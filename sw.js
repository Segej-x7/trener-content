// ============================================
// sw.js
// Кэшируем статику (HTML, CSS, JS), JSON — всегда из сети
// ============================================

const CACHE_NAME = 'trener-v1';
const PRECACHE = ['./', './index.html', './style.css', './app.js', './registry.js'];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;

    const url = new URL(e.request.url);

    // JSON — network-first (чтобы контент всегда был свежим)
    if (url.pathname.endsWith('.json')) {
        e.respondWith(
            fetch(e.request)
                .then(r => {
                    const copy = r.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
                    return r;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Остальное — cache-first
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});