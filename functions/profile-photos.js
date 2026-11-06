// Shared, private portraits. The callable supplies the verified Slack identity;
// clients never supply an owner ID or a source URL for a write.
const crypto = require('crypto');

const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const DAY = 24 * 60 * 60 * 1000;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
// Slack's user object also documents secure.gravatar.com image URLs.
const IMAGE_HOST = /(^|\.)(slack-edge\.com|slack\.com)$|^secure\.gravatar\.com$/i;

// An error the member can act on: its message is shown, with its callable code
// (profilePhoto in index.js); any other error is logged and reported as internal.
function userError(message, code) {
  const err = new Error(message);
  err.photoCode = code || 'invalid-argument';
  return err;
}

function imageType(bytes) {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return '';
}

function checkedImage(bytes, advertisedType, allowGif) {
  if (!bytes || !bytes.length || bytes.length > MAX_BYTES) throw userError('Photo must be 256 KB or smaller.');
  const type = imageType(bytes);
  if (!type || (!allowGif && type === 'image/gif') || (advertisedType && advertisedType.split(';')[0].trim().toLowerCase() !== type)) throw userError('Use a JPEG, PNG or WebP image.');
  return type;
}

async function slackImage(fetcher, url) {
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !IMAGE_HOST.test(parsed.hostname) || parsed.username || parsed.password) throw userError('Slack’s photo link is not one we can use.', 'failed-precondition');
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (i === MAX_REDIRECTS) throw userError('Slack’s photo link redirects too many times.', 'unavailable');
      url = new URL(response.headers.get('location') || '', url).href;
      continue;
    }
    if (!response.ok) throw userError('Slack’s photo is unavailable right now. Try again later.', 'unavailable');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw userError('Your Slack photo is larger than 256 KB.', 'failed-precondition');
    const advertised = response.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp|gif)(;|$)/i.test(advertised)) throw userError('Slack did not return an image.', 'unavailable');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw userError('Your Slack photo is larger than 256 KB.', 'failed-precondition'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    return { bytes, type: checkedImage(bytes, advertised, true) };
  }
}

function createPhotoService({ db, bucket, fetcher, token, FieldValue }) {
  const collection = db.collection('profilePhotos');
  const signedCache = new Map();
  const pathFor = (id) => 'profile-photos/' + id + '/' + crypto.randomUUID();
  const validId = id => typeof id === 'string' && /^[A-Z0-9]{3,32}$/.test(id);
  async function owner(email) {
    const snap = await db.collection('people').where('email', '==', email.toLowerCase()).limit(1).get();
    const id = snap.empty ? '' : snap.docs[0].id;
    if (!validId(id)) throw userError('Your Slack account is not in the member roster.', 'failed-precondition');
    return id;
  }
  async function read(id) {
    if (!validId(id)) return { state: 'missing' };
    return signed((await collection.doc(id).get()).data() || {});
  }
  async function signed(data) {
    if (!data.path || data.state !== 'active') return { state: data.state || 'missing' };
    // Both signing times are day-aligned: the same version gets the same URL
    // throughout a day, while a browser can cache its immutable object.
    const today = Math.floor(Date.now() / DAY) * DAY;
    const key = data.path + ':' + today;
    if (!signedCache.has(key)) {
      if (signedCache.size > 1000) signedCache.clear();
      signedCache.set(key, bucket.file(data.path).getSignedUrl({
        version: 'v4', action: 'read', accessibleAt: new Date(today), expires: new Date(today + 2 * DAY),
      }).then(urls => urls[0]).catch(err => { signedCache.delete(key); throw err; }));
    }
    return { state: 'active', source: data.source, type: data.type, url: await signedCache.get(key), updatedAt: data.updatedAt || null };
  }
  // Many members' photos in one Firestore read; an id that isn't a Slack id is
  // just without a photo, so one odd roster entry doesn't hide everyone's.
  async function batch(ids) {
    if (!Array.isArray(ids) || ids.length > 500) throw userError('Ask for at most 500 photos at a time.');
    const unique = Array.from(new Set(ids.filter(id => typeof id === 'string')));
    const valid = unique.filter(validId);
    const snaps = valid.length ? await db.getAll(...valid.map(id => collection.doc(id))) : [];
    const results = await Promise.all(snaps.map(async (snap, i) => [valid[i], await signed(snap.data() || {})]));
    const out = Object.fromEntries(unique.filter(id => !validId(id)).map(id => [id, { state: 'missing' }]));
    return Object.assign(out, Object.fromEntries(results));
  }
  // Marks an import as under way. A later one takes over (its mark replaces this
  // one's, and only the latest is adopted); the state, 'removed' included, changes
  // only when an import succeeds.
  async function claim(id) {
    const pending = crypto.randomUUID();
    await collection.doc(id).set({ pending, pendingAt: Date.now() }, { merge: true });
    return pending;
  }
  async function clearPending(id, pending) {
    const ref = collection.doc(id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if ((snap.data() || {}).pending === pending) tx.update(ref, { pending: FieldValue.delete(), pendingAt: FieldValue.delete() });
    });
  }
  // The member's choice to use their Slack photo. 'no-slack-photo': Slack has only
  // its default for them, and whatever they had stays.
  async function importSlack(id) {
    const pending = await claim(id);
    let path = '';
    try {
      const response = await fetcher('https://slack.com/api/users.info?user=' + encodeURIComponent(id), {
        headers: { Authorization: 'Bearer ' + token() }, signal: AbortSignal.timeout(8000),
      });
      const json = await response.json();
      if (!json.ok) throw userError('Your Slack profile is unavailable right now. Try again later.', 'unavailable');
      const profile = (json.user && json.user.profile) || {};
      const url = profile.image_192 || profile.image_72 || profile.image_512 || '';
      if (!url || profile.is_custom_image === false || /_default\./i.test(url)) {
        await clearPending(id, pending);
        return { state: 'no-slack-photo' };
      }
      const image = await slackImage(fetcher, url);
      path = pathFor(id);
      await bucket.file(path).save(image.bytes, { resumable: false, metadata: { contentType: image.type, cacheControl: CACHE_CONTROL }, preconditionOpts: { ifGenerationMatch: 0 } });
      const ref = collection.doc(id);
      const adopted = await db.runTransaction(async tx => {
        const snap = await tx.get(ref); const data = snap.data() || {};
        if (data.pending !== pending) return null;
        tx.set(ref, { state: 'active', path, type: image.type, source: 'slack', updatedAt: Date.now(), pending: FieldValue.delete(), pendingAt: FieldValue.delete() }, { merge: true });
        return data.path || '';
      });
      if (adopted === null) { await bucket.file(path).delete({ ignoreNotFound: true }); return { state: 'unchanged' }; }
      if (adopted) await bucket.file(adopted).delete({ ignoreNotFound: true }).catch(() => {});
      return { state: 'active' };
    } catch (err) {
      if (path) await bucket.file(path).delete({ ignoreNotFound: true }).catch(() => {});
      await clearPending(id, pending);
      throw err;
    }
  }
  async function replace(id, imageBase64) {
    if (typeof imageBase64 !== 'string' || imageBase64.length > MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) throw userError('Invalid photo.');
    const bytes = Buffer.from(imageBase64, 'base64'); const type = checkedImage(bytes);
    const path = pathFor(id);
    await bucket.file(path).save(bytes, { resumable: false, metadata: { contentType: type, cacheControl: CACHE_CONTROL }, preconditionOpts: { ifGenerationMatch: 0 } });
    try {
      const ref = collection.doc(id);
      const oldPath = await db.runTransaction(async tx => {
        const snap = await tx.get(ref); const data = snap.data() || {};
        tx.set(ref, { state: 'active', path, type, source: 'manual', updatedAt: Date.now(), pending: FieldValue.delete(), pendingAt: FieldValue.delete() }, { merge: true });
        return data.path || '';
      });
      if (oldPath) await bucket.file(oldPath).delete({ ignoreNotFound: true }).catch(() => {});
    } catch (err) { await bucket.file(path).delete({ ignoreNotFound: true }).catch(() => {}); throw err; }
    return { state: 'active' };
  }
  async function remove(id) {
    const ref = collection.doc(id);
    const oldPath = await db.runTransaction(async tx => {
      const snap = await tx.get(ref); const data = snap.data() || {};
      tx.set(ref, { state: 'removed', path: FieldValue.delete(), type: FieldValue.delete(), source: FieldValue.delete(), updatedAt: Date.now(), pending: FieldValue.delete(), pendingAt: FieldValue.delete() }, { merge: true });
      return data.path || '';
    });
    if (oldPath) await bucket.file(oldPath).delete({ ignoreNotFound: true }).catch(() => {});
    return { state: 'removed' };
  }
  return { owner, read, batch, importSlack, replace, remove };
}

module.exports = { createPhotoService, imageType, checkedImage, slackImage, userError, MAX_BYTES };
