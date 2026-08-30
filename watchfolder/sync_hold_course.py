#!/usr/bin/env python3
"""
Synkroniserer vaultens lektionsplan-noter ind i Hold Course-pluginets data.json (issue #113).

Kilden er frontmatteren på `type: lektionsplan`-noterne, ikke extensionens hukommelse: den samme
kode dækker så både engangs-migreringen af de eksisterende noter og den løbende synk. background.js
har ganske vist plan-objekterne i hukommelsen (spørgsmål 1 i #113), men kun for sit aktuelle
tidsvindue, og springer uændrede planer helt over (`prevRecord?.hash === currentHash` -> continue) —
en migrering af de allerede skrevne noter ville derfor kræve en anden vej ind alligevel.

Merge, ikke overskrivning. Hold Course bygger aldrig sine objekter om — pluginet har hverken
JSON.parse/stringify, import/export eller nogen anden gen-serialisering, og hver opdatering går
gennem `Object.assign(obj, updates)` (main.js: updateLecture/updateAssignment/updateResource).
Ukendte nøgler overlever derfor en fuld runde gennem UI'et, og synken kan stemple sin egen identitet
på objekterne:

    lecture.vswPlanId     plan_id fra frontmatteren (issue #96)
    assignment.vswKey     "<lecture.id>|lit|<sti>" / "<lecture.id>|forb|<titel>"
    resource.vswResKey    vault-stien til den matchede litteraturfil
    class.vswFag          fag:-værdien
    semester.vswSync      semestret synken lægger sine klasser i

Synken ejer kun title/date/dueDate/type. Valdemars egne felter — status-pills, karakterer, noter,
linkede noter, TA/kontor-tid — røres aldrig, og intet slettes nogensinde. Samme princip som
spliceAutoSection i background.js: maskinen ejer en afgrænset zone, mennesket ejer resten.

Kendt begrænsning (2026-08-28, delvist afhjulpet): Hold Course implementerer ikke
`onExternalSettingsChange` og cacher sin data.json i hukommelsen ved plugin-opstart (main.js:
`this.data = await this.loadData()`, kun kaldt i onload) — selv luk/genåbn af Hold Course-visningen
render'er bare fra den allerede-indlæste kopi igen. Ingen installeret plugin tilbyder en "genindlæs
KUN denne plugin"-kommando, så eneste udløser udefra er en fuld app-reload. trigger_obsidian_reload()
gør præcis det, via Local REST API-pluginet (allerede installeret) — men KUN når sync() rent faktisk
skrev en ændret data.json, ikke ved hver kørsel (en fuld reload afbryder Valdemar hvis han sidder og
skriver i en note). Er Obsidian ikke åben, eller Local REST API ikke installeret/konfigureret, fejler
det stille — reload er en bekvemmelighed, ikke en forudsætning: mtime-vagten nedenfor sikrer at VI
aldrig overskriver Valdemars arbejde, og synken er idempotent, så en tabt skrivning/reload kommer
igen ved næste kørsel.

Notér uden plan_id (ældre end issue #96) synkes ikke — de rapporteres, se ensure_lecture for hvorfor
et gæt på fag+uge blev afprøvet og forkastet.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører den indbyggede test.
"""

import json
import re
import ssl
import tempfile
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
DATA_JSON = VAULT_ROOT / ".obsidian" / "plugins" / "hold-course" / "data.json"
LOCAL_REST_API_CONFIG = VAULT_ROOT / ".obsidian" / "plugins" / "obsidian-local-rest-api" / "data.json"

# main.js: COLOR_PALETTE har 6 farver, og addClass sætter colorIndex = classes.length % længden.
COLOR_PALETTE_SIZE = 6

# Hold Courses class.courseUrl renderes som et rigtigt "Course page"-link BÅDE på fag-kortet
# (main.js: _renderClassCard) og i fag-headeren (_renderClassView) — ét klik fra Hold Course til
# itslearning. Formen er verificeret live 2026-08-28 (ikke gættet, jf. #118): CourseID'et er
# første halvdel af plan_id ("36016:1297067"), og itslearnings egen venstremenu linker til
# præcis denne URL.
COURSE_URL = "https://via.itslearning.com/Course/Course.aspx?CourseId={}"

# Symbol + farve pr. fag. Symbolerne matcher background.js' FOLDER_SYMBOLS, farverne matcher
# Valdemars Google-kalendere, så Hold Course og kalenderen viser samme fag i samme farve.
# colorIndex peger ind i main.js' COLOR_PALETTE: 0 amber, 1 teal, 2 coral, 3 purple, 4 pink,
# 5 green. Gul findes ikke som sådan — amber er paletten's gule, coral er dens røde.
# Det er VORES konfiguration, ikke Valdemars data, så synken sætter code og colorIndex ved hver
# kørsel. `name` sættes derimod kun ved oprettelsen og er hans at redigere.
FAG_STYLE = {
    "Musik":         {"symbol": "♪",  "colorIndex": 5, "itslearningCode": "LSmu-2527"},    # grøn
    "Religion":      {"symbol": "♱",  "colorIndex": 0, "itslearningCode": "LSkr-2628"},    # amber/gul
    "LivsOplysning": {"symbol": "⚖︎", "colorIndex": 2, "itslearningCode": "LSS24.1livs"},  # coral/rød
}


def nfc(text: str) -> str:
    """Obsidian indekserer sine stier som NFC, men macOS' filsystem leverer NFD — så
    `path.relative_to(...)` giver en streng der ser identisk ud, men som
    `vault.getAbstractFileByPath()` ikke kan slå op. Pluginets "Open note"-knap fejler så TAVST
    (`const file = ...getAbstractFileByPath(path); if (file) ...` — ingen else-gren, main.js:2292).
    Ramte 14 af 34 lektioner: alle stier med å/æ/ø. Normalisér derfor alt der skal ind i data.json.
    """
    return unicodedata.normalize("NFC", text)

# Præfikserne background.js sætter foran værdierne i frontmatteren (yamlBlockLines).
LITTERATUR_PREFIX = "▥"
LITTERATUR_FIL_PREFIX = "📎"
MATERIALE_FIL_PREFIX = "📎"
FORBEREDELSE_PREFIX = "⚒"


# ─── Frontmatter ──────────────────────────────────────────────────────────────

def parse_frontmatter(text: str) -> dict:
    """Den delmængde YAML background.js rent faktisk skriver: skalarer og literal blocks (`|`)."""
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 3)
    if end == -1:
        return {}

    fields, key, block = {}, None, []
    for line in text[4:end].split("\n"):
        if key is not None and (line.startswith("  ") or not line.strip()):
            block.append(line[2:])
            continue
        if key is not None:
            fields[key] = "\n".join(block).strip()
            key, block = None, []
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*): ?(.*)$', line)
        if not match:
            continue
        name, value = match.group(1), match.group(2)
        if value == "|":
            key = name
        else:
            fields[name] = value.strip().strip('"')
    if key is not None:
        fields[key] = "\n".join(block).strip()
    return fields


def prefixed_lines(value: str, prefix: str) -> list[str]:
    """Linjerne i et blok-felt, uden background.js' symbol-præfiks. `false` betyder tomt."""
    if not value or value == "false":
        return []
    out = []
    for line in value.split("\n"):
        line = line.strip()
        if line.startswith(prefix):
            line = line[len(prefix):].strip()
        if line:
            out.append(line)
    return out


def note_stub_path(plan_path: str) -> str:
    """`[NOTE]`-stubben der hører til en `[PLAN]`-note — Valdemars egen note for lektionen.

    background.js skriver den til `§ FAG/<fag>/NOTER/<uge>/[NOTE] <uge>.md` (noteStubPath), altså
    samme sti som lektionsplanen med MD -> NOTER og [PLAN] -> [NOTE]. Verificeret 1:1 mod vaulten:
    36 af 36 lektionsplan-noter har en stub. Falder tilbage til selve planen hvis stubben mangler."""
    stub = plan_path.replace("/MD/", "/NOTER/").replace("[PLAN] ", "[NOTE] ")
    return stub if (VAULT_ROOT / stub).exists() else plan_path


def wikilink_target(line: str) -> str | None:
    """`[[sti|alias]]` -> "sti". Uden pipe-håndtering ville et alias (Valdemars pæne visningstekst,
    fx "Titel.md" eller "Titel (web)") blive en del af selve stien og fejlagtigt matche som en
    død fil — se prune_dead_links().
    """
    match = re.match(r'^\[\[([^|\]]+)(?:\|.*)?\]\]$', line)
    return match.group(1) if match else None


def wikilink_for(rel_path: str) -> str:
    """Samme alias-form som background.js' mdLink(): filnavnet selv, ikke hele stien."""
    return f"[[{rel_path}|{rel_path.rsplit('/', 1)[-1]}]]"


def append_file_list_field(text: str, key: str, prefix: str, new_links: list[str]) -> str:
    """Tilføjer nye 📎-linjer til et frontmatter-blokfelt (materiale_filer/litteratur_filer).
    `key: false` bliver til `key: |` hvis feltet var tomt. Rører teksten slet ikke hvis feltet
    ikke findes (ældre note-version uden feltet)."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line == f"{key}: false":
            block = [f"{key}: |"] + [f"  {prefix} {link}" for link in new_links]
            return "\n".join(lines[:i] + block + lines[i + 1:])
        if line.strip() == f"{key}: |":
            j = i + 1
            while j < len(lines) and lines[j].startswith("  "):
                j += 1
            block = [f"  {prefix} {link}" for link in new_links]
            return "\n".join(lines[:j] + block + lines[j:])
    return text


def patch_pending_materiale(vault_root: Path, apply: bool) -> list[str]:
    """Selvhelbredende pas (issue #141): background.js skriver `materiale_filer: false` når en
    fil ikke er MinerU-konverteret endnu på skrivetidspunktet — og den genskriver kun planer der
    stadig ligger inden for sit korte itslearning-tidsvindue (daysBack: 1). Falder lektionen ud
    af det vindue før konverteringen er færdig, retter background.js sig aldrig selv, og
    materiale_filer: false står tilbage for evigt (bekræftet live: en hel BACKFILL_DAYS_BACK-kørsel
    når slet ikke at blive genbesøgt af næste, kortvinduede kørsel).

    Kører derfor helt uafhængigt af itslearning: for hver [PLAN]-note sammenlignes de allerede
    linkede filer (materiale_filer + litteratur_filer) mod hvad der faktisk ligger i notens egen
    MD-mappe — enhver fil dér uden et link bliver tilføjet til materiale_filer. Ingen forsøg på at
    skelne materiale fra litteratur her (den klassifikation kræver itslearning-dataen, som denne
    funktion bevidst ikke rører); begge felter giver alligevel samme Reading-opgave i Hold Course
    (se sync_data), så klassifikationen er kosmetisk, ikke funktionel, for netop dette formål.
    Idempotent og billig (samme mapper read_plans() alligevel scanner), sikkert at køre hvert minut."""
    patched = []
    for plan_path in sorted(vault_root.rglob("[[]PLAN[]] *.md")):
        text = plan_path.read_text(encoding="utf-8")
        fields = parse_frontmatter(text)
        if fields.get("type") != "lektionsplan":
            continue

        linked = {wikilink_target(l) for l in prefixed_lines(fields.get("materiale_filer", ""), MATERIALE_FIL_PREFIX)}
        linked |= {wikilink_target(l) for l in prefixed_lines(fields.get("litteratur_filer", ""), LITTERATUR_FIL_PREFIX)}

        orphans = [
            nfc(str(md.relative_to(vault_root)))
            for md in sorted(plan_path.parent.glob("*.md"))
            if md.name != plan_path.name
        ]
        orphans = [o for o in orphans if o not in linked]
        if not orphans:
            continue

        updated = append_file_list_field(text, "materiale_filer", MATERIALE_FIL_PREFIX,
                                          [wikilink_for(o) for o in orphans])
        if updated == text:
            continue
        patched.append(str(plan_path.relative_to(vault_root)))
        if apply:
            plan_path.write_text(updated, encoding="utf-8")
    return patched


def read_tasks(vault_root: Path) -> list[dict]:
    """`type: opgave`-noterne extensionen skriver til NOTER/OPGAVER/ (writeTaskNotes i
    background.js): afleveringsopgaver med en rigtig deadline, som ikke hænger på en bestemt
    lektion. De bliver til Hold Courses klasse-niveau-opgaver.

    Nøglen er ElementID fra `kilde:`-URL'en — samme stabile id som background.js' taskId() bruger.
    Noter uden den (fx Valdemars egne, håndskrevne opgave-noter og skabelonen i META) springes over:
    uden et stabilt id kan synken ikke undgå dubletter."""
    tasks = []
    for path in sorted(vault_root.rglob("*.md")):
        if "OPGAVER" not in str(path):
            continue
        fields = parse_frontmatter(path.read_text(encoding="utf-8"))
        if fields.get("type") != "opgave" or not fields.get("fag") or not fields.get("deadline"):
            continue
        match = re.search(r"ElementID=(\d+)", fields.get("kilde", ""))
        if not match:
            continue
        fields["_element_id"] = match.group(1)
        fields["_path"] = nfc(str(path.relative_to(vault_root)))
        fields["_title"] = path.stem
        tasks.append(fields)
    return tasks


def read_plans(vault_root: Path) -> tuple[list[dict], list[str]]:
    """Alle `type: lektionsplan`-noter. `type: dublet` falder væk af sig selv (issue #113).

    Returnerer også stierne på de noter der mangler plan_id — de er ældre end issue #96 og kan ikke
    synkes sikkert (se ensure_lecture). De skal rettes i vaulten, ikke gættes om her, så de
    rapporteres frem for at forsvinde stille."""
    plans, uden_plan_id = [], []
    for path in sorted(vault_root.rglob("[[]PLAN[]] *.md")):
        fields = parse_frontmatter(path.read_text(encoding="utf-8"))
        if fields.get("type") != "lektionsplan" or not fields.get("fag"):
            continue
        rel = str(path.relative_to(vault_root))
        if not fields.get("plan_id"):
            uden_plan_id.append(rel)
            continue
        fields["_path"] = nfc(rel)
        plans.append(fields)
    return plans, uden_plan_id


# ─── data.json-hjælpere ───────────────────────────────────────────────────────

def generate_id(counter: list[int]) -> str:
    """Samme form som main.js' generateId (base36-tid + tilfældig hale) — kun formen betyder noget,
    id'erne skal blot være unikke inden for filen."""
    counter[0] += 1
    return f"{int(time.time() * 1000):x}v{counter[0]:03x}"


def find_stamped(items, key, value):
    return next((it for it in items if it.get(key) == value), None)


def semester_name(plans: list[dict]) -> tuple[str, str, int]:
    dates = sorted(p["start"][:10] for p in plans if p.get("start"))
    year, month = (int(dates[0][:4]), int(dates[0][5:7])) if dates else (time.localtime().tm_year, time.localtime().tm_mon)
    if month >= 7:
        return f"Efterår {year}", "Fall", year
    return f"Forår {year}", "Spring", year


def term_year_for_date(date: str) -> tuple[str, int]:
    """Samme juli-grænse som semester_name, men for én enkelt dato — bruges til at afgøre om en
    lektion/opgave hører til DET semester Hold Course-objektet allerede repræsenterer."""
    year, month = int(date[:4]), int(date[5:7])
    return ("Fall", year) if month >= 7 else ("Spring", year)


def ensure_semester(data: dict, plans: list[dict], new_id) -> dict:
    sem = find_stamped(data.setdefault("semesters", []), "vswSync", True)
    if sem:
        return sem
    # Har Valdemar allerede oprettet et semester, adopteres det frem for at lave et dubletsemester
    # ved siden af — han skal ikke sidde med to der ligner hinanden i semester-skifteren.
    sem = next((s for s in data["semesters"] if s["id"] == data.get("currentSemesterId")), None) \
        or (data["semesters"][0] if data["semesters"] else None)
    if sem is None:
        name, term, year = semester_name(plans)
        sem = {"id": new_id(), "name": name, "term": term, "year": year, "classes": [], "resources": []}
        data["semesters"].append(sem)
    sem["vswSync"] = True
    sem.setdefault("classes", [])
    sem.setdefault("resources", [])
    if not data.get("currentSemesterId"):
        data["currentSemesterId"] = sem["id"]
    return sem


def course_url(course_id: str) -> str:
    """itslearning-kursets forside ud fra plan_id'ets/kilde-URL'ens CourseID. Tom streng når vi
    ikke har et id — synken gætter aldrig på et link der kan føre et forkert sted hen."""
    return COURSE_URL.format(course_id) if course_id else ""


def ensure_class(sem: dict, fag: str, new_id, course_id: str = "") -> dict:
    # `code` er IKKE fagets navn med et symbol foran — det ville stå lige over/ved siden af
    # `name` (samme tekst to gange, kun det ene med ikon: bekræftet live 2026-08-27, "to titler").
    # itslearnings eget kursusnavn blev ved samme lejlighed overvejet og fravalgt alene ("en ren
    # VIA-administrativ kode siger intet på et blik") — men er siden (2026-08-28, se nedenfor)
    # tilføjet SAMMEN MED symbolet, da symbolerne alene viste sig svære at skelne i praksis.
    style = FAG_STYLE.get(fag, {})
    symbol = style.get("symbol", fag)
    code = f"{symbol} {style['itslearningCode']}" if style.get("itslearningCode") else symbol
    url = course_url(course_id)
    cls = find_stamped(sem["classes"], "vswFag", fag)
    if cls:
        # Samme ejerskabs-mønster som vaultLink/notes: vswCourseUrl husker hvad synken sidst skrev,
        # så et felt Valdemar selv har rettet i EditClassModal ("Course page URL") bliver stående.
        if url and cls.get("courseUrl", "") in ("", cls.get("vswCourseUrl", "")):
            cls["courseUrl"] = url
            cls["vswCourseUrl"] = url
        # code er synkens konfiguration (FAG_STYLE) og sættes derfor ved hver kørsel. colorIndex
        # sættes KUN ved oprettelsen (se nedenfor) — Hold Course har ingen farvevælger i UI'et,
        # kun en positionel auto-tildeling, og en anden farve pr. kørsel oveni Valdemars egen
        # (fx via kalenderens farver) gav "flere farver i spil", ikke færre (samme dato).
        cls["code"] = code
        return cls
    # Kun felterne vi rent faktisk har data til. Underviser, lokale, mødedage og tidspunkter står
    # tomme og røres aldrig igen — udfylder Valdemar dem én gang i Hold Course, bliver de stående
    # (spørgsmål 4 i #113: synken gætter aldrig på data den ikke har).
    #
    # De to felt-grupper er ikke bare "ikke nået endnu", de er afprøvet mod virkeligheden og skal
    # BLIVE tomme (live-tjek i itslearning 2026-08-28, se #118):
    #   professorName — Musik har fem undervisere i itslearnings deltagerliste (Anne Katrine
    #     Christensen, Anne-Mette Nystrøm Søndergaard Jensen, Klaus Franck Glüsing, Lone Sonne,
    #     Mikael Koed Thomsen). Der FINDES ingen underviser pr. fag at skrive her; underviseren er
    #     et lektions-faktum, og Hold Course har intet lektions-felt til det.
    #   meetingDays/meetingStartTime/meetingEndTime — ville gøre skade, ikke gavn. main.js'
    #     getItemsForDate stempler klassens ENE mødetid på den FØRSTE lektion på datoen, og Musik
    #     har torsdage med to reelle lektioner (08:15 og 12:25). Kalenderen ville altså vise et
    #     forkert klokkeslæt på den ene af dem, hvor den nu ikke viser noget.
    cls = {
        "id": new_id(), "colorIndex": style.get("colorIndex", len(sem["classes"]) % COLOR_PALETTE_SIZE),
        "code": code, "name": fag, "courseUrl": url, "vswCourseUrl": url, "meetingLink": "",
        "professorName": "", "professorEmail": "", "officeHours": "",
        "taName": "", "taEmail": "", "taOfficeHours": "",
        "meetingDays": [], "location": "", "startDate": "", "endDate": "",
        "meetingStartTime": "", "meetingEndTime": "",
        "lectures": [], "assignments": [], "exams": [], "resources": [],
        "vswFag": fag,
    }
    sem["classes"].append(cls)
    return cls


def ensure_lecture(cls: dict, plan: dict, new_id) -> dict:
    """Nøglen er plan_id og kun plan_id (issue #96) — stabilt også når itslearning flytter en
    eksisterende lektion i stedet for at oprette en ny.

    Fristelsen er at falde tilbage på fag+uge for de gamle noter der er ældre end plan_id. Det er
    afprøvet og forkastet: `uge` er kun uge+ugedag uden klokkeslæt, og Musik har tre torsdage med
    to reelle lektioner hver (08:15 "Når børn synger" og 12:25 "I. M. U.") — en uge-nøgle flettede
    dem live til én og tabte tre lektioner. Og selv en slot-nøgle med klokkeslæt genskabte den
    plan_id-løse note som dublet ved hver kørsel, fordi noten bliver liggende på disken efter at
    dens tvilling har fået sit plan_id. Notér uden plan_id rapporteres derfor i stedet for at
    blive gættet ind — det er en vault-tilstand der skal rettes ved kilden, ikke her."""
    lec = find_stamped(cls.setdefault("lectures", []), "vswPlanId", plan["plan_id"])
    if lec is None:
        lec = {"id": new_id(), "title": "", "date": "", "status": "not-started",
               "notes": "", "vaultLink": "", "assignments": [], "vswPlanId": plan["plan_id"]}
        cls["lectures"].append(lec)
    # Synkens felter. status er udelukkende Valdemars og røres aldrig.
    lec["title"] = plan.get("emne") or plan.get("uge") or "Lektion"
    lec["date"] = (plan.get("start") or "")[:10]

    # "Key Concepts & Lesson Goal" (lec.notes) er en fritekst-boks han også selv kan skrive i,
    # samme situation som vaultLink lige nedenfor: vswNotes husker hvad synken sidst skrev, så en
    # tom boks udfyldes, en boks han selv har rettet i (afviger fra vswNotes) står urørt.
    beskrivelse = plan.get("beskrivelse", "")
    beskrivelse = "" if beskrivelse == "false" else beskrivelse
    notes_owned = "vswNotes" not in lec or lec.get("notes", "") in ("", lec["vswNotes"])
    if beskrivelse and notes_owned:
        lec["notes"] = beskrivelse
        lec["vswNotes"] = beskrivelse
    # Hold Courses "Lecture note" er Valdemars egen note for lektionen, ikke maskinens lektionsplan
    # — derfor [NOTE]-stubben, som selv linker videre til [PLAN] via sit kilde:-felt. Ét klik til
    # planen, i stedet for at bruge feltet på en note han ikke selv skriver i.
    stub = nfc(note_stub_path(plan["_path"]))
    # vswVaultLink husker hvad synken sidst skrev. Står feltet uændret, må synken flytte det (fx da
    # det her skiftede fra [PLAN] til [NOTE]); har Valdemar brugt pluginets Browse/Remove-knap til
    # at pege et andet sted hen, er værdien hans og bliver stående.
    # Mangler stemplet helt, stammer værdien fra en tidligere synk-version (der pegede på [PLAN])
    # og ikke fra Valdemar — han har ikke haft feltet i hånden endnu. Så den må flyttes én gang.
    sync_owned = "vswVaultLink" not in lec or lec["vaultLink"] in ("", lec["vswVaultLink"])
    if sync_owned:
        lec["vaultLink"] = stub
        lec["vswVaultLink"] = stub
    # Normalisér uanset. NFC/NFD er to kodninger af SAMME sti, ikke to forskellige valg, så det
    # overskriver ikke hans valg — det gør bare at pluginet kan slå stien op (se nfc()).
    lec["vaultLink"] = nfc(lec["vaultLink"])
    return lec


def stable_key(vault_path: str) -> str:
    """Ugemappen ("§ FAG/<fag>/<gren>/<ugemappe>/<fil>", parts[3]) er det eneste flygtige led i en
    materialesti — den ændrer sig ved enhver ugedrift (#96) eller en navngivningsændring som #135.
    At nøgle vswResKey/vswKey på HELE stien fik enhver sådan ændring til at fremstå som et helt
    NYT bibliotekselement i Hold Course, i stedet for det samme materiale der bare er flyttet —
    og fordi Hold Course-synken bevidst aldrig sletter noget selv (se modulets docstring), blev
    den gamle nøgle stående som en spøgelses-dublet for evigt (#138, live 2026-08-30 lige efter
    #135-migreringen: hver titel i Library dukkede op to gange). Fjerner kun selve ugemappe-leddet
    — fag+gren+filnavn er stabilt og adskiller stadig forskellige fag/grene fra hinanden.
    """
    parts = vault_path.split("/")
    if len(parts) >= 5:
        return "/".join(parts[:3] + parts[4:])
    return vault_path


def ensure_resource(sem: dict, cls: dict, vault_path: str, new_id) -> dict:
    key = stable_key(vault_path)
    res = find_stamped(sem.setdefault("resources", []), "vswResKey", key)
    if res is None:
        res = {"id": new_id(), "title": Path(vault_path).stem, "author": "", "type": "",
               "classIds": [], "status": "unread", "vaultLink": vault_path, "url": "",
               "notes": "", "vswResKey": key}
        sem["resources"].append(res)
    # I modsætning til assignment.linkedNote (Valdemars valg, overskrives aldrig) er vaultLink her
    # ren maskin-bogføring af hvor materialet FAKTISK ligger nu — skal altid følge med når
    # ugemappen flytter, ellers ville "Open note" pege på et dødt sted selvom #138-fixet korrekt
    # undgik at oprette en dublet.
    res["vaultLink"] = nfc(vault_path)
    if cls["id"] not in res.setdefault("classIds", []):
        res["classIds"].append(cls["id"])
    return res


def ensure_assignment(owner: dict, key: str, title: str, atype: str, due: str, linked_book: str,
                      new_id, linked_note: str = "") -> dict:
    """`owner` er enten en lecture eller en class — Hold Course har begge slags opgaver
    (`cls.assignments[]` er dem uden lektion, main.js: addAssignment med lectureId = null)."""
    assign = find_stamped(owner.setdefault("assignments", []), "vswKey", key)
    if assign is None:
        assign = {"id": new_id(), "title": "", "type": atype, "dueDate": "", "status": "not-started",
                  "notes": "", "grade": "", "linkedBook": "", "linkedNote": "", "vswKey": key}
        owner["assignments"].append(assign)
    # status/grade/notes/linkedNote er Valdemars fremdrift og overskrives aldrig.
    assign["title"] = title
    assign["type"] = atype
    assign["dueDate"] = due
    if linked_book:
        assign["linkedBook"] = linked_book
    # Kun når feltet er tomt — har Valdemar peget opgaven mod sin egen note, er det hans valg.
    if linked_note and not assign.get("linkedNote"):
        assign["linkedNote"] = linked_note
    assign["linkedNote"] = nfc(assign.get("linkedNote", ""))
    return assign


def prune_dead_links(data: dict, vault_root: Path) -> tuple[int, int]:
    """Fjerner spøgelses-dubletter fra en tidligere stiændring (#138): en resource/assignment hvis
    `vaultLink`/`linkedNote` peger på en fil der ikke længere findes. `stable_key()` (se ovenfor)
    forhindrer NYE dubletter, men rydder ikke de gamle op — de blev oprettet dengang synken nøglede
    på hele stien, og synken sletter bevidst aldrig noget selv. Kun stien afgør: et tomt
    `linkedNote` er en aldrig-linket opgave, ikke en stale én, og røres ikke.

    Fanger også EKSAKTE vaultLink-dubletter (to resources med identisk sti) — opstår hvis to
    sync-processer skriver samtidig (fundet 2026-08-30: en manuel `--apply` kørt oveni den
    kørende watch-daemon). Ingen filsti-check nødvendig her, kun vaultLink-lighed; den ældste af
    de to bevares og resten af opgavernes linkedBook peges om til den.
    """
    removed_res = removed_assign = 0
    for sem in data.get("semesters", []):
        alive_res_ids = set()
        seen_by_link = {}
        id_remap = {}
        kept = []
        for res in sem.get("resources", []):
            link = res.get("vaultLink")
            if link and not (vault_root / link).exists():
                removed_res += 1
                continue
            if link and link in seen_by_link:
                id_remap[res["id"]] = seen_by_link[link]["id"]
                for cid in res.get("classIds", []):
                    if cid not in seen_by_link[link].setdefault("classIds", []):
                        seen_by_link[link]["classIds"].append(cid)
                removed_res += 1
                continue
            if link:
                seen_by_link[link] = res
            alive_res_ids.add(res["id"])
            kept.append(res)
        sem["resources"] = kept

        for cls in sem.get("classes", []):
            owners = cls.get("lectures", []) + [cls]
            for owner in owners:
                kept = []
                for a in owner.get("assignments", []):
                    if a.get("linkedNote") and not (vault_root / a["linkedNote"]).exists():
                        removed_assign += 1
                        continue
                    if a.get("linkedBook") in id_remap:
                        a["linkedBook"] = id_remap[a["linkedBook"]]
                    if a.get("linkedBook") and a["linkedBook"] not in alive_res_ids:
                        a["linkedBook"] = ""
                    kept.append(a)
                owner["assignments"] = kept
    return removed_res, removed_assign


# ─── Synk ─────────────────────────────────────────────────────────────────────

def sync_data(data: dict, plans: list[dict], new_id=None, tasks: list[dict] | None = None) -> dict:
    """Fletter plans ind i en data.json-struktur. Ren funktion — al I/O ligger i sync()."""
    counter = [0]
    new_id = new_id or (lambda: generate_id(counter))
    data.setdefault("semesters", [])
    data.setdefault("dataVersion", 2)
    tasks = tasks or []
    if not plans and not tasks:
        return data

    sem = ensure_semester(data, plans, new_id)

    # Kun DETTE semesters lektioner/opgaver synkes ind i det (issue #125, fundet live 2026-08-28
    # efter #121s backfill). Et itslearning-rum kan strække sig over mere end ét semester —
    # Musik (courseId 36016) havde lektioner tilbage til 2025-08-13, samme fag: og samme rum som
    # indeværende semesters undervisning. Uden dette filter fletter en bredere backfill (eller et
    # rum der reelt løber flere semestre) ældre lektioner ind i samme Hold Course-fag, og hver af
    # dem bliver en frisk, aldrig-før-set opgave med status not-started — som øjeblikkeligt tæller
    # som Overdue på tværs af dashboard, Assignments-liste og kalender (samme
    # getAllAssignments-mekanisme som gjorde tovejs-fuldførelsen nødvendig, bare i stor skala: 125
    # af 137 Musik-opgaver blev Overdue af én kørsel).
    #
    # Filtreres kun når semestret allerede har term/year (altid sandt for et semester denne synk
    # selv har oprettet, se ensure_semester/semester_name) — mangler de, er det tryggere at lade
    # alt igennem end at gætte på en semestergrænse.
    if sem.get("term") and sem.get("year"):
        target = (sem["term"], sem["year"])
        plans = [p for p in plans if p.get("start") and term_year_for_date(p["start"][:10]) == target]
        tasks = [t for t in tasks if t.get("deadline") and term_year_for_date(t["deadline"][:10]) == target]

    for plan in sorted(plans, key=lambda p: (p["fag"], p.get("start", ""))):
        # plan_id er "<courseId>:<planId>" (background.js: planKey) — første halvdel er det
        # CourseID class.courseUrl skal pege på.
        cls = ensure_class(sem, plan["fag"], new_id, plan["plan_id"].split(":")[0])
        lec = ensure_lecture(cls, plan, new_id)
        due = lec["date"]
        # Opgavernes nøgle hænger på lektionens EGET id, ikke på plan_id eller dato: id'et er det
        # eneste der ligger fast når itslearning udskyder en lektion (plan_id består, datoen
        # skifter — issue #96). En dato-afledt nøgle ville fordoble alle opgaver ved hver
        # udskydelse.
        akey = lec["id"]
        stub = lec.get("vswVaultLink") or lec["vaultLink"]

        lit_files = prefixed_lines(plan.get("litteratur_filer", ""), LITTERATUR_FIL_PREFIX)
        targets = [nfc(t) for t in (wikilink_target(line) for line in lit_files) if t]
        if targets:
            for target in targets:
                res = ensure_resource(sem, cls, target, new_id)
                # linkedNote peger på selve materiale-noten, så "Open note" virker direkte fra
                # opgaven uden omvejen om Library.
                ensure_assignment(lec, f'{akey}|lit|{stable_key(target)}', res["title"], "Reading", due,
                                  res["id"], new_id, linked_note=target)
        else:
            # Ren litteratur-tekst uden filmatch: stadig en Reading-opgave, bare uden Library-link —
            # der er ikke noget at linke til (issue #44's konservative matching lader den slags stå).
            lit_text = prefixed_lines(plan.get("litteratur", ""), LITTERATUR_PREFIX)
            if lit_text:
                ensure_assignment(lec, f'{akey}|lit|', " ".join(lit_text)[:200], "Reading", due,
                                  "", new_id, linked_note=stub)

        for titel in prefixed_lines(plan.get("forberedelse", ""), FORBEREDELSE_PREFIX):
            # Forberedelses-afkrydsningerne står i [NOTE]-stubben (issue #59), så det er dér
            # opgaven skal føre hen.
            ensure_assignment(lec, f'{akey}|forb|{titel}', titel, "Other", due, "", new_id,
                              linked_note=stub)

        # Alt vedhæftet fil-materiale UDEN et litteratur-felt-match (background.js udelukker selv
        # de allerede fangede litteratur_filer-mål, så ingen dublet-Reading for samme fil). Dækker
        # fag hvor underviseren aldrig udfylder "Tilhørende litteratur" — LivsOplysning har 0
        # udfyldte litteratur-felter, men vedhæfter læsestoffet som almindelige fil-elementer.
        for line in prefixed_lines(plan.get("materiale_filer", ""), MATERIALE_FIL_PREFIX):
            target = nfc(wikilink_target(line) or "")
            if not target:
                continue
            res = ensure_resource(sem, cls, target, new_id)
            ensure_assignment(lec, f'{akey}|mat|{stable_key(target)}', res["title"], "Reading", due,
                              res["id"], new_id, linked_note=target)

    # Afleveringsopgaver hænger på faget, ikke på en lektion — derfor klasse-niveau. De vises i
    # Hold Courses Assignments-liste og kalender uden at blive klistret på en tilfældig lektion.
    for task in sorted(tasks, key=lambda t: (t["fag"], t.get("deadline", ""))):
        cls = ensure_class(sem, task["fag"], new_id)
        ensure_assignment(cls, f'opgave|{task["_element_id"]}', task["_title"], "Writing",
                          task["deadline"][:10], "", new_id, linked_note=task["_path"])

    return data


def sync_task_completion(data: dict, vault_root: Path, dry_run: bool) -> tuple[list[str], list[str]]:
    """Holder Forberedelse-afkrydsningen i [NOTE]-stubben og opgavens status i Hold Course ens.
    Returnerer (krydset af i vaulten, markeret done i Hold Course).

    Hold Course -> vault: et Done-tryk krydser `- [ ] ⚒ <titel>` af i stubben, hvorfra
    background.js' EKSISTERENDE checkbox->itslearning-mekanisme (issue #70) tager over. Ingen ny
    itslearning-kode, kun en ny skriver af den samme linje. Extensionen skal selv have
    `enableTaskCompletionSync` slået til, ellers ligger krydset bare der uden effekt.

    Vault -> Hold Course: en allerede afkrydset linje sætter opgaven til `done`. Uden den retning
    er kæden kun envejs, og alt Valdemar fuldfører i itslearning/vaulten bliver stående som
    "not started" i Hold Course — hvor det ophober sig som Overdue for evigt på både dashboardets
    Today-strip, i Assignments-listen og som rød pille i kalenderen (main.js: getAllAssignments
    filtrerer udelukkende på `status !== 'done'`). Retningen rører KUN `not-started`: har Valdemar
    selv sat opgaven til `in-progress` i Hold Course, er det hans vurdering og ikke vores.

    Bindes på OPGAVE-niveau, ikke lektion (afklaret med Valdemar 2026-08-28): en lektion kan i
    princippet have flere forberedelses-opgaver, hver med sit eget itslearning-element/URL, så kun
    en per-opgave-binding rammer den rigtige. Nøglen er assignment.vswKey's "<lecture.id>|forb|
    <titel>"-form (samme titel background.js skrev linjen med, se writeLectureNoteStub).

    Begge retninger går KUN mod fuldført, aldrig tilbage — samme retning som selve
    itslearning-synken, og derfor naturligt idempotent og uden mulighed for at de to sider kan
    vippe frem og tilbage mod hinanden."""
    checked, marked_done = [], []
    for sem in data.get("semesters", []):
        for cls in sem.get("classes", []):
            for lec in cls.get("lectures", []):
                stub_rel = lec.get("vswVaultLink") or lec.get("vaultLink")
                if not stub_rel:
                    continue
                file = vault_root / stub_rel
                if not file.exists():
                    continue
                text, changed = None, False
                for assign in lec.get("assignments", []):
                    key = assign.get("vswKey", "")
                    if "|forb|" not in key:
                        continue
                    titel = key.split("|forb|", 1)[1]
                    if text is None:
                        text = file.read_text(encoding="utf-8")
                    unchecked = f"- [ ] {FORBEREDELSE_PREFIX} {titel}"
                    checked_line = f"- [x] {FORBEREDELSE_PREFIX} {titel}"
                    if assign.get("status") == "done":
                        if unchecked in text:
                            text = text.replace(unchecked, checked_line)
                            changed = True
                            checked.append(f"{titel} ({stub_rel})")
                    elif assign.get("status") == "not-started" and checked_line in text:
                        assign["status"] = "done"
                        marked_done.append(f"{titel} ({stub_rel})")
                if changed and not dry_run:
                    file.write_text(text, encoding="utf-8")
    return checked, marked_done


def trigger_obsidian_reload(vault_root: Path) -> None:
    """Beder Obsidian genindlæse sig selv (`app:reload`) via Local REST API-pluginet, så Hold
    Course viser den friske data.json med det samme i stedet for at vente på at Valdemar selv
    reloader — se modul-docstringens "Kendt begrænsning". Kaldes kun af sync() lige efter den
    faktisk har skrevet en ændret data.json. Fejler stille: Obsidian kører måske ikke lige nu,
    Local REST API er måske ikke installeret, eller porten/nøglen er ukendt — ingen af de
    tilfælde skal vælte selve synk-kørslen, reload er en bekvemmelighed oveni, ikke forudsætning."""
    try:
        config = json.loads(LOCAL_REST_API_CONFIG.read_text(encoding="utf-8"))
        req = urllib.request.Request(
            f"https://127.0.0.1:{config['port']}/commands/app%3Areload/",
            method="POST",
            headers={"Authorization": f"Bearer {config['apiKey']}"},
        )
        urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=5)
    except Exception as err:
        print(f"Kunne ikke bede Obsidian genindlæse (Local REST API): {err}", file=sys.stderr)


def sync(vault_root: Path, data_path: Path, apply: bool, quiet: bool = False) -> int:
    if not data_path.exists():
        print(f"Hold Course' data.json findes ikke ({data_path}) — er pluginet installeret?", file=sys.stderr)
        return 1

    patched = patch_pending_materiale(vault_root, apply)
    if patched and not quiet:
        label = "Rettet" if apply else "Ville rette (dry-run)"
        print(f"{label}: {len(patched)} lektionsplan-note(r) fik nye materiale_filer-links (issue #141):")
        for rel in patched:
            print(f"  {rel}")

    plans, uden_plan_id = read_plans(vault_root)
    tasks = read_tasks(vault_root)
    before = data_path.read_text(encoding="utf-8")
    mtime = data_path.stat().st_mtime
    data = json.loads(before)
    merged = sync_data(data, plans, tasks=tasks)
    # FØR serialiseringen: vault -> Hold Course-retningen sætter status på opgaver i `merged`, og
    # de ændringer skal med i den data.json vi sammenligner og skriver.
    checked, marked_done = sync_task_completion(merged, vault_root, dry_run=not apply)
    removed_res, removed_assign = prune_dead_links(merged, vault_root)
    after = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"

    if uden_plan_id and not quiet:
        print(f"{len(uden_plan_id)} lektionsplan-note(r) uden plan_id springes over "
              f"(ældre end issue #96, kan ikke matches sikkert — ret dem i vaulten):")
        for rel in uden_plan_id:
            print(f"  {rel}")

    # Rapporteres UANSET om data.json selv skal genskrives: Hold Course kan have gemt et Done-tryk
    # siden sidste kørsel uden at vores egen frontmatter-flet ændrer noget, og et Done-tryk skal
    # krydses af i vaulten ved næste tick, ikke først når en lektionsplan-note tilfældigvis ændrer
    # sig.
    if checked and not quiet:
        label = "Krydset af" if apply else "Ville krydse af (dry-run)"
        print(f"{label}: {len(checked)} Forberedelse-opgave(r) markeret Done i Hold Course:")
        for titel in checked:
            print(f"  {titel}")
    if marked_done and not quiet:
        label = "Markeret Done i Hold Course" if apply else "Ville markere Done i Hold Course (dry-run)"
        print(f"{label}: {len(marked_done)} Forberedelse-opgave(r) allerede krydset af i vaulten:")
        for titel in marked_done:
            print(f"  {titel}")
    if (removed_res or removed_assign) and not quiet:
        label = "Ryddet op" if apply else "Ville rydde op (dry-run)"
        print(f"{label}: {removed_res} død(e) Library-post(er), {removed_assign} død(e) opgave(r) "
              f"(pegede på filer der ikke længere findes).")

    if after == before:
        # Watch-scriptet kalder denne funktion hvert minut; uden quiet ville loggen fyldes med
        # "allerede opdateret" og skjule de kørsler der reelt skete noget i.
        if not quiet:
            print(f"{len(plans)} lektionsplan-noter — Hold Course er allerede opdateret.")
        return 0

    sem = find_stamped(data["semesters"], "vswSync", True) or {}
    lectures = sum(len(c.get("lectures", [])) for c in sem.get("classes", []))
    assignments = sum(len(l.get("assignments", [])) for c in sem.get("classes", []) for l in c.get("lectures", [])) \
        + sum(len(c.get("assignments", [])) for c in sem.get("classes", []))
    print(f"{len(plans)} lektionsplan-noter + {len(tasks)} opgave-noter -> {len(sem.get('classes', []))} fag, "
          f"{lectures} lektioner, {assignments} opgaver, {len(sem.get('resources', []))} Library-poster.")

    if not apply:
        print("Dry-run. Kør med --apply for at skrive data.json.")
        return 0

    # Hold Course selv kan have gemt mens vi regnede (pluginet skriver hele sin hukommelses-kopi).
    # Springer vi over her, kommer den samme flettning igen ved næste kørsel — det koster ét
    # interval, hvor en overskrivning ville koste Valdemars status-pills.
    if data_path.stat().st_mtime != mtime:
        print("data.json ændrede sig undervejs (Hold Course gemte) — springer over, prøver igen næste kørsel.")
        return 0

    data_path.write_text(after, encoding="utf-8")
    trigger_obsidian_reload(vault_root)
    print("Skrevet. Bedt Obsidian genindlæse (Local REST API) — fejler stille hvis det ikke lykkedes.")
    return 0


def main() -> int:
    return sync(VAULT_ROOT, DATA_JSON, apply="--apply" in sys.argv)


# ─── Selvtjek ─────────────────────────────────────────────────────────────────

def selfcheck() -> int:
    note = (
        "---\n"
        "fag: Musik\n"
        "uge: W36tirs\n"
        'emne: "Musikforståelse"\n'
        'start: "2026-09-01 12:25:00"\n'
        'stop: "2026-09-01 15:45:00"\n'
        "type: lektionsplan\n"
        'plan_id: "36016:1235133"\n'
        "litteratur: |\n"
        "  ▥ Frede V Nielsen (2010): Ars og Scientia, Almen Musikdidaktik Kap 3.3\n"
        "litteratur_filer: |\n"
        "  📎 [[§ FAG/♪ Musik/MD/W36tirs - Musikforståelse/Frede V Nielsen Ars og Scientia.md]]\n"
        "forberedelse: |\n"
        "  ⚒ Forberedelse\n"
        "---\n\n"
        "<!-- AUTO:START -->\n# Titel\n<!-- AUTO:END -->\n"
    )
    fm = parse_frontmatter(note)
    assert fm["fag"] == "Musik", fm
    assert fm["emne"] == "Musikforståelse", fm
    assert fm["plan_id"] == "36016:1235133", fm
    assert fm["litteratur"].startswith("▥ Frede"), fm
    assert fm["forberedelse"] == "⚒ Forberedelse", fm

    plan = dict(fm, _path="§ FAG/♪ Musik/MD/W36tirs - Musikforståelse/[PLAN] W36tirs - Musikforståelse.md")
    ids = iter(f"id{n}" for n in range(100))
    data = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan], lambda: next(ids))

    sem = data["semesters"][0]
    assert sem["term"] == "Fall" and sem["year"] == 2026, sem
    cls = sem["classes"][0]
    assert cls["code"] == "♪ LSmu-2527" and cls["name"] == "Musik" and cls["vswFag"] == "Musik", cls
    assert cls["colorIndex"] == 5, cls  # kun sat ved oprettelsen, som defaulten for Musik

    # colorIndex rørt IGEN ved en senere kørsel: Hold Course har ingen farvevælger, kun en
    # positionel auto-tildeling — en gentaget override ville give "flere farver i spil" i stedet
    # for færre (Valdemars ord, live 2026-08-27), da HC selv kan have flyttet den siden.
    cls["colorIndex"] = 1
    data_recolor = sync_data(data, [plan], lambda: "MÅ-IKKE-BRUGES")
    assert data_recolor["semesters"][0]["classes"][0]["colorIndex"] == 1, "colorIndex blev overskrevet"
    assert data_recolor["semesters"][0]["classes"][0]["code"] == "♪ LSmu-2527", "code følger stadig med"
    lec = cls["lectures"][0]
    assert lec["title"] == "Musikforståelse" and lec["date"] == "2026-09-01", lec
    # "Lecture note" peger på [NOTE]-stubben, ikke på maskinens [PLAN].
    assert lec["vaultLink"].startswith("§ FAG/♪ Musik/NOTER/"), lec["vaultLink"]
    assert "[NOTE] " in lec["vaultLink"], lec["vaultLink"]
    # NFC, ellers finder pluginets getAbstractFileByPath ikke filen og "Open note" fejler tavst.
    assert unicodedata.is_normalized("NFC", lec["vaultLink"]), lec["vaultLink"]
    assert unicodedata.is_normalized("NFC", sem["resources"][0]["vaultLink"]), sem["resources"]
    assert len(lec["assignments"]) == 2, lec["assignments"]
    reading = next(a for a in lec["assignments"] if a["type"] == "Reading")
    assert reading["title"] == "Frede V Nielsen Ars og Scientia", reading
    assert reading["dueDate"] == "2026-09-01", reading
    assert reading["linkedBook"] == sem["resources"][0]["id"], (reading, sem["resources"])
    # Reading-opgaven fører til selve materiale-noten, forberedelse til Valdemars stub.
    assert reading["linkedNote"] == sem["resources"][0]["vaultLink"], reading
    assert sem["resources"][0]["classIds"] == [cls["id"]], sem["resources"]
    forb = next(a for a in lec["assignments"] if a["type"] == "Other")
    assert forb["linkedNote"] == lec["vaultLink"], forb
    assert forb["title"] == "Forberedelse", forb

    # Idempotens: samme input igen giver præcis samme struktur, ingen dubletter.
    snapshot = json.dumps(data, sort_keys=True)
    again = sync_data(json.loads(snapshot), [plan], lambda: "MÅ-IKKE-BRUGES")
    assert json.dumps(again, sort_keys=True) == snapshot, "synk er ikke idempotent"

    # Valdemars egne ændringer overlever en synk — dette er #113's vigtigste faldgrube.
    lec["status"] = "in-progress"
    reading["status"] = "done"
    reading["grade"] = "12"
    reading["notes"] = "læst i toget"
    reading["linkedNote"] = "min note.md"
    lec["vaultLink"] = "min egen note.md"
    cls["professorName"] = "Underviser"
    merged = sync_data(data, [plan], lambda: "MÅ-IKKE-BRUGES")
    m_cls = merged["semesters"][0]["classes"][0]
    m_lec = m_cls["lectures"][0]
    m_read = next(a for a in m_lec["assignments"] if a["type"] == "Reading")
    assert m_lec["status"] == "in-progress", m_lec
    assert m_lec["vaultLink"] == "min egen note.md", m_lec
    assert m_read["status"] == "done" and m_read["grade"] == "12", m_read
    assert m_read["notes"] == "læst i toget" and m_read["linkedNote"] == "min note.md", m_read
    assert m_cls["professorName"] == "Underviser", m_cls

    # Litteratur-tekst uden filmatch -> opgave uden Library-link.
    plan2 = dict(plan, plan_id="1:2", litteratur_filer="false",
                 _path="§ FAG/♪ Musik/MD/W37tirs/[PLAN] W37tirs.md")
    ids2 = iter(f"b{n}" for n in range(100))
    data2 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan2], lambda: next(ids2))
    lec2 = data2["semesters"][0]["classes"][0]["lectures"][0]
    read2 = next(a for a in lec2["assignments"] if a["type"] == "Reading")
    assert read2["linkedBook"] == "", read2
    assert read2["title"].startswith("Frede V Nielsen"), read2
    assert data2["semesters"][0]["resources"] == [], data2["semesters"][0]["resources"]

    # To reelle lektioner samme dag i samme fag (Musik torsdag: 08:15 og 12:25) deler `uge`-værdi
    # og SKAL blive to lektioner. Regressionsvagt mod den uge-baserede fallback der flettede dem.
    tors_a = {"fag": "Musik", "uge": "W34tors", "emne": "Når børn synger.", "plan_id": "36016:1298094",
              "start": "2026-08-20 08:15:00", "type": "lektionsplan", "_path": "a.md"}
    tors_b = dict(tors_a, emne="I. M. U.", plan_id="36016:1308760", start="2026-08-20 12:25:00", _path="b.md")
    ids3 = iter(f"c{n}" for n in range(100))
    data3 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2},
                      [tors_a, tors_b], lambda: next(ids3))
    lectures = data3["semesters"][0]["classes"][0]["lectures"]
    assert len(lectures) == 2, lectures
    assert {l["title"] for l in lectures} == {"Når børn synger.", "I. M. U."}, lectures
    assert all(l["date"] == "2026-08-20" for l in lectures), lectures

    # En udskudt lektion beholder sit plan_id og flytter dato — uden at opgaverne fordobles (#96).
    lectures[0]["assignments"].append({"id": "x", "title": "manuel", "type": "Other", "dueDate": "",
                                       "status": "not-started", "notes": "", "grade": "",
                                       "linkedBook": "", "linkedNote": ""})
    udskudt = dict(tors_a, start="2026-08-27 08:15:00", forberedelse="⚒ Forberedelse")
    data3 = sync_data(data3, [udskudt, tors_b], lambda: next(ids3))
    moved = next(l for l in data3["semesters"][0]["classes"][0]["lectures"] if l["vswPlanId"] == tors_a["plan_id"])
    assert moved["date"] == "2026-08-27", moved
    assert len(moved["assignments"]) == 2, moved["assignments"]   # den manuelle + forberedelse
    data3 = sync_data(data3, [udskudt, tors_b], lambda: "MÅ-IKKE-BRUGES")
    moved = next(l for l in data3["semesters"][0]["classes"][0]["lectures"] if l["vswPlanId"] == tors_a["plan_id"])
    assert len(moved["assignments"]) == 2, moved["assignments"]   # og ikke tre efter endnu en kørsel
    assert any(a["id"] == "x" for a in moved["assignments"]), moved["assignments"]

    # Afleveringsopgaver lander på klassen, ikke på en lektion, og fordobles ikke ved gentagne kørsler.
    opgave = {"type": "opgave", "fag": "Musik", "deadline": "2026-10-01 23:59:00",
              "kilde": "https://via.itslearning.com/main.aspx?CourseID=36016&ElementID=4831051",
              "_element_id": "4831051", "_path": "✎ NOTER/OPGAVER/Studieopgave/Studieopgave.md",
              "_title": "Studieopgave"}
    ids4 = iter(f"d{n}" for n in range(100))
    data4 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2},
                      [plan], lambda: next(ids4), tasks=[opgave])
    cls4 = data4["semesters"][0]["classes"][0]
    assert len(cls4["assignments"]) == 1, cls4["assignments"]
    ca = cls4["assignments"][0]
    assert ca["type"] == "Writing" and ca["dueDate"] == "2026-10-01", ca
    assert ca["linkedNote"] == opgave["_path"], ca
    assert ca["vswKey"] == "opgave|4831051", ca
    snap4 = json.dumps(data4, sort_keys=True)
    assert json.dumps(sync_data(json.loads(snap4), [plan], lambda: "MÅ-IKKE-BRUGES", tasks=[opgave]),
                      sort_keys=True) == snap4, "opgave-synk er ikke idempotent"

    # sync_task_completion: opgave-niveau binding, ikke lektion (Valdemars valg, 2026-08-28).
    stub_dir = Path(tempfile.mkdtemp())
    stub_path = stub_dir / "stub.md"
    stub_path.write_text(
        "---\ntype: note\n---\n\n## ⚒ Forberedelse\n"
        "- [ ] ⚒ Forberedelse\n- [ ] ⚒ Læs kapitel 2\n", encoding="utf-8")
    rel = str(stub_path.relative_to(stub_dir.parent))
    lec_tc = {"id": "L1", "vaultLink": rel, "assignments": [
        {"vswKey": "L1|forb|Forberedelse", "status": "done"},
        {"vswKey": "L1|forb|Læs kapitel 2", "status": "not-started"},
        {"vswKey": "L1|lit|nogetandet", "status": "done"},  # ikke forberedelse — må ikke krydses
    ]}
    data_tc = {"semesters": [{"classes": [{"lectures": [lec_tc]}]}]}
    checked_dry, done_dry = sync_task_completion(data_tc, stub_dir.parent, dry_run=True)
    assert checked_dry == [f"Forberedelse ({rel})"], checked_dry
    assert done_dry == [], done_dry                           # ingen linje er krydset af i vaulten endnu
    assert "- [ ] ⚒ Forberedelse" in stub_path.read_text(encoding="utf-8"), "dry-run skrev alligevel"

    checked, _ = sync_task_completion(data_tc, stub_dir.parent, dry_run=False)
    assert checked == [f"Forberedelse ({rel})"], checked
    written = stub_path.read_text(encoding="utf-8")
    assert "- [x] ⚒ Forberedelse" in written, written        # den Done-markerede krydses af
    assert "- [ ] ⚒ Læs kapitel 2" in written, written        # den ANDEN opgave, stadig not-started, rørt IKKE

    # Idempotent: kør igen, ingenting sker (allerede [x], og opgaven er allerede done).
    assert sync_task_completion(data_tc, stub_dir.parent, dry_run=False) == ([], [])

    # Den anden retning: Valdemar (eller extensionen efter en itslearning-synk) krydser af i
    # vaulten -> opgaven bliver done i Hold Course. Uden den ville alt fuldført arbejde blive
    # stående som Overdue på dashboardet for evigt.
    stub_path.write_text(
        "---\ntype: note\n---\n\n## ⚒ Forberedelse\n"
        "- [x] ⚒ Forberedelse\n- [x] ⚒ Læs kapitel 2\n", encoding="utf-8")
    lec_tc["assignments"][1]["status"] = "not-started"
    lec_tc["assignments"].append({"vswKey": "L1|forb|Eget tempo", "status": "in-progress"})
    _, marked = sync_task_completion(data_tc, stub_dir.parent, dry_run=False)
    assert marked == [f"Læs kapitel 2 ({rel})"], marked
    assert lec_tc["assignments"][1]["status"] == "done", lec_tc["assignments"][1]
    # in-progress er Valdemars egen vurdering og røres ikke, heller ikke selvom linjen mangler.
    assert lec_tc["assignments"][3]["status"] == "in-progress", lec_tc["assignments"][3]
    assert sync_task_completion(data_tc, stub_dir.parent, dry_run=False) == ([], [])

    # prune_dead_links (#138): en gammel dublet der peger på en fil der ikke længere findes (fx
    # efter en ugemappe-flytning, fra dengang synken nøglede på hele stien) skal væk, men en
    # levende post med en fil der findes skal overleve, og en ikke-linket opgave (tomt linkedNote)
    # skal ALDRIG fjernes.
    findes_path = stub_dir / "findes.md"
    findes_path.write_text("noget", encoding="utf-8")
    findes_rel = str(findes_path.relative_to(stub_dir.parent))
    data_prune = {"semesters": [{
        "resources": [
            {"id": "r-dod", "vaultLink": "findes/slet/ikke/gammel-sti.md"},
            {"id": "r-god", "vaultLink": findes_rel},
        ],
        "classes": [{
            "assignments": [{"vswKey": "a1", "linkedNote": "findes/slet/ikke/gammel-sti.md", "linkedBook": "r-dod"}],
            "lectures": [{"assignments": [
                {"vswKey": "a2", "linkedNote": findes_rel, "linkedBook": "r-god"},
                {"vswKey": "a3", "linkedNote": ""},  # aldrig linket — skal overleve uændret
            ]}],
        }],
    }]}
    removed_res, removed_assign = prune_dead_links(data_prune, stub_dir.parent)
    assert (removed_res, removed_assign) == (1, 1), (removed_res, removed_assign)
    sem_p = data_prune["semesters"][0]
    assert [r["id"] for r in sem_p["resources"]] == ["r-god"], sem_p["resources"]
    assert sem_p["classes"][0]["assignments"] == [], sem_p["classes"][0]["assignments"]  # a1 fjernet
    lec_p_assigns = sem_p["classes"][0]["lectures"][0]["assignments"]
    assert [a["vswKey"] for a in lec_p_assigns] == ["a2", "a3"], lec_p_assigns
    assert lec_p_assigns[0]["linkedBook"] == "r-god", lec_p_assigns
    assert prune_dead_links(data_prune, stub_dir.parent) == (0, 0), "ikke idempotent"

    # Eksakt vaultLink-dublet (to processer der skrev samtidig, live 2026-08-30): den ældste
    # bevares, classIds flettes, og en opgave der pegede på den yngre id'es flyttes med over.
    data_race = {"semesters": [{
        "resources": [
            {"id": "r-first", "vaultLink": findes_rel, "classIds": ["c1"]},
            {"id": "r-second", "vaultLink": findes_rel, "classIds": ["c2"]},
        ],
        "classes": [{
            "assignments": [{"vswKey": "b1", "linkedNote": "", "linkedBook": "r-second"}],
            "lectures": [],
        }],
    }]}
    removed_res_r, removed_assign_r = prune_dead_links(data_race, stub_dir.parent)
    assert (removed_res_r, removed_assign_r) == (1, 0), (removed_res_r, removed_assign_r)
    sem_r = data_race["semesters"][0]
    assert [r["id"] for r in sem_r["resources"]] == ["r-first"], sem_r["resources"]
    assert sem_r["resources"][0]["classIds"] == ["c1", "c2"], sem_r["resources"][0]
    assert sem_r["classes"][0]["assignments"][0]["linkedBook"] == "r-first", sem_r["classes"][0]["assignments"]

    # class.courseUrl: udledt af plan_id'ets CourseID, verificeret URL-form (live 2026-08-28).
    ids8 = iter(f"u{n}" for n in range(100))
    data8 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan], lambda: next(ids8))
    cls8 = data8["semesters"][0]["classes"][0]
    assert cls8["courseUrl"] == "https://via.itslearning.com/Course/Course.aspx?CourseId=36016", cls8
    cls8["courseUrl"] = "https://via.itslearning.com/noget-jeg-selv-valgte"  # Valdemar retter feltet
    data8 = sync_data(data8, [plan], lambda: "MÅ-IKKE-BRUGES")
    cls8 = data8["semesters"][0]["classes"][0]
    assert cls8["courseUrl"] == "https://via.itslearning.com/noget-jeg-selv-valgte", cls8

    # Kun indeværende semester synkes (issue #125): et rum der løber over flere semestre (fundet
    # live 2026-08-28 efter #121s backfill — Musik courseId 36016 havde lektioner fra 2025-08-13)
    # må ikke flette forrige semesters lektioner ind i dette semesters fag.
    forrige_semester = dict(plan, plan_id="36016:9990001", uge="W33tors-sidste-aar",
                            start="2025-08-14 08:15:00", stop="2025-08-14 12:00:00")
    ids9 = iter(f"e{n}" for n in range(100))
    data9 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2},
                      [plan], lambda: next(ids9))  # opretter "Efterår 2026" via plan (august -> Fall)
    assert data9["semesters"][0]["term"] == "Fall" and data9["semesters"][0]["year"] == 2026, data9["semesters"][0]
    data9 = sync_data(data9, [plan, forrige_semester], lambda: "MÅ-IKKE-BRUGES")
    lectures9 = data9["semesters"][0]["classes"][0]["lectures"]
    assert len(lectures9) == 1, lectures9   # forrige semesters lektion sprunget over, ikke tilføjet
    assert lectures9[0]["vswPlanId"] == plan["plan_id"], lectures9

    # Key Concepts & Lesson Goal (lec.notes): udfyldes fra beskrivelse:, men Valdemars egen
    # rettelse i Hold Course overlever en resync, ligesom vaultLink.
    plan_b = dict(plan, beskrivelse="I dag arbejder vi med resonansbegrebet.")
    ids7 = iter(f"g{n}" for n in range(100))
    data7 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan_b], lambda: next(ids7))
    lec7 = data7["semesters"][0]["classes"][0]["lectures"][0]
    assert lec7["notes"] == "I dag arbejder vi med resonansbegrebet.", lec7
    lec7["notes"] = "Mine egne stikord til timen"  # Valdemar retter i Hold Course
    plan_b2 = dict(plan_b, beskrivelse="Underviseren har opdateret beskrivelsen.")
    data7 = sync_data(data7, [plan_b2], lambda: "MÅ-IKKE-BRUGES")
    lec7 = data7["semesters"][0]["classes"][0]["lectures"][0]
    assert lec7["notes"] == "Mine egne stikord til timen", lec7  # ikke overskrevet

    # LivsOplysning-scenariet (live 2026-08-27): intet udfyldt litteratur-felt, men vedhæftede
    # fil-elementer i materiale_filer. Skal STADIG give en Reading-opgave, ikke ingenting.
    livso = dict(plan, plan_id="9:9", litteratur="false", litteratur_filer="false",
                 forberedelse="false", materiale_filer="📎 [[§ FAG/⚖︎ LivsOplysning/MD/x/Rosa1.md]]",
                 fag="LivsOplysning", _path="§ FAG/⚖︎ LivsOplysning/MD/x/[PLAN] x.md")
    ids5 = iter(f"e{n}" for n in range(100))
    data5 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [livso], lambda: next(ids5))
    lec5 = data5["semesters"][0]["classes"][0]["lectures"][0]
    assert len(lec5["assignments"]) == 1, lec5["assignments"]
    mat = lec5["assignments"][0]
    assert mat["type"] == "Reading" and mat["title"] == "Rosa1", mat
    assert mat["linkedBook"] == data5["semesters"][0]["resources"][0]["id"], mat
    snap5 = json.dumps(data5, sort_keys=True)
    assert json.dumps(sync_data(json.loads(snap5), [livso], lambda: "MÅ-IKKE-BRUGES"), sort_keys=True) == snap5

    # Et fag der har BÅDE litteratur_filer og materiale_filer for samme lektion -> ingen dublet,
    # to forskellige filer giver to opgaver.
    baade = dict(plan, plan_id="9:10", materiale_filer="📎 [[§ FAG/♪ Musik/MD/x/Ekstra.md]]",
                 _path="§ FAG/♪ Musik/MD/x/[PLAN] x.md")
    ids6 = iter(f"f{n}" for n in range(100))
    data6 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [baade], lambda: next(ids6))
    lec6 = data6["semesters"][0]["classes"][0]["lectures"][0]
    titles6 = sorted(a["title"] for a in lec6["assignments"] if a["type"] == "Reading")
    assert titles6 == ["Ekstra", "Frede V Nielsen Ars og Scientia"], titles6

    # Findes stubben ikke, falder vi tilbage til selve planen
    # Findes stubben ikke, falder vi tilbage til selve planen frem for et dødt link.
    assert note_stub_path("findes/slet/ikke/MD/x/[PLAN] x.md") == "findes/slet/ikke/MD/x/[PLAN] x.md"

    # `false`-felter og dublet-noter giver ingenting.
    assert prefixed_lines("false", "▥") == []
    assert parse_frontmatter("---\ntype: dublet\nplan_id: \"1:1\"\n---\n")["type"] == "dublet"

    # wikilink_target: pipe-alias (Valdemars pæne visningstekst, 2026-08-30) må ikke blive en del
    # af stien — ellers matcher den aldrig en rigtig fil og prune_dead_links() sletter den.
    assert wikilink_target("[[sti/Titel.md]]") == "sti/Titel.md"
    assert wikilink_target("[[sti/Titel.md|Titel.md]]") == "sti/Titel.md"
    assert wikilink_target("[[sti/Titel (2026).pdf|Titel (web)]]") == "sti/Titel (2026).pdf"

    # patch_pending_materiale (#141): en fil der lå i MD-mappen uden noget link i frontmatter
    # (MinerU-konverteringen kom først efter background.js' tidsvindue lukkede) skal linkes ind,
    # men en fil der ALLEREDE er nævnt i litteratur_filer skal ikke dubleres over i materiale_filer.
    patch_root = Path(tempfile.mkdtemp())
    week_dir = patch_root / "§ FAG" / "♪ Musik" / "MD" / "W36tirs"
    week_dir.mkdir(parents=True)
    plan_note = week_dir / "[PLAN] W36tirs.md"
    plan_note.write_text(
        "---\ntype: lektionsplan\nfag: Musik\n"
        "litteratur_filer: |\n  📎 [[§ FAG/♪ Musik/MD/W36tirs/Allerede-linket.md]]\n"
        "materiale_filer: false\n---\n\n<!-- AUTO:START -->\n# Titel\n<!-- AUTO:END -->\n",
        encoding="utf-8",
    )
    (week_dir / "Allerede-linket.md").write_text("noget", encoding="utf-8")
    (week_dir / "Ny-fil.md").write_text("noget nyt", encoding="utf-8")

    patched_dry = patch_pending_materiale(patch_root, apply=False)
    assert patched_dry == [str(plan_note.relative_to(patch_root))], patched_dry
    assert "materiale_filer: false" in plan_note.read_text(encoding="utf-8"), "dry-run skrev alligevel"

    patched = patch_pending_materiale(patch_root, apply=True)
    assert patched == [str(plan_note.relative_to(patch_root))], patched
    written = plan_note.read_text(encoding="utf-8")
    assert "materiale_filer: |\n  📎 [[§ FAG/♪ Musik/MD/W36tirs/Ny-fil.md|Ny-fil.md]]" in written, written
    assert "Allerede-linket.md" not in written.split("materiale_filer:")[1].split("---")[0], \
        "allerede litteratur-linket fil blev dubleret ind i materiale_filer"

    # Idempotent: ingen nye orphans tilbage efter patchen.
    assert patch_pending_materiale(patch_root, apply=True) == []

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        sys.exit(selfcheck())
    sys.exit(main())
