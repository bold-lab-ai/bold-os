// Search ranking, shared by the site's search page (pages/search.js) and the agents'
// search tool (functions/api.js; firebase.json's predeploy copies this file there).
// Items are { title, where, text }. A query word matches a whole word, or the start of
// one when it has 3 letters or more ("agent" finds "agents", "rl" never finds "world"),
// accents and British/American spellings folded ("generalisation" = "generalization"),
// with a few lab abbreviations ("rl" = "reinforcement learning"). Filler words ("a",
// "the", "how") are left out unless that leaves nothing. Every word must match; if none
// does, the items matching most of them come back marked `partial`. Ranking: where each
// word matched (title over section over text, rarer words counting more), the whole
// phrase in the title or text, and a title that is the query.
(function(root){
  var STOP = ['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'how', 'do', 'does', 'i', 'my',
    'me', 'we', 'our', 'with', 'at', 'by', 'what', 'can', 'it', 'as', 'from', 'about', 'into', 'should', 'when', 'where', 'who'];
  // Each set: spellings of one thing, any of which finds the others.
  var SAME = [
    ['rl', 'reinforcement learning'], ['marl', 'multi agent reinforcement learning'], ['llm', 'large language model'],
    ['ml', 'machine learning'], ['ai', 'artificial intelligence'], ['nlp', 'natural language processing'],
    ['ued', 'unsupervised environment design'], ['cot', 'chain of thought'], ['phd', 'dphil'],
    ['bold os', 'boldos', 'bold.os'], ['os', 'operating system'], ['vacation', 'holiday'], ['hrl', 'hierarchical reinforcement learning'],
  ];
  var FIELDS = [['title', 6], ['where', 2], ['text', 1]];

  // Lower case, accents off, one character for one, so positions still point into the original.
  function foldChars(s){
    s = String(s || '');
    var out = '';
    for (var i = 0; i < s.length; i++){
      var c = s[i], f = c.normalize ? c.normalize('NFKD').replace(/[̀-ͯ]/g, '') : c;
      out += (f.length === 1 ? f : c).toLowerCase();
    }
    return out;
  }
  function stem(w){
    w = w.replace(/isation/g, 'ization').replace(/ise(d|s)?$/, 'ize$1').replace(/yse$/, 'yze').replace(/our$/, 'or');
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
    return w;
  }
  // The words of a text: { w (stemmed), at, end } in the original's positions.
  function tokens(text){
    var f = foldChars(text), re = /[a-z0-9]+/g, m, out = [];
    while ((m = re.exec(f))) out.push({ w: stem(m[0]), at: m.index, end: m.index + m[0].length });
    return out;
  }
  function words(s){ return tokens(s).map(function(t){ return t.w; }); }

  // A query: each word with its alternatives (each a run of words), and the phrase.
  function prepare(query){
    var all = words(query), kept = all.filter(function(w){ return STOP.indexOf(w) === -1; });
    if (!kept.length) kept = all;
    var joined = ' ' + all.join(' ') + ' ', used = {};
    var terms = [];
    // A multi-word spelling in the query ("reinforcement learning") counts as one term.
    SAME.forEach(function(set){
      set.forEach(function(sp){
        var ws = words(sp);
        if (ws.length > 1 && joined.indexOf(' ' + ws.join(' ') + ' ') !== -1 && !ws.some(function(w){ return used[w]; })){
          ws.forEach(function(w){ used[w] = true; });
          terms.push({ alts: set.map(words) });
        }
      });
    });
    kept.forEach(function(w){
      if (used[w]) return;
      used[w] = true;
      var set = SAME.filter(function(s){ return s.some(function(sp){ var ws = words(sp); return ws.length === 1 && ws[0] === w; }); })[0];
      terms.push({ alts: set ? set.map(words) : [[w]] });
    });
    return { terms: terms, phrase: all.join(' '), raw: String(query || '').trim() };
  }

  // Where the term matches in a list of words: { exact } or null.
  function find(toks, term){
    var best = null;
    term.alts.forEach(function(run){
      for (var i = 0; i + run.length <= toks.length; i++){
        var ok = true, exact = true;
        for (var j = 0; j < run.length && ok; j++){
          var d = toks[i + j].w, q = run[j];
          if (d === q) continue;
          exact = false;
          ok = q.length >= 3 && j === run.length - 1 && d.indexOf(q) === 0;
        }
        if (ok){ if (exact) return (best = { exact: true, at: i, len: run.length }); if (!best) best = { exact: false, at: i, len: run.length }; }
      }
    });
    return best;
  }
  function prepped(it){
    if (!it._sr) it._sr = { title: tokens(it.title), where: tokens(it.where), text: tokens(it.text) };
    return it._sr;
  }
  function count(toks, term){ var n = 0; term.alts.forEach(function(run){ toks.forEach(function(t){ if (t.w === run[0] || (run[0].length >= 3 && t.w.indexOf(run[0]) === 0)) n++; }); }); return n; }

  // items → [{ item, score, partial }], best first; [] for an empty query.
  function rank(items, query){
    var p = typeof query === 'string' ? prepare(query) : query;
    if (!p.terms.length) return [];
    var hitsBy = items.map(function(it){
      var tk = prepped(it);
      return p.terms.map(function(term){
        for (var f = 0; f < FIELDS.length; f++){ var h = find(tk[FIELDS[f][0]], term); if (h) return { field: f, exact: h.exact }; }
        return null;
      });
    });
    // Rarer terms count more.
    var n = items.length, idf = p.terms.map(function(term, k){
      var df = hitsBy.filter(function(hs){ return hs[k]; }).length;
      return Math.log(1 + n / (1 + df));
    });
    var phrase = p.terms.length > 1 ? ' ' + p.phrase + ' ' : '';
    function score(it, hs){
      var tk = prepped(it), s = 0;
      hs.forEach(function(h, k){
        if (!h) return;
        var tf = count(tk.text, p.terms[k]);
        s += idf[k] * (FIELDS[h.field][1] * (h.exact ? 1 : 0.7) + Math.min(1, tf / (tf + 1 + tk.text.length / 400)));
      });
      var title = ' ' + tk.title.map(function(t){ return t.w; }).join(' ') + ' ';
      if (title.trim() === p.phrase) s += 20;
      else if (phrase && title.indexOf(phrase) !== -1) s += 10;
      else if (phrase && (' ' + tk.text.map(function(t){ return t.w; }).join(' ') + ' ').indexOf(phrase) !== -1) s += 4;
      return s;
    }
    var full = [];
    hitsBy.forEach(function(hs, i){ if (hs.every(Boolean)) full.push({ item: items[i], score: score(items[i], hs), partial: false }); });
    if (full.length || p.terms.length < 2) return full.sort(function(a, b){ return b.score - a.score; });
    // Nothing has every word: those with the most of them (at least half).
    var most = Math.max.apply(null, hitsBy.map(function(hs){ return hs.filter(Boolean).length; }));
    if (most < Math.ceil(p.terms.length / 2)) return [];
    return hitsBy.map(function(hs, i){ return hs.filter(Boolean).length === most ? { item: items[i], score: score(items[i], hs), partial: true } : null; })
      .filter(Boolean).sort(function(a, b){ return b.score - a.score; });
  }

  // The [at, end) spans of a text where a query term matches.
  function spans(text, query){
    var p = typeof query === 'string' ? prepare(query) : query, toks = tokens(text), out = [];
    p.terms.forEach(function(term){
      term.alts.forEach(function(run){
        for (var i = 0; i + run.length <= toks.length; i++){
          var ok = true;
          for (var j = 0; j < run.length && ok; j++){ var d = toks[i + j].w, q = run[j]; ok = d === q || (q.length >= 3 && j === run.length - 1 && d.indexOf(q) === 0); }
          if (ok) out.push([toks[i].at, toks[i + run.length - 1].end]);
        }
      });
    });
    return out.sort(function(a, b){ return a[0] - b[0]; }).filter(function(s, i, all){ return !i || s[0] >= all[i - 1][1]; });
  }
  // Text with its matches wrapped by mark(s); the rest through esc.
  function highlight(text, query, esc, mark){
    text = String(text || '');
    var out = '', from = 0;
    spans(text, query).forEach(function(s){ out += esc(text.slice(from, s[0])) + mark(esc(text.slice(s[0], s[1]))); from = s[1]; });
    return out + esc(text.slice(from));
  }
  // About `len` characters around the first match.
  function snippet(text, query, len){
    text = String(text || ''); len = len || 240;
    var s = spans(text, query)[0];
    if (!s) return text.length > len ? text.slice(0, len) + '…' : text;
    var from = Math.max(0, s[0] - Math.round(len / 3)), to = Math.min(text.length, from + len);
    if (from) { var sp = text.indexOf(' ', from); if (sp !== -1 && sp < s[0]) from = sp + 1; }
    return (from ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
  }

  var api = { prepare: prepare, rank: rank, spans: spans, highlight: highlight, snippet: snippet, tokens: tokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BoldSearchRank = api;
})(typeof window !== 'undefined' ? window : this);
