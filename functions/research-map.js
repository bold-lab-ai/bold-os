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
  function clusters(items, k){
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
  // A stable number in [0, 1) for a string, so the layout is the same each time.
  function seed(s){ var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }
  // Where each item sits (w × h). First the clustered ones: each cluster around its own centre (on a ring),
  // pushed apart and pulled to their centre, so each cluster stays together. Then the rest (moonshots, northstars):
  // each among what's linked to it (a moonshot among its stepping stones, a northstar among its moonshots),
  // pushed off everything else. → { pid: { x, y } }, and each cluster's { x, y, r } in `cl.clusters`.
  function topicLayout(items, links, cl, w, h){
    var pos = {}, cx = w / 2, cy = h / 2, k = cl.clusters.length, R = Math.min(w, h) * (k > 1 ? 0.36 : 0), sx = w / Math.min(w, h);
    var centre = cl.clusters.map(function(c, j){ var a = -Math.PI / 2 + j * 2 * Math.PI / Math.max(1, k); return { x: cx + Math.cos(a) * R * sx * 0.9, y: cy + Math.sin(a) * R }; });
    var inC = items.filter(function(i){ return cl.of[i.pid] !== undefined; }).map(function(i){ return i.pid; });
    var free = items.filter(function(i){ return cl.of[i.pid] === undefined; }).map(function(i){ return i.pid; });
    inC.forEach(function(id){
      var c = centre[cl.of[id]], a = seed(id) * 2 * Math.PI, r = 10 + seed(id + '.') * 40;
      pos[id] = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    });
    var clamp = function(p){ p.x = Math.max(20, Math.min(w - 20, p.x)); p.y = Math.max(20, Math.min(h - 20, p.y)); };
    var MIN = 40;
    var push = function(ids, movable, rounds, pull){
      for (var it = 0; it < rounds; it++) {
        var heat = 1 - it / rounds, f = {};
        movable.forEach(function(id){ f[id] = { x: 0, y: 0 }; });
        for (var a = 0; a < ids.length; a++) for (var b = a + 1; b < ids.length; b++) {
          var A = ids[a], B = ids[b];
          if (!f[A] && !f[B]) continue;
          var p = pos[A], q = pos[B], dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
          // Two that carry labels (neither clustered: moonshots, northstars) keep further apart, sideways most.
          var same = cl.of[A] !== undefined && cl.of[A] === cl.of[B], both = cl.of[A] === undefined && cl.of[B] === undefined;
          var near = both ? (Math.abs(dy) < 22 && Math.abs(dx) < 240 ? 60 : 0) : 0;
          var fr = (same ? 700 : both ? 5000 : 2200) / d2 + (d < MIN ? (MIN - d) * 0.6 : 0) + near * (1 - Math.abs(dy) / 22) * 0.4;
          if (f[A]) { f[A].x -= dx / d * fr; f[A].y -= dy / d * fr; }
          if (f[B]) { f[B].x += dx / d * fr; f[B].y += dy / d * fr; }
        }
        pull(f);
        movable.forEach(function(id){
          var len = Math.sqrt(f[id].x * f[id].x + f[id].y * f[id].y) || 1, step = Math.min(24 * heat + 0.5, len);
          pos[id].x += f[id].x / len * step; pos[id].y += f[id].y / len * step; clamp(pos[id]);
        });
      }
    };
    push(inC, inC, 260, function(f){ inC.forEach(function(id){ var c = centre[cl.of[id]]; f[id].x += (c.x - pos[id].x) * 0.05; f[id].y += (c.y - pos[id].y) * 0.05; }); });
    // The rest, each at the middle of what it's linked to that's placed already (stepping stones, then moonshots).
    var nb = {};
    (links || []).forEach(function(e){ (nb[e.from] = nb[e.from] || []).push(e.to); (nb[e.to] = nb[e.to] || []).push(e.from); });
    for (var pass = 0; pass < 3; pass++) free.forEach(function(id){
      if (pos[id] && pass < 2) return;
      var near = (nb[id] || []).filter(function(o){ return pos[o]; });
      if (!near.length) return;
      pos[id] = { x: near.reduce(function(s, o){ return s + pos[o].x; }, 0) / near.length + (seed(id) - 0.5) * 30,
        y: near.reduce(function(s, o){ return s + pos[o].y; }, 0) / near.length + (seed(id + '.') - 0.5) * 30 };
    });
    free.forEach(function(id){ if (!pos[id]) pos[id] = { x: cx + (seed(id) - 0.5) * 120, y: cy + (seed(id + '.') - 0.5) * 120 }; });
    push(inC.concat(free), free, 200, function(f){
      free.forEach(function(id){
        (nb[id] || []).forEach(function(o){ if (pos[o]) { f[id].x += (pos[o].x - pos[id].x) * 0.02; f[id].y += (pos[o].y - pos[id].y) * 0.02; } });
      });
    });
    cl.clusters.forEach(function(c, j){
      var mine = inC.filter(function(id){ return cl.of[id] === j; });
      if (!mine.length) { c.x = centre[j].x; c.y = centre[j].y; c.r = 0; return; }
      c.x = mine.reduce(function(s, id){ return s + pos[id].x; }, 0) / mine.length;
      c.y = mine.reduce(function(s, id){ return s + pos[id].y; }, 0) / mine.length;
      c.r = Math.max.apply(null, mine.map(function(id){ return Math.sqrt(Math.pow(pos[id].x - c.x, 2) + Math.pow(pos[id].y - c.y, 2)); })) + 26;
    });
    return pos;
  }

  return { words: words, clusters: clusters, topicLayout: topicLayout, LEVELS: LEVELS, NAMES: NAMES, PLURAL: PLURAL, MAX_LINKS: MAX_LINKS, levelOf: levelOf, parentLevel: parentLevel, childLevel: childLevel,
    normalizeLinks: normalizeLinks, linkIssue: linkIssue, linked: linked, buildMap: buildMap, lineage: lineage };
});
