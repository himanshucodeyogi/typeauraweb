/* Developed by Himanshu Kashyap
   Dev-only fixtures for the admin console.

   This module is imported ONLY when the page is opened with ?mock=1 — nothing
   references it otherwise, so it never loads for a real operator. It exists
   because the admin API only accepts calls from the production origin
   (see the CORS rule for /api/admin/* in backend/vercel.json), which makes the
   real console impossible to iterate on locally, and because every real call
   spends part of a rate-limited budget.

   The shapes here mirror backend/lib/admin/* exactly. If a handler's response
   changes, change it here too or the mock stops being a useful check. */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const day = (n) => new Date(Date.now() + IST_OFFSET_MS - n * 86400000).toISOString().slice(0, 10);
const iso = (n) => new Date(Date.now() - n * 86400000).toISOString();

/* Deterministic pseudo-random so screenshots are stable across reloads. */
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (lo, hi) => Math.floor(lo + rnd() * (hi - lo));

const DEVICE_NAMES = [
  'realme RMX5108', 'Samsung SM-A546E', 'OnePlus CPH2467', 'Xiaomi 23021RAAEG',
  'motorola edge 40', 'vivo V2312', 'OPPO CPH2557', 'POCO X6 Pro', 'Nothing A065',
  'Samsung SM-S911B', 'iQOO Neo 9', 'Redmi Note 13', 'Tecno LH7n', 'Infinix X6831',
  /* Deliberately included: device_name is client-supplied, so the console must
     render this as literal text, not as markup. */
  '<script>alert(1)</script>',
];
/* Deliberately long-tailed rather than an even spread: one dominant market, a
   handful of mid-size ones, then countries with a single device each. That tail
   is the case the country panel exists to surface — a new market arrives as
   exactly one device — so the fixture has to produce more rows than the panel's
   collapsed preview, or the "Show all" path is never exercised locally. */
const COUNTRY_HEAD = ['IN', 'IN', 'IN', 'IN', 'IN', 'US', 'AE', 'GB', 'NP', 'BD', 'CA', 'AU', 'DE', 'SA', 'PK'];
const COUNTRY_TAIL = ['PL', 'FR', 'BR', 'ID', 'MX', 'IL', 'UG', 'AF', 'NG', 'EG', 'KE', 'ZA', 'TR', 'ES', 'VN'];
const countryFor = (i) =>
  (i < COUNTRY_TAIL.length ? COUNTRY_TAIL[i] : COUNTRY_HEAD[i % COUNTRY_HEAD.length]);
const THEMES = ['Midnight', 'Aurora', 'Sunset', 'Classic Dark', 'Ocean'];

const devices = Array.from({ length: 137 }, (_, i) => {
  const paid = i % 11 === 0;
  const max  = paid && i % 33 === 0;
  const installedDaysAgo = between(1, 300);
  const tokens = between(0, 240000);
  return {
    device_id: `dev_${String(i).padStart(4, '0')}_${Math.abs(Math.floor(rnd() * 1e9)).toString(36)}`,
    device_name: DEVICE_NAMES[i % DEVICE_NAMES.length],
    android_version: String(between(10, 17)),
    country: countryFor(i),
    install_date: iso(installedDaysAgo),
    created_at:   iso(installedDaysAgo),
    last_use_date: iso(between(0, Math.min(installedDaysAgo, 40))),
    plan_tier: paid ? (max ? 'max' : 'pro') : 'free',
    ...(paid ? {
      paid_tier: max ? 'max' : 'pro',
      premium_plan: max ? 'max_annual' : 'pro_monthly',
      premium_since: iso(between(5, 90)),
      premium_until: iso(-between(1, 300)),
      recovery_code: `TA-${Math.abs(Math.floor(rnd() * 1e4)).toString().padStart(4, '0')}-${Math.abs(Math.floor(rnd() * 1e4)).toString().padStart(4, '0')}`,
    } : {}),
    ...(i % 23 === 0 ? { admin_plan_override: 'pro', admin_plan_override_at: iso(between(1, 20)) } : {}),
    ...(i % 31 === 0 ? { plan_byok_active: true } : {}),
    ...(i % 17 === 0 ? { merged_device_ids: ['dev_old_a', 'dev_old_b'] } : {}),
    keyboard_enabled:  i % 5 !== 0,
    keyboard_selected: i % 7 !== 0,
    selected_theme: THEMES[i % THEMES.length],
    total_app_opens:      between(1, 900),
    total_keyboard_opens: between(1, 5200),
    total_ai_uses:        between(0, 640),
    total_voice_ai_uses:  between(0, 210),
    total_lens_translate: between(0, 320),
    total_lens_reply:     between(0, 140),
    total_ai_tokens:      tokens,
  };
});

const crashGroups = [
  {
    group_hash: 'a1b2c3d4e5f60718',
    occurrences: 412,
    first_seen: iso(24), last_seen: iso(0),
    affected_devices: 88,
    sample: {
      message: 'NullPointerException: Attempt to invoke virtual method on a null object reference',
      error_type: 'platform_error',
      stack_trace_preview: 'at com.typeaura.app.KeyboardService.onStartInputView(KeyboardService.kt:412)\n  at android.inputmethodservice…',
      stack_trace: 'java.lang.NullPointerException: Attempt to invoke virtual method\n'
        + '  at com.typeaura.app.KeyboardService.onStartInputView(KeyboardService.kt:412)\n'
        + '  at android.inputmethodservice.InputMethodService.showWindow(InputMethodService.java:2216)\n'
        + '  at android.os.Handler.dispatchMessage(Handler.java:106)\n'
        + '  at android.app.ActivityThread.main(ActivityThread.java:8663)',
    },
  },
  {
    group_hash: 'b2c3d4e5f6071829',
    occurrences: 96,
    first_seen: iso(9), last_seen: iso(1),
    affected_devices: 31,
    sample: {
      message: 'TimeoutException: Future not completed within 0:00:10.000000',
      error_type: 'zone_error',
      stack_trace_preview: 'package:typeaura/services/ai_client.dart 88:22  AiClient.chat',
      stack_trace: 'TimeoutException after 0:00:10.000000: Future not completed\n'
        + '  package:typeaura/services/ai_client.dart 88:22   AiClient.chat\n'
        + '  package:typeaura/utils/ai_gate.dart 44:9         AiGate.ensureAllowed',
    },
  },
  {
    group_hash: 'c3d4e5f607182930',
    occurrences: 18,
    first_seen: iso(4), last_seen: iso(3),
    affected_devices: 7,
    sample: {
      message: 'RenderFlex overflowed by 27 pixels on the bottom',
      error_type: 'flutter_error',
      stack_trace_preview: 'package:flutter/src/rendering/flex.dart 121:14',
      stack_trace: 'A RenderFlex overflowed by 27 pixels on the bottom.\n'
        + '  package:flutter/src/rendering/flex.dart 1021:14',
    },
  },
];

const occurrencesFor = (hash) => Array.from({ length: 20 }, (_, i) => ({
  device_id: devices[(i * 7) % devices.length].device_id,
  app_version: ['3.0.0', '2.9.4', '2.8.1'][i % 3],
  mode: i % 3 === 0 ? 'app' : 'keyboard',
  error_type: 'platform_error',
  message: crashGroups.find(g => g.group_hash === hash)?.sample.message || '',
  fatal: i % 4 === 0,
  timestamp: iso(i % 6),
  received_at: iso(i % 6),
  group_hash: hash,
}));

let config = {
  premium_enabled: false,
  byok_enabled: true,
  gif_enabled: true,
  gated_tools: ['Email Composer'],
  ready_countries: ['IN', 'US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'ZA'],
  referral_enabled: true,
  free_daily_tokens: 5000,
  referral: {
    referrer_bonus: 5000, referee_bonus: 2000, bonus_days: 3,
    max_bonus: 25000, max_per_day: 5, max_lifetime: 20,
    claim_window_days: 14, popup_every_n_opens: 3, popup_cooldown_hours: 20,
  },
};

/* Shaped to make the interesting cases visible without a live program: a
   healthy referrer, one that hit the lifetime cap, and one whose invites all
   sit unqualified — which is what a farm of installs nobody sets up looks
   like. The qualify rate deliberately sits near the real funnel's 33%. */
const referrals = {
  enabled: config.referral_enabled,
  config: config.referral,
  funnel: { claims: 48, qualified: 17, pending: 29, capped: 2, qualify_rate: 35.4 },
  live_grants: { devices: 11, tokens_per_day: 41000 },
  top_referrers: [
    { hw_id: 'hw-a1', device_id: 'a1b2c3d4e5f6', total: 21, qualified: 9, pending: 12, capped: 2, last: '2026-09-18T10:12:00Z' },
    { hw_id: 'hw-b2', device_id: 'b2c3d4e5f6a1', total: 6,  qualified: 5, pending: 1,  capped: 0, last: '2026-09-17T08:02:00Z' },
    { hw_id: 'hw-c3', device_id: 'c3d4e5f6a1b2', total: 14, qualified: 0, pending: 14, capped: 0, last: '2026-09-16T22:41:00Z' },
    { hw_id: 'hw-d4', device_id: 'd4e5f6a1b2c3', total: 3,  qualified: 3, pending: 0,  capped: 0, last: '2026-09-12T14:20:00Z' },
  ],
};

const keyHealth = [
  { index: 1, name: 'Key 1', masked: 'gsk_abc••••••••••••7f2a', model: 'openai/gpt-oss-120b', status: 'working',   latency: 412, error: null, checkedAt: new Date().toISOString() },
  { index: 2, name: 'Key 2', masked: 'gsk_def••••••••••••91bc', model: 'openai/gpt-oss-120b', status: 'working',   latency: 733, error: null, checkedAt: new Date().toISOString() },
  { index: 3, name: 'Key 3', masked: 'gsk_ghi••••••••••••3d40', model: 'openai/gpt-oss-120b', status: 'ratelimit', latency: 205, error: 'Rate limited — key likely valid', checkedAt: new Date().toISOString() },
  { index: 4, name: 'Key 4', masked: 'gsk_jkl••••••••••••88ee', model: 'openai/gpt-oss-120b', status: 'failed',    latency: null, error: 'Invalid or expired key', checkedAt: new Date().toISOString() },
];

const keyLimits = [
  { index: 1, name: 'Key 1', masked: 'gsk_abc••••••••••••7f2a', key_hash: 'aaaa1111bbbb2222', status: 'available', blocked_until: null },
  { index: 2, name: 'Key 2', masked: 'gsk_def••••••••••••91bc', key_hash: 'cccc3333dddd4444', status: 'available', blocked_until: null },
  { index: 3, name: 'Key 3', masked: 'gsk_ghi••••••••••••3d40', key_hash: 'eeee5555ffff6666', status: 'blocked',   blocked_until: iso(-0.02) },
  { index: 4, name: 'Key 4', masked: 'gsk_jkl••••••••••••88ee', key_hash: 'gggg7777hhhh8888', status: 'invalid',   blocked_until: null },
];

let published = { version: '3.0.0', title: 'Play Store launch', highlights: ['Glide typing', 'Floating Lens'], date: day(6) };

/* Mirrors the $group in backend/lib/admin/stats.js: per-country totals plus the
   active-7d count and the engagement sums, biggest first. */
function countryRollup() {
  const cutoff = iso(7);
  const by = new Map();
  for (const d of devices) {
    const row = by.get(d.country)
      || { country: d.country, users: 0, active_7d: 0, kb_opens: 0, ai_uses: 0 };
    row.users     += 1;
    row.active_7d += d.last_use_date >= cutoff ? 1 : 0;
    row.kb_opens  += d.total_keyboard_opens || 0;
    row.ai_uses   += d.total_ai_uses || 0;
    by.set(d.country, row);
  }
  /* Same tie-break as the backend's $sort, so the long tail of one-device
     countries doesn't reorder between renders. */
  return [...by.values()].sort(
    (a, b) => b.users - a.users || b.active_7d - a.active_7d || a.country.localeCompare(b.country));
}

function stats() {
  const dates = Array.from({ length: 30 }, (_, i) => day(29 - i));
  return {
    total_users: devices.length,
    dau: 41, wau: 88, mau: 121,
    total_keyboard_opens: devices.reduce((s, d) => s + d.total_keyboard_opens, 0),
    total_ai_uses:        devices.reduce((s, d) => s + d.total_ai_uses, 0),
    total_voice_ai_uses:  devices.reduce((s, d) => s + d.total_voice_ai_uses, 0),
    total_app_opens:      devices.reduce((s, d) => s + d.total_app_opens, 0),
    new_installs_7d: 14,
    total_lens_translate: devices.reduce((s, d) => s + d.total_lens_translate, 0),
    total_lens_reply:     devices.reduce((s, d) => s + d.total_lens_reply, 0),
    /* Derived from the device fixtures rather than invented, so the active-7d
       split in the country panel agrees with what the Devices table shows when
       you click through to a country. */
    countries: countryRollup(),
    countries_pending: 9,
    daily_active: dates.map((date, i) => ({ date, users: Math.round(22 + i * 0.75 + Math.sin(i / 2.4) * 9) })),
    daily_tokens: dates.map((date, i) => ({ date, tokens: Math.round(120000 + i * 3400 + Math.sin(i / 1.7) * 52000) })),
    plan_mix: { free: devices.length - 13, pro: 9, max: 4 },
    generated_at: new Date().toISOString(),
  };
}

function paginate(list, params) {
  const p = Number(params.get('page') || 1);
  const limit = Number(params.get('limit') || 50);
  const search = (params.get('search') || '').toLowerCase();
  const filter = params.get('filter') || '';
  const sort = params.get('sort') || 'last_use_date';

  const country = (params.get('country') || '').toUpperCase();

  let rows = list;
  if (search) rows = rows.filter(d => (d.device_name + d.device_id).toLowerCase().includes(search));
  if (country) rows = rows.filter(d => d.country === country);
  if (filter === 'plan_free') rows = rows.filter(d => d.plan_tier === 'free');
  if (filter === 'plan_pro')  rows = rows.filter(d => d.plan_tier === 'pro');
  if (filter === 'plan_max')  rows = rows.filter(d => d.plan_tier === 'max');
  if (filter === 'plan_paid') rows = rows.filter(d => d.premium_until);
  if (filter === 'plan_byok') rows = rows.filter(d => d.plan_byok_active);
  if (filter === 'override_set') rows = rows.filter(d => d.admin_plan_override);
  if (filter === 'enabled')  rows = rows.filter(d => d.keyboard_enabled);
  if (filter === 'selected') rows = rows.filter(d => d.keyboard_selected);
  if (filter === 'active7d')  rows = rows.filter(d => d.last_use_date >= iso(7));
  if (filter === 'active30d') rows = rows.filter(d => d.last_use_date >= iso(30));

  rows = [...rows].sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (typeof av === 'number') return (bv || 0) - (av || 0);
    return String(bv || '').localeCompare(String(av || ''));
  });

  const total = rows.length;
  return {
    devices: rows.slice((p - 1) * limit, p * limit),
    pagination: { page: p, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/* Small delay so loading states are actually visible while reviewing the UI. */
const delay = (ms = 260) => new Promise(r => setTimeout(r, ms));

export default {
  async handle(path, method = 'GET', body = null) {
    await delay();
    const [route, qs] = path.split('?');
    const params = new URLSearchParams(qs || '');

    if (route === '/api/updates') return published;

    if (route === '/api/admin/stats') return stats();

    if (route === '/api/admin/users') return paginate(devices, params);

    if (route === '/api/admin/user') {
      const device = devices.find(d => d.device_id === params.get('id'));
      if (!device) throw new Error('Device not found');
      const types = ['app_open', 'keyboard_opened', 'ai_used', 'voice_ai', 'lens_translate', 'theme_changed'];

      const page  = Math.max(1, Number(params.get('events_page')  || 1));
      const limit = Math.min(200, Math.max(1, Number(params.get('events_limit') || 50)));
      const skip  = (page - 1) * limit;
      /* Long enough (and deterministic per device) that "Load more" has real
         pages to walk — events are never pruned server-side, so a busy device
         genuinely looks like this. */
      const total = 40 + (device.total_keyboard_opens % 460);
      const count = Math.max(0, Math.min(limit, total - skip));

      return {
        device,
        recent_events: Array.from({ length: count }, (_, i) => {
          const n = skip + i;
          return {
            device_id: device.device_id,
            event_type: types[n % types.length],
            metadata: types[n % types.length] === 'theme_changed' ? device.selected_theme : null,
            timestamp: iso(n * 0.4),
            received_at: iso(n * 0.4),
          };
        }),
        events_pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
      };
    }

    if (route === '/api/admin/crashes') {
      const hash = params.get('hash');
      if (hash) {
        const group = crashGroups.find(g => g.group_hash === hash);
        if (!group) throw new Error('Group not found');
        return { group, recent_occurrences: occurrencesFor(hash) };
      }
      const search = (params.get('search') || '').toLowerCase();
      const groups = search
        ? crashGroups.filter(g => g.sample.message.toLowerCase().includes(search))
        : crashGroups;
      return { groups, pagination: { page: 1, limit: 50, total: groups.length, total_pages: 1 } };
    }

    if (route === '/api/admin/check-keys') return { results: keyHealth };

    if (route === '/api/admin/key-limits') {
      if (method === 'DELETE') {
        const k = keyLimits.find(x => x.key_hash === body.key_hash);
        if (k) { k.status = 'available'; k.blocked_until = null; }
        return { ok: true, unblocked: body.key_hash };
      }
      return { keys: keyLimits };
    }

    if (route === '/api/admin/referrals') {
      return { ...referrals, enabled: config.referral_enabled, config: config.referral };
    }

    if (route === '/api/admin/set-config') {
      if (method === 'POST') { config = { ...config, ...body }; return { ok: true, ...config }; }
      return { ...config };
    }

    if (route === '/api/admin/set-plan') {
      const d = devices.find(x => x.device_id === body.device_id);
      if (!d) throw new Error('Device not found');
      if (method === 'DELETE') {
        delete d.admin_plan_override; delete d.admin_plan_override_at;
        return { ok: true, cleared: true };
      }
      d.admin_plan_override = body.plan_tier === 'premium' ? 'pro' : body.plan_tier;
      d.admin_plan_override_at = new Date().toISOString();
      d.plan_tier = d.admin_plan_override;
      return { ok: true, plan_tier: d.admin_plan_override };
    }

    if (route === '/api/admin/delete-user') {
      const i = devices.findIndex(x => x.device_id === body.device_id);
      if (i >= 0) devices.splice(i, 1);
      return { ok: true, device_found: i >= 0, deleted: { devices: i >= 0 ? 1 : 0, events: 34, crashes: 2, payments: 1 } };
    }

    if (route === '/api/admin/set-version') {
      published = { ...body, date: new Date().toISOString().split('T')[0] };
      return { ok: true, saved: { ...published, updated_at: new Date().toISOString() } };
    }

    throw new Error(`Mock has no handler for ${route}`);
  },
};
