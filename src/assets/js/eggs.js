// Easter eggs, on every page (base.njk). None of them writes, messages or tells anyone:
// they only change what this page shows, until it's reloaded. The others live where they
// belong: the 404 page (404.njk), `sudo` in search (pages/search.js), the lamp theme
// (mountTheme, bold.js), the deadline's shiver (markdown.js), the Lineage engraving
// (pages/network.js) and \bold in KaTeX (card-model.js).
// Here: the console, Reviewer 2, milestone numbers, the birthday, the Matrix (`redpill`) and the masthead's
// cat at inbox zero.
// Their styles are at the end of bold.css.
(function(){
  var root = document.documentElement;

  // Devtools: a hello for whoever reads the source.
  try {
    console.log('%c\n ██████  ███████     ██████   ██████  ██      ██████\n ██   ██ ██          ██   ██ ██    ██ ██      ██   ██\n ██████  █████       ██████  ██    ██ ██      ██   ██\n ██   ██ ██          ██   ██ ██    ██ ██      ██   ██\n ██████  ███████     ██████   ██████  ███████ ██████\n',
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
      pill.type = 'button'; pill.className = 'mx-pill';
      pill.setAttribute('aria-label', 'Take the blue pill'); pill.title = 'Take the blue pill';   // just the pill, no words
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
      st.stage = 'choice';   // whatever they say: the punchline, and on
      return R(['Reviewer 2, who thinks you should have cited [47].', 'Now. Red pill, or blue pill?']);
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
  // Knocks on a wooden door, one at each of `at` ([seconds from now, strength]), made here (synthThuds, KNOCK);
  // KNOCK.recorded > 0 adds a recorded one over it (assets/audio/knock.mp3, cut from Freesound #256513, CC0;
  // on, at 1). Silent until the page has had a click or a key (audioCtx).
  var audio = null, knockBuf = null, knockLoad = null;
  function loadKnock(){
    if (knockLoad || !audio) return knockLoad || Promise.resolve(null);
    knockLoad = fetch('assets/audio/knock.mp3').then(function(r){ if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(function(b){ return new Promise(function(ok, no){ audio.decodeAudioData(b, ok, no); }); })
      .then(function(buf){ knockBuf = buf; return buf; }, function(){ return null; });
    return knockLoad;
  }
  // The page's audio, made only once the page has had a click or a key (browsers refuse it before:
  // the 01:24 call, or BoldEggs.wake from the console), else null; the first one after makes it.
  function audioCtx(){
    if (audio) return audio;
    var AC = window.AudioContext || window.webkitAudioContext, ua = navigator.userActivation;
    if (!AC || (ua && !ua.hasBeenActive)) return null;
    try { audio = new AC(); } catch (e){ return null; }
    return audio;
  }
  ['pointerdown', 'keydown'].forEach(function(t){
    addEventListener(t, function(){
      if (!document.querySelector('.mx-term')) return;
      var a = audioCtx();
      if (a) { if (a.state === 'suspended') a.resume(); loadKnock(); }
    }, { capture: true, passive: true });
  });
  // The blip of each letter as it appears, as on the film's screen: a very short, high chirp, made here
  // from a few pure tones (strongest near 9.2 and 5.7 kHz, fainter ones between), an even rise, a
  // short peak, then a fade, gone in ~15 ms, with a touch of noise around the same pitches (noise). Each letter's a little different (level, length; the pitch barely), as
  // a real one is; the pitch holds steady. Only once sound is allowed (audioCtx), never before. BLIP.tones: [Hz, relative level];
  // BLIP.noise: how much of the noise, against the tones;
  // BLIP.hold: how much of it stays at full level before it ends (0.3: fades away, 0.9: stops dead).
  var BLIP = { tones: [[9250, 1], [5700, 0.75], [6350, 0.3], [6950, 0.25], [10000, 0.3]], s: 0.015, level: 0.08, noise: 0.2, hold: 0.4, attack: 0.003 };
  var blipNoise = null;
  function tick(){
    try {
      if (!audio || audio.state !== 'running') return;
      var t = audio.currentTime, len = BLIP.s * (0.95 + Math.random() * 0.1), lv = BLIP.level * (0.9 + Math.random() * 0.2);
      var pitch = 1 + (Math.random() - 0.5) * 0.008, g = audio.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lv, t + BLIP.attack);   // an even rise, as the clip's (~3 ms)
      g.gain.setValueAtTime(lv, t + len * BLIP.hold); g.gain.exponentialRampToValueAtTime(0.0001, t + len);   // the peak, then the fade
      g.connect(audio.destination);
      BLIP.tones.forEach(function(x){
        var o = audio.createOscillator(), v = audio.createGain(), hz = x[0] * pitch;
        o.type = 'sine'; o.frequency.value = hz;
        v.gain.value = x[1] * (1 - BLIP.noise * 0.5);
        o.connect(v); v.connect(g); o.start(t); o.stop(t + len + 0.01);
      });
      if (BLIP.noise > 0) {
        if (!blipNoise) {
          blipNoise = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.06), audio.sampleRate);
          var d = blipNoise.getChannelData(0);
          for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        }
        [[9250, 1], [5700, 0.7]].forEach(function(x){
          var n = audio.createBufferSource(), f = audio.createBiquadFilter(), v = audio.createGain();
          n.buffer = blipNoise; f.type = 'bandpass'; f.frequency.value = x[0] * pitch; f.Q.value = 6; v.gain.value = x[1] * BLIP.noise * 6;
          n.connect(f); f.connect(v); v.connect(g); n.start(t, Math.random() * 0.03, len + 0.01);
        });
      }
    } catch (e){}
  }
  // The two knocks, KNOCK KNOCK: [seconds from the start, strength], 330 ms apart and the second ~1 dB softer, as in the reference, on mx-knock's 9% and 50% of .8s (bold.css).
  var KNOCKS = [[0.072, 1], [0.402, 0.9]];
  function thuds(at){
    try {
      if (!audioCtx() || audio.state !== 'running') return;
      var now = audio.currentTime;
      var play = function(buf){
        var base = Math.max(now, audio.currentTime);   // late (still loading): both knocks move, keeping their gap
        synthThuds(at, base, KNOCK.level);
        if (!buf || !KNOCK.recorded) return;
        var g = audio.createGain(); g.gain.value = KNOCK.recorded; g.connect(audio.destination);
        at.forEach(function(k){ var n = audio.createBufferSource(), v = audio.createGain(); v.gain.value = k[1]; n.buffer = buf; n.connect(v); v.connect(g); n.start(base + k[0]); });
      };
      if (knockBuf) play(knockBuf); else loadKnock().then(play);
    } catch (e){}
  }
  // Made here, from a reference knock's measurements (2026-11-06): the body low, 100-250 Hz (strongest near
  // 150-200), dying away over ~150 ms; the wood, a band around 600-900 Hz, gone sooner; a touch up to
  // ~1.6 kHz; a hit: at full at once (attack, 0.5 ms). KNOCK.body: [from Hz, to Hz, decay s, level]; KNOCK.wood: [Hz, Q, decay s, level].
  var KNOCK = { body: [[220, 140, 0.15, 1], [150, 105, 0.2, 0.7]], wood: [[750, 1.8, 0.06, 0.5], [1500, 1.5, 0.025, 0.15]], attack: 0.0005, level: 0.9, recorded: 1, room: 0.3, roomS: 0.6 };
  // The room: its echo made here (fading noise, the highs fading first), roomS long, mixed in at `room`.
  var roomIr = null;
  function roomOf(){
    if (roomIr && roomIr.s === KNOCK.roomS) return roomIr.buf;
    var len = Math.floor(audio.sampleRate * KNOCK.roomS), buf = audio.createBuffer(2, len, audio.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c), last = 0;
      for (var i = 0; i < len; i++) {
        var x = i / len, soft = 0.3 + 0.65 * x;   // later, duller: a gentle low-pass that closes over the tail
        last = last * soft + (Math.random() * 2 - 1) * (1 - soft);
        d[i] = last * Math.pow(1 - x, 2.5) * 3;
      }
    }
    roomIr = { s: KNOCK.roomS, buf: buf };
    return buf;
  }
  function synthThuds(at, now, level){
    try {
      var out = audio.createGain();
      out.gain.value = level; out.connect(audio.destination);
      if (KNOCK.room > 0) {
        var verb = audio.createConvolver(), wet = audio.createGain();
        verb.buffer = roomOf(); wet.gain.value = KNOCK.room;
        out.connect(verb); verb.connect(wet); wet.connect(audio.destination);
      }
      var noise = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.1), audio.sampleRate), d = noise.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      var env = function(g, peak, t, decay){
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + KNOCK.attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + KNOCK.attack + decay);
      };
      at.forEach(function(k){
        var t = now + k[0];
        KNOCK.body.forEach(function(b){
          var o = audio.createOscillator(), g = audio.createGain();
          o.type = 'sine'; o.frequency.setValueAtTime(b[0], t); o.frequency.exponentialRampToValueAtTime(b[1], t + b[2]);
          env(g, b[3] * k[1], t, b[2]);
          o.connect(g); g.connect(out); o.start(t); o.stop(t + KNOCK.attack + b[2] + 0.02);
        });
        KNOCK.wood.forEach(function(w){
          var n = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
          n.buffer = noise; f.type = 'bandpass'; f.frequency.value = w[0]; f.Q.value = w[1];
          env(g, w[3] * k[1] * 4, t, w[2]);   // a narrow band of noise is quiet: brought up to sit with the body
          n.connect(f); f.connect(g); g.connect(out); n.start(t, 0, KNOCK.attack + w[2] + 0.02);
        });
      });
    } catch (e){}
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
    // The next line waits for you: a click, a tap or a key, once its line has been held.
    var waiting = null;
    function stir(){ if (waiting) { var go = waiting; waiting = null; setTimeout(go, 300 + Math.random() * 300); } }   // a beat first, 0.3-0.6 s
    ['pointerdown', 'keydown'].forEach(function(t){ addEventListener(t, stir, { passive: true }); });
    function close(){
      if (game && game.timer) clearTimeout(game.timer);
      waiting = null;
      ['pointerdown', 'keydown'].forEach(function(t){ removeEventListener(t, stir); });
      term.classList.add('is-gone'); setTimeout(function(){ term.remove(); }, 600);
    }
    // As in the film: each line alone on the screen, typed at a person's uneven pace, the block cursor on
    // it, then the screen clears for the next. The last is held, then the prompt. A line is its text, or
    // [text, ms]: how long it's held (the cursor blinking on it). opts.lead: a blank screen with only the
    // cursor first; opts.wait: each line but the last left until you click or press a key (stir), for the
    // opening; otherwise they move on by themselves, once there's been time to read them; opts.instant:
    // shown at once, one under another, without waiting (the game's words).
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
        if (k > 0 && !quick) log.innerHTML = '';   // alone on the screen
        var p = k === 0 && first ? first : document.createElement('p');
        if (!p.parentNode) log.appendChild(p);
        if (quick) { p.textContent = text; line(k + 1); return; }
        (function key(){
          p.textContent = text.slice(0, ++i);
          if (text[i - 1] !== ' ') tick();
          if (i >= text.length) {
            // The last line: held, then the prompt (or what comes next). Any other, in the opening: it waits
            // for you, from the moment it's typed (a click during a hold isn't lost); in replies, it's held
            // long enough to read (nothing to answer), then the next.
            var go = function(){ line(k + 1); };
            if (k + 1 >= job.lines.length) setTimeout(go, hold);
            else if (job.opts.wait) waiting = go;
            else setTimeout(go, typeof l === 'string' ? Math.max(1400, text.length * 50) : hold);
            return;
          }
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
    // A knock at the door: the screen thuds twice, and two knocks are heard with the thuds (KNOCKS).
    function knock(){ thuds(KNOCKS); if (!still) { term.classList.add('is-knocked'); setTimeout(function(){ term.classList.remove('is-knocked'); }, 800); } next(); }
    var who = st.name || 'BOLD';
    // The film's beats: a blank screen first, each line left to sink in; after the knock, it's your turn.
    function opening(){
      if (audioCtx()) { if (audio.state === 'suspended') audio.resume(); loadKnock(); }   // the knock's sound loads now, well before it
      say([['Wake up, ' + who + '...', 3500], ['The BOLD.OS has you...', 3500], ['Follow the white rabbit.', 3000], ['Knock, knock, ' + who + '.', 400]], knock, { lead: 1500, wait: true });
    }
    // Always a blank screen first, only the cursor blinking, until you click or press a key: then
    // "Wake up". That click or key also lets the browser play sound, so every blip and knock is heard.
    // Armed a moment later, so the key that opened it (redpill's last letter, still on its way) isn't it.
    log.innerHTML = '<p></p>'; setTimeout(function(){ waiting = opening; }, 0);
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
  // A still of the whole screen's rain mid-fall (the hints' dropped frame): columns run on, then drawn once.
  function rainFrame(){
    var cv = document.createElement('canvas'), cx = cv.getContext('2d'), d = window.devicePixelRatio || 1, S = 18;
    var W = innerWidth, H = innerHeight, rows = Math.ceil(H / S) + 1, cols = [];
    cv.className = 'mx-frame'; cv.setAttribute('aria-hidden', 'true');
    cv.width = W * d; cv.height = H * d; cx.setTransform(d, 0, 0, d, 0, 0);
    for (var x = 0; x < Math.ceil(W / S); x++){
      var c = rainColumn(rows, Math.random() < 0.3 ? 0.55 : 1);
      c.heads.push(rainHead(c, true)); if (Math.random() < 0.35) c.heads.push(rainHead(c, true));
      for (var k = 0; k < 50; k++) rainStep(c, true);
      cols.push(c);
    }
    cx.fillStyle = '#030a06'; cx.fillRect(0, 0, W, H);
    cx.textBaseline = 'top'; cx.textAlign = 'center';
    cols.forEach(function(c, x){ rainDraw(cx, c, x * S, S); });
    document.body.appendChild(cv);
    return cv;
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
  // the homepage, hints (below), and searching with the hint in the box goes into the Matrix.
  // From 01:24 to 01:29 (a background tab's timers may run only once a minute), once a page.
  var IDLE = 30 * 60e3, lastActive = Date.now(), called = false;
  ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function(t){
    addEventListener(t, function(){ lastActive = Date.now(); }, { passive: true, capture: true });
  });
  function isHome(){ var p = location.pathname; return /\/$/.test(p) || /\/index\.html$/.test(p); }
  // Hints, as the film gives them, on the homepage until you follow them: now and then the screen drops a
  // frame of the rain, and the search box types "Follow the white rabbit." and keeps it. Searching then, with
  // the hint in the box (Enter on it empty, or a search with "rabbit" in it), goes into the Matrix; any
  // other search is an ordinary one.
  var hinting = null;
  function hints(){
    if (hinting || root.classList.contains('is-matrix')) return;
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches, timers = [], box = null, was = '', ready = false;
    var later = function(f, ms){ timers.push(setTimeout(f, ms)); };
    hinting = { stop: function(){
      timers.forEach(clearTimeout);
      if (box) box.placeholder = was;
      document.removeEventListener('keydown', follow, true); document.removeEventListener('submit', follow, true);
      hinting = null;
    } };
    // Before the search box's own Enter (search-box.js), as the page's first listener.
    function follow(e){
      if (!ready || !box || e.target !== box && e.target !== box.form) return;
      if (e.type === 'keydown' && e.key !== 'Enter') return;
      var q = box.value.trim();
      if (q && !/rabbit/i.test(q)) return;   // an ordinary search
      e.preventDefault(); e.stopImmediatePropagation();
      box.value = ''; box.blur();
      hinting.stop(); matrix(true, true);
    }
    document.addEventListener('keydown', follow, true);
    document.addEventListener('submit', follow, true);
    // 1. A dropped frame: for a tenth of a second, twice, the whole screen is a still of the rain mid-fall
    // (the second a little off, like a skipped frame), then the page again. Two dark flashes, under the
    // three-a-second limit for flashing; none with reduced motion.
    function flicker(){
      if (!hinting) return;
      if (!still) {
        var cv = rainFrame();
        var show = function(on, dx){ cv.style.visibility = on ? 'visible' : 'hidden'; cv.style.transform = dx ? 'translateX(' + dx + 'px)' : ''; };
        show(true, 0);
        later(function(){ show(false); }, 90);
        later(function(){ show(true, -6); }, 170);
        later(function(){ cv.remove(); }, 230);
      }
      later(flicker, 20000 + Math.random() * 20000);
    }
    // 2. The search box (shown when signed in) types the hint once and keeps it.
    function whisper(){
      if (!hinting) return;
      box = document.querySelector('.home-search .ms-input') || document.querySelector('.ms-input');
      if (!box || !box.offsetParent) { box = null; later(whisper, 5000); return; }
      was = box.placeholder;
      var line = 'Follow the white rabbit.', i = 0;
      (function key(){
        box.placeholder = line.slice(0, ++i);
        if (i < line.length) later(key, still ? 0 : 90 + Math.random() * 90);
        else ready = true;
      })();
    }
    later(whisper, 3000); later(flicker, 6000);
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
  // BoldEggs.knock(): the knock's two knocks alone (click the page once first: browsers want that for sound).
  window.BoldEggs = { wake: function(how){ if (how === 'idle') converse(); else hints(); }, brain: null,
    // BoldEggs.blip(): one letter's blip; BoldEggs.blip({ s: 0.03, level: 0.12, noise: 0.8, hold: 0.9, attack: 0.005 }) changes it first.
    blip: function(o){ if (o) Object.assign(BLIP, o); var a = audioCtx(); if (!a) return 'Click the page once first.'; (a.state === 'suspended' ? a.resume() : Promise.resolve()).then(tick); return BLIP; },
    // BoldEggs.knock(): the two knocks; BoldEggs.knock({ level: 1, room: 0.5, roomS: 0.9 }) changes them first (KNOCK).
    cat: function(){ catVisit(true); return 'Here, kitty.'; },
    knock: function(o){
      if (o) Object.assign(KNOCK, o);
      var a = audioCtx();
      if (!a) return 'Click the page once first: browsers play sound only after a click or a key.';
      (a.state === 'suspended' ? a.resume() : Promise.resolve()).then(function(){ return loadKnock(); }).then(function(){ thuds(KNOCKS); });
      return 'Knock, knock.';
    } };

  // Inbox zero: a cat in the masthead. Now and then, when nothing is waiting or unread, it walks in along the
  // masthead's floor, sits, curls up asleep for a while, then walks off; it leaves early if something comes
  // in. Our own pixel art (16x7, drawn on a canvas in the theme's colours); it never takes a click. At most
  // once every 10 minutes, half the times it could. BoldEggs.cat() calls it now.
  var CAT_ART = {
    walk1: ['............k..k', '............kkkk', '.k..........kekk', '..k.kkkkkkkkkkkk', '...kkkkkkkkkkkk.', '....kkkkkkkkkkk.', '....k.k....k.k..'],
    walk2: ['............k..k', '............kkkk', '.k..........kekk', '..k.kkkkkkkkkkkk', '...kkkkkkkkkkkk.', '....kkkkkkkkkkk.', '.....k.k..k.k...'],
    sit: ['..........k..k..', '..........kkkk..', '..........kekk..', '........kkkkkk..', '.k.....kkkkkkk..', '..k...kkkkkkkk..', '...kkkkkkkk.kk..'],
    blink: ['..........k..k..', '..........kkkk..', '..........kkkk..', '........kkkkkk..', '.k.....kkkkkkk..', '..k...kkkkkkkk..', '...kkkkkkkk.kk..'],
    sleep: ['................', '................', '..........k..k..', '..........kkkk..', '....kkkkkkkkkkk.', '..kkkkkkkkkkkkk.', '.kkkkkkkkkkkkkk.'],
    sleep2: ['................', '................', '..........k..k..', '..........kkkk..', '....kkkkkkkkkkk.', '..kkkkkkkkkkkkk.', 'kkkkkkkkkkkkkkk.'],
  };
  var CAT_PX = 3, catOn = false, catLast = 0;
  try { catLast = Number(localStorage.getItem('boldCatAt')) || 0; } catch (e){}
  function catVisit(force){
    var mast = document.getElementById('masthead');
    if (catOn || !mast || mast.hidden || root.classList.contains('is-matrix')) return;
    if (!force && (Date.now() - catLast < 10 * 60e3)) return;
    catOn = true; catLast = Date.now();
    try { localStorage.setItem('boldCatAt', String(catLast)); } catch (e){}
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var lane = document.createElement('div'), el = document.createElement('div'), cv = document.createElement('canvas');
    lane.className = 'mast-cat-lane'; lane.setAttribute('aria-hidden', 'true');
    el.className = 'mast-cat'; cv.width = 16 * CAT_PX; cv.height = 7 * CAT_PX;
    el.appendChild(cv); lane.appendChild(el); mast.appendChild(lane);
    var ctx = cv.getContext('2d'), css = getComputedStyle(root);
    function draw(name){
      var ink = css.getPropertyValue('--muted').trim() || '#888', eye = css.getPropertyValue('--paper').trim() || '#fff';
      ctx.clearRect(0, 0, cv.width, cv.height);
      CAT_ART[name].forEach(function(row, y){
        for (var x = 0; x < row.length; x++) {
          var c = row[x]; if (c === '.') continue;
          ctx.fillStyle = c === 'e' ? eye : ink; ctx.fillRect(x * CAT_PX, y * CAT_PX, CAT_PX, CAT_PX);
        }
      });
    }
    var W = lane.clientWidth, w = cv.width, fromLeft = Math.random() < 0.5;
    // A short walk in: it settles 40-220 px from the side it came from.
    var walkIn = Math.round(Math.min(220, Math.max(40, W * (0.04 + Math.random() * 0.14))));
    var x = fromLeft ? -w : W, spot = fromLeft ? walkIn : W - w - walkIn, step = 0, timer = null, zs = null, leaving = false;
    function place(){ el.style.transform = 'translateX(' + Math.round(x) + 'px)'; }
    function face(left){ el.classList.toggle('is-left', left); }
    function zzz(on){
      if (on && !zs) { zs = ['z', 'z', 'Z'].map(function(t){ var z = document.createElement('span'); z.className = 'mast-cat-z'; z.textContent = t; el.appendChild(z); return z; }); }
      if (!on && zs) { zs.forEach(function(z){ z.remove(); }); zs = null; }
    }
    // Walks to `to`, then does `then`; a step every 140 ms, 4 px a step (twice as fast leaving in a hurry).
    function walk(to, then, hurry){
      clearTimeout(timer); zzz(false); face(to < x);
      if (still) { x = to; place(); return then(); }
      (function go(){
        var d = to - x, v = (hurry ? 8 : 4) * Math.sign(d);
        if (Math.abs(d) <= Math.abs(v)) { x = to; place(); return then(); }
        x += v; place(); draw(step++ % 2 ? 'walk2' : 'walk1');
        timer = setTimeout(go, 140);
      })();
    }
    function gone(){ clearTimeout(timer); document.removeEventListener('bold:bell', onBell); lane.remove(); catOn = false; }
    function leave(hurry){
      if (leaving) return; leaving = true;
      var out = x + w / 2 < W / 2 ? -w : W;
      if (still) { el.style.opacity = '0'; return setTimeout(gone, 700); }
      walk(out, gone, hurry);
    }
    function onBell(e){ if (e.detail && e.detail.n > 0) leave(true); }   // something came in: off it goes
    document.addEventListener('bold:bell', onBell);
    // Sits a few seconds (blinking now and then), sleeps 10-20 s (breathing, zzz), sits up, leaves.
    function sit(ms, then){
      draw('sit'); var end = Date.now() + ms;
      (function look(){
        if (leaving) return;
        if (Date.now() >= end) return then();
        draw(Math.random() < 0.15 ? 'blink' : 'sit');
        timer = setTimeout(function(){ draw('sit'); timer = setTimeout(look, 600 + Math.random() * 900); }, 160);
      })();
    }
    function sleep(ms, then){
      zzz(true); var end = Date.now() + ms, n = 0;
      (function breathe(){
        if (leaving) return;
        if (Date.now() >= end) { zzz(false); return then(); }
        draw(n++ % 2 ? 'sleep2' : 'sleep'); timer = setTimeout(breathe, 1100);
      })();
    }
    if (still) { el.style.opacity = '0'; x = spot; place(); draw('sleep'); requestAnimationFrame(function(){ el.style.opacity = '1'; }); }
    else place();
    walk(spot, function(){ sit(2500 + Math.random() * 2500, function(){ sleep(10000 + Math.random() * 10000, function(){ sit(1500, function(){ leave(false); }); }); }); });
  }
  // Called when the inbox is empty: half the time, 5-25 s later, if it's still empty then.
  var catPending = null;
  function catCheck(){
    var b = window.BOLD && BOLD.bell;
    if (!b || !b.ready || b.n > 0) { clearTimeout(catPending); catPending = null; return; }
    if (catPending || catOn || Date.now() - catLast < 10 * 60e3 || catCheck.rolled) return;
    catCheck.rolled = true;
    if (Math.random() >= 0.5) return;
    catPending = setTimeout(function(){ catPending = null; var b2 = BOLD.bell; if (b2 && b2.ready && !b2.n) catVisit(); }, 5000 + Math.random() * 20000);
  }
  document.addEventListener('bold:bell', catCheck);

  function start(){ watch(); birthday(); catCheck(); if (root.classList.contains("is-matrix")) matrix(true); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
