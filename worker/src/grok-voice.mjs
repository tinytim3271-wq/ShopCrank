import { HttpError, json, requestJson } from './http.mjs';
import { constantTimeEqual, hmacBase64Url } from './security.mjs';
import {
  calculateVoiceCost,
  executeAdvancedShopSearch,
  loadShopPricing,
  recordAiUsage,
} from './ai.mjs';
import { verifyTwilioWebhookSignature } from './integrations/sms.mjs';
import { searchLicensedLabor } from './integrations/labor.mjs';

export const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';
export const GROK_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';
export const GROK_MODEL = 'grok-voice-latest';
export const GROK_TRANSCRIBE_MODEL = 'grok-transcribe';
export const GROK_VOICES = Object.freeze(['eve', 'ara', 'rex', 'sal', 'leo']);
export const DEFAULT_GROK_VOICE = 'eve';

const GROK_SAMPLE_RATE = 24000;
const TWILIO_SAMPLE_RATE = 8000;
const STREAM_TOKEN_TTL_MS = 15 * 60 * 1000;

const STANDARD_SHOP_OPERATIONS = Object.freeze([
  { pattern: /\b(front\s+)?brake\s*(pad|rotor|job|service|grind|squeak)/i, description: 'Front Brake Pads & Rotor Replacement', hours: 1.8, partsPrice: 265, partDescription: 'Ceramic Brake Pad & Rotor Kit (1 Axle)' },
  { pattern: /\brear\s+brake/i, description: 'Rear Brake Pads & Rotor Replacement', hours: 1.8, partsPrice: 255, partDescription: 'Rear Brake Pad & Rotor Kit' },
  { pattern: /\b(oil\s*change|synthetic\s*oil|lube|oil\s*service)/i, description: 'Full Synthetic Oil & Filter Service', hours: 0.5, partsPrice: 68, partDescription: 'Full Synthetic Oil & OEM Filter' },
  { pattern: /\bwater\s*pump/i, description: 'Engine Water Pump Replacement & Coolant Bleed', hours: 2.8, partsPrice: 210, partDescription: 'Water Pump, Gasket & Coolant' },
  { pattern: /\balternator/i, description: 'Alternator Replacement & Charging System Test', hours: 1.4, partsPrice: 310, partDescription: 'Remanufactured OEM-Spec Alternator' },
  { pattern: /\bstarter/i, description: 'Starter Motor Replacement & Starting Circuit Test', hours: 1.3, partsPrice: 245, partDescription: 'Starter Motor Assembly' },
  { pattern: /\bbattery\b/i, description: 'Battery Replacement & Charging System Inspection', hours: 0.5, partsPrice: 195, partDescription: 'AGM / Lead-Acid Automotive Battery' },
  { pattern: /\b(a\/c|air\s*condition|ac\s*blow|warm\s*air|freon|refrigerant)/i, description: 'A/C Performance & Leak Diagnostic', hours: 1.2, partsPrice: 45, partDescription: 'Refrigerant Dye & Service Port Seals' },
  { pattern: /\b(spark\s*plug|tune[\s-]*up|ignition\s*coil)/i, description: 'Spark Plug & Ignition Service', hours: 1.6, partsPrice: 145, partDescription: 'Iridium Spark Plug Set' },
  { pattern: /\b(alignment|wheel\s*alignment|pulling)/i, description: 'Four-Wheel Computerized Alignment', hours: 1.0, partsPrice: 0, partDescription: '' },
  { pattern: /\b(tire\s*rotation|rotate\s*tires|balance)/i, description: 'Tire Rotation & Road-Force Balance', hours: 0.6, partsPrice: 0, partDescription: '' },
  { pattern: /\b(coolant|radiator\s*flush|overheat)/i, description: 'Cooling System Pressure Test & Flush', hours: 1.2, partsPrice: 55, partDescription: 'OEM-Spec Extended Life Coolant' },
  { pattern: /\b(transmission\s*fluid|transmission\s*service)/i, description: 'Transmission Fluid & Filter Service', hours: 1.5, partsPrice: 135, partDescription: 'ATF Fluid & Filter Kit' },
  { pattern: /\b(check\s*engine|dtc|code|misfire|rough\s*idle|stall|no\s*start|diagnostic)/i, description: 'Comprehensive OBD-II & Mechanical Diagnostic Inspection', hours: 1.0, partsPrice: 0, partDescription: '' },
]);

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[ch]));
}

export function normalizeGrokVoice(value) {
  const voice = String(value || DEFAULT_GROK_VOICE).trim().toLowerCase();
  return GROK_VOICES.includes(voice) ? voice : DEFAULT_GROK_VOICE;
}

export function normalizeXaiApiKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new HttpError(400, 'Paste your xAI API key.');
  if (/\s/.test(key) || key.length < 16 || key.length > 300) {
    throw new HttpError(400, 'Enter a valid xAI API key from console.x.ai.');
  }
  return key;
}

function parseEntityRow(row) {
  if (!row?.data_json) return null;
  try {
    return JSON.parse(row.data_json);
  } catch {
    return null;
  }
}

export async function loadGrokShopSettings(env, shopId) {
  const defaults = {
    voice: DEFAULT_GROK_VOICE,
    greeting: '',
    instructions: '',
    forwardingPhone: '',
    autoSaveIntake: true,
    shopName: 'Our Automotive Shop',
    shopPhone: '',
    shopAddress: '',
    shopHours: 'Monday–Friday 8:00 AM – 5:30 PM',
  };
  if (!env?.DB || !shopId) return defaults;
  try {
    const result = await env.DB.prepare(`
      SELECT entity_id, data_json FROM entities
      WHERE shop_id = ? AND entity_type = 'shopsettings' AND entity_id IN ('profile', 'grok_phone')
    `).bind(shopId).all();
    const map = new Map((result.results || []).map((row) => [row.entity_id, parseEntityRow(row)]));
    const profile = map.get('profile') || {};
    const grokPhone = map.get('grok_phone') || {};
    return {
      voice: normalizeGrokVoice(grokPhone.voice),
      greeting: cleanText(grokPhone.greeting, 500),
      instructions: cleanText(grokPhone.instructions, 2000),
      forwardingPhone: cleanText(grokPhone.forwardingPhone || profile.phone, 40),
      autoSaveIntake: grokPhone.autoSaveIntake !== false,
      shopName: cleanText(profile.shopName || profile.name || defaults.shopName, 160),
      shopPhone: cleanText(profile.phone || '', 40),
      shopAddress: cleanText(profile.address || '', 240),
      shopHours: cleanText(grokPhone.shopHours || profile.hours || defaults.shopHours, 240),
    };
  } catch {
    return defaults;
  }
}

export async function resolveGrokApiKey(env, shopId, getSecret = null) {
  if (shopId && typeof getSecret === 'function') {
    try {
      const shopKey = await getSecret(env, shopId, 'xai-api-key');
      if (String(shopKey || '').trim()) {
        return { apiKey: String(shopKey).trim(), keySource: 'shop' };
      }
    } catch {
      // Fall back to platform key if secret lookup fails.
    }
  }
  const envKey = String(env?.XAI_API_KEY || '').trim();
  if (envKey) return { apiKey: envKey, keySource: 'platform' };
  return { apiKey: '', keySource: null };
}

export const GROK_SHOP_TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'get_shop_info',
    description: 'Get the automotive shop profile, address, hours, labor rate, tax rate, diagnostic policy, and any existing customer/vehicle records matching the caller phone number.',
    parameters: {
      type: 'object',
      properties: {
        callerPhone: { type: 'string', description: 'Caller phone number if known.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'lookup_customer_and_vehicles',
    description: 'Search shop records for an existing customer, vehicle, open work order (RO), estimate, or appointment by name, phone, VIN, or repair order number.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Customer name, phone number, VIN, vehicle model, or RO/Estimate number.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'calculate_service_estimate',
    description: 'Calculate an itemized automotive service estimate (labor hours, labor cost, parts estimate, shop supplies fee, and tax) using the shop labor rate and service guide.',
    parameters: {
      type: 'object',
      properties: {
        vehicle: {
          type: 'object',
          properties: {
            year: { type: 'string' },
            make: { type: 'string' },
            model: { type: 'string' },
            trim: { type: 'string' },
            engine: { type: 'string' },
            vin: { type: 'string' },
            mileage: { type: 'string' },
          },
        },
        complaint: { type: 'string', description: 'Customer symptoms or reason for visit.' },
        requestedServices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Requested repairs or maintenance items (e.g. ["front brake pads and rotors", "synthetic oil change"]).',
        },
        customLines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['labor', 'part'] },
              description: { type: 'string' },
              hours: { type: 'number' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
            },
          },
        },
      },
      required: ['complaint'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'save_call_intake_and_estimate',
    description: 'Fill the shop customer intake form, vehicle details, 3 Cs / concern, and save a reviewable Estimate and Work Order draft in ShopCrank. Call this whenever the caller provides their name, vehicle, or repair concern, and update it as more details are collected.',
    parameters: {
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          properties: {
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            name: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            zip: { type: 'string' },
          },
        },
        vehicle: {
          type: 'object',
          properties: {
            year: { type: 'string' },
            make: { type: 'string' },
            model: { type: 'string' },
            trim: { type: 'string' },
            engine: { type: 'string' },
            vin: { type: 'string' },
            plate: { type: 'string' },
            plateState: { type: 'string' },
            mileage: { type: 'string' },
            color: { type: 'string' },
          },
        },
        concern: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Primary customer complaint or symptoms.' },
            began: { type: 'string', description: 'When the issue started.' },
            frequency: { type: 'string', description: 'How often the issue occurs.' },
            lights: { type: 'string', description: 'Dashboard warning lights on (e.g. Check Engine, ABS).' },
            recentRepairs: { type: 'string' },
            towed: { type: 'string', description: 'Whether the vehicle needs a tow or is drivable.' },
            overheating: { type: 'string' },
          },
        },
        requestedServices: {
          type: 'array',
          items: { type: 'string' },
        },
        preferredAppointment: {
          type: 'string',
          description: 'Preferred drop-off day or time mentioned by the caller.',
        },
      },
      required: ['customer', 'vehicle', 'concern'],
      additionalProperties: false,
    },
  },
]);

export function buildGrokInstructions({
  shopSettings = {},
  pricing = { laborRate: 140, taxRate: 8.25 },
  callerPhone = '',
  callerContext = null,
} = {}) {
  const shopName = shopSettings.shopName || 'Our Automotive Shop';
  const laborRate = Number(pricing.laborRate || 140).toFixed(2);
  const taxRate = Number(pricing.taxRate || 8.25).toFixed(2);
  const greeting = shopSettings.greeting
    || `Thanks for calling ${shopName}! I'm Grok, the shop's automated service advisor. How can I help you with your vehicle today?`;
  const callerLine = callerPhone
    ? `\nCaller phone number from Caller ID: ${callerPhone}.`
    : '';
  const existingCustomerLine = callerContext?.customer
    ? `\nMatched existing customer on file: ${JSON.stringify(callerContext.customer)}. Vehicles on file: ${JSON.stringify(callerContext.vehicles || [])}. Open orders: ${JSON.stringify(callerContext.openOrders || [])}.`
    : '';
  const extraInstructions = shopSettings.instructions
    ? `\nShop-specific policy & notes: ${shopSettings.instructions}`
    : '';

  return `You are Grok, the live phone receptionist and automotive service advisor for ${shopName}.
Speak naturally, warmly, and concisely over the phone—keep each spoken turn brief (1 to 3 sentences at a time) so the caller can easily converse with you.

Shop Information:
- Shop Name: ${shopName}
- Address: ${shopSettings.shopAddress || 'Ask staff to confirm address if requested'}
- Hours: ${shopSettings.shopHours || 'Monday–Friday 8:00 AM – 5:30 PM'}
- Labor Rate: $${laborRate}/hr
- Sales Tax Rate: ${taxRate}%
- Shop Supplies Fee: 3% of labor (capped at $20.00)${callerLine}${existingCustomerLine}${extraInstructions}
- Recommended Opening Greeting: "${greeting}"

Your Core Responsibilities on Every Call:
1. Answer Brief Questions & Status Checks:
   - If the caller asks about shop hours, location, labor rates, services, or the status of their vehicle/repair order, use \`get_shop_info\` or \`lookup_customer_and_vehicles\` to give accurate answers from shop records.
2. Gather Customer & Vehicle Intake Information Conversationally:
   - Collect the caller's name, phone number (confirm Caller ID if present), email (optional), vehicle year/make/model (and mileage or VIN if handy), and their exact complaint/symptoms (warning lights, when it started, whether it needs a tow).
3. Provide Ballpark Estimates:
   - When the caller asks how much a repair, maintenance service, or diagnostic costs, call \`calculate_service_estimate\` to compute the labor, parts, shop supplies, and tax using the shop's $${laborRate}/hr labor rate.
   - Clearly state the ballpark total and mention that final pricing is confirmed after an in-bay technician inspection.
4. Fill Shop Forms & Save the Intake + Estimate:
   - Call \`save_call_intake_and_estimate\` as soon as you have the caller's name/phone, vehicle, and concern so the shop's intake form, customer record, estimate, and work order draft are filled in automatically.`;
}

export function buildGrokSessionUpdate({
  shopSettings = {},
  pricing = { laborRate: 140, taxRate: 8.25 },
  callerPhone = '',
  callerContext = null,
} = {}) {
  return {
    type: 'session.update',
    session: {
      voice: normalizeGrokVoice(shopSettings.voice),
      instructions: buildGrokInstructions({ shopSettings, pricing, callerPhone, callerContext }),
      turn_detection: { type: 'server_vad' },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: GROK_SAMPLE_RATE },
          transcription: { model: GROK_TRANSCRIBE_MODEL },
        },
        output: {
          format: { type: 'audio/pcm', rate: GROK_SAMPLE_RATE },
        },
      },
      tools: GROK_SHOP_TOOLS,
    },
  };
}

export async function calculateGrokServiceEstimate(env, shopId, input = {}, pricingOverride = null) {
  const pricing = pricingOverride || (await loadShopPricing(env, shopId));
  const laborRate = Number(pricing.laborRate || 140);
  const taxRate = Number(pricing.taxRate || 8.25);
  const vehicleObj = input.vehicle || {};
  const vehicleLabel = [vehicleObj.year, vehicleObj.make, vehicleObj.model, vehicleObj.trim]
    .map((v) => cleanText(v, 60))
    .filter(Boolean)
    .join(' ') || cleanText(input.vehicleDescription || 'Customer Vehicle', 120);
  const complaint = cleanText(input.complaint || '', 500);
  const requested = Array.isArray(input.requestedServices) ? input.requestedServices.map((s) => cleanText(s, 200)).filter(Boolean) : [];
  const searchSource = [complaint, ...requested].join(' ');

  const lines = [];
  if (Array.isArray(input.customLines) && input.customLines.length) {
    for (const item of input.customLines.slice(0, 15)) {
      const isPart = String(item?.type || '').toLowerCase() === 'part';
      if (isPart) {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const unitPrice = Math.max(0, Number(item.unitPrice) || 0);
        lines.push({
          type: 'part',
          description: cleanText(item.description || 'Replacement Part', 200),
          quantity: qty,
          unitPrice,
          total: Math.round(qty * unitPrice * 100) / 100,
          source: 'Grok Estimate',
        });
      } else {
        const hours = Math.max(0.2, Number(item.hours ?? item.quantity) || 1);
        const total = Math.round(hours * laborRate * 100) / 100;
        lines.push({
          type: 'labor',
          description: cleanText(item.description || 'Service Labor', 200),
          hours,
          quantity: hours,
          laborRate,
          unitPrice: laborRate,
          total,
          source: 'Grok Estimate',
        });
      }
    }
  }

  if (!lines.length) {
    // Try licensed labor lookup first if configured
    for (const term of (requested.length ? requested : [complaint]).filter(Boolean).slice(0, 3)) {
      try {
        const licensed = await searchLicensedLabor(env, {
          vin: vehicleObj.vin || '',
          year: vehicleObj.year || '',
          make: vehicleObj.make || '',
          model: vehicleObj.model || '',
          query: term,
        });
        const hit = Array.isArray(licensed) ? licensed.find((item) => Number(item.hours) > 0) : null;
        if (hit) {
          const hours = Math.max(0.2, Number(hit.hours) || 1);
          lines.push({
            type: 'labor',
            description: cleanText(hit.operation || hit.description || term, 200),
            hours,
            quantity: hours,
            laborRate,
            unitPrice: laborRate,
            total: Math.round(hours * laborRate * 100) / 100,
            source: cleanText(hit.source || 'Labor Guide', 80),
          });
        }
      } catch {
        // Ignore licensed provider errors and fall back to built-in operations.
      }
    }
  }

  if (!lines.length) {
    for (const op of STANDARD_SHOP_OPERATIONS) {
      if (op.pattern.test(searchSource)) {
        const laborTotal = Math.round(op.hours * laborRate * 100) / 100;
        lines.push({
          type: 'labor',
          description: op.description,
          hours: op.hours,
          quantity: op.hours,
          laborRate,
          unitPrice: laborRate,
          total: laborTotal,
          source: 'ShopCrank Service Guide',
        });
        if (op.partsPrice > 0) {
          lines.push({
            type: 'part',
            description: op.partDescription || `${op.description} Parts`,
            quantity: 1,
            unitPrice: op.partsPrice,
            total: op.partsPrice,
            source: 'ShopCrank Ballpark Parts',
          });
        }
      }
    }
  }

  if (!lines.length) {
    const defaultOp = STANDARD_SHOP_OPERATIONS.at(-1);
    const laborTotal = Math.round(defaultOp.hours * laborRate * 100) / 100;
    lines.push({
      type: 'labor',
      description: complaint ? `Diagnose & Inspect: ${complaint.slice(0, 80)}` : defaultOp.description,
      hours: defaultOp.hours,
      quantity: defaultOp.hours,
      laborRate,
      unitPrice: laborRate,
      total: laborTotal,
      source: 'Shop Standard Diagnostic',
    });
  }

  const laborTotal = Math.round(
    lines.filter((l) => l.type === 'labor').reduce((sum, l) => sum + Number(l.total || 0), 0) * 100,
  ) / 100;
  const laborHours = Math.round(
    lines.filter((l) => l.type === 'labor').reduce((sum, l) => sum + Number(l.hours || l.quantity || 0), 0) * 100,
  ) / 100;
  const partsTotal = Math.round(
    lines.filter((l) => l.type === 'part').reduce((sum, l) => sum + Number(l.total || 0), 0) * 100,
  ) / 100;
  const shopSupplies = laborTotal > 0 ? Math.min(20, Math.round(laborTotal * 0.03 * 100) / 100) : 0;
  const fees = shopSupplies > 0 ? [{ id: 'shop-supplies', description: 'Shop supplies (3% of labor, max $20)', amount: shopSupplies }] : [];
  const subtotal = Math.round((laborTotal + partsTotal + shopSupplies) * 100) / 100;
  const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;

  return {
    vehicle: vehicleLabel,
    laborRate,
    taxRate,
    laborHours,
    labor: laborTotal,
    parts: partsTotal,
    shopSupplies,
    fees,
    subtotal,
    tax,
    total,
    lines,
    disclaimer: 'Preliminary phone estimate based on caller description. Final price requires an in-shop vehicle inspection and part fitment verification.',
  };
}

async function lookupCallerContext(env, shopId, callerPhone) {
  const digits = String(callerPhone || '').replace(/\D/g, '').slice(-10);
  if (!digits || digits.length < 7 || !env?.DB) return null;
  try {
    const customerRow = await env.DB.prepare(`
      SELECT entity_id, data_json FROM entities
      WHERE shop_id = ? AND entity_type = 'customers'
        AND replace(replace(replace(replace(json_extract(data_json, '$.phone'), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
      LIMIT 1
    `).bind(shopId, `%${digits}`).first();
    const customer = parseEntityRow(customerRow);
    if (!customer) return null;
    const customerName = String(customer.name || '').trim();
    const [vehiclesRes, ordersRes] = await Promise.all([
      env.DB.prepare(`
        SELECT data_json FROM entities
        WHERE shop_id = ? AND entity_type = 'vehicles'
          AND (json_extract(data_json, '$.customerId') = ? OR lower(json_extract(data_json, '$.customer')) = lower(?))
        ORDER BY updated_at DESC LIMIT 5
      `).bind(shopId, customer.id || customerRow.entity_id, customerName).all(),
      env.DB.prepare(`
        SELECT data_json FROM entities
        WHERE shop_id = ? AND entity_type = 'orders'
          AND lower(json_extract(data_json, '$.customer')) = lower(?)
        ORDER BY updated_at DESC LIMIT 5
      `).bind(shopId, customerName).all(),
    ]);
    return {
      customer,
      vehicles: (vehiclesRes.results || []).map(parseEntityRow).filter(Boolean),
      openOrders: (ordersRes.results || []).map(parseEntityRow).filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function upsertShopEntityDirect(env, shopId, entityType, entityId, record, createdBy = 'grok-voice') {
  if (!env?.DB || !shopId) return record;
  const now = new Date().toISOString();
  const payload = {
    ...record,
    id: entityId,
    shopId,
    createdBy: record.createdBy || createdBy,
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(shopId, entityType, entityId, JSON.stringify(payload), payload.createdBy, payload.createdAt, now).run();
  return payload;
}

export function buildIntakeDraftFromGrokCall(input = {}, estimateCalc = null, callerPhone = '') {
  const rawCust = input.customer || {};
  const rawName = cleanText(rawCust.name || '', 160);
  const nameParts = rawName ? rawName.split(/\s+/) : [];
  const firstName = cleanText(rawCust.firstName || nameParts[0] || 'Caller', 80);
  const lastName = cleanText(rawCust.lastName || nameParts.slice(1).join(' ') || '', 80);
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || rawName || 'Phone Caller';
  const phone = cleanText(rawCust.phone || callerPhone || '', 40);
  const email = cleanText(rawCust.email || '', 254);
  const address = cleanText(rawCust.address || '', 240);
  const city = cleanText(rawCust.city || '', 100);
  const state = cleanText(rawCust.state || '', 40);
  const zip = cleanText(rawCust.zip || '', 20);

  const rawVeh = input.vehicle || {};
  const year = cleanText(rawVeh.year || '', 10);
  const make = cleanText(rawVeh.make || '', 60);
  const model = cleanText(rawVeh.model || '', 60);
  const trim = cleanText(rawVeh.trim || '', 60);
  const engine = cleanText(rawVeh.engine || '', 60);
  const vin = cleanText(rawVeh.vin || '', 17).toUpperCase();
  const plate = cleanText(rawVeh.plate || '', 20).toUpperCase();
  const plateState = cleanText(rawVeh.plateState || rawVeh.plate_state || '', 10).toUpperCase();
  const mileage = cleanText(rawVeh.mileage || '', 20).replace(/[^\d]/g, '');
  const color = cleanText(rawVeh.color || '', 40);
  const vehicleDescription = [year, make, model, trim].filter(Boolean).join(' ')
    || cleanText(rawVeh.description || 'Vehicle pending', 160);

  const rawConcern = typeof input.concern === 'string'
    ? { description: input.concern }
    : (input.concern || {});
  const complaint = cleanText(
    rawConcern.description || input.complaint || (Array.isArray(input.requestedServices) ? input.requestedServices.join(', ') : '') || 'Phone inquiry',
    2000,
  );

  const aiFilledFields = {};
  if (vin) aiFilledFields['vehicle.vin'] = true;
  if (plate) aiFilledFields['vehicle.plate'] = true;
  if (plateState) aiFilledFields['vehicle.plateState'] = true;
  if (year) aiFilledFields['vehicle.year'] = true;
  if (make) aiFilledFields['vehicle.make'] = true;
  if (model) aiFilledFields['vehicle.model'] = true;
  if (trim) aiFilledFields['vehicle.trim'] = true;
  if (engine) aiFilledFields['vehicle.engine'] = true;
  if (mileage) aiFilledFields['vehicle.mileage'] = true;
  if (color) aiFilledFields['vehicle.color'] = true;
  if (complaint) aiFilledFields['concern.description'] = true;

  const estimateLines = (estimateCalc?.lines || []).map((line) => ({
    type: line.type === 'part' ? 'part' : 'labor',
    description: line.description,
    quantity: line.type === 'part' ? (line.quantity || 1) : (line.hours || line.quantity || 1),
    hours: line.type === 'labor' ? (line.hours || line.quantity || 1) : undefined,
    unitPrice: Number(line.unitPrice || 0),
    total: Number(line.total || 0),
    source: line.source || 'Grok Voice Estimate',
    aiFilled: true,
  }));
  if (estimateLines.length) aiFilledFields['estimate.lines'] = true;

  return {
    fullName,
    vehicleDescription,
    complaint,
    intakeDraft: {
      id: `intake-grok-${Date.now()}`,
      step: 0,
      savedAt: new Date().toISOString(),
      status: 'draft',
      source: 'grok_voice_call',
      customer: {
        firstName,
        lastName,
        phone,
        email,
        company: '',
        secondaryPhone: '',
        address,
        city,
        state,
        zip,
        contact: { phone: true, text: Boolean(phone), email: Boolean(email) },
      },
      vehicle: {
        vin,
        plate,
        plateState,
        year,
        make,
        model,
        trim,
        engine,
        transmission: '',
        mileage,
        color,
      },
      photos: [],
      damage: [],
      concern: {
        description: complaint,
        began: cleanText(rawConcern.began || '', 200),
        frequency: cleanText(rawConcern.frequency || '', 200),
        lights: cleanText(rawConcern.lights || '', 200),
        recentRepairs: cleanText(rawConcern.recentRepairs || '', 300),
        accident: '',
        towed: cleanText(rawConcern.towed || '', 120),
        overheating: cleanText(rawConcern.overheating || '', 120),
      },
      diagnosis: {
        visual: '',
        roadTest: '',
        fluids: '',
        battery: '',
        codes: '',
        notes: input.preferredAppointment ? `Preferred drop-off: ${cleanText(input.preferredAppointment, 200)}` : '',
        cause: '',
        correction: '',
        severity: '',
        analysis: null,
      },
      estimate: {
        lines: estimateLines,
        diagnosticCharge: 0,
        approval: 'pending',
      },
      aiFilledFields,
      assignments: [],
    },
  };
}

export async function executeGrokShopTool(env, shopId, name, args = {}, { callerPhone = '', callSid = '' } = {}) {
  if (name === 'get_shop_info') {
    const [shopSettings, pricing, callerContext] = await Promise.all([
      loadGrokShopSettings(env, shopId),
      loadShopPricing(env, shopId),
      lookupCallerContext(env, shopId, args.callerPhone || callerPhone),
    ]);
    return {
      shopName: shopSettings.shopName,
      phone: shopSettings.shopPhone || shopSettings.forwardingPhone,
      address: shopSettings.shopAddress,
      hours: shopSettings.shopHours,
      laborRate: pricing.laborRate,
      taxRate: pricing.taxRate,
      shopSuppliesPolicy: '3% of labor, capped at $20.00',
      callerContext,
    };
  }

  if (name === 'lookup_customer_and_vehicles') {
    const query = cleanText(args.query || callerPhone, 160);
    if (!query) return { error: 'Provide a search query such as customer name, phone number, VIN, or RO number.' };
    if (!env?.DB) return { query, count: 0, records: [] };
    return executeAdvancedShopSearch(env, shopId, {
      query,
      types: ['customers', 'vehicles', 'orders', 'estimates', 'appointments'],
      limit: 10,
    });
  }

  if (name === 'calculate_service_estimate') {
    return calculateGrokServiceEstimate(env, shopId, args);
  }

  if (name === 'save_call_intake_and_estimate') {
    const pricing = await loadShopPricing(env, shopId);
    const estimateCalc = await calculateGrokServiceEstimate(env, shopId, {
      vehicle: args.vehicle,
      complaint: args.concern?.description || args.complaint || '',
      requestedServices: args.requestedServices || [],
    }, pricing);
    const { fullName, vehicleDescription, complaint, intakeDraft } = buildIntakeDraftFromGrokCall(args, estimateCalc, callerPhone);

    const timestamp = Date.now();
    const customerId = `cust-grok-${timestamp}`;
    const vehicleId = `veh-grok-${timestamp}`;
    const estimateNumber = `EST-${new Date().getFullYear()}-${String(timestamp).slice(-4)}`;
    const estimateId = `estimate-${timestamp}`;
    const orderId = `RO-${String(timestamp).slice(-4)}`;

    const customerRecord = {
      id: customerId,
      name: fullName,
      phone: intakeDraft.customer.phone,
      email: intakeDraft.customer.email,
      billingAddress: [intakeDraft.customer.address, intakeDraft.customer.city, intakeDraft.customer.state, intakeDraft.customer.zip].filter(Boolean).join(', '),
      billingNotes: 'Created by Grok Phone Intake',
      source: 'grok_voice_call',
    };

    const vehicleRecord = {
      id: vehicleId,
      customerId,
      customer: fullName,
      year: intakeDraft.vehicle.year,
      make: intakeDraft.vehicle.make,
      model: intakeDraft.vehicle.model,
      trim: intakeDraft.vehicle.trim,
      engine: intakeDraft.vehicle.engine,
      vin: intakeDraft.vehicle.vin,
      plate: intakeDraft.vehicle.plate,
      mileage: intakeDraft.vehicle.mileage,
      color: intakeDraft.vehicle.color,
    };

    const estimateRecord = {
      id: estimateId,
      number: estimateNumber,
      customer: fullName,
      customerDetails: {
        name: fullName,
        phone: intakeDraft.customer.phone,
        email: intakeDraft.customer.email,
        address: customerRecord.billingAddress,
      },
      phone: intakeDraft.customer.phone,
      email: intakeDraft.customer.email,
      vehicle: vehicleDescription,
      vehicleDetails: {
        description: vehicleDescription,
        vin: intakeDraft.vehicle.vin,
        plate: intakeDraft.vehicle.plate,
      },
      vin: intakeDraft.vehicle.vin,
      plate: intakeDraft.vehicle.plate,
      workOrderId: orderId,
      status: 'pending',
      source: 'grok_voice_call',
      lines: estimateCalc.lines.map((line) => ({
        service: line.description,
        description: line.description,
        type: line.type,
        hours: line.hours || (line.type === 'labor' ? line.quantity : 0),
        quantity: line.quantity || 1,
        unitPrice: line.unitPrice || 0,
        labor: line.type === 'labor' ? line.total : 0,
        parts: line.type === 'part' ? line.total : 0,
        total: line.total,
        notes: line.source || '',
      })),
      fees: estimateCalc.fees,
      subtotal: estimateCalc.subtotal,
      tax: estimateCalc.tax,
      total: estimateCalc.total,
      summary: `Grok phone estimate for ${vehicleDescription}: ${complaint}`,
    };

    const orderRecord = {
      id: orderId,
      customer: fullName,
      phone: intakeDraft.customer.phone,
      vehicle: vehicleDescription,
      vin: intakeDraft.vehicle.vin || 'VIN pending',
      complaint,
      status: 'estimate',
      priority: /tow|overheat|brake|stall|no\s*start/i.test(`${complaint} ${intakeDraft.concern.towed}`) ? 'high' : 'normal',
      tech: 'Unassigned',
      bay: 'Unassigned',
      mobile: false,
      promise: cleanText(args.preferredAppointment || 'Phone Intake - Pending Drop-off', 120),
      notes: [
        'Created automatically by Grok Phone Receptionist.',
        intakeDraft.concern.lights ? `Warning lights: ${intakeDraft.concern.lights}` : '',
        intakeDraft.concern.began ? `Began: ${intakeDraft.concern.began}` : '',
        intakeDraft.concern.frequency ? `Frequency: ${intakeDraft.concern.frequency}` : '',
        intakeDraft.concern.towed ? `Tow status: ${intakeDraft.concern.towed}` : '',
        args.preferredAppointment ? `Preferred appointment: ${args.preferredAppointment}` : '',
      ].filter(Boolean).join('\n'),
      labor: estimateCalc.labor,
      laborHours: estimateCalc.laborHours,
      parts: estimateCalc.parts,
      tax: estimateCalc.tax,
      total: estimateCalc.total,
      estimate: {
        lines: estimateCalc.lines,
        disclaimer: estimateCalc.disclaimer,
        approvalStatus: 'pending',
      },
      intake: intakeDraft,
      source: 'grok_voice_call',
      callSid: callSid || null,
    };

    if (env?.DB && shopId) {
      await Promise.all([
        upsertShopEntityDirect(env, shopId, 'customers', customerId, customerRecord),
        upsertShopEntityDirect(env, shopId, 'vehicles', vehicleId, vehicleRecord),
        upsertShopEntityDirect(env, shopId, 'estimates', estimateId, estimateRecord),
        upsertShopEntityDirect(env, shopId, 'orders', orderId, orderRecord),
      ]);
    }

    const draftAction = {
      kind: 'estimate_work_order_draft',
      saved: Boolean(env?.DB && shopId),
      requiresUserReview: false,
      orderId,
      estimateNumber,
      estimateId,
      customerId,
      vehicleId,
      pricing: { laborRate: pricing.laborRate, taxRate: pricing.taxRate },
      draft: {
        customer: {
          name: fullName,
          phone: intakeDraft.customer.phone,
          email: intakeDraft.customer.email,
          address: customerRecord.billingAddress,
        },
        vehicle: {
          description: vehicleDescription,
          vin: intakeDraft.vehicle.vin,
          plate: intakeDraft.vehicle.plate,
        },
        complaint,
        requestedServices: args.requestedServices || [complaint],
        parts: estimateCalc.lines.filter((l) => l.type === 'part').map((p) => ({
          description: p.description,
          quantity: p.quantity || 1,
          unitPrice: p.unitPrice || 0,
          priceStatus: 'priced',
        })),
        labor: estimateCalc.lines.filter((l) => l.type === 'labor').map((l) => ({
          description: l.description,
          hours: l.hours || l.quantity || 1,
          source: l.source || 'ShopCrank Service Guide',
        })),
      },
      intakeDraft,
      estimate: estimateRecord,
      order: orderRecord,
    };

    return {
      saved: true,
      orderId,
      estimateNumber,
      customer: fullName,
      vehicle: vehicleDescription,
      complaint,
      estimateTotal: estimateCalc.total,
      estimateBreakdown: {
        labor: estimateCalc.labor,
        parts: estimateCalc.parts,
        shopSupplies: estimateCalc.shopSupplies,
        tax: estimateCalc.tax,
        total: estimateCalc.total,
      },
      action: draftAction,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// --- G.711 mu-law (8 kHz) <-> Linear PCM16 (24 kHz) conversion for Twilio Media Streams ---

export function mulawByteToPcm16(uVal) {
  const u = (~uVal) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

export function pcm16ToMulawByte(pcmVal) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sample = Math.max(-32768, Math.min(32767, Math.trunc(pcmVal)));
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent -= 1, expMask >>= 1) {
    // find segment exponent
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Converts Twilio 8kHz mu-law base64 payload into 24kHz PCM16 little-endian base64 for Grok.
 */
export function transcodeTwilioMulaw8kToGrokPcm24k(mulawBase64) {
  const mulawBytes = base64ToUint8Array(mulawBase64);
  const inSamples = mulawBytes.length;
  if (!inSamples) return '';
  const outSamples = inSamples * 3;
  const outBuffer = new ArrayBuffer(outSamples * 2);
  const view = new DataView(outBuffer);
  for (let i = 0; i < inSamples; i += 1) {
    const s0 = mulawByteToPcm16(mulawBytes[i]);
    const s1 = i + 1 < inSamples ? mulawByteToPcm16(mulawBytes[i + 1]) : s0;
    const baseIdx = i * 3;
    view.setInt16((baseIdx) * 2, s0, true);
    view.setInt16((baseIdx + 1) * 2, Math.round((s0 * 2 + s1) / 3), true);
    view.setInt16((baseIdx + 2) * 2, Math.round((s0 + s1 * 2) / 3), true);
  }
  return uint8ArrayToBase64(new Uint8Array(outBuffer));
}

/**
 * Converts Grok 24kHz PCM16 little-endian base64 into Twilio 8kHz mu-law base64.
 */
export function transcodeGrokPcm24kToTwilioMulaw8k(pcm24kBase64) {
  const pcmBytes = base64ToUint8Array(pcm24kBase64);
  const totalSamples = Math.floor(pcmBytes.byteLength / 2);
  const outSamples = Math.floor(totalSamples / 3);
  if (!outSamples) return '';
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  const mulawBytes = new Uint8Array(outSamples);
  for (let i = 0; i < outSamples; i += 1) {
    const idx = i * 3;
    const s0 = view.getInt16(idx * 2, true);
    const s1 = view.getInt16((idx + 1) * 2, true);
    const s2 = view.getInt16((idx + 2) * 2, true);
    const avg = Math.round((s0 + s1 + s2) / 3);
    mulawBytes[i] = pcm16ToMulawByte(avg);
  }
  return uint8ArrayToBase64(mulawBytes);
}

// --- Twilio Stream Token Signing & Verification ---

function streamSigningSecret(env) {
  return String(
    env?.INTEGRATION_ENCRYPTION_KEY
      || env?.DIAGNOSTICS_CAPABILITY_SECRET
      || env?.TWILIO_AUTH_TOKEN
      || 'shopcrank-dev-voice-stream-secret',
  ).trim();
}

export async function signGrokStreamToken(env, { shopId, caller = '', callSid = '', expiresAt = Date.now() + STREAM_TOKEN_TTL_MS }) {
  const payload = JSON.stringify({
    shopId: String(shopId || ''),
    caller: String(caller || ''),
    callSid: String(callSid || ''),
    exp: Number(expiresAt),
  });
  const encoded = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const sig = await hmacBase64Url(streamSigningSecret(env), encoded);
  return `${encoded}.${sig}`;
}

export async function verifyGrokStreamToken(env, token, expectedShopId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = await hmacBase64Url(streamSigningSecret(env), encoded);
  if (!constantTimeEqual(sig, expectedSig)) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(atob(padded));
    if (!data || data.shopId !== expectedShopId) return null;
    if (Number(data.exp || 0) < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function buildTwilioVoiceStreamTwiml({ streamUrl, caller = '', callSid = '', shopId = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(streamUrl)}">
      <Parameter name="shopId" value="${xmlEscape(shopId)}" />
      <Parameter name="caller" value="${xmlEscape(caller)}" />
      <Parameter name="callSid" value="${xmlEscape(callSid)}" />
    </Stream>
  </Connect>
</Response>`;
}

export async function handleTwilioVoiceIncoming(request, env, shopId, { getSecret = null } = {}) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!shopId) throw new HttpError(400, 'Shop ID is required');

  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);

  // Verify Twilio signature if TWILIO_AUTH_TOKEN is configured and signature header is present
  const authToken = String(env?.TWILIO_AUTH_TOKEN || '').trim();
  const signature = request.headers.get('X-Twilio-Signature');
  if (authToken && String(env?.TWILIO_VERIFY_VOICE || '1') !== '0') {
    const publicUrl = new URL(request.url);
    const valid = await verifyTwilioWebhookSignature({
      authToken,
      url: publicUrl.toString(),
      parameters: params,
      signature,
    });
    if (!valid) {
      throw new HttpError(401, 'Invalid Twilio webhook signature');
    }
  }

  const { apiKey } = await resolveGrokApiKey(env, shopId, getSecret);
  if (!apiKey) {
    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you for calling. Our automated service advisor is currently offline. Please leave a message or call back during shop hours.</Say></Response>`;
    return new Response(fallbackTwiml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }

  const caller = cleanText(params.get('From') || '', 40);
  const callSid = cleanText(params.get('CallSid') || `call-${Date.now()}`, 80);
  const token = await signGrokStreamToken(env, { shopId, caller, callSid });

  const url = new URL(request.url);
  const wsProtocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  const streamUrl = `${wsProtocol}//${url.host}/api/voice/twilio/stream/${encodeURIComponent(shopId)}?token=${encodeURIComponent(token)}`;
  const twiml = buildTwilioVoiceStreamTwiml({ streamUrl, caller, callSid, shopId });

  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

// --- Route Handlers for In-App Grok Voice & Settings ---

export async function handleGrokClientSecret(request, env, context, { getSecret = null, fetcher = fetch } = {}) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const { apiKey, keySource } = await resolveGrokApiKey(env, context.shopId, getSecret);
  if (!apiKey) {
    throw new HttpError(503, 'Grok Voice is not configured yet. Add your xAI API key in Settings > Grok Voice & Phone Call Forwarding.');
  }
  const body = await requestJson(request).catch(() => ({}));
  const callerPhone = cleanText(body.callerPhone || '', 40);

  let response;
  try {
    response = await fetcher(GROK_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expires_after: { seconds: 300 } }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach xAI to start a Grok Voice session');
  }

  const payload = await response.json().catch(() => ({}));
  const token = String(payload?.client_secret?.value || payload?.value || payload?.token || '').trim();
  if (!response.ok || !token) {
    throw new HttpError(502, payload?.error?.message || payload?.message || 'xAI rejected the Grok Voice token request');
  }

  const [shopSettings, pricing, callerContext] = await Promise.all([
    loadGrokShopSettings(env, context.shopId),
    loadShopPricing(env, context.shopId),
    callerPhone ? lookupCallerContext(env, context.shopId, callerPhone) : Promise.resolve(null),
  ]);

  const requestedVoice = body.voice ? normalizeGrokVoice(body.voice) : shopSettings.voice;
  const sessionUpdate = buildGrokSessionUpdate({
    shopSettings: { ...shopSettings, voice: requestedVoice },
    pricing,
    callerPhone,
    callerContext,
  });

  return json({
    token,
    expiresAt: payload?.client_secret?.expires_at || payload?.expires_at || Math.floor(Date.now() / 1000) + 300,
    url: GROK_REALTIME_URL,
    model: GROK_MODEL,
    voice: requestedVoice,
    keySource,
    sessionUpdate,
  });
}

export async function handleGrokToolCall(request, env, context) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await requestJson(request);
  const name = cleanText(body.name || '', 80);
  const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
  const callerPhone = cleanText(body.callerPhone || '', 40);
  const result = await executeGrokShopTool(env, context.shopId, name, args, { callerPhone });
  return json({ name, result });
}

export async function handleGrokVoiceSettings(request, env, context, {
  getSecret = null,
  saveSecret = null,
  deleteSecret = null,
  putEntity = null,
  listEntities = null,
} = {}) {
  const shopId = context.shopId;
  const origin = new URL(request.url).origin;
  const twilioVoiceWebhookUrl = `${origin}/api/voice/twilio/incoming/${encodeURIComponent(shopId)}`;

  if (request.method === 'GET') {
    const [{ apiKey, keySource }, shopSettings, orders] = await Promise.all([
      resolveGrokApiKey(env, shopId, getSecret),
      loadGrokShopSettings(env, shopId),
      typeof listEntities === 'function' ? listEntities(env, shopId, 'orders').catch(() => []) : Promise.resolve([]),
    ]);
    const recentGrokCalls = (Array.isArray(orders) ? orders : [])
      .filter((o) => o?.source === 'grok_voice_call')
      .slice(0, 15);
    return json({
      configured: Boolean(apiKey),
      keySource,
      maskedKey: apiKey ? `\u2022\u2022\u2022\u2022${apiKey.slice(-4)}` : '',
      voice: shopSettings.voice,
      voices: GROK_VOICES,
      greeting: shopSettings.greeting,
      instructions: shopSettings.instructions,
      forwardingPhone: shopSettings.forwardingPhone,
      shopHours: shopSettings.shopHours,
      autoSaveIntake: shopSettings.autoSaveIntake,
      twilioVoiceWebhookUrl,
      recentCalls: recentGrokCalls,
    });
  }

  if (!['admin', 'owner'].includes(context.role)) {
    throw new HttpError(403, 'Only shop owners and admins can configure Grok Voice & Phone Call Forwarding');
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await requestJson(request);
    const rawKey = String(body.apiKey || '').trim();
    if (rawKey) {
      const validKey = normalizeXaiApiKey(rawKey);
      if (typeof saveSecret === 'function') {
        await saveSecret(env, shopId, 'xai-api-key', validKey);
      }
    }
    const currentSettings = await loadGrokShopSettings(env, shopId);
    const nextSettings = {
      voice: normalizeGrokVoice(body.voice || currentSettings.voice),
      greeting: cleanText(body.greeting ?? currentSettings.greeting, 500),
      instructions: cleanText(body.instructions ?? currentSettings.instructions, 2000),
      forwardingPhone: cleanText(body.forwardingPhone ?? currentSettings.forwardingPhone, 40),
      shopHours: cleanText(body.shopHours ?? currentSettings.shopHours, 240),
      autoSaveIntake: body.autoSaveIntake !== false,
      updatedAt: new Date().toISOString(),
    };
    if (typeof putEntity === 'function') {
      await putEntity(env, context, 'shopsettings', 'grok_phone', nextSettings);
    } else if (env?.DB) {
      await upsertShopEntityDirect(env, shopId, 'shopsettings', 'grok_phone', nextSettings, context.userId || 'admin');
    }
    const { apiKey, keySource } = await resolveGrokApiKey(env, shopId, getSecret);
    return json({
      configured: Boolean(apiKey),
      keySource,
      maskedKey: apiKey ? `\u2022\u2022\u2022\u2022${apiKey.slice(-4)}` : '',
      ...nextSettings,
      twilioVoiceWebhookUrl,
      saved: true,
    });
  }

  if (request.method === 'DELETE') {
    if (typeof deleteSecret === 'function') {
      await deleteSecret(env, shopId, 'xai-api-key');
    }
    const { apiKey, keySource } = await resolveGrokApiKey(env, shopId, getSecret);
    return json({
      configured: Boolean(apiKey),
      keySource,
      removed: true,
      twilioVoiceWebhookUrl,
    });
  }

  throw new HttpError(405, 'Method not allowed');
}

// --- Durable Object Bridge: Twilio Media Stream <-> xAI Grok Realtime WebSocket ---

function safeCloseSocket(socket, code = 1000, reason = 'Session ended') {
  try {
    socket.close(code, String(reason).slice(0, 120));
  } catch {
    // Already closed
  }
}

export async function handleGrokTwilioBridge({
  request,
  env,
  state,
  shopId,
  callerPhone = '',
  callSid = '',
  apiKey = '',
  fetcher = fetch,
}) {
  const [shopSettings, pricing, callerContext, upstreamResponse] = await Promise.all([
    loadGrokShopSettings(env, shopId),
    loadShopPricing(env, shopId),
    callerPhone ? lookupCallerContext(env, shopId, callerPhone) : Promise.resolve(null),
    fetcher(GROK_REALTIME_URL.replace(/^wss:/, 'https:'), {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${apiKey}`,
      },
    }),
  ]);

  const upstream = upstreamResponse?.webSocket;
  if (!upstream || upstreamResponse.status !== 101) {
    throw new HttpError(502, 'Grok Realtime Voice API is unavailable');
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  upstream.accept();

  let streamSid = '';
  let currentCaller = callerPhone;
  let currentCallSid = callSid;
  let twilioInboundBytes = 0;
  let greetingSent = false;
  let finalized = false;
  const transcriptLines = [];

  const sessionUpdate = buildGrokSessionUpdate({
    shopSettings,
    pricing,
    callerPhone: currentCaller,
    callerContext,
  });
  upstream.send(JSON.stringify(sessionUpdate));

  const triggerInitialGreeting = () => {
    if (greetingSent) return;
    greetingSent = true;
    const greetingText = shopSettings.greeting
      || `Greet the caller warmly on behalf of ${shopSettings.shopName}, introduce yourself as Grok the shop's automated service advisor, and ask how you can help with their vehicle today.`;
    upstream.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[Phone call connected${currentCaller ? ` from ${currentCaller}` : ''}. ${greetingText}]` }],
      },
    }));
    upstream.send(JSON.stringify({ type: 'response.create' }));
  };

  const finalizeCall = async (reason) => {
    if (finalized) return;
    finalized = true;
    const voiceSeconds = twilioInboundBytes / TWILIO_SAMPLE_RATE;
    const costs = calculateVoiceCost(env, voiceSeconds);
    try {
      await recordAiUsage(env, {
        shopId,
        userId: 'grok-phone-receptionist',
        channel: 'voice',
        provider: 'xai',
        model: GROK_MODEL,
        voiceSeconds,
        ...costs,
        metadata: {
          reason,
          caller: currentCaller,
          callSid: currentCallSid,
          transcriptTurns: transcriptLines.length,
        },
      });
    } catch {
      // Best-effort usage logging
    }
  };

  // Twilio -> Grok
  server.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.event === 'start') {
      streamSid = String(msg.start?.streamSid || msg.streamSid || '');
      const custom = msg.start?.customParameters || {};
      if (custom.caller && !currentCaller) currentCaller = String(custom.caller);
      if (custom.callSid && !currentCallSid) currentCallSid = String(custom.callSid);
      triggerInitialGreeting();
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      const payload = String(msg.media.payload);
      twilioInboundBytes += Math.floor((payload.length * 3) / 4);
      const pcm24kBase64 = transcodeTwilioMulaw8kToGrokPcm24k(payload);
      if (pcm24kBase64 && upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm24kBase64,
        }));
      }
      return;
    }
    if (msg.event === 'stop') {
      safeCloseSocket(upstream, 1000, 'Twilio call ended');
      state?.waitUntil?.(finalizeCall('twilio_stop'));
    }
  });

  server.addEventListener('close', () => {
    safeCloseSocket(upstream, 1000, 'Twilio stream closed');
    state?.waitUntil?.(finalizeCall('twilio_closed'));
  });
  server.addEventListener('error', () => {
    safeCloseSocket(upstream, 1011, 'Twilio stream error');
    state?.waitUntil?.(finalizeCall('twilio_error'));
  });

  // Grok -> Twilio
  upstream.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'session.updated' && !greetingSent && streamSid) {
      triggerInitialGreeting();
    }

    // Barge-in: caller started speaking, immediately clear Twilio's playback buffer
    if (msg.type === 'input_audio_buffer.speech_started' && streamSid && server.readyState === WebSocket.OPEN) {
      server.send(JSON.stringify({ event: 'clear', streamSid }));
      return;
    }

    // Audio output from Grok -> transcode 24kHz PCM16 to 8kHz mu-law for Twilio
    if ((msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') && msg.delta) {
      const mulawBase64 = transcodeGrokPcm24kToTwilioMulaw8k(String(msg.delta));
      if (mulawBase64 && streamSid && server.readyState === WebSocket.OPEN) {
        server.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: mulawBase64 },
        }));
      }
      return;
    }

    if (msg.type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      transcriptLines.push({ role: 'caller', text: String(msg.transcript).trim() });
    }
    if (msg.type === 'response.output_audio_transcript.done' && msg.transcript) {
      transcriptLines.push({ role: 'grok', text: String(msg.transcript).trim() });
    }

    // Function tool calls from Grok during the phone call
    if (msg.type === 'response.function_call_arguments.done') {
      const toolName = String(msg.name || '');
      const callId = String(msg.call_id || '');
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(msg.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      try {
        const output = await executeGrokShopTool(env, shopId, toolName, parsedArgs, {
          callerPhone: currentCaller,
          callSid: currentCallSid,
        });
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
          }));
          upstream.send(JSON.stringify({ type: 'response.create' }));
        }
      } catch (err) {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ error: err instanceof Error ? err.message : 'Tool execution failed' }),
            },
          }));
          upstream.send(JSON.stringify({ type: 'response.create' }));
        }
      }
    }
  });

  upstream.addEventListener('close', () => {
    safeCloseSocket(server, 1000, 'Grok session ended');
    state?.waitUntil?.(finalizeCall('grok_closed'));
  });
  upstream.addEventListener('error', () => {
    safeCloseSocket(server, 1011, 'Grok session error');
    state?.waitUntil?.(finalizeCall('grok_error'));
  });

  return new Response(null, { status: 101, webSocket: client });
}
