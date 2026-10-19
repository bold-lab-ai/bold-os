// Who did what with whom (interactions/{id}, written by the server: functions/index.js
// "Interactions"), drawn as a graph: Connections on a profile (ego: the person in the
// middle, everyone they've interacted with around them, and their timeline) and the
// Network page (everyone). People are dots coloured by their group in Who is BOLD
// (.pp-*); a line joins two people who have interacted, thicker the more they have,
// coloured by its kind: joining, working together or talking. The layout is a small
// force simulation, run to rest before drawing; nothing here needs a library.
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

  function db(){ return firebase.firestore(BOLD.getApp()); }
  function lower(e){ return String(e || '').toLowerCase(); }

  // Everyone's names, Slack ids and groups → { email: { name, id, group } }.
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
  function nameOf(dir, e){ return (dir[e] && dir[e].name) || String(e).split('@')[0]; }
  function hrefOf(dir, e, me){
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
  // Every interaction between two people.
  function loadAll(){
    return db().collection('interactions').where('group', 'in', ['joining', 'working', 'talking']).get().then(function(s){
      return s.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.to && x.from !== x.to; });
    });
  }

  // Interactions → { nodes: [{ id }], edges: [{ a, b, n, groups: { group: n }, main }] }.
  function graphOf(list){
    var edges = {}, nodes = {};
    list.forEach(function(x){
      if (!x.to) return;
      var a = x.from < x.to ? x.from : x.to, b = x.from < x.to ? x.to : x.from, k = a + ' ' + b;
      var e = edges[k] || (edges[k] = { a: a, b: b, n: 0, groups: {} });
      e.n++; e.groups[x.group] = (e.groups[x.group] || 0) + 1;
      nodes[a] = nodes[b] = 1;
    });
    var list2 = Object.keys(edges).map(function(k){
      var e = edges[k];
      e.main = Object.keys(e.groups).sort(function(p, q){ return e.groups[q] - e.groups[p]; })[0];
      return e;
    });
    return { nodes: Object.keys(nodes).map(function(id){ return { id: id }; }), edges: list2 };
  }

  // A stable pseudo-random number in [0, 1) for a string, so a graph lays out the same each time.
  function seed(s){ var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

  // Places g's nodes (x, y) in a w × h box: they push each other apart, lines pull
  // the people they join together (the more interactions, the harder) and a little
  // gravity keeps everyone in view. `fixed`: a node held at the middle.
  function layout(g, w, h, fixed){
    var n = g.nodes.length, byId = {};
    if (!n) return;
    var k = Math.sqrt(w * h / n) * 0.7, cx = w / 2, cy = h / 2;
    g.nodes.forEach(function(v){
      byId[v.id] = v;
      var a = seed(v.id) * Math.PI * 2, r = (0.05 + 0.3 * seed(v.id + '.')) * Math.min(w, h);
      v.x = cx + Math.cos(a) * r; v.y = cy + Math.sin(a) * r;
    });
    if (fixed && byId[fixed]) { byId[fixed].x = cx; byId[fixed].y = cy; }
    var temp = Math.min(w, h) / 6;
    for (var it = 0; it < 400; it++) {
      g.nodes.forEach(function(v){ v.dx = 0; v.dy = 0; });
      for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
        var p = g.nodes[i], q = g.nodes[j], dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy || 0.01;
        var f = k * k / d2;
        p.dx += dx * f; p.dy += dy * f; q.dx -= dx * f; q.dy -= dy * f;
      }
      g.edges.forEach(function(e){
        var p = byId[e.a], q = byId[e.b], dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = d / k * (1 + Math.log(e.n) * 0.5);
        p.dx -= dx * f; p.dy -= dy * f; q.dx += dx * f; q.dy += dy * f;
      });
      g.nodes.forEach(function(v){
        // Gravity, stretched to the box's shape, so loose people stay near the middle.
        v.dx += (cx - v.x) * 0.035 * h / w; v.dy += (cy - v.y) * 0.035;
        if (v.id === fixed) return;
        var d = Math.sqrt(v.dx * v.dx + v.dy * v.dy) || 1, s = Math.min(d, temp) / d;
        v.x = Math.max(30, Math.min(w - 30, v.x + v.dx * s));
        v.y = Math.max(20, Math.min(h - 20, v.y + v.dy * s));
      });
      temp = Math.max(1, temp * 0.985);
    }
  }

  // Ego layout: the person at the middle, the people they've interacted with on a ring
  // around them, grouped by their main kind and nearer the more they've interacted (two
  // rings past 28); people two steps away (v.far) on an outer ring, each beside the
  // people who link them in.
  function radial(g, w, h, centre){
    var byId = {}, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 56, sx = w / Math.min(w, h) * 0.92;
    g.nodes.forEach(function(v){ byId[v.id] = v; });
    var far = g.nodes.filter(function(v){ return v.far; });
    var R1 = far.length ? R * 0.58 : R;
    var others = g.edges.filter(function(e){ return e.a === centre || e.b === centre; }).map(function(e){ return { id: e.a === centre ? e.b : e.a, e: e }; })
      .sort(function(p, q){ return GROUPS.findIndex(function(x){ return x[0] === p.e.main; }) - GROUPS.findIndex(function(x){ return x[0] === q.e.main; }) || q.e.n - p.e.n; });
    var max = Math.max.apply(null, others.map(function(o){ return o.e.n; }).concat([1]));
    if (byId[centre]) { byId[centre].x = cx; byId[centre].y = cy; }
    others.forEach(function(o, i){
      var a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, others.length);
      var near = max > 1 ? Math.log(o.e.n) / Math.log(max) : 0;
      var r = R1 * (1 - 0.38 * near) * (others.length > 28 && i % 2 ? 0.78 : 1);
      var v = byId[o.id]; v.x = cx + Math.cos(a) * r * sx; v.y = cy + Math.sin(a) * r; v.angle = a;
    });
    if (!far.length) return;
    // Each far person's angle: the average direction of the people linking them in, then
    // spread so neighbours on the ring keep a little apart.
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

  // The graph as SVG, in ink on paper: people are rings in their group's colour (Who is
  // BOLD), filled when chosen; lines are hairlines, thicker with more interactions,
  // dotted for joining, solid for working together, dashed for talking.
  // opts: { dir, me, centre, labels: 'all' | 'big', selected }.
  function svg(g, w, h, opts){
    var dir = opts.dir, byId = {}, degree = {};
    g.nodes.forEach(function(v){ byId[v.id] = v; });
    g.edges.forEach(function(e){ degree[e.a] = (degree[e.a] || 0) + e.n; degree[e.b] = (degree[e.b] || 0) + e.n; });
    var sel = opts.selected, near = {};
    if (sel) { near[sel] = 1; g.edges.forEach(function(e){ if (e.a === sel) near[e.b] = 1; if (e.b === sel) near[e.a] = 1; }); }
    var big = Object.keys(degree).sort(function(a, b){ return degree[b] - degree[a]; }).slice(0, 25);
    var radius = function(id){ return id === opts.centre ? 9 : 3.5 + Math.min(5.5, Math.sqrt(degree[id] || 1) * 1.1); };
    return '<svg class="cx-svg' + (opts.centre ? ' is-ego' : '') + (sel ? ' has-selected' : '') + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Who has interacted with whom">' +
      '<g class="cx-edges">' + g.edges.map(function(e){
        var p = byId[e.a], q = byId[e.b], lit = sel && (e.a === sel || e.b === sel);
        var parts = GROUPS.filter(function(x){ return e.groups[x[0]]; }).map(function(x){ return e.groups[x[0]] + ' ' + x[1].toLowerCase(); }).join(', ');
        return '<path class="cx-edge cx-' + e.main + (lit ? ' is-lit' : '') + (e.far ? ' is-far' : '') + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="' + curve(p, q, (seed(e.a + e.b) - 0.5) * 0.3) +
          '" stroke-width="' + (0.8 + Math.min(2.6, Math.log(e.n) * 0.9)).toFixed(2) + '"><title>' + esc(nameOf(dir, e.a) + ' and ' + nameOf(dir, e.b) + ': ' + parts) + '</title></path>';
      }).join('') + '</g>' +
      '<g class="cx-nodes">' + g.nodes.map(function(v){
        var d = dir[v.id], cls = 'cx-node ' + (d && d.member ? 'pp-' + d.group : 'is-outside') + (v.id === opts.centre ? ' is-centre' : '') + (near[v.id] ? ' is-lit' : '') + (v.id === sel ? ' is-selected' : '') + (v.far ? ' is-far' : '');
        var label = (opts.labels === 'all' && !v.far) || v.id === opts.centre || near[v.id] || big.indexOf(v.id) >= 0;
        var r = radius(v.id), lx = r + 5, ly = 4, anchor = 'start';
        if (v.id === opts.centre) { lx = 0; ly = r + 17; anchor = 'middle'; }
        else if (v.angle !== undefined) { var c = Math.cos(v.angle), sn = Math.sin(v.angle); anchor = c < -0.3 ? 'end' : c > 0.3 ? 'start' : 'middle'; lx = c * (r + 6); ly = sn * (r + 6) + (anchor === 'middle' ? (sn > 0 ? 12 : -4) : 4); }
        else if (v.x > w - 140) { anchor = 'end'; lx = -r - 5; }
        return '<g class="' + cls + '" data-email="' + esc(v.id) + '" transform="translate(' + v.x.toFixed(1) + ',' + v.y.toFixed(1) + ')" tabindex="0">' +
          '<circle r="' + r.toFixed(1) + '"></circle>' +
          '<text class="cx-label' + (label ? '' : ' is-quiet') + '" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '">' + esc(nameOf(dir, v.id)) + '</text>' +
          '<title>' + esc(nameOf(dir, v.id) + (degree[v.id] ? ' · ' + degree[v.id] + ' interaction' + (degree[v.id] === 1 ? '' : 's') : '')) + '</title></g>';
      }).join('') + '</g></svg>';
  }

  // Hovering (or focusing) someone lights their lines and the people at the other end.
  function bindHover(root){
    var on = function(e){
      var n = e.target.closest && e.target.closest('.cx-node'), s = n && n.closest('.cx-svg');
      if (!s) return;
      var id = n.getAttribute('data-email');
      s.classList.add('is-hover');
      Array.prototype.forEach.call(s.querySelectorAll('.cx-edge'), function(p){
        var hit = p.getAttribute('data-a') === id || p.getAttribute('data-b') === id;
        p.classList.toggle('is-hot', hit);
        if (hit) [p.getAttribute('data-a'), p.getAttribute('data-b')].forEach(function(x){ var m = s.querySelector('.cx-node[data-email="' + CSS.escape(x) + '"]'); if (m) m.classList.add('is-hot'); });
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
  function legendHtml(){
    return '<div class="cx-legend">' + GROUPS.slice(0, 3).map(function(x){ return '<span class="cx-key">' + sample(x[0]) + esc(x[1]) + '</span>'; }).join('') +
      '<span class="cx-key"><svg class="cx-sample" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.2" class="cx-ring"></circle></svg><span>Ring: their group in <a href="boldiquette.html#who-is-bold">Who is BOLD</a></span></span></div>';
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
    var row = function(x){ return '<li class="cx-row"><span class="cx-when">' + day(x.at) + '</span><span class="cx-kind" title="' + esc((GROUPS.filter(function(gr){ return gr[0] === x.group; })[0] || ['', ''])[1]) + '">' + sample(x.group) + '</span><span class="cx-what">' + sentence(x, dir, me) + '</span></li>'; };
    return (start.length ? '<div class="md-group"><h3>Coming to BOLD</h3><ul class="cx-timeline">' + start.map(row).join('') + '</ul></div>' : '') +
      '<div class="md-group"><h3>Since</h3>' + (rest.length ? '<ul class="cx-timeline">' + rest.slice(0, shown).map(row).join('') + '</ul>' +
        (rest.length > shown ? '<button type="button" class="btn-text cx-more">Show more (' + (rest.length - shown) + ')</button>' : '') : '<p class="proj-msg">Nothing yet.</p>') + '</div>';
  }

  // Connections for `email` into `root`. me: the signed-in person's email.
  function mountPerson(root, email, me){
    email = lower(email); me = lower(me);
    root.innerHTML = '<p class="proj-msg">Loading&hellip;</p>';
    var shown = 30, filter = 'all', steps = 2, everyone = null;
    Promise.all([loadFor(email), directory()]).then(function(r){
      var list = r[0], dir = r[1];
      function draw(){
        if (steps === 2 && !everyone) { loadAll().then(function(a){ everyone = a; draw(); }).catch(function(err){ console.error('[BOLD Connections] loading everyone failed', err); steps = 1; draw(); }); }
        var kind = function(x){ return x.to && (filter === 'all' || x.group === filter); };
        var direct = list.filter(kind), g = graphOf(direct);
        // Two steps: the people they've interacted with, and whoever those people have
        // interacted with (up to 60, the most connected first), faded.
        if (steps === 2 && everyone) {
          var first = {};
          g.nodes.forEach(function(v){ if (v.id !== email) first[v.id] = 1; });
          var more = everyone.filter(function(x){ return kind(x) && x.from !== email && x.to !== email && (first[x.from] || first[x.to]); });
          var weight = {};
          more.forEach(function(x){ [x.from, x.to].forEach(function(e){ if (!first[e]) weight[e] = (weight[e] || 0) + 1; }); });
          var keep = Object.keys(weight).sort(function(a, b){ return weight[b] - weight[a]; }).slice(0, 60);
          more = more.filter(function(x){ return (first[x.from] || keep.indexOf(x.from) >= 0) && (first[x.to] || keep.indexOf(x.to) >= 0); });
          g = graphOf(direct.concat(more));
          g.edges.forEach(function(e){ e.far = e.a !== email && e.b !== email; });
          g.nodes.forEach(function(v){ v.far = v.id !== email && !first[v.id]; });
        }
        if (!g.nodes.length) g.nodes.push({ id: email });
        var w = 760, h = Math.max(380, Math.min(steps === 2 ? 700 : 620, 300 + g.nodes.length * 8));
        radial(g, w, h, email);
        var counts = {};
        list.forEach(function(x){ counts[x.group] = (counts[x.group] || 0) + 1; });
        root.innerHTML =
          '<div class="view-toggle cx-filter" role="group" aria-label="Show">' + [['all', 'All']].concat(GROUPS).map(function(x){
            return '<button type="button" class="view-btn" data-cx="' + x[0] + '" aria-pressed="' + (filter === x[0]) + '">' + esc(x[1]) + (x[0] !== 'all' && counts[x[0]] ? ' · ' + counts[x[0]] : '') + '</button>';
          }).join('') + '</div> ' +
          '<div class="view-toggle cx-filter" role="group" aria-label="How far">' + [[1, 'Direct'], [2, 'Two steps']].map(function(x){
            return '<button type="button" class="view-btn" data-steps="' + x[0] + '" aria-pressed="' + (steps === x[0]) + '">' + x[1] + '</button>';
          }).join('') + '</div>' +
          '<div class="cx-graph">' + svg(g, w, h, { dir: dir, me: me, centre: email, labels: 'all' }) + '</div>' + legendHtml() +
          timelineHtml(list.filter(function(x){ return filter === 'all' || x.group === filter; }), dir, email, me, shown);
      }
      bindHover(root);
      root.addEventListener('click', function(e){
        var b = e.target.closest('[data-cx]');
        if (b) { filter = b.getAttribute('data-cx'); draw(); return; }
        var st = e.target.closest('[data-steps]');
        if (st) { steps = Number(st.getAttribute('data-steps')); draw(); return; }
        if (e.target.closest('.cx-more')) { shown += 50; draw(); return; }
        var n = e.target.closest('.cx-node');
        if (n && n.getAttribute('data-email') !== email) { var h = hrefOf(dir, n.getAttribute('data-email'), me); if (h) location.href = h; }
      });
      draw();
    }).catch(function(err){
      console.error('[BOLD Connections] loading failed', err);
      root.innerHTML = '<p class="proj-msg">Couldn’t load the connections. Try reloading the page.</p>';
    });
  }

  return { GROUPS: GROUPS, directory: directory, loadAll: loadAll, graphOf: graphOf, layout: layout, svg: svg, legendHtml: legendHtml, bindHover: bindHover,
    nameOf: nameOf, hrefOf: hrefOf, mountPerson: mountPerson };
})();
