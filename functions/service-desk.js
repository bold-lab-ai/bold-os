// Service desk files (service-desk.html): a card on the Service desk can carry a file
// (the preprint template's zip, say) that only people signed in to BOLD.OS download.
// The file lives in Storage under service-desk/<card>/, which no client reads or writes
// (storage.rules); a PI or admin uploads it through serviceDeskFile, and everyone with
// the Service desk's View gets a short-lived signed link to it. The card's `file` field
// is written here only (firestore.rules keeps clients from changing it).

const MAX_BYTES = 5 * 1024 * 1024;
const LINK_MINUTES = 10;
// Files people download from a lab page: archives, documents and plain text.
const TYPES = {
  zip: 'application/zip', pdf: 'application/pdf', tex: 'text/plain', sty: 'text/plain', bib: 'text/plain',
  txt: 'text/plain', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// An error the member can act on: its message is shown (serviceDeskFile in index.js).
function userError(message, code) {
  const err = new Error(message);
  err.deskCode = code || 'invalid-argument';
  return err;
}

// The name it's saved and downloaded under: letters, digits, dot, dash and underscore,
// with an extension from TYPES. Returns { name, type } or throws.
function checkedName(name) {
  const clean = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  const ext = (clean.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  const type = ext && TYPES[ext.toLowerCase()];
  if (!clean || !type) throw userError('Use a .zip, .pdf, .tex, .sty, .bib, .txt, .md, .docx or .pptx file.');
  return { name: clean, type };
}

function checkedBytes(base64) {
  if (typeof base64 !== 'string' || base64.length > MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw userError('Couldn’t read the file. Try again.');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw userError('The file is empty.');
  if (bytes.length > MAX_BYTES) throw userError('The file must be 5 MB or smaller.');
  return bytes;
}

function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id); }

function createServiceDesk({ db, bucket, now = () => Date.now() }) {
  const cards = db.collection('serviceDesk');
  async function card(id) {
    if (!validId(id)) throw userError('No such card.', 'not-found');
    const snap = await cards.doc(id).get();
    if (!snap.exists) throw userError('No such card.', 'not-found');
    return snap;
  }
  // A new file replaces the card's old one (deleted once the card points at the new one).
  async function upload(id, fileName, base64, by) {
    const snap = await card(id);
    const { name, type } = checkedName(fileName);
    const bytes = checkedBytes(base64);
    const at = now();
    const path = 'service-desk/' + id + '/' + at + '-' + name;
    await bucket.file(path).save(bytes, { resumable: false, metadata: { contentType: type } });
    const old = (snap.data().file || {}).path;
    try {
      await cards.doc(id).update({ file: { path, name, type, size: bytes.length, at, by }, updatedAt: at, updatedBy: by.email });
    } catch (err) { await bucket.file(path).delete({ ignoreNotFound: true }).catch(() => {}); throw err; }
    if (old && old !== path) await bucket.file(old).delete({ ignoreNotFound: true }).catch(() => {});
    return { name, size: bytes.length };
  }
  async function remove(id, by) {
    const snap = await card(id);
    const old = (snap.data().file || {}).path;
    await cards.doc(id).update({ file: null, updatedAt: now(), updatedBy: by.email });
    if (old) await bucket.file(old).delete({ ignoreNotFound: true }).catch(() => {});
    return { removed: true };
  }
  // A signed link that works for LINK_MINUTES, saving the file under its own name.
  async function link(id) {
    const f = (await card(id)).data().file;
    if (!f || !f.path) throw userError('This card has no file.', 'not-found');
    const [url] = await bucket.file(f.path).getSignedUrl({
      version: 'v4', action: 'read', expires: now() + LINK_MINUTES * 60 * 1000,
      responseDisposition: 'attachment; filename="' + f.name + '"',
    });
    return { url, name: f.name };
  }
  return { upload, remove, link };
}

module.exports = { createServiceDesk, _internal: { checkedName, checkedBytes, validId, MAX_BYTES } };
