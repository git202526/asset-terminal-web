/* 资产聚合管理终端 PWA Service Worker
 * 静态资源：网络优先（每次拉新版，拉不到才用缓存）
 * API：网络优先，离线兜底
 */
const CACHE = 'asset-terminal-v3';
const STATIC = ['/', '/index.html', '/style.css', '/app.js', '/db-offline.js', '/api-offline.js',
  'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 只处理同源GET请求
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 网络优先：每次都尝试拉最新版
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => {
      // 网络失败才用缓存
      return caches.match(e.request).then(hit => hit || caches.match('/index.html'));
    })
  );
});
