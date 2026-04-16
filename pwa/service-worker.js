/**
 * VergeMesh Relay — Service Worker
 * Caches all PWA assets for full offline operation.
 * The PWA must work with zero internet on the sending device.
 */

const CACHE_NAME = 'vergemesh-v3.5';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './lib/vmesh-protocol.js',
  './lib/utxo-cache.js',
  './lib/meshtastic-bridge.js',
  './lib/qr-handler.js',
  './lib/ellipal-bridge.js',
  './lib/noble-secp256k1.js',
  './lib/tx-assembler.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// External CDN assets to cache
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache local assets
      await cache.addAll(ASSETS);
      // Cache CDN assets (best effort)
      for (const url of CDN_ASSETS) {
        try { await cache.add(url); } catch (e) {
          console.warn(`[SW] Failed to cache CDN asset: ${url}`, e);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For NowNodes API calls — always go to network (never cache API responses)
  if (url.hostname.includes('nownodes.io')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses for fonts and CDN
        if (response.ok && (url.hostname.includes('fonts') || url.hostname.includes('cdn.jsdelivr'))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
