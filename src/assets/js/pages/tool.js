// A tool's page (tool.html?tool=<name>): one of the tools the lab adds for AI agents,
// agentTools/{name} (functions/api-tools.js): its description, inputs, whether it acts,
// and its code, which runs in a sandbox as whoever calls it. Like everything on the site
// it changes only by a proposal (agentTools/{name}/proposals: kind 'tool', or 'delete'
// to remove it), listed under Proposed changes with what it changes and Claude's review
// (functions/reviewer.js), until another PI or admin accepts or declines it
// (decideProposal); whoever proposed it can edit or withdraw it. tool.html?new proposes a
// new tool (kind 'new'), shown on its page until decided. History: every version
// (history.js); PIs and admins restore one.
(function(){
  var esc = BOLD.escapeHtml;
  var body = document.getElementById('toolBody');
  if (!body || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var isNew = params.has('new'), name = params.get('tool') || '';
  var NAME = /^[a-z][a-z0-9_]{2,40}$/;
  var ref = !isNew && NAME.test(name) ? db.collection('agentTools').doc(name) : null;
  var x = null, loaded = false, proposals = [], me = null, fullWrite = false, form = null, editingQ = null, shown = {}, busy = {}, notice = '';
  var BACK = '<a class="back-link" href="tools.html">&larr; All tools</a>';
  var FIELDS = { title: 'Title', description: 'Description', acting: 'Acts', input: 'Inputs', code: 'Code' };
  var CONTENT = ['title', 'description', 'acting', 'input', 'code'];
  var historyWrap = document.getElementById('toolHistoryWrap'), histPanel = null;

  function content(d){ var o = {}; d = d || {}; CONTENT.forEach(function(k){ o[k] = d[k] !== undefined ? d[k] : (k === 'acting' ? false : k === 'input' ? {} : ''); }); return o; }
  // The proposal for this tool the site is on (bold.js's branch, the Version pill), if any:
  // the tool is shown as it would make it.
  function branchPrefix(){ return 'agentTools/' + name + '/proposals/'; }
  function branchQ(){
    var b = BOLD.branch(), id = b && b.ref.indexOf(branchPrefix()) === 0 ? b.ref.slice(branchPrefix().length) : '';
    return id ? proposals.filter(function(q){ return q.id === id; })[0] || null : null;
  }
  function viewQ(q){
    if (q) BOLD.setBranch({ ref: branchPrefix() + q.id, title: 'Tool ' + ((x && x.title) || name) + ': ' + (q.note || (q.kind === 'delete' ? 'remove it' : 'a change')), url: 'tool.html?tool=' + encodeURIComponent(name) }, { quiet: true });
    else BOLD.setBranch(null, { quiet: true });
    render(); window.scrollTo(0, 0);
  }
  function mine(q){ return !!(me && q.by && String(q.by.email).toLowerCase() === me.email.toLowerCase()); }
  function inputsHtml(input){
    var keys = Object.keys(input || {});
    if (!keys.length) return '<p class="proj-msg">No inputs.</p>';
    return '<ul class="tl-inputs">' + keys.map(function(k){ var i = input[k]; return '<li><code>' + esc(k) + '</code> <span class="tl-type">' + esc(i.type || 'string') + (i.required ? ', required' : '') + '</span>' + (i.description ? '<span class="tl-desc">' + esc(i.description) + '</span>' : '') + '</li>'; }).join('') + '</ul>';
  }

  // ---------- proposing ----------
  function formHtml(){
    var d = editingQ ? Object.assign(content(x), editingQ.after || {}) : content(x);
    var removing = form === 'delete';
    return '<div class="event-form skill-form">' +
      (isNew ? '<label>Name<input type="text" class="tl-name" spellcheck="false" autocapitalize="off" placeholder="e.g. overdue_letters"></label><p class="event-form-hint">Lowercase letters, digits and _: how agents call it. It can’t be changed later.</p>' : '') +
      (removing ? '<p class="hero-note">Propose removing this tool: agents won’t have it any more.</p>' :
        '<label>Title<input type="text" class="tl-title" maxlength="120" value="' + esc(d.title || '') + '"></label>' +
        '<label>Description<textarea class="tl-description no-tags" rows="3" maxlength="1500">' + esc(d.description || '') + '</textarea></label>' +
        '<p class="event-form-hint">What it does and when to use it: agents read only this to decide.</p>' +
        '<label class="tl-check"><input type="checkbox" class="tl-acting"' + (d.acting ? ' checked' : '') + '> It acts: it writes, or calls the site’s functions (only tokens allowed to act get it)</label>' +
        '<label>Inputs (JSON: { name: { type, description, required } })<textarea class="tl-input mono no-tags" rows="5" spellcheck="false">' + esc(JSON.stringify(d.input || {}, null, 2)) + '</textarea></label>' +
        '<label>Code (the body of an async function (input, bold) returning JSON)<textarea class="tl-code mono no-tags" rows="18" spellcheck="false">' + esc(d.code || '') + '</textarea></label>' +
        '<p class="event-form-hint">It runs in a sandbox as whoever calls it, under the site’s rules: <code>bold.read(path)</code>, <code>bold.query(collection, { where, orderBy, limit, group })</code>, and for a tool that acts <code>bold.write(op, path, data)</code> and <code>bold.call(callable, data)</code>.</p>') +
      '<label>What you changed and why, for whoever reviews it<input type="text" class="tl-note" maxlength="300" value="' + esc(editingQ ? editingQ.note || '' : '') + '"></label>' +
      '<p class="event-form-hint">It’s saved as a proposed change until ' + (fullWrite ? 'another' : 'a') + ' PI or admin accepts it; Claude reviews it meanwhile.</p>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save tl-save">' + (editingQ ? 'Update proposed change' : 'Propose') + '</button><button type="button" class="ev-cancel">Cancel</button></div></div>';
  }
  function fail(msg){ var e = body.querySelector('.ev-error'); e.textContent = msg; e.hidden = false; var b = body.querySelector('.tl-save'); if (b) b.disabled = false; }
  function save(){
    var v = function(c){ var el = body.querySelector(c); return el ? el.value : ''; };
    var note = v('.tl-note').trim(), target = isNew ? v('.tl-name').trim() : name;
    if (!NAME.test(target)) return fail('The name is lowercase letters, digits and _, 3 to 41 characters.');
    if (!note) return fail('Say what you changed and why, for whoever reviews it.');
    var kind = isNew ? 'new' : form === 'delete' ? 'delete' : 'tool', after = null;
    if (kind !== 'delete') {
      var input;
      try { input = JSON.parse(v('.tl-input') || '{}'); } catch (e){ return fail('The inputs aren’t valid JSON.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('The inputs are an object: { name: { type, description, required } }.');
      var code = v('.tl-code');
      if (!code.trim()) return fail('Write its code.');
      // Only compiled, to catch mistakes: it never runs here.
      try { new Function('input', 'bold', 'return (async () => {\n' + code + '\n})();'); } catch (e){ return fail('The code doesn’t compile: ' + e.message); }
      var proposed = { title: v('.tl-title').trim() || target, description: v('.tl-description').trim(), acting: body.querySelector('.tl-acting').checked, input: input, code: code };
      if (kind === 'new') after = proposed;
      else {
        after = {};
        CONTENT.forEach(function(k){ if (JSON.stringify(proposed[k]) !== JSON.stringify(content(x)[k])) after[k] = proposed[k]; });
        if (!editingQ && !Object.keys(after).length) return fail('That changes nothing.');
      }
    }
    body.querySelector('.tl-save').disabled = true;
    var col = db.collection('agentTools').doc(target).collection('proposals');
    var start = isNew ? db.collection('agentTools').doc(target).get().then(function(s){ if (s.exists) throw new Error('exists'); }) : Promise.resolve();
    start.then(function(){ return BOLD.confirmProposal(editingQ ? 'edit' : 'propose'); }).then(function(ok){
      if (!ok) throw { cancelled: true };
      var q = editingQ;
      return q ? col.doc(q.id).set({ kind: q.kind, before: null, after: after, note: note, by: q.by, at: q.at, status: 'open', editedAt: Date.now() })
        : col.add({ kind: kind, before: null, after: after, note: note, by: { email: me.email, name: me.name }, at: Date.now(), status: 'open' });
    }).then(function(){
      notice = 'Thanks — your change is under Proposed changes until ' + (fullWrite ? 'another' : 'a') + ' PI or admin reviews it.';
      if (isNew) { location.replace('tool.html?tool=' + encodeURIComponent(target) + '#proposals'); return; }
      form = null; editingQ = null; render();
    }).catch(function(err){
      if (err && err.cancelled) { body.querySelector('.tl-save').disabled = false; return; }
      if (err && err.message === 'exists') return fail('There’s already a tool called ' + target + ': propose a change to it instead.');
      console.error('[BOLD Tools] proposing failed', err); fail('Couldn’t save — try again.');
    });
  }

  // ---------- proposals ----------
  function proposalsHtml(){
    if (!proposals.length && !notice) return '';
    return '<section class="block" id="proposals"><div class="block-head"><h2>Proposed changes</h2></div>' + (notice ? '<p class="event-form-hint sk-notice">' + esc(notice) + '</p>' : '') +
      '<ul class="sk-proposals">' + proposals.map(function(q){
        var own = mine(q), b = busy[q.id] ? ' disabled' : '';
        var decide = !fullWrite ? ' disabled title="Only PIs and admins accept or decline"' : own ? ' disabled title="Another PI or admin reviews your own change"' : '';
        var what = q.kind === 'new' ? 'A new tool' : q.kind === 'delete' ? 'Removing it' : 'A change';
        var r = q.review && q.review.of === (q.editedAt || q.at) ? q.review : null;
        return '<li class="sk-proposal" id="q-' + esc(q.id) + '"><p class="sk-p-head"><strong>' + what + '</strong> · ' + esc((q.by && q.by.name) || 'Someone') + ' · ' + BoldHistory.when(q.editedAt || q.at) + (q.editedAt ? ' (edited)' : '') + '</p>' +
          (q.note ? '<p class="sk-p-note">' + esc(q.note) + '</p>' : '') +
          '<p class="event-form-hint">' + (r ? '<strong>Reviewer: ' + esc(r.verdict) + '.</strong> ' + esc(r.summary) : 'Claude is reviewing it…') + '</p>' +
          (shownQ(q) ? '<div class="sk-p-changes">' + (q.kind === 'delete' ? '<p class="event-form-hint">Removes the tool.</p>' : BoldHistory.changesHtml(content(x), content(Object.assign({}, x || {}, q.after)), FIELDS)) +
            (r && r.reasons && r.reasons.length ? '<ul class="mx-reasons">' + r.reasons.map(function(t){ return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') + '</div>' : '') +
          '<div class="event-controls"><button type="button" class="btn-text tq-show" data-id="' + esc(q.id) + '">' + (shownQ(q) ? 'Hide changes' : 'Show changes') + '</button>' +
            (x ? '<button type="button" class="btn-text tq-view" data-id="' + esc(q.id) + '">' + (branchQ() === q ? 'Back to the tool now' : 'View as proposed') + '</button>' : '') +
            '<button type="button" class="btn-text tq-accept" data-id="' + esc(q.id) + '"' + (decide || b) + '>Accept</button>' +
            '<button type="button" class="btn-text danger tq-decline" data-id="' + esc(q.id) + '"' + (decide || b) + '>Decline</button>' +
            (own ? (q.kind !== 'delete' ? '<button type="button" class="btn-text tq-edit" data-id="' + esc(q.id) + '"' + b + '>Edit</button>' : '') + '<button type="button" class="btn-text danger tq-withdraw" data-id="' + esc(q.id) + '"' + b + '>Withdraw</button>' : '') +
          '</div></li>';
      }).join('') + '</ul></section>';
  }
  function shownQ(q){ return !!shown[q.id] || (!x && q.kind === 'new'); }
  function proposalAction(t){
    var id = t.getAttribute('data-id'), q = proposals.filter(function(p){ return p.id === id; })[0];
    if (!q) return;
    if (t.classList.contains('tq-show')) { shown[id] = !shownQ(q); render(); return; }
    if (t.classList.contains('tq-view')) { viewQ(branchQ() === q ? null : q); return; }
    if (t.classList.contains('tq-edit')) { editingQ = q; form = 'change'; render(); return; }
    var withdraw = t.classList.contains('tq-withdraw'), accept = t.classList.contains('tq-accept');
    var job = BOLD.confirmProposal(withdraw ? 'withdraw' : accept ? 'accept' : 'decline', q.by && q.by.name, accept ? ['Give every agent the tool as changed, at once'] : []).then(function(ok){
      if (!ok) throw { cancelled: true };
      busy[id] = true; render();
      return withdraw ? db.collection('agentTools').doc(name).collection('proposals').doc(id).delete()
        : firebase.app().functions('europe-west2').httpsCallable('decideProposal')({ collection: 'agentTools', slug: name, id: id, accept: accept, editedAt: q.editedAt || 0 });
    });
    job.catch(function(err){
      if (err && err.cancelled) return;
      console.error('[BOLD Tools] that failed', err);
      window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'That didn’t work — try again.');
    }).then(function(){ delete busy[id]; render(); });
  }

  // ---------- page ----------
  function drawHistory(){
    var on = !!x && !form;
    historyWrap.hidden = !on;
    if (!on || histPanel) return;
    histPanel = BoldHistory.mount(document.getElementById('toolHistory'), {
      ref: ref, fields: FIELDS,
      canRestore: function(){ return fullWrite; },
      restore: function(v){
        var back = content(v.data);
        return ref.update(Object.assign(back, { name: name, changeNote: 'Restored the version of ' + BoldHistory.when(v.at), updatedAt: Date.now(), updatedBy: me.email }));
      },
    });
  }
  function render(){
    if (!loaded) return;
    if (historyWrap) drawHistory();
    if (isNew) {
      document.title = 'New tool | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<div><span class="eyebrow">Tool</span></div><h1>Propose a new tool</h1>' +
        '<p class="hero-note">A new ability for every agent. Another PI or admin accepts it; Claude reviews it meanwhile.</p></div><main>' + formHtml() + '</main>';
      bind();
      return;
    }
    if (!x && !proposals.length) {
      document.title = 'Tool not found | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<h1>Tool not found</h1><p class="hero-note">It may have been removed.</p></div>';
      return;
    }
    var shown_ = x ? content(x) : content((proposals.filter(function(q){ return q.kind === 'new'; })[0] || {}).after);
    // On a branch that changes it: shown as proposed, with no controls but the way back.
    var bq = x && branchQ();
    if (bq && bq.kind === 'tool') shown_ = content(Object.assign({}, x, bq.after));
    document.title = (shown_.title || name) + ' | BOLD Lab';
    var head = '<div class="hero">' + BACK + '<div><span class="eyebrow">Tool' + (x ? '' : ' · proposed') + '</span></div><h1>' + esc(shown_.title || name) + '</h1>' +
      '<p class="skill-name"><code>' + esc(name) + '</code> · ' + (shown_.acting ? 'acts' : 'reads') + '</p>';
    if (form) { body.innerHTML = head + '</div><main>' + formHtml() + '</main>'; bind(); return; }
    body.innerHTML = head + '<p class="hero-note">' + esc(shown_.description || '') + '</p>' +
      (bq ? '<p class="sk-branch">' + (bq.kind === 'delete' ? 'This tool would be removed, as proposed by ' : 'Shown as proposed by ') + esc((bq.by && bq.by.name) || 'someone') + (bq.note ? ': “' + esc(bq.note) + '”' : '') +
        '. <button type="button" class="btn-text tl-branch-back">Back to the tool now</button></p>' :
      x ? '<div class="event-controls"><button type="button" class="btn-text tl-change">Propose a change</button><button type="button" class="btn-text danger tl-remove">Propose removing it</button></div>' : '') + '</div>' +
      '<main>' + proposalsHtml() + (x ? '<section class="block"><div class="block-head"><h2>Inputs</h2></div>' + inputsHtml(shown_.input) + '</section>' +
        '<section class="block"><div class="block-head"><h2>Code</h2></div><pre class="skill-file-body"><code>' + esc(shown_.code || '') + '</code></pre></section>' : '') + '</main>';
    var tb = body.querySelector('.tl-branch-back');
    if (tb) tb.addEventListener('click', function(){ viewQ(null); });
    var c = body.querySelector('.tl-change'), rm = body.querySelector('.tl-remove');
    if (c) c.addEventListener('click', function(){ notice = ''; editingQ = null; form = 'change'; render(); });
    if (rm) rm.addEventListener('click', function(){ notice = ''; editingQ = null; form = 'delete'; render(); });
    var qs = body.querySelector('.sk-proposals');
    if (qs) qs.addEventListener('click', function(e){ var t = e.target.closest('button'); if (t && !t.disabled) proposalAction(t); });
  }
  function bind(){
    body.querySelector('.tl-save').addEventListener('click', save);
    body.querySelector('.ev-cancel').addEventListener('click', function(){ if (isNew) { location.href = 'tools.html'; return; } form = null; editingQ = null; render(); });
    body.querySelector('.skill-form').addEventListener('input', function(){ var e = body.querySelector('.ev-error'); if (e) e.hidden = true; });
  }

  BOLD.onUser(function(user){
    if (!user) return;
    me = { email: (user.email || '').toLowerCase(), name: user.displayName || user.email || '' };
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')({}).then(function(r){ fullWrite = !!(r.data && r.data.fullWrite); render(); }).catch(function(){});
    if (isNew) { loaded = true; render(); return; }
    if (!ref) { loaded = true; render(); return; }
    var editing = function(){ return form && body.querySelector('.skill-form'); };
    ref.onSnapshot(function(snap){ x = snap.exists ? snap.data() : null; loaded = true; if (!editing()) render(); },
      function(err){ console.error('[BOLD Tools] loading failed', err); loaded = true; render(); });
    ref.collection('proposals').where('status', '==', 'open').onSnapshot(function(snap){
      proposals = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return a.at - b.at; });
      if (!editing()) render();
    }, function(err){ console.error('[BOLD Tools] loading proposals failed', err); });
  });
})();
