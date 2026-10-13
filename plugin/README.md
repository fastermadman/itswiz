# ItsWiz

ItsWiz er en itslearning-høst som Obsidian-plugin: lektionsplaner, materialer og afleveringsopgaver
hentes ind i vaulten uden Chrome. Logikken er kopieret fra Chrome-extensionens `background.js`, som blev slettet i #244.

## Installation for medstuderende (BRAT)

1. Installér **Obsidian42 - BRAT** (Community plugins) og slå det til.
2. BRAT → *Add beta plugin* → `https://github.com/FasterMadman/itswiz`. Slå **ItsWiz** til under Community plugins.
3. Klik eksamenshatten i venstre bjælke og log ind på itslearning. Tryk **Høst nu**.
4. *MinerU-nøgle* (valgfri, kun til konvertering af PDF/Office til noter): hent en gratis nøgle på mineru.net (log ind → API → token), indsæt den i ItsWiz' indstillinger og slå *Konvertér RAW-filer* til.
5. *Kalender*: itslearning viser kun events fra kurser du har sat **stjerne** ved. Stjernemarkér de kurser du vil have med i itslearning, og slå så *Personlige kalenderevents i itslearning* til.
6. Hvad ItsWiz skriver i vaulten: alt under `§ FAG/` (lektionsplaner i `MD/`, hentede filer i `RAW/`, tomme forelæsningsnoter i `NOTER/`) og opgaver i `✎ NOTER/OPGAVER/`. Intet uden for de to mapper, og `ItsWiz-test/` kun ved Sti-test.

## Brug (udvikling: symlink fra repoet)

1. Symlink ind i vaulten (gjort for ViaVault), fra repo-roden:
   `mkdir -p ~/ViaVault/.obsidian/plugins/itswiz && ln -sf "$PWD"/plugin/{main.js,manifest.json} ~/ViaVault/.obsidian/plugins/itswiz/`
2. Obsidian → Indstillinger → Community plugins → slå **ItsWiz** til.
3. Klik eksamenshatten i venstre bjælke og log ind på itslearning i fanen.
4. ViaVault har fået extensionens data importeret (kommandoen **Importér VIAstudyWiz-data fra
   udklipsholderen**, #239). Extensionen er væk (#244), så i en ny vault med gamle VIAstudyWiz-noter
   nægter ItsWiz at høste, fordi første kørsel ville skrive alle lektionsplaner om.
5. **Høst nu** (knap i fanen eller kommando). **Sti-test** henter én fil pr. download-vej til
   `ItsWiz-test/` og rører ikke `§ FAG` eller `✎ NOTER`.

6. Derefter kører høsten af sig selv ved Obsidian-start og med intervallet i indstillingerne (default 24 timer).
   Statusbaren viser sidste kørsel og antal fejl; klik for fejllisten. Udløbet itslearning-login fornyes
   automatisk via Microsofts "Forbliv logget ind"; lykkes det ikke, kommer én besked og ItsWiz-fanen åbner.

7. **Kalender (#243):** slå "Personlige kalenderevents i itslearning" til i indstillingerne (default fra). Hver høst
   opretter/retter/flytter ét personligt event pr. lektion og afleveringsfrist og aflyser (`AFLYST · `) lektioner,
   der er forsvundet fra itslearning. ItsWiz rører kun events i `calendarEventMap` i `data.json`. Kommandoen
   **Fjern alle ItsWiz-kalenderevents** sletter dem igen.

Kun desktop. Ingen build, ingen dependencies. Test: `node --test plugin/test/*.test.js`.
