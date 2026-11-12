// The Markdown field: one box, the same everywhere. A page writes its <textarea> with
// class md-field and this makes it the field, as boxes appear (pages draw them as they
// go): Write | Preview tabs above it (as GitHub's: the preview in the box's place, as tall
// as it), and a line under it saying what it takes, where images are added. Loaded on
// every signed-in page (base.njk), after markdown.js.
//
// On the textarea:
// - data-md="abstract": an abstract (plain text, $LaTeX$, images: card-model.js
//   renderAbstractHtml) rather than Markdown (markdown.js).
// - data-preview-class: the preview's classes, so it looks as the text will where it's
//   shown (default md-desc; guide-text on a guide).
// - data-md-breaks="true": a single line break kept as one, as where it's shown (Conversations,
//   markdown.js render(text, { breaks: true })), so the preview matches.
// A disabled or read-only box greys out its image button, with the reason.
//
// Images (#193): pasting or dropping an image or an SVG (a file, or an SVG's own text),
// or choosing one, uploads it to the lab's Google Drive (functions/index.js markdownImage)
// and writes ![name](its Drive link) at the caret; BOLD.imageHtml shows it. Anyone with
// the link can see it, so it asks every time (the ground rule). An image the lab already
// has (the same file, by its SHA-256) isn't uploaded again: its link is used, unasked.
window.BoldMdField = (function(){
  var esc = BOLD.escapeHtml;
  var TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
  var MAX_MB = 10;
  var HINT = {
    markdown: 'Markdown: **bold**, *italic*, [links](https://…), - lists, $x^2$ for maths, @ to tag someone, :name for emoji.',
    abstract: 'Plain text, with $inline$ or $$block$$ LaTeX.'
  };
  var RENDER = {
    markdown: function(t, ta){ return window.BoldMarkdown ? BoldMarkdown.render(t, { breaks: !!(ta && ta.getAttribute('data-md-breaks') === 'true') }) : '<p>' + esc(t) + '</p>'; },
    abstract: function(t){ return typeof renderAbstractHtml === 'function' ? renderAbstractHtml(t) : esc(t); }
  };
  function kind(ta){ return RENDER[ta.getAttribute('data-md')] ? ta.getAttribute('data-md') : 'markdown'; }

  // --- The field around each box ---
  function enhance(ta){
    if (ta.getAttribute('data-mdf')) return;
    ta.setAttribute('data-mdf', '1');
    var k = kind(ta);
    var tabs = document.createElement('span');
    tabs.className = 'mdf-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.innerHTML = '<button type="button" class="mdf-tab is-current" data-mdf-mode="write" role="tab" aria-selected="true">Write</button>' +
      '<button type="button" class="mdf-tab" data-mdf-mode="preview" role="tab" aria-selected="false">Preview</button>';
    var preview = document.createElement('div');
    preview.className = 'mdf-preview ' + (ta.getAttribute('data-preview-class') || 'md-desc');
    preview.hidden = true;
    var line = document.createElement('span');
    line.className = 'mdf-line';
    line.innerHTML = esc(HINT[k]) + ' Paste or drop an image or SVG, or <button type="button" class="btn-text mdf-pick">choose one</button>.' +
      '<input type="file" class="mdf-file" hidden multiple accept="' + TYPES.join(',') + '"><span class="mdf-msg" aria-live="polite"></span>';
    ta.insertAdjacentElement('beforebegin', tabs);
    ta.insertAdjacentElement('afterend', line);
    ta.insertAdjacentElement('afterend', preview);
    ta.addEventListener('input', function(){ if (!preview.hidden) draw(ta); });
    sync(ta);
  }
  function partsOf(ta){
    var tabs = ta.previousElementSibling, preview = ta.nextElementSibling, line = preview && preview.nextElementSibling;
    return tabs && tabs.classList.contains('mdf-tabs') && line && line.classList.contains('mdf-line') ? { tabs: tabs, preview: preview, line: line } : null;
  }
  function draw(ta){
    var p = partsOf(ta);
    if (p) p.preview.innerHTML = ta.value.trim() ? RENDER[kind(ta)](ta.value, ta) : '<p class="mdf-empty">Nothing to preview.</p>';
  }
  function mode(ta, previewing){
    var p = partsOf(ta);
    if (!p) return;
    Array.prototype.forEach.call(p.tabs.children, function(b){
      var on = (b.getAttribute('data-mdf-mode') === 'preview') === previewing;
      b.classList.toggle('is-current', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (previewing) { p.preview.style.minHeight = ta.offsetHeight + 'px'; draw(ta); }
    ta.hidden = previewing; p.preview.hidden = !previewing;
    if (!previewing) ta.focus();
  }
  // The image button is greyed out with the box.
  function sync(ta){
    var p = partsOf(ta), b = p && p.line.querySelector('.mdf-pick');
    if (!b) return;
    var off = ta.disabled || ta.readOnly;
    b.disabled = off || busy(ta);
    b.title = off ? 'This box can’t be changed' : busy(ta) ? 'Uploading…' : '';
  }
  function busy(ta){ return ta.getAttribute('data-mdf-busy') === '1'; }
  function say(ta, t){ var p = partsOf(ta), m = p && p.line.querySelector('.mdf-msg'); if (m) m.textContent = t ? ' ' + t : ''; }
  function fieldOf(el){
    var w = el.closest && el.closest('.mdf-tabs, .mdf-line');
    if (!w) return null;
    var ta = w.classList.contains('mdf-tabs') ? w.nextElementSibling : w.previousElementSibling.previousElementSibling;
    return ta && ta.tagName === 'TEXTAREA' ? ta : null;
  }

  // --- Images ---
  // Pasted text that is a whole SVG → a file.
  function svgFile(text){
    var t = String(text || '').trim();
    if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t) || !/<\/svg>$/i.test(t)) return null;
    try { return new File([t], 'diagram.svg', { type: 'image/svg+xml' }); } catch (e){ return null; }
  }
  // Writes `text` in place of the selection, as typing would (drafts and counters hear it).
  function insert(ta, text){
    var a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    var pre = a > 0 && !/\s$/.test(v.slice(0, a)) ? ' ' : '';
    ta.value = v.slice(0, a) + pre + text + v.slice(b);
    var at = a + pre.length + text.length;
    ta.setSelectionRange(at, at);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function swap(ta, from, to){
    var i = ta.value.indexOf(from);
    if (i < 0) { if (to) insert(ta, to); return; }
    ta.value = ta.value.slice(0, i) + to + ta.value.slice(i + from.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function altOf(name){ return String(name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[\[\]\n]/g, ' ').slice(0, 80) || 'image'; }

  // The file's SHA-256 (hex), to find the copy the lab already has; '' if the browser can't.
  function hashOf(f){
    if (!(window.crypto && crypto.subtle && f.arrayBuffer)) return Promise.resolve('');
    return f.arrayBuffer().then(function(b){ return crypto.subtle.digest('SHA-256', b); }).then(function(d){
      return Array.prototype.map.call(new Uint8Array(d), function(x){ return ('0' + x.toString(16)).slice(-2); }).join('');
    }).catch(function(){ return ''; });
  }
  // Each image is kept once on the lab's Drive (functions/index.js imageHashes): one it
  // already has is written at once, its link from there; only new ones are asked about
  // and uploaded. All in the order given.
  function upload(ta, files){
    files = Array.prototype.filter.call(files || [], function(f){ return f; });
    if (!files.length || busy(ta) || ta.disabled || ta.readOnly) return;
    if (files.some(function(f){ return TYPES.indexOf(f.type) < 0 || f.size > MAX_MB * 1024 * 1024; })) { say(ta, 'Only PNG, JPEG, GIF, WebP or SVG images, up to ' + MAX_MB + ' MB.'); return; }
    var caret = [ta.selectionStart, ta.selectionEnd];
    var done = function(){ ta.removeAttribute('data-mdf-busy'); sync(ta); };
    ta.setAttribute('data-mdf-busy', '1'); sync(ta); say(ta, 'Checking…');
    var find = firebase.app().functions('europe-west2').httpsCallable('markdownImage');
    Promise.all(files.map(function(f){
      return hashOf(f).then(function(h){ return h ? find({ find: h }) : { data: {} }; })
        .then(function(r){ return { f: f, url: r.data && r.data.url || '' }; }, function(){ return { f: f, url: '' }; });
    })).then(function(items){
      var fresh = items.filter(function(x){ return !x.url; }), one = fresh.length === 1;
      var ask = !fresh.length ? Promise.resolve(true) : BOLD.confirmAlways({ title: one ? 'Upload ' + fresh[0].f.name + '?' : 'Upload ' + fresh.length + ' images?', go: 'Upload',
        effects: ['Put ' + (one ? 'it' : 'them') + ' on the lab’s Google Drive, where anyone with the link can see ' + (one ? 'it' : 'them')] });
      return ask.then(function(ok){
        // Where the caret was before the question took the focus.
        if (caret[1] <= ta.value.length) { ta.focus(); ta.setSelectionRange(caret[0], caret[1]); }
        var n = 0, sent = 0;
        return items.reduce(function(chain, x){
          return chain.then(function(){
            var alt = altOf(x.f.name);
            if (x.url) { insert(ta, '![' + alt + '](' + x.url + ')'); return; }
            if (!ok) return;
            var mark = '![Uploading ' + alt + '…]()';
            insert(ta, mark);
            say(ta, 'Uploading ' + (one ? x.f.name : (++n) + ' of ' + fresh.length) + '…');
            return BOLD.driveUpload('markdownImage', {}, x.f)
              .then(function(d){ sent++; swap(ta, mark, '![' + alt + '](' + d.url + ')'); },
                function(err){ swap(ta, mark, ''); throw err; });
          });
        }, Promise.resolve()).then(function(){
          var reused = items.length - fresh.length;
          var m = (sent ? 'Uploaded' : '') + (sent && reused ? '; ' : '') + (reused ? (reused === 1 ? 'one image was' : reused + ' images were') + ' already on the lab’s Drive' : '') +
            (sent || reused ? ': save to keep ' + (sent + reused === 1 ? 'it' : 'them') + '.' : '');
          say(ta, m.charAt(0).toUpperCase() + m.slice(1));
        });
      });
    }).catch(function(err){
      console.error('[BOLD] uploading an image failed', err);
      say(ta, err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t upload it — try again.');
    }).then(done);
  }
  function imagesIn(dt){ return Array.prototype.filter.call((dt && dt.files) || [], function(f){ return /^image\//.test(f.type); }); }
  function box(t){ return t && t.tagName === 'TEXTAREA' && t.classList.contains('md-field') ? t : null; }

  document.addEventListener('paste', function(e){
    var ta = box(e.target);
    if (!ta) return;
    var files = imagesIn(e.clipboardData);
    if (!files.length) { var svg = svgFile(e.clipboardData && e.clipboardData.getData('text/plain')); if (svg) files = [svg]; }
    if (!files.length) return;
    e.preventDefault();
    upload(ta, files);
  });
  document.addEventListener('dragover', function(e){
    if (box(e.target) && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault();
  });
  document.addEventListener('drop', function(e){
    var ta = box(e.target), files = ta && imagesIn(e.dataTransfer);
    if (!files || !files.length) return;
    e.preventDefault();
    ta.focus();
    upload(ta, files);
  });
  document.addEventListener('click', function(e){
    var t = e.target.closest && e.target.closest('[data-mdf-mode], .mdf-pick');
    var ta = t && fieldOf(t);
    if (!ta) return;
    e.preventDefault();
    if (t.classList.contains('mdf-pick')) partsOf(ta).line.querySelector('.mdf-file').click();
    else mode(ta, t.getAttribute('data-mdf-mode') === 'preview');
  });
  document.addEventListener('change', function(e){
    if (!e.target.classList || !e.target.classList.contains('mdf-file')) return;
    var ta = fieldOf(e.target), files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (ta) { mode(ta, false); upload(ta, files); }
  });

  function scan(root){
    var boxes = root.matches && root.matches('textarea.md-field') ? [root] : root.querySelectorAll('textarea.md-field');
    Array.prototype.forEach.call(boxes, enhance);
  }
  scan(document);
  new MutationObserver(function(list){
    list.forEach(function(m){ Array.prototype.forEach.call(m.addedNodes, function(n){ if (n.nodeType === 1) scan(n); }); });
  }).observe(document.body, { childList: true, subtree: true });

  // render(kind, text): the HTML a field of that kind shows; sync(textarea): after a page
  // disables or enables a box.
  return { render: function(k, t){ return (RENDER[k] || RENDER.markdown)(t); }, sync: sync };
})();
