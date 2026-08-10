#!/usr/bin/env python3
"""
Engangs-omdøbning af fag-mapper til de venlige navne extensionen nu bruger
(samme mapping som COURSE_DISPLAY_NAMES i background.js, hidtil kun brugt til
kalendersync — se GitHub-issue #15-kommentaren).

    LSmu-2527/     -> Musik/
    LSkr-2628/     -> Religion/
    LSS24.1livs/   -> LivsOplysning/

Omdøber selve mappen og retter alle "[[<gammelt-fag>/…"-wikilinks og
"fag: <gammelt-fag>"-frontmatter i vaultens .md-filer — en almindelig `mv`
uden om Obsidian opdaterer ikke links, i modsætning til en omdøbning foretaget
inde i appen.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører de indbyggede tests.
"""

import re
import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
RENAMES = {
    "LSmu-2527": "Musik",
    "LSkr-2628": "Religion",
    "LSS24.1livs": "LivsOplysning",
}


def rewrite_references(text: str) -> str:
    for old, new in RENAMES.items():
        text = re.sub(rf"(\[\[){re.escape(old)}/", rf"\1{new}/", text)
        text = re.sub(rf"^fag: {re.escape(old)}$", f"fag: {new}", text, flags=re.MULTILINE)
    return text


def main() -> int:
    apply = "--apply" in sys.argv

    moves = [(VAULT_ROOT / old, VAULT_ROOT / new) for old, new in RENAMES.items() if (VAULT_ROOT / old).is_dir()]
    for _, new in moves:
        if new.exists():
            print(f"AFBRUDT — {new} findes allerede, flet i hånden først", file=sys.stderr)
            return 1

    changed = []
    for path in VAULT_ROOT.rglob("*.md"):
        old_text = path.read_text(encoding="utf-8")
        new_text = rewrite_references(old_text)
        if new_text != old_text:
            changed.append((path, new_text))

    print(f"{len(moves)} mappe-omdøbninger:")
    for old, new in moves:
        print(f"  {old.name}/ -> {new.name}/")
    print(f"{len(changed)} noter med links/frontmatter der rettes.")

    if not apply:
        print("Dry-run. Kør med --apply for at udføre.")
        return 0

    for path, new_text in changed:
        path.write_text(new_text, encoding="utf-8")
    for old, new in moves:
        old.rename(new)

    print("Færdig.")
    return 0


def selfcheck() -> int:
    text = (
        "---\n"
        "fag: LSmu-2527\n"
        "uge: W34tors\n"
        "type: materiale\n"
        'kilde: "[[LSmu-2527/RAW/W34tors/Titel.pdf]]"\n'
        "---\n\n"
        "Se også [[LSkr-2628/MD/W33ons/Andet]].\n"
    )
    out = rewrite_references(text)
    assert "fag: Musik" in out, out
    assert '[[Musik/RAW/W34tors/Titel.pdf]]' in out, out
    assert "[[Religion/MD/W33ons/Andet]]" in out, out
    assert "LSmu-2527" not in out and "LSkr-2628" not in out, out
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
