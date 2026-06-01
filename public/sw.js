/**
 * NoteForge service worker — deliberately minimal.
 *
 * Its only jobs are (1) satisfy the PWA installability criteria (a registered
 * SW with a fetch handler) and (2) give a graceful offline fallback for page
 * navigations. It does NOT cache app HTML, API responses, or any user content
 * — the app is SSR + per-user encrypted, so caching authed bytes would be both
 * stale and a privacy leak. Static assets are left to the HTTP cache.
 */
const CACHE = 'noteforge-shell-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never touch API / auth / server routes — always straight to network.
  if (url.pathname.startsWith('/api')) return

  // Network-first for page navigations; fall back to the offline shell when
  // the network is unavailable. No caching of the live response.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)))
  }
})
