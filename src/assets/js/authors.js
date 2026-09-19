"use strict";

// The author rows — roster picker, "+ New author" (name + email) for someone
// outside the Slack workspace, the PI as the last row — shared by the Internal
// Review Board (Edit fields, Submit the abstract) and a project's own page.
// Plain functions; the page defines what they read, as globals:
//   state.people          the `people` roster, [{ name, email }] (audit-board/core.js)
//   personByEmail(email)  → a roster entry or null           (audit-board/storage.js)
//   escapeHtml(s)                                            (audit-board/core.js)
// Each page keeps its own array of in-progress { name, email, isNew } rows
// (`isNew` is UI-only — stripped by authorsForSave before anything is saved).

  // `locked` (2026-09-14, see authorsLocked) disables every control and
  // drops Remove/"Pick from list instead" entirely rather than just
  // greying them out — nothing about this row is actionable once
  // authors are fixed, so there's no half-interactive state to represent.
  function authorRowsHtml(rows, locked){
    return rows.map(function(row, i){
      var isPi = i === rows.length - 1;
      var label = isPi ? 'PI' : ('Author ' + (i + 1));
      var html = '<div class="author-row">' +
        '<span class="author-pi-tag' + (isPi ? '' : ' author-pi-tag--hidden') + '">PI</span>';
      // Wording corrected 2026-09-14+1 — stale since the "locked strictly
      // AFTER abstract review, not during" fix: this used to say "once
      // Abstract Reviewed is reached", which stopped being true the
      // moment that fix shipped. Kept label-agnostic (not "once past
      // Abstract Reviewed"/"Abstract Submitted") rather than threading
      // `board` all the way through renderAuthorRows just to pick the
      // right one via statusLabelFor.
      // `locked` can also be a string: the reason to show instead (used
      // when the viewer just isn't allowed to edit — 2026-09-18+27).
      var lockAttr = locked ? ' disabled title="' + escapeHtml(typeof locked === 'string' ? locked : 'Authors are locked once the abstract is submitted') + '"' : '';
      if (row.isNew){
        html +=
          '<input type="text" class="author-input author-new-name" data-author-idx="' + i + '" value="' + escapeHtml(row.name) + '" placeholder="Name" aria-label="' + label + ' name"' + lockAttr + '>' +
          '<input type="email" class="author-input author-new-email" data-author-idx="' + i + '" value="' + escapeHtml(row.email) + '" placeholder="Email" aria-label="' + label + ' email"' + lockAttr + '>' +
          (locked ? '' : '<button type="button" class="btn-text author-use-roster" data-author-idx="' + i + '">Pick from list instead</button>');
      } else {
        var options = '<option value="">Choose a person…</option>' + state.people.map(function(p){
          return '<option value="' + escapeHtml(p.email) + '"' + (p.email === row.email ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        }).join('') + '<option value="__new__">+ New author (not in the workspace)…</option>';
        html += '<select class="author-input author-select" data-author-idx="' + i + '" aria-label="' + label + '"' + lockAttr + '>' + options + '</select>';
      }
      html += (!locked && rows.length > 1 ? '<button type="button" class="btn-text danger author-remove" data-remove-author-idx="' + i + '">Remove</button>' : '') +
      '</div>';
      return html;
    }).join('');
  }

  // Used by the Edit-fields modal (eAuthorsState / #eAuthorsWrap) — the
  // registration modal doesn't collect authors any more (see onAddCard).
  // `locked`: see authorRowsHtml — when true, the rows render read-only
  // and nothing below is worth wiring up at all (every listener target
  // is disabled or simply absent from the markup). `onChange` (2026-09-14
  // +1, optional): called every time this function actually (re)renders —
  // i.e. after any structural change to `rows` (add/remove/select/"use
  // roster"), since every one of those funnels through a call back into
  // this same function.
  function renderAuthorRows(wrapId, rows, onEnter, locked, onChange){
    var wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.innerHTML = authorRowsHtml(rows, locked);
    if (onChange) onChange();
    if (locked) return;
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-select'), function(sel){
      sel.addEventListener('change', function(){
        var idx = Number(sel.getAttribute('data-author-idx'));
        if (sel.value === '__new__'){
          rows[idx] = { name: '', email: '', isNew: true };
        } else {
          var p = personByEmail(sel.value);
          rows[idx] = { name: p ? p.name : '', email: sel.value, isNew: false };
        }
        renderAuthorRows(wrapId, rows, onEnter, locked, onChange);
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-new-name'), function(inp){
      inp.addEventListener('input', function(){
        rows[Number(inp.getAttribute('data-author-idx'))].name = inp.value;
      });
      if (onEnter) inp.addEventListener('keydown', function(ev){ if (ev.key === 'Enter'){ ev.preventDefault(); onEnter(ev); } });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-new-email'), function(inp){
      inp.addEventListener('input', function(){
        rows[Number(inp.getAttribute('data-author-idx'))].email = inp.value;
      });
      if (onEnter) inp.addEventListener('keydown', function(ev){ if (ev.key === 'Enter'){ ev.preventDefault(); onEnter(ev); } });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-use-roster'), function(btn){
      btn.addEventListener('click', function(){
        rows[Number(btn.getAttribute('data-author-idx'))] = { name: '', email: '', isNew: false };
        renderAuthorRows(wrapId, rows, onEnter, locked, onChange);
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-remove'), function(btn){
      btn.addEventListener('click', function(){
        rows.splice(Number(btn.getAttribute('data-remove-author-idx')), 1);
        renderAuthorRows(wrapId, rows, onEnter, locked, onChange);
      });
    });
  }

  // Strip the row's UI-only isNew flag and drop wholly-empty rows before
  // saving — mirrors the old rawAuthors.filter(Boolean) behavior for the
  // new object shape. The last row (the PI) still has to be filled in;
  // callers check that separately before this runs.
  function authorsForSave(rows){
    return rows
      .map(function(r){ return { name: (r.name || '').trim(), email: (r.email || '').trim() }; })
      .filter(function(r){ return r.name || r.email; });
  }

  // Denormalized alongside `authors` (2026-09-12, see bold-os#3)
  // purely so a Cloud Function can query "papers this person is an author
  // on" across every venue — Firestore's array-contains can only match a
  // primitive value, not a partial match inside {name,email} objects, so
  // authors itself can't be queried directly. Client-side rendering never
  // reads this field; it exists only for that one server-side query.
  function authorEmailsOf(authors){
    return authors.map(function(a){ return a.email; }).filter(Boolean);
  }

  // Shared validation for both the registration and Edit-fields author
  // rows — same two checks either way: the last row (the PI slot) has to
  // be a real, complete entry, not just non-blank, and no OTHER row can be
  // half-filled (a name typed with no email, or vice versa — only
  // possible in "+ New author" mode, since picking from the roster always
  // sets both fields together). Returns a reason string to show, or null
  // if the rows are good to save.
  function authorRowsIssue(rows){
    function complete(r){ return !!(r && r.name && r.name.trim()) && !!(r && r.email && r.email.trim()); }
    function blank(r){ return !(r && r.name && r.name.trim()) && !(r && r.email && r.email.trim()); }
    var piRow = rows[rows.length - 1];
    if (!complete(piRow)) return 'The last author (the PI) needs both a name and an email.';
    if (rows.some(function(r){ return !blank(r) && !complete(r); })) return 'Each author needs both a name and an email — finish or remove any half-filled row.';
    return null;
  }
