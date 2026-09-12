// Cloud Functions for bold-d7ff2 — Slack DM notifications on Internal
// Review Board events. See ml-conference-cycle#1 and docs/FIREBASE.md's
// "Slack notifications" section for the design/history; this is the
// project's first server-side code, everything else in the repo is the
// plain client in audit-board.html talking straight to Firestore/Storage.
//
// Why this needs to exist at all: sending a Slack message needs a Bot
// token (chat:write + im:write scopes), a real credential that can never
// live in audit-board.html's client-side source. This is the one place
// that credential is ever held — as a Cloud Functions secret
// (`firebase functions:secrets:set SLACK_BOT_TOKEN`), never in the repo,
// never passed through the client.
//
// STATUS_LABEL/REVIEW_STATE_LABEL below are deliberately duplicated from
// audit-board.html's STATUS_LABELS/REVIEW_STATE_LABELS, not imported —
// there's no shared module between the plain-HTML client and this Node
// project. Keep both in sync by hand if either changes. Same for
// venueUrl/cardUrl mirroring audit-board.html's stateUrl() hash scheme —
// see that function's own comment for why it's a hash, not a real path.
//
// Structure follows the same split used throughout audit-board.html this
// same week: a pure decision function (cardEventsToNotify — no I/O, no
// Firestore, no Slack) computes *what* to notify from a before/after
// diff, and the actual trigger is a thin wrapper that resolves each
// event's emails to Slack ids and sends it. Keeping the decision logic
// pure is what makes it unit-testable without a live emulator or a real
// Slack workspace — see scratchpad test scripts referenced in the
// changelog.

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const SLACK_BOT_TOKEN = defineSecret('SLACK_BOT_TOKEN');

// Same region as the Firestore database (europe-west2, see firebase.json)
// — keeps the trigger close to the data it reads/writes. maxInstances is
// a cost/safety cap, not a real expected load at this scale.
setGlobalOptions({ region: 'europe-west2', maxInstances: 10 });

const APP_BASE_URL = 'https://bold-lab-ai.github.io/ml-conference-cycle/audit-board.html';

// Deep links (2026-09-12) — mirrors audit-board.html's stateUrl(): a hash,
// not a real path, since this is a static site with no server routing.
// The client's parseDeepLinkHash() on page load restores straight to the
// venue/card these point at.
function venueUrl(boardId){
  return APP_BASE_URL + '#board=' + encodeURIComponent(boardId);
}
function cardUrl(boardId, cardId){
  return APP_BASE_URL + '#board=' + encodeURIComponent(boardId) + '&card=' + encodeURIComponent(cardId);
}

// Bold *and* clickable — Slack mrkdwn's <url|label> syntax, with the bold
// asterisks inside the label so they apply to the link text (2026-09-12,
// per Eduardo: the title itself should be the link). This is now the
// *only* link in a message — no separate button any more (see
// sendEvent's own comment) — so it's the one thing to click in every
// notification.
function linkedTitle(text, url){
  return '<' + url + '|*' + text + '*>';
}

// Mirrors audit-board.html's STATUS_LABELS.
const STATUS_LABEL = {
  register: 'Registered',
  pitch_day: 'Pitched',
  draft_review: 'Drafted',
  final_draft: 'Reviewed',
  pi_polish: 'PI Approved',
  submit: 'Submitted',
  arxiv_publicity: 'Posted',
  rebuttal: 'Reviews Out',
  pre_conference: 'Accepted'
};

// Mirrors the three raw tri-state values from audit-board.html's
// REVIEW_STATE_LABELS (jr_approved/sr_approved are display-badge keys,
// not real values of jrReviewState/srReviewState, so aren't needed here).
const REVIEW_STATE_LABEL = {
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved'
};

// One glance at the emoji should say which way a reviewer's sign-off
// went (2026-09-12, per Eduardo) — a single 🔍 covering the whole
// message couldn't distinguish "approved" from "changes requested" when
// both roles changed in the same write with different outcomes. Reverting
// to 'in_review' (e.g. unticking a checklist box after being 'approved' —
// see onToggleChecklist's auto-sync in audit-board.html) is a real but
// less common case; ↩️ reads as "reopened", not a decision either way.
function reviewStateEmoji(state){
  if (state === 'approved') return '✅';
  if (state === 'changes_requested') return '❌';
  return '↩️';
}

// ---------- pure decision logic ----------

// Discussion/checklist-comment threads are embedded arrays with one level
// of nested replies (see docs/FIREBASE.md) — flatten both levels so a new
// comment is just "present in `after` but not in `before`, by id".
function flattenMessages(list){
  var out = [];
  (list || []).forEach(function(m){
    out.push(m);
    (m.replies || []).forEach(function(r){ out.push(r); });
  });
  return out;
}

function newMessages(beforeList, afterList){
  var beforeIds = {};
  flattenMessages(beforeList).forEach(function(m){ beforeIds[m.id] = true; });
  return flattenMessages(afterList).filter(function(m){ return !beforeIds[m.id]; });
}

// Given a card's before/after (Firestore document data, or null for
// before on a brand-new card), its title, and its boardId/cardId (for
// building a real deep link — see cardUrl above), returns the list of
// notifications this diff implies — { emails, headline, excludeEmail? } —
// with no I/O of any kind. `headline` is Slack mrkdwn; the paper/venue
// name is always linkedTitle(), the message's one and only clickable
// element (see sendEvent — there's no separate button any more). A
// single write can imply more than one event at once (e.g. a reviewer's
// last tick both sets their review state AND auto-advances the card in
// the same write, see onSetReviewState/onToggleChecklist in
// audit-board.html) — each becomes its own entry, since they can go to
// different recipients.
function cardEventsToNotify(before, after, title, boardId, cardId){
  var events = [];
  if (!before) return events; // brand-new card — nothing to notify about yet
  var url = cardUrl(boardId, cardId);
  var linked = linkedTitle(title, url);
  var submitterEmail = after.submittedBy && after.submittedBy.email;
  var rvBefore = before.reviewers || {};
  var rvAfter = after.reviewers || {};

  // Reviewer sign-off on your card (Approved / Changes requested), or
  // both reviewers approving and the card auto-advancing in the same
  // write — notify the submitter either way, since they aren't the one
  // who clicked it. Outcome emoji lead the message (roleEmojis), same
  // position as every other event type's icon — collected separately from
  // the plain-text role labels (roleChanges) so a mixed outcome (one role
  // approves, the other requests changes) still shows both glyphs up
  // front, distinctly, rather than picking just one to lead with.
  var roleEmojis = [];
  var roleChanges = [];
  if (after.jrReviewState !== before.jrReviewState){
    roleEmojis.push(reviewStateEmoji(after.jrReviewState));
    roleChanges.push('Junior reviewer: ' + (REVIEW_STATE_LABEL[after.jrReviewState] || after.jrReviewState));
  }
  if (after.srReviewState !== before.srReviewState){
    roleEmojis.push(reviewStateEmoji(after.srReviewState));
    roleChanges.push('Senior reviewer: ' + (REVIEW_STATE_LABEL[after.srReviewState] || after.srReviewState));
  }
  if (roleChanges.length && submitterEmail){
    var reviewHeadline = roleEmojis.join('') + ' ' + linked + ' — ' + roleChanges.join(', ') + '.';
    if (before.status !== after.status && after.status === 'final_draft'){
      reviewHeadline += ' Both reviewers approved — moved to Reviewed.';
    }
    events.push({ emails: [submitterEmail], headline: reviewHeadline });
  }

  // You're assigned as reviewer — only whoever's newly in that role, not
  // whoever's being replaced or removed. 🔍 = "go take a look", distinct
  // from the outcome checkmarks/X above (this is a task handed to you,
  // not a verdict on your own work).
  if (rvAfter.junior && rvAfter.junior !== rvBefore.junior){
    events.push({ emails: [rvAfter.junior], headline: '🔍 You’ve been assigned as *Junior reviewer* for ' + linked + '.' });
  }
  if (rvAfter.senior && rvAfter.senior !== rvBefore.senior){
    events.push({ emails: [rvAfter.senior], headline: '🔍 You’ve been assigned as *Senior reviewer* for ' + linked + '.' });
  }

  // General status change, to the submitter. ➡️ = plain forward motion,
  // no decision implied.
  if (before.status !== after.status && submitterEmail){
    var label = STATUS_LABEL[after.status] || after.status;
    events.push({ emails: [submitterEmail], headline: '➡️ ' + linked + ' moved to *' + label + '*.' });
  }

  // Reaches the PI-approval step — notify the PI specifically (the last
  // entry in authors, see docs/AGENTS.md guideline 8), not just the
  // submitter (already covered above). Silently produces no event if the
  // PI has no email on file — old, not-yet-migrated author data (see
  // normalizeCard's authors migration) or a card whose last author was
  // never actually set. 🔔 = "this needs a decision from you" — same
  // family as the venue-proposal notification below, both are asking the
  // recipient to actually go approve something, not just informing them.
  if (before.status !== 'pi_polish' && after.status === 'pi_polish'){
    var authors = after.authors || [];
    var pi = authors.length ? authors[authors.length - 1] : null;
    if (pi && pi.email){
      events.push({ emails: [pi.email], headline: '🔔 ' + linked + ' is ready for your approval.' });
    }
  }

  // New Discussion message (2026-09-12, revised per Eduardo) — a
  // brand-new top-level message still goes to everyone with a stake in
  // the card (submitter + both reviewers), excluding the poster. A REPLY
  // goes only to the people already in *that* thread — the top-level
  // message's own author plus anyone who'd already replied before this
  // one — not the full stakeholder set, so replying inside one side
  // conversation doesn't loop in someone who was never part of it.
  var stakeholders = [submitterEmail, rvAfter.junior, rvAfter.senior].filter(Boolean);
  var beforeDiscussionById = {};
  (before.discussion || []).forEach(function(m){ beforeDiscussionById[m.id] = m; });
  (after.discussion || []).forEach(function(afterMsg){
    var beforeMsg = beforeDiscussionById[afterMsg.id];
    if (!beforeMsg){
      var newBody = (afterMsg.body || '').slice(0, 140);
      events.push({
        emails: stakeholders,
        excludeEmail: afterMsg.authorEmail,
        headline: '💬 ' + (afterMsg.author || 'Someone') + ' commented on ' + linked + ': “' + newBody + '”'
      });
      return;
    }
    var beforeReplyIds = {};
    (beforeMsg.replies || []).forEach(function(r){ beforeReplyIds[r.id] = true; });
    (afterMsg.replies || []).filter(function(r){ return !beforeReplyIds[r.id]; }).forEach(function(reply){
      var participants = [beforeMsg.authorEmail].concat((beforeMsg.replies || []).map(function(r){ return r.authorEmail; }));
      var replyBody = (reply.body || '').slice(0, 140);
      events.push({
        emails: participants,
        excludeEmail: reply.authorEmail,
        headline: '💬 ' + (reply.author || 'Someone') + ' replied on ' + linked + ': “' + replyBody + '”'
      });
    });
  });

  // Checklist-item comments (2026-09-12, revised per Eduardo) — not a
  // stakeholder broadcast like Discussion. Each item has one shared
  // thread, not separate junior/senior threads, so there's no way to
  // tell which reviewer a submitter's comment is addressed to: if the
  // SUBMITTER posts, notify BOTH reviewers. If a REVIEWER posts (junior
  // or senior — the two passes are independent of each other), notify
  // only the submitter, not the other reviewer. Anyone else posting (a
  // PI/admin editing directly, say) falls back to "notify the submitter"
  // — the safest default, since they're the one most likely to want to
  // know about any comment on their own paper.
  var beforeChecklist = before.checklist || [];
  var afterChecklist = after.checklist || [];
  afterChecklist.forEach(function(item){
    var beforeItem = beforeChecklist.filter(function(it){ return it.id === item.id; })[0];
    newMessages(beforeItem && beforeItem.comments, item.comments).forEach(function(msg){
      var recipients = (msg.authorEmail && msg.authorEmail === submitterEmail)
        ? [rvAfter.junior, rvAfter.senior]
        : [submitterEmail];
      var posterName = msg.author || 'Someone';
      var body = (msg.body || '').slice(0, 140);
      events.push({
        emails: recipients,
        excludeEmail: msg.authorEmail,
        headline: '💬 ' + posterName + ' commented on ' + linked + ': “' + body + '”'
      });
    });
  });

  return events;
}

// ---------- Slack API ----------
// Plain fetch against the Web API, no SDK dependency — same minimal-deps
// preference as the rest of this project, just applied to the one place
// that now has a real package.json.

async function slackFetch(token, method, body){
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) logger.warn('Slack API call failed', { method, error: json.error });
  return json;
}

// Resolves a real email to a Slack user id via the `people` collection —
// already synced from Slack's users.list (see docs/FIREBASE.md) — rather
// than a live users.lookupByEmail call. Faster (one Firestore read, no
// extra external round trip) and doesn't add a new load-bearing use of
// the users:read.email scope at notify time. Returns null, not an error,
// for anyone not in the roster (an external "New author", see
// docs/AGENTS.md guideline 8, or old data with a blank email) — there's
// simply nowhere to send that DM.
async function slackIdForEmail(email){
  if (!email) return null;
  const snap = await db.collection('people').where('email', '==', email).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data().slackId || null;
}

// Opens (or reuses) a DM channel and posts one message. Never throws —
// logs and resolves false on any failure, so one bad recipient (no Slack
// id, a transient API error) can't take the rest of a batch down with it,
// and a retry of the whole trigger isn't forced by one skipped DM.
async function dmBySlackId(token, slackId, text){
  try {
    const opened = await slackFetch(token, 'conversations.open', { users: slackId });
    if (!opened.ok) return false;
    const posted = await slackFetch(token, 'chat.postMessage', { channel: opened.channel.id, text: text });
    return !!posted.ok;
  } catch (err){
    logger.error('dmBySlackId threw', { slackId, error: String(err) });
    return false;
  }
}

async function dmByEmail(token, email, text){
  const slackId = await slackIdForEmail(email);
  if (!slackId){
    logger.info('No Slack id for email — skipping DM', { email });
    return false;
  }
  return dmBySlackId(token, slackId, text);
}

async function rolesEmails(name){
  const doc = await db.collection('roles').doc(name).get();
  const data = doc.exists ? doc.data() : null;
  return (data && Array.isArray(data.emails)) ? data.emails : [];
}

// Resolves and sends one event ({ emails, headline, excludeEmail? }) — the
// one place cardEventsToNotify's pure output turns into real Slack calls.
// Plain text, not Block Kit (2026-09-12, reverted from the same-day Block
// Kit version) — per Eduardo, the linked title is the message's one
// clickable element now; a separate button was a redundant second link to
// the same place once the title itself became clickable. Slack's mrkdwn
// (the default for chat.postMessage's `text`) already renders the bold
// link correctly with no Block Kit needed.
async function sendEvent(token, event){
  const unique = Array.from(new Set(event.emails.filter(Boolean)))
    .filter(function(e){ return e !== event.excludeEmail; });
  await Promise.all(unique.map(function(email){ return dmByEmail(token, email, event.headline); }));
}

// ---------- 1. Venue proposal needs approval ----------
// PIs and admins are the only ones who can approve/reject (see
// onApproveVenue/onRejectVenue in audit-board.html) — notify all of them
// the moment a proposal exists, rather than relying on someone happening
// to open the board and see "Pending your approval".

exports.onVenueProposed = onDocumentCreated(
  { document: 'boards/{boardId}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const data = event.data && event.data.data();
    if (!data || data.status !== 'pending') return;
    const token = SLACK_BOT_TOKEN.value();
    const pis = await rolesEmails('pis');
    const admins = await rolesEmails('admins');
    const proposer = (data.proposedBy && (data.proposedBy.name || data.proposedBy.email)) || 'Someone';
    const url = venueUrl(event.params.boardId);
    // 🔔 — same "needs a decision from you" family as onCardWritten's
    // PI-approval notification, not a plain FYI icon.
    const headline = '🔔 New venue proposal: ' + linkedTitle(data.label, url) + ' — proposed by ' + proposer +
      '. It needs your approval before it’s visible to the lab.';
    await sendEvent(token, {
      emails: pis.concat(admins),
      excludeEmail: data.proposedBy && data.proposedBy.email,
      headline: headline
    });
  }
);

// ---------- 2, 3, 4: card events ----------

exports.onCardWritten = onDocumentWritten(
  { document: 'boards/{boardId}/cards/{cardId}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // card deleted — nothing to notify about
    const token = SLACK_BOT_TOKEN.value();
    const title = after.title || 'a paper';
    const events = cardEventsToNotify(before, after, title, event.params.boardId, event.params.cardId);
    for (let i = 0; i < events.length; i++){
      await sendEvent(token, events[i]);
    }
  }
);

// Exported for the standalone unit test only (see scratchpad) — not part
// of the public Cloud Functions surface, harmless to export alongside it.
exports._internal = { flattenMessages, newMessages, cardEventsToNotify, venueUrl, cardUrl, linkedTitle, reviewStateEmoji };
