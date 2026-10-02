// Weather dashboard: loads the last ~3 months from the Google Sheet and draws them with uPlot.
//
// Speed: the Google query endpoint filters rows server-side, so only the needed period is
// downloaded. The result is cached in localStorage; later visits show the cache instantly and
// only fetch rows newer than the cached ones.

const SHEET_ID = '17ZaP_LAmInf3U9zOsFkX-KpC1ypWF3ZrvFiRI71pUiY';
const KEEP_DAYS = 92;
const CACHE_KEY = 'weather-cache-v1';
const RANGE_KEY = 'weather-range';
const STALE_HOURS = 2;
const MISSING = -999;

// Sheet header -> field name
const COLUMNS = {
    'Date': 't',
    'Temperature (degC)': 'temp',
    'Relative Humidity (%)': 'rh',
    'Wind speed (m/s)': 'ws',
    'Wind Direction (deg)': 'wd',
    'Wind Gust (m/s)': 'gust',
    'Rain': 'rain',
    'CO2': 'co2',
    'Diffuse radiation (PAR)': 'dif',
    'Global radiation (PAR)': 'glob',
};
const FIELDS = Object.values(COLUMNS);

// Plausible ranges; anything outside is treated as a sensor error
const VALID = {
    temp: [-50, 60], rh: [0, 100], ws: [0, 75], wd: [0, 360], gust: [0, 90],
    rain: [0, 200], co2: [250, 5000], dif: [-50, 3500], glob: [-50, 3500],
};

const CHARTS = [
    { id: 'temp', title: 'Temperature', unit: '°C', series: [{ key: 'temp', label: 'Temperature' }] },
    { id: 'rh', title: 'Relative humidity', unit: '%', range: [0, 100], series: [{ key: 'rh', label: 'Humidity' }] },
    { id: 'rain', title: 'Rain', unit: 'mm', bars: true, series: [{ key: 'rain', label: 'Rain' }] },
    { id: 'wind', title: 'Wind speed', unit: 'm/s', min0: true,
      series: [{ key: 'ws', label: 'Mean' }, { key: 'gust', label: 'Gust' }] },
    { id: 'wd', title: 'Wind direction', unit: '', points: true, range: [0, 360],
      series: [{ key: 'wd', label: 'From', fmt: v => `${compass(v)} ${Math.round(v)}°` }] },
    { id: 'rad', title: 'Solar radiation', unit: 'PAR, µmol/m²/s', min0: true,
      series: [{ key: 'glob', label: 'Global', fmt: v => Math.round(v) }, { key: 'dif', label: 'Diffuse', fmt: v => Math.round(v) }] },
    { id: 'co2', title: 'CO₂', unit: 'ppm', series: [{ key: 'co2', label: 'CO₂', fmt: v => Math.round(v) }] },
];

const $ = sel => document.querySelector(sel);
let data = null;            // { t: [...], temp: [...], ... } with t in seconds (logger wall-clock as UTC)
let rangeDays = readRange();
let plots = [];

// ---------- Time helpers ----------
// Timestamps are the logger's wall-clock time. They are kept as UTC so they display exactly as logged.
function parseTs(s) {
    const [d, tm = '00:00:00'] = s.split(' ');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi, se] = tm.split(':').map(Number);
    return Date.UTC(y, mo - 1, da, h, mi, se || 0) / 1000;
}

function fmtTs(sec) {
    return new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function nowWallClock() {
    const d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) / 1000;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const tickTime = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const tickDay = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short' });
function timeTicks(u, splits) {
    const span = u.scales.x.max - u.scales.x.min;
    return splits.map(s => {
        const d = new Date(s * 1000);
        const midnight = s % 86400 === 0;
        return span > 2.5 * 86400 || midnight ? tickDay.format(d) : tickTime.format(d);
    });
}
const fmtWhen = (sec, daily) => (daily ? dayFmt : dateFmt).format(new Date(sec * 1000));

function ago(sec) {
    const m = Math.round((nowWallClock() - sec) / 60);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
}

function compass(deg) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// ---------- Loading ----------
function queryUrl(sinceTs) {
    const tq = `select * where A > '${sinceTs}' order by A`;
    return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&tq=${encodeURIComponent(tq)}`;
}

function parseCsv(text) {
    const lines = text.trim().split('\n');
    const strip = s => s.replace(/^"|"$/g, '');
    const header = lines[0].split('","').map(s => strip(s.trim()));
    const idx = {};
    header.forEach((h, i) => { if (COLUMNS[h]) idx[COLUMNS[h]] = i; });
    if (idx.t === undefined) throw new Error('Unexpected sheet format');

    const out = Object.fromEntries(FIELDS.map(f => [f, []]));
    for (let r = 1; r < lines.length; r++) {
        const cells = lines[r].trim().split('","').map(strip);
        if (!cells[idx.t]) continue;
        out.t.push(parseTs(cells[idx.t]));
        for (const f of FIELDS) {
            if (f === 't') continue;
            const raw = idx[f] === undefined ? '' : cells[idx[f]];
            let v = raw === '' ? null : Number(raw);
            if (v === MISSING || !Number.isFinite(v) || v < VALID[f][0] || v > VALID[f][1]) v = null;
            out[f].push(v);
        }
    }
    return out;
}

function mergeAndTrim(old, fresh) {
    const merged = Object.fromEntries(FIELDS.map(f => [f, []]));
    const lastOld = old && old.t.length ? old.t[old.t.length - 1] : -Infinity;
    if (old) FIELDS.forEach(f => merged[f].push(...old[f]));
    fresh.t.forEach((t, i) => {
        if (t <= lastOld) return;
        FIELDS.forEach(f => merged[f].push(fresh[f][i]));
    });
    const cutoff = (merged.t.length ? merged.t[merged.t.length - 1] : 0) - KEEP_DAYS * 86400;
    const start = merged.t.findIndex(t => t >= cutoff);
    if (start > 0) FIELDS.forEach(f => merged[f].splice(0, start));
    return merged;
}

function readCache() {
    try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY));
        return c && Array.isArray(c.t) && c.t.length ? c : null;
    } catch { return null; }
}

function writeCache(d) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch { /* storage full or blocked */ }
}

async function load() {
    const cached = readCache();
    if (cached) {
        data = cached;
        render();
    }
    const since = cached
        ? fmtTs(cached.t[cached.t.length - 1])
        : fmtTs(nowWallClock() - KEEP_DAYS * 86400).slice(0, 10) + ' 00:00:00';
    try {
        const res = await fetch(queryUrl(since));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fresh = parseCsv(await res.text());
        data = mergeAndTrim(cached, fresh);
        writeCache(data);
        render();
    } catch (err) {
        console.error('Could not load data:', err);
        if (!data) {
            $('#status').textContent = 'Could not load data. Check your connection and reload the page.';
            $('#charts').innerHTML = '<p class="empty">No data available.</p>';
        } else {
            $('#status').textContent += ' · offline, showing saved data';
        }
    }
}

// ---------- Range ----------
// A link like .../#30d opens that range; otherwise the last choice on this device is used
function readRange() {
    const m = location.hash.match(/^#(1|7|30|90)d$/);
    if (m) return Number(m[1]);
    try { return Number(localStorage.getItem(RANGE_KEY)) || 30; } catch { return 30; }
}

function setupRanges() {
    const buttons = document.querySelectorAll('#ranges button');
    const sync = () => buttons.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === rangeDays)));
    buttons.forEach(b => b.addEventListener('click', () => {
        rangeDays = Number(b.dataset.days);
        try { localStorage.setItem(RANGE_KEY, rangeDays); } catch { /* ignore */ }
        history.replaceState(null, '', `#${rangeDays}d`);
        sync();
        if (data) renderCharts();
    }));
    sync();
}

function sliceRange(d, days) {
    const end = d.t[d.t.length - 1];
    let i = d.t.findIndex(t => t > end - days * 86400);
    if (i < 0) i = 0;
    return Object.fromEntries(FIELDS.map(f => [f, d[f].slice(i)]));
}

// Rain is a total per 15 min; sum into hourly (short ranges) or daily (long ranges) bars
function binRain(d, days) {
    const size = days <= 7 ? 3600 : 86400;
    const t = [], v = [];
    for (let i = 0; i < d.t.length; i++) {
        // A 15-min value is stamped at the end of its period; shift back so it lands in the right bin
        const bin = Math.floor((d.t[i] - 1) / size) * size;
        if (t[t.length - 1] !== bin) { t.push(bin); v.push(null); }
        if (d.rain[i] !== null) v[v.length - 1] = (v[v.length - 1] || 0) + d.rain[i];
    }
    return { t: t.map(x => x + size / 2), v: v.map(x => (x === null ? null : Math.round(x * 10) / 10)), size };
}

// ---------- Tiles ----------
// Tiles summarise the 24 hours up to the latest reading
function stats24(key) {
    const end = data.t[data.t.length - 1];
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = data.t.length - 1; i >= 0 && data.t[i] > end - 86400; i--) {
        const v = data[key][i];
        if (v === null) continue;
        min = Math.min(min, v); max = Math.max(max, v); sum += v; n++;
    }
    return n ? { min, max, sum, mean: sum / n } : null;
}

function renderTiles() {
    const f1 = v => (v === null || v === undefined ? '–' : v.toFixed(1));
    const f0 = v => (v === null || v === undefined ? '–' : Math.round(v));
    const t = stats24('temp'), rh = stats24('rh'), ws = stats24('ws'), g = stats24('gust');
    const r = stats24('rain'), glob = stats24('glob'), co2 = stats24('co2');

    const tiles = [
        { label: 'Temperature', kind: 'avg', value: f1(t?.mean), unit: '°C',
          sub: t ? `${f1(t.min)} – ${f1(t.max)} °C` : '' },
        { label: 'Humidity', kind: 'avg', value: f0(rh?.mean), unit: '%',
          sub: rh ? `${f0(rh.min)} – ${f0(rh.max)} %` : '' },
        { label: 'Wind', kind: 'avg', value: f1(ws?.mean), unit: 'm/s',
          sub: g ? `Max gust ${f1(g.max)} m/s` : '' },
        { label: 'Rain', kind: 'total', value: f1(r?.sum), unit: 'mm', sub: '' },
        { label: 'Solar radiation', kind: 'avg', value: f0(glob?.mean), unit: 'PAR',
          sub: glob ? `Peak ${f0(glob.max)}` : '' },
        { label: 'CO₂', kind: 'avg', value: f0(co2?.mean), unit: 'ppm',
          sub: co2 ? `${f0(co2.min)} – ${f0(co2.max)} ppm` : '' },
    ];

    const end = data.t[data.t.length - 1];
    $('#tiles-window').textContent = `${fmtWhen(end - 86400)} – ${fmtWhen(end)}`;
    $('#tiles').innerHTML = tiles.map(t => `
        <div class="tile">
            <div class="label">${t.label}<span class="kind">${t.kind}</span></div>
            <div class="value">${t.value}<span class="unit">${t.unit}</span></div>
            <div class="sub">${t.sub || '&nbsp;'}</div>
        </div>`).join('');
}

function renderStatus() {
    const last = data.t[data.t.length - 1];
    const stale = nowWallClock() - last > STALE_HOURS * 3600;
    const el = $('#status');
    el.classList.toggle('stale', stale);
    el.textContent = `Latest reading ${fmtWhen(last)} (${ago(last)})`;
}

// ---------- Charts ----------
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartHeight() {
    return window.innerWidth < 520 ? 160 : 200;
}

function buildChart(def, d, container, colors) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
        <div class="card-head">
            <h2>${def.title}${def.unit ? `<small>${def.unit}</small>` : ''}</h2>
            <div class="readout"></div>
        </div>
        <div class="plot"></div>`;
    container.appendChild(card);
    const readout = card.querySelector('.readout');
    const plotEl = card.querySelector('.plot');

    let x, ys, daily = false;
    if (def.bars) {
        const b = binRain(d, rangeDays);
        x = b.t; ys = [b.v]; daily = b.size === 86400;
    } else {
        x = d.t; ys = def.series.map(s => d[s.key]);
    }

    const seriesColor = i => (i === 0 ? colors.s1 : colors.s2);
    const fmt = (s, v) => (v === null || v === undefined ? '–' : s.fmt ? s.fmt(v) : v.toFixed(1));

    const updateReadout = idx => {
        const i = idx ?? (x.length - 1);
        const when = x.length ? fmtWhen(def.bars ? x[i] - (daily ? 43200 : 1800) : x[i], daily) : '';
        const vals = def.series.map((s, k) => {
            const swatch = def.series.length > 1 ? `<span class="swatch" style="background:${seriesColor(k)}"></span>` : '';
            const label = def.series.length > 1 ? `${s.label} ` : '';
            return `<span>${swatch}${label}<span class="val">${fmt(s, ys[k][i])}</span></span>`;
        }).join('');
        const period = def.bars ? (daily ? ' (day)' : ' (hour)') : '';
        readout.innerHTML = `<span class="when">${idx == null ? 'Latest' : when}${idx == null ? '' : period}</span>${vals}`;
    };

    const axis = {
        stroke: colors.muted,
        grid: { stroke: colors.grid, width: 1 },
        ticks: { stroke: colors.axis, width: 1, size: 4 },
        font: '11px system-ui, -apple-system, "Segoe UI", sans-serif',
    };

    const yAxis = { ...axis, size: 44 };
    if (def.id === 'wd') {
        yAxis.splits = () => [0, 90, 180, 270, 360];
        yAxis.values = (u, vals) => vals.map(v => ['N', 'E', 'S', 'W', 'N'][v / 90]);
    }

    const series = [{}].concat(def.series.map((s, k) => {
        const base = { label: s.label, stroke: seriesColor(k), width: 1.5, spanGaps: false, points: { show: false } };
        if (def.bars) {
            return { ...base, fill: colors.s1, width: 0, paths: uPlot.paths.bars({ size: [0.8, 24], align: 0 }) };
        }
        if (def.points) {
            return { ...base, width: 0, paths: () => null, points: { show: true, size: 3, width: 0, fill: colors.s1, stroke: colors.s1 } };
        }
        return base;
    }));

    const opts = {
        width: 300,
        height: chartHeight(),
        padding: [8, 8, 0, 0],
        legend: { show: false },
        cursor: {
            sync: { key: 'weather' },
            drag: { x: false, y: false },
            points: { size: 7, width: 2, stroke: colors.card },
        },
        scales: {
            x: { time: true },
            y: {
                range: (u, min, max) => {
                    if (def.range) return def.range;
                    if (min === null) return [0, 1];
                    if (def.bars) return [0, Math.max(1, max * 1.1)];
                    const pad = Math.max((max - min) * 0.08, 0.5);
                    return [def.min0 ? 0 : min - pad, max + pad];
                },
            },
        },
        tzDate: ts => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
        axes: [{ ...axis, space: 64, values: timeTicks }, yAxis],
        series,
        hooks: { setCursor: [u => updateReadout(u.cursor.idx)] },
    };

    const plot = new uPlot(opts, [x, ...ys], plotEl);
    updateReadout(null);
    enableTouch(plot);
    plot.observer = new ResizeObserver(() => {
        const w = plotEl.clientWidth;
        if (w && (w !== plot.width || chartHeight() !== plot.height)) plot.setSize({ width: w, height: chartHeight() });
    });
    plot.observer.observe(plotEl);
    return plot;
}

// uPlot reacts to mouse events; forward touch drags so phones can scrub through values
function enableTouch(u) {
    const over = u.over;
    const send = (type, touch) => over.dispatchEvent(new MouseEvent(type, { clientX: touch.clientX, clientY: touch.clientY, bubbles: true }));
    let startX = 0, startY = 0, scrubbing = false;
    over.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; scrubbing = false;
        send('mouseenter', e.touches[0]);
        send('mousemove', e.touches[0]);
    }, { passive: true });
    over.addEventListener('touchmove', e => {
        const t = e.touches[0];
        if (!scrubbing && Math.abs(t.clientX - startX) > Math.abs(t.clientY - startY)) scrubbing = true;
        if (scrubbing) send('mousemove', t);
    }, { passive: true });
}

function renderCharts() {
    plots.forEach(p => { p.observer.disconnect(); p.destroy(); });
    plots = [];
    const container = $('#charts');
    container.innerHTML = '';
    const d = sliceRange(data, rangeDays);
    const colors = {
        s1: cssVar('--series-1'), s2: cssVar('--series-2'), muted: cssVar('--ink-muted'),
        grid: cssVar('--grid'), axis: cssVar('--axis'), card: cssVar('--card'),
    };
    plots = CHARTS.map(def => buildChart(def, d, container, colors));
}

function render() {
    if (!data || !data.t.length) return;
    renderStatus();
    renderTiles();
    renderCharts();
}

// Redraw with the right colors when the system switches between light and dark
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (data) renderCharts(); });

// Refresh when the tab comes back into view (the logger uploads every 15 min)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && data && nowWallClock() - data.t[data.t.length - 1] > 20 * 60) load();
});

setupRanges();
load();
