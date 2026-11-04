// BOLD OS in the public channels (functions/index.js joinNewChannel, onChannelJoinRun; 2026-11-04):
// which channels it joins. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { channelsToJoin } = require('../functions/index.js')._internal;

test('only public channels it isn’t in, not archived, by name', () => {
  assert.deepStrictEqual(channelsToJoin([
    { id: 'C2', name: 'random' }, { id: 'C1', name: 'general', is_member: true }, { id: 'C3', name: 'old', is_archived: true },
    { id: 'G1', name: 'secret', is_private: true }, { id: 'C4', name: 'all-active-projects' }, null,
  ]), [{ id: 'C4', name: 'all-active-projects' }, { id: 'C2', name: 'random' }]);
});
