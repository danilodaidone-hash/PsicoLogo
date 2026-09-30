// Scarica i caratteri tipografici nella cartella public/fonts.
// Se il download non riesce, l'app funziona lo stesso con i caratteri di sistema.
const fs = require('node:fs');
const FILES = [
  ['bricolage-grotesque', 'bricolage-grotesque-latin-500-normal'],
  ['bricolage-grotesque', 'bricolage-grotesque-latin-700-normal'],
  ['atkinson-hyperlegible', 'atkinson-hyperlegible-latin-400-normal'],
  ['atkinson-hyperlegible', 'atkinson-hyperlegible-latin-700-normal'],
  ['jetbrains-mono', 'jetbrains-mono-latin-400-normal'],
  ['jetbrains-mono', 'jetbrains-mono-latin-500-normal'],
];
(async () => {
  fs.mkdirSync('public/fonts', { recursive: true });
  for (const [pkg, file] of FILES) {
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/npm/@fontsource/${pkg}@5/files/${file}.woff2`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(`public/fonts/${file}.woff2`, Buffer.from(await r.arrayBuffer()));
      console.log('carattere scaricato:', file);
    } catch (e) { console.log('carattere non scaricato (uso quello di sistema):', file, e.message); }
  }
})();
