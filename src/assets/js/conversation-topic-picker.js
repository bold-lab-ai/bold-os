// The first choices include the lab's icons. Searching also uses the site's emoji catalogue.
function conversationIconChooser(editor){
  var featured = [
    ['🦋', 'Butterfly', 'about bold'], ['☎️', 'Telephone', 'advice help phone'], ['⚙️', 'Gear', 'feedback settings'],
    ['📄', 'Document', 'file page proposal project plan'], ['🧠', 'Brain', 'research brainstorm'],
    ['📖', 'Book', 'paper reading'], ['🕒', 'Clock', 'meeting event'], ['💬', 'Speech bubble', 'general conversation chat'],
    ['💡', 'Light bulb', 'idea'], ['🔬', 'Microscope', 'science'], ['🌱', 'Seedling', 'growth'], ['⭐', 'Star', 'favourite']
  ];
  var esc = BOLD.escapeHtml, button = editor.querySelector('.bs-topic-icon'), panel = editor.querySelector('.bs-icon-panel');
  var search = panel.querySelector('input'), grid = panel.querySelector('.bs-icon-grid'), restore = panel.querySelector('.bs-icon-restore');
  var suggested = '💬', picked = '', pickedName = '';
  function updateButton(){
    var value = picked || suggested, item = featured.find(function(x){ return x[0] === value; });
    var label = 'Choose icon: ' + (pickedName || (item && item[1]) || value);
    button.textContent = value;
    button.setAttribute('aria-label', label); button.title = label;
    restore.hidden = !picked;
  }
  function close(){
    panel.hidden = true; button.setAttribute('aria-expanded', 'false');
  }
  async function results(){
    var query = search.value.trim().toLowerCase();
    var choices = featured.filter(function(x){ return x[0] === query || (x[1] + ' ' + x[2]).toLowerCase().includes(query); });
    if (query) {
      grid.innerHTML = '<span class="bs-no-icons">Searching…</span>';
      var more = await BoldEmoji.search(query.replace(/\s+/g, '_'), 48);
      if (panel.hidden || query !== search.value.trim().toLowerCase()) return;
      var seen = new Set(choices.map(function(x){ return x[0].replace(/\uFE0F/g, ''); }));
      more.forEach(function(x){
        var key = x.e.replace(/\uFE0F/g, '');
        if (seen.has(key)) return;
        seen.add(key); choices.push([x.e, x.name.replace(/_/g, ' ')]);
      });
    }
    grid.innerHTML = choices.map(function(x){
      return '<button type="button" class="bs-icon-choice" data-icon="' + esc(x[0]) + '" aria-label="' + esc(x[1]) +
        '" title="' + esc(x[1]) + '" aria-pressed="' + (x[0] === (picked || suggested)) + '">' + esc(x[0]) + '</button>';
    }).join('') || '<span class="bs-no-icons">No matching icons</span>';
  }
  button.addEventListener('click', function(){
    if (!panel.hidden) { close(); return; }
    panel.hidden = false; button.setAttribute('aria-expanded', 'true');
    search.value = ''; results(); search.focus();
  });
  search.addEventListener('input', results);
  grid.addEventListener('click', function(e){
    var choice = e.target.closest('[data-icon]'); if (!choice) return;
    picked = choice.dataset.icon; pickedName = choice.getAttribute('aria-label');
    close(); updateButton(); button.focus();
  });
  restore.addEventListener('click', function(){ picked = ''; pickedName = ''; close(); updateButton(); button.focus(); });
  panel.addEventListener('keydown', function(e){
    if (e.key === 'Escape') { close(); button.focus(); }
    else if (e.key === 'Enter' && e.target === search) {
      var first = grid.querySelector('button'); if (first) first.focus();
    } else return;
    e.preventDefault(); e.stopPropagation();
  });
  return {
    suggest: function(name){ suggested = ConversationTopics.suggestIcon(name); updateButton(); },
    reset: function(name){ picked = ''; pickedName = ''; close(); this.suggest(name); },
    value: function(){ return picked || suggested; }
  };
}

// A searchable disclosure with ordinary keyboard-operable buttons. Topic creation is
// inline in the existing composer, so title, text, and visibility survive the choice.
function conversationTopicPicker(host){
  var esc = BOLD.escapeHtml, topics = [], selected = '', choiceVersion = 0;
  host.innerHTML = '<details class="bs-topic-picker"><summary aria-label="Choose a topic">Choose a topic</summary><div class="bs-topic-menu">' +
    '<input type="search" aria-label="Find a topic" placeholder="Find a topic" maxlength="60">' +
    '<div class="bs-topic-options"></div><button type="button" class="btn-text bs-topic-new">Create a topic…</button>' +
    '<div class="bs-topic-create" hidden><label>Topic name<input class="bs-topic-name" maxlength="60"></label>' +
    '<div class="bs-icon-field"><span>Icon</span><button type="button" class="bs-topic-icon" aria-label="Choose icon" aria-expanded="false"></button></div>' +
    '<div class="bs-icon-panel" hidden><input type="search" class="no-emoji" aria-label="Search icons" placeholder="Search icons" maxlength="60">' +
    '<div class="bs-icon-grid" role="group" aria-label="Icons"></div><button type="button" class="btn-text bs-icon-restore" hidden>Use suggested icon</button></div>' +
    '<button type="button" class="btn-box bs-topic-save">Create topic</button></div>' +
    '<p class="field-error" role="alert" hidden></p></div></details>';
  var details = host.querySelector('details'), summary = host.querySelector('summary'), search = host.querySelector('[type=search]');
  var options = host.querySelector('.bs-topic-options'), add = host.querySelector('.bs-topic-new'), editor = host.querySelector('.bs-topic-create');
  var name = host.querySelector('.bs-topic-name'), icon = conversationIconChooser(editor), save = host.querySelector('.bs-topic-save');
  var error = host.querySelector('[role=alert]');
  function report(message){ error.textContent = message; error.hidden = !message; }
  function draw(){
    var hit = topics.find(function(t){ return t.id === selected; });
    summary.setAttribute('aria-label', hit ? 'Topic: ' + hit.name : 'Choose a topic');
    summary.textContent = hit ? hit.icon + ' ' + hit.name : 'Choose a topic';
    var query = search.value.trim().toLowerCase();
    options.innerHTML = topics.filter(function(t){ return t.name.toLowerCase().startsWith(query); }).map(function(t){
      return '<button type="button" class="btn-text" data-topic="' + esc(t.id) + '"><span aria-hidden="true">' + esc(t.icon) + '</span> ' + esc(t.name) + '</button>';
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
    editor.hidden = false; name.value = search.value.trim(); icon.reset(name.value); report(''); name.focus();
  });
  name.addEventListener('input', function(){ icon.suggest(name.value); });
  save.addEventListener('click', async function(){
    var title = name.value.trim(), id = ConversationTopics.topicId(title);
    if (!id) { report('Give the topic a name containing a letter or number.'); name.focus(); return; }
    if (save.disabled) return;
    var version = choiceVersion;
    save.disabled = true;
    try {
      var topic = await conversationTopicPicker.create(id, title, icon.value());
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
    if (existing.exists) return ConversationTopics.fromDoc(existing);
    tx.set(ref, { name: name, icon: icon });
    return { id: id, name: name, icon: icon };
  });
};
conversationTopicPicker.watch = function(update, fail){
  return firebase.firestore(BOLD.getApp()).collection('conversationTopics').onSnapshot(function(snap){
    var topics = snap.docs.map(ConversationTopics.fromDoc);
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
