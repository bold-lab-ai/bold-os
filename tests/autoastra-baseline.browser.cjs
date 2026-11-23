// Run against a BOLD_TEST=1 static build and seeded local demo emulators.
// Set GCLOUD_PROJECT=demo-bold-os, FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR_HOST,
// FIREBASE_AUTH_EMULATOR_HOST and BOLD_TEST_SITE (http://127.0.0.1:<port>).
// Install Playwright, or set NODE_PATH to its installation directory.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {fixture, call, db, owner, operator} = require('./autoastra-baseline.emulator.cjs');
const site = new URL(process.env.BOLD_TEST_SITE || 'http://127.0.0.1:8150');
const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const fn = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
if (site.protocol !== 'http:' || site.hostname !== '127.0.0.1' || !/^127\.0\.0\.1:\d{2,5}$/.test(auth)) {
  throw Error('Run only on a local BOLD_TEST site backed by the demo emulators.');
}
const port = host => Number(host.split(':')[1]);
const checked = async (action, data) => {
  const result = await call(operator, action, data);
  assert.equal(result.status, 200, action + ' should succeed in the emulator');
  return result.data.result;
};

async function test() {
  const browser = await chromium.launch({channel:process.env.CHROME_CHANNEL || 'chrome'});
  const records = await fixture();
  const key = crypto.randomBytes(32).toString('hex');
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(18000);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname.endsWith('/assets/js/bold.js')) {
        // The shipped test mode uses well-known ports. Support isolated emulators in parallel test runs.
        const response = await route.fetch();
        const script = (await response.text()).replace("useEmulator('127.0.0.1', 8080)",
          "useEmulator('127.0.0.1', " + port(process.env.FIRESTORE_EMULATOR_HOST) + ")")
          .replace("useEmulator('127.0.0.1', 5001)", "useEmulator('127.0.0.1', " + port(fn) + ")")
          .replace('http://localhost:9099', 'http://' + auth);
        return route.fulfill({response, body:script});
      }
      if (['127.0.0.1','localhost'].includes(url.hostname)) return route.continue();
      if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')
          && route.request().method() === 'GET') return route.continue();
      return route.abort();
    });
    const base = new URL('/problem.html', site);
    base.searchParams.set('problem', records.problem_id);
    await page.goto(base.href);
    assert.equal(await page.evaluate(() => window.BOLD_TEST), true, 'expected demo build');
    await page.locator('#testBar [data-switch]').click();
    await page.getByRole('button',{name:'Ines Internal',exact:true}).click();
    await page.getByRole('button',{name:'AutoAstra baseline',exact:true}).click();
    const request = page.getByRole('button',{name:'Request AutoAstra baseline'});
    const inbox = db.doc('autoastraBaselineJobs/' + records.benchmark_id);
    await request.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/operator must assign compute/i).waitFor();
    await dialog.getByRole('button',{name:'Cancel'}).click();
    assert.equal((await inbox.get()).exists,false);
    await request.click();
    await dialog.getByRole('button',{name:'Request baseline', exact:true}).click();
    const pending = page.getByText(/Awaiting compute assignment/i);
    await pending.waitFor();
    assert.equal((await inbox.get()).get('status'),'pending');
    assert.equal(await request.count(),0);
    const releaseURL = new URL(base);
    releaseURL.hash = 'tab=releases&release=' + records.benchmark_id;
    await page.goto(releaseURL.href);
    await page.reload();
    await pending.waitFor();

    await checked('claim_baseline',{benchmark_id:records.benchmark_id,claim_key:key});
    await page.reload();
    await page.getByText(/worker has claimed the request/i).waitFor();
    const summary = {run_id:'a'.repeat(32), candidate_sha256:'c'.repeat(64),development_fitness:0.25,
                     final_fitness:1.25,metric:'MAE',direction:'minimize'};
    await checked('finish_baseline',{benchmark_id:records.benchmark_id,claim_key:key,summary});
    const view = page.waitForResponse(resp => resp.url().endsWith('/benchmarkRegistry')
      && resp.request().method()==='POST' && resp.request().postDataJSON()?.data?.action==='get');
    await page.reload();
    const data = (await (await view).json()).result;
    assert.deepEqual(data.versions.find(r=>r.id===records.benchmark_id).baseline,{status:'completed',summary});
    assert.doesNotMatch(JSON.stringify(data),/claimHash|claim_key|claimedBy|recipient|internal@example\.com/i);
    await page.getByText(/MAE \(minimize\).*Development 0\.25.*Final 1\.25/).waitFor();
    await page.getByText('Baseline provenance',{exact:true}).click();
    await page.getByText(summary.candidate_sha256,{exact:true}).waitFor();
    await page.getByText(summary.run_id,{exact:true}).waitFor();
    const panel = await page.locator('#problemBody').innerText();
    for(const privateValue of [key, owner, 'claimHash', 'claim_key', 'recipient']) {
      assert.ok(!panel.includes(privateValue), 'release page must omit private fields');
    }
    if (process.env.AUTOASTRA_UI_SCREENSHOT) {
      const output = path.resolve(process.env.AUTOASTRA_UI_SCREENSHOT);
      if (fs.existsSync(output)) throw Error('Select a new screenshot path.');
      await page.locator('#release-' + records.benchmark_id).screenshot({path:output});
    }
    console.log('Chrome passed confirmation, cancellation, pending/reload, claimed, both measured scores, provenance and privacy with real Firebase emulators.');
  } finally {
    await browser.close();
    await Promise.all(['problemBank/'+records.problem_id,'benchmarks/'+records.benchmark_id,
      'autoastraBaselineJobs/'+records.benchmark_id].map(p=>db.doc(p).delete()));
  }
}
test().finally(()=>require('../functions/node_modules/firebase-admin').app().delete())
  .catch(error=>{ console.error(error); process.exitCode=1; });
