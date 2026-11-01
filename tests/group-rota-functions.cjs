const assert = require('node:assert/strict');
const admin = require('../functions/node_modules/firebase-admin');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
admin.initializeApp({ projectId: 'demo-test' });
const db = admin.firestore();
const sends = [];
const rota = require('../functions/group-rota')({
  db, admin, HttpsError, onCall: (opts, fn) => fn || opts, onSchedule: (opts, fn) => fn,
  signedInEmail: r => r.email,
  requireAccess: async () => {},
  rolesEmails: async role => role === 'admins' ? ['admin@example.org'] : [],
  slackFetch: async (_token, method, body) => {
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D1' } };
    if (method === 'chat.postMessage') { sends.push(body); return { ok: true, channel: body.channel, ts: String(sends.length) }; }
    return { ok: true };
  }, botToken: { value: () => 'mock-token' }, logger: { error: () => {} }
});
const req = (email, data) => ({ email, data });
const one = 'one@example.org', two = 'two@example.org', boss = 'admin@example.org';
const good = async (fn, r) => (await fn(r)).ok;
const denied = async (fn, r) => assert.rejects(() => fn(r));
(async () => {
  await db.collection('people').doc('U1').set({ email: one, slackId: 'U1', name: 'One' });
  await db.collection('people').doc('U2').set({ email: two, slackId: 'U2', name: 'Two' });
  await db.collection('people').doc('UA').set({ email: boss, slackId: 'UA', name: 'Admin' });
  for (const id of ['U1','U2']) {
    await db.collection('groupRotaEligibility').doc(id).set({ eligible: true });
    await db.collection('groupRotaMembers').doc(id).set({ active: true, category: 'phd' });
  }
  const dates = ['2099-01-05','2099-01-12','2099-01-19'];
  for (const [i, date] of dates.entries()) await db.collection('groupMeetings').doc(date).set({ date, format: i === 2 ? 'long' : 'short', status: 'scheduled', startTime: '11:00', durationMinutes: 60 });
  const seed = (id, date, format, who, topic) => db.collection('groupRotaSlots').doc(id).set({ meetingId: date, date, slotNumber: 1, format, presenterSlackId: who, topic, projectId: '', slidesUrl: '', outcome: 'unconfirmed', revision: 0, updatedBy: 'migration' });
  await seed('fs1', dates[0], 'short', 'U1', 'First');
  await seed('fs2', dates[1], 'short', 'U2', 'Second');
  await seed('fl1', dates[2], 'long', '', '');
  assert.equal(await good(rota.groupRotaEdit, req('One@Example.org', { slotId: 'fs1', revision: 0, topic: 'Changed', projectId: '', slidesUrl: 'https://example.org/slides' })), true);
  await denied(rota.groupRotaEdit, req(two, { slotId: 'fs1', revision: 1, topic: 'Wrong owner' }));
  await denied(rota.groupRotaEdit, req(one, { slotId: 'fs1', revision: 0, topic: 'Stale' }));
  await denied(rota.groupRotaEdit, req(one, { slotId: 'fs1', revision: 1, topic: 'Broken project', projectId: 'missing' }));
  const requested = await rota.groupRotaRequestSwap(req(one, { slotId: 'fs1', otherSlotId: 'fs2' }));
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
  await db.collection('groupMeetings').doc('2099-01-26').set({ date: '2099-01-26', format: 'short', status: 'scheduled', startTime: '11:00' });
  await seed('shortOpen', '2099-01-26', 'short', '', '');
  const offered = await rota.groupRotaOfferShort(req(boss, { slotId: 'shortOpen', recipientSlackId: 'U2' }));
  assert.equal((await db.collection('groupRotaSlots').doc('shortOpen').get()).data().presenterSlackId, '');
  await assert.rejects(() => rota.slackAction({ user: { id: 'U1' }, actions: [{ action_id: 'rota_offer_accept', value: offered.id }] }));
  await rota.slackAction({ user: { id: 'U2' }, actions: [{ action_id: 'rota_offer_accept', value: offered.id }] });
  assert.equal((await db.collection('groupRotaSlots').doc('shortOpen').get()).data().presenterSlackId, 'U2');
  await db.collection('groupMeetings').doc('2099-02-16').set({ date: '2099-02-16', format: 'short', status: 'scheduled', startTime: '11:00' });
  await seed('shortClaim', '2099-02-16', 'short', '', '');
  await seed('shortClaim2', '2099-02-16', 'short', '', '');
  await good(rota.groupRotaClaim, req(one, { slotId: 'shortClaim' }));
  assert.equal((await db.collection('groupRotaSlots').doc('shortClaim').get()).data().presenterSlackId, 'U1');
  await denied(rota.groupRotaClaim, req(one, { slotId: 'shortClaim2' }));
  await denied(rota.groupRotaClaim, req(two, { slotId: 'shortClaim' }));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const london = parts.year + '-' + parts.month + '-' + parts.day;
  const base = new Date(london + 'T12:00:00Z'); base.setUTCDate(base.getUTCDate() + 7);
  const reminderDate = base.toISOString().slice(0,10);
  await db.collection('groupMeetings').doc(reminderDate).set({ date: reminderDate, format: 'long', status: 'scheduled', startTime: '11:00' });
  await seed('reminderSlot', reminderDate, 'long', 'U1', 'Reminder topic');
  await db.collection('groupRotaConfig').doc('current').set({ reminderChannelId: 'C1', remindersEnabled: true });
  const before = sends.length;
  await rota.groupRotaReminder(); await rota.groupRotaReminder();
  assert.equal(sends.length - before, 1);
  assert.match(sends.at(-1).text, /please add slides/);
  await db.collection('groupMeetingSeasons').doc('future').set({ label: 'Future', publicationState: 'published' });
  await rota.groupRotaSaveMeeting(req(boss, { date: '2099-02-02', seasonId: 'future', format: 'long', startTime: '11:00', durationMinutes: 60, location: 'Lab' }));
  const created = { id: '2099-02-02-slot-1' };
  assert.equal((await db.collection('groupRotaSlots').doc(created.id).get()).data().presenterSlackId, '');
  await denied(rota.groupRotaCreateSlot, req(boss, { date: '2099-02-02', slotNumber: 1 }));
  await denied(rota.groupRotaDeleteMeeting, req(boss, { date: '2099-02-02' }));
  await rota.groupRotaDeleteSlot(req(boss, { slotId: created.id }));
  await rota.groupRotaDeleteMeeting(req(boss, { date: '2099-02-02' }));
  await rota.groupRotaSaveMeeting(req(boss, { date: '2099-02-09', seasonId: 'future', format: 'short', startTime: '11:00', durationMinutes: 60, location: 'Lab' }));
  const shortSlots = await db.collection('groupRotaSlots').where('meetingId', '==', '2099-02-09').get();
  assert.deepEqual(shortSlots.docs.map(d => d.data().slotNumber).sort(), [1, 2, 3]);
  console.log('Rota callable transactions: ownership, revisions, swap, short offer, recusal privacy, concurrent claim and reminder deduplication passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
