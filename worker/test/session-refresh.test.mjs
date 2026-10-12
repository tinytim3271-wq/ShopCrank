import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function sessionGetRequest(token) {
  return new Request('https://app.example.test/api/auth/session', {
    headers: token === null ? {} : { Cookie: `mechpro_session=${token}` },
  });
}

function logoutRequest(token) {
  return new Request('https://app.example.test/api/auth/logout', {
    method: 'POST',
    headers: token === null ? {} : { Cookie: `mechpro_session=${token}` },
  });
}

function mockSessionsDb({ expiresAt }) {
  const row = {
    session_id: 'session-1', user_id: 'user-1', expires_at: expiresAt,
    revoked_at: null, email: 'owner@shop.test', name: 'Owner', shop_id: 'shop-a', role: 'admin',
  };
  const calls = { expiresUpdates: [], lastSeenUpdates: 0, revokedAt: null, revokedSessionId: null };
  return {
    row,
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/FROM sessions s\s+INNER JOIN users u/.test(sql)) return row;
              return null;
            },
            async run() {
              if (/UPDATE sessions SET last_seen_at/.test(sql)) {
                calls.lastSeenUpdates += 1;
                return { success: true };
              }
              if (/UPDATE sessions SET expires_at/.test(sql)) {
                calls.expiresUpdates.push({ id: args[1], expiresAt: args[0] });
                row.expires_at = args[0];
                return { success: true };
              }
              if (/UPDATE sessions SET revoked_at/.test(sql)) {
                calls.revokedAt = args[0];
                calls.revokedSessionId = args[1];
                return { success: true };
              }
              assert.fail(`unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('auth/session extends a near-expiry session and re-issues the rolling cookie', async () => {
  const now = Date.now();
  const DB = mockSessionsDb({ expiresAt: new Date(now + 60 * 60 * 1000).toISOString() });
  const response = await worker.fetch(sessionGetRequest('tok-123'), { DB });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('Set-Cookie') || '';
  assert.match(setCookie, /^mechpro_session=tok-123;/);
  assert.match(setCookie, /Max-Age=604800/);
  assert.equal(DB.calls.expiresUpdates.length, 1);
  assert.equal(DB.calls.expiresUpdates[0].id, 'session-1');
  const extended = Date.parse(DB.calls.expiresUpdates[0].expiresAt);
  assert.ok(Math.abs(extended - (now + WEEK_MS)) < 60 * 1000, 'expiry must roll forward one full TTL');
  assert.equal(DB.calls.revokedAt, null);
  const payload = await response.json();
  assert.equal(payload.claims['custom:shopId'], 'shop-a');
  assert.ok(Math.abs(payload.expiresAt - (now + WEEK_MS)) < 60 * 1000, 'client expiresAt must match the rolled D1 TTL');
  assert.ok(Math.abs(payload.claims.exp * 1000 - (now + WEEK_MS)) < 60 * 1000);
});

test('auth/session leaves a fresh session expiry untouched but still re-issues the cookie', async () => {
  const now = Date.now();
  const remainingMs = 6 * 24 * 60 * 60 * 1000;
  const DB = mockSessionsDb({ expiresAt: new Date(now + remainingMs).toISOString() });
  const response = await worker.fetch(sessionGetRequest('tok-123'), { DB });
  assert.equal(response.status, 200);
  assert.equal(DB.calls.expiresUpdates.length, 0);
  const setCookie = response.headers.get('Set-Cookie') || '';
  assert.match(setCookie, /^mechpro_session=tok-123;/);
  assert.match(setCookie, /Max-Age=518400/);
  const payload = await response.json();
  assert.ok(Math.abs(payload.expiresAt - (now + remainingMs)) < 60 * 1000, 'client expiresAt must mirror remaining D1 lifetime');
  assert.ok(payload.expiresAt - Date.now() > 24 * 60 * 60 * 1000, 'must not collapse to a 1-hour client logout window');
});

test('auth/logout revokes the active session and clears the cookie', async () => {
  const DB = mockSessionsDb({ expiresAt: new Date(Date.now() + WEEK_MS).toISOString() });
  const response = await worker.fetch(logoutRequest('tok-123'), { DB });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).loggedOut, true);
  assert.match(response.headers.get('Set-Cookie') || '', /^mechpro_session=;/);
  assert.match(response.headers.get('Set-Cookie') || '', /Max-Age=0;\s*Expires/);
  assert.equal(DB.calls.revokedSessionId, 'session-1');
  assert.ok(DB.calls.revokedAt);
});

test('auth/logout without a valid session still clears the cookie (idempotent)', async () => {
  const DB = mockSessionsDb({ expiresAt: new Date(Date.now() + WEEK_MS).toISOString() });
  const response = await worker.fetch(logoutRequest(null), { DB });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(DB.calls.revokedAt, null);
  assert.match(response.headers.get('Set-Cookie') || '', /Max-Age=0/);
});