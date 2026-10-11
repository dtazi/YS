"""Independent offline pdfplumber reference for Attijariwafa and BMCE layouts.

Reads individual PDF characters at their actual coordinates (the browser uses
pdf.js words). Real statement data must never be printed to the model console.
"""
import re
import unicodedata
from datetime import timedelta
from decimal import Decimal
import pdfplumber
import fbar_cih as f


def cell(line, lo, hi):
    chars = sorted([c for c in line if lo <= (c['x0'] + c['x1']) / 2 < hi], key=lambda c: c['x0'])
    result, previous = '', None
    for c in chars:
        if previous is not None and c['x0'] - previous > 1.8:
            result += ' '
        result += c['text']
        previous = c['x1']
    return result.strip()


def compact(text):
    return re.sub(r'\s', '', text)


def fold(text):
    return ''.join(c for c in unicodedata.normalize('NFD', text) if not unicodedata.combining(c)).upper()


def date8(text):
    m = re.fullmatch(r'(\d{2})(\d{2})(\d{4})', compact(text))
    return f.to_date(*map(int, m.groups())) if m else None


def date_full(text):
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', compact(text))
    return f.to_date(*map(int, m.groups())) if m else None


def money(text, stmt, page, required=False):
    value = f.parse_amount(text) if text else (None if required else Decimal(0))
    if value is None:
        stmt.warnings.append(f'p{page}: unreadable amount in a bank table cell.')
    return value


def signed(text, label, stmt, page):
    value = money(text, stmt, page, True)
    if 'DEBITEUR' in label.upper():
        return -value if value is not None else None
    if 'CREDITEUR' in label.upper():
        return value
    stmt.warnings.append(f'p{page}: balance credit/debit designation could not be read.')
    return None


def opening_balance(text, stmt, page):
    match = re.fullmatch(r'(-?[\d .]+,\d{2})\s*(CREDITEUR|DEBITEUR)', text, re.I)
    if not match:
        stmt.warnings.append(f'p{page}: unreadable amount or designation in the starting balance.')
        return None
    return signed(match[1], match[2], stmt, page)


def parse_attijari(path):
    statements, stmt, pending, expected_pages = [], None, [], None

    def finish():
        nonlocal stmt, pending, expected_pages
        if stmt is None:
            return
        for oper, value, description, debit, credit, page in pending:
            d = f.resolve_date(oper[:2] + '/' + oper[2:], stmt)
            if not d:
                stmt.warnings.append(f'p{page}: unreadable date in a transaction.')
                continue
            v = date8(value)
            if not v:
                stmt.warnings.append(f'p{page}: unreadable date in a value-date cell.')
            stmt.transactions.append(f.Transaction(d, v, description, debit or Decimal(0), credit or Decimal(0), page=page))
        if expected_pages is not None and stmt.last_page - stmt.first_page + 1 != expected_pages:
            stmt.warnings.append('The statement page count does not match its printed page count.')
        statements.append(stmt)
        stmt, pending, expected_pages = None, [], None

    with pdfplumber.open(path) as pdf:
        for n, page in enumerate(pdf.pages, 1):
            lines = f.group_lines(page.chars)
            opening = next((l for l in lines if 280 < l[0]['top'] < 310 and re.match(r'SOLDE\s+', cell(l, 150, 310), re.I)), None)
            if opening:
                finish()
            if stmt is None:
                stmt = f.Statement(path, first_page=n)
            stmt.last_page = n
            account = compact(cell([c for c in page.chars if 230 < c['top'] < 245], 340, 465))
            if re.fullmatch(r'\d{24}', account):
                if stmt.account and stmt.account != account:
                    stmt.warnings.append('Account changes within this statement.')
                else:
                    stmt.account = account
            page_line = next((l for l in lines if 270 < l[0]['top'] < 285), [])
            count = re.search(r'(\d+)/(\d+)', cell(page_line, 480, 520))
            if count:
                if expected_pages is None:
                    expected_pages = int(count[2])
                if int(count[1]) != n - stmt.first_page + 1 or expected_pages != int(count[2]):
                    stmt.warnings.append(f'p{n}: unexpected printed page number.')
            else:
                stmt.warnings.append(f'p{n}: printed page number could not be read.')
            if opening:
                stmt.open_date = date8(re.sub(r'[^0-9]', '', cell(opening, 248, 310)))
                stmt.opening = opening_balance(cell(opening, 370, 510), stmt, n)
            for l in lines:
                upper = fold(cell(l, 150, 300))
                if re.search(r'SOLDE\s+FINAL', upper):
                    stmt.close_date = date8(cell(l, 240, 300))
                    stmt.closing = signed(cell(l, 328, 395), cell(l, 395, 510), stmt, n)
                elif re.search(r'TOTAL\s+MOUVEMENTS', upper):
                    stmt.total_debit = money(cell(l, 328, 418), stmt, n, True)
                    stmt.total_credit = money(cell(l, 418, 512), stmt, n, True)
                elif 330 < l[0]['top'] < 590:
                    oper = compact(cell(l, 80, 106))
                    debit, credit = cell(l, 328, 418), cell(l, 418, 512)
                    if not re.fullmatch(r'\d{4}', oper):
                        if re.search(r'\d', debit + credit + oper):
                            stmt.warnings.append(f'p{n}: line not understood, ignored.')
                        continue
                    pending.append((oper, compact(cell(l, 274.5, 328)), cell(l, 106, 274.5),
                                    money(debit, stmt, n), money(credit, stmt, n), n))
    finish()
    for s in statements:
        if len(statements) > 1:
            s.display_name += f' (pages {s.first_page}–{s.last_page})'
        f.check_statement(s)
    return statements


def parse_bmce(path):
    stmt = f.Statement(path, first_page=1)
    expected_count, snapshot = None, None
    with pdfplumber.open(path) as pdf:
        stmt.last_page = len(pdf.pages)
        for l in f.group_lines(pdf.pages[0].chars):
            upper = fold(cell(l, 0, 600))
            match = re.search(r'(\d{2}/\d{2}/\d{4})AU(\d{2}/\d{2}/\d{4})', compact(upper))
            if match:
                start = date_full(match[1])
                stmt.open_date = start - timedelta(days=1) if start else None
                stmt.close_date = date_full(match[2])
            if re.search(r'SOLDE\s+REEL', upper):
                snapshot = money(cell(l, 300, 370), stmt, 1, True)
                account = compact(cell(l, 70, 200))
                if re.fullmatch(r'\d{24}', account):
                    stmt.account = account
            if re.search(r'TOTAL\s+DES.*MOUVEMENTS', upper):
                raw = compact(cell(l, 295, 315))
                expected_count = int(raw) if raw.isdigit() else None
                stmt.total_debit = money(cell(l, 385, 472), stmt, 1, True)
                stmt.total_credit = money(cell(l, 472, 559), stmt, 1, True)
        current = None
        for n, page in enumerate(pdf.pages, 1):
            for l in f.group_lines(page.chars):
                if l[0]['top'] < (350 if n == 1 else 35) or l[0]['top'] > 765:
                    continue
                oper, description = cell(l, 35, 117.5), cell(l, 244, 384.5)
                if re.fullmatch(r'\d{2}/\d{2}/\d{4}', oper):
                    d, v = date_full(oper), date_full(cell(l, 117.5, 188))
                    if not d or not v:
                        stmt.warnings.append(f'p{n}: unreadable date in a transaction.')
                    if not d:
                        current = None
                        continue
                    current = f.Transaction(d, v, description,
                        money(cell(l, 385, 472), stmt, n, True) or Decimal(0),
                        money(cell(l, 472, 559), stmt, n, True) or Decimal(0), page=n)
                    stmt.transactions.append(current)
                elif current is not None and description and not oper:
                    current.description += ' ' + description
                elif re.search(r'\d', oper):
                    stmt.warnings.append(f'p{n}: line not understood, ignored.')
    if expected_count is None or expected_count != len(stmt.transactions):
        stmt.warnings.append('The transaction count does not match the total selected movements.')
    if any(a.op_date < b.op_date for a, b in zip(stmt.transactions, stmt.transactions[1:])):
        stmt.warnings.append('The transaction history is not in the expected reverse date order.')
    stmt.transactions.reverse()
    if snapshot is not None:
        stmt.closing = snapshot
        stmt.opening = snapshot - sum((t.credit - t.debit for t in stmt.transactions), Decimal(0))
    stmt.warnings.append('Balance anchor is provisional: SOLDE REEL is an undated online balance. '
        'The opening balance and yearly maximum assume it equals the closing balance of the selected period. '
        'Obtain a dated opening or closing statement before using these figures for filing. '
        'Transactions on the same day were replayed in reverse displayed order; their exact posting sequence is unconfirmed.')
    f.check_statement(stmt)
    return [stmt]


def parse_statements(path, bank):
    if bank == 'attijari':
        return parse_attijari(path)
    if bank == 'bmce':
        return parse_bmce(path)
    return f.parse_statements(path)
