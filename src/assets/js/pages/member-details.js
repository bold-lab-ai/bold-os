// profile.html's "Your BOLD details": the signed-in member's record
// (members/{email}), made when a PI approved their request to join (join.html)
// or added here, and theirs to edit (firestore.rules).
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('memberDetails');
  if (!box || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var me = null, rec = undefined, opt = null, editing = false, unsub = null;

  function render(){
    if (!me || rec === undefined || !opt) return;
    if (editing) {
      box.innerHTML = '<div class="event-form join-form">' + BoldJoin.fieldsHtml(rec || {}, opt) +
        '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save md-save">Save</button><button type="button" class="md-cancel">Cancel</button></div></div>';
      return;
    }
    box.innerHTML = rec ? BoldJoin.factsHtml(rec) + '<div class="event-controls"><button type="button" class="btn-text md-edit">Edit your details</button></div>' :
      '<p class="proj-msg">Add your role, institution, research interests and dates, so the lab knows who you are.</p>' +
      '<div class="event-controls"><button type="button" class="btn-text md-edit">Add your details</button></div>';
  }

  box.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('md-edit')) { editing = true; render(); return; }
    if (t.classList.contains('md-cancel')) { editing = false; render(); return; }
    if (!t.classList.contains('md-save')) return;
    var d = BoldJoin.read(box), err = box.querySelector('.ev-error');
    var p = BoldJoin.problem(d);
    if (p) { err.textContent = p; err.hidden = false; return; }
    t.disabled = true;
    db.collection('members').doc(me.email).set(Object.assign(d, { name: (rec && rec.name) || me.name || me.email, email: me.email, updatedAt: Date.now() }), { merge: true })
      .then(function(){ editing = false; render(); })
      .catch(function(e2){
        console.error('[BOLD Profile] saving your details failed', e2);
        err.textContent = 'Couldn’t save — try again.'; err.hidden = false; t.disabled = false;
      });
  });

  BoldJoin.options(db, function(o){ opt = o; render(); });
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    me = user && user.email ? { email: user.email.toLowerCase(), name: user.displayName || '' } : null;
    rec = undefined; editing = false;
    if (!me) return;
    unsub = db.collection('members').doc(me.email).onSnapshot(function(s){
      rec = s.exists ? s.data() : null;
      render();
    }, function(e){ console.error('[BOLD Profile] loading your details failed', e); rec = null; render(); });
  });
})();
