const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const topics = require('../functions/conversation-topics');

test('shared topic names have stable ids and a suggested icon', async () => {
  assert.equal(topics.topicId(' Café Reading! '), 'cafe-reading');
  assert.equal(topics.topicId('話題'), '話題');
  assert.equal(topics.topicId(' - '), '');
  assert.equal(topics.suggestIcon('Reading group'), '📖');
  assert.ok(topics.suggestIcon('Other'));
  for (const topic of topics.starters) {
    assert.equal(topics.topicId(topic.name), topic.id);
    assert.equal(topics.suggestIcon(topic.name), topic.icon);
  }
  const db = { collection: () => ({ doc: id => ({ get: async () => ({ exists: id === 'advice' }) }) }) };
  assert.equal(await topics.exists(db, 'advice'), true);
  for (const id of [null, {}, 'unknown-topic', 'a/b', '_other']) assert.equal(await topics.exists(db, id), false);
});

test('topic records display emoji for both old symbols and new selections', () => {
  const topic = icon => topics.fromDoc({ id: 'my-project', data: () => ({ name: 'My project', icon }) });
  for (const [before, after] of [['☏', '☎️'], ['⚙', '⚙️'], ['whiteboard', '📄'], ['anything', '📄'], ['🧑‍🔬', '🧑‍🔬']]) {
    assert.equal(topic(before).icon, after);
  }
});

test('topic suggestions use phrases and whole words in the typed name', () => {
  const emojiNames = new Map([['polar_bear', '🐻‍❄️'], ['bear', '🐻'], ['planet', '🪐'], ['octopus', '🐙']]);
  for (const [name, icon] of [['Polar bear club', '🐻‍❄️'], ['Planet discussions', '🪐'], ['Octopus', '🐙'],
    ['Café meetup', '☕'], ['Machine learning', '🤖'], ['Summer hikes', '🥾']]) {
    assert.equal(topics.suggestIcon(name, emojiNames), icon);
  }
  assert.equal(topics.suggestIcon('Vellum Collective'), topics.suggestIcon('vellum collective'));
  assert.equal(topics.suggestIcon(''), '💬');
});

test('creating a topic selects it without submitting or resetting the draft', async () => {
  const { document, window } = parseHTML('<form><input name="title" value="My draft"><div class="slot"></div><textarea>Unfinished text</textarea></form>');
  const ctx = { document, BOLD: { escapeHtml: String }, ConversationTopics: topics };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/conversation-topic-picker.js'), 'utf8'), ctx);
  ctx.BoldEmoji = { names: async () => new Map([['telescope', '🔭']]),
    search: async query => query === 'octopus' ? [{ e: '🐙', name: 'octopus' }] : [] };
  const picker = ctx.conversationTopicPicker(document.querySelector('.slot'));
  picker.update(topics.starters);
  const q = s => document.querySelector(s);
  const input = (s, value) => { q(s).value = value; q(s).dispatchEvent(new window.Event('input')); };
  assert.equal(picker.required(), false);
  input('[type=search]', ' A ');
  assert.deepEqual(Array.from(q('.bs-topic-options').querySelectorAll('[data-topic]'), b => b.dataset.topic), ['about-bold', 'advice']);
  input('[type=search]', '');
  assert.equal(q('.bs-topic-options').children.length, topics.starters.length);
  input('[type=search]', 'adv');
  assert.equal(q('.bs-topic-options').children.length, 1);
  q('[data-topic=advice]').click();
  assert.equal(picker.value(), 'advice');
  picker.reset();
  input('[type=search]', 'Reading group');
  q('.bs-topic-new').click();
  const icon = q('.bs-topic-icon');
  assert.equal(icon.getAttribute('aria-label'), 'Choose icon: Book');
  input('.bs-topic-name', 'Telescope club'); await new Promise(setImmediate);
  assert.equal(icon.textContent, '🔭');
  icon.click();
  assert.equal(q('.bs-icon-panel input').getAttribute('placeholder'), 'Search all icons');
  assert.equal(q('.bs-icon-caption').hidden, false);
  input('.bs-icon-panel input', 'octopus');
  assert.equal(q('.bs-icon-caption').hidden, true);
  await new Promise(setImmediate);
  q('[data-icon="🐙"]').click();
  input('.bs-topic-name', 'Reading circle');
  assert.equal(icon.getAttribute('aria-label'), 'Choose icon: octopus');
  q('.bs-topic-save').click(); await new Promise(setImmediate);
  picker.update(topics.starters);
  assert.deepEqual({ ...picker.selection().newTopic }, { name: 'Reading circle', icon: '🐙' });
  assert.equal(q('summary').textContent, '🐙 Reading circle');
  assert.equal(q('.bs-topic-discard').hidden, false);
  assert.equal(q('.bs-topic-save').textContent, 'Create topic');
  assert.equal(picker.value(), 'reading-circle');
  q('.bs-topic-discard').click();
  assert.equal(picker.value(), '');
  assert.equal(q('.bs-topic-discard').hidden, true);
  assert.equal(q('[name=title]').value, 'My draft');
  assert.equal(q('textarea').value, 'Unfinished text');
  q('.bs-topic-new').click();
  input('.bs-topic-name', 'Paper club');
  icon.click();
  input('.bs-icon-panel input', 'file');
  await new Promise(setImmediate);
  const file = q('[data-icon="📄"]');
  assert.equal(file.getAttribute('aria-label'), 'Document');
  file.click();
  icon.click(); q('.bs-icon-restore').click();
  q('.bs-topic-save').click(); await new Promise(setImmediate);
  assert.equal(picker.selection().newTopic.icon, topics.suggestIcon('Paper club'));
  assert.equal(picker.required(), true);
  picker.update([...topics.starters, { id: 'paper-club', name: 'Paper Club', icon: '📝' }]);
  assert.equal(q('summary').textContent, '📝 Paper Club');
  assert.equal(picker.selection().newTopic, undefined);
  assert.equal(q('[data-remove-topic]').dataset.removeTopic, 'paper-club');
  picker.update(topics.starters);
  assert.equal(picker.required(), false);
});

test('saving while emoji names load uses the final topic name', async () => {
  const { document, window } = parseHTML('<div class="slot"></div>');
  let loadNames;
  const ctx = { document, BOLD: { escapeHtml: String }, ConversationTopics: topics,
    BoldEmoji: { names: () => new Promise(resolve => { loadNames = resolve; }) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/conversation-topic-picker.js'), 'utf8'), ctx);
  const picker = ctx.conversationTopicPicker(document.querySelector('.slot'));
  document.querySelector('.bs-topic-new').click();
  const field = document.querySelector('.bs-topic-name');
  for (const value of ['Coffee', 'Bear']) {
    field.value = value; field.dispatchEvent(new window.Event('input'));
  }
  document.querySelector('.bs-topic-save').click();
  loadNames(new Map([['bear', '🐻']]));
  await new Promise(setImmediate);
  assert.deepEqual({ ...picker.selection().newTopic }, { name: 'Bear', icon: '🐻' });
  picker.reset();
  assert.equal(picker.selection().newTopic, undefined);
});

test('a pending topic creation cannot select a topic in the next draft after cancel', async () => {
  const { document } = parseHTML('<div class="slot"></div>');
  const ctx = { document, BOLD: { escapeHtml: String }, ConversationTopics: topics };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/conversation-topic-picker.js'), 'utf8'), ctx);
  let finishSave;
  ctx.BoldEmoji = { names: () => new Promise(resolve => { finishSave = resolve; }) };
  const picker = ctx.conversationTopicPicker(document.querySelector('.slot'));
  picker.update(topics.starters);
  document.querySelector('[data-topic=advice]').click();
  document.querySelector('.bs-topic-new').click();
  document.querySelector('.bs-topic-name').value = 'Paper club';
  document.querySelector('.bs-topic-save').click();
  await new Promise(setImmediate);
  picker.reset();
  finishSave(new Map());
  await new Promise(setImmediate);
  assert.equal(document.querySelector('summary').textContent, 'Choose a topic');
  assert.equal(picker.value(), '');
  assert.equal(picker.required(), false);
  assert.equal(document.querySelector('.bs-topic-save').disabled, false);
});
