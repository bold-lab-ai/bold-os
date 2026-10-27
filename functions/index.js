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

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten, onDocumentWrittenWithAuthContext } = require('firebase-functions/v2/firestore');
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
  // A comment's message links to the comment itself (audit-board: &msg= opens and marks it).
  var linkedMsg = function(id){ return linkedTitle(title, url + '&msg=' + encodeURIComponent(id || '')); };
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
        excludeEmail: afterMsg.authorEmail, comment: true,
        headline: '💬 ' + (afterMsg.author || 'Someone') + ' commented on ' + linkedMsg(afterMsg.id) + ': “' + newBody + '”'
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
        excludeEmail: reply.authorEmail, comment: true,
        headline: '💬 ' + (reply.author || 'Someone') + ' replied on ' + linkedMsg(reply.id) + ': “' + replyBody + '”'
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
        excludeEmail: msg.authorEmail, comment: true,
        headline: '💬 ' + posterName + ' commented on ' + linkedMsg(msg.id) + ': “' + body + '”'
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
    // A tag (@[Name](SlackId), "Tagging people") reads as plain @Name in Slack.
    body: JSON.stringify(body).replace(TAG, '@$1')
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

// An event added by someone who isn't a PI or admin starts hidden: tell the PIs and
// admins, who release it from its page (firestore.rules, events/{slug}).
exports.onEventAdded = onDocumentCreated(
  { document: 'events/{slug}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const data = event.data && event.data.data();
    if (!data || data.hidden !== true || !data.createdBy || await isFullWrite(data.createdBy)) return;
    const snap = await db.collection('people').where('email', '==', data.createdBy).limit(1).get();
    const who = snap.empty ? data.createdBy.split('@')[0] : snap.docs[0].data().name;
    await tellStaff('🔔 ' + slackText(who) + ' added an event, ' + linkedTitle(data.title || event.params.slug, SITE_URL + 'event.html?event=' + encodeURIComponent(event.params.slug)) +
      '. It stays hidden until a PI or admin releases it from its page.', data.createdBy);
  }
);

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
// Everyone, PIs and admins too, changes a guide (guides/{slug}), the
// BOLDiquette (handbook/{slug}) or a skill (skills/{name}, kind 'skill') by proposing it (…/proposals/{id}, see
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
  if (q.kind === 'skill') return 'a change to the skill';
  if (q.kind === 'tool') return 'a change to the tool';
  if (q.kind === 'new') return 'adding it';
  if (q.kind === 'delete') return 'removing it';
  if (q.kind === 'add') return 'a new part, ' + title(q.after);
  if (q.kind === 'remove') return 'removing the part ' + title(q.before);
  if (q.kind === 'move' && q.after && q.after.tab) return 'moving the tab ' + title(q.after);
  if (q.kind === 'move') return 'moving the part ' + title(q.before);
  if (q.kind === 'restore') return 'restoring an earlier version';
  if (q.kind === 'batch') {
    const n = (q.changes || []).length;
    const list = (q.changes || []).slice(0, 3).map((c) => proposalSummary(c));
    return n + ' changes (' + list.join('; ') + (n > 3 ? '; and ' + (n - 3) + ' more' : '') + ')';
  }
  return 'a change to the part ' + title(q.before || q.after);
}

function onProposed(collection, pageUrl){
  return onDocumentCreated(
    { document: collection + '/{slug}/proposals/{id}', secrets: [SLACK_BOT_TOKEN] },
    async function(event){
      const q = event.data && event.data.data();
      if (!q || q.status !== 'open') return;
      const doc = await db.collection(collection).doc(event.params.slug).get();
      // A new skill or tool has no document yet: its proposal carries the title.
      const name = (doc.exists && doc.data().title) || (q.after && q.after.title) || event.params.slug;
      const who = (q.by && (q.by.name || q.by.email)) || 'Someone';
      const link = linkedTitle(slackText(name), pageUrl(event.params.slug) + '#proposals');
      const what = q.kind === 'new' && !doc.exists
        ? ' proposed a new ' + (collection === 'agentTools' ? 'tool' : 'skill') + ', ' + link
        : ' suggested ' + proposalSummary(q) + ' in ' + link;
      const headline = '🔔 ' + slackText(who) + what +
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

// What became of a proposal: edited by whoever proposed it, accepted or declined
// (decideProposal), or withdrawn (deleted while open). Whoever proposed it
// hears it was decided; the PIs and admins, but whoever decided it, hear
// either, so a "needs a decision" message isn't left standing.
// Pure, so it's testable on its own. → { proposer, others } headlines, or null.
function proposalOutcome(before, after, name, url){
  if (!before || before.status !== 'open') return null;
  const who = (before.by && (before.by.name || before.by.email)) || 'Someone';
  const what = proposalSummary(before) + ' in ' + linkedTitle(slackText(name), url);
  if (!after) return { others: '↩️ ' + slackText(who) + ' withdrew ' + what + '. Nothing to decide.' };
  // Edited by whoever proposed it (pages/guide.js): the reviewers hear what it is now.
  if (after.status === 'open' && after.editedAt && after.editedAt !== before.editedAt) {
    return { others: '✏️ ' + slackText(who) + ' edited their suggestion: it’s now ' + proposalSummary(after) + ' in ' + linkedTitle(slackText(name), url) + '.' };
  }
  if (after.status !== 'accepted' && after.status !== 'declined') return null;
  const decider = slackText(after.decidedByName || after.decidedBy || 'A PI or admin');
  const icon = after.status === 'accepted' ? '✅ ' : '✖️ ';
  return {
    proposer: icon + decider + ' ' + after.status + ' your suggestion, ' + what + '.',
    others: icon + decider + ' ' + after.status + ' ' + slackText(who) + '’s suggestion, ' + what + '.',
  };
}

// Pure: what closes a proposal's discussion → { resolvedWith, resolvedBy, resolvedByName }
// once it's accepted, declined or withdrawn (deleted while open), else null.
function proposalClosed(before, after){
  if (!before || before.status !== 'open') return null;
  if (!after) return { resolvedWith: 'withdrawn', resolvedBy: String((before.by && before.by.email) || ''), resolvedByName: String((before.by && before.by.name) || '') };
  if (after.status !== 'accepted' && after.status !== 'declined') return null;
  return { resolvedWith: after.status, resolvedBy: String(after.decidedBy || ''), resolvedByName: String(after.decidedByName || '') };
}

// Its comments are resolved with it, so they leave the open threads (comments.html).
async function resolveProposalComments(collection, slug, id, before, after){
  const closed = proposalClosed(before, after);
  if (!closed) return;
  const snap = await db.collection(collection).doc(slug).collection('comments').where('proposalId', '==', id).get();
  const open = snap.docs.filter(function(d){ return !d.data().resolved; });
  if (!open.length) return;
  const batch = db.batch();
  open.forEach(function(d){ batch.update(d.ref, Object.assign({ resolved: true, resolvedAt: Date.now() }, closed)); });
  await batch.commit();
}

function onProposalDecided(collection, pageUrl){
  return onDocumentWritten(
    { document: collection + '/{slug}/proposals/{id}', secrets: [SLACK_BOT_TOKEN] },
    async function(event){
      const before = event.data.before.exists ? event.data.before.data() : null;
      const after = event.data.after.exists ? event.data.after.data() : null;
      const doc = await db.collection(collection).doc(event.params.slug).get();
      // Deleted with its guide: nothing to tell (but a proposed new skill or tool has no
      // document yet, and an accepted removal has just deleted it).
      const kind = ((after || before) || {}).kind;
      if (!doc.exists && kind !== 'new' && kind !== 'delete') return;
      await resolveProposalComments(collection, event.params.slug, event.params.id, before, after);
      const title = (doc.exists && doc.data().title) || ((before && before.after) || {}).title || event.params.slug;
      const out = proposalOutcome(before, after, title, pageUrl(event.params.slug));
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

// A guide with a page of its own (bold.js BOLD.GUIDE_PAGES) links there.
const GUIDE_PAGES = { 'get-started-at-bold': 'get-started.html' };
const guideUrl = (slug) => SITE_URL + (GUIDE_PAGES[slug] || 'guide.html?guide=' + encodeURIComponent(slug));
// The BOLDiquette is the one handbook document; it has its own page.
const handbookUrl = (slug) => SITE_URL + (slug === 'boldiquette' ? 'boldiquette.html' : 'index.html');
exports.onGuideProposed = onProposed('guides', guideUrl);
exports.onHandbookProposed = onProposed('handbook', handbookUrl);
// A skill has its page; its changes are proposed there too (pages/skill.js).
const skillUrl = (name) => SITE_URL + 'skill.html?skill=' + encodeURIComponent(name);
exports.onSkillProposed = onProposed('skills', skillUrl);
exports.onSkillProposalDecided = onProposalDecided('skills', skillUrl);
// The tools the lab adds for agents (tool.html; functions/api-tools.js).
const toolUrl = (name) => SITE_URL + 'tool.html?tool=' + encodeURIComponent(name);
exports.onToolProposed = onProposed('agentTools', toolUrl);
exports.onToolProposalDecided = onProposalDecided('agentTools', toolUrl);
exports.onGuideProposalDecided = onProposalDecided('guides', guideUrl);
exports.onHandbookProposalDecided = onProposalDecided('handbook', handbookUrl);

// ---------- Tagging people ----------
// A tag is @[Name](SlackId) in any text (mentions.js). Whoever is newly tagged in
// any document gets a DM (onTagged), except: in a guide's or the BOLDiquette's
// comment, with that page's comment digest (below); in a proposed change, at once,
// for the tags it adds (onProposalTagged); accepting it tells nobody again.
const TAG = /@\[([^\]]+)\]\((U[A-Z0-9]+)\)/g;

// The Slack ids tagged anywhere in value (a string, or any data holding strings). Pure.
function taggedIds(value){
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { for (const m of v.matchAll(TAG)) if (out.indexOf(m[2]) === -1) out.push(m[2]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k]));
  };
  walk(value);
  return out;
}

// Who a proposal tags that wasn't tagged already: in the text it proposes (and
// its note), not in the text it replaces, nor in what it proposed before an edit
// (prev). Pure.
function proposalNewTags(prev, q){
  const sides = (x, side) => !x ? [] : [x[side]].concat((x.changes || []).map((c) => c[side]));
  const old = taggedIds(sides(q, 'before')).concat(taggedIds(prev && sides(prev, 'after').concat([prev.note])));
  return taggedIds(sides(q, 'after').concat([q.note])).filter((id) => old.indexOf(id) === -1);
}

// { Slack id: email } for those ids that are on the roster.
async function emailsForSlackIds(ids){
  const out = {};
  for (const id of Array.from(new Set(ids))) {
    const email = await emailForSlackId(id);
    if (email) out[id] = String(email).toLowerCase();
  }
  return out;
}

// The Slack ids tagged in after and not in before. Pure.
function newTags(before, after){
  const old = taggedIds(before);
  return taggedIds(after).filter((id) => old.indexOf(id) === -1);
}

// Where a tag is: { title, url } for a document's path, or null where tags tell
// nobody here: bookkeeping and private collections, and guides and the
// BOLDiquette (their comments and proposed changes tell, above). Pure.
const TAG_SILENT = ['roles', 'people', 'meta', 'settings', 'readPoints', 'changelog', 'commentQueue', 'venueCalls', 'githubLinks', 'googleLinks',
  'letterRequests', 'introRequests', 'joinRequests', 'members', 'hackathonJoins', 'projectWorkspaces', 'guides', 'handbook', 'interactions'];
// An event's page: its own (d.page: Collaboration Week, the Festival) or event.html.
function eventUrl(slug, d){
  return SITE_URL + (d && /^[a-z0-9-]+\.html$/.test(d.page || '') ? d.page : 'event.html?event=' + encodeURIComponent(slug));
}
function tagPlace(path, data){
  const seg = path.split('/');
  if (TAG_SILENT.indexOf(seg[0]) !== -1 || seg.indexOf('versions') !== -1) return null;
  const d = data || {}, id = seg[1], q = encodeURIComponent(id);
  const named = (fallback) => String(d.title || d.label || d.name || fallback);
  if (seg[0] === 'boards' && seg[2] === 'cards' && seg.length === 4) return { title: named('a paper'), url: cardUrl(id, seg[3]) };
  if (seg.length > 2) return { title: named(seg[2]), url: SITE_URL };
  if (seg[0] === 'boards') return { title: named(id), url: venueUrl(id) };
  if (seg[0] === 'events') return { title: named(id), url: eventUrl(id, d) };
  if (seg[0] === 'collabWeekSessions') return { title: named(id), url: SITE_URL + 'session.html?session=' + q };
  if (seg[0] === 'collabWeekTalks') return { title: named(id), url: SITE_URL + 'talk.html?talk=' + q };
  if (seg[0] === 'collabWeekProposals') return { title: named('a session proposal'), url: SITE_URL + 'event-collaboration-week.html' };
  if (seg[0] === 'skills') return { title: named(id), url: SITE_URL + 'skill.html?skill=' + q };
  if (seg[0] === 'projects') return { title: named('a project'), url: projectPageUrl(id) };
  if (seg[0] === 'introOffers') return { title: 'an introduction offer at ' + String(d.org || 'an organisation'), url: introUrl() };
  return { title: named(seg[0]), url: SITE_URL };
}

// The first text in data that tags id, as plain text, shortened. Pure.
function tagExcerpt(data, id){
  let found = '';
  const walk = (v) => {
    if (found) return;
    if (typeof v === 'string') { if (v.indexOf('](' + id + ')') !== -1) found = v; }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k]));
  };
  walk(data);
  const t = found.replace(TAG, '@$1').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}

// On a board card, the comment (discussion or checklist point) that tags id, for its link (&msg=), or ''. Pure.
function tagMessageId(data, id){
  const d = data || {};
  const all = [].concat.apply(flattenMessages(d.discussion), (d.checklist || []).map((it) => flattenMessages(it.comments)));
  const m = all.filter((x) => String(x.body || '').indexOf('](' + id + ')') !== -1).pop();
  return m && m.id ? String(m.id) : '';
}

// Any document anywhere, written by anyone: whoever it newly tags gets a DM.
// Who wrote it: the signed-in person, or the document's updatedBy (a function's write).
function onTagged(document){
  return onDocumentWrittenWithAuthContext({ document, secrets: [SLACK_BOT_TOKEN] }, async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const path = event.data.after.ref.path;
    const place = tagPlace(path, after);
    const ids = place ? newTags(before, after) : [];
    if (!ids.length) return;
    let by = '';
    try { if (event.authType === 'app_user' && event.authId) by = String((await admin.auth().getUser(event.authId)).email || ''); } catch (e) { /* who is a nicety */ }
    if (!by) by = typeof after.updatedBy === 'string' ? after.updatedBy : String((after.updatedBy && after.updatedBy.email) || '');
    by = by.toLowerCase();
    const who = by ? await personFor(by) : null;
    const emails = await emailsForSlackIds(ids);
    try { await recordTags(path, by, emails, Date.now(), place, after); } catch (err){ logger.warn('Recording tags failed', { path, error: String(err && err.message || err) }); }
    for (const id of ids) {
      if (!emails[id] || emails[id] === by) continue;
      const excerpt = tagExcerpt(after, id), msg = /^boards\/[^/]+\/cards\//.test(path) ? tagMessageId(after, id) : '';
      const text = '🏷️ ' + (who ? slackText(who.name || who.email) + ' tagged you' : 'You were tagged') + ' in ' + linkedTitle(slackText(place.title), place.url + (msg ? '&msg=' + encodeURIComponent(msg) : '')) +
        (excerpt ? ': “' + slackText(excerpt) + '”' : '.');
      const sent = await dmBySlackId(SLACK_BOT_TOKEN.value(), id, text);
      logger.info('Tag DM', { path, to: id, by, sent, authType: event.authType, authId: event.authId });
    }
  });
}
// Every document at the top level and one collection down.
exports.onTagged = onTagged('{c1}/{d1}');
exports.onTaggedNested = onTagged('{c1}/{d1}/{c2}/{d2}');

function onProposalTagged(collection, pageUrl){
  return onDocumentWritten(
    { document: collection + '/{slug}/proposals/{id}', secrets: [SLACK_BOT_TOKEN] },
    async function(event){
      const prev = event.data.before.exists ? event.data.before.data() : null;
      const q = event.data.after.exists ? event.data.after.data() : null;
      if (!q || q.status !== 'open') return;
      const ids = proposalNewTags(prev, q);
      if (!ids.length) return;
      const doc = await db.collection(collection).doc(event.params.slug).get();
      if (!doc.exists && q.kind !== 'new') return;
      const by = String((q.by && q.by.email) || '').toLowerCase();
      const text = '🏷️ ' + slackText((q.by && (q.by.name || q.by.email)) || 'Someone') + ' tagged you in a suggested change to ' +
        linkedTitle(slackText((doc.exists && doc.data().title) || (q.after || {}).title || event.params.slug), pageUrl(event.params.slug) + '#proposals') + ': ' + proposalSummary(q) + '.';
      const emails = await emailsForSlackIds(ids);
      for (const id of ids) if (emails[id] && emails[id] !== by) await dmBySlackId(SLACK_BOT_TOKEN.value(), id, text);
    }
  );
}

// ---------- Comments on a guide or the BOLDiquette, in Slack, batched ----------
// A comment (<collection>/{slug}/comments/{id}, comments.js) joins its page's queue
// (commentQueue/{collection}__{slug}, server only); every few minutes the queue of a
// page that has had no new comment for COMMENT_QUIET (or has waited COMMENT_MAX) is
// sent: one message per person, however many comments it holds. New threads go to
// the PIs and admins; replies to whoever is in the thread; nobody hears of their own.
const COMMENT_QUIET = 10 * 60 * 1000;
const COMMENT_MAX = 60 * 60 * 1000;

function onCommented(collection){
  return onDocumentCreated({ document: collection + '/{slug}/comments/{id}' }, async function(event){
    const c = event.data && event.data.data();
    if (!c) return;
    const ref = db.collection('commentQueue').doc(collection + '__' + event.params.slug);
    const item = { id: event.params.id, partId: String(c.partId || ''), parent: c.parent || null, proposalId: c.proposalId || null, quote: String(c.quote || '').slice(0, 200),
      text: String(c.text || '').slice(0, 300), tagged: taggedIds(c.text), by: { email: String((c.by && c.by.email) || '').toLowerCase(), name: String((c.by && c.by.name) || '') }, at: c.at || Date.now() };
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const q = snap.exists ? snap.data() : { collection, slug: event.params.slug, items: [], firstAt: Date.now() };
      q.items = (q.items || []).concat([item]).slice(-200);
      q.lastAt = Date.now();
      tx.set(ref, q);
    });
  });
}
// An edited comment (comments.js): whoever it newly tags joins the queue, and only they hear of it.
function onCommentEdited(collection){
  return onDocumentUpdated({ document: collection + '/{slug}/comments/{id}' }, async function(event){
    const before = event.data.before.data(), c = event.data.after.data();
    const tagged = newTags(before.text, c.text);
    if (!tagged.length) return;
    const ref = db.collection('commentQueue').doc(collection + '__' + event.params.slug);
    const item = { id: event.params.id, partId: String(c.partId || ''), parent: c.parent || null, proposalId: c.proposalId || null, quote: String(c.quote || '').slice(0, 200),
      text: String(c.text || '').slice(0, 300), tagged, tagsOnly: true, by: { email: String((c.by && c.by.email) || '').toLowerCase(), name: String((c.by && c.by.name) || '') }, at: Date.now() };
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const q = snap.exists ? snap.data() : { collection, slug: event.params.slug, items: [], firstAt: Date.now() };
      q.items = (q.items || []).concat([item]).slice(-200);
      q.lastAt = Date.now();
      tx.set(ref, q);
    });
  });
}
exports.onGuideCommentEdited = onCommentEdited('guides');
exports.onHandbookCommentEdited = onCommentEdited('handbook');
exports.onGuideCommented = onCommented('guides');
exports.onHandbookCommented = onCommented('handbook');
exports.onGuideProposalTagged = onProposalTagged('guides', guideUrl);
exports.onHandbookProposalTagged = onProposalTagged('handbook', handbookUrl);
exports.onSkillProposalTagged = onProposalTagged('skills', skillUrl);
exports.onToolProposalTagged = onProposalTagged('agentTools', toolUrl);

// Whether a queue is ready to send: quiet long enough, or waited long enough. Pure.
function commentQueueDue(q, now){
  return !!q && (now - (q.lastAt || 0) >= COMMENT_QUIET || now - (q.firstAt || 0) >= COMMENT_MAX);
}

// Who hears of which comments → { email: [items] }. threads: { rootId: [emails in it] },
// and 'p:<proposal id>': [whoever proposed it and has commented on it]. tagEmails:
// { Slack id: email }; whoever a comment tags hears of it too (taggedYou). Pure.
function commentRecipients(items, staff, threads, tagEmails){
  const out = {};
  const add = (email, it, tagged) => {
    if (!email || email === it.by.email) return;
    const mine = out[email] = out[email] || [];
    const had = mine.filter((x) => x.id === it.id)[0];
    if (had) { if (tagged) had.taggedYou = true; return; }
    mine.push(Object.assign({}, it, tagged ? { taggedYou: true } : {}));
  };
  items.forEach((it) => {
    // On a proposed change: whoever proposed it and whoever's in its discussion.
    // An edit that tags someone new: only they hear of it.
    if (it.tagsOnly) {}
    else if (it.proposalId) (threads['p:' + it.proposalId] || []).forEach((e) => add(e, it));
    else if (!it.parent) staff.forEach((e) => add(e, it));
    else (threads[it.parent] || []).forEach((e) => add(e, it));
    (it.tagged || []).forEach((id) => add((tagEmails || {})[id], it, true));
  });
  return out;
}

// One person's message. Pure.
function commentDigest(items, name, url){
  const n = items.length;
  // A tag (@[Name](SlackId), mentions.js) as plain @Name.
  const untag = (t) => String(t || '').replace(TAG, '@$1');
  items = items.map((it) => Object.assign({}, it, { text: untag(it.text), quote: untag(it.quote) }));
  // Each comment links to itself (#c=, pages/guide.js opens its thread).
  const at = (it, label) => '<' + url + '#c=' + encodeURIComponent(it.id) + '|' + label.replace(/\|/g, '¦') + '>';
  const line = (it) => '• ' + slackText(it.by.name || it.by.email) + (it.taggedYou ? ' tagged you' : '') + ' ' + at(it, it.proposalId ? 'on a proposed change' : it.parent ? 'replied' : 'on “' + slackText(it.quote.length > 60 ? it.quote.slice(0, 60) + '…' : it.quote) + '”') +
    ': ' + slackText(it.text.length > 140 ? it.text.slice(0, 140) + '…' : it.text);
  return '💬 ' + (n === 1 ? 'A new comment' : n + ' new comments') + ' on ' + linkedTitle(slackText(name), url) + '\n' +
    items.slice(0, 5).map(line).join('\n') + (n > 5 ? '\n…and ' + (n - 5) + ' more.' : '');
}

exports.flushCommentQueue = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] },
  async function(){
    const now = Date.now();
    const snap = await db.collection('commentQueue').get();
    for (const doc of snap.docs) {
      const q = doc.data();
      if (!commentQueueDue(q, now)) continue;
      // Taken off the queue first, so a comment arriving meanwhile starts a new one.
      const taken = await db.runTransaction(async (tx) => {
        const s = await tx.get(doc.ref);
        if (!s.exists || s.data().lastAt !== q.lastAt) return null;
        tx.delete(doc.ref);
        return s.data();
      });
      if (!taken || !(taken.items || []).length) continue;
      const page = db.collection(taken.collection).doc(taken.slug);
      const [pageSnap, all, props] = await Promise.all([page.get(), page.collection('comments').get(), page.collection('proposals').get()]);
      if (!pageSnap.exists) continue;
      const threads = {};
      const join = (key, e) => { if (e && (threads[key] = threads[key] || []).indexOf(e) === -1) threads[key].push(e); };
      all.docs.forEach((d) => {
        const c = d.data(), e = c.by && c.by.email ? String(c.by.email).toLowerCase() : '';
        join(c.proposalId ? 'p:' + c.proposalId : c.parent || d.id, e);
      });
      props.docs.forEach((d) => { const q = d.data(); join('p:' + d.id, q.by && q.by.email ? String(q.by.email).toLowerCase() : ''); });
      const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins')).map((e) => String(e).toLowerCase());
      const url = (taken.collection === 'guides' ? guideUrl : handbookUrl)(taken.slug);
      const name = pageSnap.data().title || taken.slug;
      const byPerson = commentRecipients(taken.items, Array.from(new Set(staff)), threads,
        await emailsForSlackIds([].concat.apply([], taken.items.map((it) => it.tagged || []))));
      const token = SLACK_BOT_TOKEN.value();
      await Promise.all(Object.keys(byPerson).map((email) => dmByEmail(token, email, commentDigest(byPerson[email], name, url))));
    }
  }
);

// ---------- Deciding a suggested change to a guide or the BOLDiquette ----------
// A guide (guides/{slug}) or the BOLDiquette (handbook/{slug}) changes only by
// an accepted proposal, a PI's or admin's own included: clients can't change
// their content (firestore.rules), so a PI or admin who didn't propose the
// change accepts or declines it here.
// data: { collection: 'guides' | 'handbook', slug, id, accept: bool } → { status }.

const REVIEWED = ['guides', 'handbook', 'skills', 'agentTools'];

// Who can see what (functions/access.js): the BOLDiquette's table of who can view, edit
// and propose on each page, by group, saved in settings/access when a change to it is accepted.
const access = require('./access')({ db, groupOf, isFullWrite, HttpsError });

// The document with proposal q applied: pure, so it's testable on its own. → { title, description, parts } changed.
function appliedProposal(doc, q){
  // Several changes proposed together (a draft): each in turn, on the result of the last.
  if (q.kind === 'batch') {
    const changes = Array.isArray(q.changes) ? q.changes : [];
    if (!changes.length || changes.length > 50) throw new HttpsError('invalid-argument', 'No changes to apply.');
    let cur = Object.assign({}, doc);
    const out = {};
    changes.forEach((c) => {
      if (!c || c.kind === 'batch' || c.kind === 'restore') throw new HttpsError('invalid-argument', 'Unknown kind of change.');
      const r = appliedProposal(cur, c);
      cur = Object.assign({}, cur, r);
      Object.assign(out, r);
    });
    return out;
  }
  // A skill (skills/{name}): its title, description, instructions and files, as proposed.
  // A new skill or tool: the whole of it, as proposed (decideProposal makes the document).
  if (q.kind === 'new') return Object.assign({}, q.after || {});
  // A tool (agentTools/{name}): its title, description, inputs, whether it acts, and code.
  if (q.kind === 'tool') {
    const a = q.after || {}, out = {};
    ['title', 'description', 'code'].forEach((k) => { if (typeof a[k] === 'string') out[k] = a[k]; });
    if (typeof a.acting === 'boolean') out.acting = a.acting;
    if (a.input && typeof a.input === 'object') out.input = a.input;
    return out;
  }
  if (q.kind === 'skill') {
    const a = q.after || {}, out = {};
    ['title', 'description', 'body'].forEach((k) => { if (typeof a[k] === 'string') out[k] = a[k]; });
    if (Array.isArray(a.files)) out.files = a.files.filter((f) => f && typeof f.path === 'string').map((f) => ({ path: f.path, content: String(f.content || '') }));
    return out;
  }
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
    // A move can take it to another section.
    if (typeof after.section === 'string' && byId[q.partId]) byId[q.partId].section = after.section;
    const moved = order.filter((id) => byId[id]).map((id) => byId[id]);
    return { parts: moved.concat(parts.filter((p) => order.indexOf(p.id) === -1)) };
  }
  throw new HttpsError('invalid-argument', 'Unknown kind of change.');
}

exports.decideProposal = onCall(
  async (request) => {
    const email = signedInEmail(request).toLowerCase();
    const data = request.data || {};
    if (REVIEWED.indexOf(data.collection) === -1 || !/^[a-z0-9_-]{1,64}$/.test(String(data.slug || '')) || !/^[A-Za-z0-9]{1,40}$/.test(String(data.id || ''))) {
      throw new HttpsError('invalid-argument', 'No such proposal.');
    }
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins can do this.');
    const name = request.auth.token.name || '';
    const ref = db.collection(data.collection).doc(data.slug);
    const qRef = ref.collection('proposals').doc(data.id);
    return db.runTransaction(async (tx) => {
      const [snap, qSnap] = await Promise.all([tx.get(ref), tx.get(qRef)]);
      if (!qSnap.exists) throw new HttpsError('not-found', 'No such proposal.');
      const q = qSnap.data();
      // A new skill or tool has no document yet; anything else needs one.
      const creating = q.kind === 'new' && (data.collection === 'skills' || data.collection === 'agentTools');
      if (creating ? snap.exists : !snap.exists) throw new HttpsError(creating ? 'already-exists' : 'not-found', creating ? 'It exists already: propose a change to it instead.' : 'No such proposal.');
      if (q.status !== 'open') throw new HttpsError('failed-precondition', 'It has already been decided.');
      const by = q.by && q.by.email ? String(q.by.email).toLowerCase() : '';
      if (by === email) throw new HttpsError('permission-denied', 'Another PI or admin reviews your own change.');
      // Edited since the page showed it: look at it again first.
      if (typeof data.editedAt === 'number' && (q.editedAt || 0) !== data.editedAt) {
        throw new HttpsError('failed-precondition', 'It has just been edited. Have a look at it again.');
      }
      const now = Date.now();
      if (data.accept) {
        const who = (q.by && (q.by.name || q.by.email)) || '';
        const stamp = { changeNote: String(q.note || ('Proposed by ' + who)).slice(0, 300), updatedAt: now, updatedBy: email, proposedBy: by };
        if (q.kind === 'delete') {
          // Its history credits whoever accepted it, then it goes.
          tx.update(ref, stamp);
          tx.delete(ref);
        } else {
          let fields = appliedProposal(snap.exists ? snap.data() : {}, q);
          // A tool is checked as agents get it (name, inputs, code that compiles: functions/api-tools.js).
          if (data.collection === 'agentTools') {
            try { fields = agentApi.checkTool(data.slug, Object.assign({}, snap.exists ? snap.data() : {}, fields)); }
            catch (err) { throw new HttpsError('failed-precondition', 'It can’t be accepted as it is: ' + err.message); }
          }
          // The BOLDiquette's Who can see what: only PIs' and admins' changes, and only a table
          // the site can read; the site then enforces it (settings/access).
          if (data.collection === 'handbook' && data.slug === 'boldiquette') {
            const before = snap.exists ? snap.data().parts : [];
            const pages = await access.checkTableChange(before, fields.parts || before, by);
            if (pages) tx.set(db.collection('settings').doc('access'), { pages, updatedAt: now, updatedBy: email, proposedBy: by });
          }
          if (creating) tx.set(ref, Object.assign(fields, { name: data.slug, createdAt: now, createdBy: by }, stamp));
          else tx.update(ref, Object.assign(fields, stamp));
        }
      }
      const status = data.accept ? 'accepted' : 'declined';
      tx.update(qRef, { status, decidedBy: email, decidedByName: name, decidedAt: now });
      return { status };
    }).then((r) => { access.forget(); return r; });
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
    // Whoever this write tags hears of it from onTagged instead: not twice.
    const tagged = Object.values(await emailsForSlackIds(newTags(before, after)));
    for (let i = 0; i < events.length; i++){
      const e = events[i];
      await sendEvent(token, e.comment ? Object.assign({}, e, { emails: e.emails.filter((x) => tagged.indexOf(String(x || '').toLowerCase()) === -1) }) : e);
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
// URL (app_home_opened, team_join and user_change for the people roster, plus the
// one-time url_verification handshake) and
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
    // Someone joins the Slack, or changes their name or email, or is deactivated: just
    // their entry in the people roster (the daily syncPeople catches anything missed).
    if (body.type === 'event_callback' && body.event && (body.event.type === 'team_join' || body.event.type === 'user_change')){
      try {
        await upsertPerson(body.event.user);
      } catch (err){
        logger.error('upsertPerson threw', { error: String(err) });
      }
      res.status(200).send('');
      return;
    }
    res.status(200).send('');
  }
);

// One Slack user (users.list's shape, as team_join and user_change send it) → their
// people/{slackId}: written if they have an email, removed once deactivated.
async function upsertPerson(u){
  if (!u || !u.id || u.is_bot || u.id === 'USLACKBOT') return;
  const ref = db.collection('people').doc(u.id);
  if (u.deleted) { await ref.delete(); logger.info('upsertPerson: removed', { slackId: u.id }); return; }
  if (!u.profile || !u.profile.email) { logger.warn('upsertPerson: no email (users:read.email?)', { slackId: u.id }); return; }
  const p = { slackId: u.id, email: u.profile.email, name: u.profile.real_name || u.real_name || u.name || u.profile.email };
  const was = (await ref.get()).data();
  if (was && was.name === p.name && was.email === p.email) return;
  await ref.set(p, { merge: true });
  logger.info('upsertPerson: ' + (was ? 'updated' : 'added'), { slackId: u.id });
}

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
    try { await recordSignUp(request.auth.uid, email.toLowerCase()); } catch (err){ logger.warn('Recording a first sign-in failed', { error: String(err && err.message || err) }); }
    const [pis, admins, group, pages] = await Promise.all([rolesEmails('pis'), rolesEmails('admins'), access.groupFor(email), access.table()]);
    // Their group and Who can see what, for the pages to show what's theirs (BOLD.can).
    return { fullWrite: pis.indexOf(email) !== -1 || admins.indexOf(email) !== -1, group, pages };
  }
);

exports.getMyProfile = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    await access.requireAccess(email, 'profile', 'view');   // Who can see what
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

// The profile's Projects tab: the board's papers (gatherDashboard), plus projects not
// on a venue yet (top-level `projects`, by who registered them and their authors),
// plus `member`: the other projects they're a member of (projectWorkspaces.members).
exports.getMyProjects = onCall(
  async (request) => {
    const email = signedInEmail(request);
    await access.requireAccess(email, 'profile', 'view');   // Who can see what
    const [sections, ownSnap, authSnap, wsSnap] = await Promise.all([
      gatherDashboard(email, PROFILE_PROJECTS_CAP),
      db.collection('projects').where('submittedBy.email', '==', email).get(),
      db.collection('projects').where('authorEmails', 'array-contains', email).get(),
      db.collection('projectWorkspaces').where('members', 'array-contains', email).get(),
    ]);
    const out = projectsFromDashboard(sections);
    const loose = (d) => ({ boardId: null, boardLabel: 'No venue yet', cardId: d.id, title: d.data().title || 'Untitled', badges: badgesForCard(d.data()) });
    out.owner = out.owner.concat(ownSnap.docs.map(loose));
    out.author = out.author.concat(authSnap.docs.map(loose));
    const listed = new Set(out.owner.concat(out.author).map((i) => i.cardId));
    const GROUP = { planned: 'Planned', ongoing: 'Ongoing', submission: 'In submission', completed: 'Completed' };
    out.member = wsSnap.docs.map((d) => d.data()).filter((w) => w.cardId && !listed.has(w.cardId) &&
      !(w.venues || []).some((v) => listed.has(v.cardId)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((w) => ({ boardId: w.boardId || null, boardLabel: GROUP[w.group] || '', cardId: w.cardId, title: w.title || 'Untitled', badges: [] }));
    return out;
  }
);

// Which of the Projects page's four groups a card belongs to. Completed =
// accepted at a venue (the last column, or the outcome Accepted), or marked
// completed on its project page (`completed`: its workspace's completedAt);
// In submission (`submission`) = on a venue's board (`onBoard`), with no outcome yet;
// Ongoing = being worked on: marked so on its project page, or with a weekly meeting
// (`started`: workspaceStarted), or rejected or withdrawn at a venue (the project goes on);
// Planned = the rest.
function projectGroupForCard(card, completed, onBoard, started){
  if (completed || card.status === 'conference' || card.outcome === 'accepted') return 'completed';
  if (onBoard && !card.outcome) return 'submission';
  return onBoard || started ? 'ongoing' : 'planned';
}

// Pure: every card → the Projects page's three lists, most recently updated
// first. `boards` is [{ id, label, status }], `cards` is [{ boardId, id, data }]
// (a card in a pending venue is skipped) and `unassigned` is [{ id, data }] —
// projects registered without a venue yet (top-level `projects` collection).
// Both are cards in the same shape (src/assets/js/card-model.js); the only
// difference is that an unassigned one has no board, so no boardId/link.
// `completedIds` / `startedIds`: projects marked completed on their project page
// (workspaces' completedAt) / being worked on (workspaceStarted).
function allProjectsFromCards(boards, cards, unassigned, completedIds, startedIds){
  const done = new Set(completedIds || []), started = new Set(startedIds || []);
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
    entries.push({ pid: projectIdOf(c.data, c.id), d: c.data, boardId: c.boardId, item: Object.assign(base(c.id, c.data), { boardId: c.boardId, boardLabel: labels[c.boardId], cardId: c.id }) });
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
    return { group: projectGroupForCards(list.map(function(e){ return { data: e.d, boardId: e.boardId || null }; }), done.has(pid), started.has(pid)), updatedAt: Math.max.apply(null, list.map(function(e){ return e.d.updatedAt || 0; })), item: last.item };
  });
  const out = { ongoing: [], submission: [], completed: [], planned: [] };
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
    await access.requireAccess(email, 'projects', 'view');   // Who can see what
    const [boardsSnap, cardsSnap, unassignedSnap, wsSnap] = await Promise.all([
      db.collection('boards').get(),
      db.collectionGroup('cards').get(),
      db.collection('projects').get(),
      db.collection('projectWorkspaces').get()
    ]);
    const groups = allProjectsFromCards(
      boardsSnap.docs.map(function(d){ return { id: d.id, label: d.data().label, status: d.data().status || 'approved' }; }),
      cardsSnap.docs.map(function(d){ return { boardId: d.ref.parent.parent.id, id: d.id, data: d.data() }; }),
      unassignedSnap.docs.map(function(d){ return { id: d.id, data: d.data() }; }),
      wsSnap.docs.filter(function(d){ return d.data().completedAt > 0; }).map(function(d){ return d.id; }),
      wsSnap.docs.filter(function(d){ return workspaceStarted(d.data()); }).map(function(d){ return d.id; })
    );
    const items = groups.ongoing.concat(groups.submission, groups.completed, groups.planned);
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
    await access.requireAccess(email, 'projects', 'view');   // Who can see what
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
// and the bot's own name (for telling people whom to invite), from auth.test and its profile.
let slackAuthCache = null;
async function slackAuthInfo(token){
  if (!slackAuthCache){
    const auth = await slackFetch(token, 'auth.test', {});
    if (!auth.ok) return null;
    // auth.test gives the bot's original username (mlconferencecycle); people know it by
    // the name it shows in Slack now (BOLD OS), its profile's.
    let me = null;
    if (auth.user_id) try {
      me = await (await fetch('https://slack.com/api/users.info?' + new URLSearchParams({ user: auth.user_id }), { headers: { 'Authorization': 'Bearer ' + token } })).json();
    } catch (e){ me = null; }
    const p = (me && me.ok && me.user && me.user.profile) || {};
    slackAuthCache = { teamId: auth.team_id, bot: p.display_name || p.real_name || auth.user, url: auth.url || '' };
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
// mode 'rename' { from, project: { id, board } }: a project's page changing its
// channel. The new name existing already, it's just linked; otherwise the project's
// old channel (`from`, which must be the project's) is renamed in Slack (the bot
// can only rename channels it's in, such as those it created), and with no old
// channel to rename, it's created as for 'ensure'. Only who can edit the project.
exports.projectChannel = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    await access.requireAccess(email, 'projects', 'view');   // Who can see what
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
    if (data.mode === 'rename' && !out.exists){
      const p = data.project || {};
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(p.id || '')) || (p.board && !/^[A-Za-z0-9_-]{1,80}$/.test(String(p.board)))) throw new HttpsError('invalid-argument', 'No such project.');
      const cardSnap = await cardRefFor(String(p.id), p.board ? String(p.board) : null).get();
      if (!cardSnap.exists) throw new HttpsError('not-found', 'No such project.');
      const card = cardSnap.data();
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only whoever registered the project, its authors, or a PI or admin can change its channel.');
      const old = normalizeProjectChannel(data.from), current = normalizeProjectChannel(card.slackChannel);
      if (old.error || current.error || old.name !== current.name) throw new HttpsError('failed-precondition', 'The project\u2019s channel has changed: reload the page.');
      const oldId = await slackChannelId(token, old.name);
      if (oldId){
        const renamed = await slackFetch(token, 'conversations.rename', { channel: oldId, name: n.name });
        channelNamesCache = null;
        if (!renamed.ok){
          const auth = await slackAuthInfo(token);
          logger.warn('Renaming a project channel failed', { from: old.name, to: n.name, error: renamed.error });
          throw new HttpsError('failed-precondition', 'Slack wouldn\u2019t let ' + (auth && auth.bot ? '@' + auth.bot : 'the BOLD Slack app') +
            ' rename #' + old.name + ' (' + renamed.error + '). Rename it in Slack, then save the new name here.');
        }
        return Object.assign(out, { exists: true, renamed: true, url: await slackChannelUrl(token, oldId) });
      }
    }
    if (out.exists || (data.mode !== 'ensure' && data.mode !== 'rename')) return out;

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
    await access.requireAccess(email, 'projects', 'edit');   // Who can see what
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
// Google account, with the scopes calendar.events, drive.file and gmail.send
// (functions/tools/google-token.js makes it).
const GOOGLE_OAUTH = defineSecret('GOOGLE_OAUTH');
const { FieldValue } = require('firebase-admin/firestore');
const PROJECT_TZ = 'Europe/London';
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Pure: a meeting as sent by a page → { day, time, minutes, every, until?, link? } or { error }.
// day: 'MO'…'SU'; time: 'HH:MM' in London; minutes: 15–240 in 15s; every: 1–4 weeks;
// link: an existing meeting link (https) used instead of a new Google Meet.
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
  // Until when it runs (YYYY-MM-DD, the last day it may fall on), or for good.
  const until = String(m.until || '');
  if (until && !(/^\d{4}-\d{2}-\d{2}$/.test(until) && !isNaN(Date.parse(until)))) return { error: 'Give a valid end date.' };
  if (until && until < todayIsoLondon()) return { error: 'The end date has passed.' };
  const link = String(m.link || '').trim();
  if (link && !(link.length <= 500 && /^https:\/\/[^\s"<>]+$/.test(link))) return { error: 'Give a meeting link starting with https://' };
  const out = { day, time, minutes, every };
  if (until) out.until = until;
  if (link) out.link = link;
  return out;
}

// Pure: how a new event is joined: the meeting's own link (as its location), or a new Google Meet.
function eventConference(meeting, requestId){
  return meeting.link ? { location: meeting.link } : { conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } };
}
// Pure: what brings an existing event's link in line with the meeting (switching to its
// own link drops the Google Meet; dropping it makes one), or null.
function conferenceChange(ev, meeting, requestId){
  if (meeting.link) return ev.location !== meeting.link || ev.hangoutLink ? { location: meeting.link, conferenceData: null } : null;
  return ev.hangoutLink ? null : Object.assign({ location: '' }, eventConference(meeting, requestId));
}

// Pure: whether two meetings fall at the same times (an end date aside).
function sameMeetingTimes(a, b){
  return !!a && !!b && a.day === b.day && a.time === b.time && a.minutes === b.minutes && a.every === b.every;
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

// `pausedAt` (ms): a paused meeting's series ends then (UNTIL), so its upcoming dates
// leave everyone's calendar while the event, its invitation and Meet link stay; resuming
// takes UNTIL off again.
// A meeting with an end date (`until`) ends the series that day, or when paused if sooner.
function meetingRecurrence(m, pausedAt){
  const ends = [pausedAt || 0, m.until ? Date.parse(m.until + 'T23:59:59Z') : 0].filter(Boolean);
  const until = ends.length ? ';UNTIL=' + new Date(Math.min.apply(null, ends)).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') : '';
  return ['RRULE:FREQ=WEEKLY' + (m.every > 1 ? ';INTERVAL=' + m.every : '') + ';BYDAY=' + m.day + until];
}

function nowHmLondon(){
  return new Intl.DateTimeFormat('en-GB', { timeZone: PROJECT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

// Pure: the project's members, lowercase and once each: whoever registered it,
// its authors, then whoever joined. An address pasted with its brackets
// ("<a@b.org>") is cleaned; anything that still isn't an address is left out, since
// Drive and Calendar refuse it and would stop everyone after it being added.
function projectMembers(card, joined){
  const out = [];
  [card.submittedBy && card.submittedBy.email].concat(card.authorEmails || [], joined || []).forEach(function(e){
    const v = String(e || '').trim().toLowerCase().replace(/^[<\s]+|[>\s,;]+$/g, '');
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v) && out.indexOf(v) < 0) out.push(v);
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
  if (ws.meeting && ws.meeting.link) lines.unshift('Join: <a href="' + ws.meeting.link + '">' + ws.meeting.link + '</a>');
  return lines.join('<br>');
}

// Pure: a Calendar event → the day its series starts (YYYY-MM-DD, London), or ''. A
// meeting every N weeks falls on the weeks N apart from it (calendar.html places it so).
function seriesStart(ev){
  const t = ev && ev.start && (ev.start.dateTime || ev.start.date);
  return t ? String(t).slice(0, 10) : '';
}

function eventTimes(meeting, pausedAt){
  const t = firstMeetingTimes(meeting, todayIsoLondon(), nowHmLondon());
  return {
    start: { dateTime: t.start, timeZone: PROJECT_TZ },
    end: { dateTime: t.end, timeZone: PROJECT_TZ },
    recurrence: meetingRecurrence(meeting, pausedAt)
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

// Pure: whether a workspace counts as being worked on: marked ongoing, or it has a weekly meeting.
function workspaceStarted(ws){ return !!(ws && (ws.startedAt || ws.meeting)); }

// Pure: a project's group from its cards ([{ data, boardId }], oldest first): completed
// if marked so or accepted at any venue; otherwise its latest card's.
function projectGroupForCards(cards, completed, started){
  if (completed || cards.some(function(c){ return projectGroupForCard(c.data) === 'completed'; })) return 'completed';
  const last = cards[cards.length - 1];
  return projectGroupForCard(last.data, false, !!last.boardId, started);
}

// What a page reads: the workspace, as stored.
function workspaceView(ws){
  const out = {};
  ['cardId', 'boardId', 'venues', 'title', 'group', 'completedAt', 'startedAt', 'pausedAt', 'slackChannel', 'members', 'joined', 'meeting', 'eventLink', 'meetUrl',
    'deckUrl', 'notesUrl', 'noDocs', 'skipped', 'slackSkipped', 'error', 'repo', 'repoName', 'repoUrl', 'repoError', 'work'].forEach(function(k){ if (ws[k] !== undefined) out[k] = ws[k]; });
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
  // One the lab already has: its name in bold-lab-ai (or its github.com address).
  if (r.mode === 'existing'){
    const n = repoNameOf(r.name);
    return n ? { mode: 'existing', name: n } : { error: 'Give a repository in ' + GITHUB_ORG + ', as its name or its GitHub address.' };
  }
  return { error: 'Choose a repository.' };
}
// Pure: "bold-os", "bold-lab-ai/bold-os" or "https://github.com/bold-lab-ai/bold-os" → "bold-os"; '' if it isn't one of the org's.
function repoNameOf(s){
  s = String(s || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /^(?:([A-Za-z0-9-]+)\/)?([A-Za-z0-9_.-]{1,100})$/.exec(s);
  if (!m || (m[1] && m[1].toLowerCase() !== GITHUB_ORG)) return '';
  return m[2];
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
    // Planned, ongoing, in submission or completed, as on the Projects page (the meetings page leaves out completed ones).
    patch.group = projectGroupForCards(cards, !!ws.completedAt, workspaceStarted({ startedAt: ws.startedAt, meeting: meeting !== undefined ? meeting : ws.meeting }));
    patch.slackChannel = card.slackChannel || '';
    const everyone = [];
    cards.forEach(function(c){ projectMembers(c.data, []).forEach(function(e){ if (everyone.indexOf(e) < 0) everyone.push(e); }); });
    patch.members = projectMembers({ authorEmails: everyone }, ws.joined);
    patch.joined = ws.joined || [];
    if (!ws.createdAt) patch.createdAt = Date.now();
    // Kept even if Google or GitHub fails below, so trying again picks them up.
    if (meeting !== undefined) patch.meeting = meeting;
    if (repo !== undefined) patch.repo = repo;
    // Slides and notes: left out if whoever registered it chose so; Set up makes them.
    if (changes.docs !== undefined) patch.noDocs = changes.docs === false;
    if (changes.skipped) patch.skipped = changes.skipped;
    await save();

    try {
      // Slides, then notes (which link the slides): saved as each is made, so a
      // failure part way never makes the same file twice.
      const folder = !ws.noDocs && (!ws.deckId || !ws.notesId) ? await projectFolderId() : null;
      if (!ws.noDocs && !ws.deckId){
        const f = await createDeck(ws.title, folder);
        patch.deckId = f.id; patch.deckUrl = f.webViewLink; await save();
      }
      if (!ws.noDocs && !ws.notesId){
        const f = await createNotes(ws.title, folder, { page: projectPageUrl(ws.cardId, ws.boardId), deck: ws.deckUrl });
        patch.notesId = f.id; patch.notesUrl = f.webViewLink; await save();
      }
      // Each member's address for Google: their linked Google account, or their Slack email.
      const addrs = await googleAddressesFor(ws.members);
      // Files: shared with every member, unshared from whoever left.
      const shared = ws.shared || [];
      for (const e of addrs.filter(function(m){ return ws.deckId && ws.notesId && shared.indexOf(m) < 0; })){
        await shareFile(ws.deckId, e); await shareFile(ws.notesId, e);
        patch.shared = (ws.shared || []).concat(e); await save();
      }
      for (const e of shared.filter(function(m){ return addrs.indexOf(m) < 0; })){
        await unshareFile(ws.deckId, e); await unshareFile(ws.notesId, e);
        patch.shared = ws.shared.filter(function(m){ return m !== e; }); await save();
      }

      // The meeting: Google emails the guests an invitation, or a change, or a cancellation.
      // A completed project's meeting is cancelled; the time is kept, so it comes back
      // if the project is reopened. A paused one keeps its event, its series ended
      // (meetingRecurrence); one paused before it was made waits to be resumed.
      const wantEvent = !!ws.meeting && ws.group !== 'completed' && !(ws.pausedAt && !ws.eventId);
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
          guestsCanModify: false
        }, eventConference(ws.meeting, 'bold-' + id + '-' + Date.now()), eventTimes(ws.meeting)));
        patch.eventId = ev.id; patch.eventLink = ev.htmlLink; patch.meetUrl = ws.meeting.link || ev.hangoutLink || '';
        patch.eventMeeting = ws.meeting; patch.eventStart = seriesStart(ev);
        await save();
      } else if (!wantEvent && ws.eventId){
        await googleFetch('DELETE', CAL + '/' + ws.eventId + '?sendUpdates=all').catch(function(err){ if (err.status !== 410 && err.status !== 404) throw err; });
        patch.eventId = FieldValue.delete(); patch.eventLink = FieldValue.delete();
        patch.meetUrl = FieldValue.delete(); patch.eventMeeting = FieldValue.delete(); patch.eventPausedAt = FieldValue.delete();
        patch.eventStart = FieldValue.delete();
        await save();
        ['eventId', 'eventLink', 'meetUrl', 'eventMeeting', 'eventPausedAt', 'eventStart'].forEach(function(k){ delete ws[k]; });
      } else if (ws.eventId){
        const ev = await googleFetch('GET', CAL + '/' + ws.eventId);
        const change = {};
        const want = attendees(ev.attendees);
        if (JSON.stringify(want.map(function(a){ return a.email; })) !== JSON.stringify((ev.attendees || []).map(function(a){ return a.email; }))) change.attendees = want;
        if (ev.summary !== ws.title) change.summary = ws.title;
        const desc = eventDescription(ws);
        if (ev.description !== desc) change.description = desc;
        // A new time moves the series; a new end date or a pause only changes how long it runs.
        if (!sameMeetingTimes(ws.eventMeeting, ws.meeting)) Object.assign(change, eventTimes(ws.meeting, ws.pausedAt));
        else if ((ws.eventMeeting.until || '') !== (ws.meeting.until || '') || (ws.pausedAt || 0) !== (ws.eventPausedAt || 0)) change.recurrence = meetingRecurrence(ws.meeting, ws.pausedAt);
        Object.assign(change, conferenceChange(ev, ws.meeting, 'bold-' + id + '-' + Date.now()));
        let now = ev;
        if (Object.keys(change).length){
          now = await googleFetch('PATCH', CAL + '/' + ws.eventId + '?conferenceDataVersion=1&sendUpdates=all', change) || ev;
          patch.eventMeeting = ws.meeting; patch.eventPausedAt = ws.pausedAt || FieldValue.delete(); patch.eventStart = seriesStart(now); await save();
        } else if (!ws.eventStart && seriesStart(ev)){ patch.eventStart = seriesStart(ev); await save(); }
        const url = ws.meeting.link || now.hangoutLink || '';
        if (url !== (ws.meetUrl || '')){ patch.meetUrl = url; await save(); }
      }
      patch.error = FieldValue.delete();
    } catch (err){
      logger.error('Setting up the project\u2019s meeting, slides and notes failed', { id, error: String(err && err.message || err) });
      patch.error = err instanceof HttpsError ? err.message : 'Couldn\u2019t set up the meeting, slides and notes.';
    }
    await save();

    try {
      if (ws.repo && ws.repo.mode === 'existing' && !ws.repoName){
        let r;
        try { r = await githubApp('GET', '/repos/' + GITHUB_ORG + '/' + ws.repo.name); }
        catch (err){
          if (err.status === 404) throw new HttpsError('not-found', GITHUB_ORG + '/' + ws.repo.name + ' isn’t there, or BOLD.OS can’t see it.');
          throw err;
        }
        patch.repoName = r.name; patch.repoUrl = r.html_url; await save();
      }
      if (ws.repo && ws.repo.mode !== 'existing' && !ws.repoName){
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
      await syncWorkspace(pid, { meeting: m && !m.error ? m : undefined, repo: r && !r.error ? r : undefined, docs: after.setUpDocs === false ? false : undefined,
        skipped: Array.isArray(after.setUpSkipped) ? after.setUpSkipped.filter(function(k){ return ['channel', 'announce', 'meeting', 'docs', 'repo'].indexOf(k) >= 0; }) : undefined });
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
    // announce: false, whoever registered it chose not to (its workspace's `skipped`
    // says so, and its page offers to announce it later: projectWorkspace 'announce').
    if (!card || card.announce === false) return;
    await announceProject(card, event.params.cardId).catch(function(err){ logger.warn('Announcing a new project failed', { error: String(err.message) }); });
  }
);
async function announceProject(card, cardId){
  const token = SLACK_BOT_TOKEN.value();
  const channel = await slackChannelId(token, ACTIVE_PROJECTS_CHANNEL);
  if (!channel) throw new Error('The BOLD.OS app can’t see #' + ACTIVE_PROJECTS_CHANNEL + ': invite it to the channel.');
  const posted = await slackFetch(token, 'chat.postMessage', {
    channel, text: projectAnnouncement(card, projectPageUrl(cardId)), unfurl_links: false,
  });
  if (!posted.ok) throw new Error('Slack said ' + posted.error + '.');
}

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
//   not; editors only.
// - 'start' / 'plan': marks the project ongoing (being worked on) or back to planned;
//   editors only. On a venue's board it's in submission either way; with a weekly meeting, ongoing.
// - 'pause' / 'resume': pauses its meeting (its upcoming dates come off Google Calendar;
//   the same event, invitation and Meet link stay) or brings it back; editors only. Completion by acceptance at a venue needs neither.
// - 'submit': submits the project to another venue ({ venue, card }: a card the page
//   built); editors only; → { cardId, boardId }.
// - 'announce': announces it in #all-active-projects, if that was skipped when it was
//   registered (its workspace's `skipped`); editors only.
// - 'slack': invites the caller to its Slack channel, if they skipped it when joining
//   (`slackSkipped`).
// Whatever was skipped when it was registered is in the workspace's `skipped`
// ('channel', 'announce', 'meeting', 'docs', 'repo'); the page offers each again.
// - 'templates': no project; the org's template repositories → { templates: [{ name, description }] }.
// - 'mine': no project; the caller's projects not yet completed, set up if they
//   weren't yet → { projects: [{ id, title, cardId, boardId }] }.
// - 'venues': no project; the approved venues → { venues: [{ id, label, deadline }] }.
// → the workspace (workspaceView), plus { slack: { status, url } | { error } } on 'join'.
// A presentation's file (slides, a poster, a PDF) uploaded into the lab's Drive, in the
// projects' folder: a project's presentation (project: its workspace id; its members
// and PIs/admins) or a talk on an event's programme (talk: its slug; whoever can edit
// it, talkRole). { project | talk, name, type, size } → { url }: a
// resumable upload session the browser sends the file to itself (so no size limit here),
// made for the page's origin so Drive lets it in. { project, file } → { url }: once it's
// there, anyone with the link can view it, and its link goes in the slides field.
const PRESENTATION_MAX = 300 * 1024 * 1024;
const UPLOAD_ORIGINS = [new URL(SITE_URL).origin, 'http://localhost:8137', 'http://127.0.0.1:8137'];
exports.presentationFile = onCall(
  { secrets: [GOOGLE_OAUTH] },
  async (request) => {
    const email = callerEmail(request), data = request.data || {};
    await access.requireAccess(email, 'projects', 'edit');   // Who can see what
    // owner: what the file is for ('project:<id>' or 'talk:<slug>'), and its title.
    let owner, title;
    if (data.talk){
      const talk = await findTalk(String(data.talk));
      if (!talk) throw new HttpsError('not-found', 'No such talk.');
      if (!(await talkRole(email, talk, talk.doc))) throw new HttpsError('permission-denied', 'Only the talk’s speakers, its session’s leads and PIs/admins can add its files.');
      owner = 'talk:' + talk.slug; title = talk.doc.title || '';
    } else {
      const project = String(data.project || '');
      if (!validSlug(project)) throw new HttpsError('invalid-argument', 'No project given.');
      const ws = (await db.collection('projectWorkspaces').doc(project).get()).data();
      if (!ws) throw new HttpsError('not-found', 'That project isn’t set up yet.');
      if ((ws.members || []).map(lowerEmail).indexOf(email) < 0 && !(await isFullWrite(email)))
        throw new HttpsError('permission-denied', 'Only the project’s members can add its files.');
      owner = 'project:' + project; title = ws.title || '';
    }
    if (data.file){
      const id = String(data.file);
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new HttpsError('invalid-argument', 'No file given.');
      const f = await googleFetch('GET', DRIVE + '/' + id + '?fields=id,webViewLink,appProperties');
      if (!f || !f.appProperties || f.appProperties.boldFor !== owner) throw new HttpsError('permission-denied', 'That file isn’t for this.');
      await googleFetch('POST', DRIVE + '/' + id + '/permissions', { type: 'anyone', role: 'reader' });
      logger.info('presentationFile: uploaded', { for: owner, file: id, by: email });
      return { url: f.webViewLink };
    }
    const name = String(data.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 200), size = Number(data.size) || 0;
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(data.type || '')) ? String(data.type) : 'application/octet-stream';
    if (!name) throw new HttpsError('invalid-argument', 'The file has no name.');
    if (!size || size > PRESENTATION_MAX) throw new HttpsError('invalid-argument', 'Files up to 300 MB.');
    const origin = String((request.rawRequest && request.rawRequest.headers.origin) || '');
    const headers = { 'Authorization': 'Bearer ' + await googleToken(), 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(size) };
    if (UPLOAD_ORIGINS.indexOf(origin) >= 0) headers.Origin = origin;
    const meta = { name: (title ? title + ' — ' : '') + name, parents: [await projectFolderId()], appProperties: { boldFor: owner } };
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers, body: JSON.stringify(meta) });
    const url = res.headers.get('location');
    if (!res.ok || !url){
      logger.warn('presentationFile: Drive refused the upload', { status: res.status, body: (await res.text()).slice(0, 300) });
      throw new HttpsError('unavailable', 'Google Drive didn’t take the file — try again.');
    }
    return { url };
  }
);

exports.projectWorkspace = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN, GITHUB_APP], timeoutSeconds: 540 },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'projects', 'view');   // Who can see what
    const data = request.data || {};
    if (data.action === 'templates') return { templates: await projectTemplates() };
    if (data.action === 'mine'){
      // The caller's projects not yet completed: those whose cards name them (as
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
        Object.keys(ws).filter(function(id){ return ws[id].completedAt; }),
        Object.keys(ws).filter(function(id){ return workspaceStarted(ws[id]); }));
      const named = {};
      venueCards.concat(ownCards).forEach(function(c){
        if (projectMembers(c.data, []).indexOf(email) >= 0) named[projectIdOf(c.data, c.id)] = true;
      });
      const mine = groups.planned.concat(groups.ongoing, groups.submission).filter(function(i){
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
      // Set up makes whatever's missing, the slides and notes too.
      const changes = data.action === 'setUp' ? { docs: true } : {};
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

    if (data.action === 'pause' || data.action === 'resume'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project\u2019s submitter, authors, PIs and admins can do this.');
      await wsRef.set(data.action === 'pause'
        ? { pausedAt: Date.now(), pausedBy: email }
        : { pausedAt: FieldValue.delete(), pausedBy: FieldValue.delete() }, { merge: true });
      return workspaceView(await syncWorkspace(pid));
    }

    // Ongoing (being worked on) or back to planned; a project on a venue's board is in submission either way.
    if (data.action === 'start' || data.action === 'plan'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project\u2019s submitter, authors, PIs and admins can do this.');
      await wsRef.set(data.action === 'start'
        ? { startedAt: Date.now(), startedBy: email }
        : { startedAt: FieldValue.delete(), startedBy: FieldValue.delete() }, { merge: true });
      return workspaceView(await syncWorkspace(pid));
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
      ['id', 'setUpMeeting', 'setUpRepo', 'setUpDocs', 'setUpSkipped', 'announce'].forEach(function(k){ delete c[k]; });
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
      const noSlack = joining && data.slack === false && !!card.slackChannel;
      await wsRef.set({ joined: joining
        ? FieldValue.arrayUnion(email)
        : FieldValue.arrayRemove(email), slackSkipped: noSlack ? FieldValue.arrayUnion(email) : FieldValue.arrayRemove(email) }, { merge: true });
      const out = workspaceView(await syncWorkspace(pid));
      // data.slack === false: not invited to the channel (they chose so).
      if (joining && card.slackChannel && data.slack !== false){
        const n = normalizeProjectChannel(card.slackChannel);
        try { out.slack = await inviteToProjectChannel(SLACK_BOT_TOKEN.value(), email, n.name); }
        catch (err){ out.slack = { error: err.message || 'Couldn’t add you to the Slack channel.' }; }
      }
      return out;
    }
    if (data.action === 'slack'){
      if (!card.slackChannel) throw new HttpsError('failed-precondition', 'It has no Slack channel yet.');
      const out = await inviteToProjectChannel(SLACK_BOT_TOKEN.value(), email, normalizeProjectChannel(card.slackChannel).name);
      await wsRef.set({ slackSkipped: FieldValue.arrayRemove(email) }, { merge: true });
      return out;
    }

    if (data.action === 'announce'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project\u2019s submitter, authors, PIs and admins can do this.');
      try { await announceProject(card, id); }
      catch (err){ throw new HttpsError('failed-precondition', err.message); }
      await wsRef.set({ skipped: FieldValue.arrayRemove('announce') }, { merge: true });
      return { ok: true };
    }

    // Its work board (projectWork): on or off, the repositories it shows, and whether it
    // shows the proposed changes to the site's content (PIs and admins only: that's the
    // whole lab's). data.work: any of { on, repos, content }.
    if (data.action === 'work'){
      const w = data.work && typeof data.work === 'object' ? data.work : {};
      const full = await isFullWrite(email);
      if (!full && !(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project’s submitter, authors, PIs and admins can do this.');
      const ws = (await wsRef.get()).data() || {};
      const next = Object.assign({ on: false, repos: [], content: false }, ws.work || {});
      if (w.on !== undefined) next.on = !!w.on;
      if (w.content !== undefined && !!w.content !== !!next.content){
        if (!full) throw new HttpsError('permission-denied', 'Only PIs and admins can show the site’s proposed changes on a board.');
        next.content = !!w.content;
      }
      if (w.repos !== undefined){
        if (!Array.isArray(w.repos) || w.repos.length > 5) throw new HttpsError('invalid-argument', 'Up to 5 repositories.');
        const names = [];
        for (const x of w.repos){
          const n = repoNameOf(x);
          if (!n) throw new HttpsError('invalid-argument', String(x).slice(0, 100) + ' isn’t a repository in ' + GITHUB_ORG + '.');
          if (names.indexOf(n) >= 0) continue;
          // Only ones BOLD.OS can see.
          try { await githubApp('GET', '/repos/' + GITHUB_ORG + '/' + n); }
          catch (err){
            if (err instanceof HttpsError) throw err;
            throw new HttpsError('not-found', GITHUB_ORG + '/' + n + ' isn’t there, or BOLD.OS can’t see it.');
          }
          names.push(n);
        }
        next.repos = names;
      }
      next.updatedAt = Date.now(); next.updatedBy = email;
      await wsRef.set({ work: next }, { merge: true });
      workCache.delete(pid);
      return { work: next };
    }
    throw new HttpsError('invalid-argument', 'Unknown action.');
  }
);

// --- Work boards: everything in the works, and everything waiting on someone (project page, Work tab) ---
// The board's own cards are projectWorkspaces/{pid}/work/{id} (firestore.rules), read
// live by the page; projectWork adds what's happening elsewhere. Every item says what
// it's about, its type (code, content or a request), who it's from (`by`) and who's on
// it (`on`, or `waiting` when it's waiting on someone not named, such as "a PI or
// admin"), and sits in a column: To do, In progress, Waiting for review, Done (the last 14 days).
// - GitHub, from the board's repositories: open issues (To do; In progress once
//   someone has it), pull requests (a draft In progress, open In review, merged
//   Done) and recently closed issues (Done). Needs the GitHub App's Issues and Pull
//   requests: read.
// - With `content` on (BOLD OS's board): everything on BOLD.OS waiting on someone,
//   each only for those who'd see it on its own page:
//   - proposed changes to the BOLDiquette, guides, skills and tools (content);
//   - requests (type request): to join BOLD, to change group, recommendation letters,
//     introductions, joining a supervision meeting, letting an agent act, new venues.
// People are named as on BOLD.OS: a GitHub login becomes the name of whoever linked it.
// A card linking a pull request, an issue or a proposal shows as one (the page joins them).
const WORK_DAYS = 14;
const WORK_COLUMNS = ['todo', 'doing', 'review', 'done'];
const workCache = new Map();   // pid → { at, items, errors } (the caller-independent part: GitHub)
const PIS_ADMINS = 'a PI or admin';

// Pure: an issue's or pull request's numbers it closes ("Closes #12", "fixes #3").
function closesIssues(body){
  const out = [], re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(String(body || '')))) if (out.indexOf(Number(m[1])) < 0) out.push(Number(m[1]));
  return out;
}

// Pure: a GitHub issue or pull request → a board item. `who(login)` → a person.
function githubWorkItem(repo, x, isPr, who){
  const since = function(t){ return t ? Date.parse(t) : 0; };
  const base = {
    source: 'github', type: 'code', kind: isPr ? 'pr' : 'issue', ref: (GITHUB_ORG + '/' + repo + '#' + x.number).toLowerCase(), repo, number: x.number,
    title: String(x.title || ''), url: x.html_url, by: who(x.user && x.user.login)
  };
  if (!isPr){
    const on = (x.assignees || []).map(function(a){ return who(a.login); });
    if (x.state === 'closed') return Object.assign(base, { column: 'done', state: 'closed', since: since(x.closed_at), on });
    return Object.assign(base, { column: on.length ? 'doing' : 'todo', state: 'open', since: since(x.created_at), on });
  }
  const closes = closesIssues(x.body).map(function(n){ return (GITHUB_ORG + '/' + repo + '#' + n).toLowerCase(); });
  if (x.merged_at) return Object.assign(base, { column: 'done', state: 'merged', since: since(x.merged_at), on: [], closes });
  if (x.state === 'closed') return Object.assign(base, { column: 'done', state: 'closed', since: since(x.closed_at), on: [], closes });
  if (x.draft) return Object.assign(base, { column: 'doing', state: 'draft', since: since(x.created_at), on: [base.by], closes });
  // Open: whoever's asked to review it is on it.
  const reviewers = (x.requested_reviewers || []).map(function(r){ return who(r.login); });
  return Object.assign(base, { column: 'review', state: 'open', since: since(x.created_at), on: reviewers, waiting: reviewers.length ? '' : 'a reviewer', closes });
}

// One repository's items → { items } or { error }.
async function githubWork(repo, who){
  const now = Date.now(), after = new Date(now - WORK_DAYS * 86400000).toISOString();
  const base = '/repos/' + GITHUB_ORG + '/' + repo;
  try {
    const [open, closed, pulls] = await Promise.all([
      githubApp('GET', base + '/issues?state=open&per_page=100'),
      githubApp('GET', base + '/issues?state=closed&since=' + encodeURIComponent(after) + '&per_page=100'),
      githubApp('GET', base + '/pulls?state=all&sort=updated&direction=desc&per_page=100')
    ]);
    const items = [];
    open.concat(closed).forEach(function(x){
      if (x.pull_request) return;   // pulls, below
      if (x.state === 'closed' && Date.parse(x.closed_at) < now - WORK_DAYS * 86400000) return;
      items.push(githubWorkItem(repo, x, false, who));
    });
    pulls.forEach(function(x){
      if (x.state === 'closed' && Date.parse(x.closed_at) < now - WORK_DAYS * 86400000) return;
      items.push(githubWorkItem(repo, x, true, who));
    });
    return { items };
  } catch (err){
    if (err instanceof HttpsError) return { error: err.message };
    if (err.status === 403) return { error: 'BOLD.OS can’t read ' + repo + '’s issues and pull requests yet — an admin gives its GitHub App Issues and Pull requests: read.' };
    if (err.status === 404) return { error: GITHUB_ORG + '/' + repo + ' isn’t there, or BOLD.OS can’t see it.' };
    return { error: 'GitHub didn’t answer for ' + repo + ' — try again.' };
  }
}

// Names as on BOLD.OS: email → name, from members (then the Slack roster); a minute's cache.
let workNamesCache = null;
async function workNames(){
  if (workNamesCache && workNamesCache.at > Date.now() - 60000) return workNamesCache.names;
  const [members, people] = await Promise.all([db.collection('members').get(), db.collection('people').get()]);
  const names = {};
  people.docs.forEach(function(d){ const p = d.data(); if (p.email && p.name) names[String(p.email).toLowerCase()] = p.name; });
  members.docs.forEach(function(d){ const m = d.data(); if (m.name) names[d.id.toLowerCase()] = m.name; });
  workNamesCache = { at: Date.now(), names };
  return names;
}

// Pure: a proposal's page: its collection and document → { page (Who can see what), title, url }.
function proposalPlace(collection, slug, doc){
  const title = (doc && doc.title) || slug;
  if (collection === 'handbook') return { page: 'boldiquette', title: slug === 'boldiquette' ? 'BOLDiquette' : title, url: handbookUrl(slug) };
  if (collection === 'guides') return { page: access.guideArea(slug), title, url: guideUrl(slug) };
  if (collection === 'skills') return { page: 'skills', title: 'Skill ' + title, url: skillUrl(slug) };
  if (collection === 'agentTools') return { page: 'tools', title: 'Tool ' + title, url: toolUrl(slug) };
  return null;
}

// The site's proposed changes the caller can see: open, or decided in the last 14 days.
async function contentWork(email, person){
  const after = Date.now() - WORK_DAYS * 86400000;
  // All of them, filtered here: a few hundred at most, and no collection-group index needed.
  const docs = (await db.collectionGroup('proposals').get()).docs.filter(function(d){
    const q = d.data();
    return q.status === 'open' || (q.decidedAt || 0) >= after;
  });
  const titles = {}, mayView = {};
  const items = [];
  for (const d of docs){
    const parent = d.ref.parent.parent;
    if (!parent || parent.parent.parent) continue;   // only {collection}/{slug}/proposals
    const collection = parent.parent.id, slug = parent.id;
    if (['handbook', 'guides', 'skills', 'agentTools'].indexOf(collection) < 0) continue;
    if (!(parent.path in titles)){
      const s = await parent.get();
      titles[parent.path] = s.exists ? s.data() : null;
    }
    const place = proposalPlace(collection, slug, titles[parent.path] || (d.data().after || null));
    if (!place) continue;
    if (!(place.page in mayView)) mayView[place.page] = await access.can(email, place.page, 'view');
    if (!mayView[place.page]) continue;
    const q = d.data();
    const what = proposalSummary(q).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const item = { source: 'content', type: 'content', kind: 'proposal', ref: d.ref.path, title: place.title + ': ' + what,
      url: place.url + '#proposals', by: person(q.by && q.by.email, q.by && q.by.name) };
    if (q.status === 'open') Object.assign(item, { column: 'review', state: 'open', since: q.editedAt || q.at || 0, on: [], waiting: PIS_ADMINS });
    else Object.assign(item, { column: 'done', state: q.status, since: q.decidedAt || 0, on: q.decidedBy ? [person(q.decidedBy, q.decidedByName)] : [] });
    items.push(item);
  }
  return items;
}

// Pure: a request → its column and when it got there: open → review (waiting on someone),
// being worked on → doing, settled → done (or null once older than 14 days).
function requestColumn(open, doing, settledAt, at, now){
  if (open) return { column: doing ? 'doing' : 'review', since: at || 0 };
  if ((settledAt || 0) < (now || Date.now()) - WORK_DAYS * 86400000) return null;
  return { column: 'done', since: settledAt || 0 };
}

// Requests waiting on someone, those the caller sees on their own pages (firestore.rules):
// to join (PIs and admins, and whoever was named as inviting them), to change group
// (PIs and admins, and who asked), recommendation letters and introductions (the two
// people), supervision meetings (who asked and the student), agents acting (PIs and
// admins, and the token's owner), new venues (PIs and admins, and who proposed it).
async function requestWork(email, full, person){
  const now = Date.now(), items = [];
  const add = function(o, col){ if (col) items.push(Object.assign({ source: 'request', type: 'request' }, o, col)); };
  const q = function(c, field){ return db.collection(c).where(field, '==', email).get().then(function(s){ return s.docs; }); };
  const all = function(c){ return db.collection(c).get().then(function(s){ return s.docs; }); };
  const uniq = function(lists){ const seen = {}; return [].concat.apply([], lists).filter(function(d){ if (seen[d.ref.path]) return false; seen[d.ref.path] = true; return true; }); };
  const [joins, groups, lettersA, lettersB, introsA, introsB, studyA, studyB, tokens, boards] = await Promise.all([
    full ? all('joinRequests') : q('joinRequests', 'invitedBy.email'),
    full ? all('groupRequests') : q('groupRequests', 'email'),
    q('letterRequests', 'requesterEmail'), q('letterRequests', 'writerEmail'),
    q('introRequests', 'requesterEmail'), q('introRequests', 'offererEmail'),
    access.can(email, 'calendar', 'view').then(function(ok){ return ok ? q('studyRequests', 'email') : []; }),
    access.can(email, 'calendar', 'view').then(function(ok){ return ok ? q('studyRequests', 'student') : []; }),
    full ? all('apiTokens') : q('apiTokens', 'email'),
    full ? all('boards') : Promise.resolve([])
  ]);
  joins.forEach(function(d){
    const r = d.data(), inv = r.invitedBy && r.invitedBy.email;
    add({ kind: 'join', ref: d.ref.path, title: 'Join BOLD: ' + (r.name || 'someone') + (r.role ? ' (' + r.role + ')' : ''), url: SITE_URL + 'join-requests.html#r=' + d.id,
      by: { name: r.name || '' }, on: r.status === 'open' && inv ? [person(inv, r.invitedBy.name)] : r.decidedBy ? [person(r.decidedBy, r.decidedByName)] : [],
      waiting: r.status === 'open' && !inv ? PIS_ADMINS : '', state: r.status },
    requestColumn(r.status === 'open', false, r.decidedAt, r.at, now));
  });
  groups.forEach(function(d){
    const r = d.data();
    add({ kind: 'group', ref: d.ref.path, title: 'Change group: ' + (r.name || r.email) + ', ' + (GROUP_LABELS[r.from] || r.from || '?') + ' → ' + (GROUP_LABELS[r.to] || r.to || '?'),
      url: SITE_URL + 'join-requests.html#g=' + d.id, by: person(r.email, r.name), on: r.decidedBy ? [person(r.decidedBy, r.decidedByName)] : [],
      waiting: r.status === 'open' ? PIS_ADMINS : '', state: r.status },
    requestColumn(r.status === 'open', false, r.decidedAt, r.at, now));
  });
  uniq([lettersA, lettersB]).forEach(function(d){
    const r = d.data(), recips = r.recipients || [];
    const done = r.open === false || (recips.length && recips.every(function(x){ return x.submittedAt; }));
    const settled = r.open === false ? (r.updatedAt || 0) : Math.max.apply(null, [0].concat(recips.map(function(x){ return x.submittedAt || 0; })));
    add({ kind: 'letter', ref: d.ref.path, title: 'Recommendation letter: ' + (r.purpose || ''), url: letterUrl(d.id),
      by: person(r.requesterEmail, r.requesterName), on: [person(r.writerEmail, r.writerName)], state: done ? 'done' : r.acknowledgedAt ? 'writing' : 'asked' },
    requestColumn(!done, !!r.acknowledgedAt, settled, r.acknowledgedAt || r.at, now));
  });
  uniq([introsA, introsB]).forEach(function(d){
    const r = d.data();
    add({ kind: 'introduction', ref: d.ref.path, title: 'Introduction: ' + (r.org || '') + (r.area ? ' (' + r.area + ')' : ''), url: SITE_URL + 'introductions.html#i=' + d.id,
      by: person(r.requesterEmail, r.requesterName), on: [person(r.offererEmail, r.offererName)], state: r.status },
    requestColumn(r.status === 'asked' || r.status === 'accepted', r.status === 'accepted', r.updatedAt, r.status === 'accepted' ? r.updatedAt : r.at, now));
  });
  uniq([studyA, studyB]).forEach(function(d){
    const r = d.data();
    add({ kind: 'supervision', ref: d.ref.path, title: 'Join ' + (r.studentName || r.student) + '’s supervision meetings', url: SITE_URL + 'profile.html#studies',
      by: person(r.email, r.name), on: [person(r.student, r.studentName)], state: r.status },
    requestColumn(r.status === 'open', false, r.decidedAt, r.at, now));
  });
  tokens.forEach(function(d){
    const x = d.data(), r = x.actRequest;
    if (!r) return;
    add({ kind: 'agent', ref: d.ref.path, title: 'Let an agent act: ' + (x.label || 'a token'), url: SITE_URL + 'join-requests.html#agents',
      by: person(x.email), on: r.decidedBy ? [person(r.decidedBy, r.decidedByName)] : [], waiting: r.status === 'open' ? PIS_ADMINS : '', state: r.status },
    requestColumn(r.status === 'open', false, r.decidedAt, r.at, now));
  });
  boards.forEach(function(d){
    const b = d.data();
    if (b.status !== 'pending') return;
    add({ kind: 'venue', ref: d.ref.path, title: 'New venue: ' + (b.label || d.id), url: SITE_URL + 'audit-board.html',
      by: person(b.proposedBy && b.proposedBy.email, b.proposedBy && b.proposedBy.name), on: [], waiting: PIS_ADMINS, state: 'open' },
    { column: 'review', since: b.createdAt || 0 });
  });
  return items;
}

exports.projectWork = onCall(
  { secrets: [GITHUB_APP], timeoutSeconds: 60 },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'projects', 'view');   // Who can see what
    const pid = String((request.data || {}).project || '');
    if (!validSlug(pid)) throw new HttpsError('invalid-argument', 'No project given.');
    const ws = (await db.collection('projectWorkspaces').doc(pid).get()).data();
    if (!ws || !ws.work || !ws.work.on) throw new HttpsError('failed-precondition', 'This project has no work board.');
    const names = await workNames();
    // A person as BOLD.OS names them: { name, email }.
    const person = function(e, fallback){
      e = String(e || '').toLowerCase();
      return { name: names[e] || fallback || e.split('@')[0] || 'someone', email: e };
    };
    // The repositories: the board's, or else the project's own.
    const repos = (ws.work.repos && ws.work.repos.length) ? ws.work.repos : ws.repoName ? [ws.repoName] : [];
    const fresh = !!(request.data || {}).fresh;
    let gh = workCache.get(pid);
    const key = JSON.stringify(repos);
    if (!gh || gh.key !== key || fresh || gh.at < Date.now() - 60000){
      // GitHub logins → people, from who linked their GitHub (githubLinks): named as on BOLD.OS.
      const links = await db.collection('githubLinks').get();
      const byLogin = {};
      links.docs.forEach(function(d){
        const g = d.data();
        if (g.github && g.status !== 'failed') byLogin[String(g.github).toLowerCase()] = d.id.toLowerCase();
      });
      const who = function(login){
        const e = byLogin[String(login || '').toLowerCase()];
        return e ? person(e) : { name: login || 'someone', login: login || '' };
      };
      const results = await Promise.all(repos.map(function(r){ return githubWork(r, who); }));
      gh = { key, at: Date.now(), items: [], errors: [] };
      results.forEach(function(r){ if (r.error) gh.errors.push(r.error); else gh.items = gh.items.concat(r.items); });
      workCache.set(pid, gh);
    }
    let items = gh.items, errors = gh.errors.slice();
    if (ws.work.content){
      const full = await isFullWrite(email);
      const [content, requests] = await Promise.all([
        contentWork(email, person).catch(function(err){
          logger.error('projectWork: reading the proposals failed', { pid, error: String(err && err.message || err) });
          errors.push('The proposed changes couldn’t load — try again.');
          return [];
        }),
        requestWork(email, full, person).catch(function(err){
          logger.error('projectWork: reading the requests failed', { pid, error: String(err && err.message || err) });
          errors.push('The requests couldn’t load — try again.');
          return [];
        })
      ]);
      items = items.concat(content, requests);
    }
    return { items, errors, repos, at: gh.at };
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
    await access.requireAccess(email, 'events', 'edit');   // Who can see what
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
    await access.requireAccess(email, 'events', 'view');   // Who can see what
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
    await access.requireAccess(email, 'events', 'edit');   // Who can see what
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
    await access.requireAccess(email, 'profile', 'edit');   // Who can see what
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
    await access.requireAccess(email, 'profile', 'edit');   // Who can see what
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
      // And the study meetings they're in.
      const studies = await db.collection('studies').where('everyone', 'array-contains', email).get();
      for (const d of studies.docs) await syncStudyMeeting(d.id);
    }
    return { link: google ? { google } : null };
  }
);

// ---------- Studies: a PhD or Master student's details and supervision meeting ----------
// studies/{email}: the student's working title, the people involved in their studies
// (supervisors first) and their recurring meeting with them, a Google Calendar event
// with a Meet link owned by the lab's Google account, every one of them a guest (as a
// project's meeting, syncWorkspace). Only `studies` writes it; the lab reads it.
// The profile's Studies tab shows it to students (STUDY_ROLES, their members record).
const STUDY_ROLES = ['PhD student', 'Master student'];

// The student's Slack channel with the people involved: "supervision-<their name>",
// private, made by the bot when they first save their studies (a name that doesn't
// start with the prefix gets it, as a project's "proj-"). One that already exists is
// used, not made again; everyone on Slack among them is invited, and whoever is added
// later. Hand-kept in sync with pages/studies.js (SUPERVISION_PREFIX, its hint).
const SUPERVISION_PREFIX = 'supervision-';

// Pure: whatever was typed → { name, prefixed } (no '#', lowercase, starting with the
// prefix) or { error }.
function normalizeSupervisionChannel(input){
  let name = String(input || '').trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
  if (!name) return { error: 'Enter a channel name.' };
  if (!/^[a-z0-9_-]+$/.test(name)) return { error: 'Use letters, numbers, hyphens and underscores only.' };
  const prefixed = name.indexOf(SUPERVISION_PREFIX) !== 0;
  if (prefixed) name = SUPERVISION_PREFIX + name;
  if (name === SUPERVISION_PREFIX) return { error: 'Add a name after ' + SUPERVISION_PREFIX + '.' };
  if (name.length > 80) return { error: 'Slack channel names can be at most 80 characters.' };
  return { name, prefixed };
}

// Pure: a person's name → their default channel, "supervision-ada-lovelace".
function supervisionChannelFor(name){
  const slug = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80 - SUPERVISION_PREFIX.length).replace(/-+$/, '');
  return slug ? SUPERVISION_PREFIX + slug : '';
}

// Makes studies/{email}'s channel if it isn't there, and invites whoever of the student
// and the people involved is on Slack and not invited yet (`channelInvited`). Records
// `channelError` instead of throwing.
async function syncStudyChannel(email){
  const ref = db.collection('studies').doc(email);
  const s = (await ref.get()).data();
  if (!s || !s.channel) return;
  const token = SLACK_BOT_TOKEN.value();
  const patch = {};
  try {
    let id = s.channelId || await slackChannelId(token, s.channel);
    if (!id){
      const created = await slackFetch(token, 'conversations.create', { name: s.channel, is_private: true });
      channelNamesCache = null;
      if (!created.ok){
        const auth = await slackAuthInfo(token);
        if (created.error === 'name_taken') throw new HttpsError('failed-precondition', '#' + s.channel + ' already exists but the bot can’t see it' + (auth && auth.bot ? ': invite @' + auth.bot + ' to it, then Try again.' : '.'));
        throw slackChannelError(created.error, created);
      }
      id = created.channel.id;
    }
    if (id !== s.channelId){ patch.channelId = id; patch.channelUrl = await slackChannelUrl(token, id); }
    const invited = (s.channelInvited || []).slice();
    for (const e of [email].concat((s.people || []).map(function(p){ return p.email; }))){
      if (invited.indexOf(e) >= 0) continue;
      const uid = await slackIdForEmail(e);
      if (!uid) continue;
      let res = await slackFetch(token, 'conversations.invite', { channel: id, users: uid });
      if (!res.ok && res.error === 'not_in_channel'){
        await slackFetch(token, 'conversations.join', { channel: id });
        res = await slackFetch(token, 'conversations.invite', { channel: id, users: uid });
      }
      if (!res.ok && res.error !== 'already_in_channel') throw slackChannelError(res.error, res);
      invited.push(e);
    }
    patch.channelInvited = invited;
    patch.channelError = FieldValue.delete();
  } catch (err){
    logger.error('Setting up a supervision channel failed', { error: String(err && err.message || err) });
    patch.channelError = err instanceof HttpsError ? err.message : 'Couldn’t set up the Slack channel.';
  }
  await ref.set(patch, { merge: true });
}

// Pure: what a page sends → { title, people: [{ name, email }], meeting } or { error }.
// At least one person; the meeting is optional (normalizeMeeting's, or null); `me` (lowercase) can't be one of the people.
function normalizeStudies(d, me){
  d = d && typeof d === 'object' ? d : {};
  const title = String(d.title || '').trim();
  if (title.length > 200) return { error: 'Keep the title under 200 characters.' };
  const people = [];
  for (const p of Array.isArray(d.people) ? d.people : []){
    const email = String(p && p.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Give a valid email for everyone.' };
    if (email === me || people.some(function(x){ return x.email === email; })) continue;
    people.push({ name: String(p.name || '').trim().slice(0, 120) || email, email });
  }
  if (!people.length) return { error: 'Add who supervises your studies.' };
  if (people.length > 10) return { error: 'Up to 10 people.' };
  const meeting = d.meeting == null ? null : normalizeMeeting(d.meeting);
  if (meeting && meeting.error) return { error: meeting.error };
  return { title, people, meeting };
}

function studiesView(s){
  const out = {};
  ['degree', 'title', 'people', 'meeting', 'pausedAt', 'eventLink', 'meetUrl', 'error', 'channel', 'channelUrl', 'channelError', 'updatedAt'].forEach(function(k){ if (s[k] !== undefined) out[k] = s[k]; });
  return out;
}

// Brings studies/{email}'s Calendar event in line with its meeting and people. Records
// an error on it instead of throwing, so the profile can show it and offer to try again.
async function syncStudyMeeting(email){
  const ref = db.collection('studies').doc(email);
  const s = (await ref.get()).data();
  if (!s) return null;
  const patch = {};
  try {
    const addrs = await googleAddressesFor([email].concat((s.people || []).map(function(p){ return p.email; })));
    const summary = (s.name || email) + ' — ' + (s.degree === 'Master student' ? 'Master' : 'PhD') + ' meeting';
    const description = (s.meeting && s.meeting.link ? 'Join: <a href="' + s.meeting.link + '">' + s.meeting.link + '</a><br>' : '') +
      (s.title ? s.title + '<br>' : '') + 'Set on <a href="' + SITE_URL + 'profile.html#studies">BOLD.OS</a> by ' + (s.name || email) + '.';
    const attendees = function(existing){
      const kept = (existing || []).filter(function(a){ return a.organizer || a.self || addrs.indexOf(String(a.email).toLowerCase()) >= 0; });
      return kept.concat(addrs.filter(function(m){
        return !kept.some(function(a){ return String(a.email).toLowerCase() === m; });
      }).map(function(m){ return { email: m }; }));
    };
    // A paused meeting keeps its event, its series ended (meetingRecurrence); one paused
    // before it was made waits to be resumed.
    const want = !!s.meeting && !(s.pausedAt && !s.eventId);
    if (want && !s.eventId){
      const ev = await googleFetch('POST', CAL + '?conferenceDataVersion=1&sendUpdates=all', Object.assign({
        summary, description, attendees: attendees([]), guestsCanModify: false
      }, eventConference(s.meeting, 'bold-study-' + crypto.randomBytes(6).toString('hex')), eventTimes(s.meeting)));
      Object.assign(patch, { eventId: ev.id, eventLink: ev.htmlLink, meetUrl: s.meeting.link || ev.hangoutLink || '', eventMeeting: s.meeting, eventStart: seriesStart(ev) });
    } else if (!want && s.eventId){
      await googleFetch('DELETE', CAL + '/' + s.eventId + '?sendUpdates=all').catch(function(err){ if (err.status !== 410 && err.status !== 404) throw err; });
      ['eventId', 'eventLink', 'meetUrl', 'eventMeeting', 'eventPausedAt', 'eventStart'].forEach(function(k){ patch[k] = FieldValue.delete(); });
    } else if (s.eventId){
      const ev = await googleFetch('GET', CAL + '/' + s.eventId);
      const change = {};
      const want = attendees(ev.attendees);
      if (JSON.stringify(want.map(function(a){ return a.email; })) !== JSON.stringify((ev.attendees || []).map(function(a){ return a.email; }))) change.attendees = want;
      if (ev.summary !== summary) change.summary = summary;
      if (ev.description !== description) change.description = description;
      if (!sameMeetingTimes(s.eventMeeting, s.meeting)) Object.assign(change, eventTimes(s.meeting, s.pausedAt));
      else if ((s.eventMeeting.until || '') !== (s.meeting.until || '') || (s.pausedAt || 0) !== (s.eventPausedAt || 0)) change.recurrence = meetingRecurrence(s.meeting, s.pausedAt);
      Object.assign(change, conferenceChange(ev, s.meeting, 'bold-study-' + crypto.randomBytes(6).toString('hex')));
      let now = ev;
      if (Object.keys(change).length){
        now = await googleFetch('PATCH', CAL + '/' + s.eventId + '?conferenceDataVersion=1&sendUpdates=all', change) || ev;
        patch.eventMeeting = s.meeting; patch.eventPausedAt = s.pausedAt || FieldValue.delete(); patch.eventStart = seriesStart(now);
      } else if (!s.eventStart && seriesStart(ev)) patch.eventStart = seriesStart(ev);
      const url = s.meeting.link || now.hangoutLink || '';
      if (url !== (s.meetUrl || '')) patch.meetUrl = url;
    }
    patch.error = FieldValue.delete();
  } catch (err){
    logger.error('Setting up a study meeting failed', { error: String(err && err.message || err) });
    patch.error = err instanceof HttpsError ? err.message : 'Couldn’t set up the meeting in Google Calendar.';
  }
  await ref.set(patch, { merge: true });
  return (await ref.get()).data();
}

// The profile's Studies tab, for the caller's own studies:
// - 'save': { title, people: [{ name, email }], meeting: { day, time, minutes, every } or null (none:
//   its event is cancelled), channel, noChannel (no Slack channel, until one is made: they
//   have one already, such as their project's) }, people required;
//   only PhD and Master students (their members record's role), or whoever already has studies.
// - 'retry': tries the Slack channel and the Calendar event again.
// - 'channel': { name } (or none: the default) → { name, prefixed, exists }, for the form's hint.
// - 'pause' / 'resume': { student } (the caller's own when none): pauses the meeting
//   (its upcoming dates come off Google Calendar; the same event, invitation and Meet
//   link stay) or brings it back; the student or anyone involved in their studies.
// → the studies (studiesView).
exports.studies = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN], timeoutSeconds: 120 },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'calendar', 'view');   // Who can see what
    const data = request.data || {};
    if (data.action === 'pause' || data.action === 'resume'){
      const student = String(data.student || email).trim().toLowerCase();
      const sref = db.collection('studies').doc(student);
      const s = (await sref.get()).data();
      if (!s || !s.meeting) throw new HttpsError('not-found', 'There’s no meeting to ' + data.action + '.');
      if ((s.everyone || [student]).indexOf(email) < 0) throw new HttpsError('permission-denied', 'Only the student and the people involved in their studies can do this.');
      await sref.set(data.action === 'pause' ? { pausedAt: Date.now(), pausedBy: email } : { pausedAt: FieldValue.delete(), pausedBy: FieldValue.delete() }, { merge: true });
      return studiesView(await syncStudyMeeting(student));
    }
    const ref = db.collection('studies').doc(email);
    const [prev, member] = await Promise.all([ref.get(), db.collection('members').doc(email).get()]);
    const role = member.exists ? member.data().role : '';
    const myName = (member.exists && member.data().name) || request.auth.token.name || email;
    if (data.action === 'channel'){
      // The form's live check: the name it would use, and whether it's there already.
      const n = data.name ? normalizeSupervisionChannel(data.name) : { name: supervisionChannelFor(myName), prefixed: false };
      if (n.error) throw new HttpsError('invalid-argument', n.error);
      if (!n.name) throw new HttpsError('invalid-argument', 'Enter a channel name.');
      return { name: n.name, prefixed: n.prefixed, exists: !!(await slackChannelId(SLACK_BOT_TOKEN.value(), n.name)) };
    }
    if (data.action === 'retry'){
      if (!prev.exists) throw new HttpsError('not-found', 'Save your studies first.');
      await syncStudyChannel(email);
      return studiesView(await syncStudyMeeting(email));
    }
    if (data.action !== 'save') throw new HttpsError('invalid-argument', 'Unknown action.');
    if (STUDY_ROLES.indexOf(role) < 0 && !prev.exists) throw new HttpsError('permission-denied', 'Studies are for PhD and Master students: set your role in Your details first.');
    const n = normalizeStudies(data, email);
    if (n.error) throw new HttpsError('invalid-argument', n.error);
    // The channel: named once, when it's first made; after that it stays. Until then they
    // can have none.
    let channel = prev.exists && prev.data().channelId ? prev.data().channel : '';
    const noChannel = !channel && data.noChannel === true;
    if (!channel && !noChannel){
      const c = data.channel ? normalizeSupervisionChannel(data.channel) : { name: supervisionChannelFor(myName) };
      if (c.error) throw new HttpsError('invalid-argument', c.error);
      channel = c.name;
    }
    await ref.set(Object.assign({
      email, name: myName,
      degree: STUDY_ROLES.indexOf(role) >= 0 ? role : (prev.exists && prev.data().degree) || '',
      title: n.title, people: n.people, meeting: n.meeting, channel,
      everyone: [email].concat(n.people.map(function(p){ return p.email; })), updatedAt: Date.now()
    }, n.meeting ? {} : { pausedAt: FieldValue.delete(), pausedBy: FieldValue.delete() },
    noChannel ? { channelError: FieldValue.delete(), channelInvited: FieldValue.delete() } : {}), { merge: true });
    await syncStudyChannel(email);
    return studiesView(await syncStudyMeeting(email));
  }
);

// A lab member's request to be among the people involved in a student's studies, from
// the Calendar, and the student's decision (on their Studies tab). studyRequests/{id}:
// { student, studentName, email, name, note, status: open|approved|declined|withdrawn, at };
// read by the two of them, written only here.
// - 'request': { student, note } → { id }; one open request per student; DMs the student.
// - 'withdraw': { id }: whoever asked, while it's open.
// - 'decide': { id, accept }: the student; accepting adds them to the people involved
//   (the meeting's guests, the Slack channel). DMs whoever asked.
exports.studyRequest = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN], timeoutSeconds: 120 },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'calendar', 'view');   // Who can see what
    const d = request.data || {};
    const col = db.collection('studyRequests');
    const token = SLACK_BOT_TOKEN.value();
    if (d.action === 'request'){
      const student = String(d.student || '').trim().toLowerCase();
      if (!student || student === email) throw new HttpsError('invalid-argument', 'Choose someone else’s studies.');
      const s = (await db.collection('studies').doc(student).get()).data();
      if (!s) throw new HttpsError('not-found', 'Those studies aren’t there.');
      if ((s.everyone || []).indexOf(email) >= 0) throw new HttpsError('already-exists', 'You’re already in their meeting.');
      const open = await col.where('email', '==', email).where('student', '==', student).where('status', '==', 'open').limit(1).get();
      if (!open.empty) throw new HttpsError('already-exists', 'You’ve already asked.');
      const m = await db.collection('members').doc(email).get();
      const name = (m.exists && m.data().name) || request.auth.token.name || email;
      const note = String(d.note || '').trim().slice(0, 1000);
      const ref = await col.add({ student, studentName: s.name || student, email, name, note, status: 'open', at: Date.now() });
      await sendEvent(token, { emails: [student], headline: '🎓 ' + slackText(name) + ' asks to join your supervision meeting' +
        (note ? ': “' + slackText(note.slice(0, 300)) + '”' : '') + '. ' + linkedTitle('Approve or decline', SITE_URL + 'profile.html#studies') + '.' });
      return { id: ref.id };
    }
    const id = String(d.id || '');
    if (!validSlug(id)) throw new HttpsError('invalid-argument', 'No request given.');
    const ref = col.doc(id);
    if (d.action === 'withdraw'){
      await db.runTransaction(async function(tx){
        const r = (await tx.get(ref)).data();
        if (!r || r.email !== email) throw new HttpsError('not-found', 'That request isn’t there.');
        if (r.status !== 'open') throw new HttpsError('failed-precondition', 'It’s already been decided.');
        tx.update(ref, { status: 'withdrawn', decidedAt: Date.now() });
      });
      return { ok: true };
    }
    if (d.action !== 'decide') throw new HttpsError('invalid-argument', 'Unknown action.');
    const accept = !!d.accept;
    const sref = db.collection('studies').doc(email);
    const r = await db.runTransaction(async function(tx){
      const [rs, ss] = await Promise.all([tx.get(ref), tx.get(sref)]);
      const r = rs.data();
      if (!r || r.student !== email) throw new HttpsError('not-found', 'That request isn’t there.');
      if (r.status !== 'open') throw new HttpsError('failed-precondition', 'It’s already been decided.');
      tx.update(ref, { status: accept ? 'approved' : 'declined', decidedAt: Date.now() });
      if (accept){
        const s = ss.data() || {};
        const people = (s.people || []).slice();
        if (!people.some(function(p){ return p.email === r.email; })){
          if (people.length >= 10) throw new HttpsError('failed-precondition', 'Up to 10 people: remove someone first.');
          people.push({ name: r.name || r.email, email: r.email });
        }
        tx.update(sref, { people, everyone: [email].concat(people.map(function(p){ return p.email; })), updatedAt: Date.now() });
      }
      return r;
    });
    if (accept){ await syncStudyChannel(email); await syncStudyMeeting(email); }
    await sendEvent(token, { emails: [r.email], headline: accept
      ? '🎓 ' + slackText(r.studentName) + ' added you to their supervision meeting: Google Calendar sends the invitation.'
      : '🎓 ' + slackText(r.studentName) + ' declined your request to join their supervision meeting.' });
    return { ok: true };
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
    const email = callerEmail(request);
    await access.requireAccess(email, 'events', 'view');   // Who can see what
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
    await access.requireAccess(email, 'events', 'edit');   // Who can see what
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
    await access.requireAccess(email, 'events', 'edit');   // Who can see what
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
    await access.requireAccess(email, 'events', 'edit');   // Who can see what
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

const TRACKED = ['skills', 'guides', 'handbook', 'agentTools'];
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

// ---------- Joining BOLD: requests, approval, the welcome email ----------
// Anyone can ask to join on join.html (requestToJoin; no sign-in, since they
// aren't in the Slack yet). The PIs and admins are told in Slack and decide on
// join-requests.html (decideJoinRequest). Approving keeps what they told us as
// their member record (members/{email}, which they can edit on their profile)
// and sends them the welcome email from the lab's Google account (Gmail,
// GOOGLE_OAUTH with gmail.send): join the Slack with the workspace's invite
// link, complete the profile, link accounts, read the BOLDiquette, add projects.
// The invite link and the email's text are settings/joinInvite, edited on
// join-requests.html; the form's choices are settings/joinForm. An email that
// can't be sent yet (no Google account or invite link) waits and is retried
// hourly (retryWelcomeEmails), or from the page.

const JOIN_ROLES = ['PhD student', 'Master student', 'Postdoc', 'Visitor', 'Collaborator', 'Adjunct', 'PI', 'Alumni', 'Staff', 'Other'];
const JOIN_NO_END = ['PI', 'Adjunct', 'Alumni', 'Collaborator'];
// BOLD's research pillars, as the Google Form had them; settings/joinForm replaces them.
const JOIN_PILLARS = [
  'Core Algorithmic Innovation Questioning the Foundations of the Field',
  'Human-Centric Learning and Discovery (incl. Human-AI Coordination, MARL, Co-Scientist)',
  'Robust Adaptation and Learning incl. in Embodied Envs (RL, Open-Ended Learning, Robotics)',
];
const JOIN_TEXT = { name: 120, email: 200, links: 500, institution: 120, role: 60, contact: 200, interests: 300, basedIn: 120, pronouns: 40, note: 1000 };
// How someone likes to receive feedback (join-common.js FEEDBACK, firestore.rules); optional.
const JOIN_FEEDBACK = ['direct', 'balanced', 'gentle'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WELCOME_SUBJECT = 'Welcome to BOLD';
const WELCOME_BODY = [
  'Hi {name},',
  '',
  'Welcome to BOLD! Your request to join has been approved. Here are your next steps:',
  '',
  '1. Join the BOLD Slack: {slackInvite}',
  '   You sign in to BOLD.OS with your Slack account, using this email address.',
  '2. Complete your profile: {site}profile.html',
  '3. Link your accounts (GitHub and Google): {site}profile.html#linked-accounts',
  '4. Read the BOLDiquette: {site}boldiquette.html',
  '5. Add your projects, if you have any: {site}projects-register.html',
  '',
  'See you on Slack,',
  'The BOLD team',
].join('\n');

// Pure: what join.html sent → { request } or { error }. `roles` and `pillars`
// are the choices on offer (settings/joinForm).
function normalizeJoinRequest(d, roles, pillars){
  d = d && typeof d === 'object' ? d : {};
  const out = {};
  for (const k of Object.keys(JOIN_TEXT)) {
    const v = String(d[k] == null ? '' : d[k]).trim();
    if (v.length > JOIN_TEXT[k]) return { error: 'That’s too long: ' + k + '.' };
    out[k] = v;
  }
  out.email = out.email.toLowerCase();
  if (!out.name) return { error: 'Give your full name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: 'Give a valid email address.' };
  if (!out.institution) return { error: 'Give your home institution.' };
  if ((roles || JOIN_ROLES).indexOf(out.role) === -1) return { error: 'Choose your role at BOLD.' };
  if (!out.contact) return { error: 'Say who your BOLD point of contact is.' };
  if (!out.interests) return { error: 'Give your main research interests.' };
  const chosen = Array.isArray(d.pillars) ? d.pillars.map(String) : [];
  out.pillars = (pillars || []).filter((p) => chosen.indexOf(p) !== -1);
  out.listOnWebsite = d.listOnWebsite === true;
  out.feedback = JOIN_FEEDBACK.indexOf(d.feedback) !== -1 ? d.feedback : '';
  out.startDate = String(d.startDate || '');
  out.endDate = String(d.endDate || '');
  if (out.startDate && !ISO_DAY.test(out.startDate)) return { error: 'Give a valid start date.' };
  if (out.endDate && !ISO_DAY.test(out.endDate)) return { error: 'Give a valid end date.' };
  if (!out.endDate && JOIN_NO_END.indexOf(out.role) === -1) return { error: 'Give your end date (not needed for PIs, adjuncts, alumni and collaborators).' };
  if (out.startDate && out.endDate && out.endDate < out.startDate) return { error: 'The end date is before the start date.' };
  return { request: out };
}

// Pure: the welcome email for request r → { subject, body } or { error } (what's missing).
function welcomeEmail(r, settings, todayIso){
  const s = settings || {};
  const invite = String(s.slackInviteUrl || '').trim();
  if (!invite) return { error: 'No Slack invite link yet: add it on the join requests page.' };
  if (s.slackInviteExpires && s.slackInviteExpires < (todayIso || todayIsoLondon())) return { error: 'The Slack invite link expired on ' + s.slackInviteExpires + ': add a new one on the join requests page.' };
  const fill = (t) => String(t).replace(/\{name\}/g, (r.name || '').split(' ')[0] || r.name || '')
    .replace(/\{fullName\}/g, r.name || '').replace(/\{slackInvite\}/g, invite).replace(/\{site\}/g, SITE_URL);
  return { subject: fill(s.subject || WELCOME_SUBJECT), body: fill(s.body || WELCOME_BODY) };
}

// Pure: a plain-text UTF-8 email as Gmail's API takes it (base64url of the MIME message).
function mimeMessage(to, subject, body){
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const msg = [
    // Gmail sends it from the lab's account; no From needed.
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  return Buffer.from(msg, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function joinSettings(){
  const [form, invite] = await Promise.all([db.collection('settings').doc('joinForm').get(), db.collection('settings').doc('joinInvite').get()]);
  const f = form.exists ? form.data() : {};
  return {
    roles: Array.isArray(f.roles) && f.roles.length ? f.roles : JOIN_ROLES,
    pillars: Array.isArray(f.pillars) && f.pillars.length ? f.pillars : JOIN_PILLARS,
    invite: invite.exists ? invite.data() : {},
  };
}

// Sends request id's welcome email, if it's due; records how it went on the request. → { status, error? }
async function sendWelcome(id){
  const ref = db.collection('joinRequests').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'missing' };
  const r = snap.data();
  if (r.status !== 'approved' || (r.welcome && r.welcome.status === 'sent')) return { status: (r.welcome && r.welcome.status) || r.status };
  const tries = ((r.welcome && r.welcome.tries) || 0) + 1;
  const mail = welcomeEmail(r, (await joinSettings()).invite);
  let error = mail.error || '';
  if (!error) {
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + await googleToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: mimeMessage(r.email, mail.subject, mail.body) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        logger.error('sendWelcome: Gmail refused', { id, status: res.status, error: j.error && j.error.message });
        error = res.status === 403 ? 'The lab’s Google account can’t send email yet (gmail.send): reconnect it.' : 'Gmail refused it (' + res.status + ').';
      }
    } catch (e) {
      error = e instanceof HttpsError ? e.message : 'Couldn’t reach Gmail.';
      if (!(e instanceof HttpsError)) logger.error('sendWelcome threw', { id, error: String(e) });
    }
  }
  const welcome = error ? { status: 'waiting', error, tries, at: Date.now() } : { status: 'sent', tries, at: Date.now() };
  await ref.update({ welcome });
  return welcome;
}

exports.requestToJoin = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const d = request.data || {};
    // A field people don't see: filled in, it's a bot. Say nothing different.
    if (d.website) return { ok: true };
    // Their point of contact, who invited them (required): someone on the Slack roster who
    // can decide requests (joinInviterEmails); they approve or decline it (onJoinRequested,
    // decideJoinRequest). It's both `contact` (with contactEmail) and `invitedBy`.
    const id = String(d.invitedBy || '');
    const p = /^[A-Z0-9]{2,20}$/.test(id) ? await db.collection('people').doc(id).get() : null;
    const inviterEmail = p && p.exists ? String(p.data().email || '').toLowerCase() : '';
    if (!inviterEmail || !(await joinInviterEmails()).has(inviterEmail)) throw new HttpsError('invalid-argument', 'Choose your point of contact from the list.');
    const inviterName = String(p.data().name || inviterEmail);
    const set = await joinSettings();
    const n = normalizeJoinRequest(Object.assign({}, d, { contact: inviterName }), set.roles, set.pillars);
    if (n.error) throw new HttpsError('invalid-argument', n.error);
    const r = n.request;
    r.contactEmail = inviterEmail;
    r.invitedBy = { id, name: inviterName, email: inviterEmail, status: 'pending' };
    const open = await db.collection('joinRequests').where('email', '==', r.email).where('status', '==', 'open').limit(1).get();
    if (!open.empty) throw new HttpsError('already-exists', 'There’s already a request for this email address, waiting for a PI. You’ll hear by email.');
    const recent = await db.collection('joinRequests').where('at', '>', Date.now() - 3600000).count().get();
    if (recent.data().count >= 30) throw new HttpsError('resource-exhausted', 'Too many requests right now: try again in an hour.');
    await db.collection('joinRequests').add(Object.assign(r, { status: 'open', at: Date.now() }));
    return { ok: true };
  }
);

const joinPageUrl = () => SITE_URL + 'join-requests.html';

// Pure: a name folded for matching ("Zoë Lee" → "zoe lee").
function foldName(s){ return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

// Who can invite someone to BOLD, and so decide their request to join: whoever is at the
// Requests page's Edit level (BOLDiquette › Who can see what), PIs and admins included.
// → a Set of emails, lowercase; kept a minute.
let inviterCache = null, inviterAt = 0;
async function joinInviterEmails(){
  if (inviterCache && Date.now() - inviterAt < 60000) return inviterCache;
  const level = ((await access.table()).requests || {}).edit || 'internal';
  const out = new Set();
  if (level !== 'none') {
    const need = require('./access').rank(level);
    (await db.collection('members').get()).docs.forEach((m) => { if (require('./access').rank(groupOf(m.data())) >= need) out.add(m.id.toLowerCase()); });
    (await rolesEmails('pis')).concat(await rolesEmails('admins')).forEach((e) => out.add(String(e).toLowerCase()));
  }
  inviterCache = out; inviterAt = Date.now();
  return out;
}

// The join form's "Who invited you": up to 6 people on the Slack roster who can invite
// (joinInviterEmails) whose name has a word starting with what was typed (2 letters at
// least). No sign-in (applicants aren't on Slack yet), so it gives names and Slack ids
// only. data: { q } → { people: [{ id, name }] }.
// The profile's point of contact (data: { all: true }, signed in): every one of them, with
// their email (what members/{email}.contactEmail holds), since PAN-BOLD can't read `people`.
exports.joinInviters = onCall(async (request) => {
  if ((request.data || {}).all === true){
    const email = callerEmail(request);
    await access.requireAccess(email, 'profile', 'view');   // Who can see what
    const [snap, can] = await Promise.all([db.collection('people').get(), joinInviterEmails()]);
    return { people: snap.docs.map(function(d){ return { name: String(d.data().name || ''), email: String(d.data().email || '').toLowerCase() }; })
      .filter(function(p){ return p.name && p.email && p.email !== email && can.has(p.email); })
      .sort(function(a, b){ return a.name.localeCompare(b.name); }) };
  }
  const q = foldName((request.data || {}).q).slice(0, 60);
  if (q.length < 2) return { people: [] };
  const [snap, can] = await Promise.all([db.collection('people').get(), joinInviterEmails()]);
  const people = snap.docs.filter((d) => can.has(String(d.data().email || '').toLowerCase()))
    .map(function(d){ return { id: d.id, name: String(d.data().name || '') }; })
    .filter(function(p){ const n = foldName(p.name); return p.name && (n.indexOf(q) === 0 || n.indexOf(' ' + q) >= 0); })
    .sort(function(a, b){ return a.name.localeCompare(b.name); }).slice(0, 6);
  return { people };
});

// A member says who invited them to the BOLD Slack, on their profile (members/{email}
// .invitedBy, which they can't write themselves): someone on the roster, or nobody
// (email ''). Whoever they name gets a DM to confirm it on the Requests page (Invited by
// you; confirmJoinInvite with { member }). data: { email } → { invitedBy }.
exports.setMyInviter = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'profile', 'edit');   // Who can see what
    const to = String((request.data || {}).email || '').trim().toLowerCase();
    const ref = db.collection('members').doc(email);
    const m = await ref.get();
    if (!m.exists) throw new HttpsError('failed-precondition', 'Save your details first.');
    const cur = m.data().invitedBy || null;
    if (!to) { if (cur) await ref.update({ invitedBy: FieldValue.delete() }); return { invitedBy: null }; }
    if (to === email) throw new HttpsError('invalid-argument', 'Choose who invited you.');
    if (cur && cur.email === to) return { invitedBy: cur };
    const p = await db.collection('people').where('email', '==', to).limit(1).get();
    if (p.empty) throw new HttpsError('not-found', 'Choose someone on BOLD.OS.');
    const who = p.docs[0];
    const invitedBy = { id: who.id, name: String(who.data().name || to), email: to, status: 'pending', askedAt: Date.now(), via: 'profile' };
    await ref.update({ invitedBy });
    const name = m.data().name || email;
    await sendEvent(SLACK_BOT_TOKEN.value(), { emails: [to], headline: '👋 ' + slackText(name) + ' names you as their BOLD point of contact, who invited them. ' +
      linkedTitle('Confirm it, or say you didn’t', joinPageUrl() + '#invited') + '.' });
    return { invitedBy };
  }
);

// Whoever an applicant (or a member, on their profile) named as inviting them confirms it
// or says they didn't, on the Requests page. data: { id, confirm: bool } for a request to
// join, { member: email, confirm } for a member → { ok }. Saying they didn't DMs the PIs
// and admins. A request's answer is copied to the member's record if they're approved already.
exports.confirmJoinInvite = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'profile', 'edit');   // Who can see what
    const d = request.data || {};
    if (d.member){
      const mref = db.collection('members').doc(String(d.member).toLowerCase());
      const mstatus = d.confirm ? 'confirmed' : 'denied';
      const m = await db.runTransaction(async (tx) => {
        const x = (await tx.get(mref)).data();
        if (!x || !x.invitedBy || x.invitedBy.email !== email) throw new HttpsError('not-found', 'No such member.');
        tx.update(mref, { 'invitedBy.status': mstatus, 'invitedBy.at': Date.now() });
        return x;
      });
      if (!d.confirm && m.invitedBy.status !== 'denied'){
        const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
        await sendEvent(SLACK_BOT_TOKEN.value(), { emails: staff, headline: '⚠️ ' + slackText(m.invitedBy.name) + ' says they didn’t invite ' + slackText(m.name || mref.id) + ' to the BOLD Slack (they said so on their profile).' });
      }
      return { ok: true };
    }
    if (!/^[A-Za-z0-9]{1,40}$/.test(String(d.id || ''))) throw new HttpsError('invalid-argument', 'No such request.');
    const ref = db.collection('joinRequests').doc(d.id);
    const status = d.confirm ? 'confirmed' : 'denied';
    const r = await db.runTransaction(async (tx) => {
      const q = (await tx.get(ref)).data();
      if (!q || !q.invitedBy || q.invitedBy.email !== email) throw new HttpsError('not-found', 'No such request.');
      tx.update(ref, { 'invitedBy.status': status, 'invitedBy.at': Date.now() });
      return q;
    });
    if (r.status === 'approved'){
      const m = db.collection('members').doc(r.email);
      if ((await m.get()).exists) await m.set({ invitedBy: Object.assign({}, r.invitedBy, { status, at: Date.now() }) }, { merge: true });
    }
    if (!d.confirm && r.invitedBy.status !== 'denied'){
      const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
      await sendEvent(SLACK_BOT_TOKEN.value(), { emails: staff, headline: '⚠️ ' + slackText(r.invitedBy.name) + ' says they didn’t invite ' + slackText(r.name) + ' (' + slackText(r.email) + '). ' +
        linkedTitle('See the request', joinPageUrl() + '#r=' + d.id) + '.' });
    }
    return { ok: true };
  }
);

exports.onJoinRequested = onDocumentCreated(
  { document: 'joinRequests/{id}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const r = event.data && event.data.data();
    if (!r || r.status !== 'open') return;
    // Whoever invited them decides it; the PIs and admins only hear of one without an inviter (from before it was required).
    if (r.invitedBy) {
      await dmBySlackId(SLACK_BOT_TOKEN.value(), r.invitedBy.id, '👋 ' + slackText(r.name) + ' (' + slackText(r.role) + ', ' + slackText(r.institution) + ', ' + slackText(r.email) + ') asked to join BOLD and says you invited them. ' +
        linkedTitle('Approve or decline', joinPageUrl() + '#i=' + event.params.id) + '.');
      return;
    }
    const headline = '👋 ' + slackText(r.name) + ' (' + slackText(r.role) + ', ' + slackText(r.institution) + ') asked to join BOLD' +
      (r.contact ? ', with ' + slackText(r.contact) + ' as their point of contact' : '') + '. ' +
      linkedTitle('Approve or decline', joinPageUrl() + '#r=' + event.params.id) + '.';
    const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
    await sendEvent(SLACK_BOT_TOKEN.value(), { emails: staff, headline });
  }
);

// data: { id, accept: bool } → { status, welcome? }. Whoever they named as inviting them
// (at Requests' Edit level); PIs and admins only one without an inviter (from before it was required).
exports.decideJoinRequest = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'requests', 'edit');   // Who can see what
    const full = await isFullWrite(email);
    const d = request.data || {};
    if (!/^[A-Za-z0-9]{1,40}$/.test(String(d.id || ''))) throw new HttpsError('invalid-argument', 'No such request.');
    const ref = db.collection('joinRequests').doc(d.id);
    const name = request.auth.token.name || '';
    const deciderGroup = await access.groupFor(email);
    const r = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'No such request.');
      const q = snap.data();
      // Only whoever invited them decides it; PIs and admins only one without an inviter (from before it was required).
      const inviter = !!(q.invitedBy && q.invitedBy.email === email), noInviter = !(q.invitedBy && q.invitedBy.email);
      if (!inviter && !(full && noInviter)) throw new HttpsError('permission-denied', 'Only whoever invited them decides this.');
      if (q.status !== 'open') throw new HttpsError('failed-precondition', 'It has already been ' + q.status + '.');
      const m = db.collection('members').doc(q.email);
      const had = d.accept ? await tx.get(m) : null;
      const status = d.accept ? 'approved' : 'declined';
      // Their inviter approving it confirms they invited them.
      const confirmed = inviter && d.accept ? { invitedBy: Object.assign({}, q.invitedBy, { status: 'confirmed', at: Date.now() }) } : {};
      tx.update(ref, Object.assign({ status, decidedBy: email, decidedByName: name, decidedAt: Date.now() }, confirmed));
      Object.assign(q, confirmed);
      if (d.accept) {
        // Their record in BOLD.OS: what they told us. They keep it up to date on their profile.
        // Their group, unless a PI or admin already set one: what their role suggests, but
        // never above the group of whoever approves it (a PI or admin raises it on People).
        const keep = ['name', 'email', 'links', 'institution', 'role', 'contact', 'contactEmail', 'interests', 'pillars', 'listOnWebsite', 'basedIn', 'pronouns', 'feedback', 'startDate', 'endDate', 'invitedBy'];
        const rec = {};
        keep.forEach((k) => { if (q[k] !== undefined) rec[k] = q[k]; });
        if (!(had.exists && GROUPS.indexOf(had.data().category) >= 0)) Object.assign(rec, { category: cappedGroup(roleGroup(q.role), deciderGroup), categoryBy: email, categoryAt: Date.now() });
        tx.set(m, Object.assign(rec, { requestId: d.id, approvedBy: email, approvedAt: Date.now() }), { merge: true });
      }
      return Object.assign({}, q, { status });
    });
    if (r.status !== 'approved') return { status: r.status };
    return { status: r.status, welcome: await sendWelcome(d.id) };
  }
);

// data: { id } → the welcome email's new state. Sends it again if it hasn't gone.
exports.sendWelcomeEmail = onCall(
  { secrets: [GOOGLE_OAUTH] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'requests', 'edit');   // Who can see what
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins can do this.');
    const id = String((request.data || {}).id || '');
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new HttpsError('invalid-argument', 'No such request.');
    return sendWelcome(id);
  }
);

exports.retryWelcomeEmails = onSchedule(
  { schedule: '15 * * * *', timeZone: 'Europe/London', secrets: [GOOGLE_OAUTH] },
  async function(){
    const snap = await db.collection('joinRequests').where('welcome.status', '==', 'waiting').get();
    for (const doc of snap.docs) {
      const w = doc.data().welcome || {};
      // Hourly for two days, then daily.
      if (w.tries > 48 && Date.now() - (w.at || 0) < 86400000) continue;
      await sendWelcome(doc.id);
    }
  }
);

// ---------- Groups: the BOLDiquette's Who is BOLD ----------
// Every member is in one group, the one a PI or admin set (members' `category`, on the
// People page, or by approving a request); without one, PAN-BOLD (groupOf; BoldJoin.groupOf
// on the pages, kept in sync by hand). The group decides what they can see (settings/access),
// so it never follows anything a member edits: approving a request sets it from their role
// (roleGroup: PIs BOLD-exec, PhD and Master students BOLD-internal, Staff BOLD-staff, else PAN-BOLD). A member asks for another group on their profile
// (groupRequests/{id}, through groupRequest); the PIs and admins decide on Join
// requests. Each group but PAN-BOLD may have Slack channels (settings/groups.channels, set there:
// one or more names, separated by commas, as "bold-internal, all-active-projects"), and each
// role on the join form may have some too (settings/groups.roleChannels, by role: "PhD student").
// The groups are ranked (GROUPS, highest first) and each is in the channels of those below
// it too: BOLD-exec in BOLD-staff's, BOLD-internal's and BOLD-associate's; BOLD-internal
// in BOLD-associate's, not BOLD-staff's. Whoever comes into a group is invited to its
// channels (onMemberGroup), and setting a channel invites everyone meant to be in it
// (onGroupChannels; settings/groupsInvited, server only, is what has been invited, so a
// change to the ranking reaches the channels already set). Nobody is removed from a channel.
const GROUPS = ['exec', 'staff', 'internal', 'associate', 'pan'];
const GROUP_LABELS = { exec: 'BOLD-exec', internal: 'BOLD-internal', associate: 'BOLD-associate', staff: 'BOLD-staff', pan: 'PAN-BOLD' };
const CHANNEL_GROUPS = GROUPS.filter(function(g){ return g !== 'pan'; });
// Bump when the ranking changes: every channel is then filled again.
const GROUP_RANKING_VERSION = 2;

// Pure: group → the groups whose channels its members are in (its own and those below).
function channelGroupsFor(g){
  const i = GROUPS.indexOf(g);
  return i < 0 ? [] : CHANNEL_GROUPS.filter(function(h){ return GROUPS.indexOf(h) >= i; });
}

// Pure: a member record → its group.
function groupOf(m){
  m = m || {};
  return GROUPS.indexOf(m.category) >= 0 ? m.category : 'pan';
}
// Pure: a role → the group it suggests, when a request is approved.
// The lower of two groups (GROUPS runs from the top down).
function cappedGroup(g, cap){ return GROUPS.indexOf(cap) < 0 ? g : GROUPS[Math.max(GROUPS.indexOf(g), GROUPS.indexOf(cap))]; }
function roleGroup(role){
  return role === 'PI' ? 'exec' : role === 'PhD student' || role === 'Master student' ? 'internal' : role === 'Staff' ? 'staff' : 'pan';
}

function groupChannelName(raw){ return String(raw || '').trim().replace(/^#/, '').toLowerCase(); }
// A group's channels, as saved ("#a, b c") → ['a', 'b', 'c'].
function groupChannelNames(raw){ return String(raw || '').split(/[\s,]+/).map(groupChannelName).filter(Boolean); }

// Invites each of `emails` to group channel `name`; → the first error, or ''.
async function inviteToGroupChannel(token, emails, name){
  let error = '';
  for (const e of emails){
    if (!(await slackIdForEmail(e))) continue;   // not on Slack (yet)
    try { await inviteToProjectChannel(token, e, name); }
    catch (err){
      logger.warn('Adding someone to a group channel failed', { channel: name, error: String(err.message) });
      error = error || err.message;
      if (/can.t see|can.t manage/.test(err.message)) break;   // same for everyone after
    }
  }
  return error;
}

exports.onMemberGroup = onDocumentWritten(
  { document: 'members/{email}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const g = groupOf(after);
    const wanted = before && groupOf(before) === g ? [] : channelGroupsFor(g);
    // A new role: its channels too (settings/groups.roleChannels).
    const role = String(after.role || ''), newRole = role && (!before || before.role !== role);
    if (!wanted.length && !newRole) return;
    const set = (await db.collection('settings').doc('groups').get()).data() || {};
    const names = [];
    wanted.forEach(function(h){ groupChannelNames((set.channels || {})[h]).forEach(function(n){ if (names.indexOf(n) < 0) names.push(n); }); });
    if (newRole) groupChannelNames((set.roleChannels || {})[role]).forEach(function(n){ if (names.indexOf(n) < 0) names.push(n); });
    for (const name of names) await inviteToGroupChannel(SLACK_BOT_TOKEN.value(), [event.params.email], name);
  }
);
exports.onGroupChannels = onDocumentWritten(
  { document: 'settings/groups', secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 540 },
  async function(event){
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const doneRef = db.collection('settings').doc('groupsInvited');
    const done = (await doneRef.get()).data() || {};
    const before = done.version === GROUP_RANKING_VERSION ? (done.channels || {}) : {};
    const beforeRoles = done.roles || {};
    const channels = after.channels || {}, roleChannels = after.roleChannels || {};
    // Each group's (and role's) channels not yet filled: new ones, or all of them after the ranking changed.
    const freshIn = function(now, had){ const old = groupChannelNames(had); return groupChannelNames(now).filter(function(n){ return old.indexOf(n) < 0; }); };
    const changed = CHANNEL_GROUPS.filter(function(g){ return freshIn(channels[g], before[g]).length; });
    const changedRoles = Object.keys(roleChannels).filter(function(r){ return freshIn(roleChannels[r], beforeRoles[r]).length; });
    if (!changed.length && !changedRoles.length) return;
    const members = (await db.collection('members').get()).docs.map(function(d){ return Object.assign({ email: d.id }, d.data()); });
    const errors = Object.assign({}, after.channelErrors || {}), roleErrors = Object.assign({}, after.roleChannelErrors || {});
    const fill = async function(emails, names){
      let err = '';
      for (const name of names) err = (await inviteToGroupChannel(SLACK_BOT_TOKEN.value(), emails, name)) || err;
      return err;
    };
    for (const g of changed){
      const err = await fill(members.filter(function(m){ return channelGroupsFor(groupOf(m)).indexOf(g) >= 0; }).map(function(m){ return m.email; }), freshIn(channels[g], before[g]));
      if (err) errors[g] = err; else delete errors[g];
    }
    for (const r of changedRoles){
      const err = await fill(members.filter(function(m){ return m.role === r; }).map(function(m){ return m.email; }), freshIn(roleChannels[r], beforeRoles[r]));
      if (err) roleErrors[r] = err; else delete roleErrors[r];
    }
    Object.keys(roleErrors).forEach(function(r){ if (!groupChannelNames(roleChannels[r]).length) delete roleErrors[r]; });
    // A channel that failed isn't done: saving the settings again retries it.
    const invited = {}, invitedRoles = {};
    CHANNEL_GROUPS.forEach(function(g){ if (groupChannelNames(channels[g]).length && !errors[g]) invited[g] = groupChannelNames(channels[g]).join(', '); });
    Object.keys(roleChannels).forEach(function(r){ if (groupChannelNames(roleChannels[r]).length && !roleErrors[r]) invitedRoles[r] = groupChannelNames(roleChannels[r]).join(', '); });
    await doneRef.set({ channels: invited, roles: invitedRoles, version: GROUP_RANKING_VERSION, at: Date.now() });
    // Replaced whole (a merge would keep errors that are fixed).
    await event.data.after.ref.update({ channelErrors: errors, roleChannelErrors: roleErrors });
  }
);

// A member's request to be in another group, and the PIs' and admins' decision:
// - 'request': { to, note } → { id }; one open request at a time; DMs the PIs and admins.
// - 'withdraw': { id }: their own open request.
// - 'decide': { id, accept }: PIs and admins; accepting sets their group. DMs them.
exports.groupRequest = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'profile', 'edit');   // Who can see what
    const d = request.data || {};
    const col = db.collection('groupRequests');
    const token = SLACK_BOT_TOKEN.value();
    if (d.action === 'request'){
      const m = await db.collection('members').doc(email).get();
      if (!m.exists) throw new HttpsError('failed-precondition', 'Add your details first.');
      const to = String(d.to || '');
      if (GROUPS.indexOf(to) < 0) throw new HttpsError('invalid-argument', 'Choose a group.');
      const from = groupOf(m.data());
      if (to === from) throw new HttpsError('invalid-argument', 'You’re already in ' + GROUP_LABELS[to] + '.');
      const open = await col.where('email', '==', email).where('status', '==', 'open').limit(1).get();
      if (!open.empty) throw new HttpsError('already-exists', 'You already have a request waiting.');
      const name = m.data().name || request.auth.token.name || email;
      const note = String(d.note || '').trim().slice(0, 1000);
      const ref = await col.add({ email, name, from, to, note, status: 'open', at: Date.now() });
      const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
      await sendEvent(token, { emails: staff, headline: '🏷️ ' + slackText(name) + ' asks to move from ' + GROUP_LABELS[from] + ' to ' + GROUP_LABELS[to] +
        (note ? ': “' + slackText(note.slice(0, 300)) + '”' : '') + '. ' + linkedTitle('Approve or decline', joinPageUrl() + '#g=' + ref.id) + '.' });
      return { id: ref.id };
    }
    const id = String(d.id || '');
    if (!validSlug(id)) throw new HttpsError('invalid-argument', 'No request given.');
    const ref = col.doc(id);
    if (d.action === 'withdraw'){
      await db.runTransaction(async function(tx){
        const r = (await tx.get(ref)).data();
        if (!r || r.email !== email) throw new HttpsError('not-found', 'That request isn’t there.');
        if (r.status !== 'open') throw new HttpsError('failed-precondition', 'It’s already been decided.');
        tx.update(ref, { status: 'withdrawn', decidedAt: Date.now() });
      });
      return { ok: true };
    }
    if (d.action !== 'decide') throw new HttpsError('invalid-argument', 'Unknown action.');
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins decide.');
    const accept = !!d.accept;
    const r = await db.runTransaction(async function(tx){
      const r = (await tx.get(ref)).data();
      if (!r) throw new HttpsError('not-found', 'That request isn’t there.');
      if (r.status !== 'open') throw new HttpsError('failed-precondition', 'It’s already been decided.');
      tx.update(ref, { status: accept ? 'approved' : 'declined', decidedBy: email, decidedByName: request.auth.token.name || email, decidedAt: Date.now() });
      if (accept) tx.update(db.collection('members').doc(r.email), { category: r.to, categoryBy: email, categoryAt: Date.now() });
      return r;
    });
    await sendEvent(token, { emails: [r.email], headline: accept
      ? '🏷️ You’re now ' + GROUP_LABELS[r.to] + ' (' + linkedTitle('Who is BOLD', SITE_URL + 'boldiquette.html#who-is-bold') + ').'
      : '🏷️ Your request to move to ' + GROUP_LABELS[r.to] + ' was declined. Ask a PI if you’d like to know more.' });
    return { ok: true };
  }
);

// Slack invite links expire (30 days at most). settings/joinInvite.slackInviteExpires
// (YYYY-MM-DD, set with the link on join-requests.html): three days before, and once it
// has passed, the PIs and admins get a DM to add a new one; welcome emails wait meanwhile
// (welcomeEmail). `reminded` (server only) keeps each DM to once per link and stage.
// Pure: → 'soon' | 'expired' | '' for an expiry date, today.
function inviteReminderStage(expires, todayIso){
  if (!expires) return '';
  if (expires < todayIso) return 'expired';
  const days = (Date.parse(expires + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000;
  return days <= 3 ? 'soon' : '';
}

exports.remindJoinInvite = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] },
  async function(){
    const ref = db.collection('settings').doc('joinInvite');
    const snap = await ref.get();
    const inv = snap.exists ? snap.data() : {};
    const stage = inviteReminderStage(inv.slackInviteExpires || '', todayIsoLondon());
    if (!stage || !inv.slackInviteUrl) return;
    const key = stage + ':' + inv.slackInviteExpires + ':' + inv.slackInviteUrl;
    if (inv.reminded === key) return;
    const headline = (stage === 'expired'
      ? '⚠️ The Slack invite link in the welcome email expired on ' + inv.slackInviteExpires + ': welcome emails wait until there’s a new one. '
      : '⏳ The Slack invite link in the welcome email expires on ' + inv.slackInviteExpires + '. ') +
      'In Slack: Invite people → Copy invite link (the longest expiry), then ' + linkedTitle('add it under Settings', joinPageUrl() + '#settings') + ' with its new expiry date.';
    const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
    await sendEvent(SLACK_BOT_TOKEN.value(), { emails: staff, headline });
    await ref.set({ reminded: key }, { merge: true });
  }
);

// Exported for the standalone unit test only (see scratchpad) — not part
// of the public Cloud Functions surface, harmless to export alongside it.
// ---------- Service desk: recommendation letters ----------
//
// Anyone in the lab asks anyone in the lab for a recommendation letter
// (letters.html). letterRequests/{id}: { requesterEmail, requesterName,
// writerEmail, writerName, purpose, cv, statement, howWorked, best, extra,
// recipients: [{ id, name, url,
// deadline, sentBy: 'writer' | 'requester', submittedAt, letterUrl, reminded }],
// acknowledgedAt, open, at, updatedAt }. Only the two of them read it; every
// write goes through letterRequest, which DMs the other one on Slack. The letter
// itself stays out of BOLD.OS: the writer marks each recipient submitted, and
// shares the letter (letterUrl) only where the requester has to send it on.
// remindLetterWriters nudges the writer before each deadline. Writers are
// BOLD.OS users: accounts that have signed in with Slack (letterWriters).

// The materials are a set list: a link to their CV, optionally a link to a cover
// letter or research statement, and "About your work with me": how they worked
// with the writer and what they did themselves and, optionally, a moment or two
// at their best and anything else relevant.
const LETTER_TEXT = { purpose: 300, cv: 1000, statement: 1000, howWorked: 6000, best: 3000, extra: 3000 };
const LETTER_REMIND_DAYS = [7, 2];
const letterUrl = (id) => SITE_URL + 'letters.html#l=' + id;

// Pure: what letters.html sent → { request } (the fields the requester sets) or { error }.
// `was`: the recipients so far, whose ids, submissions and reminders are kept.
function normalizeLetterRequest(d, was){
  d = d && typeof d === 'object' ? d : {};
  const out = {};
  for (const k of Object.keys(LETTER_TEXT)) {
    const v = String(d[k] == null ? '' : d[k]).trim();
    if (v.length > LETTER_TEXT[k]) return { error: 'That’s too long: ' + k + '.' };
    out[k] = v;
  }
  if (!out.purpose) return { error: 'Say what the letter is for.' };
  if (!/^https?:\/\/\S+$/.test(out.cv)) return { error: 'Give a link to your CV, starting with https://.' };
  if (!out.howWorked) return { error: 'Say how you’ve worked together and what you did yourself.' };
  if (out.statement && !/^https?:\/\/\S+$/.test(out.statement)) return { error: 'The cover letter or statement link starts with https://.' };
  const list = Array.isArray(d.recipients) ? d.recipients : [];
  if (!list.length) return { error: 'Add where the letter goes.' };
  if (list.length > 20) return { error: 'Twenty recipients at most.' };
  const old = {};
  (was || []).forEach((r) => { old[r.id] = r; });
  const seen = {};
  const recipients = [];
  for (const raw of list) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = String(r.name || '').trim(), url = String(r.url || '').trim(), deadline = String(r.deadline || '');
    if (!name) return { error: 'Give each recipient a name.' };
    if (name.length > 200 || url.length > 500) return { error: 'That’s too long: ' + name.slice(0, 40) + '.' };
    if (url && !/^https?:\/\/\S+$/.test(url)) return { error: 'A link starts with https://: ' + name + '.' };
    // The deadline is optional; one without gets no reminders.
    if (deadline && !ISO_DAY.test(deadline)) return { error: 'Give a valid deadline for ' + name + '.' };
    const sentBy = r.sentBy === 'requester' ? 'requester' : 'writer';
    const prev = r.id && old[r.id];
    if (prev && prev.submittedAt && (prev.sentBy !== sentBy)) return { error: 'The letter for ' + prev.name + ' is already in: who sends it can’t change.' };
    const id = prev ? prev.id : crypto.randomBytes(6).toString('hex');
    if (seen[id]) return { error: 'A recipient appears twice.' };
    seen[id] = true;
    recipients.push({
      id, name, url, deadline, sentBy,
      submittedAt: prev ? prev.submittedAt || null : null,
      letterUrl: prev && sentBy === 'requester' ? prev.letterUrl || '' : '',
      // A moved deadline gets its reminders again.
      reminded: prev && prev.deadline === deadline ? prev.reminded || [] : [],
    });
  }
  out.recipients = recipients;
  return { request: out };
}

const letterOpen = (recipients) => recipients.some((r) => !r.submittedAt);

// Pure: the reminders due today → [{ id, recipientId, days }]. `requests`: [{ id, recipients }].
function letterRemindersDue(requests, today){
  const day = (s) => Date.parse(s + 'T00:00:00Z') / 86400000;
  const out = [];
  requests.forEach((q) => (q.recipients || []).forEach((r) => {
    if (r.submittedAt || !r.deadline) return;
    const left = day(r.deadline) - day(today);
    // The nearest reminder not sent yet, once it's due (a missed day still sends it).
    const due = LETTER_REMIND_DAYS.filter((n) => left <= n && left >= 0 && (r.reminded || []).indexOf(n) === -1);
    if (due.length) out.push({ id: q.id, recipientId: r.id, days: Math.min.apply(null, due), left });
  }));
  return out;
}

function letterDeadlines(recipients){
  return recipients.map((r) => slackText(r.name) + ' (' + (r.deadline || 'no deadline') + ')').join(', ');
}

// data: { action, … } → { id? }. Actions:
//   create { writerEmail, purpose, links, notes, recipients }   anyone, for themselves
//   update { id, purpose, links, notes, recipients }              the requester
//   withdraw { id }                                               the requester (deletes it)
//   acknowledge { id }                                            the writer
//   submit { id, recipientId, letterUrl? }, unsubmit { id, recipientId }   the writer
exports.letterRequest = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'service-desk', 'edit');   // Who can see what
    const d = request.data || {};
    const token = SLACK_BOT_TOKEN.value();
    const myName = request.auth.token.name || email;
    const tell = (to, text) => dmByEmail(token, to, text);

    if (d.action === 'create') {
      const writerEmail = String(d.writerEmail || '').trim().toLowerCase();
      if (!writerEmail) throw new HttpsError('invalid-argument', 'Choose your referee.');
      if (writerEmail === email) throw new HttpsError('invalid-argument', 'Choose someone else as your referee.');
      const writer = (await letterWriters()).filter((w) => w.email === writerEmail)[0];
      if (!writer) throw new HttpsError('invalid-argument', 'They haven’t signed in to BOLD.OS yet.');
      const n = normalizeLetterRequest(d, []);
      if (n.error) throw new HttpsError('invalid-argument', n.error);
      const open = await db.collection('letterRequests').where('requesterEmail', '==', email).where('open', '==', true).count().get();
      if (open.data().count >= 50) throw new HttpsError('resource-exhausted', 'You have fifty requests open: withdraw some first.');
      const now = Date.now();
      const ref = await db.collection('letterRequests').add(Object.assign(n.request, {
        requesterEmail: email, requesterName: myName, writerEmail, writerName: writer.name,
        acknowledgedAt: null, open: true, at: now, updatedAt: now,
      }));
      await tell(writerEmail, '✉️ ' + slackText(myName) + ' asked you for a recommendation letter: ' +
        linkedTitle(slackText(n.request.purpose), letterUrl(ref.id)) + '. Deadlines: ' + letterDeadlines(n.request.recipients) + '.\n' +
        '💡 To draft it, copy the prompt under "For your agent" on the request into Claude Code: it uses the <' +
        SITE_URL + 'skill.html?skill=bold-recommendation-letter|bold-recommendation-letter> skill.');
      return { id: ref.id };
    }

    const id = String(d.id || '');
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new HttpsError('invalid-argument', 'No such request.');
    const ref = db.collection('letterRequests').doc(id);
    const mine = (q) => {
      const isRequester = q.requesterEmail === email, isWriter = q.writerEmail === email;
      if (['update', 'withdraw'].indexOf(d.action) !== -1 && !isRequester) throw new HttpsError('permission-denied', 'Only the applicant can do this.');
      if (['acknowledge', 'submit', 'unsubmit'].indexOf(d.action) !== -1 && !isWriter) throw new HttpsError('permission-denied', 'Only the referee can do this.');
    };
    let note = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'No such request: it may have been withdrawn.');
      const q = snap.data();
      mine(q);
      const title = linkedTitle(slackText(q.purpose), letterUrl(id));
      if (d.action === 'update') {
        const n = normalizeLetterRequest(d, q.recipients);
        if (n.error) throw new HttpsError('invalid-argument', n.error);
        tx.update(ref, Object.assign(n.request, { open: letterOpen(n.request.recipients), updatedAt: Date.now() }));
        note = { to: q.writerEmail, text: '✏️ ' + slackText(q.requesterName) + ' updated their letter request: ' +
          linkedTitle(slackText(n.request.purpose), letterUrl(id)) + '. Deadlines: ' + letterDeadlines(n.request.recipients) + '.' };
      } else if (d.action === 'withdraw') {
        tx.delete(ref);
        if (q.open) note = { to: q.writerEmail, text: '↩️ ' + slackText(q.requesterName) + ' withdrew their request for a letter: *' + slackText(q.purpose) + '*. Nothing more to do.' };
      } else if (d.action === 'acknowledge') {
        if (q.acknowledgedAt) return;
        tx.update(ref, { acknowledgedAt: Date.now() });
        note = { to: q.requesterEmail, text: '👍 ' + slackText(q.writerName) + ' got your request for a letter: ' + title + '.' };
      } else if (d.action === 'submit' || d.action === 'unsubmit') {
        const recipients = (q.recipients || []).map((r) => Object.assign({}, r));
        const r = recipients.filter((x) => x.id === d.recipientId)[0];
        if (!r) throw new HttpsError('not-found', 'No such recipient.');
        if (d.action === 'submit') {
          const link = String(d.letterUrl || '').trim();
          if (r.sentBy === 'requester') {
            if (!/^https?:\/\/\S+$/.test(link) || link.length > 1000) throw new HttpsError('invalid-argument', 'Give a link to the letter, starting with https://, for them to send.');
            r.letterUrl = link;
          }
          r.submittedAt = Date.now();
          note = { to: q.requesterEmail, text: r.sentBy === 'requester'
            ? '📎 ' + slackText(q.writerName) + ' shared your letter for ' + slackText(r.name) + ', for you to send' + (r.deadline ? ' by ' + r.deadline : '') + ': ' + title + '.'
            : '✅ ' + slackText(q.writerName) + ' submitted your letter to ' + slackText(r.name) + ': ' + title + '.' };
        } else {
          r.submittedAt = null;
          r.letterUrl = '';
        }
        tx.update(ref, { recipients, open: letterOpen(recipients), acknowledgedAt: q.acknowledgedAt || Date.now(), updatedAt: Date.now() });
      } else {
        throw new HttpsError('invalid-argument', 'Unknown action.');
      }
    });
    if (note) await tell(note.to, note.text);
    return { id };
  }
);

// Everyone who can write a letter: the BOLD.OS users (Slack accounts, not
// disabled) → [{ name, email }], named as on the Slack roster.
async function letterWriters(){
  const users = [];
  let page;
  do {
    page = await admin.auth().listUsers(1000, page && page.pageToken);
    users.push(...page.users);
  } while (page.pageToken);
  const roster = {};
  (await db.collection('people').get()).docs.forEach((doc) => { const p = doc.data(); if (p.email) roster[p.email.toLowerCase()] = p.name; });
  return users
    .filter((u) => u.email && !u.disabled && u.providerData.some((p) => p.providerId === SIGN_IN_PROVIDER))
    .map((u) => { const email = u.email.toLowerCase(); return { email, name: roster[email] || u.displayName || email }; })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// → { writers: [{ name, email }] }, for the "Who writes it" list.
exports.letterWriters = onCall(async (request) => {
  const email = callerEmail(request);
  await access.requireAccess(email, 'service-desk', 'view');   // Who can see what
  return { writers: await letterWriters() };
});

exports.remindLetterWriters = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] },
  async function(){
    const snap = await db.collection('letterRequests').where('open', '==', true).get();
    const byId = {};
    snap.docs.forEach((doc) => { byId[doc.id] = doc.data(); });
    const due = letterRemindersDue(snap.docs.map((doc) => ({ id: doc.id, recipients: doc.data().recipients })), todayIsoLondon());
    for (const x of due) {
      const q = byId[x.id];
      const r = q.recipients.filter((y) => y.id === x.recipientId)[0];
      const when = x.left === 0 ? 'today' : x.left === 1 ? 'tomorrow' : 'in ' + x.left + ' days';
      const sent = await dmByEmail(SLACK_BOT_TOKEN.value(), q.writerEmail, '⏰ ' + slackText(q.requesterName) + '’s letter for ' + slackText(r.name) +
        ' is due ' + when + ' (' + r.deadline + '): ' + linkedTitle(slackText(q.purpose), letterUrl(x.id)) + '.');
      if (!sent) continue;
      // Marks every reminder up to this one sent, so a missed one doesn't follow.
      await db.runTransaction(async (tx) => {
        const s = await tx.get(db.collection('letterRequests').doc(x.id));
        if (!s.exists) return;
        const recipients = s.data().recipients.map((y) => y.id !== x.recipientId ? y
          : Object.assign({}, y, { reminded: Array.from(new Set((y.reminded || []).concat(LETTER_REMIND_DAYS.filter((n) => n >= x.days)))) }));
        tx.update(s.ref, { recipients });
      });
    }
  }
);

// ---------- Service desk: introductions ----------
// introductions.html. Anyone offers to introduce people to someone at an
// organisation they know (introOffers/{id}: { org, area, by: { email, name }, at,
// updatedAt }; written by its author under the rules; no names of whoever they'd
// introduce). Anyone else asks on an offer (introRequests/{id}: { offerId, org,
// area, requesterEmail, requesterName, offererEmail, offererName, why, status:
// asked | accepted | declined | done, reply, at, updatedAt }); only the two of
// them read it, and every write goes through introRequest, which DMs the other.
const INTRO_WHY_MAX = 2000, INTRO_REPLY_MAX = 1000;
const introUrl = (id) => SITE_URL + 'introductions.html' + (id ? '#i=' + id : '');
const INTRO_OPEN = ['asked', 'accepted'];

// data: { action, … } → { id }. Actions:
//   create { offerId, why }        anyone but the offer's author
//   withdraw { id }                the requester, while it's open (deletes it)
//   accept | decline { id, reply? }, done { id }   whoever made the offer
//   withdrawOffer { offerId }      whoever made it, or a PI or admin: deletes the
//                                  offer and closes its open requests (declined)
exports.introRequest = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'service-desk', 'edit');   // Who can see what
    const d = request.data || {};
    const token = SLACK_BOT_TOKEN.value();
    const me = await personFor(email);
    const myName = (me && me.name) || request.auth.token.name || email;
    const tell = (to, text) => dmByEmail(token, to, text);

    if (d.action === 'withdrawOffer') {
      const offerId = String(d.offerId || '');
      if (!/^[A-Za-z0-9]{1,40}$/.test(offerId)) throw new HttpsError('invalid-argument', 'No such offer.');
      const offerRef = db.collection('introOffers').doc(offerId);
      const offerSnap = await offerRef.get();
      if (!offerSnap.exists) throw new HttpsError('not-found', 'That offer has been removed.');
      const o = offerSnap.data(), mine = String((o.by && o.by.email) || '').toLowerCase() === email;
      if (!mine && !(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only whoever made the offer can withdraw it.');
      const open = (await db.collection('introRequests').where('offerId', '==', offerId).get()).docs
        .filter((x) => INTRO_OPEN.indexOf(x.data().status) !== -1);
      const batch = db.batch(), now = Date.now();
      open.forEach((x) => batch.update(x.ref, { status: 'declined', reply: 'The offer was withdrawn.', updatedAt: now }));
      batch.delete(offerRef);
      await batch.commit();
      const by = slackText(String((o.by && o.by.name) || 'Whoever offered it'));
      for (const x of open) {
        await tell(x.data().requesterEmail, '↩️ ' + by + ' withdrew their offer of introductions at ' + linkedTitle(slackText(o.org), introUrl(x.id)) +
          ', so your request is closed.');
      }
      return { closed: open.length };
    }

    if (d.action === 'create') {
      const offerId = String(d.offerId || '');
      if (!/^[A-Za-z0-9]{1,40}$/.test(offerId)) throw new HttpsError('invalid-argument', 'No such offer.');
      const why = String(d.why || '').trim();
      if (!why) throw new HttpsError('invalid-argument', 'Say what you’d like and why.');
      if (why.length > INTRO_WHY_MAX) throw new HttpsError('invalid-argument', 'That’s too long.');
      const offerSnap = await db.collection('introOffers').doc(offerId).get();
      if (!offerSnap.exists) throw new HttpsError('not-found', 'That offer has been removed.');
      const o = offerSnap.data(), offererEmail = String((o.by && o.by.email) || '').toLowerCase();
      if (offererEmail === email) throw new HttpsError('invalid-argument', 'That’s your own offer.');
      const mine = (await db.collection('introRequests').where('requesterEmail', '==', email).get()).docs.map((x) => x.data());
      if (mine.some((q) => q.offerId === offerId && INTRO_OPEN.indexOf(q.status) !== -1)) throw new HttpsError('already-exists', 'You’ve asked on this offer already.');
      if (mine.filter((q) => INTRO_OPEN.indexOf(q.status) !== -1).length >= 50) throw new HttpsError('resource-exhausted', 'You have fifty requests open: withdraw some first.');
      const now = Date.now();
      const ref = await db.collection('introRequests').add({
        offerId, org: String(o.org || ''), area: String(o.area || ''), requesterEmail: email, requesterName: myName,
        offererEmail, offererName: String((o.by && o.by.name) || offererEmail), why, status: 'asked', reply: '', at: now, updatedAt: now,
      });
      await tell(offererEmail, '🤝 ' + slackText(myName) + ' asked you for an introduction at ' + linkedTitle(slackText(o.org), introUrl(ref.id)) +
        ': “' + slackText(why.length > 300 ? why.slice(0, 300) + '…' : why) + '”');
      return { id: ref.id };
    }

    const id = String(d.id || '');
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new HttpsError('invalid-argument', 'No such request.');
    const ref = db.collection('introRequests').doc(id);
    let note = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'No such request: it may have been withdrawn.');
      const q = snap.data();
      const title = linkedTitle(slackText(q.org), introUrl(id));
      if (d.action === 'withdraw') {
        if (q.requesterEmail !== email) throw new HttpsError('permission-denied', 'Only whoever asked can withdraw it.');
        tx.delete(ref);
        if (INTRO_OPEN.indexOf(q.status) !== -1) note = { to: q.offererEmail, text: '↩️ ' + slackText(q.requesterName) + ' withdrew their request for an introduction at *' + slackText(q.org) + '*. Nothing more to do.' };
        return;
      }
      if (['accept', 'decline', 'done'].indexOf(d.action) === -1) throw new HttpsError('invalid-argument', 'Unknown action.');
      if (q.offererEmail !== email) throw new HttpsError('permission-denied', 'Only whoever made the offer can do this.');
      const reply = String(d.reply || '').trim();
      if (reply.length > INTRO_REPLY_MAX) throw new HttpsError('invalid-argument', 'That note is too long.');
      const said = reply ? ': “' + slackText(reply) + '”' : '.';
      if (d.action === 'accept') {
        if (q.status !== 'asked') throw new HttpsError('failed-precondition', 'You’ve answered this one already.');
        tx.update(ref, { status: 'accepted', reply, updatedAt: Date.now() });
        note = { to: q.requesterEmail, text: '🤝 ' + slackText(q.offererName) + ' will introduce you at ' + title + said };
      } else if (d.action === 'decline') {
        if (INTRO_OPEN.indexOf(q.status) === -1) throw new HttpsError('failed-precondition', 'This one is closed already.');
        tx.update(ref, { status: 'declined', reply, updatedAt: Date.now() });
        note = { to: q.requesterEmail, text: '✖️ ' + slackText(q.offererName) + ' can’t introduce you at ' + title + ' this time' + said };
      } else {
        if (q.status !== 'accepted') throw new HttpsError('failed-precondition', 'Say you’ll do it first.');
        tx.update(ref, { status: 'done', updatedAt: Date.now() });
        note = { to: q.requesterEmail, text: '✅ ' + slackText(q.offererName) + ' has introduced you at ' + title + '.' };
      }
    });
    if (note) await tell(note.to, note.text);
    return { id };
  }
);

// ---------- Calls for papers on OpenReview ----------

// When each venue's next call is looked for, as months of the year: from
// `start`, for `months` months. Its submission invitation appears on OpenReview
// months before submissions open (ICLR in Jun–Jul, ICML in Sep–Oct, NeurIPS in
// Feb, 2024–2027), so each window is that, with a month or two either side.
// `offset` takes the year the window starts in to the edition's year.
const CALL_VENUES = [
  { name: 'ICLR', group: 'ICLR.cc', start: 5, months: 5, offset: 1 },
  { name: 'ICML', group: 'ICML.cc', start: 8, months: 6, offset: 1 },
  { name: 'NeurIPS', group: 'NeurIPS.cc', start: 1, months: 5, offset: 0 },
];
const OPENREVIEW_API = 'https://api2.openreview.net';

// The venues to look for on iso (YYYY-MM-DD) → [{ name, group, year }]: each
// venue whose window it's in, with the edition that window is for.
function venueCallsToCheck(iso){
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  return CALL_VENUES.filter((v) => (m - v.start + 12) % 12 < v.months)
    .map((v) => ({ name: v.name, group: v.group, year: (m < v.start ? y - 1 : y) + v.offset }));
}

// The edition's submission invitation, or null if it isn't on OpenReview yet.
// `expired=true` finds it after its deadline too (without it, a 400).
async function openReviewSubmission(group, year){
  const id = group + '/' + year + '/Conference/-/Submission';
  const res = await fetch(OPENREVIEW_API + '/invitations?expired=true&id=' + encodeURIComponent(id));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('OpenReview answered ' + res.status + ' for ' + id);
  const json = await res.json();
  return (json.invitations || [])[0] || null;
}

// The DM for a call found.
function venueCallMessage(name, year, group, inv){
  const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  const when = [inv.cdate && 'submissions open ' + day(inv.cdate), inv.duedate && 'deadline ' + day(inv.duedate)].filter(Boolean).join(', ');
  return '📣 ' + linkedTitle(name + ' ' + year, 'https://openreview.net/group?id=' + encodeURIComponent(group + '/' + year + '/Conference')) +
    ' is on OpenReview' + (when ? ': ' + when : '') + '.';
}

// Mondays 09:00 London: looks for each venue's next call, in its window, and
// DMs the PIs and admins once when it appears (venueCalls/{name}-{year},
// server only).
exports.checkVenueCalls = onSchedule(
  { schedule: '0 9 * * 1', timeZone: 'Europe/London', secrets: [SLACK_BOT_TOKEN] },
  async function(){
    for (const v of venueCallsToCheck(todayIsoLondon())) {
      const ref = db.collection('venueCalls').doc(v.name + '-' + v.year);
      if ((await ref.get()).exists) continue;
      let inv;
      try { inv = await openReviewSubmission(v.group, v.year); }
      catch (err) { logger.warn('checkVenueCalls: OpenReview failed', { venue: v.name, year: v.year, error: String(err) }); continue; }
      if (!inv) continue;
      const text = venueCallMessage(v.name, v.year, v.group, inv);
      const to = Array.from(new Set((await rolesEmails('pis')).concat(await rolesEmails('admins')).map((e) => e.toLowerCase())));
      for (const email of to) await dmByEmail(SLACK_BOT_TOKEN.value(), email, text);
      await ref.set({ venue: v.name, year: v.year, cdate: inv.cdate || null, duedate: inv.duedate || null, notified: to, at: FieldValue.serverTimestamp() });
    }
  }
);

// ---------- Interactions: who did what with whom, for Connections and Network ----------
// interactions/{id}: { kind, group, from, to, at, title, href, thing, source }; `thing`
// is what it happened on ('project:<id>', 'guide:<slug>', …; thingOf), '' if nothing. `from` and `to`
// are lowercase emails; `to` is '' for what someone did on the site on their own. Each
// is derived from a document (`source`, its path) by interactionsFor, and replaced
// whenever that document changes (onInteractionSource); rebuildInteractions derives
// them all again. Tags outside the documents read here are added as they happen
// (onTagged, source '<path>#tags'), and first sign-ins by getMyAccess (source
// 'auth/<uid>'). The lab reads them; nobody writes them but the server.
const INTERACTION_GROUPS = {
  asked: 'joining', invited: 'joining', approved: 'joining', contact: 'joining', supervises: 'joining', 'signed-up': 'joining',
  coauthor: 'working', project: 'working', reviewed: 'working', meeting: 'working', introduced: 'working', letter: 'working',
  tagged: 'talking', replied: 'talking', decided: 'talking',
  registered: 'site', added: 'site', edited: 'site', proposed: 'site', commented: 'site', read: 'site',
  // Between two things, no one's doing: thing → thing2.
  presented: 'related', 'part-of': 'related',
};
const INTERACTION_TOP = ['joinRequests', 'members', 'studies', 'projects', 'projectWorkspaces', 'studyRequests', 'introRequests', 'letterRequests',
  'skills', 'guides', 'events', 'collabWeekSessions'];

const lowerEmail = (v) => String((v && typeof v === 'object' ? v.email : v) || '').trim().toLowerCase();

// Pure, but for `lookup(path)` → that document's data or null (a comment's parent, a
// proposal). A document at `path` → [{ kind, from, to?, toSlack?, at, title, href, key? }]:
// toSlack is a tagged Slack id, made an email by the caller.
async function interactionsFor(path, d, lookup){
  const seg = path.split('/'), out = [];
  if (!d) return out;
  const thing = thingOf(path, d);
  const add = function(kind, from, to, at, title, href, key){
    from = lowerEmail(from); to = lowerEmail(to);
    if (!from || from === to) return;
    out.push({ kind, from, to, at: Number(at) || 0, title: String(title || ''), href: String(href || ''), key: String(key || ''), thing });
  };
  const tags = function(from, text, at, title, href, key){
    taggedIds(text).forEach(function(id){ if (lowerEmail(from)) out.push({ kind: 'tagged', from: lowerEmail(from), toSlack: id, at: Number(at) || 0, title, href, key: (key || '') + id, thing }); });
  };
  // Two things linked (kind: presented, part-of): `thing` (or this document's) → the event `slug`.
  const related = async function(kind, at, title, href, slug, from, key){
    const ev = await lookup('events/' + slug);
    out.push({ kind, from: '', to: '', at: Number(at) || 0, title: String(title || ''), href: String(href || ''), key: String(key || ''), thing: from || thing,
      thing2: 'event:' + slug, title2: String((ev && ev.title) || slug), href2: eventUrl(slug, ev) });
  };
  const top = seg[0], n = seg.length;

  if (n === 2 && top === 'joinRequests'){
    const href = SITE_URL + 'join-requests.html#r=' + seg[1], title = 'Joining BOLD';
    add('asked', d.email, '', d.at, title, href);
    // Once they're a member, their record says who invited them (it may change there).
    if (d.status !== 'approved' && d.invitedBy && d.invitedBy.status === 'confirmed') add('invited', d.invitedBy.email, d.email, d.invitedBy.at || d.at, title, href);
    if (d.status === 'approved') add('approved', d.decidedBy, d.email, d.decidedAt, title, href);
  } else if (n === 2 && top === 'members'){
    add('contact', d.contactEmail, seg[1], d.approvedAt || d.updatedAt, 'Point of contact', SITE_URL + 'people.html');
    if (d.invitedBy && d.invitedBy.status === 'confirmed') add('invited', d.invitedBy.email, seg[1], d.invitedBy.at || d.approvedAt, 'Joining BOLD', SITE_URL + 'people.html');
  } else if (n === 2 && top === 'studies'){
    const title = (d.degree === 'Master student' ? 'Master' : 'PhD') + ' supervision';
    (d.people || []).forEach(function(p){ add('supervises', p.email, seg[1], d.createdAt || d.updatedAt, title, SITE_URL + 'calendar.html'); });
  } else if ((n === 2 && top === 'projects') || (n === 4 && top === 'boards' && seg[2] === 'cards')){
    const href = n === 2 ? projectPageUrl(seg[1]) : cardUrl(seg[1], seg[3]), title = d.title || 'A paper';
    const people = [];
    [d.submittedBy && d.submittedBy.email].concat(d.authorEmails || []).forEach(function(e){ e = lowerEmail(e); if (e && people.indexOf(e) < 0) people.push(e); });
    add('registered', d.submittedBy, '', d.createdAt, title, href);
    people.forEach(function(a, i){ people.slice(i + 1).forEach(function(b){ add('coauthor', a < b ? a : b, a < b ? b : a, d.createdAt, title, href); }); });
    ['junior', 'senior'].forEach(function(role){
      const r = d.reviewers && d.reviewers[role];
      if (r) people.forEach(function(a){ add('reviewed', r, a, d.updatedAt || d.createdAt, title, href, role); });
    });
    const threads = [].concat(d.discussion || [], [].concat.apply([], (d.checklist || []).map(function(it){ return it.comments || []; })));
    threads.forEach(function(m){
      add('commented', m.authorEmail, '', m.timestamp, title, href, m.id);
      tags(m.authorEmail, m.body, m.timestamp, title, href, m.id);
      (m.replies || []).forEach(function(r){
        add('commented', r.authorEmail, '', r.timestamp, title, href, r.id);
        add('replied', r.authorEmail, m.authorEmail, r.timestamp, title, href, r.id);
        tags(r.authorEmail, r.body, r.timestamp, title, href, r.id);
      });
    });
  } else if (n === 2 && top === 'projectWorkspaces'){
    const href = projectPageUrl(d.cardId || seg[1], d.boardId), joined = (d.joined || []).map(lowerEmail);
    (d.members || []).map(lowerEmail).forEach(function(m){
      joined.forEach(function(j){ if (j !== m && !(joined.indexOf(m) >= 0 && m < j)) add('project', j, m, d.createdAt, d.title || 'A project', href); });
    });
  } else if (n === 2 && top === 'studyRequests'){
    if (d.status === 'approved') add('meeting', d.email, d.student, d.decidedAt || d.at, (d.studentName || 'Their') + ' supervision meeting', SITE_URL + 'calendar.html');
  } else if (n === 2 && top === 'introRequests'){
    if (d.status === 'accepted' || d.status === 'done') add('introduced', d.offererEmail, d.requesterEmail, d.updatedAt || d.at, 'An introduction at ' + (d.org || 'an organisation'), introUrl(seg[1]));
  } else if (n === 2 && top === 'letterRequests'){
    add('letter', d.requesterEmail, d.writerEmail, d.at, 'A recommendation letter', letterUrl(seg[1]));
  } else if (n === 2 && ['skills', 'guides', 'events', 'collabWeekSessions'].indexOf(top) >= 0){
    const href = top === 'skills' ? SITE_URL + 'skill.html?skill=' + encodeURIComponent(seg[1]) : top === 'guides' ? guideUrl(seg[1])
      : top === 'events' ? eventUrl(seg[1], d) : SITE_URL + 'session.html?session=' + encodeURIComponent(seg[1]);
    add('added', d.createdBy, '', d.createdAt, d.title || d.name || seg[1], href);
    // A session belongs to its event.
    if (top === 'collabWeekSessions' && d.eventSlug) await related('part-of', d.createdAt || d.updatedAt, d.title || seg[1], href, d.eventSlug);
  } else if (n === 4 && top === 'projectWorkspaces' && seg[2] === 'presentations'){
    // A project presented at one of the site's events (its talk or session folded into it).
    const o = d.occasion || {};
    if (o.kind === 'event' && o.id){
      const ws = (await lookup('projectWorkspaces/' + seg[1])) || {}, cardId = ws.cardId || seg[1];
      const card = ws.boardId ? await lookup('boards/' + ws.boardId + '/cards/' + cardId) : null;
      const project = 'project:' + ((card && card.projectId) || cardId);
      await related('presented', Date.parse(d.date) || d.createdAt || d.at, (card && card.title) || ws.title || d.title || 'A project', projectPageUrl(cardId, ws.boardId), o.id, project, seg[3]);
    }
  } else if (n === 4 && (top === 'guides' || top === 'handbook' || top === 'skills')){
    const page = top === 'guides' ? guideUrl(seg[1]) : top === 'handbook' ? handbookUrl(seg[1]) : SITE_URL + 'skill.html?skill=' + encodeURIComponent(seg[1]);
    const parent = await lookup(top + '/' + seg[1]);
    const title = (parent && (parent.title || parent.name)) || seg[1];
    if (seg[2] === 'versions'){
      add('edited', d.updatedBy, '', d.at || d.updatedAt, title, page);
    } else if (seg[2] === 'readers' && top !== 'skills'){
      add('read', d.email, '', d.readAt || d.at, title, page);
    } else if (seg[2] === 'comments' && top !== 'skills'){
      const href = page + '#c=' + encodeURIComponent(seg[3]);
      add('commented', d.by, '', d.at, title, href);
      tags(d.by && d.by.email, d.text, d.at, title, href);
      const to = d.parent ? await lookup(top + '/' + seg[1] + '/comments/' + d.parent) : d.proposalId ? await lookup(top + '/' + seg[1] + '/proposals/' + d.proposalId) : null;
      if (to) add('replied', d.by, to.by, d.at, title, href);
    } else if (seg[2] === 'proposals' && top !== 'skills'){
      add('proposed', d.by, '', d.at, title, page);
      if ((d.status === 'accepted' || d.status === 'declined') && d.decidedBy) add('decided', d.decidedBy, d.by, d.decidedAt, title, page);
      tags(d.by && d.by.email, [d.after, d.note].concat((d.changes || []).map(function(c){ return c.after; })), d.at, title, page);
    }
  }
  return out;
}

// Pure: the thing an interaction at `path` happened on, as '<type>:<id>' (a project or
// paper, an event, session or talk, a guide or the BOLDiquette, a skill), or '' for
// those between people only (joining, supervision, introductions, letters). Every card of
// a project is the project.
function thingOf(path, d){
  const seg = path.split('/'), id = seg[1] || '';
  if (seg[0] === 'boards' && seg[2] === 'cards' && seg[3]) return 'project:' + ((seg.length === 4 && d && d.projectId) || seg[3]);
  if (seg[0] === 'projects') return 'project:' + ((seg.length === 2 && d && d.projectId) || id);
  const types = { projectWorkspaces: 'project', guides: 'guide', handbook: 'handbook', skills: 'skill', events: 'event', collabWeekSessions: 'session', collabWeekTalks: 'talk' };
  return types[seg[0]] && id ? types[seg[0]] + ':' + id : '';
}

// Whether interactionsFor reads documents at `path`.
function isInteractionSource(path){
  const seg = path.split('/');
  if (seg.length === 2) return INTERACTION_TOP.indexOf(seg[0]) >= 0;
  if (seg.length === 4 && seg[0] === 'boards' && seg[2] === 'cards') return true;
  if (seg.length === 4 && seg[0] === 'projectWorkspaces' && seg[2] === 'presentations') return true;
  return seg.length === 4 && ['guides', 'handbook', 'skills'].indexOf(seg[0]) >= 0 && ['versions', 'readers', 'comments', 'proposals'].indexOf(seg[2]) >= 0;
}

function interactionId(source, x){
  return crypto.createHash('sha1').update([source, x.kind, x.from, x.to, x.at, x.key || ''].join('|')).digest('hex').slice(0, 28);
}

// The interactions of `path` (data: the document, or null if it's gone), made emails
// of tagged Slack ids, as { id: record }.
async function interactionRecords(path, data, slackEmails){
  const list = await interactionsFor(path, data, async function(p){ const s = await db.doc(p).get(); return s.exists ? s.data() : null; });
  const ids = list.filter(function(x){ return x.toSlack && !(x.toSlack in slackEmails); }).map(function(x){ return x.toSlack; });
  Object.assign(slackEmails, await emailsForSlackIds(ids));
  ids.forEach(function(id){ if (!(id in slackEmails)) slackEmails[id] = ''; });
  const out = {};
  list.forEach(function(x){
    const to = x.toSlack ? slackEmails[x.toSlack] : x.to;
    if (x.toSlack && (!to || to === x.from)) return;
    const rec = { kind: x.kind, group: INTERACTION_GROUPS[x.kind], from: x.from, to: to || '', at: x.at, title: x.title, href: x.href, thing: x.thing || '', source: path };
    if (x.thing2) Object.assign(rec, { thing2: x.thing2, title2: x.title2, href2: x.href2 });
    out[interactionId(path, Object.assign({}, x, { to: rec.to }))] = rec;
  });
  return out;
}

// Writes `want` ({ id: record }) in place of `have` ({ id: record }): sets what's new or
// changed, deletes the rest.
async function replaceInteractions(have, want){
  const col = db.collection('interactions');
  let batch = db.batch(), n = 0;
  const step = async function(){ if (++n >= 400){ await batch.commit(); batch = db.batch(); n = 0; } };
  for (const id of Object.keys(have)) if (!want[id]) { batch.delete(col.doc(id)); await step(); }
  for (const id of Object.keys(want)) if (stableJson(have[id] || null) !== stableJson(want[id])) { batch.set(col.doc(id), want[id]); await step(); }
  if (n) await batch.commit();
}

async function syncInteractions(path, data){
  const have = {};
  (await db.collection('interactions').where('source', '==', path).get()).docs.forEach(function(s){ have[s.id] = s.data(); });
  await replaceInteractions(have, await interactionRecords(path, data, {}));
}

function onInteractionSource(document){
  return onDocumentWritten({ document }, async function(event){
    const path = (event.data.after.exists ? event.data.after : event.data.before).ref.path;
    if (!isInteractionSource(path)) return;
    try { await syncInteractions(path, event.data.after.exists ? event.data.after.data() : null); }
    catch (err){ logger.error('Recording interactions failed', { path, error: String(err && err.message || err) }); }
  });
}
exports.onInteractionSource = onInteractionSource('{c1}/{d1}');
exports.onInteractionSourceNested = onInteractionSource('{c1}/{d1}/{c2}/{d2}');

// Tags the documents above don't cover (onTagged): added as they happen, kept.
async function recordTags(path, by, emails, at, place, data){
  if (isInteractionSource(path) || !by) return;
  const source = path + '#tags', batch = db.batch();
  Object.keys(emails).forEach(function(id){
    const to = emails[id];
    if (!to || to === by) return;
    const rec = { kind: 'tagged', group: 'talking', from: by, to, at, title: place.title, href: place.url, thing: thingOf(path, data), source };
    batch.set(db.collection('interactions').doc(interactionId(source, rec)), rec);
  });
  await batch.commit();
}

// Someone's first sign-in (their Firebase account's creation), once.
const signUpsSeen = new Set();
async function recordSignUp(uid, email){
  if (!uid || !email || signUpsSeen.has(uid)) return;
  signUpsSeen.add(uid);
  const source = 'auth/' + uid, rec = { kind: 'signed-up', group: 'joining', from: email, to: '', at: 0, title: 'BOLD.OS', href: SITE_URL, source };
  const ref = db.collection('interactions').doc(crypto.createHash('sha1').update(source).digest('hex').slice(0, 28));
  if ((await ref.get()).exists) return;
  const u = await admin.auth().getUser(uid);
  rec.at = Date.parse(u.metadata.creationTime) || Date.now();
  await ref.set(rec);
}

// Derives every interaction again, from every document they come from (PIs and admins;
// Network → Rebuild). Tags recorded as they happened and sign-ins are kept.
exports.rebuildInteractions = onCall(
  { timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'people', 'view');   // Who can see what
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins can do this.');
    const docs = [];
    for (const c of INTERACTION_TOP) (await db.collection(c).get()).docs.forEach(function(s){ docs.push(s); });
    for (const g of ['cards', 'versions', 'readers', 'comments', 'proposals', 'presentations'])
      (await db.collectionGroup(g).get()).docs.forEach(function(s){ if (isInteractionSource(s.ref.path)) docs.push(s); });
    const want = {}, slackEmails = {};
    for (const s of docs) Object.assign(want, await interactionRecords(s.ref.path, s.data(), slackEmails));
    const have = {};
    (await db.collection('interactions').get()).docs.forEach(function(s){
      const src = String(s.data().source || '');
      if (src.indexOf('auth/') === 0 || /#tags$/.test(src)) return;
      have[s.id] = s.data();
    });
    await replaceInteractions(have, want);
    // First sign-ins, from Firebase Auth.
    try {
      let page;
      do {
        page = await admin.auth().listUsers(1000, page && page.pageToken);
        for (const u of page.users) if (u.email) await recordSignUp(u.uid, String(u.email).toLowerCase());
      } while (page.pageToken);
    } catch (err){ logger.warn('Listing first sign-ins failed', { error: String(err && err.message || err) }); }
    return { count: Object.keys(want).length, sources: docs.length };
  }
);

// A DM to each PI and admin, once each, but not to `except` (whoever caused it).
async function tellStaff(text, except){
  const skip = String(except || '').toLowerCase();
  const emails = Array.from(new Set((await rolesEmails('pis')).concat(await rolesEmails('admins')).map((e) => String(e).toLowerCase()))).filter((e) => e !== skip);
  if (emails.length) await sendEvent(SLACK_BOT_TOKEN.value(), { emails, headline: text });
}

// BOLD.OS for agents: personal tokens (apiTokens) and the read-only API and MCP
// endpoint (boldApi), in functions/api.js.
const agentApi = require('./api')({ access, db, admin, onRequest, onCall, HttpsError, logger, callerEmail, isFullWrite, allProjectsFromCards, projectGroupForCards, workspaceStarted, groupOf, SITE_URL,
  SIGN_IN_PROVIDER, secrets: [SLACK_BOT_TOKEN, GOOGLE_OAUTH, GITHUB_APP], SLACK_BOT_TOKEN,
  // Asking to act, and the decision: the PIs and admins hear of a request, its owner of the decision.
  tellStaff,
  tellPerson: (email, text) => sendEvent(SLACK_BOT_TOKEN.value(), { emails: [email], headline: text }),
  slackText, linkedTitle, joinPageUrl, skillMd, onSchedule,
  callables: () => ({ projectWorkspace: exports.projectWorkspace, projectWork: exports.projectWork, projectChannel: exports.projectChannel, introRequest: exports.introRequest, studyRequest: exports.studyRequest,
    letterRequest: exports.letterRequest, decideProposal: exports.decideProposal, groupRequest: exports.groupRequest, setMyInviter: exports.setMyInviter,
    confirmJoinInvite: exports.confirmJoinInvite, decideJoinRequest: exports.decideJoinRequest, eventSeries: exports.eventSeries }) });
exports.apiTokens = agentApi.apiTokens;
exports.boldApi = agentApi.boldApi;
// Subscribing to the Calendar: one private .ics link a person (calendar.html; served by boldApi).
exports.calendarFeed = agentApi.calendarFeed;
// Recurring lab meetings (series.html, Events): functions/series.js.
const labSeries = require('./series')({ db, onCall, onDocumentWritten, HttpsError, logger, callerEmail, isFullWrite, access, rolesEmails,
  googleFetch, CAL, eventConference, eventTimes, conferenceChange, meetingRecurrence, sameMeetingTimes, seriesStart,
  normalizeMeeting, googleAddressesFor, groupOf, tellStaff, slackText, linkedTitle, SITE_URL, GOOGLE_OAUTH, SLACK_BOT_TOKEN, FieldValue, crypto,
  onSchedule, tellPeople: (emails, text) => sendEvent(SLACK_BOT_TOKEN.value(), { emails, headline: text }) });
exports.eventSeries = labSeries.eventSeries;
exports.onMemberGroupChanged = labSeries.onMemberGroupChanged;
exports.seriesNudges = labSeries.seriesNudges;
exports.onOccurrenceWritten = labSeries.onOccurrenceWritten;
// Where the tools agents add run: no credentials, as whoever calls them (functions/sandbox.js).
exports.mcpSandbox = require('./sandbox')({ onRequest, logger }).mcpSandbox;
// Claude reviews each proposed tool for whoever decides (functions/reviewer.js); needs ANTHROPIC_API_KEY.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
exports.reviewMcpChange = require('./reviewer')({ db, onDocumentWritten, logger, ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, slackText, linkedTitle, SITE_URL,
  tellStaff }).reviewMcpChange;

exports._internal = {
  projectGroupForCard, allProjectsFromCards, closesIssues, githubWorkItem, requestColumn, repoNameOf, normalizeRepo, normalizeProjectChannel, keywordCounts, cappedGroup, roleGroup,
  flattenMessages, newMessages, cardEventsToNotify, homeRefreshTargetsForReviewers,
  newlyAddedAuthorEmails, reviewsOutCandidates, todayIsoLondon, venueUrl, cardUrl, linkedTitle,
  reviewStateEmoji, verifySlackSignatureRaw, appliedProposal, proposalSummary, proposalOutcome, proposalClosed, projectAnnouncement, commentQueueDue, commentRecipients, commentDigest, canAssignReviewer, parseAssignAction,
  reviewerEmailFromAction, cardLine, personOptionsFor, filterPeopleOptions, initialOptionForEmail,
  reviewerPickerBlock, sectionBlocks, buildHomeView, buildUnrecognizedView, profileFieldsFromSlack,
  projectsFromDashboard, badgesForCard, skillMd, skillZip, versionContent, stableJson,
  normalizeMeeting, firstMeetingTimes, meetingRecurrence, projectMembers, normalizeRepo, projectRepoName,
  projectIdOf, projectGroupForCards, workspaceStarted, normalizeJoinRequest, welcomeEmail, mimeMessage,
  normalizeLetterRequest, letterRemindersDue, normalizeStudies, groupOf, roleGroup, channelGroupsFor, seriesStart, normalizeSupervisionChannel, supervisionChannelFor, inviteReminderStage, taggedIds, proposalNewTags, newTags, tagPlace, tagExcerpt, tagMessageId, venueCallsToCheck, venueCallMessage, interactionsFor, isInteractionSource, thingOf
};
