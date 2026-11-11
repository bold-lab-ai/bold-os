'use strict';

// All published assignments are explicit documents. No roster sync or seed
// calculation writes to a slot. The caller supplies the Firebase auth context;
// every mutation below checks the linked Slack identity again on the server.
module.exports = function rota({ db, admin, HttpsError, onCall, onSchedule, signedInEmail,
  rolesEmails, requireAccess, seesEvent, slackFetch, pilotSlack, botToken, logger }) {
  const slots = db.collection('groupRotaSlots');
  const meetings = db.collection('events');
  const swaps = db.collection('groupRotaSwaps');
  const offers = db.collection('groupRotaOffers');
  const notifications = db.collection('groupRotaNotifications');
  const baseUrl = 'https://bold-lab-ai.github.io/bold-os/group-meetings.html';
  const error = (code, message) => { throw new HttpsError(code, message); };
  const now = () => Date.now();
  const iso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const url = s => typeof s === 'string' && s.length <= 2000 && (!s || /^https:\/\/[^\s]+$/i.test(s));
  const link = s => baseUrl + '?date=' + encodeURIComponent(s.meetingId || s.date) + '&slot=' + encodeURIComponent(s.slotNumber);
  const londonNow = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  };
  const upcoming = m => m && !m.hidden && m.status !== 'skipped' && iso(m.date) && (m.date + 'T' + (m.startTime || '00:00')) > londonNow();
  const clean = value => String(value || '').trim();
  const slotRef = id => { if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id || ''))) error('invalid-argument', 'Invalid slot.'); return slots.doc(id); };
  async function rotaSeries() {
    const found = await db.collection('eventSeries').where('page', '==', 'group-meetings.html').limit(2).get();
    if (found.size !== 1) error('failed-precondition', 'The group meeting event series is not configured.');
    const doc = found.docs[0], series = doc.data();
    if (series.kind !== 'editions' || series.inviteGroup !== 'none') error('failed-precondition', 'The group meeting series must use editions without invitations.');
    return { id: doc.id, ...series };
  }
  const meetingRef = (seriesId, date) => meetings.doc(seriesId + '-' + date);
  async function recipientEmail(slackId) {
    const person = await db.collection('people').doc(slackId).get();
    const email = person.exists && clean(person.data().email).toLowerCase();
    if (!email) error('failed-precondition', 'The recipient is not in the BOLD.OS roster.');
    return email;
  }
  async function actor(request, requireIdentity = true) {
    const email = signedInEmail(request).toLowerCase();
    await requireAccess(email, 'events', 'view');
    const series = await rotaSeries();
    const roster = await db.collection('people').get();
    const matches = roster.docs.filter(d => String(d.data().email || '').toLowerCase() === email);
    if (requireIdentity && (matches.length !== 1 || !matches[0].data().slackId)) error('failed-precondition', 'Your Slack account is not uniquely matched in the roster.');
    const slackId = matches.length === 1 ? matches[0].data().slackId || '' : '';
    const [member, eligible, admins, pis] = await Promise.all([
      slackId ? db.collection('groupRotaMembers').doc(slackId).get() : null,
      slackId ? db.collection('groupRotaEligibility').doc(slackId).get() : null, rolesEmails('admins'), rolesEmails('pis')
    ]);
    const adminRole = admins.concat(pis).map(x => String(x).toLowerCase()).includes(email) || (series.organisers || []).includes(email);
    if (!adminRole && (series.hidden || !(await seesEvent(email, series)))) error('permission-denied', 'The group meeting series is not visible to you.');
    return { email, slackId, registered: !!member && member.exists && member.data().active === true,
      eligible: !!eligible && eligible.exists && eligible.data().eligible === true, seriesId: series.id, series,
      admin: adminRole, canSeeDrafts: adminRole,
      people: roster.docs.map(d => ({ slackId: d.id, name: d.data().name || '' })) };
  }
  const requirePresenter = a => { if (!a.registered || !a.eligible) error('permission-denied', 'An active eligible rota registration is required.'); };
  const requireAdmin = a => { if (!a.admin) error('permission-denied', 'Only a rota administrator can do this.'); };
  const packageOf = s => ({ presenterSlackId: s.presenterSlackId || '', legacyMemberId: s.legacyMemberId || '', legacyName: s.legacyName || '', topic: s.topic || '', projectId: s.projectId || '', slidesUrl: s.slidesUrl || '' });
  const sameFormat = (a, b) => a.format && a.format === b.format;
  const pending = s => !!s.pendingActionId;
  function stamp(a, note) { return { updatedBy: a.email, updatedAt: now(), changeNote: note }; }
  async function details(request) {
    const a = await actor(request); const data = request.data || {};
    const ref = slotRef(data.slotId); const topic = clean(data.topic), projectId = clean(data.projectId), slidesUrl = clean(data.slidesUrl);
    if (topic.length > 140 || projectId.length > 100 || !url(slidesUrl)) error('invalid-argument', 'Check the topic, project and HTTPS slides URL.');
    if (projectId) {
      const ws = await db.collection('projectWorkspaces').doc(projectId).get();
      if (!ws.exists) error('invalid-argument', 'That project is unavailable.');
      const members = (ws.data().members || []).map(x => String(x).toLowerCase());
      if (!a.admin && !members.includes(a.email)) error('permission-denied', 'You can link only your own team’s project.');
    }
    await db.runTransaction(async tx => {
      const s = await tx.get(ref); if (!s.exists) error('not-found', 'Slot not found.');
      const v = s.data(); if (v.seriesId !== a.seriesId) error('not-found', 'Slot not found.');
      if (v.presenterSlackId !== a.slackId && !a.admin) error('permission-denied', 'This is another presenter’s slot.');
      const correction = a.admin && v.presenterSlackId !== a.slackId;
      const auditNote = clean(data.auditNote);
      if (correction && (!auditNote || auditNote.length > 300)) error('invalid-argument', 'An administrator correction needs an audit note (up to 300 characters).');
      if (v.revision !== data.revision || pending(v)) error('aborted', 'This slot changed. Reload it first.');
      tx.update(ref, { topic, projectId, slidesUrl, revision: v.revision + 1, ...stamp(a, correction ? 'Administrator correction: ' + auditNote : 'Talk details updated') });
    });
    return { ok: true };
  }
  async function claim(request) {
    const a = await actor(request); requirePresenter(a);
    const ref = slotRef(request.data && request.data.slotId);
    await db.runTransaction(async tx => {
      const s = await tx.get(ref); if (!s.exists) error('not-found', 'Slot not found.');
      const v = s.data(), m = await tx.get(meetingRef(a.seriesId, v.meetingId));
      const peers = await tx.get(slots.where('meetingId', '==', v.meetingId));
      if (v.seriesId !== a.seriesId || !m.exists || !upcoming(m.data()) || !['short', 'long'].includes(v.format) || v.presenterSlackId || v.legacyMemberId || v.legacyName || pending(v)) error('failed-precondition', 'This slot is not open for claims.');
      if (peers.docs.some(d => d.data().presenterSlackId === a.slackId)) error('failed-precondition', 'You already present at this meeting.');
      tx.update(ref, { presenterSlackId: a.slackId, legacyMemberId: '', legacyName: '', topic: '', projectId: '', slidesUrl: '', outcome: 'unconfirmed', revision: v.revision + 1, ...stamp(a, 'Open slot claimed') });
    });
    return { ok: true };
  }
  async function recuse(request) {
    const a = await actor(request), d = request.data || {}, reason = clean(d.reason);
    if (!reason || reason.length > 2000) error('invalid-argument', 'Give a reason (up to 2,000 characters).');
    const ref = slotRef(d.slotId), declineRef = db.collection('groupRotaDeclines').doc();
    await db.runTransaction(async tx => {
      const s = await tx.get(ref); if (!s.exists) error('not-found', 'Slot not found.');
      const v = s.data(), m = await tx.get(meetingRef(a.seriesId, v.meetingId));
      if (v.seriesId !== a.seriesId || v.presenterSlackId !== a.slackId) error('permission-denied', 'This is not your assigned slot.');
      if (!m.exists || !upcoming(m.data()) || v.revision !== d.revision || pending(v)) error('aborted', 'This slot cannot be declined now. Reload it first.');
      tx.create(declineRef, { bySlackId: a.slackId, byEmail: a.email, slotId: ref.id, original: packageOf(v), reason, at: now(), resolution: 'open' });
      tx.update(ref, { presenterSlackId: '', legacyMemberId: '', legacyName: '', topic: '', projectId: '', slidesUrl: '', outcome: 'unconfirmed', revision: v.revision + 1, ...stamp(a, 'Slot opened') });
    });
    return { ok: true };
  }
  async function requestSwap(request) {
    const a = await actor(request); requirePresenter(a);
    const d = request.data || {}, first = slotRef(d.slotId), second = slotRef(d.otherSlotId);
    if (first.id === second.id) error('invalid-argument', 'Choose another slot.');
    const swapRef = swaps.doc(); const expiresAt = now() + 7 * 86400000;
    await db.runTransaction(async tx => {
      const [left, right] = await Promise.all([tx.get(first), tx.get(second)]);
      if (!left.exists || !right.exists) error('not-found', 'Slot not found.');
      const x = left.data(), y = right.data();
      const [mx, my, ey, ry] = await Promise.all([tx.get(meetingRef(a.seriesId, x.meetingId)), tx.get(meetingRef(a.seriesId, y.meetingId)), tx.get(db.collection('groupRotaEligibility').doc(y.presenterSlackId || '_')), tx.get(db.collection('groupRotaMembers').doc(y.presenterSlackId || '_'))]);
      if (x.seriesId !== a.seriesId || y.seriesId !== a.seriesId || x.presenterSlackId !== a.slackId || !y.presenterSlackId || y.presenterSlackId === a.slackId || !ey.exists || ey.data().eligible !== true || !ry.exists || ry.data().active !== true || !sameFormat(x, y) || x.format !== 'short' || pending(x) || pending(y) || !mx.exists || !my.exists || !upcoming(mx.data()) || !upcoming(my.data())) error('failed-precondition', 'These short slots cannot be swapped.');
      const deadline = Math.min(expiresAt, Date.parse(mx.data().date + 'T00:00:00Z'), Date.parse(my.data().date + 'T00:00:00Z'));
      tx.create(swapRef, { slotId: first.id, otherSlotId: second.id, slotRevision: x.revision, otherRevision: y.revision, requesterSlackId: a.slackId, recipientSlackId: y.presenterSlackId, createdAt: now(), expiresAt: deadline, status: 'pending', notificationState: 'queued' });
      tx.update(first, { pendingActionId: swapRef.id }); tx.update(second, { pendingActionId: swapRef.id });
    });
    return { id: swapRef.id, notificationState: 'queued' };
  }
  async function finishSwap(id, decision, bySlackId) {
    const series = await rotaSeries();
    const ref = swaps.doc(id); let result = 'unchanged';
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists) error('not-found', 'Swap not found.');
      const s = snap.data();
      if (s.recipientSlackId !== bySlackId && !(decision === 'cancelled' && s.requesterSlackId === bySlackId)) error('permission-denied', 'This request is for someone else.');
      if (s.status !== 'pending') { result = s.status; return; }
      const lref = slotRef(s.slotId), rref = slotRef(s.otherSlotId);
      const [left, right] = await Promise.all([tx.get(lref), tx.get(rref)]);
      const x = left.data(), y = right.data();
      if (!x || !y) error('failed-precondition', 'A slot is missing.');
      const [mx, my, ex, ey] = await Promise.all([tx.get(meetingRef(series.id, x.meetingId)), tx.get(meetingRef(series.id, y.meetingId)), tx.get(db.collection('groupRotaEligibility').doc(s.requesterSlackId)), tx.get(db.collection('groupRotaEligibility').doc(s.recipientSlackId))]);
      const valid = x.seriesId === series.id && y.seriesId === series.id && x.revision === s.slotRevision && y.revision === s.otherRevision && x.pendingActionId === id && y.pendingActionId === id && x.presenterSlackId === s.requesterSlackId && y.presenterSlackId === s.recipientSlackId && mx.exists && my.exists && upcoming(mx.data()) && upcoming(my.data()) && ex.exists && ey.exists && ex.data().eligible === true && ey.data().eligible === true && now() < s.expiresAt;
      result = valid ? decision : now() >= s.expiresAt ? 'expired' : 'invalidated';
      if (result === 'confirmed') {
        tx.update(lref, { ...packageOf(y), revision: x.revision + 1, pendingActionId: '', updatedBy: 'slack:' + bySlackId, updatedAt: now(), changeNote: 'Swap confirmed' });
        tx.update(rref, { ...packageOf(x), revision: y.revision + 1, pendingActionId: '', updatedBy: 'slack:' + bySlackId, updatedAt: now(), changeNote: 'Swap confirmed' });
      } else {
        if (x.pendingActionId === id) tx.update(lref, { pendingActionId: '' });
        if (y.pendingActionId === id) tx.update(rref, { pendingActionId: '' });
      }
      tx.update(ref, { status: result, decidedAt: now(), decidedBySlackId: bySlackId });
    });
    return { status: result };
  }
  async function cancelSwap(request) { const a = await actor(request); return finishSwap(String(request.data && request.data.id || ''), 'cancelled', a.slackId); }
  async function outcome(request) {
    const a = await actor(request); requireAdmin(a); const d = request.data || {};
    if (!['unconfirmed', 'presented', 'did-not-present'].includes(d.outcome)) error('invalid-argument', 'Invalid outcome.');
    const ref = slotRef(d.slotId);
    await db.runTransaction(async tx => {
      const s = await tx.get(ref); if (!s.exists) error('not-found', 'Slot not found.');
      const v = s.data(), m = await tx.get(meetingRef(a.seriesId, v.meetingId));
      if (v.seriesId !== a.seriesId || !m.exists || m.data().status === 'skipped' || upcoming(m.data()) || v.revision !== d.revision) error('failed-precondition', 'This meeting has not finished or the slot changed.');
      tx.update(ref, { outcome: d.outcome, revision: v.revision + 1, ...stamp(a, 'Presentation outcome updated') });
    }); return { ok: true };
  }
  async function offerShort(request) {
    const a = await actor(request); requireAdmin(a);
    const d = request.data || {}, recipient = clean(d.recipientSlackId), ref = slotRef(d.slotId), offerRef = offers.doc();
    if (!/^U[A-Z0-9]+$/.test(recipient)) error('invalid-argument', 'Choose a presenter.');
    await db.runTransaction(async tx => {
      const [snap, eligible, member] = await Promise.all([tx.get(ref), tx.get(db.collection('groupRotaEligibility').doc(recipient)), tx.get(db.collection('groupRotaMembers').doc(recipient))]);
      if (!snap.exists) error('not-found', 'Slot not found.');
      const s = snap.data(), [m, peers] = await Promise.all([tx.get(meetingRef(a.seriesId, s.meetingId)), tx.get(slots.where('meetingId', '==', s.meetingId))]);
      if (s.seriesId !== a.seriesId || !m.exists || !upcoming(m.data()) || s.format !== 'short' || s.presenterSlackId || pending(s) || !eligible.exists || eligible.data().eligible !== true || !member.exists || member.data().active !== true || peers.docs.some(x => x.data().presenterSlackId === recipient)) error('failed-precondition', 'This vacancy cannot be offered to that presenter.');
      tx.create(offerRef, { slotId: ref.id, expectedRevision: s.revision, recipientSlackId: recipient, offeredBy: a.email, createdAt: now(), expiresAt: Math.min(now() + 7 * 86400000, Date.parse(s.date + 'T00:00:00Z')), status: 'pending', notificationState: 'queued' });
      tx.update(ref, { pendingActionId: offerRef.id });
    });
    await sendOffer(offerRef.id, botToken.value());
    return { id: offerRef.id };
  }
  async function finishOffer(id, decision, bySlackId) {
    const series = await rotaSeries();
    const ref = offers.doc(id); let status = 'unchanged';
    await db.runTransaction(async tx => {
      const oSnap = await tx.get(ref); if (!oSnap.exists) error('not-found', 'Offer not found.');
      const o = oSnap.data(); if (o.recipientSlackId !== bySlackId) error('permission-denied', 'This offer is for someone else.');
      if (o.status !== 'pending') { status = o.status; return; }
      const sRef = slotRef(o.slotId), [sSnap, eligible, member] = await Promise.all([tx.get(sRef), tx.get(db.collection('groupRotaEligibility').doc(bySlackId)), tx.get(db.collection('groupRotaMembers').doc(bySlackId))]);
      const s = sSnap.data(); if (!s) error('failed-precondition', 'Slot missing.');
      const [m, peers] = await Promise.all([tx.get(meetingRef(series.id, s.meetingId)), tx.get(slots.where('meetingId', '==', s.meetingId))]);
      const valid = s.seriesId === series.id && s.revision === o.expectedRevision && s.pendingActionId === id && !s.presenterSlackId && s.format === 'short' && m.exists && upcoming(m.data()) && eligible.exists && eligible.data().eligible === true && member.exists && member.data().active === true && !peers.docs.some(x => x.data().presenterSlackId === bySlackId) && now() < o.expiresAt;
      status = valid ? decision : now() >= o.expiresAt ? 'expired' : 'invalidated';
      if (status === 'accepted') tx.update(sRef, { presenterSlackId: bySlackId, legacyMemberId: '', legacyName: '', revision: s.revision + 1, pendingActionId: '', updatedBy: 'slack:' + bySlackId, updatedAt: now(), changeNote: 'Open short slot accepted' });
      else if (s.pendingActionId === id) tx.update(sRef, { pendingActionId: '' });
      tx.update(ref, { status, decidedAt: now(), decidedBySlackId: bySlackId });
    });
    return { status };
  }
  async function sendOffer(id, token) {
    const o = (await offers.doc(id).get()).data(); if (!o || o.status !== 'pending') return;
    const nref = notifications.doc('offer-' + id);
    const reserved = await db.runTransaction(async tx => { const n = await tx.get(nref); if (n.exists) return false; tx.create(nref, { kind: 'offer', offerId: id, status: 'sending', at: now() }); return true; });
    if (!reserved) return;
    try {
      const s = (await slots.doc(o.slotId).get()).data();
      const sent = await pilotSlack(token, 'rota-offers', 'Group meeting short-slot offers', { emails: [await recipientEmail(o.recipientSlackId)], actionsRequired: true, requireDelivery: true,
        text: 'A group meeting short slot is available for you.', blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'A short group meeting slot on ' + s.date + ' is offered to you. <' + link(s) + '|Review the slot>.' } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Accept' }, action_id: 'rota_offer_accept', value: id },
          { type: 'button', text: { type: 'plain_text', text: 'Decline' }, action_id: 'rota_offer_decline', value: id }
        ] }
      ] });
      const state = sent.pilot ? 'pilot' : 'sent';
      await nref.update({ status: state, at: now() }); await offers.doc(id).update({ notificationState: state });
    } catch (e) { await nref.update({ status: 'uncertain', error: String(e).slice(0,300), at: now() }); await offers.doc(id).update({ notificationState: 'uncertain' }); logger.error('Rota offer delivery uncertain', { id, error: String(e) }); }
  }
  async function saveMeeting(request) {
    const a = await actor(request); requireAdmin(a); const d = request.data || {}, date = clean(d.date);
    if (!iso(date) || !['short', 'long'].includes(d.format) || !/^\d{2}:\d{2}$/.test(d.startTime || '') || !Number.isInteger(d.durationMinutes) || d.durationMinutes < 15 || d.durationMinutes > 480 || !clean(d.seasonId) || clean(d.location).length > 200) error('invalid-argument', 'Check the meeting details.');
    const ref = meetingRef(a.seriesId, date), [old, season, assigned] = await Promise.all([ref.get(), db.collection('groupMeetingSeasons').doc(clean(d.seasonId)).get(), slots.where('meetingId', '==', date).limit(1).get()]);
    if (!season.exists || season.data().publicationState !== 'published') error('failed-precondition', 'Publish the season first.');
    if (!assigned.empty && old.exists && old.data().format !== d.format) error('failed-precondition', 'A meeting with published slots cannot change format.');
    const meeting = { date, startDate: date, endDate: date, seasonId: clean(d.seasonId), format: d.format, timeZone: 'Europe/London', startTime: d.startTime, durationMinutes: d.durationMinutes, location: clean(d.location), place: clean(d.location), status: old.exists ? old.data().status || 'scheduled' : 'scheduled', origin: old.exists ? old.data().origin || 'import' : 'site', ...stamp(a, 'Meeting details updated') };
    if (old.exists) await ref.set(meeting, { merge: true });
    else {
      const batch = db.batch();
      batch.create(ref, { ...meeting, slug: ref.id, series: a.seriesId, title: a.series.title || 'Group meetings', description: a.series.description || '', page: 'group-meetings.html', hidden: !!a.series.hidden, visibleTo: a.series.visibleTo || 'internal', inviteGroup: 'none', createdAt: now(), createdBy: a.email });
      const count = d.format === 'long' ? 1 : 3;
      for (let number = 1; number <= count; number++) {
        batch.create(slots.doc(date + '-slot-' + number), { seriesId: a.seriesId, meetingId: date, date, slotNumber: number, format: d.format, presenterSlackId: '', legacyMemberId: '', legacyName: '', topic: '', projectId: '', slidesUrl: '', outcome: 'unconfirmed', revision: 0, origin: 'site', createdAt: now(), ...stamp(a, 'Open slot created') });
      }
      await batch.commit();
    }
    return { ok: true };
  }
  async function createSlot(request) {
    const a = await actor(request); requireAdmin(a); const d = request.data || {}, date = clean(d.date), number = Number(d.slotNumber);
    if (!iso(date) || !Number.isInteger(number) || number < 1 || number > 3) error('invalid-argument', 'Invalid meeting or slot number.');
    const mRef = meetingRef(a.seriesId, date), id = date + '-slot-' + number, ref = slots.doc(id);
    await db.runTransaction(async tx => {
      const [m, s] = await Promise.all([tx.get(mRef), tx.get(ref)]);
      if (!m.exists || !upcoming(m.data()) || m.data().status !== 'scheduled' || (m.data().format === 'long' && number !== 1)) error('failed-precondition', 'This meeting cannot take that slot.');
      if (s.exists) error('already-exists', 'That slot already exists.');
      tx.create(ref, { seriesId: a.seriesId, meetingId: date, date, slotNumber: number, format: m.data().format, presenterSlackId: '', legacyMemberId: '', legacyName: '', topic: '', projectId: '', slidesUrl: '', outcome: 'unconfirmed', revision: 0, origin: 'site', createdAt: now(), ...stamp(a, 'Open slot created') });
    });
    return { id };
  }
  async function deleteSlot(request) {
    const a = await actor(request); requireAdmin(a); const ref = slotRef(request.data && request.data.slotId);
    await db.runTransaction(async tx => {
      const s = await tx.get(ref); if (!s.exists) error('not-found', 'Slot not found.');
      const v = s.data();
      if (v.seriesId !== a.seriesId || v.origin !== 'site' || v.revision !== 0 || v.presenterSlackId || v.legacyMemberId || pending(v)) error('failed-precondition', 'Only a newly created, untouched open slot can be removed.');
      tx.delete(ref);
    }); return { ok: true };
  }
  async function deleteMeeting(request) {
    const a = await actor(request); requireAdmin(a); const date = clean(request.data && request.data.date);
    if (!iso(date)) error('invalid-argument', 'Invalid date.');
    const ref = meetingRef(a.seriesId, date);
    await db.runTransaction(async tx => {
      const [m, existing] = await Promise.all([tx.get(ref), tx.get(slots.where('meetingId', '==', date).limit(1))]);
      if (!m.exists || m.data().origin !== 'site' || !existing.empty) error('failed-precondition', 'Only a new meeting without slots can be removed.');
      tx.delete(ref);
    }); return { ok: true };
  }
  async function setMeetingVisibility(request) {
    const a = await actor(request); requireAdmin(a);
    const d = request.data || {}, date = clean(d.date);
    if (!iso(date) || typeof d.hidden !== 'boolean') error('invalid-argument', 'Choose a meeting and visibility.');
    if (!d.hidden && a.series.hidden) error('failed-precondition', 'Release the event series first.');
    const ref = meetingRef(a.seriesId, date), snap = await ref.get();
    if (!snap.exists) error('not-found', 'Meeting not found.');
    await ref.update({ hidden: d.hidden, ...stamp(a, d.hidden ? 'Meeting hidden' : 'Meeting released') });
    return { ok: true };
  }
  async function saveSeason(request) {
    const a = await actor(request); requireAdmin(a); const d = request.data || {}, id = clean(d.id);
    const state = clean(d.publicationState) || 'draft';
    if (!/^[a-z0-9-]{1,64}$/.test(id) || !clean(d.label) || clean(d.label).length > 120 || clean(d.rotationDescription).length > 2000 || !['draft', 'published'].includes(state)) error('invalid-argument', 'Check the season details.');
    if (state === 'draft' && (await meetings.where('series', '==', a.seriesId).get()).docs.some(doc => doc.data().seasonId === id)) error('failed-precondition', 'A season with published meetings cannot become a draft.');
    await db.collection('groupMeetingSeasons').doc(id).set({ label: clean(d.label), regularTime: clean(d.regularTime), location: clean(d.location), rotationDescription: clean(d.rotationDescription), publicationState: state, ...stamp(a, 'Season details updated') }, { merge: true });
    return { ok: true };
  }
  async function access(request) {
    let a;
    try { a = await actor(request, false); }
    catch (e) {
      signedInEmail(request);
      return { slackId: '', registered: false, eligible: false, admin: false, reason: 'Your Slack account is not uniquely matched in the roster', swaps: [] };
    }
    const ownSwaps = await swaps.where('requesterSlackId', '==', a.slackId).get();
    const offeredSwaps = await swaps.where('recipientSlackId', '==', a.slackId).get();
    const [assigned, registered] = await Promise.all([slots.get(), db.collection('groupRotaMembers').get()]);
    const visibleIds = new Set(assigned.docs.map(d => d.data().presenterSlackId).concat(registered.docs.filter(d => d.data().active).map(d => d.id)));
    return { slackId: a.slackId, seriesId: a.seriesId, seriesHidden: !!a.series.hidden, registered: a.registered, eligible: a.eligible, admin: a.admin, canSeeDrafts: a.canSeeDrafts,
      people: a.people.filter(p => visibleIds.has(p.slackId)),
      reason: !a.slackId ? 'Your Slack account is not uniquely matched in the roster' : !a.registered ? 'Join the rota to use this action' : !a.eligible ? 'Eligibility has not been confirmed' : '',
      swaps: [...ownSwaps.docs, ...offeredSwaps.docs].filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i).map(s => ({ id: s.id, ...s.data() })) };
  }
  async function snapshot(request) {
    const a = await actor(request, false);
    const pick = (id, data, keys) => Object.fromEntries([['id', id], ...keys.filter(key => data[key] !== undefined).map(key => [key, data[key]])]);
    const [eventDocs, slotDocs, memberDocs, seasonDocs] = await Promise.all([
      meetings.where('series', '==', a.seriesId).get(), slots.get(),
      db.collection('groupRotaMembers').get(), db.collection('groupMeetingSeasons').get()
    ]);
    const published = new Set(seasonDocs.docs.filter(doc => a.admin || doc.data().publicationState === 'published').map(doc => doc.id));
    const visible = [];
    for (const doc of eventDocs.docs) {
      const m = doc.data();
      if (published.has(m.seasonId) && (a.admin || !m.hidden && await seesEvent(a.email, m))) visible.push(pick(doc.id, m,
        ['date', 'seasonId', 'format', 'startTime', 'durationMinutes', 'timeZone', 'location', 'status', 'skipReason', 'origin', 'hidden']));
    }
    const dates = new Set(visible.map(m => m.date));
    return {
      meetings: visible,
      slots: slotDocs.docs.filter(doc => doc.data().seriesId === a.seriesId && dates.has(doc.data().meetingId)).map(doc => pick(doc.id, doc.data(),
        ['meetingId', 'date', 'slotNumber', 'format', 'presenterSlackId', 'legacyMemberId', 'legacyName', 'topic', 'slidesUrl', 'projectId', 'outcome', 'revision', 'pendingActionId', 'origin'])),
      members: memberDocs.docs.map(doc => pick(doc.id, doc.data(), ['active', 'category', 'legacyMemberId'])),
      seasons: seasonDocs.docs.filter(doc => published.has(doc.id)).map(doc => pick(doc.id, doc.data(), ['label', 'regularTime', 'location', 'rotationDescription', 'publicationState']))
    };
  }
  async function register(request) {
    const a = await actor(request); if (!a.eligible) error('permission-denied', 'Eligibility has not been confirmed.');
    const category = clean(request.data && request.data.category);
    if (!['phd', 'masters', 'postdoc', 'associate'].includes(category)) error('invalid-argument', 'Choose a category.');
    await db.collection('groupRotaMembers').doc(a.slackId).set({ active: true, category, updatedAt: now(), updatedBy: a.email }, { merge: true });
    return { ok: true };
  }
  async function leave(request) {
    const a = await actor(request);
    await db.collection('groupRotaMembers').doc(a.slackId).set({ active: false, updatedAt: now(), updatedBy: a.email }, { merge: true });
    return { ok: true };
  }
  async function slackCommand(body) {
    if (body.command !== '/rota' || !body.user_id) return null;
    if (body.team_id !== 'T0B7DUVFEM8') return 'This command is available only in the BOLD Slack workspace.';
    const person = await db.collection('people').doc(body.user_id).get();
    if (!person.exists) return 'Your Slack account is not yet in the BOLD.OS roster.';
    const parts = clean(body.text).toLowerCase().split(/\s+/);
    if (parts[0] === 'leave') {
      await db.collection('groupRotaMembers').doc(body.user_id).set({ active: false, updatedAt: now(), updatedBy: 'slack:' + body.user_id }, { merge: true });
      return 'You have left future rota registration. Published assignments are unchanged.';
    }
    if (parts[0] !== 'join' || !['phd', 'masters', 'postdoc', 'associate'].includes(parts[1])) return 'Use `/rota join phd|masters|postdoc|associate` or `/rota leave`.';
    const e = await db.collection('groupRotaEligibility').doc(body.user_id).get();
    if (!e.exists || e.data().eligible !== true) return 'Your bold-associates eligibility is not confirmed. Ask a rota organiser.';
    await db.collection('groupRotaMembers').doc(body.user_id).set({ active: true, category: parts[1], updatedAt: now(), updatedBy: 'slack:' + body.user_id }, { merge: true });
    return 'You are registered. Existing assignments have not changed.';
  }
  async function sendSwap(id, token) {
    const ref = swaps.doc(id), snap = await ref.get(); if (!snap.exists || snap.data().status !== 'pending') return;
    const s = snap.data(); const nref = notifications.doc('swap-' + id);
    const reserved = await db.runTransaction(async tx => {
      const n = await tx.get(nref);
      if (n.exists && ['sending', 'sent', 'pilot', 'uncertain'].includes(n.data().status)) return false;
      tx.set(nref, { kind: 'swap', swapId: id, status: 'sending', at: now() }); return true;
    });
    if (!reserved) return;
    try {
      const [left, right] = await Promise.all([slots.doc(s.slotId).get(), slots.doc(s.otherSlotId).get()]);
      if (!left.exists || !right.exists) throw Error('A slot is missing');
      const a = left.data(), b = right.data();
      const result = await pilotSlack(token, 'rota-swaps', 'Group meeting slot swap requests', { emails: [await recipientEmail(s.recipientSlackId)], actionsRequired: true, requireDelivery: true,
        text: 'Group meeting swap: please confirm or decline.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '<@' + s.requesterSlackId + '> requests a group meeting swap: ' + a.date + ' (' + a.format + ') for ' + b.date + ' (' + b.format + '). Review the <' + baseUrl + '|rota> before deciding.' } },
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Confirm' }, action_id: 'rota_swap_confirm', value: id },
            { type: 'button', text: { type: 'plain_text', text: 'Decline' }, action_id: 'rota_swap_decline', value: id }
          ] }
        ] });
      const state = result.pilot ? 'pilot' : 'sent';
      await nref.set({ status: state, at: now() }, { merge: true });
      await ref.update({ notificationState: state });
    } catch (e) {
      // Slack may have accepted a request before its response was lost. Inspect
      // this record before a manual retry rather than blindly posting twice.
      const state = 'uncertain';
      await nref.set({ status: state, error: String(e).slice(0, 300), at: now() }, { merge: true });
      await ref.update({ notificationState: state }); logger.error('Rota swap delivery ' + state, { id, error: String(e) });
    }
  }
  async function retrySwap(request) {
    const a = await actor(request), id = clean(request.data && request.data.id);
    const snap = await swaps.doc(id).get();
    if (!snap.exists || snap.data().status !== 'pending') error('failed-precondition', 'This request is no longer pending.');
    if (snap.data().requesterSlackId !== a.slackId && !a.admin) error('permission-denied', 'This is another presenter’s request.');
    if (snap.data().notificationState !== 'failed') error('failed-precondition', 'Inspect uncertain deliveries before retrying.');
    await sendSwap(id, botToken.value());
    return { notificationState: (await swaps.doc(id).get()).data().notificationState };
  }
  async function slackAction(payload) {
    const action = (payload.actions || [])[0];
    if (!action) return false;
    if (['rota_offer_accept', 'rota_offer_decline'].includes(action.action_id)) {
      await finishOffer(String(action.value || ''), action.action_id === 'rota_offer_accept' ? 'accepted' : 'declined', payload.user && payload.user.id);
      return true;
    }
    if (!['rota_swap_confirm', 'rota_swap_decline'].includes(action.action_id)) return false;
    await finishSwap(String(action.value || ''), action.action_id === 'rota_swap_confirm' ? 'confirmed' : 'declined', payload.user && payload.user.id);
    return true;
  }
  async function remind(token) {
    const series = await rotaSeries();
    if (series.hidden) return;
    const configSnap = await db.collection('groupRotaConfig').doc('current').get();
    const config = configSnap.exists ? configSnap.data() : {};
    if (!config.reminderChannelId || !config.remindersEnabled) return;
    const london = londonNow().slice(0, 10);
    const target = new Date(london + 'T12:00:00Z'); target.setUTCDate(target.getUTCDate() + 7);
    const date = target.toISOString().slice(0, 10), m = await meetingRef(series.id, date).get();
    if (!m.exists || m.data().hidden || m.data().status !== 'scheduled') return;
    const rows = await slots.where('meetingId', '==', date).get();
    const lines = rows.docs.map(d => d.data()).sort((a,b) => a.slotNumber - b.slotNumber).map(s => s.presenterSlackId
      ? '<@' + s.presenterSlackId + '> — ' + (s.topic || 'Topic to come') + (s.slidesUrl ? '' : ' · please add slides: ' + link(s))
      : 'Open ' + s.format + ' slot: ' + link(s));
    const ref = notifications.doc('reminder-' + date + '-' + config.reminderChannelId);
    const reserved = await db.runTransaction(async tx => {
      const old = await tx.get(ref); if (old.exists) return false;
      tx.create(ref, { kind: 'reminder', date, channel: config.reminderChannelId, status: 'sending', at: now() }); return true;
    });
    if (!reserved) return;
    try {
      const posted = await pilotSlack(token, 'rota-reminders', 'Group meeting rota reminders', { channel: config.reminderChannelId, requireDelivery: true, text: 'Next Monday’s group meeting (' + date + ')\n' + lines.join('\n') + '\n' + baseUrl });
      await ref.update({ status: posted.pilot ? 'pilot' : 'sent', at: now() });
    } catch (e) { await ref.update({ status: 'uncertain', error: String(e).slice(0,300), at: now() }); logger.error('Rota reminder uncertain', { date, error: String(e) }); }
  }
  async function syncEligibility(token) {
    const snap = await db.collection('groupRotaConfig').doc('current').get();
    const id = snap.exists && snap.data().eligibilityUserGroupId;
    if (!id) return; // The actual stable user-group ID must be configured first.
    const result = await slackFetch(token, 'usergroups.users.list', { usergroup: id });
    if (!result.ok || !Array.isArray(result.users)) { logger.error('Rota eligibility refresh failed', { error: result.error }); return; }
    const [assigned, members, roster] = await Promise.all([slots.get(), db.collection('groupRotaMembers').get(), db.collection('people').get()]);
    const ids = new Set([...assigned.docs.map(d => d.data().presenterSlackId), ...members.docs.map(d => d.id)].filter(Boolean));
    const list = new Set(result.users), activeRoster = new Set(roster.docs.map(d => d.data().slackId));
    const all = [...ids];
    for (let i = 0; i < all.length; i += 400) {
      const batch = db.batch();
      all.slice(i, i + 400).forEach(slackId => batch.set(db.collection('groupRotaEligibility').doc(slackId), { eligible: list.has(slackId) && activeRoster.has(slackId), sourceGroupId: id, checkedAt: now() }));
      await batch.commit();
    }
  }
  return {
    groupRotaAccess: onCall(access), groupRotaSnapshot: onCall(snapshot), groupRotaRegister: onCall(register), groupRotaLeave: onCall(leave),
    groupRotaEdit: onCall(details), groupRotaClaim: onCall(claim), groupRotaRecuse: onCall(recuse),
    groupRotaRequestSwap: onCall({ secrets: [botToken] }, async request => { const result = await requestSwap(request); await sendSwap(result.id, botToken.value()); return { id: result.id, notificationState: (await swaps.doc(result.id).get()).data().notificationState }; }),
    groupRotaRetrySwap: onCall({ secrets: [botToken] }, retrySwap),
    groupRotaCancelSwap: onCall(cancelSwap), groupRotaOutcome: onCall(outcome),
    groupRotaOfferShort: onCall({ secrets: [botToken] }, offerShort),
    groupRotaSaveMeeting: onCall(saveMeeting), groupRotaSaveSeason: onCall(saveSeason),
    groupRotaSetMeetingVisibility: onCall(setMeetingVisibility),
    groupRotaCreateSlot: onCall(createSlot), groupRotaDeleteSlot: onCall(deleteSlot), groupRotaDeleteMeeting: onCall(deleteMeeting),
    groupRotaReminder: onSchedule({ schedule: '0 14 * * 1', timeZone: 'Europe/London', secrets: [botToken] }, async () => remind(botToken.value())),
    groupRotaEligibilitySync: onSchedule({ schedule: '0 7 * * *', timeZone: 'Europe/London', secrets: [botToken] }, async () => syncEligibility(botToken.value())),
    groupRotaExpireSwaps: onSchedule({ schedule: 'every 30 minutes', timeZone: 'Europe/London' }, async () => {
      const due = await swaps.where('status', '==', 'pending').where('expiresAt', '<=', now()).get();
      for (const s of due.docs) await finishSwap(s.id, 'expired', s.data().recipientSlackId);
      const oldOffers = await offers.where('status', '==', 'pending').where('expiresAt', '<=', now()).get();
      for (const o of oldOffers.docs) await finishOffer(o.id, 'expired', o.data().recipientSlackId);
    }),
    slackAction, slackCommand, _internal: { upcoming, sameFormat, packageOf, url }
  };
};
