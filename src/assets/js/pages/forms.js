(function(){
  var root = document.getElementById('forms'), esc = BOLD.escapeHtml, data, people = [], draft, user, busy = false;
  if (!root || !BOLD.getAuth()) return;
  var id = new URLSearchParams(location.search).get('id'), creating = new URLSearchParams(location.search).has('new');
  function call(d){ return BOLD.getApp().functions('europe-west2').httpsCallable('forms')(d).then(function(r){ return r.data; }); }
  function button(a, text, disabled){ return '<button type="button" class="btn-text" data-action="' + a + '"' + (disabled ? ' disabled title="' + esc(disabled) + '"' : '') + '>' + text + '</button>'; }
  function names(emails){ return emails.map(function(e){ var p = people.filter(function(p){ return p.email === e; })[0]; return p ? p.name : e; }).join(', '); }
  function options(list, selected){ return list.map(function(p){ return '<option value="' + esc(p.email) + '"' + (selected.indexOf(p.email) !== -1 ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join(''); }
  function empty(){ return { title: '', description: '', owners: [user.email.toLowerCase()], targetEmails: [], targetGroups: [], reminders: false, notifyOwners: false, questions: [{ id: 'q1', label: '', type: 'text', required: false, options: [] }] }; }
  function questionEditor(q, i){
    return '<fieldset class="fm-question" data-qid="' + esc(q.id) + '"><legend>Question ' + (i + 1) + '</legend>' +
      '<label>Question<input class="fm-label" type="text" value="' + esc(q.label) + '" maxlength="500"></label>' +
      '<label>Answer type<select class="fm-type">' + [['text','Text'],['choice','Single choice'],['scale','Scale (1–5)']].map(function(t){ return '<option value="' + t[0] + '"' + (q.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></label>' +
      '<label>Choice options (one per line; used for single choice)<textarea class="fm-options no-tags">' + esc(q.options.join('\n')) + '</textarea></label>' +
      '<label><input class="fm-required" type="checkbox"' + (q.required ? ' checked' : '') + '> Required</label>' + button('removeQuestion', 'Remove question') + '</fieldset>';
  }
  function editor(){
    return '<section><h2>' + (id ? 'Edit draft' : 'New form') + '</h2><label>Title<input id="fmTitle" type="text" maxlength="160" value="' + esc(draft.title) + '"></label>' +
      '<label>Description<textarea id="fmDescription" class="no-tags">' + esc(draft.description) + '</textarea></label>' +
      '<label>Owners (can edit and read all responses)<select id="fmOwners" multiple>' + options(people, draft.owners) + '</select></label>' +
      '<label>Individual recipients<select id="fmTargets" multiple>' + options(people, draft.targetEmails) + '</select></label><p>Hold Ctrl or Command to select several people.</p>' +
      '<fieldset><legend>Recipient groups</legend>' + [['pan','PAN-BOLD'],['associate','BOLD-associate'],['internal','BOLD-internal'],['staff','BOLD-staff'],['exec','BOLD-exec']].map(function(g){ return '<label><input class="fm-group" type="checkbox" value="' + g[0] + '"' + (draft.targetGroups.indexOf(g[0]) !== -1 ? ' checked' : '') + '> ' + g[1] + '</label>'; }).join('') +
      '<p>Groups are exact categories. Recipients are fixed when you publish.</p></fieldset>' +
      '<label><input id="fmReminders" type="checkbox"' + (draft.reminders ? ' checked' : '') + '> Send weekly BOLD.OS inbox reminders to people who have not responded, starting seven days after publication.</label>' +
      '<label><input id="fmOwnerDigest" type="checkbox"' + (draft.notifyOwners ? ' checked' : '') + '> Notify all owners in BOLD.OS at most once a day when new responses arrive.</label>' +
      draft.questions.map(questionEditor).join('') + button('addQuestion', 'Add question') + button('save', 'Save draft') + '</section>';
  }
  function question(q){
    var label = esc(q.label) + (q.required ? ' (required)' : ' (optional)');
    return '<label>' + label + (q.type === 'text' ? '<textarea class="fm-input no-tags" data-q="' + esc(q.id) + '"></textarea>' :
      '<select class="fm-input" data-q="' + esc(q.id) + '"><option value="">Choose…</option>' + (q.type === 'scale' ? ['1','2','3','4','5'] : q.options).map(function(v){ return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('') + '</select>') + '</label>';
  }
  function results(){
    return '<section><h2>Responses (' + data.form.responseCount + ')</h2><p>Completion records and individual submission times are not shown to owners.</p>' +
      (data.responses || []).map(function(r){ return '<article class="fm-response"><h3>' + (r.identity ? esc(r.identity.name || r.identity.email) + ' · ' + esc(r.identity.email) : 'Anonymous response') + '</h3>' +
        data.form.questions.map(function(q){ return '<p><strong>' + esc(q.label) + '</strong></p><p class="fm-answer">' + esc(r.answers[q.id] || 'No answer') + '</p>'; }).join('') + '</article>'; }).join('') + '</section>';
  }
  function render(){
    var allowed = BOLD.can('forms', 'edit'), reason = allowed ? '' : BOLD.cannotReason('forms', 'edit');
    var html = '<p id="fmError" role="alert" hidden></p><p><a href="forms.html">All forms</a></p>';
    if (!id && !creating) html += (allowed ? '<p><a class="btn-text" href="forms.html?new">Create form</a></p>' : button('new', 'Create form', reason)) +
      '<ul>' + data.forms.map(function(f){ return '<li><a href="forms.html?id=' + encodeURIComponent(f.id) + '">' + esc(f.title) + '</a> · ' + esc(f.status) + (f.owner ? ' · owner' : '') + '</li>'; }).join('') + '</ul>';
    else if (creating || data.form.status === 'draft' && data.owner) {
      html += editor();
      if (id) html += button('publish', 'Publish saved draft', reason);
    } else {
      var f = data.form;
      html += '<h2>' + esc(f.title) + '</h2><p class="fm-answer">' + esc(f.description) + '</p><p>Status: ' + esc(f.status) + '</p>' +
        '<p class="fm-privacy">Answers are anonymous to form owners unless you choose to identify yourself. BOLD.OS keeps a private completion record for reminders. What you write may identify you.</p>';
      if (data.submitted) html += '<p>Your response has been submitted.</p>' +
        (data.myResponse && data.myResponse.identity ? '<p>You chose to share your name and email with the owners.</p>' : button('reveal', 'Share my name and email with the owners', reason));
      else if (data.targeted && f.status === 'open') html += '<section><h2>Your response</h2>' + f.questions.map(question).join('') +
        '<label><input id="fmIdentify" type="checkbox"> Include my name and email</label>' + (f.reminders ? '<p>Weekly inbox reminders stop once you submit.</p>' : '') + button('submit', 'Submit response', reason) + '</section>';
      if (data.owner) {
        html += '<section><h2>Manage form</h2><p>Recipients: ' + f.recipientEmails.length + '. Owners: ' + esc(names(f.owners)) + '.</p>' +
          (f.status === 'open' ? button('close', 'Close form and stop reminders', reason) + (f.invitationsPending ? button('invite', 'Send pending invitations', reason) : '') : '') + '</section>' + results();
      }
    }
    root.innerHTML = html;
  }
  function collect(){
    function selected(id){ return Array.from(document.getElementById(id).selectedOptions).map(function(o){ return o.value; }); }
    return { title: document.getElementById('fmTitle').value, description: document.getElementById('fmDescription').value,
      owners: selected('fmOwners'), targetEmails: selected('fmTargets'), targetGroups: Array.from(root.querySelectorAll('.fm-group:checked')).map(function(e){ return e.value; }),
      reminders: document.getElementById('fmReminders').checked, notifyOwners: document.getElementById('fmOwnerDigest').checked,
      questions: Array.from(root.querySelectorAll('.fm-question')).map(function(q){ return { id: q.dataset.qid, label: q.querySelector('.fm-label').value, type: q.querySelector('.fm-type').value,
        required: q.querySelector('.fm-required').checked, options: q.querySelector('.fm-options').value.split('\n').map(function(x){ return x.trim(); }).filter(Boolean) }; }) };
  }
  async function load(){
    data = await call(id ? { action: 'get', id: id } : { action: 'list' });
    if (BOLD.can('forms', 'edit')) people = (await call({ action: 'people' })).people;
    draft = creating ? empty() : id && data.owner && data.form.status === 'draft' ? data.form : null;
    render();
  }
  root.addEventListener('click', async function(event){
    var b = event.target.closest('[data-action]'); if (!b || b.disabled || busy) return;
    var action = b.dataset.action, d = { action: action, id: id }, ok;
    if (action === 'addQuestion' || action === 'removeQuestion') {
      draft = collect();
      if (action === 'addQuestion') draft.questions.push({ id: 'q' + Date.now(), label: '', type: 'text', required: false, options: [] });
      else draft.questions = draft.questions.filter(function(q){ return q.id !== b.closest('[data-qid]').dataset.qid; });
      render(); return;
    }
    busy = true; b.disabled = true;
    try {
      if (action === 'save') {
        draft = collect(); d.action = id ? 'save' : 'create'; d.form = draft; d.revision = data.form && data.form.revision;
        ok = await BOLD.confirmAction({ title: 'Save form owners?', always: true, effects: ['Allow these members to edit the form and read all responses: ' + names(draft.owners) + '.'], go: 'Save draft' });
        if (!ok) return; d.confirmOwners = true;
      }
      if (action === 'publish' || action === 'invite') {
        ok = await BOLD.confirmAction({ title: action === 'publish' ? 'Publish saved draft?' : 'Send invitations?', always: true,
          effects: [action === 'publish' ? 'Publish the last saved questions to the selected individuals and exact groups. Questions and recipients cannot be changed afterwards.' : 'Invite the form’s recipients.',
            data.form.reminders ? 'Send weekly inbox reminders to non-responders, starting seven days after publication.' : 'No automatic reminders.',
            data.form.notifyOwners ? 'Notify all owners at most daily when new responses arrive.' : 'No owner response notifications.',
            { key: 'notify', text: 'Notify all recipients in BOLD.OS now.' }], go: action === 'publish' ? 'Publish' : 'Send' });
        if (!ok) return; d.confirmPublish = true; d.notify = !ok.skip.notify; d.revision = data.form.revision;
        if (action === 'invite' && !d.notify) return;
      }
      if (action === 'submit') {
        d.answers = {}; root.querySelectorAll('.fm-input').forEach(function(e){ d.answers[e.dataset.q] = e.value; });
        d.identify = document.getElementById('fmIdentify').checked;
      }
      if (action === 'reveal' || action === 'submit' && d.identify) {
        ok = await BOLD.confirmAction({ title: 'Share your identity?', always: true, effects: ['Show your name and email alongside this response to all form owners. This cannot be undone.'], go: 'Share my identity' });
        if (!ok) return; d.confirmIdentity = true;
      }
      var result = await call(d);
      if (action === 'save' && !id) { location.href = 'forms.html?id=' + encodeURIComponent(result.id); return; }
      await load();
    } catch(e){ var error = document.getElementById('fmError'); error.hidden = false; error.textContent = e.message; }
    finally { busy = false; b.disabled = false; }
  });
  BOLD.onUser(function(u){ user = u; if (!u) { root.innerHTML = ''; return; } load().catch(function(e){ root.textContent = e.message; }); });
})();
