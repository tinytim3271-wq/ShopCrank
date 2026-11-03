/**
 * Ratchet for src/runtime/legacy.js. Most regressions in this repo came from
 * layering one more `render = function () { … renderCore() }` override on top of
 * the last one, so a later fix silently undid an earlier one. New behaviour goes
 * in a module under src/modules/ with its own test, and legacy.js only calls it.
 *
 * These numbers may only go DOWN. When you remove overrides or move code out of
 * legacy.js, lower them in the same commit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const LEGACY = new URL('./legacy.js', import.meta.url);
const MAX_OVERRIDES = 129;
const MAX_BYTES = 816_000;
const MAX_OVERRIDES_PER_NAME = { bind: 17, settings: 10, render: 8, bindEstimateActions: 6, bindExpandedFeatures: 5 };

const source = readFileSync(LEGACY, 'utf8');
const overrides = [...source.matchAll(/^([A-Za-z_$][\w$]*) = (?:async )?function\b/gm)].map(match => match[1]);

test('legacy.js gets no new function overrides', () => {
  assert.ok(overrides.length <= MAX_OVERRIDES, `legacy.js has ${overrides.length} top-level "x = function" overrides (limit ${MAX_OVERRIDES}). Put the new behaviour in src/modules/ and call it from the existing function instead of wrapping it again.`);
  const counts = overrides.reduce((all, name) => ({ ...all, [name]: (all[name] || 0) + 1 }), {});
  for (const [name, limit] of Object.entries(MAX_OVERRIDES_PER_NAME)) {
    assert.ok((counts[name] || 0) <= limit, `${name} is wrapped ${counts[name]} times (limit ${limit})`);
  }
});

test('legacy.js does not grow', () => {
  const bytes = statSync(LEGACY).size;
  assert.ok(bytes <= MAX_BYTES, `legacy.js is ${bytes} bytes (limit ${MAX_BYTES}). Move new code into src/modules/.`);
});
