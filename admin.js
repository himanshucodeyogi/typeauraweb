/* Developed by Himanshu Kashyap
   TypeAura Admin Console.

   Two things shape almost every decision in this file:

   1. The admin API is rate limited per IP. Authenticated calls now get their own
      generous budget (see backend/lib/auth.js), but requests are still treated as
      a scarce resource: every GET goes through a TTL cache, sections load lazily
      on first visit, and nothing polls in the background. Refresh is always an
      explicit act by the operator, and the topbar shows how stale the data is.

   2. Everything the server returns about a device is attacker-influenced
      (device_name and friends come straight from the client), so every value
      interpolated into markup goes through esc(). */

(() => {
  'use strict';

  const API_BASE = 'https://typeaurabackend.vercel.app';

  /* Mirrors backend/lib/admin/set-config.js — the tool names it accepts. */
  const GATED_TOOLS = ['Live Translate', 'Text Tools', 'AI Chat', 'Smart Reply', 'Email Composer', 'Tone Changer'];

  /* Chart series. Fixed order, never cycled. Kept in sync with the --a-c*
     custom properties in admin.css, where the validation notes live. */
  const C1 = '#7C6CF8', C2 = '#0891B2', C3 = '#EC4899', C4 = '#EA580C';
  const ORD = ['#4A4290', '#6459D4', '#8B7CFA'];

  const TOOLS = [
    { key: 'total_ai_uses',        label: 'Keyboard AI',    color: C1 },
    { key: 'total_voice_ai_uses',  label: 'Voice AI',       color: C2 },
    { key: 'total_lens_translate', label: 'Lens translate', color: C3 },
    { key: 'total_lens_reply',     label: 'Lens reply',     color: C4 },
  ];

  const SECTION_TITLES = {
    overview: 'Overview',
    devices:  'Devices',
    aitools:  'AI Tools',
    apikeys:  'API Keys',
    crashes:  'Crashes',
    referrals: 'Referrals',
    releases: 'Releases & Config',
  };

  /* ═══ State ══════════════════════════════════════════════════ */

  const MOCK = new URLSearchParams(location.search).get('mock') === '1';

  let token   = '';
  let section = 'overview';
  const loaded = new Set();            // sections that have fetched at least once

  const page = { dev: 1, ai: 1, crash: 1 };
  const timers = {};

  let stats  = null;
  let activeRange = 30;                // days shown in the daily-active chart
  let config = { premium_enabled: false, byok_enabled: true, gif_enabled: true, gated_tools: [] };
  let keyHealth = [];                  // from check-keys
  let keyLimits = [];                  // from key-limits

  /* ═══ DOM helpers ════════════════════════════════════════════ */

  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const icon = (name, cls) => `<svg class="${cls || ''}"><use href="#i-${name}"/></svg>`;

  /* ═══ Formatting ═════════════════════════════════════════════ */

  function fmt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const v = Number(n);
    if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e4) return (v / 1e3).toFixed(0) + 'k';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  const fmtFull = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(+d) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(+d) ? '—' : d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(+d) ? '—' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  /* 'YYYY-MM-DD' → '19 Jul'. Parsed as UTC noon so the label can't slip a day
     on a browser west of the date line. */
  function fmtDayLabel(ymd) {
    const d = new Date(`${ymd}T12:00:00Z`);
    return Number.isNaN(+d) ? ymd : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  /* 'IN' → 'India', via the browser's own CLDR data — no country table to ship
     or maintain. Falls back to the raw code where Intl.DisplayNames is missing.

     Flag emoji were tried here and dropped: Windows ships no flag glyphs and
     renders the regional-indicator pair as plain letters, so every row read
     "IN IN". A name (or a code) alone is correct on every platform. */
  let regionNames = null;
  function regionName(code) {
    if (!code) return '—';
    try {
      if (!regionNames) regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
      return regionNames.of(String(code).toUpperCase()) || code;
    } catch { return code; }
  }

  /* ═══ Plan logic ═════════════════════════════════════════════
     A faithful port of effectiveTier() in backend/lib/tiers.js. The admin API
     never sends a computed tier, and the client-reported `plan_tier` alone is
     misleading (a paid user can park their plan as Free), so the console has to
     derive it the same way the server does. Keep the two in step. */

  const RANK = { free: 0, pro: 1, max: 2 };
  const TIER_LABEL = { free: 'Free', pro: 'Pro', max: 'Max' };

  const normTier = (t) => (t === 'premium' ? 'pro' : (typeof t === 'string' && RANK[t] != null ? t : null));

  function effectiveTier(d) {
    if (!d) return 'free';
    const adminTier = normTier(d.admin_plan_override);
    const adminPaid = adminTier === 'pro' || adminTier === 'max';
    const until     = d.premium_until ? new Date(d.premium_until) : null;
    const paidValid = !!(until && until > new Date());
    const paidTier  = paidValid ? (normTier(d.paid_tier) === 'max' ? 'max' : 'pro') : null;

    if (d.plan_tier === 'free' && !adminPaid) return 'free';
    if (adminTier === 'free' && !paidValid)   return 'free';

    const candidates = [];
    if (adminPaid) candidates.push(adminTier);
    if (paidTier)  candidates.push(paidTier);
    if (!candidates.length) return 'free';
    return candidates.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
  }

  const isPaidValid = (d) => !!(d && d.premium_until && new Date(d.premium_until) > new Date());

  function planBadge(d) {
    const tier  = effectiveTier(d);
    const legacyByok = d.plan_tier === 'byok' || d.plan_byok_active;

    let html = `<span class="a-plan a-plan-${tier}">${TIER_LABEL[tier]}</span>`;

    const flags = [];
    if (isPaidValid(d)) {
      const bought = TIER_LABEL[normTier(d.paid_tier) || 'pro'] || 'Pro';
      flags.push(`<span class="a-flag-paid" title="Active purchase: ${esc(bought)} until ${esc(fmtDate(d.premium_until))}">${icon('card')}</span>`);
    }
    if (d.admin_plan_override) {
      flags.push(`<span class="a-flag-override" title="Admin override: ${esc(d.admin_plan_override)}">${icon('shield')}</span>`);
    }
    if (legacyByok) flags.push(`<span class="a-plan a-plan-byok" title="Legacy BYOK key stored">BYOK</span>`);

    if (flags.length) html += `<span class="a-plan-flags">${flags.join('')}</span>`;
    return html;
  }

  /* ═══ Toasts ═════════════════════════════════════════════════ */

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `a-toast is-${kind}`;
    const ic = kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : 'activity';
    el.innerHTML = `${icon(ic)}<span>${esc(message)}</span>`;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, kind === 'bad' ? 6500 : 4000);
  }

  /* ═══ Confirm dialog ════════════════════════════════════════
     Replaces window.confirm(): the console already owns a modal layer, and a
     native dialog blocks the whole tab. */

  let dialogResolve = null;

  function confirmAsk(title, text, confirmLabel = 'Confirm', danger = false) {
    $('dialogTitle').textContent = title;
    $('dialogText').textContent  = text;
    const btn = $('dialogConfirm');
    btn.textContent = confirmLabel;
    btn.className = `a-btn ${danger ? 'a-btn-danger' : 'a-btn-primary'}`;
    $('dialog').classList.add('is-open');
    $('dialog').setAttribute('aria-hidden', 'false');
    btn.focus();
    return new Promise((resolve) => { dialogResolve = resolve; });
  }

  function closeDialog(result) {
    $('dialog').classList.remove('is-open');
    $('dialog').setAttribute('aria-hidden', 'true');
    if (dialogResolve) { dialogResolve(result); dialogResolve = null; }
  }

  /* ═══ API layer ══════════════════════════════════════════════ */

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  const cache = new Map();             // path → { at, data }
  const DEFAULT_TTL = 60_000;

  let mock = null;                     // populated only when ?mock=1

  async function request(path, { method = 'GET', body, ttl = DEFAULT_TTL, force = false } = {}) {
    const cacheable = method === 'GET' && ttl > 0;

    if (cacheable && !force) {
      const hit = cache.get(path);
      if (hit && Date.now() - hit.at < ttl) return hit.data;
    }

    let data;
    if (mock) {
      data = await mock.handle(path, method, body);
    } else {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 401) { onUnauthorized(); throw new ApiError('Session rejected — sign in again.', 401); }
      if (res.status === 429) {
        const wait = Number(res.headers.get('Retry-After')) || 0;
        setHealth('warn', 'Rate limited');
        throw new ApiError(wait ? `Rate limited. Try again in ${wait}s.` : 'Rate limited. Try again shortly.', 429);
      }

      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    }

    if (cacheable) cache.set(path, { at: Date.now(), data });
    if (!mock) setHealth('ok', 'Backend healthy');
    return data;
  }

  /* Any write invalidates the reads it could have changed. */
  function invalidate(prefix) {
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  }

  function setHealth(state, text) {
    const el = $('health');
    if (!el) return;
    el.dataset.state = state;
    $('healthText').textContent = text;
  }

  /* ═══ Charts ═════════════════════════════════════════════════
     Hand-rolled inline SVG — the site ships no charting library and a strict
     no-CDN page shouldn't start. Every chart draws into a fixed viewBox and
     scales to its container, so hover maps cleanly through percentages. */

  const VW = 640;                      // viewBox width for all full-size charts

  /* Round up to a readable axis top. The step list is deliberately fine-grained:
     a coarse [1,2,5,10] ladder rounds 285k up to 500k and throws away half the
     plot height. Every step is divisible by 2 so the mid gridline stays round. */
  function niceMax(v) {
    if (!v || v <= 0) return 1;
    const mag  = 10 ** Math.floor(Math.log10(v));
    const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => v <= s * mag) || 10;
    return step * mag;
  }

  function emptyChart(host, message) {
    host.innerHTML = `<div class="a-chart-empty">${esc(message)}</div>`;
  }

  /**
   * Line + area chart over a dated series.
   * @param {HTMLElement} host  a .a-chart-wrap
   * @param {Array<{date:string, value:number}>} data oldest → newest
   */
  function lineChart(host, data, opts = {}) {
    const { color = C1, compact = false, label = 'value' } = opts;
    if (!data || !data.length) {
      if (compact) { host.innerHTML = ''; return; }
      return emptyChart(host, 'No data for this period yet.');
    }

    const H    = compact ? 44 : 210;
    const padL = compact ? 2  : 44;
    const padR = compact ? 2  : 10;
    const padT = compact ? 8  : 14;
    const padB = compact ? 6  : 26;
    const plotW = VW - padL - padR;
    const plotH = H - padT - padB;

    const max = niceMax(Math.max(...data.map(d => d.value), 0));
    const x = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const y = (v) => padT + plotH - (v / max) * plotH;

    const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(data.length - 1).toFixed(1)} ${padT + plotH} L${x(0).toFixed(1)} ${padT + plotH} Z`;
    const gid  = `g${Math.random().toString(36).slice(2, 8)}`;

    let grid = '';
    let yAxis = '';
    if (!compact) {
      for (let t = 0; t <= 2; t++) {
        const v  = (max / 2) * t;
        const yy = y(v).toFixed(1);
        grid  += `<line class="a-grid-line" x1="${padL}" y1="${yy}" x2="${VW - padR}" y2="${yy}"/>`;
        yAxis += `<text class="a-axis-text" x="${padL - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(fmt(v))}</text>`;
      }
    }

    /* Three x labels only — first, middle, last. A label per day would collide
       long before 30 of them fit. */
    let xAxis = '';
    if (!compact) {
      [0, Math.floor((data.length - 1) / 2), data.length - 1].forEach((i, n) => {
        if (i < 0 || !data[i]) return;
        xAxis += `<text class="a-axis-text" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${n === 0 ? 'start' : n === 2 ? 'end' : 'middle'}">${esc(fmtDayLabel(data[i].date))}</text>`;
      });
    }

    /* The compact form is a sparkline inside a KPI tile: decoration that gives
       the headline number a shape. It carries no hover layer on purpose — the
       tile clips its own overflow, and the very same series is fully
       explorable, with crosshair and tooltip, in the panel below. */
    const interactive = !compact;

    host.innerHTML = `
      <svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="none" role="img"
           aria-label="${esc(label)} over the last ${data.length} days, from ${esc(fmtDayLabel(data[0].date))} to ${esc(fmtDayLabel(data[data.length - 1].date))}">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="${color}" stop-opacity="0.34"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#${gid})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${yAxis}${xAxis}
        ${interactive ? `
          <line class="a-crosshair" id="${gid}-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}"/>
          <circle id="${gid}-dot" r="4" fill="${color}" stroke="var(--card-solid)" stroke-width="2" opacity="0"/>
          <rect class="a-hot" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/>` : ''}
      </svg>
      ${interactive ? '<div class="a-tooltip"><span class="a-tooltip-date"></span><br><span class="a-tooltip-val"></span></div>' : ''}`;

    if (!interactive) return;

    attachHover(host, data, {
      count: data.length,
      toX: x, toY: (d) => y(d.value),
      viewW: VW, viewH: H,
      cross: $(`${gid}-cross`), dot: $(`${gid}-dot`),
      label,
    });
  }

  /** Vertical bar chart over a dated series. */
  function barChart(host, data, opts = {}) {
    const { color = C2, label = 'value' } = opts;
    if (!data || !data.length) return emptyChart(host, 'No data for this period yet.');
    if (!data.some(d => d.value > 0)) return emptyChart(host, 'No AI tokens recorded in this period.');

    const H = 210, padL = 44, padR = 10, padT = 14, padB = 26;
    const plotW = VW - padL - padR;
    const plotH = H - padT - padB;

    const max  = niceMax(Math.max(...data.map(d => d.value), 0));
    const slot = plotW / data.length;
    const bw   = Math.max(2, slot - 2);     // the 2px gap keeps bars from fusing
    const x    = (i) => padL + i * slot + (slot - bw) / 2;
    const y    = (v) => padT + plotH - (v / max) * plotH;

    let grid = '', yAxis = '';
    for (let t = 0; t <= 2; t++) {
      const v  = (max / 2) * t;
      const yy = y(v).toFixed(1);
      grid  += `<line class="a-grid-line" x1="${padL}" y1="${yy}" x2="${VW - padR}" y2="${yy}"/>`;
      yAxis += `<text class="a-axis-text" x="${padL - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(fmt(v))}</text>`;
    }

    let xAxis = '';
    [0, Math.floor((data.length - 1) / 2), data.length - 1].forEach((i, n) => {
      if (i < 0 || !data[i]) return;
      xAxis += `<text class="a-axis-text" x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="${n === 0 ? 'start' : n === 2 ? 'end' : 'middle'}">${esc(fmtDayLabel(data[i].date))}</text>`;
    });

    const bars = data.map((d, i) => {
      const h = Math.max(d.value > 0 ? 2 : 0, padT + plotH - y(d.value));
      return `<rect x="${x(i).toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 2).toFixed(1)}" fill="${color}"/>`;
    }).join('');

    const gid = `b${Math.random().toString(36).slice(2, 8)}`;
    host.innerHTML = `
      <svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} over time">
        ${grid}${bars}${yAxis}${xAxis}
        <line class="a-crosshair" id="${gid}-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}"/>
        <rect class="a-hot" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/>
      </svg>
      <div class="a-tooltip"><span class="a-tooltip-date"></span><br><span class="a-tooltip-val"></span></div>`;

    attachHover(host, data, {
      count: data.length,
      toX: (i) => x(i) + bw / 2,
      toY: (d) => y(d.value),
      viewW: VW, viewH: H,
      cross: $(`${gid}-cross`), dot: null,
      label,
    });
  }

  /* Shared crosshair + tooltip behaviour for the dated charts. */
  function attachHover(host, data, cfg) {
    const svg = host.querySelector('svg');
    const hot = host.querySelector('.a-hot');
    const tip = host.querySelector('.a-tooltip');
    if (!svg || !hot || !tip) return;

    const show = (evt) => {
      const box = svg.getBoundingClientRect();
      const rel = (evt.clientX - box.left) / box.width * cfg.viewW;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < cfg.count; i++) {
        const d = Math.abs(cfg.toX(i) - rel);
        if (d < bestD) { bestD = d; best = i; }
      }
      const point = data[best];
      const px = cfg.toX(best), py = cfg.toY(point);

      if (cfg.cross) { cfg.cross.setAttribute('x1', px); cfg.cross.setAttribute('x2', px); cfg.cross.classList.add('is-on'); }
      if (cfg.dot)   { cfg.dot.setAttribute('cx', px); cfg.dot.setAttribute('cy', py); cfg.dot.setAttribute('opacity', '1'); }

      tip.querySelector('.a-tooltip-date').textContent = fmtDayLabel(point.date);
      tip.querySelector('.a-tooltip-val').textContent  = `${fmtFull(point.value)} ${cfg.label}`;
      tip.style.left = `${(px / cfg.viewW) * 100}%`;
      tip.style.top  = `${(py / cfg.viewH) * 100}%`;
      tip.classList.add('is-on');
    };

    const hide = () => {
      if (cfg.cross) cfg.cross.classList.remove('is-on');
      if (cfg.dot)   cfg.dot.setAttribute('opacity', '0');
      tip.classList.remove('is-on');
    };

    hot.addEventListener('pointermove', show);
    hot.addEventListener('pointerenter', show);
    hot.addEventListener('pointerleave', hide);
  }

  /** Donut with a direct-labelled legend beside it. */
  function donut(host, slices, centreLabel) {
    const total = slices.reduce((s, x) => s + x.value, 0);
    if (!total) return emptyChart(host, 'No devices yet.');

    const S = 150, R = 62, r = 42, cx = S / 2, cy = S / 2;
    const polar = (radius, a) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];

    let angle = -Math.PI / 2;
    const arcs = slices.map((s) => {
      if (!s.value) return '';
      const sweep = (s.value / total) * Math.PI * 2;
      /* A full circle can't be drawn as one arc — split it. */
      const span = Math.min(sweep, Math.PI * 1.999);
      const a0 = angle, a1 = angle + span;
      angle = a1;
      const [x0, y0] = polar(R, a0), [x1, y1] = polar(R, a1);
      const [x2, y2] = polar(r, a1), [x3, y3] = polar(r, a0);
      const large = span > Math.PI ? 1 : 0;
      return `<path d="M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${large} 0 ${x3} ${y3} Z"
                fill="${s.color}" stroke="var(--card-solid)" stroke-width="2"><title>${esc(s.label)}: ${esc(fmtFull(s.value))}</title></path>`;
    }).join('');

    const legend = slices.map(s => `
      <div class="a-donut-row">
        <span class="a-legend-swatch" style="background:${s.color}"></span>
        <span class="a-donut-name">${esc(s.label)}</span>
        <span class="a-donut-num">${esc(fmtFull(s.value))}</span>
        <span class="a-donut-pct">${total ? ((s.value / total) * 100).toFixed(1) : '0.0'}%</span>
      </div>`).join('');

    host.innerHTML = `
      <div class="a-donut-wrap">
        <svg viewBox="0 0 ${S} ${S}" style="width:150px;flex:0 0 auto" role="img" aria-label="${esc(centreLabel)} breakdown">
          ${arcs}
          <text class="a-donut-center-val" x="${cx}" y="${cy - 2}">${esc(fmt(total))}</text>
          <text class="a-donut-center-lbl" x="${cx}" y="${cy + 13}">${esc(centreLabel.toUpperCase())}</text>
        </svg>
        <div class="a-donut-legend">${legend}</div>
      </div>`;
  }

  /* ═══ Overview ═══════════════════════════════════════════════ */

  async function loadOverview(force = false) {
    try {
      stats = await request('/api/admin/stats', { ttl: 120_000, force });
      renderOverview();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  function renderOverview() {
    if (!stats) return;

    const active = (stats.daily_active || []).map(d => ({ date: d.date, value: d.users || 0 }));
    const tokens = (stats.daily_tokens || []).map(d => ({ date: d.date, value: d.tokens || 0 }));
    const tokens30 = tokens.reduce((s, d) => s + d.value, 0);

    $('k-total').textContent  = fmt(stats.total_users);
    $('k-dau').textContent    = fmt(stats.dau);
    $('k-mau').textContent    = fmt(stats.mau);
    /* Headline and sparkline must be the same measure — this tile is tokens, so
       "Total AI Uses" (a lifetime count with no series behind it) lives in the
       strip below instead. */
    $('k-tokens').textContent = fmt(tokens30);

    $('k-total-foot').textContent = `${fmtFull(stats.new_installs_7d)} new in the last 7 days`;
    $('k-mau-foot').textContent   = stats.total_users
      ? `${((stats.mau / stats.total_users) * 100).toFixed(1)}% of all installs`
      : '';

    $('k-wau').textContent   = fmt(stats.wau);
    $('k-ai').textContent    = fmt(stats.total_ai_uses);
    $('k-kb').textContent    = fmt(stats.total_keyboard_opens);
    $('k-app').textContent   = fmt(stats.total_app_opens);
    $('k-voice').textContent = fmt(stats.total_voice_ai_uses);
    $('k-lens').textContent  = fmt((stats.total_lens_translate || 0) + (stats.total_lens_reply || 0));

    renderActiveChart();
    /* The sparkline always shows the full window — it's the tile's shape, not a
       view the operator steers, so the range toggle below doesn't move it. */
    lineChart($('k-dau-spark'), active, { color: C1, compact: true, label: 'devices' });
    barChart($('chartTokens'), tokens, { color: C2, label: 'tokens' });
    lineChart($('k-tokens-spark'), tokens, { color: C2, compact: true, label: 'tokens' });

    const mix = stats.plan_mix || {};
    donut($('chartPlans'), [
      { label: 'Free', value: mix.free || 0, color: ORD[0] },
      { label: 'Pro',  value: mix.pro  || 0, color: ORD[1] },
      { label: 'Max',  value: mix.max  || 0, color: ORD[2] },
    ], 'devices');

    renderCountries();
    populateCountryFilter();
    stamp();
  }

  /* The daily-active panel, at whatever range the toggle is on. Split out of
     renderOverview() so flipping 7d/30d re-slices the series already in hand
     instead of costing a request — `stats` holds all 30 days either way. */
  function renderActiveChart() {
    if (!stats) return;
    const all = (stats.daily_active || []).map(d => ({ date: d.date, value: d.users || 0 }));
    lineChart($('chartActive'), all.slice(-activeRange), { color: C1, label: 'devices' });
  }

  function setActiveRange(days) {
    if (days === activeRange) return;
    activeRange = days;
    $$('#activeRange .a-seg-btn').forEach(b => {
      const on = Number(b.dataset.range) === days;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    renderActiveChart();
  }

  /* How many country rows the panel shows before the "Show all" toggle. The
     list itself is never truncated server-side — a market with one device is
     exactly the row you don't want silently dropped. */
  const COUNTRY_PREVIEW = 12;
  let countriesExpanded = false;

  function toggleCountries() {
    countriesExpanded = !countriesExpanded;
    renderCountries();
    /* Collapsing from the bottom of a long list would leave the viewport past
       the panel, so pull the toggle back into view. */
    if (!countriesExpanded) {
      const btn = $('countryPanel').querySelector('[data-action="toggle-countries"]');
      if (btn) btn.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderCountries() {
    const host = $('countryPanel');
    const rows = Array.isArray(stats.countries) ? stats.countries : [];
    if (!rows.length) {
      return emptyChart(host, 'No country data yet — it is stamped on a device’s next ping.');
    }

    /* Bars scale against the top country, not the total, so a long tail after
       one dominant market stays readable. */
    const max   = Math.max(...rows.map(r => r.users), 1);
    const shown = rows.reduce((n, r) => n + r.users, 0);
    const live  = rows.reduce((n, r) => n + (r.active_7d || 0), 0);

    const visible = countriesExpanded ? rows : rows.slice(0, COUNTRY_PREVIEW);
    const hidden  = rows.length - visible.length;

    /* Each bar is split active-7d / dormant rather than showing one lifetime
       total. A country's device count on its own says only "we were installed
       there once" — the split is what distinguishes a live market from a single
       device that ran the app one afternoon and never came back (which is what
       a VPN exit, a store crawler or a review device looks like). The hover
       title carries the engagement totals for the same reason. */

    host.innerHTML = `
      <div class="a-barlist${countriesExpanded && rows.length > COUNTRY_PREVIEW ? ' is-scroll' : ''}">
        ${visible.map(r => {
          const users  = r.users || 0;
          const act    = Math.min(r.active_7d || 0, users);
          const name   = regionName(r.country);
          const title  = `${name} (${r.country}) · ${fmtFull(act)} of ${fmtFull(users)} active in 7d · `
                       + `${fmtFull(r.kb_opens || 0)} keyboard opens · ${fmtFull(r.ai_uses || 0)} AI uses`;
          return `
          <button type="button" class="a-barlist-row is-clickable" data-country="${esc(r.country)}" title="${esc(title)}">
            <span class="a-barlist-key">${esc(name)}</span>
            <span class="a-barlist-track is-split">
              <span class="a-barlist-fill" style="width:${((act / max) * 100).toFixed(1)}%"></span>
              <span class="a-barlist-fill is-dim" style="width:${(((users - act) / max) * 100).toFixed(1)}%"></span>
            </span>
            <span class="a-barlist-val">${esc(fmtFull(users))} <small>· ${esc(fmtFull(act))} active</small></span>
          </button>`;
        }).join('')}
      </div>
      ${rows.length > COUNTRY_PREVIEW ? `
      <div class="a-barlist-more">
        <button type="button" class="a-btn a-btn-ghost a-btn-sm" data-action="toggle-countries"
                aria-expanded="${countriesExpanded}">
          ${countriesExpanded
            ? `Show top ${COUNTRY_PREVIEW}`
            : `Show all ${esc(fmtFull(rows.length))} countries <small>· ${esc(fmtFull(hidden))} more</small>`}
        </button>
      </div>` : ''}
      <div class="a-barlist-legend">
        <span class="a-legend-item"><span class="a-legend-swatch" style="background:${C1}"></span>Active in 7d</span>
        <span class="a-legend-item"><span class="a-legend-swatch a-swatch-dim"></span>Dormant</span>
        <span class="a-legend-note">Click a country to see its devices</span>
      </div>
      ${stats.countries_pending ? `<p class="a-note">${esc(fmtFull(stats.countries_pending))} device(s) haven’t pinged since country tracking shipped, so they carry no country yet — this covers the ${esc(fmtFull(shown))} reported so far, not all installs. Of those, ${esc(fmtFull(live))} were active in the last 7 days.</p>` : ''}`;
  }

  /* The Devices country dropdown is filled from the same breakdown, so it can
     only ever offer codes that exist in the data. Overview loads first at boot,
     but a reload straight onto #devices skips it — showCountry() below adds a
     missing code on demand rather than depending on this having run. */
  function populateCountryFilter() {
    const sel  = $('devCountry');
    const rows = Array.isArray(stats && stats.countries) ? stats.countries : [];
    if (!sel || !rows.length) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">All countries</option>'
      + rows.map(r => `<option value="${esc(r.country)}">${esc(regionName(r.country))} (${esc(r.country)})</option>`).join('');
    if (keep) sel.value = keep;
  }

  /* Country row → the Devices table, scoped to that country. */
  function showCountry(code) {
    const sel = $('devCountry');
    if (!Array.from(sel.options).some(o => o.value === code)) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${regionName(code)} (${code})`;
      sel.appendChild(opt);
    }
    sel.value = code;
    /* go() fetches the section itself on its first visit — reloading here too
       would fire the same request twice. */
    const firstVisit = !loaded.has('devices');
    go('devices');
    if (!firstVisit) loadDevices(1);
  }

  function stamp() {
    if (!stats || !stats.generated_at) return;
    $('stamp').textContent = `Updated ${fmtTime(stats.generated_at)}`;
  }

  /* ═══ Country readiness board ════════════════════════════════
     A full-screen checklist of every country, where the operator ticks the
     markets the app and the keyboard are actually ready for. It is the launch
     side of what the "Devices by country" panel measures: that panel says where
     people already are, this one says where we mean to be.

     The ticks are the operator's own judgement — nothing derives them. The
     board only supplies the evidence beside each row (devices seen there) and
     persists the list server-side, so it is the same checklist from any
     machine rather than one browser's localStorage.

     Codes only, names from Intl.DisplayNames — same reasoning as regionName():
     shipping a name table would mean shipping it in one language and letting it
     drift. This is the complete set of 249 officially assigned ISO 3166-1
     alpha-2 codes, uninhabited territories included: a country you would never
     ship to costs one filtered-out row, while a missing one is a market you
     cannot record at all. Plus XK — Kosovo has no officially assigned code, but
     the app already ships it a keyboard layout (kCountryLayouts in
     lib/data/keyboard_layouts.dart), so it is a market whether ISO says so or
     not. CLDR names it, and `/api/track` will report it. */

  const ISO_COUNTRIES = (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
    'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
    'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
    'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY ' +
    'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
    'NA NC NE NF NG NI NL NO NP NR NU NZ OM ' +
    'PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
    'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
  ).split(' ');

  /* Live only while the board is open. Held apart from `config.ready_countries`
     so a tick shows instantly and the save can be debounced — the console
     treats requests as scarce, and ticking a dozen countries in a row must not
     cost a dozen POSTs. */
  let readySet    = null;
  let readyFilter = 'all';
  let readyQuery  = '';
  let readyDirty  = false;
  let readySaving = false;

  /* code → { users, active_7d, … }, from the same breakdown the panel charts. */
  function countryStatsMap() {
    const map = new Map();
    for (const r of (stats && stats.countries) || []) {
      if (r && r.country) map.set(String(r.country).toUpperCase(), r);
    }
    return map;
  }

  /* Sorted by NAME, not code: on a 249-row list, alphabetical by what you
     actually read is the only order that can be scanned. Rebuilt per render
     because the filter and the query change what survives — cheap at this size. */
  function readyRows() {
    const seen = countryStatsMap();
    /* A code the backend reported that ISO does not list (or that was assigned
       after this build) still deserves a row — it is a real market with real
       devices behind it. */
    const codes = [...new Set([...ISO_COUNTRIES, ...seen.keys()])];
    const q = readyQuery.trim().toLowerCase();

    return codes
      .map(code => ({ code, name: regionName(code), row: seen.get(code) || null }))
      .filter(c => {
        if (readyFilter === 'ready'   && !readySet.has(c.code)) return false;
        if (readyFilter === 'pending' &&  readySet.has(c.code)) return false;
        if (readyFilter === 'devices' && !c.row)                return false;
        if (q && !c.name.toLowerCase().includes(q) && !c.code.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }

  function renderReadiness() {
    if (!readySet) return;
    const seen = countryStatsMap();
    const rows = readyRows();

    /* Device coverage, not just a count of ticks: "30 countries ready" says
       little on its own, "and they hold 96% of the devices we have seen" is the
       number that tells you whether the checklist is where the users are. */
    let reported = 0, covered = 0;
    for (const [code, r] of seen) {
      const users = r.users || 0;
      reported += users;
      if (readySet.has(code)) covered += users;
    }
    const pct = reported ? Math.round((covered / reported) * 100) : 0;

    const sep = '<span class="a-ready-sep">·</span>';
    $('readyCount').innerHTML =
      `<strong>${esc(fmtFull(readySet.size))}</strong> of ${esc(fmtFull(ISO_COUNTRIES.length))} ready`
      + (reported ? ` ${sep} ${esc(String(pct))}% of devices covered` : '')
      + (rows.length !== ISO_COUNTRIES.length ? ` ${sep} showing ${esc(fmtFull(rows.length))}` : '');

    if (!rows.length) {
      $('readyGrid').innerHTML = '<p class="a-ready-empty">No country matches this search.</p>';
      return;
    }

    $('readyGrid').innerHTML = rows.map(c => {
      const on    = readySet.has(c.code);
      const users = c.row ? (c.row.users || 0) : 0;
      const act   = c.row ? Math.min(c.row.active_7d || 0, users) : 0;
      const meta  = c.row
        ? `${esc(c.code)} · ${esc(fmtFull(users))} device${users === 1 ? '' : 's'}`
          + (act ? ` · <span class="a-ready-live">${esc(fmtFull(act))} active</span>` : '')
        : `${esc(c.code)} · no devices yet`;
      /* data-cc, not data-country: the global click handler routes any
         [data-country] straight to the Devices table, which would slam the
         board shut on every tick. */
      return `
        <button type="button" class="a-ready-item" role="checkbox" aria-checked="${on}"
                data-action="ready-toggle" data-cc="${esc(c.code)}">
          <span class="a-ready-box">${icon('check')}</span>
          <span class="a-ready-text">
            <span class="a-ready-name">${esc(c.name)}</span>
            <span class="a-ready-meta">${meta}</span>
          </span>
        </button>`;
    }).join('');
  }

  async function openReadiness() {
    const board = $('readiness');
    board.classList.add('is-open');
    board.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    if (!readySet) {
      $('readyGrid').innerHTML = '<p class="a-ready-empty">Loading the saved list…</p>';
      try {
        /* Shares its cache entry with the Releases section, so opening the board
           after visiting that section costs no request at all. */
        config = await request('/api/admin/set-config', { ttl: 30_000 });
      } catch (e) {
        $('readyGrid').innerHTML = `<p class="a-ready-empty">${esc(e.message)}</p>`;
        return;
      }
      readySet = new Set(
        (Array.isArray(config.ready_countries) ? config.ready_countries : [])
          .map(c => String(c).toUpperCase())
      );
      setReadyStatus('');
    }
    renderReadiness();
    $('readySearch').focus();
  }

  function closeReadiness() {
    const board = $('readiness');
    board.classList.remove('is-open');
    board.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    /* Never close over an unsaved tick — the debounce may still be pending. */
    if (readyDirty) saveReadiness();
  }

  function toggleReady(code) {
    if (!readySet || !code) return;
    if (readySet.has(code)) readySet.delete(code);
    else readySet.add(code);
    readyDirty = true;
    renderReadiness();

    setReadyStatus('Saving…');
    debounce('ready', saveReadiness, 900);
  }

  function setReadyFilter(name) {
    if (!name || name === readyFilter) return;
    readyFilter = name;
    $$('#readyFilter .a-seg-btn').forEach(b => {
      const on = b.dataset.filter === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    renderReadiness();
  }

  function setReadyStatus(text, kind = '') {
    const el = $('readyStatus');
    el.className = `a-full-status a-action-status${kind ? ` is-${kind}` : ''}`;
    el.textContent = text;
  }

  /* The whole list goes up on every save, matching how set-config treats each
     of its fields as a wholesale replacement. It is at most 249 two-letter
     codes, so there is nothing to gain from a diff. */
  async function saveReadiness() {
    if (!readySet || readySaving) return;
    readySaving = true;
    readyDirty  = false;
    const sent = [...readySet].sort();
    try {
      const data = await request('/api/admin/set-config', {
        method: 'POST',
        body: { ready_countries: sent },
      });
      config = data;
      invalidate('/api/admin/set-config');
      setReadyStatus(`Saved · ${fmtFull(sent.length)} ready`, 'ok');
    } catch (e) {
      /* The board keeps showing what the operator ticked rather than snapping
         back: the ticks are their input, and a rate-limited save is worth
         retrying, not discarding. */
      readyDirty = true;
      setReadyStatus(e.message, 'bad');
      toast(e.message, 'bad');
    } finally {
      readySaving = false;
      /* A tick that landed while the request was in flight is not in `sent`. */
      if (readyDirty) debounce('ready', saveReadiness, 900);
    }
  }

  /* ═══ Devices ════════════════════════════════════════════════ */

  function skeleton(tbody, cols, rows = 6) {
    tbody.innerHTML = Array.from({ length: rows }, () =>
      `<tr class="a-skel-row">${Array.from({ length: cols }, (_, i) =>
        `<td><span class="a-skel" style="width:${[70, 45, 35, 40, 60, 60, 30, 30, 45, 35, 35, 40][i] || 50}%"></span></td>`).join('')}</tr>`
    ).join('');
  }

  function stateRow(tbody, cols, message, isError = false) {
    tbody.innerHTML = `<tr class="a-state-row${isError ? ' is-error' : ''}"><td colspan="${cols}">${esc(message)}</td></tr>`;
  }

  async function loadDevices(p = 1, force = false) {
    page.dev = p;
    const params = new URLSearchParams({ page: p, limit: 50, sort: $('devSort').value, order: 'desc' });
    const search  = $('devSearch').value.trim();
    const filter  = $('devFilter').value;
    const country = $('devCountry').value;
    if (search)  params.set('search', search);
    if (filter)  params.set('filter', filter);
    if (country) params.set('country', country);

    const tbody = $('devBody');
    skeleton(tbody, 12);

    try {
      const data = await request(`/api/admin/users?${params}`, { force });
      renderDevices(data.devices || []);
      renderPager($('devPager'), data.pagination, 'dev');
      if (data.pagination) {
        const badge = $('navCountDevices');
        badge.textContent = fmt(data.pagination.total);
        badge.classList.remove('a-hidden');
      }
    } catch (e) {
      stateRow(tbody, 12, e.message, true);
      $('devPager').innerHTML = '';
    }
  }

  function renderDevices(devices) {
    const tbody = $('devBody');
    if (!devices.length) return stateRow(tbody, 12, 'No devices match these filters.');

    tbody.innerHTML = devices.map(d => `
      <tr class="is-clickable" data-device-id="${esc(d.device_id)}" tabindex="0">
        <td class="a-primary-cell" title="${esc(d.device_id)}">${esc(d.device_name || 'Unknown')}</td>
        <td>${planBadge(d)}</td>
        <td${d.country ? ` title="${esc(regionName(d.country))}"` : ''}>${d.country ? esc(d.country) : '<span class="a-no">—</span>'}</td>
        <td>${esc(d.android_version || '—')}</td>
        <td>${esc(fmtDate(d.install_date))}</td>
        <td>${esc(fmtDate(d.last_use_date))}</td>
        <td class="a-right a-num">${esc(fmtFull(d.total_app_opens || 0))}</td>
        <td class="a-right a-num">${esc(fmtFull(d.total_keyboard_opens || 0))}</td>
        <td class="a-right a-num">${esc(fmt(d.total_ai_tokens || 0))}</td>
        <td>${d.keyboard_enabled  ? '<span class="a-yes">Yes</span>' : '<span class="a-no">No</span>'}</td>
        <td>${d.keyboard_selected ? '<span class="a-yes">Yes</span>' : '<span class="a-no">No</span>'}</td>
        <td>${esc(d.selected_theme || '—')}</td>
      </tr>`).join('');
  }

  function renderPager(host, p, target) {
    if (!p) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <span class="a-pager-info">Page ${p.page} of ${p.total_pages || 1} · ${fmtFull(p.total)} total</span>
      <button class="a-btn a-btn-ghost a-btn-sm" data-action="page" data-target="${target}" data-page="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>Previous</button>
      <button class="a-btn a-btn-ghost a-btn-sm" data-action="page" data-target="${target}" data-page="${p.page + 1}" ${p.page >= (p.total_pages || 1) ? 'disabled' : ''}>Next</button>`;
  }

  /* ═══ Device drawer ══════════════════════════════════════════ */

  let drawerDeviceId = null;

  /* Activity pager state for the open device: how much of the timeline is on
     screen and how much is left. Null whenever the drawer isn't showing a
     device. 100 per request keeps a normal drawer open cheap while still
     letting an operator walk a few thousand events without burning through the
     authenticated rate-limit budget (see backend/lib/auth.js). */
  const EVENTS_LIMIT = 100;
  let drawerEvents = null;             // { page, loaded, total, busy }

  function openDrawer(title, bodyHtml, wide = false) {
    drawerEvents = null;
    $('drawerTitle').innerHTML = title;
    $('drawerBody').innerHTML  = bodyHtml;
    const d = $('drawer');
    d.classList.toggle('is-wide', wide);
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('is-open');
  }

  function closeDrawer() {
    $('drawer').classList.remove('is-open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('is-open');
    drawerDeviceId = null;
    drawerEvents   = null;
  }

  async function showDevice(deviceId) {
    drawerDeviceId = deviceId;
    openDrawer('Loading…', '<p class="a-muted">Loading device…</p>');
    try {
      const data = await request(
        `/api/admin/user?id=${encodeURIComponent(deviceId)}&events_limit=${EVENTS_LIMIT}`,
        { ttl: 15_000 });
      renderDevice(data);
    } catch (e) {
      $('drawerBody').innerHTML = `<p class="a-error-text">${esc(e.message)}</p>`;
    }
  }

  function renderDevice({ device: d, recent_events: events, events_pagination: pg }) {
    if (!d) return;
    $('drawerTitle').innerHTML = `${esc(d.device_name || 'Unknown device')} ${planBadge(d)}`;

    const tier      = effectiveTier(d);
    const paidValid = isPaidValid(d);
    const priorInstalls = Array.isArray(d.merged_device_ids) ? d.merged_device_ids.length : 0;

    const rows = [
      ['Device ID',       `<span class="a-mono">${esc(d.device_id)}</span>`],
      ['Effective tier',  `${TIER_LABEL[tier]} <span class="a-muted">· ${fmtFull({ free: 10000, pro: 50000, max: 150000 }[tier])} tokens/day</span>`],
      ['Self-reported',   esc(d.plan_tier || 'free')],
      ['Country',         d.country ? `${esc(regionName(d.country))} <span class="a-muted">${esc(d.country)}</span>` : '—'],
      ['Android',         esc(d.android_version || '—')],
      ['First seen',      esc(fmtDateTime(d.created_at || d.install_date))],
      ['Install date',    esc(fmtDate(d.install_date))],
      ['Last active',     esc(fmtDateTime(d.last_use_date))],
      ['Prior installs',  priorInstalls ? `${priorInstalls} <span class="a-muted">· merged on reinstall</span>` : '—'],
      ['Purchased tier',  d.paid_tier ? `${esc(TIER_LABEL[normTier(d.paid_tier)] || d.paid_tier)}${paidValid ? '' : ' <span class="a-muted">· expired</span>'}` : '—'],
      ['Purchased plan',  esc(d.premium_plan || '—')],
      ['Paid since',      esc(d.premium_since ? fmtDateTime(d.premium_since) : '—')],
      ['Paid until',      d.premium_until ? `${esc(fmtDateTime(d.premium_until))}${paidValid ? '' : ' <span class="a-error-text">· expired</span>'}` : '—'],
      ['Recovery code',   d.recovery_code ? `<span class="a-mono">${esc(d.recovery_code)}</span>` : '—'],
      ['Restored from',   d.premium_restored_from ? `<span class="a-mono">${esc(d.premium_restored_from)}</span> <span class="a-muted">· ${esc(fmtDate(d.premium_restored_at))}</span>` : '—'],
      ['Admin override',  d.admin_plan_override ? `${esc(d.admin_plan_override)} <span class="a-muted">· set ${esc(fmtDateTime(d.admin_plan_override_at))}</span>` : '—'],
      ['Keyboard enabled', d.keyboard_enabled  ? 'Yes' : 'No'],
      ['Set as default',   d.keyboard_selected ? 'Yes' : 'No'],
      ['Theme',            esc(d.selected_theme || '—')],
      ['Lifetime tokens',  esc(fmtFull(d.total_ai_tokens || 0))],
      ['App opens',        esc(fmtFull(d.total_app_opens || 0))],
      ['Keyboard opens',   esc(fmtFull(d.total_keyboard_opens || 0))],
      ['Keyboard AI',      esc(fmtFull(d.total_ai_uses || 0))],
      ['Voice AI',         esc(fmtFull(d.total_voice_ai_uses || 0))],
      ['Lens translate',   esc(fmtFull(d.total_lens_translate || 0))],
      ['Lens reply',       esc(fmtFull(d.total_lens_reply || 0))],
    ];

    let html = `<div class="a-drawer-section"><h3>Device</h3>
      <dl class="a-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;

    html += `<div class="a-drawer-section">
      <h3>Change plan</h3>
      <p>Sets an admin override, applied on the device's next analytics ping. An override outranks the
         app's self-reported tier. Setting Free while a purchase is still valid does <em>not</em> lower the
         budget — the server keeps honouring the paid tier until it expires.</p>
      <div class="a-actions">
        <button class="a-btn ${tier === 'free' ? 'a-btn-primary' : 'a-btn-ghost'} a-btn-sm" data-action="set-plan" data-plan="free">Free</button>
        <button class="a-btn ${tier === 'pro'  ? 'a-btn-primary' : 'a-btn-ghost'} a-btn-sm" data-action="set-plan" data-plan="pro">Pro</button>
        <button class="a-btn ${tier === 'max'  ? 'a-btn-primary' : 'a-btn-ghost'} a-btn-sm" data-action="set-plan" data-plan="max">Max</button>
        ${d.admin_plan_override ? '<button class="a-btn a-btn-ghost a-btn-sm" data-action="clear-plan">Clear override</button>' : ''}
        <span class="a-action-status" id="planStatus"></span>
      </div>
    </div>`;

    html += `<div class="a-drawer-section">
      <h3 class="is-danger">Danger zone</h3>
      <p>Permanently deletes ALL data for this user: device records (plan, premium expiry, recovery code,
         daily token counters), events, crashes and payment records — including every reinstall on the same
         hardware. This cannot be undone.</p>
      <div class="a-actions">
        <button class="a-btn a-btn-danger a-btn-sm" data-action="delete-device">${icon('trash')}Delete all user data</button>
        <span class="a-action-status" id="deleteStatus"></span>
      </div>
    </div>`;

    const loaded = events ? events.length : 0;
    const total  = pg && Number.isFinite(pg.total) ? pg.total : loaded;

    if (loaded) {
      drawerEvents = { page: (pg && pg.page) || 1, loaded, total, busy: false };
      html += `<div class="a-drawer-section">
        <h3>Activity · <span id="eventsCount">${fmtFull(loaded)}</span> of ${fmtFull(total)}</h3>
        <div class="a-events" id="eventsList">${events.map(eventRow).join('')}</div>
        <div class="a-actions a-events-more" id="eventsMore">${moreEventsBtn(loaded, total)}</div>
      </div>`;
    } else {
      html += '<div class="a-drawer-section"><h3>Activity</h3><p class="a-muted">No events recorded.</p></div>';
    }

    $('drawerBody').innerHTML = html;
  }

  function eventRow(e) {
    return `<div class="a-event">
      <span class="a-event-type">${esc(e.event_type)}</span>
      ${e.metadata ? `<span class="a-event-meta">${esc(e.metadata)}</span>` : ''}
      <span class="a-event-time">${esc(fmtDateTime(e.timestamp))}</span>
    </div>`;
  }

  function moreEventsBtn(loaded, total) {
    const remaining = total - loaded;
    if (remaining <= 0) return '';
    return `<button class="a-btn a-btn-ghost a-btn-sm" data-action="more-events">Load more</button>
      <span class="a-action-status">${fmtFull(remaining)} older</span>`;
  }

  /* Appends the next page in place rather than re-rendering the drawer, so the
     operator's scroll position survives. The device doc comes back too and is
     simply ignored — one shape for the endpoint beats a second events-only mode
     for the sake of one indexed findOne. */
  async function loadMoreEvents() {
    if (!drawerDeviceId || !drawerEvents || drawerEvents.busy) return;
    const deviceId = drawerDeviceId;
    const next     = drawerEvents.page + 1;
    const btn      = document.querySelector('[data-action="more-events"]');

    drawerEvents.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

    try {
      const data = await request(
        `/api/admin/user?id=${encodeURIComponent(deviceId)}&events_page=${next}&events_limit=${EVENTS_LIMIT}`,
        { ttl: 15_000 });

      // The drawer may have been closed or switched while this was in flight.
      if (drawerDeviceId !== deviceId || !drawerEvents || !$('eventsList')) return;

      const rows = data.recent_events || [];
      drawerEvents.page    = next;
      drawerEvents.loaded += rows.length;
      if (data.events_pagination && Number.isFinite(data.events_pagination.total)) {
        drawerEvents.total = data.events_pagination.total;
      }
      // An empty page while the count still claims more (events deleted between
      // the two calls) would leave a button that does nothing. Trust the rows.
      if (!rows.length) drawerEvents.total = drawerEvents.loaded;

      $('eventsList').insertAdjacentHTML('beforeend', rows.map(eventRow).join(''));
      $('eventsCount').textContent = fmtFull(drawerEvents.loaded);
      $('eventsMore').innerHTML    = moreEventsBtn(drawerEvents.loaded, drawerEvents.total);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
      toast(e.message, 'bad');
    } finally {
      if (drawerEvents) drawerEvents.busy = false;
    }
  }

  async function setPlan(tier) {
    if (!drawerDeviceId) return;
    const status = $('planStatus');
    status.className = 'a-action-status';
    status.textContent = 'Saving…';
    try {
      await request('/api/admin/set-plan', { method: 'POST', body: { device_id: drawerDeviceId, plan_tier: tier } });
      invalidate('/api/admin/user');
      invalidate('/api/admin/stats');
      toast(`Plan override set to ${TIER_LABEL[tier] || tier}.`, 'ok');
      await showDevice(drawerDeviceId);
      loadDevices(page.dev, true);
    } catch (e) {
      status.className = 'a-action-status is-bad';
      status.textContent = e.message;
    }
  }

  async function clearPlan() {
    if (!drawerDeviceId) return;
    const status = $('planStatus');
    status.className = 'a-action-status';
    status.textContent = 'Clearing…';
    try {
      await request('/api/admin/set-plan', { method: 'DELETE', body: { device_id: drawerDeviceId } });
      invalidate('/api/admin/user');
      toast('Admin override cleared.', 'ok');
      await showDevice(drawerDeviceId);
      loadDevices(page.dev, true);
    } catch (e) {
      status.className = 'a-action-status is-bad';
      status.textContent = e.message;
    }
  }

  async function deleteDevice() {
    if (!drawerDeviceId) return;
    const ok = await confirmAsk(
      'Delete all user data?',
      'This removes the device records, events, crashes and payment records for this user — including every reinstall on the same hardware.\n\nThis cannot be undone.',
      'Delete permanently', true,
    );
    if (!ok) return;

    const status = $('deleteStatus');
    status.className = 'a-action-status';
    status.textContent = 'Deleting…';
    try {
      const data = await request('/api/admin/delete-user', { method: 'POST', body: { device_id: drawerDeviceId } });
      const d = data.deleted || {};
      invalidate('/api/admin/');
      toast(`Deleted ${d.devices || 0} device(s), ${d.events || 0} events, ${d.crashes || 0} crashes, ${d.payments || 0} payment record(s).`, 'ok');
      closeDrawer();
      loadDevices(page.dev, true);
    } catch (e) {
      status.className = 'a-action-status is-bad';
      status.textContent = e.message;
    }
  }

  /* ═══ AI tools ═══════════════════════════════════════════════ */

  function renderAiLegend() {
    $('aiLegend').innerHTML = TOOLS.map(t =>
      `<span class="a-legend-item"><span class="a-legend-swatch" style="background:${t.color}"></span>${esc(t.label)}</span>`).join('');
  }

  /* Fixed track + percentage fill. (The old version wrote the percentage into a
     `px` width capped at 80px, so every value above 80% rendered identically.) */
  function cellBar(value, max, color) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return `<td><span class="a-cellbar">
      <span class="a-cellbar-track"><span class="a-cellbar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
      <span class="a-cellbar-num">${esc(fmtFull(value))}</span>
    </span></td>`;
  }

  function topTool(d) {
    let best = null, bestVal = 0;
    for (const t of TOOLS) {
      const v = d[t.key] || 0;
      if (v > bestVal) { bestVal = v; best = t; }
    }
    return best ? `<span class="a-chip" style="background:${best.color}22;border:1px solid ${best.color}66;color:${best.color}">${esc(best.label)}</span>` : '<span class="a-no">—</span>';
  }

  async function loadAiTools(p = 1, force = false) {
    page.ai = p;
    const params = new URLSearchParams({ page: p, limit: 50, sort: $('aiSort').value, order: 'desc' });
    const search = $('aiSearch').value.trim();
    if (search) params.set('search', search);

    const tbody = $('aiBody');
    skeleton(tbody, 7);

    try {
      const data = await request(`/api/admin/users?${params}`, { force });
      const devices = data.devices || [];
      if (!devices.length) { stateRow(tbody, 7, 'No devices match this search.'); $('aiPager').innerHTML = ''; return; }

      /* Each column scales against its own column max — cross-column widths are
         not comparable, which is why every bar keeps its number beside it. */
      const maxes = {};
      for (const t of TOOLS) maxes[t.key] = Math.max(...devices.map(d => d[t.key] || 0), 1);

      tbody.innerHTML = devices.map(d => `
        <tr>
          <td class="a-primary-cell" title="${esc(d.device_id)}">${esc(d.device_name || 'Unknown')}</td>
          ${TOOLS.map(t => cellBar(d[t.key] || 0, maxes[t.key], t.color)).join('')}
          <td>${topTool(d)}</td>
          <td class="a-right a-num">${esc(fmtFull(TOOLS.reduce((s, t) => s + (d[t.key] || 0), 0)))}</td>
        </tr>`).join('');

      renderPager($('aiPager'), data.pagination, 'ai');
    } catch (e) {
      stateRow(tbody, 7, e.message, true);
      $('aiPager').innerHTML = '';
    }
  }

  /* ═══ API keys ═══════════════════════════════════════════════
     Health (check-keys) and limit status (key-limits) are separate endpoints —
     both live-ping Groq and are slow — but they describe the same keys, so they
     render into one card per key. */

  function renderKeys() {
    const grid = $('keyGrid');
    const byIndex = new Map();
    for (const k of keyHealth) byIndex.set(k.index, { ...byIndex.get(k.index), ...k });
    for (const k of keyLimits) byIndex.set(k.index, { ...byIndex.get(k.index), ...k, limitStatus: k.status });

    const keys = [...byIndex.values()].sort((a, b) => a.index - b.index);

    if (!keys.length) {
      grid.innerHTML = `<div class="a-empty">${icon('key')}<p>No key data loaded yet. Run a health check, or refresh the limit status.</p></div>`;
      $('keySummary').innerHTML = '';
      return;
    }

    grid.innerHTML = keys.map(k => {
      const chips = [];

      /* keyHealth rows carry `status` as health; keyLimits rows overwrite it and
         we stash the limit meaning in `limitStatus`. Read them apart. */
      const health = keyHealth.find(h => h.index === k.index);
      if (health) {
        if (health.status === 'working')        chips.push(`<span class="a-chip a-chip-ok">${icon('check')}Working</span>`);
        else if (health.status === 'ratelimit') chips.push(`<span class="a-chip a-chip-warn">${icon('alert')}Rate limited</span>`);
        else if (health.status === 'failed')    chips.push(`<span class="a-chip a-chip-bad">${icon('close')}Failed</span>`);
      }
      if (k.limitStatus === 'blocked')      chips.push(`<span class="a-chip a-chip-warn">${icon('lock')}Blocked</span>`);
      else if (k.limitStatus === 'invalid') chips.push(`<span class="a-chip a-chip-bad">${icon('close')}Invalid key</span>`);
      else if (k.limitStatus === 'available') chips.push(`<span class="a-chip a-chip-ok">${icon('check')}Available</span>`);
      if (!chips.length) chips.push('<span class="a-chip a-chip-muted">Not checked</span>');

      const meta = [];
      if (health && health.latency != null) meta.push(`Latency <b>${esc(health.latency)} ms</b>`);
      if (health && health.checkedAt)       meta.push(`Checked <b>${esc(fmtTime(health.checkedAt))}</b>`);
      if (health && health.model)           meta.push(`Model <b>${esc(health.model)}</b>`);
      if (k.limitStatus === 'blocked' && k.blocked_until) meta.push(`Until <b>${esc(fmtDateTime(k.blocked_until))}</b>`);

      return `<article class="a-key-card">
        <div class="a-key-card-top">
          <span class="a-key-idx">${esc(k.index)}</span>
          <span class="a-key-name">${esc(k.name || `Key ${k.index}`)}</span>
        </div>
        <span class="a-mono a-key-masked">${esc(k.masked || '—')}</span>
        <div class="a-key-chips">${chips.join('')}</div>
        ${meta.length ? `<div class="a-key-meta">${meta.join('')}</div>` : ''}
        ${health && health.error ? `<p class="a-key-err">${esc(health.error)}</p>` : ''}
        ${k.limitStatus === 'blocked' && k.key_hash
          ? `<div><button class="a-btn a-btn-ghost a-btn-sm" data-action="unblock" data-hash="${esc(k.key_hash)}">Unblock now</button></div>` : ''}
      </article>`;
    }).join('');

    const working = keyHealth.filter(k => k.status === 'working' || k.status === 'ratelimit').length;
    const failed  = keyHealth.filter(k => k.status === 'failed').length;
    const blocked = keyLimits.filter(k => k.status === 'blocked').length;

    const summary = [`<span class="a-chip a-chip-muted">${keys.length} keys</span>`];
    if (keyHealth.length) {
      summary.push(`<span class="a-chip a-chip-ok">${icon('check')}${working} working</span>`);
      if (failed)  summary.push(`<span class="a-chip a-chip-bad">${icon('close')}${failed} failed</span>`);
    }
    if (blocked) summary.push(`<span class="a-chip a-chip-warn">${icon('lock')}${blocked} blocked</span>`);
    $('keySummary').innerHTML = summary.join('');
  }

  async function checkKeys() {
    const btn = $('checkKeysBtn');
    btn.disabled = true;
    try {
      const data = await request('/api/admin/check-keys', { ttl: 0 });
      keyHealth = data.results || [];
      if (!keyHealth.length) toast('No Groq keys configured on the backend.', 'bad');
      renderKeys();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  async function checkLimits() {
    const btn = $('checkLimitsBtn');
    btn.disabled = true;
    try {
      const data = await request('/api/admin/key-limits', { ttl: 0 });
      keyLimits = data.keys || [];
      renderKeys();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  async function unblockKey(hash) {
    try {
      await request('/api/admin/key-limits', { method: 'DELETE', body: { key_hash: hash } });
      toast('Key unblocked.', 'ok');
      await checkLimits();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /* ═══ Crashes ════════════════════════════════════════════════ */

  async function loadCrashes(p = 1, force = false) {
    page.crash = p;
    const params = new URLSearchParams({ page: p, limit: 50, sort: $('crashSort').value, order: 'desc' });
    const search = $('crashSearch').value.trim();
    if (search) params.set('search', search);

    const tbody = $('crashBody');
    skeleton(tbody, 6);

    try {
      const data = await request(`/api/admin/crashes?${params}`, { force });
      const groups = data.groups || [];

      $('c-groups').textContent = data.pagination ? fmtFull(data.pagination.total) : '—';
      $('c-occ').textContent    = fmtFull(groups.reduce((s, g) => s + (g.occurrences || 0), 0));
      $('c-dev').textContent    = fmtFull(groups.reduce((s, g) => s + (g.affected_devices || 0), 0));

      if (data.pagination && data.pagination.total) {
        const badge = $('navCountCrashes');
        badge.textContent = fmt(data.pagination.total);
        badge.classList.remove('a-hidden');
      }

      if (!groups.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="a-empty">${icon('check')}<p>No crashes recorded. Nothing to triage.</p></div></td></tr>`;
        $('crashPager').innerHTML = '';
        return;
      }

      tbody.innerHTML = groups.map(g => {
        const s = g.sample || {};
        const preview = (s.stack_trace_preview || '').split('\n')[0] || '';
        return `<tr class="is-clickable" data-crash-hash="${esc(g.group_hash)}" tabindex="0">
          <td class="a-primary-cell" style="max-width:340px">
            ${esc(s.message || '(no message)')}
            ${preview ? `<div class="a-muted" style="font-weight:400;font-size:11px;overflow:hidden;text-overflow:ellipsis">${esc(preview)}</div>` : ''}
          </td>
          <td><span class="a-chip a-chip-muted">${esc(s.error_type || 'unknown')}</span></td>
          <td class="a-right a-num">${esc(fmtFull(g.occurrences || 0))}</td>
          <td class="a-right a-num">${esc(fmtFull(g.affected_devices || 0))}</td>
          <td>${esc(fmtDateTime(g.last_seen))}</td>
          <td>${esc(fmtDateTime(g.first_seen))}</td>
        </tr>`;
      }).join('');

      renderPager($('crashPager'), data.pagination, 'crash');
    } catch (e) {
      stateRow(tbody, 6, e.message, true);
      $('crashPager').innerHTML = '';
    }
  }

  async function showCrash(hash) {
    openDrawer('Loading…', '<p class="a-muted">Loading crash…</p>', true);
    try {
      const data = await request(`/api/admin/crashes?hash=${encodeURIComponent(hash)}`, { ttl: 15_000 });
      renderCrash(data);
    } catch (e) {
      $('drawerBody').innerHTML = `<p class="a-error-text">${esc(e.message)}</p>`;
    }
  }

  function renderCrash({ group, recent_occurrences: occ }) {
    if (!group) return;
    const s = group.sample || {};
    const list = occ || [];
    const fatal = list.some(o => o.fatal);

    $('drawerTitle').innerHTML =
      `<span class="a-chip ${fatal ? 'a-chip-bad' : 'a-chip-warn'}" style="margin-right:8px">${icon('alert')}${fatal ? 'Fatal' : 'Handled'}</span>${esc(s.message || 'Unknown error')}`;

    /* Version and mode breakdowns come out of the same 20 occurrences the API
       already sends — the old console only listed the distinct values. */
    const tally = (key) => {
      const m = new Map();
      for (const o of list) { const v = o[key]; if (v) m.set(v, (m.get(v) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const versions = tally('app_version');
    const modes    = tally('mode');

    const rows = [
      ['Error type',       esc(s.error_type || '—')],
      ['Total occurrences', esc(fmtFull(group.occurrences || 0))],
      ['Affected devices',  esc(fmtFull(group.affected_devices || 0))],
      ['First seen',        esc(fmtDateTime(group.first_seen))],
      ['Last seen',         esc(fmtDateTime(group.last_seen))],
      ['Fatal in sample',   `${list.filter(o => o.fatal).length} of ${list.length}`],
      ['Group hash',        `<span class="a-mono">${esc(group.group_hash)}</span>`],
    ];

    let html = `<div class="a-drawer-section"><h3>Summary</h3>
      <dl class="a-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;

    if (versions.length) {
      const max = Math.max(...versions.map(v => v[1]), 1);
      html += `<div class="a-drawer-section"><h3>App versions · recent ${list.length}</h3>
        <div class="a-barlist">${versions.map(([v, n]) => `
          <div class="a-barlist-row">
            <span class="a-barlist-key">${esc(v)}</span>
            <span class="a-barlist-track"><span class="a-barlist-fill" style="width:${((n / max) * 100).toFixed(1)}%"></span></span>
            <span class="a-barlist-val">${n}</span>
          </div>`).join('')}</div>
        ${modes.length ? `<p class="a-note">Modes: ${modes.map(([m, n]) => `${esc(m)} (${n})`).join(' · ')}</p>` : ''}
      </div>`;
    }

    /* Occurrences per day across the sample — enough to tell "still happening"
       from "one bad afternoon". */
    const byDay = new Map();
    for (const o of list) {
      const t = o.timestamp || o.received_at;
      if (!t) continue;
      const day = String(t).slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    if (byDay.size > 1) {
      const series = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
      html += `<div class="a-drawer-section"><h3>Occurrences over time</h3><div class="a-chart-wrap" id="crashSpark"></div></div>`;
      setTimeout(() => { const el = $('crashSpark'); if (el) barChart(el, series, { color: C4, label: 'crashes' }); }, 0);
    }

    html += `<div class="a-drawer-section"><h3>Stack trace · sample</h3>
      <pre class="a-stack">${esc(s.stack_trace || '(no stack trace)')}</pre></div>`;

    if (list.length) {
      html += `<div class="a-drawer-section"><h3>Recent ${list.length} occurrence${list.length === 1 ? '' : 's'}</h3>
        <div class="a-events">${list.map(o => `
          <div class="a-event">
            <span class="a-event-type">${esc(o.app_version || '?')}</span>
            <span class="a-event-meta" title="${esc(o.device_id || '')}">${esc((o.device_id || '').slice(0, 8))}… · ${esc(o.mode || '?')}${o.fatal ? ' · fatal' : ''}</span>
            <span class="a-event-time">${esc(fmtDateTime(o.timestamp))}</span>
          </div>`).join('')}</div></div>`;
    }

    $('drawerBody').innerHTML = html;
  }

  /* ═══ Releases & config ══════════════════════════════════════ */

  /* ═══ Referrals ══════════════════════════════════════════════ */

  /* One request for the whole section. The endpoint already aggregates, so
     there is nothing here worth a second round trip — and this page is read
     far more often than it changes. */
  async function loadReferrals(force = false) {
    let data;
    try {
      data = await request('/api/admin/referrals?limit=25', { ttl: 60_000, force });
    } catch (e) {
      $('refTopBody').innerHTML = `<tr><td colspan="6" class="a-empty">${esc(e.message)}</td></tr>`;
      return;
    }

    const f = data.funnel || {};
    $('refClaims').textContent    = fmtFull(f.claims || 0);
    $('refQualified').textContent = fmtFull(f.qualified || 0);
    $('refPending').textContent   = fmtFull(f.pending || 0);

    /* Null, not 0, when nothing has been claimed: "0%" on an empty program
       reads as a broken funnel rather than an empty one. */
    $('refQualifiedFoot').textContent = f.qualify_rate == null
      ? 'No invites redeemed yet'
      : `${f.qualify_rate}% of redeemed codes`;
    $('refClaimsFoot').textContent = data.enabled
      ? 'Referrals are live'
      : 'Referrals are switched off';

    const live = data.live_grants || {};
    $('refLive').textContent = fmtFull(live.devices || 0);
    /* Headroom handed out, NOT spend — most of a bonus is never used, which is
       exactly why referrals cost less than the sticker number suggests. */
    $('refLiveFoot').textContent =
      `${fmtFull(live.tokens_per_day || 0)} bonus tokens/day granted`;

    const top = Array.isArray(data.top_referrers) ? data.top_referrers : [];
    $('refTopBody').innerHTML = top.length
      ? top.map(r => `
        <tr>
          <td class="a-primary-cell"><span class="a-mono">${esc(String(r.device_id || r.hw_id || '—').slice(0, 12))}</span></td>
          <td class="a-num">${fmtFull(r.total || 0)}</td>
          <td class="a-num">${fmtFull(r.qualified || 0)}</td>
          <td class="a-num">${fmtFull(r.pending || 0)}</td>
          <td>${r.capped ? `<span class="a-chip a-chip-warn">${fmtFull(r.capped)}</span>` : '<span class="a-muted">—</span>'}</td>
          <td class="a-muted">${esc(r.last ? String(r.last).slice(0, 10) : '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="a-empty">Nobody has invited anyone yet.</td></tr>';

    const c = data.config || {};
    const rows = [
      ['Referrer bonus', `+${fmtFull(c.referrer_bonus)} tokens/day`],
      ['Referee bonus',  `+${fmtFull(c.referee_bonus)} tokens/day`],
      ['Bonus length',   `${c.bonus_days} days`],
      ['Stack cap',      `+${fmtFull(c.max_bonus)} tokens/day`],
      ['Per referrer',   `${c.max_per_day}/day, ${c.max_lifetime} lifetime`],
      ['Claim window',   `${c.claim_window_days} days after install`],
      ['In-app prompt',  c.popup_every_n_opens > 0
        ? `every ${c.popup_every_n_opens} app opens` +
          (c.popup_cooldown_hours > 0 ? `, at most once per ${c.popup_cooldown_hours}h` : '')
        : 'off'],
    ];
    $('refConfig').innerHTML = rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('');
  }

  async function loadReleases(force = false) {
    /* /api/updates is public and unauthenticated — reading the live version
       costs nothing from the admin budget. There is no admin GET for it. */
    try {
      const data = mock
        ? await mock.handle('/api/updates')
        : await fetch(`${API_BASE}/api/updates`).then(r => r.json());
      $('liveVersion').textContent = data.version ? `v${data.version}` : '—';
      $('liveMeta').textContent = [data.title, data.date ? `published ${data.date}` : ''].filter(Boolean).join(' · ');
      if (data.version && !$('uvVersion').value) {
        const parts = String(data.version).split('.').map(Number);
        parts[2] = (parts[2] || 0) + 1;
        $('uvVersion').value = parts.join('.');
      }
    } catch {
      $('liveVersion').textContent = '—';
      $('liveMeta').textContent = 'Could not read the published version.';
    }

    try {
      config = await request('/api/admin/set-config', { ttl: 30_000, force });
      renderConfig();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  function renderSwitch(id, on) {
    const sw = $(`${id}Switch`);
    const st = $(`${id}State`);
    sw.setAttribute('aria-checked', String(on));
    st.textContent = on ? 'Enabled' : 'Disabled';
    st.dataset.on  = String(on);
  }

  function renderConfig() {
    renderSwitch('premium', config.premium_enabled === true);
    renderSwitch('byok',    config.byok_enabled    !== false);
    renderSwitch('gif',     config.gif_enabled     !== false);
    renderSwitch('referral', config.referral_enabled === true);
    /* Only seeded when untouched, so a half-typed value is not wiped by a
       background config refresh. */
    const ft = $('freeTokensInput');
    if (ft && !ft.value) ft.value = String(config.free_daily_tokens ?? 10000);

    const gated = Array.isArray(config.gated_tools) ? config.gated_tools : [];
    $('gatedTools').innerHTML = GATED_TOOLS.map(name => `
      <button class="a-pill" role="button" aria-pressed="${gated.includes(name)}"
              data-action="toggle-gated" data-tool="${esc(name)}">
        ${icon('lock')}${esc(name)}
      </button>`).join('');
  }

  async function writeConfig(patch, message) {
    const status = $('configStatus');
    status.className = 'a-action-status';
    status.textContent = 'Saving…';
    try {
      const data = await request('/api/admin/set-config', { method: 'POST', body: patch });
      config = data;
      invalidate('/api/admin/set-config');
      renderConfig();
      status.className = 'a-action-status is-ok';
      status.textContent = 'Saved. Devices apply it on their next ping.';
      toast(message, 'ok');
    } catch (e) {
      status.className = 'a-action-status is-bad';
      status.textContent = e.message;
      renderConfig();
    }
  }

  async function togglePremium() {
    const next = !(config.premium_enabled === true);
    const ok = await confirmAsk(
      next ? 'Make Pro and Max purchasable?' : 'Hide the paid plans?',
      next
        ? 'Both paid tiers become purchasable for every user. The Google Play service-account creds must already be set in Vercel, or checkout will fail.'
        : 'Pro and Max go back to “Coming Soon” for every user. Existing purchases stay valid — only new checkouts are blocked.',
      next ? 'Enable paid plans' : 'Disable paid plans',
    );
    if (!ok) return;
    writeConfig({ premium_enabled: next }, `Paid plans ${next ? 'enabled' : 'disabled'}.`);
  }

  async function toggleGif() {
    const next = !(config.gif_enabled !== false);
    const ok = await confirmAsk(
      next ? 'Turn the GIF keyboard on?' : 'Turn the GIF keyboard off?',
      next
        ? 'The GIF tab starts serving again. A Giphy key must be set in Vercel or the tab stays dark anyway.'
        : 'The GIF tab shows “GIFs unavailable” for every user and /api/gif stops serving.',
      next ? 'Enable GIFs' : 'Disable GIFs',
    );
    if (!ok) return;
    writeConfig({ gif_enabled: next }, `GIF keyboard ${next ? 'enabled' : 'disabled'}.`);
  }

  async function toggleReferral() {
    const next = !(config.referral_enabled === true);
    const ok = await confirmAsk(
      next ? 'Turn referrals on?' : 'Turn referrals off?',
      next
        ? 'Every device gets an invite code and can redeem one. Bonuses already granted keep running either way.'
        : 'The invite screen and the in-app prompt disappear and no new code can be redeemed. Bonuses already granted are NOT revoked — they run to their expiry.',
      next ? 'Enable referrals' : 'Disable referrals',
    );
    if (!ok) return;
    writeConfig({ referral_enabled: next }, `Referrals ${next ? 'enabled' : 'disabled'}.`);
  }

  /* The one setting here that changes what existing users get. Confirmed with
     the actual before/after numbers rather than a generic "are you sure", and
     the warning names the failure mode that is not obvious: an app build older
     than the server-authoritative-budget fix keeps showing its hardcoded
     10,000 and simply fails AI calls above the new cap. */
  async function saveFreeTokens() {
    const el = $('freeTokensInput');
    const status = $('freeTokensStatus');
    const next = Number(String(el.value).replace(/[^0-9]/g, ''));
    const current = config.free_daily_tokens ?? 10000;
    const bounds = config.free_daily_tokens_bounds || { min: 2000, max: 50000 };

    if (!Number.isFinite(next) || next < bounds.min || next > bounds.max) {
      status.className = 'a-action-status is-bad';
      status.textContent = `Enter a number between ${fmtFull(bounds.min)} and ${fmtFull(bounds.max)}.`;
      return;
    }
    if (next === current) {
      status.className = 'a-action-status';
      status.textContent = 'Already set to that.';
      return;
    }

    const lowering = next < current;
    const ok = await confirmAsk(
      `Set the Free tier to ${fmtFull(next)} tokens/day?`,
      `Currently ${fmtFull(current)}. This applies to every device on its next ping.` +
      (lowering
        ? ' Users on an app build older than the server-budget fix will keep showing the old number and their AI calls will fail in between — check adoption first.'
        : ''),
      lowering ? 'Lower the cap' : 'Raise the cap',
    );
    if (!ok) return;
    status.className = 'a-action-status';
    status.textContent = '';
    writeConfig({ free_daily_tokens: next }, `Free tier set to ${fmtFull(next)} tokens/day.`);
  }

  async function toggleByok() {
    const next = !(config.byok_enabled !== false);
    const ok = await confirmAsk(
      next ? 'Enable legacy BYOK?' : 'Disable legacy BYOK?',
      next
        ? 'Old builds (≤ v2.0.x) can use their own Groq key again.'
        : 'Users on old builds fall back to the Free quota. Their stored keys are kept.',
      next ? 'Enable BYOK' : 'Disable BYOK',
    );
    if (!ok) return;
    writeConfig({ byok_enabled: next }, `BYOK ${next ? 'enabled' : 'disabled'}.`);
  }

  function toggleGated(name) {
    const current = Array.isArray(config.gated_tools) ? config.gated_tools : [];
    const next = current.includes(name) ? current.filter(t => t !== name) : [...current, name];
    writeConfig({ gated_tools: next }, current.includes(name) ? `${name} unlocked for Free.` : `${name} gated behind a paid plan.`);
  }

  async function publishUpdate() {
    const version    = $('uvVersion').value.trim();
    const title      = $('uvTitle').value.trim();
    const highlights = $('uvHighlights').value.split('\n').map(l => l.trim()).filter(Boolean);
    const status     = $('uvStatus');

    if (!version || !title) {
      status.className = 'a-action-status is-bad';
      status.textContent = 'Version and title are both required.';
      return;
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      status.className = 'a-action-status is-bad';
      status.textContent = 'Version must look like 1.2.0';
      return;
    }

    const ok = await confirmAsk(
      `Publish v${version}?`,
      `Every installed device will be told about “${title}” on its next update check.`,
      'Publish',
    );
    if (!ok) return;

    status.className = 'a-action-status';
    status.textContent = 'Publishing…';
    try {
      const data = await request('/api/admin/set-version', { method: 'POST', body: { version, title, highlights } });
      status.className = 'a-action-status is-ok';
      status.textContent = `Published v${data.saved.version}.`;
      toast(`v${data.saved.version} published.`, 'ok');
      loadReleases(true);
    } catch (e) {
      status.className = 'a-action-status is-bad';
      status.textContent = e.message;
    }
  }

  /* ═══ Navigation ═════════════════════════════════════════════ */

  const LOADERS = {
    overview: (f) => loadOverview(f),
    devices:  (f) => loadDevices(page.dev, f),
    aitools:  (f) => loadAiTools(page.ai, f),
    /* Limit status is loaded on arrival so the section isn't an empty shell;
       the full health check stays explicit because it live-tests every key
       against Groq and is the slower of the two. */
    apikeys:  () => checkLimits(),
    crashes:  (f) => loadCrashes(page.crash, f),
    referrals: (f) => loadReferrals(f),
    releases: (f) => loadReleases(f),
  };

  function go(name) {
    if (!SECTION_TITLES[name]) return;
    section = name;

    /* The section lives in the URL so a view is linkable and survives a reload
       — the token is in sessionStorage, so a refresh lands back where it was. */
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);

    $$('.a-nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.section === name));
    $$('.a-section').forEach(s => s.classList.toggle('is-active', s.id === `sec-${name}`));
    $('pageTitle').textContent = SECTION_TITLES[name];
    closeNav();

    /* Lazy: a section fetches on first visit, then reads its cache. */
    if (!loaded.has(name)) {
      loaded.add(name);
      if (name === 'aitools') renderAiLegend();
      LOADERS[name](false);
    }
  }

  const openNav  = () => { $('sidebar').classList.add('is-open'); $('navBackdrop').classList.add('is-open'); };
  const closeNav = () => { $('sidebar').classList.remove('is-open'); $('navBackdrop').classList.remove('is-open'); };

  async function refreshCurrent() {
    const btn = $('refreshBtn');
    btn.classList.add('is-busy');
    btn.disabled = true;
    try {
      if (section === 'apikeys') {
        /* Both key endpoints live-ping Groq, so refresh does what the operator
           most likely wants — limit status — rather than firing both. */
        await checkLimits();
      } else {
        await LOADERS[section](true);
      }
    } finally {
      btn.classList.remove('is-busy');
      btn.disabled = false;
    }
  }

  /* ═══ Auth ═══════════════════════════════════════════════════ */

  function onUnauthorized() {
    token = '';
    sessionStorage.removeItem('ta_admin');
    cache.clear();
    loaded.clear();
    $('app').classList.remove('is-on');
    $('loginScreen').style.display = '';
    setHealth('down', 'Signed out');
    toast('Session rejected — sign in again.', 'bad');
  }

  async function signIn(password) {
    const err = $('loginError');
    const btn = $('loginBtn');
    err.classList.add('a-hidden');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    token = password;
    try {
      /* The stats call doubles as the auth probe, and its body populates the
         Overview — so a sign-in costs exactly one request. */
      stats = await request('/api/admin/stats', { ttl: 120_000, force: true });
      sessionStorage.setItem('ta_admin', password);
      enterApp();
    } catch (e) {
      token = '';
      err.textContent = e.status === 401 ? 'That password was not accepted.'
        : e.status === 429 ? e.message
        : `Could not reach the backend: ${e.message}`;
      err.classList.remove('a-hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  function enterApp() {
    $('loginScreen').style.display = 'none';
    $('app').classList.add('is-on');
    loaded.add('overview');
    /* Sign-in and session-restore already hold the stats body they authenticated
       with, so Overview paints without a second call. Mock mode arrives here
       with nothing, and fetches. */
    if (stats) renderOverview(); else loadOverview();

    const wanted = location.hash.slice(1);
    if (wanted && wanted !== 'overview' && SECTION_TITLES[wanted]) go(wanted);
  }

  /* ═══ Events ═════════════════════════════════════════════════ */

  function debounce(key, fn, ms = 380) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, ms);
  }

  function wire() {
    $('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const pw = $('adminPassword').value.trim();
      if (pw) signIn(pw);
    });

    document.addEventListener('click', (e) => {
      const nav = e.target.closest('.a-nav-item');
      if (nav) return go(nav.dataset.section);

      const row = e.target.closest('[data-device-id]');
      if (row) return showDevice(row.dataset.deviceId);

      const crash = e.target.closest('[data-crash-hash]');
      if (crash) return showCrash(crash.dataset.crashHash);

      const ctry = e.target.closest('[data-country]');
      if (ctry) return showCountry(ctry.dataset.country);

      const el = e.target.closest('[data-action]');
      if (!el) return;

      switch (el.dataset.action) {
        case 'logout':        onUnauthorized(); break;
        case 'refresh':       refreshCurrent(); break;
        case 'toggle-nav':    $('sidebar').classList.contains('is-open') ? closeNav() : openNav(); break;
        case 'close-nav':     closeNav(); break;
        case 'close-drawer':  closeDrawer(); break;
        case 'dialog-cancel': closeDialog(false); break;
        case 'set-plan':      setPlan(el.dataset.plan); break;
        case 'clear-plan':    clearPlan(); break;
        case 'delete-device': deleteDevice(); break;
        case 'more-events':   loadMoreEvents(); break;
        case 'check-keys':    checkKeys(); break;
        case 'check-limits':  checkLimits(); break;
        case 'unblock':       unblockKey(el.dataset.hash); break;
        case 'publish':       publishUpdate(); break;
        case 'toggle-premium': togglePremium(); break;
        case 'toggle-byok':   toggleByok(); break;
        case 'toggle-gif':    toggleGif(); break;
        case 'toggle-referral': toggleReferral(); break;
        case 'save-free-tokens': saveFreeTokens(); break;
        case 'toggle-gated':  toggleGated(el.dataset.tool); break;
        case 'active-range':  setActiveRange(Number(el.dataset.range)); break;
        case 'toggle-countries': toggleCountries(); break;
        case 'open-readiness':   openReadiness(); break;
        case 'close-readiness':  closeReadiness(); break;
        case 'ready-filter':     setReadyFilter(el.dataset.filter); break;
        case 'ready-toggle':     toggleReady(el.dataset.cc); break;
        case 'page': {
          const p = Number(el.dataset.page);
          if (el.dataset.target === 'dev')   loadDevices(p);
          if (el.dataset.target === 'ai')    loadAiTools(p);
          if (el.dataset.target === 'crash') loadCrashes(p);
          break;
        }
      }
    });

    $('dialogConfirm').addEventListener('click', () => closeDialog(true));

    /* Rows are focusable, so they must also open on Enter/Space. */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('dialog').classList.contains('is-open')) return closeDialog(false);
        /* Above the drawer in the stack, so it closes first if both are open. */
        if ($('readiness').classList.contains('is-open')) return closeReadiness();
        if ($('drawer').classList.contains('is-open')) return closeDrawer();
        closeNav();
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest && e.target.closest('[data-device-id], [data-crash-hash]');
      if (!row) return;
      e.preventDefault();
      if (row.dataset.deviceId) showDevice(row.dataset.deviceId);
      else showCrash(row.dataset.crashHash);
    });

    /* Purely local — the whole country list is already in hand, so filtering
       redraws immediately instead of debouncing toward a request. */
    $('readySearch').addEventListener('input', (e) => {
      readyQuery = e.target.value;
      renderReadiness();
    });

    $('devSearch').addEventListener('input', () => debounce('dev', () => loadDevices(1)));
    $('devFilter').addEventListener('change',  () => loadDevices(1));
    $('devCountry').addEventListener('change', () => loadDevices(1));
    $('devSort').addEventListener('change',    () => loadDevices(1));
    $('aiSearch').addEventListener('input',   () => debounce('ai', () => loadAiTools(1)));
    $('aiSort').addEventListener('change',    () => loadAiTools(1));
    $('crashSearch').addEventListener('input', () => debounce('crash', () => loadCrashes(1)));
    $('crashSort').addEventListener('change',  () => loadCrashes(1));
  }

  /* ═══ Boot ═══════════════════════════════════════════════════ */

  async function boot() {
    wire();

    if (MOCK) {
      /* Dev-only: fixtures so the console can be built and reviewed without the
         backend, which only accepts calls from the production origin anyway.
         Loaded exclusively when ?mock=1 is present. */
      try {
        mock = await import('./admin-mock.js').then(m => m.default);
        token = 'mock';
        enterApp();
        setHealth('warn', 'Mock data');
        toast('Mock mode — no backend calls.', 'info');
        return;
      } catch {
        toast('Mock fixtures failed to load.', 'bad');
      }
    }

    /* A refresh shouldn't cost a fresh sign-in (and another request). */
    const saved = sessionStorage.getItem('ta_admin');
    if (saved) {
      token = saved;
      request('/api/admin/stats', { ttl: 120_000 })
        .then((data) => { stats = data; enterApp(); })
        .catch(() => { token = ''; sessionStorage.removeItem('ta_admin'); });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
