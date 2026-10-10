// Reads a whole skill — a folder picked on the computer — into
// { folder, files: [{ path, content }], skipped: [paths] }: paths relative to the
// skill's folder (the folder holding SKILL.md), text files only (anything that
// isn't UTF-8 text is skipped), macOS clutter left out. Used by the skill page's
// "Import a folder" (pages/skill.js).
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

  return { fromFolder: fromFolder };
})();
