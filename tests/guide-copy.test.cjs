// The real copy control DOM and delegated events, with deterministic clipboard and time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
function harness(clipboard = { writeText: () => Promise.resolve() }) {
  const { window, document } = parseHTML('<html><body><main></main></body></html>');
  const timers = new Map(); let id = 0;
  const ctx = {
    window, document, navigator: { clipboard }, URL,
    location: { href: 'http://localhost:8137/guide.html?guide=test#old' },
    BOLD: { escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(fs.readFileSync('src/assets/js/guide-copy.js', 'utf8'), ctx);
  const root = document.querySelector('main'), copy = window.BoldGuideCopy;
  root.innerHTML = copy.html('p-first--details', 'First <details>') + copy.html('p-second--details', 'Second');
  copy.mount(root);
  const buttons = [...root.querySelectorAll('button')];
  function fire(element, type, props = {}) {
    const e = new window.Event(type, { bubbles: true });
    Object.assign(e, props); element.dispatchEvent(e);
  }
  function tick(ms) { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } }
  const field = (i, selector) => buttons[i].parentElement.querySelector(selector);
  return { ctx, root, buttons, fire, tick, timers, field, document };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('controls have unique content labels, real buttons, hidden decorative SVGs and live regions', () => {
  const h = harness();
  assert.equal(h.buttons[0].getAttribute('type'), 'button');
  assert.equal(h.buttons[0].getAttribute('aria-label'), 'Copy link to “First <details>”');
  assert.notEqual(h.buttons[0].getAttribute('aria-label'), h.buttons[1].getAttribute('aria-label'));
  assert.equal(h.root.querySelector('details'), null);
  const svg = h.buttons[0].querySelector('svg');
  assert.equal(svg.getAttribute('width'), '16');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('focusable'), 'false');
  assert.equal(h.field(0, '[role=status]').getAttribute('aria-live'), 'polite');
});
test('copy preserves URL and focus, confirms only after resolution, then resets at two seconds', async () => {
  let resolve; const values = [];
  const h = harness({ writeText: value => { values.push(value); return new Promise(done => { resolve = done; }); } });
  h.fire(h.buttons[0], 'focusin');
  const original = h.buttons[0];
  h.fire(original, 'click');
  assert.equal(original.hasAttribute('data-copy-state'), false);
  resolve(); await flush();
  assert.deepEqual(values, ['http://localhost:8137/guide.html?guide=test#p-first--details']);
  assert.equal(h.ctx.location.href, 'http://localhost:8137/guide.html?guide=test#old');
  assert.equal(h.buttons[0], original, 'focusable element is not replaced');
  assert.equal(original.getAttribute('data-copy-state'), 'success');
  assert.equal(h.field(0, '.gd-copy-tooltip').textContent, 'Copied!');
  assert.equal(h.field(0, '[role=status]').textContent, 'Copied!');
  assert.equal([...h.timers.values()].some(t => t.ms === 2000), true);
  h.tick(2000);
  assert.equal(original.hasAttribute('data-copy-state'), false);
  assert.equal(h.field(0, '.gd-copy-tooltip').hidden, false, 'label persists while focused');
  assert.equal(h.field(0, '.gd-copy-tooltip').textContent, original.getAttribute('aria-label'));
});
test('tooltip works on focus and Escape, and hides on blur', () => {
  const h = harness(), tip = h.field(0, '.gd-copy-tooltip');
  h.fire(h.buttons[0], 'focusin'); assert.equal(tip.hidden, false);
  h.fire(h.document, 'keydown', { key: 'Escape' }); assert.equal(tip.hidden, true);
  h.fire(h.buttons[0], 'focusout');
  h.fire(h.buttons[0], 'focusin'); assert.equal(tip.hidden, false);
  h.fire(h.buttons[0], 'focusout'); assert.equal(tip.hidden, true);
});
test('tooltip is hoverable across the gap from its button and dismisses after leaving', () => {
  const h = harness(), tip = h.field(0, '.gd-copy-tooltip');
  h.fire(h.buttons[0], 'pointerover'); assert.equal(tip.hidden, false);
  h.fire(h.buttons[0], 'pointerout', { relatedTarget: h.document.body });
  h.fire(tip, 'pointerover', { relatedTarget: h.document.body });
  h.tick(150); assert.equal(tip.hidden, false);
  h.fire(tip, 'pointerout', { relatedTarget: h.document.body });
  h.tick(150); assert.equal(tip.hidden, true);
});
test('tooltip is clamped into the viewport near either edge', () => {
  const h = harness(), tip = h.field(0, '.gd-copy-tooltip');
  h.ctx.window.innerWidth = 320; h.ctx.window.innerHeight = 256;
  tip.getBoundingClientRect = () => ({ width: 150, height: 36 });
  h.buttons[0].getBoundingClientRect = () => ({ left: 300, top: 0, bottom: 32, width: 32 });
  h.fire(h.buttons[0], 'focusin');
  assert.equal(tip.style.left, '162px'); assert.equal(tip.style.top, '38px');
  h.buttons[0].getBoundingClientRect = () => ({ left: 0, top: 200, bottom: 232, width: 32 });
  h.fire(h.ctx.window, 'resize'); assert.equal(tip.hidden, true);
  h.fire(h.buttons[0], 'focusout'); h.fire(h.buttons[0], 'focusin');
  assert.equal(tip.style.left, '8px');
});
test('unavailable, rejected and throwing clipboard APIs expose a selectable recovery URL', async () => {
  for (const clipboard of [null, { writeText: () => Promise.reject(new Error()) }, { writeText() { throw new Error(); } }]) {
    const h = harness(clipboard);
    h.fire(h.buttons[0], 'click'); await flush();
    assert.equal(h.buttons[0].getAttribute('data-copy-state'), 'error');
    assert.equal(h.field(0, '.gd-copy-recovery').hidden, false);
    assert.match(h.field(0, '[role=status]').textContent, /Couldn’t copy/);
    const input = h.field(0, 'input');
    assert.equal(input.value, 'http://localhost:8137/guide.html?guide=test#p-first--details');
    assert.equal(input.hasAttribute('readonly'), true);
    let selected = false; input.select = () => { selected = true; };
    h.fire(input, 'focusin'); assert.equal(selected, true);
    assert.equal(h.ctx.location.href.endsWith('#old'), true);
  }
});
test('latest request wins and repeated copies announce again without disturbing other controls', async () => {
  const pending = [];
  const h = harness({ writeText: () => new Promise(resolve => pending.push(resolve)) });
  h.fire(h.buttons[0], 'click'); h.fire(h.buttons[0], 'click');
  pending[1](); await flush();
  const first = h.field(0, '[role=status]').textContent;
  pending[0](); await flush();
  assert.equal(h.field(0, '[role=status]').textContent, first);
  h.fire(h.buttons[0], 'click'); pending[2](); await flush();
  assert.notEqual(h.field(0, '[role=status]').textContent, first);
  h.fire(h.buttons[1], 'click'); pending[3](); await flush();
  assert.equal(h.buttons[0].getAttribute('data-copy-state'), 'success');
  assert.equal(h.buttons[1].getAttribute('data-copy-state'), 'success');
});


test('pointer click focus does not keep the label open after leaving the icon', async () => {
  const h = harness(), tip = h.field(0, '.gd-copy-tooltip');
  h.fire(h.buttons[0], 'pointerover');
  h.fire(h.buttons[0], 'pointerdown');
  h.fire(h.buttons[0], 'focusin');
  h.fire(h.buttons[0], 'click'); await flush();
  h.fire(h.buttons[0], 'pointerout', { relatedTarget: h.document.body });
  h.tick(150); assert.equal(tip.hidden, true);
  h.tick(2000); assert.equal(tip.hidden, true, 'reset must not reopen the label for pointer focus');
});

test('scroll dismisses a clicked tooltip and its reset never sticks the label to the viewport', async () => {
  const h = harness(), tip = h.field(0, '.gd-copy-tooltip');
  h.fire(h.buttons[0], 'pointerover'); h.fire(h.buttons[0], 'pointerdown');
  h.fire(h.buttons[0], 'focusin'); h.fire(h.buttons[0], 'click'); await flush();
  h.fire(h.ctx.window, 'scroll'); assert.equal(tip.hidden, true);
  h.tick(2000); assert.equal(tip.hidden, true);
  h.fire(h.buttons[0], 'pointerout', { relatedTarget: h.document.body });
  h.fire(h.buttons[0], 'pointerover'); assert.equal(tip.hidden, false, 'deliberate re-entry opens the label again');
});

test('a clipboard promise resolving after scroll cannot reopen an abandoned tooltip', async () => {
  let resolve;
  const h = harness({ writeText: () => new Promise(done => { resolve = done; }) });
  const tip = h.field(0, '.gd-copy-tooltip');
  h.fire(h.buttons[0], 'click');
  h.fire(h.ctx.window, 'scroll');
  resolve(); await flush();
  assert.equal(tip.hidden, true);
  assert.equal(h.buttons[0].getAttribute('data-copy-state'), 'success', 'copy still completes');
  h.tick(2000); assert.equal(tip.hidden, true);
});

test('outside interaction, window blur and Escape dismiss tooltips and recovery panels', async () => {
  for (const trigger of ['outside', 'blur', 'escape']) {
    const h = harness(null), panel = h.field(0, '.gd-copy-recovery'), tip = h.field(0, '.gd-copy-tooltip');
    h.fire(h.buttons[0], 'click'); await flush(); assert.equal(panel.hidden, false);
    if (trigger === 'outside') h.fire(h.document.body, 'pointerdown');
    if (trigger === 'blur') h.fire(h.ctx.window, 'blur');
    if (trigger === 'escape') h.fire(h.document, 'keydown', { key: 'Escape' });
    assert.equal(tip.hidden, true); assert.equal(panel.hidden, true);
  }
});

test('an off-screen anchor never gets a tooltip clamped back onto the screen', () => {
  const h = harness();
  h.buttons[0].getBoundingClientRect = () => ({ left: 10, right: 42, top: -100, bottom: -68, width: 32 });
  h.fire(h.buttons[0], 'focusin'); assert.equal(h.field(0, '.gd-copy-tooltip').hidden, true);
});


test('a rejected clipboard promise after scroll does not reopen recovery either', async () => {
  let reject;
  const h = harness({ writeText: () => new Promise((_, no) => { reject = no; }) });
  h.fire(h.buttons[0], 'click'); h.fire(h.ctx.window, 'scroll');
  reject(new Error('denied')); await flush();
  assert.equal(h.field(0, '.gd-copy-tooltip').hidden, true);
  assert.equal(h.field(0, '.gd-copy-recovery').hidden, true);
  assert.equal(h.buttons[0].getAttribute('data-copy-state'), 'error');
});


test('copied links include their explicit section and preserve guide and branch parameters', async () => {
  const values = [], h = harness({ writeText: value => { values.push(value); return Promise.resolve(); } });
  h.ctx.location.href = 'http://localhost:8137/guide.html?guide=test&branch=example&section=first#old';
  h.buttons[0].setAttribute('data-copy-section', 'people');
  h.fire(h.buttons[0], 'click'); await flush();
  assert.equal(values[0], 'http://localhost:8137/guide.html?guide=test&branch=example&section=people#p-first--details');
  assert.equal(h.ctx.location.href.endsWith('section=first#old'), true, 'copy must not navigate');
});

test('a sectionless page removes a stale section selector from copied links', async () => {
  const values = [], h = harness({ writeText: value => { values.push(value); return Promise.resolve(); } });
  h.ctx.location.href = 'http://localhost:8137/guide.html?guide=test&section=old#old';
  h.fire(h.buttons[0], 'click'); await flush();
  assert.equal(values[0], 'http://localhost:8137/guide.html?guide=test#p-first--details');
});

test('manual recovery offers exactly the same section-aware URL as copying', async () => {
  const h = harness(null);
  h.buttons[0].setAttribute('data-copy-section', 'people');
  h.fire(h.buttons[0], 'click'); await flush();
  assert.equal(h.field(0, 'input').value, 'http://localhost:8137/guide.html?guide=test&section=people#p-first--details');
});
