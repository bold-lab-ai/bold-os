// A member's page (person.html?id=<their Slack id>, linked from People): their details,
// as on their own profile (members/{email}, BoldJoin.factsHtml, with their group), their
// studies if they have any (studies/{email}) and their planned and ongoing projects
// (projectWorkspaces they're a member of). Read-only: each person edits their own on
// profile.html. The Slack id (the `people` roster) keeps email addresses out of links.
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('person');
  if (!root || !BOLD.getAuth() || !window.BoldJoin) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var id = new URLSearchParams(location.search).get('id') || '';

  function projectUrl(w){ return 'project.html#id=' + encodeURIComponent(w.cardId) + (w.boardId ? '&board=' + encodeURIComponent(w.boardId) : ''); }

  function studiesHtml(s){
    var row = function(k, v){ return v ? '<div class="fact"><dt>' + k + '</dt><dd>' + v + '</dd></div>' : ''; };
    return '<div class="md-group"><h3>Studies</h3><dl class="facts">' +
      row('Degree', esc(s.degree || '')) + row('Working title', esc(s.title || '')) +
      row('People involved', (s.people || []).map(function(p){ return esc(p.name); }).join(', ')) +
      row('Meeting', s.meeting ? esc(meetingText(s.meeting)) : '') + '</dl></div>';
  }

  function projectsHtml(list){
    if (!list.length) return '';
    return '<div class="md-group"><h3>Projects</h3><ul class="proj-list">' + list.map(function(w){
      return '<li><a class="proj-title" href="' + projectUrl(w) + '">' + esc(w.title || 'Untitled') + '</a>' +
        '<span class="proj-meta">' + (w.group === 'ongoing' ? 'Ongoing' : 'Planned') + '</span></li>';
    }).join('') + '</ul></div>';
  }

  BOLD.onUser(function(user){
    if (!user) return;
    if (!id) { root.innerHTML = '<p class="proj-msg">No one chosen. <a href="people.html">See everyone</a>.</p>'; return; }
    db.collection('people').doc(id).get().then(function(p){
      if (!p.exists || !p.data().email) { root.innerHTML = '<p class="proj-msg">That person isn’t on BOLD.OS. <a href="people.html">See everyone</a>.</p>'; return; }
      var person = p.data(), email = String(person.email).toLowerCase();
      // Your own page is your profile.
      if (email === String(user.email || '').toLowerCase()) { location.replace('profile.html'); return; }
      document.getElementById('personName').textContent = person.name || email;
      document.title = (person.name || 'Person') + ' | BOLD Lab';
      return Promise.all([
        db.collection('members').doc(email).get(),
        db.collection('studies').doc(email).get(),
        db.collection('projectWorkspaces').where('members', 'array-contains', email).get(),
      ]).then(function(r){
        var m = r[0].exists ? r[0].data() : null, s = r[1].exists ? r[1].data() : null;
        var projects = r[2].docs.map(function(d){ return d.data(); }).filter(function(w){ return w.group !== 'completed'; })
          .sort(function(a, b){ return String(a.title).localeCompare(String(b.title)); });
        root.innerHTML = (m ? BoldJoin.factsHtml(m, { other: true, name: person.name || m.name, email: email, group: BoldJoin.groupBadge(BoldJoin.groupOf(m)) })
            : BoldJoin.factsHtml({}, { other: true, name: person.name, email: email }) + '<p class="proj-msg">They haven’t added their details yet.</p>') +
          (s ? studiesHtml(s) : '') + projectsHtml(projects);
      });
    }).catch(function(err){
      console.error('[BOLD Person] loading failed', err);
      root.innerHTML = '<p class="proj-msg">Couldn’t load this person. Try reloading the page.</p>';
    });
  });
})();
