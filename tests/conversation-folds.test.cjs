const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const post = { id: 'tea', title: 'When should we break?', name: 'Sam', body: 'Any ideas?', private: false };
function reply(id, parent, name = 'River Day') {
  return { id, parent, name, createdBy: name === 'River Day' ? 'river@example.test' : '', body: 'Comment ' + id, source: 'site', votes: {}, at: 1 };
}
const initial = [reply('a', 'tea'), reply('b', 'a'), reply('c', 'b'), reply('sibling', 'tea', 'Robin')];

function openThread(storage, uid, hash = '#post=tea') {
  const { document, window } = parseHTML('<html><body></body></html>');
  const snapshot = items => ({ docs: items.map(item => ({ id: item.id, data: () => item })) });
  const receivers = new Map();
  function collection(name, parent) {
    const key = parent ? parent + '/' + name : name;
    const query = {
      doc: id => ({ collection: child => collection(child, id) }), where: () => query,
      get: async () => snapshot(name === 'people' ? [{ id: 'URIVER', name: 'River Day', email: 'river@example.test' }] : []),
      onSnapshot: listener => { receivers.set(key, listener); return () => receivers.delete(key); },
    };
    return query;
  }
  let userChanged, accessChanged;
  const context = {
    document, location: { hash }, URLSearchParams, CSS: { escape: String },
    Event: window.Event, setTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), console, addEventListener() {},
    getComputedStyle: () => ({ lineHeight: '20px' }),
    localStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    firebase: {
      firestore: () => ({ collection }), auth: () => ({ currentUser: { uid } }),
      app: () => ({ functions: () => ({ httpsCallable: () => async () =>
        ({ data: { URIVER: { state: 'active', url: '/fictional-portrait.png' } } }) }) }),
    },
    BOLD: {
      getApp() {}, escapeHtml: String, can: () => true, cannotReason: () => '', isFullWrite: () => false,
      moreMenuHtml: () => '', onUser: fn => { userChanged = fn; }, onAccess: fn => { accessChanged = fn; },
    },
    BoldMarkdown: { render: text => text },
  };
  context.window = context;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  vm.createContext(context);
  const page = fs.readFileSync(require.resolve('../src/pages/conversations.html'), 'utf8');
  const scripts = JSON.parse(page.match(/^scripts: (.*)$/m)[1]);
  // Run the same shared forum and portrait components as the page. Eleventy also serves
  // shared server/client scripts from functions as assets/js.
  for (const script of ['profile-photo.js', ...scripts.filter(name => name === 'search-rank.js' || name.startsWith('conversation'))]) {
    const asset = path.join(__dirname, '../src/assets/js', script);
    const file = fs.existsSync(asset) ? asset : path.join(__dirname, '../functions', script);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: script });
  }
  document.body.appendChild(context.BoldConversations.create({}).el);
  userChanged({ uid, displayName: uid });
  accessChanged({ e: uid + '@example.test' });
  receivers.get('conversations')(snapshot([post]));
  const update = items => receivers.get('tea/messages')(snapshot(items));
  if (hash.includes('post=')) update(initial);
  const row = id => document.getElementById('m-' + id);
  const toggle = id => row(id).querySelector('.bs-open').click();
  const expanded = id => row(id).querySelector('.bs-open').getAttribute('aria-expanded') === 'true';
  return { row, toggle, expanded, update, document, location: context.location,
    publish: (key, items) => receivers.get(key)(snapshot(items)) };
}

test('fold choices survive reopening, new replies and reload, and belong to one reader', async () => {
  const storage = new Map();
  const first = openThread(storage, 'sam');
  first.toggle('b');
  first.toggle('a');
  assert.equal(first.row('a').querySelector('.bs-text'), null);
  assert.equal(first.row('c'), null);
  assert.equal(first.row('sibling').querySelector('.bs-avatar').textContent, 'RO');
  assert.equal(first.row('a').querySelector('.bs-avatar').textContent, 'RD');
  first.update([...initial, reply('new', 'b')]);
  assert.match(first.row('a').textContent, /3 replies · 1 new/);
  first.toggle('a');
  assert.equal(first.expanded('b'), false);
  first.toggle('a');
  const back = openThread(storage, 'sam');
  assert.equal(back.expanded('a'), false);
  const other = openThread(storage, 'lee');
  assert.equal(other.expanded('a'), true);
  other.toggle('sibling');
  assert.match(other.row('sibling').textContent, /0 replies/);
  assert.equal(other.row('sibling').querySelector('.bs-text'), null);
  const linked = openThread(storage, 'sam', '#post=tea&msg=c');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(linked.expanded('a'), true);
  assert.equal(linked.expanded('b'), true);
  assert.equal(linked.row('c').classList.contains('is-selected'), true);
  assert.equal(linked.row('c').querySelector('.bs-avatar img').getAttribute('src'), '/fictional-portrait.png');
});

test('deep replies remain reachable and a draft returns after its ancestor is reopened', () => {
  const thread = openThread(new Map(), 'sam');
  thread.row('c').querySelector('.bs-reply-btn').click();
  thread.row('c').querySelector('textarea').value = 'My unfinished reply';
  thread.toggle('a');
  thread.toggle('a');
  assert.equal(thread.row('c').querySelector('textarea').value, 'My unfinished reply');
  const deep = Array.from({ length: 65 }, (_, i) => reply('r' + i, i ? 'r' + (i - 1) : 'tea'));
  thread.update(deep);
  assert.ok(thread.row('r64'));
  thread.toggle('r59');
  assert.equal(thread.row('r64'), null);
  assert.match(thread.row('r59').textContent, /5 replies/);
});

test('the connector and its minus button fold their own branch and share the header’s state', () => {
  const thread = openThread(new Map(), 'sam');
  const header = thread.row('b').querySelector('.bs-line-head');
  assert.ok(header.querySelector('.bs-avatar'));
  assert.ok(header.querySelector('.bs-right .bs-up'));
  assert.ok(header.querySelector('.bs-right .bs-reply-btn'));
  const rail = id => thread.row(id).nextElementSibling?.querySelector(':scope > .bs-branch-fold');
  const originalB = rail('b');
  assert.equal(originalB.getAttribute('aria-label'), 'Collapse thread by River Day');
  originalB.querySelector('span').click();
  assert.equal(thread.expanded('b'), false);
  assert.equal(thread.expanded('a'), true);
  assert.equal(thread.row('c'), null);
  rail('a').click();
  assert.equal(thread.expanded('a'), false);
  assert.equal(thread.row('b'), null);
  assert.ok(thread.row('sibling').querySelector('.bs-text'));
  thread.toggle('a');
  assert.equal(thread.expanded('b'), false);
  thread.toggle('b');
  assert.ok(thread.row('c').querySelector('.bs-text'));
});

test('topic previews are capped and searching within a topic links to a reply in another topic', async () => {
  const forum = openThread(new Map(), 'sam', '');
  forum.publish('conversationTopics', [
    { id: 'advice', name: 'Advice', icon: '☎️' }, { id: 'about-bold', name: 'About BOLD', icon: '🦋' }
  ]);
  const rows = ['first', 'second', 'third', 'fourth', 'old'].map((id, i) => ({
    ...post, id, title: id, topicId: id === 'old' ? 'advice' : 'about-bold', at: i, pinned: id === 'first'
  }));
  forum.publish('conversations', rows);
  const group = forum.document.querySelector('.bs-topic h2 a[href="#topic=about-bold"]').closest('.bs-topic');
  assert.deepEqual(Array.from(group.querySelectorAll('ul a'), a => a.textContent), ['first', 'fourth', 'third']);
  forum.location.hash = '#topic=about-bold';
  forum.publish('conversations', rows);
  assert.equal(forum.document.querySelectorAll('.bs-post').length, 4);
  const search = forum.document.querySelector('.bs-find');
  search.value = 'compass rose';
  search.dispatchEvent(new forum.document.defaultView.Event('input'));
  forum.publish('old/messages', [{ id: 'answer', name: 'River', body: 'Try a compass rose.' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(forum.document.querySelector('.bs-result-topic').textContent, '☎️ Advice');
  assert.equal(forum.document.querySelector('.bs-matched-replies a').getAttribute('href'), '#post=old&msg=answer');
  search.value = ''; search.dispatchEvent(new forum.document.defaultView.Event('input'));
  assert.equal(forum.document.querySelectorAll('.bs-post').length, 4);
});
