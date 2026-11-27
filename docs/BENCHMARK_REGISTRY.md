# Problem Bank

The Research menu has one Problem Bank page. It holds research problems and their pinned evaluator releases.

Open the problem in **Research → Problem Bank**. Its **Verifiers** tab holds the pinned evaluator releases, their checks, and their approvals. An old Benchmarks bookmark opens the Problem Bank.

Select **Add verifier** on the problem to take its ID, title, and research question to AutoKaggle Lite. After research-data validation and human approval, the configured member-only registration service attaches the release to that problem. The return link opens its verifier. If the problem is to build a benchmark, select **This problem is building a benchmark** in the definition. Its badge reads **Benchmark** and it skips verifier setup.

## Project and evidence requirements

An open problem can exist before a project starts. It can link to several BOLD OS projects. Every new project proposal must select an unarchived scientific problem. A verified evaluator can exist while the scientific question is still open. A verifier can register before a project exists. The server checks any project that accompanies a release.

When proposing a project, select one or more registered verifier or benchmark releases. Projects can reuse a benchmark registered for another active problem. If none fits, select **Define verifier later** and supply both the reason and an approximate time for onboarding. A time such as “within six weeks” is sufficient. The project overview records the pinned versions or the deferral supplied at proposal.

To record past work, open **Internal Review**, choose a venue, and select **Register paper**. Enter the paper title and choose the open problem it addresses. You can add a compute estimate and a note for reviewers. This form saves the paper directly on the venue board. The paper links back to the problem. It requires no verifier, benchmark, or AutoKaggle session.

To find papers for a problem, expand **Papers** on its Problem Bank card or open the problem’s **Papers** tab. Each entry shows the paper title and venue. Select the title to open the paper on that venue’s board. These links use the current Internal Review records and require access to Internal Review.

## Research family tree

Open **Problem Bank → By objective** to browse the northstars, their moonshots and the problems under them. Northstars and moonshots are projects with a level (Projects, and `functions/research-map.js`). Expand a branch to see the problems that contribute to it. Search across active problems at every verifier stage. **Include archived** shows historical links. The **Unclassified** branch holds problems without a broader link and their descendants.

Choose **Graph** to explore the same records visually. Select a node to see its broader objectives, narrower problems and related problems. Solid arrows point toward a broader objective or problem. Dashed lines connect related problems. Search by title to find a problem, including one without links. You can share the address of a selected node or open its Problem Bank record.

On **Add problem**, select any broader objectives or problems and, separately, any related problems. On a saved problem, use **Edit family links**. The same problem can appear under several objectives. Its projects, verifiers and history are shared across every path. Add a moonshot with **+ Moonshot**, which opens the project form; rename it or change its northstars on its project page.

## Onboard an open problem

1. Select **Add problem**. Enter the title, select the person who defined it, and describe its significance, difficulties and current frontier. Link existing projects and name collaborators if applicable. Save the problem. To propose a new project, follow **All projects**, select **Propose a project**, and choose the open problem. If the problem is missing, follow **here** below the project form’s **Open problem** field. The bank opens in a separate tab. Save the problem and return to the proposal to select it. **Refresh list** reloads the choices if needed. The project then appears on the problem page.
2. Select **Add verifier**. You can start before a project exists. To associate the verifier with a linked project, select it before opening Lite. Confirm the transfer. The handoff includes the problem ID, title, and a research brief of up to 4,000 characters in the URL fragment. It includes a project ID only when selected. Lite asks for storage consent. Each verifier has its own session, releases, data and assets, repository, metrics and score format, submission format, and constraints. Open **Verifiers** to compare releases. Older releases can lack recorded contract details.
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

`problems.html` is laid out as Projects: List or Grid, search, and tabs by stage (Open, Implemented, Checked, Validated, Archived). **Add problem** opens the definition form. The list and grid both mark problems without a verifier. Each problem has its own page, `problem.html?problem=<id>`, with tabs for the scientific overview, registered papers, verifiers and history. Earlier research questions remain visible.

Each release has a pinned evaluator repository, commit, ZIP, contract digest, check results, research evidence where available, and separate approval. Earlier releases and changes remain in history.

The page uses Slack identity and its own row, **Problem Bank**, in the BOLDiquette's Who can do what (page key `problem-bank`; before 27 November 2026 it used the Projects row). Without a row in the saved table, everyone signed in can view it and add problems, PAN-BOLD included (`UNLISTED` in `functions/access.js`, held to by `firestore.rules` and `bold.js`). A row in the table, proposed from the page's access chip, changes this. The pages, the `benchmarkRegistry`, `problemInterview` and `problemTrial` callables, the handoff claim from Lite, problem drafts in the rules, and the agents' `list_benchmarks`, `create_open_problem`, `edit_problem`, `register_benchmark` and `search` tools all check this row. Projects keeps its own row: a project proposal needs Projects' Edit, the project form's choices of problems and releases are open to Projects or the Problem Bank, and a linked project shows its venue only to whoever sees Projects. Choosing another definer reads the roster, which needs People's View or Projects access. The creator or a PI/admin can edit descriptive details, edit the project links, and archive or restore it. Keep links used by a registered verifier. The submitter or a PI/admin can edit a bank-authored question after linking a verifier. Each released contract stays pinned. Change an evaluator contract through AutoKaggle and check the new version.

The Lite session link on each verifier opens its saved interview. Use the sharing controls there to manage handoff access. The bank stores no bearer handoff code. The session owner creates or revokes codes in AutoKaggle; existing session access checks still apply.

## Registration interface

After deployment, AutoKaggle Lite sends `POST /boldApi/v1/register_benchmark` with `Authorization: Bearer <approved acting token>` and JSON `{ "registration": <record> }`. A read-only token cannot register records. No Firebase service-account key is needed.

Schema `bold.autokaggle.registration.v1` requires `source_id`, `idempotency_key`, `destinations: ["problem_bank"]`, `session: {"application": "lite"}`, title, objective, task kind, pinned evaluator details, and validation states. Descriptive metadata, a full/Lite session reference, research evidence, and human approval are supported. Field checks are in `functions/benchmark-registry.js`.

One Firestore transaction saves `problemBank`, pinned releases in `benchmarks`, their history, and a private receipt. The response contains `problem_id`, `benchmark_id`, `commit`, and `idempotency_key`. Retries return the same receipt. A reused key with different content fails.

The optional `problem_id` identifies an existing problem. An optional `project_id` can identify a project, with `project_board` when it belongs to a board. With a parent problem, the project must already link to it. Without a parent or project, the first release creates a problem using the Lite session identity. The receiver refuses new releases for archived problems. Adding a project later preserves the release and its original receipt. Each Lite source ID belongs to one problem. Versions advance within that source. Independent sessions can both start at version one. Legacy registrations without a parent keep their existing IDs.

**A release is written once.** Registering the same commit again with identical evidence returns the same release; with different evidence it fails (`already-exists`). Changed evidence is a new version, with a new commit. A version lower than or equal to the latest is refused.

**Whose token.** Each registration is recorded as the person whose acting token sent it, and that person owns that verifier series. Its registering account or a PI/admin can add its next release. Other members with Problem Bank edit access can contribute a separate verifier. The original problem submitter keeps their definition and reminders. So AutoKaggle sends each researcher's own acting token, never one shared token, which would make its holder the owner of every problem.

**Reads go through the callable.** The rules allow no direct reads of `problemBank`, `benchmarks` or their history: `benchmarkRegistry` (list, get, search) serves the page, site search and agents, without people's emails. AutoKaggle's two addresses, for the links to sessions, are in `settings/problemBank`, which PIs and admins set on Settings › Problem Bank.

Evaluator releases are stored in `benchmarks`, and AutoKaggle and agents call `register_benchmark` and `list_benchmarks`; they all belong to the one Problem Bank page. The agent tools and site call the same permission-checked service. Registration sends no messages or invitations.

## Local checks and activation

Run `npm test` and `npm run build`. Run `npm run test-site` with Java 21 and Node 22 or 24 for demo Auth, Firestore, and Functions. Then run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/benchmark-registry.emulator.cjs
```

All integration fixtures are synthetic. Never copy them to production. Tests cover project existence, stages, approval binding, owner permissions, concurrent retries, receipts, history, search, Slack-only reads, forbidden direct writes, and private receipt access.

After PR review, an authorized Firebase operator deploys the Functions build from the reviewed commit. The registry, agent API, venue trigger, project lists, invitations, channels and meeting functions must use the same rules for distinguishing past papers from projects. The build also includes both reminder functions (`onProblemDefined` and `remindProblemVerifiers`). Release the matching project and Internal Review pages on GitHub Pages, then apply the reviewed Firestore rules. An older page open during this change needs a reload. Enable the Lite handoff endpoint and client after the registry receiver is available.

Configure AutoKaggle's private `AUTOKAGGLE_BOLD_REGISTRY_URL` as `https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/v1/register_benchmark`, and have it send each researcher's own approved acting token. Pending eligible releases can then retry. Do not extend a read-only token's permissions in code.

To check reminders with the local demo site running, run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/problem-reminders.emulator.cjs
npx bombadil browser test --headless --time-limit 65s --exit-on-violation http://localhost:8150/problem-new.html tests/bombadil/problem-onboarding.ts
```

The reminder test uses the emulator Slack outbox. It checks the intended recipient, concurrent delivery, the next weekly notice, and the stop condition. The Bombadil test signs in with a demo account, completes the form, and checks the saved problem and verifier action.

A problem that builds a benchmark skips verifier reminders. If its purpose changes back, the submitter can select **Remind me to add a verifier**. Project choices include the benchmark purpose so that the project form can inherit it. The past-paper form only needs the problem ID and title.

### Returning a verifier from email sign-in in AutoKaggle Lite

A member can authorize Lite to return an approved verifier to one open problem. The member signs in to BOLD OS, opens the problem, and confirms the handoff. They use the same email address in Lite. The project is optional. If they select a project, it must belong to the selected problem.

This integration is off by default. To turn it on, in this order:

1. Deploy the TTL policy that deletes unused codes: `firebase deploy --only firestore:indexes` (`verifierHandoffs.expireAt`).
2. Make a dedicated BOLD OS token for Lite, with acting approved by a PI or admin. Give the raw token only to whoever runs Lite's backend, for its private configuration; never in a chat or a repository. Keep Lite's credential for general reads separate. When you rotate it, revoke the old one.
3. Put `BOLD_LINKED_VERIFIER_HANDOFF_ENABLED=true` and `BOLD_LINKED_VERIFIER_SERVICE_TOKEN_SHA256` (the token's lowercase SHA-256 digest; not a secret) in `functions/.env.bold-d7ff2`.
4. Deploy `firebase deploy --only functions:benchmarkRegistry,functions:boldApi`.
5. Release the matching Lite version with the token in its backend configuration.
6. Test one transfer on a test problem, then archive it. Existing sessions that use each member's own acting token continue through `register_benchmark`.

Once a session is linked, the member gets a Slack message (`verifier-session`, in pilot until switched live in Settings › Features), and the problem page lists its linked sessions. Whoever linked one, a PI or an admin can unlink it; Lite then can't return a verifier through it. The service token is limited to 600 requests a minute and each member to 60. It doesn't depend on whoever made it still being in the BOLD Slack, as it acts only as the member who claimed each session.

| Operation | Request | Result |
| --- | --- | --- |
| Callable `benchmarkRegistry` | `{action:"issue_verifier_handoff", problem_id, project_id?, project_board?}` with a member’s Slack sign-in | `{handoff, expires_at}`. Lite receives the one-time code in the URL fragment. The member has ten minutes to claim it. |
| `POST /v1/claim_verifier_handoff` | `{handoff, email, session_id}` from the Lite backend after email verification | `{problem_id, project_id, project_board, session_id}`. Empty project fields mean no project was selected. A retry with the same code, verified email and session returns the same destination. |
| `POST /v1/register_linked_verifier` | `{registration}` from the Lite backend, with the claimed session, problem and optional project | The registry checks the declared research data validation and human approval for that exact release, then returns its receipt. A duplicate request returns the original receipt. BOLD OS records the initiating member. |

Both REST routes use the dedicated token in the Authorization header. Neither route logs the submitted code or request body. The server stores the code digest and a private binding for the session. An expired unused code can be replaced by reopening Lite from the problem. Marking a problem as building a benchmark or archiving it stops new verifier releases. Existing release receipts remain available.

The `tests/verifier-handoff.emulator.cjs` integration test needs the local demo project's Firestore and Functions emulator addresses and `BOLD_TEST_LITE_TOKEN_FILE`, a local file containing a disposable credential with the prefix `bold_local_verifier_`. Approve the fixture credential in the emulator and configure its digest as above. Use `GCLOUD_PROJECT=demo-bold-os`.
