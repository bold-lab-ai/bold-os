const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, normalize, channelId, publicView } = require('../functions/calendar-meetings');

class ApiError extends Error { constructor(code, message){ super(message); this.code = code; } }
const fixture = () => ({ id: 'meeting-test-00000000001', channel: 'CPRIVATE01', title: 'Joint supervision', firstDate: '2026-10-23', time: '15:00', minutes: 60, every: 1, until: '',
  link: 'https://meet.example.org/shared-room', participantIds: ['UCREATOR', 'UGUEST'], manualIds: ['UGUEST'] });
function harness(options = {}){
  const data = new Map([
    ['people/UCREATOR', { name: 'Ada', email: 'ada@example.org' }],
    ['people/UMEMBER', { name: 'Ben', email: 'ben@example.org' }],
    ['people/UGUEST', { name: 'Cam', email: 'cam@example.org' }],
    ['people/UADMIN', { name: 'Dee', email: 'dee@example.org' }]
  ]);
  const clone = (v) => v === undefined ? undefined : structuredClone(v);
  function ref(path){ return { path, id: path.split('/').pop(), get: async () => snap(path) }; }
  function snap(path){ return { id: path.split('/').pop(), exists: data.has(path), data: () => clone(data.get(path)), ref: ref(path) }; }
  function collection(path, filters = [], count = Infinity){
    return { doc: (id) => ref(path + '/' + id), where: (key, op, val) => collection(path, filters.concat([[key, val]]), count), limit: (n) => collection(path, filters, n),
      get: async () => ({ docs: Array.from(data.keys()).filter((p) => p.startsWith(path + '/') && p.split('/').length === path.split('/').length + 1 && filters.every(([k,v]) => data.get(p)[k] === v)).slice(0, count).map(snap) }) };
  }
  const db = { collection, runTransaction: async (fn) => {
    const changes = []; const result = await fn({ get: async (r) => snap(r.path), set: (r,v) => changes.push(() => data.set(r.path, clone(v))), delete: (r) => changes.push(() => data.delete(r.path)) });
    changes.forEach((f) => f()); return result;
  } };
  const state = { members: ['UCREATOR', 'UMEMBER', 'BBOT'], calls: [], offline: false, edit: true, view: true, private: true };
  const access = { requireAccess: async (e, a, what) => { if (!state[what]) throw new ApiError('permission-denied', 'No calendar access.'); }, can: async (e, a, what) => state[what] };
  const slack = async (method, args) => {
    state.calls.push({ method, args });
    if (state.offline) throw new Error('Slack unavailable');
    if (method === 'conversations.info') return { ok: true, channel: { name: 'joint-supervision', is_private: state.private } };
    if (method === 'conversations.members') return { ok: true, members: args.cursor ? state.members.slice(1) : state.members.slice(0,1), response_metadata: { next_cursor: args.cursor ? '' : 'next' } };
    throw new Error('Unexpected outbound call: ' + method);
  };
  return { data, state, run: createService({ db, access, HttpsError: ApiError, slack, now: () => 1000, ...options }).run };
}
test('channel links are parsed without accepting spoofed Slack hosts or DMs', () => {
  assert.equal(channelId('https://bold.slack.com/archives/CPRIVATE01'), 'CPRIVATE01');
  assert.equal(channelId('https://app.slack.com/client/T12345/CPRIVATE01'), 'CPRIVATE01');
  for (const v of ['https://slack.com.evil.org/archives/CPRIVATE01', 'http://bold.slack.com/archives/CPRIVATE01', 'DPRIVATE01', '#joint-supervision']) assert.equal(channelId(v), '');
});
test('validation preserves London wall time and first-date anchor across DST, rejects invalid schedules', () => {
  const s = normalize(fixture()); assert.equal(s.meeting.time, '15:00'); assert.equal(s.meeting.day, 'FR'); assert.equal(s.firstDate, '2026-10-23');
  assert.equal(normalize({ ...fixture(), firstDate: '2026-10-30', every: 2 }).meeting.time, '15:00');
  for (const change of [{ firstDate: '2026-02-30' }, { until: '2026-10-22' }, { every: 5 }, { time: '25:00' }, { minutes: 7 }, { link: 'javascript:alert(1)' }, { link: 'https://user:password@example.org/' }, { participantIds: [] }]) assert.throws(() => normalize({ ...fixture(), ...change }));
});
test('channel import verifies caller membership across all Slack pages, returns names and excludes unmatched members', async () => {
  const h = harness(); const r = await h.run('ben@example.org', { action: 'channel', channel: 'CPRIVATE01' });
  assert.equal(r.unmatched, 1); assert.equal(r.people.length, 2); assert.ok(h.state.calls.some((c) => c.args.cursor));
  assert.ok(!JSON.stringify(r).includes('@'));
  for (const email of ['cam@example.org', 'dee@example.org']) await assert.rejects(h.run(email, { action: 'channel', channel: 'CPRIVATE01', memberIds: ['UGUEST', 'UADMIN'] }), { code: 'permission-denied' });
});
test('membership is required for public channels too', async () => {
  const h = harness(); h.state.private = false;
  await assert.rejects(h.run('cam@example.org', { action: 'save', ...fixture() }), { code: 'permission-denied' });
});
test('save writes a separate link-free projection and no Google event; repeated submission is idempotent', async () => {
  const h = harness(); const a = { action: 'save', ...fixture() };
  const first = await h.run('ada@example.org', a), second = await h.run('ada@example.org', a);
  assert.equal(first.id, second.id); assert.equal(second.existing, true);
  const publicRecord = h.data.get('calendarMeetingEntries/' + a.id);
  assert.deepEqual(publicRecord, publicView(first));
  assert.ok(!JSON.stringify(publicRecord).includes('shared-room'));
  assert.ok(!JSON.stringify(publicRecord).includes('CPRIVATE01'));
  assert.equal(Array.from(h.data.keys()).filter((k) => k.startsWith('calendarMeetings/')).length, 1);
  assert.ok(h.state.calls.every((c) => ['conversations.info', 'conversations.members'].includes(c.method)));
});
test('manually listed participants and admins outside the channel never receive the link', async () => {
  const h = harness(); const a = fixture(); await h.run('ada@example.org', { action: 'save', ...a });
  const guest = await h.run('cam@example.org', { action: 'get', id: a.id });
  assert.equal(guest.people.length, 2); assert.equal(guest.link, undefined); assert.equal(guest.channel, undefined); assert.equal(guest.canEdit, false);
  const admin = await h.run('dee@example.org', { action: 'get', id: a.id });
  assert.equal(admin.link, undefined); assert.equal(admin.people, undefined);
  const member = await h.run('ben@example.org', { action: 'get', id: a.id });
  assert.equal(member.link, a.link); assert.equal(member.canEdit, true);
});
test('loss of membership revokes link access and editing, including the creator', async () => {
  const h = harness(); const a = fixture(); await h.run('ada@example.org', { action: 'save', ...a });
  h.state.members = ['UMEMBER'];
  assert.equal((await h.run('ada@example.org', { action: 'get', id: a.id })).link, undefined);
  await assert.rejects(h.run('ada@example.org', { action: 'save', ...a, version: 1 }), { code: 'permission-denied' });
  await assert.rejects(h.run('ada@example.org', { action: 'remove', id: a.id, version: 1 }), { code: 'permission-denied' });
});
test('Slack failure fails closed, while public calendar entries remain readable', async () => {
  const h = harness(); const a = fixture(); await h.run('ada@example.org', { action: 'save', ...a }); h.state.offline = true;
  const r = await h.run('ada@example.org', { action: 'get', id: a.id });
  assert.equal(r.link, undefined); assert.equal(r.canEdit, false); assert.match(r.channelError, /Retry/);
  assert.equal((await h.run('cam@example.org', { action: 'list' })).meetings.length, 1);
  await assert.rejects(h.run('ada@example.org', { action: 'save', ...a, version: 1 }));
});
test('calendar permissions are enforced independently of Slack membership', async () => {
  const h = harness(); h.state.edit = false;
  await assert.rejects(h.run('ada@example.org', { action: 'save', ...fixture() }), { code: 'permission-denied' });
  h.state.view = false; await assert.rejects(h.run('ada@example.org', { action: 'list' }), { code: 'permission-denied' });
});
test('duplicate entry is rejected; different channel member can edit, stale writes cannot overwrite', async () => {
  const h = harness(); const a = fixture(); await h.run('ada@example.org', { action: 'save', ...a });
  await assert.rejects(h.run('ben@example.org', { action: 'save', ...a, id: 'meeting-other-000000001' }), { code: 'already-exists' });
  const r = await h.run('ben@example.org', { action: 'save', ...a, version: 1, time: '16:00' }); assert.equal(r.version, 2);
  await assert.rejects(h.run('ada@example.org', { action: 'save', ...a, version: 1 }), { code: 'aborted' });
  await assert.rejects(h.run('ada@example.org', { action: 'remove', id: a.id, version: 1 }), { code: 'aborted' });
  await h.run('ben@example.org', { action: 'remove', id: a.id, version: 2 });
  assert.equal(Array.from(h.data.keys()).filter((k) => k.startsWith('calendarMeeting')).length, 0);
});
test('cannot forge participant identities or change the associated channel', async () => {
  const h = harness(); const a = fixture();
  await assert.rejects(h.run('ada@example.org', { action: 'save', ...a, participantIds: ['UUNKNOWN'] }), { code: 'invalid-argument' });
  await h.run('ada@example.org', { action: 'save', ...a });
  await assert.rejects(h.run('ada@example.org', { action: 'save', ...a, version: 1, channel: 'COTHER0001' }), { code: 'invalid-argument' });
});

test('project meetings must reference a current OS project, and preserve the project URL metadata', async () => {
  const h = harness({projectChoices: async () => [{id:'project-1', title:'Example project', board:'venue-1'}]});
  const a = {...fixture(), action:'save', category:'project'};
  assert.equal((await h.run('ada@example.org', {action:'projects'})).projects[0].id, 'project-1');
  for (const projectId of ['', 'invented']) await assert.rejects(h.run('ada@example.org', {...a, projectId}), {code:'invalid-argument'});
  const saved = await h.run('ada@example.org', {...a, projectId:'project-1'});
  assert.equal(saved.projectId, 'project-1'); assert.equal(saved.projectTitle, 'Example project'); assert.equal(saved.projectBoard, 'venue-1');
  assert.equal(h.data.has('projectWorkspaces/project-1'), false);
  const changed = await h.run('ada@example.org', {...a, version:1, category:'other', projectId:'project-1'});
  assert.equal(changed.projectId, '');
});
test('new meetings require confirmation, default to no invitations, and protect generated links', async () => {
  const calls = [], h = harness({googleSync: async (s,op) => {calls.push({s,op});return {link:'https://meet.example.org/generated',eventId:'stable-google-id'};}});
  const a = {...fixture(), action:'save', mode:'create', category:'other', link:''};
  await assert.rejects(h.run('ada@example.org', a), {code:'failed-precondition'});
  assert.equal(calls.length, 0);
  const saved = await h.run('ada@example.org', {...a, confirmed:true});
  assert.equal(saved.calendarState, 'ready'); assert.equal(saved.link, undefined); assert.equal(calls[0].s.inviteGuests, false);
  assert.equal((await h.run('cam@example.org', {action:'get', id:a.id})).link, undefined);
  assert.equal((await h.run('ada@example.org', {action:'get', id:a.id})).link, 'https://meet.example.org/generated');
  await h.run('ada@example.org', {...a, confirmed:true}); assert.equal(calls.length, 1);
  await h.run('ada@example.org', {...a, version:1, confirmed:true, inviteGuests:true}); assert.equal(calls[1].s.inviteGuests, true);
  await assert.rejects(h.run('ada@example.org', {...a, version:2, mode:'existing', link:fixture().link}), {code:'invalid-argument'});
});
test('existing links never call Google even if inviteGuests is supplied', async () => {
  const h = harness({googleSync: async () => {throw new Error('Unexpected Google call');}});
  const a = {...fixture(), action:'save', inviteGuests:true};
  await h.run('ada@example.org', a);
  assert.equal(h.data.get('calendarMeetings/'+a.id).inviteGuests, false);
  await h.run('ada@example.org', {action:'remove',id:a.id,version:1});
  assert.equal(h.data.has('calendarMeetings/'+a.id), false);
});
test('failed Google save and removal keep retryable state and recheck membership and confirmation', async () => {
  let failing = true; const operations = [];
  const h = harness({googleSync: async (s,op) => {operations.push([s.id,op]);if(failing)throw Error('secret Google details');return op==='remove'?{removed:true}:{link:'https://meet.example.org/generated'};}});
  const a = {...fixture(), action:'save', mode:'create', confirmed:true, inviteGuests:true};
  const saved = await h.run('ada@example.org', a); assert.equal(saved.calendarState,'error');
  assert.ok(!JSON.stringify(await h.run('ada@example.org',{action:'get',id:a.id})).includes('secret Google details'));
  await assert.rejects(h.run('ada@example.org',{action:'retry',id:a.id,version:1}),{code:'failed-precondition'});
  await assert.rejects(h.run('cam@example.org',{action:'retry',id:a.id,version:1,confirmed:true}),{code:'permission-denied'});
  failing=false; const retried=await h.run('ada@example.org',{action:'retry',id:a.id,version:1,confirmed:true});
  assert.equal(retried.calendarState,'ready');
  failing=true; const removal=await h.run('ada@example.org',{action:'remove',id:a.id,version:2,confirmed:true});
  assert.equal(removal.calendarState,'error'); assert.equal(h.data.get('calendarMeetings/'+a.id).pendingOperation,'remove');
  failing=false; await h.run('ada@example.org',{action:'retry',id:a.id,version:3,confirmed:true});
  assert.equal(h.data.has('calendarMeetings/'+a.id),false);
  assert.deepEqual(operations.map(x=>x[1]),['save','save','remove','remove']);
  assert.ok(operations.every(x=>x[0]===a.id));
});
test('Google synchronization locks concurrent edits and expired leases can be retried', async () => {
  let release, entered; const started = new Promise(r=>{entered=r;}); let clock=1000;
  const h=harness({now:()=>clock,googleSync:async()=>{entered();await new Promise(r=>{release=r;});return {link:'https://meet.example.org/generated'};}});
  const a={...fixture(),action:'save',mode:'create',confirmed:true};
  const saving=h.run('ada@example.org',a); await started;
  await assert.rejects(h.run('ada@example.org',{...a,version:1,time:'16:00'}),{code:'aborted'});
  await assert.rejects(h.run('ada@example.org',{action:'remove',id:a.id,version:1,confirmed:true}),{code:'aborted'});
  assert.equal((await h.run('ada@example.org',{action:'get',id:a.id})).syncing,true);
  release(); await saving;
  const record=h.data.get('calendarMeetings/'+a.id); record.calendarLeaseUntil=clock+300000; record.calendarState='pending';
  clock+=300001;
  assert.equal((await h.run('ada@example.org',{action:'get',id:a.id})).syncing,false);
});
