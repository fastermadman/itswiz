#!/usr/bin/env python3
"""
Engangs: repeg Hold Course' data.json fra de gamle "MD/<dato> - <emne>/"-stier til de nye
"MD/<enhed>/"-stier efter enhed-migreringen (migrate_to_enhed_mapper.py, #149).

- resource.vaultLink  -> den fil der FAKTISK ligger der nu (MD/<enhed>/<stem>.md, evt. dato-suffiks)
- resource.vswResKey  -> mappe-løs form (stable_key: § FAG/<fag>/MD/<stem>.md), så næste sync
                         matcher det samme bibliotekselement i stedet for at lave en spøgelses-dublet (#138)
- assignment.vswKey   -> samme mappe-strip på "<id>|mat|<sti>"- / "|lit|"-formen
- assignment.linkedNote -> repeg hvis den peger på en død MD-sti
- dedup: resources/opgaver der efter normaliseringen har samme nøgle flettes (union classIds,
  behold den ældste — samme regel som prune_dead_links' eksakt-dublet-håndtering)

Reconcilerer bagefter til .obsidian-onyx (Boox), med Boox' eget settings-felt bevaret (#146).

Dry-run som standard. `--apply` skriver. Kør EFTER migrate_to_enhed_mapper.py --apply.
GitHub: fastermadman/viastudywiz-extension#151
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sync_hold_course import VAULT_ROOT, nfc, stable_key  # noqa: E402

DATA_JSON = VAULT_ROOT / ".obsidian" / "plugins" / "hold-course" / "data.json"
ONYX_DATA_JSON = VAULT_ROOT / ".obsidian-onyx" / "plugins" / "hold-course" / "data.json"

OLD_FOLDER = re.compile(r"^(§ FAG/[^/]+/MD)/(\d{4}-\d{2}-\d{2}) - (.+?)/(.+)$")
SANITIZE = re.compile(r'[\\/:*?"<>|]')


def sanitize(name: str) -> str:
    return SANITIZE.sub("_", name).strip()


def md_index() -> dict[tuple[str, str], list[Path]]:
    """(fag, stem) -> [rigtige MD-filer]. Stem uden evt. " (YYYY-MM-DD)"-suffiks bevares også."""
    idx: dict[tuple[str, str], list[Path]] = {}
    for md in (VAULT_ROOT / "§ FAG").glob("*/MD/**/*.md"):
        fag = md.relative_to(VAULT_ROOT).parts[1]
        idx.setdefault((fag, md.stem), []).append(md)
        base = re.sub(r" \(\d{4}-\d{2}-\d{2}\)$", "", md.stem)
        if base != md.stem:
            idx.setdefault((fag, base), []).append(md)
    return idx


def resolve(old_link: str, idx: dict) -> str | None:
    """Gammel vaultLink -> ny, rigtig, relativ sti (eller None hvis den ikke kan findes)."""
    link = old_link[:-3] if old_link.endswith(".md") else old_link
    m = OLD_FOLDER.match(link + ".md")
    if m:
        base, date, emne, rest = m.groups()
        cand = VAULT_ROOT / f"{base}/{sanitize(emne)}/{rest}"
        if cand.exists():
            return nfc(str(cand.relative_to(VAULT_ROOT)))
        # dato-suffikset ved merge-kollision?
        cand2 = cand.with_name(f"{cand.stem} ({date}){cand.suffix}")
        if cand2.exists():
            return nfc(str(cand2.relative_to(VAULT_ROOT)))
    # fallback: slå op på (fag, stem)
    parts = link.split("/")
    if len(parts) >= 3:
        fag, stem = parts[1], Path(link).name
        hits = idx.get((fag, stem)) or []
        if len(hits) == 1:
            return nfc(str(hits[0].relative_to(VAULT_ROOT)))
    return None


def strip_folder_in_vswkey(vswkey: str) -> str:
    """"<id>|mat|§ FAG/<fag>/MD/<mappe>/<fil>.md" -> mappe-løs. Andre former urørt."""
    parts = vswkey.split("|", 2)
    if len(parts) == 3 and parts[1] in ("mat", "lit") and parts[2].startswith("§ FAG/"):
        return f"{parts[0]}|{parts[1]}|{stable_key(parts[2])}"
    return vswkey


def dedup(items: list[dict], key_field: str) -> tuple[list[dict], int]:
    """Behold den ældste (først i listen) pr. nøgle; union classIds; drop resten."""
    seen: dict[str, dict] = {}
    out, dropped = [], 0
    for it in items:
        k = it.get(key_field)
        if k and k in seen:
            keep = seen[k]
            for cid in it.get("classIds", []):
                if cid not in keep.setdefault("classIds", []):
                    keep["classIds"].append(cid)
            if not keep.get("vaultLink") and it.get("vaultLink"):
                keep["vaultLink"] = it["vaultLink"]
            dropped += 1
            continue
        seen[k] = it
        out.append(it)
    return out, dropped


def relink(data: dict) -> dict:
    idx = md_index()
    stats = {"res_link": 0, "res_key": 0, "res_dead": 0, "res_dedup": 0,
             "as_key": 0, "as_note": 0, "as_dedup": 0}
    dead_samples = []

    for sem in data.get("semesters", []):
        resources = sem.get("resources") or []
        for r in resources:
            old = r.get("vaultLink") or ""
            new = resolve(old, idx)
            if new and new != old:
                r["vaultLink"] = new
                stats["res_link"] += 1
            elif not new and old and not (VAULT_ROOT / old).exists():
                stats["res_dead"] += 1
                if len(dead_samples) < 12:
                    dead_samples.append(old)
            k = r.get("vswResKey") or ""
            nk = stable_key(k)
            if nk != k:
                r["vswResKey"] = nk
                stats["res_key"] += 1
        sem["resources"], d = dedup(resources, "vswResKey")
        stats["res_dedup"] += d

        for cls in sem.get("classes", []):
            for owner in [cls, *cls.get("lectures", [])]:
                assigns = owner.get("assignments") or []
                for a in assigns:
                    k = a.get("vswKey") or ""
                    nk = strip_folder_in_vswkey(k)
                    if nk != k:
                        a["vswKey"] = nk
                        stats["as_key"] += 1
                    ln = a.get("linkedNote") or ""
                    if ln and ln.startswith("§ FAG/") and "/MD/" in ln and not (VAULT_ROOT / ln).exists():
                        new_ln = resolve(ln, idx)
                        if new_ln:
                            a["linkedNote"] = new_ln
                            stats["as_note"] += 1
                owner["assignments"], d = dedup(assigns, "vswKey")
                stats["as_dedup"] += d

    return {"stats": stats, "dead": dead_samples}


def main() -> int:
    apply = "--apply" in sys.argv
    if not DATA_JSON.exists():
        print(f"Findes ikke: {DATA_JSON}", file=sys.stderr)
        return 1

    text = DATA_JSON.read_text(encoding="utf-8")
    data = json.loads(text)
    report = relink(data)
    s = report["stats"]
    print(f"resource.vaultLink repeget : {s['res_link']}")
    print(f"resource.vswResKey mappe-løst: {s['res_key']}")
    print(f"resource dedup (dublet fjernet): {s['res_dedup']}")
    print(f"resource UOPLØSELIG (død link): {s['res_dead']}")
    for x in report["dead"]:
        print(f"    {x}")
    print(f"assignment.vswKey mappe-løst : {s['as_key']}")
    print(f"assignment.linkedNote repeget: {s['as_note']}")
    print(f"assignment dedup             : {s['as_dedup']}")

    new_text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if not apply:
        print("\nDry-run. Kør med --apply for at skrive data.json (+ reconcile til Boox).")
        return 0
    if DATA_JSON.read_text(encoding="utf-8") != text:
        print("data.json ændrede sig undervejs — afbryder, prøv igen.", file=sys.stderr)
        return 1
    DATA_JSON.write_text(new_text, encoding="utf-8")
    print(f"Skrev {DATA_JSON}")

    if ONYX_DATA_JSON.exists():
        onyx = json.loads(ONYX_DATA_JSON.read_text(encoding="utf-8"))
        merged = json.loads(new_text)
        merged["settings"] = onyx.get("settings", merged.get("settings"))
        ONYX_DATA_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Reconcileret {ONYX_DATA_JSON} (Boox' settings bevaret)")
    return 0


def selfcheck() -> int:
    assert stable_key("§ FAG/♪ Musik/MD/2026-08-11 - Emne/Fil.md") == "§ FAG/♪ Musik/MD/Fil.md"
    assert stable_key("§ FAG/♪ Musik/MD/Fil.md") == "§ FAG/♪ Musik/MD/Fil.md"
    assert strip_folder_in_vswkey("L1|mat|§ FAG/♪ Musik/MD/2026-08-11 - Emne/Fil.md") == "L1|mat|§ FAG/♪ Musik/MD/Fil.md"
    assert strip_folder_in_vswkey("opgave|4831051") == "opgave|4831051"
    assert strip_folder_in_vswkey("L1|forb|Titel") == "L1|forb|Titel"
    assert sanitize("Hvad er religion?") == "Hvad er religion_"
    d, dropped = dedup([{"vswResKey": "k", "classIds": ["a"]}, {"vswResKey": "k", "classIds": ["b"], "vaultLink": "x"}], "vswResKey")
    assert len(d) == 1 and dropped == 1 and d[0]["classIds"] == ["a", "b"] and d[0]["vaultLink"] == "x"
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
