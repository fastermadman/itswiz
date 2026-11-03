'use strict';
const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap');

const PDF = 'Courses/Math/RAW/Week 1/a.pdf';
const DOCX = 'Courses/Math/RAW/Week 1/b.docx';
const RAW = 'Courses/Math/RAW';

test('no settings: everything is auto (#315)', () => {
  assert.strictEqual(plugin.resolveAction(PDF, 'pdf', undefined, undefined), 'auto');
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', {}, {}), 'auto');
});

test('precedence: file answer, folder, type, auto', () => {
  const conv = { byType: { pdf: 'onebit' }, byFolder: { [RAW]: 'mineru' } };
  assert.strictEqual(plugin.resolveAction(PDF, 'pdf', conv, { [PDF]: 'text' }), 'text');
  assert.strictEqual(plugin.resolveAction(PDF, 'pdf', conv, {}), 'mineru');
  assert.strictEqual(plugin.resolveAction('Courses/Other/RAW/x.pdf', 'pdf', conv, {}), 'onebit');
  assert.strictEqual(plugin.resolveAction('Courses/Other/RAW/x.pdf', 'PDF', {}, {}), 'auto');
});

test('Office files only take auto or skip; other values fall back one level', () => {
  assert.deepStrictEqual(plugin.allowedActions('docx'), ['auto', 'skip']);
  const conv = { byType: { docx: 'auto' }, byFolder: { [RAW]: 'text' } };
  assert.strictEqual(plugin.resolveAction(DOCX, 'docx', conv, {}), 'auto');
  assert.strictEqual(plugin.resolveAction(DOCX, 'docx', { byFolder: { [RAW]: 'skip' } }, {}), 'skip');
  assert.strictEqual(plugin.resolveAction(PDF, 'pdf', { byFolder: { [RAW]: 'nonsense' } }, {}), 'auto');
});

test('ask: waits unless the file has an answer; skip never asks', () => {
  const conv = { ask: true, byFolder: { [RAW]: 'text' } };
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', conv, {}), 'ask');
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', conv, { [PDF]: 'onebit' }), 'onebit');
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', conv, { [PDF]: 'skip' }), 'skip');
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', { ask: true, byFolder: { [RAW]: 'skip' } }, {}), 'skip');
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', { ask: false, byFolder: { [RAW]: 'text' } }, {}), 'text');
});

test('force never asks and never skips', () => {
  const conv = { ask: true, byFolder: { [RAW]: 'skip' } };
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', conv, {}, { force: true }), 'auto');
  assert.strictEqual(plugin.gateConversion(PDF, 'pdf', { ask: true, byFolder: { [RAW]: 'mineru' } }, {}, { force: true }), 'mineru');
});

test('textActionSet sees text anywhere', () => {
  assert.ok(!plugin.textActionSet({ byType: { pdf: 'auto' } }, {}));
  assert.ok(plugin.textActionSet({ byFolder: { [RAW]: 'text' } }, {}));
  assert.ok(plugin.textActionSet({}, { [PDF]: 'text' }));
});

test('conversionSummary: nothing, converted, failed (#318)', () => {
  assert.strictEqual(plugin.conversionSummary(0, 0), null);
  assert.strictEqual(plugin.conversionSummary(3, 0), 'ItsWiz: 3 file(s) converted.');
  assert.match(plugin.conversionSummary(2, 1), /2 file\(s\) converted, 1 failed/);
  assert.match(plugin.conversionSummary(0, 1), /0 file\(s\) converted, 1 failed/);
});
