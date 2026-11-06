'use strict';

// A comment thread turned into a conversation (2026-11-06): Make it a conversation on a thread of
// comments on the BOLDiquette or a guide (comments.js). The thread is copied into Conversations as a
// post (conversations/{id}, source 'comment') with its replies under it, each by whoever wrote it, as a
// Slack thread is brought in (slack-thread.js). The post's `from` says where it came from, and links back
// to the passage; the thread's first comment gets `conversation: <post id>`, so the page shows where it
// went on, and takes no more replies there (firestore.rules). One thread is one post: asking again
// gives the same post.
// commentConversation { on: 'handbook/<slug>' | 'guides/<slug>', id: <the thread's first comment> } → { id, title, existed }.
// Who may: whoever may post in Conversations and see the page. Only where everyone who sees
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
// Pure: the page a thread is on, and its area in Who can see what. on: 'handbook/<slug>' | 'guides/<slug>'.
function pageOf(on, guideArea){
  const m = /^(handbook|guides)\/([a-z0-9_-]{1,80})$/.exec(String(on || ''));
  if (!m) return null;
  const [, collection, slug] = m;
  if (collection === 'handbook' && slug !== 'boldiquette') return null;
  return { collection, slug, area: collection === 'handbook' ? 'boldiquette' : guideArea(slug),
    href: collection === 'handbook' ? 'boldiquette.html' : 'guide.html?guide=' + encodeURIComponent(slug) };
}

module.exports = function({ db, onCall, HttpsError, signedInEmail, access, FieldValue, SITE_URL, rank, guideArea }){
  const commentConversation = onCall(async (request) => {
    const email = signedInEmail(request).toLowerCase();
    const data = request.data || {};
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
    const by = (c) => ({ name: String((c.by && c.by.name) || (c.by && c.by.email) || 'Someone').slice(0, 200), createdBy: String((c.by && c.by.email) || '').toLowerCase() });
    const p = (await db.collection('people').where('email', '==', email).limit(1).get()).docs[0];
    const title = titleOf(root.text, root.quote);
    const from = { kind: 'comment', on: page.collection + '/' + page.slug, commentId: cid, partId: String(root.partId || ''),
      page: String(doc.title || (page.collection === 'handbook' ? 'BOLDiquette' : page.slug)).slice(0, 200), part: String((part && part.title) || '').slice(0, 200),
      url: SITE_URL + page.href + '#c=' + encodeURIComponent(cid) };
    const batch = db.batch();
    batch.create(ref, Object.assign({ title, body: bodyOf(root.quote, root.text), at: root.at || Date.now(), source: 'comment', from,
      private: false, readers: [], votes: {}, replies: replies.length, commentReplies: replies.length,
      broughtBy: { email, name: String((p && p.data().name) || '') }, broughtAt: FieldValue.serverTimestamp() }, by(root)));
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
