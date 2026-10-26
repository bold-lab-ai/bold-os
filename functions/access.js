'use strict';

// Who can see what (BOLDiquette › People › Who can see what): for each page, the lowest
// group of Who is BOLD that can see it and that can change it. Whether a change takes effect
// at once or is a proposal someone reviews is the page's (REVIEWED), not the table's. The table
// is a part of the BOLDiquette (ACCESS_PART); accepting a change to it (decideProposal)
// parses it here and saves the result in settings/access, which the rules
// (firebase/firestore.rules need()), the functions (requireAccess) and the pages
// (bold.js BOLD.can) read. Only PIs and admins propose changes to it.

const ACCESS_PART = 'access';

// The pages, as the table names them. A page missing from the table is BOLD-internal.
const PAGES = [
  ['boldiquette', 'BOLDiquette'],
  ['projects', 'Projects'],
  ['profile', 'Your profile'],
  ['calendar', 'Calendar'],
  ['ml-cycle', 'ML Conference Cycle'],
  ['people', 'People'],
  ['requests', 'Requests'],
  ['events', 'Events'],
  ['agents', 'Agents'],
  ['tools', 'Tools'],
  ['skills', 'Skills'],
  ['guides', 'How to'],
  ['service-desk', 'Service desk'],
  ['search', 'Search'],
  ['changelog', 'Changes'],
];
const WHAT = ['view', 'change'];
// Pages where every change is a proposal (and commenting is part of it): changing them is proposing.
const REVIEWED = ['boldiquette', 'guides', 'skills', 'tools'];
// edit / propose (callers, older tables) → change.
const whatOf = (what) => what === 'view' ? 'view' : 'change';

// Each group can do everything the groups below it can. `everyone` includes people who
// aren't signed in; `none` is nobody (the page has no such action).
const LEVELS = ['everyone', 'pan', 'associate', 'internal', 'staff', 'exec', 'none'];
const LEVEL_NAMES = { everyone: 'Everyone', pan: 'PAN-BOLD', associate: 'BOLD-associate', internal: 'BOLD-internal', staff: 'BOLD-staff', exec: 'BOLD-exec', none: '—' };
const DEFAULT_LEVEL = 'internal';
function rank(level){ const i = LEVELS.indexOf(level); return i < 0 ? LEVELS.indexOf(DEFAULT_LEVEL) : i; }

// The starting table (BOLDiquette text and settings/access agree on it).
const DEFAULT_PAGES = {
  boldiquette: { view: 'everyone', change: 'internal' },
  projects: { view: 'associate', change: 'associate' },
  profile: { view: 'pan', change: 'pan' },
};
PAGES.forEach(([key]) => { if (!DEFAULT_PAGES[key]) DEFAULT_PAGES[key] = { view: 'internal', change: 'internal' }; });

const norm = (s) => String(s || '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase();

// Pure: the table's Markdown → { <page>: { view, change } }, or throws an Error saying
// which row is wrong. Rows: | Page | See | Change |; other text is ignored. A row as the
// table first was (| Page | View | Edit | Propose |) reads as See, and Change from Propose on
// a REVIEWED page and from Edit elsewhere.
function parseAccessTable(body){
  const byName = {}; PAGES.forEach(([key, name]) => { byName[norm(name)] = key; });
  const byLevel = {}; LEVELS.forEach((l) => { byLevel[norm(LEVEL_NAMES[l])] = l; });
  byLevel['-'] = byLevel['–'] = byLevel[''] = 'none';
  const out = {};
  String(body || '').split('\n').forEach((line) => {
    if (!/^\s*\|/.test(line)) return;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) return;   // the |---| line
    if (norm(cells[0]) === 'page') return;                   // the header
    const key = byName[norm(cells[0])];
    if (!key) throw new Error('“' + cells[0] + '” isn’t a page (the pages: ' + PAGES.map((p) => p[1]).join(', ') + ').');
    if (out[key]) throw new Error(cells[0] + ' is in the table twice.');
    if (cells.length < 3) throw new Error(cells[0] + ' needs See and Change.');
    const levels = cells.slice(1, cells.length >= 4 ? 4 : 3).map((c) => {
      const level = byLevel[norm(c)];
      if (!level) throw new Error(cells[0] + ': “' + c + '” isn’t a group (' + LEVELS.map((l) => LEVEL_NAMES[l]).join(', ') + ').');
      return level;
    });
    out[key] = { view: levels[0], change: levels.length === 3 ? levels[REVIEWED.indexOf(key) >= 0 ? 2 : 1] : levels[1] };
  });
  if (!Object.keys(out).length) throw new Error('The table has no pages.');
  if (out.profile && rank(out.profile.view) > rank('pan')) throw new Error('Your profile must stay open to PAN-BOLD: it’s where people ask for another group.');
  if (out.boldiquette && out.boldiquette.view !== 'everyone' && rank(out.boldiquette.view) > rank('pan')) throw new Error('The BOLDiquette must stay open to PAN-BOLD.');
  // A page left out keeps the default (BOLD-internal), as the rules have it.
  return out;
}

// Pure: the table as Markdown, for the BOLDiquette (the starting text).
function accessTableMarkdown(pages){
  pages = pages || DEFAULT_PAGES;
  return '| Page | See | Change |\n|---|---|---|\n' +
    PAGES.map(([key, name]) => '| ' + name + ' | ' + WHAT.map((w) => LEVEL_NAMES[(pages[key] || {})[w] || DEFAULT_LEVEL]).join(' | ') + ' |').join('\n');
}

module.exports = function access({ db, groupOf, isFullWrite, HttpsError }){
  let cache = null, cachedAt = 0;
  async function table(){
    if (cache && Date.now() - cachedAt < 60000) return cache;
    const snap = await db.collection('settings').doc('access').get();
    cache = (snap.exists && snap.data().pages) || DEFAULT_PAGES; cachedAt = Date.now();
    return cache;
  }
  // email → their group ('pan' without a members doc; PIs and admins count as BOLD-exec,
  // as in the rules).
  async function groupFor(email){
    if (!email) return 'everyone';
    if (await isFullWrite(email)) return 'exec';
    const snap = await db.collection('members').doc(String(email).toLowerCase()).get();
    return groupOf(snap.exists ? snap.data() : null);
  }
  // Whether `email` (null: not signed in) may `what` on `page`.
  // A table's level for `what` (view | change; edit and propose are change).
  async function levelOf(page, what){
    const p = (await table())[page] || {}, w = whatOf(what);
    return p[w] || (w === 'change' && (REVIEWED.indexOf(page) >= 0 ? p.propose : p.edit)) || DEFAULT_LEVEL;
  }
  async function can(email, page, what){
    const level = await levelOf(page, what);
    if (level === 'none') return false;
    return rank(await groupFor(email)) >= rank(level);
  }
  // Throws permission-denied unless they may.
  async function requireAccess(email, page, what){
    if (await can(email, page, what)) return;
    const level = await levelOf(page, what);
    const name = (PAGES.filter((p) => p[0] === page)[0] || [page, page])[1];
    throw new HttpsError('permission-denied', level === 'none' ? 'Nobody can do this on ' + name + '.'
      : name + ' is for ' + LEVEL_NAMES[level] + ' and above (BOLDiquette › Who can see what).');
  }
  // For decideProposal: a BOLDiquette proposal changing the table. `before` and `after`
  // are the BOLDiquette's parts; → the new table to save, or null if it didn't change.
  async function checkTableChange(before, after, proposerEmail){
    const part = (parts) => (parts || []).filter((p) => p && p.id === ACCESS_PART)[0] || null;
    const a = part(before), b = part(after);
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (!(await isFullWrite(proposerEmail))) throw new HttpsError('permission-denied', 'Only PIs and admins can change who can see what.');
    if (!b) throw new HttpsError('failed-precondition', 'Who can see what can’t be removed: the site uses it.');
    try { return parseAccessTable(b.body); }
    catch (err) { throw new HttpsError('failed-precondition', 'Who can see what can’t be read: ' + err.message); }
  }
  return { table, groupFor, can, requireAccess, checkTableChange, forget(){ cache = null; } };
};
Object.assign(module.exports, { ACCESS_PART, PAGES, LEVELS, LEVEL_NAMES, DEFAULT_PAGES, REVIEWED, parseAccessTable, accessTableMarkdown, rank });
