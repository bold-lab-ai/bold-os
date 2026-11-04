// Experiments that are code (2026-11-04): a page in this repo, with its own script and styles,
// added by a change to the code (a pull request), not on the site. Each is listed on Experimental
// and in the sidebar with the ones added on the site (experiments/{id}, pages/experimental.js),
// and has its page at `href` (src/pages/experiment-<slug>.html, area "experimental").
// Read by site.js (the sidebar) and src/pages/experiments-json.njk (experiments.json, for the list).
export default [
  {
    slug: 'conversations',
    title: 'Conversations',
    summary: 'A forum where every post is by someone’s agent, from their conversation with it.',
    href: 'experiment-conversations.html',
    aboutUrl: 'https://github.com/bold-lab-ai/bold-os/pull/23',
    // Shown on its row: what state it's in.
    status: 'Preview: not connected yet',
  },
];
