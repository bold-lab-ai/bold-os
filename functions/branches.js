'use strict';
// Branches of the site (#324, 2026-11-11): every change to the BOLDiquette, a guide, a skill or a tool is made
// on a branch, as on GitHub. A branch (branches/{id}: { title, description, status open | accepted | declined |
// withdrawn | draft, by, at, contributors, pages, editedAt, decidedBy… }) is a proposal of the whole site (or, as a
// draft, not yet: Save draft opens one; nobody is told and it can't be decided until it's marked ready): each page it
// changes keeps its part of it where that page's proposals live, under the branch's own id
// (<collection>/<slug>/proposals/<branch id>, `branch: <id>`): on the BOLDiquette and the guides a batch whose
// changes are its commits, each with who made it and when; on a skill or tool the whole of it as proposed, its
// commits listed. Anyone who can edit a page commits to any open branch (branchCommit, the server only: the
// rules allow no client writes); a PI or admin who hasn't committed to it accepts or declines it, all its pages
// together or none (decideBranch); its author or a PI withdraws it. The pages are drawn as the branch you're
// on makes them (bold.js BOLD.branch), and each branch has its page, as a pull request (proposal.html?b=<id>).

const MAX_COMMITS = 50, MAX_PAGES = 20, MAX_TITLE = 120, MAX_DESCRIPTION = 5000, MAX_NOTE = 300, MAX_SIZE = 400000;
const ID = /^[A-Za-z0-9]{1,40}$/, SLUG = /^[a-z0-9_-]{1,64}$/, PART = /^[A-Za-z0-9_-]{1,64}$/;
const PART_KINDS = ['about', 'edit', 'add', 'remove', 'move', 'restore', 'access'];
const WHOLE = { skills: ['skill', 'new'], agentTools: ['tool', 'new', 'delete'] };
const WHOLE_KEYS = { skills: ['title', 'description', 'body', 'files'], agentTools: ['title', 'description', 'acting', 'input', 'code'] };
const COLLECTIONS = ['handbook', 'guides', 'skills', 'agentTools'];

class BranchError extends Error { constructor(code, message){ super(message); this.code = code; } }
const bad = (m) => new BranchError('invalid-argument', m);

// Pure: a page a branch can change, 'collection/slug', or null.
function pageKey(collection, slug){
  collection = String(collection || ''); slug = String(slug || '');
  if (COLLECTIONS.indexOf(collection) < 0 || !SLUG.test(slug)) return null;
  if (collection === 'handbook' && slug !== 'boldiquette') return null;
  return collection + '/' + slug;
}
// Pure: its area in Who can see what.
function areaOf(page, guideArea){
  const [collection, slug] = page.split('/');
  return collection === 'handbook' ? 'boldiquette' : collection === 'guides' ? guideArea(slug) : collection === 'skills' ? 'skills' : 'tools';
}
// Pure: whether a page keeps its parts (a batch of changes) or the whole of it (a skill, a tool).
const isWhole = (page) => /^(skills|agentTools)\//.test(page);

const text = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const orNull = (v) => (v === undefined ? null : v);

// Pure: a commit asked for, checked as the rules checked proposals → { kind, partId, area?, before, after, note }.
function validChange(page, c){
  if (!isMap(c)) throw bad('No change given.');
  const collection = page.split('/')[0], note = text(c.note, MAX_NOTE);
  if (!note) throw bad('Say what you changed and why, for whoever reviews it.');
  if (JSON.stringify(c).length > MAX_SIZE) throw bad('That change is too big.');
  if (isWhole(page)) {
    if (WHOLE[collection].indexOf(c.kind) < 0) throw bad('Unknown kind of change.');
    if (c.kind === 'delete') return { kind: 'delete', partId: '', before: orNull(c.before), after: null, note };
    if (!isMap(c.after) || Object.keys(c.after).some((k) => WHOLE_KEYS[collection].indexOf(k) < 0)) throw bad('That isn’t a ' + (collection === 'skills' ? 'skill' : 'tool') + '.');
    return { kind: c.kind, partId: '', before: orNull(c.before), after: c.after, note };
  }
  if (PART_KINDS.indexOf(c.kind) < 0 || (c.kind === 'access' && page !== 'handbook/boldiquette')) throw bad('Unknown kind of change.');
  const partId = String(c.partId || '');
  if (partId && !PART.test(partId)) throw bad('Which part?');
  if (['edit', 'add', 'remove', 'move'].indexOf(c.kind) >= 0 && !partId) throw bad('Which part?');
  if (c.before != null && !isMap(c.before)) throw bad('That isn’t a change.');
  if (c.after != null && !isMap(c.after)) throw bad('That isn’t a change.');
  const out = { kind: c.kind, partId, before: orNull(c.before), after: orNull(c.after), note };
  if (c.kind === 'access') {
    const a = c.after || {};
    if (typeof c.area !== 'string' || c.area.length > 40 || typeof a.view !== 'string' || typeof a.edit !== 'string') throw bad('That isn’t a page and its groups.');
    out.area = c.area; out.partId = 'access';
  }
  return out;
}

// Pure: a page's part of a branch with commit c added (prop: what it was, or null) → the proposal doc to save.
// status: the branch's, open or draft.
function withCommit(prop, page, branchId, c, by, at, status){
  const head = { by: prop ? prop.by : by, at: prop ? prop.at : at, status: status || 'open', branch: branchId, editedAt: at, note: prop ? (prop.note || c.note) : c.note };
  const commit = Object.assign({}, c, { by, at });
  if (isWhole(page)) {
    const commits = ((prop && prop.commits) || []).concat([{ kind: c.kind, after: c.after, note: c.note, by, at }]);
    if (commits.length > MAX_COMMITS) throw new BranchError('failed-precondition', 'A branch holds ' + MAX_COMMITS + ' commits to a page at most.');
    // A new skill or tool stays new however it's changed after; a removal is the last word until changed again.
    const kind = prop && prop.kind === 'new' && c.kind !== 'delete' ? 'new' : c.kind;
    return Object.assign(head, { kind, partId: '', before: prop ? orNull(prop.before) : c.before, after: c.after, commits });
  }
  const changes = ((prop && prop.changes) || []).concat([commit]);
  if (changes.length > MAX_COMMITS) throw new BranchError('failed-precondition', 'A branch holds ' + MAX_COMMITS + ' commits to a page at most.');
  return Object.assign(head, { kind: 'batch', partId: '', before: null, after: null, changes });
}

// Pure: why `email` can't accept or decline branch b ('' if they can).
function cannotDecide(b, email, full){
  if (!full) return 'Only PIs and admins can do this.';
  if (b && b.status === 'draft') return 'It’s a draft: it’s marked ready for review first.';
  if (!b || b.status !== 'open') return 'It has already been decided.';
  if ((b.contributors || []).indexOf(String(email || '').toLowerCase()) >= 0) return 'You’ve committed to it: another PI or admin reviews it.';
  return '';
}
const isOpen = (b) => !!b && (b.status === 'open' || b.status === 'draft');
const canWithdraw = (b, email, full) => isOpen(b) && (full || (b.by && String(b.by.email || '').toLowerCase() === String(email || '').toLowerCase()));

// Pure: every commit on a branch, oldest first → [{ page, kind, partId, note, by, at, i }] (i: its place on its page).
function commitsOf(props){
  const out = [];
  Object.keys(props || {}).forEach((page) => {
    const q = props[page];
    if (!q) return;
    const list = isWhole(page) ? (q.commits || [{ kind: q.kind, after: q.after, note: q.note, by: q.by, at: q.at }]) : q.kind === 'batch' ? (q.changes || []) : [q];
    list.forEach((c, i) => out.push({ page, kind: c.kind, partId: c.partId || '', note: c.note || '', by: c.by || q.by || null, at: c.at || q.at || 0, i }));
  });
  return out.sort((a, b) => a.at - b.at || (a.page < b.page ? -1 : a.page > b.page ? 1 : a.i - b.i));
}

// Pure: a page's part of a branch rebased on main (its commits replayed on the page as it is now, by whoever has
// committed to it: pages/guide.js): the same commits, in order, each checked again, keeping who made it and when.
function rebased(prop, page, changes, at){
  if (!prop || (prop.status !== 'open' && prop.status !== 'draft')) throw new BranchError('failed-precondition', 'It has been decided.');
  if (isWhole(page) || prop.kind !== 'batch') throw bad('Only the BOLDiquette’s and the guides’ changes are rebased.');
  const had = prop.changes || [];
  if (!Array.isArray(changes) || changes.length !== had.length) throw bad('The rebase doesn’t match its commits: look again.');
  const out = changes.map((c, i) => {
    if (!c || c.kind !== had[i].kind || String(c.partId || '') !== String(had[i].partId || '')) throw bad('The rebase doesn’t match its commits: look again.');
    const v = validChange(page, Object.assign({}, c, { note: had[i].note || 'Change' }));
    return Object.assign(v, { note: had[i].note || '', by: had[i].by || prop.by, at: had[i].at || prop.at });
  });
  return Object.assign({}, prop, { changes: out, editedAt: at });
}

module.exports = { rebased, isOpen, MAX_COMMITS, MAX_PAGES, MAX_TITLE, MAX_DESCRIPTION, ID, BranchError, pageKey, areaOf, isWhole, validChange, withCommit, cannotDecide, canWithdraw, commitsOf, text };
