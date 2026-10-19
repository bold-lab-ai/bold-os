// The search box in the masthead (every signed-in page; partials/masthead.njk),
// GitHub-style: typing offers to search the section you're in, everywhere, or
// another section (BoldSearch.SCOPES); Enter or Tab, or a click, opens search.html?q=&in=.
// "in:<scope>" in the text picks the section too. "/" focuses the box.
window.BoldSearch = (function(){
  var esc = BOLD.escapeHtml;
  // Where one can search: key, label, and the pages that belong to it.
  var SCOPES = [
    { key: 'boldiquette', label: 'BOLDiquette', pages: /^(boldiquette|index)\.html$/ },
    { key: 'guides', label: 'How to', pages: /^(guides?|get-started)\.html$/ },
    { key: 'skills', label: 'Skills', pages: /^skills?\.html$/ },
    { key: 'events', label: 'Events', pages: /^(events?|session|talk|event-collaboration-week.*)\.html$/ },
    { key: 'projects', label: 'Projects', pages: /^(projects?|project-meetings|projects-register)\.html$/ },
    { key: 'board', label: 'Review board', pages: /^(audit-board|how-to-submit-a-paper)\.html$/ },
    { key: 'comments', label: 'Comments', pages: /^comments\.html$/ },
  ];
  function scope(key){ return SCOPES.filter(function(s){ return s.key === key; })[0] || null; }
  // The section the page you're on belongs to, or null.
  function here(){
    var page = location.pathname.split('/').pop() || 'index.html';
    if (page === 'search.html') return scope(new URLSearchParams(location.search).get('in'));
    return SCOPES.filter(function(s){ return s.pages.test(page); })[0] || null;
  }
  // "in:skills foo" → { q: 'foo', in: 'skills' }.
  function parse(text){
    var m = /(^|\s)in:(\S+)/.exec(text), key = m && scope(m[2].toLowerCase()) ? m[2].toLowerCase() : '';
    return { q: (key ? text.replace(m[0], ' ') : text).replace(/\s+/g, ' ').trim(), in: key };
  }
  function href(q, key){ return 'search.html?q=' + encodeURIComponent(q) + (key ? '&in=' + key : ''); }

  function mount(){
    var box = document.getElementById('mastSearch');
    if (!box) return;
    var cur = here();
    box.innerHTML = '<form class="ms-form" action="search.html" role="search">' +
      '<input class="ms-input" name="q" type="search" placeholder="Search' + (cur ? ' ' + esc(cur.label) : '') + '" aria-label="Search BOLD.OS" autocomplete="off" spellcheck="false">' +
      '<kbd class="ms-key" aria-hidden="true">/</kbd></form><ul class="ms-menu" role="listbox" hidden></ul>';
    var input = box.querySelector('.ms-input'), menu = box.querySelector('.ms-menu'), rows = [], active = 0;
    if (location.pathname.split('/').pop() === 'search.html') input.value = new URLSearchParams(location.search).get('q') || '';

    function options(){
      var p = parse(input.value);
      if (!p.q) return [];
      if (p.in) return [{ q: p.q, key: p.in, label: scope(p.in).label }];
      var out = cur ? [{ q: p.q, key: cur.key, label: cur.label }] : [];
      out.push({ q: p.q, key: '', label: 'Everywhere' });
      SCOPES.forEach(function(s){ if (!cur || s.key !== cur.key) out.push({ q: p.q, key: s.key, label: s.label }); });
      return out;
    }
    function draw(){
      rows = options();
      if (active >= rows.length) active = 0;
      menu.hidden = !rows.length;
      menu.innerHTML = rows.map(function(r, i){
        return '<li role="option" class="ms-row' + (i === active ? ' is-active' : '') + '" data-i="' + i + '"' + (i === active ? ' aria-selected="true"' : '') + '>' +
          '<span class="ms-q">' + esc(r.q) + '</span><span class="ms-where">' + (r.key ? 'in ' + esc(r.label) : esc(r.label)) + '</span></li>';
      }).join('');
    }
    function go(r){ if (r) location.href = href(r.q, r.key); }
    input.addEventListener('input', function(){ active = 0; draw(); });
    input.addEventListener('focus', draw);
    input.addEventListener('blur', function(){ setTimeout(function(){ menu.hidden = true; }, 150); });
    input.addEventListener('keydown', function(e){
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!rows.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; draw();
      } else if ((e.key === 'Tab' && !e.shiftKey || e.key === 'Enter') && !menu.hidden && rows.length) {
        // Tab, like Enter, opens the highlighted place.
        e.preventDefault(); go(rows[active]);
      } else if (e.key === 'Escape') { menu.hidden = true; input.blur(); }
    });
    box.querySelector('form').addEventListener('submit', function(e){ e.preventDefault(); go(rows[active] || options()[0]); });
    // The row under the pointer is the highlighted one, for Enter and Tab too.
    menu.addEventListener('mousemove', function(e){
      var li = e.target.closest('.ms-row'), i = li ? +li.getAttribute('data-i') : active;
      if (i !== active) { active = i; draw(); }
    });
    menu.addEventListener('mousedown', function(e){
      var li = e.target.closest('.ms-row');
      if (li) { e.preventDefault(); go(rows[+li.getAttribute('data-i')]); }
    });
    // "/" anywhere but in a text box focuses it.
    document.addEventListener('keydown', function(e){
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      e.preventDefault(); input.focus();
    });
  }

  return { SCOPES: SCOPES, scope: scope, parse: parse, href: href, mount: mount };
})();
BoldSearch.mount();
