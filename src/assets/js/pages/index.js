// The home page (index.html). Signed out: the hero (BOLD.OS, Log in or Sign up), with no masthead or
// sidebar. Signed in (2026-11-07): a letter from BOLD to them, written afresh each visit from what's
// there (no model yet): what needs them, what's next for them, what the lab is doing. Each part of it is
// a way in: a link, and on hover or focus its other actions beside it; J and K move between them.
// What it says, in order (each only when there's something to say):
// - Hello, and their meeting if it's on or about to start (Join).
// - Who has been waiting on them longest (myRequests' forYou), and how many more.
// - Who replied to them (unread conversation-reply-mine notifications).
// - Their next meeting (their projects', supervision and lab series meetings, as the Calendar reads them), or that
//   they're free until it.
// - Their paper due within two weeks (getMyProjects, projectWorkspace 'venues').
// - New: their next first step (onboarding-common.js).
// - The lab: the papers going to the next deadline (getAllProjects); the week's events; what the lab is
//   talking about most lately (Conversations' posts), and whether it's waiting for an answer.
// BOLD-LLM writes it when it arrives. Under it, Conversations: the same forum as Conversations' page (conversations-forum.js), between the lab (left:
// papers in submission with their deadlines, work completed, events coming up) and them (right: their week, with
// Join; their projects; unread notifications; their first steps until done), as quiet margin notes: each part
// shows three items, and "N more" opens the rest in place.
(function(){
  var esc = BOLD.escapeHtml;
  var masthead = document.getElementById('masthead');
  var sidebar = document.getElementById('sidebar');
  var navToggle = document.getElementById('navToggle');
  var signInBtn = document.getElementById('homeSignInBtn');
  var mount = document.getElementById('bsMount');
  var forum = null;
  if (signInBtn) signInBtn.addEventListener('click', BOLD.signIn);

  function feed(on){
    document.body.classList.toggle('is-home-feed', on);
    if (masthead) masthead.hidden = !on;
    if (sidebar) sidebar.hidden = !on;
    if (navToggle) navToggle.hidden = !on;
    if (on && !forum && mount && window.BoldConversations) {
      forum = BoldConversations.create({ note: false });
      mount.appendChild(forum.el);
    }
  }

  var MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'], DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  var num = function(n){ return WORDS[n] || String(n); };
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  function iso(d){ return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayAt(i){ var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + i); return d; }
  function daysTo(t){ return Math.round((Date.parse(t + 'T12:00:00') - dayAt(0).getTime()) / 86400000); }
  function mins(hm){ var t = String(hm || '0:0').split(':').map(Number); return t[0] * 60 + t[1]; }
  function span(ms){
    var m = Math.round(ms / 60000);
    if (m < 60) return m <= 1 ? 'a minute' : num(m) + ' minutes';
    var h = Math.round(m / 60); if (h < 24) return h === 1 ? 'an hour' : num(h) + ' hours';
    var d = Math.round(h / 24); return d === 1 ? 'a day' : num(d) + ' days';
  }
  function inDays(n){ return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + num(n) + ' days'; }
  function first(name){ return String(name || '').split(' ')[0]; }
  function names(xs){ return xs.length <= 1 ? xs.join('') : xs.length === 2 ? xs[0] + ' and ' + xs[1] : xs[0] + ', ' + xs[1] + ' and ' + (xs.length - 2 === 1 ? 'one other' : num(xs.length - 2) + ' others'); }
  function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
  function quote(t){ t = String(t || '').trim(); return '“' + (t.length > 60 ? t.slice(0, 58).replace(/\s+\S*$/, '') + '…' : t) + '”'; }

  // A way in: the words, a link; its other actions beside it on hover or focus.
  function door(html, href, acts, strong){
    return '<span class="door' + (strong ? ' is-strong' : '') + '"><a class="door-link" href="' + esc(href) + '">' + html + '</a>' +
      (acts && acts.length ? '<span class="door-acts">' + acts.map(function(a){
        return '<a href="' + esc(a[1]) + '"' + (a[2] ? ' target="_blank" rel="noopener"' : '') + '>' + esc(a[0]) + '</a>';
      }).join('') + '</span>' : '') + '</span>';
  }

  var state = {}, unsubs = [], asked = '', user = null;
  function stop(){ unsubs.forEach(function(u){ u(); }); unsubs = []; state = {}; asked = ''; }

  // Their meetings in the next 7 days (as the Calendar's: every N weeks from its first date).
  // Their meetings, as the Calendar reads them (pages/calendar.js meetings()): their projects' (not completed),
  // the supervision meetings they're in (the student's or a supervisor's), and the released lab series that
  // invite them (`guests`); each only once it has its calendar event, and not while paused.
  function mineEmail(e){ return String(e || '').toLowerCase() === asked; }
  function sources(){
    var out = [];
    (state.meetings || []).forEach(function(w){
      if (!w.meeting || !(w.eventId || w.hasEvent || w.pausedAt) || w.group === 'completed' || w.completedAt) return;
      out.push({ title: w.title || 'a project meeting', href: 'project.html#id=' + encodeURIComponent(w.id), x: w });
    });
    (state.studies || []).forEach(function(st){
      if (!st.meeting || !(st.eventId || st.pausedAt)) return;
      if (!mineEmail(st.email) && !(st.people || []).some(function(p){ return mineEmail(p.email); })) return;
      out.push({ title: (mineEmail(st.email) ? 'your ' : (st.name || st.email) + '’s ') + (st.degree === 'Master student' ? 'Master' : 'PhD') + ' supervision',
        href: mineEmail(st.email) ? 'profile.html#studies' : 'calendar.html', x: st });
    });
    (state.series || []).forEach(function(se){
      if (!se.meeting || !(se.eventId || se.pausedAt) || !(se.guests || []).some(mineEmail)) return;
      out.push({ title: se.title || 'a lab meeting', href: 'series.html?series=' + encodeURIComponent(se.id), x: se });
    });
    return out;
  }
  function meetings(){
    var out = [], now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    sources().forEach(function(src){
      var w = src.x, m = w.meeting;
      if (!m || !m.time || w.pausedAt) return;
      for (var i = 0; i < 7; i++) {
        var d = dayAt(i), t = iso(d);
        if (m.day !== DAYS[(d.getDay() + 6) % 7] || (m.until && m.until < t)) continue;
        if (w.eventStart) {
          var start = String(w.eventStart).slice(0, 10), weeks = Math.round((Date.parse(t) - Date.parse(start)) / (7 * 86400000));
          if (t < start || weeks % (m.every || 1)) continue;
        }
        var from = mins(m.time), to = from + (m.minutes || 60);
        if (i === 0 && to <= nowMin) continue;
        out.push({ day: i, wd: (d.getDay() + 6) % 7, from: from, time: m.time, title: src.title, href: src.href,
          join: /^https:\/\//.test(w.meetUrl || '') ? w.meetUrl : '', soon: i === 0 ? from - nowMin : Infinity, on: i === 0 && from <= nowMin });
      }
    });
    return out.sort(function(a, b){ return a.day - b.day || a.from - b.from; });
  }
  function myPapers(){
    if (!state.mine || !state.venues) return [];
    var due = {}, seen = {}, out = [];
    state.venues.forEach(function(v){ due[v.id] = v; });
    ['owner', 'author', 'member'].forEach(function(k){
      (state.mine[k] || []).forEach(function(p){
        var v = p.boardId && due[p.boardId];
        if (!v || !v.deadline || seen[p.cardId]) return;
        seen[p.cardId] = 1; out.push({ title: p.title, venue: v.label, n: daysTo(v.deadline), href: 'project.html#id=' + encodeURIComponent(p.cardId) });
      });
    });
    return out.filter(function(x){ return x.n >= 0; }).sort(function(a, b){ return a.n - b.n; });
  }

  // ---- The letter ----
  function write(){
    var el = document.getElementById('homeLetter');
    if (!el || !state.forYou || !state.notes || !state.meetings) return;   // what decides the first lines isn't in yet
    var h = new Date().getHours(), you = [], lab = [];
    var hello = (h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (user && user.displayName ? ', ' + esc(first(user.displayName)) : '') + '.';
    var ms = meetings(), live = ms.filter(function(m){ return m.day === 0 && m.soon <= 10; })[0];

    // Their meeting, now.
    if (live) you.push((live.on ? 'You’re due in ' : 'Your ') + door('<em>' + esc(live.title) + '</em>' + (live.on ? ' now' : ' meeting starts in ' + span(live.soon * 60000)), live.href, null, true) + '.' +
      (live.join ? ' ' + door('Join it', live.join, null, true) + '.' : ''));
    // Who's waiting on them.
    var w = state.forYou;
    if (w.length) {
      var x = w[0], who = x.by && x.by.name ? first(x.by.name) : 'Someone';
      you.push(door(esc(who) + ' has been waiting ' + span(Date.now() - (x.since || Date.now())), x.url, [['Open it', x.url], ['All waiting', 'notifications.html#todo']], !live) +
        ' on <em>' + esc(x.title || 'a request') + '</em>' +
        (w.length > 1 ? ', and ' + door(num(w.length - 1) + ' more ' + (w.length === 2 ? 'thing needs' : 'things need') + ' you', 'notifications.html#todo') : '') + '.');
    }
    // Who replied to them.
    var replies = state.notes.filter(function(n){ return !n.read && n.feature === 'conversation-reply-mine'; });
    if (replies.length) {
      var people = [];
      replies.forEach(function(n){ var p = String(n.text || '').split(' replied')[0].replace(/^[^A-Za-zÀ-ÿ]+/, ''); p = first(p); if (p && people.indexOf(p) < 0) people.push(p); });
      var where = /in “([^”]+)”/.exec(replies[0].text || '');
      you.push(door(esc(names(people) || 'Someone') + ' replied to you', replies[0].href || 'notifications.html', [['Read it', replies[0].href || 'notifications.html'], ['All replies', 'notifications.html']]) +
        (replies.length === 1 && where ? ' in <em>' + esc(where[1]) + '</em>' : '') + '.');
    }
    // What's next for them, by the day and the hour. Monday morning: the week ahead. Later today: free until it.
    // Nothing left today (a weekend, an evening, a Friday after the last one): say so, and what starts the next
    // working day ("Your week starts on Monday…", "Tomorrow starts…").
    var wd = (new Date().getDay() + 6) % 7, weekend = wd >= 5, evening = h >= 18;
    var todayLeft = ms.filter(function(m){ return m.day === 0 && m !== live; });
    var dueToday = myPapers().some(function(p){ return p.n === 0; });
    var at = function(m){ return door('<em>' + esc(m.title) + '</em>', m.href) + ' ' + (m.day === 0 ? 'today' : m.day === 1 ? 'tomorrow' : 'on ' + DAY_FULL[m.wd]) + ' at ' + esc(m.time); };
    if (!live) {
      var week = ms.filter(function(m){ return m.day <= 4; });
      if (wd === 0 && h < 12 && week.length) {
        you.push('This week you have ' + door(num(week.length) + (week.length === 1 ? ' meeting' : ' meetings'), 'calendar.html') + ', starting with ' + at(week[0]) + '.');
      } else if (todayLeft.length) {
        you.push('You’re free until ' + door('<em>' + esc(todayLeft[0].title) + '</em> at ' + esc(todayLeft[0].time), todayLeft[0].href, todayLeft[0].join ? [['Join', todayLeft[0].join, 1]] : null) + '.');
      } else {
        if (!dueToday) you.push(weekend || h < 12 ? 'Nothing is due today.' : 'Nothing else is due today.');
        var ahead = weekend || evening || wd === 4;
        var nx = (ahead ? ms.filter(function(m){ return m.day >= 1 && m.wd < 5; }) : ms.filter(function(m){ return m.day >= 1; }))[0];
        if (nx && nx.wd === 0 && wd >= 4) you.push('Your week starts on Monday at ' + esc(nx.time) + ' with ' + door('<em>' + esc(nx.title) + '</em>', nx.href) + '.');
        else if (nx && nx.day === 1) you.push('Tomorrow starts at ' + esc(nx.time) + ' with ' + door('<em>' + esc(nx.title) + '</em>', nx.href) + '.');
        else if (nx) you.push('Your next meeting is ' + at(nx) + '.');
        else if ((state.meetings || []).length) you.push('No meetings for you this week.');
      }
    }
    // Their paper, due soon.
    var mp = myPapers().filter(function(p){ return p.n <= 14; })[0];
    if (mp) you.push(door('<em>' + esc(mp.title) + '</em> is due at ' + esc(mp.venue) + ' ' + inDays(mp.n), mp.href, null, mp.n <= 3) + '.');
    // New here: the next first step.
    var st = state.steps;
    if (st && !st.done && st.next) you.push('Next on your first steps: ' + door(esc(st.next.label.charAt(0).toLowerCase() + st.next.label.slice(1)), st.next.href, [['All your steps · ' + st.count, 'onboarding.html']]) + '.');
    if (!you.length) you.push('Nothing needs you.');

    // The lab: papers to the next deadline.
    if (state.all && state.venues) {
      var today = iso(dayAt(0)), at = {};
      (state.all.submission || []).concat(state.all.ongoing || []).forEach(function(p){ if (p.boardId) at[p.boardId] = (at[p.boardId] || 0) + 1; });
      var v = state.venues.filter(function(v){ return v.deadline && v.deadline >= today && at[v.id]; }).sort(function(a, b){ return a.deadline.localeCompare(b.deadline); })[0];
      if (v) lab.push(door(cap(num(at[v.id])) + (at[v.id] === 1 ? ' paper is' : ' papers are') + ' going to ' + esc(v.label), 'audit-board.html#board=' + encodeURIComponent(v.id),
        [['The board', 'audit-board.html#board=' + encodeURIComponent(v.id)], ['All research', 'projects.html']]) + ' ' + inDays(daysTo(v.deadline)) + '.');
    }
    // The week's events.
    if (state.events) {
      var t0 = iso(dayAt(0)), t6 = iso(dayAt(6));
      var evs = state.events.filter(function(x){ return x.startDate && (x.endDate || x.startDate) >= t0 && x.startDate <= t6; }).sort(function(a, b){ return a.startDate.localeCompare(b.startDate); });
      if (evs.length) {
        var e = evs[0], ed = new Date(e.startDate + 'T12:00:00');
        lab.push(door('<em>' + esc(e.title || e.slug) + '</em>', e.page || 'event.html?event=' + encodeURIComponent(e.slug)) + ' is ' +
          (e.startDate <= t0 ? 'on now' : daysTo(e.startDate) === 1 ? 'tomorrow' : 'on ' + DAY_FULL[(ed.getDay() + 6) % 7]) +
          (evs.length > 1 ? ', one of ' + door(num(evs.length) + ' events this week', 'calendar.html') : '') + '.');
      }
    }
    // What the lab is talking about: the busiest conversation lately, and whether it awaits an answer.
    if (state.posts && state.posts.length) {
      var weekAgo = Date.now() - 7 * 86400000, me = asked;
      var recent = state.posts.filter(function(p){ return (p.lastAt || p.at || 0) > weekAgo; });
      var top = recent.slice().sort(function(a, b){ return (b.replies || 0) - (a.replies || 0) || (b.lastAt || b.at || 0) - (a.lastAt || a.at || 0); })[0];
      var open = recent.filter(function(p){ return !(p.replies > 0) && p !== top && String(p.createdBy || '').toLowerCase() !== me && String((p.by || {}).email || '').toLowerCase() !== me; })[0];
      if (top) lab.push('The lab is talking about ' + door(esc(quote(top.title)), 'index.html#post=' + encodeURIComponent(top.id), null) +
        (top.replies ? ' (' + num(top.replies) + (top.replies === 1 ? ' reply' : ' replies') + ')' : '') +
        (open ? ', and nobody has answered ' + esc(first(open.name)) + '’s ' + door(esc(quote(open.title)), 'index.html#post=' + encodeURIComponent(open.id), [['Answer it', 'index.html#post=' + encodeURIComponent(open.id)]]) + ' yet' : '') + '.');
    }

    // Written by BOLD LLM (their choice, profile › Agents, and the lab's, Settings › Home letter; homeLetters/{email})
    // within the last day: that, under the greeting and any meeting on now, which a morning letter can't know.
    var al = llmLetter();
    if (al) { el.innerHTML = '<p>' + hello + (live ? ' ' + you[0] : '') + '</p>' + al; return; }
    el.innerHTML = '<p>' + hello + ' ' + you.join(' ') + '</p>' + (lab.length ? '<p>' + lab.join(' ') + '</p>' : '') +
      (state.letterChoice === 'bold' ? '<p class="hl-by">' + (state.letterWriting ? 'BOLD LLM is writing today’s letter; this is the rule-based one meanwhile.' : 'BOLD LLM couldn’t write today’s letter, so this is the rule-based one.') +
        ' <a href="profile.html#agents">Who writes it</a></p>' : '');
  }
  // BOLD LLM's letter, short or long (kept in this browser), as Markdown, with when it was written; or ''.
  var LEN_KEY = 'boldLetterLength';
  function letterLength(){ try { return localStorage.getItem(LEN_KEY) === 'long' ? 'long' : 'short'; } catch (e){ return 'short'; } }
  function llmLetter(){
    var l = state.llmLetter;
    if (state.letterChoice !== 'bold' || !l || !l.at || Date.now() - l.at >= 24 * 3600000 || !window.BoldMarkdown) return '';
    var len = letterLength(), at = new Date(l.at);
    return '<div class="hl-agent-text">' + BoldMarkdown.render(String(l[len] || l.short || '')) + '</div>' +
      '<p class="hl-by">Written by BOLD LLM at ' + esc(('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2)) + ' · ' +
      '<button type="button" class="btn-text hl-len" data-len="' + (len === 'short' ? 'long' : 'short') + '">' + (len === 'short' ? 'Long' : 'Short') + '</button> · ' +
      '<a href="profile.html#agents">Who writes it</a></p>';
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('.hl-len');
    if (!b) return;
    try { localStorage.setItem(LEN_KEY, b.getAttribute('data-len')); } catch (err){}
    write();
  });

  // ---- Beside Conversations: the lab on the left, them on the right (each part only when it has something) ----
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function ago(t){
    var s = Math.max(0, (Date.now() - (t || 0)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
    var d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }
  function dayName(t){ var d = new Date(t + 'T12:00:00'); return DAY_SHORT[(d.getDay() + 6) % 7] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function part(id, title, href, body){
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = !body;
    if (body) el.innerHTML = '<h2 class="home-box-title"><a href="' + href + '">' + esc(title) + '</a></h2>' + body;
  }
  // Every item, the first three shown and the rest behind "N more", which opens them in place (nothing left out).
  var SHOWN = 3;
  function list(items, html, cls){
    var rest = items.length - SHOWN;
    return '<ul class="home-list' + (cls ? ' ' + cls : '') + '">' + items.map(function(x, i){
      var li = html(x, i);
      return i < SHOWN ? li : li.replace(/^<li/, '<li hidden');
    }).join('') + '</ul>' + (rest > 0 ? '<button type="button" class="btn-text home-open" aria-expanded="false">' + rest + ' more</button>' : '');
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('.home-open');
    if (!b) return;
    var open = b.getAttribute('aria-expanded') !== 'true', ul = b.previousElementSibling;
    Array.prototype.slice.call(ul.children, SHOWN).forEach(function(li){ li.hidden = !open; });
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? 'Fewer' : (ul.children.length - SHOWN) + ' more';
  });
  function more(n, shown, href, what){ return n > shown ? '<p class="home-more"><a href="' + href + '">' + esc(what || 'All ' + n) + '</a></p>' : ''; }
  var projectHref = function(p){ return 'project.html#id=' + encodeURIComponent(p.pid || p.cardId); };

  // In submission: those with a deadline to come first, soonest first; then the rest.
  function drawSubmitting(){
    if (!state.all || !state.venues) return;
    var deadline = {}, today = iso(dayAt(0));
    state.venues.forEach(function(v){ deadline[v.id] = v.deadline || ''; });
    var xs = (state.all.submission || []).filter(function(p){ return p.title && !p.titleOnly; }).map(function(p){
      var d = deadline[p.boardId] || '';
      return { p: p, d: d, open: !!(d && d >= today) };
    }).sort(function(a, b){ return (b.open - a.open) || (a.open ? a.d.localeCompare(b.d) : b.d.localeCompare(a.d)) || a.p.title.localeCompare(b.p.title); });
    part('homeSubmitting', 'In submission', 'projects.html', xs.length ? list(xs, function(x){
      var n = x.open ? daysTo(x.d) : null;
      return '<li><a href="' + projectHref(x.p) + '">' + esc(x.p.title) + '</a><span class="home-meta">' + esc(x.p.boardLabel || 'A venue') +
        (n !== null ? ' · <span class="home-due' + (n <= 14 ? ' is-soon' : '') + '">' + (n === 0 ? 'due today' : n === 1 ? 'due tomorrow' : 'due in ' + n + ' days') + '</span>' : '') + '</span></li>';
    })   : '');
  }
  function drawDone(){
    if (!state.all) return;
    var xs = (state.all.completed || []).filter(function(p){ return p.title && !p.titleOnly; });
    part('homeDone', 'Completed', 'projects.html', xs.length ? list(xs, function(p){
      return '<li><a href="' + projectHref(p) + '">' + esc(p.title) + '</a>' + (p.boardLabel ? '<span class="home-meta">' + esc(p.boardLabel) + '</span>' : '') + '</li>';
    })   : '');
  }
  // Events in the next 30 days, or on now.
  function drawEvents(){
    if (!state.events) return;
    var today = iso(dayAt(0)), end = iso(dayAt(30));
    var xs = state.events.filter(function(x){ return x.startDate && (x.endDate || x.startDate) >= today && x.startDate <= end; })
      .sort(function(a, b){ return a.startDate.localeCompare(b.startDate); });
    part('homeEvents', 'Coming up', 'events.html', xs.length ? list(xs, function(x){
      return '<li><a href="' + esc(x.page || 'event.html?event=' + encodeURIComponent(x.slug)) + '">' + esc(x.title || x.slug) + '</a>' +
        '<span class="home-meta">' + esc((x.startDate <= today ? 'On now' : dayName(x.startDate)) + (x.place ? ' · ' + x.place : '')) + '</span></li>';
    }) : '');
  }
  // Their week: their meetings, Join from 10 minutes before.
  function drawWeek(){
    if (!state.meetings) return;
    var xs = meetings();
    part('homeWeek', 'Your week', 'calendar.html', xs.length ? list(xs, function(m){
      var when = (m.day === 0 ? 'Today' : m.day === 1 ? 'Tomorrow' : DAY_SHORT[m.wd]) + ' ' + m.time;
      return '<li><a href="' + esc(m.href) + '">' + esc(m.title) + '</a><span class="home-meta">' + esc(when) +
        (m.join && m.soon <= 10 ? ' · <a class="home-join" href="' + esc(m.join) + '" target="_blank" rel="noopener">Join</a>' : '') + '</span></li>';
    })   : '');
  }
  function drawProjects(){
    if (!state.mine) return;
    var seen = {}, xs = [];
    ['owner', 'author', 'member'].forEach(function(k){
      (state.mine[k] || []).forEach(function(p){ if (p.cardId && !seen[p.cardId]) { seen[p.cardId] = 1; xs.push(p); } });
    });
    part('homeProjects', 'Your projects', 'profile.html#projects', xs.length ? list(xs, function(p){
      return '<li><a href="project.html#id=' + encodeURIComponent(p.cardId) + '" title="' + esc(p.title || '') + '">' + esc(p.title || 'A project') + '</a></li>';
    }, 'home-list-tight') 
      : '<p class="home-box-sub"><a href="projects.html">Find a project</a> and ask its lead to add you.</p>');
  }
  function drawInbox(){
    if (!state.notes) return;
    var xs = state.notes.filter(function(n){ return !n.read; });
    part('homeInbox', xs.length === 1 ? 'Unread' : 'Unread · ' + (xs.length >= 100 ? '100+' : xs.length), 'notifications.html', xs.length ? list(xs.slice(0, 20), function(n){
      return '<li>' + (n.href ? '<a href="' + esc(n.href) + '">' + esc(n.text) + '</a>' : '<span>' + esc(n.text) + '</span>') + '<span class="home-meta">' + esc(ago(n.at)) + '</span></li>';
    }) + (xs.length > 20 ? '<p class="home-more"><a href="notifications.html">All ' + xs.length + '</a></p>' : '') : '');
  }
  function drawSteps(){
    var box = document.getElementById('next-steps'), s = state.stepsFull;
    if (!box) return;
    if (!s || s.done) { box.hidden = true; return; }
    box.innerHTML = '<h2 class="home-box-title"><a href="onboarding.html">Your first steps</a></h2>' +
      '<p class="home-box-sub">' + (window.BoldJoin ? BoldJoin.groupBadge(s.group) + ' · ' : '') + esc(BoldOnboarding.count(s)) + ' done</p>' +
      '<div class="home-steps-text">' + BoldOnboarding.listHtml(s, 'your first steps') + '</div>' +
      (!s.tour ? '<p class="home-more"><a href="onboarding.html#tour">Take the tour</a></p>' : '');
    box.hidden = false;
  }
  function drawSides(){ drawSubmitting(); drawDone(); drawEvents(); drawWeek(); drawProjects(); drawInbox(); drawSteps(); }

  // ---- Talking to BOLD ----
  // Under the letter, a dialog with BOLD LLM: they write (Markdown, md-field.js), it answers, as Markdown. Open to
  // whoever has BOLD LLM writing their letter (state.chatOn: their choice and the lab's), answered by homeLetter
  // 'ask' (functions/bold-llm.js) with the conversation so far. Otherwise hidden; #ask in the address shows it
  // in this browser as a preview (localStorage boldHomeAsk; #ask-off hides it), whose answer says BOLD LLM isn't
  // on for them and offers a search. Kept for the visit only (sessionStorage).
  var mountAsk = function(){};
  (function(){
    var box = document.getElementById('homeAskBox');
    if (!box) return;
    var KEY = 'boldHomeAsk', LOG = 'boldHomeAskLog', on = false, log = [];
    try {
      if (/[#&]ask-off\b/.test(location.hash)) localStorage.removeItem(KEY);
      else if (/[#&]ask\b/.test(location.hash)) localStorage.setItem(KEY, '1');
      on = localStorage.getItem(KEY) === '1';
      log = JSON.parse(sessionStorage.getItem(LOG) || '[]') || [];
    } catch (e){}
    var mounted = false;
    mountAsk = function(){ if (!mounted) { mounted = true; mount(); } };
    if (on) mountAsk();
    function mount(){
    box.hidden = false;
    var list = box.querySelector('.ha-log'), form = box.querySelector('.ha-form'), text = form.querySelector('textarea');
    var line = box.querySelector('.ha-line'), still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    function md(t){ return window.BoldMarkdown ? BoldMarkdown.render(t, { breaks: true }) : '<p>' + esc(t) + '</p>'; }
    function item(m, fresh){
      return '<li class="ha-msg ha-' + m.who + (fresh ? ' is-new' : '') + '"><p class="ha-who">' + (m.who === 'you' ? 'You' : 'BOLD') + '</p><div class="ha-text md-desc">' + md(m.text) + '</div></li>';
    }
    function save(){ try { sessionStorage.setItem(LOG, JSON.stringify(log.slice(-40))); } catch (e){} }
    function draw(){ list.innerHTML = log.map(function(m){ return item(m); }).join(''); list.hidden = !log.length; }
    // A line that opens into the box: drawn out, then unfolded (CSS); closed again when empty.
    function open(yes){
      box.classList.toggle('is-open', yes);
      line.setAttribute('aria-expanded', String(yes));
      if (yes) setTimeout(function(){ text.focus(); }, still ? 0 : 260);
    }
    line.addEventListener('click', function(){ open(true); });
    box.querySelector('.ha-close').addEventListener('click', function(){ open(false); line.focus(); });
    document.addEventListener('keydown', function(e){
      var t = e.target, tag = t && t.tagName;
      if (e.key === 'Escape' && box.contains(t) && !text.value.trim()) { open(false); line.focus(); return; }
      if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      e.preventDefault(); open(true);
    });
    document.addEventListener('click', function(e){ if (box.classList.contains('is-open') && !box.contains(e.target) && !text.value.trim() && !log.length) open(false); });
    // Without BOLD LLM on for them (the #ask preview): that it isn't, and a way to what they asked meanwhile.
    function placeholder(q){
      var words = q.replace(/[#*_`>\[\]()?!.,;:]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
      return 'BOLD LLM isn’t on for you: choose it on your [profile](profile.html#agents) to talk to it here.' +
        (words ? '\n\nMeanwhile, [search BOLD.OS for “' + words + '”](search.html?q=' + encodeURIComponent(words) + ').' : '');
    }
    // BOLD LLM's answer to the conversation so far (homeLetter 'ask'), or what went wrong.
    function answer(q){
      if (!state.chatOn) return Promise.resolve(placeholder(q));
      var messages = log.map(function(m){ return { role: m.who === 'you' ? 'user' : 'assistant', text: m.text }; });
      return firebase.app().functions('europe-west2').httpsCallable('homeLetter')({ action: 'ask', messages: messages })
        .then(function(r){ return String((r.data || {}).text || ''); })
        .catch(function(err){ console.error('[BOLD Lab] BOLD LLM’s answer failed', err); return (err && err.message && err.code !== 'functions/internal') ? err.message : 'BOLD LLM couldn’t answer just now — try again.'; });
    }
    // BOLD's answer writes itself out, word by word, as a model streams.
    function stream(full){
      var m = { who: 'bold', text: full };
      log.push(m); save();
      list.hidden = false;
      list.insertAdjacentHTML('beforeend', item({ who: 'bold', text: '' }, true));
      var el = list.lastElementChild.querySelector('.ha-text'), parts = full.split(/(\s+)/), n = 0;
      if (still) { el.innerHTML = md(full); return; }
      el.classList.add('is-streaming');
      var tick = setInterval(function(){
        n += 2;
        el.innerHTML = md(parts.slice(0, n).join(''));
        if (n >= parts.length) { clearInterval(tick); el.classList.remove('is-streaming'); el.innerHTML = md(full); }
      }, 35);
    }
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var q = text.value.trim();
      if (!q) return;
      log.push({ who: 'you', text: q }); save();
      list.hidden = false;
      list.insertAdjacentHTML('beforeend', item({ who: 'you', text: q }, true));
      text.value = ''; text.dispatchEvent(new Event('input'));
      // While it thinks: a quiet line, replaced by the answer as it writes itself out.
      list.insertAdjacentHTML('beforeend', '<li class="ha-msg ha-bold ha-pending"><p class="ha-who">BOLD</p><div class="ha-text"><p>Thinking…</p></div></li>');
      form.querySelector('button[type="submit"], button:not([type])') && (form.querySelector('button[type="submit"], button:not([type])').disabled = true);
      answer(q).then(function(a){
        var p = list.querySelector('.ha-pending');
        if (p) p.remove();
        var b = form.querySelector('button[type="submit"], button:not([type])');
        if (b) b.disabled = false;
        stream(a || 'Nothing to say to that.');
      });
    });
    // Enter sends; Shift+Enter is a new line.
    text.addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    draw();
    if (log.length) open(true);
    }
  })();

  // J and K: from one way in to the next, as in a list.
  document.addEventListener('keydown', function(e){
    if ((e.key !== 'j' && e.key !== 'k') || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    var ds = Array.prototype.slice.call(document.querySelectorAll('#homeLetter .door-link'));
    if (!ds.length) return;
    var i = ds.indexOf(document.activeElement);
    e.preventDefault();
    ds[i < 0 ? 0 : Math.max(0, Math.min(ds.length - 1, i + (e.key === 'j' ? 1 : -1)))].focus();
  });

  function drawToday(){
    var el = document.getElementById('homeToday'); if (!el) return;
    var d = new Date();
    el.textContent = DAY_FULL[(d.getDay() + 6) % 7] + ' ' + d.getDate() + ' ' + MONTHS_FULL[d.getMonth()];
  }

  function load(u){
    user = u;
    var me = String(u.email || '').toLowerCase();
    drawToday();
    if (!me || asked === me) return;
    stop(); asked = me;
    var mine = me;
    var db = firebase.firestore(BOLD.getApp());
    var call = function(n, d){ return firebase.app().functions('europe-west2').httpsCallable(n)(d || {}); };
    var fail = function(what, then){ return function(err){ console.error('[BOLD Lab] loading ' + what + ' failed', err); if (then) then(); }; };
    var set = function(k){ return function(v){ if (asked !== mine) return; state[k] = v; write(); drawSides(); }; };
    // Who writes their letter: BOLD LLM if they chose it (prefs/{uid}.homeLetter) and the lab has it on
    // (settings/homeLetter); then today's, or one written now (homeLetter 'write'), the rule-based one meanwhile.
    Promise.all([db.collection('prefs').doc(u.uid).get(), db.collection('settings').doc('homeLetter').get()]).then(function(r){
      var c = (r[0].exists && r[0].data().homeLetter) === 'bold' && (r[1].exists && r[1].data().writer) === 'claude' ? 'bold' : 'rules';
      state.chatOn = c === 'bold';
      if (state.chatOn) mountAsk();
      if (c !== 'bold') return set('letterChoice')(c);
      return db.collection('homeLetters').doc(me).get().then(function(x){
        state.llmLetter = x.exists ? x.data() : null;
        var fresh = state.llmLetter && Date.now() - state.llmLetter.at < 24 * 3600000;
        state.letterWriting = !fresh;
        set('letterChoice')(c);
        if (fresh) return;
        return call('homeLetter', { action: 'write' }).then(function(w){ state.llmLetter = (w.data || {}).letter || null; })
          .catch(fail('BOLD LLM’s letter')).then(function(){ state.letterWriting = false; set('letterChoice')(c); });
      });
    }).catch(fail('who writes your letter'));
    call('myRequests').then(function(r){
      set('forYou')((r.data || {}).forYou || []);
      if (BOLD.setTodoCount) BOLD.setTodoCount((state.forYou || []).length);
    }, fail('what waits on you', function(){ set('forYou')([]); }));
    call('projectWorkspace', { action: 'venues' }).then(function(r){ set('venues')((r.data || {}).venues || []); }, fail('the venues', function(){ set('venues')([]); }));
    call('getAllProjects').then(function(r){ set('all')(r.data || {}); }, fail('the projects'));
    call('getMyProjects').then(function(r){ set('mine')(r.data || {}); }, fail('your projects', function(){ set('mine')({}); }));
    unsubs.push(db.collection('projectWorkspaces').where('members', 'array-contains', me).onSnapshot(function(s){
      set('meetings')(s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }));
    }, fail('your meetings', function(){ set('meetings')([]); })));
    // Supervision meetings, as the Calendar reads them (firestore.rules lets the lab read studies).
    unsubs.push(db.collection('studies').onSnapshot(function(snap){
      set('studies')(snap.docs.map(function(d){ return Object.assign({ email: d.id }, d.data()); }));
    }, fail('the supervision meetings', function(){ set('studies')([]); })));
    unsubs.push(db.collection('notifications').where('to', '==', me).onSnapshot(function(s){
      set('notes')(s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return (b.at || 0) - (a.at || 0); }));
    }, fail('your notifications', function(){ set('notes')([]); })));
    // The lab's conversations (the open ones; firestore.rules), as the forum lists them.
    unsubs.push(db.collection('conversations').where('private', '==', false).onSnapshot(function(s){
      var t = function(v){ return v && v.toMillis ? v.toMillis() : Number(v) || 0; };
      set('posts')(s.docs.map(function(d){ var p = Object.assign({ id: d.id }, d.data()); p.at = t(p.at); p.lastAt = t(p.lastAt); return p; }));
    }, fail('the conversations', function(){ set('posts')([]); })));
    var evAsked = false;
    BOLD.onAccess(function(a){
      if (evAsked || !a || asked !== mine) return; evAsked = true;
      // The lab series their group sees, released (as the Calendar's); theirs are those inviting them.
      unsubs.push(db.collection('eventSeries').where('hidden', '==', false).where('visibleTo', 'in', BOLD.visibleLevels()).onSnapshot(function(snap){
        set('series')(snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }));
      }, fail('the lab series', function(){ set('series')([]); })));
      unsubs.push(db.collection('events').where('hidden', '==', false).where('visibleTo', 'in', BOLD.visibleLevels()).onSnapshot(function(s){
        set('events')(s.docs.map(function(d){ return d.data(); }));
      }, fail('the events', function(){ set('events')([]); })));
      if (a.group !== 'out' && window.BoldOnboarding) BoldOnboarding.load(function(s){
        if (!s) return;
        var next = (s.steps || []).filter(function(x){ return !x.done; })[0];
        state.stepsFull = s;
        set('steps')({ done: s.done, next: next, count: BoldOnboarding.count(s) });
      });
    });
    // The letter keeps up with the clock (a meeting coming up), each minute.
    var tick = setInterval(function(){ if (asked === mine) { write(); drawWeek(); } }, 60000);
    unsubs.push(function(){ clearInterval(tick); });
  }

  if (!BOLD.getAuth()) feed(false);
  else {
    if (BOLD.authHint()) feed(true);
    BOLD.onUser(function(u){ feed(!!u); if (u) load(u); else stop(); });
  }
})();
