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
