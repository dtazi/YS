# Offline browser app: FBAR maximum balance from CIH statements

## Goal
A non-technical person (the account holder) gets ONE file, `dist/FBAR-Max-Balance.html`. He double-clicks it,
it opens in his browser (Chrome, Safari, Edge, Firefox, on Mac or Windows), he drags his CIH Bank PDF statements
onto it, and he sees the maximum balance of each account for the year (MAD and USD), ready for his FBAR.

Hard rules:
- **Nothing leaves the computer.** No network requests of any kind. The HTML includes everything inline
  (pdf.js, worker, code, CSS). A CSP meta tag forbids network access (`connect-src 'none'`, no external src).
  It must work with Wi-Fi turned off and when opened from `file://`.
- The logic is a faithful port of `fbar_cih.py` (the reference implementation, already tested). Same rules,
  same checks, same warnings. Money is handled as **integer cents** (never floats for sums).
- The user is not technical: plain language, no jargon, no stack traces.

## Files
| Path | What |
|---|---|
| `src/fbar-core.js` | Pure logic, no dependencies, no DOM. UMD: `module.exports` in Node, `window.FBARCore` in browser. |
| `src/extract-pdfjs.js` | Turns a PDF (ArrayBuffer) into the `pages` structure below using pdf.js. UMD: `window.FBARExtract` / `module.exports`. Works in Node (pdfjs-dist legacy build) and browser. |
| `tests/` | Tests comparing the JS port against `fbar_cih.py` on invented PDFs. |
| `app/` + `build.mjs` + `dist/` | UI and the build that inlines everything into one HTML file. |
| `tools/export_report.mjs` | Private local PDF/CSV export, cross-checked against the Python reader. |

pdf.js is `pdfjs-dist@3.11.174` (already in `node_modules`, UMD builds: `build/pdf.min.js`, `build/pdf.worker.min.js`,
Node: `legacy/build/pdf.js`). In the single-file HTML, inline BOTH `pdf.min.js` and `pdf.worker.min.js` as scripts: when
`globalThis.pdfjsWorker` exists pdf.js runs its "fake worker" on the main thread, which avoids worker/file:// problems.
Pass `isEvalSupported: false`, `disableFontFace: true`, `useSystemFonts: false` and do not set cMapUrl / standardFontDataUrl
(text extraction does not need them; they would trigger network requests).

## Contract (`src/fbar-core.js` and `src/extract-pdfjs.js`)

```js
// Extraction
FBARExtract.extractPages(pdfjsLib, arrayBuffer) -> Promise<Page[]>
// Page = { width, height, words: Word[], vlines: number[] }
// Word = { text, x0, x1, top, bottom }  // PDF points, origin TOP-left (like pdfplumber), split on spaces
// vlines = x positions of vertical rules longer than 20pt, [] if not determinable (core must work without them)

// Logic
FBARCore.parseFile(pages, fileName) -> Statement[]
FBARCore.parseStatements(pages, fileName) -> Statement[] // CIH-specific
FBARCore.parseStatement(pages, fileName) -> Statement    // first statement only; compatibility API
// Statement = { fileName, displayName, firstPage, lastPage, bank, account,
//               openDate, opening, closeDate, closing, totalDebit, totalCredit,
//               transactions: [{ opDate, valueDate, description, debit, credit, balanceAfter, page }],
//               warnings: string[] }
// dates are 'YYYY-MM-DD' strings or null; amounts are integer cents or null.
// A PDF with no text at all -> warning that it is a scanned PDF (plain-language wording for the UI).

FBARCore.summarize(statements, year) -> {
  year,
  accounts: [{ account, statements: Statement[],          // sorted by openDate
               issues: string[],                          // statement warnings (prefixed with file name) + coverage gaps
               max: { date, balance, label } | null,     // balance in cents
               yearEnd: { date, balance } | null }],
  problemCount
}
FBARCore.toUsd(cents, madPerUsd) -> integer dollars, rounded UP (0 if balance <= 0)
FBARCore.formatMad(cents) -> "18 240,50"
FBARCore.statementsCsv(statements) / FBARCore.transactionsCsv(statements) -> CSV string (same columns as the Python script)
FBARCore.layoutDump(pages) -> string, positions + masked text (letters->x, digits->9, keywords kept),
                               safe to share for debugging (see tools/safe_inspect.py for Python)
```

The UI excludes repeated account/period statements before summarizing. A merged PDF retains the
original page numbers in the breakdown and report. Missing periods keep the result marked NOT FINAL.
CIH is the only included bank parser; `registerBank` is an extension point for future banks.

## Test data
`tests/make_fake_statements.py OUTDIR` writes fake CIH statements (invented data, same layout as the real ones) and prints
the expected maximum per account. Run with `.venv/bin/python`. Never use real statements in tests.
