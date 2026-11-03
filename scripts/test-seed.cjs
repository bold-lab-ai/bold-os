// Demo data for the local test copy (scripts/test-site.sh): the Firestore emulator of the demo
// project `demo-bold-os` only (it refuses anything else). Test accounts (test-mode.js's), their
// groups and details, the BOLDiquette's Who is BOLD, Get started, the access table, event series
// (two required for BOLD-internal) and two projects. All made up.
// BOLDIQUETTE_PARTS=<a JSON file of the BOLDiquette's parts> uses those instead of a stand-in
// (the real ones are BOLD-internal: keep that file outside the repo).
'use strict';
const path = require('path');
const fs = require('fs');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));
if (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== 'demo-bold-os') throw new Error('Only the demo project.');
admin.initializeApp({ projectId: 'demo-bold-os' });
const db = admin.firestore();

const people = [
  ['UTESTPI', 'Pat PI', 'pi@example.com', 'exec', 'PI'],
  ['UTESTIN', 'Ines Internal', 'internal@example.com', 'internal', 'PhD student'],
  ['UTESTAS', 'Ari Associate', 'associate@example.com', 'associate', 'Collaborator'],
  ['UTESTPA', 'Pan Person', 'pan@example.com', null, 'Visitor'],
  ['UTESTNW', 'Nell New', 'new@example.com', undefined, ''],
];
const STAND_IN_WHO = [
  'Any member of BOLD is a **BOLDie**.',
  '', '#### BOLD-exec', '- **Who**: the PIs', '- **Requirements**:', '  - Shape BOLD',
  '', '#### BOLD-internal', '- **Who**: PhD students and staff', '- **Privilege**:', '  - Access to the PIs for supervision',
  '- **Requirements**:', '  - Takes an active part in shaping and running BOLD', '  - Presents in the group meeting when it’s their turn',
  '', '#### BOLD-associate', '- **Who**: collaborators', '- **Requirements**:', '  - Contribute to research, operations, or funding',
  '', '#### PAN-BOLD', '- All members of the BOLD Slack', '- **Requirements**:', '  - Follow the Collaboration Etiquette',
].join('\n');
const LEVEL = (v, e) => ({ view: v, edit: e });

(async () => {
  const b = db.batch();
  const set = (p, d) => b.set(db.doc(p), d);
  set('roles/pis', { emails: ['pi@example.com'] });
  set('roles/admins', { emails: [] });
  set('settings/access', { pages: {
    boldiquette: LEVEL('everyone', 'internal'), profile: LEVEL('everyone', 'everyone'), 'get-started': LEVEL('everyone', 'associate'),
    projects: LEVEL('internal', 'associate'), events: LEVEL('everyone', 'internal'), calendar: LEVEL('internal', 'internal'),
    people: LEVEL('internal', 'internal'), requests: LEVEL('internal', 'internal'), 'service-desk': LEVEL('associate', 'associate'),
    guides: LEVEL('internal', 'internal'), agents: LEVEL('internal', 'internal'), tools: LEVEL('internal', 'internal'), skills: LEVEL('internal', 'internal'),
    'ml-cycle': LEVEL('internal', 'internal'), search: LEVEL('internal', 'internal'), changelog: LEVEL('internal', 'internal'),
  } });
  for (const [id, name, email, category, role] of people) {
    set('people/' + id, { name, email, slackId: id });
    if (category === undefined) continue;   // Nell: no record yet
    const m = { name, email, role, institution: 'UCL', interests: 'reinforcement learning', pillars: ['Core Algorithmic Innovation Questioning the Foundations of the Field'],
      startDate: '2026-10-01', contact: 'Pat PI', invitedBy: { email: 'pi@example.com', name: 'Pat PI', status: 'confirmed' } };
    if (role !== 'PI' && role !== 'Collaborator') m.endDate = '2029-09-30';
    if (category) m.category = category;
    if (role === 'PI') { delete m.invitedBy; m.contact = ''; }
    set('members/' + email, m);
  }
  let parts = [{ id: 'who-is-bold', section: 'People', title: 'Who is BOLD', body: STAND_IN_WHO }];
  if (process.env.BOLDIQUETTE_PARTS) {
    const j = JSON.parse(fs.readFileSync(process.env.BOLDIQUETTE_PARTS, 'utf8'));
    parts = (j.parts || j).map((p) => ({ id: p.id, section: p.section || '', title: p.title || '', body: p.body || '' }));
  }
  set('handbook/boldiquette', { title: 'BOLDiquette', description: 'The local test copy’s BOLDiquette.', parts });
  set('guides/get-started-at-bold', { title: 'Get started at BOLD', description: 'Getting set up at BOLD.', parts: [
    { id: 'everyone', section: 'BOLD', title: 'Checklist', body: '- Ask to join on BOLD.OS\n- Fill in your profile\n- Read the BOLDiquette' }] });
  const meeting = (day) => ({ day, time: '15:00', minutes: 60, every: 1 });
  set('eventSeries/reading-group', { id: 'reading-group', kind: 'meeting', title: 'BOLD Reading Group', description: 'Papers, every week.', hidden: false, visibleTo: 'internal',
    invite: { mode: 'join' }, requiredFor: 'internal', meeting: meeting('TH'), joined: ['internal@example.com'], organisers: ['pi@example.com'], createdBy: 'pi@example.com' });
  set('eventSeries/group-meeting', { id: 'group-meeting', kind: 'meeting', title: 'Group meeting', description: 'The lab, every week.', hidden: false, visibleTo: 'internal',
    invite: { mode: 'join' }, requiredFor: 'internal', meeting: meeting('MO'), joined: ['internal@example.com'], organisers: ['pi@example.com'], createdBy: 'pi@example.com' });
  set('eventSeries/hamming', { id: 'hamming', kind: 'meeting', title: 'Hamming Sessions', description: 'What are the important problems?', hidden: false, visibleTo: 'internal',
    invite: { mode: 'group', group: 'internal' }, requiredFor: 'internal', meeting: meeting('WE'), joined: [], organisers: ['pi@example.com'], createdBy: 'pi@example.com' });
  // Who sees which (visibleTo): the Festival anyone, even signed out; Collaboration week associates and above.
  set('eventSeries/bold-festival', { id: 'bold-festival', kind: 'editions', title: 'Festival', description: 'BOLD’s festival.', hidden: false, visibleTo: 'public',
    cadence: { every: 12, unit: 'month' }, inviteGroup: 'none', joined: [], organisers: ['pi@example.com'], createdBy: 'pi@example.com' });
  set('events/bold-festival-2027-06-01', { slug: 'bold-festival-2027-06-01', series: 'bold-festival', title: 'Festival', hidden: false, visibleTo: 'public', startDate: '2027-06-01', endDate: '2027-06-03', place: 'Oxford', createdBy: 'pi@example.com' });
  set('eventSeries/collaboration-week', { id: 'collaboration-week', kind: 'editions', title: 'Collaboration week', description: 'A week of working together.', hidden: false, visibleTo: 'associate',
    cadence: { every: 12, unit: 'month' }, inviteGroup: 'associate', joined: [], organisers: ['pi@example.com'], createdBy: 'pi@example.com' });
  set('events/collaboration-week-2027-03-01', { slug: 'collaboration-week-2027-03-01', series: 'collaboration-week', title: 'Collaboration week', hidden: false, visibleTo: 'associate', startDate: '2027-03-01', endDate: '2027-03-05', place: 'London', createdBy: 'pi@example.com' });
  const card = (title, by, name) => ({ title, pid: title.toLowerCase().replace(/\W+/g, '-'), submittedBy: { name, email: by }, authors: [{ name, email: by }], authorEmails: [by],
    keywords: ['rl'], badges: [], abstract: 'A made-up project for the test copy.', status: 'ongoing', createdAt: Date.now() });
  set('projects/diverging-runs', card('Diverging runs', 'internal@example.com', 'Ines Internal'));
  set('projectWorkspaces/diverging-runs', { members: ['internal@example.com', 'associate@example.com'], joined: ['associate@example.com'], startedAt: Date.now() });
  set('projects/world-models', card('World models', 'pi@example.com', 'Pat PI'));
  set('projectWorkspaces/world-models', { members: ['pi@example.com'], joined: [], startedAt: Date.now() });
  await b.commit();
  console.log('Seeded the demo project: 5 accounts, Who is BOLD (' + (process.env.BOLDIQUETTE_PARTS ? 'the real one, from your file' : 'a stand-in') + '), 5 series, 2 events, 2 projects.');
})().catch((e) => { console.error(e); process.exit(1); });
