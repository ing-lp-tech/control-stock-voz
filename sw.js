// Service worker de StockVoz: la app abre sin internet después de la primera visita.
// Al publicar cambios, subí VERSION para que los usuarios reciban la actualización.
const VERSION = 'stockvoz-v6.5.1';
const CORE = [
  './', './index.html', './admin.html', './manifest.webmanifest', './css/styles.css',
  './js/app.js', './js/admin.js', './js/config.js', './js/utils.js', './js/store.js', './js/cloud.js',
  './js/voice.js', './js/scanner.js', './js/labels.js', './js/io.js', './js/remito.js', './js/reports.js',
  './icons/icon.svg', './icons/sprite.svg', './assets/creador.jpg', './favicon.ico',
  './icons/favicon-32.png', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
// Librerías externas: se guardan para poder imprimir etiquetas y exportar Excel sin conexión.
const CDN = [
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
];

// Vercel con "cleanUrls" redirige /index.html → /. Una respuesta redirigida no se puede servir a una navegación,
// así que se guarda una copia limpia.
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(CORE.map(async url => {
      try { const res = await fetch(url, { cache: 'no-store' }); if (res.ok) await cache.put(url, await clean(res)); } catch { /* se reintenta en la próxima visita */ }
    }));
    await Promise.all(CDN.map(async url => {
      try { const res = await fetch(url, { mode: 'cors' }); if (res.ok) await cache.put(url, res); } catch { /* opcional */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('stockvoz-') && k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Nunca cachear la API de Supabase.
  if (url.hostname.endsWith('supabase.co') || url.pathname.includes('/rest/v1/')) return;

  // Librerías y fuentes: primero caché.
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    event.respondWith((async () => {
      try { const cached = await caches.match(req); if (cached) return cached; } catch { /* caché no disponible: usar la red */ }
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    })());
    return;
  }
  if (url.origin !== location.origin) return;

  // Archivos de la app: primero red (los cambios publicados se ven al instante); sin conexión, la copia guardada.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(VERSION); c.put(req, await clean(res.clone())).catch(() => {}); }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const fallback = url.pathname.includes('admin') ? './admin.html' : './index.html';
        return (await caches.match(fallback)) || (await caches.match('./')) || Response.error();
      }
      return Response.error();
    }
  })());
});
