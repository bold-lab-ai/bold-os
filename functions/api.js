// ---------- BOLD.OS for agents: personal tokens, a read-only API and MCP ----------
// Anyone in the BOLD Slack makes personal tokens on their profile (Linked accounts →
// Agents; apiTokens below). A token acts as its owner and reads what they can read on
// the site: everything lab-wide, plus their own letters and introductions. A token made
// with "Can also act" (`write`) may also act: join and leave projects, ask for and answer
// introductions, ask to join a supervision meeting, ask for a letter, each through the
// page's own callable (act), so the same checks and Slack messages apply.
//
// boldApi (one HTTPS function) answers two ways, from the same tools (TOOLS):
//   POST /mcp            MCP (Streamable HTTP, stateless, JSON responses): for agents
//                        (Claude Code: claude mcp add --transport http bold-os <url>/mcp
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

module.exports = function(deps){
  const { db, admin, onRequest, onCall, HttpsError, logger, callerEmail, isFullWrite,
    allProjectsFromCards, groupOf, SITE_URL, SIGN_IN_PROVIDER, secrets, callables } = deps;

  const TOKENS_PER_PERSON = 5, RATE_PER_MINUTE = 60, LOG_DAYS = 90;
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const GROUP_LABEL = { exec: 'BOLD-exec', staff: 'BOLD-staff', internal: 'BOLD-internal', associate: 'BOLD-associate', pan: 'PAN-BOLD' };

  // ---------- tokens (the profile's Agents row) ----------
  // data: { action: 'list' } → { tokens: [{ id, label, prefix, createdAt, lastUsedAt }] }
  //       { action: 'create', label, write } → { token, id, … }: the token, once;
//                                     `write`: it may also act (WRITE tools), not just read
  //       { action: 'revoke', id }    its owner, or a PI or admin
//       { action: 'activity', all } → { tokens, log }: yours (all: everyone's, PIs and admins)
  const apiTokens = onCall(async (request) => {
    const email = callerEmail(request);
    const d = request.data || {};
    const mine = async () => (await db.collection('apiTokens').where('email', '==', email).get()).docs;
    const view = (doc) => { const x = doc.data(); return { id: doc.id, label: x.label || '', prefix: x.prefix, write: !!x.write, createdAt: x.createdAt || 0, lastUsedAt: x.lastUsedAt || 0 }; };
    if (d.action === 'list') return { tokens: (await mine()).map(view).sort((a, b) => b.createdAt - a.createdAt) };
    if (d.action === 'create') {
      const label = String(d.label || '').trim().slice(0, 60);
      if (!label) throw new HttpsError('invalid-argument', 'Name it, e.g. after the agent that will use it.');
      if ((await mine()).length >= TOKENS_PER_PERSON) throw new HttpsError('resource-exhausted', 'You have ' + TOKENS_PER_PERSON + ' tokens: revoke one first.');
      const person = await personByEmail(email);
      const token = 'bold_' + crypto.randomBytes(32).toString('base64url');
      const now = Date.now(), id = sha(token);
      const write = d.write === true;
      await db.collection('apiTokens').doc(id).set({ email, name: (person && person.name) || '', label, write, prefix: token.slice(0, 12), createdAt: now, lastUsedAt: 0, minute: 0, count: 0 });
      return { token, id, label, write, prefix: token.slice(0, 12), createdAt: now, lastUsedAt: 0 };
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
      // agents.html: your tokens and what they did; with `all`, everyone's (PIs and admins).
      const all = d.all === true;
      if (all && !(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins see everyone’s.');
      const [tokenDocs, logDocs] = await Promise.all([
        all ? db.collection('apiTokens').get().then((x) => x.docs) : mine(),
        (all ? db.collection('apiLog').orderBy('at', 'desc').limit(LOG_SHOWN) : db.collection('apiLog').where('email', '==', email)).get().then((x) => x.docs),
      ]);
      const name = await nameOf();
      const labels = {};
      tokenDocs.forEach((t) => { labels[t.data().prefix] = t.data().label; });
      return {
        all,
        tokens: tokenDocs.map((t) => Object.assign(view(t), { owner: name(t.data().email) })).sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt)),
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
    if (!m) throw httpError(401, 'Send your BOLD.OS token: Authorization: Bearer bold_…  Make one on your profile, under Linked accounts.');
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
      (m.every > 1 ? ', every ' + m.every + ' weeks' : '') + (m.until ? ', until ' + m.until : '');
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
      workspaces.filter((w) => w.completedAt > 0).map((w) => w._id));
  }
  function isHidden(ev, full){ return ev.hidden !== false && !full; }

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
  const SCOPES = ['boldiquette', 'guides', 'skills', 'events', 'projects', 'people', 'board', 'comments'];
  const TOOLS = [
    {
      name: 'search',
      description: 'Search BOLD.OS as its site search does: the BOLDiquette (the lab handbook), how-to guides, skills, events with their sessions and talks, projects, people, papers on the Internal Review Board, and comments. Every word must match; title matches rank first.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Words to look for.' },
        scope: { type: 'string', enum: SCOPES, description: 'Only this section (default: everywhere).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'At most this many results (default 25).' },
      }, required: ['query'] },
      run: search,
    },
    {
      name: 'list_projects',
      description: 'The lab’s research projects, as on the Projects page: planned, ongoing and completed, most recently updated first. Filter by group, keyword, words, or only yours.',
      inputSchema: { type: 'object', properties: {
        group: { type: 'string', enum: ['planned', 'ongoing', 'completed'] },
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
      description: 'What is on, as on the Calendar: the lab’s events between two dates (with their schedule of sessions), and the recurring project and supervision meetings.',
      inputSchema: { type: 'object', properties: {
        from: { type: 'string', description: 'YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'YYYY-MM-DD (default: 60 days after from).' },
        kind: { type: 'string', enum: ['all', 'events', 'meetings'], description: 'Default: all.' },
      } },
      run: calendar,
    },
    {
      name: 'my_items',
      description: 'Your own things on BOLD.OS: the projects you are on, your studies, recommendation letters you asked for or were asked to write, and introductions you asked for or were asked to make, with their status.',
      inputSchema: { type: 'object', properties: {} },
      run: myItems,
    },
    {
      name: 'list_introduction_offers',
      description: 'Offers of introductions (Service desk → Introductions): people in BOLD who can introduce you to someone at a company or institution. Each has an id for ask_for_introduction.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words in the organisation, area or who offers.' } } },
      run: listOffers,
    },
    // Acting (tokens made with "Can also act"): each through the page's own function.
    {
      name: 'join_project', write: true,
      description: 'Join a project, as its Join project button does: you are added to its meeting, Slack channel, slides and notes.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The project id, from list_projects.' } }, required: ['id'] },
      run: async (who, a) => { const c = await cardOf(a.id); await act(who, 'projectWorkspace', { action: 'join', id: c.id, board: c.boardId }); return { joined: true, project: c.data.title }; },
    },
    {
      name: 'leave_project', write: true,
      description: 'Leave a project you joined (its registrant and authors stay on it).',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The project id.' } }, required: ['id'] },
      run: async (who, a) => { const c = await cardOf(a.id); await act(who, 'projectWorkspace', { action: 'leave', id: c.id, board: c.boardId }); return { left: true, project: c.data.title }; },
    },
    {
      name: 'ask_for_introduction', write: true,
      description: 'Ask for an introduction on an offer (from list_introduction_offers). Whoever offered it gets a Slack message with what you wrote.',
      inputSchema: { type: 'object', properties: {
        offer_id: { type: 'string' },
        why: { type: 'string', description: 'What you would like, and why: who you would like to meet there, what about, and a line on you.' },
      }, required: ['offer_id', 'why'] },
      run: async (who, a) => act(who, 'introRequest', { action: 'create', offerId: a.offer_id, why: a.why }),
    },
    {
      name: 'answer_introduction', write: true,
      description: 'Answer a request for an introduction someone asked of you (ids in my_items): accept (“I’ll introduce you”), decline, or done once you have introduced them. They get a Slack message.',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string' }, answer: { type: 'string', enum: ['accept', 'decline', 'done'] },
        note: { type: 'string', description: 'An optional note for them (accept and decline).' },
      }, required: ['id', 'answer'] },
      run: async (who, a) => act(who, 'introRequest', { action: a.answer, id: a.id, reply: a.note || '' }),
    },
    {
      name: 'withdraw_introduction_request', write: true, destructive: true,
      description: 'Withdraw a request for an introduction you made (ids in my_items). It is deleted, and whoever offered is told.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (who, a) => act(who, 'introRequest', { action: 'withdraw', id: a.id }),
    },
    {
      name: 'ask_to_join_supervision', write: true,
      description: 'Ask a PhD or Master student to join their recurring supervision meeting. They approve or decline on their profile, and get a Slack message.',
      inputSchema: { type: 'object', properties: {
        student: { type: 'string', description: 'The student’s name.' }, note: { type: 'string', description: 'Why you would like to join (optional).' },
      }, required: ['student'] },
      run: async (who, a) => {
        const pool = (await lab.studies()).map((s) => ({ email: s._id, name: s.name || '' }));
        return act(who, 'studyRequest', { action: 'request', student: resolve(pool, a.student, 'the students with supervision meetings'), note: a.note || '' });
      },
    },
    {
      name: 'ask_for_letter', write: true,
      description: 'Ask someone in BOLD for a recommendation letter (Service desk → Recommendation letters). They get a Slack message and see the request on BOLD.OS; only the two of you can read it.',
      inputSchema: { type: 'object', properties: {
        referee: { type: 'string', description: 'Their name.' },
        purpose: { type: 'string', description: 'What the letter is for, e.g. "PhD applications, Fall 2027".' },
        cv: { type: 'string', description: 'A link to your CV (https://…).' },
        how_worked: { type: 'string', description: 'How you have worked together, and what you did yourself.' },
        statement: { type: 'string', description: 'A link to your cover letter or statement (optional).' },
        best: { type: 'string', description: 'What they could best speak to (optional).' },
        extra: { type: 'string', description: 'Anything else (optional).' },
        recipients: { type: 'array', description: 'Where the letter goes.', items: { type: 'object', properties: {
          name: { type: 'string' }, url: { type: 'string', description: 'Where to submit it (optional).' }, deadline: { type: 'string', description: 'YYYY-MM-DD (optional).' },
          sent_by: { type: 'string', enum: ['writer', 'requester'], description: 'Who submits it (default: the writer).' },
        }, required: ['name'] } },
      }, required: ['referee', 'purpose', 'cv', 'how_worked', 'recipients'] },
      run: async (who, a) => {
        const pool = (await lab.people()).map((p) => ({ email: p.email, name: p.name || '' }));
        return act(who, 'letterRequest', {
          action: 'create', writerEmail: resolve(pool, a.referee, 'people in BOLD'), purpose: a.purpose, cv: a.cv, howWorked: a.how_worked,
          statement: a.statement || '', best: a.best || '', extra: a.extra || '',
          recipients: (a.recipients || []).map((r) => ({ name: r.name, url: r.url || '', deadline: r.deadline || '', sentBy: r.sent_by === 'requester' ? 'requester' : 'writer' })),
        });
      },
    },
  ];
  const toolsFor = (who) => TOOLS.filter((t) => !t.write || who.write);

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
    if (want('guides')) jobs.push(lab.guides().then((l) => parts(l, 'guides', guideHref, 'p-', 'How to')));
    if (want('skills')) jobs.push(lab.skills().then((l) => l.forEach((x) => item('skills', x.title || x.name || x._id, 'Skill', [x.name, x.description, x.body].join(' '), 'skill.html?skill=' + encodeURIComponent(x._id)))));
    if (want('events')) jobs.push(Promise.all([lab.events(), lab.sessions(), lab.talks()]).then(([evs, ss, ts]) => {
      const talk = (x) => [x.abstract, x.speaker, x.affiliation, x.description, x.summary].filter(Boolean).join(' ');
      evs.filter((x) => !isHidden(x, full)).forEach((x) => item('events', x.title, 'Event' + (x.place ? ' · ' + x.place : ''), [x.description, x.place].join(' '), x.page || 'event.html?event=' + encodeURIComponent(x._id)));
      ss.forEach((x) => item('events', x.title, 'Session', talk(x), 'session.html?session=' + encodeURIComponent(x._id)));
      ts.forEach((x) => item('events', x.title, 'Talk' + (x.speaker ? ' · ' + x.speaker : ''), talk(x), 'talk.html?talk=' + encodeURIComponent(x._id)));
    }));
    if (want('projects')) jobs.push(allProjects().then((g) => [].concat(g.ongoing, g.planned, g.completed).forEach((p) =>
      item('projects', p.title, 'Project' + (p.owner ? ' · ' + p.owner : ''), [p.abstract, (p.keywords || []).join(' '), p.owner].join(' '), projectHref(p.projectId || p.cardId, p.boardId)))));
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
    const q = fold(a.query);
    const scored = items.map((it) => {
      const t = fold(it.title), all = t + ' ' + fold(it.where) + ' ' + fold(it.text);
      if (!ws.every((w) => all.indexOf(w) !== -1)) return null;
      const s = 1 + ws.reduce((n, w) => n + (t.indexOf(w) !== -1 ? 5 : 0) + Math.min(5, all.split(w).length - 1), 0) + (t === q ? 20 : 0);
      return { s, it };
    }).filter(Boolean).sort((x, y) => y.s - x.s);
    const snippet = (text) => {
      const low = fold(text), at = ws.map((w) => low.indexOf(w)).filter((i) => i !== -1).sort((x, y) => x - y)[0];
      if (at === undefined) return text.length > 240 ? text.slice(0, 240) + '…' : text;
      const from = Math.max(0, at - 80), to = Math.min(text.length, at + 200);
      return (from ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
    };
    return { total: scored.length, results: scored.slice(0, limit).map((h) => ({ scope: h.it.scope, title: h.it.title, where: h.it.where, snippet: snippet(h.it.text), url: h.it.url })) };
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
    ['ongoing', 'planned', 'completed'].forEach((group) => {
      if (a.group && a.group !== group) return;
      g[group].forEach((p) => {
        const id = p.pid || p.projectId || p.cardId;
        if (kw && !(p.keywords || []).some((k) => fold(k) === kw)) return;
        if (ws.length && !matches([p.title, p.abstract, (p.keywords || []).join(' '), p.owner, (p.authors || []).map((x) => x.name).join(' ')].join(' '), ws)) return;
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
    const completed = !!w.completedAt || card.status === 'conference' || card.outcome === 'accepted';
    return {
      id: pid, title: card.title || 'Untitled', url: url(projectHref(mine[mine.length - 1].id, mine[mine.length - 1].boardId)),
      group: completed ? 'completed' : card.status === 'register' || card.status === 'pitch' ? 'planned' : 'ongoing',
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
      presentations,
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
    }
    return out;
  }

  async function myItems(who){
    const e = who.email;
    const q = (col, field) => db.collection(col).where(field, '==', e).get().then((s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data())));
    const [lettersAsked, lettersToWrite, introsAsked, introsOfMe, me, name] = await Promise.all([
      q('letterRequests', 'requesterEmail'), q('letterRequests', 'writerEmail'), q('introRequests', 'requesterEmail'), q('introRequests', 'offererEmail'),
      getPerson(who, { _email: e }), nameOf(),
    ]);
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
      introductions: { you_asked: introsAsked.map((x) => intro(x, false)), asked_of_you: introsOfMe.map((x) => intro(x, true)) },
    };
  }

  // ---------- MCP (Streamable HTTP, stateless) ----------
  const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  const INSTRUCTIONS = 'BOLD.OS is the BOLD lab’s operating system: its handbook (the BOLDiquette), how-to guides, skills, events, research projects, people and calendar. ' +
    'These tools work as the person whose token this is, and see what they see on the site. Start with search for anything; use list_projects/get_project, find_people/get_person and calendar for structured answers, and my_items for the person’s own things. Every result has a url to the page on the site. ' +
    'Tools that act (join a project, ask for an introduction or a letter) send Slack messages to other people in the person’s name: confirm with the person before using them.';
  async function mcp(who, msg){
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id === undefined ? null : msg.id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
    if (msg.id === undefined) return null; // a notification
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: MCP_VERSIONS.indexOf(p.protocolVersion) !== -1 ? p.protocolVersion : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'bold-os', title: 'BOLD.OS', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        });
      case 'ping': return reply({});
      case 'tools/list':
        return reply({ tools: toolsFor(who).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !t.write, destructiveHint: !!t.destructive, idempotentHint: !t.write, openWorldHint: !!t.write } })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === p.name);
        if (!tool) return fail(-32602, 'Unknown tool: ' + p.name);
        if (tool.write && !who.write) return reply({ content: [{ type: 'text', text: 'This token can only read. To act, make a token with “Can also act” on your BOLD.OS profile.' }], isError: true });
        log(who, tool.name, p.arguments);
        try {
          const out = await tool.run(who, p.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
        } catch (err) {
          if (!err.status) logger.error('boldApi tool failed', { tool: tool.name, error: String(err.stack || err) });
          return reply({ content: [{ type: 'text', text: err.status ? err.message : 'That failed on BOLD.OS’s side — try again.' }], isError: true });
        }
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default: return fail(-32601, 'Method not found: ' + msg.method);
    }
  }

  // ---------- the HTTPS function ----------
  // The secrets are those of the callables the write tools go through.
  const boldApi = onRequest({ cors: true, memory: '512MiB', timeoutSeconds: 300, secrets }, async (req, res) => {
    const path = req.path.replace(/\/+$/, '') || '/';
    if (path === '/' && req.method === 'GET') {
      return res.json({ name: 'BOLD.OS API', mcp: '/mcp', read: TOOLS.filter((t) => !t.write).map((t) => 'GET /v1/' + t.name), act: TOOLS.filter((t) => t.write).map((t) => 'POST /v1/' + t.name), auth: 'Authorization: Bearer <token from your BOLD.OS profile, Linked accounts>' });
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
    const m = /^\/v1\/([a-z_]+)$/.exec(path);
    const tool = m && TOOLS.find((t) => t.name === m[1]);
    if (!tool) return res.status(404).json({ error: 'No such endpoint. GET / lists them.' });
    // Reads are GETs with query parameters; acting is a POST with a JSON body.
    if (req.method !== (tool.write ? 'POST' : 'GET')) return res.status(405).set('Allow', tool.write ? 'POST' : 'GET').json({ error: (tool.write ? 'POST' : 'GET') + ' /v1/' + tool.name + '.' });
    if (tool.write && !who.write) return res.status(403).json({ error: 'This token can only read. To act, make a token with “Can also act” on your BOLD.OS profile.' });
    let args = {};
    if (tool.write) args = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    else Object.keys(req.query).forEach((k) => {
      const v = String(req.query[k]), type = (tool.inputSchema.properties[k] || {}).type;
      args[k] = type === 'boolean' ? v === 'true' || v === '1' : type === 'integer' ? Number(v) : v;
    });
    log(who, tool.name, args);
    try { res.json(await tool.run(who, args)); }
    catch (err) {
      if (!err.status) logger.error('boldApi tool failed', { tool: tool.name, error: String(err.stack || err) });
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  });

  return { apiTokens, boldApi, _internal: { meetingText, TOOLS, mcp, resolve } };
};
