# ItsWiz

ItsWiz is an Obsidian plugin (`plugin/`) that harvests lesson plans, teaching materials and assignments from
via.itslearning.com (VIA University College) into your vault, converts documents with MinerU, syncs to
Hold Course and puts personal events in the itslearning calendar.
Setup and usage: [`plugin/README.md`](plugin/README.md).

## Install (BRAT)

1. Install the **Obsidian42 - BRAT** plugin from Community plugins.
2. BRAT → *Add beta plugin* → paste `https://github.com/FasterMadman/itswiz` → *Add plugin*.
3. Settings → Community plugins → enable **ItsWiz**. BRAT picks up updates from new releases by itself.

The rest (login, MinerU key, calendar, what gets written to the vault) is in [`plugin/README.md`](plugin/README.md).

The Chrome extension and the Python/launchd layer (`watchfolder/`) that ItsWiz replaced were removed in #244;
they only exist in git history.

Context, research and architecture decisions live in ValdiVault (Danish, the maintainer's own vault):
`10_Projects/VIAstudyWiz/06-start-her.md` (pure pointer collection, start here)
`10_Projects/VIAstudyWiz/05-api-reference.md` (current technical reference)

## Vault structure

The generated notes and folder names are in Danish (e.g. `§ FAG`, `NOTER`, `W34tors`): they are tied to
existing vaults and `.base` files and are not translated (see #266 for the folder architecture).

All machine-written content lives under `§ FAG/` (`FAG_ROOT` in `plugin/main.js`,
locked, see issue #29). Three branches per subject: `RAW/` is bytes for devices
(Boox/NeoReader browse the bare filesystem), `MD/` is notes for Obsidian, and
`NOTER/` is a fourth, **manually owned** branch (see below). New machine-written
content always falls into `RAW/`/`MD/` so the structure never has to be reorganised again.

The subject folder is named after the subject: the name chosen per itslearning course code in the
`courseNames` setting (`courseFolderName()`, e.g. `Musik`), or the raw code when none is set. No symbols
in folder names (#270): icons and colours belong to Hold Course. The same name is the `fag:` frontmatter
field, which `Seminarium.base` filters on exactly (`fag == "Musik"`).

The week folder is named `W<week><day> - <topic>` (e.g. `W34tors - Skolens formål`) when the plan
has a `topic.name`: structured data from itslearning, confirmed live, not free-text parsing.
Only added going forward: older folders in the vault are still just `W34tors` without a topic,
not migrated retroactively.

```
ViaVault/§ FAG/<subject>/
  RAW/<week> - <topic>/<title>.pdf                       ← ItsWiz' harvest only writes here
  MD/<week> - <topic>/<week> - <topic> lektionsplan.md   ← lesson plan + links to the week's materials
  MD/<week> - <topic>/<title>.md                         ← MinerU output (ItsWiz' conversion)
  MD/<week> - <topic>/_attachments/<title>/<sha>.jpg     ← extracted images
  NOTER/<week> - <topic>/<week> - <topic> note.md        ← lecture-note STUB, see below
```

The notes get frontmatter (`fag`, `uge`, `type`, `kilde`, and `emne`/`start`/`stop`
when the plan has them), so `Seminarium.base` can build overviews across weeks
and topics without the structure encoding everything. `uge` is the plain week code
(`W34tors`), `emne` is its own field, not buried in the folder name string.
Image embeds are wikilinks (`![[<sha>.jpg]]`), not relative paths: those
break on titles with parentheses. Rationale and alternatives in ValdiVault:
`10_Projects/VIAstudyWiz/10-filsystem-design-raw-md.md`.

### `NOTER/` — lecture-note stub (issue #68)

`writePlanNotes` writes, in the same run as the lesson plan, an empty
lecture-note stub in `§ FAG/<subject>/NOTER/<week>/` with `fag`/`uge`/`emne`/
`kilde:` already filled in from itslearning data: no manual creation,
no hand-written frontmatter. **Create-if-not-exists** via a real file check
(`readFromVault`), run independently of the lesson-plan hash: the stub is written
even when the lesson plan doesn't change, and if it already exists it is
never touched again. It is the user's writing surface.

`NOTER/` is a sibling of `RAW/`+`MD/`, not a separate top root. See
`12-notestruktur-egne-noter.md` §11 in ValdiVault for why (short version:
one place per subject instead of several roots to remember, decided with
ADHD in mind in issue #65).

### ⚒ Forberedelse (preparation): read-something vs. do-something (issue #59)

itslearning's `Arbejdsopgave` elements (typically titled "Forberedelse") carry
no content in `plan.elements`, only a URL to
`/CustomActivity/CustomActivityOverview.aspx`. That page is plain
server-rendered HTML, so `collectRangeInPage` fetches the description with a plain
`fetch` (no SSO handshake, no hidden tab) and reads it out of the page's single
`.h-userinput` element. Embedded documents (Google Docs etc.) are iframes behind
itslearning's oembed viewer and are unpacked into real links, otherwise
`stripHtml` would remove them entirely.

The result lands **in two places with a job each**:

- **The lesson-plan note** (`MD/`): `forberedelse:` in frontmatter (`false` when
  there is nothing) drives `Seminarium.base`'s ⚒ column, and a
  `## ⚒ Forberedelse` section in the AUTO block has the full content with
  clickable markdown links. Machine-owned, so the teacher's corrections follow along.
- **The lecture-note stub** (`NOTER/`): `- [ ] ⚒ <title>` per element.
  Written at creation, and new elements are **appended** later if the
  teacher adds something. Existing lines, and thereby your ticks, are never touched.

The read/do split lives in the *carrier*, not in the content: itslearning has one
free-text field, so a "Forberedelse" element can easily contain pure
literature. That is why `litteratur:` (from the plan's own field) and
`forberedelse:` (from the elements) are two independent fields, each with its own
symbol and column. The code never guesses what the text "really" is.

### Own notes, the Obsidian side

`VIDEN/` (permanent notes + EMR-generated literature notes),
`✎ NOTER/OPGAVER/` (assignments) and `Egne noter.base` are pure vault structure with no
code dependency, touched by Obsidian/QuickAdd, not by ItsWiz. See
`⚙ META/Guides/` in the vault itself (`00 - Kom i gang.md`,
`01 - QuickAdd-genveje.md`, `02 - Symboler og struktur.md`) for
usage, and `12-notestruktur-egne-noter.md` in ValdiVault for
the architectural rationale.

One-off vault migrations (run, kept as documentation): `watchfolder/engangsscripts/`.

## Assignments

Assignments with a real deadline (from
`restapi/personal/tasklistdailyworkflow/{courseId}/v1`, one call per course)
become a note in `✎ NOTER/OPGAVER/<assignment>/<assignment>.md` with `type: opgave`
plus a personal itslearning calendar event at the deadline time (when
calendar sync is on), separate from lesson-plan events. Assignments without a deadline (sentinel `9999-12-31`) are
skipped: they are the same "Forberedelse" elements that already appear in the
lesson plans. The note is written only once (the assignment folder is your own
writing area), while the calendar event is updated if the deadline moves.

The assignment's attached description (e.g. a PDF) is also fetched when possible.
The file is neither in plan.elements nor in Ressourcer, only in the
Afleveringsopgave tool itself (`assignment.itslearning.com`), which requires its
own SSO handshake (session cookie scoped to that domain: a direct
download URL without the handshake gives 403). A hidden window therefore completes the
handshake properly (same technique as the Office/WOPI chain), and the file's real
download URL is read out of the page's `fileListControl.initialize(...)` data
afterwards. It lands in `✎ NOTER/OPGAVER/<assignment>/RAW/`, the same RAW/MD pattern as
`§ FAG/`: the conversion turns it into `.../MD/<filename>.md`, and the note
links there (not to the RAW file, same rule as issue #26). Fails softly:
no attachment found is not an error, only the source link is then the only one.
Runs only once per assignment (same dedup as the note itself), not on every
run.

## Security

No session cookies, anti-forgery tokens or other secrets may be committed.
They must be read dynamically from the browser's own session at runtime.

## Development: tests

```bash
node --test plugin/test/*.test.js
git config core.hooksPath .githooks   # once: pre-push runs the tests
```

`.githooks/` also contains `post-commit`/`post-checkout` that run graphify-rs (skipped if
`graphify-rs` is not installed), so `core.hooksPath` doesn't switch them off.
