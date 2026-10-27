// A board: columns side by side, each a head and a list of cards, scrolling sideways
// when they don't fit (styles: assets/css/board.css). Shared by the Internal Review
// Board (audit-board/board.js) and a project's Work tab (pages/project-work.js), so
// the two look and behave the same. A page loads it with `scripts: ["board.js"]` and
// `styles: ["board"]` in its front matter.
//
//   BoldBoard.columnsHtml(columns) → the columns' HTML. columns: [{ id, label, count,
//     hint (HTML under the label, optional), body (the cards' HTML), empty (shown
//     when there are none), headExtra (HTML after the hint, optional) }].
//   BoldBoard.equalizeHeads(root): every column head on the boards inside `root` as
//     tall as the tallest, so the cards start on one line across the board; kept so
//     when the window is resized. Call it after each redraw.
//   BoldBoard.drag(root, { item, canDrag(el), drop(el, columnId) }): cards matching
//     the selector `item` inside `root` can be dragged to another column, with a
//     mouse, or on a touch screen by holding a card for a moment first. Links,
//     buttons and fields in a card still work as usual; a button marked
//     .board-drag-through (a card's title that opens it) also starts a drag. Call it again after each
//     redraw (it listens on `root`, once).
var BoldBoard = (function(){
  var esc = function(s){ return BOLD.escapeHtml(s); };
  var COLUMN_MIN = 240;   // keep in step with .column's min-width in board.css

  function columnsHtml(columns){
    // Wide enough for every column at its narrowest, scrolling sideways below that.
    var html = '<div class="columns" style="min-width:' + (COLUMN_MIN * columns.length + (columns.length - 1) + 2) + 'px">';
    columns.forEach(function(c){
      html += '<div class="column" data-col="' + esc(c.id) + '">' +
        '<div class="column-head"><div class="ch-top"><span>' + c.label + '</span><span class="count">' + (c.count == null ? '' : c.count) + '</span></div>' +
          (c.hint != null ? '<div class="ch-hint">' + c.hint + '</div>' : '') + (c.headExtra || '') + '</div>' +
        '<div class="column-body">' + (c.body || '<div class="column-empty">' + (c.empty || 'Nothing here') + '</div>') + '</div>' +
      '</div>';
    });
    return html + '</div>';
  }

  // Heads differ (a hint that wraps, a button under the label): each is pinned to the
  // tallest one's natural height, measured again after every redraw and resize.
  var equalized = [];
  function equalizeHeads(root){
    root = root || document;
    if (equalized.indexOf(root) < 0) equalized.push(root);
    Array.prototype.forEach.call(root.querySelectorAll('.columns'), function(cols){
      var heads = Array.prototype.filter.call(cols.querySelectorAll('.column-head'), function(h){ return h.parentNode.parentNode === cols; });
      heads.forEach(function(h){ h.style.height = ''; });
      var max = heads.reduce(function(m, h){ return Math.max(m, h.offsetHeight); }, 0);
      if (max) heads.forEach(function(h){ h.style.height = max + 'px'; });
    });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){ equalized.forEach(function(r){ if (r === document || r.isConnected) equalizeHeads(r); }); }, 120);
  });

  var HOLD_MS = 280, SLOP = 6;
  function drag(root, opts){
    if (!root || root.__boldBoardDrag) { if (root) root.__boldBoardDrag = opts; return; }
    root.__boldBoardDrag = opts;
    var s = null;   // the drag under way: { el, id, x, y, ghost, over, timer, touch, live }

    function columnAt(x, y){
      var hit = document.elementFromPoint(x, y);
      return hit && hit.closest && hit.closest('.column[data-col]');
    }
    function begin(){
      s.live = true;
      var r = s.el.getBoundingClientRect();
      s.dx = s.x - r.left; s.dy = s.y - r.top;
      s.ghost = s.el.cloneNode(true);
      s.ghost.classList.add('board-ghost');
      s.ghost.style.width = r.width + 'px';
      document.body.appendChild(s.ghost);
      s.el.classList.add('is-dragging');
      document.documentElement.classList.add('board-dragging');
      move(s.x, s.y);
    }
    function move(x, y){
      s.ghost.style.transform = 'translate(' + (x - s.dx) + 'px,' + (y - s.dy) + 'px)';
      var col = columnAt(x, y);
      if (col !== s.over){
        if (s.over) s.over.classList.remove('is-drop-target');
        s.over = col;
        if (col && col !== s.from) col.classList.add('is-drop-target');
      }
      // Near either side of the scrolling area, scroll it along.
      var sc = root.querySelector('.board-scroll');
      if (sc){
        var b = sc.getBoundingClientRect();
        if (x < b.left + 40) sc.scrollLeft -= 14; else if (x > b.right - 40) sc.scrollLeft += 14;
      }
    }
    function end(dropIt){
      if (!s) return;
      clearTimeout(s.timer);
      if (s.live){
        var to = s.over && s.over !== s.from ? s.over.getAttribute('data-col') : null;
        if (s.over) s.over.classList.remove('is-drop-target');
        s.ghost.remove();
        s.el.classList.remove('is-dragging');
        document.documentElement.classList.remove('board-dragging');
        // A drag isn't also a click on the card.
        var el = s.el;
        var swallow = function(e){ e.stopPropagation(); e.preventDefault(); };
        el.addEventListener('click', swallow, true);
        setTimeout(function(){ el.removeEventListener('click', swallow, true); }, 0);
        if (dropIt && to) root.__boldBoardDrag.drop(el, to);
      }
      s = null;
    }

    root.addEventListener('pointerdown', function(e){
      var o = root.__boldBoardDrag;
      if ((e.pointerType === 'mouse' && e.button !== 0) || s) return;
      var el = e.target.closest(o.item);
      if (!el || !root.contains(el) || e.target.closest('a, button:not(.board-drag-through), input, select, textarea, label')) return;
      if (o.canDrag && !o.canDrag(el)) return;
      s = { el: el, from: el.closest('.column[data-col]'), x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', live: false };
      // On a touch screen a quick swipe scrolls; holding a card picks it up.
      if (s.touch) s.timer = setTimeout(function(){ if (s && !s.live) { begin(); if (navigator.vibrate) navigator.vibrate(10); } }, HOLD_MS);
    });
    window.addEventListener('pointermove', function(e){
      if (!s) return;
      if (!s.live){
        var far = Math.abs(e.clientX - s.x) > SLOP || Math.abs(e.clientY - s.y) > SLOP;
        if (!far) return;
        if (s.touch) { end(false); return; }   // a swipe before the hold: let it scroll
        begin();
      }
      e.preventDefault();
      move(e.clientX, e.clientY);
    }, { passive: false });
    // On a touch screen, once a card is held the browser stops sending pointer events
    // (it cancels them to scroll): the drag follows the finger's touch events instead,
    // and the page doesn't scroll under it.
    window.addEventListener('touchmove', function(e){
      if (!s || !s.live || !s.touch) return;
      e.preventDefault();
      var t = e.touches[0];
      if (t) move(t.clientX, t.clientY);
    }, { passive: false });
    window.addEventListener('touchend', function(){ if (s && s.live && s.touch) end(true); });
    window.addEventListener('pointerup', function(e){ if (!(s && s.touch && e.pointerType !== 'mouse' && s.live)) end(true); });
    window.addEventListener('pointercancel', function(){ if (!(s && s.live && s.touch)) end(false); });
    window.addEventListener('keydown', function(e){ if (e.key === 'Escape') end(false); });
  }

  return { columnsHtml: columnsHtml, equalizeHeads: equalizeHeads, drag: drag, COLUMN_MIN: COLUMN_MIN };
})();
