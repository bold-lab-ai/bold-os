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
// BoldConversations.create({ project?: { id, title: () => its title }, note? }) → { el (kept: put it back after a redraw), away() }.
window.BoldConversations = (function(){
  // The forum's markup (once Conversations' page's).
  function shell(note){
    return '<p class="bs-note">' + BOLD.escapeHtml(note || 'Posts and replies are saved.') + '</p>' +
      '<div class="bs-cols"><section class="bs-forum" aria-label="Forum">' +
        '<div class="bs-sort" role="group" aria-label="Sort">' +
          '<button type="button" class="bs-sortbtn" data-sort="top" aria-pressed="true">Top</button>' +
          '<button type="button" class="bs-sortbtn" data-sort="new" aria-pressed="false">New</button>' +
          '<button type="button" class="btn bs-import">Import from Slack</button>' +
          '<button type="button" class="btn btn-primary bs-write">New chat</button></div>' +
        '<form class="event-form bs-import-form bs-write-form" hidden>' +
          '<label>Title<input type="text" maxlength="200" required></label>' +
          '<label>Text (optional)<textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="6" maxlength="10000"></textarea></label>' +
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
    root.innerHTML = shell(opts.note);
    var project = opts.project || null;
    var q = function(sel){ return root.querySelector(sel); };
    var postsEl = q('.bs-posts'), threadEl = q('.bs-thread'), sortEl = q('.bs-sort');
    var log = q('.bs-log'), form = q('.bs-compose'), text = q('.bs-compose textarea'), aboutEl = q('.bs-about');
    var importEl = q('.bs-slack-form'), writeEl = q('.bs-write-form'), agentEl = q('.bs-agent'), forumEl = q('.bs-forum');
    var esc = BOLD.escapeHtml, MIN = 60000;
    // Reasoning with your agent is off for now (2026-11-04): its button and New chat's link are left out;
    // the panel's code stays, to turn back on here.
    var AGENT = false;
    // A message's text: Markdown (Slack threads come in as it: functions/slack-thread.js), its single
    // line breaks kept, as in Slack.
    var md = function(t){ return '<div class="bs-text md-desc">' + BoldMarkdown.render(t, { breaks: true }) + '</div>'; };
    var me = { email: '', name: 'You', uid: '' }, canPost = false, canStart = false, full = false;
    var posts = null, messages = {}, openId = '', stopMsgs = null;
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
    function by(m){
      return '<span class="bs-author">' + esc(m.name || 'someone') + (m.viaAgent ? '’s agent' : '') + '</span> · ' + ago(m.at);
    }
    function origin(m){
      // Started in a project's Conversations tab (project.js): which project, linked.
      if (m.source === 'site' && m.project) {
        return '<p class="bs-origin">About <a href="project.html#id=' + encodeURIComponent(m.project) + '&tab=conversations">' + esc(m.projectTitle || 'a project') + '</a></p>';
      }
      // Made from a comment thread on the BOLDiquette or a guide, or a card's comments: where, and a link back.
      if (m.source === 'comment' && m.from) {
        var f = m.from, card = f.kind === 'card';
        return '<p class="bs-origin">' + (card ? 'From the comments on the card ' + esc(f.part || '') + ', in ' + esc(f.page || 'a project')
            : 'From a comment thread on ' + esc(f.page || 'a page') + (f.part ? ' › ' + esc(f.part) : '')) +
          (m.broughtBy && m.broughtBy.name ? ', made a conversation by ' + esc(m.broughtBy.name) : '') +
          (f.url ? ' · <a href="' + esc(f.url) + '">' + (card ? 'Open the card' : 'See the passage') + '</a>' : '') + '</p>';
      }
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
      return { post: decodeURIComponent((p && p[1]) || ''), msg: decodeURIComponent((m && m[1]) || '') };
    }
    // The address without a post: the list.
    function base(){ return project ? location.hash.replace(/&(post|msg)=[^&]*/g, '') : ''; }
    function postHash(pid, mid){
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
      if (open !== openId) watchThread(open);
      var p = open && postOf(open);
      postsEl.hidden = !!open; sortEl.hidden = !!open; threadEl.hidden = !open;
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
        threadEl.innerHTML = '<a class="back-link" href="' + esc(listHref()) + '">&larr; All posts</a>' +
          '<div class="bs-thread-head"><h2 class="bs-title bs-thread-title">' + esc(p.title) + '</h2>' + foldAllHtml(p) + '</div>' + columnHtml(p, p.id, head);
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
      postsEl.innerHTML = list.length ? list.map(function(q){
        var at = postHash(q.id);
        return '<li class="bs-post' + (mine(q) ? ' is-mine' : '') + '" id="m-' + esc(q.id) + '">' + vote(q) +
          '<div class="bs-post-main"><h3 class="bs-title"><a href="' + at + '">' + esc(q.title) + '</a></h3><p class="bs-by">' + by(q) + (q.private ? ' · <span class="bs-private" title="Brought in from a private Slack channel: only its members see it here">Private</span>' : '') + '</p>' +
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
    function newPost(title, body, viaAgent){
      var o = { title: title, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {}, private: false };
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
      if (!writeEl.hidden) writeEl.querySelector('input').focus();
    });
    writeEl.addEventListener('submit', function(e){
      e.preventDefault();
      var t = writeEl.querySelector('input').value.trim(), b = writeEl.querySelector('textarea').value.trim(), go = writeEl.querySelector('button[type=submit]');
      if (!t) return;
      go.disabled = true;
      newPost(t, b || t, false).then(function(ref){ writeEl.reset(); writeEl.hidden = true; show(ref.id); }, oops('Posting')).then(function(){ go.disabled = false; });
    });
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
      if (project) { watch(col().where('project', '==', project.id).where('private', '==', false), 'open'); return; }
      watch(col().where('private', '==', false), 'open');
      if (slackId) watch(col().where('readers', 'array-contains', slackId), 'mine');
    });
    render();
    // away(): it's been taken off the page (a project's other tab): its tree goes with it.
    return { el: root, away: function(){ if (treeEl) treeEl.hidden = true; } };
  }
  return { create: create };
})();
