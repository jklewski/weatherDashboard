// Weather dashboard: loads the last ~3 months from the Google Sheet and draws them with uPlot.
//
// Speed: the Google query endpoint filters rows server-side, so only the needed period is
// downloaded. The result is cached in localStorage; later visits show the cache instantly and
// only fetch rows newer than the cached ones.

const SHEET_ID = '17ZaP_LAmInf3U9zOsFkX-KpC1ypWF3ZrvFiRI71pUiY';
const KEEP_DAYS = 92;
const CACHE_KEY = 'weather-cache-v1';
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
    // fill: shade the lower series down to zero and the band between it and the upper series
    // (remove for plain lines). The upper value always includes the lower one, so they are not stacked.
    // dirKey: draw a strip of wind-direction arrows above the chart and show the direction on hover
    { id: 'wind', title: 'Wind speed', unit: 'm/s', min0: true, fill: { upper: 'gust', lower: 'ws' }, dirKey: 'wd',
      series: [{ key: 'ws', label: 'Mean' }, { key: 'gust', label: 'Gust' }] },
    // hidden: kept for later; the wind speed chart shows direction as arrows instead
    { id: 'wd', title: 'Wind direction', unit: '', points: true, hidden: true, range: [0, 360],
      series: [{ key: 'wd', label: 'From', fmt: v => `${compass(v)} ${Math.round(v)}°` }] },
    // The band between global and diffuse is direct sunlight
    { id: 'rad', title: 'Solar radiation', unit: 'PAR, µmol/m²/s', min0: true, fill: { upper: 'glob', lower: 'dif' },
      series: [{ key: 'glob', label: 'Global', fmt: v => Math.round(v) }, { key: 'dif', label: 'Diffuse', fmt: v => Math.round(v) }] },
    { id: 'co2', title: 'CO₂', unit: 'ppm', series: [{ key: 'co2', label: 'CO₂', fmt: v => Math.round(v) }] },
];

const $ = sel => document.querySelector(sel);
let data = null;            // { t: [...], temp: [...], ... } with t in seconds (logger wall-clock as UTC)
let rangeDays = readRange();
let plots = [];

// ---------- Time helpers ----------
// Timestamps are the logger's wall-clock time (Swedish time). They are kept as UTC so they display
// exactly as logged, and "now" is converted to Swedish wall-clock time so comparisons work in any time zone.
const STATION_TZ = 'Europe/Stockholm';
function parseTs(s) {
    const [d, tm = '00:00:00'] = s.split(' ');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi, se] = tm.split(':').map(Number);
    return Date.UTC(y, mo - 1, da, h, mi, se || 0) / 1000;
}

function fmtTs(sec) {
    return new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const stationClock = new Intl.DateTimeFormat('en-US', {
    timeZone: STATION_TZ, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
function nowWallClock() {
    const p = Object.fromEntries(stationClock.formatToParts(new Date()).map(x => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
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
// Charts are hidden until a range is picked. A link like .../#30d opens with that range shown.
function readRange() {
    const m = location.hash.match(/^#(1|7|30|90)d$/);
    return m ? Number(m[1]) : null;
}

// Clicking a range shows the charts; clicking the selected range again hides them
function setupRanges() {
    const buttons = document.querySelectorAll('#ranges button');
    const sync = () => {
        buttons.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === rangeDays)));
        $('#charts-hint').hidden = rangeDays !== null;
    };
    buttons.forEach(b => b.addEventListener('click', () => {
        const days = Number(b.dataset.days);
        rangeDays = days === rangeDays ? null : days;
        history.replaceState(null, '', rangeDays ? `#${rangeDays}d` : location.pathname + location.search);
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
// Tiles show the latest reading; the small text below summarises the 24 hours up to it
function stats(key, seconds) {
    const end = data.t[data.t.length - 1];
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = data.t.length - 1; i >= 0 && data.t[i] > end - seconds; i--) {
        const v = data[key][i];
        if (v === null) continue;
        min = Math.min(min, v); max = Math.max(max, v); sum += v; n++;
    }
    return n ? { min, max, sum, mean: sum / n } : null;
}
const stats24 = key => stats(key, 86400);

// Latest valid value; looks back up to an hour so a single bad reading doesn't blank the tile
function latest(key) {
    const end = data.t[data.t.length - 1];
    for (let i = data.t.length - 1; i >= 0 && data.t[i] > end - 3600; i--) {
        if (data[key][i] !== null) return data[key][i];
    }
    return null;
}

// Rain over the last 30 min, described by intensity (thresholds as mm/h: 2.5 and 7.6)
function rainText(mm) {
    if (mm === null) return '–';
    if (mm === 0) return 'None';
    if (mm < 1.25) return 'Light';
    if (mm < 3.8) return 'Moderate';
    return 'Heavy';
}

// Small arrow pointing where the wind blows to (the logger gives the direction it comes from)
function windArrow(deg) {
    if (deg === null) return ' ';
    const from = `From ${compass(deg)} (${Math.round(deg)}°)`;
    return `<svg class="wind-arrow" viewBox="0 0 24 24" style="transform: rotate(${deg + 180}deg)" role="img" aria-label="${from}">`
        + `<title>${from}</title><path fill="currentColor" d="M12 2 19 20 12 16 5 20z"/></svg>`;
}

function renderTiles() {
    const f1 = v => (v === null || v === undefined ? '–' : v.toFixed(1));
    const f0 = v => (v === null || v === undefined ? '–' : Math.round(v));
    const t = stats24('temp'), rh = stats24('rh'), ws = stats24('ws'), g = stats24('gust');
    const r = stats24('rain'), glob = stats24('glob'), co2 = stats24('co2');
    const r30 = stats('rain', 1800);

    const tiles = [
        { label: 'Temperature', value: f1(latest('temp')), unit: '°C',
          sub: t ? `${f1(t.min)} – ${f1(t.max)} °C` : '' },
        { label: 'Humidity', value: f0(latest('rh')), unit: '%',
          sub: rh ? `${f0(rh.min)} – ${f0(rh.max)} %` : '' },
        { label: 'Wind', value: `${f1(latest('ws'))}<span class="paren"> (${f1(latest('gust'))})</span>`, unit: 'm/s', after: windArrow(latest('wd')),
          sub: ws || g ? `Max ${f1(ws?.max)} (${f1(g?.max)}) m/s` : '' },
        { label: 'Rain', value: rainText(r30 ? r30.sum : null), unit: '',
          sub: r ? `Total ${f1(r.sum)} mm` : '' },
        { label: 'Solar radiation', value: f0(latest('glob')), unit: 'PAR',
          sub: glob ? `Peak ${f0(glob.max)} PAR` : '' },
        { label: 'CO₂', value: f0(latest('co2')), unit: 'ppm',
          sub: co2 ? `${f0(co2.min)} – ${f0(co2.max)} ppm` : '' },
    ];

    $('#tiles').innerHTML = tiles.map(t => `
        <div class="tile">
            <div class="label">${t.label}</div>
            <div class="value">${t.value}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}${t.after || ''}</div>
            <div class="sub">${t.sub || '&nbsp;'}</div>
        </div>`).join('');
}

function renderStatus() {
    const last = data.t[data.t.length - 1];
    const stale = nowWallClock() - last > STALE_HOURS * 3600;
    const el = $('#status');
    el.classList.toggle('stale', stale);
    el.textContent = `Last reading ${ago(last)}`;
}

// ---------- Charts ----------
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Row of arrows above the wind chart, one per block of time. The block length grows with the
// range so arrows stay at least ~20 px apart. Each arrow is the speed-weighted mean direction
// of its block and points where the wind blows to; calm blocks get no arrow, light wind is faint.
const DIR_BLOCKS = [1, 2, 3, 6, 12, 24, 48, 72, 168].map(h => h * 3600);
function drawDirectionStrip(u, d, dirKey, color) {
    const t = u.data[0];
    if (t.length < 2) return;
    const span = u.scales.x.max - u.scales.x.min;
    const plotW = u.bbox.width / uPlot.pxRatio;
    const size = DIR_BLOCKS.find(s => plotW / (span / s) >= 20) || DIR_BLOCKS[DIR_BLOCKS.length - 1];

    // Sum the wind vectors per block (direction "from", weighted by speed)
    const blocks = new Map();
    for (let i = 0; i < t.length; i++) {
        const ws = d.ws[i], wd = d[dirKey][i];
        if (ws === null || wd === null) continue;
        const key = Math.floor((t[i] - 1) / size) * size;
        const b = blocks.get(key) || { x: 0, y: 0, sum: 0, n: 0 };
        const rad = wd * Math.PI / 180;
        b.x += ws * Math.sin(rad); b.y += ws * Math.cos(rad); b.sum += ws; b.n++;
        blocks.set(key, b);
    }
    const maxMean = Math.max(...[...blocks.values()].map(b => b.sum / b.n), 1);

    const ctx = u.ctx, r = uPlot.pxRatio;
    const cy = u.bbox.top - 12 * r;
    ctx.save();
    ctx.fillStyle = color;
    for (const [start, b] of blocks) {
        const mean = b.sum / b.n;
        if (mean < 0.3) continue;
        const cx = u.valToPos(start + size / 2, 'x', true);
        if (cx < u.bbox.left || cx > u.bbox.left + u.bbox.width) continue;
        const from = Math.atan2(b.x, b.y);
        ctx.globalAlpha = 0.3 + 0.7 * Math.min(1, mean / maxMean);
        ctx.setTransform(r, 0, 0, r, 0, 0);
        ctx.translate(cx / r, cy / r);
        ctx.rotate(from + Math.PI);      // canvas y points down, so 0 rad = arrow pointing up (north)
        ctx.beginPath();
        ctx.moveTo(0, -6); ctx.lineTo(4.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-4.5, 6);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
}

// uPlot band between the upper and lower series (indices are +1: series 0 is the x axis)
function fillBand(def, seriesColor) {
    const up = def.series.findIndex(s => s.key === def.fill.upper);
    const lo = def.series.findIndex(s => s.key === def.fill.lower);
    return { series: [up + 1, lo + 1], fill: withAlpha(seriesColor(up), 0.3) };
}

// '#2a78d6' -> 'rgba(42, 120, 214, a)' for translucent fills on the canvas
function withAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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

    // Filled charts colour by role (upper blue, lower orange) so wind and radiation look alike
    const seriesColor = def.fill
        ? i => (def.series[i].key === def.fill.upper ? colors.s1 : colors.s2)
        : i => (i === 0 ? colors.s1 : colors.s2);
    const fmt = (s, v) => (v === null || v === undefined ? '–' : s.fmt ? s.fmt(v) : v.toFixed(1));

    // Not hovering: no values, just a colour key when the chart has two lines
    const legend = def.series.length > 1
        ? def.series.map((s, k) => `<span><span class="swatch" style="background:${seriesColor(k)}"></span>${s.label}</span>`).join('')
        : '';

    const updateReadout = idx => {
        if (idx == null) { readout.innerHTML = legend; return; }
        const i = idx;
        const when = x.length ? fmtWhen(def.bars ? x[i] - (daily ? 43200 : 1800) : x[i], daily) : '';
        const vals = def.series.map((s, k) => {
            const swatch = def.series.length > 1 ? `<span class="swatch" style="background:${seriesColor(k)}"></span>` : '';
            const label = def.series.length > 1 ? `${s.label} ` : '';
            return `<span>${swatch}${label}<span class="val">${fmt(s, ys[k][i])}</span></span>`;
        }).join('');
        const period = def.bars ? (daily ? ' (day)' : ' (hour)') : '';
        const dir = def.dirKey && d[def.dirKey][i] !== null ? `<span>${windArrow(d[def.dirKey][i])}${compass(d[def.dirKey][i])}</span>` : '';
        readout.innerHTML = `<span class="when">${when}${period}</span>${vals}${dir}`;
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
        if (def.fill) {
            // The lower series fills down to zero; the upper one is filled down to it via a band below
            return { ...base, width: 0.75, fill: s.key === def.fill.lower ? withAlpha(seriesColor(k), 0.35) : undefined };
        }
        return base;
    }));

    const opts = {
        width: 300,
        height: chartHeight(),
        padding: [def.dirKey ? 24 : 8, 8, 0, 0],
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
        // Multi-day ranges tick on whole days only, so wide charts don't repeat the same date
        axes: [{ ...axis, space: 64, size: 28, values: timeTicks,
                 incrs: rangeDays > 1 ? [1, 2, 7, 14, 30].map(n => n * 86400) : [1, 2, 3, 6, 12].map(n => n * 3600) }, yAxis],
        series,
        bands: def.fill ? [fillBand(def, seriesColor)] : [],
        hooks: {
            setCursor: [u => updateReadout(u.cursor.idx)],
            draw: def.dirKey ? [u => drawDirectionStrip(u, d, def.dirKey, colors.ink2)] : [],
        },
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
    if (rangeDays === null) return;
    const d = sliceRange(data, rangeDays);
    const colors = {
        s1: cssVar('--series-1'), s2: cssVar('--series-2'), muted: cssVar('--ink-muted'),
        grid: cssVar('--grid'), axis: cssVar('--axis'), card: cssVar('--card'), ink2: cssVar('--ink-2'),
    };
    plots = CHARTS.filter(def => !def.hidden).map(def => buildChart(def, d, container, colors));
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
