// join.html: anyone, signed in or not, asks to join BOLD (requestToJoin, which
// checks it again). The PIs and admins decide on join-requests.html.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('joinBody');
  if (!box) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var opt = null, sent = false;

  function render(v){
    if (sent) {
      box.innerHTML = '<p class="jn-notice">Thanks, ' + esc(sent) + '. Your request is with the BOLD PIs; you’ll hear by email.</p>';
      return;
    }
    box.innerHTML = '<div class="event-form join-form">' + BoldJoin.fieldsHtml(v, opt, { withIdentity: true }) +
      // Hidden from people: a bot fills it in.
      '<label class="jn-trap" aria-hidden="true">Website<input type="text" class="jn-website" tabindex="-1" autocomplete="off"></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save">Ask to join</button></div></div>';
    box.querySelector('.ev-save').addEventListener('click', send);
  }

  function showError(msg){ var e = box.querySelector('.ev-error'); e.textContent = msg; e.hidden = !msg; }

  function send(){
    var form = box.querySelector('.join-form'), d = BoldJoin.read(form);
    d.website = form.querySelector('.jn-website').value;
    var p = BoldJoin.problem(d);
    if (p) { showError(p); return; }
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
