#!/usr/bin/env python3
"""
Giver hver lektion sin egen [PLAN]-note-fil (issue #184).

  § FAG/<fag>/MD/<enhed>/[PLAN] <enhed>.md  ->  .../[PLAN] <dato> - <enhed>.md

background.js skrev indtil #184 ALLE en enheds lektioner til `[PLAN] <enhed>.md` — samme sti for
alle søskende, hvor hver kørsel overskrev den forrige. Kun den sidst skrevne lektions plandata
overlevede, og noten bar det plan_id den lektion havde. De daterede noter fra før
enhed-migreringen (#150/#155) stod tilbage som rester ingen skrev til længere, hvoraf 11 delte
plan_id med den udaterede note og prunede dens Reading-opgaver i sync_hold_course — nye
opgave-id'er ved hver kørsel, så data.json ændrede sig altid og Obsidian blev reloadet hvert
minut (live-bekræftet 2026-09-06).

Kør EFTER at background.js er opdateret. Mappen (`enhedFolder`) ændres ikke — kun filnavnet, som
er det eneste sted der kan skille søskende ad. #183s ejerskabsmekanisme forudsætter netop at
søskende deler mappe.

To former, fordi de har vidt forskellig link-risiko:

* **erstat** — den daterede note findes allerede (11 af 12 tilfælde i vaulten). Den er en STALE
  kopi af samme lektion (samme plan_id), og den udaterede er den friske. Målets NAVN består, kun
  indholdet erstattes, så alt der linker til målet bliver ved med at virke uanset hvad.
* **omdøb** — der findes ingen dateret note (1 tilfælde). Filen omdøbes.

CLAUDE.md kræver Obsidians egen move, fordi den opdaterer `[[wikilinks]]` andre steder i vaulten.
Local REST API v5.1.0 har ikke længere noget move/rename-endpoint (`/vault/` kan kun
GET/PUT/POST/PATCH/DELETE; `MOVE` står i `Access-Control-Allow-Methods`, men er ikke en rute), så
reglen efterleves ved sin begrundelse i stedet for sin bogstav: Obsidian spørges om den
forsvindende fils backlinks, og de links skrives om til det nye navn — præcis det Obsidians rename
selv ville have gjort. Kræver derfor at Obsidian kører med Local REST API slået til.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører de indbyggede asserts.
"""

import json
import re
import ssl
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
LOCAL_REST_API_CONFIG = VAULT_ROOT / ".obsidian" / "plugins" / "obsidian-local-rest-api" / "data.json"

AUTO_START = "<!-- AUTO:START -->"
AUTO_END = "<!-- AUTO:END -->"
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def frontmatter(text: str) -> dict[str, str]:
    """Kun de skalar-felter migreringen bruger (plan_id, dato, hentet) — ikke en YAML-parser."""
    match = re.match(r"^---\n([\s\S]*?)\n---\n", text)
    if not match:
        return {}
    fields = {}
    for line in match.group(1).split("\n"):
        key, sep, value = line.partition(":")
        if sep and not key.startswith(" "):
            fields[key.strip()] = value.strip().strip('"')
    return fields


def human_content(text: str) -> str:
    """Alt uden for frontmatter OG uden for AUTO-blokken — dvs. det maskinen ikke ejer.

    `[PLAN]`-noter er per ejerskabskontrakten 100% maskinens (ValdiVault 14-hold-course-synk.md),
    så det her SKAL være tomt. Målt mod den rigtige vault 2026-09-07: 0 af 102 noter havde noget.
    Scriptet erstatter aldrig en note uden først at have bevist det for netop den fil — samme
    positivt-bevis-princip som #183/#185, og den lærepenge #176 kostede.
    """
    body = re.sub(r"^---\n[\s\S]*?\n---\n\n?", "", text)
    return re.sub(re.escape(AUTO_START) + r"[\s\S]*?" + re.escape(AUTO_END), "", body).strip()


def plan_note_target(path: Path) -> tuple[Path, dict] | None:
    """Den daterede sti en `[PLAN] <enhed>.md` skal hedde — eller None hvis noten er i orden.

    Samme regel som `planNoteName()` i background.js: `[PLAN] <dato> - <enhed>`, og `[PLAN] <dato>`
    alene når lektionen ikke har noget brugbart emne (mappen ER da datoen, og "<dato> - <dato>"
    ville være ren støj). Den emneløse form er derfor allerede unik og røres ikke.
    """
    enhed = path.parent.name
    if path.stem != f"[PLAN] {enhed}" or DATE_RE.fullmatch(enhed):
        return None
    fields = frontmatter(path.read_text(encoding="utf-8"))
    dato = fields.get("dato")
    if not dato or not DATE_RE.fullmatch(dato):
        return None
    return path.parent / f"[PLAN] {dato} - {enhed}.md", fields


def plan_migration(vault_root: Path) -> tuple[list[dict], list[str]]:
    """Planlægger uden at røre noget. Returnerer (handlinger, advarsler)."""
    actions, warnings = [], []
    for path in sorted(vault_root.rglob("[[]PLAN[]] *.md")):
        found = plan_note_target(path)
        if not found:
            continue
        target, fields = found
        pid = fields.get("plan_id")
        if not pid:
            warnings.append(f"{path.relative_to(vault_root)}: intet plan_id (#117) — springes over")
            continue
        if not target.exists():
            actions.append({"source": path, "target": target, "mode": "omdøb"})
            continue
        stale = target.read_text(encoding="utf-8")
        stale_pid = frontmatter(stale).get("plan_id")
        if stale_pid != pid:
            warnings.append(
                f"{path.relative_to(vault_root)}: målet {target.name} har et ANDET plan_id "
                f"({stale_pid} != {pid}) — rørt ikke, ryd op i hånden")
            continue
        if human_content(stale):
            warnings.append(
                f"{target.relative_to(vault_root)}: har indhold uden for AUTO-blokken — rørt "
                f"ikke, flet i hånden")
            continue
        actions.append({"source": path, "target": target, "mode": "erstat"})
    return actions, warnings


def rewrite_links(text: str, old_stem: str, new_stem: str) -> str:
    """`[[<old>]]`, `[[<old>|alias]]`, `[[<old>#overskrift]]` -> samme med `<new>`.

    Det Obsidians egen rename ville have gjort. Kun hele link-målet matches, så en note hvis navn
    har et andet notenavn som præfiks ikke bliver ramt.

    Begge sider NFC-normaliseres: `old_stem` kommer fra filsystemet (macOS/Syncthing skriver gerne
    NFD), notens tekst er NFC. Uden det matcher "Musikforståelse"/"Idéhistorie" aldrig — samme
    NFC/NFD-fælde som #131, bare i tekstindholdet i stedet for i et filopslag. Ramte live under
    #184-migreringen: to links blev efterladt døde, fordi netop `å` og `é` er dekomponerbare.
    """
    text, old_stem, new_stem = (unicodedata.normalize("NFC", s) for s in (text, old_stem, new_stem))
    return re.sub(r"\[\[" + re.escape(old_stem) + r"(?=[\]|#])", f"[[{new_stem}", text)


def execute(actions: list[dict], vault_root: Path, backlinks) -> list[str]:
    """Udfører handlingerne. `backlinks` injiceres, så selfcheck kan køre uden Obsidian."""
    done = []
    for act in actions:
        src, tgt = act["source"], act["target"]
        rel = str(src.relative_to(vault_root))
        # Links til den forsvindende fil skrives om FØR den forsvinder, så en afbrudt kørsel
        # efterlader et link der stadig peger på en fil der findes.
        for linker in backlinks(rel):
            f = vault_root / linker
            f.write_text(rewrite_links(f.read_text(encoding="utf-8"), src.stem, tgt.stem),
                         encoding="utf-8")
        if act["mode"] == "erstat":
            # Målets navn består — kun indholdet bliver det friske. Alt der linker til MÅLET
            # bliver derfor ved med at virke, uden at noget skal skrives om.
            tgt.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            src.unlink()
        else:
            src.rename(tgt)
        done.append(f"{rel} -> {tgt.name} ({act['mode']})")
    return done


# ─── Obsidian Local REST API ──────────────────────────────────────────────────

def _api(method: str, rel_path: str, headers: dict | None = None):
    # NFC, ikke stien som filsystemet gav den: macOS/Syncthing skriver gerne NFD (dekomponeret
    # "å" som to kodepunkter), mens Obsidians indeks er NFC. Synligt identisk, byte-forskelligt —
    # og et opslag på NFD-formen giver 404 selvom filen findes. Samme fælde som #131.
    config = json.loads(LOCAL_REST_API_CONFIG.read_text(encoding="utf-8"))
    path = urllib.parse.quote(unicodedata.normalize("NFC", rel_path))
    req = urllib.request.Request(
        f"https://127.0.0.1:{config['port']}/vault/{path}",
        method=method,
        headers={"Authorization": f"Bearer {config['apiKey']}", **(headers or {})},
    )
    return urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=15)


def api_backlinks(rel_path: str) -> list[str]:
    """Obsidians EGEN liste over noter der linker hertil — facit, ikke et grep."""
    body = _api("GET", rel_path, {"Accept": "application/vnd.olrapi.note+json"}).read()
    return json.loads(body).get("backlinks", [])


def main() -> int:
    apply = "--apply" in sys.argv
    actions, warnings = plan_migration(VAULT_ROOT)
    for w in warnings:
        print(f"⚠️  {w}", file=sys.stderr)
    if not actions:
        print("Intet at migrere — alle [PLAN]-noter har allerede et navn pr. lektion.")
        return 0

    print(f"{'Migrerer' if apply else 'Ville migrere (dry-run)'}: {len(actions)} note(r)")
    for act in actions:
        links = api_backlinks(str(act["source"].relative_to(VAULT_ROOT)))
        print(f"  [{act['mode']}] {act['source'].relative_to(VAULT_ROOT)} -> {act['target'].name}"
              + (f"  (+{len(links)} link(s) skrives om)" if links else ""))
    if not apply:
        print("\nKør med --apply for at udføre. Obsidian SKAL køre (Local REST API).")
        return 0

    for line in execute(actions, VAULT_ROOT, api_backlinks):
        print(f"✓ {line}")
    print("\nFærdig. Genstart watchfolder-daemonen og verificér i Obsidian.")
    return 0


def selfcheck() -> int:
    import tempfile

    assert rewrite_links("a [[[PLAN] X]] b [[[PLAN] X|alias]] c [[[PLAN] XY]]",
                         "[PLAN] X", "[PLAN] 2026-01-01 - X") == \
        "a [[[PLAN] 2026-01-01 - X]] b [[[PLAN] 2026-01-01 - X|alias]] c [[[PLAN] XY]]"
    # NFD-stem (som filsystemet giver den) mod NFC-tekst (som noten er skrevet).
    assert rewrite_links("se [[[PLAN] Musikforståelse]]",
                         unicodedata.normalize("NFD", "[PLAN] Musikforståelse"),
                         "[PLAN] 2026-10-06 - Musikforståelse") == \
        "se [[[PLAN] 2026-10-06 - Musikforståelse]]"

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        def note(rel: str, pid: str, dato: str, body: str = "", hentet: str = "2026-09-06 08:00"):
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(
                f'---\ntype: lektionsplan\nfag: LivsOplysning\nplan_id: "{pid}"\n'
                f'dato: {dato}\nhentet: "{hentet}"\n---\n\n'
                f"{AUTO_START}\n# {rel}\n{AUTO_END}\n{body}", encoding="utf-8")
            return p

        md = "§ FAG/⚖︎ LivsOplysning/MD"
        # a) udateret note UDEN dateret tvilling -> ren omdøbning
        note(f"{md}/Musikforståelse/[PLAN] Musikforståelse.md", "36016:1283999", "2026-10-06")
        # b) udateret note MED stale dateret tvilling, samme plan_id -> tvillingen får det friske
        #    indhold og beholder sit navn; den udaterede forsvinder
        note(f"{md}/Introduktion/[PLAN] Introduktion.md", "33203:1315587", "2026-08-10")
        note(f"{md}/Introduktion/[PLAN] 2026-08-10 - Introduktion.md", "33203:1315587",
             "2026-08-10", hentet="2026-09-01 08:00")
        # c) søskende der allerede har eget dateret navn -> urørt
        note(f"{md}/Introduktion/[PLAN] 2026-08-17 - Introduktion.md", "33203:1315588", "2026-08-17")
        # d) emneløs lektion: mappen ER datoen, [PLAN] <dato>.md er allerede unik -> urørt
        note(f"{md}/2026-04-08/[PLAN] 2026-04-08.md", "36016:1200000", "2026-04-08")

        # En [NOTE]-stub der linker til den udaterede note — den reelle form i vaulten, hvor
        # stubben kan tilhøre en HELT anden lektion end den noten sidst bar (live: LivsOplysnings
        # "Idéhistorie og etik", stub for 2026-10-05, note med dato 2026-09-28).
        stub = root / "§ FAG/⚖︎ LivsOplysning/NOTER/2026-08-10 - Introduktion/[NOTE] x.md"
        stub.parent.mkdir(parents=True)
        stub.write_text('---\nkilde: "[[[PLAN] Introduktion]]"\n---\n\n'
                        "Kilde: [[[PLAN] Introduktion]]\n", encoding="utf-8")

        pid_foer = {frontmatter(p.read_text())["plan_id"] for p in root.rglob("[[]PLAN[]] *.md")}
        noter_foer = len(list(root.rglob("[[]PLAN[]] *.md")))
        assert noter_foer == 5 and len(pid_foer) == 4, (noter_foer, pid_foer)
        # Uden migreringen deler to noter plan_id — churn-bug'en fra #181/#184.
        assert noter_foer - len(pid_foer) == 1

        actions, warnings = plan_migration(root)
        assert not warnings, warnings
        assert sorted(a["mode"] for a in actions) == ["erstat", "omdøb"], actions

        def fake_backlinks(rel):
            stem = Path(rel).stem
            return [str(f.relative_to(root)) for f in root.rglob("*.md")
                    if f"[[{stem}]]" in f.read_text(encoding="utf-8")]

        execute(actions, root, fake_backlinks)

        efter = sorted(root.rglob("[[]PLAN[]] *.md"))
        pid_efter = [frontmatter(p.read_text())["plan_id"] for p in efter]
        # Nul tab: hvert plan_id fra før findes stadig, nu med præcis én fil hver.
        assert set(pid_efter) == pid_foer, (pid_efter, pid_foer)
        assert len(pid_efter) == len(set(pid_efter)) == 4, pid_efter
        assert sorted(p.name for p in efter) == [
            "[PLAN] 2026-04-08.md",
            "[PLAN] 2026-08-10 - Introduktion.md",
            "[PLAN] 2026-08-17 - Introduktion.md",
            "[PLAN] 2026-10-06 - Musikforståelse.md",
        ], sorted(p.name for p in efter)
        # Den FRISKE note vandt, ikke den stale rest den erstattede.
        intro = root / md / "Introduktion" / "[PLAN] 2026-08-10 - Introduktion.md"
        assert frontmatter(intro.read_text())["hentet"] == "2026-09-06 08:00", intro.read_text()
        # Stubbens link peger nu på den daterede note — ingen døde links efterladt.
        assert "[[[PLAN] 2026-08-10 - Introduktion]]" in stub.read_text(), stub.read_text()
        assert "[[[PLAN] Introduktion]]" not in stub.read_text(), stub.read_text()

        # Idempotent: anden kørsel finder intet at gøre.
        assert plan_migration(root) == ([], []), plan_migration(root)

        # En note med Valdemars eget indhold uden for AUTO erstattes ALDRIG (#176-lærepengen).
        note(f"{md}/Etik/[PLAN] Etik.md", "33203:9", "2026-09-28")
        note(f"{md}/Etik/[PLAN] 2026-09-28 - Etik.md", "33203:9", "2026-09-28", body="\nMin note.\n")
        acts, warns = plan_migration(root)
        assert acts == [] and len(warns) == 1 and "uden for AUTO-blokken" in warns[0], (acts, warns)

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
