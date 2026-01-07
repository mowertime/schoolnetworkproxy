const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Common User-Agent string to mimic legitimate browser traffic
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

// Create HTTP/HTTPS agents with connection pooling for better performance
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  rejectUnauthorized: false // Allow self-signed certificates for proxy functionality
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

// Search endpoint - proxies Google search queries with streaming
app.get('/search', async (req, res) => {
  const query = req.query.q || req.query.query;
  
  if (!query) {
    return res.status(400).json({ error: 'Search query parameter (q or query) is required' });
  }
  
  try {
    // Build Google search URL
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
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
    
    // Stream the response for better performance
    if (response.body) {
      response.body.pipeTo(new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
        abort(err) {
          res.status(500).json({ error: 'Stream aborted', details: err.message });
        }
      }));
    } else {
      // Fallback for environments without streaming support
      const data = await response.text();
      res.send(data);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to perform search', details: error.message });
  }
});

// Catch-all proxy for direct URL access with streaming
app.use('/fetch', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  try {
    const urlObj = new URL(targetUrl);
    const agent = urlObj.protocol === 'https:' ? httpsAgent : httpAgent;
    
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Connection': 'keep-alive'
      },
      agent: agent
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
    
    // Stream the response for better performance
    if (response.body) {
      response.body.pipeTo(new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
        abort(err) {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Stream aborted', details: err.message });
          }
        }
      }));
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

app.listen(PORT, () => {
  const env = process.env.NODE_ENV || 'development';
  console.log(`School Network Proxy running on port ${PORT}`);
  if (env === 'development') {
    console.log(`Access at: http://localhost:${PORT}`);
  }
});
