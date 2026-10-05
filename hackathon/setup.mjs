// One-time hackathon setup: gives the local Functions emulator placeholder
// Slack secrets so it starts. Anything that really calls Slack (DMs, channel
// creation) will fail locally, on purpose — no real secrets on laptops.
import fs from 'node:fs';

const file = new URL('../functions/.secret.local', import.meta.url);
if (fs.existsSync(file)) {
  console.log('functions/.secret.local already exists — leaving it alone.');
} else {
  fs.writeFileSync(file, 'SLACK_BOT_TOKEN=xoxb-hackathon-placeholder\nSLACK_SIGNING_SECRET=hackathon-placeholder\n');
  console.log('Wrote functions/.secret.local with placeholder Slack secrets.');
}
console.log('Next: `npm run emulators` in one terminal, `npm run seed -- <your Slack email>` then `npm start` in another.');
