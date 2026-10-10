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
  nav: [
    { label: 'Projects', href: 'projects.html', links: [] },
    // Its sub-pages are the released events (Firestore), filled in by bold.js.
    { label: 'Events', href: 'events.html', links: [], events: true },
    { label: 'ML Conference Cycle', href: 'how-to-submit-a-paper.html', links: [
      { label: 'Guide', href: 'how-to-submit-a-paper.html' },
      { label: 'Internal review board', href: 'audit-board.html' },
    ] },
    // Its sub-pages are the how-to guides (Firestore), filled in by bold.js.
    { label: 'How to', href: 'guides.html', links: [], guides: true },
    // Its sub-pages are the skills (Firestore), filled in by bold.js.
    { label: 'Skills', href: 'skills.html', links: [], skills: true },
  ],
};
