# Community 9: write_duplicate_stub()

**Members:** 11

## Nodes

- **already_converted()** (`watchfolder_watch_viastudywiz_py_already_converted`, Function, degree: 3)
- **cached_zip()** (`watchfolder_watch_viastudywiz_py_cached_zip`, Function, degree: 2)
- **error_marker_path()** (`watchfolder_watch_viastudywiz_py_error_marker_path`, Function, degree: 6)
- **existing_conversion()** (`watchfolder_watch_viastudywiz_py_existing_conversion`, Function, degree: 3)
- **md_targets()** (`watchfolder_watch_viastudywiz_py_md_targets`, Function, degree: 7)
- **previously_failed()** (`watchfolder_watch_viastudywiz_py_previously_failed`, Function, degree: 3)
- **process_document()** (`watchfolder_watch_viastudywiz_py_process_document`, Function, degree: 11)
- **sanitize()** (`watchfolder_watch_viastudywiz_py_sanitize`, Function, degree: 5)
- **submit()** (`watchfolder_watch_viastudywiz_py_submit`, Function, degree: 4)
- **write_cache()** (`watchfolder_watch_viastudywiz_py_write_cache`, Function, degree: 2)
- **write_duplicate_stub()** (`watchfolder_watch_viastudywiz_py_write_duplicate_stub`, Function, degree: 4)

## Relationships

- watchfolder_watch_viastudywiz_py_md_targets → watchfolder_watch_viastudywiz_py_sanitize (calls)
- watchfolder_watch_viastudywiz_py_existing_conversion → watchfolder_watch_viastudywiz_py_md_targets (calls)
- watchfolder_watch_viastudywiz_py_write_duplicate_stub → watchfolder_watch_viastudywiz_py_md_targets (calls)
- watchfolder_watch_viastudywiz_py_error_marker_path → watchfolder_watch_viastudywiz_py_sanitize (calls)
- watchfolder_watch_viastudywiz_py_already_converted → watchfolder_watch_viastudywiz_py_md_targets (calls)
- watchfolder_watch_viastudywiz_py_previously_failed → watchfolder_watch_viastudywiz_py_error_marker_path (calls)
- watchfolder_watch_viastudywiz_py_submit → watchfolder_watch_viastudywiz_py_sanitize (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_already_converted (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_previously_failed (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_existing_conversion (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_write_duplicate_stub (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_cached_zip (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_submit (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_write_cache (calls)
- watchfolder_watch_viastudywiz_py_process_document → watchfolder_watch_viastudywiz_py_error_marker_path (calls)

