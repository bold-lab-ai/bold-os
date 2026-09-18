"use strict";

  // ---------- card detail ----------

  function openCard(cardId){
    state.view = 'card';
    state.currentCardId = cardId;
    state.detailTab = 'author';
    state.discussionReplyOpenId = null;
    state.checklistCommentOpenId = null;
    state.checklistReplyOpenId = null;
    renderAll();
    window.scrollTo(0, 0);
    pushNavState();
  }

  function backToBoard(){
    state.view = 'venue';
    state.currentCardId = null;
    renderAll();
    pushNavState();
  }

  function getCurrentCard(){
    return state.cards.filter(function(c){ return c.id === state.currentCardId; })[0];
  }

  // Abstract's own lightweight go/no-go (2026-09-18+4, per Eduardo) — no
  // checklist, just a direct call from whoever's looking (soft, no real
  // access control client-side, same as reviewerInputHtml's own picker —
  // roles aren't readable client-side to lock this down further). Shown
  // only while the card is actually at `abstract`; the two buttons write
  // card.abstractReviewState straight via onSetAbstractReview below.
  function abstractApprovalHtml(card){
    if (card.status !== 'abstract') return '';
    var v = card.abstractReviewState || 'in_review';
    // Two independent conditions gate the move to Paper now
    // (2026-09-18+16, per Eduardo, added the authors' checklist —
    // authorChecklistComplete — alongside the senior reviewer's
    // Approve): list whichever of the two is still outstanding, rather
    // than the banner only ever mentioning the reviewer's own call, which
    // is now only half the picture. See advanceBlockReason's own comment.
    var checklistDone = authorChecklistComplete(card);
    var outstanding = [];
    if (v !== 'approved') outstanding.push('the senior reviewer’s Approve');
    if (!checklistDone) outstanding.push('the authors’ checklist');
    var done = v === 'approved' && checklistDone;
    return '<div class="gate-banner' + (done ? ' done' : '') + '" id="abstractApproval">' +
      'Abstract review &mdash; ' + reviewStateBadgeHtml(v) + ' ' +
      (done
        ? 'This card can move to ' + STATUS_LABELS.paper + '.'
        : 'Still needs ' + outstanding.join(' and ') + ' before this card can move to ' + STATUS_LABELS.paper + '.') +
      '<div class="gate-banner-actions">' +
        '<button class="btn" type="button" data-abstract-review="approved"' + (v === 'approved' ? ' disabled' : '') + '>Approve</button>' +
        '<button class="btn-text danger" type="button" data-abstract-review="changes_requested"' + (v === 'changes_requested' ? ' disabled' : '') + '>Request changes</button>' +
      '</div>' +
    '</div>';
  }

  function onSetAbstractReview(cardId, value){
    var boardId = state.currentBoardId;
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card || card.abstractReviewState === value) return;
    var prev = state.cards;
    var next = state.cards.map(function(c){
      return c.id === cardId ? Object.assign({}, c, { abstractReviewState: value, updatedAt: Date.now() }) : c;
    });
    state.cards = next;
    renderCardDetail();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast(saveErrorMessage('Could not save — try again.'), 'error');
      } else {
        showToast(value === 'approved' ? 'Approved.' : 'Changes requested.', 'ok');
      }
    });
  }

  function gateBannerHtml(card){
    var ac = authorChecklistCounts(card);
    var c = checklistCounts(card);
    var done = checklistComplete(card);
    var rv = card.reviewers || {};
    var counts = 'authors <strong>' + ac.done + '/' + ac.total + '</strong>, ' + REVIEW_ROLES.map(function(role){
      return REVIEW_ROLE_LABELS[role].toLowerCase() + ' <strong>' + c[role] + '/' + c.total + '</strong>';
    }).join(', ');
    var noRev = !rv.junior || !rv.senior;
    return '<div class="gate-banner' + (done ? ' done' : '') + '" id="gateBanner">' +
      'Checklists &mdash; ' + counts + '. ' +
      (done
        ? 'Both checklists complete &mdash; this paper can be moved to ' + STATUS_LABELS[GATE_STATUS] + '.'
        : 'Both the authors’ and the reviewers’ checklists must be complete before this paper can reach ' + STATUS_LABELS[GATE_STATUS] + '.') +
      (noRev ? ' <strong>Assign a junior and a senior reviewer</strong> below.' : '') +
    '</div>';
  }

  // ---------- Format / Science checklists, Discussion (see the Author/
  // Review/Discussion sections in renderCardDetail for how these are
  // actually laid out on the page — no tab bar any more) ----------

  function threadCount(messages){
    return (messages || []).reduce(function(n, m){ return n + 1 + (m.replies ? m.replies.length : 0); }, 0);
  }

  // The per-item feedback thread, shown under a checklist row when its
  // "feedback" toggle is open. Same OpenReview-style shape as the
  // Discussion tab (one level of replies), just scoped to one checklist
  // point. Fixed input ids ('clcNew*', 'clcReply*') are safe because only
  // one item's thread — and one reply box within it — is ever open.
  function checklistItemThreadHtml(it){
    var comments = it.comments || [];
    var replyOpenId = state.checklistReplyOpenId;
    var html = '<div class="cl-thread">';
    if (comments.length === 0){
      html += '<p class="disc-empty">No feedback on this point yet.</p>';
    } else {
      comments.forEach(function(msg){
        html += '<div class="disc-thread">';
        html += discussionMessageHtml(msg, false);
        html += '<div class="disc-actions"><button class="btn-text" type="button" data-clc-reply-toggle="' + escapeHtml(msg.id) + '">' + (replyOpenId === msg.id ? 'Cancel' : 'Reply') + '</button></div>';
        if ((msg.replies || []).length){
          html += '<div class="disc-replies">';
          msg.replies.forEach(function(r){ html += discussionMessageHtml(r, true); });
          html += '</div>';
        }
        if (replyOpenId === msg.id){
          html += discussionFormHtml('clcReply', 'Reply&hellip;', 'Post reply');
        }
        html += '</div>';
      });
    }
    html += '<div class="cl-thread-new">' + discussionFormHtml('clcNew', 'Leave feedback on this point (e.g. &ldquo;author name visible, p.4 line 312&rdquo;)&hellip;', 'Post feedback') + '</div>';
    html += '</div>';
    return html;
  }

  // Only the reviewer actually assigned to a role (card.reviewers[role] ===
  // their signed-in email) can tick that role's boxes — same client-side
  // shape used throughout this file, not the real access control.
  // Computed once per role here rather than per item, since it doesn't
  // vary by item. Science checklist only — the authors' checklist has its
  // own, broader access check (isCardAuthorEmail).
  function checklistTickAccess(card){
    var access = {};
    REVIEW_ROLES.forEach(function(role){
      var reviewerEmail = (card.reviewers && card.reviewers[role]) || '';
      access[role] = !!(state.currentUser && reviewerEmail && state.currentUser.email === reviewerEmail);
    });
    return access;
  }

  // Two genuinely different layouts, not just a filtered list (2026-09-14):
  // format is the authors' checklist — one checkbox per item, ticked by any
  // co-author (isCardAuthorEmail), wired through onToggleAuthorChecklist,
  // rendered in the Author section. science is the reviewers' checklist —
  // unchanged from before the split, junior + senior each still get their
  // own column, wired through the original onToggleChecklist, rendered in
  // the Review section (see renderCardDetail).
  // No per-item feedback thread here (2026-09-18+18, per Eduardo — "it's
  // the author themself that is doing it") — unlike the reviewers'
  // Science checklist below, where feedback is another person (junior/
  // senior reviewer) commenting on someone else's work, ticking the
  // authors' own Format checklist is self-assessment: there's no other
  // party in the loop to leave a note for. threadCount/
  // checklistItemThreadHtml/state.checklistCommentOpenId etc. are left
  // alone — reviewerChecklistTabHtml still uses all of them.
  function authorChecklistTabHtml(card){
    var items = checklistItemsFor(card, 'format');
    var canAct = !!(state.currentUser && isCardAuthorEmail(card, state.currentUser.email));
    var html = '<div class="cl-wrap">';
    html += '<p class="cl-agent-note">Working through this with a coding agent? Point it at <a href="https://raw.githubusercontent.com/bold-lab-ai/bold-os/main/checklists/format/AGENTS.md" target="_blank" rel="noopener">checklists/format/AGENTS.md</a> — a pre-check for formatting and policy compliance, before a human ticks these.</p>';
    html += '<div class="cl-head single"><span></span><span>Author</span></div>';
    var lastCat = null;
    items.forEach(function(it){
      if (it.category !== lastCat){
        html += '<div class="cl-cat">' + escapeHtml(it.category) + '</div>';
        lastCat = it.category;
      }
      html += '<div class="cl-item">';
      html += '<div class="cl-row single">';
      html += '<label class="cl-label" for="cla-' + escapeHtml(it.id) + '">' + escapeHtml(it.label) + '</label>';
      html += '<input type="checkbox" id="cla-' + escapeHtml(it.id) + '" data-cla="' + escapeHtml(card.id) + '" data-cla-item="' + escapeHtml(it.id) + '"' + (it.authorChecked ? ' checked' : '') +
        (canAct ? '' : ' disabled title="Only a listed author can tick this"') +
        ' aria-label="Author: ' + escapeHtml(it.label) + '">';
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function reviewerChecklistTabHtml(card){
    var items = checklistItemsFor(card, 'science');
    var openId = state.checklistCommentOpenId;
    var access = checklistTickAccess(card);
    var html = '<div class="cl-wrap">';
    html += '<p class="cl-agent-note">Working through this with a coding agent? Point it at <a href="https://raw.githubusercontent.com/bold-lab-ai/bold-os/main/checklists/reviewers/AGENTS.md" target="_blank" rel="noopener">checklists/reviewers/AGENTS.md</a> — a skeptical pre-review to speed up your own pass, not a replacement for it.</p>';
    html += '<div class="cl-head"><span></span>' + REVIEW_ROLES.map(function(role){ return '<span>' + REVIEW_ROLE_LABELS[role] + '</span>'; }).join('') + '</div>';
    var lastCat = null;
    items.forEach(function(it){
      if (it.category !== lastCat){
        html += '<div class="cl-cat">' + escapeHtml(it.category) + '</div>';
        lastCat = it.category;
      }
      html += '<div class="cl-item">';
      html += '<div class="cl-row">';
      html += '<label class="cl-label" for="cl-' + escapeHtml(it.id) + '-' + REVIEW_ROLES[0] + '">' + escapeHtml(it.label) + '</label>';
      REVIEW_ROLES.forEach(function(role){
        html += '<input type="checkbox" id="cl-' + escapeHtml(it.id) + '-' + role + '" data-cl="' + escapeHtml(card.id) + '" data-cl-item="' + escapeHtml(it.id) + '" data-cl-role="' + role + '"' + (it[role] ? ' checked' : '') +
          (access[role] ? '' : ' disabled title="Only the assigned ' + REVIEW_ROLE_LABELS[role].toLowerCase() + ' reviewer can tick this"') +
          ' aria-label="' + REVIEW_ROLE_LABELS[role] + ': ' + escapeHtml(it.label) + '">';
      });
      html += '</div>';
      var n = threadCount(it.comments);
      var isOpen = openId === it.id;
      html += '<div class="cl-row-foot"><button class="btn-text' + (n ? ' has-feedback' : '') + '" type="button" data-clc-toggle="' + escapeHtml(it.id) + '">' +
        (isOpen ? 'Hide feedback' : (n ? '&#128172; ' + n + ' comment' + (n === 1 ? '' : 's') : '&#128172; Add feedback')) +
      '</button></div>';
      if (isOpen) html += checklistItemThreadHtml(it);
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function discussionMessageHtml(msg, isReply){
    return '<div class="disc-msg' + (isReply ? ' disc-reply' : '') + '">' +
      '<div class="disc-meta"><span class="disc-author">' + escapeHtml(msg.author) + '</span><span class="disc-time">' + formatTimestamp(msg.timestamp) + '</span></div>' +
      '<div class="disc-body">' + escapeHtml(msg.body) + '</div>' +
    '</div>';
  }

  // No author field any more (2026-09-12) — a message's author is always
  // the signed-in poster (state.currentUser), same as submittedBy/
  // reviewers/proposedBy elsewhere. See onPostDiscussion et al.
  function discussionFormHtml(idPrefix, placeholderHtml, submitLabel){
    return '<div class="disc-form">' +
      '<textarea id="' + idPrefix + 'Body" placeholder="' + placeholderHtml + '"></textarea>' +
      '<div class="disc-form-actions"><button class="btn btn-primary" type="button" id="' + idPrefix + 'Submit">' + submitLabel + '</button></div>' +
    '</div>';
  }

  // OpenReview-style thread: top-level messages, each with at most one level
  // of replies (no reply-to-a-reply — see docs/AGENTS.md). Only one reply form is
  // ever open at a time (state.discussionReplyOpenId), so the reply inputs
  // can use fixed ids regardless of which thread they belong to.
  function discussionTabHtml(card){
    var thread = card.discussion || [];
    var replyOpenId = state.discussionReplyOpenId;
    var html = '<div class="discussion">';
    if (thread.length === 0){
      html += '<p class="disc-empty">No discussion yet. Start one below.</p>';
    } else {
      thread.forEach(function(msg){
        html += '<div class="disc-thread">';
        html += discussionMessageHtml(msg, false);
        html += '<div class="disc-actions"><button class="btn-text" type="button" data-disc-reply-toggle="' + escapeHtml(msg.id) + '">' + (replyOpenId === msg.id ? 'Cancel' : 'Reply') + '</button></div>';
        if ((msg.replies || []).length){
          html += '<div class="disc-replies">';
          msg.replies.forEach(function(r){ html += discussionMessageHtml(r, true); });
          html += '</div>';
        }
        if (replyOpenId === msg.id){
          html += discussionFormHtml('discReply', 'Reply&hellip;', 'Post reply');
        }
        html += '</div>';
      });
    }
    html += '<div class="disc-new"><h3>Start a new topic</h3>' + discussionFormHtml('discNew', 'Share a comment, question, or concern&hellip;', 'Post') + '</div>';
    html += '</div>';
    return html;
  }

  function onPostDiscussion(cardId){
    if (!requireSignedIn()) return;
    var bodyEl = document.getElementById('discNewBody');
    var body = bodyEl.value.trim();
    if (!body){
      showToast('Enter a message to post.', 'error');
      return;
    }
    var boardId = state.currentBoardId;
    var msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      author: state.currentUser.name || state.currentUser.email,
      authorEmail: state.currentUser.email,
      timestamp: Date.now(), body: body, replies: []
    };
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      return Object.assign({}, c, { discussion: (c.discussion || []).concat([msg]), updatedAt: Date.now() });
    });
    var prev = state.cards;
    state.cards = next;
    renderBoard();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderBoard();
        showToast('Could not post — try again.', 'error');
      }
    });
  }

  function onPostReply(cardId, parentId){
    if (!parentId) return;
    if (!requireSignedIn()) return;
    var bodyEl = document.getElementById('discReplyBody');
    var body = bodyEl.value.trim();
    if (!body){
      showToast('Enter a reply to post.', 'error');
      return;
    }
    var boardId = state.currentBoardId;
    var reply = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      author: state.currentUser.name || state.currentUser.email,
      authorEmail: state.currentUser.email,
      timestamp: Date.now(), body: body
    };
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      return Object.assign({}, c, {
        discussion: (c.discussion || []).map(function(m){
          if (m.id !== parentId) return m;
          return Object.assign({}, m, { replies: (m.replies || []).concat([reply]) });
        }),
        updatedAt: Date.now()
      });
    });
    var prev = state.cards;
    state.cards = next;
    state.discussionReplyOpenId = null;
    renderBoard();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderBoard();
        showToast('Could not post — try again.', 'error');
      }
    });
  }

  // Mirrors onPostDiscussion / onPostReply but writes into one checklist
  // item's `comments` array instead of the card-level `discussion`. Keeps
  // the item's thread open after posting so the reviewer sees it land.
  function onPostChecklistComment(cardId, itemId){
    if (!itemId) return;
    if (!requireSignedIn()) return;
    var body = document.getElementById('clcNewBody').value.trim();
    if (!body){
      showToast('Enter some feedback to post.', 'error');
      return;
    }
    var boardId = state.currentBoardId;
    var msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      author: state.currentUser.name || state.currentUser.email,
      authorEmail: state.currentUser.email,
      timestamp: Date.now(), body: body, replies: []
    };
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      return Object.assign({}, c, {
        checklist: (c.checklist || []).map(function(it){
          if (it.id !== itemId) return it;
          return Object.assign({}, it, { comments: (it.comments || []).concat([msg]) });
        }),
        updatedAt: Date.now()
      });
    });
    var prev = state.cards;
    state.cards = next;
    state.checklistReplyOpenId = null;
    renderCardDetail();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast('Could not post — try again.', 'error');
      }
    });
  }

  function onPostChecklistReply(cardId, itemId, parentId){
    if (!itemId || !parentId) return;
    if (!requireSignedIn()) return;
    var body = document.getElementById('clcReplyBody').value.trim();
    if (!body){
      showToast('Enter a reply to post.', 'error');
      return;
    }
    var boardId = state.currentBoardId;
    var reply = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      author: state.currentUser.name || state.currentUser.email,
      authorEmail: state.currentUser.email,
      timestamp: Date.now(), body: body
    };
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      return Object.assign({}, c, {
        checklist: (c.checklist || []).map(function(it){
          if (it.id !== itemId) return it;
          return Object.assign({}, it, {
            comments: (it.comments || []).map(function(m){
              if (m.id !== parentId) return m;
              return Object.assign({}, m, { replies: (m.replies || []).concat([reply]) });
            })
          });
        }),
        updatedAt: Date.now()
      });
    });
    var prev = state.cards;
    state.cards = next;
    state.checklistReplyOpenId = null;
    renderCardDetail();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast('Could not post — try again.', 'error');
      }
    });
  }

  function renderCardDetail(){
    var card = getCurrentCard();
    var board = getCurrentBoard();
    if (!card){
      els.boardRegion.innerHTML = '<div class="detail"><a href="#" class="detail-back" id="detailBack">&larr; Back to board</a><p class="board-empty">This paper is no longer on the board.</p></div>';
      var lb = document.getElementById('detailBack');
      if (lb) lb.addEventListener('click', function(e){ e.preventDefault(); backToBoard(); });
      return;
    }

    var overdue = isOverdue(card, board);
    var dl = effectiveDeadline(card, board);
    var effective = displayStatus(card, board);
    var rushCutoff = rushColumnCutoff(effective, board);
    var rushOverdue = isRushColumnPastCutoff(effective, board);

    var html = '<div class="detail">';
    html += '<a href="#" class="detail-back" id="detailBack">&larr; Back to ' + (board ? escapeHtml(board.label) : 'board') + '</a>';

    html += '<div class="detail-head">';
    html += '<h2>' + escapeHtml(card.title) + '</h2>';
    if (STATUS_LABELS[card.status]) html += '<span class="badge" style="background:var(--accent-dim);color:var(--accent);">' + escapeHtml(statusLabelFor(card.status, board)) + '</span>';
    if (card.status === 'abstract') html += reviewStateBadgeHtml(card.abstractReviewState || 'in_review');
    if (card.status === 'paper') html += reviewStateBadgeHtml(reviewFilterState(card));
    if (card.status === 'rebuttal') html += rebuttalBadgeHtml(card);
    if (shouldShowOutcomeBadge(card)) html += '<span class="badge badge-outcome-' + card.outcome + '">' + OUTCOME_LABELS[card.outcome] + '</span>';
    if (overdue || rushOverdue) html += '<span class="badge badge-overdue">Overdue</span>';
    html += '</div>';
    if (!STATUS_LABELS[card.status]) html += '<div style="font-size:12px;color:var(--warn-text);background:var(--warn-bg);padding:6px 10px;margin-top:10px;border-radius:var(--radius);">Status &ldquo;' + escapeHtml(card.status) + '&rdquo; isn’t a column anymore &mdash; pick a new one below.</div>';

    html += '<div class="detail-controls">';
    html += moveButtonsHtml(card, board);
    html += '<select aria-label="Status" data-status-for="' + escapeHtml(card.id) + '">' + statusOptionsHtml(card.status, effectiveStatusOrder(board), board) + '</select>';
    html += '<button class="btn" type="button" data-edit="' + escapeHtml(card.id) + '">Edit fields</button>';
    html += '<button class="btn-text danger" type="button" data-remove="' + escapeHtml(card.id) + '">Remove paper</button>';
    html += '</div>';

    html += '<dl class="detail-grid">';
    if (dl) html += '<dt>' + (card.status === 'rebuttal' ? 'Rebuttal due' : 'Deadline') + '</dt><dd>' + formatDate(dl) + (card.status !== 'rebuttal' ? ' <span style="color:var(--muted);">(venue deadline)</span>' : '') + '</dd>';
    if (rushCutoff) html += '<dt>Rush cutoff</dt><dd' + (rushOverdue ? ' style="color:var(--danger-text);"' : '') + '>' + formatDateTime(rushCutoff) + ' <strong>(' + formatTimeLeft(rushCutoff) + ')</strong></dd>';
    if (card.authors && card.authors.length) html += '<dt>Authors</dt><dd>' + card.authors.map(function(a){ return escapeHtml(a.name || a.email || '?'); }).join(', ') + '</dd>';
    if (card.overleafLink) html += '<dt>Overleaf</dt><dd><a href="' + escapeHtml(card.overleafLink) + '" target="_blank" rel="noopener">' + escapeHtml(card.overleafLink) + '</a></dd>';
    if (card.abstractText) html += '<dt>Abstract</dt><dd class="abstract-render">' + renderAbstractHtml(card.abstractText) + '</dd>';
    if (card.pitchLink) html += '<dt>Pitch materials</dt><dd><a href="' + escapeHtml(card.pitchLink) + '" target="_blank" rel="noopener">Open</a></dd>';
    if (card.submissionLink) html += '<dt>Submission</dt><dd><a href="' + escapeHtml(card.submissionLink) + '" target="_blank" rel="noopener">' + submissionLinkLabel(card.submissionLink) + '</a></dd>';
    if (card.arxivLink) html += '<dt>arXiv</dt><dd><a href="' + escapeHtml(card.arxivLink) + '" target="_blank" rel="noopener">' + escapeHtml(card.arxivLink) + '</a></dd>';
    if (card.rebuttalDeadline) html += '<dt>Rebuttal deadline</dt><dd>' + formatDate(card.rebuttalDeadline) + '</dd>';
    if (card.rebuttalDocLink) html += '<dt>Rebuttal doc</dt><dd><a href="' + escapeHtml(card.rebuttalDocLink) + '" target="_blank" rel="noopener">Open</a></dd>';
    if (card.cameraReadyLink) html += '<dt>Camera-ready</dt><dd><a href="' + escapeHtml(card.cameraReadyLink) + '" target="_blank" rel="noopener">Open</a></dd>';
    if (card.correspondingAuthorEmail) html += '<dt>Corresponding author</dt><dd><a href="mailto:' + escapeHtml(card.correspondingAuthorEmail) + '">' + escapeHtml(card.correspondingAuthorEmail) + '</a></dd>';
    if (card.computeEstimate) html += '<dt>Compute estimate</dt><dd>' + escapeHtml(card.computeEstimate) + '</dd>';
    html += '<dt>Submitted by</dt><dd>' + (card.submittedBy && card.submittedBy.name
      ? escapeHtml(card.submittedBy.name) + (card.submittedBy.email ? ' <span style="color:var(--muted);">(' + escapeHtml(card.submittedBy.email) + ')</span>' : '')
      : '—') + '</dd>';
    if (card.createdAt) html += '<dt>Registered</dt><dd>' + formatTimestamp(card.createdAt) + '</dd>';
    var regNote = card.history && card.history[0] && card.history[0].note;
    if (regNote) html += '<dt>Note at registration</dt><dd style="white-space:pre-wrap;">' + escapeHtml(regNote) + '</dd>';
    html += '</dl>';

    // Author (things an author fills in) vs Review (things a reviewer
    // does) — split into two sections at 2026-09-18+11, back into two
    // TABS at 2026-09-18+19 (per Eduardo). Reviewer assignment and Review
    // notes stay under Review, not the shared grid above — both are
    // review-side content, not general paper metadata. Discussion stays
    // under Review too (2026-09-18+12), as its last subsection — not a
    // tab of its own — even though anyone can actually post there
    // regardless of role.
    var authorBody = abstractSubmissionFieldsHtml(card, board);
    // Authors' Format checklist moved here from the Paper stage
    // (2026-09-18+16, per Eduardo) — it's a self-check on the author's
    // own draft (mandatory sections, length, anonymity, template, policy
    // compliance), nothing that needs the paper to already be under
    // internal review, so it's fillable in parallel with waiting on the
    // senior reviewer's abstract call, and is now itself a second gate
    // on Abstract -> Paper (see advanceBlockReason). Paper stage keeps
    // only the reviewers' Science checklist and the submission-link
    // control below.
    if (card.status === 'abstract'){
      authorBody += '<h3 class="detail-subhead">Submit full paper</h3>' + authorChecklistTabHtml(card);
      // Save + Submit at the end of this block (2026-09-18+17, per
      // Eduardo), same pair the other two Author-section blocks end
      // with. "Save" has nothing new to persist — each checklist box
      // already saves itself the moment it's ticked (onToggleAuthorChecklist)
      // — kept anyway for the same interaction pattern/reassurance as
      // abstractSubmissionFieldsHtml/paperSubmissionFieldsHtml, wired to
      // onConfirmChecklistSaved (a toast, no write). Submit reuses the
      // shared [data-move] handler like those two, but — same trap
      // moveButtonsInnerHtml's own rgtConfirmKey exists to avoid —
      // data-move-label can't be the literal "Submit paper" text: that
      // key is already SUBMIT_CONFIRM_MESSAGES' for the OTHER "Submit
      // paper" button (leaving `paper` for `rebuttal`, the real external
      // venue submission, which DOES get a confirm dialog). Using the
      // exact same 'abstract-approved-advance' key the top button uses
      // for this same transition keeps this one a plain, unconfirmed
      // move, not a false "submit to the venue" prompt.
      var checklistBlockReason = advanceBlockReason(card, 'paper', board);
      authorBody += '<div class="stage-fields-actions">' +
        '<button class="btn" type="button" data-stage-checklist-save="' + escapeHtml(card.id) + '">Save</button>' +
        '<button class="btn btn-primary" type="button" data-move="' + escapeHtml(card.id) + '" data-move-to="paper" data-move-label="abstract-approved-advance"' +
          (checklistBlockReason ? ' disabled title="' + escapeHtml(checklistBlockReason) + '"' : ' title="Move to ' + escapeHtml(statusLabelFor('paper', board)) + '"') + '>Submit</button>' +
        (checklistBlockReason ? '<span class="stage-fields-hint">' + escapeHtml(checklistBlockReason) + '</span>' : '') +
      '</div>';
    }
    if (card.status === 'paper'){
      authorBody += paperSubmissionFieldsHtml(card, board);
    }

    var reviewBody = '<dl class="detail-grid">' +
      '<dt><span class="rv-role junior">Jr</span>&nbsp;reviewer</dt><dd style="max-width:260px;">' + reviewerInputHtml(card, 'junior') +
        (card.status === 'paper' ? reviewStatePillHtml(card, 'junior') : '') + '</dd>' +
      '<dt><span class="rv-role senior">Sr</span>&nbsp;reviewer</dt><dd style="max-width:260px;">' + reviewerInputHtml(card, 'senior') +
        (card.status === 'paper' ? reviewStatePillHtml(card, 'senior') : '') + '</dd>' +
      (card.reviewNotes ? '<dt>Review notes</dt><dd style="white-space:pre-wrap;">' + escapeHtml(card.reviewNotes) + '</dd>' : '') +
    '</dl>';
    reviewBody += abstractApprovalHtml(card);
    if (card.status === 'paper'){
      // gateBannerHtml describes the checklist gate (GATE_AFTER_STATUS) —
      // only meaningful while the card is actually sitting at Paper.
      reviewBody += gateBannerHtml(card);
      reviewBody += '<h3 class="detail-subhead">Checklist for reviewers</h3>' + reviewerChecklistTabHtml(card);
    }
    var discCount = threadCount(card.discussion);
    reviewBody += '<h3 class="detail-subhead">Discussion' +
      (discCount ? ' <span class="n">' + discCount + '</span>' : '') + '</h3>' + discussionTabHtml(card);

    // Author/Review as tabs (2026-09-18+19, per Eduardo — back from the
    // always-both-visible sections at 2026-09-18+11). No tab bar at all
    // when Author has nothing to show (e.g. a non-author viewer, or a
    // stage — Pitch, Rebuttal, Camera-ready, Accepted — where neither
    // abstractSubmissionFieldsHtml, the checklist, nor
    // paperSubmissionFieldsHtml render anything): same "skip the tab bar
    // for a single visible pane" shape the old Format/Science/Discussion
    // tabs used outside Paper, rather than showing an empty "Author" tab
    // next to a real "Review" one.
    if (!authorBody){
      html += '<div class="detail-tabpanel active">' + reviewBody + '</div>';
    } else {
      var detailTab = state.detailTab === 'review' ? 'review' : 'author';
      html += '<div class="detail-tabbar" role="tablist" aria-label="Author or Review">' +
        '<button class="detail-tab' + (detailTab === 'author' ? ' active' : '') + '" type="button" role="tab" id="detail-tab-btn-author" data-detail-tab="author" aria-selected="' + (detailTab === 'author') + '">Author</button>' +
        '<button class="detail-tab' + (detailTab === 'review' ? ' active' : '') + '" type="button" role="tab" id="detail-tab-btn-review" data-detail-tab="review" aria-selected="' + (detailTab === 'review') + '">Review' + (discCount ? ' <span class="n">' + discCount + '</span>' : '') + '</button>' +
      '</div>';
      html += '<div class="detail-tabpanel active">' + (detailTab === 'review' ? reviewBody : authorBody) + '</div>';
    }

    html += '</div>';
    els.boardRegion.innerHTML = html;

    document.getElementById('detailBack').addEventListener('click', function(e){ e.preventDefault(); backToBoard(); });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-detail-tab]'), function(btn){
      btn.addEventListener('click', function(){
        state.detailTab = btn.getAttribute('data-detail-tab');
        renderCardDetail();
      });
    });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-abstract-review]'), function(btn){
      btn.addEventListener('click', function(){ onSetAbstractReview(card.id, btn.getAttribute('data-abstract-review')); });
    });
    var discNewBtn = document.getElementById('discNewSubmit');
    if (discNewBtn) discNewBtn.addEventListener('click', function(){ onPostDiscussion(card.id); });
    var discReplyBtn = document.getElementById('discReplySubmit');
    if (discReplyBtn) discReplyBtn.addEventListener('click', function(){ onPostReply(card.id, state.discussionReplyOpenId); });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-disc-reply-toggle]'), function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-disc-reply-toggle');
        state.discussionReplyOpenId = state.discussionReplyOpenId === id ? null : id;
        renderCardDetail();
      });
    });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-clc-toggle]'), function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-clc-toggle');
        state.checklistCommentOpenId = state.checklistCommentOpenId === id ? null : id;
        state.checklistReplyOpenId = null;
        renderCardDetail();
      });
    });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-clc-reply-toggle]'), function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-clc-reply-toggle');
        state.checklistReplyOpenId = state.checklistReplyOpenId === id ? null : id;
        renderCardDetail();
      });
    });
    var clcNewBtn = document.getElementById('clcNewSubmit');
    if (clcNewBtn) clcNewBtn.addEventListener('click', function(){ onPostChecklistComment(card.id, state.checklistCommentOpenId); });
    var clcReplyBtn = document.getElementById('clcReplySubmit');
    if (clcReplyBtn) clcReplyBtn.addEventListener('click', function(){ onPostChecklistReply(card.id, state.checklistCommentOpenId, state.checklistReplyOpenId); });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-move]'), function(btn){
      btn.addEventListener('click', function(){
        var to = btn.getAttribute('data-move-to');
        if (to && confirmMoveIfSubmit(btn.getAttribute('data-move-label'))) onChangeStatus(btn.getAttribute('data-move'), to);
      });
    });
    var sel = els.boardRegion.querySelector('[data-status-for]');
    if (sel) sel.addEventListener('change', function(){ onChangeStatus(sel.getAttribute('data-status-for'), sel.value); });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-reviewer-role]'), function(inp){
      inp.addEventListener('change', function(){
        onSetReviewer(inp.getAttribute('data-reviewer'), inp.getAttribute('data-reviewer-role'), inp.value.trim());
      });
    });
    var ed = els.boardRegion.querySelector('[data-edit]');
    if (ed) ed.addEventListener('click', function(){ openEditModal(ed.getAttribute('data-edit')); });
    var rm = els.boardRegion.querySelector('[data-remove]');
    if (rm) rm.addEventListener('click', function(){ onRemoveCard(rm.getAttribute('data-remove')); });
    // Inline "Submit the abstract" form (abstractSubmissionFieldsHtml) —
    // only actually present in the DOM while that section renders
    // something, same guard here as the modal's own eAuthorsWrap init.
    var stageAuthorsWrap = document.getElementById('stageAuthorsWrap');
    if (stageAuthorsWrap){
      // isNew must reflect whether this person is actually IN the roster
      // (2026-09-18+21, found by Eduardo — "the dialog for authors
      // doesn't show their names, only 'Choose a person...'"), not
      // unconditionally false: authorRowsHtml's roster-picker mode can
      // only ever show a name if state.people has a matching email — an
      // author saved as "+ New author (not in the workspace)" (or anyone
      // simply not yet Slack-synced) has no such match, so the <select>
      // silently fell back to its own first, unselected option every
      // time the row was reconstructed from saved data, even though
      // name/email were both there all along. Also covers a blank email
      // specifically (2026-09-18+22, found by Eduardo testing an older
      // card whose authors came from the plain-string-author migration —
      // see normalizeCard's own comment, email unrecoverable for that old
      // data): `a.email && personByEmail(a.email)` is false either way a
      // row can't resolve to a real picker option, whether that's because
      // the email plain doesn't match anyone, or because there's no
      // email at all — both need "+ New author" text-input mode to show
      // the name, which the picker has no way to display for either case.
      stageAuthorsState = card.authors && card.authors.length
        ? card.authors.map(function(a){ return { name: (a && a.name) || '', email: (a && a.email) || '', isNew: !(a && a.email && personByEmail(a.email)) }; })
        : [{ name: '', email: '', isNew: false }];
      renderAuthorRows('stageAuthorsWrap', stageAuthorsState, null, false);
      var stageAddAuthorBtn = document.getElementById('stageAddAuthor');
      if (stageAddAuthorBtn) stageAddAuthorBtn.addEventListener('click', function(){
        stageAuthorsState.splice(Math.max(stageAuthorsState.length - 1, 0), 0, { name: '', email: '', isNew: false });
        renderAuthorRows('stageAuthorsWrap', stageAuthorsState, null, false);
      });
    }
    var stageFieldsSaveBtn = els.boardRegion.querySelector('[data-stage-fields-save]');
    if (stageFieldsSaveBtn) stageFieldsSaveBtn.addEventListener('click', function(){ onSaveAbstractFields(stageFieldsSaveBtn.getAttribute('data-stage-fields-save')); });
    var stagePaperSaveBtn = els.boardRegion.querySelector('[data-stage-paper-save]');
    if (stagePaperSaveBtn) stagePaperSaveBtn.addEventListener('click', function(){ onSavePaperSubmissionLink(stagePaperSaveBtn.getAttribute('data-stage-paper-save')); });
    var stageChecklistSaveBtn = els.boardRegion.querySelector('[data-stage-checklist-save]');
    if (stageChecklistSaveBtn) stageChecklistSaveBtn.addEventListener('click', onConfirmChecklistSaved);
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-cl]'), function(box){
      box.addEventListener('change', function(){
        onToggleChecklist(box.getAttribute('data-cl'), box.getAttribute('data-cl-item'), box.getAttribute('data-cl-role'), box.checked);
      });
    });
    Array.prototype.forEach.call(els.boardRegion.querySelectorAll('[data-cla]'), function(box){
      box.addEventListener('change', function(){
        onToggleAuthorChecklist(box.getAttribute('data-cla'), box.getAttribute('data-cla-item'), box.checked);
      });
    });
  }

  // role is 'junior' or 'senior'. Client-side-restricted to the matching
  // assigned reviewer (checklistTickAccess/reviewerChecklistTabHtml
  // already disables the checkbox for anyone else) — same belt-and-braces
  // shape used throughout this file, not the real access control
  // (Security Rules).
  //
  // Review state is now purely derived from the checklist (2026-09-14,
  // simplified per Eduardo — replaces the earlier manual-sign-off design):
  // a role's jrReviewState/srReviewState is 'approved' exactly when every
  // one of that role's boxes is ticked, 'in_review' otherwise. No other
  // input exists any more — there used to also be a manually-clickable
  // 'changes_requested' state (onSetReviewState, now removed) with its own
  // button row, but that let a reviewer mark themselves Approved with
  // nothing ticked (a real bug — see roleChecklistComplete's comment) and,
  // once fixed to gate on the checklist, was just a redundant second way
  // to say the same thing the checklist already said. Ticking is the only
  // remaining signal; unticking any box un-approves just as automatically.
  // A stray legacy 'changes_requested' value from before this change
  // (reviewFilterState still renders it as the card's colour, for cards
  // nobody has touched since) self-heals the moment anyone ticks or
  // unticks a box — deliberately no explicit migration beyond that.
  function onToggleChecklist(cardId, itemId, role, checked){
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    var reviewerEmail = (card.reviewers && card.reviewers[role]) || '';
    if (!state.currentUser || !reviewerEmail || state.currentUser.email !== reviewerEmail) return;

    var boardId = state.currentBoardId;
    // No more auto-advance (2026-09-18 redesign): the checklist lives
    // wholly within `abstract` now — there's no separate "Reviewed"
    // status to jump to any more (see STATUS_ORDER's own comment).
    // Completing it just unblocks the "Submit paper" button
    // (advanceBlockReason/abstractAcceptBlockReason), same as any other
    // gate — the submitter still clicks it themselves, since submitting
    // the paper is a real external act only they can actually do. This
    // toast is the one thing that replaces the old auto-advance
    // confirmation: fires once, right when the LAST box that was still
    // needed gets ticked, not on every tick.
    var wasComplete = checklistComplete(card);
    var reviewStateChanged = false;
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      var newChecklist = c.checklist.map(function(it){
        if (it.id !== itemId) return it;
        var patch = {}; patch[role] = checked;
        return Object.assign({}, it, patch);
      });
      var merged = Object.assign({}, c, { checklist: newChecklist });

      REVIEW_ROLES.forEach(function(r){
        var field = r === 'senior' ? 'srReviewState' : 'jrReviewState';
        var newVal = roleChecklistComplete(merged, r) ? 'approved' : 'in_review';
        if (merged[field] !== newVal){
          var p = {}; p[field] = newVal;
          merged = Object.assign({}, merged, p);
          reviewStateChanged = true;
        }
      });
      merged.updatedAt = Date.now();
      return merged;
    });
    var justCompleted = !wasComplete && card.status === 'paper' &&
      checklistComplete(next.filter(function(c){ return c.id === cardId; })[0]);
    var prev = state.cards;
    state.cards = next;

    if (reviewStateChanged){
      // More than the gate banner/move buttons changed (the tri-state
      // buttons, badges) — a full re-render is worth the reset scroll
      // position here, since this only fires on the box that actually
      // crosses a completion boundary, not on every tick.
      renderCardDetail();
    } else {
      // Common case: refresh just the gate banner and the move controls,
      // leaving the checklist checkboxes and scroll position alone.
      var card2 = getCurrentCard();
      var banner = document.getElementById('gateBanner');
      if (banner && card2) banner.outerHTML = gateBannerHtml(card2);
      var moveWrap = els.boardRegion.querySelector('.detail-controls .card-move');
      if (moveWrap && card2){
        var moveBoard = getCurrentBoard();
        moveWrap.innerHTML = moveButtonsInnerHtml(card2, moveBoard);
        Array.prototype.forEach.call(moveWrap.querySelectorAll('[data-move]'), function(btn){
          btn.addEventListener('click', function(){
            var to = btn.getAttribute('data-move-to');
            if (to && confirmMoveIfSubmit(btn.getAttribute('data-move-label'))) onChangeStatus(btn.getAttribute('data-move'), to);
          });
        });
      }
    }

    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast(saveErrorMessage('Could not save the checklist — try again.'), 'error');
      } else if (justCompleted){
        showToast('Checklist complete — the paper can be submitted now.', 'ok');
      }
    });
  }

  // The authors' checklist's own toggle handler (2026-09-14) — separate
  // from onToggleChecklist above rather than folded into it, since the
  // access model is genuinely different (any listed co-author, not a
  // specific assigned role) and there's no per-role field to set, just
  // one shared authorChecked boolean per item. Same no-auto-advance shape
  // as onToggleChecklist (2026-09-18) — completing the last box just
  // unblocks Submit paper, doesn't move the card itself.
  function onToggleAuthorChecklist(cardId, itemId, checked){
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    if (!state.currentUser || !isCardAuthorEmail(card, state.currentUser.email)) return;

    var boardId = state.currentBoardId;
    // Was checklistComplete()/'paper' before 2026-09-18+17 — dead ever
    // since the Format checklist moved to render only at 'abstract'
    // (this handler only fires from a checkbox that no longer exists in
    // the DOM at 'paper' at all). authorChecklistComplete (not full
    // checklistComplete — the Science half isn't even reachable yet at
    // this stage) is the right thing to watch for here now.
    var wasAuthorDone = authorChecklistComplete(card);
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      var newChecklist = c.checklist.map(function(it){
        if (it.id !== itemId) return it;
        return Object.assign({}, it, { authorChecked: checked });
      });
      var merged = Object.assign({}, c, { checklist: newChecklist });
      merged.updatedAt = Date.now();
      return merged;
    });
    var updatedCard = next.filter(function(c){ return c.id === cardId; })[0];
    var justCompleted = !wasAuthorDone && card.status === 'abstract' && authorChecklistComplete(updatedCard);
    var prev = state.cards;
    state.cards = next;
    renderCardDetail();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast(saveErrorMessage('Could not save the checklist — try again.'), 'error');
      } else if (justCompleted){
        showToast(updatedCard.abstractReviewState === 'approved'
          ? 'Checklist complete — this paper can move to Paper now.'
          : 'Authors’ checklist complete — still waiting on the senior reviewer’s approval.', 'ok');
      }
    });
  }

  // Nothing new to actually persist here — every checklist box already
  // saves itself the moment it's ticked (onToggleAuthorChecklist above).
  // Exists purely so "Submit full paper" ends with the same Save+Submit
  // pair abstractSubmissionFieldsHtml/paperSubmissionFieldsHtml do, for
  // the same reassurance/interaction consistency (2026-09-18+17, per
  // Eduardo).
  function onConfirmChecklistSaved(){
    showToast('Saved.', 'ok');
  }

  function renderAll(){
    els.toolbar = els.toolbar || document.getElementById('toolbar');
    if (els.toolbar) els.toolbar.style.display = (state.view === 'list') ? '' : 'none';
    updateNewVenueButtonState();
    renderVenuesList();
    renderBoard();
  }

