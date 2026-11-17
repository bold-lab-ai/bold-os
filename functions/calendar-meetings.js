'use strict';

// Calendar meetings: existing-link listings stay local; confirmed new meetings use the injected Google adapter.
// Public projections never contain a channel, people, email addresses or meeting link.
const crypto = require('crypto');
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const lower = (v) => String(v || '').trim().toLowerCase();
function channelId(value){
  const v = String(value || '').trim();
  if (/^[CG][A-Z0-9]{8,}$/.test(v)) return v;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || !(u.hostname === 'app.slack.com' || /^[a-z0-9-]+\.slack\.com$/.test(u.hostname))) return '';
    const m = /^\/archives\/([CG][A-Z0-9]{8,})(?:\/|$)/.exec(u.pathname) || /^\/client\/T[A-Z0-9]+\/([CG][A-Z0-9]{8,})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}
function validDate(v){ return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v; }
function normalize(d){
  const title = String(d.title || '').trim(), firstDate = String(d.firstDate || ''), until = String(d.until || '');
  const time = String(d.time || ''), minutes = Number(d.minutes), every = Number(d.every);
  const mode = d.mode || 'existing', category = d.category || 'supervision';
  if (!['existing', 'create'].includes(mode) || !['project', 'supervision', 'other'].includes(category)) throw new Error('Choose a valid meeting type and category.');
  const link = mode === 'existing' ? String(d.link || '').trim() : '';
  if (!title || title.length > 120) throw new Error('Give a title of up to 120 characters.');
  if (!validDate(firstDate) || (until && (!validDate(until) || until < firstDate))) throw new Error('Choose valid first and end dates, with the end on or after the first.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a start time in London time.');
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240 || minutes % 15) throw new Error('Choose a duration from 15 minutes to 4 hours, in 15-minute steps.');
  if (![1, 2, 3, 4].includes(every)) throw new Error('Choose every 1–4 weeks.');
  let u; try { u = new URL(link); } catch (_) {}
  if (mode === 'existing' && (!u || u.protocol !== 'https:' || u.username || u.password || /[\s<>"\u0000-\u001f]/.test(link) || link.length > 500)) throw new Error('Add an HTTPS meeting link.');
  const ids = Array.from(new Set(Array.isArray(d.participantIds) ? d.participantIds : []));
  if (!ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('Choose between 1 and 100 BOLD.OS participants.');
  const manualIds = Array.from(new Set(Array.isArray(d.manualIds) ? d.manualIds : [])).filter((id) => ids.includes(id));
  return { title, firstDate, mode, category, inviteGuests: mode === 'create' && d.inviteGuests === true, meeting: { day: DAYS[new Date(firstDate + 'T12:00:00Z').getUTCDay()], time, minutes, every, ...(until ? { until } : {}) }, link: u ? u.href : '', participantIds: ids, manualIds };
}
function publicView(s){ return { id: s.id, title: s.title, firstDate: s.firstDate, meeting: s.meeting, version: s.version, mode: s.mode || 'existing', category: s.category || 'supervision', projectId: s.projectId || '', projectTitle: s.projectTitle || '', projectBoard: s.projectBoard || '', calendarState: s.calendarState || 'listed' }; }
function fingerprint(s){ return crypto.createHash('sha256').update(JSON.stringify([s.channelId, s.firstDate, s.meeting.day, s.meeting.time, s.meeting.minutes, s.meeting.every, s.meeting.until || '', s.mode || 'existing', s.mode === 'create' ? '' : s.link])).digest('hex'); }

function createService({ db, access, HttpsError, slack, googleSync, projectChoices = async () => [], now = Date.now }){
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const records = db.collection('calendarMeetings'), publicRecords = db.collection('calendarMeetingEntries'), keys = db.collection('calendarMeetingKeys');
  async function identity(email){
    const ps = await db.collection('people').where('email', '==', lower(email)).limit(1).get();
    if (!ps.docs.length) fail('permission-denied', 'Sign in with your BOLD.OS account first.');
    return ps.docs[0].id;
  }
  async function roster(){
    const snap = await db.collection('people').get();
    return snap.docs.filter((d) => d.data().email && !d.data().is_bot && !d.data().deleted).map((d) => ({ id: d.id, name: d.data().name || 'Unnamed BOLD.OS member' }));
  }
  async function channel(value, userId){
    const id = channelId(value);
    if (!id) fail('invalid-argument', 'Paste a Slack channel link or channel ID.');
    const info = await slack('conversations.info', { channel: id });
    if (!info.ok) fail('failed-precondition', 'BOLD.OS cannot read this channel. Add it with /invite @BOLD OS, then retry.');
    const ch = info.channel || {};
    if (ch.is_im || ch.is_mpim || ch.is_archived || ch.is_ext_shared) fail('invalid-argument', 'Choose an active channel in the BOLD workspace, not a DM or externally shared channel.');
    const ids = []; let cursor = '';
    do {
      const r = await slack('conversations.members', { channel: id, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!r.ok) fail('unavailable', 'Could not verify channel membership. Check that BOLD.OS is in the channel and retry.');
      ids.push(...(r.members || [])); cursor = r.response_metadata && r.response_metadata.next_cursor || '';
    } while (cursor);
    if (!ids.includes(userId)) fail('permission-denied', 'You must be a member of this Slack channel.');
    return { id, name: ch.name || id, memberIds: ids };
  }
  function requireConfirmation(d){ if (d.confirmed !== true) fail('failed-precondition', 'Confirm the Google Calendar changes before continuing.'); }
  function requireUnlocked(s){ if (s.calendarLeaseUntil > now()) fail('aborted', 'Google Calendar is being updated. Wait a moment and refresh.'); }
  function lock(s, operation){ return { ...s, calendarState: 'pending', syncError: '', pendingOperation: operation, syncToken: crypto.randomUUID(), calendarLeaseUntil: now() + 300000 }; }
  async function finishSync(s){
    let result, error = '';
    try {
      if (!googleSync) throw new Error('Google Calendar is not configured.');
      result = await googleSync(s, s.pendingOperation);
    } catch (e) {
      // Keep the entry and stable event ID, including when Google accepted a request but
      // its response was lost. An explicit retry reconciles rather than inserting again.
      error = /preparing the Meet link|cancelled externally/.test(e.message || '') ? e.message : 'Could not finish the Google Calendar update. Refresh and retry; an existing event will not be duplicated.';
    }
    return db.runTransaction(async (tx) => {
      const ref = records.doc(s.id), snap = await tx.get(ref);
      if (!snap.exists || snap.data().syncToken !== s.syncToken) fail('aborted', 'This update was superseded. Refresh the meeting.');
      if (!error && result.removed) { tx.delete(keys.doc(s.fingerprint)); tx.delete(publicRecords.doc(s.id)); tx.delete(ref); return { removed: true }; }
      const saved = { ...snap.data(), ...(!error ? result : {}), calendarLeaseUntil: 0, syncToken: '', calendarState: error ? 'error' : 'ready', syncError: error };
      tx.set(ref, saved); tx.set(publicRecords.doc(s.id), publicView(saved));
      return publicView(saved);
    });
  }
  async function run(email, d){
    const read = ['get', 'list'].includes(d.action);
    await access.requireAccess(email, 'calendar', read ? 'view' : 'edit');
    if (d.action === 'list') return { meetings: (await publicRecords.get()).docs.map((x) => publicView(x.data())) };
    const userId = await identity(email);
    if (d.action === 'projects') return { projects: await projectChoices(email) };
    if (d.action === 'directory') return { people: (await roster()).sort((a, b) => a.name.localeCompare(b.name)) };
    if (d.action === 'channel') {
      const c = await channel(d.channel, userId), people = await roster();
      const members = people.filter((p) => c.memberIds.includes(p.id));
      return { channel: { id: c.id, name: c.name }, people: members, unmatched: c.memberIds.length - members.length };
    }
    if (d.id && !/^[a-zA-Z0-9-]{20,80}$/.test(d.id)) fail('invalid-argument', 'Invalid meeting ID.');
    const ref = records.doc(d.id || crypto.randomUUID());
    const snap = d.id ? await ref.get() : null, old = snap && snap.exists ? snap.data() : null;
    if (['get', 'remove', 'retry'].includes(d.action) && !old) fail('not-found', 'This meeting is no longer listed.');
    if (d.action === 'get') {
      let c, channelError = '';
      try { c = await channel(old.channelId, userId); } catch (e) { channelError = e.code === 'permission-denied' ? 'The meeting link is only available to Slack channel members.' : 'Could not verify Slack membership. Retry to access the meeting link.'; }
      const out = { ...publicView(old), canEdit: !!c && await access.can(email, 'calendar', 'edit'), channelError };
      if (c || old.participantIds.includes(userId)) out.people = (await roster()).filter((p) => old.participantIds.includes(p.id));
      if (c) Object.assign(out, { link: old.link, channel: { id: c.id, name: c.name }, participantIds: old.participantIds, manualIds: old.manualIds, inviteGuests: !!old.inviteGuests, syncError: old.syncError || '', pendingOperation: old.pendingOperation || '', syncing: old.calendarLeaseUntil > now() });
      return out;
    }
    if (!['save', 'remove', 'retry'].includes(d.action)) fail('invalid-argument', 'Unknown action.');
    const c = await channel(old ? old.channelId : d.channel, userId);
    if (old && d.channel && channelId(d.channel) !== old.channelId) fail('invalid-argument', 'The associated channel cannot be changed.');
    if (old && old.mode === 'create' && (d.action === 'retry' || d.action === 'remove')) {
      requireConfirmation(d);
      const locked = await db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (!current.exists || current.data().version !== d.version) fail('aborted', 'This meeting changed. Reopen it first.');
        requireUnlocked(current.data());
        const next = lock({ ...current.data(), version: current.data().version + 1 }, d.action === 'remove' ? 'remove' : current.data().pendingOperation || 'save');
        tx.set(ref, next); tx.set(publicRecords.doc(ref.id), publicView(next)); return next;
      });
      return finishSync(locked);
    }
    if (d.action === 'retry') fail('invalid-argument', 'Existing meeting listings do not need Google Calendar updates.');
    if (d.action === 'remove') {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (!current.exists) return;
        if (current.data().version !== d.version) fail('aborted', 'This meeting changed. Reopen it before removing it.');
        tx.delete(keys.doc(current.data().fingerprint)); tx.delete(publicRecords.doc(ref.id)); tx.delete(ref);
      });
      return { removed: true };
    }
    let n; try { n = normalize(d); } catch (e) { fail('invalid-argument', e.message); }
    if (old && (old.mode || 'existing') !== n.mode) fail('invalid-argument', 'A meeting cannot switch between an existing listing and a Google-managed event.');
    if (n.mode === 'create') {
      requireConfirmation(d);
      if (!old && require('./busy').londonMs(n.firstDate, n.meeting.time) <= now()) fail('invalid-argument', 'Choose a future first meeting.');
    }
    if (n.category === 'project') {
      const project = (await projectChoices(email)).find((p) => p.id === d.projectId);
      if (!project) fail('invalid-argument', 'Choose an existing BOLD.OS project.');
      n.projectId = project.id; n.projectTitle = project.title; n.projectBoard = project.board || '';
    } else { n.projectId = ''; n.projectTitle = ''; n.projectBoard = ''; }
    const people = await roster();
    if (n.participantIds.some((id) => !people.some((p) => p.id === id))) fail('invalid-argument', 'Every participant must have a current BOLD.OS account.');
    n = { ...n, id: ref.id, channelId: c.id, createdBy: old ? old.createdBy : userId, updatedBy: userId, updatedAt: now() };
    n.fingerprint = fingerprint(n);
    const saved = await db.runTransaction(async (tx) => {
      const current = await tx.get(ref), duplicate = await tx.get(keys.doc(n.fingerprint));
      // Same creation request retried: return its existing entry without an extra write.
      if (current.exists && d.version === undefined) {
        if (current.data().fingerprint === n.fingerprint && current.data().createdBy === userId) return { ...publicView(current.data()), existing: true };
        fail('already-exists', 'This meeting ID is already used. Reopen the entry.');
      }
      if (current.exists) requireUnlocked(current.data());
      if (d.version !== undefined && (!current.exists || current.data().version !== d.version)) fail('aborted', 'Someone changed this meeting. Reopen it before saving.');
      if (duplicate.exists && duplicate.data().id !== ref.id) fail('already-exists', 'This channel already has a meeting with that schedule and link. Open its existing calendar entry.');
      n.version = current.exists ? current.data().version + 1 : 1;
      if (n.mode === 'create') n = lock({ ...n, link: current.exists ? current.data().link || '' : '' }, 'save');
      if (current.exists && current.data().fingerprint !== n.fingerprint) tx.delete(keys.doc(current.data().fingerprint));
      tx.set(keys.doc(n.fingerprint), { id: ref.id }); tx.set(ref, n); tx.set(publicRecords.doc(ref.id), publicView(n));
      return n;
    });
    if (saved.existing) return saved;
    return saved.mode === 'create' ? finishSync(saved) : publicView(saved);
  }
  return { run };
}
module.exports = { channelId, normalize, publicView, fingerprint, createService };
