// Builds dist/index.html: one self-contained file that runs the whole platform in the browser (demo mode).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

let html = read('public/index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('public/styles.css')}\n</style>`)
  .replace('<script src="shared/engine.js"></script>', () => `<script>\n${safe(read('shared/engine.js'))}\n</script>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${safe(read('public/app.js'))}\n</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), html);
console.log(`dist/index.html — ${(html.length / 1024).toFixed(1)} KB`);
