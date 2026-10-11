/* Offline positioned-text readers for Attijariwafa monthly statements and BMCE history exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fbar-core.js'));
  else factory(root.FBARCore);
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  // Courier table words can cross a column border (code/date and description/value date).
  // Split those words by glyph centres rather than assigning the entire word to one column.
  function cell(line, lo, hi, split) {
    return line.map(function (w) {
      if (!split) return w.x0 >= lo && w.x1 <= hi + 1 ? w.text : '';
      return Array.from(w.text).filter(function (_, i, chars) {
        var centre = w.x0 + (i + 0.5) * (w.x1 - w.x0) / chars.length;
        return centre >= lo && centre < hi;
      }).join('');
    }).filter(Boolean).join(' ').trim();
  }
  function compact(text) { return text.replace(/\s/g, ''); }
  function fold(text) { return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }
  function date8(text) {
    var m = /^(\d{2})(\d{2})(\d{4})$/.exec(compact(text));
    return m ? core.toDate(+m[1], +m[2], +m[3]) : null;
  }
  function dateFull(text) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(compact(text));
    return m ? core.toDate(+m[1], +m[2], +m[3]) : null;
  }
  function money(text, stmt, page, required) {
    var value = text ? core.parseAmount(text) : (required ? null : 0);
    if (value === null) stmt.warnings.push('p' + page + ': unreadable amount in a bank table cell.');
    return value;
  }
  function signed(text, label, stmt, page) {
    var value = money(text, stmt, page, true);
    if (/DEBITEUR/i.test(label)) return value === null ? null : -value;
    if (/CREDITEUR/i.test(label)) return value;
    stmt.warnings.push('p' + page + ': balance credit/debit designation could not be read.');
    return null;
  }
  function openingBalance(text, stmt, page) {
    var match = /^(-?[\d .]+,\d{2})\s*(CREDITEUR|DEBITEUR)$/i.exec(text);
    if (!match) { stmt.warnings.push('p' + page + ': unreadable amount or designation in the starting balance.'); return null; }
    return signed(match[1], match[2], stmt, page);
  }
  function display(stmt, multi) {
    if (multi) stmt.displayName += ' (pages ' + stmt.firstPage + '–' + stmt.lastPage + ')';
    return core.finalizeStatement(stmt);
  }

  function parseAttijari(pages, fileName) {
    var statements = [], stmt = null, pending = [], expectedPages = null;
    function finish() {
      if (!stmt) return;
      pending.forEach(function (r) {
        var d = core.resolveDate(r.oper.slice(0, 2) + '/' + r.oper.slice(2), stmt);
        if (!d) { stmt.warnings.push('p' + r.page + ': unreadable date in a transaction.'); return; }
        var v = date8(r.value);
        if (!v) stmt.warnings.push('p' + r.page + ': unreadable date in a value-date cell.');
        stmt.transactions.push({ opDate: d, valueDate: v, description: r.description,
          debit: r.debit === null ? 0 : r.debit, credit: r.credit === null ? 0 : r.credit,
          balanceAfter: null, page: r.page });
      });
      if (expectedPages !== null && stmt.lastPage - stmt.firstPage + 1 !== expectedPages) {
        stmt.warnings.push('The statement page count does not match its printed page count.');
      }
      statements.push(stmt); stmt = null; pending = []; expectedPages = null;
    }
    pages.forEach(function (page, index) {
      var lines = core.groupLines(page.words || []), pageNo = index + 1;
      var opening = lines.find(function (l) {
        return l[0].top > 280 && l[0].top < 310 && /^SOLDE\s+/i.test(cell(l, 150, 310, false));
      });
      if (opening) finish();
      if (!stmt) {
        stmt = core.createStatement(fileName); stmt.bank = { id: 'attijariwafa', name: 'Attijariwafa Bank' };
        stmt.firstPage = pageNo;
      }
      stmt.lastPage = pageNo;
      var account = compact(cell((page.words || []).filter(function (w) { return w.top > 230 && w.top < 245; }), 340, 465, false));
      if (/^\d{24}$/.test(account)) {
        if (stmt.account && stmt.account !== account) stmt.warnings.push('Account changes within this statement.');
        else stmt.account = account;
      }
      var pageLine = lines.find(function (l) { return l[0].top > 270 && l[0].top < 285; });
      var pageCount = pageLine && /(\d+)\/(\d+)/.exec(cell(pageLine, 480, 520, false));
      if (pageCount) {
        if (expectedPages === null) expectedPages = +pageCount[2];
        if (+pageCount[1] !== pageNo - stmt.firstPage + 1 || expectedPages !== +pageCount[2]) {
          stmt.warnings.push('p' + pageNo + ': unexpected printed page number.');
        }
      } else stmt.warnings.push('p' + pageNo + ': printed page number could not be read.');
      if (opening) {
        stmt.openDate = date8(cell(opening, 248, 310, false).replace(/[^0-9]/g, ''));
        stmt.opening = openingBalance(cell(opening, 370, 510, false), stmt, pageNo);
      }
      lines.forEach(function (l) {
        var upper = fold(cell(l, 150, 300, false));
        if (/SOLDE\s+FINAL/.test(upper)) {
          stmt.closeDate = date8(cell(l, 240, 300, false));
          stmt.closing = signed(cell(l, 328, 395, false), cell(l, 395, 510, false), stmt, pageNo);
        } else if (/TOTAL\s+MOUVEMENTS/.test(upper)) {
          stmt.totalDebit = money(cell(l, 328, 418, false), stmt, pageNo, true);
          stmt.totalCredit = money(cell(l, 418, 512, false), stmt, pageNo, true);
        } else if (l[0].top > 330 && l[0].top < 590) {
          var oper = compact(cell(l, 80, 106, true));
          var debit = cell(l, 328, 418, true), credit = cell(l, 418, 512, true);
          // Undated separators consist solely of punctuation. Reject an unrecognised data row.
          if (!/^\d{4}$/.test(oper)) {
            if (/\d/.test(debit + credit + oper)) stmt.warnings.push('p' + pageNo + ': line not understood, ignored.');
            return;
          }
          pending.push({ oper: oper, value: compact(cell(l, 274.5, 328, true)),
            description: cell(l, 106, 274.5, true), debit: money(debit, stmt, pageNo, false),
            credit: money(credit, stmt, pageNo, false), page: pageNo });
        }
      });
    });
    finish();
    return statements.map(function (s) { return display(s, statements.length > 1); });
  }

  function parseBmce(pages, fileName) {
    var stmt = core.createStatement(fileName);
    stmt.bank = { id: 'bmce', name: 'BMCE Bank of Africa' };
    stmt.balanceBasis = 'undated-snapshot';
    stmt.firstPage = 1; stmt.lastPage = pages.length;
    var first = pages[0] || { words: [] }, expectedCount = null, snapshot = null;
    core.groupLines(first.words || []).forEach(function (l) {
      var upper = fold(cell(l, 0, 600, false));
      var range = /(\d{2}\/\d{2}\/\d{4})AU(\d{2}\/\d{2}\/\d{4})/.exec(compact(upper));
      if (range) {
        var start = dateFull(range[1]); stmt.openDate = start ? core.addDays(start, -1) : null;
        stmt.closeDate = dateFull(range[2]);
      }
      if (/SOLDE\s+REEL/.test(upper)) {
        snapshot = money(cell(l, 300, 370, false), stmt, 1, true);
        var account = compact(cell(l, 70, 200, false));
        if (/^\d{24}$/.test(account)) stmt.account = account;
      }
      if (/TOTAL\s+DES.*MOUVEMENTS/.test(upper)) {
        expectedCount = +compact(cell(l, 295, 315, false));
        stmt.totalDebit = money(cell(l, 385, 472, false), stmt, 1, true);
        stmt.totalCredit = money(cell(l, 472, 559, false), stmt, 1, true);
      }
    });
    var current = null;
    pages.forEach(function (page, index) {
      core.groupLines(page.words || []).forEach(function (l) {
        var oper = cell(l, 35, 117.5, false), description = cell(l, 244, 384.5, false);
        if (l[0].top < (index === 0 ? 350 : 35) || l[0].top > 765) return;
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(oper)) {
          var d = dateFull(oper), v = dateFull(cell(l, 117.5, 188, false));
          if (!d || !v) stmt.warnings.push('p' + (index + 1) + ': unreadable date in a transaction.');
          if (!d) { current = null; return; }
          current = { opDate: d, valueDate: v, description: description,
            debit: money(cell(l, 385, 472, false), stmt, index + 1, true) || 0,
            credit: money(cell(l, 472, 559, false), stmt, index + 1, true) || 0,
            balanceAfter: null, page: index + 1 };
          stmt.transactions.push(current);
        } else if (current && description && !oper) current.description += ' ' + description;
        else if (/\d/.test(oper)) stmt.warnings.push('p' + (index + 1) + ': line not understood, ignored.');
      });
    });
    if (expectedCount === null || expectedCount !== stmt.transactions.length) {
      stmt.warnings.push('The transaction count does not match the total selected movements.');
    }
    var descending = stmt.transactions.every(function (t, i, ts) { return !i || ts[i - 1].opDate >= t.opDate; });
    if (!descending) stmt.warnings.push('The transaction history is not in the expected reverse date order.');
    stmt.transactions.reverse();
    if (snapshot !== null) {
      stmt.closing = snapshot;
      stmt.opening = snapshot - stmt.transactions.reduce(function (sum, t) { return sum + t.credit - t.debit; }, 0);
    }
    stmt.warnings.push('Balance anchor is provisional: SOLDE REEL is an undated online balance. ' +
      'The opening balance and yearly maximum assume it equals the closing balance of the selected period. ' +
      'Obtain a dated opening or closing statement before using these figures for filing. ' +
      'Transactions on the same day were replayed in reverse displayed order; their exact posting sequence is unconfirmed.');
    return [display(stmt, false)];
  }

  core.registerBank({ id: 'attijariwafa', name: 'Attijariwafa Bank', detect: function (pages) {
    return pages.some(function (p) {
      return core.groupLines(p.words || []).some(function (l) {
        return l[0].top > 280 && l[0].top < 310 && /^SOLDE(?:ANTERIEUR|DEPART)/.test(compact(fold(cell(l, 150, 310, false))));
      });
    });
  }, parse: parseAttijari });
  core.registerBank({ id: 'bmce', name: 'BMCE Bank of Africa', detect: function (pages) {
    return pages.some(function (p) {
      return core.groupLines(p.words || []).some(function (l) { return /SOLDE\s+REEL/.test(fold(cell(l, 200, 300, false))); });
    });
  }, parse: parseBmce });
  return { parseAttijari: parseAttijari, parseBmce: parseBmce };
});
