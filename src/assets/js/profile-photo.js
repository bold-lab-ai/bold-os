/* Shared member portrait. Signed URLs last a week (the same link all week, so the
   browser keeps each immutable image and downloads it at most once a week).
   Photos are kept in this browser, by the viewer's email: your own (boldPhoto) and
   everyone else's (boldPhotos). One kept for under FRESH is shown with no request;
   an older one is shown at once and refreshed in the background, for the next
   page. Changing yours on Profile, or signing out, forgets it. A failed batch is
   not retried until the next page. */
(function(){
  var HOUR = 60 * 60 * 1000, FRESH = 6 * HOUR, KEY = 'boldPhoto', SAVED = 'boldPhotos', SAVED_MAX = 600;
  var cache = Object.create(null), known = Object.create(null), ownPromise = null;
  function initials(name){
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  }
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('profilePhoto')(data).then(function(r){ return r.data || {}; }); }
  function myEmail(){
    var u = null;
    try { u = BOLD.getAuth() && BOLD.getAuth().currentUser; } catch (e){}
    var h = BOLD.authHint && BOLD.authHint();
    return String((u && u.email) || (h && h.e) || '').toLowerCase();
  }
  // A photo whose link still has an hour to run (or no photo: initials).
  function usable(p){ return !!p && (p.state !== 'active' || (!!p.url && (!p.expiresAt || p.expiresAt - Date.now() > HOUR))); }
  function stored(){
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      return s && s.email && s.email === myEmail() && Date.now() - s.at < FRESH && usable(s.data && s.data.photo) ? s.data : null;
    } catch (e){ return null; }
  }
  // Everyone else's: { email, items: { id: { photo, at } } }.
  function savedRead(){
    try {
      var s = JSON.parse(localStorage.getItem(SAVED) || 'null');
      return s && s.email === myEmail() && s.items ? s.items : {};
    } catch (e){ return {}; }
  }
  function savedWrite(results){
    try {
      var items = savedRead(), now = Date.now();
      Object.keys(results).forEach(function(id){ items[id] = { photo: results[id], at: now }; });
      var ids = Object.keys(items);
      if (ids.length > SAVED_MAX) ids.sort(function(a, b){ return items[a].at - items[b].at; }).slice(0, ids.length - SAVED_MAX).forEach(function(id){ delete items[id]; });
      localStorage.setItem(SAVED, JSON.stringify({ email: myEmail(), items: items }));
    } catch (e){}
  }
  function savedForget(id){
    try { var items = savedRead(); delete items[id]; localStorage.setItem(SAVED, JSON.stringify({ email: myEmail(), items: items })); } catch (e){}
  }
  function store(data){ try { localStorage.setItem(KEY, JSON.stringify({ email: myEmail(), at: Date.now(), data: data })); } catch (e){} }
  function start(node, name){
    var version = String(Number(node.dataset.photoVersion || 0) + 1);
    node.dataset.photoVersion = version;
    node.classList.add('member-photo');
    node.textContent = initials(name);
    node.setAttribute('aria-label', name ? name + ' profile picture' : 'Profile picture');
    return version;
  }
  // `known`: a photo this page has already shown, so it's drawn at once (from the
  // browser's cache) rather than faded in over initials again.
  function show(node, version, photo, known){
    if (node.dataset.photoVersion !== version) return;
    var url = photo && photo.state === 'active' && photo.url;
    if (!url) return;
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if (known) img.classList.add('is-loaded');
    img.onload = function(){ if (node.dataset.photoVersion === version) img.classList.add('is-loaded'); else img.remove(); };
    img.onerror = function(){ img.remove(); };
    node.appendChild(img);
    img.src = url;
  }
  // Kept photos first: fresh ones need no request; stale ones are shown now and
  // asked for again with the missing ones, in the one batch.
  function batch(ids){
    var saved = savedRead(), now = Date.now(), missing = [], stale = [];
    Array.from(new Set(ids.filter(function(id){ return id && !cache[id]; }))).forEach(function(id){
      var s = saved[id];
      if (s && usable(s.photo)) {
        known[id] = s.photo; cache[id] = Promise.resolve(s.photo);
        if (now - s.at > FRESH) stale.push(id);
      } else missing.push(id);
    });
    var ask = missing.concat(stale);
    if (ask.length) {
      var request = call({ action: 'batch', slackIds: ask }).then(function(results){ savedWrite(results); return results; });
      stale.forEach(function(id){ request.then(function(results){ if (results[id]) known[id] = results[id]; }, function(){}); });
      missing.forEach(function(id){
        cache[id] = request.then(function(results){ return results[id] || { state: 'missing' }; }, function(){ return { state: 'missing' }; })
          .then(function(photo){ known[id] = photo; return photo; });
      });
    }
    return Promise.all(ids.filter(Boolean).map(function(id){ return cache[id].then(function(photo){ return [id, photo]; }); }))
      .then(function(pairs){ return Object.fromEntries(pairs); });
  }
  function mountMany(nodes){
    nodes = Array.prototype.slice.call(nodes);
    // batch() takes in the kept photos at once (known), and asks for the rest.
    var pending = batch(nodes.map(function(node){ return node.dataset.id; }).filter(Boolean)), later = [];
    nodes.forEach(function(node){
      var id = node.dataset.id, version = start(node, node.dataset.name);
      if (id && known[id]) show(node, version, known[id], true);
      else if (id) later.push({ node: node, id: id, version: version });
    });
    if (!later.length) return;
    pending.then(function(photos){
      later.forEach(function(e){ show(e.node, e.version, photos[e.id]); });
    });
  }
  function mount(node, id, name){
    if (!node) return;
    node.dataset.id = id || '';
    node.dataset.name = name || '';
    mountMany([node]);
  }
  function signedIn(){ try { return !!(BOLD.getAuth() && BOLD.getAuth().currentUser); } catch (e){ return false; } }
  function mine(){
    if (ownPromise) return ownPromise;
    var s = stored();
    if (s) return (ownPromise = Promise.resolve(s));
    if (!signedIn()) return Promise.reject(new Error('Not signed in yet.'));
    ownPromise = call({ action: 'mine' }).then(function(data){ store(data); return data; }, function(err){ ownPromise = null; throw err; });
    return ownPromise;
  }
  function mountOwn(node, name){
    if (!node) return mine();
    var version = start(node, name), s = stored();
    if (s) show(node, version, s.photo, true);
    return mine().then(function(data){
      var url = function(d){ return d && d.photo && d.photo.state === 'active' ? d.photo.url : ''; };
      if (!s || url(s) !== url(data)) { node.querySelectorAll('img').forEach(function(i){ i.remove(); }); show(node, version, data.photo); }
      document.dispatchEvent(new CustomEvent('bold:photo', { detail: data.photo || { state: 'missing' } }));
      return data;
    });
  }
  // After a change: this page's copy of the photo, and the browser's, are dropped.
  function clear(id){
    if (id) { delete cache[String(id)]; delete known[String(id)]; savedForget(String(id)); }
    ownPromise = null;
    try { localStorage.removeItem(KEY); } catch (e){}
  }
  // Another account (or none): only this page's copy; the stored one is checked against the email.
  function reset(){ ownPromise = null; if (!signedIn()) try { localStorage.removeItem(KEY); localStorage.removeItem(SAVED); } catch (e){} }
  BOLD.photo = { mount: mount, mountMany: mountMany, mountOwn: mountOwn, mine: mine, clear: clear, reset: reset, call: call, initials: initials };
})();
