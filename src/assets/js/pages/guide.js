// A how-to guide's page (guide.html?guide=<slug>) — one guides/{slug} doc (see
// guides-common.js): its title and description, its contents, then its parts,
// each written in Markdown. Anyone signed in can change any of it, PIs and
// admins too, only by proposing it: changing, adding or removing a part, the
// title and description, moving a part and restoring a version (history.js) are
// all proposals, listed under "Proposed changes" until a PI/admin other than
// whoever proposed it accepts it (decideProposal applies it, crediting both;
// firestore.rules allow no other write) or declines it. Whoever proposed one
// can withdraw it while it's open. PIs/admins add and delete guides
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
  var ref = !isNew && G.SLUG.test(slug) ? db.collection(COLLECTION).doc(slug) : null;
  var MAX_SIZE = 900000;

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
  var viewing = null, tabBefore = null;
  function viewed(){ return viewing ? proposals.filter(function(q){ return q.id === viewing; })[0] || null : null; }
  // Parts you've folded (only their title shows): this browser's, per guide.
  var folded = {};
  function foldKey(){ return 'bold-folded:' + COLLECTION + '/' + slug; }
  try { (JSON.parse(localStorage.getItem(foldKey()) || '[]') || []).forEach(function(id){ folded[id] = true; }); } catch (e){}
  function saveFolded(){ try { localStorage.setItem(foldKey(), JSON.stringify(Object.keys(folded).filter(function(k){ return folded[k]; }))); } catch (e){} }

  // Your draft: changes staged before proposing them together (one "batch"
  // proposal). Kept in this browser only, per guide and person.
  var draft = [], draftOpen = false, draftNote = '', draftBusy = false, draftError = '';
  function draftKey(){ return me && ref ? 'bold-draft:' + COLLECTION + '/' + slug + ':' + me.email : null; }
  function loadDraft(){
    draft = [];
    try { var raw = draftKey() && localStorage.getItem(draftKey()); if (raw) draft = JSON.parse(raw) || []; } catch (e){ draft = []; }
    if (!Array.isArray(draft)) draft = [];
  }
  function saveDraft(){
    try { if (draftKey()) { if (draft.length) localStorage.setItem(draftKey(), JSON.stringify(draft)); else localStorage.removeItem(draftKey()); } } catch (e){}
  }
  // The guide as shown: as it is, with the proposal on show applied, or with your draft.
  function doc(){
    if (!x) return x;
    var q = viewed();
    if (q) return Object.assign({}, x, applied(x, q));
    return draft.length ? Object.assign({}, x, applied(x, { kind: 'batch', changes: draft })) : x;
  }
  function parts(){ var d = doc(); return (d && d.parts) || []; }
  function part(id){ return parts().filter(function(p){ return p.id === id; })[0] || null; }
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
  // The section a #hash names: a section's slug, or one of its parts' id.
  function tabFor(hash){
    var h = decodeURIComponent(String(hash || '').replace(/^#/, ''));
    if (!h) return null;
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
    var icon = function(cls, label, svg, off){
      return '<button type="button" class="icon-btn ' + cls + '" data-id="' + esc(p.id) + '" aria-label="' + label + '" title="' + label + '"' + (off ? ' disabled' : '') + '>' + svg + '</button>';
    };
    var q = viewed(), fold = !!folded[p.id] && !q;
    // The grip drags it above or below another part, or onto a tab (into your draft).
    var grip = '<span class="icon-btn gd-grip" draggable="true" data-id="' + esc(p.id) + '" role="img" aria-label="Drag to move it" title="Drag to move it">' + GRIP + '</span>';
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
      (draft.length ? '<button type="button" class="ev-save" data-stage="1">Add to draft</button>' :
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
      '<textarea class="gd-body md-mentions" rows="16" aria-label="Text">' + esc(p.body) + '</textarea>' +
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
    if (q.kind === 'about') return { title: after.title || '', description: after.description || '' };
    if (q.kind === 'restore') return { title: after.title || '', description: after.description || '', parts: after.parts || [] };
    if (q.kind === 'add') {
      var np = Object.assign({ id: q.partId }, after), at = -1;
      list.forEach(function(p, i){ if (np.section && p.section === np.section) at = i; });
      if (at === -1) list.push(np); else list.splice(at + 1, 0, np);
      return { parts: list };
    }
    if (q.kind === 'remove') return { parts: list.filter(function(p){ return p.id !== q.partId; }) };
    if (q.kind === 'edit') { list.forEach(function(p){ if (p.id === q.partId) Object.assign(p, after); }); return { parts: list }; }
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
    var o = { Title: side.title || '', Text: side.body || '' };
    if (side.section !== undefined) o.Section = side.section;
    return o;
  }

  function proposalHtml(q){
    var cur = q.kind === 'about' ? { title: x.title, description: x.description || '' } : q.partId ? part(q.partId) : null;
    var stale = (q.kind === 'about' || q.kind === 'edit' || q.kind === 'remove') && (!cur || (q.before && (cur.title !== q.before.title || (q.kind === 'about' ? (cur.description || '') !== (q.before.description || '') :
      (cur.body || '') !== (q.before.body || '') || (q.before.section !== undefined && (cur.section || '') !== q.before.section)))));
    var what = q.kind === 'about' ? KIND.about : q.kind === 'restore' ? 'Restore the version of ' + esc(BoldHistory.when(q.after.versionAt)) :
      q.kind === 'batch' ? (q.changes || []).length + ' changes' :
      KIND[q.kind] + ' “' + esc((q.after || q.before || {}).title || '') + '”';
    var mine = me && q.by && q.by.email === me.email;
    var off = !fullWrite ? ' disabled title="' + G.NOT_PI + '"' :
      mine ? ' disabled title="Another PI or admin reviews your change"' : '';
    return '<li class="gd-proposal" data-id="' + esc(q.id) + '">' +
      '<p class="gd-proposal-head"><span class="hist-when">' + BoldHistory.when(q.at) + '</span>' +
        '<span>' + what + ' · proposed by ' + esc(q.by ? (q.by.name || q.by.email) : 'someone') + '</span></p>' +
      (q.note ? '<p class="gd-proposal-note">' + esc(q.note) + '</p>' : '') +
      (stale ? '<p class="gd-proposal-stale">' + (q.kind !== 'about' && !cur ? 'That part has since been removed.' : 'This has changed since it was proposed; accepting replaces the current text.') + '</p>' : '') +
      (q.kind === 'batch' ? '<ol class="gd-batch">' + (q.changes || []).map(function(c){
          return '<li><p class="hist-label">' + changeLabel(c) + (c.note ? ' · ' + esc(c.note) : '') + '</p>' + BoldHistory.changesHtml(sideText(c.kind, c.before), sideText(c.kind, c.after), {}) + '</li>';
        }).join('') + '</ol>' :
        BoldHistory.changesHtml(q.kind === 'restore' ? flatten(x) : sideText(q.kind, q.before), sideText(q.kind, q.after), {})) +
      '<div class="event-controls">' +
        '<button type="button" class="btn-text gd-view">View as proposed</button>' +
        '<button type="button" class="btn-text gd-accept"' + off + (q.kind !== 'add' && q.kind !== 'about' && q.kind !== 'restore' && q.kind !== 'batch' && !cur ? ' disabled' : '') + '>Accept</button>' +
        '<button type="button" class="btn-text danger gd-decline"' + off + '>Decline</button>' +
        (mine ? '<button type="button" class="btn-text gd-withdraw">Withdraw</button>' : '') +
      '</div>' + (comments ? comments.proposalThreadHtml(q.id) : '') + '</li>';
  }

  function proposalsHtml(){
    if (!proposals.length) return '';
    return '<section class="block guide-proposals" id="proposals"><div class="block-head"><h2>Proposed changes</h2></div>' +
      '<ul class="gd-proposal-list">' + proposals.map(proposalHtml).join('') + '</ul></section>';
  }

  // Applied by the server, which checks who decides it.
  function decide(q, accept){
    return firebase.app().functions('europe-west2').httpsCallable('decideProposal')({ collection: COLLECTION, slug: slug, id: q.id, accept: accept });
  }

  // Proposes a change. change: { kind, partId, before, after, note } → Promise.
  function submit(change){
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
      (DELETABLE ? '<button type="button" class="btn-text danger gd-delete"' + off + '>Delete guide</button>' : '') +
      (proposals.length ? '<a class="btn-text gd-pending" href="#proposals">' + proposals.length + ' proposed change' + (proposals.length === 1 ? '' : 's') + '</a>' : '') + '</div>';
    hero += '</div>';
    var adding = form && form.kind === 'add';
    body.innerHTML = hero + '<main>' +
      (notice ? '<p class="gd-notice">' + esc(notice) + '</p>' : '') +
      draftHtml() +
      (readPoint ? readPoint.html(x) : '') +
      tabsHtml() +
      // The contents sit beside the parts and stay on screen (above them on narrow screens).
      '<div class="guide-layout"><div class="guide-main">' +
      (adding && form.newTab ? '<section class="guide-part">' + partFormHtml(null) + '</section>' : foldAllHtml() + shown().map(partHtml).join('') +
      (adding ? '<section class="guide-part">' + partFormHtml(null) + '</section>' :
        '<button type="button" class="event-add gd-add">' + '+ Suggest a new part' + '</button>')) +
      proposalsHtml() + (readPoint ? readPoint.readersHtml() : '') + '</div>' + contentsHtml() + '</div></main>';
    var open = body.querySelector('.guide-form');
    if (open) bindForm(open);
    var dn = body.querySelector('.gd-draft-note');
    if (dn) dn.addEventListener('input', function(){ draftNote = dn.value; });
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
    if (!draft.length) return '';
    var n = draft.length + (draft.length === 1 ? ' change' : ' changes');
    return '<aside class="gd-draft" aria-label="Your draft">' +
      '<p class="gd-draft-head"><span><strong>Your draft:</strong> ' + n + ', not proposed yet. It shows here only for you.</span>' +
        '<span class="gd-draft-actions"><button type="button" class="btn-text gd-draft-toggle">' + (draftOpen ? 'Hide' : 'Review') + '</button>' +
        '<button type="button" class="btn-text danger gd-draft-discard">Discard</button></span></p>' +
      (draftOpen ? '<ol class="gd-draft-list">' + draft.map(function(c, i){
        return '<li><span>' + changeLabel(c) + (c.note ? ' · ' + esc(c.note) : '') + '</span>' +
          '<button type="button" class="btn-text gd-draft-drop" data-i="' + i + '">Remove</button>' +
          BoldHistory.changesHtml(sideText(c.kind, c.before), sideText(c.kind, c.after), {}) + '</li>';
      }).join('') + '</ol>' : '') +
      '<div class="event-form gd-draft-form"><label>What you changed and why<input type="text" class="gd-draft-note" maxlength="300" value="' + esc(draftNote) + '" placeholder="e.g. Brought the setup section up to date"></label>' +
        (draftError ? '<p class="ev-error">' + esc(draftError) + '</p>' : '') +
        '<div class="event-form-actions"><button type="button" class="ev-save gd-draft-propose"' + (draftBusy ? ' disabled' : '') + '>Propose ' + (draft.length === 1 ? 'it' : 'all ' + draft.length) + '</button></div></div>' +
      '</aside>';
  }
  function proposeDraft(){
    if (draftBusy) return;
    draftNote = (body.querySelector('.gd-draft-note') || {}).value || draftNote;
    if (!draftNote.trim()) { draftError = 'Say what you changed and why, for whoever reviews it.'; render(); return; }
    draftBusy = true; draftError = ''; render();
    var change = draft.length === 1 ? Object.assign({}, draft[0], { note: draftNote.trim() }) :
      { kind: 'batch', partId: '', before: null, after: null, changes: draft, note: draftNote.trim() };
    submit(change).then(function(){
      draft = []; saveDraft(); draftBusy = false; draftNote = ''; draftOpen = false; render();
    }).catch(function(err){
      console.error('[BOLD Guides] proposing the draft failed', err);
      draftBusy = false; draftError = 'Couldn’t propose it — try again.'; render();
    });
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
    body.innerHTML = '<div class="gd-viewing" role="status"><span>Viewing the page as proposed by ' + esc(q.by ? (q.by.name || q.by.email) : 'someone') + ': ' + what +
        '.</span>' +
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

  function view(id){
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
    viewing = null; tab = tabBefore; render();
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
        draft.push(change); saveDraft(); notice = '';
        closeForm();
        return;
      }
      setBusy(true);
      submit(change).then(closeForm).catch(function(err){
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
      staging = draft.length > 0;
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
    if (!t || t.disabled || !x || !me) return;
    if (t.classList.contains('gd-view-exit')) { stopViewing(); return; }
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
      if (window.confirm('Discard your draft of ' + draft.length + (draft.length === 1 ? ' change' : ' changes') + '?')) { draft = []; saveDraft(); draftNote = ''; render(); }
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
      var job = null;
      if (t.classList.contains('gd-accept') && fullWrite) job = decide(q, true);
      else if (t.classList.contains('gd-decline') && fullWrite && window.confirm('Decline this proposed change?')) job = decide(q, false);
      else if (t.classList.contains('gd-withdraw') && window.confirm('Withdraw your proposed change?')) job = ref.collection('proposals').doc(q.id).delete();
      if (job) {
        t.disabled = true;
        job.catch(function(err){
          console.error('[BOLD Guides] updating a proposal failed', err);
          window.alert('Couldn’t do that — try again.');
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
      restore: function(v){
        return submit({ kind: 'restore', partId: '', before: null, note: 'Restore the version of ' + BoldHistory.when(v.at),
          after: { title: v.data.title || '', description: v.data.description || '', parts: v.data.parts || [], versionAt: v.at } }).then(render);
      },
    });
  }

  var unsubs = [], signIns = 0;
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
  function refresh(){
    if (form) return;
    var ready = !jumped && x && (proposalsLoaded || location.hash !== '#proposals');
    if (ready) tab = tabFor(location.hash);
    render();
    if (ready) { jumped = true; goTo(location.hash); }
  }
  // Shows what #hash names: a part (scrolled to) or a section's tab.
  function goTo(hash){
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
      refresh();
    }, function(err){ console.error('[BOLD Guides] loading proposed changes failed', err); }));
  });
})();
