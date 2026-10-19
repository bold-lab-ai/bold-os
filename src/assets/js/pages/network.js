// Network (network.html, under People): everyone's interactions (connections.js) as
// one graph. Filters: kinds (joining, working together, talking), since when, and a
// group of Who is BOLD (both people in it); Find someone selects them. Clicking someone
// selects them: their lines stay lit and their busiest connections are listed below,
// with a link to their Connections. PIs and admins can rebuild every interaction from
// the documents they come from (rebuildInteractions).
(function(){
  var esc = BOLD.escapeHtml, C = window.BoldConnections;
  var graph = document.getElementById('nwGraph');
  if (!graph || !BOLD.getAuth() || !C || !window.BoldJoin) return;
  var el = function(id){ return document.getElementById(id); };
  var all = null, dir = null, me = '', g = null, selected = '';
  var kinds = { joining: true, working: true, talking: true }, since = 'all', group = '';
  var SINCE = [['all', 'All time'], ['365', 'Past year'], ['90', 'Past 3 months']];
  var W = 1000, H = 680;

  function controls(){
    el('nwKinds').innerHTML = C.GROUPS.slice(0, 3).map(function(x){
      return '<button type="button" class="view-btn" data-kind="' + x[0] + '" aria-pressed="' + !!kinds[x[0]] + '">' + esc(x[1]) + '</button>';
    }).join('');
    el('nwSince').innerHTML = SINCE.map(function(x){
      return '<button type="button" class="view-btn" data-since="' + x[0] + '" aria-pressed="' + (since === x[0]) + '">' + esc(x[1]) + '</button>';
    }).join('');
    el('nwGroup').innerHTML = '<option value="">Every group</option>' + BoldJoin.CATEGORIES.map(function(c){
      return '<option value="' + c[0] + '"' + (group === c[0] ? ' selected' : '') + '>' + esc(c[1]) + '</option>';
    }).join('');
  }

  function build(){
    var from = since === 'all' ? 0 : Date.now() - Number(since) * 86400000;
    var inGroup = function(e){ return !group || (dir[e] && dir[e].member && dir[e].group === group); };
    var list = all.filter(function(x){ return kinds[x.group] && x.at >= from && inGroup(x.from) && inGroup(x.to); });
    g = C.graphOf(list);
    // Narrow screens: a taller box, so the graph isn't squeezed into a strip.
    if (graph.parentNode.clientWidth < 600) { W = 600; H = 820; } else { W = 1000; H = 680; }
    C.layout(g, W, H);
    if (selected && !g.nodes.some(function(v){ return v.id === selected; })) selected = '';
    el('nwPeople').innerHTML = g.nodes.map(function(v){ return '<option value="' + esc(C.nameOf(dir, v.id)) + '">'; }).join('');
    draw();
  }

  function personHtml(){
    if (!selected) return '';
    var links = g.edges.filter(function(e){ return e.a === selected || e.b === selected; })
      .sort(function(p, q){ return q.n - p.n; });
    var h = C.hrefOf(dir, selected, me);
    return '<div class="md-group"><h3>' + (h ? '<a href="' + esc(h) + '">' + esc(C.nameOf(dir, selected)) + '</a>' : esc(C.nameOf(dir, selected))) + '</h3>' +
      '<ul class="cx-timeline">' + links.slice(0, 12).map(function(e){
        var other = e.a === selected ? e.b : e.a, oh = C.hrefOf(dir, other, me);
        var parts = C.GROUPS.filter(function(x){ return e.groups[x[0]]; }).map(function(x){ return e.groups[x[0]] + ' ' + x[1].toLowerCase(); }).join(', ');
        return '<li class="cx-row cx-' + e.main + '"><span class="cx-what">' + (oh ? '<a href="' + esc(oh) + '">' + esc(C.nameOf(dir, other)) + '</a>' : esc(C.nameOf(dir, other))) +
          ' <span class="proj-meta">' + esc(parts) + '</span></span></li>';
      }).join('') + '</ul>' + (links.length > 12 ? '<p class="proj-meta">And ' + (links.length - 12) + ' more on <a href="' + esc(h) + '">their Connections</a>.</p>' : '') + '</div>';
  }

  function draw(){
    var people = g.nodes.length, n = g.edges.reduce(function(s, e){ return s + e.n; }, 0);
    el('nwMsg').textContent = people ? people + ' people · ' + n + ' interaction' + (n === 1 ? '' : 's') : 'No interactions for these filters.';
    graph.hidden = !people;
    if (people) graph.innerHTML = C.svg(g, W, H, { dir: dir, me: me, labels: 'big', selected: selected });
    el('nwLegend').innerHTML = people ? C.legendHtml() : '';
    el('nwPerson').innerHTML = personHtml();
  }

  document.addEventListener('click', function(e){
    var k = e.target.closest('[data-kind]'), s = e.target.closest('[data-since]'), n = e.target.closest('.cx-node');
    if (k) { kinds[k.getAttribute('data-kind')] = !kinds[k.getAttribute('data-kind')]; controls(); build(); }
    else if (s) { since = s.getAttribute('data-since'); controls(); build(); }
    else if (n && graph.contains(n)) { var id = n.getAttribute('data-email'); selected = selected === id ? '' : id; draw(); }
  });
  graph.addEventListener('keydown', function(e){
    var n = e.target.closest && e.target.closest('.cx-node');
    if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); n.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  C.bindHover(graph);
  el('nwGroup').addEventListener('change', function(){ group = this.value; build(); });
  el('nwFind').addEventListener('change', function(){
    var q = this.value.trim().toLowerCase();
    var hit = g.nodes.filter(function(v){ return C.nameOf(dir, v.id).toLowerCase() === q; })[0] ||
      g.nodes.filter(function(v){ return C.nameOf(dir, v.id).toLowerCase().indexOf(q) >= 0; })[0];
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
