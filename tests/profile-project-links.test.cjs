const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('every project title on the profile opens the project page with its board context', () => {
  const page = fs.readFileSync(require.resolve('../src/pages/profile.html'), 'utf8');
  const { document, window } = parseHTML('<html><body>' + page.slice(page.indexOf('<div')) + '</body></html>');
  const venueProject = { title: 'Submitted project', cardId: 'paper#1', boardId: 'venue&year' };
  const looseProject = { title: 'Unassigned project', cardId: 'project-2', boardId: null };
  const projects = { owner: [venueProject, looseProject], author: [venueProject], member: [venueProject], reviewer: [venueProject] };
  const email = 'member@example.test';

  // Open the real Projects tab with a cached getMyProjects response.
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/pages/profile.js'), 'utf8'), {
    document, window, location: { hash: '#projects' },
    BOLD: { getAuth: () => ({}), authHint: () => ({ e: email }), onAccess() {}, onUser() {} },
    localStorage: { getItem: key => key === 'boldProfile:getMyProjects:' + email ? JSON.stringify({ d: projects }) : null }
  });

  for (const group of ['Owner', 'Author', 'Member', 'Reviewer']) {
    const title = document.querySelector('#proj' + group + ' .proj-title');
    assert.equal(title.getAttribute('href'), 'project.html#id=paper%231&board=venue%26year', group);
  }
  assert.equal(document.querySelector('#projOwner li:last-child a').getAttribute('href'), 'project.html#id=project-2');
});
