const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../src/assets/js/profile-photo.js'), 'utf8');

async function mountWith(photo) {
  const calls = [];
  const node = {
    dataset: { id: 'U123', name: 'Ada Lovelace' }, children: [],
    classList: { add() {} }, setAttribute() {}, appendChild(img) { this.children.push(img); },
    set textContent(value) { this.children = []; this.text = value; }, get textContent() { return this.text; },
  };
  const context = {
    BOLD: { getAuth: () => ({ currentUser: { email: 'viewer@example.test' } }), authHint: () => null },
    firebase: { app: () => ({ functions: () => ({ httpsCallable: () => data => {
      calls.push(data);
      return photo instanceof Error ? Promise.reject(photo) : Promise.resolve({ data: { U123: photo } });
    } }) }) },
    document: { createElement: () => ({ alt: '', classList: { add() {} }, remove() { node.children = node.children.filter(child => child !== this); }, set src(value) { this.url = value; } }) },
    localStorage: { getItem: () => null, setItem() {} },
  };
  vm.runInNewContext(script, context);
  context.BOLD.photo.mountMany([node]);
  await new Promise(resolve => setImmediate(resolve));
  return { node, calls };
}

test('rota uses the shared signed photo', async () => {
  const { node, calls } = await mountWith({ state: 'active', url: 'https://shared.example/photo' });
  assert.equal(calls[0].action, 'batch');
  assert.deepEqual(Array.from(calls[0].slackIds), ['U123']);
  assert.equal(node.children[0].url, 'https://shared.example/photo');
});

test('rota shows initials when the shared photo is missing or unavailable', async () => {
  for (const photo of [{ state: 'missing' }, new Error('Function unavailable')]) {
    const { node } = await mountWith(photo);
    assert.equal(node.textContent, 'AL');
    assert.equal(node.children.length, 0);
  }
});

test('a failed shared image load leaves initials', async () => {
  const { node } = await mountWith({ state: 'active', url: 'https://shared.example/broken' });
  node.children[0].onerror();
  assert.equal(node.textContent, 'AL');
  assert.equal(node.children.length, 0);
});

test('removing a shared photo leaves initials', async () => {
  const { node } = await mountWith({ state: 'removed' });
  assert.equal(node.textContent, 'AL');
  assert.equal(node.children.length, 0);
});
