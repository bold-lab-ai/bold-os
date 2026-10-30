// Three-way merges for proposals (#177), as git merges: one file for the server
// (functions/index.js appliedProposal, accepting a proposal) and the pages
// (assets/js/merge.js, copied there by eleventy.config.js: guide.js shows a
// proposal as it would be accepted, says whether it's behind, and updates it).
// Plain functions, no DOM or Firebase: BoldMerge in a page, require('./merge') here.
(function(root, make){
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.BoldMerge = make();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  // A three-way merge, line by line: `base` the text a proposal was made on, `ours` the
  // text now, `theirs` the proposal's. Lines kept by both sides anchor the merge; between
  // anchors, whichever side changed wins, or both if they made the same change. Both
  // changing the same lines differently (or lines next to each other) is a conflict,
  // unless it's the same lines both added around one side's change. → the merged text,
  // or null on a conflict.
  function mergeText(base, ours, theirs){ var r = merge3(base, ours, theirs, null); return r.conflicts ? null : r.text; }
  // The same, with each conflict written out as git does, for a person to resolve:
  // <<<<<<< labels[0] / ours / ======= / theirs / >>>>>>> labels[1]. → { text, conflicts }.
  function mergeMarked(base, ours, theirs, labels){ return merge3(base, ours, theirs, labels || ['Main', 'Your proposal']); }
  // Lines a conflict is marked with (mergeMarked), so a resolved text can be checked for them.
  var MARKER = /^(<{7}|={7}|>{7})( |$)/m;
  function hasMarkers(text){ return MARKER.test(String(text || '')); }

  function merge3(base, ours, theirs, labels){
    var o = String(base).split('\n'), a = String(ours).split('\n'), b = String(theirs).split('\n');
    // For each line of o, the line of x it stays as (longest common subsequence), or -1.
    var match = function(x){
      var n = o.length, m = x.length, L = [], i, j;
      for (i = 0; i <= n; i++) { L.push(new Array(m + 1)); for (j = 0; j <= m; j++) L[i][j] = 0; }
      for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = o[i] === x[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      var at = new Array(n);
      for (i = 0; i < n; i++) at[i] = -1;
      for (i = 0, j = 0; i < n && j < m;) {
        if (o[i] === x[j]) { at[i] = j; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
      }
      return at;
    };
    var same = function(x, y){ return x.length === y.length && x.every(function(l, k){ return l === y[k]; }); };
    var ma = match(a), mb = match(b), out = [], io = 0, ia = 0, ib = 0, conflicts = 0;
    for (;;) {
      var i = io;
      while (i < o.length && !(ma[i] >= 0 && mb[i] >= 0)) i++;
      var ja = i < o.length ? ma[i] : a.length, jb = i < o.length ? mb[i] : b.length;
      var O = o.slice(io, i), A = a.slice(ia, ja), B = b.slice(ib, jb);
      if (same(A, O)) out.push.apply(out, B);
      else if (same(B, O) || same(A, B)) out.push.apply(out, A);
      else {
        // Lines both sides added at the start or end of the change are kept once; what's
        // left must be one side's change alone.
        var p = 0, q = 0;
        while (p < A.length && p < B.length && A[p] === B[p]) p++;
        while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
        var A2 = A.slice(p, A.length - q), B2 = B.slice(p, B.length - q);
        if (!same(A2, O) && !same(B2, O)) {
          conflicts++;
          if (!labels) return { text: null, conflicts: conflicts };
          out.push.apply(out, A.slice(0, p).concat(['<<<<<<< ' + labels[0]], A2, ['======='], B2, ['>>>>>>> ' + labels[1]], A.slice(A.length - q)));
        }
        else out.push.apply(out, A.slice(0, p).concat(same(A2, O) ? B2 : A2, A.slice(A.length - q)));
      }
      if (i >= o.length) break;
      out.push(o[i]); io = i + 1; ia = ja + 1; ib = jb + 1;
    }
    return { text: out.join('\n'), conflicts: conflicts };
  }

  // An edit proposed on `before` (a part's { title, section, body } then), applied to the
  // part `now` as it is: each field the proposal sets, merged with whatever changed since.
  // Without `before` (older proposals), the proposal as it is.
  // → { fields } to set on the part, or { conflict: the field's name } if they can't merge.
  function mergeEdit(now, before, after){
    after = after || {};
    if (!before || typeof before !== 'object') return { fields: after };
    var out = {}, conflict = '';
    Object.keys(after).forEach(function(k){
      if (conflict) return;
      var base = before[k], cur = now[k], want = after[k];
      if (base === undefined || cur === base || cur === want) { out[k] = want; return; }
      if (want === base) { out[k] = cur; return; }
      var merged = k === 'body' && typeof cur === 'string' && typeof want === 'string' ? mergeText(base, cur, want) : null;
      if (merged === null) conflict = k; else out[k] = merged;
    });
    return conflict ? { conflict: conflict } : { fields: out };
  }

  // Where an edit stands against the part now: 'current' (made on it), 'behind' (the part
  // changed since, and it merges), 'conflict' (it changed in the same lines), or 'gone'
  // (the part was removed).
  function editState(now, before, after){
    if (!now) return 'gone';
    if (!before || typeof before !== 'object') return 'current';
    var changed = Object.keys(after || {}).some(function(k){ return before[k] !== undefined && before[k] !== now[k]; });
    if (!changed) return 'current';
    return mergeEdit(now, before, after).conflict ? 'conflict' : 'behind';
  }

  return { mergeText: mergeText, mergeMarked: mergeMarked, hasMarkers: hasMarkers, mergeEdit: mergeEdit, editState: editState };
});
