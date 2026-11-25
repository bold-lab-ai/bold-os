const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('../functions/guide-anchors.js');
const part = (id, title, body = '', section = 'Research') => ({ id, title, body, section });
const active = r => r.entries.filter(e => e.active);
const copy = x => JSON.parse(JSON.stringify(x));

test('readable fragments come from plain heading text and retain Unicode', () => {
  assert.equal(A.slug('Research Project Lifecycle'), 'research-project-lifecycle');
  assert.equal(A.slug("This’ll be **helpful** about Θ!"), 'thisll-be-helpful-about-θ');
  assert.equal(A.slug('[Getting started](https://example.org)'), 'getting-started');
  assert.equal(A.slug('東京'), '東京');
  assert.equal(A.slug('!!!'), 'heading');
});

test('part titles and nested headings share a duplicate-safe namespace per section', () => {
  const r = A.current([part('afchbwgz', 'Methods', '# Methods\n## Methods\n# Methods-1'), part('b', 'Methods', '', 'People')]);
  assert.deepEqual(active(r).map(e => e.slug), ['methods', 'methods-1', 'methods-2', 'methods-1-1', 'methods']);
  assert.equal(A.resolve(r, 'methods', 'research').partId, 'afchbwgz');
  assert.equal(A.resolve(r, 'methods', 'people').partId, 'b');
  assert.equal(A.resolve(r, 'methods', null), null, 'ambiguous hash-only URLs cannot pick arbitrarily');
});

test('outline excludes code and maths, includes quoted headings, and strips phase timing', () => {
  assert.deepEqual(A.headings('```md\n# Not a heading\n```\n$$\n# Neither\n$$\n> # Quoted\n> > ## Nested\n# Draft · 2w\n# Submit · 1d').map(h => h.text), ['Quoted', 'Nested', 'Draft', 'Submit']);
});

test('accepted title and nested heading renames preserve prior readable and opaque aliases', () => {
  const before = [part('opaque', 'Old Part', '# Original\nText')];
  const initial = A.current(before);
  const after = [part('opaque', 'New Part', '# Renamed\nText')];
  const r = A.update(before, after, copy(initial));
  assert.equal(A.resolve(r, 'old-part', 'research').slug, 'new-part');
  assert.equal(A.resolve(r, 'original', 'research').slug, 'renamed');
  assert.equal(A.resolveLegacy(r, 'opaque').slug, 'new-part');
  assert.equal(A.resolveLegacy(r, 'opaque--original').currentLegacy, 'opaque--renamed');
  assert.deepEqual(initial, A.current(before), 'previous registry must not be mutated');
  const loaded = A.current(after, copy(r));
  assert.equal(A.resolve(loaded, 'original', 'research').slug, 'renamed', 'aliases survive a reload');
});

test('the first accepted rename bootstraps aliases from an existing unregistered page', () => {
  const r = A.update([part('p', 'Before', '# First')], [part('p', 'After', '# Second')]);
  assert.equal(A.resolve(r, 'before', 'research').slug, 'after');
  assert.equal(A.resolve(r, 'first', 'research').slug, 'second');
});

test('duplicate insertion or part reordering never reassigns an already claimed readable URL', () => {
  const before = [part('a', 'Same'), part('b', 'Same')], saved = A.current(before);
  const after = [part('new', 'Same'), before[1], before[0]];
  const r = A.update(before, after, saved);
  assert.equal(A.resolve(r, 'same', 'research').partId, 'a');
  assert.equal(A.resolve(r, 'same-1', 'research').partId, 'b');
  assert.equal(A.resolve(r, 'same-2', 'research').partId, 'new');
});

test('inserting and reordering unchanged nested headings retains their identity', () => {
  const before = [part('p', 'Part', '# Alpha\n# Beta')], saved = A.current(before);
  const key = A.resolve(saved, 'alpha', 'research').key;
  const r = A.update(before, [part('p', 'Part', '# New\n# Beta\n# Alpha')], saved);
  assert.equal(A.resolve(r, 'alpha', 'research').key, key);
  assert.equal(A.resolve(r, 'alpha', 'research').index, 2);
});

test('deleted headings reserve their old URLs and restoring them reactivates aliases', () => {
  const before = [part('a', 'Part', '# Gone'), part('b', 'Other')], saved = A.current(before);
  const removed = [part('a', 'Part'), part('b', 'Gone')];
  const r = A.update(before, removed, saved);
  assert.equal(A.resolve(r, 'gone', 'research'), null);
  assert.equal(A.resolve(r, 'gone-1', 'research').partId, 'b');
  const restored = A.update(removed, before, r);
  assert.equal(A.resolve(restored, 'gone', 'research').partId, 'a');
});

test('moving a part to another section preserves old section and slug combinations', () => {
  const before = [part('a', 'Heading')], after = [part('a', 'Renamed', '', 'People')];
  const r = A.update(before, after, A.current(before));
  assert.equal(A.resolve(r, 'heading', 'research').section, 'people');
  assert.equal(A.resolve(r, 'renamed', 'people').partId, 'a');
});

test('readable fragments never collide with existing opaque part IDs', () => {
  const r = A.current([part('opaque', 'Original'), part('b', 'opaque')]);
  assert.equal(A.resolve(r, 'opaque-1', 'research').partId, 'b');
});

test('server acceptance and browser preview persist the same aliases across batch renames', () => {
  const server = require('../functions/index.js')._internal.appliedProposal;
  const ctx = { window: { BoldGuideAnchors: A }, BoldMerge: require('../functions/merge.js') };
  vm.runInNewContext(fs.readFileSync('src/assets/js/proposal-model.js', 'utf8'), ctx);
  const d = { title: 'Guide', parts: [part('p', 'Part', '# Alpha')] };
  const q = { kind: 'batch', changes: [
    { kind: 'edit', partId: 'p', before: { body: '# Alpha' }, after: { body: '# Beta' } },
    { kind: 'edit', partId: 'p', before: { body: '# Beta' }, after: { body: '# Gamma' } },
  ] };
  const accepted = server(d, q), preview = ctx.window.BoldProposals.applied(d, q);
  assert.deepEqual(copy(preview), copy(accepted));
  const registry = copy(accepted.headingAnchors);
  for (const slug of ['alpha', 'beta', 'gamma']) assert.equal(A.resolve(registry, slug, 'research').slug, 'gamma');
});

test('old conference-phase fragments follow renamed headings too', () => {
  const before = [part('p', 'Cycle', '# Draft · 2w\n# Submit · 1d')];
  const after = [part('p', 'Cycle', '# Prepare · 2w\n# Submit · 1d')];
  const r = A.update(before, after, A.current(before));
  assert.equal(A.resolveLegacy(r, 'phase-draft').slug, 'prepare');
  assert.equal(A.resolveLegacy(r, 'phase-submit').slug, 'submit');
});

test('a single rename combined with reordering retains its aliases', () => {
  const before = [part('p', 'Part', '# Alpha\n# Beta\n# Gamma')];
  const after = [part('p', 'Part', '# Gamma\n# Changed\n# Beta')];
  const r = A.update(before, after, A.current(before));
  assert.equal(A.resolve(r, 'alpha', 'research').slug, 'changed');
  assert.equal(A.resolve(r, 'alpha', 'research').index, 1);
});
