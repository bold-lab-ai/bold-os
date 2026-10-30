'use strict';

// Who can see what (BOLDiquette › People › Who can see what): for each page, the lowest
// group of Who is BOLD that can view it and that can edit it. Whether an edit takes effect
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
  ['get-started', 'Get started'],
  ['search', 'Search'],
  ['changelog', 'Changes'],
];
const WHAT = ['view', 'edit'];
// Pages where every change is a proposal (and commenting is part of it): editing them is proposing.
const REVIEWED = ['boldiquette', 'guides', 'skills', 'tools', 'get-started'];
// A guide whose page is in another area than How to's (firestore.rules guideArea, bold.js BOLD.GUIDE_AREAS).
const GUIDE_AREAS = { 'get-started-at-bold': 'get-started' };
const guideArea = (slug) => GUIDE_AREAS[slug] || 'guides';
// propose (callers, older tables) → edit.
const whatOf = (what) => what === 'view' ? 'view' : 'edit';

// Each group can do everything the groups below it can. `everyone` is everyone signed in,
// the same as PAN-BOLD (signing in takes the BOLD Slack); nobody who isn't signed in sees
// anything. `none` is nobody.
const LEVELS = ['everyone', 'pan', 'associate', 'internal', 'staff', 'exec', 'none'];
const LEVEL_NAMES = { out: 'Not signed in', everyone: 'Everyone', pan: 'PAN-BOLD', associate: 'BOLD-associate', internal: 'BOLD-internal', staff: 'BOLD-staff', exec: 'BOLD-exec', none: '—' };
const DEFAULT_LEVEL = 'internal';
const RANKS = { out: 0, everyone: 1, pan: 1, associate: 2, internal: 3, staff: 4, exec: 5, none: 6 };
function rank(level){ return level in RANKS ? RANKS[level] : RANKS[DEFAULT_LEVEL]; }

// The starting table (BOLDiquette text and settings/access agree on it).
const DEFAULT_PAGES = {
  boldiquette: { view: 'everyone', edit: 'internal' },
  projects: { view: 'associate', edit: 'associate' },
  profile: { view: 'everyone', edit: 'everyone' },
  // Get started at BOLD: for everyone who joins, PAN-BOLD included; changed by proposals, as the Service desk.
  'get-started': { view: 'everyone', edit: 'associate' },
};
PAGES.forEach(([key]) => { if (!DEFAULT_PAGES[key]) DEFAULT_PAGES[key] = { view: 'internal', edit: 'internal' }; });

const norm = (s) => String(s || '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase();

// Pure: the table's Markdown → { <page>: { view, edit } }, or throws an Error saying
// which row is wrong. Read: the table headed | Page | View | Edit |; other text, and other
// tables (the part also shows the groups' ranks and the role → group suggestions), are
// ignored. A row as the table first was (| Page | View | Edit | Propose |) reads as View,
// and Edit from Propose on a REVIEWED page and from Edit elsewhere.
function parseAccessTable(body){
  const byName = {}; PAGES.forEach(([key, name]) => { byName[norm(name)] = key; });
  const byLevel = {}; LEVELS.forEach((l) => { byLevel[norm(LEVEL_NAMES[l])] = l; });
  byLevel['-'] = byLevel['–'] = byLevel[''] = 'none';
  const out = {};
  let inTable = false;   // inside the table headed Page
  String(body || '').split('\n').forEach((line) => {
    if (!/^\s*\|/.test(line)) { inTable = false; return; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) return;   // the |---| line
    if (norm(cells[0]) === 'page') { inTable = true; return; }   // its header
    if (!inTable) return;
    const key = byName[norm(cells[0])];
    if (!key) throw new Error('“' + cells[0] + '” isn’t a page (the pages: ' + PAGES.map((p) => p[1]).join(', ') + ').');
    if (out[key]) throw new Error(cells[0] + ' is in the table twice.');
    if (cells.length < 3) throw new Error(cells[0] + ' needs View and Edit.');
    const levels = cells.slice(1, cells.length >= 4 ? 4 : 3).map((c) => {
      const level = byLevel[norm(c)];
      if (!level) throw new Error(cells[0] + ': “' + c + '” isn’t a group (' + LEVELS.map((l) => LEVEL_NAMES[l]).join(', ') + ').');
      return level;
    });
    out[key] = { view: levels[0], edit: levels.length === 3 ? levels[REVIEWED.indexOf(key) >= 0 ? 2 : 1] : levels[1] };
  });
  if (!Object.keys(out).length) throw new Error('The table has no pages.');
  if (out.profile && rank(out.profile.view) > rank('pan')) throw new Error('Your profile must stay open to PAN-BOLD: it’s where people ask for another group.');
  if (out.boldiquette && rank(out.boldiquette.view) > rank('pan')) throw new Error('The BOLDiquette must stay open to PAN-BOLD.');
  // A page left out keeps the default (BOLD-internal), as the rules have it.
  return out;
}

// A proposal from a page's eye chip (bold.js) changes one row: { kind: 'access', area,
// before: { view, edit }, after: { view, edit } }, applied when it's accepted to the table as
// it is then (setAccessRow), so it never undoes another change to the part. Without the part
// yet, accepting it adds the part (accessPartBody), from the table in force.
const ACCESS_INTRO = 'Who can view each page of BOLD.OS, and who can edit it (on the BOLDiquette, How to, Skills and Tools, by proposing). Everyone means everyone signed in; each group can do everything the groups below it can; — is nobody. Only PIs and admins change this table, and who is in which group.';
const pageName = (key) => (PAGES.filter((p) => p[0] === key)[0] || [key, key])[1];
const levelCell = (l) => l === 'none' ? '—' : LEVEL_NAMES[l];
const accessRowMarkdown = (area, lv) => '| ' + pageName(area) + ' | ' + WHAT.map((w) => levelCell(lv[w])).join(' | ') + ' |';
// Pure: the part's body with one page's row set: replaced in the table headed Page, or added
// at its end (or a table added); everything else as it is.
function setAccessRow(body, area, lv){
  let inTable = false, last = -1, done = false;
  const lines = String(body || '').split('\n').map((line, i) => {
    if (!/^\s*\|/.test(line)) { inTable = false; return line; }
    const first = line.trim().replace(/^\||\|$/g, '').split('|')[0];
    if (norm(first) === 'page') { inTable = true; last = i; return line; }
    if (!inTable) return line;
    last = i;
    if (norm(first) === norm(pageName(area))) { done = true; return accessRowMarkdown(area, lv); }
    return line;
  });
  if (!done) {
    if (last === -1) lines.push('', '| Page | View | Edit |', '|---|---|---|', accessRowMarkdown(area, lv));
    else lines.splice(last + 1, 0, accessRowMarkdown(area, lv));
  }
  return lines.join('\n');
}
// Pure: the whole part's body: the introduction and the table, with one row set.
function accessPartBody(pages, area, lv){
  const p = Object.assign({}, DEFAULT_PAGES, pages || {});
  if (area) p[area] = lv;
  return ACCESS_INTRO + '\n\n' + accessTableMarkdown(p);
}
// Pure: what an `access` proposal changes, in words: "who can see Calendar (View and Edit:
// BOLD-internal → BOLD-associate)".
function accessChangeText(area, before, after){
  before = before || {}; after = after || {};
  const name = (l) => l === 'none' ? 'nobody' : LEVEL_NAMES[l] || l;
  const changed = WHAT.filter((w) => before[w] !== after[w]);
  const label = (ws) => ws.map((w) => w === 'view' ? 'View' : 'Edit').join(' and ');
  let what;
  if (!changed.length) what = 'no change';
  else if (changed.length === 2 && before.view === before.edit && after.view === after.edit) what = label(changed) + ': ' + name(before.view) + ' → ' + name(after.view);
  else what = changed.map((w) => label([w]) + ': ' + name(before[w]) + ' → ' + name(after[w])).join('; ');
  return 'who can see ' + pageName(area) + ' (' + what + ')';
}
// Pure: the pages whose rows differ between two bodies of the part (unreadable: null).
function accessRowsChanged(beforeBody, afterBody){
  try {
    const a = beforeBody ? parseAccessTable(beforeBody) : {}, b = parseAccessTable(afterBody);
    return PAGES.map((p) => p[0]).filter((k) => JSON.stringify(a[k] || null) !== JSON.stringify(b[k] || null)).map(pageName);
  } catch (e) { return null; }
}

// Pure: the table as Markdown, for the BOLDiquette (the starting text).
function accessTableMarkdown(pages){
  pages = pages || DEFAULT_PAGES;
  return '| Page | View | Edit |\n|---|---|---|\n' +
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
    if (!email) return 'out';   // not signed in: below every level
    if (await isFullWrite(email)) return 'exec';
    const snap = await db.collection('members').doc(String(email).toLowerCase()).get();
    return groupOf(snap.exists ? snap.data() : null);
  }
  // Whether `email` (null: not signed in) may `what` on `page`.
  // A table's level for `what` (view | edit; propose is edit).
  async function levelOf(page, what){
    const p = (await table())[page] || {}, w = whatOf(what);
    return p[w] || DEFAULT_LEVEL;
  }
  async function can(email, page, what){
    // list: View or Edit (Projects: whoever has Edit without View sees the titles and joins).
    if (what === 'list') return (await can(email, page, 'view')) || can(email, page, 'edit');
    const level = await levelOf(page, what);
    if (level === 'none') return false;
    return rank(await groupFor(email)) >= rank(level);
  }
  async function lowerOf(page){
    const v = await levelOf(page, 'view'), e = await levelOf(page, 'edit');
    return rank(v) <= rank(e) ? v : e;
  }
  // Throws permission-denied unless they may.
  async function requireAccess(email, page, what){
    if (await can(email, page, what)) return;
    const level = what === 'list' ? await lowerOf(page) : await levelOf(page, what);
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
Object.assign(module.exports, { ACCESS_PART, ACCESS_INTRO, setAccessRow, accessPartBody, accessChangeText, accessRowsChanged, PAGES, LEVELS, LEVEL_NAMES, DEFAULT_PAGES, REVIEWED, GUIDE_AREAS, guideArea, parseAccessTable, accessTableMarkdown, rank });
