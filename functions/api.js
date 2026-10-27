// ---------- BOLD.OS for agents: personal tokens, a read-only API and MCP ----------
// Anyone in the BOLD Slack makes personal tokens on their profile (its Agents tab;
// apiTokens below). A token acts as its owner and reads what they can read on
// the site: everything lab-wide, plus their own letters and introductions. A token made
// with "Can also act" (`write`) may also act: join and leave projects, ask for and answer
// introductions, ask to join a supervision meeting, ask for a letter, each through the
// page's own callable (act), so the same checks and Slack messages apply.
//
// boldApi (one HTTPS function) answers two ways, from the same tools (TOOLS):
//   POST /mcp            MCP (Streamable HTTP, stateless, JSON responses): for agents
//                        (Claude Code: claude mcp add --scope user --transport http bold-os <url>/mcp
//                        --header "Authorization: Bearer <token>").
//   GET  /v1/<tool>?…    the same tools as JSON, arguments as query parameters.
// Both need `Authorization: Bearer <token>`.
//
// Tokens: apiTokens/{sha-256 of the token} { email, label, prefix (its first 12
// characters, to recognise it), createdAt, lastUsedAt, minute, count }; server only
// (firestore.rules' deny-all). The token itself is shown once, when made, and never
// stored. It works while its owner is in the BOLD Slack (the `people` roster), at most
// RATE_PER_MINUTE requests a minute. Every call is logged in apiLog { email, token
// (prefix), tool, args, at, expireAt } (expireAt: for a Firestore TTL policy, 90 days).
const crypto = require('crypto');
// Search ranking, shared with the site: copied here at deploy (firebase.json's predeploy),
// else the site's copy (run as a script: the repo's root package is an ES module).
const rank = (function(){
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const here = path.join(__dirname, 'search-rank.js'), src = path.join(__dirname, '..', 'src', 'assets', 'js', 'search-rank.js');
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(fs.existsSync(here) ? here : src, 'utf8'), ctx);
  return ctx.module.exports;
})();

module.exports = function(deps){
  const { db, admin, onRequest, onCall, HttpsError, logger, callerEmail, isFullWrite,
    allProjectsFromCards, projectGroupForCards, workspaceStarted, groupOf, SITE_URL, SIGN_IN_PROVIDER, secrets, callables,
    SLACK_BOT_TOKEN, tellStaff, tellPerson, slackText, linkedTitle, joinPageUrl, skillMd, onSchedule, access } = deps;

  const TOKENS_PER_PERSON = 5, RATE_PER_MINUTE = 60, LOG_DAYS = 90;
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const GROUP_LABEL = { exec: 'BOLD-exec', staff: 'BOLD-staff', internal: 'BOLD-internal', associate: 'BOLD-associate', pan: 'PAN-BOLD' };

  // ---------- tokens (the profile's Agents row) ----------
  // A token reads; it acts too only once a PI or admin approves (actRequest on the
  // token: { status: open | approved | declined | stopped, note, at, decidedBy,
  // decidedByName, decidedAt }), from the Requests page's Agents tab.
  // data: { action: 'list' } → { tokens: [{ id, label, prefix, write, act, createdAt, lastUsedAt }] }
  //       { action: 'create', label, askAct, note } → { token, id, … }: the token, once;
  //                                       `askAct`: also asks for it to act
  //       { action: 'revoke', id }        its owner, or a PI or admin
  //       { action: 'askAct', id, note }  its owner, for a token that only reads
  //       { action: 'stopAct', id }       its owner, or a PI or admin: back to reading only
  //       { action: 'actRequests' }       PIs and admins → { requests }
  //       { action: 'decideAct', id, accept }   PIs and admins
  //       { action: 'activity', all }     → { tokens, log }: yours (all: everyone's, at Agents' View level)
  const apiTokens = onCall({ secrets: [SLACK_BOT_TOKEN] }, async (request) => {
    const email = callerEmail(request);
    const d = request.data || {};
    const mine = async () => (await db.collection('apiTokens').where('email', '==', email).get()).docs;
    const view = (doc) => { const x = doc.data(); return { id: doc.id, label: x.label || '', prefix: x.prefix, write: !!x.write, act: (x.actRequest && x.actRequest.status) || '', createdAt: x.createdAt || 0, lastUsedAt: x.lastUsedAt || 0 }; };
    const myName = async () => ((await personByEmail(email)) || {}).name || email;
    const askAct = async (ref, label, note) => {
      const n = String(note || '').trim().slice(0, 1000);
      await ref.update({ actRequest: { status: 'open', note: n, at: Date.now() } });
      await Promise.resolve(tellStaff('🤖 ' + slackText(await myName()) + ' asks to let their agent act for them (token “' + slackText(label) + '”)' +
        (n ? ': “' + slackText(n.slice(0, 300)) + '”' : '') + '. ' + linkedTitle('Approve or decline', joinPageUrl() + '#agents') + '.', email)).catch((err) => logger.warn('Telling the PIs failed', { error: String(err.message) }));
    };
    const tokenRef = (id) => {
      if (!/^[0-9a-f]{64}$/.test(String(id || ''))) throw new HttpsError('invalid-argument', 'No such token.');
      return db.collection('apiTokens').doc(String(id));
    };
    if (d.action === 'list') return { tokens: (await mine()).map(view).sort((a, b) => b.createdAt - a.createdAt) };
    if (d.action === 'create') {
      const label = String(d.label || '').trim().slice(0, 60);
      if (!label) throw new HttpsError('invalid-argument', 'Name it, e.g. after the agent that will use it.');
      if ((await mine()).length >= TOKENS_PER_PERSON) throw new HttpsError('resource-exhausted', 'You have ' + TOKENS_PER_PERSON + ' tokens: revoke one first.');
      const person = await personByEmail(email);
      const token = 'bold_' + crypto.randomBytes(32).toString('base64url');
      const now = Date.now(), id = sha(token);
      // Never acting from the start: asking to is a request (askAct).
      await db.collection('apiTokens').doc(id).set({ email, name: (person && person.name) || '', label, write: false, prefix: token.slice(0, 12), createdAt: now, lastUsedAt: 0, minute: 0, count: 0 });
      if (d.askAct === true) await askAct(db.collection('apiTokens').doc(id), label, d.note);
      return { token, id, label, write: false, act: d.askAct === true ? 'open' : '', prefix: token.slice(0, 12), createdAt: now, lastUsedAt: 0 };
    }
    if (d.action === 'askAct') {
      const ref = tokenRef(d.id), x = (await ref.get()).data();
      if (!x || x.email !== email) throw new HttpsError('not-found', 'No such token.');
      if (x.write) throw new HttpsError('failed-precondition', 'It acts already.');
      if (x.actRequest && x.actRequest.status === 'open') throw new HttpsError('already-exists', 'You’ve asked already: a PI or admin will decide.');
      await askAct(ref, x.label, d.note);
      return { ok: true };
    }
    if (d.action === 'stopAct') {
      const ref = tokenRef(d.id), x = (await ref.get()).data();
      if (!x) throw new HttpsError('not-found', 'No such token.');
      if (x.email !== email && !(await isFullWrite(email))) throw new HttpsError('permission-denied', 'That’s not your token.');
      await ref.update({ write: false, actRequest: Object.assign({}, x.actRequest, { status: 'stopped', decidedBy: email, decidedByName: await myName(), decidedAt: Date.now() }) });
      return { ok: true };
    }
    if (d.action === 'actRequests' || d.action === 'decideAct') {
      if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins decide.');
      if (d.action === 'actRequests') {
        const snap = await db.collection('apiTokens').get(), name = await nameOf();
        return { requests: snap.docs.filter((t) => t.data().actRequest).map((t) => {
          const x = t.data(), r = x.actRequest;
          return { id: t.id, owner: name(x.email), email: x.email, label: x.label, prefix: x.prefix, note: r.note || '', status: r.status, at: r.at || 0,
            decidedByName: r.decidedByName || '', decidedAt: r.decidedAt || 0, lastUsedAt: x.lastUsedAt || 0 };
        }).sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.at - a.at) };
      }
      const ref = tokenRef(d.id), accept = d.accept === true, decider = await myName();
      const x = await db.runTransaction(async (tx) => {
        const x = (await tx.get(ref)).data();
        if (!x || !x.actRequest) throw new HttpsError('not-found', 'That request isn’t there: the token may have been revoked.');
        if (x.actRequest.status !== 'open') throw new HttpsError('failed-precondition', 'It’s already been decided.');
        if (x.email === email) throw new HttpsError('permission-denied', 'Another PI or admin decides your own.');
        tx.update(ref, { write: accept, actRequest: Object.assign({}, x.actRequest, { status: accept ? 'approved' : 'declined', decidedBy: email, decidedByName: decider, decidedAt: Date.now() }) });
        return x;
      });
      await Promise.resolve(tellPerson(x.email, accept
        ? '🤖 Your agent can now act for you (token “' + slackText(x.label) + '”), in your name. ' + linkedTitle('See what it does', SITE_URL + 'agents.html') + '.'
        : '🤖 Your request to let your agent act for you (token “' + slackText(x.label) + '”) was declined. It still reads. Ask a PI if you’d like to know more.')).catch((err) => logger.warn('Telling them failed', { error: String(err.message) }));
      return { ok: true };
    }
    if (d.action === 'revoke') {
      const id = String(d.id || '');
      if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpsError('invalid-argument', 'No such token.');
      const ref = db.collection('apiTokens').doc(id), snap = await ref.get();
      if (!snap.exists) return { ok: true };
      if (snap.data().email !== email && !(await isFullWrite(email))) throw new HttpsError('permission-denied', 'That’s not your token.');
      await ref.delete();
      return { ok: true };
    }
    if (d.action === 'activity') {
      // agents.html: your tokens and what they did; with `all`, everyone's (whoever can view Agents).
      const all = d.all === true;
      if (all) await access.requireAccess(email, 'agents', 'view');
      const [tokenDocs, logDocs] = await Promise.all([
        all ? db.collection('apiTokens').get().then((x) => x.docs) : mine(),
        (all ? db.collection('apiLog').orderBy('at', 'desc').limit(LOG_SHOWN) : db.collection('apiLog').where('email', '==', email)).get().then((x) => x.docs),
      ]);
      const name = await nameOf();
      const labels = {};
      tokenDocs.forEach((t) => { labels[t.data().prefix] = t.data().label; });
      return {
        all,
        tokens: tokenDocs.map((t) => Object.assign(view(t), { owner: name(t.data().email), mine: t.data().email === email })).sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt)),
        log: logDocs.map((x) => x.data()).sort((a, b) => b.at - a.at).slice(0, LOG_SHOWN)
          .map((x) => ({ at: x.at, who: name(x.email), token: labels[x.token] || x.token + '… (revoked)', tool: x.tool, args: x.args === '{}' ? '' : x.args })),
      };
    }
    throw new HttpsError('invalid-argument', 'Unknown action.');
  });
  const LOG_SHOWN = 300;

  async function personByEmail(email){
    const snap = await db.collection('people').where('email', '==', email).limit(1).get();
    if (snap.empty) {
      // The roster keeps Slack's capitalisation.
      const all = await lab.people();
      return all.find((p) => String(p.email || '').toLowerCase() === email) || null;
    }
    return snap.docs[0].data();
  }

  // The token in the request → its owner's email, or an error with an HTTP status.
  async function authorize(req){
    const m = /^Bearer\s+(bold_[A-Za-z0-9_-]{20,})\s*$/.exec(req.get('authorization') || '');
    if (!m) throw httpError(401, 'Send your BOLD.OS token: Authorization: Bearer bold_…  Make one on your BOLD.OS profile, in its Agents tab.');
    const ref = db.collection('apiTokens').doc(sha(m[1]));
    const minute = Math.floor(Date.now() / 60000);
    const t = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const x = snap.data(), count = x.minute === minute ? (x.count || 0) + 1 : 1;
      if (count > RATE_PER_MINUTE) return Object.assign({ limited: true }, x);
      tx.update(ref, { minute, count, lastUsedAt: Date.now() });
      return x;
    });
    if (!t) throw httpError(401, 'That token isn’t valid: it may have been revoked.');
    if (t.limited) throw httpError(429, 'At most ' + RATE_PER_MINUTE + ' requests a minute: wait a moment.');
    if (!(await personByEmail(t.email))) throw httpError(403, 'Only people in the BOLD Slack can use BOLD.OS.');
    return { email: t.email, prefix: t.prefix, name: t.name || '', write: !!t.write };
  }
  function httpError(status, message){ const e = new Error(message); e.status = status; return e; }

  function log(who, tool, args){
    const now = Date.now();
    return db.collection('apiLog').add({
      email: who.email, token: who.prefix, tool, args: JSON.stringify(args || {}).slice(0, 300), at: now,
      expireAt: admin.firestore.Timestamp.fromMillis(now + LOG_DAYS * 86400000),
    }).catch((err) => logger.warn('apiLog failed', { error: String(err.message) }));
  }

  // ---------- lab-wide data, kept a minute per instance ----------
  const cache = {};
  function cached(key, load){
    const hit = cache[key];
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const value = load().catch((err) => { delete cache[key]; throw err; });
    cache[key] = { at: Date.now(), value };
    return value;
  }
  const docs = (snap) => snap.docs.map((d) => Object.assign({ _id: d.id, _path: d.ref.path }, d.data()));
  const lab = {
    people: () => cached('people', async () => docs(await db.collection('people').get())),
    members: () => cached('members', async () => docs(await db.collection('members').get())),
    boards: () => cached('boards', async () => docs(await db.collection('boards').get())),
    cards: () => cached('cards', async () => (await db.collectionGroup('cards').get()).docs.map((d) => ({ boardId: d.ref.parent.parent.id, id: d.id, data: d.data() }))),
    unassigned: () => cached('projects', async () => (await db.collection('projects').get()).docs.map((d) => ({ id: d.id, data: d.data() }))),
    workspaces: () => cached('workspaces', async () => docs(await db.collection('projectWorkspaces').get())),
    events: () => cached('events', async () => docs(await db.collection('events').get())),
    sessions: () => cached('sessions', async () => docs(await db.collection('collabWeekSessions').get())),
    talks: () => cached('talks', async () => docs(await db.collection('collabWeekTalks').get())),
    studies: () => cached('studies', async () => docs(await db.collection('studies').get())),
    series: () => cached('series', async () => docs(await db.collection('eventSeries').get())),
    skills: () => cached('skills', async () => docs(await db.collection('skills').get())),
    guides: () => cached('guides', async () => docs(await db.collection('guides').get())),
    handbook: () => cached('handbook', async () => docs(await db.collection('handbook').get())),
    comments: () => cached('comments', async () => docs(await db.collectionGroup('comments').get())),
  };

  const url = (href) => SITE_URL + href;
  const plain = (t) => String(t || '').replace(/@\[([^\]]+)\]\(U[A-Z0-9]+\)/g, '@$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = (q) => fold(q).split(/\s+/).filter(Boolean);
  const matches = (hay, ws) => { const h = fold(hay); return ws.every((w) => h.indexOf(w) !== -1); };
  const projectHref = (id, board) => 'project.html#id=' + encodeURIComponent(id) + (board ? '&board=' + encodeURIComponent(board) : '');
  const guideHref = (slug) => 'guide.html?guide=' + encodeURIComponent(slug);
  const DAYS = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
  function meetingText(m){
    if (!m || !m.day || !m.time) return '';
    const [h, mi] = m.time.split(':').map(Number), end = h * 60 + mi + (m.minutes || 60);
    const pad = (n) => String(n).padStart(2, '0');
    return DAYS[m.day] + 's, ' + m.time + '–' + pad(Math.floor(end / 60) % 24) + ':' + pad(end % 60) + ' London time' +
      (m.every > 1 ? ', every ' + m.every + ' weeks' : '') + (m.until ? ', until ' + m.until : '') + (m.link ? ', on its own link' : '');
  }
  // Email → name: the roster, members' own names, else how a project lists them (an
  // author, or whoever registered it), for people not on Slack.
  async function nameOf(){
    const [people, members, cards, unassigned] = await Promise.all([lab.people(), lab.members(), lab.cards(), lab.unassigned()]);
    const by = {};
    cards.concat(unassigned).forEach((c) => [c.data.submittedBy].concat(c.data.authors || []).forEach((a) => {
      if (a && a.email && a.name) by[String(a.email).toLowerCase()] = { name: a.name };
    }));
    people.forEach((p) => { if (p.email) by[String(p.email).toLowerCase()] = { name: p.name, slackId: p.slackId || p._id }; });
    members.forEach((m) => { const e = String(m.email || m._id).toLowerCase(); by[e] = Object.assign({}, by[e], { name: m.name || (by[e] && by[e].name) }); });
    return (email) => { const x = by[String(email || '').toLowerCase()]; return (x && x.name) || 'someone not on BOLD.OS'; };
  }
  async function profileUrlOf(){
    const people = await lab.people(), by = {};
    people.forEach((p) => { if (p.email) by[String(p.email).toLowerCase()] = p.slackId || p._id; });
    return (email) => { const id = by[String(email || '').toLowerCase()]; return id ? url('person.html?id=' + encodeURIComponent(id)) : ''; };
  }
  async function allProjects(){
    const [boards, cards, unassigned, workspaces] = await Promise.all([lab.boards(), lab.cards(), lab.unassigned(), lab.workspaces()]);
    return allProjectsFromCards(
      boards.map((b) => ({ id: b._id, label: b.label, status: b.status || 'approved' })), cards, unassigned,
      workspaces.filter((w) => w.completedAt > 0).map((w) => w._id), workspaces.filter(workspaceStarted).map((w) => w._id));
  }
  function isHidden(ev, full){ return ev.hidden !== false && !full; }

  // ---------- subscribing to the Calendar (calendar.html's Subscribe) ----------
  // One private link a person: GET /calendar/<token>.ics on boldApi, for Google Calendar,
  // Apple Calendar or Outlook, which can't sign in. It holds what its owner can see on the
  // Calendar, as they can see it whenever it's fetched (events, if they can view Events;
  // project and supervision meetings, if they can view Projects), without the meetings
  // they're in: those are already in their calendar, as invitations; and the released lab
  // meetings (eventSeries) they aren't invited to, if they can view Events. It stops working
  // when they leave the BOLD Slack or make a new link.
  // calendarFeeds/{email} { token, createdAt, lastUsedAt }; server only (firestore.rules' deny-all).
  // data: { action: 'get' } → { url }: theirs, made the first time
  //       { action: 'reset' } → { url }: a new one; the old one stops working
  const feedUrl = (token) => 'https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/calendar/' + token + '.ics';
  const calendarFeed = onCall(async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'calendar', 'view');
    const action = (request.data || {}).action;
    if (action !== 'get' && action !== 'reset') throw new HttpsError('invalid-argument', 'Unknown action.');
    const ref = db.collection('calendarFeeds').doc(email), snap = await ref.get();
    if (action === 'get' && snap.exists && snap.data().token) return { url: feedUrl(snap.data().token) };
    const token = 'cal_' + crypto.randomBytes(24).toString('base64url');
    await ref.set({ token, createdAt: Date.now(), lastUsedAt: 0 });
    return { url: feedUrl(token) };
  });

  async function calendarIcs(token){
    if (!/^cal_[A-Za-z0-9_-]{32}$/.test(token)) throw httpError(404, 'No such calendar.');
    const snap = await db.collection('calendarFeeds').where('token', '==', token).limit(1).get();
    if (snap.empty) throw httpError(404, 'No such calendar: the link may have been replaced by a new one.');
    const doc = snap.docs[0], email = doc.id;
    if (!(await personByEmail(email))) throw httpError(403, 'Only people in the BOLD Slack can use BOLD.OS.');
    if (!(await access.can(email, 'calendar', 'view'))) throw httpError(403, 'The Calendar isn’t open to your group.');
    if (Date.now() - (doc.data().lastUsedAt || 0) > 3600000) doc.ref.update({ lastUsedAt: Date.now() }).catch(() => {});
    const [seeEvents, seeMeetings, full] = await Promise.all([access.can(email, 'events', 'view'), access.can(email, 'projects', 'view'), isFullWrite(email)]);
    const mine = (list) => (list || []).some((e) => String(e || '').toLowerCase() === email);
    let events = [], meetings = [];
    if (seeEvents) {
      events = (await lab.events()).filter((e) => !isHidden(e, full)).map((e) => ({
        id: e._id, title: e.title, start: e.startDate, end: e.endDate, place: e.place || '', description: plain(e.description),
        url: url(e.page || 'event.html?event=' + encodeURIComponent(e._id)) }));
      // Lab meetings (eventSeries): the released ones they aren't invited to.
      (await lab.series()).filter((x) => x.hidden === false && x.meeting && (x.eventId || x.pausedAt) && (x.guests || []).indexOf(email) < 0).forEach((x) => {
        meetings.push({ id: 'series-' + x._id, title: x.title, meeting: x.meeting, start: x.eventStart, pausedAt: x.pausedAt,
          description: plain(x.description), url: url('series.html?series=' + encodeURIComponent(x._id)) });
      });
    }
    if (seeMeetings) {
      const [workspaces, studies, name] = await Promise.all([lab.workspaces(), lab.studies(), nameOf()]);
      // Ids without anyone's address in them.
      const hid = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 20);
      workspaces.filter((w) => w.meeting && (w.eventId || w.pausedAt) && w.group !== 'completed' && !w.completedAt && !mine(w.members)).forEach((w) => {
        meetings.push({ id: 'project-' + w._id, title: (w.title || 'Untitled') + ' · project meeting', meeting: w.meeting, start: w.eventStart, pausedAt: w.pausedAt,
          description: Array.from(new Set((w.members || []).map(name))).join(', '), url: url(projectHref(w.cardId || w._id, w.boardId)) });
      });
      studies.filter((s) => s.meeting && (s.eventId || s.pausedAt) &&
        !mine([s._id].concat(s.everyone || [], (s.people || []).map((p) => p.email)))).forEach((s) => {
        meetings.push({ id: 'study-' + hid(s._id), title: (s.name || name(s._id)) + ' · ' + (s.degree === 'Master student' ? 'Master' : 'PhD') + ' supervision',
          meeting: s.meeting, start: s.eventStart, pausedAt: s.pausedAt, description: s.title || '', url: url('calendar.html') });
      });
    }
    return require('./calendar-ics').buildCalendar({ name: 'BOLD Lab', events, meetings });
  }

  // ---------- acting: through the site's own callables, as the token's owner ----------
  // The same function the page calls (same checks, same Slack messages), with the
  // caller's identity as a Slack sign-in would give it.
  const CODE_STATUS = { 'invalid-argument': 400, 'failed-precondition': 409, 'already-exists': 409, 'not-found': 404, 'permission-denied': 403, 'resource-exhausted': 429, 'unauthenticated': 401 };
  async function act(who, fn, data){
    const auth = { uid: 'api:' + who.prefix, token: { email: who.email, name: who.name, firebase: { identities: { [SIGN_IN_PROVIDER]: ['api'] }, sign_in_provider: SIGN_IN_PROVIDER } } };
    try { return (await callables()[fn].run({ auth, data, rawRequest: null })) || {}; }
    catch (err) {
      if (err && CODE_STATUS[err.code]) throw httpError(CODE_STATUS[err.code], err.message);
      throw err;
    }
  }
  // A name (or part of one) → one email from `pool` ([{ email, name }]), or a 409 listing the matches.
  function resolve(pool, name, what){
    const ws = words(name);
    if (!ws.length) throw httpError(400, 'Say who: ' + what + '.');
    const exact = pool.filter((x) => fold(x.name) === fold(name));
    const some = exact.length ? exact : pool.filter((x) => matches(x.name, ws));
    const emails = Array.from(new Set(some.map((x) => String(x.email).toLowerCase())));
    if (!emails.length) throw httpError(404, 'Nobody called “' + name + '” among ' + what + '.');
    if (emails.length > 1) throw httpError(409, 'More than one ' + what + ' matches “' + name + '”: ' + Array.from(new Set(some.map((x) => x.name))).slice(0, 10).join(', ') + '. Give the full name.');
    return emails[0];
  }
  async function cardOf(id){
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''))) throw httpError(400, 'Give a project id, from list_projects.');
    const [cards, unassigned] = await Promise.all([lab.cards(), lab.unassigned()]);
    const hit = cards.find((c) => c.id === id) || unassigned.map((u) => ({ boardId: null, id: u.id, data: u.data })).find((c) => c.id === id);
    if (!hit) throw httpError(404, 'No project with that id.');
    return hit;
  }

  // ---------- the tools ----------
  // The tools the lab adds, from the Tools pages (agentTools), run in mcpSandbox (functions/api-tools.js).
  const added = require('./api-tools')({ db, httpError, builtins: () => TOOLS, idTokenFor: (e) => actions.idTokenFor(e), fetchImpl: deps.fetchImpl, sandboxUrl: deps.sandboxUrl, SITE_URL });
  const actions = require('./api-actions')({ db, admin, logger, httpError, act, resolve, cardOf, lab, words, fold, matches, url, isFullWrite, SITE_URL, fetchImpl: deps.fetchImpl, checkTool: (n, d) => added.check(n, d) });
  const SCOPES = ['boldiquette', 'guides', 'skills', 'events', 'projects', 'people', 'board', 'comments'];
  const TOOLS = [
    {
      name: 'search',
      description: 'Search BOLD.OS as its site search does: the BOLDiquette (the lab handbook), how-to guides, skills, events with their sessions and talks, projects, people, papers on the Internal Review Board, and comments. Every word must match, as a whole word or a word’s start (abbreviations such as RL and LLM included), unless nothing does; title matches rank first.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Words to look for.' },
        scope: { type: 'string', enum: SCOPES, description: 'Only this section (default: everywhere).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'At most this many results (default 25).' },
      }, required: ['query'] },
      run: search,
    },
    {
      name: 'list_projects',
      description: 'The lab’s research projects, as on the Projects page: planned, ongoing (being worked on), in submission (on a venue’s board) and completed, most recently updated first. Filter by group, keyword, words, or only yours.',
      inputSchema: { type: 'object', properties: {
        group: { type: 'string', enum: ['planned', 'ongoing', 'submission', 'completed'] },
        keyword: { type: 'string', description: 'A project keyword, e.g. "reinforcement learning".' },
        query: { type: 'string', description: 'Words in the title, abstract, keywords or people.' },
        mine: { type: 'boolean', description: 'Only projects you are a member of.' },
      } },
      run: listProjects,
    },
    {
      name: 'get_project',
      description: 'One project in full: abstract, authors, members, keywords, stage, venues, its Slack channel, weekly meeting, slides, notes, paper links and presentations. Takes the id from list_projects or search.',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string', description: 'The project id (its card id).' },
      }, required: ['id'] },
      run: getProject,
    },
    {
      name: 'find_people',
      description: 'People in BOLD (Who is BOLD): name, group, role, institution, interests and their profile page. Filter by words or group. Emails are left out.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Words in their name, role, institution, interests or where they are based.' },
        group: { type: 'string', enum: Object.keys(GROUP_LABEL), description: 'exec (PIs), staff, internal, associate, or pan (PAN-BOLD).' },
      } },
      run: findPeople,
    },
    {
      name: 'get_person',
      description: 'One person in full: their details, their studies (for PhD and Master students) and the projects they are a member of. Takes a name (or part of one) or their Slack id.',
      inputSchema: { type: 'object', properties: {
        name: { type: 'string', description: 'Their name, or part of it.' },
        slack_id: { type: 'string', description: 'Their Slack user id (U…).' },
      } },
      run: getPerson,
    },
    {
      name: 'calendar',
      description: 'What is on, as on the Calendar: the lab’s events between two dates (with their schedule of sessions), and the recurring project, supervision and lab meetings.',
      inputSchema: { type: 'object', properties: {
        from: { type: 'string', description: 'YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'YYYY-MM-DD (default: 60 days after from).' },
        kind: { type: 'string', enum: ['all', 'events', 'meetings'], description: 'Default: all.' },
      } },
      run: calendar,
    },
    {
      name: 'my_items',
      description: 'Your own things on BOLD.OS, with their ids: the projects you are on, your studies, recommendation letters you asked for or write, introductions (asked, asked of you, your offers), requests to join supervision meetings, and an open request to change group.',
      inputSchema: { type: 'object', properties: {} },
      run: myItems,
    },
    {
      name: 'list_introduction_offers',
      description: 'Offers of introductions (Service desk → Introductions): people in BOLD who can introduce you to someone at a company or institution. Each has an id for ask_for_introduction.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words in the organisation, area or who offers.' } } },
      run: listOffers,
    },
    // Acting, and what it needs to read: functions/api-actions.js.
    ...actions.READ,
    ...actions.WRITE,
    { name: 'list_tools', description: 'BOLD.OS’s own tools and the ones the lab has added (Tools pages), with how to propose a new tool or a change to one. with_code: true includes the added tools’ code.',
      inputSchema: { type: 'object', properties: { with_code: { type: 'boolean' } } }, run: (who, a) => added.listTools(who, a) },
  ];
  // Who can see what (functions/access.js): each reading tool reads one page, and answers
  // only if its person may view that page. Acting goes through the rules and callables,
  // which check it themselves.
  const TOOL_PAGE = { search: 'search', list_projects: 'projects', get_project: 'projects', find_people: 'people', get_person: 'people',
    calendar: 'calendar', my_items: 'profile', list_introduction_offers: 'service-desk', list_tools: 'tools', list_skills: 'skills', get_skill: 'skills' };
  const pageOfTool = (name, args) => { const p = String((args || {}).page || '').trim().toLowerCase();
    return name === 'read_page' ? (p === 'boldiquette' ? 'boldiquette' : require('./access').guideArea(p)) : TOOL_PAGE[name]; };
  async function mayView(who, page){
    if (!page || await access.can(who.email, page, 'view')) return;
    const level = ((await access.table())[page] || {}).view || 'internal';
    throw httpError(403, 'That page is for ' + (require('./access').LEVEL_NAMES[level] || level) + ' and above (BOLDiquette › Who can see what).');
  }
  const toolsFor = (who) => TOOLS.filter((t) => !t.write || who.write);
  // A tool by name: BOLD.OS's own, else one the lab's agents added (run in mcpSandbox).
  async function toolNamed(who, name){
    const t = TOOLS.find((x) => x.name === name);
    if (t) return Object.assign({}, t, { run: async (w, args) => { await mayView(w, pageOfTool(t.name, args)); return t.run(w, args); } });
    const one = (await added.toolList(Object.assign({}, who, { write: true }))).find((x) => x.name === name);
    if (!one) return null;
    // The lab's added tools come from the Tools page.
    return Object.assign({}, one, { run: async (w, args) => { await mayView(w, 'tools'); return added.runTool(w, name, args || {}); } });
  }
  async function runBuiltin(who, name, args){
    const t = TOOLS.find((x) => x.name === name);
    if (!t || t.write || t.setup) throw httpError(404, 'No reading tool ' + name + '.');
    return t.run(who, args || {});
  }

  async function listOffers(who, a){
    const [offers, asked] = await Promise.all([
      db.collection('introOffers').get().then((s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
      db.collection('introRequests').where('requesterEmail', '==', who.email).get().then((s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
    ]);
    const ws = words(a.query);
    const rows = offers.filter((o) => !ws.length || matches([o.org, o.area, o.by && o.by.name].join(' '), ws))
      .sort((x, y) => fold(x.org).localeCompare(fold(y.org)))
      .map((o) => {
        const mine = asked.find((q) => q.offerId === o.id && (q.status === 'asked' || q.status === 'accepted'));
        return { id: o.id, organisation: o.org, area: o.area || '', offered_by: o.by && o.by.name || '', yours: String(o.by && o.by.email || '').toLowerCase() === who.email,
          you_asked: mine ? { id: mine.id, status: mine.status } : null, url: url('introductions.html') };
      });
    return { total: rows.length, offers: rows };
  }

  async function search(who, a){
    const ws = words(a.query);
    if (!ws.length) throw httpError(400, 'Give a query.');
    const scope = SCOPES.indexOf(a.scope) !== -1 ? a.scope : '';
    const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 100);
    const full = await isFullWrite(who.email);
    const items = [];
    const item = (s, title, where, text, href) => items.push({ scope: s, title: plain(title) || 'Untitled', where, text: plain(text), url: url(href) });
    const want = (s) => !scope || scope === s;
    const parts = (list, s, page, prefix, where) => list.forEach((x) => {
      const href = page(x._id), name = x.title || x._id;
      item(s, name, where, x.description, href);
      (x.parts || []).forEach((p) => item(s, p.title, name + (p.section ? ' › ' + p.section : ''), p.body, href + '#' + prefix + p.id));
    });
    const jobs = [];
    if (want('boldiquette')) jobs.push(lab.handbook().then((l) => parts(l, 'boldiquette', (id) => id === 'boldiquette' ? 'boldiquette.html' : 'index.html', '', 'BOLDiquette')));
    // Get started is the Service desk's (access.js GUIDE_AREAS): labelled so, and only for who can see that.
    if (want('guides')) jobs.push(lab.guides().then(async (l) => {
      for (const g of l) {
        const area = require('./access').guideArea(g._id);
        if (area === 'guides' || await access.can(who.email, area, 'view')) parts([g], 'guides', guideHref, 'p-', area === 'guides' ? 'How to' : 'Service desk');
      }
    }));
    if (want('skills')) jobs.push(lab.skills().then((l) => l.forEach((x) => item('skills', x.title || x.name || x._id, 'Skill', [x.name, x.description, x.body].join(' '), 'skill.html?skill=' + encodeURIComponent(x._id)))));
    if (want('events')) jobs.push(Promise.all([lab.events(), lab.sessions(), lab.talks()]).then(([evs, ss, ts]) => {
      const talk = (x) => [x.abstract, x.speaker, x.affiliation, x.description, x.summary].filter(Boolean).join(' ');
      evs.filter((x) => !isHidden(x, full)).forEach((x) => item('events', x.title, 'Event' + (x.place ? ' · ' + x.place : ''), [x.description, x.place].join(' '), x.page || 'event.html?event=' + encodeURIComponent(x._id)));
      ss.forEach((x) => item('events', x.title, 'Session', talk(x), 'session.html?session=' + encodeURIComponent(x._id)));
      ts.forEach((x) => item('events', x.title, 'Talk' + (x.speaker ? ' · ' + x.speaker : ''), talk(x), 'talk.html?talk=' + encodeURIComponent(x._id)));
    }));
    if (want('projects')) jobs.push(allProjects().then((g) => [].concat(g.ongoing, g.submission, g.planned, g.completed).forEach((p) =>
      item('projects', p.title, 'Project' + (p.owner ? ' · ' + p.owner : ''), [p.abstract, (p.keywords || []).join(' '), p.owner, (p.authors || []).map((x) => x.name).filter((n) => n !== p.owner).join(' ')].join(' '), projectHref(p.projectId || p.cardId, p.boardId)))));
    if (want('people')) jobs.push(Promise.all([lab.members(), profileUrlOf()]).then(([ms, profile]) => ms.forEach((x) => {
      const p = profile(x.email || x._id);
      item('people', x.name || 'A member', [x.role, x.institution].filter(Boolean).join(' · ') || 'Member', [x.interests, x.basedIn, x.pronouns].join(' '), p ? p.slice(SITE_URL.length) : 'people.html');
    })));
    const approved = async () => {
      const boards = {};
      (await lab.boards()).forEach((b) => { if ((b.status || 'approved') === 'approved') boards[b._id] = b.label || b._id; });
      return (await lab.cards()).filter((c) => boards[c.boardId]).map((c) => Object.assign({ boardLabel: boards[c.boardId] }, c));
    };
    const cardHref = (c) => 'audit-board.html#board=' + encodeURIComponent(c.boardId) + '&card=' + encodeURIComponent(c.id);
    if (want('board')) jobs.push(approved().then((cs) => cs.forEach((c) => item('board', c.data.title, c.boardLabel, c.data.abstractText || c.data.abstract, cardHref(c)))));
    if (want('comments')) jobs.push(Promise.all([lab.comments(), approved(), lab.guides(), lab.handbook()]).then(([cs, cards, gs, hs]) => {
      const titles = {};
      gs.concat(hs).forEach((d) => { titles[d._path] = d.title || d._id; });
      cs.forEach((c) => {
        const seg = c._path.split('/'); // guides/{slug}/comments/{id}
        if (seg.length !== 4 || (seg[0] !== 'guides' && seg[0] !== 'handbook')) return;
        const page = seg[0] === 'guides' ? guideHref(seg[1]) : seg[1] === 'boldiquette' ? 'boldiquette.html' : 'index.html';
        item('comments', titles[seg[0] + '/' + seg[1]] || seg[1], 'Comment by ' + (c.by ? c.by.name || 'someone' : 'someone') + (c.resolved ? ' · resolved' : ''), [c.text, c.quote].join(' '), page + '#c=' + encodeURIComponent(c._id));
      });
      cards.forEach((cd) => {
        const threads = [].concat.apply(cd.data.discussion || [], (cd.data.checklist || []).map((it) => it.comments || []));
        [].concat.apply([], threads.map((m) => [m].concat((m && m.replies) || []))).filter((m) => m && m.id).forEach((m) =>
          item('comments', cd.data.title, 'Comment by ' + (m.author || 'someone') + ' · ' + cd.boardLabel, m.body, cardHref(cd) + '&msg=' + encodeURIComponent(m.id)));
      });
    }));
    await Promise.all(jobs);
    // As the site's search page ranks them (search-rank.js).
    const query = rank.prepare(a.query);
    let scored = rank.rank(items, query);
    if (scored.some((h) => !h.partial)) scored = scored.filter((h) => !h.partial);
    const snippet = (text) => rank.snippet(text, query, 280);
    const partial = !!(scored[0] && scored[0].partial);
    return Object.assign({ total: scored.length }, partial ? { note: 'Nothing has every word; these have most of them.' } : {},
      { results: scored.slice(0, limit).map((h) => ({ scope: h.item.scope, title: h.item.title, where: h.item.where, snippet: snippet(h.item.text), url: h.item.url })) });
  }

  function projectRow(p, group, name){
    return {
      id: p.projectId || p.cardId, board: p.boardId || null, title: p.title, group,
      venue: p.boardLabel || null, owner: p.owner || '',
      authors: (p.authors || []).map((x) => x.name || name(x.email)), keywords: p.keywords || [],
      slack_channel: p.slackChannel || '', url: url(projectHref(p.projectId || p.cardId, p.boardId)),
    };
  }
  async function listProjects(who, a){
    const [g, name, workspaces] = await Promise.all([allProjects(), nameOf(), lab.workspaces()]);
    const members = {};
    workspaces.forEach((w) => { members[w._id] = w.members || []; });
    const ws = words(a.query), kw = fold(a.keyword);
    let rows = [];
    ['ongoing', 'submission', 'planned', 'completed'].forEach((group) => {
      if (a.group && a.group !== group) return;
      g[group].forEach((p) => {
        const id = p.pid || p.projectId || p.cardId;
        if (kw && !(p.keywords || []).some((k) => fold(k) === kw)) return;
        if (ws.length && !matches([p.title, p.abstract, (p.keywords || []).join(' '), p.owner, (p.authors || []).map((x) => x.name).filter((n) => n !== p.owner).join(' ')].join(' '), ws)) return;
        const team = (members[id] || []).map((e) => String(e).toLowerCase());
        if (a.mine && team.indexOf(who.email) === -1 && !(p.authors || []).some((x) => String(x.email).toLowerCase() === who.email)) return;
        rows.push(Object.assign(projectRow(p, group, name), { id, members: team.map(name) }));
      });
    });
    return { total: rows.length, projects: rows };
  }

  async function getProject(who, a){
    const id = String(a.id || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw httpError(400, 'Give a project id, from list_projects.');
    const [cards, unassigned, boards, workspaces, name, profile] = await Promise.all([lab.cards(), lab.unassigned(), lab.boards(), lab.workspaces(), nameOf(), profileUrlOf()]);
    const labels = {};
    boards.forEach((b) => { if ((b.status || 'approved') !== 'pending') labels[b._id] = b.label || b._id; });
    // Its cards: the one asked for, and every card of the same project.
    const all = cards.filter((c) => labels[c.boardId]).concat(unassigned.map((u) => ({ boardId: null, id: u.id, data: u.data })));
    const hit = all.find((c) => c.id === id);
    if (!hit) throw httpError(404, 'No project with that id.');
    const pid = hit.data.projectId || hit.id;
    const mine = all.filter((c) => (c.data.projectId || c.id) === pid).sort((x, y) => (x.data.createdAt || 0) - (y.data.createdAt || 0));
    const card = mine[mine.length - 1].data, w = workspaces.find((x) => x._id === pid) || {};
    const presentations = (await db.collection('projectWorkspaces').doc(pid).collection('presentations').get()).docs.map((d) => d.data())
      .map((t) => ({ title: t.title, type: t.type, date: t.date || '', presenter: t.presenter && (t.presenter.name || name(t.presenter.email)), slides: t.slidesUrl || '', recording: t.recordingUrl || '' }));
    // Its work board's own cards (the Work tab); its issues, pull requests and proposals come with the work tool's list.
    const COLUMN = { todo: 'To do', doing: 'In progress', review: 'Waiting for review', done: 'Done' };
    const work = w.work && w.work.on ? {
      repositories: (w.work.repos && w.work.repos.length ? w.work.repos : w.repoName ? [w.repoName] : []).map((r) => 'bold-lab-ai/' + r),
      shows_site_proposals: !!w.work.content,
      cards: (await db.collection('projectWorkspaces').doc(pid).collection('work').get()).docs.map((d) => {
        const c = d.data();
        return { card_id: d.id, title: c.title, notes: c.notes || '', column: COLUMN[c.column] || c.column, assigned_to: (c.assignees || []).map((x) => x.name || name(x.email)),
          links: (c.links || []).map((l) => l.url), made_by: c.by && (c.by.name || name(c.by.email)) };
      }),
    } : null;
    return {
      id: pid, title: card.title || 'Untitled', url: url(projectHref(mine[mine.length - 1].id, mine[mine.length - 1].boardId)),
      group: projectGroupForCards(mine, !!w.completedAt, workspaceStarted(w)),
      stage: card.status || '', outcome: card.outcome || '',
      venues: mine.map((c) => ({ venue: c.boardId ? labels[c.boardId] : 'No venue yet', stage: c.data.status || '', outcome: c.data.outcome || '' })),
      abstract: card.abstractText || '', keywords: card.keywords || [],
      registered_by: card.submittedBy ? card.submittedBy.name || name(card.submittedBy.email) : '',
      authors: (card.authors || []).map((x) => ({ name: x.name || name(x.email), profile: profile(x.email) })),
      members: (w.members || []).map((e) => ({ name: name(e), profile: profile(e) })),
      slack_channel: card.slackChannel || '',
      meeting: w.meeting ? meetingText(w.meeting) + (w.pausedAt ? ' (paused)' : '') : '', meet_url: w.meetUrl || '',
      slides: w.deckUrl || '', notes: w.notesUrl || '', repository: w.repoUrl || '',
      links: { overleaf: card.overleafLink || '', arxiv: card.arxivLink || '', pitch: card.pitchLink || '', submission: card.submissionLink || '', camera_ready: card.cameraReadyLink || '' },
      presentations, work,
    };
  }

  function personRow(m, profile){
    const g = groupOf(m);
    return {
      name: m.name || '', group: GROUP_LABEL[g] || g, role: m.role || '', institution: m.institution || '',
      interests: m.interests || '', pillars: m.pillars || [], based_in: m.basedIn || '', pronouns: m.pronouns || '',
      links: m.links || '', booking: m.bookingUrl || '', profile: profile(m.email || m._id),
    };
  }
  async function findPeople(who, a){
    const [ms, profile] = await Promise.all([lab.members(), profileUrlOf()]);
    const ws = words(a.query);
    const rows = ms.filter((m) => (!a.group || groupOf(m) === a.group) &&
      (!ws.length || matches([m.name, m.role, m.institution, m.interests, m.basedIn, (m.pillars || []).join(' ')].join(' '), ws)))
      .map((m) => personRow(m, profile)).sort((x, y) => x.name.localeCompare(y.name));
    return { total: rows.length, people: rows };
  }
  async function getPerson(who, a){
    const [people, ms, profile, name, workspaces, studies] = await Promise.all([lab.people(), lab.members(), profileUrlOf(), nameOf(), lab.workspaces(), lab.studies()]);
    let email = a._email || '';
    if (email) { /* my_items: the caller */ }
    else if (a.slack_id) { const p = people.find((x) => (x.slackId || x._id) === a.slack_id); email = p ? String(p.email).toLowerCase() : ''; }
    else if (a.name) {
      const ws = words(a.name), named = ms.map((m) => ({ e: String(m.email || m._id).toLowerCase(), n: m.name })).concat(people.map((p) => ({ e: String(p.email || '').toLowerCase(), n: p.name })));
      const exact = named.find((x) => fold(x.n) === fold(a.name)), some = named.filter((x) => matches(x.n, ws));
      const distinct = Array.from(new Set(some.map((x) => x.e)));
      if (!exact && distinct.length > 1) return { ambiguous: true, matches: distinct.slice(0, 20).map((e) => ({ name: name(e), profile: profile(e) })) };
      email = exact ? exact.e : distinct[0] || '';
    } else throw httpError(400, 'Give a name or a slack_id.');
    if (!email) throw httpError(404, 'Nobody by that name or id.');
    const m = ms.find((x) => String(x.email || x._id).toLowerCase() === email);
    const s = studies.find((x) => x._id === email);
    return Object.assign(m ? personRow(m, profile) : { name: name(email), profile: profile(email), details: 'They haven’t added their details yet.' }, {
      studies: s ? { degree: s.degree || '', title: s.title || '', people: (s.people || []).map((p) => p.name || name(p.email)), meeting: meetingText(s.meeting) + (s.pausedAt ? ' (paused)' : '') } : null,
      projects: workspaces.filter((w) => (w.members || []).some((e) => String(e).toLowerCase() === email))
        .map((w) => ({ id: w._id, title: w.title || 'Untitled', group: w.group || '', url: url(projectHref(w.cardId || w._id, w.boardId)) })),
    });
  }

  async function calendar(who, a){
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date().toISOString().slice(0, 10);
    const from = iso.test(a.from || '') ? a.from : today;
    const to = iso.test(a.to || '') ? a.to : new Date(Date.parse(from + 'T00:00:00Z') + 60 * 86400000).toISOString().slice(0, 10);
    const kind = a.kind || 'all', out = { from, to };
    const [full, name] = await Promise.all([isFullWrite(who.email), nameOf()]);
    if (kind !== 'meetings') {
      const [evs, sessions] = await Promise.all([lab.events(), lab.sessions()]);
      const titles = {};
      sessions.forEach((s) => { titles[s._id] = s.title; });
      out.events = evs.filter((e) => !isHidden(e, full) && e.startDate && (e.endDate || e.startDate) >= from && e.startDate <= to)
        .sort((x, y) => x.startDate.localeCompare(y.startDate))
        .map((e) => ({
          title: e.title, start: e.startDate, end: e.endDate || e.startDate, place: e.place || '', description: plain(e.description),
          url: url(e.page || 'event.html?event=' + encodeURIComponent(e._id)),
          schedule: (e.days || []).filter((d) => !d.date || (d.date >= from && d.date <= to)).map((d) => ({
            date: d.date || '', slots: (d.slots || []).map((sl) => ({
              start: sl.start || '', end: sl.end || '', title: sl.title || '', kind: sl.kind || '',
              sessions: (sl.sessions || []).map((id) => titles[id]).filter(Boolean),
            })),
          })),
        }));
    }
    if (kind !== 'events') {
      const [workspaces, studies] = await Promise.all([lab.workspaces(), lab.studies()]);
      out.project_meetings = workspaces.filter((w) => w.meeting && (w.eventId || w.pausedAt) && w.group !== 'completed' && !w.completedAt)
        .map((w) => ({ project: w.title, when: meetingText(w.meeting), paused: !!w.pausedAt, members: (w.members || []).map(name),
          you_are_in_it: (w.members || []).some((e) => String(e).toLowerCase() === who.email), url: url(projectHref(w.cardId || w._id, w.boardId)) }));
      out.supervision_meetings = studies.filter((s) => s.meeting && (s.eventId || s.pausedAt))
        .map((s) => ({ student: s.name || name(s._id), title: s.title || '', when: meetingText(s.meeting), paused: !!s.pausedAt,
          you_are_in_it: (s.everyone || []).some((e) => String(e).toLowerCase() === who.email) }));
      if (await access.can(who.email, 'events', 'view')) {
        out.lab_meetings = (await lab.series()).filter((x) => x.hidden === false && x.meeting && (x.eventId || x.pausedAt))
          .map((x) => ({ id: x._id, title: x.title, when: meetingText(x.meeting), paused: !!x.pausedAt,
            invited: x.invite && x.invite.mode === 'group' ? (GROUP_LABEL[x.invite.group] || 'everyone in BOLD') + ' and above' : 'whoever joins',
            you_are_invited: (x.guests || []).indexOf(who.email) >= 0, url: url('series.html?series=' + encodeURIComponent(x._id)) }));
      }
    }
    return out;
  }

  async function myItems(who){
    const e = who.email;
    const q = (col, field) => db.collection(col).where(field, '==', e).get().then((s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data())));
    const [lettersAsked, lettersToWrite, introsAsked, introsOfMe, me, name, studyAsked, studyOfMe, offers, groupReqs] = await Promise.all([
      q('letterRequests', 'requesterEmail'), q('letterRequests', 'writerEmail'), q('introRequests', 'requesterEmail'), q('introRequests', 'offererEmail'),
      getPerson(who, { _email: e }), nameOf(), q('studyRequests', 'email'), q('studyRequests', 'student'), q('introOffers', 'by.email'), q('groupRequests', 'email'),
    ]);
    const study = (x, asStudent) => ({ id: x.id, with: asStudent ? x.name : x.studentName, note: x.note || '', status: x.status });
    const letter = (x, asWriter) => ({
      with: asWriter ? x.requesterName || name(x.requesterEmail) : x.writerName || name(x.writerEmail),
      id: x.id, purpose: x.purpose || '', open: x.open !== false,
      recipients: (x.recipients || []).map((r) => ({ name: r.name || '', deadline: r.deadline || '', submitted: !!r.submittedAt })),
      url: url('letters.html#l=' + x.id),
    });
    const intro = (x, asOfferer) => ({ id: x.id, organisation: x.org, with: asOfferer ? x.requesterName : x.offererName, status: x.status, url: url('introductions.html#i=' + x.id) });
    return {
      you: { name: me.name, profile: me.profile, group: me.group || '' },
      projects: me.projects, studies: me.studies,
      letters: { you_asked: lettersAsked.map((x) => letter(x, false)), you_write: lettersToWrite.map((x) => letter(x, true)) },
      introductions: { you_asked: introsAsked.map((x) => intro(x, false)), asked_of_you: introsOfMe.map((x) => intro(x, true)),
        your_offers: offers.map((x) => ({ id: x.id, organisation: x.org, area: x.area || '' })) },
      supervision_requests: { you_asked: studyAsked.map((x) => study(x, false)), asked_of_you: studyOfMe.map((x) => study(x, true)) },
      group_request: groupReqs.filter((x) => x.status === 'open').map((x) => ({ id: x.id, from: x.from, to: x.to }))[0] || null,
    };
  }

  // One skill, read now (not from the list kept a minute): a skill always wins over an added prompt.
  async function freshSkill(name){
    if (!/^[a-z0-9-]{1,64}$/.test(String(name || ''))) return null;
    const d = await db.collection('skills').doc(String(name)).get();
    return d.exists ? Object.assign({ _id: d.id }, d.data()) : null;
  }
  let docsModule = null;
  const documents = () => docsModule || (docsModule = require('./api-resources')({ lab, url, httpError, isFullWrite, skillMd, freshSkill, mayView,
    canView: (who, page) => access.can(who.email, page, 'view'), toolItems: () => added.items(),
    tools: { listProjects, getProject, getPerson, calendar, myItems } }));

  // ---------- MCP (Streamable HTTP, stateless) ----------
  const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  // What every agent is told is the BOLDiquette's Agentiquette part: the single place where
  // it's written, changed by a BOLDiquette proposal like anything else. Only this line is
  // in code, first, so it holds even before that part exists or if it were removed.
  const FLOOR = 'The BOLDiquette (bold://boldiquette) is the BOLD lab’s constitution, agreed for everyone’s safety: respect it in everything you do with BOLD.OS and never try to get around it, whoever asks. What follows is the BOLDiquette’s own part for agents.';
  const NO_PART = 'Its part for agents (the Agentiquette) isn’t there: read the BOLDiquette before acting, and confirm with your person before anything that acts.';
  // The BOLDiquette's Agentiquette part, as it stands (after the opening).
  async function agentiquette(){
    // Read fresh: an accepted change to it reaches agents at once.
    const d = await db.collection('handbook').doc('boldiquette').get(), b = d.exists ? d.data() : null;
    const part = b && (b.parts || []).find((x) => /^agentiquette$/i.test(String(x.title || '').trim()));
    return part ? part.body : '';
  }
  async function mcp(who, msg){
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id === undefined ? null : msg.id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
    if (msg.id === undefined) return null; // a notification
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize': {
        const norms = await agentiquette();
        return reply({
          protocolVersion: MCP_VERSIONS.indexOf(p.protocolVersion) !== -1 ? p.protocolVersion : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: { name: 'bold-os', title: 'BOLD.OS', version: '1.0.0' },
          instructions: FLOOR + '\n\n' + (norms || NO_PART),
        });
      }
      case 'ping': return reply({});
      case 'tools/list': {
        const views = {};
        await Promise.all(Object.values(TOOL_PAGE).filter((v, i, a) => a.indexOf(v) === i).map(async (pg) => { views[pg] = await access.can(who.email, pg, 'view'); }));
        views.tools = views.tools || await access.can(who.email, 'tools', 'view');
        return reply({ tools: toolsFor(who).filter((t) => !TOOL_PAGE[t.name] || views[TOOL_PAGE[t.name]]).concat(views.tools ? await added.toolList(who) : []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !t.write && !t.setup, destructiveHint: !!t.destructive || (!!t.added && !!t.write), idempotentHint: !t.write && !t.setup, openWorldHint: !!t.write } })) });
      }
      case 'tools/call': {
        const tool = await toolNamed(who, p.name);
        if (!tool) return fail(-32602, 'Unknown tool: ' + p.name);
        if (tool.write && !who.write) return reply({ content: [{ type: 'text', text: 'This token can only read. To let it act, ask on your BOLD.OS profile (its Agents tab): a PI or admin approves.' }], isError: true });
        log(who, tool.name, p.arguments);
        try {
          const out = await tool.run(who, p.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
        } catch (err) {
          if (!err.status) logger.error('boldApi tool failed', { tool: tool.name, error: String(err.stack || err) });
          return reply({ content: [{ type: 'text', text: err.status ? err.message : 'That failed on BOLD.OS’s side — try again.' }], isError: true });
        }
      }
      // The skills as prompts, every document as a resource (functions/api-resources.js).
      case 'prompts/list': case 'prompts/get': case 'resources/list': case 'resources/templates/list': case 'resources/read': {
        const R = documents();
        try {
          if (msg.method === 'prompts/get' || msg.method === 'resources/read') log(who, msg.method, p);
          return reply(await ({ 'prompts/list': R.listPrompts, 'prompts/get': R.getPrompt, 'resources/list': R.listResources,
            'resources/templates/list': R.listTemplates, 'resources/read': R.readResource })[msg.method](who, p));
        } catch (err) {
          if (!err.status) { logger.error('boldApi ' + msg.method + ' failed', { error: String(err.stack || err) }); return fail(-32603, 'That failed on BOLD.OS’s side — try again.'); }
          return fail(err.status === 404 ? (msg.method === 'resources/read' ? -32002 : -32602) : -32602, err.message);
        }
      }
      default: return fail(-32601, 'Method not found: ' + msg.method);
    }
  }

  // ---------- the HTTPS function ----------
  // The secrets are those of the callables the write tools go through.
  const boldApi = onRequest({ cors: true, memory: '512MiB', timeoutSeconds: 300, secrets }, async (req, res) => {
    const path = req.path.replace(/\/+$/, '') || '/';
    if (path === '/' && req.method === 'GET') {
      return res.json({ name: 'BOLD.OS API', mcp: '/mcp', mcp_also: 'prompts (the skills) and resources (every page, bold://…)', read: TOOLS.filter((t) => !t.write && !t.setup).map((t) => 'GET /v1/' + t.name), act: TOOLS.filter((t) => t.write).map((t) => 'POST /v1/' + t.name), auth: 'Authorization: Bearer <token from the Agents tab of your BOLD.OS profile>' });
    }
    // A Calendar subscription (calendarFeed): the link is the key, as calendar apps can't send one.
    const cal = /^\/calendar\/([^/]+)\.ics$/.exec(path);
    if (cal) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET').send('GET this link.');
      try {
        const ics = await calendarIcs(cal[1]);
        return res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('Cache-Control', 'private, max-age=300')
          .set('Content-Disposition', 'inline; filename="bold-lab.ics"').send(ics);
      } catch (err) {
        if (!err.status) logger.error('calendar feed failed', { error: String(err.stack || err) });
        return res.status(err.status || 500).type('text/plain').send(err.status ? err.message : 'Something went wrong.');
      }
    }
    if (path === '/mcp' && req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'POST JSON-RPC to /mcp.' });
    let who;
    try { who = await authorize(req); }
    catch (err) {
      if (!err.status) { logger.error('boldApi auth failed', { error: String(err.stack || err) }); return res.status(500).json({ error: 'Something went wrong.' }); }
      if (err.status === 401) res.set('WWW-Authenticate', 'Bearer realm="BOLD.OS"');
      return res.status(err.status).json(path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32001, message: err.message } } : { error: err.message });
    }
    if (path === '/mcp') {
      const body = req.body;
      if (Array.isArray(body)) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches aren’t supported.' } });
      const out = await mcp(who, body);
      return out ? res.json(out) : res.status(202).end();
    }
    const m = /^\/v1\/([a-z0-9_]+)$/.exec(path);
    const tool = m && await toolNamed(who, m[1]);
    if (!tool) return res.status(404).json({ error: 'No such endpoint. GET / lists them.' });
    // Reads are GETs with query parameters; acting is a POST with a JSON body.
    const post = tool.write || tool.setup;
    if (req.method !== (post ? 'POST' : 'GET')) return res.status(405).set('Allow', post ? 'POST' : 'GET').json({ error: (post ? 'POST' : 'GET') + ' /v1/' + tool.name + '.' });
    if (tool.write && !who.write) return res.status(403).json({ error: 'This token can only read. To let it act, ask on your BOLD.OS profile (its Agents tab): a PI or admin approves.' });
    let args = {};
    if (post) args = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    else Object.keys(req.query).forEach((k) => {
      const v = String(req.query[k]), type = ((tool.inputSchema.properties || {})[k] || {}).type;
      args[k] = type === 'boolean' ? v === 'true' || v === '1' : type === 'integer' ? Number(v) : v;
    });
    log(who, tool.name, args);
    try { res.json(await tool.run(who, args)); }
    catch (err) {
      if (!err.status) logger.error('boldApi tool failed', { tool: tool.name, error: String(err.stack || err) });
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  });

  return { apiTokens, boldApi, calendarFeed, checkTool: (name, def) => added.check(name, def), _internal: { meetingText, TOOLS, mcp, resolve, added } };
};
