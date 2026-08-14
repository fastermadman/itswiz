#!/usr/bin/env python3
"""
Omdøber eksisterende meta-noter til [TAG]-præfiks-formatet (issue #82, #85):
  '<uge> lektionsplan.md' -> '[PLAN] <uge>.md'  (i */MD/<uge>/)
  '<uge> note.md'         -> '[NOTE] <uge>.md'  (i */NOTER/<uge>/)

Bruges efter at background.js er opdateret til at skrive det nye format.
Scriptet er sikkert mod doubletter — hvis målfilen allerede eksisterer, springer
den over (skriver en advarsel) i stedet for at overskrive.
"""

import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"

# (rod-mappenavn, gammelt filnavn-suffiks, nyt præfiks)
RENAME_RULES = [
    ("MD", " lektionsplan.md", "[PLAN] "),
    ("NOTER", " note.md", "[NOTE] "),
]


def rename_in_week_dir(week_dir: Path, old_suffix: str, new_prefix: str) -> int:
    """Omdøber filer i én ugemappe. Returnerer antal omdøbt."""
    old_files = list(week_dir.glob(f"*{old_suffix}"))
    if not old_files:
        return 0

    count = 0
    for old_file in old_files:
        week_folder = week_dir.name
        new_name = f"{new_prefix}{week_folder}.md"
        new_file = week_dir / new_name

        if new_file.exists():
            print(f"⚠️  {new_file.name} eksisterer allerede — springer over", file=sys.stderr)
            continue

        old_file.rename(new_file)
        print(f"✓ {old_file.name} → {new_name}")
        count += 1

    return count


def main():
    if not VAULT_ROOT.exists():
        print(f"Fejl: {VAULT_ROOT} eksisterer ikke", file=sys.stderr)
        return 1

    total = 0
    for root_dir_name, old_suffix, new_prefix in RENAME_RULES:
        for root_dir in sorted(VAULT_ROOT.rglob(f"*/{root_dir_name}")):
            if not root_dir.is_dir():
                continue

            for week_dir in sorted(root_dir.iterdir()):
                if week_dir.is_dir():
                    total += rename_in_week_dir(week_dir, old_suffix, new_prefix)

    print(f"\n✅ Færdig: {total} filer omdøbt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
