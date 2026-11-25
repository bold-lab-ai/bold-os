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

test('a benchmark launch goes to the Lite base without a session or handoff',()=>{
  const {serviceUrl} = context.window.BOLDRegistryLinks;
  assert.equal(serviceUrl('https://lite.example.org/lite?project=a#secret'), 'https://lite.example.org/lite');
  for (const invalid of ['https://user:pass@example.org', 'http://example.org', 'javascript:alert(1)', 'http://localhost:8888/lite']){
    assert.equal(serviceUrl(invalid), '');
  }
  const demo = {window:{BOLD_TEST:true}, URL};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/registry-links.js'),'utf8'), demo);
  assert.equal(demo.window.BOLDRegistryLinks.serviceUrl('http://localhost:8888/lite'), 'http://localhost:8888/lite');
});

test('Research lists the Problem Bank; old Benchmarks bookmarks lead there', async () => {
  const site = (await import('../src/_data/site.js')).default;
  const research = site.nav.find(group => group.label === 'Research').links;
  assert.ok(research.some(link => link.href === 'problems.html'));
  assert.ok(!research.some(link => link.href === 'benchmarks.html'));
  const redirect = fs.readFileSync(require.resolve('../src/pages/benchmarks.html'), 'utf8');
  assert.match(redirect, /http-equiv="refresh" content="0; url=problems\.html"/);
  assert.match(redirect, /href="problems\.html"/);
});
