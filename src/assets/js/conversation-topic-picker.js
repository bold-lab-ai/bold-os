// A searchable disclosure with ordinary keyboard-operable buttons. Topic creation is
// inline in the existing composer, so title, text, and visibility survive the choice.
function conversationTopicPicker(host){
  var esc = BOLD.escapeHtml, topics = [], selected = '', choiceVersion = 0;
  host.innerHTML = '<details class="bs-topic-picker"><summary aria-label="Choose a topic">Choose a topic</summary><div class="bs-topic-menu">' +
    '<input type="search" aria-label="Find a topic" placeholder="Find a topic" maxlength="60">' +
    '<div class="bs-topic-options"></div><button type="button" class="btn-text bs-topic-new">Create a topic…</button>' +
    '<div class="bs-topic-create" hidden><label>Topic name<input class="bs-topic-name" maxlength="60"></label>' +
    '<label>Icon<input class="bs-topic-icon no-emoji" maxlength="16"></label>' +
    '<button type="button" class="btn-box bs-topic-save">Create topic</button></div>' +
    '<p class="field-error" role="alert" hidden></p></div></details>';
  var details = host.querySelector('details'), summary = host.querySelector('summary'), search = host.querySelector('[type=search]');
  var options = host.querySelector('.bs-topic-options'), add = host.querySelector('.bs-topic-new'), editor = host.querySelector('.bs-topic-create');
  var name = host.querySelector('.bs-topic-name'), icon = host.querySelector('.bs-topic-icon'), save = host.querySelector('.bs-topic-save');
  var error = host.querySelector('[role=alert]'), custom = false;
  function report(message){ error.textContent = message; error.hidden = !message; }
  function draw(){
    var hit = topics.find(function(t){ return t.id === selected; });
    summary.setAttribute('aria-label', hit ? 'Topic: ' + hit.name : 'Choose a topic');
    summary.textContent = hit ? hit.icon + ' ' + hit.name : 'Choose a topic';
    var query = search.value.trim().toLowerCase();
    options.innerHTML = topics.filter(function(t){ return t.name.toLowerCase().includes(query); }).map(function(t){
      return '<button type="button" class="btn-text" data-topic="' + esc(t.id) + '">' + esc(t.icon + ' ' + t.name) + '</button>';
    }).join('');
  }
  function choose(id){
    choiceVersion++; save.disabled = false;
    selected = id; search.value = ''; editor.hidden = true; details.open = false; report(''); draw();
  }
  options.addEventListener('click', function(e){
    var b = e.target.closest('[data-topic]');
    if (b) { choose(b.dataset.topic); summary.focus(); }
  });
  search.addEventListener('input', draw);
  add.addEventListener('click', function(){
    editor.hidden = false; name.value = search.value.trim(); icon.value = ConversationTopics.suggestIcon(name.value);
    custom = false; report(''); name.focus();
  });
  name.addEventListener('input', function(){ if (!custom) icon.value = ConversationTopics.suggestIcon(name.value); });
  icon.addEventListener('input', function(){ custom = !!icon.value.trim(); });
  save.addEventListener('click', async function(){
    var title = name.value.trim(), id = ConversationTopics.topicId(title);
    if (!id) { report('Give the topic a name containing a letter or number.'); name.focus(); return; }
    if (save.disabled) return;
    var version = choiceVersion;
    save.disabled = true;
    try {
      var topic = await conversationTopicPicker.create(id, title, icon.value.trim() || ConversationTopics.suggestIcon(title));
      // Cancel or choosing a different topic takes precedence over a pending save.
      if (version !== choiceVersion) return;
      if (!topics.some(function(t){ return t.id === topic.id; })) topics = topics.concat(topic);
      choose(topic.id); summary.focus();
    } catch (e){
      if (version === choiceVersion) { save.disabled = false; report(e.message || 'Couldn’t create the topic.'); }
    }
  });
  host.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && details.open) { details.open = false; summary.focus(); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      if (editor.contains(e.target)) save.click();
      else if (options.firstElementChild) options.firstElementChild.focus();
      else add.focus();
    }
  });
  return {
    update: function(items){ topics = items; draw(); },
    value: function(){ return selected; },
    reset: function(){ choose(''); },
    required: function(){
      if (topics.some(function(t){ return t.id === selected; })) return true;
      details.open = true; search.focus(); report('Choose a topic before continuing.'); return false;
    },
  };
}

conversationTopicPicker.create = function(id, name, icon){
  var db = firebase.firestore(BOLD.getApp()), ref = db.collection('conversationTopics').doc(id);
  return db.runTransaction(async function(tx){
    var existing = await tx.get(ref);
    if (existing.exists) return Object.assign({ id: id }, existing.data());
    tx.set(ref, { name: name, icon: icon });
    return { id: id, name: name, icon: icon };
  });
};
conversationTopicPicker.watch = function(update, fail){
  return firebase.firestore(BOLD.getApp()).collection('conversationTopics').onSnapshot(function(snap){
    var topics = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
    update(topics.sort(function(a,b){ return a.name.localeCompare(b.name); }));
  }, fail);
};
// When moving a guide comment into Conversations, choose its topic before confirming the move.
conversationTopicPicker.prompt = function(){
  return new Promise(function(resolve){
    var dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-label', 'Choose a conversation topic');
    dialog.innerHTML = '<h2>Choose a conversation topic</h2><div class="bs-topic-slot"></div>' +
      '<p class="ev-error" role="alert" hidden></p><div class="confirm-actions">' +
      '<button type="button" class="btn-box" data-cancel>Cancel</button><button type="button" class="btn-box is-primary" data-continue>Continue</button></div>';
    var picker = conversationTopicPicker(dialog.querySelector('.bs-topic-slot'));
    var stop = conversationTopicPicker.watch(picker.update, function(){
      var error = dialog.querySelector('.ev-error'); error.textContent = 'Couldn’t load topics.'; error.hidden = false;
    });
    function finish(id){ stop(); dialog.close(); dialog.remove(); resolve(id); }
    dialog.querySelector('[data-cancel]').onclick = function(){ finish(''); };
    dialog.addEventListener('cancel', function(e){ e.preventDefault(); finish(''); });
    dialog.querySelector('[data-continue]').onclick = function(){ if (picker.required()) finish(picker.value()); };
    document.body.appendChild(dialog); dialog.showModal();
    dialog.querySelector('details').open = true; dialog.querySelector('[type=search]').focus();
  });
};
