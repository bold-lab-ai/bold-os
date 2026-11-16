// Readable guide URLs, shared by the server and browser. Old URLs are reserved
// forever in headingAnchors; no content is edited or written by the renderer.
(function(root, make){
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.BoldGuideAnchors = make();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';
  function plain(text){
    return String(text || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*~`]/g, '').replace(/\\([\\!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
  }
  function slug(text){
    return plain(text).normalize('NFC').toLowerCase().trim()
      .replace(/[^\p{L}\p{M}\p{N}_ \-]/gu, '').replace(/ /g, '-') || 'heading';
  }
  function sectionSlug(s){
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  }
  var PHASE = /^(#{1,4})\s+(.*?)\s+·\s+(\d+[wd]|after)\s*$/;
  // Mirror the heading blocks supported by markdown.js (including quoted text,
  // but excluding fenced code, displayed maths, and indented list continuations).
  function headings(text){
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), out = [];
    var phases = lines.filter(function(l){ return PHASE.test(l); }).length;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], quote, m;
      if (/^```/.test(line)) { for (i++; i < lines.length && !/^```/.test(lines[i]); i++) {} continue; }
      if (/^\s*\$\$/.test(line)) {
        if (/^\s*\$\$[\s\S]+?\$\$\s*$/.test(line)) continue;
        for (i++; i < lines.length && !/\$\$\s*$/.test(lines[i]); i++) {} continue;
      }
      if (/^>\s?/.test(line)) {
        quote = [];
        for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
        i--; out = out.concat(headings(quote.join('\n'))); continue;
      }
      m = /^(#{1,4})\s+(.*)$/.exec(line);
      if (m) { var ph = phases > 1 && PHASE.exec(line), raw = ph ? ph[2] : m[2]; out.push({ raw: raw, text: plain(raw), phase: ph ? 'phase-' + raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '' }); }
    }
    return out;
  }
  function legacyHeadings(p){
    var used = Object.create(null);
    return headings(p.body).map(function(h){
      var base = p.id + '--' + (h.raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'heading');
      var id = base, n = 2;
      while (used[id]) id = base + '-' + n++;
      used[id] = true;
      return { text: h.text, legacy: id, phase: h.phase };
    });
  }
  function clone(v){ return JSON.parse(JSON.stringify(v)); }
  function token(section, fragment){ return JSON.stringify([section, fragment]); }
  function update(before, after, saved){
    before = before || []; after = after || [];
    // Bootstrap the old page before applying an edit, so its existing readable
    // links become aliases even if its first recorded change renames a heading.
    var old = saved && saved.version === 1 ? clone(saved) : before.length ? update([], before, null) : { version: 1, next: 1, entries: [] };
    var entries = old.entries, active = [], reserved = Object.create(null);
    entries.forEach(function(e){
      (e.aliases || []).forEach(function(a){ reserved[token(a.section, a.slug)] = e.key; });
    });
    function remember(e, section, fragment){
      if (!e.aliases.some(function(a){ return a.section === section && a.slug === fragment; })) e.aliases.push({ section: section, slug: fragment });
      reserved[token(section, fragment)] = e.key;
    }
    // Preserve the opaque part IDs and the historic p- prefixed guide IDs.
    after.forEach(function(p){
      [p.id, 'p-' + p.id].forEach(function(id){ reserved[token(sectionSlug(p.section), id)] = 'part:' + p.id; });
    });
    // Reserved interface and timeline fragments must keep their old meaning.
    after.forEach(function(p){
      reserved[token(sectionSlug(p.section), 'proposals')] = '!interface';
      legacyHeadings(p).forEach(function(h){ if (h.phase) reserved[token(sectionSlug(p.section), h.phase)] = '!phase'; });
    });
    function activate(e, p, index, title, legacy, phase){
      if (!e) { e = { key: index < 0 ? 'part:' + p.id : 'heading:' + old.next++, partId: p.id, aliases: [], legacy: [] }; entries.push(e); }
      e.index = index; e.currentLegacy = legacy; e.title = title; e.section = sectionSlug(p.section); e.active = true;
      var base = slug(title), fragment = base, n = 1;
      while (reserved[token(e.section, fragment)] && reserved[token(e.section, fragment)] !== e.key) fragment = base + '-' + n++;
      e.slug = fragment; remember(e, e.section, fragment);
      if (e.legacy.indexOf(legacy) < 0) e.legacy.push(legacy);
      if (phase && e.legacy.indexOf(phase) < 0) e.legacy.push(phase);
      active.push(e.key);
      return e;
    }
    after.forEach(function(p){
      activate(entries.filter(function(e){ return e.key === 'part:' + p.id; })[0], p, -1, p.title || '', p.id);
      var previous = entries.filter(function(e){ return e.partId === p.id && e.index >= 0 && e.active; }).sort(function(a, b){ return a.index - b.index; });
      var next = legacyHeadings(p), matches = {}, taken = {};
      // Match unchanged headings first, even when inserted around or reordered.
      next.forEach(function(h, i){
        var same = previous.filter(function(e){ return !taken[e.key] && e.title === h.text; });
        if (same.length) { matches[i] = same[0]; taken[same[0].key] = true; }
      });
      // Within unchanged neighbours, one replacement is a rename. Multiple
      // replacements in the same gap retain their relative order when counts
      // agree; unequal counts are treated as deletions/additions, not redirects.
      var anchors = Object.keys(matches).map(Number).sort(function(a,b){ return a-b; });
      var bounds = [-1].concat(anchors, [next.length]);
      for (var b = 0; b < bounds.length - 1; b++) {
        var lo = bounds[b], hi = bounds[b+1];
        var left = lo < 0 ? -1 : previous.indexOf(matches[lo]);
        var right = hi === next.length ? previous.length : previous.indexOf(matches[hi]);
        if (right <= left) continue;
        var lost = previous.slice(left+1, right).filter(function(e){ return !taken[e.key]; });
        var added = [];
        for (var j = lo+1; j < hi; j++) if (!matches[j]) added.push(j);
        if (lost.length === added.length) added.forEach(function(i,k){ matches[i] = lost[k]; taken[lost[k].key] = true; });
      }
      var remainingOld = previous.filter(function(e){ return !taken[e.key]; });
      var remainingNew = next.map(function(_,i){ return i; }).filter(function(i){ return !matches[i]; });
      if (remainingOld.length === 1 && remainingNew.length === 1) {
        matches[remainingNew[0]] = remainingOld[0]; taken[remainingOld[0].key] = true;
      }
      next.forEach(function(h,i){
        if (!matches[i]) {
          var restored = entries.filter(function(e){ return e.partId === p.id && e.index >= 0 && !e.active && e.title === h.text && !taken[e.key]; });
          if (restored.length === 1) { matches[i] = restored[0]; taken[restored[0].key] = true; }
        }
        activate(matches[i], p, i, h.text, h.legacy, h.phase);
      });
    });
    entries.forEach(function(e){ e.active = active.indexOf(e.key) !== -1; });
    return old;
  }
  function current(parts, saved){ return update(parts, parts, saved); }
  function resolve(registry, fragment, section){
    var matches = registry.entries.filter(function(e){
      return e.active && e.aliases.some(function(a){ return a.slug === fragment && (section == null || a.section === section); });
    });
    // Without a section selector an ambiguous slug must never pick arbitrarily.
    return matches.length === 1 ? matches[0] : null;
  }
  function resolveLegacy(registry, fragment){
    return registry.entries.filter(function(e){ return e.legacy.indexOf(fragment) !== -1; })[0] || null;
  }
  return { resolveLegacy: resolveLegacy, slug: slug, sectionSlug: sectionSlug, headings: headings, update: update, current: current, resolve: resolve };
});
