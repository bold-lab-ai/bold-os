const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/assets/js/audit-board/modals.js'), 'utf8');

function board(){
  const data = new Map();
  const opened = [];
  const context = {
    localStorage: {getItem:key=>data.get(key) || null, setItem:(key,value)=>data.set(key,value), removeItem:key=>data.delete(key)},
    state: {view:'venue', currentBoardId:'venue-a', currentUser:{email:'pat'}, cards:[]},
    openCard:id=>opened.push(id)
  };
  vm.runInNewContext(source, context);
  return {context, data, opened};
}

test('old drafts restore, and the open problem and retry ID survive reopening for the same person and venue', ()=>{
  const {context, data} = board();
  const key = context.paperDraftKey('venue-a', 'pat');
  data.set('airb-draft-register:venue-a:pat', JSON.stringify({title:'Original draft', computeEstimate:'2 GPU-hours', note:'Review this.'}));
  assert.equal(context.readPaperDraft(key).title, 'Original draft');
  const draft = {...context.readPaperDraft(key), problemId:'active-problem', requestId:'same-on-retry'};
  context.savePaperDraft(key, draft);
  assert.deepEqual(JSON.parse(JSON.stringify(context.readPaperDraft(key))), draft);
  assert.equal(context.readPaperDraft(context.paperDraftKey('venue-b','pat')).title, undefined);
  assert.equal(context.readPaperDraft(context.paperDraftKey('venue-a','someone-else')).title, undefined);
  context.savePaperDraft(key, {title:' ',computeEstimate:'',note:'',problemId:''});
  assert.equal(data.has(key), false);
});

test('open a registered paper once when its venue snapshot arrives', ()=>{
  const {context, opened} = board();
  context.pendingPaperCard = {board:'venue-a', id:'paper', email:'pat'};
  context.openRegisteredPaper();
  assert.deepEqual(opened, []);
  context.state.cards = [{id:'other-paper'}, {id:'paper'}];
  context.openRegisteredPaper();
  context.openRegisteredPaper();
  assert.deepEqual(opened, ['paper']);
});

test('a late paper response cannot open a card for another signed-in person or venue', ()=>{
  for (const change of [{currentUser:{email:'someone-else'}}, {currentBoardId:'venue-b'}, {view:'card'}]){
    const {context, opened} = board();
    context.pendingPaperCard = {board:'venue-a', id:'paper', email:'pat'};
    Object.assign(context.state, change, {cards:[{id:'paper'}]});
    context.openRegisteredPaper();
    assert.deepEqual(opened, []);
    assert.equal(context.pendingPaperCard, null);
  }
});

test('paper registration permits either edit grant and explains read-only or signed-out access', ()=>{
  const {context} = board();
  for (const grants of [new Set(['ml-cycle']), new Set(['projects']), new Set(['ml-cycle','projects'])]){
    context.BOLD = {can:(area,action) => action === 'edit' && grants.has(area)};
    assert.equal(context.paperRegistrationReason(), '');
  }
  context.BOLD = {can:()=>false};
  assert.match(context.paperRegistrationReason(), /edit access/);
  context.state.currentUser = null;
  assert.match(context.paperRegistrationReason(), /Sign in/);
});
