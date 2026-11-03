/**
 * Panels added below the core Settings page: danger zone, archived records,
 * phone (usage, Twilio, AgentPhone) and apps & billing. These used to be four
 * separate `settings = function () { … }` overrides in legacy.js; one ordered
 * list here replaces them. Each panel is a pure function of the viewer so it
 * can be tested without the app.
 *
 * `deps`: { icon, escapeHtml, archiveNote, phoneUsagePanel, twilioPanel, apiUrl, shopId }
 */
export function dangerZonePanel({ icon }) {
  return `<section class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Danger zone</div><h2>Start with a clean slate</h2><p>Remove every shop record while keeping employee access and subscription verification intact.</p></div><button type="button" class="danger" id="open-full-reset">${icon("trash-2", 14)} Remove all shop data</button></div></section>`;
}

export function archivedRecordsPanel({ icon, escapeHtml, archiveNote }) {
  return `<section class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Records</div><h2>Archived records</h2><p>${escapeHtml(archiveNote)}</p></div><button type="button" class="secondary" id="open-archived-records">${icon("archive", 14)} View archived records</button></div></section>`;
}

export function agentPhonePanel({ icon, escapeHtml, apiUrl, shopId }) {
  return `<section class="settings-panel agentphone-settings"><div class="statement-head"><div><div class="eyebrow">Optional third-party</div><h2>Connect AgentPhone.ai</h2><p>Optional separate product. Twilio credentials go in the <b>Shop phone (Twilio)</b> panel above — not here.</p></div>${icon("phone-call", 20)}</div><form class="form-grid" id="agentphone-config-form"><label>AgentPhone API key *<input name="apiKey" type="password" autocomplete="new-password" placeholder="ap_..." required/></label><label>Agent ID *<input name="agentId" placeholder="agt_..." required/></label><label>Conversation history<input name="contextLimit" type="number" min="0" max="50" value="10"/></label><label>Voice response timeout<input name="timeout" type="number" min="5" max="120" value="30"/></label><div class="full agentphone-webhook-preview"><span>Webhook URL</span><code>${apiUrl}/agentphone/webhook/${escapeHtml(shopId)}</code></div><div class="full"><button class="primary" type="submit">${icon("plug-zap", 14)} Connect AgentPhone</button><small class="form-help">The AgentPhone webhook signing secret is generated and encrypted and stored in D1 by the Worker.</small></div></form></section>`;
}

export function appsBillingPanel({ icon }) {
  return `<section class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Apps and subscription</div><h2>Install ShopCrank and manage plan</h2><p>Download Windows or Android apps, install the web app on a phone home screen, or convert a free shop to paid.</p></div></div><div class="download-actions"><a class="secondary" href="/downloads" target="_blank" rel="noopener">${icon("download", 14)} Open downloads page</a><a class="secondary" href="/downloads/ShopCrank.apk">${icon("smartphone", 14)} Android APK</a><a class="secondary" href="/api/downloads/ShopCrank-Setup-1.1.0.exe">${icon("monitor", 14)} Windows setup</a><button type="button" class="primary" id="upgrade-shop-plan">${icon("sparkles", 14)} Upgrade to paid</button></div></section>`;
}

/**
 * Which panels a viewer sees, in page order.
 * viewer: { role, canDeleteRecords, offline }
 */
export function settingsExtraPanels(viewer, deps) {
  const role = String(viewer?.role || '');
  const isAdmin = role === 'admin';
  const panels = [];
  if (isAdmin) panels.push(dangerZonePanel(deps));
  if (viewer?.canDeleteRecords && !viewer?.offline) panels.push(archivedRecordsPanel(deps));
  panels.push(deps.phoneUsagePanel());
  if (deps.twilioPanel || isAdmin) {
    panels.push(deps.twilioPanel || '');
    if (isAdmin) panels.push(agentPhonePanel(deps));
  }
  if (['admin', 'super_admin'].includes(role)) panels.push(appsBillingPanel(deps));
  return panels.join('');
}
