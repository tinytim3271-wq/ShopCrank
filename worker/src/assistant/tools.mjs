// Assistant tool registry and the single server-side gate every tool call passes:
// persona allowlist first (front_desk never reaches tech tools), then the
// signed-in user's role (accounting tools need an accounting role).

import {
  GROK_SHOP_TOOLS,
  calculateGrokServiceEstimate,
  executeGrokShopTool,
  loadGrokShopSettings,
} from '../grok-voice.mjs';
import {
  ANTHROPIC_TOOLS,
  executeAdvancedShopSearch,
  executeGroundingTool,
  loadShopPricing,
  prepareEstimateWorkOrderDraft,
} from '../ai.mjs';
import { searchLicensedLabor } from '../integrations/labor.mjs';
import {
  ACCESS_DENIED_ACCOUNTING,
  ACCESS_DENIED_PERSONA,
  ACCESS_DENIED_ROLE,
  canUseAccounting,
  isAccountingEntityType,
  isStaffRole,
  readableKnowledgePermissions,
  redactAccountingFields,
} from './rbac.mjs';
import {
  PERSONAS,
  buildFrontDeskInstructions,
  buildTechAssistantInstructions,
} from './personas.mjs';
import { citationsFrom, searchKnowledge } from '../knowledge/store.mjs';
import { saveMemory } from '../knowledge/memory.mjs';
import { getShopSetting, putShopEntity } from '../shop-settings-store.mjs';
import { normalizeQuestionnaireAnswers, formatWeeklyHours } from '../../../src/modules/front-desk-questionnaire.js';

const fromGrok = name => {
  const tool = GROK_SHOP_TOOLS.find(item => item.name === name);
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
};
const fromAnthropic = name => {
  const tool = ANTHROPIC_TOOLS.find(item => item.name === name);
  return { name: tool.name, description: tool.description, parameters: tool.input_schema };
};
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });

const TECH_TOOLS = [
  fromGrok('get_shop_info'),
  fromGrok('lookup_customer_and_vehicles'),
  fromGrok('calculate_service_estimate'),
  fromGrok('save_call_intake_and_estimate'),
  fromAnthropic('lookup_job'),
  fromAnthropic('lookup_estimate'),
  fromAnthropic('lookup_customer'),
  fromAnthropic('lookup_parts'),
  fromAnthropic('search_shop_records'),
  fromAnthropic('prepare_estimate_work_order'),
  {
    name: 'lookup_labor_time',
    description: 'Look up labor hours for an operation on a vehicle from the licensed labor guide, falling back to the ShopCrank service guide.',
    parameters: object({
      operation: str('Repair operation, e.g. "front brake pads and rotors".'),
      vehicle: object({ year: { type: 'string' }, make: { type: 'string' }, model: { type: 'string' }, vin: { type: 'string' } }),
    }, ['operation']),
  },
  {
    name: 'lookup_dtc',
    description: 'Find shop history for an OBD-II trouble code: past diagnostic sessions and repair orders that mention it, plus shop knowledge.',
    parameters: object({ code: str('OBD-II code such as P0301.') }, ['code']),
  },
  {
    name: 'search_shop_knowledge',
    description: 'Search this shop\'s knowledge base (procedures, notes, FAQs, uploaded documents, reference websites, and saved memories). Cite results as [KB-n].',
    parameters: object({ query: str('What to look for.') }, ['query']),
  },
  {
    name: 'remember_shop_fact',
    description: 'Save a lasting fact about this shop that staff told you: a preference, preferred supplier, or a common issue on a vehicle.',
    parameters: object({
      fact: str('The fact in one or two sentences.'),
      category: { type: 'string', enum: ['fact', 'preference', 'supplier', 'vehicle_issue'] },
      vehicle: str('Vehicle the fact applies to, if any.'),
    }, ['fact']),
  },
];

const ACCOUNTING_TOOLS = [
  fromAnthropic('lookup_invoice'),
  {
    name: 'list_invoices_and_payments',
    description: 'List invoices and payments for the shop (accounting).',
    parameters: object({ query: str('Customer, invoice number, or status.'), limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  },
  {
    name: 'get_financial_report',
    description: 'Summarize invoiced, collected, and outstanding totals for a date range (accounting).',
    parameters: object({ from: str('Start date YYYY-MM-DD.'), to: str('End date YYYY-MM-DD.') }),
  },
  {
    name: 'list_expenses',
    description: 'List recorded shop expenses for a date range (accounting).',
    parameters: object({ from: str('Start date YYYY-MM-DD.'), to: str('End date YYYY-MM-DD.') }),
  },
  {
    name: 'get_payroll_summary',
    description: 'Summarize payroll records (accounting).',
    parameters: object({ period: str('Pay period, e.g. 2026-10.') }),
  },
  {
    name: 'request_quickbooks_sync',
    description: 'Prepare a QuickBooks Online sync of customers, invoices, or payments for the admin to confirm (accounting).',
    parameters: object({ entity: { type: 'string', enum: ['customers', 'invoices', 'payments'] } }, ['entity']),
  },
  {
    name: 'prepare_refund',
    description: 'Prepare a refund on an invoice for the admin to confirm (accounting).',
    parameters: object({ invoiceNumber: str('Invoice number.'), amount: { type: 'number', minimum: 0 }, reason: str('Reason.') }, ['invoiceNumber', 'amount']),
  },
  {
    name: 'prepare_pricing_change',
    description: 'Prepare a labor-rate or pricing change for the admin to confirm (accounting).',
    parameters: object({ laborRate: { type: 'number', minimum: 0 }, note: str('What else changes.') }),
  },
];

const FRONT_DESK_TOOLS = [
  {
    name: 'get_shop_hours_and_directions',
    description: 'Get the shop\'s customer-facing details: hours, holiday hours, address, directions, parking, contact info, services offered and not offered, vehicles serviced, payment, warranty, and booking policies.',
    parameters: object({}),
  },
  {
    name: 'answer_pricing_question',
    description: 'Look up the shop\'s published price rules for a service. Returns only published prices and the approved wording.',
    parameters: object({ service: str('The service the caller asked about.') }, ['service']),
  },
  {
    name: 'search_customer_faq',
    description: 'Search the shop\'s customer-safe FAQs and policies.',
    parameters: object({ query: str('The caller\'s question.') }, ['query']),
  },
  {
    name: 'check_my_vehicle_status',
    description: 'Check the status of the caller\'s own vehicle, matched by caller ID. Returns only status and promised time.',
    parameters: object({ lastName: str('Caller\'s last name, if the shop requires it for verification.') }),
  },
  {
    name: 'request_appointment',
    description: 'Record an appointment request for staff to confirm.',
    parameters: object({
      name: str('Caller name.'),
      phone: str('Callback number if different from caller ID.'),
      vehicle: str('Year, make, model.'),
      concern: str('What the caller needs done.'),
      preferredTime: str('Preferred day or time.'),
    }, ['name', 'vehicle', 'concern']),
  },
  {
    name: 'take_message',
    description: 'Take a message for a staff callback.',
    parameters: object({ name: str('Caller name.'), phone: str('Callback number.'), message: str('The message.') }, ['name', 'message']),
  },
  {
    name: 'save_caller_intake',
    description: 'Save the caller\'s name, vehicle, and concern so staff have the intake ready.',
    parameters: fromGrok('save_call_intake_and_estimate').parameters,
  },
  {
    name: 'transfer_to_staff',
    description: 'Transfer the caller to shop staff right away. Use when the caller asks for a person, manager, or owner, or is upset.',
    parameters: object({ reason: str('Why the caller is being transferred.') }),
  },
];

const TECH_TOOL_NAMES = new Set(TECH_TOOLS.map(tool => tool.name));
const ACCOUNTING_TOOL_NAMES = new Set(ACCOUNTING_TOOLS.map(tool => tool.name));
const FRONT_DESK_TOOL_NAMES = new Set(FRONT_DESK_TOOLS.map(tool => tool.name));

export const PERSONA_TOOL_NAMES = Object.freeze({
  [PERSONAS.TECH]: Object.freeze([...TECH_TOOL_NAMES, ...ACCOUNTING_TOOL_NAMES]),
  [PERSONAS.FRONT_DESK]: Object.freeze([...FRONT_DESK_TOOL_NAMES]),
});
export const ACCOUNTING_TOOL_LIST = Object.freeze([...ACCOUNTING_TOOL_NAMES]);

/**
 * Server-side authorization for one tool call. Independent of what the model
 * was shown, so prompt injection or a forged client request cannot widen it.
 */
export function authorizeAssistantTool({ persona, role, name }) {
  if (persona === PERSONAS.FRONT_DESK) {
    return FRONT_DESK_TOOL_NAMES.has(name)
      ? { allowed: true }
      : { allowed: false, code: 'persona_denied', message: ACCESS_DENIED_PERSONA };
  }
  if (persona !== PERSONAS.TECH) return { allowed: false, code: 'persona_denied', message: ACCESS_DENIED_PERSONA };
  if (!isStaffRole(role)) return { allowed: false, code: 'role_denied', message: ACCESS_DENIED_ROLE };
  if (ACCOUNTING_TOOL_NAMES.has(name)) {
    return canUseAccounting(role)
      ? { allowed: true, accounting: true }
      : { allowed: false, code: 'accounting_denied', message: ACCESS_DENIED_ACCOUNTING };
  }
  if (TECH_TOOL_NAMES.has(name)) return { allowed: true };
  return { allowed: false, code: 'unknown_tool', message: ACCESS_DENIED_PERSONA };
}

/** Tools shown to the model for a persona and role (a subset of what authorize allows). */
export function toolsFor(persona, role, format = 'grok') {
  const list = persona === PERSONAS.FRONT_DESK
    ? FRONT_DESK_TOOLS
    : [...TECH_TOOLS, ...(canUseAccounting(role) ? ACCOUNTING_TOOLS : [])];
  if (format === 'anthropic') return list.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  return list.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
}

async function loadFrontDeskAnswers(env, shopId) {
  const setting = await getShopSetting(env, shopId, 'front_desk_questionnaire').catch(() => null);
  return normalizeQuestionnaireAnswers(setting?.answers || {});
}

export async function loadFrontDeskPersona(env, shopId) {
  return getShopSetting(env, shopId, 'front_desk_persona').catch(() => null);
}

export async function loadTechAssistantProfile(env, shopId) {
  return getShopSetting(env, shopId, 'tech_assistant_persona').catch(() => null);
}

/** Session instructions and tools for one surface. */
export async function buildPersonaSession(env, { persona, shopId, role = '', callerPhone = '' }) {
  const [shopSettings, pricing] = await Promise.all([loadGrokShopSettings(env, shopId), loadShopPricing(env, shopId)]);
  if (persona === PERSONAS.FRONT_DESK) {
    const frontDeskPersona = await loadFrontDeskPersona(env, shopId);
    return {
      persona,
      shopSettings,
      frontDeskPersona,
      voice: frontDeskPersona?.voice || shopSettings.voice,
      instructions: buildFrontDeskInstructions({ shopSettings, callerPhone, frontDeskPersona }),
      tools: toolsFor(PERSONAS.FRONT_DESK, '', 'grok'),
    };
  }
  const techProfile = await loadTechAssistantProfile(env, shopId);
  return {
    persona: PERSONAS.TECH,
    shopSettings,
    voice: shopSettings.voice,
    instructions: buildTechAssistantInstructions({ shopSettings, pricing, role, techProfile }),
    tools: toolsFor(PERSONAS.TECH, role, 'grok'),
  };
}

function digits10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

async function listEntitiesDirect(env, shopId, type, limit = 200) {
  if (!env?.DB) return [];
  const result = await env.DB.prepare(
    'SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = ? ORDER BY updated_at DESC LIMIT ?',
  ).bind(shopId, type, limit).all();
  return (result.results || []).map(row => {
    try {
      return JSON.parse(row.data_json);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function inRange(dateValue, from, to) {
  const date = String(dateValue || '').slice(0, 10);
  if (!date) return !from && !to;
  return (!from || date >= from) && (!to || date <= to);
}

async function runTechTool(env, { shopId, role, userId, name, args, callerPhone, callSid }) {
  switch (name) {
    case 'get_shop_info':
    case 'lookup_customer_and_vehicles':
    case 'calculate_service_estimate':
    case 'save_call_intake_and_estimate':
      return redactAccountingFields(await executeGrokShopTool(env, shopId, name, args, { callerPhone, callSid }), role);
    case 'prepare_estimate_work_order':
      return prepareEstimateWorkOrderDraft(args, await loadShopPricing(env, shopId));
    case 'search_shop_records': {
      const types = canUseAccounting(role) ? args.types : (Array.isArray(args.types) && args.types.length ? args.types : ['orders', 'estimates', 'customers', 'vehicles', 'appointments', 'inventory'])
        .filter(type => !isAccountingEntityType(type));
      if (Array.isArray(types) && !types.length) return { query: args.query, count: 0, records: [], readOnly: true };
      return redactAccountingFields(await executeAdvancedShopSearch(env, shopId, { ...args, types }), role);
    }
    case 'lookup_job':
    case 'lookup_estimate':
    case 'lookup_customer':
    case 'lookup_parts':
    case 'lookup_invoice':
      return redactAccountingFields(await executeGroundingTool(env, shopId, name, args), role);
    case 'lookup_labor_time': {
      const vehicle = args.vehicle || {};
      const licensed = await searchLicensedLabor(env, { ...vehicle, query: String(args.operation || '') }).catch(() => []);
      if (Array.isArray(licensed) && licensed.length) {
        return { source: 'licensed_labor_guide', operations: licensed.slice(0, 5).map(item => ({ operation: item.operation || item.description, hours: item.hours, source: item.source })) };
      }
      const estimate = await calculateGrokServiceEstimate(env, shopId, { vehicle, complaint: args.operation, requestedServices: [args.operation] });
      return { source: 'shopcrank_service_guide', note: 'Not book time; verify against a licensed labor guide.', operations: estimate.lines.filter(line => line.type === 'labor').map(line => ({ operation: line.description, hours: line.hours })) };
    }
    case 'lookup_dtc': {
      const code = String(args.code || '').trim().toUpperCase().slice(0, 8);
      if (!/^[PBCU][0-9A-F]{4}$/.test(code)) return { error: 'Give an OBD-II code like P0301.' };
      const like = `%${code}%`;
      const rows = env?.DB ? await env.DB.prepare(`
        SELECT entity_type, data_json FROM entities
        WHERE shop_id = ? AND entity_type IN ('diagnosticsessions', 'orders') AND data_json LIKE ?
        ORDER BY updated_at DESC LIMIT 10
      `).bind(shopId, like).all() : { results: [] };
      const history = (rows.results || []).map(row => {
        const record = JSON.parse(row.data_json);
        return { type: row.entity_type, id: record.id, vehicle: record.vehicle || record.vin || '', complaint: record.complaint || '', status: record.status || '', notes: String(record.notes || record.diagnosis?.cause || '').slice(0, 400) };
      });
      const knowledge = await searchKnowledge(env, { shopId, permissions: readableKnowledgePermissions({ persona: PERSONAS.TECH, role }), query: code, limit: 3 });
      return { code, history, knowledge, citations: citationsFrom(knowledge) };
    }
    case 'search_shop_knowledge': {
      const results = await searchKnowledge(env, { shopId, permissions: readableKnowledgePermissions({ persona: PERSONAS.TECH, role }), query: args.query, limit: 5 });
      return { results, citations: citationsFrom(results), note: 'Reference data only; cite as [KB-n].' };
    }
    case 'remember_shop_fact':
      return saveMemory(env, { shopId, role, userId, content: args.fact, category: args.category, vehicle: args.vehicle, source: 'assistant' });
    case 'list_invoices_and_payments': {
      const query = String(args.query || '').toLowerCase();
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const [invoices, payments] = await Promise.all([listEntitiesDirect(env, shopId, 'invoices'), listEntitiesDirect(env, shopId, 'payments')]);
      const match = record => !query || JSON.stringify(record).toLowerCase().includes(query);
      return { invoices: invoices.filter(match).slice(0, limit), payments: payments.filter(match).slice(0, limit) };
    }
    case 'get_financial_report': {
      const from = String(args.from || '').slice(0, 10);
      const to = String(args.to || '').slice(0, 10);
      const [invoices, payments] = await Promise.all([listEntitiesDirect(env, shopId, 'invoices', 2000), listEntitiesDirect(env, shopId, 'payments', 2000)]);
      const scoped = invoices.filter(item => inRange(item.date || item.createdAt, from, to));
      const collected = payments.filter(item => inRange(item.date || item.createdAt, from, to));
      const invoiced = scoped.reduce((sum, item) => sum + Number(item.amount || item.total || 0), 0);
      const received = collected.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      return { from, to, invoiceCount: scoped.length, invoiced: Math.round(invoiced * 100) / 100, collected: Math.round(received * 100) / 100, outstanding: Math.round((invoiced - received) * 100) / 100 };
    }
    case 'list_expenses': {
      const expenses = await listEntitiesDirect(env, shopId, 'expenses', 500);
      return { expenses: expenses.filter(item => inRange(item.date || item.createdAt, args.from, args.to)).slice(0, 50) };
    }
    case 'get_payroll_summary': {
      const records = await listEntitiesDirect(env, shopId, 'payroll', 500);
      const period = String(args.period || '');
      return { period, records: records.filter(item => !period || JSON.stringify(item).includes(period)).slice(0, 50) };
    }
    case 'request_quickbooks_sync':
      return { kind: 'quickbooks_sync_request', entity: args.entity, requiresUserReview: true, saved: false, message: `Ready to sync ${args.entity} to QuickBooks. Confirm it under Integrations → QuickBooks.` };
    case 'prepare_refund':
      return { kind: 'refund_draft', invoiceNumber: String(args.invoiceNumber || ''), amount: Number(args.amount) || 0, reason: String(args.reason || ''), requiresUserReview: true, saved: false };
    case 'prepare_pricing_change':
      return { kind: 'pricing_change_draft', laborRate: Number.isFinite(Number(args.laborRate)) ? Number(args.laborRate) : null, note: String(args.note || ''), requiresUserReview: true, saved: false };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

async function runFrontDeskTool(env, { shopId, name, args, callerPhone, callSid }) {
  const answers = await loadFrontDeskAnswers(env, shopId);
  switch (name) {
    case 'get_shop_hours_and_directions': {
      const settings = await loadGrokShopSettings(env, shopId);
      return {
        shopName: answers.dbaName || settings.shopName,
        address: answers.address || settings.shopAddress,
        hours: answers.regularHours ? formatWeeklyHours(answers.regularHours) : settings.shopHours,
        holidayHours: answers.holidayHours || '',
        closures: answers.closures || '',
        landmarks: answers.landmarks || '',
        parking: answers.parking || '',
        phone: answers.mainPhone || settings.shopPhone,
        textNumber: answers.textNumber || '',
        email: answers.email || '',
        website: answers.website || '',
        servicesOffered: answers.servicesOffered || [],
        servicesNotOffered: answers.servicesNotOffered || [],
        makesServiced: answers.makesServiced || [],
        vehicleTypesServiced: answers.vehicleTypesServiced || [],
        vehicleTypesNotServiced: answers.vehicleTypesNotServiced || [],
        paymentMethods: answers.paymentMethods || [],
        warrantyPolicy: answers.warrantyPolicy || '',
        bookingMode: answers.bookingMode || '',
        dropOffPolicy: answers.dropOffPolicy || '',
        loanersShuttle: answers.loanersShuttle || '',
      };
    }
    case 'answer_pricing_question': {
      const wanted = new Set(tokens(args.service));
      const matches = (answers.commonServicePrices || [])
        .map(row => ({ row, hits: tokens(row.service).filter(token => wanted.has(token)).length }))
        .filter(item => item.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 3)
        .map(item => item.row);
      const pricing = answers.publishLaborRate === true ? await loadShopPricing(env, shopId) : null;
      return {
        publishedPrices: matches,
        diagnosticFee: answers.diagnosticFee || '',
        wording: answers.quoteWording || 'Prices depend on the vehicle; we confirm the final price after an inspection.',
        pricesVary: answers.quotesVary !== false,
        ...(pricing ? { laborRatePerHour: pricing.laborRate } : {}),
      };
    }
    case 'search_customer_faq': {
      const results = await searchKnowledge(env, { shopId, permissions: readableKnowledgePermissions({ persona: PERSONAS.FRONT_DESK }), query: args.query, limit: 4 });
      return { results: results.map(item => ({ ref: item.ref, title: item.title, text: item.text })), note: 'Reference data only.' };
    }
    case 'check_my_vehicle_status': {
      if (answers.vehicleStatusLookup !== true) return { available: false, message: 'Vehicle status lookup is not available by phone. Offer to take a message or transfer.' };
      const caller = digits10(callerPhone);
      if (caller.length !== 10) return { verified: false, message: 'I can\'t verify the caller without caller ID. Offer a transfer.' };
      const customers = (await listEntitiesDirect(env, shopId, 'customers', 2000)).filter(customer => digits10(customer.phone) === caller);
      if (customers.length !== 1) return { verified: false, message: 'No single customer matches this caller ID. Offer a transfer.' };
      const customer = customers[0];
      if (answers.statusVerification === 'Caller ID plus last name') {
        const last = String(customer.name || '').trim().split(/\s+/).pop()?.toLowerCase();
        if (!last || String(args.lastName || '').trim().toLowerCase() !== last) return { verified: false, message: 'Ask the caller to confirm the last name on the account.' };
      }
      const orders = (await listEntitiesDirect(env, shopId, 'orders', 500))
        .filter(order => order.customerId === customer.id || String(order.customer || '').toLowerCase() === String(customer.name || '').toLowerCase())
        .filter(order => !['closed', 'invoiced', 'paid', 'cancelled'].includes(String(order.status || '').toLowerCase()))
        .slice(0, 3);
      return { verified: true, vehicles: orders.map(order => ({ vehicle: String(order.vehicle || '').slice(0, 80), status: order.status || 'in progress', promisedTime: order.promise || '' })) };
    }
    case 'request_appointment': {
      const id = `appt-fd-${Date.now()}`;
      await putShopEntity(env, shopId, 'appointments', id, {
        customer: String(args.name || '').slice(0, 120),
        phone: String(args.phone || callerPhone || '').slice(0, 40),
        vehicle: String(args.vehicle || '').slice(0, 160),
        service: String(args.concern || '').slice(0, 500),
        requestedTime: String(args.preferredTime || '').slice(0, 120),
        status: 'requested',
        source: 'front_desk_phone',
        callSid: callSid || null,
      }, 'front-desk-phone');
      return { requested: true, reference: id, message: 'Appointment request recorded; staff will confirm the time.' };
    }
    case 'take_message': {
      const id = `callback-${Date.now()}`;
      await putShopEntity(env, shopId, 'callbackrequests', id, {
        name: String(args.name || '').slice(0, 120),
        phone: String(args.phone || callerPhone || '').slice(0, 40),
        message: String(args.message || '').slice(0, 1000),
        status: 'new',
        source: 'front_desk_phone',
        callSid: callSid || null,
      }, 'front-desk-phone');
      return { saved: true, message: 'Message saved for a staff callback.' };
    }
    case 'save_caller_intake': {
      const result = await executeGrokShopTool(env, shopId, 'save_call_intake_and_estimate', args, { callerPhone, callSid });
      return { saved: Boolean(result?.saved), reference: result?.orderId || '', message: 'Intake saved for staff.' };
    }
    case 'transfer_to_staff':
      return { transfer: true, reason: String(args.reason || 'caller request').slice(0, 200), message: 'Transferring the caller now.' };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/** Run one assistant tool after authorization; denials return a polite refusal. */
export async function executeAssistantTool(env, { shopId, persona, role = '', userId = '', name, args = {}, callerPhone = '', callSid = '' }) {
  const decision = authorizeAssistantTool({ persona, role, name });
  if (!decision.allowed) {
    console.warn(JSON.stringify({ message: 'assistant tool denied', shopId, persona, role, tool: name, code: decision.code }));
    return { error: 'access_denied', denied: true, code: decision.code, message: decision.message };
  }
  const safeArgs = args && typeof args === 'object' ? args : {};
  if (persona === PERSONAS.FRONT_DESK) return runFrontDeskTool(env, { shopId, name, args: safeArgs, callerPhone, callSid });
  return runTechTool(env, { shopId, role, userId, name, args: safeArgs, callerPhone, callSid });
}
