// Shared by the scientific problem form and the editor on a problem's overview.
window.BoldProblemFamily = (function(){
  'use strict';
  var esc = BOLD.escapeHtml;
  var labels = {parents:'Which broader objective or problem would this help solve?', related:'Related problems'};
  function connections(graph, id){
    var result = {parents:[], children:[], related:[]};
    graph.edges.forEach(function(edge){
      if (edge.kind === 'contributes_to') {
        if (id === edge.from) result.parents.push(edge.to);
        if (id === edge.to) result.children.push(edge.from);
      } else if (edge.kind === 'related_to') {
        if (id === edge.from) result.related.push(edge.to);
        if (id === edge.to) result.related.push(edge.from);
      }
    });
    return result;
  }
  function narrowerProblems(graph, id){
    var byParent = new Map();
    graph.edges.forEach(function(edge){
      if (edge.kind !== 'contributes_to') return;
      if (!byParent.has(edge.to)) byParent.set(edge.to, []);
      byParent.get(edge.to).push(edge.from);
    });
    var found = new Set(), remaining = id ? [id] : [];
    while (remaining.length) {
      var next = remaining.pop();
      if (found.has(next)) continue;
      found.add(next);
      (byParent.get(next) || []).forEach(function(child){ remaining.push(child); });
    }
    return found;
  }
  function index(graph){
    return new Map(graph.objectives.concat(graph.problems).map(function(node){ return [node.id,node]; }));
  }
  function link(node){
    var route = node.kind ? 'problems.html?objective=' : 'problem.html?problem=';
    return '<a href="' + route + encodeURIComponent(node.id) + '">' + esc(node.title) + '</a>' + (node.archived ? ' (archived)' : '');
  }
  function picker(container, graph, id){
    var nodes = Array.from(index(graph).values()).sort(function(a,b){
      return (Number(!a.kind) - Number(!b.kind)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
    var original = connections(graph, id), narrower = narrowerProblems(graph, id), children = new Set(original.children);
    var picked = {parents:new Set(original.parents), related:new Set(original.related)};
    var groupNames = Object.keys(picked);
    container.innerHTML = groupNames.map(function(key){
      return '<details class="pb-family-choice" data-group="'+key+'"><summary>' + labels[key] + ' <small data-count></small></summary>' +
        '<label>Search ' + (key === 'parents' ? 'objectives and problems' : 'problems') + '<input type="search" data-search></label>' +
        '<div data-choices role="group" aria-label="'+labels[key]+'"></div>' +
        '<button class="btn-text" type="button" data-more hidden>Show more</button></details>';
    }).join('');
    var groups = groupNames.map(function(key){
      var group = container.querySelector('[data-group="'+key+'"]');
      var input = group.querySelector('[data-search]'), list = group.querySelector('[data-choices]');
      var more = group.querySelector('[data-more]'), count = group.querySelector('[data-count]');
      var other = key === 'parents' ? 'related' : 'parents';
      var limit = 12;
      function draw(){
        var term = input.value.trim().toLowerCase();
        var matches = nodes.filter(function(node){
          if (node.id === id || (node.archived && !picked[key].has(node.id))) return false;
          if (key === 'related' && (node.kind || children.has(node.id))) return false;
          if (key === 'parents' && narrower.has(node.id)) return false;
          return !term || node.title.toLowerCase().includes(term);
        });
        // Keep chosen links visible before the other matches. Searching never clears a selection.
        var chosen = matches.filter(function(n){ return picked[key].has(n.id); });
        var others = matches.filter(function(n){ return !picked[key].has(n.id); });
        list.innerHTML = chosen.concat(others.slice(0,limit)).map(function(n){
          var checked = picked[key].has(n.id), unavailable = picked[other].has(n.id);
          var kind = n.kind === 'pillar' ? 'pillar' : n.kind === 'moonshot' ? 'moonshot' : '';
          var note = [kind, n.archived ? 'archived' : '', unavailable ? (key === 'parents' ? 'already a related problem' : 'already a broader problem') : ''].filter(Boolean).join(' · ');
          return '<label class="pb-family-option"><input type="checkbox" value="' + esc(n.id) + '"' +
            (checked ? ' checked' : '') + (unavailable ? ' disabled' : '') + '><span>' + esc(n.title) +
            (note ? ' <small>(' + note + ')</small>' : '') + '</span></label>';
        }).join('') || '<span class="pb-family-note">' + (term ? 'No matches.' : 'No available links.') + '</span>';
        more.hidden = others.length <= limit;
        count.textContent = picked[key].size ? '(' + picked[key].size + ' selected)' : '';
      }
      input.addEventListener('input', function(){limit = 12; draw();});
      // A search in the picker should not submit the entire problem form.
      input.addEventListener('keydown', function(event){ if (event.key === 'Enter') event.preventDefault(); });
      more.addEventListener('click', function(){ limit += 12; draw(); });
      list.addEventListener('change', function(event){
        var box = event.target;
        if (box.type !== 'checkbox') return;
        if (box.checked) picked[key].add(box.value); else picked[key].delete(box.value);
        count.textContent = picked[key].size ? '(' + picked[key].size + ' selected)' : '';
        groups.forEach(function(g){ if (g.key !== key) g.draw(); });
      });
      draw();
      return {key:key, draw:draw};
    });
    return function value(){return {parents:Array.from(picked.parents).sort(), related:Array.from(picked.related).sort()};};
  }
  return {connections:connections, index:index, link:link, picker:picker};
})();
