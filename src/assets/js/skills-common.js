// Skills — each one a Claude skill, skills/{name} in Firestore: { name, title,
// description, body, files: [{ path, content }], createdAt, createdBy,
// updatedAt, updatedBy }. Its package is the folder Claude loads: SKILL.md (YAML
// front matter `name` and `description`, then `body`) plus `files`, served as a
// .zip by the skillPackage function (functions/index.js). Only PIs/admins write
// them (firestore.rules). Shared by the skills page (the list, "+ Add a skill")
// and a skill's page (skill.html?skill=<name>).
window.BoldSkills = (function(){
  var esc = BOLD.escapeHtml;
  var NOT_PI = 'Only PIs and admins can add and change skills';
  var PACKAGE = 'https://europe-west2-bold-d7ff2.cloudfunctions.net/skillPackage?skill=';
  // Claude's limits on SKILL.md's front matter.
  var NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var MAX_DESCRIPTION = 1024;

  function packageUrl(name){ return PACKAGE + encodeURIComponent(name); }
  function installCommand(name){
    var zip = '/tmp/' + name + '.zip';
    return 'curl -sL "' + packageUrl(name) + '" -o ' + zip + ' && unzip -o ' + zip + ' -d ~/.claude/skills';
  }

  // The fields every skill has, filled from x (a skill, or {} for a new one).
  // The name is the skill's id, so it's set once, when the skill is added.
  function metaHtml(x, isNew){
    return '<label>Title<input type="text" class="sk-title" value="' + esc(x.title || '') + '" placeholder="e.g. Presenting"></label>' +
      (isNew ? '<label>Name<input type="text" class="sk-name" value="' + esc(x.name || '') + '" placeholder="e.g. bold-presenting" spellcheck="false" autocapitalize="off"></label>' +
        '<p class="event-form-hint">The skill’s folder name: lowercase letters, numbers and hyphens. It can’t be changed later.</p>' : '') +
      '<label>Description<textarea class="sk-description" rows="4" maxlength="' + MAX_DESCRIPTION + '">' + esc(x.description || '') + '</textarea></label>' +
      '<p class="event-form-hint">What the skill does and when to use it. Claude reads only this to decide when to load the skill.</p>';
  }

  // → { fields } or { error }.
  function readMeta(form, isNew){
    var v = function(c){ var el = form.querySelector(c); return el ? el.value.trim() : ''; };
    var f = { title: v('.sk-title'), description: v('.sk-description') };
    if (isNew) f.name = v('.sk-name');
    var error = !f.title ? 'Give the skill a title.' :
      isNew && !NAME.test(f.name) ? 'The name can only have lowercase letters, numbers and single hyphens.' :
      isNew && f.name.length > 64 ? 'The name can be at most 64 characters.' :
      isNew && /anthropic|claude/.test(f.name) ? 'Claude doesn’t accept “anthropic” or “claude” in a skill’s name.' :
      !f.description ? 'Describe what the skill does and when to use it.' :
      f.description.length > MAX_DESCRIPTION ? 'The description can be at most ' + MAX_DESCRIPTION + ' characters.' :
      /[<>]/.test(f.description) ? 'Claude doesn’t accept < or > in a description.' : '';
    return error ? { error: error } : { fields: f };
  }

  function showError(form, msg){
    var box = form.querySelector('.ev-error');
    box.textContent = msg; box.hidden = !msg;
  }

  // Whether the signed-in user is a PI/admin (getMyAccess); cb(bool).
  function access(cb){
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
      cb(!!(r.data && r.data.fullWrite));
    }).catch(function(err){ console.error('[BOLD Skills] access check failed', err); cb(false); });
  }

  return { NOT_PI: NOT_PI, NAME: NAME, packageUrl: packageUrl, installCommand: installCommand,
    metaHtml: metaHtml, readMeta: readMeta, showError: showError, access: access };
})();
