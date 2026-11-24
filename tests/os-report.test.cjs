// Telling BOLD.OS what's wrong or what it should do (functions/os-report.js): Sofya's extra guidance while they
// report, and the card drafted from the talk for BOLD OS's board.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const R = require('../functions/os-report');

test('only bug and feature are intents; guidance only while reporting', () => {
  assert.equal(R.intentOf('bug'), 'bug');
  assert.equal(R.intentOf('feature'), 'feature');
  assert.equal(R.intentOf('toString'), '');
  assert.equal(R.intentOf(null), '');
  assert.equal(R.guidance(''), '');
  assert.match(R.guidance('bug'), /Add it to the board/);
  assert.match(R.guidance('bug'), /Never say it has been filed/);
  assert.match(R.guidance('feature'), /something new/);
});

test('a bug card: severity in the title, its sections as headings, nothing it wasn’t given', () => {
  const c = R.cardOf({title: 'Bug: Calendar shows the wrong day', severity: 'blocks', sections: {
    'Where': 'calendar.html', 'What happened': 'Monday shows as Sunday', 'Steps to reproduce': '', 'Invented': 'x'}}, 'bug');
  assert.equal(c.title, 'Bug (blocks me): Calendar shows the wrong day');
  assert.equal(c.kind, 'code');
  assert.match(c.notes, /^\*\*Severity:\*\* Blocks me/);
  assert.match(c.notes, /### Where\ncalendar\.html/);
  assert.doesNotMatch(c.notes, /Steps to reproduce|Invented/);
});

test('a feature card is a request; a severity there is ignored; no title is an error', () => {
  const c = R.cardOf({title: 'Export my week as PDF', severity: 'blocks', sections: {'Why it matters': 'For my supervisor'}}, 'feature');
  assert.equal(c.title, 'Feature request: Export my week as PDF');
  assert.equal(c.kind, 'request');
  assert.doesNotMatch(c.notes, /Severity/);
  assert.throws(() => R.cardOf({title: ' '}, 'bug'), /couldn’t draft/);
  assert.throws(() => R.cardOf({title: 'x'}, 'other'), /Report a bug/);
  assert.match(R.cardPrompt('bug'), /"What happened": ""/);
});
