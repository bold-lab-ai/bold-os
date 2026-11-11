'use strict';

// Private relationships are returned only by this callable, never by a public roster query.
module.exports = function({ db, onCall, onDocumentCreated, HttpsError, signedInEmail, access, isFullWrite, viewingAs, numberFor, deliver, SITE_URL }) {
  const fail = (code, text) => { throw new HttpsError(code, text); };
  const lower = value => String(value || '').trim().toLowerCase();
  const validEmail = value => /^[^/@\s]+@[^/\s]+\.[^/\s]+$/.test(value);
  const rows = snap => snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  const roster = () => db.collection('peerAmbassadors').where('active', '==', true).get();
  async function ambassador(email) {
    if (viewingAs(email)) return false;
    return !!(await db.doc('peerAmbassadors/' + email).get()).data()?.active;
  }
  async function tell(to, text, source) {
    // No details about a member's request leave the private page.
    await deliver(to, { text, href: SITE_URL + 'peer-support.html', feature: 'peer-support', source, ping: false });
  }
  async function createRequest(email, source) {
    const ref = db.doc('peerBuddyRequests/' + email);
    const number = await numberFor(ref.path);
    return db.runTransaction(async tx => {
      const old = await tx.get(ref);
      if (old.exists && old.data().status !== 'closed') return false;
      tx.set(ref, { memberEmail: email, ambassadorEmail: '', status: 'pending', source, number, notificationPending: true, at: Date.now(), updatedAt: Date.now() });
      return true;
    });
  }
  async function handle(request) {
    const email = lower(signedInEmail(request)), d = request.data || {}, action = d.action || 'load';
    await access.requireAccess(email, 'peer-support', ['load', 'directory'].includes(action) ? 'view' : 'edit');
    const isAmbassador = await ambassador(email);
    if (action === 'directory') return { ambassadors: rows(await roster()).map(({ name, bio, slackId }) => ({ name, bio, slackId })) };
    if (action === 'load') {
      const [people, content, mine, application, staff] = await Promise.all([
        roster(), db.doc('peerSupportContent/main').get(), db.doc('peerBuddyRequests/' + email).get(),
        db.doc('peerApplications/' + email).get(), isFullWrite(email),
      ]);
      const out = { ambassadors: rows(people), content: content.data() || {}, mine: mine.data() || null,
        application: application.data() || null, isAmbassador, canBootstrap: staff && people.empty };
      if (isAmbassador) {
        const [queue, applications, members] = await Promise.all([
          db.collection('peerBuddyRequests').get(), db.collection('peerApplications').get(), db.collection('members').get(),
        ]);
        out.requests = rows(queue); out.applications = rows(applications);
        out.members = members.docs.map(m => ({ email: m.id, name: m.data().name || m.id }));
      }
      return out;
    }
    if (action === 'request') {
      const created = await createRequest(email, 'requested');
      if (created && d.notify === true) {
        await tell((await roster()).docs.map(a => a.id), 'A peer support request is waiting in the ambassador console.', 'peerBuddyRequests/' + email);
        await db.doc('peerBuddyRequests/' + email).update({ notificationPending: false });
      }
      return { created };
    }
    if (action === 'apply') {
      const ref = db.doc('peerApplications/' + email), number = await numberFor(ref.path);
      const created = await db.runTransaction(async tx => {
        const old = await tx.get(ref);
        if (old.exists && old.data().status === 'pending') return false;
        if (isAmbassador) fail('failed-precondition', 'You are already an ambassador.');
        tx.set(ref, { email, name: String(request.auth.token.name || '').slice(0, 160), status: 'pending', notificationPending: true, number, at: Date.now() });
        return true;
      });
      if (created && d.notify === true) { await tell((await roster()).docs.map(a => a.id), 'An ambassador application is waiting in the console.', ref.path); await ref.update({ notificationPending: false }); }
      return { created };
    }
    if (action === 'bootstrap') {
      if (!(await isFullWrite(email)) || !(await roster()).empty) fail('permission-denied', 'Only staff can appoint the first ambassador.');
      const target = lower(d.email);
      if (!validEmail(target)) fail('invalid-argument', 'Choose a member.');
      const member = await db.doc('members/' + target).get();
      if (!member.exists) fail('not-found', 'That member is not registered.');
      // A single lock prevents two simultaneous bootstrap requests.
      await db.runTransaction(async tx => {
        const lock = await tx.get(db.doc('peerSupportContent/bootstrap'));
        if (lock.exists) fail('failed-precondition', 'The first ambassador has already been appointed.');
        tx.set(db.doc('peerAmbassadors/' + target), { name: member.data().name || target, bio: '', slackId: '', active: true, notifyNewJoiners: false });
        tx.set(db.doc('peerSupportContent/bootstrap'), { at: Date.now() });
      });
      return { ok: true };
    }
    if (action === 'notifyRequest' || action === 'notifyApplication') {
      const ref = db.doc((action === 'notifyRequest' ? 'peerBuddyRequests/' : 'peerApplications/') + email);
      const q = await ref.get();
      if (!q.exists || q.data().status !== 'pending' || !q.data().notificationPending) return { ok: true };
      if (d.notify !== true) fail('failed-precondition', 'Confirm the notification first.');
      await tell((await roster()).docs.map(a => a.id), 'A peer support request is waiting in the ambassador console.', ref.path);
      await ref.update({ notificationPending: false });
      return { ok: true };
    }
    if (action === 'accept' || action === 'close') {
      await db.runTransaction(async tx => {
        const ref = db.doc('peerBuddyRequests/' + email), snap = await tx.get(ref);
        if (!snap.exists) fail('not-found', 'No buddy request.');
        if (action === 'accept' && snap.data().status !== 'offered') fail('failed-precondition', 'There is no buddy offer to accept.');
        tx.update(ref, { status: action === 'accept' ? 'active' : 'closed', updatedAt: Date.now() });
      });
      return { ok: true };
    }
    if (!isAmbassador) fail('permission-denied', 'Only peer support ambassadors can do this.');
    if (action === 'content') {
      const body = String(d.body || '').trim(), formUrl = String(d.formUrl || '').trim();
      if (body.length > 10000 || (formUrl && !/^https:\/\/[^\s]+$/.test(formUrl))) fail('invalid-argument', 'Use a short description and an HTTPS form link.');
      await db.doc('peerSupportContent/main').set({ body, formUrl, updatedBy: email });
      return { ok: true };
    }
    if (action === 'profile') {
      const people = await db.collection('people').where('email', '==', email).limit(1).get();
      const person = people.docs[0]?.data() || {};
      await db.doc('peerAmbassadors/' + email).update({ name: String(person.name || request.auth.token.name || email).slice(0, 160),
        slackId: person.slackId || '', bio: String(d.bio || '').slice(0, 2000), notifyNewJoiners: d.notifyNewJoiners === true });
      return { ok: true };
    }
    const target = lower(d.email);
    if (!validEmail(target)) fail('invalid-argument', 'Choose a member.');
    if (action === 'approveApplication') {
      if (target === email) fail('permission-denied', 'Another ambassador must review your application.');
      await db.runTransaction(async tx => {
        const ref = db.doc('peerApplications/' + target), app = await tx.get(ref);
        if (!app.exists || app.data().status !== 'pending') fail('failed-precondition', 'This application is not pending.');
        tx.set(db.doc('peerAmbassadors/' + target), { name: app.data().name || target, bio: '', slackId: '', active: true, notifyNewJoiners: false });
        tx.update(ref, { status: 'approved', decidedBy: email, decidedAt: Date.now() });
      });
      return { ok: true };
    }
    if (action === 'offer') {
      const buddy = lower(d.ambassadorEmail);
      if (!validEmail(buddy) || buddy === target) fail('invalid-argument', 'Choose a different ambassador.');
      if (d.conflictsChecked !== true) fail('failed-precondition', 'Check for active supervision and research collaboration before offering a buddy.');
      const workspaces = await db.collection('projectWorkspaces').where('members', 'array-contains', target).get();
      if (workspaces.docs.some(w => !w.data().completedAt && (w.data().members || []).includes(buddy))) fail('failed-precondition', 'Choose someone outside their current research projects.');
      await db.runTransaction(async tx => {
        const ref = db.doc('peerBuddyRequests/' + target);
        const [q, a, studies] = await Promise.all([tx.get(ref), tx.get(db.doc('peerAmbassadors/' + buddy)), tx.get(db.doc('studies/' + target))]);
        if (!q.exists || q.data().status !== 'pending') fail('failed-precondition', 'This request is no longer waiting for a match.');
        if (!a.exists || !a.data().active) fail('failed-precondition', 'Choose an active ambassador.');
        if ((studies.data()?.people || []).some(p => lower(p.email) === buddy)) fail('failed-precondition', 'Choose someone outside their supervision group.');
        tx.update(ref, { ambassadorEmail: buddy, status: 'offered', offeredBy: email, notificationPending: true, updatedAt: Date.now() });
      });
      if (d.notify === true) { await tell([target, buddy], 'Your peer support buddy arrangement has an update.', 'peerBuddyRequests/' + target); await db.doc('peerBuddyRequests/' + target).update({ notificationPending: false }); }
      return { ok: true };
    }
    if (action === 'notifyOffer') {
      const ref = db.doc('peerBuddyRequests/' + target), q = await ref.get();
      if (!q.exists || q.data().status !== 'offered' || !q.data().notificationPending) return { ok: true };
      if (d.notify !== true) fail('failed-precondition', 'Confirm the notification first.');
      await tell([target, q.data().ambassadorEmail], 'Your peer support buddy arrangement has an update.', ref.path);
      await ref.update({ notificationPending: false });
      return { ok: true };
    }
    fail('invalid-argument', 'Unknown peer support action.');
  }
  return {
    peerSupport: onCall(handle),
    onPeerMemberJoined: onDocumentCreated('members/{email}', async event => {
      const email = lower(event.params.email);
      if (!validEmail(email) || !event.data) return;
      if (await createRequest(email, 'new-member')) {
        const to = (await roster()).docs.filter(d => d.data().notifyNewJoiners === true).map(d => d.id);
        await tell(to, 'A new member is waiting for a buddy offer in the ambassador console.', 'peerBuddyRequests/' + email);
      }
    }),
    handle,
  };
};
