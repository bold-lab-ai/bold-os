// ---------- BOLD.OS for agents: the tools the lab adds (functions/api.js) ----------
// Everything agents get comes from the site, its single source of truth: instructions
// from the BOLDiquette, prompts from the skills, resources from the pages, and the tools
// the lab adds from the Tools pages (tools.html, tool.html): agentTools/{name} { name,
// title, description, acting, input: { name: { type, description, required } }, code,
// createdAt, createdBy, updatedAt, updatedBy, changeNote, proposedBy }, kept in the
// version history like the skills. Like everything on the site, a tool changes only by
// a proposal on its page (agentTools/{name}/proposals, kinds 'new', 'tool', 'delete'),
// which another PI or admin accepts (decideProposal), while Claude reviews it
// (reviewer.js). This file checks a tool (check, also used when one is accepted), lists
// the added tools for agents, and runs one, in mcpSandbox (sandbox.js) as whoever
// calls it: a tool's code never runs in BOLD.OS's own functions.
const vm = require('vm');

const NAME = /^[a-z][a-z0-9_]{2,40}$/;
const SANDBOX = 'https://mcpsandbox-5mde3ilmqa-nw.a.run.app';

module.exports = function(ctx){
  const { db, httpError, builtins, idTokenFor, fetchImpl, sandboxUrl } = ctx;
  const doFetch = fetchImpl || fetch;

  // The added tools (kept 30 seconds per instance); never one in a built-in tool's name.
  let cache = null;
  async function items(){
    if (cache && Date.now() - cache.at < 30000) return cache.value;
    const own = builtins().map((t) => t.name), value = {};
    (await db.collection('agentTools').get()).docs.forEach((d) => { if (own.indexOf(d.id) === -1) value[d.id] = d.data(); });
    cache = { at: Date.now(), value };
    return value;
  }

  // A tool as proposed → its fields, checked; throws an Error with `status` 400.
  const text = (v, max, what) => { if (typeof v !== 'string') throw httpError(400, what + ' must be text.'); if (v.length > max) throw httpError(400, what + ' is at most ' + max + ' characters.'); return v; };
  function check(name, def){
    if (!NAME.test(name || '')) throw httpError(400, 'A tool’s name is lowercase, with letters, digits and _ (3 to 41 characters).');
    if (builtins().some((t) => t.name === name)) throw httpError(400, name + ' is one of BOLD.OS’s own tools: choose another name.');
    def = def || {};
    const code = text(def.code || '', 50000, 'The code');
    // Compiled here only to catch mistakes: it runs only in mcpSandbox.
    try { new vm.Script('(async function(input, bold){\n' + code + '\n})'); } catch (e) { throw httpError(400, 'The code doesn’t compile: ' + e.message); }
    const input = {}, keys = Object.keys(def.input || {});
    if (keys.length > 12) throw httpError(400, 'At most 12 inputs.');
    keys.forEach((k) => {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(k)) throw httpError(400, 'Input names are lowercase words: ' + k);
      const d = def.input[k] || {};
      if (['string', 'integer', 'number', 'boolean', 'array', 'object'].indexOf(d.type || 'string') === -1) throw httpError(400, 'Input ' + k + ': its type is string, integer, number, boolean, array or object.');
      input[k] = { type: d.type || 'string', description: text(d.description || '', 300, 'Input ' + k + '’s description'), required: d.required === true };
    });
    return { title: text(def.title || name, 120, 'The title'), description: text(def.description || '', 1500, 'The description'), acting: def.acting === true, input, code };
  }

  async function sandboxToken(){
    // Cloud Run checks this: boldApi's own identity, for the sandbox's address.
    const r = await doFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(sandboxUrl || SANDBOX), { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) throw httpError(503, 'The sandbox can’t be reached.');
    return r.text();
  }
  async function runTool(who, name, input){
    const def = (await items())[name];
    if (!def) throw httpError(404, 'No tool ' + name + '.');
    if (def.acting && !who.write) throw httpError(403, 'This token can only read: ' + name + ' acts. Ask on your profile to let it act.');
    input = input || {};
    Object.keys(def.input || {}).forEach((k) => { if (def.input[k].required && (input[k] === undefined || input[k] === '')) throw httpError(400, name + ' needs ' + k + '.'); });
    const [idToken, auth] = await Promise.all([idTokenFor(who.email), sandboxToken()]);
    const r = await doFetch(sandboxUrl || SANDBOX, { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: def.code, input, idToken, acting: !!def.acting }) });
    const out = await r.json().catch(() => ({ error: 'The sandbox answered ' + r.status + '.' }));
    if (out.error) throw httpError(400, name + ': ' + out.error);
    return out.result;
  }

  // For tools/list: the added tools this token may use (acting ones only if it acts).
  async function toolList(who){
    const t = await items();
    return Object.keys(t).filter((n) => !t[n].acting || who.write).map((n) => {
      const props = {}, required = [];
      Object.keys(t[n].input || {}).forEach((k) => { props[k] = { type: t[n].input[k].type, description: t[n].input[k].description }; if (t[n].input[k].required) required.push(k); });
      return { name: n, description: (t[n].description || '') + ' (Added by the lab: tool.html?tool=' + n + '.)', inputSchema: { type: 'object', properties: props, required }, write: !!t[n].acting, added: true };
    });
  }
  // list_tools: BOLD.OS's own tools and the lab's, so an agent can improve them.
  async function listTools(who, a){
    const t = await items();
    return {
      how: 'BOLD.OS improves itself through its pages: propose a change to a tool with the proposals tool (page "tool:<name>"; a new name proposes a new tool), as to the BOLDiquette, a guide or a skill. Another PI or admin accepts it. ' +
        'A tool is { title, description, acting, input: { name: { type, description, required } }, code }: code is the body of an async function (input, bold) returning JSON, run in a sandbox as whoever calls it, under BOLD.OS’s rules: ' +
        'bold.read(path), bold.query(collection, { where: [[field, op, value]], orderBy: [field, "asc"|"desc"], limit, group }), and for acting tools bold.write(op, path, data, id) (create, set, update, delete) and bold.call(callable, data).',
      built_in: builtins().map((x) => ({ name: x.name, acting: !!x.write })),
      added: Object.keys(t).map((n) => ({ name: n, title: t[n].title || n, acting: !!t[n].acting, description: t[n].description, input: t[n].input, code: a && a.with_code ? t[n].code : undefined,
        url: (ctx.SITE_URL || '') + 'tool.html?tool=' + encodeURIComponent(n) })),
    };
  }

  return { items, check, runTool, toolList, listTools, reset: () => { cache = null; } };
};
