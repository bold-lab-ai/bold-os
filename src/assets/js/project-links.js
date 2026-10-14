// Projects and the event programme, from the event's side: a talk's, a session's
// and an event's page list the projects that presented there, and let someone on
// a project add a presentation to it, linked to this talk, session or event.
// Presentations (projectWorkspaces/{id}/presentations, see pages/project.js) name
// where they were given in `occasion` ({ kind: 'event', id: event slug, label,
// sessionSlug, sessionTitle, talkSlug, talkTitle }); they're found across every
// project with a collection-group query on occasion.talkSlug, occasion.sessionSlug
// or occasion.id (index overrides in firestore.indexes.json).
//
// BoldProjectLinks.create({ field: 'talkSlug' | 'sessionSlug' | 'id', slug,
//   occasion() → the occasion, prefill() → { title, presenter, date, slidesUrl },
//   onChange }) → { load(user), rowHtml() (a dt/dd pair), lineHtml() (a paragraph) }.
window.BoldProjectLinks = (function(){
  var esc = BOLD.escapeHtml;
  var seq = 0;

  function projectHref(id, w){
    return 'project.html#id=' + encodeURIComponent(w.cardId || id) + (w.boardId ? '&board=' + encodeURIComponent(w.boardId) : '') + '&tab=presentations';
  }

  function create(opts){
    var key = 'bpl' + (++seq);
    var db = null, me = null, list = [], mine = null, open = false, busy = false, error = '', added = null;
    function changed(){ opts.onChange(); }

    // The projects presented here.
    function find(){
      return db.collectionGroup('presentations').where('occasion.' + opts.field, '==', opts.slug).get().then(function(snap){
        var ids = [];
        snap.docs.forEach(function(d){
          var o = d.data().occasion || {};
          if (o.kind !== 'event') return;   // occasion.id is also a venue's, for presentations at a venue
          var id = d.ref.parent.parent.id;
          if (ids.indexOf(id) < 0) ids.push(id);
        });
        return Promise.all(ids.map(function(id){ return db.collection('projectWorkspaces').doc(id).get(); }));
      }).then(function(snaps){
        list = snaps.filter(function(s){ return s.exists; }).map(function(s){ return { title: s.data().title || 'Untitled project', href: projectHref(s.id, s.data()) }; });
        changed();
      }).catch(function(err){ console.error('[BOLD Events] loading the projects presented here failed', err); });
    }

    // The projects the viewer is on: where they can add a presentation (firestore.rules).
    function loadMine(){
      if (mine) return;
      db.collection('projectWorkspaces').where('members', 'array-contains', me.email.toLowerCase()).get().then(function(snap){
        mine = snap.docs.map(function(d){ return { id: d.id, title: d.data().title || 'Untitled project', w: d.data() }; })
          .filter(function(p){ return p.w.group !== 'completed'; })
          .sort(function(a, b){ return a.title.localeCompare(b.title); });
        changed();
      }).catch(function(err){ console.error('[BOLD Events] loading your projects failed', err); mine = []; changed(); });
    }

    function load(user){
      me = user ? { email: user.email || '', name: user.displayName || '' } : null;
      list = []; mine = null; open = false; error = ''; added = null;
      if (!me || !opts.slug) return;
      try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
      find();
    }

    function save(projectId){
      var pre = opts.prefill() || {}, occasion = opts.occasion();
      if (!occasion || !occasion.id) { error = 'This page hasn’t finished loading — try again.'; return changed(); }
      var p = (mine || []).filter(function(x){ return x.id === projectId; })[0];
      var t = {
        title: String(pre.title || occasion.talkTitle || occasion.sessionTitle || occasion.label).slice(0, 200),
        date: /^\d{4}-\d\d-\d\d$/.test(pre.date || '') ? pre.date : new Date().toISOString().slice(0, 10),
        presenter: String(pre.presenter || me.name || '').slice(0, 200),
        occasion: occasion,
        slidesUrl: /^https?:\/\//i.test(pre.slidesUrl || '') ? pre.slidesUrl : '',
        recordingUrl: '',
        by: { email: me.email, name: me.name },
        at: Date.now()
      };
      busy = true; error = ''; changed();
      db.collection('projectWorkspaces').doc(projectId).collection('presentations').add(t).then(function(){
        busy = false; open = false; added = p ? { title: p.title, href: projectHref(p.id, p.w) } : null;
        find();
      }).catch(function(err){
        console.error('[BOLD Events] adding the presentation failed', err);
        busy = false; error = 'Couldn’t add it — try again.'; changed();
      });
    }

    // The list, and adding: a button, then the viewer's projects to choose from.
    function inner(){
      var links = list.map(function(p){ return '<a href="' + esc(p.href) + '">' + esc(p.title) + '</a>'; }).join(', ');
      var html = links;
      if (!me) return html;
      if (!open) {
        html += (links ? ' ' : '') + '<button type="button" class="btn-text bpl-open" data-bpl="' + key + '">+ Add to a project</button>';
      } else if (!mine) {
        html += '<span class="bpl-form detail-muted">Loading your projects…</span>';
      } else if (!mine.length) {
        html += '<span class="bpl-form detail-muted">You’re not on any project yet — join one from <a href="projects.html">Projects</a>.</span> ' +
          '<button type="button" class="btn-text bpl-cancel" data-bpl="' + key + '">Cancel</button>';
      } else {
        html += '<span class="bpl-form"><select class="bpl-project" data-bpl="' + key + '" aria-label="Project">' +
          mine.map(function(p){ return '<option value="' + esc(p.id) + '">' + esc(p.title) + '</option>'; }).join('') + '</select>' +
          '<button type="button" class="btn-text bpl-save" data-bpl="' + key + '"' + (busy ? ' disabled' : '') + '>Add</button>' +
          '<button type="button" class="btn-text bpl-cancel" data-bpl="' + key + '">Cancel</button></span>';
      }
      if (added) html += '<span class="bpl-note">Added to <a href="' + esc(added.href) + '">' + esc(added.title) + '</a>; edit it there.</span>';
      if (error) html += '<span class="bpl-note bpl-error">' + esc(error) + '</span>';
      return html;
    }
    function rowHtml(){
      if (!me && !list.length) return '';
      return '<dt>' + (list.length > 1 ? 'Projects' : 'Project') + '</dt><dd class="bpl">' + inner() + '</dd>';
    }
    function lineHtml(){
      if (!me && !list.length) return '';
      return '<p class="bpl bpl-line"><span class="bpl-label">' + (list.length ? 'Projects presented here: ' : 'Presented a project here? ') + '</span>' + inner() + '</p>';
    }

    document.addEventListener('click', function(e){
      var b = e.target.closest && e.target.closest('[data-bpl="' + key + '"]');
      if (!b || b.disabled || b.tagName === 'SELECT') return;
      if (b.classList.contains('bpl-open')) { open = true; added = null; error = ''; loadMine(); changed(); }
      else if (b.classList.contains('bpl-cancel')) { open = false; error = ''; changed(); }
      else if (b.classList.contains('bpl-save')) {
        var sel = document.querySelector('select[data-bpl="' + key + '"]');
        if (sel) save(sel.value);
      }
    });

    return { load: load, rowHtml: rowHtml, lineHtml: lineHtml };
  }

  return { create: create };
})();
