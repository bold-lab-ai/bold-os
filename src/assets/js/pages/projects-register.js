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

  /* ---------- Slack channel: say what will happen ---------- */
  var channelInput = el('pfChannel'), statusBox = el('channelStatus');
  var callChannel = null;
  try {
    var httpsCallable = firebase.app().functions('europe-west2').httpsCallable('projectChannel');
    callChannel = function(name, mode){ return httpsCallable({ name: name, mode: mode }).then(function(r){ return r.data; }); };
  } catch (e){}

  function statusLine(cls, text){
    var li = document.createElement('li');
    li.className = cls; li.textContent = text;
    return li;
  }
  function renderStatus(lines){
    statusBox.innerHTML = '';
    lines.forEach(function(l){ statusBox.appendChild(statusLine(l[0], l[1])); });
  }

  // What the typed name becomes, and what happens to it in Slack.
  var checkSeq = 0, checkTimer = null;
  function updateChannelStatus(){
    clearTimeout(checkTimer);
    var seq = ++checkSeq;
    if (!channelInput.value.trim()) return renderStatus([]);
    var n = normalizeProjectChannel(channelInput.value);
    if (n.error) return renderStatus([['warn', n.error]]);
    var name = '#' + n.name;
    var lines = [n.prefixed
      ? ['', 'Will be saved as ' + name + ' \u2014 project channels start with proj-.']
      : ['ok', 'Starts with proj- \u2014 no change.']];
    renderStatus(lines.concat([['pending', 'Checking Slack\u2026']]));
    checkTimer = setTimeout(function(){
      if (!callChannel) return renderStatus(lines);
      callChannel(n.name, 'check').then(function(r){
        if (seq !== checkSeq) return;
        renderStatus(lines.concat([r.exists
          ? ['ok', name + ' already exists \u2014 nothing to do.']
          : ['new', name + ' doesn\u2019t exist yet \u2014 it will be created and you\u2019ll be invited when you submit.']]));
      }).catch(function(err){
        if (seq !== checkSeq) return;
        console.error('[BOLD Lab] channel check failed', err);
        renderStatus(lines.concat([['warn', 'Couldn\u2019t check Slack \u2014 the channel is set up when you submit.']]));
      });
    }, 500);
  }
  channelInput.addEventListener('input', updateChannelStatus);
  // Leaving the field shows the name as it will be stored.
  channelInput.addEventListener('blur', function(){
    var n = normalizeProjectChannel(channelInput.value);
    if (!n.error && channelInput.value.trim() && channelInput.value.trim() !== '#' + n.name){
      channelInput.value = '#' + n.name;
      updateChannelStatus();
    }
  });

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!me || !me.email || !db) return showError('Could not connect — reload, or check back shortly.');
    var title = el('pfTitle').value.trim();
    var abstractText = el('stageAbstractText').value.trim();
    if (!title) return showError('Give the project a title.');
    if (!abstractText) return showError('Add an abstract or pitch.');
    var channel = normalizeProjectChannel(channelInput.value);
    if (channel.error) return showError(channel.error);
    errorBox.hidden = true;
    submitBtn.disabled = true;

    // Set up the Slack channel first (creates and invites if it doesn't exist),
    // so a project is never registered against a channel that couldn't be made.
    var ensure = callChannel
      ? callChannel(channel.name, 'ensure')
      : Promise.reject(new Error('functions unavailable'));
    renderStatus([['pending', 'Setting up #' + channel.name + '\u2026']]);
    ensure.then(function(r){
      // A project is a card (card-model.js) \u2014 the same one "+ Register paper" makes.
      // It's kept in `projects` until a venue is set (Projects page).
      var card = makeRegisteredCard({ name: me.displayName, email: me.email }, {
        title: title, abstractText: abstractText, slackChannel: '#' + r.name
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
      updateChannelStatus();
      var code = err && err.code;
      showError(code === 'permission-denied'
        ? 'You don\u2019t have permission to do that \u2014 check with a PI or lab admin.'
        : (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') && err.message
          ? err.message
          : 'Could not register the project \u2014 try again.');
    });
  });
})();
