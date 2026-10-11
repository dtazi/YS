"""Generate fake CIH statements (same layout as the real ones, invented data) for testing.

Writes PDFs into the given folder and prints the expected maximum balance per account.
"""
import random
import sys
from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

W, H = A4
COLS = [13.6, 40.9, 69.5, 388.0, 484.7, 579.0]  # vertical rules of the transaction table
BODY_TOP, BODY_BOTTOM, LINE = 301, 675, 10.5
LABELS = ["VIR RECU DE SARL ATLAS TRADING", "RETRAIT GAB CASA ANFA", "PAIEMENT CARTE MARJANE",
          "PRELEVEMENT REDAL", "FRAIS TENUE DE COMPTE", "VERSEMENT ESPECES AGENCE"]


def fmt(amount):
    return f"{amount:,.2f}".replace(",", " ").replace(".", ",")


def y(top):
    return H - top


def draw_page(c, account_rib, page_no, page_count):
    c.setFont("Helvetica-Bold", 9)
    c.drawString(30, y(100), "RELEVE DE COMPTE BANCAIRE")
    c.setFont("Helvetica", 6)
    c.drawString(17, y(124), "AGENCE")
    c.setFont("Courier", 8)
    c.drawString(60, y(124), "AGENCE TEST")
    c.drawString(295, y(116), "TEST CLIENT FICTIF")
    c.setFont("Helvetica-Bold", 6)
    for x, word in [(17, "BANQUE"), (62, "VILLE"), (108, "N° DE COMPTE"), (198, "CLE")]:
        c.drawString(x, y(187), word)
    c.setFont("Courier", 8)
    c.drawString(17, y(201), account_rib)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(28, y(281), "DATES")
    c.drawString(90, y(287), "OPERATION-REFERENCE")
    c.drawString(390, y(287), "DEBIT")
    c.drawString(486, y(287), "CREDIT")
    c.setFont("Helvetica-Bold", 6)
    c.drawString(17, y(292), "OPER")
    c.drawString(42, y(292), "VALEUR")
    for x in COLS:
        c.line(x, y(273), x, y(703))
    c.line(COLS[0], y(273), COLS[-1], y(273))
    c.line(COLS[0], y(295), COLS[-1], y(295))
    c.line(COLS[0], y(703), COLS[-1], y(703))
    c.setFont("Helvetica", 7)
    c.drawString(16, y(682), "PAGE N°")
    c.setFont("Courier", 8)
    c.drawString(19, y(697), f"{page_no:04d}/{page_count}")
    c.setFont("Helvetica-Bold", 6)
    c.drawString(14, y(712), "Sauf erreur ou omission de notre part")


def row(c, top, oper=None, valeur=None, desc="", debit=None, credit=None):
    c.setFont("Courier", 8)
    if oper:
        c.drawString(15.5, y(top), oper)
    if valeur:
        c.drawString(43, y(top), valeur)
    c.drawString(76, y(top), desc)
    if debit is not None:
        c.drawRightString(480.5, y(top), fmt(debit))
    if credit is not None:
        c.drawRightString(575.7, y(top), fmt(credit))


def make_statement(path, rib, start_balance, month_end_prev, month_end, txns):
    """txns: list of (date, label lines, debit, credit)."""
    rows = []
    for d, lines, debit, credit in txns:
        dd = d.strftime("%d/%m")
        rows.append(dict(oper=dd, valeur=(d + timedelta(days=1)).strftime("%d/%m"), desc=lines[0],
                         debit=debit or None, credit=credit or None))
        rows += [dict(desc=extra) for extra in lines[1:]]
    per_page = int((BODY_BOTTOM - BODY_TOP) / LINE) - 2
    pages = [rows[i:i + per_page] for i in range(0, len(rows), per_page)] or [[]]
    c = canvas.Canvas(str(path), pagesize=A4)
    balance = start_balance
    for i, page_rows in enumerate(pages):
        draw_page(c, rib, i + 1, len(pages))
        top = BODY_TOP
        if i == 0:
            row(c, top, desc=f"SOLDE DEPART AU :     {month_end_prev:%d/%m/%Y}",
                **({"credit": start_balance} if start_balance >= 0 else {"debit": -start_balance}))
        else:
            row(c, top, desc="REPORT", credit=balance)
        top += LINE
        for r in page_rows:
            row(c, top, **r)
            balance += (r.get("credit") or 0) - (r.get("debit") or 0)
            top += LINE
        if i < len(pages) - 1:
            row(c, top, desc="A REPORTER", credit=balance)
            c.showPage()
    debits = sum(t[2] for t in txns)
    credits = sum(t[3] for t in txns)
    row(c, 685, desc="TOTAL DES MOUVEMENTS", debit=debits, credit=credits)
    row(c, 696, desc=f"NOUVEAU SOLDE AU      {month_end:%d/%m/%Y}",
        **({"credit": balance} if balance >= 0 else {"debit": -balance}))
    c.save()
    return balance


def make_account(folder, rib, year, opening, rng, skip_month=None, empty_months=()):
    balance, peak, peak_date = opening, opening, date(year, 1, 1)
    for month in range(1, 13):
        start_prev = date(year, month, 1) - timedelta(days=1)
        end = date(year, month, monthrange(year, month)[1])
        txns = []
        if month not in empty_months:
            n = 40 if month == 6 else rng.randint(3, 12)  # June is long enough to span two pages
            days = sorted(rng.randint(1, end.day) for _ in range(n))
            running = balance
            for day in days:
                if rng.random() < 0.4:
                    amt = Decimal(rng.randint(500, 1_500_000 if month == 7 else 80_000)) + Decimal("0.25")
                    debit, credit = Decimal(0), amt
                else:
                    amt = Decimal(rng.randint(50, 30_000)) + Decimal("0.10")
                    debit, credit = amt, Decimal(0)
                lines = [rng.choice(LABELS)] + (["REF 2025-" + str(rng.randint(1000, 9999))]
                                                if rng.random() < 0.3 else [])
                txns.append((date(year, month, day), lines, debit, credit))
                running += credit - debit
                if running > peak:
                    peak, peak_date = running, date(year, month, day)
        new_balance = balance + sum(t[3] - t[2] for t in txns)
        if month != skip_month:
            make_statement(folder / f"{rib.replace(" ", "")[-4:]}_{year}-{month:02d}.pdf", rib, balance, start_prev, end, txns)
        balance = new_balance
    return peak, peak_date


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(7)
    a = make_account(out, "230 780 0000000000000001 23", 2025, Decimal("18240.50"), rng, empty_months=(3,))
    b = make_account(out, "230 780 0000000000000002 45", 2025, Decimal("5200.00"), rng, skip_month=9)
    print(f"Expected account ...0001 23: max {fmt(a[0])} on {a[1]}")
    print(f"Expected account ...0002 45: max {fmt(b[0])} on {b[1]}  (September statement missing)")
