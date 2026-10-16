'use strict';
const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap');

test('inRawBranch følger kun de to rødder (#269)', () => {
  plugin.applyRoots({});
  assert.ok(plugin.inRawBranch('Fag/Musik/RAW/E/a.pdf'));
  assert.ok(plugin.inRawBranch('Noter/Opgaver/Opg/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Andet/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Fagx/M/RAW/a.pdf'));
});

test('rødderne kan ændres og normaliseres', () => {
  plugin.applyRoots({ fagRoot: '§ FAG/', opgaverRoot: '/✎ NOTER/OPGAVER' });
  assert.ok(plugin.inRawBranch('§ FAG/M/RAW/a.pdf'));
  assert.ok(plugin.inRawBranch('✎ NOTER/OPGAVER/O/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Fag/M/RAW/a.pdf'));
  assert.ok(plugin.touchesHoldCourseInput('✎ NOTER/OPGAVER/O/O.md'));
  assert.ok(!plugin.touchesHoldCourseInput('Andet/OPGAVER/O.md'));
  plugin.applyRoots({});
});

test('ekstra mapper konverteres og får folder: i stedet for course:', () => {
  plugin.applyRoots({ extraFolders: ['/almind/SFF/', ''] });
  assert.ok(plugin.inRawBranch('almind/SFF/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('almind/Andet/RAW/a.pdf'));
  const fm = plugin.materialeFrontmatter('almind/SFF/RAW/a.pdf', [], '2026-10-15T22:00');
  assert.match(fm, /^---\nfolder: "SFF"\n/);
  assert.doesNotMatch(fm, /course:/);
  plugin.applyRoots({});
  assert.match(plugin.materialeFrontmatter('Fag/Musik/RAW/a.pdf', [], 'x'), /course: Musik/);
});
