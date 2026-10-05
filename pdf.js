// PsicoLogo – generatore PDF minimale (A4), senza librerie esterne.
// Usa i caratteri standard del PDF (Helvetica, Courier) con codifica WinAnsi: niente file di font da allegare.
'use strict';
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
function str(t) {
  let out = '';
  for (const ch of String(t ?? '')) {
    let c = WIN[ch] ?? ch.codePointAt(0);
    if (c > 255) c = 63; // '?'
    const b = String.fromCharCode(c);
    out += (b === '(' || b === ')' || b === '\\') ? '\\' + b : b;
  }
  return '(' + out + ')';
}
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
// Pagina A4: 595 x 842 punti
class Page {
  constructor() { this.ops = []; }
  text(x, y, t, { size = 10, font = 'F1', gray = 0 } = {}) { this.ops.push(`BT ${gray} g /${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td ${str(t)} Tj ET`); }
  // testo allineato a destra in Courier (larghezza fissa 0,6 em)
  right(xr, y, t, { size = 10, font = 'F3', gray = 0 } = {}) { this.text(xr - String(t).length * size * 0.6, y, t, { size, font, gray }); }
  line(x1, y1, x2, y2, w = 0.6, gray = 0.75) { this.ops.push(`${gray} G ${w} w ${x1} ${y1} m ${x2} ${y2} l S`); }
  rect(x, y, w, h, gray = 0.95) { this.ops.push(`${gray} g ${x} ${y} ${w} ${h} re f 0 g`); }
  image(name, x, y, w, h) { this.ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)} cm /${name} Do Q`); }
  // va a capo stimando la larghezza media dei caratteri Helvetica (circa 0,5 em)
  wrap(x, y, t, maxW, { size = 10, font = 'F1', gray = 0, lead = 1.35 } = {}) {
    const max = Math.max(10, Math.floor(maxW / (size * 0.5)));
    const words = String(t ?? '').split(/\s+/); let lineTxt = ''; let yy = y;
    for (const w of words) {
      if ((lineTxt + ' ' + w).trim().length > max) { this.text(x, yy, lineTxt, { size, font, gray }); yy -= size * lead; lineTxt = w; }
      else lineTxt = (lineTxt + ' ' + w).trim();
    }
    if (lineTxt) { this.text(x, yy, lineTxt, { size, font, gray }); yy -= size * lead; }
    return yy;
  }
}
function build(pages, image) {
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const f4 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  let img = 0;
  if (image) img = add({ head: `<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>`, data: image.data });
  const kids = [];
  for (const p of pages) {
    const content = Buffer.from(p.ops.join('\n'), 'latin1');
    const c = add({ head: `<< /Length ${content.length} >>`, data: content });
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R /F4 ${f4} 0 R >>${img ? ` /XObject << /Im1 ${img} 0 R >>` : ''} >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; let off = parts[0].length; const xref = [];
  objs.forEach((o, i) => {
    xref.push(off);
    const chunk = typeof o === 'string'
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.head}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(chunk); off += chunk.length;
  });
  const x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
}

const pad = n => String(n).padStart(2, '0');
const fmtD = s => { const [y, m, d] = String(s).split('-'); return `${d}/${m}/${y}`; };
const num = n => (Number(n) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const age = s => { if (!s) return 99; const b = new Date(s), t = new Date(); let a = t.getFullYear() - b.getFullYear(); if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--; return a; };

// Fattura sanitaria in PDF a partire dai dati dell'app
function invoicePdf(data, inv, logoJpeg) {
  const me = data.me || {}, p = (data.patients || []).find(x => x.id === inv.patientId) || {}, st = (data.studi || []).find(x => x.id === inv.studioId) || {};
  const online = (inv.lines || []).some(l => { const a = (data.appts || []).find(x => x.id === l.apptId); return a && a.online; });
  const legal = (inv.regime === 'forfettario'
    ? 'Operazione effettuata ai sensi dell’art. 1, commi da 54 a 89, della Legge n. 190/2014 – Regime forfettario. Operazione non soggetta a ritenuta alla fonte a titolo di acconto ai sensi dell’art. 1, comma 67, L. n. 190/2014. '
    : 'Operazione esente IVA ai sensi dell’art. 10, c. 1, n. 18, DPR 633/1972. ')
    + (inv.bollo ? 'Imposta di bollo da € 2,00 assolta sull’originale per importi superiori a € 77,47. ' : '')
    + (inv.ts ? 'Spesa sanitaria da trasmettere al Sistema Tessera Sanitaria.' : 'Il paziente si è opposto alla trasmissione dei dati al Sistema Tessera Sanitaria.');
  const pg = new Page(); const L = 50, R = 545;
  let top = 792, image = null;
  if (logoJpeg) {
    const sz = jpegSize(logoJpeg);
    if (sz) { const h = 54, w = Math.min(160, sz.w * h / sz.h); pg.image('Im1', L, top - h, w, w === 160 ? 160 * sz.h / sz.w : h); image = { data: logoJpeg, w: sz.w, h: sz.h }; top -= 70; }
  }
  // professionista
  let y = top;
  pg.text(L, y, [me.titolo, me.nome, me.cognome].filter(Boolean).join(' '), { size: 13, font: 'F2' }); y -= 16;
  for (const t of [me.qualifica, me.albo, me.piva ? 'P. IVA ' + me.piva : '', st.nome ? `Prestazione resa presso: ${st.nome}${st.indirizzo ? ', ' + st.indirizzo : ''}` : '', online ? 'Anche in modalità online (videochiamata)' : '']) {
    if (t) { y = pg.wrap(L, y, t, 300, { size: 9.5, gray: 0.3 }); }
  }
  // riquadro fattura
  pg.text(390, 792, 'FATTURA', { size: 18, font: 'F2' });
  pg.text(390, 772, 'N. ' + inv.num, { size: 11, font: 'F2' });
  pg.text(390, 757, 'del ' + fmtD(inv.date), { size: 10, gray: 0.3 });
  // intestatario
  y = Math.min(y, 735) - 22;
  pg.text(L, y, 'INTESTATA A', { size: 8, font: 'F2', gray: 0.45 }); y -= 15;
  pg.text(L, y, `${p.nome || ''} ${p.cognome || ''}`.trim(), { size: 11, font: 'F2' }); y -= 14;
  if (p.cf) { pg.text(L, y, 'C.F. ' + p.cf, { size: 9.5, gray: 0.3 }); y -= 13; }
  if (age(p.nascita) < 18 && p.tutori && p.tutori[0]) { pg.text(L, y, 'Pagamento a cura di ' + p.tutori[0].nome, { size: 9.5, gray: 0.3 }); y -= 13; }
  // righe
  y -= 18;
  pg.rect(L, y - 6, R - L, 20, 0.94);
  pg.text(L + 8, y, 'Descrizione', { size: 9, font: 'F2' }); pg.text(R - 60, y, 'Importo', { size: 9, font: 'F2' });
  y -= 24;
  const row = (d, a, bold) => {
    const yy = pg.wrap(L + 8, y, d, 360, { size: 10, font: bold ? 'F2' : 'F1' });
    pg.text(R - 92, y, '€', { size: 10, font: bold ? 'F2' : 'F1' }); pg.right(R - 8, y, num(a), { size: 10, font: bold ? 'F4' : 'F3' });
    y = yy - 4; pg.line(L, y + 6, R, y + 6, 0.4, 0.85); y -= 6;
  };
  for (const l of inv.lines || []) row(l.desc, l.amount);
  row(inv.cassaNome || 'Contributo integrativo', inv.contr);
  if (inv.bollo) row('Rimborso marca da bollo', inv.bollo);
  y -= 2; pg.line(L, y + 14, R, y + 14, 1.2, 0);
  pg.text(L + 8, y, 'TOTALE', { size: 11, font: 'F2' }); pg.text(R - 100, y, '€', { size: 12, font: 'F2' }); pg.right(R - 8, y, num(inv.tot), { size: 12, font: 'F4' });
  y -= 34;
  y = pg.wrap(L, y, legal, R - L, { size: 8.5, gray: 0.35 });
  pg.text(L, 40, 'Fattura emessa in formato cartaceo/PDF: per le prestazioni sanitarie rese a persone fisiche non si emette la fattura elettronica.', { size: 7, gray: 0.55 });
  return build([pg], image);
}
module.exports = { invoicePdf };
