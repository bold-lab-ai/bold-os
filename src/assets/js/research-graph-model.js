// Shared geometry uses node centres. Each label has space for two 165px-wide lines.
(function (root) {
  'use strict';

  var OVERVIEW_SIZE = 12, NEIGHBOR_SIZE = 8;
  var roles = ['parents', 'children', 'related'];
  var roleOrder = {pillar: 0, moonshot: 1, problem: 2};
  function byName(a, b) {
    return roleOrder[a.kind] - roleOrder[b.kind] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  }
  function build(family, includeArchived) {
    var nodes = new Map(), links = new Map(), edges = [], seen = new Set();
    function add(record, kind) {
      if ((!includeArchived && record.archived) || nodes.has(record.id)) return;
      nodes.set(record.id, Object.assign({}, record, {kind:kind}));
      links.set(record.id, {parents:[], children:[], related:[]});
    }
    family.objectives.forEach(function (node) { add(node, node.kind); });
    family.problems.forEach(function (node) { add(node, 'problem'); });
    family.edges.forEach(function (edge) {
      var from = nodes.get(edge.from), to = nodes.get(edge.to);
      if (!from || !to || from === to) return;
      if (edge.kind !== 'contributes_to' && edge.kind !== 'related_to') return;
      if (edge.kind === 'related_to' && from.id > to.id) { var tmp = from; from = to; to = tmp; }
      var key = JSON.stringify([from.id, to.id, edge.kind]);
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({from:from.id, to:to.id, kind:edge.kind});
      if (edge.kind === 'contributes_to') {
        links.get(from.id).parents.push(to);
        links.get(to.id).children.push(from);
      } else {
        links.get(from.id).related.push(to);
        links.get(to.id).related.push(from);
      }
    });
    links.forEach(function (groups) { roles.forEach(function (role) { groups[role].sort(byName); }); });
    return {nodes:nodes, edges:edges, links:links, ordered:Array.from(nodes.values()).sort(byName)};
  }
  function neighbors(index, id) {
    return index.links.get(id) || {parents:[], children:[], related:[]};
  }
  function search(index, query) {
    var words = String(query || '').trim().toLowerCase().split(/\s+/);
    return index.ordered.filter(function (node) {
      var title = node.title.toLowerCase();
      return words.every(function (word) { return title.includes(word); });
    });
  }

  // A small ring keeps labels apart even for eight neighbours. Direct contributions
  // occupy northern/southern slots first and related problems use the side slots.
  var ring = [[-203,-117],[0,-180],[203,-117],[292,0],[203,117],[0,180],[-203,117],[-292,0]];
  var slots = {parents:[0,2,1,7,3,6,4,5], children:[6,4,5,7,3,0,2,1], related:[7,3,0,4,2,6,1,5]};
  function focused(index, node) {
    var groups = neighbors(index, node.id), picked = [], usedIds = new Set([node.id]), usedSlots = new Set();
    var points = [Object.assign({}, node, {x:0, y:0})];
    // Give each relation type a place before filling the remaining slots.
    for (var n = 0; picked.length < NEIGHBOR_SIZE && roles.some(function (role) { return n < groups[role].length; }); n++) {
      roles.forEach(function (role) {
        var next = groups[role][n];
        if (next && picked.length < NEIGHBOR_SIZE && !usedIds.has(next.id)) {
          usedIds.add(next.id);
          picked.push({node:next, role:role});
        }
      });
    }
    picked.forEach(function (entry) {
      var slot = slots[entry.role].find(function (s) { return !usedSlots.has(s); });
      usedSlots.add(slot);
      points.push(Object.assign({}, entry.node, {x:ring[slot][0], y:ring[slot][1]}));
    });
    return {points:points, total:1 + new Set(roles.flatMap(function (r) { return groups[r].map(function (v) {return v.id;}); })).size};
  }

  function overview(index) {
    var placed = new Map(), points = [], row = 0;
    function degree(node) {
      var group = index.links.get(node.id);
      return group.parents.length + group.children.length + group.related.length;
    }
    function priority(a, b) {
      return index.links.get(b.id).parents.length - index.links.get(a.id).parents.length || degree(b) - degree(a) || byName(a,b);
    }
    function nearby(node) {
      var links = index.links.get(node.id);
      return links.parents.concat(links.children, links.related);
    }
    function addLayer(nodes) {
      // Place each layer near its visible connections from previous layers.
      var entries = nodes.map(function (node) {
        var drawn = nearby(node).map(function (n) { return placed.get(n.id); }).filter(Boolean);
        var x = drawn.length ? drawn.reduce(function (sum, p) { return sum + p.x; }, 0) / drawn.length : 0;
        return {node:node, x:x};
      }).sort(function (a,b) { return a.x-b.x || byName(a.node,b.node); });
      for (var start = 0; start < entries.length; start += 4) {
        var line = entries.slice(start,start+4), centre = line.reduce(function (sum,e) {return sum+e.x;},0) / line.length;
        line.forEach(function (e,i) {
          var p = Object.assign({}, e.node, {x:centre+(i-(line.length-1)/2)*206, y:row*148});
          placed.set(p.id,p); points.push(p);
        });
        row++;
      }
    }
    var goals = index.ordered.filter(function (n) { return n.kind !== 'problem'; }).sort(function (a,b) {
      return roleOrder[a.kind]-roleOrder[b.kind] || degree(b)-degree(a) || byName(a,b);
    }).slice(0,6);
    var problems = index.ordered.filter(function (n) { return n.kind === 'problem'; });
    var frontier = goals;
    addLayer(goals);
    // Focus the overview on branches that are actually linked to objectives. If none
    // has a link yet, show a connected problem or some independent starting points.
    if (!goals.some(function (n) { return degree(n) > 0; }) && problems.length) {
      var ranked = problems.slice().sort(priority);
      frontier = degree(ranked[0]) ? [ranked[0]] : ranked.slice(0, OVERVIEW_SIZE - placed.size);
      addLayer(frontier);
    }
    while (frontier.length && placed.size < OVERVIEW_SIZE && row < 4) {
      var next = new Map();
      frontier.forEach(function (node) {
        nearby(node).forEach(function (candidate) {
          if (!placed.has(candidate.id)) next.set(candidate.id, candidate);
        });
      });
      frontier = Array.from(next.values()).sort(priority).slice(0,OVERVIEW_SIZE-placed.size);
      addLayer(frontier);
    }
    return {points:points, total:index.nodes.size};
  }

  function project(index, focusId) {
    var focus = index.nodes.get(focusId), view = focus ? focused(index,focus) : overview(index);
    var points = view.points;
    // Centre sparse drawings rather than leaving a single branch in a corner.
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var minX = points.length ? Math.min.apply(null,xs) : 0, maxX = points.length ? Math.max.apply(null,xs) : 0;
    var minY = points.length ? Math.min.apply(null,ys) : 0, maxY = points.length ? Math.max.apply(null,ys) : 0;
    var width = Math.max(400,maxX-minX+192), height = Math.max(245,maxY-minY+120);
    points.forEach(function (p) {
      p.x += (width-minX-maxX)/2;
      p.y += (height-minY-maxY)/2 - 12;
    });
    var visible = new Set(points.map(function (node) { return node.id; }));
    var edges = index.edges.filter(function (e) { return visible.has(e.from) && visible.has(e.to); });
    return {nodes:points, edges:edges, width:width, height:height, focusId:focus ? focus.id : null, omitted:view.total-points.length};
  }
  root.BoldResearchGraphModel = {build:build, search:search, neighbors:neighbors, project:project};
})(window);
