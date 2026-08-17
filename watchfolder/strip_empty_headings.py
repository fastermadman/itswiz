"""Fjerner tomme heading-linjer (bare '#'..'######' uden tekst) fra vaulten.

Opstod som MinerU-støj, uafhængigt af sidemarkør-bugget der blev rettet i
watch_viastudywiz.py (se insert_page_markers). Kør uden argumenter for dry-run,
med --apply for at skrive ændringerne.

Sikkerhed: scriptet gætter ALDRIG en overskriftstekst og hæfter den ikke automatisk
på den tomme '#' — det ville risikere at lave en overskrift ud af almindelig brødtekst.
I stedet: hvis næste ikke-tomme linje ligner en overskriftstitel (kort, ingen
sætningsafsluttende tegn, ikke en liste/billede/citat-linje), springes den linje over
til manuel gennemgang i stedet for at blive slettet. Kun linjer der tydeligt IKKE
ligner en glemt titel bliver fjernet.
"""
import re
import sys
from pathlib import Path

VAULT = Path.home() / "ViaVault"
EMPTY_HEADING = re.compile(r"^#{1,6}[ \t]*$")

TITLE_MAX_LEN = 70
NOT_TITLE_PREFIXES = ("*—", "![[", "-", "\\-", "*", ">", "|")


def looks_like_lost_title(line: str) -> bool:
    text = line.strip()
    if not text:
        return False
    if len(text) > TITLE_MAX_LEN:
        return False
    if text[0].islower():
        return False
    if text.endswith((".", "!", "?", ":", ",", ";")):
        return False
    if text.startswith(NOT_TITLE_PREFIXES):
        return False
    if re.match(r"^\d+[.)]", text):  # nummereret liste
        return False
    return True


def next_nonblank(lines: list[str], start: int) -> str | None:
    for line in lines[start:]:
        if line.strip():
            return line
    return None


def fix(text: str, filename: str) -> tuple[str, int, list[str]]:
    lines = text.split("\n")
    out = []
    removed = 0
    flagged = []
    for i, line in enumerate(lines):
        if EMPTY_HEADING.match(line):
            nxt = next_nonblank(lines, i + 1)
            if nxt and looks_like_lost_title(nxt):
                flagged.append(f"{filename}:{i + 1}  næste linje: {nxt.strip()[:70]!r}")
                out.append(line)  # rør ikke, lad stå til manuel gennemgang
            else:
                removed += 1
                continue  # linjen udelades helt
        else:
            out.append(line)
    new_text = "\n".join(out)
    new_text = re.sub(r"\n{3,}", "\n\n", new_text)
    return new_text, removed, flagged


def main() -> int:
    dry_run = "--apply" not in sys.argv
    changed = []
    all_flagged = []
    for md in VAULT.rglob("*.md"):
        if ".stversions" in md.parts:
            continue
        text = md.read_text(encoding="utf-8")
        new_text, n, flagged = fix(text, str(md.relative_to(VAULT)))
        all_flagged.extend(flagged)
        if n:
            if not dry_run:
                md.write_text(new_text, encoding="utf-8")
            changed.append((md, n))

    for md, n in changed:
        print(f"{n:2d}  {md.relative_to(VAULT)}")
    print(f"\n{'(dry run) ' if dry_run else ''}{len(changed)} filer, {sum(n for _, n in changed)} tomme overskrifter fjernet")

    if all_flagged:
        print(f"\n{len(all_flagged)} sprunget over til manuel gennemgang (ligner muligvis en glemt titel):")
        for f in all_flagged:
            print(" -", f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
