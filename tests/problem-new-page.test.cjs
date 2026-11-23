// Adding a problem (problem-new.html): the conversation ticks off what's needed, then Check and edit shows what
// BOLD gathered as fields; edits there are what's sent next and what's saved.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');

const read = (f) => fs.readFileSync(require.resolve('../src/' + f), 'utf8');
const page = read('pages/problem-new.html');
const ns = 'ns-hcld', moon = 'ms-co';
const graph = {objectives: [{id: ns, title: 'Human-Centric', kind: 'northstar'}, {id: moon, title: 'Co-scientist', kind: 'moonshot'}], problems: [], edges: []};
const projects = [{id: 'world-models', board: '', title: 'World models'}, {id: ns, board: '', title: 'Human-Centric'}];
const gathered = {title: 'Divergence', significance: 'Wasted compute', difficulties: 'Shows up late', existing_solutions: 'Restarts',
  builds_benchmark: false, benchmark_known: true, collaborators: '', project_ids: ['world-models'], parent_ids: [moon], related_ids: []};

async function setup(search = '', stored = {}){
  const {document, window} = parseHTML('<html><body>' + page.slice(page.indexOf('<div class="hero">')) + '</body></html>');
  const calls = [];
  // Not in linkedom: scrolling and focus are no-ops here.
  window.HTMLElement.prototype.scrollIntoView = function(){};
  window.HTMLElement.prototype.focus = function(){};
  window.HTMLElement.prototype.reportValidity = function(){ return true; };
  const reply = (r) => Promise.resolve({data: r});
  const callable = (name) => (data) => {
    calls.push({name, data: JSON.parse(JSON.stringify(data))});
    if (name === 'benchmarkRegistry' && data.action === 'projects') return reply({items: projects});
    if (name === 'benchmarkRegistry' && data.action === 'family') return reply(graph);
    if (name === 'benchmarkRegistry' && data.action === 'create') return reply({problem_id: 'ak-' + 'a'.repeat(24)});
    const n = calls.filter((c) => c.name === 'problemInterview').length;
    return reply(n === 1 ? {me: {id: 'UME', name: 'Me'}, reply: 'Why does it matter?', ready: false, draft: {...gathered, title: '', existing_solutions: '', benchmark_known: false, project_ids: [], parent_ids: []}}
      : {me: {id: 'UME', name: 'Me'}, reply: 'All there: check it below.', ready: true, draft: gathered});
  };
  const visits = [];
  // problemDrafts in memory, as Firestore would keep them for this person.
  const drafts = new Map(Object.entries(stored));
  let n = 0;
  const doc = (id) => ({ id, set: async (v, o) => { drafts.set(id, o && o.merge ? {...(drafts.get(id) || {}), ...JSON.parse(JSON.stringify(v))} : v); }, delete: async () => { drafts.delete(id); } });
  const firestore = () => ({ collection: () => ({ doc: (id) => doc(id || 'd' + (++n)),
    where: (f, op, v) => ({ limit: () => ({ get: async () => ({ docs: [...drafts].filter(([, d]) => d[f] === v).map(([id, d]) => ({ id, data: () => d })) }) }) }) }) });
  let onUser;
  const ctx = {document, window, console, crypto: {randomUUID: () => '11111111-2222-3333-4444-555555555555'}, setInterval, clearInterval, setTimeout, clearTimeout, Event: window.Event,
    location: {assign: (u) => visits.push(u), search, pathname: '/problem-new.html'}, history: {replaceState(){}}, localStorage: {setItem(){}},
    matchMedia: () => ({matches: true}),
    firebase: {app: () => ({functions: () => ({httpsCallable: callable})}), firestore},
    BoldMarkdown: {render: (t) => '<p>' + t + '</p>'},
    BOLD: {escapeHtml: String, can: () => true, cannotReason: () => '', onAccess: (f) => f(), onUser: (f) => { onUser = f; },
      confirmAction: async () => ({skip: {}})}};
  ctx.window.matchMedia = ctx.matchMedia;
  vm.createContext(ctx);
  for (const f of ['assets/js/problem-projects.js', 'assets/js/problem-family-picker.js']) vm.runInContext(read(f), ctx);
  // The shared modules hang themselves on window; the page reads them as globals.
  ctx.BoldProblemProjects = ctx.BoldProblemProjects || window.BoldProblemProjects;
  ctx.BoldProblemFamily = ctx.BoldProblemFamily || window.BoldProblemFamily;
  vm.runInContext(read('assets/js/pages/problem-new.js'), ctx);
  onUser({uid: 'u1', email: 'Me@Example.com'});
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  const $ = (id) => document.getElementById(id);
  const say = async (text) => { $('pbChatInput').value = text; $('pbChatForm').dispatchEvent(new window.Event('submit', {cancelable: true})); for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {document, window, $, say, calls, visits, drafts};
}

test('ticks fill in as BOLD gathers them; Check and edit appears once it has all it needs', async () => {
  const {$, say, document} = await setup();
  assert.equal($('pbReview').hidden, true);
  await say('Runs diverge');
  const done = () => [...document.querySelectorAll('#pbChecks li.is-done')].length;
  assert.equal(done(), 2);
  assert.equal($('pbReview').hidden, true);
  await say('It wastes compute; restarts today; not a benchmark');
  assert.equal(done(), 6);
  assert.equal($('pbReview').hidden, false);
  assert.equal($('pbTitle').value, 'Divergence');
  assert.equal($('pbExisting').value, 'Restarts');
  // Projects: stepping stones only, the gathered one ticked.
  assert.equal(document.querySelectorAll('#pbProjects input').length, 1);
  assert.equal(document.querySelector('#pbProjects input').hasAttribute('checked'), true);
});

test('edits are sent with the next message and are what is saved', async () => {
  const {$, say, calls, visits, document, window} = await setup();
  await say('Runs diverge'); await say('More');
  $('pbTitle').value = 'Predicting divergence';
  $('pbReview').dispatchEvent(new window.Event('input'));
  await say('One more thing');
  assert.equal(calls.filter((c) => c.name === 'problemInterview').pop().data.draft.title, 'Predicting divergence');
  // BOLD's next draft keeps the edit (here it answers with the gathered draft again): the field shows it.
  $('pbTitle').value = 'Predicting divergence';
  $('pbReview').dispatchEvent(new window.Event('submit', {cancelable: true}));
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  const create = calls.find((c) => c.data.action === 'create');
  assert.equal(create.data.title, 'Predicting divergence');
  assert.equal(create.data.owner_id, 'UME');
  assert.deepEqual(create.data.projects, [{id: 'world-models', board: ''}]);
  assert.deepEqual(create.data.family, {parents: [moon], related: []});
  assert.equal(create.data.reminders, true);
  assert.equal(visits.length, 1);
});

test('the conversation is kept as their draft, picked up later, and gone once saved', async () => {
  const a = await setup();
  await a.say('Runs diverge');
  const [[id, kept]] = [...a.drafts];
  assert.equal(kept.email, 'me@example.com');
  assert.equal(kept.turns.length, 3);
  assert.equal(kept.title, 'Runs diverge');
  assert.equal(a.$('pbDrafts').hidden, false);
  await a.say('More');
  assert.equal(a.drafts.get(id).done, true);
  assert.equal(a.drafts.get(id).title, 'Divergence');
  // Later: ?draft=<id> opens it where they left it, Check and edit included.
  const b = await setup('?draft=' + id, {[id]: a.drafts.get(id)});
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.document.querySelectorAll('#pbLog .ha-msg').length, 5);
  assert.equal(b.$('pbReview').hidden, false);
  assert.equal(b.$('pbTitle').value, 'Divergence');
  b.$('pbReview').dispatchEvent(new b.window.Event('submit', {cancelable: true}));
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.calls.find((c) => c.data.action === 'create').data.owner_id, 'UME');
  assert.equal(b.drafts.has(id), false);
  assert.equal(b.visits.length, 1);
});
