// Didriksons Poolkollen – demo
// En enda sida som pratar direkt med Supabase. Behörigheterna ligger i databasen
// (Row Level Security), så en kund kan bara läsa sin egen pool.

// ------------------------------------------------------------------
// Uppstart
// ------------------------------------------------------------------
const cfg = window.POOLKOLLEN_CONFIG || {};
const configured = Boolean(
  cfg.supabaseUrl && cfg.supabaseKey && !cfg.supabaseUrl.includes('DITT-PROJEKT') && !cfg.supabaseKey.includes('DIN-'),
);
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl.trim(), cfg.supabaseKey.trim()) : null;
const root = document.getElementById('app');

let profile = null;
let flash = null; // { text, kind: 'ok' | 'err' }
let routeToken = 0;
let lastPath = null;

// ------------------------------------------------------------------
// Små hjälpare
// ------------------------------------------------------------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const link = (path, q = {}) => {
  const qs = new URLSearchParams(
    Object.entries(q).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString();
  return '#' + path + (qs ? '?' + qs : '');
};

function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  return { path, q: Object.fromEntries(new URLSearchParams(qs || '')) };
}

function go(path, q) {
  const h = link(path, q);
  if (location.hash === h) route();
  else location.hash = h;
}

function setFlash(text, kind = 'ok') {
  flash = { text, kind };
}

// Sidorna lägger en markör där meddelandet ska stå. Markören byts ut först när
// sidan faktiskt visas, så att en avbruten sidladdning inte "äter upp" meddelandet.
const FLASH_SLOT = '<!--flash-->';
function takeFlash() {
  return FLASH_SLOT;
}
function fillFlash(html) {
  if (!html.includes(FLASH_SLOT)) return html;
  const f = flash;
  flash = null;
  const box = f ? `<div class="flash flash-${f.kind}" role="status">${esc(f.text)}</div>` : '';
  return html.replace(FLASH_SLOT, box).split(FLASH_SLOT).join('');
}

async function must(promise) {
  const res = await promise;
  if (res.error) throw res.error;
  return res;
}

// ------------------------------------------------------------------
// Poollogik: status, gränsvärden, formatering
// ------------------------------------------------------------------
const TZ = 'Europe/Stockholm';
const OFFLINE_MINUTES = 60;
const STATUS_LABEL = { ok: 'OK', varning: 'Varning', larm: 'Larm', offline: 'Offline' };
const STATUS_ORDER = { larm: 0, varning: 1, offline: 2, ok: 3 };
const LINE = { ok: '#2E8B5E', varning: '#C27A12', larm: '#C62828', offline: '#9AA3AB' };

function phLevel(ph) {
  if (ph == null) return 'ok';
  if (ph <= 7.0 || ph >= 7.8) return 'larm';
  if (ph < 7.2 || ph > 7.6) return 'varning';
  return 'ok';
}
function orpLevel(orp) {
  if (orp == null) return 'ok';
  if (orp < 600) return 'larm';
  if (orp < 650 || orp > 800) return 'varning';
  return 'ok';
}
const minutesSince = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

function statusOf(l) {
  if (!l) return 'offline';
  if (minutesSince(l.measured_at) > OFFLINE_MINUTES) return 'offline';
  const levels = [phLevel(l.ph), orpLevel(l.orp)];
  if (levels.includes('larm')) return 'larm';
  if (levels.includes('varning')) return 'varning';
  return 'ok';
}

const fmt = (v, d = 1) => (v == null ? '–' : Number(v).toFixed(d).replace('.', ','));

function ago(iso) {
  if (!iso) return 'aldrig';
  const m = Math.round(minutesSince(iso));
  if (m < 1) return 'nyss';
  if (m < 60) return `${m} min sedan`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} tim sedan`;
  return `${Math.round(h / 24)} dagar sedan`;
}

function problemText(l, status) {
  if (status === 'offline') return `Enheten har inte rapporterat sedan ${ago(l?.measured_at)}. Kontrollera ström och uppkoppling i pumprummet.`;
  if (!l) return '';
  const parts = [];
  if (phLevel(l.ph) !== 'ok') parts.push(Number(l.ph) > 7.4 ? `pH är för högt (${fmt(l.ph)})` : `pH är för lågt (${fmt(l.ph)})`);
  if (orpLevel(l.orp) !== 'ok') parts.push(Number(l.orp) < 650 ? `redox är lågt (${l.orp} mV), kloret räcker inte till` : `redox är högt (${l.orp} mV)`);
  if (!parts.length) return 'Alla värden ligger inom målområdet.';
  const text = parts.join(' och ');
  return (text.startsWith('pH') ? text : text.charAt(0).toUpperCase() + text.slice(1)) + '.';
}

function adviceText(l, status) {
  if (status === 'offline') return 'Boka ett servicebesök eller be kunden kontrollera att pumpen och enheten har ström.';
  if (!l || status === 'ok') return 'Ingen åtgärd behövs just nu.';
  const ph = Number(l.ph);
  const orpLow = Number(l.orp) < 650;
  if (ph > 7.6 && orpLow) return 'Sänk pH först, chockklorera sedan. Mängden räknas ut från poolens volym.';
  if (ph > 7.6) return 'Tillsätt pH-minus och mät igen efter några timmar.';
  if (ph < 7.2) return 'Tillsätt pH-plus och mät igen efter några timmar.';
  if (orpLow) return 'Höj klorhalten, kontrollera även stabilisator och filter.';
  return 'Håll koll på utvecklingen.';
}

// ------------------------------------------------------------------
// Datum (svensk tid, räknat som ÅÅÅÅ-MM-DD)
// ------------------------------------------------------------------
const DAY_SHORT = ['mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];
const DAY_LONG = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const MONTH_SHORT = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];

const toUTC = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUTC = (d) => d.toISOString().slice(0, 10);
const todayISO = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (iso, n) => {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
};
const dow = (iso) => (toUTC(iso).getUTCDay() + 6) % 7; // 0 = måndag
const mondayOf = (iso) => addDays(iso, -dow(iso));
const monthStart = (iso, offset = 0) => {
  const d = toUTC(iso);
  return fromUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)));
};
const daysInMonth = (first) => {
  const d = toUTC(first);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};
const monthOf = (iso) => Number(iso.slice(5, 7));
function isoWeek(iso) {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d - jan4) / 604800000 - 3 / 7 + ((jan4.getUTCDay() + 6) % 7) / 7);
}
const fmtDay = (iso) => `${DAY_SHORT[dow(iso)]} ${Number(iso.slice(8, 10))} ${MONTH_SHORT[monthOf(iso) - 1]}`;
const fmtDayLong = (iso) => `${DAY_LONG[dow(iso)]} ${Number(iso.slice(8, 10))} ${MONTHS[monthOf(iso) - 1]}`;
const fmtTime = (iso) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const lastSevenDayLabels = () => {
  const t = todayISO();
  return Array.from({ length: 7 }, (_, i) => DAY_SHORT[dow(addDays(t, i - 6))]);
};

// ------------------------------------------------------------------
// Besökstyper
// ------------------------------------------------------------------
const KINDS = {
  service: {
    label: 'Servicebesök', card: 'Service', sub: 'ca 1 tim',
    slots: ['08–09', '09–10', '10–11', '13–14', '14–15', '15–16'], months: null, season: 'hela året',
    tasks: ['Kontroll av vattnet och utrustningen', 'Kalibrering av givarna', 'Justering av kemin vid behov'],
  },
  stangning: {
    label: 'Vinterstängning', card: 'Vinter­stängning', sub: 'aug–nov · 3 tim',
    slots: ['08–11', '12–15'], months: [8, 9, 10, 11], season: 'augusti–november',
    tasks: ['Rengöring och sänkning av vattennivån', 'Tömning av ledningar och pump', 'Vinterkemikalier och täckning', 'Givarna tas in för vinterförvaring'],
  },
  oppning: {
    label: 'Vårstart', card: 'Vårstart', sub: 'mars–maj · 3 tim',
    slots: ['08–11', '12–15'], months: [3, 4, 5], season: 'mars–maj',
    tasks: ['Avtäckning och rengöring', 'Uppstart av pump och filter', 'Givarna monteras och kalibreras', 'Startdosering av kemikalier'],
  },
};
const parseSlot = (s) => s.split('–').map(Number);
const seasonalKind = (month) =>
  KINDS.stangning.months.includes(month) ? 'stangning' : KINDS.oppning.months.includes(month) ? 'oppning' : 'service';

// ------------------------------------------------------------------
// Ikoner och små komponenter
// ------------------------------------------------------------------
const ICONS = {
  grid: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/>',
  calendar: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2v4M13 2v4"/>',
  home: '<path d="M3 9 10 3l7 6v8H3z"/>',
  logout: '<path d="M8 3.5H4.5v13H8"/><path d="M12 6.5 15.5 10 12 13.5M15.5 10H8"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  left: '<path d="M12 4 6 10l6 6"/>',
  right: '<path d="M8 4l6 6-6 6"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16 3.5V7h-3.5"/>',
  message: '<path d="M3.5 4.5h13v9h-7l-4 3v-3h-2z"/>',
  bell: '<path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13z"/><path d="M8.5 18a1.5 1.5 0 0 0 3 0"/>',
  users: '<circle cx="8" cy="7" r="3"/><path d="M2.5 17a5.5 5.5 0 0 1 11 0"/><path d="M13 4.5a3 3 0 0 1 0 5M15 12.5a5 5 0 0 1 2.5 4.5"/>',
  chart: '<path d="M3 3v14h14"/><path d="M7 13V9M11 13V6M15 13v-3"/>',
  doc: '<path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3M8 9.5h4M8 12.5h4"/>',
  history: '<path d="M3 16 8 10l3 3 6-7"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  mail: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3 5.5 7 5.5 7-5.5"/>',
};
const icon = (name, size = 20, sw = 1.7) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const brand = (dark = true) => `
  <div class="brand ${dark ? 'brand-dark' : 'brand-light'}">
    <div class="brand-mark"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5c3 3.6 5 6.3 5 9a5 5 0 0 1-10 0c0-2.7 2-5.4 5-9z"/></svg></div>
    <div><div class="brand-small">Didriksons</div><div class="brand-big">Poolkollen</div></div>
  </div>`;

const pill = (status, label) => `<span class="pill pill-${status}"><span class="dot"></span>${esc(label ?? STATUS_LABEL[status])}</span>`;

function lineChart(values, { min, max, band, height = 100, label, color = 'var(--accent)' }) {
  const W = 400;
  const H = height;
  if (values.length < 2) return '<div class="chart-empty">Ingen mätdata ännu</div>';
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const x = (i) => (i / (values.length - 1)) * W;
  const y = (v) => H - ((clamp(v) - min) / (max - min)) * H;
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const bandRect = band ? `<rect x="0" y="${y(band[1])}" width="${W}" height="${y(band[0]) - y(band[1])}" fill="var(--ok-bg)"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}" role="img" aria-label="${esc(label)}">
    ${bandRect}
    <line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function sparkline(values, color) {
  const W = 96;
  const H = 28;
  if (values.length < 2) return `<svg width="${W}" height="${H}" aria-hidden="true"></svg>`;
  const pts = values
    .map((v, i) => {
      const cx = 2 + (i / (values.length - 1)) * (W - 4);
      const cy = H - 2 - ((Math.min(8.2, Math.max(6.6, v)) - 6.6) / 1.6) * (H - 4);
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

const dayLabels = () => `<div class="daylabels">${lastSevenDayLabels().map((d) => `<span>${d}</span>`).join('')}</div>`;

// ------------------------------------------------------------------
// Skal för personal och kund
// ------------------------------------------------------------------
async function staffShell(active, content) {
  const [bk, al] = await Promise.all([
    sb.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'ny'),
    sb.from('alarms').select('id', { count: 'exact', head: true }).is('resolved_at', null).is('acknowledged_at', null),
  ]);
  const newBookings = bk.count || 0;
  const openAlarms = al.count || 0;
  const name = profile.full_name || 'Personal';
  const item = (key, href, ic, label, badge, badgeCls = '') =>
    `<a href="${href}" class="${active === key ? 'active' : ''}">${icon(ic)}${label}${badge ? `<span class="badge ${badgeCls}">${badge}</span>` : ''}</a>`;
  return `
  <div class="shell">
    <aside class="side">
      ${brand()}
      <nav class="nav" aria-label="Huvudmeny">
        ${item('overview', '#/admin', 'grid', 'Översikt')}
        ${item('alarms', '#/admin/larm', 'bell', 'Larm', openAlarms, 'badge-alarm')}
        ${item('bookings', '#/admin/bokningar', 'calendar', 'Servicebesök', newBookings)}
        ${item('customers', '#/admin/kunder', 'users', 'Kunder')}
        ${item('stats', '#/admin/statistik', 'chart', 'Statistik')}
      </nav>
      <div class="side-foot">
        <div class="who">
          <div class="avatar">${esc(name.charAt(0))}</div>
          <div><div class="who-name">${esc(name)}</div><div class="who-sub">Ser alla pooler</div></div>
        </div>
        <button class="side-btn" type="button" data-action="logout">Logga ut</button>
      </div>
    </aside>
    <main class="main">${content}</main>
  </div>`;
}

async function customerShell(active, content) {
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true }).is('read_at', null);
  const unread = active === 'messages' ? 0 : count || 0;
  const tab = (key, href, ic, label, badge) =>
    `<a href="${href}" class="${active === key ? 'active' : ''}"><span class="tab-icon">${icon(ic, 22)}${badge ? `<span class="tab-badge">${badge}</span>` : ''}</span>${label}</a>`;
  return `
  <div class="kund">
    <div class="kund-inner">${content}</div>
    <nav class="tabbar" aria-label="Flikar">
      ${tab('home', '#/kund', 'home', 'Hem')}
      ${tab('history', '#/kund/historik', 'history', 'Historik')}
      ${tab('book', '#/kund/boka', 'calendar', 'Boka')}
      ${tab('messages', '#/kund/meddelanden', 'mail', 'Meddelanden', unread)}
      <button type="button" data-action="logout"><span class="tab-icon">${icon('logout', 22)}</span>Logga ut</button>
    </nav>
  </div>`;
}

// ------------------------------------------------------------------
// Sidor
// ------------------------------------------------------------------
function pageSetup() {
  return `
  <div class="login-wrap"><div class="login card">
    ${brand(false)}
    <h1>Nästan klart</h1>
    <p class="muted">Appen saknar nycklarna till Supabase. Öppna filen <code>config.js</code> och fyll i din
    Project URL och din Publishable key. Spara, vänta en minut och ladda om sidan.</p>
  </div></div>`;
}

const DEMO = [
  { email: 'tekniker@poolkollen.demo', title: 'Tekniker', sub: 'Ser alla 42 pooler, larm och bokningar' },
  { email: 'anna@poolkollen.demo', title: 'Kund: Anna Andersson', sub: 'Pool som mår bra, kan boka besök' },
  { email: 'berg@poolkollen.demo', title: 'Kund: Per Berg', sub: 'Pool med larm' },
];

function pageLogin(q) {
  return `
  <div class="login-wrap"><div class="login card">
    ${brand(false)}
    <div class="stack-4">
      <h1>Logga in</h1>
      <p class="muted">Demo av övervakning och bokning. All data är påhittad.</p>
    </div>
    ${takeFlash()}
    ${q.noprofile ? `<div class="flash flash-err">Kontot ${esc(q.noprofile)} saknar profil. Kör <code>supabase/setup.sql</code> igen.
      <button class="btn btn-secondary btn-sm" type="button" data-action="logout">Logga ut</button></div>` : ''}
    <div class="demo-box">
      <div class="demo-title">Snabbinloggning</div>
      ${DEMO.map((d) => `
        <button class="demo-btn" type="button" data-action="demo-login" data-email="${esc(d.email)}">
          <span class="demo-btn-title">${esc(d.title)}</span>
          <span class="demo-btn-sub">${esc(d.sub)}</span>
        </button>`).join('')}
    </div>
    <details class="manual">
      <summary>Logga in med e-post</summary>
      <form class="form" id="login-form">
        <label>E-post<input name="email" type="email" required autocomplete="username"></label>
        <label>Lösenord<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn btn-primary btn-block" type="submit">Logga in</button>
      </form>
      <p class="muted small">Alla demokonton har lösenordet demo1234.</p>
    </details>
  </div></div>`;
}

// ---------- Tekniker: översikt ----------
async function pageAdmin(q) {
  await sb.rpc('catch_up_readings');
  const [poolsRes, latestRes, trendRes] = await Promise.all([
    must(sb.from('pools').select('id, customer_id, volume_m3, sanitizer, customers(name, contact_name, area)')),
    must(sb.from('pool_latest').select('pool_id, measured_at, ph, orp, temp')),
    must(sb.rpc('pool_trend_24h')),
  ]);
  const latestBy = new Map((latestRes.data || []).map((l) => [l.pool_id, l]));
  const trendBy = new Map((trendRes.data || []).map((t) => [t.pool_id, (t.ph || []).map(Number)]));
  const rows = (poolsRes.data || [])
    .map((p) => {
      const c = Array.isArray(p.customers) ? p.customers[0] : p.customers;
      const latest = latestBy.get(p.id) || null;
      return {
        id: p.id, customerId: p.customer_id, kund: c?.name || '', contact: c?.contact_name || '', area: c?.area || '',
        volume: p.volume_m3, sanitizer: p.sanitizer, latest, status: statusOf(latest), trend: trendBy.get(p.id) || [],
      };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.kund.localeCompare(b.kund, 'sv'));

  if (!rows.length) {
    return staffShell('overview', `<div class="card empty"><h1>Ingen data ännu</h1>
      <p class="muted">Kör filen <code>supabase/setup.sql</code> i Supabase SQL Editor för att skapa demodatan.</p></div>`);
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const sel = rows.find((r) => r.id === q.pool) || rows[0];
  const hist = (await must(sb.rpc('pool_history', { p_pool: sel.id, p_days: 7 }))).data || [];
  const newest = rows.map((r) => r.latest?.measured_at).filter(Boolean).sort().pop();
  const off = count('offline');
  const l = sel.latest;

  const tableRows = rows.map((r) => {
    const isOff = r.status === 'offline';
    return `
    <a href="${link('/admin', { pool: r.id })}" class="prow ${sel.id === r.id ? 'selected' : ''}" ${sel.id === r.id ? 'aria-current="true"' : ''}>
      <div>${pill(r.status)}</div>
      <div class="who2"><span class="strong ellipsis">${esc(r.kund)}</span><span class="muted small ellipsis">${esc(r.area)}</span></div>
      <div class="num strong v-${isOff ? 'off' : phLevel(r.latest?.ph)}">${fmt(r.latest?.ph)}</div>
      <div class="hide-sm">${sparkline(r.trend, LINE[r.status])}</div>
      <div class="num v-${isOff ? 'off' : orpLevel(r.latest?.orp)}">${r.latest?.orp != null ? `${r.latest.orp} mV` : '–'}</div>
      <div class="num hide-sm">${r.latest?.temp != null ? `${fmt(r.latest.temp)}°` : '–'}</div>
      <div class="small hide-sm ${isOff ? 'v-larm' : 'muted'}">${ago(r.latest?.measured_at)}</div>
    </a>`;
  }).join('');

  return staffShell('overview', `
    <div class="pagehead">
      <div class="stack-6">
        <h1>Översikt</h1>
        <div class="muted">${fmtDayLong(todayISO())} · senaste mätning ${newest ? fmtTime(newest) : '–'}</div>
      </div>
      <button class="btn btn-secondary" type="button" data-action="reset">${icon('refresh', 18)}Återställ demon</button>
    </div>
    ${takeFlash()}
    <div class="kpis">
      <div class="card kpi"><div class="label">Anslutna pooler</div><div class="value">${rows.length}</div><div class="sub">${off} enhet${off === 1 ? '' : 'er'} offline</div></div>
      <div class="card kpi"><div class="label">Mår bra</div><div class="value v-good">${count('ok')}</div><div class="sub">Alla värden inom gränserna</div></div>
      <div class="card kpi"><div class="label">Varningar</div><div class="value v-varning">${count('varning')}</div><div class="sub">Håll koll, åtgärda i veckan</div></div>
      <div class="card kpi kpi-alarm"><div class="label">Larm</div><div class="value">${count('larm')}</div><div class="sub">Åtgärda idag</div></div>
    </div>
    <div class="split">
      <section class="card tablecard">
        <div class="tablecard-head"><h2>Kundernas pooler</h2><div class="muted small">${rows.length} pooler · sorterat på status</div></div>
        <div class="prow head">
          <div>Status</div><div>Kund</div><div>pH</div><div class="hide-sm">pH 24 h</div><div>Redox</div><div class="hide-sm">Temp</div><div class="hide-sm">Mätt</div>
        </div>
        <div class="scroll">${tableRows}</div>
      </section>
      <section class="card detail" aria-label="Detaljer för ${esc(sel.kund)}">
        <div class="detail-head">
          <div class="stack-4">
            <h2>${esc(sel.kund)} · ${esc(sel.area)}</h2>
            <div class="muted small">${esc(sel.contact)} · ${sel.volume} m³ · ${esc(String(sel.sanitizer).toLowerCase())} · enhet i pumprum</div>
          </div>
          ${pill(sel.status)}
        </div>
        <p class="detail-text">${esc(problemText(l, sel.status))}</p>
        <div class="stack-6">
          <div class="metric-row"><div class="strong small">pH, senaste 7 dagarna</div><div class="metric num v-${phLevel(l?.ph)}">${fmt(l?.ph)}</div></div>
          ${lineChart(hist.map((h) => Number(h.ph)), { min: 6.6, max: 8.2, band: [7.2, 7.6], height: 100, label: 'pH senaste 7 dagarna' })}
          ${dayLabels()}
        </div>
        <div class="stack-6">
          <div class="metric-row"><div class="strong small">Redox (mV)</div><div class="metric num v-${orpLevel(l?.orp)}">${l?.orp ?? '–'}</div></div>
          ${lineChart(hist.map((h) => Number(h.orp)), { min: 550, max: 820, band: [650, 800], height: 70, label: 'Redox senaste 7 dagarna' })}
        </div>
        <div class="stack-6">
          <div class="metric-row"><div class="strong small">Vattentemperatur</div><div class="metric num">${l?.temp != null ? `${fmt(l.temp)}°` : '–'}</div></div>
          ${lineChart(hist.map((h) => Number(h.temp)), { min: 14, max: 28, height: 50, label: 'Temperatur senaste 7 dagarna', color: '#5B7C99' })}
          <div class="muted small">Grönt fält = målområde</div>
        </div>
        <div class="advice"><div class="strong small">Föreslagen åtgärd</div><div class="small">${esc(adviceText(l, sel.status))}</div></div>
        <div class="row-8">
          <a class="btn btn-primary grow" href="${link('/admin/rapport/ny', { pool: sel.id })}">${icon('doc', 18)}Skriv servicerapport</a>
          <button class="btn btn-secondary grow" type="button" data-action="sms" data-customer="${esc(sel.customerId)}" data-name="${esc(sel.contact || sel.kund)}" data-text="${esc(problemText(l, sel.status))}">${icon('message', 18)}Meddela kunden</button>
        </div>
        <a class="small center" href="${link('/admin/kunder', { id: sel.customerId })}">Öppna kundkortet</a>
      </section>
    </div>`);
}

// ---------- Tekniker: bokningskalender ----------
async function pageBookings(q) {
  const w = Math.max(-8, Math.min(12, Number(q.w || 0) || 0));
  const today = todayISO();
  const monday = addDays(mondayOf(today), w * 7);
  const friday = addDays(monday, 4);
  const year = today.slice(0, 4);
  const cols = 'id, pool_id, customer_id, kind, date, slot, start_h, end_h, status, note, customers(name, area)';

  const [weekRes, newRes, seasonRes, poolsRes] = await Promise.all([
    must(sb.from('bookings').select(cols).gte('date', monday).lte('date', friday)),
    must(sb.from('bookings').select(cols).eq('status', 'ny').order('date').order('start_h')),
    must(sb.from('bookings').select('pool_id').eq('kind', 'stangning').gte('date', `${year}-01-01`).lte('date', `${year}-12-31`)),
    must(sb.from('pools').select('id', { count: 'exact', head: true })),
  ]);
  const weekIds = (weekRes.data || []).map((b) => b.id);
  const reportsRes = weekIds.length
    ? await must(sb.from('service_reports').select('id, booking_id').in('booking_id', weekIds))
    : { data: [] };
  const reportBy = new Map((reportsRes.data || []).map((r) => [r.booking_id, r.id]));
  const cust = (b) => (Array.isArray(b.customers) ? b.customers[0] : b.customers) || { name: '', area: '' };
  const week = weekRes.data || [];
  const pending = newRes.data || [];
  const booked = new Set((seasonRes.data || []).map((b) => b.pool_id)).size;
  const total = poolsRes.count || 0;
  const notBooked = Math.max(0, total - booked);
  const pct = total ? Math.round((booked / total) * 100) : 0;
  const days = Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  const range = `${Number(monday.slice(8))} ${MONTH_SHORT[monthOf(monday) - 1]} – ${Number(friday.slice(8))} ${MONTH_SHORT[monthOf(friday) - 1]}`;

  const block = (b) => {
    const c = cust(b);
    const short = b.end_h - b.start_h <= 1;
    const what = KINDS[b.kind].label + (b.note ? `: ${b.note}` : '');
    const style = `top:${(b.start_h - 8) * 60 + 2}px;height:${(b.end_h - b.start_h) * 60 - 4}px`;
    const reportId = reportBy.get(b.id);
    const missing = !reportId && b.date <= today;
    const href = reportId
      ? link('/admin/rapport', { id: reportId })
      : missing ? link('/admin/rapport/ny', { booking: b.id }) : link('/admin/kunder', { id: b.customer_id });
    const tag = b.status === 'ny' ? '<span class="new-tag">NY</span>'
      : reportId ? `<span class="done-tag" title="Rapport klar">${icon('check', 12, 2.4)}</span>`
      : missing ? '<span class="miss-tag">RAPPORT</span>' : '';
    const title = `${c.name}, ${c.area} · ${b.slot} · ${what}${missing ? ' · rapport saknas, klicka för att skriva' : ''}`;
    return `
      <a href="${href}" class="block block-${b.kind} ${b.status === 'ny' ? 'block-new' : ''} ${short ? 'block-short' : ''} ${missing ? 'block-missing' : ''}" style="${style}" title="${esc(title)}">
        <div class="block-top"><span class="strong ellipsis">${esc(c.name)}</span>${tag}</div>
        ${short
          ? `<span class="small ellipsis">${esc(b.slot)} · ${esc(b.note || KINDS[b.kind].label)}</span>`
          : `<span class="small num ellipsis">${esc(b.slot)} · ${esc(c.area)}</span><span class="small strong ellipsis">${esc(what)}</span>`}
      </a>`;
  };

  const requests = pending.length
    ? pending.map((b) => {
        const c = cust(b);
        return `
        <div class="request">
          <div>
            <div class="strong">${esc(c.name)} · ${esc(c.area)}</div>
            <div class="muted small">${esc(KINDS[b.kind].label)} · ${fmtDay(b.date)} kl ${esc(b.slot)}</div>
          </div>
          <div class="row-8">
            <button class="btn btn-primary btn-sm grow" type="button" data-action="confirm" data-id="${esc(b.id)}">Bekräfta</button>
            <button class="btn btn-secondary btn-sm grow" type="button" data-action="cancel" data-id="${esc(b.id)}">Avboka</button>
          </div>
        </div>`;
      }).join('')
    : '<p class="muted small">Inga nya bokningar just nu.</p>';

  return staffShell('bookings', `
    <div class="pagehead">
      <div class="stack-6">
        <h1>Servicebesök</h1>
        <div class="muted">Vecka ${isoWeek(monday)} · ${range}</div>
      </div>
      <div class="row-10 wrap">
        <div class="legend">
          <span><i class="sw sw-cls"></i>Vinterstängning</span>
          <span><i class="sw sw-open"></i>Vårstart</span>
          <span><i class="sw sw-svc"></i>Service</span>
          <span><i class="sw sw-new"></i>Ny kundbokning</span>
          <span><i class="sw sw-miss"></i>Rapport saknas</span>
        </div>
        <a class="btn btn-secondary icon-btn" href="${link('/admin/bokningar', { w: w - 1 })}" aria-label="Föregående vecka">${icon('left')}</a>
        <a class="btn btn-secondary" href="#/admin/bokningar">Idag</a>
        <a class="btn btn-secondary icon-btn" href="${link('/admin/bokningar', { w: w + 1 })}" aria-label="Nästa vecka">${icon('right')}</a>
      </div>
    </div>
    ${takeFlash()}
    <div class="split split-360">
      <section class="card weekcard" aria-label="Veckokalender">
        <div class="week">
          <div class="week-head-spacer"></div>
          ${days.map((d, i) => `
            <div class="week-head ${d === today ? 'is-today' : ''}">
              <div class="small strong muted">${DAY_SHORT[i]}</div>
              <div class="week-date">${Number(d.slice(8))} ${MONTH_SHORT[monthOf(d) - 1]}</div>
            </div>`).join('')}
          <div class="week-hours">${[8, 9, 10, 11, 12, 13, 14, 15, 16].map((h) => `<div class="week-hour">${String(h).padStart(2, '0')}</div>`).join('')}</div>
          ${days.map((d) => `
            <div class="week-col ${d === today ? 'is-today' : ''} ${d < today ? 'is-past' : ''}">
              ${week.filter((b) => b.date === d).map(block).join('')}
            </div>`).join('')}
        </div>
      </section>
      <div class="stack-16">
        <section class="card side-card">
          <div class="side-card-head"><h2>Nya kundbokningar</h2><span class="muted small">${pending.length} att bekräfta</span></div>
          ${requests}
        </section>
        <section class="card side-card">
          <h2>Säsongen</h2>
          <div class="stack-6">
            <div class="row-between small"><span class="strong">Vinterstängning ${year}</span><span>${booked} av ${total} bokade</span></div>
            <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Andel bokade vinterstängningar"><div style="width:${pct}%"></div></div>
            <div class="muted small">${notBooked} kunder har inte bokat ännu</div>
          </div>
          <button class="btn btn-secondary btn-block" type="button" data-action="remind" data-n="${notBooked}" ${notBooked ? '' : 'disabled'}>Skicka påminnelse till ${notBooked} kunder</button>
          <div class="divider"></div>
          <div class="stack-4"><div class="strong small">Vårstart ${Number(year) + 1}</div><div class="muted small">Kunderna kan boka från 1 mars</div></div>
        </section>
        <p class="muted small pad-4">Kunderna bokar själva i lediga tider, vardagar 08–16. Nya bokningar hamnar här för bekräftelse. Klicka på ett genomfört besök för att skriva eller läsa servicerapporten.</p>
      </div>
    </div>`);
}

// ---------- Kund: startsida ----------
const HERO = {
  ok: { title: 'Poolen mår bra', cls: 'hero-ok' },
  varning: { title: 'Håll lite koll', cls: 'hero-varning' },
  larm: { title: 'Poolen behöver åtgärdas', cls: 'hero-larm' },
  offline: { title: 'Vi får inga mätvärden', cls: 'hero-offline' },
};
const LEVEL_TEXT = { ok: 'bra', varning: 'utanför målet', larm: 'åtgärda' };

async function myPool() {
  // RLS gör att kunden bara får sin egen pool
  const { data } = await must(sb.from('pools').select('id, volume_m3, customers(name, contact_name, area)').limit(1));
  const pool = (data || [])[0];
  if (!pool) return null;
  pool.customer = Array.isArray(pool.customers) ? pool.customers[0] : pool.customers;
  return pool;
}

async function pageKund() {
  await sb.rpc('catch_up_readings');
  const pool = await myPool();
  if (!pool) return customerShell('home', '<div class="card empty"><h1>Ingen pool kopplad</h1><p class="muted">Kontakta Didriksons.</p></div>');
  const today = todayISO();
  const [latestRes, histRes, bookingsRes, unreadRes] = await Promise.all([
    must(sb.from('pool_latest').select('pool_id, measured_at, ph, orp, temp').eq('pool_id', pool.id).maybeSingle()),
    must(sb.rpc('pool_history', { p_pool: pool.id, p_days: 7 })),
    must(sb.from('bookings').select('id, kind, date, slot, status').gte('date', today).order('date')),
    sb.from('messages').select('id', { count: 'exact', head: true }).is('read_at', null),
  ]);
  const unread = unreadRes.count || 0;
  const l = latestRes.data;
  const hist = histRes.data || [];
  const bookings = bookingsRes.data || [];
  const status = statusOf(l);
  const hero = HERO[status];
  const firstName = (profile.full_name || pool.customer?.contact_name || '').split(' ')[0];
  const suggest = seasonalKind(monthOf(today));
  const hasSeasonal = bookings.some((b) => b.kind === suggest);
  const ph = phLevel(l?.ph);
  const orp = orpLevel(l?.orp);
  const heroSub =
    status === 'ok' ? `Alla värden inom målområdet · mätt ${ago(l?.measured_at)}`
    : status === 'offline' ? `Senaste mätning ${ago(l?.measured_at)}. Kontrollera att poolpumpen har ström.`
    : `Vi har sett det och hör av oss om vi behöver komma ut. Mätt ${ago(l?.measured_at)}.`;

  const bookingRows = bookings.length
    ? bookings.map((b) => `
      <div class="card pad-14-16 booking-row">
        <div class="grow"><div class="strong">${esc(KINDS[b.kind].label)}</div><div class="muted small">${fmtDay(b.date)} kl ${esc(b.slot)}</div></div>
        ${b.status === 'bekraftad'
          ? pill('ok', 'Bekräftad')
          : `<div class="booking-actions">${pill('varning', 'Väntar på bekräftelse')}
               <button class="linkbtn" type="button" data-action="cancel-own" data-id="${esc(b.id)}">Avboka</button></div>`}
      </div>`).join('')
    : '<p class="muted small">Inga kommande besök.</p>';

  return customerShell('home', `
    <div class="stack-14">
      <div class="kund-head"><div><div class="muted small">Didriksons Poolkollen</div><h1>Hej ${esc(firstName)}!</h1></div></div>
      ${takeFlash()}
      ${unread ? `<a class="card notice" href="#/kund/meddelanden">${icon('mail', 20)}<span class="grow">Du har ${unread} ${unread === 1 ? 'nytt meddelande' : 'nya meddelanden'}</span>${icon('right', 18)}</a>` : ''}
      <div class="hero ${hero.cls}">
        <div class="hero-sub"><span class="hero-dot"></span>Din pool · ${esc(pool.customer?.area)}</div>
        <div class="hero-title">${hero.title}</div>
        <div class="hero-sub">${esc(heroSub)}</div>
      </div>
      <div class="tiles">
        <div class="card tile"><div class="muted small">pH</div><div class="tile-value">${fmt(l?.ph)}</div>
          <div class="tile-note v-${ph === 'ok' ? 'good' : ph}">${ph === 'ok' ? 'Mål 7,2–7,6' : LEVEL_TEXT[ph]}</div></div>
        <div class="card tile"><div class="muted small">Klor (redox)</div><div class="tile-value">${l?.orp ?? '–'}</div>
          <div class="tile-note v-${orp === 'ok' ? 'good' : orp}">mV · ${LEVEL_TEXT[orp]}</div></div>
        <div class="card tile"><div class="muted small">Vatten</div><div class="tile-value">${l?.temp != null ? `${fmt(l.temp)}°` : '–'}</div>
          <div class="tile-note muted">${pool.volume_m3} m³</div></div>
      </div>
      <section class="card pad-16-20 stack-8">
        <div class="row-between"><h2 class="h-small">pH senaste veckan</h2>${pill(status)}</div>
        ${lineChart(hist.map((h) => Number(h.ph)), { min: 6.6, max: 8.2, band: [7.2, 7.6], height: 90, label: 'pH senaste veckan' })}
        ${dayLabels()}
        <a class="small" href="#/kund/historik">Se mer historik och tidigare besök</a>
      </section>
      ${hasSeasonal ? '' : `
      <section class="card pad-16-20 cta">
        <div class="cta-icon">${icon('calendar', 22)}</div>
        <div class="grow">
          <div class="strong">${suggest === 'service' ? 'Behöver poolen service?' : `Dags att boka ${KINDS[suggest].label.toLowerCase()}`}</div>
          <div class="muted small">Välj en ledig tid som passar dig</div>
        </div>
        <a class="btn btn-primary btn-sm" href="${link('/kund/boka', { kind: suggest })}">Boka</a>
      </section>`}
      <section class="stack-8"><h2 class="h-small">Mina bokningar</h2>${bookingRows}</section>
    </div>`);
}

// ---------- Kund: boka ----------
async function pageBoka(q) {
  const today = todayISO();
  const kind = KINDS[q.kind] ? q.kind : seasonalKind(monthOf(today));
  const k = KINDS[kind];
  const { data } = await must(sb.rpc('booked_ranges', { p_from: today, p_to: addDays(monthStart(today, 12), -1) }));
  const ranges = data || [];

  const inSeason = (date) => !k.months || k.months.includes(monthOf(date));
  const freeSlots = (date) => {
    if (!inSeason(date) || date <= today || dow(date) >= 5) return [];
    return k.slots.filter((s) => {
      const [a, b] = parseSlot(s);
      return !ranges.some((r) => r.date === date && r.start_h < b && r.end_h > a);
    });
  };
  const monthDates = (offset) => {
    const f = monthStart(today, offset);
    return Array.from({ length: daysInMonth(f) }, (_, i) => addDays(f, i));
  };

  // Utan vald månad: öppna första månaden som har lediga tider
  let m = Math.max(0, Math.min(11, Number(q.m || 0) || 0));
  if (q.m == null) {
    for (let i = 0; i <= 11; i++) {
      if (monthDates(i).some((d) => freeSlots(d).length)) { m = i; break; }
    }
  }
  const first = monthStart(today, m);
  const month = monthOf(first);
  const seasonOpen = !k.months || k.months.includes(month);
  const dates = monthDates(m);
  const freeBy = new Map(dates.map((d) => [d, freeSlots(d)]));
  const day = q.d && freeBy.get(q.d)?.length ? q.d : dates.find((d) => freeBy.get(d).length) || null;
  const daySlots = day ? freeBy.get(day) : [];
  const slot = q.s && daySlots.includes(q.s) ? q.s : null;
  const href = (o) => link('/kund/boka', { kind, m, ...o });

  let nextOpen = null;
  if (!seasonOpen && k.months) {
    for (let i = 1; i <= 12; i++) if (k.months.includes(monthOf(monthStart(today, i)))) { nextOpen = i; break; }
  }
  const monthName = MONTHS[month - 1];

  const cells = [
    ...Array.from({ length: dow(first) }, () => '<span></span>'),
    ...dates.map((d) => {
      const n = Number(d.slice(8));
      if (freeBy.get(d).length) {
        return `<a href="${href({ d })}" class="cal-day free ${d === day ? 'selected' : ''}" aria-label="${fmtDay(d)}, lediga tider" ${d === day ? 'aria-current="date"' : ''}>${n}</a>`;
      }
      const cls = dow(d) >= 5 ? 'weekend' : d <= today || !seasonOpen ? 'closed' : 'full';
      return `<span class="cal-day ${cls}" aria-label="${fmtDay(d)}, ej bokningsbart">${n}</span>`;
    }),
  ].join('');

  const slots = day ? `
    <section class="stack-8">
      <h2 class="h-label">Lediga tider ${fmtDay(day)}</h2>
      <div class="slots">
        ${k.slots.map((s) => daySlots.includes(s)
          ? `<a href="${href({ d: day, s })}" class="slot ${s === slot ? 'selected' : ''}" ${s === slot ? 'aria-current="true"' : ''}>${s}</a>`
          : `<span class="slot taken" aria-label="${s} upptagen">${s}</span>`).join('')}
      </div>
    </section>` : '';

  return customerShell('book', `
    <div class="stack-16">
      <div class="stack-4">
        <a href="#/kund" class="back">${icon('left', 18)}Tillbaka</a>
        <h1>Boka besök</h1>
      </div>
      ${q.fel ? `<div class="flash flash-err" role="alert">${esc(q.fel)}</div>` : ''}
      <section class="stack-8">
        <h2 class="h-label">Vad vill du boka?</h2>
        <div class="kinds">
          ${Object.keys(KINDS).map((key) => `
            <a href="${link('/kund/boka', { kind: key })}" class="kind ${key === kind ? 'active' : ''}" ${key === kind ? 'aria-current="true"' : ''}>
              <span class="kind-title">${KINDS[key].card}</span><span class="kind-sub">${KINDS[key].sub}</span>
            </a>`).join('')}
        </div>
      </section>
      <section class="card cal">
        <div class="cal-head">
          ${m > 0 ? `<a class="icon-link" href="${href({ m: m - 1, d: null })}" aria-label="Föregående månad">${icon('left')}</a>` : `<span class="icon-link disabled" aria-hidden="true">${icon('left')}</span>`}
          <div class="cal-title">${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${first.slice(0, 4)}</div>
          ${m < 11 ? `<a class="icon-link" href="${href({ m: m + 1, d: null })}" aria-label="Nästa månad">${icon('right')}</a>` : `<span class="icon-link disabled" aria-hidden="true">${icon('right')}</span>`}
        </div>
        <div class="cal-grid cal-dows">${DAY_SHORT.map((d) => `<div>${d}</div>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend"><span><i class="lg-free"></i>Ledigt</span><span><s>12</s> Fullbokat</span></div>
        ${!seasonOpen ? `<div class="advice small">${k.label} bokas ${k.season}. ${nextOpen != null ? `<a href="${href({ m: nextOpen, d: null })}">Visa ${MONTHS[monthOf(monthStart(today, nextOpen)) - 1]}</a>` : ''}</div>` : ''}
        ${seasonOpen && !day ? '<div class="advice small">Inga lediga tider den här månaden. Prova nästa månad.</div>' : ''}
      </section>
      ${slots}
      <div class="book-bar">
        <div class="muted small center">Ingår i ditt serviceavtal · avboka senast dagen innan</div>
        ${day && slot
          ? `<button class="btn btn-primary btn-block btn-lg" type="button" data-action="book" data-kind="${kind}" data-date="${day}" data-slot="${slot}" data-m="${m}">Boka ${fmtDay(day)} kl ${slot}</button>`
          : '<button class="btn btn-block btn-lg" type="button" disabled>Välj dag och tid</button>'}
      </div>
    </div>`);
}

// ---------- Kund: bokat ----------
async function pageKlart(q) {
  const { data: b } = q.id ? await sb.from('bookings').select('kind, date, slot').eq('id', q.id).maybeSingle() : { data: null };
  const k = b ? KINDS[b.kind] : null;
  return customerShell('book', `
    <div class="done">
      <div class="done-check">${icon('check', 36, 2)}</div>
      <h1>Bokat!</h1>
      ${b && k ? `<div class="done-what">${esc(k.label)} ${fmtDay(b.date)} kl ${esc(b.slot)}</div>` : ''}
      <p class="muted">Bokningen väntar på bekräftelse från oss. Du ser status under Mina bokningar. Du behöver inte vara hemma, men poolen ska vara åtkomlig.</p>
      ${k ? `<div class="card pad-16 done-tasks"><div class="strong small">Det här gör vi</div><ul>${k.tasks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      <div class="stack-10 full">
        <a href="#/kund" class="btn btn-primary btn-block btn-lg">Till startsidan</a>
        <a href="#/kund/boka" class="btn btn-secondary btn-block">Boka något mer</a>
      </div>
    </div>`);
}

// ------------------------------------------------------------------
// Fler hjälpare för larm, rapporter och statistik
// ------------------------------------------------------------------
const ALARM_KIND = { ph_hog: 'pH högt', ph_lag: 'pH lågt', redox_lag: 'Lågt redox', offline: 'Offline' };
const CHEMS = [
  ['pH-minus', 'kg'], ['pH-plus', 'kg'], ['Klorgranulat', 'kg'], ['Chockklor', 'kg'], ['Flockningsmedel', 'l'], ['Vinterkemikalier', 'l'],
];
const isoDateOf = (iso) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const fmtDateTime = (iso) => `${fmtDay(isoDateOf(iso))} ${fmtTime(iso)}`;
function durText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} tim`;
  return `${Math.round(h / 24)} dagar`;
}
const fmtAmount = (c) => `${fmt(c.amount, Number(c.amount) % 1 ? 1 : 0)} ${c.unit} ${c.name}`;
const levelPill = (a) => pill(a.level === 'larm' ? 'larm' : 'varning', a.level === 'larm' ? 'Larm' : 'Varning');
const numOrNull = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const firstOf = (x) => (Array.isArray(x) ? x[0] : x) || null;

function barList(items, cls = '') {
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div class="barlist">${items.map((i) => `
    <div class="barlist-row">
      <div class="barlist-label ellipsis">${esc(i.label)}</div>
      <div class="barlist-track"><div class="barlist-fill ${cls}" style="width:${Math.round((i.value / max) * 100)}%"></div></div>
      <div class="barlist-value num">${esc(i.display ?? i.value)}</div>
    </div>`).join('')}</div>`;
}

// ---------- Tekniker: larm ----------
async function pageAlarms(q) {
  const tab = q.visa === 'alla' ? 'alla' : 'aktiva';
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const cols = 'id, pool_id, customer_id, kind, level, message, started_at, resolved_at, acknowledged_at, acknowledged_by, comment, customers(name, area)';
  const [activeRes, allRes] = await Promise.all([
    must(sb.from('alarms').select(cols).is('resolved_at', null).order('started_at', { ascending: false })),
    must(sb.from('alarms').select(cols).gte('started_at', since).order('started_at', { ascending: false })),
  ]);
  const active = activeRes.data || [];
  const list = tab === 'aktiva' ? active : allRes.data || [];
  const unacked = active.filter((a) => !a.acknowledged_at).length;

  const row = (a) => {
    const c = firstOf(a.customers) || {};
    const end = a.resolved_at ? new Date(a.resolved_at) : new Date();
    const dur = durText(end - new Date(a.started_at));
    let side;
    if (a.resolved_at) {
      side = `${pill('ok', 'Åtgärdat')}<div class="muted small">${esc(a.comment || '')}</div>`;
    } else if (a.acknowledged_at) {
      side = `<div class="small"><span class="strong">Kvitterat</span> av ${esc(a.acknowledged_by || '')} · ${ago(a.acknowledged_at)}</div>
              ${a.comment ? `<div class="muted small quote">"${esc(a.comment)}"</div>` : ''}
              <a class="small" href="${link('/admin/rapport/ny', { pool: a.pool_id })}">Skriv servicerapport</a>`;
    } else {
      side = `<form class="ack-form" data-id="${esc(a.id)}">
                <label class="sr-only" for="ack-${esc(a.id)}">Kommentar</label>
                <input id="ack-${esc(a.id)}" name="comment" type="text" placeholder="Kommentar (valfritt)" autocomplete="off">
                <button class="btn btn-primary btn-sm" type="submit">Kvittera</button>
              </form>`;
    }
    return `
      <div class="card alarm-row ${!a.resolved_at && !a.acknowledged_at ? `alarm-open alarm-${a.level}` : ''}">
        <div class="alarm-main">
          <div class="row-8 wrap">${levelPill(a)}<span class="muted small">${ALARM_KIND[a.kind]}</span></div>
          <div class="strong">${esc(a.message)}</div>
          <div class="small"><a href="${link('/admin', { pool: a.pool_id })}">${esc(c.name)} · ${esc(c.area)}</a></div>
          <div class="muted small">Startade ${fmtDateTime(a.started_at)} · ${a.resolved_at ? `varade ${dur}` : `pågått ${dur}`}</div>
        </div>
        <div class="alarm-side">${side}</div>
      </div>`;
  };

  return staffShell('alarms', `
    <div class="pagehead">
      <div class="stack-6">
        <h1>Larm</h1>
        <div class="muted">${active.length} aktiva · ${unacked} väntar på kvittering</div>
      </div>
      <div class="seg" role="tablist" aria-label="Visa">
        <a href="#/admin/larm" role="tab" aria-selected="${tab === 'aktiva'}" class="${tab === 'aktiva' ? 'active' : ''}">Aktiva (${active.length})</a>
        <a href="${link('/admin/larm', { visa: 'alla' })}" role="tab" aria-selected="${tab === 'alla'}" class="${tab === 'alla' ? 'active' : ''}">Senaste 30 dagarna (${(allRes.data || []).length})</a>
      </div>
    </div>
    ${takeFlash()}
    <div class="stack-10">${list.length ? list.map(row).join('') : '<div class="card empty"><p class="muted">Inga larm här.</p></div>'}</div>
    <p class="muted small pad-4">Larm skapas automatiskt när pH eller redox ligger utanför gränserna, eller när en enhet slutar rapportera. Kvittera för att visa att någon tar hand om det. Larmet stängs när en servicerapport markerar det som åtgärdat.</p>`);
}

// ---------- Tekniker: kunder och pooler ----------
async function pageCustomers(q) {
  const [custRes, latestRes] = await Promise.all([
    must(sb.from('customers').select('id, name, contact_name, area, since_year, plan, pools(id, size_text, pool_type, volume_m3, sanitizer, installed_year, device_serial, calibrated_at)').order('name')),
    must(sb.from('pool_latest').select('pool_id, measured_at, ph, orp, temp')),
  ]);
  const latestBy = new Map((latestRes.data || []).map((l) => [l.pool_id, l]));
  const customers = (custRes.data || []).map((c) => {
    const pool = firstOf(c.pools);
    const latest = pool ? latestBy.get(pool.id) || null : null;
    return { ...c, pool, latest, status: statusOf(latest) };
  });
  if (!customers.length) return staffShell('customers', '<div class="card empty"><h1>Inga kunder</h1></div>');
  const sel = customers.find((c) => c.id === q.id) || customers[0];
  const p = sel.pool;
  const today = todayISO();

  const [bookRes, repRes, alRes] = await Promise.all([
    must(sb.from('bookings').select('id, kind, date, slot, status').eq('customer_id', sel.id).gte('date', today).order('date')),
    must(sb.from('service_reports').select('id, kind, visited_at, technician').eq('customer_id', sel.id).order('visited_at', { ascending: false }).limit(8)),
    must(sb.from('alarms').select('id, kind, level, message, started_at, resolved_at, acknowledged_at').eq('customer_id', sel.id).order('started_at', { ascending: false }).limit(6)),
  ]);
  const l = sel.latest;

  const list = customers.map((c) => `
    <a href="${link('/admin/kunder', { id: c.id })}" class="cust-row ${c.id === sel.id ? 'selected' : ''}" data-name="${esc(`${c.name} ${c.contact_name} ${c.area}`.toLowerCase())}" ${c.id === sel.id ? 'aria-current="true"' : ''}>
      <div class="who2"><span class="strong ellipsis">${esc(c.name)}</span><span class="muted small ellipsis">${esc(c.contact_name)} · ${esc(c.area)}</span></div>
      ${pill(c.status)}
    </a>`).join('');

  const fact = (label, value) => `<div class="fact"><dt>${label}</dt><dd>${esc(value ?? '–')}</dd></div>`;
  const bookings = (bookRes.data || []).map((b) => `
    <li><span class="strong">${esc(KINDS[b.kind].label)}</span> <span class="muted">${fmtDay(b.date)} kl ${esc(b.slot)}</span>
      ${b.status === 'ny' ? pill('varning', 'Obekräftad') : ''}</li>`).join('') || '<li class="muted">Inga bokade besök</li>';
  const reports = (repRes.data || []).map((r) => `
    <li><a href="${link('/admin/rapport', { id: r.id })}">${esc(KINDS[r.kind].label)} ${fmtDay(r.visited_at)}</a> <span class="muted">· ${esc(r.technician || '')}</span></li>`).join('') || '<li class="muted">Inga rapporter än</li>';
  const alarms = (alRes.data || []).map((a) => `
    <li>${levelPill(a)} <span>${esc(a.message)}</span> <span class="muted">· ${fmtDay(isoDateOf(a.started_at))}</span>
      ${a.resolved_at ? '<span class="muted">· åtgärdat</span>' : a.acknowledged_at ? '<span class="muted">· kvitterat</span>' : '<span class="v-larm">· okvitterat</span>'}</li>`).join('') || '<li class="muted">Inga larm</li>';

  return staffShell('customers', `
    <div class="pagehead">
      <div class="stack-6"><h1>Kunder och pooler</h1><div class="muted">${customers.length} kunder med övervakning</div></div>
    </div>
    ${takeFlash()}
    <div class="split split-cust">
      <section class="card custlist">
        <div class="custlist-search">
          <label class="sr-only" for="cust-search">Sök kund</label>
          <input id="cust-search" type="search" placeholder="Sök namn eller område" autocomplete="off">
        </div>
        <div class="custlist-rows">${list}</div>
      </section>
      <section class="card cust-detail">
        <div class="detail-head">
          <div class="stack-4">
            <h2>${esc(sel.name)} · ${esc(sel.area)}</h2>
            <div class="muted small">${esc(sel.contact_name)} · kund sedan ${esc(sel.since_year ?? '–')}</div>
          </div>
          <span class="plan-tag plan-${esc(String(sel.plan).toLowerCase())}">Avtal ${esc(sel.plan)}</span>
        </div>

        <div class="nowbox">
          ${pill(sel.status)}
          <div class="nowvals">
            <span>pH <b class="num v-${phLevel(l?.ph)}">${fmt(l?.ph)}</b></span>
            <span>Redox <b class="num v-${orpLevel(l?.orp)}">${l?.orp ?? '–'}</b></span>
            <span>Vatten <b class="num v-ok">${l?.temp != null ? `${fmt(l.temp)}°` : '–'}</b></span>
          </div>
          <span class="muted small">Mätt ${ago(l?.measured_at)}</span>
        </div>

        <div>
          <h3 class="h-small">Poolen</h3>
          <dl class="facts">
            ${fact('Storlek', p?.size_text)}${fact('Typ', p?.pool_type)}${fact('Volym', p ? `${p.volume_m3} m³` : null)}
            ${fact('Desinfektion', p?.sanitizer)}${fact('Byggd', p?.installed_year)}${fact('Sensorenhet', p?.device_serial)}
            ${fact('Kalibrerad', p?.calibrated_at ? fmtDay(p.calibrated_at) : null)}
          </dl>
        </div>

        <div class="cols-2">
          <div><h3 class="h-small">Kommande besök</h3><ul class="plain">${bookings}</ul></div>
          <div><h3 class="h-small">Servicerapporter</h3><ul class="plain">${reports}</ul></div>
        </div>
        <div><h3 class="h-small">Larmhistorik</h3><ul class="plain">${alarms}</ul></div>

        <div class="row-8 wrap">
          ${p ? `<a class="btn btn-primary" href="${link('/admin/rapport/ny', { pool: p.id })}">${icon('doc', 18)}Skriv servicerapport</a>
                 <a class="btn btn-secondary" href="${link('/admin', { pool: p.id })}">Visa mätvärden</a>` : ''}
        </div>
      </section>
    </div>`);
}

// ---------- Tekniker: skriv servicerapport ----------
async function pageReportNew(q) {
  let poolId = q.pool || null;
  let booking = null;
  if (q.booking) {
    booking = (await must(sb.from('bookings').select('id, pool_id, kind, date, slot').eq('id', q.booking).maybeSingle())).data;
    poolId = booking?.pool_id || poolId;
  }
  if (!poolId) return go('/admin/kunder');
  const [poolRes, latestRes, alRes] = await Promise.all([
    must(sb.from('pools').select('id, customer_id, volume_m3, customers(name, contact_name, area)').eq('id', poolId).maybeSingle()),
    must(sb.from('pool_latest').select('ph, orp, measured_at').eq('pool_id', poolId).maybeSingle()),
    must(sb.from('alarms').select('id', { count: 'exact', head: true }).eq('pool_id', poolId).is('resolved_at', null)),
  ]);
  const pool = poolRes.data;
  if (!pool) return go('/admin/kunder');
  const c = firstOf(pool.customers) || {};
  const l = latestRes.data;
  const activeAlarms = alRes.count || 0;
  const kindLabel = KINDS[booking?.kind || 'service'].label;

  return staffShell('customers', `
    <div class="pagehead">
      <div class="stack-6">
        <a class="back" href="${link('/admin/kunder', { id: pool.customer_id })}">${icon('left', 18)}${esc(c.name)}</a>
        <h1>Ny servicerapport</h1>
        <div class="muted">${esc(kindLabel)} · ${esc(c.name)}, ${esc(c.area)} · ${pool.volume_m3} m³${booking ? ` · bokat ${fmtDay(booking.date)} kl ${esc(booking.slot)}` : ''}</div>
      </div>
    </div>
    ${takeFlash()}
    <form id="report-form" class="card report-form" data-pool="${esc(pool.id)}" data-booking="${esc(booking?.id || '')}" data-customer="${esc(pool.customer_id)}">
      <label class="field">Datum för besöket
        <input type="date" name="date" value="${esc(booking?.date || todayISO())}" required>
      </label>

      <fieldset>
        <legend>Mätvärden</legend>
        <div class="grid-2">
          <label class="field">pH före<input type="number" name="ph_before" step="0.01" min="5" max="9" value="${l?.ph ?? ''}"></label>
          <label class="field">pH efter<input type="number" name="ph_after" step="0.01" min="5" max="9" placeholder="t.ex. 7,4"></label>
          <label class="field">Redox före (mV)<input type="number" name="orp_before" step="1" min="0" max="1200" value="${l?.orp ?? ''}"></label>
          <label class="field">Redox efter (mV)<input type="number" name="orp_after" step="1" min="0" max="1200" placeholder="t.ex. 720"></label>
        </div>
        <p class="muted small">Värdena före är hämtade från sensorn (${ago(l?.measured_at)}).</p>
      </fieldset>

      <fieldset>
        <legend>Tillsatt kemi</legend>
        <div class="chem-grid">
          ${CHEMS.map(([name, unit], i) => `
            <label class="chem">
              <span>${name}</span>
              <span class="chem-input"><input type="number" name="chem_${i}" step="0.1" min="0" placeholder="0"><span class="muted">${unit}</span></span>
            </label>`).join('')}
        </div>
      </fieldset>

      <label class="field">Anteckningar till kunden
        <textarea name="notes" rows="4" placeholder="Vad gjordes och vad bör kunden tänka på?"></textarea>
      </label>

      ${activeAlarms ? `
      <label class="check">
        <input type="checkbox" name="resolve" checked>
        <span>Markera poolens ${activeAlarms} aktiva larm som åtgärdade</span>
      </label>` : ''}

      <div class="row-8 wrap">
        <button class="btn btn-primary" type="submit">${icon('check', 18, 2)}Spara och skicka till kunden</button>
        <a class="btn btn-secondary" href="${link('/admin/kunder', { id: pool.customer_id })}">Avbryt</a>
      </div>
    </form>`);
}

// ---------- Servicerapport (visas för både personal och kund) ----------
async function pageReport(q, staffView) {
  const { data: r } = await must(sb.from('service_reports').select('*, customers(name, contact_name, area)').eq('id', q.id || '00000000-0000-0000-0000-000000000000').maybeSingle());
  const shell = (html) => (staffView ? staffShell('customers', html) : customerShell('history', html));
  if (!r) return shell('<div class="card empty"><h1>Rapporten hittades inte</h1></div>');
  const c = firstOf(r.customers) || {};
  const chems = Array.isArray(r.chemicals) ? r.chemicals : [];
  const back = staffView ? link('/admin/kunder', { id: r.customer_id }) : '#/kund/historik';
  const val = (v, lvl, d = 1) => (v == null ? '<span class="muted">–</span>' : `<span class="num strong v-${lvl(v)}">${d ? fmt(v, d) : v}</span>`);

  return shell(`
    <div class="stack-16 report-view">
      <div class="stack-4">
        <a class="back" href="${back}">${icon('left', 18)}Tillbaka</a>
        <h1>Servicerapport</h1>
        <div class="muted">${esc(KINDS[r.kind]?.label || 'Servicebesök')} · ${fmtDayLong(r.visited_at)} · ${esc(r.technician || 'Didriksons')}</div>
      </div>
      ${takeFlash()}
      <section class="card pad-16-20 stack-10">
        ${staffView ? `<div class="small"><span class="strong">${esc(c.name)}</span> · ${esc(c.contact_name)} · ${esc(c.area)}</div>` : ''}
        <table class="vals">
          <thead><tr><th scope="col">Värde</th><th scope="col">Före</th><th scope="col">Efter</th></tr></thead>
          <tbody>
            <tr><th scope="row">pH</th><td>${val(r.ph_before, phLevel)}</td><td>${val(r.ph_after, phLevel)}</td></tr>
            <tr><th scope="row">Redox (mV)</th><td>${val(r.orp_before, orpLevel, 0)}</td><td>${val(r.orp_after, orpLevel, 0)}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="card pad-16-20 stack-8">
        <h2 class="h-small">Tillsatt kemi</h2>
        ${chems.length ? `<ul class="plain">${chems.map((ch) => `<li>${esc(fmtAmount(ch))}</li>`).join('')}</ul>` : '<p class="muted small">Ingen kemi behövde tillsättas.</p>'}
      </section>
      <section class="card pad-16-20 stack-8">
        <h2 class="h-small">Anteckningar</h2>
        <p>${esc(r.notes || 'Inga anteckningar.')}</p>
      </section>
    </div>`);
}

// ---------- Tekniker: statistik ----------
async function pageStats() {
  const since = new Date(Date.now() - 35 * 86400000);
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [alRes, repRes, latestRes, upRes] = await Promise.all([
    must(sb.from('alarms').select('kind, level, started_at, acknowledged_at, resolved_at, customers(name)').gte('started_at', since.toISOString())),
    must(sb.from('service_reports').select('kind, visited_at, chemicals').gte('visited_at', isoDateOf(since30.toISOString()))),
    must(sb.from('pool_latest').select('pool_id, measured_at, ph, orp, temp')),
    must(sb.from('bookings').select('id', { count: 'exact', head: true }).gte('date', todayISO())),
  ]);
  const alarms = alRes.data || [];
  const a30 = alarms.filter((a) => new Date(a.started_at) >= since30);
  const acked = a30.filter((a) => a.acknowledged_at);
  const avgAck = acked.length
    ? Math.round(acked.reduce((s, a) => s + (new Date(a.acknowledged_at) - new Date(a.started_at)), 0) / acked.length / 60000)
    : null;
  const ackText = avgAck == null ? '–' : avgAck >= 120 ? `${fmt(avgAck / 60, 1)}<span class="unit">tim</span>` : `${avgAck}<span class="unit">min</span>`;
  const reports = repRes.data || [];
  const latest = latestRes.data || [];
  const okCount = latest.filter((l) => statusOf(l) === 'ok').length;
  const okPct = latest.length ? Math.round((okCount / latest.length) * 100) : 0;

  // Larm per vecka (5 veckor)
  const thisMonday = mondayOf(todayISO());
  const weeks = Array.from({ length: 5 }, (_, i) => addDays(thisMonday, (i - 4) * 7));
  const perWeek = weeks.map((w) => {
    const inWeek = alarms.filter((a) => { const d = isoDateOf(a.started_at); return d >= w && d < addDays(w, 7); });
    return { w, larm: inWeek.filter((a) => a.level === 'larm').length, varning: inWeek.filter((a) => a.level === 'varning').length };
  });
  const maxW = Math.max(1, ...perWeek.map((p) => p.larm + p.varning));
  const W = 560, H = 180, bw = 56, gap = (W - bw * 5) / 5;
  const bars = perWeek.map((p, i) => {
    const x = gap / 2 + i * (bw + gap);
    const hv = (p.varning / maxW) * (H - 30);
    const hl = (p.larm / maxW) * (H - 30);
    const total = p.larm + p.varning;
    return `
      <rect x="${x}" y="${H - hv}" width="${bw}" height="${hv}" fill="#E9B45F" rx="3"/>
      <rect x="${x}" y="${H - hv - hl}" width="${bw}" height="${hl}" fill="#C62828" rx="3"/>
      <text x="${x + bw / 2}" y="${H - hv - hl - 6}" text-anchor="middle" class="svg-num">${total}</text>
      <text x="${x + bw / 2}" y="${H + 18}" text-anchor="middle" class="svg-label">v ${isoWeek(p.w)}</text>`;
  }).join('');

  // Topplista och typer
  const byPool = {};
  a30.forEach((a) => { const n = firstOf(a.customers)?.name || '–'; byPool[n] = (byPool[n] || 0) + 1; });
  const top = Object.entries(byPool).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
  const byKind = Object.keys(ALARM_KIND).map((k) => ({ label: ALARM_KIND[k], value: a30.filter((a) => a.kind === k).length }));

  // Kemikalier
  const chem = {};
  reports.forEach((r) => (Array.isArray(r.chemicals) ? r.chemicals : []).forEach((c) => {
    const key = `${c.name}|${c.unit}`;
    chem[key] = (chem[key] || 0) + Number(c.amount || 0);
  }));
  const chemItems = Object.entries(chem).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const [name, unit] = k.split('|');
    return { label: name, value: v, display: `${fmt(v, v % 1 ? 1 : 0)} ${unit}` };
  });

  return staffShell('stats', `
    <div class="pagehead">
      <div class="stack-6"><h1>Statistik</h1><div class="muted">Senaste 30 dagarna</div></div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="label">Larm</div><div class="value">${a30.length}</div><div class="sub">varav ${a30.filter((a) => a.level === 'larm').length} allvarliga</div></div>
      <div class="card kpi"><div class="label">Tid till kvittering</div><div class="value">${ackText}</div><div class="sub">i snitt</div></div>
      <div class="card kpi"><div class="label">Genomförda besök</div><div class="value">${reports.length}</div><div class="sub">${upRes.count || 0} bokade framåt</div></div>
      <div class="card kpi"><div class="label">Inom målområdet nu</div><div class="value v-good">${okPct}<span class="unit">%</span></div><div class="sub">${okCount} av ${latest.length} pooler</div></div>
    </div>
    <div class="stats-grid">
      <section class="card side-card">
        <div class="side-card-head"><h2>Larm per vecka</h2>
          <div class="legend"><span><i class="sw" style="background:#C62828"></i>Larm</span><span><i class="sw" style="background:#E9B45F"></i>Varning</span></div>
        </div>
        <svg class="weekbars" viewBox="0 -10 ${W} ${H + 34}" role="img" aria-label="Antal larm per vecka de senaste fem veckorna">${bars}</svg>
      </section>
      <section class="card side-card">
        <h2>Pooler med flest larm</h2>
        ${top.length ? barList(top, 'fill-alarm') : '<p class="muted small">Inga larm.</p>'}
      </section>
      <section class="card side-card">
        <h2>Typ av larm</h2>
        ${barList(byKind, 'fill-warn')}
      </section>
      <section class="card side-card">
        <h2>Kemikalier vid besök</h2>
        ${chemItems.length ? barList(chemItems) : '<p class="muted small">Ingen kemi registrerad.</p>'}
      </section>
    </div>`);
}

// ---------- Kund: historik ----------
async function pageHistory(q) {
  const days = q.d === '7' ? 7 : 30;
  const pool = await myPool();
  if (!pool) return customerShell('history', '<div class="card empty"><h1>Ingen pool kopplad</h1></div>');
  const [histRes, repRes] = await Promise.all([
    must(sb.rpc('pool_history', { p_pool: pool.id, p_days: days })),
    must(sb.from('service_reports').select('id, kind, visited_at, notes').order('visited_at', { ascending: false }).limit(12)),
  ]);
  const hist = histRes.data || [];
  const t = todayISO();
  const labels = days === 7
    ? lastSevenDayLabels()
    : [28, 21, 14, 7, 0].map((n) => { const d = addDays(t, -n); return `${Number(d.slice(8))} ${MONTH_SHORT[monthOf(d) - 1]}`; });
  const labelRow = `<div class="daylabels">${labels.map((d) => `<span>${d}</span>`).join('')}</div>`;
  const reports = (repRes.data || []).map((r) => `
    <a class="card pad-14-16 report-link" href="${link('/kund/rapport', { id: r.id })}">
      <div class="cta-icon">${icon('doc', 20)}</div>
      <div class="grow">
        <div class="strong">${esc(KINDS[r.kind]?.label || 'Servicebesök')}</div>
        <div class="muted small ellipsis">${fmtDay(r.visited_at)} · ${esc(r.notes || '')}</div>
      </div>
      ${icon('right', 18)}
    </a>`).join('') || '<p class="muted small">Inga besök än.</p>';

  return customerShell('history', `
    <div class="stack-14">
      <div class="row-between">
        <h1>Historik</h1>
        <div class="seg seg-sm" role="tablist" aria-label="Period">
          <a href="${link('/kund/historik', { d: 7 })}" role="tab" aria-selected="${days === 7}" class="${days === 7 ? 'active' : ''}">7 dagar</a>
          <a href="#/kund/historik" role="tab" aria-selected="${days === 30}" class="${days === 30 ? 'active' : ''}">30 dagar</a>
        </div>
      </div>
      <section class="card pad-16-20 stack-8">
        <h2 class="h-small">pH</h2>
        ${lineChart(hist.map((h) => Number(h.ph)), { min: 6.6, max: 8.2, band: [7.2, 7.6], height: 90, label: `pH senaste ${days} dagarna` })}
        ${labelRow}
      </section>
      <section class="card pad-16-20 stack-8">
        <h2 class="h-small">Klor (redox, mV)</h2>
        ${lineChart(hist.map((h) => Number(h.orp)), { min: 550, max: 820, band: [650, 800], height: 80, label: `Redox senaste ${days} dagarna` })}
        ${labelRow}
      </section>
      <section class="card pad-16-20 stack-8">
        <h2 class="h-small">Vattentemperatur</h2>
        ${lineChart(hist.map((h) => Number(h.temp)), { min: 14, max: 28, height: 60, label: `Temperatur senaste ${days} dagarna`, color: '#5B7C99' })}
        ${labelRow}
        <div class="muted small">Grönt fält = målområde</div>
      </section>
      <section class="stack-8">
        <h2 class="h-small">Servicebesök</h2>
        ${reports}
      </section>
    </div>`);
}

// ---------- Kund: meddelanden ----------
const MSG_ICON = { info: 'mail', larm: 'bell', paminnelse: 'calendar', bokning: 'check', rapport: 'doc' };
async function pageMessages() {
  const { data } = await must(sb.from('messages').select('id, kind, title, body, created_at, read_at').order('created_at', { ascending: false }).limit(40));
  const msgs = data || [];
  if (msgs.some((m) => !m.read_at)) sb.rpc('mark_messages_read').then(() => {});
  const items = msgs.map((m) => `
    <div class="card msg ${m.read_at ? '' : 'msg-unread'}">
      <div class="msg-icon msg-${esc(m.kind)}">${icon(MSG_ICON[m.kind] || 'mail', 20)}</div>
      <div class="grow stack-4">
        <div class="row-between">
          <span class="strong">${esc(m.title)}</span>
          ${m.read_at ? '' : '<span class="new-tag">NY</span>'}
        </div>
        ${m.body ? `<p class="small">${esc(m.body)}</p>` : ''}
        <div class="muted small">${ago(m.created_at)}${m.kind === 'rapport' ? ' · <a href="#/kund/historik">Visa historik</a>' : ''}${m.kind === 'paminnelse' ? ' · <a href="#/kund/boka">Boka nu</a>' : ''}</div>
      </div>
    </div>`).join('');
  return customerShell('messages', `
    <div class="stack-14">
      <h1>Meddelanden</h1>
      ${items || '<p class="muted">Inga meddelanden än.</p>'}
    </div>`);
}

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------
async function loadProfile(userId) {
  const { data } = await sb.from('profiles').select('id, full_name, role, customer_id').eq('id', userId).maybeSingle();
  return data || null;
}

function render(token, path, html) {
  if (token !== routeToken) return; // en nyare navigering hann före
  const samePage = path === lastPath;
  const scrollY = window.scrollY;
  const inner = root.querySelector('.scroll')?.scrollTop ?? 0;
  root.innerHTML = fillFlash(html);
  if (samePage) {
    window.scrollTo(0, scrollY);
    const sc = root.querySelector('.scroll');
    if (sc) sc.scrollTop = inner;
  } else {
    window.scrollTo(0, 0);
  }
  lastPath = path;
}

async function route() {
  const token = ++routeToken;
  const { path, q } = parseHash();
  if (!configured) return render(token, 'setup', pageSetup());

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      profile = null;
      if (path !== '/login') return go('/login');
      return render(token, path, pageLogin(q));
    }
    if (!profile || profile.id !== session.user.id) profile = await loadProfile(session.user.id);
    if (!profile) return render(token, '/login', pageLogin({ noprofile: session.user.email }));

    const home = profile.role === 'staff' ? '/admin' : '/kund';
    if (path === '/' || path === '/login') return go(home);
    if (path.startsWith('/admin') && profile.role !== 'staff') return go('/kund');
    if (path.startsWith('/kund') && profile.role !== 'customer') return go('/admin');

    const pages = {
      '/admin': pageAdmin,
      '/admin/larm': pageAlarms,
      '/admin/bokningar': pageBookings,
      '/admin/kunder': pageCustomers,
      '/admin/statistik': pageStats,
      '/admin/rapport/ny': pageReportNew,
      '/admin/rapport': (q) => pageReport(q, true),
      '/kund': pageKund,
      '/kund/historik': pageHistory,
      '/kund/boka': pageBoka,
      '/kund/klart': pageKlart,
      '/kund/meddelanden': pageMessages,
      '/kund/rapport': (q) => pageReport(q, false),
    };
    const page = pages[path];
    if (!page) return go(home);
    const html = await page(q);
    if (typeof html === 'string') render(token, path, html);
  } catch (err) {
    console.error(err);
    render(token, 'error', `
      <div class="login-wrap"><div class="login card">
        ${brand(false)}
        <h1>Något gick fel</h1>
        <p class="muted">${esc(err?.message || err)}</p>
        <p class="muted small">Kontrollera att <code>supabase/setup.sql</code> har körts och att nycklarna i <code>config.js</code> stämmer.</p>
        <div class="row-8">
          <a class="btn btn-primary" href="#/">Försök igen</a>
          <button class="btn btn-secondary" type="button" data-action="logout">Logga ut</button>
        </div>
      </div></div>`);
  }
}

// ------------------------------------------------------------------
// Knappar och formulär
// ------------------------------------------------------------------
async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    setFlash('Fel e-post eller lösenord.', 'err');
    return go('/login');
  }
  profile = null;
  go('/');
}

const actions = {
  'demo-login': (el) => signIn(el.dataset.email, 'demo1234'),
  logout: async () => {
    await sb.auth.signOut();
    profile = null;
    go('/login');
  },
  reset: async () => {
    const { error } = await sb.rpc('reset_demo');
    setFlash(error ? `Kunde inte återställa: ${error.message}` : 'Demon är återställd med ny demodata.', error ? 'err' : 'ok');
    go('/admin');
  },
  sms: async (el) => {
    const { error } = await sb.from('messages').insert({
      customer_id: el.dataset.customer,
      kind: 'larm',
      title: 'Meddelande om din pool',
      body: `Hej! ${el.dataset.text} Vi hör av oss om vad som behöver göras.`,
    });
    setFlash(error ? error.message : `Meddelandet till ${el.dataset.name} är skickat och syns direkt i kundens app. (I den riktiga versionen även som sms.)`, error ? 'err' : 'ok');
    route();
  },
  confirm: async (el) => {
    const { error } = await sb.from('bookings').update({ status: 'bekraftad' }).eq('id', el.dataset.id);
    setFlash(error ? error.message : 'Bokningen är bekräftad. Kunden ser det direkt i sin app.', error ? 'err' : 'ok');
    route();
  },
  cancel: async (el) => {
    const { error } = await sb.from('bookings').delete().eq('id', el.dataset.id);
    setFlash(error ? error.message : 'Bokningen är borttagen.', error ? 'err' : 'ok');
    route();
  },
  remind: async () => {
    const { data, error } = await sb.rpc('remind_unbooked');
    setFlash(error ? error.message : `Påminnelse skickad till ${data} kunder. Den syns direkt i deras app under Meddelanden.`, error ? 'err' : 'ok');
    route();
  },
  book: async (el) => {
    const { kind, date, slot, m } = el.dataset;
    const { data, error } = await sb.rpc('book_visit', { p_kind: kind, p_date: date, p_slot: slot });
    if (error) return go('/kund/boka', { kind, m, d: date, fel: error.message });
    go('/kund/klart', { id: data });
  },
  'cancel-own': async (el) => {
    const { error } = await sb.from('bookings').delete().eq('id', el.dataset.id);
    setFlash(error ? error.message : 'Bokningen är avbokad.', error ? 'err' : 'ok');
    route();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  el.disabled = true;
  el.setAttribute('aria-busy', 'true');
  try {
    await fn(el);
  } finally {
    if (el.isConnected) {
      el.disabled = false;
      el.removeAttribute('aria-busy');
    }
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'login-form') {
    e.preventDefault();
    const fd = new FormData(form);
    return signIn(String(fd.get('email') || '').trim(), String(fd.get('password') || ''));
  }

  if (form.classList.contains('ack-form')) {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.rpc('ack_alarm', { p_id: form.dataset.id, p_comment: form.comment.value });
    setFlash(error ? error.message : 'Larmet är kvitterat.', error ? 'err' : 'ok');
    return route();
  }

  if (form.id === 'report-form') {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    const f = form.elements;
    const chemicals = CHEMS.map(([name, unit], i) => ({ name, unit, amount: numOrNull(f[`chem_${i}`].value) }))
      .filter((c) => c.amount && c.amount > 0);
    const orp = (v) => { const n = numOrNull(v); return n == null ? null : Math.round(n); };
    const { data, error } = await sb.rpc('create_report', {
      p_pool: form.dataset.pool,
      p_booking: form.dataset.booking || null,
      p_date: f.date.value || null,
      p_ph_before: numOrNull(f.ph_before.value),
      p_ph_after: numOrNull(f.ph_after.value),
      p_orp_before: orp(f.orp_before.value),
      p_orp_after: orp(f.orp_after.value),
      p_chemicals: chemicals,
      p_notes: f.notes.value,
      p_resolve: Boolean(f.resolve?.checked),
    });
    if (error) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      setFlash(error.message, 'err');
      return route();
    }
    setFlash(f.resolve?.checked
      ? 'Rapporten är sparad och skickad till kunden. Larmen är stängda och poolen visas som åtgärdad.'
      : 'Rapporten är sparad och skickad till kunden.');
    return go('/admin/rapport', { id: data });
  }
});

// Sök i kundlistan utan att ladda om sidan
document.addEventListener('input', (e) => {
  if (e.target.id !== 'cust-search') return;
  const v = e.target.value.trim().toLowerCase();
  root.querySelectorAll('.cust-row').forEach((r) => { r.hidden = Boolean(v) && !r.dataset.name.includes(v); });
});

window.addEventListener('hashchange', route);
route();
