// Exercise the page's actual link handlers with synthetic guide data, without Firebase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/assets/js/pages/guide.js', 'utf8');
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source boundaries: ${start} … ${end}`);
  return source.slice(from, to);
}
function harness() {
  const nodes = new Map(), scrolled = [];
  const data = [
    { id: 'one', title: 'First Part', section: 'First', body: '# Details' },
    { id: 'two', title: 'Second Part', section: 'Second', body: '# Details\n# Details' },
  ];
  const ctx = {
    window: { addEventListener() {} }, BoldGuideCopy: { html(hash, title, section) { return { hash, title, section }; }, mount() {} }, BOLD: { escapeHtml: s => String(s), TAG: /$^/, IMAGE: /$^/ },
    document: { addEventListener() {},
      getElementById: id => nodes.get(id),
    },
    PREFIX: 'p-', parts: () => data, hasSections: () => true, part: id => data.find(p => p.id === id), doc: () => ({ parts: data }), BoldGuideAnchors: require('../functions/guide-anchors.js'), visible: () => true,
    body: {}, esc: s => String(s), URL, URLSearchParams,
    location: new URL('http://localhost:8137/guide.html?guide=test'),
    folded: { two: true }, saveFolded() {}, tab: 'First', jumped: false,
    x: {}, proposalsLoaded: true, form: null, comments: null, commentFor: () => '',
    sections: () => ['First', 'Second'], G: { slugify: s => s.toLowerCase() },
  };
  const replacements = [], pushes = [];
  ctx.history = { state: { retained: true }, pushState(state, _, href) { pushes.push(href); ctx.location.href = new URL(href, ctx.location.href).href; }, replaceState(state, _, href) { replacements.push({ state, href }); ctx.location.href = new URL(href, ctx.location.href).href; } };
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
    between('  function tabFor(', '  function tabsHtml()') +
    between('  function refresh(){', '  // Shows what #hash') +
    between('  function goTo(hash)', '  // What you type while') +
    between('  function navigateFromUrl(){', '  BOLD.onUser') +
    between('  function sameGuideUrl(href){', '  // Old sidebar fragments'), ctx);
  return { ctx, scrolled, replacements, pushes };
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


test('legacy hash-only section selection normalizes to query without a heading fragment', () => {
  const { ctx, replacements } = harness();
  ctx.location.search = '?guide=test&branch=example'; ctx.location.hash = '#second';
  ctx.refresh();
  assert.equal(ctx.tab, 'Second');
  assert.equal(ctx.location.href, 'http://localhost:8137/guide.html?guide=test&branch=example&section=second');
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].state.retained, true);
});

test('legacy opaque heading bookmarks normalize section and fragment together', () => {
  const { ctx, scrolled } = harness();
  ctx.location.hash = '#p-two'; ctx.refresh();
  assert.equal(ctx.location.search, '?guide=test&section=second');
  assert.equal(ctx.location.hash, '#second-part');
  assert.deepEqual(scrolled, ['p-two']);
});

test('in-page heading navigation fixes a stale section selector without adding history', () => {
  const { ctx, replacements, scrolled } = harness();
  ctx.location.search = '?guide=test&section=first'; ctx.location.hash = '#p-two--details';
  ctx.navigateFromUrl();
  assert.equal(ctx.location.href, 'http://localhost:8137/guide.html?guide=test&section=second#details');
  assert.equal(ctx.tab, 'Second'); assert.deepEqual(scrolled, ['p-two--details']);
  assert.equal(replacements.length, 1);
});

test('canonical section and heading URLs are idempotent and the bare page stays bare', () => {
  const { ctx, replacements } = harness();
  ctx.location.search = '?guide=test&section=second'; ctx.location.hash = '#details';
  ctx.navigateFromUrl(); ctx.navigateFromUrl();
  assert.equal(replacements.length, 0);
  ctx.location.href = 'http://localhost:8137/guide.html?guide=test'; ctx.navigateFromUrl();
  assert.equal(ctx.location.search, '?guide=test'); assert.equal(ctx.location.hash, '');
});


test('TL;DR legacy section fragments normalize to ?section=tl-dr', () => {
  const { ctx } = harness();
  ctx.parts()[0].section = 'TL;DR'; ctx.sections = () => ['TL;DR', 'Second'];
  ctx.G.slugify = ctx.BoldGuideAnchors.sectionSlug;
  ctx.location.hash = '#tl-dr'; ctx.refresh();
  assert.equal(ctx.location.search, '?guide=test&section=tl-dr');
  assert.equal(ctx.location.hash, ''); assert.equal(ctx.tab, 'TL;DR');
});

test('section-only URLs follow an unambiguous accepted tab rename and normalize its name', () => {
  const { ctx } = harness(), A = ctx.BoldGuideAnchors;
  const before = JSON.parse(JSON.stringify(ctx.parts())), saved = A.current(before);
  const data = ctx.parts(); data[1].section = 'Renamed';
  const headingAnchors = A.update(before, data, saved);
  ctx.doc = () => ({ parts: data, headingAnchors }); ctx.sections = () => ['First', 'Renamed'];
  ctx.location.search = '?guide=test&section=second'; ctx.refresh();
  assert.equal(ctx.tab, 'Renamed'); assert.equal(ctx.location.search, '?guide=test&section=renamed');
  assert.equal(ctx.location.hash, '');
});


function follow(h, href, options = {}) {
  let prevented = false;
  const a = { href: new URL(href, h.ctx.location.href).href, target: options.target || '',
    hasAttribute: name => name === 'download' && !!options.download,
    classList: { contains: name => name === 'guide-tab' && !!options.tab },
  };
  h.ctx.BOLD.switchTab = (_, __, show) => show();
  const { target, ...eventOptions } = options;
  h.ctx.followGuideLink({ button: 0, target: { closest: () => a }, preventDefault() { prevented = true; }, ...eventOptions });
  return prevented;
}

test('same-guide sidebar and content links switch sections in place, without a document navigation', () => {
  const h = harness();
  assert.equal(follow(h, '?guide=test&section=second'), true);
  assert.equal(h.ctx.tab, 'Second'); assert.equal(h.pushes.length, 1);
  assert.equal(h.ctx.location.search, '?guide=test&section=second');
  assert.equal(follow(h, '?guide=test&section=first'), true);
  assert.equal(h.ctx.tab, 'First'); assert.equal(h.pushes.length, 2);
});

test('clicking the current section again does not create a duplicate history entry', () => {
  const h = harness();
  h.ctx.location.search = '?guide=test&section=second'; h.ctx.tab = 'Second';
  assert.equal(follow(h, '?guide=test&section=second'), true);
  assert.equal(h.pushes.length, 0); assert.equal(h.ctx.tab, 'Second');
});

test('tab-bar links retain in-place switching and heading links still unfold and scroll', () => {
  const h = harness();
  assert.equal(follow(h, '?guide=test&section=second', { tab: true }), true);
  assert.equal(h.ctx.tab, 'Second');
  assert.equal(follow(h, '?guide=test&section=second#details-1'), true);
  assert.equal(h.ctx.folded.two, false); assert.deepEqual(h.scrolled, ['p-two--details-2']);
});

test('a duplicate heading link resolves in its destination section, not the current section', () => {
  const h = harness();
  h.ctx.location.search = '?guide=test&section=first';
  assert.equal(follow(h, '?guide=test&section=second#details'), true);
  assert.equal(h.ctx.tab, 'Second');
  assert.equal(h.ctx.location.search, '?guide=test&section=second');
  assert.equal(h.ctx.folded.two, false);
  assert.deepEqual(h.scrolled, ['p-two--details']);
});

test('different documents, guide identities and branch contexts use normal browser navigation', () => {
  const h = harness();
  for (const href of ['/other.html?section=second', '?guide=another&section=second', '?guide=test&branch=other&section=second', 'https://example.org/guide.html?guide=test']) {
    assert.equal(follow(h, href), false);
  }
  assert.equal(h.pushes.length, 0);
});

test('modified clicks, downloads, other targets and handled events retain browser behavior', () => {
  const h = harness(), href = '?guide=test&section=second';
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { target: '_blank' }, { download: true }, { defaultPrevented: true }]) {
    assert.equal(follow(h, href, options), false);
  }
});
