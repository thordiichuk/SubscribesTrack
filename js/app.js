/* =========================================================
   SubsTrack — трекер і календар підписок
   Vanilla JS, без залежностей. Дані: localStorage (опційно зашифровані).
   ========================================================= */
'use strict';

/* ---------------------------------------------------------
   Константи
   --------------------------------------------------------- */
const LS_META = 'subtrack.meta.v1';   // тема, параметри блокування (не секретне)
const LS_DATA = 'subtrack.data.v1';   // підписки + налаштування (шифрується, якщо є PIN)
const PBKDF2_ITER = 250000;
const MAX_ATTEMPTS = 5;               // після стількох невдалих спроб — пауза
const LOCKOUT_MS = 30_000;

const CATEGORIES = {
  entertainment: { label: 'Розваги',    color: '#8b7cf6' },
  work:          { label: 'Робота',     color: '#3e8ef7' },
  education:     { label: 'Навчання',   color: '#2eb67d' },
  utilities:     { label: 'Комунальні', color: '#f2a93b' },
  other:         { label: 'Інше',       color: '#e66fa0' },
};

const STATUSES = {
  active:     'Активна',
  paused:     'Пауза',
  cancelling: 'До скасування',
  cancelled:  'Скасована',
};

const STATUS_COLORS = { active: 'var(--ok)', paused: 'var(--muted)', cancelling: 'var(--warn)', cancelled: 'var(--danger)' };

const PERIODS = {
  monthly: { label: 'Щомісяця',   short: '/міс' },
  yearly:  { label: 'Щороку',     short: '/рік' },
  weekly:  { label: 'Щотижня',    short: '/тиж' },
  once:    { label: 'Одноразово', short: '' },
};

const CURRENCIES = {
  PLN: { symbol: 'zł', prefix: false },
  USD: { symbol: '$',  prefix: true },
  EUR: { symbol: '€',  prefix: true },
  UAH: { symbol: '₴',  prefix: false },
  GBP: { symbol: '£',  prefix: true },
  CHF: { symbol: 'CHF', prefix: false },
  CZK: { symbol: 'Kč', prefix: false },
};

// Приблизні курси за замовчуванням: скільки PLN коштує 1 одиниця валюти
const DEFAULT_RATES_PLN = { PLN: 1, USD: 3.65, EUR: 4.25, UAH: 0.088, GBP: 4.9, CHF: 4.55, CZK: 0.17 };

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

/* ---------------------------------------------------------
   Стан
   --------------------------------------------------------- */
let meta = null;        // { theme, view, lock: {salt, iter} | null, failed, lockUntil }
let state = null;       // { version, subs: [], settings: {...}, notified: {} }
let cryptoKey = null;   // AES-ключ у пам'яті (лише поки застосунок розблоковано)
let bound = false;
let reminderTimer = null;
let idleTimer = null;
let hiddenAt = 0;

const ui = {
  category: 'all',
  status: 'all',
  sort: 'date-asc',
  search: '',
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  calSelected: null, // ISO-рядок
  editingId: null,
};

/* ---------------------------------------------------------
   Утиліти
   --------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const enc = new TextEncoder();
const dec = new TextDecoder();

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function safeUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

const b64 = {
  from: buf => btoa(String.fromCharCode(...new Uint8Array(buf))),
  to: str => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
};

/* ---------- Дати (усі дати — локальні, формат YYYY-MM-DD) ---------- */
function parseDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function toISO(date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function today() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function addMonthsAnchored(date, n, anchorDay) {
  const y = date.getFullYear(), m = date.getMonth() + n;
  const dim = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(anchorDay || date.getDate(), dim));
}
function daysUntil(iso) { return Math.round((parseDate(iso) - today()) / 86400000); }
function fmtDate(iso, withYear = false) {
  const d = parseDate(iso);
  const s = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return withYear || d.getFullYear() !== today().getFullYear() ? `${s} ${d.getFullYear()}` : s;
}
function dueLabel(days) {
  if (days < 0) return `прострочено ${-days} ${plural(-days, 'день', 'дні', 'днів')}`;
  if (days === 0) return 'сьогодні';
  if (days === 1) return 'завтра';
  return `через ${days} ${plural(days, 'день', 'дні', 'днів')}`;
}

function nextOccurrence(sub, date) {
  switch (sub.period) {
    case 'weekly': return addDays(date, 7);
    case 'monthly': return addMonthsAnchored(date, 1, sub.anchorDay);
    case 'yearly': return addMonthsAnchored(date, 12, sub.anchorDay);
    default: return null;
  }
}

/** Усі списання підписки у проміжку [from, to] (включно) */
function occurrences(sub, from, to) {
  if (sub.status === 'cancelled' || sub.status === 'paused') return [];
  const out = [];
  let d = parseDate(sub.nextDate);
  if (sub.period === 'once') return d >= from && d <= to ? [d] : [];
  let guard = 0;
  while (d && d <= to && guard++ < 600) {
    if (d >= from) out.push(d);
    d = nextOccurrence(sub, d);
  }
  return out;
}

/* ---------- Гроші ---------- */
function fmtNum(v) {
  return new Intl.NumberFormat('uk-UA', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v);
}
function fmtMoney(v, cur) {
  const c = CURRENCIES[cur] || { symbol: cur, prefix: false };
  const n = fmtNum(Math.round(v * 100) / 100);
  return c.prefix ? `${c.symbol}${n}` : `${n} ${c.symbol}`;
}
function moneyParts(v, cur) {
  const c = CURRENCIES[cur] || { symbol: cur };
  return { n: fmtNum(Math.round(v * 100) / 100), sym: c.symbol };
}
function fmtCompact(v, cur) {
  const c = CURRENCIES[cur] || { symbol: cur, prefix: false };
  const n = v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',') + 'k' : String(Math.round(v));
  return c.prefix ? `${c.symbol}${n}` : n;
}
function toBase(amount, cur) {
  const rates = state.settings.rates;
  const r = rates[cur];
  if (!r) return amount; // невідома валюта — рахуємо 1:1
  return amount * r;
}
function monthlyCost(sub) {
  const p = toBase(Number(sub.price) || 0, sub.currency);
  switch (sub.period) {
    case 'monthly': return p;
    case 'yearly': return p / 12;
    case 'weekly': return p * 52 / 12;
    default: return 0;
  }
}
const isCharging = s => s.status === 'active' || s.status === 'cancelling';

/* ---------------------------------------------------------
   Сховище та шифрування
   --------------------------------------------------------- */
function defaultSettings() {
  return {
    baseCurrency: 'PLN',
    rates: { ...DEFAULT_RATES_PLN },
    ratesUpdated: null,
    remindDays: 3,
    browserNotify: false,
    tg: { enabled: false, token: '', chatId: '' },
    autoLockMin: 5,
  };
}
function defaultState() {
  return { version: 1, subs: [], settings: defaultSettings(), notified: {} };
}
function normalizeState(s) {
  const base = defaultState();
  const out = { ...base, ...(s || {}) };
  out.settings = { ...base.settings, ...(s?.settings || {}) };
  out.settings.tg = { ...base.settings.tg, ...(s?.settings?.tg || {}) };
  out.settings.rates = { ...base.settings.rates, ...(s?.settings?.rates || {}) };
  out.notified = out.notified || {};
  out.subs = Array.isArray(out.subs) ? out.subs.map(normalizeSub).filter(Boolean) : [];
  return out;
}
function normalizeSub(s) {
  if (!s || typeof s !== 'object' || !s.name) return null;
  const nextDate = /^\d{4}-\d{2}-\d{2}$/.test(s.nextDate) ? s.nextDate : toISO(today());
  return {
    id: s.id || uid(),
    name: String(s.name).slice(0, 80),
    url: s.url ? String(s.url) : '',
    price: Math.max(0, Number(s.price) || 0),
    currency: CURRENCIES[s.currency] ? s.currency : 'PLN',
    period: PERIODS[s.period] ? s.period : 'monthly',
    nextDate,
    anchorDay: Number(s.anchorDay) || parseDate(nextDate).getDate(),
    category: CATEGORIES[s.category] ? s.category : 'other',
    status: STATUSES[s.status] ? s.status : 'active',
    note: s.note ? String(s.note).slice(0, 500) : '',
    createdAt: s.createdAt || new Date().toISOString(),
    updatedAt: s.updatedAt || new Date().toISOString(),
  };
}

function loadMeta() {
  try {
    const m = { theme: 'light', view: 'list', lock: null, failed: 0, lockUntil: 0, ...JSON.parse(localStorage.getItem(LS_META) || '{}') };
    if (!m.themeExplicit) m.theme = 'light'; // світла тема, доки користувач сам не обере іншу
    return m;
  } catch { return { theme: 'light', view: 'list', lock: null, failed: 0, lockUntil: 0 }; }
}
function saveMeta() { localStorage.setItem(LS_META, JSON.stringify(meta)); }

async function deriveKey(pin, saltB64, iter) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64.to(saltB64), iterations: iter, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function encryptJSON(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { enc: 1, iv: b64.from(iv), ct: b64.from(ct) };
}
async function decryptJSON(blob, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.to(blob.iv) }, key, b64.to(blob.ct));
  return JSON.parse(dec.decode(pt));
}

let saveChain = Promise.resolve();
function save() {
  // Послідовні збереження, щоб уникнути гонок при асинхронному шифруванні
  const snapshot = JSON.parse(JSON.stringify(state));
  saveChain = saveChain.then(async () => {
    try {
      if (meta.lock && cryptoKey) {
        localStorage.setItem(LS_DATA, JSON.stringify(await encryptJSON(snapshot, cryptoKey)));
      } else if (!meta.lock) {
        localStorage.setItem(LS_DATA, JSON.stringify(snapshot));
      }
    } catch (e) {
      console.error(e);
      toast('Не вдалося зберегти дані');
    }
  });
  return saveChain;
}

/* ---------------------------------------------------------
   Запуск
   --------------------------------------------------------- */
async function boot() {
  meta = loadMeta();
  applyTheme();
  registerSW();

  if (meta.lock) {
    if (!window.crypto?.subtle) {
      document.body.innerHTML = '<p style="padding:24px">Для розблокування потрібне захищене з\'єднання (HTTPS або localhost).</p>';
      return;
    }
    showLock();
    return;
  }
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS_DATA) || 'null'); } catch { raw = null; }
  if (raw?.enc) {
    // Дані зашифровані, але метадані втрачені — відновити неможливо
    if (confirm('Знайдено зашифровані дані, але параметри PIN втрачено. Почати з чистого аркуша?')) raw = null;
    else return;
  }
  state = normalizeState(raw);
  startApp();
}

function startApp() {
  $('#lockScreen').hidden = true;
  $('#app').hidden = false;
  rollForward();
  save();
  if (!bound) { bindEvents(); bound = true; }
  setView(meta.view || 'list');
  renderAll();
  scheduleReminders();
  resetIdle();
}

/** Переносить минулі дати повторюваних підписок на наступне майбутнє списання */
function rollForward() {
  const t = today();
  let changed = false;
  for (const s of state.subs) {
    if (s.period === 'once' || s.status === 'cancelled') continue;
    let d = parseDate(s.nextDate), guard = 0;
    while (d < t && guard++ < 1000) { d = nextOccurrence(s, d); changed = true; }
    s.nextDate = toISO(d);
  }
  return changed;
}

/* ---------------------------------------------------------
   Блокування
   --------------------------------------------------------- */
function showLock() {
  cryptoKey = null;
  state = null;
  $('#app').hidden = true;
  $$('dialog[open]').forEach(d => d.close());
  $('#lockScreen').hidden = false;
  $('#lockError').textContent = '';
  const input = $('#lockInput');
  input.value = '';
  setTimeout(() => input.focus(), 50);
  clearInterval(reminderTimer);
}

async function tryUnlock(pin) {
  const now = Date.now();
  if (meta.lockUntil > now) {
    $('#lockError').textContent = `Забагато спроб. Зачекайте ${Math.ceil((meta.lockUntil - now) / 1000)} с.`;
    return;
  }
  const btn = $('#lockForm button[type=submit]');
  btn.disabled = true; btn.textContent = 'Перевірка…';
  try {
    const key = await deriveKey(pin, meta.lock.salt, meta.lock.iter);
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_DATA) || 'null'); } catch { raw = null; }
    let data = null;
    if (raw?.enc) data = await decryptJSON(raw, key); // кидає помилку при невірному PIN
    else if (raw) data = raw;                          // (не повинно траплятися) нешифровані дані
    cryptoKey = key;
    meta.failed = 0; meta.lockUntil = 0; saveMeta();
    state = normalizeState(data);
    startApp();
  } catch {
    meta.failed = (meta.failed || 0) + 1;
    if (meta.failed >= MAX_ATTEMPTS) { meta.lockUntil = Date.now() + LOCKOUT_MS; meta.failed = 0; }
    saveMeta();
    $('#lockError').textContent = 'Невірний PIN';
    $('#lockInput').select();
  } finally {
    btn.disabled = false; btn.textContent = 'Розблокувати';
  }
}

function lockNow() {
  if (!meta.lock) return;
  save().then(showLock);
}

function resetIdle() {
  clearTimeout(idleTimer);
  if (!meta.lock || !state) return;
  const min = Number(state.settings.autoLockMin) || 0;
  if (min > 0) idleTimer = setTimeout(lockNow, min * 60_000);
}

/* ---------------------------------------------------------
   Тема та навігація
   --------------------------------------------------------- */
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>';

function applyTheme() {
  const theme = meta.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  $('meta[name=theme-color]').setAttribute('content', theme === 'light' ? '#f5f4ef' : '#121211');
  const t = $('#themeToggle');
  if (t) t.innerHTML = theme === 'light' ? ICON_MOON : ICON_SUN;
  $$('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.themeSet === theme));
}
function setTheme(theme) { meta.theme = theme; meta.themeExplicit = true; saveMeta(); applyTheme(); }

function setView(view) {
  if (!['list', 'calendar', 'stats', 'settings'].includes(view)) view = 'list';
  meta.view = view; saveMeta();
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $('#summary').hidden = view === 'settings' || view === 'stats';
  $('#fab').hidden = view === 'settings';
  renderView(view);
  window.scrollTo({ top: 0 });
}

/* ---------------------------------------------------------
   Рендер
   --------------------------------------------------------- */
function renderAll() {
  renderSummary();
  renderView(meta.view);
  $('#lockNow').hidden = !meta.lock;
}
function renderView(view) {
  if (view === 'list') renderList();
  else if (view === 'calendar') renderCalendar();
  else if (view === 'stats') renderStats();
  else if (view === 'settings') renderSettings();
}

function totals() {
  const charging = state.subs.filter(isCharging);
  const monthly = charging.reduce((a, s) => a + monthlyCost(s), 0);
  return { monthly, yearly: monthly * 12, count: charging.length };
}

function upcoming(limitDays = 30) {
  const from = today(), to = addDays(from, limitDays);
  const list = [];
  for (const s of state.subs) for (const d of occurrences(s, from, to)) list.push({ sub: s, date: d });
  return list.sort((a, b) => a.date - b.date);
}

function renderSummary() {
  const base = state.settings.baseCurrency;
  const t = totals();
  const next = upcoming(400)[0];
  const in30 = upcoming(30).reduce((a, x) => a + toBase(x.sub.price, x.sub.currency), 0);
  const m = moneyParts(t.monthly, base);
  $('#summary').innerHTML = `
    <div class="hero">
      <div class="eyebrow">Щомісяця · ${t.count} ${plural(t.count, 'активна', 'активні', 'активних')}</div>
      <div class="hero-value"><span class="num">${esc(m.n)}</span><span class="cur">${esc(m.sym)}</span></div>
      <div class="hero-meta">
        <div><span>За рік</span><b class="mono">${esc(fmtMoney(t.yearly, base))}</b></div>
        <div><span>30 днів</span><b class="mono">${esc(fmtMoney(in30, base))}</b></div>
        <div><span>Далі</span><b>${next ? esc(next.sub.name) + ' · ' + esc(dueLabel(daysUntil(toISO(next.date)))) : '—'}</b></div>
      </div>
    </div>`;
}

function urgencyClass(sub) {
  if (!isCharging(sub)) return '';
  const d = daysUntil(sub.nextDate);
  if (sub.period === 'once' && d < 0) return '';
  if (d <= 1) return 'due-danger';
  if (d <= Math.max(3, Number(state.settings.remindDays) || 0)) return 'due-warning';
  return '';
}

function filteredSubs() {
  const q = ui.search.trim().toLowerCase();
  let list = state.subs.filter(s => {
    if (ui.category !== 'all' && s.category !== ui.category) return false;
    if (ui.status === 'notcancelled' ? s.status === 'cancelled' : ui.status !== 'all' && s.status !== ui.status) return false;
    if (q && !(`${s.name} ${s.note}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const byDate = (a, b) => a.nextDate.localeCompare(b.nextDate);
  const price = s => s.period === 'once' ? toBase(s.price, s.currency) : monthlyCost(s);
  const sorters = {
    'date-asc': byDate,
    'date-desc': (a, b) => byDate(b, a),
    'price-desc': (a, b) => price(b) - price(a),
    'price-asc': (a, b) => price(a) - price(b),
    'name': (a, b) => a.name.localeCompare(b.name, 'uk'),
  };
  list.sort(sorters[ui.sort] || byDate);
  // неактивні — в кінець списку
  const rank = s => (s.status === 'cancelled' ? 2 : s.status === 'paused' ? 1 : 0);
  list.sort((a, b) => rank(a) - rank(b));
  return list;
}

function renderChips() {
  const counts = {};
  state.subs.forEach(s => { counts[s.category] = (counts[s.category] || 0) + 1; });
  $('#categoryChips').innerHTML =
    `<button class="chip ${ui.category === 'all' ? 'active' : ''}" data-cat="all">Усі <span class="count">${state.subs.length}</span></button>` +
    Object.entries(CATEGORIES).map(([k, c]) =>
      `<button class="chip ${ui.category === k ? 'active' : ''}" data-cat="${k}"><i class="dot" style="--c:${c.color}"></i>${c.label}${counts[k] ? ` <span class="count">${counts[k]}</span>` : ''}</button>`
    ).join('');
}

function subRowHTML(s) {
  const cat = CATEGORIES[s.category];
  const d = parseDate(s.nextDate);
  const days = daysUntil(s.nextDate);
  const urg = urgencyClass(s);
  const url = safeUrl(s.url);
  const inactive = s.status === 'paused' || s.status === 'cancelled';
  const parts = [
    `<i class="dot" style="--c:${cat.color}"></i>${cat.label}`,
    PERIODS[s.period].label.toLowerCase(),
  ];
  if (!inactive) parts.push(`<span class="due">${esc(dueLabel(days))}</span>`);
  return `
  <article class="item ${urg} ${inactive ? 'is-inactive' : ''}" data-id="${esc(s.id)}" tabindex="0">
    <div class="date-block"><b>${String(d.getDate()).padStart(2, '0')}</b><span>${MONTHS_SHORT[d.getMonth()]}</span></div>
    <div class="item-body">
      <div class="line1">
        <span class="name" title="${esc(s.name)}">${esc(s.name)}</span>
        <span class="price">${esc(fmtMoney(s.price, s.currency))}<small>${PERIODS[s.period].short}</small></span>
      </div>
      <div class="line2">
        ${parts.join('<span class="sep">·</span>')}
        ${s.status !== 'active' ? `<span class="tag st-${s.status}">${STATUSES[s.status]}</span>` : ''}
      </div>
      ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
      <div class="acts">
        ${url ? `<a class="act" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-action="open">Сайт ↗</a>` : ''}
        ${s.status === 'active' ? `<button class="act" data-action="pause">Пауза</button>` : ''}
        ${inactive ? `<button class="act" data-action="restore">Відновити</button>` : ''}
        ${s.status !== 'cancelled' ? `<button class="act danger" data-action="quickcancel">Скасувати${url ? ' ↗' : ''}</button>` : ''}
      </div>
    </div>
  </article>`;
}

function renderList() {
  renderChips();
  const days = Number(state.settings.remindDays) || 3;
  const soon = state.subs.filter(s => isCharging(s) && daysUntil(s.nextDate) >= 0 && daysUntil(s.nextDate) <= days)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const banner = $('#alertBanner');
  if (soon.length) {
    const urgent = soon.some(s => daysUntil(s.nextDate) <= 1);
    banner.className = 'alert' + (urgent ? ' danger' : '');
    banner.innerHTML = `<div>Скоро ${plural(soon.length, 'списання', 'списання', 'списань')}: ` +
      soon.map(s => `<b>${esc(s.name)}</b> ${esc(dueLabel(daysUntil(s.nextDate)))}`).join(', ') + '</div>';
    banner.hidden = false;
  } else banner.hidden = true;

  const list = filteredSubs();
  const el = $('#subList');
  if (!state.subs.length) {
    el.innerHTML = `<div class="empty"><div class="empty-mark"></div><h3>Поки порожньо</h3><p>Додайте першу підписку: Netflix, інтернет, оренду…</p><button class="btn btn-primary btn-lg" data-action="add">Додати підписку</button></div>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>Нічого не знайдено</h3><p>Спробуйте інші фільтри.</p></div>`;
    return;
  }
  // Групування: за місяцями (при сортуванні за датою) + окремо неактивні
  const byDate = ui.sort.startsWith('date');
  let html = '', lastKey = null;
  for (const s of list) {
    const inactive = s.status === 'paused' || s.status === 'cancelled';
    let key, title;
    if (inactive) { key = 'inactive'; title = 'Пауза та скасовані'; }
    else if (byDate) {
      const d = parseDate(s.nextDate);
      key = `${d.getFullYear()}-${d.getMonth()}`;
      title = MONTHS[d.getMonth()] + (d.getFullYear() !== today().getFullYear() ? ' ' + d.getFullYear() : '');
    } else { key = 'all'; title = null; }
    if (key !== lastKey) {
      if (title) html += `<div class="eyebrow group-title">${esc(title)}</div>`;
      lastKey = key;
    }
    html += subRowHTML(s);
  }
  el.innerHTML = html;
}

/* ---------- Календар ---------- */
function renderCalendar() {
  const y = ui.calYear, m = ui.calMonth;
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const startOffset = (first.getDay() + 6) % 7; // понеділок — перший
  const gridStart = addDays(first, -startOffset);
  const totalCells = Math.ceil((startOffset + last.getDate()) / 7) * 7;
  const gridEnd = addDays(gridStart, totalCells - 1);
  const base = state.settings.baseCurrency;
  const t = today(), tISO = toISO(t);
  const remind = Math.max(3, Number(state.settings.remindDays) || 0);

  // Збираємо списання по днях
  const byDay = {};
  for (const s of state.subs) {
    for (const d of occurrences(s, gridStart, gridEnd)) {
      (byDay[toISO(d)] ||= []).push(s);
    }
  }
  let monthSum = 0, monthCount = 0;
  Object.entries(byDay).forEach(([iso, subs]) => {
    const d = parseDate(iso);
    if (d.getMonth() === m && d.getFullYear() === y) {
      subs.forEach(s => { monthSum += toBase(s.price, s.currency); monthCount++; });
    }
  });

  $('#calTitle').innerHTML = `${MONTHS[m]} <span class="yr">${y}</span>`;
  $('#calTotal').textContent = monthCount
    ? `${monthCount} ${plural(monthCount, 'списання', 'списання', 'списань')} · ≈ ${fmtMoney(monthSum, base)}`
    : 'Списань немає';
  $('.cal-weekdays').innerHTML = WEEKDAYS.map(w => `<div>${w}</div>`).join('');

  if (!ui.calSelected) ui.calSelected = tISO;
  let html = '';
  for (let i = 0; i < totalCells; i++) {
    const d = addDays(gridStart, i), iso = toISO(d);
    const subs = byDay[iso] || [];
    const diff = Math.round((d - t) / 86400000);
    const cls = ['cal-cell'];
    if (d.getMonth() !== m) cls.push('out');
    if (iso === tISO) cls.push('today');
    if (iso === ui.calSelected) cls.push('selected');
    if (subs.length) cls.push('has');
    if (subs.length && diff >= 0 && diff <= remind) cls.push('soon');
    const sum = subs.reduce((a, s) => a + toBase(s.price, s.currency), 0);
    html += `<button class="${cls.join(' ')}" data-date="${iso}" aria-label="${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${subs.length ? ', ' + subs.length + ' списань' : ''}">
      <span class="cal-num">${d.getDate()}</span>
      <span class="cal-dots">${subs.slice(0, 4).map(s => `<i class="cal-dot" style="--c:${CATEGORIES[s.category].color}"></i>`).join('')}</span>
      ${subs.length ? `<span class="cal-sum">${esc(fmtCompact(sum, base))}</span>` : ''}
    </button>`;
  }
  $('#calGrid').innerHTML = html;
  renderCalDay(byDay);
}

function renderCalDay(byDay) {
  const iso = ui.calSelected;
  let subs = byDay?.[iso];
  if (!subs) {
    const d = parseDate(iso);
    subs = state.subs.filter(s => occurrences(s, d, d).length);
  }
  const head = `<h3>${esc(fmtDate(iso))} <span class="muted" style="font-weight:400">· ${esc(dueLabel(daysUntil(iso)))}</span></h3>`;
  if (!subs.length) {
    $('#calDay').innerHTML = head + `<p class="muted">Списань немає.</p>`;
    return;
  }
  $('#calDay').innerHTML = head + subs.map(s => {
    const c = CATEGORIES[s.category];
    return `<div class="cal-item" data-id="${esc(s.id)}">
      <i class="dot" style="--c:${c.color}"></i>
      <div class="grow"><b>${esc(s.name)}</b><span class="muted small">${c.label} · ${PERIODS[s.period].label.toLowerCase()}</span></div>
      <span class="price">${esc(fmtMoney(s.price, s.currency))}</span>
    </div>`;
  }).join('');
}

/* ---------- Статистика ---------- */
function renderStats() {
  const base = state.settings.baseCurrency;
  const t = totals();
  const byCat = {};
  state.subs.filter(isCharging).forEach(s => { byCat[s.category] = (byCat[s.category] || 0) + monthlyCost(s); });
  const catEntries = Object.entries(CATEGORIES).map(([k, c]) => ({ k, ...c, v: byCat[k] || 0 })).sort((a, b) => b.v - a.v);

  const top = state.subs.filter(isCharging).filter(s => s.period !== 'once')
    .map(s => ({ s, v: monthlyCost(s) })).sort((a, b) => b.v - a.v).slice(0, 6);
  const statusCounts = Object.keys(STATUSES).map(k => ({ k, n: state.subs.filter(s => s.status === k).length }));
  const in30 = upcoming(30);
  const in30Sum = in30.reduce((a, x) => a + toBase(x.sub.price, x.sub.currency), 0);
  const onceSum = state.subs.filter(s => s.period === 'once' && isCharging(s) && daysUntil(s.nextDate) >= 0)
    .reduce((a, s) => a + toBase(s.price, s.currency), 0);
  const saved = state.subs.filter(s => s.status === 'cancelled' || s.status === 'paused').reduce((a, s) => a + monthlyCost(s), 0);
  const currencies = [...new Set(state.subs.map(s => s.currency))].filter(c => c !== base);
  const kpi = (v, l) => { const p = moneyParts(v, base); return `<div class="kpi"><div class="v">${esc(p.n)}<small>${esc(p.sym)}</small></div><div class="l">${l}</div></div>`; };

  $('#statsContent').innerHTML = `
    <div class="stat-block">
      <div class="eyebrow">Витрати · ${esc(base)}</div>
      <div class="kpis">
        ${kpi(t.monthly, 'на місяць')}
        ${kpi(t.yearly, 'на рік')}
        ${kpi(in30Sum, `найближчі 30 днів · ${in30.length}`)}
        ${kpi(t.monthly / 30.44, 'в середньому за день')}
      </div>
      ${onceSum ? `<p class="note-line">Ще ${esc(fmtMoney(onceSum, base))} — майбутні разові платежі (не входять у місячну суму).</p>` : ''}
      ${saved ? `<p class="note-line">Пауза та скасування економлять <b class="mono">${esc(fmtMoney(saved, base))}</b> щомісяця.</p>` : ''}
    </div>

    <div class="stat-block">
      <div class="eyebrow">За категоріями · на місяць</div>
      <div class="stack">${catEntries.filter(c => c.v > 0).map(c => `<span style="--c:${c.color};flex-grow:${c.v.toFixed(2)}" title="${c.label}"></span>`).join('')}</div>
      <ul class="legend">${catEntries.map(c => `
        <li><i class="dot" style="--c:${c.color}"></i><span class="nm">${c.label}</span><span class="amt">${esc(fmtMoney(c.v, base))}</span><span class="pct">${t.monthly ? Math.round(c.v / t.monthly * 100) : 0}%</span></li>`).join('')}
      </ul>
    </div>

    <div class="stat-block">
      <div class="eyebrow">Найдорожчі · на місяць</div>
      ${top.length ? `<ul class="legend plain">${top.map(({ s, v }) => `<li><i class="dot" style="--c:${CATEGORIES[s.category].color}"></i><span class="nm">${esc(s.name)}</span><span class="amt">${esc(fmtMoney(v, base))}</span></li>`).join('')}</ul>` : '<p class="muted">Немає активних підписок.</p>'}
    </div>

    <div class="stat-block">
      <div class="eyebrow">Статуси</div>
      <ul class="legend plain">${statusCounts.map(x => `<li><i class="dot" style="--c:${STATUS_COLORS[x.k]}"></i><span class="nm">${STATUSES[x.k]}</span><span class="amt">${x.n}</span></li>`).join('')}</ul>
      ${currencies.length ? `<p class="note-line muted">Курси: ${currencies.map(c => `1 ${c} = ${fmtNum(+(state.settings.rates[c] || 1).toFixed(4))} ${base}`).join(' · ')}</p>` : ''}
    </div>`;
}

/* ---------- Налаштування ---------- */
function renderSettings() {
  const st = state.settings;
  applyTheme();
  const baseSel = $('#baseCurrency');
  baseSel.innerHTML = Object.entries(CURRENCIES).map(([k, c]) => `<option value="${k}">${k} (${c.symbol})</option>`).join('');
  baseSel.value = st.baseCurrency;
  $('#ratesList').innerHTML = Object.keys(CURRENCIES).filter(c => c !== st.baseCurrency).map(c => `
    <label class="rate">1 ${c} =
      <input class="input" type="number" step="0.0001" min="0" data-rate="${c}" value="${+(st.rates[c] || 0).toFixed(4)}"> ${CURRENCIES[st.baseCurrency].symbol}
    </label>`).join('');
  $('#ratesInfo').textContent = st.ratesUpdated ? `Оновлено: ${new Date(st.ratesUpdated).toLocaleString('uk-UA')}` : 'Курси за замовчуванням (приблизні)';
  $('#remindDays').value = st.remindDays;
  $('#browserNotify').checked = !!st.browserNotify && ('Notification' in window) && Notification.permission === 'granted';
  $('#notifyStatus').textContent = !('Notification' in window)
    ? 'Цей браузер не підтримує сповіщення.'
    : Notification.permission === 'denied' ? 'Сповіщення заблоковано в налаштуваннях браузера.'
      : Notification.permission === 'granted' ? 'Дозвіл надано.' : 'Потрібен дозвіл браузера.';
  $('#tgEnabled').checked = !!st.tg.enabled;
  $('#tgToken').value = st.tg.token || '';
  $('#tgChat').value = st.tg.chatId || '';
  $('#autoLock').value = st.autoLockMin;
  $('#pinStatus').textContent = meta.lock ? 'PIN увімкнено, дані зашифровано.' : 'PIN вимкнено: будь-хто з доступом до браузера бачить ваші підписки.';
  $('#pinSet').textContent = meta.lock ? 'Змінити PIN' : 'Встановити PIN';
  $('#pinDisable').hidden = !meta.lock;
  $('#autoLock').closest('.field').hidden = !meta.lock;
}

/* ---------------------------------------------------------
   Форма підписки
   --------------------------------------------------------- */
function fillSelect(sel, entries, value) {
  sel.innerHTML = entries.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  if (value) sel.value = value;
}

function openSubForm(id = null, preset = {}) {
  const form = $('#subForm');
  const sub = id ? state.subs.find(s => s.id === id) : null;
  ui.editingId = sub ? sub.id : null;
  $('#subDialogTitle').textContent = sub ? 'Редагувати підписку' : 'Нова підписка';
  $('#subDelete').hidden = !sub;
  $('#formError').textContent = '';
  fillSelect(form.currency, Object.entries(CURRENCIES).map(([k, c]) => [k, `${k} · ${c.symbol}`]));
  fillSelect(form.category, Object.entries(CATEGORIES).map(([k, c]) => [k, c.label]));
  fillSelect(form.status, Object.entries(STATUSES));
  const v = sub || {
    name: '', url: '', price: '', currency: state.settings.baseCurrency, period: 'monthly',
    nextDate: preset.nextDate || toISO(today()), category: 'entertainment', status: 'active', note: '',
  };
  form.name.value = v.name;
  form.url.value = v.url;
  form.price.value = v.price;
  form.currency.value = v.currency;
  form.period.value = v.period;
  form.nextDate.value = v.nextDate;
  form.category.value = v.category;
  form.status.value = v.status;
  form.note.value = v.note;
  $('#subDialog').showModal();
  if (!sub) setTimeout(() => form.name.focus(), 60);
}

function submitSubForm(e) {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim();
  const price = parseFloat(String(f.price.value).replace(',', '.'));
  const nextDate = f.nextDate.value;
  const err = $('#formError');
  if (!name) { err.textContent = 'Вкажіть назву сервісу'; f.name.focus(); return; }
  if (!(price >= 0)) { err.textContent = 'Вкажіть коректну ціну'; f.price.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) { err.textContent = 'Вкажіть дату списання'; f.nextDate.focus(); return; }
  const urlRaw = f.url.value.trim();
  const url = urlRaw ? safeUrl(urlRaw) : '';
  if (urlRaw && !url) { err.textContent = 'Некоректне посилання'; f.url.focus(); return; }

  const data = {
    name, url, price: Math.round(price * 100) / 100,
    currency: f.currency.value, period: f.period.value, nextDate,
    anchorDay: parseDate(nextDate).getDate(),
    category: f.category.value, status: f.status.value, note: f.note.value.trim(),
    updatedAt: new Date().toISOString(),
  };
  if (ui.editingId) {
    const s = state.subs.find(x => x.id === ui.editingId);
    Object.assign(s, data);
    toast('Збережено');
  } else {
    state.subs.push(normalizeSub({ ...data, id: uid(), createdAt: new Date().toISOString() }));
    toast('Підписку додано');
  }
  rollForward();
  save();
  $('#subDialog').close();
  renderAll();
  checkReminders();
}

function deleteSub(id) {
  const idx = state.subs.findIndex(s => s.id === id);
  if (idx < 0) return;
  const [removed] = state.subs.splice(idx, 1);
  save(); renderAll();
  toast(`Видалено «${removed.name}»`, 'Повернути', () => {
    state.subs.splice(idx, 0, removed); save(); renderAll();
  });
}

function setStatus(id, status, msg) {
  const s = state.subs.find(x => x.id === id);
  if (!s) return;
  const prev = s.status;
  s.status = status; s.updatedAt = new Date().toISOString();
  rollForward(); save(); renderAll();
  toast(msg || `«${s.name}»: ${STATUSES[status]}`, 'Скасувати', () => { s.status = prev; save(); renderAll(); });
}

/* ---------------------------------------------------------
   Нагадування: браузер + Telegram
   --------------------------------------------------------- */
function scheduleReminders() {
  clearInterval(reminderTimer);
  setTimeout(checkReminders, 1500);
  reminderTimer = setInterval(() => {
    if (!state) return;
    if (rollForward()) { save(); renderAll(); }
    checkReminders();
  }, 60 * 60 * 1000);
}

function dueSoon() {
  const days = Number(state.settings.remindDays);
  return state.subs
    .filter(s => isCharging(s))
    .map(s => ({ s, d: daysUntil(s.nextDate) }))
    .filter(x => x.d >= 0 && x.d <= days)
    .sort((a, b) => a.d - b.d);
}

async function checkReminders(force = false) {
  if (!state) return;
  const st = state.settings;
  const canBrowser = st.browserNotify && 'Notification' in window && Notification.permission === 'granted';
  const canTg = st.tg.enabled && st.tg.token && st.tg.chatId;

  // прибираємо старі записи
  const cutoff = toISO(addDays(today(), -60));
  for (const k of Object.keys(state.notified)) if ((k.split('|')[1] || '') < cutoff) delete state.notified[k];

  const items = dueSoon().filter(({ s }) => force || !state.notified[`${s.id}|${s.nextDate}`]);
  if (!items.length) { if (force) toast('Найближчих списань немає'); return; }
  if (!canBrowser && !canTg) { if (force) toast('Увімкніть сповіщення або Telegram'); return; }

  let ok = false;
  if (canBrowser) {
    for (const { s, d } of items) {
      try {
        await showBrowserNotification(`${s.name} — ${dueLabel(d)}`, `${fmtMoney(s.price, s.currency)} · ${fmtDate(s.nextDate)}${s.note ? '\n' + s.note : ''}`, `${s.id}|${s.nextDate}`);
        ok = true;
      } catch (e) { console.warn(e); }
    }
  }
  if (canTg) {
    const text = '<b>Нагадування про списання</b>\n\n' + items.map(({ s, d }) =>
      `• <b>${esc(s.name)}</b> — ${esc(fmtMoney(s.price, s.currency))}, ${esc(dueLabel(d))} (${esc(fmtDate(s.nextDate))})` +
      (s.note ? `\n   <i>${esc(s.note)}</i>` : '') + (safeUrl(s.url) ? `\n   ${esc(safeUrl(s.url))}` : '')
    ).join('\n');
    try { await sendTelegram(text); ok = true; } catch (e) { console.warn(e); toast('Telegram: ' + e.message); }
  }
  if (ok) {
    items.forEach(({ s }) => { state.notified[`${s.id}|${s.nextDate}`] = Date.now(); });
    save();
    if (force) toast('Нагадування надіслано');
  }
}

async function showBrowserNotification(title, body, tag) {
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (reg) return reg.showNotification(title, opts);
  return new Notification(title, opts);
}

async function sendTelegram(text) {
  const { token, chatId } = state.settings.tg;
  if (!/^\d+:[\w-]+$/.test(token)) throw new Error('некоректний Bot Token');
  // form-urlencoded — "простий" запит без CORS preflight
  const body = new URLSearchParams({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: 'true' });
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.description || `HTTP ${res.status}`);
  return json;
}

/* ---------------------------------------------------------
   Курси валют
   --------------------------------------------------------- */
function changeBaseCurrency(newBase) {
  const st = state.settings;
  const k = st.rates[newBase] || 1;
  const rates = {};
  for (const c of Object.keys(CURRENCIES)) rates[c] = (st.rates[c] || 1) / k;
  rates[newBase] = 1;
  st.rates = rates;
  st.baseCurrency = newBase;
  save(); renderSettings(); renderSummary();
}

async function fetchRates() {
  const btn = $('#fetchRates');
  const base = state.settings.baseCurrency;
  btn.disabled = true; btn.textContent = 'Завантаження…';
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
    const json = await res.json();
    if (json.result !== 'success') throw new Error('сервіс недоступний');
    for (const c of Object.keys(CURRENCIES)) {
      if (json.rates[c]) state.settings.rates[c] = 1 / json.rates[c]; // скільки base за 1 c
    }
    state.settings.rates[base] = 1;
    state.settings.ratesUpdated = new Date().toISOString();
    save(); renderSettings(); renderSummary();
    toast('Курси оновлено');
  } catch (e) {
    toast('Не вдалося оновити курси: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '↻ Оновити курси онлайн';
  }
}

/* ---------------------------------------------------------
   PIN: встановлення / зміна / вимкнення
   --------------------------------------------------------- */
let pinMode = 'set'; // set | change | disable

function openPinDialog(mode) {
  pinMode = mode;
  $('#pinDialogTitle').textContent = { set: 'Встановити PIN', change: 'Змінити PIN', disable: 'Вимкнути PIN' }[mode];
  $('#pinCurrentWrap').hidden = mode === 'set';
  $('#pinNewWrap').hidden = mode === 'disable';
  ['#pinCurrent', '#pinNew', '#pinNew2'].forEach(s => { $(s).value = ''; });
  $('#pinError').textContent = '';
  $('#pinDialog').showModal();
  setTimeout(() => (mode === 'set' ? $('#pinNew') : $('#pinCurrent')).focus(), 60);
}

async function verifyCurrentPin(pin) {
  try {
    const key = await deriveKey(pin, meta.lock.salt, meta.lock.iter);
    const raw = JSON.parse(localStorage.getItem(LS_DATA) || 'null');
    if (raw?.enc) await decryptJSON(raw, key);
    return true;
  } catch { return false; }
}

async function submitPin(e) {
  e.preventDefault();
  const err = $('#pinError');
  if (!window.crypto?.subtle) { err.textContent = 'Потрібне HTTPS-з\'єднання'; return; }
  const cur = $('#pinCurrent').value, p1 = $('#pinNew').value, p2 = $('#pinNew2').value;
  const submitBtn = $('#pinForm button[type=submit]');

  if (pinMode !== 'set') {
    await saveChain;
    if (!(await verifyCurrentPin(cur))) { err.textContent = 'Невірний поточний PIN'; return; }
  }
  if (pinMode === 'disable') {
    if (!confirm('Вимкнути PIN? Дані зберігатимуться у відкритому вигляді.')) return;
    meta.lock = null; cryptoKey = null; saveMeta();
    await save();
    $('#pinDialog').close();
    renderAll();
    toast('PIN вимкнено');
    return;
  }
  if (p1.length < 4) { err.textContent = 'Мінімум 4 символи'; return; }
  if (p1 !== p2) { err.textContent = 'PIN-коди не збігаються'; return; }

  submitBtn.disabled = true;
  try {
    const salt = b64.from(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveKey(p1, salt, PBKDF2_ITER);
    await saveChain;
    meta.lock = { salt, iter: PBKDF2_ITER };
    meta.failed = 0; meta.lockUntil = 0;
    cryptoKey = key;
    await save();
    saveMeta();
    $('#pinDialog').close();
    renderAll();
    resetIdle();
    toast(pinMode === 'set' ? 'PIN встановлено, дані зашифровано' : 'PIN змінено');
  } finally {
    submitBtn.disabled = false;
  }
}

/* ---------------------------------------------------------
   Експорт / імпорт
   --------------------------------------------------------- */
function exportJSON() {
  const payload = {
    app: 'subtrack', version: 1, exportedAt: new Date().toISOString(),
    data: { ...state, notified: {} },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `substrack-backup-${toISO(today())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Резервну копію завантажено');
}

async function importJSON(file) {
  try {
    const json = JSON.parse(await file.text());
    const data = json?.data || json; // підтримка "голого" формату
    if (!Array.isArray(data?.subs)) throw new Error('невідомий формат файлу');
    const n = data.subs.length;
    const replace = confirm(`У файлі ${n} ${plural(n, 'підписка', 'підписки', 'підписок')}.\n\nОК — замінити всі поточні дані\nСкасувати — додати до наявних`);
    const incoming = normalizeState(data);
    if (replace) {
      state = incoming;
    } else {
      const ids = new Set(state.subs.map(s => s.id));
      incoming.subs.forEach(s => { if (ids.has(s.id)) s.id = uid(); state.subs.push(s); });
    }
    rollForward(); await save(); renderAll();
    toast(`Імпортовано: ${n}`);
  } catch (e) {
    toast('Помилка імпорту: ' + e.message);
  }
}

function addDemo() {
  const t = today();
  const d = n => toISO(addDays(t, n));
  const demo = [
    { name: 'Netflix', url: 'https://www.netflix.com/cancelplan', price: 43, currency: 'PLN', period: 'monthly', nextDate: d(1), category: 'entertainment', note: 'Спільний акаунт з сестрою' },
    { name: 'Spotify', url: 'https://www.spotify.com/account', price: 23.99, currency: 'PLN', period: 'monthly', nextDate: d(3), category: 'entertainment' },
    { name: 'iCloud+ 200 ГБ', url: 'https://www.icloud.com', price: 2.99, currency: 'USD', period: 'monthly', nextDate: d(9), category: 'other', note: 'Картка Visa' },
    { name: 'ChatGPT Plus', url: 'https://chat.openai.com', price: 20, currency: 'USD', period: 'monthly', nextDate: d(14), category: 'work' },
    { name: 'Coursera Plus', url: 'https://www.coursera.org', price: 399, currency: 'USD', period: 'yearly', nextDate: d(120), category: 'education', status: 'cancelling', note: 'Скасувати до 15 числа' },
    { name: 'Інтернет', url: '', price: 60, currency: 'PLN', period: 'monthly', nextDate: d(6), category: 'utilities' },
    { name: 'Київстар', url: '', price: 250, currency: 'UAH', period: 'monthly', nextDate: d(20), category: 'utilities' },
    { name: 'Спортзал', url: '', price: 35, currency: 'PLN', period: 'weekly', nextDate: d(2), category: 'other', status: 'paused' },
  ];
  demo.forEach(x => state.subs.push(normalizeSub({ status: 'active', ...x })));
  save(); renderAll();
  toast('Демо-дані додано');
}

/* ---------------------------------------------------------
   Тост
   --------------------------------------------------------- */
let toastTimer = null;
function toast(msg, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : '');
  if (actionLabel) el.querySelector('button').onclick = () => { action(); el.classList.remove('show'); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 6000 : 2800);
}

/* ---------------------------------------------------------
   Service Worker (офлайн + сповіщення на Android)
   --------------------------------------------------------- */
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
  }
}

/* ---------------------------------------------------------
   Обробники подій
   --------------------------------------------------------- */
function bindEvents() {
  // Навігація
  $$('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#themeToggle').addEventListener('click', () => setTheme(meta.theme === 'dark' ? 'light' : 'dark'));
  $$('#themeSeg button').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
  $('#lockNow').addEventListener('click', lockNow);
  $('#fab').addEventListener('click', () => openSubForm(null, meta.view === 'calendar' && ui.calSelected ? { nextDate: ui.calSelected } : {}));

  // Фільтри
  $('#searchInput').addEventListener('input', e => { ui.search = e.target.value; renderList(); });
  $('#statusFilter').addEventListener('change', e => { ui.status = e.target.value; renderList(); });
  $('#sortSelect').addEventListener('change', e => { ui.sort = e.target.value; renderList(); });
  $('#categoryChips').addEventListener('click', e => {
    const chip = e.target.closest('[data-cat]');
    if (chip) { ui.category = chip.dataset.cat; renderList(); }
  });

  // Список підписок (делегування)
  $('#subList').addEventListener('click', e => {
    const actionEl = e.target.closest('[data-action]');
    const card = e.target.closest('.item');
    const action = actionEl?.dataset.action;
    if (action === 'add') return openSubForm();
    if (!card) return;
    const id = card.dataset.id;
    const sub = state.subs.find(s => s.id === id);
    if (!sub) return;
    switch (action) {
      case 'open': return; // звичайне посилання
      case 'quickcancel': {
        const url = safeUrl(sub.url);
        if (url) window.open(url, '_blank', 'noopener');
        return setStatus(id, 'cancelled', `«${sub.name}» позначено як скасовану`);
      }
      case 'pause': return setStatus(id, 'paused');
      case 'restore': return setStatus(id, 'active');
      default: return openSubForm(id);
    }
  });

  $('#subList').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('item')) openSubForm(e.target.dataset.id);
  });

  // Календар
  $('#calPrev').addEventListener('click', () => shiftMonth(-1));
  $('#calNext').addEventListener('click', () => shiftMonth(1));
  $('#calToday').addEventListener('click', () => {
    const t = today(); ui.calYear = t.getFullYear(); ui.calMonth = t.getMonth(); ui.calSelected = toISO(t); renderCalendar();
  });
  $('#calGrid').addEventListener('click', e => {
    const cell = e.target.closest('[data-date]');
    if (!cell) return;
    ui.calSelected = cell.dataset.date;
    const d = parseDate(ui.calSelected);
    if (d.getMonth() !== ui.calMonth) { ui.calMonth = d.getMonth(); ui.calYear = d.getFullYear(); }
    renderCalendar();
  });
  $('#calDay').addEventListener('click', e => {
    const item = e.target.closest('[data-id]');
    if (item) openSubForm(item.dataset.id);
  });
  // Свайп по календарю на телефоні
  let touchX = null;
  $('#calGrid').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  $('#calGrid').addEventListener('touchend', e => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) shiftMonth(dx < 0 ? 1 : -1);
    touchX = null;
  });

  // Форма
  $('#subForm').addEventListener('submit', submitSubForm);
  $('#subDelete').addEventListener('click', () => {
    const id = ui.editingId;
    const s = state.subs.find(x => x.id === id);
    if (s && confirm(`Видалити «${s.name}»?`)) { $('#subDialog').close(); deleteSub(id); }
  });
  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // Налаштування
  $('#baseCurrency').addEventListener('change', e => changeBaseCurrency(e.target.value));
  $('#ratesList').addEventListener('change', e => {
    const c = e.target.dataset.rate;
    const v = parseFloat(e.target.value);
    if (c && v > 0) { state.settings.rates[c] = v; save(); renderSummary(); }
  });
  $('#fetchRates').addEventListener('click', fetchRates);
  $('#remindDays').addEventListener('change', e => {
    state.settings.remindDays = Math.min(30, Math.max(0, parseInt(e.target.value, 10) || 0));
    save(); renderSummary();
  });
  $('#browserNotify').addEventListener('change', async e => {
    if (e.target.checked) {
      if (!('Notification' in window)) { e.target.checked = false; return toast('Сповіщення не підтримуються'); }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { e.target.checked = false; state.settings.browserNotify = false; save(); renderSettings(); return toast('Дозвіл не надано'); }
      state.settings.browserNotify = true;
      save(); renderSettings();
      showBrowserNotification('subtrack', 'Сповіщення увімкнено', 'test').catch(() => {});
    } else {
      state.settings.browserNotify = false; save(); renderSettings();
    }
  });
  const saveTg = () => {
    state.settings.tg = { enabled: $('#tgEnabled').checked, token: $('#tgToken').value.trim(), chatId: $('#tgChat').value.trim() };
    save();
  };
  ['#tgEnabled', '#tgToken', '#tgChat'].forEach(s => $(s).addEventListener('change', saveTg));
  $('#tgTest').addEventListener('click', async () => {
    saveTg();
    try { await sendTelegram('subtrack: тестове повідомлення. Нагадування працюють.'); toast('Повідомлення надіслано'); }
    catch (e) { toast('' + e.message); }
  });
  $('#remindNow').addEventListener('click', () => checkReminders(true));
  $('#autoLock').addEventListener('change', e => {
    state.settings.autoLockMin = Math.min(240, Math.max(0, parseInt(e.target.value, 10) || 0));
    save(); resetIdle();
  });
  $('#pinSet').addEventListener('click', () => openPinDialog(meta.lock ? 'change' : 'set'));
  $('#pinDisable').addEventListener('click', () => openPinDialog('disable'));
  $('#pinForm').addEventListener('submit', submitPin);
  $('#exportBtn').addEventListener('click', exportJSON);
  $('#importInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) importJSON(f); e.target.value = ''; });
  $('#demoBtn').addEventListener('click', addDemo);
  $('#wipeBtn').addEventListener('click', () => {
    if (!confirm('Видалити ВСІ підписки та налаштування? Цю дію не можна скасувати.')) return;
    if (prompt('Для підтвердження введіть: ВИДАЛИТИ') !== 'ВИДАЛИТИ') return;
    state = defaultState(); save(); renderAll(); toast('Дані видалено');
  });

  // Активність користувача → скидання таймера автоблокування
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => { if (state) resetIdle(); }, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!state) return;
    const min = Number(state.settings.autoLockMin) || 0;
    if (meta.lock && min > 0 && hiddenAt && Date.now() - hiddenAt > min * 60_000) return lockNow();
    if (rollForward()) save();
    renderAll();
    checkReminders();
  });

  // Гарячі клавіші: N — нова підписка, Esc закриває діалоги (нативно)
  document.addEventListener('keydown', e => {
    if (!state || e.target.matches('input, textarea, select') || $('dialog[open]')) return;
    if (e.key === 'n' || e.key === 'т') { e.preventDefault(); openSubForm(); }
  });
}

function shiftMonth(delta) {
  const d = new Date(ui.calYear, ui.calMonth + delta, 1);
  ui.calYear = d.getFullYear(); ui.calMonth = d.getMonth();
  ui.calSelected = toISO(d.getMonth() === today().getMonth() && d.getFullYear() === today().getFullYear() ? today() : d);
  renderCalendar();
}

/* Екран блокування — обробники (працюють і до розблокування) */
$('#lockForm').addEventListener('submit', e => { e.preventDefault(); tryUnlock($('#lockInput').value); });
$('#lockForgot').addEventListener('click', () => {
  if (!confirm('PIN неможливо відновити — дані зашифровано ним.\n\nСкинути застосунок і видалити ВСІ дані? (Потім можна відновити з резервної копії JSON.)')) return;
  if (prompt('Для підтвердження введіть: ВИДАЛИТИ') !== 'ВИДАЛИТИ') return;
  localStorage.removeItem(LS_DATA);
  meta.lock = null; meta.failed = 0; meta.lockUntil = 0; saveMeta();
  state = defaultState();
  startApp();
});

boot();
