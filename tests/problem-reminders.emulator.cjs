// The demo test site must be running. Use the Slack outbox, never the live workspace.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
if (process.env.GCLOUD_PROJECT !== 'demo-bold-os' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || ''))
  throw Error('Use the demo Firestore emulator.');
Object.assign(process.env, { FUNCTIONS_EMULATOR: 'true', SLACK_OUTBOX: 'on', SLACK_BOT_TOKEN: 'outbox' });
const { benchmarkRegistry, remindProblemVerifiers } = require('../functions');
const admin = require('../functions/node_modules/firebase-admin'), db = admin.firestore();
const { record } = require('./benchmark-registry.test.cjs');
const email = 'internal@example.com';
const call = data => benchmarkRegistry.run({ data, auth:{ token:{ email, firebase:{ identities:{'oidc.slack':['UTESTIN']} } } } });
const sweep = () => remindProblemVerifiers.run({});
(async () => {
  const pilot = db.doc('settings/pilot'), prefs = db.doc('notifyPrefs/' + email);
  const before = await Promise.all([pilot.get(), prefs.get()]);
  try {
    await pilot.set({ live:{'problem-verifier':true} }, { merge:true });
    await prefs.set({ slack:'all' });
    const result = await call({action:'create',request_id:crypto.randomUUID(),title:'Weekly reminder test',
      project_id:'diverging-runs',objective:'Estimate decay rates',significance:'Test calibration',existing_solutions:'Least squares',reminders:true});
    const ref = db.doc('problemBank/' + result.problem_id);
    const posts = async () => (await db.collection('slackOutbox').where('method','==','chat.postMessage').get()).docs
      .map(d=>d.data().args).filter(a=>a.text.includes('problem='+ref.id));
    await Promise.all([sweep(),sweep()]);
    for (let i=0;i<50 && (await posts()).length===0;i++) await new Promise(done=>setTimeout(done,100));
    const first = await posts();
    assert.equal(first.length,1); assert.equal(first[0].channel,'D-UTESTIN');
    assert.match(first[0].text,/Add a verifier/);
    const next = (await ref.get()).data().verifierNoticeDue;
    assert.ok(Math.abs(next-Date.now()-7*86400000)<60000);
    await ref.update({verifierNoticeDue:Date.now()-1000});
    await Promise.all([sweep(),sweep()]);
    assert.equal((await posts()).length,2);
    const r = record();
    Object.assign(r,{problem_id:ref.id,source_id:'autokaggle:'+crypto.randomUUID(),idempotency_key:crypto.randomBytes(32).toString('hex')});
    await call({action:'register',registration:r});
    assert.equal((await ref.get()).data().verifierNoticeDue,null);
    await sweep(); assert.equal((await posts()).length,2);
    console.log('Two notices to the submitter, one per due week across concurrent sweeps. Registration stopped delivery.');
  } finally {
    for (const [i,ref] of [pilot,prefs].entries()) { if(before[i].exists) await ref.set(before[i].data()); else await ref.delete(); }
    await admin.app().delete();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
