// A document's history — the versions the server records for it
// (<collection>/<id>/versions, see recordVersions in functions/index.js) — as a
// panel any page can show: newest first, who and when, the note, and on click
// what changed since the version before (line by line for text; a list of
// files { path, content } file by file; anything else as JSON). PIs/admins (or
// whoever the page says) can restore a version: the page writes its content
// back, which is recorded as a new version, so history is never rewritten.
//
// BoldHistory.mount(el, { ref, fields: { key: 'Label', … } (shown first, in
// order), flatten: data → { 'Label': text, … } (optional: what to compare, for
// content that isn't one field per label), canRestore: () => bool,
// restore: (version) => Promise }) → { stop }. A version made from someone's
// proposed change (guides) names them too.
window.BoldHistory = (function(){
  var esc = BOLD.escapeHtml;
  var META = ['updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'changeNote', 'proposedBy'];
  var CONTEXT = 3, MAX_LINES = 400, MAX_CELLS = 4e6;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function when(ms){
    var d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Line diff of a and b → [{ op: ' ' | '-' | '+', text }], or null when too big to compare.
  function lineDiff(a, b){
    var A = a === '' ? [] : String(a).split('\n'), B = b === '' ? [] : String(b).split('\n');
    var pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    var suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    var a1 = A.slice(pre, A.length - suf), b1 = B.slice(pre, B.length - suf);
    var n = a1.length, m = b1.length;
    if (n * m > MAX_CELLS) return null;
    // Longest common subsequence, from the end.
    var L = [];
    for (var i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--)
      L[i][j] = a1[i] === b1[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var out = A.slice(0, pre).map(function(t){ return { op: ' ', text: t }; });
    i = 0; j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a1[i] === b1[j]) { out.push({ op: ' ', text: a1[i] }); i++; j++; }
      else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) { out.push({ op: '-', text: a1[i] }); i++; }
      else { out.push({ op: '+', text: b1[j] }); j++; }
    }
    return out.concat(A.slice(A.length - suf).map(function(t){ return { op: ' ', text: t }; }));
  }

  // The changed lines with CONTEXT lines around them; long runs elided.
  function diffHtml(a, b){
    var d = lineDiff(a, b);
    if (!d) return '<p class="hist-note">Too long to compare line by line.</p>';
    var keep = d.map(function(){ return false; });
    d.forEach(function(x, k){ if (x.op !== ' ') for (var c = Math.max(0, k - CONTEXT); c <= Math.min(d.length - 1, k + CONTEXT); c++) keep[c] = true; });
    var html = '', shown = 0, gap = false;
    for (var k = 0; k < d.length; k++) {
      if (!keep[k]) { gap = true; continue; }
      if (shown >= MAX_LINES) { html += '<div class="hist-gap">… and more</div>'; break; }
      if (gap && html) html += '<div class="hist-gap">⋯</div>';
      gap = false;
      var cls = d[k].op === '+' ? 'hist-add' : d[k].op === '-' ? 'hist-del' : 'hist-ctx';
      html += '<div class="' + cls + '"><span class="hist-op">' + (d[k].op === ' ' ? '' : d[k].op) + '</span>' + (esc(d[k].text) || ' ') + '</div>';
      shown++;
    }
    return '<pre class="hist-diff">' + html + '</pre>';
  }

  function isFiles(v){ return Array.isArray(v) && v.every(function(f){ return f && typeof f.path === 'string' && typeof f.content === 'string'; }); }
  function asText(v){ return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2); }

  // What changed from `prev` (null: nothing before) to `cur`, field by field.
  function changesHtml(prev, cur, fields){
    prev = prev || {}; cur = cur || {};
    var keys = Object.keys(fields).concat(Object.keys(prev).concat(Object.keys(cur)).sort())
      .filter(function(k, i, all){ return all.indexOf(k) === i && META.indexOf(k) === -1; });
    var parts = [];
    keys.forEach(function(k){
      var a = prev[k], b = cur[k], label = fields[k] || k;
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (isFiles(a || []) && isFiles(b || [])) {
        var byPath = function(list){ var o = {}; (list || []).forEach(function(f){ o[f.path] = f.content; }); return o; };
        var pa = byPath(a), pb = byPath(b);
        Object.keys(pa).concat(Object.keys(pb)).filter(function(p, i, all){ return all.indexOf(p) === i; }).sort().forEach(function(p){
          if (pa[p] === pb[p]) return;
          var what = !(p in pa) ? 'added' : !(p in pb) ? 'removed' : 'changed';
          parts.push('<div class="hist-field"><p class="hist-label">' + esc(label) + ' · <code>' + esc(p) + '</code> ' + what + '</p>' + diffHtml(pa[p] || '', pb[p] || '') + '</div>');
        });
        return;
      }
      parts.push('<div class="hist-field"><p class="hist-label">' + esc(label) + '</p>' + diffHtml(asText(a), asText(b)) + '</div>');
    });
    return parts.join('') || '<p class="hist-note">No change to the content.</p>';
  }

  function mount(el, opts){
    var fields = opts.fields || {};
    var flat = opts.flatten || function(d){ return d; };
    var versions = [], loaded = false, open = null;

    function who(v){
      return (v.by ? esc(v.by.name || v.by.email) : 'Someone outside the site') +
        (v.proposedBy ? ', proposed by ' + esc(v.proposedBy.name || v.proposedBy.email) : '');
    }
    function kindLabel(v){ return v.kind === 'created' ? 'Added' : v.kind === 'deleted' ? 'Deleted' : 'Edited'; }

    function render(){
      if (!loaded) { el.innerHTML = '<p class="hist-note">Loading…</p>'; return; }
      if (!versions.length) { el.innerHTML = '<p class="hist-note">No changes recorded yet. Changes are kept from 10 October 2026 on.</p>'; return; }
      el.innerHTML = '<ol class="hist-list">' + versions.map(function(v, i){
        var isOpen = v.id === open;
        var restore = i > 0 && v.kind !== 'deleted' && isOpen ?
          '<button type="button" class="btn-text hist-restore"' + (opts.canRestore() ? '' : ' disabled title="You can’t edit this"') + '>Restore this version</button>' : '';
        return '<li class="hist-item' + (isOpen ? ' is-open' : '') + '">' +
          '<button type="button" class="hist-head" data-id="' + esc(v.id) + '" aria-expanded="' + isOpen + '">' +
            '<span class="hist-when">' + when(v.at) + '</span>' +
            '<span class="hist-who">' + kindLabel(v) + ' by ' + who(v) + (i === 0 ? ' · current' : '') + '</span>' +
            (v.note ? '<span class="hist-msg">' + esc(v.note) + '</span>' : '') +
          '</button>' +
          (isOpen ? '<div class="hist-body">' + restore + changesHtml(versions[i + 1] ? flat(versions[i + 1].data) : null, v.kind === 'deleted' ? null : flat(v.data), fields) + '</div>' : '') +
          '</li>';
      }).join('') + '</ol>';
    }

    el.addEventListener('click', function(e){
      var head = e.target.closest('.hist-head');
      if (head) { var id = head.getAttribute('data-id'); open = open === id ? null : id; render(); return; }
      var btn = e.target.closest('.hist-restore');
      if (btn && opts.canRestore()) {
        var v = versions.filter(function(x){ return x.id === open; })[0];
        if (!v || !window.confirm('Restore the version from ' + when(v.at) + '? It becomes the current one; nothing in the history is lost.')) return;
        btn.disabled = true;
        opts.restore(v).then(function(){ open = null; }).catch(function(err){
          console.error('[BOLD History] restoring a version failed', err);
          window.alert('Couldn’t restore that version — try again.');
          btn.disabled = false;
        });
      }
    });

    render();
    var stop = opts.ref.collection('versions').orderBy('at', 'desc').limit(200).onSnapshot(function(snap){
      versions = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      loaded = true;
      render();
    }, function(err){
      console.error('[BOLD History] loading the history failed', err);
      el.innerHTML = '<p class="hist-note">Couldn’t load the history.</p>';
    });
    return { stop: stop, when: when };
  }

  return { mount: mount, when: when, lineDiff: lineDiff, diffHtml: diffHtml, changesHtml: changesHtml };
})();
