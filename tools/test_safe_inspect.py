"""Checks that safe_inspect.py never prints personal data. Fake data only.

    .venv/bin/python -I tools/test_safe_inspect.py
"""
import glob
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from safe_inspect import SAFE_WORDS, mask_text  # noqa: E402

PYTHON = str(ROOT / ".venv/bin/python")
SECRETS = ["Éloïse", "Çaglar", "Benjelloun", "Orangers", "Tanger", "230 780 1234567890123456 78",
           "1 234 567,89", "58 012,40", "12/03/2025", "SARL ZÉPHYR", "محمد العلوي", "١٢٣٤"]


def run(*args):
    out = subprocess.run([PYTHON, "-I", str(ROOT / "tools/safe_inspect.py"), *args],
                         capture_output=True, text=True, check=True)
    assert out.stderr == "", f"stderr must stay empty, got: {out.stderr[:200]!r}"
    return out.stdout


def arabic_font():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    for path in ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                 "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial Unicode.ttf"]:
        try:
            pdfmetrics.registerFont(TTFont("TestArabic", path))
            return "TestArabic"
        except Exception:
            continue
    return None


def make_personal_pdf(path):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 9)
    c.drawString(300, 750, "Mme Éloïse Çaglar Benjelloun")
    c.drawString(300, 738, "12 Rue des Orangers, 90000 Tanger")
    c.drawString(40, 700, "RIB : 230 780 1234567890123456 78")
    c.drawString(40, 650, "DATE  LIBELLE  DEBIT  CREDIT  SOLDE")
    c.drawString(40, 638, "12/03/2025  VIREMENT RECU DE SARL ZÉPHYR   1 234 567,89")
    c.drawString(40, 626, "Débit total : 58 012,40")
    c.line(30, 660, 30, 600)
    font = arabic_font()
    if font:
        c.setFont(font, 10)
        c.drawString(300, 700, "محمد العلوي ١٢٣٤")
    c.save()
    return font is not None


def fold_ok(chunk):
    from safe_inspect import fold
    return fold(chunk) in SAFE_WORDS


def assert_masked(output):
    """Every printed word must be made only of x, 9, punctuation, or whitelisted words."""
    for word_part in re.findall(r"\d+\.\d-\d+\.\d:(\S*)", output):
        rest = re.sub(r"[A-Z]{2,}", lambda m: "" if m.group(0) in SAFE_WORDS else m.group(0), word_part)
        bad = [ch for ch in rest if ch not in "x9?# " and unicodedata.category(ch)[0] not in "PS"]
        assert not bad, f"unmasked characters {bad!r} in {word_part!r}"


def main():
    # Unit checks of the masking itself
    assert mask_text("Débit") == "DEBIT"
    assert mask_text("SAÏD") == "xxxx"
    assert mask_text("محمد") == "xxxx"
    assert mask_text("١٢٣") == "999"
    assert mask_text("x²½") == "x99"
    assert mask_text("ＡＢＣ") == "xxx"
    assert mask_text("‏DEBIT‮") == "DEBIT"
    assert mask_text("REF:12345") == "REF:99999"
    assert mask_text("DEBITZEPHYRIN") == "xxxxxxxxxxxxx"
    assert mask_text("1 234,56") == "9 999,99"
    assert mask_text("") == "~"
    assert mask_text("x") == "x?"
    assert mask_text("!\"#$%&") == "~"  # unmapped-font output that only looks like punctuation
    assert mask_text("\x03\x04\x01\x08") == "~"
    assert mask_text("A1@b") == "x9#x"
    assert not any(len(w) < 2 for w in SAFE_WORDS)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        personal = tmp / "personal"
        personal.mkdir()
        has_arabic = make_personal_pdf(personal / "Eloise_Caglar_Benjelloun_releve_2025.pdf")
        (personal / "not_a_pdf_Benjelloun.pdf").write_text("Benjelloun 1234567890123456")
        fake = tmp / "fake"
        subprocess.run([PYTHON, str(ROOT / "tests/make_fake_statements.py"), str(fake)],
                       capture_output=True, check=True)

        pngs = tmp / "png"
        outputs = [run("layout", str(personal), "--png-dir", str(pngs)), run("check", str(personal)),
                   run("layout", str(fake), "--pages", "1,-1"), run("check", str(fake))]
        # The personal file's output: no 4+ letter chunk anywhere, no 3+ digit chunk in any word or
        # in check mode (layout mode also prints page coordinates, which are not data).
        personal_out = outputs[0] + "\n" + outputs[1]
        word_parts = " ".join(re.findall(r"\d+\.\d-\d+\.\d:(\S*)", outputs[0])) + "\n" + outputs[1]
        for secret in SECRETS + ["Eloise", "Caglar", "releve_2025", "not_a_pdf", str(tmp)]:
            for chunk in re.findall(r"[^\W\d_]{4,}", secret):
                assert chunk.lower() not in personal_out.lower() or fold_ok(chunk), f"leak: {chunk!r}"
            for chunk in re.findall(r"\d{3,}", secret):
                assert chunk not in word_parts, f"leak: {chunk!r}"
        assert str(tmp) not in "\n".join(outputs) and "Benjelloun" not in "\n".join(outputs)
        for out in outputs:
            assert_masked(out)
        assert "error PDFSyntaxError" in outputs[1] or "error" in outputs[1]  # the fake .pdf is reported, not quoted
        assert outputs[3].count("adds up yes") == 23, outputs[3]
        assert "VIREMENT" in outputs[0] and "DEBIT" in outputs[0], "whitelisted words should stay readable"
        assert glob.glob(str(pngs / "*.png")), "PNG layout pictures should be written"
    print(f"safe_inspect: all checks passed (Arabic PDF text {'tested' if has_arabic else 'NOT tested: no font'})")


if __name__ == "__main__":
    main()
