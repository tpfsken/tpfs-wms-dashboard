// =============================================================================
// SERVICE WORKER — TPFS WMS PWA
// =============================================================================
// Strategy:
//   - Static shell (HTML/CSS/JS/icons) → cache-first, network fallback.
//     Pickers on flaky warehouse WiFi get instant loads after first install.
//   - API calls (/api/*) → network-first, no cache. We never want stale
//     order data showing up on a picker screen.
//   - S3 image URLs → not cached (they're presigned and expire).
//
// Bump CACHE_NAME any time the shell file list or strategy changes — the
// old cache is purged on activate.
// =============================================================================

const CACHE_NAME = 'tpfs-wms-shell-v114';
// Every <script> in index.html must be listed here. ui.js in particular:
// without it the cached shell loads and then every screen dies offline,
// because the whole design system is missing.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/manifest.json',
  '/icons/icon.svg',
  '/js/util.js',
  '/js/ui.js',
  '/js/combo.js',
  '/js/printDocs.js',
  '/js/clients.js',
  '/js/dashboard.js',
  '/js/inventory.js',
  '/js/orders.js',
  '/js/inbound.js',
  '/js/intake.js',
  '/js/billing.js',
  '/js/billingEngine.js',
  '/js/invoices.js',
  '/js/compliance.js',
  '/js/users.js',
  '/js/portalAccess.js',
  '/js/itemImport.js',
  '/js/excalCatchup.js',
  '/js/reports.js',
  '/js/portal.js',
  '/js/picker.js',
  '/js/floor.js',
  '/js/password.js',
  '/js/packages.js',
  '/js/quotes.js',
  '/js/scan.js',
  '/js/scanProfiles.js',
  '/js/pick.js',
  '/js/ship.js',
  '/js/migration.js',
  '/js/shipstation.js',
  '/js/packaging.js',
  '/js/waves.js',
  '/js/units.js',
  '/js/app.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Best-effort cache — if any one asset 404s during install we still
      // want the worker to register so the rest of the app works.
      .then(cache => Promise.all(
        SHELL_ASSETS.map(url => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(n => n !== CACHE_NAME && n.startsWith('tpfs-wms-'))
          .map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API requests — network first. Don't cache so pickers always see
  // current state. If the network is dead we fall back to whatever is
  // cached (rare for API GETs — usually nothing).
  if (url.pathname.startsWith('/api/') || url.hostname.includes('railway.app')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // S3 / presigned URLs — never cache, signatures expire.
  if (url.hostname.includes('s3.') || url.hostname.includes('amazonaws.com')) {
    event.respondWith(fetch(req));
    return;
  }

  // Static shell — cache first. Update cache in the background on hit
  // (stale-while-revalidate) so a redeploy still propagates.
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Optional message channel — the page can post {type:'SKIP_WAITING'} to
// activate a newly-installed worker without a manual reload.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
