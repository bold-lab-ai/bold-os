// An event set to "Anyone, even signed out" (visibleTo 'public'), for whoever can't read its
// documents directly: signed out, and PAN-BOLD (sessions, talks and proposals are BOLD-associate
// and above in firestore.rules). publicEvent({ event | series | session | talk }) → the bundle of
// its series: the series, its public editions, their sessions, talks, proposals and the projects
// presented there, each cut down to what a stranger may read (sanitize* below, by allow-list):
// no emails, contacts, meeting or slide links, notes, nor anything of an event that isn't public.
// src/assets/js/public-db.js serves the bundle to the pages as if it were Firestore.
'use strict';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Free text can name an email ("Chair: Ann (ann@x.org)"): it goes too.
function scrub(v){
  if (typeof v === 'string') return v.replace(EMAIL, '').replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ');
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = scrub(v[k]); }); return o; }
  return v;
}
function pick(x, keys){
  const o = {};
  keys.forEach((k) => { if (x && x[k] !== undefined && x[k] !== null) o[k] = x[k]; });
  return scrub(o);
}
const names = (list) => (Array.isArray(list) ? list : []).map((l) => ({ name: String((l && l.name) || '') })).filter((l) => l.name);

const isPublic = (x) => !!x && x.hidden === false && x.visibleTo === 'public';

function sanitizeSeries(s){
  return pick(s, ['id', 'kind', 'title', 'description', 'cadence', 'proposals', 'page', 'hidden', 'visibleTo']);
}
function sanitizeEvent(e){
  const o = pick(e, ['slug', 'title', 'startDate', 'endDate', 'place', 'description', 'series', 'page', 'hidden', 'visibleTo', 'proposalsOpen']);
  o.days = scrub((e.days || []).map((d) => ({ id: d.id, date: d.date, title: d.title || '', note: d.note || '',
    slots: (d.slots || []).map((s) => ({ id: s.id, kind: s.kind, start: s.start || '', end: s.end || '', title: s.title || '', text: s.text || '', sessions: s.sessions || [] })) })));
  o.venues = (e.venues || []).map((v) => pick(v, ['slug', 'name', 'address']));
  return o;
}
function sanitizeSession(s){
  const o = pick(s, ['slug', 'eventSlug', 'title', 'subtitle', 'type', 'locationSlug', 'room', 'aim', 'background', 'keyQuestions', 'overallDescription', 'problems', 'talkOrder', 'removed']);
  o.leads = names(s.leads);
  o.agenda = (s.agenda || []).map((a) => pick(a, ['time', 'activity', 'speaker']));
  return o;
}
function sanitizeTalk(t){
  const o = pick(t, ['slug', 'sessionSlug', 'title', 'speaker', 'affiliation', 'abstract', 'bio', 'type', 'duration', 'removed', 'createdAt']);
  if (Array.isArray(t.speakers)) o.speakers = names(t.speakers);
  return o;
}
function sanitizeProposal(p){
  return pick(p, ['title', 'contributionType', 'name', 'duration', 'createdAt', 'eventSlug']);
}
function sanitizePresentation(p){
  const o = pick(p, ['title', 'presenter', 'date', 'type']);
  o.occasion = pick(p.occasion || {}, ['kind', 'id', 'label', 'sessionSlug', 'sessionTitle', 'talkSlug', 'talkTitle']);
  return o;
}

// The bundle, from plain documents: { series, events: [{ id, data }], sessions, talks, proposals,
// presentations: [{ id, project, data }], projects: [{ id, data }] } → what the pages get.
function bundleOf(raw){
  const events = raw.events.filter((e) => isPublic(e.data));
  const slugs = new Set(events.map((e) => e.id));
  const sessions = raw.sessions.filter((s) => slugs.has(s.data.eventSlug));
  const sessionSlugs = new Set(sessions.map((s) => s.id));
  const presentations = raw.presentations.filter((p) => p.data.occasion && p.data.occasion.kind === 'event' && slugs.has(p.data.occasion.id));
  const shown = new Set(presentations.map((p) => p.project));
  const out = { eventSeries: {}, events: {}, collabWeekSessions: {}, collabWeekTalks: {}, collabWeekProposals: {}, presentations: [], projectWorkspaces: {} };
  if (raw.series && isPublic(raw.series.data)) out.eventSeries[raw.series.id] = sanitizeSeries(Object.assign({ id: raw.series.id }, raw.series.data));
  events.forEach((e) => { out.events[e.id] = sanitizeEvent(Object.assign({ slug: e.id }, e.data)); });
  sessions.forEach((s) => { out.collabWeekSessions[s.id] = sanitizeSession(Object.assign({ slug: s.id }, s.data)); });
  raw.talks.filter((t) => sessionSlugs.has(t.data.sessionSlug)).forEach((t) => { out.collabWeekTalks[t.id] = sanitizeTalk(Object.assign({ slug: t.id }, t.data)); });
  raw.proposals.filter((p) => slugs.has(p.data.eventSlug)).forEach((p) => { out.collabWeekProposals[p.id] = sanitizeProposal(p.data); });
  out.presentations = presentations.map((p) => ({ id: p.id, project: p.project, data: sanitizePresentation(p.data) }));
  raw.projects.filter((p) => shown.has(p.id)).forEach((p) => { out.projectWorkspaces[p.id] = pick(p.data, ['title', 'cardId', 'boardId']); });
  return out;
}

module.exports = function({ db, onCall, HttpsError }){
  const SLUG = /^[A-Za-z0-9_-]{1,120}$/;
  const get = async (col, id) => { const d = await db.collection(col).doc(id).get(); return d.exists ? d.data() : null; };
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const NONE = 'There’s nothing public there.';

  const publicEvent = onCall(async (request) => {
    const d = request.data || {};
    const key = ['talk', 'session', 'event', 'series'].filter((k) => typeof d[k] === 'string' && SLUG.test(d[k]))[0];
    if (!key) throw new HttpsError('invalid-argument', 'Which event?');
    // What it's part of: a talk's session, a session's event, an event's series.
    let eventSlug = '', seriesId = '';
    if (key === 'talk') { const t = await get('collabWeekTalks', d.talk); const s = t && t.sessionSlug ? await get('collabWeekSessions', t.sessionSlug) : null; eventSlug = (s && s.eventSlug) || ''; }
    if (key === 'session') { const s = await get('collabWeekSessions', d.session); eventSlug = (s && s.eventSlug) || ''; }
    if (key === 'event') eventSlug = d.event;
    if (key === 'series') seriesId = d.series;
    if (eventSlug) {
      const e = await get('events', eventSlug);
      if (!isPublic(e)) throw new HttpsError('not-found', NONE);
      seriesId = e.series || '';
    }
    const series = seriesId ? await get('eventSeries', seriesId) : null;
    if (key === 'series' && !isPublic(series)) throw new HttpsError('not-found', NONE);
    const events = seriesId
      ? rows(await db.collection('events').where('series', '==', seriesId).get())
      : [{ id: eventSlug, data: await get('events', eventSlug) }];
    const slugs = events.filter((e) => isPublic(e.data)).map((e) => e.id).slice(0, 30);
    if (!slugs.length) throw new HttpsError('not-found', NONE);
    const [sessions, proposals, pres] = await Promise.all([
      db.collection('collabWeekSessions').where('eventSlug', 'in', slugs).get(),
      db.collection('collabWeekProposals').where('eventSlug', 'in', slugs).get(),
      db.collectionGroup('presentations').where('occasion.id', 'in', slugs).get(),
    ]);
    const sessionSlugs = sessions.docs.map((s) => s.id);
    const talkSnaps = await Promise.all(Array.from({ length: Math.ceil(sessionSlugs.length / 30) }, (_, i) =>
      db.collection('collabWeekTalks').where('sessionSlug', 'in', sessionSlugs.slice(i * 30, i * 30 + 30)).get()));
    const presentations = pres.docs.map((p) => ({ id: p.id, project: p.ref.parent.parent.id, data: p.data() }));
    const projectIds = Array.from(new Set(presentations.map((p) => p.project)));
    const projects = (await Promise.all(projectIds.map((id) => db.collection('projectWorkspaces').doc(id).get()))).filter((s) => s.exists).map((s) => ({ id: s.id, data: s.data() }));
    return bundleOf({ series: series ? { id: seriesId, data: series } : null, events, sessions: rows(sessions), talks: [].concat(...talkSnaps.map(rows)),
      proposals: rows(proposals), presentations, projects });
  });

  return { publicEvent };
};
module.exports.bundleOf = bundleOf;
module.exports.scrub = scrub;
