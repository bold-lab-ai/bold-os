#!/usr/bin/env node
// Build a local, read-only preview from a saved rota snapshot or a local export.
// No network calls, Firebase SDK, or production writes.
import { readFile, readdir, writeFile } from 'node:fs/promises';

const sourcePath = process.argv[2];
let docs;
if (!sourcePath) {
  const previous = await readFile('_site/group-meetings-preview.html', 'utf8').catch(() => {
    throw new Error('No local preview snapshot. Pass the path to a saved rota export.');
  });
  const match = previous.match(/const data = (.*);\n/);
  if (!match) throw new Error('Could not read the local preview snapshot.');
  docs = JSON.parse(match[1]);
} else {
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
if (!source.scheduleId || !Array.isArray(source.meetings) || !Array.isArray(source.members) || !Array.isArray(source.changes)) {
  throw new Error('The saved rota export does not contain the expected meeting, member and change lists.');
}
docs = {
  groupMeetings: [], groupRotaSlots: [], groupRotaMembers: [], people: [],
  groupMeetingSeasons: [], projectWorkspaces: [], changelog: [],
};
for (const meeting of source.meetings) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting.date) || !Array.isArray(meeting.slots)) throw new Error('Invalid meeting in source rota.');
  docs.groupMeetings.push([meeting.date, {
    date: meeting.date, seasonId: source.scheduleId, format: meeting.format,
    startTime: meeting.meetingTime, durationMinutes: meeting.durationMinutes,
    timeZone: meeting.timeZone || 'Europe/London', location: 'Oxford',
    status: meeting.skipped ? 'skipped' : 'scheduled', skipReason: meeting.skipReason || '', origin: 'import',
  }]);
  meeting.slots.forEach((slot, index) => {
    const presenterId = slot.presenterId || '';
    docs.groupRotaSlots.push([slot.id, {
      meetingId: meeting.date, date: meeting.date, slotNumber: index + 1,
      format: meeting.format, presenterSlackId: presenterId ? `preview-${presenterId}` : '',
      legacyMemberId: presenterId, legacyName: slot.presenter || '', topic: slot.topic || '',
      slidesUrl: '', projectId: '', outcome: 'unconfirmed', revision: slot.version || 0, origin: 'import',
    }]);
  });
}
for (const member of source.members) {
  const id = `preview-${member.id}`;
  docs.groupRotaMembers.push([id, { active: member.active !== false, category: member.memberType || 'associate', legacyMemberId: member.id }]);
  docs.people.push([id, { slackId: id, name: member.name }]);
}
docs.groupMeetingSeasons.push([source.scheduleId, { label: source.scheduleId, regularTime: '11:00', location: 'Oxford' }]);
for (const change of source.changes) {
  const details = [];
  for (const [key, label] of [['presenterChange', 'Presenter'], ['topicChange', 'Topic']]) {
    const diff = change[key];
    if (diff) details.push(`${label}: ${diff.from || '(empty)'} → ${diff.to || '(empty)'}`);
  }
  docs.changelog.push([`source-change-${change.id}`, {
    at: Date.parse(change.changedAt), by: null, note: details.join('; ') || 'Slot details saved',
    kind: 'edited', collection: 'groupRotaSlots', docId: change.slotId,
    date: change.meetingDate, slotNumber: change.slotNumber,
  }]);
}
}

const inlineJson = JSON.stringify(docs).replace(/</g, '\\u003c');
const photoFiles = await readdir('src/assets/img/rota-profiles').catch(() => []);
const localPhotos = photoFiles.filter(file => /^[a-z0-9-]+\.webp$/.test(file)).map(file => file.slice(0, -5));
const mock = `const data = ${inlineJson};\nconst localPhotos = new Set(${JSON.stringify(localPhotos)});\n` + String.raw`
window.ROTA_LOCAL_PREVIEW = true;
const docs = items => ({ docs: items.map(([id, data]) => ({ id, data: () => data })), empty: !items.length });
const previewUser = { displayName: 'Sam' };
const previewSlackId = (data.people.find(([, person]) => person.name === 'Samuel Simons') || [])[0] || '';
window.BOLD = {
  getAuth: () => true, getApp: () => ({}), authHint: () => null,
  escapeHtml: value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
  onUser: callback => setTimeout(() => callback(previewUser), 0),
  mountMasthead: () => { document.getElementById('authRegion').textContent = 'Sam · Local signed-in preview'; },
  mountShell: () => {
    document.getElementById('shell').hidden = false;
    document.getElementById('pageGate').hidden = true;
  },
};
const previewCollection = name => {
  const query = { get: () => Promise.resolve(docs(data[name] || [])), where: () => query,
    orderBy: () => query, startAfter: () => query, limit: () => query };
  return query;
};
window.previewFirebase = {
  firestore: () => ({ collection: previewCollection }),
  app: () => ({ functions: () => ({ httpsCallable: name => () => name === 'groupRotaAccess'
    ? Promise.resolve({ data: { slackId: previewSlackId, registered: false, eligible: false, admin: false, preview: true, swaps: [], people: data.people.map(([id, p]) => ({ slackId: id, name: p.name })), reason: 'Changes are unavailable in the local preview' } })
    : Promise.reject(new Error('Local preview only — changes are not saved.')) }) }),
};
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  const url = new URL(link.href);
  if (url.origin === location.origin && url.pathname.endsWith('/group-meetings.html')) {
    event.preventDefault();
    location.href = 'group-meetings-preview.html' + url.search + url.hash;
  } else if (url.origin !== location.origin || !url.pathname.endsWith('/group-meetings-preview.html')) {
    event.preventDefault();
  }
});
document.addEventListener('DOMContentLoaded', () => {
  const shell = document.getElementById('shell');
  const toggle = document.getElementById('navToggle');
  toggle.addEventListener('click', () => {
    const open = shell.classList.toggle('is-nav-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.getElementById('sidebarBackdrop').addEventListener('click', () => {
    shell.classList.remove('is-nav-open'); toggle.setAttribute('aria-expanded', 'false');
  });
  document.getElementById('sidebarCollapse').addEventListener('click', () => shell.classList.toggle('is-collapsed'));
  document.querySelectorAll('.nav-group-toggle').forEach(button => button.addEventListener('click', () => {
    const group = button.closest('.nav-group');
    group.classList.toggle('is-pinned');
    group.classList.toggle('is-shut', !group.classList.contains('is-pinned'));
  }));
});
`;

const pagePath = '_site/group-meetings.html';
let page = await readFile(pagePath, 'utf8');
page = page.replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^\"]+"><\/script>\n/g, '');
page = page.replace(/<link[^>]+href="https:\/\/fonts\.[^\"]+"[^>]*>\n/g, '');
page = page.replace(/<script>window\.BOLD_CONFIG = [^<]+<\/script>\n/, '');
page = page.replace(/<script src="assets\/js\/bold\.js[^\"]*"><\/script>\n/, '');
page = page.replace(/<script src="assets\/js\/search-box\.js[^\"]*"><\/script>\n/, '');
page = page.replace(/<script src="assets\/js\/mentions\.js[^\"]*"><\/script>\n/, '');
page = page.replace(/assets\/js\/pages\/group-meetings\.js\?v=/, 'assets/js/pages/group-meetings-preview.js?v=');
page = page.replace('</head>', `<link rel="stylesheet" href="assets/fonts/rota-preview/fonts.css">\n<script>\n${mock}\n</script>\n</head>`);
if (page.includes('firebasejs/') || page.includes('window.BOLD_CONFIG') || page.includes('fonts.googleapis.com') || page.includes('fonts.gstatic.com')) throw new Error('Could not isolate the preview from external services.');
let rotaScript = await readFile('src/assets/js/pages/group-meetings.js', 'utf8');
rotaScript = rotaScript.replace('firebase.firestore(', 'previewFirebase.firestore(').replace('firebase.app()', 'previewFirebase.app()');
rotaScript = rotaScript.replace(/function publicPhoto\(s, person\)\{[^}]+\}/, `function publicPhoto(s, person){
    var slug = String(person || '').toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return localPhotos.has(slug) ? 'assets/img/rota-profiles/' + slug + '.webp' : '';
  }`);
rotaScript = rotaScript.replace('access && !access.eligible ? \'<p class="rota-alert">', 'access && !access.preview && !access.eligible ? \'<p class="rota-alert">');
rotaScript = rotaScript.replace('Eligibility has not been confirmed', 'Changes are unavailable in the local preview');
if (rotaScript.includes('firebase.firestore(') || rotaScript.includes('firebase.app()') || rotaScript.includes('var notice = access && !access.eligible')) throw new Error('Could not isolate the rota script from production data and access checks.');
await writeFile('_site/assets/js/pages/group-meetings-preview.js', rotaScript);
await writeFile('_site/group-meetings-preview.html', page);
console.log(`Created local preview from ${docs.groupMeetings.length} meetings, ${docs.groupRotaSlots.length} slots, ${docs.people.length} members and ${docs.changelog.length} changes.`);
