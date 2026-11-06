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
  function matrix(on, intro){
    try { console.log(on ? '[BOLD] Wake up.' : '[BOLD] Blue pill.'); } catch (e){}
    root.classList.toggle('is-matrix', on);
    try { if (on) localStorage.setItem('boldMatrix', '1'); else localStorage.removeItem('boldMatrix'); } catch (e){}
    if (!on) {
      if (rain) { rain.stop(); rain = null; }
      document.querySelectorAll('.mx-pill, .mx-wake').forEach(function(n){ n.remove(); });
      return;
    }
    if (!document.querySelector('.mx-pill')) {
      var pill = document.createElement('button');
      pill.type = 'button'; pill.className = 'mx-pill'; pill.textContent = 'Take the blue pill';
      pill.addEventListener('click', function(){ matrix(false); });
      document.body.appendChild(pill);
    }
    if (!rain) rain = startRain();
    if (intro) wake();
  }
  function wake(){
    var w = document.createElement('div'), line = 'Wake up, BOLD…', i = 0;
    w.className = 'mx-wake'; w.setAttribute('aria-hidden', 'true');
    document.body.appendChild(w);
    var t = setInterval(function(){
      w.textContent = line.slice(0, ++i);
      if (i >= line.length) { clearInterval(t); setTimeout(function(){ w.classList.add('is-gone'); setTimeout(function(){ w.remove(); }, 800); }, 1200); }
    }, 90);
  }
  function startRain(){
    var cv = document.createElement('canvas'), cx = cv.getContext('2d');
    cv.className = 'mx-rain'; cv.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(cv, document.body.firstChild);
    var GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789BOLD∇∑∂λθ', S = 16, drops = [], frame = 0, last = 0;
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function size(){
      var d = window.devicePixelRatio || 1;
      cv.width = innerWidth * d; cv.height = innerHeight * d; cx.setTransform(d, 0, 0, d, 0, 0);
      drops = []; for (var c = 0; c < Math.ceil(innerWidth / S); c++) drops.push(Math.random() * -innerHeight / S);
      cx.fillStyle = '#000'; cx.fillRect(0, 0, innerWidth, innerHeight);
    }
    function draw(){
      cx.fillStyle = 'rgba(0,0,0,0.08)'; cx.fillRect(0, 0, innerWidth, innerHeight);
      cx.font = S + 'px ui-monospace, Menlo, monospace';
      drops.forEach(function(y, c){
        var ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        cx.fillStyle = Math.random() < 0.04 ? '#d8ffe4' : '#2bff6a';
        cx.fillText(ch, c * S, y * S);
        drops[c] = y * S > innerHeight && Math.random() > 0.975 ? 0 : y + 1;
      });
    }
    function loop(t){ frame = requestAnimationFrame(loop); if (t - last < 50) return; last = t; draw(); }
    size();
    if (still) { for (var k = 0; k < 60; k++) draw(); } else frame = requestAnimationFrame(loop);
    addEventListener('resize', size);
    return { stop: function(){ cancelAnimationFrame(frame); removeEventListener('resize', size); cv.remove(); } };
  }
  document.addEventListener('keydown', function(e){
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === ' ') return;   // "red pill" counts too
    typed = (typed + e.key.toLowerCase()).slice(-8);
    if (/redpill$/.test(typed) && !root.classList.contains('is-matrix')) { typed = ''; matrix(true, true); }
    else if (/bluepill$/.test(typed) && root.classList.contains('is-matrix')) { typed = ''; matrix(false); }
  });
  addEventListener('storage', function(e){ if (e.key === 'boldMatrix') matrix(e.newValue === '1', false); });
  // For search (pages/search.js: `red pill`).
  window.BoldEggs = { matrix: function(on){ if (on !== root.classList.contains('is-matrix')) matrix(on, on); } };

  function start(){ watch(); birthday(); if (root.classList.contains('is-matrix')) matrix(true, false); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
