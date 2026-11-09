// Onboarding (Get started, 2026-11-02), one module for every page that shows it: the steps
// for the viewer's group and which are done, from the `onboarding` callable (functions/index.js
// onboardingSteps), each ticked from what BOLD.OS knows. Get started, the home page, the
// profile, Ask for another group (it must be done first) and People (PIs and admins) use it.
// BoldOnboarding.load(cb): cb({ group, steps: [{ key, label, done, href }], done }), once per page
// (again with load(cb, true)); .mark('tour') → the same, after marking the tour taken;
// .listHtml(status, back) the steps as a list; .count(status) "2 of 4". back: what the checklist
// is ("your request for BOLD-internal"): its links then leave a way back (BOLD.checklistBack, bold.js).
window.BoldOnboarding = (function(){
  var esc = BOLD.escapeHtml, cache = null, waiting = [];
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('onboarding')(data || {}); }
  function load(cb, fresh){
    if (cache && !fresh) { cb(cache); return; }
    waiting.push(cb);
    if (waiting.length > 1 && !fresh) return;
    call({}).then(function(r){ cache = r.data && Array.isArray(r.data.steps) ? r.data : null; }).catch(function(err){ console.error('[BOLD Onboarding] loading failed', err); cache = null; })
      .then(function(){ var w = waiting; waiting = []; w.forEach(function(f){ f(cache); }); });
  }
  function mark(step){ return call({ action: 'mark', step: step }).then(function(r){ cache = r.data && Array.isArray(r.data.steps) ? r.data : cache; return cache; }); }
  function count(s){ return s && s.steps ? s.steps.filter(function(x){ return x.done; }).length + ' of ' + s.steps.length : ''; }
  var TICK = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  var RING = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  function listHtml(s, back){
    if (!s || !s.steps) return '';
    var mark = back ? ' data-checklist="' + esc(back) + '"' : '';
    return '<ol class="ob-steps">' + s.steps.map(function(x){
      return '<li class="' + (x.done ? 'is-done' : '') + '"><span class="ob-mark">' + (x.done ? TICK : RING) + '</span>' +
        (x.done ? '<span>' + esc(x.label) + '</span><span class="ob-state">Done</span>' : '<a href="' + esc(x.href) + '"' + mark + '>' + esc(x.label) + '</a>') + '</li>';
    }).join('') + '</ol>';
  }
  return { load: load, mark: mark, count: count, listHtml: listHtml, call: call };
})();
