// introductions.html: introductions (functions/index.js "Service desk: introductions").
// Anyone offers to introduce people to someone at an organisation they know
// (introOffers, written here under the rules; no names); anyone else asks on an
// offer, and whoever made it answers (or withdraws the offer, closing what's open on
// it, through introRequest). Requests (introRequests, the two people's
// alone) change only through introRequest, which tells the other on Slack.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('intros');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('introRequest')(data); };
  var me = null, offers = null, byMe = null, ofMe = null, fullWrite = false, unsubs = [];
  // The open form: null, 'offer' (a new offer), 'o:<id>' (editing an offer) or 'a:<id>' (asking on one).
  var editing = null, busy = {}, filter = '';
  var OPEN = ['asked', 'accepted'];
  var STATUS = { asked: 'Asked', accepted: 'Accepted', declined: 'Declined', done: 'Introduced' };

  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function first(name){ return String(name || '').split(' ')[0] || name; }
  function fold(s){ return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
  function errText(e, fallback){ return e && e.message && e.code !== 'functions/internal' ? e.message : fallback; }

  // ---------- offers ----------
  function offerForm(o){
    var key = o ? 'o:' + o.id : 'offer';
    return '<div class="event-form lt-form" data-key="' + esc(key) + '">' +
      '<label>Company or institution<input type="text" class="in-org" maxlength="120" value="' + esc(o ? o.org : '') + '" placeholder="e.g. Google DeepMind, the Alan Turing Institute"></label>' +
      '<label>Who you could introduce people to (optional)<input type="text" class="in-area" maxlength="300" value="' + esc(o ? o.area || '' : '') + '" placeholder="A team or an area, e.g. the robotics team, research partnerships"></label>' +
      '<p class="edit-hint">No names: the organisation, and the team or area.</p>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save in-offer-save">' + (o ? 'Save' : 'Offer it') + '</button>' +
        '<button type="button" class="in-cancel">Cancel</button></div></div>';
  }
  function askForm(o){
    return '<div class="event-form lt-form" data-key="a:' + esc(o.id) + '">' +
      '<label>What you’d like, and why<textarea class="in-why no-tags" rows="5" maxlength="2000" placeholder="Who you’d like to meet there, what about, and a line on you"></textarea></label>' +
      '<p class="edit-hint">Only ' + esc(o.by.name || 'they') + ' sees this, and gets a Slack message.</p>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save in-ask-send" data-id="' + esc(o.id) + '">Ask for the introduction</button>' +
        '<button type="button" class="in-cancel">Cancel</button></div></div>';
  }
  function offerHtml(o){
    var mine = o.by && o.by.email === me.email;
    var asked = (byMe || []).filter(function(q){ return q.offerId === o.id && OPEN.indexOf(q.status) !== -1; })[0];
    var b = busy[o.id] ? ' disabled' : '';
    var controls = mine
      ? '<button type="button" class="btn-text in-edit" data-id="' + esc(o.id) + '"' + b + '>Edit</button>' +
        '<button type="button" class="btn-text danger in-remove" data-id="' + esc(o.id) + '"' + b + '>Withdraw</button>'
      : (asked
        ? '<a class="btn-text" href="#i=' + esc(asked.id) + '">You’ve asked · ' + esc(STATUS[asked.status]) + '</a>'
        : '<button type="button" class="btn-text in-ask" data-id="' + esc(o.id) + '"' + b + '>Ask for an introduction</button>') +
        (fullWrite ? '<button type="button" class="btn-text danger in-remove" data-id="' + esc(o.id) + '"' + b + '>Remove</button>' : '');
    return '<li class="lt-item" id="o-' + esc(o.id) + '">' +
      '<span class="lt-title">' + esc(o.org) + '</span>' +
      (o.area ? '<span class="lt-text">' + esc(o.area) + '</span>' : '') +
      '<span class="lt-meta">Offered by ' + (mine ? 'you' : esc(o.by.name || o.by.email)) + ' · ' + when(o.at) + '</span>' +
      (editing === 'o:' + o.id ? offerForm(o) : editing === 'a:' + o.id ? askForm(o) : '<div class="event-controls">' + controls + '</div>') + '</li>';
  }
  function shownOffers(){
    var words = fold(filter).split(/\s+/).filter(Boolean);
    return offers.filter(function(o){
      var hay = fold(o.org) + ' ' + fold(o.area) + ' ' + fold(o.by && o.by.name);
      return words.every(function(w){ return hay.indexOf(w) !== -1; });
    }).sort(function(a, b){ return fold(a.org).localeCompare(fold(b.org)) || (b.at || 0) - (a.at || 0); });
  }

  // ---------- requests ----------
  function requestHtml(q, asOfferer){
    var open = OPEN.indexOf(q.status) !== -1, b = busy[q.id] ? ' disabled' : '';
    var meta = (asOfferer ? 'From ' + esc(q.requesterName) : 'Offered by ' + esc(q.offererName)) + ' · asked ' + when(q.at);
    var controls = '', note = '';
    if (asOfferer && q.status === 'asked') {
      note = '<input type="text" class="in-reply" maxlength="1000" placeholder="A note for ' + esc(first(q.requesterName)) + ' (optional)" aria-label="A note">';
      controls = '<button type="button" class="btn-text in-accept" data-id="' + esc(q.id) + '"' + b + '>I’ll introduce you</button>' +
        '<button type="button" class="btn-text danger in-decline" data-id="' + esc(q.id) + '"' + b + '>Not this time</button>';
    } else if (asOfferer && q.status === 'accepted') {
      controls = '<button type="button" class="btn-text in-done" data-id="' + esc(q.id) + '"' + b + '>Mark introduced</button>' +
        '<button type="button" class="btn-text danger in-decline" data-id="' + esc(q.id) + '"' + b + '>Can’t after all</button>';
    } else if (!asOfferer && open) {
      controls = '<button type="button" class="btn-text danger in-withdraw" data-id="' + esc(q.id) + '"' + b + '>Withdraw</button>';
    }
    return '<li class="lt-item" id="i-' + esc(q.id) + '">' +
      '<span class="lt-title">' + esc(q.org) + '</span>' +
      '<span class="lt-meta">' + meta + ' <span class="lt-status' + (q.status === 'done' ? ' is-done' : q.status === 'declined' ? ' is-late' : '') + '">' + esc(STATUS[q.status] || q.status) + '</span></span>' +
      '<span class="lt-label">' + (asOfferer ? 'What they’d like' : 'What you asked') + '</span><span class="lt-text">' + esc(q.why) + '</span>' +
      (q.reply ? '<span class="lt-label">' + (asOfferer ? 'Your note' : first(esc(q.offererName)) + '’s note') + '</span><span class="lt-text">' + esc(q.reply) + '</span>' : '') +
      note + (controls ? '<div class="event-controls">' + controls + '</div>' : '') + '</li>';
  }
  function sorted(list){
    return list.slice().sort(function(a, b){
      var ao = OPEN.indexOf(a.status) !== -1, bo = OPEN.indexOf(b.status) !== -1;
      return ao !== bo ? (ao ? -1 : 1) : (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0);
    });
  }

  function render(){
    if (!me) return;
    if (offers === null || byMe === null || ofMe === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) return; // don't redraw over a form being filled in
    var shown = shownOffers(), openOf = ofMe.filter(function(q){ return q.status === 'asked'; }).length;
    var focused = document.activeElement && document.activeElement.classList.contains('in-filter');
    main.innerHTML =
      '<section class="block"><div class="block-head"><h2>Offers<span class="proj-count">' + offers.length + '</span></h2></div>' +
        (offers.length > 5 ? '<input type="search" class="in-filter" placeholder="Filter by organisation or area" aria-label="Filter offers" value="' + esc(filter) + '">' : '') +
        (shown.length ? '<ul class="lt-list">' + shown.map(offerHtml).join('') + '</ul>'
          : '<p class="proj-msg">' + (offers.length ? 'No offer matches.' : 'No offers yet.') + '</p>') +
        '<div class="lt-new"><button type="button" class="event-add in-offer">+ Offer an introduction</button></div></section>' +
      (ofMe.length ? '<section class="block"><div class="block-head"><h2>Asked of you' + (openOf ? '<span class="proj-count">' + openOf + ' to answer</span>' : '') + '</h2></div>' +
        '<ul class="lt-list">' + sorted(ofMe).map(function(q){ return requestHtml(q, true); }).join('') + '</ul></section>' : '') +
      (byMe.length ? '<section class="block"><div class="block-head"><h2>Your requests</h2></div>' +
        '<ul class="lt-list">' + sorted(byMe).map(function(q){ return requestHtml(q, false); }).join('') + '</ul></section>' : '');
    if (focused) { var f = main.querySelector('.in-filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
    var m = /#i=([A-Za-z0-9]+)/.exec(location.hash), el = m && document.getElementById('i-' + m[1]);
    if (el && render.jumped !== m[1]) { render.jumped = m[1]; el.classList.add('is-target'); el.scrollIntoView({ block: 'start' }); }
  }
  window.addEventListener('hashchange', render);

  function openForm(key){
    editing = key;
    if (key === 'offer') {
      var wrap = main.querySelector('.lt-new');
      wrap.innerHTML = offerForm(null);
      wrap.querySelector('.in-org').focus();
      return;
    }
    var li = document.getElementById('o-' + key.slice(2)), o = offers.filter(function(x){ return x.id === key.slice(2); })[0];
    if (!li || !o) { editing = null; return; }
    li.querySelector('.event-controls').outerHTML = key.charAt(0) === 'o' ? offerForm(o) : askForm(o);
    var box = li.querySelector('.in-org, .in-why'); if (box) box.focus();
  }
  function closeForm(){ editing = null; render(); }
  function fail(f, text, btn){ var err = f.querySelector('.ev-error'); err.textContent = text; err.hidden = false; if (btn) btn.disabled = false; }

  function saveOffer(f, btn){
    var org = f.querySelector('.in-org').value.trim(), area = f.querySelector('.in-area').value.trim();
    if (!org) { fail(f, 'Give the company or institution.'); return; }
    btn.disabled = true;
    var key = f.getAttribute('data-key'), now = Date.now();
    var job = key === 'offer'
      ? db.collection('introOffers').add({ org: org, area: area, by: { email: me.email, name: me.name }, at: now, updatedAt: now })
      : db.collection('introOffers').doc(key.slice(2)).update({ org: org, area: area, updatedAt: now });
    job.then(closeForm).catch(function(e){ console.error('[BOLD Intros] saving the offer failed', e); fail(f, 'Couldn’t save — try again.', btn); });
  }
  function ask(f, btn){
    var why = f.querySelector('.in-why').value.trim();
    if (!why) { fail(f, 'Say what you’d like and why.'); return; }
    btn.disabled = true;
    call({ action: 'create', offerId: btn.getAttribute('data-id'), why: why }).then(function(r){
      editing = null; location.hash = 'i=' + r.data.id; render();
    }).catch(function(e){ console.error('[BOLD Intros] asking failed', e); fail(f, errText(e, 'Couldn’t send it — try again.'), btn); });
  }
  function act(id, data, btn){
    busy[id] = true; btn.disabled = true;
    call(data).catch(function(e){
      console.error('[BOLD Intros] that failed', e);
      window.alert(errText(e, 'Couldn’t do that — try again.'));
    }).then(function(){ delete busy[id]; render(); });
  }

  main.addEventListener('input', function(e){
    if (e.target.classList.contains('in-filter')) { filter = e.target.value; render(); return; }
    var f = e.target.closest('.lt-form'), err = f && f.querySelector('.ev-error');
    if (err) err.hidden = true;
  });
  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var f = t.closest('.lt-form'), id = t.getAttribute('data-id');
    if (t.classList.contains('in-cancel')) { closeForm(); return; }
    if (t.classList.contains('in-offer-save')) { saveOffer(f, t); return; }
    if (t.classList.contains('in-ask-send')) { ask(f, t); return; }
    if (editing) return;
    if (t.classList.contains('in-offer')) { openForm('offer'); return; }
    if (t.classList.contains('in-edit')) { openForm('o:' + id); return; }
    if (t.classList.contains('in-ask')) { openForm('a:' + id); return; }
    if (t.classList.contains('in-remove')) {
      var o = offers.filter(function(x){ return x.id === id; })[0];
      if (!o || !window.confirm((o.by && o.by.email === me.email ? 'Withdraw your' : 'Remove the') + ' offer for ' + o.org + '? Requests still open on it are closed, and whoever asked is told on Slack.')) return;
      act(id, { action: 'withdrawOffer', offerId: id }, t);
      return;
    }
    var q = (byMe || []).concat(ofMe || []).filter(function(x){ return x.id === id; })[0];
    if (!q) return;
    var reply = function(){ var i = t.closest('.lt-item').querySelector('.in-reply'); return i ? i.value.trim() : ''; };
    if (t.classList.contains('in-accept')) act(id, { action: 'accept', id: id, reply: reply() }, t);
    else if (t.classList.contains('in-decline')) {
      if (window.confirm('Tell ' + q.requesterName + ' you can’t introduce them at ' + q.org + '?')) act(id, { action: 'decline', id: id, reply: reply() }, t);
    } else if (t.classList.contains('in-done')) act(id, { action: 'done', id: id }, t);
    else if (t.classList.contains('in-withdraw')) {
      if (window.confirm('Withdraw your request? It’s deleted, and ' + q.offererName + ' is told on Slack.')) act(id, { action: 'withdraw', id: id }, t);
    }
  });

  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: (user.email || '').toLowerCase(), name: user.displayName || user.email || '' } : null;
    offers = null; byMe = null; ofMe = null; editing = null;
    if (!user) return;
    render();
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){ fullWrite = !!(r.data && r.data.fullWrite); render(); })
      .catch(function(){ fullWrite = false; });
    var docs = function(snap){ return snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); };
    unsubs.push(db.collection('introOffers').onSnapshot(function(snap){ offers = docs(snap); render(); },
      function(err){ console.error('[BOLD Intros] loading offers failed', err); offers = []; render(); }));
    var listen = function(field, set){
      unsubs.push(db.collection('introRequests').where(field, '==', me.email).onSnapshot(function(snap){ set(docs(snap)); render(); },
        function(err){ console.error('[BOLD Intros] loading requests failed', err); set([]); render(); }));
    };
    listen('requesterEmail', function(v){ byMe = v; });
    listen('offererEmail', function(v){ ofMe = v; });
  });
})();
