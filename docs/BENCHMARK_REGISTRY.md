# Problem Bank

The Research menu has one Problem Bank page. It holds open problems and their pinned evaluator releases. The old `benchmarks.html` address redirects to `problems.html`. This branch is for PR review. It is not deployed.

## Project and evidence requirements

Every new problem and evaluator must name an existing BOLD OS project. The server checks the project in the same transaction as registration. Projects can be normal project records or publication-board cards. A free-text name is insufficient. Existing records without a link show a repair notice and require a project before an edit can be saved.

An open problem can exist before an evaluator is built. Evaluator stages are derived from supplied evidence:

| Stage | Required evidence |
| --- | --- |
| Fully implemented | Pinned GitHub commit and contract digest; build and full contract coverage passed. |
| Checked | The implementation gates plus code review, synthetic checks, known-score check, invalid-submission rejection, and clean-clone execution passed. |
| Validated on the actual task | All software checks plus a controlled run on the declared research assets, with matching expected and measured fitness. |

A synthetic fixture is not research validation. Deferred licensed-data checks must remain visible; they cannot earn the validated stage.

The receiver checks that the evidence is complete and consistent. It doesn't rerun the evaluator or prove a scientific claim, so the page labels every evaluator stage **reported by AutoKaggle**.

**Approval is given in BOLD.OS.** A PI or admin approves a release validated on the actual task with **Approve this release** on its problem's page; the server records their name and when. An approval AutoKaggle sends (`human_approval`, bound to the exact commit, contract and research report) is kept as its report (`reported_approval`) and shown as such, never as BOLD.OS's approval. Agents can't approve.

## Page and access

`problems.html` supports search, stage filters, archive filtering, and direct `?problem=<id>` links. Details show the project, owner, collaborators, objective, task, submission format, metrics, run command, dependencies, seeds, compute, data access and licence notes, limitations, open issues, and next action. Missing fields say **Not recorded**.

Each release has a pinned evaluator repository, commit, ZIP, contract digest, check results, research evidence where available, and separate approval. Earlier releases and changes remain in history.

The page uses the existing Projects access rules and Slack identity. The creator or a PI/admin can edit descriptive details, move a problem to another existing project, and archive or restore it. Only open problems have editable definitions here. Change an evaluator contract through AutoKaggle and check the new version.

Resume links open the full or Lite AutoKaggle session. **Manage handoff access** opens that application's sharing controls. The bank stores no bearer handoff code. The session owner creates or revokes codes in AutoKaggle; existing session access checks still apply.

## Registration interface

After deployment, AutoKaggle sends `POST /boldApi/v1/register_benchmark` with `Authorization: Bearer <approved acting token>` and JSON `{ "registration": <record> }`. A read-only token cannot register records. No Firebase service-account key is needed.

Schema `bold.autokaggle.registration.v1` requires `source_id`, `idempotency_key`, `project_id`, optional `project_board`, `destinations: ["problem_bank"]`, title, objective, task kind, pinned evaluator details, and validation states. Descriptive metadata, a full/Lite session reference, research evidence, and human approval are supported. Field checks are in `functions/benchmark-registry.js`.

One Firestore transaction saves `problemBank`, pinned releases in `benchmarks`, their history, and a private receipt. The response contains `problem_id`, `benchmark_id`, `commit`, and `idempotency_key`. Retries return the same receipt. A reused key with different content fails.

**A release is written once.** Registering the same commit again with identical evidence returns the same release; with different evidence it fails (`already-exists`). Changed evidence is a new version, with a new commit. A version lower than or equal to the latest is refused.

**Whose token.** Each registration is recorded as the person whose acting token sent it, and that person owns the problem: only they, or a PI or admin, can edit it or register new versions. So AutoKaggle sends each researcher's own acting token, never one shared token, which would make its holder the owner of every problem.

**Reads go through the callable.** The rules allow no direct reads of `problemBank`, `benchmarks` or their history: `benchmarkRegistry` (list, get, search) serves the page, site search and agents, without people's emails. AutoKaggle's two addresses, for the links to sessions, are in `settings/problemBank`, which PIs and admins set at the foot of the page.

The names `benchmarks`, `list_benchmarks`, and `register_benchmark` remain internal API/storage names for compatibility. They do not add a second page. The agent tools and site call the same permission-checked service. Registration sends no messages or invitations.

## Local checks and activation

Run `npm test` and `npm run build`. Run `npm run test-site` with Java 21 and Node 22 or 24 for demo Auth, Firestore, and Functions. Then run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/benchmark-registry.emulator.cjs
```

All integration fixtures are synthetic. Never copy them to production. Tests cover project existence, stages, approval binding, owner permissions, concurrent retries, receipts, history, search, Slack-only reads, forbidden direct writes, and private receipt access.

After PR review, an authorized Firebase operator must deploy `benchmarkRegistry`, the updated `boldApi`, and Firestore rules with the reviewed site. Deploy only those functions and rules. Do not run a bare Firebase deploy or enable Firebase Hosting. GitHub Pages remains the site host.

Configure AutoKaggle's private `AUTOKAGGLE_BOLD_REGISTRY_URL` as `https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/v1/register_benchmark`, and have it send each researcher's own approved acting token. Pending eligible releases can then retry. Do not extend a read-only token's permissions in code.

## Verification: 13 November 2026

The Node suite, Eleventy build, and local Firebase HTTP integration were run. Browser checks covered creating an open problem, mandatory project selection, editing and moving it, filters, empty results, archive/restore, history, and member access. The local AutoKaggle sender also registered a checked fixture, retried without duplication, and updated its evidence through the real HTTP receiver.

Lite's project question was tested with live DeepSeek V4 Pro and through its chat interface. The model recorded the project link without treating it as a paper source. These checks did not train a model or validate a real research dataset.

No production records were created. Deployment and an approved AutoKaggle acting token remain activation steps. The connected token is read-only, so no BOLD OS Board card was created.
