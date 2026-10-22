'use strict';

// #270: fagnavne som indstilling. Navnet styrer mappen, Hold Course-klassen og forløbsfilen.

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

test.beforeEach(() => plugin.applyCourseNames({ courseNames: { 'LSmu-2527': 'Musik', 'LStek-f26': '' } }));

test('kode -> navn; ukendt kode og tomt navn falder tilbage til koden; mappen er navnet uden symbol', () => {
  assert.strictEqual(plugin.courseDisplayName('LSmu-2527'), 'Musik');
  assert.strictEqual(plugin.courseDisplayName('LStek-f26'), 'LStek-f26');
  assert.strictEqual(plugin.courseDisplayName('Hjælp'), 'Hjælp');
  assert.strictEqual(plugin.courseFolderName('LSmu-2527'), 'Musik');
});

test('forloebPath virker for alle fag med en mappe, ikke kun de gamle tre', () => {
  const dirs = new Set(['Courses/Musik', 'Courses/Dansk']);
  const isDir = (p) => dirs.has(p);
  const sem = { name: 'Efterår 2026' };
  assert.strictEqual(plugin.forloebPath(sem, { vswFag: 'Dansk' }, false, isDir), 'Courses/Dansk/_forløb.md');
  assert.strictEqual(plugin.forloebPath(sem, { vswFag: 'Musik' }, true, isDir), 'Courses/Musik/_HoldCourse/Efterår 2026.md');
  assert.strictEqual(plugin.forloebPath(sem, { vswFag: 'Praktik' }, false, isDir), null);
});

test('ensureClass: code og colorIndex sættes kun ved oprettelsen', () => {
  let n = 0;
  const newId = () => `id${n++}`;
  const sem = { classes: [] };
  const cls = plugin.ensureClass(sem, 'Musik', newId, '36016');
  assert.strictEqual(cls.code, 'LSmu-2527');
  assert.strictEqual(cls.name, 'Musik');
  assert.strictEqual(cls.colorIndex, 0);
  assert.strictEqual(plugin.ensureClass(sem, 'Dansk', newId).code, 'Dansk'); // ukendt kode: fagnavnet
  Object.assign(cls, { code: 'Min kode', colorIndex: 4, name: 'Mit navn' });
  const again = plugin.ensureClass(sem, 'Musik', newId, '36016');
  assert.strictEqual(again, cls);
  assert.deepStrictEqual([again.code, again.colorIndex, again.name], ['Min kode', 4, 'Mit navn']);
});

// #295: kun valgte fag høstes.
test('filterCourses: tomt eller manglende udvalg giver ingen fag; ellers kun de valgte, på kortets Title', () => {
  const cards = [{ Title: 'LSmu-2527', CourseId: 1 }, { Title: 'Hjælp', CourseId: 2 }, { Title: 'LStek-f26', CourseId: 3 }];
  assert.deepStrictEqual(plugin.filterCourses(cards, []), []);
  assert.deepStrictEqual(plugin.filterCourses(cards, undefined), []);
  assert.deepStrictEqual(plugin.filterCourses(cards, ['LSmu-2527', 'ukendt']).map((c) => c.CourseId), [1]);
});

test('migrateSelectedCourses: eksisterende fagnavne vælges én gang, ny bruger starter tom, et udvalg røres aldrig', () => {
  const existing = { courseNames: { 'LSmu-2527': 'Musik', Hjælp: '' } };
  assert.strictEqual(plugin.migrateSelectedCourses(existing), true);
  assert.deepStrictEqual(existing.selectedCourses, ['LSmu-2527', 'Hjælp']);
  const fresh = {};
  assert.strictEqual(plugin.migrateSelectedCourses(fresh), true);
  assert.deepStrictEqual(fresh.selectedCourses, []);
  const chosen = { courseNames: { a: '', b: '' }, selectedCourses: ['a'] };
  assert.strictEqual(plugin.migrateSelectedCourses(chosen), false);
  assert.deepStrictEqual(chosen.selectedCourses, ['a']);
});
