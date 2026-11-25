const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/research-graph-model.js'),'utf8'), context);
const {build, search, neighbors, project} = context.window.BoldResearchGraphModel;
const ids = list => Array.from(list, node => node.id);

const objectives = [
  {id:'bp', title:'Beyond Backpropagation', kind:'pillar'},
  {id:'hcld', title:'Human-Centric Learning & Discovery', kind:'pillar'},
  {id:'el', title:'Embodied Learning', kind:'pillar'}
];
const robot = {id:'robot',title:'When should a warehouse robot ask for help?', stage:'checked'};
const peer = {id:'peer',title:'How much attention does an intervention need?'};
const disconnected = {id:'loose',title:'An unclassified soil measurement'};
const edge = (from,to,kind = 'contributes_to') => ({from,to,kind});
const data = {objectives, problems:[robot,peer,disconnected], edges:[
  edge('robot','hcld'), edge('robot','el'), edge('peer','robot','related_to')
]};

function verifyGeometry(view) {
  for (const node of view.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(node.x >= 82.5 && node.x <= view.width - 82.5);
    assert.ok(node.y >= 21 && node.y + 60 <= view.height);
  }
  for (const [i,a] of view.nodes.entries()) for (const b of view.nodes.slice(i+1)) {
    assert.ok(Math.abs(a.x-b.x) > 165 || Math.abs(a.y-b.y) > 80, 'node and label fit without overlap');
  }
}

test('overview and focus share one warehouse problem across its pillars', () => {
  const index = build(data,false);
  const overview = project(index);
  assert.equal(ids(overview.nodes).filter(id => id === 'robot').length,1);
  assert.equal(overview.edges.filter(e => e.from === 'robot' && e.kind === 'contributes_to').length,2);
  assert.ok(!ids(overview.nodes).includes('loose'));
  assert.deepEqual(ids(search(index,'soil unclassified')),['loose']);
  const focused = project(index,'robot');
  assert.deepEqual(ids(neighbors(index,'robot').parents),['el','hcld']);
  assert.deepEqual(ids(neighbors(index,'robot').related),['peer']);
  assert.deepEqual(ids(neighbors(index,'hcld').children),['robot']);
  assert.equal(focused.nodes.length,4);
  assert.equal(focused.omitted,0);
  assert.deepEqual(new Set(ids(focused.nodes)),new Set(['robot','el','hcld','peer']));
  verifyGeometry(overview);
  verifyGeometry(focused);
});

test('repeated, dangling and archived relations never produce extra marks', () => {
  const family = {...data, problems:[...data.problems, {...robot}, {id:'old',title:'Former task',archived:true}],
    edges:[...data.edges,edge('robot','peer','related_to'),edge('robot','el'),edge('robot','old'),edge('robot','missing'),edge('peer','peer')]};
  const index = build(family,false);
  assert.equal(index.nodes.size,6);
  assert.equal(index.edges.length,3);
  assert.deepEqual(ids(neighbors(index,'robot').related),['peer']);
  assert.equal(search(index,'former').length,0);
  assert.ok(!project(index,'old').focusId);
  const history = build(family,true);
  assert.ok(ids(project(history,'old').nodes).includes('robot'));
  assert.equal(search(history,'former')[0].archived,true);
});

test('large neighborhoods retain every peer in the inspector and search', () => {
  const wide = Array.from({length:240},(_,i) => ({id:'p'+i,title:'Problem '+i}));
  const index = build({objectives, problems:wide, edges:wide.map(p => edge(p.id,'el'))},false);
  const view = project(index,'el');
  assert.equal(view.nodes.length,9);
  assert.equal(view.omitted,232);
  assert.equal(neighbors(index,'el').children.length,240);
  assert.deepEqual(ids(search(index,'problem 239')),['p239']);
  verifyGeometry(view);
});

test('long paths, single nodes and empty graphs keep a finite drawing area', () => {
  const connected = Array.from({length:100},(_,i) => ({id:'n'+i,title:'Problem '+i}));
  const family = {objectives,problems:connected,edges:connected.map((p,i) => edge(p.id,i?'n'+(i-1):'el'))};
  const chain = project(build(family,false));
  verifyGeometry(chain);
  assert.ok(chain.height <= 600);
  assert.ok(chain.omitted > 0);
  const single = build({objectives:[],problems:[robot],edges:[]},false);
  assert.deepEqual(ids(project(single).nodes),['robot']);
  verifyGeometry(project(single,'robot'));
  const empty = project(build({objectives:[],problems:[],edges:[]},false));
  assert.equal(empty.nodes.length,0);
  assert.ok(empty.width && empty.height);
});
