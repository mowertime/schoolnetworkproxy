// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration: CAPTCHA bypass for testing/development (NEVER use in production on real sites)
const BYPASS_CAPTCHA = process.env.BYPASS_CAPTCHA === 'true' || process.env.NODE_ENV === 'development';
const CAPTCHA_BYPASS_TOKEN = process.env.CAPTCHA_BYPASS_TOKEN || 'test-token-' + Date.now();

console.log(`CAPTCHA Bypass: ${BYPASS_CAPTCHA ? 'ENABLED (Development Mode)' : 'DISABLED'}`);
if (BYPASS_CAPTCHA) {
  console.log('⚠️  WARNING: CAPTCHA bypass is active. Use only in development/testing!');
}

// Increase max listeners to prevent warnings with high connection pooling
require('events').EventEmitter.defaultMaxListeners = 100;

// Session cookie store for persistence across requests
const sessionCookies = new Map();

// IP rotation pool - simulate requests from different IPs
function generateRandomIP() {
  const ranges = [
    // Residential IP ranges from various ISPs
    () => `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
  ];
  return ranges[0]();
}

// User-Agent rotation for variety
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Human-like delay simulation
function getHumanDelay(type = 'normal') {
  switch(type) {
    case 'click': // Quick click delay
      return Math.floor(Math.random() * 100) + 50; // 50-150ms
    case 'typing': // Typing between characters
      return Math.floor(Math.random() * 150) + 50; // 50-200ms
    case 'reading': // Reading delay before navigation
      return Math.floor(Math.random() * 1000) + 500; // 500-1500ms
    case 'normal': // Normal page load delay
    default:
      return Math.floor(Math.random() * 300) + 100; // 100-400ms
  }
}

// Request timing tracker to add natural delays
const lastRequestTimes = new Map();

async function addHumanDelay(sessionId, delayType = 'normal') {
  const now = Date.now();
  const lastTime = lastRequestTimes.get(sessionId) || 0;
  const timeSinceLastRequest = now - lastTime;
  
  // If requests are too fast (< 50ms apart), add delay
  if (timeSinceLastRequest < 50) {
    const delay = getHumanDelay(delayType);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  lastRequestTimes.set(sessionId, Date.now());
}

// Latest User-Agent string to mimic current browser traffic
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Create HTTP/HTTPS agents with aggressive connection pooling for maximum speed
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000, // Keep connections alive longer
  maxSockets: Infinity, // No limit on concurrent connections
  maxFreeSockets: 256, // Keep many free sockets ready
  timeout: 30000, // Shorter timeout for faster failures
  scheduling: 'lifo' // Last-in-first-out for hot connections
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: Infinity, // No limit on concurrent connections
  maxFreeSockets: 256,
  timeout: 30000,
  rejectUnauthorized: false, // Allow self-signed certificates for proxy functionality
  scheduling: 'lifo'
});

// Enable compression for faster response times
app.use(compression());

// Enable CORS for all routes
app.use(cors());

// Serve static files (HTML interface) with caching
app.use(express.static('public', {
  maxAge: '1h', // Cache static files for 1 hour
  etag: true
}));

// Main page - redirect to proxy interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Mock CAPTCHA validation endpoint for testing/development
app.post('/captcha/validate', (req, res) => {
  if (BYPASS_CAPTCHA) {
    console.log('CAPTCHA validation bypassed (development mode)');
    return res.json({
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: req.hostname,
      bypass: true,
      message: 'CAPTCHA bypassed for development/testing'
    });
  }
  return res.status(400).json({
    success: false,
    message: 'CAPTCHA bypass not enabled'
  });
});

// Handle Google redirect URLs: /p/https/www.google.com/url?q=...
app.all(/^\/p\/https?\/[^/]*google[^/]*\/url/, async (req, res, next) => {
  try {
    // Extract the 'q' parameter from Google's redirect URL
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const targetUrl = url.searchParams.get('q');
    
    if (targetUrl && targetUrl.startsWith('http')) {
      // Redirect directly to the target URL through our proxy
      const urlObj = new URL(targetUrl);
      const protocol = urlObj.protocol.replace(':', '');
      const host = urlObj.host;
      const pathAndSearch = urlObj.pathname + urlObj.search + urlObj.hash;
      const proxyUrl = `/p/${protocol}/${host}${pathAndSearch}`;
      
      console.log(`Google redirect: ${targetUrl} -> ${proxyUrl}`);
      return res.redirect(proxyUrl);
    }
  } catch (error) {
    console.error('Google redirect handling error:', error);
  }
  
  // If we can't extract the URL, fall through to normal proxy handling
  next();
});

// Path-based proxy: /p/https/example.com/path
app.all(/^\/p\/(.*)/, async (req, res) => {
  // Extract everything after /p/
  const fullPath = req.params[0];
  
  if (!fullPath) {
    return res.status(400).json({ error: 'Invalid proxy path format. Use /p/https/example.com/path' });
  }
  
  // Parse: protocol/host/path
  const parts = fullPath.split('/');
  if (parts.length < 2) {
    return res.status(400).json({ error: 'Invalid proxy path format. Use /p/https/example.com/path' });
  }
  
  const protocol = parts[0];
  const host = parts[1];
  const pathParts = parts.slice(2);
  const path = pathParts.length > 0 ? '/' + pathParts.join('/') : '';
  const queryString = req.url.split('?')[1] || '';
  
  // Construct the full URL
  const targetUrl = `${protocol}://${host}${path}${queryString ? '?' + queryString : ''}`;
  
  try {
    // Get session identifier from client
    const sessionId = req.headers['x-session-id'] || 'default';
    const storedCookies = sessionCookies.get(sessionId) || '';
    
    // Add human-like delay to avoid detection
    await addHumanDelay(sessionId, 'normal');
    
    // Generate random IP for this request
    const spoofedIP = generateRandomIP();
    const randomUserAgent = getRandomUserAgent();
    
    // Optimize fetch for speed with realistic browser headers + IP rotation
    const fetchOptions = {
      method: req.method,
      headers: {
        'User-Agent': randomUserAgent,
        'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        'DNT': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'X-Forwarded-For': spoofedIP,
        'X-Real-IP': spoofedIP,
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      },
      // Use appropriate agent for HTTP/HTTPS
      agent: targetUrl.startsWith('https') ? httpsAgent : httpAgent
    };
    
    // Add stored session cookies
    if (storedCookies) {
      fetchOptions.headers['Cookie'] = storedCookies;
    } else if (req.headers.cookie) {
      fetchOptions.headers['Cookie'] = req.headers.cookie;
    }
    
    // Forward important headers for better compatibility and session persistence
    if (req.headers.range) {
      fetchOptions.headers['Range'] = req.headers.range;
    }
    if (req.headers['user-agent']) {
      fetchOptions.headers['User-Agent'] = req.headers['user-agent']; // Use client's UA if provided
    }
    if (req.headers.referer && req.headers.referer.includes('/p/')) {
      // Convert proxy referer back to real URL
      const refMatch = req.headers.referer.match(/\/p\/(https?)\/([^/]+)(.*?)$/);
      if (refMatch) {
        fetchOptions.headers['Referer'] = `${refMatch[1]}://${refMatch[2]}${refMatch[3] || '/'}`;
      }
    } else {
      fetchOptions.headers['Referer'] = `${protocol}://${host}/`;
    }
    
    const response = await fetch(targetUrl, fetchOptions);
    
    // Set CORS headers to allow cross-origin requests
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Remove security headers that block iframe embedding (needed for captchas and proxy functionality)
    // This is necessary but reduces security - use only in controlled environments
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    
    // Forward status and content type
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.header('Content-Type', contentType);
    }
    
    // Forward cookies with proper attributes and store in session
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const sessionId = req.headers['x-session-id'] || 'default';
      
      // Store cookies for this session
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const cookieStrings = cookies.map(c => c.split(';')[0]).join('; ');
      sessionCookies.set(sessionId, cookieStrings);
      
      // Forward cookies but make them accessible to the iframe
      cookies.forEach(cookie => {
        const modifiedCookie = cookie
          .replace(/; Secure/gi, '')
          .replace(/; HttpOnly/gi, '')
          .replace(/; SameSite=\w+/gi, '; SameSite=None');
        res.append('Set-Cookie', modifiedCookie);
      });
    }
    
    // Check if HTML and rewrite URLs
    const isHtml = contentType && contentType.includes('text/html');
    const isCss = contentType && contentType.includes('css');
    const isJs = contentType && (contentType.includes('javascript') || contentType.includes('ecmascript'));
    
    // Aggressive caching for static resources to maximize speed
    const isStatic = contentType && (contentType.includes('image/') || contentType.includes('css') || contentType.includes('javascript') || contentType.includes('font'));
    if (isStatic) {
      res.header('Cache-Control', 'public, max-age=86400, immutable'); // 24 hour cache
    } else if (isHtml) {
      res.header('Cache-Control', 'public, max-age=300'); // 5 minute cache for HTML
    }
    
    if (isHtml) {
      // Always rewrite ALL HTML pages to ensure captcha iframes work
      const html = await response.text();
      const rewrittenHtml = rewriteHtmlUrlsPathBasedFast(html, targetUrl, protocol, host);
      res.send(rewrittenHtml);
    } else if (isCss) {
      // Rewrite CSS files to fix @import and url() references
      const css = await response.text();
      const rewrittenCss = rewriteCssUrls(css, targetUrl, protocol, host);
      res.send(rewrittenCss);
    } else if (isJs) {
      // Stream JavaScript with proper content type
      const js = await response.text();
      res.send(js);
    } else if (response.body) {
      // Stream non-HTML content with maximum speed
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            if (!res.write(value)) {
              await new Promise(resolve => res.once('drain', resolve));
            }
          }
        } catch (error) {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Stream error' });
          }
        }
      };
      pump();
    } else {
      const data = await response.text();
      res.send(data);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch', details: error.message });
    }
  }
});

// Proxy endpoint - handles all proxied requests
app.use('/proxy', createProxyMiddleware({
  target: 'https://www.google.com',
  changeOrigin: true,
  secure: false,
  followRedirects: true,
  agent: httpsAgent, // Use persistent agent
  timeout: 30000, // 30 second timeout
  proxyTimeout: 30000,
  pathRewrite: {
    '^/proxy': '', // remove /proxy prefix
  },
  onProxyReq: (proxyReq, req, res) => {
    // Remove origin headers to avoid CORS issues
    proxyReq.removeHeader('origin');
    proxyReq.removeHeader('referer');
    
    // Set headers to mimic a regular browser request
    proxyReq.setHeader('User-Agent', USER_AGENT);
    proxyReq.setHeader('Connection', 'keep-alive');
  },
  onProxyRes: (proxyRes, req, res) => {
    // Note: Removing security headers is necessary for proxy functionality
    // but introduces security risks. Use only in controlled environments.
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['x-content-type-options'];
    
    // Enable CORS (required for proxy to function)
    proxyRes.headers['access-control-allow-origin'] = '*';
    proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    proxyRes.headers['access-control-allow-headers'] = '*';
  },
  router: (req) => {
    // Dynamic routing based on query parameter
    const targetUrl = req.query.url || req.headers['x-proxy-target'];
    if (targetUrl) {
      try {
        const url = new URL(targetUrl);
        return url.origin;
      } catch (e) {
        return 'https://www.google.com';
      }
    }
    return 'https://www.google.com';
  }
}));

// Results endpoint - handles YouTube and other search results pages
app.get('/results', async (req, res) => {
  const query = req.query.search_query || req.query.q || req.query.query;
  
  if (!query) {
    // If no query provided, redirect to YouTube search results through proxy
    const targetUrl = `https://www.youtube.com/results${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
    const proxyUrl = `/p/https/www.youtube.com/results${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
    return res.redirect(proxyUrl);
  }
  
  try {
    // Add human delay for search queries
    const sessionId = req.headers['x-session-id'] || 'default';
    await addHumanDelay(sessionId, 'reading');
    
    // Generate random IP and user agent
    const spoofedIP = generateRandomIP();
    const randomUserAgent = getRandomUserAgent();
    
    // Build YouTube search URL with all query parameters
    const queryString = Object.keys(req.query)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(req.query[key])}`)
      .join('&');
    const searchUrl = `https://www.youtube.com/results?${queryString}`;
    
    const storedCookies = sessionCookies.get(sessionId) || '';
    
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': randomUserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'X-Forwarded-For': spoofedIP,
        'X-Real-IP': spoofedIP,
        'Referer': 'https://www.youtube.com/',
        'Cookie': storedCookies || req.headers.cookie || ''
      },
      agent: httpsAgent
    });
    
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    
    // Handle cookies
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const cookieStrings = cookies.map(c => c.split(';')[0]).join('; ');
      sessionCookies.set(sessionId, cookieStrings);
      
      cookies.forEach(cookie => {
        const modifiedCookie = cookie
          .replace(/; Secure/gi, '')
          .replace(/; HttpOnly/gi, '')
          .replace(/; SameSite=\w+/gi, '; SameSite=None');
        res.append('Set-Cookie', modifiedCookie);
      });
    }
    
    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.header('Content-Type', contentType);
    }
    
    // Forward status code
    res.status(response.status);
    
    // Get HTML content and rewrite URLs
    const html = await response.text();
    const rewrittenHtml = rewriteHtmlUrlsPathBasedFast(html, searchUrl, 'https', 'www.youtube.com');
    res.send(rewrittenHtml);
  } catch (error) {
    console.error('Results error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to load results', details: error.message });
    }
  }
});

// Search endpoint - proxies DuckDuckGo search queries (more proxy-friendly)
app.get('/search', async (req, res) => {
  const query = req.query.q || req.query.query;
  
  if (!query) {
    return res.status(400).json({ error: 'Search query parameter (q or query) is required' });
  }
  
  try {
    // Add human delay for search queries (simulate typing + thinking time)
    const sessionId = req.headers['x-session-id'] || 'default';
    await addHumanDelay(sessionId, 'reading');
    
    // Generate random IP and user agent
    const spoofedIP = generateRandomIP();
    const randomUserAgent = getRandomUserAgent();
    
    // Build DuckDuckGo search URL (more proxy-friendly than Google)
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': randomUserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'X-Forwarded-For': spoofedIP,
        'X-Real-IP': spoofedIP
      },
      agent: httpsAgent
    });
    
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    
    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.header('Content-Type', contentType);
    }
    
    // Forward status code
    res.status(response.status);
    
    // Get HTML content and rewrite URLs with fast method
    const html = await response.text();
    const rewrittenHtml = rewriteHtmlUrlsPathBasedFast(html, searchUrl, 'https', 'www.google.com');
    res.send(rewrittenHtml);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to perform search', details: error.message });
    }
  }
});

// Catch-all proxy for direct URL access with streaming
app.use('/fetch', async (req, res) => {
  let targetUrl = req.query.url || req.headers['x-target-url'];
  
  // Try to extract URL from referer if not provided
  if (!targetUrl && req.headers.referer) {
    const refererUrl = new URL(req.headers.referer);
    const urlParam = refererUrl.searchParams.get('url');
    if (urlParam) {
      // Try to construct URL from path
      const pathAfterFetch = req.path.replace('/fetch', '');
      if (pathAfterFetch && pathAfterFetch !== '/') {
        targetUrl = urlParam + pathAfterFetch;
      }
    }
  }
  
  if (!targetUrl) {
    return res.status(400).json({ 
      error: 'URL parameter is required',
      hint: 'Use /fetch?url=https://example.com or /p/https/example.com'
    });
  }
  
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      agent: targetUrl.startsWith('https') ? httpsAgent : httpAgent
    });
    
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    
    // Forward status code
    res.status(response.status);
    
    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.header('Content-Type', contentType);
    }
    
    // Forward content length for progress indication
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      res.header('Content-Length', contentLength);
    }
    
    // Check if it's HTML content that needs URL rewriting
    const isHtml = contentType && contentType.includes('text/html');
    
    if (isHtml) {
      // For HTML content, rewrite URLs to go through the proxy
      const html = await response.text();
      const rewrittenHtml = rewriteHtmlUrls(html, targetUrl);
      res.send(rewrittenHtml);
    } else if (response.body) {
      // Stream non-HTML content
      const reader = response.body.getReader();
      
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            if (!res.write(value)) {
              // Backpressure: wait for drain event
              await new Promise(resolve => res.once('drain', resolve));
            }
          }
        } catch (error) {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Stream error', details: error.message });
          }
        }
      };
      
      pump();
    } else {
      // Fallback for environments without streaming support
      const data = await response.text();
      res.send(data);
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch URL', details: error.message });
    }
  }
});

// Helper function to rewrite URLs in HTML
function rewriteHtmlUrls(html, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const proxyPrefix = '/fetch?url=';
    
    // Rewrite absolute URLs (http:// or https://)
    html = html.replace(
      /(href|src|action|data)=["'](https?:\/\/[^"']+)["']/gi,
      (match, attr, url) => {
        try {
          // Validate and clean the URL
          const cleanUrl = url.trim();
          return `${attr}="${proxyPrefix}${encodeURIComponent(cleanUrl)}"`;
        } catch {
          return match;
        }
      }
    );
    
    // Rewrite protocol-relative URLs (//example.com/path)
    html = html.replace(
      /(href|src|action|data)=["'](\/\/[^"']+)["']/gi,
      (match, attr, url) => {
        try {
          const absoluteUrl = base.protocol + url.trim();
          return `${attr}="${proxyPrefix}${encodeURIComponent(absoluteUrl)}"`;
        } catch {
          return match;
        }
      }
    );
    
    // Rewrite root-relative URLs starting with / (but not //)
    html = html.replace(
      /(href|src|action|data)=["'](\/)([^"'\/][^"']*)["']/gi,
      (match, attr, slash, path) => {
        if (path.startsWith('fetch?url=') || path.startsWith('search?')) {
          return match; // Don't rewrite our own proxy URLs
        }
        try {
          const absoluteUrl = `${base.origin}/${path}`;
          return `${attr}="${proxyPrefix}${encodeURIComponent(absoluteUrl)}"`;
        } catch {
          return match;
        }
      }
    );
    
    // Rewrite relative URLs (no protocol, no leading slash)
    // This is tricky, so we'll be conservative and only handle common cases
    html = html.replace(
      /(href|src|action|data)=["']([^"':\/][^"']*)["']/gi,
      (match, attr, url) => {
        // Skip if it looks like a special protocol or anchor
        if (url.match(/^(mailto:|tel:|javascript:|#|data:)/i)) {
          return match;
        }
        // Skip if already proxied
        if (url.includes('fetch?url=') || url.includes('search?')) {
          return match;
        }
        try {
          // Build absolute URL from base
          const currentPath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
          const absoluteUrl = `${base.origin}${currentPath}${url}`;
          return `${attr}="${proxyPrefix}${encodeURIComponent(absoluteUrl)}"`;
        } catch {
          return match;
        }
      }
    );
    
    // Inject a script to handle dynamic navigation
    const navigationScript = `
      <script>
        (function() {
          // Intercept link clicks to ensure they go through proxy
          document.addEventListener('click', function(e) {
            var target = e.target;
            while (target && target.tagName !== 'A') {
              target = target.parentElement;
            }
            if (target && target.href && !target.href.includes('/fetch?url=')) {
              try {
                var url = new URL(target.href);
                if (url.origin !== window.location.origin) {
                  e.preventDefault();
                  window.location.href = '/fetch?url=' + encodeURIComponent(target.href);
                }
              } catch (err) {
                // Invalid URL, let it proceed normally
              }
            }
          }, true);
        })();
      </script>
    `;
    
    // Add script before closing body tag
    if (html.includes('</body>')) {
      html = html.replace('</body>', navigationScript + '</body>');
    } else if (html.includes('</BODY>')) {
      html = html.replace('</BODY>', navigationScript + '</BODY>');
    } else {
      html += navigationScript;
    }
    
    return html;
  } catch (error) {
    console.error('Error rewriting URLs:', error);
    return html;
  }
}

// Ultra-fast minimal rewriting for large pages
// CSS URL rewriting function
function rewriteCssUrls(css, baseUrl, protocol, host) {
  try {
    const base = new URL(baseUrl);
    
    // Rewrite url() in CSS
    css = css.replace(
      /url\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi,
      (match, quote, url) => {
        try {
          // Skip data: urls and already proxied
          if (url.startsWith('data:') || url.includes('/p/')) return match;
          
          // Handle absolute URLs
          if (url.startsWith('http://') || url.startsWith('https://')) {
            const u = new URL(url);
            return `url(${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote})`;
          }
          
          // Handle protocol-relative URLs
          if (url.startsWith('//')) {
            const u = new URL('https:' + url);
            return `url(${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote})`;
          }
          
          // Handle root-relative URLs
          if (url.startsWith('/')) {
            return `url(${quote}/p/${protocol}/${host}${url}${quote})`;
          }
          
          // Handle relative URLs
          const resolvedUrl = new URL(url, base.href);
          return `url(${quote}/p/${resolvedUrl.protocol.replace(':', '')}/${resolvedUrl.host}${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}${quote})`;
        } catch (e) {
          return match;
        }
      }
    );
    
    // Rewrite @import statements
    css = css.replace(
      /@import\s+(["'])([^"']+)\1/gi,
      (match, quote, url) => {
        try {
          if (url.includes('/p/')) return match;
          
          if (url.startsWith('http://') || url.startsWith('https://')) {
            const u = new URL(url);
            return `@import ${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}`;
          }
          
          if (url.startsWith('//')) {
            const u = new URL('https:' + url);
            return `@import ${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}`;
          }
          
          if (url.startsWith('/')) {
            return `@import ${quote}/p/${protocol}/${host}${url}${quote}`;
          }
          
          const resolvedUrl = new URL(url, base.href);
          return `@import ${quote}/p/${resolvedUrl.protocol.replace(':', '')}/${resolvedUrl.host}${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}${quote}`;
        } catch (e) {
          return match;
        }
      }
    );
    
    return css;
  } catch (e) {
    console.error('CSS rewriting error:', e);
    return css;
  }
}

function injectPerformanceOptimizations(html, baseUrl, protocol, host) {
  try {
    // Only inject critical navigation script, no URL rewriting for speed
    const script = `<script>window.p='${protocol}',window.h='${host}';if(navigator.onLine===false)Object.defineProperty(navigator,'onLine',{get:()=>true});document.addEventListener('click',e=>{let el=e.target;while(el&&el.tagName!=='A')el=el.parentElement;if(el&&el.href&&!el.href.includes('/p/')){e.preventDefault();try{let u=new URL(el.href);location.href='/p/'+u.protocol.replace(':','')+'/'+u.host+u.pathname+u.search+u.hash}catch{}}},true)</script>`;
    
    // Inject at the earliest possible point
    if (html.includes('<head>')) {
      return html.replace('<head>', '<head>' + script);
    } else if (html.includes('<HEAD>')) {
      return html.replace('<HEAD>', '<HEAD>' + script);
    } else {
      return script + html;
    }
  } catch {
    return html;
  }
}

// Fast HTML rewriting for smaller pages
function rewriteHtmlUrlsPathBasedFast(html, baseUrl, protocol, host) {
  try {
    const base = new URL(baseUrl);
    
    // Only remove ad scripts, keep captcha scripts for functionality
    html = html.replace(/<script[^>]*googlesyndication[^>]*>.*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*doubleclick[^>]*>.*?<\/script>/gi, '');
    
    // CAPTCHA bypass for development/testing: Remove CAPTCHA elements if enabled
    // ALWAYS ENABLED for now
    const bypassEnabled = true; // Force enable for testing
    if (bypassEnabled) {
      console.log('🔓 CAPTCHA bypass active - removing CAPTCHA elements from:', baseUrl);
      
      // Remove ALL CAPTCHA-related elements aggressively
      html = html.replace(/<div[^>]*class=["'][^"']*g-recaptcha[^"']*["'][^>]*>.*?<\/div>/gis, '<!-- captcha removed -->');
      html = html.replace(/<div[^>]*class=["'][^"']*recaptcha[^"']*["'][^>]*>.*?<\/div>/gis, '<!-- captcha removed -->');
      html = html.replace(/<div[^>]*id=["'][^"']*captcha[^"']*["'][^>]*>.*?<\/div>/gis, '<!-- captcha removed -->');
      html = html.replace(/<iframe[^>]*recaptcha[^>]*>.*?<\/iframe>/gis, '<!-- captcha removed -->');
      html = html.replace(/<iframe[^>]*hcaptcha[^>]*>.*?<\/iframe>/gis, '<!-- captcha removed -->');
      html = html.replace(/<script[^>]*recaptcha[^>]*>.*?<\/script>/gis, '');
      html = html.replace(/<script[^>]*hcaptcha[^>]*>.*?<\/script>/gis, '');
      html = html.replace(/<script[^>]*captcha[^>]*>.*?<\/script>/gis, '');
      html = html.replace(/data-sitekey=["'][^"']*["']/gi, '');
      html = html.replace(/data-callback=["']onSubmit["']/gi, '');
      
      // Remove noscript captcha fallbacks
      html = html.replace(/<noscript>.*?recaptcha.*?<\/noscript>/gis, '');
      
      // Inject comprehensive CAPTCHA bypass script
      const bypassScript = `<script>
        console.log('🔓 CAPTCHA Bypass Script Loaded');
        
        // Mock ALL CAPTCHA APIs
        window.grecaptcha = {
          ready: function(cb) { console.log('grecaptcha.ready called'); if(cb) setTimeout(cb, 10); },
          execute: function() { console.log('grecaptcha.execute called'); return Promise.resolve('${CAPTCHA_BYPASS_TOKEN}'); },
          render: function(container, params) { 
            console.log('grecaptcha.render called', container, params);
            if(params && params.callback) setTimeout(() => params.callback('${CAPTCHA_BYPASS_TOKEN}'), 100);
            return 0; 
          },
          reset: function() { console.log('grecaptcha.reset called'); },
          getResponse: function() { console.log('grecaptcha.getResponse called'); return '${CAPTCHA_BYPASS_TOKEN}'; }
        };
        
        window.hcaptcha = {
          execute: function() { console.log('hcaptcha.execute called'); return Promise.resolve('${CAPTCHA_BYPASS_TOKEN}'); },
          render: function(container, params) { 
            console.log('hcaptcha.render called');
            if(params && params.callback) setTimeout(() => params.callback('${CAPTCHA_BYPASS_TOKEN}'), 100);
            return 0; 
          },
          reset: function() { console.log('hcaptcha.reset called'); },
          getResponse: function() { console.log('hcaptcha.getResponse called'); return '${CAPTCHA_BYPASS_TOKEN}'; }
        };
        
        // Prevent CAPTCHA scripts from loading
        let origCreateElement = document.createElement.bind(document);
        document.createElement = function(tag) {
          let el = origCreateElement(tag);
          if(tag.toLowerCase() === 'script') {
            let origSet = el.setAttribute.bind(el);
            el.setAttribute = function(attr, val) {
              if(attr === 'src' && val && (val.includes('recaptcha') || val.includes('hcaptcha') || val.includes('captcha'))) {
                console.log('🚫 Blocked CAPTCHA script:', val);
                return;
              }
              return origSet(attr, val);
            };
          }
          return el;
        };
        
        // Auto-enable all disabled buttons after page load
        function enableButtons() {
          document.querySelectorAll('button:disabled, input[type="submit"]:disabled, input[type="button"]:disabled').forEach(function(btn) {
            console.log('✅ Enabling button:', btn);
            btn.disabled = false;
            btn.removeAttribute('disabled');
          });
          
          // Remove CAPTCHA requirement from forms
          document.querySelectorAll('form').forEach(function(form) {
            form.removeAttribute('data-requires-captcha');
          });
        }
        
        // Run immediately and after DOM loads
        if(document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', enableButtons);
        } else {
          enableButtons();
        }
        
        // Also run after a delay in case content loads dynamically
        setTimeout(enableButtons, 500);
        setTimeout(enableButtons, 1000);
        setTimeout(enableButtons, 2000);
      </script>`;
      
      // Inject before closing head tag or at start of HTML
      if (html.match(/<\/head>/i)) {
        html = html.replace(/<\/head>/i, bypassScript + '</head>');
      } else if (html.match(/<body[^>]*>/i)) {
        html = html.replace(/<body([^>]*)>/i, '<body$1>' + bypassScript);
      } else {
        html = bypassScript + html;
      }
    }
    
    // Rewrite URLs in HTML but NOT inside script tags
    // Use a more surgical approach - only rewrite in specific tag contexts
    
    // Rewrite <link> tags for stylesheets (including protocol-relative URLs)
    html = html.replace(
      /<link\b([^>]*?\bhref=)(["'])(https?:\/\/[^"/'][^"']*|\/\/[^"']+|\/[^"'\/][^"']*)\2([^>]*)>/gi,
      (match, before, quote, url, after) => {
        try {
          if (url.includes('/p/')) return match;
          if (url.startsWith('//')) {
            // Protocol-relative URL
            const cleanUrl = url.substring(2); // Remove //
            const u = new URL('https://' + cleanUrl);
            return `<link${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('http://') || url.startsWith('https://')) {
            const u = new URL(url);
            return `<link${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('/') && !url.startsWith('//')) {
            return `<link${before}${quote}/p/${protocol}/${host}${url}${quote}${after}>`;
          }
        } catch (e) {}
        return match;
      }
    );
    
    // Rewrite <img> tags
    html = html.replace(
      /<img\b([^>]*?\bsrc=)(["'])(https?:\/\/[^"']+|\/[^"']+)\2([^>]*)>/gi,
      (match, before, quote, url, after) => {
        try {
          if (url.includes('/p/')) return match;
          if (url.startsWith('http')) {
            const u = new URL(url);
            return `<img${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('/')) {
            return `<img${before}${quote}/p/${protocol}/${host}${url}${quote}${after}>`;
          }
        } catch (e) {}
        return match;
      }
    );
    
    // Rewrite <a> tags
    html = html.replace(
      /<a\b([^>]*?\bhref=)(["'])(https?:\/\/[^"']+|\/[^"']+)\2([^>]*)>/gi,
      (match, before, quote, url, after) => {
        try {
          if (url.includes('/p/')) return match;
          if (url.startsWith('http')) {
            const u = new URL(url);
            return `<a${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('/')) {
            return `<a${before}${quote}/p/${protocol}/${host}${url}${quote}${after}>`;
          }
        } catch (e) {}
        return match;
      }
    );
    
    // Rewrite <script> tags src attribute (but not inline scripts)
    html = html.replace(
      /<script\b([^>]*?\bsrc=)(["'])(https?:\/\/[^"/'][^"']*|\/\/[^"']+|\/[^"'\/][^"']*)\2([^>]*)>/gi,
      (match, before, quote, url, after) => {
        try {
          if (url.includes('/p/')) return match;
          if (url.startsWith('//')) {
            const cleanUrl = url.substring(2);
            const u = new URL('https://' + cleanUrl);
            return `<script${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('http://') || url.startsWith('https://')) {
            const u = new URL(url);
            return `<script${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('/') && !url.startsWith('//')) {
            return `<script${before}${quote}/p/${protocol}/${host}${url}${quote}${after}>`;
          }
        } catch (e) {}
        return match;
      }
    );
    
    // Rewrite <video> and <source> tags
    html = html.replace(
      /<(video|source)\b([^>]*?\bsrc=)(["'])(https?:\/\/[^"/'][^"']*|\/[^"']+)\3([^>]*)>/gi,
      (match, tag, before, quote, url, after) => {
        try {
          if (url.includes('/p/')) return match;
          if (url.startsWith('http://') || url.startsWith('https://')) {
            const u = new URL(url);
            return `<${tag}${before}${quote}/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}${quote}${after}>`;
          } else if (url.startsWith('/')) {
            return `<${tag}${before}${quote}/p/${protocol}/${host}${url}${quote}${after}>`;
          }
        } catch (e) {}
        return match;
      }
    );
    
    // DON'T rewrite CSS background-image or inline styles - they might be in script tags
    // Client-side interception will handle dynamic content
    // CSS files are rewritten separately via rewriteCssUrls function
    
    // Inject comprehensive script with iframe URL rewriting, fetch/XHR interception, and YouTube support
    const script = `<script>
if(navigator.onLine===false)Object.defineProperty(navigator,'onLine',{get:()=>true});
(function(){
  let rewriteUrl=function(url){
    // Type check - only process strings, return anything else as-is
    if(typeof url !== 'string')return url;
    if(!url||url.includes('/p/'))return url;
    if(url.startsWith('http')||url.startsWith('//')){
      try{
        let u=new URL(url.startsWith('//')?'https:'+url:url);
        return'/p/'+u.protocol.replace(':','')+'/'+u.host+u.pathname+u.search+u.hash;
      }catch{}
    }else if(url.startsWith('/')){
      return'/p/${protocol}/${host}'+url;
    }
    return url;
  };
  
  // Intercept setAttribute for dynamic content
  let origSetAttribute=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    if((name==='src'||name==='href'||name==='data-src'||name==='data-thumb')&&value){
      value=rewriteUrl(value);
    }else if(name==='style'&&value){
      value=value.replace(/url\\((["']?)([^)"']+)\\1\\)/gi,function(m,q,url){
        return'url('+q+rewriteUrl(url)+q+')';
      });
    }
    return origSetAttribute.call(this,name,value);
  };
  
  // Intercept createElement for dynamic iframes/images
  let origCreateElement=document.createElement;
  document.createElement=function(tagName){
    let el=origCreateElement.call(document,tagName);
    let tag=tagName.toLowerCase();
    if(tag==='iframe'||tag==='img'||tag==='video'||tag==='audio'||tag==='source'){
      let proto=tag==='iframe'?HTMLIFrameElement.prototype:
                tag==='img'?HTMLImageElement.prototype:
                tag==='video'?HTMLVideoElement.prototype:
                tag==='audio'?HTMLAudioElement.prototype:
                HTMLSourceElement.prototype;
      let origSrcDesc=Object.getOwnPropertyDescriptor(proto,'src');
      if(origSrcDesc&&origSrcDesc.set){
        Object.defineProperty(el,'src',{
          set:function(val){return origSrcDesc.set.call(this,rewriteUrl(val));},
          get:function(){return origSrcDesc.get.call(this);}
        });
      }
    }
    return el;
  };
  
  // Intercept fetch API for AJAX requests (critical for YouTube)
  let origFetch=window.fetch;
  window.fetch=function(url,opts){
    if(typeof url==='string'){
      url=rewriteUrl(url);
    }else if(url instanceof Request){
      let newUrl=rewriteUrl(url.url);
      url=new Request(newUrl,url);
    }
    return origFetch.call(this,url,opts);
  };
  
  // Intercept XMLHttpRequest for older AJAX (some YouTube features still use this)
  let origXHROpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,...args){
    if(typeof url==='string'){
      url=rewriteUrl(url);
    }
    return origXHROpen.call(this,method,url,...args);
  };
  
  // Intercept property getters/setters for image elements
  try{
    let imgProto=Image.prototype;
    let origImgSrcDesc=Object.getOwnPropertyDescriptor(imgProto,'src');
    if(origImgSrcDesc&&origImgSrcDesc.set){
      Object.defineProperty(imgProto,'src',{
        set:function(val){return origImgSrcDesc.set.call(this,rewriteUrl(val));},
        get:function(){return origImgSrcDesc.get.call(this);}
      });
    }
  }catch(e){}
  
  // Aggressive video element interception for YouTube
  try{
    let videoProto=HTMLVideoElement.prototype;
    let origVideoSrcDesc=Object.getOwnPropertyDescriptor(videoProto,'src');
    if(origVideoSrcDesc&&origVideoSrcDesc.set){
      Object.defineProperty(videoProto,'src',{
        set:function(val){
          console.log('Video src set:',val);
          return origVideoSrcDesc.set.call(this,rewriteUrl(val));
        },
        get:function(){return origVideoSrcDesc.get.call(this);}
      });
    }
  }catch(e){}
  
  // Monitor MutationObserver for dynamically added elements
  try{
    let observer=new MutationObserver(mutations=>{
      mutations.forEach(m=>{
        m.addedNodes.forEach(node=>{
          if(node.nodeType===1){
            if(node.tagName==='VIDEO'||node.tagName==='IFRAME'||node.tagName==='IMG'){
              let src=node.getAttribute('src');
              if(src&&!src.includes('/p/')){
                node.setAttribute('src',rewriteUrl(src));
              }
            }
            node.querySelectorAll&&node.querySelectorAll('video,iframe,img').forEach(el=>{
              let src=el.getAttribute('src');
              if(src&&!src.includes('/p/')){
                el.setAttribute('src',rewriteUrl(src));
              }
            });
          }
        });
      });
    });
    observer.observe(document.documentElement,{childList:true,subtree:true});
  }catch(e){}
})();

// Form submission handler
document.addEventListener('submit',e=>{
  let f=e.target;
  if(f&&f.tagName==='FORM'){
    e.preventDefault();
    let a=f.getAttribute('action')||'';
    let fd=new FormData(f);
    let params=new URLSearchParams(fd).toString();
    if(!a||a==='/'||a.startsWith('#')||a.startsWith('?')){
      let currentPath=location.pathname.match(/\\/p\\/(https?)\\/([\^\\\/]+)(.*?)$/);
      if(currentPath){
        let newUrl='/p/'+currentPath[1]+'/'+currentPath[2]+'/'+(a.replace(/^[\\/\\?#]/,'')||'');
        location.href=newUrl+(params?'?'+params:'');
        return;
      }
    }
    if(!a.includes('/p/')){
      try{
        let baseUrl='${protocol}://${host}';
        let u=new URL(a,baseUrl);
        let newUrl='/p/'+u.protocol.replace(':','')+'/'+u.host+u.pathname;
        location.href=newUrl+(params?'?'+params:'');
      }catch(err){
        f.submit();
      }
    }
  }
},true);

// Click handler for links
document.addEventListener('click',e=>{
  let el=e.target;
  while(el&&el.tagName!=='A')el=el.parentElement;
  if(el&&el.href&&!el.href.includes('/p/')){
    e.preventDefault();
    try{
      let u=new URL(el.href);
      if(u.pathname.includes('/url')&&u.searchParams.get('q')){
        let target=u.searchParams.get('q');
        if(target.startsWith('http')){
          let tu=new URL(target);
          location.href='/p/'+tu.protocol.replace(':','')+'/'+tu.host+tu.pathname+tu.search;
          return;
        }
      }
      location.href='/p/'+u.protocol.replace(':','')+'/'+u.host+u.pathname+u.search;
    }catch{}
  }
},true);
</script>`;
    
    if (html.includes('</head>')) {
      return html.replace('</head>', script + '</head>');
    }
    return script + html;
  } catch {
    return html;
  }
}

// Helper function to rewrite URLs for path-based proxy
function rewriteHtmlUrlsPathBased(html, baseUrl) {
  try {
    const base = new URL(baseUrl);
    
    // Convert URL to path-based format: /p/https/example.com/path
    function urlToPath(url) {
      try {
        const u = new URL(url);
        return `/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}`;
      } catch {
        return url;
      }
    }
    
    // Single pass rewriting - combine all patterns for better performance
    html = html.replace(
      /(href|src|action|data)=(["'])((?:https?:\/\/|\/\/|\/)[^"']+)\2/gi,
      (match, attr, quote, url) => {
        try {
          // Handle Google redirect URLs
          if (url.includes('google.com/url?')) {
            const urlObj = new URL(url.startsWith('//') ? 'https:' + url : url.startsWith('/') ? base.origin + url : url);
            const targetUrl = urlObj.searchParams.get('q');
            if (targetUrl && targetUrl.startsWith('http')) {
              return `${attr}=${quote}${urlToPath(targetUrl)}${quote}`;
            }
          }
          
          // Skip already proxied URLs
          if (url.startsWith('/p/') || url.startsWith('/fetch') || url.startsWith('/search')) {
            return match;
          }
          
          // Absolute URL
          if (url.startsWith('http')) {
            return `${attr}=${quote}${urlToPath(url)}${quote}`;
          }
          
          // Protocol-relative URL
          if (url.startsWith('//')) {
            return `${attr}=${quote}${urlToPath(base.protocol + url)}${quote}`;
          }
          
          // Root-relative URL
          if (url.startsWith('/')) {
            return `${attr}=${quote}${urlToPath(base.origin + url)}${quote}`;
          }
        } catch {}
        return match;
      }
    );
    
    // Minimal navigation interceptor - only inject if not already present
    if (!html.includes('proxyNavInterceptor')) {
      const script = `<script>window.proxyNavInterceptor=1;if(typeof navigator!=='undefined'&&navigator.onLine===false){Object.defineProperty(navigator,'onLine',{get:function(){return true},configurable:true});}document.addEventListener('submit',function(e){var f=e.target;if(f&&f.tagName==='FORM'){e.preventDefault();var a=f.getAttribute('action')||'';var fd=new FormData(f);var params=new URLSearchParams(fd).toString();if(!a||a==='/'||a.startsWith('#')||a.startsWith('?')){var currentPath=location.pathname.match(/\\/p\\/(https?)\\/([\^\\\/]+)(.*?)$/);if(currentPath){var newUrl='/p/'+currentPath[1]+'/'+currentPath[2]+'/'+(a.replace(/^[\\/\\?#]/,'')||'');location.href=newUrl+(params?'?'+params:'');return}}if(!a.includes('/p/')){try{var baseUrl='${protocol}://${host}';var u=new URL(a,baseUrl);var newUrl='/p/'+u.protocol.replace(':','')+'/'+u.host+u.pathname;location.href=newUrl+(params?'?'+params:'')}catch(err){f.submit()}}}},true);document.addEventListener('click',function(e){var el=e.target;while(el&&el.tagName!=='A')el=el.parentElement;if(el&&el.href&&!el.href.includes('/p/')){try{var u=new URL(el.href);if(u.pathname.includes('/url')&&u.searchParams.get('q')){var t=u.searchParams.get('q');if(t&&t.startsWith('http')){e.preventDefault();location.href='/p/'+new URL(t).protocol.replace(':','')+'/'+new URL(t).host+new URL(t).pathname+new URL(t).search;return}}if(u.origin!==location.origin){e.preventDefault();location.href='/p/'+u.protocol.replace(':','')+'/'+u.host+u.pathname+u.search}}catch{}}},true);</script>`;
      
      if (html.includes('</head>')) {
        html = html.replace('</head>', script + '</head>');
      } else if (html.includes('</body>')) {
        html = html.replace('</body>', script + '</body>');
      } else {
        html += script;
      }
    }
    
    return html;
  } catch (error) {
    console.error('URL rewriting error:', error);
    return html;
  }
}

app.listen(PORT, () => {
  const env = process.env.NODE_ENV || 'development';
  console.log(`School Network Proxy running on port ${PORT}`);
  if (env === 'development') {
    console.log(`Access at: http://localhost:${PORT}`);
  }
});
