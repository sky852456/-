/* ============================================================================
   旅行规划 · Service Worker
   ----------------------------------------------------------------------------
   目标：让这个应用像原生 App —— 断网也能打开、能看、能改。

   缓存策略分三层：
     1. 应用外壳（HTML / manifest / 图标）  → Cache First（永远先用缓存，秒开）
     2. CDN 静态资源（Leaflet / 二维码 / 扫码）→ Stale While Revalidate（先给旧的，后台悄悄更新）
     3. 高德地理编码等实时 API             → Network Only（不缓存，永远走网络）

   注意事项：
     · Tesseract OCR（约 15MB 语言模型）**不预缓存**，用户真正点 OCR 时再按需下载，
       否则首次安装就要拉十几兆，得不偿失。
     · 换版本务必改 VERSION，否则老缓存不会失效（activate 里会清理非当前版本）。
   ============================================================================ */

const VERSION = 'v1.5.1';
const SHELL_CACHE = `tp-shell-${VERSION}`;
const CDN_CACHE   = `tp-cdn-${VERSION}`;
const IMG_CACHE   = `tp-img-${VERSION}`;

/* 应用外壳：安装时就要缓存下来的文件（相对路径，随部署位置自动适配）
   注意：index.html 与 travel-planner.html 内容相同，两个都缓存，
   这样无论用户从短链 "/" 还是完整路径 "/travel-planner.html" 打开，离线都能命中。 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './travel-planner.html',
  './manifest.webmanifest',
  './icons.js',
  './ai.js',
  './favicon.ico',
  './favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* 需要离线可用的 CDN 资源（首次联网访问时被缓存，之后断网也能用） */
const CDN_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com'
];

/* 永远不缓存的实时接口 / 大文件
   注意：huggingface.co 是 WebLLM 模型权重的下载源（可达数 GB），
   必须放行不缓存，否则会撑爆 Cache Storage 配额并拖垮浏览器。 */
const NO_CACHE_HOSTS = [
  'huggingface.co',
  'hf.co',
  'restapi.amap.com',
  'webrd0.is.autonavi.com',
  'webrd01.is.autonavi.com',
  'webrd02.is.autonavi.com',
  'webrd03.is.autonavi.com',
  'webrd04.is.autonavi.com',
  'tile.openstreetmap.org'
];

/* ---------------------------------------------------------------- 安装 */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个添加：单个失败不影响整体（避免一个 404 导致整个 SW 装不上）
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[SW] 预缓存跳过:', url, err.message);
      }
    }));
    // 立即接管，不等旧标签页关闭
    await self.skipWaiting();
  })());
});

/* ---------------------------------------------------------------- 激活 */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉所有非当前版本的缓存
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('tp-') && !k.endsWith(VERSION))
          .map((k) => caches.delete(k))
    );

    // 同源 + CDN 的导航预载，让跳转更快
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }

    await self.clients.claim();

    // 通知所有页面：新版本已就绪
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION }));
  })());
});

/* ---------------------------------------------------------------- 工具 */
function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

function hostIn(host, list) {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

/** Cache First：命中直接返回，未命中走网络并写入缓存 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: false });
  if (hit) return hit;

  const res = await fetch(request);
  if (res && res.ok && res.type !== 'opaque') {
    cache.put(request, res.clone()).catch(() => {});
  } else if (res && res.ok) {
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

/** Stale While Revalidate：先用缓存快速响应，同时后台更新 */
async function swr(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (hit) {
    // 后台更新，失败也不影响
    network.catch(() => {});
    return hit;
  }
  const res = await network;
  if (res) return res;
  throw new Error('offline and not cached');
}

/* ---------------------------------------------------------------- 拦截 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                  // 只处理读请求

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 非 http(s)（如 chrome-extension）直接放行
  if (!/^https?:$/.test(url.protocol)) return;

  // ① 实时接口：不缓存
  if (hostIn(url.hostname, NO_CACHE_HOSTS)) return;

  // ② 导航请求（打开页面）：优先用缓存的应用外壳，保证秒开 + 离线可开
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
      } catch (e) {}

      try {
        const res = await fetch(req);
        // 联网成功：把这次真实请求的地址也缓存下来（可能是 / 或 /index.html 或 /travel-planner.html）
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone()).catch(() => {});
        cache.put('./index.html', res.clone()).catch(() => {});
        cache.put('./travel-planner.html', res.clone()).catch(() => {});
        return res;
      } catch (err) {
        // 断网：依次回退，三个候选都试一遍
        const cache = await caches.open(SHELL_CACHE);
        const hit = (await cache.match(req)) ||
                    (await cache.match('./index.html')) ||
                    (await cache.match('./travel-planner.html')) ||
                    (await cache.match('./'));
        if (hit) return hit;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>离线</title>' +
          '<body style="font-family:system-ui;padding:40px;text-align:center;color:#1c3d4a">' +
          '<h2>当前处于离线状态</h2><p>请连接网络后重新打开。</p></body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // ③ CDN 静态资源：Stale While Revalidate（离线可用的关键）
  if (hostIn(url.hostname, CDN_HOSTS)) {
    event.respondWith(swr(req, CDN_CACHE).catch(() => Response.error()));
    return;
  }

  // ④ 同源资源
  if (isSameOrigin(req.url)) {
    const dest = req.destination;
    // 图片：Cache First（图标等不常变）
    if (dest === 'image') {
      event.respondWith(cacheFirst(req, IMG_CACHE).catch(() => Response.error()));
      return;
    }
    // 其他同源静态（html/css/js/json）
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && (dest === 'script' || dest === 'style' || dest === 'document')) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        return Response.error();
      }
    })());
  }
});

/* ---------------------------------------------------------------- 消息 */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  // 页面主动要求跳过等待（用户点了"立即刷新"）
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // 页面询问当前版本
  if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: VERSION });
  }
});
