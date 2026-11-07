// join.html: anyone, signed in or not, asks to join BOLD (requestToJoin, which
// checks it again). Whoever they name as inviting them decides, on join-requests.html.
// ?invite=<id>: invited to a project by email (projectInvite, #148): whoever invited them is
// filled in, and the request carries the invitation, so they're on the project once approved.
// ?changes=<id>&key=<key>: their point of contact asked them to change their request (joinChanges,
// #261; the link is in the email they got): it opens filled in, under what was asked, and sends
// the changes to the same request.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('joinBody');
  if (!box) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var opt = null, sent = false;
  var invite = (/[?&]invite=([A-Za-z0-9]+)/.exec(location.search) || [])[1] || '', invited = null;
  var changesId = (/[?&]changes=([A-Za-z0-9]+)/.exec(location.search) || [])[1] || '', changesKey = (/[?&]key=([a-f0-9]+)/.exec(location.search) || [])[1] || '';
  var changes = null, changesError = '';
  var call = function(name, data){ return firebase.app().functions('europe-west2').httpsCallable(name)(data); };

  function render(v){
    if (changesError) { box.innerHTML = '<p class="jn-notice">' + esc(changesError) + '</p>'; return; }
    if (sent && changes) { box.innerHTML = '<p class="jn-notice">Thanks, ' + esc(sent) + '. Your changes are with ' + esc(changes.inviterName) + '; you’ll hear by email.</p>'; return; }
    if (sent) {
      box.innerHTML = '<p class="jn-notice">Thanks, ' + esc(sent) + '. Your request is with your point of contact; you’ll hear by email.</p>' +
        // Another group is a second request, to the PIs and admins (groupRequest), not part of this one.
        '<p class="jn-notice">You join as PAN-BOLD. To be in another group, <a href="group-request.html">ask for it too</a>: the PIs and admins decide that separately.</p>';
      return;
    }
    box.innerHTML = (changes ? '<div class="jn-notice"><p>' + esc(changes.byName || changes.inviterName) + ' asks you to change your request before they decide:</p><p class="lt-text">“' + esc(changes.note) + '”</p></div>' : '') +
      (invited ? '<p class="jn-notice">' + esc(invited.inviter.name) + ' invited you to their project “' + esc(invited.title) + '”. Ask to join BOLD here, and you’ll be on it once ' + esc(invited.inviter.name.split(' ')[0]) + ' approves.</p>' : '') +
      '<div class="event-form join-form">' + BoldJoin.fieldsHtml(v, opt, { withIdentity: true }) +
      // Hidden from people: a bot fills it in.
      '<label class="jn-trap" aria-hidden="true">Website<input type="text" class="jn-website" tabindex="-1" autocomplete="off"></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save">' + (changes ? 'Send the changes' : 'Ask to join') + '</button></div></div>';
    box.querySelector('.ev-save').addEventListener('click', send);
    wireInviter();
    if (invited && invited.inviter.id) { box.querySelector('.jn-inviter').value = invited.inviter.name; box.querySelector('.jn-inviter-id').value = invited.inviter.id; }
    // Changing it: who invited them stays who decides it.
    if (changes) {
      var inv = box.querySelector('.jn-inviter');
      inv.value = changes.inviterName; inv.disabled = true; inv.title = 'Who invited you decides your request: it stays ' + changes.inviterName + '.';
      box.querySelector('.jn-inviter-id').value = changes.inviterId || 'same';
    }
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
    if (invited) d.invite = invite;
    if (changes) {
      BOLD.confirmAction({ title: 'Send your changes?', go: 'Send', effects: ['Send ' + changes.inviterName + ' a Slack message that you’ve changed your request'] }).then(function(ok){ if (ok) sendRequest(d); });
      return;
    }
    BOLD.confirmAction({ title: 'Send your request?', go: 'Send', effects: ['Send your point of contact a Slack message, to approve or decline it'] }).then(function(ok){ if (ok) sendRequest(d); });
  }
  function sendRequest(d){
    var btn = box.querySelector('.ev-save');
    btn.disabled = true; showError('');
    (changes ? call('joinChanges', Object.assign({}, d, { action: 'save', id: changesId, key: changesKey })) : call('requestToJoin', d)).then(function(){
      sent = d.name.split(' ')[0] || d.name; render();
    }).catch(function(err){
      console.error('[BOLD Join] sending the request failed', err);
      showError(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t send it — try again.');
      btn.disabled = false;
    });
  }

  BoldJoin.options(db, function(o){
    opt = o;
    if (changesId) {
      return call('joinChanges', { action: 'peek', id: changesId, key: changesKey }).then(function(r){
        var v = r.data || {};
        changes = { note: v.note || '', byName: v.byName || '', inviterName: (v.inviter && v.inviter.name) || v.byName || 'your point of contact', inviterId: v.inviter && v.inviter.id };
        render(v);
      }).catch(function(err){
        console.error('[BOLD Join] opening your request failed', err);
        changesError = err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t open your request — try the link again.';
        render({});
      });
    }
    if (!invite) return render({});
    firebase.app().functions('europe-west2').httpsCallable('projectInvite')({ action: 'peek', invite: invite })
      .then(function(r){ invited = r.data && r.data.open ? r.data : null; }).catch(function(){ invited = null; }).then(function(){ render({}); });
  });
})();
