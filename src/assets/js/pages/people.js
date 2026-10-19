// People (people.html): BOLD's members (members/{email}, each edited on its owner's
// profile), grouped by role (PIs, adjuncts, postdocs and students first, then the
// join form's other roles, BoldJoin.ROLES; Alumni last), and searchable by name, institution or interest.
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('people'), search = document.getElementById('ppSearch');
  if (!root || !BOLD.getAuth() || !window.BoldJoin) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var members = null, unsub = null;

  function links(t){
    return String(t || '').split(/[\s,;]+/).filter(Boolean).map(function(u){
      var href = /^https?:\/\//.test(u) ? u : 'https://' + u;
      return /^https?:\/\/[^\s<>"]+$/.test(href) ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>' : '';
    }).filter(Boolean).join(' · ');
  }

  function personHtml(m){
    var meta = [m.institution, m.basedIn, m.contact ? 'with ' + m.contact : ''].filter(Boolean).map(esc).join(' · ');
    var l = links(m.links);
    return '<li><div><span class="proj-title">' + esc(m.name || m.email) + '</span>' + (m.pronouns ? ' <span class="acct-handle">' + esc(m.pronouns) + '</span>' : '') +
      (meta ? '<span class="proj-meta">' + meta + '</span>' : '') +
      (m.interests ? '<span class="proj-meta">' + esc(m.interests) + '</span>' : '') +
      (l ? '<span class="proj-meta">' + l + '</span>' : '') + '</div></li>';
  }

  function render(){
    if (!members) return;
    var q = search.value.trim().toLowerCase();
    var shown = members.filter(function(m){
      return !q || [m.name, m.institution, m.interests, m.basedIn, m.role].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    if (!members.length) { root.innerHTML = '<p class="proj-msg">Nobody has added their details yet.</p>'; return; }
    if (!shown.length) { root.innerHTML = '<p class="proj-msg">Nobody matches.</p>'; return; }
    var first = ['PI', 'Adjunct', 'Postdoc', 'PhD student', 'Master student'];
    var order = first.concat(BoldJoin.ROLES.filter(function(r){ return first.indexOf(r) === -1 && r !== 'Other' && r !== 'Alumni'; }), ['Other', 'Alumni']);
    var roleOf = function(m){ return order.indexOf(m.role) === -1 ? 'Other' : m.role; };
    root.innerHTML = order.map(function(r){
      var group = shown.filter(function(m){ return roleOf(m) === r; });
      if (!group.length) return '';
      var label = r === 'PI' ? 'PIs' : r === 'Staff' || r === 'Other' || r === 'Alumni' ? r : r + 's';
      return '<div class="proj-group"><h3>' + esc(label) + '<span class="proj-count">' + group.length + '</span></h3><ul class="proj-list">' + group.map(personHtml).join('') + '</ul></div>';
    }).join('');
  }

  search.addEventListener('input', render);
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    members = null;
    if (!user) return;
    unsub = db.collection('members').onSnapshot(function(s){
      members = s.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return String(a.name || a.email).localeCompare(String(b.name || b.email)); });
      render();
    }, function(err){ console.error('[BOLD People] loading failed', err); root.innerHTML = '<p class="proj-msg">Couldn’t load the people. Try reloading the page.</p>'; });
  });
})();
