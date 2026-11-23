# Problem Bank

The Research menu has one Problem Bank page. It holds research problems and their pinned evaluator releases.

For a benchmark you already use, open **Research → Benchmarks** and select **Onboard a benchmark in AutoKaggle Lite**. Start a session and share the benchmark paper, repository, or scoring instructions. This link opens the Lite service configured under **Settings → Problem Bank**. It sends no problem, project, or account details. To attach a verifier to an existing BOLD OS problem, open that problem in the Problem Bank and use **Add verifier**.

The same page lists verifier releases for active problems, newest first. Select a version to open its evidence, pinned code and download on the problem page. The catalogue shows the stage AutoKaggle reported for that version. BOLD OS approval appears separately in the release details.

## Project and evidence requirements

An open problem can exist before a project starts. It can link to several BOLD OS projects. Every new project proposal must select an unarchived scientific problem. A verified evaluator can exist while the scientific question is still open. Each new verifier release must name one linked project. The server checks that project during registration.

When proposing a project, select one or more registered verifier or benchmark releases. Projects can reuse a benchmark registered for another active problem. If none fits, select **Define verifier later** and supply both the reason and an approximate time for onboarding. A time such as “within six weeks” is sufficient. The project overview records the pinned versions or the deferral supplied at proposal.

To record past work, open **Internal Review**, choose a venue, and select **Register paper**. Enter the paper title and choose the open problem it addresses. You can add a compute estimate and a note for reviewers. This form saves the paper directly on the venue board. The paper links back to the problem. It requires no verifier, benchmark, or AutoKaggle session.

## Research family tree

Open **Problem Bank → By objective** to browse the three research pillars and named moonshots. Expand a branch to see the problems that contribute to it. Search across active problems at every verifier stage. **Include archived** shows historical links. The **Unclassified** branch holds problems without a broader link and their descendants.

Choose **Graph** to explore the same records visually. Select a node to see its broader objectives, narrower problems and related problems. Solid arrows point toward a broader objective or problem. Dashed lines connect related problems. Search by title to find a problem, including one without links. You can share the address of a selected node or open its Problem Bank record.

On **Add problem**, select any broader objectives or problems and, separately, any related problems. On a saved problem, use **Edit family links**. The same problem can appear under several objectives. Its projects, verifiers and history are shared across every path. A PI or admin can add, rename, archive and restore a moonshot under **Manage moonshots**. The registry reads pillar names from the research pillars section of the handbook.

## Onboard an open problem

1. Select **Add problem**. Enter the title, select the person who defined it, and describe its significance, difficulties and current frontier. Link existing projects and name collaborators if applicable. Save the problem. To propose a new project, follow **All projects**, select **Propose a project**, and choose the open problem. If the problem is missing, follow **here** below the project form’s **Open problem** field. The bank opens in a separate tab. Save the problem and return to the proposal to select it. **Refresh list** reloads the choices if needed. The project then appears on the problem page.
2. Select **Add verifier**. If several projects are linked, choose the one that will own this verifier. Confirm the transfer to AutoKaggle Lite. The handoff includes the problem and project IDs, title, and a research brief of up to 4,000 characters in the URL fragment. Lite asks for storage consent. Each verifier has its own session, releases, data and assets, repository, metrics and score format, submission format, and constraints. Open **Verifiers** to compare releases. Older releases can lack recorded contract details.
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

`problems.html` is laid out as Projects: List or Grid, search, and tabs by stage (Open, Implemented, Checked, Validated, Archived). **Add problem** opens the definition form. The list and grid both mark problems without a verifier. Each problem has its own page, `problem.html?problem=<id>`, with tabs for the scientific overview, verifiers and history. Earlier research questions remain visible.

Each release has a pinned evaluator repository, commit, ZIP, contract digest, check results, research evidence where available, and separate approval. Earlier releases and changes remain in history.

The page uses the existing Projects access rules and Slack identity. The creator or a PI/admin can edit descriptive details, edit the project links, and archive or restore it. Keep links used by a registered verifier. The submitter or a PI/admin can edit a bank-authored question after linking a verifier. Each released contract stays pinned. Change an evaluator contract through AutoKaggle and check the new version.

The Lite session link on each verifier opens its saved interview. Use the sharing controls there to manage handoff access. The bank stores no bearer handoff code. The session owner creates or revokes codes in AutoKaggle; existing session access checks still apply.

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

After PR review, an authorized Firebase operator deploys the Functions build from the reviewed commit. The registry, agent API, venue trigger, project lists, invitations, channels and meeting functions must use the same rules for distinguishing past papers from projects. The build also includes both reminder functions (`onProblemDefined` and `remindProblemVerifiers`). Release the matching project and Internal Review pages on GitHub Pages, then apply the reviewed Firestore rules. An older page open during this change needs a reload. Enable the Lite handoff endpoint and client after the registry receiver is available.

Configure AutoKaggle's private `AUTOKAGGLE_BOLD_REGISTRY_URL` as `https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/v1/register_benchmark`, and have it send each researcher's own approved acting token. Pending eligible releases can then retry. Do not extend a read-only token's permissions in code.

To check reminders with the local demo site running, run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/problem-reminders.emulator.cjs
npx bombadil browser test --headless --time-limit 65s --exit-on-violation http://localhost:8150/problem-new.html tests/bombadil/problem-onboarding.ts
```

The reminder test uses the emulator Slack outbox. It checks the intended recipient, concurrent delivery, the next weekly notice, and the stop condition. The Bombadil test signs in with a demo account, completes the form, and checks the saved problem and verifier action.
