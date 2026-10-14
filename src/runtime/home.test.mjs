import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHomeModel,
  escapeHtml,
  emptyState,
  greetingForNow,
  localIsoDate,
  coalesceQueuedEntityMutation,
  mergeRemoteCollection,
  pendingCreateIdsForCollection,
  sidebarCatalog,
  visibleSidebar,
} from './home.js';

test('home runtime publishes Shop Crank window helpers the SPA bootstrap reads', () => {
  assert.equal(globalThis.__SHOP_CRANK_HOME__.buildHomeModel, buildHomeModel);
  assert.equal(globalThis.__SHOP_CRANK_HOME__.visibleSidebar, visibleSidebar);
  assert.equal(globalThis.__MECHPRO_HOME__, globalThis.__SHOP_CRANK_HOME__);
});

const orders = [
  { id: 'RO-1', customer: 'Ada', vehicle: 'F-150', status: 'in_progress', tech: 'Tech A', promise: 'Today, 2:30 PM', complaint: 'Brakes' },
  { id: 'RO-2', customer: 'Bea', vehicle: 'Camry', status: 'estimate', tech: 'Unassigned', promise: 'Tomorrow, 11:00 AM', complaint: 'CEL' },
  { id: 'RO-3', customer: 'Cyd', vehicle: 'CR-V', status: 'waiting_parts', tech: 'Tech A', promise: 'Today, 5:30 PM', complaint: 'A/C' },
  { id: 'RO-4', customer: 'Dee', vehicle: 'Ram', status: 'completed', tech: 'Tech A', promise: 'Completed', complaint: 'Oil' },
];

const invoices = [
  { number: 'INV-1', customer: 'Ada', amount: 100, status: 'paid', date: 'Aug 13', ro: 'RO-4' },
  { number: 'INV-2', customer: 'Eve', amount: 250.5, status: 'overdue', date: 'Jul 28', ro: 'RO-9' },
];

test('home model populates metrics, attention, today, and activity', () => {
  const model = buildHomeModel({
    orders,
    invoices,
    appointments: [{ id: 'a1', date: '2026-09-09', status: 'confirmed' }],
    now: new Date(2026, 8, 9, 15, 0, 0),
  });
  assert.equal(model.isEmpty, false);
  assert.equal(model.openCount, 3);
  assert.equal(model.inProgressCount, 1);
  assert.equal(model.waitingCount, 1);
  assert.equal(model.overdueCount, 1);
  assert.equal(model.overdueTotal, 250.5);
  assert.equal(model.paidTotal, 100);
  assert.equal(model.todayJobs.length, 2);
  assert.equal(model.todaysAppointments.length, 1);
  assert.ok(model.attention.some((item) => item.type === 'parts'));
  assert.ok(model.attention.some((item) => item.type === 'assign'));
  assert.ok(model.attention.some((item) => item.type === 'overdue'));
  assert.ok(model.activity.length >= 4);
});

test('empty shop still returns a complete dashboard model', () => {
  const model = buildHomeModel({});
  assert.equal(model.isEmpty, true);
  assert.equal(model.openCount, 0);
  assert.deepEqual(model.attention, []);
  assert.deepEqual(model.todayJobs, []);
  assert.deepEqual(model.activity, []);
});

test('escapeHtml encodes markup and emptyState wraps copy', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`Tom & "Jerry"`), 'Tom &amp; &quot;Jerry&quot;');
  assert.match(emptyState('No customers yet'), /No customers yet/);
  assert.match(emptyState('<script>'), /&lt;script&gt;/);
});

test('greeting tracks morning, afternoon, and evening', () => {
  assert.equal(greetingForNow(new Date(2026, 8, 9, 8, 0, 0)), 'Good morning');
  assert.equal(greetingForNow(new Date(2026, 8, 9, 13, 0, 0)), 'Good afternoon');
  assert.equal(greetingForNow(new Date(2026, 8, 9, 19, 0, 0)), 'Good evening');
});

test('localIsoDate uses the calendar day, not UTC', () => {
  assert.equal(localIsoDate(new Date(2026, 8, 9, 15, 0, 0)), '2026-09-09');
});

test('sidebar groups the shop day in plain language and hides locked tools', () => {
  const labels = sidebarCatalog.flatMap((section) => section.items.map((item) => item.label));
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual(sidebarCatalog.map((section) => section.label), ['Today', 'Front counter', 'Shop floor', 'Back office']);
  const admin = visibleSidebar(() => true, { oem: true });
  assert.equal(admin[0].items[0].route, 'home');
  assert.ok(admin[2].items.some((item) => item.route === 'oem-diagnostics'));
  const writer = visibleSidebar((route) => ['home', 'dispatch', 'orders', 'customers'].includes(route), { oem: false });
  assert.deepEqual(writer.flatMap((section) => section.items.map((item) => item.route)), ['home', 'dispatch', 'orders', 'customers']);
  assert.equal(writer.some((section) => section.label === 'Back office'), false);
});

test('mergeRemoteCollection keeps local demo rows when the API is empty', () => {
  const local = [{ id: 'RO-1048' }];
  const isSample = (type, record) => type === 'orders' && record.id === 'RO-1048';
  assert.deepEqual(mergeRemoteCollection('orders', [], local, isSample), local);
  assert.deepEqual(mergeRemoteCollection('orders', [{ id: 'RO-2000' }], local, isSample), [{ id: 'RO-2000' }]);
  assert.deepEqual(mergeRemoteCollection('orders', [], [], isSample), []);
});

test('mergeRemoteCollection keeps only queued creates missing from remote data', () => {
  const local = [
    { id: 'RO-1048' },
    { id: 'RO-3001', customer: 'Pending sync' },
    { id: 'RO-3002', customer: 'Deleted remotely' },
  ];
  const isSample = (type, record) => type === 'orders' && record.id === 'RO-1048';
  assert.deepEqual(
    mergeRemoteCollection('orders', [{ id: 'RO-2000' }], local, isSample, ['RO-3001']),
    [{ id: 'RO-3001', customer: 'Pending sync' }, { id: 'RO-2000' }],
  );
  assert.deepEqual(
    mergeRemoteCollection('orders', [], local, isSample, ['RO-3001']),
    [{ id: 'RO-3001', customer: 'Pending sync' }],
  );
});

test('mergeRemoteCollection keeps queued creates whose IDs overlap demo records', () => {
  const local = [{ id: 'RO-1044', customer: 'Real customer' }];
  const isSample = (type, record) => type === 'orders' && record.id === 'RO-1044';

  assert.deepEqual(
    mergeRemoteCollection('orders', [{ id: 'RO-2000' }], local, isSample, ['RO-1044']),
    [{ id: 'RO-1044', customer: 'Real customer' }, { id: 'RO-2000' }],
  );
});

test('pendingCreateIdsForCollection reads only matching queued POST records', () => {
  const queue = [
    { method: 'POST', path: '/entities/orders', body: '{"id":"RO-3001"}' },
    { method: 'PUT', path: '/entities/orders/RO-3002', body: '{"id":"RO-3002"}' },
    { method: 'POST', path: '/entities/inspectiontemplates', body: '{"id":"template-1"}' },
    { method: 'POST', path: '/entities/orders', body: '{' },
  ];
  assert.deepEqual(pendingCreateIdsForCollection('orders', queue), ['RO-3001']);
  assert.deepEqual(
    pendingCreateIdsForCollection('inspectionTemplates', queue, { inspectiontemplates: 'inspectionTemplates' }),
    ['template-1'],
  );
});

test('editing a queued create keeps it as a POST so refreshes preserve it', () => {
  const existing = {
    key: '/entities/customers/customer-1',
    path: '/entities/customers',
    method: 'POST',
    body: '{"id":"customer-1","name":"Ada"}',
  };
  const incoming = {
    path: '/entities/customers/customer-1',
    method: 'PUT',
    body: '{"id":"customer-1","name":"Ada Lovelace"}',
    expectedUpdatedAt: '2026-10-05T12:00:00.000Z',
  };
  const queued = coalesceQueuedEntityMutation(existing, incoming);
  const queue = [{ ...queued, key: existing.key }];
  const pendingIds = pendingCreateIdsForCollection('customers', queue);

  assert.equal(queued.path, '/entities/customers');
  assert.equal(queued.method, 'POST');
  assert.equal(queued.body, incoming.body);
  assert.equal(queued.expectedUpdatedAt, null);
  assert.deepEqual(
    mergeRemoteCollection('customers', [], [{ id: 'customer-1', name: 'Ada Lovelace' }], null, pendingIds),
    [{ id: 'customer-1', name: 'Ada Lovelace' }],
  );
  assert.deepEqual(
    mergeRemoteCollection('customers', [], [{ id: 'deleted-customer' }], null, ['customer-1']),
    [],
  );
});
