// Static build for BOLD OS. Templates, layouts and data live in src/; the site is
// written to _site/ with the same flat URLs the site has always had
// (events.html, audit-board.html, …) — Slack messages and bookmarks deep-link to them.
export default function (eleventyConfig) {
  // Static files served as-is.
  eleventyConfig.addPassthroughCopy({ 'src/assets': 'assets' });

  // Page bodies are plain HTML; only layouts and partials use Nunjucks.
  eleventyConfig.addFilter('navState', (groups, current) =>
    groups.map((g) => {
      const links = g.links.map((l) => ({ ...l, active: l.href === current }));
      // A group's label is "active" only when its own page is the current one
      // and none of its sub-links is (the Guide link and its label share an href).
      const active = !links.some((l) => l.active) && g.href === current;
      return { ...g, active, links };
    }),
  );

  eleventyConfig.addFilter('concat', (a, b) => a.concat(b));

  // Looks up one item in a list by its `slug` field — used by the
  // Collaboration Week session/talk pages to resolve a session's location.
  eleventyConfig.addFilter('findBySlug', (arr, slug) => (arr || []).find((item) => item.slug === slug));

  // Every Collaboration Week talk that has its own page: the morning research
  // talks (collabWeekResearchTalks.js), then the talks inside sessions that
  // have a `slug`, with their session's slug/title/day/venue — paginated by
  // event-collaboration-week-talk.njk. A collection rather than a data file
  // importing the others, so `--serve` rebuilds it whenever they change.
  eleventyConfig.addCollection('collabWeekTalks', (api) => {
    const data = api.getAll()[0]?.data || {};
    const abstracts = data.collabWeekAbstracts || {};
    const inSessions = (data.collabWeekSessions || []).flatMap((session) => (session.talks || [])
      .filter((talk) => talk.slug)
      .map((talk) => ({ ...talk, abstract: abstracts[talk.slug] || '', sessionSlug: session.slug, sessionTitle: session.title, locationSlug: session.locationSlug, day: session.day,
        // For a reordered session (talkOrder): every talk's key and the slots' start times.
        sessionTalkKeys: session.talks.map((t) => t.slug || t.title), slotTimes: session.talks.map((t) => t.time || '') })));
    return [...(data.collabWeekResearchTalks || []), ...inSessions];
  });

  // Every programme talk and session, with the session leads who may edit
  // them. Published as event-collaboration-week-talks.json, which the
  // editTalk and createTalk functions (functions/index.js) read.
  eleventyConfig.addFilter('talkAccess', (talks, sessions) => ({
    talks: (talks || []).map((t) => ({ slug: t.slug, sessionSlug: t.sessionSlug || '' })),
    sessions: (sessions || []).map((s) => ({ slug: s.slug, leads: s.leads || [] })),
  }));

  // JSON safe to inline in a <script type="application/json"> (no "</script>").
  eleventyConfig.addFilter('jsonScript', (value) => JSON.stringify(value ?? null).replace(/</g, '\\u003c'));

  return {
    dir: { input: 'src', includes: '_includes', data: '_data', output: '_site' },
    htmlTemplateEngine: false,
    markdownTemplateEngine: false,
    templateFormats: ['html', 'njk'],
  };
}
