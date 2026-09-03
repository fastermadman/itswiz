#!/usr/bin/env python3
"""
Engangs-migrering af ~/ViaVault fra dato-mapper til enhed-mapper i FAG/-materialetræet.

    § FAG/<fag>/RAW/<dato> - <emne>/<fil>   ->  § FAG/<fag>/RAW/<enhed>/<fil>
    § FAG/<fag>/MD/<dato> - <emne>/<fil>    ->  § FAG/<fag>/MD/<enhed>/<fil>

`<enhed>` = normaliseret `emne` (itslearnings `plan.topic.name`, allerede i mappenavnet).
Flere lektioner i samme enhed smelter sammen til én mappe. Kollisioner:

  identiske bytes            -> dedup (behold én)
  type: dublet vs. rigtig    -> slet dubletten (redundant efter merge)
  0-byte / .sync-conflict    -> slet (spøgelses-/Syncthing-artefakt)
  samme navn, andet indhold  -> begge får dato-suffiks: "<navn> (<dato>).<ext>"

Rører IKKE:
  - NOTER/            (egne noter er filet efter lejlighed, 12's levetids-regel)
  - SUP-LIT/, Praktik/  og andre ikke-RAW/MD-grene
  - bare-dato-mapper uden emne (2026-04-15/) — beholdes som fallback
  - ukendte mapper (2.semester/, Rel Resources/) — springes over, rapporteres

Dry-run som standard. `--apply` udfører. `--selfcheck` kører de indbyggede asserts.

Se ValdiVault: 10_Projects/VIAstudyWiz/15-vault-fillayout-enhedsmapper.md
GitHub: fastermadman/viastudywiz-extension#149 (+ #148, #150)

Rækkefølge ved --apply (10-notens opskrift):
  1. python3 migrate_to_enhed_mapper.py            # læs planen
  2. launchctl unload …viastudywiz-watchfolder
  3. snapshot af § FAG/ (Syncthing .stversions + manuel kopi)
  4. python3 migrate_to_enhed_mapper.py --apply
  5. launchctl load …; genindlæs extension
"""

import hashlib
import re
import shutil
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from watch_viastudywiz import (  # noqa: E402
    ATTACHMENTS_DIR_NAME,
    FOLDER_SYMBOLS,
    MD_DIR_NAME,
    RAW_DIR_NAME,
    VAULT_ROOT,
)

FAG_ROOT = VAULT_ROOT / "§ FAG"
MIGRATED_BRANCHES = (RAW_DIR_NAME, MD_DIR_NAME)

BARE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BARE_WEEK = re.compile(r"^W\d{1,2}[a-zæøå]+$", re.IGNORECASE)
DATE_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2}|W\d{1,2}[a-zæøå]+)")

# (fag, rå-emne) -> ren enhed. Tom her — #150 fylder den ud (samme tabel som background.js'
# TOPIC_DISPLAY_NAMES). Indtil da migreres 1:1 på det saniterede emne; dry-run flagger skrald.
TOPIC_OVERRIDES: dict[tuple[str, str], str] = {}

JUNK_ENHED = re.compile(
    r"^(Underviser |LMS |JEPPEs |Selvstudie|Studietur|Opfinderdag|2\.semester)", re.IGNORECASE
)

SKIP_NAMES = {".DS_Store", ".stfolder", ".stignore"}
SYNC_CONFLICT = re.compile(r"\.sync-conflict-\d")
LINK_RE_TMPL = r"(\[\[§ FAG/{fag}/(?:RAW|MD)/){old}/"


def nfc(s: str) -> str:
    """macOS/Syncthing skriver nogle mappenavne i NFD ("a"+ring), extensionens strenge er NFC.
    Visuelt ens, byte-forskelligt — #131. Normalisér alt der sammenlignes eller bruges som nøgle."""
    return unicodedata.normalize("NFC", s)


def sanitize(name: str) -> str:
    return nfc(re.sub(r'[\\/:*?"<>|]', "_", name).strip())


def plain_fag(fag_dir_name: str) -> str:
    head, _, tail = fag_dir_name.partition(" ")
    return tail if head in FOLDER_SYMBOLS else fag_dir_name


def split_folder(name: str) -> tuple[str, str]:
    prefix, sep, emne = nfc(name).partition(" - ")
    return (prefix, emne) if sep else (nfc(name), "")


def folder_date(name: str) -> str:
    m = DATE_PREFIX.match(name)
    return m.group(1) if m else name


def enhed_for(fag_plain: str, emne: str) -> str:
    return TOPIC_OVERRIDES.get((fag_plain, emne), sanitize(emne))


def classify_folder(name: str) -> str:
    """'migrate' | 'keep' (gyldig bare-dato/uge) | 'skip' (ukendt)."""
    _, emne = split_folder(name)
    if emne:
        return "migrate"
    if BARE_DATE.match(name) or BARE_WEEK.match(name):
        return "keep"
    return "skip"


def is_ghost(path: Path) -> bool:
    return path.is_file() and (SYNC_CONFLICT.search(path.name) or path.stat().st_size == 0)


def fingerprint(path: Path) -> str:
    if path.is_dir():
        return repr(sorted((c.name, c.stat().st_size) for c in path.rglob("*") if c.is_file()))
    return hashlib.md5(path.read_bytes()).hexdigest()


def read_fm(md_path: Path) -> tuple[str | None, str]:
    """(type-værdi, body-md5) for en .md-note; (None, '') hvis ikke .md."""
    if md_path.suffix != ".md" or not md_path.is_file():
        return None, ""
    text = md_path.read_text(encoding="utf-8", errors="replace")
    m = re.match(r"---\n(.*?)\n---\n?", text, re.S)
    fm = m.group(1) if m else ""
    body = text[m.end():] if m else text
    t = re.search(r"^type:\s*(\S+)", fm, re.M)
    return (t.group(1) if t else None), hashlib.md5(body.strip().encode("utf-8")).hexdigest()


def wikilink_target(field_value: str) -> str:
    m = re.search(r"\[\[(.*?)\]\]", field_value)
    return m.group(1).split("|")[0].strip() if m else ""


def resolve_note(link: str, md_roots: list[Path]) -> Path | None:
    link = link.lstrip("/")
    for cand in (VAULT_ROOT / link, VAULT_ROOT / (link + ".md")):
        if cand.is_file():
            return cand
    stem = Path(link).stem
    hits = [p for root in md_roots for p in root.rglob(f"{stem}.md")]
    return hits[0] if len(hits) == 1 else None


# ─── planlægning ──────────────────────────────────────────────────────────────


class Plan:
    def __init__(self) -> None:
        self.moves: list[tuple[Path, Path]] = []
        self.dedups: list[tuple[Path, Path]] = []
        self.ghost_delete: list[Path] = []
        self.dublet_delete: list[tuple[Path, str]] = []
        self.dublet_keep_crossunit: list[tuple[Path, Path]] = []
        self.suffixed: list[tuple[Path, Path]] = []          # (src, dst-med-dato-suffiks)
        self.conflicts: list[tuple[Path, list[Path]]] = []   # ægte, uafgørlige
        self.kept_folders: list[Path] = []
        self.skipped_folders: list[Path] = []
        # (fag_plain, gammelt mappenavn, ny enhed, {gammelt stem: nyt stem} for suffiks-omdøbte)
        self.folder_moves: list[tuple[str, str, str, dict[str, str]]] = []
        self.junk_enheder: set[tuple[str, str]] = set()


def plan_fag(fag_dir: Path, plan: Plan) -> None:
    fag_plain = plain_fag(fag_dir.name)

    for branch_name in MIGRATED_BRANCHES:
        branch = fag_dir / branch_name
        if not branch.is_dir():
            continue

        by_dst: dict[Path, list[Path]] = {}
        src_folder_of: dict[Path, Path] = {}  # entry -> dens kildemappe

        for folder in sorted(branch.iterdir()):
            if folder.name in SKIP_NAMES or not folder.is_dir():
                continue
            kind = classify_folder(folder.name)
            if kind == "keep":
                plan.kept_folders.append(folder)
                continue
            if kind == "skip":
                plan.skipped_folders.append(folder)
                continue

            _, emne = split_folder(folder.name)
            enhed = enhed_for(fag_plain, emne)
            if JUNK_ENHED.match(enhed):
                plan.junk_enheder.add((fag_plain, enhed))
            dst_dir = branch / enhed
            if dst_dir == folder:
                continue

            for entry in sorted(folder.iterdir()):
                if entry.name in SKIP_NAMES:
                    continue
                if is_ghost(entry):
                    plan.ghost_delete.append(entry)
                    continue
                if entry.name == ATTACHMENTS_DIR_NAME and entry.is_dir():
                    for att in sorted(entry.iterdir()):
                        if att.name not in SKIP_NAMES:
                            key = dst_dir / ATTACHMENTS_DIR_NAME / att.name
                            by_dst.setdefault(key, []).append(att)
                            src_folder_of[att] = folder
                else:
                    by_dst.setdefault(dst_dir / entry.name, []).append(entry)
                    src_folder_of[entry] = folder

        _resolve_targets(by_dst, src_folder_of, plan)

        # registrér mappe-flytningerne (til link-omskrivning) med evt. suffiks-omdøbninger.
        # Alle navne NFC — wikilinks matches mod NFC-normaliseret notetekst (#131).
        renames_by_folder: dict[str, dict[str, str]] = {}
        for src, dst in plan.suffixed:
            if src in src_folder_of and src_folder_of[src].parent == branch:
                renames_by_folder.setdefault(nfc(src_folder_of[src].name), {})[nfc(src.stem)] = nfc(dst.stem)
        for folder in sorted(branch.iterdir()):
            if folder.is_dir() and classify_folder(folder.name) == "migrate":
                _, emne = split_folder(folder.name)
                enhed = enhed_for(fag_plain, emne)
                if enhed != nfc(folder.name):
                    # fag_dir.name (symbol-præfikset) — det er dét der står i wikilinks
                    plan.folder_moves.append(
                        (nfc(fag_dir.name), nfc(folder.name), enhed, renames_by_folder.get(nfc(folder.name), {}))
                    )


def _resolve_targets(by_dst, src_folder_of, plan: Plan) -> None:
    for dst, sources in by_dst.items():
        srcs = [*sources, dst] if dst.exists() else list(sources)

        if len(srcs) == 1:
            if srcs[0] != dst:
                plan.moves.append((srcs[0], dst))
            continue

        # md-noter: dublet taber; ellers sammenlign body
        if all(s.suffix == ".md" for s in srcs):
            typed = [(s, *read_fm(s)) for s in srcs]
            reals = [s for s, t, _ in typed if t != "dublet"]
            dubs = [s for s, t, _ in typed if t == "dublet"]
            for d in dubs:
                plan.dublet_delete.append((d, f"kollapser ind i {dst.name} ved merge"))
            bodies = {h for s, _, h in typed if s in reals}
            if len(reals) <= 1:
                keeper = reals[0] if reals else None
                if keeper and keeper != dst:
                    plan.moves.append((keeper, dst))
                continue
            if len(bodies) == 1:  # ægte noter, identisk brødtekst
                plan.dedups += [(r, dst) for r in reals[1:] if r != dst]
                if reals[0] != dst:
                    plan.moves.append((reals[0], dst))
                continue
            _suffix_all(reals, dst, src_folder_of, plan)
            continue

        # RAW-filer / _attachments-dirs
        if len({fingerprint(s) for s in srcs}) == 1:
            winner = max(srcs, key=lambda p: len(p.parts))
            for loser in srcs:
                if loser not in (winner, dst):
                    plan.dedups.append((loser, dst))
            if winner != dst:
                plan.moves.append((winner, dst))
        else:
            _suffix_all(srcs, dst, src_folder_of, plan)


def _suffix_all(srcs, dst, src_folder_of, plan: Plan) -> None:
    """Samme navn, forskelligt indhold: hver kilde beholdes med dato-suffiks."""
    for s in srcs:
        folder = src_folder_of.get(s)
        if folder is None:  # 's' er en allerede-eksisterende dst uden kildemappe — kan ikke suffikse
            plan.conflicts.append((dst, srcs))
            return
        date = folder_date(folder.name)
        new = dst.with_name(f"{dst.stem} ({date}){dst.suffix}")
        plan.suffixed.append((s, new))


def plan_dublets(plan: Plan, md_roots: list[Path]) -> None:
    already = {n for n, _ in plan.dublet_delete} | set(plan.ghost_delete)
    for root in md_roots:
        for md in sorted(root.rglob("*.md")):
            t, _ = read_fm(md)
            if t != "dublet" or md in already:
                continue
            text = md.read_text(encoding="utf-8", errors="replace")
            nf = re.search(r"^note:\s*(.+)$", text, re.M)
            target = resolve_note(wikilink_target(nf.group(1)), md_roots) if nf else None
            if target is None:
                plan.dublet_delete.append((md, "død pointer — note:-target opløses ikke"))
                continue
            se = split_folder(md.parent.name)[1]
            te = split_folder(target.parent.name)[1]
            if se and te and se == te:
                plan.dublet_delete.append((md, f"samme enhed som target ({se}) — redundant efter merge"))
            else:
                plan.dublet_keep_crossunit.append((md, target))


def _link_patterns(plan: Plan):
    pats = []
    for fag, old, new, renames in plan.folder_moves:
        base = LINK_RE_TMPL.format(fag=re.escape(fag), old=re.escape(old))
        pats.append((re.compile(base), new, renames))
    return pats


def count_link_rewrites(plan: Plan, md_roots: list[Path]) -> int:
    pats = _link_patterns(plan)
    hit = 0
    for root in md_roots:
        for md in root.rglob("*.md"):
            if any(p.search(nfc(md.read_text(encoding="utf-8", errors="replace"))) for p, _, _ in pats):
                hit += 1
    return hit


def apply_link_rewrites(plan: Plan, md_roots: list[Path]) -> None:
    pats = _link_patterns(plan)

    def rewrite(text: str) -> str:
        for pat, new, renames in pats:
            text = pat.sub(lambda m: f"{m.group(1)}{new}/", text)
            for old_stem, new_stem in renames.items():
                text = text.replace(f"/{new}/{old_stem}]]", f"/{new}/{new_stem}]]")
                text = text.replace(f"/{new}/{old_stem}.", f"/{new}/{new_stem}.")
        return text

    for root in md_roots:
        for md in root.rglob("*.md"):
            t = md.read_text(encoding="utf-8")
            # NFC-normalisér hele noten: wikilink-match kræver samme form som de NFC'de mappenavne,
            # og NFC er den kanoniske form extensionen selv skriver (#131).
            nt = rewrite(nfc(t))
            if nt != t:
                md.write_text(nt, encoding="utf-8")


# ─── kørsel ───────────────────────────────────────────────────────────────────


def rel(p: Path) -> str:
    try:
        return str(p.relative_to(VAULT_ROOT))
    except ValueError:
        return str(p)


def main() -> int:
    apply = "--apply" in sys.argv
    if not FAG_ROOT.is_dir():
        print(f"Ingen § FAG/ i {VAULT_ROOT}", file=sys.stderr)
        return 1

    plan = Plan()
    fag_dirs = [d for d in sorted(FAG_ROOT.iterdir()) if d.is_dir() and d.name not in SKIP_NAMES]
    for fag in fag_dirs:
        plan_fag(fag, plan)

    md_roots = [f / MD_DIR_NAME for f in fag_dirs if (f / MD_DIR_NAME).is_dir()]
    plan_dublets(plan, md_roots)

    seen = set()
    for fag, old, new, _ in plan.folder_moves:
        if (fag, old) in seen:
            continue
        seen.add((fag, old))
        print(f"  MERGE  {fag:14} {old!r}  ->  {new!r}")

    print(
        f"\n{len(plan.moves)} flytninger · {len(plan.dedups)} dedup · "
        f"{len(plan.suffixed)} dato-suffiks · {len(plan.ghost_delete)} spøgelsesnoter slettes · "
        f"{len(plan.dublet_delete)} dublet-noter slettes · "
        f"{len(plan.dublet_keep_crossunit)} tværgående dublets beholdes"
    )

    if plan.ghost_delete:
        print("\n── spøgelses-/sync-conflict-noter der slettes ──")
        for p in plan.ghost_delete:
            print(f"  DEL  {rel(p)}")

    if plan.suffixed:
        print("\n── samme navn, forskelligt indhold → dato-suffiks (begge beholdes) ──")
        for src, dst in plan.suffixed:
            print(f"  {rel(src)}\n     -> {rel(dst)}")

    if plan.dublet_delete:
        print("\n── dublet-noter der slettes ──")
        for note, why in plan.dublet_delete:
            print(f"  DEL  {rel(note)}\n       {why}")

    if plan.dublet_keep_crossunit:
        print("\n── tværgående dublets (behold; kandidat til used_in: senere, #148) ──")
        for note, tgt in plan.dublet_keep_crossunit:
            print(f"  KEEP {rel(note)}\n       -> {rel(tgt)}")

    if plan.kept_folders:
        print("\n── mapper beholdt (intet emne, gyldig fallback) ──")
        for f in plan.kept_folders:
            print(f"  {rel(f)}")

    if plan.skipped_folders:
        print("\n── mapper sprunget over (ukendt navn — se selv efter) ──")
        for f in plan.skipped_folders:
            print(f"  {rel(f)}")

    if plan.junk_enheder:
        print("\n── enheder der ligner skrald → skal mappes i #150 (TOPIC_DISPLAY_NAMES) ──")
        for fag, enhed in sorted(plan.junk_enheder):
            print(f"  {fag:14} {enhed!r}")

    if plan.conflicts:
        print("\nAFBRUDT — uafgørlige kollisioner:", file=sys.stderr)
        for dst, sources in plan.conflicts:
            print(f"  {rel(dst)}", file=sys.stderr)
            for s in sources:
                print(f"    <- {rel(s)}", file=sys.stderr)
        return 1

    n_links = count_link_rewrites(plan, md_roots + [f / "NOTER" for f in fag_dirs if (f / "NOTER").is_dir()])
    print(f"\n{n_links} .md-filer har wikilinks der skal skrives om (MD/ + NOTER/).")

    if not apply:
        print("\nDry-run. Kør med --apply for at udføre (stop watcher + snapshot først).")
        return 0

    link_roots = md_roots + [f / "NOTER" for f in fag_dirs if (f / "NOTER").is_dir()]

    for p in plan.ghost_delete:
        p.unlink()
    for note, _ in plan.dublet_delete:
        att = note.parent / ATTACHMENTS_DIR_NAME / note.stem
        if note.exists():
            note.unlink()
        if att.is_dir():
            shutil.rmtree(att)
    for src, dst in plan.moves + plan.suffixed:
        if not src.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    for src, _ in plan.dedups:
        if src.is_dir():
            shutil.rmtree(src)
        elif src.exists():
            src.unlink()

    apply_link_rewrites(plan, link_roots)

    for fag in fag_dirs:
        for branch_name in MIGRATED_BRANCHES:
            branch = fag / branch_name
            if not branch.is_dir():
                continue
            for folder in sorted(branch.iterdir()):
                if (
                    folder.is_dir()
                    and classify_folder(folder.name) == "migrate"
                    and not any(folder.iterdir())
                ):
                    folder.rmdir()

    print("Færdig. Kør watch_viastudywiz.py --selfcheck og verificér i Obsidian.")
    return 0


def selfcheck() -> int:
    assert split_folder("2026-08-26 - Hvad er religion") == ("2026-08-26", "Hvad er religion")
    assert split_folder("W36man - Skolens formål") == ("W36man", "Skolens formål")
    assert split_folder("2026-04-15") == ("2026-04-15", "")
    assert split_folder("2.semester") == ("2.semester", "")

    assert classify_folder("2026-08-26 - Emne") == "migrate"
    assert classify_folder("2026-04-15") == "keep"
    assert classify_folder("W36man") == "keep"
    assert classify_folder("Rel Resources") == "skip"

    assert folder_date("2026-08-26 - Emne") == "2026-08-26"
    assert folder_date("W36man - Skolens formål") == "W36man"

    assert enhed_for("Musik", "Når børn synger.") == "Når børn synger."
    assert enhed_for("Religion", "Hvad er religion?") == "Hvad er religion_"
    TOPIC_OVERRIDES[("Musik", "Underviser Klaus Glüsing")] = "Ledelse"
    assert enhed_for("Musik", "Underviser Klaus Glüsing") == "Ledelse"
    del TOPIC_OVERRIDES[("Musik", "Underviser Klaus Glüsing")]

    assert plain_fag("♪ Musik") == "Musik"
    assert plain_fag("Praktik") == "Praktik"

    assert wikilink_target('"[[§ FAG/♪ Musik/MD/X/note|alias]]"') == "§ FAG/♪ Musik/MD/X/note"

    # link-omskrivning: mappe + suffiks-omdøbning
    plan = Plan()
    plan.folder_moves = [("♪ Musik", "2026-08-25 - Musikforståelse", "Musikforståelse",
                          {"Resonans": "Resonans (2026-08-25)"})]
    class _T:
        def __init__(s, txt): s.txt = txt
        def read_text(s, **k): return s.txt
        def write_text(s, v, **k): s.txt = v
        def rglob(s, _): return [s]
    holder = _T(
        "a [[§ FAG/♪ Musik/MD/2026-08-25 - Musikforståelse/Resonans]] "
        "b [[§ FAG/♪ Musik/RAW/2026-08-25 - Musikforståelse/Andet.pdf]]"
    )
    apply_link_rewrites(plan, [holder])
    assert "[[§ FAG/♪ Musik/MD/Musikforståelse/Resonans (2026-08-25)]]" in holder.txt, holder.txt
    assert "[[§ FAG/♪ Musik/RAW/Musikforståelse/Andet.pdf]]" in holder.txt, holder.txt

    assert JUNK_ENHED.match("Underviser Lone Sonne")
    assert not JUNK_ENHED.match("Musikforståelse")

    assert SYNC_CONFLICT.search("Rosa.sync-conflict-20260830-130241-7XYEA2C.md")

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
