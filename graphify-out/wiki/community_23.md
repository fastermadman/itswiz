# Community 23: sync_data()

**Members:** 5

## Nodes

- **ensure_resource()** (`watchfolder_sync_hold_course_py_ensure_resource`, Function, degree: 5)
- **migrate_notes_to_description()** (`watchfolder_sync_hold_course_py_migrate_notes_to_description`, Function, degree: 3)
- **prune_stale_resource_classes()** (`watchfolder_sync_hold_course_py_prune_stale_resource_classes`, Function, degree: 2)
- **stable_key()** (`watchfolder_sync_hold_course_py_stable_key`, Function, degree: 3)
- **sync_data()** (`watchfolder_sync_hold_course_py_sync_data`, Function, degree: 17)

## Relationships

- watchfolder_sync_hold_course_py_ensure_resource → watchfolder_sync_hold_course_py_stable_key (calls)
- watchfolder_sync_hold_course_py_sync_data → watchfolder_sync_hold_course_py_migrate_notes_to_description (calls)
- watchfolder_sync_hold_course_py_sync_data → watchfolder_sync_hold_course_py_ensure_resource (calls)
- watchfolder_sync_hold_course_py_sync_data → watchfolder_sync_hold_course_py_stable_key (calls)
- watchfolder_sync_hold_course_py_sync_data → watchfolder_sync_hold_course_py_prune_stale_resource_classes (calls)

