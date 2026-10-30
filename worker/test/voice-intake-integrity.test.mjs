import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { executeAssistantTool } from '../src/assistant/tools.mjs';
import { handleGrokVoiceSettings } from '../src/grok-voice.mjs';
import { putShopEntity } from '../src/shop-settings-store.mjs';

const args = {
  customer: { name: 'Caller Example', phone: '+18065550123' },
  vehicle: { year: '2019', make: 'Toyota', model: 'Camry' },
  concern: { description: 'Oil change' },
};
const paths = [
  { persona: 'tech_assistant', role: 'technician', name: 'save_call_intake_and_estimate' },
  { persona: 'front_desk', name: 'save_caller_intake' },
];
const intake = (env, path) => executeAssistantTool(env, { shopId: 'shop-1', ...path, args });

for (const path of paths) {
  test(`${path.name} uses collision-resistant IDs for simultaneous calls and calls ten seconds apart`, async (t) => {
    const env = { DB: createD1() };
    let clock = 1_800_000_001_234;
    t.mock.method(Date, 'now', () => clock);
    await Promise.all([intake(env, path), intake(env, path)]);
    clock += 10_000;
    await intake(env, path);
    const records = env.DB.sqlite.prepare('SELECT entity_type, entity_id, data_json FROM entities WHERE shop_id = ?').all('shop-1');
    assert.equal(records.length, 12, 'all four records survive for each intake');
    const orders = records.filter(record => record.entity_type === 'orders').map(record => JSON.parse(record.data_json));
    const estimates = records.filter(record => record.entity_type === 'estimates').map(record => JSON.parse(record.data_json));
    assert.equal(new Set(orders.map(order => order.id)).size, 3);
    assert.equal(new Set(orders.map(order => order.intake.id)).size, 3);
    assert.equal(new Set(estimates.map(estimate => estimate.number)).size, 3);
    for (const order of orders) {
      assert.match(order.id, /^RO-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.ok(estimates.some(estimate => estimate.workOrderId === order.id && estimate.customerId === order.customerId));
    }
  });

  test(`${path.name} fails safely on an ID conflict without overwriting approved work or leaving partial records`, async (t) => {
    const env = { DB: createD1() };
    const uuid = '11111111-2222-4333-8444-555555555555';
    const orderId = `RO-${uuid}`;
    await putShopEntity(env, 'shop-1', 'orders', orderId, {
      customer: 'Original Customer', status: 'approved', vin: 'ORIGINALVIN',
      estimate: { approvalStatus: 'approved', total: 2500 },
      signature: 'original-approval',
    });
    const original = env.DB.sqlite.prepare('SELECT * FROM entities').all();
    t.mock.method(crypto, 'randomUUID', () => uuid);
    await assert.rejects(intake(env, path), error => error.status === 409 && /No existing records were changed/.test(error.message));
    assert.deepEqual(env.DB.sqlite.prepare('SELECT * FROM entities').all(), original, 'the entire insert batch rolls back');
  });
}

test('phone settings retain legitimate update behavior after intake creation becomes insert-only', async () => {
  const env = { DB: createD1() };
  for (const greeting of ['First greeting', 'Updated greeting']) {
    const response = await handleGrokVoiceSettings(new Request('https://example.com/api/settings/grok-voice', {
      method: 'PUT', body: JSON.stringify({ greeting, voice: 'eve' }),
      headers: { 'Content-Type': 'application/json' },
    }), env, { shopId: 'shop-1', role: 'admin' });
    assert.equal(response.status, 200);
  }
  const rows = env.DB.sqlite.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'shopsettings' AND entity_id = 'grok_phone'").all('shop-1');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].data_json).greeting, 'Updated greeting');
});
