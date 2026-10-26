// Search results (search.html?q=&in=), from the masthead's box (search-box.js).
// Everything the signed-in person can read, loaded here and searched in the page:
// the BOLDiquette's and the guides' parts, skills, events with their sessions and
// talks, projects (getAllProjects), people (members), papers on the review board, and comments,
// ranked by search-rank.js (BoldSearchRank: whole words, title first; shared with the agents'
// search). The sections down the side (BoldSearch.SCOPES) show how many results each has and pick one.
(function(){
  var esc = BOLD.escapeHtml;
  var list = document.getElementById('srResults'), side = document.getElementById('srScopes');
  if (!list || !BOLD.getAuth() || !window.BoldSearch || !window.BoldSearchRank) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var parsed = BoldSearch.parse(params.get('q') || '');
  var q = parsed.q, show = parsed.in || params.get('in') || '';
  if (!BoldSearch.scope(show)) show = '';
  var MAX = 100;
  var items = {}, done = {}, failed = {};   // by scope key

  // Markdown and tags as plain text.
  function plain(t){
    return String(t || '').replace(/@\[([^\]]+)\]\(U[A-Z0-9]+\)/g, '@$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_>#]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function item(title, where, text, href){ return { title: plain(title) || 'Untitled', where: where, text: plain(text), href: href }; }

  // ---------- what each section holds ----------
  function parts(col, page, prefix, where){
    return db.collection(col).get().then(function(s){
      var out = [];
      s.docs.forEach(function(d){
        var x = d.data(), url = page(d.id), name = x.title || d.id;
        out.push(item(name, where, x.description, url));
        (x.parts || []).forEach(function(p){
          out.push(item(p.title, name + (p.section ? ' › ' + p.section : ''), p.body, url + '#' + prefix + p.id));
        });
      });
      return out;
    });
  }
  var cards = null;
  function allCards(){
    if (!cards) cards = Promise.all([
      db.collectionGroup('cards').get(),
      db.collection('boards').where('status', '==', 'approved').get(),
    ]).then(function(r){
      var boards = {};
      r[1].docs.forEach(function(d){ boards[d.id] = d.data().label || d.id; });
      return r[0].docs.map(function(d){ return { id: d.id, board: d.ref.parent.parent.id, boardLabel: boards[d.ref.parent.parent.id], x: d.data() }; })
        .filter(function(c){ return c.boardLabel; });
    });
    return cards;
  }
  function cardHref(c){ return 'audit-board.html#board=' + encodeURIComponent(c.board) + '&card=' + encodeURIComponent(c.id); }
  var LOAD = {
    boldiquette: function(){
      return parts('handbook', function(id){ return id === 'boldiquette' ? 'boldiquette.html' : 'index.html'; }, '', 'BOLDiquette');
    },
    guides: function(){
      return parts('guides', function(id){ return BOLD.guideHref(id); }, 'p-', 'How to');
    },
    skills: function(){
      return db.collection('skills').get().then(function(s){
        return s.docs.map(function(d){ var x = d.data();
          return item(x.title || x.name || d.id, 'Skill', [x.name, x.description, x.body].join(' '), 'skill.html?skill=' + encodeURIComponent(d.id)); });
      });
    },
    events: function(){
      var talk = function(x){ return [x.abstract, x.speaker, x.affiliation, x.description, x.summary].filter(Boolean).join(' '); };
      return Promise.all([
        db.collection('events').where('hidden', '==', false).get(),
        db.collection('collabWeekSessions').get(),
        db.collection('collabWeekTalks').get(),
      ]).then(function(r){
        return r[0].docs.map(function(d){ var x = d.data(); return item(x.title, 'Event' + (x.place ? ' · ' + x.place : ''), [x.description, x.place].join(' '), x.page || 'event.html?event=' + encodeURIComponent(d.id)); })
          .concat(r[1].docs.map(function(d){ var x = d.data(); return item(x.title, 'Session', talk(x), 'session.html?session=' + encodeURIComponent(d.id)); }))
          .concat(r[2].docs.map(function(d){ var x = d.data(); return item(x.title, 'Talk' + (x.speaker ? ' · ' + x.speaker : ''), talk(x), 'talk.html?talk=' + encodeURIComponent(d.id)); }));
      });
    },
    projects: function(){
      return firebase.app().functions('europe-west2').httpsCallable('getAllProjects')({}).then(function(r){
        var d = r.data || {};
        return [].concat(d.ongoing || [], d.submission || [], d.planned || [], d.completed || []).map(function(p){
          return item(p.title, 'Project' + (p.owner ? ' · ' + p.owner : ''), [p.abstract, (p.keywords || []).join(' '), p.owner, (p.authors || []).map(function(a){ return a.name; }).filter(function(n){ return n !== p.owner; }).join(' ')].join(' '),
            'project.html#id=' + encodeURIComponent(p.projectId || p.cardId) + (p.boardId ? '&board=' + encodeURIComponent(p.boardId) : ''));
        });
      });
    },
    people: function(){
      // Each member's own page, by their Slack id (people/{id}).
      return Promise.all([db.collection('members').get(), db.collection('people').get().catch(function(){ return { docs: [] }; })]).then(function(r){
        var ids = {};
        r[1].docs.forEach(function(d){ var e = String(d.data().email || '').toLowerCase(); if (e) ids[e] = d.id; });
        return r[0].docs.map(function(d){ var x = d.data(), id = ids[String(x.email || d.id).toLowerCase()];
          return item(x.name || x.email, [x.role, x.institution].filter(Boolean).join(' · ') || 'Member', [x.interests, x.basedIn, x.pronouns, x.contact].join(' '),
            id ? 'person.html?id=' + encodeURIComponent(id) : 'people.html'); });
      });
    },
    board: function(){
      return allCards().then(function(cs){
        return cs.map(function(c){ return item(c.x.title, c.boardLabel, c.x.abstractText || c.x.abstract, cardHref(c)); });
      });
    },
    comments: function(){
      return Promise.all([db.collectionGroup('comments').get(), allCards(), db.collection('guides').get(), db.collection('handbook').get()]).then(function(r){
        var titles = {};
        r[2].docs.concat(r[3].docs).forEach(function(d){ titles[d.ref.path] = d.data().title || d.id; });
        var out = r[0].docs.map(function(d){
          var c = d.data(), page = d.ref.parent.parent, col = page.parent.id;
          if (col !== 'guides' && col !== 'handbook') return null;
          var url = col === 'guides' ? BOLD.guideHref(page.id) : page.id === 'boldiquette' ? 'boldiquette.html' : 'index.html';
          return item(titles[page.path] || page.id, 'Comment by ' + (c.by ? c.by.name || c.by.email : 'someone') + (c.resolved ? ' · resolved' : ''),
            [c.text, c.quote].join(' '), url + '#c=' + encodeURIComponent(d.id));
        }).filter(Boolean);
        r[1].forEach(function(cd){
          // Its discussion and its checklist points' feedback, replies included.
          var threads = [].concat.apply(cd.x.discussion || [], (cd.x.checklist || []).map(function(it){ return it.comments || []; }));
          var msgs = [].concat.apply([], threads.map(function(m){ return [m].concat(m.replies || []); })).filter(function(m){ return m && m.id; });
          msgs.forEach(function(m){
            out.push(item(cd.x.title, 'Comment by ' + (m.author || 'someone') + ' · ' + cd.boardLabel, m.body, cardHref(cd) + '&msg=' + encodeURIComponent(m.id)));
          });
        });
        return out;
      });
    },
  };

  // ---------- matching ----------
  var R = window.BoldSearchRank, query = R.prepare(q);
  var ranked = {};   // by scope key, once loaded
  function hits(key){
    if (!ranked[key]) ranked[key] = done[key] ? R.rank(items[key] || [], query) : [];
    return ranked[key];
  }
  function mark(text){ return R.highlight(text, query, esc, function(m){ return '<mark>' + m + '</mark>'; }); }
  function snippet(text){ return R.snippet(text, query, 230); }

  // ---------- drawing ----------
  function render(){
    document.getElementById('srTitle').textContent = q ? 'Results for “' + q + '”' : 'Search';
    var keys = BoldSearch.SCOPES.map(function(s){ return s.key; });
    var count = function(k){ return done[k] ? hits(k).filter(function(h){ return !h.partial; }).length : null; };
    var total = keys.every(function(k){ return done[k]; }) ? keys.reduce(function(n, k){ return n + count(k); }, 0) : null;
    side.innerHTML = [{ key: '', label: 'Everywhere' }].concat(BoldSearch.SCOPES).map(function(s){
      var n = s.key ? count(s.key) : total;
      return '<a class="sr-scope' + (s.key === show ? ' is-current' : '') + '" href="' + esc(BoldSearch.href(q, s.key)) + '"' + (s.key === show ? ' aria-current="page"' : '') + '>' +
        esc(s.label) + '<span class="sr-count">' + (n === null ? '…' : n) + '</span></a>';
    }).join('');
    if (!q) { list.innerHTML = '<p class="proj-msg">Type in the search box at the top.</p>'; return; }
    var want = show ? [show] : keys, loading = want.some(function(k){ return !done[k]; });
    // Every word matching comes first; then, if nothing does anywhere, the closest.
    var all = [].concat.apply([], want.map(function(k){ return hits(k).map(function(h){ return { it: h.item, s: h.score, partial: h.partial, key: k }; }); }));
    if (all.some(function(h){ return !h.partial; })) all = all.filter(function(h){ return !h.partial; });
    all.sort(function(a, b){ return b.s - a.s; });
    var partial = all.length && all[0].partial;
    var broke = want.filter(function(k){ return failed[k]; }).map(function(k){ return BoldSearch.scope(k).label; });
    list.innerHTML = (partial && !loading ? '<p class="proj-msg">Nothing has every word; these have most of them.</p>' : '') +
      (all.length ? '<ul class="sr-list">' + all.slice(0, MAX).map(function(h){
        return '<li class="sr-item"><a class="sr-title" href="' + esc(h.it.href) + '">' + mark(h.it.title) + '</a>' +
          '<span class="sr-where">' + (show ? '' : esc(BoldSearch.scope(h.key).label) + ' · ') + mark(h.it.where) + '</span>' +
          (h.it.text ? '<p class="sr-text">' + mark(snippet(h.it.text)) + '</p>' : '') + '</li>';
      }).join('') + '</ul>' : loading ? '' : '<p class="proj-msg">Nothing found' + (show ? ' in ' + esc(BoldSearch.scope(show).label) + '. <a href="' + esc(BoldSearch.href(q, '')) + '">Search everywhere</a>' : '') + '.</p>') +
      (all.length > MAX ? '<p class="proj-msg">Showing the first ' + MAX + '. Add a word to narrow it down.</p>' : '') +
      (loading ? '<p class="proj-msg">Searching&hellip;</p>' : '') +
      (broke.length ? '<p class="proj-msg">Couldn’t search ' + esc(broke.join(', ')) + '.</p>' : '');
  }

  var started = false;
  BOLD.onUser(function(user){
    render();
    if (!user || started || !q) return;
    started = true;
    Object.keys(LOAD).forEach(function(k){
      LOAD[k]().then(function(r){ items[k] = r; done[k] = true; ranked[k] = null; render(); })
        .catch(function(err){ console.error('[BOLD Search] searching ' + k + ' failed', err); items[k] = []; done[k] = true; failed[k] = true; ranked[k] = null; render(); });
    });
  });
})();
