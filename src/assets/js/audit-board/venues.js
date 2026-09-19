"use strict";

  // ---------- rendering ----------

  function renderVenuesList(){
    if (state.view !== 'list'){
      els.venuesRegion.innerHTML = '';
      return;
    }
    if (state.loadingBoards){
      els.venuesRegion.innerHTML = '<p class="board-empty">Loading venues&hellip;</p>';
      return;
    }
    if (state.authResolved && !state.currentUser){
      els.venuesRegion.innerHTML = '<p class="board-empty"><button class="inline-link" type="button" id="signInInline">Sign in</button> with Slack to view the Internal Review Board.</p>';
      var siInline = document.getElementById('signInInline');
      if (siInline) siInline.addEventListener('click', triggerSlackSignIn);
      return;
    }
    // Venue proposals (2026-09-11): fetchVisibleBoards() already only ever
    // returns approved venues, this session's own pending proposals, and —
    // if it succeeded — every pending proposal from anyone (proof of
    // hasFullWrite(), see its comment). Split those apart for three
    // sections rather than mixing pending rows into the normal openable
    // list.
    var approved = state.boards.filter(function(b){ return b.status !== 'pending'; });
    var pending = state.boards.filter(function(b){ return b.status === 'pending'; });
    var myEmail = state.currentUser && state.currentUser.email;
    var minePending = pending.filter(function(b){ return b.proposedBy && b.proposedBy.email === myEmail; });
    var othersPending = state.canApproveVenues
      ? pending.filter(function(b){ return !(b.proposedBy && b.proposedBy.email === myEmail); })
      : [];

    if (approved.length === 0 && pending.length === 0){
      els.venuesRegion.innerHTML = '<p class="board-empty">No venues yet. Create one for a conference and year to get started &mdash; e.g. &ldquo;ICLR 2026&rdquo;.</p>';
      return;
    }

    function sortByCreated(list){ return list.slice().sort(function(a, b){ return (b.createdAt || 0) - (a.createdAt || 0); }); }

    var html = '<div class="venues">';
    if (approved.length){
      html += sortByCreated(approved).map(function(b){
        var sub = b.deadline ? 'Paper deadline ' + formatDate(b.deadline) : 'No paper deadline set';
        if (b.location) sub += ' · ' + escapeHtml(b.location);
        return '<button class="venue-row" type="button" data-open-venue="' + escapeHtml(b.id) + '">' +
          '<span class="venue-name">' + escapeHtml(b.label) + '</span>' +
          '<span class="venue-sub">' + sub + '</span>' +
        '</button>';
      }).join('');
    } else if (pending.length){
      html += '<p class="board-empty">No approved venues yet.</p>';
    }
    // Pending rows open the normal venue page too (2026-09-11) — same
    // data-open-venue as an approved row. "Pending your approval" also
    // carries its own inline Approve/Reject (revised same day, per
    // Eduardo: reviewing shouldn't require a click-in first) — the row
    // itself can't be a <button> any more once it contains other buttons
    // (invalid HTML, and a hover/click state that would fight itself), so
    // it's a plain div with the venue name/sub as its own nested clickable
    // button (.venue-name-btn) and Approve/Reject as siblings, not
    // children of that button — same Approve/Reject also live on the
    // venue detail page itself (renderBoard()), next to Edit venue/Delete
    // venue, for reviewing the full venue before deciding either way.
    if (othersPending.length){
      html += '<div class="venues-section-title">Pending your approval</div>' + sortByCreated(othersPending).map(function(b){
        return '<div class="venue-row venue-row--pending">' +
          '<div class="venue-row-info">' +
            '<button class="venue-name-btn" type="button" data-open-venue="' + escapeHtml(b.id) + '">' + escapeHtml(b.label) + '</button>' +
            '<span class="venue-sub">Proposed by ' + proposerLabel(b.proposedBy) + '</span>' +
          '</div>' +
          '<div class="venue-row-actions">' +
            '<button class="btn btn-approve" type="button" data-approve-venue="' + escapeHtml(b.id) + '">Approve</button>' +
            '<button class="btn btn-reject" type="button" data-reject-venue="' + escapeHtml(b.id) + '">Reject</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    if (minePending.length){
      html += '<div class="venues-section-title">Your proposals awaiting approval</div>' + sortByCreated(minePending).map(function(b){
        return '<button class="venue-row" type="button" data-open-venue="' + escapeHtml(b.id) + '">' +
          '<span class="venue-name">' + escapeHtml(b.label) + '</span>' +
          '<span class="venue-sub"><span class="badge badge-pending">Pending approval</span></span>' +
        '</button>';
      }).join('');
    }
    html += '</div>';
    els.venuesRegion.innerHTML = html;

    Array.prototype.forEach.call(document.querySelectorAll('[data-open-venue]'), function(btn){
      btn.addEventListener('click', function(){
        openVenue(btn.getAttribute('data-open-venue'));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve-venue]'), function(btn){
      btn.addEventListener('click', function(){
        onApproveVenue(btn.getAttribute('data-approve-venue'));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-reject-venue]'), function(btn){
      btn.addEventListener('click', function(){
        onRejectVenue(btn.getAttribute('data-reject-venue'));
      });
    });
  }

  // List → venue → card is real navigation as far as the browser's Back
  // button should be concerned, not just an internal view flag — without
  // this, Back skips over all of it and leaves the app entirely (auth-
  // board.html is one page load; nothing here ever touched browser
  // history before). Every transition pushes a new entry, including the
  // in-app "back" links (backToVenuesList/backToBoard) — treating a step
  // back as "new navigation to the list/venue view" rather than calling
  // history.back() is deliberate: it works the same regardless of how
  // this view was reached (a fresh deep link has no history to go back
  // to), and it means the browser's own Forward button correctly returns
  // to the card/venue you just left via an in-app link, not just via Back.
  // The venue/card a URL points at, as a hash: '#board=<id>' or
  // '#board=<id>&card=<id>' — plain function of its inputs (no reading
  // location.* internally) so it's unit-testable without a DOM. Pure
  // string building, no framework: this static site has no server-side
  // routing, so a hash (not a real path) is the only piece of the URL
  // that can vary without a page reload hitting GitHub Pages' 404 page.
  function stateUrl(view, boardId, cardId, baseUrl){
    if (view === 'venue' && boardId) return baseUrl + '#board=' + encodeURIComponent(boardId);
    if (view === 'card' && boardId && cardId) return baseUrl + '#board=' + encodeURIComponent(boardId) + '&card=' + encodeURIComponent(cardId);
    return baseUrl;
  }

  // The reverse of stateUrl() — given a hash (e.g. from location.hash on
  // page load), what venue/card it points at, or null if it's not a
  // recognized deep link. Also pure/testable for the same reason.
  function parseDeepLinkHash(hash){
    var h = (hash || '').replace(/^#/, '');
    if (!h) return null;
    var params = {};
    h.split('&').forEach(function(pair){
      var idx = pair.indexOf('=');
      if (idx === -1) return;
      params[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    });
    return params.board ? { boardId: params.board, cardId: params.card || null } : null;
  }

  // Real, bookmarkable/shareable URL as of 2026-09-12 — history.pushState's
  // third argument used to be omitted, so Back/Forward worked (see the
  // popstate listener below) but the address bar never actually changed;
  // a link out of the app (a Slack notification, say — see
  // functions/index.js) could only ever land on the front door. Now every
  // venue/card view gets a real URL a fresh page load can restore — see
  // parseDeepLinkHash/applyPendingDeepLink below.
  function pushNavState(){
    var url = stateUrl(state.view, state.currentBoardId, state.currentCardId, location.pathname + location.search);
    history.pushState({ view: state.view, boardId: state.currentBoardId, cardId: state.currentCardId }, '', url);
  }

  window.addEventListener('popstate', function(ev){
    var s = ev.state;
    state.view = s ? s.view : 'list';
    state.currentBoardId = s ? s.boardId : null;
    state.currentCardId = s ? s.cardId : null;
    if (state.view !== 'venue' && state.view !== 'card'){
      stopWatchingCards();
      state.cards = [];
    }
    renderAll(); // toolbar visibility + venuesRegion/boardRegion both need this, not renderBoard() alone
    if (state.view === 'venue' || state.view === 'card') loadCurrentBoardCards();
  });

  function openVenue(id){
    state.view = 'venue';
    state.currentBoardId = id;
    state.currentCardId = null;
    state.search = { query: '', field: 'all', reviewState: 'all' };
    renderAll();
    loadCurrentBoardCards();
    pushNavState();
  }

  function backToVenuesList(){
    stopWatchingCards();
    state.view = 'list';
    state.currentBoardId = null;
    state.currentCardId = null;
    state.cards = [];
    renderAll();
    pushNavState();
  }

  // ---------- venue modal (create / edit) ----------

  function anonymityOptionsHtml(current){
    return ANONYMITY_OPTIONS.map(function(o){
      return '<option value="' + o[0] + '"' + (o[0] === (current || '') ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
  }

  function venueFieldsHtml(v){
    v = v || {};
    function val(k){ return escapeHtml(v[k] == null ? '' : v[k]); }
    return '' +
      '<div class="field-section">Venue</div>' +
      '<div class="field-2">' +
        '<div class="field"><label for="nbVenue">Venue *</label><input type="text" id="nbVenue" placeholder="ICLR" value="' + val('venue') + '"></div>' +
        '<div class="field"><label for="nbYear">Year *</label><input type="text" id="nbYear" inputmode="numeric" placeholder="2026" value="' + val('year') + '"></div>' +
      '</div>' +
      '<div class="field"><label for="nbWebsite">Website / call for papers</label><input type="url" id="nbWebsite" placeholder="https://…" value="' + val('website') + '"></div>' +
      '<div class="field-section">Key dates</div>' +
      '<div style="font-size:12px;color:var(--muted);margin:0 0 10px;">The paper deadline drives the internal schedule. Add the venue&rsquo;s other dates as they&rsquo;re announced &mdash; each appears on the board and in the .ics once set. Only the ones marked optional can be skipped entirely.</div>' +
      '<div class="field-2">' +
        '<div class="field"><label for="nbAbstract">Abstract deadline (optional)</label><input type="date" id="nbAbstract" value="' + val('abstractDeadline') + '"></div>' +
        '<div class="field"><label for="nbDeadline">Paper deadline</label><input type="date" id="nbDeadline" value="' + val('deadline') + '"></div>' +
      '</div>' +
      '<div class="field"><label for="nbPitch">Pitch Day</label><input type="date" id="nbPitch" value="' + val('pitchDay') + '">' +
        '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Leave blank to default to 6 weeks before the paper deadline</div></div>' +
      '<div class="field-2">' +
        '<div class="field"><label for="nbReviewsPublic">Reviews released</label><input type="date" id="nbReviewsPublic" value="' + val('reviewsPublicDate') + '"></div>' +
        '<div class="field"><label for="nbRebuttal">Rebuttal deadline</label><input type="date" id="nbRebuttal" value="' + val('rebuttalDeadline') + '"></div>' +
      '</div>' +
      '<div class="field-2">' +
        '<div class="field"><label for="nbNotify">Notification (optional)</label><input type="date" id="nbNotify" value="' + val('notificationDate') + '"></div>' +
        '<div class="field"><label for="nbCameraReady">Camera-ready (optional)</label><input type="date" id="nbCameraReady" value="' + val('cameraReadyDeadline') + '"></div>' +
      '</div>' +
      '<div class="field"><label for="nbConfDates">Conference dates</label><input type="text" id="nbConfDates" placeholder="11–17 May 2026" value="' + val('conferenceDates') + '"></div>' +
      '<div class="field"><label for="nbLocation">Location</label><input type="text" id="nbLocation" placeholder="Vienna, Austria" value="' + val('location') + '"></div>' +
      '<div class="field-section">Rules</div>' +
      '<div class="field-2">' +
        '<div class="field"><label for="nbMaxPapers">Max papers per author</label><input type="number" id="nbMaxPapers" min="1" value="' + val('maxPapersPerAuthor') + '"></div>' +
        '<div class="field"><label for="nbPageLimit">Page limit</label><input type="text" id="nbPageLimit" placeholder="9 pages excl. refs" value="' + val('pageLimit') + '"></div>' +
      '</div>' +
      '<div class="field-2">' +
        '<div class="field"><label for="nbAnonymity">Anonymity</label><select id="nbAnonymity">' + anonymityOptionsHtml(v.anonymity) + '</select></div>' +
        '<div class="field"><label for="nbSubSystem">Submission page (link)</label><input type="url" id="nbSubSystem" placeholder="https://openreview.net/group?id=…" value="' + val('submissionSystem') + '"></div>' +
      '</div>' +
      '<div class="field"><label for="nbNotes">Notes</label><textarea id="nbNotes" placeholder="Anything else worth recording">' + val('notes') + '</textarea></div>';
  }

  function readVenueFields(){
    function s(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    function d(id){ var el = document.getElementById(id); return (el && el.value) ? el.value : null; }
    var mp = parseInt(s('nbMaxPapers'), 10);
    return {
      venue: s('nbVenue'), year: s('nbYear'), website: s('nbWebsite'),
      abstractDeadline: d('nbAbstract'), deadline: d('nbDeadline'), pitchDay: d('nbPitch'),
      reviewsPublicDate: d('nbReviewsPublic'), rebuttalDeadline: d('nbRebuttal'),
      notificationDate: d('nbNotify'), cameraReadyDeadline: d('nbCameraReady'),
      conferenceDates: s('nbConfDates'), location: s('nbLocation'),
      maxPapersPerAuthor: (!isNaN(mp) && mp > 0) ? mp : null,
      pageLimit: s('nbPageLimit'),
      anonymity: (document.getElementById('nbAnonymity') || {}).value || '',
      submissionSystem: s('nbSubSystem'),
      notes: s('nbNotes')
    };
  }

  function renderVenueModal(opts){
    els.modalRegion.innerHTML =
      '<div class="modal-overlay" id="modalOverlay">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="venueModalTitle">' +
          '<h2 id="venueModalTitle">' + escapeHtml(opts.title) + '</h2>' +
          '<div class="modal-scroll" id="venueForm">' + venueFieldsHtml(opts.venue) + '</div>' +
          '<div class="field-error" id="venueFormError" hidden>Venue and year are both required.</div>' +
          '<div class="modal-actions">' +
            '<button class="btn" type="button" id="cancelVenueModal">Cancel</button>' +
            '<button class="btn btn-primary" type="button" id="saveVenueBtn">' + escapeHtml(opts.submitLabel) + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById('cancelVenueModal').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', function(e){ if (e.target.id === 'modalOverlay') closeModal(); });
    document.getElementById('saveVenueBtn').addEventListener('click', opts.onSubmit);
    ['nbVenue', 'nbYear'].forEach(function(id){
      document.getElementById(id).addEventListener('keydown', function(ev){
        if (ev.key === 'Enter'){ ev.preventDefault(); opts.onSubmit(); }
      });
    });
    document.getElementById('nbVenue').focus();
  }

  // Title/submit label match the button's own "New venue"/"Propose venue"
  // wording (see updateNewVenueButtonState) — same form either way
  // (venueFieldsHtml/readVenueFields, onCreateBoard unchanged), just
  // honest about which one it'll actually be for whoever's looking at it.
  function openNewVenueModal(){
    if (!requireSignedIn()) return;
    var proposing = !state.canApproveVenues;
    renderVenueModal({
      title: proposing ? 'Propose new venue' : 'New venue',
      submitLabel: proposing ? 'Propose' : 'Create',
      venue: null,
      onSubmit: onCreateBoard
    });
  }

  // This button only gates the "signed in at all" precondition, same as
  // the Register-paper button — venue delete/update still needs
  // isPi()/isAdmin() server-side and a signed-in-but-not-PI/admin click on
  // those still fails with the generic error toast. Creating a venue is
  // the one exception (2026-09-11): a signed-in-but-not-PI/admin submit
  // lands as a pending proposal instead of failing outright — same form,
  // same button, see onCreateBoard's own comment.
  //
  // Label itself reflects that (2026-09-11): "+ New venue" for a
  // confirmed PI/admin, "+ Propose venue" for everyone else, using
  // state.canApproveVenues — the same signal that gates the "Pending your
  // approval" section, since it's the only reliable "am I PI/admin" read
  // available client-side (roles/{roleId} stays unreadable). Called from
  // renderAll() too, not just auth-state-change, since canApproveVenues
  // only becomes known once the boards load resolves — before that this
  // still shows the PI/admin wording as a harmless default until it
  // settles (a beat after sign-in, not a lasting wrong state).
  function updateNewVenueButtonState(){
    if (!els.newBoardToggle) return;
    els.newBoardToggle.disabled = !state.currentUser;
    els.newBoardToggle.title = state.currentUser ? '' : 'Sign in with Slack to create a venue';
    els.newBoardToggle.textContent = state.canApproveVenues ? '+ New venue' : '+ Propose venue';
  }

  function openEditVenueModal(){
    var v = getCurrentBoard();
    if (!v) return;
    renderVenueModal({ title: 'Edit ' + v.label, submitLabel: 'Save', venue: v, onSubmit: function(){ onSaveVenue(v.id); } });
  }

  function venueMetaHtml(v){
    if (!v) return '';
    var bits = [];
    var links = [];
    if (v.website) links.push('<a href="' + escapeHtml(v.website) + '" target="_blank" rel="noopener">Call for papers</a>');
    if (v.submissionSystem) links.push('<a href="' + escapeHtml(v.submissionSystem) + '" target="_blank" rel="noopener">Submission page</a>');
    if (links.length) bits.push(links.join(' &middot; '));
    var place = [];
    if (v.conferenceDates) place.push(escapeHtml(v.conferenceDates));
    if (v.location) place.push(escapeHtml(v.location));
    if (place.length) bits.push(place.join(' &middot; '));
    var rules = [];
    if (v.maxPapersPerAuthor) rules.push('&le; ' + v.maxPapersPerAuthor + ' papers/author');
    // A bare number ("9", no unit) reads as ambiguous next to the other
    // rules — e.g. "≤ 20 papers/author · 9 · Double-blind" could be
    // anything. Append "pages" only when it's JUST a number; a value
    // someone already wrote out descriptively ("9 pages excl. refs")
    // stays exactly as entered, not doubled up.
    if (v.pageLimit){
      var pageLimitText = String(v.pageLimit).trim();
      rules.push(escapeHtml(/^\d+$/.test(pageLimitText) ? pageLimitText + ' pages' : pageLimitText));
    }
    if (v.anonymity) rules.push(ANONYMITY_LABELS[v.anonymity] || escapeHtml(v.anonymity));
    if (rules.length) bits.push(rules.join(' &middot; '));
    if (!bits.length) return '';
    return '<div class="venue-meta">' + bits.join('<br>') + '</div>';
  }

