#!/usr/bin/env python3
"""
Prøvekørsel af watcherens Hold Course-kæde på en KOPI af vaulten i tmp (#230, brugt i #208/#221/#228).
Rører hverken ~/ViaVault eller data.json.

  1. kopierer `§ FAG/**/*.md` til tmp
  2. kører patch_pending_materiale to gange (idempotens) og tjekker de tilføjede links
  3. kører read_plans + sync_data to gange på en kopi af data.json (ingen evig genskrivning)
  4. rapporterer Reading-opgaver før/efter og mål der stadig deler opgave på tværs af lektioner

Brug: python3 proevekoersel_kaede.py
"""

import collections
import copy
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sync_hold_course as m  # noqa: E402
from watch_viastudywiz import VAULT_ROOT  # noqa: E402


def reading_stats(d: dict) -> tuple[int, int]:
    """(antal Reading-opgaver, antal gentagne mål inden for en klasse)."""
    total = dup = 0
    for sem in d["semesters"]:
        for cls in sem["classes"]:
            per = collections.Counter(a["linkedNote"] for lec in cls["lectures"] for a in lec["assignments"]
                                      if a.get("type") == "Reading" and a.get("linkedNote"))
            total += sum(per.values())
            dup += sum(n - 1 for n in per.values() if n > 1)
    return total, dup


def mat_links(root: Path, rel: str) -> set[str]:
    fm = m.parse_frontmatter((root / rel).read_text(encoding="utf-8"))
    return {t for line in m.prefixed_lines(fm.get("materiale_filer", ""), m.MATERIALE_FIL_PREFIX)
            if (t := m.wikilink_target(line))}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="vaultcopy-"))
    try:
        subprocess.run(
            f'cd "{VAULT_ROOT}" && find "§ FAG" -name "*.md" -print0 | tar -cf - --null -T - | tar -xf - -C "{tmp}"',
            shell=True, check=True)
        print("kopi:", tmp, "|", sum(1 for _ in tmp.rglob("*.md")), "md-filer")

        before = {str(p.relative_to(tmp)): mat_links(tmp, str(p.relative_to(tmp)))
                  for p in tmp.rglob("[[]PLAN[]]*.md")}
        p1 = m.patch_pending_materiale(tmp, True)
        p2 = m.patch_pending_materiale(tmp, True)
        print(f"patch 1: {len(p1)} planer skrevet | patch 2 (idempotens): {len(p2)}  {'OK' if not p2 else 'FEJL!'}")

        added = bad = 0
        for rel in p1:
            for t in mat_links(tmp, rel) - before[rel]:
                added += 1
                f = tmp / t
                bad += (f.exists() and (m._is_dublet(f) or ".sync-conflict-" in f.name)) or "[PLAN]" in t or "[NOTE]" in t
        print(f"tilføjede links: {added} | forkerte (dublet/sync-conflict/PLAN/NOTE): {bad}")

        data0 = json.loads(Path(m.DATA_JSON).read_text(encoding="utf-8"))
        plans, _ = m.read_plans(tmp)
        d1 = m.sync_data(copy.deepcopy(data0), plans)
        d2 = m.sync_data(copy.deepcopy(d1), plans, lambda: "MÅ-IKKE-BRUGES")
        print("sync 1 -> 2 identisk (ingen evig genskrivning):",
              json.dumps(d1, sort_keys=True) == json.dumps(d2, sort_keys=True))
        print("Reading (opgaver, gentagne mål): nu", reading_stats(data0), "-> efter kæde", reading_stats(d1))

        owned = {p["plan_id"]: set(p["_owned"]) for p in plans}
        for sem in d1["semesters"]:
            for cls in sem["classes"]:
                per = collections.defaultdict(list)
                for lec in cls["lectures"]:
                    for a in lec["assignments"]:
                        if a.get("type") == "Reading" and a.get("linkedNote"):
                            ejet = a["linkedNote"] in owned.get(lec.get("vswPlanId"), set())
                            per[a["linkedNote"]].append((lec["date"], "ejet" if ejet else "fallback"))
                for target, rows in per.items():
                    if len(rows) > 1:
                        print("  GENTAGET", cls.get("name"), Path(target).name[:50], rows)
    finally:
        shutil.rmtree(tmp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
