import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomerDocumentLink,
  handleCustomerDocument,
} from '../src/customer-documents.mjs';

function mockEnvironment() {
  const entities = new Map();
  const links = [];
  const files = new Map();
  const key = (shopId, type, id) => `${shopId}:${type}:${id}`;
  const fixture = {
    staleEntityReads: 0,
    staleEntitySnapshot: null,
  };
  const isEstimateLocked = document => Boolean(
    document?.linesLockedAt
    || ['approved', 'declined'].includes(document?.estimateApproval?.status),
  );
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/FROM entities/i.test(sql)) {
                if (fixture.staleEntityReads > 0 && fixture.staleEntitySnapshot) {
                  fixture.staleEntityReads -= 1;
                  return {
                    data_json: JSON.stringify(fixture.staleEntitySnapshot),
                    created_by: 'writer-1',
                    created_at: fixture.staleEntitySnapshot.createdAt,
                    updated_at: fixture.staleEntitySnapshot.updatedAt || fixture.staleEntitySnapshot.createdAt,
                  };
                }
                const record = entities.get(key(args[0], args[1], args[2]));
                return record
                  ? {
                    data_json: JSON.stringify(record),
                    created_by: 'writer-1',
                    created_at: record.createdAt,
                    updated_at: record.updatedAt || record.createdAt,
                  }
                  : null;
              }
              if (/FROM customer_document_links/i.test(sql)) {
                return links.find(link => link.token_hash === args[0]) || null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO customer_document_links/i.test(sql)) {
                links.push({
                  id: args[0],
                  token_hash: args[1],
                  shop_id: args[2],
                  document_type: args[3],
                  document_id: args[4],
                  expires_at: args[5],
                  created_at: args[6],
                  created_by: args[7],
                  consumed_at: null,
                  result: null,
                });
                return { success: true, meta: { changes: 1 } };
              } else if (/UPDATE entities SET/i.test(sql)) {
                const existing = entities.get(key(args[2], args[3], args[4]));
                if (/json_extract/i.test(sql) && existing && isEstimateLocked(existing)) {
                  return { success: true, meta: { changes: 0 } };
                }
                if (/AND updated_at = \?/i.test(sql) && existing) {
                  const expectedUpdatedAt = args[5];
                  const currentUpdatedAt = existing.updatedAt || existing.createdAt;
                  if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
                    return { success: true, meta: { changes: 0 } };
                  }
                }
                entities.set(key(args[2], args[3], args[4]), JSON.parse(args[0]));
                return { success: true, meta: { changes: 1 } };
              } else if (/UPDATE customer_document_links SET/i.test(sql) && /id != \?/i.test(sql)) {
                let changes = 0;
                for (const item of links) {
                  if (
                    item.shop_id === args[2]
                    && item.document_type === args[3]
                    && item.document_id === args[4]
                    && item.id !== args[5]
                    && !item.consumed_at
                  ) {
                    Object.assign(item, { consumed_at: args[0], result: args[1] });
                    changes += 1;
                  }
                }
                return { success: true, meta: { changes } };
              } else if (/UPDATE customer_document_links SET/i.test(sql)) {
                const link = links.find(item => item.id === args[2]);
                if (link && !link.consumed_at) {
                  Object.assign(link, { consumed_at: args[0], result: args[1] });
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  Object.assign(fixture, {
    env: {
      DB,
      FILES: {
        async put(objectKey, body, options) {
          files.set(objectKey, { body, options });
        },
      },
    },
    entities,
    links,
    files,
    key,
  });
  return fixture;
}

const context = {
  shopId: 'shop-1',
  userId: 'writer-1',
  role: 'service_writer',
};

function estimateOrder() {
  return {
    id: 'RO-1100',
    customer: 'Pat Customer',
    vehicle: '2020 Example Sedan',
    status: 'estimate',
    total: 265,
    createdAt: '2026-10-02T10:00:00.000Z',
    estimate: {
      taxRate: 0,
      fees: [],
      lines: [
        { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 165 },
        { id: 'part', type: 'part', description: 'Recommended sensor', quantity: 1, unitPrice: 100 },
      ],
    },
  };
}

async function issueLink(fixture, documentType, documentId) {
  const request = new Request('https://mechpro.test/api/document-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentType, documentId }),
  });
  const response = await createCustomerDocumentLink(request, fixture.env, context);
  assert.equal(response.status, 201);
  return response.json();
}

test('public estimate link renders itemized parts and labor without authentication', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), estimateOrder());
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();

  const response = await handleCustomerDocument(
    new Request(link.url),
    fixture.env,
    token,
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Diagnosis/);
  assert.match(html, /Recommended sensor/);
  assert.match(html, /Sign &amp; approve selected work|Sign & approve selected work/);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
});

test('customer link becomes read-only and displays a staff-recorded non-signature approval', async () => {
  const fixture = mockEnvironment();
  const order = estimateOrder();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), order);
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  order.linesLockedAt = '2026-10-07T20:00:00.000Z';
  order.estimateApproval = {
    status: 'approved',
    type: 'other',
    customLabel: 'Approved via fleet manager email',
    authorizationName: 'Dana Fleet',
    approvedAt: order.linesLockedAt,
    recordedBy: { id: 'writer-1', name: 'Timothy Alderman' },
    note: 'Confirmed PO 447',
  };

  const response = await handleCustomerDocument(new Request(link.url), fixture.env, token);
  const html = await response.text();
  assert.match(html, /Approved: Approved via fleet manager email/);
  assert.match(html, /recorded by Timothy Alderman/);
  assert.doesNotMatch(html, /id="submit-signature"/);
});

test('customer estimate link renders and approves flat fee lines as fees', async () => {
  const fixture = mockEnvironment();
  const order = estimateOrder();
  order.estimate.lines.push({
    id: 'after-midnight',
    code: 'after-midnight',
    type: 'fee',
    description: 'After-midnight service',
    amount: 200,
    quantity: 1,
    unitPrice: 200,
  });
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), order);
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  const page = await handleCustomerDocument(new Request(link.url), fixture.env, token);
  const html = await page.text();
  assert.match(html, /After-midnight service/);
  assert.match(html, />Fee</);
  assert.match(html, /Flat fee/);

  const response = await handleCustomerDocument(new Request(link.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sign',
      authorizationName: 'Pat Customer',
      signatureDataUrl: `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`,
      decisions: { labor: 'declined', part: 'declined', 'after-midnight': 'approved' },
    }),
  }), fixture.env, token);
  assert.equal(response.status, 200);
  const saved = fixture.entities.get(fixture.key('shop-1', 'orders', 'RO-1100'));
  assert.equal(saved.estimate.lines.find(line => line.id === 'after-midnight').type, 'fee');
  assert.equal(saved.estimate.lineFees, 200);
  assert.equal(saved.total, 200);
});

test('remote estimate signature approves selected lines, locks them, and stores PNG in R2', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), estimateOrder());
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  const signatureDataUrl = `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`;

  const response = await handleCustomerDocument(new Request(link.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sign',
      authorizationName: 'Pat Customer',
      signatureDataUrl,
      decisions: { labor: 'approved', part: 'declined' },
    }),
  }), fixture.env, token);

  assert.equal(response.status, 200);
  const saved = fixture.entities.get(fixture.key('shop-1', 'orders', 'RO-1100'));
  assert.equal(saved.status, 'approved');
  assert.equal(saved.estimateApproval.status, 'approved');
  assert.equal(saved.estimateApproval.type, 'signature');
  assert.equal(saved.estimateApproval.authorizationName, 'Pat Customer');
  assert.equal(saved.estimateApproval.approvedAt, saved.estimateApproval.signedAt);
  assert.equal(saved.estimateApproval.recordedBy.name, 'Pat Customer');
  assert.equal(saved.estimate.lines.find(line => line.id === 'part').approvalStatus, 'declined');
  assert.equal(saved.total, 165);
  assert.ok(saved.linesLockedAt);
  assert.equal(fixture.files.size, 1);
  assert.equal(fixture.links[0].result, 'approved');

  const completed = await handleCustomerDocument(new Request(link.url), fixture.env, token);
  assert.match(await completed.text(), /Signed by Pat Customer/);
});

test('remote estimate signature requires a decision for every line', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), estimateOrder());
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();

  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Pat Customer',
        signatureDataUrl: `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`,
        decisions: { labor: 'approved' },
      }),
    }), fixture.env, token),
    error => error.status === 400 && /every estimate line/i.test(error.message),
  );
});

test('remote estimate signature rejects stale decision keys', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), estimateOrder());
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Pat Customer',
        signatureDataUrl: `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`,
        decisions: { labor: 'approved', part: 'approved', stale: 'approved' },
      }),
    }), fixture.env, token),
    error => error.status === 400 && /do not match/.test(error.message),
  );
});

test('public response rejects oversized bodies before decoding a signature', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), estimateOrder());
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();

  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) },
      body: '{}',
    }), fixture.env, token),
    error => error.status === 413,
  );
});

test('invoice uses the same one-time mobile signature route', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'invoices', 'INV-1100'), {
    id: 'INV-1100',
    number: 'INV-1100',
    ro: 'RO-1100',
    customer: 'Pat Customer',
    vehicle: '2020 Example Sedan',
    subtotal: 165,
    tax: 0,
    amount: 165,
    lines: [{ id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 165 }],
    createdAt: '2026-10-02T10:00:00.000Z',
  });
  const link = await issueLink(fixture, 'invoice', 'INV-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  const response = await handleCustomerDocument(new Request(link.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sign',
      authorizationName: 'Pat Customer',
      signatureDataUrl: `data:image/png;base64,${Buffer.from('invoice-signature').toString('base64')}`,
    }),
  }), fixture.env, token);

  assert.equal(response.status, 200);
  const invoice = fixture.entities.get(fixture.key('shop-1', 'invoices', 'INV-1100'));
  assert.equal(invoice.signature.authorizationName, 'Pat Customer');
  assert.equal(invoice.signature.source, 'remote');
  assert.equal(fixture.links[0].result, 'signed');
});

test('cannot create a new public estimate link after the estimate is locked', async () => {
  const fixture = mockEnvironment();
  const locked = estimateOrder();
  locked.linesLockedAt = '2026-10-02T11:00:00.000Z';
  locked.estimateApproval = { status: 'approved', signedAt: locked.linesLockedAt };
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), locked);

  await assert.rejects(
    () => issueLink(fixture, 'estimate', 'RO-1100'),
    error => error.status === 409 && /already locked/i.test(error.message),
  );
});

test('replayed or alternate public response cannot overwrite a locked estimate approval', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), estimateOrder());
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  const signatureDataUrl = `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`;

  const first = await handleCustomerDocument(new Request(link.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sign',
      authorizationName: 'Pat Customer',
      signatureDataUrl,
      decisions: { labor: 'approved', part: 'declined' },
    }),
  }), fixture.env, token);
  assert.equal(first.status, 200);

  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Other Person',
        signatureDataUrl,
        decisions: { labor: 'declined', part: 'approved' },
      }),
    }), fixture.env, token),
    error => error.status === 409,
  );

  // Even if the one-time token flag were cleared, the locked estimate must still refuse mutation.
  fixture.links[0].consumed_at = null;
  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Other Person',
        signatureDataUrl,
        decisions: { labor: 'declined', part: 'approved' },
      }),
    }), fixture.env, token),
    error => error.status === 409 && /already been approved or declined/i.test(error.message),
  );

  const saved = fixture.entities.get(fixture.key('shop-1', 'orders', 'RO-1100'));
  assert.equal(saved.estimateApproval.authorizationName, 'Pat Customer');
  assert.equal(saved.estimate.lines.find(line => line.id === 'part').approvalStatus, 'declined');
  assert.equal(saved.total, 165);
});

test('remote decline-all marks every line declined, zeros money, and locks the estimate', async () => {
  const fixture = mockEnvironment();
  const order = estimateOrder();
  order.estimate.fees = [{ description: 'Shop supplies', amount: 12 }];
  order.total = 277;
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), order);
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();

  const response = await handleCustomerDocument(new Request(link.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'decline' }),
  }), fixture.env, token);

  assert.equal(response.status, 200);
  const saved = fixture.entities.get(fixture.key('shop-1', 'orders', 'RO-1100'));
  assert.equal(saved.estimateApproval.status, 'declined');
  assert.equal(saved.estimateApproval.source, 'remote');
  assert.ok(saved.linesLockedAt);
  assert.ok(saved.estimate.lines.every(line => line.approvalStatus === 'declined'));
  assert.equal(saved.total, 0);
  assert.equal(saved.labor, 0);
  assert.equal(saved.parts, 0);
  assert.equal(saved.tax, 0);
  assert.equal(saved.estimate.total, 0);
  assert.equal(saved.estimate.fees[0].amount, 12);
  assert.deepEqual(saved.estimateApproval.decisions, { labor: 'declined', part: 'declined' });
  assert.equal(fixture.links[0].result, 'declined');

  await assert.rejects(
    () => issueLink(fixture, 'estimate', 'RO-1100'),
    error => error.status === 409 && /already locked/i.test(error.message),
  );
});

test('customer approval CAS rejects when staff advanced updated_at after the link loaded', async () => {
  const fixture = mockEnvironment();
  const order = estimateOrder();
  order.updatedAt = '2026-10-02T10:00:00.000Z';
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), order);
  const link = await issueLink(fixture, 'estimate', 'RO-1100');
  const token = new URL(link.url).pathname.split('/').pop();

  // Simulate the customer reading the unlocked estimate, then staff saving a newer revision.
  fixture.staleEntitySnapshot = structuredClone(order);
  fixture.staleEntityReads = 1;
  order.updatedAt = '2026-10-02T11:00:00.000Z';
  order.estimate.lines.push({
    id: 'labor-2',
    type: 'labor',
    description: 'Additional repair',
    hours: 2,
    laborRate: 165,
  });

  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Pat Customer',
        signatureDataUrl: `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`,
        decisions: { labor: 'approved', part: 'declined' },
      }),
    }), fixture.env, token),
    error => error.status === 409 && /already been approved or declined/i.test(error.message),
  );

  const saved = fixture.entities.get(fixture.key('shop-1', 'orders', 'RO-1100'));
  assert.equal(saved.updatedAt, '2026-10-02T11:00:00.000Z');
  assert.equal(saved.estimate.lines.length, 3);
  assert.equal(saved.estimateApproval, undefined);
});

test('email and SMS estimate links cannot race to overwrite each other', async () => {
  const fixture = mockEnvironment();
  const unlocked = estimateOrder();
  fixture.entities.set(fixture.key('shop-1', 'orders', 'RO-1100'), unlocked);
  const emailLink = await issueLink(fixture, 'estimate', 'RO-1100');
  const smsLink = await issueLink(fixture, 'estimate', 'RO-1100');
  const emailToken = new URL(emailLink.url).pathname.split('/').pop();
  const smsToken = new URL(smsLink.url).pathname.split('/').pop();
  const signatureDataUrl = `data:image/png;base64,${Buffer.from('png-signature').toString('base64')}`;

  // Both requests read the unlocked order before either write commits (email + SMS race).
  fixture.staleEntitySnapshot = structuredClone(unlocked);
  fixture.staleEntityReads = 2;

  const outcomes = await Promise.allSettled([
    handleCustomerDocument(new Request(emailLink.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Pat Customer',
        signatureDataUrl,
        decisions: { labor: 'approved', part: 'declined' },
      }),
    }), fixture.env, emailToken),
    handleCustomerDocument(new Request(smsLink.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'decline' }),
    }), fixture.env, smsToken),
  ]);

  const fulfilled = outcomes.filter(item => item.status === 'fulfilled');
  const rejected = outcomes.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.status, 200);
  assert.equal(rejected[0].reason.status, 409);
  assert.match(rejected[0].reason.message, /already been approved or declined/i);

  const saved = fixture.entities.get(fixture.key('shop-1', 'orders', 'RO-1100'));
  assert.ok(['approved', 'declined'].includes(saved.estimateApproval.status));
  if (saved.estimateApproval.status === 'approved') {
    assert.equal(saved.estimateApproval.authorizationName, 'Pat Customer');
    assert.equal(saved.total, 165);
  } else {
    assert.equal(saved.estimateApproval.source, 'remote');
    assert.equal(saved.status, 'estimate');
  }
  assert.ok(fixture.links.every(item => item.consumed_at));
});

test('losing claim on an unused token returns 409 before writing the document', async () => {
  const fixture = mockEnvironment();
  fixture.entities.set(fixture.key('shop-1', 'invoices', 'INV-1100'), {
    id: 'INV-1100',
    number: 'INV-1100',
    ro: 'RO-1100',
    customer: 'Pat Customer',
    vehicle: '2020 Example Sedan',
    amount: 165,
    lines: [{ id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 165 }],
    createdAt: '2026-10-02T10:00:00.000Z',
  });
  const link = await issueLink(fixture, 'invoice', 'INV-1100');
  const token = new URL(link.url).pathname.split('/').pop();
  // Pre-consume as if a racing request already claimed the token.
  fixture.links[0].consumed_at = '2026-10-02T12:00:00.000Z';
  fixture.links[0].result = 'signed';

  // Fresh handleCustomerDocument still loads consumed_at and rejects before body work.
  await assert.rejects(
    () => handleCustomerDocument(new Request(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign',
        authorizationName: 'Pat Customer',
        signatureDataUrl: `data:image/png;base64,${Buffer.from('invoice-signature').toString('base64')}`,
      }),
    }), fixture.env, token),
    error => error.status === 409,
  );
  assert.equal(fixture.entities.get(fixture.key('shop-1', 'invoices', 'INV-1100')).signature, undefined);
});
