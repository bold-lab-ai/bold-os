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
// Sam's link to the changes Pat proposed (joinChanges' key; hex, as join.html reads it).
const DEMO_JOIN_KEY = 'dec0de0c0ffee';

(async () => {
  const b = db.batch();
  const set = (p, d) => b.set(db.doc(p), d);
  set('roles/pis', { emails: ['pi@example.com'] });
  set('roles/admins', { emails: [] });
  set('peerAmbassadors/internal@example.com', { active: true, name: 'Ines Internal', bio: 'Demo ambassador', slackId: 'UTESTIN', notifyNewJoiners: false });
  // As on BOLD.OS since 2026-11-06 (the BOLDiquette's Who can do what): everyone signed in sees everything.
  set('settings/access', { pages: {
    'peer-support': LEVEL('everyone', 'everyone'), boldiquette: LEVEL('everyone', 'internal'), profile: LEVEL('everyone', 'everyone'), 'get-started': LEVEL('everyone', 'associate'),
    projects: LEVEL('everyone', 'everyone'), events: LEVEL('everyone', 'internal'), calendar: LEVEL('everyone', 'associate'),
    people: LEVEL('everyone', 'internal'), requests: LEVEL('everyone', 'internal'), 'service-desk': LEVEL('everyone', 'associate'),
    guides: LEVEL('everyone', 'internal'), agents: LEVEL('everyone', 'internal'), tools: LEVEL('everyone', 'internal'), skills: LEVEL('everyone', 'internal'),
    'ml-cycle': LEVEL('everyone', 'internal'), search: LEVEL('everyone', 'internal'), changelog: LEVEL('everyone', 'internal'),
    experimental: LEVEL('everyone', 'associate'), conversations: LEVEL('everyone', 'associate'),
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
  // Moves between groups, for Network's Lineage: Ines asked for BOLD-associate, then a PI moved her up on People.
  const day = 86400000, t0 = Date.now() - 30 * day;
  set('groupRequests/seed-ines', { email: 'internal@example.com', name: 'Ines Internal', from: 'pan', to: 'associate', note: '', terms: 'Stand-in terms.', acceptedAt: t0, status: 'approved', at: t0, decidedBy: 'pi@example.com', decidedByName: 'Pat PI', decidedAt: t0 + day });
  set('groupMoves/seed-ines', { email: 'internal@example.com', from: 'associate', to: 'internal', by: 'pi@example.com', at: t0 + 10 * day, via: '' });
  set('groupRequests/seed-ari', { email: 'associate@example.com', name: 'Ari Associate', from: 'pan', to: 'associate', note: '', terms: 'Stand-in terms.', acceptedAt: t0, status: 'approved', at: t0, decidedBy: 'pi@example.com', decidedByName: 'Pat PI', decidedAt: t0 + 2 * day });
  // Requests to join BOLD naming Pat as inviting them (Requests › Sign up, as Pat PI): Robin's to try
  // Propose changes on (#261); Sam's with changes proposed already, its applicant's link printed below
  // (a fixed demo key: the test copy has no Gmail to send it).
  const joinPat = { id: 'UTESTPI', name: 'Pat PI', email: 'pi@example.com', status: 'pending' };
  set('joinRequests/seedrobin', { name: 'Robin Rivers', email: 'robin@example.com', institution: 'Imperial', role: 'Visitor', contact: 'Pat PI', contactEmail: 'pi@example.com',
    invitedBy: joinPat, interests: 'world models, robotics', basedIn: 'London', pronouns: 'they/them', links: 'https://example.com/robin', startDate: '2026-11-15', endDate: '2027-02-15',
    pillars: ['Robust Adaptation and Learning incl. in Embodied Envs (RL, Open-Ended Learning, Robotics)'], listOnWebsite: false, feedback: 'balanced', status: 'open', at: Date.now() - 2 * day });
  set('joinRequests/seedsam', { name: 'Sam Second', email: 'sam@example.com', institution: 'UCL', role: 'Visitor', contact: 'Pat PI', contactEmail: 'pi@example.com',
    invitedBy: joinPat, interests: 'multi-agent RL', basedIn: 'London', startDate: '2026-11-10', endDate: '', pillars: [], listOnWebsite: false, feedback: '', status: 'open', at: Date.now() - 3 * day,
    changes: { status: 'asked', proposed: { role: 'PhD student', endDate: '2030-09-30' }, note: 'You’re starting your PhD with us, so let’s have you as a PhD student.', by: 'pi@example.com', byName: 'Pat PI',
      at: Date.now() - day, keyHash: require('crypto').createHash('sha256').update(DEMO_JOIN_KEY).digest('hex'), emailed: true, error: '' } });
  // A test account (Linked accounts) of Pat's: on no graph (#227).
  set('people/UTESTTA', { name: 'Pat PI (test)', email: 'pat.test@example.com', slackId: 'UTESTTA' });
  set('members/pat.test@example.com', { name: 'Pat PI (test)', email: 'pat.test@example.com', test: true, testOf: 'pi@example.com', category: 'pan', categoryBy: 'pi@example.com', categoryAt: t0,
    invitedBy: { email: 'pi@example.com', name: 'Pat PI', status: 'confirmed' } });
  // A conversation that runs on, then branches (Conversations' blocks).
  const msg = (id, parent, who, name, body, mins) => set('conversations/seed-chat/messages/' + id, { parent, body, name, createdBy: who, at: Date.now() - mins * 60000, source: 'bold', viaAgent: false, votes: {}, private: false });
  set('conversations/seed-chat', { title: 'Should we pool compute for the Q1 runs?', body: 'Three projects need big runs in January. One booking, or each their own?', name: 'Ines Internal', createdBy: 'internal@example.com',
    at: Date.now() - 300 * 60000, source: 'bold', viaAgent: false, votes: {}, replies: 6, private: false });
  msg('m1', 'seed-chat', 'pi@example.com', 'Pat PI', 'One booking: it’s cheaper, and we can share the queue.', 290);
  msg('m2', 'm1', 'associate@example.com', 'Ari Associate', 'Who decides the order of the runs, then?', 280);
  msg('m3', 'm2', 'internal@example.com', 'Ines Internal', 'Deadlines first, then whoever booked earliest.', 270);
  msg('m4', 'm3', 'pi@example.com', 'Pat PI', 'Fine by me. And for runs with no deadline?', 260);
  msg('m5', 'm4', 'associate@example.com', 'Ari Associate', 'Round robin, a day each.', 250);
  msg('m6', 'm4', 'internal@example.com', 'Ines Internal', 'Or by how long they’ve waited.', 240);
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
  console.log('Seeded the demo project: 5 accounts, Who is BOLD (' + (process.env.BOLDIQUETTE_PARTS ? 'the real one, from your file' : 'a stand-in') + '), 5 series, 2 events, 2 projects, 2 requests to join (Pat decides them).');
  console.log('Sam’s link to the changes Pat proposed: http://localhost:8150/join.html?changes=seedsam&key=' + DEMO_JOIN_KEY);
})().catch((e) => { console.error(e); process.exit(1); });
