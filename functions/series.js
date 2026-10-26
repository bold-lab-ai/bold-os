'use strict';

// Recurring lab meetings and events (series.html; Events). Two kinds:
// - 'meeting' (Hamming Sessions, the group meeting…): a weekly slot with its Google
//   Calendar series, below;
// - 'editions' (the Festival, Collaboration Week…): an event every N months
//   (`cadence: { every, unit: 'month' }`), each edition an events/{slug} doc with
//   `series: <id>`, made by 'nextEdition' (hidden, until a PI or admin releases it, as
//   any event). The series' organisers edit its editions (firestore.rules); seriesNudges
//   tells the PIs, admins and organisers when the next one is due and not scheduled.
//   `proposals`: its editions take proposals (event-proposals.js).
// eventSeries/{id} { id, kind, title, description, meeting (normalizeMeeting's: day, time,
// minutes, every, until?, link?), invite: { mode: 'group', group } | { mode: 'join' },
// joined: [emails], organisers: [emails], hidden, createdBy, createdAt, updatedAt,
// updatedBy, pausedAt?, pausedBy? }, and the Google Calendar side, as a project's
// meeting has it: eventId, eventLink, meetUrl, eventMeeting, eventPausedAt, eventStart,
// guests (whom the event invites), error.
// Only the eventSeries callable writes them (firestore.rules); the lab reads the
// released ones, PIs and admins and its organisers the hidden ones too.
//
// Who does what (the Events row of BOLDiquette › Who can see what for adding):
// - adding one: Events' Edit level; it starts hidden, and the PIs and admins are told;
// - changing, pausing, deleting it: its organisers, PIs and admins;
// - releasing and hiding it: PIs and admins. Nobody is invited before it's released,
//   so nobody invites a whole group on their own; nor, once released, does an organiser
//   change who is invited (PIs and admins do);
// - joining and leaving one that's opt-in: whoever can view Events.
// Invited: everyone in `invite.group` and above (members' groups; PIs and admins count
// as BOLD-exec), kept in line as people join BOLD or change group (onMemberGroupChanged),
// or whoever joined; and its organisers.

module.exports = function series(deps){
  const { db, onCall, onDocumentWritten, HttpsError, logger, callerEmail, isFullWrite, access, rolesEmails,
    googleFetch, CAL, eventConference, eventTimes, conferenceChange, meetingRecurrence, sameMeetingTimes, seriesStart,
    normalizeMeeting, googleAddressesFor, groupOf, tellStaff, slackText, linkedTitle, SITE_URL,
    GOOGLE_OAUTH, SLACK_BOT_TOKEN, FieldValue, crypto, onSchedule, tellPeople } = deps;
  const { rank } = require('./access');
  const INVITE_GROUPS = ['everyone', 'associate', 'internal', 'staff', 'exec'];
  const seriesUrl = (id) => SITE_URL + 'series.html?series=' + encodeURIComponent(id);
  const lower = (e) => String(e || '').trim().toLowerCase();

  // Pure: what a page sends → { kind, title, description, organisers, and meeting and
  // invite ('meeting') or cadence and proposals ('editions') } or { error }.
  function normalizeSeries(d, me){
    d = d && typeof d === 'object' ? d : {};
    const kind = d.kind === 'editions' ? 'editions' : 'meeting';
    const title = String(d.title || '').trim();
    if (!title) return { error: 'Give it a title.' };
    if (title.length > 120) return { error: 'Keep the title under 120 characters.' };
    const description = String(d.description || '').trim();
    if (description.length > 5000) return { error: 'Keep the description under 5000 characters.' };
    const out = { kind, title, description };
    if (kind === 'editions') {
      const every = Number(d.cadence && d.cadence.every);
      if (!(every >= 1 && every <= 24 && every % 1 === 0)) return { error: 'Choose how often it happens: every 1 to 24 months.' };
      Object.assign(out, { cadence: { every, unit: 'month' }, proposals: d.proposals === true });
    } else {
      const meeting = normalizeMeeting(d.meeting);
      if (meeting.error) return { error: meeting.error };
      const inv = d.invite || {};
      const invite = inv.mode === 'group' ? { mode: 'group', group: String(inv.group || '') } : { mode: 'join' };
      if (invite.mode === 'group' && INVITE_GROUPS.indexOf(invite.group) < 0) return { error: 'Choose which group is invited.' };
      Object.assign(out, { meeting, invite });
    }
    const organisers = [];
    (Array.isArray(d.organisers) ? d.organisers : []).concat(me ? [me] : []).forEach((e) => {
      const v = lower(e);
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && organisers.indexOf(v) < 0) organisers.push(v);
    });
    if (organisers.length > 10) return { error: 'Up to 10 organisers.' };
    out.organisers = organisers;
    return out;
  }

  // Pure: 'YYYY-MM-DD' plus `months` (the same day, or the month's last).
  function addMonths(iso, months){
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  async function editionsOf(id){
    return (await db.collection('events').where('series', '==', id).get()).docs.map((d) => d.data())
      .filter((e) => isoDay.test(e.startDate || '')).sort((a, b) => a.startDate.localeCompare(b.startDate));
  }
  // Pure: when the next edition is due (the last one's start plus the cadence), or ''
  // if one is coming up already.
  function nextDue(s, editions, today){
    if (!s.cadence || !editions.length) return '';
    if (editions.some((e) => (e.endDate || e.startDate) >= today)) return '';
    return addMonths(editions[editions.length - 1].startDate, s.cadence.every);
  }

  // Everyone `invite` asks for, lowercase: the group and above, or whoever joined; and the organisers.
  async function inviteesOf(s){
    let out = [];
    if (s.invite && s.invite.mode === 'group') {
      const [members, pis, admins] = await Promise.all([db.collection('members').get(), rolesEmails('pis'), rolesEmails('admins')]);
      const need = rank(s.invite.group);
      members.docs.forEach((d) => { if (rank(groupOf(d.data())) >= need) out.push(lower(d.data().email || d.id)); });
      out = out.concat(pis.map(lower), admins.map(lower));
    } else out = (s.joined || []).map(lower);
    out = out.concat((s.organisers || []).map(lower));
    return out.filter((e, i) => e && out.indexOf(e) === i);
  }

  // Brings the series' Google Calendar event in line with it: made once released, with a
  // Meet link (or its own link); changed with it; its series ended when paused; cancelled
  // when hidden or deleted. Records an error instead of throwing.
  async function syncSeries(id){
    const ref = db.collection('eventSeries').doc(id);
    const s = (await ref.get()).data();
    if (!s || s.kind === 'editions') return s || null;
    const patch = {};
    try {
      const want = !s.hidden && !!s.meeting && !(s.pausedAt && !s.eventId);
      const guests = want ? await inviteesOf(s) : [];
      const addrs = await googleAddressesFor(guests);
      const summary = s.title;
      const description = (s.meeting.link ? 'Join: <a href="' + s.meeting.link + '">' + s.meeting.link + '</a><br>' : '') +
        (s.description ? s.description.replace(/</g, '&lt;').replace(/\n/g, '<br>') + '<br><br>' : '') +
        'On <a href="' + seriesUrl(id) + '">BOLD.OS</a>.';
      const attendees = (existing) => {
        const kept = (existing || []).filter((a) => a.organizer || a.self || addrs.indexOf(lower(a.email)) >= 0);
        return kept.concat(addrs.filter((m) => !kept.some((a) => lower(a.email) === m)).map((m) => ({ email: m })));
      };
      if (want && !s.eventId) {
        const ev = await googleFetch('POST', CAL + '?conferenceDataVersion=1&sendUpdates=all', Object.assign({
          summary, description, attendees: attendees([]), guestsCanModify: false, guestsCanSeeOtherGuests: s.invite.mode !== 'group',
        }, eventConference(s.meeting, 'bold-series-' + crypto.randomBytes(6).toString('hex')), eventTimes(s.meeting, s.pausedAt)));
        Object.assign(patch, { eventId: ev.id, eventLink: ev.htmlLink, meetUrl: s.meeting.link || ev.hangoutLink || '', eventMeeting: s.meeting,
          eventPausedAt: s.pausedAt || FieldValue.delete(), eventStart: seriesStart(ev), guests });
      } else if (!want && s.eventId) {
        await googleFetch('DELETE', CAL + '/' + s.eventId + '?sendUpdates=all').catch((err) => { if (err.status !== 410 && err.status !== 404) throw err; });
        ['eventId', 'eventLink', 'meetUrl', 'eventMeeting', 'eventPausedAt', 'eventStart', 'guests'].forEach((k) => { patch[k] = FieldValue.delete(); });
      } else if (s.eventId) {
        const ev = await googleFetch('GET', CAL + '/' + s.eventId);
        const change = {};
        const want2 = attendees(ev.attendees);
        if (JSON.stringify(want2.map((a) => a.email)) !== JSON.stringify((ev.attendees || []).map((a) => a.email))) change.attendees = want2;
        if (ev.summary !== summary) change.summary = summary;
        if (ev.description !== description) change.description = description;
        if (!sameMeetingTimes(s.eventMeeting, s.meeting)) Object.assign(change, eventTimes(s.meeting, s.pausedAt));
        else if ((s.eventMeeting.until || '') !== (s.meeting.until || '') || (s.pausedAt || 0) !== (s.eventPausedAt || 0)) change.recurrence = meetingRecurrence(s.meeting, s.pausedAt);
        Object.assign(change, conferenceChange(ev, s.meeting, 'bold-series-' + crypto.randomBytes(6).toString('hex')));
        let now = ev;
        if (Object.keys(change).length) {
          now = await googleFetch('PATCH', CAL + '/' + s.eventId + '?conferenceDataVersion=1&sendUpdates=all', change) || ev;
          Object.assign(patch, { eventMeeting: s.meeting, eventPausedAt: s.pausedAt || FieldValue.delete(), eventStart: seriesStart(now) });
        }
        const url = s.meeting.link || now.hangoutLink || '';
        if (url !== (s.meetUrl || '')) patch.meetUrl = url;
        patch.guests = guests;
      }
      patch.error = FieldValue.delete();
    } catch (err) {
      logger.error('Setting up a recurring meeting failed', { id, error: String(err && err.message || err) });
      patch.error = err instanceof HttpsError ? err.message : 'Couldn’t set up the meeting in Google Calendar.';
    }
    await ref.set(patch, { merge: true });
    return (await ref.get()).data();
  }

  // What the page gets: the series, without anyone's addresses but the caller's own place in it.
  function view(s, me, full){
    const out = {};
    ['id', 'kind', 'title', 'description', 'meeting', 'invite', 'cadence', 'proposals', 'hidden', 'pausedAt', 'eventLink', 'error', 'createdAt', 'updatedAt'].forEach((k) => { if (s[k] !== undefined) out[k] = s[k]; });
    const organiser = (s.organisers || []).indexOf(me) >= 0;
    out.organiser = organiser; out.canChange = organiser || full; out.full = full;
    out.joined = (s.joined || []).indexOf(me) >= 0;
    out.invited = (s.guests || []).indexOf(me) >= 0;
    out.people = (s.guests || []).length;
    if (out.invited || full) out.meetUrl = s.meetUrl || '';
    return out;
  }

  // data: { action, id?, … }
  //   'save': { id? (none: a new one), title, description, meeting, invite, organisers }
  //   'release' | 'hide' | 'pause' | 'resume' | 'join' | 'leave' | 'delete' | 'retry': { id }
  //   'nextEdition': { id, startDate, endDate } (an 'editions' series) → { slug }: a new hidden edition,
  //     its title, place and description from the series and its last edition
  // → { series: view } ('delete': { ok }).
  const eventSeries = onCall({ secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN], timeoutSeconds: 120 }, async (request) => {
    const email = callerEmail(request);
    const d = request.data || {};
    await access.requireAccess(email, 'events', d.action === 'join' || d.action === 'leave' ? 'view' : 'edit');
    const full = await isFullWrite(email);
    if (d.action === 'save' && !d.id) {
      const n = normalizeSeries(d, email);
      if (n.error) throw new HttpsError('invalid-argument', n.error);
      const stem = n.title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'meeting';
      const id = stem + '-' + crypto.randomBytes(3).toString('hex');
      const now = Date.now();
      await db.collection('eventSeries').doc(id).set(Object.assign({ id, hidden: true, joined: [], createdBy: email, createdAt: now, updatedAt: now, updatedBy: email }, n));
      if (!full) {
        const who = ((await db.collection('people').where('email', '==', email).limit(1).get()).docs[0] || { data: () => ({}) }).data().name || email.split('@')[0];
        await Promise.resolve(tellStaff('🔔 ' + slackText(who) + ' added a recurring meeting, ' + linkedTitle(n.title, seriesUrl(id)) +
          (n.kind === 'editions' ? '. It stays hidden until a PI or admin releases it.' : '. It stays hidden, and nobody is invited, until a PI or admin releases it.'), email)).catch((err) => logger.warn('Telling the PIs failed', { error: String(err.message) }));
      }
      return { series: view((await db.collection('eventSeries').doc(id).get()).data(), email, full) };
    }
    const id = String(d.id || '');
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new HttpsError('invalid-argument', 'No such meeting.');
    const ref = db.collection('eventSeries').doc(id);
    const snap = await ref.get();
    const s = snap.exists ? snap.data() : null;
    const organiser = !!s && (s.organisers || []).indexOf(email) >= 0;
    if (!s || (s.hidden && !full && !organiser)) throw new HttpsError('not-found', 'No such meeting.');
    const change = organiser || full;
    const stamp = { updatedAt: Date.now(), updatedBy: email };
    switch (d.action) {
      case 'save': {
        if (!change) throw new HttpsError('permission-denied', 'Only its organisers, PIs and admins change it.');
        const n = normalizeSeries(d, null);
        if (n.error) throw new HttpsError('invalid-argument', n.error);
        if (n.kind !== (s.kind || 'meeting')) throw new HttpsError('invalid-argument', 'A recurring meeting stays one, and a recurring event stays one.');
        if (!n.organisers.length) throw new HttpsError('invalid-argument', 'Keep at least one organiser.');
        if (n.kind === 'meeting' && !s.hidden && !full && JSON.stringify(n.invite) !== JSON.stringify(s.invite))
          throw new HttpsError('permission-denied', 'Once it’s released, only PIs and admins change who is invited.');
        await ref.set(Object.assign(n, stamp), { merge: true });
        break;
      }
      case 'release': case 'hide':
        if (!full) throw new HttpsError('permission-denied', 'Only PIs and admins release and hide recurring meetings.');
        await ref.set(Object.assign({ hidden: d.action === 'hide' }, stamp), { merge: true });
        break;
      case 'nextEdition': {
        if (s.kind !== 'editions') throw new HttpsError('invalid-argument', 'Only a recurring event has editions.');
        if (!change) throw new HttpsError('permission-denied', 'Only its organisers, PIs and admins schedule its editions.');
        const start = String(d.startDate || ''), end = String(d.endDate || d.startDate || '');
        if (!isoDay.test(start) || !isoDay.test(end) || end < start) throw new HttpsError('invalid-argument', 'Give its first and last day, the last on or after the first.');
        const editions = await editionsOf(id), last = editions[editions.length - 1] || {};
        const slug = id + '-' + start.slice(0, 7);
        const eref = db.collection('events').doc(slug);
        if ((await eref.get()).exists) throw new HttpsError('already-exists', 'There’s an edition that month already.');
        const now = Date.now();
        await eref.set({ slug, series: id, hidden: true, title: s.title, startDate: start, endDate: end, place: last.place || '',
          description: s.description || last.description || '', createdAt: now, createdBy: email, updatedAt: now, updatedBy: email });
        await ref.set({ nudgedFor: FieldValue.delete() }, { merge: true });
        return { slug };
      }
      case 'pause': case 'resume':
        if (s.kind === 'editions') throw new HttpsError('invalid-argument', 'A recurring event isn’t paused: schedule its next edition, or don’t.');
        if (!change) throw new HttpsError('permission-denied', 'Only its organisers, PIs and admins pause it.');
        await ref.set(Object.assign(d.action === 'pause' ? { pausedAt: Date.now(), pausedBy: email } : { pausedAt: FieldValue.delete(), pausedBy: FieldValue.delete() }, stamp), { merge: true });
        break;
      case 'join': case 'leave':
        if (s.kind === 'editions') throw new HttpsError('invalid-argument', 'A recurring event isn’t joined.');
        if (s.hidden) throw new HttpsError('failed-precondition', 'It isn’t released yet.');
        if (!s.invite || s.invite.mode !== 'join') throw new HttpsError('failed-precondition', 'Everyone in its group is invited already.');
        await ref.update({ joined: d.action === 'join' ? FieldValue.arrayUnion(email) : FieldValue.arrayRemove(email) });
        break;
      case 'retry':
        if (!change) throw new HttpsError('permission-denied', 'Only its organisers, PIs and admins can do this.');
        break;
      case 'delete':
        if (!change) throw new HttpsError('permission-denied', 'Only its organisers, PIs and admins delete it.');
        await ref.set({ hidden: true }, { merge: true });
        { const after = await syncSeries(id); if (after && after.eventId) throw new HttpsError('unavailable', 'Couldn’t cancel it in Google Calendar: try again.'); }
        // Its editions stay, as events of their own.
        { const eds = await db.collection('events').where('series', '==', id).get();
          await Promise.all(eds.docs.map((e) => e.ref.update({ series: FieldValue.delete() }))); }
        await ref.delete();
        return { ok: true };
      default:
        throw new HttpsError('invalid-argument', 'Unknown action.');
    }
    return { series: view(await syncSeries(id), email, full) };
  });

  // A member joined BOLD or changed group: the released series inviting a group, again.
  const onMemberGroupChanged = onDocumentWritten({ document: 'members/{email}', secrets: [GOOGLE_OAUTH] }, async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (before && after && groupOf(before) === groupOf(after)) return;
    const snap = await db.collection('eventSeries').where('invite.mode', '==', 'group').get();
    for (const doc of snap.docs) if (!doc.data().hidden) await syncSeries(doc.id);
  });

  // Every morning: a recurring event whose next edition is due within six weeks (or past
  // due) and not scheduled: tell the PIs, admins and its organisers, once for each due date.
  const seriesNudges = onSchedule({ schedule: '0 9 * * *', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] }, async () => {
    const today = todayLondon(), soon = addMonths(today, 0);
    const snap = await db.collection('eventSeries').where('kind', '==', 'editions').get();
    const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins')).map(lower);
    for (const doc of snap.docs) {
      const s = doc.data();
      if (s.hidden) continue;
      const due = nextDue(s, await editionsOf(doc.id), today);
      if (!due || s.nudgedFor === due) continue;
      const sixWeeks = new Date(Date.parse(soon + 'T00:00:00Z') + 42 * 86400000).toISOString().slice(0, 10);
      if (due > sixWeeks) continue;
      const when = new Date(due + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const to = staff.concat((s.organisers || []).map(lower)).filter((e, i, a) => e && a.indexOf(e) === i);
      await tellPeople(to, '🗓️ The next ' + slackText(s.title) + ' is due around ' + when + ' and isn’t scheduled yet. ' +
        linkedTitle('Schedule it', seriesUrl(doc.id)) + ', or tell its organisers.').catch((err) => logger.warn('Nudging about a series failed', { id: doc.id, error: String(err.message) }));
      await doc.ref.set({ nudgedFor: due }, { merge: true });
    }
  });

  return { eventSeries, onMemberGroupChanged, seriesNudges, _internal: { normalizeSeries, inviteesOf, addMonths, nextDue } };
};
