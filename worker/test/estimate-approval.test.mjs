import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_CUSTOM_LABEL_MAX } from '../../src/modules/estimate-approval.js';
import worker, { protectOrderApprovalSignature, putEntity, validatedOrderApproval, verifyOrderApprovalSignature } from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';

const context = {
  shopId: 'shop-1',
  userId: 'staff-7',
  name: 'Timothy Alderman',
  email: 'timothy@example.test',
  role: 'service_writer',
};

const serverTimestamp = '2026-10-07T21:45:00.000Z';

const existingOrder = () => ({
  id: 'RO-1200',
  status: 'estimate',
  estimate: {
    taxRate: 0,
    fees: [],
    lines: [
      { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 140 },
      { id: 'part', type: 'part', description: 'Sensor', quantity: 1, unitPrice: 100 },
    ],
  },
});

const otherApproval = customLabel => ({
  id: 'RO-1200',
  status: 'invoiced',
  total: 99999,
  linesLockedAt: '2000-01-01T00:00:00.000Z',
  estimateApproval: {
    status: 'approved',
    type: 'other',
    customLabel,
    authorizationName: 'Dana Fleet',
    approvedAt: '2026-10-07T20:00:00.000Z',
    note: 'Confirmed PO 447',
    recordedBy: { id: 'spoofed', name: 'Spoofed User' },
    decisions: { labor: 'approved', part: 'declined' },
  },
});

test('Worker derives approval time, recorder, decisions, totals, status, and lock state', () => {
  const order = validatedOrderApproval(
    otherApproval('  Approved via fleet manager email  '),
    context,
    existingOrder(),
    serverTimestamp,
  );
  assert.equal(order.estimateApproval.type, 'other');
  assert.equal(order.estimateApproval.customLabel, 'Approved via fleet manager email');
  assert.equal(order.estimateApproval.approvedAt, serverTimestamp);
  assert.deepEqual(order.estimateApproval.recordedBy, {
    id: context.userId,
    name: context.name,
    email: context.email,
  });
  assert.equal(order.status, 'approved');
  assert.equal(order.linesLockedAt, serverTimestamp);
  assert.equal(order.total, 140);
  assert.equal(order.estimate.total, 140);
  assert.equal(order.estimate.lines.find(line => line.id === 'part').approvalStatus, 'declined');
});

test('later work-order PUTs preserve the original approval, lock, decisions, and totals', () => {
  const originalRecorder = { id: 'staff-2', name: 'Service Writer', email: 'writer@example.test' };
  const existing = {
    ...existingOrder(),
    status: 'approved',
    total: 140,
    labor: 140,
    laborHours: 1,
    parts: 0,
    tax: 0,
    linesLockedAt: '2026-10-07T20:00:00.000Z',
    estimate: {
      ...existingOrder().estimate,
      total: 140,
      lines: [
        { ...existingOrder().estimate.lines[0], approvalStatus: 'approved' },
        { ...existingOrder().estimate.lines[1], approvalStatus: 'declined' },
      ],
    },
    estimateApproval: {
      ...otherApproval('Fleet manager email').estimateApproval,
      approvedAt: '2026-10-07T20:00:00.000Z',
      recordedBy: originalRecorder,
    },
  };
  const tampered = otherApproval('Changed method');
  tampered.status = 'in_progress';
  tampered.estimateApproval.recordedBy = { id: context.userId, name: context.name };
  tampered.estimateApproval.approvedAt = serverTimestamp;
  tampered.estimateApproval.decisions = { labor: 'declined', part: 'approved' };
  const laterEditor = {
    ...context,
    userId: 'tech-9',
    name: 'Different Technician',
    email: 'tech@example.test',
    role: 'technician',
  };
  const order = validatedOrderApproval(tampered, laterEditor, existing, serverTimestamp);
  assert.deepEqual(order.estimateApproval.recordedBy, originalRecorder);
  assert.equal(order.estimateApproval.approvedAt, existing.estimateApproval.approvedAt);
  assert.deepEqual(order.estimateApproval.decisions, existing.estimateApproval.decisions);
  assert.equal(order.linesLockedAt, existing.linesLockedAt);
  assert.equal(order.total, existing.total);
  assert.equal(order.status, 'in_progress');
});

test('an explicit estimate revision may clear approval before a fresh authorization', () => {
  const existing = {
    ...existingOrder(),
    status: 'approved',
    linesLockedAt: '2026-10-07T20:00:00.000Z',
    estimateApproval: {
      ...otherApproval('Fleet manager email').estimateApproval,
      approvedAt: '2026-10-07T20:00:00.000Z',
    },
  };
  const revision = {
    ...existing,
    estimateApproval: null,
    linesLockedAt: null,
    estimateRevisionPending: true,
  };
  const order = validatedOrderApproval(revision, context, existing, serverTimestamp);
  assert.equal(order.estimateApproval, null);
  assert.equal(order.linesLockedAt, null);
  assert.equal(order.estimateRevisionPending, true);
});

test('approval creation and preservation cannot change, add, or remove the consent VIN', () => {
  const vin = '1C6SRFHT0LN123456';
  for (const [before, after] of [[vin, '1C6SRFHT0LN999999'], [vin, ''], [vin, undefined], ['', vin], [undefined, vin]]) {
    const existing = { ...existingOrder(), vin: before };
    const body = { ...otherApproval('Phone'), vin: after };
    assert.throws(() => validatedOrderApproval(body, context, existing), error => error.status === 409);
    existing.estimateApproval = otherApproval('Phone').estimateApproval;
    existing.linesLockedAt = serverTimestamp;
    assert.throws(() => validatedOrderApproval(body, context, existing), error => error.status === 409);
  }
});

test('VIN normalization and legacy approvals preserve legitimate operational edits', () => {
  const vin = '1C6SRFHT0LN123456';
  const existing = {
    ...existingOrder(), vin, linesLockedAt: serverTimestamp,
    estimateApproval: { ...otherApproval('Phone').estimateApproval, type: undefined },
  };
  const body = { ...existing, vin: ' 1c6srfht0ln-123456 ', status: 'in_progress', notes: 'Ready for bay two' };
  const saved = validatedOrderApproval(body, { ...context, role: 'technician' }, existing);
  assert.equal(saved.notes, body.notes);
  assert.equal(saved.status, 'in_progress');
  assert.deepEqual(saved.estimateApproval, existing.estimateApproval);
  const unapproved = { ...existingOrder(), vin };
  assert.equal(validatedOrderApproval({ ...otherApproval('Phone'), vin: body.vin }, context, unapproved).estimateApproval.status, 'approved');
  const revision = validatedOrderApproval({
    ...existing, vin: '1C6SRFHT0LN999999', estimateApproval: null,
    linesLockedAt: null, estimateRevisionPending: true,
  }, context, existing);
  assert.equal(revision.estimateApproval, null);
  assert.equal(validatedOrderApproval({ ...revision, estimateApproval: otherApproval('Phone').estimateApproval }, context, revision).vin, revision.vin);
});

test('ordinary upload evidence is promoted from one object version with an atomic create-only write', async () => {
  const sourceKey = 'shops/shop-1/photos/legacy.png';
  const approval = { status: 'approved', signatureKey: sourceKey };
  let stored;
  const FILES = {
    async head() { return { httpMetadata: { contentType: 'image/png' } }; },
    async get(key) {
      assert.equal(key, sourceKey);
      return { httpMetadata: { contentType: 'image/png' }, body: new Response('signed-version').body };
    },
    async put(key, bytes, options) { stored = { key, bytes, options }; return {}; },
  };
  await protectOrderApprovalSignature({ FILES }, context, approval);
  assert.match(approval.signatureKey, /^shops\/shop-1\/signatures\/.+\.png$/);
  assert.equal(stored.key, approval.signatureKey);
  assert.equal(new TextDecoder().decode(stored.bytes), 'signed-version');
  assert.deepEqual(stored.options.onlyIf, { etagDoesNotMatch: '*' });
  await assert.rejects(() => protectOrderApprovalSignature({
    FILES: { ...FILES, async get() { return { httpMetadata: { contentType: 'image/jpeg' }, body: new Response('changed').body }; } },
  }, context, { status: 'approved', signatureKey: sourceKey }), error => error.status === 400);
});

test('approval evidence promotion fails closed if immutable destination already exists', async () => {
  const approval = { status: 'approved', type: 'signature', signatureKey: 'shops/shop-1/photo/source' };
  await assert.rejects(() => protectOrderApprovalSignature({
    FILES: {
      async head() { return { httpMetadata: { contentType: 'image/png' } }; },
      async get() { return { httpMetadata: { contentType: 'image/png' }, body: new Response('signature').body }; },
      async put() { return null; },
    },
  }, context, approval), error => error.status === 409);
  assert.equal(approval.signatureKey, 'shops/shop-1/photo/source');
});

test('validated order snapshots prevent concurrent approvals or VIN edits from being overwritten', async () => {
  const DB = createD1();
  const original = JSON.stringify({ ...existingOrder(), vin: '1C6SRFHT0LN123456' });
  await DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(context.shopId, 'orders', 'RO-1200', original, context.userId, serverTimestamp, serverTimestamp).run();
  const approved = JSON.stringify({ ...JSON.parse(original), linesLockedAt: serverTimestamp, estimateApproval: otherApproval('Phone').estimateApproval });
  await DB.prepare('UPDATE entities SET data_json = ? WHERE entity_id = ?').bind(approved, 'RO-1200').run();
  await assert.rejects(() => putEntity({ DB }, context, 'orders', 'RO-1200', { ...existingOrder(), vin: '1C6SRFHT0LN999999' },
    null, context.userId, { expectedOrderSnapshot: original }), error => error.status === 409);
  assert.equal((await DB.prepare('SELECT data_json FROM entities WHERE entity_id = ?').bind('RO-1200').first()).data_json, approved);
  await assert.rejects(() => putEntity({ DB }, context, 'orders', 'RO-1200', existingOrder(),
    null, context.userId, { expectedOrderSnapshot: null }), error => error.status === 409);
  const saved = await putEntity({ DB }, context, 'orders', 'RO-1200', { ...JSON.parse(approved), status: 'in_progress' },
    null, context.userId, { expectedOrderSnapshot: approved });
  assert.equal(saved.status, 'in_progress');
  await assert.rejects(() => putEntity({ DB }, context, 'orders', 'RO-1200', JSON.parse(original),
    null, context.userId, { requireUnlockedEstimate: true, expectedOrderSnapshot: original }), error => error.status === 409);
});

test('entity routes enforce VIN consent and promote both staff estimate and invoice evidence', async () => {
  const DB = createD1();
  await DB.prepare('INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(context.email, context.shopId, context.role, context.name, serverTimestamp, serverTimestamp).run();
  const vin = '1C6SRFHT0LN123456';
  const original = { ...existingOrder(), vin };
  await DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(context.shopId, 'orders', original.id, JSON.stringify(original), context.userId, serverTimestamp, serverTimestamp).run();
  const objects = new Map([['shops/shop-1/photo/source.png', 'original signature']]);
  const env = {
    DB, DEV_AUTH_BYPASS: '1',
    FILES: {
      async head(key) { return objects.has(key) ? { httpMetadata: { contentType: 'image/png' } } : null; },
      async get(key) {
        return objects.has(key) ? { httpMetadata: { contentType: 'image/png' }, body: new Response(objects.get(key)).body } : null;
      },
      async put(key, bytes, options) {
        assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
        if (objects.has(key)) return null;
        objects.set(key, new TextDecoder().decode(bytes));
        return {};
      },
    },
  };
  const save = (type, id, body, method = 'PUT') => worker.fetch(new Request(`https://app.example.test/api/entities/${type}${id ? `/${id}` : ''}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-ShopCrank-Dev-Email': context.email },
    body: JSON.stringify(body),
  }), env);
  const signature = {
    status: 'approved', type: 'signature', authorizationName: 'Pat',
    signedAt: serverTimestamp, signatureKey: 'shops/shop-1/photo/source.png',
    decisions: { labor: 'approved', part: 'declined' },
  };
  assert.equal((await save('orders', original.id, { ...original, vin: '1C6SRFHT0LN999999', estimateApproval: signature })).status, 409);
  const response = await save('orders', original.id, { ...original, estimateApproval: signature });
  assert.equal(response.status, 200);
  const approved = await response.json();
  assert.match(approved.estimateApproval.signatureKey, /^shops\/shop-1\/signatures\//);
  objects.set(signature.signatureKey, 'subsequent ordinary upload');
  assert.equal(objects.get(approved.estimateApproval.signatureKey), 'original signature');
  assert.equal((await save('orders', original.id, { ...approved, vin: '' })).status, 409);
  assert.equal((await save('orders', original.id, { ...approved, notes: 'Ready to dispatch', status: 'in_progress' })).status, 200);
  assert.equal((await save('orders', '', { ...original, notes: 'Overwrite attempt' }, 'POST')).status, 409);
  const invoiceResponse = await save('invoices', '', { id: 'INV-1', number: 'INV-1', signature }, 'POST');
  assert.equal(invoiceResponse.status, 201);
  const invoice = await invoiceResponse.json();
  assert.match(invoice.signature.signatureKey, /^shops\/shop-1\/signatures\//);
  assert.equal(objects.get(invoice.signature.signatureKey), 'subsequent ordinary upload');
  const updatedInvoice = await save('invoices', 'INV-1', { ...invoice, notes: 'Printed copy' });
  assert.equal(updatedInvoice.status, 200);
  assert.equal((await updatedInvoice.json()).signature.signatureKey, invoice.signature.signatureKey);
  const legacy = { ...invoice, signature: { ...signature, signatureKey: 'shops/shop-1/old/missing.png' } };
  await DB.prepare('UPDATE entities SET data_json = ? WHERE shop_id = ? AND entity_type = ? AND entity_id = ?')
    .bind(JSON.stringify(legacy), context.shopId, 'invoices', 'INV-1').run();
  const legacyUpdate = await save('invoices', 'INV-1', { ...legacy, notes: 'Unrelated legacy invoice edit' });
  assert.equal(legacyUpdate.status, 200);
  assert.equal((await legacyUpdate.json()).signature.signatureKey, legacy.signature.signatureKey);
});

test('technicians and office staff cannot clear an existing approval as a revision', () => {
  const existing = {
    ...existingOrder(),
    linesLockedAt: '2026-10-07T20:00:00.000Z',
    estimateApproval: {
      ...otherApproval('Fleet manager email').estimateApproval,
      approvedAt: '2026-10-07T20:00:00.000Z',
    },
  };
  const revision = {
    ...existing,
    estimateApproval: null,
    linesLockedAt: null,
    estimateRevisionPending: true,
  };
  for (const role of ['technician', 'office']) {
    assert.throws(
      () => validatedOrderApproval(revision, { ...context, role }, existing, serverTimestamp),
      error => error.status === 403 && /cannot revise/.test(error.message),
    );
  }
});

test('Worker rejects missing and whitespace-only Other labels', () => {
  for (const value of ['', '   ']) {
    assert.throws(
      () => validatedOrderApproval(otherApproval(value), context, existingOrder(), serverTimestamp),
      error => error.status === 400 && /Custom approval type is required/.test(error.message),
    );
  }
});

test('Worker rejects overlength Other labels', () => {
  assert.throws(
    () => validatedOrderApproval(
      otherApproval('x'.repeat(APPROVAL_CUSTOM_LABEL_MAX + 1)),
      context,
      existingOrder(),
      serverTimestamp,
    ),
    error => error.status === 400 && /characters or fewer/.test(error.message),
  );
});

test('Worker rejects stale, missing, or extra line decisions', () => {
  for (const decisions of [
    { labor: 'approved' },
    { labor: 'approved', part: 'declined', stale: 'approved' },
    { labor: 'approved', part: 'maybe' },
  ]) {
    const body = otherApproval('Fleet manager email');
    body.estimateApproval.decisions = decisions;
    assert.throws(
      () => validatedOrderApproval(body, context, existingOrder(), serverTimestamp),
      error => error.status === 400 && /estimate line|do not match/.test(error.message),
    );
  }
});

test('Worker restricts new approvals to owner, admin, and service writer roles', () => {
  for (const role of ['technician', 'office']) {
    assert.throws(
      () => validatedOrderApproval(
        otherApproval('Phone authorization'),
        { ...context, role },
        existingOrder(),
        serverTimestamp,
      ),
      error => error.status === 403 && /cannot record estimate approvals/.test(error.message),
    );
  }
  for (const role of ['owner', 'admin', 'service_writer']) {
    assert.equal(
      validatedOrderApproval(
        otherApproval('Phone authorization'),
        { ...context, role },
        existingOrder(),
        serverTimestamp,
      ).estimateApproval.recordedBy.id,
      context.userId,
    );
  }
});

test('Worker requires valid signature evidence and shop ownership', () => {
  const signatureBody = otherApproval('');
  signatureBody.estimateApproval = {
    status: 'approved',
    type: 'signature',
    authorizationName: 'Pat Customer',
    signedAt: '2026-10-07T21:44:00.000Z',
    signatureKey: 'shops/shop-1/signature/example.png',
    decisions: { labor: 'approved', part: 'approved' },
  };
  assert.equal(
    validatedOrderApproval(signatureBody, context, existingOrder(), serverTimestamp)
      .estimateApproval.signatureKey,
    signatureBody.estimateApproval.signatureKey,
  );
  assert.throws(
    () => validatedOrderApproval(
      { ...signatureBody, estimateApproval: { ...signatureBody.estimateApproval, signatureKey: '' } },
      context,
      existingOrder(),
      serverTimestamp,
    ),
    error => error.status === 400 && /stored signature/.test(error.message),
  );
  assert.throws(
    () => validatedOrderApproval(
      {
        ...signatureBody,
        estimateApproval: {
          ...signatureBody.estimateApproval,
          signatureKey: 'shops/another-shop/signature/example.png',
        },
      },
      context,
      existingOrder(),
      serverTimestamp,
    ),
    error => error.status === 400 && /does not belong/.test(error.message),
  );
});

test('Worker verifies a referenced signature exists in R2 and is a PNG', async () => {
  const signature = {
    status: 'approved',
    type: 'signature',
    signatureKey: 'shops/shop-1/signature/example.png',
  };
  await verifyOrderApprovalSignature({
    FILES: {
      async head(key) {
        assert.equal(key, signature.signatureKey);
        return { httpMetadata: { contentType: 'image/png' } };
      },
    },
  }, context, signature);
  await assert.rejects(
    () => verifyOrderApprovalSignature({ FILES: { async head() { return null; } } }, context, signature),
    error => error.status === 400 && /not found/.test(error.message),
  );
  await assert.rejects(
    () => verifyOrderApprovalSignature({
      FILES: { async head() { return { httpMetadata: { contentType: 'image/jpeg' } }; } },
    }, context, signature),
    error => error.status === 400 && /PNG/.test(error.message),
  );
  await assert.rejects(
    () => verifyOrderApprovalSignature({
      FILES: { async head() { return {}; } },
    }, context, signature),
    error => error.status === 400 && /PNG/.test(error.message),
  );
});

test('the D1 approval write guard allows only one concurrent approval to commit', async () => {
  let locked = false;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                return {
                  created_at: '2026-10-07T19:00:00.000Z',
                  created_by: 'staff-1',
                  updated_at: '2026-10-07T19:00:00.000Z',
                  lines_locked_at: locked ? '2026-10-07T19:01:00.000Z' : null,
                  approval_status: locked ? 'approved' : null,
                };
              },
              async run() {
                assert.match(sql, /json_extract\(data_json, '\$\.estimateApproval\.status'\)/);
                assert.match(sql, /updated_at = \?/);
                if (locked) return { meta: { changes: 0 } };
                locked = true;
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
  const options = { requireUnlockedEstimate: true };
  const outcomes = await Promise.allSettled([
    putEntity(env, context, 'orders', 'RO-1200', otherApproval('Phone'), null, context.userId, options),
    putEntity(env, context, 'orders', 'RO-1200', otherApproval('In person'), null, context.userId, options),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejection = outcomes.find(outcome => outcome.status === 'rejected');
  assert.equal(rejection.reason.status, 409);
});

test('approval write CAS rejects when a concurrent staff edit advanced updated_at', async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (/lines_locked_at|approval_status/i.test(sql)) {
                  return {
                    updated_at: '2026-10-07T19:05:00.000Z',
                    lines_locked_at: null,
                    approval_status: null,
                  };
                }
                return {
                  created_at: '2026-10-07T19:00:00.000Z',
                  created_by: 'staff-1',
                  updated_at: '2026-10-07T19:00:00.000Z',
                };
              },
              async run() {
                statements.push({ sql, args });
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };
  await assert.rejects(
    () => putEntity(
      env,
      context,
      'orders',
      'RO-1200',
      otherApproval('Phone'),
      '2026-10-07T19:00:00.000Z',
      context.userId,
      { requireUnlockedEstimate: true },
    ),
    error => error.status === 409 && /updated elsewhere/i.test(error.message),
  );
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /AND updated_at = \?/);
  assert.equal(statements[0].args.at(-1), '2026-10-07T19:00:00.000Z');
});
