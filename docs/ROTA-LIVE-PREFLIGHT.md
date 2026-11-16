# Group meeting rota: migration and release

## Where it stands (16 November 2026)

- **Code:** merged (#30) and deployed: the rules, the indexes and the `groupRota*` functions, with `slackEvents`, `boldApi`, `eventSeries` and `historyGroupRotaSlots`.
- **Series:** `eventSeries/group-meetings-afb58e`, created through the Events form. It is hidden, has weekly editions, `inviteGroup: 'none'`, `visibleTo: 'everyone'` and `proposals: false`. `page: 'group-meetings.html'` was added by a one-time update after checking all of these and that it had no editions.
- **Imported:** the old rota's published schedule. Each part below is a document in production:

  | What | Where | How many |
  |---|---|---|
  | Season `2026-27-v4`, labelled "2026–27" | `groupMeetingSeasons` | 1 |
  | Meetings, all hidden (17 past, 35 upcoming) | `events/group-meetings-afb58e-{date}` | 52 |
  | Slots | `groupRotaSlots` | 104 |
  | Presenter records | `groupRotaMembers` | 65 |

  The import was one atomic commit that only creates documents; none of them existed before.
- **Checked after the import:** no slot differs from the export in presenter, topic or format, and the six skipped meetings stay skipped. Every meeting is on Mondays at 11:00 for 60 minutes, with no location. Each slot got its first version, and no changelog entries were written while the meetings are hidden.
- **Nothing is visible or sent yet:** the series and every meeting are hidden, and the three rota Slack features (`rota-swaps`, `rota-offers`, `rota-reminders`) are still in pilot. Reminders also need `groupRotaConfig/current` (`reminderChannelId`, `remindersEnabled`), which isn't set.

## The import

- **Source:** the [old rota's public `GET /api/rota`](https://bold-lab-meeting-rota.theo-wolf296647.chatgpt.site/api/rota), frozen at 14:20 on 16 November 2026 (SHA-256 `91b0a332823da84793aef94da48bc0d35c55a6244e3c78c778a00901a19f9a7a`). It held season `2026-27-v4` and these counts:

  | Meetings | Slots | Members | Skipped | Open slots |
  |---|---|---|---|---|
  | 52 (20 Jul 2026 – 12 Jul 2027) | 104 | 71 | 6 | 27 |

- **Kept outside this public repository,** because they contain people's names: the frozen export, the identity map and the exact documents written.
- **Tool:** `functions/tools/prepare-rota-import.mjs`, with the live series descriptor. The season's label was then set to "2026–27".
- **Identities:** the old rota's members were matched by name against BOLD.OS's `people` roster. Its export has no emails or Slack IDs.

  | Match | How many | Linked to |
  |---|---|---|
  | Exact name, one person | 54 | That person |
  | Exact name, two Slack accounts | 5 | The account with a BOLD.OS account, for 4 of them |
  | Shortened or first name, confirmed by a PI | 7 | The BOLD-internal account with that name |

  Four people with talks stay unresolved: one has two Slack accounts and neither has a BOLD.OS account, and three have no clear match. Their slots show the old name (`legacyName`, `legacyMemberId`), but nobody can edit, decline or swap them until a Slack ID is set on the slot.
- **Undoing it:** delete the 222 documents listed in the kept output: the season, the meetings, the slots and the presenter records.

## Release, in order

1. **Review** the rota as a PI or organiser on `group-meetings.html`. A manager sees hidden meetings.
2. **Link the four unresolved presenters:** set `presenterSlackId` on their slots once their Slack accounts are confirmed.
3. **Release the series** from **Rota actions → Release event series** on the rota page, then **release the meetings**, one at a time from each meeting's actions menu. Releasing the series leaves its meetings hidden.
4. **Hand over from the old rota:**
   - Changes made in the old rota after the freeze aren't imported; re-check them, or re-run the comparison against a fresh export.
   - Retire the old rota and redirect its URL.
   - Switch off the old rota's reminder before setting `groupRotaConfig/current`.
5. **Slack:**
   - Add `/rota` to the Slack app; its request URL is `slackEvents`, like `/meeting`. It isn't in this repository.
   - Try the three rota pilots with testers, then switch them live under Settings › Features.
6. **Check after release:**
   - PAN-BOLD and BOLD-associate members can see released presenters, slides and project links, but can't claim or swap.
   - BOLD-internal members can claim short and long vacancies.
   - Edit, decline, swap, short-slot offer and withdrawal, the reminder and the project links all work on the same meetings.
   - The rota appears once in Events, the Calendar, search and agents' reads.
