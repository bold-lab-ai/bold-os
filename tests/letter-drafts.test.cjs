// Recommendation letters (letters.html): what's typed and not sent yet is kept as a draft in the
// person's own browser (letter-drafts.js), saved as it's typed and by "Save as draft". The point
// of these tests: a draft never reaches the server (no letterRequest call, so no request changes
// and nobody hears on Slack), and what is sent in the end is what was sent before drafts existed.
// Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const read = (f) => fs.readFileSync(require.resolve('../src/assets/js/' + f), 'utf8');

// localStorage, in memory; `full`: it refuses every write (a full or switched-off storage).
function memory(full){
  const kept = new Map();
  return {
    kept,
    getItem: (k) => (kept.has(k) ? kept.get(k) : null),
    setItem: (k, v) => { if (full && full()) throw new Error('QuotaExceededError'); kept.set(k, String(v)); },
    removeItem: (k) => { kept.delete(k); },
  };
}

function drafts(){
  const ctx = {};
  vm.runInNewContext(read('letter-drafts.js'), ctx);
  return ctx.BoldLetterDrafts;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------- the store ----------

test('a draft is kept per account, and read back with when it was saved', () => {
  const D = drafts(), storage = memory();
  let t = 1000;
  const mine = D.store(storage, 'u1', () => t), theirs = D.store(storage, 'u2', () => t);
  assert.equal(mine.put('ask', 'd1', { purpose: 'PhD applications' }), 1000);
  assert.deepEqual(plain(mine.get('ask', 'd1')), { purpose: 'PhD applications', at: 1000 });
  assert.equal(theirs.get('ask', 'd1'), null);
  assert.deepEqual(plain(theirs.list('ask')), []);
  // Each kind is its own: an edit under the same id is another draft.
  assert.equal(mine.get('edit', 'd1'), null);
});

test('drafts are listed latest first, dropped one by one, and nothing is left behind', () => {
  const D = drafts(), storage = memory();
  let t = 1;
  const s = D.store(storage, 'u1', () => t);
  s.put('ask', 'a', { purpose: 'first' }); t = 2;
  s.put('ask', 'b', { purpose: 'second' });
  assert.deepEqual(plain(s.list('ask')).map((d) => d.id), ['b', 'a']);
  s.drop('ask', 'b');
  assert.deepEqual(plain(s.list('ask')).map((d) => d.id), ['a']);
  s.drop('ask', 'a');
  assert.equal(storage.kept.size, 0);
});

test('a draft put back as it was keeps when it was saved', () => {
  const D = drafts(), s = D.store(memory(), 'u1', () => 500);
  assert.equal(s.put('ask', 'a', { purpose: 'x' }, 42), 42);
  assert.equal(s.get('ask', 'a').at, 42);
});

test('a draft nobody came back to goes after 90 days', () => {
  const D = drafts(), storage = memory();
  let t = 0;
  const s = D.store(storage, 'u1', () => t);
  s.put('first', 'L1', { text: 'Dear committee' });
  t = D.KEEP_MS - 1;
  assert.ok(s.get('first', 'L1'));
  t = D.KEEP_MS;
  assert.equal(s.get('first', 'L1'), null);
});

test('the drafts of requests that are gone are dropped, the others kept', () => {
  const D = drafts(), s = D.store(memory(), 'u1', () => 1);
  s.put('edit', 'L1', { purpose: 'kept' });
  s.put('edit', 'L2', { purpose: 'withdrawn' });
  s.put('ask', 'd1', { purpose: 'not a request yet' });
  s.prune('edit', ['L1', 'L9']);
  assert.ok(s.get('edit', 'L1'));
  assert.equal(s.get('edit', 'L2'), null);
  assert.ok(s.get('ask', 'd1'));
});

test('a browser that refuses storage keeps no draft, and what it holds that isn’t one is ignored', () => {
  const D = drafts();
  assert.equal(D.store(null, 'u1'), null);
  assert.equal(D.store(memory(), ''), null);
  assert.equal(D.store(memory(() => true), 'u1'), null);
  // Full only later: the write says so (0), and nothing breaks.
  let full = false;
  const storage = memory(() => full), s = D.store(storage, 'u1', () => 1);
  full = true;
  assert.equal(s.put('ask', 'a', { purpose: 'x' }), 0);
  assert.equal(s.get('ask', 'a'), null);
  full = false;
  storage.kept.set('boldLetterDrafts:u1', '{not json');
  assert.deepEqual(plain(s.list('ask')), []);
  storage.kept.set('boldLetterDrafts:u1', JSON.stringify({ ask: { a: 'text', b: { purpose: 'no time' } }, edit: [] }));
  assert.deepEqual(plain(s.list('ask')), []);
});

test('a draft of an edit keeps who sends a letter that is in already', () => {
  const D = drafts();
  const live = [{ id: 'r1', name: 'MIT', sentBy: 'writer', submittedAt: 99 }, { id: 'r2', name: 'ETH', sentBy: 'writer', submittedAt: null }];
  const out = plain(D.rows([{ id: 'r1', name: 'MIT EECS', sentBy: 'requester' }, { id: 'r2', name: 'ETH', sentBy: 'requester' }, { name: 'New' }], live));
  assert.deepEqual(out[0], { id: 'r1', name: 'MIT EECS', sentBy: 'writer', submittedAt: 99 });
  assert.deepEqual(out[1], { id: 'r2', name: 'ETH', sentBy: 'requester', submittedAt: null });
  assert.deepEqual(out[2], { name: 'New', submittedAt: null });
});

test('a first draft that is what was sent is nothing to keep', () => {
  const D = drafts();
  assert.equal(D.sameFirst({ text: ' Dear committee\n', url: '', note: '' }, { text: 'Dear committee' }), true);
  assert.equal(D.sameFirst({ text: 'Dear committee, …', url: '', note: '' }, { text: 'Dear committee' }), false);
  assert.equal(D.sameFirst({ text: '', url: '', note: '' }, undefined), true);
});

// ---------- the page ----------

const REQUEST = {
  id: 'L1', requesterEmail: 'me@x', requesterName: 'Me', writerEmail: 'ref@x', writerName: 'Ref Eree',
  purpose: 'PhD applications', cv: 'https://cv', statement: '', howWorked: 'Dissertation, 2026.', best: '', extra: '',
  recipients: [{ id: 'r1', name: 'MIT', url: '', deadline: '2027-01-05', sentBy: 'writer', submittedAt: null, letterUrl: '', reminded: [] }],
  drafterEmail: '', drafterName: '', draftAt: null, acknowledgedAt: null, open: true, at: 1, updatedAt: 1,
};
const FOR_ME = Object.assign({}, REQUEST, { id: 'L2', requesterEmail: 'msc@x', requesterName: 'Msc Student', drafterEmail: 'me@x', drafterName: 'Me' });

// letters.js on a page of its own: Firestore answers with `data` ({ byMe, ofMe, forMe, sent }),
// every letterRequest call is recorded, and time passes only when the test says so.
function page(storage, data = {}){
  const { document, window } = parseHTML('<html><body><main id="letters"></main></body></html>');
  window.HTMLElement.prototype.scrollIntoView = function(){};
  window.HTMLElement.prototype.focus = function(){};
  window.localStorage = storage;
  const calls = [], asked = [], timers = new Map();
  let n = 0, confirmAnswer = true;
  window.confirm = (text) => { asked.push(text); return confirmAnswer; };
  const lists = { requesterEmail: data.byMe || [], writerEmail: data.ofMe || [], drafterEmail: data.forMe || [] };
  const snapshot = (docs) => ({ metadata: { fromCache: false }, docs: docs.map((d) => ({ id: d.id, data: () => { const x = Object.assign({}, d); delete x.id; return x; } })) });
  const firestore = () => ({ collection: (name) => ({ where: (field) => ({ onSnapshot: (next) => {
    next(snapshot(name === 'letterRequests' ? lists[field] : field === 'drafterEmail' ? data.sent || [] : []));
    return () => {};
  } }) }) });
  let onUser;
  const ctx = {
    document, window, console, URL, Event: window.Event, location: { hash: '', href: 'https://bold.test/letters.html' },
    setTimeout: (fn) => { timers.set(++n, fn); return n; }, clearTimeout: (id) => { timers.delete(id); },
    firebase: { firestore, app: () => ({ functions: () => ({ httpsCallable: (name) => (d) => {
      calls.push({ name, data: plain(d || {}) });
      return Promise.resolve({ data: name === 'letterWriters' ? { writers: [{ name: 'Ref Eree', email: 'ref@x' }, { name: 'Phd Student', email: 'phd@x' }] } : { id: 'L9' } });
    } }) }) },
    BOLD: { escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      getAuth: () => ({}), getApp: () => ({}), onUser: (f) => { onUser = f; }, takeLinkAction: () => false,
      copyBoxHtml: () => '', confirmAction: () => Promise.resolve(true) },
  };
  vm.createContext(ctx);
  vm.runInContext(read('letter-drafts.js'), ctx);
  ctx.BoldLetterDrafts = ctx.BoldLetterDrafts || window.BoldLetterDrafts;
  vm.runInContext(read('pages/letters.js'), ctx);
  onUser({ uid: 'u1', email: 'Me@X' });
  const main = document.getElementById('letters');
  const $ = (sel) => main.querySelector(sel);
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  return {
    main, $, calls, asked,
    sent: () => calls.filter((c) => c.name === 'letterRequest'),
    click: (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; assert.ok(el, 'no ' + sel); fire(el, 'click'); },
    type: (sel, text) => { const el = $(sel); assert.ok(el, 'no ' + sel); el.value = text; fire(el, 'input'); },
    // The typing pauses: whatever was waiting to be saved is.
    pause: () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); },
    waiting: () => timers.size,
    answer: (yes) => { confirmAnswer = yes; },
    settle: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); },
    kept: () => { const raw = storage.getItem('boldLetterDrafts:u1'); return raw ? JSON.parse(raw) : { ask: {}, edit: {}, first: {} }; },
  };
}

const WORK = '[data-key="howWorked"]';

test('typing a request saves it as a draft in the browser, and tells the server nothing', async () => {
  const storage = memory(), p = page(storage);
  p.click('.lt-ask');
  p.type('.lt-purpose', 'PhD applications, Fall 2027');
  p.type(WORK, 'Dissertation with you, Jan to Jun 2026.\n');
  assert.equal(p.waiting(), 1);                       // one save, once the typing pauses
  assert.deepEqual(Object.keys(p.kept().ask), []);
  p.pause();
  const got = Object.values(p.kept().ask);
  assert.equal(got.length, 1);
  assert.equal(got[0].purpose, 'PhD applications, Fall 2027');
  assert.equal(got[0].howWorked, 'Dissertation with you, Jan to Jun 2026.\n');   // as typed
  assert.match(p.$('.lt-saved').textContent, /^Draft saved /);
  await p.settle();
  assert.deepEqual(p.sent(), []);
});

test('an empty form leaves no draft, nor does one emptied again', () => {
  const storage = memory(), p = page(storage);
  p.click('.lt-ask');
  p.click('.lt-keep');
  assert.equal(storage.kept.size, 0);
  p.click('.lt-ask');
  p.type('.lt-purpose', 'x');
  p.pause();
  assert.equal(Object.keys(p.kept().ask).length, 1);
  p.type('.lt-purpose', '');
  p.pause();
  assert.equal(storage.kept.size, 0);
});

test('Save as draft closes the form, lists the draft, and it opens again as it was left', async () => {
  const storage = memory(), p = page(storage);
  p.click('.lt-ask');
  p.type('.lt-purpose', 'Fellowship');
  p.type(WORK, 'A summer project.');
  p.type('.lt-rn', 'Royal Society');
  p.click('.lt-keep');
  assert.equal(p.$('.lt-form'), null);
  assert.equal(p.$('.lt-draft .lt-title').textContent, 'Fellowship');
  assert.match(p.$('.lt-draft .lt-meta').textContent, /Not asked yet/);
  // A new page (another visit) finds it.
  const again = page(storage);
  again.click('.lt-draft .lt-resume');
  assert.equal(again.$('.lt-purpose').value, 'Fellowship');
  assert.equal(again.$(WORK).value, 'A summer project.');
  assert.equal(again.$('.lt-rn').value, 'Royal Society');
  await again.settle();
  assert.deepEqual(p.sent().concat(again.sent()), []);
});

test('Cancel asks before discarding what was typed; a draft it opened from stays as it was', () => {
  const storage = memory(), p = page(storage);
  p.click('.lt-ask');
  p.type('.lt-purpose', 'Fellowship');
  p.click('.lt-keep');
  const before = storage.getItem('boldLetterDrafts:u1');
  // Opened and closed with nothing typed: no question, the draft untouched.
  p.click('.lt-draft .lt-resume');
  p.click('.lt-cancel');
  assert.deepEqual(p.asked, []);
  assert.equal(storage.getItem('boldLetterDrafts:u1'), before);
  // Typed, saved as it's typed, then cancelled: back to the draft as it was.
  p.click('.lt-draft .lt-resume');
  p.type('.lt-purpose', 'Fellowship, 2027 round');
  p.pause();
  assert.notEqual(storage.getItem('boldLetterDrafts:u1'), before);
  p.answer(false);
  p.click('.lt-cancel');
  assert.ok(p.$('.lt-form'), 'the form stays when the answer is no');
  p.answer(true);
  p.click('.lt-cancel');
  assert.equal(p.$('.lt-form'), null);
  assert.equal(storage.getItem('boldLetterDrafts:u1'), before);
  // The draft's own Discard deletes it.
  p.click('.lt-draft .lt-drop');
  assert.equal(storage.kept.size, 0);
  assert.equal(p.$('.lt-draft'), null);
});

test('asking sends what it sent before drafts existed, once, and the draft goes', async () => {
  const storage = memory(), p = page(storage);
  p.click('.lt-ask');
  await p.settle();                                   // the people to choose from
  p.type('.lt-who .lt-who-q', 'ref');
  p.main.querySelector('.lt-who li[data-k]').dispatchEvent(new p.main.ownerDocument.defaultView.Event('mousedown', { bubbles: true }));
  p.type('.lt-purpose', '  PhD applications ');
  p.type('.lt-cv', 'https://cv.example/me.pdf');
  p.type(WORK, 'Dissertation with you.\n');
  p.type('.lt-rn', 'MIT EECS');
  p.pause();
  assert.equal(Object.keys(p.kept().ask).length, 1);
  assert.deepEqual(Object.values(p.kept().ask)[0].writer, { name: 'Ref Eree', email: 'ref@x' });
  p.click('.lt-save');
  await p.settle();
  assert.deepEqual(p.sent(), [{ name: 'letterRequest', data: {
    purpose: 'PhD applications', cv: 'https://cv.example/me.pdf', statement: '', howWorked: 'Dissertation with you.', best: '', extra: '',
    recipients: [{ name: 'MIT EECS', url: '', deadline: '', sentBy: 'writer' }],
    drafterEmail: '', action: 'create', writerEmail: 'ref@x',
  } }]);
  assert.equal(storage.kept.size, 0);
  assert.equal(p.$('.lt-form'), null);
});

test('changes to a request are a draft until Save: the request is not touched', async () => {
  const storage = memory(), p = page(storage, { byMe: [REQUEST] });
  p.click('.lt-open');
  p.click('.lt-edit');
  // Opened and left alone, or typed and put back: nothing to keep.
  p.type(WORK, 'Dissertation, 2026. And a paper.');
  p.type(WORK, 'Dissertation, 2026.');
  p.pause();
  assert.equal(storage.kept.size, 0);
  p.type(WORK, 'Dissertation, 2026. And a workshop paper.');
  p.pause();
  assert.equal(p.kept().edit.L1.howWorked, 'Dissertation, 2026. And a workshop paper.');
  assert.match(p.$('.lt-saved').textContent, /^Changes saved as a draft /);
  p.click('.lt-keep');
  assert.equal(p.$('.lt-form'), null);
  assert.match(p.$('.lt-meta').textContent, /changes not saved yet/);
  assert.match(p.$('.lt-unsaved').textContent, /aren’t saved yet/);
  // What the referee sees is the request as it is, not the draft.
  assert.match(p.$('.lt-materials').textContent, /Dissertation, 2026\./);
  assert.doesNotMatch(p.$('.lt-materials').textContent, /workshop/);
  await p.settle();
  assert.deepEqual(p.sent(), []);
  // Editing again goes on from the draft; saving sends it and the draft goes.
  p.click('.lt-unsaved .lt-edit');
  assert.equal(p.$(WORK).value, 'Dissertation, 2026. And a workshop paper.');
  p.click('.lt-save');
  await p.settle();
  assert.deepEqual(p.sent(), [{ name: 'letterRequest', data: {
    purpose: 'PhD applications', cv: 'https://cv', statement: '', howWorked: 'Dissertation, 2026. And a workshop paper.', best: '', extra: '',
    recipients: [{ id: 'r1', name: 'MIT', url: '', deadline: '2027-01-05', sentBy: 'writer' }],
    drafterEmail: '', action: 'update', id: 'L1',
  } }]);
  assert.equal(storage.kept.size, 0);
});

test('discarding a request’s unsaved changes leaves the request as it is', async () => {
  const storage = memory(), p = page(storage, { byMe: [REQUEST] });
  p.click('.lt-open');
  p.click('.lt-edit');
  p.type('.lt-purpose', 'Something else');
  p.click('.lt-keep');
  p.click('.lt-unsaved .lt-drop');
  assert.equal(storage.kept.size, 0);
  assert.equal(p.$('.lt-unsaved'), null);
  assert.equal(p.$('.lt-title').textContent, 'PhD applications');
  await p.settle();
  assert.deepEqual(p.sent(), []);
});

test('a first draft being typed is kept in the browser, and sent only by Send', async () => {
  const storage = memory(), p = page(storage, { forMe: [FOR_ME] });
  p.click('.lt-open');
  p.type('.lt-dtext', 'Dear committee, I supervised');
  p.pause();
  assert.equal(p.kept().first.L2.text, 'Dear committee, I supervised');
  assert.match(p.$('.lt-dform .lt-saved').textContent, /not sent$/);
  await p.settle();
  assert.deepEqual(p.sent(), []);
  // Another visit shows it, marked as not sent; Discard empties it again.
  const again = page(storage, { forMe: [FOR_ME] });
  again.click('.lt-open');
  assert.equal(again.$('.lt-dtext').value, 'Dear committee, I supervised');
  assert.equal(again.$('.lt-ddiscard').hidden, false);
  again.click('.lt-ddiscard');
  assert.equal(again.$('.lt-dtext').value, '');
  assert.equal(storage.kept.size, 0);
  // Typed again and sent: one call, as before, and no draft is left.
  again.type('.lt-dtext', 'Dear committee, …');
  again.click('.lt-dkeep');
  assert.equal(again.kept().first.L2.text, 'Dear committee, …');
  again.click('.lt-dsave');
  await again.settle();
  assert.deepEqual(again.sent(), [{ name: 'letterRequest', data: { action: 'draft', id: 'L2', text: 'Dear committee, …', url: '', note: '' } }]);
  assert.equal(storage.kept.size, 0);
});

test('the drafts of a request that was withdrawn go once the server says it is gone', () => {
  const storage = memory();
  const D = drafts().store(storage, 'u1');
  D.put('edit', 'L1', { purpose: 'still there' });
  D.put('edit', 'GONE', { purpose: 'withdrawn elsewhere' });
  D.put('first', 'GONE2', { text: 'no longer asked for' });
  const p = page(storage, { byMe: [REQUEST] });
  assert.deepEqual(Object.keys(p.kept().edit), ['L1']);
  assert.deepEqual(Object.keys(p.kept().first), []);
});

test('with no storage the page works as before, with Save as draft greyed out', async () => {
  const p = page(memory(() => true));
  p.click('.lt-ask');
  assert.equal(p.$('.lt-keep').disabled, true);
  assert.match(p.$('.lt-keep').getAttribute('title'), /doesn’t let BOLD\.OS keep a draft/);
  p.type('.lt-purpose', 'x');
  assert.equal(p.waiting(), 0);
});
