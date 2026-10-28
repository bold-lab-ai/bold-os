// Skills page — every skill is a skills/{name} doc (see skills-common.js),
// listed by title. "+ Add a skill" is always shown, greyed out for anyone but a
// PI/admin; it opens the skill editor for a new skill (skill.html?new). Proposed
// new skills (skills/{name}/proposals, kind 'new', e.g. from an agent) are on the
// Proposed tab (#proposed), each linking to its page, which shows the proposal until it's decided.
(function(){
  var esc = BOLD.escapeHtml;
  var S = window.BoldSkills;
  var list = document.getElementById('skillList');
  var addBtn = document.getElementById('skillAdd');
  var loading = document.getElementById('skillLoading');
  if (!list || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }

  var skills = [], fullWrite = false;

  function cardHtml(x, when, hash, cta){
    return '<a class="event-card" href="skill.html?skill=' + encodeURIComponent(x.name) + (hash || '') + '">' +
      '<h3>' + esc(x.title || x.name) + '</h3>' +
      '<p class="event-when">' + esc(when || x.name) + '</p>' +
      '<p>' + esc(x.description || '') + '</p>' +
      '<span class="event-cta">' + (cta || 'See the skill') + ' &rarr;</span></a>';
  }

  function render(){
    list.innerHTML = skills.map(function(x){ return '<li>' + cardHtml(x) + '</li>'; }).join('');
    addBtn.disabled = !fullWrite;
    addBtn.title = fullWrite ? '' : S.NOT_PI;
  }

  addBtn.addEventListener('click', function(){ if (fullWrite) location.href = 'skill.html?new'; });

  // Two tabs, named by the #hash: the skills, and the new ones proposed.
  function showTab(){
    var want = location.hash === '#proposed' ? 'proposed' : 'skills';
    ['skills', 'proposed'].forEach(function(t){ document.getElementById(t).hidden = t !== want; });
    Array.prototype.forEach.call(document.querySelectorAll('#skillTabs .guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);
  showTab();

  var unsubscribe = null, signIns = 0;
  BOLD.onUser(function(user){
    var mine = ++signIns;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    fullWrite = false;
    skills = [];
    render();
    if (!user) return;
    S.access(function(ok){ if (mine === signIns) { fullWrite = ok; render(); } });
    unsubscribe = db.collection('skills').onSnapshot(function(snap){
      loading.hidden = true;
      skills = snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.name; })
        .sort(function(a, b){ return (a.title || a.name).localeCompare(b.title || b.name); });
      render();
    }, function(err){ console.error('[BOLD Skills] loading skills failed', err); });
    // Proposed new skills. Unfiltered (a filter across collections needs its own index): there are few.
    db.collectionGroup('proposals').get().then(function(snap){
      if (mine !== signIns) return;
      var fresh = snap.docs.filter(function(d){ var q = d.data(); return d.ref.parent.parent && d.ref.parent.parent.parent.id === 'skills' && q.kind === 'new' && q.status === 'open'; });
      document.getElementById('newCount').textContent = fresh.length ? ' (' + fresh.length + ')' : '';
      document.getElementById('newNone').hidden = !!fresh.length;
      document.getElementById('newList').innerHTML = fresh.map(function(d){
        var q = d.data(), name = d.ref.parent.parent.id;
        return '<li>' + cardHtml({ name: name, title: (q.after && q.after.title) || name, description: (q.after && q.after.description) || '' },
          name + ' · proposed by ' + ((q.by && q.by.name) || 'someone'), '#proposals', 'See the proposal') + '</li>';
      }).join('');
    }).catch(function(err){ console.error('[BOLD Skills] loading proposals failed', err); });
  });
})();
