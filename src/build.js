// Concatenates the src/ sections into a single self-contained uke.html.
// Usage: node src/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// Order matters: later sections reference earlier consts.
const sections = [
  ['tuning/',   'tuning.js'],
  ['audio/',    'audio.js'],
  ['tracking/', 'tracking.js'],
  ['chord/',    'chord.js'],
  ['uke/ + strum/', 'strum.js'],
  ['annot/',    'annot.js'],
  ['fit/',      'fit.js'],
  ['songs/',    'songs.js'],
  ['main',      'main.js'],
];

let js = '';
for (const [label, file] of sections) {
  let src = read(file);
  // Strip node-only export shims; everything shares one module scope in the browser.
  src = src.replace(/^\s*if \(typeof module !== 'undefined'\)[^\n]*\n?/gm, '');
  js += `\n// ${'='.repeat(74)}\n// SECTION ${label}  (src/${file})\n// ${'='.repeat(74)}\n${src}\n`;
}

const html = read('template.html').replace('/*__SECTIONS__*/', () => js);
const out = path.join(root, 'uke.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`wrote ${out}  (${(html.length / 1024).toFixed(0)} KB)`);
