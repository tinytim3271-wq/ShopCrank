import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTAKE_DISCLAIMER,
  applyVinDecode,
  canConvertIntake,
  customerDisplayName,
  emptyIntakeDraft,
  intakeOrderPayload,
  localDiagnosticChecklist,
  missingRequiredPhotos,
  priceIntakeEstimate,
  searchLaborGuide,
  unavailableLaborSources,
} from './intake-wizard.js';

test('customer name keeps the company when both are present', () => {
  const draft = emptyIntakeDraft();
  draft.customer.firstName = 'Ada';
  draft.customer.lastName = 'Lopez';
  draft.customer.company = 'Lopez Trucking';
  assert.equal(customerDisplayName(draft), 'Ada Lopez (Lopez Trucking)');
});

test('VIN decode fills empty vehicle fields and does not overwrite a typed year', () => {
  const draft = emptyIntakeDraft();
  draft.vehicle.year = '2019';
  const next = applyVinDecode(draft, { year: '2020', make: 'Honda', model: 'CR-V', engineDisplacementLiters: '1.5', engineCylinders: '4', vin: 'abc' });
  assert.equal(next.vehicle.year, '2019');
  assert.equal(next.vehicle.make, 'Honda');
  assert.equal(next.vehicle.engine, '1.5L 4 cyl');
  assert.equal(next.vehicle.vin, 'ABC');
});

test('required photos block conversion until the four exterior shots exist', () => {
  const draft = emptyIntakeDraft();
  draft.customer = { firstName: 'Ada', lastName: 'Lopez', phone: '555', email: 'ada@example.com' };
  draft.vehicle = { ...draft.vehicle, year: '2020', make: 'Honda', model: 'CR-V' };
  draft.concern.description = 'Pulls right';
  assert.equal(canConvertIntake(draft).ok, false);
  assert.ok(missingRequiredPhotos(draft).includes('Front'));
  draft.photos = ['front', 'rear', 'driver', 'passenger'].map(slot => ({ slot, name: `${slot}.jpg` }));
  assert.equal(canConvertIntake(draft).ok, true);
});

test('conversion carries the disclaimer, customer, and primary technician', () => {
  const draft = emptyIntakeDraft();
  draft.customer = { firstName: 'Ada', lastName: 'Lopez', phone: '555', email: 'ada@example.com', company: '', contact: {} };
  draft.vehicle = { ...draft.vehicle, year: '2020', make: 'Honda', model: 'CR-V', vin: '1HGCM82633A004352' };
  draft.concern.description = 'Brake pads grinding';
  draft.photos = ['front', 'rear', 'driver', 'passenger'].map(slot => ({ slot, name: `${slot}.jpg` }));
  draft.assignments = [{ employeeId: 'u1', name: 'John Smith', role: 'primary', sharePercent: 100 }];
  const order = intakeOrderPayload(draft, {
    id: 'RO-1200',
    laborRate: 100,
    taxRate: 0,
    users: [{ id: 'u1', name: 'John Smith', techName: 'John Smith', role: 'technician', active: true }],
  });
  assert.equal(order.customer, 'Ada Lopez');
  assert.equal(order.tech, 'John Smith');
  assert.equal(order.intake.disclaimer, INTAKE_DISCLAIMER);
  assert.equal(order.estimate.disclaimer, INTAKE_DISCLAIMER);
  assert.ok(order.labor > 0);
});

test('labor lookup stays on the MechPro guide', () => {
  const hits = searchLaborGuide('brake pads');
  assert.ok(hits.every(hit => hit.source === 'MechPro guide'));
  assert.deepEqual(unavailableLaborSources().map(item => item.name), ['Mitchell', 'ALLDATA', 'Motor', 'ShopKey']);
});

test('local analysis does not pretend to be the cloud assistant', () => {
  const draft = emptyIntakeDraft();
  draft.concern.description = 'Check engine light and P0300';
  const result = localDiagnosticChecklist(draft);
  assert.equal(result.source, 'shop-checklist');
  assert.match(result.notice, /not a remote diagnosis/);
  const priced = priceIntakeEstimate(draft, { laborRate: 100, taxRate: 8.25 });
  assert.equal(priced.disclaimer, INTAKE_DISCLAIMER);
});
