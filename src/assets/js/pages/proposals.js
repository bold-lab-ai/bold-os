// Every proposed change to BOLD.OS (proposals.html, the branch button in the masthead; #324, 2026-11-11), as GitHub's
// pull requests: the branches of the site (branches/{id}, functions/branches.js), Open or Closed (accepted, declined,
// withdrawn), newest change first, filtered by the kind of page they change and "Yours" (opened or committed to). Each
// links to its page (proposal.html); an open one can be switched to (bold.js BOLD.setBranch: the site as it makes it),
// and the one you're on goes back to main.
(function(){
  var root = document.getElementById('proposals');
  if (!root || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml, db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var list = null, guides = {}, error = '', me = '', tab = 'open', kind = '', mine = false;
  var KINDS = [['', 'All pages'], ['handbook', 'BOLDiquette'], ['guides', 'How to'], ['skills', 'Agent skills'], ['agentTools', 'Agent tools']];
  var STATE = { open: 'Open', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn' };
  try { var saved = JSON.parse(sessionStorage.getItem('boldProposalsView') || 'null'); if (saved) { tab = saved.tab || tab; kind = saved.kind || ''; mine = !!saved.mine; } } catch (e){}
  if (/^#(open|closed)$/.test(location.hash)) tab = location.hash.slice(1);

  function pageName(p){
    var c = p.split('/')[0], s = p.slice(c.length + 1);
    return c === 'handbook' ? 'BOLDiquette' : c === 'guides' ? (guides[s] || s) : c === 'skills' ? 'Skill ' + s : 'Tool ' + s;
  }
  function ago(t){
    var m = Math.round((Date.now() - (t || 0)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : m < 1440 * 30 ? Math.round(m / 1440) + ' d ago'
      : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function isMine(b){ return (b.by && String(b.by.email || '').toLowerCase() === me) || (b.contributors || []).indexOf(me) >= 0; }
  function shown(){
    return (list || []).filter(function(b){
      return (tab === 'open' ? b.status === 'open' : b.status !== 'open') && (!kind || (b.pages || []).some(function(p){ return p.split('/')[0] === kind; })) && (!mine || isMine(b));
    });
  }
  function rowHtml(b){
    var on = BOLD.branchId() === b.id, n = (b.pages || []).length, people = (b.contributors || []).length;
    var when = b.status === 'open' ? 'changed ' + ago(b.editedAt || b.at) : esc(STATE[b.status] || b.status).toLowerCase() + ' ' + ago(b.decidedAt);
    return '<li class="prl-row' + (on ? ' is-on' : '') + '"><span class="prl-icon prl-' + esc(b.status) + '" aria-hidden="true"></span><div class="prl-main">' +
      '<a class="prl-title" href="' + esc(BOLD.branchPage(b.id)) + '">' + esc(b.title || 'A proposed change') + '</a>' +
      (b.status !== 'open' ? ' <span class="pr-state pr-' + esc(b.status) + '">' + esc(STATE[b.status] || b.status) + '</span>' : '') +
      (on ? ' <span class="pr-state pr-open">You’re on it</span>' : '') +
      '<p class="prl-meta">' + (b.num ? '#' + b.num + ' · ' : '') + 'by ' + esc((b.by && (b.by.name || b.by.email)) || 'someone') + ' · ' + when + ' · ' +
        esc((b.pages || []).map(pageName).join(', ')) + (people > 1 ? ' · ' + people + ' people' : '') + '</p></div>' +
      (b.status === 'open' ? '<div class="prl-act">' + (on ? '<button type="button" class="btn-text prl-main-btn">Back to main</button>'
        : '<button type="button" class="btn-text prl-switch" data-id="' + esc(b.id) + '" title="See the site as it would make it; what you change is added to it">Switch to it</button>') + '</div>' : '') + '</li>';
  }
  function render(){
    var hero = '<div class="hero"><span class="eyebrow">BOLD.OS</span><h1>Proposed changes</h1>' +
      '<p class="hero-note">Changes to the BOLDiquette, the guides, skills and tools.' +
      (BOLD.branch() ? ' You’re on <a href="' + esc(BOLD.branchPage(BOLD.branchId())) + '">' + esc((BOLD.branch().num ? '#' + BOLD.branch().num + ' ' : '') + (BOLD.branch().title || 'one')) + '</a>.' : ' You’re on main.') + '</p></div>';
    if (error) { root.innerHTML = hero + '<main><p class="ev-error">' + esc(error) + '</p></main>'; return; }
    if (!list) { root.innerHTML = hero + '<main><p class="pr-muted">Loading…</p></main>'; return; }
    var open = list.filter(function(b){ return b.status === 'open'; }).length, rows = shown();
    root.innerHTML = hero + '<main>' +
      '<div class="prl-bar"><nav class="pr-tabs prl-tabs" aria-label="Open or closed">' +
        '<a href="#open" class="pr-tab' + (tab === 'open' ? ' is-current' : '') + '" data-tab="open">Open <span class="pr-count">' + open + '</span></a>' +
        '<a href="#closed" class="pr-tab' + (tab === 'closed' ? ' is-current' : '') + '" data-tab="closed">Closed <span class="pr-count">' + (list.length - open) + '</span></a></nav>' +
        '<div class="prl-filters"><select class="prl-kind" aria-label="Which pages">' + KINDS.map(function(k){ return '<option value="' + k[0] + '"' + (k[0] === kind ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select>' +
        '<label class="prl-mine"><input type="checkbox" class="prl-mine-in"' + (mine ? ' checked' : '') + '> Yours</label></div></div>' +
      (rows.length ? '<ul class="prl-list">' + rows.map(rowHtml).join('') + '</ul>'
        : '<p class="pr-muted prl-empty">' + (tab === 'open' ? 'No open proposed changes' : 'None closed') + (kind || mine ? ' here.' : '.') +
          (tab === 'open' ? ' To propose one, change a page: the BOLDiquette, a guide, a skill or a tool.' : '') + '</p>') + '</main>';
  }
  function keep(){ try { sessionStorage.setItem('boldProposalsView', JSON.stringify({ tab: tab, kind: kind, mine: mine })); } catch (e){} }
  root.addEventListener('click', function(e){
    var a = e.target.closest('[data-tab]');
    if (a) { e.preventDefault(); tab = a.getAttribute('data-tab'); keep(); try { history.replaceState(null, '', '#' + tab); } catch (err){} render(); return; }
    var t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('prl-switch')) {
      var b = (list || []).filter(function(x){ return x.id === t.getAttribute('data-id'); })[0];
      if (b) BOLD.setBranch({ id: b.id, num: b.num || 0, title: b.title, by: (b.by && b.by.name) || '', targets: b.pages || [] }, { go: true });
      return;
    }
    if (t.classList.contains('prl-main-btn')) BOLD.setBranch(null);
  });
  root.addEventListener('change', function(e){
    if (e.target.classList.contains('prl-kind')) { kind = e.target.value; keep(); render(); }
    if (e.target.classList.contains('prl-mine-in')) { mine = e.target.checked; keep(); render(); }
  });
  var unsub = null;
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    me = user ? String(user.email || '').toLowerCase() : '';
    if (!user) { root.innerHTML = '<div class="hero"><h1>Proposed changes</h1><p class="hero-note">Sign in to see them.</p></div>'; return; }
    render();
    // The guides' titles, to name them.
    db.collection('guides').get().then(function(s){ s.docs.forEach(function(d){ guides[d.id] = d.data().title || d.id; }); render(); }, function(){});
    unsub = db.collection('branches').onSnapshot(function(s){
      list = s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return ((b.status === 'open' ? b.editedAt || b.at : b.decidedAt) || 0) - ((a.status === 'open' ? a.editedAt || a.at : a.decidedAt) || 0); });
      error = ''; render();
    }, function(err){
      console.error('[BOLD Proposals] loading them failed', err);
      error = err && err.code === 'permission-denied' ? 'You can’t see the proposed changes.' : 'Couldn’t load them — reload to try again.'; render();
    });
  });
})();
