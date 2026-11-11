// profile.html › Linked accounts › Free/busy calendars (#323, 2026-11-11; several since the same day: Google
// and Outlook, say, up to 5): calendar addresses that show when you're busy, so Suggest times on a project's meeting fits around you (busyFeed in
// functions/index.js; kept where only BOLD.OS's server reads it, and only when you're busy is read).
(function(){
  var box = document.getElementById('busyBody');
  if (!box || !BOLD.getAuth()) return;
  var MAX = 5, esc = BOLD.escapeHtml, feed = null, busy = false, error = '', done = '', adding = false;
  function call(d){ return firebase.app().functions('europe-west2').httpsCallable('busyFeed')(d).then(function(r){ return r.data || {}; }); }
  var HOW = '<details class="busy-how"><summary>Where to find it</summary><ul>' +
    '<li><b>Google Calendar:</b> Settings › your calendar › Access permissions: tick “Make available to public” with “See only free/busy”; then copy its link (Get shareable link) or, under Integrate calendar, the “Public address in iCal format”.</li>' +
    '<li><b>Outlook:</b> Settings › Calendar › Shared calendars › Publish a calendar, with “Can view when I’m busy”; copy the ICS link.</li>' +
    '<li><b>iCloud:</b> share the calendar as a public calendar and copy its link.</li></ul>' +
    '<p>A secret address works too: BOLD.OS reads only when you’re busy, never what, and keeps the link where only its server can read it.</p></details>';
  // Which service a calendar is from, by its address.
  function source(url){
    var host = ''; try { host = new URL(url).hostname; } catch (e){}
    return /google\.com$/.test(host) ? 'Google' : /outlook\.|office/.test(host) ? 'Outlook' : /icloud\.com$/.test(host) ? 'iCloud' : host;
  }
  function render(){
    var err = error ? '<span class="gh-error">' + esc(error) + '</span>' : '', off = busy ? ' disabled' : '';
    if (feed === null) { box.innerHTML = '<span class="proj-msg">Loading&hellip;</span>'; return; }
    var list = feed.feeds || [], full = list.length >= MAX, form = adding || !list.length;
    // Every calendar added, its link in full, then a + for another.
    var rows = list.map(function(f){
      return '<li class="busy-feed"><span class="busy-feed-text"><span class="busy-feed-name">' + esc(source(f.url)) + (f.name ? ': ' + esc(f.name) : '') +
        (f.at ? ' <span class="busy-when">· added ' + esc(new Date(f.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) + '</span>' : '') + '</span>' +
        '<span class="busy-link" title="' + esc(f.url) + '">' + esc(f.url) + '</span></span>' +
        '<button type="button" class="btn-box busy-remove" data-id="' + esc(f.id) + '"' + off + '>Remove</button></li>';
    }).join('');
    var add = form
      ? '<li class="busy-new"><span class="busy-add"><input type="url" class="busy-url" maxlength="1000" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="Calendar address"' + off + '></span>' +
        '<span class="busy-new-actions"><button type="button" class="btn-box is-primary busy-save"' + off + '>' + (busy ? 'Checking…' : 'Add') + '</button>' +
        (list.length ? '<button type="button" class="btn-box busy-cancel"' + off + '>Cancel</button>' : '') + '</span></li>'
      : full ? '' : '<li class="busy-plus-row"><button type="button" class="busy-plus busy-change" aria-label="Add a calendar" title="Add a calendar"' + off + '>+</button></li>';
    box.innerHTML = '<span class="gh-line">' + (list.length
        ? 'Suggest times on your projects’ meetings fits around when you’re busy in ' + (list.length === 1 ? 'this calendar' : 'any of these') + '.' + (done ? ' ' + esc(done) : '')
        : 'Not added. Suggest times on your projects’ meetings counts only your BOLD.OS meetings. Add calendars that show when you’re busy: Google, Outlook, iCloud, several if you use more than one.') +
      '<ul class="busy-feeds">' + rows + add + '</ul>' + HOW + '</span>' + err;
  }
  box.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.classList.contains('busy-change')) { adding = true; error = ''; done = ''; render(); return; }
    if (b.classList.contains('busy-cancel')) { adding = false; error = ''; render(); return; }
    if (b.classList.contains('busy-remove')) {
      busy = true; error = ''; done = ''; render();
      call({ action: 'clear', id: b.getAttribute('data-id') }).then(function(r){ feed = r; }, function(err){ error = (err && err.message) || 'Couldn’t remove it — try again.'; })
        .then(function(){ busy = false; render(); });
      return;
    }
    if (b.classList.contains('busy-save')) {
      var url = box.querySelector('.busy-url').value.trim();
      if (!url) { error = 'Paste the calendar’s address first.'; render(); return; }
      busy = true; error = ''; render();
      box.querySelector('.busy-url').value = url;
      // Read once on the server: a link that doesn't work isn't saved.
      call({ action: 'set', url: url }).then(function(r){
        feed = { feeds: r.feeds || [] }; adding = false;
        done = 'Added: ' + r.busy + (r.busy === 1 ? ' busy time' : ' busy times') + ' in the next 4 weeks.';
      }, function(err){ error = (err && err.message) || 'Couldn’t add it — try again.'; })
        .then(function(){ var v = url; busy = false; render(); var i = box.querySelector('.busy-url'); if (i && error) i.value = v; });
    }
  });
  box.addEventListener('keydown', function(e){ if (e.key === 'Enter' && e.target.classList.contains('busy-url')) { e.preventDefault(); var s = box.querySelector('.busy-save'); if (s) s.click(); } });
  BOLD.onUser(function(user){
    feed = null; adding = false; error = ''; done = '';
    if (!user) return;
    render();
    call({ action: 'get' }).then(function(r){ feed = r; render(); }, function(err){ console.error('[BOLD Profile] loading your free/busy calendar failed', err); feed = {}; error = 'Couldn’t load it — reload to try again.'; render(); });
  });
})();
