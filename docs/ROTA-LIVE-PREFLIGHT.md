# Group meeting rota: read-only migration preflight

Checked 28 October 2026. The migration target is the **current published meetings and presenter assignments**. Historical D1 change entries are not required. This is a read-only audit, not permission to import. No production data was changed.

## Source and comparison

- Source: the [old rota's public `GET /api/rota` response](https://bold-lab-meeting-rota.theo-wolf296647.chatgpt.site/api/rota), saved locally at `/private/tmp/bold-rota-public-2026-10-28.json` (SHA-256 `2f64e7b5a47bddb1047f71f43390f3a68ae71f55c3a024db7df524f9e9d747f6`). The saved file is outside this public repository because it contains people's names and assignments.
- The response reports season `2026-27-v4`, 52 meetings, 104 slots, 71 members, six skipped meetings, and 27 open slots. Its 20 recent change entries are incidental to this snapshot migration.
- All 57 distinct assigned presenters are marked `slackLinked` in that response. That Boolean does not give a verified Slack ID or establish present membership or rota eligibility. One of the 71 members is marked unlinked and is not assigned a slot.
- The previously saved local preview had the same 52 meeting dates, 104 slot IDs, 71 member IDs, skipped dates, formats, and times, but four slots had changed: `2026-10-26-slot-1` and `2026-10-26-slot-3` had different presenters and revisions; `2026-10-26-slot-2` had a different revision; `2026-11-02-slot-1` had a different topic and revision. The ignored `_site/group-meetings-preview.html` was rebuilt from the 28 October response. A field-by-field check now finds no meeting-format, skipped-state, presenter, or topic differences across its 104 slots. Browser-local preview edits can still override the snapshot until **Reset local changes** is clicked.
- Compared with the old rota's deterministic schedule generator, 33 current slots have a different presenter and two have a different topic. The generated seed cannot replace the merged live schedule.

## Local import dry run

`functions/tools/prepare-rota-import.mjs` accepted the public response as a *provisional* input with an empty identity map. It produced 157 Firestore document shapes: one season, 52 meetings, and 104 slots. The output is `/private/tmp/bold-rota-provisional-import-2026-10-28.json`. It retains the legacy presenter IDs and names for all 77 assigned slots, representing 57 distinct presenters, but none has a verified Slack ID. Those presenters would appear on the page, while ownership-based editing, declining, and swapping would not work for them. No Firestore member documents were prepared. The tool makes no network calls or Firebase writes.

## Required before migration approval

1. Re-fetch and freeze the public merged schedule at cutover. Retain its checksum and a per-slot comparison for review and reversal. The generated seed and this dated preview must not replace the cutover-day schedule.
2. Build an explicit legacy-member-ID to Slack-ID map for the 57 assigned presenters so their existing slots work as their own on BOLD.OS. The old service keeps configured mappings in its server-only `SLACK_USER_MAP` and self registrations in `rota_members`; the public API exposes only `slackLinked`. Verify mappings against the BOLD.OS Slack roster without relying on names alone. Keep any unresolved assignment visible by its legacy name and ID, and report the unavailable owner actions rather than reassigning it.
3. Compare every meeting date, format, time, skipped state, slot ID, presenter, and topic against the frozen snapshot. Review older manually entered group-meeting project presentations so the new project links do not duplicate them. Match the 67 preserved portraits by verified identity before any authorised photo transfer; four legacy portraits are absent and will use initials until supplied.
4. Re-run the import preparation with the frozen snapshot and verified map. Review the per-slot comparison and unresolved-owner list before a separately authorised production import. Set up the exact `bold-associates` eligibility source before enabling new claims and swaps.

The old public endpoint already supplies the current merged schedule, including its overrides. A full D1 history export is no longer a blocker. Verified owner IDs are still needed for existing presenters to edit, decline, and swap their slots. Deployment, reminder handover, old-URL redirect, and live validation remain separately authorised release work as described in `PLAN.md`.

## Presenter identity handoff

The local worksheet `/private/tmp/bold-rota-presenter-identity-check-2026-10-28.csv` lists the 57 distinct assigned legacy presenter IDs, display names, and assignment counts, with a blank verified Slack ID column. Fifty-six are in the old rota's configured roster and one came from self-registration. This is a local review aid containing people's names, so it is not committed to the public repository. The old service has no read-only public route for its mapping, the local `.env` has no `SLACK_USER_MAP`, and the local D1 emulator has no `rota_members` table. The next read-only route is to match these names against BOLD.OS's `people` roster, which contains Slack IDs and is available to signed-in members with People or Projects view access. Exact unique matches can be proposed from that roster; ambiguous or absent matches need separate review. This session has no signed-in roster connection yet. Until the matches are made, the imported legacy names can display, but their ownership-based actions remain unavailable.
