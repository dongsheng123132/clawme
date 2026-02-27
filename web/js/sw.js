const CACHE_NAME = "clawme-v1";
const ASSETS = [
  "/app.html",
  "/css/app.css",
  "/js/app.js",
  "/icons/icon-192.svg",
  "/icons/logo.svg",
  "/manifest.json",
];

// Install: cache core assets
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first for API, cache first for assets
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API calls: always network
  if (url.pathname.startsWith("/v1/")) {
    return;
  }

  // Assets: cache first, then network
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
