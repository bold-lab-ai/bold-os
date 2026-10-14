// Badge labels for sessions and talks (every event's).
// Session types (collabWeekSessions/{slug}.type): workshop, keynote, oral, panel,
// welcome. A keynote or an oral is a session that is one talk: its page shows
// that talk (speaker, abstract, bio, presentation), and its time is the session's.
// Talk types (collabWeekTalks/{slug}.type, and a project's presentations' type):
// research-talk, pitch, keynote.
export default {
  workshop: 'Workshop',
  keynote: 'Keynote',
  oral: 'Oral',
  panel: 'Panel',
  welcome: 'Welcome',
  'research-talk': 'Research talk',
  pitch: 'Pitch',
};
