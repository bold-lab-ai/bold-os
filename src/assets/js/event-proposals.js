// An event's proposals (collabWeekProposals, each with its edition's `eventSlug`; the
// first Collaboration Week's have none): workshops, pitches and talks, proposed on
// event-collaboration-week-propose.html?event=<slug>. Read here; whoever proposed one
// edits or deletes it (Edit and Delete always shown, greyed out for everyone else;
// firestore.rules decides). Used by Collaboration Week's Proposals tab and by an event
// page whose recurring event takes proposals (pages/event.js).
// EventProposals.mount(listEl, slug) → { update(user) }: call with the signed-in user, or null.
window.EventProposals = (function(){
  var esc = BOLD.escapeHtml;
  var NOT_PROPOSER = 'Only whoever proposed it can edit or delete a proposal';
  var FIRST = 'collaboration-week';   // the edition the proposals without an eventSlug are for

  function cardHtml(p, me){
    return '<div class="proposal-card">' +
      '<div class="proposal-top">' +
        '<span class="proposal-title">' + esc(p.title || '(untitled)') + '</span>' +
        '<span class="proposal-type">' + esc(p.contributionType || '') + '</span>' +
      '</div>' +
      '<div class="proposal-meta">' +
        '<strong>' + esc(p.name || 'Someone') + '</strong>' +
        (p.duration ? ' &middot; ' + esc(p.duration) : '') +
        (p.timeLocation ? ' &middot; ' + esc(p.timeLocation) : '') +
      '</div>' +
      (p.chair ? '<div class="proposal-meta">Chair: ' + esc(p.chair) + '</div>' : '') +
      (p.abstract ? '<div class="proposal-note">' + esc(p.abstract) + '</div>' : '') +
      (p.overallDescription ? '<div class="proposal-note">' + esc(p.overallDescription) + '</div>' : '') +
      (me && p.email === me.email
        ? '<div class="proposal-actions">' +
            '<a href="event-collaboration-week-propose.html?edit=' + encodeURIComponent(p.id) + '">Edit</a>' +
            '<button type="button" class="btn-text danger" data-delete-id="' + esc(p.id) + '">Delete</button>' +
          '</div>'
        : '<div class="proposal-actions">' +
            '<button type="button" class="btn-text" disabled title="' + NOT_PROPOSER + '">Edit</button>' +
            '<button type="button" class="btn-text danger" disabled title="' + NOT_PROPOSER + '">Delete</button>' +
          '</div>') +
    '</div>';
  }

  function mount(el, slug){
    var db = firebase.firestore(BOLD.getApp()), me = null, docs = [], unsub = null;
    function render(){
      el.innerHTML = docs.length ? docs.map(function(p){ return cardHtml(p, me); }).join('')
        : '<p class="proposal-empty">Nothing proposed yet &mdash; be the first.</p>';
    }
    el.addEventListener('click', function(e){
      var btn = e.target.closest('[data-delete-id]');
      if (!btn || !window.confirm('Delete this proposal? This can’t be undone.')) return;
      btn.disabled = true;
      db.collection('collabWeekProposals').doc(btn.getAttribute('data-delete-id')).delete().catch(function(err){
        console.error('[BOLD Events] deleting a proposal failed', err);
        window.alert('Could not delete the proposal — try again.');
        btn.disabled = false;
      });
    });
    return {
      update: function(user){
        me = user ? { email: user.email } : null;
        if (unsub) { unsub(); unsub = null; }
        if (!user) return;
        el.innerHTML = '<p class="proposal-empty">Loading&hellip;</p>';
        unsub = db.collection('collabWeekProposals').orderBy('createdAt', 'desc').onSnapshot(function(snap){
          docs = [];
          snap.forEach(function(d){ var p = d.data(); p.id = d.id; if ((p.eventSlug || FIRST) === slug) docs.push(p); });
          render();
        }, function(err){
          console.error('[BOLD Events] loading the proposals failed', err);
          el.innerHTML = '<p class="proposal-empty">Could not load proposals &mdash; reload, or check back shortly.</p>';
        });
      }
    };
  }
  return { mount: mount };
})();
