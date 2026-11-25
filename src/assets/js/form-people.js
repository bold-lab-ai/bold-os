(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FormPeople = factory();
})(typeof window !== 'undefined' ? window : this, function(){
  function fold(s){ return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
  function search(people, query){
    var words = fold(query).split(/\s+/).filter(Boolean);
    return words.length ? people.filter(function(p){ var text = fold(p.name + ' ' + p.email); return words.every(function(w){ return text.indexOf(w) !== -1; }); }) : [];
  }
  function categories(people){
    var out = [{ label: 'Everyone', group: 'All members', emails: people.map(function(p){ return p.email; }) }];
    var groups = { pan: 'PAN-BOLD', associate: 'BOLD-associate', internal: 'BOLD-internal', staff: 'BOLD-staff', exec: 'BOLD-exec' };
    [['role','Role'],['category','BOLD membership'],['institution','Institution'],['basedIn','Location'],['pillars','Research pillar']].forEach(function(field){
      var values = new Map();
      if (field[0] === 'role') ['PhD student','Master student','Postdoc','PI','Adjunct','Staff','Visitor','Collaborator','Alumni','Other'].forEach(function(v){ values.set(fold(v), { label: v, emails: [] }); });
      people.forEach(function(p){
        var raw = p[field[0]], list = Array.isArray(raw) ? raw : [raw];
        list.forEach(function(v){ if (!v) return; var key = fold(v); if (!values.has(key)) values.set(key, { label: field[0] === 'category' ? groups[v] || v : v, emails: [] }); var emails = values.get(key).emails; if (emails.indexOf(p.email) < 0) emails.push(p.email); });
      });
      Array.from(values.values()).sort(function(a,b){ return a.label.localeCompare(b.label); }).forEach(function(v){ out.push({ group: field[1], label: v.label, emails: v.emails }); });
    });
    return out;
  }
  function change(current, emails, adding, locked, limit){
    var next = adding ? Array.from(new Set(current.concat(emails))) : current.filter(function(e){ return emails.indexOf(e) < 0 || e === locked; });
    if (locked && next.indexOf(locked) < 0) next.unshift(locked);
    if (next.length > limit) throw new Error('Select at most ' + limit + ' people. This category would exceed the limit; no changes were made.');
    return next;
  }
  return { search: search, categories: categories, change: change };
});
