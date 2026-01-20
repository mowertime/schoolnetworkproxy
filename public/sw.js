// Service Worker for School Network Proxy
// Implements CrazyGames-inspired caching strategies

const CACHE_NAME = 'school-proxy-v1';
const CACHE_EXPIRY = 3600000; // 1 hour in milliseconds

// Assets to cache immediately
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network first for dynamic content, cache first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s) schemes
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Network first for proxy endpoints (/fetch, /search, /proxy)
  if (url.pathname.startsWith('/fetch') || 
      url.pathname.startsWith('/search') || 
      url.pathname.startsWith('/proxy')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Cache first for static assets
  if (url.pathname === '/' || url.pathname.endsWith('.html') || 
      url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Default to network first with cache fallback
  event.respondWith(networkFirst(request));
});

// Cache first strategy - for static assets
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  
  if (cached) {
    // Check if cache is fresh (< 1 hour old)
    const cacheDate = cached.headers.get('sw-cache-date');
    if (cacheDate) {
      const age = Date.now() - parseInt(cacheDate);
      if (age < CACHE_EXPIRY) {
        return cached;
      }
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Clone and cache the response
      const responseToCache = response.clone();
      const headers = new Headers(responseToCache.headers);
      headers.set('sw-cache-date', Date.now().toString());
      
      const cachedResponse = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: headers
      });
      
      cache.put(request, cachedResponse);
    }
    return response;
  } catch (error) {
    // Network failed, return cached version if available
    if (cached) {
      return cached;
    }
    throw error;
  }
}

// Network first strategy - for dynamic content
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Cache successful responses
      const responseToCache = response.clone();
      const headers = new Headers(responseToCache.headers);
      headers.set('sw-cache-date', Date.now().toString());
      
      const cachedResponse = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: headers
      });
      
      cache.put(request, cachedResponse);
    }
    return response;
  } catch (error) {
    // Network failed, try cache
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

// Message handler for cache management
self.addEventListener('message', (event) => {
  if (event.data.action === 'clearCache') {
    event.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        console.log('[SW] Cache cleared');
        event.ports[0].postMessage({ success: true });
      })
    );
  }
});
