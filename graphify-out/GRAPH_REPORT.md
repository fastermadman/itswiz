# 📊 Graph Analysis Report

**Root:** `.`

## Summary

| Metric | Value |
|--------|-------|
| Nodes | 373 |
| Edges | 739 |
| Communities | 26 |
| Hyperedges | 0 |

### Confidence Breakdown

| Level | Count | Percentage |
|-------|-------|------------|
| EXTRACTED | 355 | 48.0% |
| INFERRED | 384 | 52.0% |
| AMBIGUOUS | 0 | 0.0% |

## 🌟 God Nodes (Most Connected)

| Node | Degree | Community |
|------|--------|-----------|
| background | 83 | 0 |
| watch_viastudywiz | 61 | 1 |
| sync_hold_course | 55 | 2 |
| migrate_to_enhed_mapper | 38 | 4 |
| writePlanNotes() | 30 | 0 |
| migrate_to_raw_md | 24 | 3 |
| selfcheck() | 17 | 7 |
| sync_data() | 17 | 23 |
| downloadFileElements() | 16 | 0 |
| syncCalendar() | 15 | 0 |

## 🔮 Surprising Connections

- **watchfolder_sync_hold_course_py_ensure_lecture** → **watchfolder_sync_hold_course_py_nfc** (calls)
- **watchfolder_sync_hold_course_py_ensure_resource** → **watchfolder_sync_hold_course_py_find_stamped** (calls)
- **watchfolder_sync_hold_course_py_ensure_resource** → **watchfolder_sync_hold_course_py_nfc** (calls)
- **watchfolder_sync_hold_course_py_ensure_assignment** → **watchfolder_sync_hold_course_py_nfc** (calls)
- **watchfolder_sync_hold_course_py_sync_data** → **watchfolder_sync_hold_course_py_generate_id** (calls)

## 🏘️ Communities

### Community 0 — ymd() (84 nodes, cohesion: 0.06)

- background
- buildEventDescription()
- callCalendarApi()
- collectAndDownload()
- collectRangeInPage()
- completeTasks()
- courseCalendarName()
- courseDisplayName()
- courseFolderName()
- downloadFileElements()
- downloadTaskAttachment()
- enhedFolder()
- ensureOffscreenDocument()
- existingMaterialeIds()
- existingRawIds()
- existsInVault()
- expandFolderElement()
- extractAssignmentFile()
- extractExtension()
- extractExtensionFromWopi()
- _…and 64 more_

### Community 1 — sync_hold_course_quietly() (35 nodes, cohesion: 0.08)

- watch_viastudywiz
- api_request()
- _bisect_blocks()
- DocumentHandler
- .on_created()
- enrich_from_plan_note()
- datetime
- functools.lru_cache
- hashlib
- json
- pathlib.Path
- re
- requests
- shutil
- subprocess
- sync_hold_course
- sys
- tempfile
- threading
- time
- _…and 15 more_

### Community 2 — write_forloeb_mirrors() (34 nodes, cohesion: 0.09)

- sync_hold_course
- _cell()
- course_url()
- enhed_from_link()
- ensure_all_semesters()
- ensure_assignment()
- ensure_class()
- ensure_lecture()
- find_stamped()
- forloeb_path()
- generate_id()
- hhmm()
- datetime.date
- json
- pathlib.Path
- re
- ssl
- sys
- tempfile
- time
- _…and 14 more_

### Community 3 — to_wikilinks() (25 nodes, cohesion: 0.12)

- migrate_to_raw_md
- add_frontmatter()
- collapse_duplicate()
- destination()
- find_fag_dirs()
- fingerprint()
- hashlib
- pathlib.Path
- re
- shutil
- sys
- watch_viastudywiz.ATTACHMENTS_DIR_NAME
- watch_viastudywiz.frontmatter
- watch_viastudywiz.MD_DIR_NAME
- watch_viastudywiz.md_targets
- watch_viastudywiz.RAW_DIR_NAME
- watch_viastudywiz.VAULT_ROOT
- watch_viastudywiz.write_duplicate_stub
- main()
- plan_duplicate_stubs()
- _…and 5 more_

### Community 4 — _suffix_all() (23 nodes, cohesion: 0.10)

- migrate_to_enhed_mapper
- fingerprint()
- folder_date()
- _has_real_content()
- datetime
- hashlib
- pathlib.Path
- re
- shutil
- sys
- unicodedata
- watch_viastudywiz.ATTACHMENTS_DIR_NAME
- watch_viastudywiz.FOLDER_SYMBOLS
- watch_viastudywiz.MD_DIR_NAME
- watch_viastudywiz.RAW_DIR_NAME
- watch_viastudywiz.VAULT_ROOT
- is_ghost()
- Plan
- .__init__()
- read_fm()
- _…and 3 more_

### Community 5 — wikilink_target() (17 nodes, cohesion: 0.24)

- apply_link_rewrites()
- classify_folder()
- count_rewrites()
- enhed_for()
- folder_fallback_date()
- _link_patterns()
- main()
- nfc()
- normalize_time_fm()
- plain_fag()
- plan_dublets()
- plan_fag()
- resolve_note()
- sanitize()
- selfcheck()
- split_folder()
- wikilink_target()

### Community 6 — week_folder_base() (12 nodes, cohesion: 0.30)

- enrich_existing_notes
- clean_uge_field()
- pathlib.Path
- re
- sys
- inject_fields()
- main()
- plan_enrichments()
- sanitize()
- selfcheck()
- to_space_datetime()
- week_folder_base()

### Community 7 — wikilink_target() (7) (12 nodes, cohesion: 0.33)

- append_file_list_field()
- nfc()
- _owned_targets()
- parse_frontmatter()
- patch_pending_materiale()
- prefixed_lines()
- read_plans()
- read_tasks()
- remove_file_list_lines()
- selfcheck()
- wikilink_for()
- wikilink_target()

### Community 8 — writeFile() (12 nodes, cohesion: 0.38)

- offscreen
- copyRecursive()
- countPlanNotes()
- fileExists()
- findDirEntryNormalized()
- getDirectoryHandleTolerant()
- getTargetDirectory()
- getVaultHandle()
- moveDir()
- readFile()
- vaultPermissionError()
- writeFile()

### Community 9 — write_duplicate_stub() (11 nodes, cohesion: 0.27)

- already_converted()
- cached_zip()
- error_marker_path()
- existing_conversion()
- md_targets()
- previously_failed()
- process_document()
- sanitize()
- submit()
- write_cache()
- write_duplicate_stub()

### Community 10 — main() (11 nodes, cohesion: 0.24)

- backfill_footnotes
- build_raw_index()
- digest_of()
- has_footnotes()
- hashlib
- json
- pathlib.Path
- sys
- watch_viastudywiz
- zipfile
- main()

### Community 11 — selfcheck() (11 nodes, cohesion: 0.22)

- reconvert_double_page
- find_affected()
- pathlib.Path
- re
- shutil
- sys
- watch_viastudywiz.has_highlights
- watch_viastudywiz.md_targets
- watch_viastudywiz.VAULT_ROOT
- main()
- selfcheck()

### Community 12 — selfcheck() (12) (9 nodes, cohesion: 0.33)

- backfill_week_topics
- pathlib.Path
- re
- sys
- main()
- plan_renames()
- rewrite_references()
- sanitize()
- selfcheck()

### Community 13 — next_nonblank() (8 nodes, cohesion: 0.36)

- strip_empty_headings
- fix()
- pathlib.Path
- re
- sys
- looks_like_lost_title()
- main()
- next_nonblank()

### Community 14 — selfcheck() (14) (8 nodes, cohesion: 0.32)

- rename_lektionsplan_notes
- fix_backlinks()
- pathlib.Path
- re
- sys
- main()
- rename_in_week_dir()
- selfcheck()

### Community 15 — selfcheck() (15) (7 nodes, cohesion: 0.38)

- fix_fag_symbol_prefix
- pathlib.Path
- re
- sys
- main()
- rewrite_fag()
- selfcheck()

### Community 16 — reformat() (7 nodes, cohesion: 0.38)

- reformat_material_links
- find_raw_file()
- pathlib.Path
- re
- sys
- main()
- reformat()

### Community 17 — _printed_page_number() (7 nodes, cohesion: 0.29)

- _first_anchor_text()
- _format_page_marker()
- _group_blocks_by_page()
- insert_page_markers()
- _page_footnotes()
- _page_sizes()
- _printed_page_number()

### Community 18 — selfcheck() (18) (7 nodes, cohesion: 0.38)

- rename_fag_folders
- pathlib.Path
- re
- sys
- main()
- rewrite_references()
- selfcheck()

### Community 19 — rewrite_links() (6 nodes, cohesion: 0.40)

- fix_stale_fag_root_links
- pathlib.Path
- re
- sys
- main()
- rewrite_links()

### Community 20 — write_conversion() (5 nodes, cohesion: 0.40)

- _extract_running_header()
- has_highlights()
- integrate_output()
- to_wikilinks()
- write_conversion()

### Community 21 — time_fields_from_start() (5 nodes, cohesion: 0.50)

- format_now()
- frontmatter()
- plain_fag()
- selfcheck()
- time_fields_from_start()

### Community 22 — trigger_obsidian_reload() (5 nodes, cohesion: 0.40)

- prune_dead_links()
- reconcile_onyx()
- sync()
- sync_task_completion()
- trigger_obsidian_reload()

### Community 23 — sync_data() (5 nodes, cohesion: 0.50)

- ensure_resource()
- migrate_notes_to_description()
- prune_stale_resource_classes()
- stable_key()
- sync_data()

### Community 24 — fsSet() (4 nodes, cohesion: 0.83)

- fsHandle
- fsGet()
- fsOpenDb()
- fsSet()

### Community 25 — refreshVaultDirStatus() (3 nodes, cohesion: 1.00)

- options
- load()
- refreshVaultDirStatus()

## 🕳️ Knowledge Gaps

No isolated nodes.

## 💰 Token Cost

| File | Tokens |
|------|--------|
| output | 0 |
| input | 0 |
| **Total** | **0** |

## ❓ Suggested Questions

1. How does 'watchfolder_sync_hold_course_py_sync_task_completion' relate to 3 different communities (trigger_obsidian_reload(), wikilink_target() (7), write_forloeb_mirrors())?
1. How does 'watchfolder_watch_viastudywiz_py_selfcheck' relate to 5 different communities (write_conversion(), write_duplicate_stub(), sync_hold_course_quietly(), time_fields_from_start(), _printed_page_number())?
1. How does 'watchfolder_sync_hold_course_py_migrate_notes_to_description' relate to 3 different communities (sync_data(), write_forloeb_mirrors(), wikilink_target() (7))?
1. How does 'watchfolder_sync_hold_course_py_nfc' relate to 3 different communities (write_forloeb_mirrors(), wikilink_target() (7), sync_data())?
1. How does 'watchfolder_sync_hold_course_py_reconcile_onyx' relate to 3 different communities (write_forloeb_mirrors(), trigger_obsidian_reload(), wikilink_target() (7))?
1. How does 'watchfolder_watch_viastudywiz_py_process_document_with_watchdog' relate to 3 different communities (sync_hold_course_quietly(), write_duplicate_stub(), time_fields_from_start())?
1. How does 'watchfolder_sync_hold_course_py_wikilink_target' relate to 3 different communities (write_forloeb_mirrors(), wikilink_target() (7), sync_data())?

---
_Generated by graphify-rs_
