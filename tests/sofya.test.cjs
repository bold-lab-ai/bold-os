// Sofya, BOLD's own LLM (functions/sofya.js): the OpenAI-compatible calls the home letter and Talking to BOLD make.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../functions/sofya.js');

// A pretend server: answers in turn, keeping what it was sent.
function server(answers){
  const sent = [];
  const post = async (url, init) => {
    sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    const a = answers.shift(), body = JSON.parse(init.body);
    // Streamed (a letter): the message as server-sent events, a piece at a time.
    const events = body.stream && !a.status ? [{ model: S.MODEL, choices: [{ delta: { reasoning_content: 'hmm' } }] }]
      .concat(String(a.message.content).match(/[\s\S]{1,7}/g).map((c) => ({ choices: [{ delta: { content: c } }] })))
      .concat([{ choices: [{ delta: {}, finish_reason: a.finish || 'stop' }] }, { choices: [], usage: { completion_tokens: 9 } }]) : null;
    const enc = new TextEncoder();
    return { ok: a.status ? a.status < 300 : true, status: a.status || 200,
      body: events && (async function*(){ for (const e of events) yield enc.encode('data: ' + JSON.stringify(e) + '\n\n'); yield enc.encode('data: [DONE]\n\n'); })(),
      json: async () => a.json || { model: S.MODEL, choices: [{ message: a.message, finish_reason: a.finish || 'stop' }] } };
  };
  return { post, sent };
}

test('the tools, in OpenAI’s shape; what it said without its thinking; JSON from what it said', () => {
  assert.deepStrictEqual(S.openAITools([{ name: 'search', description: 'Find', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]),
    [{ type: 'function', function: { name: 'search', description: 'Find', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]);
  assert.strictEqual(S.said({ content: '<think>hmm</think>\n\nHello.' }), 'Hello.');
  assert.strictEqual(S.said({ content: 'reasoning…</think>Hello.' }), 'Hello.');   // the opening tag left out
  assert.deepStrictEqual(S.jsonOf('```json\n{"short":"a","long":"b"}\n```'), { short: 'a', long: 'b' });
  assert.deepStrictEqual(S.jsonOf('Here: {"short":"a","long":"b"} done'), { short: 'a', long: 'b' });
  assert.deepStrictEqual(S.lastJson('Long: {x}\n```json\n{"a":1}\n```\nShort.\n```json\n{"short":"s","long":"l {y}"}\n```'), { short: 's', long: 'l {y}' });
  assert.deepStrictEqual(S.argsOf({ function: { arguments: '{"q":"x"}' } }), { q: 'x' });
  assert.deepStrictEqual(S.argsOf({ function: { arguments: 'not json' } }), {});
});

test('a letter: the prompt as the system message, JSON asked for and read back', async () => {
  const srv = server([{ message: { content: '<think>…</think>{"short":"Hi","long":"Hello there"}' } }]);
  const r = await S({ key: () => 'k', post: srv.post }).letter('Write it.', 'The JSON: {}', { type: 'object' });
  assert.deepStrictEqual(r.value, { short: 'Hi', long: 'Hello there' });
  assert.strictEqual(srv.sent[0].url, S.BASE + '/chat/completions');
  assert.strictEqual(srv.sent[0].auth, 'Bearer k');
  assert.strictEqual(srv.sent[0].body.model, S.MODEL);
  assert.strictEqual(srv.sent[0].body.messages[0].role, 'system');
  assert.strictEqual(srv.sent[0].body.response_format.type, 'json_schema');
  assert.strictEqual(srv.sent[0].body.stream, true);
  assert.strictEqual(srv.sent[0].body.chat_template_kwargs.enable_thinking, false);   // thinking off unless asked for
  assert.strictEqual(r.steps[0].usage.completion_tokens, 9);
  assert.ok(r.steps[0].thinkChars === 3);
});

test('a letter in steps: one call, no JSON enforced, read from the last ```json block', async () => {
  const srv = server([{ message: { content: 'Long letter…\n\nShort one.\n```json\n{"short":"S","long":"L"}\n```' } }]);
  const r = await S({ key: () => 'k', post: srv.post }).letter('Write it.', 'The JSON: {}', { type: 'object' }, 'steps');
  assert.deepStrictEqual(r.value, { short: 'S', long: 'L' });
  assert.strictEqual(srv.sent.length, 1);
  assert.strictEqual(srv.sent[0].body.response_format, undefined);
  assert.match(srv.sent[0].body.messages[0].content, /First write the long letter/);
  const srv2 = server([{ message: { content: '```json\n{"short":"S","long":"L"}\n```' } }]);
  await S({ key: () => 'k', post: srv2.post }).letter('W', 'J', { type: 'object' }, 'json', 'medium');
  assert.strictEqual(srv2.sent[0].body.reasoning_effort, 'medium');
  assert.strictEqual(srv2.sent[0].body.chat_template_kwargs, undefined);
});

test('an answer: it calls a tool, reads the result, then answers', async () => {
  const srv = server([
    { message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"ICLR"}' } }] }, finish: 'tool_calls' },
    { message: { content: 'ICLR is in May.' } },
  ]);
  const ran = [];
  const out = await S({ key: () => 'k', post: srv.post }).chat('Be BOLD.', [{ role: 'user', content: 'When is ICLR?' }],
    [{ name: 'search', description: '', input_schema: { type: 'object' } }], async (name, args) => { ran.push([name, args]); return 'ICLR: 2027-05-04'; }, 4);
  assert.strictEqual(out, 'ICLR is in May.');
  assert.deepStrictEqual(ran, [['search', { q: 'ICLR' }]]);
  const second = srv.sent[1].body.messages;
  assert.deepStrictEqual(second.slice(-2).map((m) => m.role), ['assistant', 'tool']);
  assert.strictEqual(second[second.length - 1].tool_call_id, 'c1');
});

test('a failure is thrown, for Claude to step in', async () => {
  const srv = server([{ status: 503, json: { error: { message: 'down' } } }]);
  await assert.rejects(S({ key: () => 'k', post: srv.post }).letter('x', 'y', {}), /503: down/);
});
