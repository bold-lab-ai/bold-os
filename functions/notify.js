'use strict';

// Notifications for what someone is part of (2026-11-05): each goes to their Notifications Inbox
// (notifications.html) through `deliver` (functions/index.js), which also pings them on Slack if
// they're on pings (pilot notification-pings). Nobody hears of what they did themselves.
// - A project they're on: someone joins or leaves it; a presentation is added; it starts (ongoing)
//   or is completed; its meeting, slides, notes or repository change.
// - A board card they're on or raised: they're put on it; it moves column; it's done (its raiser
//   hears of that through card-done already, so here its people do).
// - A part of the BOLDiquette or a guide they last changed (its `changedBy`): a comment on it, a
//   proposed change to it. A skill or tool they made or last changed: a proposed change to it.
// - An event series they joined: a new edition released; a released edition moved or cancelled.
// - Their group changed by a PI or admin on People (not a request they made: that one says so).
// The pure parts (what each says, and to whom) are exported for tests.

const lower = (e) => String(e || '').trim().toLowerCase();
const emailsOf = (list) => (list || []).map(lower).filter(Boolean);
const minus = (list, who) => Array.from(new Set(emailsOf(list))).filter((e) => e !== lower(who));
const q = (t) => '“' + String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120) + '”';

// Pure: a project's workspace before → after → [{ to, text, kind }].
function projectChanges(b, a, names){
  b = b || {}; a = a || {};
  const out = [], title = q(a.title || b.title || 'your project'), name = (e) => (names && names[e]) || e.split('@')[0];
  const was = emailsOf(b.members), now = emailsOf(a.members);
  now.filter((e) => was.indexOf(e) < 0).forEach((e) => out.push({ to: minus(now, e), text: name(e) + ' joined ' + title + '.', kind: 'project-joined' }));
  was.filter((e) => now.indexOf(e) < 0).forEach((e) => out.push({ to: minus(now, e), text: name(e) + ' left ' + title + '.', kind: 'project-left' }));
  if (!b.startedAt && a.startedAt) out.push({ to: minus(now, a.startedBy), text: title + ' is ongoing now.', kind: 'project-status' });
  if (!b.completedAt && a.completedAt) out.push({ to: minus(now, a.completedBy), text: title + ' is completed.', kind: 'project-status' });
  const same = (x, y) => JSON.stringify(x || null) === JSON.stringify(y || null);
  const changed = [];
  if (!same(b.meeting, a.meeting) && (b.meeting || a.meeting)) changed.push(a.meeting ? 'its meeting' : 'its meeting (removed)');
  if (!same([b.deckId, b.ownDeckUrl], [a.deckId, a.ownDeckUrl])) changed.push('its slides');
  if (!same([b.notesId, b.ownNotesUrl], [a.notesId, a.ownNotesUrl])) changed.push('its notes');
  if (!same([b.repoName, b.ownRepoUrl], [a.repoName, a.ownRepoUrl])) changed.push('its repository');
  if (changed.length && was.length) out.push({ to: minus(now, a.updatedBy), text: title + ': ' + changed.join(', ') + ' changed.', kind: 'project-setup' });
  return out.filter((x) => x.to.length);
}

// Pure: a board card before → after (the mover: after.updatedBy) → [{ to, text, kind }].
const COLUMNS = { todo: 'To do', doing: 'Doing', review: 'Waiting for review', done: 'Done' };
function cardChanges(b, a, tag, names){
  b = b || {}; a = a || {};
  const out = [], mover = lower(a.updatedBy), who = (names && names[mover]) || (mover ? mover.split('@')[0] : 'Someone');
  const title = (tag || '') + q(a.title);
  const was = emailsOf(b.assigneeEmails), now = emailsOf(a.assigneeEmails);
  const added = now.filter((e) => was.indexOf(e) < 0 && e !== mover);
  if (added.length) out.push({ to: added, text: who + ' put you on ' + title + '.', kind: 'card-assigned' });
  if (b.column && a.column && b.column !== a.column) {
    // Its people and its raiser, but not whoever's just been put on it (they heard) nor the mover;
    // to Done, the raiser hears through card-done, so only its people here.
    const raiser = lower((a.by || {}).email);
    const to = minus(now.concat(a.column === 'done' ? [] : [raiser]), mover).filter((e) => added.indexOf(e) < 0 && !(a.column === 'done' && e === raiser));
    if (to.length) out.push({ to, text: who + ' moved ' + title + ' to ' + (COLUMNS[a.column] || a.column) + '.', kind: 'card-moved' });
  }
  return out;
}

// Pure: who hears of a comment or a proposed change on a page's part: whoever last changed it.
function partOwners(parts, partId, by){
  const p = (parts || []).filter((x) => x && x.id === partId)[0];
  return p && p.changedBy ? minus([p.changedBy], by) : [];
}

// Pure: an edition of a series before → after → { text, kind } | null (to its series' joined).
function editionChange(b, a){
  const title = q((a || b || {}).title || 'an event');
  if (a && b && b.hidden === true && a.hidden === false) return { text: 'A new edition of ' + title + ' is out' + (a.startDate ? ', on ' + a.startDate : '') + '.', kind: 'edition-new' };
  if (b && !a && b.hidden === false) return { text: title + (b.startDate ? ' on ' + b.startDate : '') + ' is cancelled.', kind: 'edition-cancelled' };
  if (a && b && a.hidden === false && b.hidden === false && (a.startDate !== b.startDate || a.endDate !== b.endDate || (a.place || '') !== (b.place || '') || JSON.stringify(a.days || null) !== JSON.stringify(b.days || null))) {
    return { text: title + ' moved' + (a.startDate ? ': now ' + a.startDate + (a.place ? ', ' + a.place : '') : '') + '.', kind: 'edition-moved' };
  }
  return null;
}

module.exports = function({ db, onDocumentWritten, onDocumentUpdated, onDocumentCreated, deliver, logger, SITE_URL, projectPageUrl, guideUrl, handbookUrl, skillUrl, toolUrl, eventUrl, GROUP_LABELS, numberTag }){
  const safe = (what, fn) => async (event) => {
    try { await fn(event); } catch (err){ logger.warn('Notifying of ' + what + ' failed', { error: String(err && err.message || err) }); }
  };
  async function namesOf(emails){
    const out = {}, list = Array.from(new Set(emailsOf(emails)));
    for (let i = 0; i < list.length; i += 30) {
      (await db.collection('people').where('email', 'in', list.slice(i, i + 30)).get()).docs.forEach((d) => { out[lower(d.data().email)] = d.data().name; });
    }
    return out;
  }
  const send = (list, href, about) => Promise.all(list.map((x) => deliver(x.to, { text: x.text, href, feature: x.kind, source: 'bold', about })));

  const onWorkspaceNotify = onDocumentUpdated('projectWorkspaces/{pid}', safe('a project', async (event) => {
    const b = event.data.before.data(), a = event.data.after.data();
    const names = await namesOf(emailsOf(b.members).concat(emailsOf(a.members)));
    await send(projectChanges(b, a, names), projectPageUrl(a.cardId || event.params.pid, a.boardId), 'project:' + event.params.pid);
  }));
  const onPresentationNotify = onDocumentCreated('projectWorkspaces/{pid}/presentations/{id}', safe('a presentation', async (event) => {
    const t = event.data.data() || {}, ws = (await db.collection('projectWorkspaces').doc(event.params.pid).get()).data() || {};
    const to = minus(ws.members, (t.by || {}).email);
    if (to.length) await deliver(to, { text: ((t.by || {}).name || 'Someone') + ' added a presentation to ' + q(ws.title) + ': ' + q(t.title) + (t.date ? ', ' + t.date : '') + '.',
      href: projectPageUrl(ws.cardId || event.params.pid, ws.boardId), feature: 'project-presentation', source: 'bold', about: 'project:' + event.params.pid });
  }));
  const onCardNotify = onDocumentUpdated('projectWorkspaces/{pid}/work/{id}', safe('a card', async (event) => {
    const b = event.data.before.data(), a = event.data.after.data();
    if (JSON.stringify([b.assigneeEmails, b.column]) === JSON.stringify([a.assigneeEmails, a.column])) return;
    const ws = (await db.collection('projectWorkspaces').doc(event.params.pid).get()).data() || {};
    const names = await namesOf([a.updatedBy]);
    const tag = numberTag ? await numberTag(event.data.after.ref.path) : '';
    const url = projectPageUrl(ws.cardId || event.params.pid, ws.boardId) + '&tab=work&card=' + encodeURIComponent(event.params.id);
    await send(cardChanges(b, a, String(tag).replace(/\*/g, ''), names), url, 'card:' + event.params.pid + '/' + event.params.id);
  }));

  // A comment or a proposed change on a BOLDiquette or guide part: whoever last changed that part.
  function onPartNotify(collection, what){
    const url = (slug) => collection === 'handbook' ? handbookUrl(slug) : guideUrl(slug);
    return onDocumentCreated(collection + '/{slug}/' + what + '/{id}', safe('a ' + what.slice(0, -1), async (event) => {
      const d = event.data.data() || {};
      if (what === 'comments' && d.parent) return;   // a reply: its thread hears of it already
      const doc = (await db.collection(collection).doc(event.params.slug).get()).data() || {};
      const parts = d.partId ? [d.partId] : (d.changes || []).map((c) => c && c.partId).filter(Boolean);
      const by = (d.by || {}).email;
      for (const pid of Array.from(new Set(parts))) {
        const to = partOwners(doc.parts, pid, by), part = (doc.parts || []).filter((x) => x.id === pid)[0] || {};
        if (!to.length) continue;
        await deliver(to, { text: ((d.by || {}).name || 'Someone') + (what === 'comments' ? ' commented on ' : ' proposed a change to ') + q(part.title) + ', which you last changed, in ' + q(doc.title) + '.',
          href: url(event.params.slug) + (what === 'comments' ? '#c=' + event.params.id : '#proposals'), feature: what === 'comments' ? 'part-comment' : 'part-proposal', source: 'bold', about: collection + ':' + event.params.slug });
      }
    }));
  }
  // A proposed change to a skill or tool: whoever made it and whoever last changed it.
  function onMadeNotify(collection, urlOf, kind){
    return onDocumentCreated(collection + '/{name}/proposals/{id}', safe('a proposal on a ' + kind, async (event) => {
      const d = event.data.data() || {}, doc = (await db.collection(collection).doc(event.params.name).get()).data() || {};
      const to = minus([doc.createdBy, doc.updatedBy], (d.by || {}).email);
      if (to.length) await deliver(to, { text: ((d.by || {}).name || 'Someone') + ' proposed a change to the ' + kind + ' ' + q(doc.title || event.params.name) + ', which you made or last changed.',
        href: urlOf(event.params.name), feature: kind + '-proposal', source: 'bold', about: collection + ':' + event.params.name });
    }));
  }
  // An edition of a series: its joined hear when it's released, moved or cancelled.
  const onEditionNotify = onDocumentWritten('events/{slug}', safe('an edition', async (event) => {
    const b = event.data.before.exists ? event.data.before.data() : null, a = event.data.after.exists ? event.data.after.data() : null;
    const sid = (a || b || {}).series;
    if (!sid) return;
    const ch = editionChange(b, a);
    if (!ch) return;
    const s = (await db.collection('eventSeries').doc(sid).get()).data() || {};
    const to = minus(s.joined, (a || {}).updatedBy);
    if (to.length) await deliver(to, { text: ch.text, href: eventUrl ? eventUrl(event.params.slug, a || b) : SITE_URL + 'events.html', feature: ch.kind, source: 'bold', about: 'series:' + sid });
  }));
  // Their group, changed by a PI or admin on People (a request they made says so itself).
  const onGroupNotify = onDocumentUpdated('members/{email}', safe('a group change', async (event) => {
    const b = event.data.before.data() || {}, a = event.data.after.data() || {};
    // A request's acceptance marks it (categoryVia 'request-<time>', new each time): that one DMs them itself.
    const viaRequest = /^request/.test(String(a.categoryVia || '')) && a.categoryVia !== b.categoryVia;
    if (!b.category || !a.category || b.category === a.category || viaRequest || lower(a.categoryBy) === lower(event.params.email)) return;
    await deliver([event.params.email], { text: 'You’re in ' + (GROUP_LABELS[a.category] || a.category) + ' now (was ' + (GROUP_LABELS[b.category] || b.category) + ').',
      href: SITE_URL + 'boldiquette.html#who-is-bold', feature: 'group-changed', source: 'bold', about: 'group' });
  }));

  return {
    onWorkspaceNotify, onPresentationNotify, onCardNotify, onEditionNotify, onGroupNotify,
    onHandbookCommentNotify: onPartNotify('handbook', 'comments'), onHandbookProposalNotify: onPartNotify('handbook', 'proposals'),
    onGuideCommentNotify: onPartNotify('guides', 'comments'), onGuideProposalNotify: onPartNotify('guides', 'proposals'),
    onSkillProposalNotify: onMadeNotify('skills', skillUrl, 'skill'), onToolProposalNotify: onMadeNotify('agentTools', toolUrl, 'tool'),
  };
};
Object.assign(module.exports, { projectChanges, cardChanges, partOwners, editionChange });
