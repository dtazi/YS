/*
 * fbar-core.js - FBAR maximum balance from bank statements: the logic.
 *
 * Faithful port of fbar_cih.py (the tested Python reference). Pure logic: no DOM, no network,
 * no dependencies. Money is always handled as INTEGER CENTS (never floats for sums).
 *
 * Input pages come from extract-pdfjs.js (or any extractor producing the same shape):
 *   Page = { width, height, words: [{ text, x0, x1, top, bottom }], vlines: [x, ...], vrules?: [{ x, top, bottom }] }
 *   coordinates in PDF points, origin at the TOP-left corner (like pdfplumber).
 *
 * One PDF may hold several statements (e.g. 12 monthly statements, one per page): parseFile / parseStatements
 * return a list. Other banks plug in with registerBank (see SPEC.md, "Bank plug-ins"); CIH is the default.
 *
 * UMD: module.exports in Node, window.FBARCore in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FBARCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DATE_RE = /^(\d{2})[/.-](\d{2})(?:[/.-](\d{2}|\d{4}))?$/;
  var INLINE_DATE_RE = /(\d{2})[/.-](\d{2})[/.-](\d{4})/;
  var AMOUNT_RE = /^-?\d{1,3}(?:[ .]?\d{3})*,\d{2}$/;
  var LINE_TOLERANCE = 3; // points; words closer than this vertically are on the same line
  var DATE_TOLERANCE_DAYS = 7; // operation dates this close to the statement period are normal (late bookings)
  var MIN_RULE_DISPLAY = 20; // layoutDump only lists vertical rules longer than this (points)
  var UNKNOWN_ACCOUNT = 'UNKNOWN ACCOUNT';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  // ---------------------------------------------------------------- dates
  // Dates are 'YYYY-MM-DD' strings outside; inside we use day numbers (days since 1970-01-01),
  // computed with pure arithmetic (no Date object: avoids time zones and the 0-99 year quirk).

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

  function daysInMonth(y, m) {
    return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  /** A valid date as 'YYYY-MM-DD', or null (Python's to_date). */
  function toDate(day, month, year) {
    if (!(year >= 1 && year <= 9999 && month >= 1 && month <= 12)) return null;
    if (!(day >= 1 && day <= daysInMonth(year, month))) return null;
    return pad(year, 4) + '-' + pad(month, 2) + '-' + pad(day, 2);
  }

  function dayNumber(iso) { // days from civil (H. Hinnant)
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    y -= m <= 2 ? 1 : 0;
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function fromDayNumber(z) { // civil from days
    z += 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp + (mp < 10 ? 3 : -9);
    return pad(y + (m <= 2 ? 1 : 0), 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
  }

  function addDays(iso, n) { return fromDayNumber(dayNumber(iso) + n); }
  function yearOf(iso) { return +iso.slice(0, 4); }

  /** '2025-09-30' -> '30 September 2025' (for messages shown to a person). */
  function humanDate(iso) {
    if (!iso) return '?';
    return (+iso.slice(8, 10)) + ' ' + MONTHS[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(0, 4));
  }

  /** 0 when the date is within the statement period [openDate, closeDate], else how many days away it is. */
  function daysOutside(iso, stmt) {
    var d = dayNumber(iso);
    if (stmt.openDate && d < dayNumber(stmt.openDate)) return dayNumber(stmt.openDate) - d;
    if (stmt.closeDate && d > dayNumber(stmt.closeDate)) return d - dayNumber(stmt.closeDate);
    return 0;
  }

  /**
   * DD/MM, DD/MM/YY or DD/MM/YYYY -> 'YYYY-MM-DD'. A missing year is taken from the statement period
   * (stmt.openDate / stmt.closeDate): the candidate inside the period, else the one nearest to it
   * (ties: nearest to the closing date). null if unreadable or impossible (31/02).
   */
  function resolveDate(text, stmt) {
    var m = DATE_RE.exec(text);
    if (!m) return null;
    var day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = m[3];
    if (year) return toDate(day, month, parseInt(year, 10) + (year.length === 2 ? 2000 : 0));
    var ref = stmt.closeDate || stmt.openDate;
    if (!ref) return null;
    var refYear = yearOf(ref), refDay = dayNumber(ref);
    var best = null, bestOut = Infinity, bestDist = Infinity;
    for (var y = refYear - 1; y <= refYear + 1; y++) {
      var d = toDate(day, month, y);
      if (!d) continue;
      var out = daysOutside(d, stmt), dist = Math.abs(dayNumber(d) - refDay);
      // strict comparison: the first candidate wins ties, like Python's min()
      if (out < bestOut || (out === bestOut && dist < bestDist)) { best = d; bestOut = out; bestDist = dist; }
    }
    return best;
  }

  // ---------------------------------------------------------------- money (integer cents)

  /** '1 234,56' / '1.234,56' / '-12,30' -> cents (integer), or null if not an amount. */
  function parseAmount(text) {
    text = String(text).replace(/ /g, ' ').trim();
    if (!AMOUNT_RE.test(text)) return null;
    var negative = text.charAt(0) === '-';
    var digits = text.replace(/[^0-9]/g, '');
    var cents = parseInt(digits, 10);
    return negative ? -cents : cents;
  }

  /** cents -> '18 240,50' (same as fbar_cih.py's fmt). '' for null. */
  function formatMad(cents) {
    if (cents === null || cents === undefined || !isFinite(cents)) return '';
    cents = Math.round(cents);
    var negative = cents < 0;
    var abs = Math.abs(cents);
    var units = String(Math.floor(abs / 100));
    var frac = pad(abs % 100, 2);
    var grouped = units.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (negative ? '-' : '') + grouped + ',' + frac;
  }

  /** cents -> '1234.56' (plain decimal, for CSV). '' for null. */
  function centsToDecimal(cents) {
    if (cents === null || cents === undefined) return '';
    var negative = cents < 0, abs = Math.abs(cents);
    return (negative ? '-' : '') + Math.floor(abs / 100) + '.' + pad(abs % 100, 2);
  }

  /**
   * Maximum balance in USD for FBAR: cents / (MAD per USD), rounded UP to whole dollars,
   * 0 if the balance is <= 0. Exact (BigInt), so 1005,00 MAD at 10.05 gives 100, not 101.
   * madPerUsd may be a number or a string ('10.05' or '10,05'). Returns null if the rate is not usable.
   */
  function toUsd(cents, madPerUsd) {
    if (cents === null || cents === undefined) return null;
    var rate = String(madPerUsd === null || madPerUsd === undefined ? '' : madPerUsd).trim().replace(',', '.');
    var m = /^(\d*)(?:\.(\d*))?$/.exec(rate);
    if (!m || (m[1] + (m[2] || '')) === '') return null;
    var fracDigits = m[2] || '';
    var rateInt = BigInt((m[1] || '0') + fracDigits); // rate * 10^k
    if (rateInt === BigInt(0)) return null;
    if (cents <= 0) return 0;
    var scale = BigInt(10) ** BigInt(fracDigits.length);
    var num = BigInt(Math.round(cents)) * scale;   // cents * 10^k
    var den = rateInt * BigInt(100);               // (rate * 10^k) * 100
    var q = num / den;
    if (num % den !== BigInt(0)) q += BigInt(1);
    return Number(q);
  }

  // ---------------------------------------------------------------- layout helpers

  function pyRound(x) { // Python's round(): halves go to the even neighbour
    var r = Math.round(x);
    if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);
    return r;
  }

  /** Words -> lines (top to bottom; words within 3pt vertically of a line's first word), each left to right. */
  function groupLines(words) {
    var sorted = words.slice().sort(function (a, b) {
      return (pyRound(a.top) - pyRound(b.top)) || (a.x0 - b.x0);
    });
    var lines = [];
    sorted.forEach(function (w) {
      var last = lines[lines.length - 1];
      if (last && Math.abs(last[0].top - w.top) <= LINE_TOLERANCE) last.push(w);
      else lines.push([w]);
    });
    return lines.map(function (line) {
      return line.slice().sort(function (a, b) { return a.x0 - b.x0; });
    });
  }

  function findWord(words, text) {
    for (var i = 0; i < words.length; i++) if (words[i].text === text) return words[i];
    return null;
  }

  /**
   * x of the table's vertical rule between lo and hi, if the PDF draws one. page.vlines lists vertical rules
   * of any length: some PDFs only draw the column borders in the header row.
   */
  function findVline(page, lo, hi, dflt) {
    var best = null;
    (page.vlines || []).forEach(function (x) {
      if (lo < x && x < hi && (best === null || x > best)) best = x;
    });
    return best === null ? dflt : best;
  }

  /** Locate the CIH transaction table columns from its header row. null if not a statement page. */
  function columnLayout(page, words) {
    var debit = findWord(words, 'DEBIT'), credit = findWord(words, 'CREDIT');
    var oper = findWord(words, 'OPER'), valeur = findWord(words, 'VALEUR');
    if (!(debit && credit && oper && valeur)) return null;
    // The description header "OPERATION-REFERENCE" can come out split ("OPERATION-R" + "EFERENCE"): take the
    // leftmost word starting with OPERATION on the DEBIT/CREDIT header line.
    var desc = null;
    words.forEach(function (w) {
      if (w.text.indexOf('OPERATION') === 0 && Math.abs(w.top - debit.top) <= LINE_TOLERANCE &&
          (desc === null || w.x0 < desc.x0)) desc = w;
    });
    if (!desc) return null;
    return {
      headerBottom: Math.max(debit.bottom, credit.bottom, oper.bottom, valeur.bottom),
      operEnd: findVline(page, oper.x1, valeur.x0, valeur.x0 - 2),
      dateEnd: findVline(page, valeur.x1, desc.x0, valeur.x1 + 3),
      amountStart: findVline(page, desc.x1, debit.x0 + 1, debit.x0 - 3),
      creditStart: findVline(page, debit.x1, credit.x0 + 1, credit.x0 - 3)
    };
  }

  /** The RIB is the line of digits under the BANQUE / VILLE / N° DE COMPTE / CLE header. */
  function readAccount(words) {
    var banque = findWord(words, 'BANQUE');
    if (!banque) return '';
    var below = words.filter(function (w) { return banque.bottom < w.top && w.top < banque.bottom + 25; });
    var lines = groupLines(below);
    for (var i = 0; i < lines.length; i++) {
      var digits = lines[i].map(function (w) { return w.text.replace(/\D/g, ''); }).join('');
      if (digits.length >= 10) return digits;
    }
    return '';
  }

  // ---------------------------------------------------------------- messages (plain language)

  function startsWithAny(s, prefixes) {
    for (var i = 0; i < prefixes.length; i++) if (s.indexOf(prefixes[i]) === 0) return true;
    return false;
  }

  var MSG = {
    scanned: 'This PDF contains no readable text: it looks like a scanned image or a photo of a statement. ' +
      'This tool can only read the original PDF statements downloaded from CIH online banking.',
    noTable: 'This does not look like a CIH Bank account statement: the table of transactions ' +
      '(with the DEBIT and CREDIT columns) was not found. If it is a CIH statement, its layout is different ' +
      'from what this tool expects.',
    badAmount: function (page, raw) {
      return 'Page ' + page + ': an amount could not be read on this line: "' + raw + '"';
    },
    badDate: function (page, raw) {
      return 'Page ' + page + ': a date could not be read on this line, so the line was left out: "' + raw + '"';
    },
    notUnderstood: function (page, raw) {
      return 'Page ' + page + ': this line was not understood and was left out: "' + raw + '"';
    },
    outsidePeriod: function (t, stmt) {
      return (t.page ? 'Page ' + t.page + ': ' : '') + 'the date of the transaction "' + t.description + '", ' +
        humanDate(t.opDate) + ', is far outside the period of the statement (' + humanDate(stmt.openDate) +
        ' to ' + humanDate(stmt.closeDate) + '), so it may have been misread.';
    },
    missing: {
      opening: 'The starting balance (line "SOLDE DEPART") was not found on this statement, or its amount ' +
        'could not be read.',
      closing: 'The ending balance (line "NOUVEAU SOLDE") was not found on this statement, or its amount ' +
        'could not be read.',
      openDate: 'The start date of the statement period (on the "SOLDE DEPART" line) was not found.',
      closeDate: 'The end date of the statement period (on the "NOUVEAU SOLDE" line) was not found.'
    },
    doesNotAddUp: function (computed, closing) {
      return 'The statement does not add up: the starting balance plus all the transactions read gives ' +
        formatMad(computed) + ' MAD, but the statement\'s ending balance is ' + formatMad(closing) +
        ' MAD. Some lines may have been misread.';
    },
    totalsDiffer: function (d, c, td, tc) {
      return 'The totals do not match: the transactions read add up to ' + formatMad(d) + ' MAD of debits and ' +
        formatMad(c) + ' MAD of credits, but the statement\'s "TOTAL DES MOUVEMENTS" line says ' +
        formatMad(td) + ' MAD and ' + formatMad(tc) + ' MAD. Some lines may have been misread.';
    },
    gap: function (from, to) {
      return 'No statement covers ' + humanDate(from) + ' to ' + humanDate(to) +
        ': the balance during those days is unknown. Add the missing statement.';
    },
    after: function (from, year) {
      return 'No statement covers the period after ' + humanDate(from) + ' (until the end of ' + year +
        '): the balance during that time is unknown. Add the missing statement(s).';
    },
    chainBreak: function (nextName, nextOpening, prevName, prevClosing) {
      return nextName + ' starts with a balance of ' + formatMad(nextOpening) + ' MAD, but ' + prevName +
        ' ended with ' + formatMad(prevClosing) + ' MAD. A statement may be missing or one of them was misread.';
    },
    unknownAccount: function (names) {
      return 'The account number could not be found on ' + (names.length === 1 ? 'this statement' :
        'these ' + names.length + ' statements') + ' (' + names.join(', ') + '), so ' +
        (names.length === 1 ? 'it cannot be matched' : 'they cannot be matched') +
        ' to an account. The figures shown for them may mix several accounts.';
    },
    bankFailed: function (bankName) {
      return 'This looks like a ' + bankName + ' statement, but no statement could be read from it.';
    },
    openingLabel: function (name) { return 'starting balance (' + name + ')'; }
  };

  // ---------------------------------------------------------------- statements

  /** An empty Statement (the shape every bank parser returns; see SPEC.md). */
  function createStatement(fileName) {
    return {
      fileName: fileName || '', displayName: fileName || '', bank: null, firstPage: null, lastPage: null,
      account: '', openDate: null, opening: null, closeDate: null, closing: null,
      totalDebit: null, totalCredit: null, transactions: [], warnings: []
    };
  }

  /**
   * The standard checks, for every bank: dates far outside the period, missing balances or dates, running
   * balance after each transaction (balanceAfter), does it add up, do the totals match. Call it once per
   * statement, after its fields and transactions are filled in.
   */
  function finalizeStatement(stmt) {
    stmt.transactions.forEach(function (t) {
      if (t.opDate && daysOutside(t.opDate, stmt) > DATE_TOLERANCE_DAYS) stmt.warnings.push(MSG.outsidePeriod(t, stmt));
    });
    ['opening', 'closing', 'openDate', 'closeDate'].forEach(function (name) {
      if (stmt[name] === null || stmt[name] === undefined) stmt.warnings.push(MSG.missing[name]);
    });
    if (stmt.opening === null || stmt.opening === undefined) return stmt;
    var balance = stmt.opening;
    stmt.transactions.forEach(function (t) {
      balance += t.credit - t.debit;
      t.balanceAfter = balance;
    });
    if (stmt.closing !== null && stmt.closing !== undefined && balance !== stmt.closing) {
      stmt.warnings.push(MSG.doesNotAddUp(balance, stmt.closing));
    }
    var debits = 0, credits = 0;
    stmt.transactions.forEach(function (t) { debits += t.debit; credits += t.credit; });
    if (stmt.totalDebit !== null && stmt.totalDebit !== undefined &&
        (debits !== stmt.totalDebit || credits !== stmt.totalCredit)) {
      stmt.warnings.push(MSG.totalsDiffer(debits, credits, stmt.totalDebit, stmt.totalCredit));
    }
    return stmt;
  }

  /** One page of a CIH statement -> its account, table layout and raw table rows. */
  function readCihPage(page, pageNo) {
    var words = page.words || [];
    var info = { pageNo: pageNo, hasText: words.length > 0, account: readAccount(words), layout: null, rows: [] };
    var layout = columnLayout(page, words);
    if (!layout) return info;
    info.layout = layout;
    var sauf = null;
    for (var i = 0; i < words.length; i++) if (words[i].text.toLowerCase() === 'sauf') { sauf = words[i]; break; }
    var footer = sauf ? sauf.top : page.height;
    // A word is in the table body when its vertical middle is below the header row.
    var body = words.filter(function (w) { return (w.top + w.bottom) / 2 > layout.headerBottom && w.top < footer; });
    groupLines(body).forEach(function (line) {
      var dates = [], desc = [], debit = [], credit = [];
      line.forEach(function (w) {
        if (w.x0 < layout.dateEnd) {
          if (DATE_RE.test(w.text)) dates.push({ isOper: w.x0 < layout.operEnd, text: w.text });
        } else if (w.x1 <= layout.amountStart) desc.push(w.text);
        else if (w.x1 <= layout.creditStart) debit.push(w.text);
        else credit.push(w.text);
      });
      var debitVal = debit.length ? parseAmount(debit.join(' ')) : null;
      var creditVal = credit.length ? parseAmount(credit.join(' ')) : null;
      var oper = null, valeur = null;
      dates.forEach(function (d) {
        if (d.isOper && oper === null) oper = d.text;
        if (!d.isOper && valeur === null) valeur = d.text;
      });
      info.rows.push({
        page: pageNo, oper: oper, valeur: valeur, desc: desc.join(' '),
        debit: debitVal, credit: creditVal,
        badAmount: (debit.length > 0 && debitVal === null) || (credit.length > 0 && creditVal === null),
        raw: line.map(function (w) { return w.text; }).join(' ')
      });
    });
    return info;
  }

  function isOpeningRow(row) { return row.desc.toUpperCase().indexOf('SOLDE DEPART') === 0; }
  function isClosingRow(row) { return row.desc.toUpperCase().indexOf('NOUVEAU SOLDE') === 0; }

  /** Pages -> groups of pages, one per statement (see parseStatements). */
  function splitStatements(infos) {
    var groups = [], cur = null;
    infos.forEach(function (info) {
      var starts = info.rows.some(isOpeningRow);
      if (cur === null || (info.layout && (cur.ended || (starts && cur.started)))) {
        cur = { infos: [], started: false, ended: false };
        groups.push(cur);
      }
      cur.infos.push(info);
      cur.started = cur.started || starts;
      cur.ended = cur.ended || info.rows.some(isClosingRow);
    });
    return groups;
  }

  /** One group of pages -> one CIH Statement. */
  function buildCihStatement(infos, fileName) {
    var stmt = createStatement(fileName);
    stmt.bank = { id: CIH_BANK.id, name: CIH_BANK.name };
    stmt.firstPage = infos.length ? infos[0].pageNo : null;
    stmt.lastPage = infos.length ? infos[infos.length - 1].pageNo : null;
    var pending = [], pagesWithText = 0, pagesWithTable = 0;
    infos.forEach(function (info) {
      if (info.hasText) pagesWithText += 1;
      if (!stmt.account) stmt.account = info.account;
      if (info.layout) pagesWithTable += 1;
      pending = pending.concat(info.rows);
    });
    if (pagesWithText === 0) {
      stmt.warnings.push(MSG.scanned);
      return stmt;
    }
    if (pagesWithTable === 0) {
      stmt.warnings.push(MSG.noTable);
      return stmt;
    }

    /** The amounts of a balance or totals line can be used: at least one, and none unreadable. */
    function readable(row) { return !row.badAmount && (row.debit !== null || row.credit !== null); }
    function signed(row) { return readable(row) ? (row.credit || 0) - (row.debit || 0) : null; }
    function inlineDate(desc) {
      var m = INLINE_DATE_RE.exec(desc);
      return m ? { date: toDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)) } : null;
    }

    // First pass: balances and period, which the year inference for transaction dates needs.
    // An unreadable or missing amount leaves the balance unknown (null): it is reported, never taken as 0.
    pending.forEach(function (row) {
      var upper = row.desc.toUpperCase(), d;
      if (upper.indexOf('SOLDE DEPART') === 0) {
        stmt.opening = signed(row);
        if ((d = inlineDate(row.desc))) stmt.openDate = d.date;
      } else if (upper.indexOf('NOUVEAU SOLDE') === 0) {
        stmt.closing = signed(row);
        if ((d = inlineDate(row.desc))) stmt.closeDate = d.date;
      } else if (upper.indexOf('TOTAL DES MOUVEMENTS') === 0) {
        var ok = readable(row);
        stmt.totalDebit = ok ? row.debit || 0 : null;
        stmt.totalCredit = ok ? row.credit || 0 : null;
      }
    });

    // Second pass: transactions. A dated row starts one; undated text rows continue its label.
    var current = null;
    pending.forEach(function (row) {
      var upper = row.desc.toUpperCase();
      if (startsWithAny(upper, ['SOLDE DEPART', 'NOUVEAU SOLDE', 'TOTAL DES MOUVEMENTS'])) {
        if (row.badAmount) stmt.warnings.push(MSG.badAmount(row.page, row.raw));
        current = null;
        return;
      }
      // page carry-over lines of multi-page statements (a dated line is a real transaction, whatever its label)
      if (startsWithAny(upper, ['REPORT', 'A REPORTER', 'À REPORTER']) && !row.oper) return;
      if (row.badAmount) stmt.warnings.push(MSG.badAmount(row.page, row.raw));
      if (row.oper) {
        var opDate = resolveDate(row.oper, stmt);
        if (opDate === null) {
          stmt.warnings.push(MSG.badDate(row.page, row.raw));
          current = null;
          return;
        }
        current = {
          opDate: opDate,
          valueDate: row.valeur ? resolveDate(row.valeur, stmt) : null,
          description: row.desc,
          debit: row.debit || 0,
          credit: row.credit || 0,
          balanceAfter: null,
          page: row.page
        };
        stmt.transactions.push(current);
      } else if (current !== null && !(current.debit || current.credit) && (row.debit || row.credit)) {
        current.debit = row.debit || 0;
        current.credit = row.credit || 0;
        current.description = (current.description + ' ' + row.desc).trim();
      } else if (current !== null && row.desc && !(row.debit || row.credit)) {
        current.description = (current.description + ' ' + row.desc).trim();
      } else if (row.desc || row.debit || row.credit) {
        stmt.warnings.push(MSG.notUnderstood(row.page, row.raw));
      }
    });

    return finalizeStatement(stmt);
  }

  /** Name of a statement for messages: the file name, plus its pages when the file holds several statements. */
  function nameStatements(statements, fileName) {
    if (statements.length < 2) return statements;
    statements.forEach(function (s) {
      s.displayName = fileName + (s.firstPage === s.lastPage ? ' (page ' + s.firstPage + ')'
        : ' (pages ' + s.firstPage + '-' + s.lastPage + ')');
    });
    return statements;
  }

  /**
   * CIH parser. pages (from extractPages) -> Statement[]: one PDF can hold several statements. A page with a
   * "SOLDE DEPART" line starts a new statement, and so does a table page after a statement's "NOUVEAU SOLDE";
   * other pages (continuation pages with "REPORT" lines, cover pages) belong to the current statement.
   */
  function parseStatements(pages, fileName) {
    fileName = fileName || '';
    var infos = (pages || []).map(function (page, idx) { return readCihPage(page, idx + 1); });
    var groups = splitStatements(infos);
    if (!groups.length) groups = [{ infos: [] }];
    return nameStatements(groups.map(function (g) { return buildCihStatement(g.infos, fileName); }), fileName);
  }

  /** The first statement of the file (kept for compatibility; use parseFile or parseStatements). */
  function parseStatement(pages, fileName) {
    return parseStatements(pages, fileName)[0];
  }

  /**
   * A Statement for a file that could not be read at all (damaged, password-protected...), so the UI
   * can show it alongside the others with the same shape. Not in the Python script (which would crash).
   */
  function unreadableStatement(fileName, message) {
    var stmt = createStatement(fileName);
    stmt.warnings.push(message || 'This file could not be opened as a PDF.');
    return stmt;
  }

  // ---------------------------------------------------------------- bank plug-ins

  function cihDetect(pages) {
    return (pages || []).some(function (p) { return columnLayout(p, p.words || []) !== null; });
  }

  var CIH_BANK = { id: 'cih', name: 'CIH Bank', detect: cihDetect, parse: parseStatements };
  var BANKS = [];

  /**
   * Adds a bank parser: { id, name, detect(pages) -> boolean, parse(pages, fileName) -> Statement[] }.
   * parseFile tries the registered banks in registration order, CIH last (the default). Registering an id
   * again replaces the earlier registration.
   */
  function registerBank(bank) {
    if (!bank || typeof bank.id !== 'string' || !bank.id || typeof bank.name !== 'string' ||
        typeof bank.detect !== 'function' || typeof bank.parse !== 'function') {
      throw new TypeError('registerBank needs { id, name, detect(pages), parse(pages, fileName) }');
    }
    for (var i = 0; i < BANKS.length; i++) {
      if (BANKS[i].id === bank.id) { BANKS[i] = bank; return bank; }
    }
    BANKS.push(bank);
    return bank;
  }

  /** The registered banks as [{ id, name }], in the order parseFile tries them (CIH last). */
  function banks() {
    var others = BANKS.filter(function (b) { return b.id !== CIH_BANK.id; });
    var cih = BANKS.filter(function (b) { return b.id === CIH_BANK.id; })[0] || CIH_BANK;
    return others.concat([cih]).map(function (b) { return { id: b.id, name: b.name }; });
  }

  /**
   * pages -> Statement[], with the parser of the first registered bank whose detect(pages) says yes
   * (CIH Bank when none does). Every statement gets bank = { id, name }.
   */
  function parseFile(pages, fileName) {
    var others = BANKS.filter(function (b) { return b.id !== CIH_BANK.id; });
    var cih = BANKS.filter(function (b) { return b.id === CIH_BANK.id; })[0] || CIH_BANK;
    var chosen = cih;
    for (var i = 0; i < others.length; i++) {
      var yes = false;
      try { yes = !!others[i].detect(pages); } catch (e) { yes = false; }
      if (yes) { chosen = others[i]; break; }
    }
    var list = chosen.parse(pages, fileName || '');
    if (!Array.isArray(list) || !list.length) list = [unreadableStatement(fileName, MSG.bankFailed(chosen.name))];
    list.forEach(function (s) {
      s.bank = { id: chosen.id, name: chosen.name };
      if (!s.fileName) s.fileName = fileName || '';
      if (!s.displayName) s.displayName = s.fileName;
    });
    return list;
  }

  registerBank(CIH_BANK);

  // ---------------------------------------------------------------- year logic

  /**
   * The day a balance change counts for: its date, kept within the statement period (openDate, closeDate].
   * A statement holds what was booked during its period: a card payment dated 31/12 that appears on the
   * January statement changed the balance in January, not in December.
   */
  function bookedDate(iso, s) {
    var d = dayNumber(iso);
    if (s.closeDate && d > dayNumber(s.closeDate)) d = dayNumber(s.closeDate);
    if (s.openDate && d <= dayNumber(s.openDate)) d = dayNumber(s.openDate) + 1;
    return fromDayNumber(d);
  }

  function nameOf(s) { return s.displayName || s.fileName; }

  /** {date, balance, label, fileName, displayName, page} for every moment statement s set the balance. */
  function balanceEvents(s) {
    var events = [];
    if (s.opening !== null && s.opening !== undefined && s.openDate) {
      events.push({ date: addDays(s.openDate, 1), balance: s.opening, label: MSG.openingLabel(nameOf(s)),
        fileName: s.fileName, displayName: nameOf(s), page: s.firstPage || null });
    }
    s.transactions.forEach(function (t) {
      if (t.balanceAfter !== null && t.balanceAfter !== undefined) {
        events.push({ date: bookedDate(t.opDate, s), balance: t.balanceAfter, label: t.description,
          fileName: s.fileName, displayName: nameOf(s), page: t.page || null });
      }
    });
    return events;
  }

  /**
   * Every moment the balance was set during the year (date = booked date), plus, for a statement whose period
   * started before the year, the balance it carried into January 1. Statements sorted by openDate.
   */
  function yearEvents(statements, year) {
    year = Number(year);
    var events = [];
    var jan1 = dayNumber(toDate(1, 1, year));
    (statements || []).forEach(function (s) {
      var own = balanceEvents(s);
      if (s.openDate && s.closeDate && dayNumber(s.openDate) + 1 < jan1 && jan1 <= dayNumber(s.closeDate)) {
        var before = own.filter(function (e) { return dayNumber(e.date) < jan1; });
        if (before.length) {
          var b = before[before.length - 1];
          events.push({ date: toDate(1, 1, year), balance: b.balance, label: b.label, fileName: b.fileName,
            displayName: b.displayName, page: b.page });
        }
      }
      own.forEach(function (e) { if (yearOf(e.date) === year) events.push(e); });
    });
    return events;
  }

  /**
   * Balance held at the end of Dec 31: the last balance change on or before that day, in the last statement
   * whose period covers Dec 31 (openDate < Dec 31 <= closeDate). null if no statement covers it.
   */
  function yearEnd(statements, year) {
    var dec31 = dayNumber(toDate(31, 12, Number(year)));
    var covering = (statements || []).filter(function (s) {
      return s.opening !== null && s.opening !== undefined && s.openDate && s.closeDate &&
        dayNumber(s.openDate) < dec31 && dec31 <= dayNumber(s.closeDate);
    });
    if (!covering.length) return null;
    var s = covering[covering.length - 1];
    var events = balanceEvents(s).filter(function (e) { return dayNumber(e.date) <= dec31; });
    var last = events[events.length - 1];
    return { date: last.date, balance: last.balance, fileName: s.fileName, displayName: nameOf(s) };
  }

  /** Periods of the year not covered by any statement, and breaks between consecutive statements. */
  function coverageGaps(statements, year) {
    var issues = [];
    var dated = statements.filter(function (s) { return s.openDate && s.closeDate; });
    dated = stableSort(dated, function (a, b) { return dayNumber(a.openDate) - dayNumber(b.openDate); });
    var yearStart = dayNumber(toDate(31, 12, year - 1)), yearEndDay = dayNumber(toDate(31, 12, year));
    var coveredUntil = yearStart;
    dated.forEach(function (s) {
      var open = dayNumber(s.openDate), close = dayNumber(s.closeDate);
      if (close < yearStart || open > yearEndDay) return;
      if (open > coveredUntil) issues.push(MSG.gap(fromDayNumber(coveredUntil + 1), s.openDate));
      coveredUntil = Math.max(coveredUntil, close);
    });
    if (coveredUntil < yearEndDay) issues.push(MSG.after(fromDayNumber(coveredUntil), year));
    for (var i = 0; i + 1 < dated.length; i++) {
      var prev = dated[i], nxt = dated[i + 1];
      if (prev.closing !== null && nxt.opening !== null && prev.closing !== nxt.opening &&
          prev.closeDate === nxt.openDate) {
        issues.push(MSG.chainBreak(nameOf(nxt), nxt.opening, nameOf(prev), prev.closing));
      }
    }
    return issues;
  }

  function stableSort(arr, cmp) {
    return arr.map(function (v, i) { return [v, i]; })
      .sort(function (a, b) { return cmp(a[0], b[0]) || (a[1] - b[1]); })
      .map(function (p) { return p[0]; });
  }

  function byOpenDate(a, b) { // Python: key=open_date or date.min (undated first)
    var da = a.openDate ? dayNumber(a.openDate) : -Infinity, db = b.openDate ? dayNumber(b.openDate) : -Infinity;
    return da === db ? 0 : (da < db ? -1 : 1);
  }

  /** Group statements by account, in order of first appearance; each group sorted by openDate. */
  function groupByAccount(statements) {
    var order = [], groups = {};
    statements.forEach(function (s) {
      var key = s.account || UNKNOWN_ACCOUNT;
      if (!Object.prototype.hasOwnProperty.call(groups, key)) { groups[key] = []; order.push(key); }
      groups[key].push(s);
    });
    return order.map(function (key) { return { account: key, statements: stableSort(groups[key], byOpenDate) }; });
  }

  /** statements: Statement[] (any order, any accounts, any banks), year: e.g. 2025. See SPEC.md. */
  function summarize(statements, year) {
    year = Number(year);
    var problemCount = 0;
    var accounts = groupByAccount(statements || []).map(function (g) {
      var issues = [];
      if (g.account === UNKNOWN_ACCOUNT) issues.push(MSG.unknownAccount(g.statements.map(nameOf)));
      g.statements.forEach(function (s) {
        s.warnings.forEach(function (w) { issues.push(nameOf(s) + ': ' + w); });
      });
      issues = issues.concat(coverageGaps(g.statements, year));
      problemCount += issues.length;
      var max = null;
      yearEvents(g.statements, year).forEach(function (e) {
        if (max === null || e.balance > max.balance) max = e; // first maximum wins, like Python's max()
      });
      var bank = null;
      g.statements.forEach(function (s) { if (!bank && s.bank) bank = s.bank; });
      return { account: g.account, bank: bank, statements: g.statements, issues: issues, max: max,
        yearEnd: yearEnd(g.statements, year) };
    });
    return { year: year, accounts: accounts, problemCount: problemCount };
  }

  /** The calendar year most statements' periods end in (a default for the year picker), or null. */
  function guessYear(statements) {
    var counts = {}, best = null;
    (statements || []).forEach(function (s) {
      var d = s.openDate ? addDays(s.openDate, 1) : s.closeDate;
      if (!d) return;
      var y = yearOf(d);
      counts[y] = (counts[y] || 0) + 1;
      if (best === null || counts[y] > counts[best] || (counts[y] === counts[best] && y > best)) best = y;
    });
    return best;
  }

  // ---------------------------------------------------------------- CSV (same columns as fbar_cih.py)

  function csvField(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvRow(fields) { return fields.map(csvField).join(',') + '\r\n'; }

  function statementsCsv(statements) {
    var out = csvRow(['account', 'file', 'period_start', 'period_end', 'opening', 'total_debit',
      'total_credit', 'closing', 'transactions', 'status']);
    groupByAccount(statements || []).forEach(function (g) {
      g.statements.forEach(function (s) {
        out += csvRow([g.account, s.fileName, s.openDate, s.closeDate, centsToDecimal(s.opening),
          centsToDecimal(s.totalDebit), centsToDecimal(s.totalCredit), centsToDecimal(s.closing),
          s.transactions.length, s.warnings.length ? s.warnings.join(' | ') : 'OK']);
      });
    });
    return out;
  }

  function transactionsCsv(statements) {
    var out = csvRow(['account', 'file', 'page', 'operation_date', 'value_date', 'description',
      'debit', 'credit', 'balance_after']);
    groupByAccount(statements || []).forEach(function (g) {
      g.statements.forEach(function (s) {
        s.transactions.forEach(function (t) {
          out += csvRow([g.account, s.fileName, t.page, t.opDate, t.valueDate, t.description,
            centsToDecimal(t.debit), centsToDecimal(t.credit), centsToDecimal(t.balanceAfter)]);
        });
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- layout dump (safe to share)

  // Table words shown as they are (they are the same on every CIH statement and identify no one).
  var KEYWORDS = ['DATES', 'OPER', 'VALEUR', 'OPERATION-REFERENCE', 'DEBIT', 'CREDIT', 'SOLDE', 'DEPART',
    'NOUVEAU', 'TOTAL', 'MOUVEMENTS', 'REPORT', 'REPORTER', 'PAGE', 'BANQUE', 'VILLE', 'COMPTE', 'CLE',
    'RELEVE', 'AGENCE', 'Sauf', 'erreur'];
  var KEPT_PUNCTUATION = ".,/-:;()'’°%+=";

  var NUMBER_RE, LETTER_RE;
  try {
    NUMBER_RE = new RegExp('\\p{N}', 'u');
    LETTER_RE = new RegExp('\\p{L}', 'u');
  } catch (e) { // very old engines without Unicode property escapes: be strict (anything else becomes #)
    NUMBER_RE = /[0-9]/;
    LETTER_RE = /[A-Za-zÀ-ÖØ-öø-ɏ]/;
  }

  /**
   * Masks one word: kept as is if it is a table keyword; "~" if it holds no letter and no digit of any script
   * (fonts without a Unicode map can turn digits into punctuation or control codes); otherwise letters -> x,
   * digits -> 9, a few separators kept (. , / - : ; ( ) ' ’ ° % + =) and every other character -> #.
   */
  function maskText(text) {
    text = String(text);
    if (text.normalize) text = text.normalize('NFC');
    if (KEYWORDS.indexOf(text) >= 0) return text;
    var chars = Array.from(text);
    if (!chars.some(function (ch) { return LETTER_RE.test(ch) || NUMBER_RE.test(ch); })) return '~';
    return chars.map(function (ch) {
      if (LETTER_RE.test(ch)) return 'x';
      if (NUMBER_RE.test(ch)) return '9';
      return KEPT_PUNCTUATION.indexOf(ch) >= 0 ? ch : '#';
    }).join('');
  }

  function ruleLines(page) {
    var xs = [];
    if (Array.isArray(page.vrules)) {
      page.vrules.forEach(function (r) { if (r.bottom - r.top > MIN_RULE_DISPLAY) xs.push(r.x); });
    } else {
      xs = (page.vlines || []).slice(); // lengths unknown: list them all
    }
    var seen = {};
    return xs.map(function (x) { return x.toFixed(1); }).filter(function (t) {
      if (seen[t]) return false;
      seen[t] = true;
      return true;
    }).sort(function (a, b) { return a - b; }).map(function (t) { return 'vline x=' + t; });
  }

  /**
   * Every word's position with its content masked (see maskText), and the vertical rules longer than 20pt:
   * shows the page layout without revealing any personal data.
   */
  function layoutDump(pages) {
    var out = [];
    (pages || []).forEach(function (page, idx) {
      out.push('--- page ' + (idx + 1) + ' (' + Math.round(page.width) + 'x' + Math.round(page.height) + ') ---');
      ruleLines(page).forEach(function (l) { out.push(l); });
      groupLines(page.words || []).forEach(function (line) {
        out.push(line.map(function (w) {
          return w.x0.toFixed(1) + '-' + w.x1.toFixed(1) + '@' + Math.round(w.top) + ':' + maskText(w.text);
        }).join(' | '));
      });
    });
    return out.join('\n') + '\n';
  }

  return {
    // reading statements
    parseFile: parseFile,
    parseStatements: parseStatements,
    parseStatement: parseStatement,
    unreadableStatement: unreadableStatement,
    // results
    summarize: summarize,
    yearEvents: yearEvents,
    yearEnd: yearEnd,
    guessYear: guessYear,
    toUsd: toUsd,
    formatMad: formatMad,
    humanDate: humanDate,
    statementsCsv: statementsCsv,
    transactionsCsv: transactionsCsv,
    layoutDump: layoutDump,
    UNKNOWN_ACCOUNT: UNKNOWN_ACCOUNT,
    // bank plug-ins and the helpers they share
    registerBank: registerBank,
    banks: banks,
    createStatement: createStatement,
    finalizeStatement: finalizeStatement,
    parseAmount: parseAmount,
    groupLines: groupLines,
    findWord: findWord,
    toDate: toDate,
    addDays: addDays,
    resolveDate: resolveDate,
    daysOutside: daysOutside,
    // internals exposed for tests
    _internal: {
      parseAmount: parseAmount, resolveDate: resolveDate, groupLines: groupLines, columnLayout: columnLayout,
      readAccount: readAccount, coverageGaps: coverageGaps, yearEvents: yearEvents, centsToDecimal: centsToDecimal,
      toDate: toDate, addDays: addDays, pyRound: pyRound, maskText: maskText, bookedDate: bookedDate,
      splitStatements: splitStatements, DATE_TOLERANCE_DAYS: DATE_TOLERANCE_DAYS
    }
  };
});
