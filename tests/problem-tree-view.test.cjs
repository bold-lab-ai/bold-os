const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/problem-tree.js'), 'utf8'), context);
const {buildIndex} = context.window.BoldProblemTree;

function fixture(){
  return {
    objectives:[{id:'pillar-1',title:'First pillar',kind:'pillar'},{id:'moon-1',title:'Second objective',kind:'moonshot'}],
    problems:[{id:'broader',title:'Broader problem',stage:'checked'},{id:'shared',title:'Shared question',stage:'validated'},
      {id:'loose',title:'Unclassified question'},{id:'narrow',title:'Narrow question'}],
    edges:[{from:'broader',to:'pillar-1',kind:'contributes_to'},{from:'shared',to:'broader',kind:'contributes_to'},
      {from:'shared',to:'moon-1',kind:'contributes_to'},{from:'narrow',to:'loose',kind:'contributes_to'},
      {from:'narrow',to:'broader',kind:'related_to'}]
  };
}
const ids = items => Array.from(items, x=>x.id);

test('a shared problem keeps its identity and stage under every broader question or objective',()=>{
  const index = buildIndex(fixture(),false);
  assert.deepEqual(ids(index.objectives),['pillar-1','moon-1']);
  assert.deepEqual(ids(index.children.get('pillar-1')),['broader']);
  assert.equal(index.children.get('broader')[0],index.children.get('moon-1')[0]);
  assert.equal(index.children.get('broader')[0].stage,'validated');
  assert.deepEqual(ids(index.parents.get('shared')),['broader','moon-1']);
  assert.deepEqual(ids(index.unclassified),['loose']);
  assert.equal(index.classified.has('narrow'),false);
  assert.deepEqual(ids(index.children.get('loose')),['narrow']);
});

test('archiving a parent retains historical paths and surfaces newly unclassified active research',()=>{
  const data = fixture(); data.objectives[0].archived = true;
  const active = buildIndex(data,false), historical = buildIndex(data,true);
  assert.deepEqual(ids(active.unclassified),['broader','loose']);
  assert.equal(active.classified.has('shared'),true);
  assert.equal(active.children.has('pillar-1'),false);
  assert.deepEqual(ids(historical.unclassified),['loose']);
  assert.deepEqual(ids(historical.children.get('pillar-1')),['broader']);
});

test('a dense graph can be indexed without expanding every path',()=>{
  const data = {objectives:[{id:'objective',title:'Research',kind:'moonshot'}],problems:[],edges:[]};
  let parents = ['objective'];
  for (let depth=0; depth<45; depth++) {
    const next = [depth+'a',depth+'b'];
    for (const id of next) {
      data.problems.push({id,title:id});
      for (const parent of parents) data.edges.push({from:id,to:parent,kind:'contributes_to'});
    }
    parents = next;
  }
  const index = buildIndex(data,false);
  assert.equal(index.classified.size,91);
  assert.equal(index.problems.length,90);
  assert.equal(index.unclassified.length,0);
});
