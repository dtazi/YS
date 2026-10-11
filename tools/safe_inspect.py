#!/usr/bin/env python3
"""Inspect real bank statements WITHOUT revealing their content.

Everything this prints is meant to be read by someone who must NOT see the data (e.g. an AI assistant
adapting the parser to a new bank). It shows the page layout with every letter masked as x and every
digit as 9, except generic banking words (DEBIT, SOLDE, ...), and the parser's checks as yes/no.
File names, names, addresses, account numbers, amounts and transaction details never appear.

    .venv/bin/python -I tools/safe_inspect.py layout FOLDER [--pages 1,2,-1] [--png-dir DIR]
    .venv/bin/python -I tools/safe_inspect.py check FOLDER
"""
import argparse
import contextlib
import logging
import os
import re
import sys
import unicodedata
import warnings
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Generic, non-personal words shown as-is (compared without accents, uppercase). Never add names,
# streets, cities or anything that could identify a person.
SAFE_WORDS = set("""
DATE DATES OPER OPERATION OPERATIONS VALEUR VAL LIBELLE LIBELLES DESIGNATION NATURE REFERENCE REFERENCES REF
DEBIT DEBITS CREDIT CREDITS SOLDE SOLDES DEPART INITIAL FINAL NOUVEAU NOUVEL ANCIEN PRECEDENT REPORT REPORTER
REPORTE TOTAL TOTAUX MOUVEMENT MOUVEMENTS MONTANT MONTANTS DEVISE DEVISES DIRHAM DIRHAMS MAROCAIN MAD DH DHS
COMPTE COMPTES RELEVE RELEVES EXTRAIT EXTRAITS PERIODE PAGE PAGES RIB IBAN BIC SWIFT CLE CODE BANQUE AGENCE
GUICHET VILLE TITULAIRE CLIENT CREDITEUR CREDITRICE DEBITEUR DEBITRICE COURANT EPARGNE TYPE NUMERO NO NUM
INTITULE ARRETE ARRETEE SITUATION DISPONIBLE FIN DEBUT MOIS ANNEE COMPTABLE EFFET
VIREMENT VIREMENTS VIR VIRT RETRAIT RETRAITS VERSEMENT VERSEMENTS PAIEMENT PAIEMENTS CARTE CB CHEQUE CHEQUES
CHQ REMISE FRAIS COMMISSION COMMISSIONS COM COTISATION TENUE PRELEVEMENT PRLV PREL INTERETS INTERET AGIOS TVA
TAXE TIMBRE ESPECES GAB DAB RECU RECUS EMIS EMISE ORDRE PERMANENT INSTANTANE NATIONAL INTERNATIONAL RETOUR
ANNULATION REGULARISATION ACHAT ACHATS ECHEANCE PRET REMBOURSEMENT FACTURE ABONNEMENT FAVEUR
DU AU AUX DE DES LE LA LES ET EN PAR POUR SUR SOUS AVEC SANS VOTRE VOS NOTRE NOS VOUS NOUS CI DESSOUS
JANVIER FEVRIER MARS AVRIL MAI JUIN JUILLET AOUT SEPTEMBRE OCTOBRE NOVEMBRE DECEMBRE
JAN FEV FEB MAR AVR APR MAY JUN JUL AOU AUG SEP OCT NOV DEC
CIH BANK ATTIJARIWAFA ATTIJARI WAFA BMCE AFRICA OF BOA SAUF ERREUR OMISSION PART
OPENING CLOSING BALANCE STATEMENT ACCOUNT DESCRIPTION AMOUNT
""".split())

TOKEN_RE = re.compile(r"[^\W\d_]+|.", re.S)  # runs of letters, or any single other character


def fold(word):
    """Uppercase without accents, for the whitelist lookup."""
    decomposed = unicodedata.normalize("NFKD", word)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).upper()


def mask_char(ch):
    cat = unicodedata.category(ch)
    if cat[0] in "LM":
        return "x"  # letters and accents of every script
    if cat[0] == "N":
        return "9"  # digits of every script, superscripts, fractions
    if cat[0] in "PS":
        return ch if ch in KEPT_PUNCTUATION else "#"  # common separators only: . , / - : ( ) ...
    if cat[0] == "Z":
        return " "
    if cat in ("Co", "Cn", "Cs"):
        return "?"  # private-use glyphs (custom font encodings), unassigned
    return ""  # control and invisible format characters (e.g. right-to-left marks)


KEPT_PUNCTUATION = set(".,/-:;()'’°%+=")


def mask_text(text):
    text = unicodedata.normalize("NFC", text)
    if not any(unicodedata.category(c)[0] in "LN" for c in text):
        # Only punctuation/symbols: typical of fonts without a Unicode map, where any glyph (even a
        # digit) can come out as punctuation. Show nothing of it.
        return "~"
    out = []
    for tok in TOKEN_RE.findall(text):
        if len(tok) > 1 and tok.isalpha() and fold(tok) in SAFE_WORDS:
            out.append(fold(tok))
        else:
            out.append("".join(mask_char(c) for c in tok))
    return "".join(out)


@contextlib.contextmanager
def quiet():
    """Silence every library message: warnings can quote text from the PDF."""
    logging.disable(logging.CRITICAL)
    warnings.simplefilter("ignore")
    sys.stderr.flush()
    devnull, saved = os.open(os.devnull, os.O_WRONLY), os.dup(2)
    os.dup2(devnull, 2)
    try:
        yield
    finally:
        os.dup2(saved, 2)
        os.close(saved)
        os.close(devnull)


def find_pdfs(folder):
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf")


def group_lines(words):
    lines = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= 3:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(line, key=lambda w: w["x0"]) for line in lines]


def rules(page):
    """Vertical rules as x -> covered spans, horizontal rules as y positions."""
    vertical, horizontal = defaultdict(list), set()
    for e in page.edges:
        if e["orientation"] == "v" and e["height"] > 5:
            vertical[round(e["x0"], 1)].append((e["top"], e["bottom"]))
        elif e["orientation"] == "h" and e["width"] > 20:
            horizontal.add(round(e["top"], 1))
    v = [f"x={x} ({min(s[0] for s in spans):.0f}-{max(s[1] for s in spans):.0f})"
         for x, spans in sorted(vertical.items())]
    return v, sorted(horizontal)


def page_numbers(spec, count):
    picked = []
    for part in spec.split(","):
        n = int(part)
        n = n if n > 0 else count + 1 + n
        if 1 <= n <= count and n not in picked:
            picked.append(n)
    return sorted(picked)


def draw_png(page, lines, path):
    from PIL import Image, ImageDraw, ImageFont
    scale = 2
    img = Image.new("RGB", (int(page.width * scale), int(page.height * scale)), "white")
    draw = ImageDraw.Draw(img)
    for e in page.edges:
        draw.line([(e["x0"] * scale, e["top"] * scale), (e["x1"] * scale, e["bottom"] * scale)], fill="#999")
    for line in lines:
        for w in line:
            size = max(8, int((w["bottom"] - w["top"]) * scale))
            draw.text((w["x0"] * scale, w["top"] * scale), mask_text(w["text"]), fill="black",
                      font=ImageFont.load_default(size))
    img.save(path)


def layout(pdfs, pages_spec, png_dir):
    import pdfplumber
    for i, path in enumerate(pdfs, 1):
        name = f"file-{i}"
        try:
            with pdfplumber.open(path) as pdf:
                print(f"=== {name}: {len(pdf.pages)} page(s) ===")
                for n in page_numbers(pages_spec, len(pdf.pages)):
                    page = pdf.pages[n - 1]
                    v, h = rules(page)
                    print(f"--- page {n} ({page.width:.0f}x{page.height:.0f}) ---")
                    print("vertical rules:", ", ".join(v) or "none")
                    print(f"horizontal rules ({len(h)}):", ", ".join(map(str, h[:40])) or "none")
                    lines = group_lines(page.extract_words(extra_attrs=["size"]))
                    for line in lines:
                        print(f"@{line[0]['top']:.1f} s{line[0]['size']:.1f}  " + " | ".join(
                            f"{w['x0']:.1f}-{w['x1']:.1f}:{mask_text(w['text'])}" for w in line))
                    if png_dir:
                        draw_png(page, lines, png_dir / f"{name}-p{n}.png")
        except Exception as exc:  # message and traceback could contain text: print the type only
            print(f"=== {name}: error {type(exc).__name__} ===")


WARNING_KINDS = [  # fixed wording of fbar_cih.py warnings; anything after the colon is masked
    (r"no text found", None), (r"transaction table header not found", None),
    (r"missing [a-z ]+", None), (r"does not add up", None), (r"totals differ", None),
    (r"p\d+: unreadable amount in line", True), (r"p\d+: unreadable date in line", True),
    (r"p\d+: line not understood, ignored", True),
]


def describe_warning(text):
    for pattern, has_line in WARNING_KINDS:
        m = re.match(pattern, text)
        if m:
            tail = text[m.end():].lstrip(": ")
            return m.group(0) + (f": {mask_text(tail)}" if has_line else "")
    return "other warning: " + mask_text(text)


def check(pdfs):
    import fbar_cih
    accounts = {}
    by_account = defaultdict(list)
    for i, path in enumerate(pdfs, 1):
        name = f"file-{i}"
        try:
            statements = fbar_cih.parse_statements(path)
        except Exception as exc:
            print(f"{name}: error {type(exc).__name__}")
            continue
        for s in statements:
            label = accounts.setdefault(s.account or "?", f"account-{chr(ord('A') + len(accounts))}")
            by_account[label].append(s)
            adds_up = not any(w.startswith("does not add up") for w in s.warnings)
            totals_ok = not any(w.startswith("totals differ") for w in s.warnings)
            source = name + (f" (pages {s.first_page}-{s.last_page})" if len(statements) > 1 else "")
            print(f"{source}: {label}, period {s.close_date:%Y-%m}" if s.close_date else f"{source}: {label}, period ?",
                  f"| transactions {len(s.transactions)}",
                  f"| opening {'yes' if s.opening is not None else 'NO'}",
                  f"| closing {'yes' if s.closing is not None else 'NO'}",
                  f"| adds up {'yes' if adds_up and s.closing is not None else 'NO'}",
                  f"| totals match {'yes' if totals_ok and s.total_debit is not None else 'NO'}")
            for w in s.warnings:
                print(f"    ! {describe_warning(w)}")
    for label, stmts in by_account.items():
        stmts.sort(key=lambda s: s.close_date or s.open_date or fbar_cih.date.min)
        months = [f"{s.close_date:%Y-%m}" for s in stmts if s.close_date]
        breaks = sum(1 for a, b in zip(stmts, stmts[1:])
                     if a.closing is not None and b.opening is not None and a.closing != b.opening)
        problems = sum(len(s.warnings) for s in stmts)
        print(f"{label}: {len(stmts)} statement(s), months {', '.join(months) or '?'}, "
              f"opening != previous closing: {breaks}, warnings: {problems}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["layout", "check"])
    ap.add_argument("folder", type=Path)
    ap.add_argument("--pages", default="1,2,-1", help="pages to show in layout mode (negative = from the end)")
    ap.add_argument("--png-dir", type=Path, help="also draw each shown page, masked, as a PNG in this folder")
    args = ap.parse_args()
    pdfs = find_pdfs(args.folder)
    print(f"{len(pdfs)} PDF file(s)")
    if args.png_dir:
        args.png_dir.mkdir(parents=True, exist_ok=True)
    with quiet():
        try:
            layout(pdfs, args.pages, args.png_dir) if args.mode == "layout" else check(pdfs)
        except Exception as exc:
            print(f"stopped: error {type(exc).__name__}")


if __name__ == "__main__":
    main()
