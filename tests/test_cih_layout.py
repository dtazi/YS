"""Regression checks using invented merged statements only."""
from datetime import date
from decimal import Decimal
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import fbar_cih
from make_fake_statements import draw_page, row, y, W, H
from reportlab.pdfgen import canvas


class CihLayoutTest(unittest.TestCase):
    def test_merged_statements_with_overlapping_header_and_metadata_rules(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "invented-merged.pdf"
            c = canvas.Canvas(str(path), pagesize=(W, H))
            rib = "230 780 0000000000000001 23"
            periods = [
                (date(2024, 12, 31), date(2025, 1, 31), Decimal("1000"), Decimal("0"), Decimal("250")),
                (date(2025, 1, 31), date(2025, 2, 28), Decimal("1250"), Decimal("100"), Decimal("0")),
            ]
            for start, end, opening, debit, credit in periods:
                draw_page(c, rib, 1, 1)
                # Metadata box rules must not be mistaken for transaction columns.
                c.line(84.9, y(175), 84.9, y(194))
                # Another font's text run overlaps the operation-date heading.
                c.setFont("Courier", 9)
                c.drawString(20, y(292), "  ")
                row(c, 301, desc=f"SOLDE DEPART AU : {start:%d/%m/%Y}", credit=opening)
                row(c, 315, oper=f"05/{end:%m}", valeur=f"05/{end:%m}", desc="FAKE TRANSFER",
                    debit=debit or None, credit=credit or None)
                row(c, 685, desc="TOTAL DES MOUVEMENTS", debit=debit, credit=credit)
                row(c, 696, desc=f"NOUVEAU SOLDE AU {end:%d/%m/%Y}", credit=opening + credit - debit)
                c.showPage()
            c.save()
            statements = fbar_cih.parse_statements(path)
            self.assertEqual(len(statements), 2)
            for i, (s, expected) in enumerate(zip(statements, periods), 1):
                start, end, opening, debit, credit = expected
                self.assertEqual((s.first_page, s.last_page), (i, i))
                self.assertEqual((s.open_date, s.close_date), (start, end))
                self.assertEqual(s.opening, opening)
                self.assertEqual(s.closing, opening + credit - debit)
                self.assertEqual((s.total_debit, s.total_credit), (debit, credit))
                self.assertEqual(s.warnings, [])
                self.assertEqual(len(s.transactions), 1)
                self.assertEqual((s.transactions[0].debit, s.transactions[0].credit), (debit, credit))
            peak = max(fbar_cih.year_events(statements, 2025), key=lambda event: event[1])
            self.assertEqual(peak[:2], (date(2025, 1, 5), Decimal("1250")))


if __name__ == "__main__":
    unittest.main()
