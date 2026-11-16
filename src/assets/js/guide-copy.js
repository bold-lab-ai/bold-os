// Primer Octicons (MIT, GitHub Inc.): assets/licenses/octicons-LICENSE.txt.
// Copy pattern: primer.style/product/scenario-patterns/copy/
window.BoldGuideCopy = (function(){
  var icons = {"copy":"<svg aria-hidden=\"true\" focusable=\"false\" fill=\"currentColor\" width=\"16\" height=\"16\" viewBox=\"0 0 16 16\"><path d=\"M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z\"/><path d=\"M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z\"/></svg>","check":"<svg aria-hidden=\"true\" focusable=\"false\" fill=\"currentColor\" width=\"16\" height=\"16\" viewBox=\"0 0 16 16\"><path d=\"M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z\"/></svg>","alert":"<svg aria-hidden=\"true\" focusable=\"false\" fill=\"currentColor\" width=\"16\" height=\"16\" viewBox=\"0 0 16 16\"><path d=\"M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z\"/></svg>"};
  var esc = BOLD.escapeHtml;
  function html(hash, title, section){
    var label = 'Copy link to “' + title + '”';
    return '<span class="gd-permalink"><button type="button" class="icon-btn gd-copy-button" data-copy-hash="' + esc(hash) + '"' + (section == null ? '' : ' data-copy-section="' + esc(section) + '"') + ' aria-label="' + esc(label) + '">' + icons.copy + '</button>' +
      '<span class="gd-copy-tooltip" role="tooltip" aria-hidden="true" hidden>' + esc(label) + '</span>' +
      '<span class="gd-copy-announcement" role="status" aria-live="polite" aria-atomic="true"></span>' +
      '<span class="gd-copy-recovery" hidden><span>Couldn’t copy. Select this link and copy it manually.</span><input class="gd-copy-value" readonly aria-label="' + esc('Link to “' + title + '” — copy manually') + '"></span></span>';
  }
  function urlFor(button){
    var url = new URL(location.href), section = button.getAttribute('data-copy-section');
    if (section === null) url.searchParams.delete('section');
    else url.searchParams.set('section', section);
    url.hash = '#' + encodeURIComponent(button.getAttribute('data-copy-hash'));
    return url.href;
  }
  function mount(root){
    var states = new WeakMap(), active = null, recovery = null, keyboard = true, pending = new Set();
    function state(button){
      var s = states.get(button);
      if (s) return s;
      var wrap = button.parentElement;
      s = { button: button, wrap: wrap, tooltip: wrap.querySelector('.gd-copy-tooltip'),
        announcement: wrap.querySelector('.gd-copy-announcement'), recovery: wrap.querySelector('.gd-copy-recovery'),
        value: wrap.querySelector('.gd-copy-value'), label: button.getAttribute('aria-label'),
        hovered: false, focused: false, dismissed: false, kind: '', request: 0, timer: null, announced: false };
      states.set(button, s);
      return s;
    }
    function position(s){
      var box = s.button.getBoundingClientRect(), tip = s.tooltip.getBoundingClientRect();
      var width = document.documentElement.clientWidth || window.innerWidth;
      var height = document.documentElement.clientHeight || window.innerHeight;
      s.tooltip.style.left = Math.max(8, Math.min(box.left + (box.width - tip.width) / 2, width - tip.width - 8)) + 'px';
      var top = box.top - tip.height - 6;
      if (top < 8) top = box.bottom + 6;
      s.tooltip.style.top = Math.max(8, Math.min(top, height - tip.height - 8)) + 'px';
      if (!s.recovery.hidden) {
        var recovery = s.recovery.getBoundingClientRect(), recoveryTop = box.bottom + 6;
        if (!s.tooltip.hidden && top >= box.bottom) recoveryTop = top + tip.height + 6;
        s.recovery.style.left = Math.max(8, Math.min(box.left, width - recovery.width - 8)) + 'px';
        s.recovery.style.top = Math.max(8, Math.min(recoveryTop, height - recovery.height - 8)) + 'px';
      }
    }
    function show(s){
      if (s.dismissed || !s.button.isConnected) return;
      if (active && active !== s) active.tooltip.hidden = true;
      var box = s.button.getBoundingClientRect();
      var width = document.documentElement.clientWidth || window.innerWidth;
      var height = document.documentElement.clientHeight || window.innerHeight;
      if (box.bottom < 0 || box.top > height || box.right < 0 || box.left > width) { hide(s); return; }
      active = s; s.tooltip.hidden = false; position(s);
    }
    function hide(s){ s.tooltip.hidden = true; if (active === s) active = null; }
    function dismiss(s){
      if (!s) return;
      clearTimeout(s.hoverTimer);
      s.dismissed = true; s.hovered = false;
      hide(s); s.recovery.hidden = true;
      if (recovery === s) recovery = null;
    }
    function dismissAll(){ var current = active; dismiss(current); if (recovery !== current) dismiss(recovery); pending.forEach(dismiss); }
    function reset(s){
      s.kind = ''; s.button.removeAttribute('data-copy-state'); s.button.innerHTML = icons.copy;
      s.tooltip.textContent = s.label;
      if ((s.hovered || s.focused) && !s.dismissed) show(s); else hide(s);
    }
    function feedback(s, kind){
      s.kind = kind;
      s.button.setAttribute('data-copy-state', kind);
      s.button.innerHTML = kind === 'success' ? icons.check : icons.alert;
      var message = kind === 'success' ? 'Copied!' : 'Couldn’t copy. Select the link below and copy it manually.';
      s.tooltip.textContent = kind === 'success' ? message : 'Couldn’t copy';
      // Alternating an inaudible space makes repeated results live-region updates.
      s.announced = !s.announced;
      s.announcement.textContent = message + (s.announced ? '' : '\u00a0');
      show(s);
      if (kind === 'success') s.timer = setTimeout(function(){ reset(s); }, 2000);
      else {
        s.value.value = s.url;
        if (!s.dismissed) {
          if (recovery && recovery !== s) recovery.recovery.hidden = true;
          recovery = s; s.recovery.hidden = false; position(s);
        }
      }
    }
    root.addEventListener('click', function(e){
      var button = e.target.closest('.gd-copy-button');
      if (!button) return;
      var s = state(button), request = ++s.request;
      pending.add(s);
      clearTimeout(s.timer); s.recovery.hidden = true; s.dismissed = false;
      if (recovery === s) recovery = null;
      reset(s);
      var url = s.url = urlFor(button);
      function done(kind){
        if (request !== s.request) return;
        pending.delete(s);
        if (button.isConnected) feedback(s, kind);
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) { done('error'); return; }
      try { navigator.clipboard.writeText(url).then(function(){ done('success'); }, function(){ done('error'); }); }
      catch (err) { done('error'); }
    });
    root.addEventListener('pointerover', function(e){
      var wrap = e.target.closest('.gd-permalink');
      if (!wrap || (e.relatedTarget && wrap.contains(e.relatedTarget))) return;
      var s = state(wrap.querySelector('.gd-copy-button'));
      clearTimeout(s.hoverTimer); s.hovered = true; s.dismissed = false; show(s);
    });
    root.addEventListener('pointerout', function(e){
      var wrap = e.target.closest('.gd-permalink');
      if (!wrap || (e.relatedTarget && wrap.contains(e.relatedTarget))) return;
      var s = state(wrap.querySelector('.gd-copy-button'));
      s.hovered = false;
      if (!s.focused) s.hoverTimer = setTimeout(function(){ if (!s.hovered && !s.focused) hide(s); }, 150);
    });
    root.addEventListener('focusin', function(e){
      if (e.target.matches('.gd-copy-value')) { e.target.select(); return; }
      if (!e.target.matches('.gd-copy-button')) return;
      var s = state(e.target); s.focused = keyboard;
      if (keyboard) { s.dismissed = false; show(s); }
    });
    root.addEventListener('focusout', function(e){
      if (!e.target.matches('.gd-copy-button')) return;
      var s = state(e.target); s.focused = false;
      if (!s.hovered) hide(s);
    });
    // A click leaves DOM focus on the button. Only keyboard focus should keep
    // its label open after the pointer leaves; never blur the control to hide it.
    document.addEventListener('pointerdown', function(e){
      keyboard = false;
      if (active) active.focused = false;
      if (active && !active.wrap.contains(e.target)) dismiss(active);
      if (recovery && !recovery.wrap.contains(e.target)) dismiss(recovery);
    }, true);
    document.addEventListener('keydown', function(e){
      keyboard = true;
      if (e.key === 'Escape') { dismissAll(); return; }
      // Tabbing back to the control will open its label on focusin.
    }, true);
    // Scroll invalidates pointer hover and fixed overlay positions. Suppression
    // also stops an in-flight clipboard result or reset timer from reopening it.
    window.addEventListener('scroll', dismissAll, true);
    window.addEventListener('resize', dismissAll);
    window.addEventListener('blur', dismissAll);
    document.addEventListener('visibilitychange', function(){ if (document.hidden) dismissAll(); });
  }
  return { html: html, mount: mount };
})();
