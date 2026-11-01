/* The theme tool (index.html). Reads bold.css's two colour blocks (:root and
   :root[data-theme="dark"]), shows each colour role as each theme draws it, and lets you change
   it. Changes are CSS written into a <style id="themeEdits"> on this page and in each gallery
   frame, so everything follows; they're kept in localStorage (boldThemeEdits) until reset, and
   Export writes the two blocks back out with them. */
(function(){
  var KEY = 'boldThemeEdits';
  var THEMES = ['light', 'dark'];
  var GROUPS = [
    ['Text and surfaces', /^--(ink|ink-soft|muted|paper|surface|wash|line|rule|underline)$/],
    ['Accent and links', /^--(accent|accent-hover|accent-dim|link|on-fill)$/],
    ['Shadows and mixing', /^--(hover-mix|shade|shadow)$/],
    ['Status', /^--(success|warn|danger|neutral)-/],
    ['Highlight', /^--highlight/],
    ['Hues and other colours', /./],
  ];
  // Text that sits on a background, and text that sits on its own fill, for the contrast tables.
  var TEXTS = ['--ink', '--ink-soft', '--muted', '--link', '--accent', '--green', '--brown', '--amber', '--plum', '--teal', '--danger-text', '--neutral-text'];
  var GROUNDS = ['--paper', '--surface', '--wash'];
  var PAIRS = [['--on-fill', '--accent'], ['--on-fill', '--accent-hover'], ['--paper', '--ink'], ['--success-text', '--success-bg'], ['--warn-text', '--warn-bg'], ['--danger-text', '--danger-bg'], ['--neutral-text', '--neutral-bg'], ['--accent', '--accent-dim']];

  var $ = function(id){ return document.getElementById(id); };
  var esc = function(s){ return String(s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); };

  var source = '', blocks = {}, base = {}, notes = {}, uses = {}, tokens = [], rows = [];
  var edits = { light: {}, dark: {} };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved && saved.light && saved.dark) edits = saved; } catch (e){}
  var frames = { light: $('frameLight'), dark: $('frameDark') };
  var gallery = 'site';

  /* ---------- reading bold.css ---------- */

  // A block from its opening line ("\n:root{") to the "}" that starts a line.
  function block(text, open){
    var at = text.indexOf('\n' + open);
    if (at < 0) return null;
    var end = text.indexOf('\n}', at + 1);
    return text.slice(at + 1, end + 2);
  }

  // { name: value } in order, and each one's comment: the one after it on its line, or a
  // comment on the lines just above it.
  function declarations(text, into, notesInto){
    var lines = text.split('\n'), pending = '', inComment = false, buf = '';
    lines.forEach(function(line){
      var t = line.trim();
      if (inComment) { buf += ' ' + t; if (t.indexOf('*/') >= 0) { inComment = false; pending = buf; } return; }
      if (/^\/\*/.test(t)) { buf = t; if (t.indexOf('*/') < 0) inComment = true; else pending = buf; return; }
      if (!t) { pending = ''; return; }
      var re = /(--[\w-]+)\s*:\s*([^;]+);\s*(?:\/\*\s*([\s\S]*?)\s*\*\/)?/g, m, first = true;
      while ((m = re.exec(line))) {
        into[m[1]] = m[2].trim();
        if (notesInto) {
          var note = m[3] || (first ? clean(pending) : '');
          if (note && !notesInto[m[1]]) notesInto[m[1]] = note;
        }
        first = false;
      }
      pending = '';
    });
  }
  function clean(c){ return c.replace(/^\/\*\s*/, '').replace(/\s*\*\/$/, '').replace(/\s+/g, ' '); }

  /* ---------- reading the frames ---------- */

  function frameDoc(theme){ return frames[theme].contentDocument; }
  // The role as that theme computes it (other roles substituted in), and as a colour.
  function computed(theme, name){ return getComputedStyle(frameDoc(theme).documentElement).getPropertyValue(name).trim(); }
  function rgba(theme, name){
    var doc = frameDoc(theme), probe = doc.getElementById('teProbe');
    if (!probe) { probe = doc.createElement('i'); probe.id = 'teProbe'; probe.style.display = 'none'; doc.body.appendChild(probe); }
    probe.style.color = ''; probe.style.color = 'var(' + name + ')';
    return parseColour(getComputedStyle(probe).color);
  }
  function parseColour(s){
    var m = s.match(/^rgba?\(([^)]+)\)/);
    if (m) { var p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
    m = s.match(/^color\(srgb\s+([^)]+)\)/);
    if (m) { var q = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [q[0] * 255, q[1] * 255, q[2] * 255, q[3] == null ? 1 : q[3]]; }
    return null;
  }
  var css = function(c){ return c ? 'rgba(' + c.map(function(v, i){ return i < 3 ? Math.round(v) : +v.toFixed(3); }).join(',') + ')' : 'transparent'; };
  var hex = function(c){ return '#' + c.slice(0, 3).map(function(v){ return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); };
  function over(fg, bg){ var a = fg[3]; return [0, 1, 2].map(function(i){ return fg[i] * a + bg[i] * (1 - a); }).concat(1); }
  function luminance(c){ return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function lin(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function ratio(fg, bg){ var a = luminance(over(fg, bg)), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }

  /* ---------- edits ---------- */

  // What a role is set to in a theme: your change, else bold.css's; in dark, the light value
  // when the dark block doesn't set it (it inherits, as on the site).
  function setTo(theme, name){
    if (edits[theme][name] != null) return edits[theme][name];
    if (theme === 'dark' && base.dark[name] != null) return base.dark[name];
    return base.light[name];
  }
  function inherits(name){ return base.dark[name] == null && edits.dark[name] == null; }
  function editCount(){ return Object.keys(edits.light).length + Object.keys(edits.dark).length; }

  function setEdit(theme, name, value){
    var original = theme === 'dark' ? base.dark[name] : base.light[name];
    if (value == null || value.trim() === '' || value.trim() === original) delete edits[theme][name];
    else edits[theme][name] = value.trim();
    try { localStorage.setItem(KEY, JSON.stringify(edits)); } catch (e){}
    apply();
  }

  function editsCss(){
    var part = function(theme){ return Object.keys(edits[theme]).map(function(n){ return n + ':' + edits[theme][n] + ';'; }).join(' '); };
    return ':root{' + part('light') + '}\n:root[data-theme="dark"]{' + part('dark') + '}';
  }

  var pending = false;
  function apply(){
    var text = editsCss();
    $('themeEdits').textContent = text;
    THEMES.forEach(function(t){ var s = frameDoc(t) && frameDoc(t).getElementById('themeEdits'); if (s) s.textContent = text; });
    if (pending) return;
    pending = true;
    requestAnimationFrame(function(){ pending = false; refresh(); });
  }

  /* ---------- the table ---------- */

  function valid(token, value){
    if (!value.trim()) return true;
    return token.kind === 'shadow' ? CSS.supports('box-shadow', value) : CSS.supports('color', value);
  }

  function render(){
    var html = '', group = '';
    tokens.forEach(function(t, i){
      if (t.group !== group) { group = t.group; html += '<h2 class="te-group">' + esc(group) + '</h2>'; }
      var used = uses[t.name] || [];
      html += '<div class="te-row" data-i="' + i + '"><div class="te-role"><h3>' + esc(t.name) + '</h3>' +
        (notes[t.name] ? '<p>' + esc(notes[t.name]) + '</p>' : '') +
        '<details><summary>' + (used.length ? 'Used ' + used.reduce(function(s, u){ return s + u[1]; }, 0) + ' times in ' + used.length + ' files' : 'Not used directly') + '</summary>' +
        (used.length ? '<ul>' + used.map(function(u){ return '<li>' + esc(u[0]) + ' · ' + u[1] + '</li>'; }).join('') + '</ul>' : '') + '</details></div>' +
        THEMES.map(function(theme){
          return '<div class="te-cell" data-theme-cell="' + theme + '">' +
            (t.kind === 'shadow'
              ? '<div class="te-shadow"><span></span></div>'
              : '<label class="te-swatch" title="Pick a colour"><span></span><input type="color" aria-label="' + esc(t.name) + ' in ' + theme + '"></label>') +
            '<div class="te-value"><input type="text" spellcheck="false" aria-label="' + esc(t.name) + ' value in ' + theme + '"><button class="te-reset" type="button" title="Back to bold.css" hidden>&#8634;</button></div>' +
            '<div class="te-meta"></div></div>';
        }).join('') + '</div>';
    });
    $('tokens').innerHTML = html;
    rows = Array.prototype.map.call(document.querySelectorAll('.te-row'), function(row){
      var t = tokens[+row.dataset.i], cells = {};
      THEMES.forEach(function(theme){
        var cell = row.querySelector('[data-theme-cell="' + theme + '"]');
        var c = cells[theme] = { el: cell, swatch: cell.querySelector('.te-swatch > span, .te-shadow > span'), picker: cell.querySelector('input[type="color"]'),
          field: cell.querySelector('input[type="text"]'), reset: cell.querySelector('.te-reset'), meta: cell.querySelector('.te-meta') };
        if (c.picker) {
          // Opens on the colour shown; picking sets an opaque hex.
          c.picker.addEventListener('pointerdown', function(){ var v = rgba(theme, t.name); if (v) c.picker.value = hex(v); });
          c.picker.addEventListener('input', function(){ setEdit(theme, t.name, c.picker.value); });
        }
        c.field.addEventListener('input', function(){
          var ok = valid(t, c.field.value);
          c.field.classList.toggle('is-bad', !ok);
          if (ok) setEdit(theme, t.name, c.field.value);
        });
        c.field.addEventListener('blur', function(){ c.field.classList.remove('is-bad'); c.field.value = setTo(theme, t.name); });
        c.reset.addEventListener('click', function(){ setEdit(theme, t.name, null); });
      });
      return { token: t, el: row, cells: cells };
    });
    filter();
  }

  function refresh(){
    var paper = {}, ink = {};
    THEMES.forEach(function(theme){ paper[theme] = css(rgba(theme, '--paper')); ink[theme] = css(rgba(theme, '--ink')); });
    rows.forEach(function(r){
      var t = r.token;
      THEMES.forEach(function(theme){
        var c = r.cells[theme], edited = edits[theme][t.name] != null;
        c.el.style.background = paper[theme];
        c.el.style.color = ink[theme];
        if (t.kind === 'shadow') { c.swatch.style.boxShadow = computed(theme, t.name); c.swatch.style.background = css(rgba(theme, '--surface')); }
        else c.swatch.style.background = css(rgba(theme, t.name));
        if (document.activeElement !== c.field) c.field.value = setTo(theme, t.name);
        c.el.classList.toggle('is-edited', edited);
        c.reset.hidden = !edited;
        var original = theme === 'dark' ? base.dark[t.name] : base.light[t.name];
        c.meta.textContent = edited ? (original != null ? 'Changed from ' + original : 'Added to the dark block')
          : theme === 'dark' && inherits(t.name) ? 'Not in the dark block: as light' : '';
      });
      r.el.dataset.edited = String(edits.light[t.name] != null || edits.dark[t.name] != null);
    });
    var n = editCount();
    $('editCount').textContent = n ? n + (n === 1 ? ' change' : ' changes') : '';
    contrast();
    if ($('editedOnly').checked) filter();
  }

  function filter(){
    var q = $('search').value.trim().toLowerCase(), only = $('editedOnly').checked;
    rows.forEach(function(r){
      var t = r.token, hay = [t.name, notes[t.name] || '', setTo('light', t.name), setTo('dark', t.name), (uses[t.name] || []).map(function(u){ return u[0]; }).join(' ')].join(' ').toLowerCase();
      r.el.hidden = (q && hay.indexOf(q) < 0) || (only && r.el.dataset.edited !== 'true');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.te-group'), function(h){
      var next = h.nextElementSibling, any = false;
      while (next && !next.classList.contains('te-group')) { if (!next.hidden) any = true; next = next.nextElementSibling; }
      h.hidden = !any;
    });
  }

  /* ---------- contrast ---------- */

  function crCell(theme, fg, bg){
    var f = rgba(theme, fg), b = rgba(theme, bg);
    if (!f || !b) return '<td></td>';
    var ground = over(b, rgba(theme, '--paper') || [255, 255, 255, 1]), r = ratio(f, ground);
    return '<td><div class="te-cr' + (r < 3 ? ' is-low is-fail' : r < 4.5 ? ' is-low' : '') + '" style="background:' + css(ground) + ';color:' + css(f) + '"><b>Aa</b><span>' + r.toFixed(2) + '</span></div></td>';
  }
  function contrast(){
    var have = function(n){ return base.light[n] != null; };
    var texts = TEXTS.filter(have), grounds = GROUNDS.filter(have);
    var head = '<tr><th></th>' + THEMES.map(function(t){ return '<th class="te-th-theme" colspan="' + grounds.length + '">' + (t === 'light' ? 'Light' : 'Dark') + '</th>'; }).join('') + '</tr>' +
      '<tr><th>Text</th>' + THEMES.map(function(){ return grounds.map(function(g){ return '<th>on ' + esc(g) + '</th>'; }).join(''); }).join('') + '</tr>';
    var body = texts.map(function(fg){
      return '<tr><td>' + esc(fg) + '</td>' + THEMES.map(function(t){ return grounds.map(function(g){ return crCell(t, fg, g); }).join(''); }).join('') + '</tr>';
    }).join('');
    var pairs = PAIRS.filter(function(p){ return have(p[0]) && have(p[1]); }).map(function(p){
      return '<tr><td>' + esc(p[0]) + ' on ' + esc(p[1]) + '</td>' + THEMES.map(function(t){ return crCell(t, p[0], p[1]); }).join('') + '</tr>';
    }).join('');
    $('contrast').innerHTML = '<table class="te-contrast">' + head + body + '</table>' +
      '<table class="te-contrast"><tr><th>Text on its fill</th><th>Light</th><th>Dark</th></tr>' + pairs + '</table>';
  }

  /* ---------- export ---------- */

  function rewrite(text, changes){
    Object.keys(changes).forEach(function(name){
      var re = new RegExp('(^|[\\s;{])(' + name.replace(/[-]/g, '\\-') + '\\s*:\\s*)([^;]*)(;)', 'm');
      if (re.test(text)) text = text.replace(re, function(m, a, b, c, d){ return a + b + changes[name] + d; });
      else text = text.replace(/\n\}\s*$/, '\n  ' + name + ':' + changes[name] + ';\n}');
    });
    return text;
  }
  // From the light block's first line to the dark block's last, with what lies between them.
  function exportText(){
    var from = source.indexOf(blocks.light), to = source.indexOf(blocks.dark);
    return rewrite(blocks.light, edits.light) + source.slice(from + blocks.light.length, to) + rewrite(blocks.dark, edits.dark) + '\n';
  }

  $('exportBtn').addEventListener('click', function(){
    var n = editCount();
    $('exportNote').textContent = (n ? n + (n === 1 ? ' change. ' : ' changes. ') : 'No changes yet: this is bold.css as it is. ') +
      'Paste these over the two blocks at the top of src/assets/css/bold.css (from :root{ to the end of :root[data-theme="dark"]{…}).';
    $('exportText').value = exportText();
    $('exportDialog').showModal();
  });
  $('exportClose').addEventListener('click', function(){ $('exportDialog').close(); });
  $('exportCopy').addEventListener('click', function(){
    var btn = this;
    navigator.clipboard.writeText($('exportText').value).then(function(){ btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = 'Copy'; }, 1500); });
  });
  $('exportDownload').addEventListener('click', function(){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([$('exportText').value], { type: 'text/css' }));
    a.download = 'bold-theme.css';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('resetAll').addEventListener('click', function(){
    if (!editCount() || !confirm('Undo all ' + editCount() + ' changes?')) return;
    edits = { light: {}, dark: {} };
    try { localStorage.removeItem(KEY); } catch (e){}
    apply();
  });
  $('search').addEventListener('input', filter);
  $('editedOnly').addEventListener('change', filter);

  /* ---------- this page's theme, the galleries ---------- */

  (function(){
    var btn = $('themeToggle'), root = document.documentElement;
    var show = function(){ btn.setAttribute('aria-pressed', String(root.getAttribute('data-theme') === 'dark')); };
    show();
    btn.addEventListener('click', function(){
      var dark = root.getAttribute('data-theme') !== 'dark';
      if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
      try { localStorage.setItem('boldTheme', dark ? 'dark' : 'light'); } catch (e){}
      show();
    });
  })();

  function fit(frame){
    var doc = frame.contentDocument;
    if (doc && doc.body) frame.style.height = Math.ceil(doc.body.getBoundingClientRect().height) + 'px';
  }
  function loadFrames(){
    return Promise.all(THEMES.map(function(theme){
      return new Promise(function(done){
        var frame = frames[theme];
        frame.onload = function(){
          var s = frame.contentDocument.getElementById('themeEdits');
          if (s) s.textContent = editsCss();
          fit(frame);
          new ResizeObserver(function(){ fit(frame); }).observe(frame.contentDocument.body);
          done();
        };
        frame.src = 'gallery-' + gallery + '.html?theme=' + theme;
      });
    }));
  }
  $('frameLayout').addEventListener('click', function(e){
    var btn = e.target.closest('[data-layout]');
    if (!btn) return;
    Array.prototype.forEach.call(this.querySelectorAll('[data-layout]'), function(b){ b.setAttribute('aria-pressed', String(b === btn)); });
    $('frames').classList.toggle('is-stacked', btn.dataset.layout === 'stack');
  });
  $('galleryTabs').addEventListener('click', function(e){
    var tab = e.target.closest('[data-gallery]');
    if (!tab) return;
    e.preventDefault();
    if (tab.dataset.gallery === gallery) return;
    gallery = tab.dataset.gallery;
    Array.prototype.forEach.call(this.querySelectorAll('.guide-tab'), function(a){ a.classList.toggle('is-current', a === tab); });
    loadFrames().then(refresh);
  });

  /* ---------- start ---------- */

  function countUses(){
    return fetch('files.json').then(function(r){ return r.ok ? r.json() : []; }).then(function(files){
      return Promise.all(files.map(function(f){
        return fetch('../' + f).then(function(r){ return r.ok ? r.text() : ''; }).then(function(text){ return [f, text]; });
      }));
    }).then(function(texts){
      tokens.forEach(function(t){
        var re = new RegExp('var\\(\\s*' + t.name.replace(/[-]/g, '\\-') + '\\s*[,)]', 'g');
        uses[t.name] = texts.map(function(ft){ return [ft[0].replace(/^assets\//, ''), (ft[1].match(re) || []).length]; })
          .filter(function(u){ return u[1]; }).sort(function(a, b){ return b[1] - a[1]; });
      });
    }).catch(function(){});
  }

  Promise.all([
    fetch('../assets/css/bold.css').then(function(r){ return r.text(); }),
    loadFrames(),
  ]).then(function(res){
    source = res[0];
    blocks.light = block(source, ':root{');
    blocks.dark = block(source, ':root[data-theme="dark"]{');
    if (!blocks.light || !blocks.dark) { $('tokens').innerHTML = '<p class="te-loading">Couldn’t find the :root and :root[data-theme="dark"] blocks in bold.css.</p>'; return; }
    base.light = {}; base.dark = {};
    declarations(blocks.light, base.light, notes);
    declarations(blocks.dark, base.dark, null);
    // The colour roles: whatever computes to a colour in light, and the shadows.
    tokens = Object.keys(base.light).map(function(name){
      var value = computed('light', name);
      var kind = /shadow/.test(name) ? 'shadow' : CSS.supports('color', value) ? 'colour' : null;
      if (!kind) return null;
      var group = GROUPS.filter(function(g){ return g[1].test(name); })[0][0];
      return { name: name, kind: kind, group: group };
    }).filter(Boolean);
    tokens.sort(function(a, b){
      var ga = GROUPS.findIndex(function(g){ return g[0] === a.group; }), gb = GROUPS.findIndex(function(g){ return g[0] === b.group; });
      return ga - gb;
    });
    return countUses().then(function(){ render(); apply(); });
  });
})();
