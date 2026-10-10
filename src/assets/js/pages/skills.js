// Skills page — every skill is a skills/{name} doc (see skills-common.js),
// listed by title. "+ Add a skill" is always shown, greyed out for anyone but a
// PI/admin; it asks for the title, name and description, then opens the new
// skill's page to write its instructions and add its files.
(function(){
  var esc = BOLD.escapeHtml;
  var S = window.BoldSkills;
  var list = document.getElementById('skillList');
  var addBtn = document.getElementById('skillAdd');
  var loading = document.getElementById('skillLoading');
  if (!list || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }

  var skills = [], fullWrite = false, me = null;

  function cardHtml(x){
    return '<a class="event-card" href="skill.html?skill=' + encodeURIComponent(x.name) + '">' +
      '<h3>' + esc(x.title || x.name) + '</h3>' +
      '<p class="event-when">' + esc(x.name) + '</p>' +
      '<p>' + esc(x.description || '') + '</p>' +
      '<span class="event-cta">Install or download &rarr;</span></a>';
  }

  function render(){
    list.innerHTML = skills.map(function(x){ return '<li>' + cardHtml(x) + '</li>'; }).join('');
    addBtn.disabled = !fullWrite;
    addBtn.title = fullWrite ? '' : S.NOT_PI;
  }

  function openForm(){
    if (document.querySelector('.event-form')) return;
    var form = document.createElement('div');
    form.className = 'event-form';
    form.innerHTML = '<p class="event-form-head">New skill</p>' + S.metaHtml({}, true) + '<p class="ev-error" hidden></p>' +
      '<div class="event-form-actions"><button type="button" class="ev-save">Add skill</button><button type="button" class="ev-cancel">Cancel</button></div>';
    addBtn.parentNode.insertBefore(form, addBtn);
    addBtn.hidden = true;
    var close = function(){ form.remove(); addBtn.hidden = false; };
    form.querySelector('.sk-title').focus();
    form.querySelector('.ev-cancel').addEventListener('click', close);
    form.querySelector('.ev-save').addEventListener('click', function(){
      var r = S.readMeta(form, true);
      if (r.error) { S.showError(form, r.error); return; }
      if (skills.some(function(x){ return x.name === r.fields.name; })) { S.showError(form, 'There’s already a skill called ' + r.fields.name + '.'); return; }
      var now = Date.now();
      var save = form.querySelector('.ev-save');
      save.disabled = true;
      db.collection('skills').doc(r.fields.name).set(Object.assign({ body: '', files: [] }, r.fields,
        { createdAt: now, createdBy: me.email, updatedAt: now, updatedBy: me.email })).then(function(){
        location.href = 'skill.html?skill=' + encodeURIComponent(r.fields.name) + '#edit';
      }).catch(function(err){
        console.error('[BOLD Skills] adding a skill failed', err);
        S.showError(form, 'Couldn’t add the skill — try again.');
        save.disabled = false;
      });
    });
  }
  addBtn.addEventListener('click', function(){ if (fullWrite) openForm(); });

  var unsubscribe = null, signIns = 0;
  BOLD.onUser(function(user){
    var mine = ++signIns;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    skills = [];
    render();
    if (!user) return;
    S.access(function(ok){ if (mine === signIns) { fullWrite = ok; render(); } });
    unsubscribe = db.collection('skills').onSnapshot(function(snap){
      loading.hidden = true;
      skills = snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.name; })
        .sort(function(a, b){ return (a.title || a.name).localeCompare(b.title || b.name); });
      render();
    }, function(err){ console.error('[BOLD Skills] loading skills failed', err); });
  });
})();
