// A public event's content for strangers (publicEvent, functions/public-event.js, 2026-11-03):
// only public events' things, and of those no emails, contacts, meeting or slide links, notes.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { bundleOf, scrub } = require('../functions/public-event.js');

const pub = { hidden: false, visibleTo: 'public', series: 'fest', title: 'Festival', createdBy: 'a@b.org', updatedBy: 'a@b.org',
  days: [{ id: 'd1', date: '2027-06-01', title: 'Day', note: 'Ask c@d.org', slots: [{ id: 's1', kind: 'sessions', sessions: ['w1'], secret: 'x' }] }],
  venues: [{ slug: 'v', name: 'Hall', address: 'Oxford', contact: 'v@x.org' }] };
const raw = {
  series: { id: 'fest', data: { title: 'Festival', hidden: false, visibleTo: 'public', organisers: ['o@x.org'], joined: ['j@x.org'] } },
  events: [{ id: 'fest-2027', data: pub }, { id: 'fest-2028', data: Object.assign({}, pub, { hidden: true }) }, { id: 'cw', data: { hidden: false, visibleTo: 'associate' } }],
  sessions: [
    { id: 'w1', data: { eventSlug: 'fest-2027', title: 'W', leads: [{ name: 'Ann', email: 'ann@x.org' }], leadEmails: ['ann@x.org'], contact: 'ann@x.org', links: { meet: 'https://meet.google.com/x' }, notes: 'n', agenda: [{ time: '9', activity: 'Talk', speaker: 'Bo', email: 'bo@x.org' }] } },
    { id: 'cw1', data: { eventSlug: 'cw', title: 'Research talk' } },
    { id: 'h1', data: { eventSlug: 'fest-2028', title: 'Hidden edition' } }],
  talks: [
    { id: 't1', data: { sessionSlug: 'w1', title: 'T', speaker: 'Bo', presenterEmails: ['bo@x.org'], presentationUrl: 'https://docs.google.com/x', notes: 'n', speakers: [{ name: 'Bo', email: 'bo@x.org' }] } },
    { id: 't2', data: { sessionSlug: 'cw1', title: 'Hidden', bio: 'x' } }],
  proposals: [
    { id: 'p1', data: { eventSlug: 'fest-2027', title: 'P', contributionType: 'Workshop', name: 'Cy', email: 'cy@x.org', chair: 'Dee (dee@x.org)' } },
    { id: 'p2', data: { title: 'Old CW one, no eventSlug', name: 'Ed' } }],
  presentations: [
    { id: 'pr1', project: 'proj', data: { title: 'Slides', presenter: 'Bo', occasion: { kind: 'event', id: 'fest-2027' }, slidesUrl: 'https://drive.google.com/x', by: { email: 'bo@x.org' } } },
    { id: 'pr2', project: 'other', data: { title: 'At CW', occasion: { kind: 'event', id: 'cw' } } }],
  projects: [{ id: 'proj', data: { title: 'World models', members: ['bo@x.org'], meetUrl: 'https://meet.google.com/y' } }, { id: 'other', data: { title: 'Secret' } }],
};

test('only the public, released editions and what belongs to them', () => {
  const b = bundleOf(raw);
  assert.deepStrictEqual(Object.keys(b.events), ['fest-2027']);
  assert.deepStrictEqual(Object.keys(b.collabWeekSessions), ['w1']);
  assert.deepStrictEqual(Object.keys(b.collabWeekTalks), ['t1']);
  assert.deepStrictEqual(Object.keys(b.collabWeekProposals), ['p1']);
  assert.deepStrictEqual(b.presentations.map((p) => p.id), ['pr1']);
  assert.deepStrictEqual(Object.keys(b.projectWorkspaces), ['proj']);
});

test('no email address, contact, link to a meeting or slides, or note anywhere', () => {
  const s = JSON.stringify(bundleOf(raw));
  assert.ok(!/@/.test(s), s.match(/.{20}@.{20}/));
  for (const bad of ['meet.google', 'docs.google', 'drive.google', 'leadEmails', 'presenterEmails', 'organisers', 'joined', 'contact', 'notes', 'createdBy', 'members', 'secret']) {
    assert.ok(!s.includes(bad), bad);
  }
  const b = bundleOf(raw);
  assert.deepStrictEqual(b.collabWeekSessions.w1.leads, [{ name: 'Ann' }]);
  assert.strictEqual(b.collabWeekProposals.p1.name, 'Cy');
  assert.strictEqual(b.projectWorkspaces.proj.title, 'World models');
});

test('a series that isn’t public gives nothing of itself', () => {
  const b = bundleOf(Object.assign({}, raw, { series: { id: 'fest', data: { hidden: false, visibleTo: 'internal' } } }));
  assert.deepStrictEqual(b.eventSeries, {});
});

test('emails go from free text too', () => {
  assert.strictEqual(scrub('Chair: Dee (dee@x.org), Ed'), 'Chair: Dee , Ed');
});
