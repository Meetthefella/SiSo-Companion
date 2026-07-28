const CACHE = 'siso-companion-v1.0.0-dev-1';
const SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    (url.protocol !== 'http:' && url.protocol !== 'https:')
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response.ok &&
          url.origin === self.location.origin
        ) {
          const copy = response.clone();

          event.waitUntil(
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, copy))
          );
        }

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) {
          return cached;
        }

        return caches.match('/');
      })
  );
});
