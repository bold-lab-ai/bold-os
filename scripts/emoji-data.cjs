// Makes src/assets/js/emoji-data.js (emoji.js's list) from emoji-datasource's emoji.json (github.com/iamcal/emoji-data,
// MIT; the names Slack uses): node scripts/emoji-data.cjs path/to/emoji-datasource/emoji.json
const fs = require('fs'), path = require('path');
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ch = (u) => String.fromCodePoint(...u.split('-').map((h) => parseInt(h, 16)));
const rows = d.filter((e) => !e.obsoleted_by && e.has_img_apple).sort((a, b) => a.sort_order - b.sort_order).map((e) => [ch(e.unified)].concat(e.short_names));
fs.writeFileSync(path.join(__dirname, '../src/assets/js/emoji-data.js'),
  '// Emoji and their Slack names (emoji-datasource 15.1.2, MIT, github.com/iamcal/emoji-data; Slack uses these names),\n' +
  '// one per line: the emoji, then its names. Made by scripts/emoji-data.cjs; loaded by emoji.js when first needed.\n' +
  'window.BoldEmojiData = ' + JSON.stringify(rows.map((r) => r.join(' ')).join('\n')) + ';\n');
console.log(rows.length + ' emoji');
