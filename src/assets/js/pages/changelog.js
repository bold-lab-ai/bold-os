// The changelog (changelog.html): every change to the site, newest first, by
// day. Code: the commits, read from git when the site is built (_data/commits.js,
// window.BOLD_COMMITS), each linking to it on GitHub. Content: every version of
// a tracked document (skills, guides, the BOLDiquette), in brief in Firestore
// changelog/{id} (recordVersions in functions/index.js), each linking to its page.
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('changelog');
  if (!root || !BOLD.getAuth()) return;
  var REPO = 'https://github.com/bold-lab-ai/bold-os/commit/';
  var PAGE = 60;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var KIND = { created: 'added', edited: 'edited', deleted: 'deleted' };

  var code = (window.BOLD_COMMITS || []).map(function(c){ return Object.assign({ type: 'code' }, c); });
  var content = [], contentLoaded = false, contentFailed = false;
  var show = 'all', shown = PAGE;

  function day(ms){ var d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function time(ms){ var d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  // Where a content change can be read, if its document still exists.
  function pageOf(e){
    if (e.kind === 'deleted') return '';
    if (e.collection === 'skills') return 'skill.html?skill=' + encodeURIComponent(e.docId);
    if (e.collection === 'guides') return BOLD.guideHref(e.docId);
    if (e.collection === 'handbook' && e.docId === 'boldiquette') return 'boldiquette.html';
    return '';
  }
  function person(p){ return p ? (p.name || p.email || '') : ''; }

  function rowHtml(e){
    var what;
    if (e.type === 'code') {
      what = '<a href="' + REPO + esc(e.hash) + '" target="_blank" rel="noopener">' + esc(e.subject) + '</a>' +
        '<span class="cl-who">' + esc(e.author || '') + '</span>';
    } else {
      var href = pageOf(e), title = href ? '<a href="' + esc(href) + '">' + esc(e.title) + '</a>' : esc(e.title);
      var by = person(e.by), proposed = person(e.proposedBy);
      what = title + ' ' + (KIND[e.kind] || 'changed') +
        (by ? '<span class="cl-who">' + esc(by) + (proposed ? ', proposed by ' + esc(proposed) : '') + '</span>' : '') +
        (e.note ? '<span class="cl-msg">' + esc(e.note) + '</span>' : '');
    }
    return '<li class="cl-item"><span class="cl-time">' + time(e.at) + '</span>' +
      '<span class="cl-type">' + (e.type === 'code' ? 'Code' : 'Content') + '</span>' +
      '<span class="cl-what">' + what + '</span></li>';
  }

  function render(){
    var list = (show === 'code' ? [] : content).concat(show === 'content' ? [] : code)
      .sort(function(a, b){ return b.at - a.at; });
    var filters = '<p class="cl-filters">' + [['all', 'All'], ['content', 'Content'], ['code', 'Code']].map(function(f){
      return '<button type="button" class="btn-text cl-filter' + (show === f[0] ? ' is-current' : '') + '" data-show="' + f[0] + '"' +
        (show === f[0] ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + f[1] + '</button>';
    }).join('') + '</p>';
    var note = !contentLoaded && show !== 'code' ? '<p class="cl-note">Loading the content changes…</p>' :
      contentFailed && show !== 'code' ? '<p class="cl-note">Couldn’t load the content changes.</p>' : '';
    var html = '', current = null, open = false;
    list.slice(0, shown).forEach(function(e){
      var d = day(e.at);
      if (d !== current) {
        if (open) html += '</ol></section>';
        html += '<section class="block cl-day"><div class="block-head"><h2>' + esc(d) + '</h2></div><ol class="cl-list">';
        current = d; open = true;
      }
      html += rowHtml(e);
    });
    if (open) html += '</ol></section>';
    if (!list.length && (contentLoaded || show === 'code')) html = '<p class="cl-note">Nothing yet.</p>';
    root.innerHTML = filters + note + html +
      (list.length > shown ? '<button type="button" class="btn-text cl-more">Show more</button>' : '');
  }

  root.addEventListener('click', function(e){
    var f = e.target.closest('.cl-filter');
    if (f) { show = f.getAttribute('data-show'); shown = PAGE; render(); return; }
    if (e.target.closest('.cl-more')) { shown += PAGE; render(); }
  });

  render();
  var stop = null;
  BOLD.onUser(function(user){
    if (stop) { stop(); stop = null; }
    if (!user) return;
    stop = firebase.firestore(BOLD.getApp()).collection('changelog').orderBy('at', 'desc').limit(1000).onSnapshot(function(snap){
      content = snap.docs.map(function(d){ return Object.assign({ type: 'content', id: d.id }, d.data()); });
      contentLoaded = true; contentFailed = false;
      render();
    }, function(err){
      console.error('[BOLD Changelog] loading the content changes failed', err);
      contentLoaded = true; contentFailed = true;
      render();
    });
  });
})();
