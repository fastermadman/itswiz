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

Brug Obsidians egen move (via `mcp__enquire__obsidian_rename_note`, eller Local REST API's
`MOVE`-verb med `Destination`-header hvis enquire-serveren ikke er tilgængelig) — ikke `mv`/`cp`,
ikke `mcp__filesystem__move_file`/`mcp__Desktop_Commander__move_file`. Grunden: Obsidians egen
move-mekanisme opdaterer automatisk alle `[[wikilinks]]` andre steder i vaulten der peger på filen;
en rå filsystem-flytning gør det ikke, og efterlader døde links i alt der linkede til den gamle
sti. Live-bekræftet 2026-08-28 (issue #131): en NFC/NFD-mismatch mellem extensionens egne strenge
og hvad macOS/Syncthing faktisk skriver til disk fik `background.js`s egen flytte-logik
(`moveDirInVault`) til fejlagtigt at tro en flytning allerede var sket — oprydningen bagefter blev
lavet via Local REST API's `MOVE`, netop for at wikilinks fulgte med.

## graphify-rs

This project has a graphify-rs knowledge graph at /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca/.

Rules:
- Before answering architecture or codebase questions, read /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca/GRAPH_REPORT.md for god nodes and community structure
- If /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify-rs build --path . --output /Users/valdefar/.graphify-rs/viastudywiz-extension-e4f58d98ef1c95ca --no-llm --update` to keep the graph current (fast, AST-only, ~2-5s)
