// The Map (research-map.html, #248): BOLD's northstars, moonshots and stepping stones, read from researchMap
// (functions/index.js), as Lineage: a board (research-map.js topicBoard), each topic of stepping stones a card
// down either side, the northstars across the top, the moonshots down the middle, linked to what's part of them;
// zoomed with the wheel or the buttons, dragged around. Clicking anything lights everything above and below it
// and says what it is below the map; a double click (or Enter) opens its page. Find lights what matches; Who
// lights what a person is on.
(function(){
  'use strict';
  var R = window.BoldResearch, esc = BOLD.escapeHtml;
  var graph = document.getElementById('rmGraph');
  if (!graph || !R || !BOLD.getAuth()) return;
  var el = function(id){ return document.getElementById(id); };
  var data = null, map = null, selected = '', find = '', person = '';
  var opts = { proposed: true, completed: false };
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
    map = R.buildMap(items, []);
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

  // A node's mark: a northstar a star, a moonshot a diamond, a stepping stone a circle, a problem a triangle.
  function mark(kind, r){
    var f = function(n){ return n.toFixed(1); };
    if (kind === 'northstar') {
      var pts = [];
      for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.48 : r * 1.25; pts.push(f(Math.cos(a) * rr) + ' ' + f(Math.sin(a) * rr)); }
      return '<path class="cx-mark" d="M' + pts.join('L') + 'Z"></path>';
    }
    if (kind === 'moonshot') return '<path class="cx-mark" d="M0 ' + f(-r * 1.3) + 'L' + f(r * 1.3) + ' 0L0 ' + f(r * 1.3) + 'L' + f(-r * 1.3) + ' 0Z"></path>';
    if (kind === 'problem') return '<path class="cx-mark" d="M0 ' + f(-r * 1.2) + 'L' + f(r * 1.15) + ' ' + f(r * 0.85) + 'H' + f(-r * 1.15) + 'Z"></path>';
    return '<circle class="cx-mark" r="' + f(r) + '"></circle>';
  }
  function nodeCls(n, on){
    return 'cx-node rm-' + n.kind + (n.group === 'proposed' ? ' is-proposed' : '') + (n.group === 'completed' ? ' is-completed' : '') +
      (n.kind !== 'problem' && !R.linked(n) ? ' is-unlinked' : '') + (on && on[n.id] ? ' is-lit' : '') + (selected === n.id ? ' is-selected' : '');
  }
  function tip(n){ return esc(n.title + (n.kind === 'problem' ? ' (problem)' : ' · ' + R.NAMES[n.kind]) + ((n.people || []).length ? ' · ' + n.people.join(', ') : '')); }

  /* ---------- Lineage: a board, zoomable ---------- */
  // A board (research-map.js topicBoard): each topic a card listing its stepping stones, cards down both sides,
  // moonshots and northstars in the middle, linked to what's part of them. One unit is one pixel when it all
  // fits, so its text is the page's size; zooming in makes everything bigger.
  var TW = 1200, TH = 800, topic = null, vb = { x: 0, y: 0, w: TW, h: TH };
  function topicData(){
    var items = map.nodes.filter(function(n){ return n.kind !== 'problem'; });
    var width = Math.max(980, Math.round(graph.clientWidth || 1200));
    var key = items.map(function(n){ return n.id; }).join(',') + '|' + width;
    if (topic && topic.key === key) return topic;
    var cl = R.clusters(items.filter(function(n){ return n.kind === 'project'; }));
    var links = map.edges.filter(function(e){ return e.kind === 'part'; });
    var board = R.topicBoard(items, links, cl, width);
    TW = width; TH = Math.max(420, board.h);
    topic = { key: key, cl: cl, board: board, pos: board.pos };
    vb = { x: 0, y: 0, w: TW, h: TH };
    return topic;
  }
  function topicsSvg(){
    var t = topicData(), on = lit(), pos = t.pos, f = function(n){ return n.toFixed(1); };
    var cards = t.board.cards.map(function(c){
      var name = t.cl.clusters[c.j].terms.join(' \u00b7 ');
      return '<g class="rm-card rm-hue-' + HUES[c.j % HUES.length] + '"><rect x="' + f(c.x) + '" y="' + f(c.y) + '" width="' + f(c.w) + '" height="' + f(c.h) + '" rx="6"><title>' + esc(name) + '</title></rect>' +
        '<text class="rm-card-head" x="' + f(c.x + 14) + '" y="' + f(c.y + 22) + '">' + esc(short(name, Math.floor((c.w - 28) / 8.6))) + '</text></g>';
    }).join('');
    // Links: a stepping stone's dot to its moonshot, a moonshot to its northstar, curving across.
    var lines = map.edges.map(function(e){
      if (e.kind !== 'part') return '';
      var p = pos[e.from], q = pos[e.to];
      if (!p || !q) return '';
      var hot = on && on[e.from] && on[e.to], mx = (p.x + q.x) / 2, d;
      if (q.side === 'top') {
        // Up to a northstar: out to one side first (its side, or for the middle one, the moonshot's own turn), then up.
        var dir = q.x < p.x - 1 ? -1 : q.x > p.x + 1 ? 1 : ((p.y / 46 | 0) % 2 ? 1 : -1);
        d = 'M' + f(p.x) + ' ' + f(p.y) + 'C' + f(p.x + dir * 150) + ' ' + f(p.y) + ' ' + f(q.x + dir * 40) + ' ' + f(q.y + 90) + ' ' + f(q.x) + ' ' + f(q.y);
      } else d = 'M' + f(p.x) + ' ' + f(p.y) + 'C' + f(mx) + ' ' + f(p.y) + ' ' + f(mx) + ' ' + f(q.y) + ' ' + f(q.x) + ' ' + f(q.y);
      return '<path class="cx-edge rm-e-part' + (q.side === 'top' ? ' rm-up' : '') + (hot ? ' is-lit' : '') + '" d="' + d + '"></path>';
    }).join('');
    var nodes = map.nodes.map(function(n){
      var p = pos[n.id];
      if (!p) return '';
      var j = t.cl.of[n.id], r = n.kind === 'northstar' ? 9 : n.kind === 'moonshot' ? 6.5 : 4.5;
      // A row's title on its card, away from the middle; a moonshot's toward the middle; a northstar's under it.
      var lx = r + 7, ly = 4.5, anchor = 'start', max = 40;
      if (n.kind === 'project') { anchor = p.side === 'left' ? 'end' : 'start'; lx = p.side === 'left' ? -(r + 7) : r + 7; max = Math.floor((t.board.cards[0] ? t.board.cards[0].w - 34 : 260) / 7.4); }
      else if (n.kind === 'moonshot') { anchor = 'middle'; lx = 0; ly = r + 16; max = Math.max(18, Math.floor((t.board.mid - 40) / 7.6)); }
      else if (n.kind === 'northstar') { anchor = 'middle'; lx = 0; ly = r + 22; max = 40; }
      return '<g class="' + nodeCls(n, on) + (j !== undefined ? ' rm-hue-' + HUES[j % HUES.length] : '') + '" data-id="' + esc(n.id) + '" transform="translate(' + f(p.x) + ',' + f(p.y) + ')" tabindex="0" role="button">' +
        mark(n.kind, r) + '<text class="cx-label" x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '">' + esc(short(n.title, max)) + '</text>' +
        '<title>' + tip(n) + '</title></g>';
    }).join('');
    return '<div class="cx-graph rm-zoom"><div class="rm-zoom-ctl view-toggle" role="group" aria-label="Zoom">' +
      '<button type="button" class="view-btn" data-zoom="in" aria-label="Zoom in">+</button><button type="button" class="view-btn" data-zoom="out" aria-label="Zoom out">\u2212</button>' +
      '<button type="button" class="view-btn" data-zoom="fit" aria-label="Fit it all in">\u2922</button></div>' +
      '<p class="rm-zoom-hint">Scroll to zoom \u00b7 drag to move</p>' +
      '<svg class="cx-svg rm-svg rm-topics' + (on ? ' has-selected' : '') + '" viewBox="' + box() + '" style="height:' + Math.round(TH) + 'px; max-height:80vh"' +
      ' preserveAspectRatio="xMidYMin meet" role="img" aria-label="Stepping stones by topic, with their moonshots and northstars">' +
      '<g>' + cards + '</g><g>' + lines + '</g><g>' + nodes + '</g></svg></div>';
  }
  function box(){ return [vb.x, vb.y, vb.w, vb.h].map(function(v){ return v.toFixed(1); }).join(' '); }
  function setBox(next){
    var w = Math.max(TW / 6, Math.min(TW * 1.5, next.w)), h = w * TH / TW;
    vb = { x: next.x + (next.w - w) / 2, y: next.y + (next.h - h) / 2, w: w, h: h };
    var svg = graph.querySelector('.rm-topics');
    if (svg) svg.setAttribute('viewBox', box());
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
    var ox = (b.width - vb.w * s) / 2, oy = 0;   // xMidYMin
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
    graph.innerHTML = topicsSvg();
    graph.hidden = false;
    el('rmMsg').hidden = true;
    legend();
    detail();
  }
  // What's lit changed: Topics keeps where it's zoomed to.
  function relight(){
    if (!map) return draw();
    var keep = vb;
    graph.innerHTML = topicsSvg();
    setBox(keep);
    detail();
  }

  function legend(){
    var key = function(kind, text){ return '<span class="cx-key"><svg class="cx-icon rm-' + kind + '" viewBox="-8 -8 16 16" aria-hidden="true">' + mark(kind, 5) + '</svg><span>' + text + '</span></span>'; };
    var html = '<div class="cx-bar cx-legend"><span class="cx-bar-row"><span class="cx-bar-label">Key</span><span class="cx-bar-items">' +
      key('northstar', 'Northstar') + key('moonshot', 'Moonshot') + key('project', 'Stepping stone') +
      '</span></span>';
    if (topic) html += '<span class="cx-bar-row"><span class="cx-bar-label">Topics</span><span class="cx-bar-items">' + topic.cl.clusters.map(function(c, j){
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
    if (topic && topic.cl.of[n.id] !== undefined) html += '<dt>Topic</dt><dd>' + esc(topic.cl.clusters[topic.cl.of[n.id]].terms.join(', ')) + '</dd>';
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
      C.pair('Show', '<span class="view-toggle cx-seg cx-multi" role="group" aria-label="Show">' + tog('proposed', 'Proposed') + tog('completed', 'Completed') + '</span>') +
      '</div><div class="cx-ctl-row">' +
      C.pair('Find', '<input type="search" class="cx-field cx-find" id="rmFind" placeholder="A title or keyword" value="' + esc(find) + '">') +
      C.pair('Who', '<select class="cx-field" id="rmPerson"><option value="">Everyone</option>' + Object.keys(people).sort().map(function(p){
        return '<option value="' + esc(p) + '"' + (person === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>') +
      '<a class="btn-text rm-add" href="projects-register.html#level=northstar">+ Northstar</a></div>';
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
