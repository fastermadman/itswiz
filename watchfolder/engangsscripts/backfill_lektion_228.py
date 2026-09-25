#!/usr/bin/env python3
"""
Engangs-backfill (#228): stempl `lektion: <plan_id>` på de materiale-noter #214 flyttede ind i
enhedsmapper, så synken (_declared_owner, #186) kender den rigtige lektion igen.

Sandhed fra to uafhængige kilder på disk, krydstjekket pr. fil:
  S2  pre-#214-snapshot: filens gamle `MD/<dato> - <emne>/`-mappe -> `[PLAN]`-notens plan_id dér
      (stabilt, overlever itslearning-omplanlægning, #96).
  S1  data.json-backup før dedup-synken: hvilken lektion (vswPlanId) havde en Reading-opgave på
      filens (patchede) nye sti.
Nye sti = enhedsmappen med samme navn, eller `<navn> (<dato>)` (#214's dato-suffiks); brødteksten
skal være identisk med snapshot-filens, ellers springes den over.

Stemples KUN når S2 og S1 er enige (S2-pid indgår i S1's lektioner for filen). Uenige, manglende
og uafklarede rapporteres og røres ikke. `--s2-only` stempler også filer uden S1-opgave.

Dry-run som standard. `--apply` skriver (Hold Course fra, watcher standset). `--selfcheck`.
  python3 backfill_lektion_228.py --snapshot <dir med udpakket § FAG/> [--backup data.json.bak…]
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sync_hold_course as sh  # noqa: E402
from migrate_to_enhed_mapper import (  # noqa: E402
    classify_folder, enhed_for, folder_date, nfc, plain_fag, read_fm, split_folder,
)
from watch_viastudywiz import VAULT_ROOT  # noqa: E402

DEFAULT_BACKUP = VAULT_ROOT / ".obsidian/plugins/hold-course/data.json.bak-214-vaultlink"
SKIP_PREFIX = ("[PLAN] ", "[NOTE] ", "_")


def s1_map(backup: Path) -> dict[str, set[str]]:
    """{ny sti: {plan_id}} fra Reading-opgaverne i data.json-backuppen."""
    out: dict[str, set[str]] = {}
    for sem in json.loads(backup.read_text(encoding="utf-8"))["semesters"]:
        for cls in sem["classes"]:
            for lec in cls["lectures"]:
                for a in lec["assignments"]:
                    k = a.get("vswKey", "")
                    if a.get("linkedNote") and ("|mat|" in k or "|lit|" in k) and lec.get("vswPlanId"):
                        out.setdefault(nfc(a["linkedNote"]), set()).add(lec["vswPlanId"])
    return out


def new_path(vault: Path, fag: str, folder: str, name: str) -> Path | None:
    """Filens nuværende placering (dato-suffiks foretrækkes: det er entydigt for denne mappe)."""
    pref, emne = split_folder(folder)
    base = vault / "§ FAG" / fag / "MD" / enhed_for(plain_fag(fag), emne)
    p = Path(name)
    for cand in (base / f"{p.stem} ({folder_date(folder)}){p.suffix}", base / name):
        if cand.exists():
            return cand
    return None


def plan(snapshot: Path, vault: Path, s1: dict[str, set[str]], s2_only: bool) -> dict:
    live_pids = {p["plan_id"] for p in sh.read_plans(vault)[0]}
    res = {"stamp": [], "s2_only_skip": [], "disagree": [], "no_folder_pid": [], "no_target": [],
           "body_mismatch": [], "plan_gone": [], "already": [], "files": 0}
    for fag_dir in sorted((snapshot / "§ FAG").iterdir()):
        md = fag_dir / "MD"
        if not md.is_dir():
            continue
        for folder in sorted(p for p in md.iterdir() if p.is_dir() and classify_folder(p.name) == "migrate"):
            pids = {f["plan_id"] for n in folder.glob("[[]PLAN[]] *.md")
                    if (f := sh.parse_frontmatter(n.read_text(encoding="utf-8"))).get("plan_id")}
            for src in sorted(folder.glob("*.md")):
                if src.name.startswith(SKIP_PREFIX) or ".sync-conflict-" in src.name:
                    continue
                if read_fm(src)[0] == "dublet":
                    continue
                res["files"] += 1
                if len(pids) != 1:
                    res["no_folder_pid"].append(src.relative_to(snapshot)); continue
                pid = next(iter(pids))
                dst = new_path(vault, fag_dir.name, nfc(folder.name), src.name)
                if dst is None:
                    res["no_target"].append(src.relative_to(snapshot)); continue
                if read_fm(src)[1] != read_fm(dst)[1]:
                    res["body_mismatch"].append(dst); continue
                if pid not in live_pids:
                    res["plan_gone"].append(dst); continue
                if sh.parse_frontmatter(dst.read_text(encoding="utf-8")).get("lektion"):
                    res["already"].append(dst); continue
                seen = s1.get(nfc(str(dst.relative_to(vault))), set())
                if pid in seen:
                    res["stamp"].append((dst, pid))
                elif not seen:
                    (res["stamp"] if s2_only else res["s2_only_skip"]).append((dst, pid))
                else:
                    res["disagree"].append((dst, pid, sorted(seen)))
    return res


def stamp(text: str, pid: str) -> str:
    """Indsæt `lektion: "<pid>"` lige før frontmatterens lukkelinje; uden frontmatter: uændret."""
    if not text.startswith("---\n"):
        return text
    end = text.find("\n---\n", 3)
    return text if end == -1 else f'{text[:end]}\nlektion: "{pid}"{text[end:]}'


def main() -> int:
    if "--snapshot" not in sys.argv:
        print(__doc__); return 1
    snapshot = Path(sys.argv[sys.argv.index("--snapshot") + 1])
    backup = Path(sys.argv[sys.argv.index("--backup") + 1]) if "--backup" in sys.argv else DEFAULT_BACKUP
    r = plan(snapshot, VAULT_ROOT, s1_map(backup), "--s2-only" in sys.argv)
    print(f"{r['files']} materiale-noter fra datomapper i snapshot:")
    for key, label in (("stamp", "STEMPLES (S1 og S2 enige)"), ("s2_only_skip", "kun S2 (ingen S1-opgave) — røres ikke uden --s2-only"),
                       ("disagree", "UENIGE (S2-pid ikke blandt S1's lektioner) — røres ikke"),
                       ("no_folder_pid", "gammel mappe uden ét entydigt [PLAN] — røres ikke"),
                       ("no_target", "ny sti ikke fundet"), ("body_mismatch", "brødtekst forskellig fra snapshot"),
                       ("plan_gone", "plan findes ikke længere"), ("already", "har allerede lektion:")):
        print(f"  {len(r[key]):4}  {label}")
    for d in r["disagree"][:8]:
        print("   UENIG", d[0].name[:60], "S2:", d[1], "S1:", d[2])
    if "--apply" not in sys.argv:
        print("\nDry-run. --apply skriver (Hold Course fra, watcher standset)."); return 0
    n = 0
    for dst, pid in r["stamp"]:
        t = dst.read_text(encoding="utf-8"); new = stamp(t, pid)
        if new != t:
            dst.write_text(new, encoding="utf-8"); n += 1
    print(f"\n{n} noter stemplet med lektion:.")
    return 0


def selfcheck() -> int:
    import tempfile
    assert stamp('---\ntype: materiale\nfag: X\n---\n\nbody', "1:2") == '---\ntype: materiale\nfag: X\nlektion: "1:2"\n---\n\nbody'
    assert stamp("uden frontmatter", "1:2") == "uden frontmatter"
    v = Path(tempfile.mkdtemp())
    base = v / "§ FAG" / "♪ Musik" / "MD" / "Emne"; base.mkdir(parents=True)
    (base / "a.md").write_text("x"); (base / "a (2026-09-03).md").write_text("y"); (base / "b.md").write_text("z")
    assert new_path(v, "♪ Musik", "2026-09-03 - Emne", "a.md") == base / "a (2026-09-03).md"  # suffiks foretrækkes
    assert new_path(v, "♪ Musik", "2026-09-01 - Emne", "a.md") == base / "a.md"
    assert new_path(v, "♪ Musik", "2026-09-01 - Emne", "b.md") == base / "b.md"
    assert new_path(v, "♪ Musik", "2026-09-01 - Emne", "c.md") is None
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
