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
    { id: 'one', title: 'First Part', section: 'First', body: '# Details' },
    { id: 'two', title: 'Second Part', section: 'Second', body: '# Details\n# Details' },
  ];
  const body = { addEventListener: (name, fn) => handlers.push(fn) };
  const ctx = {
    window: { addEventListener() {} }, BoldGuideCopy: { html(hash, title, section) { return { hash, title, section }; }, mount() {} }, BOLD: { escapeHtml: s => String(s), TAG: /$^/, IMAGE: /$^/ },
    document: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, remove() {}, set textContent(v) { messages.push(v); } }),
      body: { appendChild() {} }, getElementById: id => nodes.get(id),
    },
    PREFIX: 'p-', parts: () => data, part: id => data.find(p => p.id === id), doc: () => ({ parts: data }), BoldGuideAnchors: require('../functions/guide-anchors.js'), visible: () => true,
    body, esc: s => String(s), navigator: { clipboard }, URL, URLSearchParams,
    location: new URL('http://localhost:8137/guide.html?guide=test'),
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
    between('  function goTo(hash)', '  // What you type while') +
    between('  function navigateFromUrl(){', '  BOLD.onUser'), ctx);
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


test('identical headings retain their parent identity and open the owning tab', () => {
  const { ctx } = harness();
  assert.equal(ctx.tabFor('#p-one--details'), 'First');
  assert.equal(ctx.tabFor('#p-two--details'), 'Second');
});

test('copy labels name the section, part and nested heading without duplicating names', () => {
  const { ctx } = harness();
  assert.equal(ctx.copyPath({ section: 'People', title: 'Who is BOLD' }, 'BOLD-staff'), 'People › Who is BOLD › BOLD-staff');
  assert.equal(ctx.copyPath({ section: 'People', title: 'Who is BOLD' }), 'People › Who is BOLD');
  assert.equal(ctx.copyPath({ section: 'People', title: 'Who is BOLD' }, 'Who is BOLD'), 'People › Who is BOLD');
});


test('section query without a fragment selects the requested section on cold load', () => {
  const { ctx } = harness();
  ctx.location.search = '?guide=test&section=second';
  ctx.refresh();
  assert.equal(ctx.tab, 'Second');
});

test('explicit section and scoped heading select the tab, expand the parent and scroll', () => {
  const { ctx, scrolled } = harness();
  ctx.location.search = '?guide=test&section=second';
  ctx.location.hash = '#p-two--details-2';
  ctx.refresh();
  assert.equal(ctx.tab, 'Second');
  assert.equal(ctx.folded.two, false);
  assert.deepEqual(scrolled, ['p-two--details-2']);
});

test('tab links preserve other query parameters and replace the old fragment', () => {
  const { ctx } = harness();
  ctx.location.search = '?guide=test&branch=example&section=first';
  ctx.location.hash = '#p-one--details';
  const href = ctx.sectionHref('Second');
  assert.equal(href, '/guide.html?guide=test&branch=example&section=second');
  assert.equal(ctx.tabFromUrl(href), 'Second');
});

test('history navigation restores query-only tabs and the default section', () => {
  const { ctx } = harness();
  ctx.location.search = '?guide=test&section=second';
  ctx.navigateFromUrl(); assert.equal(ctx.tab, 'Second');
  ctx.location.search = '?guide=test&section=first';
  ctx.navigateFromUrl(); assert.equal(ctx.tab, 'First');
  ctx.location.search = '?guide=test&section=second';
  ctx.navigateFromUrl(); assert.equal(ctx.tab, 'Second');
  ctx.location.search = '?guide=test';
  ctx.navigateFromUrl(); assert.equal(ctx.tab, 'First');
});

test('unknown sections fall back safely and old heading links override a stale query', () => {
  const { ctx } = harness();
  ctx.location.search = '?guide=test&section=missing';
  assert.equal(ctx.tabFromUrl(), null);
  ctx.location.search = '?guide=test&section=first';
  ctx.location.hash = '#p-two--details';
  assert.equal(ctx.tabFromUrl(), 'Second');
});


test('rendered copy controls receive the owning section slug', () => {
  const { ctx } = harness();
  ctx.hasSections = () => true;
  assert.equal(ctx.linkHtml('p-two--details', 'Details', { section: 'Second' }).section, 'second');
  ctx.hasSections = () => false;
  assert.equal(ctx.linkHtml('p-two--details', 'Details', { section: 'Second' }).section, null);
});

test('copy controls now expose text-derived slugs instead of opaque IDs', () => {
  const { ctx } = harness();
  ctx.hasSections = () => true;
  const control = ctx.linkHtml('p-two--details', 'Details', { id: 'two', section: 'Second' }, 0);
  assert.equal(control.hash, 'details');
  assert.equal(control.section, 'second');
});

test('readable URLs locate a nested heading and unfold its parent on reload', () => {
  const { ctx, scrolled } = harness();
  ctx.location.search = '?guide=test&section=second'; ctx.location.hash = '#details-1';
  ctx.refresh();
  assert.equal(ctx.tab, 'Second'); assert.equal(ctx.folded.two, false);
  assert.deepEqual(scrolled, ['p-two--details-2']);
});


test('top-level part URLs are readable and opaque bookmarks still expand that part', () => {
  const { ctx, scrolled } = harness();
  ctx.hasSections = () => true;
  assert.equal(ctx.linkHtml('p-two', 'Second Part', { id: 'two', section: 'Second' }).hash, 'second-part');
  ctx.location.search = '?guide=test&section=second'; ctx.location.hash = '#second-part';
  ctx.refresh();
  assert.equal(ctx.folded.two, false); assert.deepEqual(scrolled, ['p-two']);
});
