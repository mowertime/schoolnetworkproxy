const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Serve static files (HTML interface)
app.use(express.static('public'));

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
  pathRewrite: {
    '^/proxy': '', // remove /proxy prefix
  },
  onProxyReq: (proxyReq, req, res) => {
    // Remove origin headers to avoid CORS issues
    proxyReq.removeHeader('origin');
    proxyReq.removeHeader('referer');
    
    // Set headers to mimic a regular browser request
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  },
  onProxyRes: (proxyRes, req, res) => {
    // Remove security headers that might block content
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['x-content-type-options'];
    
    // Enable CORS
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

// Catch-all proxy for direct URL access
app.use('/fetch', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': '*/*'
      }
    });
    
    const data = await response.text();
    
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    
    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.header('Content-Type', contentType);
    }
    
    res.send(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch URL', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`School Network Proxy running on http://localhost:${PORT}`);
  console.log(`Open your browser and navigate to http://localhost:${PORT}`);
});
