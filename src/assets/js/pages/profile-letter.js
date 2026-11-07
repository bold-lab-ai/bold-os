// profile.html#agents: who writes their home page's letter (prefs/{uid}.homeLetter): BOLD LLM (Claude
// until Sofya runs: functions/bold-llm.js) or the rule-based letter the page writes itself (the default).
// BOLD LLM is greyed out, with why, while the lab's letters are rule-based (settings/homeLetter, Settings ›
// Home letter, PIs and admins).
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('letterSetting');
  if (!box || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var uid = null, choice = null, lab = null, error = '', busy = false;
  var OFF = 'The lab’s letters are rule-based for now: PIs and admins turn BOLD LLM on in Settings › Home letter.';
  var OPTIONS = [
    ['bold', 'BOLD LLM', 'Written for you each morning from what you can see, and you can talk to it under the letter. Claude writes it until Sofya, BOLD’s own LLM, is ready; what it reads of your day is sent to Anthropic.'],
    ['rules', 'Rule-based', 'BOLD.OS puts it together as you open the page, from what’s waiting on you, your meetings and the lab.'],
  ];

  function render(){
    if (choice === null || lab === null) { box.innerHTML = ''; return; }
    var on = lab === 'claude';
    box.innerHTML = '<section class="hl-setting"><h3>Your home letter</h3><p class="hero-note">The letter that opens your <a href="index.html">home page</a>: who writes it.</p>' +
      '<fieldset class="hl-choices" aria-label="Who writes your home letter"' + (busy ? ' disabled' : '') + '>' + OPTIONS.map(function(o){
        var off = o[0] === 'bold' && !on;
        return '<label class="jn-check' + (off ? ' is-off' : '') + '"' + (off ? ' title="' + esc(OFF) + '"' : '') + '><input type="radio" name="hl-choice" value="' + o[0] + '"' +
          (choice === o[0] ? ' checked' : '') + (off ? ' disabled' : '') + '> <span><strong>' + esc(o[1]) + '</strong>: ' + esc(o[2]) + (off ? ' <em>' + esc(OFF) + '</em>' : '') + '</span></label>';
      }).join('') + '</fieldset>' +
      (choice === 'bold' && !on ? '<p class="proj-meta">You chose BOLD LLM: you’ll get its letters once the lab turns it on. Until then, the rule-based one.</p>' : '') +
      (error ? '<p class="st-error">' + esc(error) + '</p>' : '') + '</section>';
  }

  box.addEventListener('change', function(e){
    if (e.target.name !== 'hl-choice' || !uid) return;
    var was = choice;
    choice = e.target.value; busy = true; error = ''; render();
    db.collection('prefs').doc(uid).set({ homeLetter: choice, at: Date.now() }, { merge: true })
      .catch(function(err){ console.error('[BOLD Letter] saving the choice failed', err); choice = was; error = 'Couldn’t save it — try again.'; })
      .then(function(){ busy = false; render(); });
  });

  BOLD.onUser(function(user){
    uid = user ? user.uid : null;
    choice = null; lab = null; render();
    if (!user) return;
    db.collection('prefs').doc(uid).get().then(function(d){ choice = (d.exists && d.data().homeLetter) || 'rules'; })
      .catch(function(){ choice = 'rules'; }).then(render);
    db.collection('settings').doc('homeLetter').get().then(function(d){ lab = (d.exists && d.data().writer) || 'rules'; })
      .catch(function(){ lab = 'rules'; }).then(render);
  });
})();
