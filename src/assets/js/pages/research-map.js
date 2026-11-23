// The Map (research-map.html, #248): BOLD's northstars, moonshots, stepping stones and the problems they
// explore, read from researchMap (functions/index.js), in two views drawn as Network's are (connections.js's
// classes, bold.css):
// - Lineage: a tree, as People › Network › Lineage: each northstar, its moonshots under it, their stepping
//   stones under those (one under several is shown under each), and what isn't linked yet at the end; who is
//   on each beside it.
// - Topics: everything clustered by what it's about (its keywords, title and abstract: research-map.js), each
//   cluster named by its words; zoom with the wheel or the buttons, drag to move around.
// Clicking anything lights everything above and below it and says what it is below the map; a double click
// (or Enter) opens its page. Find lights what matches; Who lights what a person is on.
(function(){
  'use strict';
  var R = window.BoldResearch, esc = BOLD.escapeHtml;
  var graph = document.getElementById('rmGraph');
  if (!graph || !R || !BOLD.getAuth()) return;
  var el = function(id){ return document.getElementById(id); };
  var data = null, map = null, selected = '', find = '', person = '';
  var opts = { view: 'lineage', problems: true, people: true, proposed: true, completed: false };
  var KEY = 'boldMap:opts';
  try { var kept = JSON.parse(localStorage.getItem(KEY) || 'null'); if (kept) Object.keys(opts).forEach(function(k){ if (typeof kept[k] === typeof opts[k]) opts[k] = kept[k]; }); } catch (e){}
  var save = function(){ try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch (e){} };
  var HUES = ['accent', 'teal', 'plum', 'amber', 'green', 'brown', 'danger-text'];

  function hrefOf(n){
    if (!n) return '';
    if (n.kind === 'problem') return 'problem.html?problem=' + encodeURIComponent(n.id.replace(/^problem:/, ''));
    return n.titleOnly ? '' : 'project.html#id=' + encodeURIComponent(n.projectId || n.cardId || n.pid) + (n.boardId ? '&board=' + encodeURIComponent(n.boardId) : '');
  }
  function short(t, max){ t = String(t || ''); return t.length > max ? t.slice(0, max - 1) + '…' : t; }

  // What's shown, as the toggles have it.
  function build(){
    var items = (data.items || []).filter(function(i){ return (opts.proposed || i.group !== 'proposed') && (opts.completed || i.group !== 'completed'); });
    map = R.buildMap(items, opts.problems ? data.problems : []);
    var linked = {};
    map.edges.forEach(function(e){ linked[e.from] = linked[e.to] = true; });
    map.nodes = map.nodes.filter(function(n){ return n.kind !== 'problem' || linked[n.id]; });
    map.byId = {};
    map.nodes.forEach(function(n){ map.byId[n.id] = n; });
  }

  // What's lit: everything above and below the chosen one (for someone, everything they're on, and above and
  // below that), and whatever Find matches. null: nothing chosen, everything as it is.
  function lit(){
    if (!selected && !find && !person) return null;
    var on = {};
    var from = function(id){ Object.keys(R.lineage(map, id)).forEach(function(k){ on[k] = true; }); };
    if (selected && map.byId[selected]) from(selected);
    if (person) map.nodes.forEach(function(n){ if ((n.people || []).indexOf(person) >= 0) from(n.id); });
    if (find) {
      var ws = find.toLowerCase().split(/\s+/).filter(Boolean);
      map.nodes.forEach(function(n){ var t = (n.title + ' ' + (n.keywords || []).join(' ')).toLowerCase(); if (ws.every(function(w){ return t.indexOf(w) >= 0; })) on[n.id] = true; });
    }
    return on;
  }

  // A node's mark: a northstar a star, a moonshot a diamond, a stepping stone a square, a problem a triangle.
  function mark(kind, r){
    var f = function(n){ return n.toFixed(1); };
    if (kind === 'northstar') {
      var pts = [];
      for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.48 : r * 1.25; pts.push(f(Math.cos(a) * rr) + ' ' + f(Math.sin(a) * rr)); }
      return '<path class="cx-mark" d="M' + pts.join('L') + 'Z"></path>';
    }
    if (kind === 'moonshot') return '<path class="cx-mark" d="M0 ' + f(-r * 1.3) + 'L' + f(r * 1.3) + ' 0L0 ' + f(r * 1.3) + 'L' + f(-r * 1.3) + ' 0Z"></path>';
    if (kind === 'problem') return '<path class="cx-mark" d="M0 ' + f(-r * 1.2) + 'L' + f(r * 1.15) + ' ' + f(r * 0.85) + 'H' + f(-r * 1.15) + 'Z"></path>';
    return '<rect class="cx-mark" x="' + f(-r * 0.9) + '" y="' + f(-r * 0.9) + '" width="' + f(r * 1.8) + '" height="' + f(r * 1.8) + '"></rect>';
  }
  function nodeCls(n, on){
    return 'cx-node rm-' + n.kind + (n.group === 'proposed' ? ' is-proposed' : '') + (n.group === 'completed' ? ' is-completed' : '') +
      (n.kind !== 'problem' && !R.linked(n) ? ' is-unlinked' : '') + (on && on[n.id] ? ' is-lit' : '') + (selected === n.id ? ' is-selected' : '');
  }
  function peopleText(n){
    if (!opts.people || !(n.people || []).length) return '';
    var p = n.people;
    return p.slice(0, 4).join(', ') + (p.length > 4 ? ' +' + (p.length - 4) : '');
  }
  function tip(n){ return esc(n.title + (n.kind === 'problem' ? ' (problem)' : ' · ' + R.NAMES[n.kind]) + ((n.people || []).length ? ' · ' + n.people.join(', ') : '')); }

  /* ---------- Lineage: a tree, as People's ---------- */
  function lineageSvg(){
    var on = lit(), kids = {}, rows = [];
    // Under each: what's part of it, and a stepping stone's problems (those it explores and those of its own).
    map.edges.forEach(function(e){ var up = e.kind === 'explores' ? e.from : e.to, down = e.kind === 'explores' ? e.to : e.from; (kids[up] = kids[up] || []).push(down); });
    var byTitle = function(a, b){ return String(map.byId[a].title).localeCompare(String(map.byId[b].title)); };
    var shown = {};
    var walk = function(id, depth, parent){
      var again = !!shown[id];
      rows.push({ id: id, depth: depth, parent: parent, again: again });
      shown[id] = true;
      if (!again) { var at = rows.length - 1; (kids[id] || []).slice().sort(byTitle).forEach(function(c){ walk(c, depth + 1, at); }); }
    };
    var of = function(kind){ return map.nodes.filter(function(n){ return n.kind === kind; }).map(function(n){ return n.id; }).sort(byTitle); };
    of('northstar').forEach(function(id){ walk(id, 0, -1); });
    // What isn't under anything yet, under "Not linked yet" (and a problem whose project isn't shown, at the end too).
    var rest = of('moonshot').concat(of('project'), of('problem')).filter(function(id){ return !shown[id]; });
    if (rest.length) {
      rows.push({ head: 'Not linked yet', depth: 0, parent: -1 });
      var at = rows.length - 1;
      rest.forEach(function(id){ if (!shown[id]) walk(id, 1, at); });
    }
    if (!rows.length) return '<p class="proj-msg">Nothing yet.</p>';
    var COL = 34, ROW = 26, TOP = 16;
    var width = rows.reduce(function(w, r){
      var n = r.head ? null : map.byId[r.id], extra = n ? peopleText(n).length * 6.5 : 0;
      return Math.max(w, 24 + r.depth * COL + 14 + (r.head ? r.head.length : String(n.title).length) * 8 + (extra ? 16 + extra : 0));
    }, 0);
    var W = Math.max(760, Math.ceil(width) + 20), H = TOP + rows.length * ROW + 10;
    rows.forEach(function(r, i){ r.x = 24 + r.depth * COL; r.y = TOP + i * ROW + ROW / 2; });
    var lines = rows.map(function(r){
      if (r.parent < 0) return '';
      var p = rows[r.parent], hot = on && !p.head && on[p.id] && on[r.id];
      return '<path class="cx-edge cx-elbow' + (hot ? ' is-lit' : '') + '" d="M' + p.x + ' ' + (p.y + 7) + 'V' + r.y + 'H' + (r.x - 9) + '"></path>';
    }).join('');
    var nodes = rows.map(function(r){
      if (r.head) return '<g class="rm-head" transform="translate(' + r.x + ',' + r.y + ')"><text class="cx-label rm-head-label" x="-6" y="4">' + esc(r.head) + '</text></g>';
      var n = map.byId[r.id], who = peopleText(n);
      return '<g class="' + nodeCls(n, on) + (r.again ? ' is-again' : '') + '" data-id="' + esc(n.id) + '" transform="translate(' + r.x + ',' + r.y + ')" tabindex="0" role="button">' +
        mark(n.kind, n.kind === 'northstar' ? 7 : n.kind === 'moonshot' ? 6 : 5) +
        '<text class="cx-label" x="13" y="4">' + esc(n.title) +
        (n.group === 'proposed' ? '<tspan class="cx-how" dx="8">proposed</tspan>' : '') +
        (r.again ? '<tspan class="cx-how" dx="8">also above</tspan>' : '') +
        (who && !r.again ? '<tspan class="cx-moves" dx="10">' + esc(who) + '</tspan>' : '') + '</text>' +
        '<title>' + tip(n) + '</title></g>';
    }).join('');
    return '<div class="cx-graph cx-scroll"><svg class="cx-svg cx-lineage rm-svg' + (on ? ' has-selected' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" style="min-width:' + Math.min(W, 1100) + 'px" role="img" aria-label="Northstars, their moonshots and their stepping stones">' +
      lines + nodes + '</svg></div>';
  }

  /* ---------- Topics: clustered by what they're about, zoomable ---------- */
  var TW = 1400, TH = 950, topic = null, vb = { x: 0, y: 0, w: TW, h: TH };
  function topicData(){
    var items = map.nodes.filter(function(n){ return n.kind !== 'problem'; });
    var key = items.map(function(n){ return n.id; }).join(',') + '|' + map.nodes.length;
    if (topic && topic.key === key) return topic;
    // Only the stepping stones are clustered; moonshots and northstars sit among what's linked to them.
    var cl = R.clusters(items.filter(function(n){ return n.kind === 'project'; })), links = map.edges.filter(function(e){ return e.kind === 'part'; });
    topic = { key: key, cl: cl, pos: R.topicLayout(items, links, cl, TW, TH) };
    // A problem beside what it belongs to.
    map.nodes.forEach(function(n){
      if (n.kind !== 'problem') return;
      var e = map.edges.filter(function(x){ return x.from === n.id || x.to === n.id; })[0], o = e && topic.pos[e.from === n.id ? e.to : e.from];
      if (o) topic.pos[n.id] = { x: o.x + 24, y: o.y + 18 };
    });
    vb = { x: 0, y: 0, w: TW, h: TH };
    return topic;
  }
  function topicsSvg(){
    var t = topicData(), on = lit(), pos = t.pos;
    var hulls = t.cl.clusters.map(function(c, j){
      if (!c.size) return '';
      return '<g class="rm-cluster rm-hue-' + HUES[j % HUES.length] + '"><circle cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) + '" r="' + c.r.toFixed(1) + '"></circle>' +
        '<text x="' + c.x.toFixed(1) + '" y="' + (c.y - c.r - 8).toFixed(1) + '" text-anchor="middle">' + esc(c.terms.join(' · ')) + '</text></g>';
    }).join('');
    var lines = map.edges.map(function(e){
      var p = pos[e.from], q = pos[e.to];
      if (!p || !q) return '';
      var hot = on && on[e.from] && on[e.to];
      return '<path class="cx-edge rm-e-' + e.kind + (hot ? ' is-lit' : '') + '" d="M' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + 'L' + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + '"></path>';
    }).join('');
    var nodes = map.nodes.map(function(n){
      var p = pos[n.id];
      if (!p) return '';
      var j = t.cl.of[n.id], loud = n.kind === 'northstar' || n.kind === 'moonshot';
      var r = n.kind === 'northstar' ? 9 : n.kind === 'moonshot' ? 7 : 5;
      return '<g class="' + nodeCls(n, on) + (j !== undefined ? ' rm-hue-' + HUES[j % HUES.length] : '') + '" data-id="' + esc(n.id) + '" transform="translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')" tabindex="0" role="button">' +
        mark(n.kind, r) + '<text class="cx-label' + (loud ? ' rm-loud' : ' is-quiet') + '" x="' + (r + 5) + '" y="4">' + esc(short(n.title, loud ? 34 : 44)) + '</text>' +
        '<title>' + tip(n) + '</title></g>';
    }).join('');
    return '<div class="cx-graph rm-zoom"><div class="rm-zoom-ctl view-toggle" role="group" aria-label="Zoom">' +
      '<button type="button" class="view-btn" data-zoom="in" aria-label="Zoom in">+</button><button type="button" class="view-btn" data-zoom="out" aria-label="Zoom out">−</button>' +
      '<button type="button" class="view-btn" data-zoom="fit">Fit</button></div>' +
      '<svg class="cx-svg rm-svg rm-topics' + (on ? ' has-selected' : '') + (TW / vb.w > 1.6 ? ' is-near' : '') + '" viewBox="' + box() +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Everything, clustered by what it’s about">' +
      '<g>' + hulls + '</g><g>' + lines + '</g><g>' + nodes + '</g></svg></div>';
  }
  function box(){ return [vb.x, vb.y, vb.w, vb.h].map(function(v){ return v.toFixed(1); }).join(' '); }
  function setBox(next){
    var w = Math.max(160, Math.min(TW * 1.5, next.w)), h = w * TH / TW;
    vb = { x: next.x + (next.w - w) / 2, y: next.y + (next.h - h) / 2, w: w, h: h };
    var svg = graph.querySelector('.rm-topics');
    if (!svg) return;
    svg.setAttribute('viewBox', box());
    // Close enough in, every label shows.
    svg.classList.toggle('is-near', TW / vb.w > 1.6);
  }
  // Zooms by `f` around a point in the map's units (its middle when none).
  function zoomBy(f, px, py){
    if (px === undefined) { px = vb.x + vb.w / 2; py = vb.y + vb.h / 2; }
    var w = vb.w / f, h = vb.h / f;
    setBox({ x: px - (px - vb.x) * w / vb.w, y: py - (py - vb.y) * h / vb.h, w: w, h: h });
  }
  // A point on screen in the map's units, and how many screen pixels make one of them.
  function toMap(svg, cx, cy){
    var b = svg.getBoundingClientRect(), s = Math.min(b.width / vb.w, b.height / vb.h);
    var ox = (b.width - vb.w * s) / 2, oy = (b.height - vb.h * s) / 2;
    return { x: vb.x + (cx - b.left - ox) / s, y: vb.y + (cy - b.top - oy) / s, s: s };
  }
  var drag = null;
  graph.addEventListener('wheel', function(e){
    var svg = e.target.closest && e.target.closest('.rm-topics');
    if (!svg) return;
    e.preventDefault();
    var p = toMap(svg, e.clientX, e.clientY);
    zoomBy(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  graph.addEventListener('pointerdown', function(e){
    var svg = e.target.closest && e.target.closest('.rm-topics');
    if (!svg || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vb: { x: vb.x, y: vb.y, w: vb.w, h: vb.h }, s: toMap(svg, e.clientX, e.clientY).s, moved: false };
  });
  window.addEventListener('pointermove', function(e){
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    graph.classList.add('is-dragging');
    setBox({ x: drag.vb.x - dx / drag.s, y: drag.vb.y - dy / drag.s, w: drag.vb.w, h: drag.vb.h });
  });
  window.addEventListener('pointerup', function(){ if (drag && drag.moved) graph.dataset.dragged = '1'; drag = null; graph.classList.remove('is-dragging'); });

  /* ---------- drawing, the key, the panel, the controls ---------- */
  function draw(){
    if (!data) return;
    build();
    graph.innerHTML = opts.view === 'topics' ? topicsSvg() : lineageSvg();
    graph.hidden = false;
    el('rmMsg').hidden = true;
    legend();
    detail();
  }
  // What's lit changed: Topics keeps where it's zoomed to.
  function relight(){
    if (opts.view !== 'topics' || !map) return draw();
    var keep = vb;
    graph.innerHTML = topicsSvg();
    setBox(keep);
    detail();
  }

  function legend(){
    var key = function(kind, text){ return '<span class="cx-key"><svg class="cx-icon rm-' + kind + '" viewBox="-8 -8 16 16" aria-hidden="true">' + mark(kind, 5) + '</svg><span>' + text + '</span></span>'; };
    var html = '<div class="cx-bar cx-legend"><span class="cx-bar-row"><span class="cx-bar-label">Key</span><span class="cx-bar-items">' +
      key('northstar', 'Northstar') + key('moonshot', 'Moonshot') + key('project', 'Stepping stone') + (opts.problems ? key('problem', 'Problem') : '') +
      '<span class="cx-key rm-key-unlinked">Not linked yet</span></span></span>';
    if (opts.view === 'topics' && topic) html += '<span class="cx-bar-row"><span class="cx-bar-label">Topics</span><span class="cx-bar-items">' + topic.cl.clusters.map(function(c, j){
      return c.size ? '<span class="cx-key rm-hue-' + HUES[j % HUES.length] + '"><svg class="cx-icon" viewBox="-7 -7 14 14" aria-hidden="true"><circle class="rm-swatch" r="5"></circle></svg><span>' + esc(c.terms.join(', ')) + ' (' + c.size + ')</span></span>' : '';
    }).join('') + '</span></span>';
    el('rmLegend').innerHTML = html + '</div>';
  }

  // Below the map: what's chosen, with its links.
  function detail(){
    var box = el('rmDetail'), n = selected && map.byId[selected];
    if (!n) { box.innerHTML = ''; return; }
    var link = function(x){ var h = hrefOf(x); return h ? '<a href="' + esc(h) + '">' + esc(x.title) + '</a>' : esc(x.title); };
    var list = function(xs){ return xs.length ? xs.map(link).join(', ') : '<span class="detail-muted">None</span>'; };
    var ups = map.edges.filter(function(e){ return e.from === n.id; }).map(function(e){ return map.byId[e.to]; }).filter(Boolean);
    var downs = map.edges.filter(function(e){ return e.to === n.id; }).map(function(e){ return map.byId[e.from]; }).filter(Boolean);
    var html = '<h2>' + link(n) + '</h2><dl class="rm-dl">';
    html += '<dt>Is a</dt><dd>' + esc(n.kind === 'problem' ? 'Problem (Problem Bank)' : R.NAMES[n.kind]) + (n.group === 'proposed' ? ' · proposed' : n.group === 'completed' ? ' · completed' : '') + '</dd>';
    if (n.kind === 'northstar') html += '<dt>Serves</dt><dd><a href="boldiquette.html#our-goals-for-bold">BOLD’s goals</a></dd>';
    else html += '<dt>' + (n.kind === 'problem' ? 'Of' : 'Part of') + '</dt><dd>' + (ups.length ? list(ups) : '<span class="level-badge lv-unlinked">Not linked yet</span>') + '</dd>';
    if (n.connection) html += '<dt>How</dt><dd>' + esc(n.connection) + '</dd>';
    if (n.kind !== 'problem') html += '<dt>Made of</dt><dd>' + list(downs) + '</dd>';
    if (topic && opts.view === 'topics' && topic.cl.of[n.id] !== undefined) html += '<dt>Topic</dt><dd>' + esc(topic.cl.clusters[topic.cl.of[n.id]].terms.join(', ')) + '</dd>';
    if ((n.people || []).length) html += '<dt>People</dt><dd>' + n.people.map(esc).join(', ') + '</dd>';
    else if (n.titleOnly) html += '<dt>People</dt><dd><span class="detail-muted">Its people see them</span></dd>';
    box.innerHTML = html + '</dl>';
  }

  function controls(){
    var C = window.BoldConnections;
    var tog = function(k, label){ return '<button type="button" class="view-btn" data-opt="' + k + '" aria-pressed="' + opts[k] + '">' + label + '</button>'; };
    var people = {};
    (data ? data.items : []).forEach(function(i){ (i.people || []).forEach(function(p){ people[p] = true; }); });
    el('rmControls').innerHTML = '<div class="cx-ctl-row">' +
      C.pair('View', '<span class="view-toggle cx-seg" role="group" aria-label="View">' +
        '<button type="button" class="view-btn" data-view="lineage" aria-pressed="' + (opts.view === 'lineage') + '">Lineage</button>' +
        '<button type="button" class="view-btn" data-view="topics" aria-pressed="' + (opts.view === 'topics') + '">Topics</button></span>') +
      C.pair('Show', '<span class="view-toggle cx-seg cx-multi" role="group" aria-label="Show">' + tog('problems', 'Problems') + tog('people', 'People') + tog('proposed', 'Proposed') + tog('completed', 'Completed') + '</span>') +
      '</div><div class="cx-ctl-row">' +
      C.pair('Find', '<input type="search" class="cx-field cx-find" id="rmFind" placeholder="A title or keyword" value="' + esc(find) + '">') +
      C.pair('Who', '<select class="cx-field" id="rmPerson"><option value="">Everyone</option>' + Object.keys(people).sort().map(function(p){
        return '<option value="' + esc(p) + '"' + (person === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>') +
      '<a class="btn-text rm-add" href="projects-register.html#level=northstar">+ Northstar</a></div>';
    el('rmControls').querySelectorAll('[data-view]').forEach(function(b){ b.addEventListener('click', function(){ opts.view = b.getAttribute('data-view'); save(); controls(); draw(); }); });
    el('rmControls').querySelectorAll('[data-opt]').forEach(function(b){ b.addEventListener('click', function(){ var k = b.getAttribute('data-opt'); opts[k] = !opts[k]; save(); controls(); draw(); }); });
    el('rmFind').addEventListener('input', function(e){ find = e.target.value.trim(); relight(); });
    el('rmPerson').addEventListener('change', function(e){ person = e.target.value; relight(); });
  }

  // A click chooses (again: lets go); a double click, or Enter, opens its page; the zoom buttons zoom.
  graph.addEventListener('click', function(e){
    var z = e.target.closest && e.target.closest('[data-zoom]');
    if (z) { var k = z.getAttribute('data-zoom'); if (k === 'fit') setBox({ x: 0, y: 0, w: TW, h: TH }); else zoomBy(k === 'in' ? 1.4 : 1 / 1.4); return; }
    if (graph.dataset.dragged) { delete graph.dataset.dragged; return; }
    var g = e.target.closest && e.target.closest('.cx-node[data-id]');
    selected = g ? (selected === g.getAttribute('data-id') ? '' : g.getAttribute('data-id')) : '';
    relight();
  });
  var open = function(id){ var h = hrefOf(map && map.byId[id]); if (h) window.open(h, '_blank', 'noopener'); };
  graph.addEventListener('dblclick', function(e){ var g = e.target.closest && e.target.closest('.cx-node[data-id]'); if (g) open(g.getAttribute('data-id')); });
  graph.addEventListener('keydown', function(e){
    var g = e.target.closest && e.target.closest('.cx-node[data-id]');
    if (!g) return;
    if (e.key === 'Enter') open(g.getAttribute('data-id'));
    if (e.key === ' ') { e.preventDefault(); selected = g.getAttribute('data-id'); relight(); }
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
