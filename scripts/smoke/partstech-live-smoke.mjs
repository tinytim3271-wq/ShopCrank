#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildPartstechOrderRequest, mapPartstechQuoteItemToEstimateLine } from '../../src/modules/partstech.js';

const REQUIRED = [
  'PARTSTECH_SANDBOX_BASE_URL',
  'PARTSTECH_SANDBOX_STORE_ID',
  'PARTSTECH_SANDBOX_PART_NUMBER',
  'PARTSTECH_SANDBOX_PARTNER_ID',
  'PARTSTECH_SANDBOX_PARTNER_KEY',
  'PARTSTECH_SANDBOX_USER_ID',
  'PARTSTECH_SANDBOX_USER_KEY',
];

function sandboxBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('PARTSTECH_SANDBOX_BASE_URL must be an HTTPS sandbox URL');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || !/(^|\.)partstech\.com$/i.test(host)
    || !/(sandbox|test)/i.test(host)
    || host === 'api.partstech.com'
  ) {
    throw new Error('Refusing to run: PARTSTECH_SANDBOX_BASE_URL must use an HTTPS sandbox/test host under partstech.com, not production');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PARTSTECH_SANDBOX_BASE_URL must not contain credentials, query parameters, or a fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function parseJson(response, step) {
  return response.json().catch(() => {
    throw new Error(`PartsTech sandbox ${step} returned invalid JSON (HTTP ${response.status})`);
  });
}

async function postJson(fetcher, url, body, step, token = '') {
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`PartsTech sandbox ${step} request failed or timed out`);
  }
  const payload = await parseJson(response, step);
  if (!response.ok) throw new Error(`PartsTech sandbox ${step} failed (HTTP ${response.status})`);
  return payload;
}

export async function runPartstechSandboxSmoke(env = process.env, fetcher = fetch, logger = console) {
  if (env.PARTSTECH_SANDBOX !== '1') {
    throw new Error('Set PARTSTECH_SANDBOX=1 to explicitly enable this live sandbox check');
  }
  const missing = REQUIRED.filter(name => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Missing required sandbox configuration: ${missing.join(', ')}`);
  const baseUrl = sandboxBaseUrl(env.PARTSTECH_SANDBOX_BASE_URL);
  const credentials = {
    partnerId: env.PARTSTECH_SANDBOX_PARTNER_ID,
    partnerKey: env.PARTSTECH_SANDBOX_PARTNER_KEY,
    userId: env.PARTSTECH_SANDBOX_USER_ID,
    userKey: env.PARTSTECH_SANDBOX_USER_KEY,
  };
  const access = await postJson(fetcher, `${baseUrl}/oauth/access`, {
    accessType: 'user',
    credentials: {
      user: { id: credentials.userId, key: credentials.userKey },
      partner: { id: credentials.partnerId, key: credentials.partnerKey },
    },
  }, 'authentication');
  if (!access.accessToken) throw new Error('PartsTech sandbox authentication returned no access token');

  const quote = await postJson(fetcher, `${baseUrl}/catalog/quote`, {
    storeId: env.PARTSTECH_SANDBOX_STORE_ID.trim(),
    searchParams: { partNumber: env.PARTSTECH_SANDBOX_PART_NUMBER.trim() },
  }, 'part quote', access.accessToken);
  const rawItems = quote.parts || quote.items || quote.quotes || quote.results || [];
  const quotedItem = Array.isArray(rawItems)
    ? rawItems.map((item, index) => mapPartstechQuoteItemToEstimateLine(item, index))
      .find(item => item.priceStatus === 'priced' && item.unitPrice > 0 && item.partNumber)
    : null;
  if (!quotedItem) throw new Error('PartsTech sandbox returned no priced, orderable part for the configured test part number');

  const approvedLine = { ...quotedItem, approvalStatus: 'approved' };
  const orderRequest = buildPartstechOrderRequest({
    storeId: env.PARTSTECH_SANDBOX_STORE_ID,
    lines: [approvedLine],
    poNumber: `SC-SANDBOX-${Date.now()}`,
  });
  const checkout = await postJson(fetcher, `${baseUrl}/punchout/quote/create`, orderRequest, 'checkout-session creation', access.accessToken);
  const sessionId = String(checkout.sessionId || checkout.id || '');
  let redirectUrl;
  try {
    redirectUrl = new URL(String(checkout.redirectUrl || checkout.url || ''));
  } catch {
    throw new Error('PartsTech sandbox did not return a valid checkout URL');
  }
  if (!sessionId || redirectUrl.protocol !== 'https:' || !/(^|\.)partstech\.com$/i.test(redirectUrl.hostname)) {
    throw new Error('PartsTech sandbox returned an invalid checkout session');
  }

  const status = await postJson(fetcher, `${baseUrl}/punchout/quote/info`, { sessionId }, 'checkout-session status', access.accessToken);
  const statusValue = status.orders?.[0]?.status || status.status || status.state || 'session_created';
  logger.log(`PASS PartsTech sandbox: quote, checkout session, and status check succeeded (${quotedItem.partNumber}; ${statusValue}).`);
  logger.log('No purchase was submitted. Review/submit the checkout manually only if intentionally testing the sandbox.');
  return { partNumber: quotedItem.partNumber, sessionId, status: String(statusValue) };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  runPartstechSandboxSmoke().catch(error => {
    console.error(`FAIL PartsTech sandbox smoke: ${error.message}`);
    process.exitCode = 1;
  });
}
