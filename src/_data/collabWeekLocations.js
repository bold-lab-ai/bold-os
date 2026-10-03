// Venues for the Collaboration Week programme, with the addresses given in
// the published programme. The Google Maps link searches for name + address.
function mapsUrl(query) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
}

const locations = [
  { slug: 'robert-hooke-building', name: 'Robert Hooke Building', address: 'Parks Road, Oxford OX1 3PP' },
  { slug: 'natural-history-museum', name: 'Natural History Museum', address: 'Oxford University Museum of Natural History, Parks Road, Oxford OX1 3PW' },
  { slug: 'lamb', name: 'Life and Mind Building (LaMB)', address: 'South Parks Road, Oxford OX1 3EL' },
  { slug: 'thom-building', name: 'Thom Building', address: 'Department of Engineering Science, Parks Road, Oxford OX1 3PJ' },
  { slug: 'rhodes-house', name: 'Rhodes House', address: 'South Parks Road, Oxford OX1 3RG' },
];

export default locations.map((loc) => ({ ...loc, mapsUrl: mapsUrl(loc.name + ', ' + loc.address) }));
