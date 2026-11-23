// The registry returns one node per problem even when it has several parents.
(function(root){
  'use strict';
  var STAGES = {open:'Open', implemented:'Implemented', checked:'Checked', validated:'Validated'};

  function buildIndex(family, includeArchived){
    var nodes = new Map(), children = new Map(), parents = new Map();
    var objectives = family.objectives.filter(visible);
    var problems = family.problems.filter(visible).map(function(p){return Object.assign({}, p, {kind:'problem'});});
    function visible(item){return includeArchived || !item.archived;}
    objectives.concat(problems).forEach(function(item){
      nodes.set(item.id, item); children.set(item.id, []); parents.set(item.id, []);
    });
    family.edges.forEach(function(edge){
      if (edge.kind !== 'contributes_to' || !nodes.has(edge.from) || !nodes.has(edge.to)) return;
      children.get(edge.to).push(nodes.get(edge.from)); parents.get(edge.from).push(nodes.get(edge.to));
    });
    function byTitle(a,b){return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);}
    objectives.sort(function(a,b){return Number(b.kind === 'pillar') - Number(a.kind === 'pillar') || byTitle(a,b);});
    problems.sort(byTitle); children.forEach(function(group){group.sort(byTitle);});
    parents.forEach(function(group){group.sort(byTitle);});
    // Nodes with no visible parent form the roots of every unclassified branch.
    var unclassified = problems.filter(function(p){return !parents.get(p.id).length;});
    var classified = new Set();
    var queue = objectives.slice();
    while (queue.length) {
      var current = queue.pop();
      if (classified.has(current.id)) continue;
      classified.add(current.id);
      for (var child of children.get(current.id)) queue.push(child);
    }
    return {objectives:objectives, problems:problems, children:children, parents:parents, unclassified:unclassified, classified:classified};
  }

  function mount(call, initialObjective){
    var el = function(id){return document.getElementById(id);};
    var branches = el('pbTreeBranches'), status = el('pbTreeStatus'), retry = el('pbTreeRetry');
    var includeArchived = el('pbIncludeArchived'), manage = el('pbManageObjectives');
    var form = el('pbObjectiveForm'), select = el('pbMoonshot'), title = el('pbMoonshotTitle');
    var save = el('pbSaveMoonshot'), archive = el('pbArchiveMoonshot'), close = el('pbCancelMoonshot');
    var graph = null, index = null, query = '', version = 0, pending = false, saving = false;
    var requested = initialObjective, requestId = null;

    function node(tag, className, text){
      var element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    }
    function statusText(message){status.textContent = message; status.hidden = !message;}
    function note(text){return node('p', 'proj-empty', text);}
    function stageText(item){return item.archived ? 'Archived' : STAGES[item.stage] || 'Open';}

    function problemLink(item){
      var link = node('a', 'pb-tree-link', item.title);
      link.href = 'problem.html?problem=' + encodeURIComponent(item.id);
      return link;
    }

    function branch(item, open, unclassifiedOnly){
      var li = node('li'), row = node('div', 'pb-tree-row');
      var isProblem = item.kind === 'problem';
      var childNodes = item.id === 'unclassified' ? index.unclassified : index.children.get(item.id);
      if (unclassifiedOnly) childNodes = childNodes.filter(function(p){return !index.classified.has(p.id);});
      var expandable = !isProblem || childNodes.length > 0;
      if (expandable) {
        var toggle = node('button', isProblem ? 'pb-tree-disclosure' : 'pb-tree-objective');
        toggle.type = 'button';
        var glyph = node('span', 'pb-tree-glyph'); glyph.setAttribute('aria-hidden','true'); toggle.append(glyph);
        if (!isProblem) toggle.append(node('span', '', item.title));
        var body;
        function expand(show){
          toggle.setAttribute('aria-expanded', String(show));
          if (isProblem) toggle.setAttribute('aria-label', (show ? 'Collapse ' : 'Expand ') + item.title);
          if (body) {body.remove(); body = null;}
          if (show) {
            body = childNodes.length ? group(childNodes, null, unclassifiedOnly || item.id === 'unclassified') : note('No problems linked here yet.');
            body.classList.add('pb-tree-children'); li.append(body);
          }
        }
        toggle.addEventListener('click', function(){expand(toggle.getAttribute('aria-expanded') !== 'true');});
        row.append(toggle); li.append(row); expand(open === true);
      } else {row.append(node('span', 'pb-tree-spacer')); li.append(row);}
      if (isProblem) row.append(problemLink(item));
      var kind = isProblem ? stageText(item) : item.kind === 'pillar' ? 'Research pillar' : item.kind === 'moonshot' ? 'Moonshot' : '';
      if (!isProblem && item.archived) kind += ' · Archived';
      if (kind) {
        var handbook = item.kind === 'pillar' && /^boldiquette\.html#[a-z0-9-]+$/i.test(item.source_url || '');
        var label = node(handbook ? 'a' : 'span', 'pb-tree-kind', kind);
        if (handbook) {label.href = item.source_url; label.setAttribute('aria-label', item.title + ' in the BOLDiquette');}
        row.append(label);
      }
      return li;
    }
    function group(items, openId, unclassifiedOnly){
      var ul = node('ul', 'pb-tree-nodes');
      items.forEach(function(item){ul.append(branch(item, item.id === openId, unclassifiedOnly));});
      return ul;
    }
    function render(){
      branches.replaceChildren();
      if (!index) return;
      var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length) {
        function matches(item){
          var label = item.title.toLowerCase(); return terms.every(function(term){return label.includes(term);});
        }
        var objectives = index.objectives.filter(matches), problems = index.problems.filter(matches);
        if (objectives.length) branches.append(group(objectives));
        if (problems.length) {
          var results = node('ul','pb-tree-results');
          problems.forEach(function(problem){
            var li = node('li'), row = node('div','pb-tree-row');
            row.append(problemLink(problem), node('span','pb-tree-kind',stageText(problem))); li.append(row);
            var parents = index.parents.get(problem.id);
            li.append(node('small','pb-tree-context',parents.length ? 'Contributes to ' + parents.map(function(p){return p.title;}).join(' · ') : 'Unclassified'));
            results.append(li);
          }); branches.append(results);
        }
        if (!objectives.length && !problems.length) branches.append(note('No objectives or problems match your search.'));
      } else {
        var roots = index.objectives.slice();
        if (index.unclassified.length) roots.push({id:'unclassified',title:'Unclassified',kind:'unclassified'});
        branches.append(group(roots, requested));
      }
    }
    function reindex(){index = buildIndex(graph, includeArchived.checked); render();}
    function fillForm(){
      var current = graph.objectives.find(function(o){return o.id === select.value;});
      title.value = current ? current.title : '';
      title.setCustomValidity('');
      save.textContent = current ? 'Save name' : 'Add moonshot'; archive.hidden = !current;
      archive.textContent = current && current.archived ? 'Restore' : 'Archive'; requestId = null;
    }
    function populate(selected){
      select.replaceChildren(new Option('New moonshot',''));
      graph.objectives.filter(function(o){return o.kind === 'moonshot';}).sort(function(a,b){return a.title.localeCompare(b.title);}).forEach(function(o){
        select.add(new Option(o.title + (o.archived ? ' (archived)' : ''), o.id));
      });
      select.value = selected || ''; fillForm();
    }
    function showForm(show){form.hidden = !show; manage.setAttribute('aria-expanded', String(show));}
    function formBusy(busy){
      saving = busy;
      [select,title,save,archive,close].forEach(function(control){control.disabled = busy;});
      manage.disabled = busy || !graph || !graph.can_manage_objectives;
      manage.title = !graph || !graph.can_manage_objectives ? 'Only a PI or administrator can manage moonshots.' : '';
    }
    async function load(force, selected){
      if (!force && (graph || pending)) return;
      var ticket = ++version; pending = true; retry.hidden = true; statusText('Loading the research family tree…');
      try {
        var data = await call({action:'family'});
        if (ticket !== version) return;
        graph = data;
        var objective = graph.objectives.find(function(o){return o.id === requested;});
        if (objective && objective.archived) includeArchived.checked = true;
        reindex(); populate(selected); formBusy(false);
        if (!graph.can_manage_objectives) showForm(false);
        statusText(requested && !objective ? 'This objective could not be found.' : '');
        requested = null;
        return true;
      } catch (e){
        if (ticket !== version) return;
        statusText('Could not load the research family tree. ' + (e.message || ''));
        retry.hidden = false;
        return false;
      } finally {if (ticket === version) pending = false;}
    }
    async function submit(archiveChange){
      if (saving || !graph || !graph.can_manage_objectives) return;
      var ticket = version, id = select.value, action = {action:'save_moonshot'};
      if (id) action.objective_id = id;
      if (archiveChange) {
        var current = graph.objectives.find(function(o){return o.id === id;});
        if (!current) return;
        action.archived = !current.archived;
      } else {
        action.title = title.value.trim();
        if (!action.title) {title.setCustomValidity('Enter an objective name.'); title.reportValidity(); return;}
        if (!id) {requestId = requestId || crypto.randomUUID(); action.request_id = requestId;}
      }
      formBusy(true); statusText('Saving…');
      try {
        var result = await call(action);
        if (ticket !== version) return;
        var refreshed = await load(true, result.objective_id);
        if (refreshed === undefined) return;
        if (!refreshed) {formBusy(true); statusText('The moonshot was saved. Reload the tree to see the change.'); return;}
        statusText(archiveChange ? (action.archived ? 'Moonshot archived.' : 'Moonshot restored.') : 'Moonshot saved.');
      } catch (e){
        if (ticket !== version) return;
        formBusy(false); statusText('Could not save the moonshot. ' + (e.message || 'Try again.'));
      }
    }
    includeArchived.addEventListener('change', function(){if (graph) reindex();});
    retry.addEventListener('click', function(){load(true);});
    manage.addEventListener('click', function(){showForm(form.hidden); if (!form.hidden) select.focus();});
    close.addEventListener('click', function(){showForm(false); manage.focus();});
    select.addEventListener('change', fillForm);
    title.addEventListener('input', function(){requestId = null; title.setCustomValidity('');});
    form.addEventListener('submit', function(e){e.preventDefault(); submit(false);});
    archive.addEventListener('click', function(){submit(true);});
    return {
      load:load,
      search:function(value){if (query !== value) {query = value; render();}},
      reset:function(){
        version++; pending = false; graph = null; index = null;
        includeArchived.checked = false; branches.replaceChildren(); retry.hidden = true; form.reset();
        showForm(false); formBusy(false); statusText('');
      }
    };
  }
  root.BoldProblemTree = {buildIndex:buildIndex, mount:mount};
})(window);
