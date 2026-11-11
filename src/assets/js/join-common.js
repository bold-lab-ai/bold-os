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
  // The BOLDiquette's groups (Who is BOLD). A member's is the one a PI or admin set
  // (`category`: on the People page, or approving their request, from their role), else
  // PAN-BOLD (functions/index.js groupOf, kept in sync by hand).
  var CATEGORIES = [['exec', 'BOLD-exec'], ['staff', 'BOLD-staff'], ['internal', 'BOLD-internal'], ['associate', 'BOLD-associate'], ['pan', 'PAN-BOLD']];
  function categoryLabel(key){ var c = CATEGORIES.filter(function(x){ return x[0] === key; })[0]; return c ? c[1] : 'PAN-BOLD'; }
  function groupOf(m){
    m = m || {};
    return CATEGORIES.some(function(c){ return c[0] === m.category; }) ? m.category : 'pan';
  }
  function groupBadge(g){ return '<span class="type-badge pp-' + g + '">' + esc(categoryLabel(g)) + '</span>'; }
  // A group's whole section of the BOLDiquette's Who is BOLD (the part's Markdown, `body`):
  // what's under its heading up to the next heading, dedented, or '' if it has none. The
  // terms someone accepts to ask for that group (group-request.html).
  function groupSectionOf(body, g){
    var label = categoryLabel(g).toLowerCase(), out = [], on = false;
    String(body || '').split('\n').forEach(function(l){
      var m = /^#{1,6}\s+(.*?)\s*:?\s*$/.exec(l);
      if (m) { on = m[1].replace(/[*_`]/g, '').replace(/^for\s+/i, '').toLowerCase() === label; return; }
      if (on) out.push(l);
    });
    var cut = Math.min.apply(null, out.filter(function(l){ return /\S/.test(l); }).map(function(l){ return l.search(/\S/); }).concat([1e9]));
    return out.map(function(l){ return l.slice(Math.min(cut, l.length)); }).join('\n').replace(/^\s*\n|\s+$/g, '');
  }
  // What a group asks of its members: the **Requirements** list under its #### heading in
  // the BOLDiquette's Who is BOLD (the part's Markdown, `body`), dedented, or '' if it has none.
  function requirementsOf(body, g){
    var lines = String(body || '').split('\n'), label = categoryLabel(g).toLowerCase(), i = 0, out = [], indent = -1;
    var heading = function(l){ var m = /^#{1,6}\s+(.*?)\s*:?\s*$/.exec(l); return m ? m[1].toLowerCase() : null; };
    while (i < lines.length && heading(lines[i]) !== label) i++;
    for (i++; i < lines.length && heading(lines[i]) === null; i++) {
      var l = lines[i], lead = l.search(/\S/);
      if (indent < 0) { if (/^\s*-\s*\*\*Requirements\*\*/i.test(l)) indent = lead; continue; }
      if (lead < 0) continue;
      if (lead <= indent) break;
      out.push(l);
    }
    var cut = Math.min.apply(null, out.map(function(l){ return l.search(/\S/); }));
    return out.map(function(l){ return l.slice(cut); }).join('\n');
  }
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

  // The point of contact, on the profile: who invited them too (since 2026-10-26), a choice
  // from the people on BOLD.OS (the `people` roster, o.people, [{ name, email }]), with
  // whether they've confirmed inviting them. A typed one from before stays on offer until
  // another is chosen. (join.html has its own: join.js.)
  function contactHtml(v, people){
    var label = 'BOLD supervisor, mentor or point of contact (they invited you; we ask them to confirm)';
    if (!people) return '<label>' + label + '<input type="text" class="jn-contact" maxlength="200" value="' + esc(v.contact || '') + '" placeholder="Who connects you to BOLD?"></label>';
    var cur = String(v.contactEmail || '').toLowerCase();
    if (!cur && v.contact) {
      var named = people.filter(function(p){ return p.name.toLowerCase() === String(v.contact).trim().toLowerCase(); })[0];
      if (named) cur = named.email;
    }
    var known = people.some(function(p){ return p.email === cur; });
    var inv = v.invitedBy || {}, st = cur && inv.email === cur ? inv.status : '';
    label += st === 'confirmed' ? ' · they confirmed it' : st === 'denied' ? ' · they say they didn’t' : st ? ' · waiting for them to confirm' : '';
    return '<label>' + esc(label) + '<select class="jn-contact-pick"><option value="">Choose a person…</option>' +
      (!known && v.contact ? '<option value="__typed__" selected>' + esc(v.contact) + '</option>' : '') +
      people.map(function(p){ return '<option value="' + esc(p.email) + '"' + (p.email === cur ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') +
      '</select></label>';
  }

  // The fields, filled from v. opts: { withIdentity: name and email too, people: the roster for the point of contact,
  // noInviter: without who invited them (an inviter proposing changes to a request, join-requests.js) }.
  function fieldsHtml(v, opt, o){
    v = v || {}; o = o || {};
    var t = function(cls, label, val, ph, max, type){
      return '<label>' + label + '<input type="' + (type || 'text') + '" class="' + cls + '" maxlength="' + max + '" value="' + esc(val || '') + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
    };
    var pillars = v.pillars || [];
    var group = function(title, body){ return '<fieldset class="md-group"><legend>' + title + '</legend>' + body + '</fieldset>'; };
    return group('About you', (o.withIdentity ? t('jn-name', 'Full name', v.name, '', 120) +
        t('jn-email', 'Email address (for Slack; Gmail preferred, for Google Calendar)', v.email, 'you@gmail.com', 200, 'email') : '') +
      t('jn-pronouns', 'Pronouns', v.pronouns, 'e.g. she/her, they/them', 40) +
      t('jn-institution', 'Home institution', v.institution, 'e.g. UCL, Oxford, Imperial', 120) +
      t('jn-based', 'Primarily based in (for events and socials)', v.basedIn, 'e.g. London', 120) +
      t('jn-links', 'Links (website, X, Google Scholar)', v.links, 'https://…', 500) + (window.BOLD && BOLD.linkNote ? BOLD.linkNote() : '')) +
    group('At BOLD',
      // Your position (#260): not your group of Who is BOLD, which some roles' names sound like (Staff, PI).
      // The hint between the label and the box (a span: a label can't hold a <p>). join.html is for
      // people outside BOLD, who can't open the BOLDiquette yet: no links there.
      '<label>Role at BOLD: your position, such as PhD student or postdoc' +
      '<span class="event-form-hint">This is not your group in ' + (o.withIdentity ? 'Who is BOLD' : '<a href="boldiquette.html#who-is-bold">Who is BOLD</a>') +
        ' (PAN-BOLD, BOLD-internal…), which decides what you can see and do: ' +
        (o.withIdentity ? 'everyone joins as PAN-BOLD, and asks for another group once in.' : '<a href="group-request.html">ask for another group</a>.') + '</span>' +
      '<select class="jn-role"><option value="">Choose…</option>' + opt.roles.map(function(r){
        return '<option' + (r === v.role ? ' selected' : '') + '>' + esc(r) + '</option>';
      }).join('') + (v.role && opt.roles.indexOf(v.role) === -1 ? '<option selected>' + esc(v.role) + '</option>' : '') + '</select></label>' +
      (o.withIdentity ? '' : contactHtml(v, o.people)) +
      // join.html only: their point of contact, who invited them, picked from the roster as they
      // type (join.js); they decide the request.
      (o.withIdentity && !o.noInviter ? '<label>BOLD supervisor, mentor or point of contact (they invited you, and approve your request)' +
        '<input type="text" class="jn-inviter" maxlength="120" placeholder="Start typing their name, then choose them from the list" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"></label>' +
        '<input type="hidden" class="jn-inviter-id"><ul class="jn-inviter-list" role="listbox" hidden></ul>' : '') +
      '<div class="jn-dates">' + t('jn-start', 'Start date', v.startDate, '', 10, 'date') +
        t('jn-end', 'End date (not needed for PIs, adjuncts, alumni and collaborators)', v.endDate, '', 10, 'date') + '</div>' +
      '<label class="jn-check"><input type="checkbox" class="jn-list"' + (v.listOnWebsite ? ' checked' : '') + '> List me on the BOLD website</label>') +
    group('Research',
      t('jn-interests', 'Main research interests (up to 5 keywords)', v.interests, 'e.g. reinforcement learning, world models', 300) +
      '<fieldset class="jn-pillars"><legend>Closest BOLD research pillars</legend>' + opt.pillars.map(function(p){
        return '<label class="jn-check"><input type="checkbox" value="' + esc(p) + '"' + (pillars.indexOf(p) !== -1 ? ' checked' : '') + '> ' + esc(p) + '</label>';
      }).join('') + '</fieldset>') +
    group('Working with you',
      (o.withIdentity ? '' : t('jn-booking', 'Booking link, for “Book time with me” (a Google Calendar booking page, Calendly…)', v.bookingUrl, 'https://calendar.app.google/…', 300, 'url')) +
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
      pronouns: v('.jn-pronouns'), bookingUrl: v('.jn-booking'), feedback: (el.querySelector('.jn-feedback input:checked') || {}).value || '',
      listOnWebsite: !!(el.querySelector('.jn-list') || {}).checked,
      pillars: Array.prototype.map.call(el.querySelectorAll('.jn-pillars input:checked'), function(i){ return i.value; }),
    };
    var pick = el.querySelector('.jn-contact-pick');
    if (pick) {
      var o = pick.options[pick.selectedIndex];
      out.contact = pick.value ? o.textContent.trim() : '';
      if (pick.value !== '__typed__') out.contactEmail = out.inviterEmail = pick.value;
    }
    if (el.querySelector('.jn-name')) { out.name = v('.jn-name'); out.email = v('.jn-email').toLowerCase(); }
    // join.html: the point of contact is who invited them.
    if (el.querySelector('.jn-inviter')) { out.invitedBy = v('.jn-inviter-id'); out.inviterTyped = v('.jn-inviter'); out.contact = out.invitedBy ? out.inviterTyped : ''; }
    // inviterEmail is not part of the record: member-details.js sends it to setMyInviter.
    return out;
  }

  // Everything missing or wrong in d, as functions/index.js normalizeJoinRequest checks it, each with
  // its field (a class in fieldsHtml): [{ field, msg }], at most one per field, in the form's order.
  function problems(d){
    var out = [], add = function(field, msg){ if (!out.some(function(x){ return x.field === field; })) out.push({ field: field, msg: msg }); };
    var inviter = d.invitedBy !== undefined ? 'jn-inviter' : 'jn-contact-pick';
    if (d.name !== undefined && !d.name) add('jn-name', 'Give your full name.');
    if (d.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) add('jn-email', d.email ? 'Give a valid email address.' : 'Give your email address.');
    if (!d.institution) add('jn-institution', 'Give your home institution.');
    if (!d.role) add('jn-role', 'Choose your role at BOLD.');
    if (d.invitedBy !== undefined && !d.invitedBy) add(inviter, d.inviterTyped ? 'Choose them from the list as you type.' : 'Choose your point of contact from the list.');
    if (!d.contact) add(inviter, 'Say who your BOLD point of contact is.');
    if (d.startDate && d.endDate && d.endDate < d.startDate) add('jn-end', 'The end date is before the start date.');
    if (!d.endDate && NO_END.indexOf(d.role) === -1) add('jn-end', 'Give your end date (not needed for PIs, adjuncts, alumni and collaborators).');
    if (!d.interests) add('jn-interests', 'Give your main research interests.');
    if (d.bookingUrl && !/^https:\/\/\S+$/.test(d.bookingUrl)) add('jn-booking', 'The booking link starts with https://');
    var order = ['jn-name', 'jn-email', 'jn-institution', 'jn-role', 'jn-inviter', 'jn-contact-pick', 'jn-end', 'jn-interests', 'jn-booking'];
    return out.sort(function(x, y){ return order.indexOf(x.field) - order.indexOf(y.field); });
  }
  // The first of them, or ''.
  function problem(d){ var p = problems(d)[0]; return p ? p.msg : ''; }
  // Shows each of d's problems under its own field in the form el (a message inside its label, the
  // field marked), clearing those shown before; each goes once its field is changed. Focuses the
  // first. → how many there are.
  function showProblems(el, d){
    Array.prototype.forEach.call(el.querySelectorAll('.jn-field-error'), function(x){ x.remove(); });
    Array.prototype.forEach.call(el.querySelectorAll('[aria-invalid]'), function(x){ x.removeAttribute('aria-invalid'); });
    var list = problems(d), first = null;
    list.forEach(function(p){
      var f = el.querySelector('.' + p.field), label = f && f.closest('label');
      if (!f || !label) return;
      var m = document.createElement('span');
      m.className = 'jn-field-error'; m.id = p.field + '-error'; m.textContent = p.msg;
      label.appendChild(m);
      f.setAttribute('aria-invalid', 'true'); f.setAttribute('aria-describedby', m.id);
      var clear = function(){ m.remove(); f.removeAttribute('aria-invalid'); f.removeAttribute('aria-describedby'); f.removeEventListener('input', clear); f.removeEventListener('change', clear); };
      f.addEventListener('input', clear); f.addEventListener('change', clear);
      if (!first) first = f;
    });
    if (first) { first.scrollIntoView({ block: 'center' }); first.focus({ preventScroll: true }); }
    return list.length;
  }

  // The details as lists of facts, for reading, in the form's groups. o: { name, email }
  // to show first (the profile's own sign-in), else d's; group: the Group row's html;
  // other: someone else's (person.html), for the headings.
  function factsHtml(d, o){
    o = o || {};
    var fb = FEEDBACK.filter(function(f){ return f[0] === d.feedback; })[0];
    var row = function(k, v){ return v ? '<div class="fact"><dt>' + k + '</dt><dd>' + v + '</dd></div>' : ''; };
    var group = function(title, rows){ return rows ? '<div class="md-group"><h3>' + title + '</h3><dl class="facts">' + rows + '</dl></div>' : ''; };
    var links = String(d.links || '').split(/[\s,;]+/).filter(Boolean).map(function(u){
      var href = /^https?:\/\//.test(u) ? u : 'https://' + u;
      return /^https?:\/\/[^\s<>"]+$/.test(href) ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(u) + '</a>' : esc(u);
    }).join(' · ');
    return group(o.other ? 'About' : 'About you', row('Name', esc(o.name || d.name || '')) + row('Email', esc(o.email || d.email || '')) +
        row('Pronouns', esc(d.pronouns || '')) + row('Institution', esc(d.institution || '')) +
        row('Based in', esc(d.basedIn || '')) + row('Links', links)) +
      group('At BOLD', row('Group', o.group || '') + row('Role', esc(d.role || '')) + row('Point of contact', esc(d.contact || '')) +
        // Since 2026-10-26 the point of contact is who invited them: one row, then.
        row('Invited by', d.invitedBy && d.invitedBy.name && !(d.contactEmail && d.contactEmail === d.invitedBy.email) ? esc(d.invitedBy.name) + ' <span class="acct-handle">' +
          ({ confirmed: 'confirmed', denied: 'says they didn’t' }[d.invitedBy.status] || 'not confirmed yet') + '</span>' : '') +
        row('Dates', esc(d.startDate && d.endDate ? d.startDate + ' – ' + d.endDate : d.startDate ? 'From ' + d.startDate : d.endDate ? 'Until ' + d.endDate : '')) +
        (d.role !== undefined ? row('On the website', d.listOnWebsite ? 'Yes' : 'No') : '')) +
      group('Research', row('Interests', esc(d.interests || '')) + row('Pillars', (d.pillars || []).map(esc).join('<br>'))) +
      group(o.other ? 'Working with them' : 'Working with you', row('Feedback', fb ? '<strong>' + fb[1] + '</strong>: ' + esc(fb[2]) : '') +
        row('Booking link', /^https:\/\/\S+$/.test(d.bookingUrl || '') ? '<a href="' + esc(d.bookingUrl) + '" target="_blank" rel="noopener">' + esc(d.bookingUrl.replace(/^https:\/\//, '')) + '</a>' : ''));
  }

  return { ROLES: ROLES, PILLARS: PILLARS, NO_END: NO_END, CATEGORIES: CATEGORIES, categoryLabel: categoryLabel, groupOf: groupOf, groupBadge: groupBadge, requirementsOf: requirementsOf, groupSectionOf: groupSectionOf, FEEDBACK: FEEDBACK, options: options, fieldsHtml: fieldsHtml, read: read, problem: problem, problems: problems, showProblems: showProblems, factsHtml: factsHtml };
})();
