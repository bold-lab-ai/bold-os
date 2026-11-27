// The letters page's drafts (pages/letters.js), as plain functions (no DOM, no Firebase), so
// they can be tested (tests/letter-drafts.test.cjs). What someone has typed and not sent yet is
// kept in their own browser only (localStorage, one entry per account): a request not asked yet
// (`ask`, under an id made here), changes to a request not saved yet (`edit`, under the
// request's id) and a first draft not sent yet (`first`, under the request's id). Nothing here
// reaches the server: a request changes, and its people hear on Slack, only when its form is sent.
(function(root){
  var KINDS = ['ask', 'edit', 'first'];
  // A draft nobody came back to is dropped after this long.
  var KEEP_MS = 90 * 86400000;

  // storage: localStorage (or anything with getItem/setItem/removeItem); uid: whose drafts;
  // now: () → ms, for the tests. → null when this browser keeps nothing (private mode, no storage).
  function store(storage, uid, now){
    if (!storage || !uid) return null;
    var key = 'boldLetterDrafts:' + uid;
    now = now || function(){ return Date.now(); };
    try { storage.setItem(key + ':probe', '1'); storage.removeItem(key + ':probe'); } catch (e){ return null; }

    // Everything kept, without what's too old or isn't a draft: { ask: { id: draft }, edit, first }.
    function read(){
      var all = null;
      try { all = JSON.parse(storage.getItem(key) || 'null'); } catch (e){}
      var out = {}, t = now();
      KINDS.forEach(function(kind){
        out[kind] = {};
        var got = all && typeof all === 'object' && all[kind];
        if (!got || typeof got !== 'object') return;
        Object.keys(got).forEach(function(id){
          var d = got[id];
          if (d && typeof d === 'object' && typeof d.at === 'number' && t - d.at < KEEP_MS) out[kind][id] = d;
        });
      });
      return out;
    }
    function write(all){
      try {
        var empty = KINDS.every(function(kind){ return !Object.keys(all[kind]).length; });
        if (empty) storage.removeItem(key); else storage.setItem(key, JSON.stringify(all));
        return true;
      } catch (e){ return false; }   // full, or switched off since: the form still works
    }

    return {
      get: function(kind, id){ return read()[kind][id] || null; },
      // → when it was saved (ms), or 0 if the browser refused. Read again first, so a draft
      // being written in another tab isn't overwritten by this one. at: to put one back as it was.
      put: function(kind, id, draft, at){
        var all = read();
        at = at || now();
        all[kind][id] = Object.assign({}, draft, { at: at });
        return write(all) ? at : 0;
      },
      drop: function(kind, id){
        var all = read();
        if (!all[kind][id]) return;
        delete all[kind][id];
        write(all);
      },
      // → [{ id, …draft }], the latest first.
      list: function(kind){
        var got = read()[kind];
        return Object.keys(got).map(function(id){ return Object.assign({ id: id }, got[id]); })
          .sort(function(a, b){ return b.at - a.at; });
      },
      // Drops the drafts of requests that are gone (withdrawn, or no longer the viewer's).
      prune: function(kind, ids){
        var all = read(), keep = {}, changed = false;
        (ids || []).forEach(function(id){ keep[id] = true; });
        Object.keys(all[kind]).forEach(function(id){ if (!keep[id]) { delete all[kind][id]; changed = true; } });
        if (changed) write(all);
      },
    };
  }

  // A draft's recipients as the form's rows, for a request being edited (`live`: its recipients
  // now). A letter that is in keeps who sends it, as the form doesn't let that change.
  function rows(drafted, live){
    var now = {};
    (live || []).forEach(function(r){ if (r && r.id) now[r.id] = r; });
    return (drafted || []).map(function(r){
      var was = r && r.id && now[r.id];
      if (!was || !was.submittedAt) return Object.assign({}, r, { submittedAt: null });
      return Object.assign({}, r, { submittedAt: was.submittedAt, sentBy: was.sentBy });
    });
  }

  // Whether a first draft being typed is what was sent already (nothing to keep).
  function sameFirst(a, b){
    a = a || {}; b = b || {};
    return ['text', 'url', 'note'].every(function(k){ return String(a[k] || '').trim() === String(b[k] || '').trim(); });
  }

  root.BoldLetterDrafts = { store: store, rows: rows, sameFirst: sameFirst, KEEP_MS: KEEP_MS };
})(this);
