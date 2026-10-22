'use strict';
const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap');

test('inRawBranch følger kun de to rødder (#269)', () => {
  plugin.applyRoots({});
  assert.ok(plugin.inRawBranch('Courses/Dansk/RAW/E/a.pdf'));
  assert.ok(plugin.inRawBranch('Noter/Opgaver/Opg/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Andet/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Coursesx/M/RAW/a.pdf'));
});

test('rødderne kan ændres og normaliseres', () => {
  plugin.applyRoots({ fagRoot: '§ FAG/', opgaverRoot: '/✎ NOTER/OPGAVER' });
  assert.ok(plugin.inRawBranch('§ FAG/M/RAW/a.pdf'));
  assert.ok(plugin.inRawBranch('✎ NOTER/OPGAVER/O/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Courses/M/RAW/a.pdf'));
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
  assert.match(plugin.materialeFrontmatter('Fag/Dansk/RAW/a.pdf', [], 'x'), /course: Dansk/);
});

test('ekstra mappe: RAW-undermappen og bagudvendt skråstreg accepteres', () => {
  plugin.applyRoots({ extraFolders: ['SFF/RAW', '/SFF2/RAW/'] });
  assert.ok(plugin.inRawBranch('SFF/RAW/a.pdf'));
  assert.ok(plugin.inRawBranch('SFF2/RAW/a.pdf'));
  plugin.applyRoots({});
});

test('ekstra mappe "/" = hele vaulten (#308), men kun RAW-mapper', () => {
  plugin.applyRoots({ extraFolders: ['/'] });
  assert.ok(plugin.inRawBranch('almind/DK-LOM/RAW/a.pdf'));
  assert.ok(plugin.inRawBranch('RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('almind/DK-LOM/a.pdf'));
  assert.match(plugin.materialeFrontmatter('almind/DK-LOM/RAW/a.pdf', [], 'x'), /^---\nfolder: "DK-LOM"\n/);
  plugin.applyRoots({ extraFolders: [' ', ''] });
  assert.ok(!plugin.inRawBranch('almind/DK-LOM/RAW/a.pdf'));
  plugin.applyRoots({});
});

test('standardrod er Courses, og gemt fagRoot røres ikke (#304)', () => {
  plugin.applyRoots({});
  assert.ok(plugin.inRawBranch('Courses/Dansk/RAW/a.pdf'));
  assert.ok(!plugin.inRawBranch('Fag/Dansk/RAW/a.pdf'));
  plugin.applyRoots({ fagRoot: 'Fag' });
  assert.ok(plugin.inRawBranch('Fag/Dansk/RAW/a.pdf'));
  plugin.applyRoots({});
});

test('pinLegacyRoots: gammel installation fastlåses på Fag, ny og gemt valg røres ikke (#304)', () => {
  const old = {};
  assert.equal(plugin.pinLegacyRoots(old, {}, true), true);
  assert.equal(old.fagRoot, 'Fag');
  const oldData = {};
  assert.equal(plugin.pinLegacyRoots(oldData, { downloadedElementIds: ['1'] }, false), true);
  assert.equal(oldData.fagRoot, 'Fag');
  const fresh = {};
  assert.equal(plugin.pinLegacyRoots(fresh, { downloadedElementIds: [], planNoteContentHashes: {}, calendarEventMap: {} }, false), false);
  assert.equal(fresh.fagRoot, undefined);
  const saved = { fagRoot: 'Kurser' };
  assert.equal(plugin.pinLegacyRoots(saved, { downloadedElementIds: ['1'] }, true), false);
  assert.equal(saved.fagRoot, 'Kurser');
});

test('spørgsmålet om mappenavne stilles kun i en ny, urørt vault (#304)', () => {
  assert.equal(plugin.needsFolderQuestion({}), true);
  assert.equal(plugin.needsFolderQuestion({ foldersAsked: true }), false);
  assert.equal(plugin.needsFolderQuestion({ fagRoot: 'Fag' }), false);
  assert.equal(plugin.needsFolderQuestion({ opgaverRoot: 'X' }), false);
});

test('itslearning-adressen normaliseres, tom/ugyldig giver VIA (#296)', () => {
  const n = plugin.normalizeItslearningHost;
  assert.equal(n(''), 'via.itslearning.com');
  assert.equal(n(undefined), 'via.itslearning.com');
  assert.equal(n('skole.itslearning.com'), 'skole.itslearning.com');
  assert.equal(n(' https://Skole.itslearning.com/CourseCards '), 'skole.itslearning.com');
  assert.equal(n('not a host'), 'via.itslearning.com');
});
