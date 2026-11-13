# Forms (#264)

Forms have draft, open and closed states. Owners create text, single-choice and 1–5 scale questions, select individual recipients or exact BOLD categories, and publish a fixed questionnaire. Multiple owners can edit a draft and read its answers. Revision checks prevent stale edits from replacing another owner's draft. Questions, owners and recipients freeze on publication; create a new form for subsequent rounds.

## Privacy

Responses use random document ids, without submitter identifiers or submission timestamps. Completion receipts live in a separate server-only subcollection, keyed by the authenticated account, and link that account to its response solely for duplicate prevention, reminders and voluntary identity disclosure. Only the backend can read this mapping. Owners receive anonymous answers and an aggregate count, not completion lists, response ids, or timestamps. Respondents see only their own submission.

This is anonymity from form owners, not cryptographic anonymity from infrastructure administrators. Identifying free text, small recipient groups, and observing changes in results can still reveal identity. The page explains completion tracking and warns about identifying content. No claim of absolute anonymity is made. Form owners should consider the audience size before collecting sensitive feedback.

Named submission and revealing identity later each require an explicit, non-skippable confirmation. The server resolves the caller's own receipt; a caller cannot provide another response id to claim. Disclosure adds the account's name and email to that response and is not reversible from the page.

Every forms document and subcollection denies direct client reads/writes. Callable checks enforce Slack identity, the page's access policy, ownership and recipient membership. No generic tags, public interactions, or per-answer notifications are emitted. Search returns only accessible form titles/statuses; the agent interface manages forms but does not submit answers or reveal identities, keeping responses out of its activity logs.

## Notifications

Publishing confirms the saved recipient selection and reminder/digest options. Initial inbox invitations are optional and can be sent later. The recipients are a snapshot of registered members at publication; future group changes do not silently add people.

If selected, weekly inbox reminders start seven days after publication and stop for each respondent once their receipt exists, or when the form closes. Transactional reminder claims suppress duplicate scheduled runs. Owners can opt into at-most-daily response digests instead of per-response notifications, reducing timing disclosure. These are inbox-only (`ping: false`): no Slack, email or Calendar activity is added.

## Deployment and review

Deploy `forms`, `remindForms` and Firestore rules with the client. Propose a **Forms** row in the BOLDiquette access table through the normal on-site workflow: View Everyone; Edit at the lowest group that should be able to submit (Everyone includes new joiners). Until accepted, the standard BOLD-internal fallback applies. Do not seed production questionnaires or personal information from the public repository.

This PR is independent of the buddy implementation. The peer-support team can select its members as co-owners and link the published form from its page. Generic form-builder support for reusable group-based ownership, response editing, exports and copying forms is not included.

## Verification

`node --test tests/forms.test.cjs` validates the pure question/answer model. With `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, it also exercises the real demo Firestore transaction and rules paths: co-ownership, revision conflicts, concurrent duplicate submissions, owner/recipient access, anonymous results, self-only identity reveal, reminder targeting/deduplication, closing and direct-read/write denial. The integration test refuses a non-local emulator host.

Acceptance testing: create with another owner, publish to a small set of fictional members, submit anonymously, inspect results as an owner, then reveal identity as the original respondent. Review the privacy contract and deployment setup before collecting real feedback.
