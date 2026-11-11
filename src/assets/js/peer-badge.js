(function(){
  BOLD.onUser(function(user){
    if (!user || !window.firebase || !firebase.firestore) return;
    var id = new URLSearchParams(location.search).get('id'), own = document.getElementById('profileName');
    var db = firebase.firestore(BOLD.getApp());
    var query = own ? db.collection('peerAmbassadors').doc(user.email.toLowerCase()).get().then(function(s){ return s.exists && s.data().active; }) :
      db.collection('peerAmbassadors').where('slackId', '==', id || '').where('active', '==', true).get().then(function(s){ return !s.empty; });
    query.then(function(active){
      var heading = own || document.getElementById('personName');
      if (!active || !heading || document.getElementById('peerBadge')) return;
      var badge = document.createElement('a'); badge.id = 'peerBadge'; badge.className = 'btn-text';
      badge.href = 'peer-support.html'; badge.textContent = 'Peer support ambassador';
      heading.parentNode.appendChild(badge);
    }).catch(function(){ /* The directory may not yet be open to this group. */ });
  });
})();
