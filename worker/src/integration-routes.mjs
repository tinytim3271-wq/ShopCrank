import { HttpError, json, requestJson } from './http.mjs';
import { getLaborProviderStatus, searchLicensedLabor } from './integrations/labor.mjs';
import {
  getPartsProviderStatus,
  getPartsPunchoutUrl,
  requestPartsProvider,
} from './integrations/parts.mjs';
import {
  SmsIntegrationError,
  parseTwilioInboundWebhook,
  sendSms,
  smsIntegrationStatus,
} from './integrations/sms.mjs';
import { QuickBooksError, createQuickBooksIntegration } from './integrations/quickbooks.mjs';
import { createSupportTicket, listSupportTickets } from './support.mjs';

const MESSAGE_ROLES = ['owner', 'admin', 'office', 'service_writer'];
const INTEGRATION_ROLES = ['owner', 'admin'];

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function role(context, allowed) {
  if (!allowed.includes(context.role)) throw new HttpError(403, `Role ${context.role} is not permitted for this action`);
}

function integrationError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof SmsIntegrationError) return new HttpError(error.status, error.message);
  if (error instanceof QuickBooksError) {
    const status = error.code === 'INVALID_INPUT' ? 400
      : error.code === 'QUICKBOOKS_NOT_CONNECTED' ? 409
        : error.status >= 400 && error.status < 500 ? error.status : 502;
    return new HttpError(status, error.message);
  }
  if (error instanceof TypeError) return new HttpError(400, error.message);
  return new HttpError(502, error instanceof Error ? error.message : 'Integration request failed');
}

export async function handleIntegrationStatus(request, env, context) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const sms = smsIntegrationStatus(env);
  const quickbooks = Boolean(env.INTUIT_CLIENT_ID && env.INTUIT_CLIENT_SECRET && env.INTUIT_REDIRECT_URI);
  return json({
    labor: getLaborProviderStatus(env),
    parts: getPartsProviderStatus(env),
    sms,
    quickbooks: { configured: quickbooks },
    support: {
      enabled: true,
      emailNotifications: Boolean(env.SUPPORT_EMAIL_TO && env.EMAIL),
      statusPageUrl: String(env.STATUS_PAGE_URL || ''),
    },
    shopId: context.shopId,
  });
}

export async function handleLaborIntegration(request, env, context) {
  role(context, ['owner', 'admin', 'office', 'service_writer', 'technician']);
  if (request.method === 'GET') return json({ providers: getLaborProviderStatus(env) });
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  try {
    const body = await requestJson(request);
    const results = await searchLicensedLabor(env, body, { provider: body.provider });
    return json({
      results,
      verified: results.some((item) => item.verified),
      fallback: !results.some((item) => item.verified),
    });
  } catch (error) {
    throw integrationError(error);
  }
}

export async function handlePartsIntegration(request, env, context, segments) {
  role(context, ['owner', 'admin', 'office', 'service_writer', 'technician']);
  const provider = String(segments[1] || '').toLowerCase();
  const operation = String(segments[2] || 'status').toLowerCase();
  if (!provider && request.method === 'GET') return json({ providers: getPartsProviderStatus(env) });
  if (operation === 'punchout' && request.method === 'GET') {
    const url = getPartsPunchoutUrl(env, provider);
    if (!url) throw new HttpError(404, 'Punch-out is not configured for this provider');
    return json({ provider, url });
  }
  if (operation === 'order' && request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
  if (operation === 'order') role(context, MESSAGE_ROLES);
  try {
    const input = request.method === 'POST'
      ? await requestJson(request)
      : Object.fromEntries(new URL(request.url).searchParams);
    return json(await requestPartsProvider(env, provider, operation, input));
  } catch (error) {
    throw integrationError(error);
  }
}

async function consentStatus(env, shopId, phone) {
  return env.DB.prepare('SELECT status FROM sms_consent WHERE shop_id = ? AND phone = ?')
    .bind(shopId, phone).first();
}

async function storeCustomerMessage(env, message) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO customer_messages (
      id, shop_id, customer_id, work_order_id, phone, direction, body, provider,
      provider_message_id, message_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    message.id, message.shopId, message.customerId || null, message.workOrderId || null,
    message.phone, message.direction, message.body, message.provider,
    message.providerMessageId || null, message.messageType || 'message',
    message.status, message.createdAt,
  ).run();
}

export async function handleMessagingIntegration(request, env, context, segments) {
  role(context, MESSAGE_ROLES);
  const action = segments[1] || 'status';
  if (action === 'status' && request.method === 'GET') {
    return json({ sms: smsIntegrationStatus(env) });
  }
  if (action === 'threads' && request.method === 'GET') {
    if (!smsIntegrationStatus(env)) return json({ enabled: false, messages: [] });
    const result = await env.DB.prepare(`
      SELECT id, customer_id, work_order_id, phone, direction, body, provider_message_id,
        message_type, status, created_at
      FROM customer_messages WHERE shop_id = ? ORDER BY created_at DESC LIMIT 250
    `).bind(context.shopId).all();
    return json({
      enabled: true,
      messages: (result.results || []).map((row) => ({
        id: row.id, customerId: row.customer_id, workOrderId: row.work_order_id,
        phone: row.phone, direction: row.direction, body: row.body,
        providerMessageId: row.provider_message_id, messageType: row.message_type,
        status: row.status, createdAt: row.created_at,
      })),
    });
  }
  if (action === 'send' && request.method === 'POST') {
    if (!smsIntegrationStatus(env)) throw new HttpError(503, 'Built-in SMS is not configured');
    const body = await requestJson(request);
    const phone = String(body.to || '').trim();
    const consent = await consentStatus(env, context.shopId, phone);
    if (consent?.status === 'opted_out') throw new HttpError(409, 'This customer opted out of SMS');
    const message = String(body.body || '').trim();
    if (!message) throw new HttpError(400, 'Message body is required');
    try {
      const result = await sendSms(env, { to: phone, body: message });
      const createdAt = new Date().toISOString();
      await storeCustomerMessage(env, {
        id: `sms-${crypto.randomUUID()}`, shopId: context.shopId,
        customerId: String(body.customerId || '').slice(0, 120),
        workOrderId: String(body.workOrderId || '').slice(0, 120),
        phone, direction: 'outbound', body: message, provider: result.provider,
        providerMessageId: result.messageSid,
        messageType: String(body.messageType || 'message').slice(0, 40),
        status: result.status, createdAt,
      });
      return json({ ...result, createdAt }, 201);
    } catch (error) {
      throw integrationError(error);
    }
  }
  throw new HttpError(404, 'Not found');
}

export async function handleTwilioWebhook(request, env, shopId) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!shopId) throw new HttpError(400, 'Shop ID is required');
  try {
    const message = await parseTwilioInboundWebhook(request, env);
    const now = new Date().toISOString();
    if (message.classification) {
      await env.DB.prepare(`
        INSERT INTO sms_consent (shop_id, phone, status, source, updated_at)
        VALUES (?, ?, ?, 'twilio_inbound', ?)
        ON CONFLICT(shop_id, phone) DO UPDATE SET
          status = excluded.status, source = excluded.source, updated_at = excluded.updated_at
      `).bind(shopId, message.from, message.classification === 'opt_out' ? 'opted_out' : 'opted_in', now).run();
    }
    const customer = await env.DB.prepare(`
      SELECT entity_id FROM entities
      WHERE shop_id = ? AND entity_type = 'customers'
        AND replace(replace(replace(replace(json_extract(data_json, '$.phone'), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
      LIMIT 1
    `).bind(shopId, `%${message.from.replace(/\D/g, '').slice(-10)}`).first();
    await storeCustomerMessage(env, {
      id: `sms-${crypto.randomUUID()}`, shopId, customerId: customer?.entity_id || null,
      phone: message.from, direction: 'inbound', body: message.body, provider: message.provider,
      providerMessageId: message.messageSid, messageType: message.classification || 'message',
      status: 'received', createdAt: now,
    });
    return new Response('<Response></Response>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  } catch (error) {
    throw integrationError(error);
  }
}

function qboTokenName() {
  return 'quickbooks-oauth-tokens';
}

function dateOnly(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

async function qboRemoteId(env, shopId, entityType, localId, realmId) {
  if (!realmId) return '';
  const row = await env.DB.prepare(`
    SELECT remote_id FROM integration_sync_records
    WHERE shop_id = ? AND provider = 'quickbooks' AND entity_type = ? AND local_id = ? AND realm_id = ?
  `).bind(shopId, entityType, localId, realmId).first();
  return row?.remote_id || '';
}

function quickBooksFactory(env, shopId, dependencies) {
  return createQuickBooksIntegration({
    env,
    loadTokens: async () => {
      const raw = await dependencies.getSecret(env, shopId, qboTokenName());
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    saveTokens: (tokens) => dependencies.saveSecret(env, shopId, qboTokenName(), JSON.stringify(tokens)),
    saveState: async (state, data) => {
      const stateHash = await sha256(state);
      const encrypted = await dependencies.encryptSecret(JSON.stringify(data), env.INTEGRATION_ENCRYPTION_KEY);
      const now = new Date();
      await env.DB.prepare(`
        INSERT INTO oauth_states (
          state_hash, shop_id, provider, verifier_ciphertext, verifier_iv,
          return_to, expires_at, created_at
        ) VALUES (?, ?, 'quickbooks', ?, ?, '/app', ?, ?)
      `).bind(
        stateHash, shopId, encrypted.ciphertext, encrypted.iv,
        new Date(now.getTime() + 10 * 60 * 1000).toISOString(), now.toISOString(),
      ).run();
    },
    loadState: async (state) => {
      const row = await env.DB.prepare(`
        SELECT verifier_ciphertext, verifier_iv FROM oauth_states
        WHERE state_hash = ? AND shop_id = ? AND provider = 'quickbooks' AND expires_at > ?
      `).bind(await sha256(state), shopId, new Date().toISOString()).first();
      if (!row) return null;
      return JSON.parse(await dependencies.decryptSecret(
        row.verifier_ciphertext, row.verifier_iv, env.INTEGRATION_ENCRYPTION_KEY,
      ));
    },
    deleteState: async (state) => {
      await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND shop_id = ?')
        .bind(await sha256(state), shopId).run();
    },
    saveSyncMetadata: async (metadata) => {
      await env.DB.prepare(`
        INSERT INTO integration_sync_records (
          shop_id, provider, entity_type, local_id, remote_id, realm_id, synced_at
        ) VALUES (?, 'quickbooks', ?, ?, ?, ?, ?)
        ON CONFLICT(shop_id, provider, entity_type, local_id) DO UPDATE SET
          remote_id = excluded.remote_id, realm_id = excluded.realm_id, synced_at = excluded.synced_at
      `).bind(
        shopId, metadata.entityType, metadata.localId, metadata.quickBooksId,
        metadata.realmId, metadata.syncedAt,
      ).run();
    },
  });
}

export async function handleQuickBooksCallback(request, env, dependencies) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const row = await env.DB.prepare(`
    SELECT shop_id FROM oauth_states
    WHERE state_hash = ? AND provider = 'quickbooks' AND expires_at > ?
  `).bind(await sha256(state), new Date().toISOString()).first();
  if (!row?.shop_id) throw new HttpError(400, 'QuickBooks OAuth state is invalid or expired');
  try {
    await quickBooksFactory(env, row.shop_id, dependencies).exchangeCallback(url);
    const redirect = new URL('/app?quickbooks=connected', request.url);
    return Response.redirect(redirect.toString(), 303);
  } catch (error) {
    throw integrationError(error);
  }
}

export async function handleQuickBooks(request, env, context, segments, dependencies) {
  role(context, INTEGRATION_ROLES);
  const action = segments[1] || 'status';
  const configured = Boolean(env.INTUIT_CLIENT_ID && env.INTUIT_CLIENT_SECRET && env.INTUIT_REDIRECT_URI);
  if (action === 'status' && request.method === 'GET') {
    const tokens = await dependencies.getSecret(env, context.shopId, qboTokenName());
    return json({ configured, connected: Boolean(tokens) });
  }
  if (!configured) throw new HttpError(503, 'QuickBooks is not configured');
  const qbo = quickBooksFactory(env, context.shopId, dependencies);
  try {
    if (action === 'connect' && request.method === 'POST') {
      return json(await qbo.getAuthorizationUrl());
    }
    if (action === 'disconnect' && request.method === 'DELETE') {
      await dependencies.deleteSecret(env, context.shopId, qboTokenName());
      return json({ connected: false });
    }
    if (action === 'sync' && request.method === 'POST') {
      const body = await requestJson(request);
      const entityType = String(body.entityType || '').toLowerCase();
      const entityId = String(body.entityId || '').trim();
      if (!['customer', 'invoice', 'payment'].includes(entityType) || !entityId) {
        throw new HttpError(400, 'entityType (customer, invoice, or payment) and entityId are required');
      }
      const collection = `${entityType}s`;
      const record = await dependencies.getEntity(env, context.shopId, collection, entityId);
      if (!record) throw new HttpError(404, `${entityType} not found`);
      const rawTokens = await dependencies.getSecret(env, context.shopId, qboTokenName());
      let realmId = '';
      try { realmId = JSON.parse(rawTokens)?.realmId || ''; } catch {}
      if (await qboRemoteId(env, context.shopId, entityType, entityId, realmId)) {
        throw new HttpError(409, 'This record is already synced to QuickBooks');
      }
      const payload = { ...record, ...(body.overrides || {}) };
      let result;
      if (entityType === 'customer') {
        result = await qbo.syncCustomer(payload);
      } else {
        let customerId = String(payload.customerId || '').trim();
        let customer = customerId
          ? await dependencies.getEntity(env, context.shopId, 'customers', customerId)
          : null;
        if (!customer && dependencies.listEntities) {
          const customers = await dependencies.listEntities(env, context.shopId, 'customers');
          customer = customers.find((item) => item.name === payload.customer) || null;
          customerId = customer?.id || '';
        }
        let quickBooksCustomerId = customerId
          ? await qboRemoteId(env, context.shopId, 'customer', customerId, realmId)
          : '';
        if (!quickBooksCustomerId && customer) {
          quickBooksCustomerId = (await qbo.syncCustomer(customer)).syncMetadata.quickBooksId;
        }
        if (!quickBooksCustomerId) {
          throw new HttpError(409, 'Sync the invoice customer to QuickBooks first');
        }
        if (entityType === 'invoice') {
          const amount = Number(payload.subtotal ?? payload.amount ?? 0);
          const defaultItemId = env.INTUIT_DEFAULT_ITEM_ID || '';
          const lines = Array.isArray(payload.lines) && payload.lines.length
            ? payload.lines.map(line => ({
                ...line,
                quickBooksItemId: line.quickBooksItemId || defaultItemId || undefined,
              }))
            : [{
                description: `MechPro invoice ${payload.number || entityId}`,
                quantity: 1,
                unitPrice: amount,
                amount,
                quickBooksItemId: env.INTUIT_DEFAULT_ITEM_ID || undefined,
              }];
          result = await qbo.syncInvoice({
            ...payload,
            id: entityId,
            quickBooksCustomerId,
            number: payload.number || entityId,
            date: dateOnly(payload.date || payload.createdAt),
            dueDate: payload.dueDate ? dateOnly(payload.dueDate) : undefined,
            lines,
          });
        } else {
          const invoiceId = String(payload.invoiceId || payload.invoiceNumber || '').trim();
          const quickBooksInvoiceId = invoiceId
            ? await qboRemoteId(env, context.shopId, 'invoice', invoiceId, realmId)
            : '';
          result = await qbo.syncPayment({
            ...payload,
            id: entityId,
            quickBooksCustomerId,
            quickBooksInvoiceId: quickBooksInvoiceId || undefined,
            amount: payload.amount,
            date: dateOnly(payload.receivedAt || payload.date),
          });
        }
      }
      return json(result, 201);
    }
  } catch (error) {
    throw integrationError(error);
  }
  throw new HttpError(404, 'Not found');
}

export async function handleSupport(request, env, context) {
  if (request.method === 'GET') return json({ tickets: await listSupportTickets(env, context) });
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  return json(await createSupportTicket(env, context, await requestJson(request)), 201);
}
