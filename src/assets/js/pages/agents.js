// agents.html: two tabs, Agents (#agents: personal API tokens, functions/api.js) and
// Activity (#activity: their access log), both through apiTokens 'activity'. Yours; for
// PIs and admins Everyone's by default, Yours on #agents-mine, #activity-mine (and the old
// #mine), and they can revoke any token or stop it acting. The old #everyone is Activity. Letting a token act is decided on the
// Requests page (join-requests.js, Agents tab).
(function(){
  var root = document.getElementById('agents');
  if (!root || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('apiTokens')(data).then(function(r){ return r.data; }); };
  var whoseBar = document.getElementById('agWhose');
  var full = false, data = null, loaded = '', busy = false;
  function when(t, time){
    if (!t) return '';
    var d = new Date(t);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (time ? ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
  }
  function tab(){ return /^#(activity|everyone)/.test(location.hash) ? 'activity' : 'agents'; }
  function whose(){ return full && !/mine/.test(location.hash) ? 'everyone' : 'mine'; }
  function hashFor(t, w){ return '#' + t + (full && w === 'mine' ? '-mine' : ''); }

  function render(){
    Array.prototype.forEach.call(document.querySelectorAll('#agTabs .guide-tab'), function(a){
      var t = a.getAttribute('data-tab'), on = t === tab();
      a.setAttribute('href', hashFor(t, whose()));
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    whoseBar.hidden = !full;
    whoseBar.innerHTML = [['everyone', 'Everyone’s'], ['mine', 'Yours']].map(function(w){
      return '<a href="' + hashFor(tab(), w[0]) + '"' + (w[0] === whose() ? ' class="is-current" aria-current="true"' : '') + '>' + w[1] + '</a>';
    }).join(' · ');
    if (!data) { root.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    var all = data.all, off = busy ? ' disabled' : '';
    root.innerHTML = tab() === 'agents' ?
      (data.tokens.length ? '<ul class="lt-list">' + data.tokens.map(function(t){
        return '<li class="lt-item"><span class="lt-title">' + esc(t.label) + (all ? ' <span class="ag-owner">· ' + esc(t.owner) + '</span>' : '') + '</span>' +
          '<span class="lt-meta"><code>' + esc(t.prefix) + '…</code> · ' + (t.write ? 'Reads and acts' : t.act === 'open' ? 'Reads · asked to act' : 'Reads') + ' · made ' + when(t.createdAt) +
          ' · ' + (t.lastUsedAt ? 'last used ' + when(t.lastUsedAt, true) : 'not used yet') + '</span>' +
          '<div class="event-controls">' + (t.write ? '<button type="button" class="btn-text ag-stop" data-id="' + esc(t.id) + '"' + off + '>Stop acting</button>' : '') +
          '<button type="button" class="btn-text danger ag-revoke" data-id="' + esc(t.id) + '"' + off + '>Revoke</button></div></li>';
      }).join('') + '</ul>' : '<p class="proj-msg">' + (all ? 'Nobody has a token yet.' : 'You have no tokens. Make one on <a href="profile.html#agents">your profile</a>.') + '</p>') :
      (data.log.length ? '<ul class="ag-log">' + data.log.map(function(x){
        return '<li><span class="ag-when">' + when(x.at, true) + '</span><span class="ag-what"><strong>' + esc(x.tool) + '</strong>' +
          (x.args ? ' <code>' + esc(x.args) + '</code>' : '') + '<span class="lt-meta">' + (all ? esc(x.who) + ' · ' : '') + esc(x.token) + '</span></span></li>';
      }).join('') + '</ul>' : '<p class="proj-msg">Nothing yet.</p>');
  }
  // One call gives both tabs; a new one only when Yours/Everyone's changes.
  function load(){
    if (loaded === whose()) { render(); return; }
    loaded = whose(); data = null; render();
    var w = loaded;
    call({ action: 'activity', all: w === 'everyone' }).then(function(d){ if (loaded === w) { data = d; render(); } })
      .catch(function(err){ console.error('[BOLD Agents] loading failed', err); loaded = ''; root.innerHTML = '<p class="proj-msg">Couldn’t load this. Try reloading the page.</p>'; });
  }
  window.addEventListener('hashchange', load);
  root.addEventListener('click', function(e){
    var b = e.target.closest('.ag-revoke, .ag-stop');
    if (!b || b.disabled) return;
    var stop = b.classList.contains('ag-stop');
    if (!window.confirm(stop ? 'Stop this token acting? It still reads.' : 'Revoke this token? Whatever uses it stops working at once.')) return;
    busy = true; render();
    call({ action: stop ? 'stopAct' : 'revoke', id: b.getAttribute('data-id') }).catch(function(err){
      console.error('[BOLD Agents] revoking failed', err); window.alert('That didn’t work — try again.');
    }).then(function(){ busy = false; loaded = ''; load(); });
  });
  BOLD.onUser(function(user){
    if (!user) return;
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')({}).then(function(r){
      full = !!(r.data && r.data.fullWrite);
    }).catch(function(){}).then(load);
  });
})();
