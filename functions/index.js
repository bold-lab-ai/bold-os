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
const { onRequest, onCall: plainOnCall, HttpsError } = require('firebase-functions/v2/https');
const { AsyncLocalStorage } = require('node:async_hooks');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { getFunctions } = require('firebase-admin/functions');
const { beforeUserCreated, HttpsError: IdentityHttpsError } = require('firebase-functions/v2/identity');
const { defineSecret } = require('firebase-functions/params');
// Who can see what's pure helpers (the table, its rows); `access` below is the instance reading settings/access.
const accessLib = require('./access');
// Three-way merges for proposals (#177): shared with the pages (assets/js/merge.js).
const merge = require('./merge');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { createPhotoService } = require('./profile-photos');

admin.initializeApp();
const db = admin.firestore();
const photoService = createPhotoService({
  db, bucket: { file: path => admin.storage().bucket().file(path) }, fetcher: fetch,
  token: () => SLACK_BOT_TOKEN.value(), FieldValue: require('firebase-admin/firestore').FieldValue,
});

// ---------- View as (#172) and branches (#177): a PI or admin previews the site ----------
// The browser (bold.js) adds `viewAs` (a group: the eye chip's View as) and `branch` (an
// open proposal's path: the Version pill) to every callable while they're on. For a PI or
// admin, that call then runs as that group (for the caller only, isFullWrite is false and
// access.groupFor gives the group, so it can only ever see and do less) and, on a branch
// that changes Who can see what, with that proposal's table (access.table), to see what
// it would change. Anyone else's are ignored (their pages still show a branch, from what
// they can read). The rules still read as them.
const VIEW_AS = ['staff', 'internal', 'associate', 'pan'];
const viewing = new AsyncLocalStorage();
function viewingAs(email){
  const v = viewing.getStore();
  return v && v.email === String(email || '').toLowerCase() ? v.group || null : null;
}
function viewingTable(){ const v = viewing.getStore(); return (v && v.pages) || null; }
function onCall(opts, fn){
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return plainOnCall(opts, async (request, response) => {
    const data = request.data;
    if (!data || typeof data !== 'object' || !('viewAs' in data || 'branch' in data)) return fn(request, response);
    const rest = Object.assign({}, data), group = rest.viewAs, branch = rest.branch;
    delete rest.viewAs; delete rest.branch;
    request = Object.assign({}, request, { data: rest });
    const email = request.auth && request.auth.token && request.auth.token.email ? String(request.auth.token.email).toLowerCase() : '';
    if (!email || !(await realFullWrite(email))) return fn(request, response);
    const store = { email };
    if (VIEW_AS.indexOf(group) !== -1) store.group = group;
    if (typeof branch === 'string' && branch) {
      try { const pages = await proposedTable(branch); if (pages) store.pages = pages; }
      catch (err) { logger.warn('A branch’s table couldn’t be worked out', { branch, error: String(err && err.message || err) }); }
    }
    if (!store.group && !store.pages) return fn(request, response);
    return viewing.run(store, () => fn(request, response));
  });
}
// In the emulator, Slack is pretended: every call is written to `slackOutbox` instead.
require('./slack-outbox')(db);

// ---------- Item numbers: #123, one sequence for all of BOLD.OS ----------
// Every request and every card on a board is registered with a number when it's made
// (a GitHub issue or pull request keeps GitHub's, shown with its repository: bold-os#23).
// Kept apart from the items themselves, so any kind can be numbered without touching
// how it's edited: itemNumbers/{path with / as ~}: { number, path, at }, and the next
// number in counters/itemNumbers. Server only (firestore.rules' catch-all).
// `path` is the item's document path, or a key under it for something that can be
// asked more than once (an agent's request to act: apiTokens/<id>/act/<at>).
const numberKey = (path) => String(path).replace(/\//g, '~');
async function numberFor(path){
  const ref = db.collection('itemNumbers').doc(numberKey(path)), counter = db.collection('counters').doc('itemNumbers');
  return db.runTransaction(async function(tx){
    const [had, c] = await Promise.all([tx.get(ref), tx.get(counter)]);
    if (had.exists) return had.data().number;
    const n = (c.exists && c.data().next) || 1;
    tx.set(counter, { next: n + 1 }, { merge: true });
    tx.set(ref, { number: n, path: String(path), at: Date.now() });
    return n;
  });
}
// paths → { path: number } for those already numbered.
async function numbersOf(paths){
  const out = {};
  for (let i = 0; i < paths.length; i += 300){
    const refs = paths.slice(i, i + 300).map(function(p){ return db.collection('itemNumbers').doc(numberKey(p)); });
    if (!refs.length) continue;
    (await db.getAll.apply(db, refs)).forEach(function(d){ if (d.exists) out[d.data().path] = d.data().number; });
  }
  return out;
}
// "#123 " at the start of a Slack message about it (never fails the message).
async function numberTag(path){
  try { return '#' + (await numberFor(path)) + ' '; }
  catch (err){ logger.warn('Numbering failed', { path, error: String(err && err.message || err) }); return ''; }
}

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

// And only the BOLD Slack's own people (2026-11-05): not someone from another organisation in a
// channel shared with ours (Slack Connect), who isn't on the roster (syncPeopleFromSlack). Someone who
// just joined the Slack and isn't on it yet is looked up on Slack, and added if they're ours.
const NOT_BOLD_SLACK = 'BOLD.OS is for the BOLD Slack’s members: this Slack account belongs to another organisation.';
exports.onlySlackSignUps = beforeUserCreated({ secrets: [SLACK_BOT_TOKEN] }, async (event) => {
  const provider = (event.additionalUserInfo && event.additionalUserInfo.providerId) ||
    (event.credential && event.credential.providerId) || '';
  if (provider !== SIGN_IN_PROVIDER) {
    logger.warn('onlySlackSignUps: refused a sign-up', { provider });
    throw new IdentityHttpsError('permission-denied', 'BOLD.OS is for the BOLD Slack: sign in with Slack.');
  }
  const slack = ((event.data && event.data.providerData) || []).filter((p) => p.providerId === SIGN_IN_PROVIDER)[0];
  const id = slack && slack.uid;
  if (!id || !/^U[A-Z0-9]+$/.test(id)) throw new IdentityHttpsError('permission-denied', NOT_BOLD_SLACK);
  if ((await db.collection('people').doc(id).get()).exists) return;
  // Not on the roster (yet): ask Slack.
  const token = SLACK_BOT_TOKEN.value();
  const info = await fetch('https://slack.com/api/users.info?' + new URLSearchParams({ user: id }), { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => r.json()).catch(() => null);
  const auth = await slackAuthInfo(token).catch(() => null), team = auth && auth.teamId;
  const u = info && info.ok && info.user;
  if (!u || u.deleted || u.is_bot || !team || u.team_id !== team || slackExternal(u, team) || !(u.profile && u.profile.email)) {
    logger.warn('onlySlackSignUps: refused a Slack account not of the BOLD Slack', { slackId: id });
    throw new IdentityHttpsError('permission-denied', NOT_BOLD_SLACK);
  }
  await upsertPerson(u, team);
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
  const snap = await db.collection('people').where('email', '==', String(email).toLowerCase()).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data().slackId || null;
}

// ---------- Notifications (notifications.html, 2026-11-05) ----------
// notifications/{id} (server only; each person reads and marks read their own, firestore.rules):
// { to: email, source: 'slack' | 'conversations', feature, text, href, at, read }. Every DM and
// note-to-one BOLD OS sends on Slack is kept here for whom it's for (not a pilot's copies to its
// testers), and so are the Conversations ones (replies where they are, new conversations). Kept for good.
// Pure: Slack's mrkdwn → plain text and its first link: <url|label> → label, *bold* → bold.
function slackToPlain(text){
  const t = String(text || '');
  const first = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/.exec(t);
  const plain = t.replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, '$2').replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<@[A-Z0-9]+(?:\|([^>]*))?>/g, (m, n) => '@' + (n || 'someone')).replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1').replace(/<![^>]*>/g, '')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,:;!?])/g, '$1$2').replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,:;!?])/g, '$1$2')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  return { text: plain.slice(0, 2000), href: first ? first[1] : '' };
}
// Keeps a notification for each of `emails` (never fails what sent it). n: { text (mrkdwn or plain),
// href?, feature, source, about? (what it's on, e.g. 'conversation:<id>') }.
async function noteFor(emails, n){
  try {
    const list = Array.from(new Set((emails || []).map((e) => String(e || '').toLowerCase()).filter(Boolean)));
    if (!list.length) return;
    const p = slackToPlain(n.text);
    const base = { source: n.source || 'slack', feature: n.feature || '', text: p.text, href: n.href || p.href || '', about: n.about || '', at: Date.now(), read: false };
    // A meeting about to start (meetingReminders): its link, offered as Join until it ends.
    if (n.join) { base.join = n.join; base.endsAt = n.endsAt || 0; }
    for (let i = 0; i < list.length; i += 400) {
      const b = db.batch();
      list.slice(i, i + 400).forEach((to) => b.set(db.collection('notifications').doc(), Object.assign({ to }, base)));
      await b.commit();
    }
    // On their computers too, where they turned desktop notifications on (functions/push.js); not what
    // reaches everyone (n.ping false: a new conversation).
    // Not to whoever unticked its kind (Notifications › Settings).
    if (n.ping !== false) {
      const want = [];
      for (const e of list) if (notifyKinds.wants((await notifyPrefsOf(e)).off, base.feature)) want.push(e);
      if (want.length) await webPush.pushTo(want, base.text, base.href, n.join ? { join: n.join } : undefined);
    }
  } catch (err){ logger.warn('Keeping a notification failed', { feature: n.feature, error: String(err && err.message || err) }); }
}

// Opens (or reuses) a DM channel and posts one message. Never throws —
// logs and resolves false on any failure, so one bad recipient (no Slack
// id, a transient API error) can't take the rest of a batch down with it,
// and a retry of the whole trigger isn't forced by one skipped DM.
// With a feature's key (LIVE_FEATURES, PILOTS), a feature in pilot sends to its testers instead.
async function dmBySlackId(token, slackId, text, key, opts){
  opts = opts || {};
  try {
    // Everything for someone is in their Notifications Inbox first; whoever's on pings (pilot
    // notification-pings: its testers, then everyone) gets a "new notifications" ping on Slack
    // instead of the message itself. opts.raw: a message that's an answer to what they just did, sent as is.
    if (!opts.raw) {
      const email = await emailForSlackId(slackId);
      if (email) {
        if (!opts.noNote) await noteFor([email], { text, feature: opts.kind || key || '', source: 'slack' });
        opts = Object.assign({}, opts, { noNote: true });
        const way = await slackWayFor(email, opts.kind || key);
        if (way === 'off') return true;
        if (way === 'pings') { await queuePing(email); return true; }
      }
    }
    if (key) {
      const st = await pilotState(key);
      if (!st.live) {
        const p = (await db.collection('people').doc(slackId).get()).data();
        return toTesters(token, st, (p && p.name) || slackId, text);
      }
    }
    const opened = await slackFetch(token, 'conversations.open', { users: slackId });
    if (!opened.ok) return false;
    const posted = await slackFetch(token, 'chat.postMessage', { channel: opened.channel.id, text: text });
    return !!posted.ok;
  } catch (err){
    logger.error('dmBySlackId threw', { slackId, error: String(err) });
    return false;
  }
}

async function dmByEmail(token, email, text, key, opts){
  opts = opts || {};
  // Their Inbox first, whatever happens on Slack (a feature in pilot too); then a ping, or the message.
  // opts.kind: what it's about, when that's finer than its feature's key (a reply to your own message).
  if (!opts.noNote) await noteFor([email], { text, feature: opts.kind || key || '', source: 'slack' });
  const way = await slackWayFor(email, opts.kind || key);
  if (way === 'off') return true;
  if (way === 'pings') { await queuePing(email); return true; }
  if (key) {
    const st = await pilotState(key);
    if (!st.live) return toTesters(token, st, await nameForEmail(email), text);
  }
  const slackId = await slackIdForEmail(email);
  if (!slackId){
    logger.info('No Slack id for email — skipping DM', { email });
    return false;
  }
  return dmBySlackId(token, slackId, text, '', { raw: true });
}

// ---------- Pings: "You have new notifications" (pilot notification-pings, 2026-11-05) ----------
// Whoever is on pings (the pilot's testers; everyone once it's live) gets no message-by-message DMs:
// each notification goes to their Inbox, and slackPings/{email} (server only: { pending, firstAt,
// lastPingAt }) counts what's new; sendNotificationPings, every 5 minutes, DMs them once that they
// have new notifications, at most every 30 minutes, if any is still unread.
const PING_GAP = 30 * 60 * 1000;
async function pingsFor(email){
  if (!email) return false;
  const st = await pilotState('notification-pings');
  return st.live || st.testers.map((t) => String(t).toLowerCase()).indexOf(String(email).toLowerCase()) >= 0;
}
// What someone hears of outside their Inbox (Notifications › Settings, 2026-11-06): notifyPrefs/{email}
// { slack, off, at }, theirs to set (firestore.rules). slack: 'all' (each message), 'pings' (a ping that there are
// new ones; the default while pilot notification-pings is live, or they test it) or 'off' (nothing on Slack).
// off: the kinds they unticked (notify-kinds.js): those reach their Inbox only, neither Slack nor their computers.
// Answers to what they just did (opts.raw) and channel posts aren't theirs to turn off here.
const SLACK_WAYS = ['all', 'pings', 'off'];
const notifyKinds = require('./notify-kinds');
async function notifyPrefsOf(email){
  if (!email) return {};
  const d = await db.collection('notifyPrefs').doc(String(email).toLowerCase()).get().catch(() => null);
  return d && d.exists ? d.data() : {};
}
// → 'all' | 'pings' | 'off' for a notification of `feature` (none: Slack messages' choice alone).
async function slackWayFor(email, feature){
  if (!email) return 'all';
  const pref = await notifyPrefsOf(email);
  if (feature && !notifyKinds.wants(pref.off, feature)) return 'off';
  if (SLACK_WAYS.indexOf(pref.slack) >= 0) return pref.slack;
  return (await pingsFor(email)) ? 'pings' : 'all';
}
async function queuePing(email){
  const ref = db.collection('slackPings').doc(String(email).toLowerCase());
  await ref.set({ pending: FieldValue.increment(1), firstAt: FieldValue.serverTimestamp() }, { merge: true })
    .catch((err) => logger.warn('Queueing a ping failed', { error: String(err && err.message || err) }));
}
// Everyone in `emails` told (their Inbox), and pinged if they're on pings. n: noteFor's.
async function deliver(emails, n){
  const list = Array.from(new Set((emails || []).map((e) => String(e || '').toLowerCase()).filter(Boolean)));
  if (!list.length) return;
  await noteFor(list, n);
  if (n.ping === false) return;
  for (const e of list) if ((await slackWayFor(e, n.feature)) === 'pings') await queuePing(e);
}
// Pure: the ping's text.
function pingText(n, url){ return '🔔 You have ' + (n === 1 ? 'a new notification' : n + ' new notifications') + ' on BOLD.OS: <' + url + '|' + (n === 1 ? 'open it' : 'open them') + '>. _<' + url + '#settings|Change what you get on Slack>_'; }
exports.sendNotificationPings = onSchedule({ schedule: 'every 5 minutes', secrets: [SLACK_BOT_TOKEN] }, async function(){
  const due = (await db.collection('slackPings').where('pending', '>', 0).get()).docs;
  const now = Date.now(), url = SITE_URL + 'notifications.html';
  for (const d of due) {
    const p = d.data();
    if (p.lastPingAt && now - p.lastPingAt < PING_GAP) continue;
    try {
      // Turned off since it was queued: nothing on Slack.
      if ((await slackWayFor(d.id)) === 'off') { await d.ref.set({ pending: 0 }, { merge: true }); continue; }
      const unread = (await db.collection('notifications').where('to', '==', d.id).where('read', '==', false).count().get()).data().count;
      if (unread) {
        const id = await slackIdForEmail(d.id);
        if (id) await dmBySlackId(SLACK_BOT_TOKEN.value(), id, pingText(unread, url), '', { raw: true });
      }
      await d.ref.set({ pending: 0, lastPingAt: now }, { merge: true });
    } catch (err){ logger.warn('Sending a ping failed', { error: String(err && err.message || err) }); }
  }
});

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
// ---------- Cards from Slack: /bug and /feature-request ----------
// Either opens a form (views.open) for a card, in To do, on the board of the channel it's
// typed in: a project's own channel (its workspace's slackChannel), or one a board takes
// besides (work.channels: BOLD OS's takes #bold-operating-system). A project's #proj-
// channel without a board: the project's people (submitter, authors, members), PIs and
// admins get the form, the board added with the card (the form says so); anyone else is
// told whom to ask. Any other channel (#general, #supervision-…, a DM) says so instead. The form: its title (from what was typed after the
// command), a description, and, ticked, posting it in the project's channel. Submitting
// the form is the go-ahead (the ground rule: it asks before posting); closing it adds
// nothing. Whoever types it needs Projects' Edit, as on the page; the card is theirs.
// It also puts it in one of the board's milestones (work.milestones; ended ones aren't
// offered), or names a new one: made for whoever plans them (the project's people, PIs and
// admins: mayAddBoard), proposed in the card's description for anyone else.
const SLASH_CARDS = { '/bug': { kind: 'code', prefix: 'Bug: ', what: 'bug' }, '/feature-request': { kind: 'request', prefix: 'Feature request: ', what: 'feature request' } };
// → { id, ws } (the board's project), or { error: 'noboard', id, ws } (a project's channel,
// no board) or { error: 'elsewhere' }.
async function slashBoard(channelName){
  const name = String(channelName || '').replace(/^#/, '').toLowerCase();
  if (!name || name === 'directmessage' || name === 'privategroup') return { error: 'elsewhere' };
  const on = (d) => !!(d.data().work || {}).on;
  const extra = (await db.collection('projectWorkspaces').where('work.channels', 'array-contains', name).get()).docs.filter(on)[0];
  if (extra) return { id: extra.id, ws: extra.data() };
  const own = (await db.collection('projectWorkspaces').where('slackChannel', 'in', ['#' + name, name]).get()).docs;
  const withBoard = own.filter(on)[0];
  if (withBoard) return { id: withBoard.id, ws: withBoard.data() };
  if (own.length) return { error: 'noboard', id: own[0].id, ws: own[0].data() };
  return { error: 'elsewhere' };
}
// Whether they may add a board to the project (as on its page, and its people too).
async function mayAddBoard(email, board){
  if ((board.ws.members || []).map((e) => String(e).toLowerCase()).indexOf(email) >= 0) return true;
  const card = await cardRefFor(board.ws.cardId || board.id, board.ws.boardId || null).get();
  return card.exists ? !!(await canEditCard(email, card.data())) : !!(await isFullWrite(email));
}
// A board's milestones ([{ id, name, start, end }]).
function slashMilestones(ws){ return ((ws && ws.work) || {}).milestones || []; }
async function handleSlashCommand(token, body){
  if (body.command === '/meeting') return handleMeetingCommand(token, body);
  const c = SLASH_CARDS[body.command];
  const say = (text) => ({ response_type: 'ephemeral', text });
  if (!c) return say('BOLD.OS doesn’t know ' + body.command + '.');
  const email = await emailForSlackId(body.user_id);
  if (!email) return say('Sign in to BOLD.OS once first, so it knows who you are: ' + SITE_URL);
  if (!(await access.can(email, 'projects', 'edit'))) return say('Adding cards is for whoever can edit Projects (BOLDiquette › Who can see what).');
  const board = await slashBoard(body.channel_name);
  const chName = String(body.channel_name || '').toLowerCase();
  let addBoard = false;
  if (board.error === 'noboard') {
    const pname = board.ws.title ? slackText(board.ws.title) : 'This project';
    const page = linkedTitle('its page', projectPageUrl(board.ws.cardId || board.id, board.ws.boardId));
    if (!/^proj-/.test(chName)) return say(pname + ' doesn’t have a board: add one on ' + page + ' in BOLD.OS, then try again.');
    if (!(await mayAddBoard(email, board))) return say(pname + ' doesn’t have a board yet: ask someone on the project (its submitter, authors or people), or a PI or admin, to add one, here or on ' + page + '.');
    addBoard = true;
  }
  if (board.error === 'elsewhere' && /^proj-/.test(chName)) return say('No project in BOLD.OS uses #' + chName + ': register it first (' + SITE_URL + 'projects-register.html), then try again.');
  if (board.error === 'elsewhere'){
    // Where BOLD.OS's own cards go (the board with work.content): its channels, from its settings.
    const os = (await db.collection('projectWorkspaces').where('work.content', '==', true).get()).docs.map((d) => d.data()).filter((x) => (x.work || {}).on)[0];
    const chans = os ? [os.slackChannel].concat((os.work.channels || []).map((n) => '#' + n)).filter(Boolean) : [];
    return say(body.command + ' adds a card to a project’s board: type it in the project’s Slack channel' + (chans.length ? ' (for BOLD.OS itself, ' + chans.join(' or ') + ')' : '') + '.');
  }
  const channel = String(board.ws.slackChannel || '').replace(/^#/, '');
  const typed = String(body.text || '').trim();
  const plans = addBoard || await mayAddBoard(email, board);
  const today = new Date().toISOString().slice(0, 10);
  const open = slashMilestones(board.ws).filter((m) => !m.end || m.end >= today).slice(0, 100);
  const blocks = [
    { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' },
      element: { type: 'plain_text_input', action_id: 'v', max_length: 200, initial_value: (c.prefix + typed).slice(0, 200) } },
  ].concat(c.what === 'bug' ? BUG_BLOCKS : [
    { type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Description' },
      element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, placeholder: { type: 'plain_text', text: c.kind === 'code' ? 'What happens, what you expected, and how to make it happen again (a link, a command, a config)' : 'What it’s for, and who’d use it' } } },
  ]);
  // Screenshots or images (#…, 2026-11-05): Slack's own upload field; attached to the card after it's added
  // (onCardImageImport), as on its page.
  blocks.push({ type: 'input', block_id: 'images', optional: true, label: { type: 'plain_text', text: 'Images' },
    element: { type: 'file_input', action_id: 'v', filetypes: SLACK_IMAGE_TYPES, max_files: SLACK_IMAGES_MAX },
    hint: { type: 'plain_text', text: 'Screenshots or other images: PNG, JPEG, GIF or WebP, up to 10 MB each.' } });
  if (open.length) blocks.push({ type: 'input', block_id: 'milestone', optional: true, label: { type: 'plain_text', text: 'Milestone' },
    element: { type: 'static_select', action_id: 'v', placeholder: { type: 'plain_text', text: 'None' },
      options: open.map((m) => ({ text: { type: 'plain_text', text: (m.name + (m.end ? ' (until ' + m.end + ')' : '')).slice(0, 75) }, value: m.id })) } });
  blocks.push({ type: 'input', block_id: 'newMilestone', optional: true, label: { type: 'plain_text', text: open.length ? 'Or a new milestone' : 'Milestone' },
    element: { type: 'plain_text_input', action_id: 'v', max_length: 60, placeholder: { type: 'plain_text', text: 'A new milestone’s name' } },
    hint: { type: 'plain_text', text: plans ? 'Adds it to the board’s milestones, with the card in it.' : 'Proposes it, in the card’s description: the project’s people add milestones.' } });
  if (channel && (board.ws.skipped || []).indexOf('channel') < 0) blocks.push({ type: 'input', block_id: 'announce', optional: true, label: { type: 'plain_text', text: 'Slack' },
    element: { type: 'checkboxes', action_id: 'v', options: [{ text: { type: 'plain_text', text: 'Post it in #' + channel + ', for everyone in the channel' }, value: 'yes' }],
      initial_options: [{ text: { type: 'plain_text', text: 'Post it in #' + channel + ', for everyone in the channel' }, value: 'yes' }] } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: addBoard
    ? slackText(board.ws.title || 'This project') + ' has no board yet: adding the card adds one, on its project page, with the card in To do.'
    : 'Adds it to ' + slackText(board.ws.title || 'BOLD OS') + '’s board, in To do.' }] });
  const view = (bl) => ({ trigger_id: body.trigger_id, view: {
    type: 'modal', callback_id: 'work_card', title: { type: 'plain_text', text: c.what === 'bug' ? 'Report a bug' : 'Request a feature' },
    submit: { type: 'plain_text', text: 'Add it' }, close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ pid: board.id, kind: c.kind, what: c.what, channel: body.channel_id || '', addBoard }), blocks: bl } });
  let opened = await slackFetch(token, 'views.open', view(blocks));
  // Slack refusing the images field (its upload field, or the app without files:read): the form without it.
  if (!opened.ok && /invalid|block|scope/.test(String(opened.error || ''))) {
    logger.warn('The card form with images was refused; opening it without', { error: opened.error, details: opened.response_metadata });
    opened = await slackFetch(token, 'views.open', view(blocks.filter((b) => b.block_id !== 'images')));
  }
  if (!opened.ok) { logger.warn('Opening the card form failed', { error: opened.error }); return say('Couldn’t open the form — try again.'); }
  return {};
}
// The form submitted: the card, as the page would add it (firestore.rules validWork), then a
// note to them alone with its number and link. onWorkCardAdded posts it in the channel.
// /bug's form (2026-11-05): a proper report, in sections. Only the title and What happened are needed.
const BUG_SEVERITY = { blocks: 'blocks me', annoying: 'annoying', cosmetic: 'cosmetic' };
const BUG_BLOCKS = [
  { type: 'input', block_id: 'happened', label: { type: 'plain_text', text: 'What happened' },
    element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, placeholder: { type: 'plain_text', text: 'What you saw, with any error message' } } },
  { type: 'input', block_id: 'expected', optional: true, label: { type: 'plain_text', text: 'What you expected' },
    element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 2000 } },
  { type: 'input', block_id: 'steps', optional: true, label: { type: 'plain_text', text: 'Steps to reproduce' },
    element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, placeholder: { type: 'plain_text', text: '1. Open …\n2. Click …\n3. See …' } } },
  { type: 'input', block_id: 'severity', optional: true, label: { type: 'plain_text', text: 'How bad is it?' },
    element: { type: 'radio_buttons', action_id: 'v', options: [
      { text: { type: 'plain_text', text: 'Blocks me' }, description: { type: 'plain_text', text: 'I can’t do what I need' }, value: 'blocks' },
      { text: { type: 'plain_text', text: 'Annoying' }, description: { type: 'plain_text', text: 'There’s a workaround' }, value: 'annoying' },
      { text: { type: 'plain_text', text: 'Cosmetic' }, description: { type: 'plain_text', text: 'It looks wrong, but works' }, value: 'cosmetic' }] } },
  { type: 'input', block_id: 'device', optional: true, label: { type: 'plain_text', text: 'Device and browser' },
    element: { type: 'plain_text_input', action_id: 'v', max_length: 120, placeholder: { type: 'plain_text', text: 'e.g. Chrome, Mac, or Safari, iPhone' } } },
];
// Pure: the form's values (view.state.values) → { where, happened, expected, steps, severity, device }.
function bugReportOf(values){
  const v = values || {}, text = (b) => String(((v[b] || {}).v || {}).value || '').trim();
  const sev = (((v.severity || {}).v || {}).selected_option || {}).value || '';
  return { where: text('where'), happened: text('happened'), expected: text('expected'), steps: text('steps'),
    severity: BUG_SEVERITY[sev] ? sev : '', device: text('device') };
}
// Pure: a report → its description (Markdown, a heading per section given).
function bugNotes(r){
  const out = [];
  if (r.severity) out.push('**Severity:** ' + BUG_SEVERITY[r.severity].charAt(0).toUpperCase() + BUG_SEVERITY[r.severity].slice(1));
  [['Where', r.where], ['What happened', r.happened], ['What I expected', r.expected], ['Steps to reproduce', r.steps], ['Device and browser', r.device]]
    .forEach(function(x){ if (x[1]) out.push('### ' + x[0] + '\n' + x[1]); });
  return out.join('\n\n');
}
// Pure: the card's title with its severity: "Bug: x" → "Bug (blocks me): x"; another title gets it in front.
function bugTitle(title, severity){
  const t = String(title || '').trim();
  if (!BUG_SEVERITY[severity]) return t;
  const tag = 'Bug (' + BUG_SEVERITY[severity] + ')';
  return (/^bug\s*:/i.test(t) ? tag + ':' + t.replace(/^bug\s*:/i, '') : tag + ': ' + t).slice(0, 200);
}

// Images on a card added from Slack (/bug, /feature-request): what Slack's upload field gives, kept to
// images within the limits a card's page has (PNG, JPEG, GIF, WebP; 10 MB; 20 a card).
const SLACK_IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const SLACK_IMAGES_MAX = 5;
const CARD_IMAGE_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// Pure: Slack's files → [{ id, name, mimetype, size, url }] of the images to fetch.
function slackImagesOf(files){
  return (Array.isArray(files) ? files : []).filter(function(f){
    return f && CARD_IMAGE_MIME[f.mimetype] && Number(f.size) > 0 && Number(f.size) <= 10 * 1024 * 1024 && /^https:\/\/files\.slack\.com\//.test(String(f.url_private_download || f.url_private || ''));
  }).slice(0, SLACK_IMAGES_MAX).map(function(f){
    return { id: String(f.id || ''), name: String(f.name || 'image').slice(0, 200), mimetype: f.mimetype, size: Number(f.size), url: String(f.url_private_download || f.url_private) };
  });
}
// cardImageImports/{id} (server only): { ws, card, files, email, at } → each image fetched from Slack (as the
// bot: files:read) and put where the card's page puts its own (Storage, work/<ws>/<card>/…), then on the card.
exports.onCardImageImport = onDocumentCreated({ document: 'cardImageImports/{id}', secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 120 }, async (event) => {
  const d = event.data && event.data.data();
  if (!d || d.doneAt) return;
  const cardRef = db.collection('projectWorkspaces').doc(String(d.ws)).collection('work').doc(String(d.card));
  const added = [], failed = [];
  const bucket = admin.storage().bucket();
  for (const f of slackImagesOf(d.files)) {
    try {
      const res = await fetch(f.url, { headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN.value() } });
      const type = String(res.headers.get('content-type') || '').split(';')[0];
      if (!res.ok || !CARD_IMAGE_MIME[type]) throw new Error('Slack gave ' + res.status + ' ' + type);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 10 * 1024 * 1024) throw new Error('too big');
      const path = 'work/' + d.ws + '/' + d.card + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + CARD_IMAGE_MIME[type];
      const token = crypto.randomUUID();
      await bucket.file(path).save(buf, { contentType: type, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
      added.push({ path, url: 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name + '/o/' + encodeURIComponent(path) + '?alt=media&token=' + token,
        name: f.name, by: d.email, at: Date.now() });
    } catch (err){ failed.push(f.name); logger.warn('Attaching an image from Slack failed', { file: f.id, error: String(err && err.message || err) }); }
  }
  if (added.length) await db.runTransaction(async function(tx){
    const c = await tx.get(cardRef);
    if (!c.exists) return;
    tx.update(cardRef, { images: (c.data().images || []).concat(added).slice(0, 20) });
  });
  await event.data.ref.set({ doneAt: Date.now(), added: added.length, failed }, { merge: true });
});

async function addCardFromSlack(token, payload){
  const meta = JSON.parse(payload.view.private_metadata || '{}');
  const v = payload.view.state && payload.view.state.values || {};
  const val = (b) => (v[b] && v[b].v) || {};
  const email = await emailForSlackId(payload.user && payload.user.id);
  if (!email || !(await access.can(email, 'projects', 'edit'))) return;
  const wsRef = db.collection('projectWorkspaces').doc(String(meta.pid || ''));
  let wsSnap = await wsRef.get();
  if (!wsSnap.exists) return;
  // A project's #proj- channel without a board: the board, added first (as the page's Add one).
  if (!((wsSnap.data().work || {}).on)) {
    if (!meta.addBoard || !(await mayAddBoard(email, { id: wsSnap.id, ws: wsSnap.data() }))) return;
    await wsRef.set({ work: Object.assign({ repos: [], content: false }, wsSnap.data().work || {}, { on: true, updatedAt: Date.now(), updatedBy: email }) }, { merge: true });
    workCache.delete(wsSnap.id);
    wsSnap = await wsRef.get();
  }
  const person = (await db.collection('people').where('email', '==', email).limit(1).get()).docs[0];
  const name = (person && person.data().name) || email.split('@')[0];
  let title = String(val('title').value || '').trim().slice(0, 200);
  if (!title) return;
  const now = Date.now();
  let notes = String(val('notes').value || '').trim();
  // A bug report (/bug): its sections as the description, its severity in its title.
  if (meta.what === 'bug') {
    const r = bugReportOf(v);
    notes = bugNotes(r);
    title = bugTitle(title, r.severity);
  }
  // Its milestone: one picked, or a new one named (one of the same name is that one).
  const ms = slashMilestones(wsSnap.data());
  const picked = (val('milestone').selected_option || {}).value || '';
  const fresh = String(val('newMilestone').value || '').trim().slice(0, 60);
  let milestone = ms.some((m) => m.id === picked) ? picked : '', proposed = '', made = '';
  if (fresh) {
    const same = ms.find((m) => m.name.toLowerCase() === fresh.toLowerCase());
    if (same) milestone = same.id;
    else if (ms.length < 50 && await mayAddBoard(email, { id: wsSnap.id, ws: wsSnap.data() })) {
      milestone = Math.random().toString(36).slice(2, 10); made = fresh;
      await wsRef.update({ 'work.milestones': ms.concat([{ id: milestone, name: fresh, start: '', end: '' }]), 'work.updatedAt': now, 'work.updatedBy': email });
    } else {
      proposed = fresh;
      notes = (notes ? notes + '\n\n' : '') + '**Proposed milestone:** ' + fresh;
    }
  }
  const ref = await db.collection('projectWorkspaces').doc(wsSnap.id).collection('work').add(Object.assign({
    title, notes: notes.slice(0, 20000), kind: meta.kind === 'request' ? 'request' : 'code', column: 'todo',
    assignees: [], assigneeEmails: [], links: [], announce: !!(val('announce').selected_options || []).length,
    by: { email, name }, at: now, movedAt: now, updatedAt: now, updatedBy: email,
  }, milestone ? { milestone } : {}));
  const num = await numberFor(ref.path);
  // Its images, from Slack: fetched and attached by onCardImageImport (Slack waits 3 seconds for this answer).
  const files = slackImagesOf(val('images').files);
  if (files.length) await db.collection('cardImageImports').add({ ws: wsSnap.id, card: ref.id, files, email, at: now });
  const url = projectPageUrl(wsSnap.data().cardId || wsSnap.id, wsSnap.data().boardId) + '&tab=work&card=' + encodeURIComponent(ref.id);
  const mName = milestone && ((ms.find((m) => m.id === milestone) || {}).name || made);
  const text = '✅ Added #' + num + ' to the board: ' + linkedTitle(slackText(title), url) +
    (made ? ', in the new milestone ' + slackText(made) : mName ? ', in ' + slackText(mName) : '') + '.' +
    (proposed ? ' Milestone ' + slackText(proposed) + ' is proposed in its description: the project’s people add milestones.' : '');
  const sent = meta.channel ? await slackFetch(token, 'chat.postEphemeral', { channel: meta.channel, user: payload.user.id, text }) : { ok: false };
  if (!sent.ok) await dmBySlackId(token, payload.user.id, text, '', { raw: true });
}

// ---------- /meeting (#325, 2026-11-11): a one-off meeting with everyone in the channel ----------
// Typed in a channel BOLD OS is in, it opens a form (title, when, how long, a description, a link) naming
// everyone it invites: the channel's members with a BOLD.OS address. Sending it is the go-ahead; closing
// it sends nothing. oneOffMeetings/{id} (server only) then has onOneOffMeeting make the event from the
// lab's Google account (functions/slack-meeting.js), Google emailing the invitations, and tell whoever
// sent it, to them alone. For anyone signed in to BOLD.OS once.
const slackMeeting = require('./slack-meeting');
// A channel's members to invite → { emails, names, others }, or null when BOLD OS can't see them.
async function meetingInvitees(token, channelId){
  const ids = await groupChannelMemberIds(token, channelId);
  if (!ids) return null;
  const people = {};
  for (let i = 0; i < ids.length; i += 100) {
    const snaps = await db.getAll(...ids.slice(i, i + 100).map((id) => db.collection('people').doc(String(id))));
    snaps.forEach((d) => { if (d.exists) people[d.id] = d.data(); });
  }
  return slackMeeting.inviteesOf(ids, people);
}
async function handleMeetingCommand(token, body){
  const say = (text) => ({ response_type: 'ephemeral', text });
  const email = await emailForSlackId(body.user_id);
  if (!email) return say('Sign in to BOLD.OS once first, so it knows who you are: ' + SITE_URL);
  const name = String(body.channel_name || '');
  if (!body.channel_id || name === 'directmessage') return say('/meeting invites everyone in a channel: type it in one BOLD OS is in.');
  const who = await meetingInvitees(token, body.channel_id);
  if (!who) return say('BOLD OS can’t see who’s in this channel: add it (/invite @BOLD OS), then try again.');
  if (!who.emails.length) return say('Nobody in this channel has a BOLD.OS account to invite.');
  if (who.emails.length > slackMeeting.MAX_GUESTS) return say('/meeting invites up to ' + slackMeeting.MAX_GUESTS + ' people, and this channel has ' + who.emails.length + '.');
  const shown = name === 'privategroup' ? 'this conversation' : name;
  // What was typed ("tomorrow at 1pm for 30min") fills the form in, read in their own time zone (Slack's).
  const u = await (await fetch('https://slack.com/api/users.info?' + new URLSearchParams({ user: body.user_id }), { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => null);
  const typed = slackMeeting.parseText(body.text, Date.now(), (u && u.ok && u.user && u.user.tz) || slackMeeting.TZ);
  const tz = (u && u.ok && u.user && u.user.tz) || slackMeeting.TZ;
  const opened = await slackFetch(token, 'views.open', slackMeeting.formView({ triggerId: body.trigger_id, title: typed.title, start: typed.start, minutes: typed.minutes, tz,
    channelId: body.channel_id, channelName: shown, names: who.names, others: who.others, now: Date.now() }));
  if (!opened.ok) { logger.warn('Opening the meeting form failed', { error: opened.error, details: opened.response_metadata }); return say('Couldn’t open the form — try again.'); }
  return {};
}
// The form's buttons. Suggest a time: says it's looking, then queues meetingSuggestions/{id} (reading everyone's
// calendars takes longer than Slack waits) for onMeetingSuggest. A suggestion: When set to it.
async function handleMeetingAction(token, payload){
  const action = (payload.actions || [])[0] || {}, v = payload.view;
  if (String(action.action_id || '').indexOf(slackMeeting.PICK) === 0) {
    const r = await slackFetch(token, 'views.update', { view_id: v.id, hash: v.hash, view: slackMeeting.withWhen(slackMeeting.viewOf(v), Number(action.value)) });
    if (!r.ok) logger.warn('Setting a suggested time failed', { error: r.error });
    return null;
  }
  if (action.action_id !== slackMeeting.SUGGEST) return null;
  const minutes = slackMeeting.minutesOf(v.state && v.state.values);
  const waiting = slackMeeting.withSuggestions(slackMeeting.viewOf(v), { status: 'Looking for a time when everyone’s free for ' + minutes + ' minutes…' });
  const r = await slackFetch(token, 'views.update', { view_id: v.id, hash: v.hash, view: waiting });
  if (!r.ok) { logger.warn('Suggest a time: updating the form failed', { error: r.error }); return null; }
  const meta = JSON.parse(v.private_metadata || '{}');
  await db.collection('meetingSuggestions').add({ viewId: v.id, view: JSON.stringify(waiting), channel: String(meta.channel || ''), tz: String(meta.tz || slackMeeting.TZ),
    minutes, by: String(payload.user && payload.user.id || ''), at: Date.now() });
  return null;
}
// The form sent: checked (what to fix goes back to the form), then queued for onOneOffMeeting.
async function handleMeetingSubmit(token, payload){
  const m = slackMeeting.meetingOf(payload.view.state && payload.view.state.values, Date.now());
  if (m.errors) return { response_action: 'errors', errors: m.errors };
  const slackId = payload.user && payload.user.id;
  const email = await emailForSlackId(slackId);
  if (!email) return { response_action: 'errors', errors: { title: 'Sign in to BOLD.OS once first, so it knows who you are.' } };
  const meta = JSON.parse(payload.view.private_metadata || '{}');
  const person = (await db.collection('people').doc(String(slackId)).get()).data() || {};
  await db.collection('oneOffMeetings').add(Object.assign({}, m, {
    by: { email, name: person.name || email.split('@')[0], slackId }, channel: String(meta.channel || ''), channelName: String(meta.name || ''), at: Date.now() }));
  return null;
}

async function handleInteractivity(token, payload){
  if (payload.type === 'view_submission' && payload.view && payload.view.callback_id === 'work_card') return addCardFromSlack(token, payload);
  if (payload.type === 'view_submission' && payload.view && payload.view.callback_id === slackMeeting.CALLBACK) return handleMeetingSubmit(token, payload);
  if (payload.type === 'block_actions' && payload.view && payload.view.callback_id === slackMeeting.CALLBACK) return handleMeetingAction(token, payload);
  // Take it to the BOLD OS, a message shortcut (functions/slack-thread.js).
  if (payload.type === 'message_action' && payload.callback_id === 'send_to_conversations') return conversationsSlack.handleShortcut(payload);
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
// ---------- Pilots: a new Slack feature reaches only its testers until it's live ----------
// settings/pilot: { testers: [emails], pilotTesters: { <feature>: [emails] }, live: { <feature>: true },
// known: { <feature>: label } }: a feature in pilot goes to every pilot's testers and its own.
// (Settings › Features, settings.html#features; PIs and admins). A new feature sends through pilotSlack
// with a key of its own: until it's switched live there (it starts in pilot), whatever
// it would send goes to the testers instead, each message marked with whom it was for, so
// they see it all in the real Slack and nobody else hears a thing. With no testers, nobody.
// pilotSlack(token, key, label, { emails?: [..], channel?: 'name', text, blocks? }).
// Every feature is also in PILOTS, so Pilots lists it as soon as it's deployed (each server
// instance adds what's missing to `known` when it starts), before it first sends anything.
const PILOTS = {
  'card-comments': 'Comments on board cards',
  'card-done': 'Telling who raised a card it’s done',
  'project-invites': 'Invitations to a project, and their answers',
  'group-ready': 'Done what your new group asks',
  'group-trial': 'A new group’s first week: the reminder, and its end',
  'group-eligible': 'Telling PIs someone meets the next group’s requirements',
  'project-setup': 'An ongoing project’s setup still missing (once)',
  'channel-join': 'BOLD OS joins new public channels',
  'conversation-sent': 'A thread sent to Conversations: a reply in it saying so',
  'conversation-moved': 'A reply in Slack to a thread moved to Conversations: a note, to them alone, to reply there',
  'conversation-replies': 'A reply in a conversation you’re in: a DM',
  'conversation-invites': 'An invitation to a conversation: a DM',
  'notification-pings': 'Notifications: a ping on Slack that there are new ones, instead of each message',
  'channel-alignment': 'Slack channels follow BOLD.OS: removing whoever isn’t meant to be in one, and telling them',
};
// Every Slack feature from before Pilots: listed too, and live unless switched off there
// (listPilots sets each one live the first time; until then it counts as live). Each sends
// with its key: dmByEmail, dmBySlackId, sendEvent ({ key }), postInChannel, tellStaff,
// tellPerson, tellPeople. Replies to someone's own click in Slack (a slash command's
// answer) have no key: they always go.
const LIVE_FEATURES = {
  'venue-proposed': 'A venue proposed for Internal Review (to PIs and admins)',
  'venue-calls': 'New calls for papers (to PIs and admins)',
  'irb-board': 'Internal Review: papers, reviewers and reviews',
  'irb-author-cap': 'Internal Review: authors on too many papers',
  'irb-reviews-out': 'Internal Review: reviews out',
  'proposals': 'Proposed changes (to PIs and admins)',
  'proposal-decided': 'Proposed changes accepted or declined',
  'proposal-reviewer': 'The reviewer’s concerns about a proposed change (to PIs and admins)',
  'guide-comments': 'Comments on guides and the BOLDiquette',
  'tags': 'Tagging someone',
  'project-announce': 'New projects in #all-active-projects',
  'card-added': 'New board cards in the project’s channel',
  'supervision-requests': 'Asking to join a supervision meeting',
  'join-requests': 'Requests to join BOLD',
  'inviter-confirm': 'Confirming who invited someone',
  'group-requests': 'Requests to change group',
  'invite-link-reminder': 'The Slack invite link expiring (to PIs and admins)',
  'letters': 'Recommendation letters',
  'introductions': 'Introductions',
  'agent-requests': 'Letting an agent act',
  'series-added': 'Added as an organiser of an event series',
  'series-due': 'An event series’ next edition due',
};
let pilotsListed = null;
function listPilots(){
  if (!pilotsListed) pilotsListed = db.collection('settings').doc('pilot').get().then((s) => {
    const d = s.data() || {}, known = d.known || {}, live = d.live || {}, all = Object.assign({}, LIVE_FEATURES, PILOTS);
    // Missing, or named differently now (a renamed page): the label is the code's.
    const missing = Object.keys(all).filter((k) => known[k] !== all[k]), wasLive = Object.keys(LIVE_FEATURES).filter((k) => !(k in live));
    if (missing.length || wasLive.length) return s.ref.set(Object.assign({ known: Object.fromEntries(missing.map((k) => [k, all[k]])) },
      wasLive.length ? { live: Object.fromEntries(wasLive.map((k) => [k, true])) } : {}), { merge: true });
  }).catch((err) => { pilotsListed = null; logger.warn('Listing the pilots failed', { error: String(err && err.message || err) }); });
  return pilotsListed;
}
if (process.env.K_SERVICE) listPilots();
// settings/pilot, read at most every 30 seconds per server instance.
let pilotRead = null;
async function pilotSettings(){
  if (!pilotRead || Date.now() - pilotRead.at > 30000) pilotRead = { at: Date.now(), d: db.collection('settings').doc('pilot').get().then((x) => x.data() || {}) };
  try { return await pilotRead.d; } catch (err){ pilotRead = null; logger.warn('Reading the pilots failed', { error: String(err && err.message || err) }); return {}; }
}
// Whether feature `key` messages whom it's for → { live, testers, label }. Live: switched live
// under Pilots, or one from before Pilots never switched off. Pure on the settings.
function pilotStateOf(d, key){
  const live = d.live || {}, label = (d.known || {})[key] || PILOTS[key] || LIVE_FEATURES[key] || key;
  return { live: key in live ? live[key] === true : !!LIVE_FEATURES[key], label,
    testers: Array.from(new Set((d.testers || []).concat(((d.pilotTesters || {})[key]) || []))) };
}
async function pilotState(key){ return pilotStateOf(await pilotSettings(), key); }
function pilotNote(label, forWhom){ return '🧪 *Pilot of ' + slackText(label) + '*, for ' + (forWhom || 'nobody') + ' (only testers get it until it’s live):'; }
async function nameForEmail(e){
  const p = (await db.collection('people').where('email', '==', String(e).toLowerCase()).limit(1).get()).docs[0];
  return (p && p.data().name) || String(e).split('@')[0];
}
// A message for whom it's for, in pilot: to each tester instead, marked. → true.
async function toTesters(token, st, forWhom, text, blocks, attachments){
  const note = pilotNote(st.label, forWhom);
  for (const t of st.testers) {
    const id = await slackIdForEmail(t);
    if (!id) continue;
    const open = await slackFetch(token, 'conversations.open', { users: id });
    if (open.ok) await slackFetch(token, 'chat.postMessage', Object.assign({ channel: open.channel.id, text: note + '\n' + text, unfurl_links: false },
      blocks ? { blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: note }] }].concat(blocks) } : {},
      // A card (attachments): the note above it, the card as they'd see it.
      attachments ? { blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: note }] }], attachments } : {}));
  }
  return true;
}
// A post in a channel (by id; name for the pilot's note), as feature `key`. → Slack's answer.
async function postInChannel(token, key, channelId, name, args){
  const st = await pilotState(key);
  if (!st.live) { await toTesters(token, st, '#' + String(name || channelId).replace(/^#/, ''), args.text || '', args.blocks, args.attachments); return { ok: true, pilot: true }; }
  return slackFetch(token, 'chat.postMessage', Object.assign({ channel: channelId }, args));
}
// A message only `user` sees, in a channel or one of its threads (chat.postEphemeral), as feature `key`;
// in pilot, to its testers instead. args: { channel, user, thread_ts, text }.
async function nudgeInThread(token, key, args){
  const st = await pilotState(key);
  if (!st.live) {
    const p = (await db.collection('people').where('slackId', '==', String(args.user || '')).limit(1).get()).docs[0];
    await toTesters(token, st, (p && p.data().name) || 'someone', args.text || '', null, args.attachments);
    return { ok: true, pilot: true };
  }
  const res = await slackFetch(token, 'chat.postEphemeral', Object.assign({ unfurl_links: false }, args));
  if (!res.ok) logger.warn('Slack ephemeral message failed', { feature: key, error: res.error });
  else await noteFor([await emailForSlackId(args.user)], { text: args.text || '', href: ((((args.attachments || [])[0] || {}).blocks || []).map((b) => ((b.elements || [])[0] || {}).url).filter(Boolean)[0]) || '', feature: key, source: 'slack' });
  return res;
}
async function pilotSlack(token, key, label, m){
  const ref = db.collection('settings').doc('pilot');
  const d = (await ref.get()).data() || {};
  if (!(d.known || {})[key]) await ref.set({ known: { [key]: label } }, { merge: true });
  const st = pilotStateOf(Object.assign({}, d, { known: Object.assign({ [key]: label }, d.known || {}) }), key);
  const send = async (channel, text, blocks) => {
    const res = await slackFetch(token, 'chat.postMessage', Object.assign({ channel, text, unfurl_links: false }, blocks ? { blocks } : {}));
    if (!res.ok) logger.warn('Slack message failed', { feature: key, error: res.error });
  };
  const dm = async (email, text, blocks) => {
    const id = await slackIdForEmail(email);
    if (!id) return;
    const open = await slackFetch(token, 'conversations.open', { users: id });
    if (open.ok) await send(open.channel.id, text, blocks);
  };
  // Their Inbox first, in pilot too; whoever's on pings gets a ping instead of the message.
  const emails = [];
  for (const e of Array.from(new Set((m.emails || []).map((x) => String(x).toLowerCase())))) {
    await noteFor([e], { text: m.text, feature: key, source: 'slack' });
    const way = await slackWayFor(e, key);
    if (way === 'pings') await queuePing(e); else if (way === 'all') emails.push(e);
  }
  m = Object.assign({}, m, { emails });
  if (!emails.length && !m.channel) return { pilot: !st.live, pinged: true };
  if (st.live) {
    for (const e of emails) await dm(e, m.text, m.blocks);
    if (m.channel) { const id = await slackChannelId(token, String(m.channel).replace(/^#/, '')); if (id) await send(id, m.text, m.blocks); }
    return { pilot: false };
  }
  const forWhom = [m.channel ? '#' + String(m.channel).replace(/^#/, '') : ''].concat(await Promise.all((m.emails || []).map(nameForEmail))).filter(Boolean).join(', ');
  await toTesters(token, st, forWhom, m.text, m.blocks);
  return { pilot: true };
}

// event: { emails, headline, excludeEmail?, key: the feature (LIVE_FEATURES, PILOTS) }.
async function sendEvent(token, event){
  const unique = Array.from(new Set(event.emails.filter(Boolean)))
    .filter(function(e){ return e !== event.excludeEmail; });
  await Promise.all(unique.map(function(email){ return dmByEmail(token, email, event.headline, event.key); }));
}

// ---------- 1. Venue proposal needs approval ----------
// PIs and admins are the only ones who can approve/reject (see
// onApproveVenue/onRejectVenue in audit-board.html) — notify all of them
// the moment a proposal exists, rather than relying on someone happening
// to open the board and see "Pending your approval".

// An event added from the site starts hidden; whoever added it (or organises its series)
// releases it from its page (firestore.rules, events/{slug}), so nobody else is told. It's
// numbered here, as every request is (it's on the board until it's released).
exports.onEventAdded = onDocumentCreated(
  { document: 'events/{slug}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const data = event.data && event.data.data();
    if (!data || data.hidden !== true) return;
    await numberTag('events/' + event.params.slug);
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
    const headline = '🔔 ' + await numberTag('boards/' + event.params.boardId) + 'New venue proposal: ' + linkedTitle(data.label, url) + ' — proposed by ' + proposer +
      '. It needs your approval before it’s visible to the lab.';
    await sendEvent(token, { key: 'venue-proposed',
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
  // Who can see what: a row from a page's eye chip, or the part's rows that differ.
  if (q.kind === 'access') return slackText(accessLib.accessChangeText(q.area, q.before, q.after));
  if (q.partId === accessLib.ACCESS_PART && (q.kind === 'add' || q.kind === 'edit')) {
    const rows = accessLib.accessRowsChanged(q.kind === 'edit' && q.before ? q.before.body : '', (q.after || {}).body);
    if (q.kind === 'edit' && rows && rows.length) return 'a change to who can see ' + rows.join(', ');
  }
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

// A link to one proposed change: on the BOLDiquette and the guides, the change itself
// (#proposal-<id>, pages/guide.js); elsewhere the page's list.
function proposalAnchor(collection, id){
  return (collection === 'handbook' || collection === 'guides') && id ? '#proposal-' + id : '#proposals';
}

function onProposed(collection, pageUrl){
  return onDocumentCreated(
    { document: collection + '/{slug}/proposals/{id}', secrets: [SLACK_BOT_TOKEN] },
    async function(event){
      const q = event.data && event.data.data();
      // On a branch: its people hear of the branch once (onBranchWritten), not of each page.
      if (!q || q.status !== 'open' || q.branch) return;
      const doc = await db.collection(collection).doc(event.params.slug).get();
      // A new skill or tool has no document yet: its proposal carries the title.
      const name = (doc.exists && doc.data().title) || (q.after && q.after.title) || event.params.slug;
      const who = (q.by && (q.by.name || q.by.email)) || 'Someone';
      const link = linkedTitle(slackText(name), pageUrl(event.params.slug) + proposalAnchor(collection, event.params.id));
      const what = q.kind === 'new' && !doc.exists
        ? ' proposed a new ' + (collection === 'agentTools' ? 'tool' : 'skill') + ', ' + link
        : ' suggested ' + proposalSummary(q) + ' in ' + link;
      const headline = '🔔 ' + await numberTag(event.data.ref.path) + slackText(who) + what +
        (q.note ? ': “' + slackText(String(q.note).slice(0, 300)) + '”' : '') +
        '. It needs a PI or admin to accept or decline it.';
      const pis = await rolesEmails('pis');
      const admins = await rolesEmails('admins');
      await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'proposals',
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
      if ((after || before).branch) return;   // a branch's decision is told once (onBranchWritten)
      // Its conversation (comment-conversation.js), if it has one: the decision written into it.
      const closed = proposalClosed(before, after);
      if (closed) {
        const tref = db.collection('conversations').doc('cm-change-' + collection + '-' + event.params.slug + '-' + event.params.id);
        if ((await tref.get()).exists) {
          const last = (await tref.collection('messages').orderBy('at', 'desc').limit(1).get()).docs[0];
          await tref.collection('messages').add({ parent: last ? last.id : tref.id, body: '**' + closed.resolvedWith.charAt(0).toUpperCase() + closed.resolvedWith.slice(1) + '**.',
            name: closed.resolvedByName || closed.resolvedBy || 'Someone', createdBy: closed.resolvedBy, at: FieldValue.serverTimestamp(), source: 'proposal', votes: {} }).catch(() => {});
          await tref.set({ replies: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
        }
      }
      const title = (doc.exists && doc.data().title) || ((before && before.after) || {}).title || event.params.slug;
      const out = proposalOutcome(before, after, title, pageUrl(event.params.slug));
      if (!out) return;
      const token = SLACK_BOT_TOKEN.value();
      const proposer = before.by && before.by.email ? String(before.by.email).toLowerCase() : '';
      const decider = after && after.decidedBy ? String(after.decidedBy).toLowerCase() : '';
      const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'))
        .map((e) => String(e).toLowerCase()).filter((e) => e !== proposer && e !== decider);
      const jobs = [sendEvent(token, { key: 'proposal-decided', emails: staff, headline: out.others })];
      if (out.proposer && proposer) jobs.push(sendEvent(token, { key: 'proposal-decided', emails: [proposer], headline: out.proposer }));
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

// A branch (functions/branches.js): the PIs and admins hear when it's opened; its author when someone else commits
// to it; everyone who committed to it, and the PIs and admins, when it's decided or withdrawn.
const branchUrl = (id) => SITE_URL + 'proposal.html?b=' + encodeURIComponent(id);
exports.onBranchWritten = onDocumentWritten({ document: 'branches/{id}', secrets: [SLACK_BOT_TOKEN] }, async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null, after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  const id = event.params.id, token = SLACK_BOT_TOKEN.value();
  const link = linkedTitle(slackText(after.title || 'a proposed change'), branchUrl(id)), tag = await numberTag('branches/' + id);
  const author = String((after.by && after.by.email) || '').toLowerCase(), who = slackText((after.by && (after.by.name || after.by.email)) || 'Someone');
  const staff = async () => (await rolesEmails('pis')).concat(await rolesEmails('admins')).map((e) => String(e).toLowerCase());
  const pagesText = (n) => n === 1 ? '' : ' (' + n + ' pages)';
  if (!before) {
    // Made from a proposed change of before branches (the migration): its people heard of it then.
    if (after.status !== 'open' || after.migrated) return;
    await sendEvent(token, { key: 'proposals', emails: await staff(), excludeEmail: author,
      headline: '🔔 ' + tag + who + ' proposed ' + link + pagesText((after.pages || []).length) + '. It needs a PI or admin to accept or decline it.' });
    return;
  }
  if (before.status === 'open' && after.status !== 'open') {
    const decider = String(after.decidedBy || '').toLowerCase(), by = slackText(after.decidedByName || after.decidedBy || 'A PI or admin');
    const icon = after.status === 'accepted' ? '✅ ' : after.status === 'withdrawn' ? '↩️ ' : '✖️ ';
    const people = (after.contributors || []).concat(await staff()).map((e) => String(e).toLowerCase())
      .filter((e, i, a) => e && e !== decider && a.indexOf(e) === i);
    // Its conversation, if it has one: the decision written into it.
    const tref = db.collection('conversations').doc('cm-branch-' + id);
    if ((await tref.get()).exists) {
      const last = (await tref.collection('messages').orderBy('at', 'desc').limit(1).get()).docs[0];
      await tref.collection('messages').add({ parent: last ? last.id : tref.id, body: '**' + after.status.charAt(0).toUpperCase() + after.status.slice(1) + '**.',
        name: after.decidedByName || after.decidedBy || 'Someone', createdBy: decider, at: FieldValue.serverTimestamp(), source: 'proposal', votes: {} }).catch(() => {});
      await tref.set({ replies: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }
    await sendEvent(token, { key: 'proposal-decided', emails: people, headline: icon + tag + by + ' ' + after.status + ' ' + link + '.' });
    return;
  }
  // Someone new committed to it: its author hears.
  const added = (after.contributors || []).filter((e) => (before.contributors || []).indexOf(e) < 0);
  if (after.status === 'open' && added.length && author && added.indexOf(author) < 0) {
    await sendEvent(token, { key: 'proposals', emails: [author], headline: '✏️ ' + tag + 'Someone else committed to your proposed change ' + link + '.' });
  }
});

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
  'letterRequests', 'introRequests', 'joinRequests', 'members', 'hackathonJoins', 'projectWorkspaces', 'guides', 'handbook', 'interactions', 'privateInteractions',
  // Conversations (Experimental, 2026-11-04): no Slack messages from it while it's an experiment.
  'conversations', 'conversationImports', 'cardImageImports', 'notifications'];
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
      const sent = await dmBySlackId(SLACK_BOT_TOKEN.value(), id, text, 'tags');
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
        linkedTitle(slackText((doc.exists && doc.data().title) || (q.after || {}).title || event.params.slug), pageUrl(event.params.slug) + proposalAnchor(collection, event.params.id)) + ': ' + proposalSummary(q) + '.';
      const emails = await emailsForSlackIds(ids);
      for (const id of ids) if (emails[id] && emails[id] !== by) await dmBySlackId(SLACK_BOT_TOKEN.value(), id, text, 'tags');
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
      if (taken.collection === 'work') { await flushCardTalk(taken); continue; }
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
      await Promise.all(Object.keys(byPerson).map((email) => dmByEmail(token, email, commentDigest(byPerson[email], name, url), 'guide-comments')));
    }
  }
);

// ---------- A board card's conversation (talk.js), in Slack, batched ----------
// A comment on a card (projectWorkspaces/{pid}/work/{id}/comments/{cid}) joins the card's
// queue (commentQueue/work__{pid}__{id}), sent as the guides' are (flushCommentQueue): one
// message per person, through pilotSlack ('card-comments'). Who hears: whoever made the card,
// its assignees and whoever has commented on it, and whoever a comment tags (an edit: only
// whoever it newly tags); nobody of their own.
function queueCardTalk(event, item){
  const ref = db.collection('commentQueue').doc('work__' + event.params.pid + '__' + event.params.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const q = snap.exists ? snap.data() : { collection: 'work', pid: event.params.pid, card: event.params.id, slug: event.params.pid + '/' + event.params.id, items: [], firstAt: Date.now() };
    q.items = (q.items || []).concat([item]).slice(-200);
    q.lastAt = Date.now();
    tx.set(ref, q);
  });
}
const talkItem = (id, c, extra) => Object.assign({ id, text: String(c.text || '').slice(0, 300), tagged: taggedIds(c.text),
  by: { email: String((c.by && c.by.email) || '').toLowerCase(), name: String((c.by && c.by.name) || '') }, at: c.at || Date.now() }, extra || {});
// ---------- Projects' titles and meetings, for whoever doesn't see the projects ----------
// projectTitles/{pid}: what the Calendar shows of a project to someone with Projects' Edit
// but not View (BOLD-associates, as the table has it): its title, when it meets and
// whether it's paused or completed, how many are on it and its Slack channel, to join it.
// No links, files or people. Kept by onWorkspaceTitles from the workspace; read by the
// Calendar (firestore.rules), written only here.
// Pure: a workspace → its projectTitles document (null: none).
function projectTitleDoc(id, ws){
  if (!ws || !ws.title) return null;
  const out = { title: ws.title, cardId: ws.cardId || id, boardId: ws.boardId || null, group: ws.group || '',
    meeting: ws.meeting || null, meetingMoved: ws.meetingMoved || {}, hasEvent: !!ws.eventId, eventStart: ws.eventStart || '', pausedAt: ws.pausedAt || 0,
    completedAt: ws.completedAt || 0, slackChannel: ws.slackChannel || '', memberCount: (ws.members || []).length };
  return out;
}
exports.onWorkspaceTitles = onDocumentWritten('projectWorkspaces/{pid}', async function(event){
  const ref = db.collection('projectTitles').doc(event.params.pid);
  const before = projectTitleDoc(event.params.pid, event.data.before.exists ? event.data.before.data() : null);
  const after = projectTitleDoc(event.params.pid, event.data.after.exists ? event.data.after.data() : null);
  if (JSON.stringify(before) === JSON.stringify(after) && (await ref.get()).exists === !!after) return;
  if (after) await ref.set(after); else await ref.delete();
});

exports.onCardCommented = onDocumentCreated('projectWorkspaces/{pid}/work/{id}/comments/{cid}', async function(event){
  const c = event.data && event.data.data();
  if (c) await queueCardTalk(event, talkItem(event.params.cid, c));
});
exports.onCardCommentEdited = onDocumentUpdated('projectWorkspaces/{pid}/work/{id}/comments/{cid}', async function(event){
  const c = event.data.after.data(), tagged = newTags(event.data.before.data().text, c.text);
  if (tagged.length) await queueCardTalk(event, talkItem(event.params.cid, c, { tagged, tagsOnly: true, at: Date.now() }));
});

// Who hears of which comments on a card → { email: [items] }. people: whoever made it, its
// assignees and whoever has commented; tagEmails: { Slack id: email }. Pure.
function cardTalkRecipients(items, people, tagEmails){
  const out = {};
  const add = (email, it, tagged) => {
    email = String(email || '').toLowerCase();
    if (!email || email === it.by.email) return;
    const mine = out[email] = out[email] || [];
    const had = mine.filter((x) => x.id === it.id)[0];
    if (had) { if (tagged) had.taggedYou = true; return; }
    mine.push(Object.assign({}, it, tagged ? { taggedYou: true } : {}));
  };
  items.forEach((it) => {
    if (!it.tagsOnly) people.forEach((e) => add(e, it));
    (it.tagged || []).forEach((id) => add((tagEmails || {})[id], it, true));
  });
  return out;
}
// One person's message about a card's comments; each links to itself (&c=). Pure.
function cardTalkDigest(items, title, url){
  const n = items.length, untag = (t) => String(t || '').replace(TAG, '@$1');
  const line = (it) => { const t = untag(it.text); return '• <' + url + '&c=' + encodeURIComponent(it.id) + '|' + slackText(it.by.name || it.by.email).replace(/\|/g, '¦') + (it.taggedYou ? ' tagged you' : '') + '>: ' + slackText(t.length > 140 ? t.slice(0, 140) + '…' : t); };
  return '💬 ' + (n === 1 ? 'A new comment' : n + ' new comments') + ' on the card ' + linkedTitle(slackText(title), url) + '\n' +
    items.slice(0, 5).map(line).join('\n') + (n > 5 ? '\n…and ' + (n - 5) + ' more.' : '');
}
async function flushCardTalk(q){
  const card = db.collection('projectWorkspaces').doc(q.pid).collection('work').doc(q.card);
  const [cs, ws, all] = await Promise.all([card.get(), db.collection('projectWorkspaces').doc(q.pid).get(), card.collection('comments').get()]);
  if (!cs.exists) return;
  const c = cs.data(), w = ws.data() || {};
  const people = [c.by && c.by.email].concat(c.assigneeEmails || []).concat(all.docs.map((d) => d.data().by && d.data().by.email)).filter(Boolean).map((e) => String(e).toLowerCase());
  const byPerson = cardTalkRecipients(q.items, Array.from(new Set(people)), await emailsForSlackIds([].concat.apply([], q.items.map((it) => it.tagged || []))));
  const url = projectPageUrl(w.cardId || q.pid, w.boardId) + '&tab=work&card=' + encodeURIComponent(q.card);
  const title = (await numberTag(card.path)) + (c.title || 'a card');
  const token = SLACK_BOT_TOKEN.value();
  for (const email of Object.keys(byPerson)) await pilotSlack(token, 'card-comments', 'Comments on board cards', { emails: [email], text: cardTalkDigest(byPerson[email], title, url) });
}

// ---------- Deciding a suggested change to a guide or the BOLDiquette ----------
// A guide (guides/{slug}) or the BOLDiquette (handbook/{slug}) changes only by
// an accepted proposal, a PI's or admin's own included: clients can't change
// their content (firestore.rules), so a PI or admin who didn't propose the
// change accepts or declines it here.
// data: { collection: 'guides' | 'handbook', slug, id, accept: bool } → { status }.

const REVIEWED = ['guides', 'handbook', 'skills', 'agentTools'];

// Who can see what (functions/access.js): the BOLDiquette's table of who can view, edit
// and propose on each page, by group, saved in settings/access when a change to it is accepted.
const access = require('./access')({ db, groupOf, isFullWrite, viewingAs, viewingTable, HttpsError });

// An edit proposed on `before`, applied to part `p` as it is now: each field it sets merged
// with whatever changed since (functions/merge.js, the pages' too). Without `before` (older
// proposals), the proposal as it is. → the fields to set; throws if they can't be merged.
function mergedEdit(p, before, after){
  const r = merge.mergeEdit(p, before, after || {});
  if (r.conflict) throw new HttpsError('failed-precondition', '“' + (p.title || 'This part') + '” has changed in the same lines since this was proposed: whoever proposed it rebases it on main and resolves the conflicts, then it can be accepted.');
  return r.fields;
}

// The document with proposal q applied: pure, so it's testable on its own. → { title, description, parts } changed.
function appliedProposal(doc, q, ctx){
  // Several changes proposed together (a draft): each in turn, on the result of the last.
  if (q.kind === 'batch') {
    const changes = Array.isArray(q.changes) ? q.changes : [];
    if (!changes.length || changes.length > 50) throw new HttpsError('invalid-argument', 'No changes to apply.');
    let cur = Object.assign({}, doc);
    const out = {};
    changes.forEach((c) => {
      if (!c || c.kind === 'batch') throw new HttpsError('invalid-argument', 'Unknown kind of change.');
      const r = appliedProposal(cur, Object.assign({ by: q.by }, c), ctx);
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
  // One row of Who can see what (a page's eye chip), set in the table as it is now; without
  // the part yet, the part, from the table in force (ctx.pages, settings/access).
  if (q.kind === 'access') {
    const lv = q.after || {}, levels = accessLib.LEVELS;
    if (!accessLib.PAGES.some((p) => p[0] === q.area) || !['view', 'edit'].every((w) => levels.indexOf(lv[w]) >= 0)) {
      throw new HttpsError('invalid-argument', 'That isn’t a page and its groups.');
    }
    const row = { view: lv.view, edit: lv.edit };
    const p = parts.find((x) => x.id === accessLib.ACCESS_PART);
    if (p) p.body = accessLib.setAccessRow(p.body, q.area, row);
    else {
      const np = { id: accessLib.ACCESS_PART, title: 'Who can see what', section: 'People', body: accessLib.accessPartBody(ctx && ctx.pages, q.area, row) };
      let at = -1;
      parts.forEach((x, i) => { if (x.section === np.section) at = i; });
      if (at === -1) parts.push(np); else parts.splice(at + 1, 0, np);
    }
    return { parts };
  }
  const after = q.after || {};
  if (q.kind === 'about') return { title: String(after.title || ''), description: String(after.description || '') };
  if (q.kind === 'restore') return { title: String(after.title || ''), description: String(after.description || ''), parts: after.parts || [] };
  if (q.kind === 'add') {
    // Never the same part twice (two proposals adding one, the second accepted later).
    if (parts.some((p) => p.id === q.partId)) throw new HttpsError('failed-precondition', 'That part is there already: propose a change to it instead.');
    // At the end of its section, if it names one that's there; else at the end.
    // changedBy: whoever proposed its last accepted change (2026-11-05), told of comments and proposals on it.
    const part = Object.assign({ id: q.partId }, after, (q.by || {}).email ? { changedBy: String(q.by.email).toLowerCase() } : {});
    let at = -1;
    parts.forEach((p, i) => { if (part.section && p.section === part.section) at = i; });
    if (at === -1) parts.push(part); else parts.splice(at + 1, 0, part);
    return { parts };
  }
  if (q.kind === 'remove') return { parts: parts.filter((p) => p.id !== q.partId) };
  if (q.kind === 'edit') {
    const p = parts.find((x) => x.id === q.partId);
    if (!p) throw new HttpsError('failed-precondition', 'That part has since been removed.');
    // Merged with any change to the part since it was proposed, rather than overwriting it (#177).
    Object.assign(p, mergedEdit(p, q.before, after));
    if ((q.by || {}).email) p.changedBy = String(q.by.email).toLowerCase();
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

// Who can see what as an open BOLDiquette proposal (its path) would make it, if it changes
// it, else null: the proposal applied to the BOLDiquette as it is (appliedProposal), and
// the table read from it, as accepting it would save it (access.checkTableChange).
async function proposedTable(path){
  // A branch (branches/<id>): its part on the BOLDiquette, if it has one.
  const br = /^branches\/([A-Za-z0-9]{1,40})$/.exec(String(path || ''));
  if (br) path = 'handbook/boldiquette/proposals/' + br[1];
  const m = /^handbook\/boldiquette\/proposals\/([A-Za-z0-9]{1,40})$/.exec(String(path || ''));
  if (!m) return null;
  const [qs, ds, as] = await Promise.all([db.doc(path).get(), db.doc('handbook/boldiquette').get(), db.doc('settings/access').get()]);
  const q = qs.data();
  if (!q || q.status !== 'open' || !ds.exists) return null;
  const doc = ds.data(), now = (as.exists && as.data().pages) || accessLib.DEFAULT_PAGES;
  const fields = appliedProposal(doc, q, { pages: now });
  const partOf = (parts) => (parts || []).filter((p) => p && p.id === accessLib.ACCESS_PART)[0];
  const part = partOf(fields.parts || doc.parts), was = partOf(doc.parts);
  if (!part || (was && was.body === part.body)) return null;
  const pages = accessLib.parseAccessTable(part.body);
  // Compared as read from the text both ways, so a table written differently isn't a change.
  return was && JSON.stringify(accessLib.parseAccessTable(was.body)) === JSON.stringify(pages) ? null : pages;
}

// What accepting proposal q (on collection/slug, its document `snap`) writes, without writing it: [{ op: 'set' |
// 'update' | 'delete', ref, data }]; throws if it can't be accepted. Shared by decideProposal and decideBranch (a
// branch's pages, all in one transaction). ctx: { pages: the table in force (an 'access' row), email: who accepts,
// by: who proposed it, note, now, creating: a new skill or tool }.
async function acceptedOps(collection, slug, snap, q, ctx){
  const ref = db.collection(collection).doc(slug), ops = [];
  const stamp = { changeNote: String(ctx.note || '').slice(0, 300), updatedAt: ctx.now, updatedBy: ctx.email, proposedBy: ctx.by };
  if (q.kind === 'delete') {
    // Its history credits whoever accepted it, then it goes.
    return [{ op: 'update', ref, data: stamp }, { op: 'delete', ref }];
  }
  let fields = appliedProposal(snap.exists ? snap.data() : {}, q, { pages: ctx.pages });
  // A tool is checked as agents get it (name, inputs, code that compiles: functions/api-tools.js).
  if (collection === 'agentTools') {
    try { fields = agentApi.checkTool(slug, Object.assign({}, snap.exists ? snap.data() : {}, fields)); }
    catch (err) { throw new HttpsError('failed-precondition', 'It can’t be accepted as it is: ' + err.message); }
  }
  // The BOLDiquette's Who can see what: only a table the site can read, proposed by whoever
  // can propose on the BOLDiquette; the site then enforces it (settings/access).
  if (collection === 'handbook' && slug === 'boldiquette') {
    const before = snap.exists ? snap.data().parts : [];
    const table = await access.checkTableChange(before, fields.parts || before, ctx.by);
    if (table) ops.push({ op: 'set', ref: db.collection('settings').doc('access'), data: { pages: table, updatedAt: ctx.now, updatedBy: ctx.email, proposedBy: ctx.by } });
  }
  if (ctx.creating) ops.push({ op: 'set', ref, data: Object.assign(fields, { name: slug, createdAt: ctx.now, createdBy: ctx.by }, stamp) });
  else ops.push({ op: 'update', ref, data: Object.assign(fields, stamp) });
  return ops;
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
        // A row of Who can see what, without the part yet, starts from the table in force.
        const pages = q.kind === 'access' ? ((await tx.get(db.collection('settings').doc('access'))).data() || {}).pages : null;
        const ops = await acceptedOps(data.collection, data.slug, snap, q, { pages, email, by, note: String(q.note || ('Proposed by ' + who)), now, creating });
        ops.forEach((o) => { if (o.op === 'delete') tx.delete(o.ref); else tx[o.op](o.ref, o.data); });
      }
      const status = data.accept ? 'accepted' : 'declined';
      tx.update(qRef, { status, decidedBy: email, decidedByName: name, decidedAt: now });
      return { status };
    }).then((r) => { access.forget(); return r; });
  }
);

// ---------- Branches of the site (functions/branches.js) ----------
const branchLib = require('./branches');
const branchErr = (err) => { if (err instanceof branchLib.BranchError) throw new HttpsError(err.code, err.message); throw err; };
const branchProps = (b, id) => (b.pages || []).map((p) => db.doc(p + '/proposals/' + id));

// branchCommit { on?, title?, description?, target: { collection, slug }, change } → { id, num }: a commit on a page,
// on branch `on` (not `branch`: every call carries the one the page is on, onCall takes it off). Without it, it
// opens one (its title: `title`, else the commit's note) with this commit.
exports.branchCommit = onCall(async (request) => {
  const email = signedInEmail(request).toLowerCase(), data = request.data || {};
  const name = String(request.auth.token.name || '');
  const page = branchLib.pageKey(data.target && data.target.collection, data.target && data.target.slug);
  if (!page) throw new HttpsError('invalid-argument', 'That page can’t be changed on a branch.');
  await access.requireAccess(email, branchLib.areaOf(page, accessLib.guideArea), 'edit');
  let c;
  try { c = branchLib.validChange(page, data.change); } catch (err) { branchErr(err); }
  const docSnap = await db.doc(page).get();
  if (c.kind === 'new' ? docSnap.exists : !docSnap.exists) throw new HttpsError(c.kind === 'new' ? 'already-exists' : 'not-found', c.kind === 'new' ? 'It exists already: change it instead.' : 'That page isn’t there.');
  const id = String(data.on || '');
  if (id && !branchLib.ID.test(id)) throw new HttpsError('invalid-argument', 'No such branch.');
  const bref = id ? db.collection('branches').doc(id) : db.collection('branches').doc();
  const now = Date.now(), by = { email, name };
  await db.runTransaction(async (tx) => {
    const pref = db.doc(page + '/proposals/' + bref.id);
    const [bs, ps] = await Promise.all([id ? tx.get(bref) : Promise.resolve(null), tx.get(pref)]);
    if (id) {
      const b = bs.exists ? bs.data() : null;
      if (!b) throw new HttpsError('not-found', 'No such branch.');
      if (b.status !== 'open') throw new HttpsError('failed-precondition', 'That branch has been ' + b.status + ': go back to main to propose a change.');
      const pages = (b.pages || []).indexOf(page) >= 0 ? b.pages : (b.pages || []).concat([page]);
      if (pages.length > branchLib.MAX_PAGES) throw new HttpsError('failed-precondition', 'A branch changes ' + branchLib.MAX_PAGES + ' pages at most.');
      const contributors = (b.contributors || []).indexOf(email) >= 0 ? b.contributors : (b.contributors || []).concat([email]);
      tx.update(bref, { pages, contributors, editedAt: now });
    } else {
      const title = branchLib.text(data.title || c.note, branchLib.MAX_TITLE);
      tx.set(bref, { title, description: branchLib.text(data.description, branchLib.MAX_DESCRIPTION), status: 'open', by, at: now, contributors: [email], pages: [page], editedAt: now });
    }
    const prop = ps.exists ? ps.data() : null;
    if (prop && prop.status !== 'open') throw new HttpsError('failed-precondition', 'That branch has been decided.');
    let doc;
    try { doc = branchLib.withCommit(prop, page, bref.id, c, by, now); } catch (err) { branchErr(err); }
    tx.set(pref, doc);
  });
  // Its number (#12), as everything on BOLD.OS has one: kept on it too, for its page.
  let num = 0;
  if (!id) {
    num = await numberFor('branches/' + bref.id).catch(() => 0);
    if (num) await bref.update({ num }).catch(() => {});
  } else num = (await bref.get()).data().num || 0;
  return { id: bref.id, num };
});

// branchMeta { id, title?, description? } (whoever has committed to it, or a PI) or { id, withdraw: true } (its
// author, or a PI): its title and description, or withdrawn, its pages' proposals with it.
exports.branchMeta = onCall(async (request) => {
  const email = signedInEmail(request).toLowerCase(), data = request.data || {}, id = String(data.id || '');
  if (!branchLib.ID.test(id)) throw new HttpsError('invalid-argument', 'No such branch.');
  const full = await isFullWrite(email), bref = db.collection('branches').doc(id), now = Date.now();
  return db.runTransaction(async (tx) => {
    const bs = await tx.get(bref), b = bs.exists ? bs.data() : null;
    if (!b) throw new HttpsError('not-found', 'No such branch.');
    if (data.withdraw) {
      if (!branchLib.canWithdraw(b, email, full)) throw new HttpsError('permission-denied', b.status !== 'open' ? 'It has already been decided.' : 'Only whoever opened it, or a PI or admin, can withdraw it.');
      const props = await Promise.all(branchProps(b, id).map((r) => tx.get(r)));
      const closed = { status: 'withdrawn', decidedBy: email, decidedByName: String(request.auth.token.name || ''), decidedAt: now };
      props.forEach((p) => { if (p.exists && p.data().status === 'open') tx.update(p.ref, closed); });
      tx.update(bref, closed);
      return { status: 'withdrawn' };
    }
    if (b.status !== 'open') throw new HttpsError('failed-precondition', 'It has already been decided.');
    if (!full && (b.contributors || []).indexOf(email) < 0) throw new HttpsError('permission-denied', 'Only whoever has committed to it, or a PI or admin, can change this.');
    const up = { editedAt: b.editedAt || b.at || now, metaAt: now };
    if (typeof data.title === 'string') { up.title = branchLib.text(data.title, branchLib.MAX_TITLE); if (!up.title) throw new HttpsError('invalid-argument', 'Give it a title.'); }
    if (typeof data.description === 'string') up.description = branchLib.text(data.description, branchLib.MAX_DESCRIPTION);
    tx.update(bref, up);
    return { status: 'open' };
  });
});

// branchRebase { id, target, changes } (whoever has committed to it, or a PI): a page's part of a branch rebased on
// main (pages/guide.js replays its commits on the page as it is now, the conflicts resolved).
exports.branchRebase = onCall(async (request) => {
  const email = signedInEmail(request).toLowerCase(), data = request.data || {}, id = String(data.id || '');
  const page = branchLib.pageKey(data.target && data.target.collection, data.target && data.target.slug);
  if (!branchLib.ID.test(id) || !page) throw new HttpsError('invalid-argument', 'No such branch.');
  const full = await isFullWrite(email), bref = db.collection('branches').doc(id), pref = db.doc(page + '/proposals/' + id);
  await db.runTransaction(async (tx) => {
    const [bs, ps] = await Promise.all([tx.get(bref), tx.get(pref)]);
    const b = bs.exists ? bs.data() : null;
    if (!b || b.status !== 'open') throw new HttpsError('failed-precondition', 'It has been decided.');
    if (!full && (b.contributors || []).indexOf(email) < 0) throw new HttpsError('permission-denied', 'Only whoever has committed to it, or a PI or admin, can rebase it.');
    let doc;
    try { doc = branchLib.rebased(ps.exists ? ps.data() : null, page, data.changes, Date.now()); } catch (err) { branchErr(err); }
    tx.set(pref, doc);
    tx.update(bref, { editedAt: doc.editedAt });
  });
  return { ok: true };
});

// decideBranch { id, accept, editedAt } (a PI or admin who hasn't committed to it): every page it changes, as
// it proposes, in one go; if one can't be, none is.
exports.decideBranch = onCall(async (request) => {
  const email = signedInEmail(request).toLowerCase(), data = request.data || {}, id = String(data.id || '');
  if (!branchLib.ID.test(id)) throw new HttpsError('invalid-argument', 'No such branch.');
  const full = await isFullWrite(email), name = String(request.auth.token.name || ''), bref = db.collection('branches').doc(id);
  return db.runTransaction(async (tx) => {
    const bs = await tx.get(bref), b = bs.exists ? bs.data() : null;
    if (!b) throw new HttpsError('not-found', 'No such branch.');
    const why = branchLib.cannotDecide(b, email, full);
    if (why) throw new HttpsError(b.status !== 'open' ? 'failed-precondition' : 'permission-denied', why);
    if (typeof data.editedAt === 'number' && (b.editedAt || b.at || 0) !== data.editedAt) throw new HttpsError('failed-precondition', 'It has just changed. Have a look at it again.');
    const pages = b.pages || [];
    const [props, docs, acc] = await Promise.all([Promise.all(branchProps(b, id).map((r) => tx.get(r))), Promise.all(pages.map((p) => tx.get(db.doc(p)))), tx.get(db.collection('settings').doc('access'))]);
    const now = Date.now(), all = [];
    if (data.accept) {
      const by = String((b.by && b.by.email) || '').toLowerCase();
      for (let i = 0; i < pages.length; i++){
        const q = props[i].exists ? props[i].data() : null;
        if (!q || q.status !== 'open') continue;
        const [collection, slug] = pages[i].split('/'), creating = q.kind === 'new';
        if (creating ? docs[i].exists : !docs[i].exists) throw new HttpsError('failed-precondition', creating ? '“' + slug + '” exists already: this branch can’t make it.' : '“' + slug + '” has been deleted since.');
        try {
          (await acceptedOps(collection, slug, docs[i], q, { pages: (acc.data() || {}).pages, email, by, note: b.title, now, creating })).forEach((o) => all.push(o));
        } catch (err) {
          const page = (docs[i].exists && docs[i].data().title) || slug;
          throw new HttpsError(err.code || 'failed-precondition', page + ': ' + (err.message || 'it can’t be accepted.'));
        }
      }
    }
    all.forEach((o) => { if (o.op === 'delete') tx.delete(o.ref); else tx[o.op](o.ref, o.data); });
    const status = data.accept ? 'accepted' : 'declined', closed = { status, decidedBy: email, decidedByName: name, decidedAt: now };
    props.forEach((p) => { if (p.exists && p.data().status === 'open') tx.update(p.ref, closed); });
    tx.update(bref, closed);
    return { status };
  }).then((r) => { access.forget(); return r; });
});

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
      await sendEvent(token, { key: 'irb-author-cap', emails: [email], headline: headline });
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
      await sendEvent(token, e.comment ? Object.assign({ key: 'irb-board' }, e, { emails: e.emails.filter((x) => tagged.indexOf(String(x || '').toLowerCase()) === -1) }) : Object.assign({ key: 'irb-board' }, e));
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
          await dmByEmail(token, submitterEmail, headline, 'irb-reviews-out');
        }
      } catch (err){
        logger.error('notifyReviewsOut failed for one card', { boardId: boardId, cardId: card.id, error: String(err) });
      }
    }
  }
);

// ---------- BOLD OS in the public channels (2026-11-04) ----------
// So a thread anywhere public can be sent to Conversations (functions/slack-thread.js), BOLD OS joins
// every public channel: each new one as it's created (Slack's channel_created event, pilot
// channel-join: until it's live, its testers are told which it would join), and the ones there
// already, once (a runs/{id} document { action: 'join-public-channels', dryRun? }, server only: its
// `plan` lists them; dryRun joins none). Needs channels:join and channels:read, and the
// channel_created event subscription. Private channels can't be: Slack lets only a member invite it.
async function joinNewChannel(token, ch){
  if (!ch.id || ch.is_private) return;
  const st = await pilotState('channel-join');
  if (!st.live) { await toTesters(token, st, '#' + (ch.name || ch.id), 'BOLD OS would join #' + slackText(ch.name || ch.id) + ', a new public channel.'); return; }
  const r = await slackFetch(token, 'conversations.join', { channel: ch.id });
  if (!r.ok) logger.warn('Joining a new channel failed', { channel: ch.id, error: r.error });
}
// Pure: the public channels BOLD OS isn't in yet (conversations.list's channels), by name.
function channelsToJoin(channels){
  return (channels || []).filter((c) => c && c.id && !c.is_private && !c.is_archived && !c.is_member && !c.is_im && !c.is_mpim)
    .map((c) => ({ id: c.id, name: c.name || c.id })).sort((a, b) => a.name.localeCompare(b.name));
}
exports.onChannelJoinRun = onDocumentCreated({ document: 'runs/{id}', secrets: [SLACK_BOT_TOKEN] }, async (event) => {
  const run = event.data && event.data.data();
  if (!run || run.action !== 'join-public-channels' || run.doneAt) return;
  const token = SLACK_BOT_TOKEN.value(), all = [];
  let cursor = '', error = '';
  do {
    const r = await (await fetch('https://slack.com/api/conversations.list?' + new URLSearchParams(Object.assign({ types: 'public_channel', exclude_archived: 'true', limit: '200' }, cursor ? { cursor } : {})),
      { headers: { 'Authorization': 'Bearer ' + token } })).json();
    if (!r.ok) { error = r.error + (r.needed ? ' (needs ' + r.needed + ')' : ''); break; }
    all.push(...(r.channels || []));
    cursor = (r.response_metadata && r.response_metadata.next_cursor) || '';
  } while (cursor);
  const plan = channelsToJoin(all), joined = [], failed = [];
  if (!error && run.dryRun !== true) {
    for (const c of plan) {
      const r = await slackFetch(token, 'conversations.join', { channel: c.id });
      (r.ok ? joined : failed).push(r.ok ? c.name : c.name + ': ' + r.error);
    }
  }
  await event.data.ref.set({ doneAt: Date.now(), plan: plan.map((c) => c.name), joined, failed, error }, { merge: true });
});

// #174's preview (2026-11-05): who is in each group and project channel, as the bot sees them, so
// they can be checked against BOLD.OS before anything is removed. Read only: it changes nothing on
// Slack. On creating runs/{id} { action: 'channel-audit' } (admin access only), it writes
// { doneAt, channels: { <name>: { id, members: [Slack ids] } | { error } }, error }: every group's
// and role's channel (settings/groups), every project's (projectWorkspaces' slackChannel), and every
// other proj-… channel the bot can see.
exports.onChannelAuditRun = onDocumentCreated({ document: 'runs/{id}', secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 300 }, async (event) => {
  const run = event.data && event.data.data();
  if (!run || run.action !== 'channel-audit' || run.doneAt) return;
  const token = SLACK_BOT_TOKEN.value(), names = new Set();
  const add = (v) => groupChannelNames(v).forEach((n) => names.add(n));
  const set = (await db.collection('settings').doc('groups').get()).data() || {};
  Object.values(set.channels || {}).forEach(add); Object.values(set.roleChannels || {}).forEach(add);
  (await db.collection('projectWorkspaces').get()).docs.forEach((d) => add(d.data().slackChannel));
  let error = '';
  try { await slackChannelId(token, '-'); } catch (err) { error = String(err.message || err); }
  if (channelNamesCache) Array.from(channelNamesCache.names.keys()).filter((n) => /^proj-/.test(n)).forEach((n) => names.add(n));
  const channels = {};
  for (const name of Array.from(names).sort()) {
    const id = error ? null : await slackChannelId(token, name).catch(() => null);
    if (!id) { channels[name] = { error: 'the bot can’t see it' }; continue; }
    const members = [];
    let cursor = '', bad = '';
    do {
      const r = await (await fetch('https://slack.com/api/conversations.members?' + new URLSearchParams(Object.assign({ channel: id, limit: '1000' }, cursor ? { cursor } : {})),
        { headers: { 'Authorization': 'Bearer ' + token } })).json();
      if (!r.ok) { bad = r.error + (r.needed ? ' (needs ' + r.needed + ')' : ''); break; }
      members.push(...(r.members || []));
      cursor = (r.response_metadata && r.response_metadata.next_cursor) || '';
    } while (cursor);
    channels[name] = bad ? { id, error: bad } : { id, members };
  }
  await event.data.ref.set({ doneAt: Date.now(), channels, error }, { merge: true });
});

// ---------- #174: Slack channels follow BOLD.OS (2026-11-06) ----------
// Each group's and role's channel (settings/groups) is for that group and the groups above it
// (groupChannelsFor), each project's (its workspace's slackChannel) for the people on it (its
// workspace's members); PIs and admins stay in every one, as do bots. Everyone else is removed,
// and told once, by BOLD OS, where from, why and how to get back in (pilot `channel-alignment`:
// the run refuses to remove anyone while it isn't live, so nobody is removed untold).
// PIs and admins preview it, schedule it (one run at a time) and cancel it on Settings › Slack
// (channelAlignment); runAlignments carries out the one that's due, working it out again then.
const ALIGN_KEY = 'channel-alignment';

// Pure. in: { channels: { <name>: [Slack ids] }, people: { <Slack id>: { email, name } },
// members: { <email>: members record }, full: [emails], groups: settings/groups,
// projects: [{ channel, pid, title, url, people: [emails] }], bots: [Slack ids], exclude: [names] }
// → [{ slackId, name, email, channels: [{ name, why: 'no-record' | 'group' | 'project' | 'outside', group?, title?, url? }] }].
function alignmentPlan(x){
  const groupCh = allGroupChannels(x.groups || {}), byCh = {}, bots = new Set(x.bots || []), full = new Set((x.full || []).map((e) => String(e).toLowerCase()));
  (x.projects || []).forEach(function(p){ const n = String(p.channel || '').replace(/^#/, '').toLowerCase(); if (n) byCh[n] = p; });
  const out = {};
  Object.keys(x.channels || {}).sort().forEach(function(name){
    if ((x.exclude || []).indexOf(name) >= 0) return;
    const proj = byCh[name], isGroup = !!groupCh[name];
    if (!proj && !isGroup) return;
    (x.channels[name] || []).forEach(function(id){
      if (bots.has(id)) return;
      const p = (x.people || {})[id], email = p ? String(p.email || '').toLowerCase() : '';
      if (email && full.has(email)) return;
      const m = email ? (x.members || {})[email] || null : null;
      let why = '';
      if (!p) why = 'outside';
      else if (proj) { if ((proj.people || []).map((e) => String(e).toLowerCase()).indexOf(email) < 0) why = 'project'; }
      else if (groupChannelsFor(m || {}, x.groups || {}).indexOf(name) < 0) why = m ? 'group' : 'no-record';
      if (!why) return;
      const o = out[id] = out[id] || { slackId: id, name: (p && p.name) || (x.outside || {})[id] || '', email, channels: [] };
      o.channels.push(Object.assign({ name, why }, why === 'group' ? { group: GROUP_LABELS[groupOf(m)] } : {}, proj ? { title: proj.title, url: proj.url } : { for: groupCh[name].join(', ') }));
    });
  });
  return Object.values(out).sort(function(a, b){ return a.name.localeCompare(b.name); });
}
// Pure: what BOLD OS tells someone removed from `channels` (as in alignmentPlan), in Slack's mrkdwn.
function alignmentMessage(name, channels){
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const line = function(c){
    if (c.why === 'project') return '• #' + c.name + ': it’s for the people on <' + c.url + '|' + slackText(c.title || 'its project') + '> on BOLD.OS';
    if (c.why === 'group') return '• #' + c.name + ': it’s for ' + c.for + ' and above; you’re ' + c.group + ' on BOLD.OS';
    if (c.why === 'no-record') return '• #' + c.name + ': it’s for ' + c.for + ' and above, and you haven’t joined BOLD.OS yet';
    return '• #' + c.name + ': your account isn’t on BOLD’s Slack roster';
  };
  const has = (w) => channels.some((c) => c.why === w);
  const back = [];
  if (has('no-record') || has('outside')) back.push('• Join BOLD.OS: sign in with your BOLD Slack account at <' + SITE_URL + '|BOLD.OS> and fill in your profile. Your group’s channels follow.');
  if (has('group')) back.push('• In the wrong group? Ask for another on <' + SITE_URL + 'group-request.html|BOLD.OS>.');
  channels.filter((c) => c.why === 'project').forEach(function(c){ back.push('• Working on <' + c.url + '|' + slackText(c.title || 'the project') + '>? Ask to join it on its page on BOLD.OS; once you’re on it, you’re invited back to #' + c.name + '.'); });
  return 'Hi ' + first + ', BOLD’s Slack channels now follow BOLD.OS, the lab’s site, so you’ve been removed from:\n' + channels.map(line).join('\n') +
    '\n\nTo get back in:\n' + back.join('\n') + '\n\nYou’re still on BOLD’s Slack, in every other channel. Questions? Ask a PI or admin.';
}

// What alignmentPlan needs, from Firestore and Slack (as the bot sees each channel). → { input, unseen: [channel names] }.
async function alignmentInput(token, exclude){
  const [peopleSnap, membersSnap, groupsSnap, wsSnap, pis, admins] = await Promise.all([db.collection('people').get(), db.collection('members').get(),
    db.collection('settings').doc('groups').get(), db.collection('projectWorkspaces').get(), rolesEmails('pis'), rolesEmails('admins')]);
  const people = {}, members = {};
  peopleSnap.docs.forEach((d) => { const p = d.data(); people[d.id] = { email: String(p.email || '').toLowerCase(), name: p.name || '' }; });
  membersSnap.docs.forEach((d) => { members[d.id.toLowerCase()] = d.data(); });
  const groups = groupsSnap.data() || {};
  const projects = wsSnap.docs.map((d) => { const w = d.data(); return { channel: w.slackChannel || '', pid: d.id, title: w.title || '', url: projectPageUrl(w.cardId || d.id, w.boardId || null), people: w.members || [] }; }).filter((p) => p.channel);
  const names = new Set(Object.keys(allGroupChannels(groups)));
  projects.forEach((p) => names.add(String(p.channel).replace(/^#/, '').toLowerCase()));
  const channels = {}, unseen = [];
  for (const name of Array.from(names).sort()){
    if ((exclude || []).indexOf(name) >= 0) continue;
    const id = await slackChannelId(token, name).catch(() => null);
    const ids = id ? await groupChannelMemberIds(token, id) : null;
    if (!ids) { unseen.push(name); continue; }
    channels[name] = ids;
  }
  // Bots and apps (and deleted accounts): anyone not on the roster is looked up once.
  const bots = [], seen = new Set(), outside = {};
  const auth = await slackFetch(token, 'auth.test', {});
  if (auth.ok && auth.user_id) bots.push(auth.user_id);
  for (const ids of Object.values(channels)) for (const id of ids){
    if (people[id] || seen.has(id)) continue;
    seen.add(id);
    const u = await (await fetch('https://slack.com/api/users.info?' + new URLSearchParams({ user: id }), { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => null);
    // A bot, an app or a deleted account stays out of it; anyone else not on the roster (an account
    // from another workspace) is 'outside', named from Slack.
    if (!u || !u.ok || (u.user && (u.user.is_bot || u.user.deleted || u.user.id === 'USLACKBOT'))) bots.push(id);
    else outside[id] = (u.user.profile && (u.user.profile.real_name || u.user.profile.display_name)) || u.user.name || '';
  }
  return { input: { channels, people, members, full: pis.concat(admins), groups, projects, bots, outside, exclude: exclude || [] }, unseen };
}
// A channel's members' Slack ids (the bot must be in it), or null when it can't read them.
async function groupChannelMemberIds(token, channelId){
  const ids = [];
  let cursor = '';
  do {
    const q = new URLSearchParams(Object.assign({ channel: channelId, limit: '1000' }, cursor ? { cursor } : {}));
    const json = await (await fetch('https://slack.com/api/conversations.members?' + q, { headers: { Authorization: 'Bearer ' + token } })).json();
    if (!json.ok) { logger.warn('Reading a channel’s members failed', { error: json.error }); return null; }
    (json.members || []).forEach(function(id){ ids.push(id); });
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);
  return ids;
}
// The plan for now: alignmentInput, then alignmentPlan, each person with the message they'd get.
async function alignmentNow(token, exclude){
  const got = await alignmentInput(token, exclude);
  const plan = alignmentPlan(got.input).map((p) => Object.assign(p, { message: alignmentMessage(p.name, p.channels) }));
  return { plan, unseen: got.unseen, channels: Object.keys(got.input.channels).length };
}
// A Slack call that waits and tries again while Slack says to slow down (ratelimited), up to a minute.
async function slackPatient(token, method, body){
  let r;
  for (let i = 0; i < 12; i++){
    r = await slackFetch(token, method, body);
    if (r.ok || r.error !== 'ratelimited') return r;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  return r;
}
// Carries it out, in batches (about 6 minutes each, then the next tick of runAlignments goes on): the
// plan is worked out once, when it starts (`plan`), then each person in it removed from their channels
// and told of those it removed (`results`, one per person, in the plan's order).
async function runAlignment(ref, run){
  const token = SLACK_BOT_TOKEN.value(), started = Date.now();
  const st = await pilotState(ALIGN_KEY);
  if (!st.live) { await ref.set({ doneAt: Date.now(), error: '“' + st.label + '” isn’t live on Settings › Features, so nobody was removed.' }, { merge: true }); return; }
  let plan = run.plan, unseen = run.unseen || [];
  if (!plan){
    const now = await alignmentNow(token, run.exclude || []);
    plan = now.plan.map((p) => ({ slackId: p.slackId, name: p.name, email: p.email, channels: p.channels }));
    unseen = now.unseen;
    await ref.set({ plan, unseen, results: [] }, { merge: true });
  }
  const results = (run.results || []).slice();
  for (let k = results.length; k < plan.length; k++){
    if (Date.now() - started > 360000) { await ref.set({ results, leaseUntil: 0 }, { merge: true }); return; }   // the next tick goes on
    const p = plan[k], removed = [], failed = [];
    for (const c of p.channels){
      const id = await slackChannelId(token, c.name).catch(() => null);
      const r = id ? await slackPatient(token, 'conversations.kick', { channel: id, user: p.slackId }) : { ok: false, error: 'channel_not_found' };
      if (r.ok || r.error === 'not_in_channel') removed.push(c); else failed.push({ name: c.name, error: r.error || 'unknown' });
    }
    let told = false;
    if (removed.length){
      const open = await slackPatient(token, 'conversations.open', { users: p.slackId });
      const sent = open.ok ? await slackPatient(token, 'chat.postMessage', { channel: open.channel.id, text: alignmentMessage(p.name, removed), unfurl_links: false }) : open;
      told = !!sent.ok;
      if (p.email) await noteFor([p.email], { text: 'BOLD’s Slack channels now follow BOLD.OS: you were removed from ' + removed.map((c) => '#' + c.name).join(', ') + '.', feature: ALIGN_KEY, source: 'slack' }).catch(() => {});
    }
    results.push({ slackId: p.slackId, name: p.name, removed: removed.map((c) => c.name), failed, told });
    if (results.length % 10 === 0) await ref.set({ results }, { merge: true });
  }
  await ref.set({ results, doneAt: Date.now(), leaseUntil: 0,
    removed: results.reduce((n, r) => n + r.removed.length, 0), people: results.filter((r) => r.removed.length).length }, { merge: true });
}

// Settings › Slack: { action: 'preview' } → { plan, unseen, channels, live, runs }; 'schedule' { at (ms), exclude? }
// → { id }; 'cancel' { id }; 'status' → { live, runs: [the last few, newest first] }. PIs and admins.
exports.channelAlignment = onCall({ secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 300 }, async (request) => {
  const email = signedInEmail(request);
  if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins align the channels.');
  const d = request.data || {}, col = db.collection('runs');
  const runs = async () => (await col.where('action', '==', ALIGN_KEY).get()).docs.map((x) => Object.assign({ id: x.id }, x.data()))
    .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5)
    .map((r) => ({ id: r.id, scheduledFor: r.scheduledFor || 0, by: r.byName || r.by || '', at: r.at || 0, cancelledAt: r.cancelledAt || 0, startedAt: r.startedAt || 0, doneAt: r.doneAt || 0,
      error: r.error || '', removed: r.removed || 0, people: r.people || 0, planned: (r.plan || []).length, done: (r.results || []).length, failed: (r.results || []).filter((x) => x.failed && x.failed.length).length, untold: (r.results || []).filter((x) => x.removed && x.removed.length && !x.told).length }));
  const live = (await pilotState(ALIGN_KEY)).live;
  if (d.action === 'status') return { live, runs: await runs() };
  if (d.action === 'preview'){
    const now = await alignmentNow(SLACK_BOT_TOKEN.value(), Array.isArray(d.exclude) ? d.exclude.map(String) : []);
    return Object.assign(now, { live, runs: await runs() });
  }
  if (d.action === 'schedule'){
    const at = Number(d.at);
    if (!(at > Date.now() - 60000) || at > Date.now() + 30 * 86400000) throw new HttpsError('invalid-argument', 'Pick a time in the next 30 days.');
    const pending = (await runs()).filter((r) => !r.cancelledAt && !r.doneAt);
    if (pending.length) throw new HttpsError('failed-precondition', 'One is scheduled already: cancel it first.');
    const ref = await col.add({ action: ALIGN_KEY, scheduledFor: at, exclude: Array.isArray(d.exclude) ? d.exclude.map(String).slice(0, 100) : [], by: email, byName: await nameForEmail(email), at: Date.now() });
    return { id: ref.id };
  }
  if (d.action === 'cancel'){
    const ref = col.doc(String(d.id || ''));
    const ok = await db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists || r.data().action !== ALIGN_KEY || r.data().startedAt || r.data().cancelledAt) return false;
      tx.update(ref, { cancelledAt: Date.now(), cancelledBy: email });
      return true;
    });
    if (!ok) throw new HttpsError('failed-precondition', 'It has started already, or isn’t scheduled.');
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Unknown action.');
});
// Every 5 minutes: the scheduled run that's due, claimed once (startedAt), carried out.
// A run is held by one tick at a time (leaseUntil); one cut short is taken up by a later tick.
exports.runAlignments = onSchedule({ schedule: 'every 5 minutes', secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 540 }, async function(){
  const due = (await db.collection('runs').where('action', '==', ALIGN_KEY).get()).docs
    .filter((x) => { const r = x.data(); return !r.cancelledAt && !r.doneAt && (r.scheduledFor || 0) <= Date.now() && (r.leaseUntil || 0) < Date.now(); });
  for (const x of due){
    const claimed = await db.runTransaction(async (tx) => {
      const r = await tx.get(x.ref), d = r.data();
      if (d.doneAt || d.cancelledAt || (d.leaseUntil || 0) >= Date.now()) return null;
      tx.update(x.ref, Object.assign({ leaseUntil: Date.now() + 520000 }, d.startedAt ? {} : { startedAt: Date.now() }));
      return d;
    });
    if (!claimed) continue;
    try { await runAlignment(x.ref, claimed); }
    catch (err){ logger.error('Aligning the channels failed', { error: String(err && err.message || err) }); await x.ref.set({ doneAt: Date.now(), error: String(err && err.message || err) }, { merge: true }); }
  }
});

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

    // A slash command (/bug, /feature-request): form-encoded, with `command`. Answered at
    // once (Slack waits 3 seconds): it opens the card's form, or says why not, to them alone.
    if (req.body && typeof req.body.command === 'string'){
      let out = null;
      try { out = await handleSlashCommand(token, req.body); }
      catch (err){ logger.error('slackEvents: slash command failed', { command: req.body.command, error: String(err && err.message || err) }); out = { response_type: 'ephemeral', text: 'That didn’t work — try again.' }; }
      // The form opened: an empty reply (anything else, even {}, shows as a message).
      if (out && out.text) res.status(200).json(out); else res.status(200).send('');
      return;
    }

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
      // A form's answer to Slack (/meeting's: what to fix, shown on the form) goes back as the reply.
      let answer = null;
      try {
        answer = await handleInteractivity(token, payload);
      } catch (err){
        logger.error('handleInteractivity threw', { error: String(err) });
      }
      if (answer && answer.response_action) res.status(200).json(answer); else res.status(200).send('');
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
    // A new public channel: BOLD OS joins it (pilot channel-join), so its threads can be sent to
    // Conversations. Private channels can't be joined this way: someone /invites it.
    if (body.type === 'event_callback' && body.event && body.event.type === 'channel_created'){
      try { await joinNewChannel(token, body.event.channel || {}); }
      catch (err){ logger.error('joinNewChannel threw', { error: String(err) }); }
      res.status(200).send('');
      return;
    }
    // A reply in Slack to a thread moved to Conversations: a note to whoever wrote it to reply there
    // (slack-thread.js nudgeMoved, pilot conversation-moved). Needs the message.channels and
    // message.groups event subscriptions. Every other message: nothing.
    if (body.type === 'event_callback' && body.event && body.event.type === 'message'){
      try { await conversationsSlack.nudgeMoved(token, body.event); }
      catch (err){ logger.error('nudgeMoved threw', { channel: body.event.channel, error: String(err) }); }
      res.status(200).send('');
      return;
    }
    // Someone joins or leaves a private channel: the conversations brought in from it follow its
    // members (slack-thread.js syncReaders). Needs the member_joined_channel and member_left_channel
    // event subscriptions; sending a thread again refreshes them too.
    if (body.type === 'event_callback' && body.event && (body.event.type === 'member_joined_channel' || body.event.type === 'member_left_channel')){
      if (body.event.channel_type !== 'C') {
        try { await conversationsSlack.syncReaders(token, body.event.channel); }
        catch (err){ logger.error('syncReaders threw', { channel: body.event.channel, error: String(err) }); }
      }
      res.status(200).send('');
      return;
    }
    // Someone joins the Slack, or changes their name or email, or is deactivated: just
    // their entry in the people roster (the daily syncPeople catches anything missed).
    if (body.type === 'event_callback' && body.event && (body.event.type === 'team_join' || body.event.type === 'user_change')){
      try {
        await upsertPerson(body.event.user, body.team_id);
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
// people/{slackId}: written if they have an email, removed once deactivated. Someone from
// another workspace (in a channel shared with it: their team_id isn't ours) isn't one of
// the lab's people, and their id can't be invited to our channels (user_not_found).
// Someone whose BOLD.OS account has another email than their Slack profile (signed up with one,
// Slack on another; 2026-11-05) is on the roster under their account's: everything finds people by
// it (links to their page, notifications, DMs). Their Slack one is kept as slackEmail.
// Pure: Firebase Auth users → { slackId: account email } for the accounts signed in with Slack.
function accountEmailsBySlackId(users){
  const out = {};
  (users || []).forEach(function(u){
    const s = (u.providerData || []).filter(function(p){ return p.providerId === 'oidc.slack'; })[0];
    if (s && s.uid && u.email) out[s.uid] = String(u.email).toLowerCase();
  });
  return out;
}
// Pure: a roster entry with its account's email (and its Slack one, if they differ).
function withAccountEmail(p, account){
  if (!account || account === p.email) return Object.assign({}, p, { slackEmail: FieldValue.delete() });
  return Object.assign({}, p, { email: account, slackEmail: p.email });
}
async function allAccountEmails(){
  const out = {};
  let page;
  do {
    page = await admin.auth().listUsers(1000, page && page.pageToken);
    Object.assign(out, accountEmailsBySlackId(page.users));
  } while (page.pageToken);
  return out;
}
async function accountEmailFor(slackId){
  try {
    const r = await admin.auth().getUsers([{ providerId: 'oidc.slack', providerUid: slackId }]);
    return accountEmailsBySlackId(r.users)[slackId] || '';
  } catch (err){ logger.warn('Looking up an account by Slack id failed', { error: String(err && err.message || err) }); return ''; }
}

async function upsertPerson(u, teamId){
  if (!u || !u.id || u.is_bot || u.id === 'USLACKBOT') return;
  const ref = db.collection('people').doc(u.id);
  if (u.deleted || (teamId && u.team_id && u.team_id !== teamId) || slackExternal(u, teamId)) { if ((await ref.get()).exists) { await ref.delete(); logger.info('upsertPerson: removed', { slackId: u.id }); } return; }
  if (!u.profile || !u.profile.email) { logger.warn('upsertPerson: no email (users:read.email?)', { slackId: u.id }); return; }
  // Emails lower case, as everywhere else on BOLD.OS (Slack keeps whatever case was typed).
  const p = withAccountEmail({ slackId: u.id, email: String(u.profile.email).toLowerCase(), name: u.profile.real_name || u.real_name || u.name || u.profile.email }, await accountEmailFor(u.id));
  const was = (await ref.get()).data();
  if (was && was.name === p.name && was.email === p.email && (was.slackEmail || '') === (typeof p.slackEmail === 'string' ? p.slackEmail : '')) return;
  await ref.set(p, { merge: true });
  logger.info('upsertPerson: ' + (was ? 'updated' : 'added'), { slackId: u.id });
  // New on the BOLD Slack: PAN-BOLD's channels (Settings › Slack channels), before any record of theirs.
  if (!was) await invitePanChannels(p.email).catch((err) => logger.warn('Adding someone to PAN-BOLD\u2019s channels failed', { error: String(err && err.message || err) }));
}
async function invitePanChannels(email){
  const set = (await db.collection('settings').doc('groups').get()).data() || {};
  for (const name of groupChannelNames((set.channels || {}).pan)) await inviteToGroupChannel(SLACK_BOT_TOKEN.value(), [email], name);
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
    const [fullWrite, group, pages] = await Promise.all([isFullWrite(email.toLowerCase()), access.groupFor(email), access.table()]);
    // Their group and Who can see what, for the pages to show what's theirs (BOLD.can);
    // viewAs: the group a PI or admin is viewing the site as (View as), so the page says so.
    const as = viewingAs(email);
    return Object.assign({ fullWrite, group, pages }, as ? { viewAs: as } : {});
  }
);

// Short-lived portrait URLs are returned only to authorized callers. The
// writer is resolved from Slack sign-in, never from a client-supplied ID.
exports.profilePhoto = onCall(
  { secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 30, memory: '512MiB' },
  async request => {
    const email = signedInEmail(request).toLowerCase();
    const data = request.data || {};
    try {
      if (data.action === 'batch') {
        await access.requireAccess(email, 'people', 'view');
        return photoService.batch(data.slackIds);
      }
      await access.requireAccess(email, 'profile', data.action === 'mine' ? 'view' : 'edit');
      const id = await photoService.owner(email);
      if (data.action === 'mine') return { slackId: id, photo: await photoService.read(id) };
      if (data.action === 'slack') return { slackId: id, result: await photoService.importSlack(id) };
      if (data.action === 'replace') return { slackId: id, result: await photoService.replace(id, data.image) };
      if (data.action === 'remove') return { slackId: id, result: await photoService.remove(id) };
      throw new HttpsError('invalid-argument', 'Unknown photo action.');
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      // What the member can act on keeps its message; anything else (IAM, Storage,
      // Firestore) is logged here and reported as internal, its details kept back.
      if (err && err.photoCode) throw new HttpsError(err.photoCode, err.message);
      logger.error('profilePhoto failed', { action: data.action, error: String(err && err.stack || err) });
      throw new HttpsError('internal', 'Could not update the photo. Try again.');
    }
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
    // Its Internal Review stage only while it's in submission (on a venue's board, no outcome yet; 2026-11-05).
    const inSubmission = !!i.boardId && projectGroupForCard(i.card || {}, false, true, false) === 'submission';
    const out = { boardId: i.boardId, boardLabel: i.boardLabel, cardId: i.cardId, title: i.title, badges: inSubmission ? badgesForCard(i.card) : [] };
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
    // No venue yet: not in submission, so no Internal Review stage.
    const loose = (d) => ({ boardId: null, boardLabel: 'No venue yet', cardId: d.id, title: d.data().title || 'Untitled', badges: [] });
    out.owner = out.owner.concat(ownSnap.docs.map(loose));
    out.author = out.author.concat(authSnap.docs.map(loose));
    const listed = new Set(out.owner.concat(out.author).map((i) => i.cardId));
    const GROUP = { proposed: 'Proposed', planned: 'Approved', ongoing: 'Ongoing', submission: 'In submission', completed: 'Completed' };
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
// Ongoing = being worked on: marked so on its project page (which needs its setup first), or with its whole setup
// (a meeting, slides and notes: workspaceStarted, 2026-11-04)
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
      badges: badgesForCard(d),
      proposal: d.proposal ? { status: d.proposal.status || 'proposed', gpuHours: Number(d.proposal.gpuHours) || 0 } : null
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
  const out = { proposed: [], ongoing: [], submission: [], completed: [], planned: [] };
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

// Pure: the groups as someone with Projects' Edit but not View sees them: the projects
// they're on (`mine`: pid → true) in full, every other one as its title, to join.
function projectTitlesOnly(groups, mine, ask){
  const out = {};
  Object.keys(groups).forEach(function(g){
    out[g] = groups[g].map(function(i){
      return mine[i.pid] ? i : Object.assign({ pid: i.pid, title: i.title, projectId: i.projectId, cardId: i.cardId, boardId: i.boardId, slackChannel: i.slackChannel, titleOnly: true }, ask ? { ask: true } : {});
    });
  });
  return out;
}

// Pure: marks the projects the caller is on (`mine`: their workspaces' ids, from `members`)
// `joined`, for the Projects page's join button and its Yours filter; `v` 2 marks a list that
// has them, so the page refetches an older cached one (tests/projects-join.test.cjs).
function markJoined(shown, mine){
  ['proposed', 'ongoing', 'submission', 'completed', 'planned'].forEach(function(g){
    (shown[g] || []).forEach(function(i){ if (mine[i.pid]) i.joined = true; });
  });
  shown.v = 3;   // 3: with `proposed` (#226)
  return shown;
}

// Whether `email` joins a project straight away (BOLDiquette › Who can do what, 2026-11-04):
// BOLD-internal and above, with Projects' Edit. BOLD-associate asks to join; PAN-BOLD talks to its lead.
async function joinsStraightAway(email){
  return (await access.can(email, 'projects', 'edit')) && accessLib.rank(await access.groupFor(email)) >= accessLib.rank('internal');
}

// Who sees a project in full (BOLDiquette › Who can see what › Projects): whoever has its
// View, and its people (its workspace's `members`) whatever their group. Edit without View
// sees the titles and joins (getAllProjects, projectTitles); firestore.rules hold to the same.
async function seesProject(email, pid){
  if (await access.can(email, 'projects', 'view')) return true;
  const ws = (await db.collection('projectWorkspaces').doc(pid).get()).data();
  return !!ws && (ws.members || []).indexOf(String(email).toLowerCase()) >= 0;
}
async function requireSeesProject(email, pid){
  if (!(await seesProject(email, pid))) throw new HttpsError('permission-denied', 'Only its people see this project: join it from Projects.');
}

exports.getAllProjects = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request).toLowerCase();
    const full = await access.can(email, 'projects', 'view');
    // Who can do what: View sees them all in full (everyone signed in, once the table is Page | Edit,
    // 2026-11-04); below it, the titles. Joining: BOLD-internal and above straight away; BOLD-associate
    // asks, and its lead accepts; PAN-BOLD talks to its lead, who adds them.
    const group = await access.groupFor(email);
    const joins = await joinsStraightAway(email);
    const askOnly = !joins;
    const [boardsSnap, cardsSnap, unassignedSnap, wsSnap, mineAsked] = await Promise.all([
      db.collection('boards').get(),
      db.collectionGroup('cards').get(),
      db.collection('projects').get(),
      db.collection('projectWorkspaces').get(),
      db.collection('projectInvites').where('email', '==', email).get()
    ]);
    const groups = allProjectsFromCards(
      boardsSnap.docs.map(function(d){ return { id: d.id, label: d.data().label, status: d.data().status || 'approved' }; }),
      cardsSnap.docs.map(function(d){ return { boardId: d.ref.parent.parent.id, id: d.id, data: d.data() }; }),
      unassignedSnap.docs.map(function(d){ return { id: d.id, data: d.data() }; }),
      wsSnap.docs.filter(function(d){ return d.data().completedAt > 0; }).map(function(d){ return d.id; }),
      wsSnap.docs.filter(function(d){ return workspaceStarted(d.data()); }).map(function(d){ return d.id; })
    );
    const mine = {}, health = {};
    wsSnap.docs.forEach(function(d){ if ((d.data().members || []).indexOf(email) >= 0) mine[d.id] = true; health[d.id] = projectHealth(d.data()); });
    const shown = full ? groups : projectTitlesOnly(groups, mine, askOnly);
    const items = shown.ongoing.concat(shown.submission, shown.completed, shown.planned);
    markJoined(shown, mine);
    // Its health, for whoever sees the project in full (not a title only).
    items.forEach(function(i){ if (!i.titleOnly && health[i.pid]) i.health = health[i.pid]; });
    // Their own asks and invitations, on each title: asked (waiting on its lead) or invited (theirs to answer).
    const pending = {};
    mineAsked.docs.forEach(function(d){ const v = d.data(); if (v.status === 'asked') pending[v.pid] = { asked: true }; else if (v.status === 'open') pending[v.pid] = { invited: d.id }; });
    // Seen in full but not joined straight away (BOLD-associate): Ask to join, which its lead accepts.
    if (!joins && group !== 'pan') items.forEach(function(i){ if (!i.joined && !i.titleOnly) i.ask = true; });
    items.forEach(function(i){ if (pending[i.pid] && !i.joined) Object.assign(i, pending[i.pid]); });
    if (askOnly) shown.askOnly = true;
    // PAN-BOLD: "Talk to the lead" (a Slack DM, from a template) instead of asking to join (2026-11-03).
    if (!joins && group === 'pan') {
      const owner = {};
      groups.ongoing.concat(groups.submission, groups.completed, groups.planned).forEach(function(i){ owner[i.pid] = { name: i.owner || '', email: i.ownerEmail || '' }; });
      const ids = {};
      for (const e of Array.from(new Set(Object.values(owner).map(function(o){ return o.email; }).filter(Boolean)))) ids[e] = await slackIdForEmail(e);
      items.forEach(function(i){
        if (i.joined) return;
        delete i.ask; delete i.asked;
        const o = owner[i.pid] || {};
        i.talk = { name: o.name || 'the lead', slackId: ids[o.email] || '' };
      });
    }
    const links = await slackLinksFor(Array.from(new Set(items.map(function(i){ return i.slackChannel; }).filter(Boolean))));
    items.forEach(function(i){ if (links[i.slackChannel]) i.slackUrl = links[i.slackChannel]; });
    return shown;
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
    await access.requireAccess(email, 'projects', 'list');   // Who can see what
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
  return Object.assign(new HttpsError('failed-precondition', code === 'missing_scope'
    ? 'The Slack app can\u2019t manage channels yet \u2014 ask an admin to add its channel permissions.'
    : 'Slack said no (' + code + ').'), { slackCode: code });
}
// Pure: why Slack wouldn't add one person to a channel, in words (Slack's code in brackets),
// or '' when it isn't about them.
function slackPersonProblem(code){
  const why = { user_not_found: 'Slack doesn\u2019t know their account here (it may be one from another workspace)',
    user_disabled: 'their Slack account is deactivated', user_is_inactive: 'their Slack account is deactivated',
    user_is_restricted: 'they\u2019re a guest on Slack, and the app can\u2019t add guests to channels',
    user_is_ultra_restricted: 'they\u2019re a single-channel guest on Slack', ura_max_channels: 'they\u2019re a single-channel guest on Slack, already in their one channel',
    cant_invite: 'Slack won\u2019t let the app add them' }[code];
  return why ? why + ' (' + code + ')' : '';
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
    await access.requireAccess(email, 'projects', 'list');   // Who can see what
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

    return Object.assign(out, await makeProjectChannel(token, n.name, email));
  }
);
// A new private channel `name`, with the bot and `email` in it → { created, invited, url } ({ exists: true } if taken).
async function makeProjectChannel(token, name, email){
  const created = await slackFetch(token, 'conversations.create', { name, is_private: true });
  channelNamesCache = null;
  if (!created.ok){
    if (created.error === 'name_taken') return { exists: true };
    throw slackChannelError(created.error);
  }
  const out = { created: true, invited: false, url: await slackChannelUrl(token, created.channel.id) };
  const slackId = await slackIdForEmail(email);
  if (slackId){
    const invited = await slackFetch(token, 'conversations.invite', { channel: created.channel.id, users: slackId });
    out.invited = !!invited.ok;
  } else {
    logger.info('No Slack id for the submitter \u2014 channel created, nobody invited', { email });
  }
  return out;
}

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
  // Everyone the roster has with this email: one Slack doesn't know (user_not_found: an
  // account from another workspace, before the sync drops it) gives way to the next.
  const ids = (await db.collection('people').where('email', '==', String(email || '').toLowerCase()).get()).docs.map((d) => d.data().slackId).filter(Boolean);
  if (!ids.length) throw new HttpsError('failed-precondition', 'Your Slack account isn’t linked to this site yet.');
  const channelId = await slackChannelId(token, name);
  if (!channelId){
    const auth = await slackAuthInfo(token);
    throw new HttpsError('failed-precondition', 'The bot can’t see #' + name + (auth && auth.bot ? ' — invite @' + auth.bot + ' to it first.' : '.'));
  }
  let res;
  for (const slackId of ids){
    res = await slackFetch(token, 'conversations.invite', { channel: channelId, users: slackId });
    if (!res.ok && res.error === 'not_in_channel'){
      // A public channel the bot isn't in yet: join it (channels:join), then retry once.
      await slackFetch(token, 'conversations.join', { channel: channelId });
      res = await slackFetch(token, 'conversations.invite', { channel: channelId, users: slackId });
    }
    if (res.ok || res.error !== 'user_not_found') break;
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
// Google caps how many events and invitation emails the lab's (Gmail) account sends; past it,
// Calendar writes fail for a few hours (2026-11-05). So guests are emailed only for what they
// need to know (an invitation, a new time, who's on it; a cancellation), not for a new title,
// description or Meet link; and a sync stopped by the cap is marked (`calendarLimitAt`) and
// tried again every hour by retryCalendarLimits.
// Pure: a Calendar PATCH's changes → its sendUpdates.
function calendarUpdates(change){
  return ['attendees', 'start', 'end', 'recurrence'].some(function(k){ return change && change[k] !== undefined; }) ? 'all' : 'none';
}
// Pure: whether a Google error is that cap (or Calendar's rate limits).
function isCalendarLimit(err){
  return !!err && (['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].indexOf(err.reason) >= 0 || /usage limits exceeded/i.test(String(err.message || '')));
}
const CALENDAR_LIMIT_MSG = 'Google\u2019s limit for the lab\u2019s calendar was reached: BOLD.OS tries again by itself every hour.';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
// One date of a recurring meeting moved (functions/meeting-moves.js): its own instance in Google Calendar moved
// (or put back), Google emailing its guests. → the moves now in Google (`eventMoved`), or null if none changed.
// A date Google no longer has (the series changed since) is let go.
const meetingMoves = require('./meeting-moves');
async function syncMoves(eventId, meeting, moved, applied){
  const todo = meetingMoves.movesToSync(meeting, moved, applied);
  if (!todo.length) return null;
  const out = Object.assign({}, applied || {});
  const at = (date, time) => new Date(busy.londonMs(date, time)).toISOString();
  for (const x of todo){
    const id = meetingMoves.instanceId(eventId, busy.londonMs(x.orig, meeting.time));
    try {
      // Cancelled: that date is cancelled in Google (its guests told); restored or moved: back, at its time.
      if (x.to.cancelled) await googleFetch('DELETE', CAL + '/' + encodeURIComponent(id) + '?sendUpdates=all');
      else {
        const start = busy.londonMs(x.to.date, x.to.time);
        await googleFetch('PATCH', CAL + '/' + encodeURIComponent(id) + '?sendUpdates=all', Object.assign(x.restore ? { status: 'confirmed' } : {}, {
          start: { dateTime: at(x.to.date, x.to.time), timeZone: PROJECT_TZ },
          end: { dateTime: new Date(start + x.to.minutes * 60000).toISOString(), timeZone: PROJECT_TZ } }));
      }
    } catch (err){
      if (err.status !== 404 && err.status !== 410) throw err;
      logger.warn('A moved meeting date isn’t in Google Calendar any more', { orig: x.orig });
    }
    if ((moved || {})[x.orig]) out[x.orig] = moved[x.orig]; else delete out[x.orig];
  }
  return out;
}

// /meeting's invitations (handleMeetingCommand, handleMeetingSubmit): the event, from the lab's Google account.
exports.onOneOffMeeting = onDocumentCreated({ document: 'oneOffMeetings/{id}', secrets: [SLACK_BOT_TOKEN, GOOGLE_OAUTH], timeoutSeconds: 120 }, async (event) => {
  const d = event.data && event.data.data();
  if (!d || d.doneAt) return;
  const token = SLACK_BOT_TOKEN.value();
  const tell = async (text) => {
    const sent = d.channel ? await slackFetch(token, 'chat.postEphemeral', { channel: d.channel, user: d.by.slackId, text }) : { ok: false };
    if (!sent.ok) await dmBySlackId(token, d.by.slackId, text, '', { raw: true });
  };
  // Who's in the channel now, and whoever sent it.
  const who = await meetingInvitees(token, d.channel);
  const emails = ((who && who.emails) || []).concat(d.by.email).filter((e, i, a) => a.indexOf(e) === i).slice(0, slackMeeting.MAX_GUESTS + 1);
  const footer = 'Set up by ' + d.by.name + ' for ' + (d.channelName === 'this conversation' ? 'a Slack conversation' : '#' + d.channelName) + ', with /meeting on BOLD.OS.';
  try {
    const ev = await googleFetch('POST', CAL + '?conferenceDataVersion=1&sendUpdates=all', slackMeeting.eventOf(d, emails, 'bold-meeting-' + event.params.id, footer));
    const meet = d.link || ev.hangoutLink || '';
    await event.data.ref.set({ doneAt: Date.now(), eventId: ev.id, eventLink: ev.htmlLink || '', meetUrl: meet, invited: emails.length }, { merge: true });
    await tell('📅 Invited ' + (emails.length === 1 ? 'you' : emails.length + ' people') + ' to ' + (ev.htmlLink ? linkedTitle(slackText(d.title), ev.htmlLink) : '*' + slackText(d.title) + '*') +
      ', ' + slackMeeting.whenText(d.start, d.minutes) + (meet ? ' · ' + linkedTitle('join', meet) : '') + '. The invitations come from the lab’s Google account.');
  } catch (err){
    logger.warn('A meeting from /meeting failed', { id: event.params.id, error: String(err && err.message || err) });
    await event.data.ref.set({ doneAt: Date.now(), error: String(err && err.message || err).slice(0, 300) }, { merge: true });
    await tell(isCalendarLimit(err) ? 'Couldn’t send the invites for ' + slackText(d.title) + ': Google’s limit for the lab’s calendar was reached. Try again in a few hours.'
      : 'Couldn’t send the invites for ' + slackText(d.title) + ' — try again.');
  }
});

// Suggest a time on /meeting's form: everyone it invites (and whoever asked), their busy times (personBusy:
// their free/busy calendars and BOLD.OS meetings), the best times over the next two weeks (busy.suggestOnce),
// shown on the form. meetingSuggestions/{id} is server only.
exports.onMeetingSuggest = onDocumentCreated({ document: 'meetingSuggestions/{id}', secrets: [SLACK_BOT_TOKEN], timeoutSeconds: 120 }, async (event) => {
  const d = event.data && event.data.data();
  if (!d || d.doneAt) return;
  const token = SLACK_BOT_TOKEN.value(), view = JSON.parse(d.view);
  let shown;
  try {
    const who = (await meetingInvitees(token, d.channel)) || { emails: [], names: [] };
    const people = who.emails.map((e, i) => ({ email: e, name: who.names[i] }));
    if (d.by && !people.length) {
      const me = (await db.collection('people').doc(d.by).get()).data();
      if (me && me.email) people.push({ email: String(me.email).toLowerCase(), name: me.name || me.email });
    }
    const now = Date.now(), to = now + 16 * 86400000;
    const fromCalendar = [], none = [], failed = [];
    const list = await Promise.all(people.slice(0, slackMeeting.MAX_GUESTS).map(async (p) => {
      const b = await personBusy(p, now, to, null);
      if (b.read) fromCalendar.push(p.name);
      if (!b.feeds) none.push(p.name);
      if (b.failed) failed.push(p.name);
      return { name: p.name, busy: b.busy };
    }));
    const slots = busy.suggestOnce({ people: list, minutes: d.minutes, now });
    shown = slackMeeting.withSuggestions(view, { slots, tz: d.tz, fromCalendar, none, failed });
  } catch (err){
    logger.warn('Suggest a time failed', { error: String(err && err.message || err) });
    shown = slackMeeting.withSuggestions(view, { status: 'Couldn’t find a time — try again.' });
  }
  const r = await slackFetch(token, 'views.update', { view_id: d.viewId, view: shown });
  await event.data.ref.set({ doneAt: Date.now(), shown: !!r.ok, error: r.ok ? '' : String(r.error || '') }, { merge: true });
});

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
  if (ws.ownDeckUrl || ws.deckUrl) lines.push('<a href="' + (ws.ownDeckUrl || ws.deckUrl) + '">Slides</a>');
  if (ws.ownNotesUrl || ws.notesUrl) lines.push('<a href="' + (ws.ownNotesUrl || ws.notesUrl) + '">Meeting notes</a>');
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
// (2026-11-04) Its practical setup (a meeting, slides and notes) all there makes it ongoing on its own; marking it ongoing needs that
// setup first ('start' refuses otherwise). A meeting alone no longer does. Projects marked ongoing before
// keep `startedAt`, whatever they miss.
function workspaceStarted(ws){ return !!(ws && (ws.startedAt || setupMissing(ws).length === 0)); }
// Pure: what a project still needs to be ongoing: a weekly meeting, slides and notes (made by BOLD.OS or its
// own links). A GitHub repository isn't required (not every project needs one); it counts towards its health.
const SETUP_NAMES = { meeting: 'a weekly meeting', slides: 'slides', notes: 'meeting notes' };
function setupMissing(ws){
  ws = ws || {};
  return [['meeting', !!ws.meeting], ['slides', !!(ws.deckId || ws.deckUrl || ws.ownDeckUrl)], ['notes', !!(ws.notesId || ws.notesUrl || ws.ownNotesUrl)]]
    .filter((x) => !x[1]).map((x) => x[0]);
}
// Pure: its health (2026-11-04), as src/assets/js/project-health.js (BoldHealth.of) works it out: each of
// the four 2 when BOLD.OS made it, 1 when it's its own link, 0 when missing; out of 8.
function projectHealth(ws){
  ws = ws || {};
  const m = ws.meeting;
  const items = [['meeting', !m ? 'none' : m.link ? 'own' : 'os'], ['slides', ws.ownDeckUrl ? 'own' : ws.deckId || ws.deckUrl ? 'os' : 'none'],
    ['notes', ws.ownNotesUrl ? 'own' : ws.notesId || ws.notesUrl ? 'os' : 'none'], ['repo', ws.repoName ? 'os' : ws.ownRepoUrl ? 'own' : 'none']]
    .map((x) => ({ key: x[0], how: x[1] }));
  return { score: items.reduce((n, i) => n + (i.how === 'os' ? 2 : i.how === 'own' ? 1 : 0), 0), max: 8, items };
}
const setupMissingText = (missing) => missing.map((k) => SETUP_NAMES[k]).join(', ').replace(/, ([^,]*)$/, ' and $1');

// Pure: a project's group from its cards ([{ data, boardId }], oldest first): completed
// if marked so or accepted at any venue; otherwise its latest card's.
// A project proposed and not yet approved (2026-11-05, #226): `proposal` { status: 'proposed' | 'approved' |
// 'declined', gpuHours, at, by, decidedBy, decidedByName, decidedAt, note } on the card it was registered
// with. Without one (every project from before), it's approved.
const proposalPending = (d) => !!(d && d.proposal && d.proposal.status !== 'approved');
function projectGroupForCards(cards, completed, started){
  if (cards.length && proposalPending(cards[0].data)) return 'proposed';
  if (completed || cards.some(function(c){ return projectGroupForCard(c.data) === 'completed'; })) return 'completed';
  const last = cards[cards.length - 1];
  return projectGroupForCard(last.data, false, !!last.boardId, started);
}

// What a page reads: the workspace, as stored.
function workspaceView(ws){
  const out = {};
  ['cardId', 'boardId', 'venues', 'title', 'group', 'completedAt', 'startedAt', 'pausedAt', 'slackChannel', 'members', 'joined', 'meeting', 'meetingMoved', 'eventStart', 'eventLink', 'meetUrl',
    'deckUrl', 'notesUrl', 'ownDeckUrl', 'ownNotesUrl', 'noDocs', 'skipped', 'slackSkipped', 'error', 'repo', 'repoName', 'repoUrl', 'ownRepoUrl', 'repoError', 'work'].forEach(function(k){ if (ws[k] !== undefined) out[k] = ws[k]; });
  out.setupMissing = setupMissing(ws);
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
  // Any repository on GitHub, by its address (2026-11-04): only linked, so nobody is invited to it.
  if (r.mode === 'link'){
    const u = String(r.url || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
    return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(u) ? { mode: 'link', url: u } : { error: 'Give the repository’s GitHub address, as https://github.com/owner/name.' };
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
// files: the addresses they ticked on their profile (googleLinks inviteTo, #178), else the
// Google account they linked, else the email itself.
async function googleAddressesFor(emails){
  const out = [];
  for (const e of emails){
    const snap = await db.collection('googleLinks').doc(e).get();
    const d = snap.exists ? snap.data() : {};
    const list = Array.isArray(d.inviteTo) && d.inviteTo.length ? d.inviteTo : [d.google ? String(d.google).toLowerCase() : e];
    list.forEach(function(a){ if (out.indexOf(a) < 0) out.push(a); });
  }
  return out;
}

// GitHub access, as the BOLDiquette's transparency asks (2026-11-05, #214): everyone in BOLD who links
// GitHub joins bold-lab-ai, whose base permission (read) lets them see every repository. Writing differs:
// BOLD-internal and above write to every repository (the bold-internal team, INTERNAL_TEAM, which has
// write on all of them); everyone else writes to their projects' repositories alone (each project's team).
// Whether `email` writes to every repository (the bold-internal team): BOLD-internal and above.
async function writesEverywhere(email){
  return accessLib.rank(await access.groupFor(email)) >= accessLib.rank('internal');
}
// The linked GitHub accounts of `emails` → { team: [login] (the project's team), outside: [login]
// (outside collaborators on its repository: kept while they haven't accepted the org's invitation, so
// nobody loses their project's repository meanwhile) }.
async function githubLoginsFor(emails){
  const out = { team: [], outside: [] };
  for (const e of emails){
    const snap = await db.collection('githubLinks').doc(e).get();
    const d = snap.exists ? snap.data() : null;
    if (!d || !d.github || d.status === 'failed') continue;
    out.team.push(d.github.toLowerCase());
    if (d.status !== 'active') out.outside.push(d.github.toLowerCase());
  }
  return out;
}
const INTERNAL_TEAM = 'bold-internal';
// The bold-internal team (made if it isn't there) → its slug.
async function internalTeam(){
  try { return (await githubApp('GET', '/orgs/' + GITHUB_ORG + '/teams/' + INTERNAL_TEAM)).slug; }
  catch (err){
    if (err.status !== 404) throw err;
    return (await githubApp('POST', '/orgs/' + GITHUB_ORG + '/teams', { name: INTERNAL_TEAM, privacy: 'closed',
      description: 'BOLD-internal and above (BOLD.OS keeps it): write access to every repository' })).slug;
  }
}
// `login` in or out of the bold-internal team (adding someone invites them to the org, if need be).
async function setInternalWrite(login, on){
  const slug = await internalTeam(), path = '/orgs/' + GITHUB_ORG + '/teams/' + slug + '/memberships/' + login;
  if (on) await githubApp('PUT', path, { role: 'member' });
  else await githubApp('DELETE', path).catch(function(err){ if (err.status !== 404) throw err; });
}
// Every page of a GitHub list.
async function githubAll(path){
  const out = [];
  for (let page = 1; page < 50; page++){
    const list = await githubApp('GET', path + (path.indexOf('?') < 0 ? '?' : '&') + 'per_page=100&page=' + page);
    out.push.apply(out, list || []);
    if (!list || list.length < 100) break;
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
      // failure part way never makes the same file twice. Not one the project has its
      // own link for (ownDeckUrl, ownNotesUrl: the `links` action); a new one is shared
      // with everyone again.
      const makeDeck = !ws.noDocs && !ws.deckId && !ws.ownDeckUrl, makeNotes = !ws.noDocs && !ws.notesId && !ws.ownNotesUrl;
      const folder = makeDeck || makeNotes ? await projectFolderId() : null;
      if (makeDeck){
        const f = await createDeck(ws.title, folder);
        patch.deckId = f.id; patch.deckUrl = f.webViewLink; patch.shared = []; await save();
      }
      if (makeNotes){
        const f = await createNotes(ws.title, folder, { page: projectPageUrl(ws.cardId, ws.boardId), deck: ws.ownDeckUrl || ws.deckUrl });
        patch.notesId = f.id; patch.notesUrl = f.webViewLink; patch.shared = []; await save();
      }
      // Each member's address for Google: their linked Google account, or their Slack email.
      const addrs = await googleAddressesFor(ws.members);
      // Files: shared with every member, unshared from whoever left.
      const shared = ws.shared || [];
      // Only the ones BOLD.OS made: a project's own are its people's to share.
      for (const e of addrs.filter(function(m){ return (ws.deckId || ws.notesId) && shared.indexOf(m) < 0; })){
        if (ws.deckId) await shareFile(ws.deckId, e);
        if (ws.notesId) await shareFile(ws.notesId, e);
        patch.shared = (ws.shared || []).concat(e); await save();
      }
      for (const e of shared.filter(function(m){ return addrs.indexOf(m) < 0; })){
        if (ws.deckId) await unshareFile(ws.deckId, e);
        if (ws.notesId) await unshareFile(ws.notesId, e);
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
          // Every guest can change it in their own calendar (2026-11-11): Google has no co-owner of an event
          // besides the lab's account. BOLD.OS's own changes (its time, people, title) still win at its next sync.
          guestsCanModify: true
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
        const change = {}, timesChanged = !sameMeetingTimes(ws.eventMeeting, ws.meeting);
        const want = attendees(ev.attendees);
        if (JSON.stringify(want.map(function(a){ return a.email; })) !== JSON.stringify((ev.attendees || []).map(function(a){ return a.email; }))) change.attendees = want;
        if (ev.summary !== ws.title) change.summary = ws.title;
        const desc = eventDescription(ws);
        if (ev.description !== desc) change.description = desc;
        // A new time moves the series; a new end date or a pause only changes how long it runs.
        if (!sameMeetingTimes(ws.eventMeeting, ws.meeting)) Object.assign(change, eventTimes(ws.meeting, ws.pausedAt));
        else if ((ws.eventMeeting.until || '') !== (ws.meeting.until || '') || (ws.pausedAt || 0) !== (ws.eventPausedAt || 0)) change.recurrence = meetingRecurrence(ws.meeting, ws.pausedAt);
        if (ev.guestsCanModify !== true) change.guestsCanModify = true;   // one made before 2026-11-11 (emails nobody)
        Object.assign(change, conferenceChange(ev, ws.meeting, 'bold-' + id + '-' + Date.now()));
        let now = ev;
        if (Object.keys(change).length){
          now = await googleFetch('PATCH', CAL + '/' + ws.eventId + '?conferenceDataVersion=1&sendUpdates=' + calendarUpdates(change), change) || ev;
          patch.eventMeeting = ws.meeting; patch.eventPausedAt = ws.pausedAt || FieldValue.delete(); patch.eventStart = seriesStart(now); await save();
        } else if (!ws.eventStart && seriesStart(ev)){ patch.eventStart = seriesStart(ev); await save(); }
        const url = ws.meeting.link || now.hangoutLink || '';
        if (url !== (ws.meetUrl || '')){ patch.meetUrl = url; await save(); }
        // Its dates moved one by one (a new time for all of them leaves none moved).
        if (!ws.pausedAt){
          const moves = await syncMoves(ws.eventId, ws.meeting, ws.meetingMoved, timesChanged ? {} : ws.eventMoved);
          if (moves) { patch.eventMoved = moves; await save(); }
          else if (timesChanged && ws.eventMoved) { patch.eventMoved = FieldValue.delete(); await save(); }
        }
      }
      patch.error = FieldValue.delete(); patch.calendarLimitAt = FieldValue.delete();
    } catch (err){
      logger.error('Setting up the project\u2019s meeting, slides and notes failed', { id, error: String(err && err.message || err) });
      if (isCalendarLimit(err)) { patch.error = CALENDAR_LIMIT_MSG; patch.calendarLimitAt = Date.now(); }
      else patch.error = err instanceof HttpsError ? err.message : 'Couldn\u2019t set up the meeting, slides and notes.';
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
      // Any GitHub repository, linked (2026-11-04): kept as its address, nothing made or shared.
      if (ws.repo && ws.repo.mode === 'link' && !ws.ownRepoUrl && !ws.repoName){ patch.ownRepoUrl = ws.repo.url; await save(); }
      if (ws.repo && ws.repo.mode === 'template' && !ws.repoName){
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
          // BOLD-internal and above write to it too.
          await githubApp('PUT', '/orgs/' + GITHUB_ORG + '/teams/' + (await internalTeam()) + '/repos/' + GITHUB_ORG + '/' + ws.repoName, { permission: 'push' });
          patch.teamSlug = team.slug; patch.teamMembers = []; await save();
        }
        // Everyone on it through the team (adding someone to a team invites them to the org); while
        // they haven't accepted that, as an outside collaborator too, with write access.
        const want = await githubLoginsFor(ws.members);
        const have = ws.teamMembers || [];
        for (const login of want.team.filter(function(l){ return have.indexOf(l) < 0; })){
          await githubApp('PUT', '/orgs/' + GITHUB_ORG + '/teams/' + ws.teamSlug + '/memberships/' + login, { role: 'member' });
          patch.teamMembers = (ws.teamMembers || []).concat(login); await save();
        }
        for (const login of have.filter(function(l){ return want.team.indexOf(l) < 0; })){
          await githubApp('DELETE', '/orgs/' + GITHUB_ORG + '/teams/' + ws.teamSlug + '/memberships/' + login)
            .catch(function(err){ if (err.status !== 404) throw err; });
          patch.teamMembers = ws.teamMembers.filter(function(l){ return l !== login; }); await save();
        }
        const repoPath = '/repos/' + GITHUB_ORG + '/' + ws.repoName;
        const outside = ws.repoCollaborators || [];
        for (const login of want.outside.filter(function(l){ return outside.indexOf(l) < 0; })){
          await githubApp('PUT', repoPath + '/collaborators/' + login, { permission: 'push' });
          patch.repoCollaborators = (ws.repoCollaborators || []).concat(login); await save();
        }
        const gone = outside.filter(function(l){ return want.outside.indexOf(l) < 0; });
        if (gone.length){
          // Their access, or the invitation they haven't accepted yet.
          const invites = await githubApp('GET', repoPath + '/invitations?per_page=100').catch(function(){ return []; });
          for (const login of gone){
            await githubApp('DELETE', repoPath + '/collaborators/' + login).catch(function(err){ if (err.status !== 404) throw err; });
            for (const inv of (invites || []).filter(function(i){ return i.invitee && String(i.invitee.login).toLowerCase() === login; })){
              await githubApp('DELETE', repoPath + '/invitations/' + inv.id).catch(function(err){ if (err.status !== 404) throw err; });
            }
            patch.repoCollaborators = ws.repoCollaborators.filter(function(l){ return l !== login; }); await save();
          }
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
  return onDocumentWritten({ document, secrets: [GOOGLE_OAUTH, GITHUB_APP, SLACK_BOT_TOKEN] }, async function(event){
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
      if (proposalPending(after)) return;   // set up once approved (projectProposal)
      await setUpProject(pid, after);
      return;
    }
    const key = function(d){ return JSON.stringify([d.title, d.slackChannel, d.submittedBy && d.submittedBy.email, d.authorEmails, d.status, d.outcome]); };
    if (key(before) === key(after)) return;
    if ((await wsRef.get()).exists) await syncWorkspace(pid);
    // Its channel changed (on its page, which says so first): everyone on the project is invited to the new one.
    const moved = projectChannelChange(before, after);
    if (moved && !proposalPending(after)) await inviteProjectToChannel(pid, moved);
  });
}
// Pure: the channel a project's card moved to (its name, no #), or '' when it didn't change or was cleared.
function projectChannelChange(before, after){
  const name = (d) => { const n = normalizeProjectChannel(String((d && d.slackChannel) || '')); return n.error ? '' : n.name; };
  const was = name(before), now = name(after);
  return now && now !== was ? now : '';
}
// Invites everyone on project `pid` (its workspace's members) to Slack channel `name`. Someone not
// on Slack, or already in it, is passed over; what failed is logged, and kept on the workspace
// (channelInvite: { channel, at, failed: [emails] }) for the page.
async function inviteProjectToChannel(pid, name){
  const ws = (await db.collection('projectWorkspaces').doc(pid).get()).data() || {};
  const token = SLACK_BOT_TOKEN.value(), failed = [];
  for (const e of ws.members || []){
    if (!(await slackIdForEmail(e))) continue;
    try { await inviteToProjectChannel(token, e, name); }
    catch (err){
      logger.warn('Inviting a project\u2019s people to its new channel failed', { pid, channel: name, error: String(err.message) });
      failed.push(e);
      if (/can.t see|can.t manage/.test(err.message)) break;   // the same for everyone after
    }
  }
  await db.collection('projectWorkspaces').doc(pid).set({ channelInvite: { channel: '#' + name, at: Date.now(), failed } }, { merge: true });
}
// A new project's workspace, as its proposer asked (its card's setUp*): its meeting, slides, notes, repository.
async function setUpProject(pid, after){
  const m = after.setUpMeeting ? normalizeMeeting(after.setUpMeeting) : null;
  const r = after.setUpRepo ? normalizeRepo(after.setUpRepo) : null;
  await syncWorkspace(pid, { meeting: m && !m.error ? m : undefined, repo: r && !r.error ? r : undefined, docs: after.setUpDocs === false ? false : undefined,
    skipped: Array.isArray(after.setUpSkipped) ? after.setUpSkipped.filter(function(k){ return ['channel', 'announce', 'meeting', 'docs', 'repo'].indexOf(k) >= 0; }) : undefined });
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
    if (card && card.submittedBy && card.submittedBy.email) await afterProgress(card.submittedBy.email);   // a project of their own
    // announce: false, whoever registered it chose not to (its workspace's `skipped`
    // says so, and its page offers to announce it later: projectWorkspace 'announce').
    if (!card || card.announce === false) return;
    if (proposalPending(card)) { await tellProposal(card, event.params.cardId); return; }   // announced once approved
    await announceProject(card, event.params.cardId).catch(function(err){ logger.warn('Announcing a new project failed', { error: String(err.message) }); });
  }
);
// A project proposed (#226): PIs and admins hear (their Inbox, To do); decided with projectProposal.
async function tellProposal(card, cardId){
  const by = (card.submittedBy && (card.submittedBy.name || card.submittedBy.email)) || 'Someone', hours = Number(card.proposal && card.proposal.gpuHours) || 0;
  const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins')).filter((e) => e !== lowerEmail(card.submittedBy));
  await deliver(staff, { text: by + ' proposes a project: \u201c' + (card.title || 'Untitled') + '\u201d, ' + hours.toLocaleString('en-GB') + ' GPU hours. Approve or decline it on its page.',
    href: projectPageUrl(cardId), feature: 'project-proposals', source: 'bold', about: 'project:' + cardId });
}
// Pure: a proposal's compute budget, in GPU hours → the number, or { error }.
function normalizeGpuHours(v){
  const n = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : Number(v);
  if (!isFinite(n) || n <= 0) return { error: 'Give its compute budget, in GPU hours.' };
  if (n > 10000000) return { error: 'That\u2019s more GPU hours than BOLD has.' };
  return Math.round(n);
}
// A proposed project, decided (#226): { id, accept, note? } by a PI or admin other than whoever proposed it
// (as every change on the site); { id, action: 'resubmit', gpuHours? } by whoever proposed it, after a
// decline. Approving sets it up as its proposer asked (its channel, meeting, slides, notes, repository),
// announces it if they asked, and tells them; declining tells them, with the note.
// A proposed project's conversation (2026-11-06): conversations/cm-proposal-<card id>, about the project, started as
// its proposer (its budget and abstract); where the proposer and the PIs and admins discuss it, and where each
// decision (approved, declined, sent again) is written. Made when first needed, so older proposals have one too.
// Its decisions are source 'proposal' (onConversationMessage leaves them: the proposer is told by deliver).
async function proposalThread(id, card){
  const pid = 'cm-proposal-' + id, ref = db.collection('conversations').doc(pid);
  if ((await ref.get()).exists) return pid;
  const prop = card.proposal || {}, by = card.submittedBy || {}, abstract = String(card.abstractText || '').trim();
  const post = { title: ('Proposal: ' + String(card.title || 'a project')).slice(0, 200),
    body: '**' + String(card.title || 'A project') + '**, with a compute budget of ' + (Number(prop.gpuHours) || 0).toLocaleString('en-GB') + ' GPU hours.' + (abstract ? '\n\n' + abstract : ''),
    name: String(by.name || by.email || 'Someone').slice(0, 200), createdBy: String(by.email || '').toLowerCase(), at: prop.at || card.createdAt || Date.now(),
    source: 'proposal', project: projectIdOf(card, id), projectTitle: String(card.title || '').slice(0, 300), private: false, readers: [], votes: {}, replies: 0 };
  await ref.create(post).catch((e) => { if (e.code !== 6) throw e; });   // 6: made meanwhile
  return pid;
}
async function proposalNote(id, card, text, email, name){
  const pid = await proposalThread(id, card), ref = db.collection('conversations').doc(pid);
  // It goes on with the conversation: an answer to its latest message (as Reply does), not a branch from the post.
  const last = (await ref.collection('messages').orderBy('at', 'desc').limit(1).get()).docs[0];
  // `at` a timestamp, as the site's replies' are (one order: Firestore sorts numbers before timestamps).
  await ref.collection('messages').add({ parent: last ? last.id : pid, body: text, name: String(name || email), createdBy: email, at: FieldValue.serverTimestamp(), source: 'proposal', votes: {} });
  await ref.set({ replies: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp() }, { merge: true });
}

exports.projectProposal = onCall(
  { secrets: [SLACK_BOT_TOKEN, GOOGLE_OAUTH, GITHUB_APP], timeoutSeconds: 300 },
  async (request) => {
    const email = callerEmail(request), d = request.data || {};
    await access.requireAccess(email, 'projects', 'list');   // Who can see what
    const id = String(d.id || '');
    if (!validSlug(id)) throw new HttpsError('invalid-argument', 'No project given.');
    const ref = db.collection('projects').doc(id), snap = await ref.get();
    if (!snap.exists || !snap.data().proposal) throw new HttpsError('not-found', 'That proposal isn\u2019t there.');
    const card = snap.data(), prop = card.proposal, mine = lowerEmail(card.submittedBy) === email;
    // Its conversation (made if it isn't yet), for its page.
    if (d.action === 'thread') return { id: await proposalThread(id, card) };
    if (d.action === 'resubmit'){
      if (!mine) throw new HttpsError('permission-denied', 'Only whoever proposed it can send it again.');
      if (prop.status !== 'declined') throw new HttpsError('failed-precondition', 'It isn\u2019t declined.');
      const hours = d.gpuHours === undefined ? prop.gpuHours : normalizeGpuHours(d.gpuHours);
      if (hours && hours.error) throw new HttpsError('invalid-argument', hours.error);
      const next = { status: 'proposed', gpuHours: hours, at: Date.now(), by: email };
      await ref.update({ proposal: next, updatedAt: Date.now() });
      await tellProposal(Object.assign({}, card, { proposal: next }), id);
      await proposalNote(id, card, 'Sent it again, with a budget of ' + (Number(hours) || 0).toLocaleString('en-GB') + ' GPU hours.', email, request.auth.token.name || email)
        .catch((err) => logger.warn('Writing to a proposal’s conversation failed', { error: String(err.message) }));
      return { ok: true };
    }
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins decide a proposed project.');
    if (mine) throw new HttpsError('failed-precondition', 'Another PI or admin decides your own proposal.');
    if (prop.status !== 'proposed') throw new HttpsError('failed-precondition', 'It\u2019s already been decided.');
    const accept = !!d.accept, note = String(d.note || '').trim().slice(0, 1000), name = request.auth.token.name || email;
    const decided = Object.assign({}, prop, { status: accept ? 'approved' : 'declined', decidedBy: email, decidedByName: name, decidedAt: Date.now(), note });
    await ref.update({ proposal: decided, updatedAt: Date.now() });
    await proposalNote(id, card, (accept ? '**Approved**' : '**Declined**') + (note ? ': ' + note : '.'), email, name)
      .catch((err) => logger.warn('Writing to a proposal’s conversation failed', { error: String(err.message) }));
    const to = lowerEmail(card.submittedBy), title = card.title || 'Your project';
    if (!accept){
      await deliver([to], { text: name + ' declined your proposed project \u201c' + title + '\u201d' + (note ? ': \u201c' + note + '\u201d' : '.') + ' You can change it and send it again from its page.',
        href: projectPageUrl(id), feature: 'project-proposals', source: 'bold', about: 'project:' + id });
      return { ok: true };
    }
    // Its channel, now (the proposer's name for it), with them in it.
    let channel = '';
    const want = normalizeProjectChannel(card.setUpChannel || '');
    if (card.setUpChannel && !want.error){
      const token = SLACK_BOT_TOKEN.value();
      const r = (await slackChannelId(token, want.name)) ? { exists: true } : await makeProjectChannel(token, want.name, to).catch((err) => { logger.warn('Making a proposed project\u2019s channel failed', { error: String(err.message) }); return null; });
      if (r) channel = '#' + want.name;
    }
    const now = Object.assign({}, card, { proposal: decided }, channel ? { slackChannel: channel } : {});
    if (channel) await ref.update({ slackChannel: channel });
    await setUpProject(projectIdOf(card, id), now);
    if (card.announce !== false) await announceProject(now, id).catch((err) => logger.warn('Announcing a new project failed', { error: String(err.message) }));
    await deliver([to], { text: name + ' approved your project \u201c' + title + '\u201d (' + (Number(prop.gpuHours) || 0).toLocaleString('en-GB') + ' GPU hours): it\u2019s being set up.' + (note ? ' \u201c' + note + '\u201d' : ''),
      href: projectPageUrl(id), feature: 'project-proposals', source: 'bold', about: 'project:' + id });
    return { ok: true, slackChannel: channel };
  }
);
async function announceProject(card, cardId){
  const token = SLACK_BOT_TOKEN.value();
  const channel = await slackChannelId(token, ACTIVE_PROJECTS_CHANNEL);
  if (!channel) throw new Error('The BOLD.OS app can’t see #' + ACTIVE_PROJECTS_CHANNEL + ': invite it to the channel.');
  const posted = await postInChannel(token, 'project-announce', channel, ACTIVE_PROJECTS_CHANNEL, {
    text: projectAnnouncement(card, projectPageUrl(cardId)), unfurl_links: false,
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
//   editors only. On a venue's board it's in submission either way. 'start' needs its setup first
//   (setupMissing); with all of it, it's ongoing anyway.
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

// Images in Markdown (#193; md-images.js): an image or SVG pasted, dropped or chosen in a
// Markdown box, uploaded into the lab's Drive, in its own folder. Anyone signed in.
// { name, type, size } → { url }: a resumable upload session the browser sends the file
// to (as presentationFile). { file } → { url }: once it's there, and it's an image of
// theirs within the limit, anyone with the link can view it; url is its Drive link,
// which the pages show as an image (BOLD.imageHtml).
// Each image is kept once: `imageHashes/{sha256}` (server only) → { file, url }, from
// Drive's own sha256Checksum of the uploaded file. { find: sha256 } → { url } of the copy
// the lab already has (still on Drive), or {}: the page then uses it, uploading nothing.
// An upload that turns out to be a copy (two at once) is deleted for the one there.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const IMAGE_MAX = 10 * 1024 * 1024;
async function imagesFolderId(){
  const ref = db.collection('settings').doc('projectDrive');
  const snap = await ref.get();
  if (snap.exists && snap.data().imagesFolderId) return snap.data().imagesFolderId;
  const f = await googleFetch('POST', DRIVE + '?fields=id', { name: 'BOLD.OS images', mimeType: 'application/vnd.google-apps.folder' });
  await ref.set({ imagesFolderId: f.id }, { merge: true });
  return f.id;
}
exports.markdownImage = onCall(
  { secrets: [GOOGLE_OAUTH] },
  async (request) => {
    const email = callerEmail(request), data = request.data || {};
    const owner = 'image:' + email;
    const known = async function(hash){
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const ref = db.collection('imageHashes').doc(hash), snap = await ref.get();
      if (!snap.exists) return null;
      const f = await googleFetch('GET', DRIVE + '/' + snap.data().file + '?fields=id,trashed').catch(() => null);
      if (f && !f.trashed) return snap.data();
      await ref.delete();
      return null;
    };
    if (data.find !== undefined){
      const k = await known(String(data.find));
      return k ? { url: k.url } : {};
    }
    if (data.file){
      const id = String(data.file);
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new HttpsError('invalid-argument', 'No file given.');
      const f = await googleFetch('GET', DRIVE + '/' + id + '?fields=id,mimeType,size,sha256Checksum,appProperties');
      if (!f || !f.appProperties || f.appProperties.boldFor !== owner) throw new HttpsError('permission-denied', 'That file isn’t yours.');
      if (IMAGE_TYPES.indexOf(f.mimeType) < 0 || !(Number(f.size) <= IMAGE_MAX)){
        await googleFetch('DELETE', DRIVE + '/' + id).catch(() => null);
        throw new HttpsError('invalid-argument', 'Only PNG, JPEG, GIF, WebP or SVG images, up to 10 MB.');
      }
      const hash = String(f.sha256Checksum || '').toLowerCase();
      const there = hash && await known(hash);
      if (there && there.file !== id){
        await googleFetch('DELETE', DRIVE + '/' + id).catch(() => null);
        logger.info('markdownImage: a copy, kept once', { file: there.file, by: email });
        return { url: there.url };
      }
      await googleFetch('POST', DRIVE + '/' + id + '/permissions', { type: 'anyone', role: 'reader' });
      const url = 'https://drive.google.com/file/d/' + id + '/view';
      if (hash) await db.collection('imageHashes').doc(hash).set({ file: id, url, type: f.mimeType, by: email, at: Date.now() });
      logger.info('markdownImage: uploaded', { file: id, type: f.mimeType, by: email });
      return { url };
    }
    const name = String(data.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'image', size = Number(data.size) || 0;
    const type = String(data.type || '');
    if (IMAGE_TYPES.indexOf(type) < 0) throw new HttpsError('invalid-argument', 'Only PNG, JPEG, GIF, WebP or SVG images.');
    if (!size || size > IMAGE_MAX) throw new HttpsError('invalid-argument', 'Images up to 10 MB.');
    const origin = String((request.rawRequest && request.rawRequest.headers.origin) || '');
    const headers = { 'Authorization': 'Bearer ' + await googleToken(), 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(size) };
    if (UPLOAD_ORIGINS.indexOf(origin) >= 0) headers.Origin = origin;
    const meta = { name, mimeType: type, parents: [await imagesFolderId()], appProperties: { boldFor: owner } };
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers, body: JSON.stringify(meta) });
    const url = res.headers.get('location');
    if (!res.ok || !url){
      logger.warn('markdownImage: Drive refused the upload', { status: res.status, body: (await res.text()).slice(0, 300) });
      throw new HttpsError('unavailable', 'Google Drive didn’t take the image — try again.');
    }
    return { url };
  }
);

exports.projectWorkspace = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN, GITHUB_APP], timeoutSeconds: 540 },
  async (request) => {
    const email = callerEmail(request);
    // Who can see what: Projects' View or Edit for everything; below that, only a project
    // they're one of the people of (invited to it: projectInvite), checked below.
    const lists = await access.can(email, 'projects', 'list');
    const data = request.data || {};
    if (!lists && ['templates', 'mine', 'venues', 'join'].indexOf(data.action) >= 0) await access.requireAccess(email, 'projects', 'list');
    // Joining straight away is for BOLD-internal and above; BOLD-associate asks, PAN-BOLD talks to its lead.
    if (data.action === 'join' && !(await joinsStraightAway(email))) throw new HttpsError('permission-denied', 'Ask to join it: its lead accepts. (Joining straight away is for BOLD-internal and above.)');
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
    // Proposed (#226): nothing is set up, joined or changed until a PI or admin approves it (projectProposal).
    if (proposalPending(card)) throw new HttpsError('failed-precondition', card.proposal.status === 'declined' ? 'It was declined: change it and send it again first.' : 'It\u2019s waiting for a PI or admin to approve it.');
    const pid = projectIdOf(card, id);
    const wsRef = db.collection('projectWorkspaces').doc(pid);
    // Edit without View: joining, and then everything its people do.
    if (data.action !== 'join') await requireSeesProject(email, pid);

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
        // A link to any repository: kept as it is (ownRepoUrl), nothing made on GitHub.
        if (changes.repo.mode === 'link') { await wsRef.set({ ownRepoUrl: changes.repo.url }, { merge: true }); return workspaceView(await syncWorkspace(pid)); }
      }
      return workspaceView(await syncWorkspace(pid, changes));
    }

    // Its own slides or notes (#151): a link in place of the one BOLD.OS makes; '' goes back
    // to that one (made if there's none, unless it was left out). Only what's given changes.
    if (data.action === 'links'){
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project\u2019s submitter, authors, PIs and admins can do this.');
      const set = {};
      [['deck', 'ownDeckUrl', 'slides'], ['notes', 'ownNotesUrl', 'meeting notes']].forEach(function(k){
        if (!(k[0] in data)) return;
        const v = String(data[k[0]] || '').trim();
        if (v && (v.length > 500 || !/^https:\/\/[^\s<>"]+$/.test(v))) throw new HttpsError('invalid-argument', 'The link to the ' + k[2] + ' must be a web address starting https://.');
        set[k[1]] = v || FieldValue.delete();
      });
      // A linked repository (repo action, mode 'link'): '' unlinks it.
      if ('repo' in data && !String(data.repo || '').trim()) set.ownRepoUrl = FieldValue.delete();
      if (!Object.keys(set).length) throw new HttpsError('invalid-argument', 'No link given.');
      await wsRef.set(set, { merge: true });
      return workspaceView(await syncWorkspace(pid));
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
      if (data.action === 'start') {
        const missing = setupMissing((await wsRef.get()).data());
        if (missing.length) throw new HttpsError('failed-precondition', 'Set up ' + setupMissingText(missing) + ' first: then it’s ongoing.');
      }
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
    // whole lab's). data.work: any of { on, repos, content, channels, milestones }; the
    // project's people also plan its milestones.
    if (data.action === 'work'){
      const w = data.work && typeof data.work === 'object' ? data.work : {};
      const full = await isFullWrite(email);
      const ws = (await wsRef.get()).data() || {};
      const onlyMilestones = Object.keys(w).every((k) => k === 'milestones');
      const member = (ws.members || []).map(lowerEmail).indexOf(email) >= 0;
      if (!full && !(onlyMilestones && member) && !(await canEditCard(email, card))) throw new HttpsError('permission-denied', onlyMilestones ? 'Only the project’s people, PIs and admins can plan its milestones.' : 'Only the project’s submitter, authors, PIs and admins can do this.');
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
      // Slack channels besides the project's own whose /bug and /feature-request come to
      // this board (BOLD OS's: #bold-operating-system): ones the bot can see, not another
      // project's own channel, nor another board's.
      if (w.channels !== undefined){
        if (!Array.isArray(w.channels) || w.channels.length > 5) throw new HttpsError('invalid-argument', 'Up to 5 Slack channels.');
        const token = SLACK_BOT_TOKEN.value(), names = [];
        for (const x of w.channels){
          const n = String(x || '').trim().replace(/^#/, '').toLowerCase();
          if (!n || names.indexOf(n) >= 0) continue;
          if (!/^[a-z0-9_-]{1,80}$/.test(n)) throw new HttpsError('invalid-argument', '#' + n.slice(0, 80) + ' isn’t a Slack channel name.');
          if (!(await slackChannelId(token, n))) {
            const near = nearestChannel(n, channelNamesCache ? Array.from(channelNamesCache.names.keys()) : []);
            throw new HttpsError('not-found', 'BOLD.OS can’t see #' + n + (near ? ' — did you mean #' + near + '?' : ': if it’s private, invite the BOLD OS app to it first.'));
          }
          const own = (await db.collection('projectWorkspaces').where('slackChannel', 'in', ['#' + n, n]).get()).docs.filter((d) => d.id !== pid)[0];
          if (own) throw new HttpsError('failed-precondition', '#' + n + ' is ' + ((own.data().title) || 'another project') + '’s own channel.');
          const other = (await db.collection('projectWorkspaces').where('work.channels', 'array-contains', n).get()).docs.filter((d) => d.id !== pid)[0];
          if (other) throw new HttpsError('failed-precondition', '#' + n + ' already sends to ' + ((other.data().title) || 'another project') + '’s board.');
          names.push(n);
        }
        next.channels = names;
      }
      // Its milestones: [{ id, name, start, end }] (dates YYYY-MM-DD, either may be ''); a card
      // is in one by its `milestone` (the id), and the board shows each one's progress.
      if (w.milestones !== undefined){
        if (!Array.isArray(w.milestones) || w.milestones.length > 50) throw new HttpsError('invalid-argument', 'Up to 50 milestones.');
        const day = (v) => { v = String(v || '').trim(); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpsError('invalid-argument', 'A milestone’s dates are YYYY-MM-DD.'); return v; };
        const ids = {};
        next.milestones = w.milestones.map((x) => {
          const id = String((x && x.id) || '').trim(), name = String((x && x.name) || '').trim().slice(0, 60);
          if (!/^[a-z0-9]{1,20}$/.test(id) || ids[id]) throw new HttpsError('invalid-argument', 'A milestone needs its own id.');
          if (!name) throw new HttpsError('invalid-argument', 'Give each milestone a name.');
          const start = day(x.start), end = day(x.end);
          if (start && end && end < start) throw new HttpsError('invalid-argument', name + ' ends before it starts.');
          ids[id] = true;
          return { id, name, start, end };
        });
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
// admin"), and sits in a column: To do, In progress, Waiting for review, Done (the last 30 days).
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
const WORK_DAYS = 30;   // Done: the last 30 days (older cards are archived on the page)
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

// Names as on BOLD.OS: email → { names: name (members, then the Slack roster), ids: Slack
// id (their page, person.html?id=) }; a minute's cache.
let workNamesCache = null;
async function workNames(){
  if (workNamesCache && workNamesCache.at > Date.now() - 60000) return workNamesCache;
  const [members, people] = await Promise.all([db.collection('members').get(), db.collection('people').get()]);
  const names = {}, ids = {};
  people.docs.forEach(function(d){ const p = d.data(), e = String(p.email || '').toLowerCase(); if (!e) return; ids[e] = d.id; if (p.name) names[e] = p.name; });
  members.docs.forEach(function(d){ const m = d.data(); if (m.name) names[d.id.toLowerCase()] = m.name; });
  workNamesCache = { at: Date.now(), names, ids };
  return workNamesCache;
}

// Pure: what the people on an item do (each shown as a tag before their names): Reviewer,
// Decides, Writes it…; once done, what happened (Accepted by, Merged…).
function workRole(x){
  if (x.column === 'done') return { accepted: 'Accepted by', approved: 'Approved by', declined: 'Declined by', merged: 'Merged', closed: 'Closed', withdrawn: 'Withdrawn' }[x.state] || 'Done by';
  if (x.kind === 'pr') return x.state === 'draft' ? 'Working on it' : 'Reviewer';
  if (x.kind === 'review') return x.state === 'changes requested' ? 'Revises' : 'Reviewer';
  return { issue: 'Assigned', letter: 'Writes it', introduction: 'Introduces', invite: 'Confirms', event: 'Releases' }[x.kind] || 'Decides';
}

// Pure: a proposal's page: its collection and document → { page (Who can see what), title, url }.
function proposalPlace(collection, slug, doc){
  const title = (doc && doc.title) || slug;
  if (collection === 'handbook') return { page: 'boldiquette', title: slug === 'boldiquette' ? 'BOLDiquette' : title, url: handbookUrl(slug) };
  if (collection === 'guides') return { page: require('./access').guideArea(slug), title, url: guideUrl(slug) };
  if (collection === 'skills') return { page: 'skills', title: 'Skill ' + title, url: skillUrl(slug) };
  if (collection === 'agentTools') return { page: 'tools', title: 'Tool ' + title, url: toolUrl(slug) };
  return null;
}

// The site's proposed changes the caller can see (level 'view', the default) or propose on ('edit':
// the Version pill's), open, or decided in the last 30 days.
async function contentWork(email, person, level){
  const after = Date.now() - WORK_DAYS * 86400000;
  // All of them, filtered here: a few hundred at most, and no collection-group index needed.
  const docs = (await db.collectionGroup('proposals').get()).docs.filter(function(d){
    const q = d.data();
    // A branch's pages are listed as the branch, below.
    return !q.branch && (q.status === 'open' || (q.decidedAt || 0) >= after);
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
    if (!(place.page in mayView)) mayView[place.page] = await access.can(email, place.page, level === 'edit' ? 'edit' : 'view');
    if (!mayView[place.page]) continue;
    const q = d.data();
    const what = proposalSummary(q).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    // A new skill or tool reads as one ("New skill: Paper review"), anything else as its change.
    const title = q.kind === 'new' && /^(Skill|Tool) /.test(place.title) ? 'New ' + place.title.replace(/^(Skill|Tool) /, function(x){ return x.trim().toLowerCase() + ': '; }) : place.title + ': ' + what;
    const item = { source: 'content', type: 'content', kind: 'proposal', ref: d.ref.path, title: title,
      url: place.url + proposalAnchor(collection, d.id), by: person(q.by && q.by.email, q.by && q.by.name) };
    if (q.status === 'open') Object.assign(item, { column: 'review', state: 'open', since: q.editedAt || q.at || 0, on: [], waiting: PIS_ADMINS });
    else Object.assign(item, { column: 'done', state: q.status, since: q.decidedAt || 0, on: q.decidedBy ? [person(q.decidedBy, q.decidedByName)] : [] });
    items.push(item);
  }
  // Branches (functions/branches.js): one each, seen by whoever can see every page it changes.
  const branches = (await db.collection('branches').get()).docs.filter((d) => { const b = d.data(); return b.status === 'open' || (b.decidedAt || 0) >= after; });
  for (const d of branches){
    const b = d.data(), pages = b.pages || [];
    let sees = !!pages.length;
    for (const p of pages){
      const area = branchLib.areaOf(p, require('./access').guideArea);
      if (!(area in mayView)) mayView[area] = await access.can(email, area, level === 'edit' ? 'edit' : 'view');
      if (!mayView[area]) { sees = false; break; }
    }
    if (!sees) continue;
    const item = { source: 'content', type: 'content', kind: 'proposal', ref: d.ref.path, title: String(b.title || 'A proposed change'),
      url: branchUrl(d.id), by: person(b.by && b.by.email, b.by && b.by.name), targets: pages,
      mine: (b.contributors || []).indexOf(String(email || '').toLowerCase()) >= 0 };
    if (b.status === 'open') Object.assign(item, { column: 'review', state: 'open', since: b.editedAt || b.at || 0, on: [], waiting: PIS_ADMINS });
    else Object.assign(item, { column: 'done', state: b.status, since: b.decidedAt || 0, on: b.decidedBy ? [person(b.decidedBy, b.decidedByName)] : [] });
    items.push(item);
  }
  return items;
}

// Pure: a request → its column and when it got there: open → review (waiting on someone),
// being worked on → doing, settled → done (or null once older than 30 days).
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
    full ? all('groupRequests') : q('groupRequests', 'email'),   // PIs and admins decide them (groupRequest)
    q('letterRequests', 'requesterEmail'), q('letterRequests', 'writerEmail'),
    q('introRequests', 'requesterEmail'), q('introRequests', 'offererEmail'),
    access.can(email, 'calendar', 'view').then(function(ok){ return ok ? q('studyRequests', 'email') : []; }),
    access.can(email, 'calendar', 'view').then(function(ok){ return ok ? q('studyRequests', 'student') : []; }),
    full ? all('apiTokens') : q('apiTokens', 'email'),
    full ? all('boards') : Promise.resolve([])
  ]);
  // Projects proposed (#226): PIs and admins decide; whoever proposed one waits.
  const proposals = (await (full ? db.collection('projects').where('proposal.status', 'in', ['proposed', 'declined']) : db.collection('projects').where('submittedBy.email', '==', email)).get()).docs
    .filter(function(d){ return d.data().proposal && d.data().proposal.status !== 'approved'; });
  proposals.forEach(function(d){
    const r = d.data(), p = r.proposal, open = p.status === 'proposed';
    if (!open && !(lowerEmail(r.submittedBy) === email)) return;
    add({ kind: 'project-proposal', ref: d.ref.path, title: 'Proposed project: ' + (r.title || 'Untitled') + ' (' + (Number(p.gpuHours) || 0).toLocaleString('en-GB') + ' GPU hours)' + (open ? '' : ', declined'),
      url: projectPageUrl(d.id), by: person(lowerEmail(r.submittedBy), r.submittedBy && r.submittedBy.name),
      on: p.decidedBy ? [person(p.decidedBy, p.decidedByName)] : [], waiting: open ? PIS_ADMINS : '', state: p.status },
    requestColumn(open, false, p.decidedAt, p.at, now));
  });
  // Papers in Internal Review (ML Conference Cycle's view), people to confirm as having
  // invited them (the inviter; PIs and admins), events and series waiting to be
  // released (on whoever added the event or organises the series, who release them; PIs
  // and admins see them too), hackathon team requests.
  const [cycle, invites, events, series, hackathon] = await Promise.all([
    access.can(email, 'ml-cycle', 'view').then(function(ok){
      return ok ? Promise.all([all('boards'), db.collectionGroup('cards').get().then(function(x){ return x.docs; })]) : [[], []];
    }),
    full ? db.collection('members').where('invitedBy.status', '==', 'pending').get().then(function(x){ return x.docs; }) : q('members', 'invitedBy.email'),
    full ? db.collection('events').where('hidden', '==', true).get().then(function(x){ return x.docs; }) : q('events', 'createdBy'),
    full ? db.collection('eventSeries').where('hidden', '==', true).get().then(function(x){ return x.docs; })
      : db.collection('eventSeries').where('organisers', 'array-contains', email).get().then(function(x){ return x.docs; }),
    full ? all('hackathonJoins') : db.collection('hackathonJoins').doc(email).get().then(function(x){ return x.exists ? [x] : []; })
  ]);
  joins.forEach(function(d){
    const r = d.data(), inv = r.invitedBy && r.invitedBy.email;
    // Changes asked for (joinChanges): it waits on the applicant, not whoever decides it.
    const asked = r.status === 'open' && r.changes && r.changes.status === 'asked';
    add({ kind: 'join', ref: d.ref.path, title: 'Join BOLD: ' + (r.name || 'someone') + (r.role ? ' (' + r.role + ')' : ''), url: SITE_URL + 'join-requests.html#r=' + d.id,
      by: { name: r.name || '' }, on: asked ? [] : r.status === 'open' && inv ? [person(inv, r.invitedBy.name)] : r.decidedBy ? [person(r.decidedBy, r.decidedByName)] : [],
      waiting: r.status === 'open' && !inv && !asked ? PIS_ADMINS : '', state: asked ? 'changes asked' : r.status },
    requestColumn(r.status === 'open', asked, r.decidedAt, r.at, now));
  });
  groups.forEach(function(d){
    const r = d.data();
    add({ kind: 'group', ref: d.ref.path, title: 'Change group: ' + (r.name || r.email) + ', ' + (GROUP_LABELS[r.from] || r.from || '?') + ' → ' + (GROUP_LABELS[r.to] || r.to || '?'),
      url: SITE_URL + 'join-requests.html#g=' + d.id, by: person(r.email, r.name),
      on: r.decidedBy ? [person(r.decidedBy, r.decidedByName)] : [],
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
    add({ kind: 'agent', ref: d.ref.path, numKey: d.ref.path + '/act/' + (r.at || 0), title: 'Let an agent act: ' + (x.label || 'a token'), url: SITE_URL + 'join-requests.html#agents',
      by: person(x.email), on: r.decidedBy ? [person(r.decidedBy, r.decidedByName)] : [], waiting: r.status === 'open' ? PIS_ADMINS : '', state: r.status },
    requestColumn(r.status === 'open', false, r.decidedAt, r.at, now));
  });
  const venues = {};
  cycle[0].forEach(function(d){ venues[d.id] = d.data(); });
  cycle[1].forEach(function(d){
    const c = d.data(), boardId = d.ref.parent.parent && d.ref.parent.parent.id, v = venues[boardId];
    if (!v || (v.status || 'approved') === 'pending' || c.outcome) return;
    const base = { kind: 'review', ref: d.ref.path, title: 'Internal Review: ' + (c.title || 'a paper') + (v.label ? ' (' + v.label + ')' : ''), url: cardUrl(boardId, d.id),
      by: person(c.submittedBy && c.submittedBy.email, c.submittedBy && c.submittedBy.name) };
    // Its reviewers who haven't approved it yet (the abstract: both, until it's approved).
    const own = { junior: c.jrReviewState, senior: c.srReviewState };
    const left = ['junior', 'senior'].filter(function(k){ return c.reviewers && c.reviewers[k] && (c.status === 'abstract' || own[k] !== 'approved'); })
      .map(function(k){ return c.reviewers[k]; });
    if (c.status === 'abstract' || c.status === 'paper'){
      const states = c.status === 'abstract' ? [c.abstractReviewState || 'in_review'] : [c.jrReviewState, c.srReviewState];
      if (states.indexOf('changes_requested') >= 0) add(Object.assign(base, { on: [base.by], state: 'changes requested' }), { column: 'doing', since: c.updatedAt || c.createdAt || 0 });
      else if (!states.every(function(x){ return x === 'approved'; })){
        add(Object.assign(base, { on: left.map(function(e){ return person(e); }), waiting: left.length ? '' : 'a reviewer', state: 'in review' }), { column: 'review', since: c.updatedAt || c.createdAt || 0 });
      }
    }
  });
  invites.forEach(function(d){
    const m = d.data(), inv = m.invitedBy;
    if (!inv || inv.status !== 'pending') return;
    add({ kind: 'invite', ref: d.ref.path, numKey: d.ref.path + '/invite/' + (inv.askedAt || 0), title: 'Confirm you invited ' + (m.name || d.id), url: SITE_URL + 'join-requests.html#invited',
      by: person(d.id, m.name), on: [person(inv.email, inv.name)], state: 'open' }, { column: 'review', since: inv.askedAt || 0 });
  });
  events.forEach(function(d){
    const e = d.data();
    if (e.hidden !== true || e.series) return;   // a series' dates are released with it
    add({ kind: 'event', ref: d.ref.path, title: 'Release the event: ' + (e.title || d.id), url: SITE_URL + 'event.html?event=' + encodeURIComponent(d.id),
      by: person(e.createdBy), on: e.createdBy ? [person(e.createdBy)] : [], waiting: e.createdBy ? '' : PIS_ADMINS, state: 'hidden' }, { column: 'review', since: e.createdAt || 0 });
  });
  series.forEach(function(d){
    const e = d.data();
    if (e.hidden !== true) return;
    const orgs = (e.organisers || []).map(function(o){ return person(o); });
    add({ kind: 'event', ref: d.ref.path, title: 'Release the event series: ' + (e.title || d.id), url: SITE_URL + 'series.html?series=' + encodeURIComponent(d.id),
      by: person(e.createdBy), on: orgs, waiting: orgs.length ? '' : PIS_ADMINS, state: 'hidden' }, { column: 'review', since: e.createdAt || 0 });
  });
  hackathon.forEach(function(d){
    const h = d.data();
    if (h.status !== 'requested') return;
    add({ kind: 'hackathon', ref: d.ref.path, numKey: d.ref.path + '/ask/' + (h.requestedAt || 0), title: 'Join the hackathon team on GitHub' + (h.github ? ' (' + h.github + ')' : ''), url: SITE_URL + 'events.html',
      by: person(h.email || d.id, h.name), on: [], waiting: PIS_ADMINS, state: 'requested' }, { column: 'review', since: h.requestedAt || 0 });
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

// Numbered when made: a board's card, an event series waiting to be released, an agent's
// request to act, a request to join the hackathon team (requests made through a callable
// are numbered there, so their Slack message has it).
// A new card on a project's board: numbered, and posted in the project's Slack channel
// (its workspace's slackChannel), unless whoever added it unticked that (announce: false,
// in the page's popup) or the project has no channel.
exports.onWorkCardAdded = onDocumentCreated({ document: 'projectWorkspaces/{pid}/work/{id}', secrets: [SLACK_BOT_TOKEN] }, async function(event){
  const tag = await numberTag(event.data.ref.path);
  const c = event.data.data() || {};
  if (c.announce === false) return;
  const ws = (await db.collection('projectWorkspaces').doc(event.params.pid).get()).data() || {};
  const name = String(ws.slackChannel || '').replace(/^#/, '');
  // No channel, or making it was skipped when the project was registered (`skipped`;
  // `slackSkipped` is something else: who chose not to join it).
  if (!name || (ws.skipped || []).indexOf('channel') >= 0) return;
  try {
    const token = SLACK_BOT_TOKEN.value();
    const channel = await slackChannelId(token, name);
    if (!channel) { logger.warn('Posting a new card: the bot can’t see the project’s channel', { channel: name }); return; }
    const url = projectPageUrl(ws.cardId || event.params.pid, ws.boardId) + '&tab=work&card=' + encodeURIComponent(event.params.id);
    const COL = { todo: 'To do', doing: 'In progress', review: 'Waiting for review', done: 'Done' };
    const who = (c.by && (c.by.name || c.by.email)) || 'Someone';
    const on = (c.assignees || []).map((a) => slackText(a.name || a.email)).join(', ');
    const text = '🗂️ ' + tag + slackText(who) + ' added a card to the board: ' + linkedTitle(slackText(c.title || 'a card'), url) +
      ' (' + [c.kind ? c.kind.charAt(0).toUpperCase() + c.kind.slice(1) : '', COL[c.column] || '', on ? 'on it: ' + on : ''].filter(Boolean).join(' · ') + ')';
    const posted = await postInChannel(token, 'card-added', channel, name, { text, unfurl_links: false });
    if (!posted.ok) logger.warn('Posting a new card failed', { channel: name, error: posted.error });
  } catch (err){ logger.warn('Posting a new card failed', { channel: name, error: String(err && err.message || err) }); }
});
// A card moved to Done (project-work.js, the agents' work tool) tells whoever raised it, in a
// Slack DM through pilotSlack ('card-done'), unless they moved it themselves or whoever moved
// it unticked that (doneQuiet). A card linked to a pull request or proposal that's only shown
// in Done (projectWork) isn't moved, so it doesn't.
function cardDoneText(c, tag, url){
  const who = (c.updatedBy && c.updatedByName) || c.updatedBy || 'Someone';
  return '✅ ' + tag + linkedTitle(slackText(c.title || 'A card'), url) + ', which you raised, is done: ' + slackText(who) + ' moved it to Done.';
}
exports.onWorkCardDone = onDocumentUpdated({ document: 'projectWorkspaces/{pid}/work/{id}', secrets: [SLACK_BOT_TOKEN] }, async function(event){
  const before = event.data.before.data() || {}, c = event.data.after.data() || {};
  const raiser = String((c.by && c.by.email) || '').toLowerCase();
  if (c.column !== 'done' || before.column === 'done' || c.doneQuiet === true || !raiser || raiser === String(c.updatedBy || '').toLowerCase()) return;
  const ws = (await db.collection('projectWorkspaces').doc(event.params.pid).get()).data() || {};
  const url = projectPageUrl(ws.cardId || event.params.pid, ws.boardId) + '&tab=work&card=' + encodeURIComponent(event.params.id);
  const mover = (await db.collection('people').where('email', '==', String(c.updatedBy || '').toLowerCase()).limit(1).get()).docs[0];
  const text = cardDoneText(Object.assign({}, c, { updatedByName: mover && mover.data().name }), await numberTag(event.data.after.ref.path), url);
  try { await pilotSlack(SLACK_BOT_TOKEN.value(), 'card-done', 'Telling who raised a card it’s done', { emails: [raiser], text }); }
  catch (err){ logger.warn('Telling who raised a card it’s done failed', { error: String(err && err.message || err) }); }
});

exports.onSeriesAdded = onDocumentCreated('eventSeries/{id}', async function(event){
  const d = event.data && event.data.data();
  if (d && d.hidden === true) await numberFor(event.data.ref.path);
});
exports.onActRequested = onDocumentWritten('apiTokens/{id}', async function(event){
  const r = event.data.after.exists && event.data.after.data().actRequest;
  if (r && r.status === 'open') await numberFor('apiTokens/' + event.params.id + '/act/' + (r.at || 0));
});
exports.onHackathonAsked = onDocumentWritten('hackathonJoins/{id}', async function(event){
  const h = event.data.after.exists && event.data.after.data();
  if (h && h.status === 'requested') await numberFor('hackathonJoins/' + event.params.id + '/ask/' + (h.requestedAt || 0));
});

// A person as BOLD.OS names them (workNames): (email, fallback) → { name, email, id (their page's Slack id) }.
function workPerson(known){
  return function(e, fallback){
    e = String(e || '').toLowerCase();
    return Object.assign({ name: known.names[e] || fallback || e.split('@')[0] || 'someone', email: e }, known.ids[e] ? { id: known.ids[e] } : {});
  };
}

// Pure: what waits on someone (requestWork, contentWork) → what waits on `email` (forYou:
// they're on it, or it's for a PI or admin and they're one, but not one they asked) and what
// they asked that waits on someone else (byYou). Done ones are left out; oldest first.
function splitRequests(items, email, full){
  email = String(email || '').toLowerCase();
  const forYou = [], byYou = [];
  items.forEach(function(x){
    if (x.column === 'done') return;
    const mine = !!email && String((x.by && x.by.email) || '').toLowerCase() === email;
    const on = (x.on || []).some(function(p){ return String(p.email || '').toLowerCase() === email; });
    if (on || (full && !mine && x.waiting === PIS_ADMINS)) forYou.push(x);
    else if (mine) byYou.push(x);
  });
  const oldest = function(a, b){ return (a.since || 0) - (b.since || 0); };
  return { forYou: forYou.sort(oldest), byYou: byYou.sort(oldest) };
}

// Your requests (requests.html, the account menu's Requests; pages/requests.js): everything on BOLD.OS waiting on
// the caller to answer, and what they asked that waits on someone else, as BOLD OS's board
// sees it (requestWork, contentWork). → { forYou, byYou: [{ kind, num, title, url, by, on, waiting, state, since, column }] }
// Branches (#177; bold.js, the Version pill): every open proposal on a page you can see (its View
// level: the pill is where proposals are seen, 2026-11-05),
// newest first, each { ref (its path), num, title, url (its page), by, since }, and for one
// that changes Who can see what, `pages`: the table it would make.
exports.branches = onCall(
  { timeoutSeconds: 60 },
  async (request) => {
    const email = callerEmail(request);
    // Branches of the site only (functions/branches.js): every proposal is one since 2026-11-11.
    const open = (await contentWork(email, workPerson(await workNames()), 'view')).filter((x) => x.state === 'open' && /^branches\//.test(x.ref));
    const nums = await numbersOf(open.map((x) => x.ref));
    const out = [];
    for (const x of open){
      const b = { ref: x.ref, num: nums[x.ref] || 0, title: x.title, url: String(x.url || '').replace(/#.*$/, ''), by: (x.by && x.by.name) || '', since: x.since || 0, targets: x.targets || [], mine: !!x.mine };
      try { const pages = await proposedTable(x.ref); if (pages) b.pages = pages; }
      catch (err) { logger.warn('A branch’s table couldn’t be worked out', { ref: x.ref, error: String(err && err.message || err) }); }
      out.push(b);
    }
    return { branches: out.sort((a, b) => b.since - a.since) };
  }
);

exports.myRequests = onCall(
  { timeoutSeconds: 60 },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'profile', 'view');   // Who can see what
    const person = workPerson(await workNames()), full = await isFullWrite(email);
    const [content, requests] = await Promise.all([contentWork(email, person), requestWork(email, full, person)]);
    const split = splitRequests(content.concat(requests), email, full);
    const all = split.forYou.concat(split.byYou);
    const nums = await numbersOf(all.map(function(x){ return x.numKey || x.ref; }));
    const name = function(p){ return { name: (p && p.name) || '' }; };
    const out = function(x){
      return { kind: x.kind, num: nums[x.numKey || x.ref] || 0, title: x.title, url: x.url, by: name(x.by), on: (x.on || []).map(name),
        waiting: x.waiting || '', state: x.state || '', since: x.since || 0, column: x.column, role: workRole(x) };
    };
    return { forYou: split.forYou.map(out), byYou: split.byYou.map(out) };
  }
);

exports.projectWork = onCall(
  { secrets: [GITHUB_APP], timeoutSeconds: 60 },
  async (request) => {
    const email = callerEmail(request);
    await access.requireAccess(email, 'projects', 'list');   // Who can see what
    const pid = String((request.data || {}).project || '');
    if (!validSlug(pid)) throw new HttpsError('invalid-argument', 'No project given.');
    await requireSeesProject(email, pid);
    const ws = (await db.collection('projectWorkspaces').doc(pid).get()).data();
    if (!ws || !ws.work || !ws.work.on) throw new HttpsError('failed-precondition', 'This project has no work board.');
    const person = workPerson(await workNames());
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
    // Each person on an item tagged with what they do there.
    items = items.map(function(x){ const role = workRole(x); return Object.assign({}, x, { role, on: (x.on || []).map(function(p){ return Object.assign({ role }, p); }) }); });
    // Their numbers (#123), and the board's own cards'; anything made before numbers, or
    // missed, is numbered now (a few at a time, so a first look stays quick).
    const cardPaths = (await db.collection('projectWorkspaces').doc(pid).collection('work').get()).docs.map(function(d){ return d.ref.path; });
    const keys = items.filter(function(x){ return x.source !== 'github'; }).map(function(x){ return x.numKey || x.ref; }).concat(cardPaths);
    const nums = await numbersOf(keys);
    let numbered = 0;
    for (const k of keys) if (!nums[k] && numbered++ < 40) nums[k] = await numberFor(k);
    items.forEach(function(x){ if (x.source !== 'github' && nums[x.numKey || x.ref]) x.num = nums[x.numKey || x.ref]; delete x.numKey; });
    const cardNumbers = {};
    cardPaths.forEach(function(p){ if (nums[p]) cardNumbers[p.split('/').pop()] = nums[p]; });
    return { items, errors, repos, at: gh.at, cardNumbers };
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

// Whether `email` is a PI or admin: not while they view the site as a group (View as).
async function isFullWrite(email){
  return viewingAs(email) ? false : realFullWrite(email);
}
async function realFullWrite(email){
  email = String(email || '').toLowerCase();
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
// organisation, with no approval, whatever their group (read on every repository); BOLD-internal and
// above also go in the bold-internal team (write on every repository), everyone else writes to their
// projects' repositories alone, through each one's team (syncWorkspace). 'outside' is a link from before. The
// GitHub account is read from Firebase Auth, never from the client, so nobody
// can have someone else's account invited. GitHub emails the invitation; the
// person is "pending" until they accept it, then "active". Kept in
// githubLinks/{email}: { email, name, github (login), githubId, status:
// 'active' | 'pending' | 'outside' | 'failed', error, linkedAt, updatedAt } (no client
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
    // Everyone joins the org (read on everything); BOLD-internal and above write to everything.
    const r = await joinOrg(login, gh.uid);
    if (r.status !== 'failed' && await writesEverywhere(email)) await setInternalWrite(login.toLowerCase(), true).catch((err) => logger.warn('Adding to bold-internal failed', { error: String(err.message) }));
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

// A member's group crossing BOLD-internal (Who is BOLD): their linked GitHub account goes in or out of
// the bold-internal team (write on every repository). They stay in the org, reading everything.
exports.onMemberGithub = onDocumentWritten(
  { document: 'members/{email}', secrets: [GOOGLE_OAUTH, GITHUB_APP], timeoutSeconds: 300 },
  async function(event){
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    const high = (m) => accessLib.rank(groupOf(m)) >= accessLib.rank('internal');
    if (!after || high(before) === high(after)) return;
    const email = event.params.email;
    const ref = db.collection('githubLinks').doc(email);
    const link = (await ref.get()).data();
    if (!link || !link.github) return;
    if (link.status === 'outside'){
      const r = await joinOrg(link.github, link.githubId);
      await ref.set({ status: r.status, error: r.error, updatedAt: Date.now() }, { merge: true });
      if (r.status === 'failed') return;
    }
    await setInternalWrite(String(link.github).toLowerCase(), high(after));
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
// Slack accounts count (onlySlackSignUps, isSignedIn()).
// With a Google account linked, they choose which of their own addresses get them (#178):
// { inviteTo: [address] }, one or more of `choices` (their BOLD.OS email, their Slack one if
// it's another, the Google account: each proven theirs, never one typed in), kept as
// googleLinks inviteTo; none chosen, the Google account. A new Google account starts again.
// → { link: { google, inviteTo, choices } | null }.
// Pure: what they may choose from, and what they chose, made valid ([] for the default).
function inviteChoices(email, slackEmail, google){
  const out = [];
  [email, slackEmail, google].forEach(function(a){ a = String(a || '').toLowerCase(); if (a && out.indexOf(a) < 0) out.push(a); });
  return out;
}
function validInviteTo(list, choices){
  return Array.isArray(list) ? list.map(function(a){ return String(a || '').toLowerCase(); }).filter(function(a, i, all){ return choices.indexOf(a) >= 0 && all.indexOf(a) === i; }) : [];
}
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
    const person = (await db.collection('people').where('email', '==', email).limit(1).get()).docs[0];
    const choices = google ? inviteChoices(email, person && person.data().slackEmail, google) : [];
    let moved = false, inviteTo = prev && prev.google === google ? validInviteTo(prev.inviteTo, choices) : [];
    if ((prev && prev.google || '') !== google){
      if (google) await ref.set({ email, google, linkedAt: Date.now() });
      else await ref.delete();
      moved = true;
    } else if (google && request.data && request.data.inviteTo !== undefined){
      const want = validInviteTo(request.data.inviteTo, choices);
      if (!want.length) throw new HttpsError('invalid-argument', 'Choose at least one address.');
      // Only the Google account is the default: kept as [] so a new default follows.
      const keep = want.length === 1 && want[0] === google ? [] : want;
      if (JSON.stringify(keep) !== JSON.stringify(inviteTo)){
        await ref.set({ inviteTo: keep.length ? keep : FieldValue.delete() }, { merge: true });
        inviteTo = keep; moved = true;
      }
    }
    if (moved){
      // Their projects: invitations and files move to the new addresses.
      const mine = await db.collection('projectWorkspaces').where('members', 'array-contains', email).get();
      for (const d of mine.docs) await syncWorkspace(d.id);
      // And the study meetings they're in.
      const studies = await db.collection('studies').where('everyone', 'array-contains', email).get();
      for (const d of studies.docs) await syncStudyMeeting(d.id);
    }
    return { link: google ? { google, inviteTo: inviteTo.length ? inviteTo : [google], choices } : null };
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
        summary, description, attendees: attendees([]), guestsCanModify: true   // every guest can change it, as a project's
      }, eventConference(s.meeting, 'bold-study-' + crypto.randomBytes(6).toString('hex')), eventTimes(s.meeting)));
      Object.assign(patch, { eventId: ev.id, eventLink: ev.htmlLink, meetUrl: s.meeting.link || ev.hangoutLink || '', eventMeeting: s.meeting, eventStart: seriesStart(ev) });
    } else if (!want && s.eventId){
      await googleFetch('DELETE', CAL + '/' + s.eventId + '?sendUpdates=all').catch(function(err){ if (err.status !== 410 && err.status !== 404) throw err; });
      ['eventId', 'eventLink', 'meetUrl', 'eventMeeting', 'eventPausedAt', 'eventStart'].forEach(function(k){ patch[k] = FieldValue.delete(); });
    } else if (s.eventId){
      const ev = await googleFetch('GET', CAL + '/' + s.eventId);
      const change = {}, timesChanged = !sameMeetingTimes(s.eventMeeting, s.meeting);
      const want = attendees(ev.attendees);
      if (JSON.stringify(want.map(function(a){ return a.email; })) !== JSON.stringify((ev.attendees || []).map(function(a){ return a.email; }))) change.attendees = want;
      if (ev.summary !== summary) change.summary = summary;
      if (ev.description !== description) change.description = description;
      if (!sameMeetingTimes(s.eventMeeting, s.meeting)) Object.assign(change, eventTimes(s.meeting, s.pausedAt));
      else if ((s.eventMeeting.until || '') !== (s.meeting.until || '') || (s.pausedAt || 0) !== (s.eventPausedAt || 0)) change.recurrence = meetingRecurrence(s.meeting, s.pausedAt);
      if (ev.guestsCanModify !== true) change.guestsCanModify = true;
      Object.assign(change, conferenceChange(ev, s.meeting, 'bold-study-' + crypto.randomBytes(6).toString('hex')));
      let now = ev;
      if (Object.keys(change).length){
        now = await googleFetch('PATCH', CAL + '/' + s.eventId + '?conferenceDataVersion=1&sendUpdates=' + calendarUpdates(change), change) || ev;
        patch.eventMeeting = s.meeting; patch.eventPausedAt = s.pausedAt || FieldValue.delete(); patch.eventStart = seriesStart(now);
      } else if (!s.eventStart && seriesStart(ev)) patch.eventStart = seriesStart(ev);
      const url = s.meeting.link || now.hangoutLink || '';
      if (url !== (s.meetUrl || '')) patch.meetUrl = url;
      if (!s.pausedAt){
        const moves = await syncMoves(s.eventId, s.meeting, s.meetingMoved, timesChanged ? {} : s.eventMoved);
        if (moves) patch.eventMoved = moves; else if (timesChanged && s.eventMoved) patch.eventMoved = FieldValue.delete();
      }
    }
    patch.error = FieldValue.delete(); patch.calendarLimitAt = FieldValue.delete();
  } catch (err){
    logger.error('Setting up a study meeting failed', { error: String(err && err.message || err) });
    if (isCalendarLimit(err)) { patch.error = CALENDAR_LIMIT_MSG; patch.calendarLimitAt = Date.now(); }
    else patch.error = err instanceof HttpsError ? err.message : 'Couldn’t set up the meeting in Google Calendar.';
  }
  await ref.set(patch, { merge: true });
  return (await ref.get()).data();
}

// ---------- Free/busy calendars and suggested meeting times (#323, 2026-11-11) ----------
// Each person may give free/busy calendar links (profile › Linked accounts), several (Google and Outlook,
// say; up to 5): busyFeeds/{email} { feeds: [{ id, url, name (the calendar's own), at, checkedAt }] } (busy.feedsOf also reads the one
// { url } of before), server only (Google's public address has their email in it). Only when they're busy
// is read from them (functions/busy.js), never what, and nothing of it is kept.
// busyFeed: { action: 'get' } → { feeds: [{ id, url, at }] }; 'set' { url } adds one → { feeds, url, busy: how
// many busy times in the next 4 weeks } (read once, so a link that doesn't work isn't saved); 'clear' { id }
// removes one (no id: all).
const busy = require('./busy');
exports.busyFeed = onCall({ timeoutSeconds: 30 }, async (request) => {
  const email = callerEmail(request), data = request.data || {};
  const ref = db.collection('busyFeeds').doc(email);
  const shown = (fs) => fs.map((f) => ({ id: f.id, url: f.url, name: f.name || '', at: f.at || 0 }));
  const feeds = busy.feedsOf((await ref.get()).data());
  // url, at: the first, as the profile read it before there could be several (until that page is gone).
  if (data.action === 'get') return Object.assign({ feeds: shown(feeds) }, feeds[0] ? { url: feeds[0].url, at: feeds[0].at || 0 } : {});
  if (data.action === 'clear'){
    const left = data.id ? feeds.filter((f) => f.id !== String(data.id)) : [];
    if (left.length) await ref.set({ feeds: left }); else await ref.delete();
    return { feeds: shown(left) };
  }
  if (data.action !== 'set') throw new HttpsError('invalid-argument', 'Unknown action.');
  const url = busy.okFeedUrl(data.url);
  if (!url) throw new HttpsError('invalid-argument', 'Give a Google, Outlook or iCloud calendar (iCal) address, starting with https:// or webcal://.');
  if (feeds.some((f) => f.url === url)) throw new HttpsError('already-exists', 'That calendar is added already.');
  if (feeds.length >= busy.MAX_FEEDS) throw new HttpsError('resource-exhausted', 'Up to ' + busy.MAX_FEEDS + ' calendars: remove one first.');
  let text;
  try { text = await busy.fetchIcs(url); } catch (err){ throw new HttpsError('failed-precondition', err.message); }
  const now = Date.now(), n = busy.busyFrom(text, now, now + 28 * 86400000).length;
  const all = feeds.concat({ id: Math.random().toString(36).slice(2, 10), url, name: busy.calendarName(text), at: now, checkedAt: now });
  await ref.set({ feeds: all });
  return { feeds: shown(all), url, busy: n };
});

// meetingTimes: { id, board?, minutes, every } → { slots: [{ day, time, free, of, clash: [{ name, times }] }],
// fromCalendar: [names], boldOnly: [names], failed: [names] }. Whoever may set the project's meeting.
// Counted: the project's Authors (its People get the invitation, and aren't counted), each from their
// free/busy calendar if they gave one, and from the meetings BOLD.OS knows they have: their other
// projects', their studies' and the series they joined. Over its next 4 dates, weekdays 09:00–18:00 London (busy.suggest).
// One person's busy times, now → to: their free/busy calendars (busy in any is busy) and the meetings BOLD.OS
// knows they have (their projects', but `skipPid`'s, their studies', the series they joined) →
// { busy: merged [[start, end]], feeds: how many calendars, read: how many read, failed: how many not }.
async function personBusy(a, now, to, skipPid){
  const list = [];
  const [feed, wsSnap, stSnap, seSnap] = await Promise.all([
    db.collection('busyFeeds').doc(a.email).get(),
    db.collection('projectWorkspaces').where('members', 'array-contains', a.email).get(),
    db.collection('studies').where('everyone', 'array-contains', a.email).get(),
    db.collection('eventSeries').where('joined', 'array-contains', a.email).get()
  ]);
  wsSnap.docs.concat(stSnap.docs, seSnap.docs).forEach(function(d){
    const w = d.data();
    if (d.ref.parent.id === 'projectWorkspaces' && d.id === skipPid) return;
    if (!w.meeting || w.pausedAt || w.completedAt) return;
    busy.meetingBusy(w.meeting, now, to, String(w.eventStart || '').slice(0, 10), w.meetingMoved).forEach(function(x){ list.push(x); });
  });
  const feeds = busy.feedsOf(feed.data());
  let read = 0, failed = 0;
  for (const f of feeds){
    try { busy.busyFrom(await busy.fetchIcs(f.url), now, to).forEach(function(x){ list.push(x); }); read++; }
    catch (err){ failed++; logger.warn('A free/busy calendar couldn’t be read', { error: String(err && err.message || err) }); }
  }
  return { busy: busy.merge(list), feeds: feeds.length, read, failed };
}

exports.meetingTimes = onCall({ timeoutSeconds: 60 }, async (request) => {
  const email = callerEmail(request), data = request.data || {};
  const id = String(data.id || ''), boardId = data.board ? String(data.board) : null;
  if (!validSlug(id) || (boardId && !validSlug(boardId))) throw new HttpsError('invalid-argument', 'No project given.');
  const cardSnap = await cardRefFor(id, boardId).get();
  if (!cardSnap.exists) throw new HttpsError('not-found', 'That project isn’t there any more.');
  const card = cardSnap.data(), pid = projectIdOf(card, id);
  await requireSeesProject(email, pid);
  if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project’s submitter, authors, PIs and admins can do this.');
  const minutes = Number(data.minutes), every = Number(data.every);
  if (!(minutes >= 15 && minutes <= 240) || [1, 2, 3, 4].indexOf(every) < 0) throw new HttpsError('invalid-argument', 'Choose how long it lasts and how often.');
  // The Authors (or, with none, whoever registered it), once each.
  const seen = {}, authors = (card.authors && card.authors.length ? card.authors : [card.submittedBy || {}])
    .map(function(a){ return { email: String(a && a.email || '').trim().toLowerCase(), name: String(a && (a.name || a.email) || '') }; })
    .filter(function(a){ if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email) || seen[a.email]) return false; seen[a.email] = 1; return true; })
    .slice(0, 30);
  if (!authors.length) throw new HttpsError('failed-precondition', 'Add the project’s authors first.');
  const now = Date.now(), to = now + (4 * every + 1) * 7 * 86400000;
  const fromCalendar = [], boldOnly = [], failed = [];
  const people = await Promise.all(authors.map(async function(a){
    const p = await personBusy(a, now, to, pid);
    if (p.read) fromCalendar.push(a.name);
    if (!p.feeds) boldOnly.push(a.name);
    if (p.failed) failed.push(a.name);
    return { name: a.name, busy: p.busy };
  }));
  const slots = busy.suggest({ people, minutes, every, today: todayIsoLondon() })
    .map(function(s){ return Object.assign(s, { of: people.length }); });
  return { slots, fromCalendar, boldOnly, failed };
});

// moveMeeting (the Calendar, 2026-11-11): a recurring meeting changed from the Calendar, dragged or edited, a
// project's, a supervision or an event series'. { kind: 'project' | 'study' | 'series', id (the project's card,
// the student's email, the series), board?, scope: 'series' (every date: { day, time, minutes }) or 'once' (one
// date, `date`, moved to { date, time, minutes }, or cancelled: { cancelled: true }: meeting-moves.js) } → { ok, error? }.
// Who may: as on each one's own page: a project's submitter, authors, PIs and admins; the student and the people
// in their studies; a series' organisers, PIs and admins. Not while paused. Google emails the guests the change.
exports.moveMeeting = onCall({ timeoutSeconds: 120, secrets: [GOOGLE_OAUTH, GITHUB_APP, SLACK_BOT_TOKEN] }, async (request) => {
  const email = callerEmail(request), data = request.data || {};
  const kind = String(data.kind || ''), id = String(data.id || ''), scope = data.scope === 'once' ? 'once' : 'series';
  let ref, doc, sync;
  if (kind === 'project') {
    const boardId = data.board ? String(data.board) : null;
    if (!validSlug(id) || (boardId && !validSlug(boardId))) throw new HttpsError('invalid-argument', 'No project given.');
    const cardSnap = await cardRefFor(id, boardId).get();
    if (!cardSnap.exists) throw new HttpsError('not-found', 'That project isn’t there any more.');
    const pid = projectIdOf(cardSnap.data(), id);
    await requireSeesProject(email, pid);
    if (!(await canEditCard(email, cardSnap.data()))) throw new HttpsError('permission-denied', 'Only the project’s submitter, authors, PIs and admins can change its meeting.');
    ref = db.collection('projectWorkspaces').doc(pid);
    sync = (meeting) => syncWorkspace(pid, meeting ? { meeting } : {});
  } else if (kind === 'study') {
    ref = db.collection('studies').doc(id.toLowerCase());
    const s = (await ref.get()).data();
    if (!s) throw new HttpsError('not-found', 'That meeting isn’t there any more.');
    const involved = [ref.id].concat(s.everyone || [], (s.people || []).map((p) => p.email)).map((e) => String(e || '').toLowerCase());
    if (involved.indexOf(email) < 0 && !(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only the student and the people in their studies can change their meeting.');
    sync = () => syncStudyMeeting(ref.id);
  } else if (kind === 'series') {
    if (!validSlug(id)) throw new HttpsError('invalid-argument', 'No meeting given.');
    ref = db.collection('eventSeries').doc(id);
    const x = (await ref.get()).data();
    if (!x) throw new HttpsError('not-found', 'That meeting isn’t there any more.');
    if ((x.organisers || []).map((e) => String(e).toLowerCase()).indexOf(email) < 0 && !(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only its organisers, PIs and admins can change it.');
    sync = () => labSeries.syncSeries(id);
  } else throw new HttpsError('invalid-argument', 'Which meeting?');
  doc = (await ref.get()).data() || {};
  if (!doc.meeting) throw new HttpsError('failed-precondition', 'It has no meeting.');
  if (doc.pausedAt) throw new HttpsError('failed-precondition', 'It’s paused: resume it first.');
  const to = data.to || {};
  let out;
  if (scope === 'series') {
    const meeting = normalizeMeeting(Object.assign({}, doc.meeting, { day: to.day || doc.meeting.day, time: to.time || doc.meeting.time, minutes: to.minutes || doc.meeting.minutes }));
    if (meeting.error) throw new HttpsError('invalid-argument', meeting.error);
    // Every date at the new time: none stays moved.
    await ref.set({ meeting, meetingMoved: FieldValue.delete(), movedTo: FieldValue.delete() }, { merge: true });
    out = await sync(meeting);
  } else {
    const today = todayIsoLondon();
    // Cancelled ({ cancelled: true }), or moved.
    const move = to.cancelled ? (meetingMoves.isOccurrence(doc.meeting, doc.eventStart || '', String(data.date || '')) && String(data.date) >= today ? { cancelled: true } : { error: 'That isn’t one of its coming dates.' })
      : meetingMoves.normalizeMove(doc.meeting, doc.eventStart || '', String(data.date || ''), to, today);
    if (move.error) throw new HttpsError('invalid-argument', move.error);
    const moved = meetingMoves.withMove(doc.meetingMoved, doc.meeting, String(data.date), move, today);
    await ref.set({ meetingMoved: moved, movedTo: meetingMoves.movedTo(moved) }, { merge: true });
    out = await sync(null);
  }
  return { ok: true, error: (out && out.error) || '' };
});

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
      await sendEvent(token, { key: 'supervision-requests', emails: [student], headline: '🎓 ' + await numberTag(ref.path) + slackText(name) + ' asks to join your supervision meeting' +
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
    await sendEvent(token, { key: 'supervision-requests', emails: [r.email], headline: accept
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

// Pure: whether Slack user `u` is from another organisation, in a channel shared with ours (Slack
// Connect): their account or profile is another workspace's, or Slack calls them a stranger. They aren't
// BOLD.OS users (2026-11-05): off the roster (syncPeopleFromSlack, upsertPerson), and they can't sign up
// (onlySlackSignUps).
function slackExternal(u, team){
  if (!u || !team) return false;
  const p = u.profile || {};
  return !!u.is_stranger || !!(u.team_id && u.team_id !== team) || !!(p.team && p.team !== team);
}
// → { added, updated, removed }
async function syncPeopleFromSlack(token){
  const members = await slackMembers(token);
  // Only our workspace's people: users.list also has those from other workspaces in
  // channels shared with ours (upsertPerson).
  const auth = await slackAuthInfo(token), team = auth && auth.teamId;
  // Ours: not from another organisation in a channel shared with ours (Slack Connect), who aren't BOLD.OS users.
  const ours = u => !team || ((!u.team_id || u.team_id === team) && !slackExternal(u, team));
  const people = members
    .filter(u => !u.deleted && ours(u) && !u.is_bot && u.id !== 'USLACKBOT' && u.profile && u.profile.email)
    .map(u => ({ slackId: u.id, email: String(u.profile.email).toLowerCase(), name: u.profile.real_name || u.real_name || u.name || u.profile.email }));
  if (!people.length) {
    logger.error('syncPeople: Slack returned nobody with an email — is users:read.email granted? Nothing written.', { members: members.length });
    throw new Error('Slack returned nobody with an email (is users:read.email granted?)');
  }
  const accounts = await allAccountEmails();
  for (let i = 0; i < people.length; i++) people[i] = withAccountEmail(people[i], accounts[people[i].slackId]);
  const gone = members.filter(u => u.deleted || !ours(u)).map(u => u.id);
  const existing = await db.collection('people').get();
  const current = {};
  existing.docs.forEach(d => { current[d.id] = d.data(); });

  const writes = [];
  people.forEach(p => {
    const was = current[p.slackId];
    const slackEmail = typeof p.slackEmail === 'string' ? p.slackEmail : '';
    if (!was || was.name !== p.name || was.email !== p.email || (was.slackEmail || '') !== slackEmail) writes.push({ id: p.slackId, data: p, added: !was });
  });
  // On the roster but not on Slack's list at all (someone from elsewhere, out of every shared channel):
  // gone too, unless Slack's list looks short (then nobody is removed this way, and it's logged).
  const listed = new Set(members.map(u => u.id));
  const missing = existing.docs.map(d => d.id).filter(id => !listed.has(id) && gone.indexOf(id) < 0);
  if (members.length >= existing.size * 0.8) gone.push(...missing);
  else if (missing.length) logger.warn('syncPeople: Slack’s list looks short, not removing those missing from it', { members: members.length, roster: existing.size, missing: missing.length });
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

// Sends a plain-text email from the lab's Google account (GOOGLE_OAUTH, gmail.send). → '' or why it didn't go.
async function gmailSend(to, subject, body, what){
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + await googleToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: mimeMessage(to, subject, body) }),
    });
    if (res.ok) return '';
    const j = await res.json().catch(() => ({}));
    logger.error('Gmail refused', { what, status: res.status, error: j.error && j.error.message });
    return res.status === 403 ? 'The lab’s Google account can’t send email yet (gmail.send): reconnect it.' : 'Gmail refused it (' + res.status + ').';
  } catch (e) {
    if (!(e instanceof HttpsError)) logger.error('Sending email threw', { what, error: String(e) });
    return e instanceof HttpsError ? e.message : 'Couldn’t reach Gmail.';
  }
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
  const error = mail.error || await gmailSend(r.email, mail.subject, mail.body, 'sendWelcome ' + id);
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
    // Asked through an invitation to a project (projectInvite): they're put on it once approved.
    if (validSlug(String(d.invite || ''))) r.projectInvite = String(d.invite);
    await db.collection('joinRequests').add(Object.assign(r, { status: 'open', at: Date.now() }));
    return { ok: true };
  }
);

const joinPageUrl = () => SITE_URL + 'join-requests.html';

// ---------- Inviting someone to a project (#148, 2026-11-02) ----------
// A project's editors (its submitter, authors, PIs and admins: canEditCard) invite someone
// by email: projectInvites/{id} { pid, cardId, board, title, email, name, by, byName, status:
// 'open' | 'accepted' | 'declined' | 'withdrawn', at, decidedAt, emailed }. Someone on BOLD.OS
// gets a Slack message and the project page shows them Join / Decline; someone who isn't
// gets an email from the lab's account to ask to join BOLD (join.html?invite=<id>), naming
// whoever invited them, and is put on the project once their request is approved
// (decideJoinRequest). Accepting makes them one of its people (its workspace's `joined`), so
// they see that project in full whatever their group (seesProject; the rules hold to the same).
// Pure: may `who` ({ email, editor }) do `action` to invite `inv`? → '' or why not.
function inviteRefusal(inv, action, who){
  if (!inv) return 'That invitation isn’t there.';
  const mine = String(inv.email || '').toLowerCase() === String(who.email || '').toLowerCase();
  if (action === 'accept' || action === 'decline') { if (!mine) return 'It’s someone else’s invitation.'; }
  else if (action === 'withdraw') { if (!(who.editor || String(inv.by || '').toLowerCase() === String(who.email || '').toLowerCase())) return 'Only whoever invited them, or the project’s editors, withdraw it.'; }
  else return 'Unknown action.';
  if (inv.status !== 'open' && !(action === 'withdraw' && inv.status === 'asked')) return 'It’s already been ' + inv.status + '.';
  return '';
}
// Pure: the address of an invitation, on the project page.
function inviteUrl(inv, id){ return projectPageUrl(inv.cardId, inv.board) + '&invite=' + encodeURIComponent(id); }
// Joins email to the project pid (its workspace's `joined`) and, if it has a channel and they're
// on Slack, invites them to it. → { slack } (or {}).
async function joinProjectAs(email, pid, card, slackToo){
  await db.collection('projectWorkspaces').doc(pid).set({ joined: FieldValue.arrayUnion(email) }, { merge: true });
  await syncWorkspace(pid);
  if (!slackToo || !card || !card.slackChannel) return {};
  try { return { slack: await inviteToProjectChannel(SLACK_BOT_TOKEN.value(), email, normalizeProjectChannel(card.slackChannel).name) }; }
  catch (err){ return { slack: { error: err.message || 'Couldn’t add them to the Slack channel.' } }; }
}
async function sendLabEmail(to, subject, body){
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + await googleToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: mimeMessage(to, subject, body) }),
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'The lab’s Google account can’t send email yet (gmail.send): reconnect it.' : 'Gmail refused it (' + res.status + ').');
}
// - 'invite' { id, board, email, name }: the project's editors → { id, emailed }.
// - 'list' { id, board }: its editors → { invites: [...] } (open ones first).
// - 'accept' | 'decline' { invite }: the invitee; accept → the workspace, as joining does.
// - 'withdraw' { invite }: whoever invited them, or an editor.
// - 'peek' { invite }: anyone, signed in or not (join.html): { title, inviter: { id, name } } of an open one.
// - 'ask' { id, board }: anyone signed in who isn't on it, below Projects' View (BOLD-associate,
//   PAN-BOLD, from Projects' titles): asks to join: projectInvites/{id} with status 'asked' (by: the
//   asker, who can withdraw it); its owner (who registered it) gets a Slack message.
// - 'admit' { invite }: the project's editors accept an ask: the asker is on the project at once (its
//   workspace, its Slack channel), and told. Declining is 'withdraw'.
exports.projectInvite = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN] },
  async (request) => {
    const d = request.data || {};
    const col = db.collection('projectInvites');
    if (d.action === 'peek') {
      if (!validSlug(String(d.invite || ''))) throw new HttpsError('invalid-argument', 'No invitation given.');
      const inv = (await col.doc(String(d.invite)).get()).data();
      if (!inv || inv.status !== 'open') return { open: false };
      const p = await db.collection('people').where('email', '==', inv.by).limit(1).get();
      return { open: true, title: inv.title, inviter: { id: p.empty ? '' : p.docs[0].id, name: inv.byName } };
    }
    const email = callerEmail(request);
    const name = request.auth.token.name || email;
    if (d.action === 'ask') {
      // PAN-BOLD talks to its owner first, who adds them (2026-11-03): no asking to join.
      if ((await access.groupFor(email)) === 'pan') throw new HttpsError('failed-precondition', 'Talk to the lead on Slack first: they add you to it.');
      const id = String(d.id || ''), board = d.board ? String(d.board) : null;
      if (!validSlug(id) || (board && !validSlug(board))) throw new HttpsError('invalid-argument', 'No project given.');
      const snap = await cardRefFor(id, board).get();
      if (!snap.exists) throw new HttpsError('not-found', 'That project isn’t there any more.');
      const card = snap.data(), pid = projectIdOf(card, id);
      const ws = (await db.collection('projectWorkspaces').doc(pid).get()).data() || {};
      if ((ws.members || []).map(lowerEmail).indexOf(email) >= 0) throw new HttpsError('already-exists', 'You’re already on it.');
      const dup = await col.where('pid', '==', pid).where('email', '==', email).get();
      if (dup.docs.some((x) => x.data().status === 'asked' || x.data().status === 'open')) throw new HttpsError('already-exists', 'You’ve already asked, or been invited.');
      const lead = String((card.submittedBy || {}).email || '').toLowerCase();
      const ref = await col.add({ pid, cardId: id, board: board || null, title: String(card.title || 'a project'), email, name, by: email, byName: name, status: 'asked', at: Date.now() });
      if (lead) await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'project-invites', emails: [lead], headline: '📌 ' + slackText(name) + ' asks to join ' + linkedTitle(String(card.title || 'your project'), projectPageUrl(id, board)) + ': accept or decline, under People on its page.' });
      return { id: ref.id, status: 'asked' };
    }
    if (d.action === 'invite' || d.action === 'list') {
      const id = String(d.id || ''), board = d.board ? String(d.board) : null;
      if (!validSlug(id) || (board && !validSlug(board))) throw new HttpsError('invalid-argument', 'No project given.');
      const snap = await cardRefFor(id, board).get();
      if (!snap.exists) throw new HttpsError('not-found', 'That project isn’t there any more.');
      const card = snap.data(), pid = projectIdOf(card, id);
      if (!(await canEditCard(email, card))) throw new HttpsError('permission-denied', 'Only the project’s submitter, authors, PIs and admins invite people to it.');
      if (d.action === 'list') {
        const all = await col.where('pid', '==', pid).get();
        return { invites: all.docs.map((x) => Object.assign({ id: x.id }, x.data())).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.at - a.at).slice(0, 50) };
      }
      const to = String(d.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpsError('invalid-argument', 'Give their email address.');
      const ws = (await db.collection('projectWorkspaces').doc(pid).get()).data() || {};
      if ((ws.members || []).map(lowerEmail).indexOf(to) >= 0) throw new HttpsError('already-exists', 'They’re already on the project.');
      const dups = (await col.where('pid', '==', pid).where('email', '==', to).get()).docs;
      if (dups.some((x) => x.data().status === 'open')) throw new HttpsError('already-exists', 'They already have an invitation to it.');
      const member = (await db.collection('members').doc(to).get()).exists;
      // They asked to join (from Projects): their ask becomes the invitation.
      const asked = dups.filter((x) => x.data().status === 'asked')[0];
      const inv = { pid, cardId: id, board: board || null, title: String(card.title || 'a project'), email: to, name: String(d.name || (asked && asked.data().name) || '').trim().slice(0, 120),
        by: email, byName: name, status: 'open', at: Date.now() };
      let ref;
      if (asked) { ref = asked.ref; await ref.set(Object.assign({}, inv, { askedAt: asked.data().at })); }
      else ref = await col.add(inv);
      const token = SLACK_BOT_TOKEN.value();
      if (member) {
        await sendEvent(token, { key: 'project-invites', emails: [to], headline: '📌 ' + slackText(name) + ' invited you to ' + linkedTitle(inv.title, inviteUrl(inv, ref.id)) + ': join it or decline, from its page.' });
        return { id: ref.id, emailed: false };
      }
      let error = '';
      try {
        await sendLabEmail(to, name + ' invited you to a BOLD project',
          'Hello' + (inv.name ? ' ' + inv.name.split(' ')[0] : '') + ',\n\n' + name + ' invited you to join their project “' + inv.title + '” in BOLD.\n\n' +
          'Ask to join BOLD here, and you’ll be on the project once your request is approved:\n' + SITE_URL + 'join.html?invite=' + ref.id + '\n\nBOLD');
      } catch (err){ error = err.message || 'Couldn’t send the email.'; logger.error('projectInvite: email failed', { id: ref.id, error }); }
      await ref.update({ emailed: error ? { error, at: Date.now() } : { at: Date.now() } });
      if (error) throw new HttpsError('unavailable', 'The invitation is saved, but the email didn’t go: ' + error);
      return { id: ref.id, emailed: true };
    }
    const iid = String(d.invite || '');
    if (!validSlug(iid)) throw new HttpsError('invalid-argument', 'No invitation given.');
    const ref = col.doc(iid);
    const inv = (await ref.get()).data();
    if (d.action === 'admit') {
      if (!inv || inv.status !== 'asked') throw new HttpsError('failed-precondition', inv ? 'It’s already been ' + inv.status + '.' : 'That request isn’t there.');
      const snap = await cardRefFor(inv.cardId, inv.board).get();
      if (!snap.exists || !(await canEditCard(email, snap.data()))) throw new HttpsError('permission-denied', 'Only the project’s owner, authors, PIs and admins accept a request to join it.');
      const out = await joinProjectAs(inv.email, inv.pid, snap.data(), true);
      await ref.update({ status: 'accepted', decidedAt: Date.now(), decidedBy: email });
      await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'project-invites', emails: [inv.email], headline: '📌 ' + slackText(name) + ' accepted your request to join ' + linkedTitle(inv.title, projectPageUrl(inv.cardId, inv.board)) + ': you’re on it.' });
      return Object.assign({ status: 'accepted' }, out);
    }
    let editor = false;
    if (d.action === 'withdraw' && inv) {
      const snap = await cardRefFor(inv.cardId, inv.board).get();
      editor = snap.exists && await canEditCard(email, snap.data());
    }
    const why = inviteRefusal(inv, d.action, { email, editor });
    if (why) throw new HttpsError('failed-precondition', why);
    if (d.action === 'accept') {
      const snap = await cardRefFor(inv.cardId, inv.board).get();
      const out = await joinProjectAs(email, inv.pid, snap.exists ? snap.data() : null, true);
      await ref.update({ status: 'accepted', decidedAt: Date.now() });
      await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'project-invites', emails: [inv.by], headline: '📌 ' + slackText(name) + ' joined ' + linkedTitle(inv.title, projectPageUrl(inv.cardId, inv.board)) + ', as you invited them.' });
      return Object.assign({ status: 'accepted' }, out);
    }
    await ref.update({ status: d.action === 'decline' ? 'declined' : 'withdrawn', decidedAt: Date.now() });
    return { status: d.action === 'decline' ? 'declined' : 'withdrawn' };
  }
);

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
// Who `email` names as inviting them (their point of contact): someone on BOLD.OS, not
// themselves → the member's invitedBy, waiting for them to confirm it.
async function inviterFor(email, to){
  if (!to || to === email) throw new HttpsError('invalid-argument', 'Choose who invited you.');
  const p = await db.collection('people').where('email', '==', to).limit(1).get();
  if (p.empty) throw new HttpsError('not-found', 'Choose someone on BOLD.OS.');
  const who = p.docs[0];
  return { id: who.id, name: String(who.data().name || to), email: to, status: 'pending', askedAt: Date.now(), via: 'profile' };
}

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
    if (cur && cur.email === to) return { invitedBy: cur };
    const invitedBy = await inviterFor(email, to);
    await ref.update({ invitedBy });
    const name = m.data().name || email;
    await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'inviter-confirm', emails: [to], headline: '👋 ' + await numberTag('members/' + email + '/invite/' + invitedBy.askedAt) + slackText(name) + ' names you as their BOLD point of contact, who invited them. ' +
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
        await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'inviter-confirm', emails: staff, headline: '⚠️ ' + slackText(m.invitedBy.name) + ' says they didn’t invite ' + slackText(m.name || mref.id) + ' to the BOLD Slack (they said so on their profile).' });
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
      await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'inviter-confirm', emails: staff, headline: '⚠️ ' + slackText(r.invitedBy.name) + ' says they didn’t invite ' + slackText(r.name) + ' (' + slackText(r.email) + '). ' +
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
    const num = await numberTag('joinRequests/' + event.params.id);
    // Whoever invited them decides it; the PIs and admins only hear of one without an inviter (from before it was required).
    if (r.invitedBy) {
      await dmBySlackId(SLACK_BOT_TOKEN.value(), r.invitedBy.id, '👋 ' + num + slackText(r.name) + ' (' + slackText(r.role) + ', ' + slackText(r.institution) + ', ' + slackText(r.email) + ') asked to join BOLD and says you invited them. ' +
        linkedTitle('Approve or decline', joinPageUrl() + '#i=' + event.params.id) + '.', 'join-requests');
      return;
    }
    const headline = '👋 ' + num + slackText(r.name) + ' (' + slackText(r.role) + ', ' + slackText(r.institution) + ') asked to join BOLD' +
      (r.contact ? ', with ' + slackText(r.contact) + ' as their point of contact' : '') + '. ' +
      linkedTitle('Approve or decline', joinPageUrl() + '#r=' + event.params.id) + '.';
    const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
    await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'join-requests', emails: staff, headline });
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
        // Their group, unless a PI or admin already set one: PAN-BOLD. Any higher group is a
        // request PIs and admins decide (groupRequest), or a PI or admin sets it on People.
        const keep = ['name', 'email', 'links', 'institution', 'role', 'contact', 'contactEmail', 'interests', 'pillars', 'listOnWebsite', 'basedIn', 'pronouns', 'feedback', 'startDate', 'endDate', 'invitedBy'];
        const rec = {};
        keep.forEach((k) => { if (q[k] !== undefined) rec[k] = q[k]; });
        if (!(had.exists && GROUPS.indexOf(had.data().category) >= 0)) Object.assign(rec, { category: 'pan', categoryBy: email, categoryAt: Date.now() });
        tx.set(m, Object.assign(rec, { requestId: d.id, approvedBy: email, approvedAt: Date.now() }), { merge: true });
      }
      return Object.assign({}, q, { status });
    });
    if (r.status !== 'approved') {
      // Declined: a request for another group sent with it goes too.
      const g = await db.collection('groupRequests').where('email', '==', String(r.email || '').toLowerCase()).where('status', '==', 'open').get();
      for (const x of g.docs) await x.ref.update({ status: 'withdrawn', decidedAt: Date.now(), why: 'joining declined' });
      return { status: r.status };
    }
    // Invited to a project (projectInvite): on it now, as they asked to join through it.
    const invs = await db.collection('projectInvites').where('email', '==', String(r.email || '').toLowerCase()).where('status', '==', 'open').get();
    const extra = r.projectInvite && !invs.docs.some((x) => x.id === r.projectInvite) ? [await db.collection('projectInvites').doc(r.projectInvite).get()] : [];
    for (const x of invs.docs.concat(extra.filter((y) => y.exists && y.data().status === 'open'))) {
      try {
        await joinProjectAs(String(r.email).toLowerCase(), x.data().pid, null, false);
        await x.ref.update({ status: 'accepted', decidedAt: Date.now(), via: 'join' });
      } catch (err){ logger.error('decideJoinRequest: joining the invited project failed', { invite: x.id, error: String(err) }); }
    }
    return { status: r.status, welcome: await sendWelcome(d.id) };
  }
);

// ---------- Proposing changes to a request to join (#261, 2026-11-07) ----------
// Whoever decides a request (its inviter; PIs and admins one without an inviter) can propose
// changes to the applicant's answers instead of approving or declining it: they edit the form
// itself (and may add a note), and the request stays open, with `changes` { status: 'asked' |
// 'made', proposed: { field: value } (only what differs), note, by, byName, at, keyHash, madeAt }.
// The answers stay the applicant's: they aren't signed in (join.html is for people outside BOLD),
// so they get an email from the lab's account listing the changes, with a one-time link,
// join.html?changes=<id>&key=<key> (only its sha256 is kept), to their form holding the proposed
// answers, to accept, adjust and send; sending uses the key up and DMs whoever proposed them.
const JOIN_CHANGES_NOTE = 1000;
// The fields that can change (not who invited them: that's who decides), and their names.
const JOIN_EDITABLE = ['name', 'email', 'links', 'institution', 'role', 'interests', 'basedIn', 'pronouns', 'feedback', 'startDate', 'endDate', 'listOnWebsite', 'pillars'];
const JOIN_FIELD_NAMES = { name: 'Full name', email: 'Email address', links: 'Links', institution: 'Home institution', role: 'Role at BOLD', interests: 'Research interests',
  basedIn: 'Based in', pronouns: 'Pronouns', feedback: 'How you like to receive feedback', startDate: 'Start date', endDate: 'End date', listOnWebsite: 'Listed on the BOLD website', pillars: 'Research pillars' };
const keyHash = (k) => crypto.createHash('sha256').update(String(k || '')).digest('hex');
// Pure: the answers in `next` (normalized, normalizeJoinRequest) that differ from request q's. → { field: value }
function joinChangesProposed(q, next){
  const out = {}, same = (a, b) => JSON.stringify(a === undefined ? '' : a) === JSON.stringify(b === undefined ? '' : b);
  JOIN_EDITABLE.forEach((k) => {
    if (next[k] === undefined) return;
    const was = k === 'pillars' ? (q[k] || []) : k === 'listOnWebsite' ? q[k] === true : q[k];
    if (!same(was, next[k])) out[k] = next[k];
  });
  return out;
}
// Pure: may `who` ({ email, full }) propose `proposed` and `note` for request q? → '' or why not.
function joinChangesRefusal(q, who, note, proposed){
  if (!q) return 'No such request.';
  const inviter = !!(q.invitedBy && q.invitedBy.email), mine = inviter && q.invitedBy.email === who.email;
  if (!mine && !(who.full && !inviter)) return 'Only whoever invited them decides this.';
  if (q.status !== 'open') return 'It has already been ' + q.status + '.';
  const n = String(note || '').trim();
  if (n.length > JOIN_CHANGES_NOTE) return 'The note is too long: at most ' + JOIN_CHANGES_NOTE + ' characters.';
  if (!n && !Object.keys(proposed || {}).length) return 'Change an answer, or say what they should change.';
  return '';
}
// Pure: may the holder of `key` change request q? → '' or why not.
function joinChangesKeyRefusal(q, key){
  const c = (q && q.changes) || {};
  if (!q || !key || !c.keyHash || c.keyHash !== keyHash(key)) return 'This link isn’t valid: ask your point of contact for a new one.';
  if (q.status !== 'open') return 'Your request has already been ' + q.status + '.';
  if (c.status !== 'asked') return 'You’ve already changed it: your point of contact has it.';
  return '';
}
// Pure: each proposed change, as "Role at BOLD: Visitor → Postdoc".
function joinChangesLines(q, proposed){
  const show = (k, v) => k === 'listOnWebsite' ? (v ? 'yes' : 'no') : Array.isArray(v) ? (v.length ? v.join('; ') : '—') : String(v == null || v === '' ? '—' : v);
  return Object.keys(proposed || {}).filter((k) => JOIN_FIELD_NAMES[k]).map((k) => JOIN_FIELD_NAMES[k] + ': ' + show(k, q[k]) + ' → ' + show(k, proposed[k]));
}
// Pure: the email to the applicant. → { subject, body }
function joinChangesEmail(q, note, link, byName, proposed){
  const first = String(q.name || '').trim().split(/\s+/)[0] || 'there', who = byName || 'Your point of contact';
  const lines = joinChangesLines(q, proposed), n = String(note || '').trim();
  return { subject: 'Your request to join BOLD: ' + (byName || 'your point of contact') + ' proposes changes', body: [
    'Hi ' + first + ',', '',
    who + ' read your request to join BOLD and proposes some changes before they decide' + (lines.length ? ':' : '.'), '']
    .concat(lines.length ? lines.map((l) => '  • ' + l).concat(['']) : [])
    .concat(n ? [(lines.length ? 'They add:' : 'They say:'), n.split('\n').map((l) => '  ' + l).join('\n'), ''] : [])
    .concat(['Your form, with their changes in it, to accept, adjust and send (the link is yours alone, and works once):', link, '', 'The BOLD team'])
    .join('\n') };
}
// Pure: what the applicant may see of request q, to change it: their answers, and what's proposed.
function joinChangesView(q){
  const out = {};
  JOIN_EDITABLE.forEach((k) => { if (q[k] !== undefined) out[k] = q[k]; });
  const c = q.changes || {};
  return Object.assign(out, { proposed: c.proposed || {}, lines: joinChangesLines(q, c.proposed), note: c.note || '', byName: c.byName || '',
    inviter: q.invitedBy ? { id: q.invitedBy.id || '', name: q.invitedBy.name || '' } : null });
}

// data: { action: 'ask', id, answers?, note? } (whoever decides it; answers: the form as they edited it) → { emailed, error? };
// { action: 'peek', id, key } (the applicant, signed in or not) → what they can change;
// { action: 'save', id, key, ...the form } → { ok }.
exports.joinChanges = onCall(
  { secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN] },
  async (request) => {
    const d = request.data || {};
    if (!/^[A-Za-z0-9]{1,40}$/.test(String(d.id || ''))) throw new HttpsError('invalid-argument', 'No such request.');
    const ref = db.collection('joinRequests').doc(d.id);
    if (d.action === 'ask') {
      const email = callerEmail(request);
      await access.requireAccess(email, 'requests', 'edit');   // Who can see what
      const who = { email, full: await isFullWrite(email) }, byName = request.auth.token.name || email;
      const key = crypto.randomBytes(24).toString('hex'), note = String(d.note || '').trim(), set = await joinSettings();
      let proposed = {};
      const q = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref), x = s.exists ? s.data() : null;
        // Their answers as edited (d.answers, the form): checked as the form is, and only what differs kept.
        if (x && d.answers && typeof d.answers === 'object') {
          const base = {};
          JOIN_EDITABLE.forEach((k) => { if (x[k] !== undefined) base[k] = x[k]; });
          const n = normalizeJoinRequest(Object.assign(base, d.answers, { contact: (x.invitedBy && x.invitedBy.name) || x.contact || 'them' }), set.roles, set.pillars);
          if (n.error) throw new HttpsError('invalid-argument', n.error);
          proposed = joinChangesProposed(x, n.request);
        }
        const why = joinChangesRefusal(x, who, note, proposed);
        if (why) throw new HttpsError(x ? 'failed-precondition' : 'not-found', why);
        tx.update(ref, { changes: { status: 'asked', proposed, note, by: email, byName, at: Date.now(), keyHash: keyHash(key) } });
        return x;
      });
      const link = SITE_URL + 'join.html?changes=' + d.id + '&key=' + key;
      const mail = joinChangesEmail(q, note, link, byName, proposed);
      const error = await gmailSend(q.email, mail.subject, mail.body, 'joinChanges ' + d.id);
      // The test copy (scripts/test-site.sh) has no Gmail: the link is in the emulator's log, to try it.
      if (process.env.FUNCTIONS_EMULATOR === 'true') logger.info('joinChanges: the applicant’s link (emulator only)', { link });
      await ref.update({ 'changes.emailed': !error, 'changes.error': error });
      return Object.assign({ proposed: joinChangesLines(q, proposed) }, error ? { emailed: false, error } : { emailed: true });
    }
    const q = (await ref.get()).data();
    const why = joinChangesKeyRefusal(q, String(d.key || ''));
    if (why) throw new HttpsError('failed-precondition', why);
    if (d.action === 'peek') return joinChangesView(q);
    if (d.action !== 'save') throw new HttpsError('invalid-argument', 'Unknown action.');
    if (d.website) return { ok: true };   // the bots' field (join.html)
    const set = await joinSettings();
    const n = normalizeJoinRequest(Object.assign({}, d, { contact: (q.invitedBy && q.invitedBy.name) || q.contact || '' }), set.roles, set.pillars);
    if (n.error) throw new HttpsError('invalid-argument', n.error);
    if (n.request.email !== q.email) {
      const other = await db.collection('joinRequests').where('email', '==', n.request.email).where('status', '==', 'open').limit(1).get();
      if (!other.empty) throw new HttpsError('already-exists', 'There’s already a request for that email address.');
    }
    const upd = {};
    JOIN_EDITABLE.forEach((k) => { if (n.request[k] !== undefined) upd[k] = n.request[k]; });
    await db.runTransaction(async (tx) => {
      const again = joinChangesKeyRefusal((await tx.get(ref)).data(), String(d.key || ''));
      if (again) throw new HttpsError('failed-precondition', again);
      tx.update(ref, Object.assign(upd, { 'changes.status': 'made', 'changes.madeAt': Date.now(), 'changes.keyHash': '' }));
    });
    // Whoever asked hears they've changed it (join.html asked them first).
    const num = await numberTag('joinRequests/' + d.id), c = q.changes || {};
    const text = '✏️ ' + num + slackText(upd.name || q.name) + ' sent their request to join BOLD again, after the changes you proposed. ' + linkedTitle('Approve or decline', joinPageUrl() + '#i=' + d.id) + '.';
    if (q.invitedBy && q.invitedBy.id && q.invitedBy.email === c.by) await dmBySlackId(SLACK_BOT_TOKEN.value(), q.invitedBy.id, text, 'join-requests');
    else if (c.by) await dmByEmail(SLACK_BOT_TOKEN.value(), c.by, text, 'join-requests');
    return { ok: true };
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
// so it never follows anything a member edits: approving a request to join puts them in
// PAN-BOLD. A member asks for another group on group-request.html, accepting what it asks of
// them (groupRequests/{id}, through groupRequest); only the PIs and admins decide, on Join
// requests (2026-11-02). Each group but PAN-BOLD may have Slack channels (settings/groups.channels, set there:
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
// PAN-BOLD's too (2026-11-05): everyone on the BOLD Slack, a record or not.
const CHANNEL_GROUPS = GROUPS.slice();
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

function groupChannelName(raw){ return String(raw || '').trim().replace(/^#/, '').toLowerCase(); }
// A group's channels, as saved ("#a, b c") → ['a', 'b', 'c'].
function groupChannelNames(raw){ return String(raw || '').split(/[\s,]+/).map(groupChannelName).filter(Boolean); }

// Pure: the group (and role) channels a member record is meant to be in, given settings/groups (#174).
function groupChannelsFor(m, set){
  set = set || {};
  const out = [];
  const add = function(v){ groupChannelNames(v).forEach(function(n){ if (out.indexOf(n) < 0) out.push(n); }); };
  channelGroupsFor(groupOf(m)).forEach(function(h){ add((set.channels || {})[h]); });
  if (m && m.role) add((set.roleChannels || {})[m.role]);
  return out;
}
// Pure: every group and role channel, each with the groups and roles it's for ("BOLD-internal").
function allGroupChannels(set){
  set = set || {};
  const out = {};
  const add = function(v, what){ groupChannelNames(v).forEach(function(n){ (out[n] = out[n] || []).push(what); }); };
  CHANNEL_GROUPS.forEach(function(g){ add((set.channels || {})[g], GROUP_LABELS[g]); });
  Object.keys(set.roleChannels || {}).forEach(function(r){ add(set.roleChannels[r], r); });
  return out;
}

// Invites each of `emails` to group channel `name`; → the first error, or ''. One about a
// person says who, and why, and that the rest were added (the loop goes on past them).
async function inviteToGroupChannel(token, emails, name){
  let error = '';
  for (const e of emails){
    const uid = await slackIdForEmail(e);
    if (!uid) continue;   // not on Slack (yet)
    try { await inviteToProjectChannel(token, e, name); }
    catch (err){
      logger.warn('Adding someone to a group channel failed', { channel: name, slackId: uid, error: String(err.message) });
      const why = slackPersonProblem(err.slackCode);
      if (why && !error){
        const p = (await db.collection('people').doc(uid).get()).data() || {};
        error = 'Couldn\u2019t add ' + (p.name || 'someone') + ' to #' + name + ': ' + why + '. Everyone else was added; Save again to retry.';
      }
      error = error || err.message;
      if (/can.t see|can.t manage/.test(err.message)) break;   // same for everyone after
    }
  }
  return error;
}

// Pure: the visible channel most like `name` (a typo, a missing "s"), or '' when none is close.
function nearestChannel(name, names){
  const dist = (a, b) => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++){
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++){ const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return d[b.length];
  };
  let best = '', bestD = 3;
  for (const n of names){ const k = dist(name, n); if (k < bestD) { best = n; bestD = k; } }
  return best;
}

// The group settings' Slack channels (Requests): before saving, which of `names` the bot
// can't see — no such channel, or a private one it isn't in — each with the nearest one
// it can see. PIs and admins. data: { names: [..] } → { missing: [{ name, suggest }], bot }.
exports.checkGroupChannels = onCall(
  { secrets: [SLACK_BOT_TOKEN] },
  async (request) => {
    const email = signedInEmail(request);
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins set the groups’ channels.');
    const names = Array.isArray((request.data || {}).names) ? request.data.names.map((n) => String(n).replace(/^#/, '').toLowerCase()).filter((n) => /^[a-z0-9_-]{1,80}$/.test(n)).slice(0, 60) : [];
    const token = SLACK_BOT_TOKEN.value();
    const missing = [];
    for (const n of names) if (!(await slackChannelId(token, n))) missing.push({ name: n, suggest: nearestChannel(n, channelNamesCache ? Array.from(channelNamesCache.names.keys()) : []) });
    const auth = missing.length ? await slackAuthInfo(token) : null;
    return { missing, bot: auth && auth.bot ? '@' + auth.bot : '' };
  }
);

exports.onMemberGroup = onDocumentWritten(
  { document: 'members/{email}', secrets: [SLACK_BOT_TOKEN] },
  async function(event){
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const g = groupOf(after);
    // A group up (or their first, PAN-BOLD): its first week starts. Else, their details saved: look again.
    const email = String(event.params.email).toLowerCase(), up = !before || (GROUP_RANK[g] || 0) > (GROUP_RANK[groupOf(before)] || 0);
    const DETAILS = ['role', 'institution', 'interests', 'pillars', 'startDate', 'contact', 'invitedBy'];
    if (up) await startTrial(email, g).catch((err) => logger.warn('Starting a trial failed', { error: String(err && err.message || err) }));
    else if (DETAILS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) await afterProgress(email);
    if (up) await checkEligible(email);   // a new group: maybe already ready for the next
    const wanted = before && groupOf(before) === g ? [] : channelGroupsFor(g);
    // A new role: its channels too (settings/groups.roleChannels).
    const role = String(after.role || ''), newRole = role && (!before || before.role !== role);
    if (!wanted.length && !newRole) return;
    const set = (await db.collection('settings').doc('groups').get()).data() || {};
    const names = [];
    wanted.forEach(function(h){ groupChannelNames((set.channels || {})[h]).forEach(function(n){ if (names.indexOf(n) < 0) names.push(n); }); });
    if (newRole) groupChannelNames((set.roleChannels || {})[role]).forEach(function(n){ if (names.indexOf(n) < 0) names.push(n); });
    const failed = {};
    for (const name of names){
      const err = await inviteToGroupChannel(SLACK_BOT_TOKEN.value(), [event.params.email], name);
      if (err) failed[name] = err;
    }
    // Not just in the logs: shown on Requests by the group's (or role's) channels, where
    // PIs and admins set them, and the group is no longer counted as done, so saving the
    // settings again (once the channel is fixed) adds everyone in it (onGroupChannels).
    const bad = Object.keys(failed);
    if (!bad.length) return;
    const uses = (v) => groupChannelNames(v).filter((n) => bad.indexOf(n) >= 0)[0];
    const errs = {}, undo = {};
    wanted.forEach(function(h){ const n = uses((set.channels || {})[h]); if (n) { errs['channelErrors.' + h] = failed[n]; undo['channels.' + h] = FieldValue.delete(); } });
    if (newRole){ const n = uses((set.roleChannels || {})[role]); if (n) { errs['roleChannelErrors.' + role] = failed[n]; undo['roles.' + role] = FieldValue.delete(); } }
    if (Object.keys(undo).length) await db.collection('settings').doc('groupsInvited').update(undo).catch(function(){});
    if (Object.keys(errs).length) await db.collection('settings').doc('groups').update(errs);
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
    // PAN-BOLD's channels: everyone on the roster too (on the Slack, no record yet: PAN-BOLD, groupOf).
    const roster = changed.indexOf('pan') >= 0 ? (await db.collection('people').get()).docs.map(function(d){ return String(d.data().email || '').toLowerCase(); }).filter(Boolean) : [];
    const errors = Object.assign({}, after.channelErrors || {}), roleErrors = Object.assign({}, after.roleChannelErrors || {});
    const fill = async function(emails, names){
      let err = '';
      for (const name of names) err = (await inviteToGroupChannel(SLACK_BOT_TOKEN.value(), emails, name)) || err;
      return err;
    };
    for (const g of changed){
      const emails = members.filter(function(m){ return channelGroupsFor(groupOf(m)).indexOf(g) >= 0; }).map(function(m){ return m.email; });
      if (g === 'pan') roster.forEach(function(e){ if (emails.indexOf(e) < 0) emails.push(e); });
      const err = await fill(emails, freshIn(channels[g], before[g]));
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

// ---------- A PI's or admin's test account (2026-11-02) ----------
// A second account of theirs in the BOLD Slack, signed in to like anyone's (in a private window),
// linked on their profile (Linked accounts) so they can try BOLD.OS as someone else: testAccounts/
// {email} { owner, at } (PIs and admins read them; written only here), and its members record
// marked { test: true, testOf }. It's hidden from People (but for its owner) and from everyone's
// onboarding; its owner sets its group directly and resets it to a newcomer.
// - 'get' → { account: { email, name, group } | null }; 'link' { email }; 'unlink';
// - 'group' { group }: pan, associate, internal or staff; 'reset': its details, onboarding (the
//   tour, the BOLDiquette read), group requests, project invitations and asks, and the projects
//   and event series it joined go; it's PAN-BOLD again. Projects it registered stay.
const TEST_GROUPS = ['pan', 'associate', 'internal', 'staff'];
exports.testAccount = onCall(
  async (request) => {
    const email = callerEmail(request);
    if (!(await realFullWrite(email))) throw new HttpsError('permission-denied', 'Test accounts are for PIs and admins.');
    const d = request.data || {};
    const col = db.collection('testAccounts');
    const mine = await col.where('owner', '==', email).limit(1).get();
    const linked = mine.empty ? null : mine.docs[0].id;
    const view = async (e) => {
      if (!e) return { account: null };
      const m = (await db.collection('members').doc(e).get()).data() || {};
      return { account: { email: e, name: m.name || e, group: groupOf(m) } };
    };
    if (d.action === 'get') return view(linked);
    if (d.action === 'link') {
      if (linked) throw new HttpsError('already-exists', 'You already have one: unlink it first.');
      const to = String(d.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpsError('invalid-argument', 'Give its email address.');
      if (to === email) throw new HttpsError('invalid-argument', 'That’s you: give your second account’s address.');
      if (await realFullWrite(to)) throw new HttpsError('failed-precondition', 'That’s a PI’s or admin’s account.');
      const p = await db.collection('people').where('email', '==', to).limit(1).get();
      if (p.empty) throw new HttpsError('failed-precondition', 'No one in the BOLD Slack has that address: join the Slack with it first.');
      if ((await col.doc(to).get()).exists) throw new HttpsError('already-exists', 'It’s someone else’s test account.');
      await col.doc(to).set({ owner: email, at: Date.now() });
      await db.collection('members').doc(to).set({ test: true, testOf: email, name: p.docs[0].data().name || to, email: to }, { merge: true });
      return view(to);
    }
    if (!linked) throw new HttpsError('failed-precondition', 'Link a test account first.');
    if (d.action === 'unlink') {
      await col.doc(linked).delete();
      await db.collection('members').doc(linked).set({ test: FieldValue.delete(), testOf: FieldValue.delete() }, { merge: true });
      return { account: null };
    }
    if (d.action === 'group') {
      if (TEST_GROUPS.indexOf(d.group) < 0) throw new HttpsError('invalid-argument', 'Choose PAN-BOLD, BOLD-associate, BOLD-internal or BOLD-staff.');
      await db.collection('members').doc(linked).set({ category: d.group, categoryBy: email, categoryAt: Date.now() }, { merge: true });
      return view(linked);
    }
    if (d.action === 'reset') {
      const t = linked;
      const [reqs, invs, readers, wss, series] = await Promise.all([
        db.collection('groupRequests').where('email', '==', t).get(), db.collection('projectInvites').where('email', '==', t).get(),
        db.collection('handbook').doc('boldiquette').collection('readers').where('email', '==', t).get(),
        db.collection('projectWorkspaces').where('joined', 'array-contains', t).get(), db.collection('eventSeries').where('joined', 'array-contains', t).get(),
      ]);
      const b = db.batch();
      reqs.docs.concat(invs.docs, readers.docs).forEach((x) => b.delete(x.ref));
      b.delete(db.collection('onboarding').doc(t));
      series.docs.forEach((x) => b.update(x.ref, { joined: FieldValue.arrayRemove(t) }));
      wss.docs.forEach((x) => b.update(x.ref, { joined: FieldValue.arrayRemove(t) }));
      const m = (await db.collection('members').doc(t).get()).data() || {};
      b.set(db.collection('members').doc(t), { name: m.name || t, email: t, test: true, testOf: email, category: 'pan', categoryBy: email, categoryAt: Date.now() });
      await b.commit();
      for (const x of wss.docs) { try { await syncWorkspace(x.id); } catch (err){ logger.warn('testAccount reset: syncing a workspace failed', { pid: x.id, error: String(err) }); } }
      // Its BOLDiquette read point (readPoints/{uid}) goes too, so the page says it's unread.
      try { const u = await admin.auth().getUserByEmail(t); await db.recursiveDelete(db.collection('readPoints').doc(u.uid)); } catch (err){ /* never signed in */ }
      return view(t);
    }
    throw new HttpsError('invalid-argument', 'Unknown action.');
  }
);

// ---------- Onboarding (Get started, 2026-11-02) ----------
// What each newcomer does, by group (each group also does those of the groups below), each
// ticked from what BOLD.OS already knows, so nobody ticks their own:
// - everyone: their details (members/{email}: role, institution, interests, pillars, start
//   date, and who invited them unless a PI), read the BOLDiquette (its Mark as read, which
//   lists them in handbook/boldiquette/readers: read-point.js). The tour is optional, not a
//   step: taking it is marked at its end (onboarding/{email}, server-written), as `tour`;
// - BOLD-associate: be on a project (join one, or register one);
// - BOLD-internal and above: own a project (have registered one: its submittedBy), and join every
//   event series required for their group (eventSeries' requiredFor, set by PIs and admins on
//   its form: the reading group, the group meeting, Hamming sessions…); one that invites their
//   whole group counts as joined.
// Asking for a higher group needs it done (groupRequest). PIs and admins see everyone's on People.
const ONBOARDING_RANK = { everyone: 0, pan: 0, associate: 1, internal: 2, staff: 3, exec: 4 };
// Pure: a group and what we know of them → { steps: [{ key, label, done, href }], done }.
// f: { email, member, marks, read, inProject, owns, series: [{ id, title, requiredFor, invite, joined, hidden }] }.
function onboardingSteps(group, f){
  f = f || {};
  const m = f.member || {}, has = (k) => !!String(m[k] || '').trim();
  const r = ONBOARDING_RANK[group] || 0, email = String(f.email || '').toLowerCase();
  const details = !!f.member && has('role') && has('institution') && has('interests') && (m.pillars || []).length > 0 && has('startDate') &&
    (m.role === 'PI' || has('contact') || !!(m.invitedBy && m.invitedBy.email));
  const steps = [
    { key: 'details', label: 'Fill in your details on your profile', done: details, href: 'profile.html#details' },
    { key: 'read', label: 'Read the BOLDiquette, and mark it as read', done: !!f.read, href: 'boldiquette.html' },
  ];
  // BOLD-associate: an active collaborator, added to an ongoing project by its owner (2026-11-03, from the
  // lab's Slack thread): their own project doesn't count, and PAN-BOLD can't join one themselves.
  if (r === 1) steps.push({ key: 'project', label: 'Be added to someone’s project: talk to the lead (Projects), who adds you', done: !!f.inProject, href: 'projects.html' });
  if (r >= 2) {
    steps.push({ key: 'own', label: 'Register a project of your own', done: !!f.owns, href: 'projects-register.html' });
    (f.series || []).filter((x) => !x.hidden && x.requiredFor && r >= (ONBOARDING_RANK[x.requiredFor] || 0))
      .sort((a, b) => String(a.title).localeCompare(String(b.title)))
      .forEach((x) => {
        const inv = x.invite || {};
        const invited = inv.mode === 'group' && r >= (ONBOARDING_RANK[inv.group] || 0);
        steps.push({ key: 'series:' + x.id, label: 'Join ' + x.title, done: invited || (x.joined || []).map((e) => String(e).toLowerCase()).indexOf(email) >= 0,
          href: 'series.html?series=' + encodeURIComponent(x.id) });
      });
  }
  return { steps, done: steps.every((x) => x.done) };
}
const seriesFacts = (docs) => docs.map((d) => { const v = d.data(); return { id: d.id, title: v.title || d.id, requiredFor: v.requiredFor || '', invite: v.invite || null, joined: v.joined || [], hidden: !!v.hidden, visibleTo: v.visibleTo || 'internal' }; });
// `as`: the steps of another group (asking for it: group-request.html), else their own.
async function onboardingFor(email, as){
  email = String(email || '').toLowerCase();
  const [m, marks, read, ws, owned, ownedCard, series, group] = await Promise.all([
    db.collection('members').doc(email).get(), db.collection('onboarding').doc(email).get(),
    db.collection('handbook').doc('boldiquette').collection('readers').where('email', '==', email).limit(1).get(),
    db.collection('projectWorkspaces').where('members', 'array-contains', email).get(),
    db.collection('projects').where('submittedBy.email', '==', email).get(),
    db.collectionGroup('cards').where('submittedBy.email', '==', email).get(),
    db.collection('eventSeries').where('hidden', '==', false).get(),
    as && ONBOARDING_RANK[as] !== undefined ? as : access.groupFor(email),
  ]);
  const trial = marks.exists && marks.data().trial;
  return Object.assign({ group, tour: !!(marks.exists && marks.data().tour), trial: trial && trial.group === group && !trial.done ? { endsAt: trial.endsAt, ended: !!trial.ended } : null }, onboardingSteps(group, { email, member: m.exists ? m.data() : null, marks: marks.exists ? marks.data() : {}, read: !read.empty,
    inProject: onOthers(ws.docs, owned.docs.concat(ownedCard.docs)), owns: !owned.empty || !ownedCard.empty, series: seriesFacts(series.docs) }));
}
// On a project someone else registered: one of their workspaces isn't for a card they submitted.
function onOthers(wsDocs, ownDocs){
  const own = new Set(ownDocs.map((d) => d.id));
  return wsDocs.some((w) => !own.has(w.id) && !own.has(String((w.data() || {}).cardId || '')));
}
// - {}: your own → { group, steps, done, tour }.
// - { group }: what that group needs of them, checked now (asking for it: group-request.html).
// - { all: true }: PIs and admins, everyone with a record → { people: [{ email, name, group, steps, done }] }.
// - { action: 'mark', step: 'tour' }: marks the tour taken (at its end).
exports.onboarding = onCall(
  async (request) => {
    const email = signedInEmail(request).toLowerCase();
    const d = request.data || {};
    if (d.action === 'mark') {
      if (d.step !== 'tour') throw new HttpsError('invalid-argument', 'Unknown step.');
      await db.collection('onboarding').doc(email).set({ [d.step]: Date.now() }, { merge: true });
      return onboardingFor(email);
    }
    if (!d.all) return onboardingFor(email, ['pan', 'associate', 'internal', 'staff', 'exec'].indexOf(d.group) >= 0 ? d.group : '');
    if (!(await isFullWrite(email))) throw new HttpsError('permission-denied', 'Only PIs and admins see everyone’s onboarding.');
    const [members, marks, readers, wss, series, projects, cards] = await Promise.all([db.collection('members').get(), db.collection('onboarding').get(),
      db.collection('handbook').doc('boldiquette').collection('readers').get(), db.collection('projectWorkspaces').get(), db.collection('eventSeries').get(),
      db.collection('projects').get(), db.collectionGroup('cards').get()]);
    const mark = {}, onProject = {}, read = {}, owns = {};
    readers.docs.forEach((x) => { read[String(x.data().email || '').toLowerCase()] = true; });
    marks.docs.forEach((x) => { mark[x.id] = x.data(); });
    const submitter = {};
    projects.docs.concat(cards.docs).forEach((x) => { const e = String((x.data().submittedBy || {}).email || '').toLowerCase(); if (e) { owns[e] = true; submitter[x.id] = e; } });
    // On someone else's project (BOLD-associate's step): not one they submitted.
    wss.docs.forEach((x) => (x.data().members || []).forEach((e) => { e = String(e).toLowerCase(); if (submitter[x.id] !== e && submitter[String(x.data().cardId || '')] !== e) onProject[e] = true; }));
    const facts = seriesFacts(series.docs);
    const people = await Promise.all(members.docs.filter((x) => !x.data().test).map(async (x) => {
      const e = x.id.toLowerCase(), group = await access.groupFor(e);
      return Object.assign({ email: e, name: x.data().name || e, group }, onboardingSteps(group, { email: e, member: x.data(), marks: mark[e] || {}, read: !!read[e],
        inProject: !!onProject[e], owns: !!owns[e], series: facts }));
    }));
    return { people };
  }
);

// Once (2026-11-04), when runs/{id} is created (admin access only: the rules let no client read or write it) with
// { action: 'project-setup-nudge' }: projects ongoing only through their weekly meeting are marked ongoing
// (startedAt, startedBy 'migration-2026-11-04'), so the new rule (workspaceStarted) keeps them so; then
// each ongoing project still missing some of its setup tells its lead (whoever registered it) once, on Slack (pilot
// project-setup). { dryRun: true }: nothing is written or sent; the run lists what would be, in `plan`.
// Projects on a venue's board, and completed ones, are left alone. The run records `doneAt` and `plan`.
function setupNudgeText(title, missing, url){
  return '🛠️ “' + slackText(title) + '” is ongoing but still needs ' + setupMissingText(missing) + '. ' + linkedTitle('Set it up on its page', url) + ', so everyone on it has what they need.';
}
// Moving someone to another email (2026-11-05: Yaser signed up with one, Slack has another): a runs/{id}
// document { action: 'move-account', from, to, dryRun } (made from the console or an admin tool; clients
// can't write runs). Changes their sign-in account's email, then every document: `from` → `to` wherever it
// is a value, in an array or a map key, and a document named after it moves to `to`'s id. What Google
// has (a workspace's `shared`, an invitation's `synced`) keeps the old one, so the syncs after (their
// projects', series' and study meetings) share and invite the new address and drop the old. Logs and
// caches are left. dryRun: only says what it would change, in the run's `plan`.
const MOVE_SKIP_COLLECTIONS = ['apiLog', 'meta', 'runs', 'imageHashes', 'meetingReminders'];
const MOVE_KEEP_FIELDS = { projectWorkspaces: ['shared'], eventInvites: ['synced'] };
// Pure: `v` with every `from` (any case) → `to`, in values, arrays and map keys; { value, n } (n: how many).
function replaceEmail(v, from, to){
  let n = 0;
  const f = String(from).toLowerCase();
  const walk = function(x){
    if (typeof x === 'string') { if (x.toLowerCase() === f) { n++; return to; } return x; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const out = {};
      Object.keys(x).forEach(function(k){ const nk = k.toLowerCase() === f ? (n++, to) : k; out[nk] = walk(x[k]); });
      return out;
    }
    return x;   // Timestamps, references, FieldValues
  };
  return { value: walk(v), n };
}
exports.onAccountMoveRun = onDocumentCreated({ document: 'runs/{id}', secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN, GITHUB_APP], timeoutSeconds: 540, memory: '1GiB' }, async (event) => {
  const run = event.data && event.data.data();
  if (!run || run.action !== 'move-account' || run.doneAt) return;
  const from = lowerEmail(run.from), to = lowerEmail(run.to), dry = run.dryRun !== false;
  const report = { changed: [], moved: [], skipped: [], errors: [] };
  const done = (extra) => event.data.ref.set(Object.assign({ doneAt: Date.now(), dryRun: dry, plan: report }, extra || {}), { merge: true });
  if (!from || !to || from === to) return done({ error: 'Give from and to.' });
  let user = null;
  try { user = await admin.auth().getUserByEmail(from); } catch (err){ return done({ error: 'No account with ' + from + '.' }); }
  try { await admin.auth().getUserByEmail(to); return done({ error: 'An account already has ' + to + '.' }); } catch (err){ /* none: good */ }
  if (!dry) await admin.auth().updateUser(user.uid, { email: to });
  report.account = user.uid;
  const touched = { projectWorkspaces: [], eventSeries: [], studies: [], eventInvites: [] };
  async function walk(col){
    const name = col.id;
    if (MOVE_SKIP_COLLECTIONS.indexOf(name) >= 0) return;
    for (const d of (await col.get()).docs){
      const data = d.data(), keep = MOVE_KEEP_FIELDS[name] || [];
      const kept = {}; keep.forEach((k) => { if (k in data) { kept[k] = data[k]; delete data[k]; } });
      const r = replaceEmail(data, from, to);
      if (r.n) Object.assign(r.value, kept);
      if (d.id.toLowerCase() === from){
        const subs = await d.ref.listCollections();
        if (subs.length) report.skipped.push(d.ref.path + ' (has subcollections)');
        else {
          report.moved.push(d.ref.path);
          if (!dry) { await col.doc(to).set(r.n ? r.value : Object.assign(data, kept)); await d.ref.delete(); }
          continue;
        }
      }
      if (r.n){
        report.changed.push(d.ref.path + ' (' + r.n + ')');
        if (touched[name]) touched[name].push(d.id);
        if (!dry) await d.ref.set(r.value);
      }
      for (const sub of await d.ref.listCollections()) await walk(sub);
    }
  }
  try { for (const col of await db.listCollections()) await walk(col); }
  catch (err){ report.errors.push(String(err && err.message || err)); }
  // Google and GitHub, in line with the new address.
  if (!dry){
    for (const id of touched.projectWorkspaces) await syncWorkspace(id).catch((e) => report.errors.push('workspace ' + id + ': ' + e.message));
    for (const id of touched.eventSeries) await labSeries.syncSeries(id).catch((e) => report.errors.push('series ' + id + ': ' + e.message));
    if (touched.studies.length || report.moved.some((p) => p.indexOf('studies/') === 0)) await syncStudyMeeting(to).catch((e) => report.errors.push('studies: ' + e.message));
    for (const id of touched.eventInvites) await labSeries.syncOccurrence(id).catch((e) => report.errors.push('invite ' + id + ': ' + e.message));
  }
  logger.info('Account move', { dry, changed: report.changed.length, moved: report.moved.length, errors: report.errors.length });
  return done();
});

// GitHub access by the new rule, once (#214): runs/{id} { action: 'github-access', dryRun? } (admin
// access only). Makes the bold-internal team and gives it write on every repository; puts BOLD-internal
// and above with a linked GitHub account in it and takes out those below (never anyone who hasn't
// linked theirs: an owner looks after them); invites to the org everyone linked who isn't in it (their
// project repositories as outside collaborators until they accept); then syncs every project's team.
// Its `plan` says what it did (or, dry, would do). Safe to run again: it only adds what's missing.
exports.onGithubAccessRun = onDocumentCreated({ document: 'runs/{id}', secrets: [GOOGLE_OAUTH, GITHUB_APP], timeoutSeconds: 540, memory: '512MiB' }, async (event) => {
  const run = event.data && event.data.data();
  if (!run || run.action !== 'github-access' || run.doneAt) return;
  const dry = run.dryRun === true, plan = { repos: [], addWrite: [], removeWrite: [], invite: [], errors: [] };
  try {
    let slug = INTERNAL_TEAM;
    if (!dry) slug = await internalTeam();
    const haveRepos = dry ? await githubAll('/orgs/' + GITHUB_ORG + '/teams/' + INTERNAL_TEAM + '/repos').catch(() => []) : await githubAll('/orgs/' + GITHUB_ORG + '/teams/' + slug + '/repos');
    const had = new Set(haveRepos.filter((r) => r.permissions && r.permissions.push).map((r) => r.name));
    for (const r of await githubAll('/orgs/' + GITHUB_ORG + '/repos?type=all')){
      if (r.archived || had.has(r.name)) continue;
      plan.repos.push(r.name);
      if (!dry) await githubApp('PUT', '/orgs/' + GITHUB_ORG + '/teams/' + slug + '/repos/' + GITHUB_ORG + '/' + r.name, { permission: 'push' }).catch((err) => plan.errors.push(r.name + ': ' + err.message));
    }
    const inTeam = new Set((await githubAll('/orgs/' + GITHUB_ORG + '/teams/' + INTERNAL_TEAM + '/members').catch(() => [])).map((m) => String(m.login).toLowerCase()));
    for (const d of (await db.collection('githubLinks').get()).docs){
      const l = d.data(), login = String(l.github || '').toLowerCase();
      if (!login || l.status === 'failed') continue;
      const high = await writesEverywhere(d.id), who = (l.name || d.id) + ' (' + login + ')';
      if (high && !inTeam.has(login)) plan.addWrite.push(who);
      if (!high && inTeam.has(login)) plan.removeWrite.push(who);
      if (l.status === 'outside') plan.invite.push(who);
      if (dry) continue;
      try {
        if (l.status === 'outside'){
          const r = await joinOrg(l.github, l.githubId);
          await d.ref.set({ status: r.status, error: r.error, updatedAt: Date.now() }, { merge: true });
        }
        if (high !== inTeam.has(login)) await setInternalWrite(login, high);
      } catch (err){ plan.errors.push(who + ': ' + err.message); }
    }
    if (!dry) for (const w of (await db.collection('projectWorkspaces').get()).docs) if (w.data().teamSlug) await syncWorkspace(w.id).catch((err) => plan.errors.push(w.id + ': ' + err.message));
  } catch (err){ plan.errors.push(String(err && err.message || err)); }
  await event.data.ref.set({ doneAt: Date.now(), plan }, { merge: true });
});

exports.onSetupNudgeRun = onDocumentCreated({ document: 'runs/{id}', secrets: [SLACK_BOT_TOKEN] }, async (event) => {
  const run = event.data && event.data.data();
  if (!run || run.action !== 'project-setup-nudge' || run.doneAt) return;
  const dry = run.dryRun === true, plan = [];
  for (const d of (await db.collection('projectWorkspaces').get()).docs) {
    const ws = d.data();
    if (ws.boardId || ws.completedAt || !(ws.startedAt || ws.meeting)) continue;   // ongoing by the old rule, not on a venue's board
    const migrate = !ws.startedAt && !!ws.meeting && setupMissing(ws).length > 0;
    const missing = setupMissing(ws);
    if (!migrate && !missing.length) continue;
    // Its lead only: whoever registered it (its card's submittedBy).
    const card = await cardRefFor(ws.cardId || d.id, ws.boardId || null).get().catch(() => null);
    const lead = card && card.exists ? lowerEmail((card.data().submittedBy || {}).email) : '';
    const to = ws.setupNudgedAt || !lead ? [] : [lead];
    plan.push({ pid: d.id, title: ws.title || (card && card.exists && card.data().title) || '', migrate, missing, to });
    if (dry) continue;
    if (migrate) await d.ref.set({ startedAt: Date.now(), startedBy: 'migration-2026-11-04' }, { merge: true });
    if (missing.length && to.length) {
      await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'project-setup', emails: to, headline: setupNudgeText(ws.title || (card && card.exists && card.data().title) || 'Your project', missing, projectPageUrl(ws.cardId || d.id, ws.boardId)) });
      await d.ref.set({ setupNudgedAt: Date.now() }, { merge: true });
    }
  }
  await event.data.ref.set({ doneAt: Date.now(), plan }, { merge: true });
});

// A group's first week (2026-11-03): what a group asks of a newcomer (its onboarding steps) is done
// after joining it, not before asking. When someone's group goes up (their join approved, as PAN-BOLD;
// a request accepted; a PI or admin setting it on People), their trial starts: onboarding/{email}.trial
// { group, startedAt, endsAt, done, doneAt, ended }. Two timers for that person alone (Cloud Tasks,
// trialCheck; no schedule): on day 5, if any are left, a Slack reminder with what's left; on day 7, if
// any still are, they're told, and so are the PIs and admins, who decide (nothing changes on its own).
// Done early, the timers do nothing. Whenever they do one of the things it asks (database triggers
// below, in the background), checkTrial looks again; all done → "Congratulations", and the trial ends.
const TRIAL_DAYS = 7, TRIAL_REMIND_DAY = 5, DAY_MS = 86400000;
const GROUP_RANK = { pan: 0, associate: 1, internal: 2, staff: 3, exec: 4 };
const stepsLeft = (steps) => ((steps && steps.steps) || []).filter((x) => !x.done).map((x) => x.label.charAt(0).toLowerCase() + x.label.slice(1));
// Pure: what a timer does now → 'nothing' | 'done' (all done: close it quietly) | 'remind' | 'end'.
function trialAction(stage, trial, data, group, steps){
  if (!trial || trial.done || trial.ended || trial.startedAt !== data.startedAt || trial.group !== data.group || group !== trial.group) return 'nothing';
  if (steps && steps.done) return 'done';
  return stage === 'remind' ? 'remind' : stage === 'end' ? 'end' : 'nothing';
}
function trialTexts(label, left, name){
  const list = left.join('; ');
  return {
    remind: '⏳ Two days left of your first week in ' + label + '. Still to do: ' + list + '. ' + linkedTitle('Your first steps', SITE_URL + 'onboarding.html') + '.',
    end: '⌛ Your first week in ' + label + ' is over, with this still to do: ' + list + '. ' + linkedTitle('Your first steps', SITE_URL + 'onboarding.html') + '. The PIs and admins have been told.',
    staff: '⌛ ' + slackText(name) + '’s first week in ' + label + ' is over, with this still to do: ' + list + '. You decide what happens next: ' + linkedTitle('People', SITE_URL + 'people.html') + '.',
    done: '🎉 Congratulations! You’ve done everything ' + label + ' asks of you in your first week.',
  };
}
async function startTrial(email, group){
  const at = Date.now(), trial = { group, startedAt: at, endsAt: at + TRIAL_DAYS * DAY_MS, done: false };
  if ((await onboardingFor(email)).done) Object.assign(trial, { done: true, doneAt: at });   // nothing left: no week to watch
  // The whole trial replaced (mergeFields), so nothing of an earlier week (its `ended`, `doneAt`) stays.
  await db.collection('onboarding').doc(email).set({ trial }, { mergeFields: ['trial'] });
  if (trial.done) return;
  // The emulator runs queued tasks at once, whatever their delay: there, the timers are fired by hand.
  if (process.env.FUNCTIONS_EMULATOR === 'true') { logger.info('Trial timers not queued in the emulator'); return; }
  const queue = getFunctions().taskQueue('locations/europe-west2/functions/trialCheck');
  for (const [stage, days] of [['remind', TRIAL_REMIND_DAY], ['end', TRIAL_DAYS]]) {
    await queue.enqueue({ email, group, startedAt: at, stage }, { scheduleDelaySeconds: days * 86400 })
      .catch((err) => logger.warn('Scheduling a trial timer failed', { stage, error: String(err && err.message || err) }));
  }
}
exports.trialCheck = onTaskDispatched({ retryConfig: { maxAttempts: 3, minBackoffSeconds: 300 }, secrets: [SLACK_BOT_TOKEN] }, async (req) => {
  const data = req.data || {}, email = String(data.email || '').toLowerCase();
  if (!email) return;
  const ref = db.collection('onboarding').doc(email), [marks, group] = await Promise.all([ref.get(), access.groupFor(email)]);
  const trial = marks.exists ? marks.data().trial : null;
  const steps = trial && !trial.done && !trial.ended ? await onboardingFor(email) : null;
  const what = trialAction(data.stage, trial, data, group, steps);
  if (what === 'nothing') return;
  if (what === 'done') { await ref.set({ trial: { done: true, doneAt: Date.now() } }, { merge: true }); return; }
  const m = await db.collection('members').doc(email).get(), name = (m.exists && m.data().name) || email;
  const t = trialTexts(GROUP_LABELS[trial.group], stepsLeft(steps), name), token = SLACK_BOT_TOKEN.value();
  if (what === 'remind') { await sendEvent(token, { key: 'group-trial', emails: [email], headline: t.remind }); return; }
  await sendEvent(token, { key: 'group-trial', emails: [email], headline: t.end });
  await sendEvent(token, { key: 'group-trial', emails: (await rolesEmails('pis')).concat(await rolesEmails('admins')), headline: t.staff });
  await ref.set({ trial: { ended: Date.now() } }, { merge: true });
});
// Meeting the next group's requirements (2026-11-03): PIs and admins are told, once per person and
// group, and decide (on People); nobody is moved up on their own. PAN-BOLD → BOLD-associate (added to
// someone's project) and BOLD-associate → BOLD-internal; a series they can't see yet doesn't count against
// them (they join it in their first week). Recorded in onboarding/{email}.eligible.<group>. Pilot group-eligible.
const NEXT_GROUP = { pan: 'associate', associate: 'internal' };
// Pure: the steps that count before joining: not a required series hidden from their group.
function eligibleSteps(steps, series, group){
  const hidden = new Set((series || []).filter((x) => (VIS_RANK_OF[x.visibleTo || 'internal'] || 0) > (VIS_RANK_OF[group] || 0)).map((x) => 'series:' + x.id));
  const kept = ((steps && steps.steps) || []).filter((x) => !hidden.has(x.key));
  return { steps: kept, done: kept.length > 0 && kept.every((x) => x.done) };
}
const VIS_RANK_OF = { public: 0, everyone: 1, pan: 1, associate: 2, internal: 3, staff: 4, exec: 5 };
function eligibleText(name, label, steps){
  // In their words, not the newcomer's ("fill in your details" → "their details filled in").
  const said = (x) => ({ details: 'their details filled in', read: 'the BOLDiquette read', project: 'on someone else’s project', own: 'a project of their own' })[x.key] ||
    (x.key.indexOf('series:') === 0 ? 'joined ' + x.label.replace(/^Join /, '') : x.label);
  return '🏷️ ' + slackText(name) + ' now meets what ' + label + ' asks: ' + steps.map(said).join(', ') + '. ' +
    'Nothing changes on its own: if you agree, ' + linkedTitle('set their group on People', SITE_URL + 'people.html') + '.';
}
async function checkEligible(email){
  try {
    email = String(email || '').toLowerCase();
    const group = await access.groupFor(email), next = NEXT_GROUP[group];
    if (!next) return;
    const ref = db.collection('onboarding').doc(email), marks = await ref.get();
    if (((marks.exists && marks.data().eligible) || {})[next]) return;
    const [steps, series, m] = await Promise.all([onboardingFor(email, next), db.collection('eventSeries').where('hidden', '==', false).get(), db.collection('members').doc(email).get()]);
    const e = eligibleSteps(steps, seriesFacts(series.docs), group);
    if (!e.done) return;
    await ref.set({ eligible: { [next]: Date.now() } }, { merge: true });
    await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'group-eligible', emails: (await rolesEmails('pis')).concat(await rolesEmails('admins')),
      headline: eligibleText((m.exists && m.data().name) || email, GROUP_LABELS[next], e.steps) });
  } catch (err){ logger.warn('checkEligible failed', { error: String(err && err.message || err) }); }
}
// After something they did: their first week, and whether they now meet the next group's requirements.
async function afterProgress(email){ await checkTrial(email); await checkEligible(email); }
// In the background, after something they did (database triggers only, so no click waits on it);
// never fails (logged instead).
async function checkTrial(email){
  try {
    email = String(email || '').toLowerCase();
    const ref = db.collection('onboarding').doc(email), marks = await ref.get(), trial = marks.exists ? marks.data().trial : null;
    if (!trial || trial.done || trial.ended || (await access.groupFor(email)) !== trial.group) return;
    if (!(await onboardingFor(email)).done) return;
    await ref.set({ trial: { done: true, doneAt: Date.now() } }, { merge: true });
    await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'group-ready', emails: [email], headline: trialTexts(GROUP_LABELS[trial.group], [], '').done });
  } catch (err){ logger.warn('checkTrial failed', { error: String(err && err.message || err) }); }
}
// Who's newly in a list, between two versions of a document.
const addedTo = (before, after, key) => {
  const was = new Set(((before && before[key]) || []).map((e) => String(e).toLowerCase()));
  return ((after && after[key]) || []).map((e) => String(e).toLowerCase()).filter((e) => !was.has(e));
};
// Joining a project (its workspace's members) or an event series (its `joined`).
exports.onProjectJoined = onDocumentWritten({ document: 'projectWorkspaces/{pid}', secrets: [SLACK_BOT_TOKEN] }, async (event) => {
  const b = event.data.before.exists ? event.data.before.data() : null, a = event.data.after.exists ? event.data.after.data() : null;
  for (const e of addedTo(b, a, 'members')) await afterProgress(e);
});
exports.onSeriesJoined = onDocumentWritten({ document: 'eventSeries/{id}', secrets: [SLACK_BOT_TOKEN] }, async (event) => {
  const b = event.data.before.exists ? event.data.before.data() : null, a = event.data.after.exists ? event.data.after.data() : null;
  for (const e of addedTo(b, a, 'joined')) await afterProgress(e);
});
// Marking the BOLDiquette read (written by the page: handbook/boldiquette/readers/{uid}).
exports.onBoldiquetteRead = onDocumentCreated(
  { document: 'handbook/boldiquette/readers/{uid}', secrets: [SLACK_BOT_TOKEN] },
  async (event) => { const d = event.data && event.data.data(); if (d && d.email) await afterProgress(d.email); }
);

// A member's request to be in another group, decided by the PIs and admins only (2026-11-02):
// - 'request': { to, note, accept: true, terms } → { id }, from group-request.html, where they
//   read what the group asks of them (its section of Who is BOLD) and tick that they accept it;
//   the terms they saw are kept on the request (`terms`, `acceptedAt`). One open request at a
//   time; DMs the PIs and admins.
// - 'withdraw': { id }: their own open request.
// - 'decide': { id, accept }: a PI or admin; accepting sets their group. DMs them.
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
      // Right after asking to join (join.html), before whoever invited them approves it: a second,
      // separate request, to the PIs and admins (2026-11-04). They join as PAN-BOLD meanwhile.
      const joining = m.exists ? null : (await db.collection('joinRequests').where('email', '==', email).where('status', '==', 'open').limit(1).get()).docs[0];
      if (!m.exists && !joining) throw new HttpsError('failed-precondition', 'Ask to join BOLD first.');
      const to = String(d.to || '');
      if (GROUPS.indexOf(to) < 0) throw new HttpsError('invalid-argument', 'Choose a group.');
      const from = m.exists ? groupOf(m.data()) : 'pan';
      if (to === from) throw new HttpsError('invalid-argument', 'You’re already in ' + GROUP_LABELS[to] + '.');
      const open = await col.where('email', '==', email).where('status', '==', 'open').limit(1).get();
      if (!open.empty) throw new HttpsError('already-exists', 'You already have a request waiting.');
      const name = (m.exists ? m.data().name : joining.data().name) || request.auth.token.name || email;
      const note = String(d.note || '').trim().slice(0, 1000);
      // What the group asks of a newcomer is done in its first week, after joining (trialCheck), not before.
      // The contract: what the group asks of them, as they read it, and that they accept it.
      const terms = String(d.terms || '').trim().slice(0, 20000);
      if (d.accept !== true || !terms) throw new HttpsError('failed-precondition', 'Read what ' + GROUP_LABELS[to] + ' asks of you and tick that you accept it first.');
      const ref = await col.add({ email, name, from, to, note, terms, acceptedAt: Date.now(), status: 'open', at: Date.now() });
      const deciders = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
      await sendEvent(token, { key: 'group-requests', emails: deciders, headline:
        '🏷️ ' + await numberTag(ref.path) + slackText(name) + ' asks to move from ' + GROUP_LABELS[from] + ' to ' + GROUP_LABELS[to] + ', and accepts what it asks of them' +
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
    const full = await isFullWrite(email);
    const accept = !!d.accept;
    const r = await db.runTransaction(async function(tx){
      const r = (await tx.get(ref)).data();
      if (!r) throw new HttpsError('not-found', 'That request isn’t there.');
      // Only PIs and admins decide a change of group (2026-11-02).
      if (!full) throw new HttpsError('permission-denied', 'Only PIs and admins decide a change of group.');
      if (r.status !== 'open') throw new HttpsError('failed-precondition', 'It’s already been decided.');
      // Asked for with their request to join: that one first (whoever invited them approves it).
      if (accept && !(await tx.get(db.collection('members').doc(r.email))).exists) throw new HttpsError('failed-precondition', 'Their request to join BOLD isn’t approved yet: whoever invited them approves it first.');
      tx.update(ref, { status: accept ? 'approved' : 'declined', decidedBy: email, decidedByName: request.auth.token.name || email, decidedAt: Date.now() });
      if (accept) tx.update(db.collection('members').doc(r.email), { category: r.to, categoryBy: email, categoryAt: Date.now(), categoryVia: 'request-' + Date.now() });
      return r;
    });
    await sendEvent(token, { key: 'group-requests', emails: [r.email], headline: accept
      ? '🏷️ You’re now ' + GROUP_LABELS[r.to] + ': ' + linkedTitle('what it gives you', SITE_URL + 'boldiquette.html#who-is-bold') + '.'
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
      'In Slack: Invite people → Copy invite link (the longest expiry), then ' + linkedTitle('add it under Settings', SITE_URL + 'settings.html') + ' with its new expiry date.';
    const staff = (await rolesEmails('pis')).concat(await rolesEmails('admins'));
    await sendEvent(SLACK_BOT_TOKEN.value(), { key: 'invite-link-reminder', emails: staff, headline });
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
    const tell = (to, text) => dmByEmail(token, to, text, 'letters');

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
      await tell(writerEmail, '✉️ ' + await numberTag(ref.path) + slackText(myName) + ' asked you for a recommendation letter: ' +
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
        ' is due ' + when + ' (' + r.deadline + '): ' + linkedTitle(slackText(q.purpose), letterUrl(x.id)) + '.', 'letters');
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
    const tell = (to, text) => dmByEmail(token, to, text, 'introductions');

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
      await tell(offererEmail, '🤝 ' + await numberTag(ref.path) + slackText(myName) + ' asked you for an introduction at ' + linkedTitle(slackText(o.org), introUrl(ref.id)) +
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
      for (const email of to) await dmByEmail(SLACK_BOT_TOKEN.value(), email, text, 'venue-calls');
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
  asked: 'joining', invited: 'joining', approved: 'joining', contact: 'joining', supervises: 'joining', 'signed-up': 'joining', moved: 'joining',
  coauthor: 'working', project: 'working', reviewed: 'working', meeting: 'working', introduced: 'working', letter: 'working',
  tagged: 'talking', replied: 'talking', decided: 'talking',
  registered: 'site', added: 'site', edited: 'site', proposed: 'site', commented: 'site', read: 'site',
  // Between two things, no one's doing: thing → thing2.
  presented: 'related', 'part-of': 'related',
};
const INTERACTION_TOP = ['joinRequests', 'members', 'studies', 'projects', 'projectWorkspaces', 'studyRequests', 'introRequests', 'letterRequests',
  'skills', 'guides', 'events', 'collabWeekSessions', 'groupRequests', 'groupMoves'];
// A move between groups, as its interaction's title: 'PAN-BOLD → BOLD-associate', or the new group alone.
const groupMoveTitle = (from, to) => (GROUP_LABELS[from] ? GROUP_LABELS[from] + ' → ' : '') + (GROUP_LABELS[to] || to);

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
  } else if (n === 2 && top === 'groupRequests'){
    // A move someone asked for, by whoever approved it.
    if (d.status === 'approved') add('moved', d.decidedBy, d.email, d.decidedAt, groupMoveTitle(d.from, d.to), SITE_URL + 'boldiquette.html#who-is-bold');
  } else if (n === 2 && top === 'groupMoves'){
    // A PI or admin setting someone's group on People (a request's own move is the request's).
    if (d.via !== 'request') add('moved', d.by, d.email, d.at, groupMoveTitle(d.from, d.to), SITE_URL + 'boldiquette.html#who-is-bold');
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

// Interactions that come from what's private whoever's group (BOLDiquette › Who can do what:
// letters, introductions, supervision requests, requests to join) are kept apart, in
// privateInteractions, which only the two people in each, PIs and admins read (firestore.rules).
const PRIVATE_INTERACTION_SOURCES = ['joinRequests', 'studyRequests', 'introRequests', 'letterRequests'];
const interactionsCol = (source) => PRIVATE_INTERACTION_SOURCES.indexOf(String(source || '').split('/')[0]) >= 0 ? 'privateInteractions' : 'interactions';

// Writes `want` ({ id: record }) in place of `have` ({ id: record }) in collection `name`:
// sets what's new or changed, deletes the rest.
async function replaceInteractions(have, want, name){
  const col = db.collection(name || 'interactions');
  let batch = db.batch(), n = 0;
  const step = async function(){ if (++n >= 400){ await batch.commit(); batch = db.batch(); n = 0; } };
  for (const id of Object.keys(have)) if (!want[id]) { batch.delete(col.doc(id)); await step(); }
  for (const id of Object.keys(want)) if (stableJson(have[id] || null) !== stableJson(want[id])) { batch.set(col.doc(id), want[id]); await step(); }
  if (n) await batch.commit();
}

async function syncInteractions(path, data){
  const name = interactionsCol(path), have = {};
  (await db.collection(name).where('source', '==', path).get()).docs.forEach(function(s){ have[s.id] = s.data(); });
  await replaceInteractions(have, await interactionRecords(path, data, {}), name);
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

// Moves between groups (Network › Lineage): groupMoves/{id} { email, from, to, by, at, via } (server
// only), one for each change of a member's group, whoever made it: on People, by a request
// (via 'request': its interaction is the request's), an agent, or a test account's owner. Joining
// (their first group) isn't a move. id: their email and when, so the backfill (rebuildInteractions,
// from members' current group) and this trigger write the same document.
const groupMoveId = (email, at) => crypto.createHash('sha1').update(String(email) + '|' + String(at)).digest('hex').slice(0, 28);
// Pure: a member's record before and after → the move, or null.
function groupMoveOf(email, b, a){
  b = b || {}; a = a || {};
  // No group on the record is PAN-BOLD (groupOf), so PAN-BOLD on joining is no move.
  const from = groupOf(b), to = groupOf(a);
  if (from === to) return null;
  const viaRequest = /^request/.test(String(a.categoryVia || '')) && a.categoryVia !== b.categoryVia;
  return { email: String(email).toLowerCase(), from, to, by: String(a.categoryBy || '').toLowerCase(), at: Number(a.categoryAt) || Date.now(), via: viaRequest ? 'request' : '' };
}
// Pure: the move a member's current group records, for those set before groupMoves (from
// unknown); null for PAN-BOLD on joining, or a request's (approved groupRequests have those).
function currentGroupMove(email, m){
  m = m || {};
  const at = Number(m.categoryAt) || 0, by = String(m.categoryBy || '').toLowerCase();
  if (!m.category || !at || !by || by === String(email).toLowerCase() || m.category === 'pan') return null;
  const via = /^request-(\d+)$/.exec(String(m.categoryVia || ''));
  if (via && Math.abs(Number(via[1]) - at) < 5000) return null;
  return { email: String(email).toLowerCase(), from: '', to: m.category, by, at, via: '' };
}
exports.onGroupMove = onDocumentUpdated('members/{email}', async (event) => {
  const mv = groupMoveOf(event.params.email, event.data.before.data(), event.data.after.data());
  if (mv) await db.collection('groupMoves').doc(groupMoveId(mv.email, mv.at)).set(mv);
});

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
    // Moves made before groupMoves: each member's current group, if someone set it (create: never over a logged one).
    for (const m of (await db.collection('members').get()).docs){
      const mv = currentGroupMove(m.id, m.data());
      if (mv) await db.collection('groupMoves').doc(groupMoveId(mv.email, mv.at)).create(mv).catch(function(){});
    }
    const docs = [];
    for (const c of INTERACTION_TOP) (await db.collection(c).get()).docs.forEach(function(s){ docs.push(s); });
    for (const g of ['cards', 'versions', 'readers', 'comments', 'proposals', 'presentations'])
      (await db.collectionGroup(g).get()).docs.forEach(function(s){ if (isInteractionSource(s.ref.path)) docs.push(s); });
    const want = { interactions: {}, privateInteractions: {} }, slackEmails = {};
    for (const s of docs) Object.assign(want[interactionsCol(s.ref.path)], await interactionRecords(s.ref.path, s.data(), slackEmails));
    for (const name of Object.keys(want)){
      const have = {};
      (await db.collection(name).get()).docs.forEach(function(s){
        const src = String(s.data().source || '');
        if (src.indexOf('auth/') === 0 || /#tags$/.test(src)) return;
        have[s.id] = s.data();
      });
      await replaceInteractions(have, want[name], name);
    }
    // First sign-ins, from Firebase Auth.
    try {
      let page;
      do {
        page = await admin.auth().listUsers(1000, page && page.pageToken);
        for (const u of page.users) if (u.email) await recordSignUp(u.uid, String(u.email).toLowerCase());
      } while (page.pageToken);
    } catch (err){ logger.warn('Listing first sign-ins failed', { error: String(err && err.message || err) }); }
    return { count: Object.keys(want.interactions).length + Object.keys(want.privateInteractions).length, sources: docs.length };
  }
);

// A DM to each PI and admin, once each, but not to `except` (whoever caused it), as feature `key`.
async function tellStaff(text, except, key){
  const skip = String(except || '').toLowerCase();
  const emails = Array.from(new Set((await rolesEmails('pis')).concat(await rolesEmails('admins')).map((e) => String(e).toLowerCase()))).filter((e) => e !== skip);
  if (emails.length) await sendEvent(SLACK_BOT_TOKEN.value(), { key, emails, headline: text });
}

// BOLD.OS for agents: personal tokens (apiTokens) and the read-only API and MCP
// endpoint (boldApi), in functions/api.js.
const agentApi = require('./api')({ access, db, admin, onRequest, onCall, HttpsError, logger, callerEmail, isFullWrite, allProjectsFromCards, projectGroupForCards, workspaceStarted, groupOf, SITE_URL,
  SIGN_IN_PROVIDER, secrets: [SLACK_BOT_TOKEN, GOOGLE_OAUTH, GITHUB_APP], SLACK_BOT_TOKEN,
  // Asking to act, and the decision: the PIs and admins hear of a request, its owner of the decision.
  tellStaff,
  tellPerson: (email, text, key) => sendEvent(SLACK_BOT_TOKEN.value(), { key, emails: [email], headline: text }),
  slackText, linkedTitle, joinPageUrl, skillMd, onSchedule,
  callables: () => ({ projectWorkspace: exports.projectWorkspace, projectWork: exports.projectWork, projectChannel: exports.projectChannel, introRequest: exports.introRequest, studyRequest: exports.studyRequest,
    letterRequest: exports.letterRequest, decideProposal: exports.decideProposal, branchCommit: exports.branchCommit, branchMeta: exports.branchMeta, decideBranch: exports.decideBranch, groupRequest: exports.groupRequest, setMyInviter: exports.setMyInviter,
    confirmJoinInvite: exports.confirmJoinInvite, decideJoinRequest: exports.decideJoinRequest, joinChanges: exports.joinChanges, myRequests: exports.myRequests, eventSeries: exports.eventSeries, profilePhoto: exports.profilePhoto, commentConversation: exports.commentConversation }) });
exports.apiTokens = agentApi.apiTokens;
exports.boldApi = agentApi.boldApi;
// Subscribing to the Calendar: one private .ics link a person (calendar.html; served by boldApi).
exports.calendarFeed = agentApi.calendarFeed;
// Recurring lab meetings (series.html, Events): functions/series.js.
const labSeries = require('./series')({ db, onCall, onDocumentWritten, HttpsError, logger, callerEmail, isFullWrite, access, rolesEmails,
  googleFetch, syncMoves, CAL, calendarUpdates, isCalendarLimit, CALENDAR_LIMIT_MSG, eventConference, eventTimes, conferenceChange, meetingRecurrence, sameMeetingTimes, seriesStart,
  normalizeMeeting, googleAddressesFor, groupOf, tellStaff, slackText, linkedTitle, SITE_URL, GOOGLE_OAUTH, SLACK_BOT_TOKEN, FieldValue, crypto,
  onSchedule, tellPeople: (emails, text, key) => sendEvent(SLACK_BOT_TOKEN.value(), { key, emails, headline: text }) });
exports.eventSeries = labSeries.eventSeries;
exports.onMemberGroupChanged = labSeries.onMemberGroupChanged;
exports.seriesNudges = labSeries.seriesNudges;
exports.onOccurrenceWritten = labSeries.onOccurrenceWritten;

// Every hour: the syncs Google's calendar limit stopped (calendarLimitAt; see isCalendarLimit), oldest
// first, a few at a time; a run stops at the first still refused, the limit not lifted yet.
const CALENDAR_RETRIES = [
  ['projectWorkspaces', (id) => syncWorkspace(id)],
  ['studies', (id) => syncStudyMeeting(id)],
  ['eventSeries', (id) => labSeries.syncSeries(id)],
  ['eventInvites', (id) => labSeries.syncOccurrence(id)],
];
exports.retryCalendarLimits = onSchedule({ schedule: 'every 60 minutes', secrets: [GOOGLE_OAUTH, SLACK_BOT_TOKEN, GITHUB_APP], timeoutSeconds: 540 }, async function(){
  const todo = [];
  for (const [col, sync] of CALENDAR_RETRIES){
    const snap = await db.collection(col).where('calendarLimitAt', '>', 0).get();
    snap.docs.forEach((d) => todo.push({ col, sync, id: d.id, at: d.data().calendarLimitAt }));
  }
  todo.sort((a, b) => a.at - b.at);
  let done = 0;
  for (const t of todo.slice(0, 10)){
    try { await t.sync(t.id); } catch (err){ logger.warn('Retrying a calendar sync failed', { col: t.col, id: t.id, error: String(err && err.message || err) }); }
    const after = (await db.collection(t.col).doc(t.id).get()).data() || {};
    if (after.calendarLimitAt) { logger.info('Google\u2019s calendar limit is still on', { left: todo.length - done }); break; }
    done++;
  }
  if (todo.length) logger.info('Calendar retries', { waiting: todo.length, done });
});

// Meetings about to start (2026-11-05): 5 minutes before a project's meeting, a study meeting or a
// recurring event's, everyone it invites gets a notification (Inbox and desktop, not Slack) with Join.
// Only meetings in Google Calendar (eventId), not paused, not past their end date, and on their week
// for one every N weeks (from eventStart, as calendar.html places it). Each once: meetingReminders/{key}.
// Pure: minutes until `m` starts if that's 1–5 from now (London's `todayIso` and `nowHm`), else 0.
function meetingStartsSoon(m, start, todayIso, nowHm){
  if (!m || !m.day || !m.time) return 0;
  const d = new Date(todayIso + 'T00:00:00Z');
  if (WEEKDAYS[(d.getUTCDay() + 6) % 7] !== m.day) return 0;
  if (m.until && m.until < todayIso) return 0;
  if (start){
    if (todayIso < start) return 0;
    const weeks = Math.round((Date.parse(todayIso) - Date.parse(start)) / (7 * 86400000));
    if (weeks % (m.every || 1) !== 0) return 0;
  }
  const mins = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const left = mins(m.time) - mins(nowHm);
  return left >= 1 && left <= 5 ? left : 0;
}
exports.meetingReminders = onSchedule({ schedule: '*/5 * * * *', timeZone: PROJECT_TZ }, async function(){
  const today = todayIsoLondon(), now = nowHmLondon();
  const code = WEEKDAYS[(new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7];
  // On today's weekday, or with a date moved to today (meeting-moves.js), each once.
  const both = async (col) => {
    const [a, b] = await Promise.all([db.collection(col).where('meeting.day', '==', code).get(), db.collection(col).where('movedTo', 'array-contains', today).get()]);
    const seen = new Set();
    return { docs: a.docs.concat(b.docs).filter((d) => !seen.has(d.id) && seen.add(d.id)) };
  };
  const [wsSnap, seriesSnap, studySnap] = await Promise.all([both('projectWorkspaces'), both('eventSeries'), both('studies')]);
  const due = [];
  wsSnap.docs.forEach((d) => { const w = d.data();
    if (w.eventId && !w.pausedAt && w.group !== 'completed') due.push({ key: 'project-' + d.id, m: w.meeting, moved: w.meetingMoved, start: w.eventStart, title: w.title || 'Your project', to: w.members || [], join: w.meetUrl || w.eventLink || '', href: projectPageUrl(w.cardId || d.id, w.boardId) });
  });
  seriesSnap.docs.forEach((d) => { const x = d.data();
    if (x.eventId && !x.pausedAt && !x.hidden && x.kind !== 'editions') due.push({ key: 'series-' + d.id, m: x.meeting, moved: x.meetingMoved, start: x.eventStart, title: x.title || 'A meeting', to: x.guests || [], join: x.meetUrl || x.eventLink || '', href: SITE_URL + 'series.html?series=' + encodeURIComponent(d.id) });
  });
  studySnap.docs.forEach((d) => { const x = d.data();
    if (x.eventId && !x.pausedAt) due.push({ key: 'study-' + d.id, m: x.meeting, moved: x.meetingMoved, start: x.eventStart, title: (x.name || d.id) + '\u2019s ' + (x.degree === 'Master student' ? 'Master' : 'PhD') + ' meeting', to: [d.id].concat((x.people || []).map((p) => p.email)), join: x.meetUrl || x.eventLink || '', href: SITE_URL + 'calendar.html' });
  });
  for (const x of due){
    // Today's date of it, moved or not: as a meeting of its own today.
    const t = x.m && meetingMoves.occurrences(x.m, x.start, x.moved, today, today)[0];
    if (!t) continue;
    x.m = Object.assign({}, x.m, { day: code, time: t.time, minutes: t.minutes, every: 1 });
    const left = meetingStartsSoon(x.m, '', today, now);
    if (!left || !x.to.length) continue;
    // Once per meeting and day, however many runs see it.
    try { await db.collection('meetingReminders').doc(x.key + '-' + today + '-' + x.m.time.replace(':', '')).create({ at: Date.now(), to: x.to.length }); }
    catch (err){ continue; }
    const endsAt = Date.now() + (left + (x.m.minutes || 60)) * 60000;
    await noteFor(x.to, { source: 'bold', feature: 'meeting-soon', text: '\u201c' + x.title + '\u201d starts in ' + left + ' minute' + (left === 1 ? '' : 's') + '.', href: x.join || x.href, join: x.join, endsAt });
  }
});
// A public event's content, cut down for whoever can't read it directly (signed out, PAN-BOLD).
exports.publicEvent = require('./public-event')({ db, onCall, HttpsError }).publicEvent;
// Slack threads into Conversations (functions/slack-thread.js): Import from Slack on the page, Take it to the BOLD OS in Slack.
const conversationsSlack = require('./slack-thread')({ db, onCall, onDocumentCreated, onDocumentUpdated, HttpsError, logger, SLACK_BOT_TOKEN, signedInEmail, access, slackIdForEmail, FieldValue, SITE_URL, postInChannel, slackText, nudgeInThread, noteFor, dmByEmail, emailForSlackId, rolesEmails });
exports.slackThread = conversationsSlack.slackThread;
// A comment thread on the BOLDiquette or a guide, or a board card's comments, made a conversation (functions/comment-conversation.js).
exports.commentConversation = require('./comment-conversation')({ db, onCall, HttpsError, signedInEmail, access, FieldValue, SITE_URL, rank: accessLib.rank, guideArea: accessLib.guideArea, projectPageUrl }).commentConversation;
exports.onConversationImport = conversationsSlack.onConversationImport;
exports.onConversationMessage = conversationsSlack.onConversationMessage;
exports.onConversationCreated = conversationsSlack.onConversationCreated;
exports.onConversationAccess = conversationsSlack.onConversationAccess;
exports.onConversationInvite = conversationsSlack.onConversationInvite;
// Desktop notifications (functions/push.js): each person's devices, and a push with each notification
// (noteFor calls webPush.pushTo, once everything above is defined).
const webPush = require('./push')({ db, admin, onCall, HttpsError, signedInEmail, logger, SITE_URL });
exports.pushDevices = webPush.pushDevices;
// Notifications for what someone is part of (functions/notify.js): projects, cards, parts, skills and tools, editions, their group.
const partNotes = require('./notify')({ db, onDocumentWritten, onDocumentUpdated, onDocumentCreated, deliver, logger, SITE_URL, projectPageUrl, guideUrl, handbookUrl, skillUrl, toolUrl, eventUrl, GROUP_LABELS, numberTag });
Object.keys(partNotes).forEach((k) => { exports[k] = partNotes[k]; });
// Where the tools agents add run: no credentials, as whoever calls them (functions/sandbox.js).
exports.mcpSandbox = require('./sandbox')({ onRequest, logger }).mcpSandbox;
// Claude reviews each proposed tool for whoever decides (functions/reviewer.js); needs ANTHROPIC_API_KEY.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
exports.reviewMcpChange = require('./reviewer')({ db, onDocumentWritten, logger, ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, slackText, linkedTitle, SITE_URL,
  tellStaff }).reviewMcpChange;
// BOLD LLM, the home letter and Talking to BOLD (functions/bold-llm.js): Claude until Sofya runs, reading as
// each person through the agents' API (letterInputs, its reading tools).
const boldLlm = require('./bold-llm')({ db, admin, logger, onCall, onSchedule, HttpsError, callerEmail, access, ANTHROPIC_API_KEY,
  letterInputs: agentApi.letterInputs, chatTools: agentApi.chatTools, runChatTool: agentApi.runChatTool });
exports.writeHomeLetters = boldLlm.writeHomeLetters;
exports.homeLetter = boldLlm.homeLetter;

exports._internal = { replaceEmail, accountEmailsBySlackId, calendarUpdates, isCalendarLimit, meetingStartsSoon,
  slackImagesOf, slackToPlain, pingText, bugReportOf, bugNotes, bugTitle,
  channelsToJoin, setupMissing, setupMissingText, workspaceStarted, normalizeRepo, setupNudgeText, projectHealth,
  trialAction, trialTexts, stepsLeft, addedTo, eligibleSteps, eligibleText, onOthers,
  projectTitlesOnly, markJoined, projectTitleDoc, githubLoginsFor, mergedEdit,
  projectGroupForCard, allProjectsFromCards, closesIssues, githubWorkItem, requestColumn, proposalPlace, workRole, splitRequests, numberKey, repoNameOf, normalizeRepo, normalizeProjectChannel, keywordCounts,
  flattenMessages, newMessages, cardEventsToNotify, homeRefreshTargetsForReviewers,
  newlyAddedAuthorEmails, reviewsOutCandidates, todayIsoLondon, venueUrl, cardUrl, linkedTitle,
  reviewStateEmoji, verifySlackSignatureRaw, nearestChannel, pilotSlack, appliedProposal, proposalSummary, proposalOutcome, proposalClosed, projectAnnouncement, commentQueueDue, commentRecipients, commentDigest, pilotStateOf, sendEvent, cardTalkRecipients, cardTalkDigest, cardDoneText, canAssignReviewer, parseAssignAction,
  reviewerEmailFromAction, cardLine, personOptionsFor, filterPeopleOptions, initialOptionForEmail,
  reviewerPickerBlock, sectionBlocks, buildHomeView, buildUnrecognizedView, profileFieldsFromSlack,
  projectsFromDashboard, badgesForCard, skillMd, skillZip, versionContent, stableJson,
  normalizeMeeting, firstMeetingTimes, meetingRecurrence, projectMembers, normalizeRepo, projectRepoName,
  projectIdOf, projectGroupForCards, workspaceStarted, normalizeJoinRequest, welcomeEmail, mimeMessage, joinChangesRefusal, joinChangesKeyRefusal, joinChangesEmail, joinChangesView, joinChangesProposed, joinChangesLines, keyHash,
  onboardingSteps, inviteRefusal, normalizeLetterRequest, letterRemindersDue, normalizeStudies, groupOf, channelGroupsFor, seriesStart, normalizeSupervisionChannel, supervisionChannelFor, inviteReminderStage, taggedIds, proposalNewTags, newTags, tagPlace, tagExcerpt, tagMessageId, venueCallsToCheck, venueCallMessage, interactionsFor, isInteractionSource, thingOf, slackExternal, groupMoveOf, currentGroupMove, groupMoveTitle, normalizeGpuHours, proposalPending, inviteChoices, validInviteTo, projectChannelChange, alignmentPlan, alignmentMessage, groupChannelsFor, allGroupChannels, alignmentNow, runAlignment
};

// For tests and the test copy: the home letter's inputs as someone (functions/bold-llm.js).
exports._internal.letterInputs = (who, since) => agentApi.letterInputs(who, since);
