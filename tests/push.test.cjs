// Desktop notifications: what a push says and where it opens.
const test = require('node:test');
const assert = require('node:assert');
const { pushMessage, goneToken, idOf } = require('../functions/push.js');

test('a push: BOLD.OS, the text on one line, the icon, and its link (or the Notifications page)', () => {
  const m = pushMessage('Ann put you on\n#7 “Fix it”.', 'https://x.org/p', 'https://s/');
  assert.strictEqual(m.webpush.notification.title, 'BOLD.OS');
  assert.strictEqual(m.webpush.notification.body, 'Ann put you on #7 “Fix it”.');
  assert.strictEqual(m.webpush.notification.icon, 'https://s/assets/img/icon-192.png');
  assert.strictEqual(m.webpush.fcmOptions.link, 'https://x.org/p');
  assert.strictEqual(pushMessage('x', '', 'https://s/').webpush.fcmOptions.link, 'https://s/notifications.html');
  assert.strictEqual(pushMessage('x'.repeat(300), '', 'https://s/').webpush.notification.body.length, 238);
});

test('a token the push service has forgotten is removed; others are kept', () => {
  assert.ok(goneToken('messaging/registration-token-not-registered'));
  assert.ok(!goneToken('messaging/internal-error'));
  assert.match(idOf('abc'), /^[0-9a-f]{40}$/);
});

test('a meeting about to start pushes with a Join button opening its link', () => {
  const { pushMessage } = require('../functions/push.js');
  const m = pushMessage('“P” starts in 5 minutes.', 'https://meet.google.com/x', 'https://s/', { join: 'https://meet.google.com/x' });
  require('node:assert').deepStrictEqual(m.webpush.notification.actions, [{ action: 'join', title: 'Join' }]);
  require('node:assert').strictEqual(m.webpush.data.join, 'https://meet.google.com/x');
  require('node:assert').strictEqual(pushMessage('hi', '', 'https://s/').webpush.data, undefined);
});
