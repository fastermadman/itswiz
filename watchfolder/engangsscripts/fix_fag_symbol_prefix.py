#!/usr/bin/env python3
"""
Engangsscript: retter fag:-frontmatter i eksisterende materiale-/dublet-noter, der fejlagtigt
fik mappens symbol-navn (fx "♱ Religion") i stedet for det rene navn ("Religion") — se
watch_viastudywiz.py's frontmatter()-fix, issue #111. Bug'en splittede Bases' groupBy/filter på
fag i to grupper pr. fag og gjorde de fag=="Musik"-eksakte subject-views blinde for alle
materiale-noter.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører den indbyggede test.
"""

import re
import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
FOLDER_SYMBOLS = {"♪": "Musik", "♱": "Religion", "⚖︎": "LivsOplysning"}


def rewrite_fag(text: str) -> str:
    for symbol, name in FOLDER_SYMBOLS.items():
        text = re.sub(rf"^fag: {re.escape(symbol)} {re.escape(name)}$", f"fag: {name}", text, flags=re.MULTILINE)
    return text


def main() -> int:
    apply = "--apply" in sys.argv

    changed = []
    for path in VAULT_ROOT.rglob("*.md"):
        old_text = path.read_text(encoding="utf-8")
        new_text = rewrite_fag(old_text)
        if new_text != old_text:
            changed.append((path, new_text))

    print(f"{len(changed)} noter med fag: der rettes.")
    for path, _ in changed:
        print(f"  {path.relative_to(VAULT_ROOT)}")

    if not apply:
        print("Dry-run. Kør med --apply for at udføre.")
        return 0

    for path, new_text in changed:
        path.write_text(new_text, encoding="utf-8")
    print("Færdig.")
    return 0


def selfcheck() -> int:
    text = "---\nfag: ♱ Religion\nuge: W34tors\ntype: materiale\n---\n\nIndhold.\n"
    out = rewrite_fag(text)
    assert "fag: Religion\n" in out, out
    assert "♱" not in out, out

    unaffected = "---\nfag: Religion\ntype: lektionsplan\n---\n"
    assert rewrite_fag(unaffected) == unaffected
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        sys.exit(selfcheck())
    sys.exit(main())
