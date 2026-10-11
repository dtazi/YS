"""QA test files for the browser app. ALL DATA IS INVENTED: never put real bank statements here.

Usage (from the project root):  .venv/bin/python qa/make_qa_files.py OUTDIR

Writes into OUTDIR:
  fake/      output of tests/make_fake_statements.py (23 statements; September missing for ...0002 45)
  full24/    24 statements, 2 accounts x 12 months, nothing missing (performance run)
  bad/       files the app must reject or ignore, each with a plain-language message:
               locked.pdf              fake statement that needs a password to open ("secret")
               scan.pdf                image-only PDF (a picture of a statement, no text at all)
               not_bank.pdf            a letter, not a bank statement (accents, Arabic, other scripts)
               0123_2025-05 (1).pdf    exact byte copy of fake/0123_2025-05.pdf
               0123_2025-05 again.pdf  same statement generated again (same content, different bytes)
  broken/    an interrupted download (first 60% of a statement) and a JPEG photo of a statement
  other_years/ Dec 2024 and Jan 2026 statements of ...0001 23 with huge balances (10 000 000 / 8 900 000 MAD)
             inside 2024 / 2026: adding them must not change the 2025 maximum
  edge/      tests/make_edge_statements.py output (expected values come from running fbar_cih.py on it)
  extra/0245_2025-09 owner-password.pdf
             the missing September statement of ...0002 45, encrypted with an owner password only
             (opens without a password, like many bank PDFs): adding it must clear the September problem
  leak/      files for the "safe diagnostic file" leak test:
               leak_statement.pdf      CIH-layout statement full of accented / Arabic / non-ASCII digits,
                                       with a totals mismatch so the app offers a diagnostic file
               not_bank.pdf            (same file as bad/not_bank.pdf)
               no_tounicode.pdf        hand-written PDF whose font has no ToUnicode map (digits come out of
                                       the text layer as raw control characters)
  expected.json  expected results (cents, dates, missing months, secrets that must not leak)
"""
import sys
sys.dont_write_bytecode = True  # never drop __pycache__ into tests/ or the project root (other agents' folders)

import json
import random
import re
import shutil
import subprocess
import sys
import time
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import make_fake_statements as mfs  # noqa: E402  (read-only reuse of the generator)

from reportlab.lib import pdfencrypt  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.utils import ImageReader  # noqa: E402
from reportlab.pdfbase import pdfmetrics  # noqa: E402
from reportlab.pdfbase.ttfonts import TTFont  # noqa: E402
from reportlab.pdfgen import canvas as rl_canvas  # noqa: E402

W, H = A4
FONT_FILE = "/Library/Fonts/Arial Unicode.ttf"
YEAR = 2025
RIB_A = "230 780 0000000000000001 23"
RIB_B = "230 780 0000000000000002 45"


def cents(d):
    return int((Decimal(d) * 100).to_integral_value())


def digits(s):
    return re.sub(r"\D", "", s)


class EncryptingCanvasModule:
    """Stands in for reportlab.pdfgen.canvas inside make_fake_statements, adding encryption."""

    def __init__(self, enc):
        self.enc = enc

    def Canvas(self, path, **kw):  # noqa: N802 (mimics the reportlab API)
        return rl_canvas.Canvas(path, encrypt=self.enc(), **kw)


def regen_fake_accounts(folder, canvas_module=None):
    """Re-run the exact random sequence of make_fake_statements.py, WITHOUT skipping September."""
    folder.mkdir(parents=True, exist_ok=True)
    saved = mfs.canvas
    if canvas_module is not None:
        mfs.canvas = canvas_module
    try:
        rng = random.Random(7)
        a = mfs.make_account(folder, RIB_A, YEAR, Decimal("18240.50"), rng, empty_months=(3,))
        b = mfs.make_account(folder, RIB_B, YEAR, Decimal("5200.00"), rng)
    finally:
        mfs.canvas = saved
    return a, b


def run_fake_generator(out):
    """tests/make_fake_statements.py as the user of this repo runs it; parse its printed expectations."""
    res = subprocess.run([sys.executable, str(ROOT / "tests" / "make_fake_statements.py"), str(out)],
                         check=True, capture_output=True, text=True)
    expected = {}
    for line in res.stdout.splitlines():
        m = re.match(r"Expected account \.\.\.(\d{4}) (\d{2}): max ([\d ]+,\d{2}) on (\d{4}-\d{2}-\d{2})", line)
        if m:
            suffix = m[1] + m[2]
            amount = Decimal(m[3].replace(" ", "").replace(",", "."))
            expected[suffix] = {"maxCents": cents(amount), "maxDate": m[4], "printed": line.strip()}
    if len(expected) != 2:
        raise SystemExit("could not parse make_fake_statements.py output:\n" + res.stdout)
    return expected, res.stdout


def scan_of(pdf_path, out_path):
    """Image-only PDF: render the statement to a bitmap (like a scanner would) and put only the picture in."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf_path))
    c = rl_canvas.Canvas(str(out_path), pagesize=A4)
    for i in range(len(doc)):
        img = doc[i].render(scale=150 / 72, grayscale=True).to_pil()
        c.drawImage(ImageReader(img), 0, 0, width=W, height=H)
        c.showPage()
    c.save()
    doc.close()


def register_font():
    pdfmetrics.registerFont(TTFont("ArialUnicode", FONT_FILE))


SECRET_LINES = [
    "Attestation de résidence — Société Générale d'Études Économiques",
    "Élève : Zoé Benjelloun, née le 12/03/1987 à Fès (Maroc)",
    "Montant réglé : 12 345,67 MAD — Référence n° 4521-8873 — Œuvre, Ça, À, Ÿ",
    "شركة الأطلس للتجارة — الدار البيضاء",
    "رقم الحساب ١٢٣٤٥٦٧٨٩٠ — ۱۲۳۴۵۶۷۸۹۰",
    "Full-width １２３４５ — Ελληνικά — Привет — 銀行 — ﬁnance — x² ½ 1º 2ª",
    "Décomposé: été — Ångström — ñ — ß — ø — ł — İ",
]


def not_bank(path):
    c = rl_canvas.Canvas(str(path), pagesize=A4)
    c.setFont("ArialUnicode", 14)
    c.drawString(60, H - 80, "Lettre — Cabinet Médical Al Amal / عيادة الأمل")
    c.setFont("ArialUnicode", 10)
    for i, line in enumerate(SECRET_LINES):
        c.drawString(60, H - 120 - i * 18, line)
    c.save()


def leak_statement(path):
    """CIH layout (same drawing code as make_fake_statements.py) + non-ASCII content; totals tampered so the
    statement gets a warning and the app offers its diagnostic button."""
    rib = "230 780 0000000000000009 87"
    c = rl_canvas.Canvas(str(path), pagesize=A4)
    mfs.draw_page(c, rib, 1, 1)
    c.setFont("ArialUnicode", 8)
    c.drawString(295, mfs.y(128), "SOCIÉTÉ ÉLÉGANCE FÈS — شركة الأطلس")
    c.drawString(295, mfs.y(140), "12 RUE IBN BATTOUTA, ٢٠٠٠٠ الدار البيضاء")
    top = mfs.BODY_TOP
    mfs.row(c, top, desc="SOLDE DEPART AU :     31/12/2024", credit=Decimal("1000.00"))
    lines = [
        ("05/01", "06/01", "VIREMENT REÇU DE ZOÉ BENJELLOUN", None, Decimal("2500.00")),
        ("09/01", "10/01", "PAIEMENT CARTE CAFÉ DE FRANCE", Decimal("120.50"), None),
        ("15/01", "16/01", "تحويل من شركة الأطلس ١٢٣٤", None, Decimal("777.77")),
        ("20/01", "21/01", "RETRAIT GAB FÈS MÉDINA ۱۲۳ １２３", Decimal("300.00"), None),
    ]
    balance, debits, credits = Decimal("1000.00"), Decimal(0), Decimal(0)
    for oper, valeur, desc, debit, credit in lines:
        top += mfs.LINE
        c.setFont("Courier", 8)
        c.drawString(15.5, mfs.y(top), oper)
        c.drawString(43, mfs.y(top), valeur)
        c.setFont("ArialUnicode", 8)
        c.drawString(76, mfs.y(top), desc)
        c.setFont("Courier", 8)
        if debit is not None:
            c.drawRightString(480.5, mfs.y(top), mfs.fmt(debit))
        if credit is not None:
            c.drawRightString(575.7, mfs.y(top), mfs.fmt(credit))
        balance += (credit or 0) - (debit or 0)
        debits += debit or 0
        credits += credit or 0
    # TOTAL line printed wrong on purpose (debits + 10,00) -> "totals differ" warning
    mfs.row(c, 685, desc="TOTAL DES MOUVEMENTS", debit=debits + Decimal("10.00"), credit=credits)
    mfs.row(c, 696, desc="NOUVEAU SOLDE AU      31/01/2025", credit=balance)
    c.save()
    return digits(rib), balance


def no_tounicode_pdf(path):
    """Hand-written PDF: CIH-like header words in a normal font, but the account number and amounts drawn with a
    font whose Differences use made-up glyph names and that has NO ToUnicode map. pdf.js then reports the raw
    character codes (control characters), one code per digit: a substitution of the real digits."""
    # digit d is drawn with character code (d + 1): 0 -> \x01, 1 -> \x02, ...
    def enc(s):
        out = ""
        for ch in s:
            if ch.isdigit():
                out += "\\%03o" % (int(ch) + 1)
            elif ch in "()\\":
                out += "\\" + ch
            else:
                out += ch
        return out

    rib = "230780000000000000009987"
    amount = "48 213,56"
    content = "\n".join([
        "BT /F1 9 Tf 30 742 Td (RELEVE DE COMPTE BANCAIRE) Tj ET",
        "BT /F1 6 Tf 17 655 Td (BANQUE) Tj ET",
        "BT /F1 6 Tf 62 655 Td (VILLE) Tj ET",
        f"BT /F2 8 Tf 17 641 Td ({enc(rib)}) Tj ET",
        "BT /F1 8 Tf 76 541 Td (SOLDE DEPART AU) Tj ET",
        f"BT /F2 8 Tf 430 541 Td ({enc(amount)}) Tj ET",
    ]).encode("latin-1")
    diffs = " ".join(f"/zz{i}" for i in range(10))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] "
        b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        ("<< /Type /Font /Subtype /Type1 /BaseFont /Courier "
         f"/Encoding << /Type /Encoding /Differences [1 {diffs}] >> >>").encode("latin-1"),
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))
    return {"rib": rib, "amountDigits": digits(amount)}


def main(out):
    out = Path(out)
    if out.exists():
        for sub in ("fake", "full24", "bad", "broken", "other_years", "edge", "extra", "leak", "_regen"):
            shutil.rmtree(out / sub, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    register_font()
    expected = {"year": YEAR, "rate": "9.101"}

    # 1. the standard fake set, exactly as tests/make_fake_statements.py writes it
    fake_exp, printed = run_fake_generator(out / "fake")
    accounts = {}
    for suffix, e in fake_exp.items():
        acct = next(digits(r) for r in (RIB_A, RIB_B) if digits(r).endswith("0" + suffix))
        accounts[acct] = {"maxCents": e["maxCents"], "maxDate": e["maxDate"], "missingMonths": [],
                          "printed": e["printed"]}
    accounts[digits(RIB_B)]["missingMonths"] = [9]
    expected["fake"] = {"files": sorted(p.name for p in (out / "fake").glob("*.pdf")), "accounts": accounts,
                        "generatorOutput": printed}

    # 2. full year, two accounts, 24 statements, nothing missing
    rng = random.Random(2024)
    full = out / "full24"
    full.mkdir()
    full_acc = {}
    for rib, opening in (("230 780 0000000000000007 71", Decimal("88000.00")),
                         ("230 780 0000000000000008 82", Decimal("1500.50"))):
        peak, when = mfs.make_account(full, rib, YEAR, opening, rng)
        full_acc[digits(rib)] = {"maxCents": cents(peak), "maxDate": str(when), "missingMonths": []}
    expected["full24"] = {"files": sorted(p.name for p in full.glob("*.pdf")), "accounts": full_acc}

    # 3. regenerated fake accounts (identical data) incl. the September statement that the set lacks
    plain = out / "_regen" / "plain"
    (a_peak, a_date), (b_peak, b_date) = regen_fake_accounts(plain)
    assert cents(a_peak) == accounts[digits(RIB_A)]["maxCents"] and cents(b_peak) == accounts[digits(RIB_B)]["maxCents"]
    owner = out / "_regen" / "owner"
    regen_fake_accounts(owner, EncryptingCanvasModule(
        lambda: pdfencrypt.StandardEncryption("", ownerPassword="owner-secret", canPrint=1, canModify=0,
                                              canCopy=0, canAnnotate=0, strength=128)))
    locked = out / "_regen" / "locked"
    regen_fake_accounts(locked, EncryptingCanvasModule(
        lambda: pdfencrypt.StandardEncryption("secret", ownerPassword="owner-secret", strength=128)))

    bad = out / "bad"
    bad.mkdir()
    shutil.copy(locked / "0245_2025-09.pdf", bad / "locked.pdf")
    scan_of(plain / "0245_2025-09.pdf", bad / "scan.pdf")
    not_bank(bad / "not_bank.pdf")
    shutil.copy(out / "fake" / "0123_2025-05.pdf", bad / "0123_2025-05 (1).pdf")
    # same content, different bytes (reportlab stamps a creation time and a document id)
    time.sleep(1.1)
    again = out / "_regen" / "again"
    regen_fake_accounts(again)
    shutil.copy(again / "0123_2025-05.pdf", bad / "0123_2025-05 again.pdf")
    assert (bad / "0123_2025-05 again.pdf").read_bytes() != (out / "fake" / "0123_2025-05.pdf").read_bytes()
    expected["bad"] = {
        "files": {
            "locked.pdf": "password",
            "scan.pdf": "scanned",
            "not_bank.pdf": "notcih",
            "0123_2025-05 (1).pdf": "duplicate-file",
            "0123_2025-05 again.pdf": "duplicate-period",
        }
    }

    # other broken inputs a non-technical user may have: an interrupted download and a phone photo
    broken = out / "broken"
    broken.mkdir()
    full_sep = (plain / "0245_2025-09.pdf").read_bytes()
    (broken / "0245_2025-09 (interrupted download).pdf").write_bytes(full_sep[: len(full_sep) * 6 // 10])
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(plain / "0245_2025-09.pdf"))
    doc[0].render(scale=1.5).to_pil().convert("RGB").save(broken / "statement photo.jpg", quality=80)
    doc.close()
    expected["broken"] = {"files": sorted(p.name for p in broken.iterdir())}

    # statements from the previous and the next year with huge balances: must NOT change the 2025 maximum
    sys.path.insert(0, str(ROOT))
    import fbar_cih  # read-only use of the reference parser, to chain the balances exactly
    dec_close = fbar_cih.parse_statement(plain / "0123_2025-12.pdf").closing
    jan_open = fbar_cih.parse_statement(plain / "0123_2025-01.pdf").opening
    other = out / "other_years"
    other.mkdir()
    mfs.make_statement(other / "0123_2024-12.pdf", RIB_A, Decimal("9000000.00"), date(2024, 11, 30), date(2024, 12, 31), [
        (date(2024, 12, 5), ["VIR RECU DE SARL ATLAS TRADING"], Decimal(0), Decimal("1000000.00")),
        (date(2024, 12, 10), ["VIR EMIS VERS COMPTE EPARGNE"], Decimal("10000000.00") - jan_open, Decimal(0)),
    ])
    mfs.make_statement(other / "0123_2026-01.pdf", RIB_A, dec_close, date(2025, 12, 31), date(2026, 1, 31), [
        (date(2026, 1, 15), ["VIR RECU DE SARL ATLAS TRADING"], Decimal(0), Decimal("7000000.00")),
        (date(2026, 1, 20), ["VIR EMIS VERS COMPTE EPARGNE"], Decimal("7000000.00"), Decimal(0)),
    ])
    expected["otherYears"] = {"files": ["0123_2024-12.pdf", "0123_2026-01.pdf"],
                              "peaks": {"2024": "10 000 000,00 on 2024-12-05", "2026": "8 905 665,41-ish on 2026-01-15"}}

    # the core agent's edge statements (overdraft, big amounts, full dates, chain break, tampered, unreadable)
    subprocess.run([sys.executable, str(ROOT / "tests" / "make_edge_statements.py"), str(out / "edge")], check=True,
                   capture_output=True)

    extra = out / "extra"
    extra.mkdir()
    shutil.copy(owner / "0245_2025-09.pdf", extra / "0245_2025-09 owner-password.pdf")
    expected["extra"] = {"septemberOwnerPassword": "0245_2025-09 owner-password.pdf"}

    # 4. leak test files
    leak = out / "leak"
    leak.mkdir()
    leak_acct, leak_close = leak_statement(leak / "leak_statement.pdf")
    shutil.copy(bad / "not_bank.pdf", leak / "not_bank.pdf")
    nt = no_tounicode_pdf(leak / "no_tounicode.pdf")
    expected["leak"] = {
        "statementAccount": leak_acct,
        "secrets": ["ZOÉ", "BENJELLOUN", "SOCIÉTÉ", "ÉLÉGANCE", "FÈS", "CAFÉ", "REÇU", "MÉDINA", "Benjelloun",
                    "Zoé", "Fès", "Société", "Générale", "Études", "شركة", "الأطلس", "١٢٣", "۱۲۳", "１２３",
                    "Ελληνικά", "Привет", "銀行", "ﬁ", "Ångström", "Œuvre", "IBN", "BATTOUTA"],
        "noToUnicode": nt,
    }
    shutil.rmtree(out / "_regen", ignore_errors=True)
    (out / "expected.json").write_text(json.dumps(expected, indent=2, ensure_ascii=False))
    print(json.dumps({k: v for k, v in expected.items() if k != "fake"}, ensure_ascii=False)[:400])
    print(printed.strip())


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
