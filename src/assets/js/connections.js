// Who did what with whom (interactions/{id}, written by the server: functions/index.js
// "Interactions"), drawn three ways, in ink on paper:
// - Graph: people (rings in their group's colour, Who is BOLD) and the things they
//   interacted on (projects and papers, events, guides and the BOLDiquette, skills: small
//   shapes), joined by hairlines patterned by kind. On a profile (Connections) the person is
//   at the middle, what they've interacted with around them and what's two steps away
//   faded on an outer ring; on the Network page, everyone on concentric rings, the most
//   connected at the middle.
// - Over time (Connections): a row for each person or thing, from the first interaction to
//   the last, a mark for each.
// - Lineage (Network): who brought whom into BOLD, as a tree.
// Nothing here needs a library.
window.BoldConnections = (function(){
  var esc = BOLD.escapeHtml;
  var GROUPS = [['joining', 'Joining'], ['working', 'Working together'], ['talking', 'Talking'], ['site', 'On the site']];
  // kind → what it says, with {a} who did it, {b} the other person ({bs}: theirs), {t} where.
  var SAYS = {
    asked: '{a} asked to join BOLD', 'signed-up': '{a} first signed in to BOLD.OS',
    invited: '{a} invited {b} to the BOLD Slack', approved: '{a} approved {bs} request to join',
    contact: '{a} is {bs} point of contact', supervises: '{a} supervises {b}',
    coauthor: '{a} and {b} work together on {t}', project: '{a} joined {b} on {t}', reviewed: '{a} reviewed {bs} {t}',
    meeting: '{a} joined {bs} supervision meeting', introduced: '{a} made an introduction for {b}', letter: '{a} asked {b} for a recommendation letter',
    tagged: '{a} tagged {b} in {t}', replied: '{a} replied to {b} on {t}', decided: '{a} decided {bs} proposed change to {t}',
    registered: '{a} registered {t}', added: '{a} added {t}', edited: '{a} edited {t}', proposed: '{a} proposed a change to {t}',
    commented: '{a} commented on {t}', read: '{a} read {t}',
  };
  var JOINING_FIRST = ['asked', 'signed-up', 'invited', 'contact', 'approved', 'supervises'];
  // Things: their shape and what they're called.
  var THINGS = { project: ['square', 'Projects and papers'], event: ['diamond', 'Events'], session: ['diamond', 'Events'], talk: ['diamond', 'Events'],
    guide: ['page', 'Guides and the BOLDiquette'], handbook: ['page', 'Guides and the BOLDiquette'], skill: ['triangle', 'Skills'] };
  // Lineage: who brought someone in, the first of these that's known.
  var LINEAGE = [['invited', 'invited'], ['contact', 'via contact'], ['supervises', 'via supervisor'], ['approved', 'approved']];

  function db(){ return firebase.firestore(BOLD.getApp()); }
  function lower(e){ return String(e || '').toLowerCase(); }
  function groupIndex(g){ for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][0] === g) return i; return 9; }

  // Everyone's names, Slack ids and groups → { email: { name, id, group, member } }.
  function directory(){
    return Promise.all([db().collection('people').get(), db().collection('members').get()]).then(function(r){
      var out = {};
      r[0].docs.forEach(function(d){ var p = d.data(), e = lower(p.email); if (e) out[e] = { name: p.name || e, id: d.id, group: 'pan' }; });
      r[1].docs.forEach(function(d){
        var m = d.data(), e = lower(d.id);
        out[e] = Object.assign(out[e] || { id: '' }, { name: (out[e] && out[e].name) || m.name || e, group: BoldJoin.groupOf(m), member: true });
      });
      return out;
    });
  }
  function isThing(id){ return String(id).indexOf('thing:') === 0; }
  function nameOf(dir, e, g){
    if (isThing(e)) { var t = g && g.byId && g.byId[e]; return (t && t.title) || e.split(':').pop(); }
    return (dir[e] && dir[e].name) || String(e).split('@')[0];
  }
  function hrefOf(dir, e, me, g){
    if (isThing(e)) { var t = g && g.byId && g.byId[e]; return (t && t.href) || ''; }
    if (me && e === me) return 'profile.html#connections';
    return dir[e] && dir[e].id ? 'person.html?id=' + encodeURIComponent(dir[e].id) + '#connections' : '';
  }

  // The interactions of one person (theirs and those involving them), newest first.
  function loadFor(email){
    var col = db().collection('interactions');
    return Promise.all([col.where('from', '==', email).get(), col.where('to', '==', email).get()]).then(function(r){
      var seen = {}, out = [];
      r[0].docs.concat(r[1].docs).forEach(function(d){ if (!seen[d.id]) { seen[d.id] = 1; out.push(Object.assign({ id: d.id }, d.data())); } });
      return out.sort(function(a, b){ return b.at - a.at; });
    });
  }
  // Every interaction.
  function loadAll(){
    return db().collection('interactions').get().then(function(s){ return s.docs.map(function(d){ return d.data(); }); });
  }

  // Interactions → { nodes: [{ id, thing?, type?, title?, href? }], edges: [{ a, b, n, groups, main }], byId }.
  // With things, an interaction on a thing joins each person in it to the thing (once per
  // kind and moment, so the authors of a paper aren't counted for every pair of them);
  // without, or with nothing to be on, it joins the two people.
  function graphOf(list, things){
    var edges = {}, nodes = {}, seen = {};
    var node = function(id){ return nodes[id] || (nodes[id] = { id: id }); };
    var edge = function(a, b, x){
      if (a === b) return;
      if (b < a) { var t = a; a = b; b = t; }
      var k = a + ' ' + b, once = k + ' ' + x.kind + ' ' + x.at;
      if (seen[once]) return;
      seen[once] = 1;
      var e = edges[k] || (edges[k] = { a: a, b: b, n: 0, groups: {} });
      e.n++; e.groups[x.group] = (e.groups[x.group] || 0) + 1;
      node(a); node(b);
    };
    list.forEach(function(x){
      if (things && x.thing) {
        var id = 'thing:' + x.thing, v = node(id);
        v.thing = true; v.type = x.thing.split(':')[0];
        if (!v.title || x.kind === 'registered' || x.kind === 'added') v.title = x.title;
        if (!v.href) v.href = String(x.href || '').replace(/#.*$/, '');
        edge(x.from, id, x);
        if (x.to) edge(x.to, id, x);
      } else if (x.to) edge(x.from, x.to, x);
    });
    var out = Object.keys(edges).map(function(k){
      var e = edges[k];
      e.main = Object.keys(e.groups).sort(function(p, q){ return e.groups[q] - e.groups[p] || groupIndex(p) - groupIndex(q); })[0];
      return e;
    });
    var g = { nodes: Object.keys(nodes).map(function(id){ return nodes[id]; }), edges: out, byId: nodes };
    return g;
  }

  // A stable pseudo-random number in [0, 1) for a string, so a graph lays out the same each time.
  function seed(s){ var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

  // Whole-lab layout: concentric rings, the most connected at the middle and each ring out
  // less connected than the last (outer rings hold more, as they're longer). Within a ring,
  // each node sits towards what it's linked to further in, so neighbours stay near; a few
  // sweeps in and out settle the order.
  function concentric(g, w, h){
    var n = g.nodes.length, byId = g.byId, deg = {}, adj = {};
    if (!n) return;
    g.edges.forEach(function(e){
      deg[e.a] = (deg[e.a] || 0) + e.n; deg[e.b] = (deg[e.b] || 0) + e.n;
      (adj[e.a] = adj[e.a] || []).push([e.b, e.n]); (adj[e.b] = adj[e.b] || []).push([e.a, e.n]);
    });
    var order = g.nodes.slice().sort(function(p, q){ return (deg[q.id] || 0) - (deg[p.id] || 0) || (p.id < q.id ? -1 : 1); });
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 40, sx = w / Math.min(w, h) * 0.94;
    var m = Math.max(1, Math.min(6, Math.round(Math.sqrt(n) / 1.4))), rings = [[order[0]]], rest = order.slice(1);
    var total = m * (m + 1) / 2;
    for (var i = 1; i <= m; i++) {
      var take = i === m ? rest.length : Math.max(1, Math.round((n - 1) * i / total));
      rings.push(rest.splice(0, take));
    }
    rings = rings.filter(function(r){ return r.length; });
    var place = function(v, a, ring){ v.angle = a; v.ring = ring; var r = R * ring / (rings.length - 1 || 1); v.x = cx + Math.cos(a) * r * sx; v.y = cy + Math.sin(a) * r; };
    place(rings[0][0], 0, 0); rings[0][0].angle = undefined;
    rings.forEach(function(ring, k){ if (k) ring.forEach(function(v, i){ place(v, -Math.PI / 2 + i * 2 * Math.PI / ring.length, k); }); });
    // The direction a node's links pull it: the weighted mean of where they are.
    var pull = function(v, inner){
      var x = 0, y = 0;
      (adj[v.id] || []).forEach(function(l){
        var o = byId[l[0]];
        if (o.angle === undefined || (inner && o.ring >= v.ring)) return;
        x += Math.cos(o.angle) * l[1]; y += Math.sin(o.angle) * l[1];
      });
      return x || y ? Math.atan2(y, x) : v.angle;
    };
    for (var sweep = 0; sweep < 6; sweep++) {
      var seq = sweep % 2 ? rings.slice(1).reverse() : rings.slice(1);
      seq.forEach(function(ring){
        var k = ring[0].ring, want = ring.map(function(v){ return { v: v, a: pull(v, sweep === 0) }; }).sort(function(p, q){ return p.a - q.a; });
        // Evenly spaced, in the order they pull, turned to sit as near their pull as can be.
        var step = 2 * Math.PI / ring.length, off = 0;
        if (want.length) {
          var sx2 = 0, sy2 = 0;
          want.forEach(function(o, i){ var d = o.a - i * step; sx2 += Math.cos(d); sy2 += Math.sin(d); });
          off = Math.atan2(sy2, sx2);
        }
        want.forEach(function(o, i){ place(o.v, off + i * step, k); });
      });
    }
  }

  // Ego layout: the person at the middle, what they've interacted with on a ring around
  // them, grouped by main kind and nearer the more they've interacted (two rings past 28);
  // what's two steps away (v.far) on an outer ring, each beside what links it in.
  function radial(g, w, h, centre){
    var byId = g.byId, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 56, sx = w / Math.min(w, h) * 0.92;
    var far = g.nodes.filter(function(v){ return v.far; });
    var R1 = far.length ? R * 0.58 : R;
    var others = g.edges.filter(function(e){ return e.a === centre || e.b === centre; }).map(function(e){ return { id: e.a === centre ? e.b : e.a, e: e }; })
      .sort(function(p, q){ return groupIndex(p.e.main) - groupIndex(q.e.main) || (byId[p.id].thing ? 1 : 0) - (byId[q.id].thing ? 1 : 0) || q.e.n - p.e.n; });
    var max = Math.max.apply(null, others.map(function(o){ return o.e.n; }).concat([1]));
    if (byId[centre]) { byId[centre].x = cx; byId[centre].y = cy; byId[centre].angle = undefined; }
    others.forEach(function(o, i){
      var a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, others.length);
      var near = max > 1 ? Math.log(o.e.n) / Math.log(max) : 0;
      var r = R1 * (1 - 0.38 * near) * (others.length > 28 && i % 2 ? 0.78 : 1);
      var v = byId[o.id]; v.x = cx + Math.cos(a) * r * sx; v.y = cy + Math.sin(a) * r; v.angle = a;
    });
    if (!far.length) return;
    // Each far node's angle: the average direction of what links it in, then spread so
    // neighbours on the ring keep a little apart.
    far.forEach(function(v){
      var sxv = 0, syv = 0;
      g.edges.forEach(function(e){
        var o = e.a === v.id ? byId[e.b] : e.b === v.id ? byId[e.a] : null;
        if (o && !o.far && o.angle !== undefined) { sxv += Math.cos(o.angle) * e.n; syv += Math.sin(o.angle) * e.n; }
      });
      v.angle = Math.atan2(syv, sxv) + (seed(v.id) - 0.5) * 0.05;
    });
    far.sort(function(p, q){ return p.angle - q.angle; });
    var gap = Math.min(0.2, 2 * Math.PI / far.length * 0.9);
    for (var it = 0; it < 60; it++) for (var i = 0; i < far.length; i++) {
      var p = far[i], q = far[(i + 1) % far.length], d = q.angle - p.angle + (i === far.length - 1 ? 2 * Math.PI : 0);
      if (far.length > 1 && d < gap) { p.angle -= (gap - d) / 2; q.angle += (gap - d) / 2; }
    }
    far.forEach(function(v, i){
      var r = R * (far.length > 40 && i % 2 ? 0.9 : 1);
      v.x = cx + Math.cos(v.angle) * r * sx; v.y = cy + Math.sin(v.angle) * r;
    });
  }

  // A line from p to q, bowed a little to one side (always the same side for a pair).
  function curve(p, q, bend){
    var mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, dx = q.x - p.x, dy = q.y - p.y;
    var cx = mx - dy * bend, cy = my + dx * bend, f = function(n){ return n.toFixed(1); };
    return 'M' + f(p.x) + ' ' + f(p.y) + 'Q' + f(cx) + ' ' + f(cy) + ' ' + f(q.x) + ' ' + f(q.y);
  }

  // A thing's mark: a square (projects and papers), a diamond (events), a page (guides,
  // the BOLDiquette) or a triangle (skills), about r across.
  function shape(type, r){
    var s = (THINGS[type] || ['square'])[0], f = function(n){ return n.toFixed(1); };
    if (s === 'diamond') return '<path class="cx-mark" d="M0 ' + f(-r * 1.3) + 'L' + f(r * 1.3) + ' 0L0 ' + f(r * 1.3) + 'L' + f(-r * 1.3) + ' 0Z"></path>';
    if (s === 'page') return '<path class="cx-mark" d="M' + f(-r * 0.8) + ' ' + f(-r * 1.1) + 'H' + f(r * 0.4) + 'L' + f(r * 0.8) + ' ' + f(-r * 0.7) + 'V' + f(r * 1.1) + 'H' + f(-r * 0.8) + 'Z"></path>';
    if (s === 'triangle') return '<path class="cx-mark" d="M0 ' + f(-r * 1.2) + 'L' + f(r * 1.15) + ' ' + f(r * 0.85) + 'H' + f(-r * 1.15) + 'Z"></path>';
    return '<rect class="cx-mark" x="' + f(-r) + '" y="' + f(-r) + '" width="' + f(r * 2) + '" height="' + f(r * 2) + '"></rect>';
  }
  // A node's mark: a ring for a person, a shape for a thing.
  function mark(v, r){ return v.thing ? shape(v.type, r) : '<circle class="cx-mark" r="' + r.toFixed(1) + '"></circle>'; }
  function nodeClass(dir, v){
    if (v.thing) return 'is-thing';
    var d = dir[v.id];
    return d && d.member ? 'pp-' + d.group : 'is-outside';
  }

  // The graph as SVG: people are rings in their group's colour, filled when chosen;
  // things are small shapes; lines are hairlines, thicker with more interactions, dotted
  // for joining, solid for working together, dashed for talking, fine dots on the site.
  // opts: { dir, me, centre, labels: 'all' | 'big', selected }.
  function svg(g, w, h, opts){
    var dir = opts.dir, byId = g.byId, degree = {};
    g.edges.forEach(function(e){ degree[e.a] = (degree[e.a] || 0) + e.n; degree[e.b] = (degree[e.b] || 0) + e.n; });
    var sel = opts.selected, near = {};
    if (sel) { near[sel] = 1; g.edges.forEach(function(e){ if (e.a === sel) near[e.b] = 1; if (e.b === sel) near[e.a] = 1; }); }
    var big = Object.keys(degree).sort(function(a, b){ return degree[b] - degree[a]; }).slice(0, 25);
    var radius = function(id){ return id === opts.centre ? 9 : 3.5 + Math.min(5.5, Math.sqrt(degree[id] || 1) * 1.1); };
    var label = function(id){ return nameOf(dir, id, g); };
    return '<svg class="cx-svg' + (opts.centre ? ' is-ego' : '') + (sel ? ' has-selected' : '') + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Who has interacted with whom, and on what">' +
      '<g class="cx-edges">' + g.edges.map(function(e){
        var p = byId[e.a], q = byId[e.b], lit = sel && (e.a === sel || e.b === sel);
        var parts = GROUPS.filter(function(x){ return e.groups[x[0]]; }).map(function(x){ return e.groups[x[0]] + ' ' + x[1].toLowerCase(); }).join(', ');
        return '<path class="cx-edge cx-' + e.main + (lit ? ' is-lit' : '') + (e.far ? ' is-far' : '') + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="' + curve(p, q, (seed(e.a + e.b) - 0.5) * 0.3) +
          '" stroke-width="' + (0.8 + Math.min(2.6, Math.log(e.n) * 0.9)).toFixed(2) + '"><title>' + esc(label(e.a) + ' and ' + label(e.b) + ': ' + parts) + '</title></path>';
      }).join('') + '</g>' +
      '<g class="cx-nodes">' + g.nodes.map(function(v){
        var cls = 'cx-node ' + nodeClass(dir, v) + (v.id === opts.centre ? ' is-centre' : '') + (near[v.id] ? ' is-lit' : '') + (v.id === sel ? ' is-selected' : '') + (v.far ? ' is-far' : '');
        var shown = (opts.labels === 'all' && !v.far) || v.id === opts.centre || near[v.id] || big.indexOf(v.id) >= 0;
        var r = radius(v.id) * (v.thing ? 0.85 : 1), lx = r + 5, ly = 4, anchor = 'start';
        if (v.id === opts.centre) { lx = 0; ly = r + 17; anchor = 'middle'; }
        else if (v.angle !== undefined) { var c = Math.cos(v.angle), sn = Math.sin(v.angle); anchor = c < -0.3 ? 'end' : c > 0.3 ? 'start' : 'middle'; lx = c * (r + 6); ly = sn * (r + 6) + (anchor === 'middle' ? (sn > 0 ? 12 : -4) : 4); }
        else if (v.x > w - 140) { anchor = 'end'; lx = -r - 5; }
        var name = label(v.id), text = v.thing && name.length > 34 ? name.slice(0, 32) + '…' : name;
        return '<g class="' + cls + '" data-id="' + esc(v.id) + '" transform="translate(' + v.x.toFixed(1) + ',' + v.y.toFixed(1) + ')" tabindex="0">' + mark(v, r) +
          '<text class="cx-label' + (v.thing ? ' is-thing-label' : '') + (shown ? '' : ' is-quiet') + '" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '">' + esc(text) + '</text>' +
          '<title>' + esc(name + (degree[v.id] ? ' · ' + degree[v.id] + ' interaction' + (degree[v.id] === 1 ? '' : 's') : '')) + '</title></g>';
      }).join('') + '</g></svg>';
  }

  // Hovering (or focusing) a node lights its lines and what's at their other end.
  function bindHover(root){
    var on = function(e){
      var n = e.target.closest && e.target.closest('.cx-node'), s = n && n.closest('.cx-svg');
      if (!s) return;
      var id = n.getAttribute('data-id');
      s.classList.add('is-hover');
      Array.prototype.forEach.call(s.querySelectorAll('.cx-edge'), function(p){
        var hit = p.getAttribute('data-a') === id || p.getAttribute('data-b') === id;
        p.classList.toggle('is-hot', hit);
        if (hit) [p.getAttribute('data-a'), p.getAttribute('data-b')].forEach(function(x){ var m = s.querySelector('.cx-node[data-id="' + CSS.escape(x) + '"]'); if (m) m.classList.add('is-hot'); });
      });
      n.classList.add('is-hot');
    };
    var off = function(e){
      var s = e.target.closest && e.target.closest('.cx-svg');
      if (!s) return;
      s.classList.remove('is-hover');
      Array.prototype.forEach.call(s.querySelectorAll('.is-hot'), function(x){ x.classList.remove('is-hot'); });
    };
    root.addEventListener('mouseover', on); root.addEventListener('focusin', on);
    root.addEventListener('mouseout', off); root.addEventListener('focusout', off);
  }

  // A short sample of a kind's line, for the legend and the timeline.
  function sample(group){
    return '<svg class="cx-sample cx-' + group + '" viewBox="0 0 26 6" aria-hidden="true"><path class="cx-edge cx-' + group + '" d="M1 3H25"></path></svg>';
  }
  function legendHtml(things){
    var icon = function(inner){ return '<svg class="cx-icon" viewBox="-7 -7 14 14" aria-hidden="true">' + inner + '</svg>'; };
    return '<div class="cx-legend">' + GROUPS.slice(0, things ? 4 : 3).map(function(x){ return '<span class="cx-key">' + sample(x[0]) + esc(x[1]) + '</span>'; }).join('') +
      '<span class="cx-key">' + icon('<circle class="cx-ring" r="4.2"></circle>') + '<span>A person, ringed in their group in <a href="boldiquette.html#who-is-bold">Who is BOLD</a></span></span>' +
      (things ? ['project', 'event', 'guide', 'skill'].map(function(t){ return '<span class="cx-key is-thing">' + icon(shape(t, 4)) + esc(THINGS[t][1]) + '</span>'; }).join('') : '') + '</div>';
  }

  function sentence(x, dir, me){
    var who = function(e){
      var h = hrefOf(dir, e, me), n = e === me ? 'you' : nameOf(dir, e);
      return h && e !== me ? '<a href="' + esc(h) + '">' + esc(n) + '</a>' : esc(n);
    };
    var t = x.href ? '<a href="' + esc(x.href) + '">' + esc(x.title) + '</a>' : esc(x.title);
    var whose = function(e){ return e === me ? 'your' : who(e) + '’s'; };
    var s = (SAYS[x.kind] || '{a}: {t}').replace('{a}', who(x.from)).replace('{bs}', whose(x.to)).replace('{b}', who(x.to)).replace('{t}', t);
    return s.charAt(0) === 'y' ? 'Y' + s.slice(1) : s;
  }
  function day(ms){ return ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

  // A person's timeline: how they came to BOLD first (oldest first), then everything
  // else, newest first, by kind.
  function timelineHtml(list, dir, person, me, shown){
    var start = list.filter(function(x){ return JOINING_FIRST.indexOf(x.kind) >= 0 && (x.to === person || (x.from === person && !x.to)); })
      .sort(function(a, b){ return a.at - b.at; });
    var rest = list.filter(function(x){ return start.indexOf(x) < 0; });
    var row = function(x){ return '<li class="cx-row"><span class="cx-when">' + day(x.at) + '</span><span class="cx-kind" title="' + esc(GROUPS[groupIndex(x.group)] ? GROUPS[groupIndex(x.group)][1] : '') + '">' + sample(x.group) + '</span><span class="cx-what">' + sentence(x, dir, me) + '</span></li>'; };
    return (start.length ? '<div class="md-group"><h3>Coming to BOLD</h3><ul class="cx-timeline">' + start.map(row).join('') + '</ul></div>' : '') +
      '<div class="md-group"><h3>Since</h3>' + (rest.length ? '<ul class="cx-timeline">' + rest.slice(0, shown).map(row).join('') + '</ul>' +
        (rest.length > shown ? '<button type="button" class="btn-text cx-more">Show more (' + (rest.length - shown) + ')</button>' : '') : '<p class="proj-msg">Nothing yet.</p>') + '</div>';
  }

  // Over time: a row for each person and thing `person` has interacted with (and one for
  // coming to BOLD), first interaction first; a hairline from the first to the last, a
  // mark for each, shaped by kind. Up to 60 rows.
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function timeHtml(list, dir, person, me, things){
    var rows = {}, order = [];
    var g = { byId: {} };
    list.forEach(function(x){
      if (!x.at) return;
      var key, label, node;
      if (things && x.thing) { key = 'thing:' + x.thing; node = g.byId[key] || (g.byId[key] = { id: key, thing: true, type: x.thing.split(':')[0], title: x.title, href: String(x.href || '').replace(/#.*$/, '') }); }
      else if (x.to && (x.from === person || x.to === person)) { key = x.from === person ? x.to : x.from; node = { id: key }; }
      else if (JOINING_FIRST.indexOf(x.kind) >= 0) { key = 'self'; node = { id: 'self' }; }
      else return;
      var r = rows[key] || (rows[key] = { node: node, marks: [] });
      if (!r.first) order.push(r);
      r.first = Math.min(r.first || Infinity, x.at); r.last = Math.max(r.last || 0, x.at);
      r.marks.push(x);
    });
    order.sort(function(a, b){ return a.first - b.first; });
    var extra = order.length - 60; order = order.slice(0, 60);
    if (!order.length) return '<p class="proj-msg">Nothing yet.</p>';
    var t0 = order[0].first, t1 = Math.max(Date.now(), t0 + 86400000 * 30);
    var W = 760, L = 190, ROW = 24, TOP = 30, H = TOP + order.length * ROW + 10;
    var X = function(t){ return L + (t - t0) / (t1 - t0) * (W - L - 16); };
    // A tick at the start of each month (each quarter past two years).
    var ticks = [], d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    var step = (t1 - t0) > 2 * 365 * 86400000 ? 3 : 1;
    while (d.getTime() < t1) { ticks.push(new Date(d)); d.setMonth(d.getMonth() + step); }
    var html = '<svg class="cx-svg cx-time" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Interactions over time">' +
      ticks.map(function(t){
        var x = X(t.getTime());
        return '<line class="cx-tick" x1="' + x.toFixed(1) + '" y1="' + (TOP - 8) + '" x2="' + x.toFixed(1) + '" y2="' + (H - 6) + '"></line>' +
          '<text class="cx-axis" x="' + x.toFixed(1) + '" y="' + (TOP - 14) + '" text-anchor="middle">' + MONTHS[t.getMonth()] + (t.getMonth() === 0 || t === ticks[0] ? ' ' + String(t.getFullYear()).slice(2) : '') + '</text>';
      }).join('');
    order.forEach(function(r, i){
      var y = TOP + i * ROW + ROW / 2, v = r.node;
      var name = v.id === 'self' ? 'Coming to BOLD' : v.thing ? v.title : (v.id === me ? 'You' : nameOf(dir, v.id));
      var href = v.id === 'self' ? '' : v.thing ? v.href : hrefOf(dir, v.id, me);
      var cls = v.id === 'self' ? 'is-self' : nodeClass(dir, v);
      var text = name.length > 26 ? name.slice(0, 24) + '…' : name;
      html += '<g class="cx-node cx-trow ' + cls + '" data-id="' + esc(v.id) + '" data-href="' + esc(href) + '" tabindex="0">' +
        '<g transform="translate(' + (L - 10) + ',' + y + ')">' + (v.id === 'self' ? '<circle class="cx-mark" r="3.5"></circle>' : mark(v, 4)) + '</g>' +
        '<text class="cx-label' + (v.thing ? ' is-thing-label' : '') + '" x="' + (L - 20) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(text) + '</text>' +
        '<line class="cx-span" x1="' + X(r.first).toFixed(1) + '" y1="' + y + '" x2="' + X(r.last).toFixed(1) + '" y2="' + y + '"></line>' +
        r.marks.map(function(x){
          return '<circle class="cx-dot cx-' + x.group + '" cx="' + X(x.at).toFixed(1) + '" cy="' + y + '" r="3"><title>' + esc(day(x.at) + ': ' + sentence(x, dir, me).replace(/<[^>]+>/g, '')) + '</title></circle>';
        }).join('') + '<title>' + esc(name) + '</title></g>';
    });
    return '<div class="cx-graph">' + html + '</svg></div>' +
      '<div class="cx-legend">' + GROUPS.map(function(x){ return '<span class="cx-key"><svg class="cx-icon" viewBox="-7 -7 14 14" aria-hidden="true"><circle class="cx-dot cx-' + x[0] + '" r="3.2"></circle></svg>' + esc(x[1]) + '</span>'; }).join('') + '</div>' +
      (extra > 0 ? '<p class="proj-meta">And ' + extra + ' more, in the list below.</p>' : '');
  }

  // Lineage: who brought whom into BOLD (LINEAGE: whoever invited them, else their point
  // of contact, else a supervisor, else who approved them), as a tree from those nobody
  // brought in, the biggest family first. → SVG, or '' if nothing's known.
  function lineageHtml(all, dir, me){
    var parent = {};
    LINEAGE.forEach(function(k){
      all.forEach(function(x){ if (x.kind === k[0] && x.to && x.from !== x.to && !parent[x.to]) parent[x.to] = { from: x.from, how: k[1] }; });
    });
    // No loops: drop a parent that would make someone their own ancestor.
    Object.keys(parent).forEach(function(c){
      var seen = {}, p = c;
      while (parent[p] && !seen[p]) { seen[p] = 1; p = parent[p].from; }
      if (seen[p] || p === c) delete parent[c];
    });
    var kids = {};
    Object.keys(parent).forEach(function(c){ (kids[parent[c].from] = kids[parent[c].from] || []).push(c); });
    var size = function(id){ return 1 + (kids[id] || []).reduce(function(s, c){ return s + size(c); }, 0); };
    var roots = Object.keys(kids).filter(function(id){ return !parent[id]; }).sort(function(a, b){ return size(b) - size(a) || nameOf(dir, a).localeCompare(nameOf(dir, b)); });
    if (!roots.length) return '';
    var rows = [];
    var walk = function(id, depth){
      rows.push({ id: id, depth: depth });
      (kids[id] || []).sort(function(a, b){ return size(b) - size(a) || nameOf(dir, a).localeCompare(nameOf(dir, b)); }).forEach(function(c){ walk(c, depth + 1); });
    };
    roots.forEach(function(r){ walk(r, 0); });
    var COL = 150, ROW = 26, TOP = 14, depth = Math.max.apply(null, rows.map(function(r){ return r.depth; }));
    var W = Math.max(760, 40 + depth * COL + 260), H = TOP + rows.length * ROW + 10, at = {};
    rows.forEach(function(r, i){ r.x = 24 + r.depth * COL; r.y = TOP + i * ROW + ROW / 2; at[r.id] = r; });
    return '<div class="cx-graph cx-scroll"><svg class="cx-svg cx-lineage" viewBox="0 0 ' + W + ' ' + H + '" style="min-width:' + Math.min(W, 1100) + 'px" role="img" aria-label="Who brought whom into BOLD">' +
      rows.map(function(r){
        if (!parent[r.id]) return '';
        var p = at[parent[r.id].from];
        return '<path class="cx-edge cx-elbow" d="M' + p.x + ' ' + (p.y + 6) + 'V' + r.y + 'H' + (r.x - 7) + '"></path>';
      }).join('') +
      rows.map(function(r){
        var v = { id: r.id }, href = hrefOf(dir, r.id, me), name = r.id === me ? 'You' : nameOf(dir, r.id);
        var how = parent[r.id] ? parent[r.id].how : '';
        return '<g class="cx-node ' + nodeClass(dir, v) + '" data-id="' + esc(r.id) + '" data-href="' + esc(href) + '" transform="translate(' + r.x + ',' + r.y + ')" tabindex="0">' + mark(v, 5) +
          '<text class="cx-label" x="10" y="4">' + esc(name) + (how ? '<tspan class="cx-how" dx="8">' + esc(how) + '</tspan>' : '') + '</text>' +
          '<title>' + esc(name + (how ? ' · ' + how + (how.indexOf('via') === 0 ? ' ' : ' by ') + nameOf(dir, parent[r.id].from) : '') + (kids[r.id] ? ' · brought in ' + (size(r.id) - 1) : '')) + '</title></g>';
      }).join('') + '</svg></div>';
  }

  // Connections for `email` into `root`: Graph (two steps) or Over time, then the
  // timeline. me: the signed-in person's email.
  function mountPerson(root, email, me){
    email = lower(email); me = lower(me);
    root.innerHTML = '<p class="proj-msg">Loading&hellip;</p>';
    // steps: 2, or 1 if everyone's interactions couldn't be loaded.
    var shown = 30, filter = 'all', steps = 2, everyone = null, view = 'graph', things = true, g = null;
    Promise.all([loadFor(email), directory()]).then(function(r){
      var list = r[0], dir = r[1];
      function graphHtml(){
        if (steps === 2 && !everyone) { loadAll().then(function(a){ everyone = a; draw(); }).catch(function(err){ console.error('[BOLD Connections] loading everyone failed', err); steps = 1; draw(); }); }
        var kind = function(x){ return (x.to || (things && x.thing)) && (filter === 'all' || x.group === filter); };
        var direct = list.filter(kind);
        g = graphOf(direct, things);
        // The inner ring: what's joined to them directly. (With things, a co-author is
        // joined to them through the paper, so is a step further out.)
        var first = {};
        g.edges.forEach(function(e){ if (e.a === email) first[e.b] = 1; if (e.b === email) first[e.a] = 1; });
        var mark = function(){
          g.edges.forEach(function(e){ e.far = e.a !== email && e.b !== email; });
          g.nodes.forEach(function(v){ v.far = v.id !== email && !first[v.id]; });
        };
        mark();
        // Two steps: what they've interacted with, and whatever that has interacted with
        // (up to 60, the most connected first), faded.
        if (steps === 2 && everyone) {
          var ends = function(x){ return [x.from, x.to, things && x.thing ? 'thing:' + x.thing : ''].filter(Boolean); };
          var more = everyone.filter(function(x){ return kind(x) && x.from !== email && x.to !== email && ends(x).some(function(e){ return first[e]; }); });
          var weight = {};
          more.forEach(function(x){ ends(x).forEach(function(e){ if (!first[e]) weight[e] = (weight[e] || 0) + 1; }); });
          var keep = {};
          Object.keys(weight).sort(function(a, b){ return weight[b] - weight[a]; }).slice(0, 60).forEach(function(e){ keep[e] = 1; });
          more = more.filter(function(x){ return ends(x).every(function(e){ return first[e] || keep[e]; }); });
          g = graphOf(direct.concat(more), things);
          mark();
        }
        if (!g.nodes.length) { g.nodes.push({ id: email }); g.byId[email] = g.nodes[0]; }
        var w = 760, h = Math.max(380, Math.min(steps === 2 ? 720 : 620, 300 + g.nodes.length * 8));
        radial(g, w, h, email);
        return '<div class="cx-graph">' + svg(g, w, h, { dir: dir, me: me, centre: email, labels: 'all' }) + '</div>' + legendHtml(things);
      }
      function draw(){
        var counts = {};
        list.forEach(function(x){ counts[x.group] = (counts[x.group] || 0) + 1; });
        var toggle = function(label, attr, opts, cur){
          return '<div class="view-toggle cx-filter" role="group" aria-label="' + label + '">' + opts.map(function(x){
            return '<button type="button" class="view-btn" ' + attr + '="' + x[0] + '" aria-pressed="' + (String(cur) === String(x[0])) + '">' + esc(x[1]) + '</button>';
          }).join('') + '</div>';
        };
        root.innerHTML = '<div class="cx-controls">' +
          toggle('View', 'data-view', [['graph', 'Graph'], ['time', 'Over time']], view) +
          toggle('Show', 'data-cx', [['all', 'All']].concat(GROUPS.map(function(x){ return [x[0], x[1] + (counts[x[0]] ? ' · ' + counts[x[0]] : '')]; })), filter) +
          toggle('With', 'data-things', [['1', 'People and things'], ['0', 'People']], things ? '1' : '0') + '</div>' +
          (view === 'time' ? timeHtml(list.filter(function(x){ return filter === 'all' || x.group === filter; }), dir, email, me, things) : graphHtml()) +
          timelineHtml(list.filter(function(x){ return filter === 'all' || x.group === filter; }), dir, email, me, shown);
      }
      bindHover(root);
      root.addEventListener('click', function(e){
        var b = e.target.closest('[data-cx]'), v = e.target.closest('[data-view]'), t = e.target.closest('[data-things]');
        if (b) { filter = b.getAttribute('data-cx'); draw(); return; }
        if (v) { view = v.getAttribute('data-view'); draw(); return; }
        if (t) { things = t.getAttribute('data-things') === '1'; draw(); return; }
        if (e.target.closest('.cx-more')) { shown += 50; draw(); return; }
        var n = e.target.closest('.cx-node');
        if (!n || n.getAttribute('data-id') === email) return;
        var h = n.getAttribute('data-href') || hrefOf(dir, n.getAttribute('data-id'), me, g);
        if (h) location.href = h;
      });
      draw();
    }).catch(function(err){
      console.error('[BOLD Connections] loading failed', err);
      root.innerHTML = '<p class="proj-msg">Couldn’t load the connections. Try reloading the page.</p>';
    });
  }

  return { GROUPS: GROUPS, directory: directory, loadAll: loadAll, graphOf: graphOf, concentric: concentric, svg: svg, legendHtml: legendHtml, bindHover: bindHover,
    lineageHtml: lineageHtml, nameOf: nameOf, hrefOf: hrefOf, isThing: isThing, mountPerson: mountPerson };
})();
