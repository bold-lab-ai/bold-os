// Sofya, BOLD's own LLM (2026-11-11: llm.bold-lab.ai, an OpenAI-compatible API, Qwen), for the home letter and
// Talking to BOLD (functions/bold-llm.js) when the lab chooses it (settings/homeLetter.model 'sofya', Settings › BOLD
// Agent; Claude by default). Its requests are logged for training, so the choice says so wherever it's made. Its key is
// the BOLD_LLM_KEY secret, never in the code. Pure but for `post` (fetch).
'use strict';

const BASE = 'https://llm.bold-lab.ai/v1';
const MODEL = 'Qwen/Qwen3.8-27B-FP8';
// How long a call may take, with Qwen thinking first: a letter (written in the background, functions/bold-llm.js
// onLetterJob, 9 minutes) and a step of an answer (Talking to BOLD, while they wait).
const LETTER_TIMEOUT = 520000, CHAT_TIMEOUT = 120000;
// The letter in steps, in one answer (letter 'steps'), in place of asking for JSON straight away.
const STEPS = 'Work in this order, all in this one answer. First write the long letter, as Markdown. Then summarise it into the short letter, as Markdown. Last, put both into JSON, in a ```json block at the very end: { "short": "…", "long": "…" }.';

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
// Pure: the JSON object in the last ```json block of what it said (after the letters written out), else jsonOf.
function lastJson(text){
  const blocks = String(text || '').match(/```json\s*([\s\S]*?)```/g);
  return blocks ? JSON.parse(blocks[blocks.length - 1].replace(/^```json\s*|```$/g, '')) : jsonOf(text);
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
      return { message: j.choices[0].message || {}, model: j.model || MODEL, finish: j.choices[0].finish_reason || '', usage: j.usage || null };
    } finally { clearTimeout(timer); }
  }
  // One completion, streamed (a letter: past the 300 s Node's fetch waits for a reply's headers, 2026-11-12), the
  // pieces put together as complete() gives them → { message, model, finish, usage, firstMs, answerMs } (firstMs: the
  // first token; answerMs: the first of the answer, after the thinking).
  async function stream(body, timeout){
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout || CHAT_TIMEOUT), t0 = Date.now();
    try {
      const r = await post(BASE + '/chat/completions', { method: 'POST', signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ model: MODEL, stream: true, stream_options: { include_usage: true } }, body)) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('Sofya answered ' + r.status + (j.error ? ': ' + String(j.error.message || j.error).slice(0, 200) : '')); }
      let content = '', reasoning = '', model = MODEL, finish = '', usage = null, firstMs = 0, answerMs = 0, buf = '';
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch (e){ continue; }
          if (j.model) model = j.model;
          if (j.usage) usage = j.usage;
          const c = j.choices && j.choices[0];
          if (!c) continue;
          const d = c.delta || {};
          const think = d.reasoning_content || d.reasoning || '';
          if ((think || d.content) && !firstMs) firstMs = Date.now() - t0;
          reasoning += think;
          if (d.content) {
            content += d.content;
            const open = content.indexOf('<think>') >= 0 && content.indexOf('</think>') < 0;
            if (!answerMs && !open && said({ content })) answerMs = Date.now() - t0;
          }
          if (c.finish_reason) finish = c.finish_reason;
        }
      }
      return { message: { content, reasoning_content: reasoning }, model, finish, usage, firstMs, answerMs };
    } finally { clearTimeout(timer); }
  }
  // A letter: the prompt, the inputs → { value: { short, long }, model, steps: [{ ms, usage }] }. How it's asked (`mode`,
  // being measured, 2026-11-12): 'schema', JSON in `schema`'s shape, enforced by the server (response_format); 'json',
  // JSON asked for in the prompt only; 'steps', in one answer: the long letter in Markdown, then the short one
  // summarising it, then both as JSON at the end (read from its last ```json block).
  // `think`: with Qwen's thinking first (2026-11-12: with it a letter took over 300 s, without it ~9 s).
  async function letter(system, user, schema, mode, think){
    const steps = [], timed = async (body) => { const t0 = Date.now(), r = await stream(think ? body : Object.assign({ chat_template_kwargs: { enable_thinking: false } }, body), LETTER_TIMEOUT); steps.push({ ms: Date.now() - t0, firstMs: r.firstMs, answerMs: r.answerMs, thinkChars: r.message.reasoning_content.length, answerChars: r.message.content.length, usage: r.usage, finish: r.finish }); if (r.finish === 'length') throw new Error('the letter was cut off'); return r; };
    if (mode === 'steps') {
      const r = await timed({ max_tokens: 16000, messages: [{ role: 'system', content: system + '\n\n' + STEPS }, { role: 'user', content: user }] });
      return { value: lastJson(said(r.message)), model: r.model, steps };
    }
    const r = await timed(Object.assign({ max_tokens: 16000, messages: [{ role: 'system', content: system + '\n\nAnswer with JSON only, as: ' + JSON.stringify(schema) }, { role: 'user', content: user }] },
      mode === 'json' ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'letter', schema, strict: true } } }));
    return { value: jsonOf(said(r.message)), model: r.model, steps };
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
module.exports.lastJson = lastJson;
module.exports.argsOf = argsOf;
