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

  return { LEVELS: LEVELS, NAMES: NAMES, PLURAL: PLURAL, MAX_LINKS: MAX_LINKS, levelOf: levelOf, parentLevel: parentLevel, childLevel: childLevel,
    normalizeLinks: normalizeLinks, linkIssue: linkIssue, linked: linked, buildMap: buildMap, lineage: lineage };
});
