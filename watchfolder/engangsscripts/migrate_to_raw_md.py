#!/usr/bin/env python3
"""
Engangs-migrering af ~/ViaVault fra flad fag-mappe til RAW/MD-strukturen.

    <fag>/W34tors - Titel.pdf          ->  <fag>/RAW/W34tors/Titel.pdf
    <fag>/W34tors - Titel.md           ->  <fag>/MD/W34tors/Titel.md
    <fag>/W34tors - Titel-images/      ->  <fag>/MD/W34tors/_attachments/Titel/
    <fag>/W33ons/Titel.pdf             ->  <fag>/RAW/W33ons/Titel.pdf   (manuelt oprettede ugemapper)

Billed-embeds i de flyttede .md-filer skrives om til Obsidian-wikilinks
(![[<sha>.jpg]]), så de resolver uanset hvor noten og billederne ligger — de
relative markdown-links knækker i dag på titler med parentes.

Kører i dry-run som standard. `--apply` udfører flytningerne, `--selfcheck`
kører de indbyggede asserts.

Se ValdiVault: 10_Projects/VIAstudyWiz/10-filsystem-design-raw-md.md
"""

import hashlib
import re
import shutil
import sys
from pathlib import Path

from watch_viastudywiz import (
    ATTACHMENTS_DIR_NAME,
    MD_DIR_NAME,
    RAW_DIR_NAME,
    VAULT_ROOT,
    frontmatter,
    md_targets,
)


# Dette er en spent engangs-migrering (kørt for længst, vaulten er to strukturer videre).
# `write_duplicate_stub()` blev fjernet fra watch_viastudywiz.py da `type: dublet`-modellen
# udgik til fordel for `used_in:` (#148 opgave 2) — den gamle stub-form beholdes lokalt her,
# så scriptet stadig kan læses/køre som historisk reference.
def write_duplicate_stub(doc_path: Path, original_md: Path) -> None:
    dest_md = md_targets(doc_path)[0]
    dest_md.parent.mkdir(parents=True, exist_ok=True)
    link = original_md.relative_to(VAULT_ROOT).with_suffix("").as_posix()
    head = frontmatter(doc_path, extra=f'note: "[[{link}]]"\n').replace(
        "type: materiale", "type: dublet", 1
    )
    dest_md.write_text(f"{head}> Samme materiale som [[{link}]] — brugt igen i denne uge.\n", encoding="utf-8")

WEEK_PREFIX = re.compile(r"^(W\d{1,2}[a-zæøå]+) - (.+)$")
WEEK_FOLDER = re.compile(r"^W\d{1,2}[a-zæøå]+$")
IMAGE_EMBED = re.compile(r"!\[[^\]]*\]\(.*?([0-9a-f]{32,}\.(?:jpg|jpeg|png|webp))\)")
SKIP_NAMES = {".DS_Store"}


def to_wikilinks(markdown: str) -> str:
    return IMAGE_EMBED.sub(r"![[\1]]", markdown)


def destination(fag: Path, week: str, name: str) -> Path:
    """Hvor lander en fil/mappe ved navn `name` fra uge `week`?"""
    if name.endswith("-images"):
        return fag / MD_DIR_NAME / week / ATTACHMENTS_DIR_NAME / name[: -len("-images")]
    if name.endswith(".md"):
        return fag / MD_DIR_NAME / week / name
    return fag / RAW_DIR_NAME / week / name


def plan_fag(fag: Path) -> list[tuple[Path, Path]]:
    moves = []
    for entry in sorted(fag.iterdir()):
        if entry.name in SKIP_NAMES or entry.name in {"RAW", "MD"}:
            continue

        # Manuelt oprettet ugemappe (fx LSkr-2628/W33ons/) — indholdet har intet uge-præfiks.
        if entry.is_dir() and WEEK_FOLDER.match(entry.name):
            for child in sorted(entry.iterdir()):
                if child.name in SKIP_NAMES:
                    continue
                moves.append((child, destination(fag, entry.name, child.name)))
            continue

        # Skjulte fejl-markører hedder ".W34tors - Titel.mineru-error.txt".
        bare = entry.name[1:] if entry.name.startswith(".") else entry.name
        match = WEEK_PREFIX.match(bare)
        if not match:
            print(f"  ? springer over (intet uge-præfiks): {entry.name}")
            continue
        week, rest = match.groups()
        moves.append((entry, destination(fag, week, ("." + rest) if entry.name.startswith(".") else rest)))

    return moves


def fingerprint(path: Path) -> str:
    if path.is_dir():
        return str(sorted((c.name, c.stat().st_size) for c in path.iterdir()))
    return hashlib.md5(path.read_bytes()).hexdigest()


def resolve_duplicates(moves):
    """Nogle filer ligger både fladt og i en manuelt oprettet ugemappe (samme bytes, to steder).
    Er de identiske, migreres kun kopien fra ugemappen — den flade efterlades urørt så intet
    slettes automatisk. Er de forskellige, er det en rigtig konflikt der skal ses på i hånden."""
    by_destination = {}
    for src, dst in moves:
        by_destination.setdefault(dst, []).append(src)

    keep, conflicts = [], []
    for dst, sources in by_destination.items():
        if dst.exists():
            conflicts.append((dst, [*sources, dst]))
        elif len(sources) == 1:
            keep.append((sources[0], dst))
        elif len({fingerprint(s) for s in sources}) == 1:
            winner = max(sources, key=lambda p: len(p.parts))
            keep.append((winner, dst))
            for loser in sources:
                if loser != winner:
                    print(f"\n  DUBLET (identisk) — bliver liggende, slet selv: {loser}")
        else:
            conflicts.append((dst, sources))
    return keep, conflicts


def plan_duplicate_stubs(moves):
    """Samme dokument hænges tit på flere lektioner. RAW-kopierne beholdes (e-readeren skal kunne
    finde materialet i den rigtige uge), men noten skrives kun én gang — de senere uger får en
    henvisning. Samme regel som watch-scriptet bruger fremover, kørt bagud over det der ligger."""
    by_content = {}
    for src, dst in moves:
        if src.is_file() and RAW_DIR_NAME in {p.name for p in dst.parents}:
            raw_root = next(p for p in dst.parents if p.name == RAW_DIR_NAME)
            by_content.setdefault((raw_root, fingerprint(src)), []).append(dst)

    # Kun dokumenter der faktisk har en note at henvise til (fx .ppt er aldrig blevet konverteret).
    notes = {dst for _, dst in moves if dst.suffix == ".md"}
    stubs = []
    for copies in by_content.values():
        original, *duplicates = sorted(copies)
        if md_targets(original)[0] not in notes:
            continue
        stubs += [(d, original) for d in duplicates if md_targets(d)[0] in notes]
    return stubs


def source_document(md_path: Path) -> Path | None:
    """Find RAW-filen en migreret note stammer fra (samme uge, samme stamme, hvilken som helst endelse)."""
    md_root = next(p for p in md_path.parents if p.name == MD_DIR_NAME)
    raw_dir = md_root.parent / RAW_DIR_NAME / md_path.parent.relative_to(md_root)
    return next((p for p in sorted(raw_dir.glob(f"{md_path.stem}.*")) if p.is_file()), None)


def add_frontmatter(md_path: Path) -> None:
    """De eksisterende noter har ingen egenskaber — uden dem kan Obsidian Bases ikke se dem."""
    text = md_path.read_text(encoding="utf-8")
    source = source_document(md_path)
    if text.startswith("---") or source is None:
        return
    md_path.write_text(frontmatter(source) + text, encoding="utf-8")


def collapse_duplicate(duplicate_raw: Path, original_raw: Path) -> None:
    duplicate_md, duplicate_images = md_targets(duplicate_raw)
    original_md, original_images = md_targets(original_raw)
    if not duplicate_md.exists() or not original_md.exists():
        return

    write_duplicate_stub(duplicate_raw, original_md)

    # Billederne er de samme sha256-navne som originalens — kun redundante kopier ryger.
    if duplicate_images.is_dir() and original_images.is_dir():
        same = {p.name for p in duplicate_images.iterdir()} == {p.name for p in original_images.iterdir()}
        if same:
            shutil.rmtree(duplicate_images)


def find_fag_dirs() -> list[Path]:
    """Fag-mapper = topniveau-mapper med mindst ét uge-præfikset navn i sig."""
    fag_dirs = []
    for entry in sorted(VAULT_ROOT.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if any(WEEK_PREFIX.match(c.name.lstrip(".")) or WEEK_FOLDER.match(c.name) for c in entry.iterdir()):
            fag_dirs.append(entry)
    return fag_dirs


def main() -> int:
    apply = "--apply" in sys.argv
    moves: list[tuple[Path, Path]] = []

    for fag in find_fag_dirs():
        print(f"\n{fag.name}/")
        fag_moves = plan_fag(fag)
        for src, dst in fag_moves:
            print(f"  {src.relative_to(fag)}  ->  {dst.relative_to(fag)}")
        moves += fag_moves

    moves, conflicts = resolve_duplicates(moves)
    if conflicts:
        print("\nAFBRUDT — to forskellige filer vil lande samme sted:", file=sys.stderr)
        for dst, sources in conflicts:
            print(f"  {dst}", file=sys.stderr)
            for src in sources:
                print(f"    <- {src}", file=sys.stderr)
        return 1

    stubs = plan_duplicate_stubs(moves)
    if stubs:
        print("\nSamme dokument i flere uger — noten skrives ét sted, resten henviser:")
        for duplicate, original in stubs:
            print(f"  {duplicate.relative_to(VAULT_ROOT)}  ->  henviser til {original.parent.name}")

    print(f"\n{len(moves)} flytninger, {len(stubs)} noter bliver til henvisninger.")
    if not apply:
        print("Dry-run. Kør med --apply for at udføre.")
        return 0

    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        if dst.suffix == ".md":
            dst.write_text(to_wikilinks(dst.read_text(encoding="utf-8")), encoding="utf-8")

    for _, dst in moves:
        if dst.suffix == ".md":
            add_frontmatter(dst)

    for duplicate, original in stubs:
        collapse_duplicate(duplicate, original)

    for fag in find_fag_dirs():
        for leftover in sorted(fag.glob("W*")):
            if leftover.is_dir() and not any(leftover.iterdir()):
                leftover.rmdir()

    print("Færdig.")
    return 0


def selfcheck() -> int:
    sha = "5a82758cf95ea5f15ad38c7f357b683e9d0018663874a02855976a7b2fd904b8.jpg"
    # Titel med parentes gav et knækket markdown-link — hele pointen med wikilinks.
    assert to_wikilinks(f"![](W34tors - Sange med kazoo (7)-images/{sha})") == f"![[{sha}]]"
    assert to_wikilinks(f"![](images/{sha})") == f"![[{sha}]]"
    assert to_wikilinks("![](noget-andet.pdf)") == "![](noget-andet.pdf)"

    fag = Path("/v/LSmu-2527")
    assert destination(fag, "W34tors", "Titel.pdf") == fag / "RAW/W34tors/Titel.pdf"
    assert destination(fag, "W34tors", "Titel.md") == fag / "MD/W34tors/Titel.md"
    assert destination(fag, "W34tors", "Titel-images") == fag / "MD/W34tors/_attachments/Titel"
    assert destination(fag, "W34tors", ".Titel.mineru-error.txt") == fag / "RAW/W34tors/.Titel.mineru-error.txt"

    # Watch-scriptet skal ramme præcis de stier migreringen producerer.
    from watch_viastudywiz import md_targets

    md, images = md_targets(fag / "RAW/W34tors/Titel.pdf")
    assert md == fag / "MD/W34tors/Titel.md", md
    assert images == fag / "MD/W34tors/_attachments/Titel", images

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
