const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const page = { els: {}, escapeHtml: s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;') };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/audit-board/detail.js'), 'utf8'), page);

function navigation(card) {
  return parseHTML(page.cardNavigationHtml(card, 'venue&year', 'Venue & Year')).document;
}

test('a venue card links to the project overview using the card and board that store it', () => {
  const nav = navigation({ id: 'card#2', projectId: 'original-project' });
  const overview = nav.querySelector('a[href^="project.html"]');
  assert.equal(overview.textContent, 'Project overview');
  assert.equal(overview.getAttribute('href'), 'project.html#id=card%232&board=venue%26year');
  assert.match(nav.querySelector('#detailBack').textContent, /Back to Venue & Year/);
});

test('past papers and missing cards have only the link back to the venue', () => {
  for (const card of [{ id: 'old-paper', registrationKind: 'past_paper' }, null]) {
    const nav = navigation(card);
    assert.equal(nav.querySelectorAll('a').length, 1);
    assert.ok(nav.querySelector('#detailBack'));
  }
});
