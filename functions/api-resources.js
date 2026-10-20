// ---------- BOLD.OS for agents: prompts and resources (functions/api.js) ----------
// Prompts: each of the lab's skills (skills/{name}), so an agent's user picks one by
// name (in Claude Code, /bold-os:<skill>): its SKILL.md and files, then what they ask.
// Resources: every document on the site, at a bold:// address. They change all the
// time, so nothing is kept: resources/list is built from what's there at each call
// (as its owner sees it), resources/read reads it fresh, and the templates let an agent
// open any one by its id without listing. The server is stateless, so it doesn't
// notify of changes (listChanged and subscribe are false): an agent lists again.
module.exports = function(ctx){
  const { lab, url, httpError, isFullWrite, skillMd, tools } = ctx;
  const PAGE = 200;

  // ---------- prompts: the skills ----------
  async function listPrompts(){
    return { prompts: (await lab.skills()).sort((a, b) => a._id.localeCompare(b._id)).map((s) => ({
      name: s._id, title: s.title || s._id, description: s.description || '',
      arguments: [{ name: 'request', description: 'What you would like done with it (optional).', required: false }],
    })) };
  }
  async function getPrompt(who, p){
    const s = (await lab.skills()).find((x) => x._id === p.name);
    if (!s) throw httpError(404, 'No skill called ' + p.name + '.');
    const files = (s.files || []).filter((f) => f && f.path);
    const request = String((p.arguments || {}).request || '').trim();
    const text = 'Use the BOLD skill “' + (s.title || s._id) + '”, below: its SKILL.md' + (files.length ? ' and its files' : '') + '.\n\n' +
      skillMd(Object.assign({ name: s._id }, s)) +
      files.map((f) => '\n\n--- ' + f.path + ' ---\n' + String(f.content || '')).join('') +
      (request ? '\n\n---\n\nWhat I’d like: ' + request : '');
    return { description: s.description || '', messages: [{ role: 'user', content: { type: 'text', text } }] };
  }

  // ---------- resources: every document ----------
  const md = (uri, text) => ({ contents: [{ uri, mimeType: 'text/markdown', text }] });
  const json = (uri, data) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 1) }] });
  // The BOLDiquette or a guide, as Markdown: its parts under their sections.
  function pageMd(d){
    let out = '# ' + (d.title || '') + '\n' + (d.description ? '\n' + d.description + '\n' : ''), section = null;
    (d.parts || []).forEach((p) => {
      if ((p.section || '') !== section) { section = p.section || ''; if (section) out += '\n## ' + section + '\n'; }
      out += '\n### ' + p.title + ' {#' + p.id + '}\n\n' + p.body + '\n';
    });
    return out;
  }
  function eventMd(e, sessions, talks){
    const title = {}, bySession = {};
    sessions.forEach((s) => { title[s._id] = s; });
    talks.forEach((t) => { (bySession[t.sessionSlug] = bySession[t.sessionSlug] || []).push(t); });
    let out = '# ' + e.title + '\n\n' + e.startDate + (e.endDate && e.endDate !== e.startDate ? ' – ' + e.endDate : '') + (e.place ? ' · ' + e.place : '') + '\n' +
      (e.description ? '\n' + e.description + '\n' : '') + '\nPage: ' + url(e.page || 'event.html?event=' + encodeURIComponent(e._id)) + '\n';
    (e.days || []).forEach((d) => {
      out += '\n## ' + (d.date || 'Day') + '\n';
      (d.slots || []).forEach((sl) => {
        const names = (sl.sessions || []).map((id) => title[id]).filter((s) => s && !s.removed);
        out += '\n- ' + [sl.start && (sl.start + (sl.end ? '–' + sl.end : '')), sl.title].filter(Boolean).join(' ');
        names.forEach((s) => {
          out += '\n  - **' + s.title + '**' + (s.subtitle ? ': ' + s.subtitle : '');
          (bySession[s._id] || []).forEach((t) => { out += '\n    - ' + t.title + (t.speaker ? ' (' + t.speaker + ')' : ''); });
        });
      });
    });
    return out;
  }

  // Each kind: its address, how it's listed, and how it's read.
  const KINDS = [
    { template: 'bold://boldiquette', name: 'boldiquette', title: 'The BOLDiquette', description: 'The lab’s handbook: norms, processes and policies.',
      list: async () => [{ uri: 'bold://boldiquette', name: 'boldiquette', title: 'The BOLDiquette', mimeType: 'text/markdown' }],
      read: async () => { const d = (await lab.handbook()).find((x) => x._id === 'boldiquette'); if (!d) throw httpError(404, 'Not there.'); return pageMd(d); } },
    { template: 'bold://guide/{slug}', name: 'guide', title: 'A how-to guide', description: 'One of the How to guides.',
      list: async () => (await lab.guides()).map((g) => ({ uri: 'bold://guide/' + g._id, name: 'guide-' + g._id, title: g.title || g._id, description: g.description || '', mimeType: 'text/markdown' })),
      read: async (id) => { const d = (await lab.guides()).find((x) => x._id === id); if (!d) throw httpError(404, 'No guide ' + id + '.'); return pageMd(d); } },
    { template: 'bold://skill/{name}', name: 'skill', title: 'A skill’s SKILL.md', description: 'One of the lab’s Claude skills (its files: bold://skill/{name}/{path}).',
      list: async () => (await lab.skills()).map((s) => ({ uri: 'bold://skill/' + s._id, name: 'skill-' + s._id, title: s.title || s._id, description: s.description || '', mimeType: 'text/markdown' })),
      read: async (id) => {
        const [name, ...rest] = id.split('/'), s = (await lab.skills()).find((x) => x._id === name);
        if (!s) throw httpError(404, 'No skill ' + name + '.');
        if (!rest.length) return skillMd(Object.assign({ name }, s));
        const f = (s.files || []).find((x) => x.path === rest.join('/'));
        if (!f) throw httpError(404, 'No file ' + rest.join('/') + ' in ' + name + '.');
        return String(f.content || '');
      } },
    { template: 'bold://event/{slug}', name: 'event', title: 'An event', description: 'One of the lab’s events, with its programme.',
      list: async (who) => { const full = await isFullWrite(who.email); return (await lab.events()).filter((e) => e.hidden === false || full).map((e) => ({ uri: 'bold://event/' + e._id, name: 'event-' + e._id, title: e.title, description: [e.startDate, e.place].filter(Boolean).join(' · '), mimeType: 'text/markdown' })); },
      read: async (id, who) => {
        const e = (await lab.events()).find((x) => x._id === id);
        if (!e || (e.hidden !== false && !(await isFullWrite(who.email)))) throw httpError(404, 'No event ' + id + '.');
        const [ss, ts] = await Promise.all([lab.sessions(), lab.talks()]);
        return eventMd(e, ss.filter((s) => (s.eventSlug || 'collaboration-week') === e._id), ts);
      } },
    { template: 'bold://project/{id}', name: 'project', title: 'A project', description: 'One project in full, as get_project.', json: true,
      list: async (who) => (await tools.listProjects(who, {})).projects.map((p) => ({ uri: 'bold://project/' + p.id, name: 'project-' + p.id, title: p.title, description: p.group + (p.venue ? ' · ' + p.venue : ''), mimeType: 'application/json' })),
      read: async (id, who) => tools.getProject(who, { id }) },
    { template: 'bold://person/{slack_id}', name: 'person', title: 'A person', description: 'Someone in BOLD, as get_person.', json: true,
      list: async () => {
        const people = await lab.people(), members = await lab.members(), by = {};
        people.forEach((p) => { if (p.email) by[String(p.email).toLowerCase()] = p.slackId || p._id; });
        return members.filter((m) => by[String(m.email || m._id).toLowerCase()]).map((m) => ({ uri: 'bold://person/' + by[String(m.email || m._id).toLowerCase()], name: 'person-' + by[String(m.email || m._id).toLowerCase()], title: m.name || '', description: [m.role, m.institution].filter(Boolean).join(' · '), mimeType: 'application/json' }));
      },
      read: async (id, who) => tools.getPerson(who, { slack_id: id }) },
    { template: 'bold://calendar', name: 'calendar', title: 'The calendar', description: 'Events in the next 60 days, and the recurring project and supervision meetings.', json: true,
      list: async () => [{ uri: 'bold://calendar', name: 'calendar', title: 'The calendar', mimeType: 'application/json' }],
      read: async (id, who) => tools.calendar(who, {}) },
    { template: 'bold://me', name: 'me', title: 'Your things', description: 'Your projects, studies, letters, introductions and requests, as my_items.', json: true,
      list: async () => [{ uri: 'bold://me', name: 'me', title: 'Your things on BOLD.OS', mimeType: 'application/json' }],
      read: async (id, who) => tools.myItems(who, {}) },
  ];

  async function listResources(who, p){
    const all = [].concat(...(await Promise.all(KINDS.map((k) => k.list(who)))));
    const from = Math.max(0, parseInt((p && p.cursor) || '0', 10) || 0);
    const out = { resources: all.slice(from, from + PAGE) };
    if (from + PAGE < all.length) out.nextCursor = String(from + PAGE);
    return out;
  }
  function listTemplates(){
    return { resourceTemplates: KINDS.filter((k) => k.template.indexOf('{') !== -1).map((k) => ({ uriTemplate: k.template, name: k.name, title: k.title, description: k.description, mimeType: k.json ? 'application/json' : 'text/markdown' })) };
  }
  async function readResource(who, p){
    const uri = String((p && p.uri) || '');
    const m = /^bold:\/\/([a-z]+)(?:\/(.+))?$/.exec(uri);
    const k = m && KINDS.find((x) => x.template === 'bold://' + m[1] || x.template.indexOf('bold://' + m[1] + '/') === 0);
    if (!k || (k.template.indexOf('{') !== -1) !== !!m[2]) throw httpError(404, 'No resource at ' + uri + '.');
    const id = m[2] ? decodeURIComponent(m[2]) : '';
    const data = await k.read(id, who);
    return k.json ? json(uri, data) : md(uri, data);
  }

  return { listPrompts, getPrompt, listResources, listTemplates, readResource };
};
