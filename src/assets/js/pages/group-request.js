// group-request.html: asking for another group of Who is BOLD, as a contract (2026-11-02).
// The group's terms are its section of the BOLDiquette's Who is BOLD (handbook/boldiquette,
// part who-is-bold; BoldJoin.groupSectionOf), so they change as that part does. The person
// ticks "I accept these terms" and sends it to the PIs and admins, who decide (groupRequest
// 'request', with the terms as they read them, kept on the request). An open request shows
// here with Withdraw. ?to=<group> opens that group.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('groupRequest');
  if (!box || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var me = null, mine = null, whoIs = null, open = undefined, onboard = undefined, to = '', note = '', accepted = false, busy = false, error = '', sent = false;
  var param = (/[?&]to=([a-z]+)/.exec(location.search) || [])[1] || '';
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('groupRequest')(data); };
  var when = function(t){ return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  var terms = function(g){ return BoldJoin.groupSectionOf(whoIs, g).replace(/\]\(#/g, '](boldiquette.html#'); };

  function render(){
    if (!me || !mine || whoIs === null || open === undefined || onboard === undefined) return;
    var html = '<p class="proj-meta">You’re in ' + BoldJoin.groupBadge(mine) + '.</p>';
    if (open) {
      box.innerHTML = html + '<p>You asked for ' + BoldJoin.groupBadge(open.to) + ' on ' + when(open.at) + ', accepting what it asks of you. The PIs and admins will decide' + (sent ? ': they’ve had a Slack message.' : '.') + '</p>' +
        (open.terms ? '<div class="gr-terms"><div class="md-desc">' + BoldMarkdown.render(open.terms) + '</div></div>' : '') +
        (error ? '<p class="st-error">' + esc(error) + '</p>' : '') +
        '<div class="event-form-actions"><button type="button" class="btn-box gr-withdraw"' + (busy ? ' disabled' : '') + '>Withdraw it</button></div>';
      return;
    }
    var others = BoldJoin.CATEGORIES.filter(function(c){ return c[0] !== mine; });
    if (!to || to === mine) to = others.some(function(c){ return c[0] === param; }) ? param : '';
    var t = to ? terms(to) : '';
    var why = onboard && !onboard.done ? 'Finish your first steps at BOLD first (' + BoldOnboarding.count(onboard) + ' done).' : !to ? 'Choose a group.' : !t ? 'What ' + BoldJoin.categoryLabel(to) + ' asks isn’t written yet: propose it in Who is BOLD.' : !accepted ? 'Tick that you accept the terms first.' : '';
    box.innerHTML = html +
      '<div class="gr-tabs" role="tablist" aria-label="Groups">' + others.map(function(c){
        var on = c[0] === to;
        return '<button type="button" role="tab" aria-selected="' + on + '" class="type-badge pp-' + c[0] + (on ? ' is-current' : '') + '" data-to="' + c[0] + '">' + esc(c[1]) + '</button>';
      }).join('') + '</div>' +
      (to ? '<h2 class="gr-head">What ' + esc(BoldJoin.categoryLabel(to)) + ' asks of you, and gives you</h2>' +
        '<div class="gr-terms" role="tabpanel">' + (t ? '<div class="md-desc">' + BoldMarkdown.render(t) + '</div>' : '<p>Not written yet: <a href="boldiquette.html#who-is-bold">propose it in Who is BOLD</a>.</p>') + '</div>' +
        '<div class="gr-form">' +
          '<label>Why (optional): who you work with, what you do in BOLD<textarea class="gr-note no-tags" rows="2" maxlength="1000">' + esc(note) + '</textarea></label>' +
          '<label class="jn-check"><input type="checkbox" class="gr-accept"' + (accepted ? ' checked' : '') + (t ? '' : ' disabled') + '> I accept these terms</label>' +
          (error ? '<p class="st-error">' + esc(error) + '</p>' : '') +
          '<div class="event-form-actions"><button type="button" class="btn-box is-primary gr-send"' + (why || busy ? ' disabled' : '') + (why ? ' title="' + esc(why) + '"' : '') + '>Send to the PIs and admins</button></div>' +
          (onboard && !onboard.done ? '<p class="gr-why">' + esc(why) + ' <a href="get-started.html">Get started</a></p>' : why && to ? '<p class="gr-why">' + esc(why) + '</p>' : '') +
        '</div>' : '<p class="gr-why">Choose a group to read what it asks of you.</p>');
  }

  box.addEventListener('click', function(e){
    var tab = e.target.closest('[data-to]');
    if (tab) { to = tab.getAttribute('data-to'); accepted = false; error = ''; render(); return; }
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.classList.contains('gr-send')) {
      var t = terms(to);
      BOLD.confirmAction({ title: 'Ask to move to ' + BoldJoin.categoryLabel(to) + '?', go: 'Send', effects: ['Accept what ' + BoldJoin.categoryLabel(to) + ' asks of you, as shown', 'Send the PIs and admins a Slack message asking them to decide'] })
        .then(function(ok){
          if (!ok) return;
          busy = true; error = ''; render();
          call({ action: 'request', to: to, note: note, accept: true, terms: t }).then(function(){ sent = true; })
            .catch(function(err){ console.error('[BOLD Group] sending the request failed', err); error = (err && err.message) || 'Couldn’t send it — try again.'; })
            .then(function(){ busy = false; render(); });
        });
    } else if (b.classList.contains('gr-withdraw')) {
      busy = true; error = ''; render();
      call({ action: 'withdraw', id: open.id }).then(function(){ sent = false; })
        .catch(function(err){ console.error('[BOLD Group] withdrawing failed', err); error = (err && err.message) || 'Couldn’t withdraw it — try again.'; })
        .then(function(){ busy = false; render(); });
    }
  });
  box.addEventListener('change', function(e){
    if (e.target.classList.contains('gr-accept')) { accepted = e.target.checked; render(); }
  });
  box.addEventListener('input', function(e){
    if (e.target.classList.contains('gr-note')) note = e.target.value;
  });

  var unsub = null;
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    me = user ? { email: String(user.email || '').toLowerCase() } : null;
    if (!me) return;
    BoldOnboarding.load(function(s){ onboard = s; render(); });
    db.collection('members').doc(me.email).get().then(function(s){ mine = BoldJoin.groupOf(s.exists ? s.data() : null); render(); })
      .catch(function(){ mine = 'pan'; render(); });
    db.collection('handbook').doc('boldiquette').get().then(function(s){
      var p = ((s.exists && s.data().parts) || []).filter(function(x){ return x.id === 'who-is-bold'; })[0];
      whoIs = (p && p.body) || ''; render();
    }).catch(function(err){ console.error('[BOLD Group] loading Who is BOLD failed', err); whoIs = ''; render(); });
    unsub = db.collection('groupRequests').where('email', '==', me.email).where('status', '==', 'open').onSnapshot(function(s){
      open = s.empty ? null : Object.assign({ id: s.docs[0].id }, s.docs[0].data()); render();
    }, function(err){ console.error('[BOLD Group] loading your request failed', err); open = null; render(); });
  });
})();
