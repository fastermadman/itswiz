'use strict';

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

test('fileLink: MD når noten findes, ellers RAW-originalen (#241)', () => {
  const md = plugin.fileLink('LSmu-2527', 'Enhed', 'Titel.pdf', true);
  const raw = plugin.fileLink('LSmu-2527', 'Enhed', 'Titel.pdf', false);
  assert.match(md, /\/MD\/Enhed\/Titel\.md\|Titel\.md\]\]$/);
  assert.match(raw, /\/RAW\/Enhed\/Titel\.pdf\|Titel\.pdf\]\]$/);
});
