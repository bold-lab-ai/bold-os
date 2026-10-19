// Connects the lab's Google account to the functions: run it, sign in as that
// account in the browser, and it prints the GOOGLE_OAUTH secret to store:
//
//   (umask 077; node functions/tools/google-token.js <client id> <client secret> > ~/.bold-oauth.json) && \
//     npx firebase functions:secrets:set GOOGLE_OAUTH --data-file ~/.bold-oauth.json --project bold-d7ff2; rm -f ~/.bold-oauth.json
//
// (Not piped: the CLI reads stdin at once and fails with EAGAIN while this waits for the sign-in.)
//
// The client is an OAuth client of type "Desktop app" in the bold-d7ff2 Google
// Cloud project (docs/REFERENCE.md, "Project workspaces"). Nothing is written to disk.
const http = require('http');

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Usage: node functions/tools/google-token.js <client id> <client secret>');
  process.exit(1);
}
// gmail.send: the welcome email to people who join BOLD (sendWelcome).
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.send'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  if (!code) { res.end(); return; }
  const redirect = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' })
  });
  const json = await r.json();
  if (!json.refresh_token) {
    res.end('No refresh token came back. See the terminal.');
    console.error('Google said:', json.error || json);
    process.exit(1);
  }
  res.end('Done. You can close this tab.');
  process.stdout.write(JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: json.refresh_token }));
  server.close();
});

server.listen(0, '127.0.0.1', () => {
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:' + server.address().port,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });
  console.error('Open this and sign in as the lab\'s Google account:\n\n' + auth + '\n');
});
