import { calculateShopEstimate } from './estimate-templates.js';
import { CANNED_MENU } from './canned-services.js';
import { applyAssignments, assignableTechnicians, technicianName } from './technician-assignment.js';

export const INTAKE_STORAGE_KEY = 'mechpro-intake-draft-v1';

export const INTAKE_DISCLAIMER = 'PRELIMINARY ESTIMATE DISCLAIMER\n\nThis estimate is based on the information available at the time of inspection. Additional issues may be identified during diagnosis, testing, disassembly, or repair. Parts pricing, labor times, and availability may change. Authorization will be obtained before performing additional work. Final invoice amounts may differ from this estimate.';

export const INTAKE_STEPS = [
  { id: 'customer', label: 'Customer' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'photos', label: 'Photos' },
  { id: 'concerns', label: 'Concerns' },
  { id: 'diagnosis', label: 'Diagnosis' },
  { id: 'estimate', label: 'Estimate' },
  { id: 'review', label: 'Review' },
];

export const REQUIRED_PHOTO_SLOTS = [
  { id: 'front', label: 'Front' },
  { id: 'rear', label: 'Rear' },
  { id: 'driver', label: 'Driver side' },
  { id: 'passenger', label: 'Passenger side' },
];

export const EXTRA_PHOTO_SLOTS = [
  { id: 'odometer', label: 'Odometer' },
  { id: 'vin_sticker', label: 'VIN sticker' },
  { id: 'engine', label: 'Engine bay' },
  { id: 'tires', label: 'Tire condition' },
  { id: 'damage', label: 'Damage' },
  { id: 'concern', label: 'Customer concern area' },
  { id: 'extra', label: 'Additional photo' },
];

export const DAMAGE_AREAS = ['Front bumper', 'Rear bumper', 'Driver door', 'Passenger door', 'Hood', 'Fenders', 'Roof'];

const MECHPRO_LABOR = [
  { name: 'Brake pads', hours: 1.5, notes: 'One axle. Rotors and seized hardware are quoted separately.' },
  { name: 'Water pump', hours: 2.5, notes: 'Starting point. Confirm the labor time for this VIN before selling the job.' },
  { name: 'Alternator', hours: 1.2, notes: 'Replacement only. Programming or a stretch belt may add time.' },
  { name: 'Starter', hours: 1.2, notes: 'Starting point. Confirm access for this vehicle.' },
];

const EXTERNAL_LABOR_SOURCES = ['Mitchell', 'ALLDATA', 'Motor', 'ShopKey'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

export function emptyIntakeDraft(now = new Date()) {
  return {
    id: `intake-${now.getTime()}`,
    step: 0,
    savedAt: null,
    status: 'draft',
    customer: {
      firstName: '', lastName: '', phone: '', email: '', company: '',
      secondaryPhone: '', address: '', city: '', state: '', zip: '',
      contact: { phone: true, text: false, email: true },
    },
    vehicle: {
      vin: '', plate: '', plateState: '', year: '', make: '', model: '',
      trim: '', engine: '', transmission: '', mileage: '', color: '',
    },
    photos: [],
    damage: [],
    concern: {
      description: '', began: '', frequency: '', lights: '',
      recentRepairs: '', accident: '', towed: '', overheating: '',
    },
    diagnosis: {
      visual: '', roadTest: '', fluids: '', battery: '', codes: '', notes: '', analysis: null,
    },
    estimate: { lines: [], diagnosticCharge: 0, approval: 'pending' },
    assignments: [],
  };
}

export function customerDisplayName(draft = {}) {
  const customer = draft.customer || {};
  const person = [customer.firstName, customer.lastName].map(part => String(part || '').trim()).filter(Boolean).join(' ');
  const company = String(customer.company || '').trim();
  if (person && company) return `${person} (${company})`;
  return person || company;
}

export function customerAddress(draft = {}) {
  const customer = draft.customer || {};
  const cityLine = [customer.city, customer.state, customer.zip].map(part => String(part || '').trim()).filter(Boolean).join(' ');
  return [customer.address, cityLine].map(part => String(part || '').trim()).filter(Boolean).join(', ');
}

export function vehicleLabel(draft = {}) {
  const vehicle = draft.vehicle || {};
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].map(part => String(part || '').trim()).filter(Boolean).join(' ');
}

export function missingCustomerFields(draft = {}) {
  const customer = draft.customer || {};
  return ['firstName', 'lastName', 'phone', 'email'].filter(field => !String(customer[field] || '').trim());
}

export function missingVehicleFields(draft = {}) {
  const vehicle = draft.vehicle || {};
  const identity = vehicleLabel(draft);
  const missing = [];
  if (!identity && !String(vehicle.vin || '').trim()) missing.push('vehicle');
  return missing;
}

export function missingRequiredPhotos(draft = {}) {
  const taken = new Set((draft.photos || []).map(photo => photo.slot));
  return REQUIRED_PHOTO_SLOTS.filter(slot => !taken.has(slot.id)).map(slot => slot.label);
}

export function applyVinDecode(draft, decoded = {}) {
  const vehicle = { ...draft.vehicle };
  const fill = (field, value) => {
    if (!String(vehicle[field] || '').trim() && String(value || '').trim()) vehicle[field] = String(value).trim();
  };
  fill('year', decoded.year);
  fill('make', decoded.make);
  fill('model', decoded.model);
  fill('trim', decoded.trim);
  const engine = [decoded.engineDisplacementLiters ? `${decoded.engineDisplacementLiters}L` : '', decoded.engineCylinders ? `${decoded.engineCylinders} cyl` : '']
    .filter(Boolean).join(' ');
  fill('engine', engine);
  if (decoded.vin) vehicle.vin = String(decoded.vin).toUpperCase();
  return { ...draft, vehicle };
}

export function searchLaborGuide(query = '', services = CANNED_MENU) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const shopHits = MECHPRO_LABOR.filter(item => item.name.toLowerCase().includes(needle) || needle.includes(item.name.toLowerCase()))
    .map(item => ({ source: 'MechPro guide', name: item.name, hours: item.hours, price: null, notes: item.notes }));
  const canned = services.filter(item => `${item.name} ${item.description || ''}`.toLowerCase().includes(needle))
    .slice(0, 6)
    .map(item => ({ source: 'MechPro guide', name: item.name, hours: null, price: item.menuPrice || null, notes: item.description || '' }));
  return [...shopHits, ...canned].slice(0, 8);
}

export function unavailableLaborSources() {
  return EXTERNAL_LABOR_SOURCES.map(name => ({ name, available: false }));
}

export function seedEstimateLines(draft = {}) {
  if (Array.isArray(draft.estimate?.lines) && draft.estimate.lines.length) return draft.estimate.lines;
  const hits = searchLaborGuide(draft.concern?.description || '');
  const lines = hits.slice(0, 2).map(hit => ({
    type: 'labor',
    description: hit.name,
    quantity: hit.hours || 1,
    unitPrice: 0,
    notes: hit.notes,
    source: hit.source,
  }));
  const charge = Number(draft.estimate?.diagnosticCharge || 0);
  if (charge > 0) {
    lines.unshift({ type: 'labor', description: 'Diagnostic charge', quantity: 1, unitPrice: charge, notes: 'Initial diagnosis', source: 'Shop' });
  }
  if (!lines.length) {
    lines.push({
      type: 'labor',
      description: String(draft.concern?.description || 'Diagnose customer concern').slice(0, 120),
      quantity: 1,
      unitPrice: 0,
      notes: 'Hours stay at 1 until the technician confirms the job.',
      source: 'Shop',
    });
  }
  return lines;
}

export function priceIntakeEstimate(draft = {}, { laborRate = 165, taxRate = 0 } = {}) {
  const lines = seedEstimateLines(draft).map(line => ({
    type: line.type === 'part' ? 'part' : 'labor',
    description: line.description,
    quantity: Math.max(0, Number(line.quantity) || 0),
    unitPrice: line.type === 'part' ? Number(line.unitPrice) || 0 : undefined,
    laborRate: line.type === 'part' ? undefined : (Number(line.unitPrice) > 0 ? Number(line.unitPrice) : laborRate),
    notes: line.notes || '',
  }));
  const priced = calculateShopEstimate(lines, { laborRate, taxRate });
  return { ...priced, disclaimer: INTAKE_DISCLAIMER, lines };
}

export function localDiagnosticChecklist(draft = {}) {
  const text = `${draft.concern?.description || ''} ${draft.diagnosis?.codes || ''}`.toLowerCase();
  const causes = [];
  if (/misfire|stall|p030/.test(text)) causes.push({ name: 'Ignition and fuel', detail: 'Compare coil, plug, and injector contribution on the dead cylinder before parts are sold.' });
  if (/p0171|lean|vacuum/.test(text)) causes.push({ name: 'Unmetered air', detail: 'Smoke-test the intake and review fuel trims before replacing a sensor.' });
  if (/p0420|catalyst/.test(text)) causes.push({ name: 'Catalyst efficiency', detail: 'Confirm the upstream mixture and exhaust leaks before condemning the converter.' });
  if (!causes.length) causes.push({ name: 'Verify the complaint', detail: 'Road-test or reproduce the symptom, then record what the scan tool and the inspection actually show.' });
  return {
    source: 'shop-checklist',
    notice: 'MechPro AI is not connected. This is a shop checklist from the words on the intake, not a remote diagnosis.',
    causes,
  };
}

export function intakeOrderPayload(draft, { id, laborRate = 165, taxRate = 0, users = [] } = {}) {
  const priced = priceIntakeEstimate(draft, { laborRate, taxRate });
  const approval = draft.estimate?.approval || 'pending';
  const status = approval === 'approved' ? 'approved' : 'estimate';
  const assigned = applyAssignments({ id }, draft.assignments || [], users);
  return {
    id,
    customer: customerDisplayName(draft),
    phone: String(draft.customer?.phone || '').trim(),
    vehicle: vehicleLabel(draft) || 'Vehicle pending',
    vin: String(draft.vehicle?.vin || '').trim().toUpperCase() || 'VIN pending',
    complaint: String(draft.concern?.description || '').trim() || 'Customer concern pending',
    status,
    priority: 'normal',
    tech: assigned.tech,
    assignments: assigned.assignments,
    bay: 'Unassigned',
    mobile: false,
    promise: '',
    notes: [draft.diagnosis?.notes, draft.concern?.recentRepairs ? `Recent repairs: ${draft.concern.recentRepairs}` : ''].filter(Boolean).join('\n'),
    labor: priced.labor,
    laborHours: priced.lines.filter(line => line.type === 'labor').reduce((sum, line) => sum + Number(line.quantity || 0), 0),
    parts: priced.parts,
    tax: priced.tax,
    total: priced.total,
    estimate: {
      lines: priced.lines,
      disclaimer: INTAKE_DISCLAIMER,
      approvalStatus: approval,
    },
    intake: {
      id: draft.id,
      status: 'checked_in',
      customer: draft.customer,
      vehicle: draft.vehicle,
      photos: draft.photos || [],
      damage: draft.damage || [],
      concern: draft.concern,
      diagnosis: draft.diagnosis,
      disclaimer: INTAKE_DISCLAIMER,
      approval,
    },
  };
}

export function serializableIntake(draft = {}) {
  return {
    ...draft,
    photos: (draft.photos || []).map(photo => {
      const copy = { ...photo };
      delete copy.file;
      return copy;
    }),
  };
}

export function canConvertIntake(draft = {}) {
  const problems = [];
  if (missingCustomerFields(draft).length) problems.push('Customer name, phone, and email are required.');
  if (missingVehicleFields(draft).length) problems.push('Enter a VIN or the year, make, and model.');
  if (missingRequiredPhotos(draft).length) problems.push(`Required photos: ${missingRequiredPhotos(draft).join(', ')}.`);
  if (draft.estimate?.approval === 'denied') problems.push('This estimate was denied. Update the approval before creating the work order.');
  return { ok: problems.length === 0, problems };
}

function field(name, label, value, { type = 'text', required = false, full = false } = {}) {
  return `<label class="${full ? 'full' : ''}">${escapeHtml(label)}${required ? ' *' : ''}<input name="${escapeAttr(name)}" type="${type}" value="${escapeAttr(value || '')}" ${required ? 'required' : ''}/></label>`;
}

function progress(step) {
  return `<ol class="intake-progress">${INTAKE_STEPS.map((item, index) => `<li class="${index === step ? 'current' : ''} ${index < step ? 'done' : ''}"><span>${index + 1}</span>${escapeHtml(item.label)}</li>`).join('')}</ol>`;
}

function savedStamp(draft) {
  if (!draft.savedAt) return '<span class="intake-save">Not saved yet</span>';
  const time = new Date(draft.savedAt);
  const label = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<span class="intake-save">Draft saved${label ? ` ${escapeHtml(label)}` : ''}</span>`;
}

function customerStep(draft) {
  const customer = draft.customer;
  const contact = customer.contact || {};
  return `<div class="form-grid">${field('firstName', 'First name', customer.firstName, { required: true })}${field('lastName', 'Last name', customer.lastName, { required: true })}${field('phone', 'Phone number', customer.phone, { required: true, type: 'tel' })}${field('email', 'Email address', customer.email, { required: true, type: 'email' })}${field('company', 'Company name', customer.company)}${field('secondaryPhone', 'Secondary phone', customer.secondaryPhone, { type: 'tel' })}${field('address', 'Address', customer.address, { full: true })}${field('city', 'City', customer.city)}${field('state', 'State', customer.state)}${field('zip', 'Zip code', customer.zip)}</div>
<fieldset class="intake-choices"><legend>Communication preferences</legend>${['phone', 'text', 'email'].map(key => `<label><input type="checkbox" name="contact-${key}" ${contact[key] ? 'checked' : ''}/> ${key[0].toUpperCase()}${key.slice(1)}</label>`).join('')}</fieldset>`;
}

function vehicleStep(draft) {
  const vehicle = draft.vehicle;
  return `<div class="form-grid">${field('vin', 'VIN', vehicle.vin, { full: true })}${field('plate', 'License plate', vehicle.plate)}${field('plateState', 'Plate state', vehicle.plateState)}${field('year', 'Year', vehicle.year)}${field('make', 'Make', vehicle.make)}${field('model', 'Model', vehicle.model)}${field('trim', 'Trim', vehicle.trim)}${field('engine', 'Engine', vehicle.engine)}${field('transmission', 'Transmission', vehicle.transmission)}${field('mileage', 'Mileage', vehicle.mileage)}${field('color', 'Color', vehicle.color)}</div>
<div class="intake-actions-inline"><button class="secondary" type="button" id="intake-decode">Decode vehicle</button><button class="secondary" type="button" id="intake-plate">Lookup plate</button></div>
<p class="form-help" id="intake-vehicle-note">Plate lookup stays off until a DMV, Carfax, or registration provider is connected. VIN decode uses the shop vehicle decode service.</p>`;
}

function photoStep(draft) {
  const slots = [...REQUIRED_PHOTO_SLOTS, ...EXTRA_PHOTO_SLOTS.filter(slot => slot.id !== 'extra')];
  const cards = slots.map(slot => {
    const photos = (draft.photos || []).filter(photo => photo.slot === slot.id);
    const required = REQUIRED_PHOTO_SLOTS.some(item => item.id === slot.id);
    return `<article class="intake-photo ${photos.length ? 'taken' : ''}"><strong>${escapeHtml(slot.label)}${required ? ' *' : ''}</strong><span>${photos.length ? photos.map(photo => escapeHtml(photo.name)).join(', ') : 'Not added'}</span><label class="mini-action">Add photo<input class="intake-file" data-slot="${escapeAttr(slot.id)}" type="file" accept="image/png,image/jpeg,image/webp" hidden/></label></article>`;
  }).join('');
  const extras = (draft.photos || []).filter(photo => photo.slot === 'extra').map(photo => `<li>${escapeHtml(photo.name)}</li>`).join('');
  return `<div class="intake-photos">${cards}</div><div class="intake-actions-inline"><label class="secondary">+ Add photo<input class="intake-file" data-slot="extra" type="file" accept="image/png,image/jpeg,image/webp" hidden/></label></div>${extras ? `<ul class="intake-extra-photos">${extras}</ul>` : ''}
<h3>Damage map</h3><div class="intake-damage">${DAMAGE_AREAS.map(area => {
    const marked = (draft.damage || []).find(item => item.area === area);
    return `<label><input type="checkbox" name="damage" value="${escapeAttr(area)}" ${marked ? 'checked' : ''}/> ${escapeHtml(area)}</label><input name="damage-note-${escapeAttr(area)}" placeholder="Dent, scratch, broken trim, cracked glass, previous damage" value="${escapeAttr(marked?.note || '')}"/>`;
  }).join('')}</div>`;
}

function concernStep(draft) {
  const concern = draft.concern;
  return `<label class="full">Describe concern *<textarea name="description" required>${escapeHtml(concern.description)}</textarea></label>
<div class="form-grid">${field('began', 'When did the problem begin?', concern.began)}${field('frequency', 'How often does it occur?', concern.frequency)}${field('lights', 'Warning lights?', concern.lights)}${field('recentRepairs', 'Recent repairs?', concern.recentRepairs)}${field('accident', 'Recent accident?', concern.accident)}${field('towed', 'Vehicle towed in?', concern.towed)}${field('overheating', 'Vehicle overheating?', concern.overheating, { full: true })}</div>`;
}

function diagnosisStep(draft) {
  const diagnosis = draft.diagnosis;
  const analysis = diagnosis.analysis;
  const causes = analysis?.causes?.map(cause => `<li><strong>${escapeHtml(cause.name || cause.cause || 'Check')}</strong><p>${escapeHtml(cause.detail || cause.explanation || '')}</p></li>`).join('') || '';
  return `<div class="form-grid">${field('visual', 'Visual inspection', diagnosis.visual, { full: true })}${field('roadTest', 'Road test', diagnosis.roadTest)}${field('fluids', 'Fluid levels', diagnosis.fluids)}${field('battery', 'Battery test', diagnosis.battery)}${field('codes', 'DTC codes', diagnosis.codes, { full: true })}</div>
<label class="full">Technician notes<textarea name="notes">${escapeHtml(diagnosis.notes)}</textarea></label>
<div class="intake-actions-inline"><button class="secondary" type="button" id="intake-analyze">Review diagnostic notes</button></div>
${analysis ? `<section class="ai-notice"><span>${escapeHtml(analysis.notice || '')}</span></section><ul class="intake-causes">${causes}</ul>` : ''}`;
}

function estimateStep(draft, profile) {
  const priced = priceIntakeEstimate(draft, profile);
  const rows = (draft.estimate.lines?.length ? draft.estimate.lines : seedEstimateLines(draft)).map((line, index) => `<tr data-line="${index}"><td><input name="line-description" value="${escapeAttr(line.description || '')}"/></td><td><input name="line-hours" type="number" min="0" step="0.1" value="${Number(line.quantity || 0)}"/></td><td>${escapeHtml(line.source || 'Shop')}</td></tr>`).join('');
  return `<div class="intake-actions-inline"><input id="labor-query" placeholder="Brake pads, water pump, alternator, starter"/><button class="secondary" type="button" id="lookup-labor">Lookup labor</button></div>
<p class="form-help">Lookup uses the MechPro guide and this shop's canned jobs. Mitchell, ALLDATA, Motor, and ShopKey are not connected.</p>
<div id="labor-results"></div>
<table><thead><tr><th>Labor</th><th>Hours</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
<label>Diagnostic charge<input name="diagnosticCharge" type="number" min="0" step="0.01" value="${Number(draft.estimate.diagnosticCharge || 0)}"/></label>
<div class="estimate-sign-summary"><span>Labor ${escapeHtml(String(priced.labor))} · Parts ${escapeHtml(String(priced.parts))} · Supplies ${escapeHtml(String(priced.fees?.reduce((sum, fee) => sum + fee.amount, 0) || 0))} · Tax ${escapeHtml(String(priced.tax))}</span><strong>${escapeHtml(String(priced.total))}</strong></div>
<pre class="intake-disclaimer">${escapeHtml(INTAKE_DISCLAIMER)}</pre>
<label>Customer approval<select name="approval">${['pending', 'viewed', 'approved', 'denied'].map(status => `<option value="${status}" ${draft.estimate.approval === status ? 'selected' : ''}>${status[0].toUpperCase()}${status.slice(1)}</option>`).join('')}</select></label>
<p class="form-help">Email, text, and the customer portal send path is not connected on this step. Set the approval when the customer answers.</p>`;
}

function reviewStep(draft, users) {
  const check = canConvertIntake(draft);
  const techs = assignableTechnicians(users);
  const options = role => `<option value="">Unassigned</option>${techs.map(user => {
    const selected = (draft.assignments || []).find(item => item.role === role);
    return `<option value="${escapeAttr(user.id)}" ${selected?.employeeId === user.id ? 'selected' : ''}>${escapeHtml(technicianName(user))}</option>`;
  }).join('')}`;
  return `<dl class="intake-review"><div><dt>Customer</dt><dd>${escapeHtml(customerDisplayName(draft) || 'Missing')}</dd></div><div><dt>Vehicle</dt><dd>${escapeHtml(vehicleLabel(draft) || draft.vehicle.vin || 'Missing')}</dd></div><div><dt>Concern</dt><dd>${escapeHtml(draft.concern.description || 'Missing')}</dd></div><div><dt>Photos</dt><dd>${(draft.photos || []).length}</dd></div></dl>
<div class="form-grid"><label>Primary technician<select name="assign-primary">${options('primary')}</select></label><label>Secondary technician<select name="assign-secondary">${options('secondary')}</select></label><label>Apprentice<select name="assign-apprentice">${options('apprentice')}</select></label></div>
${check.ok ? '' : `<div class="import-errors">${check.problems.map(problem => `<span>${escapeHtml(problem)}</span>`).join('')}</div>`}
<p class="form-help">Convert copies this intake onto one work order. Customer, vehicle, photos, estimate, and diagnostic notes are not typed again.</p>`;
}

export function intakeWizardHtml(draft, { users = [], laborRate = 165, taxRate = 0 } = {}) {
  const step = Math.min(INTAKE_STEPS.length - 1, Math.max(0, Number(draft.step) || 0));
  const body = [
    customerStep,
    vehicleStep,
    photoStep,
    concernStep,
    diagnosisStep,
    current => estimateStep(current, { laborRate, taxRate }),
    current => reviewStep(current, users),
  ][step](draft);
  return `<div class="modal-head"><div><span class="eyebrow">Customer intake</span><h2>${escapeHtml(INTAKE_STEPS[step].label)}</h2></div><div class="intake-head-meta">${savedStamp(draft)}<button type="button" class="close" id="intake-cancel" aria-label="Cancel intake">×</button></div></div>
<div class="modal-body intake-body">${progress(step)}<form id="intake-form">${body}</form></div>
<div class="modal-actions"><button type="button" class="secondary" id="intake-back" ${step === 0 ? 'disabled' : ''}>Back</button><button type="button" class="secondary" id="intake-save">Save draft</button>${step < INTAKE_STEPS.length - 1 ? '<button type="button" class="primary" id="intake-next">Continue</button>' : '<button type="button" class="primary" id="intake-convert">Convert to work order</button>'}</div>`;
}

function readForm(draft, form) {
  const next = structuredClone(draft);
  const data = Object.fromEntries(new FormData(form).entries());
  const step = INTAKE_STEPS[next.step]?.id;
  if (step === 'customer') {
    ['firstName', 'lastName', 'phone', 'email', 'company', 'secondaryPhone', 'address', 'city', 'state', 'zip'].forEach(key => {
      if (key in data) next.customer[key] = String(data[key] || '').trim();
    });
    next.customer.contact = {
      phone: Boolean(form.querySelector('[name="contact-phone"]')?.checked),
      text: Boolean(form.querySelector('[name="contact-text"]')?.checked),
      email: Boolean(form.querySelector('[name="contact-email"]')?.checked),
    };
  }
  if (step === 'vehicle') {
    ['vin', 'plate', 'plateState', 'year', 'make', 'model', 'trim', 'engine', 'transmission', 'mileage', 'color'].forEach(key => {
      if (key in data) next.vehicle[key] = String(data[key] || '').trim();
    });
    next.vehicle.vin = next.vehicle.vin.toUpperCase();
  }
  if (step === 'photos') {
    const marked = new Set([...form.querySelectorAll('[name="damage"]')].filter(input => input.checked).map(input => input.value));
    next.damage = DAMAGE_AREAS.filter(area => marked.has(area))
      .map(area => ({ area, note: String(data[`damage-note-${area}`] || '').trim() }));
  }
  if (step === 'concerns') {
    ['description', 'began', 'frequency', 'lights', 'recentRepairs', 'accident', 'towed', 'overheating'].forEach(key => {
      const source = key === 'description' ? form.querySelector('[name="description"]')?.value : data[key];
      next.concern[key] = String(source || '').trim();
    });
  }
  if (step === 'diagnosis') {
    ['visual', 'roadTest', 'fluids', 'battery', 'codes', 'notes'].forEach(key => {
      next.diagnosis[key] = String(form.querySelector(`[name="${key}"]`)?.value || data[key] || '').trim();
    });
  }
  if (step === 'estimate') {
    const descriptions = [...form.querySelectorAll('[name="line-description"]')];
    const hourInputs = [...form.querySelectorAll('[name="line-hours"]')];
    next.estimate.lines = descriptions.map((input, index) => ({
      type: 'labor',
      description: input.value.trim(),
      quantity: Math.max(0, Number(hourInputs[index]?.value) || 0),
      source: 'Shop',
    })).filter(line => line.description);
    next.estimate.diagnosticCharge = Math.max(0, Number(data.diagnosticCharge) || 0);
    next.estimate.approval = data.approval || 'pending';
  }
  if (step === 'review') {
    next.assignments = ['primary', 'secondary', 'apprentice'].flatMap(role => {
      const employeeId = data[`assign-${role}`];
      if (!employeeId) return [];
      return [{ employeeId, role, sharePercent: role === 'primary' ? 100 : 0, assignedAt: new Date().toISOString() }];
    });
  }
  return next;
}

export function mountIntakeWizard(host, {
  draft,
  users = [],
  laborRate = 165,
  taxRate = 0,
  onSave,
  onCancel,
  onConvert,
  decodeVin,
  lookupPlate,
  analyze,
} = {}) {
  let current = structuredClone(draft || emptyIntakeDraft());
  let timer = 0;
  const paint = () => {
    host.innerHTML = intakeWizardHtml(current, { users, laborRate, taxRate });
    bind();
  };
  const persist = (reason) => {
    current.savedAt = new Date().toISOString();
    onSave?.(serializableIntake(current), reason);
    const stamp = host.querySelector('.intake-save');
    if (stamp) stamp.outerHTML = savedStamp(current);
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => persist('autosave'), 400);
  };
  function bind() {
    const form = host.querySelector('#intake-form');
    form?.addEventListener('input', () => {
      current = readForm(current, form);
      schedule();
    });
    host.querySelector('#intake-save')?.addEventListener('click', () => {
      if (form) current = readForm(current, form);
      persist('manual');
    });
    host.querySelector('#intake-cancel')?.addEventListener('click', () => onCancel?.(current));
    host.querySelector('#intake-back')?.addEventListener('click', () => {
      if (form) current = readForm(current, form);
      current.step = Math.max(0, current.step - 1);
      persist('step');
      paint();
    });
    host.querySelector('#intake-next')?.addEventListener('click', () => {
      if (form) current = readForm(current, form);
      current.step = Math.min(INTAKE_STEPS.length - 1, current.step + 1);
      if (INTAKE_STEPS[current.step]?.id === 'estimate' && !current.estimate.lines.length) current.estimate.lines = seedEstimateLines(current);
      persist('step');
      paint();
    });
    host.querySelector('#intake-convert')?.addEventListener('click', async () => {
      if (form) current = readForm(current, form);
      const check = canConvertIntake(current);
      if (!check.ok) {
        persist('blocked');
        paint();
        return;
      }
      await onConvert?.(current);
    });
    host.querySelector('#intake-decode')?.addEventListener('click', async () => {
      if (form) current = readForm(current, form);
      const note = host.querySelector('#intake-vehicle-note');
      try {
        const decoded = await decodeVin?.(current.vehicle.vin);
        if (!decoded) throw new Error('Enter a 17-character VIN first.');
        current = applyVinDecode(current, decoded);
        persist('vin');
        paint();
      } catch (error) {
        if (note) note.textContent = error.message || 'VIN decode failed.';
      }
    });
    host.querySelector('#intake-plate')?.addEventListener('click', async () => {
      if (form) current = readForm(current, form);
      const note = host.querySelector('#intake-vehicle-note');
      const result = await lookupPlate?.(current.vehicle) || { available: false, message: 'Plate lookup is not connected.' };
      if (note) note.textContent = result.message || 'Plate lookup is not connected.';
    });
    host.querySelectorAll('.intake-file').forEach(input => {
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        current.photos.push({
          id: `photo-${Date.now()}-${current.photos.length}`,
          slot: input.dataset.slot,
          name: file.name,
          contentType: file.type,
          takenAt: new Date().toISOString(),
          file,
        });
        persist('photo');
        paint();
      });
    });
    host.querySelector('#lookup-labor')?.addEventListener('click', () => {
      const query = host.querySelector('#labor-query')?.value || '';
      const hits = searchLaborGuide(query);
      const box = host.querySelector('#labor-results');
      if (!box) return;
      box.innerHTML = hits.length
        ? `<ul class="intake-causes">${hits.map(hit => `<li><button type="button" class="mini-action" data-add-labor="${escapeAttr(hit.name)}" data-hours="${hit.hours || 1}">${escapeHtml(hit.name)}</button><p>${escapeHtml(hit.notes)} · ${escapeHtml(hit.source)}${hit.hours ? ` · ${hit.hours} hr` : ''}</p></li>`).join('')}</ul>`
        : '<p class="form-help">No MechPro guide match. Mitchell, ALLDATA, Motor, and ShopKey are not connected.</p>';
      box.querySelectorAll('[data-add-labor]').forEach(button => {
        button.addEventListener('click', () => {
          if (form) current = readForm(current, form);
          current.estimate.lines.push({ type: 'labor', description: button.dataset.addLabor, quantity: Number(button.dataset.hours) || 1, source: 'MechPro guide' });
          persist('labor');
          paint();
        });
      });
    });
    host.querySelector('#intake-analyze')?.addEventListener('click', async () => {
      if (form) current = readForm(current, form);
      current.diagnosis.analysis = await analyze?.(current) || localDiagnosticChecklist(current);
      persist('analysis');
      paint();
    });
  }
  paint();
  return {
    current: () => current,
  };
}
