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
// action_id says which role and which verb (see reviewerPickerBlock's
// external_selects and Clear buttons), block_id says which card (its
// 'card:{boardId}:{cardId}' block_id) — so parsing it is one pure
// function taking both. 'assign' comes from picking a name in the
// external_select; 'clear' comes from the explicit Clear button
// (reviewerPickerBlock) — Block Kit's external_select, unlike a plain
// HTML <select>, has no built-in way for the viewer to clear a value
// once picked (confirmed live-testing 2026-09-14, correcting an earlier,
// wrong assumption that Slack rendered an "x" for this) — the button is
// the only way to unassign a reviewer from Slack at all.
function parseAssignAction(actionId, blockId){
  var match = /^(assign|clear)_(junior|senior)$/.exec(actionId || '');
  // The trailing :junior/:senior (see reviewerPickerBlock) exists only to
  // make each row's block_id unique within the view — action_id already
  // carries the role, so it's accepted here but not itself read back out.
  var blockMatch = /^card:([^:]+):([^:]+)(?::(?:junior|senior))?$/.exec(blockId || '');
  if (!match || !blockMatch) return null;
  return { verb: match[1], role: match[2], boardId: blockMatch[1], cardId: blockMatch[2] };
}

// Resolves the actual email to write for an 'assign' action from its
// external_select selection. Defensive, not the primary way to clear a
// reviewer (see parseAssignAction's comment — that's the Clear button,
// handled separately in handleInteractivity): returns '' if
// selected_option is present but null (matches audit-board.html's own
// unassigned sentinel, `<option value="">Assign…</option>`, see
// reviewerInputHtml/onSetReviewer) and null only when the action has no
// selected_option key at all, i.e. isn't a select action's payload shape
// in the first place — callers should ignore that case outright.
function reviewerEmailFromAction(action){
  if (!action || !('selected_option' in action)) return null;
  return action.selected_option ? (action.selected_option.value || '') : '';
}

// One line of dashboard text for a card — same linkedTitle() clickable
// pattern as the DM notifications, so tapping the title from the Home tab
// lands on the same real card the message-based notifications point at.
function cardLine(item){
  var label = STATUS_LABEL[item.status] || item.status || '';
  return linkedTitle(item.title, cardUrl(item.boardId, item.cardId)) + '\n' + item.boardLabel + ' · ' + label;
}

// Turns a (pre-filtered) roster subset into Slack option objects, sorted
// by name. Slack caps ANY select menu's option list at 100 — a real bug
// hit in production (2026-09-12): the lab roster is 274 people, so a
// static_select built from the WHOLE roster silently truncated after the
// 100th name alphabetically ("stops at letter H"), with no error, no
// warning, just missing names. Capping here is the same defensive 100
// as before; the actual fix is that this is no longer handed to Slack as
// a select's full option list (see reviewerPickerBlock) — it now only
// ever backs a live-filtered block_suggestion response (see
// filterPeopleOptions/handleBlockSuggestion), where 100 matches for a
// typed query is already far more than anyone would scroll through.
function personOptionsFor(people){
  return (people || [])
    .filter(function(p){ return p && p.email; })
    .slice()
    .sort(function(a, b){ return (a.name || a.email).localeCompare(b.name || b.email); })
    .slice(0, 100)
    .map(function(p){ return { text: { type: 'plain_text', text: p.name || p.email }, value: p.email }; });
}

// Slack's live type-ahead for external_select — Interactivity's
// block_suggestion payload carries whatever's typed so far (`query`,
// empty string when the field is first focused) and this narrows the
// roster to name/email substring matches, case-insensitive. Deliberately
// searches the WHOLE roster (not a pre-capped subset) before capping the
// RESULT to 100 — capping first, like the old static_select did, would
// silently drop a real match again for anyone past the cut alphabetically.
function filterPeopleOptions(people, query){
  var q = (query || '').trim().toLowerCase();
  var matches = (people || []).filter(function(p){
    if (!p || !p.email) return false;
    if (!q) return true;
    var name = (p.name || '').toLowerCase();
    var email = (p.email || '').toLowerCase();
    return name.indexOf(q) !== -1 || email.indexOf(q) !== -1;
  });
  return personOptionsFor(matches);
}

// Slack rejects a select's initial_option that isn't itself a full option
// object (not just a matching value) — and rejects the key being present
// at all with a null/undefined value — so this returns undefined
// (property omitted entirely by JSON.stringify) rather than null when
// there's no current assignee, or they're no longer in the roster.
// Searches the raw roster directly, NOT a pre-capped/pre-filtered option
// list — the current assignee could easily be past any alphabetical cut,
// and this only ever needs to find the one exact match, never a list.
function initialOptionForEmail(email, people){
  if (!email) return undefined;
  var match = (people || []).filter(function(p){ return p && p.email === email; })[0];
  if (!match) return undefined;
  return { text: { type: 'plain_text', text: match.name || match.email }, value: match.email };
}

// One reviewer-picker row per card the viewer owns (submitted) — the
// "if I am a paper owner, to be able to choose reviewers from there" ask.
// Both roles shown regardless of current status; reassigning after review
// has started is exactly what onSetReviewer already allows client-side.
// external_select, not static_select (2026-09-12, fixed a real bug — see
// personOptionsFor's comment): Slack's 100-option cap on a static list
// silently dropped real people from a 274-person roster. external_select
// instead calls back to this same function's block_suggestion handler as
// the viewer types, so there's no upfront list size limit at all.
// Returns an ARRAY of two `actions` blocks, one per role — junior's own
// row above senior's own row — not one block. Originally a single row
// with both selects then both Clear buttons trailing off to the side;
// Eduardo (2026-09-14, after the danger-style buttons still didn't read
// as paired with their own select): "put them below them, aligned" — i.e.
// each select immediately followed by its own Clear button, one role per
// line. Block Kit has no column/grid layout to align across separate
// blocks, and no compound select+clear control, so "each pair on its own
// row" is the closest real visual pairing actually achievable — two
// elements on the SAME row read as belonging together in a way spacing
// alone can't fake. Each row needs its own block_id (Slack requires
// block_id to be unique across the whole view) — the boardId/cardId pair
// is now suffixed with the role; parseAssignAction already gets the role
// from action_id, so the suffix here is purely to satisfy that
// uniqueness requirement, not something anything parses back out.
function reviewerPickerBlock(item, people){
  var rv = (item.card && item.card.reviewers) || {};
  var blockIdBase = 'card:' + item.boardId + ':' + item.cardId;

  var junior = { type: 'external_select', action_id: 'assign_junior', placeholder: { type: 'plain_text', text: 'Junior reviewer' }, min_query_length: 1 };
  var jrInitial = initialOptionForEmail(rv.junior, people);
  if (jrInitial) junior.initial_option = jrInitial;
  var juniorElements = [junior];
  if (rv.junior){
    // style: 'danger' is Block Kit's red-button treatment — the closest a
    // plain_text button can get to a small red "×" (there's no icon-only
    // control in Block Kit for a literal × glyph).
    juniorElements.push({ type: 'button', action_id: 'clear_junior', style: 'danger', text: { type: 'plain_text', text: '✕ Junior' } });
  }

  var senior = { type: 'external_select', action_id: 'assign_senior', placeholder: { type: 'plain_text', text: 'Senior reviewer' }, min_query_length: 1 };
  var srInitial = initialOptionForEmail(rv.senior, people);
  if (srInitial) senior.initial_option = srInitial;
  var seniorElements = [senior];
  if (rv.senior){
    seniorElements.push({ type: 'button', action_id: 'clear_senior', style: 'danger', text: { type: 'plain_text', text: '✕ Senior' } });
  }

  return [
    { type: 'actions', block_id: blockIdBase + ':junior', elements: juniorElements },
    { type: 'actions', block_id: blockIdBase + ':senior', elements: seniorElements }
  ];
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
      // reviewerPickerBlock now returns two rows (junior, then senior),
      // not one — concat, not push, to flatten both into the view.
      blocks = blocks.concat(reviewerPickerBlock(item, people));
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

// Real gap found live-testing (2026-09-14): the App Home dashboard only
// ever re-publishes when someone opens their Home tab, or right after
// *our own* Slack-driven reviewer-assignment write (see handleInteractivity's
// own handleAppHomeOpened call). A reviewer assigned or cleared directly on
// the web board never told Slack anything — the Home tab silently went
// stale until the next manual reopen. This is the pure half of the fix:
// given a card's before/after, who needs their Home tab refreshed because
// `reviewers` changed. Deliberately narrow (reviewers only, not every
// field the dashboard could show — status/title changes reordering the
// Registered list, say) to avoid re-publishing on every unrelated card
// write; can widen later if that's felt as a gap too.
//
// - The submitter, always, when reviewers changed at all — their own
//   Registered row shows the picker's initial_option, which is now stale.
// - Whoever was newly assigned to either role — a card just appeared in
//   their Reviewing section.
// - Whoever was un-assigned (cleared, or replaced by someone else) — a
//   card just disappeared from their Reviewing section.
function homeRefreshTargetsForReviewers(before, after){
  var rvBefore = (before && before.reviewers) || {};
  var rvAfter = (after && after.reviewers) || {};
  if (rvBefore.junior === rvAfter.junior && rvBefore.senior === rvAfter.senior) return [];
  var targets = [rvBefore.junior, rvAfter.junior, rvBefore.senior, rvAfter.senior];
  var submitterEmail = after && after.submittedBy && after.submittedBy.email;
  if (submitterEmail) targets.push(submitterEmail);
  return Array.from(new Set(targets.filter(Boolean)));
}

// Max papers per author (2026-09-14, see ml-conference-cycle — same day,
// briefly a client-side save-blocking gate, reverted per Eduardo: "still
// let people add papers... and notify the author that they've got a
// problem"). This is the pure half: which author emails are newly
// present on this card (in `after` but not `before`) — a brand-new card
// (before === null) counts every one of its authors as new. Only a
// newly-added author is worth checking for going over the venue's cap;
// re-checking every author on every unrelated future edit of a paper
// they're already on would re-notify them for no reason.
function newlyAddedAuthorEmails(before, after){
  var beforeEmails = (before && before.authorEmails) || [];
  var afterEmails = (after && after.authorEmails) || [];
  return afterEmails.filter(function(e){ return beforeEmails.indexOf(e) === -1; });
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
  logger.info('handleAppHomeOpened: start', { slackUserId: slackUserId });
  const email = await emailForSlackId(slackUserId);
  if (!email){
    logger.info('handleAppHomeOpened: no matching email, publishing unrecognized view', { slackUserId: slackUserId });
    const result = await slackFetch(token, 'views.publish', { user_id: slackUserId, view: buildUnrecognizedView() });
    logger.info('handleAppHomeOpened: unrecognized view published', { ok: result.ok });
    return;
  }
  const [people, sections] = await Promise.all([allPeople(), gatherDashboard(email)]);
  const result = await slackFetch(token, 'views.publish', { user_id: slackUserId, view: buildHomeView(email, sections, people) });
  logger.info('handleAppHomeOpened: dashboard view published', { ok: result.ok, error: result.error });
}

// Handles one block_actions Interactivity payload — today only the
// reviewer-picker's external_select (pick) and Clear button (unassign),
// per parseAssignAction's action_id/block_id scheme (see
// reviewerPickerBlock). block_suggestion
// (the live type-ahead) is a different payload type, handled separately
// by handleBlockSuggestion below — it needs a synchronous JSON response,
// not the empty-200-ack shape every block_actions handler uses. Anything
// unrecognized here (a payload shape not matched, a missing card, a
// blocked permission check) is silently ignored rather than surfaced to
// the user — Slack's interactivity payloads have no simple "show an error
// toast" primitive without an extra response_url round trip, and a no-op
// picker click is self-evident (the dropdown just doesn't visibly change)
// rather than actively misleading.
async function handleInteractivity(token, payload){
  if (payload.type !== 'block_actions') return;
  const action = (payload.actions || [])[0];
  if (!action) return;
  const parsed = parseAssignAction(action.action_id, action.block_id);
  if (!parsed) return;
  // 'clear' (the explicit Clear button, see reviewerPickerBlock) always
  // means "unassign", regardless of whatever's on the action payload — a
  // button has no selected_option at all, so reviewerEmailFromAction
  // would wrongly treat it as "not a select action, ignore" otherwise.
  let reviewerEmail;
  if (parsed.verb === 'clear'){
    reviewerEmail = '';
  } else {
    reviewerEmail = reviewerEmailFromAction(action);
    if (reviewerEmail === null) return;
  }

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

// external_select's live search (2026-09-12, replacing the static_select
// that silently truncated at Slack's 100-option cap — see
// reviewerPickerBlock/personOptionsFor). Slack requires this specific
// payload type to get its options back synchronously in the HTTP response
// body itself (`{ options: [...] }`), not the fire-and-forget/empty-ack
// shape every other interactivity payload uses — see the onRequest
// handler's dispatch. Never throws outward; an empty options list on
// error just shows "no matches" in Slack rather than a broken picker.
async function handleBlockSuggestion(payload){
  const people = await allPeople();
  return { options: filterPeopleOptions(people, payload.value) };
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

// Max papers per author — the I/O half (2026-09-14, see
// newlyAddedAuthorEmails' own comment for the design/history). Not a
// save-blocking gate; a DM to whoever's actually over the limit. Needs
// the venue's own `maxPapersPerAuthor` (a board field, not on the card)
// and a real count of that author's non-withdrawn papers on this one
// venue — both genuinely need I/O, which is why this isn't pure the way
// most of this file's decision logic is. Scoped to newly-added authors
// only (see newlyAddedAuthorEmails) so an unrelated later edit to a
// paper someone's already on doesn't re-notify them every time.
async function notifyAuthorsOverCap(token, boardId, before, after){
  const newEmails = newlyAddedAuthorEmails(before, after);
  if (!newEmails.length) return;
  const boardSnap = await db.collection('boards').doc(boardId).get();
  const board = boardSnap.exists ? boardSnap.data() : null;
  const max = board && board.maxPapersPerAuthor;
  if (!max) return;
  const venueLabel = (board && board.label) || boardId;
  const url = venueUrl(boardId);
  for (let i = 0; i < newEmails.length; i++){
    const email = newEmails[i];
    const snap = await db.collection('boards').doc(boardId).collection('cards')
      .where('authorEmails', 'array-contains', email).get();
    const count = snap.docs.filter(function(d){ return d.data().outcome !== 'withdrawn'; }).length;
    if (count > max){
      const headline = '⚠️ You’re now an author on ' + count + ' papers for ' + linkedTitle(venueLabel, url) +
        ' — over its ' + max + '-per-author limit.';
      await sendEvent(token, { emails: [email], headline: headline });
    }
  }
}

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

    // Refresh anyone whose Home tab dashboard is now stale because
    // `reviewers` changed here — see homeRefreshTargetsForReviewers'
    // own comment for why this is scoped to reviewers specifically.
    // Best-effort: one person's refresh failing (no Slack id on file,
    // say) shouldn't block another's, so these run independently rather
    // than aborting the whole loop on the first error.
    const refreshEmails = homeRefreshTargetsForReviewers(before, after);
    for (let i = 0; i < refreshEmails.length; i++){
      const slackId = await slackIdForEmail(refreshEmails[i]);
      if (!slackId) continue;
      try {
        await handleAppHomeOpened(token, slackId);
      } catch (err){
        logger.error('Home tab refresh after card write threw', { email: refreshEmails[i], error: String(err) });
      }
    }

    try {
      await notifyAuthorsOverCap(token, event.params.boardId, before, after);
    } catch (err){
      logger.error('notifyAuthorsOverCap threw', { boardId: event.params.boardId, error: String(err) });
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
    // Temporary diagnostic breadcrumb (2026-09-12) — logged unconditionally,
    // before signature verification, so it's possible to tell "Slack never
    // called this at all" apart from "called it and it silently succeeded"
    // (every other branch below only logs on failure/error). Remove once
    // app_home_opened is confirmed reaching this function in production.
    logger.info('slackEvents: request received', {
      method: req.method,
      contentType: req.get('content-type'),
      hasSignatureHeader: !!req.get('x-slack-signature'),
      hasTimestampHeader: !!req.get('x-slack-request-timestamp')
    });

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
      logger.info('slackEvents: interactivity payload', { type: payload.type });

      // block_suggestion (the reviewer picker's live search, 2026-09-12)
      // is a different contract from every other interactivity payload:
      // Slack wants the matching options back as the actual JSON response
      // body, synchronously — not an empty ack with the real work done
      // asynchronously. Handled first and separately for exactly that
      // reason.
      if (payload.type === 'block_suggestion'){
        try {
          const suggestion = await handleBlockSuggestion(payload);
          res.status(200).json(suggestion);
        } catch (err){
          logger.error('handleBlockSuggestion threw', { error: String(err) });
          res.status(200).json({ options: [] });
        }
        return;
      }

      // Awaited, not fire-and-forget (2026-09-12, fixed a real bug): Cloud
      // Functions v2 (Cloud Run under the hood) can throttle an instance's
      // CPU right after the HTTP response is sent, freezing any async work
      // still in flight — a `res.send()` followed by an un-awaited promise
      // was silently never completing in production (confirmed via the
      // request-received/handler-start logs landing, but views.publish
      // never firing). Slack's own 3-second budget is generous enough for
      // one Firestore write + a views.publish call; there's no automatic
      // retry for interactivity payloads on timeout, so completing before
      // responding is the only way this reliably runs at all.
      try {
        await handleInteractivity(token, payload);
      } catch (err){
        logger.error('handleInteractivity threw', { error: String(err) });
      }
      res.status(200).send('');
      return;
    }

    const body = req.body || {};
    logger.info('slackEvents: events API body', { type: body.type, eventType: body.event && body.event.type });
    if (body.type === 'url_verification'){
      // One-time handshake when the Request URL is first saved in Slack's
      // app config — must echo the challenge back verbatim, synchronously.
      res.status(200).json({ challenge: body.challenge });
      return;
    }
    if (body.type === 'event_callback' && body.event && body.event.type === 'app_home_opened'){
      // Same awaited-before-responding fix as the interactivity branch
      // above. Events API does retry on timeout (unlike interactivity),
      // and re-publishing the same Home view is harmless if Slack ever
      // does retry here, so awaiting first is strictly safer either way.
      try {
        await handleAppHomeOpened(token, body.event.user);
      } catch (err){
        logger.error('handleAppHomeOpened threw', { error: String(err) });
      }
      res.status(200).send('');
      return;
    }
    res.status(200).send('');
  }
);

// Exported for the standalone unit test only (see scratchpad) — not part
// of the public Cloud Functions surface, harmless to export alongside it.
exports._internal = {
  flattenMessages, newMessages, cardEventsToNotify, homeRefreshTargetsForReviewers,
  newlyAddedAuthorEmails, venueUrl, cardUrl, linkedTitle, reviewStateEmoji, verifySlackSignatureRaw,
  canAssignReviewer, parseAssignAction, reviewerEmailFromAction, cardLine, personOptionsFor,
  filterPeopleOptions, initialOptionForEmail, reviewerPickerBlock, sectionBlocks, buildHomeView,
  buildUnrecognizedView
};
