// The Map (research-map.html, #248): BOLD's northstars, their moonshots, the stepping stones toward
// each and the problems they explore, in columns from left to right, each line a "part of"; and who is
// on what (the people column). Read from researchMap (functions/index.js), drawn as SVG; research-map.js
// builds the graph. Clicking a node lights what it's part of and what it's made of (and, for a person,
// everything they're on), and says what it is below; a double click opens its page.
(function(){
  'use strict';
  var R = window.BoldResearch, esc = BOLD.escapeHtml;
  var graph = document.getElementById('rmGraph');
  if (!graph || !R || !BOLD.getAuth()) return;
  var el = function(id){ return document.getElementById(id); };
  var data = null, selected = '', find = '';
  var show = { problems: true, people: true, proposed: true, completed: false };
  var KEY = 'boldMap:show';
  try { var kept = JSON.parse(localStorage.getItem(KEY) || 'null'); if (kept) Object.keys(show).forEach(function(k){ if (typeof kept[k] === 'boolean') show[k] = kept[k]; }); } catch (e){}

  var COLS = [['northstar', 'Northstars'], ['moonshot', 'Moonshots'], ['project', 'Stepping stones'], ['problem', 'Problems'], ['person', 'People']];
  var ROW = 24, TOP = 40, COL_W = 300, LABEL = 32;

  function hrefOf(n){
    if (n.kind === 'problem') return 'problem.html?problem=' + encodeURIComponent(n.id.replace(/^problem:/, ''));
    if (n.kind === 'person') return '';
    return n.titleOnly ? '' : 'project.html#id=' + encodeURIComponent(n.projectId || n.cardId || n.pid) + (n.boardId ? '&board=' + encodeURIComponent(n.boardId) : '');
  }
  function short(t){ t = String(t || ''); return t.length > LABEL ? t.slice(0, LABEL - 1) + '…' : t; }

  // What's drawn: the map as `show` has it, people added as nodes linked to what they're on.
  function current(){
    var items = (data.items || []).filter(function(i){
      return (show.proposed || i.group !== 'proposed') && (show.completed || i.group !== 'completed');
    });
    var map = R.buildMap(items, show.problems ? data.problems : []);
    // A problem nobody explores, whose project isn't drawn, isn't drawn either.
    var linkedTo = {};
    map.edges.forEach(function(e){ linkedTo[e.from] = linkedTo[e.to] = true; });
    map.nodes = map.nodes.filter(function(n){ return n.kind !== 'problem' || linkedTo[n.id]; });
    if (show.people) {
      var people = {};
      map.nodes.forEach(function(n){
        (n.people || []).forEach(function(name){
          var id = 'person:' + name;
          if (!people[id]) { people[id] = { id: id, kind: 'person', title: name }; map.nodes.push(people[id]); }
          map.edges.push({ from: id, to: n.id, kind: 'member' });
        });
      });
    }
    return map;
  }

  // Columns, ordered so lines cross as little as they can: each node at the mean place of what it's linked
  // to in the column before (then after, then before again); nothing linked, at the end, by title.
  function layout(map){
    var cols = COLS.filter(function(c){ return c[0] !== 'problem' || show.problems; }).filter(function(c){ return c[0] !== 'person' || show.people; });
    var byCol = {}, nb = {};
    cols.forEach(function(c){ byCol[c[0]] = []; });
    map.nodes.forEach(function(n){ if (byCol[n.kind]) byCol[n.kind].push(n); });
    map.edges.forEach(function(e){ (nb[e.from] = nb[e.from] || []).push(e.to); (nb[e.to] = nb[e.to] || []).push(e.from); });
    Object.keys(byCol).forEach(function(k){ byCol[k].sort(function(a, b){ return String(a.title).localeCompare(String(b.title)); }); });
    var place = {};
    var setPlaces = function(list){ list.forEach(function(n, i){ place[n.id] = i / Math.max(1, list.length - 1 || 1); }); };
    cols.forEach(function(c){ setPlaces(byCol[c[0]]); });
    var order = function(list, ref){
      var score = function(n){
        var xs = (nb[n.id] || []).filter(function(id){ return ref[id]; }).map(function(id){ return place[id]; });
        return xs.length ? xs.reduce(function(a, b){ return a + b; }, 0) / xs.length : 2;
      };
      list.sort(function(a, b){ return score(a) - score(b) || String(a.title).localeCompare(String(b.title)); });
      setPlaces(list);
    };
    var inCol = function(k){ var o = {}; (byCol[k] || []).forEach(function(n){ o[n.id] = true; }); return o; };
    for (var pass = 0; pass < 3; pass++) {
      var seq = pass === 1 ? cols.slice().reverse() : cols;
      for (var i = 1; i < seq.length; i++) order(byCol[seq[i][0]], inCol(seq[i - 1][0]));
    }
    var rows = Math.max.apply(null, cols.map(function(c){ return byCol[c[0]].length; }).concat([1]));
    var H = TOP + rows * ROW + 20, pos = {};
    cols.forEach(function(c, ci){
      var list = byCol[c[0]], step = (H - TOP - 20) / Math.max(1, list.length);
      // Its label's width, roughly (12.5px Cabin; bolder for northstars and moonshots).
      list.forEach(function(n, i){ pos[n.id] = { x: 14 + ci * COL_W, y: TOP + (i + 0.5) * step, w: short(n.title).length * (n.kind === 'northstar' || n.kind === 'moonshot' ? 7.2 : 6.6) }; });
    });
    return { cols: cols, pos: pos, W: cols.length * COL_W + 20, H: H };
  }

  function lit(map){
    if (!selected && !find) return null;
    var on = {};
    if (selected) {
      var core = { nodes: map.nodes, edges: map.edges.filter(function(e){ return e.kind !== 'member'; }) };
      var starts = selected.indexOf('person:') === 0
        ? map.edges.filter(function(e){ return e.kind === 'member' && e.from === selected; }).map(function(e){ return e.to; }) : [selected];
      on[selected] = true;
      starts.forEach(function(s){ var l = R.lineage(core, s); Object.keys(l).forEach(function(k){ on[k] = true; }); });
      // The people of what's selected (not of everything above and below it).
      if (selected.indexOf('person:') !== 0) map.edges.forEach(function(e){ if (e.kind === 'member' && e.to === selected) on[e.from] = true; });
    }
    if (find) {
      var words = find.toLowerCase().split(/\s+/).filter(Boolean);
      map.nodes.forEach(function(n){ var t = String(n.title).toLowerCase(); if (words.every(function(w){ return t.indexOf(w) >= 0; })) on[n.id] = true; });
    }
    return on;
  }

  function draw(){
    if (!data) return;
    var map = current(), L = layout(map), on = lit(map);
    var svg = '<svg class="rm-svg" viewBox="0 0 ' + L.W + ' ' + L.H + '" width="' + L.W + '" height="' + L.H + '" role="img" aria-label="The map of BOLD’s northstars, moonshots and stepping stones">';
    L.cols.forEach(function(c, ci){ svg += '<text class="rm-col" x="' + (14 + ci * COL_W) + '" y="18">' + esc(c[1]) + '</text>'; });
    var lines = '', dots = '';
    map.edges.forEach(function(e){
      var a = L.pos[e.from], b = L.pos[e.to];
      if (!a || !b) return;
      // From where the left one's label ends, to the right one's dot.
      var l = a.x < b.x ? a : b, r = a.x < b.x ? b : a, lx = Math.min(l.x + 14 + l.w, r.x - 60), mid = (lx + r.x) / 2;
      var hot = on && on[e.from] && on[e.to];
      lines += '<path class="rm-edge rm-' + e.kind + (on ? (hot ? ' is-on' : ' is-off') : '') + '" d="M' + lx + ',' + l.y + ' C' + mid + ',' + l.y + ' ' + mid + ',' + r.y + ' ' + r.x + ',' + r.y + '"></path>';
    });
    map.nodes.forEach(function(n){
      var p = L.pos[n.id];
      if (!p) return;
      var cls = 'rm-node rm-' + n.kind + (n.group === 'proposed' ? ' is-proposed' : '') + (n.group === 'completed' ? ' is-completed' : '') +
        (n.kind !== 'person' && n.kind !== 'problem' && n.kind !== 'northstar' && !R.linked(n) ? ' is-unlinked' : '') +
        (on ? (on[n.id] ? ' is-on' : ' is-off') : '') + (selected === n.id ? ' is-selected' : '');
      dots += '<g class="' + cls + '" data-id="' + esc(n.id) + '" transform="translate(' + p.x + ',' + p.y + ')" tabindex="0" role="button">' +
        '<title>' + esc(n.title) + (n.group === 'proposed' ? ' (proposed)' : '') + '</title>' +
        '<circle r="' + (n.kind === 'northstar' ? 7 : n.kind === 'moonshot' ? 6 : 4.5) + '"></circle>' +
        '<text x="10" y="4">' + esc(short(n.title)) + '</text></g>';
    });
    graph.innerHTML = svg + '<g>' + lines + '</g><g>' + dots + '</g></svg>';
    graph.hidden = false;
    el('rmMsg').hidden = true;
    detail(map);
  }

  // Below the map: what's selected, with its links.
  function detail(map){
    var box = el('rmDetail');
    if (!selected) { box.innerHTML = ''; return; }
    var byId = {}; map.nodes.forEach(function(n){ byId[n.id] = n; });
    var n = byId[selected];
    if (!n) { box.innerHTML = ''; return; }
    var link = function(x){ var h = hrefOf(x); return h ? '<a href="' + esc(h) + '">' + esc(x.title) + '</a>' : esc(x.title); };
    var list = function(xs){ return xs.length ? xs.map(link).join(', ') : '<span class="detail-muted">None</span>'; };
    var ups = map.edges.filter(function(e){ return e.from === n.id && e.kind !== 'member'; }).map(function(e){ return byId[e.to]; }).filter(Boolean);
    var downs = map.edges.filter(function(e){ return e.to === n.id && e.kind !== 'member'; }).map(function(e){ return byId[e.from]; }).filter(Boolean);
    var html = '<h2>' + link(n) + '</h2><dl class="rm-dl">';
    if (n.kind === 'person') {
      html += '<dt>On</dt><dd>' + list(map.edges.filter(function(e){ return e.from === n.id; }).map(function(e){ return byId[e.to]; }).filter(Boolean)) + '</dd>';
    } else {
      html += '<dt>Is a</dt><dd>' + esc(n.kind === 'problem' ? 'Problem (Problem Bank)' : R.NAMES[n.kind]) + (n.group === 'proposed' ? ' · proposed' : n.group === 'completed' ? ' · completed' : '') + '</dd>';
      if (n.kind !== 'northstar') html += '<dt>' + (n.kind === 'problem' ? 'Of' : 'Part of') + '</dt><dd>' + (ups.length ? list(ups) : '<span class="level-badge lv-unlinked">Not linked yet</span>') + '</dd>';
      else html += '<dt>Serves</dt><dd><a href="boldiquette.html#our-goals-for-bold">BOLD’s goals</a></dd>';
      if (n.connection) html += '<dt>How</dt><dd>' + esc(n.connection) + '</dd>';
      if (n.kind !== 'problem') html += '<dt>Made of</dt><dd>' + list(downs) + '</dd>';
      if (n.people && n.people.length) html += '<dt>People</dt><dd>' + n.people.map(esc).join(', ') + '</dd>';
      else if (n.titleOnly) html += '<dt>People</dt><dd><span class="detail-muted">Its people see them</span></dd>';
    }
    box.innerHTML = html + '</dl>';
  }

  function controls(){
    var tog = function(k, label){ return '<button type="button" class="view-btn" data-show="' + k + '" aria-pressed="' + show[k] + '">' + label + '</button>'; };
    var people = {};
    (data ? data.items : []).forEach(function(i){ (i.people || []).forEach(function(p){ people[p] = true; }); });
    el('rmControls').innerHTML = '<span class="view-toggle rm-show" role="group" aria-label="Show">' + tog('problems', 'Problems') + tog('people', 'People') + tog('proposed', 'Proposed') + tog('completed', 'Completed') + '</span>' +
      '<select id="rmPerson" aria-label="Someone"><option value="">Someone…</option>' + Object.keys(people).sort().map(function(p){
        return '<option value="person:' + esc(p) + '"' + (selected === 'person:' + p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>' +
      '<input type="search" id="rmFind" placeholder="Find" aria-label="Find" value="' + esc(find) + '">' +
      '<a class="btn-text rm-add" href="projects-register.html#level=northstar">+ Northstar</a>';
    el('rmControls').querySelectorAll('[data-show]').forEach(function(b){ b.addEventListener('click', function(){
      var k = b.getAttribute('data-show'); show[k] = !show[k];
      try { localStorage.setItem(KEY, JSON.stringify(show)); } catch (e){}
      controls(); draw();
    }); });
    el('rmPerson').addEventListener('change', function(e){ selected = e.target.value; if (selected && !show.people) { show.people = true; controls(); } draw(); });
    el('rmFind').addEventListener('input', function(e){ find = e.target.value.trim(); draw(); });
  }

  // A click selects (again: clears); a double click, or Enter, opens its page.
  graph.addEventListener('click', function(e){
    var g = e.target.closest && e.target.closest('.rm-node');
    selected = g ? (selected === g.getAttribute('data-id') ? '' : g.getAttribute('data-id')) : '';
    if (el('rmPerson')) el('rmPerson').value = selected.indexOf('person:') === 0 ? selected : '';
    draw();
  });
  var open = function(id){
    var n = (current().nodes || []).filter(function(x){ return x.id === id; })[0], h = n && hrefOf(n);
    if (h) window.open(h, '_blank', 'noopener');
  };
  graph.addEventListener('dblclick', function(e){ var g = e.target.closest && e.target.closest('.rm-node'); if (g) open(g.getAttribute('data-id')); });
  graph.addEventListener('keydown', function(e){
    var g = e.target.closest && e.target.closest('.rm-node');
    if (!g) return;
    if (e.key === 'Enter') open(g.getAttribute('data-id'));
    if (e.key === ' ') { e.preventDefault(); selected = g.getAttribute('data-id'); draw(); }
  });

  BOLD.onUser(function(user){
    if (!user || data) return;
    firebase.app().functions('europe-west2').httpsCallable('researchMap')({}).then(function(r){
      data = r.data || { items: [], problems: [] };
      if (!(data.items || []).length) { el('rmMsg').textContent = 'Nothing yet.'; return; }
      controls(); draw();
    }).catch(function(err){
      console.error('[BOLD Lab] loading the map failed', err);
      el('rmMsg').textContent = 'Could not load the map.';
    });
  });
})();
