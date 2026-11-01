#!/usr/bin/env node
// Convert a frozen, already-merged export from the old rota into reviewable
// Firestore documents. This script has no network or Firebase credentials.
// Usage: node prepare-rota-import.mjs frozen-export.json identity-map.json output.json
import fs from 'node:fs';

const [, , sourcePath, mapPath, outputPath] = process.argv;
if (!sourcePath || !mapPath || !outputPath) {
  console.error('Usage: node prepare-rota-import.mjs frozen-export.json identity-map.json output.json');
  process.exit(2);
}
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const source = read(sourcePath), identities = read(mapPath);
if (!Array.isArray(source.meetings) || !Array.isArray(source.members) || !source.meetings.length) throw Error('Expected a frozen merged export with meetings and members.');
if (!identities || Array.isArray(identities) || typeof identities !== 'object') throw Error('Identity map must be an object keyed by legacy member ID.');
const seasonId = String(source.scheduleId || source.meetings[0].scheduleId || '');
if (!/^[a-zA-Z0-9-]{1,64}$/.test(seasonId)) throw Error('Invalid schedule ID.');
const memberBy = new Map(source.members.map(m => [m.id, m]));
const seen = new Set(), docs = [], unresolved = [], comparisons = [];
const season = {
  label: String(source.label || seasonId), dates: source.meetings.map(m => m.date),
  regularTime: String(source.regularTime || source.meetings[0].meetingTime || ''),
  location: String(source.location || ''), rotationDescription: String(source.rotationDescription || ''),
  initialSeed: String(source.initialSeed || ''), publicationState: 'published'
};
docs.push({ path: `groupMeetingSeasons/${seasonId}`, data: season });
for (const m of source.meetings) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date) || !['short', 'long'].includes(m.format) || !Array.isArray(m.slots)) throw Error(`Invalid meeting ${m.id}`);
  docs.push({ path: `groupMeetings/${m.date}`, data: {
    date: m.date, seasonId, format: m.format, timeZone: m.timeZone || 'Europe/London',
    startTime: m.meetingTime, durationMinutes: m.durationMinutes, location: String(m.location || season.location),
    status: m.skipped ? 'skipped' : 'scheduled', skipReason: m.skipped ? String(m.skipReason || '') : ''
  } });
  for (let i = 0; i < m.slots.length; i++) {
    const s = m.slots[i];
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(s.id) || seen.has(s.id)) throw Error(`Duplicate or invalid slot ID ${s.id}`);
    seen.add(s.id);
    const legacyId = s.presenterId || '', member = legacyId ? memberBy.get(legacyId) : null;
    const slackId = legacyId && identities[legacyId] ? String(identities[legacyId]) : '';
    if (slackId && !/^U[A-Z0-9]+$/.test(slackId)) throw Error(`Invalid Slack ID mapped to ${legacyId}`);
    if (legacyId && !slackId) unresolved.push({ slotId: s.id, legacyMemberId: legacyId, legacyName: member?.name || s.presenter || '' });
    const data = {
      meetingId: m.date, date: m.date, slotNumber: i + 1, format: m.format,
      presenterSlackId: slackId, legacyMemberId: legacyId, legacyName: member?.name || s.presenter || '',
      topic: String(s.topic || ''), projectId: '', slidesUrl: '', outcome: 'unconfirmed',
      revision: Number.isInteger(s.version) ? s.version : 0,
      createdAt: Date.now(), updatedAt: Date.now(), updatedBy: 'migration', changeNote: 'Imported published assignment'
    };
    docs.push({ path: `groupRotaSlots/${s.id}`, data });
    comparisons.push({ slotId: s.id, date: m.date, format: m.format, sourcePresenterId: legacyId, sourceTopic: s.topic || '', importedPresenterSlackId: slackId, importedLegacyMemberId: legacyId, importedTopic: data.topic });
  }
}
for (const m of source.members) {
  const slackId = identities[m.id];
  if (!slackId) continue;
  docs.push({ path: `groupRotaMembers/${slackId}`, data: { active: m.active !== false, category: m.memberType || 'associate', legacyMemberId: m.id, updatedBy: 'migration', updatedAt: Date.now() } });
}
const output = { provenance: { source: sourcePath, seasonId, preparedAt: new Date().toISOString(), sourceMeetings: source.meetings.length, sourceSlots: seen.size, sourceChanges: Array.isArray(source.changes) ? source.changes.length : null }, docs, comparisons, unresolved, legacyChanges: Array.isArray(source.changes) ? source.changes : [] };
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
console.log(`Prepared ${source.meetings.length} meetings and ${seen.size} slots; ${unresolved.length} assigned slots remain unresolved. Review ${outputPath} before any import.`);
