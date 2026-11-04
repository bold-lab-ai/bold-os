'use strict';

// A Slack thread, for Conversations (experiment-conversations.html, 2026-11-04): slackThread
// { url } → { channel, post: { who, text, at, permalink }, replies: [{ who, text, at }] }, the
// thread a link points to (its first message, or any reply in it), read with BOLD.OS's bot.
// Only what the caller can read in Slack themselves: a public channel, or a private channel or
// group DM they're in; never a one-to-one DM. The bot must be in the channel (Slack's not_in_channel
// otherwise), and needs channels:history, groups:history, mpim:history and channels:read,
// groups:read, mpim:read. Nothing is kept: the page holds what it gets. Who may: Experimental's View.

// Pure: a Slack message link → { channel, ts, thread } (thread: its thread's ts when the link is
// to a reply), or null. https://<team>.slack.com/archives/<C…>/p<16 digits>[?thread_ts=…&cid=…]
function parseSlackLink(url){
  let u;
  try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{16})\/?$/);
  if (!m) return null;
  const ts = m[2].slice(0, 10) + '.' + m[2].slice(10);
  const thread = u.searchParams.get('thread_ts');
  return { channel: m[1], ts, thread: /^\d{10}\.\d{6}$/.test(thread || '') ? thread : ts };
}

// Pure: Slack's mrkdwn → plain text: <@U…> → @Name, <url|text> → text, <url> → url, <#C…|name> → #name,
// <!here> → @here, and its &amp; &lt; &gt; back.
function slackPlain(text, names){
  return String(text || '')
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (x, id) => '@' + ((names && names[id]) || 'someone'))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Pure: may this person read the channel? info: conversations.info's channel; isMember: whether they're in it.
function mayRead(info, isMember){
  if (!info || info.is_im) return false;
  if (info.is_private || info.is_mpim || info.is_group) return !!isMember;
  return true;   // a public channel: anyone in the BOLD Slack
}

// Pure: conversations.replies' messages → the thread, the first being its post. names: { slackId: name }.
function threadOf(messages, names){
  const who = (m) => (names && names[m.user]) || (m.user_profile && (m.user_profile.real_name || m.user_profile.name)) || m.username || 'someone';
  const at = (m) => Math.round(parseFloat(m.ts) * 1000);
  const keep = (messages || []).filter((m) => m && m.ts && (!m.subtype || m.subtype === 'thread_broadcast'));
  if (!keep.length) return null;
  const [first, ...rest] = keep;
  return {
    post: { who: who(first), text: slackPlain(first.text, names), at: at(first) },
    replies: rest.map((m) => ({ who: who(m), text: slackPlain(m.text, names), at: at(m) })).filter((r) => r.text.trim()),
  };
}

module.exports = function({ db, onCall, HttpsError, logger, SLACK_BOT_TOKEN, signedInEmail, access, slackIdForEmail }){
  async function api(token, method, params){
    const res = await fetch('https://slack.com/api/' + method + '?' + new URLSearchParams(params), { headers: { 'Authorization': 'Bearer ' + token } });
    const json = await res.json();
    if (!json.ok) logger.warn('Slack API call failed', { method, error: json.error, needed: json.needed });
    return json;
  }
  const refuse = (json, what) => {
    const e = json && json.error;
    if (e === 'not_in_channel' || e === 'channel_not_found') throw new HttpsError('failed-precondition', 'BOLD.OS’s Slack app isn’t in that channel: add it there (/invite @BOLD OS), then try again.');
    if (e === 'missing_scope') throw new HttpsError('failed-precondition', 'BOLD.OS’s Slack app can’t read ' + what + ' yet (it needs ' + (json.needed || 'more permissions') + '): ask an admin.');
    if (e === 'thread_not_found' || e === 'message_not_found') throw new HttpsError('not-found', 'No such thread.');
    throw new HttpsError('unavailable', 'Slack said no (' + (e || 'no answer') + ').');
  };

  const slackThread = onCall({ secrets: [SLACK_BOT_TOKEN] }, async (request) => {
    const email = signedInEmail(request).toLowerCase();
    await access.requireAccess(email, 'experimental', 'view');
    const link = parseSlackLink((request.data || {}).url);
    if (!link) throw new HttpsError('invalid-argument', 'That isn’t a link to a Slack message: in Slack, a message’s ⋯ menu → Copy link.');
    const token = SLACK_BOT_TOKEN.value();
    const info = await api(token, 'conversations.info', { channel: link.channel });
    if (!info.ok) refuse(info, 'channels');
    const ch = info.channel || {};
    if (ch.is_im) throw new HttpsError('permission-denied', 'Direct messages can’t be brought in.');
    let member = false;
    if (ch.is_private || ch.is_mpim || ch.is_group) {
      const me = await slackIdForEmail(email);
      let cursor = '';
      do {
        const r = await api(token, 'conversations.members', Object.assign({ channel: link.channel, limit: '1000' }, cursor ? { cursor } : {}));
        if (!r.ok) refuse(r, 'who is in a channel');
        if (me && (r.members || []).indexOf(me) >= 0) { member = true; break; }
        cursor = (r.response_metadata && r.response_metadata.next_cursor) || '';
      } while (cursor);
    }
    if (!mayRead(ch, member)) throw new HttpsError('permission-denied', 'Only a thread you can read in Slack: you aren’t in that channel.');
    const messages = [];
    let cursor = '';
    do {
      const r = await api(token, 'conversations.replies', Object.assign({ channel: link.channel, ts: link.thread, limit: '200' }, cursor ? { cursor } : {}));
      if (!r.ok) refuse(r, 'messages');
      messages.push(...(r.messages || []));
      cursor = (r.response_metadata && r.response_metadata.next_cursor) || '';
    } while (cursor && messages.length < 1000);
    // Names from the roster (people, synced from Slack), for the authors and the @mentions.
    const ids = new Set();
    messages.forEach((m) => { if (m.user) ids.add(m.user); String(m.text || '').replace(/<@([A-Z0-9]+)/g, (x, id) => ids.add(id)); });
    const names = {};
    const idList = Array.from(ids);
    for (let i = 0; i < idList.length; i += 30) {
      (await db.collection('people').where('slackId', 'in', idList.slice(i, i + 30)).get()).docs.forEach((d) => { names[d.data().slackId] = d.data().name; });
    }
    const t = threadOf(messages, names);
    if (!t) throw new HttpsError('not-found', 'That thread is empty.');
    const team = new URL(String(request.data.url)).origin;
    t.post.permalink = team + '/archives/' + link.channel + '/p' + link.thread.replace('.', '');
    t.channel = ch.name ? '#' + ch.name : '';
    return t;
  });
  return { slackThread, parseSlackLink, slackPlain, mayRead, threadOf };
};
module.exports.parseSlackLink = parseSlackLink;
module.exports.slackPlain = slackPlain;
module.exports.mayRead = mayRead;
module.exports.threadOf = threadOf;
