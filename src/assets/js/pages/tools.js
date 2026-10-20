// tools.html: the tools AI agents use with BOLD.OS (functions/api-tools.js). Those the lab
// added (agentTools/{name}), each with its page (tool.html?tool=<name>); the proposed new
// ones still waiting (agentTools/{name}/proposals, kind 'new', read with a
// collectionGroup query); and BOLD.OS's own, by name (boldApi's index).
(function(){
  var esc = BOLD.escapeHtml;
  var list = document.getElementById('toolList');
  if (!list || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var API = 'https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/';

  function card(href, title, sub, text, cta){
    return '<li><a class="event-card" href="' + esc(href) + '"><h3>' + esc(title) + '</h3><p class="event-when">' + esc(sub) + '</p><p>' + esc(text || '') + '</p>' +
      '<span class="event-cta">' + cta + ' &rarr;</span></a></li>';
  }
  BOLD.onUser(function(user){
    if (!user) return;
    db.collection('agentTools').get().then(function(snap){
      var tools = snap.docs.map(function(d){ return Object.assign({ name: d.id }, d.data()); }).sort(function(a, b){ return (a.title || a.name).localeCompare(b.title || b.name); });
      document.getElementById('toolLoading').hidden = true;
      list.innerHTML = tools.length ? tools.map(function(t){
        return card('tool.html?tool=' + encodeURIComponent(t.name), t.title || t.name, t.name + ' · ' + (t.acting ? 'acts' : 'reads'), t.description, 'See the tool');
      }).join('') : '<li><p class="proj-msg">None yet.</p></li>';
    }).catch(function(err){ console.error('[BOLD Tools] loading failed', err); document.getElementById('toolLoading').textContent = 'Couldn’t load the tools. Try reloading the page.'; });
    // Proposed new tools: their page shows the proposal until it's decided.
    // Unfiltered (a filter across collections needs its own index): there are few.
    db.collectionGroup('proposals').get().then(function(snap){
      var fresh = snap.docs.filter(function(d){ var x = d.data(); return d.ref.parent.parent && d.ref.parent.parent.parent.id === 'agentTools' && x.kind === 'new' && x.status === 'open'; });
      if (!fresh.length) return;
      document.getElementById('proposedNew').hidden = false;
      document.getElementById('newList').innerHTML = fresh.map(function(d){
        var q = d.data(), name = d.ref.parent.parent.id;
        return card('tool.html?tool=' + encodeURIComponent(name) + '#proposals', (q.after && q.after.title) || name, name + ' · proposed by ' + ((q.by && q.by.name) || 'someone'), q.note, 'See the proposal');
      }).join('');
    }).catch(function(err){ console.error('[BOLD Tools] loading proposals failed', err); });
    fetch(API).then(function(r){ return r.json(); }).then(function(d){
      var name = function(s){ return s.replace(/^(GET|POST) \/v1\//, ''); };
      document.getElementById('builtIn').innerHTML = 'Reading: ' + (d.read || []).map(function(s){ return '<code>' + esc(name(s)) + '</code>'; }).join(', ') +
        '.<br>Acting: ' + (d.act || []).map(function(s){ return '<code>' + esc(name(s)) + '</code>'; }).join(', ') + '.';
    }).catch(function(){ document.getElementById('builtIn').textContent = 'Couldn’t load them.'; });
  });
})();
