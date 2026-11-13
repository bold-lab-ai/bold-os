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

test('a letter is current once written since the letters were last due (04:00 London), not just in the last day', () => {
  // 2026-11-12, 10:00 London (GMT): yesterday afternoon's isn't this morning's; one from 04:00 on is.
  const now = Date.parse('2026-11-12T10:00:00Z');
  assert.strictEqual(new Date(HL.lastDue('daily', now)).toISOString(), '2026-11-12T04:00:00.000Z');
  assert.ok(!HL.isFresh({ at: Date.parse('2026-11-11T15:00:00Z') }, 'daily', now));
  assert.ok(HL.isFresh({ at: Date.parse('2026-11-12T04:03:00Z') }, 'daily', now));
  assert.ok(!HL.isFresh(null, 'daily', now));
  // Before 04:00: yesterday's 04:00 one is still current.
  const early = Date.parse('2026-11-12T03:30:00Z');
  assert.strictEqual(new Date(HL.lastDue('daily', early)).toISOString(), '2026-11-11T04:00:00.000Z');
  // Twice a day: after 13:00, the 13:00 one; through the working day before 04:00, yesterday's 18:00.
  assert.strictEqual(new Date(HL.lastDue('twice', Date.parse('2026-11-12T14:10:20Z'))).toISOString(), '2026-11-12T13:00:00.000Z');
  assert.strictEqual(new Date(HL.lastDue('working', early)).toISOString(), '2026-11-11T18:00:00.000Z');
  // Summer time (BST): 04:00 London is 03:00 UTC.
  assert.strictEqual(new Date(HL.lastDue('daily', Date.parse('2026-07-01T09:00:00Z'))).toISOString(), '2026-07-01T03:00:00.000Z');
  assert.ok(HL.writesAt('daily', 4) && !HL.writesAt('daily', 5));
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
  assert.ok(HL.writesAt('daily', 4) && !HL.writesAt('daily', 13));
  assert.ok(HL.writesAt('twice', 13) && !HL.writesAt('twice', 9));
  assert.deepStrictEqual(HL.REFRESH.working.filter((h) => HL.writesAt('working', h)), [4, 9, 12, 15, 18]);
  assert.ok(HL.writesAt(undefined, 4) && !HL.writesAt('nonsense', 7));
});

test('a letter covers what changed since the previous one, at most a day', () => {
  const now = Date.parse('2026-11-09T13:00:00Z');
  assert.strictEqual(HL.sinceFor({ at: now - 7 * 3600000 }, now), now - 7 * 3600000);
  assert.strictEqual(HL.sinceFor({ at: now - 30 * 3600000 }, now), now - 24 * 3600000);
  assert.strictEqual(HL.sinceFor(null, now), now - 24 * 3600000);
});

test('who writes the letters: a ladder, tried in turn; nothing below rule-based', () => {
  assert.deepStrictEqual(HL.ladderOf({ ladder: ['sofya', 'claude', 'rules'] }), ['sofya', 'claude', 'rules']);
  assert.deepStrictEqual(HL.ladderOf({ ladder: ['claude', 'claude', 'nonsense'] }), ['claude', 'sofya', 'rules']);
  // Set before ladders: from writer and model.
  assert.deepStrictEqual(HL.ladderOf({ writer: 'rules' }), ['rules', 'sofya', 'claude']);
  assert.deepStrictEqual(HL.ladderOf({ writer: 'claude' }), ['claude', 'rules', 'sofya']);
  assert.deepStrictEqual(HL.ladderOf({ writer: 'claude', model: 'sofya' }), ['sofya', 'claude', 'rules']);
  assert.deepStrictEqual(HL.ladderOf(null), ['rules', 'sofya', 'claude']);
  assert.deepStrictEqual(HL.modelsOf(['sofya', 'rules', 'claude']), ['sofya']);
  assert.deepStrictEqual(HL.modelsOf(['rules', 'claude', 'sofya']), []);
  assert.deepStrictEqual(HL.modelsOf(['claude', 'sofya', 'rules']), ['claude', 'sofya']);
});

test('the morning’s line: the past week only, whoever comes most often first, then the latest visit', () => {
  const now = Date.parse('2026-11-12T05:00:00Z'), D = 86400000;
  const line = HL.letterOrder([
    { email: 'daily@x', days: ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'] },
    { email: 'twice@x', days: ['2026-11-04', '2026-11-11'] },
    { email: 'twice-earlier@x', days: ['2026-11-03', '2026-11-09'] },
    { email: 'auth-only@x', days: [], lastSeen: now - 2 * D },          // before visits were kept: Auth's last visit counts
    { email: 'away@x', days: ['2026-10-30', '2026-11-01', '2026-11-02'], lastSeen: now - 10 * D },   // not this past week
    { email: 'gone@x', lastSeen: now - 20 * D },
  ], now).map((p) => p.email);
  assert.deepStrictEqual(line, ['daily@x', 'twice@x', 'twice-earlier@x', 'auth-only@x']);
  assert.strictEqual(HL.londonDate(Date.parse('2026-07-01T23:30:00Z')), '2026-07-02');   // London, in summer time
});

test('the facts worked out for the letter: days waited, GPU hours, deadlines, today and the next meeting', () => {
  const now = Date.parse('2026-11-12T17:45:00Z');   // Thursday, 17:45 London
  const f = HL.factsOf({
    waiting_on_you: [
      { kind: 'project-proposal', title: 'Proposed project: Trading Agent (20,000 GPU hours)', from: 'Valentin', since: '2026-11-06T10:00:00Z', url: 'v' },
      { kind: 'project-proposal', title: 'Proposed project: Benchmark (350 GPU hours)', from: 'Tobias', since: '2026-11-10T09:00:00Z', url: 't' },
      { kind: 'letter', title: 'Recommendation letter', from: 'Anubha', since: '2026-10-30T09:00:00Z', url: 'a' },
    ],
    your_letters: [{ with: 'Anubha', url: 'l', recipients: [{ name: 'Oxford', deadline: '2026-12-02', submitted: false }, { name: 'Cambridge', deadline: '2026-12-08', submitted: false }, { name: 'Done', deadline: '2026-11-20', submitted: true }] }],
    your_week: [
      { kind: 'project', title: 'Latent Option Models', when: 'Thursdays, 11:00–12:00 London time' },
      { kind: 'supervision', title: 'Credit Assignment', when: 'Thursdays, 17:30–18:30 London time' },
      { kind: 'project', title: 'AMAZE', when: 'Fridays, 10:00–11:00 London time' },
    ],
    os_changes: { content: [] },
  }, now);
  assert.deepStrictEqual(f.waiting_longest_first.map((w) => [w.from, w.days_waiting, w.gpu_hours]), [['Anubha', 13, undefined], ['Valentin', 6, 20000], ['Tobias', 2, 350]]);
  const p = f.waiting_by_kind.find((k) => k.kind === 'project-proposal');
  assert.deepStrictEqual([p.count, p.gpu_hours, p.longest_days, p.largest.from], [2, 20350, 6, 'Valentin']);
  assert.deepStrictEqual(f.deadlines_within_3_weeks.map((d) => [d.deadline, d.days_left]), [['2026-12-02', 20]]);   // 8 December is 26 days: not within three
  assert.deepStrictEqual(f.today.meetings.map((m) => [m.title, m.state]), [['Latent Option Models', 'done'], ['Credit Assignment', 'on now']]);
  assert.strictEqual(f.today.free_for_rest_of_today, false);
  assert.deepStrictEqual(f.next_meeting, { title: 'AMAZE', weekday: 'Friday', start: '10:00', url: undefined });
  assert.strictEqual(f.os_changes_count, 0);
  assert.strictEqual(HL.meetingOf('Mondays, 14:00–15:00 London time, every 2 weeks').fortnightly, true);
  // As functions/api.js gives them: { you_asked, you_write }.
  const g = HL.factsOf({ your_letters: { you_asked: [], you_write: [{ with: 'Anubha', recipients: [{ name: 'Oxford', deadline: '2026-12-02', submitted: false }] }] } }, now);
  assert.strictEqual(g.deadlines_within_3_weeks.length, 1);
  assert.deepStrictEqual(HL.factsOf({ your_letters: {}, your_week: null, waiting_on_you: null }, now).deadlines_within_3_weeks, []);
});
