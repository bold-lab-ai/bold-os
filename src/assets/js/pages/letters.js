// letters.html: recommendation letters (functions/index.js "Service desk").
// Anyone asks anyone in the lab for a letter; the writer gets a Slack message,
// acknowledges it, and marks each recipient submitted, or shares the letter
// where the requester sends it on. Every write is letterRequest; the page reads
// the requests asked by and of the viewer (letterRequests, theirs alone). Each request
// is one line (what it's for, who, how many letters are in); clicking it opens the rest.
// An applicant may name a first drafter (someone they worked with closely, such as the
// PhD student who supervised their project): they see the request on a third tab and
// send the draft here; the referee reads it on the request (letterDrafts, the two of
// them only), and the applicant sees only that it's in.
// What's typed and not sent yet is kept as a draft in this browser only (letter-drafts.js):
// saved as it's typed, and by "Save as draft". No draft reaches the server, so a request
// changes, and its people hear, only when its form is sent. The text boxes grow with their text.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('letters');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('letterRequest')(data); };
  var me = null, byMe = null, ofMe = null, forMe = null, writers = null, unsubs = [];
  // The first drafts the viewer may read (as referee or drafter): request id → draft.
  var drafts = {}, draftsAs = { writer: {}, drafter: {} };
  // The open form: null, 'new', or a request's id.
  var editing = null, busy = {};
  // The requests opened (clicked) to show their details: id → true.
  var shown = {};
  // The first drafts being typed (not sent yet): id → true.
  var typed = {};
  // The viewer's drafts in this browser (BoldLetterDrafts.store), null if it keeps none; the
  // open request form's draft: { kind: 'ask' | 'edit', id, base (the form as it'd open without
  // a draft, as JSON), opened (as it did open), was (the draft then), timer }; the first drafts
  // waiting to be saved: id → timer; and the requests with changes not saved yet: id → draft.
  var store = null, formDraft = null, firstTimers = {}, unsaved = {};
  var SAVE_AFTER = 600;
  var NO_STORE = 'This browser doesn’t let BOLD.OS keep a draft';
  var KEEP_TIP = 'Keep it in this browser to finish later. Nobody is told.';

  // When a draft was saved: the time if today, the day too before.
  function savedAt(t){
    var d = new Date(t), time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  // A text box as tall as its text (never shorter than its rows), so it's read without
  // scrolling inside it. One on a tab that isn't shown has no height to measure: showTab() does it.
  function grow(ta){
    if (!ta.offsetHeight) return;
    var y = window.scrollY;
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + ta.offsetHeight - ta.clientHeight) + 'px';
    if (window.scrollY !== y) window.scrollTo(window.scrollX, y);   // measuring it mustn't move the page
  }
  function growAll(){ Array.prototype.forEach.call(main.querySelectorAll('textarea.lt-grow'), grow); }

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
    var dr = drafts[q.id];
    if (q.drafterEmail && dr) {
      lines.push('', 'First draft, from ' + (q.drafterName || 'their first drafter') + ', who worked with the applicant (sent ' + when(dr.updatedAt || dr.at) +
        '). Build the letter on it, in the referee’s own voice:');
      if (dr.url) lines.push('Link: ' + dr.url);
      if (dr.note) lines.push('Their note: ' + dr.note);
      if (dr.text) lines.push('', dr.text);
    } else if (q.drafterEmail) {
      lines.push('', 'First draft: ' + (q.drafterName || 'someone') + ' is writing one; it isn’t in yet.');
    }
    return lines.join('\n');
  }

  // Collapsed: how many letters are in, and the next deadline (or that one is late).
  function summary(q){
    var rs = q.recipients || [], done = rs.filter(function(r){ return r.submittedAt; }).length;
    var next = nextDeadline(q), late = next !== '9999' && next < today();
    return '<span class="lt-sum">' + done + ' of ' + rs.length + ' in' +
      (done < rs.length && next !== '9999' ? ' · ' + (late ? '<span class="is-late">overdue since ' + day(next) + '</span>' : 'next due ' + day(next)) : '') +
      (q.drafterEmail ? ' · ' + (q.draftAt ? 'first draft in' : 'first draft not in yet') : '') + '</span>';
  }

  // The first draft, as each of the three sees it: the referee reads it, the drafter
  // writes it (the form, filled from what they sent), the applicant sees only whether it's in.
  function draftHtml(q, role){
    if (!q.drafterEmail) return '';
    var dr = drafts[q.id], name = esc(q.drafterName || q.drafterEmail);
    var head = '<span class="lt-label">First draft</span>';
    if (role === 'drafter' && (q.open !== false || !q.draftAt)) return head + (q.open === false ? '<p class="lt-draft-state">Every letter is in: no draft is needed now.</p>' : draftFormHtml(q, dr));
    var state = q.draftAt
      ? 'From ' + name + ' · <span class="is-ok">in ' + when(q.draftAt) + '</span>' + (dr && dr.updatedAt && dr.updatedAt !== dr.at ? ' · updated ' + when(dr.updatedAt) : '')
      : 'From ' + name + ' · not in yet';
    if (role !== 'writer' || !dr) return head + '<p class="lt-draft-state">' + state + '</p>';
    return head + '<p class="lt-draft-state">' + state + '</p><dl class="lt-materials">' +
      material('Link', dr.url && '<a href="' + esc(dr.url) + '" target="_blank" rel="noopener">Open the draft</a>') +
      material('Their note', dr.note && '<span class="lt-text">' + linkify(dr.note) + '</span>') + '</dl>' +
      (dr.text ? '<div class="lt-draft-text">' + linkify(dr.text) + '</div>' : '');
  }

  function draftFormHtml(q, dr){
    dr = dr || {};
    // What they typed and didn't send (kept in this browser) comes before what they sent.
    var mine = store ? store.get('first', q.id) : null;
    if (mine) dr = mine;
    var b = busy[q.id] ? ' disabled' : '';
    return '<div class="event-form lt-dform" data-id="' + esc(q.id) + '">' +
      '<p class="detail-muted">' + esc(first(q.requesterName)) + ' asked you to write a first draft for ' + esc(q.writerName) +
        '. Only ' + esc(first(q.writerName)) + ' and you read it; ' + esc(first(q.requesterName)) + ' sees only that it’s in.</p>' +
      '<label>The draft<textarea class="lt-dtext lt-grow no-tags" rows="12" maxlength="20000">' + esc(dr.text || '') + '</textarea></label>' +
      '<label>Or a link to it (optional)<input type="url" class="lt-durl" maxlength="1000" value="' + esc(dr.url || '') + '" placeholder="https://…"></label>' +
      '<label>A note for ' + esc(first(q.writerName)) + ' (optional)<textarea class="lt-dnote lt-grow no-tags" rows="3" maxlength="2000">' + esc(dr.note || '') + '</textarea></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save lt-dsave" data-id="' + esc(q.id) + '"' + b + '>' + (q.draftAt ? 'Update the draft' : 'Send the first draft') + '</button>' +
        '<button type="button" class="lt-dkeep" data-id="' + esc(q.id) + '"' + (store ? ' title="' + KEEP_TIP + '"' : ' disabled title="' + NO_STORE + '"') + '>Save without sending</button>' +
        '<button type="button" class="lt-ddiscard" data-id="' + esc(q.id) + '" title="Back to ' + (q.draftAt ? 'the draft you sent' : 'an empty draft') + '"' + (mine ? '' : ' hidden') + '>Discard</button>' +
        (q.draftAt ? '<span class="detail-muted">Sent ' + when(q.draftAt) + '</span>' : '') +
        '<span class="lt-saved" role="status">' + (mine ? 'Saved ' + savedAt(mine.at) + ' · not sent' : '') + '</span></div></div>';
  }

  // role: 'writer' (As referee), 'requester' (As applicant) or 'drafter' (As first drafter).
  function requestHtml(q, role){
    var asWriter = role === 'writer', asDrafter = role === 'drafter';
    var ack = q.acknowledgedAt ? '<span class="is-ok">Received ' + when(q.acknowledgedAt) + '</span>' : 'Not acknowledged yet';
    var meta = asWriter
      ? 'Applicant: ' + esc(q.requesterName) + ' · asked ' + when(q.at) + (q.acknowledgedAt ? '' : ' · not acknowledged yet')
      : asDrafter
        ? 'Applicant: ' + esc(q.requesterName) + ' · referee: ' + esc(q.writerName) + ' · asked ' + when(q.at)
        : 'Referee: ' + esc(q.writerName) + ' · asked ' + when(q.at) + ' · ' + ack;
    var b = busy[q.id] ? ' disabled' : '';
    var controls = asWriter
      ? (q.acknowledgedAt ? '' : '<button type="button" class="btn-text lt-ack" data-id="' + esc(q.id) + '"' + b + '>Got it</button>')
      : asDrafter ? ''
      : '<button type="button" class="btn-text lt-edit" data-id="' + esc(q.id) + '"' + b + '>Edit</button>' +
        '<button type="button" class="btn-text danger lt-withdraw" data-id="' + esc(q.id) + '"' + b + '>Withdraw</button>';
    var open = !!shown[q.id] || editing === q.id;
    // The applicant's changes to it, kept as a draft in this browser.
    var mine = role === 'requester' ? unsaved[q.id] : null;
    var head = '<button type="button" class="lt-title lt-open" data-id="' + esc(q.id) + '" aria-expanded="' + open + '">' + esc(q.purpose) + '</button>' +
      '<span class="lt-meta">' + meta + ' · ' + summary(q) + (mine ? ' · changes not saved yet' : '') + '</span>';
    if (!open) return '<li class="lt-item" id="l-' + esc(q.id) + '">' + head + '</li>';
    return '<li class="lt-item is-open" id="l-' + esc(q.id) + '">' + head +
      '<span class="lt-label">Where it goes</span><ul class="lt-recipients">' +
        (q.recipients || []).map(function(r){ return recipientHtml(q, r, asWriter); }).join('') + '</ul>' +
      '<span class="lt-label">Materials</span><dl class="lt-materials">' +
        material('CV', q.cv && '<a href="' + esc(q.cv) + '" target="_blank" rel="noopener">Open</a>') +
        material('Cover letter or research statement', q.statement && '<a href="' + esc(q.statement) + '" target="_blank" rel="noopener">Open</a>') +
        WORK.map(function(w){ return material(w.short, q[w.key] && '<span class="lt-text">' + linkify(q[w.key]) + '</span>'); }).join('') + '</dl>' +
      draftHtml(q, role) +
      (asWriter && q.open !== false ? '<span class="lt-label">For your agent</span><div class="lt-agent">' +
        '<p class="detail-muted">Paste it into Claude Code to draft the letter with the <a href="skill.html?skill=' + SKILL + '">' + SKILL + '</a> skill.</p>' +
        BOLD.copyBoxHtml(agentPrompt(q)) + '</div>' : '') +
      (mine ? '<p class="lt-draft-state lt-unsaved">Your changes from ' + savedAt(mine.at) + ' aren’t saved yet: they’re kept in this browser. ' +
        '<button type="button" class="btn-text lt-edit" data-id="' + esc(q.id) + '"' + b + '>Continue editing</button> ' +
        '<button type="button" class="btn-text danger lt-drop" data-kind="edit" data-id="' + esc(q.id) + '">Discard them</button></p>' : '') +
      (controls ? '<div class="event-controls">' + controls + '</div>' : '') +
      (editing === q.id ? formHtml(q) : '') + '</li>';
  }

  // A request not asked yet, kept as a draft in this browser: one line, as a request is.
  function askDraftHtml(d){
    var id = esc(d.id);
    return '<li class="lt-item lt-draft" data-did="' + id + '">' +
      '<button type="button" class="lt-title lt-open lt-resume" data-did="' + id + '">' + esc(String(d.purpose || '').trim() || 'Untitled request') + '</button>' +
      '<span class="lt-meta"><span class="lt-status">Draft</span>Not asked yet' + (d.writer ? ' · referee: ' + esc(d.writer.name) : '') +
        ' · saved ' + savedAt(d.at) + ' · kept in this browser</span>' +
      '<div class="event-controls"><button type="button" class="btn-text lt-resume" data-did="' + id + '">Continue</button>' +
        '<button type="button" class="btn-text danger lt-drop" data-kind="ask" data-id="' + id + '">Discard</button></div></li>';
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

  // The form, empty (asking) or filled from q (editing); d: a draft of it, shown instead.
  function formHtml(q, d){
    var v = d || q || {};
    var rows = d ? BoldLetterDrafts.rows(d.recipients, q ? q.recipients : []) : q ? q.recipients : null;
    var who = q
      ? '<label>Referee<span class="spk-chosen">' + esc(q.writerName) + '</span></label>'
      : '<label>Referee</label><div class="lt-who"></div>';
    return '<div class="event-form lt-form" data-id="' + esc(q ? q.id : '') + '">' + who +
      '<label>What it’s for<input type="text" class="lt-purpose" maxlength="300" value="' + esc(v.purpose || '') + '" placeholder="e.g. PhD applications, Fall 2027"></label>' +
      '<fieldset><legend>Where it goes</legend><div class="lt-rows">' +
        (rows || [null]).map(rowHtml).join('') + '</div>' +
        '<button type="button" class="btn-text lt-radd">+ Add a recipient</button></fieldset>' +
      '<fieldset><legend>Materials for the referee</legend>' +
        '<label>CV (link)<input type="url" class="lt-cv" maxlength="1000" value="' + esc(v.cv || '') + '" placeholder="https://…"></label>' +
        '<label>Cover letter or research statement (link, optional)<input type="url" class="lt-statement" maxlength="1000" value="' + esc(v.statement || '') + '" placeholder="https://…"></label>' +
      '</fieldset>' +
      '<fieldset><legend>About your work with me</legend>' + WORK.map(function(w){
        return '<label>' + esc(w.q) + '<textarea class="lt-w lt-grow no-tags" data-key="' + w.key + '" rows="' + (w.key === 'howWorked' ? 7 : 4) + '" maxlength="' + (w.key === 'howWorked' ? 6000 : 3000) + '">' + esc(v[w.key] || '') + '</textarea></label>';
      }).join('') + '</fieldset>' +
      '<fieldset><legend>First draft (optional)</legend>' +
        '<p class="detail-muted lt-hint">If someone you worked with closely, such as the PhD student who supervised your project, will write a first draft for your referee, choose them. They see this request and send the draft here; you see only when it’s in.</p>' +
        (q && q.draftAt
          ? '<label>First drafter<span class="spk-chosen">' + esc(q.drafterName || q.drafterEmail) + ' <span class="detail-muted">their draft is in, so this can’t change</span></span></label>'
          : '<label>First drafter</label><div class="lt-drafter"></div>') +
      '</fieldset>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save lt-save">' + (q ? 'Save' : 'Ask for the letter') + '</button>' +
        '<button type="button" class="lt-keep"' + (store ? ' title="' + KEEP_TIP + '"' : ' disabled title="' + NO_STORE + '"') + '>Save as draft</button>' +
        '<button type="button" class="lt-cancel">Cancel</button>' +
        '<span class="lt-saved" role="status"></span></div></div>';
  }

  function render(){
    if (!me) return;
    if (byMe === null || ofMe === null || forMe === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) return; // don't redraw over a form being filled in
    var openOf = ofMe.filter(function(q){ return q.open; }).length, openBy = byMe.filter(function(q){ return q.open; }).length;
    var openFor = forMe.filter(function(q){ return q.open && !q.draftAt; }).length;
    // The drafts kept in this browser: requests not asked yet, and changes not saved yet.
    var asks = store ? store.list('ask') : [];
    unsaved = {};
    if (store) store.list('edit').forEach(function(d){ unsaved[d.id] = d; });
    // A draft being written survives the redraw (a snapshot can come in while it's typed).
    var kept = {}, focus = document.activeElement && document.activeElement.closest && document.activeElement.closest('.lt-dform') ? document.activeElement : null;
    Array.prototype.forEach.call(main.querySelectorAll('.lt-dform'), function(f){
      var id = f.getAttribute('data-id');
      if (typed[id]) kept[id] = { text: f.querySelector('.lt-dtext').value, url: f.querySelector('.lt-durl').value, note: f.querySelector('.lt-dnote').value };
    });
    var focusSel = focus ? { id: focus.closest('.lt-dform').getAttribute('data-id'), cls: focus.className.split(' ')[0], at: focus.selectionStart } : null;
    // Tabs, named by the #hash: as referee, as applicant (with how many are open) and, once
    // someone has asked you for one, as first drafter (with how many drafts are still to send).
    main.innerHTML =
      '<nav class="guide-tabs lt-tabs" id="ltTabs" aria-label="Letters">' +
        '<a class="guide-tab" href="#referee">As referee' + (openOf ? ' (' + openOf + ')' : '') + '</a>' +
        '<a class="guide-tab" href="#applicant">As applicant' + (openBy ? ' (' + openBy + ')' : '') + '</a>' +
        (forMe.length ? '<a class="guide-tab" href="#drafter">As first drafter' + (openFor ? ' (' + openFor + ')' : '') + '</a>' : '') + '</nav>' +
      '<section class="lt-panel" id="referee">' +
        (ofMe.length ? '<ul class="lt-list">' + sorted(ofMe).map(function(q){ return requestHtml(q, 'writer'); }).join('') + '</ul>' : '<p class="proj-msg">Nobody has asked you for a letter.</p>') + '</section>' +
      '<section class="lt-panel" id="applicant">' +
        (byMe.length ? '<ul class="lt-list">' + sorted(byMe).map(function(q){ return requestHtml(q, 'requester'); }).join('') + '</ul>' : '<p class="proj-msg">You haven’t asked for a letter yet.</p>') +
        (asks.length ? '<ul class="lt-list lt-drafts">' + asks.map(askDraftHtml).join('') + '</ul>' : '') +
        '<div class="lt-new"><button type="button" class="event-add lt-ask">+ Ask for a letter</button></div></section>' +
      (forMe.length ? '<section class="lt-panel" id="drafter">' +
        '<ul class="lt-list">' + sorted(forMe).map(function(q){ return requestHtml(q, 'drafter'); }).join('') + '</ul></section>' : '');
    Object.keys(kept).forEach(function(id){
      var f = main.querySelector('.lt-dform[data-id="' + id + '"]');
      if (!f) return;
      f.querySelector('.lt-dtext').value = kept[id].text; f.querySelector('.lt-durl').value = kept[id].url; f.querySelector('.lt-dnote').value = kept[id].note;
    });
    if (focusSel) {
      var el = main.querySelector('.lt-dform[data-id="' + focusSel.id + '"] .' + focusSel.cls);
      if (el) { el.focus(); try { el.setSelectionRange(focusSel.at, focusSel.at); } catch (e){} }
    }
    // letters.html#ask (the masthead's + menu) opens the form, on As applicant.
    var ask = BOLD.takeLinkAction('ask', '#applicant');
    showTab();
    if (ask) { openForm('new'); return; }
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
    var has = function(list){ return list.some(function(q){ return q.id === m[1]; }); };
    if (h === '#referee' || h === '#applicant' || (h === '#drafter' && forMe.length)) want = h.slice(1);
    else if (m) want = has(ofMe) ? 'referee' : has(byMe) ? 'applicant' : has(forMe) ? 'drafter' : 'applicant';
    else want = ofMe.length ? 'referee' : forMe.some(function(q){ return q.open && !q.draftAt; }) ? 'drafter' : 'applicant';
    ['referee', 'applicant', 'drafter'].forEach(function(t){ var el = document.getElementById(t); if (el) el.hidden = t !== want; });
    Array.prototype.forEach.call(tabs.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    growAll();   // the text boxes on the tab now shown
  }
  window.addEventListener('hashchange', function(){ if (byMe && ofMe && forMe) { if (location.hash === '#ask') render(); else showTab(); } });
  window.addEventListener('resize', growAll);   // a narrower box wraps its text onto more lines

  // ---------- choosing the writer: a list of the BOLD.OS users, filtered by typing ----------
  // key: 'writer' (the referee) or 'drafter' (the first drafter, optional: it can be removed).
  function mountWho(wrap, form, key){
    key = key || 'writer';
    var other = key === 'writer' ? 'drafter' : 'writer';
    var chosen = form[key];
    if (chosen) {
      wrap.innerHTML = '<span class="spk-chosen">' + esc(chosen.name) + ' <span class="detail-muted">' + esc(chosen.email) + '</span>' +
        '<button type="button" class="btn-text lt-who-change">Change</button>' +
        (key === 'drafter' ? '<button type="button" class="btn-text danger lt-who-remove">Remove</button>' : '') + '</span>';
      wrap.querySelector('.lt-who-change').addEventListener('click', function(){ form[key] = null; mountWho(wrap, form, key); wrap.querySelector('input').focus(); touch(); });
      var rm = wrap.querySelector('.lt-who-remove');
      if (rm) rm.addEventListener('click', function(){ form[key] = null; mountWho(wrap, form, key); touch(); });
      return;
    }
    wrap.innerHTML = '<div class="spk-search"><input type="text" class="lt-who-q" placeholder="' + (key === 'drafter' ? 'Nobody; or choose, or type a name…' : 'Choose, or type a name…') +
      '" autocomplete="off" role="combobox" aria-expanded="false" aria-label="' + (key === 'drafter' ? 'First drafter' : 'Referee') + '">' +
      '<ul class="spk-results" role="listbox" hidden></ul></div>';
    var input = wrap.querySelector('input'), list = wrap.querySelector('ul'), found = [], active = 0;
    var fold = function(s){ return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); };
    function pick(k){ if (!found[k]) return; form[key] = { name: found[k].name || found[k].email, email: found[k].email }; mountWho(wrap, form, key); touch(); }
    function show(){
      var words = fold(input.value).split(/\s+/).filter(Boolean);
      var not = form[other] && form[other].email;
      found = (writers || []).filter(function(p){
        var hay = fold(p.name) + ' ' + fold(p.email);
        return p.email !== me.email && p.email !== not && words.every(function(w){ return hay.indexOf(w) >= 0; });
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

  // The open form's people: { writer, drafter, was } (was: the drafter's email before editing).
  var newForm = null;

  function loadWriters(){
    if (writers) return;
    firebase.app().functions('europe-west2').httpsCallable('letterWriters')().then(function(r){
      writers = (r.data && r.data.writers) || [];
      var q = document.activeElement;
      if (q && q.classList.contains('lt-who-q')) q.dispatchEvent(new Event('input'));
    }).catch(function(err){ console.error('[BOLD Letters] loading the BOLD.OS users failed', err); writers = []; });
  }

  // did: the draft to go on with (a request not asked yet). A request being edited opens with
  // its changes not saved yet, if this browser kept any.
  function openForm(id, did){
    editing = id;
    if (id === 'new') {
      var d = did && store ? store.get('ask', did) : null;
      newForm = { writer: (d && d.writer) || null, drafter: (d && d.drafter) || null, was: '' };
      var wrap = main.querySelector('.lt-new');
      wrap.innerHTML = formHtml(null, d);
      var line = d && main.querySelector('.lt-draft[data-did="' + did + '"]');
      if (line) line.hidden = true;   // it's the form now
      mountWho(wrap.querySelector('.lt-who'), newForm, 'writer');
      mountWho(wrap.querySelector('.lt-drafter'), newForm, 'drafter');
      loadWriters();
      startDraft('ask', d ? did : newId(), null, { writer: null, drafter: null }, d);
      wrap.querySelector(d ? '.lt-purpose' : '.lt-who-q').focus();
      return;
    }
    var q = byMe.filter(function(x){ return x.id === id; })[0], li = document.getElementById('l-' + id);
    if (!q || !li) { editing = null; return; }
    var e = store ? store.get('edit', id) : null;
    var asIs = { writer: { name: q.writerName, email: q.writerEmail },
      drafter: q.drafterEmail ? { name: q.drafterName || q.drafterEmail, email: q.drafterEmail } : null };
    // Who drafts it can't change once the draft is in, whatever was chosen before.
    newForm = { writer: asIs.writer, drafter: e && !q.draftAt ? e.drafter || null : asIs.drafter, was: q.drafterEmail || '' };
    li.insertAdjacentHTML('beforeend', formHtml(q, e));
    var note = li.querySelector('.lt-unsaved');
    if (note) note.hidden = true;   // they're in the form now
    var dw = li.querySelector('.lt-drafter');
    if (dw) { mountWho(dw, newForm, 'drafter'); loadWriters(); }
    startDraft('edit', id, q, asIs, e);
    li.querySelector('.lt-purpose').focus();
  }

  function closeForm(){
    if (formDraft) clearTimeout(formDraft.timer);
    editing = null; newForm = null; formDraft = null; render();
  }

  // The form's fields; raw: as typed (for a draft), else trimmed (to send).
  function fields(f, raw){
    var v = function(el){ return raw ? el.value : el.value.trim(); }, at = function(c){ return v(f.querySelector(c)); };
    return {
      purpose: at('.lt-purpose'), cv: at('.lt-cv'), statement: at('.lt-statement'),
      howWorked: at('[data-key="howWorked"]'), best: at('[data-key="best"]'), extra: at('[data-key="extra"]'),
      recipients: Array.prototype.map.call(f.querySelectorAll('.lt-rrow'), function(row){
        return { id: row.getAttribute('data-rid') || undefined, name: v(row.querySelector('.lt-rn')), url: v(row.querySelector('.lt-ru')),
          deadline: row.querySelector('.lt-rd').value, sentBy: row.querySelector('.lt-rs').value };
      }),
    };
  }

  function readForm(f){
    var d = fields(f);
    d.drafterEmail = newForm && newForm.drafter ? newForm.drafter.email : '';
    return d;
  }

  // ---------- drafts, kept in this browser (letter-drafts.js) ----------
  function newId(){ return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // A request form as a draft: what's typed, as typed, and who was chosen.
  function snap(f, people){
    var d = fields(f, true);
    d.writer = people.writer || null; d.drafter = people.drafter || null;
    return d;
  }
  function saved(text, f){
    var el = f && f.querySelector('.lt-saved');
    if (el) el.textContent = text;
  }

  // The open form's draft. base: the form as it'd open without one (empty, or the request as
  // it is), so a draft that says nothing new isn't kept; opened: as it did open, for Cancel.
  function startDraft(kind, id, q, asIs, was){
    var blank = document.createElement('div');
    blank.innerHTML = formHtml(q, null);
    var f = main.querySelector('.lt-form');
    formDraft = { kind: kind, id: id, base: JSON.stringify(snap(blank.querySelector('.lt-form'), asIs)),
      opened: JSON.stringify(snap(f, newForm)), was: was || null, timer: null };
    growAll();
    if (was) saved(kind === 'edit' ? 'Your changes from ' + savedAt(was.at) + ', not saved yet' : 'Draft saved ' + savedAt(was.at), f);
  }

  // Keeps the open form as a draft now. → false only if the browser refused it.
  function keepForm(){
    if (!formDraft) return true;
    clearTimeout(formDraft.timer); formDraft.timer = null;
    var f = main.querySelector('.lt-form');
    if (!f || !store) return false;
    var d = snap(f, newForm);
    if (JSON.stringify(d) === formDraft.base) { store.drop(formDraft.kind, formDraft.id); saved('', f); return true; }
    var at = store.put(formDraft.kind, formDraft.id, d);
    saved(at ? (formDraft.kind === 'edit' ? 'Changes saved as a draft ' : 'Draft saved ') + savedAt(at) : 'Couldn’t save a draft: this browser’s storage is full', f);
    return !!at;
  }
  // A change to the open form: it's saved as a draft once the typing pauses.
  function touch(){
    if (!formDraft || !store) return;
    clearTimeout(formDraft.timer);
    formDraft.timer = setTimeout(keepForm, SAVE_AFTER);
  }

  // Cancel undoes what was typed since the form opened (after asking): a draft it opened from
  // stays as it was; the draft's own Discard deletes it.
  function cancelForm(){
    var f = main.querySelector('.lt-form');
    if (formDraft && f && JSON.stringify(snap(f, newForm)) !== formDraft.opened) {
      if (!window.confirm('Discard what you’ve typed?' + (store ? ' To keep it for later, choose “Save as draft”.' : ''))) return;
      clearTimeout(formDraft.timer); formDraft.timer = null;
      if (store && formDraft.was) store.put(formDraft.kind, formDraft.id, formDraft.was, formDraft.was.at);
      else if (store) store.drop(formDraft.kind, formDraft.id);
    }
    closeForm();
  }

  // The same for a first draft being typed: saved once the typing pauses, unless it's what was sent.
  function keepFirst(id){
    clearTimeout(firstTimers[id]); delete firstTimers[id];
    var f = main.querySelector('.lt-dform[data-id="' + id + '"]');
    if (!f || !store) return false;
    var d = { text: f.querySelector('.lt-dtext').value, url: f.querySelector('.lt-durl').value, note: f.querySelector('.lt-dnote').value };
    var discard = f.querySelector('.lt-ddiscard');
    if (BoldLetterDrafts.sameFirst(d, drafts[id])) { store.drop('first', id); saved('', f); discard.hidden = true; return true; }
    var at = store.put('first', id, d);
    saved(at ? 'Saved ' + savedAt(at) + ' · not sent' : 'Couldn’t save it: this browser’s storage is full', f);
    discard.hidden = !at;
    return !!at;
  }
  function touchFirst(id){
    if (!store) return;
    clearTimeout(firstTimers[id]);
    firstTimers[id] = setTimeout(function(){ keepFirst(id); }, SAVE_AFTER);
  }
  function forgetFirst(id){
    clearTimeout(firstTimers[id]); delete firstTimers[id]; delete typed[id];
    if (store) store.drop('first', id);
  }

  // What's waiting to be saved is saved before the page goes (closed, reloaded, left).
  function flush(){
    if (formDraft && formDraft.timer) keepForm();
    Object.keys(firstTimers).forEach(keepFirst);
  }
  document.addEventListener('visibilitychange', function(){ if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

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
    var dr = newForm.drafter, changed = (dr ? dr.email : '') !== newForm.was;
    if (id && !changed) return send(f, btn, id, d, err);
    if (id) {
      var was = (byMe.filter(function(x){ return x.id === id; })[0] || {}).drafterName || 'your first drafter';
      BOLD.confirmAction({ title: dr ? 'Ask ' + dr.name + ' for the first draft?' : 'Nobody writes a first draft?', go: 'Save',
        effects: ['Send ' + newForm.writer.name + ' a Slack message from BOLD.OS that you updated your request']
          .concat(dr ? ['Send ' + dr.name + ' a Slack message asking for a first draft, and let them see this request'] : [])
          .concat(newForm.was ? ['Tell ' + was + ' on Slack that their draft isn’t needed, and stop them seeing this request'] : []) })
        .then(function(ok){ if (ok) send(f, btn, id, d, err); });
      return;
    }
    var late = d.recipients.some(function(r){ return r.deadline && r.deadline < today(); });
    BOLD.confirmAction({ title: late ? 'A deadline has passed already. Ask anyway?' : 'Ask ' + newForm.writer.name + ' for the letter?', go: 'Ask',
      effects: ['Send ' + newForm.writer.name + ' a Slack message from BOLD.OS with your request']
        .concat(dr ? ['Send ' + dr.name + ' a Slack message asking for a first draft, and let them see this request'] : []) })
      .then(function(ok){ if (ok) send(f, btn, id, d, err); });
  }
  function send(f, btn, id, d, err){
    btn.disabled = true; err.hidden = true;
    var data = Object.assign(d, id ? { action: 'update', id: id } : { action: 'create', writerEmail: newForm.writer.email });
    call(data).then(function(){
      if (formDraft && store) store.drop(formDraft.kind, formDraft.id);   // sent: no draft of it is left
      closeForm();
    }).catch(function(e){
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
    var f = e.target.closest('.lt-form, .lt-dform'), err = f && f.querySelector('.ev-error');
    if (err) err.hidden = true;
    if (f && f.classList.contains('lt-dform')) { typed[f.getAttribute('data-id')] = true; touchFirst(f.getAttribute('data-id')); }
    else if (f) touch();
    if (e.target.classList.contains('lt-grow')) grow(e.target);
  });
  main.addEventListener('change', function(e){ if (e.target.closest('.lt-form')) touch(); });

  function sendDraft(f, btn){
    var id = f.getAttribute('data-id'), err = f.querySelector('.ev-error');
    var q = (forMe || []).filter(function(x){ return x.id === id; })[0];
    if (!q) return;
    var d = { action: 'draft', id: id, text: f.querySelector('.lt-dtext').value.trim(), url: f.querySelector('.lt-durl').value.trim(), note: f.querySelector('.lt-dnote').value.trim() };
    if (!d.text && !d.url) { err.textContent = 'Paste the draft, or give a link to it.'; err.hidden = false; return; }
    if (d.url && !/^https?:\/\/\S+$/.test(d.url)) { err.textContent = 'The link to the draft starts with https://.'; err.hidden = false; return; }
    BOLD.confirmAction({ title: q.draftAt ? 'Update the first draft?' : 'Send ' + q.writerName + ' the first draft?', go: q.draftAt ? 'Update' : 'Send',
      effects: ['Send ' + q.writerName + ' a Slack message from BOLD.OS that the ' + (q.draftAt ? 'draft was updated' : 'first draft is in')]
        .concat(q.draftAt ? [] : ['Tell ' + q.requesterName + ' on Slack that their referee has it (not what it says)']) }).then(function(ok){
      if (!ok) return;
      btn.disabled = true; err.hidden = true;
      call(d).then(function(){ forgetFirst(id); render(); }).catch(function(e){
        console.error('[BOLD Letters] sending the draft failed', e);
        err.textContent = e && e.message && e.code !== 'functions/internal' ? e.message : 'Couldn’t send it — try again.';
        err.hidden = false; btn.disabled = false;
      });
    });
  }

  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var f = t.closest('.lt-form');
    if (t.classList.contains('lt-resume')) { if (!editing) openForm('new', t.getAttribute('data-did')); return; }
    if (t.classList.contains('lt-drop')) {
      var kind = t.getAttribute('data-kind');
      if (!editing && store && window.confirm(kind === 'edit' ? 'Discard your changes? The request stays as it is.' : 'Discard this draft? It’s deleted from this browser.')) {
        store.drop(kind, t.getAttribute('data-id')); render();
      }
      return;
    }
    if (t.classList.contains('lt-keep')) { if (keepForm()) closeForm(); return; }
    if (t.classList.contains('lt-dkeep')) { keepFirst(t.getAttribute('data-id')); return; }
    if (t.classList.contains('lt-ddiscard')) {
      var did = t.getAttribute('data-id'), sent = drafts[did] || {}, df = t.closest('.lt-dform');
      if (!window.confirm(drafts[did] ? 'Discard what you haven’t sent? The draft you sent stays as it is.' : 'Discard what you’ve typed?')) return;
      forgetFirst(did);
      df.querySelector('.lt-dtext').value = sent.text || ''; df.querySelector('.lt-durl').value = sent.url || ''; df.querySelector('.lt-dnote').value = sent.note || '';
      saved('', df); t.hidden = true; growAll();
      return;
    }
    if (t.classList.contains('lt-open')) { if (!editing) { var oid = t.getAttribute('data-id'); shown[oid] = !shown[oid]; render(); } return; }
    if (t.classList.contains('lt-ask')) { if (!editing) openForm('new'); return; }
    if (t.classList.contains('lt-edit')) { if (!editing) openForm(t.getAttribute('data-id')); return; }
    if (t.classList.contains('lt-cancel')) { cancelForm(); return; }
    if (t.classList.contains('lt-save')) { save(f, t); return; }
    if (t.classList.contains('lt-dsave')) { sendDraft(t.closest('.lt-dform'), t); return; }
    if (t.classList.contains('lt-radd')) { f.querySelector('.lt-rows').insertAdjacentHTML('beforeend', rowHtml(null)); f.querySelector('.lt-rrow:last-child .lt-rn').focus(); touch(); return; }
    if (t.classList.contains('lt-rremove')) {
      var row = t.closest('.lt-rrow');
      if (f.querySelectorAll('.lt-rrow').length > 1) { row.parentNode.removeChild(row); touch(); }
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
    flush();   // whoever was signed in keeps what they were typing
    if (formDraft) clearTimeout(formDraft.timer);
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: (user.email || '').toLowerCase() } : null;
    byMe = null; ofMe = null; forMe = null; editing = null; drafts = {}; draftsAs = { writer: {}, drafter: {} };
    store = null; formDraft = null; unsaved = {};
    if (!user) return;
    // Each account's drafts are its own; a browser that refuses storage keeps none.
    try { store = BoldLetterDrafts.store(window.localStorage, user.uid); } catch (e){ store = null; }
    render();
    // gone: the kind of draft to drop once the server says its request is no longer here.
    var listen = function(field, set, gone){
      unsubs.push(db.collection('letterRequests').where(field, '==', me.email).onSnapshot(function(snap){
        var list = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        set(list);
        if (gone && store && snap.metadata && snap.metadata.fromCache === false) store.prune(gone, list.map(function(q){ return q.id; }));
        render();
      }, function(err){ console.error('[BOLD Letters] loading requests failed', err); set([]); render(); }));
    };
    listen('requesterEmail', function(v){ byMe = v; }, 'edit');
    listen('writerEmail', function(v){ ofMe = v; });
    listen('drafterEmail', function(v){ forMe = v; }, 'first');
    // The first drafts: those sent to the viewer as referee, and those they wrote.
    ['writer', 'drafter'].forEach(function(as){
      unsubs.push(db.collection('letterDrafts').where(as + 'Email', '==', me.email).onSnapshot(function(snap){
        var got = {};
        snap.docs.forEach(function(d){ got[d.id] = d.data(); });
        draftsAs[as] = got;
        drafts = Object.assign({}, draftsAs.drafter, draftsAs.writer);
        render();
      }, function(err){ console.error('[BOLD Letters] loading first drafts failed', err); }));
    });
  });
})();
