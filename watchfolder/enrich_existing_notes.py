#!/usr/bin/env python3
"""
Engangs-berigelse af eksisterende noters frontmatter med emne/start/stop.

writePlanNotes() og frontmatter() (background.js / watch_viastudywiz.py, se PR #21) skriver nu
emne+start+stop på alle NYE noter. Dette script eftermonterer samme felter på noter der blev
skrevet før den ændring. Data hentet live fra itslearnings plan-API (myEvents +
plans/selected/v1) for de tre aktive fag, 2026-08-10 — samme kildedata som
watchfolder/backfill_week_topics.py brugte til selve mappe-omdøbningen.

Springer bevidst de fire uger over hvor to Musik-lektioner samme dag allerede er blandet sammen
i én ikke-omdøbt mappe (samme udeladelse som backfill_week_topics.py) — der er ingen sikker måde
at afgøre hvilken fil hører til hvilken af de to lektioner uden endnu et opslag pr. fil.

Dry-run som standard, `--apply` udfører, `--selfcheck` kører de indbyggede tests.
"""

import re
import sys
from pathlib import Path

VAULT_ROOT = Path.home() / "ViaVault"
FAG = {"33203": "LivsOplysning", "36016": "Musik", "39550": "Religion"}
DAY_ABBREV = ["søn", "man", "tirs", "ons", "tors", "fre", "lør"]

CONFLICT_BASES = {("Musik", "W34tors"), ("Musik", "W36tors"), ("Musik", "W39tors"), ("Musik", "W41tors")}

# courseId -> [{title, start, stop, topic}], hentet live fra itslearning (se docstring).
PLANS_BY_COURSE = {
    "33203": [
        {"start": "2026-08-17T10:00:00+00:00", "stop": "2026-08-17T15:00:00+00:00", "topic": "Skolens formål"},
        {"start": "2026-08-10T09:00:00+00:00", "stop": "2026-08-10T15:00:00+00:00", "topic": "Introduktion"},
        {"start": "2026-08-31T09:00:00+00:00", "stop": "2026-08-31T15:00:00+00:00", "topic": "Skolens formål"},
        {"start": "2026-08-24T09:00:00+00:00", "stop": "2026-08-24T15:00:00+00:00", "topic": "Skolens formål"},
    ],
    "36016": [
        {"start": "2026-09-29T00:01:00+00:00", "stop": "2026-09-29T23:59:00+00:00", "topic": "Underviser Lone Sonne"},
        {"start": "2026-10-06T00:01:00+00:00", "stop": "2026-10-06T23:59:00+00:00", "topic": "Underviser Lone Sonne"},
        {"start": "2026-08-13T08:15:00+00:00", "stop": "2026-08-13T12:00:00+00:00", "topic": "Når børn synger."},
        {"start": "2026-08-27T08:15:00+00:00", "stop": "2026-08-27T12:00:00+00:00", "topic": "Når børn synger."},
        {"start": "2026-08-20T08:15:00+00:00", "stop": "2026-08-20T12:00:00+00:00", "topic": "Når børn synger."},
        {"start": "2026-09-03T08:15:00+00:00", "stop": "2026-09-03T12:00:00+00:00", "topic": "Når børn synger."},
        {"start": "2026-09-10T08:15:00+00:00", "stop": "2026-09-10T12:00:00+00:00", "topic": "Når børn synger."},
        {"start": "2026-09-24T08:15:00+00:00", "stop": "2026-09-24T12:00:00+00:00", "topic": "Studieprodukt, fremlæggelse."},
        {"start": "2026-10-08T08:15:00+00:00", "stop": "2026-10-08T12:00:00+00:00", "topic": "Studieprodukt, fremlæggelse."},
        {"start": "2026-08-20T12:25:00+00:00", "stop": "2026-08-20T14:00:00+00:00", "topic": "I. M. U."},
        {"start": "2026-09-03T12:25:00+00:00", "stop": "2026-09-03T14:00:00+00:00", "topic": "I. M. U."},
        {"start": "2026-09-24T12:25:00+00:00", "stop": "2026-09-24T14:00:00+00:00", "topic": "I. M. U."},
        {"start": "2026-10-08T12:25:00+00:00", "stop": "2026-10-08T14:00:00+00:00", "topic": "I. M. U."},
        {"start": "2026-09-15T00:01:00+00:00", "stop": "2026-09-17T23:59:00+00:00", "topic": "Studietur"},
        {"start": "2026-08-11T12:25:00+00:00", "stop": "2026-08-11T14:00:00+00:00", "topic": "Musikforståelse"},
        {"start": "2026-08-18T00:01:00+00:00", "stop": "2026-08-18T23:59:00+00:00", "topic": "Musikforståelse"},
        {"start": "2026-09-01T00:01:00+00:00", "stop": "2026-09-01T23:59:00+00:00", "topic": "Musikforståelse"},
        {"start": "2026-09-08T00:01:00+00:00", "stop": "2026-09-08T23:59:00+00:00", "topic": "Musikforståelse"},
    ],
    "39550": [
        {"start": "2026-08-21T08:15:00+00:00", "stop": "2026-08-21T12:00:00+00:00", "topic": "Den religiøse dimension"},
        {"start": "2026-08-19T12:30:00+00:00", "stop": "2026-08-19T15:45:00+00:00", "topic": "Den religiøse dimension"},
        {"start": "2026-08-12T12:30:00+00:00", "stop": "2026-08-12T15:45:00+00:00", "topic": "Intro til faget"},
        {"start": "2026-08-14T08:15:00+00:00", "stop": "2026-08-14T12:00:00+00:00", "topic": "Intro til faget"},
        {"start": "2026-09-04T08:15:00+00:00", "stop": "2026-09-04T12:00:00+00:00", "topic": "Hvad er religion og hvordan kan det udforskes?"},
        {"start": "2026-09-02T12:30:00+00:00", "stop": "2026-09-02T15:45:00+00:00", "topic": "Hvad er religion og hvordan kan det udforskes?"},
        {"start": "2026-08-26T12:30:00+00:00", "stop": "2026-08-26T15:45:00+00:00", "topic": "Hvad er religion og hvordan kan det udforskes?"},
        {"start": "2026-08-28T08:15:00+00:00", "stop": "2026-08-28T12:00:00+00:00", "topic": "Hvad er religion og hvordan kan det udforskes?"},
        {"start": "2026-09-09T12:30:00+00:00", "stop": "2026-09-09T15:45:00+00:00", "topic": "Dannelse til religiøs myndighed"},
        {"start": "2026-09-11T08:15:00+00:00", "stop": "2026-09-11T12:00:00+00:00", "topic": "Dannelse til religiøs myndighed"},
        {"start": "2026-09-16T12:30:00+00:00", "stop": "2026-09-16T15:45:00+00:00", "topic": "Bibelske fortællinger under en fagdidaktisk synsvinkel"},
        {"start": "2026-09-18T08:15:00+00:00", "stop": "2026-09-18T12:00:00+00:00", "topic": "Bibelske fortællinger under en fagdidaktisk synsvinkel"},
        {"start": "2026-09-23T12:30:00+00:00", "stop": "2026-09-23T15:45:00+00:00", "topic": "Bibelske fortællinger under en fagdidaktisk synsvinkel"},
        {"start": "2026-09-25T08:15:00+00:00", "stop": "2026-09-25T12:00:00+00:00", "topic": "Bibelske fortællinger under en fagdidaktisk synsvinkel"},
        {"start": "2026-10-02T08:15:00+00:00", "stop": "2026-10-02T12:00:00+00:00", "topic": "Bibelske fortællinger under en fagdidaktisk synsvinkel"},
        {"start": "2026-09-30T12:30:00+00:00", "stop": "2026-09-30T15:45:00+00:00", "topic": "Den religiøse dimension"},
        {"start": "2026-10-07T12:30:00+00:00", "stop": "2026-10-09T12:00:00+00:00", "topic": "SP I: Religionsdidaktisk projekt"},
    ],
}


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


def week_folder_base(iso_start: str) -> str:
    from datetime import datetime, timedelta, timezone

    date = datetime.fromisoformat(iso_start)
    d = datetime(date.year, date.month, date.day, tzinfo=timezone.utc)
    day_num = d.isoweekday()
    d = d + timedelta(days=4 - day_num)
    year_start = datetime(d.year, 1, 1, tzinfo=timezone.utc)
    week = -(-((d - year_start).days + 1) // 7)
    js_day = (date.weekday() + 1) % 7
    return f"W{week}{DAY_ABBREV[js_day]}"


def to_space_datetime(iso: str) -> str:
    return iso[:19].replace("T", " ")


# Ældre noter (skrevet af backfill_week_topics.py, før dette script) har en sammensat
# "uge: W33tirs - Musikforståelse" — nu hvor emne er sit eget felt, er det redundant og gør
# uge-værdien inkonsistent på tværs af uger i Bases. Rens den ned til det rene ugekode.
def clean_uge_field(text: str) -> str:
    return re.sub(r"^uge: (W\d+[a-zæøå]+) - .+$", r"uge: \1", text, flags=re.MULTILINE)


def inject_fields(text: str, fields: dict) -> str:
    """Indsætter manglende nøgler lige før frontmatterens lukkende '---'. Idempotent: rører
    ikke felter der allerede findes (fx hvis scriptet køres to gange, eller feltet allerede
    blev sat af en nyere kørsel af writePlanNotes/frontmatter())."""
    if not text.startswith("---\n"):
        return text
    end = text.index("\n---", 4)
    head, rest = text[:end], text[end:]
    missing = {k: v for k, v in fields.items() if not re.search(rf"^{k}:", head, re.MULTILINE)}
    if not missing:
        return text
    lines = "".join(f'{k}: "{v}"\n' for k, v in missing.items())
    return head + "\n" + lines.rstrip("\n") + rest


def plan_enrichments():
    jobs = []  # (fag, week_dir, {emne, start, stop})
    for course_id, plans in PLANS_BY_COURSE.items():
        fag = FAG[course_id]
        for plan in plans:
            base = week_folder_base(plan["start"])
            if (fag, base) in CONFLICT_BASES:
                continue
            week = f"{base} - {sanitize(plan['topic'])}" if plan["topic"] else base
            week_dir = VAULT_ROOT / fag / "MD" / week
            if not week_dir.is_dir():
                continue
            fields = {
                "emne": plan["topic"],
                "start": to_space_datetime(plan["start"]),
                "stop": to_space_datetime(plan["stop"]),
            }
            jobs.append((fag, week_dir, fields))
    return jobs


def main() -> int:
    apply = "--apply" in sys.argv
    jobs = plan_enrichments()

    total_notes = 0
    for fag, week_dir, fields in jobs:
        notes = list(week_dir.glob("*.md"))
        total_notes += len(notes)
        print(f"{week_dir.relative_to(VAULT_ROOT)}  ({len(notes)} noter)  emne=\"{fields['emne']}\"")

    print(f"\n{len(jobs)} ugemapper, {total_notes} noter i alt.")
    if not apply:
        print("Dry-run. Kør med --apply for at udføre.")
        return 0

    changed = 0
    for _, week_dir, fields in jobs:
        for note in week_dir.glob("*.md"):
            text = note.read_text(encoding="utf-8")
            new_text = clean_uge_field(inject_fields(text, fields))
            if new_text != text:
                note.write_text(new_text, encoding="utf-8")
                changed += 1

    print(f"Færdig. {changed} noter opdateret.")
    return 0


def selfcheck() -> int:
    text = "---\nfag: Musik\nuge: W33tirs\ntype: materiale\n---\n\nIndhold.\n"
    out = inject_fields(text, {"emne": "Musikforståelse", "start": "2026-08-11 12:25", "stop": "2026-08-11 14:00"})
    assert 'emne: "Musikforståelse"' in out, out
    assert 'start: "2026-08-11 12:25"' in out, out
    assert "Indhold.\n" in out, out

    # Idempotent: kør igen, "emne" må ikke dubleres.
    out2 = inject_fields(out, {"emne": "Musikforståelse", "start": "2026-08-11 12:25", "stop": "2026-08-11 14:00"})
    assert out2 == out, out2
    assert out2.count("emne:") == 1, out2

    assert week_folder_base("2026-08-20T08:15:00+00:00") == "W34tors"

    cleaned = clean_uge_field("uge: W33tirs - Musikforståelse\n")
    assert cleaned == "uge: W33tirs\n", cleaned
    assert clean_uge_field("uge: W33tirs\n") == "uge: W33tirs\n"

    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck() if "--selfcheck" in sys.argv else main())
