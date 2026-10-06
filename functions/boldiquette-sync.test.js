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
