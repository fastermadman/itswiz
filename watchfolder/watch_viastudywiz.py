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
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import sync_hold_course

TIME_ZONE = ZoneInfo("Europe/Copenhagen")
VAULT_ROOT = Path.home() / "ViaVault"
RAW_DIR_NAME = "RAW"
MD_DIR_NAME = "MD"
# Matcher background.js' FOLDER_SYMBOLS. Mappenavnet har symbolet foran til visuel navigation
# (issue #63), men fag:-frontmatter skal blive ved det rene navn, ellers splitter Bases'
# groupBy/filter materiale-/dublet-noter fra lektionsplan-/opgave-noter i to grupper (issue #111).
FOLDER_SYMBOLS = {"♪": "Musik", "♱": "Religion", "⚖︎": "LivsOplysning"}
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

# Hver enkelt HTTP-kald har sin egen timeout ovenfor, men intet fangede tidligere hvis
# process_document() som HELHED hang længere end summen af dem — live-observeret 2+ timers
# fastlåsning uden ny log-linje (issue #143). Loftet er den teoretiske værst-tænkelige sti
# (alle upload-forsøg + poll) plus luft til zip-download/diskskrivning, så den kun rammer reelle
# hæng, ikke langsomme-men-normale konverteringer.
PROCESS_TIMEOUT_S = UPLOAD_TIMEOUT_S * UPLOAD_RETRIES + POLL_TIMEOUT_S + 10 * 60

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
def enrich_from_plan_note(week_dir: Path, md_name: str = "") -> dict[str, str]:
    # glob() ville fortolke "[PLAN]" som en karakterklasse (ét tegn ud af P/L/A/N), ikke en
    # bogstavelig streng — derfor startswith() på et almindeligt "*.md"-glob i stedet.
    notes = sorted(p for p in week_dir.glob("*.md") if p.name.startswith("[PLAN] "))
    if not notes:
        return {}
    text = _plan_note_for(notes, md_name).read_text(encoding="utf-8")
    fields = {}
    for key in ("emne", "uge", "ugedag", "dato", "start", "stop"):
        value = read_frontmatter_field(text, key)
        if value:
            fields[key] = value
    return fields


# Efter enhed-migreringen (#150/#155) ligger ALLE en enheds [PLAN]-noter i samme MD-mappe, så
# "den første note i mappen" er et vilkårligt valg blandt søskende — og det er netop dét der gav
# materiale-noter et `dato:` fra en anden lektion end den de hører til (mekanismen bag #183's
# observation om at `dato:` ikke matcher filnavnets dato-suffiks). Det pålidelige signal er
# background.js' egen plan.elements-liste, som står i AUTO-blokkens "## Materialer" pr. plan:
# den plan der nævner FILEN er dens ejer. Nævner ingen den (MinerU-konverteringen er asynkron og
# kan nå frem før background.js har skrevet planen — hele grunden til at #141 findes), falder vi
# tilbage til den første note, som før. Kun uge/ugedag/dato/start/stop rammes af valget; `emne`
# er enhedens navn og dermed ens for alle søskende.
def _plan_note_for(notes: list[Path], md_name: str) -> Path:
    if md_name and len(notes) > 1:
        for note in notes:
            body = note.read_text(encoding="utf-8")
            # Samme regex som sync_hold_course._owned_targets — formatet er background.js'
            # AUTO-blok, og to kopier ville kunne drifte fra hinanden.
            block = sync_hold_course.AUTO_MATERIALER_RE.search(body)
            if block and any(link.rsplit("/", 1)[-1] == md_name
                             for link in re.findall(r"\[\[([^|\]]+)", block.group(1))):
                return note
    return notes[0]


_DAYS_DA = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]


def time_fields_from_start(start: str) -> dict[str, str]:
    """"2026-09-18 08:15:00" -> {uge: "2026-W38", ugedag: "fredag", dato: "2026-09-18"}.
    Fallback når lektionsplan-noten mangler (#154)."""
    try:
        dt = datetime.fromisoformat(start.strip())
    except ValueError:
        return {}
    y, w, wd = dt.isocalendar()
    return {"uge": f"{y}-W{w:02d}", "ugedag": _DAYS_DA[wd - 1], "dato": dt.strftime("%Y-%m-%d")}


# "hentet:" — lokal væg-tid i samme tidszone som extensionens egen formatNow() (TIME_ZONE), samme
# "yyyy-MM-dd HH:mm"-format, for konsistens på tværs af begge kodebaser (issue #34). Noter her
# skrives kun én gang (se already_converted()), så "opdateret:" giver ikke mening endnu.
def format_now() -> str:
    return datetime.now(TIME_ZONE).strftime("%Y-%m-%d %H:%M")


def plain_fag(folder_name: str) -> str:
    for symbol, name in FOLDER_SYMBOLS.items():
        if folder_name == f"{symbol} {name}":
            return name
    return folder_name


# RAW/MD-mappen hedder nu "<enhed>" (background.js' enhedFolder), ikke "<dato> - <emne>".
# `uge:` og `emne:` hentes derfor fra lektionsplan-noten (enrich_from_plan_note); mappe-navnet
# bruges kun som fallback hvis den note mangler (kalender-sync slået fra) eller endnu ikke er
# migreret ("<dato> - <emne>"-form).
_DATE_OR_WEEK = re.compile(r"^(\d{4}-\d{2}-\d{2}|W\d{1,2}[a-zæøå]+)", re.IGNORECASE)


def frontmatter(doc_path: Path, note_type: str = "materiale", extra: str = "") -> str:
    raw_root = next(p for p in doc_path.parents if p.name == RAW_DIR_NAME)
    folder = doc_path.parent.name
    _, _, folder_emne = folder.partition(" - ")
    md_week_dir = raw_root.parent / MD_DIR_NAME / doc_path.parent.relative_to(raw_root)

    fields = enrich_from_plan_note(md_week_dir, f"{sanitize(doc_path.stem)}.md")
    # enhed-mappe: hele navnet er emnet; dato-fallback-mappe (intet topic): intet emne.
    # Ligger filen direkte i RAW/ uden nogen mappe imellem (manuelt tilføjet korpus/praktik,
    # ikke lektionsbundet — fx SUP-LIT/EMU-kristendom, #67/#114), er der ingen uge og intet
    # emne at udlede; mappenavnet ("RAW") må ikke lække ind som feltværdi.
    no_folder_meta = folder == RAW_DIR_NAME or bool(_DATE_OR_WEEK.fullmatch(folder))
    emne = fields.get("emne") or folder_emne or ("" if no_folder_meta else folder)

    # uge/ugedag/dato: fra lektionsplan-noten, ellers udledt af start, ellers udeladt (#154).
    time_fields = {k: fields[k] for k in ("uge", "ugedag", "dato") if k in fields}
    if not time_fields and fields.get("start"):
        time_fields = time_fields_from_start(fields["start"])

    lines = [f"fag: {plain_fag(raw_root.parent.name)}\n"]
    lines += [f"{k}: {time_fields[k]}\n" for k in ("uge", "ugedag", "dato") if k in time_fields]
    lines.append(f"type: {note_type}\n")
    lines.append(f'kilde: "[[{doc_path.relative_to(VAULT_ROOT).as_posix()}]]"\n')
    lines.append(f'hentet: "{format_now()}"\n')
    if emne:
        lines.append(f'emne: "{emne}"\n')
    lines += [f'{key}: "{fields[key]}"\n' for key in ("start", "stop") if key in fields]

    return "---\n" + "".join(lines) + extra + "---\n\n"


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


HIGHLIGHT_PATTERN = re.compile(r"==[^=\n]+==")


# Bruges af write_conversion() (skriver aldrig oven i en highlightet note) og af
# reconvert_double_page.py (springer highlightede noter over FØR de slettes — allerede_converted()
# alene stopper ikke den sti, da sletning gør filen "ny" igen ved næste watcher-kørsel, se #42).
def has_highlights(md_path: Path) -> bool:
    return md_path.exists() and bool(HIGHLIGHT_PATTERN.search(md_path.read_text(encoding="utf-8")))


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


# MinerU finder fodnote-teksten fint (page_footnote-blokke, issue #142) — den blev bare aldrig
# hentet ud herfra og skrevet til noten. Fodnote-nummerering nulstiller typisk pr. side i en bog
# (Rosa1.pdf har fx flere "1"-fodnoter på forskellige sider), så de skal placeres side for side
# ved insert_page_markers' eksisterende sidemarkør, ikke samlet i én flad liste i bunden af noten.
def _page_footnotes(page_blocks: list[dict]) -> list[str]:
    return [
        text
        for block in page_blocks
        if block.get("type") == "page_footnote" and (text := (block.get("text") or "").strip())
    ]


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
    pending_footnotes: list[str] = []

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
                marker = _format_page_marker(pending_label, pending_footnotes)
                result = result[:line_start] + marker + result[line_start:]
                idx += len(marker)
            pending_label = _printed_page_number(group) or str(page_idx + 1)
            pending_footnotes = _page_footnotes(group)
            search_pos = idx + len(anchor)

    if pending_label is not None:
        result = result.rstrip("\n") + _format_page_marker(pending_label, pending_footnotes, trailing_rule=False)

    return result


def _format_page_marker(label: str, footnotes: list[str], trailing_rule: bool = True) -> str:
    trailer = "\n\n---\n\n" if trailing_rule else "\n"
    if footnotes:
        notes = "\n\n".join(footnotes)
        return f"\n\n---\n{notes}\n\n*— side {label} —*{trailer}"
    return f"\n\n*— side {label} —*{trailer}"


# Adskilt fra integrate_output() så highlight-beskyttelsen kan testes uden netværk (selfcheck).
def write_conversion(doc_path: Path, full_md: Path, images_dir: Path) -> None:
    dest_md, dest_images = md_targets(doc_path)
    dest_md.parent.mkdir(parents=True, exist_ok=True)

    md_text = full_md.read_text(encoding="utf-8")
    running_header = None
    content_list_matches = list(full_md.parent.glob("*_content_list.json"))
    if content_list_matches:
        layout_path = full_md.parent / "layout.json"
        md_text = insert_page_markers(
            md_text, content_list_matches[0], layout_path if layout_path.exists() else None
        )
        try:
            blocks = json.loads(content_list_matches[0].read_text(encoding="utf-8"))
            running_header = _extract_running_header(blocks)
        except (json.JSONDecodeError, OSError):
            pass

    # Skriv ved siden af i stedet for at overskrive, hvis Valdemar allerede har highlightet i den
    # eksisterende note — se has_highlights() ovenfor (issue #42). Billed-wikilinks (![[hash]])
    # refererer ikke til mappenavnet, så .ny-mappen er sikker at bruge.
    protect_existing = has_highlights(dest_md)
    if protect_existing:
        dest_md = dest_md.with_name(f"{dest_md.stem}.ny.md")
        dest_images = dest_images.with_name(f"{dest_images.name}.ny")

    extra_fm = f'sektion: "{running_header}"\n' if running_header else ""
    text = frontmatter(doc_path, extra=extra_fm) + to_wikilinks(md_text)
    dest_md.write_text(text, encoding="utf-8")

    if images_dir.exists():
        if dest_images.exists():
            shutil.rmtree(dest_images)
        dest_images.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(images_dir), str(dest_images))

    if protect_existing:
        print(
            f"Highlights fundet i {md_targets(doc_path)[0].name} — ny konvertering skrevet til "
            f"{dest_md.name} i stedet (issue #42)",
            flush=True,
        )


def integrate_output(doc_path: Path, zip_bytes: bytes) -> None:
    # Vigtigt: udpakkes UDENFOR den overvågede vault-mappe. Ellers ser watchdog ZIP'ens egen
    # "<uuid>_origin.pdf"-kopi som en ny fil og prøver at behandle den igen (selv-triggeret loop).
    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        zip_path = tmp_dir / "result.zip"
        zip_path.write_bytes(zip_bytes)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp_dir)

        write_conversion(doc_path, tmp_dir / "full.md", tmp_dir / "images")


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


# Tråden kan ikke dræbes udefra hvis den hænger i et blokerende kald uden egen timeout, men
# join() med timeout sikrer at hovedtråden altid kommer videre til næste fil i køen — den
# hængende baggrundstråd dør for sig selv når dens eget kald til sidst timer ud (#143).
def process_document_with_watchdog(doc_path: Path) -> None:
    thread = threading.Thread(target=process_document, args=(doc_path,), daemon=True)
    thread.start()
    thread.join(PROCESS_TIMEOUT_S)
    if thread.is_alive():
        print(
            f"Timeout ({PROCESS_TIMEOUT_S}s) ved behandling af {doc_path.name} — markeret som "
            "fejlet, fortsætter til næste fil (issue #143)",
            file=sys.stderr,
            flush=True,
        )
        error_marker_path(doc_path).write_text(
            f"Timeout efter {PROCESS_TIMEOUT_S}s (issue #143)", encoding="utf-8"
        )


def scan_existing() -> None:
    """Fanger filer der allerede lå der før scriptet startede (watchdog ser kun nye events)."""
    for doc_path in sorted(VAULT_ROOT.glob(f"**/{RAW_DIR_NAME}/**/*")):
        if doc_path.is_file() and doc_path.suffix.lower() in SUPPORTED_SUFFIXES:
            process_document_with_watchdog(doc_path)


# Merge-logikken for Syncthing-konfliktfiler (Titel.sync-conflict-<dato>-<enhed>.md) hører hjemme
# i ViaVault selv, ikke her — den arbejder på vaultens egen git-historik og har intet med
# itslearning/MinerU at gøre (se ViaVault/.scripts/resolve_sync_conflict.py). Men denne watcher er
# den eneste proces der allerede overvåger HELE vaulten rekursivt, så den er den naturlige trigger:
# launchd's WatchPaths blev overvejet og droppet igen, fordi den ikke pålideligt fanger ændringer
# dybt nede i et træ med hundredvis af ugemapper, kun de eksplicit angivne stier selv.
SYNC_CONFLICT_SCRIPT = Path.home() / "ViaVault" / ".scripts" / "resolve_sync_conflict.py"


def resolve_sync_conflict(conflict_path: Path) -> None:
    if not SYNC_CONFLICT_SCRIPT.exists():
        return
    result = subprocess.run(
        [sys.executable, str(SYNC_CONFLICT_SCRIPT), str(conflict_path)],
        capture_output=True, text=True,
    )
    for line in result.stdout.splitlines():
        print(line, flush=True)
    if result.stderr:
        print(f"resolve_sync_conflict.py fejlede: {result.stderr.strip()}", file=sys.stderr, flush=True)


class DocumentHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if "sync-conflict-" in path.name:
            time.sleep(2)  # lad Syncthing blive helt færdig med at skrive konflikt-filen
            resolve_sync_conflict(path)
            return
        if path.suffix.lower() not in SUPPORTED_SUFFIXES:
            return
        if not in_raw_branch(path):
            return
        time.sleep(2)  # lad downloadet blive helt færdigskrevet før vi rører den
        process_document_with_watchdog(path)


def sync_hold_course_quietly() -> None:
    """Holder Hold Course-pluginets data.json i sync med lektionsplan-noterne (issue #113).

    Ligger her frem for som et selvstændigt trin, fordi #113 kræver at synken sker uden noget nyt
    manuelt trin. Kaldet er billigt (læser ~36 små noter) og skriver kun når noget reelt ændrede
    sig, så minut-intervallet i main() koster ingenting. Fejl må aldrig vælte watcheren — MinerU-
    konverteringen er den vigtige opgave her, Hold Course-synken er en bekvemmelighed."""
    try:
        sync_hold_course.sync(VAULT_ROOT, sync_hold_course.DATA_JSON, apply=True, quiet=True)
    except Exception as exc:  # noqa: BLE001 — se docstring: synken må aldrig stoppe watcheren
        print(f"Hold Course-synk fejlede (fortsætter): {exc}", file=sys.stderr, flush=True)


def main():
    VAULT_ROOT.mkdir(parents=True, exist_ok=True)
    scan_existing()
    sync_hold_course_quietly()

    observer = Observer()
    observer.schedule(DocumentHandler(), str(VAULT_ROOT), recursive=True)
    observer.start()
    print(f"Overvåger {VAULT_ROOT} ...", flush=True)
    try:
        while True:
            time.sleep(60)
            sync_hold_course_quietly()
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

        # Uden lektionsplan-note: emne genbruges fra mappenavnet; uge/ugedag/dato har ingen
        # kilde (mappenavnet er ikke længere en, #150/#154), så de udelades.
        global VAULT_ROOT
        old_root, VAULT_ROOT = VAULT_ROOT, root
        try:
            fm = frontmatter(raw_pdf)
            assert 'emne: "Når børn synger."' in fm, fm
            assert "uge:" not in fm and "start:" not in fm, fm

            # Med lektionsplan-note ved siden af: emne + start/stop derfra, og uge/ugedag/dato
            # udledes af start når planen kun har start (ikke de tre felter eksplicit).
            md_dir = root / "Musik" / MD_DIR_NAME / "W34tors - Når børn synger."
            md_dir.mkdir(parents=True)
            (md_dir / "[PLAN] W34tors - Når børn synger..md").write_text(
                '---\nemne: "Når børn synger. (fra plan)"\nstart: "2026-08-20 08:15:00"\nstop: "2026-08-20 12:00:00"\n---\n',
                encoding="utf-8",
            )
            fm = frontmatter(raw_pdf)
            assert 'emne: "Når børn synger. (fra plan)"' in fm, fm
            assert 'start: "2026-08-20 08:15:00"' in fm, fm
            assert "uge: 2026-W34\n" in fm and "ugedag: torsdag\n" in fm and "dato: 2026-08-20\n" in fm, fm
        finally:
            VAULT_ROOT = old_root

        # Symbol-mappenavn (issue #111): fag: skal blive ved det rene navn, ikke mappens
        # visningssymbol, ellers splitter Bases materiale-noter fra lektionsplan-noter i to grupper.
        symbol_pdf = root / "♱ Religion" / RAW_DIR_NAME / "W34tors - Dåb." / "Titel.pdf"
        symbol_pdf.parent.mkdir(parents=True)
        symbol_pdf.write_bytes(b"")
        old_root, VAULT_ROOT = VAULT_ROOT, root
        try:
            fm = frontmatter(symbol_pdf)
            assert "fag: Religion\n" in fm, fm
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

        # Fodnoter (issue #142): MinerU finder dem fint (page_footnote-blokke), men de blev
        # aldrig skrevet til noten. Skal stå indrammet af --- LIGE over sidens egen markør — og
        # to forskellige sider må ikke blande deres fodnoter sammen, selvom begge nummererer
        # deres første fodnote "1" (almindeligt i en bog der nulstiller pr. side).
        blocks_fn = [
            {"type": "text", "page_idx": 0, "text": "Side et."},
            {"type": "page_footnote", "page_idx": 0, "text": "1 Side ets egen fodnote."},
            {"type": "page_number", "page_idx": 0, "text": "10"},
            {"type": "text", "page_idx": 1, "text": "Side to."},
            {"type": "page_footnote", "page_idx": 1, "text": "1 Side tos egen fodnote — IKKE samme som side ets."},
            {"type": "page_number", "page_idx": 1, "text": "11"},
            {"type": "text", "page_idx": 2, "text": "Side tre, ingen fodnoter."},
        ]
        content_list_fn = root / "content_list_fn.json"
        content_list_fn.write_text(json.dumps(blocks_fn), encoding="utf-8")
        md_fn = "Side et.\n\nSide to.\n\nSide tre, ingen fodnoter."
        marked_fn = insert_page_markers(md_fn, content_list_fn)
        assert "1 Side ets egen fodnote." in marked_fn, marked_fn
        assert "1 Side tos egen fodnote — IKKE samme som side ets." in marked_fn, marked_fn
        assert marked_fn.index("Side et.") < marked_fn.index("1 Side ets egen") < marked_fn.index("*— side 10 —*"), marked_fn
        assert marked_fn.index("*— side 10 —*") < marked_fn.index("Side to.") < marked_fn.index("1 Side tos egen") < marked_fn.index("*— side 11 —*"), marked_fn
        assert marked_fn.index("*— side 11 —*") < marked_fn.index("Side tre"), marked_fn
        # Ingen fodnote-side skal aldrig indsætte et tomt --- --- -par.
        assert "1 Side ets egen fodnote.\n\n*— side 10 —*" in marked_fn, marked_fn

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

        # frontmatter() på enhed-mapper (#150) + adskilte tids-felter (#154).
        import unittest.mock as _m

        assert time_fields_from_start("2026-09-18 08:15:00") == {
            "uge": "2026-W38", "ugedag": "fredag", "dato": "2026-09-18"
        }
        # uge 1 tilhører sit år, ikke det foregående (ISO) — årstals-unik, jf. #135.
        assert time_fields_from_start("2025-12-29 09:00:00")["uge"] == "2026-W01"

        enhed_doc = VAULT_ROOT / "§ FAG/♪ Musik/RAW/Musikforståelse/Frede.pdf"
        with _m.patch(f"{__name__}.enrich_from_plan_note",
                      return_value={"emne": "Musikforståelse", "uge": "2026-W35",
                                    "ugedag": "tirsdag", "dato": "2026-08-25"}):
            fm = frontmatter(enhed_doc)
        assert "uge: 2026-W35\n" in fm and "ugedag: tirsdag\n" in fm and "dato: 2026-08-25\n" in fm, fm
        assert 'emne: "Musikforståelse"\n' in fm, fm
        assert "\nuge: Musikforståelse" not in fm, fm   # enhed-navnet må ALDRIG blive uge

        # Kun start i plan-noten -> uge/ugedag/dato udledes.
        with _m.patch(f"{__name__}.enrich_from_plan_note", return_value={"start": "2026-09-18 08:15:00"}):
            fm2 = frontmatter(enhed_doc)
        assert "uge: 2026-W38\n" in fm2 and "ugedag: fredag\n" in fm2 and "dato: 2026-09-18\n" in fm2, fm2

        # Ingen plan-note, dato-fallback-mappe: ingen tids-felter (mappenavnet er ikke en kilde).
        with _m.patch(f"{__name__}.enrich_from_plan_note", return_value={}):
            fm3 = frontmatter(VAULT_ROOT / "§ FAG/♪ Musik/RAW/2026-04-15/Noget.pdf")
        assert "uge:" not in fm3 and "emne:" not in fm3, fm3

        # #114/#67: fil direkte i RAW/ (manuelt tilføjet korpus, ingen mappe imellem) — hverken
        # uge eller emne, og "RAW" må ALDRIG lække ind som feltværdi.
        with _m.patch(f"{__name__}.enrich_from_plan_note", return_value={}):
            fm4 = frontmatter(VAULT_ROOT / "§ FAG/♱ Religion/SUP-LIT/EMU-kristendom/RAW/Gsk_læseplan.pdf")
        assert "uge:" not in fm4 and "emne:" not in fm4, fm4
        assert '"RAW"' not in fm4 and ": RAW\n" not in fm4, fm4

        # #181/#183: i en delt enhed-mappe vælges plan-noten der EJER filen (AUTO-blokkens
        # "## Materialer"), ikke bare den første. Uden dette fik hver materiale-note tids-felter
        # fra en vilkårlig søskende-lektion.
        import tempfile as _tf
        delt = Path(_tf.mkdtemp()) / "Skolens formål"
        delt.mkdir(parents=True)
        for dato, fil in (("2026-08-17", "Rosa1.md"), ("2026-09-07", "Resonans.md")):
            (delt / f"[PLAN] {dato} - Skolens formål.md").write_text(
                f'---\nemne: "Skolens formål"\ndato: {dato}\nstart: "{dato} 10:00:00"\n---\n\n'
                f"<!-- AUTO:START -->\n# Skolens formål\n\n## Materialer\n"
                f"- [[§ FAG/⚖︎ LivsOplysning/MD/Skolens formål/{fil}|{fil}]]\n<!-- AUTO:END -->\n",
                encoding="utf-8")
        assert enrich_from_plan_note(delt, "Resonans.md")["dato"] == "2026-09-07", \
            "materiale-noten fik tids-felter fra en søskende-lektion i stedet for sin egen ejer"
        assert enrich_from_plan_note(delt, "Rosa1.md")["dato"] == "2026-08-17"
        # Ejerløs fil (MinerU nåede frem før background.js skrev planen, #141) -> første note, som før.
        assert enrich_from_plan_note(delt, "Ukendt.md")["dato"] == "2026-08-17"
        assert enrich_from_plan_note(delt)["dato"] == "2026-08-17"

        # md_targets uændret: MD-mappen spejler RAW-mappen uanset navneform.
        md, att = md_targets(enhed_doc)
        assert md == VAULT_ROOT / "§ FAG/♪ Musik/MD/Musikforståelse/Frede.md", md
        assert att == VAULT_ROOT / "§ FAG/♪ Musik/MD/Musikforståelse/_attachments/Frede", att

        # write_conversion(): highlights i eksisterende MD beskyttes mod overskrivning (#42).
        old_root, VAULT_ROOT = VAULT_ROOT, root
        try:
            with tempfile.TemporaryDirectory() as src_dir_str:
                src_dir = Path(src_dir_str)
                full_md = src_dir / "full.md"
                no_images_dir = src_dir / "images"  # findes ikke — testen fokuserer på MD-beskyttelse
                dest_md, _ = md_targets(raw_pdf)
                ny_md = dest_md.with_name(f"{dest_md.stem}.ny.md")

                # Uden highlights: overskrives direkte som hidtil.
                full_md.write_text("Ny tekst uden markeringer.", encoding="utf-8")
                write_conversion(raw_pdf, full_md, no_images_dir)
                assert "Ny tekst uden markeringer." in dest_md.read_text(encoding="utf-8"), dest_md.read_text()
                assert not ny_md.exists()

                # Med highlights i den eksisterende note: beskyttes, ny konvertering havner i .ny.md.
                dest_md.write_text(dest_md.read_text(encoding="utf-8") + "\n==vigtig markering==\n", encoding="utf-8")
                full_md.write_text("Anden ny tekst.", encoding="utf-8")
                write_conversion(raw_pdf, full_md, no_images_dir)
                assert "==vigtig markering==" in dest_md.read_text(encoding="utf-8"), "highlight blev overskrevet"
                assert ny_md.exists(), "ny konvertering blev ikke skrevet ved siden af"
                assert "Anden ny tekst." in ny_md.read_text(encoding="utf-8")
        finally:
            VAULT_ROOT = old_root

    # process_document_with_watchdog() (#143): en fil der hænger længere end loftet skal
    # markeres som fejlet og give hovedtråden fri igen, i stedet for at blokere for evigt.
    import unittest.mock

    global PROCESS_TIMEOUT_S
    old_timeout, PROCESS_TIMEOUT_S = PROCESS_TIMEOUT_S, 0.1
    with tempfile.TemporaryDirectory() as tmp:
        stuck_doc = Path(tmp) / "haenger.pdf"
        stuck_doc.write_bytes(b"")
        with unittest.mock.patch(
            "__main__.process_document", side_effect=lambda p: time.sleep(10)
        ):
            process_document_with_watchdog(stuck_doc)
        assert error_marker_path(stuck_doc).exists(), "timeout-markør blev ikke skrevet"
    PROCESS_TIMEOUT_S = old_timeout

    # resolve_sync_conflict(): kalder ViaVaults egen merge-script som subprocess. Peger
    # SYNC_CONFLICT_SCRIPT på en lille fixture i stedet for det rigtige script, så testen ikke
    # afhænger af at ~/ViaVault findes/er et git-repo på maskinen der kører selvtjekket.
    global SYNC_CONFLICT_SCRIPT
    old_script = SYNC_CONFLICT_SCRIPT
    with tempfile.TemporaryDirectory() as tmp:
        fake_script = Path(tmp) / "fake_resolve.py"
        fake_script.write_text(
            "import sys\n"
            "print(f'Flettet og løst: {sys.argv[1]}')\n",
            encoding="utf-8",
        )
        SYNC_CONFLICT_SCRIPT = fake_script
        try:
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with redirect_stdout(buf):
                resolve_sync_conflict(Path("note.sync-conflict-20260830-120000-ABC123.md"))
            assert "Flettet og løst" in buf.getvalue(), buf.getvalue()

            # Manglende script (fx ViaVault ikke sat op endnu) må aldrig kaste en exception —
            # daemonens hovedopgave (MinerU-konvertering) skal fortsætte uanset.
            SYNC_CONFLICT_SCRIPT = Path(tmp) / "findes-ikke.py"
            resolve_sync_conflict(Path("note.sync-conflict-20260830-120000-ABC123.md"))
        finally:
            SYNC_CONFLICT_SCRIPT = old_script

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
