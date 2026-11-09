// The tour of BOLD.OS (onboarding, 2026-11-02): an overlay that lights up the real menu and
// masthead one item at a time, with a short note on each, Back, Next and Skip.
// Its steps are a Markdown list, "- [Label](target): what it's for", from the Get started
// guide's part `tour` (so it's changed by proposing, as the guide is), else DEFAULT below.
// A target is a menu link's href (projects.html: its item in the sidebar) or one of the
// masthead's named controls (#search, #create, #mine, #notifications, #you, #theme, #access).
// A step whose target isn't on the page (a menu item someone's group can't see) is skipped.
// BoldTour.start({ markdown, onDone }) runs it; onDone(true) when they reach the end, (false) on Skip.
window.BoldTour = (function(){
  var esc = BOLD.escapeHtml;
  var DEFAULT = [
    '- [Search](#search): Find anything on BOLD.OS: people, projects, pages, guides.',
    '- [+](#create): Start something new: a project, an event, a request.',
    '- [Mine](#mine): What’s yours: your projects, events, letters and introductions.',
    '- [Notifications](#notifications): What waits on you.',
    '- [You](#you): Your profile: your details, your group, your accounts and agents.',
    '- [BOLDiquette](boldiquette.html): How BOLD works, agreed by everyone. Read it; changes are proposed and reviewed.',
    '- [Research](projects.html): The lab’s projects. Join one, or register yours.',
    '- [Calendar](calendar.html): Meetings, events and deadlines, in one place.',
    '- [People](people.html): Who’s in BOLD, and what they work on.',
    '- [Events](events.html): Where BOLD gathers: the group meeting, reading groups, workshops.',
    '- [Agents](agents.html): Connect your AI agent to BOLD.OS.',
    '- [How to](guides.html): Guides to doing things at BOLD.',
    '- [Service desk](service-desk.html): Letters, introductions, and getting started.',
    '- [Who can see what](#access): Who can see the page you’re on. Each page says so here.'
  ].join('\n');
  var NAMED = { search: '.masthead .mast-search', create: '.masthead .mast-create', mine: '.masthead .mast-mine', notifications: '.masthead .mast-bell',
    you: '.masthead .mast-avatar', theme: '.masthead .mast-theme', access: '.page-access' };

  // "- [Label](target): text" lines → [{ label, target, text }].
  function parse(md){
    return String(md || '').split('\n').map(function(l){
      var m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*:?\s*(.*)$/.exec(l);
      return m ? { label: m[1], target: m[2], text: m[3] } : null;
    }).filter(Boolean);
  }
  function visible(el){ if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }
  function find(target){
    if (target.charAt(0) === '#') {
      var sel = NAMED[target.slice(1)], el = sel && document.querySelector(sel);
      return el && el.closest('button, a, .page-access') || el;
    }
    var links = document.querySelectorAll('#sidebar a[href="' + target.replace(/"/g, '') + '"]');
    for (var i = 0; i < links.length; i++) if (!links[i].classList.contains('nav-sub')) return links[i].closest('.nav-group-head') || links[i];
    return links[0] || null;
  }
  // On a narrow screen the menu is a drawer: open it for the menu's steps.
  var opened = false;   // the drawer the tour opened, closed again for the masthead's steps and at the end
  function openMenu(){
    var shell = document.getElementById('shell'), t = document.getElementById('navToggle');
    if (window.matchMedia('(max-width: 820px)').matches && t && shell && !shell.classList.contains('is-nav-open')) { t.click(); opened = true; }
    var rail = document.getElementById('sidebarCollapse');
    if (shell && rail && shell.classList.contains('is-collapsed')) rail.click();
  }

  function closeMenu(){
    var shell = document.getElementById('shell'), t = document.getElementById('navToggle');
    if (opened && t && shell && shell.classList.contains('is-nav-open')) t.click();
    opened = false;
  }

  function start(o){
    o = o || {};
    var steps = parse(o.markdown);
    if (!steps.length) steps = parse(DEFAULT);
    var i = 0, ui = document.createElement('div'), lastFocus = document.activeElement;
    ui.className = 'tour';
    ui.innerHTML = '<div class="tour-spot" aria-hidden="true"></div><div class="tour-pop" role="dialog" aria-modal="true" aria-live="polite" aria-labelledby="tourTitle" tabindex="-1"></div>';
    document.body.appendChild(ui);
    var spot = ui.querySelector('.tour-spot'), pop = ui.querySelector('.tour-pop');
    function el(k){ return steps[k] && find(steps[k].target); }
    function next(from, dir){ for (var k = from; k >= 0 && k < steps.length; k += dir) { if (steps[k].target.charAt(0) !== '#') openMenu(); else closeMenu(); if (visible(el(k))) return k; } return -1; }
    function place(){
      var e = el(i);
      if (!e) return;
      var r = e.getBoundingClientRect(), pad = 6;
      spot.style.top = (r.top - pad) + 'px'; spot.style.left = (r.left - pad) + 'px';
      spot.style.width = (r.width + 2 * pad) + 'px'; spot.style.height = (r.height + 2 * pad) + 'px';
      var pw = Math.min(320, window.innerWidth - 32), ph = pop.offsetHeight;
      var below = r.bottom + 14 + ph < window.innerHeight, right = r.right + 14 + pw < window.innerWidth;
      var top = r.left < 260 && right ? Math.max(16, Math.min(r.top, window.innerHeight - ph - 16)) : below ? r.bottom + 14 : Math.max(16, r.top - ph - 14);
      var left = r.left < 260 && right ? r.right + 14 : Math.max(16, Math.min(r.left, window.innerWidth - pw - 16));
      pop.style.width = pw + 'px'; pop.style.top = top + 'px'; pop.style.left = left + 'px';
    }
    function show(){
      var s = steps[i], first = next(i - 1, -1) < 0, last = next(i + 1, 1) < 0;
      var e = el(i);
      if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest' });
      var n = steps.filter(function(x, k){ return visible(el(k)); }).length, at = steps.slice(0, i + 1).filter(function(x, k){ return visible(el(k)); }).length;
      pop.innerHTML = '<p class="tour-count">' + at + ' of ' + n + '</p><h2 id="tourTitle">' + esc(s.label) + '</h2><p>' + esc(s.text) + '</p>' +
        '<div class="tour-actions"><button type="button" class="btn-text tour-skip">Skip the tour</button>' +
        (first ? '' : '<button type="button" class="btn-box tour-back">Back</button>') +
        '<button type="button" class="btn-box is-primary tour-next">' + (last ? 'Finish' : 'Next') + '</button></div>';
      place();
      var b = pop.querySelector('.tour-next'); if (b) b.focus();
    }
    function end(done){
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', key, true);
      ui.remove(); closeMenu();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      if (o.onDone) o.onDone(done);
    }
    function key(e){
      if (e.key === 'Escape') { e.preventDefault(); end(false); }
      else if (e.key === 'ArrowRight') { var k = next(i + 1, 1); if (k >= 0) { i = k; show(); } }
      else if (e.key === 'ArrowLeft') { var j = next(i - 1, -1); if (j >= 0) { i = j; show(); } }
    }
    pop.addEventListener('click', function(e){
      if (e.target.closest('.tour-skip')) return end(false);
      if (e.target.closest('.tour-back')) { var j = next(i - 1, -1); if (j >= 0) { i = j; show(); } return; }
      if (e.target.closest('.tour-next')) { var k = next(i + 1, 1); if (k < 0) return end(true); i = k; show(); }
    });
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); document.addEventListener('keydown', key, true);
    i = next(0, 1);
    if (i < 0) { ui.remove(); return; }
    show();
  }
  return { start: start, parse: parse, DEFAULT: DEFAULT };
})();
