// Site-wide constants. The one place the Firebase config, SDK version, repo URL
// and navigation are defined — layouts and partials read these, pages never repeat them.
// A local test copy (scripts/test-site.sh, BOLD_TEST=1): a demo project that only exists in the
// Firebase emulators, so nothing can reach the real one; never set for the real build.
const TEST = process.env.BOLD_TEST === '1';

export default {
  testMode: TEST,
  repoUrl: 'https://github.com/bold-lab-ai/bold-os',

  // Firebase compat build from gstatic (docs/AGENTS.md-approved CDN exception,
  // 2026-09-11 — see docs/FIREBASE.md). Bump the pinned version deliberately.
  // Bumping it also means refreshing the self-hosted sign-in helper in the
  // bold-lab-ai.github.io repo and re-testing sign-in — see docs/AGENTS.md "Sign-in".
  firebaseSdkVersion: '10.14.1',
  // BOLD's Slack workspace (not a secret: it's in every Slack web address). Named on sign-in so
  // Slack signs returning people straight in, without its consent screen (bold.js BOLD.signIn).
  slackTeam: 'T0B7DUVFEM8',
  // Desktop notifications' Web Push key: set on the site (Settings › Notifications, settings/webPush);
  // this one only if that's empty (e.g. the local test copy).
  webPushKey: '',
  firebase: TEST ? { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-bold-os', storageBucket: 'demo-bold-os.appspot.com', appId: 'demo' } : {
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
    // Reddit-like threads (conversations.html, 2026-11-04; was an experiment).
    { label: 'Conversations', href: 'conversations.html', links: [], area: 'conversations' },
    // Research: the projects and their papers' internal review. Shown with Projects (the
    // lower of the two; areaWhat titles: everyone signed in sees the projects' titles, and
    // below Projects' View and Edit asks to join one, 2026-11-02); Internal review has its own area.
    { label: 'Research', href: 'projects.html', area: 'projects', areaWhat: 'titles', links: [
      // To come: `soon: true` shows the name with a Soon tag, not a link (no page yet).
      { label: 'Problems bank', soon: true },
      { label: 'Benchmarks', soon: true },
      { label: 'Projects', href: 'projects.html', area: 'projects', areaWhat: 'titles' },
      { label: 'Internal review', href: 'audit-board.html', area: 'ml-cycle' },
    ] },
    { label: 'Calendar', href: 'calendar.html', links: [], separatorAfter: true, area: 'calendar' },
    { label: 'People', href: 'people.html', area: 'people', links: [
      { label: 'Members', href: 'people.html' },
      { label: 'Network', href: 'network.html' },
      { label: 'Requests', href: 'join-requests.html', area: 'requests' },
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
    // Hidden from the sidebar for now (2026-11-05: Conversations, its only experiment, has its own
    // place); experimental.html still works. To bring it back, uncomment it and put
    // separatorAfter: true back on the Service desk.
    // Experimental features (experimental.html, 2026-11-04): code ones (src/_data/experiments.js) and
    // ones anyone who may edit the page adds on the site (experiments/{id}, filled in by bold.js).
    // The code ones (src/_data/experiments.js) are written in by the sidebar partial, from that data (not
    // imported here: the dev server would keep an old copy); the ones added on the site follow.
    // { label: 'Experimental', href: 'experimental.html', links: [], experiments: true, area: 'experimental' },
  ],
};
