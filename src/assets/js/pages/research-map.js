// The Map (research-map.html, #248): BOLD's northstars, moonshots and stepping stones, read from researchMap
// (functions/index.js), in two views:
// - Lineage: a board (research-map.js topicBoard), each topic of stepping stones a card down either side, the
//   northstars across the top, the moonshots down the middle, linked to what's part of them.
// - Topics, as Prezi: topics, sub-topics and stepping stones as frames within frames (topicTree, frameLayout),
//   flown into with a click, out with Esc or Back, along with the arrows; a stepping stone's card at the bottom.
// Both zoom with the wheel or the buttons and drag around. Clicking anything lights everything above and below it
// and says what it is below the map; a double click (or Enter) opens its page. Find lights what matches; Who
// lights what a person is on.
(function(){
  'use strict';
  var R = window.BoldResearch, esc = BOLD.escapeHtml;
  var graph = document.getElementById('rmGraph');
  if (!graph || !R || !BOLD.getAuth()) return;
  var el = function(id){ return document.getElementById(id); };
  var data = null, map = null, selected = '', find = '', person = '';
  var opts = { view: 'lineage', proposed: true, completed: false };
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
      '<svg class="cx-svg rm-svg rm-topics rm-zoomable' + (on ? ' has-selected' : '') + '" viewBox="' + box() + '" style="height:' + Math.round(TH) + 'px; max-height:80vh"' +
      ' preserveAspectRatio="xMidYMin meet" role="img" aria-label="Stepping stones by topic, with their moonshots and northstars">' +
      '<g>' + cards + '</g><g>' + lines + '</g><g>' + nodes + '</g></svg></div>';
  }
  function box(){ return [vb.x, vb.y, vb.w, vb.h].map(function(v){ return v.toFixed(1); }).join(' '); }
  // How far in one can zoom: Lineage a little, Topics far (into a project's card).
  var MINW = 1 / 6;
  function setBox(next){
    var w = Math.max(TW * MINW, Math.min(TW * 1.5, next.w)), h = w * TH / TW;
    vb = { x: next.x + (next.w - w) / 2, y: next.y + (next.h - h) / 2, w: w, h: h };
    var svg = graph.querySelector('.rm-zoomable');
    if (svg) svg.setAttribute('viewBox', box());
    if (opts.view === 'topics') detailLevel();
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
    var svg = e.target.closest && e.target.closest('.rm-zoomable');
    if (!svg) return;
    e.preventDefault();
    var p = toMap(svg, e.clientX, e.clientY);
    zoomBy(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  graph.addEventListener('pointerdown', function(e){
    var svg = e.target.closest && e.target.closest('.rm-zoomable');
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

  /* ---------- Topics, as Prezi: sets within sets, flown into ---------- */
  // The stepping stones as a topic tree (research-map.js topicTree: topics, a big one's sub-topics, then the
  // projects), drawn as sets (topicGraph): each topic a circle, placed by how alike the topics are; inside, each
  // stepping stone a point, placed by how alike it is to the others, so nearer is more alike; faint lines join each
  // to its most alike (nearLinks). Clicking a set flies into it; clicking a point flies to it and opens its card.
  // Esc, Back or the empty canvas flies out a level; the arrows go to the next or previous at the same level; the
  // breadcrumb says where you are. The wheel and dragging roam freely. Names show once they're big enough to read,
  // and only where there's room (detailLevel).
  var prezi = null, focus = 'all', flying = 0;
  var PW = 1600, PH = 1000;
  function preziData(){
    var items = map.nodes.filter(function(n){ return n.kind === 'project'; }).map(function(n){ return Object.assign({}, n, { pid: n.id }); });
    var key = items.map(function(n){ return n.id; }).join(',');
    if (prezi && prezi.key === key) return prezi;
    var tree = R.topicTree(items);
    var parent = {}, byId = {}, hue = {};
    var walk = function(node, up, h){
      byId[node.id] = node; parent[node.id] = up;
      if (h !== undefined) hue[node.id] = h;
      (node.children || []).forEach(function(c, i){ walk(c, node.id, up === undefined ? i % HUES.length : h); });
    };
    walk(tree, undefined, undefined);
    prezi = { key: key, tree: tree, at: R.topicGraph(tree, items, PW, PH), links: R.nearLinks(items, 2, 0.12), parent: parent, byId: byId, hue: hue };
    if (!byId[focus]) focus = 'all';
    return prezi;
  }
  function preziSvg(){
    var P = preziData(), on = lit(), f = function(n){ return n.toFixed(2); };
    var sets = '', points = '', cards = '';
    var count = function(x){ return x.children ? x.children.reduce(function(s, c){ return s + count(c); }, 0) : 1; };
    var walk = function(node, depth){
      var c = P.at[node.id], hue = P.hue[node.id] !== undefined ? ' rm-hue-' + HUES[P.hue[node.id]] : '';
      if (node.children && node.id !== 'all') {
        // A topic by its two main words (a sub-topic by all of its): its tooltip and the breadcrumb say all three.
        var name = depth === 1 ? node.terms.slice(0, 2).join(' \u00b7 ') : node.name, label = name + '  \u00b7 ' + count(node);
        // As wide as its circle at most; a topic's (the top level) never smaller than reads when it all fits.
        var fs = Math.min(c.r * 0.16, c.r * 1.9 / (label.length * 0.74));
        if (depth === 1) fs = Math.max(fs, 17);
        sets += '<g class="rz-set' + hue + (focus === node.id ? ' is-focus' : '') + '" data-node="' + esc(node.id) + '" data-w="' + f(2 * c.r) + '" data-fs="' + f(fs) + '">' +
          '<circle class="rz-ring" cx="' + f(c.x) + '" cy="' + f(c.y) + '" r="' + f(c.r) + '"></circle>' +
          '<text class="rz-title" x="' + f(c.x) + '" y="' + f(c.y - c.r - fs * 0.45) + '" text-anchor="middle" style="font-size:' + f(fs) + 'px" data-len="' + label.length + '"><title>' + esc(node.name) + '</title>' + esc(name) +
          '<tspan class="rz-count">  · ' + count(node) + '</tspan></text></g>';
      }
      (node.children || []).forEach(function(k){ walk(k, depth + 1); });
      if (!node.children) {
        var n = node.item, dot = c.r * 0.3, fsz = c.r * 0.5;
        points += '<g class="rz-point cx-node rm-project' + hue + (on && on[n.id] ? ' is-lit' : '') + (selected === n.id ? ' is-selected' : '') + (focus === node.id ? ' is-focus' : '') +
          '" data-node="' + esc(node.id) + '" data-id="' + esc(n.id) + '" data-r="' + f(c.r) + '" data-x="' + f(c.x) + '" data-y="' + f(c.y) + '">' +
          '<circle class="rz-dot" cx="' + f(c.x) + '" cy="' + f(c.y) + '" r="' + f(dot) + '"></circle>' +
          '<text class="rz-name" x="' + f(c.x + dot * 1.5) + '" y="' + f(c.y + fsz * 0.35) + '" style="font-size:' + f(fsz) + 'px">' + esc(short(n.title, 34)) + '</text>' +
          '<title>' + esc(n.title) + '</title></g>';
        // Its card, beside it: shown when it's flown to.
        var k = c.r * 4.4 / 400, href = hrefOf(map.byId[n.id] || n), abs = String(n.abstract || '').replace(/\s+/g, ' ').trim();
        var ups = (n.parents || []).map(function(id){ return map.byId[id]; }).filter(Boolean).map(function(x){ return esc(x.title); }).join(', ');
        cards += '<g class="rz-cardg' + hue + '" data-card="' + esc(node.id) + '" transform="translate(' + f(c.x + c.r * 0.6) + ',' + f(c.y - c.r * 1.6) + ') scale(' + k.toFixed(5) + ')">' +
          '<rect class="rz-card-box" width="400" height="300" rx="12"></rect>' +
          '<foreignObject width="400" height="300"><div xmlns="http://www.w3.org/1999/xhtml" class="rz-card-in">' +
            '<h3>' + esc(n.title) + '</h3>' +
            ((n.people || []).length ? '<p class="rz-people">' + n.people.map(esc).join(', ') + '</p>' : '') +
            (abs ? '<p class="rz-abs">' + esc(abs.length > 420 ? abs.slice(0, 420).replace(/\s+\S*$/, '') + '…' : abs) + '</p>' : n.titleOnly ? '<p class="rz-abs">Its people see it: join it from Projects.</p>' : '') +
            '<p class="rz-part">' + (ups ? 'Part of ' + ups : 'Not linked yet') + '</p>' +
            (href ? '<a class="rz-open" href="' + esc(href) + '">Open →</a>' : '') +
          '</div></foreignObject></g>';
      }
    };
    walk(P.tree, 0);
    // How alike: a line from each to its most alike, darker the more alike.
    var links = P.links.map(function(l){
      var a = P.at['p:' + l.a], b = P.at['p:' + l.b];
      if (!a || !b) return '';
      var hot = on && on[l.a] && on[l.b];
      return '<line class="rz-link' + (hot ? ' is-lit' : '') + '" x1="' + f(a.x) + '" y1="' + f(a.y) + '" x2="' + f(b.x) + '" y2="' + f(b.y) + '" style="opacity:' + Math.min(0.4, 0.04 + l.s * 0.5).toFixed(2) + '"><title>' + Math.round(l.s * 100) + '% alike</title></line>';
    }).join('');
    return '<div class="cx-graph rm-zoom rz"><nav class="rz-crumbs" aria-label="Where you are"></nav>' +
      '<div class="rm-zoom-ctl view-toggle" role="group" aria-label="Zoom">' +
      '<button type="button" class="view-btn" data-zoom="in" aria-label="Zoom in">+</button><button type="button" class="view-btn" data-zoom="out" aria-label="Zoom out">−</button>' +
      '<button type="button" class="view-btn" data-zoom="fit" aria-label="All topics">⤢</button></div>' +
      '<p class="rm-zoom-hint">Nearer is more alike · click to fly in · Esc to fly out · ← → next</p>' +
      '<svg class="cx-svg rm-svg rz-svg rm-zoomable' + (on ? ' has-selected' : '') + '" viewBox="' + box() + '" style="height:' + Math.round(TH) + 'px; max-height:78vh"' +
      ' preserveAspectRatio="xMidYMin meet" role="img" aria-label="Stepping stones by topic, nearer the more alike: click a topic to zoom into it">' +
      '<g>' + sets + '</g><g>' + links + '</g><g>' + points + '</g><g>' + cards + '</g></svg></div>';
  }
  // What shows depends on its size on screen: a set's name once it's big enough to read; a point's name once its
  // text is, and only where it has room (the focus's and the lit first, then the larger); a card when flown to.
  function detailLevel(){
    var svg = graph.querySelector('.rz-svg');
    if (!svg) return;
    var b = svg.getBoundingClientRect(), s = b.width ? Math.min(b.width / vb.w, (b.height || 1e9) / vb.h) : TW / vb.w;
    // A set's name: from big enough to read to too big to be of use (it's around you then).
    // …and only where it doesn't run into another's, the larger first.
    var named = [];
    Array.prototype.slice.call(svg.querySelectorAll('.rz-set')).sort(function(a, b){ return (+b.getAttribute('data-w')) - (+a.getAttribute('data-w')); }).forEach(function(g){
      var fs = +g.getAttribute('data-fs'), px = fs * s, t = g.querySelector('.rz-title'), x = +t.getAttribute('x'), y = +t.getAttribute('y'), half = (+t.getAttribute('data-len')) * fs * 0.39;
      var bx = [x - half, y - fs, x + half, y + fs * 0.3];
      var ok = (+g.getAttribute('data-w')) * s >= 120 && px >= 9 && px <= 46 && !named.some(function(o){ return bx[0] < o[2] && bx[2] > o[0] && bx[1] < o[3] && bx[3] > o[1]; });
      if (ok) named.push(bx);
      g.classList.toggle('is-tiny', !ok);
    });
    // A point's name doesn't run into a set's either.
    var taken = named.slice(), pts = Array.prototype.slice.call(svg.querySelectorAll('.rz-point'));
    // Every dot is in the way of every name but its own.
    var dots = pts.map(function(g){ var r = +g.getAttribute('data-r') * 0.35, x = +g.getAttribute('data-x'), y = +g.getAttribute('data-y'); return { g: g, b: [x - r, y - r, x + r, y + r] }; });
    var inView = function(x, y){ return x > vb.x && x < vb.x + vb.w && y > vb.y && y < vb.y + vb.h; };
    pts.sort(function(p, q){
      var rank = function(g){ return g.classList.contains('is-focus') || g.classList.contains('is-selected') ? 0 : g.classList.contains('is-lit') ? 1 : 2; };
      return rank(p) - rank(q) || (+q.getAttribute('data-r')) - (+p.getAttribute('data-r'));
    });
    pts.forEach(function(g){
      var r = +g.getAttribute('data-r'), x = +g.getAttribute('data-x'), y = +g.getAttribute('data-y'), t = g.querySelector('.rz-name');
      // Readable, and not so big it's in the way (or its card is open).
      var readable = r * 0.5 * s >= 10 && r * 0.5 * s <= 30 && !(g.classList.contains('is-focus') && r * 4.4 * s >= 220), len = 0;
      try { len = t.getComputedTextLength(); } catch (e){}
      if (!len) len = t.textContent.length * r * 0.5 * 0.55;
      var bx = [x - r * 0.3, y - r * 0.4, x + r * 0.45 + len, y + r * 0.4];
      var hit = function(o){ return bx[0] < o[2] && bx[2] > o[0] && bx[1] < o[3] && bx[3] > o[1]; };
      var free = readable && inView(x, y) && !taken.some(hit) && !dots.some(function(d){ return d.g !== g && hit(d.b); });
      if (free) taken.push(bx);
      g.classList.toggle('is-named', free);
    });
    svg.querySelectorAll('.rz-cardg').forEach(function(g){
      var id = g.getAttribute('data-card'), r = prezi && prezi.at[id] ? prezi.at[id].r : 0;
      g.classList.toggle('is-open', id === focus && r * 4.4 * s >= 220);
    });
  }
  // The box that shows `id` whole, with a margin, at the map's shape: a set's circle; a point with its card.
  function boxOf(id){
    var c = prezi.at[id], leaf = !prezi.byId[id].children;
    var cx = leaf ? c.x + c.r * 2.4 : c.x, cy = c.y, half = id === 'all' ? null : leaf ? c.r * 3.2 : c.r * 1.12;
    if (!half) return { x: 0, y: 0, w: PW, h: PH };
    var w = 2 * half, h = 2 * half * (leaf ? 0.75 : 1.08);
    if (w / h < TW / TH) w = h * TW / TH; else h = w * TH / TW;
    return { x: cx - w / 2, y: cy - h / 2 - (leaf ? 0 : half * 0.06), w: w, h: h };
  }
  // Flies to `id`: the middle moves and the width zooms (in proportion), eased in and out.
  function flyTo(id){
    if (!prezi || !prezi.at[id]) return;
    focus = id;
    crumbs();
    graph.querySelectorAll('.rz-set, .rz-point').forEach(function(g){ g.classList.toggle('is-focus', g.getAttribute('data-node') === id); });
    var from = { x: vb.x, y: vb.y, w: vb.w, h: vb.h }, to = boxOf(id), t0 = 0, run = ++flying;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches, D = reduce ? 1 : 650;
    var step = function(t){
      if (run !== flying) return;
      if (!t0) t0 = t;
      var u = Math.min(1, (t - t0) / D), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      var w = from.w * Math.pow(to.w / from.w, e), cx = from.x + from.w / 2 + (to.x + to.w / 2 - from.x - from.w / 2) * e, cy = from.y + from.h / 2 + (to.y + to.h / 2 - from.y - from.h / 2) * e;
      var h = w * TH / TW;
      setBox({ x: cx - w / 2, y: cy - h / 2, w: w, h: h });
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function crumbs(){
    var nav = graph.querySelector('.rz-crumbs');
    if (!nav || !prezi) return;
    var path = [], id = focus;
    while (id !== undefined) { path.unshift(id); id = prezi.parent[id]; }
    nav.innerHTML = (focus !== 'all' ? '<button type="button" class="btn-text rz-back" data-fly="' + esc(prezi.parent[focus]) + '">← Back</button>' : '') +
      path.map(function(x, i){
        var n = prezi.byId[x], name = n.children ? n.name : n.item.title;
        return i === path.length - 1 ? '<span class="rz-here">' + esc(name) + '</span>' : '<button type="button" class="btn-text" data-fly="' + esc(x) + '">' + esc(name) + '</button>';
      }).join('<span class="rz-sep">›</span>');
  }
  // The next (or previous) at the same level as where you are: a sibling; from the top, the first topic.
  function step(d){
    if (!prezi) return;
    if (focus === 'all') { var first = prezi.tree.children[0]; if (first) flyTo(first.id); return; }
    var sibs = prezi.byId[prezi.parent[focus]].children, i = sibs.findIndex(function(x){ return x.id === focus; });
    flyTo(sibs[(i + d + sibs.length) % sibs.length].id);
  }
  document.addEventListener('keydown', function(e){
    if (opts.view !== 'topics' || !prezi || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'Escape' && focus !== 'all') { e.preventDefault(); flyTo(prezi.parent[focus]); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });

  /* ---------- drawing, the key, the panel, the controls ---------- */
  function draw(){
    if (!data) return;
    build();
    if (opts.view === 'topics') {
      // Topics: a 1600 × 1000 canvas, shown where it was flown to.
      TW = PW; TH = PH; MINW = 1 / 300;
      var keep = prezi ? vb : null;
      graph.innerHTML = preziSvg();
      if (keep) setBox(keep); else { vb = boxOf('all'); setBox(vb); }
      crumbs();
    } else { MINW = 1 / 6; topic = null; graph.innerHTML = topicsSvg(); }
    graph.hidden = false;
    el('rmMsg').hidden = true;
    legend();
    detail();
  }
  // What's lit changed: Topics keeps where it's zoomed to.
  function relight(){
    if (!map) return draw();
    var keep = vb;
    if (opts.view === 'topics') { graph.innerHTML = preziSvg(); crumbs(); } else graph.innerHTML = topicsSvg();
    setBox(keep);
    detail();
  }

  function legend(){
    var key = function(kind, text){ return '<span class="cx-key"><svg class="cx-icon rm-' + kind + '" viewBox="-8 -8 16 16" aria-hidden="true">' + mark(kind, 5) + '</svg><span>' + text + '</span></span>'; };
    var html = '<div class="cx-bar cx-legend"><span class="cx-bar-row"><span class="cx-bar-label">Key</span><span class="cx-bar-items">' +
      key('northstar', 'Northstar') + key('moonshot', 'Moonshot') + key('project', 'Stepping stone') +
      '</span></span>';
    if (opts.view === 'topics') { el('rmLegend').innerHTML = ''; return; }
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
      C.pair('View', '<span class="view-toggle cx-seg" role="group" aria-label="View">' +
        '<button type="button" class="view-btn" data-view="lineage" aria-pressed="' + (opts.view === 'lineage') + '">Lineage</button>' +
        '<button type="button" class="view-btn" data-view="topics" aria-pressed="' + (opts.view === 'topics') + '">Topics</button></span>') +
      C.pair('Show', '<span class="view-toggle cx-seg cx-multi" role="group" aria-label="Show">' + tog('proposed', 'Proposed') + tog('completed', 'Completed') + '</span>') +
      '</div><div class="cx-ctl-row">' +
      C.pair('Find', '<input type="search" class="cx-field cx-find" id="rmFind" placeholder="A title or keyword" value="' + esc(find) + '">') +
      C.pair('Who', '<select class="cx-field" id="rmPerson"><option value="">Everyone</option>' + Object.keys(people).sort().map(function(p){
        return '<option value="' + esc(p) + '"' + (person === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>') +
      '<a class="btn-text rm-add" href="projects-register.html#level=northstar">+ Northstar</a></div>';
    el('rmControls').querySelectorAll('[data-view]').forEach(function(b){ b.addEventListener('click', function(){
      if (opts.view === b.getAttribute('data-view')) return;
      opts.view = b.getAttribute('data-view'); save(); prezi = null; focus = 'all'; controls(); draw();
    }); });
    el('rmControls').querySelectorAll('[data-opt]').forEach(function(b){ b.addEventListener('click', function(){ var k = b.getAttribute('data-opt'); opts[k] = !opts[k]; save(); controls(); draw(); }); });
    el('rmFind').addEventListener('input', function(e){ find = e.target.value.trim(); relight(); });
    el('rmPerson').addEventListener('change', function(e){ person = e.target.value; relight(); });
  }

  // A click chooses (again: lets go); a double click, or Enter, opens its page; the zoom buttons zoom.
  graph.addEventListener('click', function(e){
    var z = e.target.closest && e.target.closest('[data-zoom]');
    if (z) {
      var k = z.getAttribute('data-zoom');
      if (k === 'fit') { if (opts.view === 'topics') flyTo('all'); else setBox({ x: 0, y: 0, w: TW, h: TH }); } else zoomBy(k === 'in' ? 1.4 : 1 / 1.4);
      return;
    }
    var fly = e.target.closest && e.target.closest('[data-fly]');
    if (fly) { flyTo(fly.getAttribute('data-fly')); return; }
    if (graph.dataset.dragged) { delete graph.dataset.dragged; return; }
    if (opts.view === 'topics') {
      // A link on a card goes where it says; a frame or a card flies into it; the empty canvas flies out a level.
      if (e.target.closest('a') || e.target.closest('[data-card]')) return;
      var fr = e.target.closest('[data-node]');
      if (fr) {
        var id = fr.getAttribute('data-node');
        if (id === focus && fr.classList.contains('rz-point')) { selected = fr.getAttribute('data-id'); detail(); return; }
        // From far off, one level at a time: into the frame on the way to it under where you are.
        var path = [], x = id;
        while (x !== undefined && x !== focus) { path.unshift(x); x = prezi.parent[x]; }
        flyTo(x === focus && path.length ? path[0] : id);
        if (fr.classList.contains('rz-point') && (x !== focus || path.length === 1)) { selected = fr.getAttribute('data-id'); detail(); }
      } else if (focus !== 'all' && e.target.closest('svg')) flyTo(prezi.parent[focus]);
      return;
    }
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
