# ItsWiz

VIAstudyWiz' itslearning-høst som Obsidian-plugin: lektionsplaner, materialer og afleveringsopgaver
hentes ind i vaulten uden Chrome. Logikken er kopieret fra `../background.js` (frosset indtil #244).

## Brug

1. Symlink ind i vaulten (gjort for ViaVault), fra repo-roden:
   `mkdir -p ~/ViaVault/.obsidian/plugins/itswiz && ln -sf "$PWD"/plugin/{main.js,manifest.json} ~/ViaVault/.obsidian/plugins/itswiz/`
2. Obsidian → Indstillinger → Community plugins → slå **ItsWiz** til.
3. Klik eksamenshatten i venstre bjælke og log ind på itslearning i fanen.
4. Første gang i en vault, hvor extensionen har kørt: kør i extensionens service worker-konsol
   `chrome.storage.local.get(null).then((d) => copy(JSON.stringify(d)))` og derefter kommandoen
   **Importér VIAstudyWiz-data fra udklipsholderen**. Ellers nægter ItsWiz at høste, fordi første
   kørsel ville skrive alle lektionsplaner om.
5. **Høst nu** (knap i fanen eller kommando). **Sti-test** henter én fil pr. download-vej til
   `ItsWiz-test/` og rører ikke `§ FAG` eller `✎ NOTER`.

6. Derefter kører høsten af sig selv ved Obsidian-start og med intervallet i indstillingerne (default 24 timer).
   Statusbaren viser sidste kørsel og antal fejl; klik for fejllisten. Udløbet itslearning-login fornyes
   automatisk via Microsofts "Forbliv logget ind"; lykkes det ikke, kommer én besked og ItsWiz-fanen åbner.

Kun desktop. Ingen build, ingen dependencies. Test: `node --test plugin/test/*.test.js`.
