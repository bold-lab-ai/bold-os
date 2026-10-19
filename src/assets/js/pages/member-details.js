// profile.html's "Your details": the signed-in member's record
// (members/{email}), made when a PI approved their request to join (join.html)
// or added here, and theirs to edit (firestore.rules). The record is the one source
// of these details: their Slack profile's fields (profile.js, BOLD.slackFields) only
// fill the form the first time (SLACK_SAME), and aren't shown.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('memberDetails');
  if (!box || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var me = null, rec = undefined, opt = null, editing = false, unsub = null;
  // A Slack field (by its label) and the record's field that says the same.
  var SLACK_SAME = [[/institution|affiliation|university|organi[sz]ation/i, 'institution'], [/role|position|title/i, 'role'],
    [/supervisor|advisor|adviser|contact/i, 'contact'], [/interest/i, 'interests'], [/start/i, 'startDate'], [/end/i, 'endDate'],
    [/based|location|city/i, 'basedIn'], [/website|link|scholar/i, 'links'], [/pronoun/i, 'pronouns']];
  function sameAs(label){ var m = SLACK_SAME.filter(function(x){ return x[0].test(label); })[0]; return m ? m[1] : ''; }
  // A new record's form, filled from Slack where it can be.
  function fromSlack(){
    var out = {};
    (BOLD.slackFields || []).forEach(function(f){
      var k = sameAs(f.label);
      if (k && ['institution', 'contact', 'interests', 'basedIn', 'links', 'pronouns'].indexOf(k) !== -1 && !out[k]) out[k] = f.value;
    });
    return out;
  }

  function render(){
    if (!me || rec === undefined || !opt) return;
    if (editing) {
      box.innerHTML = '<div class="event-form join-form">' + BoldJoin.fieldsHtml(rec || fromSlack(), opt) +
        '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save md-save">Save</button><button type="button" class="md-cancel">Cancel</button></div></div>';
      return;
    }
    var who = { name: me.name, email: me.email };
    box.innerHTML = rec ? BoldJoin.factsHtml(rec, who) + '<div class="event-controls"><button type="button" class="btn-text md-edit">Edit your details</button></div>' :
      BoldJoin.factsHtml({}, who) + '<p class="proj-msg">Add your role, institution, research interests and dates, so the lab knows who you are.</p>' +
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
