// Skills page — every skill is a skills/{name} doc (see skills-common.js), laid out as Projects (2026-11-25):
// List or Grid (kept in this browser), "+ Add a skill" (greyed for anyone but a PI/admin; it opens the skill editor,
// skill.html?new), a search over title, name and description, and two tabs with their counts: the skills, and the
// new ones proposed (skills/{name}/proposals, kind 'new', e.g. from an agent), each linking to its page, which shows
// the proposal until it's decided. #proposed opens that tab. Each row: its title, a line of what it is, its description.
(function(){
  var esc = BOLD.escapeHtml;
  var S = window.BoldSkills;
  var list = document.getElementById('skillList'), newList = document.getElementById('newList');
  var addBtn = document.getElementById('skillAdd'), loading = document.getElementById('skillLoading');
  var search = document.getElementById('skillSearch'), views = document.getElementById('skillViews');
  if (!list || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }

  var skills = [], proposed = [], fullWrite = false, q = '';
  function day(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function files(n){ return n ? n + ' file' + (n > 1 ? 's' : '') : ''; }

  // A row, as a project's (proj-main: title, meta, abstract).
  function rowHtml(x, meta, hash){
    return '<li><div class="proj-main"><a class="proj-title" href="skill.html?skill=' + encodeURIComponent(x.name) + (hash || '') + '">' + esc(x.title || x.name) + '</a>' +
      '<span class="proj-meta">' + meta.filter(Boolean).map(esc).join(' · ') + '</span>' +
      (x.description ? '<p class="proj-abstract">' + esc(x.description) + '</p>' : '') + '</div></li>';
  }
  function matches(x){
    if (!q) return true;
    return [x.title, x.name, x.description].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  function render(){
    var a = skills.filter(matches), b = proposed.filter(matches);
    list.innerHTML = a.map(function(x){ return rowHtml(x, [x.name, files((x.files || []).length), x.updatedAt ? 'updated ' + day(x.updatedAt) : '']); }).join('') ||
      '<li class="proj-none"><p class="proj-empty">' + (q ? 'No skill matches.' : 'No skills yet.') + '</p></li>';
    newList.innerHTML = b.map(function(x){ return rowHtml(x, [x.name, 'proposed by ' + x.by, x.at ? day(x.at) : ''], '#proposals'); }).join('') ||
      '<li class="proj-none"><p class="proj-empty">' + (q ? 'No proposed skill matches.' : 'No new skills proposed.') + '</p></li>';
    document.getElementById('cntSkills').textContent = skills.length ? String(a.length) : '';
    document.getElementById('cntProposed').textContent = proposed.length ? String(b.length) : '';
    addBtn.disabled = !fullWrite;
    addBtn.title = fullWrite ? '' : S.NOT_PI;
  }
  addBtn.addEventListener('click', function(){ if (fullWrite) location.href = 'skill.html?new'; });
  search.addEventListener('input', function(){ q = search.value.trim().toLowerCase(); render(); });

  // List or Grid, kept in this browser.
  var VIEW_KEY = 'boldSkills:view';
  function setView(v){
    views.setAttribute('data-view', v);
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn[data-view]'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
    try { localStorage.setItem(VIEW_KEY, v); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn[data-view]'), function(b){ b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); }); });
  try { if (localStorage.getItem(VIEW_KEY) === 'grid') setView('grid'); } catch (e){}

  // Two tabs: the skills, and the new ones proposed (#proposed).
  function showTab(want){
    want = want || (location.hash === '#proposed' ? 'proposed' : 'skills');
    Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), function(t){
      var on = t.getAttribute('data-tab') === want;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
    });
    list.hidden = want !== 'skills'; newList.hidden = want !== 'proposed';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), function(t){
    t.addEventListener('click', function(){
      var want = t.getAttribute('data-tab');
      history.replaceState(null, '', want === 'proposed' ? '#proposed' : location.pathname + location.search);
      showTab(want);
    });
  });
  window.addEventListener('hashchange', function(){ showTab(); });
  showTab();

  var unsubscribe = null, signIns = 0;
  BOLD.onUser(function(user){
    var mine = ++signIns;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    fullWrite = false; skills = []; proposed = [];
    render();
    if (!user) return;
    S.access(function(ok){ if (mine === signIns) { fullWrite = ok; render(); } });
    unsubscribe = db.collection('skills').onSnapshot(function(snap){
      loading.hidden = true;
      skills = snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.name; })
        .sort(function(a, b){ return (a.title || a.name).localeCompare(b.title || b.name); });
      render();
    }, function(err){ console.error('[BOLD Skills] loading skills failed', err); loading.textContent = 'Couldn’t load the skills — reload to try again.'; });
    // Proposed new skills. Unfiltered (a filter across collections needs its own index): there are few.
    db.collectionGroup('proposals').get().then(function(snap){
      if (mine !== signIns) return;
      proposed = snap.docs.filter(function(d){ var x = d.data(); return d.ref.parent.parent && d.ref.parent.parent.parent.id === 'skills' && x.kind === 'new' && x.status === 'open'; })
        .map(function(d){
          var x = d.data(), name = d.ref.parent.parent.id;
          return { name: name, title: (x.after && x.after.title) || name, description: (x.after && x.after.description) || '', by: (x.by && x.by.name) || 'someone', at: x.at };
        });
      render();
    }).catch(function(err){ console.error('[BOLD Skills] loading proposals failed', err); });
  });
})();
