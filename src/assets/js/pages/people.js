// People (people.html): BOLD's members (members/{email}, each edited on its owner's
// profile), grouped by role (PIs, adjuncts, postdocs and students first, then the
// join form's other roles, BoldJoin.ROLES; Alumni last), and searchable by name, institution or interest.
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('people'), search = document.getElementById('ppSearch');
  if (!root || !BOLD.getAuth() || !window.BoldJoin) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var members = null, unsub = null, staff = false, me = null;

  function links(t){
    return String(t || '').split(/[\s,;]+/).filter(Boolean).map(function(u){
      var href = /^https?:\/\//.test(u) ? u : 'https://' + u;
      return /^https?:\/\/[^\s<>"]+$/.test(href) ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>' : '';
    }).filter(Boolean).join(' · ');
  }

  function personHtml(m){
    var meta = [m.institution, m.basedIn, m.contact ? 'with ' + m.contact : ''].filter(Boolean).map(esc).join(' · ');
    var l = links(m.links);
    var cat = m.category || 'pan';
    var badge = staff
      ? '<select class="pp-cat" data-email="' + esc(m.email) + '" aria-label="Group of ' + esc(m.name || m.email) + '">' + BoldJoin.CATEGORIES.map(function(c){
          return '<option value="' + c[0] + '"' + (c[0] === cat ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>'
      : '<span class="badge pp-badge pp-' + cat + '">' + esc(BoldJoin.categoryLabel(cat)) + '</span>';
    return '<li><div><span class="proj-title">' + esc(m.name || m.email) + '</span>' + (m.pronouns ? ' <span class="acct-handle">' + esc(m.pronouns) + '</span>' : '') + ' ' + badge +
      (meta ? '<span class="proj-meta">' + meta + '</span>' : '') +
      (m.interests ? '<span class="proj-meta">' + esc(m.interests) + '</span>' : '') +
      (l ? '<span class="proj-meta">' + l + '</span>' : '') + '</div></li>';
  }

  function render(){
    if (!members) return;
    var q = search.value.trim().toLowerCase();
    var shown = members.filter(function(m){
      return !q || [m.name, m.institution, m.interests, m.basedIn, m.role, BoldJoin.categoryLabel(m.category)].join(' ').toLowerCase().indexOf(q) !== -1;
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
  root.addEventListener('change', function(e){
    var sel = e.target.closest('.pp-cat');
    if (!sel) return;
    sel.disabled = true;
    db.collection('members').doc(sel.getAttribute('data-email')).update({ category: sel.value, categoryBy: me, categoryAt: Date.now() })
      .catch(function(err){ console.error('[BOLD People] setting the group failed', err); render(); });
  });
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    members = null;
    if (!user) return;
    me = user.email; staff = false;
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){ staff = !!(r.data && r.data.fullWrite); render(); }).catch(function(){});
    unsub = db.collection('members').onSnapshot(function(s){
      members = s.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return String(a.name || a.email).localeCompare(String(b.name || b.email)); });
      render();
    }, function(err){ console.error('[BOLD People] loading failed', err); root.innerHTML = '<p class="proj-msg">Couldn’t load the people. Try reloading the page.</p>'; });
  });
})();
