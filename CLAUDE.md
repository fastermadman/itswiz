# VIAstudyWiz — projektinstruktioner

Issue-baseret model/effort-skift (labels `model:*`/`effort:*` på åbne issues, prompt ved skift)
er nu en global konvention — se `~/.claude/CLAUDE.md`. Ikke gentaget her.

## Sprog

Al kode-kommentar/dokumentation på dansk, medmindre det er extension-kildekode i sig selv
(variabelnavne/inline-kommentarer på engelsk er fint, chat-kommunikation på dansk).

## Hvor tingene ligger

Kontekst, research og arkitekturbeslutninger ligger i ValdiVault, ikke i dette repo:
`~/ValdiVault/10_Projects/VIAstudyWiz/06-start-her.md` — start altid der. Ren pointer-note til
GitHub issues/milestones og arkitekturnoter, ingen statusprosa der kan gå forældet.

## Flyt/omdøb ALDRIG vault-filer med rå filsystem-værktøjer

(Håndhæves af PreToolUse-hook `.claude/hooks/vault-move-guard.sh`.)

Brug Obsidian-CLI'en (`/Applications/Obsidian.app/Contents/MacOS/obsidian vault=ViaVault move path=<fra> to=<til>`,
kræver Obsidian åben; angiv ALTID `vault=ViaVault` eller `vault=ValdiVault` som første parameter, ellers rammer den sidst fokuserede vault; `rename` findes også; verificeret 2026-09-25 at wikilinks opdateres) — ikke `mv`/`cp`,
ikke `mcp__filesystem__move_file`/`mcp__Desktop_Commander__move_file`. Grunden: Obsidians egen
move-mekanisme opdaterer automatisk alle `[[wikilinks]]` andre steder i vaulten der peger på filen;
en rå filsystem-flytning gør det ikke, og efterlader døde links i alt der linkede til den gamle
sti. Live-bekræftet 2026-08-28 (issue #131): en NFC/NFD-mismatch mellem extensionens egne strenge
og hvad macOS/Syncthing faktisk skriver til disk fik `background.js`s egen flytte-logik
(`moveDirInVault`) til fejlagtigt at tro en flytning allerede var sket — oprydningen bagefter blev
lavet via Local REST API's `MOVE`, netop for at wikilinks fulgte med.

## Kør/test

Ingen build og ingen dependencies. Verifikationsløkken for Python-laget (kun stdlib, rører ikke vaulten):

```bash
python3 watchfolder/sync_hold_course.py --selfcheck && python3 watchfolder/watch_viastudywiz.py --selfcheck
node --check background.js   # kun syntaks — der findes ingen JS-tests
```

`.githooks/pre-push` kører selvtjekkene (aktivér: `git config core.hooksPath .githooks`). Et selvtjek der
begynder at kræve `~/ViaVault` tester ikke længere ren logik — det var fejlen i #139.

## Grænsen mellem hvad der kan bevises og hvad der skal prøves

Selvtjekkene dækker ren logik: frontmatter-parsing, wikilinks, `sync_data`, stemplet ejerskab, highlight-beskyttelse.
Grønne selvtjek betyder at logikken er rigtig — **ikke** at pipelinen virker. Ikke dækket, og kan ikke blive det uden
den rigtige omverden: itslearnings API/DOM, `background.js` (service worker, File System Access), Hold Course-pluginet
i Obsidian, den kørende launchd-proces og hvad Syncthing/macOS faktisk skriver til disk (NFC/NFD, #131).

Rører et issue en af dem, lukkes det først når et console-snippet er kørt live og det eksakte output er citeret i
issue-kommentaren — kodegennemgang alene er ikke bevis. Husk genstart af driftsprocesserne (afsnittet nedenfor)
før du prøver: ellers tester du gammel kode.

## Genstart driftsprocesser efter kodeændringer i sync/extension-laget

`watchfolder/watch_viastudywiz.py` (launchd-job `com.valdemar.viastudywiz-watchfolder`) importerer
`sync_hold_course` som modul ved opstart og holder den i hukommelsen — en `git pull`/commit til
`sync_hold_course.py` eller `background.js` ændrer INTET i den kørende proces, før den genstartes:

```bash
launchctl kickstart -k gui/$(id -u)/com.valdemar.viastudywiz-watchfolder
```

Samme problem gælder Obsidians Hold Course-plugin (`main.js`, symlinket fra `obsidian-hold-course`):
Obsidian genindlæser ikke plugin-kode af sig selv efter en ekstern filændring. Er Local REST API sat
op og porten kendt (se `~/ViaVault/.obsidian/plugins/obsidian-local-rest-api/data.json`), kan en
reload trigges uden at forlade appen:

```python
import sys; sys.path.insert(0, "watchfolder")
from pathlib import Path
import sync_hold_course as m
m.trigger_obsidian_reload(Path.home() / "ViaVault")
```

Fejler den stille (forkert port/nøgle, Obsidian ikke åben), er en manuel Cmd+R i Obsidian reserven.
Glemmes begge dele, ser man ændringer der "ikke virker" selvom koden er korrekt — bekræftet live
2026-09-05/06 to gange i træk under #176/#177/#179-arbejdet.

## ItsWiz-pluginet (`plugin/`)

`plugin/` er ItsWiz: Obsidian-pluginet der afløser extensionen og Python/launchd-laget (milestone
"ItsWiz: fra Chrome til Obsidian"). Ingen build. `~/ViaVault/.obsidian/plugins/itswiz/` symlinker
`main.js`/`manifest.json` herfra. Obsidian genindlæser ikke pluginet selv efter en filændring:

```bash
obsidian vault=ViaVault plugin:reload id=itswiz
```

Høstlogikken i `plugin/main.js` er kopieret fra `background.js`, som er frosset indtil #244: ret kun
i pluginet. `node --test plugin/test/*.test.js` kræver at kopiens rene funktioner giver samme output som
`background.js` (`plugin/test/parity.test.js`), og kører også i `pre-push`.

## Secret-redaction

I et nyt checkout/worktree skal `claude plugin install secret-redactor@viastudywiz-mods --scope project` køres én gang (appens binær, 2.1.286+), og derefter `/reload-plugins` — ellers er mod'en slået til i settings men ikke indlæst.

## graphify-rs

This project has a graphify-rs knowledge graph at /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca/.

Rules:
- On-demand: læs kun GRAPH_REPORT.md (/Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca/) når spørgsmålet er arkitektur/tværgående, ikke ved hver søgning
- If /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify-rs build --path . --output /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca --no-llm --update` to keep the graph current (fast, AST-only, ~2-5s)
