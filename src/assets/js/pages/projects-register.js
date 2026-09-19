(function(){
  // The masthead, gate and sidebar are bold.js's; this page is just the form.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var form = el('projectForm'), errorBox = el('projectError'), submitBtn = el('submitBtn');
  var me;
  BOLD.onUser(function(user){ me = user; });

  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  // The board's own abstract field (counter, LaTeX preview) — see card-model.js.
  el('abstractField').innerHTML = abstractTextFieldHtml('', '');
  wireAbstractPreview();

  function showError(msg){ errorBox.textContent = msg; errorBox.hidden = false; }

  /* ---------- keywords and the Slack channel: project-fields.js ---------- */
  el('keywordEntry').innerHTML = keywordEntryHtml();
  el('channelEntry').innerHTML = channelEntryHtml('');
  var keywordField = wireKeywordField([], showError, function(){ errorBox.hidden = true; });
  var channelField = wireChannelField('submit');
  var channelInput = el('pfChannel');

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!me || !me.email || !db) return showError('Could not connect — reload, or check back shortly.');
    var title = el('pfTitle').value.trim();
    var abstractText = el('stageAbstractText').value.trim();
    if (!title) return showError('Give the project a title.');
    if (!abstractText) return showError('Add an abstract or pitch.');
    var channel = normalizeProjectChannel(channelInput.value);
    if (channel.error) return showError(channel.error);
    keywordField.addTyped();
    errorBox.hidden = true;
    submitBtn.disabled = true;

    var ensure = channelField.ensure(channel.name);
    ensure.then(function(r){
      // A project is a card (card-model.js) \u2014 the same one "+ Register paper" makes.
      // It's kept in `projects` until a venue is set (Projects page).
      var card = makeRegisteredCard({ name: me.displayName, email: me.email }, {
        title: title, abstractText: abstractText, keywords: keywordField.get(), slackChannel: '#' + r.name
      });
      var id = card.id; delete card.id; // the id is the document's, as in the board's saveBoard()
      var ref = db.collection('projects').doc(id);
      return ref.set(card);
    }).then(function(){
      // Drop the projects page's cached list so the new project shows at once.
      try { localStorage.removeItem('boldProjects:getAllProjects:' + me.email.toLowerCase()); } catch (err){}
      location.href = 'projects.html#planned';
    }).catch(function(err){
      console.error('[BOLD Lab] register project failed', err);
      submitBtn.disabled = false;
      channelField.refresh();
      var code = err && err.code;
      showError(code === 'permission-denied'
        ? 'You don\u2019t have permission to do that \u2014 check with a PI or lab admin.'
        : (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') && err.message
          ? err.message
          : 'Could not register the project \u2014 try again.');
    });
  });
})();
