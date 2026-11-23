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
