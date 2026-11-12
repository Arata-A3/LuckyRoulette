// オフラインでも開けるようにするサービスワーカー。
// ページ類: 通信できるときは常に最新を取りに行き（ネットワーク優先）、できないときだけキャッシュを使う。
// フォント（lib/fonts/ の woff2）: 中身が変わらないので、キャッシュにあればそれを使う（キャッシュ優先）。
const CACHE = 'luckyroulette-v2';
const FONT_CACHE = 'luckyroulette-fonts-v1';   // フォントを入れ替えたら番号を上げる
const FONT_CSS = 'lib/fonts/zen-maru-gothic.css';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', FONT_CSS];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

const isFont = (url) => url.pathname.includes('/lib/fonts/') && url.pathname.endsWith('.woff2');

self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    if (isFont(url)) {
        e.respondWith(
            caches.open(FONT_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
                if (res.ok) c.put(req, res.clone());
                return res;
            })))
        );
        return;
    }
    e.respondWith(
        fetch(req)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req, { ignoreSearch: true })
                .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
                .then((hit) => hit || Response.error()))
    );
});

// ホーム画面に追加したアプリとして開いたとき、ページから頼まれる:
// フォントを全部保存して、オフラインでもどの文字も丸ゴシックで出せるようにする
async function cacheAllFonts() {
    const cssUrl = new URL(FONT_CSS, self.registration.scope);
    const css = await (await fetch(cssUrl)).text();
    const urls = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) => new URL(m[1], cssUrl).href);
    const c = await caches.open(FONT_CACHE);
    const missing = [];
    for (const u of urls) if (!(await c.match(u))) missing.push(u);
    // 4 本ずつ取りに行く。途中で失敗したものは、次に開いたときにまた取る
    for (let i = 0; i < missing.length; i += 4) {
        await Promise.all(missing.slice(i, i + 4).map((u) =>
            fetch(u).then((res) => (res.ok ? c.put(u, res) : null)).catch(() => null)));
    }
    return { total: urls.length, fetched: missing.length };
}
self.addEventListener('message', (e) => {
    if (e.data === 'cacheAllFonts') {
        e.waitUntil(cacheAllFonts().then((r) => { if (e.source) e.source.postMessage({ fontsCached: r }); }).catch(() => { }));
    }
});
