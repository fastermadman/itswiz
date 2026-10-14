// One-off migration (#271): ItsWiz' own structure words become English.
//
//   keys      fag->course, emne->topic, lokale->room, underviser->teacher, hentet->fetched, kilde->source,
//             lektion->lesson, litteratur->literature, litteratur_filer->literature_files,
//             materiale_filer->material_files, forberedelse->preparation,
//             forberedelse_tekst->preparation_text, beskrivelse->description
//   types     lektionsplan->lesson-plan, materiale->material, opgave->assignment
//   removed   uge, ugedag, dato; `false` placeholders; the ▥/📎/⚒ prefixes in list fields
//   headings  ## Materialer, ## ⚒ Forberedelse, ## Opgavebeskrivelse (+ ⚒ in [NOTE] checkboxes), `Kilde:` in stubs
//
// Plain text edits on the frontmatter block (no YAML re-serialisation), so block scalars, quoting and
// key order stay exactly as written. Idempotent: a second run changes nothing.
//
// Run order matters, see the plan in #271: Hold Course sync OFF in the ItsWiz settings first
// (the script refuses to apply otherwise), dry-run, apply, then load the new plugin version.
//
//   dry-run  obsidian vault=ViaVault eval code="$(cat plugin/scripts/migrate-english.js)"
//   apply    obsidian vault=ViaVault eval code="window.ITSWIZ_APPLY=true; $(cat plugin/scripts/migrate-english.js)"
//
// or paste the file into Obsidian's developer console (apply: set window.ITSWIZ_APPLY = true first).
// Hold Course' own data.json (`vsw*` fields) is not touched.

// Wrapped so the script can be eval'ed more than once in the same Obsidian session.
const result = (function () {
  const KEY_MAP = {
    fag: "course", emne: "topic", lokale: "room", underviser: "teacher", hentet: "fetched", kilde: "source",
    lektion: "lesson", litteratur: "literature", litteratur_filer: "literature_files",
    materiale_filer: "material_files", forberedelse: "preparation", forberedelse_tekst: "preparation_text",
    beskrivelse: "description",
  };
  const TYPE_MAP = { lektionsplan: "lesson-plan", materiale: "material", opgave: "assignment" };
  const DROP_KEYS = new Set(["uge", "ugedag", "dato"]);
  const DROP_WHEN_FALSE = new Set(["literature", "literature_files", "preparation", "preparation_text", "material_files", "description"]);
  const PREFIXED_LISTS = new Set(["literature", "literature_files", "preparation", "material_files"]);
  const OUR_TYPES = new Set(["lektionsplan", "materiale", "opgave", "lesson-plan", "material", "assignment"]);

  const BODY_RULES = [
    [/^## Materialer$/gm, "## Materials"],
    [/^## (?:⚒ )?(?:Forberedelse|Preparation)$/gm, "## Preparation"],
    [/^(- \[[ xX]\]) ⚒ /gm, "$1 "],
    [/^## Opgavebeskrivelse$/gm, "## Assignment description"],
    [/^Kilde: \[\[/gm, "Source: [["],
    [/\[Åbn opgaven i itslearning\]\(/g, "[Open the assignment in itslearning]("],
    [/\[Åbn "([^\n]*?)" i itslearning\]\(/g, '[Open "$1" in itslearning]('],
    [/_\(intet indhold hentet — åbn i itslearning\)_/g, "_(no content fetched — open in itslearning)_"],
    [/\(link — åbn selve lektionsplanen i itslearning for at følge det\)/g, "(link — open the lesson plan in itslearning to follow it)"],
  ];

  const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;

  // Returns { text, changed, ops } for one note. `path` only matters for [NOTE] stubs (type: note).
  function migrateNote(text, path = "") {
    const ops = { keys: 0, types: 0, dropped: 0, prefixes: 0, body: 0 };
    if (!text.startsWith("---\n")) return { text, changed: false, ops, skipped: true };
    const end = text.indexOf("\n---", 3);
    if (end === -1) return { text, changed: false, ops, skipped: true };
    const fm = text.slice(4, end);
    const rest = text.slice(end);

    const typeMatch = /^type:[ \t]*"?([^"\n]*?)"?[ \t]*$/m.exec(fm);
    const type = typeMatch?.[1] ?? "";
    const isStub = type === "note" && path.split("/").pop().startsWith("[NOTE] ");
    if (!OUR_TYPES.has(type) && !isStub) return { text, changed: false, ops, skipped: true };

    // Group into top-level entries: a key line plus its indented/blank continuation.
    const entries = [];
    for (const line of fm.split("\n")) {
      const m = KEY_LINE.exec(line);
      if (m || !entries.length) entries.push({ key: m?.[1] ?? null, lines: [line] });
      else entries[entries.length - 1].lines.push(line);
    }

    const out = [];
    for (const entry of entries) {
      if (entry.key === null) { out.push(...entry.lines); continue; }
      if (DROP_KEYS.has(entry.key)) { ops.dropped++; continue; }
      let key = entry.key;
      let [first, ...tail] = entry.lines;
      if (key in KEY_MAP) {
        key = KEY_MAP[key];
        first = first.replace(/^[A-Za-z_][A-Za-z0-9_]*:/, `${key}:`);
        ops.keys++;
      }
      const value = first.slice(key.length + 1).trim();
      if (DROP_WHEN_FALSE.has(key) && value === "false" && !tail.some((l) => l.trim())) { ops.dropped++; continue; }
      if (key === "type" && value.replace(/"/g, "") in TYPE_MAP) {
        first = first.replace(/(lektionsplan|materiale|opgave)/, (t) => TYPE_MAP[t]);
        ops.types++;
      }
      if (PREFIXED_LISTS.has(key)) {
        tail = tail.map((l) => l.replace(/^(\s+)(?:▥|📎|⚒) ?/, (_, ws) => { ops.prefixes++; return ws; }));
      }
      out.push(first, ...tail);
    }

    let body = rest;
    for (const [re, to] of BODY_RULES) body = body.replace(re, (...a) => { ops.body++; return to.replace(/\$(\d)/g, (_, n) => a[+n]); });

    const next = `---\n${out.join("\n")}${body}`;
    return { text: next, changed: next !== text, ops };
  }

  // Danish keys still in a note's frontmatter after migration. Non-empty for notes the script
  // deliberately skips (own types such as `viden`), so the post-run report shows them for a decision.
  function leftovers(text, path = "") {
    const t = migrateNote(text, path).text;
    if (!t.startsWith("---\n") || t.indexOf("\n---", 3) === -1) return [];
    const fm = t.slice(4, t.indexOf("\n---", 3));
    return fm.split("\n").map((l) => KEY_LINE.exec(l)?.[1]).filter((k) => k && (k in KEY_MAP || DROP_KEYS.has(k)));
  }

  async function run(app, apply) {
    const itswiz = app.plugins.plugins.itswiz;
    const s = itswiz?.data?.settings ?? {};
    if (apply && s.enableHoldCourseSync) return "REFUSED: turn Hold Course sync off in the ItsWiz settings first.";
    const root = (v, d) => String(v ?? "").trim().replace(/^\/+|\/+$/g, "") || d;
    const roots = [root(s.fagRoot, "Fag"), root(s.opgaverRoot, "Noter/Opgaver")];
    const files = app.vault.getMarkdownFiles().filter((f) => roots.some((r) => f.path.startsWith(`${r}/`)));
    const total = { files: files.length, changed: 0, keys: 0, types: 0, dropped: 0, prefixes: 0, body: 0 };
    const left = [];
    for (const f of files) {
      const text = await app.vault.read(f);
      const r = migrateNote(text, f.path);
      if (r.changed) {
        total.changed++;
        for (const k of ["keys", "types", "dropped", "prefixes", "body"]) total[k] += r.ops[k];
        if (apply) await app.vault.process(f, (cur) => migrateNote(cur, f.path).text);
      }
      if (leftovers(text, f.path).length) left.push(f.path);
    }
    const summary = `${apply ? "APPLIED" : "DRY-RUN"} ${JSON.stringify(total)}; roots ${JSON.stringify(roots)}; ` +
      `notes still holding old keys after migration: ${left.length}${left.length ? " " + JSON.stringify(left.slice(0, 20)) : ""}`;
    console.log("ItsWiz migrate:", summary);
    return summary;
  }


  if (typeof app === "undefined") return { migrateNote, leftovers, KEY_MAP, TYPE_MAP };
  return run(app, window.ITSWIZ_APPLY === true);
})();
if (typeof module !== "undefined" && typeof app === "undefined") module.exports = result;
result;
