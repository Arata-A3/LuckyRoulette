// LuckyRoulette の自動テスト。
// 使い方: node tests/run.mjs            （すべて）
//         node tests/run.mjs 共有 色     （名前に含まれる語で絞り込み）
// 必要なもの: Node 22 以上（WebSocket が標準で使える）と Google Chrome。
// Chrome の場所が違うときは、環境変数 CHROME_PATH で指定する。
//
// 仕組み: リポジトリを小さな HTTP サーバーで配信し、ヘッドレス Chrome を DevTools プロトコルで操作する。
// テストはページの中で動く JS で、失敗すると例外を投げる（ok / eq）。アプリの関数や state はそのまま呼べる。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const filters = process.argv.slice(2);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 配信 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(body);
    } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const URL0 = ORIGIN + '/index.html';

// ---------- Chrome ----------
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!CHROME) { console.error('Chrome が見つかりません。環境変数 CHROME_PATH で場所を指定してください。'); process.exit(2); }
const profile = await mkdtemp(join(tmpdir(), 'lr-test-'));
const DPORT = 9400 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DPORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${DPORT}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break; } catch { }
    await sleep(100);
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let msgId = 0;
const waits = new Map(), listeners = [];
ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    else if (m.method) listeners.forEach(fn => fn(m));
});
const send = (method, params = {}) => new Promise(r => { const i = ++msgId; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const pageErrors = [];
listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
});
const waitEvent = (name, ms = 8000) => new Promise((resolve) => {
    const t = setTimeout(() => { listeners.splice(listeners.indexOf(fn), 1); resolve(null); }, ms);
    const fn = (m) => { if (m.method === name) { clearTimeout(t); listeners.splice(listeners.indexOf(fn), 1); resolve(m); } };
    listeners.push(fn);
});
await send('Runtime.enable');
await send('Page.enable');

// ページの中で使う道具
const PRELUDE = `
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(m + ': ' + x + ' !== ' + y); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rect = (e) => e.getBoundingClientRect();
const spinNow = () => { doSpin(); spin.start -= 1e6; loop(performance.now()); };
const noOverflow = (tag) => { const W = document.documentElement.clientWidth; ok(document.documentElement.scrollWidth <= W, tag + ': 横にはみ出している (' + document.documentElement.scrollWidth + ' > ' + W + ')'); };
`;
async function run(body) {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${PRELUDE}\n${body}\n})()`, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.split('\n')[0] || r.result.exceptionDetails.text);
    return r.result.result.value;
}
async function open({ width = 390, height = 844, hash = '', fresh = true } = {}) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 769 });
    // 先に空のページへ移る（閉じる直前の自動保存が済んでから消すため）
    const blank = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url: 'about:blank' });
    await blank;
    if (fresh) await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage' });
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url: URL0 + (hash ? '#' + hash : '') });
    await loaded;
    await sleep(250);
}

// ---------- テスト ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('起動: エラーなく開き、バージョンが出る', async () => {
    await open();
    await run(`
        ok(/^v\\d+\\.\\d+\\.\\d+$/.test($('appVersion').textContent), 'バージョン表示: ' + $('appVersion').textContent);
        eq($('appVersion').textContent, 'v' + APP_VERSION, 'バージョン');
        eq(curList().items.length, 6, '初期の項目数');
    `);
});

for (const w of [320, 360, 390]) {
    test(`横はみ出し: 幅 ${w}px（通常・色選び・メニュー・まとめて抽選）`, async () => {
        await open({ width: w, height: 800 });
        await run(`
            curList().items[0].name = 'とても長い項目の名前をここに入れてみるテストです'; renderAll();
            noOverflow('通常');
            openColorDialog(curList().items[0].id); noOverflow('色選び'); $('colorDialog').close();
            setMenu(true); noOverflow('メニュー'); setMenu(false);
            $('batchBtn').click(); noOverflow('まとめて抽選'); $('batchDialog').close();
            selectTab('history'); noOverflow('履歴'); selectTab('settings'); noOverflow('設定');
        `);
    });
}

test('ルーレットの canvas が正方形（幅 300px でも縦に伸びない）', async () => {
    for (const w of [360, 390, 1366]) {
        await open({ width: w, height: w > 800 ? 768 : 900 });
        await run(`const c = $('wheel'); eq(c.width, c.height, '幅 ${w}: canvas の幅と高さ'); ok(Math.abs(rect(c).width - rect(c).height) < 1, '表示の縦横');`);
    }
});

test('項目行: 欄の高さ・位置と見出しの中心がそろう', async () => {
    for (const w of [360, 390, 1366]) {
        await open({ width: w, height: 900 });
        await run(`
            const r = itemRows.get(curList().items[0].id);
            const els = [r.name, r.stepper, r.star, r.del];
            eq(els.map(e => Math.round(rect(e).height)), [36, 36, Math.round(rect(r.star).height), 36], '高さ');
            eq(new Set(els.map(e => Math.round(rect(e).top))).size, 1, '上端がそろう');
            const hs = [...document.querySelectorAll('.item-head span')];
            const cx = (e) => Math.round(rect(e).left + rect(e).width / 2);
            ok(Math.abs(cx(hs[3]) - cx(r.stepper)) <= 1, '出やすさの見出しの中心');
            ok(Math.abs(cx(hs[4]) - cx(r.star)) <= 1, '当たりの見出しの中心');
            ok(Math.abs(cx(hs[1]) - cx(r.sw)) <= 1, '色の見出しの中心');
            const sw = rect(r.sw), nm = rect(r.name);
            ok(Math.abs((sw.top + sw.height / 2) - (nm.top + nm.height / 2)) <= 1, '色の丸が名前の欄の高さの中央');
        `);
    }
});

test('出やすさの − / ＋', async () => {
    await open();
    await run(`
        const it = curList().items[0], r = itemRows.get(it.id);
        ok(r.minus.disabled, '1 のとき − は押せない');
        r.plus.click(); r.plus.click(); eq(it.weight, 3, '＋ 2 回');
        r.minus.click(); eq(it.weight, 2, '− 1 回');
        eq(JSON.parse(localStorage.getItem(SAVE_KEY)).lists[0].items[0].weight, 2, '保存される');
        it.weight = MAX_WEIGHT; renderAll(); ok(r.plus.disabled, '最大のとき ＋ は押せない');
        r.w.value = '250'; r.w.dispatchEvent(new Event('change')); eq(it.weight, MAX_WEIGHT, '直接入力も上限まで');
    `);
});

test('色選び: テーマの色・同じ色・端末の色・最近使った色・自動に戻す', async () => {
    await open();
    await run(`
        const [a, b] = curList().items;
        itemRows.get(a.id).sw.click(); ok($('colorDialog').open, 'パネルが開く');
        ok($('cdRecentSec').hidden, '最初は最近使った色がない');
        $('cdTheme').children[3].click(); eq(a.color, THEMES.vivid.colors[3], 'テーマの色'); ok(!$('colorDialog').open, '選ぶと閉じる');
        itemRows.get(b.id).sw.click();
        [...$('cdSame').children].find(x => x.textContent === a.name).click(); eq(b.color, a.color, '同じ色');
        itemRows.get(b.id).sw.click();
        const ci = $('cdCustom'); ci.value = '#123456'; ci.dispatchEvent(new Event('input')); ci.dispatchEvent(new Event('change'));
        eq(b.color, '#123456', '端末の色');
        eq(parseSaved(localStorage.getItem(SAVE_KEY)).recentColors, ['#123456', '#3ccf6e'], '最近使った色が保存される');
        itemRows.get(b.id).sw.click(); $('cdAuto').click(); eq(b.color, null, '自動に戻す');
    `);
});

test('回す: 履歴・結果カード・検証', async () => {
    await open();
    await run(`
        spinNow();
        const h = curList().history[0];
        eq(h.n, 1, '通し番号'); ok(h.snap, '検証用のデータ');
        ok(document.querySelector('#result .rcard .rname').textContent === h.name, '結果カード');
        eq(verifyEntry(h).ok, true, '検証が一致');
        const fake = { ...h, name: h.name === 'カレー' ? 'パスタ' : 'カレー' }; eq(verifyEntry(fake).ok, false, '書き換えた記録は不一致');
        eq(verifyEntry({ ...h, snap: undefined }).ok, null, '古い記録は検証できない');
        selectTab('history'); ok(document.querySelectorAll('#history .hrow').length === 1, '履歴に 1 件');
    `);
});

test('まとめて抽選: いくつか選ぶ・チーム分け・同じシードなら同じ結果', async () => {
    await open();
    await run(`
        $('batchBtn').click(); $('bdCount').value = 3; $('bdRun').click();
        const h = curList().history[0];
        eq(h.kind, 'pick', '種類'); eq(h.picks.length, 3, '3 個'); eq(new Set(h.picks).size, 3, '重複なし');
        eq(verifyEntry(h).ok, true, '検証が一致');
        $('bdModes').children[1].click(); $('bdCount').value = 4; $('bdRun').click();
        const t = curList().history[0];
        eq(t.kind, 'team', '種類'); eq(t.teams.length, 4, '4 チーム');
        eq(t.teams.flat().sort(), curList().items.map(i => i.name).sort(), '全員がどこかのチームに入る');
        ok(Math.max(...t.teams.map(x => x.length)) - Math.min(...t.teams.map(x => x.length)) <= 1, '人数の差は 1 以内');
        eq(verifyEntry(t).ok, true, 'チーム分けの検証');
        const c = curList().items;
        eq(summarizeMulti('pick', drawMulti('AAAA-BBBB', c, 'pick', 3)), summarizeMulti('pick', drawMulti('AAAA-BBBB', c, 'pick', 3)), '同じシード');
        $('batchDialog').close();
        const saved = parseSaved(localStorage.getItem(SAVE_KEY));
        eq(saved.lists[0].history[0].teams, t.teams, '保存と読み込みでチームが残る');
        eq(saved.lists[0].history[1].picks, h.picks, '保存と読み込みで選んだ項目が残る');
        eq(curList().spinCount, 2, '通し番号が進む');
    `);
});

test('ひな形から新しいリスト', async () => {
    await open();
    await run(`
        $('newList').click(); ok($('newListDialog').open, 'ダイアログが開く');
        [...$('templates').children].find(b => b.dataset.key === 'dice').click();
        eq($('nlName').value, 'サイコロ', '名前が入る');
        $('newListForm').requestSubmit();
        eq(curList().name, 'サイコロ', 'リスト名'); eq(curList().items.map(i => i.name), ['1', '2', '3', '4', '5', '6'], '項目');
        $('newList').click(); $('nlName').value = '自分の名前'; $('nlName').dispatchEvent(new Event('input'));
        [...$('templates').children].find(b => b.dataset.key === 'coin').click();
        eq($('nlName').value, '自分の名前', '自分で入れた名前はひな形で上書きしない');
        $('newListDialog').close();
    `);
});

test('共有リンク: 作る・読み込む・URL から開く', async () => {
    await open();
    const url = await run(`
        const l = curList(); l.items[1].color = '#123456'; l.items[2].weight = 7;
        const url = shareUrlFor(l);
        const s = parseShared(url);
        eq(s.name, l.name, '名前'); eq(s.items.map(i => [i.name, i.weight, i.color, i.win]), l.items.map(i => [i.name, i.weight, i.color, i.win]), '項目');
        eq(parseShared('https://example.com/#share=壊れた'), null, '壊れたリンク');
        eq(parseShared('#share=' + b64urlEncode('{"v":1,"i":[]}')), null, '空のリスト');
        return url;
    `);
    const hash = url.split('#')[1];
    await open({ hash });
    await run(`
        await sleep(100);
        ok($('dialog').open, '追加するか聞かれる'); ok($('dialogMsg').textContent.includes('お昼ごはん'), 'リスト名が出る');
        $('dialogForm').requestSubmit(); await sleep(50);
        eq(state.lists.length, 2, 'リストが増える'); eq(curList().name, 'お昼ごはん（共有）', '同じ名前には（共有）を付ける');
        eq(curList().items[2].weight, 7, '出やすさ'); eq(curList().items[1].color, '#123456', '色');
        eq(location.hash, '', 'URL の #share= を消す');
    `);
});

test('バックアップ: 保存した形式から戻せる', async () => {
    await open();
    await run(`
        spinNow(); state.recentColors = ['#abcdef']; saveState();
        const body = JSON.stringify({ app: 'LuckyRoulette', backupVersion: 1, data: state });
        const p = JSON.parse(body);
        const st = parseSaved(JSON.stringify(p.data));
        eq(st.lists.map(l => [l.name, l.items.length, l.history.length]), state.lists.map(l => [l.name, l.items.length, l.history.length]), 'リスト');
        eq(st.totalSpins, state.totalSpins, '通算'); eq(st.recentColors, ['#abcdef'], '最近使った色');
        let bad = false; try { parseSaved('{"foo":1}'); } catch (e) { bad = true; } ok(bad, 'バックアップでないファイルは読み込まない');
    `);
});

test('タブを切り替えても、タブのバーの位置が変わらない', async () => {
    for (const [w, h] of [[390, 844], [1100, 700]]) {
        await open({ width: w, height: h });
        await run(`
            for (let k = 0; k < 9; k++) spinNow();
            const bar = document.querySelector('.tabs');
            window.scrollTo(0, rect(bar).top + scrollY - 10);
            const top0 = Math.round(rect(bar).top);
            for (const t of ['history', 'settings', 'items', 'history', 'items']) { selectTab(t); eq(Math.round(rect(bar).top), top0, '幅 ${w}: ' + t); }
        `);
    }
});

test('画面の明るさ: ライト・ダーク・端末に合わせる、再読み込み後も残る', async () => {
    await open();
    await run(`
        const bg = () => getComputedStyle(document.body).getPropertyValue('--bg').trim();
        [...$('appearances').children].find(b => b.dataset.key === 'dark').click();
        eq(document.documentElement.dataset.theme, 'dark', 'ダーク'); eq(bg(), '#110f19', 'ダークの背景');
        [...$('appearances').children].find(b => b.dataset.key === 'light').click();
        eq(bg(), '#f4f2fa', 'ライトの背景');
        eq(document.querySelector('meta[name=theme-color]').content, '#f4f2fa', 'theme-color');
    `);
    await open({ fresh: false });
    await run(`eq(document.documentElement.dataset.theme, 'light', '再読み込み後も残る'); [...$('appearances').children].find(b => b.dataset.key === 'auto').click(); eq(document.documentElement.dataset.theme, undefined, '端末に合わせる');`);
});

test('全画面モード', async () => {
    await open({ width: 390, height: 844 });
    await run(`
        const w0 = rect($('wheelWrap')).width;
        setFocus(true); await sleep(50);
        ok(getComputedStyle(document.querySelector('.side')).display === 'none', 'パネルが消える');
        ok(rect($('wheelWrap')).width >= w0, 'ルーレットが小さくならない');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        ok(!document.body.classList.contains('focus'), 'Esc で戻る');
    `);
});

test('壊れたセーブでも起動し、壊れたデータは退避する', async () => {
    await open();
    await run(`resetting = true; localStorage.setItem(SAVE_KEY, '{壊れたデータ');`);   // 閉じるときの自動保存で上書きしないように
    await open({ fresh: false });
    await run(`
        eq(curList().name, 'お昼ごはん', '初期状態で起動');
        eq(localStorage.getItem(SAVE_KEY + '_corrupted'), '{壊れたデータ', '退避');
    `);
});

test('サービスワーカー: フォントを全部保存し、オフラインでも開ける', async () => {
    await open();
    const r = await run(`
        const reg = await navigator.serviceWorker.ready;
        const reply = new Promise(res => navigator.serviceWorker.addEventListener('message', e => res(e.data), { once: true }));
        reg.active.postMessage('cacheAllFonts');
        const d = await Promise.race([reply, sleep(60000).then(() => null)]);
        ok(d, 'フォント保存の返事が来ない');
        eq((await (await caches.open('luckyroulette-fonts-v1')).keys()).length, d.fontsCached.total, 'フォントが全部保存される');
        for (const f of ['index.html', 'css/style.css', 'js/app.js', 'lib/fonts/zen-maru-gothic.css']) ok(await caches.match(f), f + ' が保存されている');
        return d.fontsCached.total;
    `);
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const loaded = waitEvent('Page.loadEventFired');
        await send('Page.reload', {});
        await loaded; await sleep(500);
        await run(`
            eq(document.title, 'LuckyRoulette', 'オフラインで開ける');
            ok(typeof doSpin === 'function', 'アプリの JS が読み込まれる');
            await document.fonts.load('700 20px "Zen Maru Gothic"', '鬱薔薇麒麟');
            ok(document.fonts.check('700 20px "Zen Maru Gothic"', '鬱薔薇麒麟'), '表示したことのない漢字も丸ゴシックで出る');
        `);
    } finally {
        await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    return `フォント ${r} 個`;
});

// ---------- 実行 ----------
let pass = 0, fail = 0;
const selected = tests.filter(t => !filters.length || filters.some(f => t.name.includes(f)));
for (const t of selected) {
    pageErrors.length = 0;
    const t0 = Date.now();
    try {
        const note = await t.fn();
        if (pageErrors.length) throw new Error('ページでエラー: ' + pageErrors.join(' / '));
        pass++;
        console.log(`  ok  ${t.name}${note ? `（${note}）` : ''}  ${Date.now() - t0}ms`);
    } catch (e) {
        fail++;
        console.log(`  NG  ${t.name}\n      ${e.message}`);
    }
}
console.log(`\n${pass} 件成功、${fail} 件失敗（${selected.length} 件中）`);
ws.close(); chrome.kill(); server.close();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => { });
process.exit(fail ? 1 : 0);
