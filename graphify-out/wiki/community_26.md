# Community 26: fsSet()

**Members:** 4

## Nodes

- **fsHandle** (`fshandle_js`, File, degree: 3)
- **fsGet()** (`fshandle_js_fsget`, Function, degree: 2)
- **fsOpenDb()** (`fshandle_js_fsopendb`, Function, degree: 3)
- **fsSet()** (`fshandle_js_fsset`, Function, degree: 2)

## Relationships

- fshandle_js → fshandle_js_fsopendb (defines)
- fshandle_js → fshandle_js_fsset (defines)
- fshandle_js → fshandle_js_fsget (defines)
- fshandle_js_fsset → fshandle_js_fsopendb (calls)
- fshandle_js_fsget → fshandle_js_fsopendb (calls)

