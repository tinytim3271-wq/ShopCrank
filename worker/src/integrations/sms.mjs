const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP']);

export const MAX_SMS_TEXT_LENGTH = 1600;

const encoder = new TextEncoder();

export class SmsIntegrationError extends Error {
  constructor(message, { code = 'sms_error', status = 500 } = {}) {
    super(message);
    this.name = 'SmsIntegrationError';
    this.code = code;
    this.status = status;
  }
}

function value(env, name) {
  return String(env?.[name] || '').trim();
}

export const TWILIO_SECRET_NAMES = Object.freeze({
  accountSid: 'twilio-account-sid',
  authToken: 'twilio-auth-token',
  fromNumber: 'twilio-from-number',
  messagingServiceSid: 'twilio-messaging-service-sid',
});

/** Merge optional shop overrides with platform env Twilio credentials. */
export function twilioConfig(env, overrides = null) {
  const accountSid = String(overrides?.accountSid || value(env, 'TWILIO_ACCOUNT_SID')).trim();
  const authToken = String(overrides?.authToken || value(env, 'TWILIO_AUTH_TOKEN')).trim();
  const messagingServiceSid = String(
    overrides?.messagingServiceSid || value(env, 'TWILIO_MESSAGING_SERVICE_SID'),
  ).trim();
  const fromNumber = String(overrides?.fromNumber || value(env, 'TWILIO_FROM_NUMBER')).trim();
  if (!accountSid || !authToken || (!messagingServiceSid && !fromNumber)) return null;
  return { accountSid, authToken, messagingServiceSid, fromNumber };
}

/**
 * Resolve Twilio credentials for a shop: encrypted shop secrets first, then platform env.
 * getSecret(env, shopId, name) matches getIntegrationSecret.
 */
export async function resolveTwilioShopConfig(env, shopId, getSecret = null) {
  let shopAccountSid = '';
  let shopAuthToken = '';
  let shopFromNumber = '';
  let shopMessagingServiceSid = '';
  if (shopId && typeof getSecret === 'function') {
    try {
      [shopAccountSid, shopAuthToken, shopFromNumber, shopMessagingServiceSid] = await Promise.all([
        getSecret(env, shopId, TWILIO_SECRET_NAMES.accountSid),
        getSecret(env, shopId, TWILIO_SECRET_NAMES.authToken),
        getSecret(env, shopId, TWILIO_SECRET_NAMES.fromNumber),
        getSecret(env, shopId, TWILIO_SECRET_NAMES.messagingServiceSid),
      ]);
    } catch {
      // Fall through to platform env.
    }
  }
  const hasShopCreds = Boolean(String(shopAccountSid || '').trim() && String(shopAuthToken || '').trim());
  const config = twilioConfig(env, {
    accountSid: shopAccountSid,
    authToken: shopAuthToken,
    fromNumber: shopFromNumber,
    messagingServiceSid: shopMessagingServiceSid,
  });
  if (!config) {
    return {
      configured: false,
      accountSid: '',
      authToken: '',
      fromNumber: '',
      messagingServiceSid: '',
      keySource: null,
    };
  }
  return {
    configured: true,
    ...config,
    keySource: hasShopCreds ? 'shop' : 'platform',
  };
}

export function smsIntegrationStatus(env, overrides = null) {
  const config = twilioConfig(env, overrides);
  if (!config) return null;
  const status = {
    enabled: true,
    provider: 'twilio',
    senderType: config.messagingServiceSid ? 'messaging_service' : 'phone_number',
  };
  if (overrides?.keySource) status.keySource = overrides.keySource;
  return status;
}

export function isE164(valueToCheck) {
  return E164_PATTERN.test(String(valueToCheck || '').trim());
}

function requireE164(valueToCheck, field) {
  const normalized = String(valueToCheck || '').trim();
  if (!isE164(normalized)) {
    throw new SmsIntegrationError(`${field} must be an E.164 phone number`, {
      code: 'invalid_phone_number',
      status: 400,
    });
  }
  return normalized;
}

function requireText(body) {
  const text = String(body ?? '');
  if (!text.trim()) {
    throw new SmsIntegrationError('SMS body is required', { code: 'invalid_body', status: 400 });
  }
  if (text.length > MAX_SMS_TEXT_LENGTH) {
    throw new SmsIntegrationError(`SMS body must be ${MAX_SMS_TEXT_LENGTH} characters or fewer`, {
      code: 'invalid_body',
      status: 400,
    });
  }
  return text;
}

function basicAuthorization(accountSid, authToken) {
  const bytes = encoder.encode(`${accountSid}:${authToken}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function safeTwilioResponse(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

export function createTwilioSmsProvider(env, { fetcher = globalThis.fetch, config: configOverride = null } = {}) {
  const config = configOverride || twilioConfig(env);
  if (!config) {
    throw new SmsIntegrationError('SMS delivery is not configured', {
      code: 'sms_not_configured',
      status: 503,
    });
  }
  if (typeof fetcher !== 'function') {
    throw new TypeError('fetcher must be a function');
  }

  return Object.freeze({
    provider: 'twilio',
    async send({ to, body }) {
      const form = new URLSearchParams({
        To: requireE164(to, 'to'),
        Body: requireText(body),
      });
      if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
      else form.set('From', requireE164(config.fromNumber, 'TWILIO_FROM_NUMBER'));

      let response;
      try {
        response = await fetcher(
          `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: basicAuthorization(config.accountSid, config.authToken),
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
            body: form.toString(),
          },
        );
      } catch {
        throw new SmsIntegrationError('Unable to reach the SMS provider', {
          code: 'sms_provider_error',
          status: 502,
        });
      }
      const payload = await safeTwilioResponse(response);
      if (!response.ok) {
        throw new SmsIntegrationError('Twilio rejected the SMS message', {
          code: 'sms_provider_error',
          status: 502,
        });
      }
      return {
        provider: 'twilio',
        messageSid: String(payload.sid || ''),
        status: String(payload.status || 'accepted'),
      };
    },
  });
}

export function createSmsProvider(env, options = {}) {
  const config = options.config || twilioConfig(env);
  return config ? createTwilioSmsProvider(env, { ...options, config }) : null;
}

export async function sendSms(env, message, options) {
  const provider = createSmsProvider(env, options);
  if (!provider) {
    throw new SmsIntegrationError('SMS delivery is not configured', {
      code: 'sms_not_configured',
      status: 503,
    });
  }
  return provider.send(message);
}

function signatureData(url, parameters) {
  const grouped = new Map();
  for (const [name, parameterValue] of parameters.entries()) {
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(parameterValue);
  }
  const names = [...grouped.keys()].sort();
  const body = names.map(name => (
    grouped.get(name).sort().map(parameterValue => `${name}${parameterValue}`).join('')
  )).join('');
  return `${url}${body}`;
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

export async function verifyTwilioWebhookSignature({
  authToken,
  url,
  parameters,
  signature,
}) {
  if (!authToken || !url || !(parameters instanceof URLSearchParams) || !signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(authToken)),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureData(url, parameters)));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return constantTimeEqual(btoa(binary), signature);
}

export function classifySmsKeyword(body) {
  const keyword = String(body || '').trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(keyword)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(keyword)) return 'opt_in';
  return null;
}

export async function parseTwilioInboundWebhook(request, env, { authToken: authTokenOverride = '' } = {}) {
  const authToken = String(authTokenOverride || value(env, 'TWILIO_AUTH_TOKEN')).trim();
  if (!authToken) {
    throw new SmsIntegrationError('SMS webhook verification is not configured', {
      code: 'sms_not_configured',
      status: 503,
    });
  }
  const parameters = new URLSearchParams(await request.text());
  const publicUrl = new URL(request.url);
  try {
    const configuredUrl = value(env, 'TWILIO_WEBHOOK_URL');
    if (configuredUrl) {
      const configured = new URL(configuredUrl);
      publicUrl.protocol = configured.protocol;
      publicUrl.hostname = configured.hostname;
      publicUrl.port = configured.port;
    }
  } catch {
    throw new SmsIntegrationError('TWILIO_WEBHOOK_URL is invalid', {
      code: 'sms_not_configured',
      status: 503,
    });
  }
  const valid = await verifyTwilioWebhookSignature({
    authToken,
    url: publicUrl.toString(),
    parameters,
    signature: request.headers.get('X-Twilio-Signature'),
  });
  if (!valid) {
    throw new SmsIntegrationError('Invalid Twilio webhook signature', {
      code: 'invalid_webhook_signature',
      status: 401,
    });
  }

  const body = String(parameters.get('Body') || '').slice(0, MAX_SMS_TEXT_LENGTH);
  return {
    provider: 'twilio',
    from: requireE164(parameters.get('From'), 'From'),
    to: requireE164(parameters.get('To'), 'To'),
    body,
    messageSid: String(parameters.get('MessageSid') || '').trim().slice(0, 64),
    classification: classifySmsKeyword(body),
  };
}
