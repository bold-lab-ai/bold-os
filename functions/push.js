'use strict';

// Desktop notifications (Web Push, 2026-11-05): every notification noteFor keeps (functions/index.js)
// also shows on the computers where its person turned them on (notifications.html), even with BOLD.OS
// closed, through Firebase Cloud Messaging and the site's service worker (firebase-messaging-sw.js).
// pushTokens/{sha256 of the token} (server only): { email, token, label, at, usedAt }. A token the push
// service no longer knows (the browser forgot it, or the person blocked notifications) is removed.
const crypto = require('crypto');
const idOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 40);
const lower = (e) => String(e || '').trim().toLowerCase();

// Pure: the push for a notification (FCM's webpush message, without its tokens).
function pushMessage(text, href, siteUrl){
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  return {
    webpush: {
      notification: { title: 'BOLD.OS', body: body.length > 240 ? body.slice(0, 237) + '…' : body, icon: siteUrl + 'assets/img/icon-192.png', badge: siteUrl + 'assets/img/icon-192.png' },
      fcmOptions: { link: /^https:\/\//.test(href || '') ? href : siteUrl + 'notifications.html' },
    },
  };
}
// Pure: whether an FCM error means the token is gone for good.
const goneToken = (code) => ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].indexOf(code) >= 0;

module.exports = function({ db, admin, onCall, HttpsError, signedInEmail, logger, SITE_URL }){
  const col = db.collection('pushTokens');
  async function devicesOf(email, token){
    const mine = token ? idOf(token) : '';
    return (await col.where('email', '==', email).get()).docs
      .map((d) => ({ id: d.id, label: d.data().label || '', at: d.data().at || 0, current: d.id === mine }))
      .sort((a, b) => b.at - a.at);
  }
  // { action: 'list' | 'add' | 'remove', token?, label?, id? } → { devices: [{ id, label, at, current }] }.
  const pushDevices = onCall(async (request) => {
    const email = lower(signedInEmail(request));
    const d = request.data || {}, token = String(d.token || '');
    if (token && (token.length < 20 || token.length > 4096)) throw new HttpsError('invalid-argument', 'That isn’t a push token.');
    if (d.action === 'add') {
      if (!token) throw new HttpsError('invalid-argument', 'No token.');
      // A token moving to someone else (one browser, two people) is theirs now.
      await col.doc(idOf(token)).set({ email, token, label: String(d.label || '').slice(0, 60), at: Date.now() });
    } else if (d.action === 'remove') {
      const id = d.id ? String(d.id) : token ? idOf(token) : '';
      if (!/^[0-9a-f]{40}$/.test(id)) throw new HttpsError('invalid-argument', 'No device given.');
      const snap = await col.doc(id).get();
      if (snap.exists && snap.data().email === email) await snap.ref.delete();
    } else if (d.action !== 'list') throw new HttpsError('invalid-argument', 'Unknown action.');
    return { devices: await devicesOf(email, token) };
  });
  // Shows `text` (linking `href`) on each of `emails`' devices. Never fails what called it.
  async function pushTo(emails, text, href){
    try {
      const list = Array.from(new Set((emails || []).map(lower).filter(Boolean)));
      const docs = [];
      for (let i = 0; i < list.length; i += 30) docs.push(...(await col.where('email', 'in', list.slice(i, i + 30)).get()).docs);
      if (!docs.length) return;
      const msg = pushMessage(text, href, SITE_URL);
      for (let i = 0; i < docs.length; i += 500) {
        const part = docs.slice(i, i + 500);
        const res = await admin.messaging().sendEachForMulticast(Object.assign({ tokens: part.map((d) => d.data().token) }, msg));
        const b = db.batch();
        let n = 0;
        res.responses.forEach((r, k) => {
          if (r.success) { b.update(part[k].ref, { usedAt: Date.now() }); n++; }
          else if (goneToken(r.error && r.error.code)) { b.delete(part[k].ref); n++; }
          else logger.warn('A push failed', { code: r.error && r.error.code });
        });
        if (n) await b.commit();
      }
    } catch (err){ logger.warn('Pushing a notification failed', { error: String(err && err.message || err) }); }
  }
  return { pushDevices, pushTo };
};
Object.assign(module.exports, { pushMessage, goneToken, idOf });
