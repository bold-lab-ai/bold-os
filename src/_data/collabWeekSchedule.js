// Day-by-day shape of the BOLD Collaboration Week programme (5–9 Oct 2026),
// from the programme spreadsheet (see event-collaboration-week.html's
// provenance line). Session slugs point into collabWeekSessions.js.
export default {
  days: [
    {
      date: '2026-10-05',
      label: 'Monday 5 Oct',
      blocks: [
        { time: '13:45–15:00', kind: 'sessions', sessions: ['monday-keynote-and-pillars'] },
        { time: '15:00–15:30', kind: 'logistics', label: 'Break' },
        { time: '15:30–16:45', kind: 'sessions', sessions: ['project-pitches-i'] },
        { time: '16:45–17:30', kind: 'sessions', sessions: ['after-agi-panel'] },
        { time: '18:00–19:30', kind: 'logistics', label: 'Casual social dinner' },
      ],
    },
    {
      date: '2026-10-06',
      label: 'Tuesday 6 Oct',
      blocks: [
        { time: '13:45–15:00', kind: 'sessions', sessions: ['research-to-entrepreneurship', 'bold-os-workshop'] },
        { time: '15:00–15:30', kind: 'logistics', label: 'Break' },
        { time: '15:30–17:30', kind: 'sessions', sessions: ['ai4science-bold', 'proving-isnt-understanding', 'bold-os-workshop-continued'] },
        { time: '18:00–19:30', kind: 'logistics', label: 'Casual social dinner' },
      ],
    },
    {
      date: '2026-10-07',
      label: 'Wednesday 7 Oct',
      blocks: [
        { time: '13:45–15:00', kind: 'sessions', sessions: ['who-do-you-trust', 'co-scientist-future-of-human-involvement'] },
        { time: '15:00–15:30', kind: 'logistics', label: 'Break' },
        { time: '15:30–17:30', kind: 'sessions', sessions: ['reward-models-for-llms', 'open-ended-multi-agent-env-design'] },
        { time: '18:00–', kind: 'logistics', label: 'Formal dinner, Rhodes House' },
      ],
    },
    {
      date: '2026-10-08',
      label: 'Thursday 8 Oct',
      blocks: [
        { time: '13:45–15:00', kind: 'sessions', sessions: ['after-agi-what-is-left', 'tabular-foundation-models', 'reasoning-generalisation-world-models'] },
        { time: '15:00–15:30', kind: 'logistics', label: 'Break' },
        { time: '15:30–17:30', kind: 'sessions', sessions: ['rethinking-ml-conferences', 'eggroll', 'memory-for-long-horizon-agents'] },
        { time: '18:00–19:30', kind: 'logistics', label: 'Casual social dinner' },
      ],
    },
    {
      date: '2026-10-09',
      label: 'Friday 9 Oct',
      blocks: [
        { time: '13:45–15:00', kind: 'sessions', sessions: ['bold-os-follow-up'] },
        { time: '15:00–15:30', kind: 'logistics', label: 'Break' },
        { time: '15:30–17:30', kind: 'sessions', sessions: ['multi-agent-research-at-bold', 'goals-options-structured-actions'] },
        { time: '18:00–19:30', kind: 'logistics', label: 'Casual social dinner' },
      ],
    },
  ],
};
