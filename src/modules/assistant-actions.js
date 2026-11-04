/**
 * Cards under a Tech Assistant reply: confirming a change the assistant may not
 * make on its own (texts, payments, settings…), opening a screen it pointed to,
 * and the web sources it used. A confirmed card runs the same API call with the
 * user's own session, so it is exactly the user doing it.
 */

const SAFE_PATH = /^\/[A-Za-z0-9/_.~%-]+(\?[A-Za-z0-9=&_.~%+-]*)?$/;
const METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** A confirmation card the app will run: a write to a plain ShopCrank API path, never DELETE. */
export function isRunnableConfirmation(action) {
  return Boolean(action)
    && action.kind === 'app_api_confirmation'
    && METHODS.has(String(action.method || '').toUpperCase())
    && SAFE_PATH.test(String(action.path || ''))
    && !/(^|\/)(auth|ai)(\/|$)/.test(String(action.path || ''))
    && !String(action.path || '').includes('..');
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * @param {object[]} actions  the reply's actions
 * @param {number} messageIndex
 */
export function assistantActionsHtml(actions = [], messageIndex = 0, { escapeHtml = value => String(value ?? ''), icon = () => '', sources = [] } = {}) {
  return assistantSourcesHtml(sources, { escapeHtml }) + (Array.isArray(actions) ? actions : []).map((action, actionIndex) => {
    const key = `${messageIndex}:${actionIndex}`;
    if (action?.kind === 'estimate_work_order_draft') {
      return `<button type="button" class="assistant-draft-action" data-assistant-draft="${key}">${icon('clipboard-plus', 14)} Save estimate & fill work order</button>`;
    }
    if (action?.kind === 'open_screen' && action.screen) {
      return `<button type="button" class="secondary assistant-open-screen" data-assistant-screen="${key}">${icon('arrow-right', 14)} Open ${escapeHtml(action.title || action.screen)}</button>`;
    }
    if (isRunnableConfirmation(action)) {
      const state = action.status === 'done'
        ? `<span class="badge paid">Done</span>`
        : action.status === 'dismissed'
          ? `<span class="badge">Not done</span>`
          : `<div class="assistant-confirm-actions"><button type="button" class="primary" data-assistant-confirm="${key}">${icon('check', 14)} Confirm</button><button type="button" class="secondary" data-assistant-dismiss="${key}">Don't do it</button></div>`;
      return `<div class="assistant-confirm-card" role="group" aria-label="Needs your confirmation"><strong>${escapeHtml(action.summary || 'Confirm this change')}</strong><span class="assistant-confirm-detail">${escapeHtml(action.method)} ${escapeHtml(action.path)}</span>${action.reason ? `<small>${escapeHtml(action.reason)}</small>` : ''}${action.error ? `<small class="login-error">${escapeHtml(action.error)}</small>` : ''}${state}</div>`;
    }
    return '';
  }).join('');
}

export function assistantSourcesHtml(sources = [], { escapeHtml = value => String(value ?? '') } = {}) {
  const links = (Array.isArray(sources) ? sources : [])
    .map(source => ({ url: safeHttpsUrl(source?.url), title: source?.title }))
    .filter(source => source.url)
    .slice(0, 8)
    .map(source => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || new URL(source.url).hostname)}</a></li>`);
  return links.length ? `<details class="assistant-sources"><summary>Sources (${links.length})</summary><ul>${links.join('')}</ul></details>` : '';
}

/** Run a confirmed card with the user's session. Returns the API result. */
export async function runConfirmedAction(action, apiFetch) {
  if (!isRunnableConfirmation(action)) throw new Error('This change cannot be run from here.');
  const init = { method: String(action.method).toUpperCase() };
  if (action.body && typeof action.body === 'object') init.body = JSON.stringify(action.body);
  return apiFetch(action.path, init);
}

/**
 * Wire the cards in `root` (buttons carry "message:action" indexes into
 * `conversation`). `openScreen(action)` navigates; `rerender()` redraws.
 */
export function bindAssistantActionButtons(root, { conversation = [], apiFetch, toast = () => {}, openScreen = () => {}, rerender = () => {}, saveDraft = async () => {} }) {
  if (!root) return;
  const getAction = key => {
    const [messageIndex, actionIndex] = String(key || '').split(':').map(Number);
    return conversation[messageIndex]?.actions?.[actionIndex] || null;
  };
  root.querySelectorAll('[data-assistant-draft]').forEach(button => {
    button.onclick = async () => {
      const action = getAction(button.dataset.assistantDraft);
      if (!action) return;
      button.disabled = true;
      try { await saveDraft(action); } catch (error) { button.disabled = false; toast(error?.message || 'The estimate draft could not be saved'); }
    };
  });
  root.querySelectorAll('[data-assistant-confirm]').forEach(button => {
    button.onclick = async () => {
      const action = getAction(button.dataset.assistantConfirm);
      if (!action) return;
      button.disabled = true;
      try {
        await runConfirmedAction(action, apiFetch);
        action.status = 'done';
        action.error = '';
        toast(action.summary ? `Done: ${action.summary}` : 'Done');
      } catch (error) {
        action.error = error?.message || 'That did not work';
        toast(action.error);
      }
      rerender();
    };
  });
  root.querySelectorAll('[data-assistant-dismiss]').forEach(button => {
    button.onclick = () => {
      const action = getAction(button.dataset.assistantDismiss);
      if (!action) return;
      action.status = 'dismissed';
      rerender();
    };
  });
  root.querySelectorAll('[data-assistant-screen]').forEach(button => {
    button.onclick = () => {
      const action = getAction(button.dataset.assistantScreen);
      if (action?.screen) openScreen(action);
    };
  });
  globalThis.lucide?.createIcons?.();
}
