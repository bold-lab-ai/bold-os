// Maths in Markdown (src/assets/js/markdown.js, 2026-11-07): $…$ inline, $$…$$ displayed, set aside as TeX for KaTeX.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = { window: {}, BOLD: { escapeHtml: esc, TAG: /@\[([^\]]+)\]\((U[A-Z0-9]+)\)/g, IMAGE: /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g, imageHtml: () => '<img>', SLACK_TEAM: 'T' } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/markdown.js'), 'utf8'), ctx);
const md = (t) => ctx.window.BoldMarkdown.render(t);
const texOf = (h) => Array.from(h.matchAll(/data-tex="([^"]*)"/g), (m) => m[1]);

test('inline maths is set aside as TeX, untouched by Markdown', () => {
  const h = md('The loss is $L = \\sum_i x_i^2$ and *this* is italic.');
  assert.deepStrictEqual(texOf(h), ['L = \\sum_i x_i^2']);
  assert.match(h, /<em>this<\/em>/);
  assert.doesNotMatch(h, /<em>i x/);
});
test('a displayed formula, on a line of its own or across lines', () => {
  assert.match(md('$$E = mc^2$$'), /md-math-block.*is-display.*data-tex="E = mc\^2"/);
  const h = md('Before\n$$\n\\frac{a}{b}\n$$\nAfter');
  assert.deepStrictEqual(texOf(h), ['\\frac{a}{b}']);
  assert.match(h, /<p>Before<\/p>/); assert.match(h, /<p>After<\/p>/);
});
test('money and escaped dollars stay text', () => {
  assert.deepStrictEqual(texOf(md('It costs $5 and $10 a month.')), []);
  assert.deepStrictEqual(texOf(md('A plain \\$ sign, and $x$.')), ['x']);
  assert.match(md('A plain \\$ sign'), /A plain \$ sign/);
});
test('maths in code stays code; TeX with < and & is escaped in the page', () => {
  assert.deepStrictEqual(texOf(md('`$x$` is code')), []);
  const h = md('$a < b \\& c$');
  assert.deepStrictEqual(texOf(h), ['a &lt; b \\&amp; c']);
  assert.doesNotMatch(h, /<b /);
});
