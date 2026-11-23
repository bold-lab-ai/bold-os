// Scoped heading IDs used by guide section links (markdown.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const ctx = {
  window: {},
  BOLD: {
    escapeHtml,
    TAG: /@\[([^\]]+)\]\((U[A-Z0-9]+)\)/g,
    IMAGE: /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g,
    imageHtml: () => '<img>',
    SLACK_TEAM: 'T'
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/markdown.js'), 'utf8'), ctx);
const render = (text, opts) => ctx.window.BoldMarkdown.render(text, opts);

test('scoped duplicate headings and natural suffix collisions get unique IDs', () => {
  const headings = [];
  const html = render('# Methods\n# Methods\n# Methods-2', { headingPrefix: 'part-a', headings });
  assert.deepEqual(Array.from(html.matchAll(/<h\d id="([^"]+)"/g), (m) => m[1]), [
    'part-a--methods', 'part-a--methods-2', 'part-a--methods-2-2'
  ]);
  assert.deepEqual(Array.from(headings, (h) => h.id), [
    'part-a--methods', 'part-a--methods-2', 'part-a--methods-2-2'
  ]);
});

test('prefix and heading content are escaped in attributes and markup', () => {
  const html = render('# <script>& "quoted"', { headingPrefix: 'x" onmouseover="run&' });
  assert.match(html, /id="x&quot; onmouseover=&quot;run&amp;--script-quoted"/);
  assert.match(html, /&lt;script&gt;&amp; &quot;quoted&quot;/);
  assert.doesNotMatch(html, /<script>|id="x"/);
});

test('non-ASCII-only headings use the heading fallback', () => {
  const html = render('# 東京', { headingPrefix: 'guide' });
  assert.match(html, /<h3 id="guide--heading">東京<\/h3>/);
});

test('headings inside nested blockquotes remain in the active scope', () => {
  const headings = [];
  const html = render('> # Quoted\n> > ## Nested\n# Outside', { headingPrefix: 'part', headings });
  assert.deepEqual(Array.from(html.matchAll(/<h\d id="([^"]+)"/g), (m) => m[1]), [
    'part--quoted', 'part--nested', 'part--outside'
  ]);
  assert.deepEqual(Array.from(headings, (h) => h.id), [
    'part--quoted', 'part--nested', 'part--outside'
  ]);
  assert.match(html, /<blockquote><h3 id="part--quoted">Quoted<\/h3><blockquote><h4 id="part--nested">Nested<\/h4><\/blockquote><\/blockquote>/);
});

test('scoped phase headings retain legacy timeline anchors as aliases', () => {
  const html = render('# Deadline · 1w\n# Results · after', { headingPrefix: 'guide', headings: [] });
  assert.match(html, /<a href="#phase-deadline">/);
  assert.match(html, /<h3 class="md-phase" id="guide--deadline"><span id="phase-deadline" class="gd-heading-alias" aria-hidden="true"><\/span>/);
  assert.match(html, /<h3 class="md-phase" id="guide--results"><span id="phase-results" class="gd-heading-alias" aria-hidden="true"><\/span>/);
});

test('rendering without options preserves legacy output and phase IDs', () => {
  assert.equal(render('# Plain'), '<h3>Plain</h3>');
  const html = render('# Deadline · 1w\n# Results · after');
  assert.match(html, /<h3 class="md-phase" id="phase-deadline">/);
  assert.match(html, /<h3 class="md-phase" id="phase-results">/);
  assert.doesNotMatch(html, /gd-heading-alias|id="[^\"]+--/);
});


test('identical heading names in different parts have distinct anchors', () => {
  assert.match(render('#### Results', { headingPrefix: 'p-one' }), /id="p-one--results"/);
  assert.match(render('#### Results', { headingPrefix: 'p-two' }), /id="p-two--results"/);
});
