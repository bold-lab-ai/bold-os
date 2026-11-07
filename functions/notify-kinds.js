'use strict';

// What people can choose to hear about (Notifications › Settings, 2026-11-06): each kind is a set of the
// features notifications carry (`feature` on notifications/{id}; the keys senders pass: PILOTS and
// LIVE_FEATURES in index.js, notify.js's kinds). A kind someone unticks (notifyPrefs/{email} `off`) still
// reaches their Inbox, but not Slack nor their computers. A feature in no kind can't be turned off on its
// own (only by Slack messages: Nothing). Also read by the page (src/_data/notifyKinds.js), so the two agree.
const KINDS = [
  { section: 'Conversations', items: [
    { id: 'conv-mine', label: 'Replies to my messages', features: ['conversation-reply-mine'] },
    { id: 'conv-in', label: 'Other replies in conversations I’m in', features: ['conversation-replies'] },
    { id: 'conv-invites', label: 'Invitations to conversations', features: ['conversation-invites'] },
  ] },
  { section: 'Projects', items: [
    { id: 'proj-people-mine', label: 'People joining or leaving my projects', features: ['project-joined-mine', 'project-left-mine'] },
    { id: 'proj-people', label: 'People joining or leaving other projects I’m in', features: ['project-joined', 'project-left'] },
    { id: 'proj-changes', label: 'A project I’m in starting, completing, changing its setup or adding a presentation', features: ['project-status', 'project-setup', 'project-presentation'] },
    { id: 'proj-invites', label: 'Invitations to projects, and their answers', features: ['project-invites'] },
    { id: 'meetings', label: 'Meetings about to start', features: ['meeting-soon'] },
  ] },
  { section: 'Boards', items: [
    { id: 'cards', label: 'Cards I’m on or raised: put on one, moved, done', features: ['card-assigned', 'card-moved', 'card-done'] },
    { id: 'card-comments', label: 'Comments on cards I’m on or raised', features: ['card-comments'] },
  ] },
  { section: 'The BOLDiquette, guides, skills and tools', items: [
    { id: 'tags', label: 'Someone tagging me', features: ['tags'] },
    { id: 'page-comments', label: 'Comments on what I wrote or replied to', features: ['guide-comments', 'part-comment'] },
    { id: 'page-proposals', label: 'Proposed changes to what I wrote or made', features: ['part-proposal', 'skill-proposal', 'tool-proposal'] },
    { id: 'proposal-decided', label: 'My proposed changes accepted or declined', features: ['proposal-decided'] },
  ] },
  { section: 'Events', items: [
    { id: 'events', label: 'Event series I joined or organise: new, moved or cancelled editions, and what’s due', features: ['edition-new', 'edition-moved', 'edition-cancelled', 'series-added', 'series-due'] },
  ] },
  { section: 'You, and what you asked', items: [
    { id: 'group', label: 'My group: changes, a new group’s first week, being ready for the next', features: ['group-changed', 'group-trial', 'group-ready'] },
    { id: 'asks', label: 'Answers to what I asked, and asks waiting on me: letters, introductions, supervision, agents', features: ['letters', 'introductions', 'supervision-requests', 'agent-requests', 'inviter-confirm'] },
    { id: 'review', label: 'Internal Review: my papers, reviews and reviewers', features: ['irb-board', 'irb-author-cap', 'irb-reviews-out'] },
  ] },
  { section: 'For PIs and admins', items: [
    { id: 'pi-requests', label: 'Requests to join BOLD or change group, and who meets the next group', features: ['join-requests', 'group-requests', 'group-eligible'] },
    { id: 'pi-proposals', label: 'Proposed changes and projects to decide, and the reviewer’s concerns', features: ['proposals', 'proposal-reviewer', 'project-proposals'] },
    { id: 'pi-venues', label: 'Venues proposed for Internal Review, and new calls for papers', features: ['venue-proposed', 'venue-calls'] },
    { id: 'pi-link', label: 'The Slack invite link expiring', features: ['invite-link-reminder'] },
  ], pi: true },
];
const IDS = KINDS.reduce((a, s) => a.concat(s.items.map((i) => i.id)), []);
const BY_FEATURE = {};
KINDS.forEach((s) => s.items.forEach((i) => i.features.forEach((f) => { BY_FEATURE[f] = i.id; })));
// Pure: the kind a feature is in, or ''.
const kindOf = (feature) => BY_FEATURE[String(feature || '')] || '';
// Pure: whether someone with these unticked kinds hears of `feature` outside their Inbox.
const wants = (off, feature) => { const k = kindOf(feature); return !k || (off || []).indexOf(k) < 0; };

module.exports = { KINDS, IDS, kindOf, wants };
