const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const context = {window:{}, BOLD:{escapeHtml: text => String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;')}};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/assets/js/problem-family-picker.js'),'utf8'), context);
const {connections, index, link} = context.window.BoldProblemFamily;
const graph = {
  objectives:[{id:'pillar-a',title:'A & B',kind:'pillar'}],
  problems:[{id:'question',title:'Question'}, {id:'other',title:'An older problem',archived:true}],
  edges:[
    {from:'question',to:'pillar-a',kind:'contributes_to'},
    {from:'narrower',to:'question',kind:'contributes_to'},
    {from:'question',to:'other',kind:'related_to'},
    {from:'peer',to:'question',kind:'related_to'}
  ]
};

test('a problem overview lists each kind of relationship in the correct direction', () => {
  const links = connections(graph, 'question');
  assert.deepEqual(Array.from(links.parents), ['pillar-a']);
  assert.deepEqual(Array.from(links.children), ['narrower']);
  assert.deepEqual(Array.from(links.related), ['other', 'peer']);
  const empty = connections(graph, 'new');
  assert.equal(empty.parents.length + empty.children.length + empty.related.length, 0);
});

test('an objective opens in the tree and an archived problem opens its original record', () => {
  const nodes = index(graph);
  assert.match(link(nodes.get('pillar-a')), /href="problems.html\?objective=pillar-a">A &amp; B/);
  assert.match(link(nodes.get('other')), /href="problem.html\?problem=other">An older problem<\/a> \(archived\)/);
});
