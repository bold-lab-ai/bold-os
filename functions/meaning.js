// What projects mean, for the Map's Topics (#248): each stepping stone's text (title, keywords, abstract) as a vector
// from Sofya's embedding model (llm.bold-lab.ai, BOLD's own LLM: functions/sofya.js), so that the map's distances
// are distances in meaning, not in shared words. The model is whichever Sofya serves whose name has "embed" in it
// (none yet, 2026-11-23: the map uses shared words until there is one). Each project's vector is kept in
// projectEmbeddings/{pid} (server only) with the hash of the text and the model it came from, and made again only
// when either changes. Sofya logs its requests for training: the texts sent are projects' titles, keywords and
// abstracts. Pure but for `post`/`get` (fetch) and the store.
'use strict';
const crypto = require('crypto');
const BASE = 'https://llm.bold-lab.ai/v1';
const BATCH = 32;

// Pure: what a project's meaning is read from.
function textOf(i){
  return [String(i.title || '').replace(/\[[^\]]*\]/g, ' '), (i.keywords || []).join(', '), String(i.abstract || '')]
    .map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 6000);
}
function hashOf(text){ return crypto.createHash('sha1').update(text).digest('hex'); }
// Pure: the embedding model among Sofya's (/v1/models' data), or ''.
function embedModelOf(models){
  const m = (models || []).map((x) => String((x && x.id) || '')).filter((id) => /embed/i.test(id));
  return m[0] || '';
}
// Pure: cosine similarity of two vectors (arrays).
function cosine(a, b){
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
// Pure: every pair's similarity, to three decimals: { ids, sim: [[…]] }.
function simTable(ids, vecs){
  return { ids, sim: ids.map((a) => ids.map((b) => Math.round(cosine(vecs[a], vecs[b]) * 1000) / 1000)) };
}

module.exports = function({ db, logger, fetchImpl }){
  const http = fetchImpl || fetch;
  let modelCache = null;
  // Sofya's embedding model, looked up at most every 10 minutes ('' when it has none).
  async function model(key){
    if (modelCache && Date.now() - modelCache.at < 600000) return modelCache.id;
    let id = '';
    try {
      const r = await http(BASE + '/models', { headers: { Authorization: 'Bearer ' + key } });
      id = embedModelOf(((await r.json()) || {}).data);
    } catch (err) { logger.warn('Looking up Sofya’s models failed', { error: String(err.message) }); }
    modelCache = { id, at: Date.now() };
    return id;
  }
  // `items` [{ pid, title, keywords, abstract }] → { model, ids, sim } when every one has a vector from the same
  // model (made now for any missing or out of date), else null (the map uses shared words).
  async function meaningOf(items, key){
    if (!key || !items.length) return null;
    const id = await model(key);
    if (!id) return null;
    const col = db.collection('projectEmbeddings');
    const docs = await db.getAll(...items.map((i) => col.doc(i.pid)));
    const vecs = {}, stale = [];
    items.forEach((i, k) => {
      const d = docs[k].exists ? docs[k].data() : null, text = textOf(i), h = hashOf(text);
      if (d && d.hash === h && d.model === id && Array.isArray(d.vec)) vecs[i.pid] = d.vec;
      else stale.push({ pid: i.pid, text, h });
    });
    for (let s = 0; s < stale.length; s += BATCH) {
      const part = stale.slice(s, s + BATCH);
      try {
        const r = await http(BASE + '/embeddings', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: id, input: part.map((x) => x.text) }) });
        const out = await r.json();
        if (!out || !Array.isArray(out.data)) throw new Error((out && out.error && out.error.message) || 'no vectors');
        const batch = db.batch();
        out.data.forEach((e) => {
          const x = part[e.index];
          if (!x || !Array.isArray(e.embedding)) return;
          vecs[x.pid] = e.embedding;
          batch.set(col.doc(x.pid), { vec: e.embedding, hash: x.h, model: id, at: Date.now() });
        });
        await batch.commit();
      } catch (err) {
        logger.warn('Embedding projects with Sofya failed', { model: id, error: String(err.message) });
        return null;
      }
    }
    if (items.some((i) => !vecs[i.pid])) return null;
    return Object.assign({ model: id }, simTable(items.map((i) => i.pid), vecs));
  }
  return { meaningOf, _internal: { textOf, hashOf, embedModelOf, cosine, simTable } };
};
module.exports._internal = { textOf, hashOf, embedModelOf, cosine, simTable };
