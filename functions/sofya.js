// Sofya, BOLD's own LLM (2026-11-11: llm.bold-lab.ai, an OpenAI-compatible API, Qwen), for the home letter and
// Talking to BOLD (functions/bold-llm.js) when the lab chooses it (settings/homeLetter.model 'sofya', Settings › BOLD
// Agent; Claude by default). Its requests are logged for training, so the choice says so wherever it's made. Its key is
// the BOLD_LLM_KEY secret, never in the code. Pure but for `post` (fetch).
'use strict';

const BASE = 'https://llm.bold-lab.ai/v1';
const MODEL = 'Qwen/Qwen3.8-27B-FP8';
// How long a call may take, with Qwen thinking first: a letter (written in the background, functions/bold-llm.js
// onLetterJob, 9 minutes) and a step of an answer (Talking to BOLD, while they wait).
const LETTER_TIMEOUT = 300000, CHAT_TIMEOUT = 120000;

// Pure: the agents' tools (Anthropic's shape: { name, description, input_schema }) in OpenAI's.
function openAITools(tools){
  return (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
}
// Pure: what the model said, without its thinking (<think>…</think>, when the server doesn't take it out).
function said(msg){
  return String((msg && msg.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}
// Pure: a JSON object from what it said (a ```json fence, or the first {…} in it). → the object, or throws.
function jsonOf(text){
  const t = String(text || '').trim(), fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fence ? fence[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  return JSON.parse(body);
}
// Pure: a tool call's arguments (a JSON string) → an object.
function argsOf(call){
  try { const a = JSON.parse((call && call.function && call.function.arguments) || '{}'); return a && typeof a === 'object' ? a : {}; }
  catch (e){ return {}; }
}

module.exports = function({ key, post }){
  post = post || ((url, init) => fetch(url, init));
  // One completion → { message, model, finish }. Throws on anything but an answer.
  async function complete(body, timeout){
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout || CHAT_TIMEOUT);
    try {
      const r = await post(BASE + '/chat/completions', { method: 'POST', signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' },
        // Qwen thinks first (its default); what it says is read without its thinking (said).
        body: JSON.stringify(Object.assign({ model: MODEL }, body)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.choices || !j.choices[0]) throw new Error('Sofya answered ' + r.status + (j.error ? ': ' + String(j.error.message || j.error).slice(0, 200) : ''));
      return { message: j.choices[0].message || {}, model: j.model || MODEL, finish: j.choices[0].finish_reason || '' };
    } finally { clearTimeout(timer); }
  }
  // A letter: the prompt, the inputs, and JSON back in `schema`'s shape (response_format, and said so too).
  async function letter(system, user, schema){
    const r = await complete({ max_tokens: 16000, response_format: { type: 'json_schema', json_schema: { name: 'letter', schema, strict: true } },
      messages: [{ role: 'system', content: system + '\n\nAnswer with JSON only, as: ' + JSON.stringify(schema) }, { role: 'user', content: user }] }, LETTER_TIMEOUT);
    if (r.finish === 'length') throw new Error('the letter was cut off');
    return { value: jsonOf(said(r.message)), model: r.model };
  }
  // An answer: the prompt, the conversation ([{ role, content }]), the reading tools, run as them by `run(name, args)`,
  // at most `rounds` rounds. → its text.
  async function chat(system, turns, tools, run, rounds){
    const messages = [{ role: 'system', content: system }].concat(turns);
    const fns = openAITools(tools);
    for (let i = 0; i < rounds; i++) {
      const r = await complete({ max_tokens: 8000, messages, tools: fns.length ? fns : undefined });
      const calls = (r.message.tool_calls || []).filter((c) => c && c.function && c.function.name);
      if (!calls.length) return said(r.message) || 'Nothing to say to that.';
      messages.push({ role: 'assistant', content: r.message.content || '', tool_calls: calls });
      for (const c of calls) messages.push({ role: 'tool', tool_call_id: c.id, content: await run(c.function.name, argsOf(c)) });
    }
    return 'That took too many steps: ask something narrower.';
  }
  return { letter, chat, complete };
};
module.exports.BASE = BASE;
module.exports.MODEL = MODEL;
module.exports.openAITools = openAITools;
module.exports.said = said;
module.exports.jsonOf = jsonOf;
module.exports.argsOf = argsOf;
