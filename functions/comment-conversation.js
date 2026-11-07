'use strict';

// A comment thread turned into a conversation (2026-11-06): Make it a conversation on a thread of
// comments on the BOLDiquette or a guide (comments.js). The thread is copied into Conversations as a
// post (conversations/{id}, source 'comment') with its replies under it, each by whoever wrote it, as a
// Slack thread is brought in (slack-thread.js). The post's `from` says where it came from, and links back
// to the passage; the thread's first comment gets `conversation: <post id>`, so the page shows where it
// went on, and takes no more replies there (firestore.rules). One thread is one post: asking again
// gives the same post.
// commentConversation { on: 'handbook/<slug>' | 'guides/<slug>', id: <the thread's first comment> } → { id, title, existed }.
// A board card's conversation (talk.js; since 2026-11-07 its only chat): { on: 'card/<project>/<card>', text? } → the post
// cm-card-<project>-<card>, with `project` (its project's Conversations). Started by its first message (`text`), with
// any comments it had from before copied in first; asked again with `text`, that's added to it (agents' work tool).
// A card has no field for it: the post existing is what closes the card's old comments (firestore.rules).
// Who may: whoever may post in Conversations and see the page (the project). Only where everyone who sees
// Conversations can see the page too, so nothing goes further than it was.

const MAX_TITLE = 120;

// Pure: a post's title from the first comment (its first line, shortened), else the passage.
function titleOf(text, quote){
  const line = String(text || '').split('\n').map((l) => l.replace(/^[\s>#*•-]+/, '').trim()).filter(Boolean)[0] || ('On “' + String(quote || '').trim() + '”');
  return line.length > MAX_TITLE ? line.slice(0, MAX_TITLE - 3).replace(/\s+\S*$/, '') + '…' : line;
}
// Pure: the post's text: the passage it was on, quoted, then the first comment.
function bodyOf(quote, text){
  const t = String(quote || '').trim(), q = t ? t.split('\n').map((l) => '> ' + l).join('\n') : '';
  return (q ? q + '\n\n' : '') + String(text || '');
}
// A proposed change's conversation (talk.js, pages/guide.js; 2026-11-07): { on: 'change/<collection>/<slug>/<proposal>', text? }
// → conversations/cm-change-<collection>-<slug>-<proposal>: its proposer's post (their note on it), its old discussion
// (comments with its proposalId) copied in after, then `text`; again with `text`, that's added. Each decision
// (accepted, declined, withdrawn) is written into it (index.js onProposalDecided).
// Pure: a proposed change's → { collection, slug, proposal, id: the post's }, or null.
function changeOf(on){
  const m = /^change\/(handbook|guides)\/([a-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,64})$/.exec(String(on || ''));
  if (!m || (m[1] === 'handbook' && m[2] !== 'boldiquette')) return null;
  return { collection: m[1], slug: m[2], proposal: m[3], id: 'cm-change-' + m[1] + '-' + m[2] + '-' + m[3] };
}
// An Internal Review card's Discussion (audit-board/detail.js; 2026-11-07): { on: 'review/<board>/<card>', text? } →
// conversations/cm-review-<board>-<card>, about its project if it has one: its old Discussion (the card's
// `discussion`, each message then its replies) copied in, then `text`. Its author and both reviewers count as in it.
// Pure: an Internal Review card's → { board, card, id }, or null.
function reviewOf(on){
  const m = /^review\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})$/.exec(String(on || ''));
  return m ? { board: m[1], card: m[2], id: 'cm-review-' + m[1] + '-' + m[2] } : null;
}
// Pure: a card's `discussion` → its messages in order, each topic then its replies → [{ text, by, at }].
function discussionOf(list){
  const one = (m) => ({ text: String(m.body || ''), by: { email: String(m.authorEmail || '').toLowerCase(), name: String(m.author || '') }, at: Number(m.timestamp || m.at) || 0 });
  return [].concat.apply([], (list || []).map((m) => [one(m)].concat((m.replies || []).map(one)))).filter((x) => x.text);
}
// Pure: a card's description as its first message: its notes, then its images (as talk.js descriptionOf).
function descriptionOf(c){
  const imgs = (c.images || []).filter((i) => i && /^https:\/\//.test(String(i.url || '')));
  return [String(c.notes || '').trim()].concat(imgs.map((i) => '![' + String(i.name || 'An image').replace(/[[\]]/g, '') + '](' + i.url + ')')).filter(Boolean).join('\n\n');
}
// Pure: a card's comments → { pid, card, id: the post's }, or null. on: 'card/<project>/<card>'.
function cardOf(on){
  const m = /^card\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})$/.exec(String(on || ''));
  return m ? { pid: m[1], card: m[2], id: 'cm-card-' + m[1] + '-' + m[2] } : null;
}
// Pure: the page a thread is on, and its area in Who can see what. on: 'handbook/<slug>' | 'guides/<slug>'.
function pageOf(on, guideArea){
  const m = /^(handbook|guides)\/([a-z0-9_-]{1,80})$/.exec(String(on || ''));
  if (!m) return null;
  const [, collection, slug] = m;
  if (collection === 'handbook' && slug !== 'boldiquette') return null;
  return { collection, slug, area: collection === 'handbook' ? 'boldiquette' : guideArea(slug),
    href: collection === 'handbook' ? 'boldiquette.html' : 'guide.html?guide=' + encodeURIComponent(slug) };
}

module.exports = function({ db, onCall, HttpsError, signedInEmail, access, FieldValue, SITE_URL, rank, guideArea, projectPageUrl }){
  const nameOf = async (email) => { const p = (await db.collection('people').where('email', '==', email).limit(1).get()).docs[0]; return String((p && p.data().name) || ''); };
  const by = (c) => ({ name: String((c.by && c.by.name) || (c.by && c.by.email) || 'Someone').slice(0, 200), createdBy: String((c.by && c.by.email) || '').toLowerCase() });

  // A board card's comments, all of them, as one conversation.
  async function fromCard(email, c, text){
    text = String(text || '').trim().slice(0, 10000);
    await access.requireAccess(email, 'conversations', 'edit');
    const wsRef = db.collection('projectWorkspaces').doc(c.pid), cardRef = wsRef.collection('work').doc(c.card);
    const [wsSnap, cardSnap] = await Promise.all([wsRef.get(), cardRef.get()]);
    if (!wsSnap.exists || !cardSnap.exists) throw new HttpsError('not-found', 'That card isn’t there any more.');
    const ws = wsSnap.data(), card = cardSnap.data();
    // Whoever sees the project (its people, or Projects' View), as for its comments (firestore.rules seesProject).
    const member = (ws.members || []).map((e) => String(e).toLowerCase()).indexOf(email) >= 0;
    if (!member && !(await access.can(email, 'projects', 'view'))) throw new HttpsError('permission-denied', 'You can’t see that project.');
    const convView = await access.levelOf('conversations', 'view'), projView = await access.levelOf('projects', 'view');
    if (projView === 'none' || rank(convView) < rank(projView)) throw new HttpsError('failed-precondition', 'More people see Conversations than this project, so its comments stay here.');
    const ref = db.collection('conversations').doc(c.id), had = await ref.get();
    if (had.exists) {
      // Added to it: an answer to its latest message (as Reply does), told to its people (onConversationMessage).
      if (text) await addTo(ref, email, text);
      return { id: c.id, title: had.data().title, existed: true };
    }
    const comments = (await cardRef.collection('comments').get()).docs.map((d) => d.data()).sort((a, b) => (a.at || 0) - (b.at || 0));
    // Its description first (its notes and any images: talk.js descriptionOf), by whoever made it; then what was said.
    const desc = descriptionOf(card);
    if (desc) comments.unshift({ text: desc, by: card.by || {}, at: card.at || 0 });
    if (text) comments.push({ text, by: { email, name: await nameOf(email) }, at: Date.now() });
    if (!comments.length) throw new HttpsError('invalid-argument', 'Write something first.');
    const first = comments[0], rest = comments.slice(1);
    const cardTitle = String(card.title || 'A card').slice(0, 200);
    const title = cardTitle.length > MAX_TITLE ? cardTitle.slice(0, MAX_TITLE - 3).replace(/\s+\S*$/, '') + '…' : cardTitle;
    const from = { kind: 'card', on: 'card/' + c.pid + '/' + c.card, page: String(ws.title || 'A project').slice(0, 200), part: cardTitle,
      url: projectPageUrl(ws.cardId || c.pid, ws.boardId) + '&tab=work&card=' + encodeURIComponent(c.card) };
    const batch = db.batch();
    batch.create(ref, Object.assign({ title, body: String(first.text || ''), at: first.at || Date.now(), source: 'comment', from, project: c.pid,
      private: false, readers: [], votes: {}, replies: rest.length, commentReplies: rest.length,
      broughtBy: { email, name: await nameOf(email) }, broughtAt: FieldValue.serverTimestamp() }, by(first)));
    rest.forEach((r, i) => batch.set(ref.collection('messages').doc('cm-' + i), Object.assign({ parent: c.id, body: String(r.text || ''), at: r.at || Date.now(), source: 'comment', votes: {} }, by(r))));
    try { await batch.commit(); }
    catch (e) { const again = await ref.get(); if (again.exists) return { id: c.id, title: again.data().title, existed: true }; throw e; }
    return { id: c.id, title, existed: false, replies: rest.length };
  }

  // Added to a conversation that's there: an answer to its latest message (as Reply does), told to its people.
  async function addTo(ref, email, text){
    const last = (await ref.collection('messages').orderBy('at', 'desc').limit(1).get()).docs[0];
    await ref.collection('messages').add({ parent: last ? last.id : ref.id, body: text, name: await nameOf(email) || email, createdBy: email,
      at: FieldValue.serverTimestamp(), source: 'site', viaAgent: false, votes: {} });
  }

  // A proposed change to the BOLDiquette or a guide: its discussion, as a conversation.
  async function fromChange(email, c, text){
    text = String(text || '').trim().slice(0, 10000);
    const page = pageOf(c.collection + '/' + c.slug, guideArea);
    await access.requireAccess(email, 'conversations', 'edit');
    await access.requireAccess(email, page.area, 'view');
    const convView = await access.levelOf('conversations', 'view'), pageView = await access.levelOf(page.area, 'view');
    if (pageView === 'none' || rank(convView) < rank(pageView)) throw new HttpsError('failed-precondition', 'More people see Conversations than this page, so its discussion stays here.');
    const docRef = db.collection(c.collection).doc(c.slug), ref = db.collection('conversations').doc(c.id);
    const had = await ref.get();
    if (had.exists) { if (text) await addTo(ref, email, text); return { id: c.id, title: had.data().title, existed: true }; }
    const [docSnap, propSnap] = await Promise.all([docRef.get(), docRef.collection('proposals').doc(c.proposal).get()]);
    if (!propSnap.exists) throw new HttpsError('not-found', 'That proposed change isn’t there any more.');
    const q = propSnap.data(), doc = docSnap.exists ? docSnap.data() : {};
    const part = (doc.parts || []).filter((x) => x.id === q.partId)[0];
    const what = (q.after && q.after.title) || (part && part.title) || '';
    const pageTitle = String(doc.title || (c.collection === 'handbook' ? 'BOLDiquette' : c.slug));
    const title = ('Proposed change: ' + pageTitle + (what ? ' › ' + what : '')).slice(0, 200);
    const old = (await docRef.collection('comments').where('proposalId', '==', c.proposal).get()).docs.map((d) => d.data()).sort((a, b) => (a.at || 0) - (b.at || 0));
    if (text) old.push({ text, by: { email, name: await nameOf(email) }, at: Date.now() });
    if (!old.length) throw new HttpsError('invalid-argument', 'Write something first.');
    const from = { kind: 'change', on: 'change/' + c.collection + '/' + c.slug + '/' + c.proposal, page: pageTitle.slice(0, 200), part: String(what).slice(0, 200),
      url: SITE_URL + page.href + '#proposal-' + encodeURIComponent(c.proposal) };
    const batch = db.batch();
    // The post: whoever proposed it, with their note on it; what was said is its replies, in order.
    batch.create(ref, Object.assign({ title, body: String(q.note || 'Proposes a change' + (what ? ' to “' + what + '”' : '') + ' on ' + pageTitle + '.'), at: q.at || Date.now(), source: 'comment', from,
      private: false, readers: [], votes: {}, replies: old.length, commentReplies: old.length, broughtBy: { email, name: await nameOf(email) }, broughtAt: FieldValue.serverTimestamp() },
      by({ by: q.by || {} })));
    old.forEach((r, i) => batch.set(ref.collection('messages').doc('cm-' + i), Object.assign({ parent: c.id, body: String(r.text || ''), at: r.at || Date.now(), source: 'comment', votes: {} }, by(r))));
    try { await batch.commit(); }
    catch (e) { const again = await ref.get(); if (again.exists) return { id: c.id, title: again.data().title, existed: true }; throw e; }
    return { id: c.id, title, existed: false };
  }

  // An Internal Review card's Discussion, as a conversation.
  async function fromReview(email, c, text){
    text = String(text || '').trim().slice(0, 10000);
    await access.requireAccess(email, 'conversations', 'edit');
    await access.requireAccess(email, 'ml-cycle', 'view');
    const convView = await access.levelOf('conversations', 'view'), pageView = await access.levelOf('ml-cycle', 'view');
    if (pageView === 'none' || rank(convView) < rank(pageView)) throw new HttpsError('failed-precondition', 'More people see Conversations than Internal Review, so its discussion stays here.');
    const ref = db.collection('conversations').doc(c.id), had = await ref.get();
    if (had.exists) { if (text) await addTo(ref, email, text); return { id: c.id, title: had.data().title, existed: true }; }
    const cardSnap = await db.collection('boards').doc(c.board).collection('cards').doc(c.card).get();
    if (!cardSnap.exists) throw new HttpsError('not-found', 'That paper isn’t on the board any more.');
    const card = cardSnap.data(), old = discussionOf(card.discussion);
    if (text) old.push({ text, by: { email, name: await nameOf(email) }, at: Date.now() });
    if (!old.length) throw new HttpsError('invalid-argument', 'Write something first.');
    const title = ('Internal Review: ' + String(card.title || 'a paper')).slice(0, 200);
    const from = { kind: 'review', on: 'review/' + c.board + '/' + c.card, page: 'Internal Review', part: String(card.title || '').slice(0, 200),
      url: SITE_URL + 'audit-board.html#board=' + encodeURIComponent(c.board) + '&card=' + encodeURIComponent(c.card) };
    const first = old[0], rest = old.slice(1), batch = db.batch();
    batch.create(ref, Object.assign({ title, body: first.text, at: first.at || Date.now(), source: 'comment', from, private: false, readers: [], votes: {},
      replies: rest.length, commentReplies: rest.length, broughtBy: { email, name: await nameOf(email) }, broughtAt: FieldValue.serverTimestamp() },
      card.projectId ? { project: String(card.projectId), projectTitle: String(card.title || '').slice(0, 300) } : {}, by(first)));
    rest.forEach((r, i) => batch.set(ref.collection('messages').doc('cm-' + i), Object.assign({ parent: c.id, body: r.text, at: r.at || Date.now(), source: 'comment', votes: {} }, by(r))));
    try { await batch.commit(); }
    catch (e) { const again = await ref.get(); if (again.exists) return { id: c.id, title: again.data().title, existed: true }; throw e; }
    return { id: c.id, title, existed: false };
  }

  const commentConversation = onCall(async (request) => {
    const email = signedInEmail(request).toLowerCase();
    const data = request.data || {};
    const c = cardOf(data.on);
    if (c) return fromCard(email, c, data.text);
    const ch = changeOf(data.on);
    if (ch) return fromChange(email, ch, data.text);
    const rv = reviewOf(data.on);
    if (rv) return fromReview(email, rv, data.text);
    const page = pageOf(data.on, guideArea), cid = String(data.id || '');
    if (!page || !/^[A-Za-z0-9_-]{1,64}$/.test(cid)) throw new HttpsError('invalid-argument', 'Which thread?');
    await access.requireAccess(email, 'conversations', 'edit');
    await access.requireAccess(email, page.area, 'view');
    // Not further than it was: everyone who sees Conversations must see the page.
    const convView = await access.levelOf('conversations', 'view'), pageView = await access.levelOf(page.area, 'view');
    if (pageView === 'none' || rank(convView) < rank(pageView)) throw new HttpsError('failed-precondition', 'More people see Conversations than this page, so its comments stay here.');

    const docRef = db.collection(page.collection).doc(page.slug), comments = docRef.collection('comments');
    const [docSnap, rootSnap] = await Promise.all([docRef.get(), comments.doc(cid).get()]);
    if (!rootSnap.exists) throw new HttpsError('not-found', 'That thread isn’t there any more.');
    const root = rootSnap.data();
    if (root.parent || root.proposalId || !root.quote) throw new HttpsError('invalid-argument', 'Only a thread on the text can be made a conversation.');
    const id = 'cm-' + page.collection + '-' + page.slug + '-' + cid, ref = db.collection('conversations').doc(id);
    if (root.conversation) {
      const had = await ref.get();
      if (had.exists) return { id, title: had.data().title, existed: true };
    }
    const replies = (await comments.where('parent', '==', cid).get()).docs.map((d) => d.data()).sort((a, b) => (a.at || 0) - (b.at || 0));
    const doc = docSnap.exists ? docSnap.data() : {};
    const part = (doc.parts || []).filter((p) => p.id === root.partId)[0];
    const title = titleOf(root.text, root.quote);
    const from = { kind: 'comment', on: page.collection + '/' + page.slug, commentId: cid, partId: String(root.partId || ''),
      page: String(doc.title || (page.collection === 'handbook' ? 'BOLDiquette' : page.slug)).slice(0, 200), part: String((part && part.title) || '').slice(0, 200),
      url: SITE_URL + page.href + '#c=' + encodeURIComponent(cid) };
    const batch = db.batch();
    batch.create(ref, Object.assign({ title, body: bodyOf(root.quote, root.text), at: root.at || Date.now(), source: 'comment', from,
      private: false, readers: [], votes: {}, replies: replies.length, commentReplies: replies.length,
      broughtBy: { email, name: await nameOf(email) }, broughtAt: FieldValue.serverTimestamp() }, by(root)));
    // In order, each answering the one before (conversations.js parentOf), as a Slack thread's.
    replies.forEach((r, i) => batch.set(ref.collection('messages').doc('cm-' + i), Object.assign({ parent: id, body: String(r.text || ''), at: r.at || Date.now(), source: 'comment', votes: {} }, by(r))));
    batch.update(rootSnap.ref, { conversation: id, conversationAt: Date.now(), conversationBy: email });
    try { await batch.commit(); }
    catch (e) { const again = await ref.get(); if (again.exists) return { id, title: again.data().title, existed: true }; throw e; }
    return { id, title, existed: false, replies: replies.length };
  });
  return { commentConversation };
};
module.exports.titleOf = titleOf;
module.exports.bodyOf = bodyOf;
module.exports.pageOf = pageOf;
module.exports.cardOf = cardOf;
module.exports.changeOf = changeOf;
module.exports.reviewOf = reviewOf;
module.exports.descriptionOf = descriptionOf;
module.exports.discussionOf = discussionOf;
