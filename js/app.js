'use strict';

// ===== 定数 =====
const APP_VERSION = '2.0.0';   // 画面の下に薄く出す。機能を変えたら上げる
const SAVE_KEY = 'luckyroulette_save';
const SAVE_VERSION = 1;
const MAX_ITEMS = 60;
const MAX_HISTORY = 500;
const MAX_WEIGHT = 100;
const SPEEDS = {               // 回転にかける時間
    fast:   { name: 'はやい', ms: 2500 },
    normal: { name: 'ふつう', ms: 4800 },
    slow:   { name: 'じっくり', ms: 8000 },
};
const GLOW_MS = 3000;          // 当たりのマスが色を変え続ける時間（その後は虹色で止める）
const MAX_UNDO = 20;           // 削除を元に戻せる数（リストごと）
const APPEARANCES = { auto: '端末に合わせる', light: 'ライト', dark: 'ダーク' };
const MAX_RECENT_COLORS = 8;   // 「最近使った色」に残す数
const SEED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字（I, O, 0, 1）を除く

const THEMES = {
    vivid:  { name: 'ビビッド', colors: ['#ff4d6d', '#ff9f1c', '#ffd23f', '#3ccf6e', '#2fb8ff', '#5b6cff', '#b15cff', '#ff6fb5'] },
    pastel: { name: 'パステル', colors: ['#ffb3c1', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff'] },
    ocean:  { name: 'オーシャン', colors: ['#03045e', '#0077b6', '#00b4d8', '#48cae4', '#90e0ef', '#2a9d8f', '#264653', '#4895ef'] },
    forest: { name: 'フォレスト', colors: ['#2d6a4f', '#40916c', '#74c69d', '#b7e4c7', '#d4a373', '#a98467', '#606c38', '#dda15e'] },
    sunset: { name: 'サンセット', colors: ['#5f0f40', '#9a031e', '#e36414', '#fb8b24', '#ffb703', '#d62828', '#f77f00', '#7b2cbf'] },
    mono:   { name: 'モノトーン', colors: ['#222222', '#555555', '#888888', '#bbbbbb', '#e0e0e0', '#3d3d3d', '#6f6f6f', '#a2a2a2'] },
};

// ===== 状態 =====
let state;
let resetting = false;
let spin = null;          // 回転中: { start, from, to, entry }
let rotation = 0;         // ホイールの角度（度、時計回り）
let highlight = null;     // 結果表示中の項目 id
let winGlow = false;
let rafId = 0;
let spinCands = null;     // 回転中にホイールに載っている項目
let glowStart = -Infinity; // 当たりの光り始めの時刻
let pendingSync = false;   // 回転中にほかのタブで変更があった
const undoStacks = new Map(); // リスト id → 削除した項目の記録
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function makeItem(name, extra = {}) {
    return { id: uid(), name, weight: 1, color: null, win: false, ...extra };
}
function makeList(name, names = []) {
    return { id: uid(), name, items: names.map(n => makeItem(n)), excludeMode: false, excluded: [], spinCount: 0, history: [] };
}
function makeDefaultState() {
    const lunch = makeList('お昼ごはん', ['ラーメン', 'カレー', 'パスタ', '定食', 'ハンバーガー', 'お寿司']);
    lunch.items[5].win = true;
    return {
        saveVersion: SAVE_VERSION, theme: 'vivid', speed: 'normal', currentListId: lunch.id, lists: [lunch],
        totalSpins: 0,   // すべてのリストを合わせた通し番号（リストを消しても戻らない）
        snapshots: {},   // 検証用: 抽選したときの候補（名前と出やすさ）。履歴から key で参照する
        recentColors: [], // 最近使った色（新しい順）
        appearance: 'auto', // 画面の明るさ: auto（端末に合わせる）/ light / dark
    };
}

// ===== セーブ =====
function saveState() {
    if (resetting) return;
    pruneSnapshots();
    try { const raw = JSON.stringify(state); localStorage.setItem(SAVE_KEY, raw); lastRaw = raw; }
    catch (err) { console.error(err); showNotice('保存できませんでした'); }
}
let lastRaw = null;   // このタブが最後に保存・読み込みした内容（ほかのタブが書き換えたかの判定に使う）
function readRaw() {
    try { return localStorage.getItem(SAVE_KEY); } catch (err) { console.error(err); return null; }
}
// 保存データ（文字列）→ state。壊れていれば例外、中身がなければ null
function parseSaved(raw) {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || !Array.isArray(p.lists)) throw new Error('invalid save');
    const lists = p.lists.map(sanitizeList).filter(Boolean);
    if (!lists.length) return null;
    const snapshots = {};
    if (p.snapshots && typeof p.snapshots === 'object') {
        Object.entries(p.snapshots).forEach(([k, arr]) => {
            if (!Array.isArray(arr)) return;
            const ok = arr.filter(x => Array.isArray(x) && typeof x[0] === 'string' && Number.isFinite(x[1]))
                .map(x => [x[0].slice(0, 40), clampWeight(x[1])]);
            if (ok.length === arr.length && ok.length) snapshots[k] = ok;
        });
    }
    const maxG = Math.max(0, ...lists.flatMap(l => l.history.map(h => h.g || 0)));
    return {
        saveVersion: SAVE_VERSION,
        theme: THEMES[p.theme] ? p.theme : 'vivid',
        speed: SPEEDS[p.speed] ? p.speed : 'normal',
        appearance: APPEARANCES[p.appearance] ? p.appearance : 'auto',
        currentListId: lists.some(l => l.id === p.currentListId) ? p.currentListId : lists[0].id,
        lists,
        // 通算の番号がない古いデータは、各リストの回数の合計から始める
        totalSpins: Math.max(Number.isFinite(p.totalSpins) && p.totalSpins >= 0 ? Math.floor(p.totalSpins) : lists.reduce((a, l) => a + l.spinCount, 0), maxG),
        snapshots,
        recentColors: (Array.isArray(p.recentColors) ? p.recentColors : [])
            .filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => c.toLowerCase())
            .filter((c, i, a) => a.indexOf(c) === i).slice(0, MAX_RECENT_COLORS),
    };
}
// 履歴から参照されなくなった候補の記録を消す
function pruneSnapshots() {
    const used = new Set();
    state.lists.forEach(l => l.history.forEach(h => { if (h.snap) used.add(h.snap); }));
    Object.keys(state.snapshots).forEach(k => { if (!used.has(k)) delete state.snapshots[k]; });
}
function loadState() {
    state = makeDefaultState();
    const raw = readRaw();
    if (!raw) return;
    try {
        const st = parseSaved(raw);
        if (st) state = st;
        lastRaw = raw;
    } catch (err) {
        try { localStorage.setItem(SAVE_KEY + '_corrupted', raw); } catch (e) { }
        setTimeout(() => showNotice('保存データが壊れていたため、初期状態で始めました'), 0);
    }
}
// ほかのタブが保存した最新の内容を読み込む（表示中のリストはそのまま）
function syncFromStorage() {
    const raw = readRaw();
    if (!raw || raw === lastRaw) return false;   // ほかのタブが書き換えていなければ何もしない
    let st;
    try { st = parseSaved(raw); } catch (err) { return false; }
    if (!st) return false;
    const keep = state.currentListId;
    state = st;
    lastRaw = raw;
    if (state.lists.some(l => l.id === keep)) state.currentListId = keep;
    return true;
}
function sanitizeList(l) {
    if (!l || typeof l !== 'object') return null;
    const base = makeList(typeof l.name === 'string' && l.name ? l.name : 'リスト');
    const items = Array.isArray(l.items) ? l.items.filter(i => i && typeof i === 'object').slice(0, MAX_ITEMS).map(i => ({
        id: typeof i.id === 'string' ? i.id : uid(),
        name: typeof i.name === 'string' ? i.name.slice(0, 40) : '',
        weight: clampWeight(i.weight),
        color: /^#[0-9a-f]{6}$/i.test(i.color) ? i.color : null,
        win: !!i.win,
    })) : [];
    const ids = new Set(items.map(i => i.id));
    const history = (Array.isArray(l.history) ? l.history : [])
        .filter(h => h && typeof h === 'object' && Number.isFinite(h.n) && h.n >= 1 && Number.isFinite(h.time))
        .slice(0, MAX_HISTORY)
        .map(h => ({
            n: Math.floor(h.n),
            time: h.time,
            seed: typeof h.seed === 'string' ? h.seed.slice(0, 20) : '----',
            itemId: typeof h.itemId === 'string' ? h.itemId : '',
            name: typeof h.name === 'string' ? h.name.slice(0, h.kind ? 2000 : 40) : '?',
            win: !!h.win,
            ...(Number.isFinite(h.g) && h.g >= 1 ? { g: Math.floor(h.g) } : {}),
            ...(typeof h.snap === 'string' ? { snap: h.snap } : {}),
            ...(h.kind === 'pick' && Array.isArray(h.picks) ? { kind: 'pick', picks: h.picks.filter(x => typeof x === 'string').map(x => x.slice(0, 40)) } : {}),
            ...(h.kind === 'team' && Array.isArray(h.teams) ? { kind: 'team', teams: h.teams.filter(Array.isArray).map(t => t.filter(x => typeof x === 'string').map(x => x.slice(0, 40))) } : {}),
        }));
    return {
        id: typeof l.id === 'string' ? l.id : base.id,
        name: base.name,
        items,
        excludeMode: !!l.excludeMode,
        excluded: Array.isArray(l.excluded) ? l.excluded.filter(id => ids.has(id)) : [],
        spinCount: Math.max(Number.isFinite(l.spinCount) && l.spinCount >= 0 ? Math.floor(l.spinCount) : 0, history[0] ? history[0].n : 0),
        history,
    };
}
function clampWeight(w) {
    const n = Math.round(Number(w));
    return Number.isFinite(n) ? Math.min(MAX_WEIGHT, Math.max(1, n)) : 1;
}
window.addEventListener('beforeunload', () => { if (!pendingSync) saveState(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && !pendingSync) saveState(); });

// ほかのタブで変更されたら読み込み直す（A-1: 古い内容で上書きして通し番号が戻るのを防ぐ）
window.addEventListener('storage', (e) => {
    if (e.key !== SAVE_KEY || resetting) return;
    if (e.newValue === null) {        // ほかのタブで「すべてのデータを消す」をした
        if (isSpinning()) return;
        state = makeDefaultState();
        showLastOf(curList()); renderAll();
        return;
    }
    if (isSpinning()) { pendingSync = true; return; }
    applySync();
});
function applySync() {
    pendingSync = false;
    const before = curList().history[0];
    if (!syncFromStorage()) return;
    const after = curList().history[0];
    if (!before || !after || before.n !== after.n || before.seed !== after.seed) showLastOf(curList());
    if ($('dialog').open) return;     // 入力中のダイアログはそのまま
    renderAll();
}

// ===== 便利関数 =====
const $ = (id) => document.getElementById(id);
const curList = () => state.lists.find(l => l.id === state.currentListId);
const isSpinning = () => !!spin;
const anyDialogOpen = () => !!document.querySelector('dialog[open]');

function itemColor(list, item) {
    if (item.color) return item.color;
    const pal = THEMES[state.theme].colors;
    const idx = list.items.indexOf(item);
    let c = pal[idx % pal.length];
    // 最後のマスが最初のマスと同じ色にならないようにする
    if (idx === list.items.length - 1 && idx > 0 && idx % pal.length === 0) c = pal[1 % pal.length];
    return c;
}
function textColorFor(hex) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#1d1b26' : '#ffffff';
}
// ルーレットに乗る候補（名前が空のもの・除外中のものは外す）
function candidates(list) {
    return list.items.filter(i => i.name.trim() && !(list.excludeMode && list.excluded.includes(i.id)));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function formatTime(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatNo(n) { return '#' + String(n).padStart(4, '0'); }
function seedLine(h) { return `${formatNo(h.n)}${h.g ? ' · 通算' + h.g : ''} · ${formatTime(h.time)} · ${h.seed}`; }

// ===== シードと乱数 =====
function makeSeed() {
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < 8; i++) s += SEED_CHARS[buf[i] % SEED_CHARS.length];
    return s.slice(0, 4) + '-' + s.slice(4);
}
// 文字列 → 32bit ハッシュ（FNV-1a）
function hashStr(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// シード値と候補から結果を決める。同じシード値・同じ候補なら必ず同じ結果になる
function pickFromSeed(seed, cands) {
    const rng = mulberry32(hashStr(seed));
    const segs = layout(cands);
    let r = rng() * 360, index = segs.length - 1;
    for (let i = 0; i < segs.length; i++) { if (r < segs[i].end) { index = i; break; } }
    const seg = segs[index];
    const target = seg.start + (seg.end - seg.start) * (0.12 + 0.76 * rng());   // マスの端ぎりぎりは避ける
    const turns = 5 + Math.floor(rng() * 3);
    return { index, seg, target, turns };
}
// 候補の並び（角度）: 重みに合わせて 0〜360° を割り当てる。0° が真上、時計回り
function layout(cands) {
    const total = cands.reduce((s, i) => s + i.weight, 0);
    let a = 0;
    return cands.map(item => {
        const span = 360 * item.weight / total;
        const seg = { item, start: a, end: a + span };
        a += span;
        return seg;
    });
}

// ===== 描画 =====
const canvas = $('wheel');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const size = Math.max(1, Math.round(rect.width * dpr));
    // 幅と高さの両方を見る（canvas の初期値は 300×150 なので、幅がちょうど 300 だと高さが 150 のまま残り、縦に伸びる）
    if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
    drawWheel();
}

// ルーレットの文字は canvas に描くので、使う文字のフォントを読み込んでから描き直す
const WHEEL_FONT = '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "BIZ UDPGothic", system-ui, sans-serif';
let wheelFontText = '';
function ensureWheelFont(list) {
    if (!document.fonts || !document.fonts.load) return;
    const text = list.items.map(i => i.name).join('');
    if (text === wheelFontText) return;
    wheelFontText = text;
    document.fonts.load(`700 16px "Zen Maru Gothic"`, text || 'あ').then(() => { if (!spin) drawWheel(); }, () => { });
}

function drawWheel(now = performance.now()) {
    const list = curList();
    ensureWheelFont(list);
    const segs = layout(wheelItems(list));
    const W = canvas.width, R = W / 2;
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.translate(R, R);

    if (!segs.length) {
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--panel-2');
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        return;
    }

    // 結果の表示中に並びが変わったら、針が結果のマスを指すように合わせ直す
    if (!spin && highlight) {
        const hs = segs.find(sg => sg.item.id === highlight);
        const pAt = (((-rotation) % 360) + 360) % 360;
        if (hs && !(pAt >= hs.start && pAt < hs.end)) rotation = -(hs.start + hs.end) / 2;
    }
    const glowing = now - glowStart < GLOW_MS;
    const toRad = (deg) => (deg - 90 + rotation) * Math.PI / 180;
    segs.forEach((seg, i) => {
        const { item } = seg;
        const a0 = toRad(seg.start), a1 = toRad(seg.end);
        let fill = itemColor(list, item);
        if (highlight === item.id && winGlow) {
            if (glowing) {
                fill = `hsl(${(now / 6) % 360}, 90%, 60%)`;
            } else if (ctx.createConicGradient) {   // 光り終わったら虹色で止める
                const g = ctx.createConicGradient(a0, 0, 0);
                const frac = (a1 - a0) / (2 * Math.PI);
                const rb = ['#ff3b5c', '#ff9f1a', '#ffe14d', '#3ccf6e', '#2fb8ff', '#8a5cff'];
                rb.forEach((c, k) => g.addColorStop(frac * k / (rb.length - 1), c));
                fill = g;
            } else {
                fill = '#ff9f1a';
            }
        }
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (highlight && highlight !== item.id) {   // 結果以外は暗くする
            ctx.fillStyle = 'rgba(0,0,0,.35)';
            ctx.fill();
        }
        if (segs.length > 1) {
            ctx.strokeStyle = 'rgba(255,255,255,.55)';
            ctx.lineWidth = Math.max(1, W / 300);
            ctx.stroke();
        }

        // 文字（中心から外向き）
        const span = seg.end - seg.start;
        const mid = (a0 + a1) / 2;
        const maxLen = R * 0.7;
        let fontPx = Math.min(R * 0.11, (span / 360) * 2 * Math.PI * R * 0.62 * 0.8);
        if (segs.length === 1) fontPx = R * 0.11;
        if (fontPx < W * 0.012) return;           // 細すぎるマスは文字を省く
        ctx.save();
        // 左半分のマスは文字が逆さにならないよう、向きを反対にする。
        // 回転中は止まる位置で判定する（今の角度で判定すると、真上・真下を通るたびに文字が裏返ってチラつく）
        const restRot = spin ? spin.to : rotation;
        const restMid = ((seg.start + seg.end) / 2 - 90 + restRot) * Math.PI / 180;
        const flip = segs.length > 1 && Math.cos(restMid) < 0;
        ctx.rotate(segs.length === 1 ? -Math.PI / 2 : (flip ? mid + Math.PI : mid));
        ctx.fillStyle = (highlight === item.id && winGlow) ? '#ffffff' : textColorFor(itemColor(list, item));
        ctx.textAlign = flip ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${fontPx}px ${WHEEL_FONT}`;
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${(-fontPx * 0.07).toFixed(2)}px`;   // canvas では palt が効かないので少し詰める
        let label = item.name;
        while (label.length > 1 && ctx.measureText(label).width > maxLen) label = label.slice(0, -1);
        if (label !== item.name) label = label.slice(0, -1) + '…';
        if (highlight === item.id && winGlow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = fontPx / 3; }
        else if (ctx.fillStyle === '#ffffff') { ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = fontPx / 6; ctx.shadowOffsetY = fontPx / 20; }
        ctx.fillText(label, flip ? -R * 0.88 : R * 0.88, 0);
        ctx.restore();
    });
    // 光沢（左上が明るく、縁が少し暗い）
    const gl = ctx.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.05, 0, 0, R);
    gl.addColorStop(0, 'rgba(255,255,255,.20)');
    gl.addColorStop(0.5, 'rgba(255,255,255,.03)');
    gl.addColorStop(0.86, 'rgba(0,0,0,0)');
    gl.addColorStop(1, 'rgba(0,0,0,.30)');
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = gl; ctx.fill();
    ctx.restore();
}

function loop(now) {
    rafId = 0;
    if (spin) {
        const t = Math.min(1, (now - spin.start) / spin.ms);
        const eased = 1 - Math.pow(1 - t, 4);     // だんだん遅くなる
        rotation = spin.from + (spin.to - spin.from) * eased;
        kickPointer(now);
        if (t >= 1) finishSpin();
    }
    drawWheel(now);
    // 当たりの光りは GLOW_MS で止める（ずっと描き直すと電池を使う）
    if (spin || (winGlow && now - glowStart < GLOW_MS + 100)) rafId = requestAnimationFrame(loop);
}
function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }

// 針: マスの境目を通るたびに、少し跳ねる
const POINTER_KICK_DEG = 24;
const POINTER_KICK_MS = 130;
function kickPointer(now) {
    const p = (((-rotation) % 360) + 360) % 360;
    const idx = spin.segs.findIndex(sg => p >= sg.start && p < sg.end);
    if (idx !== spin.lastIdx) {
        if (spin.lastIdx !== -1) spin.kick = now;
        spin.lastIdx = idx;
    }
    const k = Math.max(0, 1 - (now - spin.kick) / POINTER_KICK_MS);
    // 盤面は時計回り（上では右向き）に動くので、針の先は右へ押される
    $('pointer').style.transform = k > 0 && !reduceMotion ? `translateX(-50%) rotate(${-POINTER_KICK_DEG * k}deg)` : '';
}

// ===== 抽選 =====
function doSpin() {
    if (isSpinning() || anyDialogOpen()) return;
    // ほかのタブで回していたら、その通し番号の続きから数える
    if (syncFromStorage()) { pendingSync = false; }
    const list = curList();
    const cands = candidates(list);
    if (!cands.length) return;

    const seed = makeSeed();
    const { seg, target, turns } = pickFromSeed(seed, cands);

    // 針（真上）が target を指す角度: rotation ≡ -target (mod 360)
    const from = ((rotation % 360) + 360) % 360;
    let delta = ((-target - from) % 360 + 360) % 360;
    const to = from + turns * 360 + delta;

    // 回し始めた時点で履歴に記録する（途中で再読み込みしても、やり直しにならない）
    list.spinCount += 1;
    state.totalSpins += 1;
    // 検証用に、このときの候補（名前と出やすさ）を記録する。同じ内容は 1 つにまとめる
    const snap = cands.map(i => [i.name, i.weight]);
    const snapKey = hashStr(JSON.stringify(snap)).toString(36) + '-' + snap.length;
    state.snapshots[snapKey] = snap;
    const entry = { n: list.spinCount, g: state.totalSpins, time: Date.now(), seed, itemId: seg.item.id, name: seg.item.name, win: seg.item.win, snap: snapKey };
    list.history.unshift(entry);
    if (list.history.length > MAX_HISTORY) list.history.length = MAX_HISTORY;
    if (list.excludeMode && !list.excluded.includes(seg.item.id)) list.excluded.push(seg.item.id);
    saveState();

    rotation = from;
    highlight = null;
    winGlow = false;
    $('wheelWrap').classList.remove('rainbow');
    $('result').className = 'result';
    $('result').textContent = '';
    $('seedLine').textContent = seedLine(entry);
    // 除外モードでも回転中は今の並びのままにする
    spin = { start: performance.now(), from, to, entry, ms: SPEEDS[state.speed].ms, segs: layout(cands), lastIdx: -1, kick: -Infinity };
    spinCands = cands;
    renderAll();
    startLoop();
}
function finishSpin() {
    const { entry, to } = spin;
    rotation = to % 360;
    spin = null;
    spinCands = null;
    $('pointer').style.transform = '';
    showResult(entry, true);
    if (entry.win) burstConfetti();
    if (pendingSync) applySync();
    renderAll();
}

// ===== 紙吹雪（当たりのとき） =====
const CONFETTI_MS = 2600;
const CONFETTI_COLORS = ['#ff3b5c', '#ff9f1a', '#ffe14d', '#3ccf6e', '#2fb8ff', '#8a5cff', '#ff6fb5'];
function burstConfetti() {
    if (reduceMotion) return;
    const cv = $('confetti');
    const cx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.hidden = false;
    const wr = $('wheelWrap').getBoundingClientRect();
    const ox = wr.left + wr.width / 2, oy = wr.top + wr.height / 2;
    const parts = Array.from({ length: 140 }, () => {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;   // 上向きに広がる
        const v = 6 + Math.random() * 9;
        return {
            x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
            w: 6 + Math.random() * 6, h: 4 + Math.random() * 4,
            r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
            c: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        };
    });
    const t0 = performance.now();
    let last = t0, done = false;
    const stop = () => { if (done) return; done = true; cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, cv.width, cv.height); cv.hidden = true; };
    setTimeout(stop, CONFETTI_MS + 300);   // 裏に回って描画が止まっても、必ず消す
    const step = (now) => {
        if (done) return;
        const dt = Math.min(2, (now - last) / 16.7);   // 60fps を 1 とした経過
        last = now;
        cx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cx.clearRect(0, 0, W, H);
        const fade = Math.min(1, Math.max(0, (CONFETTI_MS - (now - t0)) / 600));
        cx.globalAlpha = fade;
        parts.forEach(q => {
            q.vy += 0.35 * dt; q.vx *= Math.pow(0.99, dt); q.vy *= Math.pow(0.99, dt);
            q.x += q.vx * dt; q.y += q.vy * dt; q.r += q.vr * dt;
            cx.save(); cx.translate(q.x, q.y); cx.rotate(q.r);
            cx.fillStyle = q.c; cx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h * Math.abs(Math.cos(q.r * 2)) + 1);
            cx.restore();
        });
        if (now - t0 < CONFETTI_MS) requestAnimationFrame(step);
        else stop();
    };
    requestAnimationFrame(step);
}

function showResult(entry, animate = false) {
    const list = curList();
    const el = $('result');
    if (!entry) { el.className = 'result'; el.textContent = ''; return; }
    highlight = entry.kind ? null : entry.itemId;
    const stillOnWheel = !entry.kind && wheelItems(list).some(i => i.id === entry.itemId);
    if (!stillOnWheel) highlight = null;
    winGlow = !!entry.win && stillOnWheel;
    glowStart = animate && !reduceMotion ? performance.now() : -Infinity;
    el.className = 'result';
    el.textContent = '';
    const card = document.createElement('div');
    card.className = 'rcard' + (entry.win && !entry.kind ? ' win' : '') + (animate && !reduceMotion ? ' pop' : '');
    const label = document.createElement('span'); label.className = 'rlabel';
    label.textContent = entry.kind === 'team' ? `チーム分け（${entry.teams.length}チーム）` : entry.kind === 'pick' ? `まとめて抽選（${entry.picks.length}個）` : entry.win ? '★ 当たり！' : '結果';
    const name = document.createElement('span'); name.className = entry.kind ? 'rlist' : 'rname'; name.textContent = entry.name;
    card.append(label, name);
    el.append(card);
    $('wheelWrap').classList.toggle('rainbow', !!entry.win && !entry.kind);
    if (winGlow) startLoop();
}

function clearResult() {
    highlight = null; winGlow = false;
    $('wheelWrap').classList.remove('rainbow');
    $('result').className = 'result';
    $('result').textContent = '';
}

// ホイールに描く項目。回転中は回し始めの並びのまま。
// 除外モードで結果を表示している間は、出た項目もホイールに残す
function wheelItems(list) {
    if (spinCands && list === curList()) return spinCands;
    const c = candidates(list);
    if (highlight && list.excludeMode && !c.some(i => i.id === highlight)) {
        return list.items.filter(i => c.includes(i) || i.id === highlight);
    }
    return c;
}

// ===== 画面の更新 =====
// 変わったところだけ書き換える。入力中の欄は上書きしない（フォーカスや変換中の文字を消さないため）
let listsSig = '';
function renderLists() {
    const sel = $('listSelect');
    const sig = state.lists.map(l => l.id + '\u0001' + l.name).join('\u0002');
    if (sig !== listsSig) {
        listsSig = sig;
        sel.textContent = '';
        state.lists.forEach(l => {
            const o = document.createElement('option');
            o.value = l.id; o.textContent = l.name;
            sel.append(o);
        });
    }
    sel.value = state.currentListId;
}

const itemRows = new Map();   // 項目 id → その行の要素
let rowsListId = null;
const findItem = (id) => curList().items.find(i => i.id === id);

// 線の太さをそろえたアイコン（中身は固定の文字列だけ）
const ICONS = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    star: '<path class="fill" d="M12 3.6l2.55 5.17 5.7.83-4.13 4.02.98 5.68L12 16.6l-5.1 2.7.98-5.68L3.75 9.6l5.7-.83z"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    grip: '<circle class="dot" cx="9" cy="6" r="1.5"/><circle class="dot" cx="15" cy="6" r="1.5"/><circle class="dot" cx="9" cy="12" r="1.5"/><circle class="dot" cx="15" cy="12" r="1.5"/><circle class="dot" cx="9" cy="18" r="1.5"/><circle class="dot" cx="15" cy="18" r="1.5"/>',
};
function svgIcon(name) { return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; }

function createItemRow(id) {
    const r = {};
    r.li = document.createElement('li');
    r.handle = document.createElement('span');
    r.handle.className = 'handle'; r.handle.innerHTML = svgIcon('grip'); r.handle.title = 'ドラッグで並べ替え';
    r.handle.addEventListener('pointerdown', (e) => startDrag(e, r.li, r.handle));

    r.sw = document.createElement('button');
    r.sw.type = 'button'; r.sw.className = 'swatch';
    r.sw.addEventListener('click', () => openColorDialog(id));

    const nameWrap = document.createElement('div');
    nameWrap.className = 'name-wrap';
    r.name = document.createElement('input');
    r.name.type = 'text'; r.name.className = 'name'; r.name.maxLength = 40; r.name.setAttribute('aria-label', '項目の名前');
    r.name.addEventListener('input', () => { const it = findItem(id); if (!it) return; it.name = r.name.value; drawWheel(); renderStage(); });
    r.name.addEventListener('change', () => { const it = findItem(id); if (!it) return; it.name = r.name.value.trim(); r.name.value = it.name; saveState(); renderAll(); });
    const odds = document.createElement('div'); odds.className = 'odds';
    const bar = document.createElement('span'); bar.className = 'bar';
    r.fill = document.createElement('i');
    bar.append(r.fill);
    r.pct = document.createElement('span'); r.pct.className = 'pct';
    odds.append(bar, r.pct);
    nameWrap.append(r.name, odds);

    r.w = document.createElement('input');
    r.w.type = 'number'; r.w.min = 1; r.w.max = MAX_WEIGHT; r.w.step = 1; r.w.inputMode = 'numeric';
    r.w.title = '出やすさ（1〜' + MAX_WEIGHT + '）'; r.w.setAttribute('aria-label', '出やすさ');
    r.w.addEventListener('change', () => { const it = findItem(id); if (!it) return; it.weight = clampWeight(r.w.value); r.w.value = it.weight; saveState(); renderAll(); });
    r.minus = stepButton('minus', '出やすさを下げる', stepWeight(id, -1));
    r.plus = stepButton('plus', '出やすさを上げる', stepWeight(id, 1));
    r.stepper = document.createElement('div'); r.stepper.className = 'stepper';
    r.stepper.append(r.minus, r.w, r.plus);

    r.star = document.createElement('button');
    r.star.type = 'button'; r.star.className = 'star'; r.star.innerHTML = svgIcon('star');
    r.star.addEventListener('click', () => { const it = findItem(id); if (!it) return; it.win = !it.win; saveState(); renderItems(); });

    r.del = document.createElement('button');
    r.del.type = 'button'; r.del.className = 'del'; r.del.innerHTML = svgIcon('x'); r.del.title = '削除'; r.del.setAttribute('aria-label', '削除');
    r.del.addEventListener('click', () => deleteItem(id));

    r.li.append(r.handle, r.sw, nameWrap, r.stepper, r.star, r.del);
    return r;
}

// − / ＋ ボタン。長押しすると続けて変わる
function stepButton(kind, label, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = svgIcon(kind);
    let timer = 0;
    const stopRepeat = () => { clearTimeout(timer); timer = 0; };
    b.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        stopRepeat();
        const repeat = (delay) => { timer = setTimeout(() => { if (b.disabled) return stopRepeat(); fn(false); repeat(70); }, delay); };
        repeat(450);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => b.addEventListener(t, () => { if (timer) { stopRepeat(); saveState(); } }));
    b.addEventListener('click', () => fn(true));   // 1 回押し（キーボードの Enter / Space も）
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
}
function stepWeight(id, d) {
    return (save) => {
        const it = findItem(id);
        if (!it || isSpinning()) return;
        it.weight = clampWeight(it.weight + d);
        renderAll();
        if (save) saveState();
    };
}

function deleteItem(id) {
    const list = curList();
    const item = list.items.find(i => i.id === id);
    if (!item || isSpinning()) return;
    const stack = undoStacks.get(list.id) || [];
    stack.push({ item, index: list.items.indexOf(item), wasExcluded: list.excluded.includes(id) });
    if (stack.length > MAX_UNDO) stack.shift();
    undoStacks.set(list.id, stack);
    list.items = list.items.filter(i => i !== item);
    list.excluded = list.excluded.filter(x => x !== id);
    if (highlight === id) clearResult();
    saveState(); renderAll();
}

function setIfIdle(input, value) {   // 入力中の欄は上書きしない
    if (document.activeElement !== input && input.value !== String(value)) input.value = value;
}

function renderItems() {
    const list = curList();
    const ul = $('items');
    if (rowsListId !== list.id) { itemRows.clear(); ul.textContent = ''; rowsListId = list.id; }
    const spinning = isSpinning();
    const total = list.items.filter(i => i.name.trim() && !(list.excludeMode && list.excluded.includes(i.id))).reduce((s, i) => s + i.weight, 0);
    const seen = new Set();
    list.items.forEach((item, idx) => {
        let r = itemRows.get(item.id);
        if (!r) { r = createItemRow(item.id); itemRows.set(item.id, r); }
        seen.add(item.id);
        const excluded = list.excludeMode && list.excluded.includes(item.id);
        r.li.className = 'item' + (excluded ? ' excluded' : '');
        const color = itemColor(list, item);
        r.sw.style.background = color;
        r.sw.title = item.color ? '色を変える' : '色を変える（今はテーマの自動配色）';
        r.sw.setAttribute('aria-label', `「${item.name || '名前なし'}」の色`);
        setIfIdle(r.name, item.name);
        const share = !excluded && item.name.trim() && total ? 100 * item.weight / total : 0;
        r.pct.textContent = excluded ? '除外中' : (share ? share.toFixed(1) + '%' : '―');
        r.fill.style.width = share.toFixed(2) + '%';
        r.fill.style.background = color;
        setIfIdle(r.w, item.weight);
        r.star.setAttribute('aria-pressed', item.win ? 'true' : 'false');
        r.star.title = item.win ? '当たり（押すと外す）' : '当たりにする';
        [r.sw, r.name, r.w, r.star, r.del].forEach(el => { el.disabled = spinning; });
        r.minus.disabled = spinning || item.weight <= 1;
        r.plus.disabled = spinning || item.weight >= MAX_WEIGHT;
        if (ul.children[idx] !== r.li) ul.insertBefore(r.li, ul.children[idx] || null);
    });
    for (const [id, r] of itemRows) {
        if (!seen.has(id)) { r.li.remove(); itemRows.delete(id); }
    }
    $('addName').disabled = spinning || list.items.length >= MAX_ITEMS;
    $('addName').placeholder = list.items.length >= MAX_ITEMS ? `項目は${MAX_ITEMS}個まで` : '項目を追加';
    $('resetExcluded').hidden = !list.excludeMode;
    $('resetExcluded').disabled = spinning || !list.excluded.length;
    const stack = undoStacks.get(list.id) || [];
    const lastDel = stack[stack.length - 1];
    $('undoDelete').hidden = !lastDel;
    $('undoDelete').disabled = spinning;
    $('undoDelete').textContent = lastDel ? `↩ 「${lastDel.item.name || '(名前なし)'}」を元に戻す` : '';
}

// 履歴の 1 件を検証する: 記録した候補とシード値から結果を計算し直し、記録と比べる
function verifyEntry(h) {
    const snap = h.snap && state.snapshots[h.snap];
    if (!snap) return { ok: null, text: 'この記録には検証用のデータがありません（機能を追加する前の記録です）。' };
    const cands = snap.map(([name, weight]) => ({ name, weight }));
    if (h.kind) {
        const n = h.kind === 'team' ? h.teams.length : h.picks.length;
        const again = summarizeMulti(h.kind, drawMulti(h.seed, cands, h.kind, n));
        const ok = again === h.name;
        const list = cands.map(c => c.name).join('、');
        return ok ? { ok: true, text: `シード値 ${h.seed} から計算し直しても同じ結果になりました。`, list }
            : { ok: false, text: `計算し直すと「${again}」になり、記録と一致しません。`, list };
    }
    const { seg } = pickFromSeed(h.seed, cands);
    const total = cands.reduce((a, c) => a + c.weight, 0);
    const list = cands.map(c => `${c.name}（${(100 * c.weight / total).toFixed(1)}%）`).join('、');
    return seg.item.name === h.name
        ? { ok: true, text: `シード値 ${h.seed} から計算し直しても「${seg.item.name}」になりました。`, list }
        : { ok: false, text: `計算し直すと「${seg.item.name}」になり、記録の「${h.name}」と一致しません。`, list };
}

let historySig = '';
function dayLabel(ms) {
    const d = new Date(ms), t = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(t) - day(d)) / 864e5);
    if (diff === 0) return '今日';
    if (diff === 1) return '昨日';
    const w = '日月火水木金土'[d.getDay()];
    return `${d.getFullYear() !== t.getFullYear() ? d.getFullYear() + '年' : ''}${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}
function renderHistory() {
    const list = curList();
    const ul = $('history');
    // 回転中の結果はまだ見せない
    const entries = list.history.filter(h => !(spin && h === spin.entry));
    const colors = list.items.map(i => i.id + itemColor(list, i)).join(',');
    const sig = [list.id, list.history.length, entries.length, entries[0] ? entries[0].n + entries[0].seed : '', colors, new Date().toDateString()].join('|');
    $('hsList').textContent = list.spinCount.toLocaleString();
    $('hsTotal').textContent = state.totalSpins.toLocaleString();
    $('clearHistory').disabled = isSpinning() || !list.history.length;
    if (sig === historySig) return;
    historySig = sig;
    ul.textContent = '';
    if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'hempty';
        const b = document.createElement('b'); b.textContent = 'まだ記録がありません';
        li.append(b, '「回す」を押すと、結果がここに残ります');
        ul.append(li);
    }
    let lastDay = '';
    entries.forEach(h => {
        const day = dayLabel(h.time);
        if (day !== lastDay) {
            lastDay = day;
            const g = document.createElement('li'); g.className = 'hgroup'; g.textContent = day;
            ul.append(g);
        }
        const li = document.createElement('li');
        li.className = 'hrow' + (h.win ? ' win' : '');
        const it = h.kind ? null : list.items.find(i => i.id === h.itemId);
        const dot = document.createElement('i'); dot.className = 'hdot';
        dot.style.background = it ? itemColor(list, it) : 'var(--line)';
        const main = document.createElement('div'); main.className = 'hmain';
        const name = document.createElement('div'); name.className = 'hname';
        const nm = document.createElement('span'); nm.textContent = h.name;
        name.append(nm);
        if (h.kind) { const bd = document.createElement('span'); bd.className = 'hbadge multi'; bd.textContent = h.kind === 'team' ? `${h.teams.length}チーム` : `${h.picks.length}個`; name.append(bd); }
        if (h.win) { const bd = document.createElement('span'); bd.className = 'hbadge'; bd.textContent = '★ 当たり'; name.append(bd); }
        const meta = document.createElement('div'); meta.className = 'hmeta';
        const d = new Date(h.time);
        const seed = document.createElement('span'); seed.className = 'mono'; seed.textContent = h.seed;
        meta.append(`${pad2(d.getHours())}:${pad2(d.getMinutes())} · `, seed, h.g ? ` · 通算${h.g}` : '');
        meta.title = seedLine(h);
        main.append(name, meta);
        const no = document.createElement('span'); no.className = 'hno'; no.textContent = formatNo(h.n);
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn sub verify-btn'; btn.textContent = '検証';
        btn.addEventListener('click', () => {
            const old = li.querySelector('.verify');
            if (old) { old.remove(); return; }
            const v = verifyEntry(h);
            const box = document.createElement('div');
            box.className = 'verify' + (v.ok === true ? ' ok' : v.ok === false ? ' ng' : '');
            const head = document.createElement('b');
            head.textContent = v.ok === true ? '✓ 一致 ' : v.ok === false ? '✗ 不一致 ' : '';
            box.append(head, document.createTextNode(v.text));
            if (v.list) {
                const c = document.createElement('div'); c.className = 'cands';
                c.textContent = '候補: ' + v.list;
                box.append(c);
            }
            li.append(box);
        });
        li.append(dot, main, no, btn);
        ul.append(li);
    });
}

// 設定のボタンは最初に 1 回だけ作り、押された状態だけ更新する
function buildSettings() {
    const box = $('themes');
    Object.entries(THEMES).forEach(([key, t]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'theme'; b.dataset.key = key;
        b.textContent = t.name;
        const dots = document.createElement('span'); dots.className = 'dots';
        t.colors.slice(0, 6).forEach(c => { const i = document.createElement('i'); i.style.background = c; dots.append(i); });
        b.append(dots);
        b.addEventListener('click', () => { state.theme = key; saveState(); renderAll(); });
        box.append(b);
    });
    const ap = $('appearances');
    Object.entries(APPEARANCES).forEach(([key, name]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.key = key; b.textContent = name;
        b.addEventListener('click', () => { state.appearance = key; saveState(); renderSettings(); drawWheel(); });
        ap.append(b);
    });
    // 端末の明るさが変わったら、theme-color を合わせ直す
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyAppearance());
    const sp = $('speeds');
    Object.entries(SPEEDS).forEach(([key, v]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.key = key;
        b.textContent = v.name;
        const sm = document.createElement('small'); sm.textContent = (v.ms / 1000).toFixed(1) + ' 秒';
        b.append(sm);
        b.addEventListener('click', () => { state.speed = key; saveState(); renderSettings(); });
        sp.append(b);
    });
}
function applyAppearance() {
    const a = state.appearance;
    if (a === 'light' || a === 'dark') document.documentElement.dataset.theme = a;
    else delete document.documentElement.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#1b1730';
}
function renderSettings() {
    applyAppearance();
    document.querySelectorAll('#appearances button').forEach(b => b.setAttribute('aria-pressed', state.appearance === b.dataset.key ? 'true' : 'false'));
    document.querySelectorAll('#themes .theme').forEach(b => b.setAttribute('aria-pressed', state.theme === b.dataset.key ? 'true' : 'false'));
    document.querySelectorAll('#speeds button').forEach(b => {
        b.setAttribute('aria-pressed', state.speed === b.dataset.key ? 'true' : 'false');
        b.disabled = isSpinning();
    });
    $('excludeMode').checked = curList().excludeMode;
    $('excludeMode').disabled = isSpinning();
    ['backupSave', 'backupLoad'].forEach(id => { $(id).disabled = isSpinning(); });
}

function renderStage() {
    const list = curList();
    const n = candidates(list).length;
    $('spinBtn').disabled = isSpinning() || n === 0;
    $('spinBtn').textContent = isSpinning() ? '…' : '回す';
    let msg = '';
    if (!isSpinning()) {
        if (!list.items.some(i => i.name.trim())) msg = '「項目」タブで項目を追加してください';
        else if (n === 0) msg = 'すべての項目が除外されました。「除外をリセット」で元に戻せます';
    }
    if (!noticeTimer) $('notice').textContent = msg;
    $('copyResult').hidden = isSpinning() || !list.history.length;
    ['newList', 'renameList', 'deleteList', 'listSelect', 'listMenuBtn', 'shareList', 'importShared', 'batchBtn'].forEach(id => { $(id).disabled = isSpinning(); });
    $('batchBtn').disabled = isSpinning() || n === 0;
    $('deleteList').disabled = isSpinning() || state.lists.length <= 1;
}

function renderAll() {
    renderLists();
    renderItems();
    renderHistory();
    renderSettings();
    renderStage();
    drawWheel();
}

let noticeTimer = 0;
function showNotice(msg) {
    $('notice').textContent = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeTimer = 0; renderStage(); }, 4000);
}

// リストを切り替えたとき・起動時: 最後の結果を表示する
function showLastOf(list) {
    rotation = 0;
    clearResult();
    const last = list.history[0];
    $('seedLine').textContent = last ? seedLine(last) : '';
    if (last) {
        // 最後に出た項目が針の位置に来るように合わせる
        const it = list.items.find(i => i.id === last.itemId);
        showResult(last, false);
        if (it) {
            const seg = layout(wheelItems(list)).find(s => s.item.id === it.id);
            if (seg) rotation = -(seg.start + seg.end) / 2;
        }
    }
}

// ===== ダイアログ（prompt / confirm の代わり。アプリ内ブラウザでも動くように） =====
// input が null なら確認（true / false）、文字列なら入力（文字列 / null）を返す
function ask(message, { input = null, okLabel = 'OK', danger = false, maxLength = 30 } = {}) {
    const dlg = $('dialog');
    if (!dlg.showModal) {               // <dialog> がない古いブラウザ
        return Promise.resolve(input === null ? confirm(message) : prompt(message, input));
    }
    return new Promise((resolve) => {
        $('dialogMsg').textContent = message;
        const inp = $('dialogInput');
        inp.hidden = input === null;
        inp.value = input === null ? '' : input;
        inp.maxLength = maxLength;
        $('dialogOk').textContent = okLabel;
        $('dialogOk').className = 'btn' + (danger ? ' danger-fill' : '');
        dialogDone = (ok) => {
            dialogDone = null;
            if (dlg.open) dlg.close();
            resolve(input === null ? ok : (ok ? inp.value : null));
            renderAll();
        };
        dlg.showModal();
        if (input !== null) { inp.focus(); inp.select(); } else { $('dialogOk').focus(); }
    });
}
let dialogDone = null;   // 開いているダイアログを閉じて結果を返す関数
$('dialogForm').addEventListener('submit', (e) => { e.preventDefault(); if (dialogDone) dialogDone(true); });
$('dialogCancel').addEventListener('click', () => { if (dialogDone) dialogDone(false); });
$('dialog').addEventListener('close', () => { if (dialogDone) dialogDone(false); });   // Esc キーで閉じたとき

// ===== 色選びパネル =====
let colorItemId = null;   // 色を選んでいる項目の id
function addRecentColor(c) {
    c = c.toLowerCase();
    state.recentColors = [c, ...state.recentColors.filter(x => x !== c)].slice(0, MAX_RECENT_COLORS);
}
function colorButton(hex, current, label) {
    const b = document.createElement('button');
    b.type = 'button'; b.style.background = hex; b.dataset.color = hex;
    b.title = label || hex; b.setAttribute('aria-label', label || hex);
    b.setAttribute('aria-pressed', hex.toLowerCase() === current ? 'true' : 'false');
    return b;
}
function fillColorDialog() {
    const list = curList();
    const item = findItem(colorItemId);
    if (!item) { closeColorDialog(); return; }
    const current = itemColor(list, item).toLowerCase();
    const fixed = item.color ? current : '';   // 自動配色のときは、どれも選ばれていない表示にする
    $('cdTitle').textContent = `「${item.name || '名前なし'}」の色`;
    $('cdPreview').style.background = current;
    $('cdCustom').value = current;
    $('cdAuto').disabled = !item.color;

    const recent = $('cdRecent'); recent.textContent = '';
    state.recentColors.forEach(c => recent.append(colorButton(c, fixed)));
    $('cdRecentSec').hidden = !state.recentColors.length;

    const same = $('cdSame'); same.textContent = '';
    list.items.filter(i => i !== item && i.name.trim()).forEach(i => {
        const c = itemColor(list, i).toLowerCase();
        const b = colorButton(c, '', `「${i.name}」と同じ色`);
        b.style.background = '';
        const dot = document.createElement('i'); dot.style.background = c;
        const nm = document.createElement('span'); nm.textContent = i.name;
        b.append(dot, nm);
        same.append(b);
    });
    $('cdSameSec').hidden = !same.children.length;

    const theme = $('cdTheme'); theme.textContent = '';
    THEMES[state.theme].colors.forEach(c => theme.append(colorButton(c, fixed)));
}
function openColorDialog(id) {
    if (isSpinning()) return;
    colorItemId = id;
    fillColorDialog();
    const dlg = $('colorDialog');
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); }
    else $('cdCustom').click();   // <dialog> がない古いブラウザは端末の色選びだけ出す
}
function closeColorDialog() {
    const dlg = $('colorDialog');
    if (dlg.open) dlg.close();
}
// 色を決める（null なら自動に戻す）
function applyColor(hex) {
    const item = findItem(colorItemId);
    if (!item || isSpinning()) { closeColorDialog(); return; }
    item.color = hex ? hex.toLowerCase() : null;
    if (hex) addRecentColor(hex);
    saveState(); renderAll();
    closeColorDialog();
}
['cdRecent', 'cdSame', 'cdTheme'].forEach(id => $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-color]');
    if (b) applyColor(b.dataset.color);
}));
$('cdAuto').addEventListener('click', () => applyColor(null));
$('cdClose').addEventListener('click', closeColorDialog);
$('colorDialog').addEventListener('click', (e) => { if (e.target === $('colorDialog')) closeColorDialog(); });   // 外側を押したら閉じる
$('colorDialog').addEventListener('close', () => { colorItemId = null; });
// 端末の色選び: 動かしている間はルーレットに反映し、決めたら保存する
$('cdCustom').addEventListener('input', (e) => {
    const item = findItem(colorItemId);
    if (!item || isSpinning()) return;
    item.color = e.target.value;
    $('cdPreview').style.background = e.target.value;
    renderItems(); drawWheel();
});
$('cdCustom').addEventListener('change', (e) => applyColor(e.target.value));

// ===== 並べ替え（左端の ⋮⋮ をドラッグ） =====
function startDrag(e, li, handle) {
    if (isSpinning()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const ul = $('items');
    const rows = [...ul.children];
    const from = rows.indexOf(li);
    if (from < 0 || rows.length < 2) return;
    const rects = rows.map(r => r.getBoundingClientRect());
    const step = rects[1].top - rects[0].top;       // 1 行ぶんの高さ（すき間込み）
    const startY = e.clientY;
    let to = from;
    li.classList.add('dragging');
    ul.classList.add('sorting');
    try { handle.setPointerCapture(e.pointerId); } catch (err) { }

    const move = (ev) => {
        const dy = ev.clientY - startY;
        li.style.transform = `translateY(${dy}px)`;
        const cy = rects[from].top + rects[from].height / 2 + dy;
        to = 0;
        rows.forEach((r, i) => { if (i !== from && rects[i].top + rects[i].height / 2 < cy) to++; });
        rows.forEach((r, i) => {
            if (i === from) return;
            let shift = 0;
            if (from < i && i <= to) shift = -step;
            else if (to <= i && i < from) shift = step;
            r.style.transform = shift ? `translateY(${shift}px)` : '';
            r.style.transition = 'transform .12s';
        });
    };
    const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
        li.classList.remove('dragging');
        ul.classList.remove('sorting');
        if (to !== from && !isSpinning()) {
            const list = curList();
            const [moved] = list.items.splice(from, 1);
            list.items.splice(to, 0, moved);
            saveState();
        }
        renderAll();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

// ===== 結果のコピー =====
function copyText(text) {
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.append(ta); ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { }
        ta.remove();
        return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => fallback());
    }
    return Promise.resolve(fallback());
}
function resultText(list, h) {
    if (h.kind === 'team') return `【${list.name}】${seedLine(h)} チーム分け\n` + h.teams.map((t, i) => `チーム${i + 1}: ${t.join('、')}`).join('\n');
    if (h.kind === 'pick') return `【${list.name}】${seedLine(h)} まとめて${h.picks.length}個 → ${h.name}`;
    return `【${list.name}】${seedLine(h)} → ${h.name}${h.win ? '（★当たり）' : ''}`;
}
$('copyResult').addEventListener('click', () => {
    const list = curList();
    const h = list.history[0];
    if (!h || isSpinning()) return;
    const text = resultText(list, h);
    copyText(text).then(ok => showNotice(ok ? 'コピーしました' : 'コピーできませんでした'));
});

// ===== 削除の取り消し =====
$('undoDelete').addEventListener('click', () => {
    const list = curList();
    const stack = undoStacks.get(list.id) || [];
    const rec = stack.pop();
    if (!rec || isSpinning()) return;
    if (list.items.length >= MAX_ITEMS) { stack.push(rec); showNotice(`項目は${MAX_ITEMS}個までです`); return; }
    if (!list.items.some(i => i.id === rec.item.id)) {
        list.items.splice(Math.min(rec.index, list.items.length), 0, rec.item);
        if (rec.wasExcluded && list.excludeMode) list.excluded.push(rec.item.id);
    }
    saveState(); renderAll();
});

// ===== 操作 =====
$('spinBtn').addEventListener('click', doSpin);
window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if (anyDialogOpen()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'Enter' && t && t.tagName === 'BUTTON' && t !== $('spinBtn')) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (!e.repeat) doSpin();
});
window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
});

function fitAddBox() {
    const ta = $('addName');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';
}
$('addName').addEventListener('input', fitAddBox);
$('addName').addEventListener('keydown', (e) => {
    // Enter で追加（Shift+Enter は改行）。日本語の変換を確定する Enter は除く
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if ($('addForm').requestSubmit) $('addForm').requestSubmit();
        else $('addForm').dispatchEvent(new Event('submit', { cancelable: true }));
    }
});
$('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const list = curList();
    if (isSpinning()) return;
    // 改行・「、」・「,」・タブで区切って、まとめて追加する
    const names = $('addName').value.split(/[\r\n,、，\t]+/).map(v => v.trim().slice(0, 40)).filter(Boolean);
    if (!names.length) return;
    const room = MAX_ITEMS - list.items.length;
    if (room <= 0) { showNotice(`項目は${MAX_ITEMS}個までです`); return; }
    names.slice(0, room).forEach(n => list.items.push(makeItem(n)));
    $('addName').value = '';
    fitAddBox();
    saveState(); renderAll();
    if (names.length > room) showNotice(`項目は${MAX_ITEMS}個までなので、${room}個だけ追加しました`);
    else if (names.length > 1) showNotice(`${names.length}個の項目を追加しました`);
    $('addName').focus();
});

$('listSelect').addEventListener('change', (e) => {
    if (isSpinning()) return;
    state.currentListId = e.target.value;
    saveState();
    showLastOf(curList());
    renderAll();
});
// ===== 新しいリスト（ひな形から作れる） =====
const TEMPLATES = [
    { key: 'empty', name: '空のリスト', list: '新しいリスト', items: [] },
    { key: 'coin', name: 'コイントス', items: ['表', '裏'] },
    { key: 'dice', name: 'サイコロ', items: ['1', '2', '3', '4', '5', '6'] },
    { key: 'num', name: '数字 1〜10', items: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
    { key: 'week', name: '曜日', items: ['月', '火', '水', '木', '金', '土', '日'] },
    { key: 'janken', name: 'じゃんけん', items: ['グー', 'チョキ', 'パー'] },
    { key: 'yesno', name: 'はい・いいえ', items: ['はい', 'いいえ'] },
    { key: 'dir', name: '方角', items: ['北', '東', '南', '西'] },
];
let nlTemplate = 'empty', nlNameTouched = false;
function buildTemplates() {
    const box = $('templates');
    TEMPLATES.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.key = t.key;
        b.textContent = t.name;
        const sm = document.createElement('small'); sm.textContent = t.items.length ? t.items.join('・') : '項目は自分で追加';
        b.append(sm);
        b.addEventListener('click', () => {
            nlTemplate = t.key;
            if (!nlNameTouched) $('nlName').value = t.list || t.name;
            box.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        });
        box.append(b);
    });
}
$('newList').addEventListener('click', () => {
    if (isSpinning()) return;
    nlTemplate = 'empty'; nlNameTouched = false;
    $('nlName').value = '新しいリスト';
    $('templates').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.key === 'empty' ? 'true' : 'false'));
    $('newListDialog').showModal();
    $('nlName').select();
});
$('nlName').addEventListener('input', () => { nlNameTouched = true; });
$('newListForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nlName').value.trim().slice(0, 30);
    if (!name || isSpinning()) { $('nlName').focus(); return; }
    const t = TEMPLATES.find(x => x.key === nlTemplate) || TEMPLATES[0];
    const l = makeList(name, t.items);
    state.lists.push(l);
    state.currentListId = l.id;
    $('newListDialog').close();
    saveState(); showLastOf(l); renderAll();
    selectTab('items');
    if (!t.items.length) $('addName').focus();
});
document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog.sheet').forEach(d => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
$('renameList').addEventListener('click', async () => {
    const l = curList();
    const name = ((await ask('リストの名前', { input: l.name, okLabel: '変更' })) || '').trim();
    if (!name) return;
    l.name = name.slice(0, 30);
    saveState(); renderAll();
});
$('deleteList').addEventListener('click', async () => {
    if (state.lists.length <= 1) return;
    const l = curList();
    if (!(await ask(`リスト「${l.name}」を削除しますか？\n項目と履歴も消えます。`, { okLabel: '削除', danger: true }))) return;
    if (isSpinning() || !state.lists.includes(l) || state.lists.length <= 1) return;
    undoStacks.delete(l.id);
    state.lists = state.lists.filter(x => x !== l);
    state.currentListId = state.lists[0].id;
    saveState(); showLastOf(curList()); renderAll();
});

$('resetExcluded').addEventListener('click', () => {
    const l = curList();
    l.excluded = [];
    saveState(); renderAll();
});
$('excludeMode').addEventListener('change', (e) => {
    const l = curList();
    l.excludeMode = e.target.checked;
    if (!l.excludeMode) l.excluded = [];
    clearResult();
    saveState(); renderAll();
});
$('resetColors').addEventListener('click', () => {
    curList().items.forEach(i => { i.color = null; });
    saveState(); renderAll();
});
$('clearHistory').addEventListener('click', async () => {
    const l = curList();
    if (!(await ask(`「${l.name}」の履歴を消しますか？\n通し番号は続きから数えます。`, { okLabel: '消す', danger: true }))) return;
    l.history = [];
    saveState(); renderAll();
});
$('fullReset').addEventListener('click', async () => {
    if (!(await ask('すべてのリスト・履歴・設定を消しますか？\n元に戻せません。', { okLabel: 'すべて消す', danger: true }))) return;
    resetting = true;
    [SAVE_KEY, SAVE_KEY + '_corrupted'].forEach(k => { try { localStorage.removeItem(k); } catch (e) { } });
    location.reload();
});

function selectTab(name) {
    const bar = document.querySelector('.tabs');
    const before = bar.getBoundingClientRect().top;
    const changed = $('tab-' + name).hidden;
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'));
    bar.dataset.i = String(['items', 'history', 'settings'].indexOf(name));
    ['items', 'history', 'settings'].forEach(n => { $('tab-' + n).hidden = n !== name; });
    // 中身の長さが変わってもタブのバーが画面の同じ位置に残るようにする
    const after = bar.getBoundingClientRect().top;
    if (Math.abs(after - before) > 1) window.scrollBy(0, after - before);
    if (changed) {
        const body = $('tab-' + name);
        body.classList.remove('enter'); void body.offsetWidth; body.classList.add('enter');
    }
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

// ===== リストのメニュー（⋯） =====
function setMenu(open) {
    $('listMenu').hidden = !open;
    $('listMenuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('listMenuBtn').addEventListener('click', () => setMenu($('listMenu').hidden));
$('listMenu').addEventListener('click', (e) => { if (e.target.closest('button')) setMenu(false); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu-wrap')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('listMenu').hidden) { setMenu(false); $('listMenuBtn').focus(); } });

// ===== バックアップ（A-1） =====
function todayStamp() { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; }
$('backupSave').addEventListener('click', async () => {
    saveState();
    const body = JSON.stringify({ app: 'LuckyRoulette', backupVersion: 1, version: APP_VERSION, exportedAt: Date.now(), data: state }, null, 1);
    const fileName = `luckyroulette-backup-${todayStamp()}.json`;
    const file = new File([body], fileName, { type: 'application/json' });
    // スマホは共有シート（「ファイルに保存」など）、PC はダウンロード
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: fileName }); showNotice('バックアップを保存しました'); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = fileName;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    showNotice('バックアップを保存しました');
});
$('backupLoad').addEventListener('click', () => { if (!isSpinning()) $('backupFile').click(); });
$('backupFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let st = null, when = '';
    try {
        const p = JSON.parse(await f.text());
        const data = p && p.app === 'LuckyRoulette' && p.data ? p.data : p;
        st = parseSaved(JSON.stringify(data));
        if (p && p.exportedAt) when = formatTime(p.exportedAt);
    } catch (err) { st = null; }
    if (!st) { await ask('このファイルは LuckyRoulette のバックアップとして読み込めませんでした。'); return; }
    const ok = await ask(`バックアップ${when ? `（${when} に保存）` : ''}から戻しますか？\nリスト ${st.lists.length} 個・抽選 ${st.totalSpins} 回分のデータで、今のデータを置き換えます。`, { okLabel: '戻す', danger: true });
    if (!ok || isSpinning()) return;
    state = st;
    undoStacks.clear();
    saveState(); showLastOf(curList()); renderAll();
    showNotice('バックアップから戻しました');
});

// ===== リストの共有（A-2） =====
// リストを URL の #share= に詰める（名前・出やすさ・色・当たり）。データはリンクの中だけにあり、どこにも送らない
function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function shareUrlFor(list) {
    const data = { v: 1, n: list.name, i: list.items.filter(i => i.name.trim()).map(i => [i.name, i.weight, i.color || 0, i.win ? 1 : 0]) };
    return location.origin + location.pathname + '#share=' + b64urlEncode(JSON.stringify(data));
}
function parseShared(text) {
    const m = String(text).match(/#share=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
        const d = JSON.parse(b64urlDecode(m[1]));
        if (!d || d.v !== 1 || !Array.isArray(d.i)) return null;
        const items = d.i.filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[0].trim()).slice(0, MAX_ITEMS)
            .map(x => makeItem(x[0].slice(0, 40), { weight: clampWeight(x[1]), color: /^#[0-9a-f]{6}$/i.test(x[2]) ? x[2].toLowerCase() : null, win: !!x[3] }));
        if (!items.length) return null;
        return { name: (typeof d.n === 'string' && d.n.trim() ? d.n.trim() : '共有されたリスト').slice(0, 30), items };
    } catch (e) { return null; }
}
async function importShared(shared) {
    const ok = await ask(`共有されたリスト「${shared.name}」（${shared.items.length} 項目）を追加しますか？\n${shared.items.slice(0, 8).map(i => i.name).join('、')}${shared.items.length > 8 ? ' …' : ''}`, { okLabel: '追加' });
    if (!ok || isSpinning()) return;
    const l = makeList(state.lists.some(x => x.name === shared.name) ? (shared.name + '（共有）').slice(0, 30) : shared.name);
    l.items = shared.items;
    state.lists.push(l);
    state.currentListId = l.id;
    saveState(); showLastOf(l); renderAll();
    selectTab('items');
    showNotice(`「${l.name}」を追加しました`);
}
function checkSharedHash() {
    if (!location.hash.startsWith('#share=')) return;
    const shared = parseShared(location.hash);
    history.replaceState(null, '', location.pathname + location.search);   // 再読み込みでまた聞かれないように消す
    if (shared) importShared(shared);
    else showNotice('共有リンクを読み込めませんでした');
}
window.addEventListener('hashchange', checkSharedHash);
$('shareList').addEventListener('click', async () => {
    const list = curList();
    if (!list.items.some(i => i.name.trim())) { showNotice('項目を追加してから共有してください'); return; }
    const url = shareUrlFor(list);
    if (navigator.share) {
        try { await navigator.share({ title: `LuckyRoulette「${list.name}」`, url }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const ok = await copyText(url);
    showNotice(ok ? '共有用のリンクをコピーしました' : 'リンクをコピーできませんでした');
});
$('importShared').addEventListener('click', async () => {
    const text = await ask('共有されたリンクを貼り付けてください', { input: '', okLabel: '読み込む', maxLength: 20000 });
    if (!text) return;
    const shared = parseShared(text);
    if (!shared) { await ask('リンクを読み込めませんでした。共有されたリンクをそのまま貼り付けてください。'); return; }
    importShared(shared);
});

// ===== まとめて抽選（B-3） =====
// シード値から、重複なしで n 個選ぶ（出やすさに合わせる）か、n チームに分ける（出やすさは使わない）
function drawMulti(seed, cands, mode, n) {
    const rng = mulberry32(hashStr(seed + '|' + mode + '|' + n));
    if (mode === 'team') {
        const arr = cands.slice();
        for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
        const teams = Array.from({ length: n }, () => []);
        arr.forEach((c, i) => teams[i % n].push(c));
        return teams;
    }
    const pool = cands.slice(), out = [];
    for (let k = 0; k < Math.min(n, cands.length); k++) {
        const total = pool.reduce((a, c) => a + c.weight, 0);
        let r = rng() * total, idx = pool.length - 1;
        for (let i = 0; i < pool.length; i++) { r -= pool[i].weight; if (r < 0) { idx = i; break; } }
        out.push(pool.splice(idx, 1)[0]);
    }
    return out;
}
function summarizeMulti(mode, res) {
    return mode === 'team'
        ? res.map((t, i) => `チーム${i + 1}: ${t.map(c => c.name).join('、')}`).join(' / ')
        : res.map(c => c.name).join('、');
}
let bdMode = 'pick';
function bdLimits() {
    const n = candidates(curList()).length;
    return bdMode === 'team' ? [2, Math.max(2, n)] : [1, Math.max(1, n)];
}
function renderBatchDialog() {
    const n = candidates(curList()).length;
    const [lo, hi] = bdLimits();
    const inp = $('bdCount');
    inp.min = lo; inp.max = hi;
    inp.value = Math.min(hi, Math.max(lo, Math.round(Number(inp.value)) || lo));
    $('bdCountLabel').textContent = bdMode === 'team' ? 'チームの数' : '選ぶ数';
    $('bdNote').textContent = bdMode === 'team'
        ? `候補 ${n} 個を、ランダムに ${inp.value} チームに振り分けます（出やすさは使いません）。`
        : `候補 ${n} 個から、出やすさに合わせて重複なしで ${inp.value} 個選びます。`;
    $('bdMinus').disabled = Number(inp.value) <= lo;
    $('bdPlus').disabled = Number(inp.value) >= hi;
    $('bdRun').disabled = (bdMode === 'team' && n < 2) || n < 1;
    $('bdModes').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === bdMode ? 'true' : 'false'));
}
$('batchBtn').addEventListener('click', () => {
    if (isSpinning() || !candidates(curList()).length) return;
    $('bdResult').hidden = true;
    renderBatchDialog();
    $('batchDialog').showModal();
});
$('bdModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    bdMode = b.dataset.mode;
    $('bdCount').value = bdMode === 'team' ? 2 : $('bdCount').value;
    $('bdResult').hidden = true;
    renderBatchDialog();
});
$('bdMinus').addEventListener('click', () => { $('bdCount').value = Number($('bdCount').value) - 1; renderBatchDialog(); });
$('bdPlus').addEventListener('click', () => { $('bdCount').value = Number($('bdCount').value) + 1; renderBatchDialog(); });
$('bdCount').addEventListener('change', renderBatchDialog);
$('bdRun').addEventListener('click', () => {
    if (isSpinning()) return;
    if (syncFromStorage()) { pendingSync = false; }
    const list = curList();
    const cands = candidates(list);
    renderBatchDialog();
    const n = Number($('bdCount').value);
    if (!cands.length || (bdMode === 'team' && cands.length < 2)) return;
    const seed = makeSeed();
    const res = drawMulti(seed, cands, bdMode, n);
    list.spinCount += 1;
    state.totalSpins += 1;
    const snap = cands.map(i => [i.name, i.weight]);
    const snapKey = hashStr(JSON.stringify(snap)).toString(36) + '-' + snap.length;
    state.snapshots[snapKey] = snap;
    const entry = {
        n: list.spinCount, g: state.totalSpins, time: Date.now(), seed, itemId: '', name: summarizeMulti(bdMode, res),
        win: bdMode === 'pick' && res.some(c => c.win), snap: snapKey, kind: bdMode,
        ...(bdMode === 'team' ? { teams: res.map(t => t.map(c => c.name)) } : { picks: res.map(c => c.name) }),
    };
    list.history.unshift(entry);
    if (list.history.length > MAX_HISTORY) list.history.length = MAX_HISTORY;
    if (bdMode === 'pick' && list.excludeMode) res.forEach(c => { if (!list.excluded.includes(c.id)) list.excluded.push(c.id); });
    saveState();
    // 結果の表示
    $('bdSeed').textContent = seedLine(entry);
    const box = $('bdList'); box.textContent = '';
    const dot = (c) => { const i = document.createElement('i'); i.style.background = itemColor(list, c); return i; };
    if (bdMode === 'team') {
        const wrap = document.createElement('div'); wrap.className = 'bd-teams';
        res.forEach((t, k) => {
            const d = document.createElement('div'); d.className = 'bd-team'; d.style.animationDelay = (k * 60) + 'ms';
            const h = document.createElement('b'); h.textContent = `チーム${k + 1}（${t.length}）`;
            d.append(h);
            t.forEach(c => { const sp = document.createElement('span'); sp.append(dot(c), c.name); d.append(sp); });
            wrap.append(d);
        });
        box.append(wrap);
    } else {
        const ol = document.createElement('ol'); ol.className = 'bd-picks';
        res.forEach((c, k) => {
            const li = document.createElement('li'); li.style.animationDelay = (k * 60) + 'ms';
            const rk = document.createElement('span'); rk.className = 'rank'; rk.textContent = k + 1;
            li.append(rk, dot(c), c.name + (c.win ? ' ★' : ''));
            ol.append(li);
        });
        box.append(ol);
    }
    $('bdResult').hidden = false;
    $('bdRun').textContent = 'もう一度抽選する';
    showResult(entry, false);
    $('seedLine').textContent = seedLine(entry);
    renderAll();
});
$('bdCopy').addEventListener('click', async () => {
    const list = curList();
    const h = list.history[0];
    if (!h || !h.kind) return;
    const ok = await copyText(resultText(list, h));
    $('bdCopy').textContent = ok ? 'コピーしました' : 'コピーできませんでした';
    setTimeout(() => { $('bdCopy').textContent = '結果をコピー'; }, 1500);
});
$('batchDialog').addEventListener('close', () => { $('bdRun').textContent = '抽選する'; });

// ===== 全画面モード（B-4） =====
function setFocus(on) {
    document.body.classList.toggle('focus', on);
    $('focusBtn').title = on ? '全画面を終了' : '全画面で表示';
    $('focusBtn').setAttribute('aria-label', $('focusBtn').title);
    $('focusBtn').innerHTML = on ? svgIcon('shrink') : svgIcon('expand');
    const el = document.documentElement;
    try {
        if (on && el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => { });
        if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => { });
    } catch (e) { }
    resizeCanvas();
}
$('focusBtn').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) setFocus(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('focus') && !anyDialogOpen()) setFocus(false); });

// ===== 起動 =====
$('appVersion').textContent = 'v' + APP_VERSION;
buildSettings();
buildTemplates();
loadState();
showLastOf(curList());
renderAll();
new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();
saveState();
checkSharedHash();

// ===== ホーム画面に追加（PWA） =====
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
    // ホーム画面に追加したアプリとして開いているときだけ、フォントを全部保存しておく（オフラインでも丸ゴシックで出すため）。
    // ブラウザで見ているだけの人には、使う文字の分しか読み込ませない
    const cacheFonts = () => navigator.serviceWorker.ready.then(reg => { if (reg.active) reg.active.postMessage('cacheAllFonts'); }).catch(() => {});
    const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    if (installed) cacheFonts();
    window.addEventListener('appinstalled', cacheFonts);   // Android でこの画面からインストールしたとき
    // 前の版からの更新直後は、まだ古いサービスワーカーが動いていて依頼を無視するので、新しいものに切り替わったらもう一度頼む
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (installed) cacheFonts(); });
}
