'use strict';

// #301: filtyper og størrelsesgrænse for hentede filer.

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

test('fileCategory: endelse -> kategori (uanset store/små bogstaver), ukendt -> other', () => {
  assert.strictEqual(plugin.fileCategory('.pdf'), 'pdf');
  assert.strictEqual(plugin.fileCategory('.DOCX'), 'word');
  assert.strictEqual(plugin.fileCategory('.pptx'), 'powerpoint');
  assert.strictEqual(plugin.fileCategory('.mp4'), 'video');
  assert.strictEqual(plugin.fileCategory('.m4a'), 'audio');
  assert.strictEqual(plugin.fileCategory('.zip'), 'other');
  assert.strictEqual(plugin.fileCategory(''), 'other');
});

test('fileTypeAllowed: video og lyd er fra som standard, resten til; en indstilling vinder', () => {
  assert.strictEqual(plugin.fileTypeAllowed('.pdf', {}), true);
  assert.strictEqual(plugin.fileTypeAllowed('.mp4', {}), false);
  assert.strictEqual(plugin.fileTypeAllowed('.mp3', {}), false);
  assert.strictEqual(plugin.fileTypeAllowed('.zip', {}), true);
  assert.strictEqual(plugin.fileTypeAllowed('.mp4', { fileTypes: { video: true } }), true);
  assert.strictEqual(plugin.fileTypeAllowed('.pdf', { fileTypes: { pdf: false } }), false);
});

test('maxFileBytes: 50 MB som standard, 0 = ingen grænse', () => {
  assert.strictEqual(plugin.maxFileBytes({}), 50 * 1048576);
  assert.strictEqual(plugin.maxFileBytes({ maxFileSizeMB: 2 }), 2 * 1048576);
  assert.strictEqual(plugin.maxFileBytes({ maxFileSizeMB: 0 }), Infinity);
});

test('skipStillApplies: en husket fil hentes igen når typen slås til eller grænsen hæves', () => {
  assert.strictEqual(plugin.skipStillApplies(undefined, {}), false);
  assert.strictEqual(plugin.skipStillApplies({ category: 'video' }, {}), true);
  assert.strictEqual(plugin.skipStillApplies({ category: 'video' }, { fileTypes: { video: true } }), false);
  const big = { bytes: 80 * 1048576 };
  assert.strictEqual(plugin.skipStillApplies(big, {}), true);
  assert.strictEqual(plugin.skipStillApplies(big, { maxFileSizeMB: 100 }), false);
  assert.strictEqual(plugin.skipStillApplies(big, { maxFileSizeMB: 0 }), false);
});
