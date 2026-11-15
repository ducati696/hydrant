// 消火栓マップのオフライン対応（Service Worker）
//
// ・ページと消火栓データ … 通信できれば最新を取り、できなければ保存済みを使う
// ・Leaflet などのライブラリ … 版が固定なので保存済みを優先
// ・国土地理院の地図タイル … 保存済みを優先し、初めて見た場所は保存する

// 中身の形式を変えたときは番号を上げる（古い保存分は自動で消える）
const SHELL_CACHE = 'hydrant-shell-v1';
// index.html の TILE_CACHE と同じ名前にすること
const TILE_CACHE = 'hydrant-tiles-v1';

const TILE_HOST = 'cyberjapandata.gsi.go.jp';
const LIBRARY_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

// 保存する地図タイルの上限（超えたら古いものから消す）
const MAX_TILES = 1500;
// ページとデータは、この時間だけ通信を待ってから保存済みに切り替える（ミリ秒）
const NETWORK_TIMEOUT_MS = 4000;

// インストール時に保存しておくもの（index.html が読み込むものと同じ URL）
const PRECACHE_URLS = [
    './',
    'hydrants.geojson',
    'https://unpkg.com/leaflet@1.7.1/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.7.1/dist/leaflet.js',
    'https://cdn.jsdelivr.net/npm/leaflet.locatecontrol@0.72.0/dist/L.Control.Locate.min.css',
    'https://cdn.jsdelivr.net/npm/leaflet.locatecontrol@0.72.0/dist/L.Control.Locate.min.js',
    'https://cdn.jsdelivr.net/npm/leaflet-usermarker@1.0.0/src/leaflet.usermarker.css',
    'https://cdn.jsdelivr.net/npm/leaflet-usermarker@1.0.0/src/leaflet.usermarker.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key.startsWith('hydrant-') && key !== SHELL_CACHE && key !== TILE_CACHE)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') {
        return;
    }
    const url = new URL(request.url);

    if (url.hostname === TILE_HOST) {
        event.respondWith(cacheFirst(event, TILE_CACHE, MAX_TILES));
    } else if (LIBRARY_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(event, SHELL_CACHE));
    } else if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(event));
    }
    // それ以外（Google マップへのリンクなど）は通常どおり
});

// 保存してよい応答かどうか
function isCacheable(response) {
    // opaque は CSS から読み込まれる他サイトの画像など
    return response && (response.ok || response.type === 'opaque');
}

// 保存済みがあればそれを返し、なければ取得して保存する
async function cacheFirst(event, cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(event.request);
    if (cached) {
        return cached;
    }
    const response = await fetch(event.request);
    if (isCacheable(response)) {
        event.waitUntil(
            cache.put(event.request, response.clone())
                .then(() => maxEntries && trim(cache, maxEntries))
                .catch(() => {})
        );
    }
    return response;
}

// 通信を優先し、失敗したり遅すぎたりしたら保存済みを返す
async function networkFirst(event) {
    const cache = await caches.open(SHELL_CACHE);
    // 検索文字列（?source=... など）が付いていても同じページとして扱う
    const cached = await cache.match(event.request, {ignoreSearch: true});

    const network = fetch(event.request).then(response => {
        if (response.ok) {
            event.waitUntil(cache.put(event.request, response.clone()).catch(() => {}));
        }
        return response;
    });

    if (!cached) {
        return network;
    }
    // 遅い回線では保存済みを先に返し、取得は裏で続けて次回に反映する
    event.waitUntil(network.catch(() => {}));
    const timeout = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
    return Promise.race([network.catch(() => cached), timeout]);
}

// 上限を超えた分を古い順に消す
async function trim(cache, maxEntries) {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - maxEntries; i++) {
        await cache.delete(keys[i]);
    }
}
