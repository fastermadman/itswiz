'use strict';

// Kopien i plugin/main.js må ikke drifte fra background.js, mens begge findes (#239: background.js
// er frosset indtil #244). Indlæser background.js i en sandkasse med en chrome-attrap og kræver, at
// hver ren funktion giver samme output i begge. Slettes sammen med background.js i #244.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plugin = require('./_bootstrap.js');

const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
const ctx = vm.createContext({ chrome: noop, console, URL, Intl });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'background.js'), 'utf8'), ctx);
const ext = (name) => vm.runInContext(name, ctx);

const plans = [
  { courseName: 'LSmu-2527', start: '2026-10-13T08:30:00.0000000', topic: { name: 'Når børn synger.' }, elements: [] },
  { courseName: 'LSkr-2628', start: '2027-01-04T12:30:00.0000000', topic: null, elements: [
    { id: 1, title: 'Forberedelse ', typeName: 'Arbejdsopgave', body: '<p>Læs <a href="https://x.dk">dette</a></p>', url: '/a', isCompleted: false },
    { id: 2, title: 'Aristoteles Bog 6 (uddrag).pdf', typeName: 'Fil', url: '/b' },
    { id: 3, title: 'Ukendt kursus kap. 2', typeName: 'Fil', url: '/c' },
  ], fields: [{ headingText: 'Tilhørende litteratur (læses forud for lektionen)', text: '<p>Aristoteles: Bog 6 uddrag</p>' }] },
  { courseName: 'Ukendt', start: '2026-12-31T23:00:00.0000000', topic: { name: 'a/b:c*?' }, elements: [] },
];

test('plan-afledte stier og felter er ens', () => {
  for (const plan of plans) {
    for (const fn of ['isoWeek', 'weekdayDa', 'enhedFolder', 'planNoteName', 'weekFolderName', 'planLiteratureText']) {
      assert.deepStrictEqual(plugin[fn](plan), ext(fn)(plan), `${fn}(${plan.start})`);
    }
    assert.deepStrictEqual(JSON.stringify(plugin.forberedelseElements(plan)), JSON.stringify(ext('forberedelseElements')(plan)));
    for (const title of ['Titel.docx', 'Frede V Nielsen kap. 2', 'x.PDF']) {
      for (const fn of ['rawPath', 'mdPath']) {
        assert.strictEqual(plugin[fn](plan.courseName, plugin.enhedFolder(plan), title), ext(fn)(plan.courseName, ext('enhedFolder')(plan), title));
      }
    }
    assert.strictEqual(plugin.noteStubPath(plan.courseName, 'E', 'W'), ext('noteStubPath')(plan.courseName, 'E', 'W'));
  }
});

test('tekst-funktioner er ens', () => {
  const html = '<p>A&nbsp;<a href="https://y">link</a></p><br><table><tr><td>x</td></tr></table>';
  assert.strictEqual(plugin.stripHtml(html), ext('stripHtml')(html));
  assert.strictEqual(plugin.stripHtml(html, true), ext('stripHtml')(html, true));
  for (const existing of [null, 'mine noter', '<!-- AUTO:START -->\ngammel\n<!-- AUTO:END -->\n\nmine']) {
    assert.strictEqual(plugin.spliceAutoSection(existing, 'ny'), ext('spliceAutoSection')(existing, 'ny'));
  }
  assert.strictEqual(plugin.summarizeAutoChange('a\nb', 'a\nb\nc'), ext('summarizeAutoChange')('a\nb', 'a\nb\nc'));
  assert.strictEqual(plugin.simpleHash('v11\nindhold'), ext('simpleHash')('v11\nindhold'));
  assert.strictEqual(plugin.sanitizeFilename(' Når børn synger. '), ext('sanitizeFilename')(' Når børn synger. '));
  const url = 'https://filecache.itslearning.com/x?response-content-disposition=attachment%3B%20filename%3D%22K%C3%B8.pdf%22';
  assert.strictEqual(plugin.extractExtension(url), ext('extractExtension')(url));
  const lit = plugin.planLiteratureText(plans[1]);
  assert.deepStrictEqual(
    plugin.matchLiteratureElements(lit, plans[1].elements).map((e) => e.id),
    ext('matchLiteratureElements')(lit, plans[1].elements).map((e) => e.id)
  );
  const task = { TaskUrl: 'https://via.itslearning.com/main.aspx?CourseID=1&ElementID=42', CourseId: 1, TaskTitle: 'T' };
  assert.strictEqual(plugin.taskId(task), ext('taskId')(task));
});

test('FRONTMATTER_VERSION og vault-rødder er ens', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const name of ['FRONTMATTER_VERSION', 'FAG_ROOT', 'NOTER_ROOT', 'BACKFILL_DAYS_BACK']) {
    const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.strictEqual(m && eval(m[1]), ext(name), name);
  }
});

test('Hold Course done-titler (#202)', () => {
  const data = { semesters: [{ classes: [{ lectures: [{ vswPlanId: '1:2', assignments: [
    { vswKey: 'L|forb|Forberedelse', status: 'done' }, { vswKey: 'L|forb|Andet', status: 'todo' },
  ] }] }] }] };
  assert.deepStrictEqual([...plugin.holdCourseDoneForbTitles(data, '1:2')], [...ext('holdCourseDoneForbTitles')(data, '1:2')]);
  assert.deepStrictEqual([...plugin.holdCourseDoneForbTitles(data, '1:2')], ['Forberedelse']);
});
