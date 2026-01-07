# School Network Proxy 🌐

A powerful web proxy solution designed to bypass school endpoint and DNS security restrictions, allowing access to websites like YouTube, Google, and other blocked content.

![Proxy Interface](https://github.com/user-attachments/assets/c0aea3ad-cbfb-4097-9fc7-4d49f102c11b)

## Features ✨

- **🔓 Bypass DNS Blocks** - Routes traffic through the proxy server to avoid DNS-based filtering
- **🛡️ Avoid Endpoint Security** - Removes security headers and mimics legitimate browser traffic
- **🔍 Web Search** - Built-in Google search functionality through the proxy
- **📺 Access YouTube** - Stream videos and access content without restrictions
- **🌍 Access Any Website** - Browse any website through the proxy interface
- **🎨 User-Friendly Interface** - Clean, modern UI with quick access buttons
- **⚡ Loading Indicators** - Visual feedback with loading bar and spinner to show content loading status
- **🚀 Fast & Lightweight** - Built on Express.js with compression for optimal performance

## How It Works 🔧

The proxy works by:
1. Accepting URL requests from the web interface
2. Forwarding requests to target websites on your behalf
3. Removing restrictive headers (CORS, CSP, X-Frame-Options)
4. Masquerading as a regular browser with proper User-Agent strings
5. Returning the content to your browser

This approach bypasses:
- DNS-based content filtering
- Endpoint security software that blocks certain domains
- Network-level restrictions based on URL patterns

## Installation 📦

### Prerequisites
- Node.js (v14 or higher)
- npm (comes with Node.js)

### Setup

1. Clone the repository:
```bash
git clone https://github.com/mowertime/schoolnetworkproxy.git
cd schoolnetworkproxy
```

2. Install dependencies:
```bash
npm install
```

3. Start the proxy server:
```bash
npm start
```

4. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage 🚀

### Web Interface

1. **Enter a URL**: Type any website URL in the input box (e.g., `youtube.com`, `www.google.com`)
2. **Search the Web**: Enter a search query and click the "Search" button to search through Google
3. **Quick Access**: Use the quick link buttons for popular sites:
   - Google
   - YouTube
   - Wikipedia
4. **Browse**: The content loads through the proxy, bypassing restrictions

### API Endpoints

The proxy provides several endpoints for programmatic access:

- **`/search?q=<query>`** - Search Google through the proxy
  ```bash
  curl "http://localhost:3000/search?q=nodejs+tutorial"
  ```

- **`/fetch?url=<url>`** - Fetch any URL through the proxy
  ```bash
  curl "http://localhost:3000/fetch?url=https://example.com"
  ```

- **`/proxy?url=<url>`** - Dynamic proxy routing
  ```bash
  curl "http://localhost:3000/proxy?url=https://github.com"
  ```

### Default Behavior

- The proxy opens with Google as the default page
- You can change the URL at any time
- All browsing happens through the proxy server

## Configuration ⚙️

### Port Configuration

By default, the server runs on port 3000. You can change this by setting the `PORT` environment variable:

```bash
PORT=8080 npm start
```

### Custom Deployment

For production deployment, consider:
- Using a process manager like PM2
- Setting up HTTPS with a reverse proxy (nginx/Apache)
- Implementing rate limiting for security

## Technical Details 💻

### Technologies Used

- **Express.js** - Web server framework
- **http-proxy-middleware** - HTTP/HTTPS proxy functionality
- **compression** - Gzip/deflate compression for faster response times
- **CORS** - Cross-Origin Resource Sharing support

### Performance Optimizations

- **Response streaming** - Streams content to client instead of buffering in memory
- **Connection pooling** - Reuses HTTP/HTTPS connections with keep-alive (50 max sockets)
- **Compression middleware** - Reduces response size by up to 70%
- **Static file caching** - 1-hour cache for static assets with ETags
- **Persistent agents** - Keep-alive connections reduce latency by up to 90%
- **Optimized timeouts** - 30-second proxy timeout for faster failure detection
- **Loading indicators** - Visual feedback for better user experience

### Security Features

- Removes Content Security Policy headers
- Strips X-Frame-Options to allow iframe embedding
- Sets CORS headers for cross-origin access
- Uses legitimate User-Agent strings

## Troubleshooting 🔍

### Common Issues

**Q: The proxy isn't loading websites**
- Check your internet connection
- Ensure the target website is accessible from your server
- Some sites may have additional anti-proxy measures

**Q: Port 3000 is already in use**
- Use a different port: `PORT=8080 npm start`
- Or stop the process using port 3000

**Q: Websites look broken**
- Some modern websites use JavaScript heavily and may not work perfectly in an iframe
- Try the "Open in New Tab" option if available

## Disclaimer ⚠️

This tool is provided for educational purposes. Please ensure you comply with your institution's acceptable use policies and local laws. Bypassing network security measures may violate terms of service or institutional policies. Use responsibly.

## License 📄

ISC

## Contributing 🤝

Contributions are welcome! Please feel free to submit a Pull Request.

## Support 💬

If you encounter any issues or have questions, please open an issue on GitHub.
