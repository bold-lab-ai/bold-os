# Peer support (#265)

Implements manual buddy offers, member acceptance, private assignments, ambassador applications, the roster and editable page content. The console shows current workloads. New `members` records enter the queue once; existing records are not backfilled from ambiguous start dates.

## Access and deployment

Deploy `peerSupport`, `onPeerMemberJoined` and the Firestore rules with the client. Add a **Peer support** row to the BOLDiquette access table through its normal proposal workflow, with View and Edit set to Everyone so new joiners can use it. Until accepted, the existing default restricts the page to BOLD-internal. The normal access gate applies in addition to the private record checks.

A PI/admin appoints the first ambassador using Initial setup. Subsequently ambassadors approve applications; site admins do not automatically gain access to matches. Ambassadors edit their own public biography and opt in to new-member inbox notifications. They maintain the description and questionnaire link on the page. The BOLDiquette prose remains an on-site content proposal owned by the peer support team.

Assignments, applications and page configuration have no direct client read/write access. The callable returns only the caller's request, except for the ambassador console. Direct writes to the directory are denied. Private records are excluded from tagging, general search, public interactions and the agent read API. The agent action uses the same callable for requests and applications.

Notifications contain a generic update and link, never request content. They are inbox-only (`ping: false`); no Slack integration is enabled by this change. Request/offer notifications are optional in the confirmation dialog. New-joiner notifications require each ambassador's explicit opt-in.

The matching check rejects self-matches, supervision links and shared unfinished project workspaces. Ambassadors also confirm they have checked research conflicts, since profile/project data may be incomplete. Matching remains manual. A member can decline/close and request a new match.

## Verification

Use the demo emulator project only. `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test tests/peer-support.test.cjs` exercises the lifecycle, duplicate intake, conflicts, notification opt-out, unauthorised actions and denied direct Firestore reads/writes. `npm test` and `npm run build` cover regression/build checks.

User acceptance: request as a member, offer as an ambassador, accept as the member, check another member cannot see it; check the console and directory in both themes. Scheduling and family/group matching are outside this ticket's implementation.
