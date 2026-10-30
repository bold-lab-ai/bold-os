// A how-to guide's page (guide.html?guide=<slug>) — one guides/{slug} doc (see
// guides-common.js): its title and description, its contents, then its parts,
// each written in Markdown. Anyone signed in can change any of it, PIs and
// admins too, only by proposing it: changing, adding or removing a part, the
// title and description, moving a part and restoring a version (history.js) are
// all proposals, listed under "Proposed changes" until a PI/admin other than
// whoever proposed it accepts it (decideProposal applies it, crediting both;
// firestore.rules allow no other write) or declines it. Whoever proposed one
// can edit it (it becomes their draft again) or withdraw it while it's open. PIs/admins add and delete guides
// (guide.html?new is the form for a new one).
// Parts may carry a `section`: then the page has one tab per section, showing
// that section's parts (#<section-slug> or a part's #id opens its tab). The same page serves other documents edited this way (BOLDiquette:
// boldiquette.html), set by #guideBody's data attributes: data-collection,
// data-slug, data-eyebrow, data-back (a link, or "" for none), data-anchor-prefix,
// data-deletable and data-read-point ("true": what changed since the reader
// last marked it read, read-point.js).
(function(){
  var esc = BOLD.escapeHtml;
  var G = window.BoldGuides;
  var md = BoldMarkdown.render;
  var body = document.getElementById('guideBody');
  if (!body || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var cfg = body.dataset;
  var COLLECTION = cfg.collection || 'guides';
  var EYEBROW = cfg.eyebrow !== undefined ? cfg.eyebrow : 'How to';
  var PREFIX = cfg.anchorPrefix !== undefined ? cfg.anchorPrefix : 'p-';
  var DELETABLE = cfg.deletable !== 'false';
  var isNew = !cfg.slug && params.has('new');
  var slug = cfg.slug || params.get('guide') || '';
  // A guide with a page of its own (BOLD.GUIDE_PAGES) is read there.
  if (!cfg.slug && BOLD.GUIDE_PAGES[slug]) { location.replace(BOLD.GUIDE_PAGES[slug] + location.hash); return; }
  var ref = !isNew && G.SLUG.test(slug) ? db.collection(COLLECTION).doc(slug) : null;
  var MAX_SIZE = 900000;
  // Its page in Who can see what (BOLD.can): the BOLDiquette, the How to guides, or its own (BOLD.GUIDE_AREAS).
  var AREA = COLLECTION === 'handbook' ? 'boldiquette' : BOLD.GUIDE_AREAS[slug] || 'guides';
  // Why `p` (a part; none: the page) can't be suggested a change by this viewer, or ''.
  function proposeOff(p){
    if (!me) return 'Sign in to suggest a change';
    if (!BOLD.can(AREA, 'propose')) return BOLD.cannotReason(AREA, 'propose');
    if (p && p.id === 'access' && COLLECTION === 'handbook' && !fullWrite) return 'Only PIs and admins change who can see what';
    return '';
  }

  var x = null, loaded = false, fullWrite = false, me = null;
  var proposals = [];
  // The form that's open: null, { kind: 'about' }, { kind: 'edit', id } or { kind: 'add' }.
  var form = null, notice = '';
  var BACK = cfg.back !== undefined ? cfg.back : '<a class="back-link" href="guides.html">&larr; All guides</a>';
  var EYEBROW_HTML = EYEBROW ? '<div><span class="eyebrow">' + esc(EYEBROW) + '</span></div>' : '';
  var historyWrap = document.getElementById('guideHistoryWrap'), histPanel = null;
  var KIND = { about: 'Title and description', edit: 'Change to', add: 'New part', remove: 'Remove', move: 'Move', restore: 'Restore', batch: 'Changes' };
  var readPoint = cfg.readPoint === 'true' && ref ? BoldReadPoint.create({
    ref: ref, key: COLLECTION + '-' + slug, anchor: anchor, onChange: function(){ refresh(); },
  }) : null;
  // Comments on selected text (comments.js).
  var comments = ref && window.BoldComments ? BoldComments.create({
    ref: ref, root: body, fullWrite: function(){ return fullWrite; }, onChange: function(){ refresh(); },
  }) : null;

  // The proposal whose result is on show ("View as proposed"), or null.
  // Or an earlier version (the History panel's View the page then): viewing is VERSION, and
  // viewedVersion the version, shown as a restore of it would make the page.
  var viewing = null, tabBefore = null, viewedVersion = null, VERSION = '#version';
  function viewed(){
    if (viewing === VERSION) return viewedVersion ? { id: VERSION, kind: 'restore', version: true, at: viewedVersion.at,
      after: { title: viewedVersion.data.title || '', description: viewedVersion.data.description || '', parts: viewedVersion.data.parts || [] } } : null;
    return viewing ? proposals.filter(function(q){ return q.id === viewing; })[0] || null : null;
  }
  // Parts you've folded (only their title shows): this browser's, per guide.
  var folded = {};
  function foldKey(){ return 'bold-folded:' + COLLECTION + '/' + slug; }
  try { (JSON.parse(localStorage.getItem(foldKey()) || '[]') || []).forEach(function(id){ folded[id] = true; }); } catch (e){}
  function saveFolded(){ try { localStorage.setItem(foldKey(), JSON.stringify(Object.keys(folded).filter(function(k){ return folded[k]; }))); } catch (e){} }

  // Your draft: changes staged before proposing them together (one "batch"
  // proposal). Kept in this browser only, per guide and person. Editing a
  // proposed change of yours (draftEditing: its id) makes it your draft again;
  // proposing it then updates that proposal, its discussion kept.
  var draft = [], draftOpen = false, draftNote = '', draftBusy = false, draftError = '', draftEditing = null;
  // On your own proposal's branch (#177), the page is your proposal: what you change is staged
  // here (its own draft, kept apart), and added to it as more changes, like commits on a branch.
  var commitTo = null;
  function committing(){ return commitTo ? proposals.filter(function(q){ return q.id === commitTo; })[0] || null : null; }
  function draftKey(){ return me && ref ? 'bold-draft:' + COLLECTION + '/' + slug + ':' + me.email + (commitTo ? ':on:' + commitTo : '') : null; }
  function loadDraft(){
    draft = []; draftNote = ''; draftEditing = null;
    try {
      var raw = draftKey() && localStorage.getItem(draftKey()), v = raw ? JSON.parse(raw) : null;
      if (Array.isArray(v)) draft = v;
      else if (v && Array.isArray(v.changes)) { draft = v.changes; draftNote = v.note || ''; draftEditing = v.editing || null; }
    } catch (e){ draft = []; }
  }
  function saveDraft(){
    try {
      if (!draftKey()) return;
      if (draft.length || draftEditing) localStorage.setItem(draftKey(), JSON.stringify({ changes: draft, note: draftNote, editing: draftEditing }));
      else localStorage.removeItem(draftKey());
    } catch (e){}
  }
  function clearDraft(){ draft = []; draftNote = ''; draftEditing = null; draftOpen = false; saveDraft(); }
  // The guide as shown: as it is, with the proposal on show applied, or with your draft.
  function doc(){
    if (!x) return x;
    var q = viewed();
    if (q) return Object.assign({}, x, applied(x, q));
    var cq = committing(), base = cq ? Object.assign({}, x, applied(x, cq)) : x;
    return draft.length ? Object.assign({}, base, applied(base, { kind: 'batch', changes: draft })) : base;
  }
  function parts(){ var d = doc(); return (d && d.parts) || []; }
  function part(id){ return parts().filter(function(p){ return p.id === id; })[0] || null; }
  // A part as the page has it now: no proposal on show, no draft (proposals are measured against it).
  function livePart(id){ return ((x && x.parts) || []).filter(function(p){ return p.id === id; })[0] || null; }
  function anchor(p){ return PREFIX + p.id; }
  function hasSections(){ return parts().some(function(p){ return p.section; }); }

  // ---------- tabs (one per section) ----------

  var tab = null;
  function sections(){
    return parts().map(function(p){ return p.section || ''; }).filter(function(v, i, a){ return a.indexOf(v) === i; });
  }
  function currentTab(){
    if (!hasSections()) return null;
    return sections().indexOf(tab) !== -1 ? tab : sections()[0];
  }
  // The parts on show: the current tab's, or all of them.
  function shown(){
    var t = currentTab();
    return t === null ? parts() : parts().filter(function(p){ return (p.section || '') === t; });
  }
  // A comment a #hash names (#c=<id>, as Slack sends), or ''.
  function commentFor(hash){ var m = /^#?c=(.+)$/.exec(String(hash || '')); return m ? decodeURIComponent(m[1]) : ''; }
  // The section a #hash names: a section's slug, one of its parts' id, or a comment's part.
  function tabFor(hash){
    var h = decodeURIComponent(String(hash || '').replace(/^#/, ''));
    if (!h) return null;
    if (commentFor(hash)) {
      var at = comments && comments.show(commentFor(hash)), cp = at && !at.proposalId && part(at.partId);
      return cp ? (cp.section || '') : null;
    }
    var byName = sections().filter(function(v){ return G.slugify(v) === h; })[0];
    if (byName !== undefined) return byName;
    var p = parts().filter(function(q){ return anchor(q) === h; })[0];
    return p ? (p.section || '') : null;
  }
  function tabsHtml(){
    var t = currentTab();
    if (t === null) return '';
    var secs = sections(), i = secs.indexOf(t), newTab = form && form.newTab;
    // The current tab's arrows move it (into your draft); + adds a tab. Not while viewing a proposal.
    var arrows = viewing || newTab ? '' : '<span class="gd-tab-move">' +
      '<button type="button" class="icon-btn gd-tab-left" aria-label="Move this tab left" title="Move this tab left"' + (i <= 0 ? ' disabled' : '') + '>' + BOLD.ICON_UP + '</button>' +
      '<button type="button" class="icon-btn gd-tab-right" aria-label="Move this tab right" title="Move this tab right"' + (i >= secs.length - 1 ? ' disabled' : '') + '>' + BOLD.ICON_DOWN + '</button></span>';
    return '<nav class="guide-tabs" id="gdTabs" aria-label="Sections">' + secs.map(function(v){
      var cur = v === t && !newTab;
      // Dragged onto another tab, it moves there (into your draft).
      var drag = viewing || form ? '' : ' draggable="true" data-sec="' + esc(v) + '" title="Drag to move this tab"';
      return '<a class="guide-tab' + (cur ? ' is-current' : '') + '" href="#' + esc(G.slugify(v)) + '"' + (cur ? ' aria-current="page"' : '') + drag + '>' +
        esc(v || 'Other') + '</a>' + (cur ? arrows : '');
    }).join('') +
      (viewing ? '' : '<button type="button" class="guide-tab gd-tab-add' + (newTab ? ' is-current' : '') + '" aria-label="Suggest a new tab" title="Suggest a new tab">+</button>') + foldAllButton() + '</nav>';
  }
  function stamp(note){ return { changeNote: note || '', updatedAt: Date.now(), updatedBy: me.email, proposedBy: '' }; }

  // What a version or the guide holds, as text to compare (history.js).
  function flatten(d){
    var out = { Title: d.title || '', Description: d.description || '' };
    var list = d.parts || [];
    out['Order of parts'] = list.map(function(p){ return (p.section ? p.section + ' › ' : '') + p.title; }).join('\n');
    list.forEach(function(p){ out['Part: ' + p.title] = p.body || ''; });
    return out;
  }

  // ---------- reading ----------

  // Three lines: "drag me", on a part's grip and on each tab.
  var GRIP = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10"/></svg>';
  function partHtml(p, i){
    var all = parts(), at = all.indexOf(p);
    var editing = form && form.kind === 'edit' && form.id === p.id;
    if (editing) return '<section class="guide-part" id="' + anchor(p) + '">' + partFormHtml(p) + '</section>';
    if (form && form.kind === 'move' && form.id === p.id) return '<section class="guide-part" id="' + anchor(p) + '">' + moveFormHtml(p) + '</section>';
    var why = proposeOff(p);
    var icon = function(cls, label, svg, off){
      return '<button type="button" class="icon-btn ' + cls + '" data-id="' + esc(p.id) + '" aria-label="' + label + '" title="' + esc(why || label) + '"' + (off || why ? ' disabled' : '') + '>' + svg + '</button>';
    };
    var q = viewed(), fold = !!folded[p.id] && !q;
    // The grip drags it above or below another part, or onto a tab (into your draft).
    var grip = why ? '' : '<span class="icon-btn gd-grip" draggable="true" data-id="' + esc(p.id) + '" role="img" aria-label="Drag to move it" title="Drag to move it">' + GRIP + '</span>';
    return '<section class="guide-part' + (q && changedIds(q).indexOf(p.id) !== -1 ? ' gd-proposed' : '') + (fold ? ' is-folded' : '') + '" id="' + anchor(p) + '" data-pid="' + esc(p.id) + '">' +
      // Its controls on the title's line, before it.
      '<div class="guide-part-head">' +
      (q ? '' : '<div class="guide-part-controls">' + (form ? '' : grip) + icon('gd-edit', 'Suggest a change', BOLD.ICON_PENCIL) +
        icon('gd-up', 'Suggest moving it up', BOLD.ICON_UP, at === 0) + icon('gd-down', 'Suggest moving it down', BOLD.ICON_DOWN, at === all.length - 1) + '</div>') +
      '<h2><button type="button" class="gd-fold" data-id="' + esc(p.id) + '" aria-expanded="' + !fold + '" title="' + (fold ? 'Show' : 'Fold') + ' this part">' +
        '<span class="guide-num">' + (i + 1) + '</span>' + esc(p.title) + '</button></h2></div>' +
      (fold ? '' : '<div class="guide-text">' + md(p.body) + '</div>') + '</section>';
  }

  // Marks the contents entry of the part being read.
  var contentsWatch = null;
  function watchContents(){
    if (contentsWatch) { contentsWatch.disconnect(); contentsWatch = null; }
    var links = body.querySelectorAll('.guide-contents a');
    if (!links.length || !('IntersectionObserver' in window)) return;
    var seen = {};
    contentsWatch = new IntersectionObserver(function(entries){
      entries.forEach(function(e){ seen[e.target.id] = e.isIntersecting; });
      var current = null;
      Array.prototype.forEach.call(body.querySelectorAll('.guide-part[id]'), function(sec){ if (!current && seen[sec.id]) current = sec.id; });
      if (!current) return;
      Array.prototype.forEach.call(links, function(a){ a.classList.toggle('is-current', a.getAttribute('href') === '#' + current); });
    }, { rootMargin: '0px 0px -60% 0px' });
    Array.prototype.forEach.call(body.querySelectorAll('.guide-part[id]'), function(sec){ contentsWatch.observe(sec); });
  }

  function contentsHtml(){
    if (shown().length < 2) return '';
    return '<nav class="guide-contents" aria-label="Contents"><ol>' + shown().map(function(p){
      return '<li><a href="#' + anchor(p) + '">' + esc(p.title) + '</a></li>';
    }).join('') + '</ol></nav>';
  }

  // ---------- forms ----------

  function noteHtml(placeholder){
    return '<label>What you changed and why' +
      '<input type="text" class="gd-note" maxlength="300" placeholder="' + esc(placeholder) + '"></label>' +
      '<p class="event-form-hint">' + (fullWrite ? 'Another PI or admin' : 'A PI or admin') + ' reviews your change before it shows.</p>';
  }
  // With a draft open, a change joins it; without, it's proposed or starts one.
  function actionsHtml(extra){
    return '<p class="ev-error" hidden></p><div class="event-form-actions">' +
      // On your branch, every change is staged, then added to your proposal.
      (draft.length || commitTo ? '<button type="button" class="ev-save" data-stage="1">Add to draft</button>' :
        '<button type="button" class="ev-save">Propose change</button><button type="button" class="ev-save ev-stage" data-stage="1">Add to draft</button>') +
      '<button type="button" class="ev-cancel">Cancel</button>' + (extra || '') + '</div>';
  }

  function partFormHtml(p){
    p = p || { title: '', body: '' };
    var isAdd = !p.id;
    return '<div class="event-form guide-form">' +
      '<p class="event-form-head">' + (isAdd && form.newTab ? 'New tab, with its first part' : isAdd ? 'New part' : 'Edit part') + '</p>' +
      (isAdd && form.newTab ? '<label>Tab<input type="text" class="gd-section gd-new-tab" maxlength="60" placeholder="e.g. Cambridge"></label>' :
      hasSections() ? '<label>Section<input type="text" class="gd-section" value="' + esc(p.section || (isAdd ? currentTab() : '') || '') + '" list="gdSections"></label>' +
        '<datalist id="gdSections">' + parts().map(function(q){ return q.section; }).filter(function(v, i, a){ return v && a.indexOf(v) === i; }).map(function(v){ return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>' : '') +
      '<label>Title<input type="text" class="gd-title" value="' + esc(p.title) + '" placeholder="e.g. Before the reviews come in"></label>' +
      // Write or Preview, as GitHub's comments: how the text will look, in its place.
      '<div class="gd-text-label">Text</div>' +
      '<div class="guide-tabs gd-modes" role="tablist">' +
        '<button type="button" class="guide-tab gd-mode is-current" data-mode="write" role="tab" aria-selected="true">Write</button>' +
        '<button type="button" class="guide-tab gd-mode" data-mode="preview" role="tab" aria-selected="false">Preview</button></div>' +
      '<textarea class="gd-body" rows="16" aria-label="Text">' + esc(p.body) + '</textarea>' +
      '<div class="guide-text gd-preview-box" hidden></div>' +
      '<p class="event-form-hint">Markdown: **bold**, *italic*, [a link](https://…), lines starting with - or 1. for lists, a blank line between paragraphs, @ to tag someone.</p>' +
      noteHtml(isAdd ? 'e.g. Added a part on posters' : 'e.g. Clearer advice on ablations') +
      actionsHtml(isAdd ? '' : '<button type="button" class="btn-text danger gd-remove">' + 'Propose removing this part' + '</button>') +
      '</div>';
  }

  // Where a part can go: the top of a section (or of the guide), or after any other part.
  // → [{ value: 'top:<section>' | 'after:<id>', label, section }]
  function positions(p){
    var out = [], secs = hasSections() ? sections() : [null];
    secs.forEach(function(sec){
      var inSec = parts().filter(function(q){ return sec === null || (q.section || '') === sec; });
      out.push({ value: 'top:' + (sec || ''), label: sec === null ? 'At the top' : 'At the top of ' + (sec || 'Other'), section: sec });
      inSec.forEach(function(q){ if (q.id !== p.id) out.push({ value: 'after:' + q.id, label: 'After “' + q.title + '”', section: sec }); });
    });
    return out;
  }
  // The position one step up (by -1) or down (1) from where p is, across sections.
  function stepFrom(p, by){
    var list = positions(p), here = currentPosition(p);
    var i = list.map(function(o){ return o.value; }).indexOf(here);
    var j = Math.max(0, Math.min(list.length - 1, i + by));
    return list[j].value;
  }
  function currentPosition(p){
    var all = parts(), i = all.indexOf(p), sec = p.section || '';
    var prev = all.slice(0, i).filter(function(q){ return !hasSections() || (q.section || '') === sec; }).pop();
    return prev ? 'after:' + prev.id : 'top:' + (hasSections() ? sec : '');
  }
  // The guide's parts with p at position pos → { order, section }.
  function placed(p, pos){
    var rest = parts().filter(function(q){ return q.id !== p.id; });
    var section = p.section || '', at;
    if (pos.indexOf('after:') === 0) {
      var id = pos.slice(6);
      at = rest.map(function(q){ return q.id; }).indexOf(id) + 1;
      section = (rest[at - 1] && rest[at - 1].section) || '';
    } else {
      section = pos.slice(4);
      var first = hasSections() ? rest.map(function(q){ return q.section || ''; }).indexOf(section) : 0;
      at = first === -1 ? rest.length : first;
    }
    rest.splice(at, 0, p);
    return { order: rest.map(function(q){ return q.id; }), section: section };
  }
  function moveFormHtml(p){
    var list = positions(p), cur = form.to || currentPosition(p), groups = [], last = {};
    list.forEach(function(o){
      var opt = '<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' + esc(o.label) + (o.value === currentPosition(p) ? ' (where it is now)' : '') + '</option>';
      if (o.section === null) { groups.push(opt); return; }
      if (last.section !== o.section) { last = { section: o.section, opts: [] }; groups.push(last); }
      last.opts.push(opt);
    });
    var select = groups.map(function(g){ return typeof g === 'string' ? g : '<optgroup label="' + esc(g.section || 'Other') + '">' + g.opts.join('') + '</optgroup>'; }).join('');
    return '<div class="event-form guide-form">' +
      '<p class="event-form-head">Move “' + esc(p.title) + '”</p>' +
      '<label>Put it<select class="gd-move-to">' + select + '</select></label>' +
      noteHtml('e.g. Setup belongs before the checklists') + actionsHtml() + '</div>';
  }

  function aboutFormHtml(){
    return '<div class="event-form guide-form">' +
      '<label>Title<input type="text" class="gd-title" value="' + esc(doc().title) + '"></label>' +
      '<label>Description<textarea class="gd-description" rows="3">' + esc(doc().description || '') + '</textarea></label>' +
      noteHtml('e.g. Shorter description') + actionsHtml() + '</div>';
  }

  function newFormHtml(){
    return '<div class="event-form guide-form">' +
      '<label>Title<input type="text" class="gd-title" placeholder="e.g. Write a rebuttal"></label>' +
      '<label>Name in its link<input type="text" class="gd-slug" spellcheck="false" autocapitalize="off" placeholder="e.g. write-a-rebuttal"></label>' +
      '<p class="event-form-hint">guide.html?guide=<em>name</em>: lowercase letters, numbers and hyphens. It can’t be changed later.</p>' +
      '<label>Description<textarea class="gd-description" rows="3"></textarea></label>' +
      '<p class="event-form-hint">You add its parts on the guide’s page.</p>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save">Add guide</button><button type="button" class="ev-cancel">Cancel</button></div></div>';
  }

  // A part as a proposal records it.
  function partSide(p){ var o = { title: p.title, body: p.body }; if (p.section) o.section = p.section; return o; }

  function showError(el, msg){ var b = el.querySelector('.ev-error'); b.textContent = msg; b.hidden = !msg; }

  // ---------- proposals ----------

  // The guide with proposal q applied, as decideProposal (functions/index.js
  // appliedProposal) will apply it → { title, description, parts } changed.
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

  function titleOf(id){ var p = part(id); return p ? p.title : '(a removed part)'; }
  function sideText(kind, side){
    if (!side) return { };
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

  // Where a proposal stands against the page now, as a git branch does against main: its
  // edits 'current' (made on the page as it is), 'behind' (the page changed since, and they
  // merge), 'conflict' (changed in the same lines) or 'gone' (the part was removed).
  var STATE_RANK = { current: 0, behind: 1, conflict: 2, gone: 3 };
  // Its changes in order, each on the page as the ones before it leave it (a branch's commits).
  function partIn(d, id){ return ((d && d.parts) || []).filter(function(p){ return p.id === id; })[0] || null; }
  function stateOf(q){
    var worst = 'current', cur = x;
    (q.kind === 'batch' ? q.changes || [] : [q]).forEach(function(c){
      if (c.kind === 'edit') {
        var st = BoldMerge.editState(partIn(cur, c.partId), c.before, c.after || {});
        if (STATE_RANK[st] > STATE_RANK[worst]) worst = st;
      }
      try { cur = Object.assign({}, cur, applied(cur, c)); } catch (e){}
    });
    return worst;
  }
  // A proposal in a few words, plain text (the Version picker).
  function whatText(q){
    if (q.kind === 'access') return BOLD.accessProposal.describe(q);
    if (q.kind === 'about') return KIND.about;
    if (q.kind === 'restore') return 'Restore the version of ' + BoldHistory.when(q.after.versionAt);
    if (q.kind === 'batch') return (q.changes || []).length + ' changes';
    return KIND[q.kind] + ' “' + ((q.after || q.before || {}).title || '') + '”';
  }
  // Brings your proposal up to the page as it is now (a rebase): each edit merged with what
  // changed since, and made on the page now. Its discussion stays.
  function rebase(q){
    var cur = x;
    var one = function(c){
      var p = c.kind === 'edit' && partIn(cur, c.partId), out = c;
      if (p) {
        var r = BoldMerge.mergeEdit(p, c.before, c.after || {});
        if (r.conflict) throw new Error('conflict');
        out = Object.assign({}, c, { before: partSide(p), after: Object.assign({}, c.after, r.fields) });
      }
      cur = Object.assign({}, cur, applied(cur, out));
      return out;
    };
    var upd = q.kind === 'batch' ? { changes: (q.changes || []).map(one) } : (function(){ var c = one(q); return { before: c.before, after: c.after }; })();
    upd.editedAt = Date.now();
    return ref.collection('proposals').doc(q.id).update(upd);
  }

  function proposalHtml(q){
    var cur = q.kind === 'about' ? { title: x.title, description: x.description || '' } : q.partId ? part(q.partId) : null;
    var st = stateOf(q);
    var stale = (q.kind === 'about' || q.kind === 'edit' || q.kind === 'remove') && (!cur || q.kind !== 'edit' && (q.before && (cur.title !== q.before.title || (q.kind === 'about' ? (cur.description || '') !== (q.before.description || '') :
      (cur.body || '') !== (q.before.body || '') || (q.before.section !== undefined && (cur.section || '') !== q.before.section)))));
    var what = q.kind === 'access' ? esc(BOLD.accessProposal.describe(q)) : q.kind === 'about' ? KIND.about : q.kind === 'restore' ? 'Restore the version of ' + esc(BoldHistory.when(q.after.versionAt)) :
      q.kind === 'batch' ? (q.changes || []).length + ' changes' :
      KIND[q.kind] + ' “' + esc((q.after || q.before || {}).title || '') + '”';
    var mine = me && q.by && q.by.email === me.email, byName = esc(q.by ? (q.by.name || q.by.email) : 'whoever proposed it');
    var off = st === 'conflict' ? ' disabled title="It changed in the same lines since it was proposed"' : !fullWrite ? ' disabled title="' + G.NOT_PI + '"' :
      mine ? ' disabled title="Another PI or admin reviews your change"' : '';
    // Its own address (#proposal-<id>): the board, Slack and the eye chip link to it.
    return '<li class="gd-proposal" id="proposal-' + esc(q.id) + '" data-id="' + esc(q.id) + '">' +
      '<p class="gd-proposal-head"><span class="hist-when">' + BoldHistory.when(q.at) + '</span>' +
        '<span>' + what + ' · proposed by ' + esc(q.by ? (q.by.name || q.by.email) : 'someone') +
          (q.editedAt ? ' · edited ' + esc(BoldHistory.when(q.editedAt)) : '') + '</span></p>' +
      (draftEditing === q.id ? '<p class="gd-proposal-note"><em>You’re editing it: see your draft at the top.</em></p>' : '') +
      (q.note ? '<p class="gd-proposal-note">' + esc(q.note) + '</p>' : '') +
      (q.kind === 'add' && cur ? '<p class="gd-proposal-stale">That part is there already, so this can’t be accepted: propose a change to it instead.</p>' : '') +
      (stale ? '<p class="gd-proposal-stale">' + (q.kind !== 'about' && !cur ? 'That part has since been removed.' : 'This has changed since it was proposed; accepting replaces the current text.') + '</p>' : '') +
      (st === 'behind' ? '<p class="gd-proposal-behind">The page has changed since this was proposed; accepting merges the two, as shown.' +
        (mine ? ' <button type="button" class="btn-text gd-rebase">Update to the latest</button>' : '') + '</p>' : '') +
      (st === 'conflict' ? '<p class="gd-proposal-stale">The page has changed in the same lines since this was proposed, so it can’t be accepted: ' +
        (mine ? 'withdraw it and propose it again on the latest version.' : 'decline it, or ask ' + byName + ' to propose it again on the latest version.') + '</p>' : '') +
      (q.kind === 'batch' ? '<ol class="gd-batch">' + (q.changes || []).map(function(c){
          return '<li><p class="hist-label">' + changeLabel(c) + (c.note ? ' · ' + esc(c.note) : '') + (c.at ? ' · <span class="hist-when">' + BoldHistory.when(c.at) + '</span>' : '') + '</p>' + BoldHistory.changesHtml(sideText(c.kind, c.before), sideText(c.kind, c.after), {}) + '</li>';
        }).join('') + '</ol>' :
        (q.kind === 'edit' && st === 'behind' ? (function(lp){ return BoldHistory.changesHtml(sideText('edit', partSide(lp)), sideText('edit', Object.assign(partSide(lp), BoldMerge.mergeEdit(lp, q.before, q.after || {}).fields)), {}); })(livePart(q.partId)) :
        BoldHistory.changesHtml(q.kind === 'restore' ? flatten(x) : sideText(q.kind, q.before), sideText(q.kind, q.after), {}))) +
      '<div class="event-controls">' +
        '<button type="button" class="btn-text gd-view">View as proposed</button>' +
        '<button type="button" class="btn-text gd-accept"' + off + ((q.kind !== 'add' && q.kind !== 'about' && q.kind !== 'restore' && q.kind !== 'batch' && q.kind !== 'access' && !cur) || (q.kind === 'add' && cur) ? ' disabled' : '') + '>Accept</button>' +
        '<button type="button" class="btn-text danger gd-decline"' + off + '>Decline</button>' +
        // A restore, or a row of Who can see what, stays as it is: withdraw it and propose again instead.
        (mine && q.kind !== 'restore' && q.kind !== 'access' ? '<button type="button" class="btn-text gd-revise">' + (draftEditing === q.id ? 'Editing' : 'Edit') + '</button>' : '') +
        (mine ? '<button type="button" class="btn-text gd-withdraw">Withdraw</button>' : '') +
      '</div>' + (comments ? comments.proposalThreadHtml(q.id) : '') + '</li>';
  }

  // The box under the title: what changed since you last read it (read-point.js),
  // the proposed changes open, and the open comment threads (on the Comments page).
  function statusHtml(){
    var n = proposals.length, c = comments ? comments.openCount() : 0, bits = [];
    if (n) bits.push('<a href="#proposals">' + n + ' proposed change' + (n === 1 ? '' : 's') + '</a>');
    if (c) bits.push('<a href="comments.html?on=' + encodeURIComponent(COLLECTION + '/' + slug) + '">' + c + ' open comment' + (c === 1 ? '' : 's') + '</a>');
    var inner = (readPoint ? readPoint.inner(x) : '') + (bits.length ? '<p class="rp-line rp-activity">' + bits.join(' · ') + '</p>' : '');
    return inner ? '<aside class="read-point" aria-label="What’s new">' + inner + '</aside>' : '';
  }

  function proposalsHtml(){
    if (!proposals.length) return '';
    return '<section class="block guide-proposals" id="proposals"><div class="block-head"><h2>Proposed changes</h2></div>' +
      '<ul class="gd-proposal-list">' + proposals.map(proposalHtml).join('') + '</ul></section>';
  }

  // Applied by the server, which checks who decides it.
  function decide(q, accept){
    // editedAt: the version decided on, in case it's edited meanwhile.
    return firebase.app().functions('europe-west2').httpsCallable('decideProposal')({ collection: COLLECTION, slug: slug, id: q.id, accept: accept, editedAt: q.editedAt || 0 });
  }

  // Proposes a change, once they've agreed to it telling the PIs and admins (it rejects with
  // { cancelled: true } if not). change: { kind, partId, before, after, note } → Promise.
  function submit(change){
    return BOLD.confirmProposal(change.kind === 'restore' ? 'restore' : 'propose').then(function(ok){
      if (!ok) throw { cancelled: true };
      return add(change);
    });
  }
  function add(change){
    return ref.collection('proposals').add(Object.assign({}, change, {
      by: { email: me.email, name: me.name }, at: Date.now(), status: 'open',
    })).then(function(){ notice = 'Thanks — your change is under “Proposed changes” until ' + (fullWrite ? 'another' : 'a') + ' PI or admin reviews it.'; });
  }

  // ---------- page ----------

  function render(){
    if (!loaded) return;
    drawHistory();
    if (isNew) {
      document.title = 'New guide | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + EYEBROW_HTML + '<h1>New guide</h1>' +
        (fullWrite ? '' : '<p class="hero-note">' + G.NOT_PI + '.</p>') + '</div>' + (fullWrite ? '<main>' + newFormHtml() + '</main>' : '');
      if (fullWrite) bindNew();
      return;
    }
    if (!x) {
      document.title = 'Not found | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<h1>Not found</h1><p class="hero-note">It may have been deleted.</p></div>';
      return;
    }
    document.title = x.title + ' | BOLD Lab';
    if (viewing && !viewed()) viewing = null; // decided or withdrawn meanwhile
    if (viewing) { renderViewing(); return; }
    var off = fullWrite ? '' : ' disabled title="' + G.NOT_PI + '"';
    var hero = '<div class="hero">' + BACK + EYEBROW_HTML;
    if (form && form.kind === 'about') hero += aboutFormHtml();
    else hero += '<h1>' + esc(doc().title) + '</h1>' + (doc().description ? '<p class="hero-note">' + esc(doc().description) + '</p>' : '') +
      '<div class="event-controls"><button type="button" class="btn-text gd-about">' + 'Suggest a change' + '</button>' +
      (DELETABLE ? '<button type="button" class="btn-text danger gd-delete"' + off + '>Delete guide</button>' : '') + '</div>';
    hero += '</div>';
    var adding = form && form.kind === 'add';
    body.innerHTML = hero + '<main>' +
      (notice ? '<p class="gd-notice">' + esc(notice) + '</p>' : '') +
      draftHtml() +
      statusHtml() +
      tabsHtml() +
      // The contents sit beside the parts and stay on screen (above them on narrow screens).
      '<div class="guide-layout"><div class="guide-main">' +
      (adding && form.newTab ? '<section class="guide-part">' + partFormHtml(null) + '</section>' : foldAllHtml() + shown().map(partHtml).join('') +
      (adding ? '<section class="guide-part">' + partFormHtml(null) + '</section>' :
        '<button type="button" class="event-add gd-add"' + (proposeOff() ? ' disabled title="' + esc(proposeOff()) + '"' : '') + '>' + '+ Suggest a new part' + '</button>')) +
      proposalsHtml() + (readPoint ? readPoint.readersHtml() : '') + '</div>' + contentsHtml() + '</div></main>';
    var open = body.querySelector('.guide-form');
    if (open) bindForm(open);
    var dn = body.querySelector('.gd-draft-note');
    if (dn) dn.addEventListener('input', function(){ draftNote = dn.value; saveDraft(); });
    watchContents();
    if (comments && !form) comments.decorate();
  }

  // The draft's bar: how many changes, each on request, and Propose all / Discard.
  function changeLabel(c){
    if (c.kind === 'about') return 'New title and description';
    if (c.kind === 'move' && c.after && c.after.tab) return 'Move the tab “' + esc(c.after.title || 'Other') + '”';
    if (c.kind === 'add' && c.after && c.after.section && !(x.parts || []).some(function(p){ return p.section === c.after.section; })) {
      return 'New tab “' + esc(c.after.section) + '”, with “' + esc(c.after.title || '') + '”';
    }
    return KIND[c.kind] + ' “' + esc((c.after || c.before || {}).title || '') + '”';
  }
  function draftHtml(){
    if (!draft.length && !draftEditing && !commitTo) return '';
    var n = draft.length + (draft.length === 1 ? ' change' : ' changes');
    var head = commitTo ? '<strong>On your proposal:</strong> ' + (draft.length ? n + ' not added to it yet.' : 'change the page here to add to it.') :
      draftEditing ? '<strong>Editing your proposed change:</strong> ' + n + '. Others see it as proposed until you update it.' :
      '<strong>Your draft:</strong> ' + n + ', not proposed yet. It shows here only for you.';
    return '<aside class="gd-draft" aria-label="Your draft">' +
      '<p class="gd-draft-head"><span>' + head + '</span>' +
        '<span class="gd-draft-actions">' + (draft.length ? '<button type="button" class="btn-text gd-draft-toggle">' + (draftOpen ? 'Hide' : 'Review') + '</button>' : '') +
        (draft.length || !commitTo ? '<button type="button" class="btn-text danger gd-draft-discard">' + (draftEditing ? 'Cancel editing' : commitTo ? 'Discard them' : 'Discard') + '</button>' : '') + '</span></p>' +
      (draftOpen && draft.length ? '<ol class="gd-draft-list">' + draft.map(function(c, i){
        return '<li><span>' + changeLabel(c) + (c.note ? ' · ' + esc(c.note) : '') + '</span>' +
          '<button type="button" class="btn-text gd-draft-drop" data-i="' + i + '">Remove</button>' +
          BoldHistory.changesHtml(sideText(c.kind, c.before), sideText(c.kind, c.after), {}) + '</li>';
      }).join('') + '</ol>' : '') +
      (draft.length ? '<div class="event-form gd-draft-form"><label>What you changed and why<input type="text" class="gd-draft-note" maxlength="300" value="' + esc(draftNote) + '" placeholder="e.g. Brought the setup section up to date"></label>' +
        (draftError ? '<p class="ev-error">' + esc(draftError) + '</p>' : '') +
        '<div class="event-form-actions"><button type="button" class="ev-save gd-draft-propose"' + (draftBusy ? ' disabled' : '') + '>' +
          (commitTo ? 'Add to the proposal' : draftEditing ? 'Update proposed change' : 'Propose ' + (draft.length === 1 ? 'it' : 'all ' + draft.length)) + '</button></div></div>' :
        commitTo ? '' : '<p class="gd-draft-empty">No changes left. To drop the proposal, withdraw it under “Proposed changes”.</p>') +
      '</aside>';
  }
  // A change as a proposal stores it (a draft's changes keep their own notes).
  function asProposal(){
    var note = draftNote.trim();
    return draft.length === 1 ? Object.assign({}, draft[0], { note: note }) :
      { kind: 'batch', partId: '', before: null, after: null, changes: draft, note: note };
  }
  function proposeDraft(){
    if (draftBusy || !draft.length) return;
    draftNote = (body.querySelector('.gd-draft-note') || {}).value || draftNote;
    if (!draftNote.trim()) { draftError = 'Say what you changed and why, for whoever reviews it.'; render(); return; }
    draftBusy = true; draftError = ''; render();
    var q = draftEditing && proposals.filter(function(p){ return p.id === draftEditing; })[0], cq = committing();
    // On your branch: these changes after its own, each with this note and time, like a commit.
    var job = cq ? BOLD.confirmProposal('edit').then(function(ok){
        if (!ok) throw { cancelled: true };
        var now = Date.now(), strip = function(c, at){ return { kind: c.kind, partId: c.partId || '', before: c.before === undefined ? null : c.before, after: c.after === undefined ? null : c.after, note: c.note || '', at: c.at || at }; };
        var had = cq.kind === 'batch' ? (cq.changes || []).map(function(c){ return strip(c, cq.at); }) : [strip(cq, cq.at)];
        var added = draft.map(function(c){ return Object.assign(strip(c, now), { note: draftNote.trim() }); });
        if (had.length + added.length > 50) throw { tooMany: true };
        return ref.collection('proposals').doc(cq.id).set({ kind: 'batch', partId: '', before: null, after: null, changes: had.concat(added), note: cq.note || '', by: cq.by, at: cq.at, status: 'open', editedAt: now });
      }).then(function(){ notice = 'Added to your proposal.'; }) :
    // The proposal as it is now, its proposer, time and status kept: firestore.rules allow nothing else.
      q ? BOLD.confirmProposal('edit').then(function(ok){
        if (!ok) throw { cancelled: true };
        return ref.collection('proposals').doc(q.id).set(Object.assign(asProposal(), { by: q.by, at: q.at, status: 'open', editedAt: Date.now() }));
      }).then(function(){ notice = 'Your proposed change is updated.'; }) :
      submit(asProposal());
    job.then(function(){
      clearDraft(); draftBusy = false; render();
    }).catch(function(err){
      if (err && err.cancelled) { draftBusy = false; render(); return; }
      console.error('[BOLD Guides] proposing the draft failed', err);
      draftBusy = false; draftError = err && err.tooMany ? 'A proposal holds 50 changes at most: propose these on their own.' : 'Couldn’t ' + (q || cq ? 'update' : 'propose') + ' it — try again.'; render();
    });
  }
  // Makes your proposed change q your draft, to change it.
  function editProposal(q){
    if (draftEditing === q.id) { draftOpen = true; render(); body.scrollIntoView({ block: 'start' }); return; }
    if (draft.length && !window.confirm('Editing it replaces your ' + (draftEditing ? 'edits to your other proposed change' : 'draft of ' + draft.length + (draft.length === 1 ? ' change' : ' changes')) + '. Go on?')) return;
    var strip = function(c){ return { kind: c.kind, partId: c.partId || '', before: c.before === undefined ? null : c.before, after: c.after === undefined ? null : c.after, note: c.note || '' }; };
    draft = q.kind === 'batch' ? (q.changes || []).map(strip) : [Object.assign(strip(q), { note: '' })];
    draftNote = q.note || ''; draftEditing = q.id; draftOpen = true; draftError = ''; notice = '';
    viewing = null; form = null;
    saveDraft(); render();
    body.scrollIntoView({ block: 'start' });
  }
  // Moves the current tab left (-1) or right (1): all its parts as a block, into your draft.
  function moveTab(by){
    var secs = sections(), name = currentTab(), i = secs.indexOf(name), j = i + by;
    if (name === null || j < 0 || j >= secs.length) return;
    var order = secs.slice(); order[i] = secs[j]; order[j] = name;
    placeTabs(name, order, by < 0 ? 'left' : 'right');
  }
  // The tabs in a new order (name: the one moved), into your draft.
  function placeTabs(name, order, how){
    if (order.join('\u0000') === sections().join('\u0000')) return;
    var ids = function(list){ return list.map(function(p){ return p.id; }); };
    var after = [];
    order.forEach(function(sec){ after = after.concat(parts().filter(function(p){ return (p.section || '') === sec; })); });
    draft.push({ kind: 'move', partId: '', before: { title: name, tab: true, order: ids(parts()) }, after: { title: name, tab: true, order: ids(after) },
      note: 'Moved the tab “' + (name || 'Other') + '” ' + how });
    saveDraft(); notice = ''; tab = name;
    render();
  }

  // A move of part p to position pos (as the Move form's), for your draft.
  function moveChange(p, pos, how){
    var now = { title: p.title, order: parts().map(function(q){ return q.id; }) }, then = placed(p, pos);
    var after = { title: p.title, order: then.order };
    if (hasSections()) { now.section = p.section || ''; after.section = then.section; }
    if (now.order.join() === after.order.join() && now.section === after.section) return null;
    return { kind: 'move', partId: p.id, before: now, after: after, note: 'Moved “' + p.title + '” ' + how };
  }
  function stageMove(change){
    if (!change) return;
    draft.push(change); saveDraft(); notice = ''; render();
  }
  // Dragging a part (by its grip): above or below another part, by which half it's
  // dropped on, or onto a tab, to the end of it.
  var draggedPart = null;
  function partDropSide(e, el){ var r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; }
  body.addEventListener('dragstart', function(e){
    var g = e.target.closest && e.target.closest('.gd-grip');
    if (!g) return;
    draggedPart = g.getAttribute('data-id');
    var sec = g.closest('.guide-part'); if (sec) sec.classList.add('gd-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', draggedPart); if (sec) e.dataTransfer.setDragImage(sec, 20, 20); } catch (err){}
  });
  body.addEventListener('dragover', function(e){
    if (draggedPart === null || !e.target.closest) return;
    var el = e.target.closest('.guide-part[data-pid]') || e.target.closest('.guide-tab[data-sec]');
    if (!el) return;
    e.preventDefault();
    clearDrop();
    var src = body.querySelector('.guide-part[data-pid="' + CSS.escape(draggedPart) + '"]'); if (src) src.classList.add('gd-dragging');
    if (el.classList.contains('guide-tab')) el.classList.add('gd-drop-into');
    else if (el.getAttribute('data-pid') !== draggedPart) el.classList.add('gd-drop-' + partDropSide(e, el));
  });
  body.addEventListener('drop', function(e){
    if (draggedPart === null || !e.target.closest) return;
    var el = e.target.closest('.guide-part[data-pid]') || e.target.closest('.guide-tab[data-sec]');
    if (!el) return;
    e.preventDefault();
    var p = part(draggedPart); draggedPart = null; clearDrop();
    if (!p) return;
    if (el.classList.contains('guide-tab')) {
      var sec = el.getAttribute('data-sec');
      var last = parts().filter(function(q){ return q.id !== p.id && (q.section || '') === sec; }).pop();
      stageMove(moveChange(p, last ? 'after:' + last.id : 'top:' + sec, 'to the tab “' + (sec || 'Other') + '”'));
      return;
    }
    var target = part(el.getAttribute('data-pid'));
    if (!target || target.id === p.id) return;
    var side = partDropSide(e, el), pos;
    if (side === 'after') pos = 'after:' + target.id;
    else {
      var tsec = target.section || '';
      var prev = parts().filter(function(q){ return q.id !== p.id; });
      var at = prev.indexOf(target), before = at > 0 ? prev[at - 1] : null;
      pos = before && (!hasSections() || (before.section || '') === tsec) ? 'after:' + before.id : 'top:' + (hasSections() ? tsec : '');
    }
    stageMove(moveChange(p, pos, side + ' “' + target.title + '”'));
  });

  // Dragging a tab onto another: before it or after it, by which half it's dropped on.
  var dragged = null;
  function dropSide(e, a){ var r = a.getBoundingClientRect(); return e.clientX < r.left + r.width / 2 ? 'before' : 'after'; }
  function clearDrop(){ Array.prototype.forEach.call(body.querySelectorAll('.gd-drop-before, .gd-drop-after, .gd-drop-into, .gd-dragging'), function(el){ el.classList.remove('gd-drop-before', 'gd-drop-after', 'gd-drop-into', 'gd-dragging'); }); }
  body.addEventListener('dragstart', function(e){
    var a = e.target.closest && e.target.closest('.guide-tab[data-sec]');
    if (!a) return;
    dragged = a.getAttribute('data-sec');
    a.classList.add('gd-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragged); } catch (err){}
  });
  body.addEventListener('dragover', function(e){
    var a = dragged !== null && e.target.closest && e.target.closest('.guide-tab[data-sec]');
    if (!a) return;
    e.preventDefault();
    clearDrop(); body.querySelector('.guide-tab[data-sec="' + CSS.escape(dragged) + '"]').classList.add('gd-dragging');
    if (a.getAttribute('data-sec') !== dragged) a.classList.add('gd-drop-' + dropSide(e, a));
  });
  body.addEventListener('drop', function(e){
    var a = dragged !== null && e.target.closest && e.target.closest('.guide-tab[data-sec]');
    if (!a) return;
    e.preventDefault();
    var target = a.getAttribute('data-sec'), name = dragged, side = dropSide(e, a);
    dragged = null; clearDrop();
    if (target === name) return;
    var order = sections().filter(function(v){ return v !== name; });
    order.splice(order.indexOf(target) + (side === 'after' ? 1 : 0), 0, name);
    placeTabs(name, order, side + ' “' + (target || 'Other') + '”');
  });
  body.addEventListener('dragend', function(){ dragged = null; draggedPart = null; clearDrop(); });

  // Adds a change to your draft. Editing or removing a part the draft last added or
  // edited changes that instead, so the draft holds one change per part.
  function stage(c){
    var i = -1;
    draft.forEach(function(d, j){ if (c.partId && d.partId === c.partId) i = j; });
    var last = i === -1 ? null : draft[i];
    if (last && c.kind === 'edit' && (last.kind === 'edit' || last.kind === 'add')) {
      last.after = Object.assign({}, last.after, c.after);
      if (c.note) last.note = c.note;
      var same = last.kind === 'edit' && last.before && last.after.title === last.before.title && last.after.body === last.before.body &&
        (last.after.section === undefined || last.after.section === (last.before.section || ''));
      if (same) draft.splice(i, 1);
    } else if (last && c.kind === 'remove' && last.kind === 'add') { dropFromDraft(i); return; }
    else if (last && c.kind === 'remove' && last.kind === 'edit') { draft[i] = Object.assign({}, c, { before: last.before }); }
    else draft.push(c);
    saveDraft();
  }

  // Removing a change also removes later ones on the part it added.
  function dropFromDraft(i){
    var c = draft[i];
    draft = draft.filter(function(d, j){ return j !== i && !(j > i && c.kind === 'add' && d.partId === c.partId); });
    saveDraft(); render();
  }

  // Runs fn (which re-renders) keeping part id's title where it is on screen.
  function keepInPlace(id, fn){
    var el = id && document.getElementById(PREFIX + id), was = el ? el.getBoundingClientRect().top : null;
    fn();
    var now = id && document.getElementById(PREFIX + id);
    // At once, not smoothly (bold.css scrolls smoothly), so nothing seems to move.
    if (now && was !== null) window.scrollBy({ top: now.getBoundingClientRect().top - was, behavior: 'instant' });
  }

  // Collapse all / Expand all, for the parts on show.
  // At the end of the tab bar, or (no tabs) on a line of its own above the parts.
  function foldAllButton(){
    var list = shown();
    if (list.length < 2 || viewing || (form && form.newTab)) return '';
    var all = list.every(function(p){ return folded[p.id]; });
    var icon = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (all ? '<path d="M4 3.5 8 7.5l4-4M4 8.5l4 4 4-4"/>' : '<path d="M4 7.5 8 3.5l4 4M4 12.5l4-4 4 4"/>') + '</svg>';
    return '<button type="button" class="gd-fold-all-btn" data-fold="' + (all ? '0' : '1') + '">' + icon + (all ? 'Expand all' : 'Collapse all') + '</button>';
  }
  function foldAllHtml(){
    if (currentTab() !== null) return '';
    var b = foldAllButton();
    return b ? '<div class="gd-fold-all">' + b + '</div>' : '';
  }

  // The page as the proposal on show would make it: no controls, the changed part
  // marked, and a bar to go back.
  function renderViewing(){
    var q = viewed(), d = doc();
    var what = q.kind === 'about' ? 'a new title and description' : q.kind === 'restore' ? 'restoring an earlier version' :
      q.kind === 'batch' ? (q.changes || []).length + ' changes' :
      { edit: 'a change to', add: 'a new part,', remove: 'removing', move: 'moving' }[q.kind] + ' “' + esc((q.after || q.before || {}).title || '') + '”';
    // A proposal is the site's branch, whose bar (bold.js) is at the bottom: this says how, at the top.
    body.innerHTML = '<div class="gd-viewing' + (q.version ? '' : ' is-inline') + '" role="status"><span>' + (q.version ? 'Viewing the page as it was on ' + esc(BoldHistory.when(q.at)) :
        'Viewing the page as proposed by ' + esc(q.by ? (q.by.name || q.by.email) : 'someone') + ': ' + what) +
        '.</span>' +
        (stateOf(q) === 'conflict' ? ' <span>It conflicts with a change made since: this is the text as proposed.</span>' : stateOf(q) === 'behind' ? ' <span>Merged with the changes made since, as accepting would.</span>' : '') +
        '<button type="button" class="btn-text gd-view-exit">Back to the current page</button></div>' +
      '<div class="hero">' + BACK + EYEBROW_HTML + '<h1' + (q.kind === 'about' || (q.kind === 'batch' && (q.changes || []).some(function(c){ return c.kind === 'about'; })) ? ' class="gd-proposed"' : '') + '>' + esc(d.title) + '</h1>' +
        (d.description ? '<p class="hero-note">' + esc(d.description) + '</p>' : '') + '</div>' +
      '<main>' + tabsHtml() + '<div class="guide-layout"><div class="guide-main">' + shown().map(partHtml).join('') + '</div>' + contentsHtml() + '</div></main>';
    watchContents();
  }

  // The parts a proposal changes.
  function changedIds(q){
    if (!q) return [];
    return (q.kind === 'batch' ? q.changes || [] : [q]).map(function(c){ return c.partId; }).filter(Boolean);
  }

  // This page's proposal the site is on (bold.js's branch, the Version pill), or ''.
  function branchPrefix(){ return COLLECTION + '/' + slug + '/proposals/'; }
  function branchHere(){ var b = BOLD.branch(); return b && b.ref.indexOf(branchPrefix()) === 0 ? b.ref.slice(branchPrefix().length) : ''; }
  // Viewing a proposal puts the whole site on it (a branch), so other pages follow.
  // Your own (one you can edit: not a restore, or a row of who can see what) is your branch to add to.
  function canCommit(q){ return !!(q && me && q.by && q.by.email === me.email && q.kind !== 'restore' && q.kind !== 'access'); }
  function enterCommit(id){
    commitTo = id; viewing = null; form = null; notice = '';
    loadDraft(); draftOpen = !!draft.length; render();
    body.scrollIntoView({ block: 'start' });
  }
  function view(id){
    var bq = id !== VERSION && proposals.filter(function(q){ return q.id === id; })[0];
    if (bq && branchHere() !== id) BOLD.setBranch({ ref: branchPrefix() + id, title: doc().title + ': ' + whatText(bq), url: location.pathname.split('/').pop() + location.search }, { quiet: true });
    if (canCommit(bq)) { enterCommit(id); return; }
    if (!viewing) tabBefore = tab;
    viewing = id; form = null; notice = '';
    var q = viewed(), ids = changedIds(q), target = parts().filter(function(p){ return ids.indexOf(p.id) !== -1; })[0];
    if (target && hasSections()) tab = target.section || '';
    render();
    var el = target && document.getElementById(anchor(target));
    (el || body).scrollIntoView({ block: 'start' });
  }
  function stopViewing(){
    var id = viewing;
    if (id !== VERSION && branchHere()) {
      // A branch that changes who can see what: the page is drawn again without it.
      if (BOLD.branch().pages) { BOLD.setBranch(null); return; }
      BOLD.setBranch(null, { quiet: true });
    }
    viewing = null; viewedVersion = null; tab = tabBefore; render();
    var li = body.querySelector('.gd-proposal[data-id="' + id + '"]');
    if (li) li.scrollIntoView({ block: 'center' });
  }

  function closeForm(){ form = null; render(); }

  function bindForm(el){
    el.querySelector('.ev-cancel').addEventListener('click', closeForm);
    var previewBox = el.querySelector('.gd-preview-box'), text = el.querySelector('.gd-body');
    Array.prototype.forEach.call(el.querySelectorAll('.gd-mode'), function(b){
      b.addEventListener('click', function(){
        var preview = b.getAttribute('data-mode') === 'preview';
        Array.prototype.forEach.call(el.querySelectorAll('.gd-mode'), function(o){
          o.classList.toggle('is-current', o === b); o.setAttribute('aria-selected', o === b ? 'true' : 'false');
        });
        // The preview as tall as the text box, so the form doesn't jump.
        if (preview) {
          previewBox.style.minHeight = text.offsetHeight + 'px';
          previewBox.innerHTML = text.value.trim() ? md(text.value) : '<p class="gd-preview-empty">Nothing to preview.</p>';
        }
        text.hidden = preview; previewBox.hidden = !preview;
        if (!preview) text.focus();
      });
    });
    // Each save button (Propose change, Add to draft) runs the form's save; staging says which.
    var buttons = el.querySelectorAll('.ev-save'), staging = false;
    var save = { addEventListener: function(type, fn){
      Array.prototype.forEach.call(buttons, function(b){ b.addEventListener(type, function(e){ staging = !!b.getAttribute('data-stage'); fn(e); }); });
    } };
    function setBusy(on){ Array.prototype.forEach.call(buttons, function(b){ b.disabled = on; }); }
    var v = function(c){ var f = el.querySelector(c); return f ? f.value : ''; };
    function run(change){
      if (new Blob([JSON.stringify(x.parts || []) + JSON.stringify(draft) + JSON.stringify(change)]).size > MAX_SIZE) { showError(el, 'That’s too much text for one guide.'); return; }
      if (staging) {
        stage(change); notice = '';
        closeForm();
        return;
      }
      setBusy(true);
      submit(change).then(closeForm).catch(function(err){
        if (err && err.cancelled) { setBusy(false); return; }
        console.error('[BOLD Guides] saving failed', err);
        showError(el, 'Couldn’t save — try again.');
        setBusy(false);
      });
    }
    function note(){ return v('.gd-note').trim(); }
    // A drafted change's note is optional: the draft has one of its own when proposed.
    function needNote(){
      if (!staging && !note()) { showError(el, 'Say what you changed and why, for whoever reviews it.'); return true; }
      return false;
    }
    if (form.kind === 'about') {
      save.addEventListener('click', function(){
        var after = { title: v('.gd-title').trim(), description: v('.gd-description').trim() };
        if (!after.title) { showError(el, 'Give the guide a title.'); return; }
        var d = doc();
        if (after.title === d.title && after.description === (d.description || '')) { closeForm(); return; }
        if (needNote()) return;
        run({ kind: 'about', partId: '', before: { title: d.title, description: d.description || '' }, after: after, note: note() });
      });
      return;
    }
    if (form.kind === 'move') {
      var mp = part(form.id);
      el.querySelector('.gd-move-to').addEventListener('change', function(e){ form.to = e.target.value; });
      save.addEventListener('click', function(){
        var to = v('.gd-move-to');
        if (to === currentPosition(mp)) { closeForm(); return; }
        var now = { title: mp.title, order: parts().map(function(q){ return q.id; }) }, then = placed(mp, to);
        var after = { title: mp.title, order: then.order };
        if (hasSections()) { now.section = mp.section || ''; after.section = then.section; }
        var label = el.querySelector('.gd-move-to').selectedOptions[0].textContent.replace(/ \(where it is now\)$/, '');
        run({ kind: 'move', partId: mp.id, before: now, after: after,
          note: note() || 'Moved “' + mp.title + '”: ' + label.charAt(0).toLowerCase() + label.slice(1) });
      });
      return;
    }
    var p = form.kind === 'edit' ? part(form.id) : null;
    save.addEventListener('click', function(){
      var after = { title: v('.gd-title').trim(), body: v('.gd-body').replace(/\s+$/, '') };
      if (el.querySelector('.gd-section')) after.section = v('.gd-section').trim();
      if (form.newTab) {
        if (!after.section) { showError(el, 'Name the tab.'); return; }
        if (sections().indexOf(after.section) !== -1) { showError(el, 'There’s already a tab called ' + after.section + '.'); return; }
      }
      if (!after.title) { showError(el, 'Give the part a title.'); return; }
      if (!after.body.trim()) { showError(el, 'Write the part’s text.'); return; }
      if (p && after.title === p.title && after.body === p.body && (after.section === undefined || after.section === (p.section || ''))) { closeForm(); return; }
      if (needNote()) return;
      if (form.newTab && staging) tab = after.section;
      run(p ? { kind: 'edit', partId: p.id, before: partSide(p), after: after, note: note() } :
        { kind: 'add', partId: G.partId(), before: null, after: after, note: note() });
    });
    var rm = el.querySelector('.gd-remove');
    if (rm) rm.addEventListener('click', function(){
      staging = draft.length > 0 || !!commitTo;
      if (needNote()) return;
      run({ kind: 'remove', partId: p.id, before: partSide(p), after: null, note: note() });
    });
  }

  function bindNew(){
    var el = body.querySelector('.guide-form');
    var title = el.querySelector('.gd-title'), slugIn = el.querySelector('.gd-slug');
    var touched = false;
    slugIn.addEventListener('input', function(){ touched = true; });
    title.addEventListener('input', function(){ if (!touched) slugIn.value = G.slugify(title.value); });
    el.querySelector('.ev-cancel').addEventListener('click', function(){ location.href = 'guides.html'; });
    el.querySelector('.ev-save').addEventListener('click', function(){
      var t = title.value.trim(), s = slugIn.value.trim(), d = el.querySelector('.gd-description').value.trim();
      if (!t) { showError(el, 'Give the guide a title.'); return; }
      if (!G.SLUG.test(s) || s.length > 60) { showError(el, 'The name can only have lowercase letters, numbers and single hyphens.'); return; }
      var save = el.querySelector('.ev-save');
      save.disabled = true;
      var newRef = db.collection('guides').doc(s);
      newRef.get().then(function(snap){
        if (snap.exists) { showError(el, 'There’s already a guide called ' + s + '.'); save.disabled = false; return; }
        var now = Date.now();
        return newRef.set(Object.assign({ slug: s, title: t, description: d, parts: [], createdAt: now, createdBy: me.email }, stamp('Added the guide')))
          .then(function(){ location.replace('guide.html?guide=' + encodeURIComponent(s)); });
      }).catch(function(err){
        console.error('[BOLD Guides] adding the guide failed', err);
        showError(el, 'Couldn’t add the guide — try again.');
        save.disabled = false;
      });
    });
  }

  // Proposes swapping a part with the one before or after it on show (in its tab).
  body.addEventListener('click', function(e){
    if (readPoint && readPoint.click(e)) return;
    if (comments && comments.click(e)) return;
    var t = e.target.closest('button');
    if (!t || t.disabled || !x) return;
    if (t.classList.contains('gd-view-exit')) { stopViewing(); return; }
    if (t.classList.contains('gd-fold') && !me) {
      var ofid = t.getAttribute('data-id');
      keepInPlace(ofid, function(){ folded[ofid] = !folded[ofid]; saveFolded(); render(); });
      return;
    }
    if (!me) return;
    if (t.classList.contains('gd-fold')) {
      var fid = t.getAttribute('data-id');
      keepInPlace(fid, function(){ folded[fid] = !folded[fid]; saveFolded(); render(); });
      return;
    }
    if (t.classList.contains('gd-fold-all-btn')) {
      var on = t.getAttribute('data-fold') === '1';
      // The part at the top of the screen stays there.
      var top = shown().filter(function(p){ var el = document.getElementById(anchor(p)); return el && el.getBoundingClientRect().bottom > 0; })[0];
      keepInPlace(top && top.id, function(){ shown().forEach(function(p){ folded[p.id] = on; }); saveFolded(); render(); });
      return;
    }
    if (t.classList.contains('gd-draft-toggle')) { draftOpen = !draftOpen; render(); return; }
    if (t.classList.contains('gd-tab-left') || t.classList.contains('gd-tab-right')) { if (!form) moveTab(t.classList.contains('gd-tab-left') ? -1 : 1); return; }
    if (t.classList.contains('gd-tab-add')) {
      notice = ''; form = { kind: 'add', newTab: true }; render();
      var nt = body.querySelector('.gd-new-tab'); if (nt) nt.focus();
      return;
    }
    if (t.classList.contains('gd-draft-propose')) { proposeDraft(); return; }
    if (t.classList.contains('gd-draft-drop')) { dropFromDraft(Number(t.getAttribute('data-i'))); return; }
    if (t.classList.contains('gd-draft-discard')) {
      if (draftEditing ? window.confirm('Stop editing? Your proposed change stays as it was.') :
        window.confirm('Discard your draft of ' + draft.length + (draft.length === 1 ? ' change' : ' changes') + '?')) { clearDraft(); render(); }
      return;
    }
    var id = t.getAttribute('data-id');
    if (t.classList.contains('gd-about')) { notice = ''; form = { kind: 'about' }; render(); }
    else if (t.classList.contains('gd-edit')) { notice = ''; form = { kind: 'edit', id: id }; render(); var f = document.getElementById(PREFIX + id); if (f) f.scrollIntoView({ block: 'start' }); }
    else if (t.classList.contains('gd-add')) { notice = ''; form = { kind: 'add' }; render(); body.querySelector('.guide-form .gd-title').focus(); }
    else if (t.classList.contains('gd-up') || t.classList.contains('gd-down')) {
      var mp = part(id);
      notice = ''; form = { kind: 'move', id: id, to: stepFrom(mp, t.classList.contains('gd-up') ? -1 : 1) };
      if (hasSections()) tab = mp.section || '';
      render();
      var mf = document.getElementById(PREFIX + id); if (mf) mf.scrollIntoView({ block: 'start' });
    }
    else if (t.classList.contains('gd-delete')) {
      if (!fullWrite || !window.confirm('Delete the guide “' + x.title + '” for good?')) return;
      // Stamp who's deleting it first: the history credits the last updatedBy.
      ref.update(stamp('')).then(function(){
        return ref.collection('proposals').get();
      }).then(function(snap){
        var batch = db.batch();
        snap.docs.forEach(function(d){ batch.delete(d.ref); });
        batch.delete(ref);
        return batch.commit();
      }).then(function(){ location.href = 'guides.html'; }).catch(function(err){
        console.error('[BOLD Guides] deleting the guide failed', err);
        window.alert('Couldn’t delete the guide — try again.');
      });
    } else {
      var li = t.closest('.gd-proposal');
      var q = li && proposals.filter(function(p){ return p.id === li.getAttribute('data-id'); })[0];
      if (!q) return;
      if (t.classList.contains('gd-view')) { view(q.id); return; }
      if (t.classList.contains('gd-revise')) { editProposal(q); return; }
      if (t.classList.contains('gd-rebase')) {
        t.disabled = true;
        try { rebase(q).catch(function(err){ console.error('[BOLD Guides] updating a proposal failed', err); window.alert('Couldn’t update it — try again.'); t.disabled = false; }); }
        catch (err) { window.alert('It changed in the same lines since: withdraw it and propose it again.'); t.disabled = false; }
        return;
      }
      var what = t.classList.contains('gd-accept') && fullWrite ? 'accept' : t.classList.contains('gd-decline') && fullWrite ? 'decline' : t.classList.contains('gd-withdraw') ? 'withdraw' : '';
      if (what) {
        t.disabled = true;
        BOLD.confirmProposal(what, q.by && q.by.name).then(function(ok){
          if (!ok) throw { cancelled: true };
          return what === 'withdraw' ? ref.collection('proposals').doc(q.id).delete() : decide(q, what === 'accept');
        }).catch(function(err){
          if (err && err.cancelled) { t.disabled = false; return; }
          console.error('[BOLD Guides] updating a proposal failed', err);
          window.alert(err && err.code === 'functions/failed-precondition' && err.message ? err.message : 'Couldn’t do that — try again.');
          t.disabled = false;
        });
      }
    }
  });

  function drawHistory(){
    var on = !!x && !isNew;
    historyWrap.hidden = !on;
    if (on && histPanel) histPanel.refresh();
    if (!on || histPanel) return;
    histPanel = BoldHistory.mount(document.getElementById('guideHistory'), {
      ref: ref,
      fields: {},
      flatten: flatten,
      // Resolved comments are listed among the edits.
      extras: function(){ return comments ? comments.resolvedItems() : []; },
      canRestore: function(){ return !!me; },
      view: function(v){ if (!v || !v.data) return; viewedVersion = v; view(VERSION); },
      restore: function(v){
        return submit({ kind: 'restore', partId: '', before: null, note: 'Restore the version of ' + BoldHistory.when(v.at),
          after: { title: v.data.title || '', description: v.data.description || '', parts: v.data.parts || [], versionAt: v.at } })
          .then(render, function(err){ if (!(err && err.cancelled)) throw err; });
      },
    });
  }

  var unsubs = [], signIns = 0;
  // What the viewer may do here (Who can see what) can arrive after the page is drawn.
  BOLD.onAccess(function(){ if (loaded && !form) render(); });
  if (isNew) {
    BOLD.onUser(function(user){
      var mine = ++signIns;
      me = user ? { email: user.email || '', name: user.displayName || '' } : null;
      if (user) G.access(function(ok){ if (mine === signIns) { fullWrite = ok; loaded = true; render(); } });
    });
    return;
  }
  if (!ref) { loaded = true; render(); return; }
  // Don't redraw over a form being filled in. The page is drawn after it
  // loads, so a link to one of its parts (#…) is followed once it's there.
  // A link to the proposed changes (#proposals, as Slack sends PIs) waits for them too.
  var jumped = !location.hash, proposalsLoaded = false;
  var branchShown = false;
  function refresh(){
    if (form) return;
    // On a branch that's one of this page's proposals: shown as it would be accepted, once they're in.
    if (!branchShown && x && proposalsLoaded && !viewing && branchHere()) {
      branchShown = true;
      if (proposals.some(function(q){ return q.id === branchHere(); })) { view(branchHere()); return; }
    }
    var ready = !jumped && x && (proposalsLoaded || !/^#proposal/.test(location.hash)) &&
      (!commentFor(location.hash) || (comments && comments.ready() && proposalsLoaded));
    if (ready) tab = tabFor(location.hash);
    render();
    if (ready) { jumped = true; goTo(location.hash); }
  }
  // Shows what #hash names: a part (scrolled to) or a section's tab.
  function goTo(hash){
    var cid = commentFor(hash);
    if (cid) {
      var at = comments && comments.show(cid), p = at && !at.proposalId ? part(at.partId) : null;
      if (p && folded[p.id]) { folded[p.id] = false; saveFolded(); }
      render();
      var el = body.querySelector('.cm-comment[data-cid="' + CSS.escape(cid) + '"]') || (p && document.getElementById(anchor(p))) || (at && at.proposalId && document.getElementById('proposals'));
      if (el) el.scrollIntoView({ block: 'center' });
      return;
    }
    var id = decodeURIComponent(String(hash).replace(/^#/, ''));
    var fp = parts().filter(function(q){ return anchor(q) === id; })[0];
    if (fp && folded[fp.id]) { folded[fp.id] = false; saveFolded(); render(); }
    var target = document.getElementById(id);
    if (!target && tabFor(hash) !== null) target = document.getElementById('gdTabs');
    if (target) target.scrollIntoView({ block: 'start' });
  }
  // A section tab switches in place, the tab bar staying where it is on screen.
  body.addEventListener('click', function(e){
    var a = e.target.closest('.guide-tab');
    if (!a || !x || form || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var t = tabFor(a.getAttribute('href'));
    if (t === null) return;
    e.preventDefault();
    try { history.pushState(null, '', a.getAttribute('href')); } catch (err){}
    BOLD.switchTab('#gdTabs', body, function(){ tab = t; render(); });
  });
  // The sidebar's section links (and Back) change the #hash.
  window.addEventListener('hashchange', function(){
    if (!x || form) return;
    var t = tabFor(location.hash);
    if (t === null) return;
    tab = t;
    render();
    goTo(location.hash);
  });
  BOLD.onUser(function(user){
    var mine = ++signIns;
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: user.email || '', name: user.displayName || '' } : null;
    loadDraft();
    fullWrite = false;
    if (readPoint) readPoint.start(user);
    if (comments) comments.start(user);
    if (!user) return;
    G.access(function(ok){ if (mine === signIns) { fullWrite = ok; refresh(); } });
    unsubs.push(ref.onSnapshot(function(snap){
      loaded = true;
      x = snap.exists ? Object.assign({}, snap.data(), { slug: slug }) : null;
      refresh();
    }, function(err){
      console.error('[BOLD Guides] loading the guide failed', err);
      loaded = true; x = null; render();
    }));
    unsubs.push(ref.collection('proposals').where('status', '==', 'open').onSnapshot(function(snap){
      proposals = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return a.at - b.at; });
      proposalsLoaded = true;
      // Your branch decided or withdrawn meanwhile: bold.js takes the site off it; its staged changes go.
      if (commitTo && !committing()) { commitTo = null; loadDraft(); notice = 'Your proposal is no longer open.'; }
      // Decided or withdrawn while you were editing it: your edits stay, as a draft.
      if (draftEditing && !proposals.some(function(q){ return q.id === draftEditing; })) {
        draftEditing = null; saveDraft();
        notice = 'The proposed change you were editing is no longer open. Your edits are kept as a draft.';
      }
      refresh();
    }, function(err){ console.error('[BOLD Guides] loading proposed changes failed', err); }));
  });
})();
