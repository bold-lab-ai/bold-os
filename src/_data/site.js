// Site-wide constants. The one place the Firebase config, SDK version, repo URL
// and navigation are defined — layouts and partials read these, pages never repeat them.
export default {
  repoUrl: 'https://github.com/bold-lab-ai/bold-os',

  // Firebase compat build from gstatic (docs/AGENTS.md-approved CDN exception,
  // 2026-09-11 — see docs/FIREBASE.md). Bump the pinned version deliberately.
  firebaseSdkVersion: '10.14.1',
  firebase: {
    apiKey: 'AIzaSyDNKEMYuV0gehbKoM2acafzVbBQL489yDY',
    authDomain: 'bold-d7ff2.firebaseapp.com',
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
  nav: [
    { label: 'Work with us', href: 'work-with-us.html', links: [] },
    { label: 'Projects', href: 'projects.html', links: [] },
    { label: 'ML Conference Cycle', href: 'how-to-submit-a-paper.html', links: [
      { label: 'Guide', href: 'how-to-submit-a-paper.html' },
      { label: 'Internal review board', href: 'audit-board.html' },
    ] },
    { label: 'Events', href: 'events.html', links: [
      { label: 'Collaboration Week', href: 'event-collaboration-week.html' },
      { label: 'BOLD Festival 2026', href: 'event-bold-festival.html' },
    ] },
  ],
};
