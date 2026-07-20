#!/usr/bin/env python3
"""
VIAstudyWiz watch-folder-script.

Overvåger viastudywiz/-mappen for nye PDF'er, sender dem til MinerU's
officielle REST API (mineru.net/api/v4, se ValdiVault:
10_Projects/VIAstudyWiz/07-mineru-output-integration.md), og flytter/
omdøber outputtet ind ved siden af den originale PDF.

Kræver MINERU_API_TOKEN i en .env-fil ved siden af dette script
(gitignored, se mineru.net/apiManage/token for at hente et token).
"""

import re
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import requests
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

VAULT_ROOT = Path.home() / "Downloads" / "viastudywiz"
IGNORED_DIR_NAMES = {"_metadata"}
ENV_FILE = Path(__file__).parent / ".env"
API_BASE = "https://mineru.net/api/v4"
POLL_INTERVAL_S = 8
POLL_TIMEOUT_S = 20 * 60


def load_token() -> str:
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("MINERU_API_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError(f"MINERU_API_TOKEN mangler i {ENV_FILE}")


TOKEN = load_token()


def api_request(method: str, path: str, body: dict | None = None) -> dict:
    resp = requests.request(
        method,
        f"{API_BASE}{path}",
        json=body,
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


def already_converted(pdf_path: Path) -> bool:
    return (pdf_path.parent / f"{sanitize(pdf_path.stem)}.md").exists()


def submit(pdf_path: Path) -> str:
    resp = api_request(
        "POST",
        "/file-urls/batch",
        {"files": [{"name": pdf_path.name, "data_id": sanitize(pdf_path.stem)}], "model_version": "vlm"},
    )
    if resp.get("code") != 0:
        raise RuntimeError(f"file-urls/batch fejlede: {resp}")

    batch_id = resp["data"]["batch_id"]
    upload_url = resp["data"]["file_urls"][0]

    put_resp = requests.put(upload_url, data=pdf_path.read_bytes(), timeout=300)
    put_resp.raise_for_status()

    return batch_id


def poll(batch_id: str) -> dict:
    deadline = time.time() + POLL_TIMEOUT_S
    while time.time() < deadline:
        resp = api_request("GET", f"/extract-results/batch/{batch_id}")
        result = resp["data"]["extract_result"][0]
        if result["state"] == "done":
            return result
        if result["state"] == "failed":
            raise RuntimeError(f"MinerU-fejl: {result.get('err_msg')}")
        time.sleep(POLL_INTERVAL_S)
    raise TimeoutError(f"Timeout efter {POLL_TIMEOUT_S}s")


def integrate_output(pdf_path: Path, zip_url: str) -> None:
    title = sanitize(pdf_path.stem)
    dest_md = pdf_path.parent / f"{title}.md"
    dest_images = pdf_path.parent / f"{title}-images"

    # Vigtigt: udpakkes UDENFOR den overvågede vault-mappe. Ellers ser watchdog ZIP'ens egen
    # "<uuid>_origin.pdf"-kopi som en ny fil og prøver at behandle den igen (selv-triggeret loop).
    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        zip_path = tmp_dir / "result.zip"

        zip_resp = requests.get(zip_url, timeout=120)
        zip_resp.raise_for_status()
        zip_path.write_bytes(zip_resp.content)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp_dir)

        full_md = tmp_dir / "full.md"
        images_dir = tmp_dir / "images"

        text = full_md.read_text(encoding="utf-8")
        text = text.replace("images/", f"{dest_images.name}/")
        dest_md.write_text(text, encoding="utf-8")

        if images_dir.exists():
            if dest_images.exists():
                shutil.rmtree(dest_images)
            shutil.move(str(images_dir), str(dest_images))


def process_pdf(pdf_path: Path) -> None:
    if already_converted(pdf_path):
        return

    print(f"Uploader til MinerU: {pdf_path.name}", flush=True)
    try:
        batch_id = submit(pdf_path)
        result = poll(batch_id)
        integrate_output(pdf_path, result["full_zip_url"])
        print(f"Færdig: {pdf_path.name}", flush=True)
    except (requests.RequestException, RuntimeError, TimeoutError, OSError) as exc:
        print(f"Fejl ved {pdf_path.name}: {exc}", file=sys.stderr, flush=True)


def scan_existing() -> None:
    """Fanger PDF'er der allerede lå der før scriptet startede (watchdog ser kun nye events)."""
    for pdf_path in VAULT_ROOT.rglob("*.pdf"):
        if IGNORED_DIR_NAMES & {p.name for p in pdf_path.parents}:
            continue
        process_pdf(pdf_path)


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
        process_pdf(path)


def main():
    VAULT_ROOT.mkdir(parents=True, exist_ok=True)
    scan_existing()

    observer = Observer()
    observer.schedule(PdfHandler(), str(VAULT_ROOT), recursive=True)
    observer.start()
    print(f"Overvåger {VAULT_ROOT} ...", flush=True)
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
