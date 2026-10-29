// Events added on the site — events/{slug} in Firestore: { slug, title,
// startDate, endDate ('YYYY-MM-DD'), place, description, hidden, createdAt,
// createdBy, updatedAt, updatedBy }; `hidden` (a new event starts hidden):
// only PIs/admins and whoever added it can read it until they release it.
// Adding one is for the Events page's Edit level (BOLDiquette › Who can see what);
// whoever added it edits and deletes it, PIs/admins any (firestore.rules). Shared by the events page (the list, "+ Add an event")
// and an added event's page (event.html?event=<slug>, Edit, Delete).
window.BoldEvents = (function(){
  var esc = BOLD.escapeHtml;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var NOT_PI = 'Only PIs and admins, and whoever added it, can change this event';

  // What releasing or hiding an event sets off, for its warning (BOLD.confirmAction, always
  // shown): Google Calendar invites its group (and its series' organisers) to its days
  // while it's to come (functions/series.js syncOccurrence).
  function visibilityEffects(x, hide){
    var invites = x.inviteGroup && x.inviteGroup !== 'none' && !isPast(x);
    return hide
      ? ['Hide it from the lab on Events and the Calendar'].concat(invites ? ['Cancel its Google Calendar invitation: Google emails ' + inviteText(x.inviteGroup) + ' the cancellation'] : [])
      : (invites ? ['Send a Google Calendar invitation to ' + inviteText(x.inviteGroup) + ' for its days: Google emails each of them'] : []).concat(['Show it to the lab on Events and the Calendar']);
  }

  function parts(d){ var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; }

  // '2026-10-05', '2026-10-10' → '5–10 October 2026'; across months or years, both in full.
  function when(start, end){
    var a = parts(start), b = parts(end) || a;
    if (!a) return '';
    var full = function(p){ return p.d + ' ' + MONTHS[p.m] + ' ' + p.y; };
    if (start === (end || start)) return full(a);
    if (a.y === b.y && a.m === b.m) return a.d + '–' + full(b);
    if (a.y === b.y) return a.d + ' ' + MONTHS[a.m] + ' – ' + full(b);
    return full(a) + ' – ' + full(b);
  }

  function today(){
    var t = new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function isPast(x){ return (x.endDate || x.startDate) < today(); }

  // The add/edit form's fields, filled from x (an event, or {} for a new one).
  function formHtml(x){
    return '<label>Title<input type="text" class="ev-title" value="' + esc(x.title || '') + '"></label>' +
      '<div class="ev-row"><label>Starts<input type="date" class="ev-start" value="' + esc(x.startDate || '') + '"></label>' +
      '<label>Ends<input type="date" class="ev-end" value="' + esc(x.endDate && x.endDate !== x.startDate ? x.endDate : '') + '" placeholder="optional"></label></div>' +
      '<label>Place<input type="text" class="ev-place" value="' + esc(x.place || '') + '" placeholder="e.g. Oxford"></label>' +
      '<label>Description <span class="ev-hint">Markdown: **bold**, lists, [links](https://…)</span><textarea class="ev-description" rows="5">' + esc(x.description || '') + '</textarea></label>' +
      '<p class="ev-error" hidden></p>';
  }

  // → { fields } or { error }.
  function read(form){
    var v = function(c){ return form.querySelector(c).value.trim(); };
    var f = { title: v('.ev-title'), startDate: v('.ev-start'), endDate: v('.ev-end') || v('.ev-start'),
      place: v('.ev-place'), description: v('.ev-description') };
    var error = !f.title ? 'Give the event a title.' : !f.startDate ? 'Set when it starts.' :
      f.endDate < f.startDate ? 'It has to end on or after the day it starts.' : '';
    return error ? { error: error } : { fields: f };
  }

  // Who gets a Google Calendar invitation to an occurrence of an event series
  // (`inviteGroup`: functions/series.js syncOccurrence): a group and those above it, or nobody.
  var INVITE_GROUPS = [['exec', 'BOLD-exec'], ['staff', 'BOLD-staff and above'], ['internal', 'BOLD-internal and above'],
    ['associate', 'BOLD-associate and above'], ['everyone', 'Everyone in BOLD'], ['none', 'Nobody']];
  function inviteText(g){ return (INVITE_GROUPS.filter(function(o){ return o[0] === g; })[0] || INVITE_GROUPS[5])[1]; }
  function inviteSelectHtml(cls, value, why){
    return '<label>Google Calendar invites<select class="' + cls + '"' + (why ? ' disabled title="' + esc(why) + '"' : '') + '>' +
      INVITE_GROUPS.map(function(o){ return '<option value="' + o[0] + '"' + (o[0] === (value || 'none') ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>';
  }

  function showError(form, msg){
    var box = form.querySelector('.ev-error');
    box.textContent = msg; box.hidden = !msg;
  }

  // Whether the signed-in user is a PI/admin (getMyAccess); cb(bool).
  function access(cb){
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
      cb(!!(r.data && r.data.fullWrite));
    }).catch(function(err){ console.error('[BOLD Events] access check failed', err); cb(false); });
  }

  return { when: when, isPast: isPast, formHtml: formHtml, read: read, showError: showError, access: access, NOT_PI: NOT_PI, visibilityEffects: visibilityEffects,
    inviteText: inviteText, inviteSelectHtml: inviteSelectHtml };
})();
