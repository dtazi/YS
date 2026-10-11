"""Invented positioned-text fixtures; no real customer data."""
import sys
from pathlib import Path
from reportlab.pdfgen import canvas

H = 842


def text(c, x, top, value, font='Courier-Bold', size=8, right=False):
    c.setFont(font, size)
    draw = c.drawRightString if right else c.drawString
    draw(x, H - top - size * .8, value)


def attijari_header(c, page, total, opening=None, start=None):
    text(c, 344, 235, '011222000000000000000133')
    text(c, 450, 276, 'PAGE', 'Times-Roman')
    text(c, 494, 276, f'{page}/{total}', 'Times-Roman')
    if opening is not None:
        text(c, 166, 296, 'SOLDE DEPART AU', 'Times-Bold')
        text(c, 255, 296, start, 'Times-Bold')
        text(c, 425, 296, opening, 'Times-Bold', right=True)
        text(c, 432, 296, 'CREDITEUR', 'Times-Bold')


def attijari_row(c, top, day, month, description, debit='', credit=''):
    text(c, 50.4, top, '1234GG')
    text(c, 80.6, top, day)
    text(c, 95, top, month)
    text(c, 110.2, top, description)
    # Deliberately adjacent label/value date: extraction must split MAD05 at the column boundary.
    text(c, 261.1, top, 'MAD')
    text(c, 275.7, top, day)
    text(c, 290, top, month)
    text(c, 304.4, top, '2025')
    if debit:
        text(c, 415.9, top, debit, right=True)
    if credit:
        text(c, 506, top, credit, right=True)


def attijari_footer(c, end, closing, debit, credit, sign='CREDITEUR'):
    text(c, 157.7, 530, 'TOTAL MOUVEMENTS')
    text(c, 415.9, 530, debit, right=True)
    text(c, 506, 530, credit, right=True)
    text(c, 157.7, 599, 'SOLDE  FINAL  AU')
    for x, part in zip([243.7, 258, 270.8], end.split('/')):
        text(c, x, 599, part)
    text(c, 392.2, 599, closing, right=True)
    text(c, 401.8, 599, sign)


def create_attijari(folder):
    c = canvas.Canvas(str(folder / 'invented-attijari.pdf'), pagesize=(595, H))
    attijari_header(c, 1, 2, '1000,00', '31122024')
    attijari_row(c, 335, '03', '01', 'FAKE CREDIT', credit='200,00')
    attijari_row(c, 355, '05', '01', 'FAKE PAYMENT', debit='300,00')
    c.showPage()
    attijari_header(c, 2, 2)
    attijari_row(c, 335, '05', '01', 'FAKE CREDIT', credit='100,00')
    attijari_footer(c, '31/01/2025', '1000,00', '300,00', '300,00')
    c.showPage()
    attijari_header(c, 1, 1, '1000,00', '31012025')
    attijari_row(c, 335, '02', '02', 'FAKE PAYMENT', debit='1100,00')
    attijari_footer(c, '28/02/2025', '100,00', '1100,00', '0,00', 'DEBITEUR')
    c.showPage()
    c.save()


def create_bmce(folder, bad=False):
    c = canvas.Canvas(str(folder / ('invented-bmce-bad.pdf' if bad else 'invented-bmce.pdf')), pagesize=(595, H))
    text(c, 36.6, 57, 'Compte', 'Times-Roman', 10)
    text(c, 70.8, 57, '011 222 0000000000000001 33', 'Times-Roman', 10)
    text(c, 211.6, 57, 'Solde réel', 'Times-Roman', 10)
    text(c, 366.6, 57, '900,00', 'Times-Roman', 10, right=True)
    text(c, 38, 221, 'Date opération', 'Times-Roman', 10)
    text(c, 169.2, 221, '01/01/2025AU31/12/2025', 'Times-Roman', 10)
    text(c, 249, 328, 'Total des', 'Times-Bold', 10)
    text(c, 296.3, 328, '4' if bad else '3', 'Times-Bold', 10)
    text(c, 317.3, 328, 'mouvements', 'Times-Bold', 10)
    text(c, 468.5, 328, '200,00', 'Times-Bold', 10, right=True)
    text(c, 555.8, 328, '600,00', 'Times-Bold', 10, right=True)
    rows = [('31/12/2025', 'FAKE CREDIT', '0,00', '100,00'),
            ('02/01/2025', 'FAKE PAYMENT', '200,00', '0,00'),
            ('02/01/2025', 'FAKE CREDIT', '0,00', '500,00')]
    for top, (day, label, debit, credit) in zip([360, 400, 440], rows):
        text(c, 53.4, top, day, 'Times-Roman', 10)
        text(c, 129.6, top, day, 'Times-Roman', 10)
        text(c, 205.3, top, '1234', 'Times-Roman', 10)
        text(c, 246.3, top, label, 'Times-Roman', 10)
        text(c, 468.5, top, debit, 'Times-Roman', 10, right=True)
        text(c, 555.8, top, credit, 'Times-Roman', 10, right=True)
    c.save()


if __name__ == '__main__':
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    create_attijari(folder)
    create_bmce(folder)
    create_bmce(folder, bad=True)
