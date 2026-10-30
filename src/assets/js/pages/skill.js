// A skill's page (skill.html?skill=<name>) — one skills/{name} doc (see
// skills-common.js): its title and description, how to install it, and the
// files in it (SKILL.md first), each shown on click. Anyone proposes a change to
// it, as to a guide — description, SKILL.md's instructions, and the files: add
// one empty or from the computer, rename, change or remove it — saved as a
// proposal (skills/{name}/proposals, kind 'skill': { before, after }) under
// Proposed changes, with what it changes, until another PI or admin accepts or
// declines it (decideProposal); whoever proposed it can edit or withdraw it. PIs
// and admins delete the skill (greyed out for everyone else). #edit opens the form. skill.html?new is the same form for a new skill ("+ Add a
// skill" on the skills page), with its name. Either form can import a whole
// skill's folder (skill-import.js), which fills everything in. The page's
// sections: the description (hero), Install (the Claude Code command), Content
// (the files), History (history.js: every version the server recorded, with
// what changed; PIs/admins restore one). Each save can carry a note. A skill
// that doesn't exist yet but is proposed (kind 'new', e.g. by an agent) shows its
// proposal instead, with its contents, for another PI or admin to accept or decline.
(function(){
  var esc = BOLD.escapeHtml;
  var S = window.BoldSkills;
  var body = document.getElementById('skillBody');
  if (!body || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var isNew = params.has('new');
  var name = params.get('skill') || '';
  var ref = !isNew && S.NAME.test(name) ? db.collection('skills').doc(name) : null;
  // Firestore keeps a document under 1 MiB; leave room for the rest of it.
  var MAX_SIZE = 900000;

  var x = null, loaded = false, editing = isNew || location.hash === '#edit', fullWrite = false, me = null, open = 'SKILL.md';
  // Open proposed changes; the one being edited (yours), if any; whose changes are shown; a notice.
  var proposals = [], editingQ = null, shownQ = {}, notice = '', busyQ = {};
  var BACK = '<a class="back-link" href="skills.html">&larr; All skills</a>';
  var CONTENT = ['title', 'description', 'body', 'files'];
  var historyWrap = document.getElementById('skillHistoryWrap'), histPanel = null;

  function skillMd(){
    return '---\nname: ' + x.name + '\ndescription: ' + JSON.stringify(x.description || '') + '\n---\n\n' + String(x.body || '').replace(/^\s+/, '');
  }
  function allFiles(){
    return [{ path: 'SKILL.md', content: skillMd() }].concat((x.files || []).slice().sort(function(a, b){ return a.path.localeCompare(b.path); }));
  }
  function sizeLabel(s){
    var n = new Blob([s]).size;
    return n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  }

  function controls(){
    var off = fullWrite ? '' : ' disabled title="Only PIs and admins can delete a skill"';
    return '<div class="event-controls"><button type="button" class="btn-text sk-edit">Propose a change</button>' +
      '<button type="button" class="btn-text danger sk-delete"' + off + '>Delete</button></div>';
  }

  // ---------- proposed changes ----------
  var FIELDS = { title: 'Title', description: 'Description', body: 'Instructions (SKILL.md)', files: 'File' };
  function content(d){ var o = {}; CONTENT.forEach(function(k){ o[k] = d[k] !== undefined ? d[k] : (k === 'files' ? [] : ''); }); return o; }
  function mine(q){ return !!(me && q.by && String(q.by.email).toLowerCase() === me.email.toLowerCase()); }
  // A proposed new skill's changes are shown from the start: they are all there is to see.
  // The proposal for this skill the site is on (bold.js's branch, the Version pill), if any:
  // the skill is shown as it would make it.
  function branchPrefix(){ return 'skills/' + name + '/proposals/'; }
  function branchQ(){
    var b = BOLD.branch(), id = b && b.ref.indexOf(branchPrefix()) === 0 ? b.ref.slice(branchPrefix().length) : '';
    return id ? proposals.filter(function(q){ return q.id === id; })[0] || null : null;
  }
  function viewQ(q){
    if (q) BOLD.setBranch({ ref: branchPrefix() + q.id, title: 'Skill ' + ((x && x.title) || name) + ': ' + (q.note || 'a change'), url: 'skill.html?skill=' + encodeURIComponent(name) }, { quiet: true });
    else BOLD.setBranch(null, { quiet: true });
    render(); window.scrollTo(0, 0);
  }
  // fn() with x as shown: on a branch that changes the skill, as proposed.
  function withShown(fn){
    var bq = branchQ(), x0 = x;
    if (bq && bq.kind === 'skill' && x) x = Object.assign({}, x, bq.after);
    try { return fn(); } finally { x = x0; }
  }
  function isShown(q){ return shownQ[q.id] !== undefined ? shownQ[q.id] : !x && q.kind === 'new'; }
  function proposalsHtml(){
    if (!proposals.length && !notice) return '';
    return '<section class="block" id="proposals"><div class="block-head"><h2>' + (x ? 'Proposed changes' : 'Proposed') + '</h2></div>' +
      (notice ? '<p class="event-form-hint sk-notice">' + esc(notice) + '</p>' : '') +
      '<ul class="sk-proposals">' + proposals.map(function(q){
        var own = mine(q), b = busyQ[q.id] ? ' disabled' : '', fresh = !x && q.kind === 'new';
        var stale = !!x && JSON.stringify(content(q.before || {})) !== JSON.stringify(content(x));
        var decide = !fullWrite ? ' disabled title="Only PIs and admins accept or decline"' : own ? ' disabled title="Another PI or admin reviews your own change"' : '';
        return '<li class="sk-proposal" id="q-' + esc(q.id) + '"><p class="sk-p-head">' + (fresh ? '<strong>A new skill</strong> · ' + esc((q.by && q.by.name) || 'Someone') : '<strong>' + esc((q.by && q.by.name) || 'Someone') + '</strong>') +
            ' · ' + BoldHistory.when(q.editedAt || q.at) + (q.editedAt ? ' (edited)' : '') + '</p>' +
          (q.note ? '<p class="sk-p-note">' + esc(q.note) + '</p>' : '') +
          (stale ? '<p class="event-form-hint">The skill has changed since this was proposed: accepting it replaces those changes with these.</p>' : '') +
          (isShown(q) ? '<div class="sk-p-changes">' + BoldHistory.changesHtml(content(q.before || {}), content(Object.assign({}, q.before, q.after)), FIELDS) + '</div>' : '') +
          '<div class="event-controls"><button type="button" class="btn-text sk-q-show" data-id="' + esc(q.id) + '">' + (isShown(q) ? 'Hide changes' : 'Show changes') + '</button>' +
            (x ? '<button type="button" class="btn-text sk-q-view" data-id="' + esc(q.id) + '">' + (branchQ() === q ? 'Back to the skill now' : 'View as proposed') + '</button>' : '') +
            '<button type="button" class="btn-text sk-q-accept" data-id="' + esc(q.id) + '"' + (decide || b) + '>Accept</button>' +
            '<button type="button" class="btn-text danger sk-q-decline" data-id="' + esc(q.id) + '"' + (decide || b) + '>Decline</button>' +
            // A proposed new skill is edited by proposing it again (the form here changes an existing one).
            (own ? (fresh ? '' : '<button type="button" class="btn-text sk-q-edit" data-id="' + esc(q.id) + '"' + b + '>Edit</button>') + '<button type="button" class="btn-text danger sk-q-withdraw" data-id="' + esc(q.id) + '"' + b + '>Withdraw</button>' : '') +
          '</div></li>';
      }).join('') + '</ul></section>';
  }
  function proposalAction(t){
    var id = t.getAttribute('data-id'), q = proposals.filter(function(p){ return p.id === id; })[0];
    if (!q) return;
    if (t.classList.contains('sk-q-show')) { shownQ[id] = !isShown(q); render(); return; }
    if (t.classList.contains('sk-q-view')) { viewQ(branchQ() === q ? null : q); return; }
    if (t.classList.contains('sk-q-edit')) { editingQ = q; editing = true; render(); return; }
    var withdraw = t.classList.contains('sk-q-withdraw'), accept = t.classList.contains('sk-q-accept');
    var job = BOLD.confirmProposal(withdraw ? 'withdraw' : accept ? 'accept' : 'decline', q.by && q.by.name, accept ? ['Give every agent the skill as changed, at once'] : []).then(function(ok){
      if (!ok) throw { cancelled: true };
      busyQ[id] = true; render();
      return withdraw ? ref.collection('proposals').doc(id).delete()
        // editedAt: the version decided on, in case it's edited meanwhile.
        : firebase.app().functions('europe-west2').httpsCallable('decideProposal')({ collection: 'skills', slug: name, id: id, accept: accept, editedAt: q.editedAt || 0 });
    });
    job.catch(function(err){
      if (err && err.cancelled) return;
      console.error('[BOLD Skills] that failed', err);
      window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'That didn’t work — try again.');
    }).then(function(){ delete busyQ[id]; render(); });
  }

  // The Claude Code command, ready to copy.
  function installHtml(){
    return '<section class="block"><div class="block-head"><h2>Install</h2></div>' +
      BOLD.copyBoxHtml(S.installCommand(x.name)) +
      '</section>';
  }

  function filesHtml(){
    return '<section class="block"><div class="block-head"><h2>Content</h2></div><ul class="skill-files">' +
      allFiles().map(function(f){
        var on = f.path === open;
        var preview = /\.html?$/i.test(f.path) ? '<button type="button" class="btn-text sk-preview" data-path="' + esc(f.path) + '">Preview</button>' : '';
        return '<li class="skill-file' + (on ? ' is-open' : '') + '">' +
          '<div class="skill-file-head"><button type="button" class="skill-file-name" data-path="' + esc(f.path) + '" aria-expanded="' + on + '">' +
            esc(x.name + '/' + f.path) + '</button><span class="skill-file-size">' + sizeLabel(f.content) + '</span>' + preview + '</div>' +
          (on ? '<pre class="skill-file-body"><code>' + esc(f.content) + '</code></pre>' : '') + '</li>';
      }).join('') + '</ul></section>';
  }

  function fileRowHtml(f){
    return '<div class="sk-file"><div class="sk-file-head"><input type="text" class="sk-path" value="' + esc(f.path || '') + '" placeholder="e.g. references/style.md" spellcheck="false">' +
      '<button type="button" class="btn-text danger sk-remove">Remove</button></div>' +
      '<textarea class="sk-content mono no-tags" rows="8" spellcheck="false">' + esc(f.content || '') + '</textarea></div>';
  }

  function formHtml(){
    // An existing skill's form proposes a change: from the skill, or from your proposal being edited.
    var x0 = x;
    x = editingQ ? Object.assign({}, x, editingQ.after) : x;
    try {
    return '<div class="event-form skill-form">' +
      '<div class="sk-import"><span>Have the skill already?</span>' +
        '<label class="btn-text">Import a folder<input type="file" class="sk-import-folder" webkitdirectory hidden></label>' +
        '</div>' +
      S.metaHtml(x, isNew) +
      '<label>Instructions (SKILL.md, after its name and description)<textarea class="sk-body mono no-tags" rows="18" spellcheck="false">' + esc(x.body || '') + '</textarea></label>' +
      '<p class="event-form-hint">Point Claude to the other files by their path, e.g. <code>assets/template.html</code>; it opens them only when it needs them.</p>' +
      '<p class="event-form-head sk-files-head">Other files</p><div class="sk-files">' + (x.files || []).map(fileRowHtml).join('') + '</div>' +
      '<div class="sk-file-add"><button type="button" class="btn-text sk-add-empty">+ Add a file</button>' +
        '<label class="btn-text sk-add-upload">+ Add from your computer<input type="file" multiple hidden></label></div>' +
      '<p class="event-form-hint">Text files only (Markdown, HTML, code, …), under about 900 KB in all. Adding a SKILL.md fills in the description and instructions above.</p>' +
      (isNew ? '<label>What changed (optional)<input type="text" class="sk-note" maxlength="300" placeholder="Added the skill"></label>'
        : '<label>What you changed and why, for whoever reviews it<input type="text" class="sk-note" maxlength="300" value="' + esc(editingQ ? editingQ.note || '' : '') + '" placeholder="e.g. Clearer figure rules"></label>' +
          '<p class="event-form-hint">It’s saved as a proposed change until ' + (fullWrite ? 'another' : 'a') + ' PI or admin accepts it.</p>') +
      '<p class="ev-error" hidden></p>' +
      '<div class="event-form-actions"><button type="button" class="ev-save">' + (isNew ? 'Add skill' : editingQ ? 'Update proposed change' : 'Propose change') + '</button><button type="button" class="ev-cancel">Cancel</button></div></div>';
    } finally { x = x0; }
  }

  // SKILL.md's text → { description, body }: the front matter's description
  // (plain, quoted, or a folded/literal block), and everything after it.
  function parseSkillMd(text){
    var m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return { name: '', description: '', body: text };
    var lines = m[1].split(/\r?\n/), description = '';
    var nm = /^name:\s*["']?([^"'\s]*)["']?\s*$/m.exec(m[1]);
    for (var i = 0; i < lines.length; i++) {
      var d = /^description:\s*(.*)$/.exec(lines[i]);
      if (!d) continue;
      var v = d[1].trim();
      if (!v || /^[>|][+-]?$/.test(v)) {
        var block = [];
        while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && lines[i + 1] !== '') block.push(lines[++i].trim());
        description = block.join(v.charAt(0) === '|' ? '\n' : ' ');
      } else if (v.charAt(0) === '"') {
        try { description = JSON.parse(v); } catch (e){ description = v.slice(1, -1); }
      } else if (v.charAt(0) === "'") {
        description = v.slice(1, -1).replace(/''/g, "'");
      } else description = v;
      break;
    }
    return { name: nm ? nm[1] : '', description: description, body: text.slice(m[0].length).replace(/^\s+/, '') };
  }

  function readFiles(form){
    var files = [], seen = {}, error = '';
    Array.prototype.forEach.call(form.querySelectorAll('.sk-file'), function(row){
      var path = row.querySelector('.sk-path').value.trim().replace(/^\.?\/+/, '');
      var content = row.querySelector('.sk-content').value;
      if (!path && !content) return;
      if (!path) error = error || 'Give every file a path.';
      else if (path === 'SKILL.md') error = error || 'SKILL.md is made from the name, description and instructions above.';
      else if (path.split('/').some(function(p){ return !p || p === '.' || p === '..'; }) || /\\/.test(path)) error = error || 'A path like ' + path + ' won’t work; use folders/and/a-name.ext.';
      else if (seen[path]) error = error || 'There are two files called ' + path + '.';
      seen[path] = true;
      files.push({ path: path, content: content });
    });
    return error ? { error: error } : { files: files };
  }

  function bindForm(){
    var form = body.querySelector('.skill-form');
    var list = form.querySelector('.sk-files');
    function addRow(f){
      var wrap = document.createElement('div');
      wrap.innerHTML = fileRowHtml(f);
      var row = wrap.firstChild;
      list.appendChild(row);
      return row;
    }
    list.addEventListener('click', function(e){
      var rm = e.target.closest('.sk-remove');
      if (rm) rm.closest('.sk-file').remove();
    });
    form.querySelector('.sk-add-empty').addEventListener('click', function(){ addRow({}).querySelector('.sk-path').focus(); });
    var upload = form.querySelector('.sk-add-upload input');
    upload.addEventListener('change', function(){
      Array.prototype.forEach.call(upload.files, function(file){
        file.text().then(function(text){
          if (text.indexOf('\u0000') !== -1 || text.indexOf('�') !== -1) { S.showError(form, file.name + ' isn’t a text file, so it can’t be added.'); return; }
          // A SKILL.md fills the description and instructions instead of becoming a file.
          if (file.name === 'SKILL.md') { fillSkillMd(text); return; }
          var guess = /\.(md|txt)$/i.test(file.name) ? 'references/' : /\.(py|sh|js|mjs|ts)$/i.test(file.name) ? 'scripts/' : 'assets/';
          addRow({ path: guess + file.name, content: text });
        });
      });
      upload.value = '';
    });

    function fillSkillMd(text){
      var md = parseSkillMd(text);
      var nameInput = form.querySelector('.sk-name');
      if (nameInput && md.name) nameInput.value = md.name;
      if (md.description) form.querySelector('.sk-description').value = md.description;
      form.querySelector('.sk-body').value = md.body;
    }
    // A whole skill: its SKILL.md fills the fields, its other files replace the list.
    function importSkill(promise){
      S.showError(form, '');
      promise.then(function(r){
        var md = r.files.filter(function(f){ return f.path === 'SKILL.md'; })[0];
        if (!md) { S.showError(form, 'There’s no SKILL.md in it, so it isn’t a skill.'); return; }
        fillSkillMd(md.content);
        var nameInput = form.querySelector('.sk-name');
        if (nameInput && !nameInput.value && r.folder) nameInput.value = r.folder;
        list.innerHTML = '';
        r.files.forEach(function(f){ if (f.path !== 'SKILL.md') addRow(f); });
        if (r.skipped.length) S.showError(form, 'Left out, as they aren’t text files: ' + r.skipped.join(', ') + '.');
      }).catch(function(err){
        console.error('[BOLD Skills] importing a skill failed', err);
        S.showError(form, 'Couldn’t read that folder — try again.');
      });
    }
    var folderInput = form.querySelector('.sk-import-folder');
    folderInput.addEventListener('change', function(){ if (folderInput.files.length) importSkill(SkillImport.fromFolder(folderInput.files)); folderInput.value = ''; });

    form.querySelector('.ev-cancel').addEventListener('click', function(){
      if (isNew) { location.href = 'skills.html'; return; }
      editing = false; editingQ = null; history.replaceState(null, '', location.pathname + location.search); render(); });
    form.querySelector('.ev-save').addEventListener('click', function(){
      var r = S.readMeta(form, isNew);
      if (r.error) { S.showError(form, r.error); return; }
      var f = readFiles(form);
      if (f.error) { S.showError(form, f.error); return; }
      var fields = Object.assign(r.fields, { body: form.querySelector('.sk-body').value, files: f.files,
        changeNote: form.querySelector('.sk-note').value.trim(), updatedAt: Date.now(), updatedBy: me.email });
      if (new Blob([JSON.stringify(fields)]).size > MAX_SIZE) { S.showError(form, 'That’s too much text for one skill — keep it under about 900 KB.'); return; }
      var save = form.querySelector('.ev-save');
      save.disabled = true;
      var failed = function(err){
        if (err && err.cancelled) { save.disabled = false; return; }
        console.error('[BOLD Skills] saving the skill failed', err);
        S.showError(form, 'Couldn’t save — try again.');
        save.disabled = false;
      };
      if (isNew) {
        var newRef = db.collection('skills').doc(fields.name);
        newRef.get().then(function(snap){
          if (snap.exists) { S.showError(form, 'There’s already a skill called ' + fields.name + '.'); save.disabled = false; return; }
          return newRef.set(Object.assign(fields, { createdAt: fields.updatedAt, createdBy: me.email })).then(function(){
            location.replace('skill.html?skill=' + encodeURIComponent(fields.name));
          });
        }).catch(failed);
        return;
      }
      // A change to an existing skill is a proposal (rules: only its content, and who proposes it).
      var note = fields.changeNote;
      if (!note) { S.showError(form, 'Say what you changed and why, for whoever reviews it.'); save.disabled = false; return; }
      var after = content(fields), q = editingQ;
      if (JSON.stringify(after) === JSON.stringify(content(q ? Object.assign({}, x, q.after) : x))) { editing = false; editingQ = null; render(); return; }
      var job = BOLD.confirmProposal(q ? 'edit' : 'propose').then(function(ok){ if (!ok) throw { cancelled: true }; }).then(function(){ return q
        ? ref.collection('proposals').doc(q.id).set({ kind: 'skill', before: q.before, after: after, note: note, by: q.by, at: q.at, status: 'open', editedAt: Date.now() })
        : ref.collection('proposals').add({ kind: 'skill', before: content(x), after: after, note: note, by: { email: me.email, name: me.name }, at: Date.now(), status: 'open' }); });
      job.then(function(){
        editing = false; editingQ = null; notice = 'Thanks — your change is under Proposed changes until ' + (fullWrite ? 'another' : 'a') + ' PI or admin reviews it.';
        history.replaceState(null, '', location.pathname + location.search); render();
        var el = document.getElementById('proposals'); if (el) el.scrollIntoView({ block: 'start' });
      }).catch(failed);
    });
  }

  function drawHistory(){
    var on = !!x && !isNew && !editing;
    historyWrap.hidden = !on;
    if (!on || histPanel) return;
    histPanel = BoldHistory.mount(document.getElementById('skillHistory'), {
      ref: ref,
      fields: { title: 'Title', description: 'Description', body: 'Instructions (SKILL.md)', files: 'File' },
      canRestore: function(){ return fullWrite; },
      restore: function(v){
        var back = {};
        CONTENT.forEach(function(k){ back[k] = v.data[k] !== undefined ? v.data[k] : (k === 'files' ? [] : ''); });
        return ref.update(Object.assign(back, { changeNote: 'Restored the version of ' + BoldHistory.when(v.at), updatedAt: Date.now(), updatedBy: me.email }));
      },
    });
  }

  function render(){
    if (!loaded) return;
    if (historyWrap) drawHistory();
    if (isNew) {
      document.title = 'New skill | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<div><span class="eyebrow">Skill</span></div><h1>New skill</h1>' +
        (fullWrite ? '' : '<p class="hero-note">' + S.NOT_PI + '.</p>') + '</div>' + (fullWrite ? '<main>' + formHtml() + '</main>' : '');
      if (fullWrite) bindForm();
      return;
    }
    var newQ = proposals.filter(function(q){ return q.kind === 'new'; })[0];
    if (!x && !newQ) {
      document.title = 'Skill not found | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<h1>Skill not found</h1><p class="hero-note">It may have been deleted.</p></div>';
      return;
    }
    if (!x) {
      // Proposed, not yet accepted: its proposal is the page.
      var p = newQ.after || {};
      document.title = (p.title || name) + ' | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<div><span class="eyebrow">Skill · proposed</span></div><h1>' + esc(p.title || name) + '</h1>' +
        '<p class="skill-name"><code>' + esc(name) + '</code></p><p class="hero-note">' + esc(p.description || '') + '</p></div>' +
        '<main>' + proposalsHtml() + '</main>';
      var pq = body.querySelector('.sk-proposals');
      if (pq) pq.addEventListener('click', function(e){ var t = e.target.closest('button'); if (t && !t.disabled) proposalAction(t); });
      return;
    }
    document.title = (x.title || x.name) + ' | BOLD Lab';
    var head = '<div class="hero">' + BACK + '<div><span class="eyebrow">Skill</span></div><h1>' + esc(x.title || x.name) + '</h1>' +
      '<p class="skill-name"><code>' + esc(x.name) + '</code></p>';
    if (editing) {
      body.innerHTML = head + '</div><main>' + formHtml() + '</main>';
      bindForm();
      return;
    }
    // On a branch that changes it: shown as proposed, with no controls but the way back.
    var bq = branchQ(), qsHtml = proposalsHtml();   // measured against the skill as it is
    withShown(function(){
      body.innerHTML = '<div class="hero">' + BACK + '<div><span class="eyebrow">Skill</span></div><h1>' + esc(x.title || x.name) + '</h1>' +
        '<p class="skill-name"><code>' + esc(x.name) + '</code></p><p class="hero-note">' + esc(x.description || '') + '</p>' +
        (bq ? '<p class="sk-branch">Shown as proposed by ' + esc((bq.by && bq.by.name) || 'someone') + (bq.note ? ': “' + esc(bq.note) + '”' : '') + '. <button type="button" class="btn-text sk-branch-back">Back to the skill now</button></p>' : controls()) + '</div>' +
        '<main>' + qsHtml + installHtml() + filesHtml() + '</main>';
    });
    var back = body.querySelector('.sk-branch-back');
    if (back) back.addEventListener('click', function(){ viewQ(null); });
    var ed = body.querySelector('.sk-edit');
    if (ed) ed.addEventListener('click', function(){ editingQ = null; notice = ''; editing = true; render(); });
    var qs = body.querySelector('.sk-proposals');
    if (qs) qs.addEventListener('click', function(e){ var t = e.target.closest('button'); if (t && !t.disabled) proposalAction(t); });
    var del = body.querySelector('.sk-delete');
    if (del) del.addEventListener('click', function(){
      if (!fullWrite || !window.confirm('Delete the skill “' + (x.title || x.name) + '” for good? Anyone who installed it keeps their copy.')) return;
      // Stamp who's deleting it first: the history credits the last updatedBy.
      ref.update({ updatedBy: me.email, updatedAt: Date.now(), changeNote: '' }).then(function(){ return ref.delete(); })
        .then(function(){ location.href = 'skills.html'; }).catch(function(err){
        console.error('[BOLD Skills] deleting the skill failed', err);
        window.alert('Couldn’t delete the skill — try again.');
      });
    });
    body.querySelector('.skill-files').addEventListener('click', function(e){
      var pv = e.target.closest('.sk-preview');
      if (pv) {
        var f = withShown(function(){ return allFiles().filter(function(f){ return f.path === pv.getAttribute('data-path'); })[0]; });
        if (f) window.open(URL.createObjectURL(new Blob([f.content], { type: 'text/html' })), '_blank');
        return;
      }
      var b = e.target.closest('.skill-file-name');
      if (!b) return;
      var p = b.getAttribute('data-path');
      open = open === p ? '' : p;
      var y = window.scrollY;
      render();
      window.scrollTo(0, y);
    });
  }

  var unsubscribe = null, unsubQ = null, signIns = 0;
  if (isNew) {
    x = { name: '', title: '', description: '', body: '', files: [] };
    BOLD.onUser(function(user){
      var mine = ++signIns;
      me = user ? { email: user.email || '' } : null;
      if (user) S.access(function(ok){ if (mine === signIns) { fullWrite = ok; loaded = true; render(); } });
    });
    return;
  }
  if (!ref) { loaded = true; render(); return; }
  BOLD.onUser(function(user){
    var mine = ++signIns;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? { email: user.email || '', name: user.displayName || user.email || '' } : null;
    fullWrite = false;
    if (!user) return;
    if (unsubQ) { unsubQ(); unsubQ = null; }
    unsubQ = ref.collection('proposals').where('status', '==', 'open').onSnapshot(function(snap){
      proposals = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return a.at - b.at; });
      if (!(editing && body.querySelector('.skill-form'))) render();
    }, function(err){ console.error('[BOLD Skills] loading proposed changes failed', err); });
    S.access(function(ok){ if (mine === signIns) { fullWrite = ok; render(); } });
    unsubscribe = ref.onSnapshot(function(snap){
      loaded = true;
      // Don't redraw over a form being filled in.
      var wasEditing = editing && body.querySelector('.skill-form');
      x = snap.exists ? Object.assign({}, snap.data(), { name: name }) : null;
      if (!wasEditing) render();
    }, function(err){
      console.error('[BOLD Skills] loading the skill failed', err);
      loaded = true; x = null; render();
    });
  });
})();
