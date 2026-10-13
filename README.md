# ItsWiz

ItsWiz er et Obsidian-plugin (`plugin/`) der henter lektionsplaner, undervisningsmaterialer og
afleveringsopgaver fra via.itslearning.com (VIA University College) ind i `~/ViaVault`, konverterer
dokumenter med MinerU, synker til Hold Course og lægger personlige events i itslearning-kalenderen.
Opsætning og brug: [`plugin/README.md`](plugin/README.md).

## Installér (BRAT)

1. Installér pluginet **Obsidian42 - BRAT** fra Community plugins.
2. BRAT → *Add beta plugin* → indsæt `https://github.com/FasterMadman/itswiz` → *Add plugin*.
3. Indstillinger → Community plugins → slå **ItsWiz** til. Opdateringer henter BRAT selv fra nye releases.

Resten (login, MinerU-nøgle, kalender, hvad der skrives i vaulten) står i [`plugin/README.md`](plugin/README.md).

Chrome-extensionen og Python/launchd-laget (`watchfolder/`) som ItsWiz afløste, blev fjernet i #244;
de findes kun i git-historikken.

Kontekst, research og arkitekturbeslutninger ligger i ValdiVault:
`10_Projects/VIAstudyWiz/06-start-her.md` (ren pointer-samling, start her)
`10_Projects/VIAstudyWiz/05-api-reference.md` (aktuel teknisk reference)

## Vault-struktur

Alt maskinskrevet indhold ligger under `§ FAG/` (`FAG_ROOT` i `plugin/main.js`,
låst — se issue #29). Tre grene pr. fag: `RAW/` er bytes til enheder
(Boox/NeoReader browser bare filsystemet), `MD/` er noter til Obsidian, og
`NOTER/` er en fjerde, **manuelt ejet** gren (se nedenfor). Alt nyt maskinelt
indhold falder i `RAW/`/`MD/`, så strukturen ikke skal lægges om igen.

Fag-mappen har et fag-symbol foran det venlige navn fra `COURSE_DISPLAY_NAMES`
(`courseFolderName()`, fx `♪ Musik`) — symbolerne er kun i selve mappestien
aldrig i `fag:`-frontmatter-feltet, som
`Seminarium.base` filtrerer eksakt på (`fag == "Musik"`). Symbol-ordbogen
holdes i `⚙ META/Symbol-konvention.md` i selve vaulten, ikke her — ret begge
steder hvis et symbol ændres.

Ugemappen hedder `W<uge><dag> - <emne>` (fx `W34tors - Skolens formål`) når
planen har et `topic.name` — strukturerede data fra itslearning, bekræftet
live, ikke fritekst-parsing. Kun tilføjet fremadrettet: ældre mapper i
vaulten hedder stadig bare `W34tors` uden emne, ikke migreret retroaktivt.

```
ViaVault/§ FAG/<symbol> <fag>/
  RAW/<uge> - <emne>/<titel>.pdf                       ← ItsWiz' høst skriver kun her
  MD/<uge> - <emne>/<uge> - <emne> lektionsplan.md     ← lektionsplan + links til ugens materialer
  MD/<uge> - <emne>/<titel>.md                         ← MinerU-output (konverteringen i ItsWiz)
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
kode-afhængighed — rørt af Obsidian/QuickAdd, ikke af ItsWiz. Se
`⚙ META/Guides/` i selve vaulten (`00 - Kom i gang.md`,
`01 - QuickAdd-genveje.md`, `02 - Symboler og struktur.md`) for
brugsvejledning, og `12-notestruktur-egne-noter.md` i ValdiVault for
arkitekturbegrundelsen.

Engangsmigreringer af vaulten (kørt, bevaret som dokumentation): `watchfolder/engangsscripts/`.

## Afleveringsopgaver

Afleveringsopgaver med en reel deadline (fra
`restapi/personal/tasklistdailyworkflow/{courseId}/v1`, ét kald pr. kursus)
bliver til en note i `✎ NOTER/OPGAVER/<opgave>/<opgave>.md` med `type: opgave`
plus et personligt itslearning-kalenderevent på selve deadline-tidspunktet (når
kalendersynken er slået til), adskilt fra lektionsplan-events. Opgaver uden deadline (sentinel `9999-12-31`) springes
over — det er de samme "Forberedelse"-elementer der allerede står i
lektionsplanerne. Noten skrives kun én gang (opgavemappen er dit eget
skriveområde), mens kalendereventet opdateres hvis deadline flyttes.

Opgavens vedhæftede opgavebeskrivelse (fx en PDF) forsøges også hentet.
Filen ligger hverken i plan.elements eller i Ressourcer, kun i selve
Afleveringsopgave-værktøjet (`assignment.itslearning.com`), som kræver sin
egen SSO-handshake (session-cookie scopet til det domæne — en direkte
download-URL uden handshaket giver 403). Et skjult vindue gennemfører derfor
handshaket rigtigt (samme teknik som Office/WOPI-kæden), og filens rigtige
download-URL læses ud af sidens `fileListControl.initialize(...)`-data
bagefter. Lander i `✎ NOTER/OPGAVER/<opgave>/RAW/`, samme RAW/MD-mønster som
`§ FAG/` — konverteringen laver den til `.../MD/<filnavn>.md`, og noten
linker dertil (ikke til RAW-filen, samme regel som issue #26). Fejler blødt:
ingen vedhæftning fundet er ikke en fejl, kun kilde-linket er så det eneste.
Kører kun én gang pr. opgave (samme dedup som selve noten), ikke ved hver
kørsel.

## Sikkerhed

Ingen session-cookies, antiforgery-tokens eller andre secrets må committes.
De skal læses dynamisk fra browserens egen session ved runtime.

## Udvikling — tests

```bash
node --test plugin/test/*.test.js
git config core.hooksPath .githooks   # én gang: pre-push kører testene
```

`.githooks/` indeholder også `post-commit`/`post-checkout` der kører graphify-rs (springes over hvis
`graphify-rs` ikke er installeret), så `core.hooksPath` ikke slår dem fra.
