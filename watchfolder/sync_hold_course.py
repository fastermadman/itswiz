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
    lecture.vswDescription undervisernes beskrivelse: som synken sidst skrev den (issue #172)
    assignment.vswKey     "<lecture.id>|lit|<sti>" / "<lecture.id>|forb|<titel>"
    resource.vswResKey    vault-stien til den matchede litteraturfil
    class.vswFag          fag:-værdien
    semester.vswSync      semestret synken lægger sine klasser i

Synken ejer kun title/date/dueDate/type samt lecture.description (issue #172: undervisernes
beskrivelse:, adskilt fra lecture.notes så de to ejere ikke deler felt). Valdemars egne felter —
status-pills, karakterer, noter, linkede noter, TA/kontor-tid — røres aldrig, og intet slettes
nogensinde. Samme princip som
spliceAutoSection i background.js: maskinen ejer en afgrænset zone, mennesket ejer resten.

Pluginet opdager selv en ekstern skrivning (issue #198). Hold Course implementerer
`onExternalSettingsChange` (forkens main.js:1401, v1.8.0) og genindlæser sin data.json plus
repainter begge visninger af sig selv. Indtil #132 var det ikke tilfældet, og synken bad derfor
Obsidian genstarte HELE appen via Local REST API'ets `app:reload` (trigger_obsidian_reload()) —
en grovkornet løsning der afbrød Valdemar midt i en note, og som efter forkens hc#2 kørte oveni
pluginets eget repaint uden at tilføje noget. Den er væk igen; omtalerne af den længere nede i
filen er datid og forklarer #184's symptom, ikke nuværende adfærd.

Skrivningen selv er stadig beskyttet af mtime-vagten i sync(): ændrer data.json sig undervejs
(Hold Course gemte), springes flettningen over og kommer igen ved næste kørsel — synken er
idempotent, så en tabt kørsel koster ét interval, aldrig Valdemars status-pills.

Notér uden plan_id (ældre end issue #96) synkes ikke — de rapporteres, se ensure_lecture for hvorfor
et gæt på fag+uge blev afprøvet og forkastet. Samme rapportér-ikke-slet-princip gælder den anden
vej: en lecture hvis plan_id er faldet ud af itslearning (aflyst/fjernet) rapporteres, slettes
aldrig (issue #173).

Dry-run som standard, `--apply` udfører, `--selfcheck` kører den indbyggede test.
"""

import json
import re
import tempfile
import sys
import time
import unicodedata
from datetime import date as _date
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
DATA_JSON = VAULT_ROOT / ".obsidian" / "plugins" / "hold-course" / "data.json"
ONYX_DATA_JSON = VAULT_ROOT / ".obsidian-onyx" / "plugins" / "hold-course" / "data.json"

# main.js: COLOR_PALETTE har 6 farver, og addClass sætter colorIndex = classes.length % længden.
COLOR_PALETTE_SIZE = 6

# Spejl af `CURRENT_DATA_VERSION` i obsidian-hold-course/main.js. Nu en LEVENDE
# kompatibilitets-kontrakt mellem de to repos, ikke bare et engangs-migrerings-flag
# (hold-course#63 / #182). Bump denne OG plugin-konstanten i koordinerede commits når
# en data.json-ændring IKKE er bagud-sikker for den anden side: et felt læseren skal
# have, eller et eksisterende felt/værdi hvis betydning skifter. Rent additive,
# presence-baserede felter en ældre læser trygt ignorerer (#41's per-lektion
# tid/lokale/underviser, #54's 'Preparation'-type) må springe bumpet over — men skriv
# det i commit'en; det er ikke defaulten. sync() nægter at skrive en data.json stemplet
# HØJERE end dette (skrevet af en nyere synk end pluginet kender); lavere/fraværende
# migrerer pluginet selv som hidtil. Delt fixture: den anden repos
# test/fixtures/contract-data.json, verificeret af selfcheck() her og af
# test/contract-fixture.test.js dér.
KNOWN_DATA_VERSION = 2

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

    background.js skriver den til `§ FAG/<fag>/NOTER/<enhed>/[NOTE] <uge>.md` (noteStubPath), hvor
    `<enhed>` er MAPPEN (enhedFolder) og `<uge>` ("<dato> - <emne>") er selve FILNAVNET (issue #209:
    NOTER/ er enhed-grupperet ligesom MD/, ikke længere én mappe pr. lektion). MD-mappen i plan_path
    ER allerede enhedFolder — samme værdi genbruges direkte til NOTER-mappen i stedet for at
    genudlede den, så de to grene ikke kan drive fra hinanden. [PLAN]-FILNAVNET bærer uafhængigt af
    mappen altid weekFolder som sin egen stamme ("[PLAN] 2026-09-09 - Skolens formål.md") — den er
    stub-FILNAVNETS pålidelige nøgle. Falder tilbage til selve planen hvis stubben mangler."""
    m = re.match(r'^(.*)/MD/([^/]+)/\[PLAN\] (.+)\.md$', plan_path)
    if not m:
        return plan_path
    root, enhed, week_folder = m.groups()
    stub = f"{root}/NOTER/{enhed}/[NOTE] {week_folder}.md"
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


AUTO_MATERIALER_RE = re.compile(r"^## Materialer\n(.*?)(?=\n## |\n<!-- AUTO:END|\Z)", re.S | re.M)


def _owned_targets(text: str, fields: dict) -> set[str]:
    """Hvilke materiale-filer background.js beviseligt har tildelt DENNE plan (#183).

    De to felter patch_pending_materiale aldrig selv skriver til, og som derfor stadig er ren
    plan.elements-sandhed: AUTO-blokkens `## Materialer` (writePlanNotes' `materials`, som også
    rummer Link-elementer og RAW-modparter — de matcher bare ingen fil i mappen og filtreres væk
    af kalderen) og frontmatterens `litteratur_filer`. `materiale_filer` er BEVIDST udeladt: det
    er netop dét felt der er fladet ud af tidligere kørsler, og at læse det ville gøre reglen
    cirkulær.
    """
    match = AUTO_MATERIALER_RE.search(text)
    owned = {nfc(t) for t in re.findall(r"\[\[([^|\]]+)", match.group(1))} if match else set()
    owned |= {nfc(t) for l in prefixed_lines(fields.get("litteratur_filer", ""), LITTERATUR_FIL_PREFIX)
              if (t := wikilink_target(l))}
    return owned


def _declared_owner(md_path: Path) -> str | None:
    """#186: en materiale-note kan selv erklære sin lektion via `lektion: <plan_id>` i
    frontmatter — for filer der aldrig stod i en AUTO-blok (manuelt tilføjet, eller downloadet
    uden for background.js' tidsvindue). Ren menneske-override, background.js skriver aldrig
    feltet: det ville fastfryse ejerskabet forbi den dag underviseren selv fjerner filen fra
    planen. `plan_id`-navnet blev bevidst fravalgt (samme streng, men `read_plans` filtrerer på
    `type: lektionsplan` og ville forveksle en materiale-note der har feltet med en plan)."""
    return parse_frontmatter(md_path.read_text(encoding="utf-8")).get("lektion") or None


def _is_dublet(md_path: Path) -> bool:
    """`type: dublet`-pointernoter (fra før enhed-modellen, #217) er ikke materiale: de peger blot
    videre til den rigtige note. Efter #214 lå de i samme mappe som deres mål og blev ellers
    claimet som læsestof af alle søskende-planer."""
    return parse_frontmatter(md_path.read_text(encoding="utf-8")).get("type") == "dublet"


# #208: "I dag er sat af til at I kan forberede jer …" — dagens indhold ER forberedelsen.
PREP_DAY_RE = re.compile(r"sat\s+af\s+til[^.\n]{0,60}forbere", re.IGNORECASE)


def _is_prep_day(fields: dict) -> bool:
    """En ren forberedelsesdag: `beskrivelse` siger at dagen er sat af til forberedelse, og noten har
    ingen egen `forberedelse_tekst`. Den har aldrig krævet noget specifikt læsestof selv, så at lade
    den stå uden orphan-links taber ikke adgang til noget (#208)."""
    own = fields.get("forberedelse_tekst")
    return not (own and own != "false") and bool(PREP_DAY_RE.search(fields.get("beskrivelse") or ""))


def remove_file_list_lines(text: str, key: str, prefix: str, drop: set[str]) -> str:
    """Modstykket til append_file_list_field: fjerner de 📎-linjer i `key` hvis wikilink-mål står
    i `drop`. Tømmes blokken helt, bliver feltet `key: false` igen — samme form background.js selv
    skriver for et tomt felt, så Bases' `!= false`-filtre bliver ved med at virke."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.strip() != f"{key}: |":
            continue
        j = i + 1
        while j < len(lines) and lines[j].startswith("  "):
            j += 1
        kept = [l for l in lines[i + 1:j]
                if nfc(wikilink_target(l.strip()[len(prefix):].strip()) or "") not in drop]
        block = [f"{key}: |"] + kept if kept else [f"{key}: false"]
        return "\n".join(lines[:i] + block + lines[j:])
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
    Idempotent og billig (samme mapper read_plans() alligevel scanner), sikkert at køre hvert minut.

    Efter enhed-migreringen (#150/#155) ligger ALLE en enheds [PLAN]-noter + _forløb.md i samme
    MD/<enhed>/-mappe. Kun ægte materiale tælles som "manglende link": søskende-[PLAN]/[NOTE]-noter
    og _*-filer filtreres fra, og linked-mængden NFC-normaliseres på begge sider (ü/æ/ø/å i
    mappenavne gav ellers NFD/NFC-mismatch og monotont voksende selvreferencer — issue #158).

    Ejerskab i en delt enhed-mappe afgøres af background.js' EGEN plan.elements-skrivning, ikke
    af et gæt her (#183). #176 gættede "kronologisk første lektion ejer filen, resten arver
    intet" og blev reverteret samme dag: filernes `dato:`-felt stemmer ikke med filnavnets
    dato-suffiks, fordi lektioner flyttes i itslearning (#96) uden at materiale-noternes
    snapshot-dato følger med — 3 af 4 "Skolens formål"-lektioner stod tomme i Hold Course selvom
    læsestoffet lå i vaulten.

    Det pålidelige signal FINDES dog, det står bare ikke i `materiale_filer`: background.js
    skriver samme plan.elements-liste TO steder — frontmatter `materiale_filer` OG AUTO-blokkens
    `## Materialer` (writePlanNotes). Denne funktion har kun nogensinde skrevet til
    `materiale_filer`, så AUTO-blokken (+ `litteratur_filer`, som den heller aldrig rører) er
    urørt itslearning-sandhed pr. plan — se _owned_targets(). Live-målt 2026-09-06 over alle 16
    delte enhed-mapper: 103 af 150 filer (68%) har dermed en kendt, diskriminerende ejer.

    Reglen: en orphan springes over for DENNE plan hvis en søskende beviseligt ejer den og denne
    plan ikke gør. Ejer ingen søskende den (de resterende 32% — MinerU nåede aldrig ind i
    background.js' tidsvindue, som er hele grunden til at funktionen findes), claimer alle
    søskende den som før. Aldrig under-inkluderende: #176's fejltilstand kan ikke opstå, fordi
    en fil kun fravælges dér hvor der findes positivt bevis for en anden ejer. Prisen er de
    32%'s dublet-Reading-opgaver — kedeligt, aldrig tab af adgang til materiale.

    #208: rene forberedelsesdage (_is_prep_day) arver aldrig orphans — de har aldrig krævet specifikt
    læsestof selv, og deres "arvede" liste viste sig som dublet-Reading-opgaver i Hold Course.
    Kun undertypen indsnævres; fallback'en gælder fortsat alle andre noter uændret.

    #186: for materiale der ALDRIG stod i en plan.elements-liste (manuelt tilføjet af Valdemar) er
    der intet AUTO-bevis at falde tilbage på — se _declared_owner(). Et `lektion: <plan_id>` på
    filen selv gør det samme job som AUTO-blokken ville have gjort, hvis den havde vidst det."""
    # Samlet pr. mappe, ikke pr. note: ejerskabet nedenfor kan kun afgøres ved at se søskendene.
    folders: dict[Path, list[tuple[Path, str, dict]]] = {}
    for plan_path in sorted(vault_root.rglob("[[]PLAN[]] *.md")):
        text = plan_path.read_text(encoding="utf-8")
        fields = parse_frontmatter(text)
        if fields.get("type") != "lektionsplan":
            continue
        folders.setdefault(plan_path.parent, []).append((plan_path, text, fields))

    patched = []
    for siblings in folders.values():
        owned = {path: _owned_targets(text, fields) for path, text, fields in siblings}

        # #186: `lektion: <plan_id>` på en materiale-note i mappen overtrumfer/supplerer
        # AUTO-blokken for netop DEN fil — dækker manuelt tilføjet materiale, som aldrig stod i
        # nogen plan.elements-liste og derfor ellers ville forblive ejerløst for evigt.
        declared = {
            nfc(str(md.relative_to(vault_root))): pid
            for md in siblings[0][0].parent.glob("*.md")
            if not md.name.startswith(("[PLAN] ", "[NOTE] ", "_")) and (pid := _declared_owner(md))
        }
        for plan_path, _, fields in siblings:
            owned[plan_path] |= {t for t, pid in declared.items() if pid == fields.get("plan_id")}

        for plan_path, text, fields in siblings:
            claimed_elsewhere = set().union(
                *(t for p, t in owned.items() if p != plan_path), set()
            ) - owned[plan_path]

            linked = {
                nfc(t)
                for key, pfx in (("materiale_filer", MATERIALE_FIL_PREFIX), ("litteratur_filer", LITTERATUR_FIL_PREFIX))
                for l in prefixed_lines(fields.get(key, ""), pfx)
                if (t := wikilink_target(l))
            }

            orphans = [
                nfc(str(md.relative_to(vault_root)))
                for md in sorted(plan_path.parent.glob("*.md"))
                if nfc(md.name) != nfc(plan_path.name)
                and not md.name.startswith(("[PLAN] ", "[NOTE] ", "_"))
                and not _is_dublet(md)
            ]
            orphans = [o for o in orphans if o not in linked and o not in claimed_elsewhere]
            if _is_prep_day(fields):
                orphans = []  # #208: rene forberedelsesdage arver aldrig orphan-filer

            # Oprydning efter tidligere kørslers udfladning: samme regel bagudrettet. Kun
            # `materiale_filer` (det eneste felt denne funktion nogensinde har skrevet i) og kun
            # mål en søskende beviseligt ejer — Valdemars egne links og alt uden for mappen
            # røres aldrig, og et link uden positivt modbevis bliver stående.
            foreign = {
                t for l in prefixed_lines(fields.get("materiale_filer", ""), MATERIALE_FIL_PREFIX)
                if (t := nfc(wikilink_target(l) or "")) in claimed_elsewhere
            }
            if not orphans and not foreign:
                continue

            updated = append_file_list_field(text, "materiale_filer", MATERIALE_FIL_PREFIX,
                                              [wikilink_for(o) for o in orphans]) if orphans else text
            if foreign:
                updated = remove_file_list_lines(updated, "materiale_filer", MATERIALE_FIL_PREFIX, foreign)
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
    rapporteres frem for at forsvinde stille.

    Her stod indtil #184 et dedup-plaster: to noter kunne bære samme plan_id, fordi background.js
    skrev alle en enheds lektioner til `MD/<enhed>/[PLAN] <enhed>.md` mens de daterede noter fra
    før enhed-migreringen (#150/#155) stod tilbage som rester. Begge ramte samme lecture i
    sync_data og prunede hinandens Reading-opgaver via valid_file_keys — nye opgave-id'er ved hver
    kørsel, så data.json ændrede sig altid og trigger_obsidian_reload genstartede Obsidian hvert
    minut (live-bekræftet 2026-09-06). #184 gav hver lektion sin egen plan-note-sti, så
    dubletter er strukturelt umulige og plasteret er væk igen. Selve håndhævelsen — en assertion
    frem for en rapport — hører hjemme i #182s delte kontrakt-fixture."""
    plans, uden_plan_id = [], []
    declared_by_folder: dict[Path, dict[str, str]] = {}
    for path in sorted(vault_root.rglob("[[]PLAN[]] *.md")):
        fields = parse_frontmatter(path.read_text(encoding="utf-8"))
        if fields.get("type") != "lektionsplan" or not fields.get("fag"):
            continue
        rel = str(path.relative_to(vault_root))
        if not fields.get("plan_id"):
            uden_plan_id.append(rel)
            continue
        fields["_path"] = nfc(rel)
        # #221: hvad planen BEVISELIGT ejer — resten af dens materiale_filer er fallback-afledt.
        text = path.read_text(encoding="utf-8")
        if path.parent not in declared_by_folder:
            declared_by_folder[path.parent] = {
                nfc(str(md.relative_to(vault_root))): pid
                for md in path.parent.glob("*.md")
                if not md.name.startswith(("[PLAN] ", "[NOTE] ", "_")) and (pid := _declared_owner(md))
            }
        fields["_owned"] = sorted(
            _owned_targets(text, fields)
            | {t for t, pid in declared_by_folder[path.parent].items() if pid == fields["plan_id"]}
        )
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


def relocate_stamped(data: dict, list_name: str, key: str, value, target_cls: dict) -> None:
    """Flytter et allerede eksisterende lecture/assignment-objekt ind i `target_cls`, hvis det ligger
    i en ANDEN klasse (typisk et forkert semester fra tiden før #126 fordelte retroaktivt). Uden
    dette bliver objektet duplikeret: find_stamped i target_cls finder intet og opretter et nyt,
    mens originalen bliver stående som spøgelse i sit gamle (forkerte) semester (fundet #146).

    Findes objektet ALLEREDE i target_cls (fra en tidligere kørsel der duplikerede før denne
    funktion fandtes), er den ekstra kopi et rent duplikat af synkens egne felter — den kasseres
    i stedet for at blive flyttet ind ved siden af, ellers fordobles listen ved hver kørsel.

    Kan også ligge dobbelt INDE i target_cls selv (to objekter med samme nøgle side om side, fra
    før relocate_stamped fandtes) — de ekstra fjernes her, kun den første beholdes."""
    own = target_cls.setdefault(list_name, [])
    own_matches = [it for it in own if it.get(key) == value]
    for extra in own_matches[1:]:
        own.remove(extra)
    already = own_matches[0] if own_matches else None
    for sem in data.get("semesters", []):
        for cls in sem.get("classes", []):
            if cls is target_cls:
                continue
            item = find_stamped(cls.get(list_name, []), key, value)
            if item:
                cls[list_name].remove(item)
                if not already:
                    target_cls.setdefault(list_name, []).append(item)
                return


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


def semester_name_for_term_year(term: str, year: int) -> str:
    """Dansk navn for semester ud fra term + year."""
    if term == "Fall":
        return f"Efterår {year}"
    elif term == "Spring":
        return f"Forår {year}"
    return f"{term} {year}"


def ensure_all_semesters(data: dict, plans: list[dict], tasks: list[dict], new_id) -> dict:
    """Opretter alle nødvendige semestre retroaktivt. Returnerer dict der mapper (term, year) -> semester-objekt.

    Ikke-vswSync semestre behandles som brugerens egne (adopteres). Alle lektioner/opgaver fordeles
    efter deres dato, ikke til ét hardkodet semester."""
    from datetime import datetime

    data.setdefault("semesters", [])

    # Identificer alle semestre der skal være til stede (ud fra planerne/opgaverne)
    needed_terms = set()
    for plan in plans:
        if plan.get("start"):
            needed_terms.add(term_year_for_date(plan["start"][:10]))
    for task in tasks:
        if task.get("deadline"):
            needed_terms.add(term_year_for_date(task["deadline"][:10]))

    # Hvis der slet ingen planer/opgaver, brug indeværende semester som fallback
    if not needed_terms:
        year, month = datetime.now().year, datetime.now().month
        needed_terms.add(("Fall", year) if month >= 7 else ("Spring", year))

    # Byg eller adoptér semestre
    term_year_to_sem = {}
    for term, year in sorted(needed_terms):
        # Find eksisterende semester (vswSync eller user-created)
        sem = next((s for s in data["semesters"] if s.get("term") == term and s.get("year") == year), None)
        if sem:
            term_year_to_sem[(term, year)] = sem
        else:
            # Opret nyt
            name = semester_name_for_term_year(term, year)
            sem = {"id": new_id(), "name": name, "term": term, "year": year, "classes": [], "resources": []}
            data["semesters"].append(sem)
            term_year_to_sem[(term, year)] = sem

    # Sæt currentSemesterId til nuværende semester hvis ikke sat
    if not data.get("currentSemesterId") and data["semesters"]:
        data["currentSemesterId"] = data["semesters"][0]["id"]

    return term_year_to_sem


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


def hhmm(datetime_str: str) -> str:
    """"2026-08-17 10:00:00" -> "10:00". Tom streng ved kortere/manglende input (fx `plan.stop`
    på en forældreløs plan uden stop-felt) — aldrig et gæt."""
    return datetime_str[11:16] if len(datetime_str) >= 16 else ""


def _set_deviation_field(lec: dict, field: str, cls_default: str, itslearning_value: str) -> None:
    """Sætter lec[field] når itslearning-værdien afviger fra klassens standard, ellers "" (arv).
    Kun når feltet stadig er synk-ejet (uændret siden sidste synk-skrivning, samme vsw<Felt>
    stempel-mønster som vswVaultLink) — har Valdemar selv redigeret det i Hold Course, er
    værdien hans, og synken rører den aldrig igen, heller ikke for at "rydde op til arv"."""
    stamp = f"vsw{field[0].upper()}{field[1:]}"
    sync_owned = stamp not in lec or lec.get(field, "") == lec.get(stamp, "")
    if not sync_owned:
        return
    target = itslearning_value if itslearning_value and itslearning_value != cls_default else ""
    lec[field] = target
    lec[stamp] = target


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
               "notes": "", "description": "", "vaultLink": "", "assignments": [],
               "meetingStartTime": "", "meetingEndTime": "", "location": "", "professorName": "",
               "vswPlanId": plan["plan_id"]}
        cls["lectures"].append(lec)
    # Synkens felter. status er udelukkende Valdemars og røres aldrig.
    lec["title"] = plan.get("emne") or plan.get("uge") or "Lektion"
    lec["date"] = (plan.get("start") or "")[:10]

    # Tid/lokale/underviser pr. lektion (issue #118/#124, hold-course#41): et tomt felt betyder
    # "arv fra klassens standard", IKKE "intet sat" (aftalt med Hold Course-siden) — så disse
    # felter skal kun udfyldes når itslearning rent faktisk AFVIGER fra klassens standardværdi.
    # Samme sync-owned-stempel-mønster som vswVaultLink/vswDescription ovenfor: konvergerer
    # tilbage til "" hvis afvigelsen forsvinder igen (fx en rettet plan), men rører aldrig et
    # felt Valdemar selv har redigeret i Hold Course.
    _set_deviation_field(lec, "meetingStartTime", cls.get("meetingStartTime", ""), hhmm(plan.get("start", "")))
    _set_deviation_field(lec, "meetingEndTime", cls.get("meetingEndTime", ""), hhmm(plan.get("stop", "")))
    _set_deviation_field(lec, "location", cls.get("location", ""), plan.get("lokale", ""))
    _set_deviation_field(lec, "professorName", cls.get("professorName", ""), plan.get("underviser", ""))

    # Undervisernes beskrivelse: har sit EGET felt (issue #172, counterpart til
    # hold-course#5b). Den stod før i lec.notes under et vswNotes-stempel, side om side med
    # Valdemars egne forberedelsesnoter — to ejere i ét felt. Konkret bed det på to måder:
    # et bevidst tømt notes-felt talte som "sync-owned, tomt" og blev refyldt ved næste kørsel
    # (og med hold-course#5b, hvor noten flytter ud i en fil og feltet tømmes, ville det ske
    # hver gang), og en guard der bare fredede feltet ville omvendt stoppe beskrivelses-
    # opdateringer fra overhovedet at nå frem. Split i stedet: description er 100% synkens,
    # notes er 100% Valdemars. Hold Course viser description read-only ("Lesson Description").
    beskrivelse = plan.get("beskrivelse", "")
    beskrivelse = "" if beskrivelse == "false" else beskrivelse
    # #205: Forberedelse-INSTRUKTIONEN (ikke kun titlen — den står allerede i assignment.title via
    # ensure_assignment nedenfor) i samme felt som Formål ovenfor. Valdemar spurgte hvorfor han
    # kunne se AT der var en Forberedelse uden at kunne se HVAD den bad om uden at åbne [PLAN]-
    # noten — samme "description er 100% synkens"-begrundelse gælder her, ingen ny UI-sektion
    # nødvendig, MarkdownRenderer.render (main.js:3679) tegner "**Forberedelse**"-overskriften fint.
    forberedelse_tekst = plan.get("forberedelse_tekst", "")
    forberedelse_tekst = "" if forberedelse_tekst == "false" else forberedelse_tekst
    beskrivelse_dele = [d for d in (
        beskrivelse,
        f"**Forberedelse**\n\n{forberedelse_tekst}" if forberedelse_tekst else "",
    ) if d]
    description = "\n\n---\n\n".join(beskrivelse_dele)
    if description:
        lec["description"] = description
        lec["vswDescription"] = description
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


def migrate_notes_to_description(data: dict) -> int:
    """Engangs-migrering til #172: flyt undervisernes beskrivelse fra lec.notes over i
    lec.description, så notes bliver rent Valdemars (file-is-truth, hold-course#5b).

    vswNotes-stemplet er facit for hvem der skrev teksten: står notes uændret som synken sidst
    skrev den, er det undervisernes tekst og den flyttes. Afviger den — også hvis feltet er tomt,
    fordi han bevidst har ryddet det — er indholdet hans, og feltet står urørt (hold-course#5b
    migrerer det ind i notefilen ved første redigering). Stemplet fjernes i begge tilfælde:
    synken skriver aldrig notes igen, så et vswNotes ville kun være en løgn i data.json.

    Idempotent: efter første kørsel har ingen lecture et vswNotes at migrere. Returnerer antal
    flyttede.
    """
    moved = 0
    for sem in data.get("semesters", []):
        for cls in sem.get("classes", []):
            for lec in cls.get("lectures", []):
                if "vswNotes" not in lec:
                    continue
                stamp = lec.pop("vswNotes")
                if lec.get("notes", "") == stamp:
                    lec["description"] = stamp
                    lec["vswDescription"] = stamp
                    lec["notes"] = ""
                    moved += 1
    return moved


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


def prune_stale_resource_classes(data: dict, seen: dict[str, set[str]],
                                 touched_classes: set[str]) -> list[str]:
    """`classIds` voksede kun, aldrig omvendt (#181): holdt et fag op med at bruge et materiale,
    blev resourcen hængende i den klasses Library for evigt. `prune_dead_links` fanger kun døde
    FILSTIER, ikke logisk forældreløshed — filen ligger der stadig, ingen lektion peger på den.

    `seen` er {resource_id: {class_id, ...}} fra DENNE kørsel, `touched_classes` de klasser der
    rent faktisk fik mindst én plan (samme vagt som #173's dropped_out: en klasse uden planer kan
    lige så vel være en fejlet fetch som et reelt tomt fag, og må ikke røres). Kun bogføringen
    ryddes — selve resourcen slettes ALDRIG her, fordi `status`/`notes` på den er Valdemars.
    Ender den uden nogen klasse, rapporteres den i stedet, samme rapportér-frem-for-slet-linje
    som #96/#173."""
    orphaned = []
    for sem in data.get("semesters", []):
        for res in sem.get("resources", []):
            still = seen.get(res["id"], set())
            kept = [c for c in res.get("classIds", []) if c not in touched_classes or c in still]
            res["classIds"] = kept
            if not kept:
                orphaned.append(f'{res.get("title", "")} ({res.get("vaultLink", "")})')
    return orphaned


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

def sync_data(data: dict, plans: list[dict], new_id=None, tasks: list[dict] | None = None,
             dropped_out: list[str] | None = None,
             report: dict[str, list[str]] | None = None) -> dict:
    """Fletter plans ind i en data.json-struktur. Ren funktion — al I/O ligger i sync().

    Fordeler lektioner/opgaver til deres rigtige semester baseret på dato (issue #126).
    Opretter semestre retroaktivt efter behov.

    dropped_out (#173): valgfri akkumulator — er den givet, udfyldes den med én tekstlinje pr.
    lecture der er faldet ud af itslearning siden sidst (matcher stadig `vswPlanId`, men den
    værdi optrådte ikke i DENNE kørsels plan-sæt for lektionens fag). Rapporteres kun, ALDRIG
    slettet — "intet slettes nogensinde" gælder også her. Default None ændrer ingenting for
    eksisterende kald.

    report (#181): samme rapportér-frem-for-slet-akkumulator, men for de tre andre `ensure_*` der
    manglede et modstykke — nøglerne `dropped_classes` (fag helt væk fra itslearning),
    `dropped_tasks` (afleveringsopgave væk) og `orphaned_resources` (materiale ingen klasse bruger
    længere). Ingen af dem sletter noget; `prune_stale_resource_classes` rører kun bogføringen.
    Default None ændrer ingenting for eksisterende kald."""
    counter = [0]
    new_id = new_id or (lambda: generate_id(counter))
    data.setdefault("semesters", [])
    data.setdefault("dataVersion", KNOWN_DATA_VERSION)
    tasks = tasks or []
    # Kører før alt andet og uafhængigt af om der er planer denne gang: en lektion der er faldet
    # ud af itslearning skal også have sit gamle vswNotes ryddet (#172).
    migrate_notes_to_description(data)
    if not plans and not tasks:
        return data

    # Opretter/adoptér alle nødvendige semestre
    term_year_to_sem = ensure_all_semesters(data, plans, tasks, new_id)

    # #173: hvilke (semester, klasse) der rent faktisk fik mindst én plan i DENNE kørsel, og hvilke
    # plan_id'er de fik. Kun disse klasser er "trygge" at kigge for droppede lektioner i bagefter —
    # en klasse der slet ikke optræder her kan skyldes en fetch-fejl for hele faget, ikke at alle
    # dens lektioner reelt er væk (goal metrics i #173).
    touched: dict[tuple[str, str], set[str]] = {}
    # #181: {resource_id: {class_id}} for DENNE kørsel — grundlaget for at classIds kan krympe igen.
    seen_res: dict[str, set[str]] = {}
    # #221: (klasse, mål) -> plan_id der har fået Reading-opgaven for et FALLBACK-afledt link.
    fallback_claimed: dict[tuple[str, str], str] = {}

    for plan in sorted(plans, key=lambda p: (p["fag"], p.get("start", ""))):
        if not plan.get("start"):
            continue
        # Find det rigtige semester for denne lektion
        target_term_year = term_year_for_date(plan["start"][:10])
        sem = term_year_to_sem.get(target_term_year)
        if not sem:
            # Fallback hvis término ikke er kendt (bør ikke ske efter ensure_all_semesters)
            sem = term_year_to_sem.get(next(iter(term_year_to_sem)))
            if not sem:
                continue

        # plan_id er "<courseId>:<planId>" (background.js: planKey) — første halvdel er det
        # CourseID class.courseUrl skal pege på.
        cls = ensure_class(sem, plan["fag"], new_id, plan["plan_id"].split(":")[0])
        relocate_stamped(data, "lectures", "vswPlanId", plan["plan_id"], cls)
        lec = ensure_lecture(cls, plan, new_id)
        touched.setdefault((sem["id"], cls["id"]), set()).add(plan["plan_id"])  # #173
        due = lec["date"]
        # Opgavernes nøgle hænger på lektionens EGET id, ikke på plan_id eller dato: id'et er det
        # eneste der ligger fast når itslearning udskyder en lektion (plan_id består, datoen
        # skifter — issue #96). En dato-afledt nøgle ville fordoble alle opgaver ved hver
        # udskydelse.
        akey = lec["id"]
        stub = lec.get("vswVaultLink") or lec["vaultLink"]

        # #176-følgeskade: en fil krydslinket ind af den (nu rettede) enheds-bug ovenfor gav en
        # Reading-opgave der aldrig forsvandt igen, selv efter frontmatter blev renset — ensure_
        # assignment opretter/opdaterer kun, den sletter aldrig en opgave hvis kilden bag den
        # forsvinder. `valid_file_keys` er de |lit|/|mat|-nøgler DENNE plan rent faktisk giver
        # lektionen i DENNE kørsel; alt andet med samme præfiks var en tidligere kørsels fejl
        # eller en fil der reelt er fjernet fra planen, og ryddes nedenfor. Forberedelse (|forb|)
        # og Valdemars egne opgaver (intet vswKey) er IKKE en del af dette — kun sync-ejede
        # materiale-opgaver, samme afgrænsning som synken selv skriver i modulets docstring.
        valid_file_keys = set()

        lit_files = prefixed_lines(plan.get("litteratur_filer", ""), LITTERATUR_FIL_PREFIX)
        targets = [nfc(t) for t in (wikilink_target(line) for line in lit_files) if t]
        if targets:
            for target in targets:
                res = ensure_resource(sem, cls, target, new_id)
                seen_res.setdefault(res["id"], set()).add(cls["id"])  # #181
                # linkedNote peger på selve materiale-noten, så "Open note" virker direkte fra
                # opgaven uden omvejen om Library.
                key = f'{akey}|lit|{stable_key(target)}'
                ensure_assignment(lec, key, res["title"], "Reading", due,
                                  res["id"], new_id, linked_note=target)
                valid_file_keys.add(key)
        else:
            # Ren litteratur-tekst uden filmatch: stadig en Reading-opgave, bare uden Library-link —
            # der er ikke noget at linke til (issue #44's konservative matching lader den slags stå).
            lit_text = prefixed_lines(plan.get("litteratur", ""), LITTERATUR_PREFIX)
            if lit_text:
                key = f'{akey}|lit|'
                ensure_assignment(lec, key, " ".join(lit_text)[:200], "Reading", due,
                                  "", new_id, linked_note=stub)
                valid_file_keys.add(key)

        for titel in prefixed_lines(plan.get("forberedelse", ""), FORBEREDELSE_PREFIX):
            # Forberedelses-afkrydsningerne står i [NOTE]-stubben (issue #59), så det er dér
            # opgaven skal føre hen.
            ensure_assignment(lec, f'{akey}|forb|{titel}', titel, "Preparation", due, "", new_id,
                              linked_note=stub)

        # Alt vedhæftet fil-materiale UDEN et litteratur-felt-match (background.js udelukker selv
        # de allerede fangede litteratur_filer-mål, så ingen dublet-Reading for samme fil). Dækker
        # fag hvor underviseren aldrig udfylder "Tilhørende litteratur" — LivsOplysning har 0
        # udfyldte litteratur-felter, men vedhæfter læsestoffet som almindelige fil-elementer.
        for line in prefixed_lines(plan.get("materiale_filer", ""), MATERIALE_FIL_PREFIX):
            target = nfc(wikilink_target(line) or "")
            if not target:
                continue
            # #221: et link planen ikke beviseligt ejer (patch_pending_materiale-fallback, #141/#183)
            # bliver til én Reading-opgave pr. klasse — på den TIDLIGSTE lektion (planerne løbes
            # igennem kronologisk), aldrig for sent. Linket i noten bevares på alle søskende, så
            # #183s "aldrig tab af adgang" gælder uændret; kun opgave-dubletterne udebliver, og den
            # oprydning nedenfor fjerner dem der allerede findes. Plan uden `_owned` (fx tests) er
            # upåvirket.
            if "_owned" in plan and target not in plan["_owned"]:
                if fallback_claimed.setdefault((cls["id"], target), plan["plan_id"]) != plan["plan_id"]:
                    continue
            res = ensure_resource(sem, cls, target, new_id)
            seen_res.setdefault(res["id"], set()).add(cls["id"])  # #181
            key = f'{akey}|mat|{stable_key(target)}'
            ensure_assignment(lec, key, res["title"], "Reading", due,
                              res["id"], new_id, linked_note=target)
            valid_file_keys.add(key)

        lec["assignments"] = [
            a for a in lec["assignments"]
            if not (a.get("vswKey", "").startswith((f'{akey}|lit|', f'{akey}|mat|')))
            or a["vswKey"] in valid_file_keys
        ]

    # #181: hvilke klasser der fik mindst én OPGAVE denne kørsel, og hvilke nøgler. Samme vagt
    # som `touched` ovenfor: en klasse uden opgaver i denne kørsel kigges der ikke efter droppede
    # opgaver i — read_tasks() kan have fejlet for hele faget.
    touched_tasks: dict[str, set[str]] = {}

    # Afleveringsopgaver hænger på faget, ikke på en lektion — derfor klasse-niveau. De vises i
    # Hold Courses Assignments-liste og kalender uden at blive klistret på en tilfældig lektion.
    for task in sorted(tasks, key=lambda t: (t["fag"], t.get("deadline", ""))):
        if not task.get("deadline"):
            continue
        # Find det rigtige semester for denne opgave
        target_term_year = term_year_for_date(task["deadline"][:10])
        sem = term_year_to_sem.get(target_term_year)
        if not sem:
            # Fallback hvis término ikke er kendt
            sem = term_year_to_sem.get(next(iter(term_year_to_sem)))
            if not sem:
                continue

        cls = ensure_class(sem, task["fag"], new_id)
        relocate_stamped(data, "assignments", "vswKey", f'opgave|{task["_element_id"]}', cls)
        ensure_assignment(cls, f'opgave|{task["_element_id"]}', task["_title"], "Writing",
                          task["deadline"][:10], "", new_id, linked_note=task["_path"])
        touched_tasks.setdefault(cls["id"], set()).add(f'opgave|{task["_element_id"]}')  # #181

    # #173: lectures der er faldet ud af itslearning. Kun klasser i `touched` — en klasse der
    # slet ikke fik nogen plan denne kørsel springes over i stedet for at rapportere ALLE dens
    # lektioner som droppede (kunne lige så vel være en fetch-fejl for hele faget).
    if dropped_out is not None:
        for sem in data["semesters"]:
            for cls in sem.get("classes", []):
                seen = touched.get((sem["id"], cls["id"]))
                if not seen:
                    continue
                for lec in cls.get("lectures", []):
                    plan_id = lec.get("vswPlanId")
                    if plan_id and plan_id not in seen:
                        fag = cls.get("vswFag") or cls.get("name", "")
                        dropped_out.append(f'{fag} {lec.get("date", "")} {lec.get("title", "")}')

    # #181: de tre `ensure_*` der manglede #173's modstykke. Alle tre rapporterer kun.
    if report is not None:
        touched_sems = {sem_id for sem_id, _ in touched}
        touched_classes = {cls_id for _, cls_id in touched}

        for sem in data["semesters"]:
            if sem["id"] not in touched_sems:
                continue
            # Klasser: et fag der HELT er væk fra itslearning. Kun i et semester der ellers fik
            # planer — ellers ville hvert forgangent semester blive rapporteret ved hver kørsel.
            for cls in sem.get("classes", []):
                if cls["id"] not in touched_classes:
                    report.setdefault("dropped_classes", []).append(
                        f'{sem.get("name", "")}: {cls.get("vswFag") or cls.get("name", "")}')
                    continue
                # Afleveringsopgaver: modstykket til lectures' valid_file_keys, men rapporterende
                # frem for prunende — `status`/`grade` på en Writing-opgave er Valdemars fremdrift.
                seen_keys = touched_tasks.get(cls["id"])
                if not seen_keys:
                    continue
                for a in cls.get("assignments", []):
                    key = a.get("vswKey", "")
                    if key.startswith("opgave|") and key not in seen_keys:
                        report.setdefault("dropped_tasks", []).append(
                            f'{cls.get("vswFag") or cls.get("name", "")} '
                            f'{a.get("dueDate", "")} {a.get("title", "")}')

        orphaned = prune_stale_resource_classes(data, seen_res, touched_classes)
        if orphaned:
            report.setdefault("orphaned_resources", []).extend(orphaned)

    return data


def sync_task_completion(data: dict, vault_root: Path) -> list[str]:
    """Vault -> Hold Course: en Forberedelse krydset af DIREKTE i [NOTE]-stubben (uden om Hold
    Course) sætter opgaven til `done`. Returnerer opgaverne der blev markeret done.

    Hold Course -> itslearning går IKKE længere via denne funktion (#202, 2026-09-09). Indtil da
    skrev et Done-tryk i Hold Course et kryds ind i stubben, som background.js' checkbox-scanning
    (issue #70) så opdagede ved sin næste kørsel og postede til itslearning derfra — en
    mellemstation der kun var nødvendig fordi Hold Course endnu ikke fandtes da #70 blev bygget.
    Nu Hold Course ER den primære indgang, læser background.js selv `assignment.status` direkte i
    data.json (samme `|forb|`-nøgle) i stedet for at vente på at denne funktion skriver et kryds
    ind i en fil. Det ELIMINERER ikke checkboxen i noten — den forbliver #70's oprindelige,
    uafhængige vej: Valdemar kan stadig krydse direkte i noten uden om Hold Course, og DEN retning
    er hvad denne funktion nu udelukkende dækker.

    Uden denne retning ville alt Valdemar fuldfører direkte i vaulten (eller i selve itslearning,
    som #70's egen checkbox-scanning i så fald aldrig så) blive stående som "not started" i Hold
    Course — hvor det ophober sig som Overdue for evigt på både dashboardets Today-strip, i
    Assignments-listen og som rød pille i kalenderen (main.js: getAllAssignments filtrerer
    udelukkende på `status !== 'done'`). Rører KUN `not-started`: har Valdemar selv sat opgaven
    til `in-progress` i Hold Course, er det hans vurdering og ikke vores.

    Bindes på OPGAVE-niveau, ikke lektion (afklaret med Valdemar 2026-08-28): en lektion kan i
    princippet have flere forberedelses-opgaver, hver med sit eget itslearning-element/URL, så kun
    en per-opgave-binding rammer den rigtige. Nøglen er assignment.vswKey's "<lecture.id>|forb|
    <titel>"-form (samme titel background.js skrev linjen med, se writeLectureNoteStub).

    Går KUN mod fuldført, aldrig tilbage — samme retning som selve itslearning-synken, og derfor
    naturligt idempotent."""
    marked_done = []
    for sem in data.get("semesters", []):
        for cls in sem.get("classes", []):
            for lec in cls.get("lectures", []):
                stub_rel = lec.get("vswVaultLink") or lec.get("vaultLink")
                if not stub_rel:
                    continue
                file = vault_root / stub_rel
                if not file.exists():
                    continue
                text = None
                for assign in lec.get("assignments", []):
                    key = assign.get("vswKey", "")
                    if "|forb|" not in key:
                        continue
                    if assign.get("status") != "not-started":
                        continue
                    titel = key.split("|forb|", 1)[1]
                    if text is None:
                        text = file.read_text(encoding="utf-8")
                    checked_line = f"- [x] {FORBEREDELSE_PREFIX} {titel}"
                    if checked_line in text:
                        assign["status"] = "done"
                        marked_done.append(f"{titel} ({stub_rel})")
    return marked_done


def reconcile_onyx(onyx_path: Path, merged: dict, apply: bool, quiet: bool) -> None:
    """Propagerer den friske Mac-tilstand ind i Boox' egen data.json (issue #146).

    Boox' `.obsidian-onyx`-kopi bliver aldrig rørt af selve sync()-flowet, så
    `prune_dead_links()`s rettelser lander kun på Mac. `data.json` er nu rent
    indhold (semesters, currentSemesterId, dataVersion) og skal være identisk på
    de to enheder — så reconcilen er en lige indholds-kopi.

    De device-lokale felter (`einkMode`, `mobileScale`) bor efter hold-course#10
    (plugin-PR #28) i en separat `device-settings.json` som dette script aldrig
    rører — hver enheds `.obsidian`/`.obsidian-onyx` har sin egen. Derfor er den
    tidligere "bevar Boox' eget settings"-dans væk: en `settings`-nøgle der stadig
    ligger i en af `data.json`-kopierne er legacy og strippes her (pluginet fjerner
    den også selv ved næste load, jf. #28's `onExternalSettingsChange`).

    ponytail: `install.sh` symlinker Mac's main.js (altid nyeste), men Boox' kopi
    kræver et manuelt install.sh-kør + Syncthing-tur — Boox' pluginkode kan altså
    lagge bag Mac's. Reconcilen her tjekker ikke om Boox' kode faktisk forstår det
    skema den får. Bliver et reelt problem først hvis en fremtidig main.js-ændring
    laver et brydende skift i semesters/classes-formen; opgraderingsvejen er da
    at gate reconcile_onyx på en fælles skema-version pluginet selv skriver.
    """
    if not onyx_path.exists():
        return  # Boox-kopien findes ikke på denne maskine — intet at reconcilere
    onyx_before = onyx_path.read_text(encoding="utf-8")
    onyx_mtime = onyx_path.stat().st_mtime
    reconciled = {k: v for k, v in merged.items() if k != "settings"}
    onyx_after = json.dumps(reconciled, indent=2, ensure_ascii=False) + "\n"
    if onyx_after == onyx_before:
        return
    if not apply:
        if not quiet:
            print("Ville også reconcilere .obsidian-onyx/data.json (Boox) — dry-run.")
        return
    if onyx_path.stat().st_mtime != onyx_mtime:
        print("Boox' data.json ændrede sig undervejs — springer reconcile over, prøver igen næste kørsel.")
        return
    onyx_path.write_text(onyx_after, encoding="utf-8")
    if not quiet:
        print("Reconcileret .obsidian-onyx/data.json (Boox) — rent indhold, ingen settings-nøgle.")


# ─── _forløb.md: holdbarheds-spejl (issue #152) ───────────────────────────────
#
# En genereret markdown-serialisering af hvert forløb, så vault-mappen ALENE — uden Obsidian,
# uden Hold Course-pluginet — lader en læser rekonstruere hvad der skete i hvert fag. Ren
# envejs-serialisering af `merged`: ingen ny tilstand, aldrig læst tilbage (data.json forbliver
# autoritativ). Skrives kun når indholdet faktisk ændrede sig, så en minut-tick der intet
# ændrede ikke rører mtime og ikke afbryder Valdemar.

FORLOEB_HEADER = "> Genereret fil — rediger ikke; ret i Hold Course."


def iso_week(date: str) -> str:
    """"2026-08-12" -> "2026-W33". Samme ISO-uge-form som frontmatterens `uge:` (#154)."""
    try:
        y, w, _ = _date.fromisoformat(date[:10]).isocalendar()
        return f"{y}-W{w:02d}"
    except (ValueError, TypeError):
        return "—"


def enhed_from_link(link: str) -> str:
    """Enhedsnavnet fra en `§ FAG/<fag>/MD/<enhed>/<fil>`-sti (#150). "—" hvis stien ikke har
    formen (fx tom, eller Valdemars egen note et andet sted hen)."""
    parts = (link or "").split("/")
    if "MD" in parts:
        i = parts.index("MD")
        if i + 2 < len(parts):
            return parts[i + 1]
    return "—"


def _cell(text: str) -> str:
    return (text or "—").replace("|", "\\|").replace("\n", " ")


def render_forloeb(sem: dict, cls: dict, genereret: str) -> str:
    fag = cls.get("vswFag") or cls.get("name") or ""
    out = [
        "---", f"fag: {fag}", f"semester: {sem.get('name', '')}",
        f"genereret: {genereret}", "kilde: hold-course-sync", "---", "",
        FORLOEB_HEADER, "",
        "| dato | uge | enhed | titel | status | materialer | opgaver + frist |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for lec in sorted(cls.get("lectures", []), key=lambda l: (l.get("date", ""), l.get("title", ""))):
        readings, opgaver = [], []
        for a in lec.get("assignments", []):
            if a.get("type") == "Reading":
                tgt = a.get("linkedNote") or ""
                if tgt:
                    readings.append(f"[[{tgt}|{Path(tgt).stem}]]")
            else:
                due = a.get("dueDate", "")
                opgaver.append(f"{a.get('title', '')} — {due} ({a.get('status', '')})"
                               if due else f"{a.get('title', '')} ({a.get('status', '')})")
        row = [lec.get("date", ""), iso_week(lec.get("date", "")),
               enhed_from_link(lec.get("vaultLink") or lec.get("vswVaultLink") or ""),
               lec.get("title", ""), lec.get("status", ""),
               "<br>".join(dict.fromkeys(readings)), "<br>".join(opgaver)]
        out.append("| " + " | ".join(_cell(c) for c in row) + " |")

    if cls.get("assignments"):
        out += ["", "## Afleveringer (uden lektion)", "",
                "| titel | frist | status | note |", "| --- | --- | --- | --- |"]
        for a in sorted(cls["assignments"], key=lambda a: (a.get("dueDate", ""), a.get("title", ""))):
            note = a.get("linkedNote") or ""
            out.append("| " + " | ".join(_cell(c) for c in [
                a.get("title", ""), a.get("dueDate", ""), a.get("status", ""),
                f"[[{note}|{Path(note).stem}]]" if note else ""]) + " |")
    return "\n".join(out) + "\n"


def _strip_genereret(text: str) -> str:
    return re.sub(r"^genereret: .*$", "genereret:", text, count=1, flags=re.M)


def forloeb_path(vault_root: Path, sem: dict, cls: dict, multi: bool) -> Path | None:
    """`§ FAG/<fag>/_forløb.md`, eller `_HoldCourse/<semester>.md` når samme fag har klasser i
    flere semestre (Musik: rummet løber over årsskiftet, #125). None hvis fag-mappen ikke findes
    på denne maskine — spejlet hører hjemme ved siden af materialet, ikke i løs luft."""
    fag = cls.get("vswFag") or cls.get("name") or ""
    style = FAG_STYLE.get(fag)
    if not style:
        return None
    fag_dir = vault_root / "§ FAG" / f"{style['symbol']} {fag}"
    if not fag_dir.is_dir():
        return None
    if multi:
        return fag_dir / "_HoldCourse" / nfc(f"{sem.get('name', 'ukendt')}.md")
    return fag_dir / nfc("_forløb.md")


def write_forloeb_mirrors(data: dict, vault_root: Path, quiet: bool) -> int:
    genereret = time.strftime("%Y-%m-%dT%H:%M:%S")
    fag_count: dict[str, int] = {}
    for sem in data.get("semesters", []):
        for cls in sem.get("classes", []):
            fag = cls.get("vswFag") or cls.get("name") or ""
            fag_count[fag] = fag_count.get(fag, 0) + 1

    written = 0
    for sem in data.get("semesters", []):
        for cls in sem.get("classes", []):
            fag = cls.get("vswFag") or cls.get("name") or ""
            path = forloeb_path(vault_root, sem, cls, fag_count.get(fag, 0) > 1)
            if path is None:
                continue
            text = render_forloeb(sem, cls, genereret)
            if path.exists() and _strip_genereret(path.read_text(encoding="utf-8")) == _strip_genereret(text):
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            written += 1
    if written and not quiet:
        print(f"Skrev {written} _forløb.md (holdbarheds-spejl, issue #152).")
    return written


def sync(vault_root: Path, data_path: Path, apply: bool, quiet: bool = False) -> int:
    if not data_path.exists():
        print(f"Hold Course' data.json findes ikke ({data_path}) — er pluginet installeret?", file=sys.stderr)
        return 1

    patched = patch_pending_materiale(vault_root, apply)
    if patched and not quiet:
        label = "Rettet" if apply else "Ville rette (dry-run)"
        print(f"{label}: {len(patched)} lektionsplan-note(r) fik materiale_filer opdateret "
              f"(nye orphan-links, #141 / fremmede links fjernet, #183):")
        for rel in patched:
            print(f"  {rel}")

    plans, uden_plan_id = read_plans(vault_root)
    tasks = read_tasks(vault_root)
    before = data_path.read_text(encoding="utf-8")
    mtime = data_path.stat().st_mtime
    data = json.loads(before)

    # Skema-versions-vagt (#182 / hold-course#63). En data.json stemplet højere end vi
    # kender er skrevet af en nyere synk — et felt i den kan betyde noget denne kode ikke
    # forventer. Fail-loud: nægt at skrive (også ved --apply), i stedet for at flette ind i
    # felter hvis semantik kan have skiftet. Watch-loopet kalder hvert minut, så beskeden
    # gentages til nogen opgraderer scriptet; intet er ødelagt imens (vi returnerer før
    # enhver skrivning). Pluginets modstykke advarer men loader stadig — se KNOWN_DATA_VERSION.
    seen_version = data.get("dataVersion", 0)
    if isinstance(seen_version, int) and seen_version > KNOWN_DATA_VERSION:
        print(f"data.json er dataVersion {seen_version}, men dette script kender kun "
              f"{KNOWN_DATA_VERSION} — skrevet af en nyere synk. Springer over uden at skrive "
              f"(opgradér watchfolder/sync_hold_course.py).", file=sys.stderr)
        return 1

    dropped: list[str] = []
    report: dict[str, list[str]] = {}
    merged = sync_data(data, plans, tasks=tasks, dropped_out=dropped, report=report)
    # FØR serialiseringen: vault -> Hold Course-retningen sætter status på opgaver i `merged`, og
    # de ændringer skal med i den data.json vi sammenligner og skriver.
    marked_done = sync_task_completion(merged, vault_root)
    removed_res, removed_assign = prune_dead_links(merged, vault_root)
    after = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"

    if uden_plan_id and not quiet:
        print(f"{len(uden_plan_id)} lektionsplan-note(r) uden plan_id springes over "
              f"(ældre end issue #96, kan ikke matches sikkert — ret dem i vaulten):")
        for rel in uden_plan_id:
            print(f"  {rel}")

    # #173: rapporteres uanset apply/dry-run — intet slettes, kun nævnes, så det er ikke gated
    # på "label" på samme måde som de skrivende blokke nedenfor.
    if dropped and not quiet:
        print(f"{len(dropped)} lektion(er) i data.json er ikke længere i itslearning:")
        for d in dropped:
            print(f"  {d}")

    # #181: samme rapportér-frem-for-slet-linje for de tre øvrige ensure_*.
    for key, overskrift in (
        ("dropped_classes", "fag i data.json fik ingen lektioner i et ellers aktivt semester"),
        ("dropped_tasks", "afleveringsopgave(r) i data.json er ikke længere i itslearning"),
        ("orphaned_resources", "materiale(r) i Library bruges ikke længere af nogen klasse"),
    ):
        if report.get(key) and not quiet:
            print(f"{len(report[key])} {overskrift}:")
            for line in report[key]:
                print(f"  {line}")

    # Rapporteres UANSET om data.json selv skal genskrives: en linje krydset direkte i vaulten
    # (uden om Hold Course) skal give udslag ved næste tick, ikke først når en lektionsplan-note
    # tilfældigvis ændrer sig.
    if marked_done and not quiet:
        label = "Markeret Done i Hold Course" if apply else "Ville markere Done i Hold Course (dry-run)"
        print(f"{label}: {len(marked_done)} Forberedelse-opgave(r) allerede krydset af i vaulten:")
        for titel in marked_done:
            print(f"  {titel}")
    if (removed_res or removed_assign) and not quiet:
        label = "Ryddet op" if apply else "Ville rydde op (dry-run)"
        print(f"{label}: {removed_res} død(e) Library-post(er), {removed_assign} død(e) opgave(r) "
              f"(pegede på filer der ikke længere findes).")

    # Kører uanset om Mac's egen data.json ændrede sig denne omgang: Boox kan sagtens sakke
    # bagud fra en TIDLIGERE kørsel (før dette reconcile-trin fandtes, eller efter en fejlet
    # Syncthing-tur), og det retter sig ikke af sig selv bare fordi Mac er ajour lige nu.
    reconcile_onyx(ONYX_DATA_JSON, merged, apply, quiet)

    # Holdbarheds-spejlet (#152). Skrives uanset om data.json ændrede sig denne tick — helt som
    # reconcile_onyx ovenfor: en tidligere kørsel (eller en ny/omdøbt enhedsmappe) kan have
    # efterladt et spejl bagud, og content-sammenligningen inde i funktionen gør en no-op-tick
    # gratis. Kun ved --apply; dry-run rører ingen filer.
    if apply:
        write_forloeb_mirrors(merged, vault_root, quiet)
    elif not quiet:
        print("Ville også skrive _forløb.md holdbarheds-spejl (dry-run).")

    if after == before:
        # Watch-scriptet kalder denne funktion hvert minut; uden quiet ville loggen fyldes med
        # "allerede opdateret" og skjule de kørsler der reelt skete noget i.
        if not quiet:
            print(f"{len(plans)} lektionsplan-noter — Hold Course er allerede opdateret.")
        return 0

    # Rapportér statistik på tværs af alle semestre (ikke kun ét)
    total_classes = 0
    total_lectures = 0
    total_assignments = 0
    total_resources = 0
    for sem in data.get("semesters", []):
        total_classes += len(sem.get("classes", []))
        total_lectures += sum(len(c.get("lectures", [])) for c in sem.get("classes", []))
        total_assignments += sum(len(l.get("assignments", [])) for c in sem.get("classes", []) for l in c.get("lectures", [])) \
            + sum(len(c.get("assignments", [])) for c in sem.get("classes", []))
        total_resources += len(sem.get("resources", []))

    print(f"{len(plans)} lektionsplan-noter + {len(tasks)} opgave-noter -> {total_classes} fag, "
          f"{total_lectures} lektioner, {total_assignments} opgaver, {total_resources} Library-poster.")

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
    # Ingen reload-kald: pluginets onExternalSettingsChange henter den selv (#198).
    print("Skrevet. Hold Course henter den selv (onExternalSettingsChange).")
    return 0


def init_semesters_retroactively(data_path: Path, from_year_month: str = "2024-07") -> int:
    """Opretter semestre retroaktivt fra angivet måned til nu, uden at røre lektioner.
    Bruges til at få plads til gamle ressourcer længere ned.
    Eksempel: python sync_hold_course.py --init-semesters 2024-07"""
    from datetime import datetime

    if not data_path.exists():
        print(f"data.json findes ikke ({data_path})", file=sys.stderr)
        return 1

    data = json.loads(data_path.read_text(encoding="utf-8"))
    data.setdefault("semesters", [])

    # Parse start-dato
    try:
        start_year, start_month = map(int, from_year_month.split("-"))
    except ValueError:
        print(f"Ugyldigt format: {from_year_month} (brug YYYY-MM, fx 2024-07)", file=sys.stderr)
        return 1

    # Generér alle semestre fra start til nu
    now_year, now_month = datetime.now().year, datetime.now().month
    counter = [0]
    new_id = lambda: generate_id(counter)

    created = []
    for year in range(start_year, now_year + 1):
        for month_start in [1, 7]:  # Forår (1) og Efterår (7)
            if (year, month_start) < (start_year, start_month):
                continue
            if (year, month_start) > (now_year, now_month):
                continue

            term = "Fall" if month_start >= 7 else "Spring"
            name = semester_name_for_term_year(term, year)

            # Check om semester allerede findes
            existing = next((s for s in data["semesters"]
                            if s.get("term") == term and s.get("year") == year), None)
            if existing:
                continue

            # Opret nyt semester
            sem = {
                "id": new_id(),
                "name": name,
                "term": term,
                "year": year,
                "classes": [],
                "resources": []
            }
            data["semesters"].append(sem)
            created.append(name)

    if not created:
        print(f"Alle semestre fra {from_year_month} til nu findes allerede.")
        return 0

    # Skriv tilbage
    before = data_path.read_text(encoding="utf-8")
    after = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    if after == before:
        print("Ingen ændringer.")
        return 0

    data_path.write_text(after, encoding="utf-8")
    print(f"Oprettet {len(created)} semester(e):")
    for name in created:
        print(f"  ✓ {name}")
    return 0


def main() -> int:
    if "--init-semesters" in sys.argv:
        idx = sys.argv.index("--init-semesters")
        from_date = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else "2024-07"
        return init_semesters_retroactively(DATA_JSON, from_date)
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

    # ── _forløb.md holdbarheds-spejl (#152) — kørt her, før den pre-eksisterende #139-assertion
    #    nedenfor, så en fejl herfra ikke maskeres af den. ────────────────────────────────────
    fl_sem = {"name": "Efterår 2026"}
    fl_cls = {"vswFag": "Musik", "name": "Musik", "lectures": [
        {"date": "2026-09-01", "title": "Musikforståelse", "status": "in-progress",
         "vaultLink": "§ FAG/♪ Musik/MD/Musikforståelse/[PLAN] 2026-09-01 - Musikforståelse.md",
         "assignments": [
             {"type": "Reading", "title": "Frede V Nielsen", "dueDate": "2026-09-01",
              "status": "not-started", "linkedNote": "§ FAG/♪ Musik/MD/Musikforståelse/Frede V Nielsen.md"},
             {"type": "Preparation", "title": "Forberedelse", "dueDate": "2026-09-01", "status": "done",
              "linkedNote": "§ FAG/♪ Musik/NOTER/2026-09-01/[NOTE] 2026-09-01.md"}]},
        {"date": "2026-08-25", "title": "Intro", "status": "done", "vaultLink": "", "assignments": []},
    ], "assignments": [
        {"title": "Studieopgave", "dueDate": "2026-09-28", "status": "not-started",
         "linkedNote": "✎ NOTER/OPGAVER/Studieopgave/Studieopgave.md"}]}
    fl_text = render_forloeb(fl_sem, fl_cls, "2026-09-03T10:00:00")
    assert "fag: Musik" in fl_text and "kilde: hold-course-sync" in fl_text, fl_text
    assert FORLOEB_HEADER in fl_text, fl_text
    lines_fl = fl_text.splitlines()
    # Lektionerne står kronologisk, ikke i input-rækkefølge.
    i_intro = next(i for i, l in enumerate(lines_fl) if "| Intro |" in l)
    i_musik = next(i for i, l in enumerate(lines_fl) if "Musikforståelse" in l and l.startswith("| 2026-09-01"))
    assert i_intro < i_musik, fl_text
    row = lines_fl[i_musik]
    assert "2026-W36" in row, row                      # ISO-uge udledt af datoen
    assert "| Musikforståelse |" in row, row           # enhed udledt af MD/<enhed>/-leddet
    assert "[[§ FAG/♪ Musik/MD/Musikforståelse/Frede V Nielsen.md\\|Frede V Nielsen]]" in row, row
    assert "Forberedelse — 2026-09-01 (done)" in row, row
    assert "## Afleveringer (uden lektion)" in fl_text and "Studieopgave" in fl_text, fl_text
    # Kun timestampet skifter mellem to kørsler -> _strip_genereret gør dem ens (mtime-venligt).
    assert _strip_genereret(fl_text) == _strip_genereret(render_forloeb(fl_sem, fl_cls, "2099-01-01T00:00:00"))
    assert iso_week("") == "—" and enhed_from_link("") == "—"

    # note_stub_path() slår op i den ægte VAULT_ROOT for at afgøre om [NOTE]-stubben findes på disk.
    # Her testes kun at vaultLink peger på stub-FORMEN (MD->NOTER, [PLAN]->[NOTE]) — uafhængigt af
    # hvad der tilfældigvis ligger i vaulten. Fallback-grenen ('findes ikke -> selve planen') testes
    # separat via _real_note_stub_path længere nede.
    _real_note_stub_path = note_stub_path
    globals()["note_stub_path"] = lambda p: p.replace("/MD/", "/NOTER/").replace("[PLAN] ", "[NOTE] ")

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
    forb = next(a for a in lec["assignments"] if a["type"] == "Preparation")
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

    # En lektion der allerede sidder i et FORKERT semester (fra tiden før #126) flyttes til det
    # rigtige i stedet for at blive duplikeret — live-fundet #146: 66 Musik-lektioner tilbage til
    # 2025 stod stadig i Efterår 2026 OVENI de nyoprettede kopier i deres rigtige semestre.
    stale_plan = dict(fm, start="2025-08-13 08:15:00", _path="§ FAG/♪ Musik/MD/Musikforståelse/[PLAN] W33ons.md")
    ids_stale = iter(f"stale{n}" for n in range(100))
    data_stale = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2},
                           [stale_plan], lambda: next(ids_stale))
    wrong_sem = data_stale["semesters"][0]
    assert wrong_sem["term"] == "Fall" and wrong_sem["year"] == 2025, wrong_sem
    ny_plan = dict(fm, _path=stale_plan["_path"])  # samme plan_id, dato tilbage i "Efterår 2026" (fm's egen 2026-09-01)
    data_stale = sync_data(data_stale, [ny_plan], lambda: "MÅ-IKKE-BRUGES")
    assert len(data_stale["semesters"]) == 2, data_stale["semesters"]
    all_lectures = [l for s in data_stale["semesters"] for c in s["classes"] for l in c["lectures"]]
    assert len(all_lectures) == 1, "lektionen blev duplikeret på tværs af semestre"
    assert data_stale["semesters"][1]["classes"][0]["lectures"][0]["date"] == "2026-09-01"
    assert data_stale["semesters"][0]["classes"][0]["lectures"] == [], "gammel semester skal tømmes"

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
    # #202 (2026-09-09): funktionen skriver ikke længere ind i noten — Hold Course -> itslearning
    # går nu via background.js, som læser data.json direkte. Kun vault -> Hold Course (en linje
    # krydset af DIREKTE i noten, uden om Hold Course) testes her.
    stub_dir = Path(tempfile.mkdtemp())
    stub_path = stub_dir / "stub.md"
    stub_path.write_text(
        "---\ntype: note\n---\n\n## ⚒ Forberedelse\n"
        "- [x] ⚒ Forberedelse\n- [ ] ⚒ Læs kapitel 2\n", encoding="utf-8")
    rel = str(stub_path.relative_to(stub_dir.parent))
    lec_tc = {"id": "L1", "vaultLink": rel, "assignments": [
        {"vswKey": "L1|forb|Forberedelse", "status": "not-started"},
        {"vswKey": "L1|forb|Læs kapitel 2", "status": "not-started"},
        {"vswKey": "L1|lit|nogetandet", "status": "not-started"},  # ikke forberedelse — må ikke røres
        {"vswKey": "L1|forb|Eget tempo", "status": "in-progress"},  # Valdemars egen vurdering, røres ikke
    ]}
    data_tc = {"semesters": [{"classes": [{"lectures": [lec_tc]}]}]}
    marked = sync_task_completion(data_tc, stub_dir.parent)
    assert marked == [f"Forberedelse ({rel})"], marked
    assert lec_tc["assignments"][0]["status"] == "done", lec_tc["assignments"][0]
    assert lec_tc["assignments"][1]["status"] == "not-started", lec_tc["assignments"][1]  # ikke krydset endnu
    assert lec_tc["assignments"][2]["status"] == "not-started", lec_tc["assignments"][2]  # ikke forberedelse
    assert lec_tc["assignments"][3]["status"] == "in-progress", lec_tc["assignments"][3]
    assert sync_task_completion(data_tc, stub_dir.parent) == [], "idempotent: intet mere at markere"

    # Krydses linjen af bagefter (Valdemar, eller extensionen efter en itslearning-synk), fanger
    # næste kørsel den.
    stub_path.write_text(
        "---\ntype: note\n---\n\n## ⚒ Forberedelse\n"
        "- [x] ⚒ Forberedelse\n- [x] ⚒ Læs kapitel 2\n", encoding="utf-8")
    marked2 = sync_task_completion(data_tc, stub_dir.parent)
    assert marked2 == [f"Læs kapitel 2 ({rel})"], marked2
    assert lec_tc["assignments"][1]["status"] == "done", lec_tc["assignments"][1]
    assert sync_task_completion(data_tc, stub_dir.parent) == []

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

    # #172: beskrivelse: lander i lec.description (synkens), aldrig i lec.notes (Valdemars).
    plan_b = dict(plan, beskrivelse="I dag arbejder vi med resonansbegrebet.")
    ids7 = iter(f"g{n}" for n in range(100))
    data7 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan_b], lambda: next(ids7))
    lec7 = data7["semesters"][0]["classes"][0]["lectures"][0]
    assert lec7["description"] == "I dag arbejder vi med resonansbegrebet.", lec7
    assert lec7["notes"] == "", lec7
    assert "vswNotes" not in lec7, lec7

    # Valdemars egne noter og undervisernes opdatering lever side om side: hverken clobber den
    # anden. Det var netop det lec.notes ikke kunne, da de delte felt.
    lec7["notes"] = "Mine egne stikord til timen"
    plan_b2 = dict(plan_b, beskrivelse="Underviseren har opdateret beskrivelsen.")
    data7 = sync_data(data7, [plan_b2], lambda: "MÅ-IKKE-BRUGES")
    lec7 = data7["semesters"][0]["classes"][0]["lectures"][0]
    assert lec7["notes"] == "Mine egne stikord til timen", lec7
    assert lec7["description"] == "Underviseren har opdateret beskrivelsen.", lec7

    # Et bevidst tømt notes-felt (hold-course#5b flytter noten ud i en fil og rydder feltet)
    # refyldes ALDRIG — bug'en der udløste #172.
    lec7["notes"] = ""
    data7 = sync_data(data7, [plan_b2], lambda: "MÅ-IKKE-BRUGES")
    assert data7["semesters"][0]["classes"][0]["lectures"][0]["notes"] == "", data7

    # #205: forberedelse_tekst lander i SAMME description-felt som beskrivelse, adskilt med en
    # skillelinje — ikke et nyt felt, ingen main.js-ændring nødvendig (MarkdownRenderer.render
    # tegner den bare som mere tekst i den eksisterende "Lesson Description"-boks).
    plan_c = dict(plan, beskrivelse="Formål: dagens tema.", forberedelse_tekst="Læs kapitel 3.")
    data_c = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan_c], lambda: "c0")
    lec_c = data_c["semesters"][0]["classes"][0]["lectures"][0]
    assert lec_c["description"] == (
        "Formål: dagens tema.\n\n---\n\n**Forberedelse**\n\nLæs kapitel 3."
    ), lec_c["description"]

    # Kun forberedelse_tekst, intet beskrivelse: ingen tom skillelinje foran.
    plan_d = dict(plan, beskrivelse="false", forberedelse_tekst="Medbring noder.")
    data_d = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan_d], lambda: "d0")
    lec_d = data_d["semesters"][0]["classes"][0]["lectures"][0]
    assert lec_d["description"] == "**Forberedelse**\n\nMedbring noder.", lec_d["description"]

    # Ingen af delene: som før #205, feltet rørt slet ikke (samme "if description:"-guard som
    # "if beskrivelse:" altid har haft — starter tomt fra ensure_lecture()'s egen initialisering).
    plan_e = dict(plan, beskrivelse="false", forberedelse_tekst="false")
    data_e = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [plan_e], lambda: "e0")
    lec_e = data_e["semesters"][0]["classes"][0]["lectures"][0]
    assert lec_e["description"] == "", lec_e
    assert "vswDescription" not in lec_e, lec_e

    # Engangs-migrering: uredigeret notes (== vswNotes) flyttes til description og ryddes;
    # redigeret notes bliver stående; stemplet forsvinder i begge tilfælde. Kører også på en
    # lektion der er faldet ud af itslearning (ikke i plan-sættet).
    gammel = {"semesters": [{"id": "s", "classes": [{"id": "c", "lectures": [
        {"id": "l1", "notes": "Undervisernes tekst", "vswNotes": "Undervisernes tekst"},
        {"id": "l2", "notes": "Mine egne noter", "vswNotes": "Undervisernes tekst"},
        {"id": "l3", "notes": "", "vswNotes": "Undervisernes tekst"},
    ]}]}]}
    assert migrate_notes_to_description(gammel) == 1, gammel
    l1, l2, l3 = gammel["semesters"][0]["classes"][0]["lectures"]
    assert l1["notes"] == "" and l1["description"] == "Undervisernes tekst", l1
    assert l2["notes"] == "Mine egne noter" and "description" not in l2, l2
    assert l3["notes"] == "", l3  # bevidst tømt: ikke migreret, ikke refyldt
    assert not any("vswNotes" in lec for lec in gammel["semesters"][0]["classes"][0]["lectures"]), gammel
    assert migrate_notes_to_description(gammel) == 0, gammel  # idempotent

    # #173: en lecture der falder ud af itslearning rapporteres, slettes aldrig.
    plan_b = dict(plan, plan_id="36016:9990002", uge="W36ons", emne="Anden lektion",
                  start="2026-09-02 12:25:00", stop="2026-09-02 15:45:00")
    ids10 = iter(f"h{n}" for n in range(100))
    data10 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2},
                       [plan, plan_b], lambda: next(ids10))
    assert len(data10["semesters"][0]["classes"][0]["lectures"]) == 2, data10

    # Næste kørsel: kun plan_b kommer stadig igennem — plan er faldet ud af itslearning.
    dropped10: list[str] = []
    data10 = sync_data(data10, [plan_b], lambda: "MÅ-IKKE-BRUGES", dropped_out=dropped10)
    lecs10 = data10["semesters"][0]["classes"][0]["lectures"]
    assert len(lecs10) == 2, lecs10  # INTET slettet
    assert len(dropped10) == 1 and "Musikforståelse" in dropped10[0], dropped10

    # En gentaget kørsel med samme (mangelfulde) plan-sæt rapporterer den droppede igen — ikke
    # kun ved selve overgangen. Rapportér-ikke-slet er en tilstand, ikke en engangshændelse.
    dropped10b: list[str] = []
    data10 = sync_data(data10, [plan_b], lambda: "MÅ-IKKE-BRUGES", dropped_out=dropped10b)
    assert len(dropped10b) == 1, dropped10b

    # Fag der slet ikke fik nogen plan denne kørsel (kunne være en fetch-fejl for hele faget) —
    # INGEN af dens lektioner må rapporteres som droppede. Andet fag, ingen Musik-planer overhovedet.
    andet_fag = dict(plan, fag="Dansk", plan_id="99999:1", uge="W40man",
                     start="2026-09-28 09:00:00", stop="2026-09-28 10:00:00")
    dropped10c: list[str] = []
    data10 = sync_data(data10, [andet_fag], lambda: "MÅ-IKKE-BRUGES", dropped_out=dropped10c)
    assert dropped10c == [], dropped10c  # Musik blev slet ikke rørt denne kørsel — ikke en fejl

    # dropped_out er valgfri (default None) — eksisterende kald uden parameteren er upåvirkede.
    data10_noargs = sync_data(dict(data10), [plan_b])
    assert len(data10_noargs["semesters"][0]["classes"][0]["lectures"]) == 2, data10_noargs

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

    # #221: fallback-afledt materiale (ikke i plan["_owned"]) giver kun én Reading-opgave pr. klasse,
    # på den tidligste lektion; beviseligt ejet materiale giver opgave på sin egen lektion.
    tgt221 = "§ FAG/♱ Religion/MD/Enhed/Tekst.md"
    def _p221(pid, day, owned):
        d = dict(plan, plan_id=pid, fag="Religion", litteratur="false", litteratur_filer="false",
                 forberedelse="false", materiale_filer=f"📎 [[{tgt221}]]", start=f"2026-09-{day} 09:00:00",
                 stop=f"2026-09-{day} 10:00:00", _path=f"§ FAG/♱ Religion/MD/Enhed/[PLAN] {day}.md")
        if owned is not None:
            d["_owned"] = owned
        return d
    def _reads(dat):
        lecs = sorted(dat["semesters"][0]["classes"][0]["lectures"], key=lambda l: l["date"])
        return [len([a for a in l["assignments"] if a["type"] == "Reading"]) for l in lecs]
    ids7 = iter(f"g{n}" for n in range(500))
    # Før (ingen _owned): alle tre får opgaven — som før #221.
    data7 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2},
                      [_p221("7:1", "22", None), _p221("7:2", "15", None), _p221("7:3", "29", None)],
                      lambda: next(ids7))
    assert _reads(data7) == [1, 1, 1], _reads(data7)
    # Efter: ingen har bevis -> kun den tidligste (15.) beholder opgaven; de andre ryddes.
    data7 = sync_data(data7, [_p221("7:1", "22", []), _p221("7:2", "15", []), _p221("7:3", "29", [])],
                      lambda: next(ids7))
    assert _reads(data7) == [1, 0, 0], _reads(data7)
    # Idempotent.
    snap7 = json.dumps(data7, sort_keys=True)
    assert json.dumps(sync_data(json.loads(snap7), [_p221("7:1", "22", []), _p221("7:2", "15", []),
                                                    _p221("7:3", "29", [])], lambda: "MÅ-IKKE-BRUGES"),
                      sort_keys=True) == snap7
    # Den 29. har BEVIS for teksten -> får sin egen opgave (den 22. er stadig kun fallback).
    data7 = sync_data(data7, [_p221("7:1", "22", []), _p221("7:2", "15", []), _p221("7:3", "29", [tgt221])],
                      lambda: next(ids7))
    assert _reads(data7) == [1, 0, 1], _reads(data7)

    # #176-følgeskade: forsvinder en fil fra materiale_filer igen (fx efter en dedupe-oprydning
    # af en tidligere krydslink-fejl), skal den tilhørende Reading-opgave forsvinde med — ikke
    # blive stående for evigt, som ensure_assignment alene ville gøre (den opretter/opdaterer,
    # sletter aldrig selv).
    data6b = sync_data(json.loads(json.dumps(data6)), [dict(plan, plan_id="9:10", _path=baade["_path"])],
                       lambda: "MÅ-IKKE-BRUGES")
    lec6b = data6b["semesters"][0]["classes"][0]["lectures"][0]
    titles6b = sorted(a["title"] for a in lec6b["assignments"] if a["type"] == "Reading")
    assert titles6b == ["Frede V Nielsen Ars og Scientia"], titles6b

    # issue #118/#124/hold-course#41: tid/lokale/underviser er kun sat på lektionen når det
    # AFVIGER fra klassens standard — hhmm() slår "10:00" ud af det fulde datetime-felt.
    assert hhmm("2026-08-17 10:00:00") == "10:00"
    assert hhmm("") == "" and hhmm("2026-08-17") == ""

    afvig = dict(plan, plan_id="9:11", lokale="B204", underviser="Klaus Glüsing",
                 _path="§ FAG/♪ Musik/MD/x/[PLAN] x.md")
    ids7 = iter(f"g{n}" for n in range(100))
    data7 = sync_data({"currentSemesterId": None, "semesters": [], "dataVersion": 2}, [afvig], lambda: next(ids7))
    cls7 = data7["semesters"][0]["classes"][0]
    lec7 = cls7["lectures"][0]
    # Klassens standard er tom -> alt fra itslearning tæller som afvigelse og skrives ind.
    assert lec7["meetingStartTime"] == "12:25" and lec7["meetingEndTime"] == "15:45", lec7
    assert lec7["location"] == "B204" and lec7["professorName"] == "Klaus Glüsing", lec7

    # Sætter klassens standard til PRÆCIS samme værdier -> næste synk rydder lektionens
    # eksplicitte felter (ingen reel afvigelse tilbage, skal arve igen).
    cls7["meetingStartTime"], cls7["meetingEndTime"] = "12:25", "15:45"
    cls7["location"], cls7["professorName"] = "B204", "Klaus Glüsing"
    data7b = sync_data(data7, [afvig], lambda: "MÅ-IKKE-BRUGES")
    lec7b = data7b["semesters"][0]["classes"][0]["lectures"][0]
    assert lec7b["meetingStartTime"] == "" and lec7b["meetingEndTime"] == "", lec7b
    assert lec7b["location"] == "" and lec7b["professorName"] == "", lec7b

    # Valdemar retter selv lec.location i Hold Course (stemplet matcher ikke længere) -> synken
    # rører den aldrig igen, heller ikke når itslearning senere afviger fra klassen igen.
    lec7b["location"] = "Valdemars eget valg"
    data7c = sync_data(data7b, [afvig], lambda: "MÅ-IKKE-BRUGES")
    assert data7c["semesters"][0]["classes"][0]["lectures"][0]["location"] == "Valdemars eget valg"

    # Findes stubben ikke, falder vi tilbage til selve planen
    # Findes stubben ikke, falder vi tilbage til selve planen frem for et dødt link.
    globals()["note_stub_path"] = _real_note_stub_path
    assert note_stub_path("findes/slet/ikke/MD/x/[PLAN] x.md") == "findes/slet/ikke/MD/x/[PLAN] x.md"

    # #209: NOTER-mappen er enhed-grupperet ligesom MD/ (ikke længere én mappe pr. lektion) —
    # mappenavnet genbruges direkte fra MD/<enhed>/-leddet, mens FILNAVNET stadig er weekFolder
    # ("<dato> - <emne>"). Reproducerer mod en rigtig fil, ikke kun en mocket streng-form.
    vault_root_orig = globals()["VAULT_ROOT"]
    tmp_vault = Path(tempfile.mkdtemp())
    try:
        globals()["VAULT_ROOT"] = tmp_vault
        note_dir = tmp_vault / "§ FAG" / "♱ Religion" / "NOTER" / "Hvad er religion_"
        note_dir.mkdir(parents=True)
        (note_dir / "[NOTE] 2026-09-09 - Hvad er religion_.md").write_text("Kilde: [[x]]", encoding="utf-8")
        plan_delt_mappe = (
            "§ FAG/♱ Religion/MD/Hvad er religion_/[PLAN] 2026-09-09 - Hvad er religion_.md"
        )
        assert note_stub_path(plan_delt_mappe) == (
            "§ FAG/♱ Religion/NOTER/Hvad er religion_/[NOTE] 2026-09-09 - Hvad er religion_.md"
        ), note_stub_path(plan_delt_mappe)
        # En SØSTER-lektion om samme emne (samme MD-mappe, anden dato) har sin egen stub-FIL i
        # samme mappe — ikke den vi lige oprettede — og skal derfor falde tilbage til [PLAN], ikke
        # fejlagtigt matche naboens stub.
        soester_plan = (
            "§ FAG/♱ Religion/MD/Hvad er religion_/[PLAN] 2026-09-11 - Hvad er religion_.md"
        )
        assert note_stub_path(soester_plan) == soester_plan, note_stub_path(soester_plan)
    finally:
        globals()["VAULT_ROOT"] = vault_root_orig

    # `false`-felter og dublet-noter giver ingenting.
    assert prefixed_lines("false", "▥") == []
    assert parse_frontmatter("---\ntype: dublet\nplan_id: \"1:1\"\n---\n")["type"] == "dublet"

    # ── #181: de tre ensure_*-modstykker der manglede (#173 dækkede kun lectures) ──────────
    # Kørsel 1 bygger tilstanden; kørsel 2 fjerner ét fag, én opgave og ét materiale fra
    # itslearning-siden og skal rapportere alle tre — uden at slette noget.
    p_mus = {"fag": "Musik", "plan_id": "1:1", "start": "2026-09-01 10:00:00",
             "emne": "Musikforståelse", "type": "lektionsplan",
             "_path": "§ FAG/♪ Musik/MD/Musikforståelse/[PLAN] 2026-09-01 - Musikforståelse.md",
             "materiale_filer": "📎 [[§ FAG/♪ Musik/MD/Musikforståelse/A.md]]"}
    p_rel = {"fag": "Religion", "plan_id": "2:2", "start": "2026-09-02 10:00:00",
             "emne": "Intro", "type": "lektionsplan",
             "_path": "§ FAG/♱ Religion/MD/Intro/[PLAN] 2026-09-02 - Intro.md"}
    t_op = {"fag": "Musik", "deadline": "2026-09-30", "_element_id": "E1",
            "_title": "Studieopgave", "_path": "✎ NOTER/OPGAVER/Studieopgave.md"}
    t_bliver = {"fag": "Musik", "deadline": "2026-10-30", "_element_id": "E2",
                "_title": "Eksamen", "_path": "✎ NOTER/OPGAVER/Eksamen.md"}
    ids2 = iter(f"n{n}" for n in range(200))
    d181 = sync_data({"semesters": [], "dataVersion": 2}, [p_mus, p_rel],
                     lambda: next(ids2), tasks=[t_op, t_bliver])
    rep: dict[str, list[str]] = {}
    # Kørsel 2: Religion helt væk, Studieopgave væk (men Eksamen består, så klassen ER "rørt"
    # og et drop kan skelnes fra en fejlet read_tasks), og A.md ikke længere på planen.
    sync_data(d181, [dict(p_mus, materiale_filer="")], lambda: next(ids2),
              tasks=[t_bliver], report=rep)
    assert any("Religion" in x for x in rep.get("dropped_classes", [])), rep
    assert not any("Musik" in x for x in rep.get("dropped_classes", [])), \
        ("Musik fik planer og må ikke rapporteres som droppet", rep)
    assert any("Studieopgave" in x for x in rep.get("dropped_tasks", [])), rep
    assert not any("Eksamen" in x for x in rep.get("dropped_tasks", [])), \
        ("stadig-eksisterende opgave rapporteret som droppet", rep)
    assert any("A.md" in x for x in rep.get("orphaned_resources", [])), rep
    # Intet slettet — kun rapporteret. Resourcen står stadig i Library med Valdemars felter.
    sem181 = next(x for x in d181["semesters"] if x.get("resources"))
    assert any("A.md" in r.get("vaultLink", "") for r in sem181["resources"]), sem181["resources"]
    assert len(sem181["classes"]) == 2, "en klasse blev slettet i stedet for rapporteret"
    assert all(r["classIds"] == [] for r in sem181["resources"] if "A.md" in r["vaultLink"]), \
        ("classIds krympede ikke — #181's voksende-kun-bug er tilbage", sem181["resources"])
    # Ingen tasks i kørslen => ingen opgave-rapport (kunne være en fejlet read_tasks, ikke et drop).
    rep2: dict[str, list[str]] = {}
    sync_data(d181, [p_mus], lambda: "MÅ-IKKE-BRUGES2", tasks=[], report=rep2)
    assert not rep2.get("dropped_tasks"), ("opgave rapporteret uden opgave-kørsel", rep2)

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

    # #217/#218: en type: dublet-pointernote i mappen er ikke materiale og må ikke linkes ind.
    pointer = week_dir / "2026-08-20 - Titel lektionsplan.md"
    pointer.write_text("---\ntype: dublet\nnote: \"[[Ny-fil]]\"\n---\n", encoding="utf-8")
    assert patch_pending_materiale(patch_root, apply=True) == [], "dublet-pointer blev linket ind"
    pointer.unlink()

    # #208: ren forberedelsesdag arver ikke orphans; almindelig lektion og forberedelsesdag MED
    # egen forberedelse_tekst gør.
    prep_dir = patch_root / "§ FAG" / "♱ Religion" / "MD" / "Forberedelse"
    prep_dir.mkdir(parents=True)
    def _plan(name, pid, beskr, forb):
        (prep_dir / f"[PLAN] {name}.md").write_text(
            f"---\ntype: lektionsplan\nfag: Religion\nplan_id: \"{pid}\"\n"
            f"beskrivelse: {beskr}\nforberedelse_tekst: {forb}\n"
            "materiale_filer: false\n---\n\n<!-- AUTO:START -->\n# T\n<!-- AUTO:END -->\n",
            encoding="utf-8")
    _plan("2026-09-18 - X", "1", "Vi gennemgår kapitel 3.", "false")
    _plan("2026-09-23 - X", "2", "I dag er sat af til at I kan forberede jer til næste gang.", "false")
    _plan("2026-09-24 - X", "3", "I dag er sat af til forberedelse.", "Læs kapitel 4.")
    (prep_dir / "Tekst.md").write_text("noget", encoding="utf-8")
    got = sorted(Path(x).name for x in patch_pending_materiale(patch_root, apply=True) if "Forberedelse" in x)
    assert got == ["[PLAN] 2026-09-18 - X.md", "[PLAN] 2026-09-24 - X.md"], got
    assert "Tekst.md" not in (prep_dir / "[PLAN] 2026-09-23 - X.md").read_text(encoding="utf-8")
    assert _is_prep_day({"beskrivelse": "I dag er sat af til forberedelse", "forberedelse_tekst": "false"})
    assert not _is_prep_day({"beskrivelse": "Vi læser", "forberedelse_tekst": "false"})
    assert not _is_prep_day({"beskrivelse": "sat af til forberedelse", "forberedelse_tekst": "Læs s. 3"})
    import shutil; shutil.rmtree(prep_dir)  # senere tests tæller alle planer i patch_root

    # issue #158: delt enhedsmappe — søskende-[PLAN]/[NOTE]-noter + _forløb.md må ALDRIG linkes
    # ind, og et allerede-linket materiale med NFD-kodet ø/å i stien må ikke gen-tilføjes hver kørsel.
    enhed = patch_root / "§ FAG" / "♱ Religion" / "MD" / "Løgstrup og myndighed"
    enhed.mkdir(parents=True)
    nfd = unicodedata.normalize("NFD", "§ FAG/♱ Religion/MD/Løgstrup og myndighed/Løgstrup uddrag.md")
    p1 = enhed / "[PLAN] 2026-09-09 - Løgstrup og myndighed.md"
    p1.write_text("---\ntype: lektionsplan\nfag: Religion\n"
                  f"materiale_filer: |\n  📎 [[{nfd}|Løgstrup uddrag.md]]\n---\n", encoding="utf-8")
    (enhed / "[PLAN] 2026-09-16 - Løgstrup og myndighed.md").write_text(
        "---\ntype: lektionsplan\nfag: Religion\nmateriale_filer: false\n---\n", encoding="utf-8")
    (enhed / "[NOTE] 2026-09-09.md").write_text("stub", encoding="utf-8")
    (enhed / "_forløb.md").write_text("---\nkilde: hold-course-sync\n---\n", encoding="utf-8")
    (enhed / "Løgstrup uddrag.md").write_text("materiale", encoding="utf-8")

    for _ in range(3):
        patch_pending_materiale(patch_root, apply=True)
    got = p1.read_text(encoding="utf-8")
    assert "[PLAN] 2026-09-16" not in got and "[NOTE] 2026-09-09" not in got and "_forløb.md" not in got, got
    assert got.count("📎 [[") == 1, ("NFD/NFC-lækage — materiale gen-tilføjet", got)

    # #183-reprocase: delt enhed-mappe hvor background.js HAR fordelt filerne (AUTO-blokkens
    # `## Materialer` pr. plan). Den live-hændelse der skal fanges: 4 mandagslektioner i
    # "Skolens formål", hvor #176's gæt tømte 3 af dem. Her skal hver lektion beholde PRÆCIS sit
    # eget materiale — og en fil ingen plan nævner (MinerU kom for sent, #141) skal stadig
    # claimes af dem alle, ellers er den utilgængelig fra Hold Course.
    skole = patch_root / "§ FAG" / "⚖︎ LivsOplysning" / "MD" / "Skolens formål"
    skole.mkdir(parents=True)
    ejede = {"2026-08-17": "Rosa1.md", "2026-08-31": "Resonans.md", "2026-09-07": "Korsgaard.md"}
    for dato, fil in ejede.items():
        (skole / f"[PLAN] {dato} - Skolens formål.md").write_text(
            "---\ntype: lektionsplan\nfag: LivsOplysning\nmateriale_filer: false\n---\n\n"
            "<!-- AUTO:START -->\n# Skolens formål\n\n## Materialer\n"
            f"- [[§ FAG/⚖︎ LivsOplysning/MD/Skolens formål/{fil}|{fil}]]\n"
            "<!-- AUTO:END -->\n", encoding="utf-8")
        (skole / fil).write_text("materiale", encoding="utf-8")
    # Fjerde lektion: ingen AUTO-blok overhovedet (planen faldt ud af tidsvinduet før den blev skrevet).
    p4 = skole / "[PLAN] 2026-09-21 - Skolens formål.md"
    p4.write_text("---\ntype: lektionsplan\nfag: LivsOplysning\nmateriale_filer: false\n---\n", encoding="utf-8")
    (skole / "Uden ejer.md").write_text("MinerU kom for sent", encoding="utf-8")

    patch_pending_materiale(patch_root, apply=True)
    for dato, fil in ejede.items():
        got = (skole / f"[PLAN] {dato} - Skolens formål.md").read_text(encoding="utf-8")
        mat = got.split("materiale_filer:")[1].split("---")[0]
        assert fil in mat, (f"{dato} mistede sit eget materiale — #176-regressionen er tilbage", got)
        assert "Uden ejer.md" in mat, (f"{dato} claimede ikke den ejerløse fil", got)
        for andet in set(ejede.values()) - {fil}:
            assert andet not in mat, (f"{dato} claimede {andet}, som en søskende beviseligt ejer", got)
    got4 = p4.read_text(encoding="utf-8")
    assert "Uden ejer.md" in got4 and not any(f in got4 for f in ejede.values()), \
        ("planen uden AUTO-blok skal kun claime den ejerløse fil", got4)
    # Idempotent — også med søskende-filtreringen aktiv.
    assert patch_pending_materiale(patch_root, apply=True) == []
    # Bagudrettet oprydning: en tidligere kørsel havde allerede fladet 2026-08-17 ud med alle
    # fire filer. De tre en søskende beviseligt ejer skal fjernes igen; dens egen + den ejerløse
    # bliver stående. Det er den eneste sletning i denne funktion — derfor kun med positivt
    # modbevis, aldrig på formodning (#176).
    p1 = skole / "[PLAN] 2026-08-17 - Skolens formål.md"
    flad = p1.read_text(encoding="utf-8").replace(
        "materiale_filer: |\n",
        "materiale_filer: |\n"
        "  📎 [[§ FAG/⚖︎ LivsOplysning/MD/Skolens formål/Resonans.md|Resonans.md]]\n"
        "  📎 [[§ FAG/⚖︎ LivsOplysning/MD/Skolens formål/Korsgaard.md|Korsgaard.md]]\n")
    p1.write_text(flad, encoding="utf-8")
    assert patch_pending_materiale(patch_root, apply=True) == [str(p1.relative_to(patch_root))]
    mat = p1.read_text(encoding="utf-8").split("materiale_filer:")[1].split("---")[0]
    assert "Rosa1.md" in mat and "Uden ejer.md" in mat, ("egen + ejerløs fil blev fjernet", mat)
    assert "Resonans.md" not in mat and "Korsgaard.md" not in mat, ("fremmed link blev stående", mat)

    # Tømmes blokken helt, skal feltet tilbage til `false` — ikke et tomt `|`, som ville bryde
    # Bases' `!= false`-filtre (samme form background.js selv skriver).
    tom = remove_file_list_lines(
        "---\nmateriale_filer: |\n  📎 [[a/b.md|b.md]]\ntype: lektionsplan\n---\n",
        "materiale_filer", MATERIALE_FIL_PREFIX, {"a/b.md"})
    assert "materiale_filer: false\ntype: lektionsplan" in tom, tom

    # #184: to søskende-lektioner i SAMME delte enhed-mappe, hver med sin egen daterede
    # [PLAN]-note. Det er formen efter #184; før den skrev background.js begge til
    # `[PLAN] Introduktion.md`, så kun den sidst skrevne overlevede, og den daterede rest fra før
    # enhed-migreringen (#150/#155) bar SAMME plan_id. Begge ramte da samme lecture i sync_data og
    # prunede hinandens Reading-opgaver via valid_file_keys — nye opgave-id'er ved hver kørsel, så
    # data.json ændrede sig altid og trigger_obsidian_reload genstartede Obsidian hvert minut
    # (live-bekræftet 2026-09-06). read_plans dedupede som plaster; #184 fjernede rodårsagen.
    dub_dir = patch_root / "§ FAG" / "⚖︎ LivsOplysning" / "MD" / "Introduktion"
    dub_dir.mkdir(parents=True)
    for dato, pid, fil in (("2026-08-10", "33203:1315587", "Foer.md"),
                           ("2026-08-17", "33203:1315588", "Efter.md")):
        (dub_dir / f"[PLAN] {dato} - Introduktion.md").write_text(
            f'---\ntype: lektionsplan\nfag: LivsOplysning\nplan_id: "{pid}"\n'
            f'start: "{dato} 10:00:00"\nhentet: "2026-09-06 08:00"\n'
            f"materiale_filer: |\n  📎 [[§ FAG/⚖︎ LivsOplysning/MD/Introduktion/{fil}]]\n---\n",
            encoding="utf-8")
    dub_plans, _ = read_plans(patch_root)
    assert len({p["plan_id"] for p in dub_plans}) == len(dub_plans) == 2, \
        ("hver søskende skal have sin egen note — delt filnavn er #184-bug'en", dub_plans)
    # Hver lektion beholder SIT eget materiale: deler de én note, arver den ene den andens fil.
    for plan, fil in zip(sorted(dub_plans, key=lambda p: p["start"]), ("Foer.md", "Efter.md")):
        assert fil in plan.get("materiale_filer", ""), (plan["_path"], fil)
    # Idempotens hele vejen igennem: to kørsler i træk må give bit-identisk data.json, ellers
    # skriver synken (og reloader Obsidian) ved hvert eneste tick.
    ids_d = iter(f"d{n}" for n in range(500))
    d1 = sync_data({"semesters": [], "dataVersion": 2}, dub_plans, lambda: next(ids_d))
    snap1 = json.dumps(d1, sort_keys=True)
    d2 = sync_data(json.loads(snap1), dub_plans, lambda: next(ids_d))
    assert json.dumps(d2, sort_keys=True) == snap1, \
        "data.json ændrer sig ved hver kørsel — Obsidian ville blive reloadet i ring"

    # #186-reprocase: manuelt tilføjet materiale, som ALDRIG stod i nogen AUTO-blok (Valdemar lagde
    # filen direkte i RAW/, ingen plan.elements nævner den) — samme "Skolens formål"-mappe, samme
    # fem søskende. Uden `lektion:` ville "Erklæret.md" claimes af alle fem, som "Uden ejer.md"
    # gør. Med feltet skal den ende PRÆCIS på den lektion feltets plan_id peger på.
    (skole / "[PLAN] 2026-08-31 - Skolens formål.md").write_text(
        (skole / "[PLAN] 2026-08-31 - Skolens formål.md").read_text(encoding="utf-8")
        .replace("type: lektionsplan\n", 'type: lektionsplan\nplan_id: "99001:186"\n'),
        encoding="utf-8")
    (skole / "Erklæret.md").write_text(
        '---\nlektion: "99001:186"\n---\nmanuelt tilføjet materiale', encoding="utf-8")
    patch_pending_materiale(patch_root, apply=True)
    ejer_mat = (skole / "[PLAN] 2026-08-31 - Skolens formål.md").read_text(encoding="utf-8")
    assert "Erklæret.md" in ejer_mat.split("materiale_filer:")[1].split("---")[0], \
        ("erklæret ejer fik ikke filen", ejer_mat)
    for dato in ("2026-08-17", "2026-09-07", "2026-09-21"):
        andres = (skole / f"[PLAN] {dato} - Skolens formål.md").read_text(encoding="utf-8")
        assert "Erklæret.md" not in andres, (f"{dato} claimede en erklæret fremmed fil", andres)

    # reconcile_onyx (issue #146 + hold-course#10): Boox får Mac's friske indhold,
    # og en legacy `settings`-nøgle strippes fra begge kopier (device-prefs bor nu
    # i device-settings.json, som scriptet ikke rører).
    onyx_path = patch_root / "onyx-data.json"
    onyx_path.write_text(json.dumps({"currentSemesterId": "gammel", "semesters": [], "dataVersion": 1,
                                      "settings": {"einkMode": True}}), encoding="utf-8")
    fresh = {"currentSemesterId": "ny", "semesters": [{"stub": True}], "dataVersion": 2,
             "settings": {"einkMode": False}}
    reconcile_onyx(onyx_path, fresh, apply=True, quiet=True)
    onyx_result = json.loads(onyx_path.read_text(encoding="utf-8"))
    assert onyx_result["currentSemesterId"] == "ny", onyx_result
    assert onyx_result["semesters"] == [{"stub": True}], onyx_result
    assert "settings" not in onyx_result, "legacy settings-nøgle blev ikke strippet"

    # Idempotent: en gentaget reconcile mod samme friske data ændrer intet.
    before_mtime = onyx_path.stat().st_mtime
    reconcile_onyx(onyx_path, fresh, apply=True, quiet=True)
    assert onyx_path.stat().st_mtime == before_mtime, "reconcile skrev selvom intet ændrede sig"

    # dry-run rører ikke filen.
    reconcile_onyx(onyx_path, dict(fresh, dataVersion=3), apply=False, quiet=True)
    assert json.loads(onyx_path.read_text(encoding="utf-8"))["dataVersion"] == 2, "dry-run skrev alligevel"

    # Findes Boox-kopien slet ikke på denne maskine, skal reconcile være en stille no-op.
    reconcile_onyx(patch_root / "findes-ikke.json", fresh, apply=True, quiet=True)

    # ── Delt kontrakt-fixture (#182 / hold-course#63) ────────────────────────────────────────
    #    Samme fil pluginets test/contract-fixture.test.js loader. Ligger i plugin-repoet
    #    (pluginet ejer skemaet). Springes over hvis søster-checkout mangler — CI eller en frisk
    #    klon har ikke nødvendigvis begge. En bevidst skema-ændring uden at fixturen (og
    #    KNOWN_DATA_VERSION) følger med, fejler her ELLER i plugin-testen.
    fixture = Path(__file__).resolve().parents[2] / "obsidian-hold-course" / "test" / "fixtures" / "contract-data.json"
    if not fixture.exists():
        print(f"kontrakt-fixture ikke fundet ({fixture}) — springer over (søster-repo ikke checket ud)")
    else:
        fx = json.loads(fixture.read_text(encoding="utf-8"))
        assert fx["dataVersion"] == KNOWN_DATA_VERSION, \
            (f"fixturens dataVersion {fx['dataVersion']} != KNOWN_DATA_VERSION {KNOWN_DATA_VERSION} "
             f"— bump ude af sync mellem repos", fx["dataVersion"])
        lec_fx = fx["semesters"][0]["classes"][0]["lectures"][0]
        for stamp in ("vswPlanId", "vswDescription", "vswVaultLink"):
            assert stamp in lec_fx, (f"fixturen mangler lecture-stemplet {stamp}", lec_fx)
        assert "vswKey" in lec_fx["assignments"][0], lec_fx["assignments"][0]
        assert "vswResKey" in fx["semesters"][0]["resources"][0], fx["semesters"][0]["resources"][0]
        assert "vswFag" in fx["semesters"][0]["classes"][0], fx["semesters"][0]["classes"][0]
        # sync_data uden planer/opgaver: ren gennemgang. Alle nøgler (også ukendte for synken:
        # notesLink, professorEmail, exams …) og stempler skal overleve uændret.
        snap_fx = json.dumps(fx, sort_keys=True)
        passthrough = sync_data(json.loads(snap_fx), [], tasks=[])
        assert json.dumps(passthrough, sort_keys=True) == snap_fx, \
            "sync_data ændrede kontrakt-fixturen ved en tom kørsel — et felt bliver rørt der ikke burde"

    # ── Skema-versions-vagt: en for-høj dataVersion afvises uden skrivning (#182) ─────────────
    guard_path = patch_root / "guard-data.json"
    guard_before = json.dumps({"currentSemesterId": None, "semesters": [],
                               "dataVersion": KNOWN_DATA_VERSION + 1}, indent=2) + "\n"
    guard_path.write_text(guard_before, encoding="utf-8")
    rc = sync(patch_root, guard_path, apply=True, quiet=True)
    assert rc == 1, f"for-høj dataVersion skulle give rc=1, gav {rc}"
    assert guard_path.read_text(encoding="utf-8") == guard_before, \
        "sync skrev data.json trods for-høj dataVersion"

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        sys.exit(selfcheck())
    sys.exit(main())
