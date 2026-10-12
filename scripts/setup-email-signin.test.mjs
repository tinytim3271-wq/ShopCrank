#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { SetupError, parseArgs, validateWebhookUrl } from './setup-email-signin.mjs';

test('parseArgs enables supported flags', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--local']), {
    dryRun: true,
    help: false,
    local: true,
  });
  assert.deepEqual(parseArgs(['--help']), {
    dryRun: false,
    help: true,
    local: false,
  });
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(
    () => parseArgs(['--mystery']),
    (error) => error instanceof SetupError && /Unknown option: --mystery/.test(error.message),
  );
});

test('validateWebhookUrl accepts https webhooks', () => {
  assert.equal(
    validateWebhookUrl('https://mailer.example.com/shopcrank-login'),
    'https://mailer.example.com/shopcrank-login',
  );
});

test('validateWebhookUrl rejects insecure http urls by default', () => {
  assert.throws(
    () => validateWebhookUrl('http://mailer.example.com/shopcrank-login'),
    (error) => error instanceof SetupError && /HTTPS webhook URL/.test(error.message),
  );
});

test('validateWebhookUrl allows localhost http only with --local behavior', () => {
  assert.equal(
    validateWebhookUrl('http://localhost:8787/email', { allowLocal: true }),
    'http://localhost:8787/email',
  );
  assert.equal(
    validateWebhookUrl('http://127.0.0.1:8787/email', { allowLocal: true }),
    'http://127.0.0.1:8787/email',
  );
});

test('validateWebhookUrl still rejects non-local http when --local behavior is enabled', () => {
  assert.throws(
    () => validateWebhookUrl('http://example.com/email', { allowLocal: true }),
    (error) => error instanceof SetupError && /localhost testing/.test(error.message),
  );
});
