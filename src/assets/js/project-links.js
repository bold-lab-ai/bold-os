// The projects whose presentations were given at a talk or a session, for those
// pages' "Project" row: presentations (projectWorkspaces/{id}/presentations, see
// pages/project.js) name the talk and session they were (occasion.talkSlug,
// occasion.sessionSlug), found across every project with a collection-group query
// (firestore.indexes.json), each linking its project's page.
window.BoldProjectLinks = (function(){
  var esc = BOLD.escapeHtml;

  // field: 'talkSlug' or 'sessionSlug' → a promise of [{ title, href }].
  function find(field, slug){
    var db = firebase.firestore(BOLD.getApp());
    return db.collectionGroup('presentations').where('occasion.' + field, '==', slug).get().then(function(snap){
      var ids = [];
      snap.docs.forEach(function(d){ var id = d.ref.parent.parent.id; if (ids.indexOf(id) < 0) ids.push(id); });
      return Promise.all(ids.map(function(id){ return db.collection('projectWorkspaces').doc(id).get(); }));
    }).then(function(snaps){
      return snaps.filter(function(s){ return s.exists; }).map(function(s){
        var w = s.data();
        return { title: w.title || 'Untitled project',
          href: 'project.html#id=' + encodeURIComponent(w.cardId || s.id) + (w.boardId ? '&board=' + encodeURIComponent(w.boardId) : '') + '&tab=presentations' };
      });
    }).catch(function(err){ console.error('[BOLD Events] loading the projects presented here failed', err); return []; });
  }

  // The row for a page's details list; nothing when there are none.
  function rowHtml(list){
    if (!list || !list.length) return '';
    return '<dt>' + (list.length > 1 ? 'Projects' : 'Project') + '</dt><dd>' +
      list.map(function(p){ return '<a href="' + esc(p.href) + '">' + esc(p.title) + '</a>'; }).join(', ') + '</dd>';
  }

  return { find: find, rowHtml: rowHtml };
})();
