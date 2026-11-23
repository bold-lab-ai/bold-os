# Problem Bank

The Research menu has one Problem Bank page. It holds research problems and their pinned evaluator releases.

## Project and evidence requirements

Every new problem and evaluator must name an existing BOLD OS project. The server checks the project in the same transaction as registration. Projects can be normal project records or publication-board cards. A free-text name is insufficient.

## Onboard an open problem

1. Select **Add problem** in the Problem Bank. Choose its BOLD OS project. Give the problem a title and record the question, why it matters, and what existing methods can do. Saving creates an open problem. Its card shows **No verifier**.
2. Select **Add verifier** on the problem. Confirm the transfer to AutoKaggle Lite. The handoff includes the problem ID, project ID and board, title, and up to 4,000 characters of the research question. These travel in the browser's URL fragment. Lite asks for storage consent and creates a separate session for this verifier. A second session can define another verifier for the same problem. Each verifier has its own releases, checks and scores. The bank filters by the most recently registered release. Open the problem to see all releases.
3. **Autoresearch baseline** is planned. This release does not start a baseline run or send a result email.

The submitter can accept or decline reminders when saving. People who submitted older problems can turn reminders on in their problem. The first reminder on a new problem is due at creation. It repeats every seven days until a verifier is registered. Opening Lite does not count. Archiving pauses delivery. Restoring resumes it when the submitter has reminders enabled. The submitter can change this choice on the problem.

The reminder uses the **problem-verifier** Slack pilot and each recipient's notification settings. People who choose Slack pings get an inbox link. People who choose individual messages get a direct link to the problem. A feature in pilot routes messages to testers. After review, a PI or admin can make it live under **Settings → Features**.

Evaluator stages are derived from supplied evidence:

| Stage | Required evidence |
| --- | --- |
| Fully implemented | Pinned GitHub commit and contract digest; build and full contract coverage passed. |
| Checked | The implementation gates plus code review, synthetic checks, known-score check, invalid-submission rejection, and clean-clone execution passed. |
| Validated on the actual task | All software checks plus a controlled run on the declared research assets, with matching expected and measured fitness. |

A synthetic fixture is not research validation. Deferred licensed-data checks must remain visible; they cannot earn the validated stage.

The receiver checks that the evidence is complete and consistent. It doesn't rerun the evaluator or prove a scientific claim, so the page labels every evaluator stage **reported by AutoKaggle**.

**Approval is given in BOLD.OS.** A PI or admin approves a release validated on the actual task with **Approve this release** on its problem's page; the server records their name and when. An approval AutoKaggle sends (`human_approval`, bound to the exact commit, contract and research report) is kept as its report (`reported_approval`) and shown as such, never as BOLD.OS's approval. Agents can't approve.

## Page and access

`problems.html` is laid out as Projects: List or Grid, search, and tabs by stage (Open, Implemented, Checked, Validated, Archived). **Add problem** opens the definition form. The list and grid both mark problems without a verifier. Each problem has its own page, `problem.html?problem=<id>`, laid out and edited as a project's page (`project.css`): the title and its badges, a line with its project and owner, and the tabs Overview (each field edited in place, the research question as the abstract), Evaluator releases and History. A field that isn't filled in says **Not set**.

Each release has a pinned evaluator repository, commit, ZIP, contract digest, check results, research evidence where available, and separate approval. Earlier releases and changes remain in history.

The page uses the existing Projects access rules and Slack identity. The creator or a PI/admin can edit descriptive details, move a problem to another existing project, and archive or restore it. A problem with linked verifiers keeps its project. The submitter or a PI/admin can edit a bank-authored question after linking a verifier. Each released contract stays pinned. Change an evaluator contract through AutoKaggle and check the new version.

Resume links open the full or Lite AutoKaggle session. **Manage handoff access** opens that application's sharing controls. The bank stores no bearer handoff code. The session owner creates or revokes codes in AutoKaggle; existing session access checks still apply.

## Registration interface

After deployment, AutoKaggle Lite sends `POST /boldApi/v1/register_benchmark` with `Authorization: Bearer <approved acting token>` and JSON `{ "registration": <record> }`. A read-only token cannot register records. No Firebase service-account key is needed.

Schema `bold.autokaggle.registration.v1` requires `source_id`, `idempotency_key`, `project_id`, optional `project_board`, `destinations: ["problem_bank"]`, `session: {"application": "lite"}`, title, objective, task kind, pinned evaluator details, and validation states. Descriptive metadata, a full/Lite session reference, research evidence, and human approval are supported. Field checks are in `functions/benchmark-registry.js`.

One Firestore transaction saves `problemBank`, pinned releases in `benchmarks`, their history, and a private receipt. The response contains `problem_id`, `benchmark_id`, `commit`, and `idempotency_key`. Retries return the same receipt. A reused key with different content fails.

The optional `problem_id` identifies an existing problem. The receiver checks the linked project and board and refuses a new release for an archived problem. Each Lite source ID belongs to one problem. Versions advance within that source. Independent sessions can both start at version one. Legacy registrations without a parent keep their existing IDs.

**A release is written once.** Registering the same commit again with identical evidence returns the same release; with different evidence it fails (`already-exists`). Changed evidence is a new version, with a new commit. A version lower than or equal to the latest is refused.

**Whose token.** Each registration is recorded as the person whose acting token sent it, and that person owns that verifier series. Its registering account or a PI/admin can add its next release. Other members with Projects edit access can contribute a separate verifier. The original problem submitter keeps their definition and reminders. So AutoKaggle sends each researcher's own acting token, never one shared token, which would make its holder the owner of every problem.

**Reads go through the callable.** The rules allow no direct reads of `problemBank`, `benchmarks` or their history: `benchmarkRegistry` (list, get, search) serves the page, site search and agents, without people's emails. AutoKaggle's two addresses, for the links to sessions, are in `settings/problemBank`, which PIs and admins set on Settings › Problem Bank.

Evaluator releases are stored in `benchmarks`, and AutoKaggle and agents call `register_benchmark` and `list_benchmarks`; they all belong to the one Problem Bank page. The agent tools and site call the same permission-checked service. Registration sends no messages or invitations.

## Local checks and activation

Run `npm test` and `npm run build`. Run `npm run test-site` with Java 21 and Node 22 or 24 for demo Auth, Firestore, and Functions. Then run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/benchmark-registry.emulator.cjs
```

All integration fixtures are synthetic. Never copy them to production. Tests cover project existence, stages, approval binding, owner permissions, concurrent retries, receipts, history, search, Slack-only reads, forbidden direct writes, and private receipt access.

After PR review, an authorized Firebase operator must deploy `benchmarkRegistry`, the updated `boldApi`, and Firestore rules with the reviewed site. Deploy the receiver and rules first, then the Lite handoff endpoint and client. Release the new BOLD OS pages and both reminder functions (`onProblemDefined` and `remindProblemVerifiers`). Deploy only those functions and rules. Do not run a bare Firebase deploy or enable Firebase Hosting. GitHub Pages remains the site host.

Configure AutoKaggle's private `AUTOKAGGLE_BOLD_REGISTRY_URL` as `https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/v1/register_benchmark`, and have it send each researcher's own approved acting token. Pending eligible releases can then retry. Do not extend a read-only token's permissions in code.

To check reminders with the local demo site running, run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/problem-reminders.emulator.cjs
npx bombadil browser test --headless --time-limit 65s --exit-on-violation http://localhost:8150/problem-new.html tests/bombadil/problem-onboarding.ts
```

The reminder test uses the emulator Slack outbox. It checks the intended recipient, concurrent delivery, the next weekly notice, and the stop condition. The Bombadil test signs in with a demo account, completes the form, and checks the saved problem and verifier action.
