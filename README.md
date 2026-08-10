# VIAstudyWiz — itslearning extension

Browser extension der automatiserer indsamling af lektionsplaner og
undervisningsmaterialer fra via.itslearning.com (VIA University College).

Del af VIAstudyWiz-pipelinen. Kontekst, research og arkitekturbeslutninger
ligger i ValdiVault:
`10_Projects/VIAstudyWiz/06-handover-frisk-chat.md` (arbejdsdokument, start her)
`10_Projects/VIAstudyWiz/05-api-reference.md` (aktuel teknisk reference)

## Status

Research afsluttet — API-flade og download-kæder for PDF og Office-filer
(.docx/.pptx/.xlsx) er begge kortlagt og løst. Fil-skrivning kører på File
System Access API (se afsnit nedenfor) i stedet for `chrome.downloads` —
detaljeret baggrund i ValdiVault:
`10_Projects/VIAstudyWiz/09-file-system-access-migration.md`. Se
handover-noten for fund-oversigt og resterende åbne punkter. Build-fase
kører, tracket som GitHub Issues i dette repo.

## Fil-skrivning: File System Access API

`chrome.downloads.download()` tvang en native Gem-som-dialog frem hver gang
en download ramte en ny undermappe — uanset "spørg hvor filer skal
gemmes"-indstillingen (udokumenteret macOS/Chromium-sandbox-adfærd,
[issues.chromium.org/issues/40359474](https://issues.chromium.org/issues/40359474)).
Ingen mængde forudoprettede placeholder-mapper kunne omgå det pålideligt —
se `09-file-system-access-migration.md` i ValdiVault for hele forløbet.

Løsningen: brugeren vælger vault-mappen **én gang** via en mappe-dialog i
options-siden (File System Access API). Selve fil-skrivningen sker i et
offscreen-dokument (`offscreen.html`/`offscreen.js`), fordi service workeren
ikke selv har DOM-/File-System-Access-adgang. Ingen flere OS-prompts,
uanset hvor mange nye undermapper der oprettes.

**Opsætning:** åbn extensionens indstillinger → "Vælg vault-mappe…" → peg
direkte på din vault (fx `~/ViaVault`). Ingen `vaultFolderName`-indstilling
længere — den fysiske mappe du vælger *er* vault-roden.

Skrive-tilladelsen overlever ikke pålideligt en genstart af browseren eller
extensionen (kendt FSA-begrænsning, ikke noget vi kan styre fra JS) — når det
sker, viser extension-ikonet et rødt **!**-badge. Åbn indstillinger og vælg
vault-mappen igen (samme mappe), så forsvinder badge'et og skrivning virker
igen.

## Fejl-synlighed

Badge'et viser også et gult tal for antal fejlede fil-/kalender-elementer i
seneste kørsel (vault-adgang-advarslen har forrang). `chrome.notifications`
supplerer med en fejl-liste (titel + besked pr. element, kræver din
bekræftelse for at forsvinde) og en kort success-notifikation når der faktisk
blev hentet noget nyt. **macOS-forudsætning:** System Settings → Notifications
→ Google Chrome skal have stilen sat til "Bannere" eller "Advarsler" — ellers
vises intet, selvom koden virker fint. Se ValdiVault:
`10_Projects/VIAstudyWiz/11-fejlsynlighed-og-download-robusthed.md`.

## Vault-struktur

To grene pr. fag: `RAW/` er bytes til enheder (Boox/NeoReader browser bare
filsystemet), `MD/` er noter til Obsidian. Alt nyt indhold falder i én af de to,
så strukturen ikke skal lægges om igen.

Fag-mappen hedder det venlige navn fra `COURSE_DISPLAY_NAMES` i `background.js`
(fx `Musik`), ikke itslearnings tekniske kursuskode — samme tabel som allerede
bruges til kalendersyncen.

Ugemappen hedder `W<uge><dag> - <emne>` (fx `W34tors - Skolens formål`) når
planen har et `topic.name` — strukturerede data fra itslearning, bekræftet
live, ikke fritekst-parsing. Kun tilføjet fremadrettet: ældre mapper i
vaulten hedder stadig bare `W34tors` uden emne, ikke migreret retroaktivt.

```
ViaVault/<fag>/
  RAW/<uge> - <emne>/<titel>.pdf                       ← extensionen skriver kun her
  MD/<uge> - <emne>/<uge> - <emne> lektionsplan.md     ← lektionsplan + links til ugens materialer
  MD/<uge> - <emne>/<titel>.md                         ← watch-scriptets MinerU-output
  MD/<uge> - <emne>/_attachments/<titel>/<sha>.jpg     ← udtrukne billeder
```

Noterne får frontmatter (`fag`, `uge`, `type`, `kilde`, og `emne`/`start`/`stop`
når planen har dem), så `Litteratur.base` kan bygge overblik på tværs af uger
og emner uden at strukturen skal kode alting. `uge` er den rene ugekode
(`W34tors`), `emne` er sit eget felt — ikke gemt inde i mappenavnets streng.
Billed-embeds er wikilinks (`![[<sha>.jpg]]`), ikke relative stier — de
knækker på titler med parentes. Begrundelse og alternativer i ValdiVault:
`10_Projects/VIAstudyWiz/10-filsystem-design-raw-md.md`.

Migrering af en gammel flad vault: `watchfolder/migrate_to_raw_md.py` (dry-run
som standard, `--apply` udfører, `--selfcheck` kører de indbyggede tests).
Samme mønster for retroaktiv emne-tilføjelse til ugemapper
(`watchfolder/backfill_week_topics.py`) og frontmatter-berigelse af
eksisterende noter (`watchfolder/enrich_existing_notes.py`).

## Sikkerhed

Ingen session-cookies, antiforgery-tokens eller andre secrets må committes.
De skal læses dynamisk fra browserens egen session ved runtime.

## watchfolder/ — MinerU-integration

Overvåger `~/ViaVault/*/RAW/` (extensionen skriver direkte hertil via File System
Access API — se ovenfor) for nye dokumenter — pdf, docx, pptx, xlsx — sender dem til
MinerU's officielle REST API (`mineru.net/api/v4`), og skriver outputtet over i
fagets MD-gren. MinerU har ingen output-sti-indstilling; placeringen er vores egen
efterbehandling i `integrate_output()`. Samme dokument på flere lektioner
konverteres kun én gang — de øvrige uger får en henvisningsnote. Se
`10_Projects/VIAstudyWiz/07-mineru-output-integration.md` i ValdiVault.

**Opsætning:**
1. Hent et API-token på [mineru.net/apiManage/token](https://mineru.net/apiManage/token)
2. Opret `watchfolder/.env` (git-ignoreret) med:
   ```
   MINERU_API_TOKEN=dit-token-her
   ```
3. Opret isoleret venv med `uv` og installér afhængigheder:
   ```bash
   cd watchfolder
   uv venv
   source .venv/bin/activate
   uv pip install watchdog requests
   python3 watch_viastudywiz.py   # kør manuelt/i forgrunden
   ```

**Automatisk ved login (launchd):** plisten peger på `.venv/bin/python3` — kør `uv venv` + `uv pip install` (trin 3) først.
```bash
cp watchfolder/com.valdemar.viastudywiz-watchfolder.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.valdemar.viastudywiz-watchfolder.plist
```

Log: `~/Library/Logs/viastudywiz-watchfolder.log`.
