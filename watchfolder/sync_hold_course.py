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

Kendt begrænsning: Hold Course implementerer ikke `onExternalSettingsChange`, og intet installeret
plugin tilbyder en "genindlæs plugin"-kommando. Kører Obsidian med Hold Course indlæst, ser pluginet
altså ikke vores skrivning, og dets næste egne `save()` skriver hele dets hukommelses-kopi tilbage
oven i den. Det koster ikke data: mtime-vagten nedenfor sikrer at VI aldrig overskriver Valdemars
arbejde, og synken er idempotent, så en tabt skrivning kommer igen ved næste kørsel. Hold Course
viser den friske data næste gang pluginet indlæses.

Notér uden plan_id (ældre end issue #96) synkes ikke — de rapporteres, se ensure_lecture for hvorfor
et gæt på fag+uge blev afprøvet og forkastet.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører den indbyggede test.
"""

import json
import re
import sys
import time
import unicodedata
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
DATA_JSON = VAULT_ROOT / ".obsidian" / "plugins" / "hold-course" / "data.json"

# main.js: COLOR_PALETTE har 6 farver, og addClass sætter colorIndex = classes.length % længden.
COLOR_PALETTE_SIZE = 6

# Symbol + farve pr. fag. Symbolerne matcher background.js' FOLDER_SYMBOLS, farverne matcher
# Valdemars Google-kalendere, så Hold Course og kalenderen viser samme fag i samme farve.
# colorIndex peger ind i main.js' COLOR_PALETTE: 0 amber, 1 teal, 2 coral, 3 purple, 4 pink,
# 5 green. Gul findes ikke som sådan — amber er paletten's gule, coral er dens røde.
# Det er VORES konfiguration, ikke Valdemars data, så synken sætter code og colorIndex ved hver
# kørsel. `name` sættes derimod kun ved oprettelsen og er hans at redigere.
FAG_STYLE = {
    "Musik":         {"symbol": "♪",  "colorIndex": 5},   # grøn
    "Religion":      {"symbol": "♱",  "colorIndex": 0},   # amber/gul
    "LivsOplysning": {"symbol": "⚖︎", "colorIndex": 2},   # coral/rød
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
    match = re.match(r'^\[\[(.+?)\]\]$', line)
    return match.group(1) if match else None


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


def ensure_class(sem: dict, fag: str, new_id) -> dict:
    # `code` er IKKE fagets navn med et symbol foran — det ville stå lige over/ved siden af
    # `name` (samme tekst to gange, kun det ene med ikon: bekræftet live 2026-08-27, "to titler").
    # Kun symbolet alene her, `name` er fagets fulde navn og vises ét sted for sig.
    style = FAG_STYLE.get(fag, {})
    code = style.get("symbol", fag)
    cls = find_stamped(sem["classes"], "vswFag", fag)
    if cls:
        # code er synkens konfiguration (FAG_STYLE) og sættes derfor ved hver kørsel. colorIndex
        # sættes KUN ved oprettelsen (se nedenfor) — Hold Course har ingen farvevælger i UI'et,
        # kun en positionel auto-tildeling, og en anden farve pr. kørsel oveni Valdemars egen
        # (fx via kalenderens farver) gav "flere farver i spil", ikke færre (samme dato).
        cls["code"] = code
        return cls
    # Kun felterne vi rent faktisk har data til. Underviser, lokale, mødedage og tidspunkter står
    # tomme og røres aldrig igen — udfylder Valdemar dem én gang i Hold Course, bliver de stående
    # (spørgsmål 4 i #113: synken gætter aldrig på data den ikke har).
    cls = {
        "id": new_id(), "colorIndex": style.get("colorIndex", len(sem["classes"]) % COLOR_PALETTE_SIZE),
        "code": code, "name": fag, "courseUrl": "", "meetingLink": "",
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
    # Synkens felter. status og notes er Valdemars og røres ikke.
    lec["title"] = plan.get("emne") or plan.get("uge") or "Lektion"
    lec["date"] = (plan.get("start") or "")[:10]
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


def ensure_resource(sem: dict, cls: dict, vault_path: str, new_id) -> dict:
    res = find_stamped(sem.setdefault("resources", []), "vswResKey", vault_path)
    if res is None:
        res = {"id": new_id(), "title": Path(vault_path).stem, "author": "", "type": "",
               "classIds": [], "status": "unread", "vaultLink": vault_path, "url": "",
               "notes": "", "vswResKey": vault_path}
        sem["resources"].append(res)
    res["vaultLink"] = nfc(res.get("vaultLink", ""))
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
    for plan in sorted(plans, key=lambda p: (p["fag"], p.get("start", ""))):
        cls = ensure_class(sem, plan["fag"], new_id)
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
                ensure_assignment(lec, f'{akey}|lit|{target}', res["title"], "Reading", due,
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
            ensure_assignment(lec, f'{akey}|mat|{target}', res["title"], "Reading", due,
                              res["id"], new_id, linked_note=target)

    # Afleveringsopgaver hænger på faget, ikke på en lektion — derfor klasse-niveau. De vises i
    # Hold Courses Assignments-liste og kalender uden at blive klistret på en tilfældig lektion.
    for task in sorted(tasks, key=lambda t: (t["fag"], t.get("deadline", ""))):
        cls = ensure_class(sem, task["fag"], new_id)
        ensure_assignment(cls, f'opgave|{task["_element_id"]}', task["_title"], "Writing",
                          task["deadline"][:10], "", new_id, linked_note=task["_path"])

    return data


def sync(vault_root: Path, data_path: Path, apply: bool, quiet: bool = False) -> int:
    if not data_path.exists():
        print(f"Hold Course' data.json findes ikke ({data_path}) — er pluginet installeret?", file=sys.stderr)
        return 1

    plans, uden_plan_id = read_plans(vault_root)
    tasks = read_tasks(vault_root)
    before = data_path.read_text(encoding="utf-8")
    mtime = data_path.stat().st_mtime
    data = json.loads(before)
    after = json.dumps(sync_data(data, plans, tasks=tasks), indent=2, ensure_ascii=False) + "\n"

    if uden_plan_id and not quiet:
        print(f"{len(uden_plan_id)} lektionsplan-note(r) uden plan_id springes over "
              f"(ældre end issue #96, kan ikke matches sikkert — ret dem i vaulten):")
        for rel in uden_plan_id:
            print(f"  {rel}")

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
    print("Skrevet. Hold Course viser det næste gang pluginet indlæses.")
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
    assert cls["code"] == "♪" and cls["name"] == "Musik" and cls["vswFag"] == "Musik", cls
    assert cls["colorIndex"] == 5, cls  # kun sat ved oprettelsen, som defaulten for Musik

    # colorIndex rørt IGEN ved en senere kørsel: Hold Course har ingen farvevælger, kun en
    # positionel auto-tildeling — en gentaget override ville give "flere farver i spil" i stedet
    # for færre (Valdemars ord, live 2026-08-27), da HC selv kan have flyttet den siden.
    cls["colorIndex"] = 1
    data_recolor = sync_data(data, [plan], lambda: "MÅ-IKKE-BRUGES")
    assert data_recolor["semesters"][0]["classes"][0]["colorIndex"] == 1, "colorIndex blev overskrevet"
    assert data_recolor["semesters"][0]["classes"][0]["code"] == "♪", "code følger stadig med"
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

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        sys.exit(selfcheck())
    sys.exit(main())
