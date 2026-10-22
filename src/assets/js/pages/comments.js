// Comments (comments.html): every comment thread on BOLD.OS, newest activity first.
// Threads on a guide or the BOLDiquette (<collection>/{slug}/comments, comments.js)
// and on a paper's card on the Internal Review Board (its discussion and its
// checklist points' feedback, cards' `discussion` and `checklist[].comments`).
// Each links to the thread itself (#c= on a guide, &msg= on the board).
// Filters: open, involving me (I wrote in it or am tagged), resolved, all.
// comments.html?on=<collection>/<slug> shows one page's threads (its header links here).
(function(){
  var esc = BOLD.escapeHtml;
  var root = document.getElementById('comments');
  if (!root || !BOLD.getAuth()) return;
  var PAGE = 50;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FILTERS = [['open', 'Open'], ['me', 'Involving me'], ['resolved', 'Resolved'], ['all', 'All']];
  var threads = [], loaded = false, failed = false, show = 'open', shown = PAGE, me = null, mySlackId = '';
  var on = new URLSearchParams(location.search).get('on') || '';

  function day(ms){ var d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function short(t, n){ t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

  // A guide's or the BOLDiquette's comments, as threads.
  function pageThreads(docs, titles){
    var byId = {};
    docs.forEach(function(d){ byId[d.ref.path] = Object.assign({ id: d.id }, d.data()); });
    var out = {};
    docs.forEach(function(d){
      var c = byId[d.ref.path], page = d.ref.parent.parent, col = page.parent.id;
      if (col !== 'guides' && col !== 'handbook') return;
      var rootId = c.parent || c.id, key = page.path + '/' + rootId;
      var t = out[key] = out[key] || { key: key, page: page.path, msgs: [], where: col === 'guides' ? 'How to' : 'BOLDiquette',
        title: titles[page.path] || page.id,
        href: (col === 'guides' ? BOLD.guideHref(page.id) : page.id === 'boldiquette' ? 'boldiquette.html' : 'index.html') + '#c=' + encodeURIComponent(rootId) };
      var msg = { by: c.by ? (c.by.name || c.by.email) : 'Someone', email: c.by ? String(c.by.email || '').toLowerCase() : '', text: c.text, at: c.at || 0 };
      if (c.parent) t.msgs.push(msg);
      else {
        t.msgs.unshift(msg);
        t.quote = c.proposalId ? '' : c.quote; t.onProposal = !!c.proposalId; t.resolved = !!c.resolved;
      }
    });
    // A reply whose thread has gone is left out.
    return Object.keys(out).map(function(k){ return out[k]; }).filter(function(t){ return 'resolved' in t; });
  }

  // A card's discussion and checklist feedback, as threads.
  function cardThreads(doc, boards){
    var card = doc.data(), boardId = doc.ref.parent.parent.id;
    if (!boards[boardId]) return [];
    var base = 'audit-board.html#board=' + encodeURIComponent(boardId) + '&card=' + encodeURIComponent(doc.id);
    var one = function(m, point){
      var msgs = [m].concat(m.replies || []).map(function(x){
        return { by: x.author || 'Someone', email: String(x.authorEmail || '').toLowerCase(), text: x.body, at: x.timestamp || 0 };
      });
      return { key: doc.ref.path + '/' + m.id, msgs: msgs, where: boards[boardId], title: card.title || 'A paper', quote: point || '',
        resolved: false, href: base + '&msg=' + encodeURIComponent(m.id) };
    };
    return (card.discussion || []).filter(function(m){ return m && m.id; }).map(function(m){ return one(m, ''); })
      .concat([].concat.apply([], (card.checklist || []).map(function(it){
        return (it.comments || []).filter(function(m){ return m && m.id; }).map(function(m){ return one(m, it.label || ''); });
      })));
  }

  function load(){
    var db = firebase.firestore(BOLD.getApp());
    var titles = {}, boards = {};
    var guideTitles = ['guides', 'handbook'].map(function(col){
      return db.collection(col).get().then(function(s){ s.docs.forEach(function(d){ titles[d.ref.path] = d.data().title || d.id; }); });
    });
    // The venues on the board (approved, and any you proposed), as the board lists them.
    var venue = function(s){ s.docs.forEach(function(d){ boards[d.id] = d.data().label || d.id; }); };
    var venues = Promise.all([
      db.collection('boards').where('status', '==', 'approved').get().then(venue),
      db.collection('boards').where('status', '==', 'pending').where('proposedBy.email', '==', me.email).get().then(venue).catch(function(){}),
    ]);
    var mine = db.collection('people').where('email', '==', me.email).limit(1).get().then(function(s){
      if (!s.empty) mySlackId = s.docs[0].data().slackId || s.docs[0].id;
    }).catch(function(){});
    return Promise.all(guideTitles.concat([venues, mine])).then(function(){
      return Promise.all([db.collectionGroup('comments').get(), db.collectionGroup('cards').get()]);
    }).then(function(r){
      threads = pageThreads(r[0].docs, titles).concat([].concat.apply([], r[1].docs.map(function(d){ return cardThreads(d, boards); })));
      threads.forEach(function(t){ t.last = t.msgs.reduce(function(m, x){ return Math.max(m, x.at || 0); }, 0); });
      threads.sort(function(a, b){ return b.last - a.last; });
      loaded = true; render();
    }).catch(function(err){
      console.error('[BOLD Comments] loading the comments failed', err);
      loaded = true; failed = true; render();
    });
  }

  function involvesMe(t){
    return t.msgs.some(function(m){ return m.email === me.email || (mySlackId && String(m.text || '').indexOf('](' + mySlackId + ')') !== -1); });
  }
  function filtered(){
    return threads.filter(function(t){
      if (on && t.page !== on) return false;
      return show === 'all' || (show === 'open' && !t.resolved) || (show === 'resolved' && t.resolved) || (show === 'me' && involvesMe(t));
    });
  }

  function threadHtml(t){
    var first = t.msgs[0], n = t.msgs.length - 1, lastMsg = t.msgs[t.msgs.length - 1];
    return '<li class="lt-item">' +
      '<a class="lt-title" href="' + esc(t.href) + '">' + esc(t.title) + '</a>' +
      '<span class="lt-meta">' + esc(t.where) + ' · ' + esc(first.by) + ' · ' + esc(day(first.at)) +
        (n ? ' · ' + n + (n === 1 ? ' reply' : ' replies') + ', last by ' + esc(lastMsg.by) + ' ' + esc(day(lastMsg.at)) : '') +
        (t.resolved ? ' <span class="lt-status is-done">Resolved</span>' : '') + '</span>' +
      (t.onProposal ? '<span class="lt-label">On a proposed change</span>' : t.quote ? '<span class="cm-on">On “' + esc(short(t.quote, 140)) + '”</span>' : '') +
      '<p class="lt-text">' + BoldMarkdown.plain(short(first.text, 400)) + '</p>' +
      '</li>';
  }

  function render(){
    if (!me) { root.innerHTML = '<p class="proj-msg">Sign in to see the comments.</p>'; return; }
    if (!loaded) { root.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (failed) { root.innerHTML = '<p class="proj-msg">Couldn’t load the comments. Try reloading the page.</p>'; return; }
    var list = filtered();
    // One page's comments: named in the header, with the way back to it.
    var one = on && threads.filter(function(t){ return t.page === on; })[0];
    if (on) {
      var back = document.getElementById('cmBack'), seg = on.split('/');
      var href = seg[0] === 'guides' ? BOLD.guideHref(seg[1]) : seg[1] === 'boldiquette' ? 'boldiquette.html' : 'index.html';
      var title = one ? one.title : seg[1];
      back.hidden = false; back.href = href; back.textContent = '← ' + title;
      document.getElementById('cmTitle').textContent = 'Comments on ' + title;
      document.getElementById('cmNote').innerHTML = 'Its comment threads. <a href="comments.html">All comments</a>';
    }
    root.innerHTML = '<section class="block"><p class="cm-filters">' + FILTERS.map(function(f){
        return '<button type="button" class="btn-text cm-filter' + (show === f[0] ? ' is-current' : '') + '" data-show="' + f[0] + '" aria-pressed="' + (show === f[0]) + '">' + f[1] + '</button>';
      }).join('') + '</p>' +
      (list.length ? '<ul class="lt-list">' + list.slice(0, shown).map(threadHtml).join('') + '</ul>' : '<p class="proj-msg">No comments here.</p>') +
      (list.length > shown ? '<p class="cm-more"><button type="button" class="event-add cm-show-more">Show more</button></p>' : '') +
      '</section>';
  }

  root.addEventListener('click', function(e){
    var f = e.target.closest('.cm-filter');
    if (f) { show = f.getAttribute('data-show'); shown = PAGE; render(); return; }
    if (e.target.closest('.cm-show-more')) { shown += PAGE; render(); }
  });

  BOLD.onUser(function(user){
    me = user ? { email: String(user.email || '').toLowerCase(), name: user.displayName || '' } : null;
    threads = []; loaded = false; failed = false; mySlackId = '';
    render();
    if (me) load();
  });
})();
