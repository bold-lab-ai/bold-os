// People (people.html): BOLD's members (members/{email}, each edited on its owner's
// profile), grouped by role (PIs, adjuncts, postdocs and students first, then the
// join form's other roles, BoldJoin.ROLES; Alumni last), and searchable by name, institution or interest.
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('people'), search = document.getElementById('ppSearch');
  if (!root || !BOLD.getAuth() || !window.BoldJoin) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var members = null, unsub = null, staff = false, me = null, picking = '', slackIds = {};

  function links(t){
    return String(t || '').split(/[\s,;]+/).filter(Boolean).map(function(u){
      var href = /^https?:\/\//.test(u) ? u : 'https://' + u;
      return /^https?:\/\/[^\s<>"]+$/.test(href) ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>' : '';
    }).filter(Boolean).join(' · ');
  }

  function personHtml(m){
    var meta = [m.institution, m.basedIn, m.contact ? 'with ' + m.contact : ''].filter(Boolean).map(esc).join(' · ');
    var l = links(m.links);
    var cat = BoldJoin.groupOf(m);
    var badge = function(c, attrs){ return '<span class="type-badge pp-' + c + '"' + (attrs || '') + '>' + esc(BoldJoin.categoryLabel(c)) + '</span>'; };
    // PIs and admins: the badge opens the four, and choosing one sets it.
    var tag = !staff ? badge(cat)
      : picking === m.email ? '<span class="pp-choices">' + BoldJoin.CATEGORIES.map(function(c){
          return '<button type="button" class="type-badge pp-' + c[0] + ' pp-choose' + (c[0] === cat ? ' is-current' : '') + '" data-email="' + esc(m.email) + '" data-cat="' + c[0] + '">' + esc(c[1]) + '</button>';
        }).join('') + '</span>'
      : '<button type="button" class="type-badge pp-' + cat + ' pp-open" data-email="' + esc(m.email) + '" title="Change ' + esc(m.name || m.email) + '’s group">' + esc(BoldJoin.categoryLabel(cat)) + '</button>';
    var sid = slackIds[String(m.email || '').toLowerCase()];
    var name = sid ? '<a class="proj-title" href="person.html?id=' + encodeURIComponent(sid) + '">' + esc(m.name || m.email) + '</a>' : '<span class="proj-title">' + esc(m.name || m.email) + '</span>';
    return '<li><div>' + name + (m.pronouns ? ' <span class="acct-handle">' + esc(m.pronouns) + '</span>' : '') + ' ' + tag +
      (meta ? '<span class="proj-meta">' + meta + '</span>' : '') +
      (m.interests ? '<span class="proj-meta">' + esc(m.interests) + '</span>' : '') +
      (l ? '<span class="proj-meta">' + l + '</span>' : '') + '</div></li>';
  }

  function render(){
    if (!members) return;
    var q = search.value.trim().toLowerCase();
    var shown = members.filter(function(m){
      return !q || [m.name, m.institution, m.interests, m.basedIn, m.role, BoldJoin.categoryLabel(BoldJoin.groupOf(m))].join(' ').toLowerCase().indexOf(q) !== -1;
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
  root.addEventListener('click', function(e){
    var open = e.target.closest('.pp-open'), pick = e.target.closest('.pp-choose');
    if (open) { picking = open.getAttribute('data-email'); render(); return; }
    if (!pick) return;
    var email = pick.getAttribute('data-email'), cat = pick.getAttribute('data-cat');
    picking = '';
    var m = members.filter(function(x){ return x.email === email; })[0];
    if (m && BoldJoin.groupOf(m) === cat) { render(); return; }
    if (m) m.category = cat;
    render();
    db.collection('members').doc(email).update({ category: cat, categoryBy: me, categoryAt: Date.now() })
      .catch(function(err){ console.error('[BOLD People] setting the group failed', err); });
  });

  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    members = null;
    if (!user) return;
    me = user.email; staff = false;
    // Each person's page is person.html?id=<their Slack id> (the people roster).
    db.collection('people').get().then(function(ps){
      ps.docs.forEach(function(d){ var e = String(d.data().email || '').toLowerCase(); if (e) slackIds[e] = d.id; });
      render();
    }).catch(function(){});
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){ staff = !!(r.data && r.data.fullWrite); render(); }).catch(function(){});
    unsub = db.collection('members').onSnapshot(function(s){
      members = s.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return String(a.name || a.email).localeCompare(String(b.name || b.email)); });
      render();
    }, function(err){ console.error('[BOLD People] loading failed', err); root.innerHTML = '<p class="proj-msg">Couldn’t load the people. Try reloading the page.</p>'; });
  });
})();
