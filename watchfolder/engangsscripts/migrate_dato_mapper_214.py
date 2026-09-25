#!/usr/bin/env python3
"""
Engangs-migrering (#214, #209-opfølgning): flyt indhold fra `<dato> - <emne>/`-mapper ind i
`<emne>/`-enhedsmappen under MD/ og NOTER/ i § FAG/<fag>/.

Flytter fil for fil via Obsidian CLI (`obsidian vault=ViaVault move`), så wikilinks følger med
(CLAUDE.md: aldrig rå mv). Patcher derefter linkedNote/vaultLink i Hold Courses data.json.
Planlægnings-hjælpere genbruges fra migrate_to_enhed_mapper.py (#149).

Kollisioner (samme filnavn i enhedsmappen):
  samme navn (uanset indhold) -> kilden får " (<dato>)"-suffiks (ingen sletning: links ville dø)
  0-byte / .sync-conflict   -> papirkurv

Dry-run som standard. `--apply` udfører; `--fag Religion` afgrænser. `--selfcheck` kører asserts.
Forud for --apply: watchfolder genstartet (CLAUDE.md), snapshot af § FAG/ og data.json.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from migrate_to_enhed_mapper import (  # noqa: E402
    FAG_ROOT, SKIP_NAMES, classify_folder, enhed_for, folder_date, is_ghost, nfc,
    plain_fag, split_folder,
)
from watch_viastudywiz import VAULT_ROOT  # noqa: E402

BRANCHES = ("MD", "NOTER")
DATA_JSON = VAULT_ROOT / ".obsidian/plugins/hold-course/data.json"
VAULT_NAME = VAULT_ROOT.name


def obsidian(*args: str) -> None:
    """CLI giver exit 0 ved fejl — derfor tjekkes outputtet for 'Error'."""
    out = subprocess.run(["obsidian", f"vault={VAULT_NAME}", *args], capture_output=True, text=True)
    text = out.stdout + out.stderr
    if "Error" in text:
        raise RuntimeError(f"obsidian {' '.join(args)}: {text.strip()}")


def plan_branch(branch: Path) -> dict:
    """{'move': [(src, dst)], 'trash': [(src, hvorfor)]} for én MD/ eller NOTER/-mappe."""
    plan = {"move": [], "trash": []}
    taken: dict[Path, Path] = {}  # dst -> kilde der har krav på den
    for folder in sorted(branch.iterdir()):
        if not folder.is_dir() or classify_folder(folder.name) != "migrate":
            continue
        _, emne = split_folder(folder.name)
        dst_dir = branch / enhed_for(plain_fag(branch.parent.name), emne)
        if dst_dir == folder:
            continue
        for src in sorted(p for p in folder.rglob("*") if p.is_file() and p.name not in SKIP_NAMES):
            if is_ghost(src):
                plan["trash"].append((src, "spøgelse (0 byte / sync-conflict)"))
                continue
            dst = dst_dir / src.relative_to(folder)
            owner = dst if dst.exists() else taken.get(dst)
            if owner is None:
                taken[dst] = src
            else:  # også identiske: suffiks frem for sletning, så links/pegere ikke dør
                dst = dst.with_name(f"{dst.stem} ({folder_date(folder.name)}){dst.suffix}")
                taken[dst] = src
            plan["move"].append((src, dst))
    return plan


def rel(p: Path) -> str:
    return nfc(str(p.relative_to(VAULT_ROOT)))


def patch_data_json(moves: list[tuple[Path, Path]]) -> int:
    text = DATA_JSON.read_text(encoding="utf-8")
    n = 0
    for src, dst in moves:
        old, new = json.dumps(rel(src), ensure_ascii=False), json.dumps(rel(dst), ensure_ascii=False)
        n += text.count(old)
        text = text.replace(old, new)
    DATA_JSON.write_text(text, encoding="utf-8")
    return n


def main() -> int:
    apply = "--apply" in sys.argv
    only = sys.argv[sys.argv.index("--fag") + 1] if "--fag" in sys.argv else None
    moves, trash = [], []
    for fag in sorted(d for d in FAG_ROOT.iterdir() if d.is_dir()):
        if only and plain_fag(fag.name) != only:
            continue
        for b in BRANCHES:
            if (fag / b).is_dir():
                p = plan_branch(fag / b)
                moves += p["move"]
                trash += p["trash"]

    suffixed = [(s, d) for s, d in moves if d.stem != s.stem]
    print(f"{len(moves)} flytninger ({len(suffixed)} med dato-suffiks) · {len(trash)} til papirkurv")
    for s, d in suffixed:
        print(f"  SUFFIKS {rel(s)}\n       -> {rel(d)}")
    for s, why in trash:
        print(f"  KURV    {rel(s)}  [{why}]")
    text = DATA_JSON.read_text(encoding="utf-8")
    hits = sum(text.count(json.dumps(rel(s), ensure_ascii=False)) for s, _ in moves)
    print(f"{hits} data.json-forekomster (linkedNote/vaultLink) vil blive patchet")
    if not apply:
        print("\nDry-run. --apply udfører (Obsidian skal køre).")
        return 0

    shutil.copy2(DATA_JSON, DATA_JSON.with_suffix(".json.bak-214"))
    for s, _ in trash:
        obsidian("delete", f"path={rel(s)}")
    for s, d in moves:
        d.parent.mkdir(parents=True, exist_ok=True)
        obsidian("move", f"path={rel(s)}", f"to={rel(d)}")
    print(f"data.json: {patch_data_json(moves)} forekomster patchet (backup: data.json.bak-214)")

    for fag in FAG_ROOT.iterdir():
        for b in BRANCHES:
            for f in sorted((fag / b).iterdir()) if (fag / b).is_dir() else []:
                if f.is_dir() and classify_folder(f.name) == "migrate" \
                        and not any(p.is_file() and p.name not in SKIP_NAMES for p in f.rglob("*")):
                    shutil.rmtree(f)
    print("Færdig. Genindlæs Hold Course (se CLAUDE.md) og verificér i Obsidian.")
    return 0


def selfcheck() -> int:
    import tempfile
    tmp = Path(tempfile.mkdtemp())
    br = tmp / "♪ Musik" / "MD"
    for d, name, txt in [("2026-09-01 - Emne", "a.md", "x"), ("2026-09-02 - Emne", "a.md", "x"),
                         ("2026-09-03 - Emne", "b.md", "1"), ("2026-09-04 - Emne", "b.md", "2"),
                         ("Emne", "b.md", "0"), ("2026-09-05 - Emne", "z.sync-conflict-20260901.md", "q")]:
        (br / d).mkdir(parents=True, exist_ok=True)
        (br / d / name).write_text(txt)
    p = plan_branch(br)
    assert len(p["trash"]) == 1, p["trash"]  # kun spøgelset
    assert sorted(d.name for _, d in p["move"]) == ["a (2026-09-02).md", "a.md", "b (2026-09-03).md", "b (2026-09-04).md"], p["move"]
    shutil.rmtree(tmp)
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
