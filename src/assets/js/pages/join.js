// join.html: anyone, signed in or not, asks to join BOLD (requestToJoin, which
// checks it again). Whoever they name as inviting them decides, on join-requests.html.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('joinBody');
  if (!box) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var opt = null, sent = false;

  function render(v){
    if (sent) {
      box.innerHTML = '<p class="jn-notice">Thanks, ' + esc(sent) + '. Your request is with your point of contact; you’ll hear by email.</p>';
      return;
    }
    box.innerHTML = '<div class="event-form join-form">' + BoldJoin.fieldsHtml(v, opt, { withIdentity: true }) +
      // Hidden from people: a bot fills it in.
      '<label class="jn-trap" aria-hidden="true">Website<input type="text" class="jn-website" tabindex="-1" autocomplete="off"></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save">Ask to join</button></div></div>';
    box.querySelector('.ev-save').addEventListener('click', send);
    wireInviter();
  }

  // Their point of contact, who invited them: names from the Slack roster, of those who can invite, as they type (joinInviters); choosing
  // one keeps its Slack id. Typing again clears the choice.
  function wireInviter(){
    var input = box.querySelector('.jn-inviter'), id = box.querySelector('.jn-inviter-id'), list = box.querySelector('.jn-inviter-list');
    if (!input) return;
    var seq = 0, timer = null, active = -1;
    function hide(){ list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; }
    function choose(li){ input.value = li.getAttribute('data-name'); id.value = li.getAttribute('data-id'); hide(); }
    input.addEventListener('input', function(){
      id.value = ''; clearTimeout(timer);
      var q = input.value.trim(), mine = ++seq;
      if (q.length < 2) { hide(); return; }
      timer = setTimeout(function(){
        firebase.app().functions('europe-west2').httpsCallable('joinInviters')({ q: q }).then(function(r){
          if (mine !== seq) return;
          var people = (r.data && r.data.people) || [];
          list.innerHTML = people.length ? people.map(function(p){
            return '<li role="option" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' + esc(p.name) + '</li>';
          }).join('') : '<li class="jn-none">No one by that name can invite you to BOLD</li>';
          list.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
        }).catch(function(err){ console.error('[BOLD Join] finding people failed', err); });
      }, 250);
    });
    list.addEventListener('mousedown', function(e){
      var li = e.target.closest('li[data-id]');
      if (li) { e.preventDefault(); choose(li); }
    });
    input.addEventListener('keydown', function(e){
      var items = list.querySelectorAll('li[data-id]');
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        Array.prototype.forEach.call(items, function(li, i){ li.classList.toggle('active', i === active); });
      } else if (e.key === 'Enter') { e.preventDefault(); choose(items[Math.max(active, 0)]); }
      else if (e.key === 'Escape') hide();
    });
    input.addEventListener('blur', function(){ setTimeout(hide, 150); });
  }

  function showError(msg){ var e = box.querySelector('.ev-error'); e.textContent = msg; e.hidden = !msg; }

  function send(){
    var form = box.querySelector('.join-form'), d = BoldJoin.read(form);
    d.website = form.querySelector('.jn-website').value;
    var p = BoldJoin.problem(d);
    showError(p);
    if (p) return;
    delete d.inviterTyped;
    BOLD.confirmAction({ title: 'Send your request?', go: 'Send', effects: ['Send your point of contact a Slack message, to approve or decline it'] }).then(function(ok){ if (ok) sendRequest(d); });
  }
  function sendRequest(d){
    var btn = box.querySelector('.ev-save');
    btn.disabled = true; showError('');
    firebase.app().functions('europe-west2').httpsCallable('requestToJoin')(d).then(function(){
      sent = d.name.split(' ')[0] || d.name; render();
    }).catch(function(err){
      console.error('[BOLD Join] sending the request failed', err);
      showError(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t send it — try again.');
      btn.disabled = false;
    });
  }

  BoldJoin.options(db, function(o){ opt = o; render({}); });
})();
