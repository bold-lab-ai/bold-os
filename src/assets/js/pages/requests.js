// requests.html (the account menu's Requests): the requests you have to answer and those you
// made that wait on someone else, of every kind on BOLD.OS, from myRequests (functions/index.js;
// as BOLD OS's board sees them). Each links to where it's answered.
(function(){
  var body = document.getElementById('requestsBody');
  if (!body || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var KINDS = { join: 'Joining BOLD', group: 'Changing group', letter: 'Recommendation letter', introduction: 'Introduction', supervision: 'Supervision meetings',
    agent: 'Agent acting', invite: 'Invitation', review: 'Internal Review', event: 'Event', hackathon: 'Hackathon', venue: 'Venue', proposal: 'Proposed change' };
  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function names(ps){ return (ps || []).map(function(p){ return p.name; }).filter(Boolean).join(', '); }
  function itemHtml(x, toAnswer){
    var whom = toAnswer ? (x.by && x.by.name ? 'from ' + x.by.name : '') : 'waiting on ' + (names(x.on) || x.waiting || 'someone');
    var meta = [KINDS[x.kind] || 'Request', whom, (x.column === 'doing' ? 'under way since ' : 'since ') + when(x.since)].filter(Boolean).join(' · ');
    return '<li><a class="proj-title" href="' + esc(x.url) + '">' + (x.num ? '#' + x.num + ' ' : '') + esc(x.title) + '</a>' +
      '<span class="proj-meta">' + esc(meta) + '</span></li>';
  }
  function group(title, items, toAnswer, none){
    return '<div class="proj-group"><h3>' + title + '<span class="proj-count">' + (items.length || '') + '</span></h3>' +
      (items.length ? '<ul class="proj-list">' + items.map(function(x){ return itemHtml(x, toAnswer); }).join('') + '</ul>' : '<p class="proj-msg">' + none + '</p>') + '</div>';
  }
  var asked = 0;
  BOLD.onUser(function(user){
    var mine = ++asked;
    if (!user) return;
    body.innerHTML = '<p class="proj-msg">Loading&hellip;</p>';
    firebase.app().functions('europe-west2').httpsCallable('myRequests')().then(function(r){
      if (mine !== asked) return;
      var d = r.data || {}, forYou = d.forYou || [], byYou = d.byYou || [];
      body.innerHTML = group('To answer', forYou, true, 'Nothing waiting on you.') + group('Yours', byYou, false, 'Nothing you asked is waiting.');
    }).catch(function(err){
      if (mine !== asked) return;
      console.error('[BOLD Requests] loading your requests failed', err);
      body.innerHTML = '<p class="proj-msg">Couldn’t load your requests — try reloading the page.</p>';
    });
  });
})();
