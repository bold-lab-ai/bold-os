const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),context={window:{},URL};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/registry-links.js'),'utf8'),context);
const {formatText}=context.window.BOLDRegistryLinks;

test('problem facts link repository and session references without changing the text',()=>{
  const repo='https://github.com/example/evaluator/tree/abc';
  const session='https://lite.example.org/lite?project=abc&review=evaluator';
  const html=formatText('Code: '+repo+'. Resume: '+session);
  assert.ok(html.includes('href="'+repo+'"'));
  assert.ok(html.includes('href="https://lite.example.org/lite?project=abc&amp;review=evaluator"'));
  assert.match(html,/<\/a>\. Resume:/);
  assert.equal((html.match(/rel="noopener noreferrer"/g)||[]).length,2);
});

test('problem facts keep markup, unsafe protocols and credential URLs inert',()=>{
  const html=formatText('<img src=x onerror=alert(1)> javascript:alert(1) http://example.org https://user:secret@example.org');
  assert.doesNotMatch(html,/<a |<img/);
  assert.match(html,/&lt;img/);
});

test('quotes cannot become attributes in a linked fact',()=>{
  const html=formatText('https://example.org/\" onclick=\"alert(1)');
  assert.match(html,/href="https:\/\/example.org\/" target="_blank"/);
  assert.match(html,/&quot; onclick=&quot;/);
  assert.doesNotMatch(html,/<a[^>]*onclick=/);
});
