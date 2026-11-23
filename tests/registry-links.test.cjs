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

// Drive the page's sign-in callback with a settings snapshot, including sign-out during a pending read.
function benchmarkPage(snapshot){
  const link = { removeAttribute(key){ delete this[key]; }, setAttribute(key, value){ this[key] = value; } };
  const status = {};
  let userChanged;
  const page = {
    window:{}, URL, document:{getElementById:id=>id === 'openBenchmarkLite' ? link : status},
    BOLD:{ getApp:()=>({}), getAuth:()=>({}), onUser:fn=>{userChanged=fn;} },
    firebase:{firestore(){return {collection(name){
      assert.equal(name, 'settings');
      return {doc(id){assert.equal(id, 'problemBank'); return {get:snapshot};}};
    }};}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/registry-links.js'),'utf8'), page);
  page.BOLDRegistryLinks = page.window.BOLDRegistryLinks;
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/pages/benchmarks.js'),'utf8'), page);
  return {link, status, userChanged, defaults:page.BOLDRegistryLinks.defaults};
}

test('the signed-in Benchmarks page uses the saved service or the Civo default when unset',async()=>{
  let saved;
  const page = benchmarkPage(async()=>({exists:!!saved, data:()=>saved}));
  await page.userChanged({});
  assert.equal(page.link.href, page.defaults.autokaggleLiteUrl);
  saved = {autokaggleLiteUrl:'https://lab.example/lite?project=other'};
  await page.userChanged({});
  assert.equal(page.link.href, 'https://lab.example/lite');
  assert.equal(page.link['aria-disabled'], undefined);
  saved = {autokaggleLiteUrl:'javascript:alert(1)'};
  await page.userChanged({});
  assert.equal(page.link.href, undefined);
  assert.match(page.status.textContent, /Settings/);
});

test('an unavailable setting or sign-out while loading leaves the launcher disabled',async()=>{
  let resolveRead;
  const page = benchmarkPage(()=>Promise.reject(new Error('offline')));
  await page.userChanged({});
  assert.equal(page.link.href, undefined);
  assert.match(page.status.textContent, /Reload/);
  const pending = benchmarkPage(()=>new Promise(resolve=>{resolveRead=resolve;}));
  const signingIn = pending.userChanged({});
  await pending.userChanged(null);
  resolveRead({exists:false});
  await signingIn;
  assert.equal(pending.link.href, undefined);
  assert.equal(pending.link['aria-disabled'], 'true');
});
