const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../src/assets/js/problem-papers.js'), 'utf8');
function view(canView) {
  const BOLD = {
    can: (area, action) => area === 'ml-cycle' && action === 'view' && canView,
    escapeHtml: text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  };
  const window = {};
  vm.runInNewContext(script, {window, BOLD});
  return window.BoldProblemPapers;
}

test('distinguishes no registered papers from withheld or unavailable paper data', () => {
  assert.equal(view(true).unavailableReason([]), '');
  assert.match(view(true).unavailableReason(null), /access to Internal Review/);
  assert.match(view(true).unavailableReason(undefined), /unavailable/);
  assert.equal(view(false).unavailableReason([{title:'Restricted'}]), view(false).unavailableReason([]));
  assert.match(view(false).unavailableReason([]), /access to Internal Review/);
});

test('papers with the same title link to their specific venue cards and render names as text', () => {
  const html = view(true).list([
    {board:'robot-venue',id:'paper-1',title:'Robots <people>',venue:'Robots & Systems'},
    {board:'venue b',id:'paper&2',title:'Robots <people>',venue:'Learning'},
  ]);
  assert.match(html, /href="audit-board\.html#board=robot-venue&amp;card=paper-1">Robots &lt;people&gt;/);
  assert.match(html, /href="audit-board\.html#board=venue%20b&amp;card=paper%262">Robots &lt;people&gt;/);
  assert.match(html, /Robots &amp; Systems/);
  assert.match(html, />Learning</);
});
