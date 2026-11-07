// BOLD LLM: the home letter's inputs and checks (functions/home-letter.js) and Talking to BOLD's (functions/bold-llm.js).
const test = require('node:test');
const assert = require('node:assert');
const HL = require('../functions/home-letter.js');
const { chatMessages, toolText, MODEL } = require('../functions/bold-llm.js');

test('BOLD LLM is Claude Sonnet 5.5 until Sofya runs', () => {
  assert.strictEqual(MODEL, 'claude-sonnet-5-5');
});

test('a letter needs both lengths, within their limits', () => {
  assert.deepStrictEqual(HL.checkLetter({ short: ' Hi. ', long: 'Hello.' }), { letter: { short: 'Hi.', long: 'Hello.' } });
  assert.match(HL.checkLetter({ short: '', long: 'x' }).error, /short/);
  assert.match(HL.checkLetter({ short: 'x' }).error, /long/);
  assert.match(HL.checkLetter({ short: 'x'.repeat(HL.SHORT_MAX + 1), long: 'x' }).error, /too long/);
  assert.match(HL.checkLetter(null).error, /short/);
});

test('a letter is today’s for 24 hours', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.ok(HL.isFresh({ at: now - 23 * 3600000 }, now));
  assert.ok(!HL.isFresh({ at: now - 25 * 3600000 }, now));
  assert.ok(!HL.isFresh(null, now));
});

test('the inputs: their week is the meetings they’re in, not paused; dates as ISO; London time', () => {
  const now = Date.parse('2026-11-09T07:30:00Z');   // a Monday
  const x = HL.inputsOf({ now, since: now - 86400000, person: { first_name: 'Ada', group: 'internal', pi_or_admin: false },
    waiting: [{ kind: 'join', title: 'Join BOLD: Robin', by: { name: 'Robin Rivers' }, since: now - 3600000, url: 'u' }],
    calendar: { project_meetings: [{ project: 'World models', when: 'Mondays 14:00', you_are_in_it: true, url: 'p' }, { project: 'Other', when: 'x', you_are_in_it: false },
      { project: 'Paused', when: 'y', you_are_in_it: true, paused: true }], lab_meetings: [{ title: 'Hamming', when: 'Wednesdays', you_are_invited: true, url: 's' }] },
    events: [{ title: 'Festival', start: '2027-06-01', end: '2027-06-03', place: 'Oxford', url: 'e' }],
    mine: { projects: [{ title: 'World models' }] }, notes: [{ text: 'Pat replied', at: now, read: false, href: 'n' }],
    conversations: [{ title: 'Compute', name: 'Ines', replies: 0, lastAt: now, yours: true, url: 'c' }], changes: [{ title: 'BOLDiquette', collection: 'handbook', note: 'n', by: { name: 'Pat' }, at: now }] });
  assert.deepStrictEqual(x.now, { date: '2026-11-09', weekday: 'Monday', time: '07:30', time_zone: 'Europe/London' });
  assert.deepStrictEqual(x.your_week.map((m) => m.title), ['World models', 'Hamming']);
  assert.strictEqual(x.waiting_on_you[0].from, 'Robin Rivers');
  assert.strictEqual(x.conversations[0].waits_for_an_answer, true);
  assert.strictEqual(x.os_changes.content[0].by, 'Pat');
  assert.strictEqual(x.since, new Date(now - 86400000).toISOString());
});

test('the conversation: theirs last, alternating roles from the first of theirs, each message bounded', () => {
  assert.deepStrictEqual(chatMessages([{ role: 'user', text: ' Hi ' }]).messages, [{ role: 'user', content: 'Hi' }]);
  // A leading answer (from before they wrote) is dropped: the API starts with theirs.
  assert.deepStrictEqual(chatMessages([{ role: 'assistant', text: 'Hello' }, { role: 'user', text: 'Q' }]).messages, [{ role: 'user', content: 'Q' }]);
  assert.match(chatMessages([{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A' }]).error, /yours/);
  assert.match(chatMessages([]).error, /Say something/);
  assert.match(chatMessages([{ role: 'user', text: 'x'.repeat(4001) }]).error, /too long/);
  // Only the last 20 turns go.
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: String(i) }));
  many.push({ role: 'user', text: 'last' });
  assert.ok(chatMessages(many).messages.length <= 20);
});

test('a tool’s result is JSON, cut when long', () => {
  assert.strictEqual(toolText({ a: 1 }), '{"a":1}');
  assert.match(toolText('x'.repeat(40000)), /\[cut: ask for less\]$/);
});

test('how often: the hours BOLD LLM writes at, once a day by default', () => {
  assert.ok(HL.writesAt('daily', 6) && !HL.writesAt('daily', 13));
  assert.ok(HL.writesAt('twice', 13) && !HL.writesAt('twice', 9));
  assert.deepStrictEqual(HL.REFRESH.working.filter((h) => HL.writesAt('working', h)), [6, 9, 12, 15, 18]);
  assert.ok(HL.writesAt(undefined, 6) && !HL.writesAt('nonsense', 7));
});

test('a letter covers what changed since the previous one, at most a day', () => {
  const now = Date.parse('2026-11-09T13:00:00Z');
  assert.strictEqual(HL.sinceFor({ at: now - 7 * 3600000 }, now), now - 7 * 3600000);
  assert.strictEqual(HL.sinceFor({ at: now - 30 * 3600000 }, now), now - 24 * 3600000);
  assert.strictEqual(HL.sinceFor(null, now), now - 24 * 3600000);
});
