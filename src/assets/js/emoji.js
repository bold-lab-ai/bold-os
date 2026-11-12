// Emoji by name, as on Slack: in any text box (a textarea, or a one-line text field but those marked .no-emoji or
// spellcheck="false", such as a slug), typing : and two letters of a name (:ta) lists the emoji it starts or is in
// (🎉 tada); arrows and Enter or Tab pick one, Esc closes. A whole :name: typed becomes its emoji at once. The emoji
// itself is written, not its name, so it shows the same everywhere (Slack too). The names are Slack's
// (emoji-data.js, loaded when first needed). Loaded on every signed-in page (base.njk), after mentions.js
// (BoldCaret). One list for the whole page, on whichever box is being typed in.
(function(){
  // Pure: the ":name" being typed just before the caret, if any → { start, query } (start: where the : is). Two
  // letters at least, after a space, a bracket or the start, so times (10:30) and links don't open it.
  function typing(before){
    var m = /(^|[\s(\[])(:([a-z0-9_+\-]{2,40}))$/i.exec(before);
    return m ? { start: before.length - m[2].length, query: m[3].toLowerCase() } : null;
  }
  // Pure: a whole ":name:" just typed → { start, name }, or null.
  function whole(before){
    var m = /(^|[\s(\[])(:([a-z0-9_+\-]{1,40}):)$/i.exec(before);
    return m ? { start: before.length - m[2].length, name: m[3].toLowerCase() } : null;
  }
  // Pure: the list (one line per emoji: the emoji, then its names) → [{ e, names }].
  function parse(text){
    return String(text || '').split('\n').filter(Boolean).map(function(l){ var p = l.split(' '); return { e: p[0], names: p.slice(1) }; });
  }
  // Pure: up to `max` emoji for a query: a name that is it, then names starting with it, then names with it after
  // an underscore, then in the list's order. → [{ e, name }] (the name it matched).
  function find(all, q, max){
    var hits = [];
    all.forEach(function(x, i){
      var best = null;
      x.names.forEach(function(n){
        var r = n === q ? 0 : n.indexOf(q) === 0 ? 1 : n.indexOf('_' + q) >= 0 ? 2 : -1;
        if (r >= 0 && (!best || r < best.r)) best = { r: r, name: n };
      });
      if (best) hits.push({ e: x.e, name: best.name, r: best.r, i: i });
    });
    hits.sort(function(a, b){ return a.r - b.r || a.i - b.i; });
    return hits.slice(0, max || 8).map(function(h){ return { e: h.e, name: h.name }; });
  }
  // Pure: a name's emoji, or ''.
  function byName(all, name){
    for (var i = 0; i < all.length; i++) if (all[i].names.indexOf(name) >= 0) return all[i].e;
    return '';
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { typing: typing, whole: whole, parse: parse, find: find, byName: byName }; return; }

  var all = null, loading = null;
  var box = null, list = [], at = 0, field = null, start = -1;

  function load(){
    if (all) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function(done){
      var s = document.createElement('script');
      var v = (document.querySelector('script[src*="emoji.js"]') || {}).src || '';
      s.src = 'assets/js/emoji-data.js' + (v.indexOf('?') >= 0 ? v.slice(v.indexOf('?')) : '');
      s.onload = function(){ all = parse(window.BoldEmojiData); done(); };
      s.onerror = function(){ console.error('[BOLD Emoji] loading the list failed'); all = []; done(); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function close(){ if (box) box.remove(); box = null; list = []; field = null; start = -1; }

  // Writes `text` in place of what's from `from` to the caret, and tells whoever keeps what's typed.
  function put(ta, from, text){
    var to = ta.selectionStart;
    ta.value = ta.value.slice(0, from) + text + ta.value.slice(to);
    var c = from + text.length;
    ta.setSelectionRange(c, c);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function show(ta){
    var before = ta.value.slice(0, ta.selectionStart);
    if (!/:[^\s:]*:?$/.test(before)) { if (field === ta) close(); return; }
    if (!all) { load().then(function(){ if (document.activeElement === ta) show(ta); }); return; }
    var w = whole(before), e = w && byName(all, w.name);
    if (e) { close(); put(ta, w.start, e); return; }
    var t = typing(before);
    list = t ? find(all, t.query, 8) : [];
    if (!list.length) { if (field === ta) close(); return; }
    field = ta; start = t.start; at = Math.min(at, list.length - 1);
    if (!box) {
      box = document.createElement('ul');
      box.className = 'mention-list emoji-list'; box.setAttribute('role', 'listbox');
      box.addEventListener('mousedown', function(ev){
        ev.preventDefault();
        var li = ev.target.closest('li'); if (li) pick(Number(li.getAttribute('data-i')));
      });
      document.body.appendChild(box);
    }
    box.innerHTML = list.map(function(x, i){
      return '<li role="option" data-i="' + i + '"' + (i === at ? ' class="is-active" aria-selected="true"' : '') + '><span class="emoji-list-e">' + x.e + '</span> ' + BOLD.escapeHtml(x.name) + '</li>';
    }).join('');
    var c = window.BoldCaret ? BoldCaret(ta) : (function(r){ return { top: r.bottom, left: r.left }; })(ta.getBoundingClientRect());
    box.style.top = (c.top + window.scrollY + 4) + 'px';
    box.style.left = Math.min(c.left + window.scrollX, window.scrollX + window.innerWidth - 330) + 'px';
  }

  function pick(i){
    var x = list[i], ta = field, from = start;
    if (!x || !ta) return;
    close();
    put(ta, from, x.e);
  }

  function isField(el){
    if (!el || el.readOnly || el.disabled || el.closest('.no-emoji')) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && /^(text|search)$/.test(el.type) && el.getAttribute('spellcheck') !== 'false';
  }
  document.addEventListener('input', function(e){ if (isField(e.target)) { if (field !== e.target) at = 0; show(e.target); } });
  // Before the page's own keys (Enter sending a comment, say), while the list is open.
  document.addEventListener('keydown', function(e){
    if (!box || e.target !== field || e.metaKey || e.ctrlKey || e.isComposing) return;
    if (e.key === 'ArrowDown') { at = (at + 1) % list.length; show(field); }
    else if (e.key === 'ArrowUp') { at = (at + list.length - 1) % list.length; show(field); }
    else if (e.key === 'Enter' || e.key === 'Tab') pick(at);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('focusout', function(e){ if (e.target === field) setTimeout(close, 100); });
})();
