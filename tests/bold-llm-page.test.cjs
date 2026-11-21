const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('BOLD LLM is a top-level sidebar page immediately after Agents', () => {
  const nav = read('src/_data/site.js');
  const agents = nav.indexOf("{ label: 'Agents', href: 'agents.html'");
  const llm = nav.indexOf("{ label: 'BOLD LLM', href: 'bold-llm.html'");
  const howTo = nav.indexOf("{ label: 'How to', href: 'guides.html'");

  assert.ok(agents >= 0, 'Agents entry is present');
  assert.ok(llm > agents, 'BOLD LLM follows Agents');
  assert.ok(howTo > llm, 'BOLD LLM precedes How to');
  assert.match(nav.slice(llm, howTo), /links: \[\], area: 'agents', separatorAfter: true/);
});

test('BOLD LLM page explains Sofya and links to access points', () => {
  const page = read('src/pages/agents/bold-llm.html');

  assert.match(page, /<h1>BOLD LLM<\/h1>/);
  assert.doesNotMatch(page, /class="eyebrow"/);
  assert.match(page, /title="Named after the mathematician Sofya Kovalevskaya">Sofya<\/a>/);
  assert.match(page, /Qwen\/Qwen3\.8-27B-FP8/);
  assert.match(page, /ALL REQUESTS ARE LOGGED FOR TRAINING PURPOSES/);
  assert.match(page, /How to access/);
  assert.match(page, /First create an API key at/);
  assert.match(page, /https:\/\/llm\.bold-lab\.ai\//);
  assert.match(page, /https:\/\/chat\.bold-lab\.ai/);
  assert.match(page, /https:\/\/en\.wikipedia\.org\/wiki\/Sofya_Kovalevskaya/);
  assert.doesNotMatch(page, /class="llm-footnote"/);
});

test('BOLD LLM copy boxes contain working cURL and OpenCode examples', () => {
  const boxes = {};
  const elements = {
    llmCurl: {},
    llmOpenCode: {}
  };
  const context = {
    BOLD: {
      copyBoxHtml(text) {
        boxes[Object.keys(boxes).length === 0 ? 'curl' : 'openCode'] = text;
        return text;
      }
    },
    document: {
      getElementById(id) {
        return elements[id];
      }
    }
  };

  vm.runInNewContext(read('src/assets/js/pages/bold-llm.js'), context);

  assert.match(boxes.curl, /^curl -sS https:\/\/llm\.bold-lab\.ai\/v1\/chat\/completions/);
  assert.match(boxes.curl, /Authorization: Bearer <api key>/);
  assert.match(boxes.curl, /"model": "Qwen\/Qwen3\.8-27B-FP8"/);

  const config = JSON.parse(boxes.openCode);
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.provider.boldlab.npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider.boldlab.options.baseURL, 'https://llm.bold-lab.ai/v1');
  assert.equal(config.provider.boldlab.options.apiKey, '<api key>');
  assert.equal(config.provider.boldlab.models['qwen3.8-27b-fp8'].id, 'Qwen/Qwen3.8-27B-FP8');
  assert.equal(config.provider.boldlab.models['qwen3.8-27b-fp8'].limit.context, 262144);
  assert.equal(config.provider.boldlab.models['qwen3.8-27b-fp8'].limit.output, 32768);
  assert.equal(config.model, 'boldlab/qwen3.8-27b-fp8');
});
