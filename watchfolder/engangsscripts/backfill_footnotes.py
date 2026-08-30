#!/usr/bin/env python3
"""
Engangsbackfill af MinerU-fodnoter i allerede-konverterede noter (issue #142, 2026-08-30):
write_conversion() skriver nu page_footnote-blokke til noten, men kun ved NYE konverteringer —
allerede eksisterende MD-noter blev konverteret FØR fixet og mangler stadig deres fodnoter.

Genbruger de allerede cachede MinerU-svar i ~/.viastudywiz-cache (nøglet på RAW-filens sha256,
se CACHE_DIR i watch_viastudywiz.py) — INGEN nye betalte MinerU-kald. Finder den RAW-fil hvert
cache-svar hører til ved at hashe alt under vaultens RAW-mapper og matche digests, kalder så
integrate_output() (samme funktion selve daemonen bruger) for at genskrive noten. Highlight-
beskyttelsen i write_conversion() (issue #42) gælder uændret: har Valdemar highlightet i den
eksisterende note, skrives den nye version til .ny.md i stedet for at overskrive.
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import watch_viastudywiz as w  # noqa: E402


def digest_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_raw_index() -> dict[str, Path]:
    index = {}
    for path in w.VAULT_ROOT.rglob(f"{w.RAW_DIR_NAME}/**/*"):
        if path.is_file():
            index[digest_of(path)] = path
    return index


def has_footnotes(zip_bytes: bytes) -> bool:
    import io
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.endswith("_content_list.json")]
        if not names:
            return False
        blocks = json.loads(zf.read(names[0]))
    return any(b.get("type") == "page_footnote" for b in blocks)


def main() -> int:
    apply = "--apply" in sys.argv
    print("Indekserer RAW-filer i vaulten (til at matche cache-digests)...")
    raw_index = build_raw_index()
    print(f"{len(raw_index)} RAW-filer fundet.")

    updated = skipped_no_match = skipped_no_footnotes = 0
    for cache_path in sorted(w.CACHE_DIR.glob("*.zip")):
        digest = cache_path.stem
        zip_bytes = cache_path.read_bytes()
        try:
            if not has_footnotes(zip_bytes):
                skipped_no_footnotes += 1
                continue
        except (zipfile.BadZipFile, json.JSONDecodeError):
            continue

        raw_path = raw_index.get(digest)
        if raw_path is None:
            skipped_no_match += 1
            continue

        if apply:
            w.integrate_output(raw_path, zip_bytes)
        updated += 1
        label = "Opdateret" if apply else "Ville opdatere"
        print(f"{label}: {raw_path.relative_to(w.VAULT_ROOT)}")

    print()
    print(f"{updated} note(r) med fodnoter {'opdateret' if apply else 'ville blive opdateret'}, "
          f"{skipped_no_footnotes} cache-svar uden fodnoter sprunget over, "
          f"{skipped_no_match} cache-svar uden en matchende RAW-fil på disk (formentlig ryddet op, se #138/#140).")
    if not apply:
        print("Dry-run. Kør med --apply for at skrive.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
