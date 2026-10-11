#!/usr/bin/env node
// Builds dist/FBAR-Max-Balance.html: ONE self-contained file that works offline from file://.
// Everything is inlined: pdf.js + its worker (run on the main thread as pdf.js' "fake worker"),
// src/extract-pdfjs.js, src/fbar-core.js, the UI (app/app.js) and the CSS (app/styles.css).
// A Content-Security-Policy meta tag forbids any network access.
//
// Usage: node build.mjs

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'dist', 'FBAR-Max-Balance.html');
const PDFJS_VERSION = '3.11.174';
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",        // inline scripts only; no 'unsafe-eval' (pdf.js runs with isEvalSupported: false)
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function fail(message) {
  console.error('BUILD FAILED: ' + message);
  process.exit(1);
}

const pdfjsPkg = JSON.parse(read('node_modules/pdfjs-dist/package.json'));
if (pdfjsPkg.version !== PDFJS_VERSION) fail(`expected pdfjs-dist ${PDFJS_VERSION}, found ${pdfjsPkg.version}`);

const scripts = [
  ['pdf.js ' + PDFJS_VERSION, 'node_modules/pdfjs-dist/build/pdf.min.js'],
  ['pdf.js worker ' + PDFJS_VERSION + ' (runs on the main thread)', 'node_modules/pdfjs-dist/build/pdf.worker.min.js'],
  ['statement reader', 'src/extract-pdfjs.js'],
  ['calculation', 'src/fbar-core.js'],
  ['Attijari and BMCE readers', 'src/parse-other-banks.js'],
  ['user interface', 'app/app.js'],
].map(([label, rel]) => {
  let code;
  try {
    code = read(rel);
  } catch (e) {
    fail(`missing ${rel}`);
  }
  return { label, rel, code };
});

/** Make a script safe to embed in <script>...</script>. */
function embedScript({ label, rel, code }) {
  // "</script" would end the element early; "<\/script" means the same inside JS strings/regexes/comments.
  let safe = code.replace(/<\/(script)/gi, '<\\/$1');
  // "<!--" and "<script" can switch the HTML parser into "script data escaped" states; refuse rather than guess.
  if (/<!--|<script/i.test(safe)) fail(`${rel} contains "<!--" or "<script", which cannot be inlined safely`);
  return `<script data-part="${label}">\n${safe}\n</script>`;
}

const css = read('app/styles.css');
if (/@import|url\(\s*['"]?(?!data:)/i.test(css)) fail('app/styles.css must not load anything (no @import, no url() other than data:)');
if (/<\/style/i.test(css)) fail('app/styles.css contains "</style"');

const template = read('app/index.html');
const licenses = read('LICENSE') + '\n\n' + read('THIRD_PARTY_LICENSES.txt');
if (licenses.includes('-->')) fail('license text contains an HTML comment terminator');
for (const ph of ['{{CSP}}', '{{CSS}}', '{{SCRIPTS}}', '{{BUILD_INFO}}', '{{LICENSES}}']) {
  if (!template.includes(ph)) fail(`app/index.html is missing the ${ph} placeholder`);
}
// The page itself must not reference anything external.
if (/<script[^>]+src=|<link(?![^>]*href="data:)[^>]*href=|<img[^>]+src="(?!data:)|<iframe|<object|<embed/i.test(template)) {
  fail('app/index.html references an external resource');
}

const hash = createHash('sha256');
for (const s of scripts) hash.update(s.code);
hash.update(css).update(template).update(licenses);
const today = new Date().toISOString().slice(0, 10);
const buildInfo = `${today} ${hash.digest('hex').slice(0, 8)}`;

// split/join instead of String.replace: the inlined code contains "$" sequences replace() would interpret.
const fill = (text, key, value) => text.split(key).join(value);
let html = template;
html = fill(html, '{{CSP}}', CSP);
html = fill(html, '{{CSS}}', css);
html = fill(html, '{{BUILD_INFO}}', buildInfo);
html = fill(html, '{{LICENSES}}', licenses);
html = fill(html, '{{SCRIPTS}}', scripts.map(embedScript).join('\n'));

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`Built ${path.relative(ROOT, OUT)} (${kb(statSync(OUT).size)}), build ${buildInfo}`);
for (const s of scripts) console.log(`  ${s.rel.padEnd(46)} ${kb(Buffer.byteLength(s.code))}`);
