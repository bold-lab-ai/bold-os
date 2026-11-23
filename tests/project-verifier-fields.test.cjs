const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {window:{BoldProjectVerifiers}} = vm.runInNewContext(
  fs.readFileSync(require.resolve('../src/assets/js/project-verifiers.js'),'utf8')+';({window})',
  {window:{}}
);
const read = (...args) => JSON.parse(JSON.stringify(BoldProjectVerifiers.readPlan(...args)));

test('linked mode requires a release and omits deferral drafts', () => {
  assert.ok(read(false, [], 'Earlier reason', 'Week 3').error);
  assert.deepEqual(read(false, ['p1-v2', 'p2-v1'], 'Earlier reason', 'Week 3').plan,
    {mode:'linked', releaseIds:['p1-v2','p2-v1']});
});

test('deferral requires both fields, accepts approximate timing and ignores inactive selections', () => {
  assert.equal(read(true, [], '  ', 'Q1').field,'pfVerifierReason');
  assert.equal(read(true, [], 'Dataset pending', '  ').field,'pfVerifierExpected');
  assert.deepEqual(read(true, ['p1-v2'], '  Dataset pending  ', ' by Q1 ').plan,
    {mode:'deferred',reason:'Dataset pending',expectedOnboarding:'by Q1'});
});

test('a benchmark project submits only its purpose even with earlier draft selections', () => {
  assert.deepEqual(read(false, [], '', '', true), {plan:{mode:'benchmark'}});
  assert.deepEqual(read(true, ['p1-v2'], 'Old reason', 'Q1', true), {plan:{mode:'benchmark'}});
});

test('project benchmark choice follows the selected problem and survives a refresh', () => {
  const {parseHTML} = require('linkedom');
  const page = fs.readFileSync(require.resolve('../src/pages/projects-register.html'),'utf8');
  const {document} = parseHTML(page.slice(page.indexOf('<main>')));
  const context = {document,window:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/project-verifiers.js'),'utf8'),context);
  const form = context.window.BoldProjectVerifiers.mount(async () => ({items:[],cursor:null}));
  const choice = document.getElementById('pfBuildsBenchmark');
  const defer = document.getElementById('pfDeferVerifier');
  const picker = document.getElementById('pfVerifierPicker');
  form.selectProblem('first',true);
  assert.equal(choice.disabled,true);
  assert.equal(picker.hidden,true);
  assert.equal(form.read().plan.mode,'benchmark');
  form.selectProblem('second',false);
  assert.equal(choice.disabled,false);
  assert.equal(picker.hidden,false);
  defer.checked = true;
  choice.checked = true;
  choice.dispatchEvent(new document.defaultView.Event('change'));
  form.selectProblem('second',false);
  assert.equal(defer.checked,false);
  assert.equal(form.read().plan.mode,'benchmark');
  form.selectProblem('third',false);
  assert.equal(picker.hidden,false);
  assert.equal(form.read().field,'pfDeferVerifier');
});
