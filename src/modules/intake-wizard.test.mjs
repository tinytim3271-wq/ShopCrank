import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTAKE_DISCLAIMER,
  acceptAllAiFields,
  applyAiAutofill,
  applyVinDecode,
  canConvertIntake,
  customerDisplayName,
  emptyIntakeDraft,
  findIntakeCustomer,
  intakeOrderPayload,
  intakeWizardHtml,
  localDiagnosticChecklist,
  missingRequiredPhotos,
  priceIntakeEstimate,
  searchLaborGuide,
  unavailableLaborSources,
} from './intake-wizard.js';

test('findIntakeCustomer matches normalized phone numbers or email addresses', () => {
  const customers = [
    { id: 'phone-match', phone: '(555) 555-1234', email: 'phone@example.com' },
    { id: 'email-match', phone: '555-555-9999', email: 'ADA@example.com' },
  ];

  assert.equal(findIntakeCustomer(customers, { customer: { phone: '+1 555-555-1234' } })?.id, 'phone-match');
  assert.equal(findIntakeCustomer(customers, { customer: { email: 'ada@example.com' } })?.id, 'email-match');
  assert.equal(findIntakeCustomer(customers, { customer: { phone: '555' } }), null);
});

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

test('labor lookup stays on the ShopCrank guide', () => {
  const hits = searchLaborGuide('brake pads');
  assert.ok(hits.every(hit => hit.source === 'ShopCrank guide'));
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

test('applyAiAutofill populates 3 Cs and estimate lines with Filled by AI review badges and acceptAllAiFields clears them', () => {
  let draft = emptyIntakeDraft();
  draft.step = 4; // Diagnosis step
  draft = applyAiAutofill(draft, 'diagnostic_3c', {
    complaint: 'Customer states chirping noise on cold start.',
    cause: 'Serpentine belt glazed and tensioner worn.',
    correction: 'Replace serpentine belt and tensioner assembly.',
    severity: 'RECOMMENDED',
    dtc_codes: ['P0300'],
    suggested_line_items: [
      { item_type: 'PART', description: 'Serpentine Belt', quantity: 1 },
      { item_type: 'LABOR', description: 'Serpentine Belt & Tensioner Replacement', quantity: 1, estimated_hours: 1.2 },
    ],
  });

  assert.equal(draft.concern.description, 'Customer states chirping noise on cold start.');
  assert.equal(draft.diagnosis.cause, 'Serpentine belt glazed and tensioner worn.');
  assert.equal(draft.diagnosis.correction, 'Replace serpentine belt and tensioner assembly.');
  assert.equal(draft.diagnosis.codes, 'P0300');
  assert.equal(draft.estimate.lines.length, 2);
  assert.equal(draft.estimate.lines[1].quantity, 1.2);
  assert.equal(draft.aiFilledFields['diagnosis.cause'], true);

  const html = intakeWizardHtml(draft);
  assert.match(html, /Filled by AI/);
  assert.match(html, /Accept All/);

  const accepted = acceptAllAiFields(draft);
  assert.deepEqual(accepted.aiFilledFields, {});
});

test('email is optional at intake; name and phone are required', () => {
  const draft = emptyIntakeDraft();
  draft.customer = { firstName: 'Ada', lastName: 'Lopez', phone: '806-555-0100', email: '' };
  draft.vehicle = { ...draft.vehicle, year: '2019', make: 'Toyota', model: 'Camry' };
  draft.photos = ['front', 'rear', 'driver', 'passenger'].map(slot => ({ slot, name: `${slot}.jpg` }));
  assert.equal(canConvertIntake(draft).ok, true);
  draft.customer.phone = '';
  assert.match(canConvertIntake(draft).problems.join(' '), /name and phone/);
});

test('a quick job can convert without walk-around photos, and the work order records the waiver', () => {
  const draft = emptyIntakeDraft();
  draft.customer = { firstName: 'Ada', lastName: 'Lopez', phone: '806-555-0100' };
  draft.vehicle = { ...draft.vehicle, year: '2019', make: 'Toyota', model: 'Camry' };
  draft.concern = { ...draft.concern, description: 'Oil change' };
  assert.equal(canConvertIntake(draft).ok, false);
  draft.photosWaived = true;
  assert.equal(canConvertIntake(draft).ok, true);
  assert.equal(intakeOrderPayload(draft, { id: 'RO-1', laborRate: 140, taxRate: 8.25 }).intake.photosWaived, true);
});

test('intake estimates price part lines alongside labor', () => {
  const draft = emptyIntakeDraft();
  draft.estimate.lines = [
    { type: 'labor', description: 'Brake job', quantity: 1.8, unitPrice: 0 },
    { type: 'part', description: 'Pads', quantity: 2, unitPrice: 45 },
  ];
  const priced = priceIntakeEstimate(draft, { laborRate: 140, taxRate: 0 });
  assert.equal(priced.labor, 252);
  assert.equal(priced.parts, 90);
});
