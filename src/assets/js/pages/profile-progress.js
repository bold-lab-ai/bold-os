// profile.html's completeness bar, under the name: how much of the profile is filled
// in, and links to what's left. Counts everything on it: name, email and photo (from
// Slack), their details and group (members/{email}), their studies if they're a PhD or
// Master student (studies/{email}: working title, who supervises them, the meeting and
// the Slack channel), and their linked GitHub and Google accounts (profile.js says when
// those change: bold:accounts). A link to something in Your details or Studies opens
// that tab's form; the photo is changed in Slack.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('pfProgress');
  if (!box || !BOLD.getAuth() || !window.BoldJoin) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var STUDY_ROLES = ['PhD student', 'Master student'];
  var me = null, member, studies, unsubs = [];

  function linked(id){
    var u = BOLD.getAuth().currentUser;
    return !!(u && (u.providerData || []).some(function(p){ return p && p.providerId === id; }));
  }

  // [label, done, tab] (no tab: done elsewhere, in Slack)
  function items(){
    var m = member || {}, s = studies || {}, has = function(k){ return !!String(m[k] || '').trim(); };
    var u = BOLD.getAuth().currentUser || {};
    var out = [
      ['Name', !!u.displayName, ''], ['Email', !!u.email, ''], ['Slack photo', !!u.photoURL, ''],
      ['Group', !!member, 'details'], ['Pronouns', has('pronouns'), 'details'],
      ['Role', has('role'), 'details'], ['Institution', has('institution'), 'details'], ['Point of contact', has('contact'), 'details'],
      ['Research interests', has('interests'), 'details'], ['Research pillars', !!(m.pillars || []).length, 'details'],
      ['Based in', has('basedIn'), 'details'], ['Links', has('links'), 'details'], ['Feedback preference', has('feedback'), 'details'],
      ['Start date', has('startDate'), 'details'],
    ];
    if (BoldJoin.NO_END.indexOf(m.role) === -1) out.push(['End date', has('endDate'), 'details']);
    if (STUDY_ROLES.indexOf(m.role) !== -1 || studies) {
      out.push(['Working title', !!String(s.title || '').trim(), 'studies'], ['Supervisors', !!(s.people || []).length, 'studies'],
        ['Supervision meeting', !!s.meeting, 'studies'], ['Supervision channel', !!s.channelUrl, 'studies']);
    }
    out.push(['Link GitHub', linked('github.com'), 'linked-accounts'], ['Link Google', linked('google.com'), 'linked-accounts']);
    return out;
  }

  function render(){
    if (!me || member === undefined || studies === undefined) return;
    var all = items(), left = all.filter(function(i){ return !i[1]; });
    var pct = Math.round(100 * (all.length - left.length) / all.length);
    box.hidden = false;
    box.innerHTML = '<div class="pf-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Profile complete">' +
        '<span style="width:' + pct + '%"></span></div>' +
      '<p class="pf-text">' + (left.length ? 'Profile ' + pct + '% complete. Still to add: ' + left.map(function(i){
          return i[2] ? '<a href="#' + i[2] + '" data-tab="' + i[2] + '">' + esc(i[0]) + '</a>' : esc(i[0]) + ' (in Slack)';
        }).join(', ') + '.' : 'Profile complete.') + '</p>';
  }

  // A missing detail or study item opens its tab's form.
  box.addEventListener('click', function(e){
    var a = e.target.closest('a[data-tab]');
    if (!a) return;
    var tab = a.getAttribute('data-tab'), edit = { details: '.md-edit', studies: '.st-edit' }[tab];
    if (!edit) return;
    setTimeout(function(){
      var b = document.querySelector('#' + tab + ' ' + edit);
      if (b) b.click();
      var panel = document.getElementById(tab);
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  });
  document.addEventListener('bold:accounts', render);

  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user && user.email ? { email: user.email.toLowerCase() } : null;
    member = undefined; studies = undefined;
    if (!me) { box.hidden = true; return; }
    unsubs.push(db.collection('members').doc(me.email).onSnapshot(function(s){ member = s.exists ? s.data() : null; render(); },
      function(){ member = null; render(); }));
    unsubs.push(db.collection('studies').doc(me.email).onSnapshot(function(s){ studies = s.exists ? s.data() : null; render(); },
      function(){ studies = null; render(); }));
  });
})();
