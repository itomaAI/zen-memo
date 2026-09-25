/* ========================================================
   Zen Memo - Service Worker
   ========================================================
   単体ホスト（GitHub Pages など https）でだけ動く。
   Itera OS の中は blob: なので js/pwa.js が登録そのものを見送る。

   方針
   - 画面（ナビゲーション）: ネットワーク優先。落ちたらキャッシュ。
     こうしないと、デプロイしても古い画面が出続ける。
   - 自前の資産（css / js / icons）: stale-while-revalidate。
     即座に出して、裏で新しくする。
   - 写し（vendor/）: URL に版が入っているのでキャッシュ優先。
     導入時に vendor/manifest.json を見て丸ごと先読みするので、
     一度入れれば最初からオフラインで起動できる。
   - CDN: 写しが欠けた時だけ app.js が頼る。来たらキャッシュ優先で扱う。
   - GitHub API と gist の raw: 一切触らない。同期データをキャッシュすると古い本文を掴む。
   ======================================================== */

const VERSION = '2026-09-25.1';          /* デプロイのたびに上げる */
const SHELL   = 'zen-memo-shell-' + VERSION;
const RUNTIME = 'zen-memo-runtime';      /* CDN 用。版に紐付けない（毎回落とし直さないため） */
const VENDOR  = 'zen-memo-vendor';       /* 写し用。版に紐付けない */

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/themes.css',
  './css/ui-variants.css',
  './js/app.js',
  './js/pwa.js',
  './js/vendor.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* 同期に関わるものは絶対にキャッシュしない */
const NEVER_CACHE = [
  /^https:\/\/api\.github\.com/,
  /^https:\/\/gist\.githubusercontent\.com/,
  /^https:\/\/raw\.githubusercontent\.com/
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /* 1 つ欠けただけで導入ごと失敗させない */
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (e) { /* 欠けは許す */ }
    }));

    /* 写しを丸ごと先読みする。目録は vendor/manifest.json（作り方は README）。 */
    try {
      const res = await fetch('./vendor/manifest.json', { cache: 'reload' });
      if (res && res.ok) {
        const manifest = await res.json();
        const vendorCache = await caches.open(VENDOR);
        const files = (manifest && manifest.files) || [];
        await Promise.all(files.map(async (url) => {
          try {
            /* 既にあるものは落とし直さない（版が経路に入っているので中身は変わらない） */
            if (await vendorCache.match(url)) return;
            const r = await fetch(new Request(url, { cache: 'reload' }));
            if (r && r.ok) await vendorCache.put(url, r.clone());
          } catch (e) { /* 欠けは許す */ }
        }));
      }
    } catch (e) { /* 目録が無ければ CDN に頼る。導入は止めない。 */ }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k.indexOf('zen-memo-shell-') === 0 && k !== SHELL) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'zen-skip-waiting') {
    self.skipWaiting();
  } else if (data.type === 'zen-clear-caches') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.indexOf('zen-memo-') === 0).map(k => caches.delete(k)));
      if (event.source && event.source.postMessage) event.source.postMessage({ type: 'zen-caches-cleared' });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (NEVER_CACHE.some((re) => re.test(req.url))) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
    return;
  }

  if (url.origin === self.location.origin) {
    /* 写しは経路に版が入っている。問い合わせずキャッシュから出す。 */
    if (url.pathname.indexOf('/vendor/') !== -1) {
      event.respondWith(cacheFirst(req, VENDOR));
      return;
    }
    event.respondWith(staleWhileRevalidate(req, SHELL));
    return;
  }

  event.respondWith(cacheFirst(req, RUNTIME));
});

async function networkFirstPage(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match('./index.html')) || (await cache.match('./'));
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fetching = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await fetching;
  return res || Response.error();
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}