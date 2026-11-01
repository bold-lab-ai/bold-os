/* Shared member portrait with initials fallback. Never exposes a Storage URL. */
(function(){
  var cache = Object.create(null);
  function initials(name){
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  }
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('profilePhoto')(data).then(function(r){ return r.data || {}; }); }
  function mount(node, id, name, fallbackUrl){
    if (!node) return;
    var version = String(Number(node.dataset.photoVersion || 0) + 1);
    node.dataset.photoVersion = version;
    node.classList.add('member-photo');
    node.textContent = initials(name);
    node.setAttribute('aria-label', name ? name + ' profile picture' : 'Profile picture');
    function showImage(url, onError){
      var img = document.createElement('img');
      img.alt = '';
      img.onload = function(){ if (node.dataset.photoVersion === version) { node.textContent = ''; node.appendChild(img); } };
      img.onerror = function(){ img.remove(); if (onError) onError(); };
      img.src = url;
    }
    if (!id) { if (fallbackUrl) showImage(fallbackUrl); return; }
    var key = String(id);
    if (!cache[key]) cache[key] = call({ action: 'get', slackId: key }).catch(function(){ delete cache[key]; return { state: 'missing' }; });
    cache[key].then(function(data){
      if (node.dataset.photoVersion !== version) return;
      if (data.state === 'active' && data.image && /^image\/(jpeg|png|webp|gif)$/.test(data.type)) {
        showImage('data:' + data.type + ';base64,' + data.image, fallbackUrl ? function(){ showImage(fallbackUrl); } : null);
      }
      else if (data.state !== 'removed' && fallbackUrl) showImage(fallbackUrl);
    });
  }
  function clear(id){ if (id) delete cache[String(id)]; }
  BOLD.photo = { mount: mount, clear: clear, call: call, initials: initials };
})();
