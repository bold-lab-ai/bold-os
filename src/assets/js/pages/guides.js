// How-to page — every guide is a guides/{slug} doc (see guides-common.js),
// listed by title, each with how many proposed changes await review and open comment threads. "+ Add a
// guide" is always shown, greyed out for anyone but a PI/admin; it opens the
// form for a new guide (guide.html?new).
(function(){
  var esc = BOLD.escapeHtml;
  var G = window.BoldGuides;
  var list = document.getElementById('guideList');
  var addBtn = document.getElementById('guideAdd');
  var loading = document.getElementById('guideLoading');
  if (!list || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }

  var guides = [], pending = {}, talk = {}, fullWrite = false;

  var search = document.getElementById('guideSearch'), q = '';
  // A row as on Projects (bold.css .proj-list, projects.css): the title, what awaits review, and the
  // description.
  function rowHtml(x){
    var n = pending[x.slug] || 0, c = talk[x.slug] || 0;
    var counts = [n ? n + ' proposed change' + (n === 1 ? '' : 's') : '', c ? c + ' comment' + (c === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
    var href = 'guide.html?guide=' + encodeURIComponent(x.slug);
    return '<li><div class="proj-main">' +
      '<a class="proj-title" href="' + href + '">' + esc(x.title || x.slug) + '</a>' +
      (counts ? '<span class="proj-meta">' + counts + '</span>' : '') +
      (x.description ? '<p class="proj-abstract">' + esc(x.description) + '</p>' : '') +
      '</div></li>';
  }
  function matches(x){
    if (!q) return true;
    return (String(x.title || x.slug) + ' ' + String(x.description || '')).toLowerCase().indexOf(q) !== -1;
  }

  function render(){
    var shown = guides.filter(matches);
    list.innerHTML = shown.length ? shown.map(rowHtml).join('')
      : (guides.length ? '<li class="proj-none"><p class="proj-empty">No guides match.</p></li>' : '');
    addBtn.disabled = !fullWrite;
    addBtn.title = fullWrite ? '' : G.NOT_PI;
  }
  if (search) search.addEventListener('input', function(){ q = search.value.trim().toLowerCase(); render(); });
  BOLD.mountViewToggle(document.querySelector('.view-toggle'), document.getElementById('guideViews'), 'boldGuides:view');

  addBtn.addEventListener('click', function(){ if (fullWrite) location.href = 'guide.html?new'; });

  var unsubscribe = null, signIns = 0;
  BOLD.onUser(function(user){
    var mine = ++signIns;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    fullWrite = false;
    guides = []; pending = {}; talk = {};
    render();
    if (!user) return;
    G.access(function(ok){ if (mine === signIns) { fullWrite = ok; render(); } });
    unsubscribe = db.collection('guides').onSnapshot(function(snap){
      loading.hidden = true;
      guides = snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.slug && !BOLD.GUIDE_PAGES[x.slug]; }).sort(G.byTitle);
      render();
      guides.forEach(function(x){
        db.collection('guides').doc(x.slug).collection('proposals').where('status', '==', 'open').get().then(function(s){
          if (mine !== signIns) return;
          pending[x.slug] = s.size;
          render();
        }).catch(function(err){ console.error('[BOLD Guides] counting proposed changes failed', err); });
        // Open comment threads: first comments not resolved.
        db.collection('guides').doc(x.slug).collection('comments').get().then(function(s){
          if (mine !== signIns) return;
          talk[x.slug] = s.docs.filter(function(d){ var c = d.data(); return !c.parent && !c.resolved; }).length;
          render();
        }).catch(function(err){ console.error('[BOLD Guides] counting comments failed', err); });
      });
    }, function(err){ console.error('[BOLD Guides] loading guides failed', err); });
  });
})();
