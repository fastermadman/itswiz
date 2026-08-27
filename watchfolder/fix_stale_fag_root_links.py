#!/usr/bin/env python3
"""
Engangsrettelse af døde wikilinks der stadig peger på det gamle "🎓 FAG"-rodnavn
og de gamle fag-mappenavne uden symbol (Musik/Religion/LivsOplysning), fra FØR
rod-omdøbningen i #63/4f1067c (2026-08-12). Den omdøbning rettede selve mapperne
og fremtidigt genereret indhold, men rørte aldrig links der allerede stod i noters
egen brødtekst (AUTO-splice bevarer bevidst alt uden for AUTO-markørerne, se
spliceAutoSection) — de blev aldrig fundet igen, fordi kilden er væk fra vaulten.

Symptom i Obsidian: klik på sådan et link opretter en NY tom note i stedet for at
åbne den eksisterende — linket peger på en sti der ikke findes længere, ikke et
cache-problem.

Dry-run som standard, --apply udfører.
"""

import re
import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
OLD_ROOT = "🎓 FAG"
NEW_ROOT = "§ FAG"
SYMBOLS = {"Musik": "♪", "Religion": "♱", "LivsOplysning": "⚖︎"}


def rewrite_links(text: str) -> str:
    for course, symbol in SYMBOLS.items():
        text = re.sub(
            rf"(\[\[){re.escape(OLD_ROOT)}/{re.escape(course)}/",
            rf"\1{NEW_ROOT}/{symbol} {course}/",
            text,
        )
    return text


def main() -> int:
    apply = "--apply" in sys.argv

    changed = []
    for path in VAULT_ROOT.rglob("*.md"):
        old_text = path.read_text(encoding="utf-8")
        new_text = rewrite_links(old_text)
        if new_text != old_text:
            changed.append((path, new_text))

    print(f"{len(changed)} noter med døde {OLD_ROOT}-links der rettes:")
    for path, _ in changed:
        print(f"  {path.relative_to(VAULT_ROOT)}")

    if not apply:
        print("Dry-run. Kør med --apply for at udføre.")
        return 0

    for path, new_text in changed:
        path.write_text(new_text, encoding="utf-8")
    print("Rettet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
