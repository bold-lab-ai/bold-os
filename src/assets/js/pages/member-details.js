// profile.html's "Your details": the signed-in member's record
// (members/{email}), made when a PI approved their request to join (join.html)
// or added here, and theirs to edit (firestore.rules). The record is the one source
// of these details: their Slack profile's fields (profile.js, BOLD.slackFields) only
// fill the form the first time (SLACK_SAME), and aren't shown.
(function(){
  var esc = BOLD.escapeHtml;
  var shownContact = '';   // the point of contact the form opened with
  var box = document.getElementById('memberDetails');
  if (!box || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var me = null, rec = undefined, opt = null, editing = false, unsub = null;
  // Their group (Who is BOLD) and a request for another (groupRequest in functions/index.js).
  var groupReq = null, asking = false, gBusy = false, gError = '', unsubReq = null;
  function when(t){ return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function groupHtml(){
    var g = BoldJoin.groupOf(rec);
    var html = BoldJoin.groupBadge(g) + ' <a class="acct-handle" href="boldiquette.html#who-is-bold">What’s this?</a>';
    if (groupReq) return html + '<span class="st-links">You asked for ' + BoldJoin.groupBadge(groupReq.to) + ' on ' + when(groupReq.at) + ': a PI or admin will decide. ' +
      '<button type="button" class="btn-text md-g-withdraw"' + (gBusy ? ' disabled' : '') + '>Withdraw</button></span>';
    if (!asking) return html + ' <button type="button" class="btn-text md-g-ask">Ask for another group</button>';
    return html + '<div class="md-g-form">' + BoldJoin.CATEGORIES.filter(function(c){ return c[0] !== g; }).map(function(c){
        return '<label class="jn-check"><input type="radio" name="md-g-to" value="' + c[0] + '"> ' + BoldJoin.groupBadge(c[0]) + '</label>';
      }).join('') +
      '<textarea class="md-g-note no-tags" rows="2" maxlength="1000" placeholder="Why (optional): who you work with, what you do in BOLD"></textarea>' +
      (gError ? '<p class="st-error">' + esc(gError) + '</p>' : '') +
      '<div class="event-form-actions"><button type="button" class="ev-save md-g-send"' + (gBusy ? ' disabled' : '') + '>Send to the PIs</button><button type="button" class="md-g-cancel">Cancel</button></div></div>';
  }
  function callGroup(data){ return firebase.app().functions('europe-west2').httpsCallable('groupRequest')(data); }

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

  // The people on BOLD.OS, to choose the point of contact from.
  var people = null;
  function loadPeople(){
    if (people) return;
    db.collection('people').get().then(function(s){
      people = s.docs.map(function(d){ var x = d.data(); return { name: x.name || x.email, email: String(x.email || '').toLowerCase() }; })
        .filter(function(p){ return p.email && p.email !== me.email; }).sort(function(a, b){ return a.name.localeCompare(b.name); });
      render();
    }).catch(function(err){ console.error('[BOLD Profile] loading the people failed', err); people = []; render(); });
  }

  function render(){
    if (!me || rec === undefined || !opt) return;
    if (editing && !people) { box.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) {
      box.innerHTML = '<div class="event-form join-form">' + BoldJoin.fieldsHtml(rec || fromSlack(), opt, { people: people }) +
        '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save md-save">Save</button><button type="button" class="md-cancel">Cancel</button></div></div>';
      var pick = box.querySelector('.jn-contact-pick');
      shownContact = pick ? pick.value : '';
      return;
    }
    var who = { name: me.name, email: me.email };
    box.innerHTML = rec ? BoldJoin.factsHtml(rec, Object.assign({ group: groupHtml() }, who)) + '<div class="event-controls"><button type="button" class="btn-text md-edit">Edit your details</button></div>' :
      BoldJoin.factsHtml({}, who) + '<p class="proj-msg">Add your role, institution, research interests and dates, so the lab knows who you are.</p>' +
      '<div class="event-controls"><button type="button" class="btn-text md-edit">Add your details</button></div>';
  }

  box.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('md-edit')) { editing = true; loadPeople(); render(); return; }
    if (t.classList.contains('md-g-ask')) { asking = true; gError = ''; render(); return; }
    if (t.classList.contains('md-g-cancel')) { asking = false; render(); return; }
    if (t.classList.contains('md-g-send') || t.classList.contains('md-g-withdraw')) {
      var send = t.classList.contains('md-g-send'), to = (box.querySelector('input[name="md-g-to"]:checked') || {}).value;
      if (send && !to) { gError = 'Choose a group.'; render(); return; }
      var note = send ? box.querySelector('.md-g-note').value : '';
      var go = function(){
        gBusy = true; gError = ''; render();
        callGroup(send ? { action: 'request', to: to, note: note } : { action: 'withdraw', id: groupReq.id }).then(function(){ asking = false; })
          .catch(function(err){ console.error('[BOLD Profile] the group request failed', err); gError = (err && err.message) || 'Couldn’t send it — try again.'; })
          .then(function(){ gBusy = false; render(); });
      };
      if (!send) { go(); return; }
      BOLD.confirmAction({ title: 'Ask to move to ' + BoldJoin.categoryLabel(to) + '?', go: 'Send', effects: ['Send the PIs and admins a Slack message asking to approve it'] })
        .then(function(ok){ if (ok) go(); });
      return;
    }
    if (t.classList.contains('md-cancel')) { editing = false; render(); return; }
    if (!t.classList.contains('md-save')) return;
    var d = BoldJoin.read(box), err = box.querySelector('.ev-error');
    var p = BoldJoin.problem(d);
    if (p) { err.textContent = p; err.hidden = false; return; }
    // Their point of contact is who invited them: that goes through setMyInviter (they can't
    // write it, and it asks them to confirm). A typed one from before leaves it as it is.
    // Only when they change it: saving other details never asks anyone.
    var was = String((rec && rec.invitedBy && rec.invitedBy.email) || '');
    var inviter = d.inviterEmail !== undefined && d.inviterEmail !== shownContact ? d.inviterEmail : undefined;
    delete d.inviterEmail;
    (inviter && inviter !== was ? BOLD.confirmAction({ title: 'Save your details?', go: 'Save', effects: ['Send your point of contact a Slack message asking them to confirm they invited you'] }) : Promise.resolve(true))
      .then(function(ok){ if (ok) saveDetails(t, d, inviter, was, err); });
  });
  function saveDetails(t, d, inviter, was, err){
    t.disabled = true;
    db.collection('members').doc(me.email).set(Object.assign(d, { name: (rec && rec.name) || me.name || me.email, email: me.email, updatedAt: Date.now() }), { merge: true })
      .then(function(){
        if (inviter === undefined || inviter === was) return;
        return firebase.app().functions('europe-west2').httpsCallable('setMyInviter')({ email: inviter });
      })
      .then(function(){ editing = false; render(); })
      .catch(function(e2){
        console.error('[BOLD Profile] saving your details failed', e2);
        err.textContent = 'Couldn’t save — try again.'; err.hidden = false; t.disabled = false;
      });
  }

  BoldJoin.options(db, function(o){ opt = o; render(); });
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    me = user && user.email ? { email: user.email.toLowerCase(), name: user.displayName || '' } : null;
    rec = undefined; editing = false; groupReq = null; asking = false;
    if (unsubReq) { unsubReq(); unsubReq = null; }
    if (!me) return;
    unsubReq = db.collection('groupRequests').where('email', '==', me.email).where('status', '==', 'open').onSnapshot(function(s){
      groupReq = s.empty ? null : Object.assign({ id: s.docs[0].id }, s.docs[0].data()); render();
    }, function(e){ console.error('[BOLD Profile] loading your group request failed', e); });
    unsub = db.collection('members').doc(me.email).onSnapshot(function(s){
      rec = s.exists ? s.data() : null;
      render();
    }, function(e){ console.error('[BOLD Profile] loading your details failed', e); rec = null; render(); });
  });
})();
