// Exercise the page's actual link handlers with synthetic guide data, without Firebase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/assets/js/pages/guide.js', 'utf8');
function between(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function harness(clipboard) {
  const nodes = new Map(), handlers = [], messages = [], scrolled = [], statuses = [], timers = [];
  const data = [
    { id: 'one', section: 'First', body: '# Overview' },
    { id: 'two', section: 'Second', body: '# Details\n# Details' },
  ];
  const body = { addEventListener: (name, fn) => handlers.push(fn) };
  const ctx = {
    window: {}, BoldGuideCopy: { html() {}, mount() {} }, BOLD: { escapeHtml: s => String(s), TAG: /$^/, IMAGE: /$^/ },
    document: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, remove() {}, set textContent(v) { messages.push(v); } }),
      body: { appendChild() {} }, getElementById: id => nodes.get(id),
    },
    PREFIX: 'p-', parts: () => data, visible: () => true,
    body, esc: s => String(s), navigator: { clipboard }, URL,
    location: { href: 'http://localhost:8137/guide.html?guide=test#old', hash: '' },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: id => { if (id) timers[id - 1] = null; },
    folded: { two: true }, saveFolded() {}, tab: 'First', jumped: false,
    x: {}, proposalsLoaded: true, form: null, comments: null, commentFor: () => '',
    sections: () => ['First', 'Second'], G: { slugify: s => s.toLowerCase() },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('src/assets/js/markdown.js', 'utf8'), ctx);
  ctx.md = ctx.window.BoldMarkdown.render;
  ctx.render = () => {
    nodes.clear();
    for (const p of data.filter(p => p.section === ctx.tab && !ctx.folded[p.id])) {
      const heads = [];
      ctx.md(p.body, { headingPrefix: 'p-' + p.id, headings: heads });
      for (const id of ['p-' + p.id, ...heads.map(h => h.id)]) nodes.set(id, { scrollIntoView: () => scrolled.push(id) });
    }
  };
  vm.runInContext(between('  function anchor(p)', '  function hasSections()') +
    between('  function tabFor(hash)', '  function tabsHtml()') +
    between('  function refresh(){', '  // Shows what #hash') +
    between('  function goTo(hash)', '  // What you type while'), ctx);
  return { ctx, handlers, messages, scrolled, statuses, timers };
}
test('cold load selects the owning tab, unfolds its section and scrolls to the exact duplicate heading', () => {
  const h = harness();
  h.ctx.location.hash = '#p-two--details-2';
  h.ctx.refresh();
  assert.equal(h.ctx.tab, 'Second');
  assert.equal(h.ctx.folded.two, false);
  assert.deepEqual(h.scrolled, ['p-two--details-2']);
});
test('malformed and unknown fragments do not throw or select a section', () => {
  const { ctx } = harness();
  assert.equal(ctx.tabFor('#%ZZ'), null);
  assert.equal(ctx.tabFor('#missing'), null);
  assert.doesNotThrow(() => ctx.goTo('#%ZZ'));
});
