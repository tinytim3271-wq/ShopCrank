/**
 * Message a licensed device signs (ECDSA P-256, SHA-256) to prove it holds the
 * private key whose public key is bound to the license. Shared by the key app
 * and the Worker so both sides build byte-identical input.
 */
export const DEVICE_PROOF_PREFIX = 'shopcrank-license-device';
export const DEVICE_PROOF_MAX_SKEW_MS = 5 * 60 * 1000;

export function deviceProofMessage({ purpose, subject, signedAt, nonce }) {
  const parts = [DEVICE_PROOF_PREFIX, String(purpose), String(subject), String(signedAt)];
  if (nonce !== undefined) parts.push(String(nonce));
  return parts.join('\n');
}

export function authorizePurpose(procedure, vin) {
  return `authorize:${String(procedure || '')}:${String(vin || '').toUpperCase()}`;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlFromBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Device id = base64url(SHA-256(SPKI public key bytes)). */
export async function deviceIdForPublicKey(spkiBase64) {
  const bytes = Uint8Array.from(atob(String(spkiBase64 || '')), character => character.charCodeAt(0));
  return base64UrlFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
