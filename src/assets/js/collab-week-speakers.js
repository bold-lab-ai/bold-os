// The speaker rows for a Collaboration Week talk added on the site — each
// one a person from the Slack roster or, like a project's "+ New author", a
// new person (name, and their email if they'll sign in). Shared by the
// session page's "Add a talk" form and an added talk's edit form. The
// speakers' emails are who can edit the talk (editTalk/createTalk in
// functions/index.js), and their names make up its "Speaker" line.
// Rows are { name, email, isNew }; `people` is the `people` roster.
//
// A roster person is found by typing: the matches (name or email, accents
// and case ignored) drop down under the box, picked by click or ↑/↓ + Enter;
// the last option turns what's typed into a new speaker.
window.CollabWeekSpeakers = (function(){
  var esc = BOLD.escapeHtml;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var MAX_RESULTS = 8;

  function fold(s){ return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }

  function matches(people, q){
    var words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return people.filter(function(p){
      var hay = fold(p.name) + ' ' + fold(p.email);
      return p.email && words.every(function(w){ return hay.indexOf(w) >= 0; });
    }).slice(0, MAX_RESULTS);
  }

  function rowsFrom(speakers, people){
    var rows = (speakers || []).map(function(s){
      var p = s.email && people.filter(function(x){ return x.email === s.email; })[0];
      return { name: s.name || '', email: s.email || '', isNew: !p };
    });
    return rows.length ? rows : [{ name: '', email: '', isNew: false }];
  }

  function rowHtml(r, i, n){
    var label = 'Speaker ' + (i + 1);
    var control;
    if (r.isNew) {
      control = '<input type="text" class="spk-name" data-i="' + i + '" value="' + esc(r.name) + '" placeholder="Name" aria-label="' + label + ' name">' +
        '<input type="text" class="spk-email" data-i="' + i + '" value="' + esc(r.email) + '" placeholder="Email (if they’ll sign in)" aria-label="' + label + ' email">' +
        '<button type="button" class="btn-text spk-roster" data-i="' + i + '">Pick from list instead</button>';
    } else if (r.email) {
      control = '<span class="spk-chosen">' + esc(r.name) + ' <span class="detail-muted">' + esc(r.email) + '</span></span>' +
        '<button type="button" class="btn-text spk-roster" data-i="' + i + '">Change</button>';
    } else {
      control = '<div class="spk-search"><input type="text" class="spk-q" data-i="' + i + '" placeholder="Type a name or email…" autocomplete="off"' +
        ' role="combobox" aria-expanded="false" aria-autocomplete="list" aria-label="' + label + '">' +
        '<ul class="spk-results" role="listbox" hidden></ul></div>';
    }
    return '<div class="lead-row">' + control +
      (n > 1 ? '<button type="button" class="btn-text danger spk-remove" data-i="' + i + '">Remove</button>' : '') + '</div>';
  }

  // Draws the rows into `wrap` and redraws them on every change. `focus`:
  // the row whose search box (or name box) gets the focus afterwards.
  function mount(wrap, rows, people, focus){
    wrap.innerHTML = rows.map(function(r, i){ return rowHtml(r, i, rows.length); }).join('') +
      '<button type="button" class="btn-text spk-add">+ Add a speaker</button>' +
      '<p class="edit-hint">Speakers with an email can edit the talk once they sign in with it.</p>';
    var redraw = function(f){ mount(wrap, rows, people, f); };

    wrap.querySelectorAll('.spk-q').forEach(function(input){
      var i = Number(input.getAttribute('data-i'));
      var list = input.nextElementSibling;
      var found = [], active = 0;
      function pick(k){
        if (k < found.length) rows[i] = { name: found[k].name || '', email: found[k].email, isNew: false };
        else rows[i] = { name: input.value.trim(), email: '', isNew: true };
        redraw(k < found.length ? null : i);
      }
      function show(){
        found = matches(people, input.value);
        active = 0;
        var q = input.value.trim();
        list.innerHTML = found.map(function(p, k){
          return '<li role="option" data-k="' + k + '"' + (k === active ? ' class="active"' : '') + '>' + esc(p.name) +
            '<span class="detail-muted">' + esc(p.email) + '</span></li>';
        }).join('') +
          '<li role="option" data-k="' + found.length + '" class="spk-new' + (found.length ? '' : ' active') + '">+ New speaker' +
          (q ? ': “' + esc(q) + '”' : '') + ' (not in the workspace)</li>';
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        list.querySelectorAll('li').forEach(function(li){
          // mousedown, not click: fires before the input's blur hides the list.
          li.addEventListener('mousedown', function(e){ e.preventDefault(); pick(Number(li.getAttribute('data-k'))); });
        });
      }
      function hide(){ list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
      function highlight(k){
        var items = list.querySelectorAll('li');
        active = (k + items.length) % items.length;
        items.forEach(function(li, j){ li.classList.toggle('active', j === active); });
        items[active].scrollIntoView({ block: 'nearest' });
      }
      input.addEventListener('input', function(){ rows[i].query = input.value; if (input.value.trim()) show(); else hide(); });
      input.addEventListener('focus', function(){ if (input.value.trim()) show(); });
      input.addEventListener('blur', hide);
      input.addEventListener('keydown', function(e){
        if (list.hidden) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
        else if (e.key === 'Escape') { e.preventDefault(); hide(); }
      });
      if (focus === i) input.focus();
    });
    wrap.querySelectorAll('.spk-name').forEach(function(inp){
      inp.addEventListener('input', function(){ rows[Number(inp.getAttribute('data-i'))].name = inp.value; });
      if (focus === Number(inp.getAttribute('data-i'))) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    });
    wrap.querySelectorAll('.spk-email').forEach(function(inp){
      inp.addEventListener('input', function(){ rows[Number(inp.getAttribute('data-i'))].email = inp.value; });
    });
    wrap.querySelectorAll('.spk-roster').forEach(function(btn){
      btn.addEventListener('click', function(){
        var i = Number(btn.getAttribute('data-i'));
        rows[i] = { name: '', email: '', isNew: false };
        redraw(i);
      });
    });
    wrap.querySelectorAll('.spk-remove').forEach(function(btn){
      btn.addEventListener('click', function(){ rows.splice(Number(btn.getAttribute('data-i')), 1); redraw(); });
    });
    wrap.querySelector('.spk-add').addEventListener('click', function(){
      rows.push({ name: '', email: '', isNew: false });
      redraw(rows.length - 1);
    });
  }

  // → { speakers: [{ name, email }] } or { error }. A search box with text
  // in it but nobody picked is an error rather than silently dropped.
  function toSave(rows){
    var speakers = [], error = null;
    rows.forEach(function(r){
      var name = r.name.trim(), email = r.email.trim().toLowerCase();
      if (!name && !email) {
        if ((r.query || '').trim()) error = error || 'Pick a person for “' + r.query.trim() + '”, or choose “+ New speaker”.';
        return;
      }
      if (!name) error = error || 'Give the speaker with ' + email + ' a name.';
      else if (email && !EMAIL.test(email)) error = error || 'Not an email: ' + email;
      speakers.push({ name: name, email: email });
    });
    return error ? { error: error } : { speakers: speakers };
  }

  return { rowsFrom: rowsFrom, mount: mount, toSave: toSave };
})();
