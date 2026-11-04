// A Slack thread brought into Conversations (functions/slack-thread.js, 2026-11-04): which links,
// which channels, and what comes back. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { parseSlackLink, slackPlain, mayRead, threadOf } = require('../functions/slack-thread.js');

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
  assert.deepStrictEqual(t.post, { who: 'Ari', text: 'Thursdays?', at: 1730700000000 });
  assert.deepStrictEqual(t.replies, [{ who: 'Pat', text: 'Yes @Ari', at: 1730700120000 }]);
  assert.strictEqual(threadOf([], {}), null);
});
