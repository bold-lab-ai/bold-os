// Tagging people: in any textarea (but those in .no-tags: text that leaves BOLD.OS,
// such as an abstract or a SKILL.md), typing @ and the start of a name lists the
// lab's people (the `people` roster); picking one writes @[Name](SlackId), which
// bold.js shows as @Name, linking to their Slack profile. Loaded on every signed-in
// page (base.njk). Whoever is tagged gets a Slack DM (functions/index.js, "Tagging
// people"). One list for the whole page, on whichever box is being typed in.
(function(){
  var people = null, loading = null;
  var box = null, list = [], at = 0, field = null, start = -1;

  function load(){
    if (people || loading) return loading;
    var db;
    try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return null; }
    loading = db.collection('people').get().then(function(snap){
      people = snap.docs.map(function(d){ var p = d.data(); return { name: p.name || '', id: p.slackId || d.id }; })
        .filter(function(p){ return p.name && /^U[A-Z0-9]+$/.test(p.id); })
        .sort(function(a, b){ return a.name.localeCompare(b.name); });
    }).catch(function(err){ console.error('[BOLD Mentions] loading people failed', err); people = []; });
    return loading;
  }

  function close(){ if (box) box.remove(); box = null; list = []; field = null; start = -1; }

  // The "@name" being typed just before the caret, if any → { start, query }.
  function typing(ta){
    var upto = ta.value.slice(0, ta.selectionStart);
    var m = /(^|[\s(])@([^\s@\[\]()]{0,30}(?: [^\s@\[\]()]{0,30})?)$/.exec(upto);
    return m ? { start: upto.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
  }

  function show(ta){
    var t = typing(ta);
    if (!t) { close(); return; }
    if (!people) { var l = load(); if (l) l.then(function(){ if (document.activeElement === ta) show(ta); }); return; }
    list = people.filter(function(p){
      var n = p.name.toLowerCase();
      return !t.query || n.indexOf(t.query) === 0 || n.split(' ').some(function(w){ return w.indexOf(t.query) === 0; });
    }).slice(0, 8);
    if (!list.length) { close(); return; }
    field = ta; start = t.start; at = Math.min(at, list.length - 1);
    if (!box) {
      box = document.createElement('ul');
      box.className = 'mention-list'; box.setAttribute('role', 'listbox');
      box.addEventListener('mousedown', function(e){
        e.preventDefault();
        var li = e.target.closest('li'); if (li) pick(Number(li.getAttribute('data-i')));
      });
      document.body.appendChild(box);
    }
    box.innerHTML = list.map(function(p, i){
      return '<li role="option" data-i="' + i + '"' + (i === at ? ' class="is-active" aria-selected="true"' : '') + '>@' + BOLD.escapeHtml(p.name) + '</li>';
    }).join('');
    var c = caret(ta);
    box.style.top = (c.top + window.scrollY + 4) + 'px';
    box.style.left = Math.min(c.left + window.scrollX, window.scrollX + window.innerWidth - 330) + 'px';
  }

  // Where the caret is on screen (the bottom of its line): a hidden copy of the box,
  // styled alike, holds the text up to it and a marker.
  var PROPS = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'];
  function caret(ta){
    var cs = getComputedStyle(ta), m = document.createElement('div');
    PROPS.forEach(function(k){ m.style[k] = cs[k]; });
    m.style.position = 'absolute'; m.style.visibility = 'hidden'; m.style.whiteSpace = 'pre-wrap'; m.style.wordWrap = 'break-word'; m.style.top = '0'; m.style.left = '-9999px';
    m.textContent = ta.value.slice(0, ta.selectionStart);
    var mark = document.createElement('span'); mark.textContent = '\u200b'; m.appendChild(mark);
    document.body.appendChild(m);
    var r = ta.getBoundingClientRect(), line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    var top = r.top + mark.offsetTop - ta.scrollTop + line, left = r.left + mark.offsetLeft - ta.scrollLeft;
    m.remove();
    return { top: Math.min(top, r.bottom), left: left };
  }

  function pick(i){
    var p = list[i], ta = field;
    if (!p || !ta) return;
    var tag = '@[' + p.name + '](' + p.id + ') ';
    ta.value = ta.value.slice(0, start) + tag + ta.value.slice(ta.selectionStart);
    var caret = start + tag.length;
    close();
    ta.focus(); ta.setSelectionRange(caret, caret);
    // Whoever keeps what's typed (comments.js drafts) hears of it.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isField(el){ return el && el.tagName === 'TEXTAREA' && !el.closest('.no-tags'); }
  document.addEventListener('input', function(e){ if (isField(e.target)) { if (field !== e.target) at = 0; show(e.target); } });
  document.addEventListener('keydown', function(e){
    if (!box || e.target !== field || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowDown') { at = (at + 1) % list.length; show(field); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { at = (at + list.length - 1) % list.length; show(field); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { pick(at); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  document.addEventListener('focusout', function(e){ if (e.target === field) setTimeout(close, 100); });
  document.addEventListener('focusin', function(e){ if (isField(e.target)) load(); });
})();
