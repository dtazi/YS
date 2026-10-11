// Tests with invented PDFs only; compare independent PDF readers and known arithmetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const log = console.log, warn = console.warn;
console.log = console.warn = () => {};
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
console.log = log; console.warn = warn;
const core = require('../src/fbar-core.js');
require('../src/parse-other-banks.js');
const extract = require('../src/extract-pdfjs.js');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fbar-invented-banks-'));
const py = path.resolve('.venv/bin/python');
const reference = `
import json,sys
from pathlib import Path
import fbar_other
def cents(v): return None if v is None else int(v*100)
def iso(d): return d.isoformat() if d else None
print(json.dumps([dict(account=s.account,openDate=iso(s.open_date),closeDate=iso(s.close_date),
 opening=cents(s.opening),closing=cents(s.closing),totalDebit=cents(s.total_debit),totalCredit=cents(s.total_credit),
 firstPage=s.first_page,lastPage=s.last_page,warnings=len(s.warnings),
 transactions=[dict(opDate=iso(t.op_date),valueDate=iso(t.value_date),debit=cents(t.debit),credit=cents(t.credit),
 balanceAfter=cents(t.balance_after),page=t.page) for t in s.transactions])
 for s in fbar_other.parse_statements(Path(sys.argv[1]),sys.argv[2])]))
`;
try {
  execFileSync(py, ['tests/make_other_bank_pdfs.py', folder]);
  for (const [name, bank] of [['invented-attijari.pdf', 'attijari'], ['invented-bmce.pdf', 'bmce'], ['invented-bmce-bad.pdf', 'bmce']]) {
    const file = path.join(folder, name);
    const pages = await extract.extractPages(pdfjs, new Uint8Array(fs.readFileSync(file)));
    const actual = core.parseFile(pages, name);
    const expected = JSON.parse(execFileSync(py, ['-c', reference, file, bank], { encoding: 'utf8' }));
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < actual.length; i++) {
      const a = actual[i], r = expected[i];
      for (const key of ['account', 'openDate', 'closeDate', 'opening', 'closing', 'totalDebit', 'totalCredit', 'firstPage', 'lastPage']) {
        assert.equal(a[key], r[key], name + ': ' + key);
      }
      assert.equal(a.warnings.length, r.warnings, name + ': warning count');
      assert.deepEqual(a.transactions.map(t => Object.fromEntries(Object.keys(r.transactions[0]).map(k => [k, t[k]]))), r.transactions);
    }
    if (bank === 'attijari') {
      assert.equal(actual.length, 2);
      assert.deepEqual(actual.map(s => s.transactions.length), [3, 1]);
      assert.deepEqual(actual.map(s => s.warnings), [[], []]);
      assert.equal(actual[1].closing, -10000);
      assert.equal(actual[0].transactions[1].description, 'FAKE PAYMENT MAD');
      assert.equal(core.summarize(actual, 2025).accounts[0].max.balance, 120000);
      assert.equal(core.summarize(core.parseFile(pages.slice(0, 1), name), 2025).problemCount > 0, true);
    } else {
      assert.equal(actual[0].transactions.length, 3);
      assert.equal(actual[0].opening, 50000);
      assert.equal(core.summarize(actual, 2025).accounts[0].max.balance, 100000);
      assert.equal(core.yearEnd(actual, 2025).balance, 90000);
      assert.match(actual[0].warnings.join(' '), /Balance anchor is provisional/);
      assert.equal(actual[0].warnings.length, name.includes('-bad') ? 2 : 1);
    }
    console.log('PASS ' + name + ': independent extraction, dates, balances, totals and warnings');
  }
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
