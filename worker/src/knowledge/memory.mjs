// Shop memory: facts staff tell the assistant plus patterns derived from past
// repair orders. Memories are knowledge items of kind "memory" so they share
// the same tenant and permission scoping as documents.

import { createKnowledgeItem, deleteKnowledgeBySource, MEMORY_CATEGORIES } from './store.mjs';
import { resolveKnowledgePermission } from '../assistant/rbac.mjs';

const DERIVED_SOURCE_ID = 'derived-repair-patterns';

const ISSUE_PATTERNS = [
  ['brakes', /\bbrake|rotor|caliper|pads?\b/i],
  ['oil service', /\boil\s*(change|leak|service)|synthetic/i],
  ['battery / charging', /\bbattery|alternator|charging/i],
  ['no start / starter', /\bno[\s-]*start|starter|crank/i],
  ['A/C', /\ba\/c|air\s*condition|ac\s+blow|refrigerant/i],
  ['check engine / misfire', /\bcheck\s*engine|misfire|\bp0\d{3}\b|\bcel\b/i],
  ['cooling system', /\bcoolant|overheat|radiator|water\s*pump|thermostat/i],
  ['transmission', /\btransmission|shift|slipping|cvt/i],
  ['suspension / steering', /\bsuspension|strut|shock|tie\s*rod|ball\s*joint|steering|alignment/i],
  ['tires', /\btires?\b|flat|tpms/i],
  ['electrical', /\belectrical|wiring|fuse|short/i],
];

export function vehicleKey(description) {
  const words = String(description || '').replace(/\s+/g, ' ').trim().split(' ');
  const yearIndex = words.findIndex(word => /^(19|20)\d{2}$/.test(word));
  const rest = yearIndex >= 0 ? words.slice(yearIndex + 1) : words;
  const [make, model] = rest;
  if (!make || !model) return '';
  return `${make[0].toUpperCase()}${make.slice(1).toLowerCase()} ${model}`.replace(/[^\w\s-]/g, '');
}

export function classifyIssues(text) {
  return ISSUE_PATTERNS.filter(([, pattern]) => pattern.test(String(text || ''))).map(([label]) => label);
}

function lineSupplier(line) {
  return String(line?.supplier || line?.vendor || line?.partstech?.supplierName || line?.partstech?.supplier || '').trim();
}

/** Common issues by vehicle and preferred suppliers, from this shop's repair orders. */
export function summarizeRepairPatterns(orders = [], { minCount = 2 } = {}) {
  const byVehicle = new Map();
  const suppliers = new Map();
  for (const order of orders) {
    const key = vehicleKey(order?.vehicle);
    if (key) {
      const issues = classifyIssues(`${order.complaint || ''} ${(order.estimate?.lines || []).map(line => line.description || line.service || '').join(' ')}`);
      if (!byVehicle.has(key)) byVehicle.set(key, new Map());
      for (const issue of issues) byVehicle.get(key).set(issue, (byVehicle.get(key).get(issue) || 0) + 1);
    }
    for (const line of order?.estimate?.lines || []) {
      const supplier = lineSupplier(line);
      if (supplier) suppliers.set(supplier, (suppliers.get(supplier) || 0) + 1);
    }
  }
  const vehiclePatterns = [...byVehicle.entries()].map(([vehicle, issues]) => ({
    vehicle,
    issues: [...issues.entries()].filter(([, count]) => count >= minCount).sort((a, b) => b[1] - a[1]),
  })).filter(item => item.issues.length);
  const supplierRanking = [...suppliers.entries()].filter(([, count]) => count >= minCount).sort((a, b) => b[1] - a[1]);
  return { vehiclePatterns, supplierRanking };
}

export async function saveMemory(env, { shopId, role, userId, content, category = 'fact', vehicle = '', permission = 'staff', source = 'staff' }) {
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) return { error: 'Tell me the fact to remember.' };
  const resolved = resolveKnowledgePermission({ role, requested: permission, text });
  if (!resolved.permission) return { error: 'You can only save staff memories with your role.' };
  const item = await createKnowledgeItem(env, {
    shopId,
    kind: 'memory',
    title: text.slice(0, 80),
    body: text,
    permission: resolved.permission,
    sourceType: source,
    metadata: {
      category: MEMORY_CATEGORIES.includes(category) ? category : 'fact',
      vehicle: String(vehicle || '').slice(0, 80),
      ...(resolved.autoTagged ? { autoTagged: true } : {}),
    },
    createdBy: userId,
    createdRole: role,
  });
  return { saved: true, id: item.id, permission: item.permission, autoTagged: resolved.autoTagged };
}

/** Replace previously derived memories with a fresh summary. Patterns carry no prices. */
export async function deriveRepairPatternMemories(env, { shopId, orders, actor = 'system' }) {
  await deleteKnowledgeBySource(env, shopId, DERIVED_SOURCE_ID);
  const { vehiclePatterns, supplierRanking } = summarizeRepairPatterns(orders);
  const created = [];
  for (const pattern of vehiclePatterns.slice(0, 60)) {
    const body = `Common issues on ${pattern.vehicle} at this shop: ${pattern.issues.map(([issue, count]) => `${issue} (${count} repair orders)`).join(', ')}.`;
    created.push(await createKnowledgeItem(env, {
      shopId,
      kind: 'memory',
      title: `${pattern.vehicle}: common issues`,
      body,
      permission: 'staff',
      sourceType: 'derived',
      sourceId: DERIVED_SOURCE_ID,
      metadata: { category: 'repair_pattern', vehicle: pattern.vehicle },
      createdBy: actor,
      createdRole: 'system',
    }));
  }
  if (supplierRanking.length) {
    created.push(await createKnowledgeItem(env, {
      shopId,
      kind: 'memory',
      title: 'Most-used parts suppliers',
      body: `Suppliers used most on repair orders: ${supplierRanking.slice(0, 10).map(([name, count]) => `${name} (${count} lines)`).join(', ')}.`,
      permission: 'staff',
      sourceType: 'derived',
      sourceId: DERIVED_SOURCE_ID,
      metadata: { category: 'supplier' },
      createdBy: actor,
      createdRole: 'system',
    }));
  }
  return created.map(item => ({ id: item.id, title: item.title }));
}
