// An event's days and time slots — the `days` of its events/{slug} doc:
//   days:  [{ id, date ('YYYY-MM-DD'), title, note, slots }]
//   slots: [{ id, start, end ('HH:MM', either may be ''), kind, title, text, sessions }]
// A slot's kind is 'item' (a break, a meal, a plain line: title and text) or
// 'sessions' (session slugs, side by side when more than one; only on events
// that have sessions — the page passes `sessionCards`). A session's day and
// time are its slot's: findSession() is how its pages look them up.
//
// PIs/admins add, edit and delete days and slots here; the controls are
// always shown, greyed out for everyone else (firestore.rules). A new slot is
// added with the "+" on the line where it goes (its times start from its
// neighbours'); a plain item (a break, a meal) has its own pencil and ×, a
// slot of sessions is changed through its sessions (event-sessions.js) — and
// an empty one has a × of its own. Deleting a day deletes the sessions in it
// too (the page's deleteSessions).
window.EventSchedule = (function(){
  var esc = BOLD.escapeHtml;
  var NOT_PI = 'Only PIs and admins can change the schedule';
  var PENCIL = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M11.6 1.6a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1L5.6 13.2l-3.5.9.9-3.5 8.6-9zM10.9 3.7l1.4 1.4 1.1-1.1-1.4-1.4-1.1 1.1z"/></svg>';
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // '2026-10-05' → 'Monday 5 Oct'.
  function dayLabel(date){
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  // → '09:00–09:45', '17:30→' (no end), or ''.
  function slotTime(s){ return s.start ? s.start + (s.end ? '–' + s.end : '→') : ''; }

  function newId(){ return Math.random().toString(36).slice(2, 10); }

  // Days by date; a day's slots by start time, untimed ones last.
  function sorted(days){
    return (days || []).slice().sort(function(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .map(function(d){
        var slots = (d.slots || []).map(function(s, i){ return { s: s, i: i }; }).sort(function(a, b){
          var x = a.s.start || '99:99', y = b.s.start || '99:99';
          return x < y ? -1 : x > y ? 1 : a.i - b.i;
        }).map(function(o){ return o.s; });
        return Object.assign({}, d, { slots: slots });
      });
  }

  // Where a session sits → { date, day ('Monday 5 Oct'), time ('09:00–09:45'), start, end }, or null.
  function findSession(days, slug){
    var found = null;
    (days || []).forEach(function(d){
      (d.slots || []).forEach(function(s){
        if (!found && (s.sessions || []).indexOf(slug) >= 0) found = { date: d.date, day: dayLabel(d.date), time: slotTime(s), start: s.start || '', end: s.end || '' };
      });
    });
    return found;
  }

  // Moves a session to the day `date`, start–end, of its event (ref): into the
  // slot of sessions already at that time, or a new one; the slot it leaves
  // goes if that leaves it empty. → Promise.
  function moveSession(ref, slug, date, start, end, email){
    return ref.firestore.runTransaction(function(tx){
      return tx.get(ref).then(function(snap){
        var days = JSON.parse(JSON.stringify((snap.data() || {}).days || []));
        var day = days.filter(function(d){ return d.date === date; })[0];
        if (!day) throw new Error('There’s no ' + dayLabel(date) + ' in the schedule — add the day first.');
        days.forEach(function(d){
          d.slots = (d.slots || []).filter(function(s){
            var had = (s.sessions || []).indexOf(slug) >= 0;
            s.sessions = (s.sessions || []).filter(function(x){ return x !== slug; });
            return !(had && s.kind === 'sessions' && !s.sessions.length);
          });
        });
        var slot = day.slots.filter(function(s){ return s.kind === 'sessions' && s.start === start && s.end === end; })[0];
        if (slot) slot.sessions.push(slug);
        else day.slots.push({ id: newId(), start: start, end: end, kind: 'sessions', title: '', text: '', sessions: [slug] });
        tx.update(ref, { days: days, updatedAt: Date.now(), updatedBy: email });
      });
    });
  }

  function icon(cls, label, html, on){
    return '<button type="button" class="icon-btn ' + cls + '" aria-label="' + label + '" title="' + (on ? label : NOT_PI) + '"' + (on ? '' : ' disabled') + '>' + html + '</button>';
  }

  function button(cls, label, on, extra){
    return '<button type="button" class="btn-text ' + cls + '"' + (on ? '' : ' disabled title="' + NOT_PI + '"') + (extra || '') + '>' + label + '</button>';
  }

  // el: where the days go. opts:
  //   ref            the event's doc (events/{slug})
  //   sessionCards   (slot, day) → the cards' HTML; without it, no 'sessions' slots
  //   addSession     (host, day, slot) → opens a form in `host` that adds a
  //                  session to the slot (the page writes it, then calls
  //                  EventSchedule.addToSlot)
  //   deleteSessions (slugs) → Promise; deletes them for good
  //   onRender       (el) → after each render
  // → { update(event, fullWrite, me) }
  function mount(el, opts){
    var x = null, fullWrite = false, me = null;
    var open = null;   // { what: 'day'|'slot', dayId, slotId } — the form that's open (no id: a new one)
    var err = '';

    function change(mutate){
      var db = opts.ref.firestore;
      return db.runTransaction(function(tx){
        return tx.get(opts.ref).then(function(snap){
          var days = JSON.parse(JSON.stringify((snap.data() || {}).days || []));
          mutate(days);
          tx.update(opts.ref, { days: days, updatedAt: Date.now(), updatedBy: me.email });
        });
      });
    }
    function failed(what){
      return function(e){
        console.error('[BOLD Events] ' + what + ' failed', e);
        err = 'Couldn’t ' + what + ' — try again.';
        render();
      };
    }

    function dayForm(d){
      return '<div class="sched-form" data-form="day">' +
        '<p class="sched-form-head">' + (d.id ? 'Edit ' + esc(dayLabel(d.date)) : 'New day') + '</p>' +
        '<div class="sched-row"><label>Date<input type="date" class="sf-date" value="' + esc(d.date || '') + '"></label>' +
        '<label>Title<input type="text" class="sf-title" value="' + esc(d.title || '') + '" placeholder="optional, e.g. Launch Day"></label></div>' +
        '<label>Note<input type="text" class="sf-note" value="' + esc(d.note || '') + '" placeholder="optional, e.g. where it is"></label>' +
        formEnd(d.id ? 'Save' : 'Add day') + '</div>';
    }
    function slotForm(s){
      var hasSessions = (s.sessions || []).length > 0;
      // 'break' is a plain item titled "Break", picked as a kind of its own.
      var kind = s.kind === 'item' && s.title === 'Break' && !s.text ? 'break' : s.kind || 'item';
      return '<div class="sched-form" data-form="slot">' +
        '<p class="sched-form-head">' + (s.id ? 'Edit time slot' : 'New time slot') + '</p>' +
        '<div class="sched-row"><label>Starts<input type="time" class="sf-start" step="300" value="' + esc(s.start || '') + '"></label>' +
        '<label>Ends<input type="time" class="sf-end" step="300" value="' + esc(s.end || '') + '"></label></div>' +
        (opts.sessionCards && !hasSessions
          ? '<label>What<select class="sf-kind"><option value="sessions"' + (kind === 'sessions' ? ' selected' : '') + '>Sessions</option>' +
            '<option value="break"' + (kind === 'break' ? ' selected' : '') + '>Break</option>' +
            '<option value="item"' + (kind === 'item' ? ' selected' : '') + '>Something else — a meal, arrival…</option></select></label>'
          : '') +
        '<div class="sf-item"' + (kind === 'item' ? '' : ' hidden') + '>' +
        '<label>Title<input type="text" class="sf-title" value="' + esc(s.title || '') + '" placeholder="e.g. Lunch · Natural History Museum"></label>' +
        '<label>Details<textarea class="sf-text" rows="3" placeholder="optional">' + esc(s.text || '') + '</textarea></label></div>' +
        formEnd(s.id ? 'Save' : 'Add time slot') + '</div>';
    }
    function formEnd(label){
      return '<p class="sched-error"' + (err ? '' : ' hidden') + '>' + esc(err) + '</p>' +
        '<div class="sched-actions"><button type="button" class="sf-save">' + label + '</button><button type="button" class="sf-cancel">Cancel</button></div>';
    }

    function slotHtml(d, s){
      var isOpen = open && open.what === 'slot' && open.slotId === s.id;
      if (isOpen) return slotForm(s);
      var sessions = s.kind === 'sessions';
      var plain = !sessions && !s.text;
      var body = sessions
        ? opts.sessionCards(s, d) +
          '<span class="slot-add-wrap">' + button('slot-add-session', '+ Add a session', fullWrite) +
          ((s.sessions || []).length ? '' : ' ' + icon('slot-delete', 'Delete this empty time slot', '×', fullWrite)) + '</span>'
        : '<span class="slot-title">' + esc(s.title || '') + '</span>' +
          (s.text ? '<span class="slot-text">' + esc(s.text).replace(/\n/g, '<br>') + '</span>' : '') +
          '<span class="slot-icons">' + icon('slot-edit', 'Edit this time slot', PENCIL, fullWrite) + icon('slot-delete', 'Delete this time slot', '×', fullWrite) + '</span>';
      return '<div class="slot' + (plain ? ' slot-logistics' : sessions ? '' : ' slot-item') + '" data-slot-id="' + esc(s.id) + '">' +
        '<div class="slot-time">' + esc(slotTime(s)) + '</div>' +
        '<div class="slot-sessions">' + body + '</div>' +
        '<div class="slot-session-form"></div></div>';
    }

    function render(){
      if (!x) return;
      var days = sorted(x.days);
      var html = days.map(function(d){
        var editingDay = open && open.what === 'day' && open.dayId === d.id;
        var head = editingDay ? dayForm(d) :
          '<div class="day-head"><h3>' + esc(dayLabel(d.date)) + (d.title ? ' &mdash; ' + esc(d.title) : '') + '</h3>' +
          '<span class="sched-ctl">' + button('day-edit', 'Edit', fullWrite) + button('day-delete danger', 'Delete', fullWrite) + '</span></div>' +
          (d.note ? '<p class="day-note">' + esc(d.note) + '</p>' : '');
        var adding = open && open.what === 'slot' && open.dayId === d.id && !open.slotId;
        // The "+" on the line before slot i (i = slots.length: after the last), or the new slot's form there.
        var gap = function(i){
          if (adding && open.at === i) {
            var prev = d.slots[i - 1], next = d.slots[i];
            return slotForm({ kind: opts.sessionCards ? 'sessions' : 'item', start: prev ? prev.end || prev.start : '', end: next ? next.start : '' });
          }
          return '<div class="slot-gap" data-at="' + i + '"><button type="button" class="gap-add" aria-label="Add a time slot here" title="' +
            (fullWrite ? 'Add a time slot here' : NOT_PI) + '"' + (fullWrite ? '' : ' disabled') + '>+</button></div>';
        };
        return '<div class="day-card" id="day-' + esc(d.date) + '" data-date="' + esc(d.date) + '" data-label="' + esc(dayLabel(d.date)) + '" data-day-id="' + esc(d.id) + '">' +
          head + '<div class="slots">' + gap(0) + d.slots.map(function(s, i){ return slotHtml(d, s) + gap(i + 1); }).join('') + '</div>' +
          '</div>';
      }).join('');
      var addingDay = open && open.what === 'day' && !open.dayId;
      html += addingDay ? dayForm({}) : button('sched-add-day', '+ Add a day', fullWrite);
      if (!days.length && !fullWrite) html = '<p class="sched-empty">No schedule yet.</p>' + html;
      el.innerHTML = html;

      // A slot of sessions with more than one showing lays them out side by side; one with none is hidden, except to PIs/admins.
      Array.prototype.forEach.call(el.querySelectorAll('.slot[data-slot-id]'), function(sl){
        var box = sl.querySelector('.slot-sessions');
        var cards = box.querySelectorAll('.session-card');
        if (!cards.length && !box.querySelector('.slot-add-session')) return;
        var shown = box.querySelectorAll('.session-card:not([hidden])').length;
        box.classList.toggle('is-parallel', shown > 1);
        sl.hidden = shown === 0 && !fullWrite;
        // …and so is the "+" after it, so a hidden slot doesn't leave two on one line.
        if (sl.hidden && sl.nextElementSibling && sl.nextElementSibling.classList.contains('slot-gap')) sl.nextElementSibling.hidden = true;
      });
      var form = el.querySelector('.sched-form');
      if (form) wireForm(form);
      if (opts.onRender) opts.onRender(el);
    }

    function wireForm(form){
      var q = function(c){ return form.querySelector(c); };
      var first = form.querySelector('input'); if (first) first.focus();
      var kind = q('.sf-kind');
      if (kind) kind.addEventListener('change', function(){ q('.sf-item').hidden = kind.value !== 'item'; });
      q('.sf-cancel').addEventListener('click', function(){ open = null; err = ''; render(); });
      q('.sf-save').addEventListener('click', function(){
        var o = open, v = function(c){ var i = q(c); return i ? i.value.trim() : ''; };
        var e = '', mutate;
        if (form.getAttribute('data-form') === 'day') {
          var date = v('.sf-date');
          var clash = (x.days || []).some(function(d){ return d.date === date && d.id !== o.dayId; });
          e = !date ? 'Set the day’s date.' : clash ? 'There’s already a day on ' + dayLabel(date) + '.' : '';
          var fields = { date: date, title: v('.sf-title'), note: v('.sf-note') };
          mutate = function(days){
            if (!o.dayId) days.push(Object.assign({ id: newId(), slots: [] }, fields));
            else days.forEach(function(d){ if (d.id === o.dayId) Object.assign(d, fields); });
          };
        } else {
          var start = v('.sf-start'), end = v('.sf-end');
          var k = kind ? kind.value : (o.slotId ? (findSlot(o.dayId, o.slotId) || {}).kind : 'item') || 'item';
          var s = k === 'break' ? { start: start, end: end, kind: 'item', title: 'Break', text: '' }
            : { start: start, end: end, kind: k, title: k === 'item' ? v('.sf-title') : '', text: k === 'item' ? v('.sf-text') : '' };
          e = k === 'sessions' && (!start || !end) ? 'A slot for sessions needs a start and an end.' :
            k === 'item' && !s.title ? 'Give it a title.' :
            start && end && end <= start ? 'It has to end after it starts.' : end && !start ? 'Set when it starts.' : '';
          mutate = function(days){
            days.forEach(function(d){
              if (d.id !== o.dayId) return;
              d.slots = d.slots || [];
              if (!o.slotId) d.slots.push(Object.assign({ id: newId(), sessions: [] }, s));
              else d.slots.forEach(function(x){ if (x.id === o.slotId) Object.assign(x, s); });
            });
          };
        }
        if (e) { err = e; var box = q('.sched-error'); box.textContent = e; box.hidden = false; return; }
        q('.sf-save').disabled = true;
        change(mutate).then(function(){ open = null; err = ''; render(); }).catch(failed('save that'));
      });
    }

    function findDay(id){ return (x.days || []).filter(function(d){ return d.id === id; })[0]; }
    function findSlot(dayId, id){ return ((findDay(dayId) || {}).slots || []).filter(function(s){ return s.id === id; })[0]; }

    // Deletes the sessions first (for good), then the slots or day that held them.
    function remove(what, sessions, mutate){
      var n = sessions.length;
      var msg = 'Delete ' + what + (n ? ', and the ' + (n === 1 ? 'session in it with its talks,' : n + ' sessions in it with their talks,') : '') + ' for good? This can’t be undone.';
      if (!window.confirm(msg)) return;
      (n ? opts.deleteSessions(sessions) : Promise.resolve()).then(function(){ return change(mutate); }).catch(failed('delete that'));
    }

    el.addEventListener('click', function(e){
      var b = e.target.closest('button');
      if (!b || b.disabled || !fullWrite || b.closest('.sched-form') || b.closest('.session-card')) return;
      var dayEl = b.closest('.day-card'), slotEl = b.closest('.slot[data-slot-id]');
      var dayId = dayEl && dayEl.getAttribute('data-day-id'), slotId = slotEl && slotEl.getAttribute('data-slot-id');
      err = '';
      if (b.classList.contains('sched-add-day')) { open = { what: 'day' }; render(); }
      else if (b.classList.contains('day-edit')) { open = { what: 'day', dayId: dayId }; render(); }
      else if (b.classList.contains('gap-add')) { open = { what: 'slot', dayId: dayId, at: Number(b.parentNode.getAttribute('data-at')) }; render(); }
      else if (b.classList.contains('slot-edit')) { open = { what: 'slot', dayId: dayId, slotId: slotId }; render(); }
      else if (b.classList.contains('day-delete')) {
        var d = findDay(dayId);
        var all = [].concat.apply([], (d.slots || []).map(function(s){ return s.sessions || []; }));
        remove(dayLabel(d.date) + ' and its time slots', all, function(days){
          for (var i = days.length - 1; i >= 0; i--) if (days[i].id === dayId) days.splice(i, 1);
        });
      } else if (b.classList.contains('slot-delete')) {
        var s = findSlot(dayId, slotId);
        remove('the ' + ([slotTime(s), s.title].filter(Boolean).join(' ') || 'untimed') + ' slot on ' + dayLabel(findDay(dayId).date), s.sessions || [], function(days){
          days.forEach(function(d){ if (d.id === dayId) d.slots = (d.slots || []).filter(function(x){ return x.id !== slotId; }); });
        });
      } else if (b.classList.contains('slot-add-session') && opts.addSession) {
        var host = slotEl.querySelector('.slot-session-form');
        if (host.firstChild) return;
        b.hidden = true;
        opts.addSession(host, findDay(dayId), findSlot(dayId, slotId), function(){ host.innerHTML = ''; b.hidden = false; });
      }
    });

    return {
      update: function(event, canWrite, user){
        x = event; fullWrite = !!canWrite; me = user;
        if (open && !fullWrite) open = null;
        // A form that's open stays as typed: re-render only when none is.
        if (!el.querySelector('.sched-form, .slot-session-form > *')) render();
      },
      // Adds a session's slug to a slot (after the page has created it).
      addToSlot: function(dayId, slotId, slug){
        return change(function(days){
          days.forEach(function(d){ (d.slots || []).forEach(function(s){
            if (d.id === dayId && s.id === slotId) { s.sessions = s.sessions || []; if (s.sessions.indexOf(slug) < 0) s.sessions.push(slug); }
          }); });
        });
      },
      // Takes a session's slug out of whatever slot holds it (after it's deleted).
      dropFromSlots: function(slug){
        return change(function(days){
          days.forEach(function(d){ (d.slots || []).forEach(function(s){ s.sessions = (s.sessions || []).filter(function(x){ return x !== slug; }); }); });
        });
      },
      render: render
    };
  }

  return { mount: mount, dayLabel: dayLabel, slotTime: slotTime, findSession: findSession, moveSession: moveSession, sorted: sorted, NOT_PI: NOT_PI, PENCIL: PENCIL };
})();
