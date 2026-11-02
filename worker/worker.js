/* =========================================================
   subtrack — сервер нагадувань (Cloudflare Worker, безкоштовний тариф)

   Що робить:
   • POST /sync     — Mini App надсилає сюди список підписок (автентифікація через Telegram initData)
   • POST /unsync   — видалити свої дані з сервера
   • POST /webhook  — вебхук бота: /start, /next, /help
   • GET  /setup    — одноразове налаштування вебхука й команд бота (?key=WEBHOOK_SECRET)
   • cron (щогодини) — надсилає нагадування в обрану користувачем годину

   Змінні середовища (Settings → Variables and Secrets):
   • BOT_TOKEN        (secret)  — токен бота від @BotFather
   • WEBHOOK_SECRET   (secret)  — будь-який випадковий рядок (A-Z, a-z, 0-9, _ і -)
   • APP_URL          (text)    — адреса застосунку, напр. https://thordiichuk.github.io/SubscribesTrack/
   • ALLOWED_USER_IDS (text)    — ваш Telegram ID (кілька — через кому). Порожньо = доступ для всіх.
   Прив'язка KV-сховища: змінна з назвою KV.
   Один файл без залежностей — можна вставити прямо в онлайн-редактор Cloudflare.
   ========================================================= */

const MAX_BODY = 200_000;
const AUTH_MAX_AGE = 48 * 3600; // initData дійсні 48 год

const CURRENCIES = { PLN: ['zł', false], USD: ['$', true], EUR: ['€', true], UAH: ['₴', false], GBP: ['£', true], CHF: ['CHF', false], CZK: ['Kč', false] };
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/* ---------------- HTTP ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (request.method === 'POST' && url.pathname === '/sync') return cors(await handleSync(request, env));
      if (request.method === 'POST' && url.pathname === '/unsync') return cors(await handleUnsync(request, env));
      if (request.method === 'POST' && url.pathname === '/webhook') return await handleWebhook(request, env, ctx);
      if (request.method === 'GET' && url.pathname === '/setup') return await handleSetup(url, env);
      if (request.method === 'GET' && url.pathname === '/') return new Response('subtrack reminders: OK');
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (!e.status) console.error(e);
      return cors(json({ ok: false, error: e.message || 'error' }, e.status || 500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'POST, OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  h.set('access-control-max-age', '86400');
  return new Response(res.body, { status: res.status, headers: h });
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/* ---------------- Автентифікація Telegram initData ---------------- */
const enc = new TextEncoder();
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data));
}
const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Перевіряє підпис initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) */
export async function verifyInitData(initData, botToken, nowSec = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams(initData || '');
  const hash = params.get('hash');
  if (!hash) throw httpError(401, 'no hash');
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const expected = toHex(await hmac(secret, dataCheck));
  if (!safeEqual(expected, hash)) throw httpError(401, 'bad signature');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || nowSec - authDate > AUTH_MAX_AGE) throw httpError(401, 'initData expired — перевідкрийте застосунок');
  const user = JSON.parse(params.get('user') || 'null');
  if (!user?.id) throw httpError(401, 'no user');
  return user;
}

function checkAllowed(env, userId) {
  const list = String(env.ALLOWED_USER_IDS || '').split(/[,\s]+/).filter(Boolean);
  if (list.length && !list.includes(String(userId))) throw httpError(403, 'Цей бот приватний');
}

/* ---------------- /sync ---------------- */
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw httpError(413, 'too large');
  try { return JSON.parse(text); } catch { throw httpError(400, 'bad json'); }
}

function cleanSub(s) {
  if (!s || typeof s !== 'object' || !s.name || !/^\d{4}-\d{2}-\d{2}$/.test(s.nextDate)) return null;
  return {
    id: String(s.id || '').slice(0, 64),
    name: String(s.name).slice(0, 80),
    price: Number(s.price) || 0,
    currency: CURRENCIES[s.currency] ? s.currency : 'PLN',
    period: ['monthly', 'yearly', 'weekly', 'once'].includes(s.period) ? s.period : 'monthly',
    nextDate: s.nextDate,
    anchorDay: Number(s.anchorDay) || Number(s.nextDate.slice(8, 10)),
    status: ['active', 'paused', 'cancelling', 'cancelled'].includes(s.status) ? s.status : 'active',
    note: s.note ? String(s.note).slice(0, 300) : '',
    url: /^https?:\/\//.test(s.url || '') ? String(s.url).slice(0, 500) : '',
  };
}

async function handleSync(request, env) {
  const body = await readJson(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  checkAllowed(env, user.id);
  const p = body.payload || {};
  let tz = String(p.tz || 'UTC');
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
  const record = {
    chatId: user.id,
    subs: (Array.isArray(p.subs) ? p.subs : []).slice(0, 500).map(cleanSub).filter(Boolean),
    remindDays: Math.min(30, Math.max(0, parseInt(p.remindDays, 10) || 0)),
    remindHour: Math.min(23, Math.max(0, parseInt(p.remindHour, 10) || 0)),
    tz,
    updatedAt: new Date().toISOString(),
  };
  await env.KV.put(`user:${user.id}`, JSON.stringify(record));
  const upcoming = dueList(record, localToday(tz), Math.max(record.remindDays, 7));
  return json({ ok: true, count: record.subs.length, upcoming: upcoming.length });
}

async function handleUnsync(request, env) {
  const body = await readJson(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  await env.KV.delete(`user:${user.id}`);
  await env.KV.delete(`sent:${user.id}`);
  return json({ ok: true });
}

/* ---------------- Дати (ISO-рядки, обчислення в UTC) ---------------- */
function localToday(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function localHour(tz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}
const isoToUTC = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const utcToISO = t => new Date(t).toISOString().slice(0, 10);
const daysBetween = (fromISO, toISO) => Math.round((isoToUTC(toISO) - isoToUTC(fromISO)) / 86400000);
function addMonthsAnchored(iso, n, anchor) {
  const [y, m] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return utcToISO(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor, dim)));
}
function nextOccurrence(s, iso) {
  if (s.period === 'weekly') return utcToISO(isoToUTC(iso) + 7 * 86400000);
  if (s.period === 'monthly') return addMonthsAnchored(iso, 1, s.anchorDay);
  if (s.period === 'yearly') return addMonthsAnchored(iso, 12, s.anchorDay);
  return null;
}
/** Найближча дата списання, не раніше today (повторювані підписки "прокручуються" вперед) */
function currentDate(s, today) {
  let d = s.nextDate, guard = 0;
  if (s.period === 'once') return d;
  while (d < today && guard++ < 1000) d = nextOccurrence(s, d);
  return d;
}

/** Списання в найближчі `horizon` днів: [{s, date, days}] */
export function dueList(record, today, horizon) {
  const out = [];
  for (const s of record.subs) {
    if (s.status !== 'active' && s.status !== 'cancelling') continue;
    const date = currentDate(s, today);
    const days = daysBetween(today, date);
    if (days >= 0 && days <= horizon) out.push({ s, date, days });
  }
  return out.sort((a, b) => a.days - b.days || a.s.name.localeCompare(b.s.name));
}

/* ---------------- Форматування ---------------- */
const esc = str => String(str ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function money(v, cur) {
  const [sym, prefix] = CURRENCIES[cur] || [cur, false];
  const n = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v);
  return prefix ? `${sym}${n}` : `${n} ${sym}`;
}
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}
function dueLabel(days) {
  if (days === 0) return 'сьогодні';
  if (days === 1) return 'завтра';
  return `через ${days} ${plural(days, 'день', 'дні', 'днів')}`;
}
const fmtDate = iso => `${Number(iso.slice(8, 10))} ${MONTHS_GEN[Number(iso.slice(5, 7)) - 1]}`;
function line({ s, date, days }, withDue = true) {
  let t = `• <b>${esc(s.name)}</b> — ${esc(money(s.price, s.currency))}`;
  if (withDue) t += `, ${dueLabel(days)} (${fmtDate(date)})`;
  if (s.status === 'cancelling') t += '\n   ⚠️ <i>заплановано скасувати</i>';
  if (s.note) t += `\n   <i>${esc(s.note)}</i>`;
  return t;
}

/* ---------------- Telegram API ---------------- */
async function tgApi(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}
const openButton = env => (env.APP_URL ? { inline_keyboard: [[{ text: 'Відкрити subtrack', web_app: { url: env.APP_URL } }]] } : undefined);

/* ---------------- Нагадування (cron) ---------------- */
export async function runReminders(env, { force = false } = {}) {
  let cursor, sentCount = 0;
  do {
    const page = await env.KV.list({ prefix: 'user:', cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      try { sentCount += await remindUser(env, k.name, force); } catch (e) { console.error(k.name, e); }
    }
  } while (cursor);
  return sentCount;
}

async function remindUser(env, key, force) {
  const record = JSON.parse((await env.KV.get(key)) || 'null');
  if (!record) return 0;
  if (!force && localHour(record.tz) !== record.remindHour) return 0;
  const today = localToday(record.tz);
  const sentKey = `sent:${record.chatId}`;
  const sent = JSON.parse((await env.KV.get(sentKey)) || '{}');

  const todayItems = [], soonItems = [];
  for (const item of dueList(record, today, record.remindDays)) {
    const base = `${item.s.id}|${item.date}`;
    if (item.days === 0) {
      if (!sent[`${base}|day`]) { todayItems.push(item); sent[`${base}|day`] = today; }
    } else if (!sent[`${base}|early`]) {
      soonItems.push(item); sent[`${base}|early`] = today;
    }
  }
  if (!todayItems.length && !soonItems.length) return 0;

  let text = '🔔 <b>Нагадування про списання</b>';
  if (todayItems.length) text += '\n\n<b>Сьогодні</b>\n' + todayItems.map(i => line(i, false)).join('\n');
  if (soonItems.length) text += '\n\n<b>Незабаром</b>\n' + soonItems.map(i => line(i)).join('\n');
  await tgApi(env, 'sendMessage', { chat_id: record.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: openButton(env) });

  // прибираємо записи старші за 60 днів
  const cutoff = utcToISO(isoToUTC(today) - 60 * 86400000);
  for (const k of Object.keys(sent)) if (sent[k] < cutoff) delete sent[k];
  await env.KV.put(sentKey, JSON.stringify(sent));
  return 1;
}

/* ---------------- Вебхук бота ---------------- */
async function handleWebhook(request, env, ctx) {
  if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (!msg?.text || msg.chat?.type !== 'private') return new Response('ok');
  const userId = msg.from?.id;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  const reply = (text, extra = {}) => tgApi(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

  ctx.waitUntil((async () => {
    try {
      try { checkAllowed(env, userId); } catch { return reply('Це приватний бот 🙂'); }
      if (cmd === '/next' || cmd === '/soon') {
        const record = JSON.parse((await env.KV.get(`user:${userId}`)) || 'null');
        if (!record) return reply('Даних ще немає. Відкрийте застосунок і вкажіть адресу сервера в «Опції → Нагадування».', { reply_markup: openButton(env) });
        const list = dueList(record, localToday(record.tz), 30);
        if (!list.length) return reply('У найближчі 30 днів списань немає ✨', { reply_markup: openButton(env) });
        const total = {};
        list.forEach(({ s }) => { total[s.currency] = (total[s.currency] || 0) + s.price; });
        const sum = Object.entries(total).map(([c, v]) => money(v, c)).join(' + ');
        return reply(`<b>Найближчі 30 днів</b>\n\n${list.map(i => line(i)).join('\n')}\n\nРазом: <b>${esc(sum)}</b>`, { reply_markup: openButton(env) });
      }
      if (cmd === '/start' || cmd === '/help' || cmd === '/open') {
        return reply('Привіт! Я <b>subtrack</b> — трекер ваших підписок.\n\n• Кнопка нижче відкриває застосунок\n• /next — списання на найближчі 30 днів\n\nНагадування надходять самі в обрану годину.', { reply_markup: openButton(env) });
      }
      return reply('Команди: /next — найближчі списання, /start — відкрити застосунок.');
    } catch (e) { console.error(e); }
  })());
  return new Response('ok');
}

/* ---------------- Одноразове налаштування ---------------- */
async function handleSetup(url, env) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const missing = ['BOT_TOKEN', 'WEBHOOK_SECRET', 'KV'].filter(k => !env[k]);
  if (missing.length) return json({ ok: false, error: 'Не налаштовано: ' + missing.join(', ') }, 500);
  const hook = `${url.origin}/webhook`;
  const results = {};
  results.webhook = await tgApi(env, 'setWebhook', { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true });
  results.commands = await tgApi(env, 'setMyCommands', { commands: [
    { command: 'next', description: 'Найближчі списання' },
    { command: 'start', description: 'Відкрити застосунок' },
  ] });
  if (url.searchParams.get('test') === '1') results.remindersSent = await runReminders(env, { force: true });
  return json({ ok: true, webhook: hook, results, allowedUsers: env.ALLOWED_USER_IDS || '(усі — рекомендуємо вказати свій ID)' });
}
