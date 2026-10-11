// Node tests for src/fbar-core.js + src/extract-pdfjs.js, compared against the Python reference fbar_cih.py.
//
//   node tests/run-js-tests.mjs
//
// Generates fake statements (tests/make_fake_statements.py, tests/make_edge_statements.py) into a temporary
// folder (or $FBAR_TEST_DIR), runs fbar_cih.py on them, runs the JS pipeline (pdfjs-dist legacy build) on the
// same PDFs and checks that both give the same results. Never uses real statements.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.FBAR_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
const YEAR = 2025;

// pdf.js prints harmless "Cannot polyfill DOMMatrix/Path2D" warnings when loaded in Node without `canvas`.
const pdfjsLib = (() => {
  const log = console.log, warn = console.warn;
  console.log = console.warn = () => {};
  try { return require(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.js')); }
  finally { console.log = log; console.warn = warn; }
})();
const FBARCore = require(path.join(ROOT, 'src/fbar-core.js'));
const FBARExtract = require(path.join(ROOT, 'src/extract-pdfjs.js'));

// ------------------------------------------------------------------ tiny test runner
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------ helpers
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

/** Python Decimal string ('13594344.34', '0', '-1234.56', '') -> cents or null. Independent of the code under test. */
function decToCents(s) {
  if (s === '' || s === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  assert.ok(m, `not a decimal: ${s}`);
  return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0')));
}

/** '13 294 345,24' -> cents. */
const madToCents = (s) => decToCents(s.replace(/[  ]/g, '').replace(',', '.'));

/** fbar_cih.py stdout -> { account: { statements, issues: [...], max: {balance, date, label} | null, usd } } */
function parsePythonReport(stdout) {
  const accounts = {};
  let cur = null;
  for (const line of stdout.split('\n')) {
    let m;
    if ((m = /^Account (.+?) {2}\((\d+) statements\)$/.exec(line))) {
      cur = accounts[m[1]] = { statements: Number(m[2]), issues: [], max: null, usd: null };
    } else if (cur && (m = /^ {2}! (.*)$/.exec(line))) cur.issues.push(m[1]);
    else if (cur && (m = /^ {2}Maximum balance: (.+) MAD on (\d{4}-\d\d-\d\d) {2}\((.*)\)$/.exec(line))) {
      cur.max = { balance: madToCents(m[1]), date: m[2], label: m[3] };
    } else if (cur && (m = /^ {2}In USD at .*rounded up: \$([\d,]+)$/.exec(line))) cur.usd = Number(m[1].replace(/,/g, ''));
  }
  return accounts;
}

function runPython(dir, year, outDir) {
  const stdout = run(PY, ['fbar_cih.py', dir, '--year', String(year), '--rate', '10.05', '--out', outDir]);
  return {
    report: parsePythonReport(stdout),
    statements: parseCsv(fs.readFileSync(path.join(outDir, 'statements.csv'), 'utf8')),
    transactions: parseCsv(fs.readFileSync(path.join(outDir, 'transactions.csv'), 'utf8')),
  };
}

/** Same file order as fbar_cih.py: sorted(rglob('*.pdf')). */
const pdfFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();

async function runJs(dir) {
  const pages = {}, statements = [];
  for (const f of pdfFiles(dir)) {
    pages[f] = await FBARExtract.extractPages(pdfjsLib, fs.readFileSync(path.join(dir, f)));
    statements.push(FBARCore.parseStatement(pages[f], f));
  }
  return { pages, statements };
}

const PLUMB_DUMP = `
import json, sys, pdfplumber
out = {}
for p in sys.argv[1:]:
    pages = []
    with pdfplumber.open(p) as pdf:
        for pg in pdf.pages:
            pages.append({"words": [{k: (w[k] if k == "text" else float(w[k])) for k in ("text", "x0", "x1", "top", "bottom")}
                                    for w in pg.extract_words()],
                          "vlines": sorted({round(float(e["x0"]), 3) for e in pg.edges
                                            if e["orientation"] == "v" and e["height"] > 20})})
    out[p.rsplit("/", 1)[-1]] = pages
json.dump(out, sys.stdout)
`;

// ------------------------------------------------------------------ comparisons shared by both data sets

function compareStatements(py, js) {
  const jsByFile = Object.fromEntries(js.statements.map((s) => [s.fileName, s]));
  assert.equal(py.statements.rows.length, js.statements.length, 'number of statements');
  for (const r of py.statements.rows) {
    const s = jsByFile[r.file];
    assert.ok(s, `JS has no statement for ${r.file}`);
    const ctx = r.file;
    assert.equal(s.account || FBARCore.UNKNOWN_ACCOUNT, r.account, `${ctx} account`);
    assert.equal(s.openDate ?? '', r.period_start, `${ctx} period start`);
    assert.equal(s.closeDate ?? '', r.period_end, `${ctx} period end`);
    assert.equal(s.opening, decToCents(r.opening), `${ctx} opening`);
    assert.equal(s.closing, decToCents(r.closing), `${ctx} closing`);
    assert.equal(s.totalDebit, decToCents(r.total_debit), `${ctx} total debit`);
    assert.equal(s.totalCredit, decToCents(r.total_credit), `${ctx} total credit`);
    assert.equal(s.transactions.length, Number(r.transactions), `${ctx} transaction count`);
    const pyWarnings = r.status === 'OK' ? 0 : r.status.split(' | ').length;
    assert.equal(s.warnings.length, pyWarnings, `${ctx} number of warnings (python: ${r.status}; js: ${s.warnings.join(' | ')})`);
  }
}

function compareTransactions(py, js) {
  const jsRows = [];
  for (const g of FBARCore.summarize(js.statements, YEAR).accounts) {
    for (const s of g.statements) for (const t of s.transactions) jsRows.push({ account: g.account, file: s.fileName, t });
  }
  assert.equal(jsRows.length, py.transactions.rows.length, 'number of transactions');
  py.transactions.rows.forEach((r, i) => {
    const { account, file, t } = jsRows[i];
    const ctx = `transaction ${i + 1} (${r.file} ${r.operation_date})`;
    assert.equal(account, r.account, `${ctx} account`);
    assert.equal(file, r.file, `${ctx} file`);
    assert.equal(t.opDate, r.operation_date, `${ctx} operation date`);
    assert.equal(t.valueDate ?? '', r.value_date, `${ctx} value date`);
    assert.equal(t.description, r.description, `${ctx} description`);
    assert.equal(t.debit, decToCents(r.debit), `${ctx} debit`);
    assert.equal(t.credit, decToCents(r.credit), `${ctx} credit`);
    assert.equal(t.balanceAfter, decToCents(r.balance_after), `${ctx} balance after`);
  });
}

function compareSummary(pyReport, summary) {
  assert.deepEqual(summary.accounts.map((a) => a.account), Object.keys(pyReport), 'accounts (same order)');
  let pyProblems = 0;
  for (const a of summary.accounts) {
    const p = pyReport[a.account];
    assert.equal(a.statements.length, p.statements, `${a.account} statement count`);
    assert.equal(a.issues.length, p.issues.length,
      `${a.account} issues\n  python: ${p.issues.join('\n          ')}\n  js:     ${a.issues.join('\n          ')}`);
    pyProblems += p.issues.length;
    if (p.max === null) { assert.equal(a.max, null, `${a.account} has no maximum`); continue; }
    assert.ok(a.max, `${a.account} has a maximum`);
    assert.equal(a.max.balance, p.max.balance, `${a.account} maximum balance`);
    assert.equal(a.max.date, p.max.date, `${a.account} date of maximum`);
    const opening = /^opening balance \((.*)\)$/.exec(p.max.label);
    assert.equal(a.max.label, opening ? `starting balance (${opening[1]})` : p.max.label, `${a.account} label of maximum`);
    assert.equal(FBARCore.toUsd(a.max.balance, 10.05), p.usd, `${a.account} USD`);
  }
  assert.equal(summary.problemCount, pyProblems, 'problem count');
}

function compareCsvOutput(py, js) {
  const st = parseCsv(FBARCore.statementsCsv(js.statements));
  assert.deepEqual(st.header, py.statements.header, 'statements.csv columns');
  st.rows.forEach((r, i) => {
    const p = py.statements.rows[i];
    for (const k of ['account', 'file', 'period_start', 'period_end', 'transactions']) assert.equal(r[k], p[k], `statements.csv row ${i + 1} ${k}`);
    for (const k of ['opening', 'total_debit', 'total_credit', 'closing']) assert.equal(decToCents(r[k]), decToCents(p[k]), `statements.csv row ${i + 1} ${k}`);
    assert.equal(r.status === 'OK', p.status === 'OK', `statements.csv row ${i + 1} status`);
  });
  const tx = parseCsv(FBARCore.transactionsCsv(js.statements));
  assert.deepEqual(tx.header, py.transactions.header, 'transactions.csv columns');
  assert.equal(tx.rows.length, py.transactions.rows.length);
  tx.rows.forEach((r, i) => {
    const p = py.transactions.rows[i];
    for (const k of ['account', 'file', 'operation_date', 'value_date', 'description']) assert.equal(r[k], p[k], `transactions.csv row ${i + 1} ${k}`);
    for (const k of ['debit', 'credit', 'balance_after']) assert.equal(decToCents(r[k]), decToCents(p[k]), `transactions.csv row ${i + 1} ${k}`);
  });
}

// ------------------------------------------------------------------ setup

const workDir = process.env.FBAR_TEST_DIR
  ? (fs.mkdirSync(process.env.FBAR_TEST_DIR, { recursive: true }), fs.mkdtempSync(path.join(process.env.FBAR_TEST_DIR, 'run-')))
  : fs.mkdtempSync(path.join(os.tmpdir(), 'fbar-js-tests-'));
const fakeDir = path.join(workDir, 'fake'), edgeDir = path.join(workDir, 'edge');

console.log(`Working folder: ${workDir}`);
const generatorOut = run(PY, ['tests/make_fake_statements.py', fakeDir]);
run(PY, ['tests/make_edge_statements.py', edgeDir]);
const expected = {};
for (const m of generatorOut.matchAll(/^Expected account \.\.\.(\d{4}) (\d\d): max (.+?) on (\d{4}-\d\d-\d\d)/gm)) {
  expected[m[1] + m[2]] = { balance: madToCents(m[3]), date: m[4] };
}
const pyFake = runPython(fakeDir, YEAR, path.join(workDir, 'py-fake'));
const pyEdge = runPython(edgeDir, YEAR, path.join(workDir, 'py-edge'));
const pyEdge2024 = runPython(edgeDir, 2024, path.join(workDir, 'py-edge-2024'));
const plumb = JSON.parse(run(PY, ['-c', PLUMB_DUMP, ...pdfFiles(fakeDir).map((f) => path.join(fakeDir, f)),
  ...pdfFiles(edgeDir).map((f) => path.join(edgeDir, f))]));
const jsFake = await runJs(fakeDir);
const jsEdge = await runJs(edgeDir);
const sumFake = FBARCore.summarize(jsFake.statements, YEAR);
const sumEdge = FBARCore.summarize(jsEdge.statements, YEAR);
const edgeStmt = (f) => jsEdge.statements.find((s) => s.fileName === f);

// ------------------------------------------------------------------ tests: fake year (default seed)

test('fake year: generator expectations parsed', () => {
  assert.equal(Object.keys(expected).length, 2);
  assert.equal(jsFake.statements.length, 23);
});

test('fake year: every statement matches Python (opening, closing, totals, period, count, status)', () => {
  compareStatements(pyFake, jsFake);
  for (const s of jsFake.statements) assert.deepEqual(s.warnings, [], `${s.fileName} should have no warnings`);
});

test('fake year: every transaction matches Python (dates, label, debit, credit, running balance)', () => {
  compareTransactions(pyFake, jsFake);
});

test('fake year: maximum per account (amount, date, label, USD) and issues match Python', () => {
  compareSummary(pyFake.report, sumFake);
});

test('fake year: maximum per account matches the generator', () => {
  for (const a of sumFake.accounts) {
    const e = expected[a.account.slice(-6)];
    assert.ok(e, `generator expectation for ${a.account}`);
    assert.equal(a.max.balance, e.balance, `${a.account} max`);
    assert.equal(a.max.date, e.date, `${a.account} date`);
  }
});

test('fake year: missing September is the only issue', () => {
  assert.equal(sumFake.problemCount, 1);
  const a = sumFake.accounts.find((x) => x.account.endsWith('0245'));
  assert.equal(a.issues.length, 1);
  assert.match(a.issues[0], /1 September 2025 to 30 September 2025/);
  assert.deepEqual(sumFake.accounts.find((x) => x.account.endsWith('0123')).issues, []);
});

test('fake year: CSV output has the same columns and values as the Python CSVs', () => {
  compareCsvOutput(pyFake, jsFake);
});

test('fake year: works the same without vertical rules (header-based fallback)', () => {
  for (const [f, pages] of Object.entries(jsFake.pages)) {
    const a = FBARCore.parseStatement(pages, f);
    const b = FBARCore.parseStatement(pages.map((p) => ({ ...p, vlines: [] })), f);
    assert.deepEqual(b, a, f);
  }
});

test('fake year: guessYear', () => {
  assert.equal(FBARCore.guessYear(jsFake.statements), 2025);
});

// ------------------------------------------------------------------ tests: extraction accuracy

test('extraction: same words as pdfplumber, positions within 2pt; same vertical rules', () => {
  let maxErr = 0, n = 0;
  for (const [file, pages] of Object.entries(plumb)) {
    const js = (jsFake.pages[file] || jsEdge.pages[file]);
    assert.equal(js.length, pages.length, `${file} page count`);
    pages.forEach((p, i) => {
      const jw = js[i].words;
      assert.equal(jw.length, p.words.length, `${file} p${i + 1} word count`);
      // pages without text are not searched for rules (nothing to lay out), so expect [] there
      assert.deepEqual(js[i].vlines, p.words.length ? p.vlines : [], `${file} p${i + 1} vlines`);
      const used = new Set();
      for (const w of p.words) {
        let best = -1, bd = Infinity;
        jw.forEach((v, k) => {
          if (used.has(k) || v.text !== w.text) return;
          const d = Math.abs(v.x0 - w.x0) + Math.abs(v.top - w.top);
          if (d < bd) { bd = d; best = k; }
        });
        assert.ok(best >= 0, `${file} p${i + 1}: word "${w.text}" not found`);
        used.add(best);
        for (const k of ['x0', 'x1', 'top', 'bottom']) {
          const e = Math.abs(jw[best][k] - w[k]);
          maxErr = Math.max(maxErr, e);
          assert.ok(e <= 2, `${file} p${i + 1} "${w.text}" ${k}: pdf.js ${jw[best][k]} vs pdfplumber ${w[k]}`);
        }
        n++;
      }
    });
  }
  console.log(`    (${n} words compared, largest position difference ${maxErr.toFixed(2)}pt)`);
});

test('extraction: page size and top-left origin', () => {
  const p = jsFake.pages['0123_2025-01.pdf'][0];
  assert.ok(Math.abs(p.width - 595.2756) < 0.01 && Math.abs(p.height - 841.8898) < 0.01);
  const debit = p.words.find((w) => w.text === 'DEBIT');
  assert.ok(debit.top > 275 && debit.top < 285 && debit.bottom > debit.top);
});

test('extraction: a file that is not a PDF is rejected with a plain-language message', async () => {
  for (const bytes of [Buffer.from('hello, this is not a pdf'), new ArrayBuffer(0)]) {
    await assert.rejects(FBARExtract.extractPages(pdfjsLib, bytes), (err) => {
      assert.equal(typeof err.userMessage, 'string');
      assert.match(err.userMessage, /PDF/);
      return true;
    });
  }
  const s = FBARCore.unreadableStatement('broken.pdf', 'This file is not a valid PDF, or it is damaged.');
  assert.ok(FBARCore.summarize([s], YEAR).accounts[0].issues.includes('broken.pdf: This file is not a valid PDF, or it is damaged.'));
});

test('extraction: the caller\'s buffer is left usable', async () => {
  const buf = fs.readFileSync(path.join(fakeDir, '0123_2025-01.pdf'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  await FBARExtract.extractPages(pdfjsLib, ab);
  assert.equal(ab.byteLength, buf.byteLength);
});

// ------------------------------------------------------------------ tests: edge cases

test('edge cases: every statement matches Python', () => { compareStatements(pyEdge, jsEdge); });
test('edge cases: every transaction matches Python', () => { compareTransactions(pyEdge, jsEdge); });
test('edge cases: maximum per account and issues match Python', () => { compareSummary(pyEdge.report, sumEdge); });
test('edge cases: CSV output matches the Python CSVs', () => { compareCsvOutput(pyEdge, jsEdge); });
test('edge cases: year 2024 matches Python (transactions dated 31/12 on a January statement)', () => {
  compareSummary(pyEdge2024.report, FBARCore.summarize(jsEdge.statements, 2024));
});

test('edge: negative balance shown in the DEBIT column (overdraft)', () => {
  const jan = edgeStmt('0367_2025-01.pdf'), feb = edgeStmt('0367_2025-02.pdf');
  assert.equal(jan.opening, -123456);
  assert.equal(feb.closing, -590476);
  assert.equal(feb.transactions.at(-1).balanceAfter, -590476);
  assert.deepEqual(feb.warnings, []);
});

test('edge: amounts of 1 000 000,00 and more', () => {
  const jan = edgeStmt('0367_2025-01.pdf');
  assert.deepEqual(jan.transactions.map((t) => [t.debit, t.credit]),
    [[10000, 0], [0, 125000000], [30000010, 0], [0, 1234567890]]);
  assert.equal(edgeStmt('0367_2025-02.pdf').transactions[0].debit, 1330000000);
  assert.equal(FBARCore.formatMad(1329434524), '13 294 345,24');
});

test('edge: DD/MM/YYYY, DD/MM/YY and year inference across new year', () => {
  const jan = edgeStmt('0367_2025-01.pdf');
  assert.deepEqual(jan.transactions.map((t) => [t.opDate, t.valueDate]), [
    ['2024-12-31', '2024-12-31'], ['2025-01-05', '2025-01-06'], ['2025-01-20', '2025-01-21'], ['2025-01-28', '2025-01-29']]);
  assert.equal(jan.transactions[1].description, 'VIR RECU DE SARL ATLAS TRADING REF 2025-1111');
});

test('edge: opening that differs from the previous closing is reported', () => {
  const a = sumEdge.accounts.find((x) => x.account.endsWith('0367'));
  assert.ok(a.issues.some((i) => /0367_2025-02\.pdf starts with a balance of 13 294 345,24 MAD, but 0367_2025-01\.pdf ended with 13 294 344,24 MAD/.test(i)), a.issues.join('\n'));
  assert.ok(a.issues.some((i) => /after 28 February 2025/.test(i)));
});

test('edge: a statement that does not add up (tampered PDF)', () => {
  const s = edgeStmt('0489_2025-01.pdf');
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings[0], /does not add up.*5 500,00 MAD.*5 600,00 MAD/);
  assert.match(s.warnings[1], /totals do not match.*1 500,00 MAD of debits.*1 400,00 MAD/);
});

test('edge: a statement that does not add up (tampered extracted words)', () => {
  const pages = structuredClone(jsFake.pages['0123_2025-01.pdf']);
  const amount = pages[0].words.find((w) => w.text === '887,25'); // 76 887,25 credit on 02/01
  assert.ok(amount);
  amount.text = '888,25';
  const s = FBARCore.parseStatement(pages, 'tampered.pdf');
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings[0], /does not add up/);
  assert.match(s.warnings[1], /totals do not match/);
});

test('edge: unreadable amount, impossible date, line not understood', () => {
  const s = edgeStmt('0512_2025-03.pdf');
  assert.equal(s.warnings.length, 3, s.warnings.join('\n'));
  assert.match(s.warnings[0], /^Page 1: this line was not understood and was left out: "FRAIS DIVERS 10,00"$/);
  assert.match(s.warnings[1], /^Page 1: an amount could not be read on this line: ".*12,3"$/);
  assert.match(s.warnings[2], /^Page 1: a date could not be read.*"31\/02 01\/03 RETRAIT GAB CASA ANFA 50,00"$/);
});

test('edge: scanned PDF (no text)', () => {
  const s = edgeStmt('scanned.pdf');
  assert.equal(jsEdge.pages['scanned.pdf'][0].words.length, 0);
  assert.deepEqual(jsEdge.pages['scanned.pdf'][0].vlines, []);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /no readable text.*scanned/);
  assert.equal(s.account, '');
});

test('edge: a PDF that is not a statement', () => {
  const s = edgeStmt('letter.pdf');
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /does not look like a CIH Bank account statement/);
  const unknown = sumEdge.accounts.find((a) => a.account === FBARCore.UNKNOWN_ACCOUNT);
  assert.equal(unknown.statements.length, 2);
  assert.equal(unknown.max, null);
});

test('edge: no pages at all counts as no text', () => {
  assert.match(FBARCore.parseStatement([], 'empty.pdf').warnings[0], /no readable text/);
});

// ------------------------------------------------------------------ tests: units

test('units: toUsd rounds up exactly, accepts "10,05", 0 for balances <= 0', () => {
  assert.equal(FBARCore.toUsd(190825351, 10.05), 189876);
  assert.equal(FBARCore.toUsd(100500, 10.05), 100);      // exactly 100, not 101 (float division would say 100.00000000000001)
  assert.equal(FBARCore.toUsd(100501, '10,05'), 101);
  assert.equal(FBARCore.toUsd(1, 10), 1);
  assert.equal(FBARCore.toUsd(0, 10), 0);
  assert.equal(FBARCore.toUsd(-5000, 10), 0);
  assert.equal(FBARCore.toUsd(100, ''), null);
  assert.equal(FBARCore.toUsd(100, 0), null);
  assert.equal(FBARCore.toUsd(100, 'abc'), null);
  assert.equal(FBARCore.toUsd(999999999999999, '9.3456'), 1070022256463); // checked with Python Decimal
});

test('units: formatMad', () => {
  assert.equal(FBARCore.formatMad(1824050), '18 240,50');
  assert.equal(FBARCore.formatMad(-123456), '-1 234,56');
  assert.equal(FBARCore.formatMad(-5), '-0,05');
  assert.equal(FBARCore.formatMad(0), '0,00');
  assert.equal(FBARCore.formatMad(123456789012), '1 234 567 890,12');
  assert.equal(FBARCore.formatMad(null), '');
});

test('units: amounts', () => {
  const p = FBARCore._internal.parseAmount;
  assert.equal(p('1 234,56'), 123456);
  assert.equal(p('1.234,56'), 123456);
  assert.equal(p('1234,56'), 123456);
  assert.equal(p('1 234 567,89'), 123456789);
  assert.equal(p('-0,50'), -50);
  assert.equal(p('12,3'), null);
  assert.equal(p('1,234.56'), null);
  assert.equal(p('ABC'), null);
});

test('units: dates', () => {
  const r = FBARCore._internal.resolveDate;
  const jan = { openDate: '2024-12-31', closeDate: '2025-01-31' };
  assert.equal(r('31/12', jan), '2024-12-31');
  assert.equal(r('02/01', jan), '2025-01-02');
  assert.equal(r('02.01.24', jan), '2024-01-02');
  assert.equal(r('29/02', { closeDate: '2024-03-31' }), '2024-02-29');
  assert.equal(r('29/02', { closeDate: '2025-03-31' }), '2024-02-29'); // nearest year where it exists
  assert.equal(r('31/02/2025', jan), null);
  assert.equal(r('00/01/0000', jan), null);
  assert.equal(r('05/01', { openDate: null, closeDate: null }), null);
  assert.equal(FBARCore._internal.addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(FBARCore._internal.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(FBARCore.humanDate('2025-09-01'), '1 September 2025');
  assert.equal(FBARCore._internal.pyRound(2.5), 2);
  assert.equal(FBARCore._internal.pyRound(3.5), 4);
  assert.equal(FBARCore._internal.pyRound(2.6), 3);
});

test('units: CSV quoting', () => {
  const s = FBARCore.parseStatement([], 'a "b", c.pdf');
  const csv = FBARCore.statementsCsv([s]);
  assert.equal(parseCsv(csv).rows[0].file, 'a "b", c.pdf');
  assert.ok(csv.endsWith('\r\n'));
});

test('layoutDump: positions kept, personal data masked', () => {
  const dump = FBARCore.layoutDump(jsFake.pages['0123_2025-06.pdf']);
  assert.match(dump, /^--- page 1 \(595x842\) ---$/m);
  assert.match(dump, /vline x=388\.0/);
  for (const k of ['DEBIT', 'CREDIT', 'OPERATION-REFERENCE', 'SOLDE', 'DEPART', 'NOUVEAU', 'BANQUE']) assert.ok(dump.includes(':' + k), k);
  for (const secret of ['0000000000000001', 'ATLAS', 'TEST', 'CLIENT', 'FICTIF', 'CASA', '2025']) assert.ok(!dump.includes(secret), secret);
  assert.ok(!/[0-8]/.test(dump.replace(/\d+\.\d-\d+\.\d@\d+:/g, '').replace(/^(---|vline).*$/gm, '')), 'only 9s left in masked text');
});

test('browser build: pdf.min.js + inline worker (globalThis.pdfjsWorker) gives the same pages', async () => {
  // This is how the single-file HTML runs pdf.js (fake worker on the main thread). Kept last: it sets a global.
  globalThis.pdfjsWorker = require(path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.min.js'));
  const browserLib = require(path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.min.js'));
  for (const f of ['0123_2025-06.pdf', '0245_2025-10.pdf']) {
    const pages = await FBARExtract.extractPages(browserLib, fs.readFileSync(path.join(fakeDir, f)));
    assert.deepEqual(pages, jsFake.pages[f], f);
  }
});

// ------------------------------------------------------------------ run

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok    ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${String(err && err.message || err).split('\n').join('\n      ')}`);
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed (${tests.length} tests)`);
process.exitCode = failed ? 1 : 0;
