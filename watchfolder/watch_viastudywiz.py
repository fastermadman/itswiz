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
import json
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
# Uploads til MinerU's Aliyun-endpoint (Shanghai) kan lejlighedsvis være meget langsomme
# (~13 KB/s målt, issue #84) uden at MinerU selv fejler — 5 min var for kort til en 12 MB-fil på
# en dårlig dag. 3 forsøg med 30s mellemrum dækker forbigående routing-udsving uden at kræve
# manuel sletning af fejlmarkøren for hvert forsøg.
UPLOAD_TIMEOUT_S = 20 * 60
UPLOAD_RETRIES = 3
UPLOAD_RETRY_BACKOFF_S = 30

# Cache af MinerU's rå zip-svar, nøglet på dokumentets sha256 (#99). Beskytter mod at et
# scriptnedbrud MELLEM et vellykket (betalt) MinerU-kald og det færdige lokale output tvinger et
# nyt betalt kald ved næste forsøg. Uden for VAULT_ROOT så watchdog ikke ser den.
CACHE_DIR = Path.home() / ".viastudywiz-cache"
CACHE_TTL_S = 7 * 24 * 60 * 60


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
    # glob() ville fortolke "[PLAN]" som en karakterklasse (ét tegn ud af P/L/A/N), ikke en
    # bogstavelig streng — derfor startswith() på et almindeligt "*.md"-glob i stedet.
    notes = [p for p in week_dir.glob("*.md") if p.name.startswith("[PLAN] ")]
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
    data = doc_path.read_bytes()

    for attempt in range(1, UPLOAD_RETRIES + 1):
        try:
            put_resp = requests.put(upload_url, data=data, timeout=UPLOAD_TIMEOUT_S)
            put_resp.raise_for_status()
            return batch_id
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            if attempt == UPLOAD_RETRIES:
                raise
            print(
                f"Upload-forsøg {attempt}/{UPLOAD_RETRIES} for {doc_path.name} fejlede ({exc}) "
                f"— prøver igen om {UPLOAD_RETRY_BACKOFF_S}s",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(UPLOAD_RETRY_BACKOFF_S)


def cached_zip(digest: str) -> bytes | None:
    path = CACHE_DIR / f"{digest}.zip"
    if not path.exists():
        return None
    if time.time() - path.stat().st_mtime > CACHE_TTL_S:
        path.unlink()
        return None
    return path.read_bytes()


# TTL-tjek ved LÆSNING alene renser kun de dokumenter der faktisk forsøges igen — lykkes
# konverteringen første gang (det normale), bliver den fil aldrig læst igen, og cachen vokser
# ubegrænset (~80 dok/uge × median 6-7 MB er ikke plads til på en presset disk, se #99). Feje
# forældede filer her, ved SKRIVNING, betyder oprydningen sker som bivirkning af normal drift —
# stadig ingen cron.
def write_cache(digest: str, zip_bytes: bytes) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for stale in CACHE_DIR.glob("*.zip"):
        if now - stale.stat().st_mtime > CACHE_TTL_S:
            stale.unlink()
    (CACHE_DIR / f"{digest}.zip").write_bytes(zip_bytes)


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


# MinerU's content_list.json indeholder page_idx (0-indekseret PDF-position) på hver blok, men det
# ender aldrig i full.md — kun full.md + images/ beholdes i dag (se docstring øverst). Til
# citat/henvisningsbrug er PDF-position alene ofte forkert: mange af Valdemars PDF'er er scannede
# udpluk af bøger (fx "Ubbesen Klasseledelse i og med musik s181-199.pdf"), hvor bogens egen trykte
# sidetal ikke starter ved 1. MinerU kan selv genkende det trykte sidetal som en "page_number"-blok
# (typisk header/footer-tekst) — den foretrækkes når den findes, PDF-positionen er fallback.
def _group_blocks_by_page(blocks: list[dict]) -> dict[int, list[dict]]:
    pages: dict[int, list[dict]] = {}
    for block in blocks:
        page_idx = block.get("page_idx")
        if page_idx is None:
            continue
        pages.setdefault(page_idx, []).append(block)
    return pages


def _printed_page_number(page_blocks: list[dict]) -> str | None:
    # Dobbeltside-scans (opslag med to fysiske bogsider pr. PDF-side) splittes normalt FØR dette
    # kaldes (se _split_double_page, #101) — så page_blocks er allerede kun én fysisk sides
    # blokke, og der er kun ét page_number. Intervallet herunder er fallback for det scenarie
    # split ikke kunne afgøre (fx manglende layout.json/page_size, se insert_page_markers).
    # Live-verificeret 2026-08-17 mod "Materialitet I Fibiger & Jensen Andre verdener": page_idx=0
    # gav både "191" og "190" uden split.
    numbers = []
    other_texts = []
    for block in page_blocks:
        if block.get("type") != "page_number":
            continue
        text = (block.get("text") or "").strip()
        if not text:
            continue
        if text.isdigit():
            numbers.append(int(text))
        else:
            other_texts.append(text)
    if numbers:
        numbers = sorted(set(numbers))
        return f"{numbers[0]}–{numbers[-1]}" if len(numbers) > 1 else str(numbers[0])
    return other_texts[0] if other_texts else None


# #101: content_list.json's blokke har hver deres egen bbox (bekræftet ved inspektion af rå
# API-output) — en dobbeltside-scans to fysiske sider kan derfor skelnes ud fra om blokkens
# koordinat ligger i den ene eller anden halvdel af PDF-siden. Kun relevant når der faktisk ER
# to forskellige sidetal på samme page_idx; ellers ingen split (almindelig enkeltside-scan).
#
# #103: venstre/højre (x-aksen) er IKKE den eneste orientering i praksis — undervisere roterer
# ikke altid scanningen, så to fysiske sider kan lige så vel være stablet oven på hinanden
# (y-aksen). Live-verificeret på "Benedikt Otzen Myter i Genesis": de to page_number-blokke havde
# næsten identisk x0 (26 vs. 28) men vidt forskellig y0 (179 vs. 907) — en x-splittet ville lægge
# dem i samme halvdel og aldrig adskille dem. Løsningen prøver derfor begge akser og bruger den
# der rent faktisk lægger de to kendte sidetal i hver sin halvdel, i stedet for at antage
# orienteringen på forhånd.
def _bisect_blocks(page_blocks: list[dict], coord_index: int, mid: float) -> list[list[dict]]:
    halves: list[list[dict]] = [[], []]
    for block in page_blocks:
        bbox = block.get("bbox")
        coord = bbox[coord_index] if bbox else 0
        halves[0 if coord < mid else 1].append(block)
    return halves


def _split_double_page(page_blocks: list[dict], page_size: tuple[int, int]) -> list[list[dict]] | None:
    numbers = {
        int(b["text"].strip())
        for b in page_blocks
        if b.get("type") == "page_number" and (b.get("text") or "").strip().isdigit()
    }
    if len(numbers) != 2:
        return None

    for coord_index, dimension in ((0, page_size[0]), (1, page_size[1])):
        halves = _bisect_blocks(page_blocks, coord_index, dimension / 2)
        if not halves[0] or not halves[1]:
            continue
        half_numbers = [
            {int(b["text"].strip()) for b in half if b.get("type") == "page_number" and (b.get("text") or "").strip().isdigit()}
            for half in halves
        ]
        if half_numbers[0] and half_numbers[1] and not (half_numbers[0] & half_numbers[1]):
            return halves
    return None


# page_size findes kun i layout.json, ikke i content_list.json (se #98) — pdf_info-listen har sit
# eget page_idx-felt pr. side, ikke nødvendigvis liste-index, så der slås op på det eksplicit.
def _page_sizes(layout_path: Path | None) -> dict[int, tuple[int, int]]:
    if layout_path is None:
        return {}
    try:
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return {
        page["page_idx"]: tuple(page["page_size"])
        for page in layout.get("pdf_info", [])
        if "page_size" in page
    }


# Løbende sidehoved/-fod (fx kapitelnavn, gentaget identisk på hver side) er ikke støj men
# dokument-metadata — live-verificeret 2026-08-17: "Kap. 8. Materialitet" stod ordret i både
# header- og footer-blokke på 10-11 af 11 sider i "Materialitet I Fibiger & Jensen Andre verdener".
# Kræver flertal for at undgå at en enkeltstående afvigelse (fx en fejlscannet side) bliver taget
# som dokumentets faste overskrift.
def _extract_running_header(blocks: list[dict]) -> str | None:
    from collections import Counter

    texts = [
        (b.get("text") or "").strip()
        for b in blocks
        if b.get("type") in ("header", "footer") and (b.get("text") or "").strip()
    ]
    if not texts:
        return None
    text, count = Counter(texts).most_common(1)[0]
    return text if count >= len(texts) / 2 else None


# 40 tegn er et kompromis: langt nok til at være entydigt i de fleste dokumenter, kort nok at
# markdown-escaping (fx et **fed**-ord midt i ankeret) sjældent når at afvige fra rå JSON-teksten.
ANCHOR_LENGTH = 40


def _first_anchor_text(page_blocks: list[dict]) -> str | None:
    skip_types = {"page_number", "header", "footer", "aside_text"}
    for block in page_blocks:
        if block.get("type") in skip_types:
            continue
        text = (block.get("text") or "").strip()
        if text:
            return text[:ANCHOR_LENGTH]
    return None


def insert_page_markers(
    full_md_text: str, content_list_path: Path, layout_path: Path | None = None
) -> str:
    """Indsætter sidemarkører i markdown ud fra MinerU's content_list.json.

    Best-effort tekst-ankring, ikke garanteret præcis: for hver side søges dens første
    tekst-blok op i markdown'en (sekventielt fra sidste fundne position, så gentaget tekst
    tidligere i dokumentet ikke giver fejlmatch). Sider uden nogen søgbar tekst (rene
    billed-sider) springes stille over — ingen markør, ingen fejl.

    Sidetallet er (typisk) trykt i footeren på selve den fysiske side, ikke i headeren —
    derfor placeres markøren som en footer i markdown'en også: EFTER siden sit eget indhold,
    ikke før. Konkret betyder det at en sides label indsættes ved overgangen til NÆSTE sides
    indhold (forskudt ét trin i forhold til selve tekst-ankeret), og den sidste side får sin
    markør sat i slutningen af dokumentet i stedet for.

    `layout_path` (MinerU's layout.json, #98) er valgfri — findes den, splittes dobbeltside-
    scans (#101/#103) i deres to fysiske sider vha. bbox (venstre/højre eller top/bund, se
    _split_double_page), så hver får sin egen præcise markør i
    stedet for ét interval-tal for hele opslaget.
    """
    try:
        blocks = json.loads(content_list_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return full_md_text

    page_sizes = _page_sizes(layout_path)
    pages = _group_blocks_by_page(blocks)
    result = full_md_text
    search_pos = 0
    pending_label: str | None = None

    for page_idx in sorted(pages):
        page_blocks = pages[page_idx]
        page_size = page_sizes.get(page_idx)
        groups = (_split_double_page(page_blocks, page_size) if page_size else None) or [page_blocks]

        for group in groups:
            anchor = _first_anchor_text(group)
            if not anchor:
                continue
            idx = result.find(anchor, search_pos)
            if idx == -1:
                continue
            # Ankeret kan matche midt i en linje (fx lige efter "# " i en overskrift) — indsæt
            # markøren før hele linjen, ellers splittes fx overskriftens "#" fra sin egen tekst.
            line_start = result.rfind("\n", 0, idx) + 1
            if pending_label is not None:
                marker = f"\n\n*— side {pending_label} —*\n\n---\n\n"
                result = result[:line_start] + marker + result[line_start:]
                idx += len(marker)
            pending_label = _printed_page_number(group) or str(page_idx + 1)
            search_pos = idx + len(anchor)

    if pending_label is not None:
        result = result.rstrip("\n") + f"\n\n*— side {pending_label} —*\n"

    return result


def integrate_output(doc_path: Path, zip_bytes: bytes) -> None:
    dest_md, dest_images = md_targets(doc_path)
    dest_md.parent.mkdir(parents=True, exist_ok=True)

    # Vigtigt: udpakkes UDENFOR den overvågede vault-mappe. Ellers ser watchdog ZIP'ens egen
    # "<uuid>_origin.pdf"-kopi som en ny fil og prøver at behandle den igen (selv-triggeret loop).
    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        zip_path = tmp_dir / "result.zip"
        zip_path.write_bytes(zip_bytes)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp_dir)

        full_md = tmp_dir / "full.md"
        images_dir = tmp_dir / "images"

        md_text = full_md.read_text(encoding="utf-8")
        running_header = None
        content_list_matches = list(tmp_dir.glob("*_content_list.json"))
        if content_list_matches:
            layout_path = tmp_dir / "layout.json"
            md_text = insert_page_markers(
                md_text, content_list_matches[0], layout_path if layout_path.exists() else None
            )
            try:
                blocks = json.loads(content_list_matches[0].read_text(encoding="utf-8"))
                running_header = _extract_running_header(blocks)
            except (json.JSONDecodeError, OSError):
                pass

        extra_fm = f'sektion: "{running_header}"\n' if running_header else ""
        text = frontmatter(doc_path, extra=extra_fm) + to_wikilinks(md_text)
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

    digest = hashlib.sha256(doc_path.read_bytes()).hexdigest()
    zip_bytes = cached_zip(digest)
    try:
        if zip_bytes is None:
            print(f"Uploader til MinerU: {doc_path.name}", flush=True)
            batch_id = submit(doc_path)
            result = poll(batch_id)
            zip_resp = requests.get(result["full_zip_url"], timeout=120)
            zip_resp.raise_for_status()
            zip_bytes = zip_resp.content
            write_cache(digest, zip_bytes)
        else:
            print(f"Cache-hit, springer MinerU-kald over: {doc_path.name}", flush=True)
        integrate_output(doc_path, zip_bytes)
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
            (md_dir / "[PLAN] W34tors - Når børn synger..md").write_text(
                '---\nemne: "Når børn synger. (fra plan)"\nstart: "2026-08-20 08:15:00"\nstop: "2026-08-20 12:00:00"\n---\n',
                encoding="utf-8",
            )
            fm = frontmatter(raw_pdf)
            assert 'emne: "Når børn synger. (fra plan)"' in fm, fm
            assert 'start: "2026-08-20 08:15:00"' in fm, fm
            assert 'stop: "2026-08-20 12:00:00"' in fm, fm
        finally:
            VAULT_ROOT = old_root

        # Sidemarkører: trykt sidetal (page_number-blok) skal foretrækkes frem for PDF-position.
        blocks = [
            {"type": "title", "page_idx": 0, "text": "Kapitel 3"},
            {"type": "text", "page_idx": 0, "text": "Første afsnit på siden."},
            {"type": "page_number", "page_idx": 0, "text": "181"},
            {"type": "text", "page_idx": 1, "text": "Andet afsnit, næste side."},
            # Ingen page_number-blok her — falder tilbage til PDF-position (page_idx + 1 = 3).
            {"type": "text", "page_idx": 3, "text": "Fjerde PDF-side, ingen mellemliggende side 2 fanget."},
        ]
        content_list = root / "content_list.json"
        content_list.write_text(json.dumps(blocks), encoding="utf-8")
        md = "Kapitel 3\n\nFørste afsnit på siden.\n\nAndet afsnit, næste side.\n\nFjerde PDF-side, ingen mellemliggende side 2 fanget."
        marked = insert_page_markers(md, content_list)
        assert "*— side 181 —*" in marked, marked  # trykt sidetal foretrukket
        assert "*— side 2 —*" in marked, marked  # page_idx=1 uden page_number-blok -> 1+1
        assert "*— side 4 —*" in marked, marked  # page_idx=3 uden page_number-blok -> 3+1
        # Footer-semantik: en sides label står EFTER dens eget indhold, ikke før — den
        # optræder altså ved overgangen til NÆSTE sides tekst. Sidste side (4) har ingen
        # næste side at blive forskudt til, så dens markør ender i bunden af dokumentet.
        assert marked.index("Første afsnit") < marked.index("*— side 181 —*")
        assert marked.index("*— side 181 —*") < marked.index("Andet afsnit")
        assert marked.index("Andet afsnit") < marked.index("*— side 2 —*")
        assert marked.index("*— side 2 —*") < marked.index("Fjerde PDF-side")
        assert marked.index("Fjerde PDF-side") < marked.index("*— side 4 —*")

        # Manglende/korrupt content_list.json må aldrig vælte konverteringen — bare uændret markdown.
        missing = root / "does-not-exist.json"
        assert insert_page_markers(md, missing) == md

        # Dobbeltside-scanning: to page_number-blokke på samme page_idx (opslag), vilkårlig
        # rækkefølge i JSON'en — skal give en sorteret range, ikke bare den første fundne.
        spread_page = [
            {"type": "page_number", "page_idx": 0, "text": "191"},
            {"type": "page_number", "page_idx": 0, "text": "190"},
        ]
        assert _printed_page_number(spread_page) == "190–191"
        assert _printed_page_number([{"type": "page_number", "page_idx": 0, "text": "47"}]) == "47"
        assert _printed_page_number([{"type": "text", "page_idx": 0, "text": "ingen sidetal her"}]) is None

        # #103: opslag kan være vendt forskelligt side for side i samme dokument (nogle roteret
        # rigtigt, nogle ikke) — _split_double_page afgør akse pr. side ud fra hvor de to kendte
        # sidetal rent faktisk adskilles, i stedet for at antage én orientering for hele dokumentet.
        horizontal_spread = [
            {"type": "text", "page_idx": 0, "bbox": [10, 500, 200, 520], "text": "Venstre tekst"},
            {"type": "page_number", "page_idx": 0, "bbox": [10, 780, 30, 800], "text": "10"},
            {"type": "text", "page_idx": 0, "bbox": [400, 500, 590, 520], "text": "Højre tekst"},
            {"type": "page_number", "page_idx": 0, "bbox": [570, 780, 590, 800], "text": "11"},
        ]
        halves = _split_double_page(horizontal_spread, (600, 800))
        assert halves is not None, halves
        assert {b["text"] for b in halves[0]} == {"Venstre tekst", "10"}, halves
        assert {b["text"] for b in halves[1]} == {"Højre tekst", "11"}, halves

        # Reelle bbox-værdier fra "Benedikt Otzen Myter i Genesis" (#103): x0 for de to
        # page_number-blokke er næsten identisk (26 vs. 28) — en ren x-split ville aldrig
        # adskille dem. y0 derimod (179 vs. 907) adskiller rent, fordi siderne er stablet
        # oven på hinanden, ikke ved siden af hinanden (underviseren har ikke roteret scanningen).
        vertical_spread = [
            {"type": "text", "page_idx": 0, "bbox": [50, 50, 400, 150], "text": "Øverste side"},
            {"type": "page_number", "page_idx": 0, "bbox": [28, 179, 50, 197], "text": "34"},
            {"type": "text", "page_idx": 0, "bbox": [50, 700, 400, 800], "text": "Nederste side"},
            {"type": "page_number", "page_idx": 0, "bbox": [26, 907, 48, 927], "text": "35"},
        ]
        halves = _split_double_page(vertical_spread, (595, 841))
        assert halves is not None, halves
        assert {b["text"] for b in halves[0]} == {"Øverste side", "34"}, halves
        assert {b["text"] for b in halves[1]} == {"Nederste side", "35"}, halves

        # Almindelig enkeltside-scan (kun ét sidetal) — intet forsøg på split.
        assert _split_double_page([{"type": "page_number", "page_idx": 0, "bbox": [10, 10, 20, 20], "text": "5"}], (600, 800)) is None

        # Ingen af akserne kan adskille de to sidetal — sikker fallback til None (arver den
        # gamle interval-opførsel) i stedet for at gætte forkert.
        unsplittable = [
            {"type": "page_number", "page_idx": 0, "bbox": [10, 10, 20, 20], "text": "6"},
            {"type": "page_number", "page_idx": 0, "bbox": [10, 10, 20, 20], "text": "7"},
        ]
        assert _split_double_page(unsplittable, (600, 800)) is None

        # Løbende sidehoved/-fod: konsistent gentaget tekst (flertal) bliver til sektions-metadata,
        # en enkeltstående afvigelse (fejlscannet side) må ikke fejlagtigt tages som overskrift.
        consistent_header = [{"type": "header", "page_idx": i, "text": "Kap. 8. Materialitet"} for i in range(5)]
        assert _extract_running_header(consistent_header) == "Kap. 8. Materialitet"

        inconsistent = [{"type": "header", "page_idx": i, "text": f"tilfældig tekst {i}"} for i in range(5)]
        assert _extract_running_header(inconsistent) is None

        assert _extract_running_header([]) is None

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
