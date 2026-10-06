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
    ask:      'Ask AI',
    devices:  'Devices',
    aitools:  'AI usage',
    apikeys:  'API keys',
    crashes:  'Crashes',
    referrals: 'Referrals',
    releases: 'Releases & config',
  };

  /* One line under the topbar title, so each view says what it is for. */
  const SECTION_DESCS = {
    overview: 'Installs, activity and AI spend across every device',
    ask:      'Plain-language questions, answered with read-only queries on live data',
    devices:  'Every install, its plan and how it is used. Click a row for details.',
    aitools:  'Which AI features each device leans on',
    apikeys:  'Groq and OpenRouter key health, limits and spend',
    crashes:  'Crash reports from the app and the keyboard, grouped by cause',
    referrals: 'Invite funnel, top referrers and program settings',
    releases: 'Publish app updates and change remote config',
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
  let config = { premium_enabled: false, byok_enabled: true, gif_enabled: true, gated_tools: [],
                 ai_provider: 'groq', ai_fallback: true };
  let keyHealth = [];                  // from check-keys
  let keyLimits = [];                  // from key-limits
  let orHealth  = undefined;           // check-keys' `openrouter`: undefined = not run, null = no key

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

  /* '3 h ago' for anything inside a week, a date after that. */
  function fmtAgo(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(+d)) return '—';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 0)      return fmtDate(iso);
    if (s < 60)     return 'just now';
    if (s < 3600)   return `${Math.floor(s / 60)} min ago`;
    if (s < 86400)  return `${Math.floor(s / 3600)} h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)} d ago`;
    return fmtDate(iso);
  }

  const pct = (part, whole, digits = 1) =>
    (whole ? `${((part / whole) * 100).toFixed(digits)}%` : '—');

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
    if (legacyByok) flags.push('<span class="a-plan a-plan-byok" title="Legacy BYOK key stored">BYOK</span>');

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
    $('dialog').classList.toggle('is-danger', danger);
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

      if (res.status === 401) { onUnauthorized(); throw new ApiError('Session rejected. Sign in again.', 401); }
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
     no-CDN page shouldn't start.

     Every chart is drawn at its container's real pixel width, so axis text is
     always 11px and lines are always 2px. (A fixed viewBox scaled to the card
     made the type grow and shrink with the window.) mountChart() remembers
     how to redraw each host, and one ResizeObserver redraws it whenever its
     width changes, including the first time a hidden section is shown. The
     data is already in hand, so a redraw never costs a request. */

  const chartDraws = new Map();        // host element → draw()
  let chartRO = null;

  function mountChart(host, draw) {
    if (!host) return;
    for (const h of chartDraws.keys()) {
      if (!h.isConnected) { chartDraws.delete(h); if (chartRO) chartRO.unobserve(h); }
    }
    chartDraws.set(host, draw);
    if (!chartRO && 'ResizeObserver' in window) {
      chartRO = new ResizeObserver((entries) => {
        for (const e of entries) {
          const w = Math.round(e.contentRect.width);
          if (!w || String(w) === e.target.dataset.drawnW) continue;
          const fn = chartDraws.get(e.target);
          if (fn) fn();
        }
      });
    }
    if (chartRO) chartRO.observe(host);
    draw();
  }

  /* The width to draw at. A hidden host reports 0: draw at a fallback and
     leave drawnW blank, so the observer redraws once it is shown. */
  function chartWidth(host) {
    const w = Math.round(host.clientWidth);
    host.dataset.drawnW = w ? String(w) : '';
    return w || 640;
  }

  /* Round axis steps (1, 2, 2.5, 5 × 10ⁿ) aiming for about four intervals.
     Integer series never get a fractional step: "2.5 devices" is not a tick. */
  function niceScale(maxVal, { target = 4, integer = false } = {}) {
    if (!maxVal || maxVal <= 0) return { top: target, step: 1 };
    const raw  = maxVal / target;
    const mag  = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    if (integer) step = Math.max(1, Math.ceil(step));
    return { top: Math.ceil(maxVal / step - 1e-9) * step, step };
  }

  function yAxis(top, step, y, padL, right) {
    let grid = '', labels = '';
    for (let v = 0; v <= top + step / 1000; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      grid   += `<line class="a-grid-line" x1="${padL}" y1="${yy}" x2="${right}" y2="${yy}"/>`;
      labels += `<text class="a-axis-text" x="${padL - 10}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(fmt(v))}</text>`;
    }
    return { grid, labels };
  }

  /* Date labels spaced by the room actually available, counted back from the
     newest day so today is always labelled. */
  function xAxis(data, toX, plotW, W, padL, padR, baseY) {
    const n = data.length;
    const maxLabels = Math.max(2, Math.floor(plotW / 78));
    const every = Math.max(1, Math.ceil((n - 1) / (maxLabels - 1)));
    let out = '';
    for (let i = n - 1; i >= 0; i -= every) {
      const x = toX(i);
      const anchor = x - 22 < padL ? 'start' : x + 22 > W - padR ? 'end' : 'middle';
      out += `<text class="a-axis-text" x="${x.toFixed(1)}" y="${baseY}" text-anchor="${anchor}">${esc(fmtDayLabel(data[i].date))}</text>`;
    }
    return out;
  }

  function emptyChart(host, message) {
    host.dataset.drawnW = '';
    host.innerHTML = `<div class="a-chart-empty">${esc(message)}</div>`;
  }

  /**
   * Line + area chart over a dated series.
   * @param {HTMLElement} host  a .a-chart-wrap (or a KPI spark strip)
   * @param {Array<{date:string, value:number}>} data oldest → newest
   */
  function lineChart(host, data, opts = {}) {
    mountChart(host, () => drawLine(host, data, opts));
  }

  function drawLine(host, data, { color = C1, compact = false, label = 'value' } = {}) {
    if (!data || !data.length) {
      if (compact) { host.dataset.drawnW = ''; host.innerHTML = ''; return; }
      return emptyChart(host, 'No data for this period yet.');
    }

    const W = chartWidth(host);
    const H = compact ? (host.clientHeight || 46) - 12 : 232;
    const padL = compact ? 2 : 44;
    const padR = compact ? 4 : 8;
    const padT = compact ? 5 : 10;
    const padB = compact ? 3 : 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxV = Math.max(...data.map(d => d.value), 0);
    const { top, step } = compact
      ? { top: maxV || 1, step: maxV || 1 }
      : niceScale(maxV, { integer: maxV >= 4 });
    const x = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const y = (v) => padT + plotH - (v / top) * plotH;

    const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(data.length - 1).toFixed(1)} ${padT + plotH} L${x(0).toFixed(1)} ${padT + plotH} Z`;
    const gid  = `g${Math.random().toString(36).slice(2, 8)}`;

    const axes = compact ? { grid: '', labels: '' } : yAxis(top, step, y, padL, W - padR);
    const xLabels = compact ? '' : xAxis(data, x, plotW, W, padL, padR, H - 8);

    const last = data[data.length - 1];
    /* The compact form is a sparkline inside a KPI tile: it gives the headline
       number a shape and carries no hover layer. The same series is fully
       explorable, with crosshair and tooltip, in the panel below. */
    const interactive = !compact;

    host.innerHTML = `
      <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="${esc(label)} over the last ${data.length} days, from ${esc(fmtDayLabel(data[0].date))} to ${esc(fmtDayLabel(last.date))}">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="${color}" stop-opacity="${compact ? 0.22 : 0.2}"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${axes.grid}
        <path d="${area}" fill="url(#${gid})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        ${axes.labels}${xLabels}
        <circle cx="${x(data.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="${compact ? 3 : 4}"
                fill="${color}" stroke="var(--a-surface)" stroke-width="2"/>
        ${interactive ? `
          <line class="a-crosshair" id="${gid}-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}"/>
          <circle id="${gid}-dot" r="4.5" fill="${color}" stroke="var(--a-surface)" stroke-width="2" opacity="0"/>
          <rect class="a-hot" x="${padL}" y="0" width="${plotW}" height="${padT + plotH}"/>` : ''}
      </svg>
      ${interactive ? '<div class="a-tooltip"><span class="a-tooltip-date"></span><span class="a-tooltip-val"></span></div>' : ''}`;

    if (!interactive) return;

    attachHover(host, data, {
      count: data.length,
      toX: x, toY: (d) => y(d.value),
      viewW: W,
      cross: $(`${gid}-cross`), dot: $(`${gid}-dot`),
      label,
    });
  }

  /** Vertical bar chart over a dated series. */
  function barChart(host, data, opts = {}) {
    mountChart(host, () => drawBars(host, data, opts));
  }

  function drawBars(host, data, { color = C2, label = 'value' } = {}) {
    if (!data || !data.length) return emptyChart(host, 'No data for this period yet.');
    if (!data.some(d => d.value > 0)) return emptyChart(host, 'Nothing recorded in this period.');

    const W = chartWidth(host);
    const H = 232, padL = 44, padR = 8, padT = 10, padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxV = Math.max(...data.map(d => d.value), 0);
    const { top, step } = niceScale(maxV, { integer: true });
    const slot = plotW / data.length;
    /* Thin marks: capped at 24px and never the whole slot, so the band's
       leftover reads as air rather than a wall of colour. */
    const bw   = Math.max(2, Math.min(24, slot * 0.66, slot - 2));
    const x    = (i) => padL + i * slot + (slot - bw) / 2;
    const y    = (v) => padT + plotH - (v / top) * plotH;
    const base = padT + plotH;

    const axes = yAxis(top, step, y, padL, W - padR);
    const xLabels = xAxis(data, (i) => x(i) + bw / 2, plotW, W, padL, padR, H - 8);

    /* 4px rounded data end, square at the baseline. */
    const bars = data.map((d, i) => {
      const h = d.value > 0 ? Math.max(2, base - y(d.value)) : 0;
      if (!h) return '';
      const x0 = x(i), y0 = base - h, r = Math.min(4, bw / 2, h);
      return `<path class="a-bar" data-i="${i}" fill="${color}" d="M${x0.toFixed(1)} ${base} V${(y0 + r).toFixed(1)} `
        + `Q${x0.toFixed(1)} ${y0.toFixed(1)} ${(x0 + r).toFixed(1)} ${y0.toFixed(1)} H${(x0 + bw - r).toFixed(1)} `
        + `Q${(x0 + bw).toFixed(1)} ${y0.toFixed(1)} ${(x0 + bw).toFixed(1)} ${(y0 + r).toFixed(1)} V${base} Z"/>`;
    }).join('');

    host.innerHTML = `
      <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} per day">
        ${axes.grid}<g class="a-bars">${bars}</g>${axes.labels}${xLabels}
        <rect class="a-hot" x="${padL}" y="0" width="${plotW}" height="${base}"/>
      </svg>
      <div class="a-tooltip"><span class="a-tooltip-date"></span><span class="a-tooltip-val"></span></div>`;

    attachHover(host, data, {
      count: data.length,
      toX: (i) => x(i) + bw / 2,
      toY: (d) => y(d.value),
      viewW: W,
      cross: null, dot: null,
      bars: host.querySelector('.a-bars'),
      label,
    });
  }

  /* Shared hover behaviour for the dated charts: nearest point by x, a
     crosshair or a highlighted bar, and a tooltip kept inside the card. */
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
      if (cfg.bars) {
        cfg.bars.classList.add('is-hover');
        cfg.bars.querySelectorAll('.a-bar').forEach(b => b.classList.toggle('is-on', Number(b.dataset.i) === best));
      }

      tip.querySelector('.a-tooltip-date').textContent = fmtDayLabel(point.date);
      tip.querySelector('.a-tooltip-val').textContent  = `${fmtFull(point.value)} ${cfg.label}`;
      tip.classList.add('is-on');
      /* The card clips its overflow, so a tooltip for a point near the top
         drops below the point instead of disappearing under the header. */
      tip.classList.toggle('is-below', py < tip.offsetHeight + 16);
      const half = tip.offsetWidth / 2 + 4;
      const left = Math.min(Math.max(px * (box.width / cfg.viewW), half), box.width - half);
      tip.style.left = `${left}px`;
      tip.style.top  = `${py}px`;
    };

    const hide = () => {
      if (cfg.cross) cfg.cross.classList.remove('is-on');
      if (cfg.dot)   cfg.dot.setAttribute('opacity', '0');
      if (cfg.bars) {
        cfg.bars.classList.remove('is-hover');
        cfg.bars.querySelectorAll('.a-bar.is-on').forEach(b => b.classList.remove('is-on'));
      }
      tip.classList.remove('is-on');
    };

    hot.addEventListener('pointermove', show);
    hot.addEventListener('pointerenter', show);
    hot.addEventListener('pointerleave', hide);
  }

  /* Plan mix: the paid headline, a 100% bar on the ordinal ramp, and one row
     per tier. Replaces a donut whose 3% Max slice was a sliver nobody could
     read. Free → Pro → Max is ordered, so the ramp, not categorical hues. */
  function planMix(host, mix) {
    const rows = [
      { label: 'Free', value: mix.free || 0, color: ORD[0] },
      { label: 'Pro',  value: mix.pro  || 0, color: ORD[1] },
      { label: 'Max',  value: mix.max  || 0, color: ORD[2] },
    ];
    const total = rows.reduce((s, r) => s + r.value, 0);
    if (!total) return emptyChart(host, 'No devices yet.');
    const paid = rows[1].value + rows[2].value;

    host.innerHTML = `
      <div class="a-plans">
        <div class="a-plans-head">
          <div><div class="a-plans-big">${esc(fmtFull(paid))}</div><div class="a-plans-cap">paid devices</div></div>
          <div><div class="a-plans-big">${esc(pct(paid, total))}</div><div class="a-plans-cap">of all installs</div></div>
        </div>
        <div class="a-segbar" role="img" aria-label="${esc(rows.map(r => `${r.label} ${pct(r.value, total)}`).join(', '))}">
          ${rows.filter(r => r.value > 0).map(r =>
            `<span style="flex-grow:${r.value};background:${r.color}" title="${esc(`${r.label}: ${fmtFull(r.value)}`)}"></span>`).join('')}
        </div>
        <div class="a-plans-rows">
          ${rows.map(r => `
            <div class="a-plans-row">
              <span class="a-legend-swatch" style="background:${r.color}"></span>
              <span class="a-plans-name">${esc(r.label)}</span>
              <span class="a-plans-num">${esc(fmtFull(r.value))}</span>
              <span class="a-plans-pct">${esc(pct(r.value, total))}</span>
            </div>`).join('')}
        </div>
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

    $('k-total').textContent  = fmtFull(stats.total_users);
    $('k-dau').textContent    = fmtFull(stats.dau);
    $('k-mau').textContent    = fmtFull(stats.mau);
    /* Headline and sparkline must be the same measure, so this tile is the
       30-day token sum its sparkline draws, not a lifetime count. */
    $('k-tokens').textContent = fmt(tokens30);

    const newInstalls = stats.new_installs_7d || 0;
    $('k-total-foot').innerHTML =
      `<span class="a-delta ${newInstalls ? 'is-up' : 'is-flat'}">+${esc(fmtFull(newInstalls))}</span> in the last 7 days`;
    /* DAU/MAU is the stickiness ratio: how much of the monthly base comes back
       on a given day. */
    $('k-dau-foot').innerHTML = stats.mau
      ? `<b>${esc(pct(stats.dau, stats.mau, 0))}</b> of monthly active`
      : '';
    $('k-mau-foot').innerHTML = [
      stats.total_users ? `<b>${esc(pct(stats.mau, stats.total_users))}</b> of installs` : '',
      stats.wau != null ? `<b>${esc(fmtFull(stats.wau))}</b> weekly` : '',
    ].filter(Boolean).join(' · ');
    $('k-tokens-foot').innerHTML = tokens.length
      ? `<b>${esc(fmt(Math.round(tokens30 / tokens.length)))}</b> per day on average`
      : '';

    renderActiveChart();
    /* The sparkline always shows the full window — it's the tile's shape, not a
       view the operator steers, so the range toggle below doesn't move it. */
    lineChart($('k-dau-spark'), active, { color: C1, compact: true, label: 'devices' });
    barChart($('chartTokens'), tokens, { color: C2, label: 'tokens' });
    lineChart($('k-tokens-spark'), tokens, { color: C2, compact: true, label: 'tokens' });

    planMix($('chartPlans'), stats.plan_mix || {});
    renderEngagement();

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

  /* All-time engagement: the two open counters, then AI requests split by
     feature. The bars wear the same per-feature colours as the AI usage
     table, so a feature keeps one colour across the whole console. */
  function renderEngagement() {
    const host = $('engagePanel');
    if (!host || !stats) return;
    const tools = TOOLS.map(t => ({ ...t, value: stats[t.key] || 0 }));
    const total = tools.reduce((s, t) => s + t.value, 0);
    const max   = Math.max(...tools.map(t => t.value), 1);

    host.innerHTML = `
      <div class="a-engage">
        <div class="a-engage-top">
          <div><span class="a-engage-label">Keyboard opens</span><span class="a-engage-val">${esc(fmt(stats.total_keyboard_opens || 0))}</span></div>
          <div><span class="a-engage-label">App opens</span><span class="a-engage-val">${esc(fmt(stats.total_app_opens || 0))}</span></div>
        </div>
        <div class="a-engage-sub"><span>AI requests by feature</span><span>${esc(fmtFull(total))} total</span></div>
        <div class="a-barlist">
          ${tools.map(t => `
            <div class="a-barlist-row" title="${esc(`${t.label}: ${fmtFull(t.value)}`)}">
              <span class="a-barlist-key"><span class="a-legend-swatch" style="background:${t.color}"></span>${esc(t.label)}</span>
              <span class="a-barlist-track"><span class="a-barlist-fill" style="width:${((t.value / max) * 100).toFixed(1)}%;background:${t.color}"></span></span>
              <span class="a-barlist-val">${esc(fmt(t.value))}<small>${esc(pct(t.value, total, 0))}</small></span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  /* How many country rows the panel shows before the "Show all" toggle. The
     list itself is never truncated server-side — a market with one device is
     exactly the row you don't want silently dropped. */
  const COUNTRY_PREVIEW = 10;
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
      host.innerHTML = '<div class="a-chart-empty">No country data yet. It is stamped on a device’s next ping.</div>';
      return;
    }

    /* Bars scale against the top country, not the total, so a long tail after
       one dominant market stays readable. */
    const max   = Math.max(...rows.map(r => r.users), 1);
    const shown = rows.reduce((n, r) => n + r.users, 0);
    const live  = rows.reduce((n, r) => n + (r.active_7d || 0), 0);

    const visible = countriesExpanded ? rows : rows.slice(0, COUNTRY_PREVIEW);

    /* Each bar is split active-7d / dormant rather than showing one lifetime
       total. A country's device count on its own says only "we were installed
       there once" — the split is what distinguishes a live market from a single
       device that ran the app one afternoon and never came back (which is what
       a VPN exit, a store crawler or a review device looks like). */

    const body = visible.map(r => {
      const users = r.users || 0;
      const act   = Math.min(r.active_7d || 0, users);
      const name  = regionName(r.country);
      return `
        <tr class="is-clickable" data-country="${esc(r.country)}" tabindex="0"
            title="${esc(`Show devices in ${name}`)}">
          <td class="a-primary-cell"><span class="a-cc">${esc(r.country)}</span>${esc(name)}</td>
          <td class="a-right a-num">${esc(fmtFull(users))}</td>
          <td class="a-right a-num">${esc(fmtFull(act))}<small>${esc(pct(act, users, 0))}</small></td>
          <td class="a-col-bar">
            <span class="a-barlist-track is-split" aria-hidden="true">
              <span class="a-barlist-fill" style="width:${((act / max) * 100).toFixed(1)}%"></span>
              <span class="a-barlist-fill is-dim" style="width:${(((users - act) / max) * 100).toFixed(1)}%"></span>
            </span>
          </td>
          <td class="a-right a-num">${esc(fmtFull(r.kb_opens || 0))}</td>
          <td class="a-right a-num">${esc(fmtFull(r.ai_uses || 0))}</td>
        </tr>`;
    }).join('');

    host.innerHTML = `
      <div class="a-table-scroll">
        <table class="a-table">
          <thead><tr>
            <th>Country</th><th class="a-right">Devices</th><th class="a-right">Active 7d</th>
            <th class="a-col-bar">Activity</th><th class="a-right">Keyboard opens</th><th class="a-right">AI uses</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="a-panel-foot">
        <div class="a-legend">
          <span class="a-legend-item"><span class="a-legend-swatch" style="background:${C1}"></span>Active in 7d</span>
          <span class="a-legend-item"><span class="a-legend-swatch a-swatch-dim"></span>Dormant</span>
          ${stats.countries_pending
            ? `<span class="a-legend-item a-muted" title="${esc(`${fmtFull(stats.countries_pending)} device(s) have not pinged since country tracking shipped, so they carry no country yet. This table covers the ${fmtFull(shown)} reported so far; ${fmtFull(live)} of them were active in the last 7 days.`)}">${icon('info')}${esc(fmtFull(stats.countries_pending))} without a country yet</span>`
            : ''}
        </div>
        ${rows.length > COUNTRY_PREVIEW ? `
        <button type="button" class="a-btn a-btn-ghost a-btn-sm" data-action="toggle-countries"
                aria-expanded="${countriesExpanded}" style="margin-left:auto">
          ${countriesExpanded
            ? `Show top ${COUNTRY_PREVIEW}`
            : `Show all ${esc(fmtFull(rows.length))} countries`}
        </button>` : ''}
      </div>`;
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

  /* First load of a table draws a skeleton. A refetch (filter, sort, page)
     keeps the rows already on screen, dimmed, until the new ones land, so the
     layout never jumps. `filled` marks a body that holds real rows. */
  function skeleton(tbody, cols, rows = 8) {
    if (tbody.dataset.filled === '1') { tbody.classList.add('is-stale'); return; }
    tbody.innerHTML = Array.from({ length: rows }, () =>
      `<tr class="a-skel-row">${Array.from({ length: cols }, (_, i) =>
        `<td><span class="a-skel" style="width:${[70, 45, 35, 40, 60, 60, 30, 30, 45, 35, 40][i] || 50}%"></span></td>`).join('')}</tr>`
    ).join('');
  }

  function fillBody(tbody, html) {
    tbody.classList.remove('is-stale');
    tbody.dataset.filled = '1';
    tbody.innerHTML = html;
  }

  function stateRow(tbody, cols, message, isError = false) {
    tbody.classList.remove('is-stale');
    tbody.dataset.filled = '';
    tbody.innerHTML = `<tr class="a-state-row${isError ? ' is-error' : ''}"><td colspan="${cols}">${esc(message)}</td></tr>`;
  }

  const DEV_COLS = 11;

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
    skeleton(tbody, DEV_COLS);

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
      stateRow(tbody, DEV_COLS, e.message, true);
      $('devPager').innerHTML = '';
    }
  }

  /* One column for the keyboard funnel instead of two Yes/No columns:
     set as default, enabled but not default, or not set up. */
  function keyboardStatus(d) {
    if (d.keyboard_selected) return '<span class="a-status is-ok">Default</span>';
    if (d.keyboard_enabled)  return '<span class="a-status is-warn">Enabled</span>';
    return '<span class="a-status is-off">Not set up</span>';
  }

  function renderDevices(devices) {
    const tbody = $('devBody');
    if (!devices.length) return stateRow(tbody, DEV_COLS, 'No devices match these filters.');

    fillBody(tbody, devices.map(d => `
      <tr class="is-clickable" data-device-id="${esc(d.device_id)}" tabindex="0">
        <td class="a-primary-cell">
          <span class="a-cell-title">${esc(d.device_name || 'Unknown')}</span>
          <span class="a-cell-sub a-mono">${esc(d.device_id)}</span>
        </td>
        <td>${planBadge(d)}</td>
        <td${d.country ? ` title="${esc(regionName(d.country))}"` : ''}>${d.country ? `<span class="a-cc">${esc(d.country)}</span>` : '<span class="a-muted">—</span>'}</td>
        <td class="a-num">${esc(d.android_version || '—')}</td>
        <td>${esc(fmtDate(d.install_date))}</td>
        <td title="${esc(fmtDateTime(d.last_use_date))}">${esc(fmtDate(d.last_use_date))}</td>
        <td class="a-right a-num">${esc(fmtFull(d.total_app_opens || 0))}</td>
        <td class="a-right a-num">${esc(fmtFull(d.total_keyboard_opens || 0))}</td>
        <td class="a-right a-num">${esc(fmt(d.total_ai_tokens || 0))}</td>
        <td>${keyboardStatus(d)}</td>
        <td>${esc(d.selected_theme || '—')}</td>
      </tr>`).join(''));
  }

  function renderPager(host, p, target) {
    if (!p) { host.innerHTML = ''; return; }
    const total = p.total || 0;
    const limit = p.limit || 50;
    const pages = p.total_pages || 1;
    const from  = total ? (p.page - 1) * limit + 1 : 0;
    const to    = Math.min(p.page * limit, total);
    host.innerHTML = `
      <span class="a-pager-info">Showing <b>${fmtFull(from)}–${fmtFull(to)}</b> of <b>${fmtFull(total)}</b></span>
      <span class="a-pager-pages">Page ${p.page} of ${pages}</span>
      <div class="a-pager-btns">
        <button class="a-icon-btn a-icon-btn-sm" data-action="page" data-target="${target}" data-page="${p.page - 1}"
                aria-label="Previous page" ${p.page <= 1 ? 'disabled' : ''}>${icon('chevron-left')}</button>
        <button class="a-icon-btn a-icon-btn-sm" data-action="page" data-target="${target}" data-page="${p.page + 1}"
                aria-label="Next page" ${p.page >= pages ? 'disabled' : ''}>${icon('chevron-right')}</button>
      </div>`;
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
    $('drawerMeta').innerHTML  = '';
    $('drawerBody').innerHTML  = bodyHtml;
    $('drawerBody').scrollTop  = 0;
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

  const copyBtn = (text, what) =>
    `<button class="a-icon-btn a-icon-btn-sm a-icon-btn-quiet" data-action="copy" data-copy="${esc(text)}"
             aria-label="Copy ${esc(what)}" title="Copy ${esc(what)}">${icon('copy')}</button>`;

  function drawerSection(title, inner, extraHead = '') {
    return `<section class="a-dsec">
      <div class="a-dsec-head"><h3>${esc(title)}</h3>${extraHead}</div>
      ${inner}
    </section>`;
  }

  const kvList = (rows) =>
    `<dl class="a-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  function metricCells(cells, compact = true) {
    return `<div class="a-metrics${compact ? ' is-compact' : ''}" style="--n:${cells.length}">
      ${cells.map(([label, value, title]) => `
        <div class="a-metric"${title ? ` title="${esc(title)}"` : ''}>
          <span class="a-metric-label">${esc(label)}</span>
          <span class="a-metric-value">${value}</span>
        </div>`).join('')}
    </div>`;
  }

  function setDrawerTab(name) {
    $$('#drawerBody .a-tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('#drawerBody .a-tabpanel').forEach(p => p.classList.toggle('a-hidden', p.dataset.panel !== name));
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
    $('drawerMeta').innerHTML  = `<span class="a-mono">${esc(d.device_id)}</span>${copyBtn(d.device_id, 'device ID')}`
      + (d.country ? `<span>·</span><span>${esc(regionName(d.country))}</span>` : '')
      + (d.android_version ? `<span>·</span><span>Android ${esc(d.android_version)}</span>` : '');

    const tier      = effectiveTier(d);
    const paidValid = isPaidValid(d);
    const priorInstalls = Array.isArray(d.merged_device_ids) ? d.merged_device_ids.length : 0;
    const budget = { free: config.free_daily_tokens ?? 10000, pro: 50000, max: 150000 }[tier];

    const summary = metricCells([
      ['Last active',     esc(fmtAgo(d.last_use_date)), fmtDateTime(d.last_use_date)],
      ['Lifetime tokens', esc(fmt(d.total_ai_tokens || 0)), fmtFull(d.total_ai_tokens || 0)],
      ['Keyboard opens',  esc(fmt(d.total_keyboard_opens || 0)), fmtFull(d.total_keyboard_opens || 0)],
      ['App opens',       esc(fmt(d.total_app_opens || 0)), fmtFull(d.total_app_opens || 0)],
    ]);

    const planRows = [
      ['Effective tier',  `${TIER_LABEL[tier]} <span class="a-muted">· ${esc(fmtFull(budget))} tokens/day</span>`],
      ['Self-reported',   esc(d.plan_tier || 'free')],
      ['Purchased tier',  d.paid_tier ? `${esc(TIER_LABEL[normTier(d.paid_tier)] || d.paid_tier)}${paidValid ? '' : ' <span class="a-muted">· expired</span>'}` : '—'],
      ['Purchased plan',  esc(d.premium_plan || '—')],
      ['Paid since',      esc(d.premium_since ? fmtDateTime(d.premium_since) : '—')],
      ['Paid until',      d.premium_until ? `${esc(fmtDateTime(d.premium_until))}${paidValid ? '' : ' <span class="a-error-text">· expired</span>'}` : '—'],
      ['Recovery code',   d.recovery_code ? `<span class="a-mono">${esc(d.recovery_code)}</span>` : '—'],
      ['Restored from',   d.premium_restored_from ? `<span class="a-mono">${esc(d.premium_restored_from)}</span> <span class="a-muted">· ${esc(fmtDate(d.premium_restored_at))}</span>` : '—'],
      ['Admin override',  d.admin_plan_override ? `${esc(d.admin_plan_override)} <span class="a-muted">· set ${esc(fmtDateTime(d.admin_plan_override_at))}</span>` : '—'],
    ];

    const deviceRows = [
      ['Country',          d.country ? `${esc(regionName(d.country))} <span class="a-muted">${esc(d.country)}</span>` : '—'],
      ['Android',          esc(d.android_version || '—')],
      ['First seen',       esc(fmtDateTime(d.created_at || d.install_date))],
      ['Install date',     esc(fmtDate(d.install_date))],
      ['Last active',      esc(fmtDateTime(d.last_use_date))],
      ['Prior installs',   priorInstalls ? `${priorInstalls} <span class="a-muted">· merged on reinstall</span>` : '—'],
      ['Keyboard',         keyboardStatus(d)],
      ['Theme',            esc(d.selected_theme || '—')],
    ];

    /* Same per-feature colours as the AI usage table and the Overview card. */
    const toolMax = Math.max(...TOOLS.map(t => d[t.key] || 0), 1);
    const usage = `<div class="a-barlist">${TOOLS.map(t => {
      const v = d[t.key] || 0;
      return `<div class="a-barlist-row">
        <span class="a-barlist-key"><span class="a-legend-swatch" style="background:${t.color}"></span>${esc(t.label)}</span>
        <span class="a-barlist-track"><span class="a-barlist-fill" style="width:${((v / toolMax) * 100).toFixed(1)}%;background:${t.color}"></span></span>
        <span class="a-barlist-val">${esc(fmtFull(v))}</span>
      </div>`;
    }).join('')}</div>`;

    const planControl = `
      <p>Sets an admin override, applied on the device's next analytics ping. An override outranks the
         app's self-reported tier. Setting Free while a purchase is still valid does <em>not</em> lower the
         budget: the server keeps honouring the paid tier until it expires.</p>
      <div class="a-actions">
        <div class="a-seg" role="group" aria-label="Set plan">
          ${['free', 'pro', 'max'].map(p => `
            <button type="button" class="a-seg-btn${tier === p ? ' is-active' : ''}" data-action="set-plan" data-plan="${p}"
                    aria-pressed="${tier === p}">${TIER_LABEL[p]}</button>`).join('')}
        </div>
        ${d.admin_plan_override ? '<button class="a-btn a-btn-ghost a-btn-sm" data-action="clear-plan">Clear override</button>' : ''}
        <span class="a-action-status" id="planStatus"></span>
      </div>`;

    const danger = `<div class="a-danger">
      <h3>Delete all user data</h3>
      <p>Permanently deletes device records (plan, premium expiry, recovery code, daily token counters),
         events, crashes and payment records, including every reinstall on the same hardware.
         This cannot be undone.</p>
      <div class="a-actions">
        <button class="a-btn a-btn-danger a-btn-sm" data-action="delete-device">${icon('trash')}Delete permanently</button>
        <span class="a-action-status" id="deleteStatus"></span>
      </div>
    </div>`;

    const loaded = events ? events.length : 0;
    const total  = pg && Number.isFinite(pg.total) ? pg.total : loaded;

    let activity;
    if (loaded) {
      drawerEvents = { page: (pg && pg.page) || 1, loaded, total, busy: false };
      activity = `<section class="a-dsec">
        <div class="a-dsec-head"><h3>Activity</h3>
          <span class="a-muted"><span id="eventsCount">${fmtFull(loaded)}</span> of ${fmtFull(total)} events</span></div>
        <div class="a-events" id="eventsList">${events.map(eventRow).join('')}</div>
        <div class="a-actions a-events-more" id="eventsMore">${moreEventsBtn(loaded, total)}</div>
      </section>`;
    } else {
      activity = '<div class="a-empty">' + icon('inbox') + '<p>No events recorded for this device.</p></div>';
    }

    $('drawerBody').innerHTML = `
      <div class="a-tabs" role="tablist">
        <button class="a-tab" role="tab" data-action="drawer-tab" data-tab="details" aria-selected="true">Details</button>
        <button class="a-tab" role="tab" data-action="drawer-tab" data-tab="activity" aria-selected="false">
          Activity <span class="a-tab-count">${esc(fmt(total))}</span></button>
      </div>
      <div class="a-tabpanel" data-panel="details">
        <section class="a-dsec">${summary}</section>
        ${drawerSection('Plan & billing', kvList(planRows))}
        ${drawerSection('Change plan', planControl)}
        ${drawerSection('Device', kvList(deviceRows))}
        ${drawerSection('AI usage', usage)}
        <section class="a-dsec">${danger}</section>
      </div>
      <div class="a-tabpanel a-hidden" data-panel="activity">${activity}</div>`;
  }

  function eventRow(e) {
    return `<div class="a-event">
      <span class="a-event-type">${esc(e.event_type)}</span>
      ${e.metadata ? `<span class="a-event-meta">${esc(e.metadata)}</span>` : ''}
      <span class="a-event-time" title="${esc(fmtDateTime(e.timestamp))}">${esc(fmtDateTime(e.timestamp))}</span>
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
      'This removes the device records, events, crashes and payment records for this user, including every reinstall on the same hardware.\n\nThis cannot be undone.',
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

  /* Identity rides the swatch; the label stays in text ink, never the series
     colour (a light hue as text fails contrast on this surface). */
  function topTool(d) {
    let best = null, bestVal = 0;
    for (const t of TOOLS) {
      const v = d[t.key] || 0;
      if (v > bestVal) { bestVal = v; best = t; }
    }
    return best
      ? `<span class="a-legend-item"><span class="a-legend-swatch" style="background:${best.color}"></span>${esc(best.label)}</span>`
      : '<span class="a-muted">—</span>';
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

      fillBody(tbody, devices.map(d => `
        <tr class="is-clickable" data-device-id="${esc(d.device_id)}" tabindex="0">
          <td class="a-primary-cell">
            <span class="a-cell-title">${esc(d.device_name || 'Unknown')}</span>
            <span class="a-cell-sub a-mono">${esc(d.device_id)}</span>
          </td>
          ${TOOLS.map(t => cellBar(d[t.key] || 0, maxes[t.key], t.color)).join('')}
          <td>${topTool(d)}</td>
          <td class="a-right a-num">${esc(fmtFull(TOOLS.reduce((s, t) => s + (d[t.key] || 0), 0)))}</td>
        </tr>`).join(''));

      renderPager($('aiPager'), data.pagination, 'ai');
    } catch (e) {
      stateRow(tbody, 7, e.message, true);
      $('aiPager').innerHTML = '';
    }
  }

  /* ═══ API keys ═══════════════════════════════════════════════
     Health (check-keys) and limit status (key-limits) are separate endpoints —
     both live-ping Groq and are slow — but they describe the same keys, so they
     render into one row per key. */

  function renderKeys() {
    const body = $('keyBody');
    const byIndex = new Map();
    for (const k of keyHealth) byIndex.set(k.index, { ...byIndex.get(k.index), ...k });
    for (const k of keyLimits) byIndex.set(k.index, { ...byIndex.get(k.index), ...k, limitStatus: k.status });

    const keys = [...byIndex.values()].sort((a, b) => a.index - b.index);

    const working = keyHealth.filter(k => k.status === 'working' || k.status === 'ratelimit').length;
    const failed  = keyHealth.filter(k => k.status === 'failed').length;
    const blocked = keyLimits.filter(k => k.status === 'blocked').length;
    const checked = keyHealth.length > 0;
    const last    = keyHealth.map(k => k.checkedAt).filter(Boolean).sort().pop();

    const cell = (label, value, state, sub) => `
      <div class="a-metric">
        <span class="a-metric-label">${esc(label)}</span>
        <span class="a-metric-value${state ? ` is-${state}` : ''}">${value}</span>
        ${sub ? `<span class="a-metric-sub">${esc(sub)}</span>` : ''}
      </div>`;
    $('keySummary').innerHTML =
      cell('Keys configured', esc(fmtFull(keys.length)), '', keyLimits.length ? 'From the rate-limit ledger' : '')
      + cell('Working', checked ? `${icon('check')}${esc(fmtFull(working))}` : '—', checked ? 'ok' : '',
             checked ? `Checked ${fmtTime(last)}` : 'Run a health check')
      + cell('Failed', checked ? `${failed ? icon('close') : ''}${esc(fmtFull(failed))}` : '—', failed ? 'bad' : '',
             checked ? (failed ? 'Replace or remove these keys' : 'None') : 'Run a health check')
      + cell('Blocked', `${blocked ? icon('lock') : ''}${esc(fmtFull(blocked))}`, blocked ? 'warn' : '',
             blocked ? 'Auto-unblocks when the window ends' : 'None');

    if (!keys.length) {
      body.innerHTML = `<tr class="a-state-row"><td colspan="8"><div class="a-empty">${icon('key')}<p>No key data loaded yet. Run a health check, or refresh the limit status.</p></div></td></tr>`;
      return;
    }

    body.innerHTML = keys.map(k => {
      /* keyHealth rows carry `status` as health; keyLimits rows overwrite it and
         we stash the limit meaning in `limitStatus`. Read them apart. */
      const health = keyHealth.find(h => h.index === k.index);
      let healthChip = '<span class="a-chip a-chip-muted">Not checked</span>';
      if (health) {
        if (health.status === 'working')        healthChip = `<span class="a-chip a-chip-ok">${icon('check')}Working</span>`;
        else if (health.status === 'ratelimit') healthChip = `<span class="a-chip a-chip-warn">${icon('alert')}Rate limited</span>`;
        else if (health.status === 'failed')    healthChip = `<span class="a-chip a-chip-bad">${icon('close')}Failed</span>`;
      }

      let limitChip = '<span class="a-muted">—</span>';
      if (k.limitStatus === 'blocked')        limitChip = `<span class="a-chip a-chip-warn">${icon('lock')}Blocked</span>`;
      else if (k.limitStatus === 'invalid')   limitChip = `<span class="a-chip a-chip-bad">${icon('close')}Invalid key</span>`;
      else if (k.limitStatus === 'available') limitChip = `<span class="a-chip a-chip-ok">${icon('check')}Available</span>`;

      return `<tr>
        <td class="a-num a-muted">${esc(k.index)}</td>
        <td class="a-primary-cell">
          <span class="a-cell-title">${esc(k.name || `Key ${k.index}`)}</span>
          <span class="a-cell-sub a-mono">${esc(k.masked || '—')}</span>
        </td>
        <td>${healthChip}${health && health.error ? `<div class="a-cell-err">${esc(health.error)}</div>` : ''}</td>
        <td>${limitChip}${k.limitStatus === 'blocked' && k.blocked_until
          ? `<span class="a-cell-sub">until ${esc(fmtDateTime(k.blocked_until))}</span>` : ''}</td>
        <td class="a-right a-num">${health && health.latency != null ? `${esc(fmtFull(health.latency))} ms` : '<span class="a-muted">—</span>'}</td>
        <td><span class="a-mono">${esc((health && health.model) || '—')}</span></td>
        <td>${health && health.checkedAt ? esc(fmtTime(health.checkedAt)) : '<span class="a-muted">—</span>'}</td>
        <td class="a-right">${k.limitStatus === 'blocked' && k.key_hash
          ? `<button class="a-btn a-btn-ghost a-btn-sm" data-action="unblock" data-hash="${esc(k.key_hash)}">Unblock</button>` : ''}</td>
      </tr>`;
    }).join('');
  }

  /* Credits are US dollars. Sub-dollar spend is the normal case (a few cents a
     day), so it keeps four decimals instead of rounding to $0.00. */
  const fmtUsd = (v) => (v === null || v === undefined ? '—'
    : `$${Number(v).toFixed(Math.abs(v) < 1 ? 4 : 2)}`);

  function renderOpenRouter() {
    const body = $('orBody');
    const empty = (text) => {
      body.innerHTML = `<tr class="a-state-row"><td colspan="9"><div class="a-empty">${icon('key')}<p>${esc(text)}</p></div></td></tr>`;
    };
    if (orHealth === undefined) return empty('Run a health check to see the key, its spend and the route.');
    if (orHealth === null) return empty('No OpenRouter key on the backend. Set OPENROUTER_API_KEY in Vercel and redeploy.');

    const h = orHealth;
    let chip = `<span class="a-chip a-chip-bad">${icon('close')}Failed</span>`;
    if (h.status === 'working')        chip = `<span class="a-chip a-chip-ok">${icon('check')}Working</span>`;
    else if (h.status === 'ratelimit') chip = `<span class="a-chip a-chip-warn">${icon('alert')}Rate limited</span>`;
    const c = h.credits || {};
    const muted = '<span class="a-muted">—</span>';

    body.innerHTML = `<tr>
      <td class="a-primary-cell">
        <span class="a-cell-title">${esc(h.name || 'OpenRouter')}</span>
        <span class="a-cell-sub a-mono">${esc(h.masked || '—')}</span>
      </td>
      <td>${chip}${h.error ? `<div class="a-cell-err">${esc(h.error)}</div>` : ''}</td>
      <td class="a-right a-num">${h.credits ? esc(fmtUsd(c.usage_daily)) : muted}</td>
      <td class="a-right a-num">${h.credits ? esc(fmtUsd(c.usage_monthly)) : muted}</td>
      <td class="a-right a-num">${h.credits ? esc(fmtUsd(c.usage)) : muted}</td>
      <td class="a-right a-num">${c.limit_remaining != null ? esc(fmtUsd(c.limit_remaining)) : '<span class="a-muted">No cap</span>'}</td>
      <td class="a-right a-num">${h.latency != null ? `${esc(fmtFull(h.latency))} ms` : muted}</td>
      <td><span class="a-mono">${esc(h.model || '—')}</span><span class="a-cell-sub a-mono">${esc(h.route || '')}</span></td>
      <td>${h.checkedAt ? esc(fmtTime(h.checkedAt)) : muted}</td>
    </tr>`;
  }

  async function checkKeys() {
    const btn = $('checkKeysBtn');
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const data = await request('/api/admin/check-keys', { ttl: 0 });
      keyHealth = data.results || [];
      orHealth  = data.openrouter ?? null;
      if (!keyHealth.length && !orHealth) toast('No AI keys configured on the backend.', 'bad');
      renderKeys();
      renderOpenRouter();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }

  async function checkLimits() {
    const btn = $('checkLimitsBtn');
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const data = await request('/api/admin/key-limits', { ttl: 0 });
      keyLimits = data.keys || [];
      renderKeys();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
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
        stateRow(tbody, 6, '');
        tbody.firstElementChild.firstElementChild.innerHTML =
          `<div class="a-empty">${icon('check')}<p>No crashes recorded. Nothing to triage.</p></div>`;
        $('crashPager').innerHTML = '';
        return;
      }

      fillBody(tbody, groups.map(g => {
        const s = g.sample || {};
        const preview = (s.stack_trace_preview || '').split('\n')[0] || '';
        return `<tr class="is-clickable" data-crash-hash="${esc(g.group_hash)}" tabindex="0">
          <td class="a-primary-cell" style="max-width:420px">
            <span class="a-cell-title">${esc(s.message || '(no message)')}</span>
            ${preview ? `<span class="a-cell-sub a-mono">${esc(preview)}</span>` : ''}
          </td>
          <td><span class="a-chip a-chip-muted">${esc(s.error_type || 'unknown')}</span></td>
          <td class="a-right a-num">${esc(fmtFull(g.occurrences || 0))}</td>
          <td class="a-right a-num">${esc(fmtFull(g.affected_devices || 0))}</td>
          <td title="${esc(fmtDateTime(g.last_seen))}">${esc(fmtAgo(g.last_seen))}</td>
          <td>${esc(fmtDate(g.first_seen))}</td>
        </tr>`;
      }).join(''));

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
    const fatalCount = list.filter(o => o.fatal).length;

    $('drawerTitle').innerHTML =
      `<span class="a-chip ${fatalCount ? 'a-chip-bad' : 'a-chip-warn'}">${icon('alert')}${fatalCount ? 'Fatal' : 'Handled'}</span>${esc(s.message || 'Unknown error')}`;
    $('drawerMeta').innerHTML =
      `<span class="a-chip a-chip-muted">${esc(s.error_type || 'unknown')}</span>`
      + `<span class="a-mono">${esc(group.group_hash)}</span>${copyBtn(group.group_hash, 'group hash')}`;

    /* Version and mode breakdowns come out of the same 20 occurrences the API
       already sends — the old console only listed the distinct values. */
    const tally = (key) => {
      const m = new Map();
      for (const o of list) { const v = o[key]; if (v) m.set(v, (m.get(v) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const versions = tally('app_version');
    const modes    = tally('mode');

    let html = `<section class="a-dsec">${metricCells([
      ['Occurrences',      esc(fmtFull(group.occurrences || 0))],
      ['Devices affected', esc(fmtFull(group.affected_devices || 0))],
      ['First seen',       esc(fmtDate(group.first_seen)), fmtDateTime(group.first_seen)],
      ['Last seen',        esc(fmtAgo(group.last_seen)), fmtDateTime(group.last_seen)],
    ])}</section>`;

    if (versions.length) {
      const max = Math.max(...versions.map(v => v[1]), 1);
      const modeLine = modes.length
        ? `<p class="a-note" style="margin-top:12px">Mode: ${modes.map(([m, n]) => `${esc(m)} ${n}`).join(' · ')}. Fatal in ${fatalCount} of ${list.length}.</p>`
        : '';
      html += drawerSection(`App versions · last ${list.length} reports`, `
        <div class="a-barlist">${versions.map(([v, n]) => `
          <div class="a-barlist-row">
            <span class="a-barlist-key a-mono">${esc(v)}</span>
            <span class="a-barlist-track"><span class="a-barlist-fill" style="width:${((n / max) * 100).toFixed(1)}%"></span></span>
            <span class="a-barlist-val">${n}</span>
          </div>`).join('')}</div>${modeLine}`);
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
      html += drawerSection('Reports per day', '<div class="a-chart-wrap" id="crashSpark"></div>');
      setTimeout(() => { const el = $('crashSpark'); if (el) barChart(el, series, { color: C4, label: 'reports' }); }, 0);
    }

    html += drawerSection('Stack trace', `<pre class="a-trace">${esc(s.stack_trace || '(no stack trace)')}</pre>`,
      s.stack_trace ? copyBtn(s.stack_trace, 'stack trace') : '');

    if (list.length) {
      html += drawerSection(`Recent reports`, `
        <div class="a-events">${list.map(o => `
          <div class="a-event">
            <span class="a-event-type a-mono">${esc(o.app_version || '?')}</span>
            <span class="a-event-meta" title="${esc(o.device_id || '')}">${esc((o.device_id || '').slice(0, 10))}… · ${esc(o.mode || '?')}</span>
            ${o.fatal ? '<span class="a-chip a-chip-bad">Fatal</span>' : ''}
            <span class="a-event-time">${esc(fmtDateTime(o.timestamp))}</span>
          </div>`).join('')}</div>`);
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
      stateRow($('refTopBody'), 6, e.message, true);
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
    $('refClaimsFoot').innerHTML = data.enabled
      ? '<span class="a-status is-ok">Program is live</span>'
      : '<span class="a-status is-off">Program is switched off</span>';

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
          <td class="a-right a-num">${fmtFull(r.total || 0)}</td>
          <td class="a-right a-num">${fmtFull(r.qualified || 0)}<small>${esc(pct(r.qualified || 0, r.total || 0, 0))}</small></td>
          <td class="a-right a-num">${fmtFull(r.pending || 0)}</td>
          <td>${r.capped ? `<span class="a-chip a-chip-warn">${icon('alert')}${fmtFull(r.capped)}</span>` : '<span class="a-muted">—</span>'}</td>
          <td>${esc(r.last ? fmtDate(r.last) : '—')}</td>
        </tr>`).join('')
      : '<tr class="a-state-row"><td colspan="6">Nobody has invited anyone yet.</td></tr>';

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
      $('liveMeta').textContent = [data.title, data.date ? `published ${fmtDate(data.date)}` : ''].filter(Boolean).join(' · ');
      $('liveHighlights').innerHTML = (Array.isArray(data.highlights) ? data.highlights : [])
        .map(h => `<li>${esc(h)}</li>`).join('');
      if (data.version && !$('uvVersion').value) {
        const parts = String(data.version).split('.').map(Number);
        parts[2] = (parts[2] || 0) + 1;
        $('uvVersion').value = parts.join('.');
      }
    } catch {
      $('liveVersion').textContent = '—';
      $('liveMeta').textContent = 'Could not read the published version.';
      $('liveHighlights').innerHTML = '';
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

  const PROVIDER_LABEL = { groq: 'Groq', openrouter: 'OpenRouter' };

  function renderProvider() {
    const current = config.ai_provider || 'groq';
    const avail = config.ai_providers || {};
    /* A provider with no key in Vercel can't be picked: the backend refuses it
       anyway, and greying it out says why before the click. */
    $$('#aiProviderSeg .a-seg-btn').forEach(b => {
      const name = b.dataset.provider;
      const on = name === current;
      const missing = avail[name] && avail[name].configured === false;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = missing && !on;
      b.title = missing ? 'No key set in Vercel' : '';
    });
    renderSwitch('aiFallback', config.ai_fallback !== false);

    const g = avail.groq, o = avail.openrouter;
    $('aiProviderKeys').textContent = (g || o) ? 'Keys in Vercel: ' + [
      g ? (g.configured ? `Groq ${fmtFull(g.keys)} ${g.keys === 1 ? 'key' : 'keys'}` : 'Groq not set') : null,
      o ? (o.configured ? 'OpenRouter set' : 'OpenRouter not set (OPENROUTER_API_KEY)') : null,
    ].filter(Boolean).join(' · ') : '';
  }

  function renderConfig() {
    renderProvider();
    renderSwitch('premium', config.premium_enabled === true);
    renderSwitch('byok',    config.byok_enabled    !== false);
    renderSwitch('gif',     config.gif_enabled     !== false);
    renderSwitch('referral', config.referral_enabled === true);
    /* Only seeded when untouched, so a half-typed value is not wiped by a
       background config refresh. */
    const ft = $('freeTokensInput');
    if (ft && !ft.value) ft.value = String(config.free_daily_tokens ?? 10000);
    const sf = $('sttFreeInput');
    if (sf && !sf.value) sf.value = String((config.stt_free_seconds ?? 180) / 60);

    const tb = config.free_daily_tokens_bounds || { min: 2000, max: 50000 };
    const sb = config.stt_free_seconds_bounds  || { min: 0, max: 900 };
    $('freeTokensHint').textContent =
      `Live: ${fmtFull(config.free_daily_tokens ?? 10000)}. Allowed ${fmtFull(tb.min)} to ${fmtFull(tb.max)}.`;
    $('sttFreeHint').textContent =
      `Live: ${(config.stt_free_seconds ?? 180) / 60} min. Allowed ${sb.min / 60} to ${sb.max / 60}.`;

    const gated = Array.isArray(config.gated_tools) ? config.gated_tools : [];
    $('gatedTools').innerHTML = GATED_TOOLS.map(name => `
      <button class="a-pill" role="button" aria-pressed="${gated.includes(name)}"
              data-action="toggle-gated" data-tool="${esc(name)}">
        ${icon('lock')}${esc(name)}
      </button>`).join('');
  }

  async function writeConfig(patch, message, saved = 'Saved. Devices apply it on their next ping.') {
    const status = $('configStatus');
    status.className = 'a-action-status';
    status.textContent = 'Saving…';
    try {
      const data = await request('/api/admin/set-config', { method: 'POST', body: patch });
      config = data;
      invalidate('/api/admin/set-config');
      renderConfig();
      status.className = 'a-action-status is-ok';
      status.textContent = saved;
      toast(message, 'ok');
    } catch (e) {
      status.className = 'a-action-status is-bad';
      status.textContent = e.message;
      renderConfig();
    }
  }

  async function setProvider(name) {
    const current = config.ai_provider || 'groq';
    if (!PROVIDER_LABEL[name] || name === current) return;
    const label = PROVIDER_LABEL[name];
    const ok = await confirmAsk(
      `Switch AI to ${label}?`,
      name === 'openrouter'
        ? 'Every AI call is answered by OpenRouter (Crusoe, bf16) and spends credits. Warm servers switch within 5 minutes. Keep an eye on the spend under API keys.'
        : 'Every AI call goes back to the free Groq keys, which rate-limit under load. With fallback on, OpenRouter still answers whatever Groq cannot.',
      `Use ${label}`,
    );
    if (!ok) return;
    writeConfig({ ai_provider: name }, `AI now runs on ${label}.`,
      'Saved. Every server uses it within 5 minutes.');
  }

  async function toggleAiFallback() {
    const next = !(config.ai_fallback !== false);
    const other = PROVIDER_LABEL[(config.ai_provider || 'groq') === 'groq' ? 'openrouter' : 'groq'];
    const ok = await confirmAsk(
      next ? 'Turn provider fallback on?' : 'Turn provider fallback off?',
      next
        ? `A call the primary cannot answer is retried once on ${other}.`
        : `Calls the primary cannot answer fail instead of going to ${other}. Users see "AI servers are busy".`,
      next ? 'Enable fallback' : 'Disable fallback',
    );
    if (!ok) return;
    writeConfig({ ai_fallback: next }, `Provider fallback ${next ? 'enabled' : 'disabled'}.`,
      'Saved. Every server uses it within 5 minutes.');
  }

  async function togglePremium() {
    const next = !(config.premium_enabled === true);
    const ok = await confirmAsk(
      next ? 'Make Pro and Max purchasable?' : 'Hide the paid plans?',
      next
        ? 'Both paid tiers become purchasable for every user. The Google Play service-account creds must already be set in Vercel, or checkout will fail.'
        : 'Pro and Max go back to “Coming Soon” for every user. Existing purchases stay valid; only new checkouts are blocked.',
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
        : 'The invite screen and the in-app prompt disappear and no new code can be redeemed. Bonuses already granted are NOT revoked: they run to their expiry.',
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
        ? ' Users on an app build older than the server-budget fix will keep showing the old number and their AI calls will fail in between. Check adoption first.'
        : ''),
      lowering ? 'Lower the cap' : 'Raise the cap',
    );
    if (!ok) return;
    status.className = 'a-action-status';
    status.textContent = '';
    writeConfig({ free_daily_tokens: next }, `Free tier set to ${fmtFull(next)} tokens/day.`);
  }

  /* Free AI-voice minutes. Typed in minutes, stored in seconds. */
  async function saveSttFree() {
    const el = $('sttFreeInput');
    const status = $('sttFreeStatus');
    const raw = String(el.value).trim();
    const minutes = Number(raw);
    const bounds = config.stt_free_seconds_bounds || { min: 0, max: 900 };
    const next = Math.round(minutes * 60);
    const current = config.stt_free_seconds ?? 180;

    if (!raw || !Number.isFinite(minutes) || next < bounds.min || next > bounds.max) {
      status.className = 'a-action-status is-bad';
      status.textContent = `Enter minutes between ${bounds.min / 60} and ${bounds.max / 60}.`;
      return;
    }
    if (next === current) {
      status.className = 'a-action-status';
      status.textContent = 'Already set to that.';
      return;
    }
    const ok = await confirmAsk(
      next === 0 ? 'Turn AI voice off for Free?' : `Set Free AI voice to ${next / 60} min/day?`,
      `Currently ${current / 60} min. This applies to every Free device on its next ping; Pro and Max are unaffected.`,
      next < current ? 'Lower it' : 'Raise it',
    );
    if (!ok) return;
    status.className = 'a-action-status';
    status.textContent = '';
    writeConfig({ stt_free_seconds: next },
      next === 0 ? 'AI voice is off for Free.' : `Free AI voice set to ${next / 60} min/day.`);
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
    ask:      () => renderAsk(),
    devices:  (f) => loadDevices(page.dev, f),
    aitools:  (f) => loadAiTools(page.ai, f),
    /* Limit status is loaded on arrival so the section isn't an empty shell;
       the full health check stays explicit because it live-tests every key
       against Groq and is the slower of the two. */
    apikeys:  () => { renderOpenRouter(); return checkLimits(); },
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
    $('pageDesc').textContent  = SECTION_DESCS[name] || '';
    document.title = `${SECTION_TITLES[name]} · TypeAura Admin`;
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
    try { sessionStorage.removeItem(ASK_KEY); } catch { /* ignore */ }
    askLog = [];
    cache.clear();
    loaded.clear();
    $('app').classList.remove('is-on');
    $('loginScreen').style.display = '';
    setHealth('down', 'Signed out');
    toast('Session rejected. Sign in again.', 'bad');
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

  /* ═══ Ask AI ═════════════════════════════════════════════════
     Chat with the backend's data analyst (/api/admin/ask). The server is
     stateless: the conversation lives here, in sessionStorage next to the
     token, and each question re-sends the last few turns. Every answer keeps
     the queries that produced it, so a number can be checked, not just trusted. */

  const ASK_KEY = 'ta_admin_ask';
  let askLog  = [];                    // [{ role, content, queries?, error? }]
  let askBusy = false;

  function askLoad() {
    try { askLog = JSON.parse(sessionStorage.getItem(ASK_KEY) || '[]'); } catch { askLog = []; }
    if (!Array.isArray(askLog)) askLog = [];
  }

  function askSave() {
    try { sessionStorage.setItem(ASK_KEY, JSON.stringify(askLog.slice(-40))); } catch { /* full or blocked — chat still works */ }
  }

  /* Small markdown subset: fenced code, tables, headings, lists, bold, inline
     code. Input is escaped first, so the model can't inject markup. */
  function askInline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function askMarkdown(src) {
    const lines = esc(src).split('\n');
    const out = [];
    let i = 0;
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => askInline(c.trim()));

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre>${buf.join('\n')}</pre>`);
        continue;
      }

      if (isRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const body = [];
        while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
        out.push(`<div class="a-ask-table"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }

      const h = line.match(/^\s*#{1,4}\s+(.*)$/);
      if (h) { out.push(`<h4>${askInline(h[1])}</h4>`); i++; continue; }

      if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          items.push(`<li>${askInline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }

      if (!line.trim()) { i++; continue; }

      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*•]\s|\d+[.)]\s|\|)/.test(lines[i])) {
        para.push(askInline(lines[i++]));
      }
      if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
      else out.push(`<p>${askInline(lines[i++])}</p>`);
    }
    return out.join('');
  }

  function askQueriesHtml(queries) {
    if (!queries || !queries.length) return '';
    const items = queries.map((q) => {
      const args = q.args && Object.keys(q.args).length ? JSON.stringify(q.args, null, 2) : '';
      const meta = q.error
        ? `<span class="a-ask-q-err">${esc(q.error)}</span>`
        : (q.rows != null ? `<span class="a-ask-q-rows">${q.rows} row${q.rows === 1 ? '' : 's'}</span>` : '');
      return `<li><div class="a-ask-q-head"><code>${esc(q.tool)}(${esc(q.collection || '')})</code>${meta}</div>` +
        (args ? `<pre>${esc(args)}</pre>` : '') + '</li>';
    }).join('');
    return `<details class="a-ask-queries"><summary>${icon('chevron-right')}${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} used</summary><ol>${items}</ol></details>`;
  }

  function renderAsk() {
    const log = $('askLog');
    if (!log) return;
    $('askChips').classList.toggle('a-hidden', askLog.length > 0);

    if (!askLog.length) {
      log.innerHTML = `<div class="a-ask-empty">
        <div class="a-ask-empty-icon">${icon('sparkles')}</div>
        <h3>Ask your data</h3>
        <p>Devices, events, AI usage, tokens, crashes, payments. Poochho, main query likh ke jawab dunga.</p>
      </div>`;
      return;
    }

    /* The analyst answers as plain text beside an avatar, not in a bubble:
       answers carry tables and lists, and a bubble squeezes them. */
    const bot = (inner) =>
      `<div class="a-ask-msg is-bot"><span class="a-ask-avatar">${icon('sparkles')}</span><div class="a-ask-body">${inner}</div></div>`;

    log.innerHTML = askLog.map((m) => {
      if (m.role === 'user') return `<div class="a-ask-msg is-user"><div class="a-ask-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
      if (m.error) return bot(`<div class="a-ask-bubble is-error">${esc(m.error)}</div>${askQueriesHtml(m.queries)}`);
      return bot(`<div class="a-ask-bubble">${askMarkdown(m.content)}</div>${askQueriesHtml(m.queries)}`);
    }).join('') + (askBusy
      ? bot('<div class="a-ask-bubble a-ask-typing"><span></span><span></span><span></span></div>')
      : '');

    log.scrollTop = log.scrollHeight;
  }

  async function sendAsk(text) {
    const q = (text || '').trim();
    if (!q || askBusy) return;

    askLog.push({ role: 'user', content: q });
    askBusy = true;
    $('askInput').value = '';
    growAsk();
    $('askSend').disabled = true;
    renderAsk();

    /* Only successful turns go back as context — an error bubble isn't
       something the model said. */
    const messages = askLog
      .filter(m => !m.error)
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-12);

    try {
      const res = await request('/api/admin/ask', { method: 'POST', body: { messages } });
      askLog.push({ role: 'assistant', content: res.answer || '(no answer)', queries: res.queries || [] });
    } catch (err) {
      askLog.push({ role: 'assistant', error: err.message || 'Request failed', queries: [] });
    } finally {
      askBusy = false;
      $('askSend').disabled = false;
      askSave();
      renderAsk();
      $('askInput').focus();
    }
  }

  /* The composer grows with what is typed, up to its CSS max-height. */
  function growAsk() {
    const el = $('askInput');
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  function newAsk() {
    if (askBusy) return;
    askLog = [];
    askSave();
    renderAsk();
    $('askInput').focus();
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard.', 'ok');
    } catch {
      toast('Copy failed. The browser blocked clipboard access.', 'bad');
    }
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
        case 'drawer-tab':    setDrawerTab(el.dataset.tab); break;
        case 'copy':          copyText(el.dataset.copy); break;
        case 'check-keys':    checkKeys(); break;
        case 'check-limits':  checkLimits(); break;
        case 'unblock':       unblockKey(el.dataset.hash); break;
        case 'publish':       publishUpdate(); break;
        case 'toggle-premium': togglePremium(); break;
        case 'set-provider':  setProvider(el.dataset.provider); break;
        case 'toggle-ai-fallback': toggleAiFallback(); break;
        case 'toggle-byok':   toggleByok(); break;
        case 'toggle-gif':    toggleGif(); break;
        case 'toggle-referral': toggleReferral(); break;
        case 'save-free-tokens': saveFreeTokens(); break;
        case 'save-stt-free':    saveSttFree(); break;
        case 'toggle-gated':  toggleGated(el.dataset.tool); break;
        case 'active-range':  setActiveRange(Number(el.dataset.range)); break;
        case 'toggle-countries': toggleCountries(); break;
        case 'ask-new':          newAsk(); break;
        case 'ask-chip':         sendAsk(el.textContent); break;
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

    $('askForm').addEventListener('submit', (e) => {
      e.preventDefault();
      sendAsk($('askInput').value);
    });
    $('askInput').addEventListener('input', growAsk);
    /* Enter sends, Shift+Enter is a newline — the usual chat contract. */
    $('askInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendAsk($('askInput').value);
      }
    });

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
      const row = e.target.closest && e.target.closest('tr[data-device-id], tr[data-crash-hash], tr[data-country]');
      if (!row) return;
      e.preventDefault();
      if (row.dataset.deviceId)       showDevice(row.dataset.deviceId);
      else if (row.dataset.crashHash) showCrash(row.dataset.crashHash);
      else                            showCountry(row.dataset.country);
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
    askLoad();
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
        toast('Mock mode. No backend calls.', 'info');
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
