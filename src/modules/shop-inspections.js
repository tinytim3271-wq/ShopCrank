/**
 * Shop inspection menu. Each inspection is its own record.
 * Repairs, parts, and disassembly are quoted separately from the flat fee.
 */

import { isVideoMedia, ratingChipHtml } from './inspection-ratings.js';

const check = (id, label, measure = '') => ({ id, label, measure });

export const INSPECTION_STATUSES = [
  { id: 'ok', label: 'Green · OK' },
  { id: 'monitor', label: 'Yellow · Monitor' },
  { id: 'soon', label: 'Yellow · Soon' },
  { id: 'critical', label: 'Red · Safety-critical' },
  { id: 'skipped', label: 'Not performed' },
];

export const SHOP_INSPECTIONS = [
  {
    id: 'pre-purchase',
    name: 'Flagship Pre-Purchase Inspection',
    price: 229,
    summary: 'Identity, body, tires, engine bay, cold start, road test, scan, compression, underbody, recalls, and a buy / negotiate / walk-away verdict.',
    limits: 'Any section not performed is marked. This inspection cannot predict every future failure or hidden damage.',
    verdicts: [
      { id: 'buy', label: 'BUY' },
      { id: 'negotiate', label: 'NEGOTIATE' },
      { id: 'walk', label: 'WALK AWAY' },
    ],
    photos: 'VIN, odometer, four corners, tread on all four, pads and rotors if visible, underbody and rust, engine-bay leaks, OBD screen if codes are present, and every finding that supports the verdict.',
    sections: [
      { title: 'Identity and authorization', items: [
        check('auth', 'Authorization, location, cold status, and permission for road test, lift, compression, and scan'),
        check('identity', 'VIN, mileage, and identity match the vehicle presented', 'Mileage'),
      ] },
      { title: 'Exterior', items: [
        check('paint', 'Paint, panel gaps, glass, and visible damage'),
      ] },
      { title: 'Tires and wheels', items: [
        check('tread', 'Tread at multiple points, wear, date codes, mismatch, spare, and TPMS', 'Tread /32'),
      ] },
      { title: 'Engine bay and start', items: [
        check('bay', 'Fluids, leaks, belts, hoses, mounts, battery, and cooling'),
        check('start', 'Cold start: crank time, smoke, idle, noises, and lights. Mark not observed if already warm'),
      ] },
      { title: 'Scan and mechanical', items: [
        check('scan', 'All accessible modules scanned. Codes not cleared. DTCs, freeze frame, readiness, module faults'),
        check('compression', 'Cold or hot compression, or relative compression by scan. Method labeled. Leak-down if uneven', 'Readings'),
      ] },
      { title: 'Road test and underbody', items: [
        check('road', 'Road test when legal and safe: accel, shifts, clutch, vibration, pull, brakes, steering, suspension, HVAC'),
        check('underbody', 'Underbody on a lift or jack stands: frame, rust, leaks, bushings, exhaust, tanks, lines, brakes'),
      ] },
      { title: 'Records and campaigns', items: [
        check('history', 'Service history if provided. Gaps, salvage, or flood noted'),
        check('recalls', 'NHTSA recalls and OEM TSBs. Source, date, and open campaigns recorded'),
      ] },
    ],
  },
  {
    id: 'brakes',
    name: 'Brake Inspection',
    price: 89,
    summary: 'Pedal, fluid, friction thickness, rotors or drums, hardware, parking brake, ABS, and a controlled road test.',
    limits: 'Wheels-off measurements are noted when performed. Repairs are a separate quote.',
    photos: 'Warning lights, reservoir, pads, rotors or drums, hoses, lines, hardware, and every worn, leaking, or heat-damaged part.',
    sections: [
      { title: 'Setup', items: [check('complaint', 'Complaint, mileage, recent brake work, and whether wheels come off', 'Mileage')] },
      { title: 'Measure and inspect', items: [
        check('friction', 'Pad or shoe thickness. Estimate versus measured is labeled', 'Thickness'),
        check('rotors', 'Rotor or drum condition'),
        check('hardware', 'Calipers, slides, hoses, lines, parking brake, and ABS wiring or tone rings'),
        check('pedal', 'Pedal firmness, travel, and leaks'),
      ] },
      { title: 'Road test', items: [check('road', 'Controlled road test: pull, pulsation, noise, and ABS if conditions allow')] },
    ],
  },
  {
    id: 'tires',
    name: 'Tire and Wheel Inspection',
    price: 79,
    summary: 'Tread, wear, age, size and load match, sidewalls, wheels, spare, TPMS, and a short road test.',
    limits: 'Replacement and alignment are quoted separately.',
    photos: 'Each sidewall, DOT code, tread, wheel, damage, spare, and the TPMS light if it is on.',
    sections: [
      { title: 'Tires', items: [
        check('tread', 'Inner, center, and outer tread plus pressure on all four', 'Tread / pressure'),
        check('condition', 'Cuts, bubbles, cracking, repairs, cords, and separation'),
        check('match', 'Size, load, speed, direction, matching, and clearance'),
      ] },
      { title: 'Wheels and spare', items: [
        check('wheels', 'Bends, cracks, bead corrosion, and missing lugs or studs'),
        check('spare', 'Spare, jack, wrench, lock key, and TPMS'),
        check('road', 'Brief road test for vibration, pull, and noise when safe'),
      ] },
    ],
  },
  {
    id: 'battery',
    name: 'Battery and Charging System Inspection',
    price: 89,
    summary: 'Case, terminals, state of charge, load or conductance test, cranking, alternator output, belt, cables, and related codes.',
    limits: 'A replacement battery or starter repair is a separate quote.',
    photos: 'Label, terminals, corrosion, hold-down, grounds, belt, warning lights, and meter readings.',
    sections: [
      { title: 'Battery', items: [
        check('visual', 'Case, terminals, hold-down, cables, and grounds'),
        check('test', 'Resting voltage and battery test', 'Volts / result'),
      ] },
      { title: 'Cranking and charging', items: [
        check('crank', 'Crank speed, voltage drop, and starter noise', 'Crank volts'),
        check('charge', 'Charging voltage at base and under load. Belt condition', 'Charge volts'),
        check('codes', 'Charging and start codes recorded. Codes not cleared'),
      ] },
    ],
  },
  {
    id: 'cooling',
    name: 'Cooling System Inspection',
    price: 89,
    summary: 'Coolant, radiator, cap, hoses, pump, fans, leaks, warm-up, and a pressure test when it is safe.',
    limits: 'A hot system is not opened. A pressure test is marked not performed when equipment or temperature does not allow it.',
    photos: 'Reservoir, radiator and cap, hoses, pump area, leaks, fans, and gauge readings.',
    sections: [
      { title: 'Cold inspection', items: [
        check('level', 'Level and condition, only when the system is safe to open'),
        check('hoses', 'Hoses, belts, radiator, thermostat housing, heater hoses, pump, and fan wiring'),
      ] },
      { title: 'Heat and pressure', items: [
        check('warmup', 'Warm-up: temperature rise, fan, cabin heat, idle, and lights'),
        check('pressure', 'Pressure test when safe and equipment is available', 'Pressure'),
        check('mix', 'Oil and coolant mix, steam, bubbling, or combustion-gas clues. Skipped tests noted'),
        check('road', 'Controlled road test if safe. Temperature watched'),
      ] },
    ],
  },
  {
    id: 'transmission',
    name: 'Transmission Inspection',
    price: 109,
    summary: 'Fluid where serviceable, leaks, engagement, shift quality, mounts, codes, and a controlled road test.',
    limits: 'Fluid is checked only by the OEM procedure. Color alone is not a diagnosis. A unit repair is a separate quote.',
    photos: 'Leaks, pan or case, cooler lines, mounts, and warning lights.',
    sections: [
      { title: 'Fluid and case', items: [
        check('history', 'Type, symptoms, towing, and service history'),
        check('fluid', 'Fluid level and condition where the OEM procedure allows it'),
        check('leaks', 'Case, cooler lines, seals, pan, and mounts'),
      ] },
      { title: 'Function', items: [
        check('codes', 'TCM, PCM, ABS, and drivetrain codes recorded. Codes not cleared'),
        check('engage', 'Park, reverse, neutral, and drive: delay, noise, harshness'),
        check('road', 'Road test: light and moderate accel, shifts, downshifts, coast, cruise. Manual clutch noted if equipped'),
      ] },
    ],
  },
  {
    id: 'differential',
    name: 'Differential / 4x4 Inspection',
    price: 99,
    summary: 'Differentials, transfer case, seals, U-joints and CV joints, 4WD or AWD engagement, and related noises.',
    limits: 'Fluid service, seal work, and noise diagnosis are separate quotes.',
    photos: 'Housings, seals, vents, boots, leaks, and metal on a magnet if fluid was sampled.',
    sections: [
      { title: 'Housings', items: [
        check('type', '2WD, 4WD, or AWD, use, and recent fluid service'),
        check('fluid', 'Fluid level and condition where possible. Burnt smell or metal noted'),
        check('seals', 'Cracks, cover leaks, pinion and axle seals, vents, West Texas dust'),
      ] },
      { title: 'Driveline', items: [
        check('joints', 'U-joints, CV boots, carrier, and mounts'),
        check('modes', '4HI, 4LO, or AWD engaged safely. Lights and lockers verified if equipped'),
        check('road', 'Road test: accel, coast, turns, highway whine, clunk on tip-in'),
        check('codes', 'Transfer or AWD codes recorded if equipped. Codes not cleared'),
      ] },
    ],
  },
  {
    id: 'steering',
    name: 'Steering and Suspension Inspection',
    price: 99,
    summary: 'Play, tie rods, ball joints, bushings, shocks, bearings, ride height, and a road test.',
    limits: 'Parts replacement and alignment are quoted separately. The vehicle is supported before anything underneath is loaded.',
    photos: 'Tire wear, leaking struts, broken springs, torn boots, cracks, and rust.',
    sections: [
      { title: 'Steering', items: [
        check('history', 'Steering complaint, tires, alignment, and collision history'),
        check('play', 'Free play, effort, return, and warning lights, stationary'),
        check('links', 'Tie rods, ball joints, bushings, links, rack or gear, boots, and subframes'),
      ] },
      { title: 'Suspension and road', items: [
        check('bearings', 'Wheel bearing play and noise. CV boots. Impact damage'),
        check('shocks', 'Shock and strut leaks, spring seats, ride height, bump stops'),
        check('road', 'Road test: pull, wander, shimmy, clunks, return, and stability'),
      ] },
    ],
  },
  {
    id: 'exhaust',
    name: 'Exhaust Inspection',
    price: 79,
    summary: 'Manifolds, flex pipe, catalyst, muffler, hangers, leaks, rust, visible sensors, and a road test.',
    limits: 'Catalyst or pipe replacement is a separate quote.',
    photos: 'Manifolds, catalyst, muffler, hangers, shields, rust-through, and soot.',
    sections: [
      { title: 'System', items: [
        check('listen', 'Cold and idle listen for manifold tick, then raised inspection'),
        check('pipes', 'Flanges, flex, catalyst rattle, muffler seams, hangers, and shields'),
        check('leaks', 'Soot at joints and heat damage to nearby lines or wiring'),
      ] },
      { title: 'Codes and road', items: [
        check('codes', 'Catalyst, oxygen sensor, and fuel-trim codes recorded. Codes not cleared'),
        check('road', 'Road test: drone, rattle over bumps, and exhaust smell in the cabin'),
      ] },
    ],
  },
  {
    id: 'fuel',
    name: 'Fuel System Inspection',
    price: 89,
    summary: 'Smell and visible leaks, tank and lines, EVAP, rail area, pump prime, trims, and a short road test.',
    limits: 'This is not injector removal or a tank drop. Adding a chemical is not a leak repair.',
    photos: 'Tank and lines, rail area, EVAP parts if visible, wet stains, and code screens.',
    sections: [
      { title: 'Leaks', items: [
        check('smell', 'Smell at the filler, tank, and engine bay. No smoking or sparks'),
        check('lines', 'Tank straps, lines, external filter, rail fittings, and DI pump area'),
      ] },
      { title: 'Function', items: [
        check('pump', 'In-tank pump prime on key-on. Unusual whine noted'),
        check('codes', 'Fuel, EVAP, and misfire codes plus trims. Codes not cleared', 'Trims'),
        check('road', 'Light and moderate throttle hesitation, documented only'),
      ] },
    ],
  },
  {
    id: 'electrical',
    name: 'Electrical and Lighting Inspection',
    price: 99,
    summary: 'Exterior and interior lamps, windows, locks, wipers, horn, fuses, visible wiring, and body or restraint codes.',
    limits: 'Items that cannot be tested are listed. Circuit repair is a separate quote.',
    photos: 'Each failed lamp or switch, aftermarket splices, the fuse panel, and scan screens.',
    sections: [
      { title: 'Lamps and body', items: [
        check('exterior', 'Every exterior lamp, including brake and reverse'),
        check('interior', 'Interior lamps, gauges, windows, locks, mirrors, seats, sunroof, liftgate, and remote'),
        check('accessories', 'Wipers, washers, horn, defrost, blower speeds, outlets, and basic radio'),
      ] },
      { title: 'Power and codes', items: [
        check('fuses', 'Fuses, relays, grounds, moisture, and non-OEM splices'),
        check('codes', 'Body, airbag, ABS, and network codes recorded. Codes not cleared'),
      ] },
    ],
  },
  {
    id: 'hvac',
    name: 'HVAC Inspection',
    price: 89,
    summary: 'Vent temperature, heat, defrost, blower, compressor, condenser airflow, and cabin filter if it is accessible.',
    limits: 'This is not a recharge. Pressures are taken only after the refrigerant is identified. Refrigerant is not vented.',
    photos: 'Climate panel, cabin filter, compressor, belt, condenser, lines, residue, and gauge readings if taken.',
    sections: [
      { title: 'Controls', items: [
        check('modes', 'All blower speeds, mode, temperature, recirc, heat, and defrost'),
        check('vents', 'Vent temperature after it stabilizes, at idle and at raised rpm', 'Vent temp'),
      ] },
      { title: 'Refrigerant side', items: [
        check('compressor', 'Compressor engagement, cycling, belt noise, and condenser airflow'),
        check('visual', 'Residue, blocked fins, evaporator drain, odors, and cabin filter if accessible'),
        check('pressures', 'Pressures only with identified refrigerant and proper gauges', 'Pressures'),
      ] },
    ],
  },
  {
    id: 'engine',
    name: 'Engine Performance / Compression Inspection',
    price: 129,
    summary: 'Start, idle, misfire, scan with live data, compression or relative compression, and a driveability road test.',
    limits: 'This sets the diagnostic direction. It is not authorization to repair.',
    photos: 'Engine bay, warning lights, leaks, code screens, and compression notes.',
    sections: [
      { title: 'Baseline', items: [
        check('history', 'When it happens, fuel, recent repairs, and warning lights'),
        check('visual', 'Fluids, intake, vacuum, throttle, belts, battery, and visible ignition or fuel parts'),
        check('start', 'Crank time, idle, misfire feel, smoke, noises, and temperature'),
      ] },
      { title: 'Tests', items: [
        check('scan', 'Accessible modules scanned. Codes not cleared. Live data tied to the complaint'),
        check('compression', 'Mechanical compression, or relative compression by scan. Method labeled. Leak-down if uneven', 'Readings'),
        check('screens', 'Voltage, vacuum, or fuel pressure if the tools are on hand', 'Readings'),
        check('road', 'Road test: idle, light, moderate, cruise, decel, and restart'),
      ] },
    ],
  },
  {
    id: 'alignment',
    name: 'Alignment Check',
    price: 79,
    summary: 'Tire wear, pull, steering center, ride height, and a loose-parts screen before any alignment.',
    limits: 'Rack measurements are recorded when a rack is used. Adjustment is a separate authorization.',
    photos: 'Tires, wear patterns, wheel position, and worn or bent parts.',
    sections: [
      { title: 'Tires and parts', items: [
        check('history', 'Pull or wander, prior alignment, tires, and collision history'),
        check('tread', 'Inside, center, and outside tread. Left versus right. Pressures', 'Tread'),
        check('parts', 'Tire construction, wheel damage, looseness, and ride height'),
      ] },
      { title: 'Road and rack', items: [
        check('road', 'Level-road test: pull, wander, center, shimmy, and return'),
        check('rack', 'Before-measurements if a rack is available. No adjustment without authorization', 'Toe / camber / caster'),
      ] },
    ],
  },
  {
    id: 'multipoint',
    name: 'General Multi-Point Inspection',
    price: 129,
    summary: 'A shop visit inspection: exterior, tires, under-hood, start, scan, brakes, steering, underbody, lights, HVAC, and a short road test.',
    limits: 'Urgent, soon, monitor, and OK are the customer ratings. Repairs are quoted separately.',
    photos: 'VIN, odometer, damage, dash lights, and every worn, leaking, or safety item.',
    sections: [
      { title: 'Vehicle', items: [
        check('identity', 'VIN, mileage, warning lights, and conditions', 'Mileage'),
        check('body', 'Exterior and interior concerns'),
        check('tires', 'Pressure, tread, age, wear, and mismatch', 'Tread'),
      ] },
      { title: 'Under-hood and scan', items: [
        check('fluids', 'Fluids, belts, hoses, battery, airbox, wiring, and leaks'),
        check('start', 'Crank, idle, smoke, noises, lights, and charging voltage', 'Charge volts'),
        check('scan', 'OBD scan. Codes not cleared'),
      ] },
      { title: 'Chassis and controls', items: [
        check('brakes', 'Pedal, visible pads and rotors, fluid, and leaks'),
        check('chassis', 'Steering and suspension looseness, shocks, and bearings'),
        check('underbody', 'Underbody, exhaust, lines, frame, and leaks'),
        check('controls', 'Lights, horn, wipers, HVAC, windows, locks, and belts'),
        check('road', 'Short road test when authorized'),
      ] },
    ],
  },
];

export function shopInspection(id) {
  return SHOP_INSPECTIONS.find(item => item.id === id) || null;
}

export function statusLabel(id) {
  return INSPECTION_STATUSES.find(item => item.id === id)?.label || 'Not performed';
}

export function inspectionItems(catalog) {
  return (catalog?.sections || []).flatMap(section => section.items.map(item => ({
    ...item,
    section: section.title,
    status: '',
    note: '',
    measurement: '',
  })));
}

export function closeInspectionIssues(record) {
  const issues = [];
  const items = record?.items || [];
  const openFindings = items.filter(item => item.status === 'critical' || item.status === 'soon');
  const photos = record?.photoKeys || [];
  if (openFindings.length && !photos.length) issues.push('Attach a photo of each key finding before closing.');
  if (!String(record?.customerName || '').trim()) issues.push('Add the customer name on the acknowledgment.');
  if (record?.catalogId === 'pre-purchase' && !record?.verdict) issues.push('Choose BUY, NEGOTIATE, or WALK AWAY.');
  const unmarked = items.filter(item => !item.status);
  if (unmarked.length) issues.push(`${unmarked.length} item${unmarked.length === 1 ? '' : 's'} still need a result, or mark them Not performed.`);
  return issues;
}

export function inspectionPhotoSrc(key, apiUrl = '') {
  const value = String(key || '');
  if (value.startsWith('data:image/')) return value;
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) return value;
  if (apiUrl && value && !value.includes('..') && !value.includes('/')) return `${apiUrl}/files/${encodeURIComponent(value)}`;
  return '';
}

export function customerInspectionDocument(inspection, profile = {}, escapeHtml = value => String(value ?? ''), apiUrl = '') {
  const catalog = shopInspection(inspection.catalogId);
  const name = inspection.inspectionName || catalog?.name || 'Vehicle inspection';
  const price = Number(inspection.price ?? catalog?.price ?? 0);
  const groups = new Map();
  for (const item of inspection.items || []) {
    const title = item.section || 'Inspection';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(item);
  }
  const sections = [...groups.entries()].map(([title, items]) => {
    const rows = items.map(item => `<tr><td>${escapeHtml(item.label || item.name || '')}</td><td class="result ${escapeHtml(item.status || 'skipped')}">${ratingChipHtml(item.status, escapeHtml)}${escapeHtml(statusLabel(item.status))}</td><td>${escapeHtml(item.measurement || '')}</td><td>${escapeHtml(item.note || '')}</td></tr>`).join('');
    return `<h2>${escapeHtml(title)}</h2><table><thead><tr><th>Item</th><th>Result</th><th>Measurement</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  const verdict = (catalog?.verdicts || []).find(item => item.id === inspection.verdict);
  const photos = (inspection.photoKeys || []).map(key => [key, inspectionPhotoSrc(key, apiUrl)]).filter(([, src]) => src).map(([key, src]) => (isVideoMedia(key)
    ? `<video controls preload="metadata" src="${escapeHtml(src)}"></video>`
    : `<img src="${escapeHtml(src)}" alt="Inspection photo"/>`)).join('');
  const signature = inspectionPhotoSrc(inspection.customerSignature, apiUrl);
  const scanKept = (inspection.items || []).some(item => /not cleared/i.test(item.label || item.name || '') && item.status && item.status !== 'skipped');
  return `<article class="customer-inspection">
    <p class="fee">Inspection fee ${price.toFixed(2)} USD. Repairs, parts, and disassembly are quoted separately.</p>
    <h1>${escapeHtml(name)}</h1>
    <p>${escapeHtml(profile.shopName || '')}</p>
    <p>${escapeHtml(inspection.number || '')} · ${escapeHtml(inspection.createdAt || '')}</p>
    <p><b>Customer</b> ${escapeHtml(inspection.customer || '')} · <b>Vehicle</b> ${escapeHtml(inspection.vehicle || '')}</p>
    <p><b>VIN</b> ${escapeHtml(inspection.vin || '')} · <b>Mileage</b> ${escapeHtml(inspection.mileage || '')} · <b>Technician</b> ${escapeHtml(inspection.techName || '')}</p>
    ${(inspection.conditions || []).length ? `<p><b>Conditions</b> ${escapeHtml(inspection.conditions.join(', '))}</p>` : ''}
    ${verdict ? `<p class="verdict">${escapeHtml(verdict.label)}</p>` : ''}
    ${scanKept ? '<p>Stored codes were recorded and were not cleared.</p>' : ''}
    ${inspection.sellerSummary ? `<h2>Seller summary</h2><p>${escapeHtml(inspection.sellerSummary)}</p>` : ''}
    ${sections}
    <h2>Recommendations</h2><p>${escapeHtml(inspection.recommendations || 'None beyond the items above.')}</p>
    <h2>Limits</h2><p>${escapeHtml(inspection.limits || catalog?.limits || '')}</p>
    ${photos ? `<h2>Photos</h2><div class="photos">${photos}</div>` : ''}
    <h2>Customer acknowledgment</h2>
    <p>${escapeHtml(inspection.customerName || '')} acknowledges this inspection. Repairs are not included in the inspection fee.</p>
    ${signature ? `<img class="signature" src="${escapeHtml(signature)}" alt="Customer signature"/>` : ''}
  </article>`;
}

export function inspectionMenuHtml(escapeHtml = value => String(value ?? '')) {
  return SHOP_INSPECTIONS.map(item => `<button type="button" class="inspection-offer" data-start-inspection="${escapeHtml(item.id)}"><b>${escapeHtml(item.name)}</b><span>$${item.price}</span><small>${escapeHtml(item.summary)}</small></button>`).join('');
}

function statusOptions(selected, escapeHtml) {
  const blank = `<option value="" ${selected ? '' : 'selected'}>Choose</option>`;
  return blank + INSPECTION_STATUSES.map(status => `<option value="${status.id}" ${selected === status.id ? 'selected' : ''}>${escapeHtml(status.label)}</option>`).join('');
}

export function catalogInspectionFormHtml(catalog, record = null, context = {}, escapeHtml = value => String(value ?? '')) {
  const items = record?.items?.length ? record.items : inspectionItems(catalog);
  const sections = [];
  for (const item of items) {
    const title = item.section || 'Inspection';
    let section = sections.find(entry => entry.title === title);
    if (!section) {
      section = { title, items: [] };
      sections.push(section);
    }
    section.items.push(item);
  }
  const fields = sections.map(section => {
    const rows = section.items.map(item => `<div class="inspect-row" data-section="${escapeHtml(section.title)}">
      <div><b>${escapeHtml(item.label || item.name || '')}</b></div>
      <select name="status-${escapeHtml(item.id)}" aria-label="Result for ${escapeHtml(item.label || item.name || '')}">${statusOptions(item.status, escapeHtml)}</select>
      ${item.measure || item.measurement ? `<input name="measure-${escapeHtml(item.id)}" value="${escapeHtml(item.measurement || '')}" placeholder="${escapeHtml(item.measure || 'Measurement')}" aria-label="${escapeHtml(item.measure || 'Measurement')}"/>` : '<span></span>'}
      <input name="note-${escapeHtml(item.id)}" value="${escapeHtml(item.note || '')}" placeholder="Finding" aria-label="Note"/>
      <button type="button" class="secondary dictate" data-dictate="note-${escapeHtml(item.id)}">Dictate</button>
    </div>`).join('');
    return `<section class="inspect-section"><div class="inspect-section-head"><h3>${escapeHtml(section.title)}</h3><button type="button" class="mini-action" data-mark-section="${escapeHtml(section.title)}">Mark unmarked OK</button></div>${rows}</section>`;
  }).join('');
  const vehicles = (context.vehicles || []).map(vehicle => `<option value="${escapeHtml(vehicle.id)}" ${record?.vehicleId === vehicle.id ? 'selected' : ''}>${escapeHtml(vehicle.label)}</option>`).join('');
  const orders = (context.orders || []).map(order => `<option value="${escapeHtml(order.id)}" ${record?.workOrderId === order.id ? 'selected' : ''}>${escapeHtml(order.label)}</option>`).join('');
  const verdicts = (catalog.verdicts || []).map(item => `<option value="${item.id}" ${record?.verdict === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const conditions = ['Cold', 'Already warm', 'Road test authorized', 'Lift or jack stands', 'Scan authorized', 'Compression authorized'];
  const selectedConditions = new Set(record?.conditions || []);
  const photos = (record?.photoKeys || []).map(key => inspectionPhotoSrc(key, context.apiUrl)).filter(Boolean);
  return `<form class="modal wide inspect-sheet" id="catalog-inspection-form">
    <div class="modal-head"><h2>${escapeHtml(catalog.name)}</h2><button type="button" class="close" data-close></button></div>
    <div class="modal-body">
      <p class="inspect-fee">Inspection fee $${catalog.price}. Repairs, parts, and disassembly are quoted separately. Type a finding or dictate it.</p>
      <div class="form-grid">
        <label>Customer<input name="customer" value="${escapeHtml(record?.customer || '')}" required/></label>
        <label>Vehicle<input name="vehicle" value="${escapeHtml(record?.vehicle || '')}" placeholder="Year make model" required/></label>
        <label>VIN<input name="vin" value="${escapeHtml(record?.vin || '')}"/></label>
        <label>Mileage<input name="mileage" value="${escapeHtml(record?.mileage || '')}"/></label>
        <label>Technician<input name="tech" value="${escapeHtml(record?.techName || context.techName || '')}"/></label>
        <label>Linked vehicle<select name="vehicleId"><option value="">Not in the shop list</option>${vehicles}</select></label>
        <label>Work order<select name="workOrderId"><option value="">Unlinked</option>${orders}</select></label>
      </div>
      <div class="inspect-conditions">${conditions.map(condition => `<label><input type="checkbox" name="condition" value="${escapeHtml(condition)}" ${selectedConditions.has(condition) ? 'checked' : ''}/>${escapeHtml(condition)}</label>`).join('')}</div>
      <details class="inspect-guide"><summary>Technician guide</summary><p>${escapeHtml(catalog.summary)}</p><p><b>Photos before closing:</b> ${escapeHtml(catalog.photos)}</p><p>${escapeHtml(catalog.limits)}</p></details>
      ${fields}
      <label class="full">Recommendations<textarea name="recommendations" rows="3">${escapeHtml(record?.recommendations || '')}</textarea></label>
      <button type="button" class="secondary dictate" data-dictate="recommendations">Dictate recommendations</button>
      ${verdicts ? `<label>Verdict<select name="verdict"><option value="">Choose</option>${verdicts}</select></label><label class="full">One-page seller summary<textarea name="sellerSummary" rows="4">${escapeHtml(record?.sellerSummary || '')}</textarea></label><button type="button" class="secondary dictate" data-dictate="sellerSummary">Dictate seller summary</button>` : ''}
      <label class="full">Photos or video of key findings<input name="photos" type="file" accept="image/*,video/mp4,video/webm,video/quicktime" capture="environment" multiple/></label>
      ${photos.length ? `<div class="inspect-photos">${photos.map(src => `<img src="${escapeHtml(src)}" alt="Attached inspection photo"/>`).join('')}</div>` : ''}
      <input type="hidden" name="existingPhotos" value="${escapeHtml(JSON.stringify(record?.photoKeys || []))}"/>
      <label>Customer acknowledgment name<input name="customerName" value="${escapeHtml(record?.customerName || record?.customer || '')}" placeholder="Name on the customer copy"/></label>
      <div class="inspect-sign"><span>Customer signature</span><canvas id="inspection-signature" width="520" height="140"></canvas><button type="button" class="secondary" id="clear-signature">Clear signature</button></div>
      <p class="inspect-limits">${escapeHtml(catalog.limits)}</p>
    </div>
    <div class="modal-actions">
      <button type="submit" class="secondary" data-intent="draft">Save draft</button>
      <button type="submit" class="secondary" data-intent="print">Print customer copy</button>
      <button type="submit" class="primary" data-intent="close">Close inspection</button>
    </div>
  </form>`;
}
