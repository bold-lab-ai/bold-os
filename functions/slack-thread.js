'use strict';

// Slack threads into Conversations (conversations.html, 2026-11-04), saved as a post
// (conversations/{id}) with the thread's replies under it (conversations/{id}/messages), by the
// people who wrote them. Two ways in, the same checks:
// - slackThread { url }: Import from Slack on the page → { id } (the post; one already brought in
//   keeps its id, so a thread is never in twice: sending it again refreshes it from Slack).
// - Send to Conversations, a message shortcut in Slack (callback_id send_to_conversations, on any
//   message of the thread): handleShortcut answers Slack at once by writing conversationImports/{id}
//   (server only); onConversationImport does the work and tells its sender, by the shortcut's
//   response_url, where it is.
// Only a thread its sender can read in Slack themselves: a public channel, or a private channel or
// group DM they're in; never a one-to-one DM. The bot must be in the channel (Slack's
// not_in_channel otherwise), and needs channels:history, groups:history, mpim:history and
// channels:read, groups:read, mpim:read. Who may: Conversations' Edit (bringing one in is posting).

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

// Pure: a Slack message as Markdown (markdown.js renders it, keeping single line breaks): from its
// rich text (`blocks`: lists with their nesting, numbered or not, quotes, code blocks, bold, italic,
// struck, code, links, people as tags, emoji), else from its text (Slack's mrkdwn).
function slackMarkdown(m, names){
  const blocks = (m && m.blocks || []).filter((b) => b && b.type === 'rich_text');
  if (!blocks.length) return mrkdwnToMarkdown(m && m.text, names);
  const out = [];
  const name = (id) => (names && names[id]) || 'someone';
  const inline = (els) => (els || []).map((e) => {
    if (e.type === 'text') {
      let t = String(e.text || ''), st = e.style || {};
      if (st.code) return '`' + t.replace(/`/g, "'") + '`';
      // Markdown marks can't wrap spaces at their ends: put those outside.
      const lead = t.match(/^\s*/)[0], trail = t.slice(lead.length).match(/\s*$/)[0], core = t.slice(lead.length, t.length - trail.length);
      if (!core) return t;
      let c = core;
      if (st.strike) c = '~~' + c + '~~';
      if (st.italic) c = '*' + c + '*';
      if (st.bold) c = '**' + c + '**';
      return lead + c + trail;
    }
    if (e.type === 'link') return e.text && e.text !== e.url ? '[' + e.text + '](' + e.url + ')' : String(e.url || '');
    if (e.type === 'user') return '@[' + name(e.user_id) + '](' + e.user_id + ')';
    if (e.type === 'usergroup') return '@group';
    if (e.type === 'channel') return '#channel';
    if (e.type === 'broadcast') return '@' + (e.range || 'here');
    if (e.type === 'emoji') return e.unicode ? String.fromCodePoint(...String(e.unicode).split('-').map((h) => parseInt(h, 16))) : ':' + e.name + ':';
    if (e.type === 'date') return e.fallback || '';
    return e.text || '';
  }).join('');
  // Blocks are a blank line apart, except a list straight after a list (its nested part).
  let lastList = false;
  const push = (text, isList) => {
    if (isList && lastList) out[out.length - 1] += '\n' + text; else out.push(text);
    lastList = isList;
  };
  for (const b of blocks) for (const el of (b.elements || [])) {
    if (el.type === 'rich_text_section') push(inline(el.elements).replace(/\n+$/, ''), false);
    else if (el.type === 'rich_text_list') {
      const pad = '  '.repeat(el.indent || 0), ordered = el.style === 'ordered';
      push((el.elements || []).map((it, i) => pad + (ordered ? ((el.offset || 0) + i + 1) + '. ' : '- ') + inline(it.elements).replace(/\n/g, ' ')).join('\n'), true);
    }
    else if (el.type === 'rich_text_preformatted') push('```\n' + (el.elements || []).map((e) => e.text || e.url || '').join('').replace(/\n+$/, '') + '\n```', false);
    else if (el.type === 'rich_text_quote') push(inline(el.elements).replace(/\n+$/, '').split('\n').map((l) => '> ' + l).join('\n'), false);
  }
  return out.filter((x) => x.trim()).join('\n\n');
}
// Pure: Slack's mrkdwn → Markdown, for a message without rich text (from an app, say).
function mrkdwnToMarkdown(text, names){
  return String(text || '')
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (x, id) => '@[' + ((names && names[id]) || 'someone') + '](' + id + ')')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1*$2*')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1~~$2~~')
    .replace(/^(\s*)[•◦▪]\s+/gm, '$1- ')
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
    post: { who: who(first), text: slackMarkdown(first, names), title: slackPlain(first.text, names), at: at(first) },
    replies: rest.map((m) => ({ who: who(m), text: slackMarkdown(m, names), at: at(m) })).filter((r) => r.text.trim()),
  };
}

// Pure: a Slack thread's post id, the same whichever way it came in.
const postIdOf = (channel, thread) => 'slack-' + channel + '-' + String(thread).replace('.', '');

module.exports = function({ db, onCall, onDocumentCreated, HttpsError, logger, SLACK_BOT_TOKEN, signedInEmail, access, slackIdForEmail, FieldValue, SITE_URL, postInChannel, slackText }){
  const PAGE = SITE_URL + 'conversations.html';
  // A thread newly in Conversations says so in the thread, for everyone in it (pilot conversation-sent;
  // until it's live its testers get it instead). Not when one is refreshed. Never fails the send.
  async function announce(token, link, channelName, r, who){
    if (r.existed || !postInChannel) return;
    const url = PAGE + '#post=' + encodeURIComponent(r.id);
    await postInChannel(token, 'conversation-sent', link.channel, channelName || link.channel, {
      thread_ts: link.thread, unfurl_links: false,
      text: '📌 ' + slackText(who || 'Someone') + ' sent this thread to Conversations: <' + url + '|' + String(r.title).replace(/[<>|]/g, '') + '>. Vote and reply there.',
    }).catch((e) => logger.warn('Announcing a thread in Conversations failed', { error: String(e && e.message || e) }));
  }
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

  // The thread `link` points to, if `slackId` (its sender) can read it → { t, ch }.
  async function readThread(token, link, slackId){
    const info = await api(token, 'conversations.info', { channel: link.channel });
    if (!info.ok) refuse(info, 'channels');
    const ch = info.channel || {};
    if (ch.is_im) throw new HttpsError('permission-denied', 'Direct messages can’t be brought in.');
    let member = false;
    if (ch.is_private || ch.is_mpim || ch.is_group) {
      let cursor = '';
      do {
        const r = await api(token, 'conversations.members', Object.assign({ channel: link.channel, limit: '1000' }, cursor ? { cursor } : {}));
        if (!r.ok) refuse(r, 'who is in a channel');
        if (slackId && (r.members || []).indexOf(slackId) >= 0) { member = true; break; }
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
    const names = {}, idList = Array.from(ids);
    for (let i = 0; i < idList.length; i += 30) {
      (await db.collection('people').where('slackId', 'in', idList.slice(i, i + 30)).get()).docs.forEach((d) => { names[d.data().slackId] = d.data().name; });
    }
    const t = threadOf(messages, names);
    if (!t) throw new HttpsError('not-found', 'That thread is empty.');
    return { t, ch, messages };
  }

  // Saves the thread as a post → { id, title, existed }. Sent again, it's refreshed: its text and its Slack
  // replies as they are now (new ones added), its votes and the replies written on BOLD.OS kept.
  async function saveThread(token, link, team, sender){
    const id = postIdOf(link.channel, link.thread), ref = db.collection('conversations').doc(id);
    const had = await ref.get();
    const { t, ch } = await readThread(token, link, sender.slackId);
    const first = (t.post.title.split('\n').map((l) => l.replace(/^[\s•◦▪-]+/, '').trim()).filter(Boolean)[0] || 'From Slack');
    const title = first.length > 120 ? first.slice(0, 117).replace(/\s+\S*$/, '') + '…' : first;
    const slack = { channel: link.channel, channelName: ch.name ? '#' + ch.name : '', thread: link.thread,
      permalink: (team || 'https://slack.com') + '/archives/' + link.channel + '/p' + link.thread.replace('.', '') };
    const batch = db.batch();
    const reply = (r) => ({ parent: id, body: r.text, name: r.who, createdBy: '', at: r.at, source: 'slack' });
    if (had.exists) {
      const old = had.data(), mine = (await ref.collection('messages').where('source', '==', 'slack').get()).size;
      batch.set(ref, { title, body: t.post.text, slack, slackReplies: t.replies.length,
        replies: Math.max(0, (old.replies || 0) - (old.slackReplies != null ? old.slackReplies : mine)) + t.replies.length, refreshedAt: FieldValue.serverTimestamp() }, { merge: true });
      // Each Slack reply keeps its id (its place in the thread), so its votes stay.
      t.replies.forEach((r, i) => batch.set(ref.collection('messages').doc('slack-' + i), reply(r), { merge: true }));
      await batch.commit();
      return { id, title, existed: true };
    }
    batch.create(ref, { title, body: t.post.text, name: t.post.who, createdBy: '', at: t.post.at, source: 'slack', slack, votes: {}, replies: t.replies.length, slackReplies: t.replies.length,
      broughtBy: { email: sender.email, name: sender.name || '' }, broughtAt: FieldValue.serverTimestamp() });
    t.replies.forEach((r, i) => batch.set(ref.collection('messages').doc('slack-' + i), Object.assign(reply(r), { votes: {} })));
    try { await batch.commit(); }
    catch (e) { const again = await ref.get(); if (again.exists) return { id, title: again.data().title, existed: true }; throw e; }
    return { id, title, existed: false, channelName: ch.name || '' };
  }
  async function personFor(email){
    const s = await db.collection('people').where('email', '==', email).limit(1).get();
    return s.empty ? {} : s.docs[0].data();
  }

  const slackThread = onCall({ secrets: [SLACK_BOT_TOKEN] }, async (request) => {
    const email = signedInEmail(request).toLowerCase();
    await access.requireAccess(email, 'conversations', 'edit');
    const link = parseSlackLink((request.data || {}).url);
    if (!link) throw new HttpsError('invalid-argument', 'That isn’t a link to a Slack message: in Slack, a message’s ⋯ menu → Copy link.');
    const p = await personFor(email);
    const token = SLACK_BOT_TOKEN.value(), r = await saveThread(token, link, new URL(String(request.data.url)).origin, { email, name: p.name || '', slackId: p.slackId || await slackIdForEmail(email) });
    await announce(token, link, r.channelName, r, p.name);
    return r;
  });

  // Send to Conversations (Slack's message_action payload): written down at once, done by onConversationImport.
  async function handleShortcut(payload){
    const msg = payload.message || {}, channel = (payload.channel || {}).id || '';
    await db.collection('conversationImports').add({
      slackId: (payload.user || {}).id || '', channel, thread: msg.thread_ts || msg.ts || '', team: payload.team && payload.team.domain ? 'https://' + payload.team.domain + '.slack.com' : '',
      responseUrl: payload.response_url || '', at: Date.now(),
    });
  }
  async function tell(url, text){
    if (!url) return;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }) })
      .catch((e) => logger.warn('Answering a shortcut failed', { error: String(e) }));
  }
  const onConversationImport = onDocumentCreated({ document: 'conversationImports/{id}', secrets: [SLACK_BOT_TOKEN] }, async (event) => {
    const d = event.data && event.data.data();
    if (!d || d.doneAt) return;
    let out;
    try {
      const p = (await db.collection('people').where('slackId', '==', d.slackId).limit(1).get()).docs[0];
      const email = p ? String(p.data().email || '').toLowerCase() : '';
      if (!email) throw new HttpsError('permission-denied', 'BOLD.OS doesn’t know you yet: sign in to BOLD.OS once with Slack.');
      if (!(await access.can(email, 'conversations', 'edit'))) throw new HttpsError('permission-denied', 'You can’t post in Conversations yet (BOLDiquette › Who can see what).');
      if (!/^\d{10}\.\d{6}$/.test(d.thread) || !d.channel) throw new HttpsError('invalid-argument', 'That message can’t be sent.');
      const token = SLACK_BOT_TOKEN.value(), link = { channel: d.channel, ts: d.thread, thread: d.thread };
      const r = await saveThread(token, link, d.team, { email, name: p.data().name || '', slackId: d.slackId });
      await announce(token, link, r.channelName, r, p.data().name);
      const url = PAGE + '#post=' + encodeURIComponent(r.id);
      out = { id: r.id, text: (r.existed ? 'Updated in Conversations: ' : 'Sent to Conversations: ') + '<' + url + '|' + String(r.title).replace(/[<>|]/g, '') + '>' };
    } catch (e) {
      out = { error: String(e && e.message || e), text: 'Not sent to Conversations: ' + String(e && e.message || e) };
    }
    await tell(d.responseUrl, out.text);
    await event.data.ref.set({ doneAt: Date.now(), postId: out.id || '', error: out.error || '' }, { merge: true });
  });

  // A reply's post keeps count of its replies (clients can't change it: firestore.rules).
  const onConversationMessage = onDocumentCreated('conversations/{pid}/messages/{mid}', async (event) => {
    const d = event.data && event.data.data();
    if (!d || d.source === 'slack') return;   // a thread brought in is counted as it's saved
    await db.collection('conversations').doc(event.params.pid).set({ replies: FieldValue.increment(1) }, { merge: true }).catch(() => {});
  });

  return { slackThread, handleShortcut, onConversationImport, onConversationMessage };
};
module.exports.parseSlackLink = parseSlackLink;
module.exports.slackPlain = slackPlain;
module.exports.mayRead = mayRead;
module.exports.threadOf = threadOf;
module.exports.slackMarkdown = slackMarkdown;
module.exports.mrkdwnToMarkdown = mrkdwnToMarkdown;
module.exports.postIdOf = postIdOf;
