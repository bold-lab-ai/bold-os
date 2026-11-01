const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../src/assets/js/profile-photo.js'), 'utf8');

async function mountWith(photo, fallback) {
  const node = {
    dataset: {}, children: [], textContent: '',
    classList: { add() {} }, setAttribute() {},
    appendChild(img) { this.children.push(img); },
  };
  const context = {
    BOLD: {},
    firebase: { app: () => ({ functions: () => ({ httpsCallable: () => () =>
      photo instanceof Error ? Promise.reject(photo) : Promise.resolve({ data: photo }) }) }) },
    document: { createElement: () => ({ alt: '', remove() {}, set src(value) { this.url = value; queueMicrotask(() => this.onload()); } }) },
  };
  vm.runInNewContext(script, context);
  context.BOLD.photo.mount(node, 'U123', 'Ada Lovelace', fallback);
  await new Promise(resolve => setImmediate(resolve));
  return node;
}

test('rota uses the shared photo before its legacy fallback', async () => {
  const node = await mountWith({ state: 'active', type: 'image/png', image: 'aGVsbG8=' }, 'https://legacy.example/photo');
  assert.equal(node.children[0].url, 'data:image/png;base64,aGVsbG8=');
});

test('rota uses a legacy photo when the shared photo is missing or unavailable', async () => {
  for (const photo of [{ state: 'missing' }, new Error('Function unavailable')]) {
    const node = await mountWith(photo, 'https://legacy.example/photo');
    assert.equal(node.children[0].url, 'https://legacy.example/photo');
  }
});

test('removing a shared photo leaves initials instead of restoring a legacy photo', async () => {
  const node = await mountWith({ state: 'removed' }, 'https://legacy.example/photo');
  assert.equal(node.textContent, 'AL');
  assert.equal(node.children.length, 0);
});
