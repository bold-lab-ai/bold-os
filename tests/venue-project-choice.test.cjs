const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const board = { URLSearchParams };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/audit-board/modals.js'),'utf8'),board);

const groups = {proposed:[{pid:'pending'}], planned:[
  {pid:'own',projectId:'own',title:'Owned',ownerEmail:'Author@Example.org',proposal:{status:'approved'}},
  {pid:'already-filed',projectId:'already-filed',title:'Already filed',ownerEmail:'author@example.org'},
  {pid:'pending',projectId:'pending',title:'Pending',proposal:{status:'proposed'}},
  {pid:'other',projectId:'other',title:'Other researcher',ownerEmail:'other@example.org'},
  {pid:'hidden',projectId:'hidden',title:'Title only',titleOnly:true}
], submission:[
  {pid:'coauthored',cardId:'venue-card',boardId:'source-venue',title:'Coauthored',authors:[{email:'author@example.org'}]},
  {pid:'here',cardId:'here',boardId:'current-venue',title:'At this venue',ownerEmail:'author@example.org'}
]};

test('paper registration lists editable projects and excludes the projects already at this venue',()=>{
  const ids = admin => Array.from(board.submissionProjects(groups,[{id:'old-card',projectId:'already-filed'}],'current-venue','AUTHOR@example.org',admin),p=>p.pid);
  assert.deepEqual(ids(false),['coauthored','own']);
  assert.deepEqual(ids(true),['coauthored','other','own']);
});

test('handoff names the source project card and the destination venue independently',()=>{
  assert.equal(board.submissionProjectUrl(groups.submission[0],'new-venue'),'project.html#id=venue-card&board=source-venue&submitVenue=new-venue');
  assert.equal(board.submissionProjectUrl(groups.planned[0],'new-venue'),'project.html#id=own&submitVenue=new-venue');
});
