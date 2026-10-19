#!/usr/bin/env node
/**
 * Verifies whether Google Cloud already accepts the ShopCrank redirect URI.
 * Exits 0 when registered, 1 when still mismatched (do not deploy Worker flip yet).
 *
 * Usage: node scripts/verify-google-oauth-cutover.mjs
 */
import { CANONICAL_ORIGIN } from '../worker/src/production-host.mjs';

const EXPECTED_REDIRECT = `${CANONICAL_ORIGIN}/api/auth/google/callback`;
const START_URL = `${CANONICAL_ORIGIN}/api/auth/google?returnTo=%2F`;

async function followToGoogle(url, hops = 0) {
  if (hops > 5) throw new Error('too many redirects before Google');
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location') || '';
  if (location.includes('accounts.google.com')) return location;
  if (response.status >= 300 && response.status < 400 && location) {
    return followToGoogle(new URL(location, url).toString(), hops + 1);
  }
  throw new Error(`expected redirect to Google, got ${response.status} ${location || '(no location)'}`);
}

function htmlIndicatesMismatch(html) {
  return /redirect_uri_mismatch/i.test(html) || /Invalid Request/i.test(html) && /redirect_uri/i.test(html);
}

function htmlLooksLikeConsent(html) {
  return /accountchooser|Choose an account|Sign in|identifier|consent/i.test(html);
}

async function main() {
  console.log('Expected redirect URI:', EXPECTED_REDIRECT);
  console.log('Javascript origin:   ', CANONICAL_ORIGIN);

  let googleAuthUrl;
  try {
    googleAuthUrl = await followToGoogle(START_URL);
  } catch (error) {
    console.error('Could not start production Google sign-in:', error.message);
    process.exit(2);
  }

  const current = new URL(googleAuthUrl);
  const clientId = current.searchParams.get('client_id') || '';
  const liveRedirect = current.searchParams.get('redirect_uri') || '';
  console.log('Live Worker redirect: ', liveRedirect);
  console.log('OAuth client id:      ', clientId);

  if (!clientId) {
    console.error('No client_id in Google authorize URL');
    process.exit(2);
  }

  const probe = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  probe.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: EXPECTED_REDIRECT,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'shopcrank-oauth-probe',
  }).toString();

  const probeResponse = await fetch(probe.toString(), { redirect: 'follow' });
  const html = await probeResponse.text();

  if (htmlIndicatesMismatch(html)) {
    console.log('');
    console.log('NOT REGISTERED: Google still rejects the ShopCrank callback.');
    console.log('In Google Cloud Console (project that owns this client):');
    console.log('  1. APIs & Services → Credentials → OAuth 2.0 Web client');
    console.log(`  2. Add Authorized JavaScript origin: ${CANONICAL_ORIGIN}`);
    console.log(`  3. Add Authorized redirect URI:     ${EXPECTED_REDIRECT}`);
    console.log('  4. Save, wait ~1–5 minutes, re-run this script');
    console.log('  5. Set GOOGLE_REDIRECT_ORIGIN to https://www.shopcrank.com in wrangler.jsonc, then npm run deploy:worker');
    process.exit(1);
  }

  if (htmlLooksLikeConsent(html) || liveRedirect === EXPECTED_REDIRECT) {
    console.log('');
    console.log('REGISTERED (or Worker already on ShopCrank). Safe to deploy Worker if needed.');
    process.exit(0);
  }

  console.log('Could not classify Google response; inspect manually.');
  console.log(html.slice(0, 400));
  process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
