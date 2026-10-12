import { PostHog } from 'posthog-node/edge';
import coverageBundle from '../data/coverage.json' with { type: 'json' };
import { isApiRequest, pagesProxyUrl, publicDownloadObjectKey } from './routing.mjs';
import {
  ENTITY_TYPES,
  buildTaxReport,
  canReadEntity,
  canWriteEntity,
  normalizeEntityPayload,
  normalizeEntityType,
  openInvoiceBalance,
  redactEmployee,
  validShopId,
  validVin,
} from './domain.mjs';
import { payrollLinesForOrder } from '../../src/modules/technician-assignment.js';
import {
  base64UrlEncode,
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hmacBase64Url,
  hmacHex,
  verifyAccessJwt,
  verifyGoogleIdToken,
} from './security.mjs';
import { createPartstechHandlers } from './integrations/partstech.mjs';
import { createLaborGuideHandlers } from './integrations/labor-guide.mjs';
import { createQuickbooksHandlers } from './integrations/quickbooks.mjs';
import { HttpError, json, parseJson, requestJson } from './http.mjs';
import { storeUploadedFile } from './routes/files.mjs';
import { PROGRAMMING_MODES, mintCapabilityToken, procedureSpec } from './diagnostics.mjs';
import { canSendLoginEmail, deliverLoginEmail, handleSendLogin, signInDeliveryFailure } from './login-email.mjs';
import { revokeSessionsForUserIds, syncAccessUser } from './access-users.mjs';
import { applyPendingFoundingClaim, claimBatchOutcome } from './founding.mjs';
import {
  LIVE_DIAGNOSTICS_PLANS,
  claimDecision,
  hasPlanCapability,
  isFoundingPlan,
  isPublicPlan,
  planCapabilities,
  stripePriceForPlan,
} from './plans.mjs';
import {
  calculateVoiceCost,
  isAiEnabled,
  readAudioWithinLimit,
  recordAiUsage,
  runAnthropicTurn,
  transcribeDeepgramAudio,
  usageCostsForResult,
} from './ai.mjs';
import { handleShopAiSettings } from './shop-ai.mjs';
import { AiChatSession } from './chat-session.mjs';
import { AiVoiceSession } from './voice-session.mjs';
import { createCustomerDocumentLink, handleCustomerDocument } from './customer-documents.mjs';
import {
  handleIntegrationStatus,
  handleLaborIntegration,
  handleMessagingIntegration,
  handlePartsIntegration,
  handleQuickBooks,
  handleQuickBooksCallback,
  handleSupport,
  handleTwilioWebhook,
} from './integration-routes.mjs';
import { handleCustomerLookup } from './customer-search.mjs';
import { chargeTargetSnapshot, recordPayment as recordPaymentToTarget } from './payments.mjs';
import { handleTerminalRoutes, stripeKeyMode, terminalPaymentRecord } from './terminal.mjs';
import {
  approvalRecorder,
  normalizeEstimateApproval,
  validateEstimateApproval,
} from '../../src/modules/estimate-approval.js';
import {
  approvedEstimate,
  normalizeEstimateLine,
  normalizeTechnicianIds,
} from '../../src/modules/estimate-workflow.js';

export { AiChatSession, AiVoiceSession };

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const APP_SESSION_COOKIE = 'mechpro_session';
const GOOGLE_STATE_COOKIE = '__Host-mechpro_google_state';
const GOOGLE_NONCE_COOKIE = '__Host-mechpro_google_nonce';
const GOOGLE_VERIFIER_COOKIE = '__Host-mechpro_google_verifier';
const GOOGLE_RETURN_COOKIE = '__Host-mechpro_google_return';
const GOOGLE_DESKTOP_COOKIE = '__Host-mechpro_google_desktop';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;
const SESSION_REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2;

function createPostHog(env) {
  const apiKey = String(env.POSTHOG_API_KEY || '').trim();
  const host = String(env.POSTHOG_HOST || '').trim();
  const missingVariable = !apiKey ? 'POSTHOG_API_KEY' : !host ? 'POSTHOG_HOST' : null;
  if (missingVariable) {
    if (env.ENVIRONMENT === 'development' || env.NODE_ENV === 'development') {
      throw new Error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
    }
    return null;
  }
  return new PostHog(apiKey, {
    host,
    flushAt: 20,
    flushInterval: 10000,
    enableExceptionAutocapture: true,
  });
}

function captureForContext(analytics, context, event, properties = {}) {
  analytics.client?.capture({
    distinctId: context.userId,
    event,
    properties: {
      shop_id: context.shopId,
      role: context.role,
      ...properties,
    },
    groups: { shop: context.shopId },
  });
}

let posthogClient = null;

function getPostHog(env) {
  const apiKey = String(env.POSTHOG_API_KEY || '').trim();
  const host = String(env.POSTHOG_HOST || '').trim();
  if (!apiKey) {
    if (env.ENVIRONMENT === 'development') {
      throw new Error('POSTHOG_API_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_API_KEY is configured');
    }
    return null;
  }
  if (!host) {
    if (env.ENVIRONMENT === 'development') {
      throw new Error('POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_HOST is configured');
    }
    return null;
  }
  if (!posthogClient) {
    posthogClient = new PostHog(apiKey, {
      host,
      flushAt: 20,
      flushInterval: 10000,
      enableExceptionAutocapture: true,
    });
  }
  return posthogClient;
}

function capturePostHogEvent(env, context, event, properties = {}) {
  const posthog = getPostHog(env);
  if (!posthog) return;
  posthog.capture({
    distinctId: context.userId,
    event,
    properties,
    groups: context.shopId ? { shop: context.shopId } : undefined,
  });
}

// Recursively redact sensitive fields before persisting diagnostic audit events.
const SENSITIVE_AUDIT_KEYS = new Set([
  'pin', 'token', 'securitytoken', 'password', 'credential', 'secret',
  'seed', 'authorizationtoken', 'capabilitytoken', 'privatekey',
]);

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_AUDIT_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(item),
    ]));
  }
  return value;
}

// Accept both snake_case and camelCase procedure names from clients.
function normalizeProcedure(value) {
  const raw = String(value || '').trim();
  return ({
    clearDtcs: 'clear_dtcs',
    addKey: 'add_key',
    allKeysLost: 'all_keys_lost',
    programRemote: 'program_remote',
    eraseKeys: 'erase_keys',
    moduleFlash: 'module_flash',
    flash: 'module_flash',
  })[raw] || raw;
}


function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const configured = String(env.ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (new URL(request.url).origin === origin || configured.includes(origin)) return origin;
  return null;
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function hashValue(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function cookieEntries(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  return cookieHeader.split(';').map(entry => entry.trim()).filter(Boolean).reduce((map, entry) => {
    const separator = entry.indexOf('=');
    if (separator === -1) return map;
    const key = entry.slice(0, separator).trim();
    const value = decodeURIComponent(entry.slice(separator + 1).trim());
    if (key) map[key] = value;
    return map;
  }, {});
}

function getCookieValue(request, name) {
  return cookieEntries(request)[name] || '';
}

function sessionCookieHeader(token, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  return `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

function temporaryCookieHeader(name, value, maxAgeSeconds = 10 * 60) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function safeReturnPath(value, fallback = '/app') {
  const candidate = String(value || '').trim();
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  try {
    const parsed = new URL(candidate, 'https://mechpro.invalid');
    return parsed.origin === 'https://mechpro.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback;
  } catch {
    return fallback;
  }
}

function isAuthCallbackPath(path) {
  return path === '/api/auth/callback' || path === '/api/auth/google/callback';
}

function isDatabaseOperationalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.name === 'D1Error'
    || /\bD1_ERROR\b|\bSQLITE_(?:ERROR|BUSY|CORRUPT|FULL|IOERR|LOCKED|READONLY)\b|no such (?:table|column):/i.test(message);
}

function publicRequestError(error, path) {
  if (!(error instanceof HttpError) && isAuthCallbackPath(path) && isDatabaseOperationalError(error)) {
    return new HttpError(
      503,
      'Sign-in is temporarily unavailable. Please try again later or contact support if the problem continues.',
      { 'Retry-After': '60' },
    );
  }
  return error;
}

async function resolveAppSession(request, env) {
  const token = getCookieValue(request, APP_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashValue(token);
  const row = await env.DB.prepare(`
    SELECT s.id AS session_id, s.user_id, s.expires_at, s.revoked_at, u.email, u.name, u.shop_id, u.role
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND u.enabled = 1
  `).bind(tokenHash, new Date().toISOString()).first();
  if (!row) return null;
  const now = new Date();
  // Rolling session lifetime: an active session (or desktop app) keeps extending
  // its window and stays signed in until an explicit logout or full inactivity.
  let expiresAt = String(row.expires_at || '');
  const sessionRemaining = Date.parse(expiresAt) - now.getTime();
  if (Number.isFinite(sessionRemaining) && sessionRemaining < SESSION_REFRESH_THRESHOLD_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(expiresAt, row.session_id)
      .run();
  }
  const lastSeenCutoff = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'UPDATE sessions SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)',
  ).bind(now.toISOString(), row.session_id, lastSeenCutoff).run();
  return {
    shopId: String(row.shop_id),
    role: String(row.role || 'admin'),
    userId: String(row.user_id),
    email: String(row.email || '').trim().toLowerCase(),
    name: String(row.name || row.email || 'Customer'),
    sessionId: String(row.session_id),
    expiresAt,
  };
}

function platformAdminEmails(env) {
  return String(env.ACCESS_ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isPlatformAdminEmail(email, env) {
  return platformAdminEmails(env).includes(String(email || '').trim().toLowerCase());
}

async function resolveContext(request, env) {
  const appSession = await resolveAppSession(request, env);
  if (appSession) {
    // Magic-link / cookie sessions must honor ACCESS_ADMIN_EMAILS the same way Access JWT does.
    if (isPlatformAdminEmail(appSession.email, env)) {
      return {
        shopId: 'platform',
        role: 'super_admin',
        userId: appSession.userId,
        email: appSession.email,
        name: appSession.name || 'Platform Administrator',
        claims: { sub: appSession.userId, email: appSession.email, name: appSession.name },
        sessionId: appSession.sessionId,
        expiresAt: appSession.expiresAt,
      };
    }
    return {
      shopId: appSession.shopId,
      role: appSession.role,
      userId: appSession.userId,
      email: appSession.email,
      name: appSession.name,
      claims: { sub: appSession.userId, email: appSession.email, name: appSession.name },
      sessionId: appSession.sessionId,
      expiresAt: appSession.expiresAt,
    };
  }
  let claims;
  if (env.DEV_AUTH_BYPASS === '1' && request.headers.get('X-MechPro-Dev-Email')) {
    claims = {
      sub: request.headers.get('X-MechPro-Dev-Sub') || 'local-development',
      email: request.headers.get('X-MechPro-Dev-Email'),
      name: request.headers.get('X-MechPro-Dev-Name') || 'Local Developer',
    };
  } else {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new HttpError(401, 'Authentication is required');
    try {
      claims = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    } catch (error) {
      throw new HttpError(401, error instanceof Error ? error.message : 'Invalid Cloudflare Access session');
    }
  }
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) throw new HttpError(401, 'Cloudflare Access identity has no email claim');
  if (isPlatformAdminEmail(email, env)) {
    return { shopId: 'platform', role: 'super_admin', userId: String(claims.sub || email), email, name: claims.name || 'Platform Administrator', claims };
  }
  const mapping = await env.DB.prepare(
    'SELECT shop_id, role, name, enabled FROM users WHERE email = ? COLLATE NOCASE',
  ).bind(email).first();
  if (!mapping || Number(mapping.enabled) !== 1) throw new HttpError(403, 'No active MechPro account is mapped to this Access identity');
  return {
    shopId: mapping.shop_id,
    role: mapping.role,
    userId: String(claims.sub || email),
    email,
    name: mapping.name || claims.name || email,
    claims,
  };
}

function requireRole(context, roles) {
  if (!roles.includes(context.role)) throw new HttpError(403, `Role ${context.role} is not permitted for this action`);
}

async function requireActiveAccount(context, env) {
  if (context.role === 'super_admin') return;
  const account = await env.DB.prepare(
    'SELECT suspended FROM accounts WHERE shop_id = ?',
  ).bind(context.shopId).first();
  if (account && Number(account.suspended) === 1) throw new HttpError(403, 'Customer account is suspended');
}

async function requirePlanCapability(context, env, capability) {
  if (context.role === 'super_admin') return;
  const subscription = await env.DB.prepare(
    'SELECT plan_id, status, current_period_end FROM subscriptions WHERE shop_id = ? LIMIT 1',
  ).bind(context.shopId).first();
  if (!hasPlanCapability(subscription, capability)) {
    throw new HttpError(403, `${capability.replaceAll('_', ' ')} requires an active MechPro plan`);
  }
}

function entityRecord(row, type = '') {
  const record = row ? parseJson(row.data_json) : null;
  return record && type ? normalizeEntityPayload(type, record) : record;
}

async function getEntity(env, shopId, type, id) {
  return entityRecord(await env.DB.prepare(
    'SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(shopId, type, id).first(), type);
}

async function listEntities(env, shopId, type, { limit = 0, cursor = '' } = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const nextCursor = String(cursor || '').trim();
  const filters = ['shop_id = ?', 'entity_type = ?'];
  const bindValues = [shopId, type];
  if (nextCursor) {
    // Compound cursor avoids skipping rows that share an updated_at timestamp.
    const [cursorTs, cursorId] = nextCursor.split('|');
    filters.push('(updated_at > ? OR (updated_at = ? AND entity_id > ?))');
    bindValues.push(cursorTs, cursorTs, cursorId);
  }
  let sql = `SELECT data_json, updated_at, entity_id FROM entities WHERE ${filters.join(' AND ')} ORDER BY updated_at, entity_id`;
  if (boundedLimit) {
    sql += ' LIMIT ?';
    bindValues.push(boundedLimit);
  }
  const result = await env.DB.prepare(sql).bind(...bindValues).all();
  const rows = result.results || [];
  const records = rows.map(row => entityRecord(row, type)).filter(Boolean);
  if (!boundedLimit) return records;
  return {
    records,
    nextCursor: rows.length === boundedLimit ? `${rows.at(-1)?.updated_at}|${rows.at(-1)?.entity_id}` : null,
  };
}

export async function putEntity(
  env,
  context,
  type,
  id,
  body,
  expectedUpdatedAt = null,
  createdBy = context.userId,
  { requireUnlockedEstimate = false } = {},
) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    'SELECT created_at, created_by, updated_at FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
  ).bind(context.shopId, type, id).first();
  if (expectedUpdatedAt && existing && existing.updated_at !== expectedUpdatedAt) {
    throw new HttpError(409, 'Record was updated elsewhere. Reload before saving again.');
  }
  const record = {
    ...body,
    id,
    shopId: context.shopId,
    createdBy: existing?.created_by || createdBy,
    createdAt: body.createdAt || existing?.created_at || now,
    updatedAt: now,
  };
  if (requireUnlockedEstimate) {
    // CAS on updated_at inside the same UPDATE as the unlock guard. The early
    // If-Match check above is not atomic with this write, so a concurrent staff
    // line edit can otherwise slip in and be overwritten by a stale approval.
    const casToken = expectedUpdatedAt || existing?.updated_at || null;
    let sql = `
      UPDATE entities
      SET data_json = ?, updated_at = ?
      WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
        AND COALESCE(json_extract(data_json, '$.linesLockedAt'), '') = ''
        AND COALESCE(json_extract(data_json, '$.estimateApproval.status'), '')
          NOT IN ('approved', 'declined')
    `;
    const binds = [JSON.stringify(record), now, context.shopId, type, id];
    if (casToken) {
      sql += ' AND updated_at = ?';
      binds.push(casToken);
    }
    const outcome = await env.DB.prepare(sql).bind(...binds).run();
    if (!outcome?.meta?.changes) {
      const current = await env.DB.prepare(`
        SELECT updated_at,
          json_extract(data_json, '$.linesLockedAt') AS lines_locked_at,
          json_extract(data_json, '$.estimateApproval.status') AS approval_status
        FROM entities
        WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
      `).bind(context.shopId, type, id).first();
      if (current && (
        String(current.lines_locked_at || '')
        || ['approved', 'declined'].includes(String(current.approval_status || ''))
      )) {
        throw new HttpError(409, 'This estimate has already been approved or declined');
      }
      throw new HttpError(409, 'Record was updated elsewhere. Reload before saving again.');
    }
    return record;
  }
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(context.shopId, type, id, JSON.stringify(record), record.createdBy, record.createdAt, now).run();
  return record;
}

const ESTIMATE_APPROVAL_WRITE_ROLES = new Set(['owner', 'admin', 'service_writer']);

function preserveRecordedApproval(body, existingOrder) {
  const requestedLines = new Map((body.estimate?.lines || []).map((line, index) => [
    normalizeEstimateLine(line, index).id,
    line,
  ]));
  const estimate = {
    ...existingOrder.estimate,
    lines: (existingOrder.estimate?.lines || []).map((line, index) => {
      const normalized = normalizeEstimateLine(line, index);
      const requested = requestedLines.get(normalized.id);
      if (normalized.type !== 'labor' || !Array.isArray(requested?.technicianIds)) return line;
      return { ...line, technicianIds: normalizeTechnicianIds(requested) };
    }),
  };
  return {
    ...body,
    estimate,
    labor: existingOrder.labor,
    laborHours: existingOrder.laborHours,
    parts: existingOrder.parts,
    tax: existingOrder.tax,
    total: existingOrder.total,
    linesLockedAt: existingOrder.linesLockedAt,
    estimateApproval: existingOrder.estimateApproval,
  };
}

export function validatedOrderApproval(body, context, existingOrder = null, timestamp = new Date().toISOString()) {
  const requestedApproval = body?.estimateApproval;
  const existingApproval = normalizeEstimateApproval(existingOrder?.estimateApproval);
  if (existingApproval?.status === 'approved') {
    const explicitRevision = requestedApproval == null
      && body.estimateRevisionPending === true
      && !body.linesLockedAt;
    if (explicitRevision && !ESTIMATE_APPROVAL_WRITE_ROLES.has(context.role)) {
      throw new HttpError(403, 'This role cannot revise an approved estimate');
    }
    return explicitRevision ? body : preserveRecordedApproval(body, existingOrder);
  }
  if (!requestedApproval || requestedApproval.status !== 'approved') return body;
  if (!existingOrder) throw new HttpError(409, 'Create the work order before recording approval');
  if (existingOrder.linesLockedAt || existingOrder.estimateApproval?.status === 'declined') {
    throw new HttpError(409, 'Revise the locked estimate before recording a new approval');
  }
  if (!ESTIMATE_APPROVAL_WRITE_ROLES.has(context.role)) {
    throw new HttpError(403, 'This role cannot record estimate approvals');
  }

  const sourceLines = existingOrder.estimate?.lines || [];
  if (!sourceLines.length) throw new HttpError(409, 'Add estimate lines before recording approval');
  const decisions = requestedApproval.decisions && typeof requestedApproval.decisions === 'object'
    ? requestedApproval.decisions
    : {};
  const lineIds = sourceLines.map((line, index) => normalizeEstimateLine(line, index).id);
  if (lineIds.some(id => !['approved', 'declined'].includes(decisions[id]))) {
    throw new HttpError(400, 'Approve or decline every estimate line');
  }
  if (Object.keys(decisions).some(id => !lineIds.includes(id))) {
    throw new HttpError(400, 'Approval decisions do not match this estimate');
  }

  const estimate = approvedEstimate(existingOrder.estimate, decisions);
  if (!estimate.approvedLineCount) {
    throw new HttpError(400, 'Approve at least one line or decline the estimate');
  }
  const recordedBy = approvalRecorder(context);
  let approval;
  try {
    approval = validateEstimateApproval({
      ...requestedApproval,
      approvedAt: timestamp,
      recordedBy,
      decisions,
    });
  } catch (error) {
    throw new HttpError(400, error.message || 'Estimate approval is invalid');
  }
  if (approval.type === 'signature' && approval.signatureKey && context.shopId
    && !String(approval.signatureKey).startsWith(`shops/${context.shopId}/`)) {
    throw new HttpError(400, 'Signature does not belong to this shop');
  }
  if (approval.type !== 'signature') {
    delete approval.signatureKey;
    delete approval.signatureDataUrl;
    delete approval.signedAt;
  }

  const result = {
    ...body,
    estimate,
    labor: estimate.labor,
    laborHours: estimate.laborHours,
    parts: estimate.parts,
    tax: estimate.tax,
    total: estimate.total,
    status: existingOrder.estimateRevisionPreviousStatus || 'approved',
    linesLockedAt: timestamp,
    estimateApproval: approval,
    estimateRevisionPending: false,
  };
  delete result.estimateRevisionPreviousStatus;
  return result;
}

export async function verifyOrderApprovalSignature(env, context, approval) {
  const normalized = normalizeEstimateApproval(approval);
  if (normalized?.status !== 'approved' || normalized.type !== 'signature' || !normalized.signatureKey) return;
  if (context.shopId && !String(normalized.signatureKey).startsWith(`shops/${context.shopId}/`)) {
    throw new HttpError(400, 'Signature does not belong to this shop');
  }
  if (!env.FILES?.head) throw new HttpError(503, 'Signature storage is unavailable');
  const object = await env.FILES.head(normalized.signatureKey);
  if (!object) throw new HttpError(400, 'Stored signature was not found');
  const contentType = String(object.httpMetadata?.contentType || object.contentType || '').toLowerCase();
  if (contentType !== 'image/png') {
    throw new HttpError(400, 'Stored signature must be a PNG image');
  }
}

function members(record) {
  return [...new Set((Array.isArray(record?.memberEmails) ? record.memberEmails : [])
    .map(email => String(email).trim().toLowerCase()).filter(Boolean))];
}

function listParams(request) {
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(200, Math.floor(requestedLimit))
    : 0;
  return {
    limit,
    cursor: String(url.searchParams.get('cursor') || '').trim(),
    conversationId: String(url.searchParams.get('conversationId') || '').trim(),
  };
}

async function listConversationIdsForMember(env, shopId, email, { limit = 0, cursor = '' } = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const bindValues = [shopId, email.toLowerCase()];
  let sql = `
    SELECT e.entity_id, e.updated_at, e.data_json
    FROM entities e, json_each(e.data_json, '$.memberEmails') member
    WHERE e.shop_id = ? AND e.entity_type = 'conversations' AND lower(member.value) = ?
  `;
  if (cursor) {
    sql += ' AND e.updated_at > ?';
    bindValues.push(cursor);
  }
  sql += ' ORDER BY e.updated_at';
  if (boundedLimit) {
    sql += ' LIMIT ?';
    bindValues.push(boundedLimit);
  }
  const result = await env.DB.prepare(sql).bind(...bindValues).all();
  const rows = result.results || [];
  const records = rows.map(entityRecord).filter(Boolean);
  return {
    records,
    ids: records.map(record => String(record.id || '')).filter(Boolean),
    nextCursor: boundedLimit && rows.length === boundedLimit ? String(rows.at(-1)?.updated_at || '') : null,
  };
}

async function listChatMessagesForConversations(env, shopId, email, { limit = 0, cursor = '', conversationId = '' } = {}) {
  // Keep bound-parameter count fixed (D1 caps at 100). Expanding every
  // conversation id into an IN (...) list breaks team chat once a member
  // belongs to ~99+ conversations.
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(200, Math.floor(Number(limit)))
    : 0;
  const bindValues = [shopId, email.toLowerCase()];
  let sql = `
    SELECT m.data_json, m.updated_at FROM entities m
    WHERE m.shop_id = ?1 AND m.entity_type = 'chatmessages'
      AND json_extract(m.data_json, '$.conversationId') IN (
        SELECT c.entity_id FROM entities c, json_each(c.data_json, '$.memberEmails') mem
        WHERE c.shop_id = ?1 AND c.entity_type = 'conversations' AND lower(trim(mem.value)) = ?2)
  `;
  if (conversationId) {
    sql += " AND json_extract(m.data_json, '$.conversationId') = ?";
    bindValues.push(conversationId);
  }
  if (cursor) {
    sql += ' AND m.updated_at > ?';
    bindValues.push(cursor);
  }
  sql += ' ORDER BY m.updated_at';
  if (boundedLimit) {
    sql += ' LIMIT ?';
    bindValues.push(boundedLimit);
  }
  const result = await env.DB.prepare(sql).bind(...bindValues).all();
  const rows = result.results || [];
  return {
    records: rows.map(entityRecord).filter(Boolean),
    nextCursor: boundedLimit && rows.length === boundedLimit ? String(rows.at(-1)?.updated_at || '') : null,
  };
}

async function hasLinkedCustomerEntity(env, shopId, type, customerName) {
  return Boolean(await env.DB.prepare(
    "SELECT 1 AS found FROM entities WHERE shop_id = ? AND entity_type = ? AND json_extract(data_json, '$.customer') = ? LIMIT 1",
  ).bind(shopId, type, customerName).first());
}

async function listPaymentsByInvoice(env, shopId, invoiceNumber) {
  const result = await env.DB.prepare(
    "SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'payments' AND json_extract(data_json, '$.invoiceNumber') = ?",
  ).bind(shopId, invoiceNumber).all();
  return (result.results || []).map(entityRecord).filter(Boolean);
}

async function handleEntities(request, env, context, segments, analytics) {
  const sourceType = String(segments[1] || '').toLowerCase();
  const type = normalizeEntityType(sourceType);
  const id = segments[2] ? decodeURIComponent(segments.slice(2).join('/')) : null;
  if (!ENTITY_TYPES.has(type)) throw new HttpError(404, `Unknown entity type: ${type}`);
  if (request.method === 'GET' && !canReadEntity(type, context.role)) throw new HttpError(403, `Role ${context.role} cannot read ${type}`);
  if (request.method !== 'GET' && !canWriteEntity(type, context.role)) throw new HttpError(403, `Role ${context.role} cannot modify ${type}`);

  if (request.method === 'GET' && !id) {
    const params = listParams(request);
    const paginated = params.limit > 0;
    let records;
    let nextCursor = null;
    if (type === 'conversations') {
      const result = await listConversationIdsForMember(env, context.shopId, context.email, params);
      records = result.records;
      nextCursor = result.nextCursor;
    } else {
      const result = await listEntities(env, context.shopId, type, params);
      records = paginated ? result.records : result;
      nextCursor = paginated ? result.nextCursor : null;
    }
    if (type === 'chatmessages') {
      const allowedResult = await listConversationIdsForMember(env, context.shopId, context.email);
      const allowedIds = new Set(allowedResult.ids);
      if (params.conversationId && !allowedIds.has(params.conversationId)) throw new HttpError(404, 'Conversation not found');
      const listed = await listChatMessagesForConversations(env, context.shopId, context.email, params);
      records = listed.records;
      nextCursor = listed.nextCursor;
    }
    if (type === 'employees') records = records.map(record => redactEmployee(record, context.role));
    return paginated ? json({ records, nextCursor }) : json(records);
  }
  if (request.method === 'GET' && id) {
    const record = await getEntity(env, context.shopId, type, id);
    if (!record) throw new HttpError(404, 'Not found');
    if (type === 'conversations' && !members(record).includes(context.email)) throw new HttpError(404, 'Not found');
    if (type === 'chatmessages') {
      const conversation = await getEntity(env, context.shopId, 'conversations', record.conversationId);
      if (!conversation || !members(conversation).includes(context.email)) throw new HttpError(404, 'Not found');
    }
    return json(type === 'employees' ? redactEmployee(record, context.role) : record);
  }
  if (request.method === 'POST' && !id) {
    let body = normalizeEntityPayload(sourceType, await requestJson(request));
    if (type === 'orders') body = validatedOrderApproval(body, context);
    const naturalId = type === 'invoices' ? body.number : type === 'customers' ? body.name : null;
    const newId = String(body.id || naturalId || crypto.randomUUID());
    if (type === 'conversations') {
      if (!['direct', 'group'].includes(body.kind)) throw new HttpError(400, 'Conversation kind must be direct or group');
      if (body.kind === 'group' && context.role !== 'admin') throw new HttpError(403, 'Only owners can create group conversations');
      const memberEmails = members(body);
      if (!memberEmails.includes(context.email) || memberEmails.length < 2) {
        throw new HttpError(400, 'Conversation requires the creator and at least one other member');
      }
      body = { ...body, memberEmails, creatorEmail: context.email };
    }
    if (type === 'chatmessages') {
      const conversation = await getEntity(env, context.shopId, 'conversations', String(body.conversationId || ''));
      if (!conversation || !members(conversation).includes(context.email) || !String(body.body || '').trim()) {
        throw new HttpError(404, 'Conversation not found');
      }
      body = { ...body, body: String(body.body).trim().slice(0, 4000), memberEmails: members(conversation), senderEmail: context.email };
    }
    // Sync access before writing the entity so a cross-tenant email conflict
    // cannot leave an orphan employee row behind.
    if (type === 'employees') await syncAccessUser(env, context, body);
    const saved = await putEntity(env, context, type, newId, body);
    captureForContext(analytics, context, 'entity_created', { entity_type: type });
    capturePostHogEvent(env, context, 'entity_created', {
      entity_type: type,
      actor_role: context.role,
    });
    return json(saved, 201);
  }
  if (request.method === 'PUT' && id) {
    let body = normalizeEntityPayload(sourceType, await requestJson(request));
    let requireUnlockedEstimate = false;
    if (type === 'orders') {
      const existingOrder = await getEntity(env, context.shopId, type, id);
      requireUnlockedEstimate = Boolean(
        existingOrder
        && body.estimateApproval?.status === 'approved'
        && existingOrder.estimateApproval?.status !== 'approved',
      );
      body = validatedOrderApproval(body, context, existingOrder);
      if (requireUnlockedEstimate) await verifyOrderApprovalSignature(env, context, body.estimateApproval);
    }
    if (type === 'chatmessages') throw new HttpError(405, 'Chat messages cannot be edited');
    if (type === 'conversations') {
      const existing = await getEntity(env, context.shopId, type, id);
      if (!existing || !members(existing).includes(context.email)) throw new HttpError(404, 'Conversation not found');
      if (existing.kind !== 'group' || context.role !== 'admin') throw new HttpError(403, 'Only owners can edit group conversations');
      const memberEmails = members(body);
      if (!memberEmails.includes(context.email) || memberEmails.length < 2) throw new HttpError(400, 'Group requires the owner and at least one other member');
      body = { ...body, memberEmails, creatorEmail: existing.creatorEmail };
    }
    if (type === 'employees') await syncAccessUser(env, context, body);
    const saved = await putEntity(
      env,
      context,
      type,
      id,
      body,
      request.headers.get('If-Match'),
      context.userId,
      { requireUnlockedEstimate },
    );
    captureForContext(analytics, context, 'entity_updated', { entity_type: type });
    capturePostHogEvent(env, context, 'entity_updated', {
      entity_type: type,
      actor_role: context.role,
    });
    return json(saved);
  }
  if (request.method === 'DELETE' && id) {
    const existing = await getEntity(env, context.shopId, type, id);
    if (!existing) throw new HttpError(404, 'Not found');
    if (['conversations', 'chatmessages'].includes(type)
      && (!members(existing).includes(context.email) || (context.role !== 'admin' && existing.createdBy !== context.userId))) {
      throw new HttpError(403, 'Not permitted');
    }
    if (type === 'customers') {
      const linkedTypes = ['vehicles', 'orders', 'invoices'];
      const links = await Promise.all(linkedTypes.map(linkedType => hasLinkedCustomerEntity(env, context.shopId, linkedType, existing.name)));
      if (links.some(Boolean)) {
        throw new HttpError(409, "Delete this customer's vehicles, work orders, and invoices first");
      }
    }
    const statements = [env.DB.prepare(
      'DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
    ).bind(context.shopId, type, id)];
    if (type === 'invoices') {
      const payments = await listPaymentsByInvoice(env, context.shopId, existing.number || existing.id);
      for (const payment of payments.filter(record => record.invoiceNumber === (existing.number || existing.id))) {
        statements.push(env.DB.prepare(
          'DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
        ).bind(context.shopId, 'payments', payment.id));
      }
    }
    if (type === 'employees' && existing.email) {
      statements.push(env.DB.prepare(
        'DELETE FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?',
      ).bind(existing.email, context.shopId));
    }
    await env.DB.batch(statements);
    captureForContext(analytics, context, 'entity_deleted', { entity_type: type });
    capturePostHogEvent(env, context, 'entity_deleted', {
      entity_type: type,
      actor_role: context.role,
    });
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function handleAuthSession(request, context, analytics) {
  // Browser sessionStorage treats expiresAt as a hard logout. It must mirror the
  // rolling D1/cookie TTL (7 days), not a 1-hour claim window — otherwise an
  // open dispatch tab self-signs-out after an hour despite a valid cookie.
  const parsedExpiry = context.expiresAt ? Date.parse(context.expiresAt) : Number.NaN;
  const expiresMs = Number.isFinite(parsedExpiry)
    ? parsedExpiry
    : Date.now() + SESSION_TTL_MS;
  const expires = Math.max(Math.floor(Date.now() / 1000) + 1, Math.floor(expiresMs / 1000));
  const cookieMaxAge = Math.max(1, expires - Math.floor(Date.now() / 1000));
  const sessionToken = getCookieValue(request, APP_SESSION_COOKIE);
  analytics.client?.identify({
    distinctId: context.userId,
    properties: {
      email: context.email,
      name: context.name,
      role: context.role,
      shop_id: context.shopId,
    },
  });
  captureForContext(analytics, context, 'auth_session_started');
  // Re-issue the session cookie on every /auth/session probe so a rolled-forward
  // D1 expiry is mirrored in the browser (and desktop) cookie lifetime.
  return json(
    {
      claims: {
        sub: context.userId,
        email: context.email,
        name: context.name,
        'custom:shopId': context.shopId,
        'custom:role': context.role,
        exp: expires,
      },
      expiresAt: expires * 1000,
    },
    200,
    sessionToken ? { 'Set-Cookie': sessionCookieHeader(sessionToken, cookieMaxAge) } : {},
  );
}

const GEOCODE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEOCODE_REQUEST_INTERVAL_MS = 1000;

async function waitForGeocodeSlot(env) {
  while (true) {
    const now = Date.now();
    const reservation = await env.DB.prepare(`
      UPDATE geocode_request_pacing
      SET next_available_at = ?
      WHERE id = 1 AND next_available_at <= ?
      RETURNING id
    `).bind(now + GEOCODE_REQUEST_INTERVAL_MS, now).first();
    if (reservation) return;
    const pacing = await env.DB.prepare(
      'SELECT next_available_at FROM geocode_request_pacing WHERE id = 1',
    ).first();
    const nextAvailableAt = Number(pacing?.next_available_at);
    if (!Number.isFinite(nextAvailableAt)) {
      throw new Error('Geocoding request pacing is not initialized');
    }
    const delay = nextAvailableAt - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay)));
  }
}

async function getCachedGeocode(env, key) {
  const cached = await env.DB.prepare(`
    SELECT latitude, longitude, label
    FROM geocode_cache
    WHERE address_key = ? AND expires_at > ?
  `).bind(key, Date.now()).first();
  if (!cached) return null;
  return { lat: Number(cached.latitude), lon: Number(cached.longitude), label: cached.label };
}

export async function geocodeAddress(address, env) {
  const query = String(address || '').trim();
  if (!query) return null;
  const key = query.replace(/\s+/g, ' ').toLowerCase();
  const cached = await getCachedGeocode(env, key);
  if (cached) return cached;
  await waitForGeocodeSlot(env);
  const cachedAfterWait = await getCachedGeocode(env, key);
  if (cachedAfterWait) return cachedAfterWait;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MechProShopOS/1.0 (mileage; https://www.yourcarguy806.com)',
    },
  });
  if (!response.ok) throw new HttpError(502, 'Address lookup is unavailable');
  const results = await response.json();
  const hit = Array.isArray(results) ? results[0] : null;
  if (!hit?.lat || !hit?.lon) return null;
  const result = { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name || query };
  await env.DB.prepare(`
    INSERT INTO geocode_cache (address_key, latitude, longitude, label, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(address_key) DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      label = excluded.label,
      expires_at = excluded.expires_at
  `).bind(key, result.lat, result.lon, result.label, Date.now() + GEOCODE_CACHE_TTL_MS).run();
  return result;
}

export async function drivingMiles(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new HttpError(502, 'Route calculation is unavailable');
  const payload = await response.json();
  const meters = payload?.routes?.[0]?.distance;
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) {
    throw new HttpError(422, 'No driving route found between those addresses');
  }
  return Math.round((meters / 1609.344) * 10) / 10;
}

async function handleMileageCalculate(request, env, context) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'technician', 'service_writer', 'office']);
  const body = await requestJson(request);
  const fromAddress = String(body.from || body.shopAddress || '').trim();
  const toAddress = String(body.to || body.jobAddress || '').trim();
  if (!fromAddress || !toAddress) throw new HttpError(400, 'Shop address and job site address are required');
  const [from, to] = await Promise.all([geocodeAddress(fromAddress, env), geocodeAddress(toAddress, env)]);
  if (!from) throw new HttpError(422, 'Could not locate the shop address');
  if (!to) throw new HttpError(422, 'Could not locate the job site address');
  const oneWayMiles = await drivingMiles(from, to);
  const roundTripMiles = Math.round(oneWayMiles * 2 * 10) / 10;
  return json({
    from: from.label,
    to: to.label,
    oneWayMiles,
    roundTripMiles,
    source: 'OSRM driving route',
  });
}

async function handleVin(request, env, context, vin) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  vin = String(vin || '').trim().toUpperCase();
  if (!validVin(vin)) throw new HttpError(400, 'VIN must contain 17 valid characters');
  const cached = await getEntity(env, context.shopId, 'vindecodes', vin);
  if (cached?.decoded) return json({ ...cached.decoded, cached: true });
  const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new HttpError(502, 'Vehicle data provider is unavailable');
  const result = (await response.json()).Results?.[0] || {};
  const value = key => String(result[key] || '').trim();
  const decoded = {
    vin: value('VIN').toUpperCase(), year: value('ModelYear'), make: value('Make'), model: value('Model'),
    trim: value('Trim'), vehicleType: value('VehicleType'), bodyClass: value('BodyClass'),
    driveType: value('DriveType'), fuelType: value('FuelTypePrimary'),
    engineCylinders: value('EngineCylinders'), engineDisplacementLiters: value('DisplacementL'),
    manufacturer: value('Manufacturer'), plantCountry: value('PlantCountry'),
    errorCode: value('ErrorCode'), errorText: value('ErrorText'),
  };
  if (!decoded.make && !decoded.model && !decoded.year) throw new HttpError(422, decoded.errorText || 'No vehicle details were found for this VIN');
  await putEntity(env, context, 'vindecodes', vin, { decoded, source: 'NHTSA vPIC' });
  return json({ ...decoded, cached: false });
}

async function handleCoverage(request, segments) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  if (segments[2] === 'bundle') return json(coverageBundle);
  const url = new URL(request.url);
  const platform = String(url.searchParams.get('platform') || '').trim();
  const year = Number(url.searchParams.get('year') || 0);
  if (!platform) return json(coverageBundle);
  const records = coverageBundle.records;
  const exact = records.find(record => record.platform.toUpperCase() === platform.toUpperCase()
    && (!year || (year >= record.yearRange[0] && year <= record.yearRange[1])));
  const match = exact || records.find(record => record.platform.toUpperCase() === platform.toUpperCase());
  if (!match) throw new HttpError(404, 'No coverage record found');
  return json(match);
}

async function recordDiagnosticAudit(env, context, event) {
  const id = `audit-${Date.now()}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO audit_log (id, shop_id, actor_id, actor_email, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, context.shopId, context.userId, context.email, JSON.stringify(redactSensitive(event)), new Date().toISOString()).run();
  return id;
}

async function handleDiagnostics(request, env, context, segments, analytics) {
  const action = segments[1];
  // Diagnostics (including coverage lookups) are limited to shop-floor roles.
  requireRole(context, ['owner', 'admin', 'technician', 'service_writer']);
  if (action === 'coverage') return handleCoverage(request, segments);
  if (action === 'autoauth') return handleAutoAuth(request, env, context);
  if (action === 'audit' && request.method === 'POST') {
    const id = await recordDiagnosticAudit(env, context, await requestJson(request));
    return json({ id, recorded: true }, 201);
  }
  if (action === 'authorize' && request.method === 'POST') {
    const body = await requestJson(request);
    const vin = String(body.vin || '').trim().toUpperCase();
    const procedure = normalizeProcedure(body.procedure);
    const mode = PROGRAMMING_MODES.has(body.mode) ? body.mode : 'simulate';
    if (!validVin(vin)) throw new HttpError(400, 'A valid 17-character VIN is required');
    const spec = procedureSpec(procedure);
    if (!spec) throw new HttpError(400, `Unsupported diagnostic procedure: ${body.procedure}`);
    if (!env.DIAGNOSTICS_SIGNING_PRIVATE_KEY) throw new HttpError(503, 'Diagnostics capability signing is not configured');
    // LIVE programming against real modules requires licensed OEM AutoAuth
    // credentials provisioned for the shop. SIMULATE always drives the bench
    // simulator only, so it is safe to authorize without OEM credentials.
    if (mode === 'live') {
      const subscription = await env.DB.prepare('SELECT plan_id FROM subscriptions WHERE shop_id = ?').bind(context.shopId).first();
      const planId = String(subscription?.plan_id || '');
      if (!LIVE_DIAGNOSTICS_PLANS.has(planId)) {
        return json({
          authorized: false,
          message: 'Live OEM programming is included on Shop Pro and Enterprise. Use Simulate on Solo and Shop, or upgrade the shop plan.',
        }, 402);
      }
    }
    if (mode === 'live' && spec.autoAuth) {
      const login = await readAutoAuthLogin(env, context.shopId);
      if (!login) {
        return json({
          authorized: false,
          message: 'Live programming requires your shop to sign in to a vehicle security (AutoAuth) account. Connect it in OEM Diagnostics, or use Simulate mode.',
        }, 501);
      }
    }
    const { token, payload } = await mintCapabilityToken(env, {
      procedure, vin, shopId: context.shopId, mode, actor: context.userId,
    });
    captureForContext(analytics, context, 'diagnostics_authorized', {
      procedure,
      diagnostic_scope: spec.klass,
      mode,
    });
    await recordDiagnosticAudit(env, context, {
      kind: 'diagnostics.authorize', procedure, scope: spec.klass, vin, mode, jti: payload.jti,
    });
    capturePostHogEvent(env, context, 'diagnostics_authorized', {
      procedure,
      diagnostic_scope: spec.klass,
      mode,
      actor_role: context.role,
    });
    return json({
      authorized: true, procedure, scope: spec.klass, mode, vin, token,
      expiresAt: new Date(payload.exp).toISOString(), shopId: context.shopId,
    });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function handleOnboarding(request, env, context, analytics) {
  requireRole(context, ['admin']);
  const records = await env.DB.prepare(
    "SELECT entity_type, entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type != 'employees'",
  ).bind(context.shopId).all();
  const samples = records.results.filter(row => {
    const record = entityRecord(row);
    return record.sampleData === true
      || ['RO-1044', 'RO-1046', 'RO-1048', 'RO-1049', 'RO-1050', 'RO-1051', 'RO-1052'].includes(record.id)
      || ['INV-2032', 'INV-2036', 'INV-2040', 'INV-2041'].includes(record.number);
  });
  if (request.method === 'GET') return json({ sampleRecords: samples.length });
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await requestJson(request);
  const resetAll = body.mode === 'all' && body.confirmation === 'DELETE ALL DATA';
  if (body.mode === 'all' && !resetAll) throw new HttpError(400, 'Type DELETE ALL DATA to confirm the reset');
  const targets = resetAll ? records.results : samples;
  if (targets.length) {
    await env.DB.batch(targets.map(row => env.DB.prepare(
      'DELETE FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?',
    ).bind(context.shopId, row.entity_type, row.entity_id)));
  }
  const startedAt = new Date().toISOString();
  await putEntity(env, context, 'shopsettings', 'onboarding', {
    startedAt, sampleRecordsRemoved: resetAll ? 0 : targets.length, allShopDataRemoved: resetAll,
  });
  captureForContext(analytics, context, 'onboarding_started', {
    mode: resetAll ? 'all' : 'samples',
    removed_count: targets.length,
  });
  capturePostHogEvent(env, context, 'onboarding_started', {
    reset_mode: resetAll ? 'all' : 'samples',
    removed_record_count: targets.length,
  });
  return json({ startedAt, removed: targets.length, mode: resetAll ? 'all' : 'samples' });
}

async function handlePayroll(request, env, context, analytics) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'office']);
  const [orders, employees, clocks] = await Promise.all([
    listEntities(env, context.shopId, 'orders'),
    listEntities(env, context.shopId, 'employees'),
    listEntities(env, context.shopId, 'jobclockentries'),
  ]);
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day);
  const period = monday.toISOString().slice(0, 10);
  const entries = orders.flatMap(order => payrollLinesForOrder({
    order,
    users: employees,
    clocks,
    periodKey: period,
    nowIso: now.toISOString(),
  }).map(entry => ({ ...entry, syncedAt: now.toISOString() })));
  for (const entry of entries) await putEntity(env, context, 'payrollentries', entry.id, entry);
  captureForContext(analytics, context, 'payroll_synced', {
    period,
    posted_entries: entries.length,
  });
  capturePostHogEvent(env, context, 'payroll_synced', {
    posted_entry_count: entries.length,
    actor_role: context.role,
  });
  return json({ period, postedEntries: entries.length });
}

async function handleTaxReport(request, env, context) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'office']);
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) throw new HttpError(400, 'from and to query parameters are required (YYYY-MM-DD)');
  const [payments, invoices, settings] = await Promise.all([
    listEntities(env, context.shopId, 'payments'),
    listEntities(env, context.shopId, 'invoices'),
    getEntity(env, context.shopId, 'shopsettings', 'tax'),
  ]);
  const tax = settings || { state: 'TX', rate: 8.25, taxId: '', filingFrequency: 'Monthly' };
  return json({ from, to, state: tax.state, taxId: tax.taxId, filingFrequency: tax.filingFrequency, ...buildTaxReport(payments, invoices, Number(tax.rate || 0), from, to) });
}

async function enforceAiRateLimit(env, context) {
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO ai_rate_limits (shop_id, user_id, window_start, request_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(shop_id, user_id) DO UPDATE SET
      window_start = CASE WHEN ? - window_start >= 60000 THEN ? ELSE window_start END,
      request_count = CASE WHEN ? - window_start >= 60000 THEN 1 ELSE request_count + 1 END
  `).bind(context.shopId, context.userId, now, now, now, now).run();
  const row = await env.DB.prepare(
    'SELECT request_count FROM ai_rate_limits WHERE shop_id = ? AND user_id = ?',
  ).bind(context.shopId, context.userId).first();
  if (Number(row?.request_count || 0) > 30) throw new HttpError(429, 'Assistant rate limit exceeded. Try again in a minute.');
}

async function aiAnswer(env, shopId, message, history = [], options = {}) {
  const result = await runAnthropicTurn(env, {
    shopId,
    message,
    history,
    requestedModel: options.requestedModel,
    autoEscalate: options.autoEscalate,
    allowEstimatePreparation: options.source !== 'agentphone',
  });
  const costs = usageCostsForResult(env, result);
  await recordAiUsage(env, {
    shopId,
    userId: options.userId || null,
    channel: options.channel || 'text',
    provider: result.provider || 'anthropic',
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    ...costs,
    metadata: {
      routingReason: result.routingReason,
      source: options.source || 'assistant',
      keySource: result.keySource || null,
      ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom, failureKind: result.failureKind } : {}),
    },
  });
  return {
    text: result.text,
    model: result.model,
    modelFamily: result.family,
    routingReason: result.routingReason,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    keySource: result.keySource || null,
    ...(result.notice ? { notice: result.notice } : {}),
  };
}

async function handleAssistant(request, env, context, analytics) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'office', 'service_writer', 'technician']);
  if (!isAiEnabled(env)) throw new HttpError(503, 'MechPro AI is not enabled');
  if (!env.AI_CHAT_SESSIONS) throw new HttpError(503, 'MechPro AI chat sessions are not configured');
  await enforceAiRateLimit(env, context);
  const body = await requestJson(request);
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!message) throw new HttpError(400, 'A message is required');
  const requestedSessionId = String(body.sessionId || '').trim();
  if (requestedSessionId && !/^[A-Za-z0-9_-]{8,100}$/.test(requestedSessionId)) {
    throw new HttpError(400, 'sessionId is invalid');
  }
  const sessionId = requestedSessionId || crypto.randomUUID();
  const id = env.AI_CHAT_SESSIONS.idFromName(`${context.shopId}:${sessionId}`);
  const stub = env.AI_CHAT_SESSIONS.get(id);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('X-MechPro-Shop-Id', context.shopId);
  headers.set('X-MechPro-User-Id', context.userId);
  headers.set('X-MechPro-Ai-Session-Id', sessionId);
  const sessionResponse = await stub.fetch(new Request('https://ai-session.internal/turn', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, message }),
  }));
  const result = await sessionResponse.json();
  if (!sessionResponse.ok) return json(result, sessionResponse.status);
  captureForContext(analytics, context, 'ai_assistant_queried', {
    model: result.model,
    routing_reason: result.routingReason,
  });
  return json(result);
}

async function handleVoiceSession(request, env, context) {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'A WebSocket upgrade is required');
  }
  requireRole(context, ['admin', 'office', 'service_writer', 'technician']);
  if (!isAiEnabled(env)) throw new HttpError(503, 'MechPro AI is not enabled');
  if (!env.AI_VOICE_SESSIONS) throw new HttpError(503, 'Voice AI is not configured');
  const id = env.AI_VOICE_SESSIONS.newUniqueId();
  const stub = env.AI_VOICE_SESSIONS.get(id);
  const headers = new Headers(request.headers);
  headers.set('X-MechPro-Shop-Id', context.shopId);
  headers.set('X-MechPro-User-Id', context.userId);
  headers.delete('Cookie');
  headers.delete('Cf-Access-Jwt-Assertion');
  return stub.fetch(new Request(request, { headers }));
}

async function handleVoiceTranscription(request, env, context) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'office', 'service_writer', 'technician']);
  await enforceAiRateLimit(env, context);
  const contentType = request.headers.get('Content-Type') || 'audio/webm';
  if (!contentType.toLowerCase().startsWith('audio/')) {
    throw new HttpError(415, 'An audio recording is required');
  }
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 10 * 1024 * 1024) throw new HttpError(413, 'Recorded audio must be 10 MB or smaller');
  const audio = await readAudioWithinLimit(request.body);
  const result = await transcribeDeepgramAudio(env, audio, { contentType });
  const costs = calculateVoiceCost(env, result.voiceSeconds);
  await recordAiUsage(env, {
    shopId: context.shopId,
    userId: context.userId,
    channel: 'voice',
    provider: 'deepgram',
    model: result.model,
    voiceSeconds: result.voiceSeconds,
    ...costs,
    metadata: { source: 'transcription' },
  });
  return json({ transcript: result.transcript, model: result.model });
}

async function saveIntegrationSecret(env, shopId, name, value) {
  const encrypted = await encryptSecret(value, env.INTEGRATION_ENCRYPTION_KEY);
  await env.DB.prepare(`
    INSERT INTO integration_secrets (shop_id, secret_name, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, secret_name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at
  `).bind(shopId, name, encrypted.ciphertext, encrypted.iv, new Date().toISOString()).run();
}

async function getIntegrationSecret(env, shopId, name) {
  const row = await env.DB.prepare(
    'SELECT ciphertext, iv FROM integration_secrets WHERE shop_id = ? AND secret_name = ?',
  ).bind(shopId, name).first();
  return row ? decryptSecret(row.ciphertext, row.iv, env.INTEGRATION_ENCRYPTION_KEY) : '';
}

async function deleteIntegrationSecret(env, shopId, name) {
  await env.DB.prepare(
    'DELETE FROM integration_secrets WHERE shop_id = ? AND secret_name = ?',
  ).bind(shopId, name).run();
}

// Per-shop "vehicle security access" login (AutoAuth). Each shop connects its
// own OEM/AutoAuth account; that login is what unlocks LIVE immobilizer/
// programming/flash for the shop. Credentials are encrypted at rest in D1.
const AUTOAUTH_SECRET_NAME = 'autoauth-login';

async function readAutoAuthLogin(env, shopId) {
  const raw = await getIntegrationSecret(env, shopId, AUTOAUTH_SECRET_NAME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function handleAutoAuth(request, env, context) {
  // Any shop-floor role can see connection status; only shop admins (or the
  // platform) can connect/disconnect the shop's own security-access login.
  if (request.method === 'GET') {
    const login = await readAutoAuthLogin(env, context.shopId);
    return json({
      connected: Boolean(login),
      provider: login?.provider || null,
      accountId: login?.accountId || null,
      connectedAt: login?.connectedAt || null,
    });
  }
  requireRole(context, ['owner', 'admin', 'super_admin']);
  if (request.method === 'POST') {
    const body = await requestJson(request);
    const provider = String(body.provider || 'autoauth_stellantis').trim();
    const accountId = String(body.accountId || '').trim();
    const apiKey = String(body.apiKey || body.password || '').trim();
    if (!accountId || !apiKey) throw new HttpError(400, 'accountId and apiKey are required to connect a vehicle security login');
    const record = { provider, accountId, apiKey, connectedAt: new Date().toISOString(), connectedBy: context.userId };
    await saveIntegrationSecret(env, context.shopId, AUTOAUTH_SECRET_NAME, JSON.stringify(record));
    await recordDiagnosticAudit(env, context, { kind: 'diagnostics.autoauth.connect', provider, accountId });
    return json({ connected: true, provider, accountId, connectedAt: record.connectedAt }, 201);
  }
  if (request.method === 'DELETE') {
    await deleteIntegrationSecret(env, context.shopId, AUTOAUTH_SECRET_NAME);
    await recordDiagnosticAudit(env, context, { kind: 'diagnostics.autoauth.disconnect' });
    return json({ connected: false });
  }
  throw new HttpError(405, 'Method not allowed');
}

const AUTOZONE_SECRET_NAME = 'autozone-pro-login';
const ORDERING_ROLES = ['owner', 'admin', 'service_writer', 'technician'];

async function readAutozoneLogin(env, shopId) {
  const raw = await getIntegrationSecret(env, shopId, AUTOZONE_SECRET_NAME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function handleOrdering(request, env, context, segments) {
  if (segments[1] !== 'autozone') throw new HttpError(404, 'Not found');
  requireRole(context, ORDERING_ROLES);
  if (request.method === 'GET') {
    const login = await readAutozoneLogin(env, context.shopId);
    const reveal = new URL(request.url).searchParams.get('reveal') === '1';
    if (reveal && login) {
      await recordDiagnosticAudit(env, context, { kind: 'ordering.autozone.reveal', username: login.username });
    }
    return json({
      connected: Boolean(login?.username && login?.password),
      username: login?.username || null,
      connectedAt: login?.connectedAt || null,
      ...(reveal && login?.password ? { password: login.password } : {}),
    });
  }
  requireRole(context, ['owner', 'admin']);
  if (request.method === 'POST') {
    const body = await requestJson(request);
    const username = String(body.username || '').trim().slice(0, 120);
    const password = String(body.password || '').trim().slice(0, 200);
    if (!username || !password) throw new HttpError(400, 'Username and password are required');
    const record = { username, password, connectedAt: new Date().toISOString(), connectedBy: context.userId };
    await saveIntegrationSecret(env, context.shopId, AUTOZONE_SECRET_NAME, JSON.stringify(record));
    await recordDiagnosticAudit(env, context, { kind: 'ordering.autozone.connect', username });
    return json({ connected: true, username, connectedAt: record.connectedAt }, 201);
  }
  if (request.method === 'DELETE') {
    await deleteIntegrationSecret(env, context.shopId, AUTOZONE_SECRET_NAME);
    await recordDiagnosticAudit(env, context, { kind: 'ordering.autozone.disconnect' });
    return json({ connected: false });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function handleAgentPhoneConfigure(request, env, context, analytics) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin']);
  const body = await requestJson(request);
  const apiKey = String(body.apiKey || '').trim();
  const agentId = String(body.agentId || '').trim();
  if (!/^ap_[A-Za-z0-9_-]{12,}$/.test(apiKey)) throw new HttpError(400, 'Enter a valid AgentPhone API key');
  if (!/^agt_[A-Za-z0-9_-]{3,128}$/.test(agentId)) throw new HttpError(400, 'Enter a valid AgentPhone agent ID beginning with agt_');
  const contextLimit = Math.min(50, Math.max(0, Number(body.contextLimit ?? 10) || 10));
  const timeout = Math.min(120, Math.max(5, Number(body.timeout ?? 30) || 30));
  const webhookUrl = `${new URL(request.url).origin}/api/agentphone/webhook/${encodeURIComponent(context.shopId)}`;
  const response = await fetch(`https://api.agentphone.ai/v1/agents/${encodeURIComponent(agentId)}/webhook`, {
    method: 'POST',
    headers: { Authorization: ['Bearer', apiKey].join(' '), 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, contextLimit, timeout }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.secret) throw new HttpError(502, result.message || 'AgentPhone rejected the webhook configuration');
  await Promise.all([
    saveIntegrationSecret(env, context.shopId, 'agentphone-api-key', apiKey),
    saveIntegrationSecret(env, context.shopId, 'agentphone-webhook-secret', result.secret),
    putEntity(env, context, 'shopsettings', 'agentphone', {
      provider: 'agentphone.ai', agentId, webhookUrl, contextLimit, timeout,
      status: result.status || 'active', configuredAt: new Date().toISOString(),
    }),
  ]);
  captureForContext(analytics, context, 'agentphone_configured', {
    status: result.status || 'active',
    context_limit: contextLimit,
    timeout_seconds: timeout,
  });
  return json({ configured: true, status: result.status || 'active', agentId, webhookUrl, contextLimit, timeout });
}

async function handleAgentPhoneWebhook(request, env, shopId) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const payload = await request.text();
  const signature = request.headers.get('X-Webhook-Signature') || '';
  const timestamp = request.headers.get('X-Webhook-Timestamp') || '';
  if (!shopId || !signature || !/^\d+$/.test(timestamp)) throw new HttpError(400, 'Missing webhook authentication');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new HttpError(401, 'Expired webhook signature');
  const secret = await getIntegrationSecret(env, shopId, 'agentphone-webhook-secret');
  const expected = `sha256=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
  if (!secret || !constantTimeEqual(signature, expected)) throw new HttpError(401, 'Invalid webhook signature');
  const account = await env.DB.prepare('SELECT suspended FROM accounts WHERE shop_id = ?').bind(shopId).first();
  if (account && Number(account.suspended) === 1) throw new HttpError(403, 'Shop account is suspended');
  const body = parseJson(payload);
  if (body.event === 'agent.call_ended') return json({ received: true });
  if (body.event !== 'agent.message' || !['voice', 'sms', 'mms', 'imessage'].includes(String(body.channel))) return json({ received: true });
  const transcript = String(body.data?.transcript || body.data?.message || '').trim().slice(0, 4000);
  if (!transcript) return json({ text: 'How can I help you today?' });
  return json(await aiAnswer(env, shopId, transcript, body.recentHistory || [], {
    userId: 'agentphone',
    channel: body.channel === 'voice' ? 'voice' : 'text',
    source: 'agentphone',
  }));
}

async function handleFiles(request, env, context, segments, analytics) {
  const action = segments[1];
  if (action === 'presign-upload' && request.method === 'POST') {
    const body = await requestJson(request);
    const kind = String(body.kind || 'file').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'file';
    const contentType = String(body.contentType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
    const contentLength = Number(body.contentLength || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > 15 * 1024 * 1024) throw new HttpError(400, 'File size must be between 1 byte and 15 MB');
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(contentType)) throw new HttpError(400, 'Unsupported file type');
    const key = `shops/${context.shopId}/${kind}/${crypto.randomUUID()}`;
    // Return a same-origin relative URL so browser/desktop sessions keep Access cookies.
    const uploadUrl = `/api/files/upload?key=${encodeURIComponent(key)}`;
    return json({ uploadUrl, key, expiresIn: 300 });
  }
  const key = new URL(request.url).searchParams.get('key') || (action === 'object' ? '' : decodeURIComponent(segments.slice(1).join('/')));
  if (!key || !key.startsWith(`shops/${context.shopId}/`)) throw new HttpError(403, 'File key is outside this shop');
  if (action === 'upload' && request.method === 'PUT') {
    if (!request.body) throw new HttpError(400, 'Request body is required');
    const maxBytes = 15 * 1024 * 1024;
    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > maxBytes) throw new HttpError(413, 'File exceeds 15 MB');
    const received = await storeUploadedFile(env.FILES, key, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
      customMetadata: { shopId: context.shopId, uploadedBy: context.userId },
    }, maxBytes);
    captureForContext(analytics, context, 'file_uploaded', {
      file_kind: key.split('/')[2],
      content_type: request.headers.get('Content-Type') || 'application/octet-stream',
      size_bytes: received,
    });
    return new Response(null, { status: 204 });
  }
  if (action === 'presign-download' && request.method === 'GET') {
    const downloadUrl = new URL('/api/files/object', request.url);
    downloadUrl.searchParams.set('key', key);
    return json({ url: downloadUrl.href, key, expiresIn: 300 });
  }
  if ((action === 'object' || action !== 'upload') && request.method === 'GET') {
    const object = await env.FILES.get(key);
    if (!object) throw new HttpError(404, 'File not found');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'private, max-age=300');
    return new Response(object.body, { headers });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function handleCheckout(request, env, context, analytics) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'office', 'service_writer']);
  const body = await requestJson(request);
  const invoiceNumber = String(body.invoiceNumber || '');
  if (!invoiceNumber) throw new HttpError(400, 'invoiceNumber is required');
  const invoice = await getEntity(env, context.shopId, 'invoices', invoiceNumber);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  const payments = await listPaymentsByInvoice(env, context.shopId, invoiceNumber);
  const balance = openInvoiceBalance(invoice.amount, payments);
  if (balance <= 0) throw new HttpError(409, 'Invoice has no open balance');
  const origin = request.headers.get('Origin');
  const validRedirect = value => {
    try {
      const url = new URL(String(value || ''));
      return origin && url.origin === origin && ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const successUrl = validRedirect(body.successUrl);
  const cancelUrl = validRedirect(body.cancelUrl);
  if (!successUrl || !cancelUrl) throw new HttpError(400, 'Checkout redirects must match the requesting site');
  const stripeKey = await getIntegrationSecret(env, context.shopId, 'stripe-secret-key');
  if (!stripeKey) throw new HttpError(409, 'This shop has not connected a Stripe account yet');
  const params = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(balance * 100)),
    'line_items[0][price_data][product_data][name]': `Invoice ${invoiceNumber}`,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[shopId]': context.shopId,
    'metadata[invoiceNumber]': invoiceNumber,
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, 'Stripe rejected the checkout session request');
  captureForContext(analytics, context, 'checkout_session_created', {
    amount: balance,
    currency: 'usd',
    processor: 'stripe',
  });
  capturePostHogEvent(env, context, 'payment_checkout_started', {
    amount: balance,
    currency: 'usd',
    actor_role: context.role,
  });
  return json({ url: result.url, sessionId: result.id });
}

async function handlePaymentRecord(request, env, context, analytics) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'office', 'service_writer']);
  const result = await recordPaymentToTarget(env, context, await requestJson(request));
  captureForContext(analytics, context, 'payment_recorded', {
    amount: result.payment.amount,
    method: result.payment.method,
    target_type: result.payment.targetType,
    payment_status: result.summary.status,
  });
  capturePostHogEvent(env, context, 'payment_completed', {
    amount: result.payment.amount,
    currency: 'usd',
    processor: result.payment.method,
    target_type: result.payment.targetType,
    actor_role: context.role,
  });
  return json(result, 201);
}

function stripeWebhookUrlForShop(request, shopId) {
  const url = new URL(request.url);
  return `${url.origin}/api/payments/webhook/${encodeURIComponent(shopId)}`;
}

async function handleStripeStatus(request, env, context) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'super_admin']);
  const shopId = context.shopId;
  if (!shopId) throw new HttpError(400, 'Shop context is required');
  const [secretKey, webhookSecret, publishableKey] = await Promise.all([
    getIntegrationSecret(env, shopId, 'stripe-secret-key'),
    getIntegrationSecret(env, shopId, 'stripe-webhook-secret'),
    getIntegrationSecret(env, shopId, 'stripe-publishable-key'),
  ]);
  const configured = Boolean(secretKey && webhookSecret);
  return json({
    configured,
    shopId,
    provider: 'stripe',
    webhookUrl: stripeWebhookUrlForShop(request, shopId),
    hasSecretKey: Boolean(secretKey),
    hasWebhookSecret: Boolean(webhookSecret),
    hasPublishableKey: Boolean(publishableKey),
  });
}

async function handleStripeConfigure(request, env, context, analytics) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  requireRole(context, ['admin', 'super_admin']);
  const shopId = context.shopId;
  if (!shopId) throw new HttpError(400, 'Shop context is required');
  const body = await requestJson(request);
  const secretKey = String(body.secretKey || '').trim();
  const webhookSecret = String(body.webhookSecret || '').trim();
  const publishableKey = String(body.publishableKey || '').trim();
  const updatingSecrets = Boolean(secretKey || webhookSecret);
  if (updatingSecrets) {
    if (!/^sk_(test|live)_/.test(secretKey) || !/^whsec_/.test(webhookSecret)) {
      throw new HttpError(400, 'Valid Stripe secret and webhook signing keys are required');
    }
    await Promise.all([
      saveIntegrationSecret(env, shopId, 'stripe-secret-key', secretKey),
      saveIntegrationSecret(env, shopId, 'stripe-webhook-secret', webhookSecret),
    ]);
  }
  if (publishableKey) {
    if (!/^pk_(test|live)_/.test(publishableKey)) throw new HttpError(400, 'Publishable key must start with pk_test_ or pk_live_');
    const secret = secretKey || await getIntegrationSecret(env, shopId, 'stripe-secret-key');
    if (!secret) throw new HttpError(409, 'Save the Stripe secret key before the publishable key');
    if (stripeKeyMode(secret) !== stripeKeyMode(publishableKey)) {
      throw new HttpError(400, 'Publishable key must be test or live to match the secret key');
    }
    await saveIntegrationSecret(env, shopId, 'stripe-publishable-key', publishableKey);
  }
  if (!updatingSecrets && !publishableKey) {
    throw new HttpError(400, 'Valid Stripe secret and webhook signing keys are required');
  }
  captureForContext(analytics, context, 'stripe_configured', { shop_id: shopId, provider: 'stripe' });
  capturePostHogEvent(env, context, 'stripe_payments_configured', {
    shop_id: shopId,
    actor_role: context.role,
  });
  return json({
    configured: true,
    shopId,
    provider: 'stripe',
    webhookUrl: stripeWebhookUrlForShop(request, shopId),
  });
}

async function handleStripeWebhook(request, env, shopId, analytics) {
  analytics.distinctId = `stripe-webhook:${shopId}`;
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const payload = await request.text();
  const signature = request.headers.get('Stripe-Signature') || '';
  const fields = signature.split(',').map(item => item.trim().split('=', 2));
  const timestamp = fields.find(([key]) => key === 't')?.[1];
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!shopId || !timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new HttpError(400, 'Invalid Stripe signature');
  }
  const secret = await getIntegrationSecret(env, shopId, 'stripe-webhook-secret');
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  if (!secret || !signatures.some(value => constantTimeEqual(value, expected))) throw new HttpError(400, 'Invalid Stripe signature');
  const event = parseJson(payload);
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const invoiceNumber = session.metadata?.invoiceNumber;
    if (invoiceNumber && session.metadata?.shopId === shopId && session.payment_status === 'paid' && session.currency === 'usd') {
      const invoice = await getEntity(env, shopId, 'invoices', invoiceNumber);
      if (!invoice) throw new HttpError(400, 'Invoice not found');
      const id = String(session.id);
      if (await getEntity(env, shopId, 'payments', id)) return json({ received: true, duplicate: true });
      const context = { shopId, userId: 'stripe-webhook' };
      const payments = await listPaymentsByInvoice(env, shopId, invoiceNumber);
      const amount = Number(session.amount_total || 0) / 100;
      if (amount <= 0 || amount > openInvoiceBalance(invoice.amount, payments)) throw new HttpError(400, 'Payment amount exceeds the invoice balance');
      await recordPaymentToTarget(env, context, {
        targetType: 'invoice',
        targetId: invoiceNumber,
        amount,
        method: 'processor',
        receivedAt: new Date().toISOString(),
        reference: id,
        note: 'Stripe checkout payment',
      }, { paymentId: id });
      capturePostHogEvent(env, { shopId, userId: `stripe-webhook:${shopId}` }, 'payment_completed', {
        amount,
        currency: 'usd',
        processor: 'stripe',
        $process_person_profile: false,
      });
    }
  }
  if (event.type === 'payment_intent.succeeded') {
    const record = terminalPaymentRecord(event.data?.object, shopId);
    if (record) {
      try {
        await recordPaymentToTarget(env, { shopId, userId: 'stripe-webhook' }, record.body, { paymentId: record.paymentId });
      } catch (error) {
        if (error?.status !== 409) throw error;
      }
    }
  }
  return json({ received: true });
}

async function handleEntitlement(request, env, context) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  if (context.role === 'super_admin') return json({ active: true, status: 'platform', expiresAt: null });
  const account = await env.DB.prepare(
    'SELECT suspended, subscription_status, subscription_expires_at FROM accounts WHERE shop_id = ?',
  ).bind(context.shopId).first();
  if (!account) return json({ active: false, status: 'missing', expiresAt: null }, 403);
  const expiresAt = account.subscription_expires_at || null;
  const expired = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  const status = Number(account.suspended) === 1 ? 'suspended' : expired ? 'expired' : String(account.subscription_status || 'missing');
  const active = Number(account.suspended) !== 1 && ['active', 'trialing'].includes(status) && !expired;
  return json({ active, status, expiresAt }, active ? 200 : 403);
}

async function handleAdmin(request, env, context, segments, analytics) {
  requireRole(context, ['super_admin']);
  if (segments.length === 2 && request.method === 'GET') {
    const accounts = await env.DB.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    const users = await env.DB.prepare('SELECT email, name, shop_id, role, enabled FROM users ORDER BY email').all();
    return json(accounts.results.map(account => ({
      id: account.shop_id, shopId: account.shop_id, shopName: account.shop_name,
      ownerEmail: account.owner_email, ownerName: account.owner_name,
      creditBalance: Number(account.credit_balance ?? 0), subscriptionStatus: account.subscription_status,
      subscriptionExpiresAt: account.subscription_expires_at, suspended: Boolean(account.suspended),
      createdAt: account.created_at, updatedAt: account.updated_at,
      users: users.results.filter(user => user.shop_id === account.shop_id).map(user => ({
        email: user.email, name: user.name, shopId: user.shop_id, role: user.role,
        enabled: Boolean(user.enabled), status: user.enabled ? 'ACTIVE' : 'DISABLED',
      })),
    })));
  }
  if (segments.length === 2 && request.method === 'POST') {
    const body = await requestJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const ownerName = String(body.ownerName || '').trim();
    const shopName = String(body.shopName || '').trim();
    const shopId = String(body.shopId || '').trim().toLowerCase();
    const planId = String(body.planId || 'shop').trim() || 'shop';
    if (!isPublicPlan(planId) && !isFoundingPlan(planId)) throw new HttpError(400, 'Choose Solo, Shop, Shop Pro, Enterprise, or a Founding Member plan');
    const accountMode = String(body.accountMode || body.subscriptionStatus || 'trialing').trim().toLowerCase();
    const trialDaysRaw = body.trialDays;
    const trialDays = trialDaysRaw === '' || trialDaysRaw === null || trialDaysRaw === undefined
      ? null
      : Math.max(0, Math.min(3650, Math.round(Number(trialDaysRaw))));
    if (!email || !ownerName || !shopName || !validShopId(shopId)) throw new HttpError(400, 'Owner name, email, shop name, and a valid shop ID are required');
    if (!['trialing', 'active', 'comped'].includes(accountMode)) throw new HttpError(400, 'accountMode must be trialing, active, or comped');
    if (trialDaysRaw !== null && trialDaysRaw !== undefined && trialDaysRaw !== '' && !Number.isFinite(trialDays)) {
      throw new HttpError(400, 'trialDays must be a number of days (0 = no expiry)');
    }
    const existing = await env.DB.prepare(
      'SELECT shop_id FROM accounts WHERE shop_id = ? UNION ALL SELECT shop_id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1',
    ).bind(shopId, email).first();
    if (existing) throw new HttpError(409, 'An account already uses this shop ID or owner email');
    const now = new Date();
    const nowIso = now.toISOString();
    const subscriptionStatus = accountMode === 'active' ? 'active' : 'trialing';
    let subscriptionExpiresAt = null;
    if (accountMode !== 'active' && trialDays && trialDays > 0) {
      subscriptionExpiresAt = new Date(now.getTime() + trialDays * 86400000).toISOString();
    }
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, subscription_status, subscription_expires_at, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(shopId, shopName, email, ownerName, subscriptionStatus, subscriptionExpiresAt, nowIso, nowIso, context.userId),
      env.DB.prepare(`
        INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?, ?)
      `).bind(email, shopId, ownerName, nowIso, nowIso),
      env.DB.prepare(`
        INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
        VALUES (?, 'employees', ?, ?, ?, ?, ?)
      `).bind(shopId, `owner-${shopId}`, JSON.stringify({
        id: `owner-${shopId}`, shopId, name: ownerName, email, role: 'admin', title: 'Owner',
        department: 'Administration', active: true, createdAt: nowIso, updatedAt: nowIso,
      }), context.userId, nowIso, nowIso),
    ]);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO shops (id, name, slug, timezone, billing_status, created_at, updated_at)
        VALUES (?, ?, ?, 'America/Chicago', ?, ?, ?)
      `).bind(shopId, shopName, shopId, subscriptionStatus, nowIso, nowIso),
      env.DB.prepare(`
        INSERT OR IGNORE INTO shop_memberships (shop_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)
      `).bind(shopId, email, nowIso, nowIso),
      env.DB.prepare(`
        INSERT INTO subscriptions (shop_id, plan_id, status, current_period_end, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(shop_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status,
          current_period_end = excluded.current_period_end, updated_at = excluded.updated_at
      `).bind(shopId, planId, subscriptionStatus, subscriptionExpiresAt, nowIso),
    ]);
    return json({
      id: shopId, shopId, shopName, ownerEmail: email, ownerName, creditBalance: 0,
      subscriptionStatus, subscriptionExpiresAt, planId, accountMode, trialDays,
      createdAt: nowIso, updatedAt: nowIso,
    }, 201);
  }
  const target = decodeURIComponent(segments[2] || '');
  const action = segments[3];
  if (request.method === 'POST' && action === 'integrations' && segments[4] === 'stripe') {
    if (!validShopId(target)) throw new HttpError(400, 'A valid shop ID is required');
    const body = await requestJson(request);
    const secretKey = String(body.secretKey || '').trim();
    const webhookSecret = String(body.webhookSecret || '').trim();
    const publishableKey = String(body.publishableKey || '').trim();
    if (!/^sk_(test|live)_/.test(secretKey) || secretKey.length < 30 || !/^whsec_/.test(webhookSecret)) {
      throw new HttpError(400, 'Valid Stripe secret and webhook signing keys are required');
    }
    if (publishableKey && (!/^pk_(test|live)_/.test(publishableKey) || stripeKeyMode(secretKey) !== stripeKeyMode(publishableKey))) {
      throw new HttpError(400, 'Publishable key must be test or live to match the secret key');
    }
    const writes = [
      saveIntegrationSecret(env, target, 'stripe-secret-key', secretKey),
      saveIntegrationSecret(env, target, 'stripe-webhook-secret', webhookSecret),
    ];
    if (publishableKey) writes.push(saveIntegrationSecret(env, target, 'stripe-publishable-key', publishableKey));
    await Promise.all(writes);
    return json({ configured: true, shopId: target, provider: 'stripe', hasPublishableKey: Boolean(publishableKey) });
  }
  if (request.method === 'POST' && ['reset-password', 'set-password'].includes(action)) {
    throw new HttpError(501, 'Passwords are managed by the Cloudflare Access identity provider');
  }
  if (request.method === 'POST' && action === 'credits') {
    const body = await requestJson(request);
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const reason = String(body.reason || '').trim();
    if (!validShopId(target) || !Number.isFinite(amount) || amount <= 0 || !reason) throw new HttpError(400, 'A valid shop ID, positive credit amount, and reason are required');
    const result = await env.DB.prepare(
      'UPDATE accounts SET credit_balance = credit_balance + ?, updated_at = ? WHERE shop_id = ?',
    ).bind(amount, new Date().toISOString(), target).run();
    if (!result.meta.changes) throw new HttpError(404, 'Customer account not found');
    return json({ id: crypto.randomUUID(), shopId: target, amount, reason, createdAt: new Date().toISOString() }, 201);
  }
  if (request.method === 'POST' && action === 'status') {
    const body = await requestJson(request);
    if (!validShopId(target) || typeof body.suspended !== 'boolean') throw new HttpError(400, 'A valid shop ID and suspended status are required');
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      'UPDATE accounts SET suspended = ?, updated_at = ? WHERE shop_id = ?',
    ).bind(body.suspended ? 1 : 0, now, target).run();
    if (!result.meta.changes) throw new HttpError(404, 'Customer account not found');
    await env.DB.prepare('UPDATE users SET enabled = ?, updated_at = ? WHERE shop_id = ?').bind(body.suspended ? 0 : 1, now, target).run();
    if (body.suspended) {
      const userRows = await env.DB.prepare('SELECT id FROM users WHERE shop_id = ?').bind(target).all();
      await revokeSessionsForUserIds(env, (userRows.results || []).map((row) => row.id), now);
    }
    captureForContext(analytics, context, 'account_status_changed', {
      target_shop_id: target,
      suspended: body.suspended,
    });
    return json({ shopId: target, suspended: body.suspended });
  }
  if (request.method === 'POST' && action === 'subscription') {
    if (!validShopId(target)) throw new HttpError(400, 'A valid shop ID is required');
    const body = await requestJson(request);
    const mode = String(body.mode || body.subscriptionStatus || '').trim().toLowerCase();
    const planId = String(body.planId || 'shop').trim() || 'shop';
    if (!isPublicPlan(planId) && !isFoundingPlan(planId)) throw new HttpError(400, 'Choose Solo, Shop, Shop Pro, Enterprise, or a Founding Member plan');
    const trialDays = body.trialDays === '' || body.trialDays === null || body.trialDays === undefined
      ? null
      : Math.max(0, Math.min(3650, Math.round(Number(body.trialDays))));
    if (!['trialing', 'active', 'comped', 'extend'].includes(mode)) {
      throw new HttpError(400, 'mode must be trialing, active, comped, or extend');
    }
    if (body.trialDays !== undefined && body.trialDays !== null && body.trialDays !== '' && !Number.isFinite(trialDays)) {
      throw new HttpError(400, 'trialDays must be a number of days');
    }
    const account = await env.DB.prepare('SELECT * FROM accounts WHERE shop_id = ?').bind(target).first();
    if (!account) throw new HttpError(404, 'Customer account not found');
    const now = new Date();
    const nowIso = now.toISOString();
    let subscriptionStatus = String(account.subscription_status || 'trialing');
    let subscriptionExpiresAt = account.subscription_expires_at || null;
    if (mode === 'active') {
      subscriptionStatus = 'active';
      subscriptionExpiresAt = null;
    } else if (mode === 'comped' || mode === 'trialing') {
      subscriptionStatus = 'trialing';
      subscriptionExpiresAt = trialDays && trialDays > 0
        ? new Date(now.getTime() + trialDays * 86400000).toISOString()
        : null;
    } else if (mode === 'extend') {
      subscriptionStatus = 'trialing';
      const days = trialDays && trialDays > 0 ? trialDays : 30;
      const base = subscriptionExpiresAt && new Date(subscriptionExpiresAt).getTime() > now.getTime()
        ? new Date(subscriptionExpiresAt)
        : now;
      subscriptionExpiresAt = new Date(base.getTime() + days * 86400000).toISOString();
    }
    await env.DB.prepare(
      'UPDATE accounts SET subscription_status = ?, subscription_expires_at = ?, updated_at = ? WHERE shop_id = ?',
    ).bind(subscriptionStatus, subscriptionExpiresAt, nowIso, target).run();
    await env.DB.prepare('UPDATE shops SET billing_status = ?, updated_at = ? WHERE id = ?').bind(subscriptionStatus, nowIso, target).run();
    await env.DB.prepare(`
      INSERT INTO subscriptions (shop_id, plan_id, status, current_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status,
        current_period_end = excluded.current_period_end, updated_at = excluded.updated_at
    `).bind(target, planId, subscriptionStatus, subscriptionExpiresAt, nowIso, nowIso).run();
    return json({
      shopId: target,
      subscriptionStatus,
      subscriptionExpiresAt,
      planId,
      mode,
    });
  }
  throw new HttpError(405, 'Method not allowed');
}

async function ensureSaasUser(env, email, name) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new HttpError(400, 'A valid email is required');
  const existing = await env.DB.prepare(
    'SELECT id, email, shop_id, role, name, enabled FROM users WHERE email = ? COLLATE NOCASE',
  ).bind(normalized).first();
  if (existing) {
    if (!existing.id) {
      const userId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE users SET id = ?, updated_at = ? WHERE email = ? COLLATE NOCASE')
        .bind(userId, now, normalized).run();
      existing.id = userId;
    }
    // Do not attach founding plans to existing shops on login. Claim emails are
    // unverified, so applying here would let a stolen invite rewrite a live plan.
    return existing;
  }
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const shopId = `shop-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const ownerName = String(name || normalized.split('@')[0] || 'Owner').trim();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO shops (id, name, slug, timezone, billing_status, created_at, updated_at)
      VALUES (?, ?, ?, 'America/Chicago', 'trialing', ?, ?)
    `).bind(shopId, `${ownerName}'s shop`, shopId.toLowerCase(), now, now),
    env.DB.prepare(`
      INSERT INTO shop_memberships (shop_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, 'owner', 'active', ?, ?)
    `).bind(shopId, userId, now, now),
    env.DB.prepare(`
      INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)
    `).bind(userId, normalized, shopId, ownerName, now, now),
  ]);
  await applyPendingFoundingClaim(env, {
    email: normalized,
    shopId,
    ownerName,
    shopName: `${ownerName}'s shop`,
  });
  return { id: userId, email: normalized, shop_id: shopId, role: 'admin', name: ownerName, enabled: 1 };
}

function requireGoogleConfig(env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new HttpError(503, 'Google sign-in is not configured');
  return { clientId, clientSecret };
}

function randomBase64Url(byteLength = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function desktopHandoffPage(token) {
  const link = `mechpro://auth?token=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>Return to MechPro</title>
  <style>
    body { font-family: "Segoe UI", sans-serif; background: #18252b; color: #f4f7f8; margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { max-width: 28rem; padding: 2rem; }
    a { display: inline-block; margin-top: 1rem; background: #e8a317; color: #18252b; text-decoration: none; font-weight: 700; padding: 0.8rem 1.1rem; border-radius: 0.4rem; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Google sign-in succeeded</h1>
    <p>Open MechPro to finish signing in. If Windows asks which app to use, choose MechPro.</p>
    <a href="${link}">Open MechPro</a>
  </main>
</body>
</html>`;
}

function googleAuthOrigin(request, env) {
  const configured = String(env.GOOGLE_REDIRECT_ORIGIN || '').trim();
  if (configured) return new URL(configured).origin;
  const hostname = new URL(request.url).hostname.replace(/^www\./, '');
  if (hostname === 'yourcarguy806.com') return 'https://www.yourcarguy806.com';
  return new URL(request.url).origin;
}

function googleRedirectUri(request, env) {
  return new URL('/api/auth/google/callback', googleAuthOrigin(request, env)).toString();
}

async function handleGoogleSignIn(request, env) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const { clientId } = requireGoogleConfig(env);
  const requestUrl = new URL(request.url);
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const verifier = randomBase64Url(48);
  const returnTo = safeReturnPath(requestUrl.searchParams.get('returnTo') || '/');
  const desktop = requestUrl.searchParams.get('desktop') === '1';
  const origin = googleAuthOrigin(request, env);
  if (requestUrl.origin !== origin) {
    const next = new URL(`${requestUrl.pathname}${requestUrl.search}`, origin);
    return new Response(null, {
      status: 302,
      headers: { Location: next.toString(), 'Cache-Control': 'no-store' },
    });
  }
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(request, env),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const headers = new Headers({ Location: authorizationUrl.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', temporaryCookieHeader(GOOGLE_STATE_COOKIE, state));
  headers.append('Set-Cookie', temporaryCookieHeader(GOOGLE_NONCE_COOKIE, nonce));
  headers.append('Set-Cookie', temporaryCookieHeader(GOOGLE_VERIFIER_COOKIE, verifier));
  headers.append('Set-Cookie', temporaryCookieHeader(GOOGLE_RETURN_COOKIE, returnTo));
  headers.append('Set-Cookie', temporaryCookieHeader(GOOGLE_DESKTOP_COOKIE, desktop ? '1' : '0'));
  return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(request, env) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const { clientId, clientSecret } = requireGoogleConfig(env);
  const url = new URL(request.url);
  const providerError = String(url.searchParams.get('error') || '');
  if (providerError) throw new HttpError(401, providerError === 'access_denied' ? 'Google sign-in was cancelled' : 'Google sign-in failed');
  const code = String(url.searchParams.get('code') || '');
  const state = String(url.searchParams.get('state') || '');
  const expectedState = getCookieValue(request, GOOGLE_STATE_COOKIE);
  const nonce = getCookieValue(request, GOOGLE_NONCE_COOKIE);
  const verifier = getCookieValue(request, GOOGLE_VERIFIER_COOKIE);
  if (!code || !state || !expectedState || !nonce || !verifier || !constantTimeEqual(state, expectedState)) {
    throw new HttpError(401, 'Google sign-in request is invalid or expired');
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(request, env),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.id_token) throw new HttpError(401, 'Google could not verify this sign-in');
  let claims;
  try {
    claims = await verifyGoogleIdToken(tokenPayload.id_token, clientId, nonce);
  } catch {
    throw new HttpError(401, 'Google could not verify this sign-in');
  }
  const email = String(claims.email || '').trim().toLowerCase();
  const user = await ensureSaasUser(env, email, String(claims.name || email.split('@')[0]));
  if (Number(user.enabled) !== 1) {
    throw new HttpError(403, 'This account has been disabled. Contact your shop administrator.');
  }
  const isDesktop = getCookieValue(request, GOOGLE_DESKTOP_COOKIE) === '1';
  if (isDesktop) {
    const handoffToken = crypto.randomUUID().replaceAll('-', '');
    const handoffHash = await hashValue(handoffToken);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO login_tokens (id, email, token_hash, return_to, expires_at, created_at, auth_method)
      VALUES (?, ?, ?, ?, ?, ?, 'google')
      ON CONFLICT(email) DO UPDATE SET
        token_hash = excluded.token_hash,
        return_to = excluded.return_to,
        expires_at = excluded.expires_at,
        used_at = NULL,
        created_at = excluded.created_at,
        auth_method = excluded.auth_method
    `).bind(
      crypto.randomUUID(),
      email,
      handoffHash,
      safeReturnPath(getCookieValue(request, GOOGLE_RETURN_COOKIE), '/'),
      new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      now,
    ).run();
    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    });
    for (const name of [GOOGLE_STATE_COOKIE, GOOGLE_NONCE_COOKIE, GOOGLE_VERIFIER_COOKIE, GOOGLE_RETURN_COOKIE, GOOGLE_DESKTOP_COOKIE]) {
      headers.append('Set-Cookie', clearCookieHeader(name));
    }
    return new Response(desktopHandoffPage(handoffToken), { status: 200, headers });
  }
  const sessionToken = crypto.randomUUID().replaceAll('-', '');
  const sessionId = crypto.randomUUID();
  const sessionHash = await hashValue(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, sessionHash, expiresAt, new Date().toISOString()).run();
  const posthog = getPostHog(env);
  posthog?.identify({
    distinctId: String(user.id),
    properties: { email: user.email, name: user.name, role: user.role, shop_id: user.shop_id },
  });
  capturePostHogEvent(env, { userId: String(user.id), shopId: user.shop_id }, 'user_signed_in', {
    auth_method: 'google',
    actor_role: user.role,
  });
  const headers = new Headers({
    Location: new URL(safeReturnPath(getCookieValue(request, GOOGLE_RETURN_COOKIE), '/'), url.origin).toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', sessionCookieHeader(sessionToken));
  for (const name of [GOOGLE_STATE_COOKIE, GOOGLE_NONCE_COOKIE, GOOGLE_VERIFIER_COOKIE, GOOGLE_RETURN_COOKIE, GOOGLE_DESKTOP_COOKIE]) {
    headers.append('Set-Cookie', clearCookieHeader(name));
  }
  return new Response(null, { status: 302, headers });
}

const SIGN_IN_RESEND_COOLDOWN_MS = 60 * 1000;

function signInResendRetryAfter(recent, now = Date.now()) {
  if (!recent?.created_at || recent.used_at) return 0;
  if (recent.expires_at) {
    const expires = new Date(recent.expires_at).getTime();
    if (Number.isFinite(expires) && expires <= now) return 0;
  }
  const created = new Date(recent.created_at).getTime();
  if (!Number.isFinite(created)) return 0;
  const remaining = SIGN_IN_RESEND_COOLDOWN_MS - (now - created);
  if (remaining <= 0) return 0;
  return Math.max(1, Math.min(60, Math.ceil(remaining / 1000)));
}

async function handleMagicLink(request, env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const contentType = request.headers.get('Content-Type') || '';
  const raw = await request.text();
  let body = {};
  if (raw) {
    if (contentType.includes('application/json')) body = parseJson(raw);
    else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      body = Object.fromEntries(new URLSearchParams(raw).entries());
    }
  }
  const email = String(body.email || '').trim().toLowerCase();
  const returnTo = safeReturnPath(body.returnTo || body.return_to || body.redirectTo);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const exposeLoginLink = env.AUTH_EXPOSE_LOGIN_LINK === '1';
  const sendDirectly = canSendLoginEmail(env);
  if (!env.AUTH_EMAIL_WEBHOOK && !exposeLoginLink && !sendDirectly) {
    throw new HttpError(503, 'Email sign-in is unavailable. Ask an administrator to configure email delivery (AUTH_EMAIL_WEBHOOK).');
  }
  const recent = await env.DB.prepare(
    'SELECT created_at, used_at, expires_at FROM login_tokens WHERE email = ? COLLATE NOCASE LIMIT 1',
  ).bind(email).first();
  const retryAfter = signInResendRetryAfter(recent);
  if (retryAfter) {
    const unit = retryAfter === 1 ? 'second' : 'seconds';
    throw new HttpError(
      429,
      `A sign-in link was just sent. Check your inbox and spam folder, then try again in ${retryAfter} ${unit}.`,
      { 'Retry-After': String(retryAfter) },
    );
  }
  const token = crypto.randomUUID().replaceAll('-', '');
  const tokenHash = await hashValue(token);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO login_tokens (id, email, token_hash, return_to, expires_at, created_at, auth_method)
    VALUES (?, ?, ?, ?, ?, ?, 'magic_link')
    ON CONFLICT(email) DO UPDATE SET
      token_hash = excluded.token_hash,
      return_to = excluded.return_to,
      expires_at = excluded.expires_at,
      used_at = NULL,
      created_at = excluded.created_at,
      auth_method = excluded.auth_method
  `).bind(crypto.randomUUID(), email, tokenHash, returnTo, expiresAt, now).run();
  const loginUrl = new URL('/api/auth/callback', new URL(request.url).origin);
  loginUrl.searchParams.set('token', token);
  try {
    if (sendDirectly) {
      await deliverLoginEmail(env, { email, loginUrl: loginUrl.toString() });
    } else if (env.AUTH_EMAIL_WEBHOOK) {
      const headers = { 'Content-Type': 'application/json' };
      if (env.AUTH_EMAIL_WEBHOOK_SECRET) headers.Authorization = ['Bearer', env.AUTH_EMAIL_WEBHOOK_SECRET].join(' ');
      const delivery = await fetch(env.AUTH_EMAIL_WEBHOOK, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, loginUrl: loginUrl.toString(), returnTo }),
      });
      if (!delivery.ok) throw new HttpError(502, 'Unable to deliver the sign-in email');
    }
  } catch (error) {
    await env.DB.prepare('DELETE FROM login_tokens WHERE token_hash = ?').bind(tokenHash).run();
    throw signInDeliveryFailure(error);
  }
  const payload = {
    ok: true,
    sent: true,
    email,
    returnTo,
    message: exposeLoginLink
      ? 'Open the sign-in link to continue. Email delivery is not configured yet.'
      : 'If the email matches an account, a sign-in link was sent.',
  };
  if (exposeLoginLink) payload.loginUrl = loginUrl.toString();
  return json(payload);
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token) throw new HttpError(400, 'Missing login token');
  const tokenHash = await hashValue(token);
  const loginToken = await env.DB.prepare(
    'SELECT id, email, return_to, expires_at, used_at, auth_method FROM login_tokens WHERE token_hash = ? LIMIT 1',
  ).bind(tokenHash).first();
  if (!loginToken) throw new HttpError(401, 'The sign-in link is invalid or expired');
  if (loginToken.used_at || new Date(loginToken.expires_at).getTime() <= Date.now()) {
    throw new HttpError(401, 'The sign-in link has expired');
  }
  const email = String(loginToken.email || '').trim().toLowerCase();
  const user = await ensureSaasUser(env, email, email.split('@')[0]);
  if (Number(user.enabled) !== 1) {
    throw new HttpError(403, 'This account has been disabled. Contact your shop administrator.');
  }
  const sessionToken = crypto.randomUUID().replaceAll('-', '');
  const sessionId = crypto.randomUUID();
  const sessionHash = await hashValue(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(sessionId, user.id, sessionHash, expiresAt, new Date().toISOString()),
    env.DB.prepare('UPDATE login_tokens SET used_at = ? WHERE id = ?').bind(new Date().toISOString(), loginToken.id),
  ]);
  const posthog = getPostHog(env);
  posthog?.identify({
    distinctId: String(user.id),
    properties: {
      email: user.email,
      name: user.name,
      role: user.role,
      shop_id: user.shop_id,
    },
  });
  capturePostHogEvent(env, { userId: String(user.id), shopId: user.shop_id }, 'user_signed_in', {
    auth_method: loginToken.auth_method || 'magic_link',
    actor_role: user.role,
  });
  const redirect = new URL(safeReturnPath(loginToken.return_to), url.origin);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      'Set-Cookie': sessionCookieHeader(sessionToken),
      'Cache-Control': 'no-store',
    },
  });
}

async function handleLogout(request, env) {
  // Logout must be idempotent: it still clears the cookie even when the session
  // is already expired or revoked (resolveContext throws for those cases).
  let context = null;
  try {
    context = await resolveContext(request, env);
  } catch {
    context = null;
  }
  const sessionId = context?.sessionId || '';
  if (sessionId) {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), sessionId).run();
  }
  capturePostHogEvent(env, context ?? { userId: undefined, shopId: undefined }, 'user_logged_out', {
    actor_role: context?.role,
  });
  return new Response(JSON.stringify({ ok: true, loggedOut: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookieHeader(APP_SESSION_COOKIE) },
  });
}

async function handleAuth(request, env, segments, analytics) {
  const action = segments[1] || '';
  if (action === 'magic-link') return handleMagicLink(request, env);
  if (action === 'send-login') return handleSendLogin(request, env);
  if (action === 'callback') return handleAuthCallback(request, env);
  if (action === 'google' && segments[2] === 'callback') return handleGoogleCallback(request, env);
  if (action === 'google') return handleGoogleSignIn(request, env);
  if (action === 'logout') return handleLogout(request, env);
  if (action === 'session') {
    const context = await resolveContext(request, env);
    return handleAuthSession(request, context, analytics || { client: null });
  }
  throw new HttpError(404, 'Not found');
}

async function handleBilling(request, env, context, segments) {
  const action = segments[1] || '';
  if (action === 'checkout' && request.method === 'POST') {
    const body = await requestJson(request);
    const planId = String(body.planId || 'shop').trim() || 'shop';
    const interval = String(body.interval || 'monthly').trim().toLowerCase();
    if (!['monthly', 'annual'].includes(interval)) throw new HttpError(400, 'Billing interval must be monthly or annual');
    if (!context?.shopId) throw new HttpError(401, 'You must be signed in to upgrade');
    if (!['admin', 'super_admin'].includes(context.role)) throw new HttpError(403, 'Only shop admins can upgrade billing');
    const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ? OR stripe_price_id = ? LIMIT 1').bind(planId, planId).first();
    if (!plan || Number(plan.active) === 0) throw new HttpError(404, 'Billing plan not found');
    if (Number(plan.public) === 0 || Number(plan.founding) === 1) throw new HttpError(403, 'Founding Member plans are claimed from an invite link');
    const stripeKey = env.STRIPE_SECRET_KEY || '';
    const priceId = stripePriceForPlan(env, plan.id, interval);
    if (stripeKey && priceId) {
      const origin = new URL(request.url).origin;
      const successUrl = String(body.successUrl || `${origin}/?billing=success`);
      const cancelUrl = String(body.cancelUrl || `${origin}/?billing=cancelled`);
      let customer = await env.DB.prepare(
        'SELECT stripe_customer_id FROM billing_customers WHERE shop_id = ?',
      ).bind(context.shopId).first();
      if (!customer?.stripe_customer_id) {
        const customerParams = new URLSearchParams({
          email: String(context.email || ''),
          name: String(context.name || ''),
          'metadata[shopId]': context.shopId,
        });
        const customerResponse = await fetch('https://api.stripe.com/v1/customers', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${btoa(`${stripeKey}:`)}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': `billing-customer-${context.shopId}`,
          },
          body: customerParams,
        });
        const created = await customerResponse.json().catch(() => ({}));
        if (!customerResponse.ok || !created.id) throw new HttpError(502, created.error?.message || 'Stripe customer could not be created');
        await env.DB.prepare(`
          INSERT INTO billing_customers (shop_id, stripe_customer_id, created_at) VALUES (?, ?, ?)
          ON CONFLICT(shop_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id
        `).bind(context.shopId, created.id, new Date().toISOString()).run();
        customer = { stripe_customer_id: created.id };
      }
      const params = new URLSearchParams({
        mode: 'subscription',
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer: customer.stripe_customer_id,
        client_reference_id: context.shopId,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'metadata[shopId]': context.shopId,
        'metadata[planId]': plan.id,
        'metadata[interval]': interval,
        'subscription_data[metadata][shopId]': context.shopId,
        'subscription_data[metadata][planId]': plan.id,
      });
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok || !session.url) throw new HttpError(502, session.error?.message || 'Stripe checkout could not be created');
      capturePostHogEvent(env, context, 'billing_checkout_started', {
        plan_id: plan.id,
        provider: 'stripe',
        actor_role: context.role,
      });
      return json({ ok: true, planId: plan.id, interval, shopId: context.shopId, url: session.url, provider: 'stripe', mode: 'checkout' });
    }
    throw new HttpError(503, 'Billing is not configured for this plan');
  }
  if (action === 'portal' && request.method === 'POST') {
    if (!context?.shopId) throw new HttpError(401, 'Sign in to manage billing');
    const customer = await env.DB.prepare(
      'SELECT stripe_customer_id FROM billing_customers WHERE shop_id = ?',
    ).bind(context.shopId).first();
    if (!customer?.stripe_customer_id || !env.STRIPE_SECRET_KEY) {
      throw new HttpError(503, 'Stripe billing is not configured for this shop');
    }
    const origin = new URL(request.url).origin;
    const params = new URLSearchParams({
      customer: customer.stripe_customer_id,
      return_url: `${origin}/app`,
    });
    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new HttpError(502, 'Stripe billing portal could not be created');
    return json({ ok: true, shopId: context.shopId, url: result.url, provider: 'stripe' });
  }
  if (action === 'status' && request.method === 'GET') {
    if (!context?.shopId) throw new HttpError(401, 'Sign in to view billing');
    const account = await env.DB.prepare(
      'SELECT subscription_status, subscription_expires_at, suspended FROM accounts WHERE shop_id = ?',
    ).bind(context.shopId).first();
    const subscription = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE shop_id = ? LIMIT 1',
    ).bind(context.shopId).first().catch(() => null);
    const expiresAt = account?.subscription_expires_at || subscription?.current_period_end || null;
    const expired = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
    const status = Number(account?.suspended) === 1
      ? 'suspended'
      : expired
        ? 'expired'
        : String(account?.subscription_status || subscription?.status || 'trialing');
    return json({
      ok: true,
      shopId: context.shopId,
      active: Number(account?.suspended) !== 1 && ['trialing', 'active'].includes(status) && !expired,
      status,
      planId: subscription ? String(subscription.plan_id || '') : null,
      capabilities: planCapabilities(subscription?.plan_id || 'shop'),
      currentPeriodEnd: expiresAt,
    });
  }
  if (action === 'webhook' && request.method === 'POST') {
    const payload = await request.text();
    const signature = request.headers.get('Stripe-Signature') || '';
    const secret = env.STRIPE_BILLING_WEBHOOK_SECRET || '';
    if (!secret || !signature) throw new HttpError(400, 'Invalid Stripe signature');
    const fields = signature.split(',').map(item => item.trim().split('=', 2));
    const timestamp = fields.find(([key]) => key === 't')?.[1];
    const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value);
    if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      throw new HttpError(400, 'Invalid Stripe signature');
    }
    const expected = await hmacHex(secret, `${timestamp}.${payload}`);
    if (!signatures.some(value => constantTimeEqual(value, expected))) throw new HttpError(400, 'Invalid Stripe signature');
    const event = parseJson(payload);
    const object = event.data?.object || {};
    let shopId = object.client_reference_id || object.metadata?.shopId || '';
    const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    if (!shopId && customerId) {
      const customer = await env.DB.prepare(
        'SELECT shop_id FROM billing_customers WHERE stripe_customer_id = ?',
      ).bind(customerId).first();
      shopId = customer?.shop_id || '';
    }
    if (shopId) {
      const eventId = String(event.id || crypto.randomUUID());
      const duplicate = await env.DB.prepare(
        'SELECT id FROM billing_events WHERE id = ?',
      ).bind(eventId).first();
      if (duplicate) return json({ received: true, duplicate: true }, 200);

      if (customerId) {
        await env.DB.prepare(`
          INSERT INTO billing_customers (shop_id, stripe_customer_id, created_at) VALUES (?, ?, ?)
          ON CONFLICT(shop_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id
        `).bind(shopId, customerId, new Date().toISOString()).run();
      }

      const subscriptionEvent = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type);
      const checkoutEvent = event.type === 'checkout.session.completed';
      const paymentFailed = event.type === 'invoice.payment_failed';
      if (subscriptionEvent || checkoutEvent || paymentFailed) {
        const existing = await env.DB.prepare(
          'SELECT plan_id, stripe_subscription_id, current_period_end, current_period_start FROM subscriptions WHERE shop_id = ?',
        ).bind(shopId).first();
        const planId = String(object.metadata?.planId || existing?.plan_id || 'shop');
        const rawStatus = paymentFailed ? 'past_due'
          : checkoutEvent ? 'active'
            : event.type === 'customer.subscription.deleted' ? 'canceled'
              : String(object.status || 'active');
        const status = ['active', 'trialing'].includes(rawStatus) ? rawStatus
          : ['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'canceled', 'paused'].includes(rawStatus)
            ? rawStatus : 'inactive';
        const periodEndSeconds = Number(object.current_period_end || 0);
        const periodStartSeconds = Number(object.current_period_start || 0);
        const periodEnd = paymentFailed
          ? existing?.current_period_end || null
          : periodEndSeconds > 0 ? new Date(periodEndSeconds * 1000).toISOString() : null;
        const periodStart = paymentFailed
          ? existing?.current_period_start || null
          : periodStartSeconds > 0 ? new Date(periodStartSeconds * 1000).toISOString() : null;
        const invoiceSubscription = typeof object.subscription === 'string'
          ? object.subscription
          : object.subscription?.id;
        const subscriptionId = paymentFailed
          ? String(invoiceSubscription || existing?.stripe_subscription_id || '')
          : checkoutEvent
            ? String(object.subscription || existing?.stripe_subscription_id || '')
            : String(object.id || existing?.stripe_subscription_id || '');
        const nowIso = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE accounts SET subscription_status = ?, subscription_expires_at = ?, updated_at = ? WHERE shop_id = ?',
        ).bind(status, periodEnd, nowIso, shopId).run();
        await env.DB.prepare(
          'UPDATE shops SET billing_status = ?, updated_at = ? WHERE id = ?',
        ).bind(status, nowIso, shopId).run();
        await env.DB.prepare(`
          INSERT INTO subscriptions (
            shop_id, stripe_subscription_id, plan_id, status,
            current_period_end, current_period_start, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shop_id) DO UPDATE SET
            stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
            plan_id = excluded.plan_id, status = excluded.status,
            current_period_end = excluded.current_period_end,
            current_period_start = excluded.current_period_start,
            updated_at = excluded.updated_at
        `).bind(
          shopId, subscriptionId || null, planId, status, periodEnd, periodStart, nowIso, nowIso,
        ).run();
        await env.DB.prepare(`
          INSERT OR IGNORE INTO billing_events (id, shop_id, event_type, event_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          eventId, shopId, String(event.type || 'unknown'),
          JSON.stringify(event), new Date().toISOString(),
        ).run();
        capturePostHogEvent(env, { shopId, userId: `billing-webhook:${shopId}` }, 'subscription_status_changed', {
          plan_id: planId,
          subscription_status: status,
          provider: 'stripe',
          $process_person_profile: false,
        });
      } else {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO billing_events (id, shop_id, event_type, event_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          eventId, shopId, String(event.type || 'unknown'),
          JSON.stringify(event), new Date().toISOString(),
        ).run();
      }
    }
    return json({ received: true, type: event.type || 'unknown', mode: 'processed' }, 202);
  }
  throw new HttpError(404, 'Not found');
}

async function handleFounding(request, env) {
  const url = new URL(request.url);
  const action = url.pathname.split('/').filter(Boolean).pop();
  if (action === 'status' && request.method === 'GET') {
    const counter = await env.DB.prepare('SELECT claimed, cap FROM founding_counter WHERE id = 1').first();
    const claimed = Number(counter?.claimed || 0);
    const cap = Number(counter?.cap || 50);
    return json({ claimed, cap, remaining: Math.max(0, cap - claimed), open: claimed < cap });
  }
  if (action === 'validate' && request.method === 'GET') {
    const token = String(url.searchParams.get('token') || '').trim();
    const invite = token
      ? await env.DB.prepare('SELECT token, used_at FROM founding_invites WHERE token = ?').bind(token).first()
      : null;
    const counter = await env.DB.prepare('SELECT claimed, cap FROM founding_counter WHERE id = 1').first();
    const decision = claimDecision({ invite, counter, planId: 'founding_shop' });
    if (!decision.ok && decision.status === 400) return json({ valid: false, message: decision.message }, 400);
    return json({
      valid: decision.ok,
      message: decision.ok ? 'Invite accepted.' : decision.message,
      claimed: Number(counter?.claimed || 0),
      cap: Number(counter?.cap || 50),
      remaining: Math.max(0, Number(counter?.cap || 50) - Number(counter?.claimed || 0)),
    }, decision.ok ? 200 : decision.status);
  }
  if (action === 'claim' && request.method === 'POST') {
    const body = await requestJson(request);
    const token = String(body.token || '').trim();
    const planId = String(body.planId || 'founding_shop').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw new HttpError(400, 'A work email is required');
    // Claim emails are not verified yet. Refuse addresses that already own a shop
    // so a stolen invite cannot be parked on a victim's email for later overwrite.
    const existingOwner = await env.DB.prepare(
      'SELECT shop_id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1',
    ).bind(email).first();
    if (existingOwner?.shop_id) {
      throw new HttpError(409, 'This email already belongs to a shop. Founding invites are for new signups.');
    }
    const invite = token
      ? await env.DB.prepare('SELECT token, used_at FROM founding_invites WHERE token = ?').bind(token).first()
      : null;
    const counter = await env.DB.prepare('SELECT claimed, cap FROM founding_counter WHERE id = 1').first();
    const decision = claimDecision({ invite, counter, planId });
    if (!decision.ok) throw new HttpError(decision.status, decision.message);
    const nowIso = new Date().toISOString();
    // Take the counter slot only while this invite is still free, then mark the
    // invite. Compensate any partial outcome so spots/invites are not lost.
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE founding_counter
        SET claimed = claimed + 1
        WHERE id = 1 AND claimed < cap
          AND EXISTS (SELECT 1 FROM founding_invites WHERE token = ? AND used_at IS NULL)
      `).bind(token),
      env.DB.prepare(`
        UPDATE founding_invites
        SET used_at = ?, used_by_shop_id = ?, plan_id = ?
        WHERE token = ? AND used_at IS NULL
      `).bind(nowIso, email, planId, token),
    ]);
    const counterUpdated = Number(results?.[0]?.meta?.changes || 0) > 0;
    const inviteUpdated = Number(results?.[1]?.meta?.changes || 0) > 0;
    const outcome = claimBatchOutcome(inviteUpdated, counterUpdated);
    if (outcome.ok) return json({ claimed: true, planId, email, remaining: decision.remaining });
    if (outcome.restoreInvite) {
      await env.DB.prepare(`
        UPDATE founding_invites
        SET used_at = NULL, used_by_shop_id = NULL, plan_id = NULL
        WHERE token = ? AND used_at = ?
      `).bind(token, nowIso).run();
    }
    if (outcome.decrementCounter) {
      await env.DB.prepare(`
        UPDATE founding_counter SET claimed = claimed - 1 WHERE id = 1 AND claimed > 0
      `).run();
    }
    throw new HttpError(409, 'This Founding Member spot was just claimed.');
  }
  throw new HttpError(404, 'Not found');
}

async function route(request, env, analytics) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  if (request.method === 'OPTIONS') {
    const origin = allowedOrigin(request, env);
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, If-Match',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        Vary: 'Origin',
      },
    });
  }
  if (path === '/healthz') return json({ ok: true, service: 'mechpro-cloudflare-api' });
  if (segments[0] === 'founding') return handleFounding(request, env);
  if (segments[0] === 'auth') return handleAuth(request, env, segments, analytics);
  if (segments[0] === 'customer-documents') {
    return handleCustomerDocument(request, env, decodeURIComponent(segments[1] || ''));
  }
  if (segments[0] === 'payments' && segments[1] === 'webhook') {
    return handleStripeWebhook(request, env, decodeURIComponent(segments[2] || ''), analytics);
  }
  if (segments[0] === 'agentphone' && segments[1] === 'webhook') return handleAgentPhoneWebhook(request, env, decodeURIComponent(segments[2] || ''));
  if (segments[0] === 'messaging' && segments[1] === 'twilio' && segments[2] === 'webhook') {
    return handleTwilioWebhook(request, env, decodeURIComponent(segments[3] || ''));
  }
  if (segments[0] === 'quickbooks' && segments[1] === 'callback') {
    return handleQuickBooksCallback(request, env, {
      getSecret: getIntegrationSecret,
      saveSecret: saveIntegrationSecret,
      deleteSecret: deleteIntegrationSecret,
      encryptSecret,
      decryptSecret,
      getEntity,
      listEntities,
    });
  }
  if (segments[0] === 'billing') {
    const action = segments[1] || '';
    const context = action === 'webhook' ? null : await resolveContext(request, env);
    return handleBilling(request, env, context, segments);
  }
  const context = await resolveContext(request, env);
  analytics.distinctId = context.userId;
  await requireActiveAccount(context, env);
  if (path === '/auth/session') return handleAuthSession(request, context, analytics);
  if (segments[0] === 'customers' && ['search', 'duplicates'].includes(segments[1])) {
    return handleCustomerLookup(request, env, context, segments[1]);
  }
  if (segments[0] === 'entities') return handleEntities(request, env, context, segments, analytics);
  if (segments[0] === 'vehicles' && segments[1] === 'decode') return handleVin(request, env, context, segments[2]);
  if (path === '/mileage/calculate') return handleMileageCalculate(request, env, context);
  if (segments[0] === 'diagnostics') return handleDiagnostics(request, env, context, segments, analytics);
  if (segments[0] === 'ordering') return handleOrdering(request, env, context, segments);
  if (path === '/integrations/status') return handleIntegrationStatus(request, env, context);
  if (segments[0] === 'labor-times') {
    await requirePlanCapability(context, env, 'labor_guides');
    return handleLaborIntegration(request, env, context);
  }
  if (segments[0] === 'parts') {
    await requirePlanCapability(context, env, 'parts_ordering');
    return handlePartsIntegration(request, env, context, segments);
  }
  if (segments[0] === 'messaging') {
    await requirePlanCapability(context, env, 'sms');
    return handleMessagingIntegration(request, env, context, segments);
  }
  if (segments[0] === 'quickbooks') {
    await requirePlanCapability(context, env, 'quickbooks');
    return handleQuickBooks(request, env, context, segments, {
      getSecret: getIntegrationSecret,
      saveSecret: saveIntegrationSecret,
      deleteSecret: deleteIntegrationSecret,
      encryptSecret,
      decryptSecret,
      getEntity,
      listEntities,
    });
  }
  if (segments[0] === 'support') return handleSupport(request, env, context);
  if (segments[0] === 'integrations' && segments[1] === 'partstech') {
    return createPartstechHandlers({
      saveSecret: saveIntegrationSecret,
      getSecret: (shopId, name) => getIntegrationSecret(env, shopId, name),
      deleteSecret: deleteIntegrationSecret,
      requireRole,
      recordAudit: recordDiagnosticAudit,
    })(request, env, context, segments);
  }
  if (segments[0] === 'integrations' && segments[1] === 'labor-guide') {
    return createLaborGuideHandlers({
      saveSecret: saveIntegrationSecret,
      getSecret: (shopId, name) => getIntegrationSecret(env, shopId, name),
      deleteSecret: deleteIntegrationSecret,
      requireRole,
      recordAudit: recordDiagnosticAudit,
    })(request, env, context, segments);
  }
  if (segments[0] === 'integrations' && segments[1] === 'quickbooks') {
    return createQuickbooksHandlers({
      saveSecret: saveIntegrationSecret,
      getSecret: (shopId, name) => getIntegrationSecret(env, shopId, name),
      deleteSecret: deleteIntegrationSecret,
      requireRole,
      recordAudit: recordDiagnosticAudit,
    })(request, env, context, segments);
  }
  if (path === '/onboarding/start') return handleOnboarding(request, env, context, analytics);
  if (path === '/payroll/sync') return handlePayroll(request, env, context, analytics);
  if (path === '/tax-report') return handleTaxReport(request, env, context);
  if (path === '/settings/ai') return handleShopAiSettings(request, env, context, { recordAudit: recordDiagnosticAudit });
  if (path === '/ai/assistant') return handleAssistant(request, env, context, analytics);
  if (path === '/ai/transcribe') return handleVoiceTranscription(request, env, context);
  if (path === '/ai/voice/session') return handleVoiceSession(request, env, context);
  if (path === '/agentphone/configure') return handleAgentPhoneConfigure(request, env, context, analytics);
  if (segments[0] === 'files') return handleFiles(request, env, context, segments, analytics);
  if (path === '/document-links') return createCustomerDocumentLink(request, env, context);
  if (path.startsWith('/payments/terminal')) {
    return handleTerminalRoutes(request, env, context, {
      requireRole,
      json,
      requestJson,
      chargeTargetSnapshot,
      recordPayment: recordPaymentToTarget,
      fetchImpl: fetch,
      getStripeKey: (workerEnv, shopId) => getIntegrationSecret(workerEnv, shopId, 'stripe-secret-key'),
      getPublishableKey: (workerEnv, shopId) => getIntegrationSecret(workerEnv, shopId, 'stripe-publishable-key'),
    });
  }
  if (path === '/payments/record') return handlePaymentRecord(request, env, context, analytics);
  if (path === '/payments/checkout-session') return handleCheckout(request, env, context, analytics);
  if (path === '/payments/stripe/status') return handleStripeStatus(request, env, context);
  if (path === '/payments/stripe/configure') return handleStripeConfigure(request, env, context, analytics);
  if (path === '/subscription/entitlement') return handleEntitlement(request, env, context);
  if (segments[0] === 'admin' && segments[1] === 'accounts') return handleAdmin(request, env, context, segments, analytics);
  throw new HttpError(404, 'Not found');
}

async function servePublicDownload(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const key = publicDownloadObjectKey(new URL(request.url).pathname);
  if (!key || !env.FILES) return null;
  const object = request.method === 'HEAD'
    ? await env.FILES.head(key)
    : await env.FILES.get(key);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
  if (!headers.has('Content-Type')) {
    if (key.endsWith('.apk')) headers.set('Content-Type', 'application/vnd.android.package-archive');
    else if (key.endsWith('.zip')) headers.set('Content-Type', 'application/zip');
    else headers.set('Content-Type', 'application/octet-stream');
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

async function proxyPagesRequest(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
  const target = pagesProxyUrl(request.url, env.PAGES_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set('Host', new URL(target).host);
  const response = await fetch(new Request(target, {
    method: request.method,
    headers,
    redirect: 'manual',
  }));
  const nextHeaders = new Headers(response.headers);
  nextHeaders.delete('Content-Security-Policy-Report-Only');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
}

export default {
  async fetch(request, env, executionCtx) {
    const posthog = getPostHog(env);
    const analytics = {
      client: posthog,
      distinctId: request.headers.get('X-PostHog-Distinct-ID')
        || request.headers.get('X-PostHog-Session-ID')
        || crypto.randomUUID(),
    };
    try {
      if (!isApiRequest(request)) {
        const download = await servePublicDownload(request, env);
        if (download) return download;
        return proxyPagesRequest(request, env);
      }
      const response = await route(request, env, analytics);
      return response.status === 101 ? response : withCors(response, request, env);
    } catch (error) {
      const path = new URL(request.url).pathname;
      const publicError = publicRequestError(error, path);
      const status = publicError instanceof HttpError ? publicError.status : 500;
      const requestId = request.headers.get('Cf-Ray') || crypto.randomUUID();
      posthog?.captureException(error, analytics.distinctId, {
        method: request.method,
        path,
        status,
        request_id: requestId,
      });
      console.error(JSON.stringify({
        message: 'request failed',
        requestId,
        method: request.method,
        path,
        status,
        errorName: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error),
      }));
      return withCors(json({
        message: status === 500
          ? (env.AUTH_EXPOSE_LOGIN_LINK === '1' && error instanceof Error ? error.message : 'Internal error')
          : publicError.message,
        ...(publicError !== error ? { requestId } : {}),
      }, status, {
        ...(publicError instanceof HttpError && publicError.headers ? publicError.headers : {}),
        'X-Request-ID': requestId,
      }), request, env);
    } finally {
      if (posthog) {
        const flush = posthog.flush().catch((error) => {
          console.error('PostHog flush failed', error);
        });
        if (executionCtx?.waitUntil) executionCtx.waitUntil(flush);
        else void flush;
      }
    }
  },
};
