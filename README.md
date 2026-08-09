# VIAstudyWiz — itslearning extension

Browser extension der automatiserer indsamling af lektionsplaner og
undervisningsmaterialer fra via.itslearning.com (VIA University College).

Del af VIAstudyWiz-pipelinen. Kontekst, research og arkitekturbeslutninger
ligger i ValdiVault:
`10_Projects/VIAstudyWiz/06-handover-frisk-chat.md` (arbejdsdokument)
`10_Projects/VIAstudyWiz/05-teknisk-research-itslearning-api.md` (fuld research-log)

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

## Sikkerhed

Ingen session-cookies, antiforgery-tokens eller andre secrets må committes.
De skal læses dynamisk fra browserens egen session ved runtime.

## watchfolder/ — MinerU-integration

Overvåger `~/ViaVault/` (extensionen skriver direkte hertil via File System
Access API — se ovenfor) for nye PDF'er, sender dem til MinerU's officielle REST API
(`mineru.net/api/v4`), og flytter/omdøber outputtet ind ved siden af den
originale PDF. Se `10_Projects/VIAstudyWiz/07-mineru-output-integration.md`
i ValdiVault.

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
