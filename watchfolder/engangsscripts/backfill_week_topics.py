#!/usr/bin/env python3
"""
Engangs-tilføjelse af emne til eksisterende ugemapper, retroaktivt.

Ugemapper oprettet før weekFolderName() begyndte at tilføje plan.topic.name (se
background.js, PR #21) hedder stadig bare "W34tors" uden emne. Mappingen herunder er
hentet live fra itslearnings plan-API (myEvents + plans/selected/v1) for de tre aktive
fag, 2026-08-10 — se ValdiVault 10_Projects/VIAstudyWiz/10-filsystem-design-raw-md.md.

Nogle uger har to forskellige plan-emner samme dag (to lektioner, ét kursus) — dem
migreres IKKE, listet i KNOWN_CONFLICTS og under "Springes over" i kørsels-output, i
stedet for at gætte forkert.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører de indbyggede tests.
"""

import re
import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"

# (fag, gammelt ugemappenavn) -> emne.
WEEK_TOPICS = {
    ("LivsOplysning", "W33man"): "Introduktion",
    ("LivsOplysning", "W34man"): "Skolens formål",
    ("LivsOplysning", "W35man"): "Skolens formål",
    ("LivsOplysning", "W36man"): "Skolens formål",
    ("Musik", "W33tirs"): "Musikforståelse",
    ("Musik", "W33tors"): "Når børn synger.",
    ("Musik", "W34tirs"): "Musikforståelse",
    ("Musik", "W35tors"): "Når børn synger.",
    ("Musik", "W36tirs"): "Musikforståelse",
    ("Musik", "W37tirs"): "Musikforståelse",
    ("Musik", "W37tors"): "Når børn synger.",
    ("Musik", "W38tirs"): "Studietur",
    ("Musik", "W40tirs"): "Underviser Lone Sonne",
    ("Musik", "W41tirs"): "Underviser Lone Sonne",
    ("Religion", "W33fre"): "Intro til faget",
    ("Religion", "W33ons"): "Intro til faget",
    ("Religion", "W34fre"): "Den religiøse dimension",
    ("Religion", "W34ons"): "Den religiøse dimension",
    ("Religion", "W35fre"): "Hvad er religion og hvordan kan det udforskes?",
    ("Religion", "W35ons"): "Hvad er religion og hvordan kan det udforskes?",
    ("Religion", "W36fre"): "Hvad er religion og hvordan kan det udforskes?",
    ("Religion", "W36ons"): "Hvad er religion og hvordan kan det udforskes?",
    ("Religion", "W37fre"): "Dannelse til religiøs myndighed",
    ("Religion", "W37ons"): "Dannelse til religiøs myndighed",
    ("Religion", "W38fre"): "Bibelske fortællinger under en fagdidaktisk synsvinkel",
    ("Religion", "W38ons"): "Bibelske fortællinger under en fagdidaktisk synsvinkel",
    ("Religion", "W39fre"): "Bibelske fortællinger under en fagdidaktisk synsvinkel",
    ("Religion", "W39ons"): "Bibelske fortællinger under en fagdidaktisk synsvinkel",
    ("Religion", "W40fre"): "Bibelske fortællinger under en fagdidaktisk synsvinkel",
    ("Religion", "W40ons"): "Den religiøse dimension",
    ("Religion", "W41ons"): "SP I: Religionsdidaktisk projekt",
}

# To forskellige emner fundet samme dag (flere lektioner, ét kursus) — migreres bevidst ikke.
KNOWN_CONFLICTS = {
    ("Musik", "W34tors"): {"Når børn synger.", "I. M. U."},
    ("Musik", "W36tors"): {"Når børn synger.", "I. M. U."},
    ("Musik", "W39tors"): {"Studieprodukt, fremlæggelse.", "I. M. U."},
    ("Musik", "W41tors"): {"Studieprodukt, fremlæggelse.", "I. M. U."},
}


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


def rewrite_references(text: str, old_week: str, new_week: str) -> str:
    # Wikilinks/kilde-felter: "[[.../W34tirs/..." -> "[[.../W34tirs - Musikforståelse/..."
    text = re.sub(rf"(\[\[[^\]]*?/){re.escape(old_week)}(/)", rf"\1{new_week}\2", text)
    # Frontmatter: "uge: W34tirs" -> "uge: W34tirs - Musikforståelse"
    text = re.sub(rf"^uge: {re.escape(old_week)}$", f"uge: {new_week}", text, flags=re.MULTILINE)
    # Lektionsplan-filens eget navn optræder også i sin titel/link uden efterfølgende "/"
    # ("W34tirs lektionsplan") — det mønster fanger ovenstående regex ikke.
    text = re.sub(rf"\b{re.escape(old_week)}(?= lektionsplan\b)", new_week, text)
    return text


def plan_renames():
    renames = []
    for (fag, old_week), topic in WEEK_TOPICS.items():
        new_week = f"{old_week} - {sanitize(topic)}"
        dirs = [VAULT_ROOT / fag / branch / old_week for branch in ("RAW", "MD")]
        existing = [d for d in dirs if d.is_dir()]
        if existing:
            renames.append((fag, old_week, new_week, existing))
    return renames


def main() -> int:
    apply = "--apply" in sys.argv
    renames = plan_renames()

    print(f"{len(renames)} ugemapper får emne tilføjet:")
    for fag, old_week, new_week, dirs in renames:
        for d in dirs:
            print(f"  {d.relative_to(VAULT_ROOT)}  ->  {d.parent.relative_to(VAULT_ROOT)}/{new_week}")

    if KNOWN_CONFLICTS:
        print("\nSpringes over (flere forskellige emner samme dag i itslearning):")
        for (fag, week), topics in sorted(KNOWN_CONFLICTS.items()):
            print(f"  {fag}/{week}: {' / '.join(sorted(topics))}")

    if not apply:
        print("\nDry-run. Kør med --apply for at udføre.")
        return 0

    for fag, old_week, new_week, _ in renames:
        fag_root = VAULT_ROOT / fag
        for md in fag_root.rglob("*.md"):
            text = md.read_text(encoding="utf-8")
            new_text = rewrite_references(text, old_week, new_week)
            if new_text != text:
                md.write_text(new_text, encoding="utf-8")

    for fag, old_week, new_week, dirs in renames:
        for old_dir in dirs:
            new_dir = old_dir.parent / new_week
            old_dir.rename(new_dir)
            old_note = new_dir / f"{old_week} lektionsplan.md"
            if old_note.exists():
                old_note.rename(new_dir / f"{new_week} lektionsplan.md")

    print("Færdig.")
    return 0


def selfcheck() -> int:
    text = (
        "---\n"
        "fag: Musik\n"
        "uge: W34tirs\n"
        "type: lektionsplan\n"
        'kilde: "[[Musik/RAW/W34tirs/Titel.pdf]]"\n'
        "---\n\n"
        "# W34tirs lektionsplan\n\n"
        "## Materialer\n"
        "- [[Musik/RAW/W34tirs/Andet.pdf]]\n\n"
        'Dublet-note: [[Musik/MD/W34tirs/Andet note]]\n'
    )
    out = rewrite_references(text, "W34tirs", "W34tirs - Musikforståelse")
    assert "uge: W34tirs - Musikforståelse" in out, out
    assert "[[Musik/RAW/W34tirs - Musikforståelse/Titel.pdf]]" in out, out
    assert "[[Musik/RAW/W34tirs - Musikforståelse/Andet.pdf]]" in out, out
    assert "[[Musik/MD/W34tirs - Musikforståelse/Andet note]]" in out, out
    assert "# W34tirs - Musikforståelse lektionsplan" in out, out
    assert "W34tirs " not in out.replace("W34tirs - Musikforståelse", ""), out
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
