// A proposed change's own page (proposal.html?b=<id>; #324, 2026-11-11), as a pull request on GitHub: a branch of
// the site (branches/<id>, functions/branches.js) and its part of each page it changes (<page>/proposals/<id>).
// Its title and description (whoever has committed to it, or a PI or admin, edits them), who opened it and who has
// committed to it, and three tabs: Conversation (its description, its commits and what became of it, then its
// conversation: talk.js), Commits (each, by day, with what it changed) and Changes (each page as it would leave it,
// against main, and where it stands: behind main, in conflict). Browse the site puts this tab on it (bold.js
// BOLD.setBranch), where every page shows it and what you change is committed to it. Accept and Decline: a PI or
// admin who hasn't committed to it (decideBranch: all its pages together); Withdraw: whoever opened it, or a PI or admin.
(function(){
  var root = document.getElementById('proposal');
  if (!root || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml, P = window.BoldProposals, md = BoldMarkdown.render;
  var id = new URLSearchParams(location.search).get('b') || '';
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var call = function(name, data){ return firebase.app().functions('europe-west2').httpsCallable(name)(data); };
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) { root.innerHTML = '<div class="hero"><h1>Not found</h1><p class="hero-note">That isn’t a proposed change’s address.</p></div>'; return; }

  var me = null, b = null, loaded = false, error = '', num = 0, tab = 'conversation', editing = false, busy = false, notice = '';
  var pages = {}, props = {}, unsubs = [], open = {}, talk = null;
  var TABS = [['conversation', 'Conversation'], ['commits', 'Commits'], ['changes', 'Changes']];
  var SKILL = { title: 'Title', description: 'Description', body: 'Instructions (SKILL.md)', files: 'File' };
  var TOOL = { title: 'Title', description: 'Description', acting: 'Acts', input: 'Inputs', code: 'Code' };
  var STATE = { behind: 'Main has changed since: accepting it merges the two, as shown.', conflict: 'Main has changed in the same lines since: it can’t be accepted until it’s rebased on main.', gone: 'A part it changes has since been removed from main.' };

  // A page it changes, by name and address.
  function pageName(p){
    var d = pages[p], c = p.split('/')[0], s = p.slice(c.length + 1), q = props[p];
    var t = (d && d.title) || (q && q.after && q.after.title) || s;
    return c === 'handbook' ? 'BOLDiquette' : c === 'guides' ? t : c === 'skills' ? 'Skill: ' + t : 'Tool: ' + t;
  }
  var isWhole = function(p){ return /^(skills|agentTools)\//.test(p); };
  function wholeContent(p, d){
    var o = {}, f = /^skills\//.test(p) ? SKILL : TOOL;
    Object.keys(f).forEach(function(k){ var v = (d || {})[k]; o[f[k]] = v === undefined ? (k === 'files' ? [] : k === 'acting' ? 'No' : '') : k === 'acting' ? (v ? 'Yes' : 'No') : v; });
    return o;
  }
  // Page p as main has it, and as this branch would leave it.
  function mainOf(p){ return pages[p] || {}; }
  function afterOf(p){
    var q = props[p];
    if (!q) return mainOf(p);
    if (isWhole(p)) return q.kind === 'delete' ? null : Object.assign({}, mainOf(p), q.after || {});
    return P.after(mainOf(p), q);
  }
  function stateOf(p){
    var q = props[p];
    if (!q || isWhole(p)) return 'current';
    try { return P.stateOf(mainOf(p), q); } catch (e){ return 'current'; }
  }

  // Every commit, oldest first: { page, c (the change), by, at, n (its place on its page) }.
  function commits(){
    var out = [];
    (b.pages || []).forEach(function(p){
      var q = props[p];
      if (!q) return;
      var list = isWhole(p) ? (q.commits || [{ kind: q.kind, after: q.after, note: q.note, by: q.by, at: q.at }]) : q.kind === 'batch' ? q.changes || [] : [q];
      list.forEach(function(c, n){ out.push({ page: p, c: c, by: c.by || q.by || {}, at: c.at || q.at || 0, n: n }); });
    });
    return out.sort(function(a, z){ return a.at - z.at || a.n - z.n; });
  }
  // What one commit changed: on a page of parts, that change on the page as the commits before it left it;
  // on a skill or tool, it against the one before it.
  function commitDiff(x){
    var p = x.page, q = props[p];
    if (isWhole(p)) {
      var list = q.commits || [], prev = x.n ? list[x.n - 1].after : (q.before || mainOf(p));
      if (x.c.kind === 'delete') return '<p class="hist-note">Removes it.</p>';
      return BoldHistory.changesHtml(wholeContent(p, prev), wholeContent(p, Object.assign({}, prev, x.c.after)), {});
    }
    var cur = mainOf(p);
    (q.changes || []).slice(0, x.n).forEach(function(c){ try { cur = P.after(cur, c); } catch (e){} });
    return P.diffHtml(x.c, cur);
  }
  function label(x){ return isWhole(x.page) ? ({ new: 'New', delete: 'Remove it', skill: 'Change', tool: 'Change' }[x.c.kind] || 'Change') : P.changeLabel(x.c, mainOf(x.page)); }

  var DAY = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  function dayOf(t){ return new Date(t).toLocaleDateString('en-GB', DAY); }
  function timeOf(t){ return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function who(p){ return esc((p && (p.name || p.email)) || 'Someone'); }

  function canEdit(){ return !!(me && b && b.status === 'open' && (BOLD.isFullWrite() || (b.contributors || []).indexOf(me) >= 0)); }
  function decideOff(){
    if (!b || b.status !== 'open') return 'It has been decided';
    if (!BOLD.isFullWrite()) return 'Only PIs and admins accept or decline';
    if ((b.contributors || []).indexOf(me) >= 0) return 'You’ve committed to it: another PI or admin reviews it';
    var bad = (b.pages || []).filter(function(p){ return stateOf(p) === 'conflict' || stateOf(p) === 'gone'; });
    return bad.length ? pageName(bad[0]) + ' needs rebasing on main first' : '';
  }
  function canWithdraw(){ return !!(me && b && b.status === 'open' && (BOLD.isFullWrite() || (b.by && String(b.by.email || '').toLowerCase() === me))); }

  function headHtml(){
    var st = b.status, n = (b.pages || []).length, people = (b.contributors || []).length;
    var chip = '<span class="pr-state pr-' + esc(st) + '">' + esc({ open: 'Open', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn' }[st] || st) + '</span>';
    var title = editing ? '<div class="event-form pr-edit"><label>Title<input type="text" class="pr-title-in" maxlength="120" value="' + esc(b.title || '') + '"></label>' +
        '<label>Description<textarea class="pr-desc-in md-field" rows="6" data-preview-class="md-desc">' + esc(b.description || '') + '</textarea></label>' +
        '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save pr-save"' + (busy ? ' disabled' : '') + '>Save</button><button type="button" class="ev-cancel pr-cancel">Cancel</button></div></div>'
      : '<h1 class="pr-title">' + esc(b.title || 'A proposed change') + (num ? ' <span class="pr-num">#' + num + '</span>' : '') + '</h1>';
    var off = decideOff(), wd = canWithdraw();
    return '<div class="hero pr-hero"><div><span class="eyebrow">Proposed change</span></div>' + title +
      '<p class="pr-meta">' + chip + ' <span><strong>' + who(b.by) + '</strong> ' + (st === 'open' ? 'wants to change' : 'proposed changing') + ' ' +
        (b.pages || []).map(function(p){ return '<a href="#changes" data-tab="changes">' + esc(pageName(p)) + '</a>'; }).join(', ') +
        ' · ' + (people > 1 ? people + ' people committed' : '1 person committed') + ' · opened ' + esc(dayOf(b.at || 0)) +
        (b.decidedAt && st !== 'open' ? ' · ' + esc(st) + ' by ' + esc(b.decidedByName || b.decidedBy || '') + ' on ' + esc(dayOf(b.decidedAt)) : '') + '</span></p>' +
      (editing ? '' : '<div class="pr-actions">' +
        (st === 'open' ? '<button type="button" class="btn-box is-primary pr-browse">' + (BOLD.branchId() === id ? 'You’re on it: browse the site' : 'Browse the site') + '</button>' : '') +
        (st === 'open' ? '<button type="button" class="btn-box pr-accept"' + (off || busy ? ' disabled title="' + esc(off || '') + '"' : '') + '>Accept</button>' +
          '<button type="button" class="btn-box pr-decline"' + (decideOffSimple() || busy ? ' disabled title="' + esc(decideOffSimple()) + '"' : '') + '>Decline</button>' : '') +
        (wd ? '<button type="button" class="btn-text danger pr-withdraw"' + (busy ? ' disabled' : '') + '>Withdraw</button>' : '') +
        (canEdit() ? '<button type="button" class="btn-text pr-edit-btn">Edit</button>' : '') + '</div>') +
      (notice ? '<p class="gd-notice pr-notice">' + esc(notice) + '</p>' : '') + '</div>';
  }
  // Declining doesn't need it to apply cleanly.
  function decideOffSimple(){
    if (!b || b.status !== 'open') return 'It has been decided';
    if (!BOLD.isFullWrite()) return 'Only PIs and admins accept or decline';
    if ((b.contributors || []).indexOf(me) >= 0) return 'You’ve committed to it: another PI or admin reviews it';
    return '';
  }
  function tabsHtml(){
    var counts = { commits: commits().length, changes: (b.pages || []).length };
    return '<nav class="pr-tabs" aria-label="Its parts">' + TABS.map(function(t){
      return '<a href="#' + t[0] + '" class="pr-tab' + (tab === t[0] ? ' is-current' : '') + '" data-tab="' + t[0] + '"' + (tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] +
        (counts[t[0]] ? ' <span class="pr-count">' + counts[t[0]] + '</span>' : '') + '</a>';
    }).join('') + '</nav>';
  }
  function commitRow(x, i){
    var key = x.page + ':' + x.n;
    return '<li class="pr-commit"><button type="button" class="pr-commit-head" data-key="' + esc(key) + '" aria-expanded="' + !!open[key] + '">' +
      '<span class="pr-commit-note">' + esc(x.c.note || label(x).replace(/<[^>]*>/g, '')) + '</span>' +
      '<span class="pr-commit-meta">' + who(x.by) + ' · ' + esc(pageName(x.page)) + ' · ' + label(x) + ' · ' + esc(timeOf(x.at)) + '</span></button>' +
      (open[key] ? '<div class="pr-commit-diff">' + commitDiff(x) + '</div>' : '') + '</li>';
  }
  function conversationHtml(){
    var list = commits(), items = [];
    items.push('<article class="pr-desc"><p class="pr-desc-head"><strong>' + who(b.by) + '</strong> opened it · ' + esc(dayOf(b.at || 0)) + '</p>' +
      '<div class="pr-desc-body md-desc">' + (b.description ? md(b.description) : '<p class="pr-muted">No description.</p>') + '</div></article>');
    items.push('<ol class="pr-timeline">' + list.map(function(x){
      return '<li><span class="pr-dot" aria-hidden="true"></span><strong>' + who(x.by) + '</strong> committed <a href="#commits" data-tab="commits">' + esc(x.c.note || 'a change') + '</a> to ' + esc(pageName(x.page)) + ' · ' + esc(dayOf(x.at)) + '</li>';
    }).join('') + (b.status !== 'open' ? '<li class="pr-end"><span class="pr-dot" aria-hidden="true"></span><strong>' + esc(b.decidedByName || b.decidedBy || 'Someone') + '</strong> ' + esc({ accepted: 'accepted', declined: 'declined', withdrawn: 'withdrew' }[b.status] || b.status) + ' it · ' + esc(dayOf(b.decidedAt || 0)) + '</li>' : '') + '</ol>');
    items.push('<div class="pr-talk"></div>');
    return items.join('');
  }
  function commitsHtml(){
    var list = commits(), out = '', day = '';
    if (!list.length) return '<p class="pr-muted">No commits yet.</p>';
    list.forEach(function(x, i){
      var d = dayOf(x.at);
      if (d !== day) { out += (day ? '</ol>' : '') + '<h3 class="pr-day">Commits on ' + esc(d) + '</h3><ol class="pr-commits">'; day = d; }
      out += commitRow(x, i);
    });
    return out + '</ol>';
  }
  function changesHtml(){
    return (b.pages || []).map(function(p){
      var st = stateOf(p), q = props[p], go = BOLD.targetPage(p);
      var diff = !q ? '<p class="pr-muted">Loading…</p>' : isWhole(p)
        ? (q.kind === 'delete' ? '<p class="hist-note">Removes it.</p>' : BoldHistory.changesHtml(q.kind === 'new' ? {} : wholeContent(p, mainOf(p)), wholeContent(p, afterOf(p)), {}))
        : BoldHistory.changesHtml(P.flatten(mainOf(p)), P.flatten(afterOf(p)), {});
      return '<section class="pr-page"><h3 class="pr-page-head"><a href="' + esc(go) + '" class="pr-page-link" data-page="' + esc(p) + '">' + esc(pageName(p)) + '</a>' +
          (st !== 'current' ? ' <span class="pr-state pr-' + st + '">' + esc({ behind: 'Behind main', conflict: 'Conflict', gone: 'Part removed' }[st]) + '</span>' : '') + '</h3>' +
        (st !== 'current' ? '<p class="pr-page-note">' + esc(STATE[st]) + (st === 'conflict' && canEdit() ? ' <a href="' + esc(go) + '" class="pr-page-link" data-page="' + esc(p) + '">Rebase it on its page</a>.' : '') + '</p>' : '') +
        // A tool: Claude's review of it as it is now (functions/reviewer.js).
        (q && /^agentTools\//.test(p) ? '<p class="pr-page-note">' + (q.review && q.review.of === (q.editedAt || q.at) ? '<strong>Reviewer: ' + esc(q.review.verdict) + '.</strong> ' + esc(q.review.summary || '') : 'Claude is reviewing it…') + '</p>' : '') +
        '<div class="pr-diff">' + diff + '</div></section>';
    }).join('');
  }

  function render(){
    if (error) { root.innerHTML = '<div class="hero"><h1>Not found</h1><p class="hero-note">' + esc(error) + '</p></div>'; return; }
    if (!loaded) return;
    if (!b) { root.innerHTML = '<div class="hero"><h1>Not found</h1><p class="hero-note">No proposed change has this address.</p></div>'; return; }
    document.title = (num ? '#' + num + ' ' : '') + (b.title || 'Proposed change') + ' | BOLD Lab';
    var keep = talk && talk.el.parentNode ? talk.el : null;
    root.innerHTML = headHtml() + '<main>' + tabsHtml() + '<div class="pr-body">' + (tab === 'commits' ? commitsHtml() : tab === 'changes' ? changesHtml() : conversationHtml()) + '</div></main>';
    if (tab === 'conversation') mountTalk(keep);
  }
  // Its conversation (talk.js): a thread in Conversations, started by its first message. A branch made from a
  // proposed change of before keeps that one's (b.talk: { post, on }), its old comments read from its page.
  function mountTalk(){
    var slot = root.querySelector('.pr-talk');
    if (!slot || !window.BoldTalk || !b) return;
    if (!talk) {
      var t = b.talk && b.talk.post ? b.talk : { post: 'cm-branch-' + id, on: 'branch/' + id };
      var m = /^change\/(handbook|guides)\/([a-z0-9_-]+)\/([A-Za-z0-9]+)$/.exec(t.on || '');
      talk = BoldTalk.create({ post: t.post, on: t.on, label: 'Conversation', heading: true,
        old: m ? function(){ return db.collection(m[1]).doc(m[2]).collection('comments').where('proposalId', '==', m[3]); } : null,
        effects: ['Start its conversation in Conversations', 'Tell whoever opened it, and whoever joins in, of replies'] });
    }
    slot.appendChild(talk.el);
  }

  function act(what){
    var name = b.by && b.by.name;
    busy = true; notice = ''; render();
    var job = what === 'withdraw'
      ? BOLD.confirmAction({ title: 'Withdraw it?', go: 'Withdraw it', effects: ['Tell everyone who committed to it, and the PIs and admins, on Slack that it’s withdrawn'], always: true })
          .then(function(ok){ if (!ok) throw { cancelled: true }; return call('branchMeta', { id: id, withdraw: true }); })
      : BOLD.confirmProposal(what, name, (b.pages || []).length > 1 ? [(what === 'accept' ? 'Change ' : 'Leave ') + (b.pages || []).map(pageName).join(', ') + (what === 'accept' ? ', all together' : ' as they are')] : [])
          .then(function(ok){ if (!ok) throw { cancelled: true }; return call('decideBranch', { id: id, accept: what === 'accept', editedAt: b.editedAt || b.at || 0 }); });
    job.then(function(){
      busy = false; notice = what === 'accept' ? 'Accepted: the site has changed.' : what === 'decline' ? 'Declined.' : 'Withdrawn.';
      if (BOLD.branchId() === id) BOLD.setBranch(null, { quiet: true });
      render();
    }, function(err){
      busy = false;
      if (!(err && err.cancelled)) { console.error('[BOLD Proposal] ' + what + ' failed', err); notice = (err && err.message && /functions\/(failed-precondition|permission-denied|not-found)/.test(err.code || '')) ? err.message : 'Couldn’t do that — try again.'; }
      render();
    });
  }
  function saveMeta(){
    var t = (root.querySelector('.pr-title-in') || {}).value || '', d = (root.querySelector('.pr-desc-in') || {}).value || '';
    var errEl = root.querySelector('.pr-edit .ev-error');
    if (!t.trim()) { errEl.textContent = 'Give it a title.'; errEl.hidden = false; return; }
    busy = true; render();
    call('branchMeta', { id: id, title: t, description: d }).then(function(){ busy = false; editing = false; render(); }, function(err){
      console.error('[BOLD Proposal] saving failed', err); busy = false; render();
      var e2 = root.querySelector('.pr-edit .ev-error'); if (e2) { e2.textContent = 'Couldn’t save — try again.'; e2.hidden = false; }
    });
  }

  root.addEventListener('click', function(e){
    var a = e.target.closest('[data-tab]');
    if (a) { e.preventDefault(); tab = a.getAttribute('data-tab'); try { history.replaceState(null, '', location.pathname + location.search + '#' + tab); } catch (err){} render(); return; }
    // A page it changes: opened with the site on it.
    var pl = e.target.closest('.pr-page-link');
    if (pl && b && b.status === 'open') { e.preventDefault(); BOLD.setBranch({ id: id, num: num, title: b.title, targets: [pl.getAttribute('data-page')].concat(b.pages || []) }, { go: true }); return; }
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('pr-commit-head')) { var k = t.getAttribute('data-key'); open[k] = !open[k]; render(); return; }
    if (t.classList.contains('pr-browse')) { BOLD.setBranch({ id: id, num: num, title: b.title, targets: b.pages || [] }, { go: true }); return; }
    if (t.classList.contains('pr-accept')) { act('accept'); return; }
    if (t.classList.contains('pr-decline')) { act('decline'); return; }
    if (t.classList.contains('pr-withdraw')) { act('withdraw'); return; }
    if (t.classList.contains('pr-edit-btn')) { editing = true; render(); var f = root.querySelector('.pr-title-in'); if (f) f.focus(); return; }
    if (t.classList.contains('pr-cancel')) { editing = false; render(); return; }
    if (t.classList.contains('pr-save')) { saveMeta(); return; }
  });

  // Drawn again as what it shows changes, but not over its title and description being edited.
  function draw(){ if (!editing) render(); }
  // Each page it changes, and its part of it there, followed.
  var followed = {};
  function follow(){
    (b.pages || []).forEach(function(p){
      if (followed[p]) return;
      followed[p] = true;
      unsubs.push(db.doc(p).onSnapshot(function(s){ pages[p] = s.exists ? s.data() : null; draw(); }, function(err){ console.error('[BOLD Proposal] reading ' + p + ' failed', err); }));
      unsubs.push(db.doc(p + '/proposals/' + id).onSnapshot(function(s){ props[p] = s.exists ? s.data() : null; draw(); }, function(err){ console.error('[BOLD Proposal] reading its part on ' + p + ' failed', err); }));
    });
  }
  var h = location.hash.replace(/^#/, '');
  if (TABS.some(function(t){ return t[0] === h; })) tab = h;
  BOLD.onAccess(function(){ if (loaded) draw(); });
  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ if (typeof u === 'function') u(); }); unsubs = [];
    pages = {}; props = {}; followed = {};
    me = user ? String(user.email || '').toLowerCase() : null;
    if (!user) { root.innerHTML = '<div class="hero"><h1>Proposed change</h1><p class="hero-note">Sign in to see it.</p></div>'; return; }
    unsubs.push(db.collection('branches').doc(id).onSnapshot(function(s){
      loaded = true; b = s.exists ? s.data() : null; num = (b && b.num) || 0;
      if (b) follow();
      draw();
    }, function(err){
      console.error('[BOLD Proposal] loading it failed', err);
      loaded = true; error = err && err.code === 'permission-denied' ? 'You can’t see this proposed change.' : 'Couldn’t load it — reload to try again.'; render();
    }));
  });
})();
