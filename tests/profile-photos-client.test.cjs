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
      setAttribute() {}, appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; },
      set textContent(value) { this.children = []; this.text = value; },
      get textContent() { return this.text; },
    };
    nodes.push(item);
    return item;
  }
  const BOLD = { getAuth: () => ({ currentUser: { email: 'owner@example.com' } }), authHint: () => null };
  const store = {}, localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const firebase = { app: () => ({ functions: () => ({ httpsCallable: () => async data => {
    calls.push(data);
    if (data.action === 'mine') return { data: { slackId: 'UOWNER', photo: { state: 'missing' } } };
    return { data: Object.fromEntries(data.slackIds.map(id => [id, { state: 'active', url: 'https://storage.googleapis.com/test/' + id }])) };
  } }) }) };
  const document = { createElement: () => ({ classList: { add() {} }, remove() {} }), dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync('src/assets/js/profile-photo.js', 'utf8'), { BOLD, firebase, document, localStorage, CustomEvent: class {} });
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

function setup(handler) {
  const calls = [], store = {};
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const BOLD = { getAuth: () => ({ currentUser: { email: 'owner@example.com' } }), authHint: () => null };
  const firebase = { app: () => ({ functions: () => ({ httpsCallable: () => async data => { calls.push(data); return { data: await handler(data) }; } }) }) };
  const document = { createElement: () => ({ classList: { list: [], add(c) { this.list.push(c); } }, remove() {} }), dispatchEvent() {} };
  const load = () => vm.runInNewContext(fs.readFileSync('src/assets/js/profile-photo.js', 'utf8'), { BOLD, firebase, document, localStorage, CustomEvent: class {} });
  load();
  const node = (id, name) => ({ dataset: { id, name }, children: [], classList: { add() {} }, setAttribute() {},
    appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; },
    set textContent(v) { this.children = []; this.text = v; }, get textContent() { return this.text; } });
  return { calls, store, BOLD, load, node };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a failed batch is not retried on every render', async () => {
  const t = setup(async () => { throw new Error('permission-denied'); });
  t.BOLD.photo.mountMany([t.node('UONE', 'One')]);
  await tick();
  t.BOLD.photo.mountMany([t.node('UONE', 'One')]);
  t.BOLD.photo.mountMany([t.node('UONE', 'One')]);
  await tick();
  assert.equal(t.calls.length, 1);
});

test('a photo already shown is drawn at once on the next render, with no new call', async () => {
  const t = setup(async d => Object.fromEntries(d.slackIds.map(id => [id, { state: 'active', url: 'https://x/' + id }])));
  t.BOLD.photo.mountMany([t.node('UONE', 'One')]);
  await tick();
  const again = t.node('UONE', 'One');
  t.BOLD.photo.mountMany([again]);
  assert.equal(again.children.length, 1);
  assert.ok(again.children[0].classList.list.includes('is-loaded'));
  assert.equal(t.calls.length, 1);
});

test('your own photo is kept for the next page, and forgotten after a change', async () => {
  const t = setup(async () => ({ slackId: 'UOWNER', photo: { state: 'active', url: 'https://x/me' } }));
  await t.BOLD.photo.mountOwn(t.node('', 'Owner Person'), 'Owner Person');
  t.load();   // the next page
  const mast = t.node('', 'Owner Person');
  const shown = t.BOLD.photo.mountOwn(mast, 'Owner Person');
  assert.equal(mast.children[0].src, 'https://x/me');   // painted before any call
  await shown;
  assert.equal(t.calls.length, 1);
  t.BOLD.photo.clear('UOWNER');
  await t.BOLD.photo.mine();
  assert.equal(t.calls.length, 2);
});
