// Redaction helpers for anything the Worker persists or logs.

// Secret-bearing keys, redacted from persisted audit events.
const SENSITIVE_KEYS = new Set([
  'pin', 'token', 'securitytoken', 'password', 'credential', 'secret',
  'seed', 'authorizationtoken', 'capabilitytoken', 'privatekey',
]);

// Personal data that assistant tools receive (caller names, phones, addresses).
const PERSONAL_KEYS = new Set([
  'name', 'firstname', 'lastname', 'fullname', 'customer', 'customername',
  'phone', 'callerphone', 'mobile', 'email', 'address', 'street',
  'message', 'dob', 'birthdate', 'ssn', 'driverslicense', 'plate', 'vin',
]);

const SECRETISH_KEY = /(api[-_]?key|secret|token|password|authorization|cookie)/i;
const EMAIL_IN_TEXT = /[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/gi;
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{8,}\d/g;
const MAX_LOGGED_STRING = 200;

/** Recursively redact secret-bearing fields before persisting audit events. */
export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(item),
    ]));
  }
  return value;
}

function maskText(text) {
  const masked = text.replace(EMAIL_IN_TEXT, '[EMAIL]').replace(PHONE_IN_TEXT, '[PHONE]');
  return masked.length > MAX_LOGGED_STRING ? `${masked.slice(0, MAX_LOGGED_STRING)}…` : masked;
}

/**
 * Tool input safe to write to logs: secrets and personal fields become
 * [REDACTED], emails and phone numbers inside free text are masked, and long
 * strings are cut so a log line never carries a whole transcript.
 */
export function redactToolInput(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactToolInput(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lower) || SECRETISH_KEY.test(key)) return [key, '[REDACTED]'];
      if (PERSONAL_KEYS.has(lower)) return [key, item === '' || item == null ? item : '[REDACTED]'];
      return [key, redactToolInput(item, depth + 1)];
    }));
  }
  return value;
}

/** Full error detail for logs: name, message, code/status, stack and cause. */
export function serializeError(error, depth = 0) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: maskText(error.message || ''),
    ...(error.code ? { code: String(error.code) } : {}),
    ...(error.status ? { status: Number(error.status) } : {}),
    ...(error.stack ? {
      stack: String(error.stack).split('\n').slice(0, 12).join('\n')
        .replace(EMAIL_IN_TEXT, '[EMAIL]').replace(PHONE_IN_TEXT, '[PHONE]'),
    } : {}),
    ...(error.cause && depth < 2 ? { cause: serializeError(error.cause, depth + 1) } : {}),
  };
}
