"use strict";

// The registration form's keyword and Slack-channel fields, shared with a project's
// own page (where they are edited). Plain functions over fixed ids: keywords use
// #kwEntry (filled by keywordEntryHtml), #pfKeyword, #kwAdd, #kwList, #kwSuggest;
// the channel uses #pfChannel and #channelStatus (channelEntryHtml). Needs
// card-model.js (normalizeKeyword, KEYWORDS_MAX, normalizeProjectChannel) and BOLD.

function keywordEntryHtml(){
  return '<div class="kw-entry">' +
      '<input type="text" id="pfKeyword" maxlength="40" autocomplete="off" placeholder="Add a keyword" role="combobox" aria-expanded="false" aria-controls="kwSuggest" aria-autocomplete="list">' +
      '<button class="btn kw-add" type="button" id="kwAdd" aria-label="Add keyword">+</button>' +
      '<ul class="kw-suggest" id="kwSuggest" role="listbox" hidden></ul>' +
    '</div>' +
    '<ul class="kw-list" id="kwList"></ul>' +
    '<div class="field-hint">Type a keyword and press Enter or +. Existing keywords are suggested as you type.</div>';
}

// Type, +, suggestions from the keywords already in use. `initial` is the current list;
// showError(msg) / clearError() report to the page. Returns { get(), addTyped() }.
function wireKeywordField(initial, showError, clearError){
  var el = function(id){ return document.getElementById(id); };
  var kwInput = el('pfKeyword'), kwList = el('kwList'), kwSuggest = el('kwSuggest');
  var keywords = (initial || []).slice();   // chosen
  var known = [];      // [{ name, count }] already used on other projects
  var kwActive = -1;

  try {
    firebase.app().functions('europe-west2').httpsCallable('getProjectKeywords')()
      .then(function(r){ known = (r.data && r.data.keywords) || []; })
      .catch(function(err){ console.error('[BOLD Lab] loading keywords failed', err); });
  } catch (e){}

  function renderKeywords(){
    kwList.innerHTML = '';
    keywords.forEach(function(k){
      var li = document.createElement('li'); li.className = 'kw-chip';
      li.appendChild(document.createTextNode(k));
      var x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + k);
      x.addEventListener('click', function(){ keywords = keywords.filter(function(o){ return o !== k; }); renderKeywords(); });
      li.appendChild(x); kwList.appendChild(li);
    });
  }
  function hideSuggest(){ kwSuggest.hidden = true; kwInput.setAttribute('aria-expanded', 'false'); kwActive = -1; }
  function addKeyword(raw){
    var k = normalizeKeyword(raw);
    kwInput.value = ''; hideSuggest();
    if (!k || keywords.indexOf(k) !== -1) return;
    if (keywords.length >= KEYWORDS_MAX) return showError('At most ' + KEYWORDS_MAX + ' keywords.');
    clearError();
    keywords.push(k); renderKeywords();
  }
  function showSuggest(){
    var q = normalizeKeyword(kwInput.value);
    var matches = q ? known.filter(function(k){ return k.name.indexOf(q) !== -1 && keywords.indexOf(k.name) === -1; }).slice(0, 6) : [];
    kwSuggest.innerHTML = ''; kwActive = -1;
    if (!matches.length) return hideSuggest();
    matches.forEach(function(m){
      var li = document.createElement('li'); li.setAttribute('role', 'option');
      var name = document.createElement('span'); name.textContent = m.name;
      var n = document.createElement('span'); n.className = 'n'; n.textContent = m.count;
      li.appendChild(name); li.appendChild(n);
      li.addEventListener('mousedown', function(e){ e.preventDefault(); addKeyword(m.name); kwInput.focus(); });
      kwSuggest.appendChild(li);
    });
    kwSuggest.hidden = false; kwInput.setAttribute('aria-expanded', 'true');
  }
  function moveActive(d){
    var items = kwSuggest.children;
    if (kwSuggest.hidden || !items.length) return;
    kwActive = (kwActive + d + items.length) % items.length;
    Array.prototype.forEach.call(items, function(li, i){ li.classList.toggle('active', i === kwActive); });
  }
  kwInput.addEventListener('input', showSuggest);
  kwInput.addEventListener('blur', hideSuggest);
  kwInput.addEventListener('keydown', function(e){
    if (e.key === 'ArrowDown') { moveActive(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { moveActive(-1); e.preventDefault(); }
    else if (e.key === 'Escape') hideSuggest();
    else if (e.key === 'Enter') {
      e.preventDefault(); // never submits the form
      addKeyword(kwActive >= 0 ? kwSuggest.children[kwActive].firstChild.textContent : kwInput.value);
    }
  });
  el('kwAdd').addEventListener('click', function(){ addKeyword(kwInput.value); kwInput.focus(); });
  renderKeywords();

  return {
    get: function(){ return keywords; },
    addTyped: function(){ if (kwInput.value.trim()) addKeyword(kwInput.value); } // typed but not yet added
  };
}

function channelEntryHtml(value){
  return '<input type="text" id="pfChannel" maxlength="81" placeholder="#proj-name" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="channelRules channelStatus" value="' + BOLD.escapeHtml(value || '') + '">' +
    '<div class="field-hint" id="channelRules">Project channels start with <b>proj-</b> (added if missing). If the channel doesn&rsquo;t exist, it&rsquo;s created (private) and you&rsquo;re invited.</div>' +
    '<ul class="channel-status" id="channelStatus" aria-live="polite"></ul>';
}

// Says what will happen to the typed name in Slack, live: what it's saved as, whether
// the channel exists. ensure(name) does it for real (creates it if needed, invites you)
// and resolves with the projectChannel result; refresh() redraws the live status.
function wireChannelField(verb){
  verb = verb || 'submit';
  var channelInput = document.getElementById('pfChannel'), statusBox = document.getElementById('channelStatus');
  var callChannel = null;
  try {
    var httpsCallable = firebase.app().functions('europe-west2').httpsCallable('projectChannel');
    callChannel = function(name, mode){ return httpsCallable({ name: name, mode: mode }).then(function(r){ return r.data; }); };
  } catch (e){}

  function statusLine(cls, text){
    var li = document.createElement('li');
    li.className = cls; li.textContent = text;
    return li;
  }
  function renderStatus(lines){
    statusBox.innerHTML = '';
    lines.forEach(function(l){ statusBox.appendChild(statusLine(l[0], l[1])); });
  }

  // What the typed name becomes, and what happens to it in Slack.
  var checkSeq = 0, checkTimer = null;
  function updateChannelStatus(){
    clearTimeout(checkTimer);
    var seq = ++checkSeq;
    if (!channelInput.value.trim()) return renderStatus([]);
    var n = normalizeProjectChannel(channelInput.value);
    if (n.error) return renderStatus([['warn', n.error]]);
    var name = '#' + n.name;
    var lines = [n.prefixed
      ? ['', 'Will be saved as ' + name + ' — project channels start with proj-.']
      : ['ok', 'Starts with proj- — no change.']];
    renderStatus(lines.concat([['pending', 'Checking Slack…']]));
    checkTimer = setTimeout(function(){
      if (!callChannel) return renderStatus(lines);
      callChannel(n.name, 'check').then(function(r){
        if (seq !== checkSeq) return;
        renderStatus(lines.concat([r.exists
          ? ['ok', name + ' already exists — nothing to do.']
          // Not found means it doesn't exist, or it's a private channel the bot isn't in
          // (that's caught on save as name taken, and left alone) — say both.
          : ['new', name + ' wasn’t found. If it doesn’t exist, it will be created as a private channel and you’ll be invited when you submit. If it’s an existing private channel, invite ' + (r.bot || 'the BOLD Slack app') + ' to it so the project page can link to it.']]));
      }).catch(function(err){
        if (seq !== checkSeq) return;
        console.error('[BOLD Lab] channel check failed', err);
        renderStatus(lines.concat([['warn', 'Couldn’t check Slack — the channel is set up when you ' + verb + '.']]));
      });
    }, 500);
  }
  channelInput.addEventListener('input', updateChannelStatus);
  // Leaving the field shows the name as it will be stored.
  channelInput.addEventListener('blur', function(){
    var n = normalizeProjectChannel(channelInput.value);
    if (!n.error && channelInput.value.trim() && channelInput.value.trim() !== '#' + n.name){
      channelInput.value = '#' + n.name;
      updateChannelStatus();
    }
  });

  return {
    refresh: updateChannelStatus,
    ensure: function(name){
      // Set up the Slack channel first (creates and invites if it doesn't exist),
      // so a project is never saved against a channel that couldn't be made.
      renderStatus([['pending', 'Setting up #' + name + '…']]);
      return callChannel ? callChannel(name, 'ensure') : Promise.reject(new Error('functions unavailable'));
    }
  };
}
