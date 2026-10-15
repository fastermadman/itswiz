'use strict';

// #283: the rule that sends a digital PDF to PDFable's --text instead of MinerU. The stderr rows are PDFable's real
// report format (docs/text-extraction.md): page label kind glyphs unmapped rotated tables image_share.

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

const row = (page, glyphs, unmapped, share, kind = 'digital') => `${page}\t${page}\t${kind}\t${glyphs}\t${unmapped}\t0\t0\t${share}`;
const report = (rows) => plugin.parseTextReport(['page\tlabel\tkind\tglyphs\tunmapped\trotated\ttables\timage_share', ...rows].join('\n'));

test('parseTextReport skips the header and reads the numbers', () => {
  const r = report([row(1, 1200, 3, '0.04'), row(2, 900, 0, '0.30')]);
  assert.deepStrictEqual(r.map((x) => [x.page, x.glyphs, x.unmapped, x.imageShare]), [[1, 1200, 3, 0.04], [2, 900, 0, 0.3]]);
});

test('text route: all D, small image share, few unmapped glyphs', () => {
  assert.strictEqual(plugin.textRouteOk('DD\n', report([row(1, 1000, 5, '0.02'), row(2, 1000, 5, '0.14')])), true);
});

test('text route is refused for a scan page, a picture page, many unmapped glyphs or a mismatching report', () => {
  const ok = [row(1, 1000, 0, '0.02'), row(2, 1000, 0, '0.02')];
  assert.strictEqual(plugin.textRouteOk('DS', report(ok)), false);
  assert.strictEqual(plugin.textRouteOk('DD', report([row(1, 1000, 0, '0.02'), row(2, 1000, 0, '0.15')])), false);
  assert.strictEqual(plugin.textRouteOk('DD', report([row(1, 1000, 30, '0.02'), row(2, 1000, 0, '0.02')])), false);
  assert.strictEqual(plugin.textRouteOk('DDD', report(ok)), false);
  assert.strictEqual(plugin.textRouteOk('', report([])), false);
  assert.strictEqual(plugin.textRouteOk('D', report([row(1, 0, 0, '0.00')])), false);
});

test('parseTextReport also reads the 9-column report that --figures prints', () => {
  const r = plugin.parseTextReport('page\tlabel\tkind\tglyphs\tunmapped\trotated\ttables\timage_share\tfigures\n1\t1\tdigital\t900\t0\t0\t0\t0.04\t2');
  assert.deepStrictEqual(r.map((x) => [x.page, x.glyphs, x.imageShare]), [[1, 900, 0.04]]);
});
