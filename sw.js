/* sw.js — 離線快取 Service Worker
 * - App 本體（同網域）：網路優先，失敗才用快取 → 更新會即時生效，離線時仍可開啟
 * - 版本固定的 CDN 函式庫（pdf.js / mammoth / jszip / tesseract…）：快取優先，之後離線可用
 * - 其他跨網域請求（翻譯、雲端語音等 API）：完全不攔截 */
const VERSION = 'v1';
const SHELL = 'reader-shell-' + VERSION;
const LIBS = 'reader-libs-' + VERSION;
const SHELL_FILES = ['./', 'index.html', 'reader-enhance.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const LIB_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.11.0/mammoth.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
];
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(u => shell.add(u).catch(() => {})));
    const libs = await caches.open(LIBS);
    // no-cors：與 <script> 載入方式一致；單一失敗不影響安裝
    await Promise.all(LIB_URLS.map(u => libs.add(new Request(u, {mode: 'no-cors'})).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== LIBS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); }
  else if (LIB_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req)); }
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, {ignoreSearch: true});
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}
