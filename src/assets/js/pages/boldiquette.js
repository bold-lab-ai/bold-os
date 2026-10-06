// BOLDiquette's Google Doc snapshots, per-user read point and text diff.
// The checked-in article remains visible without JS or before first sync.
(function(){
  'use strict';
  var BOLD = window.BOLD;
  if (!BOLD || !window.firebase || !firebase.firestore) return;

  var demo = BOLD.isLocal && new URLSearchParams(location.search).get('demo') === '1';
  var names = demo
    ? { meta:'boldiquetteDemoMeta', versions:'boldiquetteDemoVersions', views:'boldiquetteDemoViews' }
    : { meta:'boldiquetteMeta', versions:'boldiquetteVersions', views:'boldiquetteViews' };
  var bar = document.getElementById('boldVersionBar');
  var status = document.getElementById('boldVersionStatus');
  var actions = document.getElementById('boldVersionActions');
  var error = document.getElementById('boldVersionError');
  var readTab = document.getElementById('boldReadTab');
  var changesTab = document.getElementById('boldChangesTab');
  var readPanel = document.getElementById('boldReadPanel');
  var changesPanel = document.getElementById('boldChangesPanel');
  var markRead = document.getElementById('boldMarkRead');
  var article = document.getElementById('boldArticle');
  var toc = document.getElementById('boldToc');
  var compare = document.getElementById('boldCompareFrom');
  var summary = document.getElementById('boldChangesSummary');
  var diff = document.getElementById('boldDiff');
  var demoControls = document.getElementById('boldDemoControls');
  var initialArticle = article.innerHTML;
  var db = null, user = null, latest = null, meta = null, readPoint = null;
  var history = [], cache = {}, selectedFrom = '', unwatchMeta = null, unwatchRead = null;
  var diffRequest = 0, activeView = 'read';

  function esc(value){ return BOLD.escapeHtml(value); }
  function dateLabel(value){
    if (!value) return 'unknown time';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
  }
  function showError(message){ error.textContent = message; error.hidden = !message; }
  function fromFirstSection(html){
    var first = html.indexOf('<h2 ');
    return first < 0 ? html : html.slice(first);
  }
  function sectionBlocks(blocks){
    var first = (blocks || []).findIndex(function(block){ return block.type === 'h2'; });
    return first < 0 ? (blocks || []) : blocks.slice(first);
  }
  function showView(view){
    activeView = view;
    readPanel.hidden = view !== 'read';
    changesPanel.hidden = view !== 'changes';
    readTab.classList.toggle('is-active', view === 'read');
    changesTab.classList.toggle('is-active', view === 'changes');
    readTab.setAttribute('aria-selected', String(view === 'read'));
    changesTab.setAttribute('aria-selected', String(view === 'changes'));
    if (view === 'changes') renderChanges();
  }
  function stopWatching(){
    if (unwatchMeta) { unwatchMeta(); unwatchMeta = null; }
    if (unwatchRead) { unwatchRead(); unwatchRead = null; }
    diffRequest++;
  }
  function renderStatus(){
    if (!latest) {
      status.textContent = demo
        ? 'Fictional demo versions are not seeded yet. Run the local seed.'
        : 'No synchronized version is available yet. This is the checked-in copy; use the live Google Doc link above for the latest text.';
      actions.hidden = true;
      return;
    }
    var checked = meta && meta.lastCheckedAt ? ' · last checked ' + dateLabel(meta.lastCheckedAt) : '';
    status.textContent = (demo ? 'Fictional local demo' : 'BOLD.OS copy of the Google Doc') +
      ' · captured ' + dateLabel(latest.capturedAt) + checked;
    actions.hidden = false;
    markRead.disabled = !!readPoint && readPoint.lastReadVersion === latest.hash;
    markRead.textContent = markRead.disabled ? 'Marked as read' : 'Mark as read';
  }
  function structureArticle(){
    var headings = Array.prototype.slice.call(article.querySelectorAll('h2,h3,h4'));
    var groups = [], group = null;
    headings.forEach(function(heading){
      if (!heading.id) return;
      if (heading.tagName === 'H2') {
        group = { heading:heading, children:[] };
        groups.push(group);
      } else if (heading.tagName === 'H3' && group) {
        group.children.push(heading);
      }
    });
    toc.innerHTML = '<p class="toc-label">On this page</p><div class="bold-toc-groups">' + groups.map(function(item){
      return '<details class="bold-toc-group"><summary>' + esc(item.heading.textContent.trim()) + '</summary>' +
        '<ol><li><a href="#' + esc(item.heading.id) + '">Go to section</a></li>' + item.children.map(function(child){
          return '<li><a href="#' + esc(child.id) + '">' + esc(child.textContent.trim()) + '</a></li>';
        }).join('') + '</ol></details>';
    }).join('') + '</div>';
    toc.hidden = !latest || !groups.length;

    var root = document.createDocumentFragment(), stack = [];
    Array.prototype.slice.call(article.childNodes).forEach(function(node){
      var level = node.nodeType === 1 && /^H[2-4]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
      if (level) {
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        var details = document.createElement('details');
        details.className = 'bold-section bold-section-level-' + level;
        details.open = level === 2;
        var summaryNode = document.createElement('summary');
        summaryNode.appendChild(node);
        details.appendChild(summaryNode);
        var content = document.createElement('div');
        content.className = 'bold-section-content';
        details.appendChild(content);
        (stack.length ? stack[stack.length - 1].content : root).appendChild(details);
        stack.push({ level:level, content:content });
      } else {
        (stack.length ? stack[stack.length - 1].content : root).appendChild(node);
      }
    });
    article.appendChild(root);
  }
  function renderArticle(){
    if (!latest) article.innerHTML = initialArticle;
    else {
    // Snapshot HTML is generated by the server's allowlist sanitizer; users
    // cannot write version documents through Firestore Security Rules.
      // Older snapshots may include the Doc's cover and page-number contents.
      article.innerHTML = fromFirstSection(latest.html);
    }
    structureArticle();
  }
  function renderCompareOptions(){
    var readId = readPoint && readPoint.lastReadVersion;
    var firstLabel = readId ? 'Last marked as read (' + dateLabel(readPoint.readAt) + ')' : 'No read point yet';
    compare.innerHTML = '<option value="">' + esc(firstLabel) + '</option>' + history
      .filter(function(item){ return latest && item.id !== latest.hash; })
      .map(function(item){ return '<option value="' + esc(item.id) + '">' + esc(dateLabel(item.capturedAt)) + '</option>'; }).join('');
    compare.value = selectedFrom;
    if (compare.value !== selectedFrom) { selectedFrom = ''; compare.value = ''; }
  }
  function blockKey(block){ return (block.type || '') + '\u0000' + (block.text || ''); }
  function diffBlocks(before, after){
    var old = before || [], current = after || [];
    var rows = new Array(old.length + 1);
    for (var i = 0; i <= old.length; i++) rows[i] = new Uint16Array(current.length + 1);
    for (i = old.length - 1; i >= 0; i--){
      for (var j = current.length - 1; j >= 0; j--){
        rows[i][j] = blockKey(old[i]) === blockKey(current[j])
          ? 1 + rows[i + 1][j + 1]
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }
    var out = [], a = 0, b = 0;
    while (a < old.length || b < current.length){
      if (a < old.length && b < current.length && blockKey(old[a]) === blockKey(current[b])){
        out.push({ kind:'same', block:current[b++] }); a++;
      } else if (a < old.length && (b === current.length || rows[a + 1][b] >= rows[a][b + 1])) {
        out.push({ kind:'remove', block:old[a++] });
      } else {
        out.push({ kind:'add', block:current[b++] });
      }
    }
    return out;
  }
  function isHeading(block){ return /^h[2-6]$/.test(block.type || ''); }
  function highlightWords(before, after){
    var old = before.match(/\s+|[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu) || [];
    var current = after.match(/\s+|[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu) || [];
    var rows = new Array(old.length + 1);
    for (var i = 0; i <= old.length; i++) rows[i] = new Uint16Array(current.length + 1);
    for (i = old.length - 1; i >= 0; i--){
      for (var j = current.length - 1; j >= 0; j--){
        rows[i][j] = old[i] === current[j]
          ? 1 + rows[i + 1][j + 1]
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }
    var oldHtml = '', newHtml = '', a = 0, b = 0;
    while (a < old.length || b < current.length){
      if (a < old.length && b < current.length && old[a] === current[b]){
        oldHtml += esc(old[a]); newHtml += esc(current[b]); a++; b++;
      } else if (a < old.length && (b === current.length || rows[a + 1][b] >= rows[a][b + 1])){
        oldHtml += '<mark class="bold-word-remove">' + esc(old[a++]) + '</mark>';
      } else {
        newHtml += '<mark class="bold-word-add">' + esc(current[b++]) + '</mark>';
      }
    }
    return { before:oldHtml, after:newHtml };
  }
  function annotateChangedWords(operations){
    for (var i = 0; i < operations.length; ){
      if (operations[i].kind === 'same') { i++; continue; }
      var hunk = [];
      while (i < operations.length && operations[i].kind !== 'same') hunk.push(operations[i++]);
      var removed = hunk.filter(function(op){ return op.kind === 'remove'; });
      var added = hunk.filter(function(op){ return op.kind === 'add'; });
      for (var j = 0; j < Math.min(removed.length, added.length); j++){
        if (isHeading(removed[j].block) || isHeading(added[j].block)) continue;
        var marked = highlightWords(removed[j].block.text, added[j].block.text);
        removed[j].highlight = marked.before;
        added[j].highlight = marked.after;
      }
    }
  }
  function paintDiff(operations){
    annotateChangedWords(operations);
    var added = 0, removed = 0, section = '', lastSection = '', html = '';
    operations.forEach(function(op){
      if (op.kind === 'same') {
        if (isHeading(op.block)) section = op.block.text;
        return;
      }
      if (section && section !== lastSection){
        html += '<div class="bold-diff-context">' + esc(section) + '</div>';
        lastSection = section;
      }
      if (op.kind === 'add') added++; else removed++;
      html += '<div class="bold-diff-line is-' + op.kind + '"><span class="bold-diff-sign" aria-hidden="true">' +
        (op.kind === 'add' ? '+' : '−') + '</span><span><span class="sr-only">' +
        (op.kind === 'add' ? 'Added: ' : 'Removed: ') + '</span>' + (op.highlight || esc(op.block.text)) + '</span></div>';
      if (isHeading(op.block)) section = op.block.text;
    });
    diff.innerHTML = html || '<p class="bold-diff-empty">No text changes between these versions.</p>';
    summary.textContent = html ? added + ' added · ' + removed + ' removed' : 'No text changes between these versions.';
  }
  function versionById(id){
    if (cache[id]) return Promise.resolve(cache[id]);
    return db.collection(names.versions).doc(id).get().then(function(doc){
      if (!doc.exists) throw new Error('An earlier version is no longer available.');
      cache[id] = doc.data();
      return cache[id];
    });
  }
  function renderChanges(){
    var request = ++diffRequest;
    if (!latest) { summary.textContent = 'No synchronized version is available yet.'; diff.innerHTML = ''; return; }
    var from = selectedFrom || (readPoint && readPoint.lastReadVersion);
    if (!from) {
      summary.textContent = 'First visit: mark this version as read to start tracking later changes, or choose an earlier version above.';
      diff.innerHTML = '';
      return;
    }
    if (from === latest.hash) {
      summary.textContent = 'You are up to date.';
      diff.innerHTML = '<p class="bold-diff-empty">No changes since you marked this version as read.</p>';
      return;
    }
    summary.textContent = 'Comparing versions…';
    versionById(from).then(function(previous){
      if (request !== diffRequest) return;
      paintDiff(diffBlocks(sectionBlocks(previous.blocks), sectionBlocks(latest.blocks)));
    }).catch(function(err){
      if (request !== diffRequest) return;
      summary.textContent = 'Could not load the earlier version.';
      diff.innerHTML = '<p class="bold-diff-empty">' + esc(err.message || String(err)) + '</p>';
    });
  }
  function loadHistory(){
    return db.collection(names.versions).orderBy('capturedAt', 'desc').limit(30).get().then(function(snap){
      history = snap.docs.map(function(doc){ return { id:doc.id, capturedAt:doc.data().capturedAt }; });
      renderCompareOptions();
      if (demo) renderDemoControls();
    });
  }
  function renderDemoControls(){
    if (!BOLD.isLocal) return;
    demoControls.hidden = false;
    if (!demo){
      demoControls.innerHTML = '<a href="boldiquette.html?demo=1">Try the fictional version-history demo</a>';
      return;
    }
    demoControls.innerHTML = '<span class="bold-demo-label">Fictional local demo</span>' +
      '<button type="button" id="boldDemoEarlier">Pretend I last read the earlier demo version</button>' +
      ' · <a href="boldiquette.html">Return to BOLDiquette</a>';
    var button = document.getElementById('boldDemoEarlier');
    button.addEventListener('click', function(){
      var earlier = history.filter(function(item){ return latest && item.id !== latest.hash; }).pop();
      if (!earlier || !user) return;
      db.collection(names.views).doc(user.uid).set({ lastReadVersion:earlier.id, readAt:earlier.capturedAt })
        .then(function(){ showView('changes'); })
        .catch(function(err){ showError('Could not set demo read point: ' + (err.message || String(err))); });
    });
  }
  function start(signedIn){
    stopWatching();
    user = signedIn;
    latest = null; meta = null; readPoint = null; history = []; cache = {}; selectedFrom = '';
    renderArticle(); renderStatus(); renderCompareOptions(); showError('');
    bar.hidden = false;
    try { db = firebase.firestore(BOLD.getApp()); }
    catch (err) { showError('Could not connect to BOLD.OS data.'); return; }
    renderDemoControls();
    unwatchRead = db.collection(names.views).doc(user.uid).onSnapshot(function(snap){
      readPoint = snap.exists ? snap.data() : null;
      renderStatus(); renderCompareOptions(); if (activeView === 'changes') renderChanges();
    }, function(err){ showError('Could not load your read point: ' + (err.message || String(err))); });
    unwatchMeta = db.collection(names.meta).doc('current').onSnapshot(function(snap){
      meta = snap.exists ? snap.data() : null;
      if (!meta || !meta.latestVersion){ latest = null; renderArticle(); renderStatus(); return; }
      // The scheduler refreshes lastCheckedAt every five minutes. Keep the
      // article and the user's place in it when its content has not changed.
      if (latest && latest.hash === meta.latestVersion) { renderStatus(); return; }
      versionById(meta.latestVersion).then(function(version){
        if (!user || !meta || meta.latestVersion !== version.hash) return;
        latest = version;
        renderArticle(); renderStatus();
        loadHistory().catch(function(err){ showError('Could not load version history: ' + (err.message || String(err))); });
        if (activeView === 'changes') renderChanges();
      }).catch(function(err){ showError('Could not load the latest BOLDiquette version: ' + (err.message || String(err))); });
    }, function(err){ showError('Could not check BOLDiquette updates: ' + (err.message || String(err))); });
  }

  readTab.addEventListener('click', function(){ showView('read'); });
  changesTab.addEventListener('click', function(){ showView('changes'); });
  compare.addEventListener('change', function(){ selectedFrom = compare.value; renderChanges(); });
  toc.addEventListener('click', function(event){
    var link = event.target.closest('a[href^="#"]');
    if (!link) return;
    var target = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
    if (!target) return;
    for (var parent = target.parentElement; parent; parent = parent.parentElement){
      if (parent.matches('details.bold-section')) parent.open = true;
    }
  });
  markRead.addEventListener('click', function(){
    if (!db || !user || !latest) return;
    markRead.disabled = true;
    db.collection(names.views).doc(user.uid).set({ lastReadVersion:latest.hash, readAt:Date.now() })
      .then(function(){
        selectedFrom = '';
        renderCompareOptions();
        if (activeView === 'changes') renderChanges();
        showError('');
      })
      .catch(function(err){ markRead.disabled = false; showError('Could not save your read point: ' + (err.message || String(err))); });
  });
  BOLD.onUser(function(signedIn){
    if (signedIn) start(signedIn);
    else { stopWatching(); user = null; bar.hidden = true; latest = null; renderArticle(); }
  });
})();
