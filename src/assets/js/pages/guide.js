// A how-to guide's page (guide.html?guide=<slug>) — one guides/{slug} doc (see
// guides-common.js): its title and description, its contents, then its parts,
// each written in Markdown. Anyone signed in can change any of it, PIs and
// admins too, only on a branch of the site (#324, functions/branches.js): changing,
// adding or removing a part, the title and description, moving a part and restoring a
// version (history.js) are each a commit, on the branch you're on (bold.js BOLD.branch,
// the Version pill), or on main on a new one, which you're then on. The page is drawn
// as the branch you're on makes it. A branch has its own page, as a pull request
// (proposal.html?b=<id>), where a PI or admin who hasn't committed to it accepts it
// (decideBranch applies it, every page it changes together; firestore.rules allow no
// other write) or declines it. PIs/admins add and delete guides
// (guide.html?new is the form for a new one).
// Parts may carry a `section`: then the page has one tab per section, showing
// that section's parts (#<section-slug> or a part's #id opens its tab). The same page serves other documents edited this way (BOLDiquette:
// boldiquette.html), set by #guideBody's data attributes: data-collection,
// data-slug, data-eyebrow, data-back (a link, or "" for none), data-anchor-prefix,
// data-deletable and data-read-point ("true": what changed since the reader
// last marked it read, read-point.js).
// data-slot: the id of an element of the page, kept under the title on every redraw
// (Get started's onboarding).
(function(){
  var esc = BOLD.escapeHtml;
  var G = window.BoldGuides;
  var md = BoldMarkdown.render;
  var body = document.getElementById('guideBody');
  if (!body || !BOLD.getAuth()) return;
  var slot = document.getElementById(body.getAttribute('data-slot') || '');
  function keepSlot(){ var h = body.querySelector('.hero'); if (slot && h) { h.parentNode.insertBefore(slot, h.nextSibling); } }
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
    return '';
  }

  var x = null, loaded = false, fullWrite = false, me = null;
  var proposals = [];
  // The form that's open: null, { kind: 'about' }, { kind: 'edit', id } or { kind: 'add' }.
  var form = null, notice = '';
  var BACK = cfg.back !== undefined ? cfg.back : '<a class="back-link" href="guides.html">&larr; All guides</a>';
  var EYEBROW_HTML = EYEBROW ? '<div><span class="eyebrow">' + esc(EYEBROW) + '</span></div>' : '';
  var historyWrap = document.getElementById('guideHistoryWrap'), histPanel = null;
  var P = window.BoldProposals, KIND = P.KIND;
  var readPoint = cfg.readPoint === 'true' && ref ? BoldReadPoint.create({
    ref: ref, key: COLLECTION + '-' + slug, anchor: anchor, onChange: function(){ refresh(); },
  }) : null;
  // Comments on selected text (comments.js).
  var comments = ref && window.BoldComments ? BoldComments.create({
    ref: ref, root: body, area: AREA, fullWrite: function(){ return fullWrite; }, onChange: function(){ refresh(); },
  }) : null;

  // An earlier version on show (the History panel's View the page then): viewing is VERSION, and
  // viewedVersion the version, shown as a restore of it would make the page.
  var viewing = null, tabBefore = null, viewedVersion = null, VERSION = '#version';
  function viewed(){
    if (viewing === VERSION) return viewedVersion ? { id: VERSION, kind: 'restore', version: true, at: viewedVersion.at,
      after: { title: viewedVersion.data.title || '', description: viewedVersion.data.description || '', parts: viewedVersion.data.parts || [] } } : null;
    return null;
  }
  // Parts you've folded (only their title shows): this browser's, per guide.
  var folded = {};
  function foldKey(){ return 'bold-folded:' + COLLECTION + '/' + slug; }
  try { (JSON.parse(localStorage.getItem(foldKey()) || '[]') || []).forEach(function(id){ folded[id] = true; }); } catch (e){}
  function saveFolded(){ try { localStorage.setItem(foldKey(), JSON.stringify(Object.keys(folded).filter(function(k){ return folded[k]; }))); } catch (e){} }

  // The branch you're on (bold.js BOLD.branch): this page's part of it (proposals/<its id>, a batch of its
  // commits here), or null if it doesn't change this page (yet).
  var mine = null;
  function branchQ(){ return mine && (mine.status === 'open' || mine.status === 'draft') ? mine : null; }
  // Changes on this page from before branches (a draft kept in this browser): offered once, to propose.
  var legacy = [], TARGET = { collection: COLLECTION, slug: slug };
  function legacyKey(){ return me && ref ? 'bold-draft:' + COLLECTION + '/' + slug + ':' + me.email : null; }
  function loadLegacy(){
    legacy = [];
    try {
      var raw = legacyKey() && localStorage.getItem(legacyKey()), v = raw ? JSON.parse(raw) : null;
      legacy = Array.isArray(v) ? v : v && Array.isArray(v.changes) ? v.changes : [];
    } catch (e){ legacy = []; }
  }
  function dropLegacy(){ legacy = []; try { if (legacyKey()) localStorage.removeItem(legacyKey()); } catch (e){} }
  // The guide as shown: as the branch you're on makes it, or an earlier version on show.
  function doc(){
    if (!x) return x;
    var q = viewed() || branchQ();
    return q ? Object.assign({}, x, applied(x, q)) : x;
  }
  function parts(){ var d = doc(); return (d && d.parts) || []; }
  function part(id){ return parts().filter(function(p){ return p.id === id; })[0] || null; }
  // A part as main has it (a branch is measured against it).
  function livePart(id){ return ((x && x.parts) || []).filter(function(p){ return p.id === id; })[0] || null; }
  function anchor(p){ return PREFIX + p.id; }
  function hasSections(){ return parts().some(function(p){ return p.section; }); }

  // ---------- tabs (one per section) ----------

  var tab = null;
  // Parts this page leaves out of view (data-hide-parts, ids: Get started's Checklist on the
  // onboarding page, 2026-11-03). Only what's shown: proposals still carry every part.
  var hiddenParts = (body.getAttribute('data-hide-parts') || '').split(',').map(function(v){ return v.trim(); }).filter(Boolean);
  function visible(p){ return hiddenParts.indexOf(p.id) === -1; }
  function sections(){
    return parts().filter(visible).map(function(p){ return p.section || ''; }).filter(function(v, i, a){ return a.indexOf(v) === i; });
  }
  function currentTab(){
    if (!hasSections()) return null;
    return sections().indexOf(tab) !== -1 ? tab : sections()[0];
  }
  // The parts on show: the current tab's, or all of them.
  function shown(){
    var t = currentTab();
    return (t === null ? parts() : parts().filter(function(p){ return (p.section || '') === t; })).filter(visible);
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
    // The current tab's arrows move it (committed); + adds a tab. Not while viewing a proposal.
    var arrows = viewing || newTab ? '' : '<span class="gd-tab-move">' +
      '<button type="button" class="icon-btn gd-tab-left" aria-label="Move this tab left" title="Move this tab left"' + (i <= 0 ? ' disabled' : '') + '>' + BOLD.ICON_UP + '</button>' +
      '<button type="button" class="icon-btn gd-tab-right" aria-label="Move this tab right" title="Move this tab right"' + (i >= secs.length - 1 ? ' disabled' : '') + '>' + BOLD.ICON_DOWN + '</button></span>';
    return '<nav class="guide-tabs" id="gdTabs" aria-label="Sections">' + secs.map(function(v){
      var cur = v === t && !newTab;
      // Dragged onto another tab, it moves there (committed).
      var drag = viewing || form ? '' : ' draggable="true" data-sec="' + esc(v) + '" title="Drag to move this tab"';
      return '<a class="guide-tab' + (cur ? ' is-current' : '') + '" href="#' + esc(G.slugify(v)) + '"' + (cur ? ' aria-current="page"' : '') + drag + '>' +
        esc(v || 'Other') + '</a>' + (cur ? arrows : '');
    }).join('') +
      (viewing ? '' : '<button type="button" class="guide-tab gd-tab-add' + (newTab ? ' is-current' : '') + '" aria-label="Suggest a new tab" title="Suggest a new tab">+</button>') + foldAllButton() + '</nav>';
  }
  function stamp(note){ return { changeNote: note || '', updatedAt: Date.now(), updatedBy: me.email, proposedBy: '' }; }

  // What a version or the guide holds, as text to compare (history.js).
  var flatten = P.flatten;

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
    var q = viewed(), fold = !!folded[p.id] && !q, bq = branchQ();
    // The grip drags it above or below another part, or onto a tab (committed).
    var grip = why ? '' : '<span class="icon-btn gd-grip" draggable="true" data-id="' + esc(p.id) + '" role="img" aria-label="Drag to move it" title="Drag to move it">' + GRIP + '</span>';
    return '<section class="guide-part' + ((q || bq) && changedIds(q || bq).indexOf(p.id) !== -1 ? ' gd-proposed' : '') + (fold ? ' is-folded' : '') + '" id="' + anchor(p) + '" data-pid="' + esc(p.id) + '">' +
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

  // The branch you're on, as a name: "#12 Clearer setup".
  function branchName(){ var b = BOLD.branch(); return b ? (b.num ? '#' + b.num + ' ' : '') + (b.title || 'the proposed change') : ''; }
  function noteHtml(placeholder){
    return '<label>What you changed and why' +
      '<input type="text" class="gd-note" maxlength="300" placeholder="' + esc(placeholder) + '"></label>' +
      '<p class="event-form-hint">' + (BOLD.branch() ? 'It’s added to ' + esc(branchName()) + (BOLD.branch().draft ? ', a draft until it’s marked ready on its page.' : ', which ' + (fullWrite ? 'another PI or admin' : 'a PI or admin') + ' accepts before it shows.')
        : 'Propose change opens a proposed change for ' + (fullWrite ? 'another PI or admin' : 'a PI or admin') + ' to accept. Save draft opens it as a draft: nobody is asked yet, and you can keep adding to it.') + '</p>';
  }
  // A commit to the branch you're on; or, on main, a new branch with it: proposed, or a draft (Save draft).
  function actionsHtml(extra){
    return '<p class="ev-error" hidden></p><div class="event-form-actions">' +
      (BOLD.branch() ? '<button type="button" class="ev-save">Commit to ' + esc(BOLD.branch().num ? '#' + BOLD.branch().num : 'it') + '</button>'
        : '<button type="button" class="ev-save">Propose change</button><button type="button" class="ev-save ev-stage" data-draft="1">Save draft</button>') +
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
      // The Markdown field (md-field.js): Write or Preview, images.
      '<div class="gd-text-label">Text</div>' +
      '<textarea class="gd-body md-field" rows="16" aria-label="Text" data-preview-class="guide-text">' + esc(p.body) + '</textarea>' +
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
  var partSide = P.partSide;

  function showError(el, msg){ var b = el.querySelector('.ev-error'); b.textContent = msg; b.hidden = !msg; }

  // ---------- proposals ----------

  // The guide with change q applied, as decideBranch (functions/index.js appliedProposal) will apply it
  // (proposal-model.js, shared with a branch's page).
  var applied = P.applied, partIn = P.partIn;
  function sideText(kind, side){ return P.sideText(kind, side, doc()); }
  // Where this page's part of a branch stands against main: current, behind, conflict or gone.
  function stateOf(q){ return P.stateOf(x, q); }
  // Rebasing your proposal on main (#177), as git rebases a branch: its changes replayed in
  // order on the page as it is now, each merged with what changed since. Where one can't be
  // (main changed the same lines), it stops there for you to resolve: the part's text with
  // the conflicts marked as git marks them; Continue takes it from there. At the end the
  // proposal is saved on main. rebasing: { id, changes, single, i, cur (the page so far),
  // out (the changes rebased so far), resolve?: { part, title, titleWas, text, error } }.
  var rebasing = null;
  function startRebase(q){
    rebasing = { id: q.id, changes: q.kind === 'batch' ? (q.changes || []).slice() : [q], single: q.kind !== 'batch', i: 0, cur: x, out: [] };
    stepRebase();
  }
  function stepRebase(){
    var r = rebasing;
    while (r.i < r.changes.length) {
      var c = r.changes[r.i], p = c.kind === 'edit' && partIn(r.cur, c.partId), out = c;
      if (p) {
        var m = BoldMerge.mergeEdit(p, c.before, c.after || {});
        if (m.conflict) {
          var base = c.before || {}, want = c.after || {};
          var pick = function(k){ var b = base[k], w = want[k], n = p[k]; return w === undefined || n === w || b === n ? (w === undefined ? n : w) : w === b ? n : w; };
          r.resolve = { part: p, title: pick('title'), titleWas: base.title !== p.title && want.title !== base.title && want.title !== p.title ? p.title : '',
            text: typeof want.body === 'string' ? BoldMerge.mergeMarked(base.body === undefined ? p.body : base.body, p.body || '', want.body).text : p.body || '', error: '' };
          render();
          var el = body.querySelector('.gd-resolve');
          if (el) el.scrollIntoView({ block: 'center' });
          return;
        }
        out = Object.assign({}, c, { before: partSide(p), after: Object.assign({}, c.after, m.fields) });
      }
      r.cur = Object.assign({}, r.cur, applied(r.cur, out)); r.out.push(out); r.i++;
    }
    r.saving = true; render();
    // Saved by the server (functions/branches.js rebased): its commits as they are now, each by whoever made it.
    firebase.app().functions('europe-west2').httpsCallable('branchRebase')({ id: r.id, target: { collection: COLLECTION, slug: slug }, changes: r.out }).then(function(){
      rebasing = null; notice = 'It’s rebased on main.'; render();
      var el = body.querySelector('.gd-notice'); if (el) el.scrollIntoView({ block: 'center' });
    }, function(err){
      console.error('[BOLD Guides] rebasing a proposal failed', err);
      rebasing = null; notice = 'Couldn’t save the rebase — try again.'; render();
    });
  }
  // Continue: the resolved part, as this change now makes it, then the rest.
  function continueRebase(){
    var r = rebasing, v = r && r.resolve;
    if (!v) return;
    v.title = (body.querySelector('.gd-r-title') || {}).value || v.title; v.text = (body.querySelector('.gd-r-body') || {}).value || v.text;
    if (BoldMerge.hasMarkers(v.text)) { v.error = 'Some conflicts are still marked: keep what should stay and remove the <<<<<<<, ======= and >>>>>>> lines.'; render(); return; }
    if (!v.title.trim()) { v.error = 'Give the part a title.'; render(); return; }
    var c = r.changes[r.i], p = v.part;
    var out = Object.assign({}, c, { before: partSide(p), after: Object.assign({}, c.after, { title: v.title.trim(), body: v.text.replace(/\s+$/, '') }) });
    r.cur = Object.assign({}, r.cur, applied(r.cur, out)); r.out.push(out); r.i++;
    r.resolve = null;
    stepRebase();
  }
  function resolveHtml(){
    var r = rebasing, v = r.resolve, n = r.changes.length;
    return '<div class="event-form gd-resolve"><p class="gd-resolve-head"><strong>Resolving ' + (n > 1 ? 'change ' + (r.i + 1) + ' of ' + n + ', ' : '') + '“' + esc(v.part.title) + '”</strong>: main changed the same lines. ' +
        'Between <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; Main</code> and <code>=======</code> is main’s text, then yours, to <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code>. Keep what should stay and remove those lines.</p>' +
      (v.titleWas ? '<p class="event-form-hint">Main’s title for it is now “' + esc(v.titleWas) + '”.</p>' : '') +
      '<label>Title<input type="text" class="gd-r-title" maxlength="200" value="' + esc(v.title) + '"></label>' +
      '<label>Text<textarea class="gd-r-body md-field" rows="14" spellcheck="false" data-preview-class="guide-text">' + esc(v.text) + '</textarea></label>' +
      (v.error ? '<p class="ev-error">' + esc(v.error) + '</p>' : '') +
      '<div class="event-form-actions"><button type="button" class="ev-save gd-r-go">Continue</button><button type="button" class="ev-cancel gd-r-stop">Stop rebasing</button></div></div>';
  }

  // The box under the title: what changed since you last read it (read-point.js) and the open comment threads
  // (on the Comments page). The proposed changes are on proposals.html (the branch button, with a dot for new ones).
  function statusHtml(){
    var c = comments ? comments.openCount() : 0, bits = [];
    if (c) bits.push('<a href="comments.html?on=' + encodeURIComponent(COLLECTION + '/' + slug) + '">' + c + ' open comment' + (c === 1 ? '' : 's') + '</a>');
    var inner = (readPoint ? readPoint.inner(x) : '') + (bits.length ? '<p class="rp-line rp-activity">' + bits.join(' · ') + '</p>' : '');
    return inner ? '<aside class="read-point" aria-label="What’s new">' + inner + '</aside>' : '';
  }
  // On a branch: a line saying so, with its page; while rebasing, the conflict to resolve.
  function branchHtml(){
    var b = BOLD.branch();
    if (!b) return '';
    var r = rebasing && rebasing.resolve ? resolveHtml() : rebasing && rebasing.saving ? '<p class="gd-proposal-behind">Saving the rebase…</p>' : '';
    return '<aside class="gd-on-branch" aria-label="The proposed change you’re on"><p>You’re on ' + (b.draft ? 'the draft ' : '') + '<a href="' + esc(BOLD.branchPage(b.id)) + '">' + esc(branchName()) + '</a>' +
      (branchQ() ? ': its changes here are marked, and what you change is added to it.' : ': it doesn’t change this page yet; what you change here is added to it.') +
      (b.draft ? ' When it’s ready, mark it ready for review on its page.' : '') + '</p>' + r + '</aside>';
  }

  // A change, committed (BOLD.commit: to the branch you're on, or a new one, which you're then on).
  function commit(change, o){
    return BOLD.commit({ collection: COLLECTION, slug: slug }, change, o).then(function(r){
      notice = r.opened && o && o.draft ? 'Saved as a draft. You’re on it now: what you change is added to it. Mark it ready for review on its page.'
        : r.opened ? 'Proposed. You’re on it now: what you change is added to it, until you go back to main.' : 'Committed.';
      if (r.opened) watchBranch();
      return r;
    });
  }

  // ---------- page ----------

  // Rebase on main beside Back to main (bold.js's bar), on a branch whose part here main has moved on from.
  function offerRebase(){
    var q = branchQ(), st = q && me && !rebasing ? stateOf(q) : '';
    BOLD.setBranchAction(st === 'behind' || st === 'conflict' ? { label: 'Rebase on main', go: function(){ notice = ''; startRebase(q); } } : null);
  }
  function render(){
    if (!loaded) return;
    offerRebase();
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
    if (viewing && !viewed()) viewing = null;
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
      legacyHtml() +
      branchHtml() +
      statusHtml() +
      tabsHtml() +
      // The contents sit beside the parts and stay on screen (above them on narrow screens).
      '<div class="guide-layout"><div class="guide-main">' +
      (adding && form.newTab ? '<section class="guide-part">' + partFormHtml(null) + '</section>' : foldAllHtml() + shown().map(partHtml).join('') +
      (adding ? '<section class="guide-part">' + partFormHtml(null) + '</section>' :
        '<button type="button" class="event-add gd-add"' + (proposeOff() ? ' disabled title="' + esc(proposeOff()) + '"' : '') + '>' + '+ Suggest a new part' + '</button>')) +
      (readPoint ? readPoint.readersHtml() : '') + '</div>' + contentsHtml() + '</div></main>';
    keepSlot();
    var open = body.querySelector('.guide-form');
    if (open) bindForm(open);
    watchContents();
    if (comments && !form) comments.decorate();
  }

  function changeLabel(c){ return P.changeLabel(c, x); }
  // Changes from before branches, kept in this browser: proposed (each a commit, on a new branch or the one
  // you're on), or discarded.
  function legacyHtml(){
    if (!legacy.length || !me) return '';
    return '<aside class="gd-draft" aria-label="Changes not proposed yet"><p class="gd-draft-head"><span><strong>' + legacy.length + (legacy.length === 1 ? ' change' : ' changes') +
      ' you made here before</strong> ' + (legacy.length === 1 ? 'hasn’t' : 'haven’t') + ' been proposed: ' + legacy.map(changeLabel).join(', ') + '.</span>' +
      '<span class="gd-draft-actions"><button type="button" class="btn-text gd-legacy-go">' + (BOLD.branch() ? 'Commit to ' + esc(branchName()) : 'Save as a draft') + '</button>' +
      '<button type="button" class="btn-text danger gd-legacy-drop">Discard</button></span></p></aside>';
  }
  // All of them at once: on the branch you're on, or a new draft (branchCommit { commits }).
  function proposeLegacy(){
    var commits = legacy.map(function(c){
      var change = { kind: c.kind, partId: c.partId || '', before: c.before === undefined ? null : c.before, after: c.after === undefined ? null : c.after, note: c.note || changeLabel(c).replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '') };
      if (c.area) change.area = c.area;
      return { target: TARGET, change: change };
    });
    var data = { commits: commits, title: 'Earlier changes to ' + (x.title || slug) };
    if (BOLD.branch()) data.on = BOLD.branchId(); else data.draft = true;
    firebase.app().functions('europe-west2').httpsCallable('branchCommit')(data).then(function(r){
      var d = r.data || {};
      if (!BOLD.branch()) BOLD.setBranch({ id: d.id, num: d.num || 0, title: data.title, draft: true, targets: [COLLECTION + '/' + slug] }, { quiet: true });
      dropLegacy(); notice = BOLD.branch() && data.on ? 'Committed.' : 'Saved as a draft. You’re on it now: mark it ready for review on its page.'; watchBranch(); render();
    }, function(err){
      console.error('[BOLD Guides] saving earlier changes failed', err);
      notice = 'Couldn’t save them — try again.'; render();
    });
  }
  // Moves the current tab left (-1) or right (1): all its parts as a block, committed.
  function moveTab(by){
    var secs = sections(), name = currentTab(), i = secs.indexOf(name), j = i + by;
    if (name === null || j < 0 || j >= secs.length) return;
    var order = secs.slice(); order[i] = secs[j]; order[j] = name;
    placeTabs(name, order, by < 0 ? 'left' : 'right');
  }
  // The tabs in a new order (name: the one moved), committed.
  function placeTabs(name, order, how){
    if (order.join('\u0000') === sections().join('\u0000')) return;
    var ids = function(list){ return list.map(function(p){ return p.id; }); };
    var after = [];
    order.forEach(function(sec){ after = after.concat(parts().filter(function(p){ return (p.section || '') === sec; })); });
    notice = ''; tab = name;
    commitMove({ kind: 'move', partId: '', before: { title: name, tab: true, order: ids(parts()) }, after: { title: name, tab: true, order: ids(after) },
      note: 'Moved the tab “' + (name || 'Other') + '” ' + how });
  }

  // A move of part p to position pos (as the Move form's), to commit.
  function moveChange(p, pos, how){
    var now = { title: p.title, order: parts().map(function(q){ return q.id; }) }, then = placed(p, pos);
    var after = { title: p.title, order: then.order };
    if (hasSections()) { now.section = p.section || ''; after.section = then.section; }
    if (now.order.join() === after.order.join() && now.section === after.section) return null;
    return { kind: 'move', partId: p.id, before: now, after: after, note: 'Moved “' + p.title + '” ' + how };
  }
  // On main, a move opens a draft (dragging asks nobody anything); on a branch, it's committed to it.
  function commitMove(change){
    if (!change) return;
    notice = '';
    commit(change, { draft: !BOLD.branch() }).then(render, function(err){
      if (err && err.cancelled) { render(); return; }
      console.error('[BOLD Guides] moving failed', err);
      notice = 'Couldn’t move it — try again.'; render();
    });
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
      commitMove(moveChange(p, last ? 'after:' + last.id : 'top:' + sec, 'to the tab “' + (sec || 'Other') + '”'));
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
    commitMove(moveChange(p, pos, side + ' “' + target.title + '”'));
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



  // An earlier version on show (the History panel's View the page then): no controls, and a bar to go back.
  function renderViewing(){
    var q = viewed(), d = doc();
    body.innerHTML = '<div class="gd-viewing" role="status"><span>Viewing the page as it was on ' + esc(BoldHistory.when(q.at)) + '.</span>' +
        '<button type="button" class="btn-text gd-view-exit">Back to the current page</button></div>' +
      '<div class="hero">' + BACK + EYEBROW_HTML + '<h1>' + esc(d.title) + '</h1>' +
        (d.description ? '<p class="hero-note">' + esc(d.description) + '</p>' : '') + '</div>' +
      '<main>' + tabsHtml() + '<div class="guide-layout"><div class="guide-main">' + shown().map(partHtml).join('') + '</div>' + contentsHtml() + '</div></main>';
    watchContents();
  }

  // The parts a change touches.
  var changedIds = P.changedIds;

  function view(id){
    if (!viewing) tabBefore = tab;
    viewing = id; form = null; notice = '';
    render();
    body.scrollIntoView({ block: 'start' });
  }
  // The URL's #hash, without a new history entry or a jump.
  function setHash(h){ try { history.replaceState(history.state, '', location.pathname + location.search + h); } catch (e){} }
  function stopViewing(){
    viewing = null; viewedVersion = null; tab = tabBefore; render();
  }

  function closeForm(){ form = null; render(); }

  function bindForm(el){
    el.querySelector('.ev-cancel').addEventListener('click', closeForm);
    // Each button (Propose change or Commit, Save draft) runs the form's save; asDraft says which.
    var buttons = el.querySelectorAll('.ev-save'), asDraft = false;
    var save = { addEventListener: function(type, fn){
      Array.prototype.forEach.call(buttons, function(b){ b.addEventListener(type, function(e){ asDraft = !!b.getAttribute('data-draft'); fn(e); }); });
    } };
    function setBusy(on){ Array.prototype.forEach.call(el.querySelectorAll('.ev-save, .gd-remove'), function(b){ b.disabled = on; }); }
    var v = function(c){ var f = el.querySelector(c); return f ? f.value : ''; };
    function run(change){
      if (new Blob([JSON.stringify(doc().parts || []) + JSON.stringify(change)]).size > MAX_SIZE) { showError(el, 'That’s too much text for one guide.'); return; }
      setBusy(true);
      commit(change, { draft: asDraft }).then(closeForm).catch(function(err){
        if (err && err.cancelled) { setBusy(false); return; }
        console.error('[BOLD Guides] saving failed', err);
        showError(el, (err && err.message && /functions\/(failed-precondition|invalid-argument|permission-denied)/.test(err.code || '') ? err.message : 'Couldn’t save — try again.'));
        setBusy(false);
      });
    }
    function note(){ return v('.gd-note').trim(); }
    function needNote(){
      if (!note()) { showError(el, 'Say what you changed and why, for whoever reviews it.'); return true; }
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
      if (form.newTab) tab = after.section;
      run(p ? { kind: 'edit', partId: p.id, before: partSide(p), after: after, note: note() } :
        { kind: 'add', partId: G.partId(), before: null, after: after, note: note() });
    });
    var rm = el.querySelector('.gd-remove');
    if (rm) rm.addEventListener('click', function(){
      asDraft = false;
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
    if (t.classList.contains('gd-r-go')) { continueRebase(); return; }
    if (t.classList.contains('gd-r-stop')) { rebasing = null; render(); return; }
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
    if (t.classList.contains('gd-legacy-go')) { proposeLegacy(); return; }
    if (t.classList.contains('gd-legacy-drop')) { if (window.confirm('Discard ' + (legacy.length === 1 ? 'that change' : 'those ' + legacy.length + ' changes') + '?')) { dropLegacy(); render(); } return; }
    if (t.classList.contains('gd-tab-left') || t.classList.contains('gd-tab-right')) { if (!form) moveTab(t.classList.contains('gd-tab-left') ? -1 : 1); return; }
    if (t.classList.contains('gd-tab-add')) {
      notice = ''; form = { kind: 'add', newTab: true }; render();
      var nt = body.querySelector('.gd-new-tab'); if (nt) nt.focus();
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
      // Its proposals stay (a branch with it can't be accepted any more: its page has gone).
      ref.update(stamp('')).then(function(){ return ref.delete(); }).then(function(){ location.href = 'guides.html'; }).catch(function(err){
        console.error('[BOLD Guides] deleting the guide failed', err);
        window.alert('Couldn’t delete the guide — try again.');
      });
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
        return commit({ kind: 'restore', partId: '', before: null, note: 'Restore the version of ' + BoldHistory.when(v.at),
          after: { title: v.data.title || '', description: v.data.description || '', parts: v.data.parts || [], versionAt: v.at } }, { restore: true })
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
  function refresh(){
    if (form) return;
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
      // A comment on a proposed change (from before branches): on its branch's page.
      if (at && at.proposalId) { location.href = BOLD.branchPage(at.proposalId); return; }
      var el = body.querySelector('.cm-comment[data-cid="' + CSS.escape(cid) + '"]') || (p && document.getElementById(anchor(p)));
      if (el) el.scrollIntoView({ block: 'center' });
      return;
    }
    var id = decodeURIComponent(String(hash).replace(/^#/, ''));
    if (id === 'proposals') { BOLD.openBranches(); return; }
    // A link to a proposed change (#proposal-<id>, from before branches): its branch's page (they share the id).
    var pm = /^proposal-(.+)$/.exec(id);
    if (pm) { location.replace(BOLD.branchPage(pm[1])); return; }
    var fp = parts().filter(function(q){ return anchor(q) === id; })[0];
    if (fp && folded[fp.id]) { folded[fp.id] = false; saveFolded(); render(); }
    var target = document.getElementById(id);
    if (!target && tabFor(hash) !== null) target = document.getElementById('gdTabs');
    if (target) target.scrollIntoView({ block: 'start' });
  }
  // What you type while resolving a conflict, kept when the page is drawn again meanwhile.
  body.addEventListener('input', function(e){
    var v = rebasing && rebasing.resolve;
    if (!v || !e.target.classList) return;
    if (e.target.classList.contains('gd-r-title')) v.title = e.target.value;
    else if (e.target.classList.contains('gd-r-body')) v.text = e.target.value;
  });
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
    if (/^#proposal-/.test(location.hash)) { goTo(location.hash); return; }
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
    loadLegacy(); mine = null;
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
    watchBranch();
  });
  // This page's part of the branch you're on, followed: decided or withdrawn meanwhile, you're back on main.
  var branchUnsub = null;
  function watchBranch(){
    if (branchUnsub) { branchUnsub(); branchUnsub = null; }
    var id = BOLD.branchId();
    mine = null;
    if (!id || !me) return;
    branchUnsub = ref.collection('proposals').doc(id).onSnapshot(function(snap){
      var was = mine;
      mine = snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
      if (was && was.status === 'open' && mine && mine.status !== 'open') {
        notice = 'The proposed change you were on has been ' + mine.status + ': you’re back on main.';
        BOLD.setBranch(null, { quiet: true }); mine = null;
      }
      refresh();
    }, function(err){ console.error('[BOLD Guides] loading the proposed change you’re on failed', err); });
    unsubs.push(function(){ if (branchUnsub) { branchUnsub(); branchUnsub = null; } });
  }
})();
