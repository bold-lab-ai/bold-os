// Inviting someone to a project (#148, 2026-11-02), on its page (project.js): under People,
// "Invite someone" (the project's submitter, authors, PIs and admins; greyed for everyone
// else), by email, picked from the people on BOLD's Slack or typed. Someone on BOLD.OS gets a
// Slack message; someone who isn't gets an email to ask to join BOLD, and is put on the
// project once that's approved (projectInvite in functions/index.js). Its editors see the
// open invitations, with Withdraw, and who asked to join (from Projects' titles, below its View),
// with Accept (they're on it at once: 'admit') and Decline. The person invited sees a banner on the page (#…&invite=<id>,
// the message's link) with Join and Decline: joining makes them one of its people, so they
// see it in full whatever their group.
// BoldProjectInvite.init({ db, root, id, board, canEdit(), people(), me(), onJoined, notEditor })
// once; .html() inside the People row (redrawn with the page); .banner(el) for the invitation.
window.BoldProjectInvite = (function(){
  var esc = BOLD.escapeHtml;
  var o = null, invites = null, open = false, busy = false, msg = '', loading = false;
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('projectInvite')(data); }
  var when = function(t){ return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  function redraw(){ if (o && o.redraw) o.redraw(); }

  function load(){
    if (!o || loading || !o.canEdit()) return;
    loading = true;
    call({ action: 'list', id: o.id, board: o.board || null }).then(function(r){ invites = (r.data && r.data.invites) || []; })
      .catch(function(err){ console.error('[BOLD Project] loading invitations failed', err); invites = []; })
      .then(function(){ loading = false; redraw(); });
  }
  function html(){
    if (!o) return '';
    var can = o.canEdit();
    if (can && invites === null) load();
    var people = o.people() || [];
    var pending = (invites || []).filter(function(i){ return i.status === 'open'; });
    var asks = (invites || []).filter(function(i){ return i.status === 'asked'; });
    return '<div class="pj-inv">' +
      (can && asks.length ? '<ul class="pj-inv-list">' + asks.map(function(i){
        return '<li>' + esc(i.name || i.email) + ' asks to join <span class="detail-muted">· ' + when(i.at) + '</span>' +
          ' <button type="button" class="btn-text pj-inv-ask-yes" data-invite="' + esc(i.id) + '" data-name="' + esc(i.name || i.email) + '"' + (busy ? ' disabled' : '') + '>Accept</button>' +
          ' <button type="button" class="btn-text danger pj-inv-withdraw" data-invite="' + esc(i.id) + '"' + (busy ? ' disabled' : '') + '>Decline</button></li>';
      }).join('') + '</ul>' : '') +
      (can && pending.length ? '<ul class="pj-inv-list">' + pending.map(function(i){
        return '<li>Invited ' + esc(i.name || i.email) + (i.name ? ' <span class="detail-muted">' + esc(i.email) + '</span>' : '') + ' <span class="detail-muted">· ' + when(i.at) +
          (i.emailed && i.emailed.error ? ' · the email didn’t go' : i.emailed ? ' · emailed' : ' · on Slack') + '</span>' +
          ' <button type="button" class="btn-text pj-inv-withdraw" data-invite="' + esc(i.id) + '"' + (busy ? ' disabled' : '') + '>Withdraw</button></li>';
      }).join('') + '</ul>' : '') +
      (open && can ? '<div class="pj-inv-form"><label>Their email<input type="email" class="pj-inv-email" list="pjInvPeople" autocomplete="off" placeholder="Name or email"></label>' +
          '<datalist id="pjInvPeople">' + people.filter(function(p){ return !p.external; }).map(function(p){ return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('') + '</datalist>' +
          (msg ? '<p class="st-error">' + esc(msg) + '</p>' : '') +
          '<div class="event-form-actions"><button type="button" class="btn-box is-primary pj-inv-send"' + (busy ? ' disabled' : '') + '>Invite</button><button type="button" class="btn-box pj-inv-cancel">Cancel</button></div></div>'
        : '<button type="button" class="btn-text pj-inv-open"' + (can ? '' : ' disabled title="' + esc(o.notEditor || 'Only the project’s submitter, authors, PIs and admins invite people') + '"') + '>Invite someone</button>' +
          (msg && !open ? '<span class="detail-hint">' + esc(msg) + '</span>' : '')) +
      '</div>';
  }
  function send(){
    var input = o.root.querySelector('.pj-inv-email'), email = String(input && input.value || '').trim().toLowerCase();
    var p = (o.people() || []).filter(function(x){ return x.email === email; })[0];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg = 'Give their email address.'; redraw(); return; }
    BOLD.confirmAction({ title: 'Invite ' + (p ? p.name : email) + '?', go: 'Invite',
      effects: [p ? 'Send ' + p.name + ' a Slack message with a link to join the project or decline'
        : 'Email ' + email + ' from the lab’s Google account, asking them to join BOLD; they’re put on the project once that’s approved'] })
      .then(function(ok){
        if (!ok) return;
        busy = true; msg = ''; redraw();
        call({ action: 'invite', id: o.id, board: o.board || null, email: email, name: p ? p.name : '' })
          .then(function(r){ open = false; msg = r.data && r.data.emailed ? 'Emailed ' + email + '.' : 'Sent them a Slack message.'; invites = null; })
          .catch(function(err){ msg = (err && err.message) || 'Couldn’t invite them — try again.'; })
          .then(function(){ busy = false; redraw(); });
      });
  }
  function init(opts){
    o = opts;
    o.root.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.classList.contains('pj-inv-open')) { open = true; msg = ''; redraw(); var f = o.root.querySelector('.pj-inv-email'); if (f) f.focus(); }
      else if (b.classList.contains('pj-inv-cancel')) { open = false; msg = ''; redraw(); }
      else if (b.classList.contains('pj-inv-send')) send();
      else if (b.classList.contains('pj-inv-ask-yes')) {
        var who = b.getAttribute('data-name');
        BOLD.confirmAction({ title: 'Accept ' + who + ' on the project?', go: 'Accept', effects: ['Make them one of its people: they see it in full, and join its Slack channel, meeting, slides and notes', 'Send them a Slack message saying so'] }).then(function(ok){
          if (!ok) return;
          busy = true; msg = ''; redraw();
          call({ action: 'admit', invite: b.getAttribute('data-invite') })
            .then(function(){ msg = who + ' is on the project.'; invites = null; if (o.onAdmitted) o.onAdmitted(); })
            .catch(function(err){ msg = (err && err.message) || 'Couldn’t accept them — try again.'; })
            .then(function(){ busy = false; redraw(); });
        });
      }
      else if (b.classList.contains('pj-inv-withdraw')) {
        busy = true; redraw();
        call({ action: 'withdraw', invite: b.getAttribute('data-invite') }).then(function(){ invites = null; })
          .catch(function(err){ msg = (err && err.message) || 'Couldn’t withdraw it.'; }).then(function(){ busy = false; redraw(); });
      }
    });
  }

  // The invitation in the address (&invite=<id>), for whoever it's for: Join or Decline.
  function banner(box){
    var iid = (location.hash.match(/[#&]invite=([A-Za-z0-9]+)/) || [])[1];
    if (!box || !iid || !o) return;
    o.db.collection('projectInvites').doc(iid).get().then(function(s){
      var inv = s.exists ? s.data() : null;
      if (!inv) return;
      var draw = function(note){
        box.innerHTML = inv.status === 'open'
          ? '<p><strong>' + esc(inv.byName) + '</strong> invited you to <strong>' + esc(inv.title) + '</strong>.</p>' +
            '<div class="event-form-actions"><button type="button" class="btn-box is-primary pj-inv-join">Join the project</button><button type="button" class="btn-box pj-inv-decline">Decline</button></div>' +
            (note ? '<p class="st-error">' + esc(note) + '</p>' : '')
          : '<p>' + esc(inv.byName) + '’s invitation to ' + esc(inv.title) + ': ' + esc({ accepted: 'you joined.', declined: 'you declined it.', withdrawn: 'withdrawn.' }[inv.status] || inv.status) + '</p>';
        box.hidden = false;
      };
      draw('');
      box.onclick = function(e){
        var b = e.target.closest('button');
        if (!b || b.disabled) return;
        var join = b.classList.contains('pj-inv-join');
        if (!join && !b.classList.contains('pj-inv-decline')) return;
        Array.prototype.forEach.call(box.querySelectorAll('button'), function(x){ x.disabled = true; });
        call({ action: join ? 'accept' : 'decline', invite: iid }).then(function(){
          inv.status = join ? 'accepted' : 'declined'; draw('');
          if (join && o.onJoined) o.onJoined();
        }).catch(function(err){ draw((err && err.message) || 'That didn’t work — try again.'); });
      };
    }).catch(function(){ /* not theirs, or gone */ });
  }
  return { init: init, html: html, banner: banner };
})();
