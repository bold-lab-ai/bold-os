// The local test copy only (scripts/test-site.sh; loaded when built with BOLD_TEST=1, never on
// the real site): Slack sign-in can't run in the Firebase Auth emulator, so "Sign in" offers the
// test accounts instead, each signed in as a Slack account would be (an `oidc.slack` credential
// with an unsigned token, which only the emulator accepts). A bar at the bottom says it's the
// test copy, who you are, and switches account. The accounts are scripts/test-seed.cjs's.
(function(){
  if (!window.BOLD_TEST) return;
  var ACCOUNTS = [
    { email: 'pi@example.com', name: 'Pat PI', id: 'UTESTPI', what: 'a PI (BOLD-exec): decides requests' },
    { email: 'internal@example.com', name: 'Ines Internal', id: 'UTESTIN', what: 'BOLD-internal, leads a project' },
    { email: 'associate@example.com', name: 'Ari Associate', id: 'UTESTAS', what: 'BOLD-associate, on a project' },
    { email: 'pan@example.com', name: 'Pan Person', id: 'UTESTPA', what: 'PAN-BOLD, details filled in' },
    { email: 'new@example.com', name: 'Nell New', id: 'UTESTNW', what: 'just signed in, nothing filled in' }
  ];
  var esc = function(s){ return String(s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var b64 = function(o){ return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); };
  function signInAs(a){
    var now = Math.floor(Date.now() / 1000);
    var token = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ iss: 'https://slack.com', aud: 'demo-bold-os', sub: a.id, email: a.email, email_verified: true, name: a.name, iat: now, exp: now + 3600 }) + '.';
    var cred = new firebase.auth.OAuthProvider('oidc.slack').credential({ idToken: token });
    return BOLD.getAuth().signInWithCredential(cred).catch(function(err){ console.error('[BOLD Test] signing in failed', err); window.alert('Couldn’t sign in: ' + (err && err.message)); });
  }
  function picker(){
    var d = document.createElement('div');
    d.className = 'confirm-dialog test-picker';
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', 'Sign in as');
    d.innerHTML = '<h2>Sign in as…</h2><p>The local test copy: nothing here is real, and nothing reaches Slack or email.</p><ul>' + ACCOUNTS.map(function(a, i){
      return '<li><button type="button" class="btn-box" data-i="' + i + '">' + esc(a.name) + '</button> <span>' + esc(a.what) + '</span></li>';
    }).join('') + '</ul><div class="confirm-actions"><button type="button" class="btn-box" data-no>Cancel</button></div>';
    var back = document.createElement('div'); back.className = 'confirm-backdrop';
    document.body.appendChild(back); document.body.appendChild(d);
    var close = function(){ d.remove(); back.remove(); };
    d.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b) return;
      close();
      if (b.hasAttribute('data-i')) signInAs(ACCOUNTS[+b.getAttribute('data-i')]);
    });
    var first = d.querySelector('[data-i]'); if (first) first.focus();
  }
  BOLD.signIn = function(){ picker(); };

  function bar(user){
    var el = document.getElementById('testBar');
    if (!el) { el = document.createElement('div'); el.id = 'testBar'; el.className = 'test-bar'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.innerHTML = '<strong>Local test copy</strong> · ' + (user ? esc(user.displayName || user.email) : 'signed out') +
      ' <button type="button" class="btn-text" data-switch>' + (user ? 'Switch account' : 'Sign in') + '</button>' +
      ' · <a href="http://127.0.0.1:4000/firestore" target="_blank" rel="noopener">Data</a> · <a href="http://127.0.0.1:4000/firestore/default/data/slackOutbox" target="_blank" rel="noopener">Slack outbox</a>';
    el.querySelector('[data-switch]').onclick = function(){
      if (user) BOLD.getAuth().signOut().then(picker); else picker();
    };
  }
  document.addEventListener('DOMContentLoaded', function(){
    var s = document.createElement('style');
    s.textContent = '.test-bar{position:fixed; left:12px; bottom:40px; z-index:1500; padding:6px 12px; font:13px/1.4 var(--sans); background:#b7791f; color:#fff; border-radius:var(--radius);}' +
      '.test-bar a, .test-bar .btn-text{color:#fff;}' +
      '.test-picker{position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:1600; width:min(460px, calc(100vw - 32px)); background:var(--surface); color:var(--ink); padding:18px 20px; border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); font-family:var(--sans);}' +
      '.test-picker h2{margin:0 0 4px; font-size:18px;} .test-picker p{margin:0 0 10px; font-size:13px; color:var(--muted);}' +
      '.test-picker ul{list-style:none; margin:0; padding:0;} .test-picker li{display:flex; gap:10px; align-items:center; padding:5px 0; font-size:13px; color:var(--ink-soft);}' +
      '.test-picker li .btn-box{min-width:130px; text-align:left;}' +
      '.confirm-backdrop{position:fixed; inset:0; z-index:1550; background:color-mix(in srgb, var(--shade) 35%, transparent);}';
    document.head.appendChild(s);
    BOLD.onUser(bar);
  });
})();
