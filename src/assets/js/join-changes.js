// Changes proposed to a request to join (#261): what differs between a request's answers and
// the answers as its inviter edited them, and each change as a line ("Role at BOLD: Visitor →
// Postdoc"). As functions/index.js has them (joinChangesProposed, joinChangesLines; kept in sync
// by hand), for join-requests.html (proposing) and join.html (the applicant reading them).
window.BoldJoinChanges = (function(){
  var FIELDS = ['name', 'email', 'links', 'institution', 'role', 'interests', 'basedIn', 'pronouns', 'feedback', 'startDate', 'endDate', 'listOnWebsite', 'pillars'];
  var NAMES = { name: 'Full name', email: 'Email address', links: 'Links', institution: 'Home institution', role: 'Role at BOLD', interests: 'Research interests',
    basedIn: 'Based in', pronouns: 'Pronouns', feedback: 'How you like to receive feedback', startDate: 'Start date', endDate: 'End date', listOnWebsite: 'Listed on the BOLD website', pillars: 'Research pillars' };
  function same(a, b){ return JSON.stringify(a === undefined ? '' : a) === JSON.stringify(b === undefined ? '' : b); }
  // The answers in `next` that differ from request q's. → { field: value }
  function proposed(q, next){
    var out = {};
    next = next || {};
    FIELDS.forEach(function(k){
      if (next[k] === undefined) return;
      var v = typeof next[k] === 'string' ? next[k].trim() : next[k];
      if (k === 'email') v = String(v).toLowerCase();
      var was = k === 'pillars' ? (q[k] || []) : k === 'listOnWebsite' ? q[k] === true : q[k];
      if (!same(was, v)) out[k] = v;
    });
    return out;
  }
  function show(k, v){ return k === 'listOnWebsite' ? (v ? 'yes' : 'no') : Array.isArray(v) ? (v.length ? v.join('; ') : '—') : String(v == null || v === '' ? '—' : v); }
  // Each change, as "Role at BOLD: Visitor → Postdoc".
  function lines(q, p){
    return Object.keys(p || {}).filter(function(k){ return NAMES[k]; }).map(function(k){ return NAMES[k] + ': ' + show(k, q[k]) + ' → ' + show(k, p[k]); });
  }
  return { FIELDS: FIELDS, NAMES: NAMES, proposed: proposed, lines: lines };
})();
