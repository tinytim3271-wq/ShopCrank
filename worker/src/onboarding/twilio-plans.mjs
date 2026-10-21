// Twilio request plans for onboarding. A plan is a list of HTTP requests with
// `$ref:key.field` placeholders for values returned by earlier requests. The
// same plan is shown in dry-run, hashed for approval, and executed live, so an
// operator approves exactly what will be sent. Plans never contain credentials.

import { maskEin } from './intake.mjs';

export const TWILIO_BASES = Object.freeze({
  api: 'https://api.twilio.com/2010-04-01',
  trusthub: 'https://trusthub.twilio.com/v1',
  messaging: 'https://messaging.twilio.com/v1',
  monitor: 'https://monitor.twilio.com/v1',
});

// TrustHub policy SIDs published by Twilio for the ISV flow.
export const SECONDARY_CUSTOMER_PROFILE_POLICY_SID = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';
export const A2P_TRUST_PRODUCT_POLICY_SID = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';

// Estimates for operator review; confirm current pricing in the Twilio Console.
export const ESTIMATED_COSTS = Object.freeze({
  twilio_subaccount: { oneTimeUsd: 0, monthlyUsd: 0, note: 'Subaccounts are free.' },
  twilio_number: { oneTimeUsd: 0, monthlyUsd: 1.15, note: 'US local number, billed monthly.' },
  a2p_brand: { oneTimeUsd: 4.5, monthlyUsd: 0, note: 'Low-volume standard brand ~$4.50; standard brand with secondary vetting ~$46.' },
  a2p_campaign: { oneTimeUsd: 15, monthlyUsd: 2, note: 'Campaign vetting ~$15 once, then ~$1.50-$10/month by use case.' },
  test_calls: { oneTimeUsd: 0.05, monthlyUsd: 0, note: 'Two short call legs plus media stream minutes.' },
});

export function publicOrigin(env) {
  return String(env?.SHOPCRANK_PUBLIC_ORIGIN || 'https://www.shopcrank.com').replace(/\/+$/, '');
}

export function tenantVoiceUrl(env, shopId) {
  return `${publicOrigin(env)}/api/voice/twilio/incoming/${encodeURIComponent(shopId)}`;
}

export function tenantSmsUrl(env, shopId) {
  return `${publicOrigin(env)}/api/messaging/twilio/webhook/${encodeURIComponent(shopId)}`;
}

/** Twimlet voicemail that emails the shop; Twilio runs it if the voice URL fails. */
export function voicemailFallbackUrl(intake) {
  const params = new URLSearchParams({
    Email: intake.shopEmail,
    Message: `Thanks for calling ${intake.dbaName || intake.legalName}. Please leave a message after the tone.`,
    Transcribe: 'true',
  });
  return `https://twimlets.com/voicemail?${params.toString()}`;
}

function request(key, { method = 'POST', base = 'api', path, form = null, query = null, account = 'subaccount', description, sensitive = [] }) {
  return { key, method, base, path, form, query, account, description, sensitive };
}

export function planSubaccount(intake) {
  return [request('subaccount', {
    account: 'master',
    path: '/Accounts.json',
    form: { FriendlyName: `ShopCrank - ${intake.dbaName || intake.legalName} (${intake.shopId})`.slice(0, 64) },
    description: 'Create a Twilio subaccount under the ShopCrank master account.',
  })];
}

export function planNumberSearch(intake, subaccountSid) {
  return [request('search', {
    method: 'GET',
    path: `/Accounts/${subaccountSid}/AvailablePhoneNumbers/US/Local.json`,
    query: { AreaCode: intake.areaCode, VoiceEnabled: 'true', SmsEnabled: 'true', PageSize: '10' },
    description: `Search for local numbers in area code ${intake.areaCode} (read-only, free).`,
  })];
}

/** TwiML app (voice URL, voicemail fallback, blank status callback) + number purchase. */
export function planNumberPurchase(env, intake, subaccountSid, phoneNumber) {
  return [
    request('twiml_app', {
      path: `/Accounts/${subaccountSid}/Applications.json`,
      form: {
        FriendlyName: `ShopCrank ${intake.shopId} voice`,
        VoiceUrl: tenantVoiceUrl(env, intake.shopId),
        VoiceMethod: 'POST',
        VoiceFallbackUrl: voicemailFallbackUrl(intake),
        VoiceFallbackMethod: 'POST',
        StatusCallback: '',
        SmsUrl: tenantSmsUrl(env, intake.shopId),
        SmsMethod: 'POST',
      },
      description: 'Create the TwiML app: voice URL to the tenant route, Twimlet voicemail fallback emailing the shop, blank status callback, SMS webhook.',
    }),
    request('number', {
      path: `/Accounts/${subaccountSid}/IncomingPhoneNumbers.json`,
      form: {
        PhoneNumber: phoneNumber,
        FriendlyName: `${intake.dbaName || intake.legalName}`.slice(0, 64),
        VoiceApplicationSid: '$ref:twiml_app.sid',
        SmsUrl: tenantSmsUrl(env, intake.shopId),
        SmsMethod: 'POST',
        StatusCallback: '',
      },
      description: `Buy ${phoneNumber} and route it to the TwiML app (monthly charge).`,
    }),
  ];
}

function businessAttributes(intake) {
  return JSON.stringify({
    business_name: intake.legalName,
    business_identity: 'direct_customer',
    business_type: intake.businessType,
    business_industry: 'AUTOMOTIVE',
    business_registration_identifier: 'EIN',
    business_registration_number: intake.ein.replace(/\D/g, ''),
    business_regions_of_operation: 'USA_AND_CANADA',
    website_url: intake.website,
    social_media_profile_urls: '',
  });
}

function representativeAttributes(intake) {
  return JSON.stringify({
    first_name: intake.contact.firstName,
    last_name: intake.contact.lastName,
    email: intake.contact.email,
    phone_number: intake.contact.mobile,
    business_title: intake.contact.title || intake.contact.jobPosition,
    job_position: intake.contact.jobPosition,
  });
}

/** Phase 1 of the ISV flow: secondary customer profile, A2P trust product, brand, messaging service. */
export function planA2pBrand(env, intake, { subaccountSid, numberSid, primaryCustomerProfileSid }) {
  const name = intake.dbaName || intake.legalName;
  return [
    request('customer_profile', { base: 'trusthub', path: '/CustomerProfiles', form: { FriendlyName: `${name} profile`.slice(0, 64), Email: intake.contact.email, PolicySid: SECONDARY_CUSTOMER_PROFILE_POLICY_SID }, description: 'Create the secondary customer profile.' }),
    request('business_info', { base: 'trusthub', path: '/EndUsers', form: { FriendlyName: `${name} business`.slice(0, 64), Type: 'customer_profile_business_information', Attributes: businessAttributes(intake) }, description: 'Business information (legal name, EIN, website).', sensitive: ['Attributes'] }),
    request('representative', { base: 'trusthub', path: '/EndUsers', form: { FriendlyName: `${intake.contact.firstName} ${intake.contact.lastName}`.slice(0, 64), Type: 'authorized_representative_1', Attributes: representativeAttributes(intake) }, description: 'Authorized representative.' }),
    request('address', { path: `/Accounts/${subaccountSid}/Addresses.json`, form: { CustomerName: intake.legalName, Street: intake.address.street, City: intake.address.city, Region: intake.address.state, PostalCode: intake.address.postalCode, IsoCountry: 'US' }, description: 'Business address.' }),
    request('address_document', { base: 'trusthub', path: '/SupportingDocuments', form: { FriendlyName: `${name} address`.slice(0, 64), Type: 'customer_profile_address', Attributes: JSON.stringify({ address_sids: '$ref:address.sid' }) }, description: 'Address supporting document.' }),
    request('assign_primary', { base: 'trusthub', path: '/CustomerProfiles/$ref:customer_profile.sid/EntityAssignments', form: { ObjectSid: primaryCustomerProfileSid || 'MISSING_TWILIO_PRIMARY_CUSTOMER_PROFILE_SID' }, description: 'Link to the ShopCrank (ISV) primary customer profile.' }),
    request('assign_business', { base: 'trusthub', path: '/CustomerProfiles/$ref:customer_profile.sid/EntityAssignments', form: { ObjectSid: '$ref:business_info.sid' }, description: 'Attach business information.' }),
    request('assign_representative', { base: 'trusthub', path: '/CustomerProfiles/$ref:customer_profile.sid/EntityAssignments', form: { ObjectSid: '$ref:representative.sid' }, description: 'Attach the representative.' }),
    request('assign_address', { base: 'trusthub', path: '/CustomerProfiles/$ref:customer_profile.sid/EntityAssignments', form: { ObjectSid: '$ref:address_document.sid' }, description: 'Attach the address document.' }),
    request('profile_evaluation', { base: 'trusthub', path: '/CustomerProfiles/$ref:customer_profile.sid/Evaluations', form: { PolicySid: SECONDARY_CUSTOMER_PROFILE_POLICY_SID }, description: 'Evaluate the profile against the policy.' }),
    request('profile_submit', { base: 'trusthub', path: '/CustomerProfiles/$ref:customer_profile.sid', form: { Status: 'pending-review' }, description: 'Submit the customer profile for review.' }),
    request('trust_product', { base: 'trusthub', path: '/TrustProducts', form: { FriendlyName: `${name} A2P`.slice(0, 64), Email: intake.contact.email, PolicySid: A2P_TRUST_PRODUCT_POLICY_SID }, description: 'Create the A2P messaging trust product.' }),
    request('a2p_profile', { base: 'trusthub', path: '/EndUsers', form: { FriendlyName: `${name} A2P profile`.slice(0, 64), Type: 'us_a2p_messaging_profile_information', Attributes: JSON.stringify({ company_type: 'private' }) }, description: 'A2P messaging profile (private company).' }),
    request('assign_a2p_profile', { base: 'trusthub', path: '/TrustProducts/$ref:trust_product.sid/EntityAssignments', form: { ObjectSid: '$ref:a2p_profile.sid' }, description: 'Attach the A2P profile.' }),
    request('assign_a2p_customer', { base: 'trusthub', path: '/TrustProducts/$ref:trust_product.sid/EntityAssignments', form: { ObjectSid: '$ref:customer_profile.sid' }, description: 'Attach the customer profile.' }),
    request('trust_evaluation', { base: 'trusthub', path: '/TrustProducts/$ref:trust_product.sid/Evaluations', form: { PolicySid: A2P_TRUST_PRODUCT_POLICY_SID }, description: 'Evaluate the trust product.' }),
    request('trust_submit', { base: 'trusthub', path: '/TrustProducts/$ref:trust_product.sid', form: { Status: 'pending-review' }, description: 'Submit the trust product.' }),
    request('brand', { base: 'messaging', path: '/a2p/BrandRegistrations', form: { CustomerProfileBundleSid: '$ref:customer_profile.sid', A2PProfileBundleSid: '$ref:trust_product.sid', BrandType: 'STANDARD', SkipAutomaticSecVet: intake.lowVolume ? 'true' : 'false' }, description: 'Register the brand (one-time brand fee).' }),
    request('messaging_service', { base: 'messaging', path: '/Services', form: { FriendlyName: `ShopCrank ${intake.shopId}`.slice(0, 64), InboundRequestUrl: tenantSmsUrl(env, intake.shopId), InboundMethod: 'POST', UseInboundWebhookOnNumber: 'true' }, description: 'Create the messaging service (inbound SMS to the tenant webhook).' }),
    request('service_number', { base: 'messaging', path: '/Services/$ref:messaging_service.sid/PhoneNumbers', form: { PhoneNumberSid: numberSid || 'MISSING_NUMBER_SID' }, description: 'Add the shop number to the messaging service.' }),
  ];
}

export function defaultMessageSamples(intake) {
  const name = intake.dbaName || intake.legalName;
  return [
    `${name}: Your 2019 Ford F-150 is ready for pickup. We're open until 5:30 PM. Reply STOP to opt out.`,
    `${name}: Your estimate for brake service is ready to review. Reply YES to approve or call us with questions. Reply STOP to opt out.`,
  ];
}

/** Phase 2: the campaign, once the brand is approved. */
export function planA2pCampaign(intake, { messagingServiceSid, brandSid }) {
  const name = intake.dbaName || intake.legalName;
  const samples = intake.messageSamples.length >= 2 ? intake.messageSamples : defaultMessageSamples(intake);
  return [request('campaign', {
    base: 'messaging',
    path: `/Services/${messagingServiceSid}/Compliance/Usa2p`,
    form: {
      BrandRegistrationSid: brandSid,
      Description: `${name} sends repair status updates, estimate approvals, appointment reminders, and replies to customer questions about their vehicle service.`,
      MessageFlow: intake.optInWording,
      MessageSamples: samples,
      UsAppToPersonUsecase: intake.campaignUseCase,
      HasEmbeddedLinks: 'true',
      HasEmbeddedPhone: 'true',
      OptInKeywords: ['START', 'YES'],
      OptOutKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
      HelpKeywords: ['HELP', 'INFO'],
      OptInMessage: `${name}: You're subscribed to repair and appointment texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
      OptOutMessage: `${name}: You're unsubscribed and will get no more texts. Reply START to resubscribe.`,
      HelpMessage: `${name}: For help call ${intake.currentPhone} or email ${intake.shopEmail}. Reply STOP to opt out.`,
    },
    description: 'Submit the A2P campaign (campaign vetting fee + monthly fee).',
  })];
}

export const TEST_CALL_TWIML = '<Response><Pause length="12"/><Hangup/></Response>';

export function planTestCall(env, { toNumber }) {
  const from = String(env?.ONBOARDING_TEST_CALLER_NUMBER || '').trim() || 'MISSING_ONBOARDING_TEST_CALLER_NUMBER';
  return [request('test_call', {
    account: 'master',
    path: '/Accounts/{master}/Calls.json',
    form: { To: toNumber, From: from, Twiml: TEST_CALL_TWIML, Timeout: '25' },
    description: `Place a ~15 second test call from ${from} to ${toNumber}.`,
  })];
}

export function planTestCallChecks({ masterCallSid, subaccountSid, toNumber, startedAt }) {
  return [
    request('outbound_call', { method: 'GET', account: 'master', path: `/Accounts/{master}/Calls/${masterCallSid}.json`, description: 'Read the test call result.' }),
    request('inbound_calls', { method: 'GET', path: `/Accounts/${subaccountSid}/Calls.json`, query: { To: toNumber, 'StartTime>': startedAt.slice(0, 10), PageSize: '5' }, description: 'Read the inbound leg on the shop subaccount.' }),
    request('alerts', { method: 'GET', base: 'monitor', path: '/Alerts', query: { StartDate: startedAt, PageSize: '50' }, description: 'Read Twilio debugger alerts since the call started.' }),
  ];
}

export function planA2pStatus({ customerProfileSid, trustProductSid, brandSid, messagingServiceSid, campaignSid }) {
  const requests = [];
  if (customerProfileSid) requests.push(request('customer_profile', { method: 'GET', base: 'trusthub', path: `/CustomerProfiles/${customerProfileSid}`, description: 'Customer profile status.' }));
  if (trustProductSid) requests.push(request('trust_product', { method: 'GET', base: 'trusthub', path: `/TrustProducts/${trustProductSid}`, description: 'Trust product status.' }));
  if (brandSid) requests.push(request('brand', { method: 'GET', base: 'messaging', path: `/a2p/BrandRegistrations/${brandSid}`, description: 'Brand status.' }));
  if (messagingServiceSid && campaignSid) requests.push(request('campaign', { method: 'GET', base: 'messaging', path: `/Services/${messagingServiceSid}/Compliance/Usa2p/${campaignSid}`, description: 'Campaign status.' }));
  return requests;
}

/** Display copy of a plan with sensitive values masked. */
export function describePlan(requests, intake = null) {
  return requests.map(item => {
    const form = item.form ? { ...item.form } : null;
    for (const field of item.sensitive || []) {
      if (form && form[field]) form[field] = String(form[field]).replace(/"business_registration_number":"\d+"/, `"business_registration_number":"${maskEin(intake?.ein)}"`);
    }
    return {
      key: item.key,
      method: item.method,
      url: `${TWILIO_BASES[item.base]}${item.path}${item.query ? `?${new URLSearchParams(item.query).toString()}` : ''}`,
      account: item.account,
      form,
      description: item.description,
    };
  });
}

export async function planHash(step, requests) {
  const canonical = JSON.stringify({ step, requests: requests.map(({ key, method, base, path, form, query, account }) => ({ key, method, base, path, form, query, account })) });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
