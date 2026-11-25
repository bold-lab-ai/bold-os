const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const box = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/assets/js/form-people.js'), 'utf8'), box);
const picker = box.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const people = [
  { name: 'Zoë Smith', email: 'zoe@example.com', role: 'PhD student', category: 'internal', institution: 'Oxford', pillars: ['Learning'], basedIn: 'London' },
  { name: 'Alex Jones', email: 'aj@example.com', role: 'Postdoc', category: 'internal', institution: 'Oxford', pillars: ['Learning'] },
  { name: 'Sam Smith', email: 'sam@example.com', role: 'Master student', category: 'associate', institution: 'UCL' },
];
test('people search matches names, email, accents and multiple terms', () => {
  assert.equal(picker.search(people, '').length, 0);
  assert.equal(picker.search(people, 'SMITH').length, 2);
  assert.equal(picker.search(people, 'zoe smith')[0].email, 'zoe@example.com');
  assert.equal(picker.search(people, 'aj@')[0].name, 'Alex Jones');
  assert.equal(picker.search(people, 'Jones Alex').length, 1);
  assert.equal(picker.search(people, 'nobody').length, 0);
});
test('categories support roles, membership, institutions, locations and research pillars', () => {
  const c = picker.categories(people);
  assert.equal(c.find(x => x.label === 'PhD student').emails.length, 1);
  assert.equal(c.find(x => x.label === 'Master student').emails.length, 1);
  assert.equal(c.find(x => x.label === 'Postdoc').emails.length, 1);
  assert.equal(c.find(x => x.label === 'Oxford').emails.length, 2);
  assert.equal(c.find(x => x.label === 'Learning').emails.length, 2);
  assert.equal(c.find(x => x.label === 'London').emails.length, 1);
});
test('bulk selection deduplicates, allows individual exclusions and preserves the creator', () => {
  const all = people.map(p => p.email), first = all[0];
  const selected = picker.change([first], all, true, null, 500);
  assert.equal(selected.length, 3);
  assert.deepEqual(plain(picker.change(selected, [first], false, null, 500)), all.slice(1));
  assert.deepEqual(plain(picker.change(selected, all, false, first, 20)), [first]);
  assert.throws(() => picker.change([first], all, true, first, 2), /no changes/);
  assert.deepEqual(all, people.map(p => p.email));
});

test('selected people paginate by five, filter only selections and clamp after removal', () => {
  const roster = Array.from({ length: 12 }, (_, i) => ({ name: 'Person ' + i, email: 'person' + i + '@example.com' }));
  const selected = roster.slice(0, 11).map(p => p.email);
  assert.equal(picker.selectedPage(roster, selected, '', 0).emails.length, 5);
  assert.deepEqual(plain(picker.selectedPage(roster, selected, '', 1).emails), selected.slice(5, 10));
  assert.equal(picker.selectedPage(roster, selected, '', 2).emails.length, 1);
  assert.equal(picker.selectedPage(roster, selected.slice(0, 10), '', 2).page, 1);
  assert.equal(picker.selectedPage(roster, selected, 'person11@', 0).total, 0);
  assert.deepEqual(plain(picker.selectedPage(roster, selected, 'PERSON10@', 2).emails), [selected[10]]);
  assert.equal(picker.selectedPage(roster, [], '', 3).page, 0);
  assert.deepEqual(plain(picker.selectedPage([], ['missing@example.com'], 'missing', 0).emails), ['missing@example.com']);
  assert.equal(selected.length, 11);
});
