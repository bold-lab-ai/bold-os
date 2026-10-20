// agents.html: personal API tokens (functions/api.js) and their access log, through
// apiTokens 'activity'. Yours by default; PIs and admins also see Everyone's (#everyone)
// and can revoke any token.
(function(){
  var root = document.getElementById('agents');
  if (!root || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('apiTokens')(data).then(function(r){ return r.data; }); };
  var full = false, data = null, busy = false;
  function when(t, time){
    if (!t) return '';
    var d = new Date(t);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (time ? ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
  }
  function whose(){ return full && location.hash === '#everyone' ? 'everyone' : 'mine'; }

  function render(){
    Array.prototype.forEach.call(document.querySelectorAll('#agTabs .guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + whose();
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (!data) { root.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    var all = data.all, off = busy ? ' disabled' : '';
    root.innerHTML =
      '<section class="block"><div class="block-head"><h2>Tokens<span class="proj-count">' + data.tokens.length + '</span></h2></div>' +
      (data.tokens.length ? '<ul class="lt-list">' + data.tokens.map(function(t){
        return '<li class="lt-item"><span class="lt-title">' + esc(t.label) + (all ? ' <span class="ag-owner">· ' + esc(t.owner) + '</span>' : '') + '</span>' +
          '<span class="lt-meta"><code>' + esc(t.prefix) + '…</code> · ' + (t.write ? 'Reads and acts' : 'Reads') + ' · made ' + when(t.createdAt) +
          ' · ' + (t.lastUsedAt ? 'last used ' + when(t.lastUsedAt, true) : 'not used yet') + '</span>' +
          '<div class="event-controls"><button type="button" class="btn-text danger ag-revoke" data-id="' + esc(t.id) + '"' + off + '>Revoke</button></div></li>';
      }).join('') + '</ul>' : '<p class="proj-msg">' + (all ? 'Nobody has a token yet.' : 'You have no tokens. Make one on <a href="profile.html#linked-accounts">your profile</a>.') + '</p>') + '</section>' +
      '<section class="block"><div class="block-head"><h2>What they did</h2></div>' +
      (data.log.length ? '<ul class="ag-log">' + data.log.map(function(x){
        return '<li><span class="ag-when">' + when(x.at, true) + '</span><span class="ag-what"><strong>' + esc(x.tool) + '</strong>' +
          (x.args ? ' <code>' + esc(x.args) + '</code>' : '') + '<span class="lt-meta">' + (all ? esc(x.who) + ' · ' : '') + esc(x.token) + '</span></span></li>';
      }).join('') + '</ul>' : '<p class="proj-msg">Nothing yet.</p>') + '</section>';
  }
  function load(){
    data = null; render();
    call({ action: 'activity', all: whose() === 'everyone' }).then(function(d){ data = d; render(); })
      .catch(function(err){ console.error('[BOLD Agents] loading failed', err); root.innerHTML = '<p class="proj-msg">Couldn’t load this. Try reloading the page.</p>'; });
  }
  window.addEventListener('hashchange', load);
  root.addEventListener('click', function(e){
    var b = e.target.closest('.ag-revoke');
    if (!b || b.disabled) return;
    if (!window.confirm('Revoke this token? Whatever uses it stops working at once.')) return;
    busy = true; render();
    call({ action: 'revoke', id: b.getAttribute('data-id') }).catch(function(err){
      console.error('[BOLD Agents] revoking failed', err); window.alert('Couldn’t revoke it — try again.');
    }).then(function(){ busy = false; load(); });
  });
  BOLD.onUser(function(user){
    if (!user) return;
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')({}).then(function(r){
      full = !!(r.data && r.data.fullWrite);
      document.getElementById('agTabs').hidden = !full;
    }).catch(function(){}).then(load);
  });
})();
