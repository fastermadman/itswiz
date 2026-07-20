#!/usr/bin/env python3
"""
VIAstudyWiz watch-folder-script.

Overvåger viastudywiz/-mappen for nye PDF'er, sender dem til MinerU
(Finder-service-app'ens "upload"-kommando, cloud-baseret behandling),
venter på at outputtet dukker op i ~/MinerU/, og flytter/omdøber det
ind ved siden af den originale PDF. Se ValdiVault:
10_Projects/VIAstudyWiz/07-mineru-output-integration.md for baggrund.
"""

import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

VAULT_ROOT = Path.home() / "Downloads" / "viastudywiz"
MINERU_APP = Path("/Applications/MinerU.app/Contents/MacOS/MinerU")
MINERU_OUTPUT_ROOT = Path.home() / "MinerU"
IGNORED_DIR_NAMES = {"_metadata"}
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 20 * 60  # store scanninger kan ligge i kø et stykke tid


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


def already_converted(pdf_path: Path) -> bool:
    return (pdf_path.parent / f"{sanitize(pdf_path.stem)}.md").exists()


def find_run_folder(pdf_path: Path, after_ts: float) -> Path | None:
    """MinerU-app'en navngiver output-mapper '<originalt filnavn>-<uuid>'. Vi matcher på
    filnavn-præfiks og kræver at mappen er oprettet efter vi startede uploaden, så vi ikke
    ved en fejl griber en gammel kørsel af en fil med samme navn."""
    candidates = [
        p for p in MINERU_OUTPUT_ROOT.glob(f"{pdf_path.name}-*")
        if p.is_dir() and p.stat().st_mtime >= after_ts
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def wait_for_output(pdf_path: Path, after_ts: float) -> Path | None:
    deadline = time.time() + POLL_TIMEOUT_S
    run_folder = None
    while time.time() < deadline:
        if run_folder is None:
            run_folder = find_run_folder(pdf_path, after_ts)
        if run_folder is not None:
            full_md = run_folder / "full.md"
            if full_md.exists():
                size_before = full_md.stat().st_size
                time.sleep(POLL_INTERVAL_S)
                size_after = full_md.stat().st_size if full_md.exists() else -1
                if size_before == size_after and size_before > 0:
                    return run_folder
                continue
        time.sleep(POLL_INTERVAL_S)
    return None


def integrate_output(pdf_path: Path, run_folder: Path) -> None:
    title = sanitize(pdf_path.stem)
    dest_md = pdf_path.parent / f"{title}.md"
    dest_images = pdf_path.parent / f"{title}-images"

    full_md = run_folder / "full.md"
    images_dir = run_folder / "images"

    text = full_md.read_text(encoding="utf-8")
    text = text.replace("images/", f"{dest_images.name}/")
    dest_md.write_text(text, encoding="utf-8")

    if images_dir.exists():
        if dest_images.exists():
            shutil.rmtree(dest_images)
        shutil.move(str(images_dir), str(dest_images))

    shutil.rmtree(run_folder, ignore_errors=True)


def process_pdf(pdf_path: Path) -> None:
    if already_converted(pdf_path):
        return

    print(f"Sender til MinerU: {pdf_path.name}")
    started_at = time.time()
    subprocess.Popen(
        [str(MINERU_APP), "upload", str(pdf_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    run_folder = wait_for_output(pdf_path, started_at)
    if run_folder is None:
        print(f"Timeout: intet output fra MinerU for {pdf_path.name} inden for {POLL_TIMEOUT_S}s", file=sys.stderr)
        return

    integrate_output(pdf_path, run_folder)
    print(f"Færdig: {pdf_path.name}")


def scan_existing() -> None:
    """Fanger PDF'er der allerede lå der før scriptet startede (watchdog ser kun nye events)."""
    for pdf_path in VAULT_ROOT.rglob("*.pdf"):
        if IGNORED_DIR_NAMES & {p.name for p in pdf_path.parents}:
            continue
        try:
            process_pdf(pdf_path)
        except Exception as exc:
            print(f"Fejl ved behandling af {pdf_path}: {exc}", file=sys.stderr)


class PdfHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() != ".pdf":
            return
        if IGNORED_DIR_NAMES & {p.name for p in path.parents}:
            return
        time.sleep(2)  # lad downloadet blive helt færdigskrevet før vi rører den
        try:
            process_pdf(path)
        except Exception as exc:
            print(f"Fejl ved behandling af {path}: {exc}", file=sys.stderr)


def main():
    VAULT_ROOT.mkdir(parents=True, exist_ok=True)
    scan_existing()

    observer = Observer()
    observer.schedule(PdfHandler(), str(VAULT_ROOT), recursive=True)
    observer.start()
    print(f"Overvåger {VAULT_ROOT} ...")
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
