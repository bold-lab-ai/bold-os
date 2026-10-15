# Waiting on the lab's Google account

Everything here is built and deployed but does nothing until the lab has a Google account and BOLD.OS is connected to it (the `GOOGLE_OAUTH` secret is still a placeholder). This is the checklist for that day: work through it top to bottom, then delete this file.

## What's waiting

| Feature | Code | Without the account | With it |
|---|---|---|---|
| **Project meetings** | `syncWorkspace`, `onProjectWritten`, `onVenueCardWritten`, `projectWorkspace` | Projects register, but no meeting is created | A recurring Google Calendar meeting with a Meet link, every member invited |
| **Master slides and meeting notes** | `createDeck`, `createNotes`, `shareFile` | None are made | A Slides deck and a "living notes" Doc per project in the Drive folder "BOLD.OS projects", shared with the members and linked from the invite |
| **Linked Google addresses** | `linkGoogle`, `googleAddressesFor` | Linking works and is stored | Invitations and files go to the linked address instead of the Slack email |
| **Joining BOLD** | `join.html`, `join-requests.html`, `requestToJoin`, `decideJoinRequest`, `sendWelcome`, `retryWelcomeEmails` | Latent: the pages exist but nothing links to them; sign-up still goes to the Google Form | Sign-up on BOLD.OS, PIs approve on Join requests, approved people get the welcome email with the next steps |

## Connect the account

1. **Google Cloud console**, project `bold-d7ff2`: enable the **Google Calendar API**, **Google Drive API** and **Gmail API**.
2. **OAuth consent screen**: scopes `calendar.events`, `drive.file` and `gmail.send`; then **publish** it. In Testing, the refresh token expires after 7 days. `gmail.send` is a sensitive scope: an unverified app shows a warning when the lab account signs in, which is fine, since only that account ever signs in.
3. **Credentials**: create an OAuth client of type **Desktop app**.
4. **The secret** (an admin runs it, signing in as the lab's account in the browser):
   ```
   node functions/tools/google-token.js <client id> <client secret> | \
     npx firebase functions:secrets:set GOOGLE_OAUTH --data-file - --project bold-d7ff2
   ```
5. **Redeploy every function that uses it**, so they read the new secret:
   ```
   npx firebase deploy --only functions:onProjectWritten,functions:onVenueCardWritten,functions:projectWorkspace,functions:linkGithub,functions:linkGoogle,functions:decideJoinRequest,functions:sendWelcomeEmail,functions:retryWelcomeEmails --project bold-d7ff2
   ```

## Check it works

- **Projects:** register a test project with a meeting time. It should get a Calendar invite with Meet, a deck and notes linked from its page. Then delete it.
- **Older projects:** projects registered before now have no workspace yet. Each is set up when someone opens its page, or when a member opens their projects (`projectWorkspace` `mine`).
- **Welcome email:** approve a test request sent to your own address (step 3 under "Launch joining" below) and check the email arrives. Approved requests still waiting are retried within the hour, or with **Send the welcome email**.

## Launch joining

1. **Slack invite link**: on `join-requests.html` → Settings. In Slack: Invite people → Copy invite link → Edit link settings, and choose the longest expiry offered.
2. **Read the welcome email's text** there and adjust it.
3. **Send a test request** from `join.html` to your own address, approve it, check the email arrives and its links work.
4. **Link the pages:**
   - `src/_includes/partials/gate.njk` and `src/pages/index.html`: point "Sign up" at `join.html` instead of the Google Form (same tab).
   - `src/_data/site.js`: add `{ label: 'Join requests', href: 'join-requests.html', links: [] }` to `nav`, after Skills.
5. **Push.**
6. **Optional:** import the Google Form's 242 responses as `members` records, so existing members find their details on their profile.

## Still to decide

- Whether project decks and notes are also **commentable by anyone with the link** (the BOLDiquette asks for it). Today they're shared only with the members.
