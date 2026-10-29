'use strict';

// Slack, pretended, in the emulator (AGENTS.md "Developing a Slack feature"). When the
// functions run in the Firebase emulator (FUNCTIONS_EMULATOR, or SLACK_OUTBOX=on in a
// test), nothing reaches Slack: every call to slack.com/api is written to the emulator's
// `slackOutbox` collection ({ method, args, at }) and answered as Slack would, enough for
// the code to carry on:
// - channels: every name the data uses (projects' channels, the groups' and boards'
//   settings) exists, with the id C-<name>;
// - people: whoever is in `people` has their slackId (else U-<email>), and a DM opens D-<id>;
// - everything else: { ok: true } with a timestamp.
// A feature's agent reads `slackOutbox` to check what would have been sent, and to whom.
module.exports = function install(db){
  const on = process.env.FUNCTIONS_EMULATOR === 'true' || process.env.SLACK_OUTBOX === 'on';
  if (!on || global.__slackOutbox) return false;
  global.__slackOutbox = true;
  const realFetch = global.fetch;
  const ok = (x) => ({ ok: true, status: 200, json: async () => Object.assign({ ok: true }, x), text: async () => JSON.stringify(Object.assign({ ok: true }, x)) });

  async function channelNames(){
    const names = new Set(['general', 'all-active-projects']);
    const add = (v) => String(v || '').split(/[\s,]+/).map((n) => n.replace(/^#/, '').toLowerCase()).filter(Boolean).forEach((n) => names.add(n));
    (await db.collection('projectWorkspaces').get()).docs.forEach((d) => { const w = d.data(); add(w.slackChannel); ((w.work || {}).channels || []).forEach(add); });
    const g = (await db.collection('settings').doc('groups').get()).data() || {};
    Object.values(g.channels || {}).forEach(add); Object.values(g.roleChannels || {}).forEach(add);
    return Array.from(names);
  }
  async function personBy(field, value){
    const s = await db.collection('people').where(field, '==', value).limit(1).get();
    return s.empty ? null : s.docs[0].data();
  }

  global.fetch = async function(url, opts){
    const u = String(url && url.url || url);
    if (!u.startsWith('https://slack.com/api/')) return realFetch(url, opts);
    const parsed = new URL(u), method = parsed.pathname.replace('/api/', '');
    let args = Object.fromEntries(parsed.searchParams);
    if (opts && opts.body) {
      try { args = Object.assign(args, JSON.parse(opts.body)); }
      catch (e) { try { args = Object.assign(args, Object.fromEntries(new URLSearchParams(String(opts.body)))); } catch (x) {} }
    }
    await db.collection('slackOutbox').add({ method, args, at: Date.now() });
    switch (method) {
      case 'conversations.list':
        return ok({ channels: (await channelNames()).map((n) => ({ id: 'C-' + n, name: n })), response_metadata: { next_cursor: '' } });
      case 'conversations.open': {
        const users = String(args.users || '');
        return ok({ channel: { id: 'D-' + users } });
      }
      case 'users.lookupByEmail': {
        const p = await personBy('email', String(args.email || '').toLowerCase());
        return ok({ user: { id: (p && p.slackId) || 'U-' + args.email, profile: { email: args.email } } });
      }
      case 'users.info': case 'users.profile.get': {
        const p = await personBy('slackId', String(args.user || ''));
        return ok({ user: { id: args.user, name: (p && p.name) || 'someone', profile: { email: p && p.email, real_name: p && p.name } }, profile: { email: p && p.email, real_name: p && p.name } });
      }
      case 'users.list': {
        const people = (await db.collection('people').get()).docs.map((d) => d.data());
        return ok({ members: people.map((p) => ({ id: p.slackId || 'U-' + p.email, real_name: p.name, profile: { email: p.email, real_name: p.name } })), response_metadata: { next_cursor: '' } });
      }
      case 'auth.test':
        return ok({ user: 'BOLD OS', user_id: 'U-bold-os', team_id: 'T-bold', url: 'https://bold-lab.slack.com/' });
      case 'chat.getPermalink':
        return ok({ permalink: 'https://bold-lab.slack.com/archives/' + (args.channel || 'C') + '/p0' });
      default:
        return ok({ ts: String(Date.now() / 1000), channel: args.channel || '' });
    }
  };
  return true;
};
