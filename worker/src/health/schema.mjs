// Small JSON-Schema subset validator for tool output contracts: type (string or
// list), properties, required, items, enum, anyOf, additionalProperties: false.
// Returns drift issues instead of throwing so callers can log and keep going.

import { ERROR_ENVELOPE, TOOL_CONTRACTS, TOOL_CONTRACTS_VERSION } from './tool-contracts.mjs';

const MAX_ISSUES = 20;
const MAX_ITEMS_CHECKED = 25;

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected, actual) {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

function check(schema, value, path, issues) {
  if (issues.length >= MAX_ISSUES || !schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.anyOf)) {
    const attempts = schema.anyOf.map(option => {
      const found = [];
      check(option, value, path, found);
      return found;
    });
    if (attempts.some(found => !found.length)) return;
    // Report the closest option so the message points at the real difference.
    issues.push(...attempts.reduce((best, found) => (found.length < best.length ? found : best)).slice(0, MAX_ISSUES - issues.length));
    return;
  }
  const actual = typeOf(value);
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some(type => typeMatches(type, actual))) {
      issues.push({ path, problem: 'type', expected: expected.join('|'), actual });
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ path, problem: 'enum', expected: schema.enum.map(String).join('|'), actual: String(value).slice(0, 60) });
  }
  if (actual === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value) || value[key] === undefined) issues.push({ path: `${path}.${key}`, problem: 'missing', expected: describe(schema.properties?.[key]), actual: 'undefined' });
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) check(child, value[key], `${path}.${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) issues.push({ path: `${path}.${key}`, problem: 'unexpected', expected: 'absent', actual: typeOf(value[key]) });
      }
    }
  }
  if (actual === 'array' && schema.items) {
    value.slice(0, MAX_ITEMS_CHECKED).forEach((item, index) => check(schema.items, item, `${path}[${index}]`, issues));
  }
}

function describe(schema) {
  if (!schema) return 'any';
  if (schema.anyOf) return 'anyOf';
  const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
  return type || 'any';
}

/** Drift issues for `value` against `schema` ([] when it matches). */
export function validateShape(schema, value) {
  const issues = [];
  check(schema, value, '$', issues);
  return issues;
}

/**
 * Compare one tool result with its contract. `kind` is "ok", "error" (the tool
 * returned the documented { error } envelope), "drift", or "uncontracted".
 */
export function checkToolOutput(name, result) {
  const contract = TOOL_CONTRACTS[name];
  if (!contract) return { kind: 'uncontracted', version: TOOL_CONTRACTS_VERSION, issues: [{ path: '$', problem: 'no_contract', expected: 'contract', actual: name }] };
  const issues = validateShape(contract.returns, result);
  if (!issues.length) return { kind: 'ok', version: TOOL_CONTRACTS_VERSION, issues };
  if (!validateShape(ERROR_ENVELOPE, result).length) return { kind: 'error', version: TOOL_CONTRACTS_VERSION, issues: [] };
  return { kind: 'drift', version: TOOL_CONTRACTS_VERSION, issues };
}
