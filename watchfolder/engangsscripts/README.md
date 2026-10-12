# Engangsscripts (arkiv)

Alle scripts her er allerede kørt mod vaulten — hver fil siger selv "Engangs-" i sin docstring.
De to løbende scripts (`watch_viastudywiz.py`, `sync_hold_course.py`) blev afløst af ItsWiz og
slettet i #244; nogle af scriptsene her importerer dem og kører derfor kun fra en ældre commit. Behold dem som dokumentation af hvad der
skete og hvornår (git-datoen på filen er tæt på når migreringen faktisk kørte) — slet dem ikke,
medmindre en fremtidig session bekræfter at ingen anden note refererer den samme migrering igen.

## Udløb for enhed-migrerings-klyngen (#149–#155)

`migrate_to_enhed_mapper.py` og følge-fixene hører sammen om ét skift (dato-mapper → enhed-mapper).
Hele klyngen kan slettes i én commit når **begge** er sandt: æraen er >6 måneder gammel
(~marts 2026), og intet åbent issue refererer #149–#155.

`relink_holdcourse_enhed.py` + `repeg_plan_frontmatter_links.py` (data.json- og frontmatter-repeg)
blev retireret i #165 da recovery var verificeret stabil (#164) — deres arbejde er engangs og løber
aldrig igen. Git-historikken har dem hvis en gammel backup-restore nogensinde skulle kræve en
gentagelse.

## Søskende der ikke afløser hinanden

`backfill_week_topics.py` (omdøber ugemapper) og `enrich_existing_notes.py` (eftermonterer
emne/start/stop i frontmatter) stammer fra **samme** live itslearning-snapshot (plan-API,
2026-08-10) og springer bevidst de samme 4 Musik-uger over. De er komplementære, ikke to forsøg
på samme opgave — kør ikke den ene i troen på at den dækker den anden.
