import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = new URL('../migrations/', import.meta.url);
const all = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
const columns = db => db.prepare('PRAGMA table_info(oauth_states)').all().map(row => row.name).sort();
const PKCE = ['created_at', 'expires_at', 'provider', 'return_to', 'shop_id', 'state_hash', 'verifier_ciphertext', 'verifier_iv'];

for (const [label, order] of [
  ['integrations_support first (alphabetical)', all],
  ['repair_flow first (as some production databases ran them)', [...all].sort((a, b) => (a === '0008_repair_flow_integrations.sql' && b === '0008_integrations_support.sql' ? -1 : a === '0008_integrations_support.sql' && b === '0008_repair_flow_integrations.sql' ? 1 : a.localeCompare(b)))],
]) {
  test(`oauth_states ends with the PKCE columns QuickBooks uses when the 0008 migrations ran ${label}`, () => {
    const db = new DatabaseSync(':memory:');
    for (const name of order) db.exec(readFileSync(new URL(name, dir), 'utf8'));
    assert.deepEqual(columns(db), PKCE);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("INSERT INTO oauth_states (state_hash, shop_id, provider, verifier_ciphertext, verifier_iv, expires_at, created_at) VALUES ('h', 's', 'quickbooks', 'c', 'i', 'x', 'y')").run();
  });
}
