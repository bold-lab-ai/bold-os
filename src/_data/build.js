// A stamp for this build, added to the site's own CSS and JS URLs
// (layouts/base.njk) so browsers fetch them afresh after each change
// instead of running a cached copy.
export default { stamp: Date.now().toString(36) };
