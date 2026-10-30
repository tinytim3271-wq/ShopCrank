// Role-based access for the in-app Tech Assistant and the knowledge base. The
// assistant acts with the signed-in user's role and never more; every tool call
// and every knowledge lookup is checked here, server-side.

// Same role names the rest of ShopCrank uses (users.role, requireRole lists).
export const STAFF_ROLES = Object.freeze(['super_admin', 'owner', 'admin', 'office', 'service_writer', 'technician']);
// Accounting through the assistant: QuickBooks sync, invoices and payments,
// expenses, payroll, financial reports, labor-rate/pricing edits, and refunds.
export const ACCOUNTING_ROLES = Object.freeze(['super_admin', 'owner', 'admin']);

export const KNOWLEDGE_PERMISSIONS = Object.freeze(['customer_safe', 'staff', 'accounting']);

export function isStaffRole(role) {
  return STAFF_ROLES.includes(String(role || ''));
}

export function canUseAccounting(role) {
  return ACCOUNTING_ROLES.includes(String(role || ''));
}

export const ACCESS_DENIED_ACCOUNTING = 'Sorry, I can\'t help with that one. Accounting tasks like invoices, payments, refunds, payroll, expenses, QuickBooks, financial reports, and labor-rate or pricing changes are limited to shop admins. Please ask an admin or owner, and I\'m happy to help with anything else.';
export const ACCESS_DENIED_PERSONA = 'Sorry, that isn\'t something I can do here.';
export const ACCESS_DENIED_ROLE = 'Sorry, your account doesn\'t have access to the ShopCrank assistant.';

/** Knowledge permission tags a caller may retrieve. */
export function readableKnowledgePermissions({ persona, role }) {
  if (persona === 'front_desk') return ['customer_safe'];
  if (!isStaffRole(role)) return [];
  return canUseAccounting(role) ? ['customer_safe', 'staff', 'accounting'] : ['customer_safe', 'staff'];
}

/**
 * Permission tags a staff member may assign. Marking knowledge customer-safe
 * publishes it to the phone bot, so technicians can only create staff knowledge.
 */
export function assignableKnowledgePermissions(role) {
  if (!isStaffRole(role)) return [];
  if (canUseAccounting(role)) return [...KNOWLEDGE_PERMISSIONS];
  return role === 'technician' ? ['staff'] : ['customer_safe', 'staff'];
}

const ACCOUNTING_TEXT = [
  /\b(margin|markup|mark-up|wholesale|dealer\s+cost|our\s+cost|part\s+cost|cost\s+price|net\s+cost)\b/i,
  /\b(payroll|wages?|salar(y|ies)|commission|bonus(es)?|w-?2|1099|direct\s+deposit)\b/i,
  /\b(quickbooks|qbo|general\s+ledger|chart\s+of\s+accounts|accounts\s+(payable|receivable)|p\s*&\s*l|profit\s+and\s+loss|balance\s+sheet)\b/i,
  /\b(bank\s+account|routing\s+number|account\s+number|ein|tax\s+id|sales\s+tax\s+filing)\b/i,
  /\b(refund(s|ed)?|chargebacks?|merchant\s+fees?|stripe\s+payout)\b/i,
  /\b(expenses?|revenue|gross\s+profit|net\s+profit|cash\s+flow)\b/i,
];

/** True when text looks like it carries accounting data; such content is tagged accounting. */
export function containsAccountingData(text) {
  const value = String(text || '');
  return ACCOUNTING_TEXT.some(pattern => pattern.test(value));
}

/**
 * The tag knowledge is stored with: the requested tag if the creator may assign
 * it, raised to accounting when the content looks like accounting data.
 */
export function resolveKnowledgePermission({ role, requested = 'staff', text = '' }) {
  const allowed = assignableKnowledgePermissions(role);
  const wanted = KNOWLEDGE_PERMISSIONS.includes(requested) ? requested : 'staff';
  if (!allowed.includes(wanted)) return { permission: null, autoTagged: false };
  if (wanted !== 'accounting' && containsAccountingData(text)) return { permission: 'accounting', autoTagged: true };
  return { permission: wanted, autoTagged: false };
}

const ACCOUNTING_FIELD = /(cost|margin|markup|wholesale|payroll|wage|salary|commission|profit|vendorPrice|dealerPrice|netPrice|bank|routing|^ein$|taxId)/i;
const ACCOUNTING_TYPES = new Set(['invoices', 'payments', 'expenses', 'payroll', 'payrollentries', 'payrollruns', 'taxreports']);

/** Strip accounting-only fields from records shown to non-accounting roles. */
export function redactAccountingFields(value, role, depth = 0) {
  if (canUseAccounting(role) || depth > 8) return value;
  if (Array.isArray(value)) return value.map(item => redactAccountingFields(item, role, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (ACCOUNTING_FIELD.test(key)) continue;
    result[key] = redactAccountingFields(item, role, depth + 1);
  }
  return result;
}

export function isAccountingEntityType(type) {
  return ACCOUNTING_TYPES.has(String(type || '').trim().toLowerCase());
}
