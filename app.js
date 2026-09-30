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

function takeFlash() {
  const f = flash;
  flash = null;
  return f ? `<div class="flash flash-${f.kind}" role="status">${esc(f.text)}</div>` : '';
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
  const { count } = await sb.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'ny');
  const name = profile.full_name || 'Personal';
  return `
  <div class="shell">
    <aside class="side">
      ${brand()}
      <nav class="nav" aria-label="Huvudmeny">
        <a href="#/admin" class="${active === 'overview' ? 'active' : ''}">${icon('grid')}Översikt</a>
        <a href="#/admin/bokningar" class="${active === 'bookings' ? 'active' : ''}">${icon('calendar')}Servicebesök${count ? `<span class="badge" aria-label="${count} nya bokningar">${count}</span>` : ''}</a>
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

function customerShell(active, content) {
  return `
  <div class="kund">
    <div class="kund-inner">${content}</div>
    <nav class="tabbar" aria-label="Flikar">
      <a href="#/kund" class="${active === 'home' ? 'active' : ''}">${icon('home', 22)}Hem</a>
      <a href="#/kund/boka" class="${active === 'book' ? 'active' : ''}">${icon('calendar', 22)}Boka</a>
      <button type="button" data-action="logout">${icon('logout', 22)}Logga ut</button>
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
    must(sb.from('pools').select('id, volume_m3, sanitizer, customers(name, contact_name, area)')),
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
        id: p.id, kund: c?.name || '', contact: c?.contact_name || '', area: c?.area || '',
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
          <a class="btn btn-primary grow" href="#/admin/bokningar">Boka servicebesök</a>
          <button class="btn btn-secondary grow" type="button" data-action="sms" data-name="${esc(sel.contact || sel.kund)}">${icon('message', 18)}Sms:a kunden</button>
        </div>
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
  const cols = 'id, kind, date, slot, start_h, end_h, status, note, customers(name, area)';

  const [weekRes, newRes, seasonRes, poolsRes] = await Promise.all([
    must(sb.from('bookings').select(cols).gte('date', monday).lte('date', friday)),
    must(sb.from('bookings').select(cols).eq('status', 'ny').order('date').order('start_h')),
    must(sb.from('bookings').select('pool_id').eq('kind', 'stangning').gte('date', `${year}-01-01`).lte('date', `${year}-12-31`)),
    must(sb.from('pools').select('id', { count: 'exact', head: true })),
  ]);
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
    return `
      <div class="block block-${b.kind} ${b.status === 'ny' ? 'block-new' : ''} ${short ? 'block-short' : ''}" style="${style}" title="${esc(`${c.name}, ${c.area} · ${b.slot} · ${what}`)}">
        <div class="block-top"><span class="strong ellipsis">${esc(c.name)}</span>${b.status === 'ny' ? '<span class="new-tag">NY</span>' : ''}</div>
        ${short
          ? `<span class="small ellipsis">${esc(b.slot)} · ${esc(b.note || KINDS[b.kind].label)}</span>`
          : `<span class="small num ellipsis">${esc(b.slot)} · ${esc(c.area)}</span><span class="small strong ellipsis">${esc(what)}</span>`}
      </div>`;
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
        <p class="muted small pad-4">Kunderna bokar själva i lediga tider, vardagar 08–16. Nya bokningar hamnar här för bekräftelse.</p>
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
  const [latestRes, histRes, bookingsRes] = await Promise.all([
    must(sb.from('pool_latest').select('pool_id, measured_at, ph, orp, temp').eq('pool_id', pool.id).maybeSingle()),
    must(sb.rpc('pool_history', { p_pool: pool.id, p_days: 7 })),
    must(sb.from('bookings').select('id, kind, date, slot, status').gte('date', today).order('date')),
  ]);
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
  root.innerHTML = html;
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
      '/admin/bokningar': pageBookings,
      '/kund': pageKund,
      '/kund/boka': pageBoka,
      '/kund/klart': pageKlart,
    };
    const page = pages[path];
    if (!page) return go(home);
    render(token, path, await page(q));
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
  sms: (el) => {
    setFlash(`Demo: sms skickat till ${el.dataset.name}. (I den riktiga versionen går det via t.ex. 46elks.)`);
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
  remind: (el) => {
    setFlash(`Demo: påminnelse skickad till ${el.dataset.n} kunder. (I den riktiga versionen via sms eller mejl.)`);
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

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  signIn(String(fd.get('email') || '').trim(), String(fd.get('password') || ''));
});

window.addEventListener('hashchange', route);
route();
