// The database an event's pages read (2026-11-03): Firestore for whoever may read the event
// directly, and, for everyone else (signed out, or PAN-BOLD, who can't read sessions, talks and
// proposals: firestore.rules eventContent), the cut-down copy of a public event the server gives
// out (publicEvent, functions/public-event.js), answered as if it were Firestore. So the Festival's
// pages draw the same way for a stranger, read-only.
// BOLD.eventDb() → a stand-in for firebase.firestore(): collection(), collectionGroup(), doc(),
// where(), orderBy(), limit(), get(), onSnapshot(), and writes and runTransaction, which always go to
// Firestore (the rules decide). Signed in, a read goes to Firestore and, refused, to the copy.
// Which event: the page's #eventBody data-event, or ?event=, ?edition=, ?session=, ?talk=.
(function(){
  var real = null;
  function fs(){ return real || (real = firebase.firestore(BOLD.getApp())); }

  // Signed in or not, once auth has said.
  var viewer, waiting = [];
  BOLD.onUser(function(u){ viewer = u || null; var w = waiting; waiting = []; w.forEach(function(f){ f(); }); });
  function whenKnown(fn){ if (viewer !== undefined) fn(); else waiting.push(fn); }

  // The public copy: fetched once, on the first read that needs it.
  var bundle = null;
  function scope(){
    var q = new URLSearchParams(location.search), body = document.getElementById('eventBody');
    if (q.get('talk')) return { talk: q.get('talk') };
    if (q.get('session')) return { session: q.get('session') };
    // A series' own page (the Festival's): the whole series, whichever edition it shows.
    if (body && body.getAttribute('data-series')) return { series: body.getAttribute('data-series') };
    var ev = q.get('edition') || q.get('event') || (body && body.getAttribute('data-event'));
    if (ev) return { event: ev };
    var s = q.get('series') || (body && body.getAttribute('data-series'));
    return s ? { series: s } : null;
  }
  function load(){
    if (bundle) return bundle;
    var sc = scope();
    bundle = !sc ? Promise.resolve(null) : firebase.app().functions('europe-west2').httpsCallable('publicEvent')(sc)
      .then(function(r){ return r.data || null; })
      .catch(function(err){ if (!err || err.code !== 'functions/not-found') console.error('[BOLD Events] loading the public event failed', err); return null; });
    return bundle;
  }

  // Firestore-like snapshots over the copy.
  function docSnap(path, data){
    var id = path[path.length - 1];
    return { id: id, exists: !!data, data: function(){ return data ? JSON.parse(JSON.stringify(data)) : undefined; }, get: function(k){ return data ? data[k] : undefined; }, ref: ref(path) };
  }
  function querySnap(docs){
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function(f){ docs.forEach(f); } };
  }
  function field(d, k){ return String(k).split('.').reduce(function(o, p){ return o == null ? undefined : o[p]; }, d); }
  function match(d, w){
    var v = field(d, w[0]);
    if (w[1] === '==') return v === w[2];
    if (w[1] === 'in') return (w[2] || []).indexOf(v) >= 0;
    if (w[1] === 'array-contains') return Array.isArray(v) && v.indexOf(w[2]) >= 0;
    return false;
  }
  // A read of the copy: a document (path of even length) or a query.
  function readCopy(q){
    return load().then(function(b){
      b = b || {};
      if (q.group) {
        if (q.group !== 'presentations') return querySnap([]);
        return querySnap(filter((b.presentations || []).map(function(p){ return { path: ['projectWorkspaces', p.project, 'presentations', p.id], data: p.data }; }), q));
      }
      var p = q.path;
      if (p.length === 2) return docSnap(p, (b[p[0]] || {})[p[1]] || null);
      if (p.length === 1) return querySnap(filter(Object.keys(b[p[0]] || {}).map(function(id){ return { path: [p[0], id], data: b[p[0]][id] }; }), q));
      return querySnap([]);
    });
  }
  function filter(rows, q){
    rows = rows.filter(function(r){ return q.wheres.every(function(w){ return match(r.data, w); }); });
    q.orders.forEach(function(o){
      rows.sort(function(a, b){ var x = field(a.data, o[0]), y = field(b.data, o[0]); var c = x < y ? -1 : x > y ? 1 : 0; return o[1] === 'desc' ? -c : c; });
    });
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows.map(function(r){ return docSnap(r.path, r.data); });
  }

  // The real Firestore reference or query for q.
  function realOf(q){
    var r = q.group ? fs().collectionGroup(q.group) : null;
    if (!r) q.path.forEach(function(seg, i){ r = i % 2 ? r.doc(seg) : (i ? r.collection(seg) : fs().collection(seg)); });
    q.wheres.forEach(function(w){ r = r.where(w[0], w[1], w[2]); });
    q.orders.forEach(function(o){ r = r.orderBy(o[0], o[1]); });
    if (q.limit) r = r.limit(q.limit);
    return r;
  }
  var refused = function(err){ return err && (err.code === 'permission-denied' || err.code === 'unauthenticated'); };

  function get(q){
    return new Promise(function(done){ whenKnown(done); }).then(function(){
      if (!viewer) return readCopy(q);
      return realOf(q).get().catch(function(err){ if (refused(err)) return readCopy(q); throw err; });
    });
  }
  function onSnapshot(q, next, error){
    var off = null, stopped = false;
    whenKnown(function(){
      if (stopped) return;
      var fromCopy = function(){ readCopy(q).then(function(s){ if (!stopped) next(s); }, function(e){ if (!stopped && error) error(e); }); };
      if (!viewer) { fromCopy(); return; }
      off = realOf(q).onSnapshot(next, function(err){ if (refused(err)) fromCopy(); else if (error) error(err); });
    });
    return function(){ stopped = true; if (off) off(); };
  }

  function query(q){
    function more(k, v){ var n = { path: q.path, group: q.group, wheres: q.wheres.slice(), orders: q.orders.slice(), limit: q.limit }; if (k === 'where') n.wheres.push(v); else if (k === 'orderBy') n.orders.push(v); else n.limit = v; return query(n); }
    var o = {
      where: function(f, op, v){ return more('where', [f, op, v]); },
      orderBy: function(f, dir){ return more('orderBy', [f, dir || 'asc']); },
      limit: function(n){ return more('limit', n); },
      get: function(){ return get(q); },
      onSnapshot: function(next, error){ return onSnapshot(q, next, error); },
      firestore: db
    };
    if (!q.group && q.path.length % 2 === 1) {
      o.id = q.path[q.path.length - 1];
      o.doc = function(id){ return ref(q.path.concat([id || realOf(q).doc().id])); };
      o.add = function(d){ return realOf(q).add(d); };
    }
    return o;
  }
  function ref(path){
    var q = { path: path, wheres: [], orders: [] };
    return {
      id: path[path.length - 1], path: path.join('/'), firestore: db, __real: function(){ return realOf(q); },
      parent: { id: path[path.length - 2], parent: path.length > 2 ? ref(path.slice(0, -2)) : null },
      collection: function(n){ return query({ path: path.concat([n]), wheres: [], orders: [] }); },
      get: function(){ return get(q); },
      onSnapshot: function(next, error){ return onSnapshot(q, next, error); },
      set: function(d, o){ return realOf(q).set(d, o); },
      update: function(d){ return realOf(q).update(d); },
      delete: function(){ return realOf(q).delete(); }
    };
  }
  var unwrap = function(r){ return r && r.__real ? r.__real() : r; };
  var db = {
    collection: function(n){ return query({ path: [n], wheres: [], orders: [] }); },
    collectionGroup: function(n){ return query({ group: n, path: [], wheres: [], orders: [] }); },
    doc: function(p){ return ref(String(p).split('/')); },
    batch: function(){ var b = fs().batch(); return { set: function(r, d, o){ b.set(unwrap(r), d, o); return this; }, update: function(r, d){ b.update(unwrap(r), d); return this; }, delete: function(r){ b.delete(unwrap(r)); return this; }, commit: function(){ return b.commit(); } }; },
    runTransaction: function(fn){
      return fs().runTransaction(function(tx){
        return fn({ get: function(r){ return tx.get(unwrap(r)); }, set: function(r, d, o){ tx.set(unwrap(r), d, o); }, update: function(r, d){ tx.update(unwrap(r), d); }, delete: function(r){ tx.delete(unwrap(r)); } });
      });
    }
  };

  BOLD.eventDb = function(){ return db; };
  // Whether this visitor reads a copy (signed out): pages offer "Sign in to …" instead of the action.
  BOLD.eventDbPublic = function(){ return viewer === null; };
})();
