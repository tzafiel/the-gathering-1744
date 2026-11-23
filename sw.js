const CACHE_NAME = 'gathering-1744-v9';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './src/main.js',
  './src/core/prng.js',
  './src/core/input.js',
  './src/world/terrain.js',
  './src/world/worldState.js',
  './src/sim/player.js',
  './src/sim/mount.js',
  './src/sim/onixField.js',
  './src/audio/synth.js',
  './src/render/painterlyPost.js',
  './src/render/onixShaders.js',
  './src/render/mountMesh.js',
  './src/render/worldRenderer.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdn = url.hostname === 'cdn.jsdelivr.net';

  if (!isSameOrigin && !isCdn) return;

  if (isCdn) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
