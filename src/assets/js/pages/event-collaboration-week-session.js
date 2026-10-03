// A Collaboration Week session's page. The programme in
// src/_data/collabWeekSessions.js is the default (inlined as #sessionData);
// Firestore's collabWeekSessions/{slug} holds what's been edited since, and
// the session's leads. Everyone sees the same page; a lead (their own
// session) or a PI/admin (any) also gets one "Edit session" button that
// swaps it for a form. Only a PI/admin can change who the leads are
// (firestore.rules). Day, time and venue belong to the whole schedule, and
// each talk has its own generated page, so neither is edited here.
(function(){
  if (!BOLD.getAuth()) return;

  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var bodyEl = el('sessionBody');
  var base = JSON.parse(el('sessionData').textContent);
  var venue = JSON.parse(el('sessionLocation').textContent) || {};
  var TYPES = JSON.parse(el('sessionTypes').textContent) || {};

  function badge(type){ return TYPES[type] ? '<span class="type-badge type-' + esc(type) + '">' + esc(TYPES[type]) + '</span>' : ''; }

  var NOT_EDITOR = 'Only the session’s leads, PIs and admins can edit it';
  var db = null, ref = null;
  try {
    db = firebase.firestore(BOLD.getApp());
    ref = db.collection('collabWeekSessions').doc(base.slug);
  } catch (e){}

  var me = null;            // { email } once signed in
  var saved = null;         // the Firestore doc's data, or null if it doesn't exist (yet)
  var fullWrite = false;    // PI or admin (getMyAccess)
  var editing = false;      // the form is open
  var people = [];          // the `people` roster, for the leads picker
  var leadRows = [];        // in-progress rows while the form is open

  function session(){ return Object.assign({}, base, saved || {}); }

  // Every address a lead could sign in with: their own, plus any other roster
  // account under the same name (some people are in Slack twice).
  function emailsOf(leads){
    var out = [];
    (leads || []).forEach(function(l){
      var name = (l.name || '').trim().toLowerCase();
      if (l.email) out.push(l.email.toLowerCase());
      people.forEach(function(p){
        if (name && (p.name || '').trim().toLowerCase() === name && p.email) out.push(p.email.toLowerCase());
      });
    });
    return out.filter(function(e, i){ return out.indexOf(e) === i; });
  }

  function isLead(){
    if (!me || !me.email) return false;
    var emails = saved && saved.leadEmails ? saved.leadEmails : emailsOf(base.leads);
    return emails.indexOf(me.email.toLowerCase()) >= 0;
  }

  // A lead can only update an existing doc (a PI/admin creates it), as in the rules.
  function canEdit(){ return !!me && (fullWrite || (isLead() && !!saved)); }

  function isEmpty(v){ return v == null || v === '' || (Array.isArray(v) && !v.length); }

  // --- the editable fields, in form order ------------------------------------

  // Lists are edited as one entry per line; `|` separates the parts of an entry.
  var FIELDS = [
    { key: 'title', label: 'Title', input: 'text', required: true },
    { key: 'subtitle', label: 'Subtitle', input: 'text' },
    { key: 'room', label: 'Room', input: 'text', placeholder: 'e.g. Seminar Room 2' },
    { key: 'contact', label: 'Contact', input: 'text', placeholder: 'e.g. name@example.com' },
    { key: 'overallDescription', label: 'Overall description', input: 'area' },
    { key: 'problems', label: 'Problems', input: 'area' },
    { key: 'background', label: 'Background', input: 'area' },
    { key: 'keyQuestions', label: 'Key questions', input: 'area', list: true, hint: 'One question per line.' },
    { key: 'aim', label: 'Aim', input: 'area' },
    { key: 'links', label: 'Links', input: 'area', list: true, hint: 'One per line: Label | https://…' },
    { key: 'agenda', label: 'Agenda', input: 'area', list: true, hint: 'One per line: time | activity' }
  ];

  function toText(key, v){
    if (!v) return '';
    if (key === 'keyQuestions') return v.join('\n');
    if (key === 'links') return v.map(function(l){ return l.label + ' | ' + l.url; }).join('\n');
    if (key === 'agenda') return v.map(function(a){
      var what = a.activity + (a.speaker ? ' — ' + a.speaker : '') + (a.duration ? ' (' + a.duration + ')' : '');
      return (a.time ? a.time + ' | ' : '') + what;
    }).join('\n');
    return v;
  }

  // → { value } or { error }
  function fromText(f, text){
    var t = text.trim();
    if (!f.list) {
      if (!t && f.required) return { error: f.label + ' can’t be empty.' };
      return { value: t };
    }
    var lines = t ? t.split('\n').map(function(s){ return s.trim(); }).filter(Boolean) : [];
    if (f.key === 'keyQuestions') return { value: lines };
    if (f.key === 'links') {
      var links = [], bad = null;
      lines.forEach(function(line){
        var i = line.lastIndexOf('|');
        var label = i >= 0 ? line.slice(0, i).trim() : '';
        var url = (i >= 0 ? line.slice(i + 1) : line).trim();
        if (!/^https?:\/\/\S+$/.test(url)) bad = bad || line;
        links.push({ label: label || url, url: url });
      });
      return bad ? { error: 'Links: not a link — “' + bad + '”. Use Label | https://…' } : { value: links };
    }
    return { value: lines.map(function(line){   // agenda
      var i = line.indexOf('|');
      return i >= 0 ? { time: line.slice(0, i).trim(), activity: line.slice(i + 1).trim() } : { time: '', activity: line };
    }) };
  }

  // --- the page everyone sees -------------------------------------------------

  function row(label, valueHtml){ return '<dt>' + label + '</dt><dd>' + valueHtml + '</dd>'; }

  function leadsHtml(leads){
    return (leads || []).map(function(l){
      return '<span class="lead"' + (l.email ? ' title="' + esc(l.email) + '"' : '') + '>' + esc(l.name) + '</span>';
    }).join(', ');
  }

  function section(label, html){
    return '<div class="detail-field"><p class="detail-field-label">' + label + '</p>' + html + '</div>';
  }

  function viewHtml(){
    var s = session();
    var html = badge(s.type) + '<div class="detail-head"><h2>' + esc(s.title) + '</h2>' +
      (canEdit() ? '<button class="btn" type="button" id="editOpen">Edit session</button>' : '') + '</div>';
    if (s.subtitle) html += '<p class="detail-subtitle">' + esc(s.subtitle) + '</p>';

    var where = esc(venue.name || '') + (s.room ? ' &mdash; ' + esc(s.room) : '') +
      (venue.mapsUrl ? ' &middot; <a href="' + esc(venue.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      (venue.address ? '<span class="meta">' + esc(venue.address) + '</span>' : '');
    html += '<dl class="detail-grid">' + row('When', esc(s.day + ', ' + s.time)) + row('Where', where);
    if (!isEmpty(s.leads)) html += row(s.leads.length > 1 ? 'Leads' : 'Lead', leadsHtml(s.leads));
    if (s.contact) html += row('Contact', esc(s.contact));
    html += '</dl>';

    FIELDS.forEach(function(f){
      var v = s[f.key];
      if (isEmpty(v)) return;
      if (f.key === 'keyQuestions') html += section(f.label, '<ul>' + v.map(function(q){ return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>');
      else if (['overallDescription', 'problems', 'background', 'aim'].indexOf(f.key) >= 0) html += section(f.label, '<p>' + esc(v) + '</p>');
    });

    if (!isEmpty(s.links)) html += '<ul class="detail-links">' + s.links.map(function(l){
      return '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a></li>';
    }).join('') + '</ul>';

    if (!isEmpty(s.talks)) html += section('Talks', '<ul class="session-talks">' + s.talks.map(function(t){
      var title = t.slug ? '<a href="event-collaboration-week-talk-' + esc(t.slug) + '.html">' + esc(t.title) + '</a>' : esc(t.title);
      return '<li><span class="t">' + esc(t.time || t.duration || '') + '</span><span class="e">' + title +
        (t.speaker ? ' <span class="who">— ' + esc(t.speaker) + '</span>' : '') +
        (t.notes ? '<span class="meta">' + esc(t.notes) + '</span>' : '') + '</span>' +
        (t.type ? '<span class="talk-type">' + badge(t.type) + '</span>' : '') + '</li>';
    }).join('') + '</ul>');

    if (!isEmpty(s.agenda)) html += section('Agenda', '<ul class="session-agenda">' + s.agenda.map(function(a){
      return '<li><span class="t">' + esc(a.time || '') + '</span><span class="e">' + esc(a.activity) +
        (a.speaker ? ' — ' + esc(a.speaker) : '') + (a.duration ? ' (' + esc(a.duration) + ')' : '') + '</span></li>';
    }).join('') + '</ul>');

    if (s.notes) html += '<p class="detail-msg">' + esc(s.notes) + '</p>';
    return html;
  }

  // --- the edit form ----------------------------------------------------------

  function formHtml(){
    var s = session();
    var html = '<div class="detail-head"><h2>Edit session</h2></div>' +
      '<p class="detail-subtitle">' + esc(s.day + ', ' + s.time + ' · ' + (venue.name || '')) +
      ' — day, time and venue are set with the schedule.</p><div class="edit-form">';
    FIELDS.forEach(function(f){
      var id = 'f_' + f.key, v = toText(f.key, s[f.key]);
      html += '<div class="edit-field"><label for="' + id + '">' + esc(f.label) + '</label>' +
        (f.input === 'text'
          ? '<input type="text" id="' + id + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">'
          : '<textarea id="' + id + '" rows="' + (f.list ? 5 : 6) + '">' + esc(v) + '</textarea>') +
        (f.hint ? '<p class="edit-hint">' + esc(f.hint) + '</p>' : '') + '</div>';
      if (f.key === 'contact') html += '<div class="edit-field"><span class="edit-label">Leads</span>' + (fullWrite
        ? '<div id="leadRows"></div>'
        : '<p class="edit-static">' + leadsHtml(s.leads) + '</p><p class="edit-hint">Only PIs and admins can change the leads.</p>') + '</div>';
    });
    return html + '</div><div class="field-error" id="editError" hidden></div>' +
      '<div class="edit-actions"><button class="btn btn-primary" type="button" id="editSave">Save</button>' +
      '<button class="btn" type="button" id="editCancel">Cancel</button></div>';
  }

  function leadRowsHtml(){
    return leadRows.map(function(r, i){
      var control = r.free
        ? '<input type="text" class="lead-name" data-i="' + i + '" value="' + esc(r.name) + '" placeholder="Name (not on Slack)">' +
          '<button type="button" class="btn-text lead-roster" data-i="' + i + '">Pick from list</button>'
        : '<select class="lead-select" data-i="' + i + '"><option value="">Choose a person…</option>' +
          people.map(function(p){
            return '<option value="' + esc(p.email) + '"' + (p.email === r.email ? ' selected' : '') + '>' + esc(p.name) + '</option>';
          }).join('') + '<option value="__free__">Someone not on Slack…</option></select>';
      return '<div class="lead-row">' + control +
        '<button type="button" class="btn-text danger lead-remove" data-i="' + i + '">Remove</button></div>';
    }).join('') + '<button type="button" class="btn-text" id="leadAdd">+ Add a lead</button>';
  }

  function wireLeadRows(){
    var wrap = el('leadRows');
    if (!wrap) return;
    wrap.innerHTML = leadRowsHtml();
    wrap.querySelectorAll('.lead-select').forEach(function(sel){
      sel.addEventListener('change', function(){
        var i = Number(sel.getAttribute('data-i'));
        if (sel.value === '__free__') leadRows[i] = { name: '', email: '', free: true };
        else {
          var p = people.filter(function(x){ return x.email === sel.value; })[0];
          leadRows[i] = { name: p ? p.name : '', email: sel.value, free: false };
        }
        wireLeadRows();
      });
    });
    wrap.querySelectorAll('.lead-name').forEach(function(inp){
      inp.addEventListener('input', function(){ leadRows[Number(inp.getAttribute('data-i'))].name = inp.value; });
    });
    wrap.querySelectorAll('.lead-roster').forEach(function(btn){
      btn.addEventListener('click', function(){ leadRows[Number(btn.getAttribute('data-i'))] = { name: '', email: '', free: false }; wireLeadRows(); });
    });
    wrap.querySelectorAll('.lead-remove').forEach(function(btn){
      btn.addEventListener('click', function(){ leadRows.splice(Number(btn.getAttribute('data-i')), 1); wireLeadRows(); });
    });
    el('leadAdd').addEventListener('click', function(){ leadRows.push({ name: '', email: '', free: false }); wireLeadRows(); });
  }

  var peoplePromise = null;
  function loadPeople(){
    if (!peoplePromise) peoplePromise = db.collection('people').get().then(function(snap){
      people = snap.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the roster failed', err); });
    return peoplePromise;
  }

  function openForm(){
    var ready = fullWrite ? loadPeople() : Promise.resolve();
    ready.then(function(){
      leadRows = (session().leads || []).map(function(l){ return { name: l.name, email: l.email || '', free: !l.email }; });
      editing = true;
      render();
      el('f_title').focus();
    });
  }

  // Only the fields that changed are written. The first save of a session
  // (always a PI's/admin's — see canEdit) also records its leads from the
  // programme, so they can edit it from then on.
  function saveForm(){
    var btn = el('editSave');
    var fail = function(msg){ var e = el('editError'); e.textContent = msg; e.hidden = false; };
    if (!canEdit() || !ref) return fail(NOT_EDITOR + '.');
    var s = session(), patch = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i], parsed = fromText(f, el('f_' + f.key).value);
      if (parsed.error) return fail(parsed.error);
      if (JSON.stringify(parsed.value) !== JSON.stringify(fromText(f, toText(f.key, s[f.key])).value)) patch[f.key] = parsed.value;
    }
    if (fullWrite) {
      var leads = leadRows
        .map(function(r){ return r.free ? { name: (r.name || '').trim() } : { name: r.name, email: r.email }; })
        .filter(function(l){ return l.name; });
      if (!leads.length) return fail('A session needs at least one lead.');
      if (JSON.stringify(leads) !== JSON.stringify(s.leads || [])) { patch.leads = leads; patch.leadEmails = emailsOf(leads); }
    }
    if (!Object.keys(patch).length) { editing = false; render(); return; }
    btn.disabled = true;
    var seed = saved ? {} : { slug: base.slug, leads: base.leads || [], leadEmails: emailsOf(base.leads) };
    var write = Object.assign(seed, patch, { updatedAt: Date.now(), updatedBy: me.email });
    ref.set(write, { merge: true }).then(function(){
      saved = Object.assign({}, saved || {}, write);
      editing = false;
      render();
    }).catch(function(err){
      console.error('[BOLD Collaboration Week] saving the session failed', err);
      btn.disabled = false;
      fail(err && err.code === 'permission-denied' ? NOT_EDITOR + '.' : 'Could not save — try again.');
    });
  }

  function render(){
    bodyEl.innerHTML = editing ? formHtml() : viewHtml();
    if (!editing) {
      var open = el('editOpen');
      if (open) open.addEventListener('click', openForm);
      return;
    }
    wireLeadRows();
    el('editSave').addEventListener('click', saveForm);
    el('editCancel').addEventListener('click', function(){ editing = false; render(); });
  }

  // --- data -----------------------------------------------------------------

  function loadAccess(){
    try {
      firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
        var v = !!(r.data && r.data.fullWrite);
        if (v !== fullWrite) { fullWrite = v; if (!editing) render(); }
      }).catch(function(err){ console.error('[BOLD Collaboration Week] access check failed', err); });
    } catch (e){}
  }

  render();
  var unsubscribe = null;
  BOLD.onUser(function(user){
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    editing = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (!user || !ref) { render(); return; }
    loadAccess();
    unsubscribe = ref.onSnapshot(function(snap){
      saved = snap.exists ? snap.data() : null;
      if (!editing) render();
    }, function(err){
      console.error('[BOLD Collaboration Week] loading the session failed', err);
    });
  });
})();
