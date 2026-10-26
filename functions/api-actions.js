// ---------- BOLD.OS for agents: acting (functions/api.js) ----------
// One tool per feature of the site, each with an `action`, for tokens a PI or admin has
// let act. Each does exactly what the page does, as the token's owner:
// - what a page writes to Firestore itself is written as them under the security
//   rules (asUser: a sign-in token for them, then Firestore's REST API), so the rules
//   decide, as on the page;
// - what a page does through a callable goes through that same callable (act).
// So every check, Slack message and version-history entry is the page's own.
// Not here: the Internal Review Board (it saves whole boards at once), files
// (uploading slides) and the site's settings.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The web app's public key (src/_data/site.js): it names the project, grants nothing.
const WEB_API_KEY = 'AIzaSyDNKEMYuV0gehbKoM2acafzVbBQL489yDY';
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/bold-d7ff2/databases/(default)/documents';

// card-model.js, the page's card, copied next to this file on deploy (firebase.json
// predeploy) or read from the site's source when run locally.
let cardModel = null;
function makeRegisteredCard(user, fields){
  if (!cardModel) {
    const here = path.join(__dirname, 'card-model.js'), src = path.join(__dirname, '..', 'src', 'assets', 'js', 'card-model.js');
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(fs.existsSync(here) ? here : src, 'utf8'), ctx);
    cardModel = ctx;
  }
  return cardModel.makeRegisteredCard(user, fields);
}

// JSON → Firestore REST values, and back.
function toValue(v){
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}
function toFields(o){
  const out = {};
  Object.keys(o).forEach((k) => { if (o[k] !== undefined) out[k] = toValue(o[k]); });
  return out;
}

module.exports = function(ctx){
  const { db, admin, logger, httpError, act, resolve, cardOf, lab, words, fold, matches, url, isFullWrite, SITE_URL, fetchImpl, checkTool } = ctx;
  const doFetch = fetchImpl || fetch;

  // ---------- writing as the person, under the rules ----------
  const idTokens = {}; // email → { token, until }
  async function idTokenFor(email){
    const hit = idTokens[email];
    if (hit && hit.until > Date.now()) return hit.token;
    let custom;
    try {
      const user = await admin.auth().getUserByEmail(email);
      custom = await admin.auth().createCustomToken(user.uid);
    } catch (err) {
      logger.error('asUser: no sign-in token', { error: String(err.message || err) });
      throw httpError(503, 'BOLD.OS can’t act as you yet: its server needs permission to sign in for people (an admin grants it the Service Account Token Creator role).');
    }
    const r = await doFetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + WEB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
    });
    const j = await r.json();
    if (!r.ok || !j.idToken) { logger.error('asUser: sign-in failed', { error: JSON.stringify(j).slice(0, 300) }); throw httpError(503, 'BOLD.OS couldn’t sign in as you — try again.'); }
    idTokens[email] = { token: j.idToken, until: Date.now() + 50 * 60000 };
    return j.idToken;
  }
  // A Firestore write as `who`: create (auto id, or `id`), set (replace), update (these
  // fields of an existing document) or delete. → the document's id.
  async function asUser(who, op, docPath, data, id){
    const token = await idTokenFor(who.email);
    let endpoint = FIRESTORE + '/' + docPath, method = 'PATCH', body = null;
    if (op === 'create') { method = 'POST'; if (id) endpoint += '?documentId=' + encodeURIComponent(id); body = { fields: toFields(data) }; }
    else if (op === 'set') body = { fields: toFields(data) };
    else if (op === 'update') {
      endpoint += '?' + Object.keys(data).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&') + '&currentDocument.exists=true';
      body = { fields: toFields(data) };
    } else if (op === 'delete') method = 'DELETE';
    const r = await doFetch(endpoint, { method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.ok) { const j = method === 'DELETE' ? {} : await r.json(); return j.name ? j.name.split('/').pop() : docPath.split('/').pop(); }
    const j = await r.json().catch(() => ({}));
    const status = (j.error && j.error.status) || '';
    if (status === 'PERMISSION_DENIED') throw httpError(403, 'BOLD.OS’s rules don’t let you do that (as on the page).');
    if (status === 'NOT_FOUND') throw httpError(404, 'That isn’t there any more.');
    if (status === 'ALREADY_EXISTS') throw httpError(409, 'That already exists.');
    logger.error('asUser: write failed', { op, docPath, status: r.status, error: JSON.stringify(j).slice(0, 300) });
    throw httpError(400, 'That didn’t work: ' + ((j.error && j.error.message) || r.status));
  }

  const need = (v, what) => { if (v === undefined || v === null || String(v).trim() === '') throw httpError(400, 'Give ' + what + '.'); return typeof v === 'string' ? v.trim() : v; };
  const http = (u) => { if (u && !/^https?:\/\/\S+$/.test(u)) throw httpError(400, 'Links start with https://: ' + u); return u || ''; };
  const iso = (d, what) => { if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw httpError(400, 'Give ' + what + ' as YYYY-MM-DD.'); return d || ''; };
  const ACTIONS = (list) => ({ type: 'string', enum: list });
  const nameOfMe = (who) => who.name || who.email;

  // ---------- the BOLDiquette and the guides: a page ----------
  // page: 'boldiquette' or a guide's slug → { col, slug, ref, data }.
  async function pageOf(page){
    const p = String(page || '').trim();
    if (!/^[a-z0-9-]{1,80}$/.test(p)) throw httpError(400, 'Give the page: "boldiquette" or a guide’s slug (from search or read_page).');
    const col = p === 'boldiquette' ? 'handbook' : 'guides';
    const snap = await db.collection(col).doc(p).get();
    if (!snap.exists) throw httpError(404, 'No page “' + p + '”.');
    return { col, slug: p, data: snap.data(), href: p === 'boldiquette' ? 'boldiquette.html' : 'guide.html?guide=' + encodeURIComponent(p) };
  }
  function partOf(pg, partId){
    const part = (pg.data.parts || []).find((x) => x.id === partId);
    if (!part) throw httpError(404, 'No part “' + partId + '” on that page: read_page lists them.');
    return part;
  }

  async function readPage(who, a){
    const pg = await pageOf(a.page);
    const proposals = (await db.collection(pg.col).doc(pg.slug).collection('proposals').where('status', '==', 'open').get()).docs
      .map((d) => { const q = d.data(); return { id: d.id, kind: q.kind, part_id: q.partId || '', title: (q.after && q.after.title) || (q.before && q.before.title) || '', note: q.note || '', by: (q.by && q.by.name) || '' }; });
    return {
      title: pg.data.title, description: pg.data.description || '', url: url(pg.href),
      parts: (pg.data.parts || []).map((p) => ({ id: p.id, section: p.section || '', title: p.title, body: p.body })),
      open_proposals: proposals,
    };
  }

  async function comments(who, a){
    const pg = await pageOf(a.page), col = pg.col + '/' + pg.slug + '/comments';
    const by = { email: who.email, name: nameOfMe(who) }, now = Date.now();
    const existing = async () => {
      const s = await db.collection(pg.col).doc(pg.slug).collection('comments').doc(need(a.comment_id, 'the comment_id')).get();
      if (!s.exists) throw httpError(404, 'No such comment.');
      return Object.assign({ id: s.id }, s.data());
    };
    const text = () => { const t = need(a.text, 'the text'); if (t.length > 2000) throw httpError(400, 'At most 2000 characters.'); return t; };
    switch (a.action) {
      case 'add': {
        const part = partOf(pg, need(a.part_id, 'the part_id')), quote = need(a.quote, 'the quote: the words in the part the comment is about');
        if (quote.length > 500) throw httpError(400, 'Quote at most 500 characters.');
        const at = part.body.indexOf(quote);
        if (at === -1) throw httpError(400, 'Quote words exactly as they are in the part’s text.');
        const id = await asUser(who, 'create', col, { partId: part.id, quote, prefix: part.body.slice(Math.max(0, at - 30), at), suffix: part.body.slice(at + quote.length, at + quote.length + 30), text: text(), by, at: now });
        return { id, url: url(pg.href + '#c=' + id) };
      }
      case 'reply': {
        const c = await existing(), root = c.parent || c.id;
        const id = await asUser(who, 'create', col, { text: text(), by, at: now, parent: root, partId: c.partId || '' });
        return { id, url: url(pg.href + '#c=' + root) };
      }
      case 'on_proposal': {
        const pid = need(a.proposal_id, 'the proposal_id');
        const id = await asUser(who, 'create', col, { partId: '', proposalId: pid, text: text(), by, at: now });
        return { id };
      }
      case 'edit': { const c = await existing(); await asUser(who, 'update', col + '/' + c.id, { text: text(), editedAt: now }); return { ok: true }; }
      case 'resolve': { const c = await existing(); await asUser(who, 'update', col + '/' + c.id, { resolved: true, resolvedBy: who.email, resolvedByName: nameOfMe(who), resolvedAt: now }); return { ok: true }; }
      case 'delete': {
        const c = await existing();
        // A thread's first comment takes its replies with it, as on the page.
        if (!c.parent) for (const r of (await db.collection(pg.col).doc(pg.slug).collection('comments').where('parent', '==', c.id).get()).docs) await asUser(who, 'delete', col + '/' + r.id);
        await asUser(who, 'delete', col + '/' + c.id);
        return { ok: true };
      }
    }
    throw httpError(400, 'Unknown action.');
  }

  // A skill's proposed change (kind 'skill', as pages/skill.js makes it): its title,
  // description, instructions and files after the change, from what's given.
  const SKILL_CONTENT = ['title', 'description', 'body', 'files'];
  async function skillProposals(who, a, name){
    const snap = await db.collection('skills').doc(name).get();
    if (!snap.exists) return newSkill(who, a, name);
    const cur = {}, col = 'skills/' + name + '/proposals';
    SKILL_CONTENT.forEach((k) => { const v = snap.data()[k]; cur[k] = v !== undefined ? v : (k === 'files' ? [] : ''); });
    if (a.action === 'propose') {
      const note = need(a.note, 'a note: what you changed and why, for whoever reviews it');
      const after = JSON.parse(JSON.stringify(cur));
      ['title', 'description', 'body'].forEach((k) => { if (a[k] !== undefined) after[k] = String(a[k]); });
      if (Array.isArray(a.files)) after.files = a.files.map((f) => ({ path: need(f.path, 'each file’s path'), content: String(f.content || '') }));
      (a.set_files || []).forEach((f) => {
        const path = need(f.path, 'each file’s path');
        if (path === 'SKILL.md' || path.split('/').some((x) => !x || x === '.' || x === '..')) throw httpError(400, 'Not a file path: ' + path);
        after.files = after.files.filter((x) => x.path !== path).concat([{ path, content: String(f.content || '') }]);
      });
      (a.remove_files || []).forEach((path) => { after.files = after.files.filter((x) => x.path !== path); });
      if (JSON.stringify(after) === JSON.stringify(cur)) throw httpError(400, 'That changes nothing.');
      const id = await asUser(who, 'create', col, { kind: 'skill', before: cur, after, note, by: { email: who.email, name: nameOfMe(who) }, at: Date.now(), status: 'open' });
      return { id, url: url('skill.html?skill=' + encodeURIComponent(name) + '#proposals'), note: 'It waits under Proposed changes until a PI or admin (not you) accepts or declines it.' };
    }
    const pid = need(a.proposal_id, 'the proposal_id');
    if (a.action === 'withdraw') { await asUser(who, 'delete', col + '/' + pid); return { ok: true }; }
    if (a.action === 'accept' || a.action === 'decline') {
      const q = await db.collection('skills').doc(name).collection('proposals').doc(pid).get();
      if (!q.exists) throw httpError(404, 'No such proposal.');
      return act(who, 'decideProposal', { collection: 'skills', slug: name, id: pid, accept: a.action === 'accept', editedAt: q.data().editedAt || 0 });
    }
    throw httpError(400, 'Unknown action.');
  }

  // A new skill (no skill by that name yet): its title, description, instructions and files.
  async function newSkill(who, a, name){
    const col = 'skills/' + name + '/proposals';
    if (a.action !== 'propose') return decideOrWithdraw(who, a, 'skills', name, col);
    if (/anthropic|claude/.test(name)) throw httpError(400, 'Claude doesn’t accept “anthropic” or “claude” in a skill’s name.');
    const note = need(a.note, 'a note: what the skill is for and why it’s needed');
    const after = { title: need(a.title, 'its title'), description: need(a.description, 'its description (what it does and when to use it)'), body: need(a.body, 'its instructions (SKILL.md)'),
      files: (a.files || a.set_files || []).map((f) => ({ path: need(f.path, 'each file’s path'), content: String(f.content || '') })) };
    if (after.description.length > 1024) throw httpError(400, 'A skill’s description is at most 1024 characters.');
    const id = await asUser(who, 'create', col, { kind: 'new', before: null, after, note, by: { email: who.email, name: nameOfMe(who) }, at: Date.now(), status: 'open' });
    return { id, url: url('skill.html?skill=' + encodeURIComponent(name)), note: 'A new skill waits for a PI or admin (not you) to accept it; once accepted, every agent gets it as a prompt.' };
  }

  // A tool on the Tools pages (agentTools/{name}): a new one, a change, or removing it.
  async function toolProposals(who, a, name){
    const col = 'agentTools/' + name + '/proposals';
    if (a.action !== 'propose') return decideOrWithdraw(who, a, 'agentTools', name, col);
    const note = need(a.note, 'a note: what it changes and why, for whoever reviews it');
    const snap = await db.collection('agentTools').doc(name).get(), cur = snap.exists ? snap.data() : null;
    const by = { email: who.email, name: nameOfMe(who) }, at = Date.now();
    if (a.remove === true) {
      if (!cur) throw httpError(404, 'There’s no tool called ' + name + '.');
      return { id: await asUser(who, 'create', col, { kind: 'delete', before: null, after: null, note, by, at, status: 'open' }), url: url('tool.html?tool=' + encodeURIComponent(name) + '#proposals') };
    }
    const proposed = {};
    ['title', 'description', 'code'].forEach((k) => { if (a[k] !== undefined) proposed[k] = String(a[k]); });
    if (a.acting !== undefined) proposed.acting = a.acting === true;
    if (a.input !== undefined) proposed.input = a.input;
    // Checked as it would be accepted: name, inputs, code that compiles.
    const checked = checkTool(name, Object.assign({}, cur || {}, proposed));
    const after = {};
    Object.keys(checked).forEach((k) => { if (!cur || JSON.stringify(cur[k]) !== JSON.stringify(checked[k])) after[k] = checked[k]; });
    if (cur && !Object.keys(after).length) throw httpError(400, 'That changes nothing.');
    const id = await asUser(who, 'create', col, { kind: cur ? 'tool' : 'new', before: null, after: cur ? after : checked, note, by, at, status: 'open' });
    return { id, url: url('tool.html?tool=' + encodeURIComponent(name) + '#proposals'),
      note: 'It waits on the tool’s page until a PI or admin (not you) accepts it; Claude reviews it meanwhile. Once accepted, every agent gets it.' };
  }
  async function decideOrWithdraw(who, a, collection, name, col){
    const pid = need(a.proposal_id, 'the proposal_id');
    if (a.action === 'withdraw') { await asUser(who, 'delete', col + '/' + pid); return { ok: true }; }
    if (a.action === 'accept' || a.action === 'decline') {
      const q = await db.collection(collection).doc(name).collection('proposals').doc(pid).get();
      if (!q.exists) throw httpError(404, 'No such proposal.');
      return act(who, 'decideProposal', { collection, slug: name, id: pid, accept: a.action === 'accept', editedAt: q.data().editedAt || 0 });
    }
    throw httpError(400, 'Unknown action.');
  }

  async function proposals(who, a){
    const sk = /^skill:([a-z0-9-]{1,64})$/.exec(String(a.page || ''));
    if (sk) return skillProposals(who, a, sk[1]);
    const tl = /^tool:([a-z][a-z0-9_]{2,40})$/.exec(String(a.page || ''));
    if (tl) return toolProposals(who, a, tl[1]);
    const pg = await pageOf(a.page), col = pg.col + '/' + pg.slug + '/proposals';
    if (a.action === 'propose') {
      const note = need(a.note, 'a note: what you changed and why, for whoever reviews it');
      const kind = a.kind;
      let q;
      const side = (p) => { const o = { title: p.title, body: p.body }; if (p.section) o.section = p.section; return o; };
      if (kind === 'add') {
        const after = { title: need(a.title, 'the part’s title'), body: need(a.body, 'the part’s text') };
        if (a.section) after.section = String(a.section).trim();
        // Its id: one given (a part the site looks for by id, as the BOLDiquette's `access`), if
        // it's free; else a new one.
        let partId = Math.random().toString(36).slice(2, 10);
        if (a.part_id) {
          partId = String(a.part_id).trim();
          if (!/^[a-z0-9-]{1,64}$/.test(partId)) throw httpError(400, 'A part’s id is lowercase letters, digits and dashes.');
          if ((pg.data.parts || []).some((p) => p.id === partId)) throw httpError(400, 'There’s already a part “' + partId + '”: propose an edit to it instead.');
        }
        q = { kind, partId, before: null, after, note };
      } else if (kind === 'edit') {
        const p = partOf(pg, need(a.part_id, 'the part_id'));
        const after = { title: a.title !== undefined ? String(a.title).trim() : p.title, body: a.body !== undefined ? String(a.body) : p.body };
        if (a.section !== undefined) after.section = String(a.section).trim(); else if (p.section) after.section = p.section;
        q = { kind, partId: p.id, before: side(p), after, note };
      } else if (kind === 'remove') {
        const p = partOf(pg, need(a.part_id, 'the part_id'));
        q = { kind, partId: p.id, before: side(p), after: null, note };
      } else throw httpError(400, 'kind is add, edit or remove.');
      const id = await asUser(who, 'create', col, Object.assign(q, { by: { email: who.email, name: nameOfMe(who) }, at: Date.now(), status: 'open' }));
      return { id, url: url(pg.href + '#proposals'), note: 'It waits under Proposed changes until a PI or admin (not you) accepts or declines it.' };
    }
    const pid = need(a.proposal_id, 'the proposal_id');
    if (a.action === 'withdraw') { await asUser(who, 'delete', col + '/' + pid); return { ok: true }; }
    if (a.action === 'accept' || a.action === 'decline') {
      const s = await db.collection(pg.col).doc(pg.slug).collection('proposals').doc(pid).get();
      if (!s.exists) throw httpError(404, 'No such proposal.');
      return act(who, 'decideProposal', { collection: pg.col, slug: pg.slug, id: pid, accept: a.action === 'accept', editedAt: s.data().editedAt || 0 });
    }
    throw httpError(400, 'Unknown action.');
  }

  // ---------- projects ----------
  const cardPath = (c) => c.boardId ? 'boards/' + c.boardId + '/cards/' + c.id : 'projects/' + c.id;
  async function projects(who, a){
    const user = { name: nameOfMe(who), email: who.email };
    if (a.action === 'register') {
      const title = need(a.title, 'a title'), abstract = need(a.abstract, 'an abstract or pitch');
      const ch = await act(who, 'projectChannel', { name: need(a.slack_channel, 'its Slack channel (proj-…)'), mode: 'ensure' });
      const card = makeRegisteredCard(user, { title, abstractText: abstract, keywords: (a.keywords || []).map(String), slackChannel: '#' + ch.name });
      if (a.meeting) card.setUpMeeting = a.meeting;
      const id = card.id; delete card.id;
      await asUser(who, 'create', 'projects', card, id);
      return { id, url: url('project.html#id=' + encodeURIComponent(id)), slack_channel: '#' + ch.name, note: 'Its meeting, slides and notes are being set up.' };
    }
    const c = await cardOf(a.id);
    const ws = { id: c.id, board: c.boardId };
    switch (a.action) {
      case 'update': {
        const patch = {};
        const MAP = { title: 'title', abstract: 'abstractText', compute: 'computeEstimate' }, LINKS = { overleaf: 'overleafLink', arxiv: 'arxivLink', pitch: 'pitchLink' };
        Object.keys(MAP).forEach((k) => { if (a[k] !== undefined) patch[MAP[k]] = String(a[k]).trim(); });
        Object.keys(LINKS).forEach((k) => { if (a[k] !== undefined) patch[LINKS[k]] = http(String(a[k]).trim()); });
        if (patch.title === '') throw httpError(400, 'The title can’t be blank.');
        if (a.keywords !== undefined) patch.keywords = (a.keywords || []).map(String);
        if (a.slack_channel !== undefined) {
          // As on the page: a new name renames the old channel in Slack (or links one that exists).
          const r = await act(who, 'projectChannel', { name: a.slack_channel, mode: 'rename', from: c.data.slackChannel || '', project: ws });
          patch.slackChannel = '#' + r.name;
        }
        if (!Object.keys(patch).length) throw httpError(400, 'Say what to change.');
        patch.updatedAt = Date.now();
        await asUser(who, 'update', cardPath(c), patch);
        return { ok: true, changed: Object.keys(patch).filter((k) => k !== 'updatedAt') };
      }
      case 'remove': await asUser(who, 'delete', cardPath(c)); return { ok: true };
      case 'join': case 'leave': case 'start': case 'plan': case 'complete': case 'reopen': case 'pause_meeting': case 'resume_meeting':
        await act(who, 'projectWorkspace', Object.assign({ action: a.action.replace('_meeting', '') }, ws));
        return { ok: true, project: c.data.title };
      case 'set_meeting': case 'remove_meeting':
        await act(who, 'projectWorkspace', Object.assign({ action: 'meeting', meeting: a.action === 'remove_meeting' ? null : need(a.meeting, 'the meeting') }, ws));
        return { ok: true };
      case 'submit_to_venue': {
        const boards = await lab.boards();
        const v = need(a.venue, 'the venue');
        const b = boards.find((x) => x._id === v || fold(x.label) === fold(v));
        if (!b) throw httpError(404, 'No venue “' + v + '”. Venues: ' + boards.filter((x) => (x.status || 'approved') !== 'pending').map((x) => x.label).join(', '));
        const d = c.data;
        const next = makeRegisteredCard(user, { title: d.title, abstractText: d.abstractText, keywords: d.keywords, slackChannel: d.slackChannel, computeEstimate: d.computeEstimate });
        ['authors', 'authorEmails', 'overleafLink', 'arxivLink', 'pitchLink'].forEach((k) => { if (d[k]) next[k] = d[k]; });
        const r = await act(who, 'projectWorkspace', Object.assign({ action: 'submit', venue: b._id, card: next }, ws));
        return { ok: true, url: url('project.html#id=' + encodeURIComponent(r.cardId) + '&board=' + encodeURIComponent(r.boardId)) };
      }
    }
    throw httpError(400, 'Unknown action.');
  }

  async function presentations(who, a){
    const c = await cardOf(a.project_id), pid = c.data.projectId || c.id;
    const col = 'projectWorkspaces/' + pid + '/presentations';
    if (a.action === 'remove') { await asUser(who, 'delete', col + '/' + need(a.presentation_id, 'the presentation_id')); return { ok: true }; }
    let old = null;
    if (a.action === 'update') {
      const s = await db.collection('projectWorkspaces').doc(pid).collection('presentations').doc(need(a.presentation_id, 'the presentation_id')).get();
      if (!s.exists) throw httpError(404, 'No such presentation.');
      old = s.data();
    } else if (a.action !== 'add') throw httpError(400, 'Unknown action.');
    // Where it was given: one of the site's events, a venue on the board, or a name.
    let occasion = old && old.occasion;
    if (a.event || a.venue || a.where) {
      if (a.event) {
        const e = (await lab.events()).find((x) => x._id === a.event || fold(x.title) === fold(a.event));
        if (!e) throw httpError(404, 'No event “' + a.event + '”.');
        occasion = { kind: 'event', id: e._id, label: e.title };
      } else if (a.venue) {
        const b = (await lab.boards()).find((x) => x._id === a.venue || fold(x.label) === fold(a.venue));
        if (!b) throw httpError(404, 'No venue “' + a.venue + '”.');
        occasion = { kind: 'venue', id: b._id, label: b.label || b._id };
      } else occasion = { kind: 'other', id: '', label: String(a.where).trim().slice(0, 200) };
    }
    if (!occasion) throw httpError(400, 'Say where it was given: event, venue or where.');
    const t = {
      title: a.title !== undefined ? String(a.title).trim() : old ? old.title : '',
      type: a.type !== undefined ? a.type : old ? old.type : 'research-talk',
      date: iso(a.date !== undefined ? a.date : old ? old.date : '', 'the date'),
      presenter: a.presenter !== undefined ? String(a.presenter).trim() : old ? old.presenter : nameOfMe(who),
      occasion,
      slidesUrl: http(a.slides !== undefined ? String(a.slides).trim() : old ? old.slidesUrl : ''),
      recordingUrl: http(a.recording !== undefined ? String(a.recording).trim() : old ? old.recordingUrl : ''),
      by: old ? old.by : { email: who.email, name: nameOfMe(who) }, at: Date.now(),
    };
    if (!t.title) throw httpError(400, 'Give it a title.');
    if (!t.date) throw httpError(400, 'Give its date.');
    // An older project has no workspace yet: set it up first, as the page does.
    if (!(await db.collection('projectWorkspaces').doc(pid).get()).exists) await act(who, 'projectWorkspace', { action: 'setUp', id: c.id, board: c.boardId });
    if (old) { await asUser(who, 'set', col + '/' + a.presentation_id, t); return { ok: true }; }
    return { id: await asUser(who, 'create', col, t) };
  }

  // ---------- the service desk ----------
  async function introductions(who, a){
    const now = Date.now();
    switch (a.action) {
      case 'offer': {
        const org = need(a.organisation, 'the company or institution'), area = String(a.area || '').trim();
        if (org.length > 120 || area.length > 300) throw httpError(400, 'That’s too long.');
        return { id: await asUser(who, 'create', 'introOffers', { org, area, by: { email: who.email, name: nameOfMe(who) }, at: now, updatedAt: now }) };
      }
      case 'edit_offer': {
        const s = await db.collection('introOffers').doc(need(a.offer_id, 'the offer_id')).get();
        if (!s.exists) throw httpError(404, 'No such offer.');
        await asUser(who, 'update', 'introOffers/' + s.id, { org: a.organisation !== undefined ? need(a.organisation, 'the organisation') : s.data().org, area: a.area !== undefined ? String(a.area).trim() : s.data().area || '', updatedAt: now });
        return { ok: true };
      }
      case 'withdraw_offer': return act(who, 'introRequest', { action: 'withdrawOffer', offerId: need(a.offer_id, 'the offer_id') });
      case 'ask': return act(who, 'introRequest', { action: 'create', offerId: need(a.offer_id, 'the offer_id'), why: need(a.why, 'what you’d like and why') });
      case 'accept': case 'decline': case 'done': return act(who, 'introRequest', { action: a.action, id: need(a.request_id, 'the request_id'), reply: a.note || '' });
      case 'withdraw_request': return act(who, 'introRequest', { action: 'withdraw', id: need(a.request_id, 'the request_id') });
    }
    throw httpError(400, 'Unknown action.');
  }

  async function letters(who, a){
    const fields = (x) => ({ purpose: x.purpose, cv: x.cv, howWorked: x.how_worked, statement: x.statement, best: x.best, extra: x.extra });
    const recipients = (list) => (list || []).map((r) => ({ id: r.id, name: r.name, url: r.url || '', deadline: r.deadline || '', sentBy: r.sent_by === 'requester' ? 'requester' : 'writer' }));
    if (a.action === 'ask') {
      const pool = (await lab.people()).map((p) => ({ email: p.email, name: p.name || '' }));
      return act(who, 'letterRequest', Object.assign({ action: 'create', writerEmail: resolve(pool, a.referee, 'people in BOLD'), recipients: recipients(a.recipients) },
        { purpose: a.purpose, cv: a.cv, howWorked: a.how_worked, statement: a.statement || '', best: a.best || '', extra: a.extra || '' }));
    }
    const id = need(a.request_id, 'the request_id');
    const s = await db.collection('letterRequests').doc(id).get();
    const x = s.exists ? s.data() : null;
    if (!x || (x.requesterEmail !== who.email && x.writerEmail !== who.email)) throw httpError(404, 'No such request.');
    switch (a.action) {
      case 'update': {
        // The whole request, as the page sends it: what's given replaces what was there.
        const f = fields(a), merged = {};
        Object.keys(f).forEach((k) => { merged[k] = f[k] !== undefined ? f[k] : x[k] || ''; });
        return act(who, 'letterRequest', Object.assign({ action: 'update', id, recipients: a.recipients ? recipients(a.recipients) : x.recipients }, merged));
      }
      case 'withdraw': case 'acknowledge': return act(who, 'letterRequest', { action: a.action, id });
      case 'mark_submitted': case 'unmark_submitted': {
        const rs = x.recipients || [], want = need(a.recipient, 'the recipient (its name)');
        const r = rs.find((y) => y.id === want) || rs.find((y) => fold(y.name) === fold(want)) || rs.find((y) => matches(y.name, words(want)));
        if (!r) throw httpError(404, 'No recipient “' + want + '”: ' + rs.map((y) => y.name).join(', '));
        return act(who, 'letterRequest', { action: a.action === 'mark_submitted' ? 'submit' : 'unsubmit', id, recipientId: r.id, letterUrl: a.letter_url || '' });
      }
    }
    throw httpError(400, 'Unknown action.');
  }

  async function supervision(who, a){
    if (a.action === 'ask_to_join') {
      const pool = (await lab.studies()).map((s) => ({ email: s._id, name: s.name || '' }));
      return act(who, 'studyRequest', { action: 'request', student: resolve(pool, a.student, 'the students with supervision meetings'), note: a.note || '' });
    }
    const id = need(a.request_id, 'the request_id');
    if (a.action === 'withdraw') return act(who, 'studyRequest', { action: 'withdraw', id });
    if (a.action === 'approve' || a.action === 'decline') return act(who, 'studyRequest', { action: 'decide', id, accept: a.action === 'approve' });
    throw httpError(400, 'Unknown action.');
  }

  // Recurring events every few weeks (eventSeries of kind 'meeting'; functions/series.js), through its callable.
  async function labMeetings(who, a){
    const full = await isFullWrite(who.email);
    const pool = (await lab.series()).filter((x) => x.kind !== 'editions' && (x.hidden === false || full || (x.organisers || []).indexOf(who.email) >= 0))
      .map((x) => ({ id: x._id, name: x.title }));
    const meeting = () => ({ day: String(a.day || '').toUpperCase(), time: a.time, minutes: Number(a.minutes || 60), every: Number(a.every || 1),
      until: a.until || '', link: a.link || '' });
    const invite = () => a.invite && a.invite !== 'join' ? { mode: 'group', group: a.invite } : { mode: 'join' };
    if (a.action === 'add') return act(who, 'eventSeries', { action: 'save', title: need(a.title, 'a title'), description: a.description || '', meeting: meeting(), invite: invite(), organisers: [] });
    const id = pool.find((x) => x.id === a.meeting) ? a.meeting : (pool.find((x) => fold(x.name) === fold(a.meeting)) || {}).id;
    if (!id) throw httpError(404, 'No recurring event “' + (a.meeting || '') + '”.');
    if (a.action === 'update') {
      const s = (await lab.series()).find((x) => x._id === id);
      const m = Object.assign({}, s.meeting, a.day ? { day: String(a.day).toUpperCase() } : {}, a.time ? { time: a.time } : {}, a.minutes ? { minutes: Number(a.minutes) } : {},
        a.every ? { every: Number(a.every) } : {}, a.until !== undefined ? { until: a.until } : {}, a.link !== undefined ? { link: a.link } : {});
      return act(who, 'eventSeries', { action: 'save', id, title: a.title || s.title, description: a.description !== undefined ? a.description : s.description,
        meeting: m, invite: a.invite ? invite() : s.invite, organisers: s.organisers });
    }
    if (['join', 'leave', 'pause', 'resume', 'release', 'hide', 'delete'].indexOf(a.action) >= 0) return act(who, 'eventSeries', { action: a.action, id });
    throw httpError(400, 'Unknown action.');
  }

  // ---------- you ----------
  const PROFILE = { role: 'role', institution: 'institution', interests: 'interests', pillars: 'pillars', based_in: 'basedIn', pronouns: 'pronouns',
    links: 'links', contact: 'contact', contact_email: 'contactEmail', booking_url: 'bookingUrl', feedback: 'feedback', start_date: 'startDate', end_date: 'endDate', list_on_website: 'listOnWebsite' };
  async function profile(who, a){
    switch (a.action) {
      case 'update': {
        const patch = {};
        Object.keys(PROFILE).forEach((k) => { if (a[k] !== undefined) patch[PROFILE[k]] = a[k]; });
        if (!Object.keys(patch).length) throw httpError(400, 'Say what to change: ' + Object.keys(PROFILE).join(', ') + '.');
        if (patch.bookingUrl) http(patch.bookingUrl);
        const ref = db.collection('members').doc(who.email), was = await ref.get();
        const doc = Object.assign({}, was.exists ? was.data() : {}, patch, { name: (was.exists && was.data().name) || nameOfMe(who), email: who.email, updatedAt: Date.now() });
        // Only the keys the page writes; the rest (who approved them, their group) stay.
        if (was.exists) await asUser(who, 'update', 'members/' + who.email, Object.assign(patch, { updatedAt: doc.updatedAt }));
        else await asUser(who, 'create', 'members', doc, who.email);
        return { ok: true, changed: Object.keys(patch).filter((k) => k !== 'updatedAt') };
      }
      case 'ask_group': return act(who, 'groupRequest', { action: 'request', to: need(a.group, 'the group (exec, staff, internal, associate or pan)'), note: a.note || '' });
      case 'withdraw_group_request': return act(who, 'groupRequest', { action: 'withdraw', id: need(a.request_id, 'the request_id') });
      case 'set_inviter': {
        let email = '';
        if (a.inviter) email = resolve((await lab.people()).map((p) => ({ email: p.email, name: p.name || '' })), a.inviter, 'people in BOLD');
        return act(who, 'setMyInviter', { email });
      }
      case 'confirm_invite': case 'deny_invite':
        return act(who, 'confirmJoinInvite', Object.assign({ confirm: a.action === 'confirm_invite' }, a.request_id ? { id: a.request_id } : { member: resolve((await lab.members()).map((m) => ({ email: m.email || m._id, name: m.name || '' })), a.member, 'members') }));
    }
    throw httpError(400, 'Unknown action.');
  }

  // ---------- PIs and admins (events: adding is the table's Edit; see firestore.rules) ----------
  async function events(who, a){
    const now = Date.now();
    if (a.action === 'add') {
      const title = need(a.title, 'a title'), start = iso(need(a.start, 'the start date'), 'the start date'), end = iso(a.end || start, 'the end date');
      if (end < start) throw httpError(400, 'It has to end on or after the day it starts.');
      const slug = (fold(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'event') + '-' + Math.random().toString(16).slice(2, 8);
      await asUser(who, 'create', 'events', { slug, hidden: true, title, startDate: start, endDate: end, place: a.place || '', description: a.description || '', createdAt: now, createdBy: who.email, updatedAt: now, updatedBy: who.email }, slug);
      return { slug, url: url('event.html?event=' + slug), note: (await isFullWrite(who.email)) ? 'It starts hidden: release it to show it to the lab.'
        : 'It starts hidden: the PIs and admins are told, and one of them releases it.' };
    }
    const full = await isFullWrite(who.email);
    if ((a.action === 'release' || a.action === 'hide') && !full) throw httpError(403, 'Only PIs and admins release and hide events.');
    // Hidden ones: a PI's or admin's, or the ones they added.
    const e = (await lab.events()).filter((x) => x.hidden === false || full || x.createdBy === who.email)
      .find((x) => x._id === a.event || fold(x.title) === fold(a.event));
    if (!e) throw httpError(404, 'No event “' + a.event + '”.');
    const stamp = { updatedAt: now, updatedBy: who.email };
    switch (a.action) {
      case 'update': {
        const patch = {};
        if (a.title !== undefined) patch.title = need(a.title, 'a title');
        if (a.start !== undefined) patch.startDate = iso(a.start, 'the start date');
        if (a.end !== undefined) patch.endDate = iso(a.end, 'the end date');
        if (a.place !== undefined) patch.place = String(a.place);
        if (a.description !== undefined) patch.description = String(a.description);
        await asUser(who, 'update', 'events/' + e._id, Object.assign(patch, stamp));
        return { ok: true };
      }
      case 'release': case 'hide': await asUser(who, 'update', 'events/' + e._id, Object.assign({ hidden: a.action === 'hide' }, stamp)); return { ok: true };
      case 'delete': await asUser(who, 'delete', 'events/' + e._id); return { ok: true };
    }
    throw httpError(400, 'Unknown action.');
  }

  async function requests(who, a){
    switch (a.action) {
      case 'list': {
        if (!(await isFullWrite(who.email))) throw httpError(403, 'Only PIs and admins see requests.');
        const [j, g] = await Promise.all([
          db.collection('joinRequests').where('status', '==', 'open').get(), db.collection('groupRequests').where('status', '==', 'open').get(),
        ]);
        return {
          join: j.docs.map((d) => { const x = d.data(); return { id: d.id, name: x.name, role: x.role || '', institution: x.institution || '', invited_by: (x.invitedBy && x.invitedBy.name) || '', at: x.at, url: url('join-requests.html#r=' + d.id) }; }),
          group: g.docs.map((d) => { const x = d.data(); return { id: d.id, name: x.name, from: x.from, to: x.to, note: x.note || '', url: url('join-requests.html#g=' + d.id) }; }),
        };
      }
      case 'approve_join': case 'decline_join': return act(who, 'decideJoinRequest', { id: need(a.request_id, 'the request_id'), accept: a.action === 'approve_join' });
      case 'approve_group': case 'decline_group': return act(who, 'groupRequest', { action: 'decide', id: need(a.request_id, 'the request_id'), accept: a.action === 'approve_group' });
      case 'set_group': {
        const email = resolve((await lab.members()).map((m) => ({ email: m.email || m._id, name: m.name || '' })), a.member, 'members');
        await asUser(who, 'update', 'members/' + String(email).toLowerCase(), { category: need(a.group, 'the group'), categoryBy: who.email, categoryAt: Date.now() });
        return { ok: true };
      }
    }
    throw httpError(400, 'Unknown action.');
  }

  async function skills(who, a){
    const name = need(a.name, 'the skill’s name');
    const now = Date.now(), stamp = { updatedAt: now, updatedBy: who.email, changeNote: String(a.change_note || '').trim() };
    const s = await db.collection('skills').doc(name).get();
    switch (a.action) {
      case 'add':
        if (s.exists) throw httpError(409, 'There’s already a skill called ' + name + '.');
        await asUser(who, 'create', 'skills', Object.assign({ name, title: a.title || name, description: need(a.description, 'a description'), body: need(a.body, 'its SKILL.md body'), files: [], createdAt: now, createdBy: who.email }, stamp), name);
        return { url: url('skill.html?skill=' + encodeURIComponent(name)) };
      case 'update': throw httpError(400, 'A change to a skill is proposed: use proposals with page "skill:' + name + '".');
      case 'delete': if (!s.exists) throw httpError(404, 'No skill called ' + name + '.'); await asUser(who, 'delete', 'skills/' + name); return { ok: true };
    }
    throw httpError(400, 'Unknown action.');
  }

  // ---------- reading, for acting ----------
  async function listSkills(){
    return { skills: (await lab.skills()).map((x) => ({ name: x._id, title: x.title || x.name || x._id, description: x.description || '', url: url('skill.html?skill=' + encodeURIComponent(x._id)) })) };
  }
  async function getSkill(who, a){
    const x = (await lab.skills()).find((s) => s._id === a.name);
    if (!x) throw httpError(404, 'No skill called ' + a.name + '.');
    return { name: x._id, title: x.title || '', description: x.description || '', body: x.body || '',
      files: (x.files || []).map((f) => ({ path: f.path || f.name || '', content: typeof f.content === 'string' ? f.content : '' })),
      download: SITE_URL ? url('skill.html?skill=' + encodeURIComponent(x._id)) : '' };
  }

  const S = (props, required) => ({ type: 'object', properties: props, required: required || ['action'] });
  const str = (d) => ({ type: 'string', description: d });
  const READ = [
    { name: 'read_page', description: 'The BOLDiquette or a how-to guide in full, with each part’s id (for commenting and proposing changes) and the open proposed changes.',
      inputSchema: S({ page: str('"boldiquette", or a guide’s slug (in its url: guide.html?guide=<slug>).') }, ['page']), run: readPage },
    { name: 'list_skills', description: 'The lab’s Claude skills (Skills page).', inputSchema: S({}, []), run: listSkills },
    { name: 'get_skill', description: 'One skill: its SKILL.md and files, to use or install it.', inputSchema: S({ name: str('The skill’s name.') }, ['name']), run: getSkill },
  ];
  const WRITE = [
    { name: 'comments', run: comments,
      description: 'Comment on the BOLDiquette or a guide, as on the page: add (on words quoted from a part), reply, on_proposal (discuss a proposed change), edit or delete your own, resolve. People tagged or replied to get Slack messages.',
      inputSchema: S({ action: ACTIONS(['add', 'reply', 'on_proposal', 'edit', 'resolve', 'delete']), page: str('"boldiquette" or a guide’s slug.'), part_id: str('add: the part (read_page).'),
        quote: str('add: words from the part, exactly as written.'), text: str('The comment (Markdown, @Name to tag).'), comment_id: str('reply, edit, resolve, delete.'), proposal_id: str('on_proposal.') }, ['action', 'page']) },
    { name: 'proposals', run: proposals,
      description: 'Propose a change to the BOLDiquette, a guide, a skill or a tool: this is how BOLD.OS, and the MCP with it, improves itself (every change is a proposal; a PI or admin other than you accepts it). Actions: propose (with a note on why), withdraw your own, or, for PIs and admins, accept or decline someone else’s. ' +
        'For the BOLDiquette or a guide: kind add, edit or remove a part (read_page). For a skill (page "skill:<name>", get_skill): its new title, description or body (SKILL.md’s instructions), and its files (set_files, remove_files, or all of them in files); a new name proposes a new skill. ' +
        'For a tool (page "tool:<name>", list_tools): its title, description, acting, input and code; a new name proposes a new tool; remove: true proposes removing it.',
      inputSchema: S({ action: ACTIONS(['propose', 'withdraw', 'accept', 'decline']), page: str('"boldiquette", a guide’s slug, or "skill:<name>".'), kind: ACTIONS(['add', 'edit', 'remove']),
        part_id: str('edit, remove: the part. add: optional, its id (else a new one).'), title: str('The part’s title, or the skill’s.'), body: str('The part’s text (Markdown), or the skill’s instructions.'), section: str('Its section (tab).'),
        description: str('A skill’s description.'), files: { type: 'array', description: 'A skill: all its files (besides SKILL.md).', items: { type: 'object', properties: { path: str(''), content: str('') }, required: ['path'] } },
        set_files: { type: 'array', description: 'A skill: files to add or replace.', items: { type: 'object', properties: { path: str(''), content: str('') }, required: ['path'] } },
        remove_files: { type: 'array', items: { type: 'string' }, description: 'A skill: paths to remove.' },
        acting: { type: 'boolean', description: 'A tool: whether it writes or calls the site’s functions.' },
        input: { type: 'object', description: 'A tool: its inputs, { name: { type, description, required } }.' },
        code: str('A tool: the body of an async function (input, bold) returning JSON.'),
        remove: { type: 'boolean', description: 'A tool: propose removing it.' },
        note: str('propose: what you changed and why.'), proposal_id: str('withdraw, accept, decline.') }, ['action', 'page']) },
    { name: 'projects', run: projects,
      description: 'Projects, as on the Projects page and a project’s page: register a new one (with its Slack channel, created if new), update its fields (a new Slack channel name renames the old channel), remove it, join or leave it, mark it ongoing (start: being worked on) or back to planned (plan), mark it complete or reopen it, set, remove, pause or resume its weekly meeting, or submit it to a venue on the board.',
      inputSchema: S({ action: ACTIONS(['register', 'update', 'remove', 'join', 'leave', 'start', 'plan', 'complete', 'reopen', 'set_meeting', 'remove_meeting', 'pause_meeting', 'resume_meeting', 'submit_to_venue']),
        id: str('The project id (list_projects), for all but register.'), title: str(''), abstract: str(''), keywords: { type: 'array', items: { type: 'string' } },
        slack_channel: str('register, update: "proj-…".'), overleaf: str('update'), arxiv: str('update'), pitch: str('update: the pitch deck link'), compute: str('update: the compute estimate'),
        meeting: { type: 'object', description: 'register, set_meeting: London time.', properties: { day: ACTIONS(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']), time: str('HH:MM'), minutes: { type: 'integer', enum: [30, 45, 60, 90, 120] }, every: { type: 'integer', enum: [1, 2, 3, 4] }, until: str('YYYY-MM-DD (optional)') } },
        venue: str('submit_to_venue: the venue’s name, e.g. "ICLR 2027".') }) },
    { name: 'presentations', run: presentations,
      description: 'A project’s presentations (its Meetings tab): add, update or remove a talk about it, with where it was given (one of the site’s events, a venue, or a name) and its slides and recording links.',
      inputSchema: S({ action: ACTIONS(['add', 'update', 'remove']), project_id: str('The project id.'), presentation_id: str('update, remove (get_project lists them).'),
        title: str(''), type: ACTIONS(['research-talk', 'pitch', 'keynote']), date: str('YYYY-MM-DD'), presenter: str('Who gave it (default: you).'),
        event: str('Where: one of the site’s events (name or slug).'), venue: str('Or: a venue on the board.'), where: str('Or: anywhere else, by name.'), slides: str('https://…'), recording: str('https://…') }, ['action', 'project_id']) },
    { name: 'introductions', run: introductions,
      description: 'Introductions (Service desk): offer to introduce people to an organisation you know (no names: the organisation, and a team or area), edit or withdraw your offer (open requests on it are closed), ask on someone’s offer, answer a request asked of you (accept, decline, done), or withdraw your request. The other person gets a Slack message.',
      inputSchema: S({ action: ACTIONS(['offer', 'edit_offer', 'withdraw_offer', 'ask', 'accept', 'decline', 'done', 'withdraw_request']), organisation: str(''), area: str(''),
        offer_id: str('list_introduction_offers'), why: str('ask: what you’d like and why'), request_id: str('my_items'), note: str('accept, decline: a note for them') }) },
    { name: 'letters', run: letters,
      description: 'Recommendation letters (Service desk): ask someone in BOLD for one, update or withdraw your request; as a referee, acknowledge it and mark each recipient submitted (or not). Only the two of you see a request; the other gets a Slack message.',
      inputSchema: S({ action: ACTIONS(['ask', 'update', 'withdraw', 'acknowledge', 'mark_submitted', 'unmark_submitted']), request_id: str('my_items'), referee: str('ask: their name'),
        purpose: str(''), cv: str('https://… link to your CV'), how_worked: str('How you have worked together, and what you did yourself.'), statement: str('https://… (optional)'), best: str('(optional)'), extra: str('(optional)'),
        recipients: { type: 'array', items: { type: 'object', properties: { name: str(''), url: str(''), deadline: str('YYYY-MM-DD'), sent_by: ACTIONS(['writer', 'requester']) }, required: ['name'] } },
        recipient: str('mark_submitted: the recipient’s name'), letter_url: str('mark_submitted, when you send it yourself') }) },
    { name: 'supervision', run: supervision,
      description: 'Supervision meetings (PhD and Master students’): ask a student to join theirs, withdraw your request; as the student, approve or decline someone’s request. The other gets a Slack message.',
      inputSchema: S({ action: ACTIONS(['ask_to_join', 'withdraw', 'approve', 'decline']), student: str('ask_to_join: their name'), note: str(''), request_id: str('my_items') }) },
    { name: 'lab_meetings', run: labMeetings,
      description: 'Recurring events that meet every 1–4 weeks at a set time (Events; series.html), such as a weekly reading group: add one (it starts hidden, and nobody is invited, until a PI or admin releases it), change, pause, resume or delete one you organise; join or leave one that is opt-in. PIs and admins release and hide them. Google Calendar sends the invitations.',
      inputSchema: S({ action: ACTIONS(['add', 'update', 'join', 'leave', 'pause', 'resume', 'release', 'hide', 'delete']), meeting: str('Its name or id (all but add).'),
        title: str(''), description: str(''), day: ACTIONS(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']), time: str('HH:MM, London time'), minutes: { type: 'integer', description: '15–240, in 15s (default 60)' },
        every: { type: 'integer', description: 'Every N weeks, 1–4 (default 1)' }, until: str('YYYY-MM-DD, optional last day'), link: str('Its own meeting link (https), instead of a new Google Meet'),
        invite: ACTIONS(['join', 'everyone', 'associate', 'internal', 'staff', 'exec']) }) },
    { name: 'profile', run: profile,
      description: 'Your profile and place in BOLD: update your details, ask to move to another group (Who is BOLD), withdraw that request, say who invited you to the BOLD Slack, and confirm (or deny) that you invited someone who says you did.',
      inputSchema: S(Object.assign({ action: ACTIONS(['update', 'ask_group', 'withdraw_group_request', 'set_inviter', 'confirm_invite', 'deny_invite']) },
        ...Object.keys(PROFILE).map((k) => ({ [k]: k === 'pillars' ? { type: 'array', items: { type: 'string' } } : k === 'list_on_website' ? { type: 'boolean' } : str('update') })),
        { group: ACTIONS(['exec', 'staff', 'internal', 'associate', 'pan']), note: str(''), request_id: str(''), inviter: str('set_inviter: their name ("" for nobody)'), member: str('confirm_invite, deny_invite: the member’s name') })) },
    { name: 'events', run: events,
      description: 'The lab’s events: add one (it starts hidden, until a PI or admin releases it), update or delete one you added (PIs and admins: any), release or hide one (PIs and admins).',
      inputSchema: S({ action: ACTIONS(['add', 'update', 'release', 'hide', 'delete']), event: str('Its name or slug (all but add).'), title: str(''), start: str('YYYY-MM-DD'), end: str('YYYY-MM-DD'), place: str(''), description: str('') }) },
    { name: 'requests', run: requests,
      description: 'PIs and admins: requests to join BOLD and to change group (the Requests page): list the open ones, approve or decline them (a request to join only if it names you as inviting them, or names nobody), or set someone’s group.',
      inputSchema: S({ action: ACTIONS(['list', 'approve_join', 'decline_join', 'approve_group', 'decline_group', 'set_group']), request_id: str(''), member: str('set_group: their name'), group: ACTIONS(['exec', 'staff', 'internal', 'associate', 'pan']) }) },
    { name: 'skills', run: skills,
      description: 'PIs and admins: add a new Claude skill, or delete one. Changing a skill is a proposal, by anyone (proposals, page "skill:<name>").',
      inputSchema: S({ action: ACTIONS(['add', 'delete']), name: str('The skill’s name.'), title: str(''), description: str(''), body: str('SKILL.md body'), change_note: str('What changed') }, ['action', 'name']) },
  ];
  WRITE.forEach((t) => { t.write = true; if (t.name === 'comments' || t.name === 'events' || t.name === 'lab_meetings' || t.name === 'lab_meetings' || t.name === 'skills' || t.name === 'projects' || t.name === 'presentations') t.destructive = true; });
  return { READ, WRITE, asUser, toFields, idTokenFor };
};
module.exports.toFields = toFields;
