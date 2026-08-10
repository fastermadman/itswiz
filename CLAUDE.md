# VIAstudyWiz — projektinstruktioner

## Issue-baseret model/effort-skift

Åbne issues i dette repo er labelet med `model:haiku`/`model:sonnet`/`model:opus` og
`effort:low`/`effort:medium`/`effort:high` — Valdemars egen vurdering af hvor tung opgaven er,
sat da issuet blev oprettet (kan være forældet, se labels som et startpunkt, ikke en facitliste).

**Når du begynder at arbejde på et navngivet GitHub-issue i dette repo** (`gh issue view <n>`
eller Valdemar refererer til `#<n>`): tjek issuets `model:*`/`effort:*`-labels med
`gh issue view <n> --json labels`, og hvis de ikke matcher den model/effort du selv kører med lige
nu, foreslå eksplicit at skifte (`/model` og evt. reasoning-effort) før du går i gang — spørg,
gennemtving ikke. Nævn kort hvorfor (fx "issuet er labelet `model:opus`/`effort:high` — det er
arkitektur-tungt, vil du skifte op?").

Skift **ikke** model/effort medium under selve arbejdet på et issue uden at spørge igen —
labels er et startpunkt pr. issue, ikke en løbende styring.

## Sprog

Al kode-kommentar/dokumentation på dansk, medmindre det er extension-kildekode i sig selv
(variabelnavne/inline-kommentarer på engelsk er fint, chat-kommunikation på dansk).

## Hvor tingene ligger

Kontekst, research og arkitekturbeslutninger ligger i ValdiVault, ikke i dette repo:
`~/ValdiVault/10_Projects/VIAstudyWiz/06-handover-frisk-chat.md` — start altid der.
