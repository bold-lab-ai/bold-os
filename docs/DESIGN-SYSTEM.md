# Design system

BOLD.OS uses GOV.UK Frontend 6.6.0, installed through npm and pinned in the lockfile.
Eleventy compiles `src/assets/scss/govuk.scss` on every build, including watch builds,
and copies the upstream JavaScript locally. No CDN or separate runtime framework
is required. Run `npm ci` then `npm run build` or `npm start`.

## Structure

- `govuk.scss` imports upstream styles with Arial, the alternative font for a
  non-government service. BOLD.OS retains its own name and generic header.
- `base.njk` loads application CSS in the `bold` cascade layer and the compiled
  GOV.UK CSS above it. This preserves application layouts while making shared
  component styles authoritative. Keep application styles in this layer.
- Sass aliases connect existing buttons, inputs, textareas, selects, errors,
  hints and tables to upstream components. Dynamic Firestore content receives
  these styles immediately, without a DOM observer or rewriting event handlers.
- `govuk.js` initializes explicit upstream `data-module` components. Existing
  BOLD interactions keep their handlers. New upstream interactive components
  added after page load must be initialized after insertion using `initAll` with
  their container as `scope`.
- `bold.css` retains semantic color roles for custom boards, graphs, dialogs and
  other application components. Its light palette follows GOV.UK; dark mode
  remains a BOLD extension. The `/theme/` editor and galleries load the same CSS.

## Adding UI

Use the documented GOV.UK markup and classes for new standard controls. Use its
Sass spacing and typography helpers rather than inventing more scales. Preserve
labels, hint associations, accessible error messages and keyboard interaction;
styles alone do not supply these semantics. Bespoke boards, Markdown editors,
permission controls and proposal workflows remain application components.

The migration supplies shared visual foundations and components; it does not
certify accessibility or implement every GOV.UK service pattern. Native checkbox
and radio controls retain their existing markup. Their targets and focus styling
are shared; they are not the upstream custom checkbox/radio markup.

## Checks

Run the Eleventy build and the existing unit suite. Before release, inspect the
signed-out gate, join form, profile forms, a board and a guide at narrow and wide
sizes, in both themes. Check keyboard navigation, skip link, menus, dialogs,
validation errors and disabled controls. Use the demo emulators for writes.

Upstream references:
- https://frontend.design-system.service.gov.uk/using-govuk-frontend-without-govuk-branding/
- https://design-system.service.gov.uk/components/
- https://design-system.service.gov.uk/patterns/

GOV.UK Frontend is MIT licensed; its notice is included in `src/assets/licenses/govuk-frontend.txt` and the built site.
