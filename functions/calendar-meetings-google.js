'use strict';

// Only called for explicitly confirmed, BOLD.OS-created meetings. Imported listings
// never enter this adapter. Deterministic Google IDs make uncertain insert retries safe.
const crypto = require('crypto');
const { londonMs } = require('./busy');
const TZ = 'Europe/London';
const idOf = (id) => 'c' + crypto.createHash('sha256').update('co-supervision:' + id).digest('hex');
function eventBody(s, emails){
  const start = s.firstDate + 'T' + s.meeting.time + ':00';
  const end = new Date(Date.parse(start + 'Z') + s.meeting.minutes * 60000).toISOString().slice(0,19);
  // Google expands this local wall time in London, including DST transitions.
  const recurrence = ['RRULE:FREQ=WEEKLY;INTERVAL=' + s.meeting.every + ';BYDAY=' + s.meeting.day +
    (s.meeting.until ? ';UNTIL=' + s.meeting.until.replace(/-/g, '') + 'T235959Z' : '')];
  return { summary: s.title, description: 'Created through BOLD.OS.',
    start: { dateTime: start, timeZone: TZ }, end: { dateTime: end, timeZone: TZ }, recurrence,
    attendees: s.inviteGuests ? emails.map((email) => ({ email })) : [],
    guestsCanModify: false, guestsCanInviteOthers: false,
  };
}
function sameInstant(actual, expected){
  if (!actual || !actual.dateTime) return false;
  const t = expected.dateTime;
  return Date.parse(actual.dateTime) === londonMs(t.slice(0,10), t.slice(11,16));
}
function createGoogleMeetings({ googleFetch, addressesForIds, CAL }){
  return async function sync(s, operation){
    if (s.mode !== 'create') throw new Error('Existing calendar listings cannot write to Google.');
    const id = idOf(s.id), endpoint = CAL + '/' + id;
    let ev;
    try { ev = await googleFetch('GET', endpoint); }
    catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    if (operation === 'remove') {
      if (ev && ev.status !== 'cancelled') await googleFetch('DELETE', endpoint + '?sendUpdates=' + ((ev.attendees || []).length ? 'all' : 'none'));
      return { removed: true };
    }
    const emails = s.inviteGuests ? await addressesForIds(s.participantIds) : [];
    if (s.inviteGuests && !emails.length) throw new Error('No invitation addresses are available.');
    const body = eventBody(s, emails);
    if (!ev) {
      try {
        ev = await googleFetch('POST', CAL + '?conferenceDataVersion=1&sendUpdates=' + (s.inviteGuests ? 'all' : 'none'),
          { id, ...body, conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } });
      } catch (e) {
        if (e.status !== 409) throw e;
        ev = await googleFetch('GET', endpoint);
      }
    }
    if (ev.status === 'cancelled') throw new Error('The Google event was cancelled externally. Remove this entry and create a new meeting.');
    const change = {}, addresses = (xs) => (xs || []).filter((a) => !a.organizer && !a.self).map((a) => a.email.toLowerCase()).sort().join(',');
    if (ev.summary !== body.summary) change.summary = body.summary;
    if (!sameInstant(ev.start, body.start) || !sameInstant(ev.end, body.end)) { change.start = body.start; change.end = body.end; }
    if (JSON.stringify(ev.recurrence || []) !== JSON.stringify(body.recurrence)) change.recurrence = body.recurrence;
    if (addresses(ev.attendees) !== addresses(body.attendees)) {
      change.attendees = (ev.attendees || []).filter((a) => a.organizer || a.self || emails.includes(a.email.toLowerCase()));
      emails.forEach((email) => { if (!change.attendees.some((a) => a.email.toLowerCase() === email)) change.attendees.push({ email }); });
    }
    if (Object.keys(change).length) {
      const notify = change.start || change.recurrence || change.attendees;
      ev = await googleFetch('PATCH', endpoint + '?sendUpdates=' + (notify && ((ev.attendees || []).length || emails.length) ? 'all' : 'none'), change);
    }
    const link = ev.hangoutLink || ((ev.conferenceData || {}).entryPoints || []).find((p) => p.entryPointType === 'video')?.uri;
    if (!link || !/^https:\/\//.test(link)) throw new Error('Google is still preparing the Meet link. Retry to retrieve it; the event will not be duplicated.');
    return { eventId: id, link, calendarState: 'ready', syncError: '' };
  };
}
module.exports = { idOf, eventBody, createGoogleMeetings };
