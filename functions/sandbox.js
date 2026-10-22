// ---------- mcpSandbox: where the MCP's added tools run ----------
// Tools that agents add to BOLD.OS's MCP (functions/api-registry.js) are code, and
// they never run in BOLD.OS's own functions, which can read and write everything and
// hold the lab's Slack, Google and GitHub credentials. They run here instead:
// - its own service account (mcp-sandbox@), with no roles: nothing in the project;
// - no secrets, and no Admin SDK;
// - private: only boldApi may call it (Cloud Run checks), one request at a time per
//   instance (concurrency 1), so one call's code never sees another's;
// - the code gets only `input` and `bold`, which reach BOLD.OS as the person calling
//   the tool, with their sign-in (an ID token boldApi makes for them): Firestore's
//   REST API under the security rules, and the site's callables. A reading tool's
//   `bold` reads; an acting tool's also writes and calls.
// So a tool can do anything its caller could do on the site, and nothing else. (Node's
// vm isn't itself a security boundary: what makes this safe is that, even out of it,
// there's nothing in this function but that one caller's sign-in, and that stays out of
// the tool's worker.)
//
// POST { code, input, idToken, acting } → { result } or { error }. The code is the
// body of an async function of (input, bold); what it returns is the result (JSON).
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/bold-d7ff2/databases/(default)/documents';
const CALLABLES = 'https://europe-west2-bold-d7ff2.cloudfunctions.net/';
const LIMITS = { ms: 25000, calls: 60, result: 500000 };
const OPS = { '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL',
  'array-contains': 'ARRAY_CONTAINS', 'array-contains-any': 'ARRAY_CONTAINS_ANY', 'in': 'IN', 'not-in': 'NOT_IN' };

function toValue(v){
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  const fields = {};
  Object.keys(v).forEach((k) => { if (v[k] !== undefined) fields[k] = toValue(v[k]); });
  return { mapValue: { fields } };
}
function fromValue(v){
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}
function fromFields(f){ const o = {}; Object.keys(f || {}).forEach((k) => { o[k] = fromValue(f[k]); }); return o; }
const docOf = (d) => Object.assign({ _id: d.name.split('/').pop(), _path: d.name.split('/documents/')[1] }, fromFields(d.fields));
const cleanPath = (p) => {
  const s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!s || s.split('/').some((x) => !x || x === '.' || x === '..')) throw new Error('Not a path: ' + p);
  return s;
};

// The `bold` a tool gets: BOLD.OS, as the person calling it.
function boldFor(idToken, acting, doFetch){
  let calls = 0;
  const go = async (url, init) => {
    if (++calls > LIMITS.calls) throw new Error('Too many calls to BOLD.OS in one run (' + LIMITS.calls + ').');
    const r = await doFetch(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' }, (init || {}).headers) }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // A query's error comes as a list ([{ error }]); a document's as { error }.
      const e = (Array.isArray(j) ? (j[0] || {}).error : j.error) || {};
      const status = e.status || e.message || r.status;
      throw new Error(status === 'PERMISSION_DENIED' ? 'BOLD.OS’s rules don’t let the person calling this do that.' : 'BOLD.OS said no: ' + status);
    }
    return j;
  };
  const bold = {
    // One document → its fields (and _id, _path), or null.
    read: async (path) => {
      try { return docOf(await go(FIRESTORE + '/' + cleanPath(path))); }
      catch (e) { if (/NOT_FOUND|404/.test(e.message)) return null; throw e; }
    },
    // A collection (or, with { group: true }, every collection by that name) →
    // documents. where: [[field, op, value], …]; orderBy: [field, 'asc'|'desc']; limit.
    query: async (collection, opts) => {
      opts = opts || {};
      const parts = cleanPath(collection).split('/'), id = parts.pop(), parent = parts.length ? FIRESTORE + '/' + parts.join('/') : FIRESTORE;
      const q = { from: [{ collectionId: id, allDescendants: !!opts.group }] };
      const where = (opts.where || []).map(([field, op, value]) => {
        if (!OPS[op]) throw new Error('Unknown operator ' + op + '.');
        return { fieldFilter: { field: { fieldPath: field }, op: OPS[op], value: toValue(value) } };
      });
      if (where.length) q.where = where.length === 1 ? where[0] : { compositeFilter: { op: 'AND', filters: where } };
      if (opts.orderBy) q.orderBy = [{ field: { fieldPath: opts.orderBy[0] }, direction: opts.orderBy[1] === 'desc' ? 'DESCENDING' : 'ASCENDING' }];
      q.limit = Math.min(Number(opts.limit) || 100, 500);
      const out = await go(parent + ':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: q }) });
      return out.filter((x) => x.document).map((x) => docOf(x.document));
    },
  };
  if (acting) {
    // create (auto id, or id), set (replace), update (these fields), delete.
    bold.write = async (op, path, data, id) => {
      const p = cleanPath(path);
      if (op === 'create') return docOf(await go(FIRESTORE + '/' + p + (id ? '?documentId=' + encodeURIComponent(id) : ''), { method: 'POST', body: JSON.stringify({ fields: toValue(data || {}).mapValue.fields }) }))._id;
      if (op === 'set') { await go(FIRESTORE + '/' + p, { method: 'PATCH', body: JSON.stringify({ fields: toValue(data || {}).mapValue.fields }) }); return true; }
      if (op === 'update') {
        const mask = Object.keys(data || {}).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
        await go(FIRESTORE + '/' + p + '?' + mask + '&currentDocument.exists=true', { method: 'PATCH', body: JSON.stringify({ fields: toValue(data || {}).mapValue.fields }) });
        return true;
      }
      if (op === 'delete') { await go(FIRESTORE + '/' + p, { method: 'DELETE' }); return true; }
      throw new Error('op is create, set, update or delete.');
    };
    // One of the site's callables (as its pages call them) → its result.
    bold.call = async (name, data) => {
      if (!/^[A-Za-z]{2,60}$/.test(String(name || ''))) throw new Error('No callable ' + name + '.');
      // Not deciding proposals (a tool must never accept changes, a tool's above all), tokens or linked accounts.
      if (/^(decideProposal|apiTokens|boldApi|mcpSandbox|linkGithub|linkGoogle)$/.test(name)) throw new Error('A tool can’t call ' + name + '.');
      return (await go(CALLABLES + name, { method: 'POST', body: JSON.stringify({ data: data || {} }) })).result;
    };
  }
  return Object.freeze(bold);
}

// The tool's code runs in a worker thread of its own, inside a vm context with nothing
// but `input` and `bold`; the worker is ended when time runs out (an endless loop too),
// and has no environment. `bold` there only sends each call here, where it's made with
// the caller's sign-in (which never enters the worker).
const { Worker } = require('worker_threads');
const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
let seq = 0;
const waiting = {};
parentPort.on('message', (m) => { const w = waiting[m.id]; if (!w) return; delete waiting[m.id]; if (m.error) w.no(new Error(m.error)); else w.ok(m.result); });
const rpc = (op) => (...args) => new Promise((ok, no) => { const id = ++seq; waiting[id] = { ok, no }; parentPort.postMessage({ id, op, args: JSON.parse(JSON.stringify(args)) }); });
const bold = { read: rpc('read'), query: rpc('query') };
if (workerData.acting) { bold.write = rpc('write'); bold.call = rpc('call'); }
const box = Object.create(null);
box.input = workerData.input;
box.bold = Object.freeze(bold);
const context = vm.createContext(box, { codeGeneration: { strings: false, wasm: false } });
const done = (out) => parentPort.postMessage(Object.assign({ done: true }, out));
let fn = null;
try { fn = vm.runInContext('(async function(input, bold){\\n"use strict";\\n' + workerData.code + '\\n})', context, { timeout: 1000 }); }
catch (e) { done({ error: 'The code doesn’t compile: ' + e.message }); }
if (fn) Promise.resolve().then(() => fn(box.input, box.bold)).then(
  (r) => { try { done({ result: JSON.stringify(r === undefined ? null : r) }); } catch (e) { done({ error: 'The result isn’t JSON: ' + e.message }); } },
  (e) => done({ error: String((e && e.message) || e) }));
`;

// Runs one tool's code → { result } or { error }. `doFetch` reaches BOLD.OS (tests pass their own).
async function runTool({ code, input, idToken, acting }, doFetch){
  if (typeof code !== 'string' || !code.trim()) return { error: 'No code.' };
  const bold = boldFor(idToken, !!acting, doFetch);
  return new Promise((resolve) => {
    let finished = false;
    const worker = new Worker(WORKER, { eval: true, env: {}, workerData: { code, input: JSON.parse(JSON.stringify(input || {})), acting: !!acting },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } });
    const end = (out) => { if (finished) return; finished = true; clearTimeout(timer); worker.terminate(); resolve(out); };
    const timer = setTimeout(() => end({ error: 'It took longer than ' + LIMITS.ms / 1000 + ' seconds.' }), LIMITS.ms);
    worker.on('message', (m) => {
      if (m.done) {
        if (m.error) return end({ error: String(m.error).slice(0, 1000) });
        if (m.result.length > LIMITS.result) return end({ error: 'The result is too large (' + m.result.length + ' characters).' });
        return end({ result: JSON.parse(m.result) });
      }
      const f = bold[m.op];
      if (!f) return worker.postMessage({ id: m.id, error: 'This tool can’t ' + m.op + '.' });
      Promise.resolve().then(() => f(...(m.args || []))).then(
        (result) => { if (!finished) worker.postMessage({ id: m.id, result: result === undefined ? null : result }); },
        (e) => { if (!finished) worker.postMessage({ id: m.id, error: String((e && e.message) || e) }); });
    });
    worker.on('error', (e) => end({ error: String((e && e.message) || e).slice(0, 1000) }));
    worker.on('exit', () => end({ error: 'The tool stopped.' }));
  });
}

module.exports = function({ onRequest, logger }){
  const mcpSandbox = onRequest({
    invoker: 'private', serviceAccount: 'mcp-sandbox@bold-d7ff2.iam.gserviceaccount.com',
    concurrency: 1, cpu: 1, memory: '256MiB', timeoutSeconds: 60, maxInstances: 10,
  }, async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    const b = req.body || {};
    if (typeof b.idToken !== 'string' || !b.idToken) return res.status(400).json({ error: 'No caller.' });
    const out = await runTool(b, fetch);
    if (out.error) logger.info('mcpSandbox: a tool failed', { error: out.error.slice(0, 300) });
    res.json(out);
  });
  return { mcpSandbox };
};
module.exports.runTool = runTool;
module.exports.fromFields = fromFields;
module.exports.toValue = toValue;
module.exports.LIMITS = LIMITS;
