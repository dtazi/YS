#!/usr/bin/env node
// Save a private PDF report and CSVs locally using the offline browser app.
// Cross-check extraction against pdfplumber; print counts and checks only.
// Usage: node tools/export_report.mjs --out DIR --year 2025 [--rate 9.101] PDF [PDF ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const options = {};
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (['--out', '--year', '--rate', '--bank', '--input-dir'].includes(argv[i])) options[argv[i].slice(2)] = argv[++i];
  else files.push(path.resolve(argv[i]));
}
options.bank ||= 'cih';
if (!['cih', 'attijari', 'bmce'].includes(options.bank)) {
  console.error('Unsupported bank selection.'); process.exit(1);
}
if (options['input-dir']) {
  const discover = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) discover(p);
      else if (/\.pdf$/i.test(entry.name)) files.push(p);
    }
  };
  discover(path.resolve(options['input-dir'])); files.sort();
}
if (!options.out || !/^\d{4}$/.test(options.year || '') || !files.length) {
  console.error('Usage: node tools/export_report.mjs --out DIR --year YYYY [--rate MAD_PER_USD] PDF [PDF ...]');
  process.exit(1);
}
const OUT = path.resolve(options.out);
const PY = path.join(ROOT, '.venv/bin/python');
const APP = pathToFileURL(path.join(ROOT, 'dist/FBAR-Max-Balance.html')).href;
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
let browser;

// Private values stay in subprocess output buffers, local variables and files.
const PY_REFERENCE = `
import json, sys
from pathlib import Path
from tools.safe_inspect import quiet
import fbar_cih as f
import fbar_other
def cents(x): return None if x is None else int(x * 100)
def iso(x): return None if x is None else x.isoformat()
def record(s):
    return dict(fileName=s.path.name, account=s.account, firstPage=s.first_page, lastPage=s.last_page,
        openDate=iso(s.open_date), closeDate=iso(s.close_date), opening=cents(s.opening), closing=cents(s.closing),
        totalDebit=cents(s.total_debit), totalCredit=cents(s.total_credit), warningCount=len(s.warnings),
        transactions=[dict(opDate=iso(t.op_date), valueDate=iso(t.value_date), debit=cents(t.debit),
            credit=cents(t.credit), balanceAfter=cents(t.balance_after), page=t.page) for t in s.transactions])
with quiet():
    statements=[s for p in sys.argv[3:] for s in fbar_other.parse_statements(Path(p),sys.argv[2])]
    used=[]; seen=set()
    for s in statements:
        key=(s.account, s.open_date, s.close_date)
        if key not in seen:
            used.append(s); seen.add(key)
    accounts=[]
    for account in sorted({s.account for s in used}):
        own=sorted([s for s in used if s.account==account], key=lambda s:s.open_date or f.date.min)
        events=f.year_events(own,int(sys.argv[1])); peak=max(events,key=lambda e:e[1]) if events else None
        end=f.year_end(own,int(sys.argv[1]))
        accounts.append(dict(account=account, maximum=cents(peak[1]) if peak else None,
            maxDate=iso(peak[0]) if peak else None, yearEnd=cents(end[1]) if end else None))
print(json.dumps(dict(statements=[record(s) for s in statements],accounts=accounts)))
`;

function requireCheck(condition, label) {
  if (!condition) {
    const error = new Error(label);
    error.safeMessage = label;
    throw error;
  }
}

try {
  const reference = JSON.parse(execFileSync(PY, ['-c', PY_REFERENCE, options.year, options.bank, ...files], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  }));
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });
  const page = await browser.newPage();
  await page.emulateTimezone('Africa/Casablanca');
  let externalRequests = 0;
  let pageErrors = 0;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === APP || /^(data|blob):/.test(request.url())) request.continue();
    else { externalRequests++; request.abort(); }
  });
  page.on('pageerror', () => { pageErrors++; });
  await page.setOfflineMode(true);
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.state === 'ready');
  await page.evaluate(() => {
    window.print = () => {};
    window.__exportStatements = [];
    const parse = window.FBARCore.parseFile;
    window.FBARCore.parseFile = (...args) => {
      const statements = parse(...args);
      window.__exportStatements.push(...statements);
      return statements;
    };
    const summarize = window.FBARCore.summarize;
    window.FBARCore.summarize = (...args) => {
      window.__exportUsed = args[0];
      window.__exportSummary = summarize(...args);
      return window.__exportSummary;
    };
  });
  await page.$eval('#year', (element, year) => {
    element.value = year; element.dispatchEvent(new Event('change', { bubbles: true }));
  }, options.year);
  if (options.rate) await page.$eval('#rate', (element, rate) => {
    element.value = rate; element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, options.rate);
  const input = await page.$('#file-input');
  await input.uploadFile(...files);
  await page.waitForFunction(() => document.body.dataset.state === 'done' &&
    !document.querySelector('#file-list li[data-status="waiting"], #file-list li[data-status="reading"]'),
  { timeout: 120000 });
  const actual = await page.evaluate(() => ({
    statements: window.__exportStatements,
    used: window.__exportUsed,
    summary: window.__exportSummary,
    year: document.getElementById('year').value,
    rate: document.getElementById('rate').value,
  }));
  requireCheck(actual.year === options.year, 'Report year check failed');
  requireCheck(actual.summary && actual.summary.accounts.length > 0, 'No reportable account found');
  requireCheck(actual.statements.length === reference.statements.length, 'Independent statement count check failed');
  for (let i = 0; i < reference.statements.length; i++) {
    const a = actual.statements[i], r = reference.statements[i];
    for (const field of ['fileName', 'account', 'firstPage', 'lastPage', 'openDate', 'closeDate',
      'opening', 'closing', 'totalDebit', 'totalCredit']) {
      requireCheck(a[field] === r[field], 'Independent statement field check failed: ' + field);
    }
    requireCheck(a.warnings.length === r.warningCount, 'Independent warning count check failed');
    requireCheck(a.transactions.length === r.transactions.length, 'Independent transaction count check failed');
    for (let j = 0; j < r.transactions.length; j++) {
      for (const field of ['opDate', 'valueDate', 'debit', 'credit', 'balanceAfter', 'page']) {
        requireCheck(a.transactions[j][field] === r.transactions[j][field], 'Independent transaction check failed: ' + field);
      }
    }
  }
  for (const r of reference.accounts) {
    const a = actual.summary.accounts.find(account => account.account === r.account);
    requireCheck(a && (a.max?.balance ?? null) === r.maximum && (a.max?.date ?? null) === r.maxDate &&
      (a.yearEnd?.balance ?? null) === r.yearEnd, 'Independent maximum and year-end check failed');
  }
  const csv = await page.evaluate(() => ({
    statements: window.FBARCore.statementsCsv(window.__exportUsed),
    transactions: window.FBARCore.transactionsCsv(window.__exportUsed),
  }));
  const prefix = ({ cih: 'CIH', attijari: 'Attijari', bmce: 'BMCE' })[options.bank] + '-' + options.year;
  for (const [kind, content] of Object.entries(csv)) {
    fs.writeFileSync(path.join(OUT, prefix + '-' + kind + '.csv'), '\uFEFF' + content, { mode: 0o600 });
  }
  await page.click('#save-report-detailed');
  await page.evaluate(() => {
    const statements = window.__exportStatements;
    const duplicates = statements.filter(statement => !window.__exportUsed.includes(statement));
    // The objects remain identical inside this browser; only local file output contains private fields.
    const report = document.getElementById('report');
    const note = document.createElement('p');
    note.className = 'rep-meta';
    note.textContent = 'Verification: statement dates, balances, totals, transactions, yearly maximum and December 31 balance ' +
      'were cross-checked with a separate local PDF reader. ' +
      'This checks extraction and arithmetic; it does not confirm the date of an undated online balance. ' +
      (duplicates.length ? duplicates.length + ' repeated statement(s) were excluded from the calculation: ' +
        duplicates.map(s => s.displayName).join('; ') + '. ' : '') +
      'If any month is missing, the highest balance shown is the highest in the supplied statements; ' +
      'the final yearly maximum cannot be confirmed until that statement is added.';
    report.insertBefore(note, report.querySelector('.rep-status').nextSibling);
  });
  await page.emulateMediaType('print');
  const reportChecks = await page.evaluate(() => ({
    finalStatusCorrect: window.__exportSummary.problemCount === 0 ||
      document.querySelector('#report .rep-status').textContent.includes('NOT FINAL'),
    detailed: document.querySelectorAll('#report .rep-stmt').length,
  }));
  requireCheck(reportChecks.finalStatusCorrect, 'Report status check failed');
  requireCheck(reportChecks.detailed === actual.used.length, 'Detailed report statement count check failed');
  requireCheck(externalRequests === 0 && pageErrors === 0, 'Offline browser verification failed');
  const reportPath = path.join(OUT, prefix + '-report.pdf');
  await page.pdf({ path: reportPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  fs.chmodSync(reportPath, 0o600);
  fs.writeFileSync(path.join(OUT, prefix + '-verification.json'), JSON.stringify({
    year: Number(options.year), accounts: actual.summary.accounts.length,
    bank: options.bank,
    suppliedStatements: actual.statements.length, usedStatements: actual.used.length,
    duplicateStatements: actual.statements.length - actual.used.length,
    transactions: actual.used.reduce((count, statement) => count + statement.transactions.length, 0),
    conditionalBalanceAnchor: actual.used.some(statement => statement.balanceBasis === 'undated-snapshot'),
    statementWarnings: actual.used.reduce((count, statement) => count + statement.warnings.length, 0),
    problems: actual.summary.problemCount, independentExtractionMatches: true,
    maximumAndYearEndMatch: true, externalRequests, pageErrors,
    reportBytes: fs.statSync(reportPath).size,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('Saved a private PDF report and statement/transaction CSVs locally.');
  console.log(JSON.stringify({ statements: actual.used.length,
    duplicates: actual.statements.length - actual.used.length,
    problems: actual.summary.problemCount, independentChecks: 'PASS', externalRequests, pageErrors }));
} catch (error) {
  // Subprocess error objects can contain PDF data in stdout/stderr; never print them.
  console.error('Report export failed (' + (error.safeMessage || 'local processing failed') + ').');
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
