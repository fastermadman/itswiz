# Community 8: writeFile()

**Members:** 12

## Nodes

- **offscreen** (`offscreen_js`, File, degree: 11)
- **copyRecursive()** (`offscreen_js_copyrecursive`, Function, degree: 2)
- **countPlanNotes()** (`offscreen_js_countplannotes`, Function, degree: 2)
- **fileExists()** (`offscreen_js_fileexists`, Function, degree: 3)
- **findDirEntryNormalized()** (`offscreen_js_finddirentrynormalized`, Function, degree: 2)
- **getDirectoryHandleTolerant()** (`offscreen_js_getdirectoryhandletolerant`, Function, degree: 4)
- **getTargetDirectory()** (`offscreen_js_gettargetdirectory`, Function, degree: 6)
- **getVaultHandle()** (`offscreen_js_getvaulthandle`, Function, degree: 6)
- **moveDir()** (`offscreen_js_movedir`, Function, degree: 6)
- **readFile()** (`offscreen_js_readfile`, Function, degree: 3)
- **vaultPermissionError()** (`offscreen_js_vaultpermissionerror`, Function, degree: 2)
- **writeFile()** (`offscreen_js_writefile`, Function, degree: 3)

## Relationships

- offscreen_js → offscreen_js_vaultpermissionerror (defines)
- offscreen_js → offscreen_js_getvaulthandle (defines)
- offscreen_js → offscreen_js_finddirentrynormalized (defines)
- offscreen_js → offscreen_js_getdirectoryhandletolerant (defines)
- offscreen_js → offscreen_js_gettargetdirectory (defines)
- offscreen_js → offscreen_js_writefile (defines)
- offscreen_js → offscreen_js_readfile (defines)
- offscreen_js → offscreen_js_fileexists (defines)
- offscreen_js → offscreen_js_copyrecursive (defines)
- offscreen_js → offscreen_js_countplannotes (defines)
- offscreen_js → offscreen_js_movedir (defines)
- offscreen_js_getvaulthandle → offscreen_js_vaultpermissionerror (calls)
- offscreen_js_getdirectoryhandletolerant → offscreen_js_finddirentrynormalized (calls)
- offscreen_js_gettargetdirectory → offscreen_js_getdirectoryhandletolerant (calls)
- offscreen_js_writefile → offscreen_js_getvaulthandle (calls)
- offscreen_js_writefile → offscreen_js_gettargetdirectory (calls)
- offscreen_js_readfile → offscreen_js_getvaulthandle (calls)
- offscreen_js_readfile → offscreen_js_gettargetdirectory (calls)
- offscreen_js_fileexists → offscreen_js_getvaulthandle (calls)
- offscreen_js_fileexists → offscreen_js_gettargetdirectory (calls)
- offscreen_js_movedir → offscreen_js_getvaulthandle (calls)
- offscreen_js_movedir → offscreen_js_gettargetdirectory (calls)
- offscreen_js_movedir → offscreen_js_getdirectoryhandletolerant (calls)
- offscreen_js_movedir → offscreen_js_countplannotes (calls)
- offscreen_js_movedir → offscreen_js_copyrecursive (calls)

