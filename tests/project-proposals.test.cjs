// Proposing a project (#226): a compute budget in GPU hours, Proposed until a PI or admin approves it.
const test = require('node:test');
const assert = require('node:assert');
const { normalizeGpuHours, proposalPending, allProjectsFromCards, proposalRoute, proposalHours, asksForMore } = require('../functions/index.js')._internal;

test('a compute budget is a whole number of GPU hours, more than none', () => {
  assert.strictEqual(normalizeGpuHours(2000), 2000);
  assert.strictEqual(normalizeGpuHours('2,500'), 2500);
  assert.strictEqual(normalizeGpuHours(12.6), 13);
  assert.ok(normalizeGpuHours(0).error);
  assert.ok(normalizeGpuHours('lots').error);
  assert.ok(normalizeGpuHours(2e7).error);
});

test('only an approved proposal, or none (every project from before), counts as approved', () => {
  assert.strictEqual(proposalPending({}), false);
  assert.strictEqual(proposalPending({ proposal: { status: 'approved' } }), false);
  assert.strictEqual(proposalPending({ proposal: { status: 'proposed' } }), true);
  assert.strictEqual(proposalPending({ proposal: { status: 'declined' } }), true);
});

test('proposed and declined projects are in Proposed, with their budget; the rest as before', () => {
  const card = (title, proposal) => ({ title, status: 'register', createdAt: 1, updatedAt: 1, submittedBy: { email: 'a@x.org' }, proposal });
  const g = allProjectsFromCards([], [], [
    { id: 'p1', data: card('Waits', { status: 'proposed', gpuHours: 400 }) },
    { id: 'p2', data: card('No', { status: 'declined', gpuHours: 10 }) },
    { id: 'p3', data: card('Yes', { status: 'approved', gpuHours: 50 }) },
    { id: 'p4', data: card('Old') },
  ], [], []);
  assert.deepStrictEqual(g.proposed.map((p) => p.title).sort(), ['No', 'Waits']);
  assert.deepStrictEqual(g.planned.map((p) => p.title).sort(), ['Old', 'Yes']);
  assert.deepStrictEqual(g.proposed.filter((p) => p.title === 'Waits')[0].proposal, { status: 'proposed', more: true, gpuHours: 400, dueAt: 0 });
});

test('BOLD-internal and above: approved at once within the standard allowance, 7 days if asking for more; below: always waits', () => {
  ['internal', 'staff', 'exec'].forEach((g) => {
    assert.strictEqual(proposalRoute(g, { more: false }), 'approve');
    assert.strictEqual(proposalRoute(g, { more: true, gpuHours: 5000 }), 'deadline');
  });
  ['associate', 'pan', 'out'].forEach((g) => {
    assert.strictEqual(proposalRoute(g, { more: false }), 'wait');
    assert.strictEqual(proposalRoute(g, { more: true, gpuHours: 5000 }), 'wait');
  });
  // From before the tickbox: asking for more if it gives hours.
  assert.strictEqual(asksForMore({ gpuHours: 350 }), true);
  assert.strictEqual(asksForMore({}), false);
  assert.strictEqual(proposalHours({ more: true, gpuHours: 20000 }), '20,000 GPU hours');
  assert.strictEqual(proposalHours({ more: false }), 'the standard compute allowance');
});
