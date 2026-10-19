// Network (network.html, under People): everyone's interactions (connections.js), as a
// Graph or as a Lineage (who brought whom into BOLD). Graph filters: kinds (joining,
// working together, talking, on the site) and groups of Who is BOLD (and outside BOLD),
// each on or off, both people's groups on; since when; and with or without things
// (projects and papers, events, guides, skills). Find someone selects them. Clicking a person or thing selects it: its lines
// stay lit and its busiest connections are listed below, each with its two latest
// interactions; clicking a line (or All) lists every interaction behind it. PIs and admins
// can rebuild every interaction from the documents they come from (rebuildInteractions).
(function(){
  var esc = BOLD.escapeHtml, C = window.BoldConnections;
  var graph = document.getElementById('nwGraph');
  if (!graph || !BOLD.getAuth() || !C || !window.BoldJoin) return;
  var el = function(id){ return document.getElementById(id); };
  var all = null, dir = null, me = '', g = null, selected = '', why = '';
  var view = 'graph', since = 'all', things = true;
  // Kinds and groups add up: each is on or off, all on to start (people outside BOLD: 'outside').
  var kinds = { joining: true, working: true, talking: true, site: true }, groups = { outside: true };
  BoldJoin.CATEGORIES.forEach(function(c){ groups[c[0]] = true; });
  var SINCE = [['all', 'All time'], ['365', 'Year'], ['90', '3 months']], find = '';
  var W = 1000, H = 680;

  // View, Show and Since: one choice each; Kinds and Who: each on or off (connections.js).
  function controls(){
    var graphOnly = view === 'graph';
    el('nwControls').innerHTML = '<div class="cx-ctl-row">' +
      C.pair('View', C.seg('View', 'data-view', [['graph', 'Graph'], ['lineage', 'Lineage']], view)) +
      (graphOnly ? C.pair('Show', C.seg('Show', 'data-things', [['1', 'People and things'], ['0', 'People only']], things ? '1' : '0')) +
        C.pair('Since', C.seg('Since', 'data-since', SINCE, since)) : '') + '</div>' +
      (graphOnly ? '<div class="cx-ctl-row">' + C.pair('Kinds', C.chips('Kinds', 'data-kind', C.GROUPS, function(k){ return kinds[k]; })) + '</div>' +
        '<div class="cx-ctl-row">' + C.pair('Who', C.chips('Who', 'data-group', BoldJoin.CATEGORIES.concat([['outside', 'Outside BOLD']]), function(k){ return groups[k]; }, C.groupRing)) + '</div>' +
        '<div class="cx-ctl-row">' + C.pair('Find', '<input class="cx-field cx-find" type="search" id="nwFind" placeholder="Someone or something" aria-label="Find someone or something" list="nwPeople" value="' + esc(find) + '">') + '</div>' : '');
  }

  function build(){
    if (view === 'lineage') { drawLineage(); return; }
    var from = since === 'all' ? 0 : Date.now() - Number(since) * 86400000;
    var inGroup = function(e){ return !e || C.isThing(e) || !!groups[dir[e] && dir[e].member ? dir[e].group : 'outside']; };
    var list = all.filter(function(x){ return kinds[x.group] && x.at >= from && (x.to || (things && x.thing)) && inGroup(x.from) && inGroup(x.to); });
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
        // Why: the two latest interactions behind the line.
        var latest = C.reasons(e).slice(0, 2).map(function(x){ return '<span class="cx-reason">' + C.rowHtml(x, dir, me).replace(/^<li class="cx-row">|<\/li>$/g, '') + '</span>'; }).join('');
        return '<li class="cx-row cx-link-row"><span class="cx-what">' + link(other) + ' <span class="proj-meta">' + esc(parts) + '</span>' +
          '<span class="cx-reasons">' + latest + (e.n > 2 ? '<button type="button" class="btn-text cx-all" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '">All ' + e.n + '</button>' : '') + '</span></span></li>';
      }).join('') + '</ul>' +
      (links.length > 12 ? '<p class="proj-meta">And ' + (links.length - 12) + ' more' + (h && !C.isThing(selected) ? ' on <a href="' + esc(h) + '">their Connections</a>' : '') + '.</p>' : '') + '</div>';
  }

  function draw(){
    var people = g.nodes.filter(function(v){ return !v.thing; }).length, stuff = g.nodes.length - people;
    var n = g.edges.reduce(function(s, e){ return s + e.n; }, 0);
    el('nwMsg').textContent = g.nodes.length ? people + ' people' + (stuff ? ' · ' + stuff + ' things' : '') + ' · ' + n + ' link' + (n === 1 ? '' : 's') : 'No interactions for these filters.';
    graph.hidden = !g.nodes.length;
    var chosen = why && C.edgeOf(g, why.split(' ')[0], why.split(' ')[1]);
    if (!chosen) why = '';
    if (g.nodes.length) graph.innerHTML = C.svg(g, W, H, { dir: dir, me: me, labels: 'big', selected: selected, selectedEdge: why });
    el('nwLegend').innerHTML = g.nodes.length ? C.legendHtml(things, true) : '';
    el('nwPerson').innerHTML = (chosen ? C.reasonsHtml(chosen, g, dir, me) : '') + personHtml();
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
    var k = e.target.closest('[data-kind]'), gr = e.target.closest('[data-group]'), v = e.target.closest('[data-view]'), t = e.target.closest('[data-things]'), sn = e.target.closest('[data-since]'), n = e.target.closest('.cx-node');
    if (v) { view = v.getAttribute('data-view'); controls(); build(); }
    else if (t) { things = t.getAttribute('data-things') === '1'; controls(); build(); }
    else if (sn) { since = sn.getAttribute('data-since'); controls(); build(); }
    else if (k) { kinds[k.getAttribute('data-kind')] = !kinds[k.getAttribute('data-kind')]; controls(); build(); }
    else if (gr) { groups[gr.getAttribute('data-group')] = !groups[gr.getAttribute('data-group')]; controls(); build(); }
    else if (e.target.closest('.cx-hit') && graph.contains(e.target)) {
      var line = e.target.closest('.cx-hit'), key = line.getAttribute('data-a') + ' ' + line.getAttribute('data-b');
      why = why === key ? '' : key; draw();
    }
    else if (e.target.closest('.cx-all')) { var b2 = e.target.closest('.cx-all'); why = b2.getAttribute('data-a') + ' ' + b2.getAttribute('data-b'); draw(); el('nwPerson').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else if (e.target.closest('.cx-why-close')) { why = ''; draw(); }
    else if (n && graph.contains(n)) {
      if (view === 'lineage') { var h = n.getAttribute('data-href'); if (h) location.href = h; return; }
      var id = n.getAttribute('data-id'); selected = selected === id ? '' : id; draw();
    }
    // An empty part of the graph: nothing selected.
    else if ((selected || why) && view === 'graph' && graph.contains(e.target)) { selected = ''; why = ''; draw(); }
  });
  graph.addEventListener('keydown', function(e){
    var n = e.target.closest && e.target.closest('.cx-node');
    if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); n.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  C.bindHover(graph);
  // Find (it's redrawn with the controls, so listened for on the page).
  document.addEventListener('change', function(e){
    if (e.target.id !== 'nwFind') return;
    find = e.target.value;
    var q = find.trim().toLowerCase();
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
