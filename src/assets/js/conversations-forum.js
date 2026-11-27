// Conversations (conversations.html, above the Calendar in the sidebar; an experiment until 2026-11-04):
// Reddit-like threads. A post (conversations/{pid}) and its replies (conversations/{pid}/messages/{mid},
// each answering the post or another reply: `parent`) are a tree; each can be voted up or down
// (`votes`, by sign-in id) and replied to. Saved, and seen by whoever may view Conversations
// (Who can see what; firestore.rules). Ways in: write a post or a reply; bring in a Slack thread (Import from Slack here,
// or Take it to the BOLD OS in Slack: functions/slack-thread.js); or reason with your agent (a panel at
// the bottom, from any message, or from New chat's form for a new post), which drafts a post or a reply and saves it once you say
// so (the BOLDiquette: an agent confirms each action with its person). The agent is a preview: it
// drafts from your own words, with no model behind it. A post opens as its thread (#post=<id>).
//
// One forum, wherever it's shown (2026-11-06): Conversations' page (pages/conversations.js) and a project's
// Conversations tab (project.js) mount this same one, so they look and work alike. In a project, only the
// conversations about it (`project`), new ones about it too, and its address is the project page's own
// (#id=…&tab=conversations&post=<id>).
// A page can show one conversation alone (thread: its id; no list, no All posts): a proposed project's.
// BoldConversations.create({ project?: { id, title: () => its title }, thread?, note? (false: none), title? (false: no thread title), peek? (true: the home page's: no search box or filters, and a conversation opens on Conversations' page) }) → { el (kept: put it back after a redraw), away() }.
window.BoldConversations = (function(){
  var EYE = '<svg class="bs-readers-eye" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  var PIN = '<svg class="bs-pin-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g transform="rotate(38 12 12)"><path d="M8 3h8v2l-1 1v4l3 3v2H6v-2l3-3V6L8 5zM12 15v7"/></g></svg>';
  var PINNED = '<span class="bs-pin-label">' + PIN + 'Pinned</span>';
  // Shared comment composer. Keep its DOM node so live updates preserve the draft.
  function replyBox(o){
    var esc = BOLD.escapeHtml, label = o.label || 'Reply';
    var el = document.createElement('section');
    el.className = 'ha-box bs-answer';
    el.innerHTML = '<button type="button" class="btn-box bs-comment-button" aria-expanded="false">' + esc(label) + '</button>' +
      '<div class="ha-fold" hidden><form class="ha-form" novalidate><textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="2" maxlength="10000" placeholder="Your comment" aria-label="' + esc(label) + '"></textarea>' +
      '<div class="ha-actions"><span class="bs-answer-to"></span><button type="button" class="btn-text ha-close">Close</button><button type="submit" class="btn-box is-primary">' + esc(o.button || 'Reply') + '</button></div></form></div>';
    var line = el.querySelector('.bs-comment-button'), form = el.querySelector('form'), box = form.querySelector('textarea'), go = form.querySelector('button[type=submit]');
    function open(yes){
      el.classList.toggle('is-open', yes);
      line.hidden = yes;
      form.parentNode.hidden = !yes;
      line.setAttribute('aria-expanded', String(yes));
      if (yes) {
        var writeTab = box.hidden && form.querySelector('[data-mdf-mode="write"]');
        if (writeTab) writeTab.click();
        box.focus();
      }
    }
    line.addEventListener('click', function(){ open(true); });
    el.querySelector('.ha-close').addEventListener('click', function(){ open(false); line.focus(); });
    el.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !box.value.trim()) { open(false); line.focus(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); e.stopPropagation(); form.requestSubmit(); }
    });
    // Clicked away from, empty: closed again (as on the home page).
    document.addEventListener('click', function(e){ if (el.classList.contains('is-open') && !el.contains(e.target) && el.isConnected && !box.value.trim()) open(false); });
    form.addEventListener('submit', function(e){
      e.preventDefault(); e.stopPropagation();
      var body = box.value.trim();
      if (!body || go.disabled) return;
      go.disabled = true;
      Promise.resolve(o.send(body)).then(function(ok){
        go.disabled = false;
        if (ok === false) return;
        box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); open(false);
      }, function(){ go.disabled = false; });
    });
    return {
      el: el,
      note: function(t){ el.querySelector('.bs-answer-to').textContent = t || ''; },
      label: function(t){ line.textContent = t; box.setAttribute('aria-label', t); },
      reset: function(){ box.value = ''; open(false); },
      into: function(parent){
        var had = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
        if (el.parentNode !== parent || parent.lastChild !== el) parent.appendChild(el);
        if (had && document.activeElement !== had) { try { had.focus({ preventScroll: true }); } catch (e){ had.focus(); } }
      }
    };
  }
  // The forum's markup (once Conversations' page's).
  function shell(note, peek){
    return (note === false ? '' : '<p class="bs-note">' + BOLD.escapeHtml(note || 'Posts and replies are saved.') + '</p>') +
      '<div class="bs-cols"><section class="bs-forum" aria-label="Forum">' +
        '<div class="bs-sort" role="group" aria-label="Sort">' +
          (peek ? '' : '<input type="search" class="bs-find" placeholder="Search conversations" aria-label="Search conversations" autocomplete="off" spellcheck="false">' +
            // Filters: its icon opens them (the number: how many are set).
            '<button type="button" class="bs-filterbtn" aria-expanded="false" aria-label="Filters" title="Filters"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4z"/></svg><span class="bs-filter-n" hidden></span></button>') +
          '<button type="button" class="bs-sortbtn" data-sort="top" aria-pressed="true">Top</button>' +
          '<button type="button" class="bs-sortbtn" data-sort="new" aria-pressed="false">New</button>' +
          '<button type="button" class="btn bs-import">Import from Slack</button>' +
          '<button type="button" class="btn btn-primary bs-write">Start a conversation</button></div>' +
        // Filters (filtering()): who started it, who's in it, its project, open or private; with the search box.
        (peek ? '' : '<div class="bs-filters" role="group" aria-label="Filter conversations" hidden>' +
          '<select class="bs-filter" data-f="author" aria-label="Started by"></select>' +
          '<select class="bs-filter" data-f="with" aria-label="With"></select>' +
          '<select class="bs-filter" data-f="project" aria-label="Project"></select>' +
          '<select class="bs-filter" data-f="vis" aria-label="Who can read it"></select>' +
          '<button type="button" class="btn-text bs-filter-clear" hidden>Clear</button></div>') +
        '<form class="event-form bs-import-form bs-write-form" hidden>' +
          '<label>Title<input type="text" maxlength="200" required></label><div class="bs-topic-slot"></div>' +
          '<label>Text (optional)<textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="6" maxlength="10000"></textarea></label>' +
          // Who can read it (newWho): open, only you, or you and the people chosen (the picker, pickHtml).
          '<fieldset class="bs-new-who"><legend>Who can read it</legend>' +
            '<label><input type="radio" name="bs-new-who" value="open" checked> Open: whoever can view Conversations</label>' +
            '<label><input type="radio" name="bs-new-who" value="me"> Only me</label>' +
            '<label><input type="radio" name="bs-new-who" value="people"> Me and the people I choose</label>' +
            '<div class="bs-pick" data-pick="new" hidden></div></fieldset>' +
          '<div class="event-form-actions"><button type="submit" class="ev-save">Post</button><button type="button" class="bs-write-cancel">Cancel</button>' +
            '<button type="button" class="btn-text bs-new">or reason it through with your agent first</button></div></form>' +
        '<form class="event-form bs-import-form bs-slack-form" hidden>' +
          '<label>Link to a Slack thread (in Slack: the message’s ⋯ menu → Copy link)<input type="url" placeholder="https://….slack.com/archives/…" required></label><div class="bs-topic-slot"></div>' +
          '<p class="event-form-hint">Only a thread you can read in Slack: a public channel, or a private one you’re in. Its first message becomes the post, the rest its replies. In Slack, a message’s ⋯ menu → Take it to the BOLD OS does the same.</p>' +
          '<p class="ev-error" hidden></p>' +
          '<div class="event-form-actions"><button type="submit" class="ev-save">Bring it in</button><button type="button" class="bs-import-cancel">Cancel</button></div></form>' +
        '<nav class="bs-topic-nav" aria-label="Current topic" hidden></nav><ol class="bs-posts"></ol><article class="bs-thread" hidden></article></section>' +
      '<section class="bs-agent" aria-label="Reason with your agent" hidden>' +
        '<div class="bs-agent-head"><h2>Reason with your agent</h2><button type="button" class="bs-close" aria-label="Close" title="Close">&times;</button></div>' +
        '<p class="bs-about" hidden></p><ol class="bs-log" aria-live="polite"></ol>' +
        '<form class="bs-compose"><textarea rows="2" maxlength="4000" placeholder="What are you thinking about?" aria-label="Your message"></textarea>' +
          '<button type="submit" class="btn btn-primary">Send</button></form></section></div>';
  }
  function create(opts){
    opts = opts || {};
    var root = document.createElement('div');
    root.className = 'bs-root';
    root.innerHTML = shell(opts.note, opts.peek);
    var project = opts.project || null;
    var q = function(sel){ return root.querySelector(sel); };
    var postsEl = q('.bs-posts'), threadEl = q('.bs-thread'), sortEl = q('.bs-sort'), filtersEl = q('.bs-filters');
    var log = q('.bs-log'), form = q('.bs-compose'), text = q('.bs-compose textarea'), aboutEl = q('.bs-about');
    var importEl = q('.bs-slack-form'), writeEl = q('.bs-write-form'), agentEl = q('.bs-agent'), forumEl = q('.bs-forum');
    var esc = BOLD.escapeHtml, MIN = 60000, uid = Math.random().toString(36).slice(2, 8);
    // Reasoning with your agent is off for now (2026-11-04): its button and New chat's link are left out;
    // the panel's code stays, to turn back on here.
    var AGENT = false;
    // A message's text: Markdown (Slack threads come in as it: functions/slack-thread.js), its single
    // line breaks kept, as in Slack.
    var md = function(t){ return '<div class="bs-text md-desc">' + BoldMarkdown.render(t, { breaks: true }) + '</div>'; };
    var me = { email: '', name: 'You', uid: '', slackId: '' }, canPost = false, canStart = false, full = false;
    var posts = null, messages = {}, openId = '', stopMsgs = null;
    var topics = [], topicsReady = false, topicNav = q('.bs-topic-nav'), topicPage = !project && !opts.thread && !opts.peek;
    var topicById = function(id){ return topics.find(function(t){ return t.id === id; }); };
    function currentTopic(){ return topicPage ? new URLSearchParams(location.hash.slice(1)).get('topic') || '' : ''; }
    function topicHref(id){ return '#topic=' + encodeURIComponent(id); }
    var postPicker = conversationTopicPicker(writeEl.querySelector('.bs-topic-slot'));
    var slackPicker = conversationTopicPicker(importEl.querySelector('.bs-topic-slot'));
    var find = '';   // the search box's text: the list shows only the posts it finds, best first (search-rank.js)
    // While searching, listen only to replies under threads this reader can see.
    var replySearch = new Map(), searchFrame = 0;
    var filt = { author: '', with: '', project: '', vis: '' };
    var showFilters = false;   // the filters' row, opened by its icon
    function filtering(){ return !!(filt.author || filt.with || filt.project || filt.vis); }
    function syncReplySearch(){
      var searching = !route().post && (find.trim() || showFilters || filt.with);
      var ids = new Set(searching ? (posts || []).map(function(p){ return p.id; }) : []);
      replySearch.forEach(function(entry, id){
        if (!ids.has(id)) { entry.stop(); replySearch.delete(id); }
      });
      function repaint(){
        if (!searchFrame) searchFrame = requestAnimationFrame(function(){ searchFrame = 0; if (root.isConnected) render(); });
      }
      ids.forEach(function(id){
        if (replySearch.has(id)) return;
        var entry = { items: [], ready: false, failed: false };
        replySearch.set(id, entry);
        entry.stop = col().doc(id).collection('messages').onSnapshot(function(snapshot){
          if (replySearch.get(id) !== entry) return;
          entry.items = snapshot.docs.map(function(doc){
            var m = doc.data(); return { id: doc.id, where: m.name || '', text: m.body || '' };
          });
          entry.ready = true; repaint();
        }, function(){
          if (replySearch.get(id) !== entry) return;
          entry.items = []; entry.ready = true; entry.failed = true; repaint();
        });
      });
    }
    function repliesForSearch(id){ var entry = replySearch.get(id); return entry ? entry.items : []; }
    function people(x){ return [x.name].concat(repliesForSearch(x.id).map(function(r){ return r.where; })).filter(Boolean); }
    // The filters' choices, from the posts there are (a select being used is left alone).
    function fillFilters(){
      if (!posts || !filtersEl) return;
      var uniq = function(a){ var seen = {}; return a.filter(function(v){ if (!v || seen[v]) return false; seen[v] = 1; return true; }).sort(function(a, b){ return String(a).localeCompare(String(b)); }); };
      var projects = {}; posts.forEach(function(x){ if (x.project) projects[x.project] = x.projectTitle || x.project; });
      var choices = {
        author: [['', 'Started by anyone']].concat(uniq(posts.map(function(x){ return x.name; })).map(function(n){ return [n, 'Started by ' + n]; })),
        with: [['', 'With anyone']].concat(uniq([].concat.apply([], posts.map(people))).map(function(n){ return [n, 'With ' + n]; })),
        project: [['', 'Any project'], ['-', 'No project']].concat(Object.keys(projects).sort(function(a, b){ return projects[a].localeCompare(projects[b]); }).map(function(k){ return [k, projects[k]]; })),
        vis: [['', 'Open or private'], ['open', 'Open'], ['private', 'Private']]
      };
      Array.prototype.forEach.call(filtersEl.querySelectorAll('.bs-filter'), function(sel){
        var f = sel.getAttribute('data-f');
        if (f === 'project') sel.hidden = !!project;
        if (document.activeElement === sel) return;
        var c = choices[f];
        if (filt[f] && !c.some(function(o){ return o[0] === filt[f]; })) c.push([filt[f], f === 'author' ? 'Started by ' + filt[f] : f === 'with' ? 'With ' + filt[f] : filt[f]]);
        sel.innerHTML = c.map(function(o){ return '<option value="' + esc(o[0]) + '"' + (o[0] === filt[f] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
        sel.classList.toggle('is-on', !!filt[f]);
      });
      filtersEl.querySelector('.bs-filter-clear').hidden = !filtering();
      var n = ['author', 'with', 'project', 'vis'].filter(function(k){ return filt[k]; }).length, btn = q('.bs-filterbtn'), badge = q('.bs-filter-n');
      if (btn) { btn.setAttribute('aria-expanded', String(showFilters)); btn.classList.toggle('is-on', !!n); btn.title = n ? 'Filters (' + n + ' set)' : 'Filters'; btn.setAttribute('aria-label', btn.title); }
      if (badge) { badge.hidden = !n; badge.textContent = n; }
    }
    function passes(x){
      return (!filt.author || x.name === filt.author) &&
        (!filt.with || people(x).indexOf(filt.with) !== -1) &&
        (!filt.project || (filt.project === '-' ? !x.project : x.project === filt.project)) &&
        (!filt.vis || (filt.vis === 'private') === !!x.private);
    }
    // Who can read a conversation (firestore.rules seesConversation): an open one, whoever sees Conversations;
    // a private one, only its readers (Slack user ids: a private Slack channel's members, whoever talked with
    // BOLD LLM, or whoever it was shared with). Its starter, a PI or an admin can change it (changesWhoReads).
    var names = null, idOf = {}, idByEmail = {};   // people: Slack id → name, name → Slack id, email → Slack id; loaded with the list
    function loadNames(){
      if (names !== null) return;
      names = {};
      db().collection('people').get().then(function(snap){
        snap.docs.forEach(function(d){ var v = d.data(), id = v.slackId || d.id; if (v.name && /^U[A-Z0-9]+$/.test(id)) { names[id] = v.name; idOf[v.name] = id; if (v.email) idByEmail[String(v.email).toLowerCase()] = id; } });
        render(); drawPicks();
      }, function(){});
    }
    var readersOpen = {};   // { pid: true }: its Who can read it unfolded, kept across redraws
    var who = null;   // Change, open: { pid, private } (its people: picks.who)
    var starterOf = function(p){ return String(p.createdBy || (p.broughtBy || {}).email || '').toLowerCase(); };
    function canChangeWho(p){ return canPost && !!me.slackId && (starterOf(p) === me.email || full); }
    var lvName = function(){ return BOLD.whoCan ? BOLD.whoCan('conversations', 'view') : 'whoever sees Conversations'; };
    function namesOf(list){
      var known = list.map(function(id){ return names && names[id]; }).filter(Boolean).sort(), rest = list.length - known.length;
      return known.join(', ') + (rest ? (known.length ? ', and ' : '') + rest + ' not on BOLD.OS' : '');
    }
    // A Slack thread's channel members, as far as known (slackReaders; before it, its readers, while untouched).
    var channelOf = function(p){ return p.slackReaders || (!p.accessBy && p.private ? p.readers || [] : null); };
    function readersHtml(p){
      var editing = who && who.pid === p.id;
      // One line, folded: who, in short; unfolded: who exactly, and why, and Change.
      var line = function(short, more){
        var set = p.accessBy ? ' Set by ' + esc(p.accessByName || 'someone') + '.' : '';
        return '<details class="bs-readers" data-pid="' + esc(p.id) + '"' + (readersOpen[p.id] || editing ? ' open' : '') + '><summary title="Who can read it" aria-label="Who can read it: ' + esc(short.replace(/<[^>]+>/g, '')) + '">' + EYE + short +
          '<span class="bs-readers-caret" aria-hidden="true"></span>' +
          // Invite, right after who (a click on it doesn't fold the line: the click handler stops it).
          (canPost ? '<span class="bs-readers-sep" aria-hidden="true">·</span><button type="button" class="btn-text bs-invite-btn">Invite</button>' : '') + '</summary>' +
          (editing ? whoForm(p) : '<p class="bs-readers-more">' + more + set + (canChangeWho(p) ? ' <button type="button" class="btn-text bs-who-change">Change</button>' : '') + '</p>') + '</details>';
      };
      if (!p.private) {
        return line(esc(lvName()), 'Open: whoever can view Conversations, ' + esc(lvName()) + ' (BOLDiquette › Who can do what). PIs and admins see no more than that.');
      }
      var list = p.readers || [];
      loadNames();
      if (p.source === 'bold-llm' && list.length <= 1) return line('only you', 'A talk with BOLD LLM: nobody else, not even PIs or admins.');
      var ch = p.slack && p.slack.channelName;
      if (p.source === 'slack' && !p.accessBy) {
        return line('only ' + (ch ? esc(ch) + '’s' : 'the Slack channel’s') + ' members' + (list.length ? ' (' + list.length + ')' : ''),
          'Brought in from a private Slack channel, so only its members see it here, PIs and admins too only if they’re in it' + (list.length ? ': ' + esc(namesOf(list)) : '') + '.');
      }
      return line('only ' + list.length + ' ' + (list.length === 1 ? 'person' : 'people'), 'Private: only ' + esc(namesOf(list)) + ', PIs and admins too only if they’re among them.');
    }
    // The people picker (one for Change, a new chat and Invite): picks[key] = { ids: [Slack id], lock: an id that
    // can't be removed (you), only: the ids it may offer (else everyone in people), typed }. It draws itself in
    // each .bs-pick[data-pick=key], and redraws alone (drawPick), so typing in it survives.
    var picks = {};
    function pickInner(key){
      var st = picks[key]; if (!st) return '';
      var chips = st.ids.map(function(id){
        var locked = id === st.lock;
        return '<li class="bs-who-chip">' + esc((names && names[id]) || (id === me.slackId ? me.name : 'Someone not on BOLD.OS')) + (id === me.slackId ? ' (you)' : '') +
          (locked ? '' : '<button type="button" class="bs-who-x" data-id="' + esc(id) + '" aria-label="Remove">&times;</button>') + '</li>';
      }).join('');
      var people = Object.keys(idOf).sort().filter(function(n){ var id = idOf[n]; return st.ids.indexOf(id) === -1 && id !== me.slackId && (!st.only || st.only.indexOf(id) !== -1); });
      return (chips ? '<ul class="bs-who-chips">' + chips + '</ul>' : '') +
        '<input type="text" class="bs-who-add" list="bs-pick-' + key + '-' + uid + '" placeholder="' + esc(st.placeholder || 'Add someone…') + '" aria-label="Add someone" autocomplete="off" value="' + esc(st.typed || '') + '">' +
        '<datalist id="bs-pick-' + key + '-' + uid + '">' + people.map(function(n){ return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>';
    }
    function pickHtml(key){ return '<div class="bs-pick" data-pick="' + key + '">' + pickInner(key) + '</div>'; }
    function drawPick(key){
      Array.prototype.forEach.call(root.querySelectorAll('.bs-pick[data-pick="' + key + '"]'), function(el){
        var had = document.activeElement && el.contains(document.activeElement);
        el.innerHTML = pickInner(key);
        if (had) { var i = el.querySelector('.bs-who-add'); if (i) i.focus(); }
      });
    }
    function drawPicks(){ Object.keys(picks).forEach(drawPick); }
    // Change: open, or only the people chosen (always you among them).
    function whoForm(p){
      var lv = lvName();
      return '<form class="bs-who" data-pid="' + esc(p.id) + '">' +
        '<label><input type="radio" name="bs-who" value="open"' + (who.private ? '' : ' checked') + '> Open: whoever can view Conversations, ' + esc(lv) + '</label>' +
        '<label><input type="radio" name="bs-who" value="private"' + (who.private ? ' checked' : '') + '> Private: only these people</label>' +
        (who.private ? pickHtml('who') : '') +
        '<div class="bs-who-actions"><button type="submit" class="btn-box is-primary">Save</button><button type="button" class="btn-box bs-who-cancel">Cancel</button></div></form>';
    }
    // A private Slack channel's text reaching people it wasn't said to: the warning, or ''.
    function slackWarn(p, opening, added){
      if (!(p.source === 'slack' && p.slack && p.private)) return '';
      var ch = p.slack.channelName || '', chan = channelOf(p), lv = lvName();
      var outside = added.filter(function(id){ return !chan || chan.indexOf(id) === -1; });
      return opening ? 'This came from the private Slack channel ' + ch + '. Everyone who can view Conversations (' + lv + ') will read all of it, which its members may not expect: you may be leaking what was said there.'
        : outside.length ? 'This came from the private Slack channel ' + ch + '. ' + namesOf(outside) + (outside.length === 1 ? ' isn’t' : ' aren’t') + ' in it and will read all of it: you may be leaking what was said there.' : '';
    }
    function saveWho(p){
      var was = { private: !!p.private, readers: p.readers || [] };
      var readers = who.private ? picks.who.ids.filter(function(id, i, a){ return a.indexOf(id) === i; }) : was.readers;
      if (who.private && readers.indexOf(me.slackId) === -1) readers.push(me.slackId);
      var added = who.private ? readers.filter(function(id){ return !was.private || was.readers.indexOf(id) === -1; }) : [];
      var removed = who.private && was.private ? was.readers.filter(function(id){ return readers.indexOf(id) === -1; }) : [];
      if (was.private === who.private && !added.length && !removed.length) { who = null; render(); return; }
      var lv = lvName(), opening = was.private && !who.private, sharing = was.private && who.private && added.length;
      // Wider than a private Slack channel: warned, as what was said there reaches people it wasn't said to.
      var warn = slackWarn(p, opening, added);
      var effects = [];
      if (!who.private) effects.push('Open it to whoever can view Conversations (' + lv + ')');
      else if (!was.private) effects.push('Make it private: only ' + namesOf(readers) + ' will read it; nobody else, PIs and admins included, unless among them');
      else {
        if (added.length) effects.push('Let ' + namesOf(added) + ' read all of it');
        if (removed.length) effects.push('Stop ' + namesOf(removed) + ' reading it');
      }
      if (opening || sharing) effects.push({ key: 'tell', text: opening ? 'Tell everyone who can now read it, on their Notifications page' : 'Tell ' + namesOf(added) + ', on their Notifications page' });
      BOLD.confirmAlways({ title: 'Change who can read “' + p.title + '”?', go: 'Change it', warn: warn, effects: effects }).then(function(r){
        if (!r) return;
        return col().doc(p.id).update({ private: who.private, readers: readers, accessBy: me.email, accessByName: me.name, accessAt: FV().serverTimestamp(),
          accessTell: !!(opening || sharing) && !(r.skip && r.skip.tell) }).then(function(){ who = null; delete picks.who; render(); }, oops('Changing who can read it'));
      });
    }
    // Invite: people told (Slack and their Notifications page, onConversationInvite) that they're invited, and from
    // then on told of its replies as if they'd replied. An open one, anyone; a private one, its readers, or anyone
    // if you can change who reads it (they're added, warned as for Change).
    var inviting = '';   // the post whose Invite form is open
    function inviteHtml(p){
      if (inviting !== p.id) return '';
      return '<form class="bs-invite" data-pid="' + esc(p.id) + '"><p class="bs-invite-k">Invite people to it</p>' + pickHtml('invite') +
        '<div class="bs-who-actions"><button type="submit" class="btn-box is-primary">Invite</button><button type="button" class="btn-box bs-invite-cancel">Cancel</button></div></form>';
    }
    function sendInvite(p){
      var to = picks.invite.ids.slice();
      if (!to.length) return;
      var readers = p.readers || [], add = p.private ? to.filter(function(id){ return readers.indexOf(id) === -1; }) : [];
      var effects = [];
      if (add.length) effects.push('Let ' + namesOf(add) + ' read all of it');
      effects.push('Tell ' + namesOf(to) + ', on Slack and their Notifications page, that you invited them, and tell them of its replies from then on');
      BOLD.confirmAlways({ title: 'Invite them to “' + p.title + '”?', go: 'Invite', warn: slackWarn(p, false, add), effects: effects }).then(function(r){
        if (!r) return;
        var widen = add.length ? col().doc(p.id).update({ private: true, readers: readers.concat(add), accessBy: me.email, accessByName: me.name, accessAt: FV().serverTimestamp(), accessTell: false }) : Promise.resolve();
        return widen.then(function(){ return invite(p.id, to); }).then(function(){ inviting = ''; delete picks.invite; render(); }, oops('Inviting'));
      });
    }
    function invite(pid, to){ return col().doc(pid).collection('invites').add({ to: to, by: me.email, byName: me.name, at: FV().serverTimestamp() }); }
    var sort = 'top', replying = '', editing = '', said = [], draft = null, about = null;   // about: { pid, id }
    var accessVersion = 0, unwatch = [];   // the lists' listeners, replaced when access changes
    var db = function(){ return firebase.firestore(BOLD.getApp()); };
    var col = function(){ return db().collection('conversations'); };
    var FV = function(){ return firebase.firestore.FieldValue; };

    // ---------- what a message is ----------
    var ms = function(t){ return !t ? Date.now() : typeof t === 'number' ? t : t.toMillis ? t.toMillis() : Date.now(); };
    function ago(t){ var m = Math.round((Date.now() - ms(t)) / MIN); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
    var score = function(m){ var v = m.votes || {}; return Object.keys(v).reduce(function(s, k){ return s + (Number(v[k]) || 0); }, 0); };
    var mine = function(m){ return !!me.email && m.createdBy === me.email; };
    // A message's replies in the order they were written, whatever their votes: a conversation reads in order.
    // (Votes order the posts on the list: Top.)
    // A reply folds with its stored parent. Imported Slack messages addressed to the post
    // stay together at the top level in chronological order.
    var childrenByParent = new Map(), messageById = new Map();
    function indexReplies(pid, items){
      childrenByParent.clear(); messageById.clear();
      items.slice().sort(function(a, b){ return ms(a.at) - ms(b.at); }).forEach(function(m){
        if (m.id === pid) return;
        messageById.set(m.id, m);
        if (!childrenByParent.has(m.parent)) childrenByParent.set(m.parent, []);
        childrenByParent.get(m.parent).push(m);
      });
    }
    function kids(id){ return childrenByParent.get(id) || []; }
    // Depth-first, in reading order. Returning false skips that comment's descendants.
    function walkReplies(id, visit){
      var stack = [{ children: kids(id), index: 0 }];
      while (stack.length) {
        var level = stack[stack.length - 1];
        if (level.index === level.children.length) { stack.pop(); continue; }
        var m = level.children[level.index++];
        if (visit(m, stack.length) !== false && kids(m.id).length) {
          stack.push({ children: kids(m.id), index: 0 });
        }
      }
    }
    // Store only message IDs, scoped to this reader and post. A later deletion or a
    // reimport of old Slack messages must not turn a new reply count negative.
    var folds = Object.create(null);
    function foldKey(){ return 'boldConversationFolds:' + me.uid + ':' + openId; }
    function loadFolds(){
      folds = Object.create(null);
      if (!me.uid || !openId) return;
      try {
        var saved = JSON.parse(localStorage.getItem(foldKey()) || '{}');
        Object.keys(saved).forEach(function(id){ if (Array.isArray(saved[id])) folds[id] = saved[id]; });
      } catch (e){}
    }
    function saveFolds(){
      if (!me.uid || !openId) return;
      try {
        if (Object.keys(folds).length) localStorage.setItem(foldKey(), JSON.stringify(folds));
        else localStorage.removeItem(foldKey());
      } catch (e){}
    }
    function descendantIds(id){
      var ids = [];
      walkReplies(id, function(m){ ids.push(m.id); });
      return ids;
    }
    function reveal(id){
      var seen = new Set(), changed = false;
      while (messageById.has(id) && !seen.has(id)) {
        seen.add(id);
        if (folds[id]) { delete folds[id]; changed = true; }
        id = messageById.get(id).parent;
      }
      if (changed) saveFolds();
    }
    var count = function(k){ return k + (k === 1 ? ' reply' : ' replies'); };
    var postOf = function(id){ return (posts || []).filter(function(p){ return p.id === id; })[0]; };
    var msgOf = function(pid, id){ return pid === id ? postOf(pid) : (pid === openId ? messageById.get(id) : null); };

    function vote(m, inline){
      var v = (m.votes || {})[me.uid] || 0;
      return '<div class="bs-vote' + (inline ? ' bs-vote-inline' : '') + (v > 0 ? ' is-up' : v < 0 ? ' is-down' : '') + '">' +
        '<button type="button" class="bs-up" data-id="' + esc(m.id) + '" data-v="1" aria-pressed="' + (v > 0) + '" aria-label="Upvote" title="Upvote">▲</button>' +
        '<span class="bs-score">' + score(m) + '</span>' +
        '<button type="button" class="bs-up bs-down" data-id="' + esc(m.id) + '" data-v="-1" aria-pressed="' + (v < 0) + '" aria-label="Downvote" title="Downvote">▼</button></div>';
    }
    // Who wrote it: someone (or their agent), or, brought in from Slack, its author there.
    // Who wrote it, first and clearly, then when. Where a thread came from (Slack) is said after, at the
    // foot of its post (origin), not here.
    // The author: their profile (person.html), found by their email, or, for a Slack reply, by their name.
    function by(m, avatar){
      var id = idByEmail[String(m.createdBy || '').toLowerCase()] || (!m.createdBy && m.source === 'slack' && idOf[m.name]) || '';
      var n = esc(m.name || 'someone') + (m.viaAgent ? '’s agent' : '');
      if (avatar) n = '<span class="bs-avatar member-photo" aria-hidden="true" data-id="' + esc(id) + '" data-name="' + esc(m.name || 'Someone') + '"></span>' + n;
      return (id ? '<a class="bs-author" href="person.html?id=' + encodeURIComponent(id) + '">' + n + '</a>' : '<span class="bs-author">' + n + '</span>') + ' · ' + ago(m.at) +
        // Changed after it was written (Edit): said, with when on hover.
        (m.editedAt ? ' <span class="bs-edited" title="Edited ' + esc(ago(m.editedAt)) + '">(edited)</span>' : '');
    }
    // Edit: your own, written on the site (not one brought in from Slack or a comment thread).
    var editable = function(m){ return mine(m) && m.source === 'site'; };
    // Why a private one is private: a talk with BOLD LLM, or a private Slack channel's thread.
    function PRIVATE_TIP(m){ return m.source === 'bold-llm' ? 'A talk with BOLD LLM: only you see it' : 'Brought in from a private Slack channel: only its members see it here'; }
    function origin(m){
      // A proposed project's conversation (functions/index.js proposalThread): the project, linked (not on its own page).
      if (m.source === 'proposal' && m.project && !opts.thread) {
        return '<p class="bs-origin">A proposed project · <a href="project.html#id=' + encodeURIComponent(m.project) + '">' + esc(m.projectTitle || 'Open it') + '</a></p>';
      }
      // Started in a project's Conversations tab (project.js): which project, linked.
      if (m.source === 'site' && m.project) {
        return '<p class="bs-origin">About <a href="project.html#id=' + encodeURIComponent(m.project) + '&tab=conversations">' + esc(m.projectTitle || 'a project') + '</a></p>';
      }
      // Made from a comment thread on the BOLDiquette or a guide, or a card's comments: where, and a link back.
      if (m.source === 'comment' && m.from) {
        var f = m.from, card = f.kind === 'card';
        if ((card || f.kind === 'change' || f.kind === 'review') && opts.thread) return '';   // on the card, proposed change or paper itself
        if (f.kind === 'review') return '<p class="bs-origin">On the Internal Review of ' + esc(f.part || 'a paper') + (f.url ? ' · <a href="' + esc(f.url) + '">Open it</a>' : '') + '</p>';
        if (f.kind === 'change') return '<p class="bs-origin">On a proposed change to ' + esc(f.page || 'a page') + (f.part ? ' › ' + esc(f.part) : '') +
          (f.url ? ' · <a href="' + esc(f.url) + '">See it</a>' : '') + '</p>';
        return '<p class="bs-origin">' + (card ? 'On the card ' + esc(f.part || '') + ', in ' + esc(f.page || 'a project')
            : 'From a comment thread on ' + esc(f.page || 'a page') + (f.part ? ' › ' + esc(f.part) : '')) +
          (m.broughtBy && m.broughtBy.name && !card ? ', made a conversation by ' + esc(m.broughtBy.name) : '') +
          (f.url ? ' · <a href="' + esc(f.url) + '">' + (card ? 'Open the card' : 'See the passage') + '</a>' : '') + '</p>';
      }
      // A talk with BOLD LLM (functions/bold-llm.js, from the home page): theirs alone.
      if (m.source === 'bold-llm') return '<p class="bs-origin"><span class="bs-private" title="' + esc(PRIVATE_TIP(m)) + '">Private</span> · A talk with BOLD LLM, only you see it</p>';
      if (m.source !== 'slack' || !m.slack) return '';
      var s = m.slack;
      return '<p class="bs-origin">' + (m.private ? '<span class="bs-private" title="Brought in from a private Slack channel: only its members see it here">Private: ' + (s.channelName ? esc(s.channelName) + '’s' : 'the channel’s') + ' members</span> · ' : '') + 'From ' + (s.channelName ? esc(s.channelName) : 'Slack') +
        (m.broughtBy && m.broughtBy.name ? ', brought in by ' + esc(m.broughtBy.name) : '') +
        (s.permalink ? ' · <a href="' + esc(s.permalink) + '" target="_blank" rel="noopener">Open in Slack</a>' : '') + '</p>';
    }
    function acts(m, pid){
      var why = canPost ? '' : ' disabled title="' + esc(BOLD.cannotReason('conversations', 'edit')) + '"';
      // Reply: answers this message, nested under it. The post has none: the Add a comment button is below it.
      return '<p class="bs-acts">' +
        (m.id === pid ? '' : '<button type="button" class="btn-text bs-reply-btn" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' + why + '>Reply</button>') +
        (AGENT ? '<button type="button" class="btn-text bs-discuss" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' + (about && about.id === m.id ? ' disabled title="You’re reasoning about it with your agent"' : why) + '>Reason with your agent</button>' : '') +
        // Copy, Copy link and Remove: in its ⋯ menu (BOLD.moreMenuHtml).
        BOLD.moreMenuHtml([
          editable(m) && { label: 'Edit', cls: 'bs-edit', attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"', off: why ? BOLD.cannotReason('conversations', 'edit') : '' },
          { label: 'Copy', cls: 'bs-copy', attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' },
          { label: 'Copy link', cls: 'bs-link', attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' },
          { label: 'Remove', cls: 'bs-remove', danger: true, attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"', off: mine(m) || full ? '' : 'Only whoever wrote it, PIs and admins remove it' },
        ], 'More') + '</p>';
    }
    // Editing a message: its text in the box where it was, Save and Cancel (a .bs-replyform, data-edit, so it's
    // kept across redraws and Cmd+Enter saves it).
    function editForm(m, pid){
      var raw = pid === m.id ? (postOf(pid) || {}).body || '' : m.body || '';
      return '<form class="bs-replyform bs-editform" data-edit="1" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"><textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="5" maxlength="10000" aria-label="Edit your message">' + esc(raw) + '</textarea>' +
        '<div class="event-form-actions"><button type="submit" class="ev-save">Save</button><button type="button" class="bs-editcancel">Cancel</button></div></form>';
    }
    function replyForm(m, pid){
      return (replying === m.id ? '<form class="bs-replyform" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"><textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="5" maxlength="10000" placeholder="Your reply" aria-label="Your reply"></textarea>' +
          '<div class="event-form-actions"><button type="submit" class="ev-save">Reply</button><button type="button" class="bs-replycancel">Cancel</button></div></form>' : '');
    }
    // A message: who wrote it, its vote and buttons, its text, and its reply box when open.
    function msgHtml(m, pid, branches){
      var reply = m.id !== pid, folded = reply && Array.isArray(folds[m.id]), summary = '';
      var toggle = reply ? '<button type="button" class="bs-open" data-fold data-id="' + esc(m.id) + '" aria-expanded="' + !folded +
        '" aria-label="' + (folded ? 'Expand' : 'Collapse') + ' comment by ' + esc(m.name || 'someone') + '">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m8 4 8 8-8 8"/></svg></button>' : '';
      if (folded) {
        var ids = descendantIds(m.id), seen = new Set(folds[m.id]);
        var fresh = ids.filter(function(id){ return !seen.has(id); }).length;
        summary = '<span class="bs-fold-count">' + count(ids.length) +
          (fresh ? ' · <strong>' + fresh + ' new</strong>' : '') + '</span>';
      }
      var tag = reply ? 'article' : 'li';
      var row = '<' + tag + ' class="bs-line' + (about && about.id === m.id ? ' is-about' : '') + '" id="m-' + esc(m.id) + '">' +
        '<div class="bs-line-head"><p class="bs-by">' + by(m, reply) + '</p>' + toggle + summary +
        (folded ? '' : '<div class="bs-right">' + vote(m, true) + acts(m, pid) + '</div>') + '</div>' +
        (folded ? '' : (editing === m.id ? editForm(m, pid) : md(m.body)) + replyForm(m, pid)) + '</' + tag + '>';
      return reply ? '<li class="bs-node">' + row + (branches || '') + '</li>' : row;
    }
    function subtreeHtml(m, pid, depth){
      var children = kids(m.id);
      if (folds[m.id] || !children.length) return msgHtml(m, pid);
      // Stop indenting long exchanges on a narrow screen. Deeper comments still fold individually.
      if (depth >= 5) {
        var html = msgHtml(m, pid);
        walkReplies(m.id, function(child){ html += msgHtml(child, pid); return !folds[child.id]; });
        return html;
      }
      var label = 'Collapse thread by ' + esc(m.name || 'someone');
      var rail = '<button type="button" class="bs-branch-fold" data-fold data-id="' + esc(m.id) +
        '" aria-expanded="true" aria-label="' + label + '" title="' + label + '"><span aria-hidden="true">−</span></button>';
      var replies = children.map(function(c){ return subtreeHtml(c, pid, depth + 1); }).join('');
      return msgHtml(m, pid, '<div class="bs-branches">' + rail + '<ol class="bs-run">' + replies + '</ol></div>');
    }

    // ---------- the thread's tree, beside it ----------
    // Fixed in the blank space left of the thread (left out where there isn't room): a dot for the post
    // and each message, in the order they were written, top to bottom. A line of the conversation goes
    // straight down its lane; a branch steps out to a lane of its own. Leaves are filled; the message in
    // view has a ring. A dot opens its message (its branches unfolded) and scrolls to it.
    var treeEl = null, treeSeen = null, treeAt = '', treeSel = '';
    function drawTree(p){
      if (!p) { if (treeEl) treeEl.hidden = true; return; }
      if (!treeEl) {
        treeEl = document.createElement('nav'); treeEl.className = 'bs-tree'; treeEl.setAttribute('aria-label', 'The conversation as a tree');
        document.body.appendChild(treeEl);
        treeEl.addEventListener('click', function(e){
          var n = e.target.closest('[data-id]'); if (!n) return;
          var id = n.getAttribute('data-id');
          treeSel = id;
          reveal(id);
          render();
          var el = document.getElementById('m-' + id); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        window.addEventListener('resize', place);
        var ticking = false;
        window.addEventListener('scroll', function(){ if (ticking) return; ticking = true; requestAnimationFrame(function(){ ticking = false; place(); }); }, { passive: true });
      }
      var all = [p].concat((messages[p.id] || []).slice().sort(function(a, b){ return ms(a.at) - ms(b.at); }));
      var row = {}, lane = {}, next = 1;
      all.forEach(function(m, i){ row[m.id] = i; });
      // Lanes: how far in each message is shown (the post 0, its replies 1, theirs 2, …).
      lane[p.id] = 0;
      walkReplies(p.id, function(m, depth){ lane[m.id] = Math.min(depth, 5); next = Math.max(next, lane[m.id] + 1); });
      var R = all.length > 60 ? 8 : 12, L = 12, X = function(id){ return 8 + (lane[id] || 0) * L; }, Y = function(id){ return 8 + row[id] * R; };
      var W = 16 + (next - 1) * L, H = 16 + (all.length - 1) * R;
      var paths = '', dots = '';
      all.forEach(function(m){
        var par = m.id === p.id ? null : m.parent;
        if (par && row[par] !== undefined) {
          var x0 = X(par), y0 = Y(par), x1 = X(m.id), y1 = Y(m.id);
          paths += '<path data-to="' + esc(m.id) + '" d="M' + x0 + ' ' + y0 + (x0 === x1 ? 'V' + y1 : 'V' + (y1 - 4) + 'Q' + x0 + ' ' + y1 + ' ' + (x0 + 4) + ' ' + y1 + 'H' + x1) + '"/>';
        }
        var leaf = !kids(m.id).length;
        dots += '<circle data-id="' + esc(m.id) + '" class="' + (leaf ? 'is-leaf' : '') + '" cx="' + X(m.id) + '" cy="' + Y(m.id) + '" r="3.5"><title>' + esc((m.name || 'someone') + ': ' + String(m.id === p.id ? p.title : m.body || '').replace(/\s+/g, ' ').slice(0, 80)) + '</title></circle>';
      });
      treeEl.innerHTML = '<p class="bs-tree-head">Tree · ' + all.length + (all.length === 1 ? ' message' : ' messages') + '</p><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><g class="bs-tree-lines">' + paths + '</g>' + dots + '</svg>';
      treeEl.hidden = false;
      place(); watchSeen(); markSelected();
    }
    // The message clicked: its dot and the lines from the post down to it, and the message itself.
    function markSelected(){
      if (!treeEl) return;
      var on = {}, m = treeSel && msgOf(openId, treeSel), k = 0;
      while (m && k++ < 500) { on[m.id] = 1; m = m.parent && m.parent !== openId ? msgOf(openId, m.parent) : null; }
      var svg = treeEl.querySelector('svg'); if (svg) svg.classList.toggle('has-sel', !!treeSel);
      Array.prototype.forEach.call(treeEl.querySelectorAll('circle'), function(c){ var id = c.getAttribute('data-id'); c.classList.toggle('is-selected', id === treeSel); c.classList.toggle('is-path', !!on[id] || (!!treeSel && id === openId)); });
      Array.prototype.forEach.call(treeEl.querySelectorAll('path[data-to]'), function(x){ x.classList.toggle('is-path', !!on[x.getAttribute('data-to')]); });
      Array.prototype.forEach.call(threadEl.querySelectorAll('.bs-line'), function(el){ el.classList.toggle('is-selected', !!treeSel && el.id === 'm-' + treeSel); });
    }
    threadEl.addEventListener('click', function(e){
      if (e.target.closest('button, a, input, textarea, select, label, form')) return;
      var li = e.target.closest('.bs-line[id^="m-"]');
      if (!li) return;
      var id = li.id.slice(2);
      treeSel = treeSel === id ? '' : id;
      markSelected();
    });
    // Left of the thread, if there's room between it and the sidebar.
    function place(){
      if (!treeEl || treeEl.hidden && !openId) return;
      // Not on screen (a project's other tab): no tree.
      if (!root.isConnected) { treeEl.hidden = true; return; }
      var t = threadEl.getBoundingClientRect(), side = document.getElementById('sidebar'), s = side ? side.getBoundingClientRect() : null;
      var from = s && s.width && s.right < t.left ? s.right : 0, w = treeEl.offsetWidth || 40;
      var room = t.left - from - 32 >= w && !threadEl.hidden;
      treeEl.style.visibility = room ? 'visible' : 'hidden';
      treeEl.style.left = Math.max(from + 16, t.left - w - 24) + 'px';
      // Level with the thread's title, then held under the masthead as the page scrolls.
      var title = threadEl.querySelector('.bs-thread-title'), mast = document.querySelector('.masthead');
      var floor = mast ? Math.max(0, mast.getBoundingClientRect().bottom) + 12 : 72;
      treeEl.style.top = Math.max(floor, title ? title.getBoundingClientRect().top : t.top) + 'px';
      treeEl.style.maxHeight = 'calc(100vh - ' + (parseFloat(treeEl.style.top) + 24) + 'px)';
    }
    // The message in view: its dot gets a ring.
    function watchSeen(){
      if (treeSeen) treeSeen.disconnect();
      if (!('IntersectionObserver' in window)) return;
      treeSeen = new IntersectionObserver(function(es){
        es.forEach(function(x){ if (x.isIntersecting) treeAt = x.target.id.slice(2); });
        Array.prototype.forEach.call(treeEl.querySelectorAll('circle'), function(c){ c.classList.toggle('is-here', c.getAttribute('data-id') === treeAt); });
      }, { rootMargin: '-40% 0px -50% 0px' });
      Array.prototype.forEach.call(threadEl.querySelectorAll('.bs-line[id^="m-"]'), function(el){ treeSeen.observe(el); });
    }

    // A long message (over about 10 lines as shown) is folded, with Show more; opened, Show less.
    // Which are open is kept while the page is (`unfolded`, by message id).
    var unfolded = {}, CLAMP_LINES = 10;
    function clampLong(){
      Array.prototype.forEach.call(threadEl.querySelectorAll('.bs-line[id^="m-"]'), function(li){
        var text = li.querySelector(':scope > .bs-text'), id = li.id.slice(2);
        if (!text) return;
        var line = parseFloat(getComputedStyle(text).lineHeight) || 21;
        // A little over the limit isn't folded: it would hide only a line or two.
        if (text.scrollHeight <= line * CLAMP_LINES * 1.3) return;
        if (!unfolded[id]) { text.classList.add('is-clamped'); text.style.maxHeight = (line * CLAMP_LINES) + 'px'; }
        text.insertAdjacentHTML('afterend', '<button type="button" class="btn-text bs-more" data-id="' + esc(id) + '" aria-expanded="' + !!unfolded[id] + '">' + (unfolded[id] ? 'Show less' : 'Show more') + '</button>');
      });
    }

    // ---------- the list, or one post's thread ----------
    // The address: #post=<post id>, and &msg=<message id> for a link to one message in it. In a project, after
    // the project page's own (#id=…&tab=conversations&post=…).
    function route(){
      var h = location.hash, p = /[#&]post=([^&]+)/.exec(h), m = /[#&]msg=([^&]+)/.exec(h);
      if (opts.thread) return { post: opts.thread, msg: decodeURIComponent((m && m[1]) || '') };
      return { post: decodeURIComponent((p && p[1]) || ''), msg: decodeURIComponent((m && m[1]) || '') };
    }
    // The address without a post: the list.
    function base(){ return project ? location.hash.replace(/&(post|msg)=[^&]*/g, '') : currentTopic() ? topicHref(currentTopic()) : ''; }
    function postHash(pid, mid){
      // One conversation alone: its messages' links are the page's own address, with &msg=.
      if (opts.thread) return location.hash.replace(/&msg=[^&]*/g, '') + (mid && mid !== pid ? '&msg=' + encodeURIComponent(mid) : '');
      var b = topicPage && find.trim() ? '' : base();
      return (b ? b + '&' : '#') + 'post=' + encodeURIComponent(pid) + (mid && mid !== pid ? '&msg=' + encodeURIComponent(mid) : '');
    }
    var listHref = function(){ return base() || '#'; };
    var linkedMsg = route().msg;   // a link to a message: shown once its thread is in
    function msgLink(pid, id){ return location.origin + location.pathname + postHash(pid, id); }
    // The linked message: its branches unfolded down to it, selected (as from the tree), in view.
    function showLinked(pid){
      if (pid !== openId || !linkedMsg) return;
      var id = linkedMsg, m = msgOf(pid, id);
      linkedMsg = '';
      if (!m) return;
      reveal(id);
      treeSel = id;
      render();
      var el = document.getElementById('m-' + id); if (el) el.scrollIntoView({ block: 'center' });
    }
    // ---------- Top-level comment composer (replyBox) ----------
    // A reply to the post itself: the top level. One element, kept across the redraws (moved into each new
    // .bs-join), so what's written in it stays; a message's own Reply opens its own box.
    var answer = null, answerPid = '', parkedForm = null;
    function drawAnswer(p){
      var slot = threadEl.querySelector('.bs-join');
      if (!canPost || !slot) return;
      if (!answer) answer = replyBox({ label: 'Add a comment', button: 'Post comment', send: function(body){
        var q2 = postOf(answerPid); if (!q2) return Promise.reject(new Error('No such conversation'));
        return newReply(q2.id, q2.id, body, false).then(function(ref){ show(q2.id, ref.id); }, function(err){ oops('Replying')(err); throw err; });
      } });
      // Another conversation: an empty box, closed.
      if (answerPid !== p.id) { answerPid = p.id; answer.reset(); }
      answer.into(slot);
    }
    var unassigned = { id: '_unassigned', name: 'Awaiting a topic', icon: '🗂️' };
    function groupOf(post){ return topicById(ConversationTopics.topicOf(post)) || unassigned; }
    function backLink(){
      var topic = topicById(currentTopic()) || (currentTopic() === unassigned.id && unassigned);
      var label = !topicPage ? 'All posts' : find.trim() ? 'Search results' : topic ? topic.name : 'All topics';
      return '<a class="back-link" href="' + esc(listHref()) + '">&larr; ' + esc(label) + '</a>';
    }
    function topicControls(p){
      var t = groupOf(p);
      var why = t === unassigned ? 'This conversation is awaiting a topic' : canPost ? '' : BOLD.cannotReason('conversations', 'edit');
      return '<div class="bs-topic-tools"><a class="bs-open-topic" href="conversations.html' + topicHref(t.id) + '">' + esc(t.icon + ' ' + t.name) + '</a>' +
        '<button type="button" class="btn-text bs-pin" aria-pressed="' + !!p.pinned + '"' + (why ? ' disabled title="' + esc(why) + '"' : '') + '>' +
        (p.pinned ? PIN + 'Unpin' : 'Pin to topic') + '</button></div>';
    }
    function matchingReplies(p, query){
      var rank = window.BoldSearchRank;
      if (!query || !rank) return '';
      var matches = rank.rank(repliesForSearch(p.id), query).filter(function(hit){ return !hit.partial; });
      if (!matches.length) return '';
      return '<ul class="bs-matched-replies">' + matches.map(function(hit){
        var r = hit.item, snippet = rank.snippet(r.text, query, 110);
        return '<li><a href="' + esc(postHash(p.id, r.id)) + '">' + esc(r.where || 'Reply') + ' · ' + esc(snippet) + '</a></li>';
      }).join('') + '</ul>';
    }
    function topicPreview(topic, list){
      var limit = 3, more = list.length > limit;
      var cards = list.slice().sort(ConversationTopics.previewOrder).slice(0, limit).map(function(p){
        var post = topicHref(topic.id) + '&post=' + encodeURIComponent(p.id);
        var upvotes = Object.values(p.votes || {}).filter(function(v){ return Number(v) === 1; }).length;
        var comments = Number(p.replies) || 0, detail = 'bs-highlight-' + uid + '-' + esc(p.id);
        var flags = (p.pinned ? PINNED : '') + (p.private ? ' <span class="bs-private">Private</span>' : '');
        return '<li class="bs-highlight"><a class="bs-highlight-title" href="' + esc(post) + '" aria-describedby="' + detail + '">' + esc(p.title) + '</a>' +
          '<div class="bs-highlight-detail" id="' + detail + '">' + (flags ? '<div class="bs-highlight-flags">' + flags + '</div>' : '') +
          '<div class="bs-highlight-counts"><span>' + upvotes + (upvotes === 1 ? ' upvote' : ' upvotes') + '</span> ' +
          '<span>' + comments + (comments === 1 ? ' comment' : ' comments') + '</span></div></div></li>';
      }).join('');
      var arrow = '<span class="bs-topic-arrow" aria-hidden="true">›</span>';
      return '<li class="bs-topic"><h2><a class="bs-topic-heading" href="' + topicHref(topic.id) + '"><span><span aria-hidden="true">' + esc(topic.icon) + '</span> ' +
        esc(topic.name) + (more ? '' : arrow) + '</span>' +
        (more ? '<span class="bs-topic-all">View all ' + list.length + ' conversations' + arrow + '</span>' : '') + '</a></h2>' +
        (cards ? '<ul class="bs-highlights">' + cards + '</ul>' : '<p class="detail-muted">No conversations yet.</p>') + '</li>';
    }
    function render(){
      var open = route().post;
      // A peek given a conversation (an old index.html#post=… link): it opens on Conversations' page.
      if (open && opts.peek) { location.replace('conversations.html' + location.hash); return; }
      var p = open && postOf(open);
      // A direct link can open before sign-in. Subscribe once the reader's post query includes it.
      var visibleId = p ? open : '';
      if (visibleId !== openId) watchThread(visibleId);
      postsEl.hidden = !!open; sortEl.hidden = !!open; if (filtersEl) filtersEl.hidden = !!open || !showFilters; threadEl.hidden = !open;
      syncReplySearch();
      topicNav.hidden = true;
      var active = currentTopic(), query = find.trim(), directory = topicPage && !active && !query && !filtering();
      sortEl.querySelectorAll('.bs-sortbtn').forEach(function(button){ button.hidden = directory; });
      if (open) {
        if (importEl) importEl.hidden = true;
        if (writeEl) writeEl.hidden = true;
        if (posts === null || (p && messages[open] === undefined)) { threadEl.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
        if (!p) { threadEl.innerHTML = backLink() + '<p class="proj-msg">No such post: it may have been removed.</p>'; return; }
        // An open reply box is carried across the redraw (a reply or a vote arriving), with what's typed in it
        // and its Write | Preview tab.
        var keep = threadEl.querySelector('.bs-replyform') || parkedForm;
        parkedForm = null;
        // The post, under its title: its first message, with where it came from. With no text of its own (a card
        // with no description), only where it came from: Add a comment is right under the title.
        var first = Object.assign({}, p, { body: p.body && p.body.trim() !== p.title ? p.body : '' });
        var head = first.body ? '<ol class="bs-run bs-post-run">' + (function(h){ var i = h.lastIndexOf('</li>'); return h.slice(0, i) + origin(p) + h.slice(i); })(msgHtml(first, p.id)) + '</ol>' : origin(p);
        var top = kids(p.id);
        threadEl.innerHTML = (opts.thread ? '' : backLink()) +
          (opts.title === false ? '' : '<h2 class="bs-title bs-thread-title">' + esc(p.title) + '</h2>') +
          // Who can read it, and Invite right after it, on one line (readersHtml).
          '<div class="bs-meta">' + readersHtml(p) + '</div>' + inviteHtml(p) + topicControls(p) + head + '<div class="bs-join"></div>' +
          (top.length ? '<ol class="bs-run bs-top">' + top.map(function(m){ return subtreeHtml(m, p.id, 1); }).join('') + '</ol>' : '');
        BOLD.photo.mountMany(threadEl.querySelectorAll('.bs-avatar'));
        clampLong();
        drawTree(p);
        if (linkedMsg) { setTimeout(function(){ showLinked(p.id); }, 0); }
        drawAnswer(p);
        var fresh = threadEl.querySelector('.bs-replyform');
        if (keep && fresh && keep.getAttribute('data-id') === fresh.getAttribute('data-id') && keep.getAttribute('data-edit') === fresh.getAttribute('data-edit')) fresh.replaceWith(keep);
        else if (!fresh && keep && keep.getAttribute('data-pid') === p.id &&
                 keep.getAttribute('data-id') === (editing || replying)) parkedForm = keep;
        else { var f = fresh && fresh.querySelector('textarea'); if (f) f.focus(); }
        return;
      }
      drawTree(null);
      if (posts === null || (topicPage && !topicsReady)) { postsEl.innerHTML = '<li class="proj-msg">Loading&hellip;</li>'; return; }
      // A card's conversation made by opening the card (opened, functions/comment-conversation.js): left out until someone replies.
      var list = posts.filter(function(x){ return !(x.opened && !(x.replies > 0)); }).sort(sort === 'new' ? function(a, b){ return ms(b.at) - ms(a.at); } : function(a, b){ return score(b) - score(a) || ms(b.at) - ms(a.at); });
      fillFilters();
      if (filtering()) list = list.filter(passes);
      if (directory) {
        var groups = new Map(topics.map(function(t){ return [t, []]; }));
        list.forEach(function(p){ var t = groupOf(p); if (!groups.has(t)) groups.set(t, []); groups.get(t).push(p); });
        postsEl.innerHTML = Array.from(groups, function(entry){ return topicPreview(entry[0], entry[1]); }).join('') ||
          '<li class="proj-msg">No topics yet. Start a conversation to create one.</li>';
        return;
      }
      var t = topicById(active) || (active === unassigned.id && unassigned);
      if (topicPage) {
        topicNav.hidden = false;
        topicNav.innerHTML = '<a href="#">All topics</a> / ' + (query ? 'Search results' : t ? esc(t.icon + ' ' + t.name) : active ? 'Unknown topic' : 'Filtered conversations');
        if (active && !query) list = list.filter(function(p){ return groupOf(p).id === active; }).sort(function(a,b){ return Number(!!b.pinned) - Number(!!a.pinned); });
      }
      var empty = active && !query ? 'No conversations in this topic yet.' : project ? 'No conversations about this project yet.' : 'No posts yet.';
      if (filtering()) empty = 'No conversation matches these filters.';
      if (active && !t) empty = 'This topic is no longer available.';
      var status = '';
      if (query) {
        var ranked = list.map(function(p){
          var replies = repliesForSearch(p.id).map(function(r){ return r.where + ' ' + r.text; });
          return { title: p.title, where: [p.name, p.projectTitle].filter(Boolean).join(' '), text: [p.body].concat(replies).join(' '), post: p };
        });
        var rank = window.BoldSearchRank;
        list = rank ? rank.rank(ranked, query).filter(function(h){ return !h.partial; }).map(function(h){ return h.item.post; })
          : ranked.filter(function(r){ var hay = [r.title, r.where, r.text].join(' ').toLowerCase(); return query.toLowerCase().split(/\s+/).every(function(w){ return hay.includes(w); }); }).map(function(r){ return r.post; });
        empty = 'No conversation has “' + query + '”.';
        var entries = Array.from(replySearch.values());
        if (entries.some(function(e){ return !e.ready; })) status = 'Searching replies…';
        else if (entries.some(function(e){ return e.failed; })) status = 'Some replies couldn’t be searched.';
      }
      postsEl.innerHTML = list.length ? list.map(function(q){
        // A peek (the home page): each opens on Conversations' own page.
        var at = opts.peek ? 'conversations.html#post=' + encodeURIComponent(q.id) : postHash(q.id);
        return '<li class="bs-post' + (mine(q) ? ' is-mine' : '') + '" id="m-' + esc(q.id) + '">' + vote(q) +
          '<div class="bs-post-main">' + (q.pinned ? PINNED + ' ' : '') +
          (find.trim() ? '<span class="bs-result-topic">' + esc(groupOf(q).icon + ' ' + groupOf(q).name) + '</span>' : '') + '<h3 class="bs-title"><a href="' + at + '">' + esc(q.title) + '</a></h3><p class="bs-by">' + by(q) + (q.private ? ' · <span class="bs-private" title="' + esc(PRIVATE_TIP(q)) + '">Private</span>' : '') + '</p>' +
            (q.body && q.body.trim() !== q.title ? md(q.body).replace('class="bs-text md-desc"', 'class="bs-text md-desc bs-clip"') : '') +
            matchingReplies(q, query) + '<p class="bs-acts"><a href="' + at + '">' + count(q.replies || 0) + '</a></p></div></li>';
      }).join('') : '<li class="proj-msg">' + esc(status || empty) + '</li>';
      if (status && list.length) postsEl.insertAdjacentHTML('beforeend', '<li class="proj-msg">' + esc(status) + '</li>');
    }
    forumEl.addEventListener('click', function(e){
      if (!topicPage || !e.target.closest('.bs-topic-nav a, .bs-open-topic') || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      find = ''; findEl.value = ''; filt = { author: '', with: '', project: '', vis: '' }; render();
    });
    window.addEventListener('hashchange', function(){ if (!root.isConnected) return; replying = ''; linkedMsg = route().msg; render(); if (!linkedMsg) window.scrollTo(0, 0); });
    function watchThread(id){
      if (stopMsgs) { stopMsgs(); stopMsgs = null; }
      openId = id;
      childrenByParent.clear(); messageById.clear(); parkedForm = null;
      loadFolds();
      if (!id) return;
      delete messages[id];
      stopMsgs = col().doc(id).collection('messages').onSnapshot(function(snap){
        if (openId !== id) return;
        messages[id] = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        indexReplies(id, messages[id]);
        var active = document.activeElement;
        if (!threadEl.contains(active) || !active.matches('.bs-replyform textarea, .bs-answer textarea')) render();
      }, function(err){ if (openId !== id) return; console.error('[BOLD Lab] loading replies failed', err); messages[id] = []; indexReplies(id, []); render(); });
    }

    // ---------- writing ----------
    // readers: private to them (Slack ids, you among them), else open.
    function newPost(title, body, viaAgent, readers){
      if (!postPicker.required()) return Promise.reject(new Error('Choose a topic.'));
      var selection = postPicker.selection();
      var o = { topicId: selection.topicId, title: title, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {}, private: !!readers };
      if (readers) o.readers = readers;
      // In a project: about it (firestore.rules: one its poster sees).
      if (project) { o.project = project.id; o.projectTitle = String((project.title && project.title()) || '').slice(0, 300); }
      o.votes[me.uid] = 1;
      var post = col().doc(), topic = db().collection('conversationTopics').doc(selection.topicId);
      return db().runTransaction(async function(tx){
        var existing = await tx.get(topic);
        if (!existing.exists) {
          if (!selection.newTopic) throw new Error('That topic was removed. Choose another topic.');
          tx.set(topic, selection.newTopic);
        }
        tx.set(post, o);
        return post;
      });
    }
    // A reply answers `parent`, shown nested under it (`branch: true`; also read by older clients).
    function newReply(pid, parent, body, viaAgent){
      var o = { parent: parent, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {}, branch: true };
      o.votes[me.uid] = 1;
      if (folds[parent]) reveal(parent);
      return col().doc(pid).collection('messages').add(o);
    }
    var oops = function(what){ return function(e){ console.error('[BOLD Lab] ' + what + ' failed', e); alertBox(what + ' failed: ' + (e && e.message || e)); }; };
    function alertBox(t){ var p = q('.bs-note'); if (p) { p.textContent = t; p.classList.add('is-error'); } }

    // ---------- Reason with your agent (a preview: it drafts from your words) ----------
    function add(who, html, cls){
      var li = document.createElement('li');
      li.className = 'bs-msg' + (cls ? ' ' + cls : '');
      li.innerHTML = '<span class="bs-who">' + esc(who) + '</span><div class="bs-body">' + html + '</div>';
      log.appendChild(li);
      log.scrollTop = log.scrollHeight;
      return li;
    }
    add('Your agent', 'Think out loud with me. When something is worth sharing with the lab, I’ll draft a post, or a reply to one, and ask you before it goes out.');
    function label(a){
      var p = postOf(a.pid), m = msgOf(a.pid, a.id);
      if (!p) return 'a post';
      return a.id === a.pid ? '“' + p.title + '”' : ((m && m.name) || 'someone') + '’s reply in “' + p.title + '”';
    }
    function setAbout(a){
      about = a; said = [];
      aboutEl.hidden = !a;
      aboutEl.innerHTML = a ? 'About: <a href="' + esc(postHash(a.pid)) + '">' + esc(label(a)) + '</a> <button type="button" class="btn-text bs-unabout">Stop</button>' : '';
      text.placeholder = a ? 'What do you make of it?' : 'What are you thinking about?';
    }
    function makeDraft(){
      var all = said.join(' ').replace(/\s+/g, ' ').trim();
      if (about) return { reply: about, body: all };
      var first = (all.match(/^.*?[.?!](\s|$)/) || [all])[0].trim();
      var title = first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '…' : first;
      return { title: title.charAt(0).toUpperCase() + title.slice(1), body: all };
    }
    function offerDraft(){
      draft = makeDraft();
      add('Your agent', (draft.reply ? 'This adds to it. I’d reply:' : 'This seems worth sharing. I’d post:') +
        '<div class="bs-draft">' + (draft.title ? '<strong>' + esc(draft.title) + '</strong>' : '') + '<p>' + esc(draft.body) + '</p></div>' +
        '<div class="bs-draft-actions"><button type="button" class="btn btn-primary bs-post-it"' + (canPost ? '' : ' disabled title="' + esc(BOLD.cannotReason('conversations', 'edit')) + '"') + '>' + (draft.reply ? 'Reply' : 'Post it') + '</button>' +
        '<button type="button" class="btn bs-keep">Not yet</button></div>', 'has-draft');
    }
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var t = text.value.trim();
      if (!t) return;
      add(me.name, esc(t), 'is-mine');
      said.push(t); text.value = '';
      setTimeout(function(){
        if (said.length >= 2 || t.length > 160) offerDraft();
        else add('Your agent', about ? 'And how does that bear on what you’re working on?' : 'Go on: what makes you think so, and what would change your mind?');
      }, 400);
    });
    text.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    log.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b || b.disabled || !draft) return;
      var box = b.closest('.bs-draft-actions');
      if (b.classList.contains('bs-post-it')) {
        var d = draft; draft = null; b.disabled = true;
        var go = d.reply ? newReply(d.reply.pid, d.reply.id, d.body, true) : newPost(d.title, d.body, true);
        go.then(function(ref){
          box.innerHTML = '<span class="bs-done">' + (d.reply ? 'Replied.' : 'Posted.') + '</span>';
          add('Your agent', d.reply ? 'Replied. I’ll tell you if anyone picks it up.' : 'Posted. I’ll tell you when someone replies with something that bears on it.');
          said = [];
          if (!d.reply) postPicker.reset();
          var pid = d.reply ? d.reply.pid : ref.id;
          if (d.reply) setAbout(null);
          show(pid, d.reply ? ref.id : '');
        }, function(err){ b.disabled = false; draft = d; oops('Posting')(err); });
      } else if (b.classList.contains('bs-keep')) {
        box.innerHTML = '<span class="bs-done">Not posted.</span>'; draft = null;
        add('Your agent', 'Fine, we keep thinking. Tell me more.');
      }
    });
    aboutEl.addEventListener('click', function(e){
      if (!e.target.closest('.bs-unabout')) return;
      setAbout(null); render();
      add('Your agent', 'Back to whatever you’re thinking about.');
    });
    function fit(){ if (agentEl.hidden) return; var r = forumEl.getBoundingClientRect(); agentEl.style.left = r.left + 'px'; agentEl.style.width = r.width + 'px'; }
    window.addEventListener('resize', fit);
    function openAgent(){ agentEl.hidden = false; document.body.classList.add('bs-agent-open'); fit(); text.focus(); }
    function closeAgent(){ agentEl.hidden = true; document.body.classList.remove('bs-agent-open'); if (about) { setAbout(null); render(); } }
    agentEl.querySelector('.bs-close').addEventListener('click', closeAgent);
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !agentEl.hidden) closeAgent(); });
    writeEl.querySelector('.bs-new').hidden = !AGENT;
    writeEl.querySelector('.bs-new').addEventListener('click', function(){
      if (!postPicker.required()) return;
      writeEl.hidden = true;
      if (about) { setAbout(null); render(); }
      add('Your agent', 'A new chat. What are you thinking about?');
      openAgent();
    });
    function show(pid, mid){
      // A peek (the home page): a conversation, new or brought in, opens on Conversations' own page.
      if (opts.peek) { location.href = 'conversations.html#post=' + encodeURIComponent(pid) + (mid && mid !== pid ? '&msg=' + encodeURIComponent(mid) : ''); return; }
      var h = postHash(pid);
      if (location.hash !== h) location.hash = h.slice(1); else render();
      // Its thread open, all the way up, so it's in sight.
      setTimeout(function(){
        if (mid && msgOf(pid, mid)) { reveal(mid); render(); }
        var el = mid && document.getElementById('m-' + mid); if (el) el.scrollIntoView({ block: 'center' });
      }, 300);
    }

    // ---------- writing a post yourself, and bringing in a Slack thread ----------
    sortEl.querySelector('.bs-write').addEventListener('click', function(){
      importEl.hidden = true; writeEl.hidden = !writeEl.hidden;
      if (!writeEl.hidden) { syncNewWho(); writeEl.querySelector('input').focus(); }
    });
    writeEl.addEventListener('submit', function(e){
      e.preventDefault();
      var t = writeEl.querySelector('input').value.trim(), b = writeEl.querySelector('textarea').value.trim(), go = writeEl.querySelector('button[type=submit]');
      if (!t || !postPicker.required()) return;
      var mode = (writeEl.querySelector('input[name=bs-new-who]:checked') || {}).value || 'open';
      var others = mode === 'people' && picks.new ? picks.new.ids.filter(function(id){ return id !== me.slackId; }) : [];
      var readers = mode === 'open' ? null : [me.slackId].concat(others);
      var post = function(tell){
        go.disabled = true;
        return newPost(t, b || t, false, readers).then(function(ref){
          writeEl.reset(); postPicker.reset(); writeEl.hidden = true; picks.new = { ids: [] }; syncNewWho(); show(ref.id);
          if (tell && others.length) return invite(ref.id, others);
        }, oops('Posting')).then(function(){ go.disabled = false; });
      };
      if (!others.length) { post(false); return; }
      // With people: asked first, as it reaches them.
      BOLD.confirmAlways({ title: 'Start a private conversation?', go: 'Start it', effects: [
        'Only you and ' + namesOf(others) + ' will read it; nobody else, PIs and admins included',
        { key: 'tell', text: 'Tell ' + namesOf(others) + ', on Slack and their Notifications page, that you invited them' }] }).then(function(r){
        if (r) post(!(r.skip && r.skip.tell));
      });
    });
    // A new chat's Who can read it: the picker shows for "Me and the people I choose"; private needs a Slack sign-in.
    picks.new = { ids: [] };
    function syncNewWho(){
      var mode = (writeEl.querySelector('input[name=bs-new-who]:checked') || {}).value, el = writeEl.querySelector('.bs-pick[data-pick=new]');
      Array.prototype.forEach.call(writeEl.querySelectorAll('input[name=bs-new-who]'), function(r){ if (r.value !== 'open') { r.disabled = !me.slackId; r.parentNode.title = me.slackId ? '' : 'Needs a Slack sign-in'; } });
      el.hidden = mode !== 'people';
      if (!el.hidden) { loadNames(); drawPick('new'); }
    }
    writeEl.addEventListener('change', function(e){ if (e.target.name === 'bs-new-who') { syncNewWho(); var i = writeEl.querySelector('.bs-pick[data-pick=new] .bs-who-add'); if (i && !writeEl.querySelector('.bs-pick[data-pick=new]').hidden) i.focus(); } });
    writeEl.querySelector('.bs-write-cancel').addEventListener('click', function(){
      postPicker.reset(); writeEl.hidden = true; sortEl.querySelector('.bs-write').focus();
    });
    sortEl.querySelector('.bs-import').addEventListener('click', function(){
      writeEl.hidden = true; importEl.hidden = !importEl.hidden;
      if (!importEl.hidden) importEl.querySelector('input').focus();
    });
    // A Slack shortcut opens this same import form with its message link filled in.
    var importLink = !project && !opts.thread && !opts.peek && new URLSearchParams(location.hash.slice(1)).get('import');
    if (importLink) { importEl.querySelector('input[type=url]').value = importLink; importEl.hidden = false; }
    importEl.addEventListener('submit', function(e){
      e.preventDefault();
      var input = importEl.querySelector('input'), err = importEl.querySelector('.ev-error'), go = importEl.querySelector('button[type=submit]');
      if (!slackPicker.required()) return;
      err.hidden = true; go.disabled = true; go.textContent = 'Bringing it in…';
      firebase.app().functions('europe-west2').httpsCallable('slackThread')(Object.assign({ url: input.value.trim() }, slackPicker.selection(), project ? { project: project.id } : {})).then(function(res){
        input.value = ''; slackPicker.reset(); importEl.hidden = true;
        show(res.data.id);
      }, function(x){
        err.textContent = (x && x.message) || 'Couldn’t bring it in.'; err.hidden = false;
      }).then(function(){ go.disabled = false; go.textContent = 'Bring it in'; });
    });
    importEl.querySelector('.bs-import-cancel').addEventListener('click', function(){
      slackPicker.reset(); importEl.hidden = true; sortEl.querySelector('.bs-import').focus();
    });

    // ---------- votes, replies, folding, removing, reasoning ----------
    forumEl.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      var id = b.getAttribute('data-id'), pid = b.getAttribute('data-pid');
      if (b.classList.contains('bs-pin')) {
        var post = postOf(openId);
        if (post && canPost) col().doc(openId).update({ pinned: !post.pinned }).catch(oops('Updating pin'));
        return;
      }
      // Copy (its text, as written) and Copy link, from its ⋯ menu: the menu's button says it's done.
      if (b.classList.contains('bs-link') || b.classList.contains('bs-copy')) {
        var cm = id === pid ? postOf(pid) : msgOf(pid, id);
        var text = b.classList.contains('bs-link') ? msgLink(pid, id) : cm ? (id === pid ? [cm.title, cm.body && cm.body.trim() !== cm.title ? cm.body : ''].filter(Boolean).join('\n\n') : cm.body || '') : '';
        var mb = b.closest('.more-menu') && b.closest('.more-menu').querySelector('.more-menu-btn');
        var done = function(t){ if (!mb) return; mb.textContent = t; setTimeout(function(){ mb.textContent = '\u22ef'; }, 1500); };
        if (navigator.clipboard && text) navigator.clipboard.writeText(text).then(function(){ done(b.classList.contains('bs-link') ? 'Link copied' : 'Copied'); }, function(){ done('Couldn’t copy'); });
        else done('Couldn’t copy');
        return;
      }
      if (b.classList.contains('bs-more')) {
        unfolded[id] = !unfolded[id]; render();
        // Folding it again: back to the message, not left far below it.
        if (!unfolded[id]) { var mel = document.getElementById('m-' + id); if (mel && mel.getBoundingClientRect().top < 0) mel.scrollIntoView({ block: 'start' }); }
        return;
      }
      if (b.classList.contains('bs-up')) {
        // The same arrow again takes your vote back; the other one turns it round.
        var p = openId || id, isPost = !openId || id === openId, m = isPost ? postOf(id) : msgOf(openId, id);
        if (!m || !me.uid) return;
        var was = (m.votes || {})[me.uid] || 0, want = Number(b.getAttribute('data-v')), now = was === want ? 0 : want;
        var ref = isPost ? col().doc(id) : col().doc(p).collection('messages').doc(id), patch = {};
        patch['votes.' + me.uid] = now ? now : FV().delete();
        ref.update(patch).catch(oops('Voting'));
        return;
      }
      if (b.hasAttribute('data-fold')) {
        if (folds[id]) delete folds[id]; else folds[id] = descendantIds(id);
        saveFolds(); render();
        var button = threadEl.querySelector('.bs-open[data-id="' + CSS.escape(id) + '"]');
        if (button) button.focus({ preventScroll: !b.classList.contains('bs-branch-fold') });
        return;
      }
      if (b.classList.contains('bs-reply-btn')) {
        if (replying === id) replying = ''; else { replying = id; editing = ''; }
        render();
        var box = replying && threadEl.querySelector('.bs-replyform textarea');
        if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); }
        return;
      }
      if (b.classList.contains('bs-replycancel')) { replying = ''; render(); return; }
      if (b.classList.contains('bs-edit')) {
        editing = id; replying = ''; render();
        var eb = threadEl.querySelector('.bs-editform textarea');
        if (eb) { eb.focus(); eb.setSelectionRange(eb.value.length, eb.value.length); }
        return;
      }
      if (b.classList.contains('bs-editcancel')) { editing = ''; render(); return; }
      if (b.classList.contains('bs-remove')) {
        var isP = id === pid, what = isP ? postOf(id) : msgOf(pid, id);
        // Always asked, even with Don't ask me again: it can't be undone.
        BOLD.confirmAlways({ title: 'Remove ' + (isP ? '“' + (what ? what.title : 'this post') + '”' : 'this reply') + '?', effects: [isP ? 'Take the post and all its replies off Conversations, for everyone' : 'Take the reply off Conversations, for everyone', 'This can’t be undone'], go: 'Remove' })
          .then(function(ok){
            if (!ok) return;
            var r = isP ? col().doc(id) : col().doc(pid).collection('messages').doc(id);
            r.delete().then(function(){ if (isP) location.hash = listHref() === '#' ? '' : listHref().slice(1); }, oops('Removing'));
          });
        return;
      }
      if (b.classList.contains('bs-discuss')) {
        setAbout({ pid: pid, id: id }); render();
        var k = descendantIds(id).length;
        add('Your agent', 'Let’s reason about ' + esc(label(about)) + '. ' + (k ? count(k) + ' under it so far. ' : '') + 'What do you make of it?');
        openAgent();
        var el = document.getElementById('m-' + id);
        if (el) window.scrollBy(0, el.getBoundingClientRect().top - 90);
      }
    });
    // Cmd+Enter (Ctrl+Enter) sends a reply or a new post.
    forumEl.addEventListener('keydown', function(e){
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      var f = e.target.closest('.bs-replyform, .bs-write-form');
      if (!f || e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      var go = f.querySelector('button[type=submit]');
      if (go && !go.disabled) f.requestSubmit(go);
    });
    forumEl.addEventListener('submit', function(e){
      var f = e.target.closest('.bs-replyform');
      if (!f) return;
      e.preventDefault();
      var body = f.querySelector('textarea').value.trim(), go = f.querySelector('button[type=submit]');
      if (!body) return;
      go.disabled = true;
      if (f.getAttribute('data-edit')) {
        var epid = f.getAttribute('data-pid'), eid = f.getAttribute('data-id'), was = msgOf(epid, eid);
        if (was && body === String(was.body || '').trim()) { editing = ''; render(); return; }   // unchanged: not marked edited
        var eref = epid === eid ? col().doc(epid) : col().doc(epid).collection('messages').doc(eid);
        eref.update({ body: body, editedAt: FV().serverTimestamp() }).then(function(){ editing = ''; render(); }, function(err){ go.disabled = false; oops('Saving')(err); });
        return;
      }
      newReply(f.getAttribute('data-pid'), f.getAttribute('data-id'), body, false)
        .then(function(ref){ replying = ''; show(f.getAttribute('data-pid'), ref.id); }, function(err){ go.disabled = false; oops('Replying')(err); });
    });

    // The search box: the list redraws below it as you type (the box itself is left alone, spaces and all).
    var findEl = q('.bs-find');
    if (findEl) findEl.addEventListener('input', function(){ find = findEl.value; render(); });
    if (findEl) findEl.addEventListener('keydown', function(e){ if (e.key === 'Escape' && findEl.value) { e.stopPropagation(); findEl.value = ''; find = ''; render(); } });
    // The filters: With needs who replied, fetched as soon as the row is reached for.
    // Who can read it › Change, and Invite (their state: `who`, `inviting`, `picks`, so a redraw keeps them).
    threadEl.addEventListener('click', function(e){
      var t = e.target, p = openId && postOf(openId);
      if (!p) return;
      if (t.closest('.bs-who-change')) {
        e.preventDefault(); who = { pid: p.id, private: !!p.private };
        picks.who = { ids: (p.private ? (p.readers || []) : [me.slackId]).slice(), lock: me.slackId };
        loadNames(); render(); return;
      }
      if (t.closest('.bs-who-cancel')) { who = null; delete picks.who; render(); return; }
      if (t.closest('.bs-invite-btn')) {
        e.preventDefault();   // in the summary: not a fold
        if (inviting === p.id) { inviting = ''; delete picks.invite; render(); return; }
        inviting = p.id; loadNames();
        picks.invite = { ids: [], placeholder: 'Who? Start typing a name', only: p.private && !canChangeWho(p) ? (p.readers || []) : null };
        render(); var i = threadEl.querySelector('.bs-invite .bs-who-add'); if (i) i.focus(); return;
      }
      if (t.closest('.bs-invite-cancel')) { inviting = ''; delete picks.invite; render(); }
    });
    threadEl.addEventListener('change', function(e){
      var t = e.target;
      if (t.name === 'bs-who' && who) { who.private = t.value === 'private'; render(); }
    });
    threadEl.addEventListener('submit', function(e){
      var p = openId && postOf(openId);
      if (e.target.classList.contains('bs-who')) { e.preventDefault(); if (p && who) saveWho(p); }
      if (e.target.classList.contains('bs-invite')) { e.preventDefault(); if (p && picks.invite) sendInvite(p); }
    });
    // The pickers, wherever they are (Change, Invite, a new chat): adding by name, removing by ×.
    var pickOf = function(el){ var k = el.closest('.bs-pick'); return k && picks[k.getAttribute('data-pick')] ? k.getAttribute('data-pick') : ''; };
    var addPicked = function(input){
      var key = pickOf(input), id = idOf[input.value.trim()], st = picks[key];
      if (!st || !id || (st.only && st.only.indexOf(id) === -1)) return false;
      if (st.ids.indexOf(id) === -1) st.ids.push(id);
      st.typed = ''; drawPick(key); return true;
    };
    root.addEventListener('click', function(e){
      var x = e.target.closest('.bs-who-x'), key = x && pickOf(x);
      if (!key) return;
      picks[key].ids = picks[key].ids.filter(function(id){ return id !== x.getAttribute('data-id'); }); drawPick(key);
    });
    root.addEventListener('input', function(e){
      if (!e.target.classList.contains('bs-who-add')) return;
      var key = pickOf(e.target); if (!key) return;
      picks[key].typed = e.target.value;
      if (idOf[e.target.value.trim()]) addPicked(e.target);
    });
    root.addEventListener('keydown', function(e){
      if (e.target.classList && e.target.classList.contains('bs-who-add') && e.key === 'Enter') { e.preventDefault(); addPicked(e.target); }
    });
    // Who can read it, unfolded or folded: remembered for the redraws.
    threadEl.addEventListener('toggle', function(e){ var d = e.target; if (d.classList && d.classList.contains('bs-readers')) readersOpen[d.getAttribute('data-pid')] = d.open; }, true);
    if (filtersEl) {
      q('.bs-filterbtn').addEventListener('click', function(){ showFilters = !showFilters; render(); });
      filtersEl.addEventListener('change', function(e){
        var sel = e.target.closest('.bs-filter'); if (!sel) return;
        filt[sel.getAttribute('data-f')] = sel.value; sel.blur(); render();
      });
      filtersEl.querySelector('.bs-filter-clear').addEventListener('click', function(){ filt = { author: '', with: '', project: '', vis: '' }; render(); });
    }
    function syncSort(){ Array.prototype.forEach.call(root.querySelectorAll('.bs-sortbtn'), function(x){ x.setAttribute('aria-pressed', String(x.getAttribute('data-sort') === sort)); }); }
    sortEl.addEventListener('click', function(e){
      var b = e.target.closest('.bs-sortbtn'); if (!b) return;
      sort = b.getAttribute('data-sort'); syncSort(); render();
    });

    // ---------- who, and what's there ----------
    BOLD.onUser(function(u){ me.name = (u && u.displayName) || 'You'; me.uid = (u && u.uid) || ''; loadFolds(); });
    BOLD.onAccess(function(a){
      var version = ++accessVersion;
      unwatch.splice(0).forEach(function(stop){ stop(); });
      if (stopMsgs) { stopMsgs(); stopMsgs = null; }
      openId = ''; posts = null; messages = {}; topics = []; topicsReady = false; syncReplySearch(); topicNav.hidden = true;
      threadEl.replaceChildren(); postsEl.replaceChildren(); drawTree(null);
      postPicker.update(topics); slackPicker.update(topics);

      me.email = String((a && a.e) || '').toLowerCase();
      canPost = BOLD.can('conversations', 'edit'); full = BOLD.isFullWrite();
      // Starting a chat (New chat, Import from Slack), replying and voting: all Conversations' Edit.
      canStart = canPost;
      var startWhy = BOLD.cannotReason('conversations', 'edit');
      ['.bs-write', '.bs-import'].forEach(function(c){
        var b = sortEl.querySelector(c); b.disabled = !canStart; b.title = canStart ? '' : startWhy;
      });
      if (!BOLD.can('conversations', 'view')) { postsEl.innerHTML = '<li class="proj-msg">' + esc(BOLD.cannotReason('conversations', 'view')) + '</li>'; return; }
      // Open ones, and those brought in from a private Slack channel the viewer is in (readers: Slack user
      // ids; firestore.rules seesConversation): two queries, as the rules allow no list mixing them.
      var u = firebase.auth().currentUser, slackId = '';
      ((u && u.providerData) || []).forEach(function(p){ if (p.providerId === 'oidc.slack') slackId = p.uid; });
      me.slackId = slackId; loadNames();   // names: the authors' profiles, the pickers
      var parts = { open: [], mine: [] };
      var fail = function(err){ if (version !== accessVersion) return; console.error('[BOLD Lab] loading conversations failed', err); postsEl.innerHTML = '<li class="proj-msg">Couldn’t load the conversations.</li>'; };
      var merge = function(){
        var seen = {}; posts = [];
        parts.open.concat(parts.mine).forEach(function(p){ if (!seen[p.id]) { seen[p.id] = 1; posts.push(p); } });
        if (!postOf(openId) || !document.activeElement || !document.activeElement.closest('.bs-replyform, .bs-answer')) render();
      };
      var watch = function(qy, key){
        unwatch.push(qy.onSnapshot(function(snap){ if (version !== accessVersion) return; parts[key] = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); merge(); }, fail));
      };
      // In a project: the open ones about it (never private: started there, or from its cards).
      unwatch.push(conversationTopicPicker.watch(function(items){
        if (version !== accessVersion) return;
        topics = items; topicsReady = true;
        postPicker.update(topics); slackPicker.update(topics); render();
      }, function(err){
        if (version !== accessVersion) return;
        topicsReady = true; render(); oops('Loading topics')(err);
      }));
      // In a project: the open ones about it, and the private ones about it the viewer reads (Who can read it › Change).
      if (project) {
        watch(col().where('project', '==', project.id).where('private', '==', false), 'open');
        if (slackId) watch(col().where('project', '==', project.id).where('readers', 'array-contains', slackId), 'mine');
        return;
      }
      watch(col().where('private', '==', false), 'open');
      if (slackId) watch(col().where('readers', 'array-contains', slackId), 'mine');
    });
    render();
    // away(): it's been taken off the page (a project's other tab): its tree goes with it.
    return { el: root, away: function(){ if (treeEl) treeEl.hidden = true; } };
  }
  return { create: create, replyBox: replyBox, eye: EYE };
})();
