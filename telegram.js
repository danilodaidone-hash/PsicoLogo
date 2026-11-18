// PsicoLogo – promemoria degli appuntamenti con un bot di Telegram (gratuito).
// Il professionista crea il bot con @BotFather e inserisce la chiave nel Profilo: resta cifrata sul server.
// Ogni paziente si collega una volta con un link personale; il server poi invia i promemoria il giorno prima.
'use strict';
const crypto = require('node:crypto');

const DAY_NAMES = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const DEFAULT_TEXT = 'Promemoria per {nome}: appuntamento {giorno} alle ore {ora}, {luogo}.\nPuoi confermare o avvisare se non puoi venire con i pulsanti qui sotto.\n\n{professionista}';
const DEFAULT_TEXT2 = 'Ti ricordo che tra poco, alle ore {ora}, hai l’appuntamento: {luogo}.\n\n{professionista}';
const OWNER = '__owner';
// numero di telefono confrontabile: solo cifre, senza prefisso internazionale italiano
const normTel = t => { let d = String(t || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('39') && d.length >= 11) d = d.slice(2); return d; };
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
// data e ora italiane (es. 2026-11-19 10:00) → istante assoluto, con ora legale/solare corretta
function romeEpoch(date, hhmm) {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = String(hhmm || '00:00').split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
    const g = k => Number(p.find(x => x.type === k).value);
    t += want - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  }
  return t;
}

module.exports = function createTelegram({ db, encrypt, decrypt, log, readDoc, apiBase }) {
  const BASE = (apiBase || 'https://api.telegram.org').replace(/\/$/, '');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_links (patient_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, linked INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_codes (code TEXT PRIMARY KEY, patient_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_sent (appt_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER, sent INTEGER NOT NULL, status TEXT NOT NULL, answered INTEGER, error TEXT);
    CREATE TABLE IF NOT EXISTS tg_second (appt_id TEXT PRIMARY KEY, slot TEXT NOT NULL, sent INTEGER NOT NULL, error TEXT);
  `);
  if (!db.prepare('PRAGMA table_info(tg_sent)').all().some(c => c.name === 'slot')) db.exec("ALTER TABLE tg_sent ADD COLUMN slot TEXT NOT NULL DEFAULT ''");
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
    sentRecent: db.prepare('SELECT s.appt_id, s.status, s.sent, s.answered, s.error, s.slot, t.sent AS second FROM tg_sent s LEFT JOIN tg_second t ON t.appt_id = s.appt_id AND t.slot = s.slot WHERE s.sent > ?'),
    upsertSent: db.prepare('INSERT INTO tg_sent (appt_id, patient_id, chat_id, message_id, sent, status, answered, error, slot) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(appt_id) DO UPDATE SET patient_id = excluded.patient_id, chat_id = excluded.chat_id, message_id = excluded.message_id, sent = excluded.sent, status = excluded.status, answered = NULL, error = excluded.error, slot = excluded.slot'),
    second: db.prepare('SELECT * FROM tg_second WHERE appt_id = ?'),
    upsertSecond: db.prepare('INSERT INTO tg_second (appt_id, slot, sent, error) VALUES (?, ?, ?, ?) ON CONFLICT(appt_id) DO UPDATE SET slot = excluded.slot, sent = excluded.sent, error = excluded.error'),
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
  function render(data, a, kind = 1) {
    const me = data.me || {}, cfg = me.tg || {};
    const p = (data.patients || []).find(x => x.id === a.patientId) || {};
    const s = (data.studi || []).find(x => x.id === a.studioId) || {};
    const link = a.online ? (a.link || s.link || '') : '';
    const vars = {
      nome: p.nome || '', paziente: [p.nome, p.cognome].filter(Boolean).join(' '),
      giorno: dayLabel(a.date), data: fmtDate(a.date), ora: a.start || '',
      studio: s.nome || '', luogo: a.online ? 'seduta online' : [s.nome, s.indirizzo].filter(Boolean).join(', '),
      professionista: [me.titolo, me.nome, me.cognome].filter(Boolean).join(' '), link, telefono: me.tel || '',
    };
    const tpl = kind === 2 ? (cfg.text2 || DEFAULT_TEXT2) : (cfg.text || DEFAULT_TEXT);
    let t = String(tpl).slice(0, 1000).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    if (link && !/\{link\}/.test(tpl)) t += `\n\nLink per la seduta: ${link}`;
    return t.slice(0, 3500);
  }

  /* ---------- invio di un promemoria ---------- */
  const slotOf = a => a.date + ' ' + a.start;
  function eligible(data, a) {
    const p = (data.patients || []).find(x => x.id === a.patientId);
    if (!p) return { error: 'Paziente non trovato' };
    if (!(p.consensi && p.consensi.telegram)) return { error: 'Manca il consenso del paziente ai promemoria su Telegram' };
    const l = st.link.get(p.id);
    if (!l) return { error: 'Il paziente non ha ancora collegato Telegram' };
    return { p, l };
  }
  // kind 1 = primo promemoria con i pulsanti; kind 2 = secondo promemoria, solo informativo
  async function sendReminder(data, a, manual, kind = 1) {
    const { p, l, error } = eligible(data, a);
    if (error) return { ok: false, error };
    const params = { chat_id: l.chat_id, text: render(data, a, kind), disable_web_page_preview: true };
    if (kind === 1) params.reply_markup = { inline_keyboard: [[{ text: 'Confermo', callback_data: 'c:' + a.id }, { text: 'Devo disdire', callback_data: 'd:' + a.id }]] };
    try {
      const m = await call('sendMessage', params);
      if (kind === 1) st.upsertSent.run(a.id, p.id, l.chat_id, m.message_id, Date.now(), 'inviato', null, slotOf(a));
      else st.upsertSecond.run(a.id, slotOf(a), Date.now(), null);
      log(kind === 2 ? 'promemoria2_inviato' : manual ? 'promemoria_inviato_a_mano' : 'promemoria_inviato', 'telegram', slotOf(a));
      return { ok: true };
    } catch (e) {
      if (e.code === 403) { st.delLinksByChat.run(l.chat_id); log('telegram_bloccato', 'telegram', p.id); }
      if (kind === 1) st.upsertSent.run(a.id, p.id, l.chat_id, null, Date.now(), 'errore', String(e.message).slice(0, 200), slotOf(a));
      else st.upsertSecond.run(a.id, slotOf(a), Date.now(), String(e.message).slice(0, 200));
      log('promemoria_errore', 'telegram', String(e.message).slice(0, 120));
      return { ok: false, error: e.code === 403 ? 'Il paziente ha bloccato il bot: va ricollegato' : 'Telegram ha risposto: ' + e.message };
    }
  }
  // notifica al professionista sul suo Telegram (se l'ha collegato)
  async function notifyOwner(text) {
    const chat = meta('tg_owner_chat'); if (!chat) return;
    try { await call('sendMessage', { chat_id: chat, text }); }
    catch (e) { if (e.code === 403) { st.delMeta.run('tg_owner_chat'); st.delMeta.run('tg_owner_ts'); } console.error('Telegram, notifica:', e.message); }
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
      const H = 3600e3, now = Date.now();
      const h1 = Math.min(72, Math.max(1, Number(cfg.h1) || 25));
      const h2 = cfg.h2 === 0 || cfg.h2 === '0' ? 0 : Math.min(12, Math.max(0.5, Number(cfg.h2) || 1));
      const today = romeNow().date, last = addDay(today, 4);
      for (const a of data.appts || []) {
        if (a.status !== 'prenotato' || !a.date || a.date < today || a.date > last) continue;
        const t = romeEpoch(a.date, a.start), left = t - now;
        if (left <= 0) continue;
        if (eligible(data, a).error) continue;
        const row = st.sent.get(a.id), firstDone = row && row.slot === slotOf(a);
        // primo promemoria: da h1 ore prima, purché manchi ancora almeno mezz'ora al secondo
        if (!firstDone && left <= h1 * H && left > h2 * H + 30 * 60e3) { await sendReminder(data, a, false, 1); await sleep(200); continue; }
        // secondo promemoria: h2 ore prima, se il paziente non ha chiesto di disdire
        if (h2 > 0 && left <= h2 * H && left > 5 * 60e3) {
          const r2 = st.second.get(a.id);
          if (r2 && r2.slot === slotOf(a)) continue;
          if (firstDone && row.status === 'disdetta') continue;
          await sendReminder(data, a, false, 2); await sleep(200);
        }
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
    // il professionista condivide il proprio numero: se coincide con quello del Profilo, riceve qui le notifiche
    if (u.message && u.message.contact && u.message.chat && u.message.chat.type === 'private') {
      const chatId = String(u.message.chat.id), ct = u.message.contact, own = ct.user_id && u.message.from && ct.user_id === u.message.from.id;
      const mine = normTel(data.me && data.me.tel);
      if (own && mine.length >= 6 && normTel(ct.phone_number) === mine) {
        st.setMeta.run('tg_owner_chat', chatId); st.setMeta.run('tg_owner_ts', String(Date.now()));
        log('telegram_notifiche_collegate', 'telegram', 'numero verificato');
        try { await call('sendMessage', { chat_id: chatId, text: 'Numero verificato. In questa chat riceverai le conferme e le disdette dei pazienti.', reply_markup: { remove_keyboard: true } }); } catch {}
        return;
      }
      log('telegram_numero_non_corrisponde', 'telegram', '');
      try { await call('sendMessage', { chat_id: chatId, text: own ? 'Il numero non corrisponde a quello indicato nel Profilo di PsicoLogo: controllalo nei Dati professionali e riprova.' : 'Condividi il tuo numero con il pulsante qui sotto, non quello di un altro contatto.', reply_markup: { remove_keyboard: true } }); } catch {}
      return;
    }
    if (u.message && typeof u.message.text === 'string' && u.message.chat && u.message.chat.type === 'private') {
      const chatId = String(u.message.chat.id), text = u.message.text.trim();
      if (/^\/start\b/.test(text)) {
        const code = text.split(/\s+/)[1] || '';
        if (code === 'pro') {
          if (normTel(data.me && data.me.tel).length < 6) return reply(chatId, 'Prima inserisci il tuo cellulare in PsicoLogo, nel Profilo → Dati professionali, poi riapri questo link.');
          try { await call('sendMessage', { chat_id: chatId, text: 'Per ricevere qui le notifiche di PsicoLogo conferma che sei tu: premi il pulsante qui sotto per condividere il tuo numero.', reply_markup: { keyboard: [[{ text: 'Condividi il mio numero', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true } }); } catch (e) { console.error('Telegram:', e.message); }
          return;
        }
        const c = code && st.code.get(code);
        if (!c || c.expires < Date.now()) return reply(chatId, code ? 'Questo link non è valido o è scaduto: chiedi allo studio un nuovo link.' : `Questo è il servizio di promemoria di ${pro}. Per attivarlo usa il link personale che ti ha dato lo studio.`);
        st.delCodesFor.run(c.patient_id);
        if (c.patient_id === OWNER) {
          st.setMeta.run('tg_owner_chat', chatId); st.setMeta.run('tg_owner_ts', String(Date.now()));
          log('telegram_notifiche_collegate', 'telegram', '');
          return reply(chatId, 'Fatto: in questa chat riceverai le conferme e le disdette dei pazienti.');
        }
        st.setLink.run(c.patient_id, chatId, Date.now());
        log('telegram_collegato', 'telegram', c.patient_id);
        return reply(chatId, `Collegamento riuscito. Riceverai qui i promemoria degli appuntamenti con ${pro}, con i pulsanti per confermare o avvisare se devi disdire.\n\nPer non riceverli più scrivi /stop.`);
      }
      if (/^\/stop\b/.test(text)) {
        if (meta('tg_owner_chat') === chatId) { st.delMeta.run('tg_owner_chat'); st.delMeta.run('tg_owner_ts'); }
        const who = st.links.all().filter(l => l.chat_id === chatId).map(l => ((data.patients || []).find(p => p.id === l.patient_id) || {}));
        st.delLinksByChat.run(chatId);
        log('telegram_scollegato_dal_paziente', 'telegram', '');
        if (who.length) notifyOwner(`${who.map(p => [p.nome, p.cognome].filter(Boolean).join(' ')).join(', ')} ha disattivato i promemoria su Telegram.`);
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
      const appt = (data.appts || []).find(a => a.id === apptId);
      const msgId = cq.message && cq.message.message_id;
      if (!appt || (row.slot && row.slot !== slotOf(appt)) || (row.message_id && msgId !== row.message_id)) {
        try { await call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Questo promemoria non è più valido: usa quello più recente.' }); } catch {}
        try { await call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }); } catch {}
        return;
      }
      const status = kind === 'c' ? 'confermato' : 'disdetta';
      st.answer.run(status, Date.now(), apptId);
      log(kind === 'c' ? 'promemoria_confermato' : 'promemoria_disdetta', 'telegram', apptId);
      {
        const p = (data.patients || []).find(x => x.id === appt.patientId) || {}, s2 = (data.studi || []).find(x => x.id === appt.studioId) || {};
        const quando = `${dayLabel(appt.date)} alle ${appt.start}${appt.online ? ' (online)' : s2.nome ? ' – ' + s2.nome : ''}`;
        notifyOwner(kind === 'c' ? `Confermato: ${[p.nome, p.cognome].filter(Boolean).join(' ')}, ${quando}.` : `Disdetta richiesta: ${[p.nome, p.cognome].filter(Boolean).join(' ')}, ${quando}.\nRicordati di segnarlo nell’agenda di PsicoLogo.`);
      }
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
      const sent = {}; for (const r of st.sentRecent.all(Date.now() - 60 * 864e5)) sent[r.appt_id] = { status: r.status, sent: r.sent, answered: r.answered, error: r.error, slot: r.slot, second: r.second };
      const ot = meta('tg_owner_ts');
      send(res, 200, { configured: !!getToken(), bot, running, links, sent, owner: ot ? Number(ot) : null, defaultText: DEFAULT_TEXT, defaultText2: DEFAULT_TEXT2 }); return true;
    }
    if (url === '/api/telegram/token' && method === 'POST') {
      const b = await readJson(req); const token = String(b.token || '').trim();
      if (!TOKEN_RE.test(token)) { send(res, 400, { error: 'La chiave non sembra quella di un bot: è una riga come 123456789:AAH… che ti dà @BotFather.' }); return true; }
      let me;
      try { me = await call('getMe', {}, token); } catch (e) { send(res, 400, { error: e.code === 401 || e.code === 404 ? 'Telegram non riconosce questa chiave: controlla di averla copiata tutta.' : 'Non riesco a contattare Telegram: ' + e.message }); return true; }
      try { await call('deleteWebhook', {}, token); } catch {}
      stop();
      if (bot && bot !== me.username) { db.exec('DELETE FROM tg_links; DELETE FROM tg_codes;'); st.delMeta.run('tg_owner_chat'); st.delMeta.run('tg_owner_ts'); }
      st.setMeta.run('tg_token', encrypt(token)); st.setMeta.run('tg_bot', me.username); st.delMeta.run('tg_offset');
      log('telegram_configurato', ip, '@' + me.username);
      start();
      send(res, 200, { ok: true, bot: me.username }); return true;
    }
    if (url === '/api/telegram/token' && method === 'DELETE') {
      stop();
      for (const k of ['tg_token', 'tg_bot', 'tg_offset', 'tg_owner_chat', 'tg_owner_ts']) st.delMeta.run(k);
      db.exec('DELETE FROM tg_links; DELETE FROM tg_codes;');
      log('telegram_rimosso', ip, bot ? '@' + bot : '');
      send(res, 200, { ok: true }); return true;
    }
    if (url === '/api/telegram/link' && method === 'POST') {
      if (!getToken() || !bot) { send(res, 400, { error: 'Prima collega il bot nel Profilo.' }); return true; }
      const b = await readJson(req); const pid = String(b.patientId || '');
      const data = readDoc() || {};
      if (pid !== OWNER && !(data.patients || []).some(p => p.id === pid)) { send(res, 404, { error: 'Paziente non trovato.' }); return true; }
      st.delCodesFor.run(pid);
      const code = crypto.randomBytes(12).toString('base64url');
      const expires = Date.now() + CODE_DAYS * 864e5;
      st.addCode.run(code, pid, expires);
      send(res, 200, { url: `https://t.me/${bot}?start=${code}`, expires, bot }); return true;
    }
    const m = /^\/api\/telegram\/link\/([\w-]{1,40})$/.exec(url);
    if (url === '/api/telegram/owner' && method === 'DELETE') { st.delMeta.run('tg_owner_chat'); st.delMeta.run('tg_owner_ts'); st.delCodesFor.run(OWNER); log('telegram_notifiche_scollegate', ip, ''); send(res, 200, { ok: true }); return true; }
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
    api, start, stop, tick, tables: ['tg_links', 'tg_codes', 'tg_sent', 'tg_second'],
    _test: { render, romeNow, addDay, dayLabel, romeEpoch },
  };
};
module.exports.DEFAULT_TEXT = DEFAULT_TEXT;
module.exports.DEFAULT_TEXT2 = DEFAULT_TEXT2;
