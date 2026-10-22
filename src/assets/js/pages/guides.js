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

  function cardHtml(x){
    var n = pending[x.slug] || 0, c = talk[x.slug] || 0;
    var counts = [n ? n + ' proposed change' + (n === 1 ? '' : 's') : '', c ? c + ' comment' + (c === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
    return '<a class="event-card" href="guide.html?guide=' + encodeURIComponent(x.slug) + '">' +
      '<h3>' + esc(x.title || x.slug) + '</h3>' +
      (counts ? '<p class="event-when">' + counts + '</p>' : '') +
      '<p>' + esc(x.description || '') + '</p>' +
      '<span class="event-cta">Read the guide &rarr;</span></a>';
  }

  function render(){
    list.innerHTML = guides.map(function(x){ return '<li>' + cardHtml(x) + '</li>'; }).join('');
    addBtn.disabled = !fullWrite;
    addBtn.title = fullWrite ? '' : G.NOT_PI;
  }

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
