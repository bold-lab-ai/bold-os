// A small, safe Markdown renderer for text people write on the site (a guide's
// parts): headings (#…####), paragraphs, bullet and numbered lists (nested by
// indent), > quotes, ``` code blocks, **bold**, *italic* (asterisks only), ~~struck~~, `code` and
// [links](https://…). Everything is escaped first; links are kept only when they
// are http(s), mailto, a page of this site or an #anchor. Tables: a | row, a
// |---| row under it, then | rows. @[Name](SlackId), a tagged person (mentions.js),
// shows as @Name, linking to their Slack profile.
// Phases: a heading ending " · 8w", " · 10d" or " · after" (weeks or days before a deadline,
// or after it) is a phase; with two or more, a timeline of them, each linking to its heading,
// comes before the first (the BOLDiquette's ML Conference Cycle).
// BoldMarkdown.render(text, { breaks: true }) → HTML, a single line break kept as one (as in Slack:
// Conversations); without it a paragraph's lines join, as in Markdown. BoldMarkdown.plain(text) → plain text, escaped,
// with its tags and web addresses as links (comments).
window.BoldMarkdown = (function(){
  var esc = BOLD.escapeHtml;

  // A tag, with its link to the person's profile in the Slack app (Slack's own
  // slack://user link: it opens their profile; nobody is notified).
  function mentions(escaped){
    return escaped.replace(BOLD.TAG, function(all, name, id){
      return '<a class="md-mention" href="slack://user?team=' + BOLD.SLACK_TEAM + '&amp;id=' + id + '" title="Open in Slack">@' + name + '</a>';
    });
  }
  // Plain text (comments): escaped, its tags as links, and its http(s) addresses as
  // links (without a sentence's closing punctuation).
  function plain(text){
    var parts = String(text == null ? '' : text).split(/(https?:\/\/[^\s<>"']+)/), out = '', carry = '';
    parts.forEach(function(p, i){
      if (i % 2 === 0) { out += mentions(esc(carry + p)); carry = ''; return; }
      var tail = /[.,;:!?)\]]+$/.exec(p), u = tail ? p.slice(0, -tail[0].length) : p;
      out += '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a>';
      carry = tail ? tail[0] : '';
    });
    return out + (carry ? esc(carry) : '');
  }

  function safeUrl(u){
    u = u.trim();
    return /^(https?:\/\/|mailto:|#)/i.test(u) || /^[\w-]+\.html([?#].*)?$/.test(u) ? u : '';
  }

  // Inline formatting of one escaped line. Code spans are set aside first so
  // nothing inside them is formatted.
  function inline(text){
    var codes = [];
    var s = mentions(esc(text).replace(/`([^`]+)`/g, function(_, c){ codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; }));
    // Images (BOLD.imageHtml), set aside like code so nothing formats their addresses.
    var imgs = [];
    s = s.replace(BOLD.IMAGE, function(all, alt, url){
      imgs.push(BOLD.imageHtml(unesc(alt), unesc(url)));
      return '\u0001' + (imgs.length - 1) + '\u0001';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(all, label, url){
      var u = safeUrl(url.replace(/&amp;/g, '&'));
      if (!u) return label;
      var external = /^https?:/i.test(u);
      return '<a href="' + esc(u) + '"' + (external ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
    });
    // <https://…> and <name@host> (as Google Docs exports links and addresses).
    s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, function(all, u){
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    }).replace(/&lt;([\w.+-]+@[\w-]+(?:\.[\w-]+)+)&gt;/g, '<a href="mailto:$1">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, function(all, pre, u){
      return pre + '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function(_, i){ return '<code>' + codes[+i] + '</code>'; })
      .replace(/\u0001(\d+)\u0001/g, function(_, i){ return imgs[+i]; });
  }
  function unesc(s){ return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }

  var ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function cells(line){
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(c){ return c.trim(); });
  }

  // A bullet whose text starts with its own label ("1:", "2.", "(a)", "(b1)"),
  // as Google Docs exports hand-numbered lists: the label becomes its marker.
  var LABEL = /^(\d+[:.)]|\([a-z0-9]{1,3}\))\s+/;
  function itemHtml(bullet, text){
    var l = bullet && LABEL.exec(text);
    if (!l) return '<li>' + inline(text);
    return '<li class="md-labelled"><span class="md-label">' + esc(l[1]) + '</span>' + inline(text.slice(l[0].length));
  }

  // Lines of a list (and their continuation lines) → nested <ul>/<ol>.
  function list(lines){
    var html = '', stack = [];
    function close(toIndent){
      while (stack.length && stack[stack.length - 1].indent > toIndent) html += '</li></' + stack.pop().tag + '>';
    }
    lines.forEach(function(line){
      var m = ITEM.exec(line);
      if (!m) { html += ' ' + inline(line.trim()); return; }
      var indent = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      close(indent);
      var top = stack[stack.length - 1];
      // Bullets then numbers (or the other way) at one level: two lists.
      if (top && indent === top.indent && top.tag !== tag) { html += '</li></' + stack.pop().tag + '>'; top = stack[stack.length - 1]; }
      if (!top || indent > top.indent) {
        stack.push({ indent: indent, tag: tag });
        html += '<' + tag + (tag === 'ol' && parseInt(m[2], 10) > 1 ? ' start="' + parseInt(m[2], 10) + '"' : '') + '>';
      } else html += '</li>';
      html += itemHtml(tag === 'ul', m[3]);
    });
    close(-1);
    return html;
  }

  var PHASE = /^(#{1,4})\s+(.*?)\s+·\s+(\d+[wd]|after)\s*$/;
  function slug(t){ return String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function whenText(w){ return w === 'after' ? 'after the deadline' : parseInt(w, 10) + (/w$/.test(w) ? ' week' : ' day') + (parseInt(w, 10) === 1 ? '' : 's') + ' before'; }
  function timeline(phases){
    // The last phase before the deadline (the submission) stands out.
    var pivot = -1; phases.forEach(function(p, i){ if (p.when !== 'after') pivot = i; });
    return '<nav class="md-timeline" aria-label="Phases at a glance"><ol style="--n:' + phases.length + '">' + phases.map(function(p, i){
      return '<li' + (p.when === 'after' ? ' class="is-after"' : i === pivot ? ' class="is-pivot"' : '') + '><a href="#' + p.id + '"><span class="tl-dot"></span><span class="tl-name">' + esc(p.name) + '</span>' +
        '<span class="tl-wk">' + esc(p.when) + '</span></a></li>';
    }).join('') + '</ol></nav>';
  }
  var breaks = false;
  function render(text, opts){
    var was = breaks;
    if (opts) breaks = !!opts.breaks;
    try { return renderLines(text); } finally { breaks = was; }
  }
  function renderLines(text){
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = '', i = 0;
    var phases = [];
    lines.forEach(function(l){ var m = PHASE.exec(l); if (m) phases.push({ name: m[2], when: m[3], id: 'phase-' + slug(m[2]) }); });
    var phaseAt = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (/^```/.test(line)) {
        var code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        i++;
        out += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        var head = cells(line), rows = [];
        for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
        // An empty header row (as Google Docs exports) means the first row is the header.
        if (!head.join('') && rows.length) head = rows.shift();
        out += '<div class="md-table"><table><thead><tr>' + head.map(function(c){ return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function(row){ return '<tr>' + row.map(function(c){ return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
        continue;
      }
      var ph = phases.length > 1 && PHASE.exec(line);
      if (ph) {
        var pn = Math.min(ph[1].length + 2, 6), info = phases[phaseAt++];
        if (phaseAt === 1) out += timeline(phases);
        out += '<h' + pn + ' class="md-phase" id="' + info.id + '">' + inline(ph[2]) + ' <span class="md-when">' + esc(whenText(ph[3])) + '</span></h' + pn + '>';
        i++; continue;
      }
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { var n = Math.min(h[1].length + 2, 6); out += '<h' + n + '>' + inline(h[2]) + '</h' + n + '>'; i++; continue; }
      if (/^>\s?/.test(line)) {
        var quote = [];
        for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
        out += '<blockquote>' + render(quote.join('\n')) + '</blockquote>';
        continue;
      }
      if (ITEM.test(line)) {
        var items = [];
        for (; i < lines.length; i++) {
          if (ITEM.test(lines[i]) || (lines[i].trim() && /^\s+/.test(lines[i]))) items.push(lines[i]);
          else if (!lines[i].trim() && i + 1 < lines.length && (ITEM.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) continue;
          else break;
        }
        out += list(items);
        continue;
      }
      // Its first line always, so a line no block took (a "|" with no table rule
      // under it, say) can't stop the loop from moving on.
      var para = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*\|)/.test(lines[i]) && !ITEM.test(lines[i]); i++) para.push(lines[i].trim());
      out += '<p>' + para.map(inline).join(breaks ? '<br>' : ' ') + '</p>';
    }
    return out;
  }

  return { render: render, plain: plain };
})();
