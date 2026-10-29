const encoder = new TextEncoder();

export function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

export function base64UrlEncode(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid Access token');
  return {
    header: JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))),
    payload: JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))),
    signed: encoder.encode(`${parts[0]}.${parts[1]}`),
    signature: base64UrlDecode(parts[2]),
  };
}

function audienceMatches(audience, expected) {
  return (Array.isArray(audience) ? audience : [audience]).map(String).includes(expected);
}

async function verifyRs256Jwk(parsed, keysUrl, keyLabel, fetcher) {
  const response = await fetcher(keysUrl, {
    cf: { cacheEverything: true, cacheTtl: 3600 },
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Unable to load ${keyLabel} signing keys`);
  const { keys = [] } = await response.json();
  const jwk = keys.find(key => key.kid === parsed.header.kid);
  if (!jwk) throw new Error(`${keyLabel} signing key not found`);
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, parsed.signature, parsed.signed);
  if (!valid) throw new Error(`Invalid ${keyLabel} token signature`);
}

export async function verifyGoogleIdToken(token, clientId, expectedNonce, fetcher = fetch, nowSeconds = Date.now() / 1000) {
  if (!clientId || !expectedNonce) throw new Error('Google sign-in is not configured');
  const parsed = parseJwt(token);
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid) throw new Error('Unsupported Google ID token');
  const issuer = String(parsed.payload.iss || '');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(issuer)) {
    throw new Error('Invalid Google ID token issuer');
  }
  if (!audienceMatches(parsed.payload.aud, clientId)) throw new Error('Invalid Google ID token audience');
  if (Array.isArray(parsed.payload.aud) && parsed.payload.aud.length > 1 && parsed.payload.azp !== clientId) {
    throw new Error('Invalid Google ID token authorized party');
  }
  if (Number(parsed.payload.exp || 0) <= nowSeconds || Number(parsed.payload.iat || 0) > nowSeconds + 60) {
    throw new Error('Expired Google ID token');
  }
  if (parsed.payload.nonce !== expectedNonce) throw new Error('Invalid Google ID token nonce');
  if (parsed.payload.email_verified !== true || !parsed.payload.email || !parsed.payload.sub) {
    throw new Error('Google account email is not verified');
  }
  await verifyRs256Jwk(parsed, 'https://www.googleapis.com/oauth2/v3/certs', 'Google', fetcher);
  return parsed.payload;
}

export async function verifyAccessJwt(token, teamDomain, audience, fetcher = fetch, nowSeconds = Date.now() / 1000) {
  if (!teamDomain || !audience) throw new Error('Cloudflare Access is not configured');
  const parsed = parseJwt(token);
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid) throw new Error('Unsupported Access token');
  const issuer = new URL(teamDomain).origin;
  if (parsed.payload.iss !== issuer || !audienceMatches(parsed.payload.aud, audience)) throw new Error('Invalid Access token claims');
  if (Number(parsed.payload.exp || 0) <= nowSeconds || Number(parsed.payload.nbf || 0) > nowSeconds) {
    throw new Error('Expired Access token');
  }
  await verifyRs256Jwk(parsed, `${issuer}/cdn-cgi/access/certs`, 'Access', fetcher);
  return parsed.payload;
}

export async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

function base64ToBytes(value) {
  const normalized = String(value || '').replace(/\s+/g, '');
  return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
}

/**
 * Import a PKCS#8 (base64 DER) ECDSA P-256 private key for signing capability
 * tokens. The private key lives only in the Worker (never shipped to clients),
 * so diagnostic clients can verify tokens but cannot mint them.
 */
export async function importEcdsaPrivateKey(pkcs8Base64) {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(pkcs8Base64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** The verify-only half of the Worker's PKCS#8 signing key. */
export async function importEcdsaPublicKeyFromPrivate(pkcs8Base64) {
  const extractable = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(pkcs8Base64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', extractable);
  return crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Sign `data` with an ECDSA P-256 key, returning a base64url IEEE-P1363 (r||s) signature. */
export async function ecdsaP256SignBase64Url(privateKey, data) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(data),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value, secret) {
  if (!secret) throw new Error('INTEGRATION_ENCRYPTION_KEY is not configured');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value));
  return { ciphertext: base64UrlEncode(new Uint8Array(encrypted)), iv: base64UrlEncode(iv) };
}

export async function decryptSecret(ciphertext, iv, secret) {
  if (!secret) throw new Error('INTEGRATION_ENCRYPTION_KEY is not configured');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(iv) },
    await encryptionKey(secret),
    base64UrlDecode(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}
