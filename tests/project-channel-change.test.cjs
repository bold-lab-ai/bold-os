// A project's channel changing (projectChannelChange): its people are then invited to the new one.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { projectChannelChange } = require('../functions/index.js')._internal;

test('a new channel is the change', () => {
  assert.strictEqual(projectChannelChange({ slackChannel: '#proj-lom' }, { slackChannel: '#proj-latent-option-models' }), 'proj-latent-option-models');
  assert.strictEqual(projectChannelChange({}, { slackChannel: '#proj-roar' }), 'proj-roar');
});
test('the same channel, or none, is no change', () => {
  assert.strictEqual(projectChannelChange({ slackChannel: '#proj-lom' }, { slackChannel: 'proj-lom' }), '');
  assert.strictEqual(projectChannelChange({ slackChannel: '#proj-lom' }, { slackChannel: '' }), '');
  assert.strictEqual(projectChannelChange(null, {}), '');
});
