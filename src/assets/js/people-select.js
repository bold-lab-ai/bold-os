// Choosing one person from the lab's people (the Slack roster, `people/{Slack ID}`), as a
// <select>: the Problem Bank's research owner, edited on a problem's page (pages/problem.js).
// BoldPeopleSelect.load() → [{ id, name }] by name (once a page); .options(people, selectedId).
window.BoldPeopleSelect = (function(){
  'use strict';
  var loading = null;
  function load(){
    loading = loading || firebase.firestore(BOLD.getApp()).collection('people').get().then(function(snap){
      return snap.docs.map(function(d){ return { id: d.data().slackId || d.id, name: d.data().name || '' }; })
        .filter(function(p){ return p.name; })
        .sort(function(a, b){ return a.name.localeCompare(b.name); });
    }).catch(function(error){ loading = null; throw error; });
    return loading;
  }
  function options(people, selectedId, prompt){
    return '<option value="">' + BOLD.escapeHtml(prompt || 'Choose a person') + '</option>' + people.map(function(p){
      return '<option value="' + BOLD.escapeHtml(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>' + BOLD.escapeHtml(p.name) + '</option>';
    }).join('');
  }
  return { load: load, options: options };
})();
