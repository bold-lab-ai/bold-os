// letters.html: recommendation letters (functions/index.js "Service desk").
// Anyone asks anyone in the lab for a letter; the writer gets a Slack message,
// acknowledges it, and marks each recipient submitted, or shares the letter
// where the requester sends it on. Every write is letterRequest; the page reads
// the requests asked by and of the viewer (letterRequests, theirs alone). Each request
// is one line (what it's for, who, how many letters are in); clicking it opens the rest.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('letters');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('letterRequest')(data); };
  var me = null, byMe = null, ofMe = null, writers = null, unsubs = [];
  // The open form: null, 'new', or a request's id.
  var editing = null, busy = {};
  // The requests opened (clicked) to show their details: id → true.
  var shown = {};

  function day(iso){ return iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function today(){ var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function first(name){ return String(name || '').split(' ')[0] || name; }

  function linkify(text){
    return esc(text).replace(/https?:\/\/[^\s<>"]+/g, function(u){ return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
  }

  // The nearest deadline not submitted yet, for sorting.
  function nextDeadline(q){
    return (q.recipients || []).filter(function(r){ return !r.submittedAt && r.deadline; }).map(function(r){ return r.deadline; }).sort()[0] || '9999';
  }
  function sorted(list){
    return list.slice().sort(function(a, b){
      if (a.open !== b.open) return a.open ? -1 : 1;
      return a.open ? nextDeadline(a).localeCompare(nextDeadline(b)) : (b.at || 0) - (a.at || 0);
    });
  }

  function recipientHtml(q, r, asWriter){
    var late = !r.submittedAt && r.deadline && r.deadline < today();
    var status = r.submittedAt
      ? '<span class="lt-status is-done">' + (r.sentBy === 'requester' ? 'Shared ' : 'Submitted ') + when(r.submittedAt) + '</span>'
      : '<span class="lt-status' + (late ? ' is-late' : '') + '">' + (late ? 'Overdue' : 'Not submitted') + '</span>';
    var who = r.sentBy === 'requester' ? 'Applicant sends it' : 'Referee sends it';
    var name = r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name) + '</a>' : esc(r.name);
    var b = busy[q.id + '/' + r.id] ? ' disabled' : '';
    var controls = '';
    if (asWriter && !r.submittedAt && r.sentBy === 'requester') {
      controls = '<div class="lt-share"><input type="url" class="lt-letter" placeholder="Link to the letter, for ' + esc(first(q.requesterName)) + ' to send" aria-label="Link to the letter">' +
        '<button type="button" class="btn-text lt-submit" data-id="' + esc(q.id) + '" data-r="' + esc(r.id) + '"' + b + '>Share the letter</button></div>';
    } else if (asWriter && !r.submittedAt) {
      controls = '<button type="button" class="btn-text lt-submit" data-id="' + esc(q.id) + '" data-r="' + esc(r.id) + '"' + b + '>Mark submitted</button>';
    } else if (asWriter) {
      controls = '<button type="button" class="btn-text danger lt-unsubmit" data-id="' + esc(q.id) + '" data-r="' + esc(r.id) + '"' + b + '>Undo</button>';
    }
    return '<li><span class="lt-rname">' + name + '</span>' +
      '<span class="lt-rinfo">' + (r.deadline ? 'Due ' + day(r.deadline) : 'No deadline') + ' · ' + esc(who) + '</span>' + status +
      (r.letterUrl ? '<a class="btn-text" href="' + esc(r.letterUrl) + '" target="_blank" rel="noopener">The letter</a>' : '') +
      controls + '</li>';
  }

  // "About your work with me": the referee's questions.
  var WORK = [
    { key: 'howWorked', short: 'Worked together', q: 'How we’ve worked together: modules, project or dissertation supervision, research work, and the dates. What you did yourself, as opposed to your group: the project title, methods and tools, results, and any outputs (code, report, paper, talk).' },
    { key: 'best', short: 'Best moments', q: 'One or two moments you think show you at your best, such as a problem you solved on your own, an idea that was yours, or how you handled a setback (optional).' },
    { key: 'extra', short: 'Also relevant', q: 'Anything relevant I might not know about: publications, awards, other research, work outside the course (optional).' },
  ];

  function material(label, html){ return html ? '<div class="fact"><dt>' + label + '</dt><dd>' + html + '</dd></div>' : ''; }

  // The request as a prompt for the referee's agent (the bold-recommendation-letter skill).
  var SKILL = 'bold-recommendation-letter';
  function agentPrompt(q){
    var skillUrl = new URL('skill.html?skill=' + SKILL, location.href).href;
    var lines = [
      'Draft a recommendation letter with the ' + SKILL + ' skill (install it from ' + skillUrl + ' if you don’t have it).',
      '',
      'Applicant: ' + q.requesterName,
      'What it’s for: ' + q.purpose,
      'Asked: ' + when(q.at),
      '',
      'Where it goes:',
    ];
    (q.recipients || []).forEach(function(r){
      lines.push('- ' + r.name +
        (r.deadline ? '; due ' + day(r.deadline) : '; no deadline') +
        (r.sentBy === 'requester' ? '; the applicant sends it (the referee shares it with them)' : '; the referee sends it') +
        (r.url ? '; ' + r.url : '') +
        (r.submittedAt ? '; ALREADY SUBMITTED ' + when(r.submittedAt) : ''));
    });
    lines.push('', 'CV: ' + (q.cv || 'none'), 'Cover letter or research statement: ' + (q.statement || 'none'));
    WORK.forEach(function(w){
      if (q[w.key]) lines.push('', w.short + ' (asked: “' + w.q + '”):', q[w.key]);
    });
    return lines.join('\n');
  }

  // Collapsed: how many letters are in, and the next deadline (or that one is late).
  function summary(q){
    var rs = q.recipients || [], done = rs.filter(function(r){ return r.submittedAt; }).length;
    var next = nextDeadline(q), late = next !== '9999' && next < today();
    return '<span class="lt-sum">' + done + ' of ' + rs.length + ' in' +
      (done < rs.length && next !== '9999' ? ' · ' + (late ? '<span class="is-late">overdue since ' + day(next) + '</span>' : 'next due ' + day(next)) : '') + '</span>';
  }

  function requestHtml(q, asWriter){
    var ack = q.acknowledgedAt ? '<span class="is-ok">Received ' + when(q.acknowledgedAt) + '</span>' : 'Not acknowledged yet';
    var meta = asWriter
      ? 'Applicant: ' + esc(q.requesterName) + ' · asked ' + when(q.at) + (q.acknowledgedAt ? '' : ' · not acknowledged yet')
      : 'Referee: ' + esc(q.writerName) + ' · asked ' + when(q.at) + ' · ' + ack;
    var b = busy[q.id] ? ' disabled' : '';
    var controls = asWriter
      ? (q.acknowledgedAt ? '' : '<button type="button" class="btn-text lt-ack" data-id="' + esc(q.id) + '"' + b + '>Got it</button>')
      : '<button type="button" class="btn-text lt-edit" data-id="' + esc(q.id) + '"' + b + '>Edit</button>' +
        '<button type="button" class="btn-text danger lt-withdraw" data-id="' + esc(q.id) + '"' + b + '>Withdraw</button>';
    var open = !!shown[q.id] || editing === q.id;
    var head = '<button type="button" class="lt-title lt-open" data-id="' + esc(q.id) + '" aria-expanded="' + open + '">' + esc(q.purpose) + '</button>' +
      '<span class="lt-meta">' + meta + ' · ' + summary(q) + '</span>';
    if (!open) return '<li class="lt-item" id="l-' + esc(q.id) + '">' + head + '</li>';
    return '<li class="lt-item is-open" id="l-' + esc(q.id) + '">' + head +
      '<span class="lt-label">Where it goes</span><ul class="lt-recipients">' +
        (q.recipients || []).map(function(r){ return recipientHtml(q, r, asWriter); }).join('') + '</ul>' +
      '<span class="lt-label">Materials</span><dl class="lt-materials">' +
        material('CV', q.cv && '<a href="' + esc(q.cv) + '" target="_blank" rel="noopener">Open</a>') +
        material('Cover letter or research statement', q.statement && '<a href="' + esc(q.statement) + '" target="_blank" rel="noopener">Open</a>') +
        WORK.map(function(w){ return material(w.short, q[w.key] && '<span class="lt-text">' + linkify(q[w.key]) + '</span>'); }).join('') + '</dl>' +
      (asWriter && q.open !== false ? '<span class="lt-label">For your agent</span><div class="lt-agent">' +
        '<p class="detail-muted">Paste it into Claude Code to draft the letter with the <a href="skill.html?skill=' + SKILL + '">' + SKILL + '</a> skill.</p>' +
        BOLD.copyBoxHtml(agentPrompt(q)) + '</div>' : '') +
      (controls ? '<div class="event-controls">' + controls + '</div>' : '') +
      (editing === q.id ? formHtml(q) : '') + '</li>';
  }

  function rowHtml(r){
    r = r || {};
    var done = !!r.submittedAt;
    return '<div class="lt-rrow" data-rid="' + esc(r.id || '') + '">' +
      '<label>Recipient<input type="text" class="lt-rn" maxlength="200" value="' + esc(r.name || '') + '" placeholder="e.g. MIT EECS PhD programme"></label>' +
      '<label>Deadline (optional)<input type="date" class="lt-rd" value="' + esc(r.deadline || '') + '"></label>' +
      '<label>Link to the portal or the call<input type="url" class="lt-ru" maxlength="500" value="' + esc(r.url || '') + '" placeholder="https://…"></label>' +
      '<label>Who sends the letter<select class="lt-rs"' + (done ? ' disabled title="The letter is in already"' : '') + '>' +
        '<option value="writer"' + (r.sentBy !== 'requester' ? ' selected' : '') + '>Referee</option>' +
        '<option value="requester"' + (r.sentBy === 'requester' ? ' selected' : '') + '>Applicant (the referee shares it with you)</option></select></label>' +
      '<button type="button" class="btn-text danger lt-rremove">Remove</button></div>';
  }

  // The form, empty (asking) or filled from q (editing).
  function formHtml(q){
    var who = q
      ? '<label>Referee<span class="spk-chosen">' + esc(q.writerName) + '</span></label>'
      : '<label>Referee</label><div class="lt-who"></div>';
    return '<div class="event-form lt-form" data-id="' + esc(q ? q.id : '') + '">' + who +
      '<label>What it’s for<input type="text" class="lt-purpose" maxlength="300" value="' + esc(q ? q.purpose : '') + '" placeholder="e.g. PhD applications, Fall 2027"></label>' +
      '<fieldset><legend>Where it goes</legend><div class="lt-rows">' +
        ((q ? q.recipients : null) || [null]).map(rowHtml).join('') + '</div>' +
        '<button type="button" class="btn-text lt-radd">+ Add a recipient</button></fieldset>' +
      '<fieldset><legend>Materials for the referee</legend>' +
        '<label>CV (link)<input type="url" class="lt-cv" maxlength="1000" value="' + esc(q ? q.cv || '' : '') + '" placeholder="https://…"></label>' +
        '<label>Cover letter or research statement (link, optional)<input type="url" class="lt-statement" maxlength="1000" value="' + esc(q ? q.statement || '' : '') + '" placeholder="https://…"></label>' +
      '</fieldset>' +
      '<fieldset><legend>About your work with me</legend>' + WORK.map(function(w){
        return '<label>' + esc(w.q) + '<textarea class="lt-w no-tags" data-key="' + w.key + '" rows="' + (w.key === 'howWorked' ? 7 : 4) + '" maxlength="' + (w.key === 'howWorked' ? 6000 : 3000) + '">' + esc(q ? q[w.key] || '' : '') + '</textarea></label>';
      }).join('') + '</fieldset>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save lt-save">' + (q ? 'Save' : 'Ask for the letter') + '</button>' +
        '<button type="button" class="lt-cancel">Cancel</button></div></div>';
  }

  function render(){
    if (!me) return;
    if (byMe === null || ofMe === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) return; // don't redraw over a form being filled in
    var openOf = ofMe.filter(function(q){ return q.open; }).length, openBy = byMe.filter(function(q){ return q.open; }).length;
    // Two tabs, named by the #hash: as referee, as applicant (with how many are open).
    main.innerHTML =
      '<nav class="guide-tabs lt-tabs" id="ltTabs" aria-label="Letters">' +
        '<a class="guide-tab" href="#referee">As referee' + (openOf ? ' (' + openOf + ')' : '') + '</a>' +
        '<a class="guide-tab" href="#applicant">As applicant' + (openBy ? ' (' + openBy + ')' : '') + '</a></nav>' +
      '<section class="lt-panel" id="referee">' +
        (ofMe.length ? '<ul class="lt-list">' + sorted(ofMe).map(function(q){ return requestHtml(q, true); }).join('') + '</ul>' : '<p class="proj-msg">Nobody has asked you for a letter.</p>') + '</section>' +
      '<section class="lt-panel" id="applicant">' +
        (byMe.length ? '<ul class="lt-list">' + sorted(byMe).map(function(q){ return requestHtml(q, false); }).join('') + '</ul>' : '<p class="proj-msg">You haven’t asked for a letter yet.</p>') +
        '<div class="lt-new"><button type="button" class="event-add lt-ask">+ Ask for a letter</button></div></section>';
    showTab();
    var m = /#l=([A-Za-z0-9]+)/.exec(location.hash), el = m && document.getElementById('l-' + m[1]);
    if (el && !render.jumped && !shown[m[1]]) { shown[m[1]] = true; render(); return; }
    if (el && !render.jumped) { render.jumped = true; el.classList.add('is-target'); el.scrollIntoView({ block: 'start' }); }
  }

  // The tab the #hash names; a link to one request (#l=) opens the tab it's in. Without
  // one: As referee if anyone asked you, else As applicant.
  function showTab(){
    var tabs = document.getElementById('ltTabs');
    if (!tabs) return;
    var h = location.hash, m = /^#l=([A-Za-z0-9]+)/.exec(h), want;
    if (h === '#referee' || h === '#applicant') want = h.slice(1);
    else if (m) want = ofMe.some(function(q){ return q.id === m[1]; }) ? 'referee' : 'applicant';
    else want = ofMe.length ? 'referee' : 'applicant';
    ['referee', 'applicant'].forEach(function(t){ document.getElementById(t).hidden = t !== want; });
    Array.prototype.forEach.call(tabs.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', function(){ if (byMe && ofMe) showTab(); });

  // ---------- choosing the writer: a list of the BOLD.OS users, filtered by typing ----------
  function mountWho(wrap, form){
    var chosen = form.writer;
    if (chosen) {
      wrap.innerHTML = '<span class="spk-chosen">' + esc(chosen.name) + ' <span class="detail-muted">' + esc(chosen.email) + '</span>' +
        '<button type="button" class="btn-text lt-who-change">Change</button></span>';
      wrap.querySelector('.lt-who-change').addEventListener('click', function(){ form.writer = null; mountWho(wrap, form); wrap.querySelector('input').focus(); });
      return;
    }
    wrap.innerHTML = '<div class="spk-search"><input type="text" class="lt-who-q" placeholder="Choose, or type a name…" autocomplete="off" role="combobox" aria-expanded="false" aria-label="Referee">' +
      '<ul class="spk-results" role="listbox" hidden></ul></div>';
    var input = wrap.querySelector('input'), list = wrap.querySelector('ul'), found = [], active = 0;
    var fold = function(s){ return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); };
    function pick(k){ if (!found[k]) return; form.writer = { name: found[k].name || found[k].email, email: found[k].email }; mountWho(wrap, form); }
    function show(){
      var words = fold(input.value).split(/\s+/).filter(Boolean);
      found = (writers || []).filter(function(p){
        var hay = fold(p.name) + ' ' + fold(p.email);
        return p.email !== me.email && words.every(function(w){ return hay.indexOf(w) >= 0; });
      });
      active = 0;
      list.innerHTML = found.length ? found.map(function(p, k){
        return '<li role="option" data-k="' + k + '"' + (k === active ? ' class="active"' : '') + '>' + esc(p.name) + '<span class="detail-muted">' + esc(p.email) + '</span></li>';
      }).join('') : '<li class="spk-none">' + (writers ? 'Nobody in BOLD.OS matches.' : 'Loading…') + '</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', String(!list.hidden));
      list.querySelectorAll('li[data-k]').forEach(function(li){
        li.addEventListener('mousedown', function(e){ e.preventDefault(); pick(Number(li.getAttribute('data-k'))); });
      });
    }
    function highlight(k){
      var items = list.querySelectorAll('li[data-k]');
      if (!items.length) return;
      active = (k + items.length) % items.length;
      items.forEach(function(li, j){ li.classList.toggle('active', j === active); });
      items[active].scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('click', show);
    input.addEventListener('blur', function(){ list.hidden = true; input.setAttribute('aria-expanded', 'false'); });
    input.addEventListener('keydown', function(e){
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); list.hidden = true; }
    });
  }

  var newForm = null; // { writer } while asking

  function openForm(id){
    editing = id;
    if (id === 'new') {
      newForm = { writer: null };
      var wrap = main.querySelector('.lt-new');
      wrap.innerHTML = formHtml(null);
      mountWho(wrap.querySelector('.lt-who'), newForm);
      if (!writers) firebase.app().functions('europe-west2').httpsCallable('letterWriters')().then(function(r){
        writers = (r.data && r.data.writers) || [];
        var q = main.querySelector('.lt-who-q');
        if (q && q === document.activeElement) q.dispatchEvent(new Event('input'));
      }).catch(function(err){ console.error('[BOLD Letters] loading the BOLD.OS users failed', err); writers = []; });
      wrap.querySelector('.lt-who-q').focus();
      return;
    }
    var q = byMe.filter(function(x){ return x.id === id; })[0], li = document.getElementById('l-' + id);
    if (!q || !li) { editing = null; return; }
    li.insertAdjacentHTML('beforeend', formHtml(q));
    li.querySelector('.lt-purpose').focus();
  }

  function closeForm(){ editing = null; newForm = null; render(); }

  function readForm(f){
    var v = function(c){ return f.querySelector(c).value.trim(); };
    return {
      purpose: v('.lt-purpose'), cv: v('.lt-cv'), statement: v('.lt-statement'),
      howWorked: v('[data-key="howWorked"]'), best: v('[data-key="best"]'), extra: v('[data-key="extra"]'),
      recipients: Array.prototype.map.call(f.querySelectorAll('.lt-rrow'), function(row){
        return { id: row.getAttribute('data-rid') || undefined, name: row.querySelector('.lt-rn').value.trim(), url: row.querySelector('.lt-ru').value.trim(),
          deadline: row.querySelector('.lt-rd').value, sentBy: row.querySelector('.lt-rs').value };
      }),
    };
  }

  function problem(d, isNew){
    if (isNew && !newForm.writer) return 'Choose your referee.';
    if (!d.purpose) return 'Say what the letter is for.';
    if (!d.recipients.length) return 'Add where the letter goes.';
    if (!/^https?:\/\/\S+$/.test(d.cv)) return 'Give a link to your CV, starting with https://.';
    if (!d.howWorked) return 'Say how you’ve worked together and what you did yourself.';
    if (d.statement && !/^https?:\/\/\S+$/.test(d.statement)) return 'The cover letter or statement link starts with https://.';
    for (var i = 0; i < d.recipients.length; i++) {
      var r = d.recipients[i];
      if (!r.name) return 'Give each recipient a name.';
      if (r.url && !/^https?:\/\/\S+$/.test(r.url)) return 'A link starts with https://: ' + r.name + '.';
    }
    return '';
  }

  function save(f, btn){
    var id = f.getAttribute('data-id'), d = readForm(f), err = f.querySelector('.ev-error');
    var p = problem(d, !id);
    if (p) { err.textContent = p; err.hidden = false; return; }
    if (!id && d.recipients.some(function(r){ return r.deadline && r.deadline < today(); }) && !window.confirm('A deadline has passed already. Ask anyway?')) return;
    btn.disabled = true; err.hidden = true;
    var data = Object.assign(d, id ? { action: 'update', id: id } : { action: 'create', writerEmail: newForm.writer.email });
    call(data).then(function(){ closeForm(); }).catch(function(e){
      console.error('[BOLD Letters] saving failed', e);
      err.textContent = e && e.message && e.code !== 'functions/internal' ? e.message : 'Couldn’t save — try again.';
      err.hidden = false; btn.disabled = false;
    });
  }

  function act(key, data, btn){
    busy[key] = true; btn.disabled = true;
    call(data).catch(function(e){
      console.error('[BOLD Letters] that failed', e);
      window.alert(e && e.message && e.code !== 'functions/internal' ? e.message : 'Couldn’t do that — try again.');
    }).then(function(){ delete busy[key]; render(); });
  }

  // A message about the form goes once it's changed.
  main.addEventListener('input', function(e){
    var err = e.target.closest('.lt-form') && e.target.closest('.lt-form').querySelector('.ev-error');
    if (err) err.hidden = true;
  });

  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var f = t.closest('.lt-form');
    if (t.classList.contains('lt-open')) { if (!editing) { var oid = t.getAttribute('data-id'); shown[oid] = !shown[oid]; render(); } return; }
    if (t.classList.contains('lt-ask')) { if (!editing) openForm('new'); return; }
    if (t.classList.contains('lt-edit')) { if (!editing) openForm(t.getAttribute('data-id')); return; }
    if (t.classList.contains('lt-cancel')) { closeForm(); return; }
    if (t.classList.contains('lt-save')) { save(f, t); return; }
    if (t.classList.contains('lt-radd')) { f.querySelector('.lt-rows').insertAdjacentHTML('beforeend', rowHtml(null)); f.querySelector('.lt-rrow:last-child .lt-rn').focus(); return; }
    if (t.classList.contains('lt-rremove')) {
      var row = t.closest('.lt-rrow');
      if (f.querySelectorAll('.lt-rrow').length > 1) row.parentNode.removeChild(row);
      return;
    }
    if (editing) return;
    var id = t.getAttribute('data-id'), rid = t.getAttribute('data-r');
    var q = (byMe || []).concat(ofMe || []).filter(function(x){ return x.id === id; })[0];
    if (!q) return;
    if (t.classList.contains('lt-ack')) act(id, { action: 'acknowledge', id: id }, t);
    else if (t.classList.contains('lt-withdraw')) {
      if (window.confirm('Withdraw your request to ' + q.writerName + '? It’s deleted, and they’re told on Slack.')) act(id, { action: 'withdraw', id: id }, t);
    } else if (t.classList.contains('lt-submit')) {
      var input = t.parentNode.querySelector('.lt-letter');
      var link = input ? input.value.trim() : '';
      if (input && !/^https?:\/\/\S+$/.test(link)) { window.alert('Give a link to the letter, starting with https://.'); input.focus(); return; }
      act(id + '/' + rid, { action: 'submit', id: id, recipientId: rid, letterUrl: link }, t);
    } else if (t.classList.contains('lt-unsubmit')) {
      if (window.confirm('Mark it not submitted again?')) act(id + '/' + rid, { action: 'unsubmit', id: id, recipientId: rid }, t);
    }
  });

  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: (user.email || '').toLowerCase() } : null;
    byMe = null; ofMe = null; editing = null;
    if (!user) return;
    render();
    var listen = function(field, set){
      unsubs.push(db.collection('letterRequests').where(field, '==', me.email).onSnapshot(function(snap){
        set(snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }));
        render();
      }, function(err){ console.error('[BOLD Letters] loading requests failed', err); set([]); render(); }));
    };
    listen('requesterEmail', function(v){ byMe = v; });
    listen('writerEmail', function(v){ ofMe = v; });
  });
})();
