#!/usr/bin/env python3
"""
Engangs-rettelse (#218, #214-regression): wikilinks (frontmatter + brødtekst) der stadig peger på
`§ FAG/<fag>/(MD|RAW|NOTER)/<dato> - <emne>/<fil>` efter at mapperne er flyttet til `<emne>/`.
`obsidian move` omskrev kun brødtekst-links, ikke frontmatter.

Ny placering pr. stale sti, i denne rækkefølge (første der findes på disk):
  1. <gren>/<enhed>/<fil>
  2. <gren>/<enhed>/<fil-stem> (<dato>)<ext>      (dato-suffiks fra #214)
Findes ingen af dem, rapporteres linket og røres ikke.

Dry-run som standard. `--apply` skriver. `--selfcheck` kører asserts.
Forud for --apply: Hold Course slået fra og watchfolder standset (de skriver til de samme noter).
"""

import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from migrate_to_enhed_mapper import enhed_for, plain_fag  # noqa: E402
from watch_viastudywiz import VAULT_ROOT  # noqa: E402

# [[§ FAG/<fag>/<gren>/<dato|uge> - <emne>/<fil>   (mål slutter ved | # ] eller linjeskift)
LINK = re.compile(
    r"(\[\[)(§ FAG/(?P<fag>[^/\]|#\n]+)/(?P<gren>MD|RAW|NOTER)/"
    r"(?P<pref>\d{4}-\d{2}-\d{2}|W\d+[^\W\d_]*) - (?P<emne>[^/\]|#\n]+)/(?P<rest>[^\]|#\n]+))"
)


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def exists(root: Path, rel: str) -> bool:
    return (root / rel).exists() or (root / (rel + ".md")).exists()


def new_target(root: Path, m: re.Match) -> str | None:
    fag, gren, emne, pref, rest = (nfc(m.group(k)) for k in ("fag", "gren", "emne", "pref", "rest"))
    if exists(root, f"§ FAG/{fag}/{gren}/{pref} - {emne}/{rest}"):
        return None  # ikke stale
    enhed = enhed_for(plain_fag(fag), emne)
    base = f"§ FAG/{fag}/{gren}/{enhed}/"
    if exists(root, base + rest):
        return base + rest
    p = Path(rest)
    suffixed = f"{p.stem} ({pref}){p.suffix}"
    if exists(root, base + suffixed):
        return base + suffixed
    return ""  # stale men uden fundet mål


def fix_text(root: Path, text: str, stats: dict) -> str:
    def sub(m: re.Match) -> str:
        t = new_target(root, m)
        if t is None:
            return m.group(0)
        if t == "":
            stats["uløst"].append(nfc(m.group(2)))
            return m.group(0)
        stats["rettet"] += 1
        return m.group(1) + t

    return LINK.sub(sub, text)


def main() -> int:
    apply = "--apply" in sys.argv
    stats = {"rettet": 0, "uløst": [], "noter": 0}
    for path in sorted(VAULT_ROOT.rglob("*.md")):
        if any(part.startswith(".") for part in path.relative_to(VAULT_ROOT).parts):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if "§ FAG/" not in text:
            continue
        new = fix_text(VAULT_ROOT, text, stats)
        if new != text:
            stats["noter"] += 1
            if apply:
                path.write_text(new, encoding="utf-8")
    print(f"{stats['rettet']} links rettet i {stats['noter']} noter · {len(stats['uløst'])} uløste")
    for u in sorted(set(stats["uløst"]))[:40]:
        print(f"  UDEN MÅL {u}")
    if not apply:
        print("\nDry-run. --apply skriver (Hold Course fra, watchfolder standset).")
    return 0


def selfcheck() -> int:
    import tempfile

    root = Path(tempfile.mkdtemp())
    for f in ("§ FAG/♪ Musik/MD/Emne/a.md", "§ FAG/♪ Musik/MD/Emne/b (2026-09-03).md",
              "§ FAG/♪ Musik/RAW/Emne/c.pdf", "§ FAG/♪ Musik/NOTER/2026-09-03/x.md"):
        (root / f).parent.mkdir(parents=True, exist_ok=True)
        (root / f).write_text("x")
    s = {"rettet": 0, "uløst": []}
    t = ('materiale_filer:\n - "[[§ FAG/♪ Musik/MD/2026-09-01 - Emne/a.md|a]]"\n'
         "[[§ FAG/♪ Musik/MD/2026-09-03 - Emne/b]] [[§ FAG/♪ Musik/RAW/2026-09-03 - Emne/c.pdf]] "
         "[[§ FAG/♪ Musik/MD/2026-09-03 - Emne/mangler.md]] [[§ FAG/♪ Musik/NOTER/2026-09-03/x]]")
    out = fix_text(root, t, s)
    assert "[[§ FAG/♪ Musik/MD/Emne/a.md|a]]" in out, out
    assert "[[§ FAG/♪ Musik/MD/Emne/b (2026-09-03)]]" in out, out
    assert "[[§ FAG/♪ Musik/RAW/Emne/c.pdf]]" in out, out
    assert "MD/2026-09-03 - Emne/mangler.md" in out and s["rettet"] == 3 and len(s["uløst"]) == 1, (out, s)
    assert "NOTER/2026-09-03/x]]" in out  # bare-dato-mappe er ikke stale
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
