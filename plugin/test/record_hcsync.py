"""Optager hvert kald sync_hold_course.py's --selfcheck laver, som fixtures til JS-porten (#242).

Kør:  python3 plugin/test/record_hcsync.py   (skriver plugin/test/fixtures/hcsync-cases.json)

Hvert kald gemmes med argumenter før kaldet, returværdien, argumenterne efter kaldet (funktionerne
muterer data.json-strukturen) og — for funktioner der tager en vault-mappe — mappens filer før og
efter. new_id-funktioner gemmes som rækken af id'er de returnerede, og note_stub_path-opslag som et
kort, så plugin/test/hcsync.test.js kan afspille kaldet deterministisk mod JS-porten.

Slettes sammen med watchfolder/ i #244; fixture-filen bliver."""

import copy
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "watchfolder"))
import sync_hold_course as m  # noqa: E402

PURE = ["sync_data", "render_forloeb", "parse_frontmatter", "migrate_notes_to_description", "hhmm",
        "wikilink_target", "_is_prep_day", "iso_week", "enhed_from_link", "_strip_genereret",
        "prefixed_lines", "remove_file_list_lines", "ensure_lecture", "stable_key"]
VAULT = ["patch_pending_materiale", "sync_task_completion", "prune_dead_links", "read_plans"]

cases = []
depth = 0


def snapshot(root: Path, data=None) -> dict:
    """Hele mappen — eller, når funktionen kun slår data.json's egne stier op (selfchecken giver
    den så hele systemets tmp-mappe), kun de stier. None = filen findes ikke."""
    if data is None:
        return {str(p.relative_to(root)): p.read_text(encoding="utf-8")
                for p in sorted(root.rglob("*")) if p.is_file()}
    links = set()

    def walk(o):
        if isinstance(o, dict):
            for k in ("vaultLink", "vswVaultLink", "linkedNote"):
                if isinstance(o.get(k), str) and o[k]:
                    links.add(o[k])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return {l: ((root / l).read_text(encoding="utf-8") if (root / l).is_file() else None) for l in sorted(links)}


def plain(value):
    if isinstance(value, (set, frozenset)):
        return sorted(plain(v) for v in value)
    if isinstance(value, tuple):
        return [plain(v) for v in value]
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, Path):
        return str(value)
    return value


def recorder(name, fn):
    def wrapped(*args, **kwargs):
        global depth
        if depth:
            return fn(*args, **kwargs)
        ids, stubs = [], {}
        args = list(args)
        if name == "sync_data" and len(args) < 3 and "new_id" not in kwargs:
            kwargs["new_id"] = None
        for container, keys in ((args, range(len(args))), (kwargs, list(kwargs))):
            for k in keys:
                v = container[k]
                if callable(v) or (k == "new_id" and v is None):
                    base = v or (lambda counter=[0]: m.generate_id(counter))

                    def logged(base=base):
                        ids.append(base())
                        return ids[-1]
                    container[k] = logged
        real_stub = m.note_stub_path

        def stub(p):
            stubs[p] = real_stub(p)
            return stubs[p]
        m.note_stub_path = stub
        vault_arg = next((i for i, a in enumerate(args) if isinstance(a, Path) and a.is_dir()), None)
        case = {"fn": name,
                "args": plain([None if callable(a) else a for a in args]),
                "kwargs": plain({k: (None if callable(v) else v) for k, v in kwargs.items()})}
        if vault_arg is not None:
            case["vaultArg"] = vault_arg
            data_arg = args[0] if name in ("sync_task_completion", "prune_dead_links") else None
            case["vaultBefore"] = snapshot(args[vault_arg], data_arg)
        case["args"] = copy.deepcopy(case["args"])
        depth += 1
        try:
            result = fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            case["raises"] = type(e).__name__
            cases.append(case)
            raise
        finally:
            depth -= 1
            m.note_stub_path = real_stub
        case["result"] = plain(result)
        case["argsAfter"] = plain([None if callable(a) else a for a in args])
        case["kwargsAfter"] = plain({k: (None if callable(v) else v) for k, v in kwargs.items()})
        case["ids"] = ids
        case["stubs"] = stubs
        if vault_arg is not None:
            case["vaultAfter"] = snapshot(args[vault_arg], data_arg)
        cases.append(case)
        return result
    return wrapped


for name in PURE + VAULT:
    setattr(m, name, recorder(name, getattr(m, name)))

assert m.selfcheck() == 0
out = Path(__file__).parent / "fixtures" / "hcsync-cases.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"{len(cases)} kald optaget -> {out.relative_to(REPO)}")
