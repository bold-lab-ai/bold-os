// Telling BOLD.OS what's wrong with it, or what it should do (the home page's first two starters, 2026-11-24): a
// talk with Sofya (homeLetter 'ask' with an intent), then a card for BOLD OS's own board, as Slack's /bug and
// /feature-request make (functions/index.js SLASH_CARDS), which the person checks and adds themselves (index.js).
// Pure.
'use strict';

// BOLD OS's project (its board: projectWorkspaces/{BOARD}/work).
const BOARD = 'card-1793045860037-ols029';
const INTENTS = {
  bug: { prefix: 'Bug: ', kind: 'code',
    ask: 'where on BOLD.OS it happened (the page), what happened, what they expected, the steps to make it happen again, how bad it is (it blocks them, it gets in the way, or it only looks wrong) and their device and browser',
    sections: ['Where', 'What happened', 'What I expected', 'Steps to reproduce', 'Device and browser'] },
  feature: { prefix: 'Feature request: ', kind: 'request',
    ask: 'what they want to do that BOLD.OS doesn’t let them, why it matters to them (what they do today instead), where on BOLD.OS they’d expect it, and who else it would help',
    sections: ['What I want to do', 'Why it matters', 'What I do today', 'Where I’d expect it', 'Who else it helps'] }
};
function intentOf(x){ return Object.prototype.hasOwnProperty.call(INTENTS, x) ? x : ''; }

// Added to the talking-to-bold prompt while they're reporting.
function guidance(intent){
  const i = INTENTS[intentOf(intent)];
  if (!i) return '';
  return '\n\n## Now: ' + (intent === 'bug' ? 'they are reporting something wrong with BOLD.OS' : 'they are asking for something new on BOLD.OS') + '\n' +
    'Help them write it up for BOLD OS’s board, where the people who build BOLD.OS pick it up. Find out ' + i.ask + '. ' +
    'Ask one or two short questions at a time, only for what they haven’t said; take what they say at their word and don’t argue. ' +
    'Don’t try to fix it or work around it unless they ask. Once you have enough, say so in one sentence and tell them to press “Add it to the board” below; ' +
    'they check the card before it’s added. Never say it has been filed: only they add it.';
}

// The card's draft, from the conversation: asked of Sofya as JSON.
function cardPrompt(intent){
  const i = INTENTS[intentOf(intent)];
  return 'You turn a conversation between a person and Sofya, BOLD’s own LLM, into a card for the board of BOLD.OS (the lab’s operating system). ' +
    'It is ' + (intent === 'bug' ? 'a bug report' : 'a feature request') + ', in the person’s own words: first person, plain, nothing invented. ' +
    'Answer with JSON only, exactly this shape: {"title": "", "severity": "", "sections": {' + i.sections.map((s) => JSON.stringify(s) + ': ""').join(', ') + '}}. ' +
    'title: what it is, at most 12 words, without a "Bug:" or "Feature request:" prefix. ' +
    (intent === 'bug' ? 'severity: "blocks" (it stops them), "annoying" (it gets in the way) or "cosmetic" (it only looks wrong), or "" if they didn’t say. ' : 'severity: "". ') +
    'sections: Markdown each, "" for any they didn’t cover.';
}
const SEVERITY = { blocks: 'blocks me', annoying: 'annoying', cosmetic: 'cosmetic' };
// Pure: Sofya's answer → { title, notes, kind } for the card, or throws.
function cardOf(v, intent){
  const i = INTENTS[intentOf(intent)];
  if (!i) throw new Error('Report a bug or ask for a feature.');
  v = v && typeof v === 'object' ? v : {};
  const t = String(v.title || '').replace(/^\s*(bug|feature request)\s*(\([^)]*\))?\s*:\s*/i, '').trim().slice(0, 150);
  if (!t) throw new Error('Sofya couldn’t draft it.');
  const sev = intent === 'bug' && SEVERITY[v.severity] ? v.severity : '';
  const s = v.sections && typeof v.sections === 'object' ? v.sections : {};
  const out = [];
  if (sev) out.push('**Severity:** ' + SEVERITY[sev].charAt(0).toUpperCase() + SEVERITY[sev].slice(1));
  i.sections.forEach((k) => { const x = String(s[k] || '').trim(); if (x) out.push('### ' + k + '\n' + x.slice(0, 4000)); });
  const title = sev ? 'Bug (' + SEVERITY[sev] + '): ' + t : i.prefix + t;
  return { title: title.slice(0, 200), notes: out.join('\n\n').slice(0, 20000), kind: i.kind };
}

module.exports = { BOARD, INTENTS, intentOf, guidance, cardPrompt, cardOf };
