#!/usr/bin/env python3
"""Find the maximum yearly balance of CIH Bank accounts (for FBAR) from PDF statements.

Runs fully offline. Reads the "RELEVE DE COMPTE BANCAIRE" PDFs (one PDF may hold several
statements), rebuilds the running balance after every transaction, checks each statement
adds up, and reports the highest balance per account for the requested year, and the
balance on Dec 31.

Usage:
    python fbar_cih.py STATEMENTS_DIR --year 2025 [--rate 10.05] [--out results]

--rate is the U.S. Treasury Reporting Rate of Exchange for MAD on Dec 31 of the year
(MAD per 1 USD). FBAR converts the maximum value at that rate and rounds up.
"""
import argparse
import csv
import math
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pdfplumber

DATE_RE = re.compile(r"^(\d{2})[/.-](\d{2})(?:[/.-](\d{2}|\d{4}))?$")
INLINE_DATE_RE = re.compile(r"(\d{2})[/.-](\d{2})[/.-](\d{4})")
AMOUNT_RE = re.compile(r"^-?\d{1,3}(?:[ .]?\d{3})*,\d{2}$")
LINE_TOLERANCE = 3  # points; words closer than this vertically are on the same line
DATE_TOLERANCE_DAYS = 7  # operation dates this close to the statement period are normal (late bookings)
UNKNOWN_ACCOUNT = "UNKNOWN ACCOUNT"


@dataclass
class Transaction:
    op_date: date
    value_date: date | None
    description: str
    debit: Decimal = Decimal("0")
    credit: Decimal = Decimal("0")
    balance_after: Decimal | None = None
    page: int = 0  # 1-based page of the PDF where the transaction's dated line is


@dataclass
class Statement:
    path: Path
    account: str = ""
    open_date: date | None = None
    opening: Decimal | None = None
    close_date: date | None = None
    closing: Decimal | None = None
    total_debit: Decimal | None = None
    total_credit: Decimal | None = None
    transactions: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    first_page: int = 0  # pages of the PDF holding this statement (a PDF can hold several statements)
    last_page: int = 0
    display_name: str = ""  # file name, plus the pages when the file holds several statements

    def __post_init__(self):
        self.display_name = self.display_name or self.path.name


def parse_amount(text):
    text = text.replace(" ", " ").strip()
    if not AMOUNT_RE.match(text):
        return None
    return Decimal(text.replace(" ", "").replace(".", "").replace(",", "."))


def group_lines(words):
    lines = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= LINE_TOLERANCE:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(line, key=lambda w: w["x0"]) for line in lines]


def find_word(words, text):
    return next((w for w in words if w["text"] == text), None)


def find_vline(page, lo, hi, default, top, bottom):
    """x of the table's vertical rule between lo and hi, if the PDF draws one. Rules of any length count:
    some PDFs only draw the column borders in the header row. Slanted lines don't."""
    xs = [e["x0"] for e in page.edges
          if e["orientation"] == "v" and e["x1"] - e["x0"] < 1 and lo < e["x0"] < hi
          and e["top"] <= bottom and e["bottom"] >= top]
    return max(xs) if xs else default


def column_layout(page, words):
    """Locate the transaction table columns from its header row. None if not a statement page."""
    debit, credit = find_word(words, "DEBIT"), find_word(words, "CREDIT")
    oper, valeur = find_word(words, "OPER"), find_word(words, "VALEUR")
    if not (debit and credit and oper and valeur):
        return None
    # The description header "OPERATION-REFERENCE" can come out split ("OPERATION-R" + "EFERENCE"): take the
    # leftmost word starting with OPERATION on the DEBIT/CREDIT header line.
    desc = min((w for w in words if w["text"].startswith("OPERATION")
                and abs(w["top"] - debit["top"]) <= LINE_TOLERANCE), key=lambda w: w["x0"], default=None)
    if not desc:
        return None
    header_top = min(w["top"] for w in (debit, credit, oper, valeur))
    header_bottom = max(w["bottom"] for w in (debit, credit, oper, valeur))

    def rule(lo, hi, default):
        return find_vline(page, lo, hi, default, header_top, header_bottom)

    return {
        "header_bottom": header_bottom,
        "oper_end": rule(oper["x1"], valeur["x0"], valeur["x0"] - 2),
        "date_end": rule(valeur["x1"], desc["x0"], valeur["x1"] + 3),
        "amount_start": rule(desc["x1"], debit["x0"] + 1, debit["x0"] - 3),
        "credit_start": rule(debit["x1"], credit["x0"] + 1, credit["x0"] - 3),
    }


def to_date(day, month, year):
    try:
        return date(year, month, day)
    except ValueError:
        return None


def days_outside(d, stmt):
    """0 when d is within the statement period [open_date, close_date], else how many days away it is."""
    if stmt.open_date and d < stmt.open_date:
        return (stmt.open_date - d).days
    if stmt.close_date and d > stmt.close_date:
        return (d - stmt.close_date).days
    return 0


def resolve_date(text, stmt):
    """Turn DD/MM, DD/MM/YY or DD/MM/YYYY into a date. A missing year is taken from the statement period:
    the candidate inside the period, else the one nearest to it (ties: nearest to the closing date)."""
    m = DATE_RE.match(text)
    if not m:
        return None
    day, month, year = int(m[1]), int(m[2]), m[3]
    if year:
        return to_date(day, month, int(year) + (2000 if len(year) == 2 else 0))
    ref = stmt.close_date or stmt.open_date
    if ref is None:
        return None
    candidates = [d for y in (ref.year - 1, ref.year, ref.year + 1) if (d := to_date(day, month, y))]
    return min(candidates, key=lambda d: (days_outside(d, stmt), abs((d - ref).days))) if candidates else None


def read_account(words):
    """The RIB is the line of digits under the BANQUE / VILLE / N° DE COMPTE / CLE header."""
    banque = find_word(words, "BANQUE")
    if not banque:
        return ""
    below = [w for w in words if banque["bottom"] < w["top"] < banque["bottom"] + 25]
    for line in group_lines(below):
        digits = "".join(re.sub(r"\D", "", w["text"]) for w in line)
        if len(digits) >= 10:
            return digits
    return ""


def read_page(page, page_no):
    """One page -> its account number, table layout and raw table rows (dates resolved later)."""
    # Keep overlapping text from different fonts in separate extraction groups. Otherwise
    # a background text run can split a table heading into individual letters.
    words = page.extract_words(keep_blank_chars=False, use_text_flow=False, extra_attrs=["fontname"])
    info = {"page": page_no, "has_text": bool(words), "account": read_account(words), "layout": None, "rows": []}
    layout = column_layout(page, words)
    if not layout:
        return info
    info["layout"] = layout
    footer = next((w["top"] for w in words if w["text"].lower() == "sauf"), page.height)
    # A word is in the table body when its vertical middle is below the header row.
    body = [w for w in words
            if (w["top"] + w["bottom"]) / 2 > layout["header_bottom"] and w["top"] < footer]
    for line in group_lines(body):
        dates, desc, debit, credit = [], [], [], []
        for w in line:
            if w["x0"] < layout["date_end"]:
                if DATE_RE.match(w["text"]):
                    dates.append((w["x0"] < layout["oper_end"], w["text"]))
            elif w["x1"] <= layout["amount_start"]:
                desc.append(w["text"])
            elif w["x1"] <= layout["credit_start"]:
                debit.append(w["text"])
            else:
                credit.append(w["text"])
        info["rows"].append({
            "page": page_no,
            "oper": next((t for is_oper, t in dates if is_oper), None),
            "valeur": next((t for is_oper, t in dates if not is_oper), None),
            "desc": " ".join(desc),
            "debit": parse_amount(" ".join(debit)) if debit else None,
            "credit": parse_amount(" ".join(credit)) if credit else None,
            "bad_amount": bool((debit and parse_amount(" ".join(debit)) is None)
                               or (credit and parse_amount(" ".join(credit)) is None)),
            "raw": " ".join(w["text"] for w in line),
        })
    return info


def split_statements(infos):
    """Pages -> groups of pages, one per statement. A page with a SOLDE DEPART line starts a new statement, and
    so does a table page after a statement's NOUVEAU SOLDE; other pages (continuation pages with REPORT lines,
    cover pages) belong to the current statement."""
    groups, cur = [], None
    for info in infos:
        starts = any(r["desc"].upper().startswith("SOLDE DEPART") for r in info["rows"])
        if cur is None or (info["layout"] and (cur["ended"] or (starts and cur["started"]))):
            cur = {"infos": [], "started": False, "ended": False}
            groups.append(cur)
        cur["infos"].append(info)
        cur["started"] = cur["started"] or starts
        cur["ended"] = cur["ended"] or any(r["desc"].upper().startswith("NOUVEAU SOLDE") for r in info["rows"])
    return groups or [{"infos": []}]


def build_statement(path, infos):
    """One group of pages -> one Statement."""
    stmt = Statement(path=path)
    if infos:
        stmt.first_page, stmt.last_page = infos[0]["page"], infos[-1]["page"]
    stmt.account = next((i["account"] for i in infos if i["account"]), "")
    pending = [row for i in infos for row in i["rows"]]
    if not any(i["has_text"] for i in infos):
        stmt.warnings.append("no text found: scanned PDF? run it through OCR (ocrmypdf) first")
        return stmt
    if not any(i["layout"] for i in infos):
        stmt.warnings.append("transaction table header not found: layout differs from what the script "
                             "expects (inspect it safely with tools/safe_inspect.py)")
        return stmt

    def readable(row):
        """The amounts of a balance or totals line can be used: at least one, and none unreadable."""
        return not row["bad_amount"] and (row["debit"] is not None or row["credit"] is not None)

    def signed(row):
        return (row["credit"] or Decimal("0")) - (row["debit"] or Decimal("0")) if readable(row) else None

    # First pass: balances and period, which the year inference for transaction dates needs.
    # An unreadable or missing amount leaves the balance unknown (None): it is reported, never taken as 0.
    for row in pending:
        upper = row["desc"].upper()
        if upper.startswith("SOLDE DEPART"):
            stmt.opening = signed(row)
            if m := INLINE_DATE_RE.search(row["desc"]):
                stmt.open_date = to_date(int(m[1]), int(m[2]), int(m[3]))
        elif upper.startswith("NOUVEAU SOLDE"):
            stmt.closing = signed(row)
            if m := INLINE_DATE_RE.search(row["desc"]):
                stmt.close_date = to_date(int(m[1]), int(m[2]), int(m[3]))
        elif upper.startswith("TOTAL DES MOUVEMENTS"):
            ok = readable(row)
            stmt.total_debit = (row["debit"] or Decimal("0")) if ok else None
            stmt.total_credit = (row["credit"] or Decimal("0")) if ok else None

    # Second pass: transactions. A dated row starts one; undated text rows continue its label.
    current = None
    for row in pending:
        upper = row["desc"].upper()
        if upper.startswith(("SOLDE DEPART", "NOUVEAU SOLDE", "TOTAL DES MOUVEMENTS")):
            if row["bad_amount"]:
                stmt.warnings.append(f"p{row['page']}: unreadable amount in line: {row['raw']}")
            current = None
            continue
        if upper.startswith(("REPORT", "A REPORTER", "À REPORTER")) and not row["oper"]:
            continue  # page carry-over lines (a dated line is a real transaction, whatever its label)
        if row["bad_amount"]:
            stmt.warnings.append(f"p{row['page']}: unreadable amount in line: {row['raw']}")
        if row["oper"]:
            op_date = resolve_date(row["oper"], stmt)
            if op_date is None:
                stmt.warnings.append(f"p{row['page']}: unreadable date in line: {row['raw']}")
                current = None
                continue
            current = Transaction(op_date, resolve_date(row["valeur"], stmt) if row["valeur"] else None,
                                  row["desc"], row["debit"] or Decimal("0"), row["credit"] or Decimal("0"),
                                  page=row["page"])
            stmt.transactions.append(current)
        elif current is not None and not (current.debit or current.credit) and (row["debit"] or row["credit"]):
            current.debit, current.credit = row["debit"] or Decimal("0"), row["credit"] or Decimal("0")
            current.description = f"{current.description} {row['desc']}".strip()
        elif current is not None and row["desc"] and not (row["debit"] or row["credit"]):
            current.description = f"{current.description} {row['desc']}".strip()
        elif row["desc"] or row["debit"] or row["credit"]:
            stmt.warnings.append(f"p{row['page']}: line not understood, ignored: {row['raw']}")

    check_statement(stmt)
    return stmt


def parse_statements(path):
    """All the statements in one PDF (often one, but a download can hold e.g. 12 monthly statements)."""
    with pdfplumber.open(path) as pdf:
        infos = [read_page(page, page_no) for page_no, page in enumerate(pdf.pages, 1)]
    statements = [build_statement(path, g["infos"]) for g in split_statements(infos)]
    if len(statements) > 1:
        for s in statements:
            pages = f"page {s.first_page}" if s.first_page == s.last_page else f"pages {s.first_page}-{s.last_page}"
            s.display_name = f"{path.name} ({pages})"
    return statements


def parse_statement(path):
    """The first statement of the PDF (kept for tools that expect one statement per file)."""
    return parse_statements(path)[0]


def check_statement(stmt):
    for t in stmt.transactions:
        if days_outside(t.op_date, stmt) > DATE_TOLERANCE_DAYS:
            stmt.warnings.append(f"p{t.page}: operation date {t.op_date} outside the statement period "
                                 f"({stmt.open_date} to {stmt.close_date}): {t.description}")
    for name in ("opening", "closing", "open_date", "close_date"):
        if getattr(stmt, name) is None:
            stmt.warnings.append(f"missing {name.replace('_', ' ')}")
    if stmt.opening is None:
        return
    balance = stmt.opening
    for t in stmt.transactions:
        balance += t.credit - t.debit
        t.balance_after = balance
    if stmt.closing is not None and balance != stmt.closing:
        stmt.warnings.append(f"does not add up: opening + movements = {fmt(balance)}, "
                             f"statement closing = {fmt(stmt.closing)}")
    debits = sum((t.debit for t in stmt.transactions), Decimal("0"))
    credits = sum((t.credit for t in stmt.transactions), Decimal("0"))
    if stmt.total_debit is not None and (debits, credits) != (stmt.total_debit, stmt.total_credit):
        stmt.warnings.append(f"totals differ: read {fmt(debits)} / {fmt(credits)}, "
                             f"statement says {fmt(stmt.total_debit)} / {fmt(stmt.total_credit)}")


def fmt(amount):
    return f"{amount:,.2f}".replace(",", " ").replace(".", ",")


def booked_date(d, stmt):
    """The day a balance change counts for: its date, kept within the statement period (open_date, close_date].
    A statement holds what was booked during its period: a card payment dated 31/12 that appears on the
    January statement changed the balance in January, not in December."""
    if stmt.close_date and d > stmt.close_date:
        d = stmt.close_date
    if stmt.open_date and d <= stmt.open_date:
        d = stmt.open_date + timedelta(days=1)
    return d


def balance_events(s):
    """(date, balance, label) for every moment statement s set the balance, in statement order."""
    events = []
    if s.opening is not None and s.open_date:
        events.append((s.open_date + timedelta(days=1), s.opening, f"opening balance ({s.display_name})"))
    for t in s.transactions:
        if t.balance_after is not None:
            events.append((booked_date(t.op_date, s), t.balance_after, t.description))
    return events


def year_events(statements, year):
    """(date, balance, label) for every moment the balance was set during the year, plus, for a statement
    whose period started before the year, the balance it carried into Jan 1."""
    events = []
    jan1 = date(year, 1, 1)
    for s in statements:
        own = balance_events(s)
        if s.open_date and s.close_date and s.open_date + timedelta(days=1) < jan1 <= s.close_date:
            before = [e for e in own if e[0] < jan1]
            if before:
                events.append((jan1, before[-1][1], before[-1][2]))
        events += [e for e in own if e[0].year == year]
    return events


def year_end(statements, year):
    """(date, balance) held at the end of Dec 31: the last balance change on or before that day, in the last
    statement whose period covers Dec 31 (open_date < Dec 31 <= close_date). None if no statement covers it.
    statements must be sorted by open_date."""
    dec31 = date(year, 12, 31)
    covering = [s for s in statements if s.opening is not None and s.open_date and s.close_date
                and s.open_date < dec31 <= s.close_date]
    if not covering:
        return None
    last = [e for e in balance_events(covering[-1]) if e[0] <= dec31][-1]
    return last[0], last[1]


def usd(amount, rate):
    """FBAR conversion: MAD / (MAD per USD), rounded up to the next dollar; 0 for a balance <= 0."""
    return math.ceil(amount / rate) if amount > 0 else 0


def coverage_gaps(statements, year):
    """Periods of the year not covered by any statement, and breaks between consecutive statements."""
    issues = []
    dated = sorted((s for s in statements if s.open_date and s.close_date), key=lambda s: s.open_date)
    covered_until = date(year - 1, 12, 31)
    for s in dated:
        if s.close_date < date(year - 1, 12, 31) or s.open_date > date(year, 12, 31):
            continue
        if s.open_date > covered_until:
            issues.append(f"no statement for {covered_until + timedelta(days=1)} to {s.open_date}")
        covered_until = max(covered_until, s.close_date)
    if covered_until < date(year, 12, 31):
        issues.append(f"no statement after {covered_until}")
    for prev, nxt in zip(dated, dated[1:]):
        if prev.closing is not None and nxt.opening is not None and prev.closing != nxt.opening \
                and prev.close_date == nxt.open_date:
            issues.append(f"{nxt.display_name} opens at {fmt(nxt.opening)} but "
                          f"{prev.display_name} closed at {fmt(prev.closing)}")
    return issues


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="folder containing the statement PDFs (searched recursively)")
    ap.add_argument("--year", type=int, required=True, help="calendar year being reported")
    ap.add_argument("--rate", type=Decimal, help="Treasury MAD-per-USD rate for Dec 31 of that year")
    ap.add_argument("--out", type=Path, default=Path("results"), help="folder for the CSV outputs")
    args = ap.parse_args()

    pdfs = sorted(args.folder.rglob("*.pdf")) + sorted(args.folder.rglob("*.PDF"))
    if not pdfs:
        sys.exit(f"No PDF found in {args.folder}")

    by_account = defaultdict(list)
    for path in pdfs:
        for stmt in parse_statements(path):
            by_account[stmt.account or UNKNOWN_ACCOUNT].append(stmt)

    args.out.mkdir(parents=True, exist_ok=True)
    with open(args.out / "transactions.csv", "w", newline="") as tf, \
            open(args.out / "statements.csv", "w", newline="") as sf:
        tw, sw = csv.writer(tf), csv.writer(sf)
        tw.writerow(["account", "file", "page", "operation_date", "value_date", "description",
                     "debit", "credit", "balance_after"])
        sw.writerow(["account", "file", "period_start", "period_end", "opening", "total_debit",
                     "total_credit", "closing", "transactions", "status"])
        for account, stmts in by_account.items():
            for s in sorted(stmts, key=lambda s: s.open_date or date.min):
                sw.writerow([account, s.path.name, s.open_date, s.close_date, s.opening, s.total_debit,
                             s.total_credit, s.closing, len(s.transactions),
                             "OK" if not s.warnings else " | ".join(s.warnings)])
                for t in s.transactions:
                    tw.writerow([account, s.path.name, t.page, t.op_date, t.value_date, t.description,
                                 t.debit, t.credit, t.balance_after])

    problems = 0
    print(f"\nFBAR maximum balance, calendar year {args.year}\n" + "=" * 46)
    for account, stmts in by_account.items():
        stmts.sort(key=lambda s: s.open_date or date.min)
        print(f"\nAccount {account}  ({len(stmts)} statements)")
        if account == UNKNOWN_ACCOUNT:
            problems += 1
            print("  ! account number not found: these statements cannot be attributed to an account")
        for s in stmts:
            for w in s.warnings:
                problems += 1
                print(f"  ! {s.display_name}: {w}")
        for issue in coverage_gaps(stmts, args.year):
            problems += 1
            print(f"  ! {issue}")
        events = year_events(stmts, args.year)
        if not events:
            print("  no balance found for this year")
        else:
            when, peak, label = max(events, key=lambda e: e[1])
            print(f"  Maximum balance: {fmt(peak)} MAD on {when}  ({label})")
            if args.rate:
                print(f"  In USD at {args.rate} MAD/USD, rounded up: ${usd(peak, args.rate):,}")
        end = year_end(stmts, args.year)
        if end is None:
            print(f"  Balance on Dec 31: unknown (no statement covers Dec 31, {args.year})")
        else:
            print(f"  Balance on Dec 31: {fmt(end[1])} MAD  (last change on {end[0]})")
            if args.rate:
                print(f"  Dec 31 balance in USD at {args.rate} MAD/USD, rounded up: ${usd(end[1], args.rate):,}")

    print(f"\nDetails written to {args.out}/transactions.csv and {args.out}/statements.csv")
    if problems:
        print(f"\n{problems} problem(s) above: check them before using these figures.")
    else:
        print("\nAll statements add up and the year is fully covered.")


if __name__ == "__main__":
    main()
