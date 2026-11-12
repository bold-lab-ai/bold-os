// Sofya's chat (chat.bold-lab.ai, Open WebUI) using BOLD.OS's MCP as whoever is signed in there (2026-11-12): it sends
// each person's own Keycloak access token (the lab's realm bold-internal, client open-webui) instead of a BOLD.OS token,
// so no one's token is kept on that server. BOLD.OS checks it against the realm's published keys, its issuer, that it
// was issued to that client and hasn't expired, and takes the email it vouches for (functions/api.js authorize).
// Whoever controls the realm could vouch for anyone: it must be the lab's own.
'use strict';
const { createRemoteJWKSet, jwtVerify } = require('jose');

const ISSUER = 'https://keycloak.bold-lab.ai/realms/bold-internal';
const CLIENTS = ['open-webui'];
const JWKS = createRemoteJWKSet(new URL(ISSUER + '/protocol/openid-connect/certs'), { cacheMaxAge: 600000 });

// Pure: whether a bearer value looks like a JWT (three base64url parts), not a BOLD.OS token.
const looksLikeJwt = (s) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(String(s || ''));

// Pure: the person a verified token's claims name → { email, name }, or throws (the reason).
function personOf(claims){
  const client = claims.azp || (Array.isArray(claims.aud) ? claims.aud.find((a) => CLIENTS.indexOf(a) >= 0) : claims.aud);
  if (CLIENTS.indexOf(client) < 0) throw new Error('not issued to Sofya’s chat');
  if (claims.email_verified === false) throw new Error('its email isn’t verified');
  const email = String(claims.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('no email in it');
  return { email, name: String(claims.name || claims.preferred_username || '') };
}

// A Keycloak access token → { email, name }, or throws.
async function verify(token, keys){
  const { payload } = await jwtVerify(token, keys || JWKS, { issuer: ISSUER, clockTolerance: 30 });
  return personOf(payload);
}

module.exports = { ISSUER, CLIENTS, looksLikeJwt, personOf, verify };
