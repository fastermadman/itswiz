'use strict';

// #271: engangsmigreringen af ViaVault. Ren tekst ind, ren tekst ud (ingen Obsidian).

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateNote, leftovers } = require('../scripts/migrate-english.js');
const plugin = require('./_bootstrap.js');

const OLD_PLAN = [
  '---',
  'fag: Musik',
  'uge: 2026-W36',
  'ugedag: tirsdag',
  'dato: 2026-09-01',
  'emne: "Musikforståelse"',
  'start: "2026-09-01 12:25"',
  'stop: "2026-09-01 15:45"',
  'lokale: "B204"',
  'hentet: "2026-09-06 08:00"',
  'type: lektionsplan',
  'plan_id: "36016:1235133"',
  'litteratur: |',
  '  ▥ Frede V Nielsen (2010): Ars og Scientia',
  'litteratur_filer: |',
  '  📎 [[Fag/Musik/MD/E/Ars.md|Ars.md]]',
  '  📎 [[Fag/Musik/MD/E/Bog.md|Bog.md]]',
  'forberedelse: |',
  '  ⚒ Forberedelse',
  '  ⚒ Læs kapitel 2',
  'forberedelse_tekst: false',
  'materiale_filer: false',
  'beskrivelse: false',
  '---',
  '',
  '<!-- AUTO:START -->',
  '# Titel',
  '',
  '## Materialer',
  '- [[Fag/Musik/MD/E/Ars.md|Ars.md]]',
  '',
  '## ⚒ Forberedelse',
  '',
  'Læs.',
  '',
  '[Åbn "Forberedelse" i itslearning](https://via.itslearning.com/x)',
  '<!-- AUTO:END -->',
  '',
  'Mine egne ord om ## Materialer her.',
  '',
].join('\n');

const NEW_PLAN = [
  '---',
  'course: Musik',
  'topic: "Musikforståelse"',
  'start: "2026-09-01 12:25"',
  'stop: "2026-09-01 15:45"',
  'room: "B204"',
  'fetched: "2026-09-06 08:00"',
  'type: lesson-plan',
  'plan_id: "36016:1235133"',
  'literature: |',
  '  Frede V Nielsen (2010): Ars og Scientia',
  'literature_files: |',
  '  [[Fag/Musik/MD/E/Ars.md|Ars.md]]',
  '  [[Fag/Musik/MD/E/Bog.md|Bog.md]]',
  'preparation: |',
  '  Forberedelse',
  '  Læs kapitel 2',
  '---',
  '',
  '<!-- AUTO:START -->',
  '# Titel',
  '',
  '## Materials',
  '- [[Fag/Musik/MD/E/Ars.md|Ars.md]]',
  '',
  '## Preparation',
  '',
  'Læs.',
  '',
  '[Open "Forberedelse" in itslearning](https://via.itslearning.com/x)',
  '<!-- AUTO:END -->',
  '',
  'Mine egne ord om ## Materialer her.',
  '',
].join('\n');

test('[PLAN]: nøgler, type, falske værdier, præfikser og overskrifter; egne ord røres ikke', () => {
  const r = migrateNote(OLD_PLAN, 'Fag/Musik/MD/E/[PLAN] 2026-09-01 - T.md');
  assert.equal(r.text, NEW_PLAN);
  assert.ok(r.changed);
  assert.deepEqual(leftovers(OLD_PLAN), []);
  assert.deepEqual(leftovers(NEW_PLAN), []);
});

test('idempotent: anden kørsel ændrer intet', () => {
  const once = migrateNote(OLD_PLAN).text;
  const twice = migrateNote(once);
  assert.equal(twice.text, once);
  assert.equal(twice.changed, false);
});

test('[NOTE]-stub: ⚒ væk, kryds bevares, Kilde: -> Source:', () => {
  const old = '---\ntype: note\nfag: Musik\nuge: 2026-W36\nugedag: tirsdag\ndato: 2026-09-01\nemne: "T"\nstart: "2026-09-01 12:25"\nkilde: "[[PLAN x]]"\ntags: []\n---\n\nKilde: [[PLAN x]]\n\n## ⚒ Forberedelse\n- [x] ⚒ Forberedelse\n- [ ] ⚒ Læs kapitel 2\n\nMine noter\n';
  const want = '---\ntype: note\ncourse: Musik\ntopic: "T"\nstart: "2026-09-01 12:25"\nsource: "[[PLAN x]]"\ntags: []\n---\n\nSource: [[PLAN x]]\n\n## Preparation\n- [x] Forberedelse\n- [ ] Læs kapitel 2\n\nMine noter\n';
  assert.equal(migrateNote(old, 'Fag/Musik/NOTER/E/[NOTE] 2026-09-01 - T.md').text, want);
});

test('type: note uden [NOTE]-præfiks er brugerens egen og røres ikke', () => {
  const own = '---\ntype: note\nfag: Musik\ndato: 2026-09-01\n---\n\ntekst\n';
  const r = migrateNote(own, 'Fag/Musik/NOTER/E/Min note.md');
  assert.equal(r.text, own);
  assert.equal(r.changed, false);
});

test('egne typer (viden, litteraturnote) og noter uden frontmatter røres ikke', () => {
  for (const t of ['viden', 'litteraturnote']) {
    const own = `---\ntype: ${t}\nfag: Musik\nemne: x\ndato: 2026-09-01\n---\n\n## Materialer\n`;
    assert.equal(migrateNote(own, 'Fag/a.md').changed, false);
  }
  assert.equal(migrateNote('bare tekst\n', 'Fag/a.md').changed, false);
  assert.deepEqual(leftovers('---\ntype: viden\nfag: Musik\nemne: x\n---\n'), ['fag', 'emne']);
});

test('materiale: lektion/used_in-stemplet og kilde følger med', () => {
  const old = '---\nfag: Musik\nuge: 2026-W36\nugedag: tirsdag\ndato: 2026-09-01\ntype: materiale\nkilde: "[[Fag/Musik/RAW/E/Bog.pdf]]"\nhentet: "2026-09-06 08:00"\nemne: "T"\nstart: "2026-09-01 12:25"\nlektion: "36016:1"\nused_in:\n  - "36016:2"\n---\n\nbrødtekst\n';
  const want = '---\ncourse: Musik\ntype: material\nsource: "[[Fag/Musik/RAW/E/Bog.pdf]]"\nfetched: "2026-09-06 08:00"\ntopic: "T"\nstart: "2026-09-01 12:25"\nlesson: "36016:1"\nused_in:\n  - "36016:2"\n---\n\nbrødtekst\n';
  assert.equal(migrateNote(old, 'Fag/Musik/MD/E/Bog.md').text, want);
});

test('type: dublet: nøgler og overskrifter migreres, typen beholdes', () => {
  const old = '---\nfag: Religion\nuge: 2026-W37\ndato: 2026-09-09\nemne: "T"\nhentet: "2026-09-06 08:00"\ntype: dublet\nlitteratur: false\n---\n\n## ⚒ Forberedelse\n';
  const want = '---\ncourse: Religion\ntopic: "T"\nfetched: "2026-09-06 08:00"\ntype: dublet\n---\n\n## Preparation\n';
  assert.equal(migrateNote(old, 'Fag/Religion/MD/T/[PLAN] x.md').text, want);
});

test('materiale: sektion -> section', () => {
  const old = '---\ntype: material\ncourse: M\nsektion: "Kap. 8"\nlesson: "1:2"\n---\n';
  assert.equal(migrateNote(old, 'Fag/M/MD/E/x.md').text, '---\ntype: material\ncourse: M\nsection: "Kap. 8"\nlesson: "1:2"\n---\n');
});

test('keepLocation: room/teacher fra den gamle note bevares, nye værdier vinder', () => {
  const fm = '---\ncourse: M\nstop: "x"\nfetched: "y"\n---\n';
  const old = '---\nroom: "A212"\nteacher: "MKOR"\n---\n';
  assert.equal(plugin.keepLocation(fm, old), '---\ncourse: M\nstop: "x"\nroom: "A212"\nteacher: "MKOR"\nfetched: "y"\n---\n');
  assert.equal(plugin.keepLocation(fm.replace('stop: "x"', 'stop: "x"\nroom: "B1"'), old), '---\ncourse: M\nstop: "x"\nroom: "B1"\nteacher: "MKOR"\nfetched: "y"\n---\n');
  assert.equal(plugin.keepLocation(fm, null), fm);
});

test('opgavenote', () => {
  const old = '---\ntype: opgave\nfag: Musik\ndeadline: "2026-10-01 12:00"\nkilde: "https://via.itslearning.com/x?ElementID=1"\nhentet: "2026-09-06 08:00"\n---\n\n# O\n\nDeadline: x\n\n[Åbn opgaven i itslearning](https://x)\n\n## Opgavebeskrivelse\n- [[Noter/Opgaver/O/MD/O.md]]\n';
  const want = '---\ntype: assignment\ncourse: Musik\ndeadline: "2026-10-01 12:00"\nsource: "https://via.itslearning.com/x?ElementID=1"\nfetched: "2026-09-06 08:00"\n---\n\n# O\n\nDeadline: x\n\n[Open the assignment in itslearning](https://x)\n\n## Assignment description\n- [[Noter/Opgaver/O/MD/O.md]]\n';
  assert.equal(migrateNote(old, 'Noter/Opgaver/O/O.md').text, want);
});

test('felt med indhold beholdes: beskrivelse og forberedelse_tekst med tekst bliver til description/preparation_text', () => {
  const old = '---\ntype: lektionsplan\nfag: M\nforberedelse_tekst: |\n  Læs side 3.\n\n  Og 4.\nbeskrivelse: |\n  Tekst\n---\n';
  const want = '---\ntype: lesson-plan\ncourse: M\npreparation_text: |\n  Læs side 3.\n\n  Og 4.\ndescription: |\n  Tekst\n---\n';
  assert.equal(migrateNote(old, 'Fag/M/MD/E/[PLAN] x.md').text, want);
});

test('felt-hjælpere uden præfikser og uden false-pladsholdere', () => {
  assert.deepEqual(plugin.fieldLines('[[a|b]]\n  [[c|d]]\n\n'), ['[[a|b]]', '[[c|d]]']);
  assert.deepEqual(plugin.fieldLines(undefined), []);
  const none = '---\ntype: lesson-plan\n---\n\nbody\n';
  assert.equal(plugin.appendFileListField(none, 'material_files', ['[[x|x]]']), '---\ntype: lesson-plan\nmaterial_files: |\n  [[x|x]]\n---\n\nbody\n');
  const some = '---\nmaterial_files: |\n  [[a|a]]\ntype: lesson-plan\n---\n';
  assert.equal(plugin.appendFileListField(some, 'material_files', ['[[x|x]]']), '---\nmaterial_files: |\n  [[a|a]]\n  [[x|x]]\ntype: lesson-plan\n---\n');
  assert.equal(plugin.removeFileListLines(some, 'material_files', new Set(['a'])), '---\ntype: lesson-plan\n---\n');
});
