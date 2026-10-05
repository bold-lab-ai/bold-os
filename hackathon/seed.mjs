// Fills the local Firestore emulator with made-up data, so a fresh hackathon
// setup isn't empty. Run with the emulators up: `npm run seed -- <your email>`.
// Safe to re-run (it overwrites the same documents). Talks only to
// localhost:8080 — never to production. Everyone here is fictional (@bold.test);
// the emails you pass on the command line become PIs in your local database
// only, so you can sign in with Slack and use every feature.
import fs from 'node:fs';
import vm from 'node:vm';

const PROJECT = 'bold-d7ff2';
const BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

// The site's own card model, so seeded cards have exactly the shape the app writes.
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../src/assets/js/card-model.js', import.meta.url), 'utf8'), ctx);
const { makeRegisteredCard } = ctx;

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
  return { stringValue: String(v) };
}

async function put(path, data) {
  // "Bearer owner" is the emulator's admin bypass: writes skip the Security Rules.
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}

const people = [
  { name: 'Ada Pi', email: 'pi@bold.test' },
  { name: 'Grace Admin', email: 'admin@bold.test' },
  { name: 'Alan Senior', email: 'senior@bold.test' },
  { name: 'Katherine Junior', email: 'junior@bold.test' },
  { name: 'Barbara Student', email: 'student@bold.test' },
  { name: 'Edsger Postdoc', email: 'postdoc@bold.test' },
  { name: 'Margaret Engineer', email: 'engineer@bold.test' },
  { name: 'Claude Visitor', email: 'visitor@bold.test' },
];

// Your own Slack email(s), from the command line — never written to the repo.
const me = process.argv.slice(2).map((e) => e.trim().toLowerCase()).filter(Boolean);

const now = Date.now();
const day = 24 * 3600 * 1000;
const iso = (offsetDays) => new Date(now + offsetDays * day).toISOString().slice(0, 10);

async function main() {
  try { await fetch('http://127.0.0.1:8080/'); } catch {
    console.error('Firestore emulator not reachable on localhost:8080 — run `npm run emulators` first.');
    process.exit(1);
  }

  for (const [i, p] of people.entries()) await put(`people/seed-${i}`, { ...p, slackId: null });
  for (const [i, email] of me.entries()) await put(`people/me-${i}`, { name: email.split('@')[0], email, slackId: null });

  // Who counts as PI/admin/senior/junior (the rules read these).
  await put('roles/pis', { emails: ['pi@bold.test', ...me] });
  await put('roles/admins', { emails: ['admin@bold.test'] });
  await put('roles/seniors', { emails: ['senior@bold.test', 'postdoc@bold.test'] });
  await put('roles/juniors', { emails: ['junior@bold.test', 'student@bold.test'] });

  // One venue on the Internal Review Board, with two papers on it.
  await put('boards/iclr-2027', {
    label: 'ICLR 2027', venue: 'ICLR', year: '2027', status: 'approved', createdAt: now,
    website: 'https://iclr.cc', abstractDeadline: iso(10), deadline: iso(17), pitchDay: iso(3),
    reviewsPublicDate: iso(80), rebuttalDeadline: iso(95), notificationDate: iso(120),
    cameraReadyDeadline: iso(140), conferenceDates: 'April 2027', location: 'Somewhere nice',
    maxPapersPerAuthor: null, pageLimit: '9', anonymity: 'double-blind', submissionSystem: 'OpenReview', notes: '',
  });
  const papers = [
    [people[4], 'Open-ended agents that learn to ask for help', ['open-endedness', 'agents']],
    [people[5], 'Evolution strategies at billion-parameter scale', ['evolution strategies', 'optimisation']],
  ];
  for (const [i, [who, title, keywords]] of papers.entries()) {
    const card = makeRegisteredCard(who, { title, keywords, abstractText: `A made-up abstract for "${title}".` }, now - i * day);
    const id = card.id; delete card.id;
    await put(`boards/iclr-2027/cards/${id}`, card);
  }

  // Projects not yet tied to a venue (Projects page).
  const projects = [
    [people[6], 'BOLD.OS: the lab as software', ['tooling'], '#bold-os-hack'],
    [people[2], 'World models for curriculum design', ['world models', 'curricula'], ''],
  ];
  for (const [i, [who, title, keywords, slackChannel]] of projects.entries()) {
    const card = makeRegisteredCard(who, { title, keywords, slackChannel, abstractText: '' }, now - (i + 3) * day);
    const id = card.id; delete card.id;
    await put(`projects/${id}`, card);
  }

  // Collaboration Week proposals (Proposals tab).
  await put('collabWeekProposals/seed-1', {
    contributionType: 'Workshop', title: 'Hacking the lab OS', timeLocation: 'Any afternoon',
    chair: 'Margaret Engineer', overallDescription: 'Build the feature you wish BOLD.OS had.',
    name: 'Margaret Engineer', email: 'engineer@bold.test', createdAt: now - day,
  });
  await put('collabWeekProposals/seed-2', {
    contributionType: 'Project pitch', title: 'A benchmark for asking good questions', duration: '10 min',
    abstract: 'Agents that know what they do not know.', name: 'Barbara Student', email: 'student@bold.test', createdAt: now,
  });

  console.log(`Seeded ${people.length} people, 4 roles, 1 venue with ${papers.length} papers, ${projects.length} projects, 2 proposals.`);
  if (me.length) console.log(`PI in your local database: ${me.join(', ')}. Sign in with Slack as that address.`);
  else console.log('No email given, so nobody who can sign in has a role. Re-run: npm run seed -- you@example.com');
}

main().catch((err) => { console.error(err); process.exit(1); });
