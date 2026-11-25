(function(){
  var root = document.getElementById('forms'), esc = BOLD.escapeHtml, data, people = [], draft, user, busy = false;
  if (!root || !BOLD.getAuth()) return;
  var id = new URLSearchParams(location.search).get('id'), creating = new URLSearchParams(location.search).has('new');
  var selections = { owners: [], recipients: [] }, categories = [], creator;
  var selectedViews = { owners: { query: '', page: 0 }, recipients: { query: '', page: 0 } };
  function call(d){ return BOLD.getApp().functions('europe-west2').httpsCallable('forms')(d).then(function(r){ return r.data; }); }
  function button(a, text, disabled){ return '<button type="button" class="btn-text" data-action="' + a + '"' + (disabled ? ' disabled title="' + esc(disabled) + '"' : '') + '>' + text + '</button>'; }
  function names(emails){ return emails.map(function(e){ var p = people.filter(function(p){ return p.email === e; })[0]; return p ? p.name : e; }).join(', '); }
  function options(list, selected){ return list.map(function(p){ return '<option value="' + esc(p.email) + '"' + (selected.indexOf(p.email) !== -1 ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join(''); }
  function empty(){ return { title: '', description: '', owners: [user.email.toLowerCase()], targetEmails: [], targetGroups: [], reminders: false, notifyOwners: false, questions: [{ id: 'q1', label: '', type: 'text', required: false, options: [] }] }; }
  function personLabel(email){
    var p = people.find(function(p){ return p.email === email; });
    return '<span><strong>' + esc(p ? p.name : email) + '</strong><small>' + esc(email) + (p && p.role ? ' · ' + esc(p.role) : '') + '</small></span>';
  }
  function picker(kind, title){
    var group = '', opts = '';
    categories.forEach(function(c, i){
      if (c.group !== group) { if (group) opts += '</optgroup>'; group = c.group; opts += '<optgroup label="' + esc(group) + '">'; }
      opts += '<option value="' + i + '">' + esc(c.label) + ' (' + c.emails.length + ')</option>';
    });
    if (group) opts += '</optgroup>';
    return '<div class="fm-panel fm-picker" data-picker="' + kind + '" role="group" aria-labelledby="' + kind + '-heading"><h3 id="' + kind + '-heading">' + title + '</h3>' +
      '<p>' + (kind === 'owners' ? 'Owners can edit the draft and read every response. The creator remains an owner. Maximum 20.' : 'Only the people in this list will receive the form. Maximum 500.') + '</p>' +
      '<div class="fm-search-wrap"><label>Search ' + kind + '<input type="search" class="fm-person-search" placeholder="First name, last name or email" aria-controls="' + kind + '-results" autocomplete="off"></label>' +
      '<div class="fm-person-results" id="' + kind + '-results" hidden></div></div>' +
      '<label>Category for ' + kind + '<select class="fm-category">' + opts + '</select></label>' +
      '<div class="fm-category-actions">' + button('addCategory', 'Add category') + button('removeCategory', 'Remove category') + '</div>' +
      '<p class="fm-hint">Categories use current profile details. Add or remove a category, then adjust individuals below.</p>' +
      '<p class="fm-picker-status" role="status" aria-live="polite"></p>' +
      '<label>Filter selected ' + kind + '<input type="search" class="fm-selected-search" placeholder="First name, last name or email" value="' + esc(selectedViews[kind].query) + '"></label>' +
      '<p class="fm-selected-status" role="status"></p><ul class="fm-selected"></ul>' +
      '<div class="fm-pagination" role="group" aria-label="Selected ' + kind + ' pages">' + button('previousPeople', 'Previous') + '<span class="fm-page-number"></span>' + button('nextPeople', 'Next') + '</div></div>';
  }
  function showSearch(wrap, open){
    wrap.querySelector('.fm-person-results').hidden = !open || !wrap.querySelector('input').value.trim();
  }
  function updatePicker(el){
    var kind = el.dataset.picker, selected = selections[kind], query = el.querySelector('.fm-person-search').value;
    el.querySelector('.fm-picker-status').textContent = selected.length + ' ' + kind + ' selected';
    var view = selectedViews[kind], page = FormPeople.selectedPage(people, selected, view.query, view.page);
    view.page = page.page;
    el.querySelector('.fm-selected-status').textContent = page.total ? 'Showing ' + (page.page * 5 + 1) + ' to ' + (page.page * 5 + page.emails.length) + ' of ' + page.total + (view.query.trim() ? ' matching people' : ' selected people') : (selected.length ? 'No selected people match your search.' : 'No people selected.');
    el.querySelector('.fm-page-number').textContent = 'Page ' + (page.page + 1) + ' of ' + page.pages;
    el.querySelector('[data-action="previousPeople"]').disabled = page.page === 0;
    el.querySelector('[data-action="nextPeople"]').disabled = page.page === page.pages - 1;
    el.querySelector('.fm-pagination').hidden = page.pages === 1;
    el.querySelector('.fm-selected').innerHTML = page.emails.map(function(email){
      var locked = kind === 'owners' && email === creator;
      return '<li>' + personLabel(email) + '<button type="button" class="btn-text" data-action="removePerson" data-email="' + esc(email) + '" aria-label="Remove ' + esc(email) + '"' + (locked ? ' disabled title="The creator remains an owner"' : '') + '>' + (locked ? 'Creator' : 'Remove') + '</button></li>';
    }).join('');
    var wrap = el.querySelector('.fm-search-wrap');
    showSearch(wrap, wrap.contains(document.activeElement));
    var matches = FormPeople.search(people, query);
    el.querySelector('.fm-person-results').innerHTML = query.trim() ?
      '<p role="status">' + matches.length + ' matches' + (matches.length > 5 ? '; showing the first 5. Keep typing to narrow your search.' : '') + '</p>' +
      matches.slice(0,5).map(function(p){ var added = selected.indexOf(p.email) >= 0; return '<button type="button" class="fm-person-result" data-action="addPerson" data-email="' + esc(p.email) + '"' + (added ? ' disabled' : '') + '>' + personLabel(p.email) + '<span>' + (added ? 'Added' : 'Add') + '</span></button>'; }).join('') : '';
  }
  function choiceRow(value, i){
    return '<div class="fm-option-row"><input type="text" class="fm-option" aria-label="Option ' + (i + 1) + '" placeholder="Option ' + (i + 1) + '" maxlength="200" value="' + esc(value) + '"><button type="button" class="btn-text fm-option-remove" data-action="removeOption" aria-label="Remove option ' + (i + 1) + '" title="Remove option">×</button></div>';
  }
  function answerEditor(q){
    if (q.type === 'choice') return '<div class="fm-choices" role="group" aria-label="Choice options"><p class="fm-options-label">Choice options</p><div class="fm-option-list">' + (q.options.length ? q.options : ['', '']).map(choiceRow).join('') + '</div><div class="fm-option-actions"><button type="button" class="btn-text" data-action="addOption"' + (q.options.length >= 15 ? ' disabled title="Maximum 15 options"' : '') + '><span aria-hidden="true">+</span> Add option</button></div></div>';
    if (q.type === 'scale') return '<p class="fm-hint">Respondents choose one value from 1 to 5.</p><div class="fm-scale" role="group" aria-label="Scale answer preview">' + [1,2,3,4,5].map(function(n){ return '<label><input type="radio" disabled> ' + n + '</label>'; }).join('') + '</div>';
    return '<label>Text answer preview<textarea class="no-tags" placeholder="Respondents write their answer here" disabled></textarea></label>';
  }
  function questionEditor(q, i){
    return '<div class="fm-question fm-panel" role="group" aria-labelledby="heading-' + esc(q.id) + '" data-qid="' + esc(q.id) + '"><h3 id="heading-' + esc(q.id) + '">Question ' + (i + 1) + '</h3>' +
      '<label>Question<input class="fm-label" type="text" value="' + esc(q.label) + '" maxlength="500"></label>' +
      '<label>Answer type<select class="fm-type" data-current="' + q.type + '">' + [['text','Text'],['choice','Multiple choice (choose one)'],['scale','Scale (1–5)']].map(function(t){ return '<option value="' + t[0] + '"' + (q.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></label>' +
      '<div class="fm-answer-editor">' + answerEditor(q) + '</div>' +
      '<label><input class="fm-required" type="checkbox"' + (q.required ? ' checked' : '') + '> Required</label>' + button('removeQuestion', 'Remove question') + '</div>';
  }
  function editor(){
    return '<section><h2>' + (id ? 'Edit draft' : 'New form') + '</h2><label>Title<input id="fmTitle" type="text" maxlength="160" value="' + esc(draft.title) + '"></label>' +
      '<label>Description<textarea id="fmDescription" class="no-tags">' + esc(draft.description) + '</textarea></label>' +
      picker('owners', 'Owners') + picker('recipients', 'Recipients') +
      '<label><input id="fmReminders" type="checkbox"' + (draft.reminders ? ' checked' : '') + '> Send weekly BOLD.OS inbox reminders to people who have not responded, starting seven days after publication.</label>' +
      '<label><input id="fmOwnerDigest" type="checkbox"' + (draft.notifyOwners ? ' checked' : '') + '> Notify all owners in BOLD.OS at most once a day when new responses arrive.</label>' +
      draft.questions.map(questionEditor).join('') + button('addQuestion', 'Add question') + button('save', 'Save draft') + '</section>';
  }
  function question(q){
    var label = esc(q.label) + (q.required ? ' (required)' : ' (optional)');
    if (q.type === 'scale') return '<div class="fm-panel fm-scale-answer" data-q="' + esc(q.id) + '" role="group" aria-labelledby="answer-' + esc(q.id) + '"><h3 id="answer-' + esc(q.id) + '">' + label + '</h3><div class="fm-scale">' +
      ['1','2','3','4','5'].map(function(v){ return '<label><input type="radio" name="answer-' + esc(q.id) + '" value="' + v + '"> ' + v + '</label>'; }).join('') +
      '</div>' + (q.required ? '' : '<label><input type="radio" name="answer-' + esc(q.id) + '" value="" checked> No answer</label>') + '</div>';
    return '<label>' + label + (q.type === 'text' ? '<textarea class="fm-input no-tags" data-q="' + esc(q.id) + '"></textarea>' :
      '<select class="fm-input" data-q="' + esc(q.id) + '"><option value="">Choose…</option>' + q.options.map(function(v){ return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('') + '</select>') + '</label>';
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
    root.querySelectorAll('.fm-picker').forEach(updatePicker);
  }
  function collect(){
    return { title: document.getElementById('fmTitle').value, description: document.getElementById('fmDescription').value,
      owners: selections.owners.slice(), targetEmails: selections.recipients.slice(), targetGroups: [],
      reminders: document.getElementById('fmReminders').checked, notifyOwners: document.getElementById('fmOwnerDigest').checked,
      questions: Array.from(root.querySelectorAll('.fm-question')).map(function(q){ return { id: q.dataset.qid, label: q.querySelector('.fm-label').value, type: q.querySelector('.fm-type').value,
        required: q.querySelector('.fm-required').checked, options: Array.from(q.querySelectorAll('.fm-option')).map(function(e){ return e.value.trim(); }).filter(Boolean) }; }) };
  }
  async function load(){
    data = await call(id ? { action: 'get', id: id } : { action: 'list' });
    if (BOLD.can('forms', 'edit')) people = (await call({ action: 'people' })).people;
    draft = creating ? empty() : id && data.owner && data.form.status === 'draft' ? data.form : null;
    if (draft) {
      creator = draft.createdBy || user.email.toLowerCase();
      categories = FormPeople.categories(people);
      selections.owners = draft.owners.slice();
      // Expand legacy draft groups once, then save the explicit editable list.
      selections.recipients = Array.from(new Set(draft.targetEmails.concat(people.filter(function(p){ return (draft.targetGroups || []).indexOf(p.category) >= 0; }).map(function(p){ return p.email; }))));
    }
    render();
  }
  root.addEventListener('focusin', function(event){
    var wrap = event.target.closest('.fm-search-wrap');
    if (wrap) showSearch(wrap, true);
  });
  root.addEventListener('focusout', function(event){
    var wrap = event.target.closest('.fm-search-wrap');
    if (wrap && !wrap.contains(event.relatedTarget)) showSearch(wrap, false);
  });
  root.addEventListener('keydown', function(event){
    var wrap = event.target.closest('.fm-search-wrap');
    if (wrap && event.key === 'Escape') {
      wrap.querySelector('input').focus();
      showSearch(wrap, false);
      event.preventDefault();
    }
  });
  root.addEventListener('input', function(event){
    if (event.target.matches('.fm-selected-search')) {
      var el = event.target.closest('.fm-picker');
      selectedViews[el.dataset.picker] = { query: event.target.value, page: 0 };
      updatePicker(el);
    }
    if (event.target.matches('.fm-person-search')) updatePicker(event.target.closest('.fm-picker'));
  });
  root.addEventListener('change', async function(event){
    var select = event.target;
    if (!select.matches('.fm-type')) return;
    var previous = select.dataset.current, next = select.value;
    select.value = previous;
    if (busy || next === previous) return;
    busy = true; select.disabled = true;
    try {
      var ok = await BOLD.confirmAction({ title: 'Change answer type?', always: true,
        effects: ['Replace the answer input and permanently clear any choice options entered for this question. The question text and Required setting will be kept.'], go: 'Change type' });
      if (!ok || !root.contains(select)) return;
      select.value = next; select.dataset.current = next;
      select.closest('.fm-question').querySelector('.fm-answer-editor').innerHTML = answerEditor({ type: next, options: [] });
    } finally { busy = false; select.disabled = false; select.focus(); }
  });
  root.addEventListener('click', async function(event){
    var b = event.target.closest('[data-action]'); if (!b || b.disabled || busy) return;
    var action = b.dataset.action, d = { action: action, id: id }, ok;
    if (action === 'previousPeople' || action === 'nextPeople') {
      var pickerEl = b.closest('.fm-picker');
      selectedViews[pickerEl.dataset.picker].page += action === 'nextPeople' ? 1 : -1;
      updatePicker(pickerEl);
      return;
    }
    if (['addPerson','removePerson','addCategory','removeCategory'].indexOf(action) >= 0) {
      var el = b.closest('.fm-picker'), kind = el.dataset.picker;
      var emails = action === 'addCategory' || action === 'removeCategory' ? categories[Number(el.querySelector('.fm-category').value)].emails : [b.dataset.email];
      try {
        selections[kind] = FormPeople.change(selections[kind], emails, action === 'addPerson' || action === 'addCategory', kind === 'owners' ? creator : null, kind === 'owners' ? 20 : 500);
        updatePicker(el);
        if (action === 'addPerson') el.querySelector('.fm-person-search').focus();
        if (action === 'removePerson') el.querySelector('.fm-selected-search').focus();
      } catch(e){ el.querySelector('.fm-picker-status').textContent = e.message; }
      return;
    }
    if (action === 'addOption' || action === 'removeOption') {
      var choices = b.closest('.fm-choices'), list = choices.querySelector('.fm-option-list');
      if (action === 'addOption') {
        if (list.children.length >= 15) return;
        list.insertAdjacentHTML('beforeend', choiceRow('', list.children.length));
      } else b.closest('.fm-option-row').remove();
      var rows = Array.from(list.children);
      rows.forEach(function(row, i){
        row.querySelector('input').setAttribute('aria-label', 'Option ' + (i + 1));
        row.querySelector('input').placeholder = 'Option ' + (i + 1);
        row.querySelector('button').setAttribute('aria-label', 'Remove option ' + (i + 1));
      });
      var add = choices.querySelector('[data-action="addOption"]');
      add.disabled = rows.length >= 15; add.title = add.disabled ? 'Maximum 15 options' : '';
      if (action === 'addOption') rows[rows.length - 1].querySelector('input').focus();
      else add.focus();
      return;
    }
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
          effects: [action === 'publish' ? 'Publish the last saved questions to the saved recipient list. Questions, owners and recipients cannot be changed afterwards.' : 'Invite the form’s recipients.',
            data.form.reminders ? 'Send weekly inbox reminders to non-responders, starting seven days after publication.' : 'No automatic reminders.',
            data.form.notifyOwners ? 'Notify all owners at most daily when new responses arrive.' : 'No owner response notifications.',
            { key: 'notify', text: 'Notify all recipients in BOLD.OS now.' }], go: action === 'publish' ? 'Publish' : 'Send' });
        if (!ok) return; d.confirmPublish = true; d.notify = !ok.skip.notify; d.revision = data.form.revision;
        if (action === 'invite' && !d.notify) return;
      }
      if (action === 'submit') {
        d.answers = {}; root.querySelectorAll('.fm-input').forEach(function(e){ d.answers[e.dataset.q] = e.value; });
        root.querySelectorAll('.fm-scale-answer').forEach(function(e){ var selected = e.querySelector('input:checked'); d.answers[e.dataset.q] = selected ? selected.value : ''; });
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
