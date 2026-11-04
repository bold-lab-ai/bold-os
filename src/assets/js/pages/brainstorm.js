// Brainstorm (experiment-brainstorm.html, a code experiment: src/_data/experiments.js; 2026-11-04):
// each person talks to their own assistant, which reads what the others in the brainstorm have
// said when it bears on their work (Paralax, PR #23). Preview: the conversation box only, with no
// backend yet; messages stay in the page, nothing is sent or saved.
(function(){
  var log = document.getElementById('bsLog'), form = document.getElementById('bsForm'), text = document.getElementById('bsText');
  if (!log || !form) return;
  var esc = BOLD.escapeHtml, name = 'You';
  BOLD.onUser(function(u){ name = (u && u.displayName) || 'You'; });

  function add(who, body, mine){
    var li = document.createElement('li');
    li.className = 'bs-msg' + (mine ? ' is-mine' : '');
    li.innerHTML = '<span class="bs-who">' + esc(who) + '</span><div class="bs-body">' + esc(body) + '</div>';
    log.appendChild(li);
    li.scrollIntoView({ block: 'nearest' });
  }
  add('Your assistant', 'Hi. Tell me what you’re working on. When something the others have said bears on it, I’ll bring it in and say who it came from.');

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var t = text.value.trim();
    if (!t) return;
    add(name, t, true);
    text.value = '';
    setTimeout(function(){ add('Your assistant', 'Not connected yet: once Brainstorm is, I answer here.'); }, 400);
  });
  // Enter sends; Shift+Enter is a new line.
  text.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
})();
