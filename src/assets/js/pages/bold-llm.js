// Sofya: BOLD's self-hosted LLM. The page's copyable examples use the shared
// copy box (bold.js), so their clipboard control behaves like every other one on the site.
(function(){
  var curl = [
    'curl -sS https://llm.bold-lab.ai/v1/chat/completions \\',
    '  -H "Authorization: Bearer <api key>" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '{",
    '    "model": "Qwen/Qwen3.8-27B-FP8",',
    '    "messages": [{"role": "user", "content": "Who are you?"}]',
    "  }'",
  ].join('\n');

  var opencode = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      boldlab: {
        npm: '@ai-sdk/openai-compatible',
        name: 'BoldLab',
        options: {
          baseURL: 'https://llm.bold-lab.ai/v1',
          apiKey: '<api key>',
        },
        models: {
          'qwen3.8-27b-fp8': {
            id: 'Qwen/Qwen3.8-27B-FP8',
            name: 'Qwen 3.8 27B',
            limit: { context: 262144, output: 32768 },
          },
        },
      },
    },
    model: 'boldlab/qwen3.8-27b-fp8',
  }, null, 2);

  var curlBox = document.getElementById('llmCurl');
  var opencodeBox = document.getElementById('llmOpenCode');
  if (curlBox) curlBox.innerHTML = BOLD.copyBoxHtml(curl);
  if (opencodeBox) opencodeBox.innerHTML = BOLD.copyBoxHtml(opencode);
})();
