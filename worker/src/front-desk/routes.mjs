// Authenticated Front Desk routes: questionnaire (save progress any time,
// validation summary for go-live), the rendered persona preview, and the
// handoff log.

import { HttpError, json, requestJson } from '../http.mjs';
import { QUESTIONNAIRE_SECTIONS, validateQuestionnaire } from '../../../src/modules/front-desk-questionnaire.js';
import { getShopSetting } from '../shop-settings-store.mjs';
import { listHandoffs } from './handoff-store.mjs';
import { loadQuestionnaire, mergeIntakeIntoAnswers, saveQuestionnaire } from './persona-render.mjs';
import { getOnboarding } from '../onboarding/store.mjs';

const EDIT_ROLES = ['super_admin', 'owner', 'admin', 'office'];
const VIEW_ROLES = [...EDIT_ROLES, 'service_writer'];

export async function handleFrontDeskRoutes(request, env, context, segments) {
  const action = segments[1] || '';
  if (!VIEW_ROLES.includes(context.role)) throw new HttpError(403, 'Only shop admins and office staff can open the Front Desk setup');
  const shopId = context.shopId;

  if (action === 'questionnaire') {
    if (request.method === 'GET') {
      const [questionnaire, onboarding] = await Promise.all([loadQuestionnaire(env, shopId), getOnboarding(env, shopId).catch(() => null)]);
      const merged = mergeIntakeIntoAnswers(questionnaire.answers, onboarding?.intake || {});
      const validation = validateQuestionnaire(merged);
      return json({
        sections: QUESTIONNAIRE_SECTIONS,
        answers: questionnaire.answers,
        prefilled: merged,
        validation: { valid: validation.valid, missing: validation.missing, errors: validation.errors, progress: validation.progress },
        updatedAt: questionnaire.updatedAt,
        canEdit: EDIT_ROLES.includes(context.role),
      });
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      if (!EDIT_ROLES.includes(context.role)) throw new HttpError(403, 'Only shop admins and office staff can edit the Front Desk questionnaire');
      const body = await requestJson(request);
      const saved = await saveQuestionnaire(env, shopId, body.answers || {}, { actor: context.userId || context.email || 'staff' });
      const { validation } = saved;
      return json({
        answers: saved.answers,
        validation: { valid: validation.valid, missing: validation.missing, errors: validation.errors, progress: validation.progress },
        saved: true,
      });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (action === 'persona' && request.method === 'GET') {
    const [frontDesk, tech] = await Promise.all([getShopSetting(env, shopId, 'front_desk_persona'), getShopSetting(env, shopId, 'tech_assistant_persona')]);
    return json({ frontDesk, tech });
  }

  if (action === 'handoffs' && request.method === 'GET') {
    return json({ handoffs: await listHandoffs(env, shopId) });
  }

  throw new HttpError(404, 'Not found');
}
