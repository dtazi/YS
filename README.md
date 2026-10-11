# FBAR maximum balance from Moroccan bank statements

Finds the **highest balance of each account during the year**, the number the U.S. FBAR
(FinCEN Form 114) asks for, from your PDF bank statements. It replays every transaction on every
statement, so it catches a peak in the middle of a month, not only month-end balances.

**Your statements never leave your computer.** It's a single web page that works offline: nothing is
uploaded, no account, no AI. You can turn off Wi-Fi before you open it to be sure.

Reads **CIH Bank** and **Attijariwafa Bank** monthly statements, including several statements merged
into one PDF, and **BMCE Bank of Africa** transaction-history exports. BMCE history exports show an
undated online balance. Their maximum is provisional until a dated opening or closing statement
confirms the balance anchor; this limitation is included in the PDF and CSV warnings.

## How to use it

1. **Open the local tool:** `dist/FBAR-Max-Balance.html` (one self-contained file).
2. **Download your statements** from your bank’s online banking as PDF: all twelve months of the year, for every
   account. Use the PDF files from the bank, not scans or photos.
3. *(Optional)* Turn off Wi-Fi.
4. **Double-click `FBAR-Max-Balance.html`.** It opens in your web browser (Chrome, Safari, Edge or Firefox).
5. **Follow the three steps on the page:** check the year and the exchange rate (filled in for you),
   drop all your statements at once, and read your results.
6. **Keep or share your results:** choose **Save a detailed report (with every transaction)** and select **Save as PDF**
   in the print window. The report includes the MAD maximum, December 31 balance, a monthly table,
   and the source PDF pages so you can check the calculation. CSV downloads are also available.

You do not need Python, Node, ChatGPT, an API key, or a server to use the downloaded HTML file.

If the page shows a problem (a missing month, a statement that doesn't add up), fix it before using
the numbers: the page explains what to do in each case.

## What to do with the result

- On FinCEN Form 114 (filed online through BSA E-Filing), each account's maximum in U.S. dollars goes
  in Part II, **item 15, "Maximum value of account during calendar year"**. The page converts it with
  the official U.S. Treasury rate for December 31 and rounds up to the next dollar, as the FBAR
  instructions require.
- An FBAR is required when the maximums of **all** your foreign accounts **added together** are over
  $10,000. Then every foreign account must be listed, even small ones.
- The 2025 FBAR is due **October 15, 2026**, including the automatic extension.

This tool does the arithmetic. It isn't tax advice: if you're unsure what applies to you, ask your
tax preparer.

## If a statement can't be read

The page has a **"Create a safe diagnostic file"** button. That file keeps only the position of each
word on the page, with every letter replaced by `x` and every digit by `9`. It contains no name,
account number or amount, so you can send it to whoever maintains the tool so they can adapt it.

---

## For developers

Everything runs client-side: pdf.js 3.11.174 extracts positioned words, `src/fbar-core.js` rebuilds the
balances. The build inlines pdf.js, its worker and the code into one HTML file with a CSP that blocks
all network access.

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    npm ci
    npm run build                       # -> dist/FBAR-Max-Balance.html
    npm test                            # logic + extraction compared against Python
    npm run test:python                 # merged layout and masked diagnostic checks
    npm run test:e2e                    # offline browser test; Google Chrome must be installed

To save a private CIH report and proofreading CSVs locally, without showing account values in the terminal:

    node tools/export_report.mjs --out ~/fbar-results/cih-2025 --year 2025 --rate 9.101 ~/path/to/cih.pdf

For the other banks, select their reader and discover the PDF files without printing private filenames:

    node tools/export_report.mjs --bank attijari --input-dir ~/path/to/attijari --out ~/fbar-results/attijari-2025 --year 2025 --rate 9.101
    node tools/export_report.mjs --bank bmce --input-dir ~/path/to/bmce --out ~/fbar-results/bmce-2025 --year 2025 --rate 9.101

The export runs the browser offline and compares its extracted statements, maximum and December 31
balance with the Python reader before saving. Repeated monthly statements are excluded. Missing months
remain marked **NOT FINAL** in the PDF report. Keep these output files private.

`fbar_cih.py` is the Python reference implementation (same rules, command line):

    .venv/bin/python fbar_cih.py ~/path/to/statements --year 2025 --rate 9.101

The Python command prints real values to the terminal. Use the browser or `export_report.mjs` when
the results must stay out of the terminal or an assistant's context. To debug a real PDF, only use
the masked diagnostics:

    .venv/bin/python -I tools/safe_inspect.py check ~/path/to/statements
    .venv/bin/python -I tools/safe_inspect.py layout ~/path/to/statements --pages 1,-1

Tests use invented statements only (`tests/make_fake_statements.py`). **Never commit a real statement**:
`.gitignore` blocks PDFs and CSVs as a safety net.
