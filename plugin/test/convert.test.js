'use strict';

// #241: konverterings-porten skal give samme output som watch_viastudywiz.py. Forventningerne er
// genereret af Python-watcheren på samme input (opslag der splittes, fodnote, billede, ISO-uge 53,
// lesson:/used_in:). Paritet på rigtige MinerU-zips blev målt separat: 20/20 ens (PR-beskrivelsen).

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

const zip = Buffer.from('UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAHAAAAaW1hZ2VzL1BLAwQUAAAACADIHkxdVMRg+GkAAACAAAAABwAAAGZ1bGwubWRTVnA7vKOouCRVoTgzJVUhKTW9Mi8ltUghA4hzU1MU8vLTU0sUSlKzi0u4uHJTi1K5uMJS84pLilIVMhJzylJScxQS0xTyC4pzEoEKubg8Du/IwiWnGB2rkZkLZBfrJyYl62UVpGtyAQBQSwMEFAAAAAgAyB5MXdKNyKDpAAAAMgMAABUAAABhYmNfY29udGVudF9saXN0Lmpzb26lkk0LwjAMhv9K2Fmk82N+3BXBu5cp0tFsU2c71igT8b/bqUNXpDI8NE0KefLypuHVo0uO3hQ8wpK8zus29Xx9YiweF5oQ9E4gRJhcpMACUnOOKECqBAkID/rRmPMEtztRmmZmyihSVRr6pngeE3psc+vAe+ijJ1aKpCL8nO7DTEKsRP3ugE9YTZ/43/DydIywaMB7DuSwAlUhqJLAIqbIRRO25HkXxj801gqHTZrt+QqlpgIh5dlZYAY8BpXrzHBth/1WDn+xoO8Aui2wRS+eH2XfWnfAXsJHbYQPXMS38n+2Z5v7sb3NHVBLAwQUAAAAAADIHkxd8gFoKmUAAABlAAAACwAAAGxheW91dC5qc29ueyJwZGZfaW5mbyI6IFt7InBhZ2VfaWR4IjogMCwgInBhZ2Vfc2l6ZSI6IFs2MDAsIDEwMDBdfSwgeyJwYWdlX2lkeCI6IDEsICJwYWdlX3NpemUiOiBbMTIwMCwgMTAwMF19XX1QSwMEFAAAAAAAyB5MXdkqtScGAAAABgAAAA4AAABpbWFnZXMvYWJjLmpwZ//YanBlZ1BLAQIUAxQAAAAAAAAAIQAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAACAAQAAAABpbWFnZXMvUEsBAhQDFAAAAAgAyB5MXVTEYPhpAAAAgAAAAAcAAAAAAAAAAAAAAIABJQAAAGZ1bGwubWRQSwECFAMUAAAACADIHkxd0o3IoOkAAAAyAwAAFQAAAAAAAAAAAAAAgAGzAAAAYWJjX2NvbnRlbnRfbGlzdC5qc29uUEsBAhQDFAAAAAAAyB5MXfIBaCplAAAAZQAAAAsAAAAAAAAAAAAAAIABzwEAAGxheW91dC5qc29uUEsBAhQDFAAAAAAAyB5MXdkqtScGAAAABgAAAA4AAAAAAAAAAAAAAIABXQIAAGltYWdlcy9hYmMuanBnUEsFBgAAAAAFAAUAIgEAAI8CAAAAAA==', 'base64');
const marked = "# Første side begynder her med noget tekst\n\nmere\n\n\n\n---\n1 En fodnote\n\n*— side 12 —*\n\n---\n\nVenstre halvdel af opslaget\n\n\n\n*— side 13 —*\n\n---\n\nHøjre halvdel af opslaget\n\n![[abc.jpg]]\n\n*— side 14 —*\n";

test('zip → MD-brødtekst som watcheren', () => {
  const entries = plugin.unzip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length));
  assert.deepStrictEqual([...entries.keys()].sort(), ['abc_content_list.json', 'full.md', 'images/abc.jpg', 'layout.json']);
  assert.deepStrictEqual(plugin.conversionBody(entries), { body: marked, sektion: "Kap. 8" });
});

test('frontmatter-felter som watcheren', () => {
  const note = "---\ncourse: Dansk\nlesson: \"12345:1\"\nused_in:\n  - \"12345:2\"\n---\n\nbrødtekst\n";
  assert.strictEqual(plugin.carriedFields(note), "lesson: \"12345:1\"\nused_in:\n  - \"12345:2\"\n");
  assert.strictEqual(plugin.appendUsedIn(note, '12345:3'), "---\ncourse: Dansk\nlesson: \"12345:1\"\nused_in:\n  - \"12345:3\"\n  - \"12345:2\"\n---\n\nbrødtekst\n");
  assert.strictEqual(plugin.appendUsedIn(note, '12345:1'), null);
  assert.deepStrictEqual(plugin.mdTargets('§ FAG/♪ Dansk/RAW/Enhed/korte..pdf').md, '§ FAG/♪ Dansk/MD/Enhed/korte..md');
  assert.strictEqual(plugin.errorMarkerPath('Litteratur/RAW/Bog.pdf'), 'Litteratur/RAW/.Bog.mineru-error.txt');
});

test('materialenotens frontmatter: engelske nøgler, emne/start/stop fra planen, ingen uge/ugedag/dato (#271)', () => {
  const plan = { name: '[PLAN] 2026-09-01 - Tema.md', text: '---\ncourse: Dansk\ntopic: "Tema"\nstart: "2026-09-01 12:25:00"\nstop: "2026-09-01 15:45:00"\ntype: lesson-plan\nplan_id: "1:2"\n---\n' };
  assert.strictEqual(
    plugin.materialeFrontmatter('Fag/Dansk/RAW/Tema/Bog.pdf', [plan], '2026-10-14 10:00'),
    '---\ncourse: Dansk\ntype: material\nsource: "[[Fag/Dansk/RAW/Tema/Bog.pdf]]"\nfetched: "2026-10-14 10:00"\ntopic: "Tema"\nstart: "2026-09-01 12:25:00"\nstop: "2026-09-01 15:45:00"\n---\n\n'
  );
});

test('ejer-lektion findes også via RAW-link og NFD-navn (#241)', () => {
  const plan = (id, link) => ({ name: `[PLAN] ${id}.md`, text: `---\nplan_id: "${id}"\n---\n<!-- AUTO:START -->\n## Materials\n- ${link}\n<!-- AUTO:END -->\n` });
  const notes = [plan('1', '[[§ FAG/M/MD/E/Andet.md|Andet.md]]'), plan('2', '[[§ FAG/M/RAW/E/Danskforståelse.pdf|Danskforståelse.pdf]]')];
  assert.strictEqual(plugin.provenPlanId(notes, 'Danskforståelse.md'.normalize('NFD')), '2');
  assert.strictEqual(plugin.provenPlanId(notes, 'Ukendt.md'), null);
});

test('PDF over 200 sider deles i bidder på 100 (#211)', () => {
  assert.strictEqual(plugin.pageRanges(200), null);
  assert.deepStrictEqual(plugin.pageRanges(282), ['1-100', '101-200', '201-282']);
  const pdf = Buffer.from('<< /Type /Pages /Count 2 >> << /Type /Page >> <</Type/Page/Parent 1 0 R>>', 'latin1');
  assert.strictEqual(plugin.pdfPageCount(pdf), 2);
});

test('kopien ligger i _attachments ved noten med eget navn og samme endelse (#275)', () => {
  assert.strictEqual(plugin.copyTarget('§ FAG/♪ Dansk/RAW/Enhed/korte..pdf'), '§ FAG/♪ Dansk/MD/Enhed/_attachments/korte. (copy).pdf');
  assert.strictEqual(plugin.copyTarget('Opgaver/RAW/Bog: 1.pptx'), 'Opgaver/MD/_attachments/Bog_ 1 (copy).pptx');
});

test('pass 2 får samme flag som pass 1 plus ét --mineru pr. layout, i rækkefølge (#275)', () => {
  assert.deepStrictEqual(plugin.pdfableArgs([], 'in.pdf', 'out.pdf'), ['--rotate', '--crop', '--split', 'auto', '--deskew', 'in.pdf', 'out.pdf']);
  assert.deepStrictEqual(plugin.pdfableArgs(['l1.json', 'l2.json'], 'in.pdf', 'out.pdf'),
    ['--rotate', '--crop', '--split', 'auto', '--deskew', '--mineru', 'l1.json', '--mineru', 'l2.json', 'in.pdf', 'out.pdf']);
});

test('PDFables --mineru-advarsler genkendes, andre advarsler ikke (#275)', () => {
  assert.strictEqual(plugin.hasMineruWarning('Warning: --mineru: layout.json has 25 pages but the output has 50: no text layer (use the same flags as the run MinerU read)'), true);
  assert.strictEqual(plugin.hasMineruWarning('x\nWarning: --mineru: page 3 is [595, 842] pt in layout.json but 420x595 in the output: no text on it'), true);
  assert.strictEqual(plugin.hasMineruWarning('Warning: pages look like double pages but no confident gutter was found'), false);
  assert.strictEqual(plugin.hasMineruWarning(''), false);
});

test('PDF er digital når mere end halvdelen af siderne er det; uafgjort og tomt er scan (#281)', () => {
  assert.strictEqual(plugin.isDigitalPdf('DDDDDD\n'), true);
  assert.strictEqual(plugin.isDigitalPdf('SDDDDD'), true); // billedforside i et digitalt dokument
  assert.strictEqual(plugin.isDigitalPdf('DDS'), true);
  assert.strictEqual(plugin.isDigitalPdf('DS'), false);
  assert.strictEqual(plugin.isDigitalPdf('SSSSSD'), false);
  assert.strictEqual(plugin.isDigitalPdf(''), false);
  assert.strictEqual(plugin.isDigitalPdf('Warning: unknown option'), false);
});

test('layout.json fra alle zips i rækkefølge, ellers null (#275)', () => {
  const a = Buffer.from('{"a":1}');
  const b = Buffer.from('{"b":2}');
  assert.deepStrictEqual(plugin.layoutsOf([new Map([['layout.json', a]]), new Map([['layout.json', b]])]), [a, b]);
  assert.strictEqual(plugin.layoutsOf([new Map([['layout.json', a]]), new Map([['full.md', b]])]), null);
});
