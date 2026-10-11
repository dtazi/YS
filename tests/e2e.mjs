#!/usr/bin/env node
// End-to-end test of dist/FBAR-Max-Balance.html in a real browser (headless Google Chrome via puppeteer-core).
//
//   node tests/e2e.mjs [WORK_DIR]
//
// 1. builds the page (node build.mjs) and generates FAKE statements (tests/make_fake_statements.py,
//    tests/make_edge_case_pdfs.py, tests/make_edge_statements.py) into WORK_DIR;
// 2. opens the page from file://, uploads the PDFs through the file input and checks that the maximum,
//    its date and the USD value shown match what make_fake_statements.py / fbar_cih.py print;
// 3. checks error handling (password, scan, non-CIH, non-PDF, duplicates), the CSV and diagnostic downloads;
// 4. asserts that NO network request is made (request interception) and no CSP violation happens;
// 5. saves screenshots (light/dark, desktop/390px) into WORK_DIR/screenshots.
//
// Never uses real bank statements. Chrome path: $CHROME_PATH or the standard macOS location.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, '.venv', 'bin', 'python');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WORK = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'fbar-e2e-')));
const RATE = '9.101';
const YEAR = 2025;

let failures = 0;
let passes = 0;
function check(cond, message, extra) {
  if (cond) { passes++; console.log('  ok   ' + message); }
  else { failures++; console.log('  FAIL ' + message + (extra !== undefined ? '\n       got: ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const madToCents = (s) => Number(s.replace(/[\s ]/g, '').replace(',', ''));
const digits = (s) => s.replace(/\D/g, '');
/** ceil(cents / rate / 100) computed exactly, independent of the app's code. */
function usdCeil(cents, rate) {
  const [i, f = ''] = rate.split('.');
  const num = BigInt(cents) * 10n ** BigInt(f.length);
  const den = BigInt(i + f) * 100n;
  return Number(num / den + (num % den ? 1n : 0n));
}
function freshDir(p) { fs.rmSync(p, { recursive: true, force: true }); fs.mkdirSync(p, { recursive: true }); return p; }
function pdfsIn(dir) { return fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort().map((f) => path.join(dir, f)); }

async function waitForFile(dir, name, timeout = 15000) {
  const p = path.join(dir, name);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(p) && !fs.existsSync(p + '.crdownload')) {
      await sleep(200);
      return fs.readFileSync(p, 'utf8');
    }
    await sleep(100);
  }
  return null;
}

async function main() {
  console.log('Work dir: ' + WORK);
  const pdfDir = freshDir(path.join(WORK, 'pdfs'));
  const edgeDir = freshDir(path.join(WORK, 'edge'));
  const probDir = freshDir(path.join(WORK, 'problem-statements'));
  const shotDir = freshDir(path.join(WORK, 'screenshots'));
  const dlDir = freshDir(path.join(WORK, 'downloads'));

  // ---------------------------------------------------------------- build + fake data
  console.log(execFileSync('node', [path.join(ROOT, 'build.mjs')], { encoding: 'utf8' }).trim());
  const htmlPath = path.join(ROOT, 'dist', 'FBAR-Max-Balance.html');
  const pageUrl = pathToFileURL(htmlPath).href;

  const fakeOut = execFileSync(PY, [path.join(ROOT, 'tests', 'make_fake_statements.py'), pdfDir], { encoding: 'utf8' });
  const expected = [...fakeOut.matchAll(/Expected account \.\.\.([\d ]+): max ([\d\s,]+?) on (\d{4}-\d{2}-\d{2})/g)]
    .map((m) => ({ tail: digits(m[1]), cents: madToCents(m[2]), date: m[3], mad: m[2].trim() }));
  if (expected.length !== 2) throw new Error('could not parse make_fake_statements.py output:\n' + fakeOut);
  // Cross-check the USD values with the Python reference implementation.
  const ref = execFileSync(PY, [path.join(ROOT, 'fbar_cih.py'), pdfDir, '--year', String(YEAR), '--rate', RATE,
    '--out', path.join(WORK, 'python-results')], { encoding: 'utf8' });
  const refUsd = [...ref.matchAll(/^Account (\d+)[\s\S]*?rounded up: \$([\d,]+)/gm)]
    .map((m) => ({ account: m[1], usd: Number(m[2].replace(/,/g, '')) }));

  execFileSync(PY, [path.join(ROOT, 'tests', 'make_edge_case_pdfs.py'), edgeDir]);
  // Duplicates: an identical copy, and a copy with different bytes but the same account and period.
  const original = path.join(pdfDir, '0123_2025-05.pdf');
  fs.copyFileSync(original, path.join(edgeDir, 'copy_of_0123_2025-05.pdf'));
  fs.writeFileSync(path.join(edgeDir, 'downloaded_again_0123_2025-05.pdf'),
    Buffer.concat([fs.readFileSync(original), Buffer.from('\n% downloaded again\n')]));
  execFileSync(PY, [path.join(ROOT, 'tests', 'make_edge_statements.py'), probDir]);

  // ---------------------------------------------------------------- browser
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });
  const external = [];      // anything that is not the page itself (or data:/blob:)
  const allRequests = [];
  const csp = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    const bcdp = await browser.target().createCDPSession();
    await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      allRequests.push(url);
      if (url === pageUrl || url.startsWith('data:') || url.startsWith('blob:')) { req.continue(); return; }
      external.push(url);
      req.abort('blockedbyclient');
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (e) => {
      const url = e.request.url;
      if (url !== pageUrl && !url.startsWith('data:') && !url.startsWith('blob:') && !external.includes(url)) external.push(url);
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push('console: ' + msg.text()); });
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI);
      });
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.setOfflineMode(true); // like turning Wi-Fi off: the page must work the same
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.state === 'ready', { timeout: 20000 });

    console.log('\nStartup');
    const startup = await page.evaluate(() => ({
      year: document.getElementById('year').value,
      rate: document.getElementById('rate').value,
      rateStatus: document.getElementById('rate-status').textContent,
      deadline: document.getElementById('deadline').textContent,
      fatal: !document.getElementById('fatal').hidden,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    }));
    check(!startup.fatal, 'page loaded all its parts');
    check(startup.year === String(YEAR), 'year defaults to ' + YEAR, startup.year);
    check(startup.rate === RATE, 'official rate prefilled (' + RATE + ')', startup.rate);
    check(/Official U\.S\. Treasury rate for Dec 31, 2025/.test(startup.rateStatus), 'rate source is explained', startup.rateStatus);
    check(/October 15, 2026/.test(startup.deadline), 'deadline notice for 2025', startup.deadline);
    check(/connect-src 'none'/.test(startup.csp) && !/unsafe-eval/.test(startup.csp), 'strict CSP without unsafe-eval', startup.csp);

    async function upload(files) {
      const input = await page.$('#file-input');
      await input.uploadFile(...files);
      await page.waitForFunction(() => document.body.dataset.state === 'busy' || document.body.dataset.state === 'done', { timeout: 20000 });
      await page.waitForFunction(() => document.body.dataset.state === 'done' &&
        !document.querySelector('#file-list li[data-status="waiting"], #file-list li[data-status="reading"]'), { timeout: 180000 });
    }
    const cards = () => page.$$eval('article.account', (els) => els.map((e) => ({
      account: e.dataset.account, maxCents: e.dataset.maxCents, maxDate: e.dataset.maxDate, usd: e.dataset.usd,
      problems: Number(e.dataset.problems), text: e.innerText,
      months: Array.from(e.querySelectorAll('tr[data-month]')).map((r) => r.dataset.check),
    })));

    // ---------------------------------------------------------------- happy path (23 statements, Sept missing)
    console.log('\nFake statements (2 accounts, September missing on the second)');
    const t0 = Date.now();
    await upload(pdfsIn(pdfDir));
    console.log(`  (read ${pdfsIn(pdfDir).length} PDFs in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    let got = await cards();
    check(got.length === 2, 'two accounts shown', got.map((c) => c.account));
    let total = 0;
    for (const exp of expected) {
      const card = got.find((c) => c.account.endsWith(exp.tail));
      check(!!card, `account ...${exp.tail} found`);
      if (!card) continue;
      check(Number(card.maxCents) === exp.cents, `account ...${exp.tail}: max ${exp.mad} MAD`, card.maxCents);
      check(card.maxDate === exp.date, `account ...${exp.tail}: reached on ${exp.date}`, card.maxDate);
      check(card.text.includes(exp.mad), `account ...${exp.tail}: max displayed as "${exp.mad}"`);
      const usd = usdCeil(exp.cents, RATE);
      total += usd;
      check(Number(card.usd) === usd, `account ...${exp.tail}: USD ${usd} (rounded up)`, card.usd);
      const py = refUsd.find((r) => r.account.endsWith(exp.tail));
      check(py && py.usd === Number(card.usd), `account ...${exp.tail}: USD matches fbar_cih.py`, py);
      check(card.text.includes('$' + usd.toLocaleString('en-US')), `account ...${exp.tail}: "$${usd.toLocaleString('en-US')}" displayed`);
    }
    const a1 = got.find((c) => c.account.endsWith('000123'));
    const a2 = got.find((c) => c.account.endsWith('000245'));
    check(a1 && a1.problems === 0 && a1.months.every((m) => m === 'ok'), 'account ...0123: no problem, 12 months OK', a1 && a1.months);
    check(a2 && a2.problems >= 1 && /statement for September 2025 is missing/.test(a2.text), 'account ...0245: missing September reported in plain words');
    check(a2 && a2.months[8] === 'missing' && a2.months.filter((m) => m !== 'ok').length === 1, 'account ...0245: month table shows September missing', a2 && a2.months);
    const overall = await page.$eval('[data-testid="overall"]', (e) => ({ problems: e.dataset.problems, text: e.innerText }));
    check(Number(overall.problems) >= 1 && /Do not use these numbers yet/.test(overall.text), 'overall banner says not to use the numbers yet', overall);
    const totalShown = await page.$eval('[data-testid="total-usd"]', (e) => e.textContent);
    check(totalShown === '$' + total.toLocaleString('en-US'), 'total of all accounts shown: $' + total.toLocaleString('en-US'), totalShown);
    const threshold = await page.$eval('[data-testid="threshold"]', (e) => ({ over: e.dataset.over, text: e.innerText }));
    check(threshold.over === 'yes' && /more than \$10,000/.test(threshold.text), 'says the total is over $10,000', threshold);

    // Screenshots of the results (light/dark, desktop/phone).
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      for (const [label, width] of [['desktop', 1280], ['phone', 390]]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: width < 500 ? 2 : 1 });
        await sleep(150);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(overflow <= 0, `${label}/${scheme}: no horizontal page scroll`, overflow);
        const file = path.join(shotDir, `results-${label}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
      }
    }
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

    // CSV downloads.
    console.log('\nDownloads');
    await page.click('#dl-statements');
    const stCsv = await waitForFile(dlDir, `fbar-statements-${YEAR}.csv`);
    check(stCsv && stCsv.replace(/^﻿/, '').startsWith('account,file,period_start,period_end,opening'), 'statements CSV downloaded with the expected columns');
    check(stCsv && stCsv.trim().split(/\r?\n/).length === 1 + 23, 'statements CSV has 23 statements', stCsv && stCsv.trim().split(/\r?\n/).length);
    await page.click('#dl-transactions');
    const txCsv = await waitForFile(dlDir, `fbar-transactions-${YEAR}.csv`);
    check(txCsv && txCsv.replace(/^﻿/, '').startsWith('account,file,page,operation_date,value_date,description,debit,credit,balance_after'), 'transactions CSV downloaded with the expected columns');
    const pyTx = fs.readFileSync(path.join(WORK, 'python-results', 'transactions.csv'), 'utf8').trim().split(/\r?\n/).length;
    check(txCsv && txCsv.trim().split(/\r?\n/).length === pyTx, `transactions CSV has as many lines as fbar_cih.py's (${pyTx})`, txCsv && txCsv.trim().split(/\r?\n/).length);

    // Printable report ("Save a report" -> print window -> Save as PDF).
    console.log('\nReport');
    const reportText = await page.$eval('#report', (e) => e.textContent);
    const e1 = expected.find((x) => x.tail === '000123');
    const usd1 = '$' + usdCeil(e1.cents, RATE).toLocaleString('en-US');
    for (const [what, needle] of [['item 15 label', 'Item 15'], ['USD maximum', usd1], ['MAD maximum', e1.mad],
      ['account number without spaces', '230780000000000000000123'], ['type Bank', 'Item 16 \u2014 Type of accountBank'],
      ['institution', 'CIH Bank'], ['bank address', '187 Avenue Hassan II, Casablanca, Morocco'],
      ['rate and its source', '9.101 MAD per 1 USD \u2014 official U.S. Treasury rate for Dec 31, 2025'],
      ['not-final status', 'NOT FINAL'], ['missing month problem', 'The statement for September 2025 is missing.'],
      ['months covered', 'covering January to December 2025 (all 12 months)']]) {
      check(reportText.includes(needle), 'report shows the ' + what, needle);
    }
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.click('#save-report');
    check((await page.evaluate(() => window.__printed)) === 1, '"Save a report" opens the print window');
    const reportPdf = path.join(shotDir, 'report.pdf');
    await page.pdf({ path: reportPdf, format: 'Letter' });
    check(fs.statSync(reportPdf).size > 1000, 'report prints to PDF (' + reportPdf + ')');

    // Rate changes.
    console.log('\nExchange rate');
    await page.$eval('#rate', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    got = await cards();
    check(got.every((c) => c.usd === '') && (await page.$$('[data-testid="fbar-mad"]')).length === 2, 'without a rate, MAD is shown instead of USD');
    await page.type('#rate', '10,5');
    got = await cards();
    check(got.every((c) => Number(c.usd) === usdCeil(Number(c.maxCents), '10.5')), 'a typed rate with a comma (10,5) is used', got.map((c) => c.usd));
    const rs = await page.$eval('#rate-status', (e) => e.textContent);
    check(/Use the official rate/.test(rs), 'offers to go back to the official rate', rs);
    await page.$eval('#rate-status button', (b) => b.click());
    check((await page.$eval('#rate', (e) => e.value)) === RATE, 'back to the official rate');

    // Another year: statements are not for it, and the page says so.
    console.log('\nYear');
    await page.select('#year', '2024');
    const yearHint = await page.$eval('#results', (e) => e.innerText);
    check(/These statements are not for 2024/.test(yearHint) && /Switch to 2025/.test(yearHint), 'choosing 2024 explains the statements are for 2025');
    check((await page.$eval('#rate', (e) => e.value)) === '10.103', '2024 official rate prefilled');
    check(/past due/.test(await page.$eval('#deadline', (e) => e.textContent)), '2024 deadline shown as past due');
    await page.evaluate(() => Array.from(document.querySelectorAll('#results button')).find((b) => /Switch to 2025/.test(b.textContent)).click());
    check((await page.$eval('#year', (e) => e.value)) === '2025' && (await page.$eval('#rate', (e) => e.value)) === RATE, '"Switch to 2025" restores year and rate');

    // ---------------------------------------------------------------- files that cannot be used
    console.log('\nFiles that cannot be used');
    await page.click('#clear-all');
    check((await page.$$('article.account')).length === 0, '"Remove all files" clears the results');
    await upload([original, ...pdfsIn(edgeDir)]);
    const items = await page.$$eval('#file-list li', (els) => els.map((li) => ({
      name: li.querySelector('.name').textContent, kind: li.dataset.kind, status: li.dataset.status,
      tone: li.dataset.tone, text: li.querySelector('.detail').textContent,
      diag: !!Array.from(li.querySelectorAll('button')).find((b) => /diagnostic/i.test(b.textContent)),
    })));
    const item = (n) => items.find((i) => i.name === n) || {};
    check(item('locked.pdf').kind === 'password' && /password/.test(item('locked.pdf').text), 'password-protected PDF explained', item('locked.pdf'));
    check(item('scanned.pdf').kind === 'scanned' && /scan/.test(item('scanned.pdf').text) && /statement downloaded from your bank.s online banking/.test(item('scanned.pdf').text), 'scanned PDF explained (use the downloaded statement)', item('scanned.pdf'));
    check(item('not_cih.pdf').kind === 'notcih' && /does not look like a bank statement this tool can read/.test(item('not_cih.pdf').text) && item('not_cih.pdf').diag, 'unsupported PDF explained, with a diagnostic button', item('not_cih.pdf'));
    check(item('not_a_pdf.pdf').kind === 'notpdf', 'non-PDF file explained', item('not_a_pdf.pdf'));
    check(item('copy_of_0123_2025-05.pdf').kind === 'duplicate' && /already added/.test(item('copy_of_0123_2025-05.pdf').text), 'identical copy ignored and explained', item('copy_of_0123_2025-05.pdf'));
    check(item('downloaded_again_0123_2025-05.pdf').kind === 'duplicate' && /same account and same period/.test(item('downloaded_again_0123_2025-05.pdf').text), 'same account + period ignored and explained', item('downloaded_again_0123_2025-05.pdf'));
    check(item('0123_2025-05.pdf').tone === 'ok', 'the original statement is used', item('0123_2025-05.pdf'));
    got = await cards();
    check(got.length === 1 && got[0].text.split('\n').some((l) => /^1 statement for 2025/.test(l)), 'duplicates are not counted twice (1 statement)', got.map((c) => c.text.split('\n').slice(0, 3)));
    const banner = await page.$eval('[data-testid="overall"]', (e) => e.innerText);
    check(/4 files could not be used/.test(banner), 'banner counts the 4 unusable files (not the duplicates)', banner);
    const unusable = await page.$$eval('[data-testid="unusable"] li', (els) => els.map((e) => e.innerText));
    check(unusable.length === 4 && unusable.some((t) => /^locked\.pdf: .*password/.test(t)), 'results list the 4 unusable files with their reason', unusable);
    await page.screenshot({ path: path.join(shotDir, 'errors-desktop-light.png'), fullPage: true });

    // Safe diagnostic file for the non-CIH PDF.
    await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll('#file-list li')).find((l) => l.querySelector('.name').textContent === 'not_cih.pdf');
      Array.from(li.querySelectorAll('button')).find((b) => /diagnostic/i.test(b.textContent)).click();
    });
    await sleep(500);
    const diagName = fs.readdirSync(dlDir).find((f) => /^fbar-diagnostic-\d+\.txt$/.test(f));
    const diag = diagName ? await waitForFile(dlDir, diagName) : null;
    check(!!diag, 'diagnostic file downloaded', diagName);
    if (diag) {
      const body = diag.split('\n').filter((l) => /@\d+:/.test(l));
      const texts = body.flatMap((l) => l.split(' | ').map((w) => w.replace(/^[\d.]+-[\d.]+@\d+:/, '')));
      check(body.length > 0 && texts.every((t) => !/[0-8]/.test(t) && !/[A-Za-z]/.test(t.replace(/x/g, ''))), 'diagnostic file text is masked (only x, 9 and punctuation)', texts.slice(0, 8));
      check(!/INVOICE|Example|Supplies|120|2025/.test(texts.join(' ')), 'diagnostic file contains none of the original words or amounts');
      check(!diag.includes('not_cih'), 'diagnostic file does not include the file name');
    }

    // ---------------------------------------------------------------- statements with problems
    console.log('\nStatements with problems (core agent\'s edge cases)');
    await page.click('#clear-all');
    await upload(pdfsIn(probDir));
    got = await cards();
    const tampered = got.find((c) => c.account.endsWith('000489'));
    check(tampered && tampered.problems > 0 && /do not add up|do not match/.test(tampered.text), 'tampered statement flagged in plain words', tampered && tampered.text.slice(0, 400));
    check((await page.$eval('[data-testid="overall"]', (e) => e.innerText)).includes('Do not use these numbers yet'), 'overall banner blocks use');
    await page.screenshot({ path: path.join(shotDir, 'problems-desktop-light.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await sleep(150);
    await page.screenshot({ path: path.join(shotDir, 'problems-phone-dark.png'), fullPage: true });

    // ---------------------------------------------------------------- network / CSP
    console.log('\nPrivacy');
    const violations = await page.evaluate(() => window.__csp || []);
    csp.push(...violations);
    check(external.length === 0, 'no network request at all (only the page itself)', external);
    check(csp.length === 0, 'no Content-Security-Policy violation', csp);
    check(pageErrors.length === 0, 'no JavaScript error', pageErrors);
    console.log(`  (${allRequests.length} request(s) seen in total: ${[...new Set(allRequests.map((u) => u.split(':')[0]))].join(', ')})`);
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots: ${shotDir}`);
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
