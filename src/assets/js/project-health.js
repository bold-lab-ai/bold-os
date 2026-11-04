// A project's health (2026-11-04): its practical setup, each of a weekly meeting, slides, meeting notes
// and a GitHub repository scored 2 when BOLD.OS made it (a Meet on its Calendar invitation, slides and
// notes in the lab's Drive, a repository in bold-lab-ai: everyone on it gets them, and the lab can see
// them), 1 when it's the project's own link, 0 when missing; out of 8. The same as projectHealth in
// functions/index.js (tests/project-setup.test.cjs checks they agree).
// BoldHealth.of(ws) → { score, max, items: [{ key, label, how: 'os' | 'own' | 'none' }] }
// BoldHealth.html(h) → the bar, with what each part is in its tooltip.
(function(root){
  var LABELS = { meeting: 'Meeting', slides: 'Slides', notes: 'Meeting notes', repo: 'Repository' };
  var HOW = { os: 'made by BOLD.OS', own: 'its own link', none: 'missing' };
  function of(ws){
    ws = ws || {};
    var m = ws.meeting;
    var items = [
      ['meeting', !m ? 'none' : m.link ? 'own' : 'os'],
      ['slides', ws.ownDeckUrl ? 'own' : ws.deckId || ws.deckUrl ? 'os' : 'none'],
      ['notes', ws.ownNotesUrl ? 'own' : ws.notesId || ws.notesUrl ? 'os' : 'none'],
      ['repo', ws.repoName ? 'os' : ws.ownRepoUrl ? 'own' : 'none']
    ].map(function(x){ return { key: x[0], label: LABELS[x[0]], how: x[1] }; });
    var score = items.reduce(function(n, i){ return n + (i.how === 'os' ? 2 : i.how === 'own' ? 1 : 0); }, 0);
    return { score: score, max: 8, items: items };
  }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function html(h){
    if (!h) return '';
    var tip = 'Health ' + h.score + ' of ' + h.max + ': ' + h.items.map(function(i){ return (LABELS[i.key] || i.key) + ', ' + HOW[i.how]; }).join('; ') +
      '. Made by BOLD.OS counts twice its own link.';
    return '<span class="health" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
      '<span class="health-bar">' + h.items.map(function(i){ return '<span class="health-seg is-' + i.how + '"></span>'; }).join('') + '</span>' +
      '<span class="health-n">' + h.score + '/' + h.max + '</span></span>';
  }
  root.BoldHealth = { of: of, html: html };
})(this);
