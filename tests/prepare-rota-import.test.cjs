const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('snapshot conversion preserves assigned, open and unresolved slots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-import-test-'));
  try {
    const sourcePath = path.join(dir, 'source.json');
    const mapPath = path.join(dir, 'map.json');
    const seriesPath = path.join(dir, 'series.json');
    const outputPath = path.join(dir, 'prepared.json');
    fs.writeFileSync(sourcePath, JSON.stringify({
      scheduleId: 'synthetic-season', members: [
        { id: 'alpha', name: 'Alpha Example', memberType: 'phd' },
        { id: 'beta', name: 'Beta Example', memberType: 'postdoc' }
      ], meetings: [
        { id: '2099-01-05', date: '2099-01-05', format: 'short', meetingTime: '11:00', durationMinutes: 60, slots: [
          { id: 's1', presenterId: 'alpha', presenter: 'Alpha Example', topic: 'Original topic', version: 3 },
          { id: 's2', presenterId: 'beta', presenter: 'Beta Example', topic: '', version: 1 },
          { id: 's3', presenterId: '', presenter: '', topic: '', version: 0 }
        ] },
        { id: '2099-01-12', date: '2099-01-12', format: 'long', meetingTime: '11:00', durationMinutes: 60, skipped: true, skipReason: 'Break', slots: [
          { id: 's4', presenterId: '', presenter: '', topic: '', version: 0 }
        ] }
      ]
    }));
    fs.writeFileSync(mapPath, JSON.stringify({ alpha: 'U123' }));
    fs.writeFileSync(seriesPath, JSON.stringify({ id: 'group-meetings-test', kind: 'editions', page: 'group-meetings.html', title: 'Group meetings', inviteGroup: 'none', visibleTo: 'internal', hidden: true }));
    execFileSync(process.execPath, ['functions/tools/prepare-rota-import.mjs', sourcePath, mapPath, seriesPath, outputPath], { cwd: path.join(__dirname, '..') });
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const docs = new Map(output.docs.map(doc => [doc.path, doc.data]));
    assert.equal(docs.size, 8); // season, two meetings, four slots and one mapped member
    assert.equal(docs.get('events/group-meetings-test-2099-01-12').status, 'skipped');
    assert.equal(docs.get('events/group-meetings-test-2099-01-12').skipReason, 'Break');
    assert.equal(docs.get('events/group-meetings-test-2099-01-05').hidden, true);
    assert.equal(docs.get('events/group-meetings-test-2099-01-05').inviteGroup, 'none');
    assert.deepEqual({ id: docs.get('groupRotaSlots/s1').presenterSlackId, name: docs.get('groupRotaSlots/s1').legacyName, topic: docs.get('groupRotaSlots/s1').topic, revision: docs.get('groupRotaSlots/s1').revision },
      { id: 'U123', name: 'Alpha Example', topic: 'Original topic', revision: 3 });
    assert.deepEqual({ id: docs.get('groupRotaSlots/s2').presenterSlackId, legacyId: docs.get('groupRotaSlots/s2').legacyMemberId, name: docs.get('groupRotaSlots/s2').legacyName },
      { id: '', legacyId: 'beta', name: 'Beta Example' });
    assert.equal(docs.get('groupRotaSlots/s3').legacyName, '');
    assert.equal(docs.get('groupRotaMembers/U123').legacyMemberId, 'alpha');
    assert.deepEqual(output.unresolved.map(item => item.slotId), ['s2']);
    assert.equal(output.comparisons.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
