// A project's board (project page, Board tab; #…&tab=work): everything in the works, and on BOLD
// OS's board everything on BOLD.OS waiting on someone, in To do, In progress, Waiting for review
// or Done. Each item shows only what's needed to scan it: its type (code, content or a
// request), what it's about, who it's from, and who's on it (or what it waits for).
// - the board's own cards, projectWorkspaces/{pid}/work/{id} (firestore.rules), live;
// - from projectWork (functions/index.js): its repositories' issues and pull requests,
//   and, on a board with `content`, the proposed changes and requests the viewer sees.
// A card linking a pull request, an issue or a proposal shows as one, in the furthest
// column of the card's and theirs; a pull request that closes an issue ("Closes #5")
// takes it in. project.js mounts it (ProjectWork.start, then attach on each render);
// its DOM is kept between renders, so an open editor survives the page redrawing.
// Each card, and each GitHub issue or pull request, has its own page in the tab
// (#…&tab=work&card=<id>, &item=<owner/repo#n>): a description (Markdown) and images
// (Storage, work/<pid>/<card>/…; storage.rules), then its conversation (card-talk.js; a
// card's only, not a GitHub item's: those talk on GitHub). Describing a GitHub item makes it a card
// linking it. Proposals and requests open their own pages elsewhere on BOLD.OS.
// Milestones: the board's (work.milestones on the workspace, [{ id, name, start, end }]); a card
// is in one by its `milestone`. Their own view (#…&tab=work&milestones, the board's Milestones
// button) plans them (its editors and the project's people) and adds cards to each, many at
// once; the Milestone filter shows one's progress above the columns.
var ProjectWork = (function(){
  var esc = BOLD.escapeHtml;
  var COLUMNS = [['todo', 'To do'], ['doing', 'In progress'], ['review', 'Waiting for review'], ['done', 'Done']];
  var ORDER = { todo: 0, doing: 1, review: 2, done: 3 };
  var DAYS = 30, SLOW = 3;   // Done shows the last 30 days, then they're archived; "waiting" after 3 days
  var archive = false;       // Done showing the archive (cards done more than 30 days ago) instead
  var NO_EDIT = 'Only whoever made it, whom it’s assigned to, the project’s people, PIs and admins can change it';
  var NOT_EDITOR = 'Only the project’s submitter, authors, PIs and admins can do this';
  var PLAN_ONLY = 'Only the project’s people, PIs and admins can plan its milestones';

  var ctx = null, pid = '', db = null;
  var root = document.createElement('div');
  root.className = 'wk';
  var cards = [], cardsLoaded = false, unsub = null;
  var remote = { items: [], errors: [], at: 0, loading: false, loaded: false };
  var who = '';            // the person filter: an email or a GitHub login ('' all)
  var type = '';           // the type filter: code, content, request ('' all)
  var query = '';          // the search box's text
  var milestone = '';         // the milestone filter: a milestone's id, '-' for none ('' all)
  var plan = { editing: null, form: null, adding: null, picked: {}, find: '', msg: '' }; // the Milestones view: a milestone being edited ('new' a new one), or having cards added
  var TYPES = [['code', 'Code'], ['content', 'Content'], ['request', 'Request'], ['other', 'Other']];
  var editing = null;      // a card's id, or 'new:<column>'; 'settings'
  var draftLinks = [];     // links in the open editor
  var busy = false, msg = '';
  var slackIds = {};       // email → Slack id, for links to people's pages (the people roster)
  var view = null;         // a page: { card: id } or { item: ref }; null, the board
  var describing = false;  // the page's description being edited
  var talk = null;         // the open card's conversation (BoldCardTalk), with its card's id
  var IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  var MAX_IMAGES = 20, MAX_IMAGE_MB = 10, MAX_NOTES = 20000;
  var upload = { busy: false, msg: '' };

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
  // A link to a page of BOLD.OS (the server's are whole addresses on the live site) stays on
  // the site the board is on: the live one, a preview or localhost.
  function href(u){ return String(u || '').replace(/^https:\/\/bold-lab-ai\.github\.io\/bold-os\//, ''); }
  // A card moved to Done tells whoever raised it on Slack (onWorkCardDone), unless it's you:
  // asked first, with the message a box to untick (then doneQuiet: true on the card).
  // → Promise of the fields to save with the move ({} or { doneQuiet }), or null to stay put.
  function confirmDone(c, column){
    var by = c.by || {}, mine = String(by.email || '').toLowerCase() === me();
    if (column !== 'done' || c.column === 'done' || !by.email || mine) return Promise.resolve(column === 'done' && c.column !== 'done' ? { doneQuiet: true } : {});
    return BOLD.confirmAction({ title: 'Move “' + c.title + '” to Done?', go: 'Move it',
      effects: [{ key: 'tell', text: 'Send ' + (by.name || by.email) + ', who raised it, a Slack message that it’s done' }] })
      .then(function(go){ return go ? { doneQuiet: !!(go.skip && go.skip.tell) } : null; });
  }
  // A new card is posted in the project's Slack channel (functions/index.js onWorkCardAdded):
  // asked every time, with the post a box to untick (then announce: false on the card).
  // → Promise of { announce } to go ahead, or null.
  function confirmNewCard(title){
    var w = (ctx.ws && ctx.ws()) || {}, ch = String(w.slackChannel || '').replace(/^#/, '');
    if (!ch || (w.skipped || []).indexOf('channel') >= 0) return Promise.resolve({ announce: true });
    return BOLD.confirmAlways({ title: 'Add “' + title + '”?', go: 'Add it',
      effects: [{ key: 'announce', text: 'Post it in #' + ch + ' on Slack, for everyone in the channel' }] })
      .then(function(ok){ return ok ? { announce: !(ok.skip && ok.skip.announce) } : null; });
  }
  // The board's milestones, and how they read: "1 Nov – 14 Nov".
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function milestones(){ return ((ctx.ws() && ctx.ws().work) || {}).milestones || []; }
  function milestoneOf(id){ return id ? milestones().filter(function(s){ return s.id === id; })[0] || null : null; }
  function today(){ var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dayLabel(v){ var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] : ''; }
  function milestoneDates(s){ return s.start && s.end ? dayLabel(s.start) + ' – ' + dayLabel(s.end) : s.start ? 'from ' + dayLabel(s.start) : s.end ? 'until ' + dayLabel(s.end) : ''; }
  function milestoneNow(s){ var t = today(); return !!(s.start || s.end) && (!s.start || s.start <= t) && (!s.end || t <= s.end); }
  // Who plans the milestones: the board's editors, the project's people, PIs and admins.
  function canPlan(){ var e = me(); return ctx.canEdit() || ctx.fullWrite() || ctx.members().some(function(m){ return String(m).toLowerCase() === e; }); }
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
    if (!accessWatched) {
      accessWatched = true; BOLD.onAccess(function(){ draw(); });
      window.addEventListener('popstate', function(){ readView(); draw(); });
    }
    readView();
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
    db.collection('people').get().then(function(snap){
      snap.docs.forEach(function(d){ var e = String(d.data().email || '').toLowerCase(); if (e) slackIds[e] = d.id; });
      draw();
    }).catch(function(err){ console.error('[BOLD Lab] loading the roster failed', err); });
  }
  function stop(){ if (unsub) unsub(); unsub = null; pid = ''; view = null; endTalk(); }
  function endTalk(){ if (talk) talk.stop(); talk = null; }

  // The page open, from the address; go(v) opens another (null: the board).
  function readView(){
    var c = /[#&]card=([^&]+)/.exec(location.hash), i = /[#&]item=([^&]+)/.exec(location.hash), ms = /[#&]milestones(&|$)/.test(location.hash);
    var v = c ? { card: decodeURIComponent(c[1]) } : i ? { item: decodeURIComponent(i[1]) } : ms ? { milestones: true } : null;
    if (JSON.stringify(v) !== JSON.stringify(view)) describing = false;
    view = v;
  }
  function hrefOf(v){
    var h = location.hash.replace(/&(card|item)=[^&]*/g, '').replace(/&milestones(?=&|$)/g, '');
    if (!/[#&]tab=/.test(h)) h += '&tab=work';
    return h + (!v ? '' : v.card ? '&card=' + encodeURIComponent(v.card) : v.milestones ? '&milestones' : '&item=' + encodeURIComponent(v.item));
  }
  function go(v, replace){
    try { history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + hrefOf(v)); } catch (e){}
    view = v; describing = false; editing = null; upload = { busy: false, msg: '' }; plan = { editing: null, form: null, adding: null, picked: {}, find: '', msg: '' };
    draw();
    if (!replace) window.scrollTo(0, 0);
  }
  function attach(mount){ if (mount) { mount.appendChild(root); draw(); } }

  function fetchRemote(fresh){
    if (remote.loading || !pid) return;
    remote.loading = true; draw();
    call()({ project: pid, fresh: !!fresh }).then(function(r){
      var d = r.data || {};
      remote = { items: d.items || [], errors: d.errors || [], at: d.at || Date.now(), repos: d.repos || [], cardNumbers: d.cardNumbers || {}, loading: false, loaded: true };
      draw();
    }).catch(function(err){
      console.error('[BOLD Lab] projectWork failed', err);
      remote.loading = false; remote.loaded = true;
      remote.errors = [(err && err.message) || 'GitHub and the proposals couldn’t load — try again.'];
      draw();
    });
  }

  // Everything on the board, joined: [{ key, type, kind, source, title, url, column, by, on, waiting, since, … }].
  function items(){
    // Done more than 30 days ago: archived, shown only when Done shows the archive.
    return allItems().filter(function(x){ var old = x.column === 'done' && x.since && x.since < Date.now() - DAYS * 86400000; return archive ? x.column !== 'done' || old : !old; });
  }
  function allItems(){
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
      var on = (c.assignees || []).map(function(a){ return { name: a.name, email: String(a.email || '').toLowerCase(), role: 'Working on it' }; });
      linked.forEach(function(x){ on = on.concat(x.on || []); });
      // Its type: chosen, or from what it links (a pull request or issue: code; a proposal: content).
      var t = c.kind || (linked.some(function(x){ return x.type === 'code'; }) || (c.links || []).some(function(l){ return l.type === 'pr' || l.type === 'issue'; }) ? 'code'
        : (c.links || []).some(function(l){ return l.type === 'proposal'; }) || linked.some(function(x){ return x.type === 'content'; }) ? 'content' : 'other');
      var waiting = on.length ? '' : linked.map(function(x){ return x.waiting; }).filter(Boolean)[0] || '';
      return { key: 'card:' + c.id, card: c, source: 'card', num: (remote.cardNumbers || {})[c.id], type: t, title: c.title, notes: c.notes, column: column, since: since, milestone: milestoneOf(c.milestone) ? c.milestone : '',
        by: c.by ? { name: c.by.name, email: String(c.by.email || '').toLowerCase() } : null, on: dedupe(on), waiting: waiting, linked: linked, auto: column !== c.column };
    });
    remote.items.forEach(function(x){
      if (taken[x.ref]) return;
      out.push(Object.assign({ key: x.ref }, x, { on: dedupe(x.on || []), linked: x.closesItems || [] }));
    });
    return out;
  }
  function personKey(p){ return p.email || ('gh:' + String(p.login || p.name || '').toLowerCase()); }
  function dedupe(list){
    var seen = {};
    return list.filter(function(p){ if (!p) return false; var k = personKey(p); if (seen[k]) return false; seen[k] = true; return true; });
  }

  function days(t){ return t ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : 0; }
  // Its reference, small: PR #23, Issue #5, the request's kind; nothing for a card.
  var REQUEST_KINDS = { join: 'Joining', invite: 'Invitation', group: 'Group', letter: 'Letter', introduction: 'Introduction', supervision: 'Supervision', agent: 'Agent', venue: 'Venue', review: 'Internal Review', event: 'Event', hackathon: 'Hackathon' };
  // Its reference, small: BOLD.OS's own number (#123, one sequence for all of BOLD.OS,
  // projectWork) and what it is; a GitHub item by its repository and GitHub's number (bold-os#23).
  function refLabel(x){
    var num = x.num ? '#' + x.num : '';
    if (x.kind === 'pr') return 'PR ' + x.repo + '#' + x.number + (x.state === 'draft' ? ' draft' : '');
    if (x.kind === 'issue') return 'Issue ' + x.repo + '#' + x.number;
    if (x.kind === 'proposal') return [num, 'Proposal' + (x.state && x.state !== 'open' ? ', ' + x.state : '')].filter(Boolean).join(' ');
    if (x.source === 'request') return [num, REQUEST_KINDS[x.kind] || 'Request'].filter(Boolean).join(' ');
    return num;
  }

  // A person's name, linked to their page on BOLD.OS (person.html?id=<Slack id>), or to
  // GitHub for someone who hasn't linked it; you in bold.
  function name(p){
    if (!p) return '';
    var n = esc(p.name || p.login || p.email || 'someone'), id = p.id || slackIds[p.email || ''];
    var cls = personKey(p) === me() ? ' class="is-me"' : '';
    if (id) return '<a' + cls + ' href="person.html?id=' + encodeURIComponent(id) + '">' + n + '</a>';
    if (p.login && !p.email) return '<a' + cls + ' href="https://github.com/' + encodeURIComponent(p.login) + '" target="_blank" rel="noopener">' + n + '</a>';
    return cls ? '<b' + cls + '>' + n + '</b>' : n;
  }
  function tag(t){ return '<span class="wk-tag">' + esc(t) + '</span>'; }
  // Who it's from, then who's responsible, each after a tag saying what they do:
  // From, Reviewer, Decides, Writes it, Working on it…; or what it waits for.
  function whoHtml(x){
    var lines = [];
    if (x.by && (x.by.name || x.by.login || x.by.email)) lines.push(tag('From') + name(x.by));
    var roles = [], by = {};
    (x.on || []).forEach(function(p){
      var r = p.role || x.role || 'On it';
      if (!by[r]) { by[r] = []; roles.push(r); }
      by[r].push(p);
    });
    roles.forEach(function(r){ lines.push(tag(r) + by[r].map(name).join(', ')); });
    if (!roles.length && x.waiting && x.column !== 'done') {
      lines.push(tag(x.role || 'Waiting for') + (x.waiting === 'a reviewer' ? 'Nobody yet' : esc(x.waiting.charAt(0).toUpperCase() + x.waiting.slice(1))));
    }
    return lines.map(function(l){ return '<div class="wk-who-line">' + l + '</div>'; }).join('');
  }
  function itemHtml(x){
    var n = days(x.since), late = x.column === 'review' && n >= SLOW;
    var t = TYPES.filter(function(y){ return y[0] === x.type; })[0] || TYPES[3];
    // A card or a GitHub item opens its page here; a proposal or a request, its own page.
    var page = x.card ? { card: x.card.id } : x.source === 'github' ? { item: x.ref } : null;
    var title = page ? '<a class="wk-open board-drag-through" href="' + esc(hrefOf(page)) + '">' + esc(x.title) + '</a>'
      : x.url ? '<a href="' + esc(href(x.url)) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title);
    var ref = refLabel(x) && x.source === 'github' && x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(refLabel(x)) + '</a>' : esc(refLabel(x));
    var linked = (x.linked || []).map(function(i){ return '<a href="' + esc(href(i.url)) + '" target="_blank" rel="noopener">' + esc(refLabel(i)) + '</a>'; }).join(' ');
    // A card that can be changed is dragged to another column (BoldBoard.drag, in wire()).
    var drag = x.card && canChange(x.card);
    var html = '<div class="board-card wk-item' + (drag ? ' board-draggable' : '') + '" data-key="' + esc(x.key) + '"' + (x.notes ? ' title="' + esc(x.notes.slice(0, 300)) + '"' : '') + '>' +
      '<div class="wk-top"><span class="wk-type wk-type-' + t[0] + '">' + t[1] + '</span>' +
        (ref ? '<span class="wk-ref">' + ref + '</span>' : '') + (linked ? '<span class="wk-ref">' + linked + '</span>' : '') +
        (late ? '<span class="wk-late">' + n + ' days</span>' : '') +
        (x.milestone && milestone !== x.milestone ? '<span class="wk-milestone">' + esc(milestoneOf(x.milestone).name) + '</span>' : '') + '</div>' +
      '<div class="wk-title">' + title + '</div>' +
      whoHtml(x);
    if (x.card) {
      var ok = canChange(x.card);
      html += '<div class="wk-actions"><button class="btn-text wk-edit" type="button"' +
        (ok ? '' : ' disabled title="' + esc(canAdd() ? NO_EDIT : BOLD.cannotReason('projects', 'edit')) + '"') + '>Edit</button></div>';
    }
    return html + '</div>';
  }

  function editorHtml(c, column){
    var people = ctx.members().slice();
    if (me() && people.indexOf(me()) < 0) people.push(me());
    (c && c.assigneeEmails || []).forEach(function(e){ if (people.indexOf(e) < 0) people.push(e); });
    var cur = c && c.assigneeEmails && c.assigneeEmails[0] || '';
    var options = remote.items.filter(function(x){ return x.column !== 'done' || x.kind === 'pr'; });
    return '<form class="wk-editor" novalidate>' +
      '<label>Title<input type="text" class="wk-f-title" maxlength="200" value="' + esc(c ? c.title : '') + '" required></label>' +
      '<label>Description<textarea class="wk-f-notes" maxlength="' + MAX_NOTES + '" rows="3">' + esc(c ? c.notes || '' : '') + '</textarea></label>' +
      (c ? '<label>Column<select class="wk-f-col">' + COLUMNS.map(function(k){
        return '<option value="' + k[0] + '"' + (k[0] === c.column ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select></label>' : '') +
      '<label>Type<select class="wk-f-kind"><option value="">From its links</option>' + TYPES.map(function(y){
        return '<option value="' + y[0] + '"' + (c && c.kind === y[0] ? ' selected' : '') + '>' + y[1] + '</option>'; }).join('') + '</select></label>' +
      (milestones().length ? '<label>Milestone<select class="wk-f-milestone"><option value="">None</option>' + milestones().map(function(s){
        var cur = c ? c.milestone : milestoneOf(milestone) ? milestone : '';
        return '<option value="' + esc(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>' + esc(s.name + (milestoneDates(s) ? ' (' + milestoneDates(s) + ')' : '')) + '</option>';
      }).join('') + '</select></label>' : '') +
      '<label>Who’s on it<select class="wk-f-who"><option value="">Nobody yet</option>' + people.map(function(e){
        var p = personByEmail(e);
        return '<option value="' + esc(e) + '"' + (e === cur ? ' selected' : '') + '>' + esc(p && p.name || e) + (e === me() ? ' (you)' : '') + '</option>';
      }).join('') + '</select></label>' +
      '<div class="wk-f-links"><span>Linked</span><ul class="wk-f-linklist"></ul>' +
        '<select class="wk-f-pick" aria-label="Link a pull request, issue or proposal"><option value="">Link a pull request, issue or proposed change…</option>' +
          options.filter(function(x){ return x.source !== 'request'; }).map(function(x){ return '<option value="' + esc(x.ref) + '">' + esc((refLabel(x) + ': ' + x.title).slice(0, 140)) + '</option>'; }).join('') +
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
      // Slack's /bug and /feature-request in the project's own channel come here; these too.
      '<label>Slack channels for /bug and /feature-request<input type="text" class="wk-s-channels" value="' + esc((w.channels || []).map(function(n){ return '#' + n; }).join(', ')) + '" placeholder="#channel"' +
        (edit ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>' +
        '<span class="field-hint">Besides ' + esc((ctx.ws() && ctx.ws().slackChannel) || 'the project’s own channel') + ', separated by commas.</span></label>' +
      '<label class="wk-check"><input type="checkbox" class="wk-s-content"' + (w.content ? ' checked' : '') +
        (ctx.fullWrite() ? '' : ' disabled title="Only PIs and admins can change this"') + '> Show everything on BOLD.OS waiting on someone: proposed changes and requests (each only to whoever can see it)</label>' +
      '<div class="field-error wk-f-error" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="submit"' + (edit || ctx.fullWrite() ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Save</button>' +
        '<button class="btn" type="button" data-wk="cancel">Cancel</button>' +
        '<button class="btn-text danger wk-s-off" type="button"' + (edit ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Remove the board</button></div>' +
      '</form>';
  }

  function draw(){
    if (!ctx) return;
    // A card's page sits in the tab as the Overview does; only the board itself is wide.
    root.classList.toggle('wk-paged', !!view);
    if (!view || !view.card) endTalk();
    if (view && view.milestones) { drawMilestones(); return; }
    if (view) { drawPage(); return; }
    // An open editor stays as it is; the rest redraws around it.
    var keep = editing && root.querySelector('.wk-editor');
    if (keep) { drawBoard(keep); return; }
    drawBoard(null);
  }
  // A milestone's progress: its dates and days left (when), and done of all its cards, archived
  // ones too, with how many are in each other column (bar, summary).
  function progressOf(s){
    var cs = allItems().filter(function(x){ return x.milestone === s.id; });
    var n = function(col){ return cs.filter(function(x){ return x.column === col; }).length; };
    var done = n('done'), pct = cs.length ? Math.round(100 * done / cs.length) : 0;
    var parts = [[n('doing'), 'in progress'], [n('review'), 'waiting for review'], [n('todo'), 'to do']].filter(function(p){ return p[0]; }).map(function(p){ return p[0] + ' ' + p[1]; });
    var left = s.end && milestoneNow(s) ? Math.round((Date.parse(s.end) - Date.parse(today())) / 86400000) : null;
    return { cards: cs,
      when: [milestoneDates(s), left === null ? (s.end && s.end < today() ? 'ended' : '') : left === 0 ? 'ends today' : left === 1 ? '1 day left' : left + ' days left'].filter(Boolean).join(' · '),
      bar: '<div class="wk-milestonebar-track" role="progressbar" aria-label="' + esc(s.name) + ' done" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>',
      summary: cs.length ? done + ' of ' + cs.length + ' done (' + pct + '%)' + (parts.length ? ' · ' + parts.join(', ') : '') : 'No cards in it yet.' };
  }
  // Above the columns: the milestone filtered on, or else the one on now (with a button to filter on it).
  function milestoneHtml(){
    var s = milestoneOf(milestone), focus = !!s;
    if (!s) s = !milestone ? milestones().filter(milestoneNow)[0] : null;
    if (!s) return '';
    var g = progressOf(s);
    return '<div class="wk-milestonebar">' +
      '<div class="wk-milestonebar-head"><strong>' + esc(s.name) + '</strong>' + (g.when ? ' <span class="detail-muted">' + esc(g.when) + '</span>' : '') +
        (focus ? '' : ' <button class="btn-text" type="button" data-wk="milestone-now" data-id="' + esc(s.id) + '">Show only its cards</button>') + '</div>' +
      g.bar + '<div class="detail-muted">' + esc(g.summary) + '</div></div>';
  }

  // The Milestones view (#…&tab=work&milestones), in place of the board: each milestone, in
  // date order, with its progress and cards; planning them, and adding cards many at once.
  function ordered(){
    var key = function(s){ return s.start || s.end || '9999'; };
    return milestones().map(function(s, i){ return [s, i]; }).sort(function(a, b){ return key(a[0]) < key(b[0]) ? -1 : key(a[0]) > key(b[0]) ? 1 : a[1] - b[1]; }).map(function(x){ return x[0]; });
  }
  function colName(c){ var k = COLUMNS.filter(function(x){ return x[0] === c; })[0]; return k ? k[1] : ''; }
  function msFormHtml(s){
    return '<form class="wk-editor wk-ms-form" novalidate>' +
      '<label>Name<input type="text" class="wk-m-name" maxlength="60" value="' + esc(s.name) + '" required></label>' +
      '<div class="wk-ms-dates"><label>Starts<input type="date" class="wk-m-start" value="' + esc(s.start || '') + '"></label>' +
        '<label>Ends<input type="date" class="wk-m-end" value="' + esc(s.end || '') + '"></label></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="submit">Save</button><button class="btn" type="button" data-ms="cancel">Cancel</button></div></form>';
  }
  function cardRef(x){ return (x.num ? '#' + x.num + ' ' : '') + x.title; }
  function drawMilestones(){
    var focused = document.activeElement && root.contains(document.activeElement) && document.activeElement.classList.contains('wk-m-find');
    // What's typed in a milestone's form survives the view redrawing (a card changing, live).
    var open = el('.wk-ms-form');
    if (open && plan.form) { plan.form.name = open.querySelector('.wk-m-name').value; plan.form.start = open.querySelector('.wk-m-start').value; plan.form.end = open.querySelector('.wk-m-end').value; }
    var plans = canPlan(), off = plans ? '' : ' disabled title="' + PLAN_ONLY + '"';
    var all = allItems().filter(function(x){ return x.card; });
    var html = '<div class="wk-page wk-ms">' +
      '<a class="detail-back wk-back" href="' + esc(hrefOf(null)) + '">&larr; Back to the board</a>' +
      '<div class="detail-head"><h2 class="wk-page-title">Milestones</h2></div>' +
      (plan.editing === 'new' ? msFormHtml(plan.form) : '<button class="btn-text wk-ms-new" type="button"' + off + '>+ Add a milestone</button>') +
      (plan.msg ? '<p class="wk-error">' + esc(plan.msg) + '</p>' : '');
    var list = ordered();
    if (!list.length && plan.editing !== 'new') html += '<p class="detail-muted wk-none">No milestones yet.</p>';
    list.forEach(function(s){
      var g = progressOf(s);
      html += '<section class="wk-ms-item" data-id="' + esc(s.id) + '">';
      if (plan.editing === s.id) html += msFormHtml(plan.form);
      else html += '<div class="wk-ms-head"><h3>' + esc(s.name) + '</h3>' + (g.when ? '<span class="detail-muted">' + esc(g.when) + '</span>' : '') +
        '<span class="wk-ms-acts"><button class="btn-text" type="button" data-ms="edit"' + off + '>Edit</button><button class="btn-text danger" type="button" data-ms="remove"' + off + '>Remove</button></span></div>';
      html += g.bar + '<div class="detail-muted wk-ms-sum">' + esc(g.summary) + '</div>';
      var cs = g.cards.slice().sort(function(a, b){ return ORDER[a.column] - ORDER[b.column] || (b.since || 0) - (a.since || 0); });
      if (cs.length) html += '<ul class="wk-ms-cards">' + cs.map(function(x){
        var ok = canChange(x.card);
        return '<li><span class="wk-ms-col wk-ms-col-' + x.column + '">' + esc(colName(x.column)) + '</span>' +
          '<a class="wk-open" href="' + esc(hrefOf({ card: x.card.id })) + '">' + esc(cardRef(x)) + '</a>' +
          '<button class="btn-text wk-ms-out" type="button" data-card="' + esc(x.card.id) + '" aria-label="Take ' + esc(x.title) + ' out of ' + esc(s.name) + '"' + (ok ? '' : ' disabled title="' + esc(canAdd() ? NO_EDIT : BOLD.cannotReason('projects', 'edit')) + '"') + '>×</button></li>';
      }).join('') + '</ul>';
      if (plan.adding === s.id) {
        // Cards in no milestone yet: not done first; the search narrows them.
        var words = plan.find.trim().toLowerCase().split(/\s+/).filter(Boolean);
        var free = all.filter(function(x){ return !x.milestone && words.every(function(w){ return cardRef(x).toLowerCase().indexOf(w) >= 0; }); })
          .sort(function(a, b){ return ORDER[a.column] - ORDER[b.column] || (b.since || 0) - (a.since || 0); });
        var n = Object.keys(plan.picked).length;
        html += '<div class="wk-editor wk-ms-pick"><input type="search" class="wk-m-find" placeholder="Search cards in no milestone…" aria-label="Search cards" value="' + esc(plan.find) + '">' +
          '<ul class="wk-ms-free">' + (free.map(function(x){
            var ok = canChange(x.card);
            return '<li><label' + (ok ? '' : ' title="' + esc(canAdd() ? NO_EDIT : BOLD.cannotReason('projects', 'edit')) + '"') + '><input type="checkbox" data-card="' + esc(x.card.id) + '"' + (plan.picked[x.card.id] ? ' checked' : '') + (ok ? '' : ' disabled') + '>' +
              '<span class="wk-ms-col wk-ms-col-' + x.column + '">' + esc(colName(x.column)) + '</span>' + esc(cardRef(x)) + '</label></li>';
          }).join('') || '<li class="detail-muted">' + (words.length ? 'No card matches.' : 'Every card is in a milestone.') + '</li>') + '</ul>' +
          '<div class="stage-fields-actions"><button class="btn" type="button" data-ms="add"' + (n && !busy ? '' : ' disabled') + '>' + (n ? 'Add ' + n + (n === 1 ? ' card' : ' cards') : 'Add cards') + '</button>' +
            '<button class="btn" type="button" data-ms="close">Cancel</button></div></div>';
      } else html += '<button class="btn-text wk-ms-addcards" type="button"' + (canAdd() ? '' : ' disabled title="' + esc(BOLD.cannotReason('projects', 'edit')) + '"') + '>+ Add cards</button>';
      html += '</section>';
    });
    root.innerHTML = html + '</div>';
    wireOpen();
    wireMilestones();
    var f = el('.wk-m-find');
    if (f && focused) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }
  // A new one, by default: numbered on, starting the day after the last ends, as long as it.
  function nextMilestone(){
    var list = ordered(), last = list[list.length - 1];
    var s = { id: Math.random().toString(36).slice(2, 10), name: 'Milestone ' + (list.length + 1), start: today(), end: '' };
    if (last && last.end) {
      var d = function(v, n){ return new Date(Date.parse(v) + n * 86400000).toISOString().slice(0, 10); };
      s.start = d(last.end, 1);
      s.end = last.start ? d(s.start, Math.round((Date.parse(last.end) - Date.parse(last.start)) / 86400000)) : '';
    }
    return s;
  }
  function openForm(id, s){
    plan.editing = id; plan.form = Object.assign({}, s); plan.msg = ''; draw();
    var n = el('.wk-ms-form .wk-m-name'); if (n) n.select();
  }
  function savePlan(list){
    busy = true; plan.msg = ''; draw();
    return ctx.callWorkspace({ action: 'work', work: { milestones: list.map(function(x){ return { id: x.id, name: x.name, start: x.start || '', end: x.end || '' }; }) } })
      .then(function(){ busy = false; plan.editing = null; plan.form = null; draw(); })
      .catch(function(err){ busy = false; plan.msg = (err && err.message) || 'Couldn’t save — try again.'; draw(); throw err; });
  }
  function wireMilestones(){
    var nb = el('.wk-ms-new');
    if (nb) nb.addEventListener('click', function(){ openForm('new', nextMilestone()); });
    var form = el('.wk-ms-form');
    if (form) {
      form.querySelector('[data-ms="cancel"]').addEventListener('click', function(){ plan.editing = null; plan.form = null; plan.msg = ''; draw(); });
      form.addEventListener('submit', function(e){
        e.preventDefault();
        if (busy) return;
        var x = { name: form.querySelector('.wk-m-name').value.trim(), start: form.querySelector('.wk-m-start').value, end: form.querySelector('.wk-m-end').value };
        if (!x.name) { plan.msg = 'Give it a name.'; draw(); return; }
        if (x.start && x.end && x.end < x.start) { plan.msg = x.name + ' ends before it starts.'; draw(); return; }
        var list = milestones().map(function(s){ return Object.assign({}, s); });
        if (plan.editing === 'new') list.push(Object.assign({ id: plan.form.id }, x));
        else list = list.map(function(s){ return s.id === plan.editing ? Object.assign(s, x) : s; });
        savePlan(list).catch(function(){});
      });
    }
    Array.prototype.forEach.call(root.querySelectorAll('.wk-ms-item'), function(sec){
      var id = sec.getAttribute('data-id'), s = milestoneOf(id);
      sec.addEventListener('click', function(e){
        var b = e.target.closest('button');
        if (!b || b.disabled) return;
        var act = b.getAttribute('data-ms');
        if (act === 'edit') openForm(id, s);
        else if (act === 'remove') {
          if (!window.confirm('Remove “' + s.name + '”? Its cards stay on the board, in no milestone.')) return;
          savePlan(milestones().filter(function(x){ return x.id !== id; })).catch(function(){});
        }
        else if (b.classList.contains('wk-ms-addcards')) { plan.adding = id; plan.picked = {}; plan.find = ''; draw(); var f = el('.wk-m-find'); if (f) f.focus(); }
        else if (act === 'close') { plan.adding = null; plan.picked = {}; draw(); }
        else if (act === 'add') {
          var ids = Object.keys(plan.picked);
          busy = true; draw();
          Promise.all(ids.map(function(cid){ var c = cards.filter(function(k){ return k.id === cid; })[0]; return c ? cardChange(c, { milestone: id }) : null; }))
            .then(function(){ busy = false; plan.adding = null; plan.picked = {}; draw(); })
            .catch(function(err){ console.error('[BOLD Lab] adding cards to a milestone failed', err); busy = false; plan.msg = 'Couldn’t add them all — try again.'; draw(); });
        }
        else if (b.classList.contains('wk-ms-out')) {
          var c = cards.filter(function(k){ return k.id === b.getAttribute('data-card'); })[0];
          if (c) cardChange(c, { milestone: '' }).catch(function(err){ console.error('[BOLD Lab] taking a card out of a milestone failed', err); plan.msg = 'Couldn’t take it out — try again.'; draw(); });
        }
      });
      sec.addEventListener('change', function(e){
        var cb = e.target.closest('input[type=checkbox][data-card]');
        if (!cb) return;
        if (cb.checked) plan.picked[cb.getAttribute('data-card')] = true; else delete plan.picked[cb.getAttribute('data-card')];
        var add = sec.querySelector('[data-ms="add"]'), n = Object.keys(plan.picked).length;
        add.disabled = !n || busy; add.textContent = n ? 'Add ' + n + (n === 1 ? ' card' : ' cards') : 'Add cards';
      });
      sec.addEventListener('input', function(e){ if (e.target.classList.contains('wk-m-find')) { plan.find = e.target.value; draw(); } });
    });
  }
  function drawBoard(keepEditor){
    var all = items();
    // Who's doing what, for the Person filter: everyone on the board, busiest first.
    var people = {};
    all.forEach(function(x){
      [x.by].concat(x.on || []).forEach(function(p, i){
        if (!p || !(p.name || p.login || p.email)) return;
        var k = personKey(p);
        people[k] = people[k] || { p: p, doing: 0, review: 0 };
        if (i > 0 && (x.column === 'doing' || x.column === 'review')) people[k][x.column]++;
      });
    });
    var involves = function(x, k){ return personKey(x.by || {}) === k || (x.on || []).some(function(p){ return personKey(p) === k; }); };
    // The search: title, its reference, and the people on it.
    var words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var matches = function(x){
      if (!words.length) return true;
      var hay = [x.title, refLabel(x), x.num ? String(x.num) : '', x.by && (x.by.name || x.by.login)].concat((x.on || []).map(function(p){ return p.name || p.login; })).join(' ').toLowerCase();
      return words.every(function(w){ return hay.indexOf(w) >= 0; });
    };
    if (milestone && milestone !== '-' && !milestoneOf(milestone)) milestone = '';
    var inMilestone = function(x){ return !milestone || (milestone === '-' ? !x.milestone : x.milestone === milestone); };
    var shown = all.filter(function(x){ return (!who || involves(x, who)) && (!type || x.type === type) && inMilestone(x) && matches(x); });
    var personOptions = [['', 'Everyone']].concat(me() ? [[me(), 'Mine']] : []).concat(Object.keys(people).filter(function(k){ return k !== me(); })
      .sort(function(a, b){ return (people[b].doing + people[b].review) - (people[a].doing + people[a].review) || String(people[a].p.name).localeCompare(String(people[b].p.name)); })
      .map(function(k){
        var l = people[k], parts = [];
        if (l.doing) parts.push(l.doing + ' in progress');
        if (l.review) parts.push(l.review + ' waiting for review');
        return [k, (l.p.name || l.p.login || l.p.email) + (parts.length ? ' (' + parts.join(', ') + ')' : '')];
      }));
    var typeOptions = [['', 'All types']].concat(TYPES.filter(function(y){ return y[0] !== 'other' || all.some(function(x){ return x.type === 'other'; }); })
      .map(function(y){ return [y[0], y[1] + ' (' + all.filter(function(x){ return x.type === y[0]; }).length + ')']; }));
    var milestoneOptions = [['', 'All milestones']].concat(milestones().map(function(s){
      return [s.id, s.name + (milestoneNow(s) ? ' (now)' : '')]; })).concat([['-', 'No milestone']]);
    var filtering = words.length || who || type || milestone;
    // The shared board's search bar (BoldBoard.searchHtml), as on the Internal Review Board.
    var head = BoldBoard.searchHtml({ query: query, placeholder: 'Search by title, #number or person\u2026', label: 'Search the board',
      count: filtering ? shown.length + ' of ' + all.length : all.length + ' item' + (all.length === 1 ? '' : 's'),
      filters: [{ key: 'type', label: 'Type', value: type, options: typeOptions }, { key: 'who', label: 'Person', value: who, options: personOptions }]
        .concat(milestones().length ? [{ key: 'milestone', label: 'Milestone', value: milestone, options: milestoneOptions }] : []),
      extra: '<span class="wk-tools"><span class="detail-muted">' + (remote.loading ? 'Updating\u2026' : remote.at ? 'Updated ' + new Date(remote.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '') + '</span>' +
        '<button class="btn-text" type="button" data-wk="refresh"' + (remote.loading ? ' disabled' : '') + '>Refresh</button>' +
        '<a class="btn-text wk-open" href="' + esc(hrefOf({ milestones: true })) + '">Milestones</a>' +
        '<button class="btn-text" type="button" data-wk="settings">Board settings</button></span>' });
    var notes = (remote.errors || []).map(function(e){ return '<p class="wk-error">' + esc(e) + '</p>'; }).join('') + (msg ? '<p class="wk-error">' + esc(msg) + '</p>' : '');
    var settings = editing === 'settings' ? '<div class="wk-settings-slot"></div>' : '';
    // The shared board (assets/js/board.js): the Internal Review Board's columns.
    var cols = '<div class="board-scroll">' + BoldBoard.columnsHtml(COLUMNS.map(function(c){
      var all = shown.filter(function(x){ return x.column === c[0]; }).sort(function(a, b){ return (b.since || 0) - (a.since || 0); });
      // 20 at a time (BoldBoard.paged); Load more shows the next 20.
      var page = BoldBoard.paged(scopeOf(c[0]), c[0], all), list = page.items;
      var add = c[0] !== 'done' ? '<button class="btn-text wk-add" type="button" data-col="' + c[0] + '"' +
        (canAdd() ? '' : ' disabled title="' + esc(BOLD.cannotReason('projects', 'edit')) + '"') + '>+ Add a card</button>' : '';
      var newSlot = editing === 'new:' + c[0] ? '<div class="wk-new-slot"></div>' : '';
      return { id: c[0], label: c[0] === 'done' && archive ? 'Done, archived' : c[1], count: all.length, more: page.more,
        hint: c[0] === 'done' ? (archive ? 'Cards done more than ' + DAYS + ' days ago (the rest are on GitHub and the <a href="changelog.html">Changelog</a>). <button class="btn-text wk-archive" type="button">Back to the last ' + DAYS + ' days</button>'
          : 'The last ' + DAYS + ' days. <button class="btn-text wk-archive" type="button">Show archived</button>') : '',
        headExtra: add,
        body: newSlot + list.map(itemHtml).join(''),
        empty: !cardsLoaded || (remote.loading && !remote.loaded) ? 'Loading\u2026' : 'Nothing here' };
    })) + '</div>';
    if (keepEditor) keepEditor.remove();
    root.innerHTML = head + notes + settings + milestoneHtml() + cols;
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

  // Load more's count per column: Done's archive counts apart from its last 30 days.
  function scopeOf(column){ return pid + (archive && column === 'done' ? ':archive' : ''); }
  function wire(){
    BoldBoard.onMore(root, scopeOf, draw);
    var arch = el('.wk-archive');
    if (arch) arch.addEventListener('click', function(){ archive = !archive; draw(); });
    // Heads the same height across the board, as on the Internal Review Board.
    BoldBoard.equalizeHeads(root);
    BoldBoard.drag(root, {
      item: '.wk-item.board-draggable',
      drop: function(li, column){
        var c = cards.filter(function(x){ return 'card:' + x.id === li.getAttribute('data-key'); })[0];
        if (c && canChange(c)) moveCard(c, column);
      }
    });
    BoldBoard.wireSearch(root, {
      query: function(v){ query = v; draw(); },
      filter: function(key, v){ if (key === 'type') type = v; else if (key === 'who') who = v; else if (key === 'milestone') milestone = v; draw(); }
    });
    Array.prototype.forEach.call(root.querySelectorAll('.wk-add'), function(b){
      b.addEventListener('click', function(){ if (editing) return; editing = 'new:' + b.getAttribute('data-col'); draftLinks = []; draw(); focusTitle(); });
    });
    var now = el('[data-wk="milestone-now"]');
    if (now) now.addEventListener('click', function(){ milestone = now.getAttribute('data-id'); draw(); });
    var r = el('[data-wk="refresh"]');
    if (r) r.addEventListener('click', function(){ fetchRemote(true); });
    var s = el('[data-wk="settings"]');
    if (s) s.addEventListener('click', function(){ if (editing) return; editing = 'settings'; draw(); });
    wireOpen();
    Array.prototype.forEach.call(root.querySelectorAll('.wk-item'), function(li){
      var key = li.getAttribute('data-key');
      if (key.indexOf('card:') !== 0) return;
      var c = cards.filter(function(x){ return 'card:' + x.id === key; })[0];
      if (!c) return;
      var edit = li.querySelector('.wk-edit');
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
        var channels = form.querySelector('.wk-s-channels').value.split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); }).filter(Boolean);
        var change = { repos: repos, channels: channels };
        var content = form.querySelector('.wk-s-content');
        if (!content.disabled) change.content = content.checked;
        ctx.callWorkspace({ action: 'work', work: change }).then(function(){
          busy = false; editing = null; fetchRemote(true); draw();
        }).catch(function(err){ fail((err && err.message) || 'Couldn’t save — try again.'); });
      });
      form.querySelector('.wk-s-off').addEventListener('click', function(){
        BOLD.confirmAction({ title: 'Remove the board?', go: 'Remove it', effects: ['Hide the Board tab (its cards are kept, and come back if it’s added again)'] }).then(function(ok){
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
      draftLinks.push({ type: x.kind, ref: x.ref, url: x.url, label: (refLabel(x) + ': ' + x.title).slice(0, 200) });
      drawLinks();
    });
    form.querySelector('.wk-f-add').addEventListener('click', function(){
      var input = form.querySelector('.wk-f-url'), v = input.value.trim();
      if (!/^https?:\/\/\S+$/i.test(v)) return fail('Paste a whole link, starting https://');
      error.hidden = true;
      var g = githubRef(v);
      var x = g && remote.items.filter(function(i){ return i.ref === g.ref; })[0];
      draftLinks.push(g ? { type: g.type, ref: g.ref, url: g.url, label: x ? (refLabel(x) + ': ' + x.title).slice(0, 200) : g.ref }
        : { type: 'url', url: v.slice(0, 2000), label: v.slice(0, 200) });
      input.value = '';
      drawLinks();
    });
    var remove = form.querySelector('.wk-f-remove');
    if (remove) remove.addEventListener('click', function(){
      if (!window.confirm('Remove this card?')) return;
      // Its images first: Storage's rules check the card they belong to.
      Promise.all((c.images || []).map(function(i){ return firebase.storage().ref(i.path).delete().catch(function(){}); }))
        .then(function(){ return cardsRef().doc(c.id).delete(); })
        .then(function(){ editing = null; if (view) go(null, true); else draw(); })
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
        title: title.slice(0, 200), notes: form.querySelector('.wk-f-notes').value.trim().slice(0, MAX_NOTES), kind: form.querySelector('.wk-f-kind').value,
        assignees: a ? [{ email: a, name: (p && p.name) || (a === me() && m.displayName) || a }] : [], assigneeEmails: a ? [a] : [],
        links: draftLinks.slice(0, 10).map(function(l){ var o = { type: l.type, url: l.url, label: l.label || '' }; if (l.ref) o.ref = l.ref; return o; }),
        updatedAt: now, updatedBy: m.email
      };
      var sp = form.querySelector('.wk-f-milestone');
      if (sp ? sp.value : c && c.milestone) data.milestone = sp ? sp.value : c.milestone;
      busy = true;
      var job;
      var col = form.querySelector('.wk-f-col') ? form.querySelector('.wk-f-col').value : c && c.column;
      // Images added since the editor opened are kept.
      var now2 = c && (cards.filter(function(k){ return k.id === c.id; })[0] || c);
      if (now2 && now2.images) data.images = now2.images;
      if (c) job = confirmDone(c, col).then(function(done){
        if (!done) throw { cancelled: true };
        return cardsRef().doc(c.id).set(Object.assign({}, data, done, { column: col, by: c.by, at: c.at, movedAt: col !== c.column ? now : c.movedAt || c.at }));
      });
      else {
        var column = form.querySelector('.wk-f-column').value;
        job = confirmNewCard(data.title).then(function(go){
          if (!go) throw { cancelled: true };
          return cardsRef().add(Object.assign(data, { column: column, announce: go.announce, by: { email: m.email, name: m.displayName || m.email }, at: now, movedAt: now }));
        });
      }
      // A new card is numbered by the server a moment after it's saved: fetched again to show it.
      job.then(function(){ busy = false; editing = null; draftLinks = []; draw(); if (!c) setTimeout(function(){ fetchRemote(false); }, 2500); })
        .catch(function(err){ if (err && err.cancelled) { busy = false; return; } console.error('[BOLD Lab] saving a card failed', err); fail('Couldn’t save — try again.'); });
    });
  }

  // A card's or a GitHub item's own page, in place of the board.
  function wireOpen(){
    Array.prototype.forEach.call(root.querySelectorAll('a.wk-open, a.wk-back'), function(a){
      a.addEventListener('click', function(e){
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        var h = a.getAttribute('href'), c = /[#&]card=([^&]+)/.exec(h), i = /[#&]item=([^&]+)/.exec(h);
        go(c ? { card: decodeURIComponent(c[1]) } : i ? { item: decodeURIComponent(i[1]) } : /[#&]milestones(&|$)/.test(h) ? { milestones: true } : null);
      });
    });
  }
  // Only images Storage holds for this board are shown (an address in the card can't load anything else).
  function imageOk(i){ return i && /^https:\/\/firebasestorage\.googleapis\.com\//.test(String(i.url || '')) && String(i.path || '').indexOf('work/' + pid + '/') === 0; }
  function drawPage(){
    var all = allItems(), x = null, c = null;
    if (view.item) {
      // A GitHub item a card links is shown as that card.
      var holder = cards.filter(function(k){ return (k.links || []).some(function(l){ return l.ref === view.item; }); })[0];
      if (holder) { go({ card: holder.id }, true); return; }
      x = remote.items.filter(function(i){ return i.ref === view.item; })[0] || null;
    } else {
      x = all.filter(function(i){ return i.key === 'card:' + view.card; })[0] || null;
      c = x && x.card;
    }
    // A description or an editor being written survives the page redrawing.
    var keepDesc = root.querySelector('.wk-desc-form'), keepEditor = root.querySelector('.wk-editor');
    if (keepDesc) keepDesc.remove();
    if (keepEditor) keepEditor.remove();
    var back = '<a class="detail-back wk-back" href="' + esc(hrefOf(null)) + '">&larr; Back to the board</a>';
    var loading = view.card ? !cardsLoaded || (remote.loading && !remote.loaded) : !remote.loaded;
    if (!x) {
      root.innerHTML = '<div class="wk-page">' + back + '<p class="detail-muted">' + (loading ? 'Loading…'
        : view.card ? 'This card isn’t on the board any more.' : 'This isn’t on the board (closed, or not in its repositories).' +
          (/^[^\/\s]+\/[^\/\s#]+#\d+$/.test(view.item) ? ' <a href="https://github.com/' + esc(view.item.replace('#', '/issues/')) + '" target="_blank" rel="noopener">See it on GitHub</a>.' : '')) + '</p></div>';
      wireOpen();
      return;
    }
    var t = TYPES.filter(function(y){ return y[0] === x.type; })[0] || TYPES[3];
    var col = COLUMNS.filter(function(k){ return k[0] === x.column; })[0];
    var n = days(x.since);
    // Laid out as the project page's own: badges, the title with Edit beside it, the
    // Overview's rows (project.css .detail-grid), then the description and images as its abstract.
    var ext = function(u, text){ return '<a href="' + esc(href(u)) + '" target="_blank" rel="noopener">' + text + '</a>'; };
    var links = (c ? (c.links || []) : []).map(function(l){
      var i = l.ref && remote.items.filter(function(r){ return r.ref === l.ref; })[0];
      return '<li>' + ext(l.url, esc(i ? refLabel(i) + ': ' + i.title : l.label || l.url)) + (i && i.state ? ' <span class="detail-muted">· ' + esc(i.state) + '</span>' : '') + '</li>';
    }).concat((x.linked || []).filter(function(){ return !c; }).map(function(i){ return '<li>' + ext(i.url, esc(refLabel(i) + ': ' + i.title)) + '</li>'; }));
    var ok = c ? canChange(c) : canAdd();
    var why = !canAdd() ? BOLD.cannotReason('projects', 'edit') : NO_EDIT;
    var off = ok ? '' : ' disabled title="' + esc(why) + '"';
    var row = function(label, value){ return '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>'; };
    var rows = row('Column', esc(col ? col[1] : '') + (x.since && x.column !== 'done' ? ' <span class="detail-muted">· for ' + (n === 1 ? '1 day' : n + ' days') + '</span>' : ''));
    if (x.milestone) rows += row('Milestone', esc(milestoneOf(x.milestone).name) + (milestoneDates(milestoneOf(x.milestone)) ? ' <span class="detail-muted">· ' + esc(milestoneDates(milestoneOf(x.milestone))) + '</span>' : ''));
    if (x.by && (x.by.name || x.by.login || x.by.email)) rows += row('From', name(x.by));
    var roles = [], byRole = {};
    (x.on || []).forEach(function(p){ var r = p.role || x.role || 'On it'; if (!byRole[r]) { byRole[r] = []; roles.push(r); } byRole[r].push(p); });
    roles.forEach(function(r){ rows += row(r, byRole[r].map(name).join(', ')); });
    if (!roles.length && x.waiting && x.column !== 'done') rows += row('Waiting for', x.waiting === 'a reviewer' ? 'Nobody yet' : esc(x.waiting.charAt(0).toUpperCase() + x.waiting.slice(1)));
    if (x.source === 'github' && x.url) rows += row('On GitHub', ext(x.url, esc(refLabel(x))));
    if (links.length) rows += row('Linked', '<ul class="wk-linked">' + links.join('') + '</ul>');
    var badges = '<span class="badge wk-badge-' + t[0] + '">' + t[1] + '</span>' + (x.num ? '<span class="badge">#' + x.num + '</span>' : '');
    var html = '<div class="wk-page">' + back +
      '<div class="detail-head"><h2 class="wk-page-title">' + esc(x.title) +
        (c ? '<button class="btn-text detail-inline-edit wk-edit" type="button"' + off + '>Edit</button>' : '') + '</h2>' +
        '<div class="detail-badges">' + badges + '</div></div>' +
      (c ? '<div class="wk-page-edit"></div>' : '') +
      '<dl class="detail-grid">' + rows + '</dl>';
    // The description: the card's (Markdown); a GitHub item has none until it's described.
    html += '<div class="detail-abstract"><div class="detail-abstract-label">Description' +
      (c && !describing ? '<button class="btn-text detail-inline-edit wk-describe" type="button"' + off + '>' + (c.notes ? 'Edit' : 'Add') + '</button>' : '') + '</div>';
    if (c) html += describing ? '<div class="wk-desc-slot"></div>' : c.notes ? '<div class="wk-desc">' + BoldMarkdown.render(c.notes) + '</div>' : '<p class="detail-muted wk-none">No description yet.</p>';
    else html += '<p class="detail-muted wk-none">No description yet. Describing it makes it a card on the board, linked to it.</p>' +
      '<button class="btn-text wk-adopt" type="button"' + off + '>Add a description</button>';
    html += '</div>';
    if (c) {
      var imgs = (c.images || []).filter(imageOk), full = imgs.length >= MAX_IMAGES;
      html += '<div class="detail-abstract"><div class="detail-abstract-label">Images' +
          '<button class="btn-text detail-inline-edit wk-addimg" type="button"' + (!ok ? off : full || upload.busy ? ' disabled' + (full ? ' title="' + MAX_IMAGES + ' images at most"' : '') : '') + '>Add</button></div>' +
        (imgs.length ? '<div class="wk-images">' + imgs.map(function(i){
          return '<figure class="wk-image"><a href="' + esc(i.url) + '" target="_blank" rel="noopener"><img src="' + esc(i.url) + '" alt="' + esc(i.name || 'An image') + '" loading="lazy"></a>' +
            '<figcaption><span>' + esc(i.name || '') + '</span>' + (ok ? '<button class="btn-text wk-unimage" type="button" data-path="' + esc(i.path) + '" aria-label="Remove this image">Remove</button>' : '') + '</figcaption></figure>';
        }).join('') + '</div>' : '<p class="detail-muted wk-none">No images yet.</p>') +
        '<div class="detail-hint">PNG, JPEG, GIF or WebP, up to ' + MAX_IMAGE_MB + ' MB each' + (upload.msg ? ' · <span class="wk-upmsg">' + esc(upload.msg) + '</span>' : '') + '</div>' +
        '<input type="file" class="wk-imgfile" accept="' + Object.keys(IMAGE_TYPES).join(',') + '" multiple hidden></div>' +
        '<div class="wk-talk-slot"></div>';
    }
    root.innerHTML = html + (msg ? '<p class="wk-error">' + esc(msg) + '</p>' : '') + '</div>';

    var descSlot = el('.wk-desc-slot');
    if (descSlot) {
      var f = keepDesc;
      if (!f) {
        var tmp = document.createElement('div');
        tmp.innerHTML = '<form class="wk-editor wk-desc-form" novalidate><label>Description <span class="detail-muted">Markdown: **bold**, lists, [links](https://…)</span>' +
          '<textarea class="wk-d-text" maxlength="' + MAX_NOTES + '" rows="12">' + esc(c.notes || '') + '</textarea></label>' +
          '<div class="field-error wk-d-error" hidden></div>' +
          '<div class="stage-fields-actions"><button class="btn" type="submit">Save</button><button class="btn" type="button" data-wk="dcancel">Cancel</button></div></form>';
        f = tmp.firstChild;
        wireDescription(f, c);
      }
      descSlot.replaceWith(f);
      if (!keepDesc) f.querySelector('textarea').focus();
    }
    var talkSlot = el('.wk-talk-slot');
    if (talkSlot) {
      if (!talk || talk.id !== c.id) {
        endTalk();
        var cid = c.id;
        talk = BoldCardTalk.create(cardsRef().doc(cid), { me: ctx.me, fullWrite: ctx.fullWrite, card: function(){ return cards.filter(function(k){ return k.id === cid; })[0]; } });
        talk.id = cid;
      }
      talkSlot.replaceWith(talk.el);
    }
    var editSlot = el('.wk-page-edit');
    if (editSlot && editing === c.id) {
      var form = keepEditor;
      if (!form) {
        var t2 = document.createElement('div');
        t2.innerHTML = editorHtml(c, null);
        form = t2.firstChild;
      }
      editSlot.appendChild(form);
      if (!keepEditor) { wireEditor(form, c); focusTitle(); }
    }
    wireOpen();
    var edit = el('.wk-edit');
    if (edit) edit.addEventListener('click', function(){ if (editing) return; editing = c.id; draftLinks = (c.links || []).slice(); draw(); });
    var desc = el('.wk-describe');
    if (desc) desc.addEventListener('click', function(){ describing = true; draw(); });
    var adopt = el('.wk-adopt');
    if (adopt) adopt.addEventListener('click', function(){ adoptItem(x, adopt); });
    var add = el('.wk-addimg'), file = el('.wk-imgfile');
    if (add) add.addEventListener('click', function(){ file.click(); });
    if (file) file.addEventListener('change', function(){ addImages(c, Array.prototype.slice.call(file.files || [])); });
    Array.prototype.forEach.call(root.querySelectorAll('.wk-unimage'), function(b){
      b.addEventListener('click', function(){ removeImage(c, b.getAttribute('data-path')); });
    });
  }
  function cardChange(c, data){
    var m = ctx.me();
    return cardsRef().doc(c.id).update(Object.assign(data, { updatedAt: Date.now(), updatedBy: m.email }));
  }
  function wireDescription(form, c){
    var error = form.querySelector('.wk-d-error');
    form.querySelector('[data-wk="dcancel"]').addEventListener('click', function(){ describing = false; form.remove(); draw(); });
    form.addEventListener('submit', function(e){
      e.preventDefault();
      if (busy) return;
      busy = true;
      cardChange(c, { notes: form.querySelector('.wk-d-text').value.trim().slice(0, MAX_NOTES) }).then(function(){
        busy = false; describing = false; form.remove(); draw();
      }).catch(function(err){
        console.error('[BOLD Lab] saving a description failed', err);
        busy = false; error.textContent = 'Couldn’t save — try again.'; error.hidden = false;
      });
    });
  }
  // Describing a GitHub item: a card for it, linking it, in its column; its page then shows the card.
  function adoptItem(x, button){
    if (busy) return;
    busy = true; button.disabled = true;
    var m = ctx.me(), now = Date.now(), title = String(x.title || x.ref).slice(0, 200);
    confirmNewCard(title).then(function(go){
      if (!go) throw { cancelled: true };
      return cardsRef().add({
        title: title, notes: '', kind: 'code', column: x.column || 'todo', assignees: [], assigneeEmails: [], announce: go.announce,
        links: [{ type: x.kind === 'pr' ? 'pr' : 'issue', ref: x.ref, url: x.url, label: (refLabel(x) + ': ' + x.title).slice(0, 200) }],
        by: { email: m.email, name: m.displayName || m.email }, at: now, movedAt: now, updatedAt: now, updatedBy: m.email
      });
    }).then(function(d){
      busy = false;
      go({ card: d.id }, true);
      describing = true; draw();
      setTimeout(function(){ fetchRemote(false); }, 2500);
    }).catch(function(err){
      if (err && err.cancelled) { busy = false; button.disabled = false; return; }
      console.error('[BOLD Lab] making a card failed', err);
      busy = false; msg = 'Couldn’t make a card for it — try again.'; draw();
    });
  }
  // Images go to Storage (work/<project>/<card>/…), then their addresses onto the card.
  function addImages(c, files){
    if (upload.busy || !files.length) return;
    var room = MAX_IMAGES - (c.images || []).length;
    var bad = files.filter(function(f){ return !IMAGE_TYPES[f.type] || f.size > MAX_IMAGE_MB * 1048576; });
    files = files.filter(function(f){ return bad.indexOf(f) < 0; }).slice(0, Math.max(0, room));
    if (!files.length) { upload.msg = bad.length ? 'Only PNG, JPEG, GIF or WebP images, up to ' + MAX_IMAGE_MB + ' MB.' : MAX_IMAGES + ' images at most.'; draw(); return; }
    upload = { busy: true, msg: 'Uploading ' + files.length + (files.length === 1 ? ' image' : ' images') + '…' };
    draw();
    var m = ctx.me();
    Promise.all(files.map(function(f){
      var path = 'work/' + pid + '/' + c.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + IMAGE_TYPES[f.type];
      var ref = firebase.storage().ref(path);
      return ref.put(f, { contentType: f.type }).then(function(){ return ref.getDownloadURL(); })
        .then(function(url){ return { path: path, url: url, name: String(f.name || '').slice(0, 200), by: m.email, at: Date.now() }; });
    })).then(function(added){
      var fresh = cards.filter(function(k){ return k.id === c.id; })[0] || c;
      return cardChange(c, { images: (fresh.images || []).concat(added).slice(0, MAX_IMAGES) });
    }).then(function(){
      upload = { busy: false, msg: bad.length ? 'Some weren’t PNG, JPEG, GIF or WebP up to ' + MAX_IMAGE_MB + ' MB, and were left out.' : '' };
      draw();
    }).catch(function(err){
      console.error('[BOLD Lab] uploading images failed', err);
      upload = { busy: false, msg: 'Couldn’t upload — try again.' };
      draw();
    });
  }
  function removeImage(c, path){
    if (!window.confirm('Remove this image?')) return;
    cardChange(c, { images: (c.images || []).filter(function(i){ return i.path !== path; }) }).then(function(){
      return firebase.storage().ref(path).delete().catch(function(err){ console.error('[BOLD Lab] deleting an image failed', err); });
    }).catch(function(err){
      console.error('[BOLD Lab] removing an image failed', err);
      upload.msg = 'Couldn’t remove it — try again.'; draw();
    });
  }

  function moveCard(c, column){
    if (column === c.column) return;
    // Shown in its new column at once; the live listener confirms it (or puts it back).
    var was = c.column;
    c.column = column; draw();
    var m = ctx.me(), now = Date.now();
    var data = {};
    ['title', 'notes', 'assignees', 'assigneeEmails', 'links', 'by', 'at'].forEach(function(k){ data[k] = c[k]; });
    if (c.images) data.images = c.images;
    if (c.milestone) data.milestone = c.milestone;
    data.kind = c.kind || '';
    confirmDone(Object.assign({}, c, { column: was }), column).then(function(done){
      if (!done) { c.column = was; draw(); return; }
      return cardsRef().doc(c.id).set(Object.assign(data, done, { notes: c.notes || '', column: column, movedAt: now, updatedAt: now, updatedBy: m.email }));
    }).catch(function(err){ console.error('[BOLD Lab] moving a card failed', err); c.column = was; msg = 'Couldn’t move it — try again.'; draw(); });
  }

  return { start: start, stop: stop, attach: attach, refresh: function(){ fetchRemote(true); }, _items: items, _githubRef: githubRef };
})();
