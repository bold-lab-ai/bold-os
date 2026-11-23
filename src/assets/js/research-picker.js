// "Part of" (#248): choosing what a northstar, moonshot or stepping stone is part of, on the register form
// and a project's page. One picker for both: the candidates from the researchMap callable (research-map.js
// says which level is above which), a box to narrow them, and a tick for each. A stepping stone can also
// choose the problems it explores (the Problem Bank).
(function(){
  'use strict';
  var R = window.BoldResearch, esc = BOLD.escapeHtml;
  var loading = null;

  // The map, once a page (researchMap: { items, problems }).
  function load(fresh){
    if (loading && !fresh) return loading;
    loading = firebase.app().functions('europe-west2').httpsCallable('researchMap')({}).then(function(r){ return r.data || { items: [], problems: [] }; });
    loading.catch(function(){ loading = null; });
    return loading;
  }

  function titleOf(map, pid){ var i = (map.items || []).filter(function(x){ return x.pid === pid; })[0]; return i ? i.title : ''; }

  // The picker for a `level`, inside element `box`: `chosen` { parents, problems }; `self` the project's own id.
  function mount(box, map, level, chosen, self){
    chosen = chosen || {};
    var up = R.parentLevel(level);
    if (!up) { box.innerHTML = '<p class="rp-none">A northstar serves BOLD’s goals (BOLDiquette › Goals).</p>'; return { read: function(){ return { parents: [], problems: [] }; } }; }
    var parents = (chosen.parents || []).slice(), problems = (chosen.problems || []).slice();
    var items = (map.items || []).filter(function(i){ return i.level === up && i.pid !== self; });
    // A moonshot's northstars beside it, so moonshots read in context.
    var above = function(i){ return (i.parents || []).map(function(p){ return titleOf(map, p); }).filter(Boolean).join(', '); };
    items.sort(function(a, b){ return (above(a) + a.title).localeCompare(above(b) + b.title); });
    var probs = level === 'project' ? (map.problems || []).slice().sort(function(a, b){ return a.title.localeCompare(b.title); }) : [];
    var q = '';
    function row(kind, id, title, note){
      var on = (kind === 'parent' ? parents : problems).indexOf(id) >= 0;
      return '<label class="rp-row"><input type="checkbox" data-kind="' + kind + '" value="' + esc(id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="rp-title">' + esc(title) + '</span>' + (note ? '<span class="rp-note">' + esc(note) + '</span>' : '') + '</label>';
    }
    function hit(t){ return !q || q.toLowerCase().split(/\s+/).every(function(w){ return String(t).toLowerCase().indexOf(w) >= 0; }); }
    function draw(){
      var list = items.filter(function(i){ return hit(i.title + ' ' + above(i)) || parents.indexOf(i.pid) >= 0; });
      var plist = probs.filter(function(p){ return hit(p.title) || problems.indexOf(p.id) >= 0; });
      var html = '<div class="rp-head">' + esc(R.PLURAL[up]) + '</div>' +
        (list.length ? list.map(function(i){ return row('parent', i.pid, i.title, up === 'moonshot' ? above(i) : ''); }).join('') : '<p class="rp-none">' + (q ? 'None match.' : 'None yet.') + '</p>');
      if (level === 'project') html += '<div class="rp-head">Or the problems it explores (Problem Bank)</div>' +
        (plist.length ? plist.map(function(p){ return row('problem', p.id, p.title, titleOf(map, p.project)); }).join('') : '<p class="rp-none">' + (q ? 'None match.' : 'None yet.') + '</p>');
      box.querySelector('.rp-list').innerHTML = html;
    }
    box.innerHTML = '<input type="search" class="rp-search" placeholder="Find ' + esc(R.PLURAL[up].toLowerCase()) + (level === 'project' ? ' or problems' : '') + '" aria-label="Find">' +
      '<div class="rp-list"></div>';
    box.querySelector('.rp-search').addEventListener('input', function(e){ q = e.target.value.trim(); draw(); });
    box.querySelector('.rp-list').addEventListener('change', function(e){
      var t = e.target; if (!t || t.type !== 'checkbox') return;
      var list = t.getAttribute('data-kind') === 'parent' ? parents : problems, at = list.indexOf(t.value);
      if (t.checked && at < 0) list.push(t.value); else if (!t.checked && at >= 0) list.splice(at, 1);
    });
    draw();
    return { read: function(){ return { parents: parents.slice(), problems: problems.slice() }; } };
  }

  // What a card is part of, as links (a project's page, Projects).
  function linksHtml(map, card){
    var out = (card.parents || []).map(function(p){
      var i = (map.items || []).filter(function(x){ return x.pid === p; })[0];
      return i ? '<a href="' + esc(href(i)) + '">' + esc(i.title) + '</a>' : '';
    }).filter(Boolean);
    (card.problems || []).forEach(function(id){
      var p = (map.problems || []).filter(function(x){ return x.id === id; })[0];
      if (p) out.push('<a href="problem.html?problem=' + encodeURIComponent(p.id) + '">' + esc(p.title) + '</a> <span class="detail-muted">(problem)</span>');
    });
    return out.join(', ');
  }
  function href(i){ return 'project.html#id=' + encodeURIComponent(i.projectId || i.cardId || i.pid) + (i.boardId ? '&board=' + encodeURIComponent(i.boardId) : ''); }

  window.BoldResearchPicker = { load: load, mount: mount, linksHtml: linksHtml, href: href };
})();
