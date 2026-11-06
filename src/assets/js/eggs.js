// Easter eggs, on every page (base.njk). None of them writes, messages or tells anyone:
// they only change what this page shows, until it's reloaded. The others live where they
// belong: the 404 page (404.njk), `sudo` in search (pages/search.js), the lamp theme
// (mountTheme, bold.js), the deadline's shiver (markdown.js), the Lineage engraving
// (pages/network.js), \bold in KaTeX (card-model.js) and the inbox's cat (pages/notifications.js).
// Here: the console, Reviewer 2, milestone numbers, the birthday and the Matrix (`redpill`).
// Their styles are at the end of bold.css.
(function(){
  var root = document.documentElement;

  // Devtools: a hello for whoever reads the source.
  try {
    console.log('%c\n ██████   ██████  ██      ██████ \n ██   ██ ██    ██ ██      ██   ██\n ██████  ██    ██ ██      ██   ██\n ██   ██ ██    ██ ██      ██   ██\n ██████   ██████  ███████ ██████ .OS\n',
      'color:#1a2b4a;font-family:monospace;font-weight:bold');
    console.log('Like reading source? It’s public, and pull requests are welcome: https://github.com/bold-lab-ai/bold-os');
  } catch (e){}

  // The Konami code: Reviewer 2 leaves a note on each heading. Esc, or the code again, takes them away.
  var KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'], at = 0;
  var NOTES = ['Missing baseline.', 'Have the authors considered a larger model?', 'Weak reject.', 'The novelty is unclear.',
    'Please cite [47].', 'Error bars?', 'Not convinced.', 'Typo.', 'Why not just use a transformer?', 'Over-claimed.',
    'This was done in 1997.', 'The writing could be improved.', 'Ablation, please.', 'Confidence: 5.'];
  function reviewer2(on){
    document.querySelectorAll('.r2-note').forEach(function(n){ n.remove(); });
    root.classList.toggle('is-reviewer2', on);
    if (!on) return;
    var pool = NOTES.slice();
    document.querySelectorAll('.shell-main h1, .shell-main h2, .shell-main h3').forEach(function(h){
      if (!h.offsetParent) return;
      if (!pool.length) pool = NOTES.slice();
      var n = document.createElement('span');
      n.className = 'r2-note';
      n.setAttribute('aria-hidden', 'true');
      n.textContent = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      n.style.setProperty('--tilt', (Math.random() * 4 - 2).toFixed(1) + 'deg');
      h.appendChild(n);
    });
  }
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && root.classList.contains('is-reviewer2')) { reviewer2(false); return; }
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) { at = 0; return; }
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    at = k === KONAMI[at] ? at + 1 : (k === KONAMI[0] ? 1 : 0);
    if (at === KONAMI.length) { at = 0; reviewer2(!root.classList.contains('is-reviewer2')); }
  });

  // Milestone numbers (numberFor's one sequence for requests and cards): a badge reading #42, #404
  // or #1337 says what it is, under the pointer, and has a mark.
  var MILESTONES = { '42': 'The answer, apparently.', '404': 'Card not found. (It’s right here.)', '1337': 'Elite.', '100': 'A century.', '1000': 'Four digits.' };
  function milestones(scope){
    (scope.querySelectorAll ? scope : document).querySelectorAll('.badge:not([data-egg])').forEach(function(b){
      var m = /^#(\d+)$/.exec(b.textContent.trim()), why = m && MILESTONES[m[1]];
      b.setAttribute('data-egg', '');
      if (why) { b.classList.add('is-milestone'); b.title = why; }
    });
  }
  function watch(){
    milestones(document);
    var queued = false;
    new MutationObserver(function(){
      if (queued) return;
      queued = true;
      requestAnimationFrame(function(){ queued = false; milestones(document); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  // The lab's birthday (site.founded, MM-DD): a confetti rule under the masthead, all day.
  function birthday(){
    var d = window.BOLD_FOUNDED, now = new Date();
    if (!d || !/^\d\d-\d\d$/.test(d)) return;
    var today = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    if (today !== d) return;
    root.classList.add('is-birthday');
    var mast = document.getElementById('masthead');
    if (mast) mast.title = 'Happy birthday, BOLD.';
  }

  // Type `redpill` (not in a field): the whole site in green on black, glyphs raining behind it.
  // `bluepill`, or the pill at the bottom right, wakes you up. Kept across pages (boldMatrix).
  var typed = '', rain = null;
  function matrix(on, entering){
    try { console.log(on ? '[BOLD] Wake up.' : '[BOLD] Blue pill.'); } catch (e){}
    root.classList.toggle('is-matrix', on);
    try { if (on) localStorage.setItem('boldMatrix', '1'); else localStorage.removeItem('boldMatrix'); } catch (e){}
    if (!on) {
      if (rain) { rain.stop(); rain = null; }
      document.querySelectorAll('.mx-pill, .mx-wake, .mx-scan').forEach(function(n){ n.remove(); });
      return;
    }
    if (!document.querySelector('.mx-pill')) {
      var pill = document.createElement('button');
      pill.type = 'button'; pill.className = 'mx-pill'; pill.textContent = 'Take the blue pill';
      pill.addEventListener('click', function(){ matrix(false); });
      document.body.appendChild(pill);
    }
    if (!rain) rain = startRain(entering);
    if (!document.querySelector('.mx-scan')) { var sc = document.createElement('div'); sc.className = 'mx-scan'; sc.setAttribute('aria-hidden', 'true'); document.body.appendChild(sc); }
  }
  // The conversation's brain: what it says back to what you type. Scripted for now, and made to be
  // swapped for a model later (BOLD-LLM): set BoldEggs.brain = function(said, st){ … } returning a reply,
  // or a Promise of one. A reply is { lines: [...], then: 'prompt' | 'game' | 'matrix' | 'close' | 'rabbit' };
  // st is the conversation's memory (stage, name, turns), kept between turns.
  var REPLIES = ['Denied by the Firestore rules of this reality.', 'The Oracle is in a meeting. Try the Service desk.',
    'That is a hyperparameter, not a choice.', 'Interesting. Reviewer 2 disagrees.', 'Your request has been numbered. Nobody will read it.',
    'Have you tried a larger batch size?', 'I can only show you the door.'];
  var WORDS = ['gradient', 'softmax', 'dropout', 'baseline', 'ablation', 'tensor', 'epoch', 'rebuttal', 'arxiv', 'seed', 'attention', 'kernel'];
  function pick(a){ return a[Math.floor(Math.random() * a.length)]; }
  function scripted(said, st){
    var w = said.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    var R = function(lines, then){ return { lines: lines, then: then || 'prompt' }; };
    var name = st.name || 'BOLD';
    st.turns = (st.turns || 0) + 1;
    if (/^(exit|quit|bye|logout)$/.test(w)) return R(['There is no exit.', 'Fine. There is.'], 'close');
    if (w === 'help') return R(['Try: who’s there · red · blue · why me · who are you · where am i · what time is it · rabbit · spoon · exit']);
    if (/^(red|red pill|the red one|take the red pill|i take the red pill)$/.test(w)) {
      st.stage = 'game';
      return R(['Good.', 'Before you go in, show me you can move.', 'Type each word before it fades. Three of them.'], 'game');
    }
    if (/^(blue|blue pill|the blue one|take the blue pill|i take the blue pill)$/.test(w)) return R(['Back to your desk, then.', 'The deadline is still real.'], 'close');
    if (st.stage === 'knock') {
      if (/whos there|who is there|who is it|who/.test(w)) { st.stage = 'knock2'; return R(['Reviewer 2.']); }
      return R(['(You’re supposed to say: who’s there?)']);
    }
    if (st.stage === 'knock2') {
      st.stage = 'choice';
      if (/reviewer 2 who|reviewer two who|who$/.test(w)) return R(['Reviewer 2, who thinks you should have cited [47].', 'Now. Red pill, or blue pill?']);
      return R(['Reviewer 2 doesn’t wait for the punchline either.', 'Red pill, or blue pill?']);
    }
    if (st.stage === 'retry') {
      if (/^(y|yes|again|ok|okay|sure)$/.test(w)) { st.stage = 'game'; return R(['Again. Faster.'], 'game'); }
      return R(['Then wake up at your desk.'], 'close');
    }
    if (st.stage === 'seed') {
      st.stage = 'choice';
      if (/^(y|yes|i do|of course)/.test(w)) return R(['Then you’ll never reproduce anything.', 'Red, or blue?']);
      if (/^(n|no|i dont|never)/.test(w)) return R(['Good. Neither does Reviewer 2.', 'Red, or blue?']);
      return R(['That wasn’t a yes or a no. Red, or blue?']);
    }
    if (/^(whoami|who am i)$/.test(w)) return R([st.name ? 'You are ' + st.name + '. Or so the Slack sign-in says.' : 'Nobody. You aren’t signed in.']);
    if (/who are you/.test(w)) return R(['Someone who has been reading your reviews for a long time.', 'Some call me BOLD-LLM. Not yet.']);
    if (/why me|why/.test(w)) return R(['Because it’s ' + clock() + ', and you’re still on BOLD.OS.']);
    if (/where am i|where is this/.test(w)) return R(['On ' + document.title.replace(/ \| BOLD.*$/, '') + '.', 'Or that’s what it looks like.']);
    if (/time/.test(w)) return R([clock() + '.', 'Of course it is.']);
    if (/what is (this|the matrix|bold ?os)|matrix/.test(w)) return R(['A website. A lab. A loss function you can’t see.', 'Red pill, and you’ll see it.']);
    if (/rabbit/.test(w)) return R(['Follow it.'], 'rabbit');
    if (/spoon/.test(w)) return R(['There is no baseline.']);
    if (/^(hi|hello|hey)\b/.test(w)) return R(['Hello, ' + name + '.', 'We don’t have much time.']);
    // Every so often it asks something back, and it keeps you coming back to the choice.
    if (!st.asked && st.turns >= 3) { st.asked = true; st.stage = 'seed'; return R(['Do you believe in random seeds, ' + name + '?']); }
    st.lost = (st.lost || 0) + 1;
    return R(st.lost % 3 === 0 ? ['Focus, ' + name + '.', 'Red pill, or blue pill?'] : [pick(REPLIES)]);
  }
  function clock(){ var d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function gameOutcome(hits, st){
    if (hits === 3) return { lines: ['Faster than Reviewer 2.', 'Loading the construct...'], then: 'matrix' };
    if (hits) return { lines: [hits + ' of 3. Not bad. Not fast.', 'Loading the construct anyway...'], then: 'matrix' };
    st.stage = 'retry';
    return { lines: ['Too slow.', 'Again? (yes / no)'], then: 'prompt' };
  }
  function firstName(){
    try { var u = BOLD.getAuth() && BOLD.getAuth().currentUser; return u && u.displayName ? u.displayName.split(' ')[0] : ''; } catch (e){ return ''; }
  }
  function converse(){
    if (document.querySelector('.mx-term')) return;
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var term = document.createElement('div');
    term.className = 'mx-wake mx-term'; term.setAttribute('role', 'dialog'); term.setAttribute('aria-label', 'Wake up');
    term.innerHTML = '<div class="mx-log" aria-live="polite"></div><form class="mx-prompt" hidden><span aria-hidden="true">&gt;</span>' +
      '<input type="text" autocomplete="off" spellcheck="false" aria-label="Your answer"></form>';
    document.body.appendChild(term);
    var log = term.querySelector('.mx-log'), form = term.querySelector('.mx-prompt'), input = form.querySelector('input'), queue = [], busy = false;
    var st = { stage: 'knock', name: firstName() }, game = null, thinking = false;
    function close(){ if (game && game.timer) clearTimeout(game.timer); term.classList.add('is-gone'); setTimeout(function(){ term.remove(); }, 600); }
    // As in the film: lines typed one under another at a person's uneven pace, the block cursor on the
    // line being typed; each message clears the screen first. Then the prompt. A line is its text, or
    // [text, ms] to hold it that long before the next (the cursor blinking on it). opts.lead: a blank
    // screen with only the cursor first; opts.instant: shown at once (the game's words).
    function say(lines, then, opts){ queue.push({ lines: lines, then: then, opts: opts || {} }); if (!busy) next(); }
    function next(){
      var job = queue.shift();
      if (!job) { busy = false; form.hidden = false; input.focus(); return; }
      busy = true; form.hidden = true;
      log.innerHTML = '';
      var quick = still || job.opts.instant, first = null;
      if (job.opts.lead && !quick) { first = document.createElement('p'); log.appendChild(first); }   // only the cursor, blinking
      setTimeout(function(){ line(0); }, quick ? 0 : job.opts.lead || 0);
      function line(k){
        // Done: hand over to `then` (free to say more, or to show the prompt with next()), else the prompt.
        if (k >= job.lines.length) { setTimeout(function(){ if (job.then) { busy = false; job.then(); } else next(); }, quick ? 0 : 900); return; }
        var l = job.lines[k], text = typeof l === 'string' ? l : l[0], hold = typeof l === 'string' ? 1100 : l[1], i = 0;
        var p = k === 0 && first ? first : document.createElement('p');
        if (!p.parentNode) log.appendChild(p);
        if (quick) { p.textContent = text; line(k + 1); return; }
        (function key(){
          p.textContent = text.slice(0, ++i);
          if (i >= text.length) { setTimeout(function(){ line(k + 1); }, hold); return; }
          var c = text[i - 1], n = text[i];
          // Trailing dots come one by one; other punctuation is a beat; spaces a little longer than letters.
          setTimeout(key, c === '.' && n === '.' ? 420 + Math.random() * 160 : /[.,?]/.test(c) ? 260 + Math.random() * 200 : c === ' ' ? 90 + Math.random() * 80 : 45 + Math.random() * 90);
        })();
      }
    }
    // What a reply's `then` does once its lines are typed.
    function reply(r){
      var after = { game: play, matrix: function(){ close(); matrix(true, true); }, close: close,
        rabbit: function(){ location.href = '404.html#rabbit'; } }[r.then];   // the loss curve; served locally too
      say(r.lines || [], after || null);
    }
    // The reflex test: three words, each to be typed before it fades.
    var LIMIT = still ? 8000 : 4000;
    function play(){
      var pool = WORDS.slice(), words = [];
      while (words.length < 3) words.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      game = { words: words, i: 0, hits: 0 };
      round();
    }
    function round(){
      if (game.i >= game.words.length) { var h = game.hits; game = null; reply(gameOutcome(h, st)); return; }
      var word = game.words[game.i];
      say([word], function(){
        var p = log.lastChild;
        if (p) { p.classList.add('mx-word'); p.style.animationDuration = LIMIT + 'ms'; }
        game.word = word;
        game.timer = setTimeout(function(){ if (game && game.word === word) { game.word = null; game.i++; say(['missed'], function(){ setTimeout(round, 500); }, { instant: true }); } }, LIMIT);
        next();
      }, { instant: true });
    }
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var said = input.value.trim();
      input.value = '';
      if (!said || thinking) return;
      if (game) {
        if (!game.word) return;
        clearTimeout(game.timer);
        var hit = said.toLowerCase() === game.word;
        if (hit) game.hits++;
        game.word = null; game.i++;
        say([hit ? 'yes' : 'no'], function(){ setTimeout(round, 500); }, { instant: true });
        return;
      }
      // The brain may answer at once or later (a model): the prompt waits on it.
      var brain = (window.BoldEggs && BoldEggs.brain) || scripted;
      thinking = true; form.hidden = true;
      Promise.resolve().then(function(){ return brain(said, st); }).then(function(r){ thinking = false; reply(r || { lines: ['...'] }); },
        function(err){ thinking = false; try { console.warn('[BOLD] brain', err); } catch (x){} reply({ lines: ['The signal is breaking up. Try again.'] }); });
    });
    term.addEventListener('keydown', function(e){ if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    // A knock at the door: the screen thuds twice.
    function knock(){ if (!still) { term.classList.add('is-knocked'); setTimeout(function(){ term.classList.remove('is-knocked'); }, 700); } next(); }
    var who = st.name || 'BOLD';
    // The film's beats: a blank screen first, each line left to sink in; after the knock, it's your turn.
    say([['Wake up, ' + who + '...', 3500], ['BOLD.OS has you...', 3500], ['Follow the white rabbit.', 3000], ['Knock, knock, ' + who + '.', 400]], knock, { lead: 1500 });
  }
  // The film's digital rain. Glyphs sit in fixed cells; nothing slides. A stream is a head moving down a
  // column: each cell it reaches lights up near-white with a fresh glyph, then fades where it is, so a trail
  // is the cells it has passed, fading at their column's rate. Lit glyphs change now and then. Mirrored
  // half-width katakana and digits; some columns dimmer, smaller and slower, for depth.
  var RAIN_GLYPHS = 'ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ012345789Z:.=*+-<>¦|';
  function rainGlyph(){ return RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)]; }
  function rainColumn(rows, depth){
    var c = { depth: depth, rows: rows, cells: [], heads: [], decay: 0.9 + Math.random() * 0.06 };
    for (var r = 0; r < rows; r++) c.cells.push({ g: rainGlyph(), b: 0 });
    return c;
  }
  function rainHead(c, top){ return { y: top ? Math.random() * c.rows : -Math.random() * c.rows * 0.8, speed: (0.3 + Math.random() * 0.5) * (c.depth < 1 ? 0.7 : 1), row: -1 }; }
  // One step of a column: heads move; a cell a head reaches lights up; every lit cell fades.
  function rainStep(c, respawn){
    c.cells.forEach(function(cell){ if (cell.b > 0) { cell.b *= c.decay; if (cell.b < 0.03) cell.b = 0; else if (Math.random() < 0.02) cell.g = rainGlyph(); } });
    c.heads = c.heads.filter(function(h){
      h.y += h.speed;
      var r = Math.floor(h.y);
      if (r !== h.row && r >= 0 && r < c.rows) { h.row = r; c.cells[r].g = rainGlyph(); c.cells[r].b = 1; }
      if (r >= c.rows) return respawn ? (Object.assign(h, rainHead(c, false)), true) : false;
      return true;
    });
  }
  function rainDraw(cx, c, x, S){
    var fs = Math.round(S * (c.depth < 1 ? 0.8 : 1)), dim = c.depth < 1 ? 0.45 : 1;
    cx.font = '600 ' + fs + 'px "MS Gothic", "Hiragino Kaku Gothic Pro", "Noto Sans JP", ui-monospace, monospace';
    var heads = {}; c.heads.forEach(function(h){ heads[h.row] = true; });
    c.cells.forEach(function(cell, r){
      if (!cell.b) return;
      cx.save();
      cx.translate(x + S / 2, r * S);
      cx.scale(-1, 1);   // mirrored, as in the film
      if (heads[r]) { cx.shadowColor = '#bfffd0'; cx.shadowBlur = 12; cx.fillStyle = 'rgba(225,255,232,' + dim + ')'; }
      else { cx.shadowBlur = 0; cx.fillStyle = cell.b > 0.75 ? 'rgba(150,255,170,' + cell.b * dim + ')' : 'rgba(40,215,90,' + Math.min(1, cell.b * 1.3) * dim + ')'; }
      cx.fillText(cell.g, 0, 0);
      cx.restore();
    });
  }
  // The whole screen of it (the Matrix). Drawn over the page, screened (dark adds nothing), taking no
  // clicks. `entering`: a full-screen downpour for a moment, then it settles behind the page (.mx-rain.is-full).
  function startRain(entering){
    var cv = document.createElement('canvas'), cx = cv.getContext('2d');
    cv.className = 'mx-rain' + (entering ? ' is-full' : ''); cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
    var S = 18, cols = [], frame = 0, last = 0, W = 0, H = 0;
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function size(){
      var d = window.devicePixelRatio || 1;
      W = innerWidth; H = innerHeight; cv.width = W * d; cv.height = H * d; cx.setTransform(d, 0, 0, d, 0, 0);
      var rows = Math.ceil(H / S) + 1; cols = [];
      for (var x = 0; x < Math.ceil(W / S); x++){
        var c = rainColumn(rows, Math.random() < 0.3 ? 0.55 : 1);
        c.heads.push(rainHead(c, true));
        if (Math.random() < 0.35) c.heads.push(rainHead(c, false));
        cols.push(c);
      }
    }
    function draw(){
      cx.fillStyle = '#030a06'; cx.fillRect(0, 0, W, H);
      cx.textBaseline = 'top'; cx.textAlign = 'center';
      cols.forEach(function(c, x){ rainStep(c, true); rainDraw(cx, c, x * S, S); });
    }
    function loop(t){ frame = requestAnimationFrame(loop); if (t - last < 33) return; last = t; draw(); }
    size();
    if (still) { for (var k = 0; k < 40; k++) cols.forEach(function(c){ rainStep(c, true); }); draw(); } else frame = requestAnimationFrame(loop);
    addEventListener('resize', size);
    if (entering) setTimeout(function(){ cv.classList.remove('is-full'); }, 2600);
    return { stop: function(){ cancelAnimationFrame(frame); removeEventListener('resize', size); cv.remove(); } };
  }
  document.addEventListener('keydown', function(e){
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === ' ') return;   // "red pill" counts too
    typed = (typed + e.key.toLowerCase()).slice(-8);
    if (/redpill$/.test(typed) && !root.classList.contains('is-matrix')) { typed = ''; converse(); }
    else if (/bluepill$/.test(typed) && root.classList.contains('is-matrix')) { typed = ''; matrix(false); }
  });
  addEventListener('storage', function(e){ if (e.key === 'boldMatrix') matrix(e.newValue === '1'); });
  // For search (pages/search.js: `red pill`).
  // 01:24. Idle for 30 minutes or more, on any page, the conversation opens by itself; otherwise, on
  // the homepage, hints (below), and a click on the title goes straight into the Matrix.
  // From 01:24 to 01:29 (a background tab's timers may run only once a minute), once a page.
  var IDLE = 30 * 60e3, lastActive = Date.now(), called = false;
  ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function(t){
    addEventListener(t, function(){ lastActive = Date.now(); }, { passive: true, capture: true });
  });
  function isHome(){ var p = location.pathname; return /\/$/.test(p) || /\/index\.html$/.test(p); }
  // Hints, as the film gives them, on the homepage until you follow them: the title buzzes left and
  // right, a single stream of rain falls down the page now and then, and the search box types
  // "Follow the white rabbit." Meanwhile a click on the title goes straight into the Matrix.
  var hinting = null;
  function hints(){
    if (hinting || root.classList.contains('is-matrix')) return;
    var title = document.getElementById('homeHeroTitle') || document.querySelector('.wordmark');
    if (!title) return;
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches, timers = [];
    var later = function(f, ms){ timers.push(setTimeout(f, ms)); };
    hinting = { stop: function(){ timers.forEach(clearTimeout); title.classList.remove('is-hinted', 'is-glitch'); title.style.transform = ''; title.querySelectorAll('.mx-ghost').forEach(function(g){ g.remove(); }); title.removeEventListener('click', follow, true); title.removeAttribute('title'); hinting = null; } };
    title.classList.add('is-hinted');
    title.title = 'Follow it.';
    // The title, while hinting: into the Matrix (before its own click, which shows the sidebar).
    function follow(e){ e.preventDefault(); e.stopImmediatePropagation(); hinting.stop(); matrix(true, true); }
    title.addEventListener('click', follow, true);
    // 1. The title buzzes: two or three short bursts in which it jolts sideways, and slices of a green
    // copy and a dim copy of it (laid exactly over it) are pulled the other way. It stays legible.
    function glitch(){
      if (!hinting) return;
      if (still) { later(glitch, 10000); return; }
      var ghosts = ['mx-ghost is-a', 'mx-ghost is-b'].map(function(c){
        var g = document.createElement('span'); g.className = c; g.setAttribute('aria-hidden', 'true'); g.innerHTML = title.innerHTML;
        title.appendChild(g); return g;
      });
      title.classList.add('is-glitch');
      var bursts = 2 + Math.floor(Math.random() * 2), frames = 0;
      (function frame(){
        var on = frames % 9 < 6;   // six frames of buzz, three of rest, per burst
        var j = function(n){ return Math.round((Math.random() * 2 - 1) * n); };
        title.style.transform = on ? 'translateX(' + j(4) + 'px)' : '';
        ghosts.forEach(function(g, i){
          var top = Math.floor(Math.random() * 70), h = 8 + Math.floor(Math.random() * 30);
          g.style.clipPath = on ? 'inset(' + top + '% 0 ' + Math.max(0, 100 - top - h) + '% 0)' : 'inset(100% 0 0 0)';
          g.style.transform = on ? 'translateX(' + (i ? -1 : 1) * (3 + Math.abs(j(9))) + 'px)' : '';
        });
        if (++frames < bursts * 9) later(frame, 40 + Math.random() * 30);
        else { title.style.transform = ''; title.classList.remove('is-glitch'); ghosts.forEach(function(g){ g.remove(); }); later(glitch, 6000 + Math.random() * 6000); }
      })();
    }
    // 2. One stream of rain down one column of the page, as the Matrix's: fixed cells lit by the head.
    function trickle(){
      if (!hinting) return;
      if (!still) {
        var S = 20, rows = Math.ceil(innerHeight / S) + 1, cv = document.createElement('canvas'), cx = cv.getContext('2d'), d = window.devicePixelRatio || 1;
        cv.className = 'mx-trickle'; cv.setAttribute('aria-hidden', 'true');
        cv.width = S * d; cv.height = rows * S * d; cv.style.width = S + 'px'; cv.style.height = rows * S + 'px';
        cv.style.left = Math.round(Math.random() * (innerWidth - S)) + 'px';
        cx.setTransform(d, 0, 0, d, 0, 0); cx.textBaseline = 'top'; cx.textAlign = 'center';
        document.body.appendChild(cv);
        var c = rainColumn(rows, 1); c.decay = 0.93; c.heads.push({ y: 0, speed: 0.45 + Math.random() * 0.3, row: -1 });
        (function tick(){
          rainStep(c, false);
          cx.clearRect(0, 0, S, rows * S);
          rainDraw(cx, c, 0, S);
          if (c.heads.length || c.cells.some(function(x){ return x.b; })) later(tick, 33); else cv.remove();
        })();
      }
      later(trickle, 4000 + Math.random() * 6000);
    }
    // 3. The search box (signed in) types the hint, holds it, and gives its placeholder back.
    function whisper(){
      if (!hinting) return;
      var box = document.querySelector('.home-search .ms-input') || document.querySelector('.ms-input');
      if (!box || !box.offsetParent) { later(whisper, 15000); return; }
      var was = box.placeholder, line = 'Follow the white rabbit.', i = 0;
      (function key(){
        box.placeholder = line.slice(0, ++i);
        if (i < line.length) later(key, still ? 0 : 90 + Math.random() * 90);
        else later(function(){ box.placeholder = was; later(whisper, 30000); }, 6000);
      })();
    }
    glitch(); later(trickle, 1500); later(whisper, 3000);
  }
  function wakeCheck(){
    if (called || root.classList.contains('is-matrix')) return;
    var d = new Date();
    if (d.getHours() !== 1 || d.getMinutes() < 24 || d.getMinutes() > 29) return;
    called = true;
    if (Date.now() - lastActive >= IDLE) converse(); else if (isHome()) hints();
  }
  setInterval(wakeCheck, 5000);
  // To try it at another hour, in the console: BoldEggs.wake('hints') or BoldEggs.wake('idle').
  window.BoldEggs = { wake: function(how){ if (how === 'idle') converse(); else hints(); }, brain: null };

  function start(){ watch(); birthday(); if (root.classList.contains('is-matrix')) matrix(true); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
