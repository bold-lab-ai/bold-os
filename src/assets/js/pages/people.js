// People (people.html): BOLD's members (members/{email}, each edited on its owner's
// profile), in two tabs: By role (PIs, adjuncts, postdocs and students first, then the
// join form's other roles, BoldJoin.ROLES; Alumni last) and By group (#by-group: Who is BOLD's
// groups, BOLD-exec first, BoldJoin.CATEGORIES); searchable by name, institution or interest;
// as a list or a grid of cards (List | Grid, as on Projects; kept in this browser, boldPeopleView).
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('people'), search = document.getElementById('ppSearch');
  if (!root || !BOLD.getAuth() || !window.BoldJoin) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var members = null, unsub = null, staff = false, me = null, picking = '', slackIds = {};
  // PIs and admins: each person's onboarding (Get started), { email: { done, count } }.
  var onboarding = {};

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
    // PIs and admins: the badge opens the groups, and choosing one sets it.
    var tag = !staff ? badge(cat)
      : picking === m.email ? '<span class="pp-choices">' + BoldJoin.CATEGORIES.map(function(c){
          return '<button type="button" class="type-badge pp-' + c[0] + ' pp-choose' + (c[0] === cat ? ' is-current' : '') + '" data-email="' + esc(m.email) + '" data-cat="' + c[0] + '">' + esc(c[1]) + '</button>';
        }).join('') + '</span>'
      : '<button type="button" class="type-badge pp-' + cat + ' pp-open" data-email="' + esc(m.email) + '" title="Change ' + esc(m.name || m.email) + '’s group">' + esc(BoldJoin.categoryLabel(cat)) + '</button>';
    var sid = slackIds[String(m.email || '').toLowerCase()];
    var name = sid ? '<a class="proj-title" href="person.html?id=' + encodeURIComponent(sid) + '">' + esc(m.name || m.email) + '</a>' : '<span class="proj-title">' + esc(m.name || m.email) + '</span>';
    var photo = '<span class="member-photo" data-id="' + esc(sid || '') + '" data-name="' + esc(m.name || m.email) + '">' + esc(BOLD.photo.initials(m.name || m.email)) + '</span>';
    // pp-head: the name line; pp-meta, pp-interests, pp-links: the lines under it (the grid's cards show the first two).
    return '<li><div class="pp-person-row">' + photo + '<div><span class="pp-head">' + name + (m.pronouns ? ' <span class="acct-handle">' + esc(m.pronouns) + '</span>' : '') + ' ' + tag + (m.test ? ' <span class="badge">Your test account</span>' : '') + '</span>' +
      (meta ? '<span class="proj-meta pp-meta" title="' + esc([m.institution, m.basedIn, m.contact ? 'with ' + m.contact : ''].filter(Boolean).join(' · ')) + '">' + meta + '</span>' : '') +
      (m.interests ? '<span class="proj-meta pp-interests" title="' + esc(m.interests) + '">' + esc(m.interests) + '</span>' : '') +
      (l ? '<span class="proj-meta pp-links">' + l + '</span>' : '') +
      (staff && onboarding[String(m.email || '').toLowerCase()] ? '<span class="proj-meta pp-onboarding">' + onboarding[String(m.email || '').toLowerCase()] + '</span>' : '') + '</div></div></li>';
  }

  function loadOnboarding(){
    BoldOnboarding.call({ all: true }).then(function(r){
      onboarding = {};
      ((r.data && r.data.people) || []).forEach(function(p){
        var left = p.steps.filter(function(x){ return !x.done; }).map(function(x){ return x.label; });
        onboarding[p.email] = p.done ? 'Onboarding done' : 'Onboarding ' + BoldOnboarding.count(p) + ': still to ' + esc(left.map(function(l){ return l.charAt(0).toLowerCase() + l.slice(1); }).join('; '));
      });
      render();
    }).catch(function(err){ console.error('[BOLD People] loading onboarding failed', err); });
  }

  // A PI's or admin's test account (testAccount): only its owner sees it here, marked Test.
  function visible(m){ return !m.test || (me && String(m.testOf || '').toLowerCase() === String(me).toLowerCase()); }

  function render(){
    if (!members) return;
    var q = search.value.trim().toLowerCase();
    var shown = members.filter(visible).filter(function(m){
      return !q || [m.name, m.institution, m.interests, m.basedIn, m.role, BoldJoin.categoryLabel(BoldJoin.groupOf(m))].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    if (!members.length) { root.innerHTML = '<p class="proj-msg">Nobody has added their details yet.</p>'; return; }
    if (!shown.length) { root.innerHTML = '<p class="proj-msg">Nobody matches.</p>'; return; }
    var section = function(label, group){
      return group.length ? '<div class="proj-group"><h3>' + esc(label) + '<span class="proj-count">' + group.length + '</span></h3><ul class="proj-list">' + group.map(personHtml).join('') + '</ul></div>' : '';
    };
    if (view() === 'group') {
      root.innerHTML = BoldJoin.CATEGORIES.map(function(c){
        return section(c[1], shown.filter(function(m){ return BoldJoin.groupOf(m) === c[0]; }));
      }).join('');
      BOLD.photo.mountMany(root.querySelectorAll('.member-photo[data-id]'));
      return;
    }
    var first = ['PI', 'Adjunct', 'Postdoc', 'PhD student', 'Master student'];
    var order = first.concat(BoldJoin.ROLES.filter(function(r){ return first.indexOf(r) === -1 && r !== 'Other' && r !== 'Alumni'; }), ['Other', 'Alumni']);
    var roleOf = function(m){ return order.indexOf(m.role) === -1 ? 'Other' : m.role; };
    root.innerHTML = order.map(function(r){
      var label = r === 'PI' ? 'PIs' : r === 'Staff' || r === 'Other' || r === 'Alumni' ? r : r + 's';
      return section(label, shown.filter(function(m){ return roleOf(m) === r; }));
    }).join('');
    BOLD.photo.mountMany(root.querySelectorAll('.member-photo[data-id]'));
  }

  // The tab: By role (people.html, #by-role) or By group (#by-group).
  function view(){ return location.hash === '#by-group' ? 'group' : 'role'; }
  function drawTabs(){
    Array.prototype.forEach.call(document.querySelectorAll('#ppTabs .guide-tab'), function(a){
      var on = a.getAttribute('href') === (view() === 'group' ? '#by-group' : '#by-role');
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', function(){ drawTabs(); render(); });
  drawTabs();

  search.addEventListener('input', render);

  // List or Grid: only how the cards are laid out (people.css's #people[data-view="grid"]).
  var VIEW_KEY = 'boldPeopleView';
  function setLayout(v){
    if (v !== 'grid') v = 'list';
    root.setAttribute('data-view', v);
    Array.prototype.forEach.call(document.querySelectorAll('.pp-bar .view-btn'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
    try { localStorage.setItem(VIEW_KEY, v); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.pp-bar .view-btn'), function(b){
    b.addEventListener('click', function(){ setLayout(b.getAttribute('data-view')); });
  });
  var savedLayout = null;
  try { savedLayout = localStorage.getItem(VIEW_KEY); } catch (e){}
  setLayout(savedLayout);
  root.addEventListener('click', function(e){
    var open = e.target.closest('.pp-open'), pick = e.target.closest('.pp-choose');
    if (open) { picking = open.getAttribute('data-email'); render(); return; }
    if (!pick) return;
    var email = pick.getAttribute('data-email'), cat = pick.getAttribute('data-cat');
    picking = '';
    var m = members.filter(function(x){ return x.email === email; })[0];
    if (m && BoldJoin.groupOf(m) === cat) { render(); return; }
    // Crossing BOLD-internal changes their GitHub write access (functions/index.js, #214): ask first.
    var order = BoldJoin.CATEGORIES.map(function(c){ return c[0]; }), high = function(g){ return order.indexOf(g) <= order.indexOf('internal'); };
    var was = m ? BoldJoin.groupOf(m) : 'pan', name = (m && m.name) || email;
    var ask = high(was) === high(cat) ? Promise.resolve(true) : BOLD.confirmAction({ title: 'Move ' + name + ' to ' + BoldJoin.categoryLabel(cat) + '?', go: 'Move',
      effects: [high(cat) ? 'Give their linked GitHub account write access to every bold-lab-ai repository' : 'Take away their GitHub write access to every repository but their projects\u2019 (they still read them all)'] });
    ask.then(function(go){
      if (!go) { render(); return; }
      if (m) m.category = cat;
      render();
      db.collection('members').doc(email).update({ category: cat, categoryBy: me, categoryAt: Date.now() })
        .catch(function(err){ console.error('[BOLD People] setting the group failed', err); });
    });
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
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){ staff = !!(r.data && r.data.fullWrite); render(); if (staff) loadOnboarding(); }).catch(function(){});
    unsub = db.collection('members').onSnapshot(function(s){
      members = s.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return String(a.name || a.email).localeCompare(String(b.name || b.email)); });
      render();
    }, function(err){ console.error('[BOLD People] loading failed', err); root.innerHTML = '<p class="proj-msg">Couldn’t load the people. Try reloading the page.</p>'; });
  });
})();
