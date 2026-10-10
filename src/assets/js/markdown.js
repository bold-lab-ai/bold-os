// A small, safe Markdown renderer for text people write on the site (a guide's
// parts): headings (#…####), paragraphs, bullet and numbered lists (nested by
// indent), > quotes, ``` code blocks, **bold**, *italic* (asterisks only), ~~struck~~, `code` and
// [links](https://…). Everything is escaped first; links are kept only when they
// are http(s), mailto, a page of this site or an #anchor.
// BoldMarkdown.render(text) → HTML.
window.BoldMarkdown = (function(){
  var esc = BOLD.escapeHtml;

  function safeUrl(u){
    u = u.trim();
    return /^(https?:\/\/|mailto:|#)/i.test(u) || /^[\w-]+\.html([?#].*)?$/.test(u) ? u : '';
  }

  // Inline formatting of one escaped line. Code spans are set aside first so
  // nothing inside them is formatted.
  function inline(text){
    var codes = [];
    var s = esc(text).replace(/`([^`]+)`/g, function(_, c){ codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(all, label, url){
      var u = safeUrl(url.replace(/&amp;/g, '&'));
      if (!u) return label;
      var external = /^https?:/i.test(u);
      return '<a href="' + esc(u) + '"' + (external ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, function(all, pre, u){
      return pre + '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function(_, i){ return '<code>' + codes[+i] + '</code>'; });
  }

  var ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

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
      if (!top || indent > top.indent) {
        stack.push({ indent: indent, tag: tag });
        html += '<' + tag + (tag === 'ol' && parseInt(m[2], 10) > 1 ? ' start="' + parseInt(m[2], 10) + '"' : '') + '><li>';
      } else html += '</li><li>';
      html += inline(m[3]);
    });
    close(-1);
    return html;
  }

  function render(text){
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = '', i = 0;
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
      var para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>)/.test(lines[i]) && !ITEM.test(lines[i]); i++) para.push(lines[i].trim());
      out += '<p>' + para.map(inline).join(' ') + '</p>';
    }
    return out;
  }

  return { render: render };
})();
