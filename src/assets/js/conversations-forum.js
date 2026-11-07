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
          '<button type="button" class="btn btn-primary bs-write">New chat</button></div>' +
        // Filters (filtering()): who started it, who's in it, its project, open or private; with the search box.
        (peek ? '' : '<div class="bs-filters" role="group" aria-label="Filter conversations" hidden>' +
          '<select class="bs-filter" data-f="author" aria-label="Started by"></select>' +
          '<select class="bs-filter" data-f="with" aria-label="With"></select>' +
          '<select class="bs-filter" data-f="project" aria-label="Project"></select>' +
          '<select class="bs-filter" data-f="vis" aria-label="Who can read it"></select>' +
          '<button type="button" class="btn-text bs-filter-clear" hidden>Clear</button></div>') +
        '<form class="event-form bs-import-form bs-write-form" hidden>' +
          '<label>Title<input type="text" maxlength="200" required></label>' +
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
          '<label>Link to a Slack thread (in Slack: the message’s ⋯ menu → Copy link)<input type="url" placeholder="https://….slack.com/archives/…" required></label>' +
          '<p class="event-form-hint">Only a thread you can read in Slack: a public channel, or a private one you’re in. Its first message becomes the post, the rest its replies. In Slack, a message’s ⋯ menu → Take it to the BOLD OS does the same.</p>' +
          '<p class="ev-error" hidden></p>' +
          '<div class="event-form-actions"><button type="submit" class="ev-save">Bring it in</button><button type="button" class="bs-import-cancel">Cancel</button></div></form>' +
        '<ol class="bs-posts"></ol><article class="bs-thread" hidden></article></section>' +
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
    var find = '';   // the search box's text: the list shows only the posts it finds, best first (search-rank.js)
    var replyText = {};   // each post's replies as one text, fetched the first time the box or a filter is used
    var replyNames = {};  // and who wrote them, { pid: [name] }
    var filt = { author: '', with: '', project: '', vis: '' };
    var showFilters = false;   // the filters' row, opened by its icon
    function filtering(){ return !!(filt.author || filt.with || filt.project || filt.vis); }
    // The replies of every listed post not fetched yet, then the list again; once each.
    function fetchReplies(){
      (posts || []).forEach(function(x){
        if (replyText[x.id] !== undefined) return;
        replyText[x.id] = ''; replyNames[x.id] = [];
        col().doc(x.id).collection('messages').get().then(function(m){
          replyText[x.id] = m.docs.map(function(d){ return [d.data().name, d.data().body].join(' '); }).join(' ');
          replyNames[x.id] = m.docs.map(function(d){ return d.data().name; }).filter(Boolean);
          if (find.trim() || filt.with) render(); else fillFilters();
        }, function(){});
      });
    }
    // Who's in a conversation: who started it and everyone who replied.
    function people(x){ return [x.name].concat(replyNames[x.id] || []).filter(Boolean); }
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
    var EYE = '<svg class="bs-readers-eye" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
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
    var sort = 'top', opened = {}, replying = '', branching = false, said = [], draft = null, about = null;   // about: { pid, id }
    var unwatch = [];   // the lists' listeners, replaced when access changes
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
    // A thread is a tree: each message answers its parent. A Slack thread came in as replies to the post,
    // one after another: each is read as answering the one before (slack-<n> → slack-<n-1>); so did a
    // comment thread made a conversation (cm-<n>, functions/comment-conversation.js).
    var CHAINED = { slack: 'slack-', comment: 'cm-' };
    var parentOf = function(x){
      var pre = CHAINED[x.source], k = pre && x.parent === openId && new RegExp('^' + pre + '(\\d+)$').exec(x.id);
      if (k && +k[1] > 0 && (messages[openId] || []).some(function(y){ return y.id === pre + (k[1] - 1); })) return pre + (k[1] - 1);
      return x.parent;
    };
    var kids = function(id){ return (messages[openId] || []).filter(function(x){ return parentOf(x) === id; }).sort(function(a, b){ return ms(a.at) - ms(b.at); }); };
    // Where a message's column ends: its first reply, that one's first reply, … (each first reply continues the column).
    // A message's reply that goes on with its column: its first, unless that one branched out
    // (`branch`, Branch out); every other reply is a branch.
    var goesOn = function(id){ return kids(id).filter(function(x){ return !x.branch; })[0] || null; };
    var branchesOf = function(id){ var g = goesOn(id); return kids(id).filter(function(x){ return x !== g; }); };
    var leafOf = function(id){ var g = goesOn(id); return g ? leafOf(g.id) : id; };
    var total = function(id){ return kids(id).reduce(function(s, x){ return s + 1 + total(x.id); }, 0); };
    var count = function(k){ return k + (k === 1 ? ' reply' : ' replies'); };
    var postOf = function(id){ return (posts || []).filter(function(p){ return p.id === id; })[0]; };
    var msgOf = function(pid, id){ return pid === id ? postOf(pid) : (messages[pid] || []).filter(function(x){ return x.id === id; })[0]; };

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
    function by(m){
      var id = idByEmail[String(m.createdBy || '').toLowerCase()] || (!m.createdBy && m.source === 'slack' && idOf[m.name]) || '';
      var n = esc(m.name || 'someone') + (m.viaAgent ? '’s agent' : '');
      return (id ? '<a class="bs-author" href="person.html?id=' + encodeURIComponent(id) + '">' + n + '</a>' : '<span class="bs-author">' + n + '</span>') + ' · ' + ago(m.at);
    }
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
      // Reply goes on with the conversation, at the end of this message's column (its leaf); Branch
      // out, on any message, leaves are included, starts a new branch from it.
      var leaf = leafOf(m.id);
      return '<p class="bs-acts">' +
        '<button type="button" class="btn-text bs-reply-btn" data-pid="' + esc(pid) + '" data-id="' + esc(leaf) + '"' + (why || (leaf === m.id ? '' : ' title="Reply at the end of this conversation"')) + '>Reply</button>' +
        '<button type="button" class="btn-text bs-reply-btn" data-branch="1" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' + (why || ' title="Start a new branch from this message"') + '>Branch out</button>' +
        (AGENT ? '<button type="button" class="btn-text bs-discuss" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' + (about && about.id === m.id ? ' disabled title="You’re reasoning about it with your agent"' : why) + '>Reason with your agent</button>' : '') +
        // Copy, Copy link and Remove: in its ⋯ menu (BOLD.moreMenuHtml).
        BOLD.moreMenuHtml([
          { label: 'Copy', cls: 'bs-copy', attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' },
          { label: 'Copy link', cls: 'bs-link', attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' },
          { label: 'Remove', cls: 'bs-remove', danger: true, attrs: ' data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"', off: mine(m) || full ? '' : 'Only whoever wrote it, PIs and admins remove it' },
        ], 'More') + '</p>';
    }
    function replyForm(m, pid){
      return (replying === m.id ? '<form class="bs-replyform" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '" data-branch="' + (branching ? '1' : '') + '"><textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="5" maxlength="10000" placeholder="Your reply" aria-label="Your reply"></textarea>' +
          '<div class="event-form-actions"><button type="submit" class="ev-save">' + (branching ? 'Branch out' : 'Reply') + '</button><button type="button" class="bs-replycancel">Cancel</button></div></form>' : '');
    }
    // Replies as in Slack: the post's replies are one block, in order, a hairline between them. A
    // message's own replies are collapsed under it ("3 replies · last 2 h ago"); opened, they're a
    // block of their own, indented, where a run (each answering the one before) reads on in the block.
    function msgHtml(m, pid){
      // A leaf (nobody has answered it yet: where the conversation goes on) is marked.
      return '<li class="bs-line' + (goesOn(m.id) ? '' : ' is-leaf') + (about && about.id === m.id ? ' is-about' : '') + '" id="m-' + esc(m.id) + '">' +
        // The author, and on the same line, on the right, its vote and buttons.
        '<div class="bs-line-head"><p class="bs-by">' + by(m) + '</p><div class="bs-right">' + vote(m, true) + acts(m, pid) + '</div></div>' +
        md(m.body) + replyForm(m, pid) + '</li>';
    }
    var lastAt = function(id){ return kids(id).reduce(function(t, x){ return Math.max(t, ms(x.at), lastAt(x.id)); }, 0); };
    // A column: a message, then its first reply (made while it was a leaf: the conversation going on), and
    // so on. Every later reply to a message branches from it: a column of its own, indented under that
    // message, folded behind a toggle ("2 branches · 5 messages · last 2 h ago").
    function branchToggle(m, bs){
      var k = bs.reduce(function(t, c){ return t + 1 + total(c.id); }, 0), on = !!opened[m.id];
      var last = bs.reduce(function(t, c){ return Math.max(t, ms(c.at), lastAt(c.id)); }, 0);
      var what = bs.length + (bs.length === 1 ? ' branch' : ' branches') + ' · ' + k + (k === 1 ? ' message' : ' messages');
      return '<li class="bs-thread-toggle"><button type="button" class="btn-text bs-open" data-id="' + esc(m.id) + '" aria-expanded="' + on + '">' +
        '<span class="bs-caret" aria-hidden="true">' + (on ? '\u25be' : '\u25b8') + '</span>' + (on ? 'Hide ' + what : what + '<span class="bs-last"> · last ' + ago(last) + '</span>') + '</button></li>';
    }
    function columnHtml(first, pid, head){
      var out = '', m = first;
      while (m) {
        out += head && m === first ? head : msgHtml(m, pid);
        var bs = branchesOf(m.id);
        if (bs.length) out += branchToggle(m, bs) + (opened[m.id] ? '<li class="bs-branches">' + bs.map(function(c){ return columnHtml(c, pid); }).join('') + '</li>' : '');
        m = goesOn(m.id);
      }
      return '<ol class="bs-run">' + out + '</ol>';
    }

    // Expand all / Collapse all: every message's branches (opened), over the thread; shown when it has any.
    function branchingIds(p){ return [p].concat(messages[p.id] || []).filter(function(m){ return branchesOf(m.id).length; }).map(function(m){ return m.id; }); }
    function foldAllHtml(p){
      var ids = branchingIds(p);
      if (!ids.length) return '';
      var all = ids.every(function(id){ return opened[id]; });
      // The guides' look (guide.js foldAllButton): arrows, then the words, on the title's line.
      var icon = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (all ? '<path d="M4 7.5 8 3.5l4 4M4 12.5l4-4 4 4"/>' : '<path d="M4 3.5 8 7.5l4-4M4 8.5l4 4 4-4"/>') + '</svg>';
      return '<button type="button" class="bs-fold-all-btn" data-open="' + (all ? '0' : '1') + '">' + icon + (all ? 'Collapse all' : 'Expand all') + '</button>';
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
          var id = n.getAttribute('data-id'), m = msgOf(openId, id), k = 0;
          treeSel = id;
          while (m && parentOf(m) && k++ < 500) { opened[parentOf(m)] = true; m = msgOf(openId, parentOf(m)); }
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
      // Lanes: a message's first reply keeps its lane, later ones take new lanes.
      (function walk(id, l){
        lane[id] = l;
        var g = goesOn(id);
        kids(id).forEach(function(c){ walk(c.id, c === g ? l : next++); });
      })(p.id, 0);
      var R = all.length > 60 ? 8 : 12, L = 12, X = function(id){ return 8 + (lane[id] || 0) * L; }, Y = function(id){ return 8 + row[id] * R; };
      var W = 16 + (next - 1) * L, H = 16 + (all.length - 1) * R;
      var paths = '', dots = '';
      all.forEach(function(m){
        var par = m.id === p.id ? null : parentOf(m);
        if (par && row[par] !== undefined) {
          var x0 = X(par), y0 = Y(par), x1 = X(m.id), y1 = Y(m.id);
          paths += '<path data-to="' + esc(m.id) + '" d="M' + x0 + ' ' + y0 + (x0 === x1 ? 'V' + y1 : 'V' + (y1 - 4) + 'Q' + x0 + ' ' + y1 + ' ' + (x0 + 4) + ' ' + y1 + 'H' + x1) + '"/>';
        }
        var leaf = !goesOn(m.id);
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
      while (m && k++ < 500) { on[m.id] = 1; m = parentOf(m) && parentOf(m) !== openId ? msgOf(openId, parentOf(m)) : null; }
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
    function base(){ return project ? location.hash.replace(/&(post|msg)=[^&]*/g, '') : ''; }
    function postHash(pid, mid){
      // One conversation alone: its messages' links are the page's own address, with &msg=.
      if (opts.thread) return location.hash.replace(/&msg=[^&]*/g, '') + (mid && mid !== pid ? '&msg=' + encodeURIComponent(mid) : '');
      var b = base();
      return (b ? b + '&' : '#') + 'post=' + encodeURIComponent(pid) + (mid && mid !== pid ? '&msg=' + encodeURIComponent(mid) : '');
    }
    var listHref = function(){ return base() || '#'; };
    var linkedMsg = route().msg;   // a link to a message: shown once its thread is in
    function msgLink(pid, id){ return location.origin + location.pathname + postHash(pid, id); }
    // The linked message: its branches unfolded down to it, selected (as from the tree), in view.
    function showLinked(pid){
      var id = linkedMsg, m = msgOf(pid, id), n = 0;
      linkedMsg = '';
      if (!m) return;
      while (m && parentOf(m) && n++ < 500) { opened[parentOf(m)] = true; m = msgOf(pid, parentOf(m)); }
      treeSel = id;
      render();
      var el = document.getElementById('m-' + id); if (el) el.scrollIntoView({ block: 'center' });
    }
    function render(){
      var open = route().post;
      // A peek given a conversation (an old index.html#post=… link): it opens on Conversations' page.
      if (open && opts.peek) { location.replace('conversations.html' + location.hash); return; }
      if (open !== openId) watchThread(open);
      var p = open && postOf(open);
      postsEl.hidden = !!open; sortEl.hidden = !!open; if (filtersEl) filtersEl.hidden = !!open || !showFilters; threadEl.hidden = !open;
      if (open) {
        if (importEl) importEl.hidden = true;
        if (writeEl) writeEl.hidden = true;
        if (posts === null || messages[open] === undefined) { threadEl.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
        if (!p) { threadEl.innerHTML = '<a class="back-link" href="' + esc(listHref()) + '">&larr; All posts</a><p class="proj-msg">No such post: it may have been removed.</p>'; return; }
        // An open reply box is carried across the redraw (a reply or a vote arriving), with what's typed in it
        // and its Write | Preview tab.
        var keep = threadEl.querySelector('.bs-replyform');
        // The post is the tree's root: the first message of the conversation's column, under its title.
        var first = Object.assign({}, p, { body: p.body && p.body.trim() !== p.title ? p.body : '' });
        var head = (function(h){ var i = h.lastIndexOf('</li>'); return h.slice(0, i) + origin(p) + h.slice(i); })(msgHtml(first, p.id));
        threadEl.innerHTML = (opts.thread ? '' : '<a class="back-link" href="' + esc(listHref()) + '">&larr; All posts</a>') +
          // Its title, unless the page shows it already (a card's, title: false); the head stays for Expand all.
        '<div class="bs-thread-head">' + (opts.title === false ? '' : '<h2 class="bs-title bs-thread-title">' + esc(p.title) + '</h2>') + foldAllHtml(p) + '</div>' +
          // Who can read it, and Invite right after it, on one line (readersHtml).
          '<div class="bs-meta">' + readersHtml(p) + '</div>' + inviteHtml(p) + columnHtml(p, p.id, head);
        clampLong();
        drawTree(p);
        if (linkedMsg) { setTimeout(function(){ showLinked(p.id); }, 0); }
        var fresh = threadEl.querySelector('.bs-replyform');
        if (keep && fresh && keep.getAttribute('data-id') === fresh.getAttribute('data-id') && keep.getAttribute('data-branch') === fresh.getAttribute('data-branch')) fresh.replaceWith(keep);
        else { var f = fresh && fresh.querySelector('textarea'); if (f) f.focus(); }
        return;
      }
      drawTree(null);
      if (posts === null) { postsEl.innerHTML = '<li class="proj-msg">Loading&hellip;</li>'; return; }
      var list = posts.slice().sort(sort === 'new' ? function(a, b){ return ms(b.at) - ms(a.at); } : function(a, b){ return score(b) - score(a) || ms(b.at) - ms(a.at); });
      fillFilters();
      if (filtering()) {
        if (filt.with) fetchReplies();
        list = list.filter(passes);
        if (!list.length) { postsEl.innerHTML = '<li class="proj-msg">No conversation matches these filters.</li>'; return; }
      }
      // Searching: the posts whose title, text, author, project or replies have every word, the whole phrase first,
      // as the site's search ranks them; each post's place in Top or New breaks ties.
      if (find.trim()) {
        fetchReplies();
        var R = window.BoldSearchRank;
        list = R ? R.rank(list.map(function(x, i){ return { title: x.title, where: [x.name, x.projectTitle].filter(Boolean).join(' '), text: [x.body, replyText[x.id]].join(' '), x: x, i: i }; }), find)
          .filter(function(h){ return !h.partial; }).map(function(h){ return h.item.x; })
          : list.filter(function(x){ var hay = [x.title, x.body, x.name, x.projectTitle, replyText[x.id]].join(' ').toLowerCase(); return find.toLowerCase().split(/\s+/).filter(Boolean).every(function(w){ return hay.indexOf(w) !== -1; }); });
        if (!list.length) { postsEl.innerHTML = '<li class="proj-msg">No conversation has “' + esc(find.trim()) + '”.</li>'; return; }
      }
      postsEl.innerHTML = list.length ? list.map(function(q){
        // A peek (the home page): each opens on Conversations' own page.
        var at = opts.peek ? 'conversations.html#post=' + encodeURIComponent(q.id) : postHash(q.id);
        return '<li class="bs-post' + (mine(q) ? ' is-mine' : '') + '" id="m-' + esc(q.id) + '">' + vote(q) +
          '<div class="bs-post-main"><h3 class="bs-title"><a href="' + at + '">' + esc(q.title) + '</a></h3><p class="bs-by">' + by(q) + (q.private ? ' · <span class="bs-private" title="' + esc(PRIVATE_TIP(q)) + '">Private</span>' : '') + '</p>' +
            (q.body && q.body.trim() !== q.title ? md(q.body).replace('class="bs-text md-desc"', 'class="bs-text md-desc bs-clip"') : '') +
            '<p class="bs-acts"><a href="' + at + '">' + count(q.replies || 0) + '</a></p></div></li>';
      }).join('') : '<li class="proj-msg">' + (project ? 'No conversations about this project yet: start one, or bring in a Slack thread.' : 'No posts yet: write one, start a chat with your agent, or bring in a Slack thread.') + '</li>';
    }
    window.addEventListener('hashchange', function(){ if (!root.isConnected) return; replying = ''; linkedMsg = route().msg; render(); if (!linkedMsg) window.scrollTo(0, 0); });
    function watchThread(id){
      if (stopMsgs) { stopMsgs(); stopMsgs = null; }
      openId = id;
      if (!id) return;
      stopMsgs = col().doc(id).collection('messages').onSnapshot(function(snap){
        messages[id] = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        if (!threadEl.querySelector('.bs-replyform textarea:focus')) render();   // typing: wait (the box is kept anyway)
      }, function(err){ console.error('[BOLD Lab] loading replies failed', err); messages[id] = []; render(); });
    }

    // ---------- writing ----------
    // readers: private to them (Slack ids, you among them), else open.
    function newPost(title, body, viaAgent, readers){
      var o = { title: title, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {}, private: !!readers };
      if (readers) o.readers = readers;
      // In a project: about it (firestore.rules: one its poster sees).
      if (project) { o.project = project.id; o.projectTitle = String((project.title && project.title()) || '').slice(0, 300); }
      o.votes[me.uid] = 1;
      return col().add(o);
    }
    // branch: it starts a new branch from `parent` rather than going on with its column (Branch out).
    function newReply(pid, parent, body, viaAgent, branch){
      var o = { parent: parent, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {} };
      if (branch) o.branch = true;
      o.votes[me.uid] = 1;
      opened[parent] = true;
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
        var m = mid && msgOf(pid, mid), n = 0;
        while (m && parentOf(m) && parentOf(m) !== pid && n++ < 50) { opened[parentOf(m)] = true; m = msgOf(pid, parentOf(m)); }
        opened[pid] = true;
        if (n) render();
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
      if (!t) return;
      var mode = (writeEl.querySelector('input[name=bs-new-who]:checked') || {}).value || 'open';
      var others = mode === 'people' && picks.new ? picks.new.ids.filter(function(id){ return id !== me.slackId; }) : [];
      var readers = mode === 'open' ? null : [me.slackId].concat(others);
      var post = function(tell){
        go.disabled = true;
        return newPost(t, b || t, false, readers).then(function(ref){
          writeEl.reset(); writeEl.hidden = true; picks.new = { ids: [] }; syncNewWho(); show(ref.id);
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
    writeEl.querySelector('.bs-write-cancel').addEventListener('click', function(){ writeEl.hidden = true; });
    sortEl.querySelector('.bs-import').addEventListener('click', function(){
      writeEl.hidden = true; importEl.hidden = !importEl.hidden;
      if (!importEl.hidden) importEl.querySelector('input').focus();
    });
    importEl.addEventListener('submit', function(e){
      e.preventDefault();
      var input = importEl.querySelector('input'), err = importEl.querySelector('.ev-error'), go = importEl.querySelector('button[type=submit]');
      err.hidden = true; go.disabled = true; go.textContent = 'Bringing it in…';
      firebase.app().functions('europe-west2').httpsCallable('slackThread')(Object.assign({ url: input.value.trim() }, project ? { project: project.id } : {})).then(function(res){
        input.value = ''; importEl.hidden = true;
        show(res.data.id);
      }, function(x){
        err.textContent = (x && x.message) || 'Couldn’t bring it in.'; err.hidden = false;
      }).then(function(){ go.disabled = false; go.textContent = 'Bring it in'; });
    });
    importEl.querySelector('.bs-import-cancel').addEventListener('click', function(){ importEl.hidden = true; });

    // ---------- votes, replies, folding, removing, reasoning ----------
    forumEl.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      var id = b.getAttribute('data-id'), pid = b.getAttribute('data-pid');
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
      if (b.classList.contains('bs-open')) { opened[id] = !opened[id]; render(); return; }
      if (b.classList.contains('bs-fold-all-btn')) {
        var on = b.getAttribute('data-open') === '1', fp = postOf(openId);
        if (fp) branchingIds(fp).forEach(function(x){ opened[x] = on; });
        render(); return;
      }
      if (b.classList.contains('bs-reply-btn')) {
        var br = b.getAttribute('data-branch') === '1';
        if (replying === id && branching === br) replying = ''; else { replying = id; branching = br; }
        render();
        // Reply on a message further up: the box is at the column's end.
        var box = replying && threadEl.querySelector('.bs-replyform textarea');
        if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); }
        return;
      }
      if (b.classList.contains('bs-replycancel')) { replying = ''; render(); return; }
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
        var k = id === pid ? total(pid) : total(id);
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
      newReply(f.getAttribute('data-pid'), f.getAttribute('data-id'), body, false, f.getAttribute('data-branch') === '1')
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
      q('.bs-filterbtn').addEventListener('click', function(){ showFilters = !showFilters; if (showFilters) fetchReplies(); render(); });
      filtersEl.addEventListener('pointerenter', fetchReplies);
      filtersEl.addEventListener('focusin', fetchReplies);
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
    BOLD.onUser(function(u){ me.name = (u && u.displayName) || 'You'; me.uid = (u && u.uid) || ''; });
    BOLD.onAccess(function(a){
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
      var fail = function(err){ console.error('[BOLD Lab] loading conversations failed', err); postsEl.innerHTML = '<li class="proj-msg">Couldn’t load the conversations.</li>'; };
      var merge = function(){
        var seen = {}; posts = [];
        parts.open.concat(parts.mine).forEach(function(p){ if (!seen[p.id]) { seen[p.id] = 1; posts.push(p); } });
        if (!document.activeElement || !document.activeElement.closest('.bs-replyform')) render();
      };
      var watch = function(qy, key){
        unwatch.push(qy.onSnapshot(function(snap){ parts[key] = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); merge(); }, fail));
      };
      // In a project: the open ones about it (never private: started there, or from its cards).
      if (unwatch.length) { unwatch.forEach(function(f){ f(); }); unwatch = []; }
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
  return { create: create };
})();
