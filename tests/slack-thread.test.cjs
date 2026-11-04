// A Slack thread brought into Conversations (functions/slack-thread.js, 2026-11-04): which links,
// which channels, and what comes back. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { parseSlackLink, slackPlain, mayRead, threadOf, postIdOf } = require('../functions/slack-thread.js');

test('a message link, or a reply’s, points to its thread', () => {
  assert.deepStrictEqual(parseSlackLink('https://bold-lab.slack.com/archives/C0BB6MPNTSS/p1730700000123456'), { channel: 'C0BB6MPNTSS', ts: '1730700000.123456', thread: '1730700000.123456' });
  assert.deepStrictEqual(parseSlackLink('https://bold-lab.slack.com/archives/C0BB6MPNTSS/p1730700999000001?thread_ts=1730700000.123456&cid=C0BB6MPNTSS').thread, '1730700000.123456');
  for (const bad of ['', 'not a link', 'http://bold-lab.slack.com/archives/C1/p1730700000123456', 'https://evil.com/archives/C1/p1730700000123456', 'https://slack.com.evil.com/archives/C1/p1730700000123456', 'https://bold-lab.slack.com/archives/C1']) {
    assert.strictEqual(parseSlackLink(bad), null, bad);
  }
});

test('only what you can read in Slack yourself: never a DM', () => {
  assert.strictEqual(mayRead({ is_private: false }, false), true);
  assert.strictEqual(mayRead({ is_private: true }, false), false);
  assert.strictEqual(mayRead({ is_private: true }, true), true);
  assert.strictEqual(mayRead({ is_mpim: true }, false), false);
  assert.strictEqual(mayRead({ is_im: true }, true), false);
  assert.strictEqual(mayRead(null, true), false);
});

test('Slack’s formatting comes out as plain text, with names', () => {
  assert.strictEqual(slackPlain('Hi <@U1>, see <https://x.org|the doc> and <https://y.org> in <#C2|general> &amp; <!here>', { U1: 'Ari' }), 'Hi @Ari, see the doc and https://y.org in #general & @here');
});

test('the first message is the post, the rest its replies; joins and leaves are left out', () => {
  const t = threadOf([
    { ts: '1730700000.000100', user: 'U1', text: 'Thursdays?' },
    { ts: '1730700060.000200', subtype: 'channel_join', user: 'U3', text: 'joined' },
    { ts: '1730700120.000300', user: 'U2', text: 'Yes <@U1>' },
  ], { U1: 'Ari', U2: 'Pat' });
  assert.deepStrictEqual(t.post, { who: 'Ari', text: 'Thursdays?', title: 'Thursdays?', at: 1730700000000 });
  assert.deepStrictEqual(t.replies, [{ who: 'Pat', text: 'Yes @[Ari](U1)', at: 1730700120000 }]);
  assert.strictEqual(threadOf([], {}), null);
});

test('a thread has one post, whichever way it came in', () => {
  assert.strictEqual(postIdOf('C0BB6MPNTSS', '1730700000.123456'), 'slack-C0BB6MPNTSS-1730700000123456');
  const a = parseSlackLink('https://bold-lab.slack.com/archives/C1/p1730700000123456');
  const b = parseSlackLink('https://bold-lab.slack.com/archives/C1/p1730700999000001?thread_ts=1730700000.123456&cid=C1');
  assert.strictEqual(postIdOf(a.channel, a.thread), postIdOf(b.channel, b.thread));
});

test('Slack’s formatting comes in as Markdown: lines, lists and their nesting, styles, links, people', () => {
  const { slackMarkdown, mrkdwnToMarkdown } = require('../functions/slack-thread.js');
  const m = { text: 'fallback', blocks: [{ type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'Plan for ' }, { type: 'text', text: 'Thursday', style: { bold: true } }, { type: 'text', text: ':\nfirst line\nsecond line\n' }] },
    { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'room ' }, { type: 'link', url: 'https://x.org', text: 'booked' }] }] },
    { type: 'rich_text_list', style: 'bullet', indent: 1, elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U1' }, { type: 'text', text: ' brings ' }, { type: 'text', text: 'snacks', style: { code: true } }] }] },
    { type: 'rich_text_list', style: 'ordered', indent: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] }, { type: 'rich_text_section', elements: [{ type: 'text', text: 'two' }] }] },
    { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted' }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'x = 1' }] },
    { type: 'rich_text_section', elements: [{ type: 'emoji', name: 'thumbsup', unicode: '1f44d' }] },
  ] }] };
  assert.strictEqual(slackMarkdown(m, { U1: 'Ari' }),
    'Plan for **Thursday**:\nfirst line\nsecond line\n\n- room [booked](https://x.org)\n  - @[Ari](U1) brings `snacks`\n1. one\n2. two\n\n> quoted\n\n```\nx = 1\n```\n\n👍');
  assert.strictEqual(mrkdwnToMarkdown('*Bold* and _it_ ~gone~\n• a\n• <https://x.org|b>\nhi <@U1>', { U1: 'Ari' }),
    '**Bold** and *it* ~~gone~~\n- a\n- [b](https://x.org)\nhi @[Ari](U1)');
});
