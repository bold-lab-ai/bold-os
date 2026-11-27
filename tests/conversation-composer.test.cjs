const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('the comment button opens an empty editor and submits only the reader’s draft', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  const source = fs.readFileSync(require.resolve('../src/assets/js/conversations-forum.js'), 'utf8');
  vm.runInNewContext(source, { document, window, BOLD: { escapeHtml: String }, Event: window.Event });
  const sent = [];
  const composer = window.BoldConversations.replyBox({
    label: 'Add a comment', button: 'Post comment', send: body => sent.push(body),
  });
  composer.into(document.body);
  const button = composer.el.querySelector('button');
  const form = composer.el.querySelector('form');
  const editor = form.querySelector('textarea');
  let focused = false;
  editor.focus = () => { focused = true; };
  assert.equal(button.textContent, 'Add a comment');
  assert.equal(form.parentNode.hidden, true);
  button.click();
  assert.equal(focused, true);
  assert.equal(editor.value, '');
  assert.equal(editor.getAttribute('placeholder'), 'Your comment');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(sent, []);
  assert.equal(form.parentNode.hidden, false);
  assert.equal(form.querySelector('button[type=submit]').textContent, 'Post comment');
  editor.value = 'My comment';
  composer.el.querySelector('.ha-close').click();
  button.click();
  assert.equal(editor.value, 'My comment');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.deepEqual(sent, ['My comment']);
  assert.equal(form.parentNode.hidden, true);
  assert.equal(editor.value, '');
});
