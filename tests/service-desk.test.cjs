const test = require('node:test');
const assert = require('node:assert');
const { createServiceDesk, _internal } = require('../functions/service-desk.js');

test('file names are cleaned and must have a known extension', () => {
  assert.deepStrictEqual(_internal.checkedName('BOLD preprint template.zip'), { name: 'BOLD-preprint-template.zip', type: 'application/zip' });
  assert.deepStrictEqual(_internal.checkedName('../../etc/notes.PDF'), { name: 'etc-notes.PDF', type: 'application/pdf' });
  assert.throws(() => _internal.checkedName('run.sh'), /Use a .zip/);
  assert.throws(() => _internal.checkedName(''), /Use a .zip/);
});

test('files are limited to 5 MB and must decode', () => {
  assert.strictEqual(_internal.checkedBytes(Buffer.from('hello').toString('base64')).toString(), 'hello');
  assert.throws(() => _internal.checkedBytes('not base64!'), /Couldn’t read/);
  assert.throws(() => _internal.checkedBytes(''), /Couldn’t read/);
  assert.throws(() => _internal.checkedBytes(Buffer.alloc(_internal.MAX_BYTES + 1).toString('base64')), /5 MB/);
});

// A Firestore and a Storage bucket that keep everything in memory.
function fakes(doc) {
  const docs = { c1: doc };
  const files = {};
  const db = { collection: () => ({ doc: id => ({
    get: async () => ({ exists: id in docs, data: () => docs[id] }),
    update: async patch => { docs[id] = Object.assign({}, docs[id], patch); },
  }) }) };
  const bucket = { file: path => ({
    save: async bytes => { files[path] = bytes; },
    delete: async () => { delete files[path]; },
    getSignedUrl: async opts => ['https://signed/' + path + '?d=' + encodeURIComponent(opts.responseDisposition)],
  }) };
  return { docs, files, desk: createServiceDesk({ db, bucket, now: () => 1000 }) };
}

test('uploading puts the file on the card and replaces the old one', async () => {
  const f = fakes({ title: 'Preprint template', file: { path: 'service-desk/c1/1-old.zip' } });
  f.files['service-desk/c1/1-old.zip'] = Buffer.from('old');
  const by = { email: 'pi@lab.org', name: 'A PI' };
  const r = await f.desk.upload('c1', 'template.zip', Buffer.from('new').toString('base64'), by);
  assert.deepStrictEqual(r, { name: 'template.zip', size: 3 });
  assert.deepStrictEqual(Object.keys(f.files), ['service-desk/c1/1000-template.zip']);
  assert.strictEqual(f.docs.c1.file.path, 'service-desk/c1/1000-template.zip');
  assert.strictEqual(f.docs.c1.updatedBy, 'pi@lab.org');
});

test('a link names the file, and a card without one has none', async () => {
  const f = fakes({ title: 'T', file: { path: 'service-desk/c1/1-a.zip', name: 'a.zip' } });
  const r = await f.desk.link('c1');
  assert.match(r.url, /service-desk\/c1\/1-a\.zip/);
  assert.match(decodeURIComponent(r.url), /filename="a\.zip"/);
  const g = fakes({ title: 'T' });
  await assert.rejects(g.desk.link('c1'), /no file/);
  await assert.rejects(g.desk.link('missing'), /No such card/);
  await assert.rejects(g.desk.link('../x'), /No such card/);
});

test('removing deletes the file and clears the card', async () => {
  const f = fakes({ title: 'T', file: { path: 'service-desk/c1/1-a.zip' } });
  f.files['service-desk/c1/1-a.zip'] = Buffer.from('a');
  await f.desk.remove('c1', { email: 'pi@lab.org' });
  assert.deepStrictEqual(f.files, {});
  assert.strictEqual(f.docs.c1.file, null);
});
