// settings.html: BOLD.OS's settings, for PIs and admins (firestore.rules: only they read or
// write settings/*): the Slack invite link and the welcome email (settings/joinInvite), the
// join form's choices (settings/joinForm), each group's and role's Slack channels
// (settings/groups: whoever is in the group, or has the role, is added to them) and the
// pilots of new Slack features (settings/pilot; functions/index.js pilotSlack). Anyone else
// who can open it is told who can. Tabs: Slack, Join form, Features (settingsHtml). Moved here from Requests' Settings tab (#164);
// join-requests.html#settings opens this page.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('settingsPage');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var me = null, staff = null, invite = null, form = null, groups = {}, webPush = {}, unsubs = [], editing = false;
  // What saving is doing, shown beside its button and kept across redraws: busy ('Checking…',
  // 'Saving…') or when it last saved. One for the Slack, Join form and Notifications tabs, one for Features.
  var saving = { settings: { busy: '', at: 0 }, pilot: { busy: '', at: 0 } };
  function savedNote(k){
    var x = saving[k];
    if (x.busy) return '<span class="st-saving" role="status">' + esc(x.busy) + '</span>';
    if (!x.at) return '<span class="st-saving" role="status"></span>';
    return '<span class="st-saving is-saved" role="status">Saved at ' + new Date(x.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + '</span>';
  }
  // While saving, the button and its note say so (without redrawing the form, which would lose what's typed).
  function busyNow(btn, k, text){
    saving[k].busy = text; btn.disabled = true; btn.textContent = text;
    var n = btn.parentNode.querySelector('.st-saving'); if (n) { n.textContent = ''; n.classList.remove('is-saved'); }
  }
  // Pilots: a new Slack feature only messages its testers until it's switched live here.
  // pilotDraft: the form's testers and switches.
  var pilot = null, pilotDraft = null, pilotError = '', roster = [];
  // #174: aligning the Slack channels with BOLD.OS (functions/index.js channelAlignment): the
  // runs (status), the last preview, what's being done and why it failed. Drawn in #stAlign alone.
  var align = { status: null, preview: null, busy: '', error: '', at: '' };

  var SUBJECT = 'Welcome to BOLD';
  var BODY = ['Hi {name},', '', 'Welcome to BOLD! Your request to join has been approved. Here are your next steps:', '',
    '1. Join the BOLD Slack: {slackInvite}', '   You sign in to BOLD.OS with your Slack account, using this email address.',
    '2. Complete your profile: {site}profile.html', '3. Link your accounts (GitHub and Google): {site}profile.html#linked-accounts',
    '4. Read the BOLDiquette: {site}boldiquette.html', '5. Add your projects, if you have any: {site}projects-register.html', '',
    'See you on Slack,', 'The BOLD team'].join('\n');

  // Three tabs, by #hash: Slack (#slack: the invite link, the groups' and roles' channels),
  // Join form (#join: its choices and the welcome email) and Features (#features: each Slack
  // feature's switch and testers, the pilots; #pilots, its old name, opens it). The first two
  // are one form, saved from either.
  // Notifications (#notifications): the Web Push key desktop notifications use (settings/webPush).
  // BOLD Agent (#bold-agent): who writes the lab's home letters (settings/homeLetter, functions/bold-llm.js), saved as it's chosen.
  var TABS = [['slack', 'Slack'], ['join', 'Join form'], ['notifications', 'Notifications'], ['bold-agent', 'BOLD Agent'], ['features', 'Features']];
  var letterLab = null, letterBusy = false, letterError = '';
  // Who writes the home letters: one choice (settings/homeLetter: writer 'rules', or 'claude' with model 'claude' or
  // 'sofya', functions/bold-llm.js; Sofya with Claude whenever it fails).
  var WRITERS = [
    ['rules', 'Rule-based', 'Each home page puts its letter together as it opens, from what’s waiting, the meetings and the lab. Nothing is sent anywhere; Talking to BOLD is off.'],
    ['claude', 'Claude', 'Anthropic’s Claude (Sonnet 5.5) writes everyone’s letter, from what each person can see, and answers Talking to BOLD on the home page. What it reads of each person’s day is sent to Anthropic, and the lab pays for it.'],
    ['sofya', 'Sofya', 'BOLD’s own LLM (llm.bold-lab.ai, Qwen) does the same. Every request to it is logged for training. Claude steps in when it’s down.'],
  ];
  // The choice as stored → 'rules', 'claude' or 'sofya'.
  function writerOf(x){ return !x || x.writer !== 'claude' ? 'rules' : x.model === 'sofya' ? 'sofya' : 'claude'; }
  // How often BOLD LLM writes them (functions/home-letter.js REFRESH); each letter covers what changed since the last.
  var REFRESHES = [
    ['daily', 'Once a day', 'At 06:00.'],
    ['twice', 'Twice a day', 'At 06:00 and 13:00.'],
    ['working', 'Through the working day', 'At 06:00, 09:00, 12:00, 15:00 and 18:00. Five times the letters, and five times the cost.'],
  ];
  function letterHtml(){
    if (letterLab === null) return '<p class="proj-msg">Loading&hellip;</p>';
    var cur = writerOf(letterLab), every = letterLab.refresh || 'daily', on = cur !== 'rules';
    return '<div class="event-form join-form"><fieldset class="md-group"><legend>Who writes the home letters</legend>' +
      '<p class="proj-meta">The letter that opens everyone’s home page, and who answers Talking to BOLD.</p>' +
      WRITERS.map(function(w){
        return '<label class="jn-check"><input type="radio" name="st-letter" value="' + w[0] + '"' + (cur === w[0] ? ' checked' : '') + (letterBusy ? ' disabled' : '') + '> <span><strong>' + esc(w[1]) + '</strong>: ' + esc(w[2]) + '</span></label>';
      }).join('') +
      (letterError ? '<p class="st-error">' + esc(letterError) + '</p>' : '') +
      '</fieldset><fieldset class="md-group"><legend>How often they’re written</legend>' +
      '<p class="proj-meta">Each letter covers what changed since that person’s last one (London time). Someone opening their page with no letter from the last day gets one written then.</p>' +
      REFRESHES.map(function(r){
        return '<label class="jn-check"><input type="radio" name="st-refresh" value="' + r[0] + '"' + (every === r[0] ? ' checked' : '') + (letterBusy || !on ? ' disabled' : '') +
          (!on ? ' title="Only while Claude or Sofya writes them"' : '') + '> <span><strong>' + esc(r[1]) + '</strong>: ' + esc(r[2]) + '</span></label>';
      }).join('') +
      (letterLab.updatedBy ? '<p class="proj-meta">Set by ' + esc(letterLab.updatedBy) + ', ' + esc(new Date(letterLab.updatedAt || 0).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) + '.</p>' : '') +
      '</fieldset></div>';
  }
  // How often: a plain change, telling nobody (its cost is in the choice's words).
  function saveRefresh(refresh){
    var was = (letterLab || {}).refresh || 'daily';
    letterBusy = true; letterError = ''; drawLetter();
    db.collection('settings').doc('homeLetter').set({ refresh: refresh, updatedAt: Date.now(), updatedBy: me.email }, { merge: true })
      .catch(function(err){ console.error('[BOLD Settings] saving how often failed', err); letterError = 'Couldn’t save it — try again.'; letterLab = Object.assign({}, letterLab, { refresh: was }); })
      .then(function(){ letterBusy = false; drawLetter(); });
  }
  function drawLetter(){ var x = document.getElementById('bold-agent'); if (x) x.innerHTML = letterHtml(); }
  // Asked first: it changes where everyone's day is sent.
  function saveLetter(choice){
    var was = letterLab || {}, from = writerOf(was);
    var where = { claude: 'Anthropic (Claude)', sofya: 'Sofya (llm.bold-lab.ai), where every request is logged for training' };
    BOLD.confirmAction({ always: true, go: 'Switch',
      title: choice === 'rules' ? 'Go back to rule-based letters?' : choice === 'claude' ? 'Have Claude write the home letters?' : 'Have Sofya write the home letters?',
      effects: choice === 'rules' ? ['Everyone’s home page shows the rule-based letter, and Talking to BOLD is off', 'Nothing more is sent to ' + (from === 'sofya' ? 'Sofya' : 'Anthropic')]
        : ['For everyone on BOLD.OS in the last 30 days: send what they can see of their day to ' + where[choice] + ' at the hours below, and when they talk to BOLD',
          choice === 'sofya' ? 'Claude writes and answers whenever Sofya is down' : 'The lab pays for each letter and answer'] })
      .then(function(ok){
        if (!ok) { drawLetter(); return; }
        letterBusy = true; letterError = ''; drawLetter();
        var set = choice === 'rules' ? { writer: 'rules' } : { writer: 'claude', model: choice };
        db.collection('settings').doc('homeLetter').set(Object.assign(set, { updatedAt: Date.now(), updatedBy: me.email }), { merge: true })
          .catch(function(err){ console.error('[BOLD Settings] saving who writes the letters failed', err); letterError = 'Couldn’t save it — try again.'; letterLab = was; })
          .then(function(){ letterBusy = false; drawLetter(); });
      });
  }
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
    var save = '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save jr-save"' + (saving.settings.busy ? ' disabled' : '') + '>' + (saving.settings.busy || 'Save settings') + '</button>' + savedNote('settings') + '</div>';
    var row = function(label, inner, err){ return '<div class="st-row"><span class="st-row-label">' + esc(label) + '</span>' + inner + (err ? '<p class="st-error">' + esc(err) + '</p>' : '') + '</div>'; };
    // Each tab its own box; the Slack and Join form tabs are one form (.jr-settings).
    return '<nav class="guide-tabs profile-tabs" id="stTabs" aria-label="Settings">' + TABS.map(function(t){ return '<a class="guide-tab" href="#' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' +
      '<div class="jr-settings">' +
      '<section class="profile-panel" id="slack"><div class="event-form join-form">' +
      group('Slack invite') + '<label>Link (in Slack: Invite people → Copy invite link; replace it when it expires)<input type="url" class="jr-invite" maxlength="300" value="' + esc(inv.slackInviteUrl || '') + '" placeholder="https://join.slack.com/t/…"></label>' +
      '<label>Expires on (PIs and admins hear 3 days before)<input type="date" class="jr-expires" value="' + esc(inv.slackInviteExpires || '') + '"></label></fieldset>' +
      group('Slack channels') + '<p class="proj-meta">Everyone in a group, and in the groups above it, is added to its channels (<a href="boldiquette.html#who-is-bold">Who is BOLD</a>). None: nobody is added.</p>' +
        BoldJoin.CATEGORIES.map(function(c){
          return row(c[1], chipsHtml('chan', c[0], chanList((groups.channels || {})[c[0]]), 'group'), (groups.channelErrors || {})[c[0]]);
        }).join('') + '</fieldset>' + group('Slack channels by role') + '<p class="proj-meta">Everyone with a role (on their details) is added to its channels. The roles are the join form’s (<a href="#join">Join form</a>).</p>' +
        (f.roles || BoldJoin.ROLES).map(function(r){
          return row(r, chipsHtml('chan', r, chanList((groups.roleChannels || {})[r]), 'role'), (groups.roleChannelErrors || {})[r]);
        }).join('') + '</fieldset>' + save + '</div><div id="stAlign" class="event-form join-form st-align">' + alignHtml() + '</div></section>' +
      '<section class="profile-panel" id="join"><div class="event-form join-form">' + group('Join form') +
      row('Roles', chipsHtml('role', '', f.roles || BoldJoin.ROLES)) +
      row('Research pillars', chipsHtml('pillar', '', f.pillars || BoldJoin.PILLARS)) + '</fieldset>' +
      group('Welcome email') + '<label>Subject<input type="text" class="jr-subject" maxlength="200" value="' + esc(inv.subject || SUBJECT) + '"></label>' +
      '<label>Text ({name}: their first name, {slackInvite}: the invite link, on the Slack tab, {site}: BOLD.OS)<textarea class="jr-body no-tags" rows="14" maxlength="5000">' + esc(inv.body || BODY) + '</textarea></label></fieldset>' +
      save + '</div></section>' +
      '<section class="profile-panel" id="notifications"><div class="event-form join-form">' + group('Desktop notifications') +
      '<p class="proj-meta">The public key of the project’s Web Push certificate (Firebase console › Project settings › Cloud Messaging › Web Push certificates). Public: browsers hand it to their push service. Empty: Notifications doesn’t offer desktop notifications.</p>' +
      '<label>Web Push key<input type="text" class="jr-push-key" maxlength="200" spellcheck="false" autocomplete="off" value="' + esc((webPush || {}).publicKey || '') + '" placeholder="B…"></label></fieldset>' +
      save + '</div></section></div>' +
      '<section class="profile-panel" id="bold-agent">' + letterHtml() + '</section>' +
      '<section class="profile-panel" id="features">' + pilotHtml() + '</section>';
  }
  function showTab(){
    var tabs = document.getElementById('stTabs');
    if (!tabs) return;
    var h = location.hash.slice(1) === 'pilots' ? 'features' : location.hash.slice(1), want = TABS.some(function(t){ return t[0] === h; }) ? h : 'slack';
    TABS.forEach(function(t){ var x = document.getElementById(t[0]); if (x) x.hidden = t[0] !== want; });
    Array.prototype.forEach.call(tabs.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);

  // ---------- Pilots ----------
  // The features (functions/index.js PILOTS and LIVE_FEATURES) by what they're about, in this
  // order; one in no group shows under Other.
  var GROUPS = [
    ['Projects and boards', ['project-announce', 'card-added', 'card-comments', 'card-done', 'project-invites', 'supervision-requests']],
    ['Internal Review', ['irb-board', 'irb-reviews-out', 'irb-author-cap', 'venue-proposed', 'venue-calls']],
    ['Proposed changes and comments', ['proposals', 'proposal-decided', 'proposal-reviewer', 'guide-comments', 'tags']],
    ['Requests', ['join-requests', 'inviter-confirm', 'group-requests', 'invite-link-reminder', 'agent-requests']],
    ['Service desk', ['letters', 'introductions']],
    ['Events', ['series-added', 'series-due']],
  ];
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
    return '<div class="event-form join-form jr-pilot"><fieldset class="md-group"><legend>Slack features</legend>' +
      '<p class="proj-meta">Every Slack message BOLD.OS sends belongs to one of these features. One that isn’t live messages only its testers: each message goes to them instead, saying whom it was for. New ones start that way.</p>' +
      '<label>Testers of every pilot</label>' + testersHtml(d.testers, '', 'Nobody') +
      (keys.length ? GROUPS.concat([['Other', []]]).map(function(g){
        // Other: whatever isn't in a group yet (a new feature: add it to GROUPS).
        var mine = g[0] === 'Other' ? keys.filter(function(k){ return !GROUPS.some(function(x){ return x[1].indexOf(k) >= 0; }); })
          : g[1].filter(function(k){ return known[k]; });
        // A label that starts with its group's name ("Internal Review: …") is shown without it.
        return mine.length ? '<h3 class="jr-feature-group">' + esc(g[0]) + '</h3>' + mine.map(function(k){ return featureHtml(k, g[0]); }).join('') : '';
      }).join('') : '<p class="proj-meta">None yet: a feature appears here once it’s deployed.</p>') +
      '</fieldset>' + (pilotError ? '<p class="ev-error">' + esc(pilotError) + '</p>' : '') +
      '<div class="event-form-actions"><button type="button" class="ev-save jr-pilot-save"' + (saving.pilot.busy ? ' disabled' : pilotDraft ? '' : ' disabled title="Nothing changed"') + '>' + (saving.pilot.busy || 'Save features') + '</button>' +
        (pilotDraft && !saving.pilot.busy ? '<button type="button" class="jr-pilot-cancel">Cancel</button>' : '') + savedNote('pilot') + '</div></div>';
    function featureHtml(k, group){
        var label = known[k].indexOf(group + ': ') === 0 ? known[k].slice(group.length + 2) : known[k];
        label = label.charAt(0).toUpperCase() + label.slice(1);
        return '<div class="jr-feature"><label class="jn-check"><input type="checkbox" class="jr-live" data-key="' + esc(k) + '"' + (d.live[k] ? ' checked' : '') + '> ' + esc(label) + ' <span class="proj-meta">· ' + (d.live[k] ? 'live: messages everyone it’s for' : 'in pilot: testers only') + '</span></label>' +
          (d.live[k] ? '' : '<p class="proj-meta">Its own testers, besides those of every pilot:</p>' + testersHtml(d.pilotTesters[k] || [], k, 'None')) + '</div>';
    }
  }
  function savePilot(btn){
    var d = pilotNow(), was = (pilot || {}).live || {}, known = (pilot || {}).known || {};
    var goingLive = Object.keys(d.live).filter(function(k){ return d.live[k] && !was[k]; });
    // Going live reaches everyone each feature is for: asked every time (the ground rule).
    (goingLive.length ? BOLD.confirmAlways({ title: 'Make ' + (goingLive.length === 1 ? 'it' : 'them') + ' live?', go: 'Make live',
      effects: goingLive.map(function(k){ return 'Let ' + (known[k] || k) + ' message everyone it’s for on Slack, not just the testers'; }) }) : Promise.resolve(true)).then(function(ok){
      if (!ok) return;
      pilotError = ''; busyNow(btn, 'pilot', 'Saving…');
      db.collection('settings').doc('pilot').set({ testers: d.testers, pilotTesters: d.pilotTesters, live: d.live, updatedAt: Date.now(), updatedBy: me.email }, { merge: true }).then(function(){
        pilotDraft = null; saving.pilot = { busy: '', at: Date.now() }; render();
      }).catch(function(err){ console.error('[BOLD Settings] saving the pilots failed', err); saving.pilot.busy = ''; pilotError = 'Couldn’t save — try again.'; render(); });
    });
  }

  // ---------- Align channels with BOLD.OS ----------
  function when(ms){ return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function tomorrowAt10(){
    var d = new Date(Date.now() + 86400000), z = function(n){ return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T10:00';
  }
  var WHY = { group: function(c){ return 'for ' + c.for + '; they’re ' + c.group; }, 'no-record': function(){ return 'never joined BOLD.OS'; },
    project: function(c){ return 'not on ' + c.title; }, outside: function(){ return 'an account from another workspace'; } };
  function alignHtml(){
    var st = align.status, pv = align.preview, live = st ? st.live : null;
    var pending = st && st.runs.filter(function(r){ return !r.cancelledAt && !r.doneAt; })[0];
    var h = '<fieldset class="md-group"><legend>Align channels with BOLD.OS</legend>' +
      '<p class="proj-meta">Removes whoever isn’t meant to be in a group’s channel (above) or a project’s, and BOLD OS tells each of them where from, why and how to get back in. PIs, admins and bots stay. It’s worked out again when it runs.</p>';
    if (live === false) h += '<p class="st-error">Make “Slack channels follow BOLD.OS” live on the <a href="#features">Features</a> tab first: until then, a run removes nobody.</p>';
    h += '<div class="event-controls"><button type="button" class="btn-text st-align-preview"' + (align.busy ? ' disabled' : '') + '>' + (align.busy === 'preview' ? 'Working it out…' : pv ? 'Preview again' : 'Preview') + '</button></div>';
    if (pv) {
      var n = pv.plan.reduce(function(t, p){ return t + p.channels.length; }, 0);
      h += '<p class="proj-meta">' + pv.plan.length + ' people would leave ' + n + ' channel memberships, across the ' + pv.channels + ' channels checked.' +
        (pv.unseen.length ? ' Not checked (the bot isn’t in them): ' + pv.unseen.map(function(c){ return '#' + esc(c); }).join(', ') + '.' : '') + '</p>' +
        '<ul class="st-align-list">' + pv.plan.map(function(p){
          return '<li><details><summary><strong>' + esc(p.name || p.slackId) + '</strong>: ' + p.channels.map(function(c){ return '#' + esc(c.name) + ' <span class="proj-meta">(' + esc(WHY[c.why](c)) + ')</span>'; }).join(', ') + '</summary>' +
            '<pre class="st-align-msg">' + esc(p.message) + '</pre></details></li>';
        }).join('') + '</ul>';
    }
    if (pending && pending.startedAt) {
      h += '<p class="st-align-when"><strong>Running since ' + esc(when(pending.startedAt)) + '</strong>: ' + (pending.planned ? pending.done + ' of ' + pending.planned + ' people done.' : 'working out who leaves.') +
        ' <button type="button" class="btn-text st-align-refresh">Refresh</button></p>';
    } else if (pending) {
      h += '<p class="st-align-when"><strong>Scheduled for ' + esc(when(pending.scheduledFor)) + '</strong>, by ' + esc(pending.by) + '. ' +
        '<button type="button" class="btn-text danger st-align-cancel" data-id="' + esc(pending.id) + '"' + (align.busy ? ' disabled' : '') + '>Cancel it</button></p>';
    } else {
      h += '<div class="st-align-schedule"><label>Run it at (your time)<input type="datetime-local" class="st-align-at" value="' + esc(align.at || tomorrowAt10()) + '"></label>' +
        '<button type="button" class="ev-save st-align-go"' + (align.busy || !st ? ' disabled' : '') + (pv ? '' : ' title="Preview it first"') + '>' + (align.busy === 'schedule' ? 'Scheduling…' : 'Schedule') + '</button></div>';
    }
    var done = st ? st.runs.filter(function(r){ return r.doneAt || r.cancelledAt; }) : [];
    if (done.length) h += '<p class="proj-meta">Before: ' + done.map(function(r){
      return r.cancelledAt ? 'one for ' + esc(when(r.scheduledFor)) + ', cancelled' : esc(when(r.doneAt)) + ': ' + (r.error ? esc(r.error) : r.removed + ' removals, ' + r.people + ' people told' +
        (r.failed ? ', ' + r.failed + ' with some not removed' : '') + (r.untold ? ', ' + r.untold + ' not told' : ''));
    }).join('; ') + '.</p>';
    return h + (align.error ? '<p class="ev-error">' + esc(align.error) + '</p>' : '') + '</fieldset>';
  }
  function drawAlign(){ var el = document.getElementById('stAlign'); if (el) el.innerHTML = alignHtml(); }
  function callAlign(data){ return firebase.app().functions('europe-west2').httpsCallable('channelAlignment', { timeout: 300000 })(data).then(function(r){ return r.data; }); }
  function loadAlign(){ callAlign({ action: 'status' }).then(function(d){ align.status = d; drawAlign(); }, function(err){ console.error('[BOLD Settings] channel alignment status failed', err); align.error = 'Couldn’t load the channel alignment — reload to try again.'; drawAlign(); }); }
  function previewAlign(){
    align.busy = 'preview'; align.error = ''; drawAlign();
    callAlign({ action: 'preview' }).then(function(d){ align.preview = d; align.status = { live: d.live, runs: d.runs }; align.busy = ''; drawAlign(); },
      function(err){ console.error('[BOLD Settings] previewing the alignment failed', err); align.busy = ''; align.error = 'Couldn’t work it out: ' + (err.message || 'try again') + '.'; drawAlign(); });
  }
  function scheduleAlign(){
    var v = (document.querySelector('.st-align-at') || {}).value || '', at = new Date(v).getTime();
    align.at = v;
    if (!v || !(at > Date.now())) { align.error = 'Pick a time from now on.'; drawAlign(); return; }
    var pv = align.preview, n = pv ? pv.plan.length : 0, live = align.status && align.status.live;
    BOLD.confirmAlways({ title: 'Schedule it for ' + when(at) + '?', go: 'Schedule', effects: [
      'At ' + when(at) + ', remove from Slack channels whoever isn’t meant to be in them' + (pv ? ' (' + n + ' people, as previewed, worked out again then)' : ''),
      'Send each of them a message from BOLD OS: where from, why, and how to get back in',
      live ? '' : 'Nothing happens unless “Slack channels follow BOLD.OS” is live on the Features tab by then',
    ].filter(Boolean) }).then(function(ok){
      if (!ok) return;
      align.busy = 'schedule'; align.error = ''; drawAlign();
      callAlign({ action: 'schedule', at: at }).then(function(){ align.busy = ''; loadAlign(); },
        function(err){ align.busy = ''; align.error = err.message || 'Couldn’t schedule it — try again.'; drawAlign(); });
    });
  }
  function cancelAlign(id){
    BOLD.confirmAlways({ title: 'Cancel it?', go: 'Cancel it', effects: ['Nobody is removed from a channel, and nobody is messaged'] }).then(function(ok){
      if (!ok) return;
      align.busy = 'cancel'; drawAlign();
      callAlign({ action: 'cancel', id: id }).then(function(){ align.busy = ''; loadAlign(); }, function(err){ align.busy = ''; align.error = err.message || 'Couldn’t cancel it.'; drawAlign(); });
    });
  }

  function render(){
    if (!me) return;
    if (staff === false) { main.innerHTML = '<p class="proj-msg">Only PIs and admins see and change BOLD.OS’s settings.</p>'; return; }
    if (staff === null || invite === null || form === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    // Settings being changed aren't redrawn over: only the Features tab is.
    if (editing) { var pp = document.getElementById('features'); if (pp) pp.innerHTML = pilotHtml(); return; }
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
      groups: { channels: channels, roleChannels: roleChannels },
      push: { publicKey: v('.jr-push-key').trim() }
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
      channels[g].split(', ').forEach(function(n){ if (before.indexOf(n) < 0) { added.push(g === 'pan' ? 'Invite everyone on the BOLD Slack to #' + n + ', and whoever joins it later' : 'Invite everyone in ' + BoldJoin.categoryLabel(g) + ' and the groups above it to #' + n + ' on Slack'); newNames.push(n); } });
    });
    var hadRoles = (groups && groups.roleChannels) || {};
    Object.keys(roleChannels).forEach(function(r){
      var before = String(hadRoles[r] || '').split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); });
      roleChannels[r].split(', ').forEach(function(n){ if (before.indexOf(n) < 0) { added.push('Invite everyone whose role is ' + r + ' to #' + n + ' on Slack'); newNames.push(n); } });
    });
    // A channel the bot can't see (a typo, or a private one it isn't in) isn't saved: nobody
    // would be added to it, and nobody would know (checkGroupChannels).
    err.hidden = true; busyNow(btn, 'settings', newNames.length ? 'Checking the channels…' : 'Saving…');
    var idle = function(){ saving.settings.busy = ''; btn.disabled = false; btn.textContent = 'Save settings'; };
    checkChannels(newNames).then(function(missing){
      if (missing) { idle(); err.textContent = missing; err.hidden = false; return; }
      (added.length ? BOLD.confirmAlways({ title: 'Save the settings?', go: 'Save', effects: added }) : Promise.resolve(true)).then(function(ok){
        if (ok) writeSettings(btn, err, mine); else idle();
      });
    }).catch(function(e){
      idle();
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
  var SETTINGS_DOCS = { invite: 'joinInvite', form: 'joinForm', groups: 'groups', push: 'webPush' };
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
    // A channel that failed is tried again by saving (onGroupChannels), even with nothing changed.
    var failed = Object.keys(groups.channelErrors || {}).length || Object.keys(groups.roleChannelErrors || {}).length;
    if (failed && keys.indexOf('groups') < 0) keys.push('groups');
    err.hidden = true; busyNow(btn, 'settings', 'Saving…');
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
      editing = false; saving.settings = { busy: '', at: Date.now() };
      render();
    }).catch(function(e){
      console.error('[BOLD Settings] saving the settings failed', e);
      saving.settings.busy = ''; btn.disabled = false; btn.textContent = 'Save settings';
      err.textContent = 'Couldn’t save — try again.'; err.hidden = false;
    });
  }

  main.addEventListener('change', function(e){
    var t = e.target;
    if (t.classList.contains('jr-tester-add') && t.value) { pilotDraft = pilotNow(); testersOf(pilotDraft, t.getAttribute('data-for')).push(t.value); render(); return; }
    if (t.classList.contains('jr-live')) { pilotDraft = pilotNow(); pilotDraft.live[t.getAttribute('data-key')] = t.checked; render(); }
    if (t.name === 'st-letter') saveLetter(t.value);
    if (t.name === 'st-refresh') saveRefresh(t.value);
  });
  main.addEventListener('input', function(e){ if (e.target.classList.contains('st-align-at')) align.at = e.target.value; });
  main.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && e.target.classList.contains('st-chip-in')) { e.preventDefault(); addChip(e.target.closest('.st-chips')); }
  });
  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('st-chip-add')) { addChip(t.closest('.st-chips')); return; }
    if (t.classList.contains('st-chip-x')) { t.closest('.kw-chip').remove(); editing = true; return; }
    if (t.classList.contains('jr-save')) { saveSettings(t); return; }
    if (t.classList.contains('st-align-preview')) { previewAlign(); return; }
    if (t.classList.contains('st-align-refresh')) { loadAlign(); return; }
    if (t.classList.contains('st-align-go')) { scheduleAlign(); return; }
    if (t.classList.contains('st-align-cancel')) { cancelAlign(t.getAttribute('data-id')); return; }
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
      watch('pilot', function(x){ var was = pilot && (pilot.live || {})['channel-alignment']; pilot = x; if (align.status && was !== (x.live || {})['channel-alignment']) loadAlign(); });
      watch('webPush', function(x){ webPush = x; });
      watch('homeLetter', function(x){ letterLab = x; drawLetter(); });
      loadAlign();
    }).catch(function(err){ console.error('[BOLD Settings] checking access failed', err); staff = false; render(); });
  });
})();
