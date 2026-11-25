// Adding a problem with BOLD-LLM (functions/problem-interview.js): the conversation it's sent, the draft it may
// return, and one turn against a stand-in Sofya.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const I = require('../functions/problem-interview');
const {said, jsonOf} = require('../functions/sofya');

const lab = {
  objectives: [{id: 'ns-hcld', title: 'Human-Centric', kind: 'northstar'}, {id: 'ms-co', title: 'Co-scientist', kind: 'moonshot'}],
  problems: [{id: 'ak-' + 'a'.repeat(24), title: 'Old problem'}],
  projects: [{id: 'diverging-runs', title: 'Diverging runs'}]
};

test('the conversation must end with the person, within limits', () => {
  assert.throws(() => I.turnsOf([]), /Start again/);
  assert.throws(() => I.turnsOf([{role: 'assistant', content: 'Hi'}]), /Say something/);
  assert.throws(() => I.turnsOf([{role: 'system', content: 'x'}]), /Keep each/);
  assert.throws(() => I.turnsOf([{role: 'user', content: 'x'.repeat(4001)}]), /Keep each/);
  assert.throws(() => I.turnsOf(Array.from({length: 41}, () => ({role: 'user', content: 'x'}))), /Start again/);
  assert.deepEqual(I.turnsOf([{role: 'assistant', content: 'Describe it'}, {role: 'user', content: ' Hard thing '}]),
    [{role: 'assistant', content: 'Describe it'}, {role: 'user', content: 'Hard thing'}]);
});

test('the draft keeps only known fields and ids it was given', () => {
  const known = {projects: new Set(['diverging-runs']), problems: new Set(['ak-' + 'a'.repeat(24)]), parents: new Set(['ms-co', 'ak-' + 'a'.repeat(24)])};
  const d = I.cleanDraft({title: ' T '.padEnd(400, 'x'), significance: 'S', builds_benchmark: 'yes', extra: 'no',
    project_ids: ['diverging-runs', 'made-up'], parent_ids: ['ms-co', 'invented'], related_ids: ['ak-' + 'a'.repeat(24), 'ms-co']}, known);
  assert.equal(d.title.length, 180);
  assert.equal(d.builds_benchmark, false);
  assert.equal(d.extra, undefined);
  assert.equal(d.difficulties, '');
  assert.deepEqual(d.project_ids, ['diverging-runs']);
  assert.deepEqual(d.parent_ids, ['ms-co']);
  assert.deepEqual(d.related_ids, ['ak-' + 'a'.repeat(24)]);
});

test('the prompt names what it can link to', () => {
  const p = I.systemPrompt(lab);
  for (const s of ['XY problem', 'A problem is not a method', 'ns-hcld: Human-Centric (northstar)', 'ms-co: Co-scientist (moonshot)', 'Diverging runs', 'existing_solutions', 'builds_benchmark']) assert.ok(p.includes(s), s);
});

test('one turn, thinking off, with the current draft; ready only once the required fields are there', async () => {
  let sent;
  const reply = (v) => async (body) => { sent = body; return {message: {content: '<think>x</think>' + JSON.stringify(v)}}; };
  const turns = [{role: 'assistant', content: 'Describe it'}, {role: 'user', content: 'Runs diverge'}];
  const half = await I.interview(turns, lab, reply({reply: 'Why does it matter?', ready: true, draft: {title: 'Divergence'}}), said, jsonOf, {title: 'Mine'});
  assert.equal(sent.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(sent.response_format, {type: 'json_object'});
  assert.match(sent.messages[0].content, /"title":"Mine"/);
  assert.equal(half.reply, 'Why does it matter?');
  assert.equal(half.ready, false);
  const full = await I.interview(turns, lab, reply({reply: 'Check the draft.', ready: true,
    draft: {title: 'T', significance: 'S', difficulties: 'D', existing_solutions: 'E', builds_benchmark: false, benchmark_known: true, collaborators: '', project_ids: [], parent_ids: ['ms-co'], related_ids: []}}), said, jsonOf);
  assert.equal(full.ready, true);
  const unsaid = await I.interview(turns, lab, reply({reply: 'Drafted below.', ready: false,
    draft: {title: 'T', significance: 'S', difficulties: 'D', existing_solutions: 'E', builds_benchmark: false, benchmark_known: true, collaborators: '', project_ids: [], parent_ids: [], related_ids: []}}), said, jsonOf);
  assert.equal(unsaid.ready, true, 'ready once the fields are there, even if the model forgets to say so');
  assert.deepEqual(full.draft.parent_ids, ['ms-co']);
});

test('an answer it can\u2019t read is asked again, once', async () => {
  let n = 0;
  const flaky = async () => ({message: {content: ++n === 1 ? '{"reply": "cut' : JSON.stringify({reply: 'Again', ready: false, draft: {}})}});
  const r = await I.interview([{role: 'user', content: 'x'}], lab, flaky, said, jsonOf);
  assert.equal(r.reply, 'Again'); assert.equal(n, 2);
  let m = 0;
  await assert.rejects(I.interview([{role: 'user', content: 'x'}], lab, async () => { m++; return {message: {content: '{'}}; }, said, jsonOf));
  assert.equal(m, 2);
});
