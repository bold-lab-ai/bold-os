// What a proposed change does to a page, shared by the pages it's made on (pages/guide.js: the BOLDiquette and the
// guides) and a branch's own page (pages/proposal.js, as a pull request) — #324, 2026-11-11. Pure, but for
// BOLD.accessProposal (bold.js), BoldMerge (merge.js) and BoldHistory (history.js). A change: { kind, partId, before,
// after, note, by?, at? }, kind about | edit | add | remove | move | restore | access | batch (its `changes`, in order:
// a branch's commits on the page). As functions/index.js appliedProposal applies them, and functions/branches.js keeps them.
(function(){
  var KIND = { about: 'Title and description', edit: 'Change to', add: 'New part', remove: 'Remove', move: 'Move', restore: 'Restore', batch: 'Changes', access: 'Who can see what' };

  function partIn(d, id){ return ((d && d.parts) || []).filter(function(p){ return p.id === id; })[0] || null; }
  // A part as a proposal records it.
  function partSide(p){ var o = { title: p.title, body: p.body }; if (p.section) o.section = p.section; return o; }
  // What a version or a page holds, as text to compare (history.js).
  function flatten(d){
    var out = { Title: d.title || '', Description: d.description || '' };
    var list = d.parts || [];
    out['Order of parts'] = list.map(function(p){ return (p.section ? p.section + ' › ' : '') + p.title; }).join('\n');
    list.forEach(function(p){ out['Part: ' + p.title] = p.body || ''; });
    return out;
  }

  // Page d with change q applied → { title, description, parts } changed.
  function applied(d, q){
    if (q.kind === 'batch') {
      var cur = Object.assign({}, d), out = {};
      (q.changes || []).forEach(function(c){ var r = applied(cur, c); Object.assign(cur, r); Object.assign(out, r); });
      return out;
    }
    var list = (d.parts || []).map(function(p){ return Object.assign({}, p); });
    var after = q.after || {};
    // One row of Who can see what (a page's eye chip, bold.js), set in the part as it is now.
    if (q.kind === 'access') {
      var ap = list.filter(function(p){ return p.id === 'access'; })[0], lv = { view: after.view, edit: after.edit };
      if (ap) ap.body = BOLD.accessProposal.body(ap.body, q.area, lv);
      else list.push({ id: 'access', title: 'Who can see what', section: 'People', body: BOLD.accessProposal.body('', q.area, lv) });
      return { parts: list };
    }
    if (q.kind === 'about') return { title: after.title || '', description: after.description || '' };
    if (q.kind === 'restore') return { title: after.title || '', description: after.description || '', parts: after.parts || [] };
    if (q.kind === 'add') {
      var np = Object.assign({ id: q.partId }, after), at = -1;
      list.forEach(function(p, i){ if (np.section && p.section === np.section) at = i; });
      if (at === -1) list.push(np); else list.splice(at + 1, 0, np);
      return { parts: list };
    }
    if (q.kind === 'remove') return { parts: list.filter(function(p){ return p.id !== q.partId; }) };
    // Merged with any change since it was proposed, as accepting merges it (BoldMerge, functions/merge.js);
    // if it can't be, as proposed.
    if (q.kind === 'edit') { list.forEach(function(p){ if (p.id === q.partId) Object.assign(p, BoldMerge.mergeEdit(p, q.before, after).fields || after); }); return { parts: list }; }
    if (q.kind === 'move') {
      var order = after.order || [], byId = {};
      list.forEach(function(p){ byId[p.id] = p; });
      if (after.section !== undefined && byId[q.partId]) byId[q.partId].section = after.section;
      return { parts: order.filter(function(id){ return byId[id]; }).map(function(id){ return byId[id]; })
        .concat(list.filter(function(p){ return order.indexOf(p.id) === -1; })) };
    }
    return {};
  }
  // The page as change q leaves it.
  function after(d, q){ return Object.assign({}, d, applied(d, q)); }

  // One side of a change, as text to compare (BoldHistory.changesHtml). d: the page, to name parts a move lists.
  function sideText(kind, side, d){
    if (!side) return {};
    var titleOf = function(id){ var p = partIn(d, id); return p ? p.title : '(a removed part)'; };
    if (kind === 'move') {
      var m = { 'Order of parts': (side.order || []).map(titleOf).join('\n') };
      if (side.section !== undefined) m.Section = side.section || 'Other';
      return m;
    }
    if (kind === 'restore') return flatten(side);
    if (kind === 'about') return { Title: side.title || '', Description: side.description || '' };
    if (kind === 'access') return { View: BOLD.accessProposal.levelName(side.view), Edit: BOLD.accessProposal.levelName(side.edit) };
    var o = { Title: side.title || '', Text: side.body || '' };
    if (side.section !== undefined) o.Section = side.section;
    return o;
  }

  // Where a change stands against the page now (main), as a git branch does: its edits 'current' (made on the
  // page as it is), 'behind' (the page changed since, and they merge), 'conflict' (changed in the same lines) or
  // 'gone' (the part was removed). Its changes in order, each on the page as the ones before leave it.
  var STATE_RANK = { current: 0, behind: 1, conflict: 2, gone: 3 };
  function stateOf(main, q){
    var worst = 'current', cur = main;
    (q.kind === 'batch' ? q.changes || [] : [q]).forEach(function(c){
      if (c.kind === 'edit') {
        var st = BoldMerge.editState(partIn(cur, c.partId), c.before, c.after || {});
        if (STATE_RANK[st] > STATE_RANK[worst]) worst = st;
      }
      try { cur = after(cur, c); } catch (e){}
    });
    return worst;
  }

  // A change in a few words, HTML-escaped (main: the page as it is, to tell a new tab).
  function changeLabel(c, main){
    var esc = BOLD.escapeHtml;
    if (c.kind === 'about') return 'New title and description';
    if (c.kind === 'access') return esc(BOLD.accessProposal.describe(c));
    if (c.kind === 'restore') return 'Restore the version of ' + esc(BoldHistory.when((c.after || {}).versionAt));
    if (c.kind === 'move' && c.after && c.after.tab) return 'Move the tab “' + esc(c.after.title || 'Other') + '”';
    if (c.kind === 'add' && c.after && c.after.section && !((main && main.parts) || []).some(function(p){ return p.section === c.after.section; })) {
      return 'New tab “' + esc(c.after.section) + '”, with “' + esc(c.after.title || '') + '”';
    }
    return (KIND[c.kind] || 'Change') + ' “' + esc((c.after || c.before || {}).title || '') + '”';
  }
  // The parts a change touches.
  function changedIds(q){
    if (!q) return [];
    return (q.kind === 'batch' ? q.changes || [] : [q]).map(function(c){ return c.partId; }).filter(Boolean);
  }
  // A change's diff: the side before, the side after, against page d.
  function diffHtml(c, d){ return BoldHistory.changesHtml(c.kind === 'restore' ? flatten(d || {}) : sideText(c.kind, c.before, d), sideText(c.kind, c.after, d), {}); }

  window.BoldProposals = { KIND: KIND, partIn: partIn, partSide: partSide, flatten: flatten, applied: applied, after: after, sideText: sideText,
    STATE_RANK: STATE_RANK, stateOf: stateOf, changeLabel: changeLabel, changedIds: changedIds, diffHtml: diffHtml };
})();
