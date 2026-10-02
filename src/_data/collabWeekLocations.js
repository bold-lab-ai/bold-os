// Venues used by Collaboration Week's afternoon programme (see
// collabWeekSchedule.js). mapsQuery is a plain Google Maps search string —
// built from the venue name, not a guessed address/postcode — turned into a
// link on each session's page.
function mapsUrl(query) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
}

const locations = [
  { slug: 'natural-history-museum', name: 'Natural History Museum', mapsQuery: 'Oxford University Museum of Natural History, Oxford' },
  { slug: 'lamb', name: 'LaMB', mapsQuery: 'LaMB, Oxford' },
  { slug: 'thom-building', name: 'Thom Building', mapsQuery: 'Thom Building, Oxford' },
  { slug: 'rhodes-house', name: 'Rhodes House', mapsQuery: 'Rhodes House, Oxford' },
];

export default locations.map((loc) => ({ ...loc, mapsUrl: mapsUrl(loc.mapsQuery) }));
