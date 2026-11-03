const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('People portraits use one batch call and Profile only reads until consent', async () => {
  const calls = [];
  const nodes = [];
  function node(id, name) {
    const item = {
      dataset: { id, name }, children: [], classList: { add() {} },
      setAttribute() {}, appendChild(child) { this.children.push(child); },
      set textContent(value) { this.children = []; this.text = value; },
      get textContent() { return this.text; },
    };
    nodes.push(item);
    return item;
  }
  const BOLD = {};
  const firebase = { app: () => ({ functions: () => ({ httpsCallable: () => async data => {
    calls.push(data);
    if (data.action === 'mine') return { data: { slackId: 'UOWNER', photo: { state: 'missing' } } };
    return { data: Object.fromEntries(data.slackIds.map(id => [id, { state: 'active', url: 'https://storage.googleapis.com/test/' + id }])) };
  } }) }) };
  const document = { createElement: () => ({ classList: { add() {} }, remove() {} }), dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync('src/assets/js/profile-photo.js', 'utf8'), { BOLD, firebase, document, CustomEvent: class {} });
  const a = node('UONE', 'One Person'), b = node('UTWO', 'Two People'), c = node('UONE', 'One Person');
  BOLD.photo.mountMany([a, b, c]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'batch');
  assert.deepEqual(Array.from(calls[0].slackIds), ['UONE', 'UTWO']);
  assert.equal(a.children[0].src, 'https://storage.googleapis.com/test/UONE');
  assert.equal(b.children[0].loading, 'lazy');
  assert.equal(c.children[0].src, a.children[0].src);
  const own = node('', 'Owner Person');
  await BOLD.photo.mountOwn(own, 'Owner Person');
  await BOLD.photo.mountOwn(own, 'Owner Person');
  assert.equal(calls.filter(c => c.action === 'mine').length, 1);
  assert.equal(calls.filter(c => c.action === 'slack' || c.action === 'ensure').length, 0);
  assert.equal(own.textContent, 'OP');
});
