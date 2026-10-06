const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeExport } = require('./boldiquette-sync');

const fictional = '<html><head><style>.red{color:red}</style></head><body>' +
  '<h1>BOLDiquette</h1><h2>Working together</h2>' +
  '<p class="red">Share a short update at the imaginary Tuesday meeting.</p>' +
  '<h2>Reviewing ideas</h2><p>Ask a colleague for feedback.</p></body></html>';

test('keeps readable sections and removes active or unsafe export markup', () => {
  const result = normalizeExport(fictional.replace('</body>',
    '<script>alert(1)</script><p><a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a></p></body>'));
  assert.match(result.html, /<h2 id="working-together">Working together<\/h2>/);
  assert.match(result.html, /Unsafe link<\/p>/);
  assert.doesNotMatch(result.html, /script|javascript:|onclick|class=|<style/);
  assert.deepEqual(result.toc.map((item) => item.label), ['Working together', 'Reviewing ideas']);
});

test('formatting-only export noise does not create a new content version', () => {
  const a = normalizeExport(fictional);
  const b = normalizeExport(fictional
    .replace('class="red"', 'style="font-size:14px"')
    .replace('<h2>Reviewing ideas</h2>', '\n  <h2>Reviewing ideas</h2>\n')
    .replace('short update at', 'short   update at'));
  assert.equal(a.hash, b.hash);
});

test('a real wording change creates a new version with comparable text blocks', () => {
  const a = normalizeExport(fictional);
  const b = normalizeExport(fictional.replace('Tuesday meeting', 'Thursday meeting'));
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.blocks[1].text, 'Share a short update at the imaginary Tuesday meeting.');
  assert.equal(b.blocks[1].text, 'Share a short update at the imaginary Thursday meeting.');
});

test('the Google Docs main-tab heading levels become section and subsection headings', () => {
  const exported = '<html><body><h4>Working together</h4><h5>Meetings</h5>' +
    '<p>Bring a fictional agenda.</p><h4>Reviewing ideas</h4><p>Ask for feedback.</p></body></html>';
  const result = normalizeExport(exported);
  assert.match(result.html, /<h2 id="working-together">Working together<\/h2><h3 id="meetings">Meetings<\/h3>/);
  assert.deepEqual(result.toc.map((item) => item.label), ['Working together', 'Reviewing ideas']);
});

test('drops the Google Doc cover and generated contents before the first section', () => {
  const exported = '<html><body><p>Confidential — BOLD Internal</p>' +
    '<p><a href="#toc">Working together 2</a></p>' +
    '<h4>Working together</h4><p>Bring a fictional agenda.</p>' +
    '<h4>Reviewing ideas</h4><p>Ask for feedback.</p></body></html>';
  const result = normalizeExport(exported);
  assert.match(result.html, /^<h2 id="working-together">/);
  assert.doesNotMatch(result.html, /Confidential|Working together 2/);
});

test('preserves Google Docs list indentation without importing generated CSS', () => {
  const exported = '<html><body><h4>Working together</h4>' +
    '<ul class="c3 lst-kix_example-0"><li>Four outputs:</li></ul>' +
    '<ul class="c3 lst-kix_example-1 start"><li>Technology:</li></ul>' +
    '<ul class="c3 lst-kix_example-2 start"><li>A fictional tool.</li></ul></body></html>';
  const result = normalizeExport(exported);
  assert.match(result.html, /<ul data-bold-list-level="1"><li>Technology:<\/li><\/ul>/);
  assert.match(result.html, /<ul data-bold-list-level="2"><li>A fictional tool\.<\/li><\/ul>/);
  assert.doesNotMatch(result.html, /lst-kix|class=/);
});
