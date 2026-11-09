// Preloaded only for the local Functions emulator integration test.
process.env.PHOTO_SLACK_MOCK = 'on';
const originalFetch = global.fetch;
const { File } = require('../functions/node_modules/@google-cloud/storage');
File.prototype.getSignedUrl = async function(options) {
  if (options.version !== 'v4' || options.action !== 'read') throw new Error('Expected a V4 read URL');
  return ['https://storage.googleapis.com/demo-test/' + this.name + '?signed=day'];
};
global.fetch = function(url, options) {
  const target = String(url);
  if (target.startsWith('https://slack.com/api/users.info?')) {
    return Promise.resolve(new Response(JSON.stringify({ ok:true, user:{ profile:{ is_custom_image:true, image_192:'https://avatars.slack-edge.com/synthetic.jpg' } } }), { headers:{ 'content-type':'application/json' } }));
  }
  if (target === 'https://avatars.slack-edge.com/synthetic.jpg') {
    return Promise.resolve(new Response(Buffer.from([0xff,0xd8,0xff,0xd9]), { headers:{ 'content-type':'image/jpeg' } }));
  }
  if (/^https:\/\/(slack\.com|[^/]*slack-edge\.com)\//.test(target)) {
    return Promise.reject(new Error('Unexpected Slack request in profile-photo test'));
  }
  return originalFetch(url, options);
};
