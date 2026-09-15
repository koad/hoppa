/* HOPPA — service worker (PWA layer)
 * ---------------------------------------------------------------------------
 * Deliberately conservative. Meteor serves a hashed, frequently-changing
 * bundle and uses a websocket for DDP/HCP; an aggressive cache here would
 * serve stale code and break hot reload. So:
 *
 *   - precache only the stable, content-addressed-ish shell (icons, manifest)
 *   - network-first for everything else, cache as an offline fallback only
 *   - never intercept DDP websockets, meteorsocket, sockjs or __cordova
 *
 * This gives us installability + a usable offline shell without the classic
 * "why is my app on last week's bundle" bug.
 * ---------------------------------------------------------------------------
 */

const VERSION = 'hoppa-v1';
const SHELL = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .catch(() => { /* a missing icon must not block install */ })
  );
  // take over on next load rather than mid-session
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NEVER = /\/(sockjs|meteor-sock|__cordova|__meteor|_build)\//;
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.test(url.pathname)) return;

  // shell assets: cache-first (they only change when we bump VERSION)
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  // everything else: network-first, cache as an offline safety net
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
