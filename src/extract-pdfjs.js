/*
 * extract-pdfjs.js - turns a PDF (ArrayBuffer) into the `pages` structure fbar-core.js reads, using pdf.js.
 *
 *   FBARExtract.extractPages(pdfjsLib, arrayBuffer) -> Promise<Page[]>
 *   Page = { width, height, words: [{ text, x0, x1, top, bottom }], vlines: [x, ...] }
 *
 * Coordinates are PDF points with the origin at the TOP-left corner, like pdfplumber, so the logic ported
 * from fbar_cih.py sees (nearly) the same numbers. pdf.js gives text runs, not words: each run is split on
 * whitespace and every word's x0/x1 is estimated from the run's position and width (glyph widths are
 * estimated: uniform for monospace fonts, Helvetica-like proportions otherwise, calibrated per font).
 * vlines are read from the page's drawing operations (straight vertical segments longer than 20pt).
 *
 * Nothing here touches the network: no cMapUrl / standardFontDataUrl, eval and font loading disabled.
 * UMD: module.exports in Node, window.FBARExtract in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FBARExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_VLINE_LENGTH = 20;   // points
  var MERGE_GAP = 3;           // pdfplumber's x_tolerance: glyphs closer than this belong to the same word
  var DEFAULT_DESCENT = -0.2;  // fraction of the font size, when the font does not say

  // Helvetica advance widths (1/1000 em) for ASCII 32..126, used as relative glyph widths for
  // proportional fonts (Arial and most sans-serif fonts are close enough for splitting runs into words).
  var HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
    722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278,
    278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
    333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

  var WS = /\s/;

  function glyphWeight(ch, monospace) {
    if (monospace) return 1;
    var c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) return HELV[c - 32] / 1000;
    if (ch === '°') return 0.4;
    if (WS.test(ch)) return 0.278;
    // accented letters: width of the base letter
    var base = ch.normalize ? ch.normalize('NFD').charAt(0) : ch;
    var b = base.charCodeAt(0);
    if (base !== ch && b >= 32 && b <= 126) return HELV[b - 32] / 1000;
    return 0.556;
  }

  // 2D affine matrices as [a, b, c, d, e, f] (pdf.js convention; mul(m1, m2) applies m2 first).
  function mul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : null;
  }

  function isTextItem(item) { return item && typeof item.str === 'string' && item.transform; }

  function fontSize(item) { return Math.hypot(item.transform[2], item.transform[3]) || item.height || 0; }

  /**
   * Per font: glyph-width scale = run width / (font size * sum of relative glyph widths), measured on runs
   * without spaces (where the width is all glyphs). Lets us tell glyph widths from the gaps pdf.js turns
   * into spaces when it joins two nearby pieces of text into one run.
   */
  function fontScales(items, styles) {
    var samples = {};
    items.forEach(function (item) {
      if (!isTextItem(item) || !item.width || !item.str || WS.test(item.str)) return;
      var size = fontSize(item);
      if (!size) return;
      var mono = isMonospace(styles, item.fontName);
      var sum = 0;
      Array.from(item.str).forEach(function (ch) { sum += glyphWeight(ch, mono); });
      if (sum > 0) (samples[item.fontName] = samples[item.fontName] || []).push(item.width / (size * sum));
    });
    var scales = {};
    Object.keys(samples).forEach(function (k) { scales[k] = median(samples[k]); });
    return scales;
  }

  function isMonospace(styles, fontName) {
    var st = styles && styles[fontName];
    return !!(st && /mono/i.test(st.fontFamily || ''));
  }

  function descentOf(styles, fontName) {
    var st = styles && styles[fontName];
    var d = st && typeof st.descent === 'number' && isFinite(st.descent) ? st.descent : DEFAULT_DESCENT;
    return Math.max(-1, Math.min(0, d));
  }

  /** One pdf.js text run -> words (bounding boxes in top-left coordinates). */
  function itemToWords(item, viewportTransform, styles, scales) {
    var chars = Array.from(item.str);
    if (!chars.length || !item.width) return [];
    var size = fontSize(item);
    var mono = isMonospace(styles, item.fontName);
    var scale = scales[item.fontName];

    // advance of each character along the run, summing to item.width
    var weights = chars.map(function (ch) { return glyphWeight(ch, mono); });
    var advances;
    var nSpaces = chars.filter(function (ch) { return WS.test(ch); }).length;
    if (scale && nSpaces > 0) {
      var glyphTotal = 0;
      advances = chars.map(function (ch, i) {
        if (WS.test(ch)) return 0;
        var a = weights[i] * size * scale;
        glyphTotal += a;
        return a;
      });
      var spaceEach = (item.width - glyphTotal) / nSpaces;
      if (spaceEach > 0) {
        advances = advances.map(function (a, i) { return WS.test(chars[i]) ? spaceEach : a; });
      } else {
        advances = null;
      }
    }
    if (!advances) {
      var total = weights.reduce(function (s, w) { return s + w; }, 0) || 1;
      advances = weights.map(function (w) { return item.width * w / total; });
    }

    var m = mul(viewportTransform, item.transform);
    var len = Math.hypot(m[0], m[1]) || 1;
    var ux = m[0] / len, uy = m[1] / len;                 // along the baseline (viewport space)
    var hv = Math.hypot(m[2], m[3]) || 1;
    var vx = m[2] / hv, vy = m[3] / hv;                   // "up" for the glyphs (viewport space)
    var h = size * (Math.hypot(viewportTransform[0], viewportTransform[1]) || 1);
    var widthScale = Math.hypot(viewportTransform[0], viewportTransform[1]) || 1;
    var descent = descentOf(styles, item.fontName);
    var lo = descent * h, hi = descent * h + h;           // pdfminer: glyph box from descent to descent + size

    var words = [];
    var pos = 0, start = null, text = '';
    function flush(endPos) {
      if (start === null) return;
      var a = start * widthScale, b = endPos * widthScale;
      var pts = [[a, lo], [a, hi], [b, lo], [b, hi]].map(function (p) {
        return [m[4] + ux * p[0] + vx * p[1], m[5] + uy * p[0] + vy * p[1]];
      });
      var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
      words.push({
        text: text,
        x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
        top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys)
      });
      start = null;
      text = '';
    }
    chars.forEach(function (ch, i) {
      if (WS.test(ch)) flush(pos);
      else {
        if (start === null) start = pos;
        text += ch;
      }
      pos += advances[i];
    });
    flush(pos);
    words.forEach(function (w) {
      w.startsRun = false;
      w.endsRun = false;
    });
    if (words.length) {
      words[0].startsRun = !WS.test(chars[0]);
      words[words.length - 1].endsRun = !WS.test(chars[chars.length - 1]);
    }
    return words;
  }

  /**
   * Words from all runs of a page. Two runs that touch (no whitespace between them, gap <= 3pt, same line)
   * form one word, as pdfplumber would read them (pdf.js starts a new run e.g. when the font changes).
   */
  function pageWords(textContent, viewport) {
    var items = (textContent.items || []).filter(isTextItem);
    var styles = textContent.styles || {};
    var scales = fontScales(items, styles);
    var words = [];
    var prevWord = null; // last word of the previous run, if that run ended with a glyph
    items.forEach(function (item) {
      var ws = itemToWords(item, viewport.transform, styles, scales);
      if (!ws.length) {
        if (item.str.length) prevWord = null; // a whitespace-only run separates words
        return;
      }
      var first = ws[0];
      if (prevWord && first.startsRun && Math.abs(first.top - prevWord.top) <= 1 &&
          first.x0 >= prevWord.x1 - 0.5 && first.x0 - prevWord.x1 <= MERGE_GAP) {
        prevWord.text += first.text;
        prevWord.x1 = Math.max(prevWord.x1, first.x1);
        prevWord.top = Math.min(prevWord.top, first.top);
        prevWord.bottom = Math.max(prevWord.bottom, first.bottom);
        ws = ws.slice(1);
        if (!ws.length) { if (!first.endsRun) prevWord = null; return; }
      }
      ws.forEach(function (w) { words.push(w); });
      var last = ws[ws.length - 1];
      prevWord = last.endsRun ? last : null;
    });
    return sortLikePdfplumber(words.map(function (w) {
      return { text: w.text, x0: round3(w.x0), x1: round3(w.x1), top: round3(w.top), bottom: round3(w.bottom) };
    }));
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }

  /** Lines top to bottom (words within 3pt vertically chained together), left to right within a line. */
  function sortLikePdfplumber(words) {
    var byTop = words.slice().sort(function (a, b) { return a.top - b.top; });
    var out = [], line = [], lastTop = null;
    function flushLine() {
      line.sort(function (a, b) { return a.x0 - b.x0; });
      out.push.apply(out, line);
      line = [];
    }
    byTop.forEach(function (w) {
      if (lastTop !== null && w.top > lastTop + 3) flushLine();
      line.push(w);
      lastTop = w.top;
    });
    flushLine();
    return out;
  }

  /** x positions of vertical rules longer than 20pt, from the page's drawing operations. */
  async function pageVlines(page, OPS, viewport) {
    var ops = await page.getOperatorList();
    var ctm = viewport.transform.slice();
    var stack = [];
    var pending = [];
    var xs = [];
    var PAINT = [OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
      OPS.closeFillStroke, OPS.closeEOFillStroke];

    function segment(p, q) {
      if (Math.abs(p[0] - q[0]) < 1 && Math.abs(p[1] - q[1]) > MIN_VLINE_LENGTH) pending.push((p[0] + q[0]) / 2);
    }

    function buildPath(pathOps, coords) {
      var j = 0, cur = null, startPt = null;
      for (var k = 0; k < pathOps.length; k++) {
        var op = pathOps[k];
        if (op === OPS.moveTo) {
          cur = startPt = apply(ctm, coords[j], coords[j + 1]); j += 2;
        } else if (op === OPS.lineTo) {
          var p = apply(ctm, coords[j], coords[j + 1]); j += 2;
          if (cur) segment(cur, p);
          cur = p;
        } else if (op === OPS.curveTo) {
          cur = apply(ctm, coords[j + 4], coords[j + 5]); j += 6;
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          cur = apply(ctm, coords[j + 2], coords[j + 3]); j += 4;
        } else if (op === OPS.closePath) {
          if (cur && startPt) segment(cur, startPt);
          cur = startPt;
        } else if (op === OPS.rectangle) {
          var x = coords[j], y = coords[j + 1], w = coords[j + 2], hh = coords[j + 3]; j += 4;
          var c = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + hh), apply(ctm, x, y + hh)];
          for (var e = 0; e < 4; e++) segment(c[e], c[(e + 1) % 4]);
          cur = startPt = c[0];
        }
      }
    }

    for (var i = 0; i < ops.fnArray.length; i++) {
      var fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice());
        if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.constructPath) buildPath(args[0], args[1]);
      else if (PAINT.indexOf(fn) >= 0) { xs.push.apply(xs, pending); pending = []; }
      else if (fn === OPS.endPath) pending = []; // clipping paths are not drawn
    }
    var seen = {};
    return xs.map(round3).filter(function (x) {
      if (seen[x]) return false;
      seen[x] = true;
      return true;
    }).sort(function (a, b) { return a - b; });
  }

  function toBytes(input) {
    // Always pass pdf.js a private copy: it may transfer (detach) the buffer it is given.
    if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    throw friendly(new Error('not a binary buffer'), 'This file could not be read.');
  }

  function friendly(err, message) {
    var e = err instanceof Error ? err : new Error(String(err));
    if (!e.userMessage) {
      var name = e.name || '';
      if (message) e.userMessage = message;
      else if (name === 'PasswordException') {
        e.userMessage = 'This PDF is protected by a password. Open it, remove the password ' +
          '(or save a copy without one) and try again.';
      } else if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
        e.userMessage = 'This file is not a valid PDF, or it is damaged.';
      } else {
        e.userMessage = 'This PDF could not be read. It may be damaged.';
      }
    }
    return e;
  }

  /**
   * arrayBuffer: ArrayBuffer or Uint8Array/Buffer of a PDF file -> Promise<Page[]>.
   * On failure the promise rejects with an Error that has a plain-language `userMessage`.
   */
  async function extractPages(pdfjsLib, arrayBuffer) {
    var data = toBytes(arrayBuffer);
    var params = {
      data: data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true
    };
    if (pdfjsLib.VerbosityLevel) params.verbosity = pdfjsLib.VerbosityLevel.ERRORS;
    var task = pdfjsLib.getDocument(params);
    var doc;
    try {
      doc = await task.promise;
    } catch (err) {
      throw friendly(err);
    }
    var pages = [];
    try {
      for (var n = 1; n <= doc.numPages; n++) {
        var page = await doc.getPage(n);
        var viewport = page.getViewport({ scale: 1 });
        var textContent = await page.getTextContent();
        var words = pageWords(textContent, viewport);
        var vlines = [];
        if (words.length && pdfjsLib.OPS) { // pages without text need no table rules
          try {
            vlines = await pageVlines(page, pdfjsLib.OPS, viewport);
          } catch (e) {
            vlines = []; // the logic falls back to positions derived from the table header
          }
        }
        pages.push({ width: viewport.width, height: viewport.height, words: words, vlines: vlines });
        page.cleanup();
      }
    } catch (err) {
      throw friendly(err);
    } finally {
      try { await doc.destroy(); } catch (e) { /* ignore */ }
    }
    return pages;
  }

  return {
    extractPages: extractPages,
    _internal: { pageWords: pageWords, pageVlines: pageVlines, itemToWords: itemToWords }
  };
});
