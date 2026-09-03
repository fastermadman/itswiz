#!/usr/bin/env python3
"""
Engangs (#157): ryd døde `litteratur_filer` / `materiale_filer`-wikilinks i `[PLAN]`-noternes
frontmatter.

Baggrund: `migrate_to_enhed_mapper.py` (#149) og `background.js` genskriver kun noter fremad
(`daysBack: 1`), så plan-noter ældre end enhed-migreringen beholdt wikilinks der peger på
pre-#155-stier. `relink_holdcourse_enhed.py` (#151) repeggede `data.json`, men ikke vaultens
frontmatter. Resultat: `sync_hold_course.py` gen-skaber ~34 fantom-resources fra de døde links
hver tick, og `prune_dead_links()` sletter dem igen (net-zero, men støj).

Pr. dødt wikilink:
- resolver til en faktisk fil (typisk NFC/NFD- eller enhedsmappe-drift) -> repeg
- ingen fil nogen steder (aldrig hentet materiale, `.sync-conflict-*`, selv-reference til en
  gammel `<dato> - <emne> lektionsplan.md`) -> fjern linjen
- bliver blokken tom -> `key: false` (samme tomme form background.js selv skriver)

Levende (eksisterende) links røres ikke — byte-identiske ud.

Dry-run som standard. `--apply` skriver. Kør efter `relink_holdcourse_enhed.py`.
GitHub: fastermadman/viastudywiz-extension#157
"""

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import sync_hold_course as s  # noqa: E402
import relink_holdcourse_enhed as rl  # noqa: E402

FIELDS = (("litteratur_filer", s.LITTERATUR_FIL_PREFIX), ("materiale_filer", s.MATERIALE_FIL_PREFIX))


def rewrite_block(text: str, key: str, prefix: str, idx: dict, log: list) -> str:
    """Genskriv ét frontmatter-blokfelt (`key: |` … indrykkede linjer). Andre former urørt."""
    lines = text.split("\n")
    try:
        i = next(n for n, ln in enumerate(lines) if ln.strip() == f"{key}: |")
    except StopIteration:
        return text
    j = i + 1
    while j < len(lines) and (lines[j].startswith("  ") or not lines[j].strip()):
        j += 1

    kept: list[str] = []
    seen: set[str] = set()                                    # NFC-normaliseret, dedup på tværs af ø/æ/å
    for ln in lines[i + 1:j]:
        raw = ln.strip()
        if not raw:
            continue
        body = raw[len(prefix):].strip() if raw.startswith(prefix) else raw
        tgt = s.wikilink_target(body)
        base = (tgt or body).rsplit("/", 1)[-1]
        if base.startswith(("[PLAN] ", "[NOTE] ")):           # issue #158: søskende-note i delt
            log.append(("drop", tgt or body, None))           # enhedsmappe — aldrig ægte materiale
            continue
        key_nfc = s.nfc(tgt) if tgt else None
        if key_nfc and key_nfc in seen:
            log.append(("drop", tgt, None))                   # dublet (NFD/NFC-lækage fra #158)
            continue
        if tgt and (s.VAULT_ROOT / s.nfc(tgt)).exists():
            kept.append(ln)                                   # lever — urørt
            seen.add(key_nfc)
            continue
        new = rl.resolve(tgt, idx) if tgt else None
        if new:
            if s.nfc(new) in seen:
                log.append(("drop", tgt, None))               # opløste til en allerede-beholdt fil
                continue
            kept.append(f"  {prefix} {s.wikilink_for(new)}")
            seen.add(s.nfc(new))
            log.append(("repeg", tgt, new))
        else:
            log.append(("drop", tgt or body, None))

    if kept:
        new_lines = lines[:i + 1] + kept + lines[j:]
    else:
        new_lines = lines[:i] + [f"{key}: false"] + lines[j:]
    return "\n".join(new_lines)


def process(apply: bool) -> int:
    idx = rl.md_index()
    plans = sorted((s.VAULT_ROOT).rglob("[[]PLAN[]] *.md"))
    touched = repegs = drops = emptied = 0
    for path in plans:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            continue
        end = text.find("\n---\n", 3)
        if end == -1:
            continue
        head, body = text[:end + 5], text[end + 5:]
        log: list = []
        for key, prefix in FIELDS:
            head = rewrite_block(head, key, prefix, idx, log)
        if not log:
            continue
        touched += 1
        repegs += sum(1 for a, *_ in log if a == "repeg")
        drops += sum(1 for a, *_ in log if a == "drop")
        emptied += head.count(": false") - text[:end + 5].count(": false")
        print(f"\n{path.relative_to(s.VAULT_ROOT)}")
        for action, old, new in log:
            print(f"  {action:5}  {old.split('/')[-1]}" + (f"  ->  {new}" if new else ""))
        if apply:
            new_text = head + body
            if path.read_text(encoding="utf-8") != text:
                print("  ! filen ændrede sig undervejs — sprunget over", file=sys.stderr)
                continue
            path.write_text(new_text, encoding="utf-8")

    print(f"\n{touched} plan-note(r): {repegs} repeg, {drops} døde linjer fjernet, "
          f"{emptied} blok(ke) tømt til `false`.")
    if not apply:
        print("Dry-run. Kør med --apply for at skrive. Genstart derefter watch-daemonen "
              "(launchctl kickstart -k …) og verificér at dry-run-prune er 0.")
    return 0


def selfcheck() -> int:
    idx = {("♪ Musik", "Rigtig fil"): [s.VAULT_ROOT / "§ FAG/♪ Musik/MD/Enhed/Rigtig fil.md"]}
    t = ("---\nfag: Musik\nmateriale_filer: |\n"
         "  📎 [[§ FAG/♪ Musik/MD/Gammel/Rigtig fil.md|Rigtig fil.md]]\n"
         "  📎 [[§ FAG/♪ Musik/MD/Væk/Findes ikke.md]]\n"
         "litteratur_filer: false\n---\n")
    log: list = []
    out = rewrite_block(t, "materiale_filer", s.MATERIALE_FIL_PREFIX, idx, log)
    acts = sorted(a for a, *_ in log)
    assert acts == ["drop", "repeg"], (acts, log)
    assert "Findes ikke.md" not in out, out
    assert out.count("materiale_filer: |") == 1, out

    t2 = ("---\nmateriale_filer: |\n  📎 [[§ FAG/♪ Musik/MD/Væk/Kun død.md]]\n"
          "type: lektionsplan\n---\n")
    out2 = rewrite_block(t2, "materiale_filer", s.MATERIALE_FIL_PREFIX, {}, [])
    assert "materiale_filer: false" in out2 and "Kun død" not in out2, out2
    assert "type: lektionsplan" in out2, out2

    # issue #158: søskende-[PLAN]/[NOTE]-noter fjernes selv når filen findes; en NFD/NFC-dublet der
    # opløser til den samme fil som en allerede-beholdt linje fjernes (kun én linje tilbage).
    import unicodedata as _u
    old = "§ FAG/♪ Musik/MD/Gammel/Rigtig fil.md"
    t3 = ("---\nmateriale_filer: |\n"
          f"  📎 [[{old}|Rigtig fil.md]]\n"
          f"  📎 [[{_u.normalize('NFD', old)}|Rigtig fil.md]]\n"
          "  📎 [[§ FAG/♪ Musik/MD/Gammel/[PLAN] 2026-09-09 - Enhed.md|[PLAN] …]]\n"
          "  📎 [[§ FAG/♪ Musik/NOTER/x/[NOTE] 2026-09-09.md]]\n"
          "---\n")
    log3: list = []
    out3 = rewrite_block(t3, "materiale_filer", s.MATERIALE_FIL_PREFIX, idx, log3)
    assert "[PLAN] " not in out3 and "[NOTE] " not in out3, out3
    assert out3.count("📎 [[") == 1, out3
    assert sorted(a for a, *_ in log3) == ["drop", "drop", "drop", "repeg"], log3
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        sys.exit(selfcheck())
    sys.exit(process("--apply" in sys.argv))
