"""Generate files the app must reject gracefully (no real data anywhere).

Writes into OUTDIR:
  locked.pdf        password-protected PDF (password "secret")
  scanned.pdf       image-only PDF (no selectable text), like a paper statement put through a scanner
  not_cih.pdf       an ordinary text PDF that is not a CIH statement
  not_a_pdf.pdf     a text file with a .pdf name
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

W, H = A4


def locked(path):
    c = canvas.Canvas(str(path), pagesize=A4, encrypt="secret")
    c.setFont("Helvetica", 12)
    c.drawString(72, H - 72, "RELEVE DE COMPTE BANCAIRE (locked test file)")
    c.save()


def scanned(path):
    img = Image.new("L", (1240, 1754), 255)
    d = ImageDraw.Draw(img)
    d.text((80, 120), "RELEVE DE COMPTE BANCAIRE", fill=0)
    for i in range(30):
        d.text((80, 300 + i * 30), f"01/01  02/01  FAKE SCANNED LINE {i}   1 000,00", fill=0)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(ImageReader(img), 0, 0, width=W, height=H)
    c.save()


def not_cih(path):
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, H - 72, "INVOICE 2025-0042")
    c.setFont("Helvetica", 11)
    for i, line in enumerate(["Example Supplies Ltd", "Item: paper, 10 boxes", "Total due: 120.00 EUR"]):
        c.drawString(72, H - 110 - i * 16, line)
    c.save()


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    locked(out / "locked.pdf")
    scanned(out / "scanned.pdf")
    not_cih(out / "not_cih.pdf")
    (out / "not_a_pdf.pdf").write_text("This is just a text file, not a PDF.\n")
    print(f"Edge-case files written to {out}")
