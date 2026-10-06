// Capture the public BOLDiquette Doc in the local Firestore emulator.
// This is separate from seed.mjs so its fictional seed stays fictional.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const { syncGoogleDoc } = require('../functions/boldiquette-sync.js');
const host = '127.0.0.1:8080';
const docId = '1xwgzA72U9oSt94E47H39-8vjV0QhxYCfSP_vkY91S5w';

// Never allow this helper to reach the production database.
process.env.FIRESTORE_EMULATOR_HOST = host;
const app = admin.initializeApp({ projectId: 'bold-d7ff2' });
const db = admin.firestore(app);

async function sync() {
  const response = await fetch(`http://${host}/`);
  if (!response.ok) throw new Error(`Firestore emulator is unavailable (${response.status})`);
  const result = await syncGoogleDoc(db, docId);
  console.log(`${result.changed ? 'Captured' : 'Checked'} BOLDiquette version ${result.version.slice(0, 12)} in the local emulator.`);
}

try {
  await sync();
} catch (error) {
  console.error(`BOLDiquette sync failed: ${error.message || error}`);
  process.exitCode = 1;
}

if (process.argv.includes('--watch') && !process.exitCode) {
  console.log('Checking the public Google Doc every five minutes. Press Ctrl+C to stop.');
  setInterval(() => sync().catch((error) => {
    console.error(`BOLDiquette sync failed: ${error.message || error}`);
  }), 5 * 60 * 1000);
}
