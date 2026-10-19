// Network (network.html, under People): everyone's interactions (connections.js), as a
// Graph or as a Lineage (who brought whom into BOLD). Graph filters: kind (all, joining,
// working together, talking, on the site), since when, a group of Who is BOLD (both
// people in it), and with or without things (projects and papers, events, guides,
// skills); Find someone selects them. Clicking a person or thing selects it: its lines
// stay lit and its busiest connections are listed below. PIs and admins can rebuild every
// interaction from the documents they come from (rebuildInteractions).
(function(){
  var esc = BOLD.escapeHtml, C = window.BoldConnections;
  var graph = document.getElementById('nwGraph');
  if (!graph || !BOLD.getAuth() || !C || !window.BoldJoin) return;
  var el = function(id){ return document.getElementById(id); };
  var all = null, dir = null, me = '', g = null, selected = '';
  var view = 'graph', kind = 'all', since = 'all', group = '', things = true;
  var SINCE = [['all', 'All time'], ['365', 'Past year'], ['90', 'Past 3 months']];
  var W = 1000, H = 680;

  function toggle(attr, opts, isOn){
    return opts.map(function(x){ return '<button type="button" class="view-btn" ' + attr + '="' + x[0] + '" aria-pressed="' + !!isOn(x[0]) + '">' + esc(x[1]) + '</button>'; }).join('');
  }
  function controls(){
    el('nwView').innerHTML = toggle('data-view', [['graph', 'Graph'], ['lineage', 'Lineage']], function(k){ return view === k; });
    var opts = function(list, cur){ return list.map(function(x){ return '<option value="' + x[0] + '"' + (cur === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join(''); };
    el('nwKinds').innerHTML = opts([['all', 'All kinds']].concat(C.GROUPS), kind);
    el('nwSince').innerHTML = opts(SINCE, since);
    el('nwThings').innerHTML = toggle('data-things', [['1', 'People and things'], ['0', 'People']], function(k){ return (k === '1') === things; });
    el('nwGroup').innerHTML = '<option value="">Every group</option>' + BoldJoin.CATEGORIES.map(function(c){
      return '<option value="' + c[0] + '"' + (group === c[0] ? ' selected' : '') + '>' + esc(c[1]) + '</option>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.nw-graph-only'), function(x){ x.hidden = view !== 'graph'; });
  }

  function build(){
    if (view === 'lineage') { drawLineage(); return; }
    var from = since === 'all' ? 0 : Date.now() - Number(since) * 86400000;
    var inGroup = function(e){ return !e || C.isThing(e) || !group || (dir[e] && dir[e].member && dir[e].group === group); };
    var list = all.filter(function(x){ return (kind === 'all' || x.group === kind) && x.at >= from && (x.to || (things && x.thing)) && inGroup(x.from) && inGroup(x.to); });
    g = C.graphOf(list, things);
    // Narrow screens: a taller box, so the graph isn't squeezed into a strip.
    if (graph.parentNode.clientWidth < 600) { W = 600; H = 760; } else { W = 1000; H = 760; }
    C.concentric(g, W, H);
    if (selected && !g.byId[selected]) selected = '';
    el('nwPeople').innerHTML = g.nodes.map(function(v){ return '<option value="' + esc(C.nameOf(dir, v.id, g)) + '">'; }).join('');
    draw();
  }

  function personHtml(){
    if (!selected) return '';
    var links = g.edges.filter(function(e){ return e.a === selected || e.b === selected; }).sort(function(p, q){ return q.n - p.n; });
    var h = C.hrefOf(dir, selected, me, g), name = C.nameOf(dir, selected, g);
    var link = function(id){ var x = C.hrefOf(dir, id, me, g), n = C.nameOf(dir, id, g); return x ? '<a href="' + esc(x) + '">' + esc(n) + '</a>' : esc(n); };
    return '<div class="md-group"><h3>' + link(selected) + '</h3>' +
      '<ul class="cx-timeline">' + links.slice(0, 12).map(function(e){
        var other = e.a === selected ? e.b : e.a;
        var parts = C.GROUPS.filter(function(x){ return e.groups[x[0]]; }).map(function(x){ return e.groups[x[0]] + ' ' + x[1].toLowerCase(); }).join(', ');
        return '<li class="cx-row"><span class="cx-what">' + link(other) + ' <span class="proj-meta">' + esc(parts) + '</span></span></li>';
      }).join('') + '</ul>' +
      (links.length > 12 ? '<p class="proj-meta">And ' + (links.length - 12) + ' more' + (h && !C.isThing(selected) ? ' on <a href="' + esc(h) + '">their Connections</a>' : '') + '.</p>' : '') + '</div>';
  }

  function draw(){
    var people = g.nodes.filter(function(v){ return !v.thing; }).length, stuff = g.nodes.length - people;
    var n = g.edges.reduce(function(s, e){ return s + e.n; }, 0);
    el('nwMsg').textContent = g.nodes.length ? people + ' people' + (stuff ? ' · ' + stuff + ' things' : '') + ' · ' + n + ' link' + (n === 1 ? '' : 's') : 'No interactions for these filters.';
    graph.hidden = !g.nodes.length;
    if (g.nodes.length) graph.innerHTML = C.svg(g, W, H, { dir: dir, me: me, labels: 'big', selected: selected });
    el('nwLegend').innerHTML = g.nodes.length ? C.legendHtml(things) : '';
    el('nwPerson').innerHTML = personHtml();
  }

  function drawLineage(){
    var html = C.lineageHtml(all, dir, me);
    el('nwMsg').textContent = html ? 'Who brought whom into BOLD: whoever invited them, else their point of contact, else a supervisor, else who approved them.' : 'Nobody’s lineage is known yet.';
    graph.hidden = !html;
    graph.innerHTML = html;
    el('nwLegend').innerHTML = '';
    el('nwPerson').innerHTML = '';
  }

  document.addEventListener('click', function(e){
    var v = e.target.closest('[data-view]'), t = e.target.closest('[data-things]'), n = e.target.closest('.cx-node');
    if (v) { view = v.getAttribute('data-view'); controls(); build(); }
    else if (t) { things = t.getAttribute('data-things') === '1'; controls(); build(); }
    else if (n && graph.contains(n)) {
      if (view === 'lineage') { var h = n.getAttribute('data-href'); if (h) location.href = h; return; }
      var id = n.getAttribute('data-id'); selected = selected === id ? '' : id; draw();
    }
    // An empty part of the graph: nothing selected.
    else if (selected && view === 'graph' && graph.contains(e.target)) { selected = ''; draw(); }
  });
  graph.addEventListener('keydown', function(e){
    var n = e.target.closest && e.target.closest('.cx-node');
    if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); n.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  C.bindHover(graph);
  el('nwGroup').addEventListener('change', function(){ group = this.value; build(); });
  el('nwKinds').addEventListener('change', function(){ kind = this.value; build(); });
  el('nwSince').addEventListener('change', function(){ since = this.value; build(); });
  el('nwFind').addEventListener('change', function(){
    var q = this.value.trim().toLowerCase();
    var name = function(v){ return C.nameOf(dir, v.id, g).toLowerCase(); };
    var hit = g.nodes.filter(function(v){ return name(v) === q; })[0] || g.nodes.filter(function(v){ return name(v).indexOf(q) >= 0; })[0];
    if (hit) { selected = hit.id; draw(); }
  });
  el('nwRebuild').addEventListener('click', function(){
    var b = this; b.disabled = true; el('nwRebuildMsg').textContent = 'Rebuilding…';
    firebase.app().functions('europe-west2').httpsCallable('rebuildInteractions')({}).then(function(r){
      el('nwRebuildMsg').textContent = 'Done: ' + r.data.count + ' interactions from ' + r.data.sources + ' documents.';
      return load();
    }).catch(function(err){ el('nwRebuildMsg').textContent = err.message || 'Couldn’t rebuild.'; })
      .then(function(){ b.disabled = false; });
  });

  function load(){
    return Promise.all([C.loadAll(), dir ? dir : C.directory()]).then(function(r){ all = r[0]; dir = r[1]; build(); });
  }

  BOLD.onUser(function(user){
    if (!user) return;
    me = String(user.email || '').toLowerCase();
    controls();
    load().catch(function(err){
      console.error('[BOLD Network] loading failed', err);
      el('nwMsg').textContent = 'Couldn’t load the network. Try reloading the page.';
    });
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')({}).then(function(r){ el('nwAdmin').hidden = !r.data.fullWrite; }).catch(function(){});
  });
})();
