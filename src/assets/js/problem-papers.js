window.BoldProblemPapers = (function(){
  function unavailableReason(papers){
    if (papers === null || !BOLD.can('ml-cycle', 'view')) return 'You need access to Internal Review to see registered papers.';
    return Array.isArray(papers) ? '' : 'Paper records are unavailable. Reload this page to try again.';
  }

  function list(papers){
    return '<ul class="pb-paper-list" aria-label="Registered papers">' + papers.map(function(paper){
      var href = 'audit-board.html#board=' + encodeURIComponent(paper.board) + '&amp;card=' + encodeURIComponent(paper.id);
      return '<li><a href="' + href + '">' + BOLD.escapeHtml(paper.title) + '</a> <span class="pb-paper-venue">' +
        BOLD.escapeHtml(paper.venue) + '</span></li>';
    }).join('') + '</ul>';
  }
  return {unavailableReason:unavailableReason, list:list};
})();
