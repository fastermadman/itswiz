# Community 22: trigger_obsidian_reload()

**Members:** 5

## Nodes

- **prune_dead_links()** (`watchfolder_sync_hold_course_py_prune_dead_links`, Function, degree: 3)
- **reconcile_onyx()** (`watchfolder_sync_hold_course_py_reconcile_onyx`, Function, degree: 3)
- **sync()** (`watchfolder_sync_hold_course_py_sync`, Function, degree: 11)
- **sync_task_completion()** (`watchfolder_sync_hold_course_py_sync_task_completion`, Function, degree: 3)
- **trigger_obsidian_reload()** (`watchfolder_sync_hold_course_py_trigger_obsidian_reload`, Function, degree: 2)

## Relationships

- watchfolder_sync_hold_course_py_sync → watchfolder_sync_hold_course_py_sync_task_completion (calls)
- watchfolder_sync_hold_course_py_sync → watchfolder_sync_hold_course_py_prune_dead_links (calls)
- watchfolder_sync_hold_course_py_sync → watchfolder_sync_hold_course_py_reconcile_onyx (calls)
- watchfolder_sync_hold_course_py_sync → watchfolder_sync_hold_course_py_trigger_obsidian_reload (calls)

