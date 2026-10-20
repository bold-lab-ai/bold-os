// The profile's Agents tab: personal tokens that let an AI agent
// read BOLD.OS as you, through MCP or the JSON API (boldApi and apiTokens in
// functions/api.js); a token acts as you too only once a PI or admin approves (Ask to
// act, decided on the Requests page). A new token is shown once, with how to add it to Claude Code.
(function(){
  var box = document.getElementById('agentsBody');
  if (!box || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var API = 'https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi';
  var tokens = null, fresh = null, busy = false, error = '';
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('apiTokens')(data).then(function(r){ return r.data; }); };
  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

  function scope(t){
    return t.write ? 'Reads and acts' : t.act === 'open' ? 'Reads · asked to act, waiting for a PI or admin' : t.act === 'declined' ? 'Reads · acting declined' : 'Reads';
  }
  var ASK = 'Asking lets it act for you once a PI or admin approves: join projects, ask for introductions and letters, comment, propose changes and more. People get Slack messages from you.';
  function render(){
    if (tokens === null) { box.innerHTML = '<span class="proj-msg">Loading&hellip;</span>'; return; }
    var off = busy ? ' disabled' : '';
    box.innerHTML = '<p class="hero-note">Let an AI agent use BOLD.OS as you, through MCP: it reads what you can read, and acts for you once a PI or admin approves. <a href="agents.html">What your tokens did</a>.</p>' +
      (fresh ? '<div class="api-fresh"><p class="acct-note">Your token for <strong>' + esc(fresh.label) + '</strong>, shown only now:</p>' + BOLD.copyBoxHtml(fresh.token) +
        '<p class="acct-note">To add it to Claude Code:</p>' +
        BOLD.copyBoxHtml('claude mcp add --transport http bold-os ' + API + '/mcp --header "Authorization: Bearer ' + fresh.token + '"') +
        '<p class="acct-note">Other agents: MCP at <code>' + esc(API) + '/mcp</code>, or JSON at <code>' + esc(API) + '/v1/&lt;tool&gt;</code>, with the header <code>Authorization: Bearer &lt;token&gt;</code>.</p></div>' : '') +
      (tokens.length ? '<ul class="api-tokens">' + tokens.map(function(t){
        return '<li><span class="acct-text"><span>' + esc(t.label) + ' <code>' + esc(t.prefix) + '…</code></span>' +
          '<span class="acct-handle">' + scope(t) + ' · made ' + when(t.createdAt) + ' · ' + (t.lastUsedAt ? 'last used ' + when(t.lastUsedAt) : 'not used yet') + '</span></span>' +
          '<span class="api-btns">' + (t.write ? '<button type="button" class="btn-text api-stop" data-id="' + esc(t.id) + '"' + off + '>Stop acting</button>'
            : t.act !== 'open' ? '<button type="button" class="btn-text api-ask" data-id="' + esc(t.id) + '"' + off + '>Ask to act</button>' : '') +
          '<button type="button" class="btn-text danger api-revoke" data-id="' + esc(t.id) + '"' + off + '>Revoke</button></span></li>';
      }).join('') + '</ul>' : '') +
      (error ? '<span class="gh-error">' + esc(error) + '</span>' : '') +
      '<span class="api-new"><input type="text" class="api-label" maxlength="60" placeholder="Name it, e.g. Claude Code on my laptop" aria-label="Token name"' + off + '>' +
      '<button type="button" class="btn-box is-primary api-create"' + off + '>New token</button>' +
      '<label class="api-write"><input type="checkbox" class="api-can-act"' + off + '> Also ask to let it act for me. ' + ASK + '</label></span>';
  }
  function load(){
    call({ action: 'list' }).then(function(d){ tokens = d.tokens || []; render(); })
      .catch(function(err){ console.error('[BOLD Agents] listing tokens failed', err); tokens = []; error = 'Couldn’t load your tokens — reload to try again.'; render(); });
  }
  box.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('api-create')) {
      var label = box.querySelector('.api-label').value.trim(), write = box.querySelector('.api-can-act').checked;
      if (!label) { error = 'Name it first, after the agent that will use it.'; render(); return; }
      busy = true; error = ''; render();
      call({ action: 'create', label: label, askAct: write }).then(function(d){
        fresh = { label: d.label, token: d.token };
        tokens.unshift({ id: d.id, label: d.label, prefix: d.prefix, write: d.write, act: d.act, createdAt: d.createdAt, lastUsedAt: 0 });
      }).catch(function(err){
        console.error('[BOLD Agents] making a token failed', err);
        error = err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t make a token — try again.';
      }).then(function(){ busy = false; render(); });
    } else if (t.classList.contains('api-ask') || t.classList.contains('api-stop')) {
      var ask = t.classList.contains('api-ask');
      if (!window.confirm(ask ? ASK + ' Ask?' : 'Stop it acting for you? It still reads.')) return;
      busy = true; error = ''; render();
      call({ action: ask ? 'askAct' : 'stopAct', id: t.getAttribute('data-id') }).then(load).catch(function(err){
        console.error('[BOLD Agents] that failed', err);
        error = err && err.message && err.code !== 'functions/internal' ? err.message : 'That didn’t work — try again.';
      }).then(function(){ busy = false; render(); });
    } else if (t.classList.contains('api-revoke')) {
      if (!window.confirm('Revoke this token? Whatever uses it stops working at once.')) return;
      var id = t.getAttribute('data-id');
      busy = true; error = ''; render();
      call({ action: 'revoke', id: id }).then(function(){
        tokens = tokens.filter(function(x){ return x.id !== id; });
        if (fresh && tokens.every(function(x){ return x.label !== fresh.label; })) fresh = null;
      }).catch(function(err){ console.error('[BOLD Agents] revoking failed', err); error = 'Couldn’t revoke it — try again.'; })
        .then(function(){ busy = false; render(); });
    }
  });
  box.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && e.target.classList.contains('api-label')) { e.preventDefault(); box.querySelector('.api-create').click(); }
  });
  BOLD.onUser(function(user){ tokens = null; fresh = null; error = ''; if (user) { render(); load(); } else box.innerHTML = ''; });
})();
