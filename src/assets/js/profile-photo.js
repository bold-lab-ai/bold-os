/* Shared member portrait. Signed URLs are short lived; objects are immutable. */
(function(){
  var cache = Object.create(null), ownPromise = null;
  function initials(name){
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  }
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('profilePhoto')(data).then(function(r){ return r.data || {}; }); }
  function start(node, name){
    var version = String(Number(node.dataset.photoVersion || 0) + 1);
    node.dataset.photoVersion = version;
    node.classList.add('member-photo');
    node.textContent = initials(name);
    node.setAttribute('aria-label', name ? name + ' profile picture' : 'Profile picture');
    return version;
  }
  function show(node, version, photo){
    if (node.dataset.photoVersion !== version || !photo || photo.state !== 'active' || !photo.url) return;
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.onload = function(){ if (node.dataset.photoVersion === version) img.classList.add('is-loaded'); else img.remove(); };
    img.onerror = function(){ img.remove(); };
    node.appendChild(img);
    img.src = photo.url;
  }
  function batch(ids){
    var missing = Array.from(new Set(ids.filter(function(id){ return id && !cache[id]; })));
    if (missing.length) {
      var request = call({ action: 'batch', slackIds: missing });
      missing.forEach(function(id){
        cache[id] = request.then(function(results){ return results[id] || { state: 'missing' }; }).catch(function(){ delete cache[id]; return { state: 'missing' }; });
      });
    }
    return Promise.all(ids.filter(Boolean).map(function(id){ return cache[id].then(function(photo){ return [id, photo]; }); }))
      .then(function(pairs){ return Object.fromEntries(pairs); });
  }
  function mountMany(nodes){
    var entries = Array.prototype.map.call(nodes, function(node){
      return { node: node, id: node.dataset.id, version: start(node, node.dataset.name) };
    });
    batch(entries.map(function(e){ return e.id; })).then(function(photos){
      entries.forEach(function(e){ if (e.id) show(e.node, e.version, photos[e.id]); });
    });
  }
  function mount(node, id, name){
    if (!node) return;
    node.dataset.id = id || '';
    node.dataset.name = name || '';
    mountMany([node]);
  }
  function mine(){ if (!ownPromise) ownPromise = call({ action: 'mine' }).catch(function(err){ ownPromise = null; throw err; }); return ownPromise; }
  function mountOwn(node, name){
    if (!node) return mine();
    var version = start(node, name);
    return mine().then(function(data){
      show(node, version, data.photo);
      document.dispatchEvent(new CustomEvent('bold:photo', { detail: data.photo || { state: 'missing' } }));
      return data;
    });
  }
  function clear(id){ if (id) delete cache[String(id)]; ownPromise = null; }
  BOLD.photo = { mount: mount, mountMany: mountMany, mountOwn: mountOwn, mine: mine, clear: clear, call: call, initials: initials };
})();
