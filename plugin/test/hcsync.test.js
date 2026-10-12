'use strict';

// #242: afspiller hvert kald sync_hold_course.py's --selfcheck laver (optaget af record_hcsync.py)
// mod JS-porten i plugin/main.js og kræver samme returværdi, samme muterede argumenter og samme
// vault-filer bagefter. Grøn her = porten opfører sig som Python-synken på alle selvtjekkets cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const m = require('./_bootstrap.js');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hcsync-cases.json'), 'utf8'));

function memVault(snapshot) {
  const files = { ...snapshot };
  return {
    files,
    list: async () => Object.keys(files).filter((k) => files[k] != null),
    read: async (p) => files[p],
    write: async (p, text) => { files[p] = text; },
  };
}

function idsFrom(c) {
  const ids = [...c.ids];
  return () => {
    if (!ids.length) throw new Error('flere id\'er end Python brugte');
    return ids.shift();
  };
}

const kw = (c, name, pos) => (name in c.kwargs ? c.kwargs[name] : c.args[pos]);

const RUN = {
  sync_data: (c, a) => m.syncData(a[0], a[1], idsFrom(c), kw(c, 'tasks', 3) ?? null,
    kw(c, 'dropped_out', 4) ?? null, kw(c, 'report', 5) ?? null, (p) => c.stubs[p] ?? p),
  ensure_lecture: (c, a) => m.ensureLecture(a[0], a[1], idsFrom(c), (p) => c.stubs[p] ?? p),
  render_forloeb: (c, a) => m.renderForloeb(...a),
  parse_frontmatter: (c, a) => m.parseFrontmatter(...a),
  migrate_notes_to_description: (c, a) => m.migrateNotesToDescription(...a),
  hhmm: (c, a) => m.hhmm(...a),
  wikilink_target: (c, a) => m.wikilinkTarget(...a),
  _is_prep_day: (c, a) => m.isPrepDay(...a),
  iso_week: (c, a) => m.isoWeekOf(...a),
  enhed_from_link: (c, a) => m.enhedFromLink(...a),
  _strip_genereret: (c, a) => m.stripGenereret(...a),
  prefixed_lines: (c, a) => m.prefixedLines(...a),
  remove_file_list_lines: (c, a) => m.removeFileListLines(a[0], a[1], a[2], new Set(a[3])),
  stable_key: (c, a) => m.stableKey(...a),
  patch_pending_materiale: (c, a, v) => m.patchPendingMateriale(v, kw(c, 'apply', 1)),
  read_plans: (c, a, v) => m.readPlans(v),
  sync_task_completion: (c, a) => m.syncTaskCompletion(a[0], (p) => c.vaultBefore[p] ?? null),
  prune_dead_links: (c, a) => m.pruneDeadLinks(a[0], (p) => c.vaultBefore[p] != null),
};

CASES.forEach((c, i) => {
  test(`#${i} ${c.fn}`, async () => {
    const args = structuredClone(c.args);
    const vault = c.vaultBefore && memVault(c.vaultBefore);
    const result = await RUN[c.fn](c, args, vault);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result ?? null)), c.result, 'returværdi');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(args)), c.argsAfter, 'muterede argumenter');
    if (vault && c.fn !== 'sync_task_completion' && c.fn !== 'prune_dead_links') {
      assert.deepStrictEqual(vault.files, c.vaultAfter, 'vault-filer');
    }
  });
});

test('alle optagede funktioner har en JS-modpart', () => {
  for (const c of CASES) assert.ok(RUN[c.fn], c.fn);
});
