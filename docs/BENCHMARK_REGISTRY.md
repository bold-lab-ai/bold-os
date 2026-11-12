# Problem Bank and Benchmarks

This branch adds the two Research pages. It does not deploy them. The owner requested a branch for review, with no pull request to main.

The Problem Bank holds a stable research problem. Benchmarks holds its pinned evaluator releases. Each release must have passed software checks, a controlled check on declared research data, and human approval of that exact commit and validation report. Synthetic checks alone do not qualify. Kaito's licensed LOBSTER check is deferred, so his problem must not be registered yet.

## Pages and access

`problems.html` lists problems and their objectives. `benchmarks.html` lists evaluator versions. Both support search and a detail link with `?problem=<id>`. Details show the exact GitHub commit, ZIP, measured and expected fitness, asset hashes, validation report hash, and approval note. Old commits remain accessible. The organizer review link returns to the saved AutoKaggle session; it does not grant access to that session.

The pages use the existing Projects access rules and Slack identity. The registering account or a PI/admin can edit notes and archive or restore a problem. They cannot change a scientific contract or validation result through the notes form. Record history retains those edits. Archived problems remain available by their direct link. Benchmark releases remain in the provenance record.

## Registration interface

After deployment, AutoKaggle sends `POST /boldApi/v1/register_benchmark` with `Authorization: Bearer <approved acting token>` and JSON `{ "registration": <record> }`. Use the BOLD OS profile's approved agent access. A read-only token cannot register records. No Firebase service-account key is needed.

The record schema is `bold.autokaggle.registration.v1`. It contains a stable `source_id`, `idempotency_key`, both destinations, title, objective, task kind, pinned evaluator repository/commit/version/contract digest, software validation states, controlled research evidence, and human approval. The authoritative field checks are in `functions/benchmark-registry.js`.

A Firestore transaction saves `problemBank`, `benchmarks`, their history, and a private receipt. The response contains `problem_id`, `benchmark_id`, `commit`, and `idempotency_key`. Retries return the same receipt. A reused key with different content fails. New validation and approval of the same commit need a new key; the benchmark retains the prior validation in its history. A new evaluator version retains earlier releases.

The receiver checks the approved caller and the evidence fields. It trusts that AutoKaggle's controlled validator produced that evidence. It does not independently rerun the evaluator, prove a scientific claim, or determine whether training avoided exposed answers. The acting token must stay in private server configuration.

The agent tools `list_benchmarks`, `register_benchmark`, and `edit_problem` call the same permission-checked function as the pages. Site search and the MCP search tool include both collections. Registration and edits send no messages, invitations, or sharing changes.

## Review and activation

Run `npm test` and `npm run build`. Run `npm run test-site` with Java 21 and Node 22 or 24 for a local site with demo Auth, Firestore, and Functions. Then run:

```sh
GCLOUD_PROJECT=demo-bold-os FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tests/benchmark-registry.emulator.cjs
```

The integration fixture is explicitly synthetic. It is for local transport and UI tests only. Never copy it to production.

After review, an authorized Firebase operator must deploy `benchmarkRegistry`, the updated `boldApi`, and Firestore rules together with the reviewed site. Deploy only those functions and rules. Do not run a bare Firebase deploy or enable Firebase Hosting. GitHub Pages remains the site host.

Configure AutoKaggle's private `AUTOKAGGLE_BOLD_REGISTRY_URL` as `https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi/v1/register_benchmark` and `AUTOKAGGLE_BOLD_REGISTRY_TOKEN` as an approved BOLD OS acting token. Pending eligible releases can then retry. Do not extend a read-only token's permissions in code.

## Verification on 12 November 2026

- 195 Node tests passed. The Eleventy build passed.
- The local Firebase integration test passed: approved and read-only tokens, required validation, concurrent retries, receipts, search, Slack-only reads, forbidden direct writes, and private receipt access.
- Browser checks passed for member sign-in, both pages, search, empty results, notes, archive/restore, sign-out, and another member's disabled edit controls. Light, dark, and 390-pixel mobile layouts were inspected.
- The integration check found a pre-existing API log failure in the legacy Timestamp lookup. The log now supplies a Date, which Firestore stores as a timestamp.
- No production records were created. Firebase deployment and an approved AutoKaggle acting token remain activation steps. The current connected token is read-only, so no BOLD OS Board card was created.
