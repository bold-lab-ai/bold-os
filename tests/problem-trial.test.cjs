// Comparing the two ways of adding a problem (functions/problem-trial.js): who gets which, and what's kept.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const T = require('../functions/problem-trial');

test('each person gets one way, always the same, about half each', () => {
  assert.equal(T.variantFor('A@example.com'), T.variantFor('a@example.com'));
  const n = Array.from({length: 400}, (_, i) => T.variantFor('p' + i + '@example.com')).filter((v) => v === 'chat').length;
  assert.ok(n > 160 && n < 240, 'split ' + n + '/400');
});

test('changed fields: what differs between BOLD’s draft and what was saved', () => {
  const bold = {title: 'A', significance: 'S', difficulties: 'D', existing_solutions: 'E', builds_benchmark: false, collaborators: '', project_ids: ['x', 'y'], parent_ids: [], related_ids: []};
  assert.equal(T.changedFields(bold, {...bold, project_ids: ['y', 'x'], title: ' A '}), 0);
  assert.equal(T.changedFields(bold, {...bold, title: 'B', builds_benchmark: true}), 2);
  assert.equal(T.changedFields(null, bold), null);
});

function fakeDb(){
  const data = new Map();
  const ref = (p) => ({path: p});
  return {data, collection: (c) => ({doc: (id) => ref(c + '/' + id), get: async () => ({docs: [...data].map(([k, v]) => ({id: k.split('/')[1], data: () => v}))})}),
    runTransaction: async (fn) => fn({get: async (r) => ({exists: data.has(r.path), data: () => data.get(r.path)}), set: (r, v) => data.set(r.path, JSON.parse(JSON.stringify(v)))})};
}
test('an attempt keeps only signals, and only its owner adds to it', async () => {
  const db = fakeDb(), t = T({db}), id = '11111111-2222-3333-4444-555555555555', me = 'me@example.com';
  const {variant} = await t.record(me, {attempt: id, event: 'start'});
  assert.equal(variant, T.variantFor(me));
  await t.record(me, {attempt: id, event: 'turn'});
  await t.record(me, {attempt: id, event: 'sofya_error'});
  const other = variant === 'chat' ? 'form' : 'chat';
  assert.equal((await t.record(me, {attempt: id, event: 'switch', to: other, reason: 'sofya'})).way, other);
  await t.record(me, {attempt: id, event: 'saved', problem_id: 'ak-1', bold: {title: 'A'}, saved: {title: 'B'}, text: 'never kept'});
  const row = db.data.get('problemTrials/' + id);
  assert.equal(row.turns, 1); assert.equal(row.sofyaErrors, 1); assert.equal(row.switches[0].reason, 'sofya');
  assert.equal(row.problemId, 'ak-1'); assert.equal(row.changedFields, 1);
  assert.equal(JSON.stringify(row).includes('never kept'), false);
  assert.equal(JSON.stringify(row).includes('"B"'), false, 'what they wrote isn’t kept');
  await assert.rejects(t.record('other@example.com', {attempt: id, event: 'turn'}), /isn’t yours/);
  await assert.rejects(t.record(me, {attempt: 'nope', event: 'turn'}), /attempt id/);
  await assert.rejects(t.record(me, {attempt: id, event: 'switch', to: 'phone'}), /chat or form/);
  assert.equal((await t.list()).length, 1);
});
