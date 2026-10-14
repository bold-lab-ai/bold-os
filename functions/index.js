// Cloud Functions for bold-d7ff2 — Slack DM notifications on Internal
// Review Board events. See bold-os#1 and docs/FIREBASE.md's
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

const { onDocumentCreated, onDocumentWritten, onDocumentWrittenWithAuthContext } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { beforeUserCreated, HttpsError: IdentityHttpsError } = require('firebase-functions/v2/identity');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const SLACK_BOT_TOKEN = defineSecret('SLACK_BOT_TOKEN');
// App Home + reviewer-assignment (2026-09-12, see bold-os#3) —
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

const APP_BASE_URL = 'https://bold-lab-ai.github.io/bold-os/audit-board.html';

// ---------- who may use BOLD.OS: Slack accounts only ----------
// Membership of the BOLD Slack is what makes someone a lab member, so a session
// counts only if its account has a Slack identity (token.firebase.identities),
// and onlySlackSignUps refuses any new account that isn't a Slack one: GitHub
// (or any other provider) can't be used to sign up, and a GitHub sign-in can
// only reach an account that already has Slack. firestore.rules' isSignedIn()
// and storage.rules check the same. Not the session's sign_in_provider: linking
// GitHub (linkGithub) turns that into github.com for the rest of the session.
const SIGN_IN_PROVIDER = 'oidc.slack';

// The caller's email, if their account is a Slack one; otherwise refuses the call.
function signedInEmail(request){
  const token = request.auth && request.auth.token;
  if (!token || !token.email) throw new HttpsError('unauthenticated', 'Sign in required.');
  const identities = (token.firebase && token.firebase.identities) || {};
  if (!identities[SIGN_IN_PROVIDER]) {
    logger.warn('signedInEmail: refused an account without Slack', {
      provider: token.firebase && token.firebase.sign_in_provider, identities: Object.keys(identities),
    });
    throw new HttpsError('permission-denied', 'Sign in with Slack.');
  }
  return token.email;
}

exports.onlySlackSignUps = beforeUserCreated((event) => {
  const provider = (event.additionalUserInfo && event.additionalUserInfo.providerId) ||
    (event.credential && event.credential.providerId) || '';
  if (provider !== SIGN_IN_PROVIDER) {
    logger.warn('onlySlackSignUps: refused a sign-up', { provider });
    throw new IdentityHttpsError('permission-denied', 'BOLD.OS is for the BOLD Slack: sign in with Slack.');
  }
});

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

// Mirrors audit-board.html's STATUS_LABELS (2026-09-18 pipeline redesign
// — 8 stages, down from 10; draft_review/final_draft/abstract_review/
// pi_polish collapsed into one `abstract` stage — see that file's own
// STATUS_ORDER comment for the full rationale). camera_ready fixed
// 2026-09-18+1 to "Rebuttal Submitted" — a card enters it by submitting
// the rebuttal, not by having submitted camera-ready material yet.
// abstract reverted 2026-09-18+2 to "Abstract in review" — see
// audit-board.html's STATUS_LABELS comment for why this is deliberate.
// paper/arxiv dropped entirely 2026-09-18+3 — collapsed into `rebuttal`
// (renamed "Reviews Out" -> "Rebuttal"), see this session's notes and
// audit-board.html's STATUS_ORDER comment. notifyReviewsOut below is the
// new scheduled function that goes with this change.
const STATUS_LABEL = {
  register: 'Registered',
  pitch: 'Pitched',
  abstract: 'Abstract in review',
  rebuttal: 'Rebuttal',
  camera_ready: 'Rebuttal Submitted',
  conference: 'Accepted'
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
// (2026-09-12, see bold-os#3, "Personal papers dashboard in
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

// Mirrors firebase/firestore.rules' cards/{cardId} reviewer-reassignment condition
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
    // 2026-09-18: no more auto-advance on checklist completion (the
    // pipeline redesign collapsed draft_review/final_draft into one
    // `abstract` stage — see audit-board.html's STATUS_ORDER comment).
    // Completing both checklists just unblocks Submit paper now, doesn't
    // move the card — so this says that instead of claiming a move
    // happened that no longer does.
    var justApproved = after.jrReviewState === 'approved' && after.srReviewState === 'approved' &&
      !(before.jrReviewState === 'approved' && before.srReviewState === 'approved');
    if (after.status === 'abstract' && justApproved){
      reviewHeadline += ' Both reviewers approved — ready to submit the paper.';
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

  // Removed 2026-09-18: the "reaches PI-approval step" notification this
  // used to be — a separate pi_polish status doesn't exist any more (see
  // audit-board.html's STATUS_ORDER comment: PI approval is now just the
  // senior-reviewer checklist, since senior defaults to the PI). The real
  // event this was trying to catch — "the PI needs to go look at this" —
  // is already covered above, the moment they're assigned as senior
  // reviewer (🔍 "You've been assigned as Senior reviewer").

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

// Max papers per author (2026-09-14, see bold-os — same day,
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

// The pure half of notifyReviewsOut (2026-09-18+3, per Eduardo) — the
// first real time-driven transition in this pipeline, everything else
// here reacts to a write or an HTTP request. `boardsWithCards`: one entry
// per board that might have something to flag, each `{ id, label,
// reviewsPublicDate, cards: [...] }` where `cards` is every card under it
// currently at `rebuttal` (the caller narrows to that status before
// calling, since Firestore can't join a board-level date filter against a
// subcollection query in one pass — see the I/O wrapper below). A card is
// a candidate once the venue's own reviews-release date has passed AND it
// hasn't been notified yet — `reviewsOutNotifiedAt` is checked falsy, not
// `== null`, so an older card that predates this field (undefined, not
// null) still qualifies, matching audit-board.html's own convention for
// every optional field. Returns `{ boardId, card }` pairs, oldest venue
// deadline first, so a backlog (the function was down a while) still
// sends in a sane order.
function reviewsOutCandidates(boardsWithCards, todayIso){
  var out = [];
  (boardsWithCards || []).slice()
    .filter(function(b){ return b && b.reviewsPublicDate && b.reviewsPublicDate <= todayIso; })
    .sort(function(a, b){ return a.reviewsPublicDate < b.reviewsPublicDate ? -1 : 1; })
    .forEach(function(b){
      (b.cards || []).forEach(function(c){
        if (c && c.status === 'rebuttal' && !c.reviewsOutNotifiedAt){
          out.push({ boardId: b.id, card: c });
        }
      });
    });
  return out;
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
// overrides already in firebase/firestore.indexes.json (an equality filter plus an
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
// (see firebase/firestore.indexes.json's fieldOverrides) — submitted, reviewing as
// junior/senior, and authoring (via the denormalized authorEmails, see
// audit-board.html's authorEmailsOf). Capped to the 10 most recently
// updated per bucket (topRecent) before boardLabelsFor/toItems ever run,
// so a prolific person's history doesn't blow out the Block Kit view.
async function gatherDashboard(email, cap){
  const limit = cap || 10;
  const [registeredSnap, juniorSnap, seniorSnap, authoringSnap] = await Promise.all([
    db.collectionGroup('cards').where('submittedBy.email', '==', email).get(),
    db.collectionGroup('cards').where('reviewers.junior', '==', email).get(),
    db.collectionGroup('cards').where('reviewers.senior', '==', email).get(),
    db.collectionGroup('cards').where('authorEmails', 'array-contains', email).get()
  ]);
  const capped = [registeredSnap, juniorSnap, seniorSnap, authoringSnap].map(function(s){ return topRecent(s, limit); });
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

// ---------- Suggested changes to a guide or the BOLDiquette ----------
// Everyone, PIs and admins too, changes a guide (guides/{slug}) or the
// BOLDiquette (handbook/{slug}) by proposing it (…/proposals/{id}, see
// pages/guide.js); another PI or admin accepts or declines it on the page
// (decideProposal). Tell them all, but whoever proposed it, when one arrives,
// with a link to it.

const SITE_URL = APP_BASE_URL.replace(/[^/]*$/, '');

// Slack mrkdwn treats &, < and > as markup.
function slackText(s){
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// What a proposal does, in words: pure, so it's testable on its own.
function proposalSummary(q){
  const title = (side) => '“' + slackText((side && side.title) || '') + '”';
  if (q.kind === 'about') return 'a change to the title and description';
  if (q.kind === 'add') return 'a new part, ' + title(q.after);
  if (q.kind === 'remove') return 'removing the part ' + title(q.before);
  if (q.kind === 'move') return 'moving the part ' + title(q.before);
  if (q.kind === 'restore') return 'restoring an earlier version';
  return 'a change to the part ' + title(q.before || q.after);
}

function onProposed(collection, pageUrl){
  return onDocumentCreated(
    { document: collection + '/{slug}/proposals/{id}', secrets: [SLACK_BOT_TOKEN] },
    async function(event){
      const q = event.data && event.data.data();
      if (!q || q.status !== 'open') return;
      const doc = await db.collection(collection).doc(event.params.slug).get();
      const name = (doc.exists && doc.data().title) || event.params.slug;
      const who = (q.by && (q.by.name || q.by.email)) || 'Someone';
      const headline = '🔔 ' + slackText(who) + ' suggested ' + proposalSummary(q) + ' in ' +
        linkedTitle(slackText(name), pageUrl(event.params.slug) + '#proposals') +
        (q.note ? ': “' + slackText(String(q.note).slice(0, 300)) + '”' : '') +
        '. It needs a PI or admin to accept or decline it.';
      const pis = await rolesEmails('pis');
      const admins = await rolesEmails('admins');
      await sendEvent(SLACK_BOT_TOKEN.value(), {
        emails: pis.concat(admins),
        excludeEmail: q.by && q.by.email,
        headline: headline
      });
    }
  );
}

// What became of a proposal, once it's no longer open: accepted or declined
// (decideProposal), or withdrawn (deleted while open). Whoever proposed it
// hears it was decided; the PIs and admins, but whoever decided it, hear
// either, so a "needs a decision" message isn't left standing.
// Pure, so it's testable on its own. → { proposer, others } headlines, or null.
function proposalOutcome(before, after, name, url){
  if (!before || before.status !== 'open') return null;
  const who = (before.by && (before.by.name || before.by.email)) || 'Someone';
  const what = proposalSummary(before) + ' in ' + linkedTitle(slackText(name), url);
  if (!after) return { others: '↩️ ' + slackText(who) + ' withdrew ' + what + '. Nothing to decide.' };
  if (after.status !== 'accepted' && after.status !== 'declined') return null;
  const decider = slackText(after.decidedByName || after.decidedBy || 'A PI or admin');
  const icon = after.status === 'accepted' ? '✅ ' : '✖️ ';
  return {
    proposer: icon + decider + ' ' + after.status + ' your suggestion, ' + what + '.',
    others: icon + decider + ' ' + after.status + ' ' + slackText(who) + '’s suggestion, ' + what + '.',
  };
}

function onProposalDecided(collection, pageUrl){
  return onDocumentWritten(
    { document: collection + '/{slug}/proposals/{id}', secrets: [SLACK_BOT_TOKEN] },
    async function(event){
      const before = event.data.before.exists ? event.data.before.data() : null;
      const after = event.data.after.exists ? event.data.after.data() : null;
      const doc = await db.collection(collection).doc(event.params.slug).get();
      // Deleted with its guide: nothing to tell.
      if (!doc.exists) return;
      const out = proposalOutcome(before, after, doc.data().title || event.params.slug, pageUrl(event.params.slug));
      if (!out) return;
      const token = SLACK_BOT_TOKEN.value();
      const proposer = before.by && before.by.email ? String(before.by.email).toLowerCase() : '';
      const decider = after && after.decidedBy ? String(after.decidedBy).toLowerCase() : '';
      const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'))
        .map((e) => String(e).toLowerCase()).filter((e) => e !== proposer && e !== decider);
      const jobs = [sendEvent(token, { emails: staff, headline: out.others })];
      if (out.proposer && proposer) jobs.push(sendEvent(token, { emails: [proposer], headline: out.proposer }));
      await Promise.all(jobs);
    }
  );
}

const guideUrl = (slug) => SITE_URL + 'guide.html?guide=' + encodeURIComponent(slug);
// The BOLDiquette is the one handbook document; it has its own page.
const handbookUrl = (slug) => SITE_URL + (slug === 'boldiquette' ? 'boldiquette.html' : 'index.html');
exports.onGuideProposed = onProposed('guides', guideUrl);
exports.onHandbookProposed = onProposed('handbook', handbookUrl);
exports.onGuideProposalDecided = onProposalDecided('guides', guideUrl);
exports.onHandbookProposalDecided = onProposalDecided('handbook', handbookUrl);

// ---------- Deciding a suggested change to a guide or the BOLDiquette ----------
// A guide (guides/{slug}) or the BOLDiquette (handbook/{slug}) changes only by
// an accepted proposal, a PI's or admin's own included: clients can't change
// their content (firestore.rules), so a PI or admin who didn't propose the
// change accepts or declines it here.
// data: { collection: 'guides' | 'handbook', slug, id, accept: bool } → { status }.

const REVIEWED = ['guides', 'handbook'];

// The document with proposal q applied: pure, so it's testable on its own. → { title, description, parts } changed.
function appliedProposal(doc, q){
  const parts = (doc.parts || []).map((p) => Object.assign({}, p));
  const after = q.after || {};
  if (q.kind === 'about') return { title: String(after.title || ''), description: String(after.description || '') };
  if (q.kind === 'restore') return { title: String(after.title || ''), description: String(after.description || ''), parts: after.parts || [] };
  if (q.kind === 'add') {
    // At the end of its section, if it names one that's there; else at the end.
    const part = Object.assign({ id: q.partId }, after);
    let at = -1;
    parts.forEach((p, i) => { if (part.section && p.section === part.section) at = i; });
    if (at === -1) parts.push(part); else parts.splice(at + 1, 0, part);
    return { parts };
  }
  if (q.kind === 'remove') return { parts: parts.filter((p) => p.id !== q.partId) };
  if (q.kind === 'edit') {
    const p = parts.find((x) => x.id === q.partId);
    if (!p) throw new HttpsError('failed-precondition', 'That part has since been removed.');
    Object.assign(p, after);
    return { parts };
  }
  if (q.kind === 'move') {
    // The proposed order; parts added since keep their place after it.
    const order = Array.isArray(after.order) ? after.order : [];
    const byId = {};
    parts.forEach((p) => { byId[p.id] = p; });
    const moved = order.filter((id) => byId[id]).map((id) => byId[id]);
    return { parts: moved.concat(parts.filter((p) => order.indexOf(p.id) === -1)) };
  }
  throw new HttpsError('invalid-argument', 'Unknown kind of change.');
}

exports.decideProposal = onCall(
  async (request) => {
    const email = signedInEmail(request).toLowerCase();
    const data = request.data || {};
    if (REVIEWED.indexOf(data.collection) === -1 || !/^[a-z0-9-]{1,60}$/.test(String(data.slug || '')) || !/^[A-Za-z0-9]{1,40}$/.test(String(data.id || ''))) {
      throw new HttpsError('invalid-argument', 'No such proposal.');
    }
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins can do this.');
    const name = request.auth.token.name || '';
    const ref = db.collection(data.collection).doc(data.slug);
    const qRef = ref.collection('proposals').doc(data.id);
    return db.runTransaction(async (tx) => {
      const [snap, qSnap] = await Promise.all([tx.get(ref), tx.get(qRef)]);
      if (!snap.exists || !qSnap.exists) throw new HttpsError('not-found', 'No such proposal.');
      const q = qSnap.data();
      if (q.status !== 'open') throw new HttpsError('failed-precondition', 'It has already been decided.');
      const by = q.by && q.by.email ? String(q.by.email).toLowerCase() : '';
      if (by === email) throw new HttpsError('permission-denied', 'Another PI or admin reviews your own change.');
      const now = Date.now();
      if (data.accept) {
        const who = (q.by && (q.by.name || q.by.email)) || '';
        tx.update(ref, Object.assign(appliedProposal(snap.data(), q), {
          changeNote: String(q.note || ('Proposed by ' + who)).slice(0, 300),
          updatedAt: now, updatedBy: email, proposedBy: by,
        }));
      }
      const status = data.accept ? 'accepted' : 'declined';
      tx.update(qRef, { status, decidedBy: email, decidedByName: name, decidedAt: now });
      return { status };
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

// ---------- 5. Reviews-out auto-transition (scheduled) ----------
// The one thing in this whole pipeline that isn't a deliberate human
// click (2026-09-18+3, per Eduardo) — everything else, this function
// included, only ever reacts to a write or an HTTP request nobody has to
// poll for. A card lands in `rebuttal` the moment "Submit paper" is
// clicked (see audit-board.html's STATUS_ORDER comment) showing a
// "Waiting for reviews" badge; this runs on a timer, finds any card whose
// venue's own reviews-release date has passed, and is the one thing that
// flips the badge to "In Rebuttal" and DMs the submitter — nobody has to
// notice and click anything for that to happen.
//
// `Date.now()`'s London-local date, not UTC's — venue dates are entered
// as bare YYYY-MM-DD with no time zone of their own (same convention as
// audit-board.html's deadline handling), so "today" has to mean the same
// calendar day a person in the lab would call today.
function todayIsoLondon(){
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

exports.notifyReviewsOut = onSchedule(
  // Once a day at London midnight (2026-09-18+3, down from hourly, per
  // Eduardo — hourly was overkill for a date-only deadline with no time
  // of day of its own). Crontab, not the human-readable "every N" form,
  // specifically so it's pinned to a real wall-clock instant (midnight)
  // rather than just some interval from whenever it was last deployed —
  // timeZone matches todayIsoLondon()'s own below.
  { schedule: '0 0 * * *', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] },
  async function(){
    const token = SLACK_BOT_TOKEN.value();
    const todayIso = todayIsoLondon();

    // Boards and cards are separate collection levels — Firestore can't
    // filter one query on both a board's reviewsPublicDate and its cards'
    // status/reviewsOutNotifiedAt at once, so this is two passes: find
    // candidate boards first (cheap, few of them), then only fetch cards
    // for those. Status filtered server-side; reviewsOutNotifiedAt
    // filtered in reviewsOutCandidates itself (falsy, not `== null` — see
    // its own comment for why that matters for older cards).
    const boardsSnap = await db.collection('boards')
      .where('reviewsPublicDate', '<=', todayIso).get();
    const boardsWithCards = await Promise.all(boardsSnap.docs.map(async function(boardDoc){
      const cardsSnap = await db.collection('boards').doc(boardDoc.id).collection('cards')
        .where('status', '==', 'rebuttal').get();
      return {
        id: boardDoc.id,
        label: boardDoc.data().label,
        reviewsPublicDate: boardDoc.data().reviewsPublicDate,
        cards: cardsSnap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
      };
    }));

    const candidates = reviewsOutCandidates(boardsWithCards, todayIso);
    for (let i = 0; i < candidates.length; i++){
      const boardId = candidates[i].boardId;
      const card = candidates[i].card;
      try {
        await db.collection('boards').doc(boardId).collection('cards').doc(card.id)
          .update({ reviewsOutNotifiedAt: Date.now(), updatedAt: Date.now() });
        const submitterEmail = card.submittedBy && card.submittedBy.email;
        if (submitterEmail){
          const headline = '📢 ' + linkedTitle(card.title || 'a paper', cardUrl(boardId, card.id)) +
            ' — reviews are out. Time to start the rebuttal.';
          await dmByEmail(token, submitterEmail, headline);
        }
      } catch (err){
        logger.error('notifyReviewsOut failed for one card', { boardId: boardId, cardId: card.id, error: String(err) });
      }
    }
  }
);

// ---------- 6. Slack App Home + reviewer assignment ----------
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

// ---------- Profile page: the caller's own Slack profile fields ----------
// profile.html (2026-09-19) shows institution / role / supervisor /
// research interests / start date, which live as custom fields on each
// person's Slack profile — not in the OIDC claims and not in the `people`
// roster (name/email/slackId only). Read live from users.profile.get
// (needs the `users:read` + `users.profile:read` bot scopes; add and
// Reinstall to Workspace) rather than copied into Firestore, so Slack stays
// the one place people edit them. Returns only the *caller's* fields — the
// Slack id comes from their own verified sign-in email, never from the
// request.

// Display order for the fields we know we want; anything else the workspace
// defines follows in the order Slack returned it.
const PROFILE_FIELD_ORDER = [
  /institution|affiliation|university|organi[sz]ation/i,
  /role|position/i,
  /supervisor|advisor|adviser/i,
  /interest/i,
  /start/i
];

// Pure: users.profile.get's `profile` (fetched with include_labels) →
// [{ label, value }], empty values dropped, Slack's `title` first.
function profileFieldsFromSlack(profile){
  const out = [];
  if (!profile) return out;
  if (profile.title) out.push({ label: 'Title', value: String(profile.title) });
  const custom = Object.keys(profile.fields || {})
    .map((id, i) => ({ i, label: profile.fields[id].label, value: profile.fields[id].value }))
    .filter(f => f.label && f.value);
  const rank = f => {
    const r = PROFILE_FIELD_ORDER.findIndex(re => re.test(f.label));
    return r === -1 ? PROFILE_FIELD_ORDER.length : r;
  };
  custom.sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  custom.forEach(f => out.push({ label: String(f.label), value: String(f.value) }));
  return out;
}

// Whether the caller is a PI or admin (firestore.rules' hasFullWrite). Clients can't
// read `roles`, so a page asks here which controls to enable; the rules still decide
// what is actually allowed.
exports.getMyAccess = onCall(
  async (request) => {
    const email = signedInEmail(request);
    const [pis, admins] = await Promise.all([rolesEmails('pis'), rolesEmails('admins')]);
    return { fullWrite: pis.indexOf(email) !== -1 || admins.indexOf(email) !== -1 };
  }
);

exports.getMyProfile = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    const slackId = await slackIdForEmail(email);
    if (!slackId) return { fields: [] };
    const url = 'https://slack.com/api/users.profile.get?' +
      new URLSearchParams({ user: slackId, include_labels: 'true' });
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN.value() } });
    const json = await res.json();
    if (!json.ok) {
      logger.warn('users.profile.get failed', { error: json.error });
      throw new HttpsError('unavailable', 'Could not read Slack profile.');
    }
    // Their Slack account, for profile.html's Linked accounts: the handle and
    // their profile in the workspace (the workspace's address from auth.test).
    const auth = await slackAuthInfo(SLACK_BOT_TOKEN.value());
    const p = json.profile || {};
    const slack = { handle: p.display_name || p.real_name || '', url: auth && auth.url ? auth.url + 'team/' + slackId : '' };
    return { fields: profileFieldsFromSlack(json.profile), slack };
  }
);

// ---------- Profile page: the caller's projects ----------
// profile.html's Projects section — the caller's papers on the Internal
// Review Board, split by relationship: Owner (submittedBy, i.e. registered
// it), Author (in `authors`, via the denormalized authorEmails) and
// Reviewer (assigned junior or senior). Same four collection-group queries
// as the Slack App Home (gatherDashboard) — run here with the Admin SDK
// because firebase/firestore.rules has no collection-group rule for `cards`. A
// paper can appear under more than one heading. Keyed by the caller's own
// verified sign-in email, never a request parameter.
const PROFILE_PROJECTS_CAP = 50;

// The board's own card-detail badges (audit-board/detail.js), minus
// "overdue" — that one depends on the venue's deadlines and Rush-mode
// cutoffs (audit-board/schedule.js), so it isn't ported. Hand-kept in sync
// with audit-board/core.js (STATUS_LABELS, OUTCOME_LABELS) and
// audit-board/board.js (reviewFilterState, reviewStateBadgeHtml,
// rebuttalBadgeHtml). Each badge is { kind, label }; `kind` is the suffix
// of the board's own `badge-<kind>` class.
const BOARD_STAGE_LABEL = {
  register: 'Registered', pitch: 'Pitched', abstract: 'Abstract', paper: 'Paper',
  rebuttal: 'Rebuttal', camera_ready: 'Rebuttal Submitted', conference: 'Accepted'
};
const BOARD_REVIEW_BADGE = { in_review: 'In review', changes_requested: 'Changes requested', approved: 'Approved' };
const BOARD_OUTCOME_LABEL = { accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };

function badgesForCard(card){
  const badges = [];
  if (!card) return badges;
  if (BOARD_STAGE_LABEL[card.status]) badges.push({ kind: 'stage', label: BOARD_STAGE_LABEL[card.status] });
  const review = function(v){
    const k = BOARD_REVIEW_BADGE[v] ? v : 'in_review';
    badges.push({ kind: 'review-' + k, label: BOARD_REVIEW_BADGE[k] });
  };
  if (card.status === 'abstract') review(card.abstractReviewState || 'in_review');
  if (card.status === 'paper') {
    const jr = card.jrReviewState, sr = card.srReviewState;
    review(jr === 'changes_requested' || sr === 'changes_requested' ? 'changes_requested'
      : jr === 'approved' && sr === 'approved' ? 'approved' : 'in_review');
  }
  if (card.status === 'rebuttal') {
    if (card.rebuttalDocLink) badges.push({ kind: 'rebuttal-sent', label: 'Rebuttal sent' });
    else if (card.reviewsOutNotifiedAt) badges.push({ kind: 'rebuttal-writing', label: 'In Rebuttal' });
    else badges.push({ kind: 'rebuttal-waiting', label: 'Waiting for reviews' });
  }
  if (BOARD_OUTCOME_LABEL[card.outcome] && !(card.outcome === 'accepted' && card.status === 'conference')) {
    badges.push({ kind: 'outcome-' + card.outcome, label: BOARD_OUTCOME_LABEL[card.outcome] });
  }
  return badges;
}

// Pure: gatherDashboard()'s sections → the profile page's three lists.
function projectsFromDashboard(sections){
  const item = function(i, role){
    const out = { boardId: i.boardId, boardLabel: i.boardLabel, cardId: i.cardId, title: i.title, badges: badgesForCard(i.card) };
    if (role) out.role = role;
    return out;
  };
  const reviewer = [];
  const seen = {};
  sections.reviewingJunior.forEach(function(i){ seen[i.cardId] = reviewer.push(item(i, 'Junior')) - 1; });
  sections.reviewingSenior.forEach(function(i){
    if (i.cardId in seen) reviewer[seen[i.cardId]].role = 'Junior & Senior';
    else reviewer.push(item(i, 'Senior'));
  });
  return {
    owner: sections.registered.map(function(i){ return item(i); }),
    author: sections.authoring.map(function(i){ return item(i); }),
    reviewer: reviewer
  };
}

exports.getMyProjects = onCall(
  async (request) => {
    const email = signedInEmail(request);
    return projectsFromDashboard(await gatherDashboard(email, PROFILE_PROJECTS_CAP));
  }
);

// Which of the Projects page's three groups a card belongs to. Completed =
// accepted at a venue (the last column, or the outcome Accepted), or marked
// completed on its project page (`completed`: its workspace's completedAt);
// Planned = not yet drafted (Registered/Pitched); Ongoing = the rest, a rejected
// or withdrawn paper included: the project goes on.
function projectGroupForCard(card, completed){
  if (completed || card.status === 'conference' || card.outcome === 'accepted') return 'completed';
  if (card.status === 'register' || card.status === 'pitch') return 'planned';
  return 'ongoing';
}

// Pure: every card → the Projects page's three lists, most recently updated
// first. `boards` is [{ id, label, status }], `cards` is [{ boardId, id, data }]
// (a card in a pending venue is skipped) and `unassigned` is [{ id, data }] —
// projects registered without a venue yet (top-level `projects` collection).
// Both are cards in the same shape (src/assets/js/card-model.js); the only
// difference is that an unassigned one has no board, so no boardId/link.
// `completedIds`: cards marked completed on their project page (workspaces' completedAt).
function allProjectsFromCards(boards, cards, unassigned, completedIds){
  const done = new Set(completedIds || []);
  const labels = {};
  boards.forEach(function(b){ if (b.status !== 'pending') labels[b.id] = b.label || b.id; });
  const entries = [];
  const base = function(id, d){
    return {
      title: d.title || 'Untitled',
      abstract: d.abstractText || '',
      slackChannel: d.slackChannel || '',
      keywords: Array.isArray(d.keywords) ? d.keywords : [],
      owner: (d.submittedBy && d.submittedBy.name) || '',
      ownerEmail: (d.submittedBy && d.submittedBy.email) || '',
      authors: (Array.isArray(d.authors) ? d.authors : []).map(function(a){ return { name: (a && a.name) || '', email: (a && a.email) || '' }; }),
      badges: badgesForCard(d)
    };
  };
  cards.forEach(function(c){
    if (!(c.boardId in labels)) return;
    entries.push({ pid: projectIdOf(c.data, c.id), d: c.data, item: Object.assign(base(c.id, c.data), { boardId: c.boardId, boardLabel: labels[c.boardId], cardId: c.id }) });
  });
  (unassigned || []).forEach(function(u){
    entries.push({ pid: projectIdOf(u.data, u.id), d: u.data, item: Object.assign(base(u.id, u.data), { projectId: u.id }) });
  });
  // One row per project: its latest card, with how many venues came before.
  const byProject = {};
  entries.forEach(function(e){ (byProject[e.pid] = byProject[e.pid] || []).push(e); });
  const rows = Object.keys(byProject).map(function(pid){
    const list = byProject[pid].sort(function(a, b){ return (a.d.createdAt || 0) - (b.d.createdAt || 0); });
    const last = list[list.length - 1];
    if (list.length > 1) last.item.earlier = list.length - 1;
    last.item.pid = pid;
    return { group: projectGroupForCards(list.map(function(e){ return e.d; }), done.has(pid)), updatedAt: Math.max.apply(null, list.map(function(e){ return e.d.updatedAt || 0; })), item: last.item };
  });
  const out = { ongoing: [], completed: [], planned: [] };
  rows
    .sort(function(a, b){ return b.updatedAt - a.updatedAt; })
    .forEach(function(r){ out[r.group].push(r.item); });
  return out;
}

// Every paper ever registered on the Internal Review Board (plus projects not yet
// on a venue), for the Projects page. Any signed-in lab member may read every card (see firestore.rules), so
// this is no wider than what the board itself shows; it's a function only
// because the rules have no collection-group rule for `cards`.
// Slack channel name ("#proj-x") → link that opens it in Slack, for the channels the bot
// can see (public, or private with the bot in them). Best effort: {} if Slack can't be
// reached, so the Projects list still loads, just without the links.
async function slackLinksFor(names){
  const out = {};
  try {
    const token = SLACK_BOT_TOKEN.value();
    for (const name of names){
      const id = await slackChannelId(token, name.replace(/^#/, ''));
      if (id) out[name] = await slackChannelUrl(token, id);
    }
  } catch (err) {
    logger.warn('Slack channel links skipped', { error: err && err.message });
  }
  return out;
}

exports.getAllProjects = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    const [boardsSnap, cardsSnap, unassignedSnap, doneSnap] = await Promise.all([
      db.collection('boards').get(),
      db.collectionGroup('cards').get(),
      db.collection('projects').get(),
      db.collection('projectWorkspaces').where('completedAt', '>', 0).get()
    ]);
    const groups = allProjectsFromCards(
      boardsSnap.docs.map(function(d){ return { id: d.id, label: d.data().label, status: d.data().status || 'approved' }; }),
      cardsSnap.docs.map(function(d){ return { boardId: d.ref.parent.parent.id, id: d.id, data: d.data() }; }),
      unassignedSnap.docs.map(function(d){ return { id: d.id, data: d.data() }; }),
      doneSnap.docs.map(function(d){ return d.id; })
    );
    const items = groups.ongoing.concat(groups.completed, groups.planned);
    const links = await slackLinksFor(Array.from(new Set(items.map(function(i){ return i.slackChannel; }).filter(Boolean))));
    items.forEach(function(i){ if (links[i.slackChannel]) i.slackUrl = links[i.slackChannel]; });
    return groups;
  }
);

// ---------- Projects page: keyword suggestions ----------
// Pure: every card's `keywords` → [{ name, count }], most used first (then
// alphabetical) — what the registration form suggests as you type.
function keywordCounts(cardDatas){
  const counts = {};
  cardDatas.forEach(function(d){
    (Array.isArray(d && d.keywords) ? d.keywords : []).forEach(function(k){
      if (typeof k === 'string' && k) counts[k] = (counts[k] || 0) + 1;
    });
  });
  return Object.keys(counts)
    .map(function(name){ return { name: name, count: counts[name] }; })
    .sort(function(a, b){ return b.count - a.count || a.name.localeCompare(b.name); });
}

exports.getProjectKeywords = onCall(
  async (request) => {
    const email = signedInEmail(request);
    const [cardsSnap, projectsSnap] = await Promise.all([
      db.collectionGroup('cards').get(),
      db.collection('projects').get()
    ]);
    return { keywords: keywordCounts(cardsSnap.docs.concat(projectsSnap.docs).map(function(d){ return d.data(); })) };
  }
);

// ---------- Projects page: the project's Slack channel ----------
// Registering a project names a Slack channel for it. Rules (see the register
// form, which states them): a name that doesn't start with "proj-" gets the
// prefix added; a channel that already exists is left alone; one that doesn't
// is created (private) and the submitter is invited. Needs the bot scopes
// `channels:read` + `groups:read` (look it up), `channels:manage` +
// `groups:write` (create, invite) — add them and Reinstall to Workspace. The submitter is the caller's
// own verified email → Slack id via the `people` roster, never a parameter.

const PROJECT_CHANNEL_PREFIX = 'proj-';

// Pure: whatever was typed → { name, prefixed } (name without '#', lowercase,
// always starting with "proj-"; `prefixed` = the prefix had to be added) or
// { error }. Hand-kept in sync with normalizeProjectChannel() in
// src/assets/js/card-model.js, which the form uses for its live hint.
function normalizeProjectChannel(input){
  let name = String(input || '').trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
  if (!name) return { error: 'Enter a channel name.' };
  if (!/^[a-z0-9_-]+$/.test(name)) return { error: 'Use letters, numbers, hyphens and underscores only.' };
  const prefixed = name.indexOf(PROJECT_CHANNEL_PREFIX) !== 0;
  if (prefixed) name = PROJECT_CHANNEL_PREFIX + name;
  if (name === PROJECT_CHANNEL_PREFIX) return { error: 'Add a name after proj-.' };
  if (name.length > 80) return { error: 'Slack channel names can be at most 80 characters.' };
  return { name, prefixed };
}

// Channel name → id, cached briefly (a form check per pause in typing
// shouldn't page through the whole workspace each time). Private channels are
// listed too when the app has `groups:read` — but Slack only returns the ones the
// bot is a member of, so a private channel it hasn't been invited to still isn't
// found (create then says `name_taken`, which is treated as "exists", with no id
// to link to). Without `groups:read`, only public channels are listed.
let channelNamesCache = null;
async function listSlackChannels(token, types){
  const names = new Map();
  let cursor = '';
  do {
    const params = { types, exclude_archived: 'true', limit: '1000' };
    if (cursor) params.cursor = cursor;
    const res = await fetch('https://slack.com/api/conversations.list?' + new URLSearchParams(params),
      { headers: { 'Authorization': 'Bearer ' + token } });
    const json = await res.json();
    if (!json.ok) throw Object.assign(new Error(json.error), { slackError: json });
    (json.channels || []).forEach(function(c){ names.set(c.name, c.id); });
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);
  return names;
}

async function slackChannelId(token, name){
  if (!channelNamesCache || Date.now() - channelNamesCache.t > 30 * 1000){
    let names;
    try {
      try {
        names = await listSlackChannels(token, 'public_channel,private_channel');
      } catch (err){
        if (!err.slackError || err.slackError.error !== 'missing_scope') throw err;
        logger.warn('Slack app lacks groups:read \u2014 private channels are not looked up');
        names = await listSlackChannels(token, 'public_channel');
      }
    } catch (err){
      if (err.slackError) throw slackChannelError(err.slackError.error, err.slackError);
      throw err;
    }
    channelNamesCache = { t: Date.now(), names };
  }
  return channelNamesCache.names.get(name) || null;
}

// The workspace's team id (for a link that opens a channel in Slack's web client)
// and the bot's own name (for telling people whom to invite), from auth.test.
let slackAuthCache = null;
async function slackAuthInfo(token){
  if (!slackAuthCache){
    const auth = await slackFetch(token, 'auth.test', {});
    if (!auth.ok) return null;
    slackAuthCache = { teamId: auth.team_id, bot: auth.user, url: auth.url || '' };
  }
  return slackAuthCache;
}
async function slackChannelUrl(token, channelId){
  const auth = await slackAuthInfo(token);
  return auth ? 'https://app.slack.com/client/' + auth.teamId + '/' + channelId : '';
}

function slackChannelError(code, json){
  logger.warn('Slack channel call failed', { error: code, needed: json && json.needed, provided: json && json.provided });
  return new HttpsError('failed-precondition', code === 'missing_scope'
    ? 'The Slack app can\u2019t manage channels yet \u2014 ask an admin to add its channel permissions.'
    : 'Slack said no (' + code + ').');
}

// mode 'check' (default): { name, prefixed, exists, url } — nothing is changed;
// `url` opens the channel in Slack (only when the bot can see it: public, or
// private with the bot in it). When it can't see it, `bot` is the bot's name
// ("@name"): either the channel doesn't exist, or it's a private one the bot
// needs inviting to (only a member can do that) before the project page can link it.
// mode 'ensure': also creates the channel if it doesn't exist — private, so the
// bot (its creator, hence a member) can always link it — and invites the caller:
// { name, prefixed, exists, created, invited, url }. Registering a project
// calls 'ensure'; the form calls 'check' as you type, and a project's page
// calls it to link its channel.
exports.projectChannel = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    const data = request.data || {};
    const n = normalizeProjectChannel(data.name);
    if (n.error) throw new HttpsError('invalid-argument', n.error);
    const token = SLACK_BOT_TOKEN.value();
    const existingId = await slackChannelId(token, n.name);
    const out = { name: n.name, prefixed: n.prefixed, exists: !!existingId };
    if (existingId) out.url = await slackChannelUrl(token, existingId);
    else {
      const auth = await slackAuthInfo(token);
      if (auth && auth.bot) out.bot = '@' + auth.bot;
    }
    if (out.exists || data.mode !== 'ensure') return out;

    const created = await slackFetch(token, 'conversations.create', { name: n.name, is_private: true });
    channelNamesCache = null;
    if (!created.ok){
      if (created.error === 'name_taken') return Object.assign(out, { exists: true });
      throw slackChannelError(created.error);
    }
    out.created = true;
    out.invited = false;
    out.url = await slackChannelUrl(token, created.channel.id);
    const slackId = await slackIdForEmail(email);
    if (slackId){
      const invited = await slackFetch(token, 'conversations.invite', { channel: created.channel.id, users: slackId });
      out.invited = !!invited.ok;
    } else {
      logger.info('No Slack id for the submitter \u2014 channel created, nobody invited', { email });
    }
    return out;
  }
);

// The "Join the project" button: invites the caller (their own verified email →
// Slack id via the `people` roster, never a parameter) to a project's channel.
// Only channels named by a registered project can be joined, so this can't be
// used to get into any other proj- channel. Needs the bot scope
// `channels:manage` + `groups:write` (invite), as projectChannel does; the bot
// must be a member of a private channel to invite into it (channels it created
// are). Returns { status: 'joined' | 'already', url }.
async function isRegisteredProjectChannel(name){
  const tag = '#' + name;
  const [cardsSnap, projectsSnap] = await Promise.all([db.collectionGroup('cards').get(), db.collection('projects').get()]);
  return cardsSnap.docs.concat(projectsSnap.docs).some(function(d){
    const c = d.data().slackChannel;
    return typeof c === 'string' && c.toLowerCase() === tag;
  });
}

// Invites `email` to the project channel `name` (normalized, without '#').
// → { status: 'joined' | 'already', url }; throws an HttpsError a page can show.
async function inviteToProjectChannel(token, email, name){
  const slackId = await slackIdForEmail(email);
  if (!slackId) throw new HttpsError('failed-precondition', 'Your Slack account isn’t linked to this site yet.');
  const channelId = await slackChannelId(token, name);
  if (!channelId){
    const auth = await slackAuthInfo(token);
    throw new HttpsError('failed-precondition', 'The bot can’t see #' + name + (auth && auth.bot ? ' — invite @' + auth.bot + ' to it first.' : '.'));
  }
  let res = await slackFetch(token, 'conversations.invite', { channel: channelId, users: slackId });
  if (!res.ok && res.error === 'not_in_channel'){
    // A public channel the bot isn't in yet: join it (channels:join), then retry once.
    await slackFetch(token, 'conversations.join', { channel: channelId });
    res = await slackFetch(token, 'conversations.invite', { channel: channelId, users: slackId });
  }
  const url = await slackChannelUrl(token, channelId);
  if (res.ok) return { status: 'joined', url };
  if (res.error === 'already_in_channel') return { status: 'already', url };
  throw slackChannelError(res.error, res);
}

exports.joinProjectChannel = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    const n = normalizeProjectChannel((request.data || {}).channel);
    if (n.error) throw new HttpsError('invalid-argument', n.error);
    if (!(await isRegisteredProjectChannel(n.name))) throw new HttpsError('not-found', 'No project uses that Slack channel.');
    return inviteToProjectChannel(SLACK_BOT_TOKEN.value(), email, n.name);
  }
);

// ---------- Projects: each project's meeting, slides and notes ----------
// Every project (a card in `projects`, or in a venue's cards) gets a workspace,
// projectWorkspaces/{card id}: a recurring Google Calendar meeting with a Meet
// link, a slide deck and a notes doc, all owned by the lab's Google account.
// Its members are whoever registered the project, its authors and whoever
// joined it: each is a guest of the meeting (Google emails them the invitation)
// and can edit the deck and the notes. The lab reads workspaces; only these
// functions write them. They're kept apart from the card because the board
// saves whole cards from its own copy, which would drop fields the server added.
//
// A new card is set up by onProjectCardWritten (with the meeting the register
// form asked for, `setUpMeeting` on the card); the project page sets up older
// ones, changes the meeting, and joins or leaves (projectWorkspace).
//
// GOOGLE_OAUTH: JSON { client_id, client_secret, refresh_token } for the lab's
// Google account, with the scopes calendar.events and drive.file
// (functions/tools/google-token.js makes it).
const GOOGLE_OAUTH = defineSecret('GOOGLE_OAUTH');
const { FieldValue } = require('firebase-admin/firestore');
const PROJECT_TZ = 'Europe/London';
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Pure: a meeting as sent by a page → { day, time, minutes, every } or { error }.
// day: 'MO'…'SU'; time: 'HH:MM' in London; minutes: 15–240 in 15s; every: 1–4 weeks.
function normalizeMeeting(m){
  if (!m || typeof m !== 'object') return { error: 'Choose a day and time for the meeting.' };
  const day = String(m.day || '').toUpperCase();
  if (WEEKDAYS.indexOf(day) < 0) return { error: 'Choose a day.' };
  const time = String(m.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'Choose a time.' };
  const minutes = Number(m.minutes);
  if (!(minutes >= 15 && minutes <= 240 && minutes % 15 === 0)) return { error: 'Choose how long it lasts.' };
  const every = Number(m.every);
  if ([1, 2, 3, 4].indexOf(every) < 0) return { error: 'Choose how often it runs.' };
  return { day, time, minutes, every };
}

// Pure: the first meeting, as local times in London ('2026-10-19T14:00:00'),
// on the meeting's weekday on or after `todayIso`; today only if `nowHm` is before it.
function firstMeetingTimes(meeting, todayIso, nowHm){
  const d = new Date(todayIso + 'T00:00:00Z');
  let add = (WEEKDAYS.indexOf(meeting.day) - (d.getUTCDay() + 6) % 7 + 7) % 7;
  if (add === 0 && nowHm >= meeting.time) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  const start = new Date(d.toISOString().slice(0, 10) + 'T' + meeting.time + ':00Z');
  const end = new Date(start.getTime() + meeting.minutes * 60000);
  const local = function(t){ return t.toISOString().slice(0, 19); };
  return { start: local(start), end: local(end) };
}

function meetingRecurrence(m){
  return ['RRULE:FREQ=WEEKLY' + (m.every > 1 ? ';INTERVAL=' + m.every : '') + ';BYDAY=' + m.day];
}

function nowHmLondon(){
  return new Intl.DateTimeFormat('en-GB', { timeZone: PROJECT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

// Pure: the project's members, lowercase and once each: whoever registered it,
// its authors, then whoever joined.
function projectMembers(card, joined){
  const out = [];
  [card.submittedBy && card.submittedBy.email].concat(card.authorEmails || [], joined || []).forEach(function(e){
    const v = String(e || '').trim().toLowerCase();
    if (v && v.indexOf('@') > 0 && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

// Whoever registered the card, one of its authors, or a PI/admin.
async function canEditCard(email, card){
  return String(card.submittedBy && card.submittedBy.email || '').toLowerCase() === email ||
    (card.authorEmails || []).some(function(e){ return String(e).toLowerCase() === email; }) ||
    isFullWrite(email);
}

function projectPageUrl(id, boardId){
  return SITE_URL + 'project.html#id=' + encodeURIComponent(id) + (boardId ? '&board=' + encodeURIComponent(boardId) : '');
}

// --- Google: an access token from the refresh token, then plain REST calls ---
let googleTokenCache = null;
async function googleToken(){
  if (googleTokenCache && googleTokenCache.exp > Date.now() + 60000) return googleTokenCache.token;
  let o;
  try { o = JSON.parse(GOOGLE_OAUTH.value()); } catch (e){ o = null; }
  if (!o || !o.refresh_token) throw new HttpsError('failed-precondition', 'The lab’s Google account isn’t connected yet — ask an admin.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: o.client_id, client_secret: o.client_secret, refresh_token: o.refresh_token, grant_type: 'refresh_token' })
  });
  const json = await res.json();
  if (!res.ok){
    logger.error('Google token refresh failed', { error: json.error, description: json.error_description });
    throw new HttpsError('failed-precondition', 'The lab’s Google account needs reconnecting — ask an admin.');
  }
  googleTokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

// → the parsed JSON (null for an empty reply); throws { status, reason, message } on an error.
async function googleFetch(method, url, body, contentType){
  const headers = { 'Authorization': 'Bearer ' + await googleToken() };
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : contentType ? body : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok){
    const e = (json && json.error) || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    logger.warn('Google API call failed', { method, url: url.replace(/\?.*$/, ''), status: res.status, reason, message: e.message });
    throw Object.assign(new Error(e.message || 'Google said no (' + res.status + ').'), { status: res.status, reason });
  }
  return json;
}

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

// The Drive folder every project's files go in, made once (drive.file can only
// reach files this app made). settings/projectDrive has no client access.
async function projectFolderId(){
  const ref = db.collection('settings').doc('projectDrive');
  const snap = await ref.get();
  if (snap.exists && snap.data().folderId) return snap.data().folderId;
  const f = await googleFetch('POST', DRIVE + '?fields=id', { name: 'BOLD.OS projects', mimeType: 'application/vnd.google-apps.folder' });
  await ref.set({ folderId: f.id, at: Date.now() });
  return f.id;
}

async function createDeck(title, folder){
  return googleFetch('POST', DRIVE + '?fields=id,webViewLink',
    { name: title + ' — slides', mimeType: 'application/vnd.google-apps.presentation', parents: [folder] });
}

// A Google Doc made from a little HTML: the title, then where everything else is.
async function createNotes(title, folder, links){
  const boundary = 'bold' + crypto.randomBytes(8).toString('hex');
  const meta = { name: title + ' — meeting notes', mimeType: 'application/vnd.google-apps.document', parents: [folder] };
  const esc = function(s){ return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  const html = '<html><body><h1>' + esc(title) + ' — meeting notes</h1>' +
    '<p><a href="' + esc(links.page) + '">Project page</a> · <a href="' + esc(links.deck) + '">Slides</a></p>' +
    '<p>Newest meeting first.</p></body></html>';
  const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + boundary + '--';
  return googleFetch('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    body, 'multipart/related; boundary=' + boundary);
}

// Lets `email` edit file `id`. Quietly, unless they have no Google account under that
// address: then Drive only shares by sending them an email.
async function shareFile(id, email){
  const url = DRIVE + '/' + id + '/permissions?sendNotificationEmail=';
  const body = { type: 'user', role: 'writer', emailAddress: email };
  try {
    await googleFetch('POST', url + 'false', body);
  } catch (err){
    if (err.status !== 400) throw err;
    await googleFetch('POST', url + 'true', body);
  }
}
async function unshareFile(id, email){
  const list = await googleFetch('GET', DRIVE + '/' + id + '/permissions?fields=permissions(id,emailAddress,role)');
  for (const p of (list && list.permissions) || []){
    if (p.role !== 'owner' && String(p.emailAddress || '').toLowerCase() === email) await googleFetch('DELETE', DRIVE + '/' + id + '/permissions/' + p.id);
  }
}

function eventDescription(ws){
  const lines = ['<a href="' + projectPageUrl(ws.cardId, ws.boardId) + '">Project page</a>'];
  if (ws.deckUrl) lines.push('<a href="' + ws.deckUrl + '">Slides</a>');
  if (ws.notesUrl) lines.push('<a href="' + ws.notesUrl + '">Meeting notes</a>');
  if (ws.slackChannel) lines.push('Slack: ' + ws.slackChannel);
  return lines.join('<br>');
}

function eventTimes(meeting){
  const t = firstMeetingTimes(meeting, todayIsoLondon(), nowHmLondon());
  return {
    start: { dateTime: t.start, timeZone: PROJECT_TZ },
    end: { dateTime: t.end, timeZone: PROJECT_TZ },
    recurrence: meetingRecurrence(meeting)
  };
}

// --- the workspace itself ---
function cardRefFor(id, boardId){
  return boardId ? db.collection('boards').doc(boardId).collection('cards').doc(id) : db.collection('projects').doc(id);
}

// A project is one or more cards, one per venue it went to (`projects/{id}` until
// it has a venue). A card submitted from a project's page to another venue carries
// that project's id (`projectId`); every other card is its own project, with its
// own id. The workspace is projectWorkspaces/{project id}.
function projectIdOf(card, cardId){ return (card && card.projectId) || cardId; }

// Every card of project `pid` → [{ id, boardId, ref, data }], oldest first. Read
// whole and filtered here: a lab has a few hundred cards at most.
async function projectCards(pid){
  const [venueCards, own] = await Promise.all([db.collectionGroup('cards').get(), db.collection('projects').get()]);
  const out = [];
  venueCards.docs.concat(own.docs).forEach(function(d){
    if (projectIdOf(d.data(), d.id) !== pid) return;
    const parent = d.ref.parent.parent;
    out.push({ id: d.id, boardId: parent ? parent.id : null, ref: d.ref, data: d.data() });
  });
  return out.sort(function(a, b){ return (a.data.createdAt || 0) - (b.data.createdAt || 0); });
}

// Pure: a project's group from its cards (oldest first): completed if marked so or
// accepted at any venue; otherwise its latest card's.
function projectGroupForCards(cards, completed){
  if (completed || cards.some(function(c){ return projectGroupForCard(c) === 'completed'; })) return 'completed';
  return projectGroupForCard(cards[cards.length - 1]);
}

// What a page reads: the workspace, as stored.
function workspaceView(ws){
  const out = {};
  ['cardId', 'boardId', 'venues', 'title', 'group', 'completedAt', 'slackChannel', 'members', 'joined', 'meeting', 'eventLink', 'meetUrl',
    'deckUrl', 'notesUrl', 'error', 'repo', 'repoName', 'repoUrl', 'repoError'].forEach(function(k){ if (ws[k] !== undefined) out[k] = ws[k]; });
  return out;
}

// Brings the workspace for card `id` in line with the card: makes the deck and the
// notes if there are none, sets the meeting to `meeting` (null: none; undefined:
// leave it), invites the members and lets them edit the files, and drops those
// who left. Records an error on the workspace instead of throwing, so the page
// can offer to try again. Runs one at a time per project (a lease on the workspace).
// --- GitHub: each project's repository in bold-lab-ai, and a team for its people ---
// The repository is made from a template repository in the org (any repo marked
// "Template repository" on GitHub; the register form lists them), never empty:
// the template carries the project-tracking tools the lab's QA audit checks. It
// gets a team of the same name with write access; its members are the project's
// people who have linked their GitHub account (githubLinks). Removing a project
// leaves its repository and team alone.
//
// GITHUB_APP: JSON { app_id, installation_id, private_key } for the BOLD.OS GitHub
// App installed on bold-lab-ai, with Repository → Administration: read and write,
// Contents: read, Metadata: read, and Organization → Members: read and write.
const GITHUB_APP = defineSecret('GITHUB_APP');
const GITHUB_ORG = 'bold-lab-ai';
const GITHUB_NOT_CONNECTED = 'BOLD.OS isn’t connected to GitHub yet — ask an admin.';

// Pure: a repository choice as sent by a page → { mode: 'template', template } or { error }.
function normalizeRepo(r){
  if (!r || typeof r !== 'object') return { error: 'Choose a repository.' };
  if (r.mode === 'template'){
    const t = String(r.template || '');
    return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(t) ? { mode: 'template', template: t } : { error: 'Choose a template.' };
  }
  return { error: 'Choose a repository.' };
}

// Pure: the name of a project's new repository: its Slack channel's ("proj-…"),
// or "proj-" and its title.
function projectRepoName(ws){
  const channel = String(ws.slackChannel || '').replace(/^#/, '');
  if (/^[a-z0-9_-]+$/.test(channel)) return channel;
  return 'proj-' + (String(ws.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project');
}

// An installation token for the app (an hour; cached), from a JWT it signs itself.
let githubAppCache = null;
async function githubAppToken(){
  if (githubAppCache && githubAppCache.exp > Date.now() + 60000) return githubAppCache.token;
  let o;
  try { o = JSON.parse(GITHUB_APP.value()); } catch (e){ o = null; }
  if (!o || !o.private_key) throw new HttpsError('failed-precondition', GITHUB_NOT_CONNECTED);
  const now = Math.floor(Date.now() / 1000);
  const part = function(x){ return Buffer.from(JSON.stringify(x)).toString('base64url'); };
  const unsigned = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({ iat: now - 60, exp: now + 540, iss: String(o.app_id) });
  const jwt = unsigned + '.' + crypto.createSign('RSA-SHA256').update(unsigned).sign(o.private_key, 'base64url');
  const res = await fetch('https://api.github.com/app/installations/' + o.installation_id + '/access_tokens', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bold-os' }
  });
  const json = await res.json();
  if (!res.ok){
    logger.error('GitHub app token failed', { status: res.status, message: json.message });
    throw new HttpsError('failed-precondition', GITHUB_NOT_CONNECTED);
  }
  githubAppCache = { token: json.token, exp: Date.parse(json.expires_at) };
  return json.token;
}

// → the parsed JSON (null when empty); throws { status, message } on an error.
async function githubApp(method, path, body){
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + await githubAppToken(), Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bold-os', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok){
    logger.warn('GitHub call failed', { method, path, status: res.status, message: json && json.message });
    throw Object.assign(new Error((json && json.message) || 'GitHub said no (' + res.status + ').'), { status: res.status });
  }
  return json;
}

// The org's template repositories → [{ name, description }], cached for a few minutes.
let templatesCache = null;
async function projectTemplates(){
  if (templatesCache && templatesCache.t > Date.now() - 5 * 60000) return templatesCache.list;
  const list = [];
  for (let page = 1; page < 10; page++){
    const repos = await githubApp('GET', '/orgs/' + GITHUB_ORG + '/repos?type=all&per_page=100&page=' + page);
    repos.filter(function(r){ return r.is_template && !r.archived; })
      .forEach(function(r){ list.push({ name: r.name, description: r.description || '' }); });
    if (repos.length < 100) break;
  }
  list.sort(function(a, b){ return a.name.localeCompare(b.name); });
  templatesCache = { t: Date.now(), list };
  return list;
}

// Where each of `emails` (Slack emails) gets the project's Google invitations and
// files: the Google account they linked (googleLinks), or the email itself.
async function googleAddressesFor(emails){
  const out = [];
  for (const e of emails){
    const snap = await db.collection('googleLinks').doc(e).get();
    const a = snap.exists && snap.data().google ? String(snap.data().google).toLowerCase() : e;
    if (out.indexOf(a) < 0) out.push(a);
  }
  return out;
}

// The GitHub logins of `emails` who have linked their account (githubLinks).
async function githubLoginsFor(emails){
  const out = [];
  for (const e of emails){
    const snap = await db.collection('githubLinks').doc(e).get();
    const d = snap.exists ? snap.data() : null;
    if (d && d.github && d.status !== 'failed') out.push(d.github.toLowerCase());
  }
  return out;
}

// Brings the workspace for card `id` in line with the card: makes the deck and the
// notes if there are none, invites the members and lets them edit the files, and
// drops those who left; makes or links the repository and keeps its team to the
// members with GitHub. `changes` may set `meeting` (null: none) and `repo`.
// Google and GitHub fail apart: each records its error on the workspace (`error`,
// `repoError`) instead of throwing, so the page can offer to try again. Runs one
// at a time per project (a lease on the workspace).
async function syncWorkspace(id, changes){
  changes = changes || {};
  const wsRef = db.collection('projectWorkspaces').doc(id);
  const lease = await db.runTransaction(async function(tx){
    const snap = await tx.get(wsRef);
    const d = snap.exists ? snap.data() : {};
    if (d.syncing && d.syncing > Date.now() - 2 * 60000) return false;
    tx.set(wsRef, { syncing: Date.now() }, { merge: true });
    return true;
  });
  if (!lease){
    // Another sync is running: it runs once more when it's done, with these changes.
    const later = { again: true };
    if (changes.meeting !== undefined) later.pendingMeeting = changes.meeting;
    if (changes.repo !== undefined) later.pendingRepo = changes.repo;
    await wsRef.set(later, { merge: true });
    return (await wsRef.get()).data();
  }
  let ws = (await wsRef.get()).data();
  const patch = {};
  const save = async function(){ await wsRef.set(Object.assign({ updatedAt: Date.now() }, patch), { merge: true }); Object.assign(ws, patch); };
  try {
    // Its cards: the latest one's title and channel, everyone on any of them.
    const cards = await projectCards(id);
    if (!cards.length) throw new Error('The project isn\u2019t there any more.');
    const latest = cards[cards.length - 1], card = latest.data;
    const labels = await boardLabelsFor(cards.map(function(c){ return c.boardId; }).filter(Boolean));
    patch.cardId = latest.id;
    patch.boardId = latest.boardId;
    patch.venues = cards.map(function(c){
      return { cardId: c.id, boardId: c.boardId, label: c.boardId ? labels[c.boardId] : '', status: c.data.status || '', outcome: c.data.outcome || '', createdAt: c.data.createdAt || 0 };
    });
    const meeting = changes.meeting !== undefined ? changes.meeting : ws.pendingMeeting;
    const repo = changes.repo !== undefined ? changes.repo : ws.pendingRepo;
    patch.pendingMeeting = FieldValue.delete();
    patch.pendingRepo = FieldValue.delete();
    patch.again = FieldValue.delete();
    patch.title = card.title || 'Untitled project';
    // Planned, ongoing or completed, as on the Projects page (the meetings page leaves out completed ones).
    patch.group = projectGroupForCards(cards.map(function(c){ return c.data; }), !!ws.completedAt);
    patch.slackChannel = card.slackChannel || '';
    const everyone = [];
    cards.forEach(function(c){ projectMembers(c.data, []).forEach(function(e){ if (everyone.indexOf(e) < 0) everyone.push(e); }); });
    patch.members = projectMembers({ authorEmails: everyone }, ws.joined);
    patch.joined = ws.joined || [];
    if (!ws.createdAt) patch.createdAt = Date.now();
    // Kept even if Google or GitHub fails below, so trying again picks them up.
    if (meeting !== undefined) patch.meeting = meeting;
    if (repo !== undefined) patch.repo = repo;
    await save();

    try {
      // Slides, then notes (which link the slides): saved as each is made, so a
      // failure part way never makes the same file twice.
      const folder = (!ws.deckId || !ws.notesId) ? await projectFolderId() : null;
      if (!ws.deckId){
        const f = await createDeck(ws.title, folder);
        patch.deckId = f.id; patch.deckUrl = f.webViewLink; await save();
      }
      if (!ws.notesId){
        const f = await createNotes(ws.title, folder, { page: projectPageUrl(ws.cardId, ws.boardId), deck: ws.deckUrl });
        patch.notesId = f.id; patch.notesUrl = f.webViewLink; await save();
      }
      // Each member's address for Google: their linked Google account, or their Slack email.
      const addrs = await googleAddressesFor(ws.members);
      // Files: shared with every member, unshared from whoever left.
      const shared = ws.shared || [];
      for (const e of addrs.filter(function(m){ return shared.indexOf(m) < 0; })){
        await shareFile(ws.deckId, e); await shareFile(ws.notesId, e);
        patch.shared = (ws.shared || []).concat(e); await save();
      }
      for (const e of shared.filter(function(m){ return addrs.indexOf(m) < 0; })){
        await unshareFile(ws.deckId, e); await unshareFile(ws.notesId, e);
        patch.shared = ws.shared.filter(function(m){ return m !== e; }); await save();
      }

      // The meeting: Google emails the guests an invitation, or a change, or a cancellation.
      // A completed project's meeting is cancelled; the time is kept, so it comes back
      // if the project is reopened.
      const wantEvent = !!ws.meeting && ws.group !== 'completed';
      const attendees = function(existing){
        // Keeps each guest's reply; adds new members; drops who left.
        const kept = (existing || []).filter(function(a){ return a.organizer || a.self || addrs.indexOf(String(a.email).toLowerCase()) >= 0; });
        return kept.concat(addrs.filter(function(m){
          return !kept.some(function(a){ return String(a.email).toLowerCase() === m; });
        }).map(function(m){ return { email: m }; }));
      };
      if (wantEvent && !ws.eventId){
        const ev = await googleFetch('POST', CAL + '?conferenceDataVersion=1&sendUpdates=all', Object.assign({
          summary: ws.title,
          description: eventDescription(ws),
          attendees: attendees([]),
          guestsCanModify: false,
          conferenceData: { createRequest: { requestId: 'bold-' + id + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        }, eventTimes(ws.meeting)));
        patch.eventId = ev.id; patch.eventLink = ev.htmlLink; patch.meetUrl = ev.hangoutLink || '';
        patch.eventMeeting = ws.meeting;
        await save();
      } else if (!wantEvent && ws.eventId){
        await googleFetch('DELETE', CAL + '/' + ws.eventId + '?sendUpdates=all').catch(function(err){ if (err.status !== 410 && err.status !== 404) throw err; });
        patch.eventId = FieldValue.delete(); patch.eventLink = FieldValue.delete();
        patch.meetUrl = FieldValue.delete(); patch.eventMeeting = FieldValue.delete();
        await save();
        ['eventId', 'eventLink', 'meetUrl', 'eventMeeting'].forEach(function(k){ delete ws[k]; });
      } else if (ws.eventId){
        const ev = await googleFetch('GET', CAL + '/' + ws.eventId);
        const change = {};
        const want = attendees(ev.attendees);
        if (JSON.stringify(want.map(function(a){ return a.email; })) !== JSON.stringify((ev.attendees || []).map(function(a){ return a.email; }))) change.attendees = want;
        if (ev.summary !== ws.title) change.summary = ws.title;
        const desc = eventDescription(ws);
        if (ev.description !== desc) change.description = desc;
        if (JSON.stringify(ws.eventMeeting) !== JSON.stringify(ws.meeting)) Object.assign(change, eventTimes(ws.meeting));
        if (Object.keys(change).length){
          await googleFetch('PATCH', CAL + '/' + ws.eventId + '?sendUpdates=all', change);
          patch.eventMeeting = ws.meeting; await save();
        }
      }
      patch.error = FieldValue.delete();
    } catch (err){
      logger.error('Setting up the project\u2019s meeting, slides and notes failed', { id, error: String(err && err.message || err) });
      patch.error = err instanceof HttpsError ? err.message : 'Couldn\u2019t set up the meeting, slides and notes.';
    }
    await save();

    try {
      if (ws.repo && !ws.repoName){
        if (!(await projectTemplates()).some(function(t){ return t.name === ws.repo.template; })) {
          throw new HttpsError('invalid-argument', ws.repo.template + ' isn\u2019t one of the lab\u2019s templates.');
        }
        const name = projectRepoName(ws);
        const about = { owner: GITHUB_ORG, name, private: true, description: ws.title.slice(0, 300) };
        let r;
        try {
          r = await githubApp('POST', '/repos/' + GITHUB_ORG + '/' + ws.repo.template + '/generate', about);
        } catch (err){
          if (err.status === 422) throw new HttpsError('already-exists', GITHUB_ORG + '/' + name + ' already exists \u2014 link it as an existing repository.');
          throw err;
        }
        patch.repoName = name; patch.repoUrl = r.html_url; await save();
      }
      if (ws.repoName){
        // Its team, with write access.
        if (!ws.teamSlug){
          let team;
          try { team = await githubApp('POST', '/orgs/' + GITHUB_ORG + '/teams', { name: ws.repoName, privacy: 'closed', description: 'People on ' + ws.title.slice(0, 200) }); }
          catch (err){ if (err.status !== 422) throw err; team = await githubApp('GET', '/orgs/' + GITHUB_ORG + '/teams/' + ws.repoName); }
          await githubApp('PUT', '/orgs/' + GITHUB_ORG + '/teams/' + team.slug + '/repos/' + GITHUB_ORG + '/' + ws.repoName, { permission: 'push' });
          patch.teamSlug = team.slug; patch.teamMembers = []; await save();
        }
        const want = await githubLoginsFor(ws.members);
        const have = ws.teamMembers || [];
        for (const login of want.filter(function(l){ return have.indexOf(l) < 0; })){
          await githubApp('PUT', '/orgs/' + GITHUB_ORG + '/teams/' + ws.teamSlug + '/memberships/' + login, { role: 'member' });
          patch.teamMembers = (ws.teamMembers || []).concat(login); await save();
        }
        for (const login of have.filter(function(l){ return want.indexOf(l) < 0; })){
          await githubApp('DELETE', '/orgs/' + GITHUB_ORG + '/teams/' + ws.teamSlug + '/memberships/' + login)
            .catch(function(err){ if (err.status !== 404) throw err; });
          patch.teamMembers = ws.teamMembers.filter(function(l){ return l !== login; }); await save();
        }
      }
      patch.repoError = FieldValue.delete();
    } catch (err){
      logger.error('Setting up the project\u2019s repository failed', { id, error: String(err && err.message || err) });
      patch.repoError = err instanceof HttpsError ? err.message : 'Couldn\u2019t set up the GitHub repository.';
    }
    patch.syncing = FieldValue.delete();
    await save();
  } catch (err){
    logger.error('Setting up the project workspace failed', { id, error: String(err && err.message || err) });
    await wsRef.set({ error: err instanceof HttpsError ? err.message : 'Couldn\u2019t set up the project.', syncing: FieldValue.delete(), again: FieldValue.delete(), updatedAt: Date.now() }, { merge: true });
    return (await wsRef.get()).data();
  }
  if ((await wsRef.get()).data().again) return syncWorkspace(id);
  return (await wsRef.get()).data();
}

// A new project is set up at once (a card submitted to another venue from its
// project's page joins that project's); a changed one is brought in line when its
// title, channel, submitter, authors or stage change; when a project's last card
// is removed, its meeting is cancelled.
function onProjectCard(document){
  return onDocumentWritten({ document, secrets: [GOOGLE_OAUTH, GITHUB_APP] }, async function(event){
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    const id = event.params.cardId;
    const pid = projectIdOf(after || before, id);
    const wsRef = db.collection('projectWorkspaces').doc(pid);
    if (!after){
      const snap = await wsRef.get();
      if (!snap.exists) return;
      if ((await projectCards(pid)).length) { await syncWorkspace(pid); return; }
      const ws = snap.data();
      if (ws.eventId){
        await googleFetch('DELETE', CAL + '/' + ws.eventId + '?sendUpdates=all')
          .catch(function(err){ logger.warn('Cancelling a removed project\u2019s meeting failed', { pid, error: String(err.message) }); });
      }
      // The slides, notes and repository stay; its presentations go with it.
      await db.recursiveDelete(wsRef);
      return;
    }
    if (!before){
      if (pid !== id) { await syncWorkspace(pid); return; }
      const m = after.setUpMeeting ? normalizeMeeting(after.setUpMeeting) : null;
      const r = after.setUpRepo ? normalizeRepo(after.setUpRepo) : null;
      await syncWorkspace(pid, { meeting: m && !m.error ? m : undefined, repo: r && !r.error ? r : undefined });
      return;
    }
    const key = function(d){ return JSON.stringify([d.title, d.slackChannel, d.submittedBy && d.submittedBy.email, d.authorEmails, d.status, d.outcome]); };
    if (key(before) === key(after)) return;
    if ((await wsRef.get()).exists) await syncWorkspace(pid);
  });
}
// A new project, registered on the Projects page, announced in
// #all-active-projects: the channel is read-only for people (BOLDiquette §
// Research Project Lifecycle), so the lab hears of projects from here. The bot
// must be in the channel. A project submitted to another venue isn't new.
const ACTIVE_PROJECTS_CHANNEL = 'all-active-projects';

// The announcement: pure, so it's testable on its own.
function projectAnnouncement(card, url){
  const who = slackText((card.submittedBy && (card.submittedBy.name || card.submittedBy.email)) || 'Someone');
  const abstract = String(card.abstractText || '').trim().replace(/\s+/g, ' ');
  const lines = ['🆕 ' + linkedTitle(slackText(card.title || 'Untitled project'), url) + ' — registered by ' + who];
  if (abstract) lines.push('> ' + slackText(abstract.length > 400 ? abstract.slice(0, 400).replace(/\s+\S*$/, '') + '…' : abstract));
  const keywords = (card.keywords || []).filter(Boolean);
  if (keywords.length) lines.push('Keywords: ' + keywords.map(slackText).join(', '));
  if (card.slackChannel) lines.push('Channel: ' + slackText(card.slackChannel));
  // Opens the project's page, which joins whoever clicked (pages/project.js, &join=1):
  // its channel, meeting, notes, slides and repository.
  lines.push('<' + url + '&join=1|Join the project>');
  return lines.join('\n');
}

exports.onProjectRegistered = onDocumentCreated(
  { document: 'projects/{cardId}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const card = event.data && event.data.data();
    if (!card) return;
    const token = SLACK_BOT_TOKEN.value();
    const channel = await slackChannelId(token, ACTIVE_PROJECTS_CHANNEL);
    if (!channel){ logger.warn('#' + ACTIVE_PROJECTS_CHANNEL + ' not found: the bot can’t see it'); return; }
    const posted = await slackFetch(token, 'chat.postMessage', {
      channel, text: projectAnnouncement(card, projectPageUrl(event.params.cardId)), unfurl_links: false,
    });
    if (!posted.ok) logger.warn('Announcing a new project failed', { error: posted.error });
  }
);

exports.onProjectWritten = onProjectCard('projects/{cardId}');
exports.onVenueCardWritten = onProjectCard('boards/{boardId}/cards/{cardId}');

// The project page and the meetings page:
// - 'setUp': (re)tries setting up the workspace; whoever can edit the project.
// - 'meeting': sets the meeting ({ day, time, minutes, every }, or null for none); same.
// - 'join': makes the caller a member (and invites them to the Slack channel).
// - 'leave': stops them being one; not its submitter or authors.
// - 'repo': makes its repository from a template ({ mode: 'template', template });
//   editors only; once made, it stays.
// - 'complete' / 'reopen': marks the project completed (its meeting is cancelled) or
//   not; editors only. Completion by acceptance at a venue needs neither.
// - 'submit': submits the project to another venue ({ venue, card }: a card the page
//   built); editors only; → { cardId, boardId }.
// - 'templates': no project; the org's template repositories → { templates: [{ name, description }] }.
// - 'mine': no project; the caller's planned and ongoing projects, set up if they
//   weren't yet → { projects: [{ id, title, cardId, boardId }] }.
// - 'venues': no project; the approved venues → { venues: [{ id, label, deadline }] }.
// → the workspace (workspaceView), plus { slack: { status, url } | { error } } on 'join'.
exports.projectWorkspace = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN, GITHUB_APP], timeoutSeconds: 540 },
  async (request) => {
    const email = callerEmail(request);
    const data = request.data || {};
    if (data.action === 'templates') return { templates: await projectTemplates() };
    if (data.action === 'mine'){
      // The caller's planned and ongoing projects: those whose cards name them (as
      // submitter or author) or that they joined. Any registered before workspaces
      // existed is set up now, so it can take presentations (firestore.rules).
      const [boardsSnap, cardsSnap, unassignedSnap, wsSnap] = await Promise.all([
        db.collection('boards').get(), db.collectionGroup('cards').get(), db.collection('projects').get(),
        db.collection('projectWorkspaces').get()
      ]);
      const ws = {};
      wsSnap.docs.forEach(function(d){ ws[d.id] = d.data(); });
      const venueCards = cardsSnap.docs.map(function(d){ return { boardId: d.ref.parent.parent.id, id: d.id, data: d.data() }; });
      const ownCards = unassignedSnap.docs.map(function(d){ return { id: d.id, data: d.data() }; });
      const groups = allProjectsFromCards(
        boardsSnap.docs.map(function(d){ return { id: d.id, label: d.data().label, status: d.data().status || 'approved' }; }),
        venueCards, ownCards,
        Object.keys(ws).filter(function(id){ return ws[id].completedAt; }));
      const named = {};
      venueCards.concat(ownCards).forEach(function(c){
        if (projectMembers(c.data, []).indexOf(email) >= 0) named[projectIdOf(c.data, c.id)] = true;
      });
      const mine = groups.planned.concat(groups.ongoing).filter(function(i){
        return named[i.pid] || (ws[i.pid] && (ws[i.pid].joined || []).indexOf(email) >= 0);
      });
      for (const i of mine) if (!ws[i.pid]) await syncWorkspace(i.pid);
      return { projects: mine.map(function(i){ return { id: i.pid, title: i.title, cardId: i.cardId || i.projectId, boardId: i.boardId || null }; })
        .sort(function(a, b){ return a.title.localeCompare(b.title); }) };
    }
    if (data.action === 'venues'){
      // The venues a project can be submitted to: every approved one, newest first.
      const boards = await db.collection('boards').get();
      return { venues: boards.docs.filter(function(d){ return (d.data().status || 'approved') !== 'pending'; })
        .map(function(d){ return { id: d.id, label: d.data().label || d.id, deadline: d.data().deadline || '' }; })
        .sort(function(a, b){ return String(b.deadline).localeCompare(String(a.deadline)) || a.label.localeCompare(b.label); }) };
    }
    const id = String(data.id || ''), boardId = data.board ? String(data.board) : null;
    if (!validSlug(id) || (boardId && !validSlug(boardId))) throw new HttpsError('invalid-argument', 'No project given.');
    const cardSnap = await cardRefFor(id, boardId).get();
    if (!cardSnap.exists) throw new HttpsError('not-found', 'That project isn’t there any more.');
    const card = cardSnap.data();
    const pid = projectIdOf(card, id);
    const wsRef = db.collection('projectWorkspaces').doc(pid);

    if (data.action === 'setUp' || data.action === 'meeting' || data.action === 'repo'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project’s submitter, authors, PIs and admins can do this.');
      const changes = {};
      if (data.action === 'meeting'){
        changes.meeting = data.meeting === null ? null : normalizeMeeting(data.meeting);
        if (changes.meeting && changes.meeting.error) throw new HttpsError('invalid-argument', changes.meeting.error);
      }
      if (data.action === 'repo'){
        changes.repo = normalizeRepo(data.repo);
        if (changes.repo.error) throw new HttpsError('invalid-argument', changes.repo.error);
        const ws = (await wsRef.get()).data() || {};
        if (ws.repoName) throw new HttpsError('failed-precondition', 'It already has ' + GITHUB_ORG + '/' + ws.repoName + '.');
      }
      return workspaceView(await syncWorkspace(pid, changes));
    }

    if (data.action === 'complete' || data.action === 'reopen'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project\u2019s submitter, authors, PIs and admins can do this.');
      await wsRef.set(data.action === 'complete'
        ? { completedAt: Date.now(), completedBy: email }
        : { completedAt: FieldValue.delete(), completedBy: FieldValue.delete() }, { merge: true });
      return workspaceView(await syncWorkspace(pid));
    }

    if (data.action === 'submit'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project\u2019s submitter, authors, PIs and admins can do this.');
      const venue = String(data.venue || '');
      if (!validSlug(venue)) throw new HttpsError('invalid-argument', 'Choose a venue.');
      const board = await db.collection('boards').doc(venue).get();
      if (!board.exists || (board.data().status || 'approved') === 'pending') throw new HttpsError('not-found', 'That venue isn\u2019t on the board.');
      const cards = await projectCards(pid);
      if (cards.some(function(c){ return c.boardId === venue; })) throw new HttpsError('failed-precondition', 'It\u2019s already at ' + (board.data().label || venue) + '.');
      // The page builds the card (card-model.js, as the board does); it joins this
      // project, registered by the caller, at the first stage.
      const c = data.card && typeof data.card === 'object' ? Object.assign({}, data.card) : null;
      if (!c || typeof c.title !== 'string' || !c.title.trim()) throw new HttpsError('invalid-argument', 'The new card has no title.');
      const cardId = /^card-[a-z0-9-]{1,60}$/.test(String(c.id || '')) ? c.id : 'card-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      ['id', 'setUpMeeting', 'setUpRepo'].forEach(function(k){ delete c[k]; });
      const now = Date.now();
      await db.collection('boards').doc(venue).collection('cards').doc(cardId).set(Object.assign(c, {
        projectId: pid, status: 'register', outcome: '', createdAt: now, updatedAt: now,
        submittedBy: { name: request.auth.token.name || request.auth.token.email, email: request.auth.token.email, slackId: null }
      }));
      // A project without a venue moves onto the board: its venue-less card goes.
      for (const old of cards) if (!old.boardId) await old.ref.delete();
      return { cardId, boardId: venue };
    }

    if (data.action === 'join' || data.action === 'leave'){
      const joining = data.action === 'join';
      if (!joining && projectMembers(card, []).indexOf(email) >= 0) {
        throw new HttpsError('failed-precondition', 'Its submitter and authors stay on the project — remove yourself from the authors first.');
      }
      await wsRef.set({ joined: joining
        ? FieldValue.arrayUnion(email)
        : FieldValue.arrayRemove(email) }, { merge: true });
      const out = workspaceView(await syncWorkspace(pid));
      if (joining && card.slackChannel){
        const n = normalizeProjectChannel(card.slackChannel);
        try { out.slack = await inviteToProjectChannel(SLACK_BOT_TOKEN.value(), email, n.name); }
        catch (err){ out.slack = { error: err.message || 'Couldn’t add you to the Slack channel.' }; }
      }
      return out;
    }
    throw new HttpsError('invalid-argument', 'Unknown action.');
  }
);

// Collaboration Week hackathon: joining the bold-lab-ai `hackathon` team
// (Write on bold-os). GitHub has no join-by-link, so the BOLD OS workshop page
// does it in two steps:
// - joinHackathonTeam: a signed-in lab member asks, with their GitHub
//   username. Only recorded in hackathonJoins/{email}; nothing goes to GitHub.
// - approveHackathonJoins: a PI/admin approves some or all requests; each is
//   then sent to GitHub, which adds them (or emails an org invitation, which
//   leaves them "pending" until they accept).
// hackathonJoinRequests returns the caller's own request, and every request
// for a PI/admin. hackathonJoins has no client access (firestore.rules'
// catch-all). GitHub is called as the BOLD.OS GitHub App (GITHUB_APP, see the
// projects' repositories), which has Organization → Members: read and write.
const GITHUB_USERNAME = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

function callerEmail(request){
  return signedInEmail(request).toLowerCase();
}

async function isFullWrite(email){
  const [pis, admins] = await Promise.all([rolesEmails('pis'), rolesEmails('admins')]);
  return pis.concat(admins).some(e => String(e).toLowerCase() === email);
}

function joinView(d){
  return { email: d.email, name: d.name || '', github: d.github, status: d.status, error: d.error || '', requestedAt: d.requestedAt || 0 };
}

exports.joinHackathonTeam = onCall(
  async (request) => {
    const email = callerEmail(request);
    const github = String((request.data || {}).username || '').trim().replace(/^@/, '');
    if (!GITHUB_USERNAME.test(github)) throw new HttpsError('invalid-argument', 'That isn’t a GitHub username.');
    const ref = db.collection('hackathonJoins').doc(email);
    const prev = (await ref.get()).data();
    // Already through: changing the username would need a fresh approval.
    if (prev && prev.github.toLowerCase() === github.toLowerCase() && (prev.status === 'active' || prev.status === 'pending')) return joinView(prev);
    const doc = { email, name: request.auth.token.name || '', github, status: 'requested', error: '', requestedAt: Date.now() };
    await ref.set(doc);
    return joinView(doc);
  }
);

exports.hackathonJoinRequests = onCall(
  async (request) => {
    const email = callerEmail(request);
    const mine = (await db.collection('hackathonJoins').doc(email).get()).data();
    if (!(await isFullWrite(email))) return { mine: mine ? joinView(mine) : null, canApprove: false };
    const all = (await db.collection('hackathonJoins').get()).docs.map(d => joinView(d.data()));
    all.sort((a, b) => b.requestedAt - a.requestedAt);
    return { mine: mine ? joinView(mine) : null, canApprove: true, all };
  }
);

async function addToHackathonTeam(github){
  const res = await githubFetch('/orgs/bold-lab-ai/teams/hackathon/memberships/' + encodeURIComponent(github), {
    method: 'PUT',
    body: JSON.stringify({ role: 'member' }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { status: body.state === 'active' ? 'active' : 'pending', error: '' };
  if (res.status === 404) return { status: 'failed', error: 'No GitHub account called ' + github + '.' };
  logger.error('approveHackathonJoins: GitHub said ' + res.status, { github, message: body.message });
  return { status: 'failed', error: 'GitHub refused (' + res.status + ').' };
}

// data.emails: the requests to approve; omitted = every request still waiting.
exports.approveHackathonJoins = onCall(
  { secrets: [GITHUB_APP] },
  async (request) => {
    const email = callerEmail(request);
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins can approve.');
    const wanted = Array.isArray((request.data || {}).emails) ? request.data.emails.map(e => String(e).toLowerCase()) : null;
    const snap = await db.collection('hackathonJoins').where('status', 'in', ['requested', 'failed']).get();
    const docs = snap.docs.filter(d => wanted ? wanted.indexOf(d.id) !== -1 : d.data().status === 'requested');
    const results = [];
    for (const d of docs) {
      const r = await addToHackathonTeam(d.data().github);
      await d.ref.update({ status: r.status, error: r.error, approvedBy: email, approvedAt: Date.now() });
      results.push(Object.assign({ email: d.id, github: d.data().github }, r));
    }
    return { results };
  }
);

// ---------- GitHub: link an account, join bold-lab-ai ----------
//
// On their profile (profile.html) a signed-in person links their GitHub account
// to their BOLD.OS sign-in (Firebase Auth's GitHub provider), which proves the
// account is theirs. linkGithub then invites that account to the bold-lab-ai
// organisation, with no approval: everyone who can sign in may join. The
// GitHub account is read from Firebase Auth, never from the client, so nobody
// can have someone else's account invited. GitHub emails the invitation; the
// person is "pending" until they accept it, then "active". Kept in
// githubLinks/{email}: { email, name, github (login), githubId, status:
// 'active' | 'pending' | 'failed', error, linkedAt, updatedAt } (no client
// access: firestore.rules' catch-all). Calling it again refreshes the status;
// after the account is unlinked it forgets the link (org membership stays).
// Called as the BOLD.OS GitHub App (GITHUB_APP), with Organization → Members: read and write.

// GitHub answers 401 when the app has lost its access (uninstalled, or its key revoked).
const TOKEN_EXPIRED = 'BOLD.OS’s access to GitHub has stopped working: ask an admin to reconnect it, then try again.';

// → the fetch Response, as the app.
async function githubFetch(path, init){
  const token = await githubAppToken();
  return fetch('https://api.github.com' + path, Object.assign({}, init, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bold-os',
      'Content-Type': 'application/json',
    },
  }));
}

// The org membership of GitHub account `login` (numeric `id`), inviting it if
// it has none → { status, error }.
async function joinOrg(login, id){
  const member = await githubFetch('/orgs/bold-lab-ai/memberships/' + encodeURIComponent(login));
  if (member.ok) {
    const m = await member.json().catch(() => ({}));
    return { status: m.state === 'active' ? 'active' : 'pending', error: '' };
  }
  if (member.status === 401) throw new HttpsError('failed-precondition', TOKEN_EXPIRED);
  if (member.status !== 404) {
    logger.error('linkGithub: membership check got ' + member.status, { login });
    return { status: 'failed', error: 'GitHub refused (' + member.status + ').' };
  }
  const invite = await githubFetch('/orgs/bold-lab-ai/invitations', {
    method: 'POST', body: JSON.stringify({ invitee_id: Number(id), role: 'direct_member' }),
  });
  if (invite.ok) return { status: 'pending', error: '' };
  const body = await invite.json().catch(() => ({}));
  // 422: already invited (or similar); the invitation stands.
  if (invite.status === 422) return { status: 'pending', error: '' };
  logger.error('linkGithub: invitation got ' + invite.status, { login, message: body.message });
  return { status: 'failed', error: 'GitHub refused the invitation (' + invite.status + ').' };
}

function githubView(d){
  return d ? { github: d.github, status: d.status, error: d.error || '', linkedAt: d.linkedAt || 0 } : null;
}

exports.linkGithub = onCall(
  { secrets: [GOOGLE_OAUTH, GITHUB_APP], timeoutSeconds: 120 },
  async (request) => {
    const email = callerEmail(request);
    const ref = db.collection('githubLinks').doc(email);
    const user = await admin.auth().getUser(request.auth.uid);
    const gh = (user.providerData || []).find((p) => p.providerId === 'github.com');
    if (!gh) { await ref.delete(); return { link: null }; }
    const prev = (await ref.get()).data();
    if (prev && prev.githubId === gh.uid && prev.status === 'active') return { link: githubView(prev) };
    // The login, from GitHub itself (Firebase keeps the numeric id).
    const who = await githubFetch('/user/' + encodeURIComponent(gh.uid));
    if (!who.ok) {
      logger.error('linkGithub: looking up GitHub user ' + gh.uid + ' got ' + who.status);
      if (who.status === 401) throw new HttpsError('failed-precondition', TOKEN_EXPIRED);
      throw new HttpsError('unavailable', 'Couldn’t reach GitHub — try again.');
    }
    const login = (await who.json()).login;
    const r = await joinOrg(login, gh.uid);
    const now = Date.now();
    const doc = { email, name: request.auth.token.name || '', github: login, githubId: gh.uid,
      status: r.status, error: r.error, linkedAt: (prev && prev.githubId === gh.uid && prev.linkedAt) || now, updatedAt: now };
    await ref.set(doc);
    // Their projects' repositories: added to each one's team.
    if (doc.status !== 'failed'){
      const mine = await db.collection('projectWorkspaces').where('members', 'array-contains', email).get();
      for (const d of mine.docs){
        if (d.data().teamSlug) await syncWorkspace(d.id);
      }
    }
    return { link: githubView(doc) };
  }
);

// ---------- Linking a Google account ----------
// On their profile a signed-in person links the Google account they use (Firebase
// Auth's Google provider, BOLD.link), which proves it's theirs. linkGoogle reads it
// from Firebase Auth (never from the client) and keeps it in googleLinks/{email}:
// { email, google, linkedAt } (no client access: firestore.rules' catch-all); their
// projects' meeting invitations and slides and notes then go to it instead of
// their Slack email (googleAddressesFor). Called again after unlinking, it forgets
// the link and moves them back. Its Google account never signs anyone in: only
// Slack accounts count (onlySlackSignUps, isSignedIn()). → { link: { google } | null }.
exports.linkGoogle = onCall(
  { secrets: [GOOGLE_OAUTH, GITHUB_APP], timeoutSeconds: 120 },
  async (request) => {
    const email = callerEmail(request);
    const user = await admin.auth().getUser(request.auth.uid);
    const g = (user.providerData || []).filter(function(p){ return p.providerId === 'google.com'; })[0];
    const google = g && g.email ? g.email.toLowerCase() : '';
    const ref = db.collection('googleLinks').doc(email);
    const prev = (await ref.get()).data();
    if ((prev && prev.google || '') !== google){
      if (google) await ref.set({ email, google, linkedAt: Date.now() });
      else await ref.delete();
      // Their projects: invitations and files move to the new address.
      const mine = await db.collection('projectWorkspaces').where('members', 'array-contains', email).get();
      for (const d of mine.docs) await syncWorkspace(d.id);
    }
    return { link: google ? { google } : null };
  }
);

// ---------- people roster: daily sync from Slack ----------
//
// `people` ({ name, email, slackId }, keyed by Slack id) backs every person
// picker on the site. It was first filled by a one-off users.list script
// (docs/FIREBASE.md); this keeps it current: once a day it adds people who
// joined Slack, updates changed names and emails, and drops deactivated
// accounts. Bots and accounts without an email are skipped. Needs the bot
// token's users:read and users:read.email scopes; if Slack refuses, or
// returns nobody with an email, nothing is written. Anyone signed in can
// also run it from a person picker ("Refresh from Slack", refreshPeople),
// at most once a minute (meta/peopleSync).
async function slackMembers(token){
  const members = [];
  let cursor = '';
  do {
    const res = await fetch('https://slack.com/api/users.list?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const json = await res.json();
    if (!json.ok) throw new Error('users.list failed: ' + json.error + (json.needed ? ' (needs ' + json.needed + ')' : ''));
    members.push(...(json.members || []));
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);
  return members;
}

// → { added, updated, removed }
async function syncPeopleFromSlack(token){
  const members = await slackMembers(token);
  const people = members
    .filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT' && u.profile && u.profile.email)
    .map(u => ({ slackId: u.id, email: u.profile.email, name: u.profile.real_name || u.real_name || u.name || u.profile.email }));
  if (!people.length) {
    logger.error('syncPeople: Slack returned nobody with an email — is users:read.email granted? Nothing written.', { members: members.length });
    throw new Error('Slack returned nobody with an email (is users:read.email granted?)');
  }
  const gone = members.filter(u => u.deleted).map(u => u.id);
  const existing = await db.collection('people').get();
  const current = {};
  existing.docs.forEach(d => { current[d.id] = d.data(); });

  const writes = [];
  people.forEach(p => {
    const was = current[p.slackId];
    if (!was || was.name !== p.name || was.email !== p.email) writes.push({ id: p.slackId, data: p, added: !was });
  });
  const deletes = gone.filter(id => current[id]);
  const ops = writes.map(w => batch => batch.set(db.collection('people').doc(w.id), w.data, { merge: true }))
    .concat(deletes.map(id => batch => batch.delete(db.collection('people').doc(id))));
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => op(batch));
    await batch.commit();
  }
  const counts = { added: writes.filter(w => w.added).length, updated: writes.filter(w => !w.added).length, removed: deletes.length };
  await db.collection('meta').doc('peopleSync').set(Object.assign({ at: Date.now() }, counts));
  logger.info('syncPeople done', Object.assign({ members: members.length, people: people.length }, counts));
  return counts;
}

exports.syncPeople = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] },
  async function(){ await syncPeopleFromSlack(SLACK_BOT_TOKEN.value()); }
);

// → { added, updated, removed, at }. A sync in the last minute is reported, not repeated.
exports.refreshPeople = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    callerEmail(request);
    const last = (await db.collection('meta').doc('peopleSync').get()).data();
    if (last && Date.now() - last.at < 60 * 1000) return last;
    try {
      return Object.assign(await syncPeopleFromSlack(SLACK_BOT_TOKEN.value()), { at: Date.now() });
    } catch (err) {
      logger.error('refreshPeople failed', { error: String(err && err.message || err) });
      throw new HttpsError('unavailable', 'Couldn’t read the member list from Slack.');
    }
  }
);

// ---------- Collaboration Week: editing and adding talks ----------
//
// A talk comes either from the programme (src/_data, with its own generated
// page) or was added from its session's page (createTalk; `added: true`).
// collabWeekTalks/{slug} holds an added talk whole, and a programme talk's
// edits since. Either way the same fields can be edited (TALK_FIELDS), and
// the talk's speakers are people ([{ name, email }]): their names make its
// `speaker` line, their emails its presenterEmails. Readable by the lab,
// written only here. No talk's time is stored: the pages work it out from
// its session's order and durations.
//
// Sessions and talks of every event (Collaboration Week's, the Festival's…)
// live in collabWeekSessions/{slug} and collabWeekTalks/{slug}; a talk names
// its session (sessionSlug), a session its event (eventSlug) and its leads'
// sign-in emails (leadEmails). Access is by sign-in email only: a presenter
// (presenterEmails), a lead of the talk's session or a PI/admin can edit a
// talk. Only leads and PIs/admins can change the speakers, add a talk to a
// session, or remove one (which deletes it).
const TALK_FIELDS = { title: 300, type: 40, speaker: 300, duration: 100, affiliation: 300, notes: 1000, abstract: 10000, bio: 10000, presentationUrl: 2000 };
const TALK_TYPES = ['research-talk', 'pitch', 'keynote'];  // labels in src/_data/collabWeekTypes.js; a keynote/oral session is one talk

// [{ name, email }] → { speakers, speaker, presenterEmails }
function speakerFields(list){
  if (!Array.isArray(list) || list.length > 20) throw new HttpsError('invalid-argument', 'Too many speakers.');
  const speakers = list.map(x => ({ name: String((x && x.name) || '').trim(), email: String((x && x.email) || '').trim().toLowerCase() }))
    .filter(x => x.name || x.email);
  speakers.forEach(x => {
    if (!x.name || x.name.length > 200) throw new HttpsError('invalid-argument', 'Every speaker needs a name.');
    if (x.email && !EMAIL.test(x.email)) throw new HttpsError('invalid-argument', 'Not an email: ' + x.email);
  });
  const emails = speakers.map(x => x.email).filter(Boolean);
  return { speakers, speaker: speakers.map(x => x.name).join(', '), presenterEmails: emails.filter((e, i) => emails.indexOf(e) === i) };
}

function validSlug(slug){ return typeof slug === 'string' && !!slug && slug.indexOf('/') < 0; }

// A session's doc, or null if there's no such session (or it was deleted).
async function sessionDoc(slug){
  if (!validSlug(slug)) return null;
  const doc = (await db.collection('collabWeekSessions').doc(slug).get()).data();
  return doc && !doc.deletedAt ? doc : null;
}

// A talk → { slug, sessionSlug, doc }, or null.
async function findTalk(slug){
  if (!validSlug(slug)) return null;
  const doc = (await db.collection('collabWeekTalks').doc(slug).get()).data();
  return doc ? { slug, sessionSlug: doc.sessionSlug || '', doc } : null;
}

async function isSessionLead(email, sessionSlug){
  const doc = await sessionDoc(sessionSlug);
  return !!(doc && Array.isArray(doc.leadEmails) && doc.leadEmails.map(e => String(e).toLowerCase()).indexOf(email) >= 0);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// → 'admin' | 'lead' | 'presenter' | null, by the caller's sign-in email.
async function talkRole(email, talk, saved){
  if (await isFullWrite(email)) return 'admin';
  if (await isSessionLead(email, talk.sessionSlug)) return 'lead';
  if (saved && Array.isArray(saved.presenterEmails) && saved.presenterEmails.indexOf(email) >= 0) return 'presenter';
  return null;
}

// Validated text fields → { key: text }.
function talkTextFields(edits, allowed){
  const doc = {};
  Object.keys(edits).forEach(key => {
    if (!(key in allowed)) throw new HttpsError('invalid-argument', 'Unknown field: ' + key);
    const v = String(edits[key] == null ? '' : edits[key]).trim();
    if (v.length > allowed[key]) throw new HttpsError('invalid-argument', 'Too long: ' + key);
    doc[key] = v;
  });
  if ('title' in doc && !doc.title) throw new HttpsError('invalid-argument', 'The title can’t be empty.');
  if (doc.presentationUrl && !/^https?:\/\/\S+$/.test(doc.presentationUrl)) throw new HttpsError('invalid-argument', 'The presentation isn’t a link (https://…).');
  if ('type' in doc && TALK_TYPES.indexOf(doc.type) < 0) throw new HttpsError('invalid-argument', 'A talk is a research talk, a pitch or a keynote.');
  return doc;
}

// data: { slug } → { canEdit, canSetPresenters };
// { slug, edits: { field: text, …, presenterEmails?: [email, …] } } saves them;
// { slug, remove: true } removes it from its session (deletes it);
// { slug, restore: true } puts back a talk removed before 2026-10-10, when
// removing only marked it.
exports.editTalk = onCall(
  async (request) => {
    const email = callerEmail(request);
    const data = request.data || {};
    const talk = await findTalk(data.slug);
    if (!talk) throw new HttpsError('not-found', 'No such talk.');
    const ref = db.collection('collabWeekTalks').doc(talk.slug);
    const role = await talkRole(email, talk, talk.doc);
    const access = { canEdit: !!role, canSetPresenters: role === 'admin' || role === 'lead' };
    if (data.remove || data.restore) {
      if (!talk.sessionSlug) throw new HttpsError('failed-precondition', 'Only a talk in a session can be removed.');
      if (!access.canSetPresenters) throw new HttpsError('permission-denied', 'Only the session’s leads, PIs and admins can remove or restore a talk.');
      if (data.restore) {
        await ref.set({ removed: false, updatedBy: { email, name: request.auth.token.name || '' }, updatedAt: Date.now() }, { merge: true });
        return { removed: false };
      }
      await ref.delete();
      // …and from its session's talk order, if it was reordered.
      const sessionRef = db.collection('collabWeekSessions').doc(talk.sessionSlug);
      if ((await sessionRef.get()).exists) await sessionRef.update({ talkOrder: require('firebase-admin/firestore').FieldValue.arrayRemove(talk.slug) });
      return { removed: true };
    }
    if (!data.edits) return access;
    if (!role) throw new HttpsError('permission-denied', 'Only the talk’s presenters, the session’s leads, PIs and admins can edit this talk.');
    const edits = Object.assign({}, data.edits);
    let fromSpeakers = null;
    if ('speakers' in edits) {
      if (!access.canSetPresenters) throw new HttpsError('permission-denied', 'Only the session’s leads, PIs and admins can change the speakers.');
      fromSpeakers = speakerFields(edits.speakers);
      delete edits.speakers; delete edits.speaker; delete edits.presenterEmails;
    }
    let presenterEmails;
    if ('presenterEmails' in edits) {
      if (!access.canSetPresenters) throw new HttpsError('permission-denied', 'Only the session’s leads, PIs and admins can change the presenters.');
      const list = (Array.isArray(edits.presenterEmails) ? edits.presenterEmails : []).map(e => String(e).trim().toLowerCase()).filter(Boolean);
      const bad = list.find(e => !EMAIL.test(e));
      if (bad) throw new HttpsError('invalid-argument', 'Not an email: ' + bad);
      if (list.length > 20) throw new HttpsError('invalid-argument', 'Too many presenters.');
      presenterEmails = list.filter((e, i) => list.indexOf(e) === i);
      delete edits.presenterEmails;
    }
    delete edits.time;  // no longer stored (see above); pages built before 2026-10-08 still send it
    const doc = talkTextFields(edits, TALK_FIELDS);
    if (presenterEmails) doc.presenterEmails = presenterEmails;
    if (fromSpeakers) Object.assign(doc, fromSpeakers);
    Object.assign(doc, {
      slug: talk.slug,
      sessionSlug: talk.sessionSlug,
      updatedBy: { email, name: request.auth.token.name || '' },
      updatedAt: Date.now(),
    });
    await ref.set(doc, { merge: true });
    return Object.assign(access, { saved: doc });
  }
);

// data: { slug } → { talks }. Deletes a session removed from the schedule
// for good, PIs/admins only: its talks, its own doc, and its place in its
// event's time slots (events/{eventSlug}.days) — the slot too, if it's left empty.
exports.deleteSession = onCall(
  async (request) => {
    const email = callerEmail(request);
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins can delete a session.');
    const slug = String((request.data || {}).slug || '');
    if (!slug || slug.indexOf('/') >= 0) throw new HttpsError('invalid-argument', 'No such session.');
    const ref = db.collection('collabWeekSessions').doc(slug);
    const doc = (await ref.get()).data();
    if (!doc || !doc.removed) throw new HttpsError('failed-precondition', 'Remove the session from the schedule first.');
    const talks = await db.collection('collabWeekTalks').where('sessionSlug', '==', slug).get();
    for (let i = 0; i < talks.docs.length; i += 400) {
      const batch = db.batch();
      talks.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await ref.delete();
    const eventRef = db.collection('events').doc(doc.eventSlug || 'collaboration-week');
    await db.runTransaction(async tx => {
      const event = (await tx.get(eventRef)).data();
      if (!event || !Array.isArray(event.days)) return;
      let changed = false;
      // …and the slot it leaves, if that leaves it empty.
      const days = event.days.map(d => Object.assign({}, d, { slots: (d.slots || []).flatMap(sl => {
        if (!(sl.sessions || []).includes(slug)) return [sl];
        changed = true;
        const rest = sl.sessions.filter(x => x !== slug);
        return sl.kind === 'sessions' && !rest.length ? [] : [Object.assign({}, sl, { sessions: rest })];
      }) }));
      if (changed) tx.update(eventRef, { days, updatedAt: Date.now(), updatedBy: email });
    });
    logger.info('deleteSession', { slug, event: doc.eventSlug || '', talks: talks.size, by: email });
    return { talks: talks.size };
  }
);

// data: { sessionSlug, title, speakers?: [{ name, email }], duration?, type? } → { slug }.
// Its time isn't stored: the pages work it out from the session's order and durations.
// Adds a talk to a session; only its leads and PIs/admins can.
exports.createTalk = onCall(
  async (request) => {
    const email = callerEmail(request);
    const data = request.data || {};
    const sessionSlug = String(data.sessionSlug || '');
    if (!(await sessionDoc(sessionSlug))) throw new HttpsError('not-found', 'No such session.');
    if (!(await isFullWrite(email)) && !(await isSessionLead(email, sessionSlug))) {
      throw new HttpsError('permission-denied', 'Only the session’s leads, PIs and admins can add a talk.');
    }
    const fields = talkTextFields({ title: data.title, speaker: data.speaker, duration: data.duration, type: data.type || 'research-talk' }, TALK_FIELDS);
    const people = data.speakers ? speakerFields(data.speakers) : { speakers: [], presenterEmails: [] };
    if (!fields.title) throw new HttpsError('invalid-argument', 'The title can’t be empty.');
    const stem = fields.title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'talk';
    const slug = stem + '-' + crypto.randomBytes(3).toString('hex');
    const now = Date.now();
    const who = { email, name: request.auth.token.name || '' };
    await db.collection('collabWeekTalks').doc(slug).create(Object.assign(fields, {
      added: true, slug, sessionSlug,
    }, people, {
      createdBy: who, createdAt: now, updatedBy: who, updatedAt: now,
    }));
    return { slug };
  }
);

// ---------- skills ----------
//
// A skill on the site is a Claude skill (skills/{name}: { name, title,
// description, body, files: [{ path, content }] }): SKILL.md is its YAML front
// matter (name, description) plus `body`, and `files` are the rest of its folder
// (assets/…, references/…, scripts/…), text only. Only PIs/admins write them
// (firestore.rules). This serves one as the package Claude loads — a .zip
// holding the folder <name>/ — for claude.ai's upload and for unzipping into
// ~/.claude/skills; public, like the skills themselves, so the install command
// works from a terminal: GET ?skill=<name>.

function skillMd(skill){
  const yaml = (s) => JSON.stringify(String(s || ''));
  return '---\nname: ' + skill.name + '\ndescription: ' + yaml(skill.description) + '\n---\n\n' + String(skill.body || '').replace(/^\s+/, '');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf){
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// [{ path, data: Buffer }] → a .zip (deflated entries, UTF-8 names).
function zipFiles(files){
  const zlib = require('zlib');
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const packed = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    centrals.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([central, end]));
}

function skillZip(skill){
  const files = [{ path: skill.name + '/SKILL.md', data: Buffer.from(skillMd(skill), 'utf8') }];
  (skill.files || []).forEach((f) => {
    const path = String(f.path || '');
    if (!path || path === 'SKILL.md' || path.split('/').some((p) => !p || p === '.' || p === '..')) return;
    files.push({ path: skill.name + '/' + path, data: Buffer.from(String(f.content || ''), 'utf8') });
  });
  return zipFiles(files);
}

exports.skillPackage = onRequest(
  { invoker: 'public', cors: true },
  async (req, res) => {
    const name = String(req.query.skill || '');
    if (!/^[a-z0-9-]{1,64}$/.test(name)) { res.status(400).send('Unknown skill.'); return; }
    const snap = await db.collection('skills').doc(name).get();
    if (!snap.exists) { res.status(404).send('Unknown skill.'); return; }
    const skill = Object.assign({}, snap.data(), { name });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="' + name + '.zip"');
    res.set('Cache-Control', 'no-cache');
    res.send(skillZip(skill));
  }
);

// ---------- history: every version of a tracked document ----------
//
// For each collection in TRACKED, every write to one of its documents is kept as
// a version in <collection>/<id>/versions/{auto id}: { at, by: { email, name },
// note, kind: 'created' | 'edited' | 'deleted', data } — `data` the whole
// document after the change (before it, for a deletion), so a version is read or
// restored on its own; the site compares two versions when showing what changed
// (history.js). Recorded here, not by the pages, so no client can skip or alter
// one (firestore.rules: versions are read-only). Who: the document's `updatedBy`,
// which the rules require to be the signed-in writer's own email (a page about to
// delete a document first stamps it). The note is the document's `changeNote`,
// written with each save. A write that changes only bookkeeping isn't a version.
// `proposedBy` (guides) is whoever proposed the change the writer accepted.
// Each version is also listed in brief in changelog/{version id} (changelog.html):
// { at, by, note, kind, proposedBy, collection, docId, title }; clients only read it.

const TRACKED = ['skills', 'guides', 'handbook'];
const VERSION_META = ['updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'changeNote', 'proposedBy'];

function stableJson(v){
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object' && !(v instanceof require('firebase-admin/firestore').Timestamp)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function versionContent(data){
  const out = Object.assign({}, data || {});
  VERSION_META.forEach((k) => { delete out[k]; });
  return out;
}

async function personFor(email){
  if (!email) return null;
  let name = '';
  try {
    const snap = await db.collection('people').where('email', '==', email).limit(1).get();
    if (!snap.empty) name = snap.docs[0].data().name || '';
  } catch (e) { /* the name is a nicety */ }
  return { email, name };
}

function recordVersions(collection){
  return onDocumentWrittenWithAuthContext({ document: collection + '/{id}', region: 'europe-west2' }, async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (before && after && stableJson(versionContent(before)) === stableJson(versionContent(after))) return;
    const kind = !before ? 'created' : !after ? 'deleted' : 'edited';
    const src = after || before;
    const version = {
      at: Date.now(),
      by: await personFor(typeof src.updatedBy === 'string' ? src.updatedBy : (src.updatedBy && src.updatedBy.email) || ''),
      note: after && typeof after.changeNote === 'string' ? after.changeNote.slice(0, 300) : '',
      kind,
      data: src,
      // A guide's change someone proposed and a PI/admin accepted: who proposed it.
      proposedBy: after && after.proposedBy ? await personFor(after.proposedBy) : null,
      authType: event.authType || '',
    };
    const added = await event.data.after.ref.collection('versions').add(version);
    // The site's changelog (changelog.html) lists it too, in brief: a version
    // holds the whole document, too much to load dozens of at once.
    await db.collection('changelog').doc(added.id).set({
      at: version.at, by: version.by, note: version.note, kind, proposedBy: version.proposedBy,
      collection, docId: event.params.id, title: String(src.title || src.name || event.params.id),
    });
  });
}
TRACKED.forEach((c) => { exports['history' + c.charAt(0).toUpperCase() + c.slice(1)] = recordVersions(c); });

// Exported for the standalone unit test only (see scratchpad) — not part
// of the public Cloud Functions surface, harmless to export alongside it.
exports._internal = {
  projectGroupForCard, allProjectsFromCards, normalizeProjectChannel, keywordCounts,
  flattenMessages, newMessages, cardEventsToNotify, homeRefreshTargetsForReviewers,
  newlyAddedAuthorEmails, reviewsOutCandidates, todayIsoLondon, venueUrl, cardUrl, linkedTitle,
  reviewStateEmoji, verifySlackSignatureRaw, appliedProposal, proposalSummary, proposalOutcome, projectAnnouncement, canAssignReviewer, parseAssignAction,
  reviewerEmailFromAction, cardLine, personOptionsFor, filterPeopleOptions, initialOptionForEmail,
  reviewerPickerBlock, sectionBlocks, buildHomeView, buildUnrecognizedView, profileFieldsFromSlack,
  projectsFromDashboard, badgesForCard, skillMd, skillZip, versionContent, stableJson,
  normalizeMeeting, firstMeetingTimes, meetingRecurrence, projectMembers, normalizeRepo, projectRepoName,
  projectIdOf, projectGroupForCards
};
