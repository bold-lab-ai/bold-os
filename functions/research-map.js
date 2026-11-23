// Northstars, moonshots and stepping stones (#248, #425): every project has a level, and what it's
// part of. A northstar serves BOLD's goals (the BOLDiquette's); a moonshot is part of one or more
// northstars; a stepping stone (a project, the level of everything from before) is part of one or more
// moonshots, or explores one or more problems in the Problem Bank. One file for the server
// (functions/index.js: getAllProjects, researchMap) and the pages (assets/js/research-map.js, copied
// there by eleventy.config.js: the register form, a project's page, Projects and the Map).
// Plain functions, no DOM or Firebase: BoldResearch in a page, require('./research-map') here.
(function(root, make){
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.BoldResearch = make();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  var LEVELS = ['northstar', 'moonshot', 'project'];
  var NAMES = { northstar: 'Northstar', moonshot: 'Moonshot', project: 'Stepping stone' };
  var PLURAL = { northstar: 'Northstars', moonshot: 'Moonshots', project: 'Stepping stones' };
  var MAX_LINKS = 20, MAX_CONNECTION = 2000;

  // A card's level: anything without one (every project from before) is a stepping stone.
  function levelOf(card){ var l = card && card.level; return LEVELS.indexOf(l) >= 0 ? l : 'project'; }
  // What a level is part of: a moonshot of northstars, a stepping stone of moonshots; a northstar of BOLD's goals.
  function parentLevel(level){ return level === 'moonshot' ? 'northstar' : level === 'project' ? 'moonshot' : null; }
  function childLevel(level){ return level === 'northstar' ? 'moonshot' : level === 'moonshot' ? 'project' : null; }

  function ids(list){
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function(x){
      var s = String(x || '').trim();
      if (s && /^[A-Za-z0-9_-]{1,160}$/.test(s) && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }
  // What was given → { level, parents, problems, connection }: ids kept as given, unique; a northstar has none.
  function normalizeLinks(d){
    d = d || {};
    var level = LEVELS.indexOf(d.level) >= 0 ? d.level : 'project';
    return {
      level: level,
      parents: level === 'northstar' ? [] : ids(d.parents),
      problems: level === 'project' ? ids(d.problems) : [],
      connection: level === 'northstar' ? '' : String(d.connection || '').trim().slice(0, MAX_CONNECTION)
    };
  }
  // What's wrong with them, in words, or '' (required for every new one, and once changed).
  function linkIssue(d){
    var n = normalizeLinks(d);
    if (n.parents.length + n.problems.length > MAX_LINKS) return 'At most ' + MAX_LINKS + ' links.';
    if (n.level === 'moonshot' && !n.parents.length) return 'Choose the northstar (or northstars) it’s part of.';
    if (n.level === 'project' && !n.parents.length && !n.problems.length) return 'Choose the moonshot (or moonshots) it’s part of, or the problems it explores.';
    return '';
  }
  // Whether a card is linked up as it should be: a northstar always is.
  function linked(card){
    var l = levelOf(card);
    return l === 'northstar' || ids(card && card.parents).length > 0 || (l === 'project' && ids(card && card.problems).length > 0);
  }

  // The map: `items` [{ pid, title, level, parents, problems, … }], `problems` [{ id, title, project }].
  // → { nodes: [{ id, kind ('northstar' | 'moonshot' | 'project' | 'problem'), … }], edges: [{ from, to, kind }] }:
  // 'part' (from a part to what it's part of, only to the level above), 'explores' (a stepping stone to a
  // problem), 'problem' (a problem to the project it belongs to). Links to what isn't there are left out.
  function buildMap(items, problems){
    var byId = {}, nodes = [], edges = [];
    (items || []).forEach(function(i){
      if (!i || !i.pid || byId[i.pid]) return;
      var n = Object.assign({}, i, { id: i.pid, kind: levelOf(i) });
      byId[i.pid] = n; nodes.push(n);
    });
    var probs = {};
    (problems || []).forEach(function(p){
      if (!p || !p.id || probs[p.id]) return;
      var n = Object.assign({}, p, { id: 'problem:' + p.id, kind: 'problem' });
      probs[p.id] = n; nodes.push(n);
      if (p.project && byId[p.project]) edges.push({ from: n.id, to: p.project, kind: 'problem' });
    });
    nodes.forEach(function(n){
      if (n.kind === 'problem') return;
      var up = parentLevel(n.kind);
      ids(n.parents).forEach(function(p){ if (byId[p] && byId[p].kind === up) edges.push({ from: n.id, to: p, kind: 'part' }); });
      if (n.kind === 'project') ids(n.problems).forEach(function(p){ if (probs[p]) edges.push({ from: n.id, to: 'problem:' + p, kind: 'explores' }); });
    });
    return { nodes: nodes, edges: edges };
  }

  // Everything above and below a node (`id`), through 'part' and problem edges both ways → { id: true }.
  function lineage(map, id){
    var up = {}, down = {};
    (map.edges || []).forEach(function(e){ (up[e.from] = up[e.from] || []).push(e.to); (down[e.to] = down[e.to] || []).push(e.from); });
    var seen = {}; seen[id] = true;
    var walk = function(start, next){
      var stack = [start];
      while (stack.length){ var x = stack.pop(); (next[x] || []).forEach(function(y){ if (!seen[y]) { seen[y] = true; stack.push(y); } }); }
    };
    walk(id, up); walk(id, down);
    return seen;
  }

  // ---------- Topics: projects clustered by what they're about (the Map's Topics view) ----------
  var STOP = ('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does ' +
    'doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my ' +
    'no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these ' +
    'they this those through to too under until up very was we were what when where which while who whom why will with would you your yours ' +
    'using use used new based approach approaches method methods work project projects paper propose proposed show shows results result towards toward ' +
    'via also can could one two well make makes making way ways learn learning model models data task tasks however thus within without across ' +
    'bold doc northstar northstars moonshot moonshots stepping stepping-stones stones pillar first may might many much need needs such its it\u2019s we\u2019re aim aims goal goals study studies explore explores exploring able allow allows').split(' ');
  var STOPS = {};
  STOP.forEach(function(w){ STOPS[w] = true; });
  // A text's words: lower case, letters and digits, three letters or more, without the commonest.
  function words(text){
    return (String(text || '').toLowerCase().replace(/\$[^$]*\$/g, ' ').replace(/https?:\/\/\S+/g, ' ').match(/[a-z][a-z0-9-]{2,}/g) || [])
      .map(function(w){ return w.replace(/-+$/, ''); }).filter(function(w){ return w.length > 2 && !STOPS[w]; });
  }
  // Each item as a weighted bag of terms: its keywords (whole, and their words) count most, then its title, then
  // its abstract; weighted by how rare each term is across them all (tf-idf), and of unit length.
  function vectors(items){
    var bags = items.map(function(i){
      var bag = {}, add = function(t, w){ bag[t] = (bag[t] || 0) + w; };
      (i.keywords || []).forEach(function(k){ var kk = String(k).toLowerCase().trim(); if (kk) add('#' + kk, 4); words(k).forEach(function(w){ add(w, 2); }); });
      // A title's [tags] (PAUSED, AMAZE, who leads it) say how it's going, not what it's about.
      words(String(i.title || '').replace(/\[[^\]]*\]/g, ' ')).forEach(function(w){ add(w, 2); });
      words(i.abstract).forEach(function(w){ add(w, 1); });
      return bag;
    });
    var df = {}, n = items.length;
    bags.forEach(function(b){ Object.keys(b).forEach(function(t){ df[t] = (df[t] || 0) + 1; }); });
    return bags.map(function(b){
      var v = {}, len = 0;
      Object.keys(b).forEach(function(t){
        if (df[t] < 2 && t.charAt(0) !== '#') return;   // a word only one has links it to nothing
        var w = (1 + Math.log(b[t])) * Math.log(1 + n / df[t]);
        v[t] = w; len += w * w;
      });
      len = Math.sqrt(len) || 1;
      Object.keys(v).forEach(function(t){ v[t] /= len; });
      return v;
    });
  }
  function dot(a, b){ var s = 0; for (var t in a) if (b[t]) s += a[t] * b[t]; return s; }
  // → { of: { pid: cluster }, clusters: [{ terms: [3 words], size }] }: k clusters (about √(1.2n), 3 to 12) by
  // spherical k-means (the best of several fixed starts); each named by its terms
  // that weigh most in it, keywords first.
  // `exclude`: words not to name a cluster by (its parent's, for a sub-topic).
  function clusters(items, k, exclude){
    var n = items.length, vs = vectors(items);
    if (!n) return { of: {}, clusters: [] };
    k = Math.max(1, Math.min(n, k || Math.max(3, Math.min(12, Math.round(Math.sqrt(n * 1.2))))));
    // k-means from several starts (k-means++ on a fixed sequence of numbers, so the same every time),
    // keeping the tightest: the most similarity between each item and its cluster's centre.
    var rand = function(i){ return seed('start' + i); }, draws = 0;
    var once = function(){
      var cents = [vs[Math.floor(rand(draws++) * n)]], near = vs.map(function(v){ return dot(v, cents[0]); });
      while (cents.length < k) {
        var wts = near.map(function(s){ return Math.max(0, 1 - s); }), tot = wts.reduce(function(x, y){ return x + y; }, 0);
        if (!tot) break;
        var pick = rand(draws++) * tot, at = 0;
        while (at < n - 1 && (pick -= wts[at]) > 0) at++;
        cents.push(vs[at]);
        near = near.map(function(s, i){ return Math.max(s, dot(vs[i], vs[at])); });
      }
      var of = new Array(n), score = 0;
      for (var it = 0; it < 30; it++) {
        var moved = false;
        score = 0;
        vs.forEach(function(v, i){
          var bi = 0, bs = -1;
          cents.forEach(function(c, j){ var s = dot(v, c); if (s > bs) { bs = s; bi = j; } });
          score += bs;
          if (of[i] !== bi) { of[i] = bi; moved = true; }
        });
        cents = cents.map(function(c, j){
          var sum = {}, len = 0, any = false;
          vs.forEach(function(v, i){ if (of[i] !== j) return; any = true; for (var t in v) sum[t] = (sum[t] || 0) + v[t]; });
          if (!any) return c;
          for (var t in sum) len += sum[t] * sum[t];
          len = Math.sqrt(len) || 1;
          for (var u in sum) sum[u] /= len;
          return sum;
        });
        if (!moved) break;
      }
      return { of: of, cents: cents, score: score };
    };
    var best = null;
    for (var tries = 0; tries < 12; tries++) { var r = once(); if (!best || r.score > best.score) best = r; }
    var of = best.of, cents = best.cents;
    var out = { of: {}, clusters: cents.map(function(c){
      var terms = Object.keys(c).sort(function(a, b){ return c[b] - c[a]; });
      var skip = function(w){ return (exclude || []).some(function(x){ return x === w || x.indexOf(w) >= 0 || w.indexOf(x) >= 0; }); };
      terms = terms.filter(function(t){ return !skip(t.charAt(0) === '#' ? t.slice(1) : t); });
      var kw = terms.filter(function(t){ return t.charAt(0) === '#'; }).map(function(t){ return t.slice(1); });
      var named = kw.slice(0, 2);
      terms.forEach(function(t){
        var w = t.charAt(0) === '#' ? t.slice(1) : t;
        if (named.length < 3 && !named.some(function(x){ return x.indexOf(w) >= 0 || w.indexOf(x) >= 0; })) named.push(w);
      });
      return { terms: named, size: 0 };
    }) };
    items.forEach(function(i, x){ out.of[i.pid] = of[x]; out.clusters[of[x]].size++; });
    return out;
  }
  // A stable number in [0, 1) for a string, so the same every time.
  function seed(s){ var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

  // The Topics board, `w` wide: each cluster a card listing its items as rows, the cards stacked in a left and a
  // right column (as even as can be) under a band with the northstars across the top; the moonshots down the
  // middle, each at the height of what's part of it, none closer than `gap` to the next. → { cards: [{ j, x, y,
  // w, h, side }], pos: { id: { x, y, side } } (a row's dot, on its card's inner edge), h, mid: the middle's width }.
  function topicBoard(items, links, cl, w){
    var ROW = 24, HEAD = 34, PAD = 12, GAP = 22, M = 16, TOPBAND = 86;
    var CARD = Math.min(340, Math.max(230, w * 0.28));
    var byCluster = cl.clusters.map(function(){ return []; });
    items.forEach(function(i){ var j = cl.of[i.pid]; if (j !== undefined) byCluster[j].push(i); });
    byCluster.forEach(function(list){ list.sort(function(a, b){ return String(a.title).localeCompare(String(b.title)); }); });
    var order = cl.clusters.map(function(c, j){ return j; }).filter(function(j){ return byCluster[j].length; })
      .sort(function(a, b){ return byCluster[b].length - byCluster[a].length || a - b; });
    var hOf = function(j){ return HEAD + byCluster[j].length * ROW + PAD; };
    var col = { left: [], right: [] }, tall = { left: 0, right: 0 };
    order.forEach(function(j){ var side = tall.left <= tall.right ? 'left' : 'right'; col[side].push(j); tall[side] += hOf(j) + GAP; });
    var out = { cards: [], pos: {}, h: 0, mid: w - 2 * (M + CARD) };
    ['left', 'right'].forEach(function(side){
      var y = TOPBAND;
      col[side].forEach(function(j){
        var x = side === 'left' ? M : w - M - CARD, hh = hOf(j);
        out.cards.push({ j: j, x: x, y: y, w: CARD, h: hh, side: side });
        byCluster[j].forEach(function(i, r){ out.pos[i.pid] = { x: side === 'left' ? x + CARD - 14 : x + 14, y: y + HEAD + r * ROW + ROW / 2, side: side }; });
        y += hh + GAP;
      });
    });
    out.h = TOPBAND + Math.max(tall.left, tall.right);
    var nb = {};
    (links || []).forEach(function(e){ (nb[e.from] = nb[e.from] || []).push(e.to); (nb[e.to] = nb[e.to] || []).push(e.from); });
    var of = function(kind){ return items.filter(function(i){ return cl.of[i.pid] === undefined && (i.level || 'project') === kind; }); };
    // Northstars: across the top, in the order their moonshots' stepping stones run, left to right.
    var stars = of('northstar');
    stars.forEach(function(i, k){ out.pos[i.pid] = { x: w * (k + 1) / (stars.length + 1), y: 26, side: 'top' }; });
    // Moonshots: down the middle, each at the height of its stepping stones (none: just under the band).
    var mid = w / 2, moons = of('moonshot'), gap = 46;
    moons.forEach(function(i){
      var near = (nb[i.pid] || []).filter(function(o){ return out.pos[o] && out.pos[o].side !== 'top'; });
      var y = near.length ? near.reduce(function(s, o){ return s + out.pos[o].y; }, 0) / near.length : TOPBAND + 10;
      out.pos[i.pid] = { x: mid, y: y, side: 'middle' };
    });
    moons.sort(function(a, b){ return out.pos[a.pid].y - out.pos[b.pid].y || String(a.title).localeCompare(String(b.title)); });
    for (var it = 0; it < 60; it++) for (var k = 1; k < moons.length; k++) {
      var p = out.pos[moons[k - 1].pid], q = out.pos[moons[k].pid], d = q.y - p.y;
      if (d < gap) { p.y -= (gap - d) / 2; q.y += (gap - d) / 2; }
    }
    var floor = TOPBAND + 10;
    moons.forEach(function(i){ var p = out.pos[i.pid]; if (p.y < floor) p.y = floor; floor = p.y + gap; out.h = Math.max(out.h, p.y + 40); });
    // The northstars, left to right as their moonshots run top to bottom… across the top they go by order of mean height.
    var rank = function(i){ var ys = (nb[i.pid] || []).filter(function(o){ return out.pos[o] && out.pos[o].side === 'middle'; }).map(function(o){ return out.pos[o].y; }); return ys.length ? ys.reduce(function(a, b){ return a + b; }, 0) / ys.length : 1e9; };
    stars.slice().sort(function(a, b){ return rank(a) - rank(b) || String(a.title).localeCompare(String(b.title)); })
      .forEach(function(i, k){ out.pos[i.pid].x = w * (k + 1) / (stars.length + 1); });
    out.h += M;
    return out;
  }

  // ---------- Topics, as Prezi: frames within frames ----------
  // The topic tree: all → topics → (a big topic's) sub-topics → its stepping stones. A topic of more than `max`
  // (8) is split again, its sub-topics named without its own words, down to three levels. → { id: 'all', name,
  // children: [{ id, name, terms, children }] }, a leaf { id: 'p:<pid>', pid, item }.
  function topicTree(items, max){
    max = max || 8;
    var leaf = function(i){ return { id: 'p:' + i.pid, pid: i.pid, item: i }; };
    var byTitle = function(a, b){ return String(a.title).localeCompare(String(b.title)); };
    var split = function(list, depth, parentTerms, prefix){
      list = list.slice().sort(byTitle);
      if ((depth > 0 && list.length <= max) || depth >= 3 || list.length < 3) return list.map(leaf);
      var cl = clusters(list, depth === 0 ? undefined : Math.max(2, Math.min(5, Math.round(Math.sqrt(list.length / 2)))), parentTerms);
      var groups = cl.clusters.map(function(c, j){ return { c: c, list: list.filter(function(i){ return cl.of[i.pid] === j; }) }; }).filter(function(g){ return g.list.length; });
      if (groups.length < 2) return list.map(leaf);
      groups.sort(function(a, b){ return b.list.length - a.list.length; });
      return groups.map(function(g, j){
        var terms = g.c.terms.length ? g.c.terms : ['other'];
        return { id: prefix + '.' + j, name: terms.join(' \u00b7 '), terms: terms, children: split(g.list, depth + 1, (parentTerms || []).concat(terms), prefix + '.' + j) };
      });
    };
    return { id: 'all', name: 'All topics', terms: [], children: split(items, 0, [], 't') };
  }
  // Frames within frames: each node of the tree gets { x, y, w, h } (in `out`, by id), its children laid out on a
  // grid under its title band, as large as they'll go (a frame 3:2, a leaf's card 4:3). The root is w × h.
  function frameLayout(tree, w, h){
    var out = {};
    var place = function(node, x, y, fw, fh){
      out[node.id] = { x: x, y: y, w: fw, h: fh };
      var kids = node.children || [];
      if (!kids.length) return;
      var band = node.id === 'all' ? 0 : fh * 0.19, pad = fw * 0.04;
      var ax = x + pad, ay = y + band + pad * 0.5, aw = fw - 2 * pad, ah = fh - band - pad * 1.5, n = kids.length;
      var leafy = !kids[0].children, aspect = leafy ? 4 / 3 : 3 / 2, best = null;
      for (var c = 1; c <= n; c++) {
        var r = Math.ceil(n / c), cw = aw / c, ch = ah / r, size = Math.min(cw / aspect, ch);
        if (!best || size > best.size) best = { c: c, r: r, cw: cw, ch: ch, size: size };
      }
      var iw = best.size * aspect * 0.9, ih = best.size * 0.9;
      // Centred: the grid, and each row (a short last row in the middle).
      var gy = ay + (ah - best.r * best.ch) / 2;
      kids.forEach(function(k, i){
        var row = Math.floor(i / best.c), inRow = Math.min(best.c, n - row * best.c), col = i % best.c;
        var gx = ax + (aw - inRow * best.cw) / 2;
        place(k, gx + col * best.cw + (best.cw - iw) / 2, gy + row * best.ch + (best.ch - ih) / 2, iw, ih);
      });
    };
    place(tree, 0, 0, w, h);
    return out;
  }

  return { words: words, clusters: clusters, topicBoard: topicBoard, topicTree: topicTree, frameLayout: frameLayout, LEVELS: LEVELS, NAMES: NAMES, PLURAL: PLURAL, MAX_LINKS: MAX_LINKS, levelOf: levelOf, parentLevel: parentLevel, childLevel: childLevel,
    normalizeLinks: normalizeLinks, linkIssue: linkIssue, linked: linked, buildMap: buildMap, lineage: lineage };
});
