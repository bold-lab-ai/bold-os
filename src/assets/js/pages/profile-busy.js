// profile.html › Linked accounts › Free/busy calendar (#323, 2026-11-11): a calendar address that shows
// when you're busy, so Suggest times on a project's meeting fits around you (busyFeed in
// functions/index.js; kept where only BOLD.OS's server reads it, and only when you're busy is read).
(function(){
  var box = document.getElementById('busyBody');
  if (!box || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml, feed = null, busy = false, error = '', done = '', adding = false;
  function call(d){ return firebase.app().functions('europe-west2').httpsCallable('busyFeed')(d).then(function(r){ return r.data || {}; }); }
  var HOW = '<details class="busy-how"><summary>Where to find it</summary><ul>' +
    '<li><b>Google Calendar:</b> Settings › your calendar › Access permissions: tick “Make available to public” with “See only free/busy”; then copy its link (Get shareable link) or, under Integrate calendar, the “Public address in iCal format”.</li>' +
    '<li><b>Outlook:</b> Settings › Calendar › Shared calendars › Publish a calendar, with “Can view when I’m busy”; copy the ICS link.</li>' +
    '<li><b>iCloud:</b> share the calendar as a public calendar and copy its link.</li></ul>' +
    '<p>A secret address works too: BOLD.OS reads only when you’re busy, never what, and keeps the link where only its server can read it.</p></details>';
  function render(){
    var err = error ? '<span class="gh-error">' + esc(error) + '</span>' : '', off = busy ? ' disabled' : '';
    if (feed === null) { box.innerHTML = '<span class="proj-msg">Loading&hellip;</span>'; return; }
    if (feed.url && !adding) {
      var host = ''; try { host = new URL(feed.url).hostname; } catch (e){}
      box.innerHTML = '<span class="gh-line">Added' + (host ? ' (' + esc(host) + ')' : '') + '. Suggest times on your projects’ meetings fits around when you’re busy.' + (done ? ' ' + esc(done) : '') + '</span>' + err +
        '<span class="gh-actions"><button type="button" class="btn-box busy-change"' + off + '>Change</button><button type="button" class="btn-box busy-remove"' + off + '>Remove</button></span>';
      return;
    }
    box.innerHTML = '<span class="gh-line">' + (adding ? '' : 'Not added. Suggest times on your projects’ meetings counts only your BOLD.OS meetings. ') +
      'Add a calendar address that shows when you’re busy.' +
      '<span class="busy-add"><input type="url" class="busy-url" maxlength="1000" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="Free/busy calendar address"' + off + '></span>' + HOW + '</span>' + err +
      '<span class="gh-actions"><button type="button" class="btn-box is-primary busy-save"' + off + '>' + (busy ? 'Checking…' : 'Add') + '</button>' +
      (adding ? '<button type="button" class="btn-box busy-cancel"' + off + '>Cancel</button>' : '') + '</span>';
  }
  box.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.classList.contains('busy-change')) { adding = true; error = ''; done = ''; render(); return; }
    if (b.classList.contains('busy-cancel')) { adding = false; error = ''; render(); return; }
    if (b.classList.contains('busy-remove')) {
      busy = true; error = ''; render();
      call({ action: 'clear' }).then(function(){ feed = {}; }, function(err){ error = (err && err.message) || 'Couldn’t remove it — try again.'; })
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
        feed = { url: r.url }; adding = false;
        done = r.busy + (r.busy === 1 ? ' busy time' : ' busy times') + ' in the next 4 weeks.';
      }, function(err){ error = (err && err.message) || 'Couldn’t add it — try again.'; })
        .then(function(){ var v = url; busy = false; render(); var i = box.querySelector('.busy-url'); if (i) i.value = v; });
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
