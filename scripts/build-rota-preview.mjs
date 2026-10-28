#!/usr/bin/env node
// Build a local preview from a saved rota snapshot or a local export.
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
const previewUser = { displayName: 'Sam', email: 'sam@local.preview.invalid' };
const previewSlackId = (data.people.find(([, person]) => person.name === 'Samuel Simons') || [])[0] || '';
const previewStorageKey = 'bold-rota-preview-slots-v1';
const previewProjectId = 'local-example-project';
data.projectWorkspaces.push([previewProjectId, { id: previewProjectId, cardId: previewProjectId, title: 'Example project', members: [previewUser.email] }]);
let savedSlots = {};
try { savedSlots = JSON.parse(localStorage.getItem(previewStorageKey) || '{}') || {}; } catch (_) {}
for (const [id, slot] of data.groupRotaSlots) {
  const saved = savedSlots[id];
  if (saved && typeof saved === 'object') {
    for (const key of ['presenterSlackId', 'legacyMemberId', 'legacyName', 'topic', 'slidesUrl', 'projectId', 'revision']) {
      if (Object.prototype.hasOwnProperty.call(saved, key)) slot[key] = saved[key];
    }
  }
}
const savePreviewSlot = (id, slot) => {
  savedSlots[id] = Object.fromEntries(['presenterSlackId', 'legacyMemberId', 'legacyName', 'topic', 'slidesUrl', 'projectId', 'revision'].map(key => [key, slot[key]]));
  try { localStorage.setItem(previewStorageKey, JSON.stringify(savedSlots)); } catch (_) {}
};
const previewCallable = (name, request = {}) => {
  if (name === 'groupRotaAccess') return Promise.resolve({ data: { slackId: previewSlackId, registered: false, eligible: false, admin: false, preview: true, swaps: [], people: data.people.map(([id, p]) => ({ slackId: id, name: p.name })), reason: 'Other changes are unavailable in the local preview' } });
  const entry = data.groupRotaSlots.find(([id]) => id === request.slotId);
  if (!entry || !previewSlackId) return Promise.reject(new Error('This preview slot is unavailable.'));
  const [id, slot] = entry;
  const meeting = (data.groupMeetings.find(([date]) => date === slot.meetingId) || [])[1];
  const currentLondonTime = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London', hour12: false }).replace(' ', 'T').slice(0, 16);
  const upcoming = meeting && meeting.status !== 'skipped' && meeting.date + 'T' + (meeting.startTime || '00:00') > currentLondonTime;
  if (name === 'groupRotaClaim') {
    if (!upcoming || slot.format !== 'long' || slot.presenterSlackId || slot.legacyMemberId || slot.legacyName || slot.pendingActionId || data.groupRotaSlots.some(([, other]) => other.meetingId === slot.meetingId && other.presenterSlackId === previewSlackId)) return Promise.reject(new Error('This long slot is not open for claims.'));
    Object.assign(slot, { presenterSlackId: previewSlackId, legacyMemberId: '', legacyName: '', topic: '', slidesUrl: '', projectId: '', outcome: 'unconfirmed', revision: (slot.revision || 0) + 1 });
    savePreviewSlot(id, slot);
    return Promise.resolve({ data: { ok: true } });
  }
  if (name === 'groupRotaEdit') {
    const topic = String(request.topic || '').trim(), slidesUrl = String(request.slidesUrl || '').trim(), projectId = String(request.projectId || '').trim();
    if (slot.presenterSlackId !== previewSlackId || slot.revision !== request.revision || slot.pendingActionId || topic.length > 140 || slidesUrl.length > 2000 || (slidesUrl && !/^https:\/\/[^\s]+$/i.test(slidesUrl)) || (projectId && !data.projectWorkspaces.some(([project]) => project === projectId))) return Promise.reject(new Error('Check the title, project and HTTPS slides URL.'));
    Object.assign(slot, { topic, slidesUrl, projectId, revision: slot.revision + 1 });
    savePreviewSlot(id, slot);
    return Promise.resolve({ data: { ok: true } });
  }
  if (name === 'groupRotaRecuse') {
    const reason = String(request.reason || '').trim();
    if (slot.presenterSlackId !== previewSlackId || !upcoming || slot.revision !== request.revision || slot.pendingActionId || !reason || reason.length > 2000) return Promise.reject(new Error('This slot cannot be declined now. Give a reason and try again.'));
    Object.assign(slot, { presenterSlackId: '', legacyMemberId: '', legacyName: '', topic: '', slidesUrl: '', projectId: '', outcome: 'unconfirmed', revision: slot.revision + 1 });
    savePreviewSlot(id, slot);
    return Promise.resolve({ data: { ok: true } });
  }
  return Promise.reject(new Error('This action is unavailable in the local preview.'));
};
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
  app: () => ({ functions: () => ({ httpsCallable: name => request => previewCallable(name, request) }) }),
};
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  const url = new URL(link.href);
  if (link.hasAttribute('data-rota-slides-link') && url.protocol === 'https:') return;
  if (url.origin === location.origin && url.pathname.endsWith('/group-meetings.html')) {
    event.preventDefault();
    location.href = 'group-meetings-preview.html' + url.search + url.hash;
  } else if (url.origin === location.origin && url.pathname.endsWith('/person.html')) {
    event.preventDefault();
    const message = document.getElementById('rotaMessage');
    message.textContent = 'Member profiles are unavailable in this offline preview.';
    message.hidden = false;
  } else if (url.origin === location.origin && url.pathname.endsWith('/project.html')) {
    event.preventDefault();
    if (new URLSearchParams(url.hash.slice(1)).get('id') === previewProjectId) location.href = 'group-meetings-project-preview.html';
    else {
      const message = document.getElementById('rotaMessage');
      message.textContent = 'This project page is unavailable in the offline preview.';
      message.hidden = false;
    }
  } else if (url.origin !== location.origin || !url.pathname.endsWith('/group-meetings-preview.html')) {
    event.preventDefault();
  }
});
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rotaPreviewReset').addEventListener('click', () => {
    try { localStorage.removeItem(previewStorageKey); } catch (_) {}
    location.reload();
  });
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
page = page.replace('<p id="rotaMessage" role="status">', '<p class="rota-preview-note">Offline preview · Claims and talk details stay in this browser. <button type="button" class="btn-text" id="rotaPreviewReset">Reset local changes</button></p>\n  <p id="rotaMessage" role="status">');
page = page.replace('</head>', '<style>.rota-preview-note { margin: .25rem 0 1rem; color: var(--muted); font: 12px/1.4 var(--sans); }</style>\n</head>');
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
await writeFile('_site/group-meetings-project-preview.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Example project | Local BOLD.OS preview</title><link rel="stylesheet" href="assets/css/bold.css"><link rel="stylesheet" href="assets/fonts/rota-preview/fonts.css"><style>main{max-width:var(--content-max);margin:4rem auto;padding:0 var(--gutter)}.back-link{font:13px var(--sans)}.eyebrow{display:block;margin-top:2rem;font:12px var(--sans);text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}</style></head>
<body><main><a class="back-link" href="group-meetings-preview.html">← Group meetings</a><span class="eyebrow">Local project preview</span><h1>Example project</h1><p>This example project lets you try adding and opening a project from the rota.</p></main></body></html>`);
console.log(`Created local preview from ${docs.groupMeetings.length} meetings, ${docs.groupRotaSlots.length} slots, ${docs.people.length} members and ${docs.changelog.length} changes.`);
