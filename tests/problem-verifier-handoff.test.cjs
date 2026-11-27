const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');

const script = fs.readFileSync(require.resolve('../src/assets/js/pages/problem.js'), 'utf8');
const id = 'ak-' + '3'.repeat(24);
const token = '1a'.repeat(32);

async function page({configured, permitted, reason, confirm = true, handoff = token, projects = [], problem = {}} = {}) {
  const {document} = parseHTML('<html><head></head><body><p id="detailMsg"></p><div id="problemBody"></div></body></html>');
  const requests = [], visits = [];
  const location = {search:'?problem='+id, hash:'#tab=releases',assign:url => visits.push(new URL(url))};
  const callable = async data => {
    if (data.action === 'projects') return {data:{items:projects}};
    if (data.action === 'get') return {data:{handoff_enabled:configured,
      problem:{id,title:'Rates & kinetics',objective:'Measure decay',stage:'open',papers:[],projects,handoff_enabled:permitted,handoff_unavailable_reason:reason,...problem}}};
    assert.equal(data.action,'issue_verifier_handoff');
    requests.push(JSON.parse(JSON.stringify(data)));
    if (handoff instanceof Error) throw handoff;
    return {data:{handoff}};
  };
  const BOLD = {getAuth:()=>true,escapeHtml:String,can:()=>true,confirmAction:async()=>confirm,
    onUser:callback=>callback({uid:'test'}),onAccess:()=>{}};
  const urls = {autokaggleLiteUrl:'https://lite.example/lite'};
  vm.runInNewContext(script,{BOLD,document,location,URL,URLSearchParams,BoldProblemCategory:require('../functions/problem-category'),
    firebase:{app:()=>({functions:()=>({httpsCallable:()=>callable})})},
    BOLDRegistryLinks:{defaults:urls,serviceUrl:v=>v,loadServiceUrls:async()=>urls},
    BoldProblemPapers:{unavailableReason:()=>''}});
  await new Promise(resolve=>setImmediate(resolve));
  const button = document.getElementById('addVerifier');
  return {document,requests,visits,button,launch:()=>button.onclick()};
}

test('consent issues a single-use handoff for this problem and the chosen project', async()=>{
  const ui = await page({configured:true,permitted:true,projects:[{id:'robot',title:'Robot',board:'venue'}]});
  ui.document.querySelector('#verifierProject option[value="0"]').selected = true;
  await ui.launch();
  assert.deepEqual(ui.requests,[{action:'issue_verifier_handoff',problem_id:id,project_id:'robot',project_board:'venue'}]);
  const url = ui.visits[0], fields = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.origin+url.pathname, 'https://lite.example/lite/from-problem');
  assert.equal(url.search,'');
  assert.deepEqual(Object.fromEntries(fields),{problem:id,category:'method',builds_benchmark:'0',title:'Rates & kinetics',question:'Measure decay',project:'robot',board:'venue',handoff:token});
});

test('cancel and missing authorization cannot issue a ticket or navigate', async()=>{
  for (const opts of [{configured:true,permitted:true,confirm:false},{configured:true,permitted:false}]) {
    const ui = await page(opts);
    await ui.launch();
    assert.equal(ui.requests.length,0);
    assert.equal(ui.visits.length,0);
  }
});

test('a failed or invalid handoff keeps the user on the problem with a retry', async()=>{
  for (const handoff of ['', 'unexpected', new Error('failed-precondition')]) {
    const ui = await page({configured:true,permitted:true,handoff});
    await ui.launch();
    assert.deepEqual(ui.requests,[{action:'issue_verifier_handoff',problem_id:id}]);
    assert.equal(ui.visits.length,0);
    assert.match(ui.document.getElementById('detailMsg').textContent,/try again/);
    assert.equal(ui.button.disabled,false);
  }
});

test('legacy deployments still launch a verifier with its problem and no project', async()=>{
  const ui = await page();
  await ui.launch();
  assert.equal(ui.requests.length,0);
  const fields = new URLSearchParams(ui.visits[0].hash.slice(1));
  assert.equal(fields.get('problem'),id);
  assert.equal(fields.has('handoff'),false);
  assert.equal(fields.has('project'),false);
});

test('partially configured and read-only handoffs stay blocked even when no availability flag arrives', async()=>{
  for (const [permitted,reason] of [[false,'Ask the administrator to configure the connection.'],[undefined,'You need permission to edit projects.']]) {
    const ui=await page({configured:true,permitted,reason});
    assert.equal(ui.button.disabled,true);
    assert.ok(ui.document.getElementById('problemBody').textContent.includes(reason));
    ui.button.disabled=false; // The navigation handler also checks the saved member permission.
    await ui.launch();
    assert.deepEqual(ui.visits,[]); assert.deepEqual(ui.requests,[]);
  }
});

test('only a method problem offers Add verifier: a benchmark and an open question show that none is required', async()=>{
  const method = await page({problem:{category:'method'}});
  assert.ok(method.button);
  assert.match(method.document.getElementById('problemBody').textContent,/No verifier/);
  for (const [problem,label] of [[{category:'benchmark',builds_benchmark:true},'Benchmark'],[{builds_benchmark:true},'Benchmark'],
      [{category:'open_question',inspiration:'Loss falls twice.'},'Open question']]) {
    const ui = await page({configured:true,permitted:true,problem});
    assert.equal(ui.button,null);
    const text = ui.document.getElementById('problemBody').textContent;
    assert.match(text,/Verifier not required/);
    assert.equal(ui.document.querySelector('.detail-head .badge').textContent,label);
    assert.doesNotMatch(text,/No verifier/);
    assert.equal(ui.document.getElementById('toggleReminder'),null);
  }
  const open_question = await page({problem:{category:'open_question',inspiration:'Loss falls twice.'}});
  assert.match(open_question.document.getElementById('problemBody').textContent,/This problem is an open question\. A verifier is not required\./);
});

test('a problem saved before categories is a method, and its link to Lite states the category', async()=>{
  const ui = await page();
  await ui.launch();
  const fields = new URLSearchParams(ui.visits[0].hash.slice(1));
  assert.equal(fields.get('category'),'method');
  assert.equal(fields.get('builds_benchmark'),'0'); // For a Lite from before categories.
});
