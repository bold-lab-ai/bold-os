// settings.html: BOLD.OS's settings, for PIs and admins (firestore.rules: only they read or
// write settings/*): the Slack invite link and the welcome email (settings/joinInvite), the
// join form's choices (settings/joinForm), each group's and role's Slack channels
// (settings/groups: whoever is in the group, or has the role, is added to them) and the
// pilots of new Slack features (settings/pilot; functions/index.js pilotSlack). Anyone else
// who can open it is told who can. Tabs: Slack, Join form, Pilots (settingsHtml). Moved here from Requests' Settings tab (#164);
// join-requests.html#settings opens this page.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('settingsPage');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var me = null, staff = null, invite = null, form = null, groups = {}, unsubs = [], editing = false;
  // Pilots: a new Slack feature only messages its testers until it's switched live here.
  // pilotDraft: the form's testers and switches.
  var pilot = null, pilotDraft = null, pilotError = '', roster = [];

  var SUBJECT = 'Welcome to BOLD';
  var BODY = ['Hi {name},', '', 'Welcome to BOLD! Your request to join has been approved. Here are your next steps:', '',
    '1. Join the BOLD Slack: {slackInvite}', '   You sign in to BOLD.OS with your Slack account, using this email address.',
    '2. Complete your profile: {site}profile.html', '3. Link your accounts (GitHub and Google): {site}profile.html#linked-accounts',
    '4. Read the BOLDiquette: {site}boldiquette.html', '5. Add your projects, if you have any: {site}projects-register.html', '',
    'See you on Slack,', 'The BOLD team'].join('\n');

  // Three tabs, by #hash: Slack (#slack: the invite link, the groups' and roles' channels),
  // Join form (#join: its choices and the welcome email) and Pilots (#pilots). The first two
  // are one form, saved from either.
  var TABS = [['slack', 'Slack'], ['join', 'Join form'], ['pilots', 'Pilots']];
  // A list typed in one at a time, as keywords are on the register form: type, Enter or +,
  // × to remove (project.css .kw-*). kind: 'chan' (Slack channels, shown with #), 'role',
  // 'pillar'; key: the group's or role's for channels.
  var CHIPS = { chan: { ph: 'Add a channel', max: 80 }, role: { ph: 'Add a role', max: 80 }, pillar: { ph: 'Add a pillar', max: 80 } };
  function chipHtml(kind, v){
    var label = kind === 'chan' ? '#' + v : v;
    return '<li class="kw-chip" data-v="' + esc(v) + '">' + esc(label) + '<button type="button" class="st-chip-x" aria-label="Remove ' + esc(label) + '">×</button></li>';
  }
  // of: 'group' or 'role', whose channels these are.
  function chipsHtml(kind, key, items, of){
    return '<div class="st-chips" data-kind="' + kind + '"' + (key ? ' data-key="' + esc(key) + '"' : '') + (of ? ' data-of="' + of + '"' : '') + '>' +
      '<div class="kw-entry"><input type="text" class="st-chip-in no-tags" maxlength="' + CHIPS[kind].max + '" autocomplete="off" placeholder="' + CHIPS[kind].ph + '"' + (key ? ' aria-label="' + esc(CHIPS[kind].ph + ' for ' + key) + '"' : ' aria-label="' + CHIPS[kind].ph + '"') + '>' +
      '<button class="btn kw-add st-chip-add" type="button" aria-label="' + CHIPS[kind].ph + '">+</button></div>' +
      '<ul class="kw-list">' + items.map(function(v){ return chipHtml(kind, v); }).join('') + '</ul></div>';
  }
  // A group's or role's channels as saved ("a, b") → [names].
  function chanList(v){ return String(v || '').split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); }).filter(Boolean); }
  // A chip typed in → its value, or { error }.
  function chipValue(kind, raw){
    var v = String(raw || '').trim();
    if (kind !== 'chan') return v;
    v = v.replace(/^#/, '').toLowerCase();
    return !v || /^[a-z0-9_-]{1,80}$/.test(v) ? v : { error: 'Slack channel names use letters, numbers, hyphens and underscores.' };
  }
  function addChip(box){
    var input = box.querySelector('.st-chip-in'), kind = box.getAttribute('data-kind'), v = chipValue(kind, input.value);
    var err = box.closest('.profile-panel').querySelector('.ev-error');
    if (v && v.error) { err.textContent = v.error; err.hidden = false; return; }
    err.hidden = true; input.value = '';
    var has = Array.prototype.some.call(box.querySelectorAll('.kw-chip'), function(c){ return c.getAttribute('data-v').toLowerCase() === String(v).toLowerCase(); });
    if (!v || has) return;
    box.querySelector('.kw-list').insertAdjacentHTML('beforeend', chipHtml(kind, v));
    editing = true;
  }
  function chipsOf(box){ return Array.prototype.map.call(box.querySelectorAll('.kw-chip'), function(c){ return c.getAttribute('data-v'); }); }
  function settingsHtml(){
    var inv = invite || {}, f = form || {};
    var group = function(title){ return '<fieldset class="md-group"><legend>' + title + '</legend>'; };
    var save = '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save jr-save">Save settings</button></div>';
    var row = function(label, inner, err){ return '<div class="st-row"><span class="st-row-label">' + esc(label) + '</span>' + inner + (err ? '<p class="st-error">' + esc(err) + '</p>' : '') + '</div>'; };
    // Each tab its own box; the Slack and Join form tabs are one form (.jr-settings).
    return '<nav class="guide-tabs profile-tabs" id="stTabs" aria-label="Settings">' + TABS.map(function(t){ return '<a class="guide-tab" href="#' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' +
      '<div class="jr-settings">' +
      '<section class="profile-panel" id="slack"><div class="event-form join-form">' +
      group('Slack invite') + '<label>Link (in Slack: Invite people → Copy invite link; replace it when it expires)<input type="url" class="jr-invite" maxlength="300" value="' + esc(inv.slackInviteUrl || '') + '" placeholder="https://join.slack.com/t/…"></label>' +
      '<label>Expires on (PIs and admins hear 3 days before)<input type="date" class="jr-expires" value="' + esc(inv.slackInviteExpires || '') + '"></label></fieldset>' +
      group('Slack channels') + '<p class="proj-meta">Everyone in a group, and in the groups above it, is added to its channels (<a href="boldiquette.html#who-is-bold">Who is BOLD</a>). None: nobody is added.</p>' +
        BoldJoin.CATEGORIES.filter(function(c){ return c[0] !== 'pan'; }).map(function(c){
          return row(c[1], chipsHtml('chan', c[0], chanList((groups.channels || {})[c[0]]), 'group'), (groups.channelErrors || {})[c[0]]);
        }).join('') + '</fieldset>' + group('Slack channels by role') + '<p class="proj-meta">Everyone with a role (on their details) is added to its channels. The roles are the join form’s (<a href="#join">Join form</a>).</p>' +
        (f.roles || BoldJoin.ROLES).map(function(r){
          return row(r, chipsHtml('chan', r, chanList((groups.roleChannels || {})[r]), 'role'), (groups.roleChannelErrors || {})[r]);
        }).join('') + '</fieldset>' + save + '</div></section>' +
      '<section class="profile-panel" id="join"><div class="event-form join-form">' + group('Join form') +
      row('Roles', chipsHtml('role', '', f.roles || BoldJoin.ROLES)) +
      row('Research pillars', chipsHtml('pillar', '', f.pillars || BoldJoin.PILLARS)) + '</fieldset>' +
      group('Welcome email') + '<label>Subject<input type="text" class="jr-subject" maxlength="200" value="' + esc(inv.subject || SUBJECT) + '"></label>' +
      '<label>Text ({name}: their first name, {slackInvite}: the invite link, on the Slack tab, {site}: BOLD.OS)<textarea class="jr-body no-tags" rows="14" maxlength="5000">' + esc(inv.body || BODY) + '</textarea></label></fieldset>' +
      save + '</div></section></div>' +
      '<section class="profile-panel" id="pilots">' + pilotHtml() + '</section>';
  }
  function showTab(){
    var tabs = document.getElementById('stTabs');
    if (!tabs) return;
    var h = location.hash.slice(1), want = TABS.some(function(t){ return t[0] === h; }) ? h : 'slack';
    TABS.forEach(function(t){ var x = document.getElementById(t[0]); if (x) x.hidden = t[0] !== want; });
    Array.prototype.forEach.call(tabs.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);

  // ---------- Pilots ----------
  // testers: everyone's, for every pilot; pilotTesters: { feature: [emails] }, for that one too.
  function pilotNow(){
    if (pilotDraft) return pilotDraft;
    var p = pilot || {}, each = {};
    Object.keys(p.pilotTesters || {}).forEach(function(k){ each[k] = (p.pilotTesters[k] || []).slice(); });
    return { testers: (p.testers || []).slice(), pilotTesters: each, live: Object.assign({}, p.live || {}) };
  }
  // A list of testers with Remove beside each and a menu to add one: key '' the general ones.
  function testersHtml(list, key, none){
    return '<ul class="jr-testers">' + (list.length ? list.map(function(e, i){
        return '<li>' + esc(nameOf(e)) + ' <button type="button" class="btn-text danger jr-tester-remove" data-for="' + esc(key) + '" data-i="' + i + '">Remove</button></li>';
      }).join('') : '<li class="proj-meta">' + none + '</li>') + '</ul>' +
      '<select class="jr-tester-add" data-for="' + esc(key) + '" aria-label="Add a tester"><option value="">Add a tester…</option>' + roster.filter(function(p){ return list.indexOf(p.email) < 0; })
        .map(function(p){ return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('') + '</select>';
  }
  function testersOf(d, key){ return key ? (d.pilotTesters[key] = d.pilotTesters[key] || []) : d.testers; }
  function nameOf(e){ var p = roster.filter(function(x){ return x.email === e; })[0]; return p ? p.name : e.split('@')[0]; }
  function pilotHtml(){
    if (!pilot) return '';
    var d = pilotNow(), known = pilot.known || {}, keys = Object.keys(known).sort();
    return '<div class="event-form join-form jr-pilot"><fieldset class="md-group"><legend>Pilots</legend>' +
      '<p class="proj-meta">A new Slack feature only messages its testers until it’s live: each message goes to them instead, saying whom it was for.</p>' +
      '<label>Testers of every pilot</label>' + testersHtml(d.testers, '', 'Nobody') +
      '<label>Features</label>' + (keys.length ? keys.map(function(k){
        return '<div class="jr-feature"><label class="jn-check"><input type="checkbox" class="jr-live" data-key="' + esc(k) + '"' + (d.live[k] ? ' checked' : '') + '> ' + esc(known[k]) + ' <span class="proj-meta">· ' + (d.live[k] ? 'live: messages everyone it’s for' : 'in pilot: testers only') + '</span></label>' +
          (d.live[k] ? '' : '<p class="proj-meta">Its own testers, besides those of every pilot:</p>' + testersHtml(d.pilotTesters[k] || [], k, 'None')) + '</div>';
      }).join('') : '<p class="proj-meta">None yet: a feature appears here once it’s deployed.</p>') +
      '</fieldset>' + (pilotError ? '<p class="ev-error">' + esc(pilotError) + '</p>' : '') +
      '<div class="event-form-actions"><button type="button" class="ev-save jr-pilot-save"' + (pilotDraft ? '' : ' disabled title="Nothing changed"') + '>Save pilots</button>' +
        (pilotDraft ? '<button type="button" class="jr-pilot-cancel">Cancel</button>' : '') + '</div></div>';
  }
  function savePilot(btn){
    var d = pilotNow(), was = (pilot || {}).live || {}, known = (pilot || {}).known || {};
    var goingLive = Object.keys(d.live).filter(function(k){ return d.live[k] && !was[k]; });
    // Going live reaches everyone each feature is for: asked every time (the ground rule).
    (goingLive.length ? BOLD.confirmAlways({ title: 'Make ' + (goingLive.length === 1 ? 'it' : 'them') + ' live?', go: 'Make live',
      effects: goingLive.map(function(k){ return 'Let ' + (known[k] || k) + ' message everyone it’s for on Slack, not just the testers'; }) }) : Promise.resolve(true)).then(function(ok){
      if (!ok) return;
      btn.disabled = true; pilotError = '';
      db.collection('settings').doc('pilot').set({ testers: d.testers, pilotTesters: d.pilotTesters, live: d.live, updatedAt: Date.now(), updatedBy: me.email }, { merge: true }).then(function(){
        pilotDraft = null; render();
      }).catch(function(err){ console.error('[BOLD Settings] saving the pilots failed', err); pilotError = 'Couldn’t save — try again.'; render(); });
    });
  }

  function render(){
    if (!me) return;
    if (staff === false) { main.innerHTML = '<p class="proj-msg">Only PIs and admins see and change BOLD.OS’s settings.</p>'; return; }
    if (staff === null || invite === null || form === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    // Settings being changed aren't redrawn over: only the Pilots tab is.
    if (editing) { var pp = document.getElementById('pilots'); if (pp) pp.innerHTML = pilotHtml(); return; }
    main.innerHTML = settingsHtml();
    // Typing in a chip's box isn't a change until it's added.
    main.querySelector('.jr-settings').addEventListener('input', function(e){ if (!e.target.classList.contains('st-chip-in')) editing = true; });
    var drawn = readSettings(); settingsFrom = drawn.error ? null : drawn;
    showTab();
  }


  // What the settings form says, as saved: { invite, form, groups } (each a settings
  // document's fields), or { error }.
  function readSettings(){
    var s = main.querySelector('.jr-settings');
    var v = function(c){ return s.querySelector(c).value; };
    var url = v('.jr-invite').trim();
    if (url && !/^https:\/\/\S+$/.test(url)) return { error: 'The invite link starts with https://' };
    var box = function(kind){ return s.querySelector('.st-chips[data-kind="' + kind + '"]'); };
    var roles = chipsOf(box('role')), pillars = chipsOf(box('pillar'));
    if (!roles.length) return { error: 'Give at least one role.' };
    // Each group's and role's channels, kept as "a, b" (one name: "a").
    var names = function(sel){
      var m = {};
      Array.prototype.forEach.call(s.querySelectorAll(sel), function(b){ var v = chipsOf(b); if (v.length) m[b.getAttribute('data-key')] = v.join(', '); });
      return m;
    };
    var channels = names('.st-chips[data-of="group"]'), roleChannels = names('.st-chips[data-of="role"]');
    var badName = function(m){ return Object.keys(m).some(function(k){ return m[k].split(', ').some(function(n){ return !/^[a-z0-9_-]{1,80}$/.test(n); }); }); };
    if (badName(channels) || badName(roleChannels)) return { error: 'Slack channel names use letters, numbers, hyphens and underscores.' };
    return {
      invite: { slackInviteUrl: url, slackInviteExpires: v('.jr-expires'), subject: v('.jr-subject').trim() || SUBJECT, body: v('.jr-body') || BODY },
      form: { roles: roles, pillars: pillars },
      groups: { channels: channels, roleChannels: roleChannels }
    };
  }
  // What the form showed when it was drawn: saving writes only what was changed since.
  var settingsFrom = null;

  function saveSettings(btn){
    var err = btn.closest('.profile-panel').querySelector('.ev-error');
    var mine = readSettings();
    if (mine.error) { err.textContent = mine.error; err.hidden = false; return; }
    var channels = mine.groups.channels, roleChannels = mine.groups.roleChannels;
    // Channels added to a group: everyone meant to be in them is invited (onGroupChannels).
    var had = (groups && groups.channels) || {};
    var added = [], newNames = [];
    Object.keys(channels).forEach(function(g){
      var before = String(had[g] || '').split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); });
      channels[g].split(', ').forEach(function(n){ if (before.indexOf(n) < 0) { added.push('Invite everyone in ' + BoldJoin.categoryLabel(g) + ' and the groups above it to #' + n + ' on Slack'); newNames.push(n); } });
    });
    var hadRoles = (groups && groups.roleChannels) || {};
    Object.keys(roleChannels).forEach(function(r){
      var before = String(hadRoles[r] || '').split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); });
      roleChannels[r].split(', ').forEach(function(n){ if (before.indexOf(n) < 0) { added.push('Invite everyone whose role is ' + r + ' to #' + n + ' on Slack'); newNames.push(n); } });
    });
    // A channel the bot can't see (a typo, or a private one it isn't in) isn't saved: nobody
    // would be added to it, and nobody would know (checkGroupChannels).
    btn.disabled = true; err.hidden = true;
    checkChannels(newNames).then(function(missing){
      btn.disabled = false;
      if (missing) { err.textContent = missing; err.hidden = false; return; }
      (added.length ? BOLD.confirmAlways({ title: 'Save the settings?', go: 'Save', effects: added }) : Promise.resolve(true)).then(function(ok){
        if (ok) writeSettings(btn, err, mine);
      });
    }).catch(function(e){
      btn.disabled = false;
      console.error('[BOLD Settings] checking the channels failed', e);
      err.textContent = 'Couldn’t check the channels on Slack — try again.'; err.hidden = false;
    });
  }
  // → Promise of '' (all there) or what's wrong with the names, in words.
  function checkChannels(names){
    names = names.filter(function(n, i){ return names.indexOf(n) === i; });
    if (!names.length) return Promise.resolve('');
    return firebase.app().functions('europe-west2').httpsCallable('checkGroupChannels')({ names: names }).then(function(r){
      var d = r.data || {};
      return (d.missing || []).map(function(m){
        return 'BOLD.OS can’t see #' + m.name + (m.suggest ? ' — did you mean #' + m.suggest + '?' : ': if it’s a private channel, invite ' + (d.bot || 'the BOLD OS app') + ' to it first.');
      }).join(' ');
    });
  }
  // Each settings document is written only if something in it was changed, and then
  // only the fields (and, in a map, the entries) that were: the rest is kept as saved
  // now, so two people saving different settings at once both keep theirs.
  var SETTINGS_DOCS = { invite: 'joinInvite', form: 'joinForm', groups: 'groups' };
  function writeSettings(btn, err, mine){
    var from = settingsFrom || mine;
    var same = function(a, b){ return JSON.stringify(a) === JSON.stringify(b); };
    var isMap = function(x){ return x && typeof x === 'object' && !Array.isArray(x); };
    var merge = function(base, mineV, theirs){
      if (same(mineV, base)) return theirs;
      if (isMap(mineV) && isMap(base) && isMap(theirs)){
        var o = {};
        Object.keys(Object.assign({}, base, mineV, theirs)).forEach(function(k){ var x = merge(base[k], mineV[k], theirs[k]); if (x !== undefined) o[k] = x; });
        return o;
      }
      return mineV;
    };
    var keys = Object.keys(SETTINGS_DOCS).filter(function(k){ return !same(mine[k], from[k]); });
    btn.disabled = true; err.hidden = true;
    db.runTransaction(function(tx){
      var refs = keys.map(function(k){ return db.collection('settings').doc(SETTINGS_DOCS[k]); });
      return Promise.all(refs.map(function(r){ return tx.get(r); })).then(function(snaps){
        snaps.forEach(function(snap, i){
          var k = keys[i], now = snap.exists ? snap.data() : {}, out = {};
          Object.keys(mine[k]).forEach(function(f){
            var x = merge(from[k][f], mine[k][f], now[f] === undefined ? from[k][f] : now[f]);
            if (x !== undefined) out[f] = x;
          });
          tx.set(refs[i], Object.assign(out, { updatedAt: Date.now(), updatedBy: me.email }));
        });
      });
    }).then(function(){
      editing = false; btn.disabled = false; btn.textContent = 'Saved'; setTimeout(function(){ btn.textContent = 'Save settings'; }, 1500);
      render();
    }).catch(function(e){
      console.error('[BOLD Settings] saving the settings failed', e);
      err.textContent = 'Couldn’t save — try again.'; err.hidden = false; btn.disabled = false;
    });
  }

  main.addEventListener('change', function(e){
    var t = e.target;
    if (t.classList.contains('jr-tester-add') && t.value) { pilotDraft = pilotNow(); testersOf(pilotDraft, t.getAttribute('data-for')).push(t.value); render(); return; }
    if (t.classList.contains('jr-live')) { pilotDraft = pilotNow(); pilotDraft.live[t.getAttribute('data-key')] = t.checked; render(); }
  });
  main.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && e.target.classList.contains('st-chip-in')) { e.preventDefault(); addChip(e.target.closest('.st-chips')); }
  });
  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('st-chip-add')) { addChip(t.closest('.st-chips')); return; }
    if (t.classList.contains('st-chip-x')) { t.closest('.kw-chip').remove(); editing = true; return; }
    if (t.classList.contains('jr-save')) { saveSettings(t); return; }
    if (t.classList.contains('jr-pilot-save')) { savePilot(t); return; }
    if (t.classList.contains('jr-pilot-cancel')) { pilotDraft = null; pilotError = ''; render(); return; }
    if (t.classList.contains('jr-tester-remove')) { pilotDraft = pilotNow(); testersOf(pilotDraft, t.getAttribute('data-for')).splice(+t.getAttribute('data-i'), 1); render(); }
  });

  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: (user.email || '').toLowerCase() } : null;
    staff = null; invite = null; form = null;
    if (!user) return;
    render();
    db.collection('people').get().then(function(ps){
      roster = ps.docs.map(function(d){ return { email: String(d.data().email || '').toLowerCase(), name: d.data().name || '' }; })
        .filter(function(p){ return p.email && p.name; }).sort(function(a, b){ return a.name.localeCompare(b.name); });
      render();
    }).catch(function(){});
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
      staff = !!(r.data && r.data.fullWrite);
      if (!staff) { render(); return; }
      var watch = function(id, set){ unsubs.push(db.collection('settings').doc(id).onSnapshot(function(s){ set(s.exists ? s.data() : {}); render(); }, function(err){ console.error('[BOLD Settings] loading settings/' + id + ' failed', err); set({}); render(); })); };
      watch('joinInvite', function(x){ invite = x; });
      watch('joinForm', function(x){ form = x; });
      watch('groups', function(x){ groups = x; });
      watch('pilot', function(x){ pilot = x; });
    }).catch(function(err){ console.error('[BOLD Settings] checking access failed', err); staff = false; render(); });
  });
})();
