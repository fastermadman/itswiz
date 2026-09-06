# 📊 Graph Analysis Report

**Root:** `.`

## Summary

| Metric | Value |
|--------|-------|
| Nodes | 373 |
| Edges | 739 |
| Communities | 19 |
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
| migrate_to_enhed_mapper | 38 | 3 |
| writePlanNotes() | 30 | 0 |
| migrate_to_raw_md | 24 | 4 |
| sync_data() | 17 | 2 |
| selfcheck() | 17 | 2 |
| downloadFileElements() | 16 | 0 |
| syncCalendar() | 15 | 0 |

## 🔮 Surprising Connections

- **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_plan_fag** → **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_is_ghost** (calls)
- **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_plan_fag** → **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_resolve_targets** (calls)
- **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_plan_dublets** → **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_split_folder** (calls)
- **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_main** → **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_plan_dublets** (calls)
- **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_main** → **watchfolder_engangsscripts_migrate_to_enhed_mapper_py_rel** (calls)

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

### Community 1 — write_duplicate_stub() (63 nodes, cohesion: 0.06)

- watch_viastudywiz
- already_converted()
- api_request()
- _bisect_blocks()
- cached_zip()
- DocumentHandler
- .on_created()
- enrich_from_plan_note()
- error_marker_path()
- existing_conversion()
- _extract_running_header()
- _first_anchor_text()
- format_now()
- _format_page_marker()
- frontmatter()
- _group_blocks_by_page()
- has_highlights()
- datetime
- functools.lru_cache
- hashlib
- _…and 43 more_

### Community 2 — write_forloeb_mirrors() (56 nodes, cohesion: 0.09)

- sync_hold_course
- append_file_list_field()
- _cell()
- course_url()
- enhed_from_link()
- ensure_all_semesters()
- ensure_assignment()
- ensure_class()
- ensure_lecture()
- ensure_resource()
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
- _…and 36 more_

### Community 3 — wikilink_target() (26 nodes, cohesion: 0.10)

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
- plan_dublets()
- .__init__()
- _…and 6 more_

### Community 4 — to_wikilinks() (25 nodes, cohesion: 0.12)

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

### Community 5 — split_folder() (14 nodes, cohesion: 0.31)

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
- plan_fag()
- sanitize()
- selfcheck()
- split_folder()

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

### Community 7 — writeFile() (12 nodes, cohesion: 0.38)

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

### Community 8 — selfcheck() (8) (11 nodes, cohesion: 0.22)

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

### Community 9 — main() (11 nodes, cohesion: 0.24)

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

### Community 10 — selfcheck() (10) (9 nodes, cohesion: 0.33)

- backfill_week_topics
- pathlib.Path
- re
- sys
- main()
- plan_renames()
- rewrite_references()
- sanitize()
- selfcheck()

### Community 11 — selfcheck() (11) (8 nodes, cohesion: 0.32)

- rename_lektionsplan_notes
- fix_backlinks()
- pathlib.Path
- re
- sys
- main()
- rename_in_week_dir()
- selfcheck()

### Community 12 — next_nonblank() (8 nodes, cohesion: 0.36)

- strip_empty_headings
- fix()
- pathlib.Path
- re
- sys
- looks_like_lost_title()
- main()
- next_nonblank()

### Community 13 — reformat() (7 nodes, cohesion: 0.38)

- reformat_material_links
- find_raw_file()
- pathlib.Path
- re
- sys
- main()
- reformat()

### Community 14 — selfcheck() (7 nodes, cohesion: 0.38)

- fix_fag_symbol_prefix
- pathlib.Path
- re
- sys
- main()
- rewrite_fag()
- selfcheck()

### Community 15 — selfcheck() (15) (7 nodes, cohesion: 0.38)

- rename_fag_folders
- pathlib.Path
- re
- sys
- main()
- rewrite_references()
- selfcheck()

### Community 16 — rewrite_links() (6 nodes, cohesion: 0.40)

- fix_stale_fag_root_links
- pathlib.Path
- re
- sys
- main()
- rewrite_links()

### Community 17 — fsSet() (4 nodes, cohesion: 0.83)

- fsHandle
- fsGet()
- fsOpenDb()
- fsSet()

### Community 18 — refreshVaultDirStatus() (3 nodes, cohesion: 1.00)

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

1. Can you verify the inferred relationships of 'writePlanNotes()' (degree 30)?
1. Why is 'main()' (11 nodes) loosely connected (cohesion 0.24)? Should it be split?
1. Why is 'ymd()' (84 nodes) loosely connected (cohesion 0.06)? Should it be split?
1. Why is 'write_forloeb_mirrors()' (56 nodes) loosely connected (cohesion 0.09)? Should it be split?
1. Why is 'selfcheck() (8)' (11 nodes) loosely connected (cohesion 0.22)? Should it be split?
1. Why is 'wikilink_target()' (26 nodes) loosely connected (cohesion 0.10)? Should it be split?
1. Why is 'to_wikilinks()' (25 nodes) loosely connected (cohesion 0.12)? Should it be split?

---
_Generated by graphify-rs_
