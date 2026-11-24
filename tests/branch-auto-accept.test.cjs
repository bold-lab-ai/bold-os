// A proposed change nobody decides is accepted by itself (functions/branches.js dueAt): 7 days after it opened, or
// after its last commit, so a late change still gets its week; never a draft or one already decided.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const B = require('../functions/branches');
const DAY = 86400000;

test('due 7 days after it opened, or after its last commit if later', () => {
  assert.equal(B.AUTO_DAYS, 7);
  assert.equal(B.dueAt({status: 'open', at: 1000, editedAt: 1000}), 1000 + 7 * DAY);
  assert.equal(B.dueAt({status: 'open', at: 1000, editedAt: 1000 + 3 * DAY}), 1000 + 10 * DAY);
  assert.equal(B.dueAt({status: 'open', at: 1000, readyAt: 1000 + 2 * DAY, editedAt: 1000}), 1000 + 9 * DAY, 'a draft counts from when it was marked ready');
});

test('only an open branch is ever due', () => {
  const b = {status: 'open', at: 0, editedAt: 0};
  assert.equal(B.isDue(b, 7 * DAY - 1), false);
  assert.equal(B.isDue(b, 7 * DAY), true);
  for (const status of ['draft', 'accepted', 'declined', 'withdrawn']) assert.equal(B.isDue(Object.assign({}, b, {status}), 100 * DAY), false, status);
  assert.equal(B.isDue(null, 100 * DAY), false);
});
