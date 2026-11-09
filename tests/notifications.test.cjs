// Notifications: what a Slack message says, kept as plain text with its link.
const test = require('node:test');
const assert = require('node:assert');
const { slackToPlain } = require('../functions/index.js')._internal;

test('Slack’s links, people, channels and styles become plain text; its first link is kept', () => {
  const r = slackToPlain('🔔 *#12* <https://x.org/a|New venue> for <@U1|Pat>, in <#C1|general>: _see_ <https://x.org/b> &amp; more');
  assert.strictEqual(r.text, '🔔 #12 New venue for @Pat, in #general: see https://x.org/b & more');
  assert.strictEqual(r.href, 'https://x.org/a');
  assert.deepStrictEqual(slackToPlain('No link here'), { text: 'No link here', href: '' });
  assert.strictEqual(slackToPlain('<@U9> replied').text, '@someone replied');
});
