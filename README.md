# VIAstudyWiz — itslearning extension

Browser extension der automatiserer indsamling af lektionsplaner og
undervisningsmaterialer fra via.itslearning.com (VIA University College).

Del af VIAstudyWiz-pipelinen. Kontekst, research og arkitekturbeslutninger
ligger i ValdiVault:
`10_Projects/VIAstudyWiz/06-handover-frisk-chat.md` (arbejdsdokument)
`10_Projects/VIAstudyWiz/05-teknisk-research-itslearning-api.md` (fuld research-log)

## Status

Research afsluttet — API-flade og download-kæder for PDF og Office-filer
(.docx/.pptx/.xlsx) er begge kortlagt og løst. Se handover-noten for
fund-oversigt og resterende åbne punkter. Build-fase starter nu, tracket
som GitHub Issues i dette repo.

## Sikkerhed

Ingen session-cookies, antiforgery-tokens eller andre secrets må committes.
De skal læses dynamisk fra browserens egen session ved runtime.

## watchfolder/ — MinerU-integration

Overvåger `~/ViaVault/` (symlinket ind i `~/Downloads/ViaVault` — skjult
symlink, så Chrome kan skrive dertil uden at mappen roder i Downloads-
oversigten) for nye PDF'er, sender dem til MinerU's officielle REST API
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
