"""Generate fake CIH statements for edge cases (invented data), reusing the layout of make_fake_statements.py.

Usage: python tests/make_edge_statements.py OUTDIR

Writes, for calendar year 2025:
  0367_*  account ...0003 67: overdraft (negative balances shown in the DEBIT column), amounts >= 1 000 000,00,
          DD/MM/YYYY and DD/MM/YY transaction dates, a DD/MM date from the previous year (31/12 on a
          January statement), and a second statement whose opening differs from the first one's closing.
  0489_*  account ...0004 89: a tampered statement (one printed amount differs from what the closing implies).
  0512_*  account ...0005 12: an unreadable amount, a line that cannot be attached to a transaction, and an
          impossible date (31/02).
  scanned.pdf      no text at all (only drawings), like a scan.
  letter.pdf       a PDF with text that is not a statement.
"""
import sys
from datetime import date
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_fake_statements import A4, BODY_TOP, LINE, canvas, draw_page, fmt, row, y  # noqa: E402


def small_dates(c, top, oper=None, valeur=None):
    """Full dates (DD/MM/YYYY) only fit the narrow date columns in a small font; the baseline is raised so
    the words' tops line up with the 8pt text of the same row."""
    c.setFont("Courier", 4)
    if oper:
        c.drawString(15.5, y(top - 3.2), oper)
    if valeur:
        c.drawString(43, y(top - 3.2), valeur)


def statement(path, rib, open_date, opening, close_date, lines, totals=None, closing=None):
    """lines: dicts with oper/valeur/desc/debit/credit (+ small=True for full dates). Amounts as Decimal.
    totals/closing default to what the lines add up to; pass them to print something else (tampering)."""
    c = canvas.Canvas(str(path), pagesize=A4)
    draw_page(c, rib, 1, 1)
    top = BODY_TOP
    row(c, top, desc=f"SOLDE DEPART AU :     {open_date:%d/%m/%Y}",
        **({"credit": opening} if opening >= 0 else {"debit": -opening}))
    balance, debits, credits = opening, D(0), D(0)
    for ln in lines:
        top += LINE
        ln = dict(ln)
        if ln.pop("small", False):
            small_dates(c, top, ln.pop("oper", None), ln.pop("valeur", None))
        true_debit, true_credit = ln.pop("true_debit", None), ln.pop("true_credit", None)
        row(c, top, **ln)
        debit = true_debit if true_debit is not None else (ln.get("debit") or D(0))
        credit = true_credit if true_credit is not None else (ln.get("credit") or D(0))
        debits, credits = debits + debit, credits + credit
        balance += credit - debit
    totals = totals or (debits, credits)
    closing = balance if closing is None else closing
    row(c, 685, desc="TOTAL DES MOUVEMENTS", debit=totals[0], credit=totals[1])
    row(c, 696, desc=f"NOUVEAU SOLDE AU      {close_date:%d/%m/%Y}",
        **({"credit": closing} if closing >= 0 else {"debit": -closing}))
    c.save()
    return balance


def raw_row(c, top, debit_text):
    """A row whose DEBIT cell holds arbitrary text (for unreadable amounts)."""
    c.setFont("Courier", 8)
    c.drawString(15.5, y(top), "12/03")
    c.drawString(43, y(top), "13/03")
    c.drawString(76, y(top), "PAIEMENT CARTE MARJANE")
    c.drawRightString(480.5, y(top), debit_text)


def main(out):
    out.mkdir(parents=True, exist_ok=True)

    # --- account 0003: overdraft, big amounts, full dates, year boundary, broken chain
    rib = "230 780 0000000000000003 67"
    jan_close = statement(out / "0367_2025-01.pdf", rib, date(2024, 12, 31), D("-1234.56"), date(2025, 1, 31), [
        dict(oper="31/12", valeur="31/12", desc="FRAIS TENUE DE COMPTE", debit=D("100.00")),  # 2024-12-31
        dict(oper="05/01/2025", valeur="06/01/2025", small=True, desc="VIR RECU DE SARL ATLAS TRADING",
             credit=D("1250000.00")),
        dict(desc="REF 2025-1111"),
        dict(oper="20/01/25", valeur="21/01/25", small=True, desc="RETRAIT GAB CASA ANFA", debit=D("300000.10")),
        dict(oper="28/01", valeur="29/01", desc="VERSEMENT ESPECES AGENCE", credit=D("12345678.90")),
    ])
    statement(out / "0367_2025-02.pdf", rib, date(2025, 1, 31), jan_close + D("1.00"), date(2025, 2, 28), [
        dict(oper="03/02", valeur="04/02", desc="VIR EMIS VERS COMPTE EPARGNE", debit=D("13300000.00")),
        dict(oper="10/02", valeur="10/02", desc="PRELEVEMENT REDAL", debit=D("250.00")),
    ])

    # --- account 0004: tampered amount (printed 1 500,00 but the closing/totals imply 1 400,00)
    statement(out / "0489_2025-01.pdf", "230 780 0000000000000004 89", date(2024, 12, 31), D("5000.00"),
              date(2025, 1, 31), [
                  dict(oper="07/01", valeur="08/01", desc="PAIEMENT CARTE MARJANE", debit=D("1500.00"),
                       true_debit=D("1400.00")),
                  dict(oper="15/01", valeur="15/01", desc="VERSEMENT ESPECES AGENCE", credit=D("2000.00")),
              ])

    # --- account 0005: unreadable amount, orphan line, impossible date
    rib5 = "230 780 0000000000000005 12"
    c = canvas.Canvas(str(out / "0512_2025-03.pdf"), pagesize=A4)
    draw_page(c, rib5, 1, 1)
    top = BODY_TOP
    row(c, top, desc="SOLDE DEPART AU :     28/02/2025", credit=D("800.00"))
    top += LINE
    row(c, top, desc="FRAIS DIVERS", debit=D("10.00"))           # no date and no transaction before it
    top += LINE
    raw_row(c, top, "12,3")                                        # not a valid amount
    top += LINE
    row(c, top, oper="31/02", valeur="01/03", desc="RETRAIT GAB CASA ANFA", debit=D("50.00"))  # no 31 Feb
    top += LINE
    row(c, top, oper="15/03", valeur="15/03", desc="VIR RECU DE SARL ATLAS TRADING", credit=D("200.00"))
    row(c, 685, desc="TOTAL DES MOUVEMENTS", debit=D("0"), credit=D("200.00"))
    row(c, 696, desc="NOUVEAU SOLDE AU      31/03/2025", credit=D("1000.00"))
    c.save()

    # --- a "scanned" PDF: drawings only, no text
    c = canvas.Canvas(str(out / "scanned.pdf"), pagesize=A4)
    c.setFillGray(0.85)
    c.rect(40, 100, 500, 600, fill=1, stroke=0)
    for i in range(30):
        c.line(60, 150 + i * 18, 520, 150 + i * 18)
    c.save()

    # --- a PDF that is not a statement
    c = canvas.Canvas(str(out / "letter.pdf"), pagesize=A4)
    c.setFont("Helvetica", 11)
    for i, text in enumerate(["Objet : attestation de solde", "Madame, Monsieur,",
                              "Nous certifions que le client TEST CLIENT FICTIF est titulaire d'un compte.",
                              "Fait a Casablanca, le 15/01/2025"]):
        c.drawString(60, y(120 + i * 20), text)
    c.save()


if __name__ == "__main__":
    main(Path(sys.argv[1]))
