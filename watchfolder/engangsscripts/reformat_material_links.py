#!/usr/bin/env python3
"""
Engangsreformattering af eksisterende lektionsplan-noters materiale-links (issue #138-følge,
2026-08-30): background.js skriver nu |alias-links med det ægte filnavn (Titel.md/Titel.pdf) i
stedet for at vise hele stien, og itslearning-linket får en "(web)"-markør — se mdLink()/rawLink()
i background.js. Ramte kun NYE/ændrede lektioner (hash-sporet, issue #61); denne kører én gang
retroaktivt over de der allerede lå i vaulten, så alle noter matcher samme format med det samme.

Rører kun frontmatter-feltet `materiale_filer`/`litteratur_filer` og "## Materialer"-linjer inde i
AUTO:START/AUTO:END-blokken — alt andet i en lektionsplan-note er Valdemars egen tekst (issue #61)
og røres ikke.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"

FRONTMATTER_LINK_RE = re.compile(r'^(\s*📎 )\[\[([^|\]]+)\]\](\s*)$')
BODY_LINE_RE = re.compile(
    r'^- \[\[([^|\]]+)\]\] · \[itslearning\]\((https://via\.itslearning\.com[^)]+)\)$'
)


def find_raw_file(md_path: str) -> str | None:
    """MD-stien er stem-afledt af RAW-filen (se mdPath i background.js) — den ægte endelse
    kendes kun ved at kigge i RAW-mappen efter en fil med samme stem."""
    if "/MD/" not in md_path:
        return None
    raw_dir_rel = md_path.rsplit("/", 1)[0].replace("/MD/", "/RAW/", 1)
    raw_dir = VAULT_ROOT / raw_dir_rel
    stem = Path(md_path).stem
    if not raw_dir.is_dir():
        return None
    for f in raw_dir.iterdir():
        if f.is_file() and f.stem == stem:
            return f"{raw_dir_rel}/{f.name}"
    return None


def reformat(text: str) -> tuple[str, int]:
    changed = 0
    out_lines = []
    for line in text.split("\n"):
        m = FRONTMATTER_LINK_RE.match(line)
        if m:
            prefix, target, suffix = m.groups()
            alias = target.rsplit("/", 1)[-1]
            out_lines.append(f"{prefix}[[{target}|{alias}]]{suffix}")
            changed += 1
            continue
        m = BODY_LINE_RE.match(line)
        if m:
            md_path, url = m.groups()
            md_alias = md_path.rsplit("/", 1)[-1]
            stem = Path(md_path).stem
            raw_path = find_raw_file(md_path)
            raw_part = f" · [[{raw_path}|{raw_path.rsplit('/', 1)[-1]}]]" if raw_path else ""
            out_lines.append(f"- [[{md_path}|{md_alias}]]{raw_part} · [{stem} (web)]({url})")
            changed += 1
            continue
        out_lines.append(line)
    return "\n".join(out_lines), changed


def main() -> int:
    apply = "--apply" in sys.argv
    total_files = total_lines = 0
    for path in sorted(VAULT_ROOT.rglob("[[]PLAN[]] *.md")):
        before = path.read_text(encoding="utf-8")
        after, changed = reformat(before)
        if changed:
            total_files += 1
            total_lines += changed
            if apply:
                path.write_text(after, encoding="utf-8")
    label = "Rettet" if apply else "Ville rette (dry-run, kør med --apply for at skrive)"
    print(f"{label}: {total_lines} link(s) i {total_files} note(r).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
