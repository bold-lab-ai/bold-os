// Sofya's chat using BOLD.OS's MCP as whoever is signed in (functions/keycloak.js): only the lab's Keycloak, for its chat.
const test = require('node:test');
const assert = require('node:assert');
const { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } = require('../functions/node_modules/jose');
const K = require('../functions/keycloak.js');

async function setup(){
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = Object.assign(await exportJWK(publicKey), { kid: 'k1', alg: 'RS256' });
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims, o) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer((o && o.iss) || K.ISSUER)
    .setIssuedAt().setExpirationTime((o && o.exp) || '5m').sign(privateKey);
  return { keys, sign };
}

test('a BOLD.OS token isn’t taken for a sign-in', () => {
  assert.strictEqual(K.looksLikeJwt('bold_abcdefghijklmnopqrstuvwxyz'), false);
  assert.strictEqual(K.looksLikeJwt('aaa.bbb.ccc'), true);
});

test('the lab’s Keycloak, for Sofya’s chat: the person it vouches for', async () => {
  const { keys, sign } = await setup();
  const t = await sign({ azp: 'open-webui', email: 'Ana@Example.org', email_verified: true, name: 'Ana' });
  assert.deepStrictEqual(await K.verify(t, keys), { email: 'ana@example.org', name: 'Ana' });
});

test('anything else is refused: another issuer, another app, expired, no verified email, another key', async () => {
  const { keys, sign } = await setup();
  await assert.rejects(K.verify(await sign({ azp: 'open-webui', email: 'a@x.org' }, { iss: 'https://evil.example/realms/x' }), keys));
  await assert.rejects(K.verify(await sign({ azp: 'other-app', email: 'a@x.org' }), keys), /not issued/);
  await assert.rejects(K.verify(await sign({ azp: 'open-webui', email: 'a@x.org' }, { exp: Math.floor(Date.now() / 1000) - 3600 }), keys));
  await assert.rejects(K.verify(await sign({ azp: 'open-webui', email: 'a@x.org', email_verified: false }), keys), /verified/);
  await assert.rejects(K.verify(await sign({ azp: 'open-webui' }), keys), /no email/);
  const other = await setup();
  await assert.rejects(K.verify(await other.sign({ azp: 'open-webui', email: 'a@x.org' }), keys));
});
