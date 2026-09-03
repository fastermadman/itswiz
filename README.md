# VIAstudyWiz — itslearning extension

Browser extension der automatiserer indsamling af lektionsplaner og
undervisningsmaterialer fra via.itslearning.com (VIA University College).

Del af VIAstudyWiz-pipelinen. Kontekst, research og arkitekturbeslutninger
ligger i ValdiVault:
`10_Projects/VIAstudyWiz/06-start-her.md` (ren pointer-samling, start her)
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

Alt maskinskrevet indhold ligger under `§ FAG/` (`FAG_ROOT` i `background.js`,
låst — se issue #29). Tre grene pr. fag: `RAW/` er bytes til enheder
(Boox/NeoReader browser bare filsystemet), `MD/` er noter til Obsidian, og
`NOTER/` er en fjerde, **manuelt ejet** gren (se nedenfor). Alt nyt maskinelt
indhold falder i `RAW/`/`MD/`, så strukturen ikke skal lægges om igen.

Fag-mappen har et fag-symbol foran det venlige navn fra `COURSE_DISPLAY_NAMES`
(`courseFolderName()`, fx `♪ Musik`) — symbolerne er kun i selve mappestien
(og Google Calendar-navnet), aldrig i `fag:`-frontmatter-feltet, som
`Seminarium.base` filtrerer eksakt på (`fag == "Musik"`). Symbol-ordbogen
holdes i `⚙ META/Symbol-konvention.md` i selve vaulten, ikke her — ret begge
steder hvis et symbol ændres.

Ugemappen hedder `W<uge><dag> - <emne>` (fx `W34tors - Skolens formål`) når
planen har et `topic.name` — strukturerede data fra itslearning, bekræftet
live, ikke fritekst-parsing. Kun tilføjet fremadrettet: ældre mapper i
vaulten hedder stadig bare `W34tors` uden emne, ikke migreret retroaktivt.

```
ViaVault/§ FAG/<symbol> <fag>/
  RAW/<uge> - <emne>/<titel>.pdf                       ← extensionen skriver kun her
  MD/<uge> - <emne>/<uge> - <emne> lektionsplan.md     ← lektionsplan + links til ugens materialer
  MD/<uge> - <emne>/<titel>.md                         ← watch-scriptets MinerU-output
  MD/<uge> - <emne>/_attachments/<titel>/<sha>.jpg     ← udtrukne billeder
  NOTER/<uge> - <emne>/<uge> - <emne> note.md          ← forelæsningsnote-STUB, se nedenfor
```

Noterne får frontmatter (`fag`, `uge`, `type`, `kilde`, og `emne`/`start`/`stop`
når planen har dem), så `Seminarium.base` kan bygge overblik på tværs af uger
og emner uden at strukturen skal kode alting. `uge` er den rene ugekode
(`W34tors`), `emne` er sit eget felt — ikke gemt inde i mappenavnets streng.
Billed-embeds er wikilinks (`![[<sha>.jpg]]`), ikke relative stier — de
knækker på titler med parentes. Begrundelse og alternativer i ValdiVault:
`10_Projects/VIAstudyWiz/10-filsystem-design-raw-md.md`.

### `NOTER/` — forelæsningsnote-stub (issue #68)

`writePlanNotes` skriver, i samme kørsel som lektionsplanen, en tom
forelæsningsnote-stub i `§ FAG/<fag>/NOTER/<uge>/` med `fag`/`uge`/`emne`/
`kilde:` allerede udfyldt fra itslearning-data — ingen manuel oprettelse,
intet frontmatter i hånden. **Create-if-not-exists** via et rigtigt fil-tjek
(`readFromVault`), kørt uafhængigt af lektionsplan-hashet: stubben skrives
selv når lektionsplanen ikke ændrer sig, og findes den allerede, røres den
aldrig igen — det er brugerens skriveflade.

`NOTER/` er søskende til `RAW/`+`MD/`, ikke en separat top-rod — se
`12-notestruktur-egne-noter.md` §11 i ValdiVault for hvorfor (kort version:
ét sted pr. fag i stedet for flere rødder at huske, besluttet efter
ADHD-hensyn i issue #65).

### ⚒ Forberedelse — læs-noget vs. gør-noget (issue #59)

itslearnings `Arbejdsopgave`-elementer (typisk titlen "Forberedelse") bærer
intet indhold i `plan.elements` — kun en URL til
`/CustomActivity/CustomActivityOverview.aspx`. Den side er almindelig
server-renderet HTML, så `collectRangeInPage` henter beskrivelsen med en ren
`fetch` (ingen SSO-handshake, ingen skjult fane) og læser den ud af sidens ene
`.h-userinput`-element. Indlejrede dokumenter (Google Docs m.fl.) ligger som
iframes bag itslearnings oembed-viser og pakkes ud til rigtige links, ellers
ville `stripHtml` fjerne dem helt.

Resultatet lander **to steder med hver sit job**:

- **Lektionsplan-noten** (`MD/`): `forberedelse:` i frontmatter (`false` når
  der ikke er noget) driver `Seminarium.base`s ⚒-kolonne, og en
  `## ⚒ Forberedelse`-sektion i AUTO-blokken har det fulde indhold med
  klikbare markdown-links. Maskin-ejet, så underviserens rettelser følger med.
- **Forelæsningsnote-stubben** (`NOTER/`): `- [ ] ⚒ <titel>` pr. element.
  Skrives ved oprettelsen, og nye elementer **appendes** senere hvis
  underviseren tilføjer noget — eksisterende linjer, og dermed dine
  afkrydsninger, røres aldrig.

Skellet læs/gør ligger i *bæreren*, ikke i indholdet: itslearning har ét
fritekstfelt, så et "Forberedelse"-element kan sagtens indeholde ren
litteratur. Derfor står `litteratur:` (fra planens eget felt) og
`forberedelse:` (fra elementerne) som to uafhængige felter, med hver sit
symbol og sin kolonne — koden gætter aldrig på hvad teksten "egentlig" er.

Snitfladen til afleveringsopgaver (nedenfor) er skarp: **deadline → egen note
i `✎ NOTER/OPGAVER/`, ingen deadline → linje i lektionens noter.** De to kan
ikke overlappe, fordi opgave-noterne allerede filtrerer sentinel-deadlinen
`9999-12-31` fra.

### Egne noter, Obsidian-siden

`VIDEN/` (permanente noter + EMR-genererede literature-noter),
`✎ NOTER/OPGAVER/` (opgaver) og `Egne noter.base` er ren vault-struktur uden
kode-afhængighed — rørt af Obsidian/QuickAdd, ikke af denne extension. Se
`⚙ META/Guides/` i selve vaulten (`00 - Kom i gang.md`,
`01 - QuickAdd-genveje.md`, `02 - Symboler og struktur.md`) for
brugsvejledning, og `12-notestruktur-egne-noter.md` i ValdiVault for
arkitekturbegrundelsen.

Migrering af en gammel flad vault: `watchfolder/migrate_to_raw_md.py` (dry-run
som standard, `--apply` udfører, `--selfcheck` kører de indbyggede tests).
Samme mønster for retroaktiv emne-tilføjelse til ugemapper
(`watchfolder/backfill_week_topics.py`) og frontmatter-berigelse af
eksisterende noter (`watchfolder/enrich_existing_notes.py`).

## Afleveringsopgaver

Afleveringsopgaver med en reel deadline (fra
`restapi/personal/tasklistdailyworkflow/{courseId}/v1`, ét kald pr. kursus)
bliver til en note i `✎ NOTER/OPGAVER/<opgave>/<opgave>.md` med `type: opgave`
plus et kalenderevent på selve deadline-tidspunktet, adskilt fra
lektionsplan-events. Opgaver uden deadline (sentinel `9999-12-31`) springes
over — det er de samme "Forberedelse"-elementer der allerede står i
lektionsplanerne. Noten skrives kun én gang (opgavemappen er dit eget
skriveområde), mens kalendereventet opdateres hvis deadline flyttes.

Opgavens vedhæftede opgavebeskrivelse (fx en PDF) forsøges også hentet.
Filen ligger hverken i plan.elements eller i Ressourcer, kun i selve
Afleveringsopgave-værktøjet (`assignment.itslearning.com`), som kræver sin
egen SSO-handshake (session-cookie scopet til det domæne — en direkte
download-URL uden handshaket giver 403). En skjult fane gennemfører derfor
handshaket rigtigt (samme teknik som Office/WOPI-kæden), og filens rigtige
download-URL læses ud af sidens `fileListControl.initialize(...)`-data
bagefter. Lander i `✎ NOTER/OPGAVER/<opgave>/RAW/`, samme RAW/MD-mønster som
`§ FAG/` — watchfolderen konverterer den til `.../MD/<filnavn>.md`, og noten
linker dertil (ikke til RAW-filen, samme regel som issue #26). Fejler blødt:
ingen vedhæftning fundet er ikke en fejl, kun kilde-linket er så det eneste.
Kører kun én gang pr. opgave (samme dedup som selve noten), ikke ved hver
kørsel.

## Sikkerhed

Ingen session-cookies, antiforgery-tokens eller andre secrets må committes.
De skal læses dynamisk fra browserens egen session ved runtime.

## watchfolder/ — MinerU-integration

Overvåger `~/ViaVault/**/RAW/` rekursivt — sti-agnostisk, ikke hardcodet til
`§ FAG/` (extensionen skriver direkte hertil via File System
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

## Udvikling — selvtjek

`watchfolder/sync_hold_course.py` har indbyggede tests (`--selfcheck`, kun stdlib, kræver ikke
vaulten). Aktivér `pre-push`-hooket så et push blokeres hvis de fejler:

```bash
git config core.hooksPath .githooks
```

Hooket (`.githooks/pre-push`) kører begge selvtjek. Var brudt uset i uger efter enhed-migreringen
(#139) — derfor denne vagt. `.githooks/` indeholder også `post-commit`/`post-checkout` der kører
graphify-rs (springes over hvis `graphify-rs` ikke er installeret), så `core.hooksPath` ikke slår
dem fra.
