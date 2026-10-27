// A project's work board (project page, Work tab): its code and content work in one
// place. Three kinds of items, each placed in To do, In progress, In review or Done:
// - the board's own cards, projectWorkspaces/{pid}/work/{id} (firestore.rules),
//   followed live;
// - its repositories' issues and pull requests, and, on a board showing the site's
//   content, the proposed changes to the BOLDiquette, guides, skills and tools, both
//   from projectWork (functions/index.js).
// A card linking a pull request, an issue or a proposal shows as one, in the furthest
// column of the card's and theirs; a pull request that closes an issue ("Closes #5")
// takes it in. project.js mounts it (ProjectWork.start, then attach on each render);
// its DOM is kept between renders, so an open editor survives the page redrawing.
var ProjectWork = (function(){
  var esc = BOLD.escapeHtml;
  var COLUMNS = [['todo', 'To do'], ['doing', 'In progress'], ['review', 'In review'], ['done', 'Done']];
  var ORDER = { todo: 0, doing: 1, review: 2, done: 3 };
  var DAYS = 14, SLOW = 3;   // Done shows the last 14 days; "waiting" after 3 in review
  var NO_EDIT = 'Only whoever made it, whom it’s assigned to, the project’s people, PIs and admins can change it';
  var NOT_EDITOR = 'Only the project’s submitter, authors, PIs and admins can do this';

  var ctx = null, pid = '', db = null;
  var root = document.createElement('div');
  root.className = 'wk';
  var cards = [], cardsLoaded = false, unsub = null;
  var remote = { items: [], errors: [], at: 0, loading: false, loaded: false };
  var who = '';            // the person filter: an email or a GitHub login ('' all)
  var editing = null;      // a card's id, or 'new:<column>'; 'settings'
  var draftLinks = [];     // links in the open editor
  var busy = false, msg = '';

  function el(sel){ return root.querySelector(sel); }
  function me(){ var m = ctx.me(); return m && m.email ? m.email.toLowerCase() : ''; }
  function canAdd(){ return BOLD.can('projects', 'edit'); }
  function canChange(c){
    if (!canAdd()) return false;
    var e = me();
    return ctx.fullWrite() || ctx.members().some(function(m){ return String(m).toLowerCase() === e; }) ||
      String(c.by && c.by.email || '').toLowerCase() === e || (c.assigneeEmails || []).indexOf(e) >= 0;
  }
  function canRemove(c){
    var e = me();
    return canAdd() && (ctx.fullWrite() || ctx.members().some(function(m){ return String(m).toLowerCase() === e; }) ||
      String(c.by && c.by.email || '').toLowerCase() === e);
  }
  function cardsRef(){ return db.collection('projectWorkspaces').doc(pid).collection('work'); }
  function call(){ return firebase.app().functions('europe-west2').httpsCallable('projectWork'); }

  // A GitHub address → its ref ("bold-lab-ai/bold-os#23") and kind, or null.
  function githubRef(url){
    var m = /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/(pull|issues)\/(\d+)/i.exec(String(url || '').trim());
    return m ? { type: m[3].toLowerCase() === 'pull' ? 'pr' : 'issue', ref: (m[1] + '/' + m[2] + '#' + m[4]).toLowerCase(), url: m[0] } : null;
  }

  var accessWatched = false;
  function start(c){
    ctx = c; db = c.db;
    // Adding and changing cards depend on the viewer's group (BOLD.can), known a little later.
    if (!accessWatched) { accessWatched = true; BOLD.onAccess(function(){ draw(); }); }
    if (pid === c.pid) return;
    pid = c.pid;
    if (unsub) unsub();
    cards = []; cardsLoaded = false; remote = { items: [], errors: [], at: 0, loading: false, loaded: false };
    unsub = cardsRef().onSnapshot(function(snap){
      cards = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      cardsLoaded = true;
      draw();
    }, function(err){
      console.error('[BOLD Lab] loading the work board failed', err);
      cardsLoaded = true; msg = 'The board’s cards couldn’t load — reload to try again.';
      draw();
    });
    fetchRemote(false);
  }
  function stop(){ if (unsub) unsub(); unsub = null; pid = ''; }
  function attach(mount){ if (mount) { mount.appendChild(root); draw(); } }

  function fetchRemote(fresh){
    if (remote.loading || !pid) return;
    remote.loading = true; draw();
    call()({ project: pid, fresh: !!fresh }).then(function(r){
      var d = r.data || {};
      remote = { items: d.items || [], errors: d.errors || [], at: d.at || Date.now(), repos: d.repos || [], loading: false, loaded: true };
      draw();
    }).catch(function(err){
      console.error('[BOLD Lab] projectWork failed', err);
      remote.loading = false; remote.loaded = true;
      remote.errors = [(err && err.message) || 'GitHub and the proposals couldn’t load — try again.'];
      draw();
    });
  }

  // Everything on the board, joined: [{ key, kind, source, title, url, column, people, since, … }].
  function items(){
    var byRef = {};
    remote.items.forEach(function(x){ byRef[x.ref] = x; });
    var taken = {};
    // A pull request takes in the issues it closes.
    remote.items.forEach(function(x){
      (x.closes || []).forEach(function(r){ if (byRef[r]) { taken[r] = true; x.closesItems = (x.closesItems || []).concat(byRef[r]); } });
    });
    var out = cards.map(function(c){
      var linked = (c.links || []).map(function(l){ return l.ref && byRef[l.ref]; }).filter(Boolean);
      linked.forEach(function(x){ taken[x.ref] = true; (x.closesItems || []).forEach(function(i){ taken[i.ref] = true; }); });
      var column = c.column, since = c.movedAt || c.at || 0;
      linked.forEach(function(x){ if (ORDER[x.column] > ORDER[column]) { column = x.column; since = x.since || since; } });
      var people = (c.assignees || []).map(function(a){ return { name: a.name, email: String(a.email || '').toLowerCase(), role: 'assignee' }; });
      linked.forEach(function(x){ people = people.concat((x.people || []).filter(function(p){ return p.role !== 'opener'; })); });
      return { key: 'card:' + c.id, card: c, source: 'card', title: c.title, notes: c.notes, column: column, since: since,
        people: dedupe(people), linked: linked, auto: column !== c.column };
    });
    remote.items.forEach(function(x){
      if (taken[x.ref]) return;
      out.push(Object.assign({ key: x.ref }, x, { people: dedupe(x.people || []), linked: x.closesItems || [] }));
    });
    return out.filter(function(x){ return x.column !== 'done' || !x.since || x.since >= Date.now() - DAYS * 86400000; });
  }
  function personKey(p){ return p.email || ('gh:' + String(p.login || p.name || '').toLowerCase()); }
  function dedupe(list){
    var seen = {};
    return list.filter(function(p){ var k = personKey(p); if (!p || seen[k]) return false; seen[k] = true; return true; });
  }

  function days(t){ return t ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : 0; }
  function age(x){
    var n = days(x.since);
    var when = n === 0 ? 'today' : n === 1 ? '1 day' : n + ' days';
    if (x.column === 'review' && n >= SLOW) return '<strong>Waiting for review, ' + when + '</strong>';
    return x.column === 'done' ? (n === 0 ? 'Done today' : 'Done ' + when + ' ago') : (n === 0 ? 'Since today' : when);
  }
  function sourceLabel(x){
    if (x.source === 'card') return 'Card';
    if (x.kind === 'proposal') return 'Proposed change' + (x.state && x.state !== 'open' ? ' · ' + x.state : '');
    var repo = (remote.repos || []).length > 1 ? ' · ' + x.repo : '';
    if (x.kind === 'pr') return 'Pull request #' + x.number + (x.state === 'draft' ? ' · draft' : x.state === 'closed' ? ' · closed' : '') + repo;
    return 'Issue #' + x.number + repo;
  }
  function chips(people){
    return people.length ? '<div class="wk-people">' + people.map(function(p){
      var role = p.role === 'reviewer' ? ' (review)' : p.role === 'decider' ? ' (decided)' : p.role === 'opener' ? ' (opened it)' : '';
      return '<span class="wk-chip' + (personKey(p) === me() ? ' is-me' : '') + '">' + esc(p.name || p.login || p.email) + role + '</span>';
    }).join('') + '</div>' : '';
  }
  function linkedHtml(x){
    // What it links, and the issues those pull requests close.
    var list = [];
    (x.linked || []).forEach(function(i){ if (i && list.indexOf(i) < 0) list.push(i); (i && i.closesItems || []).forEach(function(c){ if (list.indexOf(c) < 0) list.push(c); }); });
    var extra = x.card ? (x.card.links || []).filter(function(l){ return l.type === 'url' || !(l.ref && list.some(function(i){ return i.ref === l.ref; })); }) : [];
    if (!list.length && !extra.length) return '';
    return '<ul class="wk-links">' + list.map(function(i){
      return '<li><a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(sourceLabel(i)) + '</a> ' + esc(i.title) + '</li>';
    }).concat(extra.map(function(l){
      return '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label || l.url) + '</a></li>';
    })).join('') + '</ul>';
  }
  function itemHtml(x){
    var title = x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title);
    var html = '<li class="wk-item wk-' + x.source + '" data-key="' + esc(x.key) + '">' +
      '<div class="wk-src">' + esc(sourceLabel(x)) + (x.auto ? ' · moved with its link' : '') + '</div>' +
      '<div class="wk-title">' + title + '</div>' +
      (x.notes ? '<div class="wk-notes">' + esc(x.notes) + '</div>' : '') +
      (x.note ? '<div class="wk-notes">' + esc(x.note) + '</div>' : '') +
      linkedHtml(x) + chips(x.people) +
      '<div class="wk-meta">' + age(x) + '</div>';
    if (x.card) {
      var ok = canChange(x.card), why = ok ? '' : ' disabled title="' + esc(canAdd() ? NO_EDIT : BOLD.cannotReason('projects', 'edit')) + '"';
      html += '<div class="wk-actions">' +
        '<select class="wk-move" aria-label="Move to"' + why + '>' + COLUMNS.map(function(c){
          return '<option value="' + c[0] + '"' + (c[0] === x.card.column ? ' selected' : '') + '>' + (c[0] === x.card.column ? c[1] : 'Move to ' + c[1]) + '</option>';
        }).join('') + '</select>' +
        '<button class="btn-text wk-edit" type="button"' + why + '>Edit</button></div>';
    }
    return html + '</li>';
  }

  function editorHtml(c, column){
    var people = ctx.members().slice();
    if (me() && people.indexOf(me()) < 0) people.push(me());
    (c && c.assigneeEmails || []).forEach(function(e){ if (people.indexOf(e) < 0) people.push(e); });
    var cur = c && c.assigneeEmails && c.assigneeEmails[0] || '';
    var options = remote.items.filter(function(x){ return x.column !== 'done' || x.kind === 'pr'; });
    return '<form class="wk-editor" novalidate>' +
      '<label>Title<input type="text" class="wk-f-title" maxlength="200" value="' + esc(c ? c.title : '') + '" required></label>' +
      '<label>Notes<textarea class="wk-f-notes" maxlength="4000" rows="3">' + esc(c ? c.notes || '' : '') + '</textarea></label>' +
      '<label>Who’s on it<select class="wk-f-who"><option value="">Nobody yet</option>' + people.map(function(e){
        var p = personByEmail(e);
        return '<option value="' + esc(e) + '"' + (e === cur ? ' selected' : '') + '>' + esc(p && p.name || e) + (e === me() ? ' (you)' : '') + '</option>';
      }).join('') + '</select></label>' +
      '<div class="wk-f-links"><span>Linked</span><ul class="wk-f-linklist"></ul>' +
        '<select class="wk-f-pick" aria-label="Link a pull request, issue or proposal"><option value="">Link a pull request, issue or proposed change…</option>' +
          options.map(function(x){ return '<option value="' + esc(x.ref) + '">' + esc(sourceLabel(x) + ': ' + x.title).slice(0, 140) + '</option>'; }).join('') +
        '</select>' +
        '<div class="wk-f-urlrow"><input type="url" class="wk-f-url" placeholder="Or paste a link" aria-label="A link"><button class="btn-text wk-f-add" type="button">Add</button></div>' +
      '</div>' +
      '<div class="field-error wk-f-error" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="submit">' + (c ? 'Save' : 'Add') + '</button>' +
        '<button class="btn" type="button" data-wk="cancel">Cancel</button>' +
        (c ? '<button class="btn-text danger wk-f-remove" type="button"' + (canRemove(c) ? '' : ' disabled title="Only whoever made it, the project’s people, PIs and admins can remove it"') + '>Remove</button>' : '') +
      '</div><input type="hidden" class="wk-f-column" value="' + esc(column || (c && c.column) || 'todo') + '"></form>';
  }
  function drawLinks(){
    var ul = el('.wk-f-linklist');
    if (!ul) return;
    ul.innerHTML = draftLinks.map(function(l, i){
      return '<li>' + esc(l.label || l.url) + ' <button class="btn-text wk-f-unlink" type="button" data-i="' + i + '" aria-label="Unlink">×</button></li>';
    }).join('') || '<li class="detail-muted">Nothing yet</li>';
  }

  function settingsHtml(){
    var w = (ctx.ws() && ctx.ws().work) || {};
    var edit = ctx.canEdit();
    return '<form class="wk-editor wk-settings" novalidate>' +
      '<label>Repositories<input type="text" class="wk-s-repos" value="' + esc((w.repos || []).join(', ')) + '" placeholder="' +
        esc(ctx.ws() && ctx.ws().repoName ? ctx.ws().repoName + ' (the project’s)' : 'bold-lab-ai/…') + '"' + (edit ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>' +
        '<span class="field-hint">In bold-lab-ai, separated by commas. Empty: the project’s own.</span></label>' +
      '<label class="wk-check"><input type="checkbox" class="wk-s-content"' + (w.content ? ' checked' : '') +
        (ctx.fullWrite() ? '' : ' disabled title="Only PIs and admins can change this"') + '> Show the proposed changes to the BOLDiquette, guides, skills and tools</label>' +
      '<div class="field-error wk-f-error" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="submit"' + (edit || ctx.fullWrite() ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Save</button>' +
        '<button class="btn" type="button" data-wk="cancel">Cancel</button>' +
        '<button class="btn-text danger wk-s-off" type="button"' + (edit ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Remove the board</button></div>' +
      '</form>';
  }

  function draw(){
    if (!ctx) return;
    // An open editor stays as it is; the rest redraws around it.
    var keep = editing && root.querySelector('.wk-editor');
    if (keep) { drawBoard(keep); return; }
    drawBoard(null);
  }
  function drawBoard(keepEditor){
    var all = items();
    // Who's doing what: everyone with something in progress or in review.
    var load = {};
    all.forEach(function(x){
      if (x.column !== 'doing' && x.column !== 'review') return;
      x.people.forEach(function(p){
        if (p.role === 'decider' || p.role === 'opener') return;
        var k = personKey(p);
        load[k] = load[k] || { p: p, doing: 0, review: 0 };
        load[k][x.column]++;
      });
    });
    var shown = who ? all.filter(function(x){ return x.people.some(function(p){ return personKey(p) === who; }); }) : all;
    var strip = Object.keys(load).sort(function(a, b){ return (load[b].doing + load[b].review) - (load[a].doing + load[a].review); }).map(function(k){
      var l = load[k], parts = [];
      if (l.doing) parts.push(l.doing + ' in progress');
      if (l.review) parts.push(l.review + ' in review');
      return '<button class="wk-who' + (who === k ? ' active' : '') + '" type="button" data-who="' + esc(k) + '">' + esc(l.p.name || l.p.login || l.p.email) +
        ' <span class="detail-muted">' + parts.join(', ') + '</span></button>';
    }).join('');
    var head = '<div class="wk-head">' +
      '<div class="wk-filters"><button class="wk-who' + (!who ? ' active' : '') + '" type="button" data-who="">Everyone</button>' +
        (me() ? '<button class="wk-who' + (who === me() ? ' active' : '') + '" type="button" data-who="' + esc(me()) + '">Mine</button>' : '') + strip + '</div>' +
      '<div class="wk-tools"><span class="detail-muted">' + (remote.loading ? 'Updating…' : remote.at ? 'Updated ' + new Date(remote.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '') + '</span>' +
        '<button class="btn-text" type="button" data-wk="refresh"' + (remote.loading ? ' disabled' : '') + '>Refresh</button>' +
        '<button class="btn-text" type="button" data-wk="settings">Board settings</button></div></div>';
    var notes = (remote.errors || []).map(function(e){ return '<p class="wk-error">' + esc(e) + '</p>'; }).join('') + (msg ? '<p class="wk-error">' + esc(msg) + '</p>' : '');
    var settings = editing === 'settings' ? '<div class="wk-settings-slot"></div>' : '';
    var cols = '<div class="wk-cols">' + COLUMNS.map(function(c){
      var list = shown.filter(function(x){ return x.column === c[0]; }).sort(function(a, b){ return (b.since || 0) - (a.since || 0); });
      var add = c[0] !== 'done' ? '<button class="btn-text wk-add" type="button" data-col="' + c[0] + '"' +
        (canAdd() ? '' : ' disabled title="' + esc(BOLD.cannotReason('projects', 'edit')) + '"') + '>+ Add a card</button>' : '';
      var newSlot = editing === 'new:' + c[0] ? '<div class="wk-new-slot"></div>' : '';
      return '<section class="wk-col" aria-label="' + c[1] + '"><h3>' + c[1] + ' <span class="detail-muted">' + list.length + '</span></h3>' + add + newSlot +
        '<ul class="wk-list">' + list.map(itemHtml).join('') + '</ul>' +
        (!list.length ? '<p class="detail-muted wk-empty">' + (!cardsLoaded || (remote.loading && !remote.loaded) ? 'Loading…' : 'Nothing') + '</p>' : '') +
        (c[0] === 'done' ? '<p class="detail-muted wk-empty">The last ' + DAYS + ' days. Before: <a href="changelog.html">Changelog</a>.</p>' : '') +
        '</section>';
    }).join('') + '</div>';
    if (keepEditor) keepEditor.remove();
    root.innerHTML = head + notes + settings + cols;
    // The open editor goes back where it was: settings, a new card, or in place of its card.
    if (editing) {
      var slot = editing === 'settings' ? el('.wk-settings-slot') : editing.indexOf('new:') === 0 ? el('.wk-new-slot')
        : root.querySelector('.wk-item[data-key="card:' + CSS.escape(editing) + '"]');
      var c = cards.filter(function(x){ return x.id === editing; })[0];
      if (!slot || (editing.indexOf('new:') !== 0 && editing !== 'settings' && !c)) { editing = null; }
      else {
        var form = keepEditor;
        if (!form) {
          var tmp = document.createElement('div');
          tmp.innerHTML = editing === 'settings' ? settingsHtml() : editorHtml(c, editing.indexOf('new:') === 0 ? editing.slice(4) : null);
          form = tmp.firstChild;
        }
        slot.replaceWith(form);
        if (!keepEditor) wireEditor(form, c);
      }
    }
    wire();
  }

  function wire(){
    Array.prototype.forEach.call(root.querySelectorAll('[data-who]'), function(b){
      b.addEventListener('click', function(){ who = b.getAttribute('data-who'); draw(); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('.wk-add'), function(b){
      b.addEventListener('click', function(){ if (editing) return; editing = 'new:' + b.getAttribute('data-col'); draftLinks = []; draw(); focusTitle(); });
    });
    var r = el('[data-wk="refresh"]');
    if (r) r.addEventListener('click', function(){ fetchRemote(true); });
    var s = el('[data-wk="settings"]');
    if (s) s.addEventListener('click', function(){ if (editing) return; editing = 'settings'; draw(); });
    Array.prototype.forEach.call(root.querySelectorAll('.wk-item'), function(li){
      var key = li.getAttribute('data-key');
      if (key.indexOf('card:') !== 0) return;
      var c = cards.filter(function(x){ return 'card:' + x.id === key; })[0];
      if (!c) return;
      var move = li.querySelector('.wk-move'), edit = li.querySelector('.wk-edit');
      if (move) move.addEventListener('change', function(){ moveCard(c, move.value); });
      if (edit) edit.addEventListener('click', function(){ if (editing) return; editing = c.id; draftLinks = (c.links || []).slice(); draw(); focusTitle(); });
    });
  }
  function focusTitle(){ var t = el('.wk-f-title'); if (t) t.focus(); }

  function wireEditor(form, c){
    var error = form.querySelector('.wk-f-error');
    function fail(m){ error.textContent = m; error.hidden = false; busy = false; }
    form.querySelector('[data-wk="cancel"]').addEventListener('click', function(){ editing = null; msg = ''; draw(); });
    if (form.classList.contains('wk-settings')) {
      form.addEventListener('submit', function(e){
        e.preventDefault();
        if (busy) return;
        busy = true;
        var repos = form.querySelector('.wk-s-repos').value.split(/[\s,]+/).filter(Boolean);
        var change = { repos: repos };
        var content = form.querySelector('.wk-s-content');
        if (!content.disabled) change.content = content.checked;
        ctx.callWorkspace({ action: 'work', work: change }).then(function(){
          busy = false; editing = null; fetchRemote(true); draw();
        }).catch(function(err){ fail((err && err.message) || 'Couldn’t save — try again.'); });
      });
      form.querySelector('.wk-s-off').addEventListener('click', function(){
        BOLD.confirmAction({ title: 'Remove the work board?', go: 'Remove it', effects: ['Hide the Work tab (its cards are kept, and come back if it’s added again)'] }).then(function(ok){
          if (!ok) return;
          ctx.callWorkspace({ action: 'work', work: { on: false } }).then(function(){ editing = null; })
            .catch(function(err){ fail((err && err.message) || 'Couldn’t remove it — try again.'); });
        });
      });
      return;
    }
    drawLinks();
    form.querySelector('.wk-f-linklist').addEventListener('click', function(e){
      var b = e.target.closest('.wk-f-unlink');
      if (b) { draftLinks.splice(Number(b.getAttribute('data-i')), 1); drawLinks(); }
    });
    var pick = form.querySelector('.wk-f-pick');
    pick.addEventListener('change', function(){
      var x = remote.items.filter(function(i){ return i.ref === pick.value; })[0];
      pick.value = '';
      if (!x || draftLinks.some(function(l){ return l.ref === x.ref; })) return;
      draftLinks.push({ type: x.kind, ref: x.ref, url: x.url, label: (sourceLabel(x) + ': ' + x.title).slice(0, 200) });
      drawLinks();
    });
    form.querySelector('.wk-f-add').addEventListener('click', function(){
      var input = form.querySelector('.wk-f-url'), v = input.value.trim();
      if (!/^https?:\/\/\S+$/i.test(v)) return fail('Paste a whole link, starting https://');
      error.hidden = true;
      var g = githubRef(v);
      var x = g && remote.items.filter(function(i){ return i.ref === g.ref; })[0];
      draftLinks.push(g ? { type: g.type, ref: g.ref, url: g.url, label: x ? (sourceLabel(x) + ': ' + x.title).slice(0, 200) : g.ref }
        : { type: 'url', url: v.slice(0, 2000), label: v.slice(0, 200) });
      input.value = '';
      drawLinks();
    });
    var remove = form.querySelector('.wk-f-remove');
    if (remove) remove.addEventListener('click', function(){
      if (!window.confirm('Remove this card?')) return;
      cardsRef().doc(c.id).delete().then(function(){ editing = null; draw(); })
        .catch(function(err){ console.error('[BOLD Lab] removing a card failed', err); fail('Couldn’t remove it — try again.'); });
    });
    form.addEventListener('submit', function(e){
      e.preventDefault();
      if (busy) return;
      var title = form.querySelector('.wk-f-title').value.trim();
      if (!title) return fail('Give it a title.');
      var a = form.querySelector('.wk-f-who').value, p = a && personByEmail(a);
      var m = ctx.me(), now = Date.now();
      var data = {
        title: title.slice(0, 200), notes: form.querySelector('.wk-f-notes').value.trim().slice(0, 4000),
        assignees: a ? [{ email: a, name: (p && p.name) || (a === me() && m.displayName) || a }] : [], assigneeEmails: a ? [a] : [],
        links: draftLinks.slice(0, 10).map(function(l){ var o = { type: l.type, url: l.url, label: l.label || '' }; if (l.ref) o.ref = l.ref; return o; }),
        updatedAt: now, updatedBy: m.email
      };
      busy = true;
      var job;
      if (c) job = cardsRef().doc(c.id).set(Object.assign({}, data, { column: c.column, by: c.by, at: c.at, movedAt: c.movedAt || c.at }));
      else {
        var column = form.querySelector('.wk-f-column').value;
        job = cardsRef().add(Object.assign(data, { column: column, by: { email: m.email, name: m.displayName || m.email }, at: now, movedAt: now }));
      }
      job.then(function(){ busy = false; editing = null; draftLinks = []; draw(); })
        .catch(function(err){ console.error('[BOLD Lab] saving a card failed', err); fail('Couldn’t save — try again.'); });
    });
  }

  function moveCard(c, column){
    if (column === c.column) return;
    var m = ctx.me(), now = Date.now();
    var data = {};
    ['title', 'notes', 'assignees', 'assigneeEmails', 'links', 'by', 'at'].forEach(function(k){ data[k] = c[k]; });
    cardsRef().doc(c.id).set(Object.assign(data, { notes: c.notes || '', column: column, movedAt: now, updatedAt: now, updatedBy: m.email }))
      .catch(function(err){ console.error('[BOLD Lab] moving a card failed', err); msg = 'Couldn’t move it — try again.'; draw(); });
  }

  return { start: start, stop: stop, attach: attach, refresh: function(){ fetchRemote(true); }, _items: items, _githubRef: githubRef };
})();
