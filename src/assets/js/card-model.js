"use strict";

// The paper/project card — the one data model behind both "+ Register paper"
// on the Internal Review Board and "+ Register project" on the Projects page.
// A project IS a card (boards/{venue}/cards/{id}, status 'register'): anything
// registered from either place goes through makeRegisteredCard() and then the
// same Internal Review process. Plain functions/vars, no DOM or Firebase, so
// any page can load it.

  // Each item folds together what used to be several sibling checks in the
  // same category (see changelog) \u2014 same substance, fewer ticks. Every
  // item is still worked through twice (junior + senior). 12 items: the
  // Submission-system category was dropped (it's what the OpenReview form
  // covers anyway, not something the draft needs an internal check for).
  var CHECKLIST_TEMPLATE = [
    { part: 'format', category: 'Mandatory sections & parts', label: 'All required sections and disclosure forms are present and filled in, not left as templates (e.g. limitations, ethics statement, paper checklist) \u2014 and everything the main text references in the appendix actually exists there' },
    { part: 'format', category: 'Length & page limits', label: "Main paper and every section-specific limit (abstract word count, appendix pages, etc.) are within bounds \u2014 without manually shrinking margins, font, or spacing to fit more in" },
    { part: 'format', category: 'Double-blind anonymity', label: "No identity anywhere in the PDF \u2014 no author names or affiliations (including acknowledgments), and nothing identifying in the file's title/author metadata" },
    { part: 'format', category: 'Double-blind anonymity', label: 'No identity outside the PDF either \u2014 linked code/data repos are anonymized (README, commit history, filenames) and self-citations are phrased in the third person' },
    { part: 'format', category: 'Template & formatting', label: 'Latest official venue template (not a copy from a previous year), compiles cleanly with no missing figures / broken references / warnings, and fonts / page size are correct' },
    { part: 'format', category: 'Policy compliance', label: "Not in violation of the venue's dual-submission / prior-publication policy, and any arXiv or preprint posting follows its timing policy" },
    { part: 'science', category: 'Claimed contributions', label: 'Contributions are stated clearly (ideally a short, explicit list) and checked against the paper\u2019s actual evidence \u2014 nothing in the abstract or intro claims more than the results show' },
    { part: 'science', category: 'Correctness', label: 'Theoretical claims: proofs are correct, with reasonable and clearly-stated assumptions' },
    { part: 'science', category: 'Correctness', label: 'Empirical claims: experiments are well-designed with fair, non-strawman baselines, and the results shown actually support the conclusions drawn from them' },
    { part: 'science', category: 'Impact', label: 'The problem is relevant to the target community, others could plausibly build on it, and the scope of impact is honestly represented \u2014 not oversold, not undersold' },
    { part: 'science', category: 'Limitations', label: 'Limitations and known failure modes or negative results are disclosed honestly \u2014 not buried or omitted' },
    { part: 'science', category: 'Related work & positioning', label: 'Prior work is represented accurately, the contribution is clearly differentiated from the closest prior work, and nothing obviously relevant is missing' }
  ];

  // Two different shapes depending on part (2026-09-14, see
  // authorChecklistComplete/roleChecklistComplete): a format item is
  // ticked once, by any author — authorChecked, no junior/senior at all.
  // A science item keeps the original per-reviewer shape — junior/senior,
  // no authorChecked. Never both on the same item; which fields an item
  // carries is itself how the rest of the file tells the two checklists
  // apart, alongside `part`.
  function makeChecklistSnapshot(){
    return CHECKLIST_TEMPLATE.map(function(item, i){
      var base = { id: 'chk-' + (i + 1), part: item.part, category: item.category, label: item.label, comments: [] };
      return item.part === 'format'
        ? Object.assign(base, { authorChecked: false })
        : Object.assign(base, { junior: false, senior: false });
    });
  }

  // ---- The abstract field: limit, counter, LaTeX rendering, and the editor ----
  // Abstract text may contain LaTeX ($inline$ / $$block$$, plain-text-typed
  // by whoever filled the field in — see the Edit-fields modal) — render
  // those spans with KaTeX, everything else as plain escaped text. A
  // single regex pass, block delimiters checked first so "$$" is never
  // mistaken for two empty inline formulas. KaTeX's own output is safe
  // HTML (no user string reaches the DOM unescaped outside of it), and a
  // formula KaTeX can't parse falls back to its literal source rather
  // than breaking the whole abstract.
  // Hard limit on the abstract's length (2026-09-18+34, per Eduardo), in
  // characters of the raw text (LaTeX source included).
  var ABSTRACT_MAX_CHARS = 5000;
  function abstractCounterText(length){
    return 'Characters remaining: ' + (ABSTRACT_MAX_CHARS - length);
  }

  function renderAbstractHtml(text){
    if (!text) return '';
    if (typeof katex === 'undefined') return BOLD.escapeHtml(text);
    var out = '';
    var lastIndex = 0;
    var re = /\$\$([\s\S]+?)\$\$|\$([^\$\n]+?)\$/g;
    var m;
    while ((m = re.exec(text))){
      out += BOLD.escapeHtml(text.slice(lastIndex, m.index));
      var isBlock = m[1] !== undefined;
      var src = isBlock ? m[1] : m[2];
      try {
        out += katex.renderToString(src, { throwOnError: false, displayMode: isBlock });
      } catch (err){
        out += BOLD.escapeHtml(m[0]);
      }
      lastIndex = re.lastIndex;
    }
    out += BOLD.escapeHtml(text.slice(lastIndex));
    return out;
  }

  // The abstract textarea + Preview — shared by the Submit-the-abstract
  // form and the inline abstract editor on the card details (same editor
  // in both places, 2026-09-18+32, per Eduardo).
  function abstractTextFieldHtml(text, disabledAttr){
    var len = (text || '').length;
    return '<div class="field"><label for="stageAbstractText">Abstract</label><textarea id="stageAbstractText" maxlength="' + ABSTRACT_MAX_CHARS + '"' + (disabledAttr || '') + ' placeholder="Paste the abstract text. LaTeX is fine, typed as plain text: $inline formula$ or $$block formula$$.">' + BOLD.escapeHtml(text || '') + '</textarea>' +
      '<div class="abstract-counter' + (len > ABSTRACT_MAX_CHARS ? ' over' : '') + '" id="stageAbstractCounter">' + abstractCounterText(len) + '</div>' +
      '<button class="btn-text" type="button" id="stageAbstractPreviewBtn" style="margin-top:6px;">Preview</button>' +
      '<div class="abstract-render abstract-preview" id="stageAbstractPreview" hidden></div>' +
    '</div>';
  }

  // Abstract preview (2026-09-18+30, per Eduardo): renders the textarea's
  // LaTeX ($inline$ / $$block$$) with the same renderAbstractHtml the
  // details use; stays live while open.
  function wireAbstractPreview(){
    var previewBtn = document.getElementById('stageAbstractPreviewBtn');
    var previewBox = document.getElementById('stageAbstractPreview');
    var previewText = document.getElementById('stageAbstractText');
    if (previewBtn && previewBox && previewText){
      var refreshPreview = function(){
        previewBox.innerHTML = previewText.value.trim()
          ? renderAbstractHtml(previewText.value)
          : '<span style="color:var(--muted);">Nothing to preview yet.</span>';
      };
      previewBtn.addEventListener('click', function(){
        var opening = previewBox.hidden;
        previewBox.hidden = !opening;
        previewBtn.textContent = opening ? 'Hide preview' : 'Preview';
        if (opening) refreshPreview();
      });
      previewText.addEventListener('input', function(){ if (!previewBox.hidden) refreshPreview(); });
    }
    // "Characters remaining" under the textarea, live.
    var counter = document.getElementById('stageAbstractCounter');
    if (counter && previewText){
      previewText.addEventListener('input', function(){
        counter.textContent = abstractCounterText(previewText.value.length);
        counter.className = 'abstract-counter' + (previewText.value.length > ABSTRACT_MAX_CHARS ? ' over' : '');
      });
    }
  }

  // The project's Slack channel, as typed → { name, prefixed } (no '#', lowercase,
  // always starting with "proj-"; `prefixed` = the prefix was added) or { error }.
  // For the form's live hint; the projectChannel Cloud Function
  // (functions/index.js) applies the same rules for real — keep them in sync.
  function normalizeProjectChannel(input){
    var name = String(input || '').trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (!name) return { error: 'Enter a channel name.' };
    if (!/^[a-z0-9_-]+$/.test(name)) return { error: 'Use letters, numbers, hyphens and underscores only.' };
    var prefixed = name.indexOf('proj-') !== 0;
    if (prefixed) name = 'proj-' + name;
    if (name === 'proj-') return { error: 'Add a name after proj-.' };
    if (name.length > 80) return { error: 'Slack channel names can be at most 80 characters.' };
    return { name: name, prefixed: prefixed };
  }

  // Keywords: lowercase, single-spaced, at most KEYWORD_MAX_CHARS long; a card
  // holds at most KEYWORDS_MAX. normalizeKeyword() returns '' for nothing usable.
  var KEYWORD_MAX_CHARS = 40;
  var KEYWORDS_MAX = 10;
  function normalizeKeyword(input){
    return String(input || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, KEYWORD_MAX_CHARS).trim();
  }

  // A newly registered card. `user` is { name, email } (the signed-in person —
  // never typed in); `fields` is { title, computeEstimate?, note?,
  // abstractText?, slackChannel? }. Field-by-field notes are inline.
  function makeRegisteredCard(user, fields, now){
    now = now || Date.now();
    var submittedByName = user.name || user.email;
    return {
      id: 'card-' + now + '-' + Math.random().toString(36).slice(2, 8),
      title: fields.title,
      // Authors and the Overleaf link aren't known yet at registration —
      // there's no first draft to point to and no locked-in author list
      // this early (2026-09-18, per Eduardo). Both get filled in via Edit
      // fields once the abstract itself is ready, at Submit the abstract;
      // see onSaveEdit for where the PI-defaults-to-senior-reviewer
      // assignment actually happens now, deferred from here for the same
      // reason.
      authors: [],
      authorEmails: [],
      overleafLink: '',
      correspondingAuthorEmail: user.email,
      computeEstimate: fields.computeEstimate || '',
      // Free text, filled in later (Edit fields) once the abstract itself
      // is written — not required at registration, not a deliverable gate
      // (unlike pitchLink/submissionLink/etc. below). May contain LaTeX,
      // typed as plain $inline$/$$block$$ — see renderAbstractHtml.
      abstractText: fields.abstractText || '',
      // Free-form tags, see normalizeKeyword; suggested from the ones already in use.
      keywords: fields.keywords || [],
      // The project's Slack channel, "#name" (Projects page registration).
      slackChannel: fields.slackChannel || '',
      status: 'register',
      submittedBy: { name: submittedByName, email: user.email, slackId: null },
      // Senior reviewer defaults to the PI once authors actually exist —
      // see onSaveEdit, which sets this the first time authors are saved,
      // since there's no author list yet at registration to default from.
      reviewers: { junior: '', senior: '' },
      jrReviewState: 'in_review',
      srReviewState: 'in_review',
      // Abstract's own lightweight go/no-go (2026-09-18+4) — a direct
      // tri-state set by the senior reviewer's Approve/Request changes
      // buttons, not derived from a checklist at all (unlike
      // jrReviewState/srReviewState above, which drive the Paper stage's
      // checklist-based reviewFilterState instead). See
      // advanceBlockReason's abstract->paper gate and reviewStateBadgeHtml.
      abstractReviewState: 'in_review',
      outcome: '',
      // Deliverable-per-stage redesign (2026-09-18, per Eduardo): each
      // link below is what its stage's own advance gate requires before
      // the Submit-X button unblocks — see advanceBlockReason and
      // ADVANCE_LABELS. pitchLink (Register -> Pitch), submissionLink
      // (Paper -> Rebuttal — moved 2026-09-18+3 to Abstract -> Rebuttal
      // while `paper` was briefly folded into `abstract`, moved back here
      // 2026-09-18+4 now that `paper` is its own stage again),
      // rebuttalDocLink (Rebuttal -> Camera-ready), cameraReadyLink
      // (Camera-ready -> Conference). arxivLink is deliberately NOT a gate
      // (2026-09-18+3) — arXiv posting is concurrent to sitting in
      // Rebuttal, addable any time, not required to leave anywhere.
      // reviewsOutNotifiedAt: null until the scheduled notifyReviewsOut
      // function (functions/index.js) sets it, once the venue's own
      // reviews-release date passes — drives the Rebuttal badge's
      // Waiting-for-reviews -> In-Rebuttal flip and the one-time Slack DM
      // that goes with it (see renderCard's rebuttal badge).
      pitchLink: null,
      submissionLink: null,
      arxivLink: null,
      rebuttalDeadline: null,
      rebuttalDocLink: null,
      cameraReadyLink: null,
      reviewsOutNotifiedAt: null,
      reviewNotes: '',
      checklist: makeChecklistSnapshot(),
      discussion: [],
      history: [{ timestamp: now, actor: submittedByName, action: 'registered', note: fields.note || '' }],
      createdAt: now,
      updatedAt: now
    };  }
