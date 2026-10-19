// A member's details, as join.html asks for them, profile.html edits them
// (members/{email}) and join-requests.html shows them. The choices of role and
// research pillar are settings/joinForm (edited on join-requests.html); these
// are the defaults, as functions/index.js has them (JOIN_ROLES, JOIN_PILLARS).
window.BoldJoin = (function(){
  var esc = BOLD.escapeHtml;
  var ROLES = ['PhD student', 'Master student', 'Postdoc', 'Visitor', 'Collaborator', 'Adjunct', 'PI', 'Alumni', 'Staff', 'Other'];
  var PILLARS = [
    'Core Algorithmic Innovation Questioning the Foundations of the Field',
    'Human-Centric Learning and Discovery (incl. Human-AI Coordination, MARL, Co-Scientist)',
    'Robust Adaptation and Learning incl. in Embodied Envs (RL, Open-Ended Learning, Robotics)',
  ];
  // These roles have no end date.
  var NO_END = ['PI', 'Adjunct', 'Alumni', 'Collaborator'];
  // How someone likes to receive feedback (functions/index.js JOIN_FEEDBACK, firestore.rules).
  var FEEDBACK = [
    ['direct', 'Direct', 'Be blunt: tell me plainly what’s wrong.'],
    ['balanced', 'Balanced', 'Be frank, with context and what works.'],
    ['gentle', 'Gentle', 'Start with what works, and go easy on the rest.'],
  ];

  // The choices on offer → cb({ roles, pillars }).
  function options(db, cb){
    var done = function(d){ d = d || {}; cb({ roles: d.roles && d.roles.length ? d.roles : ROLES, pillars: d.pillars && d.pillars.length ? d.pillars : PILLARS }); };
    db.collection('settings').doc('joinForm').get().then(function(s){ done(s.exists ? s.data() : null); })
      .catch(function(err){ console.error('[BOLD Join] reading the form’s choices failed', err); done(null); });
  }

  // The point of contact: a choice from the people on BOLD.OS (the `people` roster, o.people,
  // [{ name, email }]) when the page can read it, else typed (join.html: applicants aren't
  // signed in). A typed one from before stays on offer until another is chosen.
  function contactHtml(v, people){
    var label = 'BOLD supervisor, mentor or point of contact';
    if (!people) return '<label>' + label + '<input type="text" class="jn-contact" maxlength="200" value="' + esc(v.contact || '') + '" placeholder="Who connects you to BOLD?"></label>';
    var cur = String(v.contactEmail || '').toLowerCase();
    if (!cur && v.contact) {
      var named = people.filter(function(p){ return p.name.toLowerCase() === String(v.contact).trim().toLowerCase(); })[0];
      if (named) cur = named.email;
    }
    var known = people.some(function(p){ return p.email === cur; });
    return '<label>' + label + '<select class="jn-contact-pick"><option value="">Choose a person…</option>' +
      (!known && v.contact ? '<option value="__typed__" selected>' + esc(v.contact) + '</option>' : '') +
      people.map(function(p){ return '<option value="' + esc(p.email) + '"' + (p.email === cur ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') +
      '</select></label>';
  }

  // The fields, filled from v. opts: { withIdentity: name and email too, people: the roster for the point of contact }.
  function fieldsHtml(v, opt, o){
    v = v || {}; o = o || {};
    var t = function(cls, label, val, ph, max, type){
      return '<label>' + label + '<input type="' + (type || 'text') + '" class="' + cls + '" maxlength="' + max + '" value="' + esc(val || '') + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
    };
    var pillars = v.pillars || [];
    var group = function(title, body){ return '<fieldset class="md-group"><legend>' + title + '</legend>' + body + '</fieldset>'; };
    return group('About you', (o.withIdentity ? t('jn-name', 'Full name', v.name, '', 120) +
        t('jn-email', 'Email address (for Slack; Gmail preferred, for Google Calendar)', v.email, 'you@gmail.com', 200, 'email') : '') +
      t('jn-pronouns', 'Pronouns (optional)', v.pronouns, 'e.g. she/her, they/them', 40) +
      t('jn-institution', 'Home institution', v.institution, 'e.g. UCL, Oxford, Imperial', 120) +
      t('jn-based', 'Primarily based in (for events and socials)', v.basedIn, 'e.g. London', 120) +
      t('jn-links', 'Links (website, X, Google Scholar)', v.links, 'https://…', 500)) +
    group('At BOLD',
      '<label>Role at BOLD<select class="jn-role"><option value="">Choose…</option>' + opt.roles.map(function(r){
        return '<option' + (r === v.role ? ' selected' : '') + '>' + esc(r) + '</option>';
      }).join('') + (v.role && opt.roles.indexOf(v.role) === -1 ? '<option selected>' + esc(v.role) + '</option>' : '') + '</select></label>' +
      contactHtml(v, o.people) +
      '<div class="jn-dates">' + t('jn-start', 'Start date', v.startDate, '', 10, 'date') +
        t('jn-end', 'End date (not needed for PIs, adjuncts, alumni and collaborators)', v.endDate, '', 10, 'date') + '</div>' +
      '<label class="jn-check"><input type="checkbox" class="jn-list"' + (v.listOnWebsite ? ' checked' : '') + '> List me on the BOLD website</label>') +
    group('Research',
      t('jn-interests', 'Main research interests (up to 5 keywords)', v.interests, 'e.g. reinforcement learning, world models', 300) +
      '<fieldset class="jn-pillars"><legend>Closest BOLD research pillars</legend>' + opt.pillars.map(function(p){
        return '<label class="jn-check"><input type="checkbox" value="' + esc(p) + '"' + (pillars.indexOf(p) !== -1 ? ' checked' : '') + '> ' + esc(p) + '</label>';
      }).join('') + '</fieldset>') +
    group('Working with you',
      '<fieldset class="jn-feedback"><legend>How you like to receive feedback</legend>' + FEEDBACK.map(function(f){
        return '<label class="jn-check"><input type="radio" name="jn-feedback" value="' + f[0] + '"' + (v.feedback === f[0] ? ' checked' : '') + '> <span><strong>' + f[1] + '</strong>: ' + esc(f[2]) + '</span></label>';
      }).join('') + '</fieldset>');
  }

  // What the fields in el say.
  function read(el){
    var v = function(c){ var f = el.querySelector(c); return f ? f.value.trim() : ''; };
    var out = {
      links: v('.jn-links'), institution: v('.jn-institution'), role: v('.jn-role'), contact: v('.jn-contact'),
      interests: v('.jn-interests'), basedIn: v('.jn-based'), startDate: v('.jn-start'), endDate: v('.jn-end'),
      pronouns: v('.jn-pronouns'), feedback: (el.querySelector('.jn-feedback input:checked') || {}).value || '',
      listOnWebsite: !!(el.querySelector('.jn-list') || {}).checked,
      pillars: Array.prototype.map.call(el.querySelectorAll('.jn-pillars input:checked'), function(i){ return i.value; }),
    };
    var pick = el.querySelector('.jn-contact-pick');
    if (pick) {
      var o = pick.options[pick.selectedIndex];
      out.contact = pick.value ? o.textContent.trim() : '';
      if (pick.value !== '__typed__') out.contactEmail = pick.value;
    }
    if (el.querySelector('.jn-name')) { out.name = v('.jn-name'); out.email = v('.jn-email').toLowerCase(); }
    return out;
  }

  // What's missing or wrong in d, as functions/index.js normalizeJoinRequest checks it, or ''.
  function problem(d){
    if (d.name !== undefined && !d.name) return 'Give your full name.';
    if (d.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'Give a valid email address.';
    if (!d.institution) return 'Give your home institution.';
    if (!d.role) return 'Choose your role at BOLD.';
    if (!d.contact) return 'Say who your BOLD point of contact is.';
    if (!d.interests) return 'Give your main research interests.';
    if (!d.endDate && NO_END.indexOf(d.role) === -1) return 'Give your end date (not needed for PIs, adjuncts, alumni and collaborators).';
    if (d.startDate && d.endDate && d.endDate < d.startDate) return 'The end date is before the start date.';
    return '';
  }

  // The details as lists of facts, for reading, in the form's groups. o: { name, email }
  // to show first (the profile's own sign-in), else d's.
  function factsHtml(d, o){
    o = o || {};
    var fb = FEEDBACK.filter(function(f){ return f[0] === d.feedback; })[0];
    var row = function(k, v){ return v ? '<div class="fact"><dt>' + k + '</dt><dd>' + v + '</dd></div>' : ''; };
    var group = function(title, rows){ return rows ? '<div class="md-group"><h3>' + title + '</h3><dl class="facts">' + rows + '</dl></div>' : ''; };
    var links = String(d.links || '').split(/[\s,;]+/).filter(Boolean).map(function(u){
      var href = /^https?:\/\//.test(u) ? u : 'https://' + u;
      return /^https?:\/\/[^\s<>"]+$/.test(href) ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(u) + '</a>' : esc(u);
    }).join(' · ');
    return group('About you', row('Name', esc(o.name || d.name || '')) + row('Email', esc(o.email || d.email || '')) +
        row('Pronouns', esc(d.pronouns || '')) + row('Institution', esc(d.institution || '')) +
        row('Based in', esc(d.basedIn || '')) + row('Links', links)) +
      group('At BOLD', row('Role', esc(d.role || '')) + row('Point of contact', esc(d.contact || '')) +
        row('Dates', esc(d.startDate && d.endDate ? d.startDate + ' – ' + d.endDate : d.startDate ? 'From ' + d.startDate : d.endDate ? 'Until ' + d.endDate : '')) +
        (d.role !== undefined ? row('On the website', d.listOnWebsite ? 'Yes' : 'No') : '')) +
      group('Research', row('Interests', esc(d.interests || '')) + row('Pillars', (d.pillars || []).map(esc).join('<br>'))) +
      group('Working with you', row('Feedback', fb ? '<strong>' + fb[1] + '</strong>: ' + esc(fb[2]) : ''));
  }

  return { ROLES: ROLES, PILLARS: PILLARS, NO_END: NO_END, FEEDBACK: FEEDBACK, options: options, fieldsHtml: fieldsHtml, read: read, problem: problem, factsHtml: factsHtml };
})();
