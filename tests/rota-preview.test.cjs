const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const builder = fs.readFileSync(path.join(__dirname, '../scripts/build-rota-preview.mjs'), 'utf8');
const mock = builder.match(/\+ String\.raw`([\s\S]*?)`;/)?.[1];
assert.ok(mock, 'the preview builder contains its local data mock');
const fixture = {
  groupMeetings: [
    ['2026-11-16', { date: '2026-11-16', startTime: '11:00', status: 'scheduled' }],
    ['2026-11-09', { date: '2026-11-09', startTime: '11:00', status: 'scheduled' }],
  ],
  groupRotaSlots: [
    ['open-long', { meetingId: '2026-11-16', format: 'long', presenterSlackId: '', legacyMemberId: '', legacyName: '', topic: '', slidesUrl: '', projectId: '', revision: 0 }],
    ['assigned-short', { meetingId: '2026-11-09', format: 'short', presenterSlackId: 'preview-other', legacyMemberId: '', legacyName: '', topic: '', slidesUrl: '', projectId: '', revision: 0 }],
  ],
  people: [['preview-sam', { name: 'Samuel Simons' }], ['preview-other', { name: 'Other speaker' }]],
  projectWorkspaces: [],
};
const source = 'const data = ' + JSON.stringify(fixture) + ';\nconst localPhotos = new Set();\n' + mock;

class PreviewDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-10-28T12:00:00Z'])); }
}

function boot(storage) {
  const listeners = {};
  const context = vm.createContext({
    window: {}, document: { addEventListener: (event, handler) => { listeners[event] = handler; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    Date: PreviewDate, Promise, URL, URLSearchParams, setTimeout,
    location: { origin: 'http://localhost:8137' },
  });
  vm.runInContext(source, context);
  return {
    call: name => context.window.previewFirebase.app().functions().httpsCallable(name),
    slot: id => vm.runInContext('data.groupRotaSlots.find(([slotId]) => slotId === ' + JSON.stringify(id) + ')[1]', context),
    location: context.location,
    clickLink: (href, isSlides) => {
      let prevented = false;
      const link = { href, hasAttribute: attribute => attribute === 'data-rota-slides-link' && isSlides };
      listeners.click({ target: { closest: () => link }, preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}

test('claim and talk edits stay local and survive a preview reload', async () => {
  const storage = new Map();
  const preview = boot(storage);
  const slotId = 'open-long';
  const access = (await preview.call('groupRotaAccess')()).data;
  assert.equal(access.preview, true);
  await preview.call('groupRotaClaim')({ slotId });
  const claimed = preview.slot(slotId);
  assert.equal(claimed.presenterSlackId, access.slackId);
  assert.equal(claimed.topic, '');
  await preview.call('groupRotaEdit')({ slotId, revision: claimed.revision, topic: 'A local test talk', slidesUrl: 'https://example.invalid/slides', projectId: 'local-example-project' });
  const reloaded = boot(storage).slot(slotId);
  assert.equal(reloaded.topic, 'A local test talk');
  assert.equal(reloaded.slidesUrl, 'https://example.invalid/slides');
  assert.equal(reloaded.projectId, 'local-example-project');
  assert.equal(reloaded.presenterSlackId, access.slackId);
  storage.clear();
  assert.equal(boot(storage).slot(slotId).presenterSlackId, '');
});

test('the preview rejects invalid or unavailable local actions', async () => {
  const preview = boot(new Map());
  await assert.rejects(preview.call('groupRotaClaim')({ slotId: 'assigned-short' }));
  await preview.call('groupRotaClaim')({ slotId: 'open-long' });
  await assert.rejects(preview.call('groupRotaClaim')({ slotId: 'open-long' }));
  const slot = preview.slot('open-long');
  await assert.rejects(preview.call('groupRotaEdit')({ slotId: 'open-long', revision: slot.revision, topic: 'Talk', slidesUrl: 'http://example.invalid', projectId: '' }));
  await assert.rejects(preview.call('groupRotaRecuse')({ slotId: 'open-long' }));
});

test('declining a claimed slot opens it again and persists locally', async () => {
  const storage = new Map();
  const preview = boot(storage);
  await preview.call('groupRotaClaim')({ slotId: 'open-long' });
  const claimed = preview.slot('open-long');
  await preview.call('groupRotaEdit')({ slotId: 'open-long', revision: claimed.revision, topic: 'Local talk', slidesUrl: 'https://example.invalid/slides', projectId: 'local-example-project' });
  const edited = preview.slot('open-long');
  await preview.call('groupRotaRecuse')({ slotId: 'open-long', revision: edited.revision, reason: 'Cannot attend' });
  const reopened = boot(storage).slot('open-long');
  assert.equal(reopened.presenterSlackId, '');
  assert.equal(reopened.topic, '');
  assert.equal(reopened.slidesUrl, '');
  assert.equal(reopened.projectId, '');
});

test('the preview allows saved HTTPS slides to open on click', () => {
  const preview = boot(new Map());
  assert.equal(preview.clickLink('https://example.invalid/slides', true), false);
  assert.equal(preview.clickLink('https://example.invalid/other', false), true);
});

test('the preview opens its example project locally', () => {
  const preview = boot(new Map());
  assert.equal(preview.clickLink('http://localhost:8137/project.html#id=local-example-project', false), true);
  assert.equal(preview.location.href, 'group-meetings-project-preview.html');
});
