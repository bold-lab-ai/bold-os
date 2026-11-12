const assert = require('node:assert/strict');
const admin = require('../functions/node_modules/firebase-admin');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
admin.initializeApp({ projectId: 'demo-test' });
const db = admin.firestore();
const sends = [];
let viewedAs = '';
const rota = require('../functions/group-rota')({
  db, admin, HttpsError, onCall: (opts, fn) => fn || opts, onSchedule: (opts, fn) => fn,
  signedInEmail: r => r.email,
  requireAccess: async () => {},
  seesEvent: async () => true,
  rolesEmails: async () => [],
  groupFor: async email => viewedAs && email === 'admin@example.org' ? viewedAs :
    (await db.collection('members').doc(email).get()).data()?.category || 'pan',
  isFullWrite: async () => false,
  viewingAs: email => email === 'admin@example.org' ? viewedAs : '',
  slackFetch: async (_token, method, body) => {
    if (method === 'conversations.open' || method === 'chat.postMessage') throw Error('Rota messages must use pilotSlack');
    return { ok: true };
  }, pilotSlack: async (_token, key, _label, message) => { sends.push({ key, ...message }); return { pilot: true }; },
  botToken: { value: () => 'mock-token' }, logger: { error: () => {} }
});
const req = (email, data) => ({ email, data });
const one = 'one@example.org', two = 'two@example.org', boss = 'admin@example.org';
const good = async (fn, r) => (await fn(r)).ok;
const denied = async (fn, r) => assert.rejects(() => fn(r));
(async () => {
  const seriesId = 'group-meetings-test';
  await db.collection('eventSeries').doc(seriesId).set({ id: seriesId, kind: 'editions', page: 'group-meetings.html', title: 'Group meetings', inviteGroup: 'none', hidden: false, visibleTo: 'internal', organisers: [boss] });
  await db.collection('groupMeetingSeasons').doc('test-season').set({ label: 'Test season', publicationState: 'published' });
  const meeting = (date, format, extra = {}) => db.collection('events').doc(seriesId + '-' + date).set({ slug: seriesId + '-' + date, series: seriesId, page: 'group-meetings.html', date, startDate: date, endDate: date, seasonId: 'test-season', format, status: 'scheduled', startTime: '11:00', durationMinutes: 60, hidden: false, visibleTo: 'internal', inviteGroup: 'none', ...extra });
  await db.collection('people').doc('U1').set({ email: one, slackId: 'U1', name: 'One' });
  await db.collection('people').doc('U2').set({ email: two, slackId: 'U2', name: 'Two' });
  await db.collection('people').doc('UA').set({ email: boss, slackId: 'UA', name: 'Admin' });
  await db.collection('members').doc(one).set({ category: 'internal' });
  await db.collection('members').doc(two).set({ category: 'internal' });
  const pan = 'pan@example.org', associate = 'associate@example.org';
  await db.collection('people').doc('UP').set({ email: pan, slackId: 'UP', name: 'Pan' });
  await db.collection('people').doc('US').set({ email: associate, slackId: 'US', name: 'Associate' });
  await db.collection('members').doc(pan).set({ category: 'pan' });
  await db.collection('members').doc(associate).set({ category: 'associate' });
  const dates = ['2099-01-05','2099-01-12','2099-01-19'];
  for (const [i, date] of dates.entries()) await meeting(date, i === 2 ? 'long' : 'short');
  const seed = (id, date, format, who, topic) => db.collection('groupRotaSlots').doc(id).set({ seriesId, meetingId: date, date, slotNumber: 1, format, presenterSlackId: who, topic, projectId: '', slidesUrl: '', outcome: 'unconfirmed', revision: 0, updatedBy: 'migration' });
  await seed('fs1', dates[0], 'short', 'U1', 'First');
  await seed('fs2', dates[1], 'short', 'U2', 'Second');
  await seed('fl1', dates[2], 'long', '', '');
  const visibleSnapshot = await rota.groupRotaSnapshot(req(one, {}));
  assert.equal(visibleSnapshot.meetings.length, 3);
  assert.equal((await rota.groupRotaAccess(req(one, {}))).registered, true);
  assert.equal((await rota.groupRotaSnapshot(req('viewer@example.org', {}))).meetings.length, 3);
  for (const viewer of [pan, associate]) {
    assert.equal((await rota.groupRotaSnapshot(req(viewer, {}))).slots.length, 3);
    assert.equal((await rota.groupRotaAccess(req(viewer, {}))).eligible, false);
    await denied(rota.groupRotaClaim, req(viewer, { slotId: 'fl1' }));
  }
  assert.equal((await rota.groupRotaAccess(req('viewer@example.org', {}))).slackId, '');
  await denied(rota.groupRotaClaim, req('viewer@example.org', { slotId: 'fl1' }));
  await db.collection('events').doc(seriesId + '-' + dates[0]).update({ hidden: true });
  assert.equal((await rota.groupRotaSnapshot(req(one, {}))).slots.some(s => s.id === 'fs1'), false);
  assert.equal((await rota.groupRotaSnapshot(req(boss, {}))).slots.some(s => s.id === 'fs1'), true);
  await db.collection('events').doc(seriesId + '-' + dates[0]).update({ hidden: false });
  await db.collection('eventSeries').doc(seriesId).update({ hidden: true });
  await denied(rota.groupRotaSnapshot, req(one, {}));
  await db.collection('eventSeries').doc(seriesId).update({ hidden: false });
  await denied(rota.groupRotaSetMeetingVisibility, req(one, { date: dates[0], hidden: true }));
  viewedAs = 'internal';
  await denied(rota.groupRotaSetMeetingVisibility, req(boss, { date: dates[0], hidden: true }));
  viewedAs = '';
  await rota.groupRotaSetMeetingVisibility(req(boss, { date: dates[0], hidden: true }));
  assert.equal((await rota.groupRotaSnapshot(req(one, {}))).meetings.some(m => m.date === dates[0]), false);
  assert.equal((await rota.groupRotaSnapshot(req(boss, {}))).meetings.some(m => m.date === dates[0]), true);
  await rota.groupRotaSetMeetingVisibility(req(boss, { date: dates[0], hidden: false }));
  await db.collection('eventSeries').doc(seriesId).update({ hidden: true });
  await denied(rota.groupRotaSetMeetingVisibility, req(boss, { date: dates[0], hidden: false }));
  await db.collection('eventSeries').doc(seriesId).update({ hidden: false });
  assert.equal(await good(rota.groupRotaEdit, req('One@Example.org', { slotId: 'fs1', revision: 0, topic: 'Changed', projectId: '', slidesUrl: 'https://example.org/slides' })), true);
  await denied(rota.groupRotaEdit, req(two, { slotId: 'fs1', revision: 1, topic: 'Wrong owner' }));
  await denied(rota.groupRotaEdit, req(one, { slotId: 'fs1', revision: 0, topic: 'Stale' }));
  await denied(rota.groupRotaEdit, req(one, { slotId: 'fs1', revision: 1, topic: 'Broken project', projectId: 'missing' }));
  const requested = await rota.groupRotaRequestSwap(req(one, { slotId: 'fs1', otherSlotId: 'fs2' }));
  assert.equal(sends.at(-1).key, 'rota-swaps');
  assert.deepEqual(sends.at(-1).emails, [two]);
  assert.equal(sends.at(-1).actionsRequired, true);
  assert.equal(sends.at(-1).suppressPilotInbox, true);
  assert.equal((await db.collection('groupRotaSlots').doc('fs1').get()).data().presenterSlackId, 'U1');
  await assert.rejects(() => rota.slackAction({ user: { id: 'U1' }, actions: [{ action_id: 'rota_swap_confirm', value: requested.id }] }));
  assert.equal(await rota.slackAction({ user: { id: 'U2' }, actions: [{ action_id: 'rota_swap_confirm', value: requested.id }] }), true);
  assert.equal((await db.collection('groupRotaSlots').doc('fs1').get()).data().presenterSlackId, 'U2');
  assert.equal((await db.collection('groupRotaSlots').doc('fs1').get()).data().topic, 'Second');
  assert.equal((await db.collection('groupRotaSlots').doc('fs2').get()).data().presenterSlackId, 'U1');
  assert.equal((await db.collection('groupRotaSlots').doc('fs2').get()).data().slidesUrl, 'https://example.org/slides');
  assert.equal(await rota.slackAction({ user: { id: 'U2' }, actions: [{ action_id: 'rota_swap_confirm', value: requested.id }] }), true);
  const a = await db.collection('groupRotaSlots').doc('fs2').get();
  await good(rota.groupRotaRecuse, req(one, { slotId: 'fs2', revision: a.data().revision, reason: 'Private reason' }));
  const vacated = (await db.collection('groupRotaSlots').doc('fs2').get()).data();
  assert.equal(vacated.presenterSlackId, ''); assert.equal(vacated.topic, ''); assert.equal(vacated.slidesUrl, '');
  const decline = await db.collection('groupRotaDeclines').where('slotId', '==', 'fs2').get();
  assert.equal(decline.docs[0].data().reason, 'Private reason');
  assert.equal(vacated.changeNote, 'Slot opened');
  const claims = await Promise.allSettled([
    rota.groupRotaClaim(req(one, { slotId: 'fl1' })),
    rota.groupRotaClaim(req(two, { slotId: 'fl1' }))
  ]);
  assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(x => x.status === 'rejected').length, 1);
  const firstClaim = (await db.collection('groupRotaSlots').doc('fl1').get()).data();
  assert.equal(firstClaim.topic, ''); assert.equal(firstClaim.slidesUrl, ''); assert.equal(firstClaim.projectId, '');
  await seed('flLegacy', dates[2], 'long', '', '');
  await db.collection('groupRotaSlots').doc('flLegacy').update({ legacyName: 'Unresolved presenter' });
  await denied(rota.groupRotaClaim, req(firstClaim.presenterSlackId === 'U1' ? two : one, { slotId: 'flLegacy' }));
  await seed('fl2', dates[2], 'long', firstClaim.presenterSlackId === 'U1' ? 'U2' : 'U1', 'Other long talk');
  await denied(rota.groupRotaRequestSwap, req(firstClaim.presenterSlackId === 'U1' ? one : two, { slotId: 'fl1', otherSlotId: 'fl2' }));
  await denied(rota.groupRotaRequestSwap, req(two, { slotId: 'fs1', otherSlotId: 'fs2' })); // vacant target
  await seed('fs3', '2099-01-05', 'short', 'U1', 'Third');
  await seed('fs4', '2099-01-12', 'short', 'U2', 'Fourth');
  const stale = await rota.groupRotaRequestSwap(req(one, { slotId: 'fs3', otherSlotId: 'fs4' }));
  await db.collection('groupRotaSlots').doc('fs4').update({ revision: 7, topic: 'Changed meanwhile' });
  await rota.slackAction({ user: { id: 'U2' }, actions: [{ action_id: 'rota_swap_confirm', value: stale.id }] });
  assert.equal((await db.collection('groupRotaSwaps').doc(stale.id).get()).data().status, 'invalidated');
  assert.equal((await db.collection('groupRotaSlots').doc('fs3').get()).data().presenterSlackId, 'U1');
  assert.equal((await db.collection('groupRotaSlots').doc('fs4').get()).data().presenterSlackId, 'U2');
  await meeting('2099-01-26', 'short');
  await seed('shortOpen', '2099-01-26', 'short', '', '');
  const offered = await rota.groupRotaOfferShort(req(boss, { slotId: 'shortOpen', recipientSlackId: 'U2' }));
  assert.equal(sends.at(-1).key, 'rota-offers');
  assert.deepEqual(sends.at(-1).emails, [two]);
  assert.equal(sends.at(-1).suppressPilotInbox, true);
  assert.equal((await db.collection('groupRotaSlots').doc('shortOpen').get()).data().presenterSlackId, '');
  await assert.rejects(() => rota.slackAction({ user: { id: 'U1' }, actions: [{ action_id: 'rota_offer_accept', value: offered.id }] }));
  await rota.slackAction({ user: { id: 'U2' }, actions: [{ action_id: 'rota_offer_accept', value: offered.id }] });
  assert.equal((await db.collection('groupRotaSlots').doc('shortOpen').get()).data().presenterSlackId, 'U2');
  await meeting('2099-02-16', 'short');
  await seed('shortClaim', '2099-02-16', 'short', '', '');
  await seed('shortClaim2', '2099-02-16', 'short', '', '');
  await good(rota.groupRotaClaim, req(one, { slotId: 'shortClaim' }));
  assert.equal((await db.collection('groupRotaSlots').doc('shortClaim').get()).data().presenterSlackId, 'U1');
  await denied(rota.groupRotaClaim, req(one, { slotId: 'shortClaim2' }));
  await denied(rota.groupRotaClaim, req(two, { slotId: 'shortClaim' }));
  await good(rota.groupRotaLeave, req(two, {}));
  await denied(rota.groupRotaClaim, req(two, { slotId: 'shortClaim2' }));
  await good(rota.groupRotaRegister, req(two, {}));
  assert.equal((await rota.groupRotaAccess(req(two, {}))).registered, true);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const london = parts.year + '-' + parts.month + '-' + parts.day;
  const base = new Date(london + 'T12:00:00Z'); base.setUTCDate(base.getUTCDate() + 7);
  const reminderDate = base.toISOString().slice(0,10);
  await meeting(reminderDate, 'long');
  await seed('reminderSlot', reminderDate, 'long', 'U1', 'Reminder topic');
  await db.collection('groupRotaConfig').doc('current').set({ reminderChannelId: 'C1', remindersEnabled: true });
  const before = sends.length;
  await rota.groupRotaReminder(); await rota.groupRotaReminder();
  assert.equal(sends.length - before, 1);
  assert.equal(sends.at(-1).key, 'rota-reminders');
  assert.match(sends.at(-1).text, /please add slides/);
  await db.collection('groupMeetingSeasons').doc('future').set({ label: 'Future', publicationState: 'published' });
  await denied(rota.groupRotaSaveMeeting, req(one, { date: '2099-02-02', seasonId: 'future', format: 'long', startTime: '11:00', durationMinutes: 60, location: 'Lab' }));
  await rota.groupRotaSaveMeeting(req(boss, { date: '2099-02-02', seasonId: 'future', format: 'long', startTime: '11:00', durationMinutes: 60, location: 'Lab' }));
  assert.equal((await db.collection('events').doc(seriesId + '-2099-02-02').get()).data().inviteGroup, 'none');
  const created = { id: '2099-02-02-slot-1' };
  assert.equal((await db.collection('groupRotaSlots').doc(created.id).get()).data().presenterSlackId, '');
  await denied(rota.groupRotaCreateSlot, req(boss, { date: '2099-02-02', slotNumber: 1 }));
  await denied(rota.groupRotaDeleteMeeting, req(boss, { date: '2099-02-02' }));
  await rota.groupRotaDeleteSlot(req(boss, { slotId: created.id }));
  await rota.groupRotaDeleteMeeting(req(boss, { date: '2099-02-02' }));
  await rota.groupRotaSaveMeeting(req(boss, { date: '2099-02-09', seasonId: 'future', format: 'short', startTime: '11:00', durationMinutes: 60, location: 'Lab' }));
  const shortSlots = await db.collection('groupRotaSlots').where('meetingId', '==', '2099-02-09').get();
  assert.deepEqual(shortSlots.docs.map(d => d.data().slotNumber).sort(), [1, 2, 3]);
  await db.collection('members').doc(two).update({ category: 'associate' });
  assert.equal((await rota.groupRotaAccess(req(two, {}))).eligible, false);
  await denied(rota.groupRotaClaim, req(two, { slotId: shortSlots.docs[0].id }));
  console.log('Rota callable transactions: ownership, revisions, swap, short offer, recusal privacy, concurrent claim and reminder deduplication passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
