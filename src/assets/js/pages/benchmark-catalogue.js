(function () {
  'use strict';
  var list = document.getElementById('benchmarkReleases');
  if (!list || !BOLD.getAuth()) return;
  var status = document.getElementById('catalogueStatus');
  var more = document.getElementById('olderReleases');
  var stages = { implemented: 'Fully implemented', checked: 'Checked', validated: 'Validated on the actual task' };
  var revision = 0, cursor = null;

  function appendRelease(row) {
    var item = document.createElement('li');
    var link = document.createElement('a');
    link.textContent = row.title + ' · version ' + row.version;
    link.href = 'problem.html?problem=' + encodeURIComponent(row.problem_id) + '#tab=releases&release=' + encodeURIComponent(row.id);
    var note = document.createElement('small');
    note.textContent = row.problem_title + ' · ' + (stages[row.stage] || 'Stage unavailable');
    item.append(link, note);
    list.appendChild(item);
  }
  async function load() {
    var request = revision;
    more.disabled = true;
    status.textContent = 'Loading releases…';
    try {
      var call = firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry');
      var response = await call({ action: 'benchmark_catalogue', cursor: cursor });
      if (request !== revision) return;
      response.data.items.forEach(appendRelease);
      cursor = response.data.cursor;
      more.hidden = !cursor;
      more.textContent = 'Load older releases';
      status.textContent = list.children.length ? '' : cursor ? 'Older pages may contain active releases.' : 'No releases from active problems are registered yet.';
    } catch (e) {
      if (request !== revision) return;
      status.textContent = 'Could not load the releases.';
      more.textContent = 'Try again';
      more.hidden = false;
    } finally {
      if (request === revision) more.disabled = false;
    }
  }
  more.addEventListener('click', load);
  BOLD.onUser(function (user) {
    revision++;
    cursor = null;
    list.replaceChildren();
    status.textContent = '';
    more.hidden = true;
    if (user) load();
  });
})();
