import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeneralImportCsv,
  buildGeneralImportRows,
  collapseServicePeriod,
  isExternalPayment,
  isStripeSettledPayment,
  resolveServicePeriod,
  resolveStripeChargeId,
  revrecObjectKey,
  revrecStatusPayload,
  rowsToCsv,
  toUtcDate,
} from '../src/integrations/revenue-recognition.mjs';

test('toUtcDate and collapseServicePeriod normalize recognition windows', () => {
  assert.equal(toUtcDate('2026-03-15T18:00:00.000Z'), '2026-03-15');
  assert.deepEqual(collapseServicePeriod('2026-03-20', '2026-03-10'), {
    recognitionStart: '2026-03-10',
    recognitionEnd: '2026-03-10',
  });
  assert.deepEqual(collapseServicePeriod('2026-03-01', '2026-03-10'), {
    recognitionStart: '2026-03-01',
    recognitionEnd: '2026-03-10',
  });
});

test('service period prefers work-order open and invoice closeout', () => {
  assert.deepEqual(resolveServicePeriod(
    { receivedAt: '2026-04-01T12:00:00.000Z' },
    { date: '2026-03-20', closedAt: '2026-03-28T15:00:00.000Z' },
    { createdAt: '2026-03-18T09:00:00.000Z' },
  ), {
    recognitionStart: '2026-03-18',
    recognitionEnd: '2026-03-28',
  });
});

test('classifies external vs Stripe-settled payments', () => {
  assert.equal(isExternalPayment({ status: 'completed', method: 'cash', amount: 10 }), true);
  assert.equal(isExternalPayment({ status: 'completed', method: 'check', amount: 10 }), true);
  assert.equal(isStripeSettledPayment({
    status: 'completed',
    method: 'processor',
    reference: 'cs_test_123',
  }), true);
  assert.equal(isExternalPayment({
    status: 'completed',
    method: 'processor',
    reference: 'cs_test_123',
  }), false);
  assert.equal(isStripeSettledPayment({
    status: 'completed',
    stripeChargeId: 'ch_1234567890',
  }), true);
});

test('builds external and Stripe override CSV rows', () => {
  const rows = buildGeneralImportRows([
    {
      id: 'pay-cash-1',
      status: 'completed',
      method: 'cash',
      amount: 120.5,
      receivedAt: '2026-03-28T16:00:00.000Z',
      invoiceNumber: 'INV-1',
      workOrderId: 'RO-1',
      customer: 'Pat',
      note: 'Front counter',
    },
    {
      id: 'cs_test_abc',
      status: 'completed',
      method: 'processor',
      amount: 200,
      receivedAt: '2026-03-28T17:00:00.000Z',
      reference: 'cs_test_abc',
      stripeChargeId: 'ch_resolved_1',
      invoiceNumber: 'INV-2',
      workOrderId: 'RO-2',
    },
    {
      id: 'cs_unresolved',
      status: 'completed',
      method: 'processor',
      amount: 50,
      receivedAt: '2026-03-28T18:00:00.000Z',
      reference: 'cs_unresolved',
      invoiceNumber: 'INV-3',
    },
  ], [
    { number: 'INV-1', date: '2026-03-20', closedAt: '2026-03-28T16:00:00.000Z', ro: 'RO-1' },
    { number: 'INV-2', date: '2026-03-21', closedAt: '2026-03-28T17:00:00.000Z', ro: 'RO-2' },
    { number: 'INV-3', date: '2026-03-22', closedAt: '2026-03-28T18:00:00.000Z' },
  ], [
    { id: 'RO-1', createdAt: '2026-03-18T10:00:00.000Z' },
    { id: 'RO-2', createdAt: '2026-03-19T10:00:00.000Z' },
  ], {
    resolveChargeId: payment => payment.stripeChargeId || null,
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'ShopCrank');
  assert.equal(rows[0].transaction_id, 'pay-cash-1');
  assert.equal(rows[0].amount, '120.50');
  assert.equal(rows[0].currency, 'usd');
  assert.equal(rows[0].recognition_start_date, '2026-03-18');
  assert.equal(rows[0].recognition_end_date, '2026-03-28');
  assert.equal(rows[1].source, 'Stripe');
  assert.equal(rows[1].transaction_id, 'ch_resolved_1');
  assert.equal(rows[1].amount, '');
  assert.equal(rows[1].booked_date, '');

  const csv = rowsToCsv(rows);
  assert.match(csv, /^source,transaction_id/);
  assert.match(csv, /ShopCrank,pay-cash-1/);
  assert.match(csv, /Stripe,ch_resolved_1/);
  assert.equal(buildGeneralImportCsv([], [], []).trim().split('\n').length, 1);
});

test('resolveStripeChargeId follows checkout session to charge', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('/checkout/sessions/')) {
      return {
        ok: true,
        json: async () => ({ payment_intent: 'pi_abc' }),
      };
    }
    if (String(url).includes('/payment_intents/')) {
      return {
        ok: true,
        json: async () => ({ latest_charge: 'ch_from_session' }),
      };
    }
    return { ok: false, json: async () => ({}) };
  };
  const chargeId = await resolveStripeChargeId('sk_test_x', {
    reference: 'cs_test_session',
  }, { fetchImpl });
  assert.equal(chargeId, 'ch_from_session');
  assert.equal(calls.length, 2);
});

test('revrec helpers expose S3 key and status payload', () => {
  assert.equal(revrecObjectKey('demo-shop', '2026-10-16T06:00:00.000Z'), 'revrec/demo-shop/general/2026-10-16.csv');
  const payload = revrecStatusPayload({
    enabled: 1,
    currency: 'usd',
    last_exported_at: '2026-10-16T06:01:00.000Z',
    last_object_key: 'revrec/demo-shop/general/2026-10-16.csv',
    last_error: null,
  }, { stripeConfigured: true, s3Ready: true, shopId: 'demo-shop' });
  assert.equal(payload.enabled, true);
  assert.equal(payload.folderHint, 'revrec/demo-shop/general/');
  assert.equal(payload.s3Configured, true);
});
