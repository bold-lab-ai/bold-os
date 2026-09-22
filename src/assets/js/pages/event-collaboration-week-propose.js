(function(){
  var els = {
    signedOut: document.getElementById('proposeSignedOut'),
    signedIn: document.getElementById('proposeSignedIn'),
    signInBtn: document.getElementById('signInBtn'),
    signOutBtn: document.getElementById('signOutBtn'),
    whoAmI: document.getElementById('whoAmI'),
    form: document.getElementById('proposalForm'),
    submitBtn: document.getElementById('submitProposalBtn'),
    error: document.getElementById('proposalError'),
    success: document.getElementById('proposalSuccess'),
    proposeAnotherBtn: document.getElementById('proposeAnotherBtn'),
    keepEditingBtn: document.getElementById('keepEditingBtn'),
    editLink: document.getElementById('editLink'),
    successMsg: document.getElementById('successMsg'),
    heroTitle: document.getElementById('heroTitle'),
    heroNote: document.getElementById('heroNote'),
    workshopFields: document.getElementById('workshopFields'),
    talkFields: document.getElementById('talkFields')
  };

  // FIRESTORE_USE_EMULATOR must be false in anything committed — see
  // audit-board.html's own comment on this flag for why (a real production
  // incident the first time it shipped true). Project/config/auth: bold.js.
  var FIRESTORE_USE_EMULATOR = false;

  var db = null, auth = BOLD.getAuth();
  try {
    db = firebase.firestore(BOLD.getApp());
    if (FIRESTORE_USE_EMULATOR) db.useEmulator('localhost', 8080);
  } catch (e){ db = null; }

  if (!db || !auth){
    els.signedOut.innerHTML = '<p>Could not connect &mdash; reload, or check back shortly.</p>';
    return;
  }

  var currentUser = null;

  // ?edit=<proposalId> turns this page into an editor for that proposal
  // (only its proposer gets past loadForEdit — Firestore enforces the same).
  var editId = null;
  try { editId = new URLSearchParams(location.search).get('edit'); } catch (e){}
  var editLoaded = false;

  var FIELD_IDS = [
    'pfType', 'pfTitle',
    'pfTimeLocation', 'pfChair', 'pfOverallDesc', 'pfProblems', 'pfBackground', 'pfKeyQuestions', 'pfAim', 'pfAgenda',
    'pfDuration', 'pfAbstract'
  ];

  function isWorkshopType(type){ return type === 'Workshop'; }

  function updateFieldVisibility(){
    var workshop = isWorkshopType(document.getElementById('pfType').value);
    els.workshopFields.hidden = !workshop;
    els.talkFields.hidden = workshop;
  }

  function setForm(p){
    p = p || {};
    var vals = {
      pfType: p.contributionType, pfTitle: p.title,
      pfTimeLocation: p.timeLocation, pfChair: p.chair, pfOverallDesc: p.overallDescription,
      pfProblems: p.problems, pfBackground: p.background, pfKeyQuestions: p.keyQuestions,
      pfAim: p.aim, pfAgenda: p.agenda,
      pfDuration: p.duration, pfAbstract: p.abstract
    };
    FIELD_IDS.forEach(function(id){
      var el = document.getElementById(id);
      el.value = vals[id] || '';
      if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.selectedIndex = 0;
    });
    updateFieldVisibility();
  }

  function resetForm(){
    els.success.hidden = true;
    els.form.hidden = false;
    setForm(null);
  }

  function enterEditMode(){
    els.heroTitle.textContent = 'Edit your proposal';
    els.heroNote.innerHTML = 'Changes show on the <a href="event-collaboration-week.html#proposals">Proposals tab</a> straight away.';
    els.submitBtn.textContent = 'Save changes';
    els.proposeAnotherBtn.hidden = true;
    els.editLink.hidden = true;
    els.keepEditingBtn.hidden = false;
  }

  function loadForEdit(){
    editLoaded = true;
    enterEditMode();
    els.form.hidden = true;
    db.collection('collabWeekProposals').doc(editId).get().then(function(doc){
      if (!doc.exists || doc.data().email !== currentUser.email){
        els.error.textContent = 'That proposal isn\u2019t yours to edit, or it no longer exists.';
        els.error.hidden = false;
        els.form.hidden = false;
        els.submitBtn.hidden = true;
        return;
      }
      setForm(doc.data());
      els.form.hidden = false;
    }).catch(function(err){
      console.error('[Propose a Workshop] load for edit failed', err);
      els.error.textContent = 'Could not load your proposal \u2014 reload, or check back shortly.';
      els.error.hidden = false;
      els.form.hidden = false;
      els.submitBtn.hidden = true;
    });
  }

  function submitProposal(){
    if (!currentUser) return;
    var type = document.getElementById('pfType').value;
    var fields = {
      contributionType: type,
      title: document.getElementById('pfTitle').value.trim()
    };
    if (isWorkshopType(type)){
      fields.timeLocation = document.getElementById('pfTimeLocation').value.trim();
      fields.chair = document.getElementById('pfChair').value.trim();
      fields.overallDescription = document.getElementById('pfOverallDesc').value.trim();
      fields.problems = document.getElementById('pfProblems').value.trim();
      fields.background = document.getElementById('pfBackground').value.trim();
      fields.keyQuestions = document.getElementById('pfKeyQuestions').value.trim();
      fields.aim = document.getElementById('pfAim').value.trim();
      fields.agenda = document.getElementById('pfAgenda').value.trim();
    } else {
      fields.duration = document.getElementById('pfDuration').value.trim();
      fields.abstract = document.getElementById('pfAbstract').value.trim();
    }

    if (!type){
      els.error.textContent = 'Pick a contribution type first.';
      els.error.hidden = false;
      return;
    }
    els.error.hidden = true;
    els.submitBtn.disabled = true;

    var col = db.collection('collabWeekProposals');
    var write;
    if (editId){
      fields.updatedAt = Date.now();
      write = col.doc(editId).update(fields);
    } else {
      fields.name = currentUser.name || currentUser.email;
      fields.email = currentUser.email;
      fields.createdAt = Date.now();
      write = col.add(fields);
    }
    write.then(function(ref){
      if (editId){
        els.successMsg.textContent = 'Saved.';
      } else {
        els.successMsg.textContent = 'Thanks \u2014 your proposal is in.';
        els.editLink.href = '?edit=' + encodeURIComponent(ref.id);
      }
      els.form.hidden = true;
      els.success.hidden = false;
    }).catch(function(err){
      console.error('[Propose a Workshop] submit failed', err);
      els.error.textContent = editId
        ? 'Could not save your changes \u2014 try again.'
        : 'Could not save your proposal \u2014 try again.';
      els.error.hidden = false;
    }).finally(function(){
      els.submitBtn.disabled = false;
    });
  }

  function renderAuth(){
    if (currentUser){
      els.signedOut.hidden = true;
      els.signedIn.hidden = false;
      els.whoAmI.textContent = currentUser.name
        ? currentUser.name + (currentUser.email ? ' (' + currentUser.email + ')' : '')
        : (currentUser.email || 'Signed in');
    } else {
      els.signedOut.hidden = false;
      document.documentElement.classList.remove('auth-hint');
      els.signedIn.hidden = true;
    }
  }

  document.getElementById('pfType').addEventListener('change', updateFieldVisibility);
  updateFieldVisibility();
  els.signInBtn.addEventListener('click', BOLD.signIn);
  els.signOutBtn.addEventListener('click', BOLD.signOut);
  els.submitBtn.addEventListener('click', submitProposal);
  els.proposeAnotherBtn.addEventListener('click', resetForm);
  els.keepEditingBtn.addEventListener('click', function(){ els.success.hidden = true; els.form.hidden = false; });

  // Signed in last visit: skip the "sign in" panel while Firebase Auth
  // resolves. BOLD.onUser below stays authoritative and swaps it
  // back if the session has expired.
  try {
    if (localStorage.getItem('boldAuthHint')){
      els.signedOut.hidden = true;
      els.signedIn.hidden = false;
      if (editId){ enterEditMode(); els.form.hidden = true; }
    }
  } catch (e){}
  BOLD.onUser(function(user){
    currentUser = user ? { email: user.email, name: user.displayName } : null;
    renderAuth();
    if (currentUser && editId && !editLoaded) loadForEdit();
  });
})();
