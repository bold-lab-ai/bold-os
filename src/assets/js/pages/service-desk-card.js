// service-desk-card.html?card=<id>: one Service desk card's own page (serviceDesk/{id}; the list is
// service-desk.html). Its title and description, its file (Download: a short-lived link from
// serviceDeskFile, functions/service-desk.js), and its About (Markdown, BoldMarkdown). A card that
// opens a page or link has that instead of a file. PIs and admins edit it on the Service desk.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('card');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var id = new URLSearchParams(location.search).get('card') || '';
  var c = null, fullWrite = false, unsub = null, busy = false;
  var NO = 'Only PIs and admins change the Service desk.';

  function size(n){ return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function errText(e, fallback){ return e && e.message && e.code !== 'functions/internal' ? e.message : fallback; }

  function render(){
    if (c === false) {
      document.getElementById('cardTitle').textContent = 'Not on the Service desk';
      main.innerHTML = '<p class="proj-msg">This card isn’t there any more. <a href="service-desk.html">Back to the Service desk</a></p>';
      return;
    }
    if (!c) return;
    document.title = c.title + ' | BOLD Lab';
    document.getElementById('cardTitle').textContent = c.title;
    document.getElementById('cardText').textContent = c.text || '';
    var file = c.file && c.file.path;
    var external = !file && /^https:/.test(c.href || '');
    var get = file
      ? '<button type="button" class="btn btn-primary sdc-download">Download</button>' +
        '<span class="proj-meta">' + esc(c.file.name) + ' · ' + size(c.file.size || 0) + (c.file.at ? ' · updated ' + when(c.file.at) : '') + '</span>'
      : c.href ? '<a class="btn btn-primary" href="' + esc(c.href) + '"' + (external ? ' target="_blank" rel="noopener"' : '') + '>Open</a>'
      : '<span class="proj-meta">Not available yet</span>';
    var edit = '<a class="btn sdc-edit' + (fullWrite ? '' : ' is-off') + '" href="' + (fullWrite ? 'service-desk.html?edit=' + encodeURIComponent(c.id) : '#') + '"' +
      (fullWrite ? '' : ' aria-disabled="true" title="' + esc(NO) + '"') + '>Edit</a>';
    main.innerHTML = '<div class="actions sdc-get"><div class="sdc-file">' + get + '</div>' + edit + '</div>' +
      '<p class="ev-error sdc-error" hidden></p>' +
      (c.about ? '<div class="md-desc sdc-about">' + BoldMarkdown.render(c.about) + '</div>' : '');
    if (window.BoldMarkdown && BoldMarkdown.typeset) BoldMarkdown.typeset(main);
  }

  main.addEventListener('click', function(e){
    if (e.target.closest('.sdc-edit.is-off')) { e.preventDefault(); return; }
    var b = e.target.closest('.sdc-download');
    if (!b || busy) return;
    busy = true; b.disabled = true; b.textContent = 'Getting it…';
    var err = main.querySelector('.sdc-error'); err.hidden = true;
    firebase.app().functions('europe-west2').httpsCallable('serviceDeskFile')({ action: 'link', id: id })
      .then(function(r){ window.location.href = r.data.url; })
      .catch(function(e){ console.error('[BOLD Service desk] download failed', e); err.textContent = errText(e, 'Couldn’t download it. Try again.'); err.hidden = false; })
      .then(function(){ busy = false; b.disabled = false; b.textContent = 'Download'; });
  });

  BOLD.onAccess(function(a){ fullWrite = !!(a && a.fullWrite && !a.viewAs); render(); });
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    c = null;
    if (!user) return;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { c = false; return render(); }
    unsub = db.collection('serviceDesk').doc(id).onSnapshot(function(snap){
      c = snap.exists ? Object.assign({ id: snap.id }, snap.data()) : false;
      render();
    }, function(err){
      if (!BOLD.getAuth().currentUser) return;
      console.error('[BOLD Service desk] loading the card failed', err);
      main.innerHTML = '<p class="proj-msg">Couldn’t load this card.</p>';
    });
  });
})();
