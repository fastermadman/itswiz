'use strict';

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

// Fagnavne er en indstilling (#270); testene forudsætter disse to.
plugin.applyCourseNames({ courseNames: { 'LSmu-2527': 'Musik', 'LSkr-2628': 'Religion' } });

const NOW = '2026-10-13T09:00:00.000Z';
const plan = (over = {}) => ({
  courseName: 'LSmu-2527', title: 'Uge 41 tirsdag', start: '2026-10-13T12:25:00.0000000', stop: '2026-10-13T15:45:00.0000000',
  topic: { name: 'Når børn synger' }, description: 'Intro', elements: [], ...over,
});
const items = (plans = { '1:10': plan() }, tasks = []) => plugin.calendarItems({ plans, orphanPlans: {}, tasks }, NOW);
const existingOf = (...ids) => new Map(ids.map((id) => [id, { title: 'T', description: '<p>d</p>' }]));
const run = (its, map, existing, seen, ok = ['1']) => plugin.calendarActions(its, map, existing, new Set(seen), new Set(ok), NOW);
const mapOf = (it, over = {}) => ({ [it.key]: { eventId: 5, start: it.start, end: it.end, hash: it.hash, cancelled: false, ...over } });

test('lektion: titel uden præfiks uden Hold Course, vægur-tid uden zone, planer uden tid springes over', () => {
  const [it] = items();
  assert.strictEqual(it.title, 'Musik: Når børn synger');
  assert.strictEqual(it.start, '2026-10-13T12:25:00');
  assert.strictEqual(it.end, '2026-10-13T15:45:00');
  assert.strictEqual(items({ '1:11': plan({ start: '2026-10-13T00:01:00', stop: '2026-10-13T23:59:00' }) }).length, 0);
});

test('farvecirkel: klassens colorIndex fra Hold Course, ukendt fag og uden synk = intet præfiks', () => {
  const colors = plugin.fagColors({ semesters: [{ classes: [{ vswFag: 'Musik', colorIndex: 5 }, { vswFag: 'Religion', colorIndex: 0 }, { name: 'Dansk', colorIndex: 3 }] }] });
  assert.deepStrictEqual(colors, { Musik: 5, Religion: 0 });
  const calItems = (c) => plugin.calendarItems({ plans: { '1:10': plan() }, orphanPlans: {}, tasks: [{ CourseTitle: 'LSkr-2628', TaskTitle: 'Essay', Deadline: '2026-10-20T12:00:00', TaskUrl: 'https://via.itslearning.com/x?ElementID=7' }] }, NOW, c);
  assert.deepStrictEqual(calItems(colors).map((i) => i.title), ['🟢 Musik: Når børn synger', '🟡 ⚑ Religion: aflevering: Essay']);
  assert.deepStrictEqual(calItems({}).map((i) => i.title), ['Musik: Når børn synger', '⚑ Religion: aflevering: Essay']);
});

test('vindue: planer før i går og null-planer springes over', () => {
  assert.strictEqual(items({ '1:1': plan({ start: '2026-10-01T10:00:00', stop: '2026-10-01T11:00:00' }), '1:2': null }).length, 0);
});

test('afleveringsfrist: 30 minutter der slutter ved deadline', () => {
  const [it] = items({}, [{ CourseTitle: 'LSkr-2628', TaskTitle: 'Essay', Deadline: '2026-10-20T12:00:00', TaskUrl: 'https://via.itslearning.com/x?ElementID=7' }]);
  assert.strictEqual(it.key, 'opgave:7');
  assert.strictEqual(it.title, '⚑ Religion: aflevering: Essay');
  assert.strictEqual(it.start, '2026-10-20T11:30:00');
  assert.strictEqual(it.end, '2026-10-20T12:00:00');
});

test('nyt, uændret, rettet, flyttet, selv-slettet', () => {
  const [it] = items();
  assert.deepStrictEqual(run([it], {}, existingOf(), ['1:10']).map((a) => a.type), ['create']);
  assert.deepStrictEqual(run([it], mapOf(it), existingOf(5), ['1:10']), []);
  assert.deepStrictEqual(run([it], mapOf(it, { hash: 'x' }), existingOf(5), ['1:10']).map((a) => a.type), ['edit']);
  const moved = run([it], mapOf(it, { start: '2026-10-12T08:00:00' }), existingOf(5), ['1:10'])[0];
  assert.deepStrictEqual([moved.type, moved.oldEventId], ['move', 5]);
  assert.deepStrictEqual(run([it], mapOf(it), existingOf(), ['1:10']).map((a) => a.type), ['create']); // slettet i kalenderen
});

test('aflyst: kun når planen er væk fra et fag der blev hentet, og lektionen ligger fremme', () => {
  const m = { '1:99': { eventId: 8, start: '2026-10-14T10:00:00', end: '2026-10-14T11:00:00', hash: 'h', cancelled: false } };
  assert.deepStrictEqual(run([], m, existingOf(8), []).map((a) => a.type), ['cancel']);
  assert.deepStrictEqual(run([], m, existingOf(8), [], []), []); // faget fejlede: ingenting
  assert.deepStrictEqual(run([], m, existingOf(8), ['1:99']), []); // planen findes stadig (fx uden tid)
  m['1:99'].start = '2026-10-01T10:00:00';
  assert.deepStrictEqual(run([], m, existingOf(8), []), []); // fortid røres ikke
  m['1:99'].start = '2026-10-14T10:00:00'; m['1:99'].cancelled = true;
  assert.deepStrictEqual(run([], m, existingOf(8), []), []); // allerede aflyst
});

test('aflyst lektion der dukker op igen rettes tilbage', () => {
  const [it] = items();
  assert.deepStrictEqual(run([it], mapOf(it, { cancelled: true }), existingOf(5), ['1:10']).map((a) => a.type), ['edit']);
});

test('afleveringsopgaver aflyses aldrig', () => {
  const m = { 'opgave:7': { eventId: 8, start: '2026-10-20T11:30:00', end: '2026-10-20T12:00:00', hash: 'h' } };
  assert.deepStrictEqual(run([], m, existingOf(8), []), []);
});
