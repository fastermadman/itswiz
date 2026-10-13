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
