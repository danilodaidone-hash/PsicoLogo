// Scarica l'elenco dei comuni italiani con provincia, CAP e codice catastale (per il codice fiscale) e lo salva in forma compatta
// in public/comuni.json. Fonte: dati aperti ISTAT raccolti in github.com/matteocontrini/comuni-json.
// Se il download non riesce, l'app funziona lo stesso: CAP e provincia si scrivono a mano.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, '..', 'public', 'comuni.json');
const URLS = [
  'https://cdn.jsdelivr.net/gh/matteocontrini/comuni-json@master/comuni.json',
  'https://raw.githubusercontent.com/matteocontrini/comuni-json/master/comuni.json',
];

// Accetta sia il formato del progetto (cap come elenco) sia varianti con campi diversi.
function compact(list) {
  const out = [];
  for (const c of list) {
    const nome = String(c.nome || c.denominazione || '').trim();
    const sigla = String(c.sigla || (c.provincia && c.provincia.sigla) || c.siglaProvincia || '').trim().toUpperCase();
    let cap = c.cap ?? c.caps ?? [];
    if (!Array.isArray(cap)) cap = String(cap).split(/[\s,;]+/);
    cap = [...new Set(cap.map(x => String(x).trim()).filter(x => /^\d{5}$/.test(x)))].sort();
    const cat = String(c.codiceCatastale || c.codice_catastale || c.belfiore || '').trim().toUpperCase();
    if (nome && /^[A-Z]{2}$/.test(sigla)) out.push([nome, sigla, cap.join(' '), /^[A-Z]\d{3}$/.test(cat) ? cat : '']);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0], 'it'));
}

async function main() {
  for (const url of URLS) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = compact(await r.json());
      if (rows.length < 7000) throw new Error('elenco incompleto (' + rows.length + ' comuni)');
      fs.writeFileSync(OUT, JSON.stringify({ v: 1, c: rows }));
      console.log('elenco dei comuni scaricato:', rows.length, 'comuni');
      return;
    } catch (e) { console.log('elenco dei comuni non scaricato da', url, '-', e.message); }
  }
  console.log('CAP e provincia automatici non disponibili: si inseriscono a mano.');
}
if (require.main === module) main();

module.exports = { compact };
