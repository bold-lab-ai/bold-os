const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../src/assets/js/pages/group-meetings.js'), 'utf8');

async function page(seriesHidden, admin) {
  const handlers = {}, calls = [], confirms = [];
  const body = {
    innerHTML: '', hidden: true,
    addEventListener: (event, fn) => { handlers[event] = fn; },
    querySelectorAll: () => [],
  };
  const message = { textContent: '', hidden: false };
  const elements = {
    rotaBody: body, rotaMessage: message, rotaMeta: { textContent: '' },
    rotaSearch: { addEventListener() {} },
    rotaArchiveLink: { href: '', textContent: '' },
  };
  const access = { admin, seriesHidden, seriesId: 'group-meetings-afb58e', eligible: true,
    registered: true, slackId: 'U1', people: [], swaps: [] };
  const document = {
    body: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, hidden: true }),
    getElementById: id => elements[id],
    querySelector: () => ({ textContent: '' }),
  };
  const firebase = {
    firestore: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }),
    app: () => ({ functions: () => ({ httpsCallable: name => async data => {
      calls.push({ name, data });
      if (name === 'groupRotaPage') return { data: { access, snapshot: { meetings: [], slots: [], members: [], seasons: [] } } };
      if (name === 'eventSeries') return { data: { series: { hidden: false } } };
      throw Error('Unexpected callable: ' + name);
    } }) }),
  };
  const BOLD = {
    getAuth: () => ({}), getApp: () => ({}), escapeHtml: value => String(value || ''),
    onUser: fn => fn({ email: 'organiser@example.org' }),
    confirmAction: details => { confirms.push(details); return Promise.resolve(true); },
  };
  vm.runInNewContext(script, { document, firebase, BOLD, URLSearchParams,
    location: { search: '', href: '' }, console, setTimeout });
  await new Promise(resolve => setImmediate(resolve));
  return { body, handlers, calls, confirms };
}

test('an organiser can release the hidden series from the rota', async () => {
  const p = await page(true, true);
  assert.match(p.body.innerHTML, /data-action="seriesVisibility"[^>]*>Release event series</);
  p.handlers.click({ target: { closest: selector => selector === '[data-action]' ? {
    disabled: false, dataset: { action: 'seriesVisibility' }, closest: () => null,
  } : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.confirms.length, 1);
  assert.equal(p.confirms[0].always, true);
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls.find(c => c.name === 'eventSeries').data)),
    { action: 'release', id: 'group-meetings-afb58e' });
});

test('a non-organiser sees why the series action is disabled', async () => {
  const p = await page(true, false);
  assert.match(p.body.innerHTML, /data-action="seriesVisibility" disabled title="Only a series organiser, PI or admin can change visibility"/);
});

test('an organiser can hide a released series with the same confirmation', async () => {
  const p = await page(false, true);
  assert.match(p.body.innerHTML, /data-action="seriesVisibility"[^>]*>Hide event series</);
  p.handlers.click({ target: { closest: selector => selector === '[data-action]' ? {
    disabled: false, dataset: { action: 'seriesVisibility' }, closest: () => null,
  } : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.confirms[0].always, true);
  assert.ok(p.confirms[0].effects.some(e => /every meeting/.test(e)), 'says every meeting follows the series');
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls.find(c => c.name === 'eventSeries').data)),
    { action: 'hide', id: 'group-meetings-afb58e' });
});
