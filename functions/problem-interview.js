// Adding a problem by talking it through with BOLD-LLM (Sofya, functions/sofya.js): the person describes the
// problem, BOLD-LLM asks what's missing, one thing at a time, and keeps a draft of the Problem Bank's fields
// (problem-new.html ticks off each field it has, and saves it through benchmarkRegistry's create). Thinking off,
// so each turn takes seconds. Sofya logs its requests for training: the page says so. Pure but for `complete`.
'use strict';

const MAX_TURNS = 40, MAX_CHARS = 4000;
const TEXT = { title: 180, significance: 8000, difficulties: 8000, existing_solutions: 8000, collaborators: 8000 };

// The draft's shape, as the model answers it (strict JSON schema).
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reply', 'ready', 'draft'],
  properties: {
    reply: { type: 'string' },
    ready: { type: 'boolean' },
    draft: {
      type: 'object', additionalProperties: false,
      required: ['title', 'significance', 'difficulties', 'existing_solutions', 'builds_benchmark', 'benchmark_known', 'collaborators', 'project_ids', 'parent_ids', 'related_ids'],
      properties: {
        title: { type: 'string' }, significance: { type: 'string' }, difficulties: { type: 'string' }, existing_solutions: { type: 'string' },
        builds_benchmark: { type: 'boolean' }, benchmark_known: { type: 'boolean' }, collaborators: { type: 'string' },
        project_ids: { type: 'array', items: { type: 'string' } }, parent_ids: { type: 'array', items: { type: 'string' } }, related_ids: { type: 'array', items: { type: 'string' } }
      }
    }
  }
};

// Pure: the system prompt, with what the lab already has to link to.
function systemPrompt({ objectives, problems, projects }){
  const list = (rows, f) => rows.length ? rows.map(f).join('\n') : '(none yet)';
  return [
    'You are Sofya, BOLD’s own LLM. You help a researcher at BOLD, an AI research lab, add an open research problem to the lab’s Problem Bank, by conversation. If you mention yourself, you are Sofya.',
    'Start from what they describe. Ask about the required fields first, one missing thing at a time, briefly and warmly, in plain British English. Never ask about something they already told you. Don’t lecture or invent facts about their research: when unsure, ask.',
    '',
    'A problem is not a method. Watch for the XY problem: people often describe the solution they have in mind (Y: "use diffusion models for X", "build a tool that…", "fine-tune an LLM to…", "apply RL to…") instead of the problem it is meant to solve (X). The Problem Bank holds problems: what we want to know or be able to do, and why it is hard, independent of any one way of solving it, so that several methods and projects can attack the same problem and be compared.',
    'When what they describe is a method, a tool or an approach, say so gently and ask what it is for: what goes wrong today, what we can’t yet do or don’t yet know, and how we would tell it was solved. Keep asking until you reach a problem that other methods could also be tried on. Their method belongs elsewhere: mention it in existing_solutions only if it is already part of the frontier, otherwise it is a project for later, not the problem.',
    'Write the title and the other fields about the problem, never about the method: "Training runs diverge without warning", not "A divergence detector based on gradient statistics". If the person insists the method itself is the goal, it may be a benchmark or a project rather than a problem: ask which.',
    '',
    'The Problem Bank needs, for each problem:',
    '- title: a short, specific name for the problem (at most 180 characters). Propose one yourself once you understand it.',
    '- significance: why it matters, who benefits if it’s solved.',
    '- difficulties: what makes it hard.',
    '- existing_solutions: where the frontier is: what current methods can do, and what remains open.',
    '- builds_benchmark: true only if the goal is to build a benchmark itself (then it needs no separate verifier). Ask if it’s unclear. benchmark_known: true once you know either way.',
    'Optional: once the required fields are there, suggest these when they fit (one question for all of them), and confirm with the person:',
    '- parent_ids: the northstars, moonshots or broader problems it contributes to (ids from the lists below).',
    '- related_ids: related problems (ids from the problem list).',
    '- project_ids: existing projects working on it (ids from the project list).',
    '- collaborators: names of people working on it with them.',
    '',
    'Write each text field in the researcher’s voice, from what they said, concise and concrete (a few sentences). Keep every field you already have unless they change it; use "" or [] for what you don’t know yet.',
    'Set ready to true once title, significance, difficulties and existing_solutions are filled and benchmark_known is true; then sum up the problem in two or three sentences, and tell them it’s ready to check in Check and edit, under the conversation, where they can change any field and save it, or that they can keep talking to change anything.',
    'Answer with JSON only, exactly this shape: { "reply": what you say to them next, "ready": true or false, "draft": { "title": "", "significance": "", "difficulties": "", "existing_solutions": "", "builds_benchmark": false, "benchmark_known": false, "collaborators": "", "project_ids": [], "parent_ids": [], "related_ids": [] } }.',
    '',
    'Northstars and moonshots (id: title):', list(objectives, (o) => o.id + ': ' + o.title + ' (' + o.kind + ')'),
    '',
    'Problems already in the bank (id: title):', list(problems, (p) => p.id + ': ' + p.title),
    '',
    'Projects (id: title):', list(projects, (p) => p.id + ': ' + p.title)
  ].join('\n');
}

// Pure: the conversation as sent, or throws a message for the person.
function turnsOf(turns){
  if (!Array.isArray(turns) || !turns.length || turns.length > MAX_TURNS) throw new Error('Start again: the conversation is too long or empty.');
  const out = turns.map((t) => {
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string' || !t.content.trim() || t.content.length > MAX_CHARS)
      throw new Error('Keep each message under ' + MAX_CHARS + ' characters.');
    return { role: t.role, content: t.content.trim() };
  });
  if (out[out.length - 1].role !== 'user') throw new Error('Say something first.');
  return out;
}

// Pure: the model's draft, kept to known fields and ids it was given.
function cleanDraft(d, known){
  d = d && typeof d === 'object' ? d : {};
  const out = {};
  Object.keys(TEXT).forEach((k) => { out[k] = typeof d[k] === 'string' ? d[k].trim().slice(0, TEXT[k]) : ''; });
  out.builds_benchmark = d.builds_benchmark === true;
  out.benchmark_known = d.benchmark_known === true;
  const ids = (list, allowed) => Array.from(new Set((Array.isArray(list) ? list : []).map(String).filter((id) => allowed.has(id)))).slice(0, 20);
  out.project_ids = ids(d.project_ids, known.projects);
  out.parent_ids = ids(d.parent_ids, known.parents);
  out.related_ids = ids(d.related_ids, known.problems).filter((id) => out.parent_ids.indexOf(id) < 0);
  return out;
}
// Pure: whether the required fields are there.
function complete(d){ return !!(d.title && d.significance && d.difficulties && d.existing_solutions && d.benchmark_known); }

// One turn: `turns` [{ role, content }], what the lab has (`lab`: { objectives, problems, projects }), Sofya's
// `complete`, and the draft as it stands on the page (`current`) → { reply, ready, draft }.
async function interview(turns, lab, sofyaComplete, said, jsonOf, current){
  const so = current && typeof current === 'object' ? JSON.stringify(current).slice(0, 30000) : '';
  const messages = [{ role: 'system', content: systemPrompt(lab) + (so ? '\n\nThe draft so far (keep it, unless what they say changes it):\n' + so : '') }].concat(turnsOf(turns));
  // JSON object mode, not a strict schema: under load (20 at once, 2026-11-23) the schema's guided decoding now and
  // then ran on to the token limit (4 of 40 turns, ~42 s each); object mode answered all 40, median 5 s. The shape is
  // in the prompt, and the answer is checked here; one retry if it still can't be read.
  const ask = () => sofyaComplete({ max_tokens: 1500, messages, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } })
    .then((r) => jsonOf(said(r.message)));
  const v = await ask().catch(() => ask());
  const known = { projects: new Set(lab.projects.map((p) => p.id)), problems: new Set(lab.problems.map((p) => p.id)),
    parents: new Set(lab.objectives.map((o) => o.id).concat(lab.problems.map((p) => p.id))) };
  const draft = cleanDraft(v && v.draft, known);
  const reply = typeof (v && v.reply) === 'string' && v.reply.trim() ? v.reply.trim().slice(0, MAX_CHARS) : 'Tell me more about it.';
  // Ready once what's needed is there, whatever the model's own `ready` says (it often drafts it all and forgets to say).
  return { reply, draft, ready: complete(draft) };
}

module.exports = { interview, systemPrompt, turnsOf, cleanDraft, SCHEMA, MAX_TURNS };
