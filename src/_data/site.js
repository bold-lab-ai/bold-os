// Site-wide constants. The one place the Firebase config, SDK version, repo URL
// and navigation are defined — layouts and partials read these, pages never repeat them.
export default {
  repoUrl: 'https://github.com/bold-lab-ai/bold-os',

  // Firebase compat build from gstatic (docs/AGENTS.md-approved CDN exception,
  // 2026-09-11 — see docs/FIREBASE.md). Bump the pinned version deliberately.
  // Bumping it also means refreshing the self-hosted sign-in helper in the
  // bold-lab-ai.github.io repo and re-testing sign-in — see docs/AGENTS.md "Sign-in".
  firebaseSdkVersion: '10.14.1',
  firebase: {
    apiKey: 'AIzaSyDNKEMYuV0gehbKoM2acafzVbBQL489yDY',
    authDomain: 'bold-lab-ai.github.io',
    projectId: 'bold-d7ff2',
    storageBucket: 'bold-d7ff2.firebasestorage.app',
    messagingSenderId: '555050367135',
    appId: '1:555050367135:web:d90f8d7bb93a755e9fcaaa',
    measurementId: 'G-527H8R28KB',
  },

  fonts:
    'https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400' +
    '&family=Cabin:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap',

  // Sidebar. `href` is the page a group's label opens; `links` are its sub-pages.
  // separatorAfter: a hairline under the group. `area`: its page in the BOLDiquette's
  // Who can see what (functions/access.js); shown only to whoever may view it.
  nav: [
    // Its sub-pages are BOLDiquette's sections (Firestore), filled in by bold.js.
    { label: 'BOLDiquette', href: 'boldiquette.html', links: [], handbook: true, area: 'boldiquette' },
    { label: 'ML Conference Cycle', href: 'how-to-submit-a-paper.html', area: 'ml-cycle', links: [
      { label: 'Guide', href: 'how-to-submit-a-paper.html' },
      { label: 'Internal review board', href: 'audit-board.html' },
    ] },
    { label: 'Calendar', href: 'calendar.html', links: [], area: 'calendar' },
    // Counts what's waiting on the viewer (bold.js requestsNav).
    { label: 'Requests', href: 'join-requests.html', links: [], separatorAfter: true, area: 'requests' },
    { label: 'People', href: 'people.html', area: 'people', links: [
      { label: 'Members', href: 'people.html' },
      { label: 'Network', href: 'network.html' },
    ] },
    // areaWhat list: Projects' View or Edit (Edit alone sees the titles, and joins).
    { label: 'Projects', href: 'projects.html', area: 'projects', areaWhat: 'list', links: [
      { label: 'All projects', href: 'projects.html' },
    ] },
    // Its sub-pages are the released events (Firestore), filled in by bold.js.
    { label: 'Events', href: 'events.html', links: [], events: true, area: 'events' },
    { label: 'Agents', href: 'agents.html', area: 'agents', links: [
      { label: 'Activity', href: 'agents.html#activity' },
      { label: 'Tools', href: 'tools.html', area: 'tools' },
      { label: 'Skills', href: 'skills.html', area: 'skills' },
    ], separatorAfter: true },
    // Its sub-pages are the how-to guides (Firestore), filled in by bold.js.
    { label: 'How to', href: 'guides.html', links: [], guides: true, area: 'guides' },
    { label: 'Service desk', href: 'service-desk.html', area: 'service-desk', links: [
      { label: 'Get started at BOLD', href: 'get-started.html', area: 'get-started' },
      { label: 'Recommendation letters', href: 'letters.html' },
      { label: 'Introductions', href: 'introductions.html' },
    ] },
  ],
};
