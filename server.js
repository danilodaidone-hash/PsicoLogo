// PsicoLogo – server di prova
// Nessuna dipendenza esterna: usa solo i moduli integrati di Node.js 22+.
//   node:http     server web
//   node:sqlite   database (file unico in DATA_DIR)
//   node:crypto   password (scrypt), sessioni, cifratura dei dati (AES-256-GCM)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');
const { invoicePdf } = require('./pdf.js');
const APP_VERSION = '1.1.0';
const LICENSE_VERSION = '1.0';

/* ---------------- configurazione ---------------- */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETUP_CODE = (process.env.SETUP_CODE || '').trim();
// Solo per i server dimostrativi: abilita il pulsante "Azzera demo". Mai su un server con dati reali.
const DEMO_MODE = /^(1|true|si|sì|yes)$/i.test(String(process.env.DEMO_MODE || '').trim());
const MAX_BODY = 8 * 1024 * 1024;           // 8 MB
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 ore di inattività
const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 12 ore al massimo
const LOCK_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const BACKUP_KEEP = 14;

fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

// Chiave di cifratura: va passata da fuori (file .env creato dall'installazione).
let KEY;
if (process.env.DATA_KEY) {
  KEY = Buffer.from(process.env.DATA_KEY, 'base64');
} else {
  const kf = path.join(DATA_DIR, 'dev.key');
  if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  KEY = Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'base64');
  console.warn('[attenzione] DATA_KEY non impostata: uso una chiave di sviluppo salvata accanto ai dati.');
}
if (KEY.length !== 32) { console.error('DATA_KEY deve essere di 32 byte in base64'); process.exit(1); }
if (!SETUP_CODE) console.warn('[attenzione] SETUP_CODE non impostato: la prima configurazione è disattivata.');

/* ---------------- database ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'psicologo.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, pw_hash TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS doc (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, enc TEXT NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL, ip TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, fails INTEGER NOT NULL, until INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, enc BLOB NOT NULL);
  CREATE INDEX IF NOT EXISTS files_patient ON files (patient_id);
`);
// Aggiornamento dello schema per i database creati con versioni precedenti
if (!db.prepare('PRAGMA table_info(files)').all().some(c => c.name === 'category')) {
  db.exec("ALTER TABLE files ADD COLUMN category TEXT NOT NULL DEFAULT ''");
}
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
if (!db.prepare('PRAGMA table_info(account)').all().some(c => c.name === 'recovery_hash')) {
  db.exec('ALTER TABLE account ADD COLUMN recovery_hash TEXT');
}
const q = {
  account: db.prepare('SELECT * FROM account WHERE id = 1'),
  insAccount: db.prepare('INSERT INTO account (id, username, pw_hash, created) VALUES (1, ?, ?, ?)'),
  setPw: db.prepare('UPDATE account SET pw_hash = ? WHERE id = 1'),
  setRecovery: db.prepare('UPDATE account SET recovery_hash = ? WHERE id = 1'),
  delAllSessions: db.prepare('DELETE FROM sessions'),
  doc: db.prepare('SELECT * FROM doc WHERE id = 1'),
  upsertDoc: db.prepare('INSERT INTO doc (id, version, enc, updated) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, enc = excluded.enc, updated = excluded.updated'),
  insSession: db.prepare('INSERT INTO sessions (hash, created, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?)'),
  session: db.prepare('SELECT * FROM sessions WHERE hash = ?'),
  touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE hash = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE hash = ?'),
  delOtherSessions: db.prepare('DELETE FROM sessions WHERE hash != ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created < ?'),
  audit: db.prepare('INSERT INTO audit (ts, event, ip, detail) VALUES (?, ?, ?, ?)'),
  auditList: db.prepare('SELECT ts, event, ip, detail FROM audit ORDER BY id DESC LIMIT 60'),
  lock: db.prepare('SELECT * FROM locks WHERE key = ?'),
  setLock: db.prepare('INSERT INTO locks (key, fails, until) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, until = excluded.until'),
  delLock: db.prepare('DELETE FROM locks WHERE key = ?'),
  insFile: db.prepare('INSERT INTO files (id, patient_id, category, name, mime, size, created, enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  listFiles: db.prepare('SELECT id, category, name, mime, size, created FROM files WHERE patient_id = ? ORDER BY created DESC'),
  file: db.prepare('SELECT * FROM files WHERE id = ?'),
  delFile: db.prepare('DELETE FROM files WHERE id = ?'),
  allFiles: db.prepare('SELECT * FROM files'),
  delAllFiles: db.prepare('DELETE FROM files'),
  insFileFull: db.prepare('INSERT INTO files (id, patient_id, category, name, mime, size, created, enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
const log = (event, ip, detail = '') => q.audit.run(Date.now(), event, ip || '', String(detail).slice(0, 200));

/* ---------------- sicurezza ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, N, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: Number(N), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const ref = Buffer.from(hash, 'base64');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
// Documenti allegati: cifrati come i dati, conservati nel database (quindi inclusi nei backup)
function encryptBuf(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function decryptBuf(raw) {
  const buf = Buffer.from(raw);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
const MAX_FILE = 10 * 1024 * 1024; // 10 MB per documento
// Categorie: '' = documenti della cartella; le altre = moduli di consenso firmati
const FILE_CATEGORIES = new Set(['', 'informato', 'privacy', 'entrambi', 'online', 'ts']);
// Solo questi formati; il tipo viene deciso dall'estensione, non da quanto dichiara il browser.
const FILE_TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text', txt: 'text/plain; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const INLINE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(Object.assign(new Error('Il documento supera i 10 MB.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
// Codice di recupero: 16 caratteri (circa 80 bit), senza lettere ambigue (0/O, 1/I/L)
const REC_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const b = crypto.randomBytes(16);
  const raw = Array.from(b, x => REC_ALPHA[x % REC_ALPHA.length]).join('');
  q.setRecovery.run(hashPassword(raw));
  return raw.match(/.{4}/g).join('-');
}
// ---- Backup completo da scaricare: dati + documenti, cifrato con una password scelta da chi lo scarica.
// Formato: 'PLBK1' + sale(16) + iv(12) + tag(16) + AES-256-GCM( gzip( JSON ) )
const BK_MAGIC = Buffer.from('PLBK1');
const MAX_BACKUP = 300 * 1024 * 1024;
const backupKey = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function buildBackup(pass) {
  const d = q.doc.get();
  const payload = { app: 'PsicoLogo', format: 1, created: new Date().toISOString(), version: d.version, data: decrypt(d.enc),
    files: q.allFiles.all().map(f => ({ id: f.id, patient_id: f.patient_id, category: f.category, name: f.name, mime: f.mime, size: f.size, created: f.created, content: decryptBuf(f.enc).toString('base64') })) };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', backupKey(pass, salt), iv);
  const body = Buffer.concat([c.update(gz), c.final()]);
  return { buf: Buffer.concat([BK_MAGIC, salt, iv, c.getAuthTag(), body]), files: payload.files.length };
}
function readBackup(buf, pass) {
  if (buf.length < 50 || !buf.subarray(0, 5).equals(BK_MAGIC)) throw Object.assign(new Error('Questo file non è un backup di PsicoLogo.'), { status: 400 });
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49);
  let gz;
  try { const d = crypto.createDecipheriv('aes-256-gcm', backupKey(pass, salt), iv); d.setAuthTag(tag); gz = Buffer.concat([d.update(buf.subarray(49)), d.final()]); }
  catch { throw Object.assign(new Error('Password del backup errata, oppure file danneggiato.'), { status: 400 }); }
  const p = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  if (p.app !== 'PsicoLogo' || !p.data || typeof p.data !== 'object' || !Array.isArray(p.files)) throw Object.assign(new Error('Il contenuto del backup non è valido.'), { status: 400 });
  return p;
}
const normRecovery = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function isLocked(key) { const l = q.lock.get(key); return l && l.until > Date.now() ? l.until : 0; }
function fail(key) {
  const l = q.lock.get(key); const fails = (l && l.until > Date.now() - LOCK_MS ? l.fails : 0) + 1;
  q.setLock.run(key, fails, fails >= LOCK_FAILS ? Date.now() + LOCK_MS : Date.now());
}

/* ---------------- utilità HTTP ---------------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function clientIp(req) {
  // L'app ascolta solo dietro il proxy Caddy: ci fidiamo del primo indirizzo inoltrato.
  const xf = req.headers['x-forwarded-for'];
  return (xf ? xf.split(',')[0] : req.socket.remoteAddress || '').trim();
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('troppo grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('JSON non valido'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function sessionCookie(req, token, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === 'true';
  return `pl_sess=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
function newSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  q.insSession.run(sha(token), now, now, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 160));
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_MAX_MS / 1000));
  return token;
}
function currentSession(req) {
  const t = cookies(req).pl_sess; if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const s = q.session.get(sha(t)); const now = Date.now();
  if (!s) return null;
  if (now - s.last_seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) { q.delSession.run(s.hash); return null; }
  q.touchSession.run(now, s.hash);
  return s;
}
const validUser = u => /^[a-z0-9._-]{3,40}$/.test(u);
const validPw = p => typeof p === 'string' && p.length >= 10 && p.length <= 200;

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const ip = clientIp(req);
  const method = req.method;
  // Protezione CSRF: ogni richiesta che modifica deve arrivare dalla nostra pagina.
  if (method !== 'GET' && req.headers['x-psicologo'] !== '1') return send(res, 403, { error: 'Richiesta non consentita' });

  if (url === '/api/status' && method === 'GET') {
    const s = currentSession(req);
    const lv = q.getMeta.get('logo_ver'), la = q.getMeta.get('license_accepted');
    return send(res, 200, { configured: !!q.account.get(), setupEnabled: !!SETUP_CODE, demo: DEMO_MODE, logged: !!s, version: APP_VERSION, licenseVersion: LICENSE_VERSION,
      logo: lv ? lv.value : null, licenseAccepted: !!(la && JSON.parse(la.value).v === LICENSE_VERSION), licenseAcceptedAt: la ? JSON.parse(la.value).ts : null });
  }
  if (url === '/api/license' && method === 'GET') {
    let t = ''; try { t = fs.readFileSync(path.join(__dirname, 'LICENSE'), 'utf8'); } catch { t = 'Testo della licenza non disponibile.'; }
    return send(res, 200, t, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (url === '/api/logo.png' && method === 'GET') {
    const l = q.getMeta.get('logo_png');
    if (!l) return send(res, 404, { error: 'Nessun logo' });
    return send(res, 200, Buffer.from(l.value, 'base64'), { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  }

  if (url === '/api/setup' && method === 'POST') {
    if (q.account.get()) return send(res, 409, { error: 'PsicoLogo è già configurato su questo server.' });
    if (!SETUP_CODE) return send(res, 403, { error: 'Configurazione disattivata: manca il codice di installazione sul server.' });
    const lk = isLocked('setup:' + ip); if (lk) return send(res, 429, { error: 'Troppi tentativi. Riprova tra qualche minuto.' });
    const b = await readJson(req);
    if (!safeEq(String(b.code || '').trim(), SETUP_CODE)) { fail('setup:' + ip); log('setup_codice_errato', ip); return send(res, 403, { error: 'Codice di installazione non corretto.' }); }
    const u = String(b.username || '').trim().toLowerCase();
    if (!validUser(u)) return send(res, 400, { error: 'Nome utente: da 3 a 40 caratteri, solo lettere minuscole, numeri e . _ -' });
    if (!validPw(b.password)) return send(res, 400, { error: 'La password deve avere almeno 10 caratteri.' });
    if (!b.data || typeof b.data !== 'object') return send(res, 400, { error: 'Dati iniziali mancanti.' });
    if (b.acceptLicense !== true) return send(res, 400, { error: 'Per continuare devi accettare le condizioni di licenza d’uso.' });
    q.insAccount.run(u, hashPassword(b.password), Date.now());
    q.upsertDoc.run(1, encrypt(b.data), Date.now());
    log('configurazione', ip, u);
    q.setMeta.run('license_accepted', JSON.stringify({ v: LICENSE_VERSION, ts: Date.now() }));
    log('licenza_accettata', ip, 'versione ' + LICENSE_VERSION);
    newSession(req, res);
    return send(res, 200, { ok: true, version: 1, recoveryCode: newRecoveryCode() });
  }

  if (url === '/api/login' && method === 'POST') {
    const b = await readJson(req);
    const u = String(b.username || '').trim().toLowerCase();
    const acc = q.account.get();
    const lk = Math.max(isLocked('u:' + u), isLocked('ip:' + ip));
    if (lk) { log('accesso_bloccato', ip, u); return send(res, 429, { error: `Troppi tentativi sbagliati. Accesso bloccato fino alle ${new Date(lk).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}.` }); }
    // Verifichiamo sempre una password, anche se l'utente non esiste, per non rivelarlo dai tempi di risposta.
    const ok = acc && acc.username === u ? verifyPassword(String(b.password || ''), acc.pw_hash) : (verifyPassword('x', hashPassword('y')), false);
    if (!ok) { fail('u:' + u); fail('ip:' + ip); log('accesso_fallito', ip, u); return send(res, 401, { error: 'Nome utente o password non corretti.' }); }
    q.delLock.run('u:' + u); q.delLock.run('ip:' + ip);
    newSession(req, res);
    log('accesso', ip, String(req.headers['user-agent'] || '').slice(0, 80));
    return send(res, 200, { ok: true });
  }

  if (url === '/api/recovery/use' && method === 'POST') {
    const b = await readJson(req);
    const u = String(b.username || '').trim().toLowerCase();
    const lk = Math.max(isLocked('rec:' + u), isLocked('ip:' + ip));
    if (lk) { log('recupero_bloccato', ip, u); return send(res, 429, { error: `Troppi tentativi. Riprova dopo le ${new Date(lk).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}.` }); }
    const acc = q.account.get();
    const code = normRecovery(b.code);
    const ok = acc && acc.username === u && acc.recovery_hash && code.length === 16 && verifyPassword(code, acc.recovery_hash);
    if (!ok) { fail('rec:' + u); fail('ip:' + ip); log('recupero_fallito', ip, u); return send(res, 401, { error: 'Nome utente o codice di recupero non corretti.' }); }
    if (!validPw(b.password)) return send(res, 400, { error: 'La nuova password deve avere almeno 10 caratteri.' });
    q.setPw.run(hashPassword(b.password));
    q.delAllSessions.run();
    q.delLock.run('rec:' + u); q.delLock.run('u:' + u); q.delLock.run('ip:' + ip);
    const recoveryCode = newRecoveryCode(); // il codice usato non vale più
    log('password_recuperata', ip, u);
    newSession(req, res);
    return send(res, 200, { ok: true, recoveryCode });
  }

  const s = currentSession(req);
  if (!s) return send(res, 401, { error: 'Sessione scaduta: accedi di nuovo.' });

  if (url === '/api/logout' && method === 'POST') {
    q.delSession.run(s.hash); log('uscita', ip);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return send(res, 200, { ok: true });
  }
  if (url === '/api/data' && method === 'GET') {
    const d = q.doc.get();
    const acc = q.account.get();
    const lb = q.getMeta.get('last_backup');
    return send(res, 200, { version: d.version, data: decrypt(d.enc), username: acc.username, hasRecovery: !!acc.recovery_hash, lastBackup: lb ? Number(lb.value) : null });
  }
  if (url === '/api/data' && method === 'PUT') {
    const b = await readJson(req);
    const d = q.doc.get();
    if (Number(b.version) !== d.version) return send(res, 409, { error: 'I dati sono stati modificati da un altro dispositivo.', version: d.version, data: decrypt(d.enc) });
    if (!b.data || typeof b.data !== 'object') return send(res, 400, { error: 'Dati mancanti.' });
    const v = d.version + 1;
    q.upsertDoc.run(v, encrypt(b.data), Date.now());
    return send(res, 200, { ok: true, version: v });
  }
  if (url === '/api/demo/reset' && method === 'POST') {
    if (!DEMO_MODE) return send(res, 403, { error: 'Funzione disponibile solo sui server dimostrativi.' });
    const b = await readJson(req);
    if (!verifyPassword(String(b.password || ''), q.account.get().pw_hash)) { log('azzeramento_rifiutato', ip); return send(res, 400, { error: 'La password non è corretta.' }); }
    // nessuna copia: si cancellano anche i backup presenti sul server
    const bdir = path.join(DATA_DIR, 'backups');
    try { for (const f of fs.readdirSync(bdir)) fs.rmSync(path.join(bdir, f), { force: true }); } catch {}
    db.exec('PRAGMA secure_delete = ON');
    db.exec('BEGIN');
    try {
      for (const t of ['account', 'doc', 'sessions', 'files', 'meta', 'audit', 'locks']) db.exec(`DELETE FROM ${t}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    log('demo_azzerata', ip);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return send(res, 200, { ok: true });
  }
  if (url === '/api/password' && method === 'POST') {
    const b = await readJson(req);
    const acc = q.account.get();
    if (!verifyPassword(String(b.current || ''), acc.pw_hash)) { log('cambio_password_fallito', ip); return send(res, 400, { error: 'La password attuale non è corretta.' }); }
    if (!validPw(b.next)) return send(res, 400, { error: 'La nuova password deve avere almeno 10 caratteri.' });
    q.setPw.run(hashPassword(b.next));
    q.delOtherSessions.run(s.hash);
    log('cambio_password', ip);
    return send(res, 200, { ok: true });
  }
  if (url === '/api/recovery/new' && method === 'POST') {
    const b = await readJson(req);
    if (!verifyPassword(String(b.password || ''), q.account.get().pw_hash)) { log('recupero_nuovo_fallito', ip); return send(res, 400, { error: 'La password non è corretta.' }); }
    const recoveryCode = newRecoveryCode();
    log('recupero_codice_creato', ip);
    return send(res, 200, { ok: true, recoveryCode });
  }
  // ---- fattura in PDF
  const im = url.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,40})\.pdf$/);
  if (im && method === 'GET') {
    const data = decrypt(q.doc.get().enc);
    const inv = (data.invoices || []).find(i => i.id === im[1]);
    if (!inv) return send(res, 404, { error: 'Fattura non trovata.' });
    const lj = q.getMeta.get('logo_jpg');
    const pdf = invoicePdf(data, inv, lj ? Buffer.from(lj.value, 'base64') : null);
    const p = (data.patients || []).find(x => x.id === inv.patientId) || {};
    const fname = `Fattura-${String(inv.num).replace('/', '-')}-${String(p.cognome || '').replace(/[^A-Za-z0-9]/g, '')}.pdf`;
    const download = new URL(req.url, 'http://x').searchParams.has('download');
    log('fattura_pdf', ip, inv.num);
    return send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fname}"`, 'Content-Security-Policy': "default-src 'none'" });
  }
  // ---- logo personalizzato (PNG per l'app, JPEG per i PDF)
  if (url === '/api/logo' && method === 'POST') {
    const b = await readJson(req);
    const dec = (u, prefix) => typeof u === 'string' && u.startsWith(prefix) ? Buffer.from(u.slice(prefix.length), 'base64') : null;
    const png = dec(b.png, 'data:image/png;base64,'), jpg = dec(b.jpg, 'data:image/jpeg;base64,');
    if (!png || !jpg || png.length > 1500000 || jpg.length > 1500000) return send(res, 400, { error: 'Immagine non valida o troppo grande.' });
    if (png.readUInt32BE(0) !== 0x89504E47 || jpg[0] !== 0xFF || jpg[1] !== 0xD8) return send(res, 400, { error: 'Formato dell’immagine non valido.' });
    const ver = String(Date.now());
    q.setMeta.run('logo_png', png.toString('base64')); q.setMeta.run('logo_jpg', jpg.toString('base64')); q.setMeta.run('logo_ver', ver);
    log('logo_cambiato', ip);
    return send(res, 200, { ok: true, logo: ver });
  }
  if (url === '/api/logo' && method === 'DELETE') {
    db.exec("DELETE FROM meta WHERE key IN ('logo_png','logo_jpg','logo_ver')");
    log('logo_rimosso', ip);
    return send(res, 200, { ok: true });
  }
  if (url === '/api/license/accept' && method === 'POST') {
    q.setMeta.run('license_accepted', JSON.stringify({ v: LICENSE_VERSION, ts: Date.now() }));
    log('licenza_accettata', ip, 'versione ' + LICENSE_VERSION);
    return send(res, 200, { ok: true });
  }
  if (url === '/api/backup/download' && method === 'POST') {
    const b = await readJson(req);
    if (!validPw(b.password)) return send(res, 400, { error: 'La password del backup deve avere almeno 10 caratteri.' });
    const { buf, files } = buildBackup(b.password);
    const now = Date.now();
    q.setMeta.run('last_backup', String(now));
    log('backup_scaricato', ip, `${files} documenti, ${Math.round(buf.length / 1024)} KB`);
    return send(res, 200, buf, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="psicologo-backup-${new Date(now).toISOString().slice(0, 10)}.plbk"`, 'X-Last-Backup': String(now) });
  }
  if (url === '/api/backup/restore' && method === 'POST') {
    let pass = '', accPw = '';
    try { pass = decodeURIComponent(String(req.headers['x-backup-password'] || '')); accPw = decodeURIComponent(String(req.headers['x-account-password'] || '')); } catch {}
    if (!verifyPassword(accPw, q.account.get().pw_hash)) { log('ripristino_rifiutato', ip, 'password account errata'); return send(res, 400, { error: 'La password del tuo account non è corretta.' }); }
    const buf = await readRaw(req, MAX_BACKUP);
    const p = readBackup(buf, pass);
    // copia di sicurezza dello stato attuale, prima di sostituirlo
    const safety = path.join(DATA_DIR, 'backups', `prima-del-ripristino-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${safety.replace(/'/g, "''")}'`);
    const d = q.doc.get();
    db.exec('BEGIN');
    try {
      q.upsertDoc.run(d.version + 1, encrypt(p.data), Date.now());
      q.delAllFiles.run();
      for (const f of p.files) {
        const content = Buffer.from(String(f.content || ''), 'base64');
        q.insFileFull.run(String(f.id), String(f.patient_id), FILE_CATEGORIES.has(f.category) ? f.category : '', String(f.name).slice(0, 150), String(f.mime), content.length, Number(f.created) || Date.now(), encryptBuf(content));
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log('backup_ripristinato', ip, `backup del ${String(p.created).slice(0, 10)}, ${p.files.length} documenti`);
    return send(res, 200, { ok: true, created: p.created, files: p.files.length });
  }
  if (url === '/api/log' && method === 'GET') {
    return send(res, 200, { events: q.auditList.all() });
  }
  if (url === '/api/export' && method === 'GET') {
    const d = q.doc.get(); log('esportazione', ip);
    const name = `psicologo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return send(res, 200, JSON.stringify({ exported: new Date().toISOString(), version: d.version, data: decrypt(d.enc) }, null, 2),
      { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  }
  // ---- documenti allegati alla cartella ----
  if (url === '/api/files' && method === 'GET') {
    const pid = new URL(req.url, 'http://x').searchParams.get('patient') || '';
    return send(res, 200, { files: q.listFiles.all(pid) });
  }
  if (url === '/api/files' && method === 'POST') {
    const pid = String(req.headers['x-patient-id'] || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(pid)) return send(res, 400, { error: 'Paziente non valido.' });
    const category = String(req.headers['x-category'] || '');
    if (!FILE_CATEGORIES.has(category)) return send(res, 400, { error: 'Categoria del documento non valida.' });
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { name = ''; }
    name = name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 150);
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = FILE_TYPES[ext];
    if (!name || !mime) return send(res, 400, { error: 'Formato non ammesso. Usa PDF, immagini (JPG, PNG, HEIC), Word, ODT, TXT o Excel.' });
    const buf = await readRaw(req, MAX_FILE);
    if (!buf.length) return send(res, 400, { error: 'Il file è vuoto.' });
    const id = crypto.randomBytes(12).toString('hex');
    q.insFile.run(id, pid, category, name, mime, buf.length, Date.now(), encryptBuf(buf));
    log(category ? 'consenso_caricato' : 'documento_caricato', ip, name);
    return send(res, 200, { ok: true, id });
  }
  const fm = url.match(/^\/api\/files\/([a-f0-9]{24})$/);
  if (fm && method === 'GET') {
    const f = q.file.get(fm[1]);
    if (!f) return send(res, 404, { error: 'Documento non trovato.' });
    const download = new URL(req.url, 'http://x').searchParams.has('download') || !INLINE_TYPES.has(f.mime);
    log(download ? 'documento_scaricato' : 'documento_aperto', ip, f.name);
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    return send(res, 200, decryptBuf(f.enc), {
      'Content-Type': f.mime,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
  }
  if (fm && method === 'DELETE') {
    const f = q.file.get(fm[1]);
    if (!f) return send(res, 404, { error: 'Documento non trovato.' });
    q.delFile.run(f.id); log('documento_eliminato', ip, f.name);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Non trovato' });
}

/* ---------------- file statici ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.split('?')[0]);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Vietato', { 'Content-Type': 'text/plain' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Non trovato', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

/* ---------------- backup giornaliero ---------------- */
function backup() {
  if (DEMO_MODE) return; // server dimostrativo: nessuna copia dei dati di prova
  try {
    const dir = path.join(DATA_DIR, 'backups');
    const file = path.join(dir, `psicologo-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      console.log('Backup creato:', path.basename(file));
    }
    fs.readdirSync(dir).filter(f => /^psicologo-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -BACKUP_KEEP)
      .forEach(f => fs.unlinkSync(path.join(dir, f)));
    q.purgeSessions.run(Date.now() - SESSION_IDLE_MS, Date.now() - SESSION_MAX_MS);
  } catch (e) { console.error('Backup non riuscito:', e.message); }
}
backup();
setInterval(backup, 60 * 60 * 1000); // controlla ogni ora, ne crea al massimo uno al giorno

/* ---------------- avvio ---------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    if (url.startsWith('/api/')) return await api(req, res, url.split('?')[0]);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Metodo non consentito', { 'Content-Type': 'text/plain' });
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Errore interno del server' });
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, HOST, () => console.log(`PsicoLogo in ascolto su http://${HOST}:${PORT}`));
process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0); });
