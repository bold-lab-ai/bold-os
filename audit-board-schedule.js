"use strict";

  // ---------- internal deadline schedule + .ics ----------

  function pad2(n){ return n < 10 ? '0' + n : '' + n; }

  function shiftWeeks(iso, weeks){
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() - weeks * 7);
    return d;
  }
  function toIsoDate(d){
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // The internal buffer before every venue date that actually requires us
  // to deliver something (submit an abstract, submit the paper, respond to
  // a rebuttal, send camera-ready) — not the purely passive ones (reviews
  // released, notification), where there's nothing for us to buffer
  // against. One source for both this rail and the Rush column headers
  // (below): the authors' internal cutoff is RUSH_BUFFER_HOURS before the
  // venue's deadline, the reviewers' is RUSH_REVIEW_BUFFER_HOURS before
  // it (author submits internally -> reviewer responds -> author
  // incorporates changes or it goes out as-is), so the two can't drift.
  var RUSH_BUFFER_HOURS = 48;
  var RUSH_REVIEW_BUFFER_HOURS = 24;
  var BUFFER_DAYS = RUSH_BUFFER_HOURS / 24;
  var REVIEWER_BUFFER_DAYS = RUSH_REVIEW_BUFFER_HOURS / 24;
  var BUFFER_KEYS = { paper: 1, abstract: 1, rebuttal_deadline: 1, camera_ready: 1 };
  // Only the two stages that have a reviewer gate on the board get a
  // reviewer date (2026-09-18+21, per Eduardo — aligned with the column
  // headers): abstract (senior go/no-go) and paper (both checklists).
  // Rebuttal and camera-ready have no reviewer step, so no reviewer date.
  var REVIEWER_KEYS = { paper: 1, abstract: 1 };

  // Every dated milestone for a venue, chronological. Needs v.deadline.
  function internalSchedule(v){
    if (!v || !v.deadline) return [];
    function wk(n){ return wrap(shiftWeeks(v.deadline, n), n + (n === 1 ? ' week before' : ' weeks before')); }
    function wrap(dateObj, derivation){ return { dateObj: dateObj, derivation: derivation }; }
    function on(iso, derivation){ return { dateObj: new Date(iso + 'T00:00:00'), derivation: derivation }; }
    // Every deadline we have to deliver against (abstract, paper,
    // rebuttal, camera-ready) uses the AoE-corrected London calendar
    // date, not the bare stored one — the same instant the column headers
    // and the Overdue badges count against (deadlineInstant), so this
    // rail always agrees with them. Reviews-released/notification are
    // plain venue dates, and the working-backward dates via wk() are
    // ours, so they stay as stored.
    function onDeadline(iso, derivation){
      var correctedIso = londonDeadlineDateIso(iso);
      if (!correctedIso) return null;
      // `instant` is the real AoE moment the deadline passes — what the
      // column headers turn red on, and so what the rail's red keys off.
      return Object.assign(on(correctedIso, derivation), { instant: deadlineInstant(iso) });
    }

    // The 8/6/4/2/1-week runway is the normal-mode pipeline; Rush mode has
    // no Pitch column and replaces it with the 48h/24h cutoffs, so those
    // rows would show dates the board doesn't hold anyone to.
    var runway = [
      Object.assign({ key: 'register', label: 'Register', short: 'Register',
        summary: 'Register paper — abstract, outline, compute estimate',
        description: 'Abstract, paper outline and a compute estimate on the Internal Review Board. No full text yet.' }, wk(8)),
      Object.assign({ key: 'pitch', label: 'Pitch Day', short: 'Pitch Day',
        summary: 'Pitch Day — present the paper to the group',
        description: 'Every paper is pitched to the group.' },
        v.pitchDay ? on(v.pitchDay, 'set for this venue') : wk(6)),
      Object.assign({ key: 'first_draft', label: 'First draft', short: 'First draft',
        summary: 'First full draft → Internal Review',
        description: 'A first full draft exists and enters Internal Review (junior + senior reviewer).' }, wk(4)),
      Object.assign({ key: 'final_draft', label: 'Final draft', short: 'Final draft',
        summary: 'Final draft — every review comment incorporated',
        description: '' }, wk(2)),
      Object.assign({ key: 'pi_polish', label: 'PI approval', short: 'PI approval',
        summary: 'PI approval',
        description: "The PI reads the final draft and approves it for submission. This is the PI's only involvement." }, wk(1))
    ];
    var rows = (v.rushMode ? [] : runway).concat([
      Object.assign({ key: 'paper', label: 'Paper deadline', short: 'Paper',
        summary: 'Paper deadline', description: '' }, onDeadline(v.deadline, ''))
    ]);
    if (v.abstractDeadline){
      rows.push(Object.assign({ key: 'abstract', label: 'Abstract deadline', short: 'Abstract',
        summary: 'Abstract deadline (venue)', description: '' }, onDeadline(v.abstractDeadline, 'venue')));
    }
    // Venue's own dates, each only if the venue actually has it.
    if (v.reviewsPublicDate){
      rows.push(Object.assign({ key: 'reviews_public', label: 'Reviews released', short: 'Reviews',
        summary: 'Reviews released', description: '' }, on(v.reviewsPublicDate, 'venue')));
    }
    if (v.rebuttalDeadline){
      rows.push(Object.assign({ key: 'rebuttal_deadline', label: 'Rebuttal deadline', short: 'Rebuttal',
        summary: 'Rebuttal deadline', description: '' }, onDeadline(v.rebuttalDeadline, 'venue')));
    }
    if (v.notificationDate){
      rows.push(Object.assign({ key: 'notification', label: 'Notification', short: 'Decision',
        summary: 'Notification', description: '' }, on(v.notificationDate, 'venue')));
    }
    if (v.cameraReadyDeadline){
      rows.push(Object.assign({ key: 'camera_ready', label: 'Camera-ready', short: 'Camera-ready',
        summary: 'Camera-ready deadline', description: '' }, onDeadline(v.cameraReadyDeadline, 'venue')));
    }
    rows.forEach(function(r){ r.iso = toIsoDate(r.dateObj); });
    rows.forEach(function(r){
      if (!BUFFER_KEYS[r.key]) return;
      var b = new Date(r.dateObj);
      b.setDate(b.getDate() - BUFFER_DAYS);
      r.bufferIso = toIsoDate(b);
      if (r.instant) r.bufferInstant = new Date(r.instant.getTime() - RUSH_BUFFER_HOURS * 3600000);
      if (!REVIEWER_KEYS[r.key]) return;
      if (r.instant) r.reviewerInstant = new Date(r.instant.getTime() - RUSH_REVIEW_BUFFER_HOURS * 3600000);
      var rb = new Date(r.dateObj);
      rb.setDate(rb.getDate() - REVIEWER_BUFFER_DAYS);
      r.reviewerBufferIso = toIsoDate(rb);
    });
    rows.sort(function(a, b){ return a.dateObj - b.dateObj; });
    return rows;
  }

  function formatDateShort(iso){
    if (!iso) return '';
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function venueScheduleHtml(v){
    var rows = internalSchedule(v);
    if (!rows.length) return '';
    var hasVenueDates = rows.some(function(r){ return r.derivation === 'venue'; });
    // One point per date (2026-09-18+22, per Eduardo), not a stack of
    // three under one dot: the authors' internal deadline, the reviewers'
    // (abstract/paper only) and the venue's own each sit at their own
    // place on the rail, named Internal / review / External for the stage, as in the column headers.
    var points = [];
    rows.forEach(function(r){
      if (r.bufferIso){
        points.push({ kind: 'authors', order: 0, iso: r.bufferIso, at: r.bufferInstant, name: 'Internal ' + r.short.toLowerCase(),
          tip: 'Authors\u2019 internal deadline for the ' + r.short.toLowerCase() + ' \u2014 ' + formatDate(r.bufferIso) });
      }
      if (r.reviewerBufferIso){
        points.push({ kind: 'reviewers', order: 1, iso: r.reviewerBufferIso, at: r.reviewerInstant, name: r.short + ' review',
          tip: 'Reviewers\u2019 deadline for the ' + r.short.toLowerCase() + ' \u2014 ' + formatDate(r.reviewerBufferIso) });
      }
      points.push({ kind: r.key === 'paper' ? 'paper' : (r.derivation === 'venue' ? 'venue' : 'ours'), order: 2, iso: r.iso, at: r.instant,
        name: r.bufferIso ? 'External ' + r.short.toLowerCase() : (r.short || r.label),
        tip: r.label + ' \u2014 ' + formatDate(r.iso) + (r.derivation ? ' (' + r.derivation + ')' : '') });
    });
    points.sort(function(a, b){ return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : a.order - b.order; });
    // Past = red (2026-09-18+23, per Eduardo). Deadlines we deliver against
    // go red on their exact instant, same as the column headers; plain
    // venue dates (reviews released, decision) and the runway milestones
    // have no time of day, so they go red once their day is over.
    var todayIso = toIsoDate(new Date());
    var pts = points.map(function(pt){
      var past = pt.at ? Date.now() > pt.at.getTime() : todayIso > pt.iso;
      return '<li class="vs-pt is-' + pt.kind + (past ? ' is-past' : '') + '" title="' + escapeHtml(pt.tip) + '">' +
        '<span class="vs-dot"></span>' +
        '<span class="vs-name">' + escapeHtml(pt.name) + '</span>' +
        '<span class="vs-when">' + formatDateShort(pt.iso) + '</span>' +
      '</li>';
    }).join('');
    var subUrl = icsSubscribeUrl(v.id);
    // The 'paper' row's own .iso, not v.deadline directly — already the
    // AoE-corrected London date (see internalSchedule's onDeadline), so
    // this summary line agrees with both the rail below it and the
    // column header's External deadline.
    var paperRow = rows.filter(function(r){ return r.key === 'paper'; })[0];
    return '<div class="venue-schedule">' +
      '<div class="vs-head">Deadlines <span>&mdash; ' +
        (v.rushMode ? 'Rush mode, internal cutoffs before each venue date' : 'counted back from the ' + formatDate(paperRow.iso) + ' paper deadline' +
          (hasVenueDates ? ', plus the venue&rsquo;s own dates' : '')) +
        '</span></div>' +
      '<div class="vs-rail-wrap"><ol class="vs-rail" style="--n:' + points.length + '">' + pts + '</ol></div>' +
      '<div class="ics-actions">' +
        '<button class="ics-btn" type="button" id="downloadIcs">Add to calendar (.ics)</button>' +
        (subUrl ?
          '<span class="ics-tip-wrap">' +
            '<button class="ics-btn" type="button" id="subscribeIcs" data-url="' + escapeHtml(subUrl) + '">Subscribe to calendar</button>' +
            '<span class="ics-tip" id="subscribeIcsTip" role="status">Link copied — paste it into your calendar app’s &ldquo;Subscribe by URL&rdquo; option (Google Calendar: Settings &rarr; Add calendar &rarr; From URL).</span>' +
          '</span>'
          : '') +
      '</div>' +
    '</div>';
  }

  function icsEscape(s){
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsDateStamp(d){
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }
  function icsDateValue(d){
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function buildIcs(v){
    var rows = internalSchedule(v);
    if (!rows.length) return '';
    var stamp = icsDateStamp(new Date());
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'PRODID:-//BOLD Lab//Internal Review Board//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + icsEscape(v.label + ' \u2014 internal deadlines')
    ];
    rows.forEach(function(r){
      var end = new Date(r.dateObj); end.setDate(end.getDate() + 1);
      lines.push(
        'BEGIN:VEVENT',
        'UID:' + v.id + '-' + r.key + '@bold-internal-review-board',
        'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + icsDateValue(r.dateObj),
        'DTEND;VALUE=DATE:' + icsDateValue(end),
        'SUMMARY:' + icsEscape(v.label + ' \u2014 ' + r.summary),
        'DESCRIPTION:' + icsEscape(r.description || r.derivation || ''),
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  function downloadIcs(v){
    var text = buildIcs(v);
    if (!text){ showToast('Set a paper deadline first.', 'error'); return; }
    try {
      var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = slugify(v.label) + '-internal-deadlines.ics';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    } catch (e){
      logError('downloadIcs', e);
      showToast('Could not build the .ics file.', 'error');
    }
  }

  // Subscribe-by-URL calendar feed — same bytes as the download button,
  // published to Cloud Storage at a stable public path so calendar apps
  // (Google/Apple/Outlook) can poll it themselves. See storage.rules for
  // why only a PI/admin can publish it (mirrors who can edit a venue).
  function icsStoragePath(boardId){ return 'venues/' + boardId + '/feed.ics'; }

  // Deterministic public URL — no need to call getDownloadURL() (which
  // embeds a share token): the object is genuinely public via Storage
  // Rules, so the plain alt=media URL always works once it exists.
  function icsSubscribeUrl(boardId){
    if (!storage) return null;
    return 'https://firebasestorage.googleapis.com/v0/b/' + BOLD.firebaseConfig.storageBucket +
      '/o/' + encodeURIComponent(icsStoragePath(boardId)) + '?alt=media';
  }

  // Called after a venue is created/edited — best-effort, non-blocking:
  // the venue's own Firestore save is already the source of truth, this
  // just keeps the published feed in sync with it. Failures (e.g. the
  // signed-in user isn't a PI/admin, or Storage isn't reachable) are
  // logged, not surfaced as a save failure — the venue itself still saved.
  function syncVenueIcs(v){
    if (!storage || !v) return;
    var text = buildIcs(v);
    var ref = storage.ref().child(icsStoragePath(v.id));
    if (!text){
      // No deadline (any more) — remove a stale published feed, if any.
      ref.delete().catch(function(){ /* fine if it never existed */ });
      return;
    }
    ref.putString(text, undefined, { contentType: 'text/calendar; charset=utf-8' })
      .catch(function(err){ logError('syncVenueIcs', err); });
  }

  function getCurrentBoard(){
    return state.boards.filter(function(b){ return b.id === state.currentBoardId; })[0];
  }

  // The real venue deadline whatever's still outstanding at this status is
  // racing toward — shared by effectiveDeadline (drives the general
  // Overdue badge, every status) and rushColumnRealDeadline below (drives
  // Rush mode's own extra internal-buffer countdown, Registered/Abstract
  // Submitted only — see that function's own comment for why only those
  // two get it). register/pitch: abstract not sent yet, racing the
  // abstract deadline. abstract: abstract sent, paper not yet, racing the
  // paper deadline. camera_ready: racing the venue's camera-ready
  // deadline. Everything else has nothing externally outstanding.
  function outstandingDeadlineFor(status, board){
    if (status === 'camera_ready') return (board && board.cameraReadyDeadline) || null;
    // abstract AND paper both race the same real venue deadline — the
    // paper hasn't gone out yet in either stage, `paper` reinstated as
    // its own stage (2026-09-18+4) doesn't change what's actually
    // outstanding, just splits how the card gets there into two columns.
    if (status === 'abstract') return (board && board.deadline) || null;
    // Paper = paper already submitted (leaving Abstract is the real
    // submission, 2026-09-18+18, per Eduardo), so what's outstanding
    // there is the REBUTTAL, not the paper deadline any more.
    if (status === 'paper') return (board && board.rebuttalDeadline) || null;
    if (status === 'register' || status === 'pitch'){
      return (board && (board.abstractDeadline || board.deadline)) || null;
    }
    return null;
  }

  // Deadlines are venue-level only — no per-card override. A paper on a
  // different track or deadline is a different venue by convention (see
  // docs/FIREBASE.md/changelog); a card just inherits whatever venue it's on.
  // rebuttal is the one per-CARD deadline (see card.rebuttalDeadline);
  // every other status reads outstandingDeadlineFor's venue-level answer.
  // (2026-09-18: this used to only cover register/pitch_day/draft_review/
  // final_draft/pi_polish, silently returning null for abstract_review —
  // a real gap, see #11 — now closed: every pre-submission status has a
  // real answer via outstandingDeadlineFor.)
  function effectiveDeadline(card, board){
    if (card.status === 'rebuttal') return card.rebuttalDeadline || null;
    return outstandingDeadlineFor(card.status, board);
  }

  // Venue deadlines are stored as bare dates (no time of day). Verified
  // 2026-09-17 against a real, live OpenReview invitation — ICLR 2027's
  // Submission invitation gives duedate 2026-09-19T11:59:00Z, which is
  // exactly 18 Sep 23:59 "Anywhere on Earth" (AoE, UTC-12): ML-conference
  // deadlines are near-universally AoE, not a fixed hour in any one
  // timezone. (An earlier version of this function guessed 18:00 London
  // time instead — unverified, and about 18 hours early as a result.)
  // AoE 23:59 on the stored date is a fixed UTC 11:59 on the NEXT
  // calendar date — no DST involved, unlike London, which is still used
  // only for how the instant gets DISPLAYED (formatDateTime below), not
  // for what instant it actually is.
  function deadlineInstant(iso){
    if (!iso) return null;
    var d = new Date(iso + 'T11:59:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  function isOverdue(card, board){
    var instant = deadlineInstant(effectiveDeadline(card, board));
    return !!instant && Date.now() > instant.getTime();
  }

  // The calendar date a deadline's true instant falls on when read in
  // London time — 'YYYY-MM-DD'. A stored deadline of "18 Sep" is really
  // 23:59 AoE, whose instant lands on 19 Sep in London (see
  // deadlineInstant) — the venue timeline (internalSchedule below) needs
  // this to show the SAME date the column header's External deadline
  // does (formatDateTime(deadlineInstant(...))), not the bare stored
  // date, or the two would disagree by a day.
  function londonDeadlineDateIso(iso){
    var instant = deadlineInstant(iso);
    if (!instant) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  }

  // Rush mode's own internal deadlines (2026-09-14, per Eduardo) —
  // separate from effectiveDeadline/isOverdue above, which drive the
  // general "Overdue" badge off a venue's real deadline directly and are
  // unchanged by any of this. Rush's three columns with something still
  // outstanding — Registered (abstract not sent), Abstract (paper not
  // sent, waiting on the lightweight go/no-go), and Paper (paper not sent,
  // checklist in progress — 2026-09-18+4, `paper` reinstated as its own
  // stage: same real deadline as Abstract, since the paper genuinely
  // isn't out yet in either) — each count down to a CUTOFF instead:
  // RUSH_BUFFER_HOURS before the real venue deadline that stage is
  // actually racing toward, so there's still a buffer to act before the
  // real deadline hits, not right up to the wire. Rebuttal has nothing
  // outstanding to submit at that point, so it gets no cutoff at all (see
  // rushColumnRealDeadline).
  // Which real venue deadline a given rush column is racing toward — just
  // Registered, Abstract, and Paper, the three Rush-mode columns with
  // something still outstanding (see outstandingDeadlineFor above, which
  // this reuses directly — same answer effectiveDeadline gives any card
  // at that status, just addressed by bare status/board instead of a
  // card, since a column header isn't about any one card). Rebuttal gets
  // no entry: once "Submit paper" has been clicked there's nothing left
  // for the submitter to submit, just a venue decision to wait for, so no
  // countdown belongs on that column (see columnHintFor).
  // Returns a bare ISO date string, or null if the venue has no deadline
  // of that kind set, or the column has no countdown at all.
  function rushColumnRealDeadline(status, board){
    if (!board || (status !== 'register' && status !== 'abstract' && status !== 'paper')) return null;
    return outstandingDeadlineFor(status, board);
  }

  // The actual cutoff a rush column is held to: RUSH_BUFFER_HOURS before
  // its real deadline's instant. Returns a Date, or null if that column
  // has no applicable deadline (not a rush review column, rush mode is
  // off, or the venue hasn't set the relevant deadline yet).
  function rushColumnCutoff(status, board){
    if (!board || !board.rushMode) return null;
    var instant = deadlineInstant(rushColumnRealDeadline(status, board));
    if (!instant) return null;
    return new Date(instant.getTime() - RUSH_BUFFER_HOURS * 3600000);
  }

  function isRushColumnPastCutoff(status, board){
    var cutoff = rushColumnCutoff(status, board);
    return !!cutoff && Date.now() > cutoff.getTime();
  }

  // The reviewer's own deadline, the midpoint between the internal cutoff
  // (RUSH_BUFFER_HOURS before the real deadline) and the real deadline
  // itself — the same "middle of the buffer window" convention as the
  // schedule rail's REVIEWER_BUFFER_DAYS, to the minute here instead of a
  // calendar day. Only on the columns where a review is actually a gate
  // (see advanceBlockReason): leaving `abstract` needs the senior
  // reviewer's go-ahead, leaving `paper` needs both reviewers' approval.
  // Registered has no review gate, so no reviewer deadline either.
  // Anchored to the deadline of the stage BEFORE the column's own
  // (2026-09-18+19, per Eduardo): what a reviewer reviews in Abstract is
  // the abstract, due by the abstract deadline (Registered's real
  // deadline); in Paper it's the paper, due by the paper deadline
  // (Abstract's real deadline) — not the column's own outstanding
  // deadline, which is the authors' next task (paper / rebuttal).
  var RUSH_REVIEW_GATED = { abstract: 'register', paper: 'abstract' };

  function rushColumnReviewDeadline(status, board){
    if (!board || !board.rushMode || !RUSH_REVIEW_GATED[status]) return null;
    var instant = deadlineInstant(rushColumnRealDeadline(RUSH_REVIEW_GATED[status], board));
    if (!instant) return null;
    return new Date(instant.getTime() - RUSH_REVIEW_BUFFER_HOURS * 3600000);
  }

  // The card's overdue badges (2026-09-18+18, per Eduardo): in Rush mode
  // two separate ones, not one — "Review overdue" (the reviewers' date has
  // passed and the review isn't approved yet; only on the review-gated
  // columns) and "Submission overdue" (the authors' internal cutoff has
  // passed and the card is still in the column, i.e. not submitted). The
  // dates are exactly the ones the column header shows. Outside Rush mode
  // there are no internal dates, so it stays the one plain "Overdue" off
  // the venue's real deadline.
  function reviewApprovedFor(card){
    if (card.status === 'abstract') return card.abstractReviewState === 'approved';
    if (card.status === 'paper') return reviewFilterState(card) === 'approved';
    return true;
  }

  function overdueFlags(card, board){
    var status = displayStatus(card, board);
    if (board && board.rushMode && (status === 'register' || status === 'abstract' || status === 'paper')){
      var reviewAt = rushColumnReviewDeadline(status, board);
      return {
        review: !!reviewAt && Date.now() > reviewAt.getTime() && !reviewApprovedFor(card),
        submission: isRushColumnPastCutoff(status, board),
        plain: false
      };
    }
    return { review: false, submission: false, plain: isOverdue(card, board) };
  }

  function overdueBadgesHtml(card, board){
    var f = overdueFlags(card, board);
    return (f.review ? '<span class="badge badge-overdue">Review overdue</span>' : '') +
      (f.submission ? '<span class="badge badge-overdue">Submission overdue</span>' : '') +
      (f.plain ? '<span class="badge badge-overdue">Overdue</span>' : '');
  }

  // "2d 4h left" / "3h left" / "5h overdue" — whole hours only; a rush
  // cutoff is only ever precise to the minute to begin with (AoE 23:59,
  // via deadlineInstant), so a couple of stray minutes would be false
  // precision here.
  function formatTimeLeft(cutoff){
    if (!cutoff) return null;
    var ms = cutoff.getTime() - Date.now();
    var pastDue = ms < 0;
    var totalHours = Math.floor(Math.abs(ms) / 3600000);
    var days = Math.floor(totalHours / 24);
    var hours = totalHours % 24;
    var text = (days > 0 ? days + 'd ' : '') + hours + 'h';
    return pastDue ? (text + ' overdue') : (text + ' left');
  }

  // "18 Sep, 6:00 PM BST" — a date plus a time of day, for the rush
  // cutoff itself (formatDate below is date-only, for the real venue
  // deadlines it already handles everywhere else). Always rendered in
  // London time with its abbreviation shown, not the viewer's own local
  // time — the underlying instant is the same for everyone, but showing
  // it in whatever zone the viewer happens to be in would make the same
  // cutoff look different depending on who's looking.
  function formatDateTime(d){
    if (!d) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'Europe/London' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Europe/London', timeZoneName: 'short' });
  }

  // The line under a column's title — STATUS_HINTS' plain "move a card
  // here when…" note everywhere except Rush mode's three columns with an
  // outstanding submission (Registered, Abstract, Paper — see
  // rushColumnRealDeadline), which show their review deadline (Abstract/
  // Paper only), internal cutoff and real deadline instead, since that's
  // the more useful thing to see there.
  // Rebuttal falls through to the plain STATUS_HINTS text same as any
  // other column here — the Waiting-for-reviews/In-Rebuttal distinction
  // lives on the card's own badge instead (rebuttalBadgeHtml), not this
  // column-header line.
  // Returns trusted HTML, not plain text — the "time left"/"time overdue"
  // portion is wrapped in <strong> so it stands out against the rest of
  // the line. Safe to render unescaped: everything that goes into it is
  // either the static STATUS_HINTS text or a computed date/number, never
  // anything a person typed freely (same as formatDate's other call sites
  // throughout the file).
  // The External row is the deadline of the stage the column's reviewers
  // are reviewing (2026-09-18+20, per Eduardo), shown between the
  // reviewers' row and the authors' internal one: Abstract → External
  // Abstract deadline, Paper → External Paper deadline. Registered has no
  // reviewers, so no External row. Same anchor as
  // rushColumnReviewDeadline (RUSH_REVIEW_GATED).
  var RUSH_EXTERNAL_LABELS = { abstract: 'Abstract', paper: 'Paper' };
  // What each role on a card in that column actually has to get done, and
  // by when (2026-09-18+18, per Eduardo) — the labels say the task, not
  // just the deadline's name. Registered: authors send the abstract.
  // Abstract: reviewers review the abstract, authors send the paper.
  // Paper: reviewers review the paper, authors send the rebuttal — the
  // paper is already in by then, so Paper races the REBUTTAL deadline
  // (see outstandingDeadlineFor).
  var RUSH_TASK_LABELS = {
    register: { author: 'Authors: submit abstract by:' },
    abstract: { review: 'Reviewers: review abstract by:', author: 'Authors: submit paper by:' },
    paper:    { review: 'Reviewers: review paper by:',    author: 'Authors: submit rebuttal by:' }
  };

  function columnHintFor(status, board){
    if (board && board.rushMode && (status === 'register' || status === 'abstract' || status === 'paper')){
      var real = rushColumnRealDeadline(status, board);
      if (!real) return status === 'paper' ? 'No rebuttal deadline set for this venue yet' : 'No deadline set for this venue yet';
      var cutoff = rushColumnCutoff(status, board);
      var reviewDeadline = rushColumnReviewDeadline(status, board);
      var externalInstant = RUSH_EXTERNAL_LABELS[status] ? deadlineInstant(rushColumnRealDeadline(RUSH_REVIEW_GATED[status], board)) : null;
      // In this order (2026-09-18+20, per Eduardo): the reviewers' deadline
      // (only on a review-gated column, see rushColumnReviewDeadline),
      // then the venue's External deadline for what they're reviewing,
      // then the authors' internal deadline for the next submission — same London-time treatment on all three, so the
      // numbers are always directly comparable. Each line turns red on
      // ITS OWN instant passing — the earlier ones (review, internal)
      // go red well before the venue's real deadline is actually
      // overdue; showing the venue line red at that point would be
      // wrong, it hasn't happened.
      var now = Date.now();
      var reviewCls = reviewDeadline && now > reviewDeadline.getTime() ? ' hint-overdue' : '';
      var internalCls = now > cutoff.getTime() ? ' hint-overdue' : '';
      var venueCls = externalInstant && now > externalInstant.getTime() ? ' hint-overdue' : '';
      // One row per deadline, label and date on the same line (a date
      // too long for what's left of the line wraps to the next one, see
      // ch-hint-deadlines' own CSS) — the row carries the overdue class,
      // so label and date go red together.
      function row(cls, label, value){
        return '<div class="hint-row' + cls + '"><span class="hint-label">' + label + '</span> ' +
          '<span class="hint-value">' + value + '</span></div>';
      }
      var tasks = RUSH_TASK_LABELS[status];
      return (reviewDeadline ? row(reviewCls, tasks.review, formatDateTime(reviewDeadline)) : '') +
        (externalInstant ? row(venueCls, 'External ' + RUSH_EXTERNAL_LABELS[status] + ' deadline:', formatDateTime(externalInstant)) : '') +
        row(internalCls, tasks.author, formatDateTime(cutoff) + ' (<strong>' + formatTimeLeft(cutoff) + '</strong>)');
    }
    return escapeHtml(STATUS_HINTS[status] || '');
  }

  function formatDate(iso){
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Like formatDate, but from a JS ms timestamp (createdAt/updatedAt) rather
  // than an ISO date string.
  function formatTimestamp(ms){
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function statusOptionsHtml(current, order, board){
    return order.map(function(s){
      var sel = s === current ? ' selected' : '';
      return '<option value="' + s + '"' + sel + '>' + statusLabelFor(s, board) + '</option>';
    }).join('');
  }

  // The status delta columns to the left (-1) or right (+1) of `status`
  // within `order`, or null at the ends / for a status that's no longer a
  // column. `status` should be a value from `order` already — pass
  // displayStatus(card, board), not the card's raw status, so this stays
  // correct when `order` is RUSH_STATUS_ORDER.
  function statusAt(status, delta, order){
    var i = order.indexOf(status);
    if (i === -1) return null;
    var j = i + delta;
    return (j < 0 || j >= order.length) ? null : order[j];
  }

  function submissionLinkLabel(url){
    return url.indexOf('openreview.net') !== -1 ? 'View on OpenReview' : 'View submission';
  }

  // Reviewers need edit access to the draft, not a read-only share link.
  // Returns an error string to show the user, or null if the link is fine
  // (or isn't an overleaf.com link at all, e.g. a self-hosted mirror).
  // Fixed 2026-09-14+1 — reported by a user: their real edit link,
  // https://www.overleaf.com/1244862613jcskdxnpqfqw#840950, was rejected
  // as "not a project link". A real Overleaf project link takes one of
  // TWO shapes, not one: the classic overleaf.com/project/<id> from the
  // address bar while editing, or a bare overleaf.com/<token> — the edit
  // link-sharing token from Overleaf's own Share dialog (its read-only
  // counterpart is overleaf.com/read/<token>, already handled below). The
  // bare form has no further path segments and is a long alphanumeric
  // token, unlike Overleaf's own short, word-like page routes (/learn,
  // /contact, /user/settings, …) — that distinction is what tells the two
  // apart without having to maintain a list of every real Overleaf route.
  function overleafLinkIssue(url){
    if (!url) return null;
    var u;
    try { u = new URL(url); } catch (e){ return null; }
    var host = u.hostname.toLowerCase();
    if (host !== 'overleaf.com' && host !== 'www.overleaf.com') return null;
    if (/^\/read\//i.test(u.pathname)){
      return 'That’s a read-only Overleaf share link — reviewers need edit access. Use the URL from the address bar while editing the project (overleaf.com/project/…), or in Overleaf’s Share dialog invite them as editors.';
    }
    if (/^\/project\//i.test(u.pathname)) return null;
    if (/^\/[a-zA-Z0-9]{15,}$/.test(u.pathname)) return null;
    return 'That doesn’t look like an Overleaf project link. Use the URL from the address bar while editing the project (overleaf.com/project/…), or an edit link from Overleaf’s Share dialog.';
  }

