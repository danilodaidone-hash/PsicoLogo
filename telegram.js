// PsicoLogo – promemoria degli appuntamenti con un bot di Telegram (gratuito).
// Il professionista crea il bot con @BotFather e inserisce la chiave nel Profilo: resta cifrata sul server.
// Ogni paziente si collega una volta con un link personale; il server poi invia i promemoria il giorno prima.
'use strict';
const crypto = require('node:crypto');

const DAY_NAMES = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const DEFAULT_TEXT = 'Promemoria per {nome}: appuntamento {giorno} alle ore {ora}, {luogo}.\n\n{professionista}';
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const CODE_DAYS = 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function romeNow(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')) };
}
const addDay = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : 18 * 60; };
const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d)); return `${DAY_NAMES[t.getUTCDay()]} ${d} ${MONTHS[m - 1]}`; };
const fmtDate = iso => iso.split('-').reverse().join('/');

module.exports = function createTelegram({ db, encrypt, decrypt, log, readDoc, apiBase }) {
  const BASE = (apiBase || 'https://api.telegram.org').replace(/\/$/, '');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_links (patient_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, linked INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_codes (code TEXT PRIMARY KEY, patient_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_sent (appt_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER, sent INTEGER NOT NULL, status TEXT NOT NULL, answered INTEGER, error TEXT);
  `);
  const st = {
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    delMeta: db.prepare('DELETE FROM meta WHERE key = ?'),
    links: db.prepare('SELECT patient_id, chat_id, linked FROM tg_links'),
    link: db.prepare('SELECT * FROM tg_links WHERE patient_id = ?'),
    setLink: db.prepare('INSERT INTO tg_links (patient_id, chat_id, linked) VALUES (?, ?, ?) ON CONFLICT(patient_id) DO UPDATE SET chat_id = excluded.chat_id, linked = excluded.linked'),
    delLink: db.prepare('DELETE FROM tg_links WHERE patient_id = ?'),
    delLinksByChat: db.prepare('DELETE FROM tg_links WHERE chat_id = ?'),
    code: db.prepare('SELECT * FROM tg_codes WHERE code = ?'),
    addCode: db.prepare('INSERT INTO tg_codes (code, patient_id, expires) VALUES (?, ?, ?)'),
    delCodesFor: db.prepare('DELETE FROM tg_codes WHERE patient_id = ?'),
    purgeCodes: db.prepare('DELETE FROM tg_codes WHERE expires < ?'),
    sent: db.prepare('SELECT * FROM tg_sent WHERE appt_id = ?'),
    sentRecent: db.prepare('SELECT appt_id, status, sent, answered, error FROM tg_sent WHERE sent > ?'),
    upsertSent: db.prepare('INSERT INTO tg_sent (appt_id, patient_id, chat_id, message_id, sent, status, answered, error) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(appt_id) DO UPDATE SET patient_id = excluded.patient_id, chat_id = excluded.chat_id, message_id = excluded.message_id, sent = excluded.sent, status = excluded.status, answered = NULL, error = excluded.error'),
    answer: db.prepare('UPDATE tg_sent SET status = ?, answered = ? WHERE appt_id = ?'),
  };
  const meta = k => { const r = st.meta.get(k); return r ? r.value : null; };
  const getToken = () => { const v = meta('tg_token'); if (!v) return null; try { return decrypt(v); } catch { return null; } };

  async function call(method, params, token = getToken()) {
    if (!token) throw Object.assign(new Error('Bot non configurato'), { code: 0 });
    const r = await fetch(`${BASE}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
    });
    const j = await r.json().catch(() => ({ ok: false, description: 'risposta non valida (HTTP ' + r.status + ')' }));
    if (!j.ok) throw Object.assign(new Error(j.description || 'errore Telegram'), { code: j.error_code || r.status });
    return j.result;
  }

  /* ---------- testo del promemoria ---------- */
  function render(data, a) {
    const me = data.me || {}, cfg = me.tg || {};
    const p = (data.patients || []).find(x => x.id === a.patientId) || {};
    const s = (data.studi || []).find(x => x.id === a.studioId) || {};
    const link = a.online ? (a.link || s.link || '') : '';
    const vars = {
      nome: p.nome || '', paziente: [p.nome, p.cognome].filter(Boolean).join(' '),
      giorno: dayLabel(a.date), data: fmtDate(a.date), ora: a.start || '',
      studio: s.nome || '', luogo: a.online ? 'seduta online' : [s.nome, s.indirizzo].filter(Boolean).join(', '),
      professionista: [me.titolo, me.nome, me.cognome].filter(Boolean).join(' '), link,
    };
    let t = String(cfg.text || DEFAULT_TEXT).slice(0, 1000).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    if (link && !/\{link\}/.test(cfg.text || '')) t += `\n\nLink per la seduta: ${link}`;
    return t.slice(0, 3500);
  }

  /* ---------- invio di un promemoria ---------- */
  async function sendReminder(data, a, manual) {
    const p = (data.patients || []).find(x => x.id === a.patientId);
    if (!p) return { ok: false, error: 'Paziente non trovato' };
    if (!(p.consensi && p.consensi.telegram)) return { ok: false, error: 'Manca il consenso del paziente ai promemoria su Telegram' };
    const l = st.link.get(p.id);
    if (!l) return { ok: false, error: 'Il paziente non ha ancora collegato Telegram' };
    const keyboard = { inline_keyboard: [[{ text: 'Confermo', callback_data: 'c:' + a.id }, { text: 'Devo disdire', callback_data: 'd:' + a.id }]] };
    try {
      const m = await call('sendMessage', { chat_id: l.chat_id, text: render(data, a), reply_markup: keyboard, disable_web_page_preview: true });
      st.upsertSent.run(a.id, p.id, l.chat_id, m.message_id, Date.now(), 'inviato', null);
      log(manual ? 'promemoria_inviato_a_mano' : 'promemoria_inviato', 'telegram', a.date + ' ' + a.start);
      return { ok: true };
    } catch (e) {
      if (e.code === 403) { st.delLinksByChat.run(l.chat_id); log('telegram_bloccato', 'telegram', p.id); }
      st.upsertSent.run(a.id, p.id, l.chat_id, null, Date.now(), 'errore', String(e.message).slice(0, 200));
      log('promemoria_errore', 'telegram', String(e.message).slice(0, 120));
      return { ok: false, error: e.code === 403 ? 'Il paziente ha bloccato il bot: va ricollegato' : 'Telegram ha risposto: ' + e.message };
    }
  }

  /* ---------- controllo periodico: promemoria per gli appuntamenti di domani ---------- */
  let ticking = false;
  async function tick() {
    if (ticking || !getToken()) return;
    ticking = true;
    try {
      const data = readDoc(); if (!data) return;
      const cfg = (data.me && data.me.tg) || {};
      if (!cfg.enabled) return;
      const now = romeNow();
      if (now.min < toMin(cfg.time)) return;
      const tomorrow = addDay(now.date, 1);
      for (const a of data.appts || []) {
        if (a.date !== tomorrow || a.status !== 'prenotato' || st.sent.get(a.id)) continue;
        const p = (data.patients || []).find(x => x.id === a.patientId);
        if (!p || !(p.consensi && p.consensi.telegram) || !st.link.get(p.id)) continue;
        await sendReminder(data, a, false);
        await sleep(200);
      }
      st.purgeCodes.run(Date.now());
    } catch (e) { console.error('Telegram, promemoria:', e.message); }
    finally { ticking = false; }
  }

  /* ---------- messaggi in arrivo dal bot (lettura periodica, senza webhook) ---------- */
  let running = false, gen = 0;
  async function reply(chatId, text) { try { await call('sendMessage', { chat_id: chatId, text }); } catch (e) { console.error('Telegram, risposta:', e.message); } }
  async function onUpdate(u) {
    const data = readDoc() || {};
    const pro = [data.me && data.me.titolo, data.me && data.me.nome, data.me && data.me.cognome].filter(Boolean).join(' ') || 'lo studio';
    if (u.message && typeof u.message.text === 'string' && u.message.chat && u.message.chat.type === 'private') {
      const chatId = String(u.message.chat.id), text = u.message.text.trim();
      if (/^\/start\b/.test(text)) {
        const code = text.split(/\s+/)[1] || '';
        const c = code && st.code.get(code);
        if (!c || c.expires < Date.now()) return reply(chatId, code ? 'Questo link non è valido o è scaduto: chiedi allo studio un nuovo link.' : `Questo è il servizio di promemoria di ${pro}. Per attivarlo usa il link personale che ti ha dato lo studio.`);
        st.setLink.run(c.patient_id, chatId, Date.now());
        st.delCodesFor.run(c.patient_id);
        log('telegram_collegato', 'telegram', c.patient_id);
        return reply(chatId, `Collegamento riuscito. Riceverai qui i promemoria degli appuntamenti con ${pro}, con i pulsanti per confermare o avvisare se devi disdire.\n\nPer non riceverli più scrivi /stop.`);
      }
      if (/^\/stop\b/.test(text)) {
        st.delLinksByChat.run(chatId);
        log('telegram_scollegato_dal_paziente', 'telegram', '');
        return reply(chatId, 'Fatto: non riceverai più promemoria. Se vorrai riattivarli, chiedi allo studio un nuovo link.');
      }
      return reply(chatId, `Questo è un servizio automatico di promemoria: i messaggi scritti qui non vengono letti. Per qualsiasi comunicazione contatta direttamente ${pro}.`);
    }
    const cq = u.callback_query;
    if (cq && typeof cq.data === 'string') {
      const [kind, apptId] = cq.data.split(':');
      const row = apptId && st.sent.get(apptId);
      const chatId = String((cq.message && cq.message.chat && cq.message.chat.id) || '');
      if (!row || row.chat_id !== chatId || !['c', 'd'].includes(kind)) {
        try { await call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Promemoria non più valido.' }); } catch {}
        return;
      }
      const status = kind === 'c' ? 'confermato' : 'disdetta';
      st.answer.run(status, Date.now(), apptId);
      log(kind === 'c' ? 'promemoria_confermato' : 'promemoria_disdetta', 'telegram', apptId);
      try { await call('answerCallbackQuery', { callback_query_id: cq.id, text: kind === 'c' ? 'Grazie, appuntamento confermato.' : 'Ricevuto: lo studio è stato avvisato.' }); } catch {}
      try {
        await call('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: (cq.message.text || '') + (kind === 'c' ? '\n\nRisposta: confermato. Grazie!' : '\n\nRisposta: devo disdire. Lo studio è stato avvisato e ti ricontatterà se serve.') });
      } catch {}
    }
  }
  async function loop(my) {
    while (running && my === gen && getToken()) {
      try {
        const offset = Number(meta('tg_offset') || 0);
        const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        if (my !== gen) break;
        for (const u of ups) {
          st.setMeta.run('tg_offset', String(u.update_id + 1));
          try { await onUpdate(u); } catch (e) { console.error('Telegram, messaggio:', e.message); }
        }
      } catch (e) {
        if (my !== gen) break;
        if (e.code === 401 || e.code === 404) { console.error('Telegram: la chiave del bot non è più valida.'); log('telegram_chiave_non_valida', 'telegram', ''); break; }
        await sleep(e.code === 409 ? 30000 : 10000);
      }
    }
    if (my === gen) running = false;
  }
  function start() { if (running || !getToken()) return; running = true; loop(++gen); }
  function stop() { running = false; gen++; }

  /* ---------- API per l'app (già autenticata) ---------- */
  async function api(req, res, url, method, ip, { readJson, send }) {
    if (!url.startsWith('/api/telegram')) return false;
    const bot = meta('tg_bot');
    if (url === '/api/telegram' && method === 'GET') {
      const links = {}; for (const l of st.links.all()) links[l.patient_id] = l.linked;
      const sent = {}; for (const r of st.sentRecent.all(Date.now() - 60 * 864e5)) sent[r.appt_id] = { status: r.status, sent: r.sent, answered: r.answered, error: r.error };
      send(res, 200, { configured: !!getToken(), bot, running, links, sent, defaultText: DEFAULT_TEXT }); return true;
    }
    if (url === '/api/telegram/token' && method === 'POST') {
      const b = await readJson(req); const token = String(b.token || '').trim();
      if (!TOKEN_RE.test(token)) { send(res, 400, { error: 'La chiave non sembra quella di un bot: è una riga come 123456789:AAH… che ti dà @BotFather.' }); return true; }
      let me;
      try { me = await call('getMe', {}, token); } catch (e) { send(res, 400, { error: e.code === 401 || e.code === 404 ? 'Telegram non riconosce questa chiave: controlla di averla copiata tutta.' : 'Non riesco a contattare Telegram: ' + e.message }); return true; }
      try { await call('deleteWebhook', {}, token); } catch {}
      stop();
      if (bot && bot !== me.username) { db.exec('DELETE FROM tg_links; DELETE FROM tg_codes;'); }
      st.setMeta.run('tg_token', encrypt(token)); st.setMeta.run('tg_bot', me.username); st.delMeta.run('tg_offset');
      log('telegram_configurato', ip, '@' + me.username);
      start();
      send(res, 200, { ok: true, bot: me.username }); return true;
    }
    if (url === '/api/telegram/token' && method === 'DELETE') {
      stop();
      for (const k of ['tg_token', 'tg_bot', 'tg_offset']) st.delMeta.run(k);
      db.exec('DELETE FROM tg_links; DELETE FROM tg_codes;');
      log('telegram_rimosso', ip, bot ? '@' + bot : '');
      send(res, 200, { ok: true }); return true;
    }
    if (url === '/api/telegram/link' && method === 'POST') {
      if (!getToken() || !bot) { send(res, 400, { error: 'Prima collega il bot nel Profilo.' }); return true; }
      const b = await readJson(req); const pid = String(b.patientId || '');
      const data = readDoc() || {};
      if (!(data.patients || []).some(p => p.id === pid)) { send(res, 404, { error: 'Paziente non trovato.' }); return true; }
      st.delCodesFor.run(pid);
      const code = crypto.randomBytes(12).toString('base64url');
      const expires = Date.now() + CODE_DAYS * 864e5;
      st.addCode.run(code, pid, expires);
      send(res, 200, { url: `https://t.me/${bot}?start=${code}`, expires, bot }); return true;
    }
    const m = /^\/api\/telegram\/link\/([\w-]{1,40})$/.exec(url);
    if (m && method === 'DELETE') { st.delLink.run(m[1]); st.delCodesFor.run(m[1]); log('telegram_scollegato', ip, m[1]); send(res, 200, { ok: true }); return true; }
    if (url === '/api/telegram/send' && method === 'POST') {
      const b = await readJson(req); const data = readDoc() || {};
      const a = (data.appts || []).find(x => x.id === String(b.apptId || ''));
      if (!a) { send(res, 404, { error: 'Appuntamento non trovato: salva e riprova.' }); return true; }
      const r = await sendReminder(data, a, true);
      send(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error }); return true;
    }
    send(res, 404, { error: 'Non trovato' }); return true;
  }

  return {
    api, start, stop, tick, tables: ['tg_links', 'tg_codes', 'tg_sent'],
    _test: { render, romeNow, addDay, dayLabel },
  };
};
module.exports.DEFAULT_TEXT = DEFAULT_TEXT;
