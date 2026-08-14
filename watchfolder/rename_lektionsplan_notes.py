#!/usr/bin/env python3
"""
Omdøber eksisterende lektionsplan-noter fra '*lektionsplan.md' til '[PLAN] *.md'.

Bruges efter at background.js er opdateret til at bruge det nye format.
Scriptet er sikkert mod doubletter — hvis [PLAN] allerede eksisterer, springer
den over (skriver en advarsel).
"""

import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
MD_DIR_NAME = "MD"


def rename_in_week_dir(week_dir: Path) -> int:
    """Omdøber filer i én ugemappe. Returnerer antal omdøbt."""
    old_files = list(week_dir.glob("* lektionsplan.md"))
    if not old_files:
        return 0

    count = 0
    for old_file in old_files:
        # Parse weekFolder fra mappenavnet (fx "W33fre - Intro til faget")
        week_folder = week_dir.name
        new_name = f"[PLAN] {week_folder}.md"
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
    # Find alle MD-mapper (struktur: FAG/<fagtype>/MD/<uge>/)
    for md_dir in sorted(VAULT_ROOT.rglob(f"*/{MD_DIR_NAME}")):
        if not md_dir.is_dir():
            continue

        for week_dir in sorted(md_dir.iterdir()):
            if week_dir.is_dir():
                total += rename_in_week_dir(week_dir)

    print(f"\n✅ Færdig: {total} filer omdøbt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
