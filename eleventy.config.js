// Static build for BOLD OS. Templates, layouts and data live in src/; the site is
// written to _site/ with the same flat URLs the site has always had
// (events.html, audit-board.html, …) — Slack messages and bookmarks deep-link to them.
import fs from 'node:fs';
import path from 'node:path';

export default function (eleventyConfig) {
  // Static files served as-is.
  eleventyConfig.addPassthroughCopy({ 'src/assets': 'assets' });
  // The three-way merge proposals use: one file for the server and the pages (#177).
  eleventyConfig.addPassthroughCopy({ 'functions/merge.js': 'assets/js/merge.js' });

  // The theme tool (tools/theme, at /theme/): the ground truth for the site's colours, live but
  // not in the sidebar. It reads the CSS and JS it finds uses of each colour in from this list.
  eleventyConfig.addPassthroughCopy({ 'tools/theme': 'theme' });
  const list = (dir) => fs.readdirSync(dir, { recursive: true })
    .filter((f) => /\.(css|js)$/.test(f)).map((f) => path.posix.join(dir.replace(/^src\//, ''), f.split(path.sep).join('/')));
  eleventyConfig.addTemplate('theme-files.html', JSON.stringify([...list('src/assets/css'), ...list('src/assets/js')]),
    { permalink: 'theme/files.json' });

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
  eleventyConfig.addFilter('uniq', (a) => [...new Set(a)]);

  // JSON safe to inline in a <script type="application/json"> (no "</script>").
  eleventyConfig.addFilter('jsonScript', (value) => JSON.stringify(value ?? null).replace(/</g, '\\u003c'));

  return {
    dir: { input: 'src', includes: '_includes', data: '_data', output: '_site' },
    htmlTemplateEngine: false,
    markdownTemplateEngine: false,
    templateFormats: ['html', 'njk'],
  };
}
