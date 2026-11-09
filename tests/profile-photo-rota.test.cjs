const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../src/assets/js/profile-photo.js'), 'utf8');

async function mountWith(photo, fallback) {
  const calls = [];
  const node = {
    dataset: { id: 'U123', name: 'Ada Lovelace', fallbackUrl: fallback }, children: [],
    classList: { add() {} }, setAttribute() {}, appendChild(img) { this.children.push(img); },
    set textContent(value) { this.children = []; this.text = value; }, get textContent() { return this.text; },
  };
  const context = {
    BOLD: { getAuth: () => ({ currentUser: { email: 'viewer@example.test' } }), authHint: () => null },
    firebase: { app: () => ({ functions: () => ({ httpsCallable: () => data => {
      calls.push(data);
      return photo instanceof Error ? Promise.reject(photo) : Promise.resolve({ data: { U123: photo } });
    } }) }) },
    document: { createElement: () => ({ alt: '', classList: { add() {} }, remove() {}, set src(value) { this.url = value; } }) },
    localStorage: { getItem: () => null, setItem() {} },
  };
  vm.runInNewContext(script, context);
  context.BOLD.photo.mountMany([node]);
  await new Promise(resolve => setImmediate(resolve));
  return { node, calls };
}

test('rota uses a shared signed photo before its legacy fallback', async () => {
  const { node, calls } = await mountWith({ state: 'active', url: 'https://shared.example/photo' }, 'https://legacy.example/photo');
  assert.equal(calls[0].action, 'batch');
  assert.deepEqual(Array.from(calls[0].slackIds), ['U123']);
  assert.equal(node.children[0].url, 'https://shared.example/photo');
});

test('rota uses a legacy photo when the shared photo is missing or unavailable', async () => {
  for (const photo of [{ state: 'missing' }, new Error('Function unavailable')]) {
    const { node } = await mountWith(photo, 'https://legacy.example/photo');
    assert.equal(node.children[0].url, 'https://legacy.example/photo');
  }
});

test('a failed shared image load uses the legacy photo', async () => {
  const { node } = await mountWith({ state: 'active', url: 'https://shared.example/broken' }, 'https://legacy.example/photo');
  node.children[0].onerror();
  assert.equal(node.children[1].url, 'https://legacy.example/photo');
});

test('removing a shared photo leaves initials instead of restoring a legacy photo', async () => {
  const { node } = await mountWith({ state: 'removed' }, 'https://legacy.example/photo');
  assert.equal(node.textContent, 'AL');
  assert.equal(node.children.length, 0);
});
