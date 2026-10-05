// PsicoLogo – reimpostazione della password dal server (procedura di emergenza)
// Uso, sul server:  sudo docker compose -f /opt/psicologo/docker-compose.yml exec app node scripts/reset-password.js
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'psicologo.db'));
const acc = db.prepare('SELECT username FROM account WHERE id = 1').get();
if (!acc) { console.log('PsicoLogo non è ancora configurato: non c\'è nessun account.'); process.exit(1); }
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const pw = Array.from(crypto.randomBytes(14), x => ALPHA[x % ALPHA.length]).join('');
const salt = crypto.randomBytes(16);
const h = crypto.scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
db.prepare('UPDATE account SET pw_hash = ? WHERE id = 1').run(`scrypt$32768$${salt.toString('base64')}$${h.toString('base64')}`);
db.prepare('DELETE FROM sessions').run();
db.prepare('DELETE FROM locks').run();
db.prepare('INSERT INTO audit (ts, event, ip, detail) VALUES (?, ?, ?, ?)').run(Date.now(), 'password_reimpostata_server', 'server', acc.username);
console.log('');
console.log('  Password reimpostata per l\'utente: ' + acc.username);
console.log('  Password temporanea:               ' + pw);
console.log('');
console.log('  Accedi con questa password e cambiala subito dal Profilo.');
console.log('');
