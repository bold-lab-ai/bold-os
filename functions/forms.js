'use strict';

const crypto = require('node:crypto');
const GROUPS = ['pan', 'associate', 'internal', 'staff', 'exec'];
const DAY = 86400000;
const lower = x => String(x || '').trim().toLowerCase();
const list = x => Array.isArray(x) ? [...new Set(x.map(lower))] : [];
const emailValid = x => /^[^/@\s]+@[^/\s]+\.[^/\s]+$/.test(x);

function normalizeForm(input, creator) {
  const d = input || {}, title = String(d.title || '').trim(), description = String(d.description || '').trim();
  if (!title || title.length > 160 || description.length > 5000) throw new Error('Give a title of at most 160 characters and a short description.');
  const owners = [...new Set([creator, ...list(d.owners)])], targetEmails = list(d.targetEmails), targetGroups = list(d.targetGroups);
  if (owners.length > 20 || targetEmails.length > 500 || !owners.concat(targetEmails).every(emailValid)) throw new Error('Use valid member email addresses; at most 20 owners and 500 recipients.');
  if (targetGroups.some(g => !GROUPS.includes(g))) throw new Error('Choose valid BOLD groups.');
  if (!Array.isArray(d.questions) || !d.questions.length || d.questions.length > 30) throw new Error('Add between 1 and 30 questions.');
  const ids = new Set();
  const questions = d.questions.map((q, i) => {
    const id = String(q.id || 'q' + (i + 1)), label = String(q.label || '').trim(), type = q.type || 'text';
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id) || !label || label.length > 500 || !['text', 'choice', 'scale'].includes(type)) throw new Error('Each question needs a unique id, a label, and a supported type.');
    ids.add(id);
    const options = type === 'choice' ? [...new Set((q.options || []).map(o => String(o).trim()))] : [];
    if (type === 'choice' && (options.length < 2 || options.length > 15 || options.some(o => !o || o.length > 200))) throw new Error('Choice questions need 2–15 distinct options.');
    return { id, label, type, required: q.required === true, options };
  });
  return { title, description, owners, targetEmails, targetGroups, questions, reminders: d.reminders === true, notifyOwners: d.notifyOwners === true };
}
function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Provide your answers.');
  if (Object.keys(answers).some(k => !questions.some(q => q.id === k))) throw new Error('The form has changed. Reload it before submitting.');
  const out = {};
  for (const q of questions) {
    const value = answers[q.id] == null ? '' : String(answers[q.id]).trim();
    if (q.required && !value) throw new Error('Answer “' + q.label + '”.');
    if (value.length > 5000 || (value && q.type === 'choice' && !q.options.includes(value)) || (value && q.type === 'scale' && !/^[1-5]$/.test(value))) throw new Error('Check your answer to “' + q.label + '”.');
    out[q.id] = value;
  }
  return out;
}

module.exports = function({ db, onCall, onSchedule, HttpsError, signedInEmail, access, deliver, SITE_URL }) {
  const fail = (c, m) => { throw new HttpsError(c, m); };
  const formRef = id => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''))) fail('invalid-argument', 'Choose a form.');
    return db.doc('forms/' + id);
  };
  const check = fn => { try { return fn(); } catch(e) { fail('invalid-argument', e.message); } };
  const owner = (f, email) => (f.owners || []).includes(email);
  const target = (f, email) => (f.recipientEmails || []).includes(email);
  function requireOwner(f, email){ if (!owner(f, email)) fail('permission-denied', 'Only this form’s owners can manage it.'); }
  const publicForm = f => ({ title: f.title, description: f.description, questions: f.questions, status: f.status, reminders: f.reminders });
  async function tell(emails, id, text) {
    await deliver(emails, { text, href: SITE_URL + 'forms.html?id=' + id, feature: 'forms', source: 'forms/' + id, ping: false });
  }
  async function handle(request) {
    const email = lower(signedInEmail(request)), d = request.data || {}, action = d.action || 'list';
    await access.requireAccess(email, 'forms', ['list', 'get', 'people'].includes(action) ? 'view' : 'edit');
    if (action === 'people') {
      await access.requireAccess(email, 'forms', 'edit');
      const s = await db.collection('members').get();
      return { people: s.docs.map(p => ({ email: p.id, name: p.data().name || p.id, category: p.data().category || 'pan' })) };
    }
    if (action === 'list') {
      const [mine, assigned] = await Promise.all([
        db.collection('forms').where('owners', 'array-contains', email).get(),
        db.collection('forms').where('recipientEmails', 'array-contains', email).get(),
      ]);
      const byId = new Map(); mine.docs.concat(assigned.docs).forEach(s => byId.set(s.id, s.data()));
      return { forms: [...byId].map(([id, f]) => ({ id, title: f.title, status: f.status, owner: owner(f, email) })) };
    }
    if (action === 'create' || action === 'save') {
      const ref = action === 'create' ? db.collection('forms').doc() : formRef(d.id);
      await db.runTransaction(async tx => {
        const old = await tx.get(ref), f = old.data();
        if (action === 'save') {
          if (!old.exists) fail('not-found', 'No such form.');
          requireOwner(f, email);
          if (f.status !== 'draft') fail('failed-precondition', 'Published questions and recipients are fixed. Create a new form to change them.');
          if (d.revision !== f.revision) fail('aborted', 'Another owner edited this form. Reload before saving.');
        }
        const normalized = check(() => normalizeForm(d.form, f ? f.createdBy : email));
        if (normalized.owners.some(e => !(d.confirmOwners === true) && !(f ? f.owners : [email]).includes(e))) fail('failed-precondition', 'Confirm who will be able to edit the form and read responses.');
        const members = await Promise.all(normalized.owners.concat(normalized.targetEmails).map(e => tx.get(db.doc('members/' + e))));
        if (members.some(m => !m.exists)) fail('invalid-argument', 'Owners and recipients must be registered members.');
        tx.set(ref, Object.assign(normalized, { status: 'draft', createdBy: f ? f.createdBy : email, revision: (f?.revision || 0) + 1,
          responseCount: 0, recipientEmails: [], invitationsPending: false }));
      });
      return { id: ref.id };
    }
    const ref = formRef(d.id);
    if (action === 'get') {
      const snap = await ref.get(); if (!snap.exists) fail('not-found', 'No such form.');
      const f = snap.data(), isOwner = owner(f, email), isTarget = target(f, email);
      if (!isOwner && !isTarget) fail('permission-denied', 'This form is not addressed to you.');
      const receipt = await ref.collection('completion').doc(email).get();
      const out = { id: ref.id, form: publicForm(f), owner: isOwner, targeted: isTarget, submitted: receipt.exists };
      if (receipt.exists) {
        const response = await ref.collection('responses').doc(receipt.data().responseId).get();
        out.myResponse = response.data() || null;
      }
      if (isOwner) {
        out.form = Object.assign({}, f);
        // No completion list, response timestamps or answer-to-recipient linkage leaves the server.
        out.responses = (await ref.collection('responses').get()).docs.map(r => ({ answers: r.data().answers, identity: r.data().identity || null }));
      }
      return out;
    }
    if (action === 'publish') {
      if (d.confirmPublish !== true) fail('failed-precondition', 'Confirm the recipients and reminder schedule before publishing.');
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref); if (!snap.exists) fail('not-found', 'No such form.');
        const f = snap.data(); requireOwner(f, email);
        if (f.status !== 'draft' || d.revision !== f.revision) fail('failed-precondition', 'Reload the current draft before publishing.');
        const members = await tx.get(db.collection('members'));
        const recipients = members.docs.filter(m => f.targetEmails.includes(m.id) || f.targetGroups.includes(m.data().category || 'pan')).map(m => m.id);
        if (!recipients.length || recipients.length > 500) fail('invalid-argument', 'Choose between 1 and 500 recipients.');
        tx.update(ref, { recipientEmails: recipients, status: 'open', invitationsPending: true, openedAt: Date.now(), revision: f.revision + 1 });
      });
      if (d.notify === true) {
        const f = (await ref.get()).data();
        await tell(f.recipientEmails, ref.id, 'A form is available for you in BOLD.OS.');
        await ref.update({ invitationsPending: false });
      }
      return { id: ref.id };
    }
    if (action === 'invite' || action === 'close') {
      const snap = await ref.get(); if (!snap.exists) fail('not-found', 'No such form.');
      const f = snap.data(); requireOwner(f, email);
      if (action === 'close') { await ref.update({ status: 'closed', reminders: false }); return { id: ref.id }; }
      if (f.status !== 'open' || !f.invitationsPending) fail('failed-precondition', 'There are no invitations waiting.');
      if (d.notify !== true) fail('failed-precondition', 'Confirm the notifications first.');
      await tell(f.recipientEmails, ref.id, 'A form is available for you in BOLD.OS.');
      await ref.update({ invitationsPending: false }); return { id: ref.id };
    }
    if (action === 'submit') {
      const response = ref.collection('responses').doc(crypto.randomUUID()), receipt = ref.collection('completion').doc(email);
      await db.runTransaction(async tx => {
        const [snap, old] = await Promise.all([tx.get(ref), tx.get(receipt)]);
        if (!snap.exists) fail('not-found', 'No such form.');
        const f = snap.data();
        if (!target(f, email)) fail('permission-denied', 'This form is not addressed to you.');
        if (old.exists) fail('already-exists', 'You have already submitted this form.');
        if (f.status !== 'open') fail('failed-precondition', 'This form is closed.');
        if (d.identify === true && d.confirmIdentity !== true) fail('failed-precondition', 'Confirm that you want the owners to see your identity.');
        const answers = check(() => validateAnswers(f.questions, d.answers));
        tx.create(response, { answers, identity: d.identify === true ? { name: String(request.auth.token.name || '').slice(0, 160), email } : null });
        tx.create(receipt, { responseId: response.id });
        tx.update(ref, { responseCount: f.responseCount + 1 });
      });
      return { id: ref.id, submitted: true };
    }
    if (action === 'reveal') {
      if (d.confirmIdentity !== true) fail('failed-precondition', 'Confirm that you want the owners to see your identity.');
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref), receipt = await tx.get(ref.collection('completion').doc(email));
        if (!snap.exists || !receipt.exists) fail('not-found', 'You have not submitted this form.');
        tx.update(ref.collection('responses').doc(receipt.data().responseId), { identity: { name: String(request.auth.token.name || '').slice(0, 160), email } });
      });
      return { id: ref.id, identified: true };
    }
    fail('invalid-argument', 'Unknown forms action.');
  }
  async function reminders() {
    const now = Date.now(), open = await db.collection('forms').where('status', '==', 'open').get();
    for (const snap of open.docs) {
      const f = snap.data();
      if (f.reminders && now - f.openedAt >= 7 * DAY) for (const email of f.recipientEmails) {
        const claim = snap.ref.collection('reminders').doc(email);
        const send = await db.runTransaction(async tx => {
          const [current, completed, last] = await Promise.all([tx.get(snap.ref), tx.get(snap.ref.collection('completion').doc(email)), tx.get(claim)]);
          if (current.data()?.status !== 'open' || !current.data()?.reminders || completed.exists || now - (last.data()?.at || 0) < 7 * DAY) return false;
          tx.set(claim, { at: now }); return true;
        });
        if (send) await tell([email], snap.id, 'A form is waiting for your response. Weekly reminders stop after you submit.');
      }
      if (f.notifyOwners && f.responseCount > (f.lastDigestCount || 0)) {
        const send = await db.runTransaction(async tx => {
          const current = (await tx.get(snap.ref)).data();
          if (!current || current.status !== 'open' || now - (current.lastDigestAt || 0) < DAY || current.responseCount <= (current.lastDigestCount || 0)) return false;
          tx.update(snap.ref, { lastDigestAt: now, lastDigestCount: current.responseCount }); return true;
        });
        if (send) await tell(f.owners, snap.id, 'Your form has new responses. Open BOLD.OS to review them.');
      }
    }
  }
  return { forms: onCall(handle), remindForms: onSchedule('every 24 hours', reminders), handle, reminders };
};
module.exports.normalizeForm = normalizeForm;
module.exports.validateAnswers = validateAnswers;
