#!/usr/bin/env python3
"""
Omdøber eksisterende meta-noter til [TAG]-præfiks-formatet (issue #82, #85):
  '<uge> lektionsplan.md' -> '[PLAN] <uge>.md'  (i */MD/<uge>/)
  '<uge> note.md'         -> '[NOTE] <uge>.md'  (i */NOTER/<uge>/)

Bruges efter at background.js er opdateret til at skrive det nye format.
Scriptet er sikkert mod doubletter — hvis målfilen allerede eksisterer, springer
den over (skriver en advarsel) i stedet for at overskrive.

Retter også wikilink-backlinks ([[<gammelt filnavn>]]) i resten af vaulten efter hver
omdøbning — en ren filsystem-rename omgår Obsidians egen alwaysUpdateLinks, som kun
trigges af flytninger foretaget INDE i Obsidian. Uden dette laver scriptet døde links
i alt der pegede på den gamle fil (fx note-stubbens kilde:-felt, se issue om #82's
regression).
"""

import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"

# (rod-mappenavn, gammelt filnavn-suffiks, nyt præfiks)
RENAME_RULES = [
    ("MD", " lektionsplan.md", "[PLAN] "),
    ("NOTER", " note.md", "[NOTE] "),
]


def rename_in_week_dir(week_dir: Path, old_suffix: str, new_prefix: str) -> list[tuple[str, str]]:
    """Omdøber filer i én ugemappe. Returnerer liste af (gammel stem, ny stem)."""
    old_files = list(week_dir.glob(f"*{old_suffix}"))
    if not old_files:
        return []

    renamed = []
    for old_file in old_files:
        week_folder = week_dir.name
        new_name = f"{new_prefix}{week_folder}.md"
        new_file = week_dir / new_name

        if new_file.exists():
            print(f"⚠️  {new_file.name} eksisterer allerede — springer over", file=sys.stderr)
            continue

        old_stem = old_file.stem
        old_file.rename(new_file)
        print(f"✓ {old_file.name} → {new_name}")
        renamed.append((old_stem, new_file.stem))

    return renamed


def fix_backlinks(renamed: list[tuple[str, str]]) -> int:
    """Retter [[<gammel stem>]] -> [[<ny stem>]] i alle .md-filer i vaulten."""
    if not renamed:
        return 0

    count = 0
    for md_file in VAULT_ROOT.rglob("*.md"):
        text = md_file.read_text(encoding="utf-8")
        original = text
        for old_stem, new_stem in renamed:
            text = text.replace(f"[[{old_stem}]]", f"[[{new_stem}]]")
        if text != original:
            md_file.write_text(text, encoding="utf-8")
            print(f"  ↳ backlink rettet i {md_file.relative_to(VAULT_ROOT)}")
            count += 1

    return count


def main():
    if not VAULT_ROOT.exists():
        print(f"Fejl: {VAULT_ROOT} eksisterer ikke", file=sys.stderr)
        return 1

    all_renamed = []
    for root_dir_name, old_suffix, new_prefix in RENAME_RULES:
        for root_dir in sorted(VAULT_ROOT.rglob(f"*/{root_dir_name}")):
            if not root_dir.is_dir():
                continue

            for week_dir in sorted(root_dir.iterdir()):
                if week_dir.is_dir():
                    all_renamed.extend(rename_in_week_dir(week_dir, old_suffix, new_prefix))

    backlinks_fixed = fix_backlinks(all_renamed)

    print(f"\n✅ Færdig: {len(all_renamed)} filer omdøbt, {backlinks_fixed} filer fik rettet backlinks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
