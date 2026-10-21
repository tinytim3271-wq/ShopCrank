// Regenerates both per-shop personas from onboarding intake + the Front Desk
// questionnaire, and republishes the customer-safe answers to the knowledge base.

import { getShopSetting, putShopSetting } from '../shop-settings-store.mjs';
import { getOnboarding } from '../onboarding/store.mjs';
import { loadShopPricing } from '../ai.mjs';
import { createKnowledgeItem, deleteKnowledgeBySource } from '../knowledge/store.mjs';
import {
  customerSafeQuestionnaireEntries,
  formatWeeklyHours,
  normalizeQuestionnaireAnswers,
  renderFrontDeskTemplate,
  validateQuestionnaire,
} from '../../../src/modules/front-desk-questionnaire.js';

export const QUESTIONNAIRE_SETTING_ID = 'front_desk_questionnaire';
const QUESTIONNAIRE_SOURCE_ID = 'front-desk-questionnaire';

/** Intake values fill questionnaire gaps; questionnaire answers always win. */
export function mergeIntakeIntoAnswers(answers = {}, intake = {}) {
  const merged = { ...normalizeQuestionnaireAnswers(answers) };
  const fill = (key, value) => {
    const current = merged[key];
    const blank = current === undefined || current === null || current === '' || (Array.isArray(current) && !current.length);
    if (blank && value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)) merged[key] = value;
  };
  fill('legalName', intake.legalName);
  fill('dbaName', intake.dbaName || intake.legalName);
  fill('address', [intake.address?.street, intake.address?.city, intake.address?.state, intake.address?.postalCode].filter(Boolean).join(', '));
  fill('website', intake.website);
  fill('mainPhone', intake.currentPhone);
  fill('servicesOffered', intake.services);
  fill('laborRate', Number.isFinite(Number(intake.laborRate)) && intake.laborRate !== '' ? Number(intake.laborRate) : undefined);
  fill('smsOptInWording', intake.optInWording);
  fill('voice', intake.voice);
  return normalizeQuestionnaireAnswers(merged);
}

export async function loadQuestionnaire(env, shopId) {
  const setting = await getShopSetting(env, shopId, QUESTIONNAIRE_SETTING_ID);
  return { answers: normalizeQuestionnaireAnswers(setting?.answers || {}), updatedAt: setting?.updatedAt || null, updatedBy: setting?.updatedBy || '' };
}

export async function regenerateShopPersonas(env, shopId, { actor = 'system' } = {}) {
  const [{ answers }, onboarding, pricing, profile, grokPhone] = await Promise.all([
    loadQuestionnaire(env, shopId),
    getOnboarding(env, shopId).catch(() => null),
    loadShopPricing(env, shopId),
    getShopSetting(env, shopId, 'profile'),
    getShopSetting(env, shopId, 'grok_phone'),
  ]);
  const intake = onboarding?.intake || {};
  const merged = mergeIntakeIntoAnswers(answers, intake);
  const context = {
    shopName: profile?.shopName || profile?.name || intake.dbaName || intake.legalName || '',
    laborRate: pricing.laborRate,
    address: profile?.address || '',
    phone: profile?.phone || '',
    hours: intake.hours || grokPhone?.shopHours || '',
    services: intake.services || [],
  };
  const validation = validateQuestionnaire(merged);
  const instructions = renderFrontDeskTemplate(merged, context);
  const now = new Date().toISOString();
  const frontDesk = await putShopSetting(env, shopId, 'front_desk_persona', {
    instructions,
    greeting: merged.greetingText || '',
    voice: merged.voice || grokPhone?.voice || 'eve',
    botName: merged.botName || '',
    goLiveReady: validation.valid,
    generatedAt: now,
    generatedBy: actor,
  }, actor);
  const techProfile = await putShopSetting(env, shopId, 'tech_assistant_persona', {
    services: merged.servicesOffered || [],
    makes: merged.makesServiced || [],
    notServiced: [...(merged.makesNotServiced || []), ...(merged.vehicleTypesNotServiced || []), ...(merged.servicesNotOffered || [])],
    suppliers: Array.isArray(intake.preferredSuppliers) ? intake.preferredSuppliers : [],
    notes: '',
    generatedAt: now,
  }, actor);
  const firstTarget = (merged.transferTargets || [])[0];
  await putShopSetting(env, shopId, 'grok_phone', {
    ...(grokPhone || {}),
    voice: frontDesk.voice,
    greeting: merged.greetingText || grokPhone?.greeting || '',
    forwardingPhone: firstTarget?.phone || grokPhone?.forwardingPhone || '',
    shopHours: merged.regularHours ? formatWeeklyHours(merged.regularHours) : (grokPhone?.shopHours || ''),
    autoSaveIntake: grokPhone?.autoSaveIntake !== false,
  }, actor);

  await deleteKnowledgeBySource(env, shopId, QUESTIONNAIRE_SOURCE_ID);
  for (const entry of customerSafeQuestionnaireEntries(merged)) {
    await createKnowledgeItem(env, {
      shopId,
      kind: 'questionnaire',
      title: entry.title,
      body: entry.body,
      permission: 'customer_safe',
      sourceType: 'questionnaire',
      sourceId: QUESTIONNAIRE_SOURCE_ID,
      metadata: { section: entry.sectionId },
      createdBy: actor,
      createdRole: 'system',
    });
  }
  return { frontDesk, techProfile, validation };
}

export async function saveQuestionnaire(env, shopId, answers, { actor = 'system' } = {}) {
  const current = await loadQuestionnaire(env, shopId);
  const next = normalizeQuestionnaireAnswers({ ...current.answers, ...normalizeQuestionnaireAnswers(answers) });
  await putShopSetting(env, shopId, QUESTIONNAIRE_SETTING_ID, { answers: next, updatedBy: actor }, actor);
  const regenerated = await regenerateShopPersonas(env, shopId, { actor });
  return { answers: next, validation: regenerated.validation, persona: regenerated.frontDesk };
}
