(function(root){
  'use strict';
  var stages = {implemented:'Implemented', checked:'Checked', validated:'Validated on the actual task'};

  function readPlan(deferred, ids, reason, expected){
    if (!deferred) {
      if (!ids.length) return {error:'Choose a verifier release or select “Define verifier later”.', field:'pfDeferVerifier'};
      if (ids.length > 100) return {error:'Choose up to 100 verifier releases.', field:'pfVerifierChoices'};
      return {plan:{mode:'linked', releaseIds:ids}};
    }
    reason = reason.trim();
    expected = expected.trim();
    if (!reason) return {error:'Explain why you will define the verifier later.', field:'pfVerifierReason'};
    if (!expected) return {error:'Give an approximate time for onboarding the verifier.', field:'pfVerifierExpected'};
    return {plan:{mode:'deferred', reason:reason, expectedOnboarding:expected}};
  }

  function mount(loadPage){
    var el = function(id){ return document.getElementById(id); };
    var field = el('pfVerifierField'), choices = el('pfVerifierChoices'), more = el('pfVerifierMore');
    var status = el('pfVerifierStatus'), defer = el('pfDeferVerifier'), reason = el('pfVerifierReason'), expected = el('pfVerifierExpected');
    var generation = 0, cursor = null, loading = false, retryRefresh = false, seen = new Set();
    function showMode(){
      el('pfVerifierPicker').hidden = defer.checked;
      el('pfVerifierDeferral').hidden = !defer.checked;
      reason.required = expected.required = defer.checked;
    }
    defer.addEventListener('change', showMode);
    function checked(){
      return Array.from(choices.querySelectorAll('input:checked'));
    }
    function addRelease(row, selected){
      if (seen.has(row.id)) return;
      seen.add(row.id);
      var label = document.createElement('label'), box = document.createElement('input');
      label.className = 'verifier-check';
      box.type = 'checkbox'; box.value = row.id; box.checked = selected.has(row.id);
      var name = document.createElement('span');
      name.textContent = row.title + ' · v' + row.version;
      box.dataset.releaseTitle = name.textContent;
      var details = document.createElement('small');
      details.textContent = [row.problem_title,stages[row.stage],row.id.slice(-40,-33)].filter(Boolean).join(' · ');
      name.append(details); label.append(box,name); choices.append(label);
    }
    async function load(refresh){
      if ((!refresh && loading) || field.disabled) return;
      var request = ++generation, pageCursor = refresh ? null : cursor;
      var previous = new Map(checked().map(function(box){return [box.value,box.dataset.releaseTitle];}));
      var missing = new Set(previous.keys()), rows = [];
      loading = true; more.disabled = true; status.textContent = 'Loading verifier releases…';
      if (refresh) choices.inert = true;
      try {
        var result;
        do {
          result = await loadPage(pageCursor);
          if (request !== generation) return;
          pageCursor = result.cursor;
          result.items.forEach(function(row){rows.push(row); missing.delete(row.id);});
        } while (pageCursor && (!rows.length || (refresh && missing.size)));
        if (refresh) { seen.clear(); choices.replaceChildren(); }
        rows.forEach(function(row){addRelease(row,previous);});
        cursor = pageCursor; retryRefresh = false;
        status.textContent = seen.size ? '' : 'No verifier releases are available yet.';
        more.textContent = 'Load more releases'; more.hidden = !cursor;
        if (refresh && missing.size) {
          var names = Array.from(missing,function(id){return previous.get(id);});
          var message = 'Removed ' + names.join(', ') + ' because the releases are no longer available. Review your selections.';
          status.textContent = message;
          return message;
        }
      } catch (err){
        if (request !== generation) return;
        retryRefresh = !!refresh;
        status.textContent = refresh ? 'Could not refresh verifier releases. Your selections are still in the form.' : 'Could not load verifier releases.';
        more.textContent = 'Try again'; more.hidden = false;
      } finally {
        if (request === generation) { loading = false; more.disabled = false; choices.inert = false; }
      }
    }
    more.addEventListener('click', function(){ load(retryRefresh); });
    function reset(enabled){
      generation++; loading = false; retryRefresh = false; cursor = null; seen.clear(); choices.replaceChildren(); choices.inert = false;
      field.disabled = !enabled; more.hidden = true; more.disabled = false;
      defer.checked = false; reason.value = ''; expected.value = ''; showMode();
      status.textContent = enabled ? '' : 'Sign in to choose a verifier.';
      if (enabled) load();
    }
    return {
      reset:reset,
      refresh:function(){return load(true);},
      read:function(){
        var ids = checked().map(function(box){return box.value;});
        return readPlan(defer.checked,ids,reason.value,expected.value);
      }
    };
  }
  root.BoldProjectVerifiers = {mount:mount,readPlan:readPlan};
})(window);
