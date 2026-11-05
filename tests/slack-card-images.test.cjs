// Images on a card added from Slack (/bug, /feature-request): only images within a card's limits.
const test = require('node:test');
const assert = require('node:assert');
const { slackImagesOf } = require('../functions/index.js')._internal;

const img = (o) => Object.assign({ id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 1000, url_private_download: 'https://files.slack.com/files-pri/T-F1/download/shot.png' }, o);

test('Slack’s images come through, as the card keeps them', () => {
  assert.deepStrictEqual(slackImagesOf([img()]), [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 1000, url: 'https://files.slack.com/files-pri/T-F1/download/shot.png' }]);
});

test('not an image, too big, not from Slack, or more than five: left out', () => {
  assert.strictEqual(slackImagesOf([img({ mimetype: 'application/pdf' })]).length, 0);
  assert.strictEqual(slackImagesOf([img({ size: 11 * 1024 * 1024 })]).length, 0);
  assert.strictEqual(slackImagesOf([img({ url_private_download: 'https://example.com/x.png' })]).length, 0);
  assert.strictEqual(slackImagesOf([img(), img(), img(), img(), img(), img()]).length, 5);
  assert.deepStrictEqual(slackImagesOf(undefined), []);
});
