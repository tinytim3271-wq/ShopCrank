// Operator intake for a new shop. Everything A2P, Twilio, and the Grok
// templates need is collected here once.

import { normalizePhone, isE164Phone, GROK_VOICE_IDS } from '../../../src/modules/front-desk-questionnaire.js';

export const SHOP_STAFF_ROLES = Object.freeze(['admin', 'office', 'service_writer', 'technician']);
export const A2P_BUSINESS_TYPES = Object.freeze(['Partnership', 'Limited Liability Corporation', 'Co-operative', 'Non-profit Corporation', 'Corporation']);
export const A2P_USE_CASES = Object.freeze(['CUSTOMER_CARE', 'ACCOUNT_NOTIFICATION', 'MIXED', 'LOW_VOLUME']);
export const A2P_JOB_POSITIONS = Object.freeze(['Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel', 'Other']);

const str = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const list = value => (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n|,/)).map(item => str(item, 120)).filter(Boolean).slice(0, 60);

export function slugifyShopId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export function areaCodeFrom(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return national.length === 10 ? national.slice(0, 3) : '';
}

export function normalizeIntake(input = {}) {
  const address = input.address && typeof input.address === 'object' ? input.address : {};
  const contact = input.contact && typeof input.contact === 'object' ? input.contact : {};
  const currentPhone = normalizePhone(input.currentPhone);
  return {
    shopId: slugifyShopId(input.shopId || input.dbaName || input.legalName),
    legalName: str(input.legalName),
    dbaName: str(input.dbaName),
    ein: str(input.ein, 20).replace(/[^\d-]/g, ''),
    businessType: str(input.businessType, 60),
    address: {
      street: str(address.street),
      city: str(address.city, 100),
      state: str(address.state, 2).toUpperCase(),
      postalCode: str(address.postalCode, 10),
    },
    website: str(input.website, 300),
    contact: {
      firstName: str(contact.firstName, 80),
      lastName: str(contact.lastName, 80),
      title: str(contact.title, 80),
      jobPosition: str(contact.jobPosition, 40),
      email: str(contact.email, 254).toLowerCase(),
      mobile: normalizePhone(contact.mobile),
    },
    shopEmail: str(input.shopEmail || contact.email, 254).toLowerCase(),
    hours: str(input.hours, 400),
    services: list(input.services),
    laborRate: input.laborRate === '' || input.laborRate === undefined || input.laborRate === null ? null : Number(input.laborRate),
    currentPhone,
    areaCode: str(input.areaCode, 3).replace(/\D/g, '') || areaCodeFrom(currentPhone),
    optInWording: str(input.optInWording, 1000),
    campaignUseCase: A2P_USE_CASES.includes(input.campaignUseCase) ? input.campaignUseCase : 'CUSTOMER_CARE',
    lowVolume: input.lowVolume !== false,
    messageSamples: list(input.messageSamples).slice(0, 5),
    voice: GROK_VOICE_IDS.includes(input.voice) ? input.voice : 'eve',
    preferredSuppliers: list(input.preferredSuppliers).slice(0, 10),
    staff: (Array.isArray(input.staff) ? input.staff : []).slice(0, 40).map(member => ({
      name: str(member?.name, 120),
      email: str(member?.email, 254).toLowerCase(),
      role: SHOP_STAFF_ROLES.includes(member?.role) ? member.role : 'technician',
    })).filter(member => member.email),
    planId: str(input.planId || 'shop', 40),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateIntake(input = {}) {
  const intake = normalizeIntake(input);
  const errors = [];
  const need = (ok, field, message) => { if (!ok) errors.push({ field, message }); };
  need(/^[a-z0-9][a-z0-9-]{2,47}$/.test(intake.shopId), 'shopId', 'Shop ID (tenant slug) needs 3-48 lowercase letters, numbers, or dashes.');
  need(intake.legalName, 'legalName', 'Legal name is required.');
  need(/^\d{2}-?\d{7}$/.test(intake.ein), 'ein', 'EIN must be 9 digits (XX-XXXXXXX).');
  need(A2P_BUSINESS_TYPES.includes(intake.businessType), 'businessType', `Business type must be one of: ${A2P_BUSINESS_TYPES.join(', ')}.`);
  need(intake.address.street && intake.address.city, 'address', 'Street and city are required.');
  need(/^[A-Z]{2}$/.test(intake.address.state), 'address.state', 'State must be a 2-letter code.');
  need(/^\d{5}(-\d{4})?$/.test(intake.address.postalCode), 'address.postalCode', 'ZIP code is required.');
  need(/^https:\/\/[^\s]+\.[^\s]+/.test(intake.website), 'website', 'Website must start with https:// (A2P requires a working site).');
  need(intake.contact.firstName && intake.contact.lastName, 'contact.name', 'Authorized contact first and last name are required.');
  need(EMAIL.test(intake.contact.email), 'contact.email', 'Authorized contact email is required.');
  need(isE164Phone(intake.contact.mobile), 'contact.mobile', 'Authorized contact mobile must be a phone number like +18065550199.');
  need(A2P_JOB_POSITIONS.includes(intake.contact.jobPosition), 'contact.jobPosition', `Job position must be one of: ${A2P_JOB_POSITIONS.join(', ')}.`);
  need(intake.hours, 'hours', 'Hours are required.');
  need(intake.services.length > 0, 'services', 'List at least one service.');
  need(Number.isFinite(intake.laborRate) && intake.laborRate > 0 && intake.laborRate < 1000, 'laborRate', 'Labor rate must be a number of dollars per hour.');
  need(isE164Phone(intake.currentPhone), 'currentPhone', 'Current shop phone must be a phone number like +18065550199.');
  need(/^\d{3}$/.test(intake.areaCode), 'areaCode', 'Area code is required.');
  need(intake.optInWording.length >= 20, 'optInWording', 'SMS opt-in wording is required (how customers agree to receive texts).');
  need(EMAIL.test(intake.shopEmail), 'shopEmail', 'Shop email (receives voicemails) is required.');
  for (const [index, member] of intake.staff.entries()) need(EMAIL.test(member.email), `staff.${index}.email`, `Staff member ${index + 1} needs a valid email.`);
  return { valid: errors.length === 0, errors, intake };
}

export function maskEin(ein) {
  const digits = String(ein || '').replace(/\D/g, '');
  return digits.length >= 4 ? `XX-XXX${digits.slice(-4)}` : '';
}
