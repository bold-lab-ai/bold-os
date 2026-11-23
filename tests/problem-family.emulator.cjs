// Exercise the same registry transactions against an isolated Firestore emulator
// project. In particular, this tests contention that an in-memory fake cannot model.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.METADATA_SERVER_DETECTION = 'none';
const {Firestore} = require('../functions/node_modules/@google-cloud/firestore');
const registry = require('../functions/benchmark-registry');
const projectId = 'demo-bold-family-tests';
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw Error('Supply the local Firestore emulator address.');
const db = new Firestore({projectId});
const member = 'researcher@example.invalid';
class RegistryError extends Error {constructor(code,message){super(message);this.code=code;}}
const call = registry({db, onCall:(_options,fn)=>fn,callerEmail:()=>member,access:{requireAccess:async()=>{},can:async()=>true},isFullWrite:async()=>false,HttpsError:RegistryError}).run;
async function main(){
  const pair = [crypto.randomUUID(),crypto.randomUUID()].map(v=>'ak-'+v.replaceAll('-','').slice(0,24));
  const docs = pair.map((id,i)=>db.doc('problemBank/'+id).set({title:'Cycle test '+i,stage:'checked',archived:false,createdBy:member}));
  await Promise.all(docs);
  const [a,b] = pair;
  const set = (id, target) => call({data:{action:'set_family',problem_id:id,family:{parents:[target],related:[]},previous:{parents:[],related:[]}}});
  const results = await Promise.allSettled([set(a,b),set(b,a)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'failed-precondition');
  const graph = await call({data:{action:'family'}});
  const newEdges = graph.edges.filter(edge=>pair.includes(edge.from));
  assert.equal(newEdges.length,1);
  assert.equal(newEdges[0].kind,'contributes_to');
  const winner=newEdges[0].from, history=await db.collection('problemBank').doc(winner).collection('versions').get();
  assert.equal(history.size,1);assert.equal(history.docs[0].data().updatedBy,member);
  assert.doesNotMatch(JSON.stringify(graph),/researcher@example/);
  console.log('Two simultaneous reciprocal parent links produced one committed edge, one rejected cycle, and one audit record.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.terminate());
