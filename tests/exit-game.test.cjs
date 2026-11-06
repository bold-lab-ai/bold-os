// eXit (eggs.js): the branches follow Murat Erdemir's script, each ending reached as there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

function load(){
  const noop = () => {};
  const el = () => ({ classList: { toggle: noop, add: noop, contains: () => false }, addEventListener: noop, querySelectorAll: () => [], appendChild: noop });
  const document = Object.assign(el(), { documentElement: el(), readyState: 'loading', body: el(), querySelector: () => null, getElementById: () => null });
  const window = { };
  const ctx = { window, document, console: { log: noop, warn: noop }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: noop, setInterval: noop, setTimeout: noop, matchMedia: () => ({ matches: false }), navigator: {}, location: {} };
  vm.runInNewContext(fs.readFileSync(__dirname + '/../src/assets/js/eggs.js', 'utf8'), ctx);
  return window.BoldEggs._exitNext;
}
const next = load();
function play(answers){ let s = 'start'; for (const a of answers) { const t = next(s, a); if (t) s = t; } return s; }

test('every ending, by the script\'s own answers', () => {
  assert.equal(play(['move the barrel', 'enter tunnel', 'read note', 'light a match', 'look', 'get on the boat']), 'newWorld');
  assert.equal(play(['move the barrel', 'enter tunnel', 'read note', 'light a match', 'look', 'stay']), 'collapsed');
  assert.equal(play(['move the barrel', 'enter tunnel', 'read note', 'light a match', 'stay', 'read', 'stay']), 'stayed');
  assert.equal(play(['move the barrel', 'enter tunnel', 'read note', 'light a match', 'stay', 'leave']), 'left');
  assert.equal(play(['move the barrel', 'enter tunnel', 'read note', 'stay', 'yes', 'leave']), 'left');
  assert.equal(play(['move the barrel', 'enter tunnel', 'read note', 'stay', 'no', 'stay', 'yes']), 'cannotLeave');
  assert.equal(play(['move the barrel', 'enter tunnel', 'stay', 'yes', 'stay']), 'stayed');
  assert.equal(play(['move the barrel', 'stay', 'take', 'examine', 'light', 'stay']), 'stayed');
  assert.equal(play(['sit down next to my friend', 'light a match', 'leave']), 'left');
  assert.equal(play(['stay', 'leave']), 'left');
});

test('answers are case-blind; unknown ones and "leave" at the second note ask again', () => {
  assert.equal(next('start', '  Move The Barrel '), 'tunnel');
  assert.equal(next('start', 'dance'), null);
  assert.equal(next('noteAgain', 'leave'), null);
  assert.equal(next('start', 'examine'), 'beam');
});

test('answers are read by their words', () => {
  for (const a of ['enter', 'enter the tunnel', 'Enter the tunnel', 'Enter the secret tunnel', 'go into the tunnel', 'Leave.']) assert.equal(next('tunnel', a), 'weak', a);
  assert.equal(next('tunnel', 'look'), null);
  assert.equal(next('start', 'look at the barrel'), 'beam');
  assert.equal(next('start', 'push the barrel'), 'tunnel');
  assert.equal(next('start', 'sit down'), 'handed');
  assert.equal(next('dark', 'light the match'), 'beach');
  assert.equal(next('weak', 'take the note'), 'dark');
  assert.equal(next('boat', 'board the boat'), 'newWorld');
  assert.equal(next('match', 'y'), 'note');
  assert.equal(next('note', 'I stay with my friend'), 'stayed');
  assert.equal(next('note', 'don\'t leave'), null);
  assert.equal(next('note', ''), null);
});
