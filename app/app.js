/* FBAR Max Balance: user interface.
 *
 * Runs entirely inside this page: no network, no storage, no cookies.
 * Uses window.pdfjsLib (pdf.js), window.FBARExtract (src/extract-pdfjs.js) and
 * window.FBARCore (src/fbar-core.js), all inlined in the same HTML file by build.mjs.
 */
(function () {
  'use strict';

  // ===========================================================================
  //  OFFICIAL EXCHANGE RATES: Moroccan dirhams (MAD) for 1 US dollar.
  //  Source: U.S. Treasury, "Treasury Reporting Rates of Exchange"
  //  (fiscaldata.treasury.gov), country-currency "Morocco-Dirham", rate for December 31.
  //  To add a year, add a line such as   2026: 9.5,
  //  A year that is missing here (or set to null) means the user has to type the rate.
  // ===========================================================================
  const DEFAULT_RATES = {
    2025: 9.101,
    2024: 10.103,
    2023: 9.855,
    2022: 10.48,
    2021: 9.271,
  };
  const RATE_SOURCE = 'fiscaldata.treasury.gov, Treasury Reporting Rates of Exchange';

  // Banks: name for FBAR item 17 (when the statement reader does not give one) and head office
  // address for items 19 to 23. Matched against statement.bank.id / statement.bank.name.
  const BANKS = [
    { match: /cih/i, name: 'CIH Bank', address: '187 Avenue Hassan II, Casablanca, Morocco' },
    { match: /attijari/i, name: 'Attijariwafa bank', address: '2 boulevard Moulay Youssef, Casablanca, Morocco' },
    { match: /bmce|bank of africa|boa/i, name: 'BMCE Bank of Africa', address: '140 avenue Hassan II, Casablanca, Morocco' },
  ];
  const SUPPORTED_BANKS = 'CIH Bank, Attijariwafa Bank and BMCE Bank of Africa';
  const FBAR_THRESHOLD_USD = 10000;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // ---------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);

  /** Tiny DOM builder. Text always goes through textContent (never innerHTML). */
  function h(tag, props) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const v = props[key];
        if (v == null || v === false) continue;
        if (key === 'class') node.className = v;
        else if (key === 'text') node.textContent = v;
        else if (key === 'dataset') Object.assign(node.dataset, v);
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), v);
        else node.setAttribute(key, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach((k) => append(node, k)); return; }
    node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const isIso = (s) => typeof s === 'string' && ISO_RE.test(s);
  function dayNum(iso) {
    const m = ISO_RE.exec(iso);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  }
  function isoOfDay(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function lastDayOfMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
  function niceDate(iso) {
    if (!isIso(iso)) return 'unknown date';
    const m = ISO_RE.exec(iso);
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
  }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function listJoin(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function madText(cents) { return cents == null ? '—' : FBARCore.formatMad(cents) + ' MAD'; }
  function madNum(cents) { return cents == null ? '—' : FBARCore.formatMad(cents); }
  function groupThousands(intString) { return intString.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function usdText(dollars) { return '$' + groupThousands(String(dollars)); }

  function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }
  function prettyAccount(acc) {
    const d = digitsOnly(acc);
    if (d.length === 24) return d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6, 22) + ' ' + d.slice(22);
    return d || '';
  }
  function hasAccountNumber(acc) { return digitsOnly(acc).length >= 10; }

  /** Fast non-cryptographic fingerprint (two FNV-1a variants + length) to spot the same file added twice. */
  function fingerprint(bytes) {
    let a = 0x811c9dc5, b = 0x9e3779b9 ^ bytes.length;
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 16777619);
      b = Math.imul(b ^ bytes[i], 0x5bd1e995);
    }
    return bytes.length + ':' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  }
  function looksLikePdf(bytes) {
    const head = bytes.subarray(0, 1024);
    for (let i = 0; i + 4 < head.length; i++) {
      if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
    }
    return false;
  }
  function readFile(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  function pause() {
    return new Promise((resolve) => {
      let done = false;
      const go = () => { if (!done) { done = true; resolve(); } };
      if (window.requestAnimationFrame) requestAnimationFrame(() => setTimeout(go, 0));
      setTimeout(go, 60);
    });
  }
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  // ---------------------------------------------------------------- state

  const thisYear = new Date().getFullYear();
  const state = {
    year: thisYear - 1,
    rateIsDefault: false,
    files: [],          // entries, in the order they were added
    queue: [],
    busy: false,
    batchTotal: 0,
    batchDone: 0,
    nextId: 1,
    used: [],           // entries whose statement is used in the calculation
    summary: null,
    closedMonths: {},   // account -> true when the user collapsed its month table
    proof: {},          // account -> { query, open: { fileName: true } } for "Check the details yourself"
    reportDetailed: false,
    notice: '',
  };

  // ---------------------------------------------------------------- startup checks

  function startupProblem() {
    const missing = [];
    if (!window.pdfjsLib) missing.push('pdf.js');
    if (!window.pdfjsWorker) missing.push('pdf.js worker');
    if (!window.FBARExtract) missing.push('statement reader');
    if (!window.FBARCore) missing.push('calculation');
    return missing;
  }

  // ---------------------------------------------------------------- step 1: year and rate

  function setupSettings() {
    const sel = $('year');
    const years = new Set();
    for (let y = thisYear - 1; y >= thisYear - 8; y--) years.add(y);
    Object.keys(DEFAULT_RATES).forEach((y) => years.add(+y));
    years.add(state.year);
    Array.from(years).sort((a, b) => b - a).forEach((y) => sel.appendChild(h('option', { value: y, text: y })));
    sel.value = String(state.year);
    sel.addEventListener('change', () => {
      state.year = +sel.value;
      onYearChanged();
    });
    $('rate').addEventListener('input', () => {
      const def = DEFAULT_RATES[state.year];
      state.rateIsDefault = def != null && parseRate($('rate').value) === def;
      updateRateStatus();
      recomputeAndRender();
    });
    prefillRate(true);
    updateYearTexts();
  }

  function setYear(y) {
    const sel = $('year');
    if (!Array.from(sel.options).some((o) => +o.value === y)) {
      sel.appendChild(h('option', { value: y, text: y }));
      Array.from(sel.options).sort((a, b) => +b.value - +a.value).forEach((o) => sel.appendChild(o));
    }
    sel.value = String(y);
    state.year = y;
    onYearChanged();
  }

  function onYearChanged() {
    prefillRate(false);
    updateYearTexts();
    recomputeAndRender();
  }

  function prefillRate(initial) {
    const input = $('rate');
    const def = DEFAULT_RATES[state.year];
    const current = input.value.trim();
    if (initial || state.rateIsDefault || current === '') {
      input.value = def != null ? String(def) : '';
      state.rateIsDefault = def != null;
    }
    updateRateStatus();
  }

  function parseRate(text) {
    const t = String(text || '').trim().replace(/\s+/g, '').replace(',', '.');
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
    const v = Number(t);
    return isFinite(v) && v > 0 ? v : null;
  }
  function currentRate() { return parseRate($('rate').value); }

  function updateRateStatus() {
    const box = $('rate-status');
    const raw = $('rate').value.trim();
    const rate = parseRate(raw);
    const def = DEFAULT_RATES[state.year];
    box.className = 'hint';
    box.textContent = '';
    if (!raw) {
      box.textContent = 'Enter the rate to see the results in US dollars.';
      return;
    }
    if (rate == null) {
      box.classList.add('warn');
      box.textContent = 'This is not a number the page understands. Type only the number, with a dot or a comma for the decimals.';
      return;
    }
    if (def != null && rate === def) {
      box.classList.add('good');
      box.textContent = 'Official U.S. Treasury rate for Dec 31, ' + state.year + ' (' + RATE_SOURCE + '). You can change it if needed.';
      return;
    }
    if (rate < 1) {
      box.classList.add('warn');
      box.textContent = 'This looks like dollars for one dirham. The page needs the opposite: how many dirhams make one US dollar (around 9 to 11 in recent years).';
    } else if (rate < 6 || rate > 14) {
      box.classList.add('warn');
      box.textContent = 'This looks unusual: one US dollar has been worth around 9 to 11 dirhams in recent years. Please double-check.';
    } else {
      box.textContent = 'Rate entered: 1 US dollar = ' + raw + ' dirhams. Make sure it is the rate for December 31, ' + state.year + '.';
    }
    if (def != null) {
      box.appendChild(document.createTextNode(' '));
      box.appendChild(h('button', {
        type: 'button', class: 'btn-link',
        onclick: () => { $('rate').value = String(def); state.rateIsDefault = true; updateRateStatus(); recomputeAndRender(); },
      }, 'Use the official rate (' + def + ')'));
    }
  }

  function updateYearTexts() {
    document.querySelectorAll('.year-label').forEach((n) => { n.textContent = String(state.year); });
    const box = $('deadline');
    const dueIso = (state.year + 1) + '-10-15';
    if (todayIso() <= dueIso) {
      box.className = 'deadline';
      box.textContent = 'The FBAR for ' + state.year + ' is due October 15, ' + (state.year + 1) +
        '. That date already includes the automatic extension; there is no further extension.';
    } else {
      box.className = 'deadline past';
      box.textContent = 'The FBAR for ' + state.year + ' was due October 15, ' + (state.year + 1) +
        ', so it is past due: file it as soon as possible, and choose the late-filing reason in BSA E-Filing.';
    }
  }

  // ---------------------------------------------------------------- step 2: files

  function setupFiles() {
    const input = $('file-input');
    input.addEventListener('change', () => {
      addFiles(Array.from(input.files || []));
      input.value = '';
    });
    $('clear-all').addEventListener('click', () => {
      state.files = [];
      state.queue = [];
      state.notice = '';
      recomputeAndRender();
    });

    // Accept drops anywhere on the page, and never let the browser open a dropped PDF itself
    // (that would replace this page and lose the results).
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      if (!e.dataTransfer) return;
      filesFromDrop(e.dataTransfer).then((files) => {
        if (!files.length) {
          setProgress('No PDF file was found in what you dropped.');
          return;
        }
        addFiles(files);
      });
    });
  }

  /** Files from a drop; folders are opened and their PDFs collected (when the browser allows it). */
  function filesFromDrop(dt) {
    const plain = Array.from(dt.files || []);
    // webkitGetAsEntry must be called during the drop event itself, before anything asynchronous.
    const entries = Array.from(dt.items || []).map((it) =>
      (it.kind === 'file' && typeof it.webkitGetAsEntry === 'function') ? it.webkitGetAsEntry() : null);
    if (!entries.length || !entries.every(Boolean) || !entries.some((en) => en.isDirectory)) {
      return Promise.resolve(plain);
    }
    const out = [];
    const walk = (entry) => {
      if (entry.isFile) {
        if (!/\.pdf$/i.test(entry.name)) return Promise.resolve();
        return new Promise((resolve, reject) => entry.file(resolve, reject)).then((f) => { out.push(f); });
      }
      if (!entry.isDirectory) return Promise.resolve();
      const reader = entry.createReader();
      const readAll = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject))
        .then((batch) => {
          if (!batch.length) return undefined;
          return batch.reduce((p, child) => p.then(() => walk(child)), Promise.resolve()).then(readAll);
        });
      return readAll();
    };
    return entries.reduce((p, en) => p.then(() => walk(en)), Promise.resolve())
      .then(() => out)
      .catch(() => plain.filter((f) => f.size > 0));
  }

  function addFiles(files) {
    if (!files.length) return;
    if (!state.busy && state.queue.length === 0) { state.batchTotal = 0; state.batchDone = 0; }
    state.notice = '';
    for (const file of files) {
      const entry = { id: state.nextId++, file: file, name: file.name || 'file', status: 'waiting' };
      state.files.push(entry);
      state.queue.push(entry);
      state.batchTotal++;
    }
    recomputeAndRender();
    pump();
  }

  function removeEntry(entry) {
    state.files = state.files.filter((e) => e !== entry);
    state.queue = state.queue.filter((e) => e !== entry);
    recomputeAndRender();
  }

  async function pump() {
    if (state.busy) return;
    state.busy = true;
    document.body.dataset.state = 'busy';
    try {
      while (state.queue.length) {
        const entry = state.queue.shift();
        if (state.files.indexOf(entry) === -1) continue;
        entry.status = 'reading';
        setProgress('Reading file ' + (state.batchDone + 1) + ' of ' + state.batchTotal + '…');
        renderFiles();
        await pause();
        try {
          await processFile(entry);
        } catch (err) {
          console.error(err);
          fail(entry, 'error', 'Something unexpected happened while reading this file.', !!entry.pages);
        }
        state.batchDone++;
        recomputeAndRender();
        await pause();
      }
    } finally {
      state.busy = false;
      setProgress('');
      recomputeAndRender();
      document.body.dataset.state = 'done';
    }
  }

  function fail(entry, kind, message, canDiagnose) {
    entry.status = 'failed';
    entry.kind = kind;
    entry.message = message;
    entry.canDiagnose = !!canDiagnose && !!entry.pages;
  }

  async function processFile(entry) {
    let buffer;
    try {
      buffer = await readFile(entry.file);
    } catch (err) {
      return fail(entry, 'unreadable', 'This file could not be opened. If it is on a USB stick or in a cloud folder, copy it to your computer first, then add it again.');
    }
    const bytes = new Uint8Array(buffer);
    entry.hash = fingerprint(bytes);
    if (!looksLikePdf(bytes)) {
      return fail(entry, 'notpdf', 'This is not a PDF file, so it was skipped. Only PDF bank statements can be read.');
    }
    let pages;
    try {
      pages = await FBARExtract.extractPages(window.pdfjsLib, buffer.slice(0));
    } catch (err) {
      const name = (err && err.name) || '';
      const msg = (err && err.message) || '';
      if (name === 'PasswordException' || /password/i.test(msg)) {
        return fail(entry, 'password', 'This PDF is locked with a password, so it cannot be read. Open it with its password, choose Print, then “Save as PDF”, and add that new copy instead.');
      }
      if (name === 'InvalidPDFException' || name === 'FormatError' || /invalid pdf/i.test(msg)) {
        return fail(entry, 'damaged', 'This PDF seems damaged or incomplete. Download the statement again from your bank\u2019s online banking and add the new copy.');
      }
      console.error(err);
      return fail(entry, 'error', ((err && err.userMessage) ? err.userMessage + ' ' : 'This PDF could not be read. ') +
        'Download the statement again from your bank\u2019s online banking and add the new copy.');
    }
    entry.pages = pages;
    const words = (pages || []).reduce((n, p) => n + ((p && p.words) ? p.words.length : 0), 0);
    if (words === 0) {
      return fail(entry, 'scanned', 'This PDF contains no text that can be read: it looks like a scan or a photo of a paper statement. Please use the statement downloaded from your bank\u2019s online banking (the PDF the bank provides), not a scan.');
    }
    let found;
    try {
      found = typeof FBARCore.parseFile === 'function'
        ? FBARCore.parseFile(pages, entry.name)
        : [FBARCore.parseStatement(pages, entry.name)];
    } catch (err) {
      console.error(err);
      return fail(entry, 'crash', 'Something unexpected happened while reading this statement.', true);
    }
    const statements = (Array.isArray(found) ? found : [found]).filter((st) => st &&
      (st.account || st.openDate || st.closeDate || (st.transactions && st.transactions.length)));
    if (!statements.length) {
      return fail(entry, 'notcih', 'This does not look like a bank statement this tool can read (' + SUPPORTED_BANKS + '), so it was set aside. If it really is one, create a safe diagnostic file and send it to the person who made this tool.', true);
    }
    const matched = statements.filter((st) => hasAccountNumber(st.account));
    if (!matched.length) {
      return fail(entry, 'noaccount', 'This looks like a bank statement, but its account number could not be found, so it cannot be matched to an account. Create a safe diagnostic file and send it to the person who made this tool.', true);
    }
    entry.statements = matched;
    entry.unmatched = statements.length - matched.length;
    entry.status = 'done';
    return undefined;
  }

  function setProgress(text) { $('progress').textContent = text; }

  // ---------------------------------------------------------------- calculation

  function recompute() {
    const byHash = new Map();
    const byKey = new Map();
    const usedStmts = [];
    const stmtEntry = new Map();
    for (const e of state.files) {
      e.dupOf = null;
      e.dupKind = null;
      e.dupStatements = [];
      if (!e.hash) continue;
      const same = byHash.get(e.hash);
      if (same) { e.dupOf = same; e.dupKind = 'file'; continue; }
      byHash.set(e.hash, e);
      if (e.status !== 'done') continue;
      const mine = [];
      for (const st of e.statements) {
        if (isIso(st.openDate) && isIso(st.closeDate)) {
          const key = bankOf(st).name + '|' + digitsOnly(st.account) + '|' + st.openDate + '|' + st.closeDate;
          const first = byKey.get(key);
          if (first) { e.dupStatements.push({ stmt: st, of: first }); continue; }
          byKey.set(key, e);
        }
        mine.push(st);
      }
      if (!mine.length) { e.dupOf = e.dupStatements[0].of; e.dupKind = 'period'; continue; }
      mine.forEach((st) => { usedStmts.push(st); stmtEntry.set(st, e); });
    }
    state.usedStmts = usedStmts;
    state.stmtEntry = stmtEntry;
    state.summary = null;
    state.summaryError = false;
    if (usedStmts.length) {
      try {
        state.summary = FBARCore.summarize(usedStmts, state.year);
      } catch (err) {
        console.error(err);
        state.summaryError = true;
      }
    }
  }

  function entryOf(stmt) {
    return state.stmtEntry.get(stmt) || state.files.find((e) => e.status === 'done' && e.name === stmt.fileName) || null;
  }

  /** Bank of a statement or account: { name, address } (CIH when the reader does not say). */
  function bankOf(x) {
    const b = (x && x.bank) || (x && x.statements && x.statements[0] && x.statements[0].bank) || null;
    const key = b ? String((b.id || '') + ' ' + (b.name || '')) : 'cih';
    const known = BANKS.find((k) => k.match.test(key));
    return { name: (b && b.name) || (known ? known.name : 'CIH Bank'), address: known ? known.address : null };
  }

  function conditionalBalance(x) {
    return x.balanceBasis === 'undated-snapshot' ||
      (x.statements || []).some(s => s.balanceBasis === 'undated-snapshot');
  }

  /** "0123_2025-05.pdf", plus the pages when one PDF holds several statements. */
  function fileLabel(st) {
    const e = entryOf(st);
    const multi = e && e.statements && e.statements.length > 1;
    if (multi && st.firstPage) {
      return (st.fileName || 'file') + ', ' + (st.lastPage && st.lastPage !== st.firstPage ? 'pages ' + st.firstPage + '\u2013' + st.lastPage : 'page ' + st.firstPage);
    }
    return st.fileName || 'file';
  }

  function outsideYear(s, year) {
    if (!isIso(s.openDate) || !isIso(s.closeDate)) return false;
    return s.closeDate < year + '-01-01' || s.openDate >= year + '-12-31';
  }

  /** "the September 2025 statement" or "the statement from ... to ..." */
  function statementName(s) {
    if (isIso(s.openDate) && isIso(s.closeDate)) {
      const o = ISO_RE.exec(s.openDate), c = ISO_RE.exec(s.closeDate);
      const openIsMonthEnd = +o[3] === lastDayOfMonth(+o[1], +o[2]);
      const closeIsMonthEnd = +c[3] === lastDayOfMonth(+c[1], +c[2]);
      const nextMonth = new Date(Date.UTC(+o[1], +o[2], 1));
      if (openIsMonthEnd && closeIsMonthEnd && nextMonth.getUTCFullYear() === +c[1] && nextMonth.getUTCMonth() + 1 === +c[2]) {
        return 'the ' + MONTHS[+c[2] - 1] + ' ' + c[1] + ' statement';
      }
      return 'the statement from ' + niceDate(isoOfDay(dayNum(s.openDate) + 1)) + ' to ' + niceDate(s.closeDate);
    }
    return 'the statement “' + (s.fileName || 'unnamed') + '”';
  }
  function shortPeriod(s) {
    const n = statementName(s);
    return n.replace(/^the /, '').replace(/ statement$/, '').replace(/^statement from /, '');
  }
  function capitalize(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

  /** Short plain-language reason for a statement warning from FBARCore.parseStatement
   *  (its messages are already in plain English; this condenses several into one sentence). */
  function explainWarning(w) {
    const raw = String(w);
    const lc = raw.toLowerCase();
    const pm = /\bp(?:age)?\s*(\d+)\s*:/i.exec(raw);
    const where = pm ? ' on page ' + pm[1] : '';
    if (/balance anchor is provisional/.test(lc)) return raw;
    if (/scan/.test(lc)) return 'it contains no readable text (it looks like a scan)';
    if (/table of transactions|header not found/.test(lc)) return 'the list of transactions could not be found in it';
    if (/does not add up|doesn't add up/.test(lc)) return 'the transactions do not add up to the final balance printed by the bank';
    if (/totals (do not|don't) match|totals differ/.test(lc)) return 'the transactions do not match the totals printed at the bottom of the statement';
    if (/amount.*(unreadable|not be read|not read)|unreadable amount/.test(lc)) return 'an amount' + where + ' could not be read';
    if (/date.*(unreadable|not be read|not read)|unreadable date/.test(lc)) return 'a date' + where + ' could not be read';
    if (/not understood/.test(lc)) return 'a line' + where + ' could not be understood and was left out';
    if (/start date|open(ing)? date/.test(lc)) return 'its start date (on the \u201cSOLDE DEPART\u201d line) could not be found';
    if (/end date|clos(e|ing) date/.test(lc)) return 'its end date (on the \u201cNOUVEAU SOLDE\u201d line) could not be found';
    if (/starting balance|missing opening/.test(lc)) return 'its starting balance (\u201cSOLDE DEPART\u201d) could not be found';
    if (/ending balance|missing closing/.test(lc)) return 'its final balance (\u201cNOUVEAU SOLDE\u201d) could not be found';
    return 'this was reported: \u201c' + raw + '\u201d';
  }

  function addDaysIso(iso, n) { return isoOfDay(dayNum(iso) + n); }

  /** The date a transaction's balance counts from: its operation date, kept inside the statement's
   *  period (a line dated Dec 31 on the January statement counts from January 1). */
  function effectiveDate(t, s) {
    if (!isIso(t.opDate)) return null;
    let d = t.opDate;
    if (isIso(s.openDate)) { const first = addDaysIso(s.openDate, 1); if (d < first) d = first; }
    if (isIso(s.closeDate) && d > s.closeDate) d = s.closeDate;
    return d;
  }

  /** Balance at the end of December 31 of the year: { date, balance } or null.
   *  Uses the core's acc.yearEnd when present; otherwise works it out from the statements. */
  function yearEndOf(acc, year) {
    if (acc.yearEnd !== undefined) return acc.yearEnd;
    const dec31 = year + '-12-31';
    const stmts = (acc.statements || []).filter((s) => isIso(s.openDate) && isIso(s.closeDate));
    const covering = stmts.find((s) => s.openDate < dec31 && s.closeDate >= dec31 && s.opening != null);
    if (covering) {
      if (covering.closeDate === dec31 && covering.closing != null) return { date: dec31, balance: covering.closing };
      let bal = covering.opening;
      (covering.transactions || []).forEach((t) => {
        const d = effectiveDate(t, covering);
        if (d && d <= dec31 && t.balanceAfter != null) bal = t.balanceAfter;
      });
      return { date: dec31, balance: bal };
    }
    const next = stmts.find((s) => s.openDate === dec31 && s.opening != null);
    return next ? { date: dec31, balance: next.opening } : null;
  }

  /** Coverage, month table data and plain-language problems for one account. */
  function analyzeAccount(acc, year) {
    const all = (acc.statements || []).slice();
    const dated = all.filter((s) => isIso(s.openDate) && isIso(s.closeDate))
      .sort((a, b) => (a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0));
    const spans = dated.map((s) => [dayNum(s.openDate), dayNum(s.closeDate)]); // covers (open, close]
    const isCovered = (d) => spans.some((sp) => sp[0] < d && d <= sp[1]);

    // Balance events of the year, bucketed by month (same rule as the core: opening balance
    // counts the day after the statement's start date, each transaction on its operation date).
    const events = [];
    for (const s of all) {
      if (s.opening != null && isIso(s.openDate)) {
        const d = isoOfDay(dayNum(s.openDate) + 1);
        if (+d.slice(0, 4) === year) events.push({ date: d, balance: s.opening });
      }
      for (const t of (s.transactions || [])) {
        const d = effectiveDate(t, s);
        if (d && +d.slice(0, 4) === year && t.balanceAfter != null) events.push({ date: d, balance: t.balanceAfter });
      }
    }

    // Breaks between consecutive statements (closing of one != opening of the next).
    const breaks = [];
    for (let i = 1; i < dated.length; i++) {
      const prev = dated[i - 1], next = dated[i];
      if (prev.closing != null && next.opening != null && prev.closeDate === next.openDate && prev.closing !== next.opening) {
        breaks.push({ prev: prev, next: next });
      }
    }

    const months = [];
    for (let m = 1; m <= 12; m++) {
      const first = dayNum(year + '-' + pad2(m) + '-01');
      const last = first + lastDayOfMonth(year, m) - 1;
      const uncovered = [];
      for (let d = first; d <= last; d++) if (!isCovered(d)) uncovered.push(d);
      const inMonth = dated.filter((s) => dayNum(s.openDate) < last && dayNum(s.closeDate) >= first);
      const startStmt = dated.find((s) => dayNum(s.openDate) === first - 1);
      const startPrev = dated.find((s) => dayNum(s.closeDate) === first - 1);
      const endStmt = dated.find((s) => dayNum(s.closeDate) === last);
      const endNext = dated.find((s) => dayNum(s.openDate) === last);
      let high = null;
      for (const ev of events) {
        if (+ev.date.slice(5, 7) === m && (high == null || ev.balance > high)) high = ev.balance;
      }
      let check;
      if (uncovered.length === last - first + 1) check = 'missing';
      else if (uncovered.length) check = 'partial';
      else if (inMonth.some((s) => (s.warnings || []).length)) check = 'problem';
      else if (breaks.some((b) => inMonth.indexOf(b.next) !== -1 && dayNum(b.next.openDate) >= first - 1)) check = 'mismatch';
      else check = 'ok';
      months.push({
        month: m,
        uncovered: uncovered,
        start: startStmt ? startStmt.opening : (startPrev ? startPrev.closing : null),
        end: endStmt ? endStmt.closing : (endNext ? endNext.opening : null),
        high: high,
        check: check,
      });
    }

    const problems = []; // { text, todo, stmts: [] }
    const missing = months.filter((mo) => mo.check === 'missing').map((mo) => mo.month);
    if (missing.length === 12) {
      problems.push({ text: 'There is no statement for ' + year + ' for this account.', todo: 'Add the statements of ' + year + ' (or choose another year in step 1).' });
    } else {
      // Group consecutive missing months.
      const groups = [];
      for (const m of missing) {
        const g = groups[groups.length - 1];
        if (g && g[1] === m - 1) g[1] = m; else groups.push([m, m]);
      }
      for (const g of groups) {
        if (g[0] === g[1]) {
          problems.push({ text: 'The statement for ' + MONTHS[g[0] - 1] + ' ' + year + ' is missing.', todo: 'Add it, otherwise the maximum may be wrong.' });
        } else {
          problems.push({ text: 'The statements from ' + MONTHS[g[0] - 1] + ' to ' + MONTHS[g[1] - 1] + ' ' + year + ' are missing (' + (g[1] - g[0] + 1) + ' months).', todo: 'Add them, otherwise the maximum may be wrong.' });
        }
      }
    }
    for (const mo of months) {
      if (mo.check !== 'partial') continue;
      const a = isoOfDay(mo.uncovered[0]), b = isoOfDay(mo.uncovered[mo.uncovered.length - 1]);
      const range = a === b ? MONTHS[mo.month - 1] + ' ' + (+a.slice(8)) : MONTHS[mo.month - 1] + ' ' + (+a.slice(8)) + ' to ' + (+b.slice(8));
      problems.push({ text: 'Part of ' + MONTHS[mo.month - 1] + ' ' + year + ' (' + range + ') is not covered by any statement.', todo: 'A statement is probably missing: add it, otherwise the maximum may be wrong.' });
    }
    for (const b of breaks) {
      if (outsideYear(b.next, year) && outsideYear(b.prev, year)) continue;
      problems.push({
        text: capitalize(statementName(b.next)) + ' starts at ' + madText(b.next.opening) + ', but ' + statementName(b.prev) + ' ended at ' + madText(b.prev.closing) + '. These should be the same.',
        todo: 'A statement may be missing in between, or one of them was misread. If none is missing, create a safe diagnostic file for both and send them to the person who made this tool.',
        stmts: [b.prev, b.next],
      });
    }
    for (const s of all) {
      if (outsideYear(s, year)) continue;
      const ws = s.warnings || [];
      if (!ws.length) continue;
      const reasons = [];
      ws.forEach((w) => { const r = explainWarning(w); if (reasons.indexOf(r) === -1) reasons.push(r); });
      const misread = reasons.some((r) => /add up|match the totals/.test(r));
      problems.push({
        text: capitalize(statementName(s)) + ' (' + (s.fileName || 'file') + ') was read, but ' + listJoin(reasons) + '.' +
          (misread ? ' Something was probably misread.' : ''),
        todo: 'Check that it is the PDF downloaded from your bank\u2019s online banking. If it is, create a safe diagnostic file for it and send it to the person who made this tool.',
        stmts: [s],
      });
    }
    if (!hasAccountNumber(acc.account)) {
      problems.push({ text: 'The account number could not be found on these statements.', todo: 'Create a safe diagnostic file for one of them and send it to the person who made this tool.', stmts: all.slice(0, 1) });
    }
    if (!acc.max) {
      problems.push({ text: 'No balance was found for ' + year + ' in these statements.', todo: 'Check that the statements are for ' + year + '.' });
    }
    const coreIssues = (acc.issues || []).map(String);
    if (coreIssues.length && !problems.length) {
      problems.push({ text: 'The tool found a problem it cannot explain in simple words (see “technical details” below).', todo: 'Send a safe diagnostic file of the statements of this account to the person who made this tool.', stmts: all });
    }

    const inYear = all.filter((s) => !outsideYear(s, year));
    const fullMonths = months.filter((mo) => mo.check !== 'missing' && mo.check !== 'partial').map((mo) => mo.month);
    return { months: months, problems: problems, coreIssues: coreIssues, inYear: inYear, otherYears: all.length - inYear.length, fullMonths: fullMonths };
  }

  function monthRanges(list) {
    const groups = [];
    for (const m of list) {
      const g = groups[groups.length - 1];
      if (g && g[1] === m - 1) g[1] = m; else groups.push([m, m]);
    }
    return groups.map((g) => (g[0] === g[1] ? MONTHS[g[0] - 1] : MONTHS[g[0] - 1] + ' to ' + MONTHS[g[1] - 1]));
  }

  // ---------------------------------------------------------------- rendering

  function recomputeAndRender() {
    recompute();
    renderFiles();
    renderResults();
  }

  function fileView(e) {
    if (e.status === 'waiting') return { tone: 'info', text: 'Waiting\u2026' };
    if (e.status === 'reading') return { tone: 'busy', text: 'Reading\u2026' };
    if (e.dupKind === 'file') return { tone: 'info', text: 'This exact file was already added (\u201c' + e.dupOf.name + '\u201d), so this copy is ignored.' };
    if (e.status === 'failed') return { tone: 'bad', text: e.message, diag: e.canDiagnose };
    const sts = e.statements;
    const accts = [];
    sts.forEach((st) => { const d = digitsOnly(st.account).slice(-4); if (accts.indexOf(d) === -1) accts.push(d); });
    const who = bankOf(sts[0]).name + ' \u00b7 account' + (accts.length > 1 ? 's' : '') + ' ending ' + listJoin(accts);
    const period = sts.length === 1 ? shortPeriod(sts[0]) : plural(sts.length, 'statement');
    if (e.dupKind === 'period') {
      return { tone: 'info', text: who + ' \u00b7 ' + period + ' \u00b7 already added (same account and same period as \u201c' + e.dupOf.name + '\u201d), so this copy is ignored.' };
    }
    const notes = [];
    if (e.dupStatements.length) notes.push(plural(e.dupStatements.length, 'statement') + ' already added from another file, ignored');
    const outside = sts.filter((st) => outsideYear(st, state.year)).length;
    if (outside === sts.length) {
      return { tone: 'info', text: who + ' \u00b7 ' + period + ' \u00b7 not part of ' + state.year + ', so it is not used for that year.' };
    }
    if (outside) notes.push(outside + ' not part of ' + state.year);
    if (e.unmatched) {
      return { tone: 'warn', diag: true, text: who + ' \u00b7 ' + period + ' \u00b7 ' + plural(e.unmatched, 'statement') + ' in this file could not be matched to an account (see the results below).' };
    }
    if (sts.some((st) => (st.warnings || []).length)) {
      return { tone: 'warn', diag: true, text: who + ' \u00b7 ' + period + ' \u00b7 read, but with a problem (see the results below).' };
    }
    const n = sts.reduce((k, st) => k + (st.transactions || []).length, 0);
    return { tone: 'ok', text: who + ' \u00b7 ' + period + ' \u00b7 ' + plural(n, 'transaction') + (notes.length ? ' (' + notes.join('; ') + ')' : '') };
  }

  function diagnosticButton(entry, label) {
    return h('button', {
      type: 'button', class: 'btn btn-secondary btn-small',
      title: 'Saves a text file that shows only the layout of this statement: letters become x and digits become 9. No names, numbers or amounts.',
      onclick: () => downloadDiagnostic(entry),
    }, label || 'Create a safe diagnostic file');
  }

  function fileItem(e) {
    const v = fileView(e);
    return h('li', { dataset: { status: e.status, tone: v.tone, kind: e.kind || (e.dupKind ? 'duplicate' : '') } },
      h('span', { class: 'dot ' + v.tone, 'aria-hidden': 'true' }),
      h('span', { class: 'name' }, e.name),
      h('span', { class: 'actions' },
        v.diag ? diagnosticButton(e) : null,
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', 'aria-label': 'Remove ' + e.name, onclick: () => removeEntry(e) }, 'Remove')),
      h('span', { class: 'detail' + (v.tone === 'bad' ? ' bad' : v.tone === 'warn' ? ' warn' : '') }, v.text));
  }

  function renderFiles() {
    const box = $('file-list');
    const area = $('file-area');
    box.textContent = '';
    area.hidden = state.files.length === 0;
    const sorted = state.files.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id - b.id);
    // Files that need a look are always listed; the ones read correctly are folded away.
    const fine = sorted.filter((e) => fileView(e).tone === 'ok');
    const others = sorted.filter((e) => fileView(e).tone !== 'ok');
    if (others.length) box.appendChild(h('ul', { class: 'files' }, others.map(fileItem)));
    if (fine.length) {
      const det = h('details', { class: 'ok-files' },
        h('summary', null, plural(fine.length, 'statement') + ' read correctly' + (state.showOkFiles ? '' : ' (show the list)')),
        h('ul', { class: 'files' }, fine.map(fileItem)));
      det.open = !!state.showOkFiles;
      det.addEventListener('toggle', () => {
        state.showOkFiles = det.open;
        det.querySelector('summary').textContent = plural(fine.length, 'statement') + ' read correctly' + (det.open ? '' : ' (show the list)');
      });
      box.appendChild(det);
    }
    $('files-title').textContent = 'Your files (' + state.files.length + ')';
    const anyDiag = sorted.some((e) => fileView(e).diag);
    let note = $('diag-note');
    if (anyDiag) {
      if (!note) {
        note = h('p', { id: 'diag-note', class: 'hint' },
          'A \u201csafe diagnostic file\u201d shows only the layout of a statement: every letter becomes x and every digit becomes 9, so it contains no names, no account numbers and no amounts. You can send it to the person who made this tool so they can fix the problem.');
        area.appendChild(note);
      }
    } else if (note) {
      note.remove();
    }
  }

  function renderResults() {
    const root = $('results');
    const frag = document.createDocumentFragment();
    const summary = state.summary;
    const year = state.year;
    const rate = currentRate();
    const failed = state.files.filter((e) => e.status === 'failed' && !e.dupKind);
    const pending = state.files.filter((e) => e.status === 'waiting' || e.status === 'reading').length;
    $('downloads').hidden = state.usedStmts.length === 0;

    if (!state.files.length || !summary) renderReport([], [], null, 0);
    if (!state.files.length) {
      frag.appendChild(h('p', { class: 'empty' }, 'Results will appear here once you add your statements.'));
      root.textContent = '';
      root.appendChild(frag);
      return;
    }
    if (state.summaryError) {
      frag.appendChild(h('div', { class: 'banner bad', role: 'alert' },
        h('h3', null, 'Something went wrong while calculating'),
        h('p', null, 'The statements were read, but the calculation failed. Please send a safe diagnostic file of each statement (buttons in step 2) to the person who made this tool.')));
    }
    if (!summary) {
      if (pending) frag.appendChild(h('p', { class: 'empty' }, 'Reading your statements…'));
      else if (!state.summaryError) {
        frag.appendChild(h('div', { class: 'banner bad' },
          h('h3', null, 'No statement could be used'),
          h('p', null, 'None of the files could be used. The reason is shown next to each file in step 2.')));
      }
      root.textContent = '';
      root.appendChild(frag);
      return;
    }

    const accounts = (summary.accounts || []).map((acc) => ({ acc: acc, info: analyzeAccount(acc, year) }));
    const problemCount = accounts.reduce((n, a) => n + a.info.problems.length, 0) + failed.length;

    // Overall status banner.
    if (pending) {
      frag.appendChild(h('p', { class: 'progress' }, 'Still reading ' + plural(pending, 'file') + '… the results below will update.'));
    } else if (problemCount) {
      const items = [];
      if (failed.length) {
        items.push(h('li', null, plural(failed.length, 'file') + ' could not be used (listed below, with the reason). If ' + (failed.length === 1 ? 'it is a bank statement' : 'they are bank statements') + ' for ' + year + ', fix that first. If a file does not belong here, remove it from the list.'));
      }
      const acctProblems = problemCount - failed.length;
      if (acctProblems) items.push(h('li', null, plural(acctProblems, 'problem') + ' with the accounts, explained in red below.'));
      frag.appendChild(h('div', { class: 'banner bad', role: 'alert', 'data-testid': 'overall', dataset: { problems: problemCount } },
        h('h3', null, 'Do not use these numbers yet'),
        h('p', null, 'Something needs your attention first; until it is fixed, a maximum below may be wrong:'),
        h('ul', null, items)));
    } else {
      frag.appendChild(h('div', { class: 'banner ok', 'data-testid': 'overall', dataset: { problems: 0 } },
        h('h3', null, 'Everything checks out'),
        h('p', null, 'Every statement adds up, and all 12 months of ' + year + ' are covered for ' + (accounts.length === 1 ? 'the account' : 'each account') + '.' +
          (rate ? '' : ' Enter the exchange rate in step 1 to get the numbers in US dollars.'))));
    }

    if (failed.length) {
      frag.appendChild(h('div', { class: 'problems unusable', 'data-testid': 'unusable' },
        h('h4', null, 'Files that could not be used (' + failed.length + ')'),
        h('ul', null, failed.map((e) => h('li', null,
          h('strong', null, e.name), ': ', e.message,
          h('div', { class: 'btn-row' },
            e.canDiagnose ? diagnosticButton(e) : null,
            h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => removeEntry(e) }, 'Remove from the list')))))));
    }

    // Hint when the statements are for another year.
    const inChosen = state.usedStmts.some((st) => !outsideYear(st, year));
    const best = (!inChosen && typeof FBARCore.guessYear === 'function') ? FBARCore.guessYear(state.usedStmts) : null;
    if (best && best !== year) {
      frag.appendChild(h('div', { class: 'banner warn' },
        h('h3', null, 'These statements are not for ' + year),
        h('p', null, 'Most of your statements are for ' + best + '. ',
          h('button', { type: 'button', class: 'btn-link', onclick: () => { setYear(+best); } }, 'Switch to ' + best))));
    }

    // Summary of all accounts + FBAR threshold.
    if (accounts.length) {
      let total = 0;
      const rows = accounts.map((a) => {
        const max = a.acc.max;
        const usd = (max && rate) ? FBARCore.toUsd(max.balance, rate) : null;
        if (usd != null) total += usd;
        const ye = yearEndOf(a.acc, year);
        const digits = digitsOnly(a.acc.account);
        return h('tr', { dataset: { account: digits } },
          h('td', null,
            h('span', { class: 'rib hide-narrow' }, prettyAccount(a.acc.account) || 'Unknown account'),
            h('span', { class: 'rib show-narrow' }, digits ? '\u2026' + digits.slice(-6) : 'Unknown'),
            a.info.problems.length ? h('span', { class: 'badge bad badge-inline' }, 'not final') : null),
          h('td', { class: 'num', 'data-col': 'max-mad' }, max ? madNum(max.balance) : '\u2014'),
          h('td', { class: 'num', 'data-col': 'max-usd' }, usd != null ? usdText(usd) : '\u2014'),
          h('td', { class: 'num', 'data-col': 'dec31-mad' }, ye ? madNum(ye.balance) : '\u2014'));
      });
      const table = h('table', { class: 'summary-table', 'data-testid': 'summary' },
        h('thead', null, h('tr', null,
          h('th', null, 'Account'), h('th', { class: 'num' }, 'Highest (MAD)'), h('th', { class: 'num' }, 'Highest (USD)'),
          h('th', { class: 'num' }, 'Balance on Dec 31 (MAD)'))),
        h('tbody', null, rows),
        (rate && accounts.length > 1) ? h('tfoot', null, h('tr', null,
          h('td', { colspan: 2 }, 'All accounts added together'), h('td', { class: 'num', 'data-testid': 'total-usd' }, usdText(total)), h('td'))) : null);
      frag.appendChild(h('div', { class: 'table-scroll' }, table));
      if (rate) {
        const over = total > FBAR_THRESHOLD_USD;
        const what = accounts.length > 1 ? 'Added together, the maximums of these accounts come to ' : 'The maximum of this account is ';
        frag.appendChild(h('p', { class: 'total-line', 'data-testid': 'threshold', dataset: { over: over ? 'yes' : 'no' } },
          what, h('strong', null, usdText(total)), '. ',
          over
            ? 'That is more than $10,000, so an FBAR is required for ' + year + ', and every foreign account must be listed on it, including small ones and any accounts not listed here.'
            : 'That is not more than $10,000. If you have other foreign accounts (not listed here), add their maximums too: an FBAR is required only if the total is more than $10,000.'));
      } else {
        frag.appendChild(h('p', { class: 'hint' }, 'Enter the exchange rate in step 1 to see these numbers in US dollars.'));
      }
    }

    accounts.forEach((a) => frag.appendChild(renderAccount(a.acc, a.info, year, rate)));
    renderReport(accounts, failed, rate, problemCount);

    root.textContent = '';
    root.appendChild(frag);
  }

  function coveredText(info, year) {
    return info.fullMonths.length === 12
      ? 'January to December ' + year + ' (all 12 months)'
      : (info.fullMonths.length ? listJoin(monthRanges(info.fullMonths)) + ' ' + year : 'no month of ' + year);
  }

  /** "1 908 253,51 MAD ÷ 9.101 dirhams per dollar = $209,675.14" (cents cut, not rounded, for display). */
  function conversionText(cents, rate) {
    const exactCents = Math.floor(cents / rate);
    return madText(cents) + ' \u00f7 ' + String(rate) + ' dirhams per dollar = $' +
      groupThousands(String(Math.floor(exactCents / 100))) + '.' + pad2(exactCents % 100);
  }

  function statementOfMax(acc) {
    const max = acc.max;
    if (!max) return null;
    const same = (acc.statements || []).filter((st) => !max.fileName || st.fileName === max.fileName);
    return same.find((st) => isIso(st.openDate) && isIso(st.closeDate) && st.openDate < max.date && max.date <= st.closeDate) || same[0] || null;
  }

  function isOpeningLabel(label) { return /^starting balance \(/i.test(String(label || '')); }

  function peakMonthOf(max, year) {
    return max && isIso(max.date) && +max.date.slice(0, 4) === year ? +max.date.slice(5, 7) : null;
  }

  const CHECK_TEXT = { ok: 'OK', missing: 'Missing', partial: 'Part missing', problem: 'Problem', mismatch: 'Mismatch' };

  function monthTable(info, year, peakMonth) {
    return h('table', { class: 'month-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, String(year)),
        h('th', { scope: 'col', class: 'hide-narrow' }, 'Start of month'),
        h('th', { scope: 'col' }, 'End of month'),
        h('th', { scope: 'col' }, 'Highest in month'),
        h('th', { scope: 'col' }, 'Check'))),
      h('tbody', null, info.months.map((mo) => h('tr', {
        class: (mo.check === 'missing' ? 'missing' : '') + (mo.month === peakMonth ? ' is-peak' : ''),
        dataset: { month: mo.month, check: mo.check },
      },
        h('td', null, MONTHS_SHORT[mo.month - 1]),
        h('td', { class: 'hide-narrow' }, madNum(mo.start)),
        h('td', null, madNum(mo.end)),
        h('td', null, madNum(mo.high), mo.month === peakMonth ? h('span', { class: 'peak-mark', title: 'Highest of the year' }, '\u2605') : null),
        h('td', null, h('span', { class: 'check ' + (mo.check === 'ok' ? 'ok' : 'bad') }, CHECK_TEXT[mo.check]))))));
  }

  function renderAccount(acc, info, year, rate) {
    const max = acc.max;
    const hasProblems = info.problems.length > 0;
    const usd = (max && rate) ? FBARCore.toUsd(max.balance, rate) : null;
    const acctDigits = digitsOnly(acc.account);
    const card = h('article', {
      class: 'card account' + (hasProblems ? ' has-problems' : ''),
      dataset: {
        account: acctDigits, problems: info.problems.length,
        maxCents: max ? max.balance : '', maxDate: max ? max.date : '', usd: usd != null ? usd : '',
      },
    });

    card.appendChild(h('div', { class: 'account-head' },
      h('h3', null, 'Account ', h('span', { class: 'rib' }, prettyAccount(acc.account) || '(number not found)')),
      hasProblems
        ? h('span', { class: 'badge bad' }, plural(info.problems.length, 'problem') + ': not final')
        : h('span', { class: 'badge ok' }, 'Checked: ready to use')));

    card.appendChild(h('p', { class: 'facts' },
      plural(info.inYear.length, 'statement') + ' for ' + year + ' \u00b7 covers ' + coveredText(info, year) +
      (info.otherYears ? ' · ' + plural(info.otherYears, 'statement') + ' from another year (not used)' : '')));

    if (hasProblems) {
      card.appendChild(h('div', { class: 'problems', role: 'alert' },
        h('h4', null, 'Fix ' + (info.problems.length === 1 ? 'this' : 'these') + ' before using the number below'),
        h('ul', null, info.problems.map((p) => {
          const entries = (p.stmts || []).map(entryOf).filter((e, i, all) => e && all.indexOf(e) === i);
          return h('li', null, p.text,
            p.todo ? h('span', { class: 'todo' }, p.todo) : null,
            entries.length ? h('div', { class: 'btn-row' }, entries.map((e) =>
              diagnosticButton(e, entries.length > 1 ? 'Safe diagnostic file: ' + e.name : 'Create a safe diagnostic file'))) : null);
        }))));
    }

    // The number for the form: dirhams and dollars side by side, equally prominent.
    const box = h('div', { class: 'fbar-number' + (hasProblems ? ' not-final' : ''), 'data-testid': 'fbar-number' });
    box.appendChild(h('p', { class: 'label' }, 'Maximum value of this account in ' + year + ' (FBAR form, item 15)',
      hasProblems ? h('span', { class: 'not-final-tag' }, 'not final') : null));
    if (!max) {
      box.appendChild(h('p', { class: 'value' }, '\u2014'));
      box.appendChild(h('p', { class: 'how' }, 'No balance found for ' + year + '.'));
    } else {
      box.appendChild(h('div', { class: 'values' },
        h('div', { class: 'v' },
          h('span', { class: 'v-label' }, 'In dirhams, as on your statements'),
          h('span', { class: 'value', 'data-testid': 'fbar-mad' }, madNum(max.balance), h('span', { class: 'cur' }, 'MAD'))),
        h('div', { class: 'v' },
          h('span', { class: 'v-label' }, 'In US dollars, for the form'),
          usd != null
            ? h('span', { class: 'value', 'data-testid': 'usd' }, usdText(usd))
            : h('span', { class: 'value pending' }, 'enter the rate in step 1'))));
      if (usd != null) {
        box.appendChild(h('p', { class: 'how' }, max.balance > 0
          ? conversionText(max.balance, rate) + ', rounded up to the next whole dollar.'
          : 'The balance never went above zero during ' + year + ', so the value to enter is $0.'));
      } else {
        box.appendChild(h('p', { class: 'how' }, 'The form asks for US dollars: enter the exchange rate in step 1.'));
      }
      box.appendChild(h('button', { type: 'button', class: 'btn-link show-max', onclick: () => showMaxRow(acctDigits) },
        'Show me where this comes from'));
    }
    card.appendChild(box);

    if (max) {
      const maxStmt = statementOfMax(acc);
      card.appendChild(h('dl', { class: 'peak' },
        h('dt', null, 'Highest balance'), h('dd', { 'data-testid': 'max-mad' }, madText(max.balance)),
        h('dt', null, 'Reached on'), h('dd', null, niceDate(max.date)),
        h('dt', null, isOpeningLabel(max.label) ? 'What' : 'After this transaction'),
        h('dd', null, isOpeningLabel(max.label) ? 'The starting balance of the statement (carried over from the month before)' : (max.label || '\u2014')),
        maxStmt ? h('dt', null, 'Found in') : null,
        maxStmt ? h('dd', null, capitalize(statementName(maxStmt)) + ' (' + maxStmt.fileName + ')') : null,
        h('dt', null, 'Account number for the form (item 18)'), h('dd', null,
          acctDigits ? h('span', { class: 'acct-plain' }, acctDigits) : '(not found)',
          acctDigits ? h('span', { class: 'muted small' }, ' (without spaces)') : null)));
    }

    const ye = yearEndOf(acc, year);
    const yeUsd = (ye && rate) ? FBARCore.toUsd(ye.balance, rate) : null;
    card.dataset.yearEndCents = ye ? ye.balance : '';
    card.appendChild(h('div', { class: 'year-end', 'data-testid': 'year-end' },
      h('p', null, h('span', { class: 'muted' }, 'Balance on December 31, ' + year + ': '),
        ye ? h('strong', null, madText(ye.balance)) : h('strong', null, 'not available'),
        ye && yeUsd != null ? ' (= ' + usdText(yeUsd) + ' at the same rate)' : '',
        ye ? '' : ' (no statement covers December 31, ' + year + ')'),
      h('p', { class: 'hint' }, 'Your tax preparer may ask for this (for example for Form 8938).')));

    // Month by month.
    const peakMonth = peakMonthOf(max, year);
    const table = monthTable(info, year, peakMonth);
    const details = h('details', { class: 'months' },
      h('summary', null, 'Month by month (amounts in MAD)'),
      h('div', { class: 'table-scroll' }, table),
      peakMonth ? h('p', { class: 'hint' }, '★ marks the month with the highest balance of the year.') : null);
    if (!state.closedMonths[acc.account]) details.open = true;
    details.addEventListener('toggle', () => { state.closedMonths[acc.account] = !details.open; });
    card.appendChild(details);

    card.appendChild(renderProof(acc, info, year));

    if (info.coreIssues.length) {
      card.appendChild(h('details', { class: 'tech' },
        h('summary', null, 'Technical details'),
        h('p', { class: 'muted small' }, 'The checks exactly as the calculation reported them (these may include amounts from your statements).'),
        h('ul', null, info.coreIssues.map((t) => h('li', null, t)))));
    }
    return card;
  }

  // ---------------------------------------------------------------- proofreading ("Check the details yourself")

  /** 'YYYY-MM-DD' -> '15/01/2025', the way the bank writes dates. */
  function bankDate(iso) {
    if (!isIso(iso)) return '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }
  /** A balance as printed on the statement: negative balances are printed in the DEBIT column. */
  function bankBalance(cents) {
    if (cents == null) return 'not found';
    return cents < 0 ? FBARCore.formatMad(-cents) + ' (débit)' : FBARCore.formatMad(cents);
  }
  function normalizeText(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** "1 234,56", "1234,56", "1.234,56", "1234.56" -> { cents }; "1234" -> { whole }; anything else -> null. */
  function parseAmountQuery(q) {
    let t = String(q || '').replace(/[\s  ]/g, '').replace(/^[-+]/, '').replace(/(mad|dhs?|dirhams?)$/i, '');
    if (!/^\d[\d.,]*$/.test(t)) return null;
    const last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
    const decimals = last >= 0 ? t.length - last - 1 : 0;
    if (last >= 0 && decimals >= 1 && decimals <= 2) {
      const whole = t.slice(0, last).replace(/[.,]/g, '') || '0';
      return { cents: Number(whole) * 100 + Number(t.slice(last + 1).padEnd(2, '0')) };
    }
    if (last === t.length - 1) t = t.slice(0, -1);          // "1234," -> 1234
    return { whole: Number(t.replace(/[.,]/g, '')) };
  }

  /** Lines of one statement, as shown in the breakdown: starting balance, every transaction, final balance. */
  function statementRows(s) {
    const rows = [];
    rows.push({ kind: 'opening', date: isIso(s.openDate) ? addDaysIso(s.openDate, 1) : null, shownDate: s.openDate,
      balance: s.opening, page: s.firstPage || 1, stmt: s });
    (s.transactions || []).forEach((t) => {
      const d = effectiveDate(t, s);
      rows.push({ kind: 'tx', t: t, date: d, shownDate: t.opDate, balance: t.balanceAfter,
        page: (typeof t.page === 'number' && t.page > 0) ? t.page : null, early: !!(d && t.opDate < d), stmt: s });
    });
    rows.push({ kind: 'closing', date: s.closeDate, shownDate: s.closeDate, balance: s.closing, stmt: s, page: s.lastPage || null });
    return rows;
  }

  /** Finds the row that produced the year's maximum and the highest row of each month (first one wins, like the core). */
  function markRows(acc, stmtRows, year) {
    const monthHigh = {};
    let maxRow = null, fallback = null;
    const max = acc.max;
    stmtRows.forEach((rows) => rows.forEach((r) => {
      if (r.kind === 'closing' || r.balance == null || !r.date || +r.date.slice(0, 4) !== year) return;
      const m = +r.date.slice(5, 7);
      if (!monthHigh[m] || r.balance > monthHigh[m].balance) monthHigh[m] = r;
      if (max && r.balance === max.balance && (!max.fileName || r.stmt.fileName === max.fileName)) {
        if (!maxRow && r.date === max.date) maxRow = r;
        if (!fallback) fallback = r;
      }
    }));
    return { maxRow: maxRow || fallback, monthHigh: monthHigh };
  }

  /** The four figures printed on the statement, each checked against what the transactions add up to. */
  function statementFigures(s, prev) {
    let debits = 0, credits = 0;
    (s.transactions || []).forEach((t) => { debits += t.debit || 0; credits += t.credit || 0; });
    const computedClosing = s.opening != null ? s.opening + credits - debits : null;
    const check = (computed, printed, what) => {
      if (printed == null) return { ok: false, short: 'not found', text: 'This line was not found on the statement.' };
      if (computed == null) return null;
      if (computed === printed) return { ok: true, short: '', text: what + ' ' + FBARCore.formatMad(computed) + ': matches.' };
      return { ok: false, short: 'difference ' + FBARCore.formatMad(Math.abs(computed - printed)),
        text: what + ' ' + FBARCore.formatMad(computed) + ', the statement says ' + FBARCore.formatMad(printed) + '.' };
    };
    return [
      { key: 'opening', label: conditionalBalance(s) ? 'Derived opening (unconfirmed)' : 'Solde départ', value: s.opening, balance: true,
        check: prev && prev.closing != null ? check(prev.closing, s.opening, 'The previous statement ended at') : null },
      { key: 'debit', label: 'Total débit', value: s.totalDebit, check: check(debits, s.totalDebit, 'The debits read add up to') },
      { key: 'credit', label: 'Total crédit', value: s.totalCredit, check: check(credits, s.totalCredit, 'The credits read add up to') },
      { key: 'closing', label: conditionalBalance(s) ? 'Undated SOLDE REEL' : 'Nouveau solde', value: s.closing, balance: true,
        check: conditionalBalance(s) ? null : check(computedClosing, s.closing, 'Starting balance + credits − debits gives') },
    ];
  }

  function figureNodes(figs) {
    return figs.map((f) => h('span', { class: 'fig', dataset: { fig: f.key, cents: f.value == null ? '' : f.value, ok: f.check ? (f.check.ok ? 'yes' : 'no') : '' } },
      h('span', { class: 'fig-label' }, f.label),
      h('span', { class: 'fig-value' }, f.value == null ? 'not found' : (f.balance ? bankBalance(f.value) : FBARCore.formatMad(f.value))),
      f.check ? h('span', { class: 'mark ' + (f.check.ok ? 'ok' : 'bad'), title: f.check.text },
        f.check.ok ? '✓' : '✗ ' + f.check.short,
        h('span', { class: 'visually-hidden' }, ' ' + f.check.text)) : null));
  }

  /** Table of every line of one statement. forPrint: no ids, compact. */
  function txTable(rows, marks, year, acctDigits, forPrint) {
    const cell = (cents) => (cents ? FBARCore.formatMad(cents) : '');
    return h('table', { class: 'tx-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Value date'), h('th', { scope: 'col', class: 'label-col' }, 'Label'),
        h('th', { scope: 'col', class: 'num' }, 'Debit (MAD)'), h('th', { scope: 'col', class: 'num' }, 'Credit (MAD)'),
        h('th', { scope: 'col', class: 'num' }, 'Balance after (MAD)'), h('th', { scope: 'col' }, 'Page'))),
      h('tbody', null, rows.map((r) => {
        const isMax = r === marks.maxRow;
        const monthHigh = r.date && marks.monthHigh[+r.date.slice(5, 7)] === r && +r.date.slice(0, 4) === year;
        const t = r.t || {};
        const label = r.kind === 'opening'
          ? (conditionalBalance(r.stmt) ? 'DERIVED OPENING (unconfirmed)' : 'SOLDE DEPART (starting balance)')
          : r.kind === 'closing'
            ? (conditionalBalance(r.stmt) ? 'ASSUMED CLOSING (undated online balance)' : 'NOUVEAU SOLDE (final balance printed by the bank)')
            : (t.description || '');
        const search = normalizeText([label, bankDate(r.shownDate), bankDate(t.valueDate)].join(' '));
        return h('tr', {
          class: 'row-' + r.kind + (isMax ? ' is-max' : '') + (monthHigh ? ' month-high' : ''),
          id: isMax && !forPrint ? 'max-row-' + acctDigits : null,
          tabindex: isMax && !forPrint ? '-1' : null,
          dataset: { kind: r.kind, balance: r.balance == null ? '' : r.balance, debit: t.debit || '', credit: t.credit || '', date: r.date || '', search: search },
        },
          h('td', { class: 'nowrap' }, bankDate(r.shownDate)),
          h('td', { class: 'nowrap' }, bankDate(t.valueDate)),
          h('td', { class: 'label-col' }, label,
            r.early ? h('span', { class: 'row-note' }, 'Dated ' + bankDate(t.opDate) + ', before this statement’s period: it counts from ' + niceDate(r.date) + '.') : null,
            isMax ? h('span', { class: 'tag max' }, '★ highest balance of ' + year) : null,
            monthHigh && !isMax ? h('span', { class: 'tag' }, '▲ highest in ' + MONTHS[+r.date.slice(5, 7) - 1]) : null),
          h('td', { class: 'num' }, cell(t.debit)),
          h('td', { class: 'num' }, cell(t.credit)),
          h('td', { class: 'num strong' }, r.balance == null ? '' : FBARCore.formatMad(r.balance)),
          h('td', { class: 'nowrap' }, r.page ? 'p. ' + r.page : (r.kind === 'tx' ? '—' : '')));
      })));
  }

  function proofData(acc, info, year) {
    const stmts = info.inYear.slice();
    const stmtRows = stmts.map(statementRows);
    const marks = markRows(acc, stmtRows, year);
    const dated = (acc.statements || []).filter((s) => isIso(s.openDate) && isIso(s.closeDate));
    const prevOf = (s) => dated.find((p) => p !== s && p.closeDate === s.openDate) || null;
    return { stmts: stmts, stmtRows: stmtRows, marks: marks, prevOf: prevOf };
  }

  function renderProof(acc, info, year) {
    const key = acc.account;
    const ui = state.proof[key] || (state.proof[key] = { query: '', open: {} });
    const acctDigits = digitsOnly(acc.account);
    const data = proofData(acc, info, year);
    const sec = h('section', { class: 'proof', dataset: { account: acctDigits } });
    sec.appendChild(h('h4', null, 'Check the details yourself'));
    sec.appendChild(h('p', { class: 'hint' },
      'One block per statement, in date order. The four figures in each title are printed on the bank statement, so you can tick them off: ✓ means the transactions add up to it, ✗ shows the difference. Open a block to see every transaction and the page of the PDF where it is.'));
    const input = h('input', { type: 'search', class: 'proof-search', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'A word or an amount, e.g. MARJANE or 1 234,56', 'aria-label': 'Search the transactions of this account' });
    input.value = ui.query;
    const count = h('p', { class: 'proof-count', 'aria-live': 'polite' });
    const blocks = data.stmts.map((s, i) => {
      const det = h('details', { class: 'stmt', dataset: { file: s.fileName } });
      det.open = !!ui.open[s.fileName];
      det.addEventListener('toggle', () => { ui.open[s.fileName] = det.open; });
      const figs = statementFigures(s, data.prevOf(s));
      const bad = figs.some((f) => f.check && !f.check.ok);
      det.appendChild(h('summary', { class: bad ? 'has-bad' : '' },
        h('span', { class: 'stmt-head' }, h('strong', null, capitalize(shortPeriod(s))),
          h('span', { class: 'muted small' }, ' · ' + fileLabel(s) + ' · ' + plural((s.transactions || []).length, 'transaction'))),
        h('span', { class: 'figs' }, figureNodes(figs))));
      det.appendChild(h('div', { class: 'table-scroll' }, txTable(data.stmtRows[i], data.marks, year, acctDigits, false)));
      return det;
    });
    const filter = () => { ui.query = input.value; applySearch(sec, ui.query, count); };
    input.addEventListener('input', filter);
    sec.appendChild(h('div', { class: 'proof-tools' },
      input,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => blocks.forEach((b) => { b.open = true; }) }, 'Expand all'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => blocks.forEach((b) => { b.open = false; }) }, 'Collapse all'))));
    sec.appendChild(count);
    blocks.forEach((b) => sec.appendChild(b));
    if (ui.query) applySearch(sec, ui.query, count);
    return sec;
  }

  function rowMatches(tr, amount, text) {
    const d = tr.dataset;
    const amounts = [d.debit, d.credit, d.balance].filter((v) => v !== '' && v != null).map(Number);
    if (amount && amount.cents != null && amounts.indexOf(amount.cents) !== -1) return true;
    if (amount && amount.whole != null && amounts.some((c) => Math.floor(Math.abs(c) / 100) === amount.whole)) return true;
    return !!text && d.search.indexOf(text) !== -1;
  }

  function applySearch(sec, query, count) {
    const q = String(query || '').trim();
    const blocks = Array.from(sec.querySelectorAll('details.stmt'));
    if (!q) {
      blocks.forEach((b) => { b.hidden = false; b.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = false; }); });
      count.textContent = '';
      return;
    }
    const amount = parseAmountQuery(q);
    const text = normalizeText(q);
    let nRows = 0, nBlocks = 0;
    blocks.forEach((b) => {
      let any = false;
      b.querySelectorAll('tbody tr').forEach((tr) => {
        const ok = rowMatches(tr, amount, text);
        tr.hidden = !ok;
        if (ok) { any = true; nRows++; }
      });
      b.hidden = !any;
      if (any) { nBlocks++; b.open = true; }
    });
    count.textContent = nRows
      ? plural(nRows, 'matching line') + ' in ' + plural(nBlocks, 'statement') + '.'
      : 'No line matches “' + q + '”.';
  }

  /** "Show me where this comes from": open the statement, clear the search, scroll to the row. */
  function showMaxRow(acctDigits) {
    const row = document.getElementById('max-row-' + acctDigits);
    if (!row) return;
    const sec = row.closest('.proof');
    const input = sec.querySelector('.proof-search');
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
    const det = row.closest('details');
    det.open = true;
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }

  // ---------------------------------------------------------------- printable report

  /** Fills #report, which only shows when printing ("Save a report" -> print -> Save as PDF). */
  function renderReport(accounts, failed, rate, problemCount) {
    const rep = $('report');
    rep.textContent = '';
    const has = accounts.length > 0;
    document.body.classList.toggle('has-report', has);
    if (!has) return;
    const year = state.year;
    const conditional = accounts.some(a => conditionalBalance(a.acc));
    const def = DEFAULT_RATES[year];
    let total = 0;
    accounts.forEach((a) => { if (a.acc.max && rate) total += FBARCore.toUsd(a.acc.max.balance, rate) || 0; });

    rep.appendChild(h('h1', null, 'FBAR: maximum value of bank accounts in Morocco, ' + year));
    rep.appendChild(h('p', { class: 'rep-meta' }, 'Prepared on ' + niceDate(todayIso()) + ' from ' +
      plural(state.usedStmts.length, 'bank statement') + ', read offline on this computer (FBAR maximum balance tool, build ' +
      (document.documentElement.getAttribute('data-build') || '?') + ').'));
    rep.appendChild(problemCount
      ? h('p', { class: 'rep-status bad' }, 'NOT FINAL: ' + plural(problemCount, 'problem') + ' must be fixed before these numbers are used (listed below).')
      : h('p', { class: 'rep-status ok' }, 'Checked: every statement adds up, and every month of ' + year + ' is covered for ' + (accounts.length === 1 ? 'the account' : 'each account') + '.'));

    const rows = [
      ['Exchange rate', rate == null ? 'none entered, so no US dollar values are shown'
        : String(rate) + ' MAD per 1 USD' + (def != null && rate === def
          ? ' \u2014 official U.S. Treasury rate for Dec 31, ' + year + ' (' + RATE_SOURCE + ')'
          : ' \u2014 entered by hand (official source: U.S. Treasury Reporting Rates of Exchange, Morocco-Dirham, Dec 31, ' + year + ', fiscaldata.treasury.gov)') +
          '. US dollars = MAD \u00f7 rate, rounded up to the next whole dollar.'],
    ];
    if (rate) {
      rows.push(['Sum of the maximum values below', usdText(total) + (conditional
        ? ' — conditional: confirm the undated balance before using this sum to assess the filing threshold'
        : total > FBAR_THRESHOLD_USD
        ? ' \u2014 more than $10,000: an FBAR is required, and every foreign account must be listed'
        : ' \u2014 not more than $10,000 for these accounts alone; add any other foreign accounts (an FBAR is required if the total is more than $10,000)')]);
    }
    rep.appendChild(fieldTable(rows));

    // Cover page: every account at a glance.
    rep.appendChild(h('h3', null, 'All accounts'));
    rep.appendChild(h('table', { class: 'rep-summary' },
      h('thead', null, h('tr', null,
        h('th', null, 'Account number (item 18)'),
        h('th', { class: 'num' }, 'Highest, MAD'),
        h('th', { class: 'num' }, 'Highest, USD (item 15)'),
        h('th', null, 'Reached on'),
        h('th', { class: 'num' }, 'Balance on Dec 31, MAD'),
        h('th', null, 'Status'))),
      h('tbody', null, accounts.map((a) => {
        const max = a.acc.max;
        const usd = (max && rate) ? FBARCore.toUsd(max.balance, rate) : null;
        const ye = yearEndOf(a.acc, year);
        return h('tr', null,
          h('td', null, digitsOnly(a.acc.account) || '(not found)'),
          h('td', { class: 'num strong' }, max ? madNum(max.balance) : '\u2014'),
          h('td', { class: 'num strong' }, usd != null ? usdText(usd) : '\u2014'),
          h('td', { class: 'date' }, max ? niceDate(max.date) : '\u2014'),
          h('td', { class: 'num' }, ye ? madNum(ye.balance) : '\u2014'),
          h('td', null, a.info.problems.length ? 'NOT FINAL (' + plural(a.info.problems.length, 'problem') + ')' : 'Checked'));
      }))));
    rep.appendChild(h('p', { class: 'rep-meta' }, 'Every account: type of account (item 16) Bank. Name (item 17) and address (items 19 to 23) of the bank, and the details of each account, are on the following pages.'));

    if (failed.length) {
      rep.appendChild(h('div', { class: 'rep-problems' },
        h('strong', null, 'Files that could not be used:'),
        h('ul', null, failed.map((e) => h('li', null, e.name + ': ' + e.message)))));
    }

    const dueIso = (year + 1) + '-10-15';
    rep.appendChild(h('p', { class: 'rep-meta' },
      'The FBAR is FinCEN Form 114, filed online through BSA E-Filing. ' +
      (todayIso() <= dueIso ? 'The ' + year + ' FBAR is due October 15, ' + (year + 1) + ' (automatic extension included). '
        : 'The ' + year + ' FBAR was due October 15, ' + (year + 1) + ': it is past due. ') +
      'If unsure, confirm with your tax preparer. This report contains account numbers and balances: keep it private.'));

    accounts.forEach((a) => {
      const acc = a.acc, info = a.info, max = acc.max;
      const usd = (max && rate) ? FBARCore.toUsd(max.balance, rate) : null;
      const maxStmt = statementOfMax(acc);
      const sec = h('section', { class: 'rep-account' });
      sec.appendChild(h('h2', null, 'Account ' + (prettyAccount(acc.account) || '(number not found)') +
        (info.problems.length ? ' \u2014 NOT FINAL' : '')));
      sec.appendChild(h('h3', null, 'FinCEN Form 114 (FBAR), Part II'));
      if (conditionalBalance(acc)) sec.appendChild(h('p', { class: 'rep-status bad' },
        'Conditional calculation: every balance below assumes the undated SOLDE REEL is the period-end balance. A dated bank statement must confirm this assumption.'));
      sec.appendChild(fieldTable([
        ['Item 15 \u2014 Maximum value of account during calendar year', max
          ? (usd != null ? usdText(usd) + '   (' + madText(max.balance) + ')' : madText(max.balance) + ' (US dollars not computed: no exchange rate entered)') +
            (conditionalBalance(acc) ? ' — conditional, unconfirmed' : '')
          : 'no balance found'],
        ['Item 16 \u2014 Type of account', 'Bank'],
        ['Item 17 \u2014 Name of financial institution', bankOf(acc).name],
        ['Item 18 \u2014 Account number', digitsOnly(acc.account) || '(not found)'],
        ['Items 19 to 23 \u2014 Address of the financial institution', bankOf(acc).address || 'as printed on your statements'],
      ], 'rep-form'));
      sec.appendChild(h('h3', null, 'How the maximum was found'));
      const detail = [];
      if (max) {
        detail.push(['Highest balance', madText(max.balance)]);
        detail.push(['Reached on', niceDate(max.date)]);
        detail.push(isOpeningLabel(max.label) ? ['What', 'The starting balance of the statement (carried over from the month before)'] : ['Transaction', max.label || '\u2014']);
        if (maxStmt) detail.push(['Statement', capitalize(statementName(maxStmt)) + ' (' + fileLabel(maxStmt) + ')']);
        if (usd != null) detail.push(['In US dollars', max.balance > 0 ? conversionText(max.balance, rate) + ', rounded up to ' + usdText(usd) : '$0 (the balance never went above zero)']);
      }
      const ye = yearEndOf(acc, year);
      const yeUsd = (ye && rate) ? FBARCore.toUsd(ye.balance, rate) : null;
      detail.push([(conditionalBalance(acc) ? 'Assumed balance' : 'Balance') + ' on December 31, ' + year, ye
        ? madText(ye.balance) + (yeUsd != null ? ' (= ' + usdText(yeUsd) + ' at the same rate)' : '') + '. Your tax preparer may ask for this (for example for Form 8938).'
        : 'not available (no statement covers December 31, ' + year + ')']);
      detail.push(['Statements used', plural(info.inYear.length, 'statement') + ' for ' + year + ', covering ' + coveredText(info, year) +
        (info.problems.length ? ' \u2014 ' + plural(info.problems.length, 'problem') + ' (below)' : ' \u2014 all add up')]);
      sec.appendChild(fieldTable(detail));
      if (info.problems.length) {
        sec.appendChild(h('div', { class: 'rep-problems' },
          h('strong', null, 'Problems to fix before using this number:'),
          h('ul', null, info.problems.map((p) => h('li', null, p.text + (p.todo ? ' ' + p.todo : ''))))));
      }
      sec.appendChild(h('h3', null, 'Month by month (amounts in MAD)'));
      sec.appendChild(monthTable(info, year, peakMonthOf(max, year)));
      rep.appendChild(sec);
    });

    if (state.reportDetailed) {
      accounts.forEach((a) => {
        const acctDigits = digitsOnly(a.acc.account);
        const data = proofData(a.acc, a.info, year);
        const sec = h('section', { class: 'rep-account rep-detail', dataset: { account: acctDigits } });
        sec.appendChild(h('h2', null, 'Appendix: every transaction, account ' + (prettyAccount(a.acc.account) || '(number not found)')));
        sec.appendChild(h('p', { class: 'rep-meta' }, (conditionalBalance(a.acc)
          ? 'Amounts in MAD. Debit and credit totals are checked against the export. The opening balance is derived and the closing balance is an undated snapshot; running balances and maxima are conditional. '
          : 'Amounts in MAD, written as on the bank statement. For each statement, the four figures printed by the bank are checked against the transactions (OK, or the difference). ') +
          '\u2605 marks the highest balance of ' + year + ', \u25b2 the highest of each month.'));
        data.stmts.forEach((s, i) => {
          const figs = statementFigures(s, data.prevOf(s));
          const part = h('div', { class: 'rep-stmt' });
          part.appendChild(h('h3', null, capitalize(shortPeriod(s)) + ' \u2014 ' + fileLabel(s)));
          part.appendChild(h('table', { class: 'rep-figs' },
            h('thead', null, h('tr', null, figs.map((f) => h('th', null, f.label)))),
            h('tbody', null,
              h('tr', null, figs.map((f) => h('td', { class: 'num' }, f.value == null ? 'not found' : (f.balance ? bankBalance(f.value) : FBARCore.formatMad(f.value))))),
              h('tr', null, figs.map((f) => h('td', null, f.check ? (f.check.ok ? 'OK' : 'NOT OK: ' + f.check.text) : '')))) ));
          part.appendChild(txTable(data.stmtRows[i], data.marks, year, acctDigits, true));
          sec.appendChild(part);
        });
        rep.appendChild(sec);
      });
    }

  }

  function fieldTable(rows, cls) {
    return h('table', { class: 'rep-fields' + (cls ? ' ' + cls : '') },
      h('tbody', null, rows.map((r) => h('tr', null, h('th', { scope: 'row' }, r[0]), h('td', null, r[1])))));
  }

  // ---------------------------------------------------------------- downloads

  function csvDownload(kind) {
    const stmts = state.usedStmts;
    if (!stmts.length) return;
    const text = kind === 'statements' ? FBARCore.statementsCsv(stmts) : FBARCore.transactionsCsv(stmts);
    // The byte-order mark lets Excel show accented letters correctly.
    download('fbar-' + kind + '-' + state.year + '.csv', '﻿' + text, 'text/csv;charset=utf-8');
  }

  function downloadDiagnostic(entry) {
    let dump;
    try {
      dump = FBARCore.layoutDump(entry.pages || []);
    } catch (err) {
      console.error(err);
      setProgress('Sorry, the diagnostic file could not be created for this file.');
      return;
    }
    const sts = entry.statements || [];
    const what = entry.status === 'failed' ? (entry.kind || 'failed')
      : (sts.some((st) => st.warnings && st.warnings.length) ? 'statement read with warnings' : 'statement') +
        (sts.length > 1 ? ' (' + sts.length + ' statements in the file)' : '') + (entry.unmatched ? ', ' + entry.unmatched + ' without account number' : '');
    const header = [
      'Safe diagnostic file - FBAR maximum balance tool (bank statements)',
      'File: statement-' + entry.id + '.pdf (the real file name is not included)' + (sts.length ? ', bank: ' + bankOf(sts[0]).name : ''),
      'This shows only the layout of one statement: every letter is replaced by x and every digit by 9.',
      'It contains no names, no account numbers and no amounts.',
      'Tool build: ' + (document.documentElement.getAttribute('data-build') || 'unknown'),
      'Situation: ' + what + ', ' + plural((entry.pages || []).length, 'page'),
      '',
    ].join('\n');
    download('fbar-diagnostic-' + entry.id + '.txt', header + dump + '\n', 'text/plain;charset=utf-8');
  }

  // ---------------------------------------------------------------- start

  function start() {
    document.body.dataset.state = 'idle';
    const missing = startupProblem();
    setupSettings();
    if (missing.length) {
      const box = $('fatal');
      box.hidden = false;
      box.appendChild(h('h2', null, 'This page did not load correctly'));
      box.appendChild(h('p', null, 'A part of it is missing (' + missing.join(', ') + '). Please ask for a fresh copy of the file and open it again.'));
      $('file-input').disabled = true;
      return;
    }
    setupFiles();
    $('dl-statements').addEventListener('click', () => csvDownload('statements'));
    $('dl-transactions').addEventListener('click', () => csvDownload('transactions'));
    const printReport = (detailed) => {
      state.reportDetailed = detailed;
      renderResults();
      window.print();
    };
    $('save-report').addEventListener('click', () => printReport(false));
    $('save-report-detailed').addEventListener('click', () => printReport(true));
    // The short report stays the default (also for the browser's own Print command).
    window.addEventListener('afterprint', () => {
      if (state.reportDetailed) { state.reportDetailed = false; renderResults(); }
    });
    recomputeAndRender();
    document.body.dataset.state = 'ready';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
