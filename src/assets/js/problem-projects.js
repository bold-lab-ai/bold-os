window.BoldProblemProjects = (function(){
  var esc = BOLD.escapeHtml;
  function same(a,b){
    return (a.id === b.id && (a.board || '') === (b.board || '')) || (a.stable_id && a.stable_id === b.stable_id);
  }
  function fields(choices, selected, problemId){
    return choices.map(function(p,i){
      var inherited = !!problemId && p.openProblemId === problemId;
      var checked = inherited || selected.some(function(link){ return same(p, link); });
      return '<label><input type="checkbox" value="' + i + '"' + (checked ? ' checked' : '') + (inherited ? ' disabled' : '') + '> ' + esc(p.title + (p.venue ? ' · ' + p.venue : '')) + (inherited ? ' (selected on the project)' : '') + '</label>';
    }).join('');
  }
  function selected(container,choices){
    return Array.from(container.querySelectorAll('input:checked:not(:disabled)'),function(input){
      var p = choices[Number(input.value)];
      return {id:p.id,board:p.board || ''};
    });
  }
  function links(choices){
    return choices.map(function(p){
      return '<a href="project.html#id=' + encodeURIComponent(p.id) + (p.board ? '&amp;board=' + encodeURIComponent(p.board) : '') + '">' + esc(p.title || p.id) + '</a>';
    }).join(' · ');
  }
  return {fields:fields,selected:selected,links:links};
})();
