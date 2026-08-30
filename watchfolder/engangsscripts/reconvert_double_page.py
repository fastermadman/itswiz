#!/usr/bin/env python3
"""
Engangs-oprydning efter #101 (bbox-split af dobbeltside-scans i insert_page_markers()).

Noter konverteret FØR #101 (18/8) brugte den gamle fallback for opslag med to
page_number-blokke på samme page_idx: ét interval-tal ("*— side 190–191 —*") i
stedet for to præcise markører. De er kendetegnet ved netop det interval-mønster
i brødteksten - findes de, er dokumentet med stor sandsynlighed et opslag der nu
ville blive splittet korrekt.

Scriptet sletter noten + dens _attachments-mappe, så already_converted() i
watch_viastudywiz.py ser RAW-filen som ny igen ved næste kørsel. Ingen lokal
cache at genbruge her (MinerU-zip-cachen har kun ~1 uges TTL, se #99) - hver
genkonvertering koster et nyt MinerU-kald.

Noter med highlights (==tekst==) springes over i stedet for at slettes — write_conversion()'s
egen highlight-beskyttelse (#42) når aldrig at virke her, fordi allerede_converted() ser filen
som "ny" først EFTER den er slettet af dette script.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører de indbyggede tests.
"""
import re
import shutil
import sys
from pathlib import Path

from watch_viastudywiz import VAULT_ROOT, has_highlights, md_targets

INTERVAL_MARKER = re.compile(r"— side \d+–\d+ —")
KILDE_FIELD = re.compile(r'^kilde:\s*"\[\[([^\]]+)\]\]"', re.MULTILINE)


def find_affected(root: Path = VAULT_ROOT) -> list[tuple[Path, Path]]:
    """Returnerer [(note_path, raw_pdf_path), ...] for noter med det gamle intervalmærke."""
    jobs = []
    for note in sorted(root.rglob("*.md")):
        text = note.read_text(encoding="utf-8", errors="ignore")
        if not INTERVAL_MARKER.search(text):
            continue
        m = KILDE_FIELD.search(text)
        if not m:
            print(f"ADVARSEL: intervalmærke fundet, men intet kilde-felt: {note}", file=sys.stderr)
            continue
        raw_path = root / m.group(1)
        if not raw_path.exists():
            print(f"ADVARSEL: kilde-fil mangler for {note}: {raw_path}", file=sys.stderr)
            continue
        jobs.append((note, raw_path))
    return jobs


def main() -> int:
    apply = "--apply" in sys.argv
    jobs = find_affected()

    for note, raw_path in jobs:
        print(f"{note.relative_to(VAULT_ROOT)}  <-  {raw_path.relative_to(VAULT_ROOT)}")
    print(f"\n{len(jobs)} note(r) med gammelt intervalmærke fundet.")

    if not apply:
        print("Dry-run. Kør med --apply for at slette dem (genkonverteres af watch_viastudywiz.py ved næste kørsel).")
        return 0

    deleted = 0
    for note, raw_path in jobs:
        if has_highlights(note):
            print(f"Springer over (highlights): {note.relative_to(VAULT_ROOT)}", file=sys.stderr)
            continue
        note.unlink()
        deleted += 1
        _, attachments_dir = md_targets(raw_path)
        if attachments_dir.exists():
            shutil.rmtree(attachments_dir)

    print(f"Færdig. {deleted} note(r) + tilhørende _attachments slettet, {len(jobs) - deleted} sprunget over (highlights).")
    return 0


def selfcheck() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        raw_dir = root / "Musik" / "RAW" / "W34tors"
        raw_dir.mkdir(parents=True)
        raw_pdf = raw_dir / "Titel.pdf"
        raw_pdf.write_bytes(b"")

        md_dir = root / "Musik" / "MD" / "W34tors"
        md_dir.mkdir(parents=True)
        affected = md_dir / "Titel.md"
        affected.write_text(
            '---\nkilde: "[[Musik/RAW/W34tors/Titel.pdf]]"\n---\n\nTekst.\n\n*— side 190–191 —*\n',
            encoding="utf-8",
        )
        unaffected = md_dir / "Andet.md"
        unaffected.write_text(
            '---\nkilde: "[[Musik/RAW/W34tors/Titel.pdf]]"\n---\n\nTekst uden intervalmærke.\n\n*— side 47 —*\n',
            encoding="utf-8",
        )

        jobs = find_affected(root)
        assert len(jobs) == 1, jobs
        assert jobs[0][0] == affected, jobs
        assert jobs[0][1] == raw_pdf, jobs

        # Highlightede noter beskyttes mod sletning, selv når de er "affected" (#42).
        affected.write_text(
            affected.read_text(encoding="utf-8") + "\n==vigtig markering==\n", encoding="utf-8"
        )
        assert has_highlights(affected)

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
