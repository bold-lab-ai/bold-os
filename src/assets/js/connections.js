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

  // The graph as SVG. opts: { dir, me, centre, labels: 'all' | 'big', selected }.
  function svg(g, w, h, opts){
    var dir = opts.dir, byId = {}, degree = {};
    g.nodes.forEach(function(v){ byId[v.id] = v; });
    g.edges.forEach(function(e){ degree[e.a] = (degree[e.a] || 0) + e.n; degree[e.b] = (degree[e.b] || 0) + e.n; });
    var sel = opts.selected, near = {};
    if (sel) { near[sel] = 1; g.edges.forEach(function(e){ if (e.a === sel) near[e.b] = 1; if (e.b === sel) near[e.a] = 1; }); }
    var big = Object.keys(degree).sort(function(a, b){ return degree[b] - degree[a]; }).slice(0, 25);
    var radius = function(id){ return id === opts.centre ? 11 : 4 + Math.min(7, Math.sqrt(degree[id] || 1) * 1.4); };
    return '<svg class="cx-svg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Who has interacted with whom">' +
      '<g class="cx-edges">' + g.edges.map(function(e){
        var p = byId[e.a], q = byId[e.b], dim = sel && !(e.a === sel || e.b === sel);
        var parts = GROUPS.filter(function(x){ return e.groups[x[0]]; }).map(function(x){ return e.groups[x[0]] + ' ' + x[1].toLowerCase(); }).join(', ');
        return '<line class="cx-edge cx-' + e.main + (dim ? ' is-dim' : '') + '" x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) +
          '" stroke-width="' + (1 + Math.min(5, Math.log(e.n) * 1.6)).toFixed(1) + '"><title>' + esc(nameOf(dir, e.a) + ' – ' + nameOf(dir, e.b) + ': ' + parts) + '</title></line>';
      }).join('') + '</g>' +
      '<g class="cx-nodes">' + g.nodes.map(function(v){
        var d = dir[v.id], cls = 'cx-node ' + (d && d.member ? 'pp-' + d.group : 'is-outside') + (v.id === opts.centre ? ' is-centre' : '') + (sel && !near[v.id] ? ' is-dim' : '') + (v.id === sel ? ' is-selected' : '');
        var label = opts.labels === 'all' || v.id === opts.centre || near[v.id] || big.indexOf(v.id) >= 0;
        var r = radius(v.id), anchor = v.x > w - 120 ? 'end' : 'start', lx = anchor === 'end' ? -r - 4 : r + 4;
        return '<g class="' + cls + '" data-email="' + esc(v.id) + '" transform="translate(' + v.x.toFixed(1) + ',' + v.y.toFixed(1) + ')" tabindex="0">' +
          '<circle r="' + r.toFixed(1) + '"></circle>' +
          (label ? '<text x="' + lx + '" y="4" text-anchor="' + anchor + '">' + esc(nameOf(dir, v.id)) + '</text>' : '') +
          '<title>' + esc(nameOf(dir, v.id) + (degree[v.id] ? ' · ' + degree[v.id] + ' interaction' + (degree[v.id] === 1 ? '' : 's') : '')) + '</title></g>';
      }).join('') + '</g></svg>';
  }

  function legendHtml(){
    return '<div class="cx-legend">' + GROUPS.slice(0, 3).map(function(x){ return '<span class="cx-key cx-' + x[0] + '">' + esc(x[1]) + '</span>'; }).join('') +
      '<span class="cx-key-note">Dots: their group in <a href="boldiquette.html#who-is-bold">Who is BOLD</a></span></div>';
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
    var row = function(x){ return '<li class="cx-row cx-' + x.group + '"><span class="cx-when">' + day(x.at) + '</span><span class="cx-what">' + sentence(x, dir, me) + '</span></li>'; };
    return (start.length ? '<div class="md-group"><h3>Coming to BOLD</h3><ul class="cx-timeline">' + start.map(row).join('') + '</ul></div>' : '') +
      '<div class="md-group"><h3>Since</h3>' + (rest.length ? '<ul class="cx-timeline">' + rest.slice(0, shown).map(row).join('') + '</ul>' +
        (rest.length > shown ? '<button type="button" class="btn-text cx-more">Show more (' + (rest.length - shown) + ')</button>' : '') : '<p class="proj-msg">Nothing yet.</p>') + '</div>';
  }

  // Connections for `email` into `root`. me: the signed-in person's email.
  function mountPerson(root, email, me){
    email = lower(email); me = lower(me);
    root.innerHTML = '<p class="proj-msg">Loading&hellip;</p>';
    var shown = 30, filter = 'all';
    Promise.all([loadFor(email), directory()]).then(function(r){
      var list = r[0], dir = r[1];
      function draw(){
        var edges = list.filter(function(x){ return x.to && (filter === 'all' || x.group === filter); });
        var g = graphOf(edges);
        if (!g.nodes.length) g.nodes.push({ id: email });
        var w = 760, h = Math.max(320, Math.min(560, 200 + g.nodes.length * 14));
        layout(g, w, h, email);
        var counts = {};
        list.forEach(function(x){ counts[x.group] = (counts[x.group] || 0) + 1; });
        root.innerHTML =
          '<div class="view-toggle cx-filter" role="group" aria-label="Show">' + [['all', 'All']].concat(GROUPS).map(function(x){
            return '<button type="button" class="view-btn" data-cx="' + x[0] + '" aria-pressed="' + (filter === x[0]) + '">' + esc(x[1]) + (x[0] !== 'all' && counts[x[0]] ? ' · ' + counts[x[0]] : '') + '</button>';
          }).join('') + '</div>' +
          '<div class="cx-graph">' + svg(g, w, h, { dir: dir, me: me, centre: email, labels: 'all' }) + '</div>' + legendHtml() +
          timelineHtml(list.filter(function(x){ return filter === 'all' || x.group === filter; }), dir, email, me, shown);
      }
      root.addEventListener('click', function(e){
        var b = e.target.closest('[data-cx]');
        if (b) { filter = b.getAttribute('data-cx'); draw(); return; }
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

  return { GROUPS: GROUPS, directory: directory, loadAll: loadAll, graphOf: graphOf, layout: layout, svg: svg, legendHtml: legendHtml,
    nameOf: nameOf, hrefOf: hrefOf, mountPerson: mountPerson };
})();
