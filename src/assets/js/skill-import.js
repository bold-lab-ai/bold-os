// Reads a whole skill — a folder picked on the computer, or a .zip — into
// { folder, files: [{ path, content }], skipped: [paths] }: paths relative to the
// skill's folder (the folder holding SKILL.md), text files only (anything that
// isn't UTF-8 text is skipped), macOS clutter left out. Used by the skill page's
// "Import a folder" / "Import a .zip" (pages/skill.js). A .zip is unpacked here,
// with the browser's own DecompressionStream — no library.
window.SkillImport = (function(){
  var JUNK = /(^|\/)(__MACOSX|\.DS_Store|\._[^/]*|Thumbs\.db)(\/|$)/;

  function decodeText(bytes){
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e){ return null; }
  }

  // [{ path, bytes }] → the result above. The skill's folder is the one holding
  // the shallowest SKILL.md; without one, the common top folder, if any.
  function collect(entries){
    entries = entries.filter(function(e){ return !JUNK.test(e.path) && !/\/$/.test(e.path); });
    var md = entries.filter(function(e){ return /(^|\/)SKILL\.md$/.test(e.path); })
      .sort(function(a, b){ return a.path.split('/').length - b.path.split('/').length; })[0];
    var prefix = md ? md.path.slice(0, -'SKILL.md'.length) : '';
    if (!md) {
      var tops = {};
      entries.forEach(function(e){ tops[e.path.split('/')[0]] = true; });
      var keys = Object.keys(tops);
      if (keys.length === 1 && entries.every(function(e){ return e.path.indexOf('/') !== -1; })) prefix = keys[0] + '/';
    }
    var out = { folder: prefix.replace(/\/$/, '').split('/').pop(), files: [], skipped: [] };
    entries.forEach(function(e){
      if (prefix && e.path.indexOf(prefix) !== 0) return;
      var path = e.path.slice(prefix.length);
      var text = decodeText(e.bytes);
      if (text === null || text.indexOf('\u0000') !== -1) out.skipped.push(path);
      else out.files.push({ path: path, content: text });
    });
    return out;
  }

  // FileList from <input webkitdirectory> → Promise of the result.
  function fromFolder(fileList){
    return Promise.all(Array.prototype.map.call(fileList, function(f){
      return f.arrayBuffer().then(function(buf){ return { path: f.webkitRelativePath || f.name, bytes: new Uint8Array(buf) }; });
    })).then(collect);
  }

  function inflate(bytes){
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function(b){ return new Uint8Array(b); });
  }

  // A .zip File → Promise of the result. Reads the central directory; entries
  // are stored or deflated (what every zip tool writes).
  function fromZip(file){
    return file.arrayBuffer().then(function(buf){
      var v = new DataView(buf), u8 = new Uint8Array(buf);
      var end = -1;
      for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
      }
      if (end < 0) throw new Error('not a zip');
      var count = v.getUint16(end + 10, true), at = v.getUint32(end + 16, true), jobs = [];
      for (var n = 0; n < count; n++) {
        if (v.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip');
        var flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true);
        var nameLen = v.getUint16(at + 28, true), extraLen = v.getUint16(at + 30, true), commentLen = v.getUint16(at + 32, true);
        var local = v.getUint32(at + 42, true);
        var nameBytes = u8.subarray(at + 46, at + 46 + nameLen);
        var path = flags & 0x800 ? new TextDecoder().decode(nameBytes) : Array.prototype.map.call(nameBytes, function(c){ return String.fromCharCode(c); }).join('');
        at += 46 + nameLen + extraLen + commentLen;
        if (/\/$/.test(path) || JUNK.test(path)) continue;
        var start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        var data = u8.subarray(start, start + size);
        jobs.push((method === 0 ? Promise.resolve(data) : method === 8 ? inflate(data) : Promise.resolve(new Uint8Array([0])))
          .then(function(p){ return function(bytes){ return { path: p, bytes: bytes }; }; }(path)));
      }
      return Promise.all(jobs).then(collect);
    });
  }

  return { fromFolder: fromFolder, fromZip: fromZip };
})();
