#!/usr/bin/env python3
"""
VIAstudyWiz watch-folder-script.

Overvåger ~/ViaVault (extensionen skriver direkte hertil via File System
Access API, se 09-file-system-access-migration.md) for nye dokumenter, sender dem til MinerU's
officielle REST API (mineru.net/api/v4, se ValdiVault:
10_Projects/VIAstudyWiz/07-mineru-output-integration.md), og skriver outputtet
over i fagets MD-gren:

    <fag>/RAW/<uge>/<titel>.pdf
      -> <fag>/MD/<uge>/<titel>.md
      -> <fag>/MD/<uge>/_attachments/<titel>/<sha>.jpg

MinerU har ingen indstilling for output-sti — API'et returnerer altid en zip med
full.md + images/, så placeringen er og bliver vores egen efterbehandling her i
integrate_output(). Kun filer under en RAW/-gren behandles; alt andet i vaulten er
enten Obsidian-noter eller Valdemars eget indhold (se 10-filsystem-design-raw-md.md).

Kræver MINERU_API_TOKEN i en .env-fil ved siden af dette script
(gitignored, se mineru.net/apiManage/token for at hente et token).
"""

import hashlib
import re
import shutil
import sys
import tempfile
import time
import zipfile
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

TIME_ZONE = ZoneInfo("Europe/Copenhagen")
VAULT_ROOT = Path.home() / "ViaVault"
RAW_DIR_NAME = "RAW"
MD_DIR_NAME = "MD"
ATTACHMENTS_DIR_NAME = "_attachments"
ENV_FILE = Path(__file__).parent / ".env"
API_BASE = "https://mineru.net/api/v4"
# MinerU v4 tager også Office-formater, ikke kun PDF (mineru.net/apiManage/docs) — så docx/pptx/
# xlsx behandles ensartet med PDF'erne. Fjern dem herfra hvis Office-filer ikke skal koste kvote.
SUPPORTED_SUFFIXES = {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}
POLL_INTERVAL_S = 8
POLL_TIMEOUT_S = 20 * 60


# Læses først ved første API-kald (ikke ved import), så sti-logikken kan enhedstestes uden .env.
@lru_cache(maxsize=1)
def load_token() -> str:
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("MINERU_API_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError(f"MINERU_API_TOKEN mangler i {ENV_FILE}")


def api_request(method: str, path: str, body: dict | None = None) -> dict:
    resp = requests.request(
        method,
        f"{API_BASE}{path}",
        json=body,
        headers={"Authorization": f"Bearer {load_token()}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


# MinerU skriver ![](images/<sha256>.jpg). Relative markdown-links knækker på titler med
# parentes ("Sange med kazoo (7)") — linket slutter ved den første ")". Billednavnene er
# indholds-hashes og dermed unikke i hele vaulten, så Obsidian-wikilinks resolver uanset hvor
# noten og _attachments-mappen ligger, og overlever at filer flyttes udenom Obsidian (Finder,
# migrations-script, Syncthing).
def to_wikilinks(markdown: str) -> str:
    return re.sub(r"!\[[^\]]*\]\(images/([^)]+)\)", r"![[\1]]", markdown)


# Egenskaber frem for mappe-struktur: fag/uge står i noten, så Obsidian Bases kan bygge
# litteraturoversigter på tværs af uger uden at strukturen skal kunne kode alting. `kilde` er
# Obsidian-alternativet til et symlink — hverken Obsidian (enkeltfiler) eller Syncthing-til-
# Android håndterer symlinks, men en wikilink virker både på Mac og på Boox'en.
def read_frontmatter_field(text: str, key: str) -> str | None:
    match = re.search(rf'^{re.escape(key)}:\s*"?([^"\n]*?)"?\s*$', text, re.MULTILINE)
    return match.group(1) if match and match.group(1) else None


# Ugemappens navn er "W34tors" eller "W34tors - Skolens formål" (background.js's
# weekFolderName()) — men selve lektionsplan-noten, skrevet direkte af extensionen med adgang
# til den fulde plan, har det rigtige tidspunkt (start/stop) oveni emnet. Foretræk den når den
# findes, fald tilbage til at parse emnet ud af mappenavnet ellers (fx hvis kalender-sync/
# lektionsplan-noter er slået fra i indstillingerne).
def enrich_from_plan_note(week_dir: Path) -> dict[str, str]:
    notes = list(week_dir.glob("* lektionsplan.md"))
    if not notes:
        return {}
    text = notes[0].read_text(encoding="utf-8")
    fields = {}
    for key in ("emne", "start", "stop"):
        value = read_frontmatter_field(text, key)
        if value:
            fields[key] = value
    return fields


# "hentet:" — lokal væg-tid i samme tidszone som extensionens egen formatNow() (TIME_ZONE), samme
# "yyyy-MM-dd HH:mm"-format, for konsistens på tværs af begge kodebaser (issue #34). Noter her
# skrives kun én gang (se already_converted()), så "opdateret:" giver ikke mening endnu.
def format_now() -> str:
    return datetime.now(TIME_ZONE).strftime("%Y-%m-%d %H:%M")


def frontmatter(doc_path: Path, note_type: str = "materiale", extra: str = "") -> str:
    raw_root = next(p for p in doc_path.parents if p.name == RAW_DIR_NAME)
    uge, _, folder_emne = doc_path.parent.name.partition(" - ")
    md_week_dir = raw_root.parent / MD_DIR_NAME / doc_path.parent.relative_to(raw_root)

    fields = enrich_from_plan_note(md_week_dir)
    emne = fields.get("emne") or folder_emne
    extra_lines = [f'emne: "{emne}"\n'] if emne else []
    extra_lines += [f'{key}: "{fields[key]}"\n' for key in ("start", "stop") if key in fields]

    return (
        "---\n"
        f"fag: {raw_root.parent.name}\n"
        f"uge: {uge}\n"
        f"type: {note_type}\n"
        f'kilde: "[[{doc_path.relative_to(VAULT_ROOT).as_posix()}]]"\n'
        f'hentet: "{format_now()}"\n'
        f"{''.join(extra_lines)}"
        f"{extra}"
        "---\n\n"
    )


def md_targets(doc_path: Path) -> tuple[Path, Path]:
    """<fag>/RAW/<uge>/<titel>.pdf -> (<fag>/MD/<uge>/<titel>.md, .../MD/<uge>/_attachments/<titel>/)"""
    raw_root = next(p for p in doc_path.parents if p.name == RAW_DIR_NAME)
    md_dir = raw_root.parent / MD_DIR_NAME / doc_path.parent.relative_to(raw_root)
    title = sanitize(doc_path.stem)
    return md_dir / f"{title}.md", md_dir / ATTACHMENTS_DIR_NAME / title


def in_raw_branch(path: Path) -> bool:
    return RAW_DIR_NAME in {p.name for p in path.parents}


# Samme dokument hænges tit på flere lektioner (fx "Sange med kazoo (7)" i både W34 og W35), så
# det havner i to ugemapper med hver sit element-id. RAW-kopierne får lov at blive — e-readeren
# skal kunne finde materialet i den uge det hører til — men MinerU skal kun betales én gang, og
# vidensbasen skal kun have én note. Dubletten findes ved at hashe: ingen sidecar-database at
# holde ved lige, og det selv-reparerer hvis noter slettes eller flyttes.
def existing_conversion(doc_path: Path) -> Path | None:
    raw_root = next(p for p in doc_path.parents if p.name == RAW_DIR_NAME)
    size = doc_path.stat().st_size
    digest = hashlib.sha256(doc_path.read_bytes()).hexdigest()

    for other in sorted(raw_root.rglob(f"*{doc_path.suffix}")):
        if other == doc_path or other.stat().st_size != size:
            continue
        if hashlib.sha256(other.read_bytes()).hexdigest() != digest:
            continue
        other_md = md_targets(other)[0]
        if other_md.exists():
            return other_md
    return None


def write_duplicate_stub(doc_path: Path, original_md: Path) -> None:
    dest_md = md_targets(doc_path)[0]
    dest_md.parent.mkdir(parents=True, exist_ok=True)
    link = original_md.relative_to(VAULT_ROOT).with_suffix("").as_posix()
    head = frontmatter(doc_path, note_type="dublet", extra=f'note: "[[{link}]]"\n')
    dest_md.write_text(f"{head}> Samme materiale som [[{link}]] — brugt igen i denne uge.\n", encoding="utf-8")


def error_marker_path(doc_path: Path) -> Path:
    return doc_path.parent / f".{sanitize(doc_path.stem)}.mineru-error.txt"


def already_converted(doc_path: Path) -> bool:
    return md_targets(doc_path)[0].exists()


def previously_failed(doc_path: Path) -> bool:
    # Undgår at retry en fil for evigt ved hver script-genstart (fx en PDF over MinerU's
    # sidegrænse vil aldrig lykkes) - marker-filen fjernes manuelt hvis man vil prøve igen.
    return error_marker_path(doc_path).exists()


def submit(doc_path: Path) -> str:
    resp = api_request(
        "POST",
        "/file-urls/batch",
        {"files": [{"name": doc_path.name, "data_id": sanitize(doc_path.stem)}], "model_version": "vlm"},
    )
    if resp.get("code") != 0:
        raise RuntimeError(f"file-urls/batch fejlede: {resp}")

    batch_id = resp["data"]["batch_id"]
    upload_url = resp["data"]["file_urls"][0]

    put_resp = requests.put(upload_url, data=doc_path.read_bytes(), timeout=300)
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


def integrate_output(doc_path: Path, zip_url: str) -> None:
    dest_md, dest_images = md_targets(doc_path)
    dest_md.parent.mkdir(parents=True, exist_ok=True)

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

        text = frontmatter(doc_path) + to_wikilinks(full_md.read_text(encoding="utf-8"))
        dest_md.write_text(text, encoding="utf-8")

        if images_dir.exists():
            if dest_images.exists():
                shutil.rmtree(dest_images)
            dest_images.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(images_dir), str(dest_images))


def process_document(doc_path: Path) -> None:
    if already_converted(doc_path) or previously_failed(doc_path):
        return

    original_md = existing_conversion(doc_path)
    if original_md:
        write_duplicate_stub(doc_path, original_md)
        print(f"Dublet af {original_md.name} — henviser i stedet for at konvertere igen", flush=True)
        return

    print(f"Uploader til MinerU: {doc_path.name}", flush=True)
    try:
        batch_id = submit(doc_path)
        result = poll(batch_id)
        integrate_output(doc_path, result["full_zip_url"])
        print(f"Færdig: {doc_path.name}", flush=True)
    except (requests.RequestException, RuntimeError, TimeoutError, OSError) as exc:
        print(f"Fejl ved {doc_path.name}: {exc}", file=sys.stderr, flush=True)
        error_marker_path(doc_path).write_text(str(exc), encoding="utf-8")


def scan_existing() -> None:
    """Fanger filer der allerede lå der før scriptet startede (watchdog ser kun nye events)."""
    for doc_path in sorted(VAULT_ROOT.glob(f"**/{RAW_DIR_NAME}/**/*")):
        if doc_path.is_file() and doc_path.suffix.lower() in SUPPORTED_SUFFIXES:
            process_document(doc_path)


class DocumentHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() not in SUPPORTED_SUFFIXES:
            return
        if not in_raw_branch(path):
            return
        time.sleep(2)  # lad downloadet blive helt færdigskrevet før vi rører den
        process_document(path)


def main():
    VAULT_ROOT.mkdir(parents=True, exist_ok=True)
    scan_existing()

    observer = Observer()
    observer.schedule(DocumentHandler(), str(VAULT_ROOT), recursive=True)
    observer.start()
    print(f"Overvåger {VAULT_ROOT} ...", flush=True)
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


def selfcheck() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        raw_pdf = root / "Musik" / RAW_DIR_NAME / "W34tors - Når børn synger." / "Titel.pdf"
        raw_pdf.parent.mkdir(parents=True)
        raw_pdf.write_bytes(b"")

        # Uden lektionsplan-note: emne genbruges fra mappenavnet, ingen start/stop.
        global VAULT_ROOT
        old_root, VAULT_ROOT = VAULT_ROOT, root
        try:
            fm = frontmatter(raw_pdf)
            assert "uge: W34tors\n" in fm, fm
            assert 'emne: "Når børn synger."' in fm, fm
            assert "start:" not in fm, fm

            # Med lektionsplan-note ved siden af: emne + start/stop kommer derfra i stedet.
            md_dir = root / "Musik" / MD_DIR_NAME / "W34tors - Når børn synger."
            md_dir.mkdir(parents=True)
            (md_dir / "W34tors - Når børn synger. lektionsplan.md").write_text(
                '---\nemne: "Når børn synger. (fra plan)"\nstart: "2026-08-20 08:15:00"\nstop: "2026-08-20 12:00:00"\n---\n',
                encoding="utf-8",
            )
            fm = frontmatter(raw_pdf)
            assert 'emne: "Når børn synger. (fra plan)"' in fm, fm
            assert 'start: "2026-08-20 08:15:00"' in fm, fm
            assert 'stop: "2026-08-20 12:00:00"' in fm, fm
        finally:
            VAULT_ROOT = old_root

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
