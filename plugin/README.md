# ItsWiz

ItsWiz is an itslearning harvester as an Obsidian plugin: lesson plans, materials and assignments
are pulled into your vault without Chrome. The logic was copied from the Chrome extension's `background.js`,
which was deleted in #244.

## Install for fellow students (BRAT)

1. Install **Obsidian42 - BRAT** (Community plugins) and enable it.
2. BRAT → *Add beta plugin* → `https://github.com/FasterMadman/itswiz`. Enable **ItsWiz** under Community plugins.
3. Click the graduation-cap icon in the left ribbon and log in to itslearning. Press **Harvest now**.
4. *MinerU key* (optional, only for converting PDF/Office files to notes): get a free key at mineru.net
   (log in → API → token), paste it into ItsWiz' settings and turn *Convert RAW files* on.
5. *Calendar*: itslearning only shows events from courses you have **starred**. Star the courses you want
   in itslearning, then turn on *Personal calendar events in itslearning*.
6. What ItsWiz writes to the vault: everything under `§ FAG/` (lesson plans in `MD/`, downloaded files in `RAW/`,
   empty lecture notes in `NOTER/`) and assignments in `✎ NOTER/OPGAVER/`. Nothing outside those two folders, and
   `ItsWiz-test/` only for the path test. The generated notes and folder names are Danish.

## Usage (development: symlink from the repo)

1. Symlink into the vault (done for ViaVault), from the repo root:
   `mkdir -p ~/ViaVault/.obsidian/plugins/itswiz && ln -sf "$PWD"/plugin/{main.js,manifest.json} ~/ViaVault/.obsidian/plugins/itswiz/`
2. Obsidian → Settings → Community plugins → enable **ItsWiz**.
3. Click the graduation-cap icon in the left ribbon and log in to itslearning in the tab.
4. ViaVault has had the extension's data imported (command **Import VIAstudyWiz data from the
   clipboard**, #239). The extension is gone (#244), so in a new vault with old VIAstudyWiz notes
   ItsWiz refuses to harvest, because the first run would rewrite all lesson plans.
5. **Harvest now** (button in the tab or command). **Path test** fetches one file per download route into
   `ItsWiz-test/` and does not touch `§ FAG` or `✎ NOTER`.

6. After that the harvest runs by itself at Obsidian start and at the interval in the settings (default 24 hours).
   The status bar shows the last run and the number of errors; click it for the error list. An expired itslearning
   login is renewed automatically via Microsoft's "Stay signed in"; if that fails, you get one notice and the ItsWiz tab opens.

7. **Calendar (#243):** turn on "Personal calendar events in itslearning" in the settings (default off). Each harvest
   creates/fixes/moves one personal event per lesson and assignment deadline and cancels (`AFLYST · `) lessons
   that have disappeared from itslearning. ItsWiz only touches events in `calendarEventMap` in `data.json`. The command
   **Remove all ItsWiz calendar events** deletes them again.

Desktop only. No build, no dependencies. Test: `node --test plugin/test/*.test.js`.
