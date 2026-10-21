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

Repoet er ItsWiz-pluginet i `plugin/` (Obsidian-plugin, milestone "ItsWiz: fra Chrome til Obsidian"). Chrome-extensionen
og Python/launchd-laget (`watchfolder/watch_viastudywiz.py`, `sync_hold_course.py`, plisten) blev fjernet i #244 og findes
kun i git-historikken; `watchfolder/engangsscripts/` er bevaret som arkiv. Ingen build og ingen dependencies:

```bash
node --check plugin/main.js && node --test plugin/test/*.test.js
```

`.githooks/pre-push` kører det samme (aktivér: `git config core.hooksPath .githooks`). `plugin/test/hcsync.test.js`
afspiller de optagede kald fra den slettede Python-synks selvtjek (`plugin/test/fixtures/`); `convert.test.js` holder
konverteringen på watch-scriptets gamle output.

## Grænsen mellem hvad der kan bevises og hvad der skal prøves

Testene dækker ren logik: frontmatter-parsing, wikilinks, Hold Course-synk, konvertering, kalender-mapping.
Grønne tests betyder at logikken er rigtig — **ikke** at pipelinen virker. Ikke dækket, og kan ikke blive det uden
den rigtige omverden: itslearnings API/DOM, Obsidians vindues-/netværks-API'er, Hold Course-pluginet og hvad
Syncthing/macOS faktisk skriver til disk (NFC/NFD, #131).

Rører et issue en af dem, lukkes det først når det er prøvet live i Obsidian mod `~/ViaVault`, og det eksakte output er
citeret i issue-kommentaren — kodegennemgang alene er ikke bevis.

## Genindlæs pluginet efter kodeændringer

`~/ViaVault/.obsidian/plugins/itswiz/` symlinker `main.js`/`manifest.json` herfra. Obsidian genindlæser ikke plugin-kode
af sig selv efter en ekstern filændring (bekræftet live 2026-09-05/06), så ellers tester du gammel kode:

```bash
obsidian vault=ViaVault plugin:reload id=itswiz
```

Samme gælder Hold Course-pluginet (`id=hold-course`, symlinket fra `obsidian-hold-course`). Hold Course-synken kører via
Hold Course' `api.update()` (hold-course#84).

## Secret-redaction

I et nyt checkout/worktree skal `claude plugin install secret-redactor@viastudywiz-mods --scope project` køres én gang (appens binær, 2.1.286+), og derefter `/reload-plugins` — ellers er mod'en slået til i settings men ikke indlæst.
