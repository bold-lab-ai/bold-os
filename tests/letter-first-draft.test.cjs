// Recommendation letters' first draft (functions/index.js "Service desk"): who may draft
// it, and what a draft must have.
const test = require('node:test');
const assert = require('node:assert');
const { letterDrafterOf, normalizeLetterDraft, normalizeLetterRequest } = require('../functions/index.js')._internal;

const writers = [{ email: 'phd@x', name: 'Pat PhD' }, { email: 'ref@x', name: 'Rae Referee' }, { email: 'msc@x', name: 'Max MSc' }];

test('a first drafter is optional, and anyone else who has signed in to BOLD.OS', () => {
  assert.deepStrictEqual(letterDrafterOf('', writers, 'msc@x', 'ref@x'), { drafter: null });
  assert.deepStrictEqual(letterDrafterOf(undefined, writers, 'msc@x', 'ref@x'), { drafter: null });
  assert.deepStrictEqual(letterDrafterOf(' PhD@X ', writers, 'msc@x', 'ref@x'), { drafter: { email: 'phd@x', name: 'Pat PhD' } }, 'emails are lower-cased');
});

test('the applicant, the referee or someone not on BOLD.OS can’t be the first drafter', () => {
  assert.ok(letterDrafterOf('msc@x', writers, 'msc@x', 'ref@x').error);
  assert.ok(letterDrafterOf('ref@x', writers, 'msc@x', 'ref@x').error);
  assert.ok(letterDrafterOf('nobody@x', writers, 'msc@x', 'ref@x').error);
});

test('a draft is its text, a link to it, or both, with an optional note', () => {
  assert.deepStrictEqual(normalizeLetterDraft({ text: '  Dear committee…  ' }), { draft: { text: 'Dear committee…', url: '', note: '' } });
  assert.deepStrictEqual(normalizeLetterDraft({ url: 'https://docs.google.com/d/1', note: 'Rough' }), { draft: { text: '', url: 'https://docs.google.com/d/1', note: 'Rough' } });
  assert.ok(normalizeLetterDraft({}).error, 'neither text nor link');
  assert.ok(normalizeLetterDraft({ note: 'only a note' }).error);
  assert.ok(normalizeLetterDraft({ url: 'docs.google.com/d/1' }).error, 'a link starts with https://');
  assert.ok(normalizeLetterDraft({ text: 'x'.repeat(20001) }).error, 'too long');
  assert.ok(normalizeLetterDraft(null).error);
});

test('the requester’s fields never carry the drafter or the draft (those are set apart)', () => {
  const n = normalizeLetterRequest({ purpose: 'PhD applications', cv: 'https://cv', howWorked: 'MSc project', recipients: [{ name: 'MIT' }],
    drafterEmail: 'phd@x', draftAt: 1, text: 'sneaky' }, []);
  assert.ok(n.request);
  ['drafterEmail', 'drafterName', 'draftAt', 'text'].forEach((k) => assert.ok(!(k in n.request), k));
});

test('Connections: the applicant and their first drafter are linked, as the applicant and referee are', async () => {
  const { interactionsFor } = require('../functions/index.js')._internal;
  const none = async () => null;
  const pair = (x) => [x.from, x.to].sort().join(' ');
  const out = await interactionsFor('letterRequests/L1', { requesterEmail: 'msc@x', writerEmail: 'ref@x', drafterEmail: 'phd@x', at: 1 }, none);
  assert.deepStrictEqual(out.map(pair).sort(), ['msc@x phd@x', 'msc@x ref@x']);
  const old = await interactionsFor('letterRequests/L0', { requesterEmail: 'msc@x', writerEmail: 'ref@x', at: 1 }, none);
  assert.deepStrictEqual(old.map(pair), ['msc@x ref@x'], 'no drafter: as before');
});

test('a first draft never tells anyone it tags (it’s for the referee only)', () => {
  const { tagPlace } = require('../functions/index.js')._internal;
  assert.strictEqual(tagPlace('letterDrafts/L1', { text: 'Thanks to [@Pat](U123)' }), null);
  assert.strictEqual(tagPlace('letterRequests/L1', {}), null);
});
