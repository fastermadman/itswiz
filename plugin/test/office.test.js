'use strict';

// #286: docx/pptx → markdown straight from the XML. Built from minimal in-memory zip entries.

const test = require('node:test');
const assert = require('node:assert');
const plugin = require('./_bootstrap.js');

const E = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));

test('docx: headings, bold, link, list, table and picture', () => {
  const doc = `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:hyperlink r:id="rId2"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>item &amp; more</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
  </w:body></w:document>`;
  const rels = `<Relationships><Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="https://x.dk" TargetMode="External"/></Relationships>`;
  const { body, images } = plugin.officeToMarkdown('.docx', E({ 'word/document.xml': doc, 'word/_rels/document.xml.rels': rels, 'word/media/image1.png': 'PNG' }), 'Note');
  assert.match(body, /^# Intro/);
  assert.match(body, /Plain \*\*bold\*\*\[site\]\(https:\/\/x\.dk\)/);
  assert.match(body, /\n {2}- item & more/);
  assert.match(body, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(body, /!\[\[Note-1\.png\]\]/);
  assert.deepStrictEqual(images.map((i) => i[0]), ['Note-1.png']);
});

test('pptx: slide order, title, bullets, picture and notes', () => {
  const pres = `<p:presentation><p:sldIdLst><p:sldId r:id="rA"/><p:sldId r:id="rB"/></p:sldIdLst></p:presentation>`;
  const presRels = `<Relationships><Relationship Id="rA" Target="slides/slide2.xml"/><Relationship Id="rB" Target="slides/slide1.xml"/></Relationships>`;
  const s2 = `<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sp>
    <p:sp><a:p><a:pPr lvl="1"/><a:r><a:t>point</a:t></a:r></a:p></p:sp><p:pic><a:blip r:embed="rI"/></p:pic></p:sld>`;
  const s2rels = `<Relationships><Relationship Id="rI" Target="../media/a.jpg"/><Relationship Id="rN" Target="../notesSlides/notesSlide2.xml"/></Relationships>`;
  const notes = `<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><a:p><a:r><a:t>say this</a:t></a:r></a:p></p:sp></p:notes>`;
  const s1 = `<p:sld><p:sp><a:p><a:r><a:t>second</a:t></a:r></a:p></p:sp></p:sld>`;
  const { body } = plugin.officeToMarkdown('.pptx', E({
    'ppt/presentation.xml': pres, 'ppt/_rels/presentation.xml.rels': presRels,
    'ppt/slides/slide2.xml': s2, 'ppt/slides/_rels/slide2.xml.rels': s2rels, 'ppt/slides/slide1.xml': s1,
    'ppt/notesSlides/notesSlide2.xml': notes, 'ppt/media/a.jpg': 'J',
  }), 'Deck');
  assert.match(body, /^## Slide 1: First\n\n {2}- point\n\n!\[\[Deck-1\.jpg\]\]\n\n> \*\*Notes\*\*\n> say this\n\n## Slide 2\n\n- second/);
});
