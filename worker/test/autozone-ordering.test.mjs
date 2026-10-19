import test from 'node:test';
import assert from 'node:assert/strict';
import { handleOrdering } from '../src/index.js';
import { encryptSecret } from '../src/security.mjs';

const KEY = 'test-integration-key-0123456789abcdef';

async function envWithLogin(login) {
  const encrypted = login ? await encryptSecret(JSON.stringify(login), KEY) : null;
  const audits = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => (sql.includes('FROM integration_secrets') && encrypted ? encrypted : null),
            run: async () => {
              if (sql.includes('INSERT INTO audit_log')) audits.push(JSON.parse(args[4]));
              return {};
            },
          };
        },
      };
    },
  };
  return { env: { DB, INTEGRATION_ENCRYPTION_KEY: KEY }, audits };
}

const technician = { shopId: 'shop-1', userId: 'tech-1', email: 'tech@example.test', role: 'technician' };
const owner = { ...technician, userId: 'owner-1', role: 'owner' };
const login = { username: 'shopcrank-counter', password: 'Hunter2!plaintext', connectedAt: '2026-10-01T00:00:00Z' };

test('AutoZone Pro status never includes the saved password', async () => {
  const { env } = await envWithLogin(login);
  for (const context of [technician, owner]) {
    const response = await handleOrdering(new Request('https://x/api/ordering/autozone'), env, context, ['ordering', 'autozone']);
    const body = await response.json();
    assert.equal(body.connected, true);
    assert.equal(body.username, 'shopcrank-counter');
    assert.equal('password' in body, false);
    assert.doesNotMatch(JSON.stringify(body), /Hunter2/);
  }
});

test('the legacy reveal query is refused for every role and audited', async () => {
  const { env, audits } = await envWithLogin(login);
  for (const context of [technician, owner]) {
    await assert.rejects(
      handleOrdering(new Request('https://x/api/ordering/autozone?reveal=1'), env, context, ['ordering', 'autozone']),
      error => error.status === 403 && !/Hunter2/.test(error.message),
    );
  }
  assert.deepEqual(audits.map(event => event.kind), ['ordering.autozone.reveal_denied', 'ordering.autozone.reveal_denied']);
  assert.doesNotMatch(JSON.stringify(audits), /Hunter2/);
});

test('technicians cannot overwrite the shop AutoZone Pro login', async () => {
  const { env } = await envWithLogin(null);
  await assert.rejects(
    handleOrdering(new Request('https://x/api/ordering/autozone', {
      method: 'POST',
      body: JSON.stringify({ username: 'x', password: 'y' }),
      headers: { 'Content-Type': 'application/json' },
    }), env, technician, ['ordering', 'autozone']),
    error => error.status === 403,
  );
});
