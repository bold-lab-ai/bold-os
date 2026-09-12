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
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const SLACK_BOT_TOKEN = defineSecret('SLACK_BOT_TOKEN');
// App Home + reviewer-assignment (2026-09-12, see ml-conference-cycle#3) —
// verifies that an incoming HTTP request actually came from Slack (see
// verifySlackSignatureRaw below). Not yet set — Eduardo still needs to run
// `firebase functions:secrets:set SLACK_SIGNING_SECRET --project bold-d7ff2`
// with the "Signing Secret" from the Slack app's Basic Information page,
// same pattern as SLACK_BOT_TOKEN.
const SLACK_SIGNING_SECRET = defineSecret('SLACK_SIGNING_SECRET');

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

// ---------- App Home dashboard — pure decision logic ----------
// (2026-09-12, see ml-conference-cycle#3, "Personal papers dashboard in
// Slack App Home, with reviewer assignment" — combines the original
// reviewer-assignment-from-Slack scope with a per-person dashboard.)
// Same split as everywhere else in this file: no I/O below this point,
// only the actual Firestore/Slack calls further down are impure.

// Slack signs every Events API and Interactivity request with the app's
// Signing Secret: HMAC-SHA256 over 'v0:{timestamp}:{raw body}', hex-encoded
// and prefixed 'v0=' (see https://api.slack.com/authentication/verifying-requests).
// Verifying this is the ONLY thing standing between this public HTTP
// endpoint and anyone on the internet being able to forge Slack events or
// (worse) forge a reviewer-assignment interactivity payload — this must run
// before any request body is trusted. The timestamp check guards against
// replaying an old, previously-valid request; nowSeconds is a parameter
// (not Date.now() inline) purely so this stays pure/testable.
function verifySlackSignatureRaw(signingSecret, timestamp, rawBody, signatureHeader, nowSeconds){
  if (!signingSecret || !timestamp || !signatureHeader) return false;
  var ts = parseInt(timestamp, 10);
  if (!isFinite(ts) || Math.abs(nowSeconds - ts) > 60 * 5) return false;
  var base = 'v0:' + timestamp + ':' + (rawBody || '');
  var expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  var a = Buffer.from(expected, 'utf8');
  var b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Mirrors firestore.rules' cards/{cardId} reviewer-reassignment condition
// exactly (see the "Reassigning reviewers is narrower" comment there):
// only the card's own submitter (the paper's owner) or a PI/admin may
// reassign reviewers. This check exists ONLY because the Cloud Function
// writes via the Admin SDK, which bypasses Security Rules entirely — this
// is the one place standing in for that rule for this one write path, and
// it must be kept in sync by hand if the rule ever changes.
function canAssignReviewer(actingEmail, card, piEmails, adminEmails){
  if (!actingEmail) return false;
  var submitterEmail = card && card.submittedBy && card.submittedBy.email;
  if (actingEmail === submitterEmail) return true;
  if ((piEmails || []).indexOf(actingEmail) !== -1) return true;
  if ((adminEmails || []).indexOf(actingEmail) !== -1) return true;
  return false;
}

// A reviewer-picker action's identity is split across two payload fields —
// action_id says which role (see reviewerPickerBlock's static_selects),
// block_id says which card (see its 'card:{boardId}:{cardId}' block_id) —
// so parsing it is one pure function taking both.
function parseAssignAction(actionId, blockId){
  var roleMatch = /^assign_(junior|senior)$/.exec(actionId || '');
  var blockMatch = /^card:([^:]+):([^:]+)$/.exec(blockId || '');
  if (!roleMatch || !blockMatch) return null;
  return { role: roleMatch[1], boardId: blockMatch[1], cardId: blockMatch[2] };
}

// One line of dashboard text for a card — same linkedTitle() clickable
// pattern as the DM notifications, so tapping the title from the Home tab
// lands on the same real card the message-based notifications point at.
function cardLine(item){
  var label = STATUS_LABEL[item.status] || item.status || '';
  return linkedTitle(item.title, cardUrl(item.boardId, item.cardId)) + '\n' + item.boardLabel + ' · ' + label;
}

// Slack's static_select caps at 100 options — the lab roster is nowhere
// near that, but capped here defensively rather than assumed. Sorted by
// name so the dropdown is actually browsable by eye.
function personOptionsFor(people){
  return (people || [])
    .filter(function(p){ return p && p.email; })
    .slice()
    .sort(function(a, b){ return (a.name || a.email).localeCompare(b.name || b.email); })
    .slice(0, 100)
    .map(function(p){ return { text: { type: 'plain_text', text: p.name || p.email }, value: p.email }; });
}

// Slack rejects a static_select initial_option that isn't itself one of
// the option objects it's given (not just a matching value) — and rejects
// the key being present at all with a null/undefined value — so this
// returns undefined (property omitted entirely by JSON.stringify) rather
// than null when there's no current assignee, or they're not in the
// options list (e.g. an old reviewer no longer in the `people` roster).
function initialOptionFor(email, options){
  if (!email) return undefined;
  return (options || []).filter(function(o){ return o.value === email; })[0];
}

// One reviewer-picker row per card the viewer owns (submitted) — the
// "if I am a paper owner, to be able to choose reviewers from there" ask.
// Both roles shown regardless of current status; reassigning after review
// has started is exactly what onSetReviewer already allows client-side.
function reviewerPickerBlock(item, people){
  var options = personOptionsFor(people);
  var junior = { type: 'static_select', action_id: 'assign_junior', placeholder: { type: 'plain_text', text: 'Junior reviewer' }, options: options };
  var senior = { type: 'static_select', action_id: 'assign_senior', placeholder: { type: 'plain_text', text: 'Senior reviewer' }, options: options };
  var rv = (item.card && item.card.reviewers) || {};
  var jrInitial = initialOptionFor(rv.junior, options);
  var srInitial = initialOptionFor(rv.senior, options);
  if (jrInitial) junior.initial_option = jrInitial;
  if (srInitial) senior.initial_option = srInitial;
  return { type: 'actions', block_id: 'card:' + item.boardId + ':' + item.cardId, elements: [junior, senior] };
}

// One heading + its cards (or an empty-state line) + a trailing divider —
// used for the three read-only sections (Reviewing — Junior/Senior,
// Authoring). Registered is built by hand in buildHomeView since it also
// carries the reviewer-picker action block per card.
function sectionBlocks(heading, items, emptyText){
  var blocks = [{ type: 'header', text: { type: 'plain_text', text: heading, emoji: true } }];
  if (!items.length){
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: emptyText } });
  } else {
    items.forEach(function(item){ blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cardLine(item) } }); });
  }
  blocks.push({ type: 'divider' });
  return blocks;
}

// The whole Home tab for one person, as a Block Kit `view` object ready
// for views.publish. `sections` is the already-queried, already-capped
// (top 10 most-recently-updated per bucket, see gatherDashboard) data;
// this function itself does no querying/sorting/capping of its own.
function buildHomeView(email, sections, people){
  var blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Here’s what’s yours right now.' } }, { type: 'divider' }];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: '📄 Registered', emoji: true } });
  if (!sections.registered.length){
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Nothing registered yet.' } });
  } else {
    sections.registered.forEach(function(item){
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cardLine(item) } });
      blocks.push(reviewerPickerBlock(item, people));
    });
  }
  blocks.push({ type: 'divider' });

  blocks = blocks.concat(sectionBlocks('🔍 Reviewing — Junior', sections.reviewingJunior, 'Not assigned as junior reviewer on anything.'));
  blocks = blocks.concat(sectionBlocks('🔍 Reviewing — Senior', sections.reviewingSenior, 'Not assigned as senior reviewer on anything.'));
  blocks = blocks.concat(sectionBlocks('✍️ Authoring', sections.authoring, 'Not listed as an author on anything yet.'));
  // Trailing divider from the last sectionBlocks() call is harmless at
  // the end of a Block Kit view — Slack doesn't require trimming it.

  return { type: 'home', blocks: blocks };
}

// Shown when a Slack user id can't be matched to anyone in the `people`
// roster (e.g. the roster sync hasn't run for a new hire yet) — same
// "nowhere to send this" gap slackIdForEmail/dmByEmail already handle for
// DMs, mirrored here for the Home tab instead of silently failing.
function buildUnrecognizedView(){
  return { type: 'home', blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: 'We couldn’t match your Slack account to a BOLD lab email yet. Ask an admin to add you to the roster, then reopen this tab.' } }
  ] };
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

// ---------- App Home dashboard — I/O ----------

// The reverse of slackIdForEmail — needed because every inbound Slack
// event/interactivity payload identifies the person by their Slack user
// id, never by email; the dashboard and the permission check both need
// the real email. Same "no match" shape as slackIdForEmail: null, not an
// error, for a Slack id not in the roster yet.
async function emailForSlackId(slackId){
  if (!slackId) return null;
  const snap = await db.collection('people').where('slackId', '==', slackId).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data().email || null;
}

// The whole roster, for building the reviewer-picker's option list (see
// personOptionsFor) — small enough (lab-scale, not org-scale) to fetch in
// full on every Home-tab open rather than caching.
async function allPeople(){
  const snap = await db.collection('people').get();
  return snap.docs.map(function(d){ return d.data(); });
}

// Sorts a query snapshot's docs by updatedAt descending and caps to
// `limit` — done here in JS rather than via Firestore .orderBy() so the
// four dashboard queries only need the single-field COLLECTION_GROUP
// overrides already in firestore.indexes.json (an equality filter plus an
// orderBy on a different field would need its own composite index).
function topRecent(snap, limit){
  return snap.docs
    .slice()
    .sort(function(a, b){ return (b.data().updatedAt || 0) - (a.data().updatedAt || 0); })
    .slice(0, limit);
}

// One board-id -> label lookup per distinct board across all four result
// sets, not per card — a person's papers are likely concentrated in a
// handful of venues even when they have many cards.
async function boardLabelsFor(boardIds){
  const unique = Array.from(new Set(boardIds));
  const entries = await Promise.all(unique.map(async function(boardId){
    const doc = await db.collection('boards').doc(boardId).get();
    return [boardId, doc.exists ? (doc.data().label || boardId) : boardId];
  }));
  const map = {};
  entries.forEach(function(e){ map[e[0]] = e[1]; });
  return map;
}

// The four collection-group queries behind the dashboard's four buckets
// (see firestore.indexes.json's fieldOverrides) — submitted, reviewing as
// junior/senior, and authoring (via the denormalized authorEmails, see
// audit-board.html's authorEmailsOf). Capped to the 10 most recently
// updated per bucket (topRecent) before boardLabelsFor/toItems ever run,
// so a prolific person's history doesn't blow out the Block Kit view.
async function gatherDashboard(email){
  const [registeredSnap, juniorSnap, seniorSnap, authoringSnap] = await Promise.all([
    db.collectionGroup('cards').where('submittedBy.email', '==', email).get(),
    db.collectionGroup('cards').where('reviewers.junior', '==', email).get(),
    db.collectionGroup('cards').where('reviewers.senior', '==', email).get(),
    db.collectionGroup('cards').where('authorEmails', 'array-contains', email).get()
  ]);
  const capped = [registeredSnap, juniorSnap, seniorSnap, authoringSnap].map(function(s){ return topRecent(s, 10); });
  const allDocs = capped.reduce(function(a, b){ return a.concat(b); }, []);
  const labels = await boardLabelsFor(allDocs.map(function(d){ return d.ref.parent.parent.id; }));

  function toItems(docs){
    return docs.map(function(d){
      const boardId = d.ref.parent.parent.id;
      const card = d.data();
      return { boardId: boardId, boardLabel: labels[boardId], cardId: d.id, title: card.title || 'Untitled', status: card.status, card: card };
    });
  }

  return {
    registered: toItems(capped[0]),
    reviewingJunior: toItems(capped[1]),
    reviewingSenior: toItems(capped[2]),
    authoring: toItems(capped[3])
  };
}

// Renders and publishes one person's whole Home tab — called both on
// app_home_opened and, again, right after a reviewer-assignment write goes
// through (see handleInteractivity) so the picker's initial_option
// reflects the change immediately rather than waiting for the next open.
async function handleAppHomeOpened(token, slackUserId){
  const email = await emailForSlackId(slackUserId);
  if (!email){
    await slackFetch(token, 'views.publish', { user_id: slackUserId, view: buildUnrecognizedView() });
    return;
  }
  const [people, sections] = await Promise.all([allPeople(), gatherDashboard(email)]);
  await slackFetch(token, 'views.publish', { user_id: slackUserId, view: buildHomeView(email, sections, people) });
}

// Handles one Interactivity payload — today only the reviewer-picker's
// static_select, per parseAssignAction's action_id/block_id scheme (see
// reviewerPickerBlock). Anything else (a payload shape not recognized, a
// missing card, a blocked permission check) is silently ignored rather
// than surfaced to the user — Slack's interactivity payloads have no
// simple "show an error toast" primitive without an extra response_url
// round trip, and a no-op picker click is self-evident (the dropdown just
// doesn't visibly change) rather than actively misleading.
async function handleInteractivity(token, payload){
  if (payload.type !== 'block_actions') return;
  const action = (payload.actions || [])[0];
  if (!action) return;
  const parsed = parseAssignAction(action.action_id, action.block_id);
  if (!parsed) return;
  const reviewerEmail = action.selected_option && action.selected_option.value;
  if (!reviewerEmail) return;

  const actingSlackId = payload.user && payload.user.id;
  const actingEmail = await emailForSlackId(actingSlackId);
  const cardRef = db.collection('boards').doc(parsed.boardId).collection('cards').doc(parsed.cardId);
  const cardSnap = await cardRef.get();
  if (!cardSnap.exists) return;
  const card = cardSnap.data();

  const [pis, admins] = await Promise.all([rolesEmails('pis'), rolesEmails('admins')]);
  if (!canAssignReviewer(actingEmail, card, pis, admins)){
    logger.warn('Blocked reviewer-assignment attempt from Slack', { actingEmail: actingEmail, boardId: parsed.boardId, cardId: parsed.cardId });
    return;
  }

  const reviewers = Object.assign({}, card.reviewers || {});
  reviewers[parsed.role] = reviewerEmail;
  await cardRef.update({ reviewers: reviewers, updatedAt: Date.now() });

  if (actingSlackId) await handleAppHomeOpened(token, actingSlackId);
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

// ---------- 5. Slack App Home + reviewer assignment ----------
// One HTTP endpoint doing double duty as both Slack's Events API Request
// URL (app_home_opened, plus the one-time url_verification handshake) and
// its Interactivity Request URL (the reviewer-picker's block_actions) —
// deliberately combined rather than two functions, since Slack config
// treats them as separate URLs but nothing stops them being the same one,
// and the signature-verification step at the top is identical either way.
//
// Eduardo's own remaining steps, none doable from here: enable "App Home"
// and "Event Subscriptions" (subscribed to app_home_opened) and
// "Interactivity & Shortcuts" in the Slack app config, all pointed at this
// function's URL (printed by `firebase deploy` once live); and run
// `firebase functions:secrets:set SLACK_SIGNING_SECRET --project bold-d7ff2`
// with the app's Signing Secret from Basic Information.
//
// Both branches ack Slack immediately (res.status(200).send('') before any
// await) and do the real work after — Slack requires a response within 3
// seconds and retries on timeout, and neither a Home-tab render nor a
// reviewer-assignment write is guaranteed to be that fast.
exports.slackEvents = onRequest(
  // invoker: 'public' — Slack calls this with no Google/Firebase auth of
  // its own, only its request signature (verified first thing below); GCP
  // now requires HTTP functions to say explicitly they allow unauthenticated
  // invocation, otherwise `firebase deploy` stops to ask interactively.
  { secrets: [SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET], invoker: 'public' },
  async function(req, res){
    const timestamp = req.get('x-slack-request-timestamp');
    const signature = req.get('x-slack-signature');
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!verifySlackSignatureRaw(SLACK_SIGNING_SECRET.value(), timestamp, raw, signature, nowSeconds)){
      logger.warn('Slack signature verification failed');
      res.status(401).send('Invalid signature');
      return;
    }

    const token = SLACK_BOT_TOKEN.value();

    // Interactivity arrives form-encoded with the JSON payload inside a
    // single `payload` field; Events API arrives as plain JSON — this is
    // the one place the two request shapes are told apart.
    if (req.body && typeof req.body.payload === 'string'){
      let payload;
      try { payload = JSON.parse(req.body.payload); } catch (err){ res.status(200).send(''); return; }
      res.status(200).send('');
      handleInteractivity(token, payload).catch(function(err){
        logger.error('handleInteractivity threw', { error: String(err) });
      });
      return;
    }

    const body = req.body || {};
    if (body.type === 'url_verification'){
      // One-time handshake when the Request URL is first saved in Slack's
      // app config — must echo the challenge back verbatim, synchronously.
      res.status(200).json({ challenge: body.challenge });
      return;
    }
    if (body.type === 'event_callback' && body.event && body.event.type === 'app_home_opened'){
      res.status(200).send('');
      handleAppHomeOpened(token, body.event.user).catch(function(err){
        logger.error('handleAppHomeOpened threw', { error: String(err) });
      });
      return;
    }
    res.status(200).send('');
  }
);

// Exported for the standalone unit test only (see scratchpad) — not part
// of the public Cloud Functions surface, harmless to export alongside it.
exports._internal = {
  flattenMessages, newMessages, cardEventsToNotify, venueUrl, cardUrl, linkedTitle, reviewStateEmoji,
  verifySlackSignatureRaw, canAssignReviewer, parseAssignAction, cardLine, personOptionsFor,
  initialOptionFor, reviewerPickerBlock, sectionBlocks, buildHomeView, buildUnrecognizedView
};
