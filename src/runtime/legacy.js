/* global DOMPurify */
import { storageKeys } from '../shared/config.js';
import { escapeAttr, escapeHtml } from '../shared/html.js';
import { DESKTOP_ENTITLEMENT_INTERVAL, isDesktopApp } from '../modules/platform/detect.js';
import { chatTime, cleanEmail } from '../modules/chat/utils.js';
import { prepareEntityMutation, withOptimisticConcurrencyHeaders } from './prepare-entity-mutation.js';
import { IMPORT_TYPES, prepareImportRecords } from '../modules/imports.js';
import { CANNED_MENU, cannedServiceGroups, estimateLineFromService, missingCannedServices } from '../modules/canned-services.js';
import { buildRepairGuide, repairDiagram, safeVideoUrl, stepText } from '../modules/repair-guide.js';
import { inspectionMenuHtml } from '../modules/shop-inspections.js';
import { autozoneProLoginUrl, orderingPanelHtml } from '../modules/autozone-pro.js';
import { partstechPanelHtml } from '../modules/partstech.js';
import { laborGuidePanelHtml, createManualLaborEntry } from '../modules/labor-guide.js';
import { shopAiPanelHtml } from '../modules/shop-ai-settings.js';
import { quickbooksPanelHtml } from '../modules/quickbooks.js';
import { applyEstimateFromInspection } from '../modules/repair-order-flow.js';
import { uploadFailureMessage, uploadFileToStorage } from '../modules/file-upload.js';
import { applyAiWorkflowEstimate } from '../modules/ai-workflow.js';
import {
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  CUSTOMER_SEARCH_MIN_LENGTH,
  customerContactChanged,
  customerContactFields,
  likelyDuplicateCustomers,
  localCustomerMatches,
  mergeSavedCustomer,
  shouldSearchCustomers,
} from '../modules/customer-intake.js';
import * as Mileage from '../modules/mileage.js';
import * as Filing from '../modules/filing/index.js';
import { customerLifetimeSpend } from '../modules/customer-metrics.js';
import { applyShopSnapshot, ensureOfflineOwner, isOfflineDesktop, offlineLoginMarkup, offlineSession, snapshotShop } from '../modules/offline-desktop.js';
import { presentCatalogInspection, printCatalogInspection } from './catalog-inspection-ui.js';
import { applyQueuedEntityMutations } from './entity-persistence.js';
import { createMutationQueueStore } from './mutation-queue-store.js';
import { paymentSummary } from '../modules/payments.js';
import { cardTerminalModel, recoveryWriteup } from '../modules/card-terminal.js';
import { syncHelp } from '../modules/help-menu.js';
import {
  applyAssignments,
  assignmentSummary,
  attributeClockHours,
  classificationFor,
  clockedHours,
  orderIncludesTechnician,
  payrollLinesForOrder,
  PAY_PLANS,
  EMPLOYEE_CLASSIFICATIONS,
  technicianTrackerHtml,
  technicianPerformance,
} from '../modules/technician-assignment.js';
import {
  INTAKE_STORAGE_KEY,
  emptyIntakeDraft,
  findIntakeCustomer,
  intakeOrderPayload,
  localDiagnosticChecklist,
  mountIntakeWizard,
  serializableIntake,
} from '../modules/intake-wizard.js';
import {
  customLaborDraft,
  customersWithSelected,
  estimateEditorDescription,
  invoicePrintLineItems,
  isLegacyAfterMidnightLine,
  terminalOrderChangesAfterMidnightFee,
} from '../modules/work-order-editor.js';
import {
  afterMidnightFeeLine,
  approvedEstimate,
  billableEstimateLines,
  calculateEstimate,
  estimatePartPriceStatus,
  invoiceRecordForOrder,
  invoiceWithEditedWorkOrder,
  laborLinePrintRows,
  normalizeEstimateLine,
  normalizeTechnicianIds,
  workOrderWithEditedEstimate,
} from '../modules/estimate-workflow.js';
import {
  REFERENCE_ESTIMATE,
  calculateShopEstimate,
  estimateFromAssistantDraft,
  workOrderDraftFromEstimate,
} from '../modules/estimate-templates.js';
import { KEY_OPERATIONS, assertKeyJobAllowed, assertLiveKeySession, isRoAuthorizedForKeys, keyAuditRecord, keyConfirmationMatches, liveKeyProcedureFor, normalizeVin, simulateKeyJob, simulateObdScan } from '../modules/shop-os/bay.js';
import {
  APPROVAL_CUSTOM_LABEL_MAX,
  APPROVAL_NOTE_MAX,
  ESTIMATE_APPROVAL_TYPES,
  approvalRecorder,
  approvalSummary,
  normalizeEstimateApproval,
  validateEstimateApproval,
} from '../modules/estimate-approval.js';
const { buildHomeModel, emptyState, greetingForNow, localIsoDate, mergeRemoteCollection, pendingCreateIdsForCollection, visibleSidebar } = window.__MECHPRO_HOME__;
void escapeAttr;
function safeHtml(markup) {
  const html = String(markup ?? "");
  if (typeof DOMPurify === "undefined" || typeof DOMPurify.sanitize !== "function") return html;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
}
function empty(message) { return emptyState(message) }
function localAssistantReply(message) { const source = aiKeywords(message), order = state.orders.find(item => [item.id, item.customer, item.vehicle].some(value => source.includes(String(value || "").toLowerCase()))); if (order) return `${order.id} is ${statusLabel[order.status] || order.status} for ${order.customer}. Vehicle: ${order.vehicle}. Concern: ${order.complaint}. Technician: ${order.tech || "Unassigned"}. Promise: ${order.promise || "Not scheduled"}. Verify the record before acting.`; if (/diagnos|check engine|misfire|brake|rough idle|warning light/.test(source)) return "The cloud assistant is temporarily unavailable. Record the exact symptoms, DTCs, freeze-frame data, and vehicle VIN, then verify tests and specifications with current manufacturer service information."; if (/schedule|appointment|available|book/.test(source)) return `There are ${state.appointments.length} appointments loaded locally. Confirm the date, time, customer, and technician before booking.`; return "The cloud assistant is temporarily unavailable because the AI provider is rate-limited. Loaded work orders and local workflow guidance remain available; try again after the provider quota resets." }
function chatUser(email) { return state.users.find(user => cleanEmail(user.email) === cleanEmail(email)) }
function chatTitle(conversation) { if (conversation.kind === "group") return conversation.name || "Team group"; const other = conversation.memberEmails.map(chatUser).find(user => user && user.id !== currentUser().id); return other?.name || "Direct message" }
let chatDerivedCache = null;
function getChatDerived() {
  const key = [
    state.conversations.length,
    state.chatMessages.length,
    Object.keys(state.chatLastRead || {}).length,
    state.chatMessages.at(-1)?.id || state.chatMessages.at(-1)?.createdAt || '',
    state.conversations.at(-1)?.id || '',
    cleanEmail(currentUser()?.email),
  ].join('|');
  if (chatDerivedCache?.key === key) return chatDerivedCache;
  const messagesByConversation = new Map();
  for (const message of state.chatMessages) {
    if (!message?.conversationId) continue;
    const list = messagesByConversation.get(message.conversationId) || [];
    list.push(message);
    messagesByConversation.set(message.conversationId, list);
  }
  for (const list of messagesByConversation.values()) list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const activityByConversation = new Map();
  const unreadByConversation = new Map();
  const me = cleanEmail(currentUser()?.email);
  for (const conversation of state.conversations) {
    const list = messagesByConversation.get(conversation.id) || [];
    activityByConversation.set(conversation.id, list.at(-1)?.createdAt || conversation.createdAt || '');
    const readAt = state.chatLastRead?.[conversation.id] || '';
    let unread = 0;
    for (const message of list) {
      if (cleanEmail(message.senderEmail) !== me && String(message.createdAt) > readAt) unread += 1;
    }
    unreadByConversation.set(conversation.id, unread);
  }
  chatDerivedCache = { key, messagesByConversation, activityByConversation, unreadByConversation };
  return chatDerivedCache;
}
function conversationMessages(id) { return getChatDerived().messagesByConversation.get(id) || [] }
function conversationActivity(conversation) { return getChatDerived().activityByConversation.get(conversation.id) || conversation.createdAt || "" }
function chatUnread(conversation) { return getChatDerived().unreadByConversation.get(conversation.id) || 0 }
function teamChat() { const conversations = [...state.conversations].sort((a, b) => conversationActivity(b).localeCompare(conversationActivity(a))); if (!conversations.some(item => item.id === chatConversationId)) chatConversationId = conversations[0]?.id || null; const active = conversations.find(item => item.id === chatConversationId), messages = active ? conversationMessages(active.id) : []; const list = conversations.map(item => { const last = conversationMessages(item.id).at(-1), unread = chatUnread(item); return `<button class="chat-thread ${active?.id === item.id ? "active" : ""}" data-chat-thread="${item.id}"><span class="chat-thread-icon">${icon(item.kind === "group" ? "users" : "user", 15)}</span><span><strong>${escapeHtml(chatTitle(item))}</strong><small>${escapeHtml(last?.body || (item.kind === "group" ? `${item.memberEmails.length} members` : "Start a conversation"))}</small></span>${unread ? `<b>${unread}</b>` : ""}</button>` }).join(""); const messageList = messages.map(message => { const sender = chatUser(message.senderEmail), mine = cleanEmail(message.senderEmail) === cleanEmail(currentUser().email); return `<article class="chat-message ${mine ? "mine" : ""}"><div><strong>${mine ? "You" : escapeHtml(sender?.name || message.senderEmail)}</strong><time>${chatTime(message.createdAt)}</time></div><p>${escapeHtml(message.body)}</p></article>` }).join(""); return shell(`${heading("Internal communications", "Team chat", "Private employee messages and owner-managed group conversations.", false)}<section class="chat-workspace"><aside class="chat-threads"><div class="chat-actions"><button class="secondary" id="new-direct-chat">${icon("message-square-plus", 14)} New message</button>${currentUser().role === "admin" ? `<button class="icon-button" id="new-group-chat" title="Create group chat">${icon("users-round", 15)}</button>` : ""}<button class="icon-button" id="refresh-chat" title="Refresh messages">${icon("refresh-cw", 15)}</button></div><div class="chat-thread-list">${list || `<div class="chat-empty-small">No conversations yet.</div>`}</div></aside><div class="chat-room">${active ? `<header class="chat-room-head"><div><span>${active.kind === "group" ? "Group conversation" : "Direct message"}</span><h2>${escapeHtml(chatTitle(active))}</h2><small>${active.memberEmails.map(email => chatUser(email)?.name || email).map(escapeHtml).join(" · ")}</small></div>${active.kind === "group" && currentUser().role === "admin" ? `<button class="secondary" id="manage-chat-group">${icon("user-cog", 14)} Members</button>` : ""}</header><div class="chat-messages">${messageList || `<div class="chat-empty">${icon("messages-square", 30)}<h3>No messages yet</h3><p>Send the first message to start this conversation.</p></div>`}</div><form class="chat-composer" id="chat-message-form"><textarea name="body" maxlength="4000" required placeholder="Message ${escapeHtml(chatTitle(active))}"></textarea><button class="primary" type="submit" title="Send message">${icon("send", 16)} Send</button></form>` : `<div class="chat-empty">${icon("message-circle", 34)}<h2>Start a team conversation</h2><p>Message an employee directly or create an owner-managed group.</p><button class="primary" id="empty-new-direct">${icon("message-square-plus", 14)} New message</button></div>`}</div></section>`) }
function openDirectChat() { const people = state.users.filter(user => user.active && user.id !== currentUser().id); showModal(`<form class="modal" id="direct-chat-form"><div class="modal-head"><h2>New direct message</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><label>Employee<select name="email" required>${people.map(user => `<option value="${escapeHtml(user.email)}">${escapeHtml(user.name)} · ${escapeHtml(user.title || roleLabel[user.role])}</option>`).join("")}</select></label></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("message-square-plus", 14)} Open chat</button></div></form>`); document.querySelector("#direct-chat-form").onsubmit = async event => { event.preventDefault(); const email = cleanEmail(new FormData(event.target).get("email")), members = [cleanEmail(currentUser().email), email].sort((a, b) => a.localeCompare(b)), existing = state.conversations.find(item => item.kind === "direct" && JSON.stringify([...item.memberEmails].sort((a, b) => a.localeCompare(b))) === JSON.stringify(members)); if (existing) { chatConversationId = existing.id; closeModal(); markChatRead(existing.id); render(); return } try { const record = await apiFetch("/entities/conversations", { method: "POST", body: JSON.stringify({ id: `conversation-${Date.now()}`, kind: "direct", memberEmails: members, createdAt: now() }) }); state.conversations.push(record); chatConversationId = record.id; save(); closeModal(); render() } catch (error) { toast("Could not create the conversation") } } }
function openGroupChat(conversation = null) { const selected = new Set(conversation?.memberEmails || [cleanEmail(currentUser().email)]), people = state.users.filter(user => user.active); showModal(`<form class="modal" id="group-chat-form"><div class="modal-head"><h2>${conversation ? "Manage group" : "New group chat"}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><label>Group name<input name="name" maxlength="80" required value="${escapeHtml(conversation?.name || "")}" placeholder="e.g. Service team"/></label><fieldset class="chat-member-picker"><legend>Members</legend>${people.map(user => `<label><input type="checkbox" name="members" value="${escapeHtml(user.email)}" ${selected.has(cleanEmail(user.email)) ? "checked" : ""} ${user.id === currentUser().id ? "disabled" : ""}/><span class="avatar">${initials(user.name)}</span><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.title || roleLabel[user.role])}</small></span></label>`).join("")}</fieldset></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("users", 14)} ${conversation ? "Save members" : "Create group"}</button></div></form>`); document.querySelector("#group-chat-form").onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target), members = [cleanEmail(currentUser().email), ...form.getAll("members").map(cleanEmail)].filter((email, index, list) => email && list.indexOf(email) === index); if (members.length < 2) { toast("Add at least one employee to the group"); return } const record = { ...(conversation || {}), id: conversation?.id || `conversation-${Date.now()}`, kind: "group", name: String(form.get("name")).trim(), memberEmails: members, createdAt: conversation?.createdAt || now() }; try { const saved = await apiFetch(`/entities/conversations${conversation ? `/${encodeURIComponent(conversation.id)}` : ""}`, { method: conversation ? "PUT" : "POST", body: JSON.stringify(record) }); if (conversation) Object.assign(conversation, saved); else state.conversations.push(saved); chatConversationId = saved.id; save(); closeModal(); render() } catch (error) { toast("Could not save the group conversation") } } }
function markChatRead(id) { state.chatLastRead ??= {}; state.chatLastRead[id] = now(); save() }
async function loadChatFromApi() { try { const [conversations, messages] = await Promise.all([apiFetch("/entities/conversations"), apiFetch("/entities/chatmessages")]); state.conversations = conversations; state.chatMessages = messages; save() } catch (error) { console.error("Failed to load team chat; using local data", error) } }
async function sendChatMessage(conversationId, body) { const record = await apiFetch("/entities/chatmessages", { method: "POST", body: JSON.stringify({ id: `chatmessage-${Date.now()}`, conversationId, body, createdAt: now() }) }); state.chatMessages.push(record); markChatRead(conversationId); return record }
function scheduleChatRefresh() { clearTimeout(chatRefreshTimer); if (state.route !== "chat") return; chatRefreshTimer = setTimeout(async () => { if (state.route !== "chat") return; await loadChatFromApi(); render() }, 10000) }
function bindTeamChat() { document.querySelector("#new-direct-chat")?.addEventListener("click", openDirectChat); document.querySelector("#empty-new-direct")?.addEventListener("click", openDirectChat); document.querySelector("#new-group-chat")?.addEventListener("click", () => openGroupChat()); document.querySelector("#manage-chat-group")?.addEventListener("click", () => openGroupChat(state.conversations.find(item => item.id === chatConversationId))); document.querySelector("#refresh-chat")?.addEventListener("click", async () => { await loadChatFromApi(); toast("Team chat refreshed"); render() }); document.querySelectorAll("[data-chat-thread]").forEach(button => button.onclick = () => { chatConversationId = button.dataset.chatThread; markChatRead(chatConversationId); render() }); document.querySelector("#chat-message-form")?.addEventListener("submit", async event => { event.preventDefault(); const body = String(new FormData(event.target).get("body") || "").trim(), button = event.target.querySelector("button"); if (!body) return; button.disabled = true; try { await sendChatMessage(chatConversationId, body); render() } catch (error) { toast("Message could not be sent"); button.disabled = false } }) }
function payments() {
  const config = state.billingSettings;
  const status = stripePaymentStatus;
  const configured = Boolean(status?.configured || config.enabled);
  const shopId = status?.shopId || sessionClaimShopId(authSession()?.claims) || "";
  const webhookUrl = status?.webhookUrl || (shopId ? `${location.origin}${cloudflareConfig.apiUrl}/payments/webhook/${encodeURIComponent(shopId)}` : "");
  const statusLabel = configured
    ? `Connected${config.accountLabel ? ` · ${escapeHtml(config.accountLabel)}` : ""}`
    : "Stripe keys not saved yet";
  return shell(`${heading("Online payments", "Payment service", "Connect this shop's Stripe account so customers can pay invoices online with a hosted Checkout link.", false)}<section class="messaging-panel"><div class="messaging-status ${configured ? "ready" : "idle"}">${icon(configured ? "circle-check" : "credit-card", 17)}<div><strong>${configured ? "Online card payments ready" : "Online card payments not connected"}</strong><span>${statusLabel}. Secrets stay encrypted on the Worker — the browser never stores them.</span></div></div><div class="service-contract"><h2>Stripe Checkout for invoices</h2><p>Paste your Stripe secret key and webhook signing secret. MechPro creates Checkout Sessions through <code>POST /payments/checkout-session</code> and records payments when Stripe posts <code>checkout.session.completed</code> to your shop webhook.</p><label class="full">Webhook endpoint (Stripe Dashboard → Developers → Webhooks)<input id="stripe-webhook-url" readonly value="${escapeAttr(webhookUrl)}" placeholder="Sign in to load the shop webhook URL"/><div class="messaging-actions"><button class="secondary" type="button" id="copy-stripe-webhook" ${webhookUrl ? "" : "disabled"}>${icon("copy", 14)} Copy webhook URL</button></div></label><p class="ai-disclaimer">Subscribe the webhook to event <b>checkout.session.completed</b> only. Use test keys (<code>sk_test_</code>) until you are ready for live cards.</p></div><form class="form-grid" id="billing-form"><label class="full">Stripe secret key *<input name="secretKey" type="password" autocomplete="off" placeholder="sk_test_… or sk_live_…" ${configured ? "" : "required"}/><small>${configured ? "Leave blank to keep the saved key. Enter a new key only to replace it." : "Required. Starts with sk_test_ or sk_live_."}</small></label><label class="full">Webhook signing secret *<input name="webhookSecret" type="password" autocomplete="off" placeholder="whsec_…" ${configured ? "" : "required"}/><small>${configured ? "Leave blank to keep the saved signing secret." : "From the Stripe webhook endpoint details."}</small></label><label class="full">Stripe publishable key<input name="publishableKey" autocomplete="off" placeholder="pk_test_… or pk_live_…"/><small>${status?.hasPublishableKey ? "Saved. Enter a new key only to replace it. Required for phone orders." : "Starts with pk_test_ or pk_live_. Required before the office can type a card for a phone order."}</small></label><label>Account label<input name="accountLabel" value="${escapeAttr(config.accountLabel || "")}" placeholder="e.g. Main shop Stripe"/></label><label>Shop name on receipts<input name="shopName" value="${escapeAttr(config.shopName || "Your Car Guy")}"/></label><label class="toggle-field full"><input type="checkbox" name="enabled" ${config.enabled || configured ? "checked" : ""}/><span>Enable Pay online on open invoices</span></label><div class="full messaging-actions"><button class="secondary" type="button" id="refresh-stripe-status">${icon("refresh-cw", 14)} Refresh status</button><button class="primary" type="submit">${icon("save", 14)} Save Stripe keys</button></div></form></section>`);
}
let posReaders = null;
let posConfigured = false;
let posCharge = null;
let posPollTimer = 0;
let posSelectedId = "";
let posMode = "reader";
let posPhoneEntry = false;
let posStripe = null;
function cardTerminal() {
  const model = cardTerminalModel({
    orders: state.orders || [],
    invoices: state.invoices || [],
    payments: state.payments || [],
    selectedId: posSelectedId,
    readers: posReaders || [],
    configured: posConfigured,
    paymentSummary,
  });
  const selected = model.selected;
  if (selected) posSelectedId = selected.targetId;
  const options = model.choices.map(choice => `<option value="${escapeAttr(choice.targetId)}" ${selected?.targetId === choice.targetId ? "selected" : ""}>${escapeHtml(choice.label)} · due ${money(choice.balance)}</option>`).join("");
  const readerOptions = model.readers.map(reader => `<option value="${escapeAttr(reader.id)}">${escapeHtml(reader.label)} · ${escapeHtml(reader.status)}</option>`).join("");
  const writeup = selected ? recoveryWriteup({ customer: selected.customer, vehicle: selected.vehicle }) : recoveryWriteup({});
  const chargeNote = posCharge ? `<p class="pos-status" data-phase="${escapeAttr(posCharge.phase || "")}">${escapeHtml(posCharge.message || "")}</p>` : "";
  const connection = posReaders === null
    ? "Checking the shop Stripe account…"
    : model.configured
      ? (model.readers.length ? `${model.readers.length} reader${model.readers.length === 1 ? "" : "s"} online in this Stripe account.` : "Stripe is connected. No card reader is registered yet. Add one in the Stripe Dashboard under Terminal, then refresh.")
      : "Stripe is not connected. An owner saves the shop keys on the Payments page before this counter can take a card.";
  const identity = `<div class="full pos-identity"><span>Customer</span><strong>${escapeHtml(selected?.customer || "Select a work order")}</strong><span>Vehicle</span><strong>${escapeHtml(selected?.vehicle || "Vehicle comes from the work order")}</strong></div>`;
  const amountField = `<label>Amount<input name="amount" id="pos-amount" type="number" min="0.50" step="0.01" value="${selected && selected.balance >= 0.5 ? selected.balance.toFixed(2) : ""}" required/></label>`;
  const orderField = `<label class="full">Work order<select name="orderId" id="pos-order" required>${options || `<option value="">No work orders</option>`}</select></label>`;
  const phoneNotice = posPhoneEntry
    ? "Type the card number, expiration, security code, and postal code from the phone call. Stripe collects the card. MechPro stores the approval on the work order."
    : "Add the Stripe publishable key on the Payments page first. It starts with pk_test_ or pk_live_ and must belong to the same account as the secret key.";
  const counter = posMode === "phone"
    ? `<form class="form-grid" id="pos-phone-form">${orderField}${identity}${amountField}<div class="full" id="pos-card-element"></div><p class="ai-disclaimer">${escapeHtml(phoneNotice)}</p><div class="full messaging-actions"><button class="primary" type="submit" id="pos-phone-prepare" ${!selected || selected.balance < 0.5 || !posPhoneEntry ? "disabled" : ""}>${icon("credit-card", 14)} Enter card</button><button class="primary" type="button" id="pos-phone-charge" hidden>${icon("check", 14)} Charge card</button></div><p class="pos-status" id="pos-phone-status" hidden></p></form>`
    : `<form class="form-grid" id="pos-form">${orderField}${identity}${amountField}<label>Reader<select name="readerId" id="pos-reader" required>${readerOptions || `<option value="">No reader</option>`}</select></label><div class="full messaging-actions"><button class="secondary" type="button" id="pos-refresh">${icon("refresh-cw", 14)} Refresh readers</button><button class="secondary" type="button" id="pos-cancel" ${posCharge ? "" : "disabled"}>${icon("x", 14)} Cancel on reader</button><button class="primary" type="submit" id="pos-charge" ${!selected || selected.balance < 0.5 || !model.readers.length ? "disabled" : ""}>${icon("credit-card", 14)} Charge card</button></div>${chargeNote}</form>`;
  return shell(`${heading("Front counter", "Card terminal", "Take a card on the reader, or type a card for a purchase made over the phone.", false)}<section class="messaging-panel pos-terminal"><div class="messaging-status ${model.configured ? "ready" : "idle"}">${icon("credit-card", 17)}<div><strong>${posMode === "phone" ? "Phone order" : model.configured ? "Card reader ready" : "Card reader not connected"}</strong><span>${escapeHtml(posMode === "phone" ? phoneNotice : connection)}</span></div></div><div class="accounting-tabs"><button class="tab ${posMode === "reader" ? "active" : ""}" type="button" data-pos-mode="reader">Card reader</button><button class="tab ${posMode === "phone" ? "active" : ""}" type="button" data-pos-mode="phone">Phone order</button></div>${counter}<section class="pos-writeup"><h2>Technician write-up</h2><p>The recovery note uses the customer and vehicle on the selected work order.</p><pre id="pos-writeup">${escapeHtml(writeup.ready ? writeup.text : "Select a work order that has both a customer name and a vehicle. Those details are written into the note. They are not filled in from memory.")}</pre><button class="secondary" type="button" id="pos-save-writeup" ${writeup.ready ? "" : "disabled"}>${icon("save", 14)} Save on work order</button></section></section>`);
}
function messaging() { const config = state.messagingSettings; return shell(`${heading("Delivery infrastructure", "Messaging service", "Connect this shop's own secure delivery service for automatic email and SMS.", false)}<section class="messaging-panel"><div class="messaging-status ${config.enabled ? "ready" : "idle"}">${icon(config.enabled ? "circle-check" : "circle-alert", 17)}<div><strong>${config.enabled ? "Shop messaging service active" : "Native device messaging is active"}</strong><span>${config.enabled ? "Estimate and customer messages will post to the configured shop endpoint." : "Messages currently open the device email or SMS app."}</span></div></div><div class="service-contract"><h2>Shop-managed delivery endpoint</h2><p>Configure a secure endpoint owned by the subscribing shop. It stores SMTP and SMS provider credentials server-side; MechPro never stores or exposes those credentials in the browser.</p><code>POST /messages<br>{ channel: "email" | "sms", to, subject, body, metadata }</code></div><form class="form-grid" id="messaging-form"><label class="full">Secure service endpoint *<input name="endpoint" type="url" value="${config.endpoint}" placeholder="https://messaging.yourshop.com/messages"/></label><label>Sender email<input name="senderEmail" type="email" value="${config.senderEmail}" placeholder="service@yourshop.com"/></label><label>Sender phone<input name="senderPhone" type="tel" value="${config.senderPhone}" placeholder="+18065550100"/></label><label class="full">Shop name<input name="shopName" value="${config.shopName || "Your Car Guy"}"/></label><label class="toggle-field full"><input type="checkbox" name="enabled" ${config.enabled ? "checked" : ""}/><span>Use this endpoint for customer email and SMS delivery</span></label><div class="full messaging-actions"><button class="secondary" type="button" id="test-messaging">${icon("send", 14)} Test configuration</button><button class="primary" type="submit">${icon("save", 14)} Save messaging service</button></div></form></section>`) }
let integrationStatus = null, laborLookupResults = [], partsLookupResult = null;
async function loadIntegrationStatus() { try { integrationStatus = await apiFetch("/integrations/status") } catch (error) { integrationStatus = { error: error.message } } }
function integrationState(name, configured) { return `<div class="messaging-status ${configured ? "ready" : "idle"}">${icon(configured ? "circle-check" : "circle-alert", 17)}<div><strong>${escapeHtml(name)}</strong><span>${configured ? "Configured and available" : "Not configured — this feature stays disabled until credentials are added"}</span></div></div>` }
function integrations() {
  if (!integrationStatus) void loadIntegrationStatus().then(render);
  const status = integrationStatus || {};
  const labor = status.labor || {}, parts = status.parts || {}, qbo = status.quickbooks || {};
  const laborRows = laborLookupResults.map(item => `<tr><td>${escapeHtml(item.description || "Labor operation")}</td><td><b>${item.hours == null ? "Enter manually" : `${Number(item.hours).toFixed(2)} h`}</b></td><td>${escapeHtml(item.source)}</td><td><span class="badge ${item.verified ? "paid" : "estimate"}">${item.verified ? "Verified" : "Unverified"}</span></td></tr>`).join("");
  const partsOutput = partsLookupResult ? `<pre class="service-contract">${escapeHtml(JSON.stringify(partsLookupResult, null, 2))}</pre>` : "";
  return shell(`${heading("Connected services", "Integrations", "Licensed labor, supplier ordering, accounting, and messaging connections.", false)}
    <section class="messaging-panel"><h2>Licensed labor guide</h2>${integrationState("MOTOR", labor.motor?.configured)}${integrationState("ALLDATA", labor.alldata?.configured)}
      <form class="form-grid" id="labor-lookup-form"><label>VIN<input name="vin" maxlength="17"/></label><label>Year<input name="year" type="number" min="1886" max="2200"/></label><label>Make<input name="make"/></label><label>Model<input name="model"/></label><label class="full">Operation<input name="query" required placeholder="Front brake pads and rotors"/></label><div class="full"><button class="primary" type="submit">${icon("search", 14)} Find labor time</button></div></form>
      ${laborRows ? `<div class="data-panel"><table><thead><tr><th>Operation</th><th>Hours</th><th>Source</th><th>Status</th></tr></thead><tbody>${laborRows}</tbody></table></div>` : ""}</section>
    <section class="messaging-panel"><h2>Parts ordering</h2>${integrationState("PartsTech", parts.partstech?.configured || parts.partstech?.hasPunchout)}${integrationState("Nexpart", parts.nexpart?.configured || parts.nexpart?.hasPunchout)}
      <form class="form-grid" id="parts-search-form"><label>Provider<select name="provider"><option value="partstech">PartsTech</option><option value="nexpart">Nexpart</option></select></label><label>Action<select name="operation"><option value="search">Search</option><option value="quote">Quote</option><option value="order">Place order</option></select></label><label>Part / keyword or quote ID<input name="query" required/></label><label>VIN<input name="vin" maxlength="17"/></label><div class="full messaging-actions"><button class="primary" type="submit">${icon("send", 14)} Send to provider</button><button class="secondary" type="button" id="parts-punchout">${icon("external-link", 14)} Open punch-out</button></div></form>${partsOutput}</section>
    <section class="messaging-panel"><h2>QuickBooks Online</h2>${integrationState("Intuit app", qbo.configured)}<p>Connect an administrator-approved Intuit app, then sync customers, invoices, and payments one way from MechPro.</p><button class="primary" id="quickbooks-connect" ${qbo.configured ? "" : "disabled"}>${icon("plug-zap", 14)} Connect QuickBooks</button><form class="form-grid" id="quickbooks-sync-form"><label>Record type<select name="entityType"><option value="customer">Customer</option><option value="invoice">Invoice</option><option value="payment">Payment</option></select></label><label>MechPro record ID<input name="entityId" required placeholder="customer-123 or INV-2041"/></label><div class="full"><button class="secondary" type="submit">${icon("refresh-cw", 14)} Sync to QuickBooks</button></div></form></section>`);
}
function support() {
  if (!integrationStatus) void loadIntegrationStatus().then(render);
  const statusUrl = integrationStatus?.support?.statusPageUrl;
  return shell(`${heading("Help", "Help & support", "Self-service answers and a direct ticket path for shop-impacting issues.", false)}
    <section class="messaging-panel"><div class="statement-head"><div><div class="eyebrow">Help center</div><h2>Common questions</h2></div>${icon("life-buoy", 20)}</div>
      <details><summary>Why does a labor time say unverified?</summary><p>MOTOR or ALLDATA has not returned a licensed operation. Confirm the vehicle and operation, then enter shop time manually.</p></details>
      <details><summary>Why is texting unavailable?</summary><p>The platform Twilio number, webhook, and A2P 10DLC campaign must be configured. Customers who text STOP remain blocked until they text START.</p></details>
      <details><summary>How do I connect accounting?</summary><p>An admin opens Integrations, connects the approved Intuit app, and syncs MechPro records one way to QuickBooks Online.</p></details>
      <details><summary>How do I import existing shop data?</summary><p>Use Import data for supported CSV files. Request assisted migration below for mapping, validation, and reconciliation.</p></details>
      ${statusUrl ? `<p><a class="secondary" href="${escapeAttr(statusUrl)}" target="_blank" rel="noopener noreferrer">${icon("activity", 14)} Service status</a></p>` : ""}</section>
    <section class="messaging-panel"><h2>Contact support</h2><form class="form-grid" id="support-ticket-form"><label>Category<select name="category"><option value="technical">Technical issue</option><option value="billing">Billing</option><option value="onboarding">Onboarding</option><option value="data_migration">Data migration</option><option value="feedback">Feedback</option></select></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="urgent">Urgent — shop blocked</option></select></label><label class="full">Subject<input name="subject" maxlength="160" required/></label><label class="full">What happened?<textarea name="description" maxlength="8000" required placeholder="Include the affected work order, expected result, and exact error. Do not include passwords or card data."></textarea></label><div class="full"><button class="primary" type="submit">${icon("send", 14)} Submit ticket</button></div></form></section>`);
}
function bindIntegrations() {
  document.querySelector("#labor-lookup-form")?.addEventListener("submit", async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); try { const result = await apiFetch("/labor-times/search", { method: "POST", body: JSON.stringify(data) }); laborLookupResults = result.results || []; render() } catch (error) { toast(error.message) } });
  document.querySelector("#parts-search-form")?.addEventListener("submit", async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); if (data.operation === "order" && !confirm(`Place this ${data.provider} order? The supplier may charge the connected account.`)) return; try { partsLookupResult = await apiFetch(`/parts/${encodeURIComponent(data.provider)}/${encodeURIComponent(data.operation)}`, { method: "POST", body: JSON.stringify({ query: data.query, quoteId: data.query, vin: data.vin }) }); render() } catch (error) { toast(error.message) } });
  document.querySelector("#parts-punchout")?.addEventListener("click", async () => { const provider = document.querySelector("#parts-search-form [name=provider]").value; try { const result = await apiFetch(`/parts/${encodeURIComponent(provider)}/punchout`); window.open(result.url, "_blank", "noopener,noreferrer") } catch (error) { toast(error.message) } });
  document.querySelector("#quickbooks-connect")?.addEventListener("click", async () => { try { const result = await apiFetch("/quickbooks/connect", { method: "POST", body: "{}" }); window.location.assign(result.authorizationUrl) } catch (error) { toast(error.message) } });
  document.querySelector("#quickbooks-sync-form")?.addEventListener("submit", async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); try { const result = await apiFetch("/quickbooks/sync", { method: "POST", body: JSON.stringify(data) }); toast(`Synced as QuickBooks ID ${result.syncMetadata?.quickBooksId || "created"}`) } catch (error) { toast(error.message) } });
  document.querySelector("#support-ticket-form")?.addEventListener("submit", async event => { event.preventDefault(); const button = event.target.querySelector("button[type=submit]"), data = Object.fromEntries(new FormData(event.target)); button.disabled = true; try { const result = await apiFetch("/support", { method: "POST", body: JSON.stringify(data) }); if (result?.queued) throw new Error("Support tickets require a live connection."); toast(`Support ticket ${result.id} submitted`); event.target.reset() } catch (error) { toast(error.message) } finally { button.disabled = false } });
}
let assistantConversation = [], assistantPaused = false, assistantSessionId = "";
function openGlobalAssistant() { showModal(`<div class="modal wide global-assistant-modal"><div class="modal-head"><h2>MechPro Assistant</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body">${liveAssistant()}</div></div>`); bindLiveAssistant(); }
function toggleAssistantPause() { assistantPaused = !assistantPaused; if (assistantPaused) { window.speechSynthesis?.cancel(); toast("Assistant paused") } else toast("Assistant resumed"); document.querySelectorAll("[data-assistant-pause]").forEach(button => { button.title = assistantPaused ? "Resume assistant" : "Pause assistant"; button.innerHTML = icon(assistantPaused ? "play" : "pause", 15) }); document.querySelectorAll("#assistant-form textarea,#assistant-form button").forEach(control => { control.disabled = assistantPaused }) }
function liveAssistant() { const rows = assistantConversation.map(item => `<article class="assistant-message ${item.role}"><strong>${item.role === "user" ? "You" : "MechPro Assistant"}</strong><p>${escapeHtml(item.content)}</p></article>`).join(""); return `<section class="ai-panel live-assistant"><div class="statement-head"><div><div class="eyebrow">Live voice assistant</div><h2>Ask MechPro anything</h2><p>Talk or type questions about shop operations, vehicles, work orders, invoices, and repair decisions.</p></div>${icon("audio-lines", 20)}</div><div class="assistant-messages" id="assistant-messages">${rows || `<div class="assistant-empty">Your live assistant is ready. Ask a question to begin.</div>`}</div><form class="assistant-form" id="assistant-form"><textarea name="message" rows="2" maxlength="4000" placeholder="Ask about a customer, repair, invoice, or shop task..."></textarea><div class="assistant-actions"><button class="secondary" type="button" id="assistant-mic" title="Speak to MechPro">${icon("mic", 15)} Speak</button><button class="icon-button" type="button" id="assistant-stop" title="Stop speaking">${icon("volume-x", 15)}</button><button class="primary" type="submit">${icon("send", 14)} Ask assistant</button></div></form></section>` }
function aiWorkbench() { const tabs = [["workflow", "RO workflow"], ["diagnostics", "Diagnostics"], ["estimate", "Estimator"], ["saved-estimates", "Estimates"], ["guide", "Repair guide"], ["phone", "Phone intake"]], body = { workflow: aiWorkflowForm(), diagnostics: aiDiagnosticsForm(), estimate: aiEstimateForm(), "saved-estimates": savedEstimates(), guide: aiGuideForm(), phone: aiPhoneForm() }[aiTab]; return shell(`${heading("Service intelligence", "AI Workbench", "Diagnostics, estimates, repair planning, and live conversation in one workspace.", false)}${liveAssistant()}<div class="ai-notice">${icon("sparkles", 16)}<span>AI outputs are recommendations. Verify safety-critical work and customer-impacting changes before acting.</span></div><div class="accounting-tabs">${tabs.map(tab => `<button class="tab ${aiTab === tab[0] ? "active" : ""}" data-ai-tab="${tab[0]}">${tab[1]}</button>`).join("")}</div>${body}`) }
function aiFormShell(title, description, fields, action) { return `<section class="ai-panel"><div class="statement-head"><div><div class="eyebrow">AI assistant</div><h2>${title}</h2><p>${description}</p></div>${icon("sparkles", 19)}</div><form class="form-grid" id="ai-form">${fields}<div class="full"><button class="primary" type="submit">${icon("sparkles", 15)} ${action}</button></div></form></section>` }
function aiWorkflowForm() { const options = visibleOrders().map(order => `<option value="${order.id}">${order.id} · ${escapeHtml(order.customer)} · ${escapeHtml(order.vehicle)}</option>`).join(""); return `${aiFormShell("Repair-order workflow", "Generate causes, labor, parts, diagnostics, repair steps, and recommended services for an existing work order.", `<label class="full">Work order<select name="workOrderId">${options}</select></label>`, "Generate workflow")}${aiResult?.kind === "workflow" ? workflowResult(aiResult) : ""}` }
function aiDiagnosticsForm() { return `${aiFormShell("AI diagnostics", "Analyze symptoms and DTC codes into probable causes, tests, urgency, and labor time.", `<label>Vehicle<input name="vehicle" required placeholder="2018 Ford F-150 5.0L"/></label><label>DTC codes<input name="dtc" placeholder="P0300, P0171"/></label><label class="full">Symptoms / complaint<textarea name="symptoms" required placeholder="Rough idle, check engine light, hesitation on acceleration"></textarea></label>`, "Run diagnostics")}${aiResult?.kind === "diagnostics" ? diagnosticsResult(aiResult) : ""}` }
function aiEstimateForm() { return `${aiFormShell("AI estimator", "Build a practical service estimate with labor, parts, shop fees, and a tax-inclusive total.", `<label>Vehicle<input name="vehicle" required placeholder="2020 Honda CR-V EX"/></label><label>Requested service<input name="service" required placeholder="Front brake pads and rotors"/></label><label class="full">Additional notes<textarea name="notes" placeholder="Mileage, prior repairs, customer preferences"></textarea></label>`, "Generate estimate")}${aiResult?.kind === "estimate" ? estimateResult(aiResult) : ""}` }
function aiGuideForm() { return `${aiFormShell("AI repair guide", "A step-by-step procedure with diagrams and YouTube searches for this vehicle. Torque and fluid specs still come from current service information.", `<label>Vehicle<input name="vehicle" required placeholder="2017 GMC Sierra 1500"/></label><label>Repair / service<input name="repair" required placeholder="Replace water pump"/></label>`, "Generate repair guide")}${aiResult?.kind === "guide" ? guideResult(aiResult) : ""}` }
function aiPhoneForm() { return `${aiFormShell("AI phone intake", "Turn a customer call transcript into service recommendations, questions, and booking guidance.", `<label class="full">Call transcript<textarea name="transcript" required placeholder="Customer: My 2016 Camry has a check engine light and shakes at stop lights..."></textarea></label>`, "Analyze call")}${aiResult?.kind === "phone" ? phoneResult(aiResult) : ""}` }
function aiKeywords(text) { return String(text || "").toLowerCase() }
/* removed duplicate diagnoseLocal */

function estimateLocal(vehicle, service, notes = "") { const source = aiKeywords(`${service} ${notes}`), laborRate = Number(shopProfile().laborRate ?? 140), brake = /brake|rotor|pad/.test(source), oil = /oil|lube/.test(source), ac = /a\/c|air.?condition/.test(source), lines = brake ? [{ service: "Front brake pads and rotor service", hours: 2, parts: 285, notes: "Includes hardware inspection and brake bedding road test." }] : oil ? [{ service: "Synthetic oil and filter service", hours: .5, parts: 68, notes: "Includes multipoint inspection and fluid top-off." }] : ac ? [{ service: "A/C performance diagnosis", hours: 1.5, parts: 35, notes: "Pressure test and airflow inspection; repair parts quoted after diagnosis." }] : [{ service, hours: 1.5, parts: 110, notes: "Preliminary estimate; verify condition and part fitment before approval." }]; const detail = lines.map(line => ({ ...line, labor: line.hours * laborRate, total: line.hours * laborRate + line.parts })), totals = calculateShopEstimate(detail.flatMap((line, index) => [{ id: `labor-${index}`, type: "labor", description: line.service, notes: line.notes, hours: line.hours, laborRate }, ...(line.parts ? [{ id: `part-${index}`, type: "part", description: `${line.service} parts`, quantity: 1, unitPrice: line.parts }] : [])]), { taxRate: state.taxSettings.rate }); return { kind: "estimate", vehicle, lines: detail, fees: totals.fees, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, summary: `Preliminary estimate for ${vehicle}. Confirm parts availability and inspect the vehicle before final authorization.` } }
function guideLocal(vehicle, repair) { return buildRepairGuide(vehicle, repair) }
function phoneLocal(transcript) { const text = aiKeywords(transcript), vehicle = (transcript.match(/(?:19|20)\d{2}\s+[A-Za-z]+(?:\s+[A-Za-z0-9-]+){0,2}/) || ["Vehicle not confirmed"])[0], urgent = /brake|smoke|overheat|stall|no.?start/.test(text), service = /brake/.test(text) ? "Brake system inspection" : /a\/c|warm/.test(text) ? "A/C performance inspection" : /check engine|rough|shake/.test(text) ? "Check-engine diagnostic" : /oil/.test(text) ? "Oil service and inspection" : "Diagnostic inspection"; return { kind: "phone", vehicle, symptoms: transcript.slice(0, 260), service, urgency: urgent ? "Immediate" : "Soon", response: urgent ? "For safety, please avoid driving the vehicle until we can inspect it. We can prioritize an appointment today." : "We can schedule a diagnostic appointment so a technician can verify the concern and provide an accurate estimate.", questions: ["What warning lights are currently on?", "When did the concern begin and does it happen consistently?", "What is the current mileage and have there been recent repairs?"], booking: true } }
function detailedDiagnosticPlan(vehicle, symptoms, dtc) { const source = aiKeywords(`${symptoms} ${dtc}`), misfire = /misfire|p030|rough|shake/.test(source), brake = /brake|grind|vibrat|pulsat/.test(source), ac = /a\/c|air.?condition|warm air|not cool/.test(source); const common = { vehicle, symptoms, dtc, kind: "diagnostics", urgency: brake ? "High" : misfire ? "Prompt" : "Standard", hours: brake ? 1.5 : misfire ? 2 : 1.5, notes: "Advisory diagnostic plan only. Confirm procedures, specifications, torque values, refrigerant requirements, and safety precautions in current manufacturer service information for the exact VIN." }; const causes = misfire ? [{ cause: "Ignition coil, spark plug, or cylinder-specific ignition fault", likelihood: "High", explanation: "Rough running and P030x-style symptoms most often require ignition and cylinder-contribution checks first.", evidence: "A cylinder-specific misfire counter, worn/fouled plug, weak spark, or a misfire that follows a swapped coil increases confidence.", tools: ["OEM-capable scan tool", "Spark tester", "Digital multimeter", "Torque wrench"], tests: [{ name: "Confirm the affected cylinder and operating conditions", procedure: ["Connect a scan tool and perform a complete module scan before clearing codes.", "Record DTCs, freeze-frame data, fuel trims, coolant temperature, load, RPM, and misfire counters.", "Duplicate the complaint at the recorded speed, load, and temperature when safe."], good: "No abnormal cylinder count; trims and sensor data remain within manufacturer specification.", bad: "One cylinder accumulates counts or the fault repeats under the freeze-frame conditions." }, { name: "Inspect and isolate the ignition component", procedure: ["Disable the engine and inspect the plug, boot, coil, connector, and harness for damage, oil, coolant, carbon tracking, or corrosion.", "Measure plug condition and gap against current service information.", "When manufacturer guidance permits, swap the suspect coil with a known-good cylinder, clear counters, and repeat the operating condition."], good: "Components pass inspection and the misfire remains with the original cylinder.", bad: "The misfire follows the coil or a plug/boot defect is found." }], repairs: ["Replace only the failed plug, boot, coil, or damaged connector after confirmation; inspect companion components for the same wear pattern.", "If ignition passes, continue with injector balance, compression, relative compression, and cylinder leak-down testing before authorizing parts."] }, { cause: "Unmetered air, intake leak, or crankcase ventilation fault", likelihood: "Medium", explanation: "An intake leak can create a lean, unstable idle and secondary misfires, especially when fuel trims improve at higher RPM.", evidence: "High positive trim at idle that decreases near 2,500 RPM, smoke leakage, or a split PCV/intake hose increases confidence.", tools: ["Scan tool", "EVAP-approved smoke machine", "Inspection light", "Service-information vacuum diagram"], tests: [{ name: "Compare fuel trim by engine speed", procedure: ["Warm the engine to closed loop and switch off nonessential loads.", "Record short- and long-term fuel trim for each bank at idle.", "Hold approximately 2,500 RPM and record the same values; compare banks and RPM ranges."], good: "Combined trim remains within manufacturer limits and does not change materially with RPM.", bad: "Positive trim is excessive at idle and improves substantially at higher RPM." }, { name: "Smoke-test the intake system", procedure: ["Key off and follow manufacturer isolation points for the intake and EVAP system.", "Introduce regulated smoke at the specified low pressure.", "Inspect intake boots, manifold seals, brake-booster supply, PCV plumbing, vacuum hoses, and capped ports."], good: "The sealed intake holds smoke with no external leakage.", bad: "Smoke exits a hose, gasket, fitting, diaphragm, or intake component." }], repairs: ["Replace the confirmed leaking hose, seal, gasket, or valve and repair damaged wiring or fittings.", "Clear adaptations only when directed, then recheck trims at idle and 2,500 RPM."] }, { cause: "Fuel injector delivery or mechanical cylinder fault", likelihood: "Minor", explanation: "Injector flow, compression, valve sealing, or timing faults can mimic ignition failure but should be tested after faster primary checks.", evidence: "Misfire stays on the cylinder after ignition checks, injector balance differs, or compression/leak-down is outside specification.", tools: ["Scan tool with injector control", "Fuel-pressure gauge or approved analyzer", "Compression or relative-compression tester", "Cylinder leak-down tester"], tests: [{ name: "Compare injector operation and cylinder sealing", procedure: ["Verify injector command, connector integrity, and audible/measured operation.", "Perform the manufacturer injector balance or contribution test while monitoring safe fuel pressure.", "If delivery is acceptable, perform relative or manual compression and leak-down testing with the engine secured."], good: "Injector pressure drop and cylinder sealing are even and within specification.", bad: "The injector has an unequal pressure drop or cylinder compression/leakage is outside specification." }], repairs: ["Service or replace the confirmed injector only after electrical and pressure checks pass.", "For mechanical leakage, document readings and obtain authorization for the required engine repair or teardown diagnosis."] }] : brake ? [{ cause: "Brake pads below limit and/or rotor thickness variation or runout", likelihood: "High", explanation: "Grinding, vibration, and pulsation commonly result from worn friction material or rotor condition.", evidence: "Pad thickness below limit, metal contact, rotor below discard thickness, measurable runout, or thickness variation increases confidence.", tools: ["Vehicle lift or rated jack stands", "Brake micrometer", "Dial indicator with magnetic base", "Torque wrench"], tests: [{ name: "Measure friction and rotor condition", procedure: ["Confirm the complaint with a controlled road test only if braking remains safe.", "Lift and support the vehicle at approved points; remove wheels and inspect inner and outer pads.", "Measure pad thickness, rotor thickness at multiple indexed points, and lateral runout using the manufacturer procedure.", "Record every reading on the worksheet before disassembly."], good: "Pads, rotor thickness, variation, and runout are within current manufacturer limits.", bad: "Friction is at/below limit, metal contact exists, or any rotor reading exceeds specification." }], repairs: ["Replace pads and service or replace rotors as allowed by measured thickness and manufacturer policy.", "Clean mating surfaces, install approved hardware, torque fasteners and wheels to specification, then perform the required bedding procedure."] }, { cause: "Restricted caliper piston, slide, hose, or uneven application", likelihood: "Medium", explanation: "A restricted corner can overheat a rotor, accelerate one-sided wear, and create a pull or vibration.", evidence: "Side-to-side temperature difference, tapered/uneven pad wear, restricted slide travel, or residual pressure increases confidence.", tools: ["Infrared thermometer or thermal camera", "Brake hose clamps only if manufacturer-approved", "Caliper service tools", "Dial indicator"], tests: [{ name: "Compare wheel-end operation", procedure: ["After a controlled stop sequence, compare wheel-end temperatures without touching hot components.", "Inspect pad wear pattern, slide movement, piston boot, hose routing, and signs of heat damage.", "Follow service information to distinguish mechanical binding from trapped hydraulic pressure."], good: "Temperatures and wear are even; slides and piston move normally with no residual restriction.", bad: "One corner is materially hotter, wear is tapered, or pressure/movement remains restricted." }], repairs: ["Replace or overhaul the confirmed caliper/slide components and heat-damaged friction parts as specified.", "Replace a confirmed restricted hose; bleed with the specified fluid and sequence, then verify pedal reserve and leaks."] }, { cause: "Hub, wheel-bearing, suspension, or wheel-torque contribution", likelihood: "Minor", explanation: "Mounting-face debris, bearing play, suspension looseness, or uneven wheel torque can produce brake-related vibration even when friction parts appear acceptable.", evidence: "Runout changes after rotor indexing, hub runout is excessive, play/noise is present, or wheel torque is uneven.", tools: ["Dial indicator", "Torque wrench", "Hub cleaning tools", "Approved chassis inspection tools"], tests: [{ name: "Isolate hub and chassis contribution", procedure: ["Inspect wheel fastener condition and record removal torque concerns.", "Clean the hub/rotor mounting faces and measure hub runout using service information.", "Check bearing play/noise and related steering or suspension joints under the approved unloaded/loaded condition."], good: "Hub runout, bearing condition, chassis joints, and wheel torque meet specification.", bad: "Excessive hub runout/play, looseness, damage, or uneven fastening is confirmed." }], repairs: ["Correct mounting-face corrosion and index the rotor only when permitted.", "Replace the confirmed hub/bearing or worn chassis component, align if required, and torque wheels in sequence."] }] : ac ? [{ cause: "Insufficient condenser airflow or cooling-fan control fault", likelihood: "High", explanation: "Cooling that worsens at idle commonly points to inadequate airflow or fan operation.", evidence: "High-side pressure rises at idle and drops with added airflow, or commanded fan speed does not match actual operation.", tools: ["Bidirectional scan tool", "Refrigerant identifier and approved service station", "Digital multimeter", "Airflow/temperature probes"], tests: [{ name: "Verify airflow and fan command", procedure: ["Confirm refrigerant type and inspect the condenser/radiator stack for blockage or damage.", "Monitor ambient temperature, vent temperature, fan command, fan speed, and system pressures at idle.", "Add controlled external airflow and compare pressure and vent-temperature response."], good: "Fan operation follows command and pressures remain within the manufacturer chart for ambient conditions.", bad: "Fan operation is absent/slow or controlled airflow materially restores pressure and cooling." }], repairs: ["Repair the confirmed fan motor, relay/module, power, ground, control circuit, shutter, or airflow blockage.", "Retest at idle and road speed with pressures and center-vent temperature documented."] }, { cause: "Low refrigerant charge caused by a system leak", likelihood: "Medium", explanation: "Low charge reduces heat transfer; adding refrigerant without locating the leak is not a complete repair.", evidence: "Recovered weight is below specification or an electronic detector, dye inspection, vacuum decay, or nitrogen trace test confirms leakage.", tools: ["Certified recovery/recharge station", "Refrigerant identifier", "Electronic leak detector", "UV lamp or approved trace-gas equipment"], tests: [{ name: "Recover, measure, and leak-test", procedure: ["Identify refrigerant and recover it using approved equipment; record recovered weight.", "Compare recovered quantity with the underhood charge specification.", "Leak-test accessible fittings, hoses, condenser, compressor, service ports, evaporator drain, and other specified points.", "Do not mix refrigerants or vent refrigerant."], good: "Charge weight matches specification and no leak is detected by the approved method.", bad: "Charge is low and a leak is confirmed or the system fails the specified integrity test." }], repairs: ["Replace the confirmed leaking component and required seals, add the specified oil quantity, evacuate, verify vacuum hold, and recharge by exact weight.", "Replace service-port caps/seals as required and document leak-test results after repair."] }, { cause: "Air-mix door, temperature sensor, compressor-control, or internal system fault", likelihood: "Minor", explanation: "Control or internal faults remain possible after airflow and charge integrity are proven.", evidence: "Commands and actual door position disagree, sensor values are implausible, compressor command/output differs, or pressure performance remains abnormal at correct charge.", tools: ["OEM-capable scan tool", "Digital multimeter", "Temperature probes", "Manufacturer pressure/temperature charts"], tests: [{ name: "Validate HVAC commands and thermal performance", procedure: ["Scan HVAC and powertrain modules and record DTCs before clearing.", "Compare requested and actual door positions, evaporator/ambient/cabin sensors, compressor command, and pressure sensor data.", "Measure vent temperatures across modes and sides and compare pressure-temperature performance with service information."], good: "Commands, positions, sensors, and pressure-temperature relationships agree with specification.", bad: "A command/feedback mismatch, implausible sensor, control-circuit fault, or internal performance failure is repeatable." }], repairs: ["Calibrate or repair the confirmed actuator, sensor, wiring, control, compressor, or internal component according to service information.", "Do not authorize major HVAC component replacement until charge and airflow are verified."] }] : [{ cause: "Condition directly related to the customer complaint", likelihood: "High", explanation: "The first path should reproduce the concern and inspect the system named in the complaint before replacing parts.", evidence: "A repeatable symptom, visual defect, DTC, abnormal live-data value, or failed specification increases confidence.", tools: ["OEM-capable scan tool", "Digital multimeter", "Inspection light", "Manufacturer service information"], tests: [{ name: "Verify and baseline the complaint", procedure: ["Confirm vehicle identity, VIN, mileage, warning indicators, and the exact customer concern.", "Perform a complete scan and save codes, freeze-frame, readiness state, and relevant live data.", "Inspect the affected system for loose, damaged, leaking, overheated, contaminated, or previously repaired components.", "Reproduce the concern under safe, documented conditions and compare readings with current manufacturer specifications."], good: "The concern cannot be duplicated and all inspected values remain within specification.", bad: "The concern repeats and a related component, circuit, fluid, or measured value fails specification." }], repairs: ["Repair only the verified failed component or connection, following manufacturer service information.", "If the concern is not verified, document conditions and obtain more customer detail instead of guessing."] }, { cause: "Electrical supply, ground, connector, wiring, or sensor input fault", likelihood: "Medium", explanation: "Circuit faults can create intermittent or misleading symptoms and should be load-tested before module or component replacement.", evidence: "Voltage drop, unstable reference voltage, poor terminal tension, corrosion, or an implausible sensor signal increases confidence.", tools: ["Digital multimeter", "Low-current test light where approved", "Terminal test kit", "Wiring diagrams"], tests: [{ name: "Test the circuit under load", procedure: ["Use the wiring diagram to identify powers, grounds, reference, signal, splices, and shared loads.", "Inspect connector locks, terminal tension, fretting, moisture, rub-through, and prior repairs.", "Back-probe only with approved methods; measure voltage drop and signal response while the circuit is loaded and the complaint is present."], good: "Power, ground voltage drop, terminal integrity, and signal sweep meet specification.", bad: "Excessive drop, intermittent open/short, poor terminal fit, or implausible signal is captured." }], repairs: ["Repair terminals or wiring with approved materials and routing; correct power or ground faults before replacing controlled parts.", "Repeat the loaded test and secure the harness away from heat, motion, and abrasion."] }, { cause: "Secondary mechanical, contamination, calibration, or intermittent fault", likelihood: "Minor", explanation: "Less common faults should be pursued after the complaint and primary electrical/mechanical checks are documented.", evidence: "Primary tests pass but the symptom remains repeatable under a specific temperature, load, vibration, or time condition.", tools: ["Data-logging scan tool", "Specialty gauges as required", "Manufacturer service information", "Inspection tools"], tests: [{ name: "Capture the intermittent or secondary condition", procedure: ["Review service bulletins and known diagnostic procedures for the exact VIN and configuration.", "Data-log the relevant inputs and outputs during the conditions that trigger the concern.", "Test mechanical integrity, fluid condition, contamination, calibration, and learned values only as directed by service information."], good: "No abnormal event is captured and all secondary measurements meet specification.", bad: "A repeatable correlation or out-of-specification mechanical/calibration value is documented." }], repairs: ["Correct the documented mechanical, contamination, or calibration fault; do not replace parts solely on probability.", "If no fault is captured, return the vehicle with documented test conditions and a monitoring/recheck plan."] }]; return { ...common, causes, tests: causes.flatMap(item => item.tests.map(test => `${item.likelihood}: ${test.name} — ${test.procedure.join(" ")} PASS: ${test.good} FAIL: ${test.bad}`)) } }
function diagnoseLocal(vehicle, symptoms, dtc) { return detailedDiagnosticPlan(vehicle, symptoms, dtc) }
function detailedGuide(vehicle, repair) { return guideLocal(vehicle, repair) }
function workflowLocal(order) { const diagnostics = detailedDiagnosticPlan(order.vehicle, order.complaint, ""), estimate = estimateLocal(order.vehicle, order.complaint, order.notes), guide = detailedGuide(order.vehicle, estimate.lines[0].service); return { kind: "workflow", orderId: order.id, order: { customer: order.customer, vehicle: order.vehicle, vin: order.vin || "VIN pending", complaint: order.complaint, technician: order.tech || "Unassigned", bay: order.bay || "Unassigned", promise: order.promise || "Not scheduled", notes: order.notes || "" }, diagnostics, estimate, guide, recommended: [{ service: "Multipoint inspection", reason: "Confirm related wear items while the vehicle is in service.", cost: 0 }, { service: "Fluid and maintenance review", reason: "Check manufacturer interval items during the repair visit.", cost: 45 }] } }
function worksheetCheck(label, text) { return `<li><span class="print-check">&#9633;</span><div><b>${escapeHtml(label)}</b><p>${escapeHtml(text)}</p></div></li>` }
function workflowResult(result) { const order = result.order || {}, causes = result.diagnostics.causes.map(cause => `<article class="cause-card"><div class="cause-title"><h3>${escapeHtml(cause.cause)}</h3><span class="ai-tag ${cause.likelihood.toLowerCase()}">${cause.likelihood}</span></div><p>${escapeHtml(cause.explanation)}</p><small><b>Evidence that raises likelihood:</b> ${escapeHtml(cause.evidence)}</small><div class="cause-tools"><b>Tools:</b> ${cause.tools.map(escapeHtml).join(" · ")}</div>${cause.tests.map((test, index) => `<section class="test-procedure"><h4>Test ${index + 1}: ${escapeHtml(test.name)}</h4><ol>${test.procedure.map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol><div class="expected-readings"><p><b>Pass / normal:</b> ${escapeHtml(test.good)}</p><p><b>Fail / supports cause:</b> ${escapeHtml(test.bad)}</p></div><div class="worksheet-reading">Actual reading / observation: ______________________________________________</div></section>`).join("")}<h4>Repair options after confirmation</h4><ul class="repair-options">${cause.repairs.map(option => worksheetCheck("Option", option)).join("")}</ul></article>`).join(""), parts = result.estimate.lines.map(line => `<tr><td>${escapeHtml(line.service)}</td><td>${line.hours.toFixed(2)}</td><td>${money(line.parts)}</td><td><b>${money(line.total)}</b></td></tr>`).join(""), steps = result.guide.steps.map((step, index) => worksheetCheck(`Step ${index + 1}`, stepText(step))).join(""), safety = result.guide.safety.map(item => `<li>${escapeHtml(item)}</li>`).join(""), qc = result.guide.postRepair.map((item, index) => worksheetCheck(`QC ${index + 1}`, item)).join(""); return `<section class="ai-result"><div class="ai-result-head no-print"><div><div class="eyebrow">Generated technician workflow</div><h2>${escapeHtml(result.orderId)}</h2><p>Ranked causes, detailed tests, repair choices, and final quality control.</p></div><div class="ai-result-actions"><button class="secondary" type="button" onclick="window.print()">${icon("printer", 14)} Print technician packet</button><button class="primary" id="apply-ai-workflow">${icon("save", 14)} Apply to work order</button></div></div><div class="technician-worksheet" id="ai-technician-printable"><header class="worksheet-header"><div><div class="eyebrow">MechPro diagnostic & repair worksheet</div><h2>${escapeHtml(result.orderId)} · ${escapeHtml(order.vehicle || result.diagnostics.vehicle)}</h2></div><div class="worksheet-assignment"><span>Assigned technician</span><b>${escapeHtml(order.technician || "Unassigned")}</b></div></header><section class="worksheet-meta"><div><span>Customer</span><b>${escapeHtml(order.customer || "Not recorded")}</b></div><div><span>VIN</span><b class="mono">${escapeHtml(order.vin || "VIN pending")}</b></div><div><span>Bay / assignment</span><b>${escapeHtml(order.bay || "Unassigned")}</b></div><div><span>Promise</span><b>${escapeHtml(order.promise || "Not scheduled")}</b></div><div class="wide"><span>Customer complaint</span><b>${escapeHtml(order.complaint || result.diagnostics.symptoms)}</b></div></section><aside class="worksheet-warning"><b>Technician verification required.</b> Likelihood ranks prioritize testing; they are not a diagnosis or authorization to replace parts. Use current manufacturer information and record objective results.</aside><section class="worksheet-section"><div class="worksheet-section-head"><div><span>01</span><h2>Ranked causes & diagnostic procedures</h2></div><div class="likelihood-key"><b class="high">High</b><b class="medium">Medium</b><b class="minor">Minor</b></div></div><div class="cause-list">${causes}</div></section><section class="worksheet-section"><div class="worksheet-section-head"><div><span>02</span><h2>Preliminary estimate</h2></div></div><table><thead><tr><th>Service</th><th>Labor hours</th><th>Parts</th><th>Line total</th></tr></thead><tbody>${parts}</tbody></table><div class="ai-total"><span>Preliminary estimated total</span><b>${money(result.estimate.total)}</b></div><p class="worksheet-fineprint">Inspect and obtain customer authorization before additional work. Part fitment, labor operations, taxes, fluids, programming, sublet work, and hidden damage may change the final estimate.</p></section><section class="worksheet-section"><div class="worksheet-section-head"><div><span>03</span><h2>Detailed repair checklist</h2></div></div><h3>Safety and stop-work conditions</h3><ul class="safety-list">${safety}</ul><ul class="worksheet-checklist">${steps}</ul></section><section class="worksheet-section"><div class="worksheet-section-head"><div><span>04</span><h2>Post-repair verification</h2></div></div><ul class="worksheet-checklist two-column">${qc}</ul><div class="worksheet-notes"><b>Technician findings, actual readings, torque references, parts used, and additional recommendations</b><div></div><div></div><div></div><div></div></div><footer class="worksheet-signoff"><label>Technician signature <span></span></label><label>Date / time <span></span></label><label>QC signature <span></span></label></footer></section></div></section>` }
function diagnosticsResult(result) { return `<section class="ai-result"><div class="ai-result-head"><div><div class="eyebrow">Diagnostic report</div><h2>${escapeHtml(result.vehicle)}</h2><p>${escapeHtml(result.urgency)} priority · ${result.hours.toFixed(2)} labor hours estimated</p></div></div><div class="ai-result-grid"><section><h3>Probable causes</h3><ul class="ai-causes">${result.causes.map(c => `<li><b>${escapeHtml(c.cause)}</b><span class="ai-tag ${escapeAttr(c.likelihood.toLowerCase())}">${escapeHtml(c.likelihood)}</span><small>${escapeHtml(c.explanation)}</small></li>`).join("")}</ul></section><section><h3>Recommended tests</h3><ul class="ai-checklist">${result.tests.map(test => `<li>${icon("check-circle-2", 13)}${escapeHtml(test)}</li>`).join("")}</ul><p class="ai-disclaimer">${escapeHtml(result.notes)}</p></section></div></section>` }
function estimateResult(result) { return `<section class="ai-result"><div class="ai-result-head"><div><div class="eyebrow">Preliminary estimate</div><h2>${escapeHtml(result.vehicle)}</h2><p>${escapeHtml(result.summary)}</p></div><button class="primary" id="save-ai-estimate">${icon("save", 14)} Create estimate</button></div><table><thead><tr><th>Service</th><th>Labor</th><th>Parts</th><th>Total</th></tr></thead><tbody>${result.lines.map(line => `<tr><td>${escapeHtml(line.service)}<small>${escapeHtml(line.notes)}</small></td><td>${line.hours.toFixed(2)}h · ${money(line.labor)}</td><td>${money(line.parts)}</td><td><b>${money(line.total)}</b></td></tr>`).join("")}</tbody></table><div class="ai-estimate-totals"><span>Subtotal ${money(result.subtotal)}</span><span>Tax ${money(result.tax)}</span><b>Total ${money(result.total)}</b></div></section>` }
function savedEstimates() { const rows = [...state.estimates].reverse().map(estimate => `<tr><td class="mono"><b>${estimate.number}</b></td><td>${escapeHtml(estimate.customer)}<small>${escapeHtml(estimate.vehicle)}</small></td><td>${estimate.status === "approved" ? `<span class="badge paid">Approved</span>` : `<span class="badge estimate">Pending</span>`}</td><td><b>${money(estimate.total)}</b></td><td><div class="estimate-actions"><button class="mini-action" data-send-estimate="${estimate.id}" data-channel="email">${icon("mail", 13)} Email</button><button class="mini-action" data-send-estimate="${estimate.id}" data-channel="sms">${icon("message-square", 13)} Text</button>${estimate.status !== "approved" ? `<button class="mini-action" data-sign-estimate="${estimate.id}">${icon("signature", 13)} Sign</button>` : ""}</div></td></tr>`).join(""); return `<section class="ai-result"><div class="ai-result-head"><div><div class="eyebrow">Customer estimates</div><h2>Estimate register</h2><p>Send itemized estimates through the device email or messaging apps and record authorization.</p></div></div><div class="data-panel"><table><thead><tr><th>Estimate</th><th>Customer & vehicle</th><th>Status</th><th>Total</th><th>Delivery & approval</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No saved estimates. Generate one from the Estimator tab.</td></tr>`}</tbody></table></div></section>` }
function makeEstimate() { if (aiResult?.kind !== "estimate") return; const number = `EST-${String(state.estimates.length + 1001).padStart(4, "0")}`, matching = state.orders.find(order => order.vehicle === aiResult.vehicle) || state.orders.find(order => aiResult.vehicle.includes(order.vehicle.split(" ").slice(0, 3).join(" "))), customer = matching?.customer || "Walk-in customer", email = state.customers.find(item => item.name === customer)?.email || "", phone = matching?.phone || state.customers.find(item => item.name === customer)?.phone || "", record = { id: `estimate-${Date.now()}`, number, customer, email, phone, vehicle: aiResult.vehicle, workOrderId: matching?.id || null, createdAt: now(), status: "pending", lines: aiResult.lines, fees: aiResult.fees, subtotal: aiResult.subtotal, tax: aiResult.tax, total: aiResult.total, summary: aiResult.summary, signature: null, authorizationName: "" }; state.estimates.push(record); pushEstimateToApi(record); save(); toast(`${number} created for ${customer}`); aiTab = "saved-estimates"; aiResult = null; render() }
function estimateMessage(estimate) { const lines = estimate.lines.map(line => `${line.service}: ${money(line.total)}`).join("; "); return `Your Car Guy estimate ${estimate.number} for ${estimate.vehicle}. ${lines}. Total ${money(estimate.total)}. Please contact us to approve or sign in person.` }
async function deliverShopMessage({ channel, to, subject, body, metadata }) { const config = state.messagingSettings; if (channel === "sms" && !integrationStatus) await loadIntegrationStatus(); if (channel === "sms" && integrationStatus?.sms?.enabled) { try { await apiFetch("/messaging/send", { method: "POST", body: JSON.stringify({ to, body, customerId: metadata?.customerId, workOrderId: metadata?.workOrderId, messageType: metadata?.type || "message" }) }); return { mode: "mechpro_sms" } } catch (error) { if (error.retryable === false) throw error; toast(error.message || "Built-in SMS was unavailable. Opening the device app instead.") } } if (config.enabled && config.endpoint) { try { const response = await fetch(config.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, to, subject, body, metadata, from: channel === "email" ? config.senderEmail : config.senderPhone, shopName: config.shopName }) }); if (!response.ok) throw new Error("Delivery endpoint rejected the message"); return { mode: "service" } } catch (error) { toast("Shop delivery service was unavailable. Opening the device app instead.") } } if (channel === "email") window.location.href = `mailto:${encodeURIComponent(to || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; else window.location.href = `sms:${String(to || "").replace(/[^0-9+]/g, "")}?body=${encodeURIComponent(body)}`; return { mode: "device" } }
async function sendEstimate(id, channel) { const estimate = state.estimates.find(item => item.id === id); if (!estimate) return; const subject = `Estimate ${estimate.number} — ${state.messagingSettings.shopName || "Your Car Guy"}`, body = estimateMessage(estimate), result = await deliverShopMessage({ channel, to: channel === "email" ? estimate.email : estimate.phone, subject, body, metadata: { type: "estimate", estimateId: estimate.id, estimateNumber: estimate.number, workOrderId: estimate.workOrderId } }); estimate.lastSentAt = now(); estimate.lastSentChannel = channel; estimate.deliveryMode = result.mode; updateEstimateInApi(estimate); save(); toast(result.mode === "service" ? `${estimate.number} sent through the shop messaging service` : `${estimate.number} opened in your device ${channel === "email" ? "email" : "messaging"} app`) }
function openSignature(id) { const estimate = state.estimates.find(item => item.id === id); if (!estimate) return; showModal(`<form class="modal" id="signature-form"><div class="modal-head"><h2>Customer authorization</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${estimate.number} · ${escapeHtml(estimate.vehicle)}</span><strong>${money(estimate.total)}</strong></div><label>Authorized customer name *<input name="authorizationName" required value="${escapeAttr(estimate.customer === "Walk-in customer" ? "" : estimate.customer)}"/></label><label class="signature-label">Draw signature *<canvas id="signature-pad" width="560" height="180"></canvas></label><p class="ai-disclaimer">By signing, the customer authorizes the listed estimate. This record is stored on this device.</p></div><div class="modal-actions"><button type="button" class="secondary" id="clear-signature">Clear</button><button type="submit" class="primary">${icon("check", 14)} Approve estimate</button></div></form>`); initSignaturePad(estimate) }
function canvasToBlob(canvas) { return new Promise(resolve => canvas.toBlob(resolve, "image/png")) }
async function uploadFileToR2(blob, kind, contentType) { return uploadFileToStorage(blob, kind, contentType, { apiFetch }) }
function initSignaturePad(estimate) { const canvas = document.querySelector("#signature-pad"), context = canvas.getContext("2d"), position = event => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) } }; let drawing = false, drawn = false; context.lineWidth = 2.4; context.lineCap = "round"; context.strokeStyle = "#14201c"; canvas.addEventListener("pointerdown", event => { drawing = true; drawn = true; canvas.setPointerCapture(event.pointerId); const point = position(event); context.beginPath(); context.moveTo(point.x, point.y) }); canvas.addEventListener("pointermove", event => { if (!drawing) return; const point = position(event); context.lineTo(point.x, point.y); context.stroke() }); canvas.addEventListener("pointerup", () => { drawing = false }); document.querySelector("#clear-signature").onclick = () => { context.clearRect(0, 0, canvas.width, canvas.height); drawn = false }; document.querySelector("#signature-form").onsubmit = async event => { event.preventDefault(); const name = new FormData(event.target).get("authorizationName").trim(), submitButton = event.target.querySelector("button[type=submit]"); if (!drawn) { toast("Capture the customer signature before approving"); return } submitButton.disabled = true; try { const blob = await canvasToBlob(canvas), key = await uploadFileToR2(blob, "signature", "image/png"); estimate.status = "approved"; estimate.authorizationName = name; estimate.signatureKey = key; estimate.signature = null; estimate.signedAt = now(); if (estimate.workOrderId) { const order = state.orders.find(item => item.id === estimate.workOrderId); if (order && order.status === "estimate") { order.status = "approved"; updateOrderInApi(order) } } updateEstimateInApi(estimate); save(); closeModal(); toast(`${estimate.number} approved and signed`); render() } catch (error) { toast(uploadFailureMessage(error, "Could not upload the signature. Please try again.")); submitButton.disabled = false } } }
function guideResult(result) { const videos = (result.videos || []).map(video => { const url = safeVideoUrl(video.url); return url ? `<a class="guide-video" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${icon("play", 14)}<span><b>${escapeHtml(video.label)}</b><small>Opens a YouTube search for this vehicle</small></span></a>` : "" }).join(""); const steps = (result.steps || []).map((step, index) => { const item = typeof step === "string" ? { title: step, detail: "", watch: "" } : step; const picture = item.diagram ? `<div class="guide-diagram">${repairDiagram(item.diagram)}</div>` : ""; return `<li class="guide-step"><b>${index + 1}</b><div><strong>${escapeHtml(item.title || "")}</strong><p>${escapeHtml(item.detail || "")}</p>${item.watch ? `<p class="guide-watch"><em>Watch for.</em> ${escapeHtml(item.watch)}</p>` : ""}${picture}</div></li>` }).join(""); return `<section class="ai-result guide-result"><div class="ai-result-head"><div><div class="eyebrow">Repair guide</div><h2>${escapeHtml(result.title)}</h2><p>${escapeHtml(result.difficulty || "")} · ${escapeHtml(result.time || "")}</p></div></div><p class="guide-note">${escapeHtml(result.note || "")}</p><div class="guide-layout"><div class="guide-diagram">${repairDiagram(result.diagram)}</div><section><h3>Tools</h3><ul class="ai-checklist">${(result.tools || []).map(tool => `<li>${icon("wrench", 13)}${escapeHtml(tool)}</li>`).join("")}</ul><h3>Parts</h3><ul class="ai-checklist">${(result.parts || []).map(part => `<li>${icon("package", 13)}${escapeHtml(part)}</li>`).join("")}</ul></section></div><h3>Repair steps</h3><ol class="guide-steps">${steps}</ol><h3>Reference videos</h3><div class="guide-videos">${videos}</div><h3>Safety</h3><ul class="ai-checklist">${(result.safety || []).map(note => `<li>${icon("triangle-alert", 13)}${escapeHtml(note)}</li>`).join("")}</ul></section>` }
function phoneResult(result) { return `<section class="ai-result"><div class="ai-result-head"><div><div class="eyebrow">Call intake summary</div><h2>${escapeHtml(result.vehicle)}</h2><p>${escapeHtml(result.urgency)} · ${escapeHtml(result.service)}</p></div></div><div class="ai-result-grid"><section><h3>Customer concern</h3><p class="ai-copy">${escapeHtml(result.symptoms)}</p><h3>Suggested response</h3><p class="ai-copy">${escapeHtml(result.response)}</p></section><section><h3>Follow-up questions</h3><ul class="ai-checklist">${result.questions.map(question => `<li>${icon("circle-help", 13)}${escapeHtml(question)}</li>`).join("")}</ul><div class="ai-booking">${icon("calendar-check", 16)} Booking recommended</div></section></div></section>` }
const STORE = storageKeys.dispatch;
const seed = {
  route: "home",
  orders: [
    { id: "RO-1048", customer: "Demo Customer A", phone: "555-0142", vehicle: "2018 Ford F-150 XLT", vin: "DEMOVIN000000001", complaint: "Brake pedal vibration and grinding under moderate braking.", status: "in_progress", priority: "high", tech: "Tech A", bay: "Bay 2", mobile: false, promise: "Today, 2:30 PM", total: 684.22, scheduled: "9:00 AM", notes: "Front pads at 2mm. Replace pads and rotors; inspect rear brakes.", labor: 225, laborHours: 1.5, parts: 407.49, tax: 51.73 },
    { id: "RO-1049", customer: "Demo Fleet Co", phone: "555-0177", vehicle: "2021 Chevrolet Express 2500", vin: "DEMOVIN000000002", complaint: "Fleet van will not crank. Driver reports intermittent clicking.", status: "approved", priority: "normal", tech: "Tech A", bay: "Mobile", mobile: true, promise: "Today, 4:00 PM", total: 319.85, scheduled: "10:30 AM", notes: "Mobile dispatch. Battery and starter diagnosis approved.", labor: 165, laborHours: 1, parts: 130.68, tax: 24.17 },
    { id: "RO-1050", customer: "Demo Customer B", phone: "555-0109", vehicle: "2016 Toyota Camry SE", vin: "DEMOVIN000000003", complaint: "Check engine light, rough idle, and reduced fuel economy.", status: "estimate", priority: "normal", tech: "Unassigned", bay: "Unassigned", mobile: false, promise: "Tomorrow, 11:00 AM", total: 189.95, scheduled: "1:00 PM", notes: "Initial scan shows P0302. Estimate includes diagnostic time.", labor: 165, laborHours: 1, parts: 10.61, tax: 14.34 },
    { id: "RO-1051", customer: "Demo Customer C", phone: "555-0191", vehicle: "2020 Honda CR-V EX", vin: "DEMOVIN000000004", complaint: "A/C blows warm at idle and cools while driving.", status: "waiting_parts", priority: "normal", tech: "Tech A", bay: "Bay 1", mobile: false, promise: "Today, 5:30 PM", total: 742.16, scheduled: "8:00 AM", notes: "Condenser fan motor failed. Part arriving later today.", labor: 247.5, laborHours: 1.5, parts: 438.73, tax: 55.93 },
    { id: "RO-1052", customer: "Demo Customer D", phone: "555-0126", vehicle: "2019 Ram 1500 Laramie", vin: "DEMOVIN000000005", complaint: "Oil service, tire rotation, and 60k mile inspection.", status: "approved", priority: "low", tech: "Tech A", bay: "Bay 3", mobile: false, promise: "Tomorrow, 9:30 AM", total: 244.6, scheduled: "3:00 PM", notes: "Synthetic oil service and multipoint inspection approved.", labor: 110, laborHours: 0.75, parts: 116.16, tax: 18.44 },
    { id: "RO-1046", customer: "Demo Customer E", phone: "555-0133", vehicle: "2017 GMC Sierra 1500", vin: "DEMOVIN000000006", complaint: "Replace water pump and thermostat.", status: "completed", priority: "normal", tech: "Tech A", bay: "Bay 4", mobile: false, promise: "Completed", total: 1128.43, scheduled: "Yesterday", notes: "Cooling system pressure tested. No leaks found.", labor: 495, laborHours: 3, parts: 548.2, tax: 85.23 },
    { id: "RO-1044", customer: "Demo Retail Co", phone: "555-0168", vehicle: "2022 Ford Transit Connect", vin: "DEMOVIN000000007", complaint: "Scheduled fleet maintenance.", status: "invoiced", priority: "low", tech: "Tech A", bay: "Mobile", mobile: true, promise: "Completed", total: 389.24, scheduled: "Monday", notes: "Invoice sent to fleet manager. Net 15 terms.", labor: 165, laborHours: 1, parts: 194.79, tax: 29.45 }
  ],
  vehicles: [],
  inventory: [],
  vendors: [],
  services: [],
  inspectionTemplates: [],
  inspections: [],
  reminders: [],
  appointments: [
    { id: "apt-1048", sampleData: true, customer: "Demo Customer A", vehicle: "2018 Ford F-150 XLT", date: "2026-09-09", time: "09:00", service: "Brake inspection follow-up", tech: "Tech A", bay: "Bay 2", status: "confirmed" },
    { id: "apt-1049", sampleData: true, customer: "Demo Fleet Co", vehicle: "2021 Chevrolet Express 2500", date: "2026-09-09", time: "10:30", service: "Mobile no-crank diagnosis", tech: "Tech A", bay: "Mobile", status: "scheduled" },
    { id: "apt-1052", sampleData: true, customer: "Demo Customer D", vehicle: "2019 Ram 1500 Laramie", date: "2026-09-10", time: "09:30", service: "60k mile service", tech: "Tech A", bay: "Bay 3", status: "scheduled" }
  ],
  purchases: [],
  diagnosticSessions: [],
  keyJobs: [],
  shopSettingsRecords: [],
  customers: [
    { name: "Demo Customer A", phone: "555-0142", email: "customer-a@example.com", vehicles: 2, visits: 6, spend: 2834.17 },
    { name: "Demo Fleet Co", phone: "555-0177", email: "fleet@example.com", vehicles: 8, visits: 22, spend: 14982.4 },
    { name: "Demo Customer B", phone: "555-0109", email: "customer-b@example.com", vehicles: 1, visits: 3, spend: 929.8 },
    { name: "Demo Customer C", phone: "555-0191", email: "customer-c@example.com", vehicles: 2, visits: 4, spend: 1740.66 },
    { name: "Demo Customer D", phone: "555-0126", email: "customer-d@example.com", vehicles: 3, visits: 9, spend: 4822.13 },
    { name: "Demo Retail Co", phone: "555-0168", email: "retail@example.com", vehicles: 4, visits: 15, spend: 8389.42 }
  ],
  users: [
    { id: "user-admin", name: "Demo Admin", email: "admin@example.com", role: "admin", title: "Service Manager", techName: "", active: true, employeeId: "EMP-001", phone: "555-0100", address: "", startDate: "2022-03-14", employmentType: "Salary", payRate: 0, payFrequency: "Biweekly", department: "Management", emergencyContact: "", taxStatus: "W-2" },
    { id: "user-tech", name: "Demo Technician", email: "tech@example.com", role: "technician", title: "Lead Technician", techName: "Tech A", active: true, employeeId: "EMP-002", phone: "555-0102", address: "", startDate: "2023-01-09", employmentType: "Hourly", payRate: 0, payFrequency: "Weekly", department: "Service", emergencyContact: "", taxStatus: "W-2" },
    { id: "user-office", name: "Demo Office", email: "office@example.com", role: "office", title: "Office Coordinator", techName: "", active: true, employeeId: "EMP-003", phone: "555-0104", address: "", startDate: "2024-02-05", employmentType: "Hourly", payRate: 0, payFrequency: "Weekly", department: "Administration", emergencyContact: "", taxStatus: "W-2" },
    { id: "user-writer", name: "Demo Writer", email: "writer@example.com", role: "service_writer", title: "Service Writer", techName: "", active: true, employeeId: "EMP-004", phone: "555-0106", address: "", startDate: "2023-08-21", employmentType: "Hourly", payRate: 0, payFrequency: "Weekly", department: "Front Counter", emergencyContact: "", taxStatus: "W-2" }
  ],
  currentUserId: "user-admin",
  conversations: [],
  chatMessages: [],
  chatLastRead: {},
  payrollEntries: [],
  shiftEntries: [],
  jobClockEntries: [],
  estimates: [],
  // Default messaging settings – replace with your real service endpoint to enable email/SMS delivery.
  messagingSettings: { enabled: true, endpoint: "https://httpbin.org/post", senderEmail: "no-reply@example.com", senderPhone: "", shopName: "Your Car Guy" },
  billingSettings: { enabled: false, provider: "stripe", checkoutEndpoint: "", onboardingUrl: "", accountLabel: "", shopName: "Your Car Guy", shopId: "", webhookUrl: "" },
  payments: [],
  taxSettings: { state: "TX", taxId: "", rate: 8.25, filingFrequency: "Monthly", ein: "", texasTaxpayerNumber: "", webfileNumber: "", jurisdictions: null },
  chartOfAccounts: [
    { code: "1000", name: "Operating Checking", type: "Asset" }, { code: "1010", name: "Cash on Hand", type: "Asset" }, { code: "1020", name: "Card Processor Clearing", type: "Asset" }, { code: "1100", name: "Accounts Receivable", type: "Asset" }, { code: "1200", name: "Parts Inventory", type: "Asset" }, { code: "2000", name: "Accounts Payable", type: "Liability" }, { code: "2100", name: "Sales Tax Payable", type: "Liability" }, { code: "2200", name: "Federal Income Tax Withheld", type: "Liability" }, { code: "2210", name: "FICA Payable (SS)", type: "Liability" }, { code: "2220", name: "Medicare Payable", type: "Liability" }, { code: "4000", name: "Service Revenue", type: "Income" }, { code: "5000", name: "Cost of Parts", type: "Expense" }, { code: "6100", name: "Shop Supplies", type: "Expense" }, { code: "6200", name: "Utilities", type: "Expense" }, { code: "6300", name: "Tools & Equipment", type: "Expense" }
  ],
  journalEntries: [],
  expenses: [
    { date: "Aug 14, 2026", vendor: "Demo Parts Supplier", category: "Parts & supplies", memo: "Brake rotor inventory replenishment", amount: 412.87 },
    { date: "Aug 12, 2026", vendor: "Demo Utilities", category: "Utilities", memo: "Shop electric service", amount: 286.14 }
  ],
  invoices: [
    { number: "INV-2041", ro: "RO-1046", customer: "Demo Customer E", date: "Aug 13, 2026", due: "Paid Aug 13", amount: 1128.43, subtotal: 1042.43, taxRate: 8.25, tax: 86, status: "paid" },
    { number: "INV-2040", ro: "RO-1044", customer: "Demo Retail Co", date: "Aug 11, 2026", due: "Aug 26, 2026", amount: 389.24, subtotal: 359.58, taxRate: 8.25, tax: 29.66, status: "sent" },
    { number: "INV-2036", ro: "RO-1039", customer: "Demo Customer F", date: "Jul 28, 2026", due: "Aug 12, 2026", amount: 846.9, subtotal: 782.36, taxRate: 8.25, tax: 64.54, status: "overdue" },
    { number: "INV-2032", ro: "RO-1034", customer: "Demo Realty Co", date: "Jul 21, 2026", due: "Aug 5, 2026", amount: 1276.18, subtotal: 1178.92, taxRate: 8.25, tax: 97.26, status: "overdue" }
  ]
};
const LOCAL_PREFERENCES_VERSION = 2;
let stripePaymentStatus = null;
let state = load(), filter = "active", query = "", importPreview = null, accountingTab = "overview", payrollPeriodKey = null, taxPackageRange = null, filingCenterOpen = false, shopOpsTab = "vehicles", reminderFilter = "all", aiTab = "workflow", aiResult = null, taxReportResult = null, chatConversationId = null, chatRefreshTimer = null, platformAccounts = null, platformAccountsLoading = false, elmPort = null, pendingAuthProfile = null;
const usStates = [{ code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" }, { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "DC", name: "District of Columbia" }, { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" }, { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" }, { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" }, { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" }, { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" }, { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" }, { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" }, { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }];
function sanitizeUsers(users) { return users.map(({ password, ...user }) => user) }
function load() { try { const value = JSON.parse(localStorage.getItem(STORE)); if (value?.version !== LOCAL_PREFERENCES_VERSION) { localStorage.removeItem(STORE); return structuredClone(seed) } const route = typeof value.route === "string" && /^[a-z-]+$/.test(value.route) ? value.route : seed.route; return { ...structuredClone(seed), route } } catch { localStorage.removeItem(STORE); return structuredClone(seed) } }
let saveTimer = 0, pendingStateSnapshot = null, persistedStateSnapshot = localStorage.getItem(STORE) || null;
function invalidateDerivedCaches() { chatDerivedCache = null; financeDerivedCache = null; relationshipDerivedCache = null }
function flushStateSave() { if (pendingStateSnapshot == null || pendingStateSnapshot === persistedStateSnapshot) return; localStorage.setItem(STORE, pendingStateSnapshot); persistedStateSnapshot = pendingStateSnapshot; pendingStateSnapshot = null }
function save() { state.users = sanitizeUsers(state.users); invalidateDerivedCaches(); const snapshot = JSON.stringify({ version: LOCAL_PREFERENCES_VERSION, route: state.route }); if (snapshot === pendingStateSnapshot || snapshot === persistedStateSnapshot) return; pendingStateSnapshot = snapshot; clearTimeout(saveTimer); saveTimer = setTimeout(flushStateSave, 120) }
window.addEventListener("pagehide", flushStateSave);
window.addEventListener("beforeunload", flushStateSave);
const cloudflareConfig = window.__MECHPRO_CONFIG__.cloudflare;
/* platform: isDesktopApp, DESKTOP_ENTITLEMENT_INTERVAL from modules/platform/detect.js */
let desktopEntitlementVerified = !isDesktopApp, desktopLoginMessage = "", offlineAccountReady = false, offlineAccountEmail = "";
function sessionClaimRole(claims) { return claims?.role || claims?.["custom:role"] || "technician" }
function sessionClaimShopId(claims) { return claims?.shopId || claims?.["custom:shopId"] || "" }
function localAccessSession() { const expires = Math.floor(Date.now() / 1000) + 86400; return { claims: { sub: "local-development", email: "admin@example.com", name: "Demo Admin", "custom:shopId": "local-shop", "custom:role": "admin", exp: expires }, expiresAt: expires * 1000 } }
function isLocalShell() {
  // Desktop production loads the hosted HTTPS app (same-origin /api). Only file://
  // or loopback counts as a local shell; never treat the online desktop window as offline-dev.
  return location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname)
}
async function cloudflareAccessSignIn() { if (isOfflineDesktop()) throw new Error("Sign in with the password saved on this computer."); if (isLocalShell()) return localAccessSession(); const response = await fetch(`${cloudflareConfig.apiUrl}/auth/session`, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } }); const session = await response.json().catch(() => ({})); if (!response.ok || !session.claims) throw new Error(session.message || "Cloudflare Access authentication failed"); sessionStorage.setItem(storageKeys.session, JSON.stringify(session)); return session }
async function requestMagicLinkSignIn(email) { let response; try { response = await fetch(`${cloudflareConfig.apiUrl}/auth/magic-link`, { method: "POST", credentials: "include", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ email, returnTo: "/", return_to: "/" }) }) } catch (error) { if (error instanceof TypeError) throw new Error("Could not reach MechPro sign-in. Check your internet connection and try again."); throw error } const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.message || "Could not start sign-in"); const loginUrl = payload.loginUrl || payload.login_url || payload.url; if (loginUrl) { location.assign(loginUrl); return { redirecting: true, email } }; return { sent: true, email, message: payload.message || "Check your email for a sign-in link. It expires in 15 minutes. Look in spam if it is not in your inbox." } }
const cloudflareSignIn = cloudflareAccessSignIn;
function authSession() { try { const raw = sessionStorage.getItem(storageKeys.session) || localStorage.getItem(storageKeys.session); const session = JSON.parse(raw || "null"); if (!session?.claims) return null; const expiresAt = Number(session.expiresAt || session.claims.exp * 1000 || 0); if (!expiresAt || expiresAt <= Date.now()) { clearAuthSession(); return null } if (localStorage.getItem(storageKeys.session)) { sessionStorage.setItem(storageKeys.session, JSON.stringify(session)); localStorage.removeItem(storageKeys.session) } return session } catch { clearAuthSession(); return null } }
function clearAuthSession() { sessionStorage.removeItem(storageKeys.session); localStorage.removeItem(storageKeys.session) }
// Best-effort server logout: revokes the D1 session and clears the HttpOnly
// cookie (same-origin in the desktop shell). Skipped entirely for the offline
// desktop edition, which keeps accounts in the local vault instead of D1.
function signOutApiRequest() { if (isOfflineDesktop()) return; fetch(`${cloudflareConfig.apiUrl}/auth/logout`, { method: "POST", credentials: "include", cache: "no-store", headers: { Accept: "application/json" } }).catch(() => {}) }
async function signOutEverywhere() { state.currentUserId = null; desktopEntitlementVerified = !isDesktopApp; signOutApiRequest(); clearAuthSession(); closeModal(); save(); render(); toast("Signed out of MechPro") }
const MUTATION_QUEUE_STORE = "mechpro-mutation-queue-v1";
const mutationQueueStore = createMutationQueueStore({ storage: localStorage, storeKey: MUTATION_QUEUE_STORE });
let flushingMutationQueue = false;
function readMutationQueue() { return mutationQueueStore.read().filter(item => item?.method === "DELETE" || item?.body) }
function writeMutationQueue(queue) { mutationQueueStore.write(queue) }
function mutationId() { return globalThis.crypto?.randomUUID?.() || `mutation-${Date.now()}-${Math.random().toString(16).slice(2)}` }
function prepareMutation(path, options) { return prepareEntityMutation(path, options, mutationId) }
function queueEntityMutation(mutation, conflict = false) { const queue = readMutationQueue(), existingIndex = queue.findIndex(item => item.key === mutation.key); if (mutation.options.method === "DELETE" && existingIndex >= 0 && queue[existingIndex].method === "POST") { queue.splice(existingIndex, 1); writeMutationQueue(queue); return } const item = { id: mutationId(), key: mutation.key, path: mutation.path, method: mutation.options.method, body: mutation.options.body, expectedUpdatedAt: mutation.expectedUpdatedAt || null, queuedAt: new Date().toISOString(), conflict }; if (existingIndex >= 0) queue.splice(existingIndex, 1, item); else queue.push(item); writeMutationQueue(queue) }
async function authorizedApiRequest(path, options = {}) { const session = authSession(); if (!session) throw new Error("Not signed in"); const localHeaders = isLocalShell() ? { "X-MechPro-Dev-Email": session.claims.email || "admin@example.com", "X-MechPro-Dev-Name": session.claims.name || "Local Developer", "X-MechPro-Dev-Sub": session.claims.sub || "local-development" } : {}; return fetch(`${cloudflareConfig.apiUrl}${path}`, { ...options, credentials: "include", headers: { "Content-Type": "application/json", ...localHeaders, ...options.headers || {} } }) }
async function verifyDesktopEntitlement() { if (!isDesktopApp || isOfflineDesktop() || (isLocalShell() && cloudflareConfig.apiUrl.startsWith("/"))) { desktopEntitlementVerified = true; return true } if (!navigator.onLine) throw new Error("MechPro Desktop requires an internet connection to verify your subscription."); let response; try { response = await authorizedApiRequest("/subscription/entitlement", { cache: "no-store" }) } catch { throw new Error("MechPro could not reach the subscription service. Check your internet connection and try again.") } const body = await response.json().catch(() => ({})); if (!response.ok || body.active !== true) throw new Error(body.status === "expired" ? "Your MechPro subscription has expired." : body.status === "suspended" ? "This MechPro subscription is suspended." : "An active MechPro subscription is required for the Windows app."); desktopEntitlementVerified = true; desktopLoginMessage = ""; return true }
async function flushMutationQueue() { if (flushingMutationQueue || !navigator.onLine || !authSession()) return; flushingMutationQueue = true; let synced = 0; try { const queue = readMutationQueue(); for (const item of [...queue]) { if (item.conflict) continue; let response; try { response = await authorizedApiRequest(item.path, withOptimisticConcurrencyHeaders({ method: item.method, body: item.body }, item.expectedUpdatedAt)) } catch { break } if (response.status === 409) { item.conflict = true; writeMutationQueue(queue); toast("An offline edit conflicts with newer server data. Reload before editing that record again."); continue } if (!response.ok) { if (response.status >= 500 || response.status === 401) break; item.conflict = true; writeMutationQueue(queue); continue } queue.splice(queue.indexOf(item), 1); writeMutationQueue(queue); synced++ } if (synced) toast(`${synced} offline change${synced === 1 ? "" : "s"} synced`) } finally { flushingMutationQueue = false } }
async function apiFetch(path, options = {}) { if (isOfflineDesktop()) { if (String(path).startsWith("/ai/")) { const aiError = new Error("MechPro AI runs in the cloud. This offline copy keeps records on this computer only, so sign in to the online version at yourcarguy806.com to use the assistant."); aiError.retryable = false; throw aiError } const method = String(options.method || "GET").toUpperCase(); if (method === "GET" || method === "HEAD") { const offlineError = new Error("This copy of MechPro keeps shop records on this computer."); offlineError.retryable = false; throw offlineError } return { queued: true } } if (readMutationQueue().some(item => !item.conflict) && navigator.onLine && !flushingMutationQueue) void flushMutationQueue(); const mutation = prepareMutation(path, options); try { const response = await authorizedApiRequest(path, withOptimisticConcurrencyHeaders(mutation.options, mutation.expectedUpdatedAt)); if (!response.ok) { const payload = await response.json().catch(() => ({})), error = new Error(payload.message || `API request failed: ${response.status}`); error.status = response.status; error.retryable = response.status >= 500; throw error } return response.status === 204 ? null : response.json() } catch (error) { if (mutation.queueable && (error.retryable || !navigator.onLine || error instanceof TypeError)) { queueEntityMutation(mutation); if (!options.silent) toast("Saved offline. MechPro will sync when the connection returns."); return { queued: true } } throw error } }
window.addEventListener("online", flushMutationQueue);
async function pushCustomerToApi(record) { record.id ||= mutationId(); try { await apiFetch("/entities/customers", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync customer to API", error) } }
async function loadCustomersFromApi() { try { state.customers = await apiFetch("/entities/customers"); cloudSyncStatus = "connected"; save() } catch (error) { console.error("Failed to load customers from API; using local data", error); cloudSyncStatus = authSession() ? "offline" : "local" } }
async function pushOrderToApi(record) { try { const saved = await apiFetch("/entities/orders", { method: "POST", body: JSON.stringify(record) }); return saved?.queued ? record : saved || record } catch (error) { console.error("Failed to sync order to API", error); throw error } }
async function updateOrderInApi(record, { throwOnError = true } = {}) { try { const saved = await apiFetch(`/entities/orders/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(record) }); return saved?.queued ? record : saved || record } catch (error) { console.error("Failed to sync order update to API", error); if (throwOnError) throw error; return null } }
async function deleteOrderInApi(id) { try { await apiFetch(`/entities/orders/${encodeURIComponent(id)}`, { method: "DELETE" }) } catch (error) { console.error("Failed to delete order in API", error) } }
async function loadOrdersFromApi() { try { state.orders = await apiFetch("/entities/orders"); cloudSyncStatus = "connected"; save() } catch (error) { console.error("Failed to load orders from API; using local data", error); cloudSyncStatus = authSession() ? "offline" : "local" } }
async function pushInvoiceToApi(record) { try { await apiFetch("/entities/invoices", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync invoice to API", error) } }
async function updateInvoiceInApi(record, { throwOnError = false } = {}) { try { return await apiFetch(`/entities/invoices/${encodeURIComponent(record.number)}`, { method: "PUT", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync invoice update to API", error); if (throwOnError) throw error; return null } }
async function loadInvoicesFromApi() { try { state.invoices = await apiFetch("/entities/invoices"); save() } catch (error) { console.error("Failed to load invoices from API; using local data", error) } }
async function pushPaymentToApi(record) { try { await apiFetch("/entities/payments", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync payment to API", error) } }
async function loadPaymentsFromApi() { try { state.payments = await apiFetch("/entities/payments"); save() } catch (error) { console.error("Failed to load payments from API; using local data", error) } }
async function pushExpenseToApi(record) { try { await apiFetch("/entities/expenses", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync expense to API", error) } }
async function loadExpensesFromApi() { try { state.expenses = await apiFetch("/entities/expenses"); save() } catch (error) { console.error("Failed to load expenses from API; using local data", error) } }
async function pushEstimateToApi(record) { try { await apiFetch("/entities/estimates", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync estimate to API", error) } }
async function updateEstimateInApi(record) { try { await apiFetch(`/entities/estimates/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync estimate update to API", error) } }
async function loadEstimatesFromApi() { try { state.estimates = await apiFetch("/entities/estimates"); save() } catch (error) { console.error("Failed to load estimates from API; using local data", error) } }
async function pushShiftEntryToApi(record) { try { await apiFetch("/entities/shiftentries", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync shift entry to API", error) } }
async function updateShiftEntryInApi(record) { try { await apiFetch(`/entities/shiftentries/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync shift entry update to API", error) } }
async function loadShiftEntriesFromApi() { try { state.shiftEntries = await apiFetch("/entities/shiftentries"); save() } catch (error) { console.error("Failed to load shift entries from API; using local data", error) } }
async function pushJobClockEntryToApi(record) { try { await apiFetch("/entities/jobclockentries", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync job clock entry to API", error) } }
async function updateJobClockEntryInApi(record) { try { await apiFetch(`/entities/jobclockentries/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync job clock entry update to API", error) } }
async function loadJobClockEntriesFromApi() { try { state.jobClockEntries = await apiFetch("/entities/jobclockentries"); save() } catch (error) { console.error("Failed to load job clock entries from API; using local data", error) } }
async function pushPayrollEntryToApi(record) { try { await apiFetch("/entities/payrollentries", { method: "POST", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync payroll entry to API", error) } }
async function updatePayrollEntryInApi(record) { try { await apiFetch(`/entities/payrollentries/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(record) }) } catch (error) { console.error("Failed to sync payroll entry update to API", error) } }
async function loadPayrollEntriesFromApi() { try { state.payrollEntries = await apiFetch("/entities/payrollentries"); save() } catch (error) { console.error("Failed to load payroll entries from API; using local data", error) } }
const shopEntityCollections = { vehicles: "vehicles", inventory: "inventory", vendors: "vendors", services: "services", inspectiontemplates: "inspectionTemplates", inspections: "inspections", reminders: "reminders", appointments: "appointments", purchases: "purchases", shopsettings: "shopSettingsRecords", diagnosticsessions: "diagnosticSessions", keyprogrammingjobs: "keyJobs" };
async function saveShopEntity(type, record) { const saved = await apiFetch(`/entities/${type}${record.updatedAt ? `/${encodeURIComponent(record.id)}` : ""}`, { method: record.updatedAt ? "PUT" : "POST", body: JSON.stringify(record) }), value = saved?.queued ? record : saved, collection = shopEntityCollections[type], index = state[collection].findIndex(item => item.id === value.id); if (index >= 0) state[collection][index] = value; else state[collection].push(value); save(); return value }
const shopEntityReadRoles = { keyprogrammingjobs: ["admin", "technician", "service_writer"] };
async function loadShopEntities() { const role = currentUser()?.role || ""; const types = Object.keys(shopEntityCollections).filter(type => !shopEntityReadRoles[type] || shopEntityReadRoles[type].includes(role)); const results = await Promise.allSettled(types.map(type => apiFetch(`/entities/${type}`))); let failed = 0; types.forEach((type, index) => { const result = results[index]; if (result.status === "fulfilled" && Array.isArray(result.value)) state[shopEntityCollections[type]] = result.value; else if (result.status === "rejected") { failed += 1; console.error(`Failed to load ${type}; using local data`, result.reason) } }); save(); return failed === 0 }
function icon(name, size = 18) { return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>` }
function money(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value) }
function initials(name) { return name.split(/\s+/).map(x => x[0]).slice(0, 2).join("").toUpperCase() }
const roleLabel = { super_admin: "Super Admin", admin: "Admin", technician: "Technician", office: "Office", service_writer: "Service Writer" };
const roleRoutes = { super_admin: ["superadmin"], admin: ["dispatch", "orders", "schedule", "customers", "shopops", "oem-diagnostics", "obd", "keys", "chat", "invoices", "pos", "ai", "accounting", "payroll", "messaging", "payments", "integrations", "support", "imports", "reports", "settings", "employees"], technician: ["dispatch", "orders", "schedule", "shopops", "oem-diagnostics", "obd", "keys", "chat", "ai", "payroll", "integrations", "support"], office: ["customers", "shopops", "chat", "invoices", "pos", "accounting", "messaging", "integrations", "support"], service_writer: ["dispatch", "orders", "schedule", "customers", "shopops", "oem-diagnostics", "obd", "keys", "chat", "invoices", "pos", "ai", "messaging", "integrations", "support"] };
function currentUser() { const session = authSession(); if (!session || !desktopEntitlementVerified) return null; const email = String(session.claims.email || "").trim().toLowerCase(); const profile = state.users.find(user => user.id === state.currentUserId && user.active && user.email.toLowerCase() === email) || null; if (!profile) return null; const jwtRole = sessionClaimRole(session.claims); return jwtRole && jwtRole !== profile.role ? { ...profile, role: jwtRole } : profile }
function canAccess(route) { return !!currentUser() && roleRoutes[currentUser().role].includes(route) }
function visibleOrders() { const user = currentUser(); return user?.role === "technician" ? state.orders.filter(order => orderIncludesTechnician(order, user, state.users)) : state.orders }
function weekPeriod(date = new Date()) { const day = date.getDay(), monday = new Date(date); monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1)); monday.setHours(0, 0, 0, 0); const friday = new Date(monday); friday.setDate(monday.getDate() + 4); return { key: monday.toISOString().slice(0, 10), start: monday.toLocaleDateString("en-US", { month: "short", day: "numeric" }), end: friday.toLocaleDateString("en-US", { month: "short", day: "numeric" }) } }
function shopDayLabel(date = new Date()) { return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) }
function relativePromiseHint() { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); return `Tomorrow, ${tomorrow.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` }
function employeeByTech(name) { return state.users.find(user => user.techName === name && user.active) }
function syncPayroll(order) { const period = weekPeriod(); const lines = payrollLinesForOrder({ order, users: state.users, clocks: state.jobClockEntries, periodKey: period.key, nowIso: now() }); lines.forEach(line => { const entry = state.payrollEntries.find(item => item.id === line.id || (item.workOrderId === line.workOrderId && item.employeeId === line.employeeId && item.periodKey === line.periodKey)); if (entry) { Object.assign(entry, line); updatePayrollEntryInApi(entry) } else { state.payrollEntries.push(line); pushPayrollEntryToApi(line) } }) }
function syncAllPayroll() { state.orders.forEach(syncPayroll); save() }
function now() { return new Date().toISOString() }
function openShift(userId = currentUser()?.id) { return state.shiftEntries.find(entry => entry.userId === userId && !entry.clockOut) }
function openJobClock(workOrderId, userId = currentUser()?.id) { return state.jobClockEntries.find(entry => entry.workOrderId === workOrderId && entry.userId === userId && !entry.clockOut) }
function hoursBetween(start, end) { return Math.max(0, Math.round((new Date(end) - new Date(start)) / 36000) / 100) }
function formatTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }
function formatHours(hours) { return `${Number(hours || 0).toFixed(2)} hr` }
function jobTrackedHours(workOrderId) { return state.jobClockEntries.filter(entry => entry.workOrderId === workOrderId && entry.clockOut).reduce((sum, entry) => sum + Number(entry.hours || 0), 0) }
function toggleShift() { const user = currentUser(), shift = openShift(user.id); if (shift) { shift.clockOut = now(); shift.hours = hoursBetween(shift.clockIn, shift.clockOut); updateShiftEntryInApi(shift); toast(`Shift clocked out: ${formatHours(shift.hours)}`) } else { const entry = { id: `shift-${Date.now()}`, userId: user.id, clockIn: now(), clockOut: null, hours: 0 }; state.shiftEntries.push(entry); pushShiftEntryToApi(entry); toast("Shift clocked in") }; save(); render() }
function startJobClock(workOrderId) { const order = state.orders.find(item => item.id === workOrderId), user = currentUser(); if (!order || user.role !== "technician" || !orderIncludesTechnician(order, user, state.users)) { toast("Only an assigned technician can clock this job"); return } if (openJobClock(workOrderId, user.id)) { toast("You are already clocked into this job"); return } const entry = { id: `jobclock-${Date.now()}`, workOrderId, userId: user.id, clockIn: now(), clockOut: null, hours: 0 }; state.jobClockEntries.push(entry); pushJobClockEntryToApi(entry); save(); toast(`${order.id} job clock started`); render() }
function stopJobClock(workOrderId) { const order = state.orders.find(item => item.id === workOrderId), entry = openJobClock(workOrderId); if (!order || !entry) return; entry.clockOut = now(); entry.hours = hoursBetween(entry.clockIn, entry.clockOut); const tracked = attributeClockHours(order, currentUser()?.id, state.jobClockEntries, state.users); order.assignments = tracked.assignments; order.tech = tracked.tech; order.laborHours = tracked.laborHours; updateJobClockEntryInApi(entry); void updateOrderInApi(order).catch(error => toast(error.message || "Work order could not be saved")); save(); toast(`${order.id} job clock stopped: ${formatHours(entry.hours)}`); render() }
function label(status) { return ({ estimate: "Estimate", approved: "Approved", in_progress: "In progress", waiting_parts: "Waiting parts", completed: "Completed", invoiced: "Invoiced", paid: "Paid", sent: "Sent", overdue: "Overdue" })[status] || status }
function badge(status) { return `<span class="badge ${status}">${label(status)}</span>` }
function toast(message) { const node = document.createElement("div"); node.className = "toast"; node.textContent = message; document.querySelector("#toast-region").append(node); setTimeout(() => node.remove(), 2600) }
let attentionDismissBound = false;
let userMenuDismissBound = false;
function nav(route, iconName, text, count = "") { if (!canAccess(route)) return ""; const current = state.route === route; return `<button class="nav-button ${current ? "active" : ""}" data-route="${route}"${current ? ' aria-current="page"' : ""}>${icon(iconName)}<span>${text}</span>${count !== "" && count !== "0" ? `<span class="count">${count}</span>` : ""}</button>` }
function sidebarNavigation() { const counts = { active: visibleOrders().filter(x => !["completed", "invoiced"].includes(x.status)).length, orders: visibleOrders().length, overdue: state.invoices.filter(x => x.status === "overdue").length, unread: state.conversations.reduce((sum, item) => sum + chatUnread(item), 0) }; const oem = true; return visibleSidebar(canAccess, { oem }).map(section => `<div class="nav-label">${escapeHtml(section.label)}</div><nav class="nav" aria-label="${escapeHtml(section.label)}">${section.items.map(item => nav(item.route, item.icon, bayNavLabel(item), item.count ? String(counts[item.count] || "") : "")).join("")}</nav>`).join("") }
function attentionMenu() { const model = buildHomeModel({ orders: visibleOrders(), invoices: canAccess("invoices") ? state.invoices : [], appointments: state.appointments || [], now: new Date() }); const count = model.attention.length; const rows = model.attention.slice(0, 6).map(item => { const detail = item.type === "overdue" ? `${String(item.detail || "").split(" · ")[0]} · ${money(item.amount || 0)}` : item.detail; return `<button type="button" class="attention-item" ${item.orderId ? `data-order="${escapeHtml(item.orderId)}"` : `data-route="invoices"`}><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(detail || "")}</small></button>` }).join(""); return `<div class="attention-menu"><button class="icon-button" id="attention-toggle" type="button" aria-label="Needs attention${count ? `, ${count} items` : ""}" aria-expanded="false" aria-controls="attention-panel" title="Needs attention">${icon("bell")}${count ? `<span class="attention-badge">${count}</span>` : ""}</button><div class="attention-panel" id="attention-panel" hidden role="dialog" aria-label="Needs attention"><div class="attention-panel-head"><strong>Needs attention</strong><span>${count ? `${count} open` : "All clear"}</span></div>${rows || `<p class="attention-empty">Nothing is waiting. Home shows the full shop snapshot.</p>`}<button class="mini-action attention-home" type="button" data-route="home">Open home</button></div></div>` }
function bindAttentionPanel() { const toggle = document.querySelector("#attention-toggle"), panel = document.querySelector("#attention-panel"); if (!toggle || !panel) return; toggle.onclick = event => { event.stopPropagation(); const willOpen = panel.hidden; panel.hidden = !willOpen; toggle.setAttribute("aria-expanded", willOpen ? "true" : "false") }; if (attentionDismissBound) return; attentionDismissBound = true; document.addEventListener("click", event => { const openPanel = document.querySelector("#attention-panel"), openToggle = document.querySelector("#attention-toggle"); if (!openPanel || openPanel.hidden || event.target.closest(".attention-menu")) return; openPanel.hidden = true; openToggle?.setAttribute("aria-expanded", "false") }) }
function syncStatusBadge() { const pending = readMutationQueue().filter(item => !item.conflict).length, conflicts = readMutationQueue().filter(item => item.conflict).length, online = navigator.onLine; if (conflicts) return `<span class="sync-pill conflict" title="Offline edits conflict with newer server data">${icon("triangle-alert", 14)} ${conflicts} conflict${conflicts === 1 ? "" : "s"}</span>`; if (!online) return `<span class="sync-pill offline" title="Working offline">${icon("wifi-off", 14)} Offline${pending ? ` · ${pending} queued` : ""}</span>`; if (pending) return `<span class="sync-pill pending" title="Waiting to sync offline changes">${icon("refresh-cw", 14)} Syncing ${pending}</span>`; return `<span class="sync-pill online" title="Connected">${icon("cloud-check", 14)} Online</span>` }
function shell(content) { const user = currentUser(), profile = shopProfile(), shift = openShift(user.id); return `<a class="skip-link" href="#main-content">Skip to content</a><div class="app-shell"><aside class="sidebar" id="sidebar"><div class="brand"><div class="brand-mark">${icon("wrench")}</div><div><div class="brand-name">MechPro</div><small>Shop operating system</small></div></div>${sidebarNavigation()}<div class="sidebar-foot"><div class="shop-card"><strong>${escapeHtml(profile.shopName || "Your shop")}</strong><span>${escapeHtml(profile.phone || "Add a phone in Settings")}</span></div><div class="user-menu" id="user-menu"><button class="user-row" id="user-menu-toggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="user-menu-panel"><div class="avatar">${initials(user.name)}</div><div><strong>${escapeHtml(user.name)}</strong><span>${roleLabel[user.role]}</span></div>${icon("chevron-up", 14)}</button><div class="user-menu-panel" id="user-menu-panel" role="menu" hidden>${canAccess("settings") ? `<button type="button" role="menuitem" id="user-menu-settings">${icon("settings", 14)} Shop settings</button>` : ""}<button type="button" role="menuitem" id="sign-out">${icon("log-out", 14)} Sign out</button></div></div></div></aside><main class="main"><header class="topbar"><button class="icon-button menu-button" id="menu-button" type="button" aria-label="Open navigation menu" title="Open menu">${icon("menu")}</button><label class="global-search">${icon("search", 16)}<input id="global-search" aria-label="Search work orders, customers, and VINs" value="${query}" placeholder="Search ROs, customers, VIN..."/><span class="shortcut">/</span></label><div class="top-actions">${syncStatusBadge()}<button class="shift-button ${shift ? "clocked" : ""}" id="global-clock">${icon(shift ? "square" : "play", 14)} ${shift ? `Clock out · ${formatTime(shift.clockIn)}` : "Clock in"}</button><button class="location-pill" type="button" data-route="settings" title="Open shop settings">${icon("map-pin", 15)} ${escapeHtml(profile.shopName || "Shop")}</button>${attentionMenu()}</div></header><div class="content" id="main-content">${content}</div></main></div>` }
function heading(kicker, title, description, action = true) { return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div><div class="head-actions"><button class="secondary" id="export-button">${icon("download", 15)} Export</button>${action ? `<button class="primary" id="new-ro-button">${icon("plus", 15)} New work order</button>` : ""}</div></div>` }
function filtered() { const q = query.trim().toLowerCase(); return visibleOrders().filter(x => (filter === "all" || (filter === "active" ? !["completed", "invoiced"].includes(x.status) : ["completed", "invoiced"].includes(x.status))) && (!q || [x.id, x.customer, x.vehicle, x.vin, x.complaint, x.tech].some(v => String(v).toLowerCase().includes(q)))) }
function stats() { const tech = currentUser()?.role === "technician", orders = visibleOrders(), openCount = orders.filter(x => !["completed", "invoiced"].includes(x.status)).length, inProgress = orders.filter(x => x.status === "in_progress").length, waiting = orders.filter(x => x.status === "waiting_parts").length, paid = state.invoices.filter(x => x.status === "paid").reduce((s, x) => s + x.amount, 0), overdue = state.invoices.filter(x => x.status === "overdue"), overdueTotal = overdue.reduce((s, x) => s + Number(x.amount || 0), 0), baysInUse = new Set(orders.filter(x => x.status === "in_progress" && x.bay && x.bay !== "Unassigned" && x.bay !== "Mobile").map(x => x.bay)).size, cells = tech ? [["clipboard-check", "My open orders", openCount, "Assigned to you", "good"], ["circle-play", "In progress", inProgress, "Active repairs", ""], ["triangle-alert", "Waiting on parts", waiting, "Parts follow-up needed", "warn"]] : [["clipboard-check", "Open work orders", openCount, `${openCount} active in shop`, "good"], ["circle-play", "In progress", inProgress, `${baysInUse} bay${baysInUse === 1 ? "" : "s"} in use`, ""], ["triangle-alert", "Waiting on parts", waiting, waiting ? `${waiting} need parts follow-up` : "No parts holds", "warn"], ["badge-dollar-sign", "Collected (paid invoices)", money(paid), "From paid invoice register", "good"], ["clock-alert", "Overdue invoices", overdue.length, overdue.length ? `${money(overdueTotal)} outstanding` : "None overdue", "warn"]]; return `<div class="stats ${tech ? "tech-stats" : ""}">${cells.map(x => `<div class="stat"><div class="stat-top"><span>${x[1]}</span>${icon(x[0])}</div><div class="stat-value">${x[2]}</div><div class="stat-note ${x[4]}">${x[3]}</div></div>`).join("")}</div>` }
function toolbar() { return `<div class="toolbar"><div class="tabs">${[["active", "Active"], ["completed", "Completed"], ["all", "All orders"]].map(x => `<button class="tab ${filter === x[0] ? "active" : ""}" data-filter="${x[0]}">${x[1]}</button>`).join("")}</div><label class="toolbar-search">${icon("search")}<input id="order-search" value="${query}" placeholder="Filter this view..."/></label></div>` }
function card(x) { return `<button class="job-card ${x.priority}" data-order="${x.id}"><div class="job-meta"><span>${x.id}</span><span>·</span><span>${x.bay}</span>${x.mobile ? `<span class="mobile">${icon("map-pin", 10)} Mobile</span>` : ""}</div><h4>${x.customer}</h4><div class="vehicle">${x.vehicle}</div><p class="complaint">${x.complaint}</p><div class="job-foot"><span class="tech"><span class="mini-avatar">${initials(x.tech)}</span>${x.tech}</span><span class="promise">${icon("clock-3", 11)}${x.promise}</span></div></button>` }
function dispatch() { const statuses = ["estimate", "approved", "in_progress", "waiting_parts"], orders = filtered(), lanes = statuses.map(s => { const items = orders.filter(x => x.status === s); return `<section class="lane"><div class="lane-head"><span class="status-dot ${s}"></span><h3>${label(s)}</h3><span class="lane-count">${items.length}</span></div><div class="lane-body">${items.length ? items.map(card).join("") : `<div class="empty-lane">No work orders</div>`}</div></section>` }).join(""); return shell(`${heading(shopDayLabel(), "Dispatch board", "Live shop workload, technician assignments, and promise times.")}${stats()}${toolbar()}<div class="board">${lanes}</div>`) }
function orders() { const rows = filtered().map(x => `<tr data-order="${x.id}"><td class="mono strong">${x.id}</td><td><b>${escapeHtml(x.customer)}</b><small>${escapeHtml(x.phone)}</small></td><td><b>${escapeHtml(x.vehicle)}</b><small class="mono">${escapeHtml(x.vin)}</small></td><td>${badge(x.status)}</td><td>${escapeHtml(x.tech)}<small>${escapeHtml(x.bay)}</small></td><td>${escapeHtml(x.promise)}</td><td><b>${money(x.total)}</b></td></tr>`).join(""); return shell(`${heading("Operations", "Work orders", "Every estimate, repair, and completed job in one searchable queue.")}${toolbar()}<div class="data-panel"><table><thead><tr><th>RO number</th><th>Customer</th><th>Vehicle</th><th>Status</th><th>Assignment</th><th>Promise</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>${rows ? "" : empty("No matching work orders")}</div>`) }
function schedule() { return scheduleWorkspace() }
function customers() { const q = query.toLowerCase(), cards = state.customers.filter(x => !q || Object.values(x).join(" ").toLowerCase().includes(q)).map(x => { const visitCount = state.orders.filter(o => o.customer === x.name).length; return `<article class="customer-card" data-open-customer="${encodeURIComponent(x.name)}"><div class="customer-top"><div class="avatar">${initials(x.name)}</div><div><h3>${escapeHtml(x.name)}</h3><p>${escapeHtml(x.phone)} · ${escapeHtml(x.email)}</p></div></div><div class="customer-stats"><div><span>Vehicles</span><b>${x.vehicles}</b></div><div><span>Lifetime spend</span><b>${money(x.spend)}</b></div><div><span>Shop visits</span><b>${Math.max(Number(x.visits) || 0, visitCount)}</b></div><div><span>Linked ROs</span><b>${visitCount || "None"}</b></div></div><div class="customer-card-actions"><button class="customer-message" data-message-customer="${encodeURIComponent(x.name)}" data-message-phone="${encodeURIComponent(x.phone || "")}" data-message-email="${encodeURIComponent(x.email || "")}">${icon("send", 14)} Message</button><button class="mini-action" data-open-customer="${encodeURIComponent(x.name)}">${icon("user", 14)} Details</button></div></article>` }).join(""); return shell(`${heading("Relationships", "Customers", "Customer contact details, vehicles, and service value at a glance.")}<div class="customer-grid">${cards}</div>`) }
const inspectionPoints = ["Exterior lights", "Windshield", "Wiper blades", "Washer operation", "Mirrors", "Horn", "Seat belts", "Warning lights", "Battery condition", "Battery terminals", "Charging system", "Engine oil", "Coolant", "Brake fluid", "Power steering fluid", "Transmission fluid", "Belts", "Hoses", "Air filter", "Cabin filter", "Fuel system leaks", "Exhaust system", "Front brake pads", "Rear brake pads", "Brake rotors/drums", "Brake hoses/lines", "Parking brake", "Steering components", "Front suspension", "Rear suspension", "CV boots/U-joints", "Wheel bearings", "Tire tread LF", "Tire tread RF", "Tire tread LR", "Tire tread RR"];
function customerOptions(selected = "") { return customersWithSelected(state.customers, selected).map(customer => `<option ${customer.name === selected ? "selected" : ""}>${escapeHtml(customer.name)}</option>`).join("") }
function vehicleLabel(vehicle) { return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ") }
let relationshipDerivedCache=null;
function getRelationshipDerived(){const key=[state.orders.length,state.vehicles.length,state.orders.at(-1)?.id||"",state.vehicles.at(-1)?.id||""].join("|");if(relationshipDerivedCache?.key===key)return relationshipDerivedCache;const ordersByVin=new Map(),ordersByVehicleLabel=new Map(),vehicleByLookup=new Map();for(const order of state.orders){if(order.vin){const list=ordersByVin.get(order.vin)||[];list.push(order);ordersByVin.set(order.vin,list)}if(order.vehicle){const list=ordersByVehicleLabel.get(order.vehicle)||[];list.push(order);ordersByVehicleLabel.set(order.vehicle,list)}}for(const vehicle of state.vehicles){const label=vehicleLabel(vehicle);if(vehicle.id)vehicleByLookup.set(vehicle.id,vehicle);if(label)vehicleByLookup.set(label,vehicle);if(vehicle.customer&&vehicle.plate)vehicleByLookup.set(`${vehicle.customer}#${vehicle.plate}`,vehicle);if(vehicle.customer&&vehicle.vin)vehicleByLookup.set(`${vehicle.customer}#${vehicle.vin}`,vehicle)}relationshipDerivedCache={key,ordersByVin,ordersByVehicleLabel,vehicleByLookup};return relationshipDerivedCache}
function linkedOrders(vehicle) { const { ordersByVin, ordersByVehicleLabel } = getRelationshipDerived(), byVin = vehicle.vin ? ordersByVin.get(vehicle.vin) || [] : [], byLabel = ordersByVehicleLabel.get(vehicleLabel(vehicle)) || []; return byVin.length && byLabel.length ? [...new Set([...byVin, ...byLabel])] : byVin.length ? byVin : byLabel }
function operationsVehicles() { const rows = state.vehicles.map(vehicle => { const history = linkedOrders(vehicle); return `<tr data-edit-vehicle="${vehicle.id}" class="clickable-row"><td><b>${escapeHtml(vehicleLabel(vehicle))}</b><small>${escapeHtml(vehicle.plate || "No plate")} · ${escapeHtml(vehicle.mileage || "Mileage pending")}</small></td><td>${escapeHtml(vehicle.customer)}</td><td class="mono">${escapeHtml(vehicle.vin || "VIN pending")}</td><td>${history.length}<small>${history.at(-1)?.id || "No service yet"}</small></td><td>${vehicle.nextServiceDate || "Not set"}</td></tr>` }).join(""); return `<div class="ops-actions"><button class="primary" id="add-vehicle">${icon("car-front", 14)} Add vehicle</button></div><div class="data-panel"><table><thead><tr><th>Vehicle</th><th>Owner</th><th>VIN</th><th>Service history</th><th>Next service</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No linked vehicles yet.</td></tr>`}</tbody></table></div>` }
function catalogInspectionApp() { return { showModal, closeModal, toast, escapeHtml, icon, state, saveShopEntity, uploadFileToR2, now, shopProfile, printableBrand, currentUser, cloudflareConfig, render, vehicleLabel, isLocalShell, save } }
function openCatalogInspection(existing, catalogId) { presentCatalogInspection(catalogInspectionApp(), existing, catalogId) }
function operationsInspections() { const rows = [...state.inspections].reverse().map(item => { const counts = (item.items || []).reduce((total, row) => (total[row.status] = (total[row.status] || 0) + 1, total), {}), results = item.catalogId ? `<span class="inspection-count fail">${counts.critical || 0} safety</span> <span class="inspection-count warn">${counts.soon || 0} soon</span> <span class="inspection-count good">${counts.ok || 0} ok</span>` : `<span class="inspection-count good">${counts.pass || 0} pass</span> <span class="inspection-count warn">${counts.attention || 0} attention</span> <span class="inspection-count fail">${counts.fail || 0} fail</span>`, badge = item.recordStatus === "closed" ? `<span class="badge paid">Closed</span>` : item.catalogId ? `<span class="badge estimate">Draft</span>` : item.approvalStatus === "approved" ? `<span class="badge paid">Approved</span>` : item.approvalStatus === "rejected" ? `<span class="badge overdue">Rejected</span>` : `<span class="badge estimate">Pending</span>`; return `<tr><td><b>${escapeHtml(item.number)}</b><small>${escapeHtml(item.inspectionName || "Checklist")} · ${new Date(item.createdAt).toLocaleDateString()}</small></td><td>${escapeHtml(item.customer)}<small>${escapeHtml(item.vehicle)}</small></td><td>${escapeHtml(item.workOrderId || "Unlinked")}</td><td>${results}</td><td>${badge}</td><td><button class="mini-action" data-edit-inspection="${item.id}">${icon("clipboard-check", 13)} Open</button><button class="mini-action" data-estimate-from-inspection="${item.id}">${icon("file-text", 13)} Estimate</button></td></tr>` }).join(""); return `<div class="ops-actions"><span class="ops-note">Lubbock flat rates. Repairs, parts, and disassembly are quoted separately.</span><button class="secondary" id="manage-templates">${icon("list-plus", 14)} Templates</button><button class="secondary" id="add-inspection">${icon("clipboard-check", 14)} Custom checklist</button></div><div class="inspection-catalog">${inspectionMenuHtml(escapeHtml)}</div><div class="data-panel"><table><thead><tr><th>Inspection</th><th>Customer & vehicle</th><th>Work order</th><th>Results</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">No inspections yet. Start one from the menu above.</td></tr>`}</tbody></table></div>` }
function operationsInventory() { const rows = state.inventory.map(item => `<tr class="${Number(item.quantity) <= Number(item.reorderLevel) ? "low-stock" : ""}"><td><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.sku)} · ${escapeHtml(item.kind)}</small></td><td>${Number(item.quantity || 0)} ${escapeHtml(item.unit || "ea")}<small>Reorder at ${Number(item.reorderLevel || 0)}</small></td><td>${money(Number(item.cost || 0))}</td><td>${money(Number(item.price || 0))}</td><td>${escapeHtml(item.vendor || "Unassigned")}</td><td><button class="mini-action" data-receive-stock="${item.id}">${icon("package-plus", 13)} Receive</button><button class="mini-action" data-order-autozone="${escapeHtml(item.id)}">${icon("shopping-cart", 13)} AutoZone</button></td></tr>`).join(""); return `<div class="ops-actions"><span class="ops-note">${state.inventory.filter(item => Number(item.quantity) <= Number(item.reorderLevel)).length} low-stock item(s)</span><button class="secondary" id="add-vendor">${icon("truck", 14)} Vendor</button><button class="primary" id="add-inventory">${icon("package-plus", 14)} Add item</button></div><div class="data-panel"><table><thead><tr><th>Item</th><th>On hand</th><th>Cost</th><th>Price</th><th>Vendor</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">No parts, tires, services, or assets in inventory.</td></tr>`}</tbody></table></div>` }
function visibleCannedServices() { const ids = new Set(CANNED_MENU.map(item => item.id)); if (state.services.some(item => ids.has(item.id))) return state.services; const names = new Set(state.services.map(item => String(item.name || "").trim().toLowerCase())); return [...state.services, ...CANNED_MENU.filter(item => !names.has(item.name.toLowerCase()))] }
function operationsServices() { const groups = cannedServiceGroups(visibleCannedServices()), tables = groups.map(group => { const rows = group.items.map(item => { const price = Number(item.menuPrice ?? item.partsPrice ?? 0), discount = Number(item.discount || 0); return `<tr><td><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description || "")}</small>${item.marginNote ? `<small>${escapeHtml(item.marginNote)}</small>` : ""}</td><td>${money(price)}${discount ? `<small>${discount}% off</small>` : ""}</td><td><button type="button" class="mini-action" data-edit-service="${escapeAttr(item.id)}">${icon("pencil", 13)} Edit</button></td></tr>` }).join(""); return `<h3>${escapeHtml(group.label)}</h3><div class="data-panel"><table><thead><tr><th>Service</th><th>Menu price</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` }).join(""); return `<div class="ops-actions"><span class="ops-note">Starter menu prices. Edit any job for this shop. The shop note stays off the customer estimate.</span><button class="primary" id="add-service">${icon("list-plus", 14)} Canned service</button></div>${tables || `<div class="data-panel"><table><tbody><tr><td>No canned services yet.</td></tr></tbody></table></div>`}` }
function reminderVehicle(item) { const lookup = getRelationshipDerived().vehicleByLookup; return lookup.get(item.vehicle) || lookup.get(`${item.customer}#${item.vehicle}`) }
function reminderStatus(item) { if (item.sentAt) return "sent"; const today = new Date(), todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-"), vehicle = reminderVehicle(item), mileageDue = Number(item.dueMileage) > 0 && Number.isFinite(Number(vehicle?.mileage)) && Number(vehicle.mileage) >= Number(item.dueMileage); if (item.dueDate && item.dueDate < todayKey) return "overdue"; if (item.dueDate === todayKey || mileageDue) return "due"; return "upcoming" }
function operationsReminders() { const filters = [["all", "All"], ["due", "Due"], ["overdue", "Overdue"], ["sent", "Sent"]], items = [...state.reminders].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).filter(item => reminderFilter === "all" || reminderStatus(item) === reminderFilter), rows = items.map(item => { const status = reminderStatus(item), vehicle = reminderVehicle(item), statusLabel = status === "upcoming" ? "Upcoming" : status[0].toUpperCase() + status.slice(1), statusClass = status === "sent" ? "paid" : status === "overdue" ? "overdue" : status === "due" ? "approved" : "estimate"; return `<tr class="clickable-row" data-edit-reminder="${item.id}"><td>${escapeHtml(item.customer)}<small>${escapeHtml(item.vehicle)}</small></td><td>${escapeHtml(item.service)}${item.parentReminderId ? `<small>Follow-up reminder</small>` : ""}</td><td>${item.dueDate || "Date pending"}<small>${item.dueMileage ? `${item.dueMileage} miles${vehicle?.mileage ? ` · current ${vehicle.mileage}` : ""}` : "No mileage trigger"}</small></td><td><span class="badge ${statusClass}">${statusLabel}</span>${item.sentAt ? `<small>${new Date(item.sentAt).toLocaleString()}</small>` : ""}</td><td><div class="reminder-actions"><button class="mini-action" data-edit-reminder-button="${item.id}">${icon("pencil", 13)} Edit</button>${item.sentAt ? `<button class="mini-action" data-follow-up-reminder="${item.id}">${icon("calendar-plus", 13)} Follow up</button>` : `<button class="mini-action" data-send-reminder="${item.id}">${icon("send", 13)} Send</button>`}</div></td></tr>` }).join(""); return `<div class="ops-actions reminder-toolbar"><div class="tabs reminder-filters">${filters.map(([value, text]) => `<button class="tab ${reminderFilter === value ? "active" : ""}" data-reminder-filter="${value}">${text}</button>`).join("")}</div><button class="primary" id="add-reminder">${icon("bell-plus", 14)} Add reminder</button></div><div class="data-panel reminder-table"><table><thead><tr><th>Customer & vehicle</th><th>Service</th><th>Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No ${reminderFilter === "all" ? "maintenance" : reminderFilter} reminders.</td></tr>`}</tbody></table></div>` }
function operationsDiagnostics() { const output = state.elmOutput || "Connect an ELM327 for generic OBD-II data. OEM programming, module coding, and bidirectional controls are in OEM diagnostics.", friendly = typeof output === "string" ? output : output.friendly, raw = typeof output === "object" ? output.raw : ""; return `<section class="diagnostics-console"><div class="messaging-status ${elmPort ? "ready" : "idle"}">${icon(elmPort ? "circle-check" : "usb", 17)}<div><strong>${elmPort ? "ELM327 connected" : "No diagnostic adapter connected"}</strong><span>Chrome or Edge desktop · compatible USB or Bluetooth-COM ELM327 adapter</span></div></div><div class="ops-actions"><button class="primary" id="elm-connect">${icon("plug-zap", 14)} ${elmPort ? "Disconnect" : "Connect adapter"}</button><button class="secondary" data-elm-command="live" ${elmPort ? "" : "disabled"}>${icon("activity", 14)} Live data</button><button class="secondary" data-elm-command="dtc" ${elmPort ? "" : "disabled"}>${icon("scan-line", 14)} Read DTCs</button><button class="secondary danger" data-elm-command="clear" ${elmPort ? "" : "disabled"}>${icon("eraser", 14)} Clear DTCs</button><button class="primary" id="open-oem-programming" type="button">${icon("radio-tower", 14)} OEM programming, coding, and bidirectional</button></div><pre id="elm-output">${escapeHtml(friendly)}</pre>${raw ? `<details class="elm-raw"><summary>Raw adapter response</summary><pre>${escapeHtml(raw)}</pre></details>` : ""}</section>` }
let autozoneAccount = { connected: false, loaded: false };
let partstechAccount = { connected: false, loaded: false };
let laborGuideAccount = { connected: false, provider: "manual", loaded: false };
let quickbooksAccount = { connected: false, loaded: false };
function operationsOrdering() { const canSave = ["owner", "admin"].includes(currentUser()?.role); return [
  orderingPanelHtml(autozoneAccount, { canSave, escapeHtml, icon }),
  partstechPanelHtml(partstechAccount, { canSave, escapeHtml, icon }),
  laborGuidePanelHtml(laborGuideAccount, { canSave, escapeHtml, icon }),
  quickbooksPanelHtml(quickbooksAccount, { canSave, escapeHtml, icon }),
].join("") }
async function loadAutozoneAccount(force = false) { if (autozoneAccount.loaded && !force) return; autozoneAccount = { ...autozoneAccount, loaded: true }; try { const account = await apiFetch("/ordering/autozone"); autozoneAccount = { connected: Boolean(account?.connected), username: account?.username || "", connectedAt: account?.connectedAt || null, loaded: true } } catch { autozoneAccount = { connected: false, loaded: true, unavailable: true } } if (state.route === "shopops" && shopOpsTab === "ordering") render() }

async function loadPartstechAccount(force = false) {
  if (partstechAccount.loaded && !force) return;
  partstechAccount = { ...partstechAccount, loaded: true };
  try {
    const account = await apiFetch("/integrations/partstech");
    partstechAccount = { ...account, loaded: true };
  } catch {
    partstechAccount = { connected: false, loaded: true, unavailable: true };
  }
  if (state.route === "shopops" && shopOpsTab === "ordering") render();
}
async function loadLaborGuideAccount(force = false) {
  if (laborGuideAccount.loaded && !force) return;
  laborGuideAccount = { ...laborGuideAccount, loaded: true };
  try {
    const account = await apiFetch("/integrations/labor-guide");
    laborGuideAccount = { ...account, loaded: true };
  } catch {
    laborGuideAccount = { connected: false, provider: "manual", loaded: true, unavailable: true };
  }
  if (state.route === "shopops" && shopOpsTab === "ordering") render();
}
async function loadQuickbooksAccount(force = false) {
  if (quickbooksAccount.loaded && !force) return;
  quickbooksAccount = { ...quickbooksAccount, loaded: true };
  try {
    const account = await apiFetch("/integrations/quickbooks");
    quickbooksAccount = { ...account, loaded: true };
  } catch {
    quickbooksAccount = { connected: false, loaded: true, unavailable: true };
  }
  if (state.route === "shopops" && shopOpsTab === "ordering") render();
}
async function openAutozoneOrder(keyword) { const url = autozoneProLoginUrl(keyword); const opened = window.open(url, "_blank", "noopener,noreferrer"); if (!opened) { toast("Allow pop-ups to open AutoZone Pro."); return } if (!autozoneAccount.connected) { toast("AutoZone Pro opened. Save the shop login on Ordering to copy the password next time."); return } try { const detail = await apiFetch("/ordering/autozone?reveal=1"); if (detail?.password && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(detail.password); toast(`AutoZone Pro opened for ${detail.username}. Password copied — paste it on their sign-in page.`); return } toast(`AutoZone Pro opened. Sign in as ${detail?.username || "the saved user"}.`) } catch (error) { toast(error.message || "AutoZone Pro opened. The saved password could not be copied.") } }
async function saveAutozoneLogin(form) { const data = Object.fromEntries(new FormData(form)); const account = await apiFetch("/ordering/autozone", { method: "POST", body: JSON.stringify({ username: data.username, password: data.password }) }); autozoneAccount = { connected: true, username: account.username, connectedAt: account.connectedAt, loaded: true }; toast("AutoZone Pro login saved"); render() }
function shopOperations() { const tabs = [["vehicles", "Vehicles"], ["inspections", "Inspections"], ["inventory", "Inventory"], ["ordering", "Ordering"], ["services", "Canned services"], ["reminders", "Reminders"], ["diagnostics", "OBD-II"]], view = { vehicles: operationsVehicles, inspections: operationsInspections, inventory: operationsInventory, ordering: operationsOrdering, services: operationsServices, reminders: operationsReminders, diagnostics: operationsDiagnostics }[shopOpsTab]; return shell(`${heading("Connected workflow", "Shop operations", "Linked vehicles, inspections, stock, service templates, reminders, vendors, and basic OBD-II tools.", false)}<div class="accounting-tabs ops-tabs">${tabs.map(tab => `<button class="tab ${shopOpsTab === tab[0] ? "active" : ""}" data-ops-tab="${tab[0]}">${tab[1]}</button>`).join("")}</div>${view()}`) }
function openVehicleForm(existing = null) { showModal(`<form class="modal" id="vehicle-form"><div class="modal-head"><h2>${existing ? "Edit" : "Add linked"} vehicle</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Owner<select name="customer" required>${customerOptions(existing?.customer)}</select></label><label>VIN<input name="vin" maxlength="17" pattern="[A-HJ-NPR-Z0-9]{17}" value="${escapeHtml(existing?.vin || "")}"/></label><div class="full vin-actions"><button class="secondary" type="button" id="decode-vin">${icon("scan-line", 14)} Decode VIN with NHTSA</button><span id="vin-status"></span></div><label>Year<input name="year" required value="${escapeHtml(existing?.year || "")}"/></label><label>Make<input name="make" required value="${escapeHtml(existing?.make || "")}"/></label><label>Model<input name="model" required value="${escapeHtml(existing?.model || "")}"/></label><label>Trim<input name="trim" value="${escapeHtml(existing?.trim || "")}"/></label><label>Plate<input name="plate" value="${escapeHtml(existing?.plate || "")}"/></label><label>Mileage<input name="mileage" type="number" min="0" value="${existing?.mileage || ""}"/></label><label>Next service date<input name="nextServiceDate" type="date" value="${existing?.nextServiceDate || ""}"/></label><label class="full">Notes<textarea name="notes">${escapeHtml(existing?.notes || "")}</textarea></label><label class="full">Vehicle photos<input name="photos" type="file" accept="image/*" multiple/></label>${(existing?.photoKeys || []).length ? `<div class="full vehicle-photo-thumbs">${existing.photoKeys.map(key => `<img src="${cloudflareConfig.apiUrl}/files/${encodeURIComponent(key)}" alt="Vehicle photo" class="vehicle-thumb"/>`).join("")}</div>` : ""}</div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Save vehicle</button></div></form>`); const form = document.querySelector("#vehicle-form"); document.querySelector("#decode-vin").onclick = async () => { const vin = form.elements.vin.value.trim().toUpperCase(), s = document.querySelector("#vin-status"); s.textContent = "Looking up vehicle..."; try { const data = await apiFetch(`/vehicles/decode/${encodeURIComponent(vin)}`);["year", "make", "model", "trim"].forEach(key => form.elements[key].value = data[key] || ""); s.textContent = `${data.cached ? "Cached" : "NHTSA"} vehicle data loaded` } catch { s.textContent = "VIN could not be decoded" } }; form.onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)), files = form.elements.photos.files, photoKeys = [...(existing?.photoKeys || [])]; const button = form.querySelector("button[type=submit]"); button.disabled = true; try { for (const file of files) { const key = await uploadFileToR2(file, "vehicle-photo", file.type); photoKeys.push(key) } await saveShopEntity("vehicles", { id: existing?.id || `vehicle-${Date.now()}`, ...data, vin: data.vin.trim().toUpperCase(), photoKeys, createdAt: existing?.createdAt || now(), updatedAt: existing ? now() : undefined }); closeModal(); toast("Vehicle saved"); render() } catch (error) { toast("Could not save vehicle"); button.disabled = false } } }
function openInspectionTemplateForm(existing = null) { const items = existing?.items || inspectionPoints.map(name => ({ name })); showModal(`<form class="modal wide" id="template-form"><div class="modal-head"><h2>${existing ? "Edit" : "New"} inspection template</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label class="full">Template name<input name="name" required value="${escapeHtml(existing?.name || "")}" placeholder="e.g. Pre-purchase inspection"/></label></div><h3>Checklist items</h3><div id="template-items">${items.map((item, i) => `<div class="template-item-row"><input name="item-${i}" value="${escapeHtml(item.name)}" required/><button type="button" class="icon-button remove-template-item" title="Remove">${icon("trash-2", 13)}</button></div>`).join("")}</div><div class="ops-actions"><button type="button" class="secondary" id="add-template-item">${icon("plus", 14)} Add item</button></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("save", 14)} Save template</button></div></form>`); let itemCount = items.length; const bindTemplateRows = () => { document.querySelectorAll(".remove-template-item").forEach(btn => btn.onclick = () => { btn.closest(".template-item-row").remove() }) }; bindTemplateRows(); document.querySelector("#add-template-item").onclick = () => { document.querySelector("#template-items").insertAdjacentHTML("beforeend", `<div class="template-item-row"><input name="item-${itemCount++}" required placeholder="Inspection point"/><button type="button" class="icon-button remove-template-item" title="Remove">${icon("trash-2", 13)}</button></div>`); lucide.createIcons(); bindTemplateRows() }; document.querySelector("#template-form").onsubmit = async event => { event.preventDefault(); const form = event.target, name = form.elements.name.value.trim(), templateItems = [...form.querySelectorAll("#template-items input")].map(input => ({ name: input.value.trim() })).filter(item => item.name); if (!templateItems.length) { toast("Add at least one inspection point"); return } const record = { ...(existing || {}), id: existing?.id || `template-${Date.now()}`, name, items: templateItems, updatedAt: existing ? now() : undefined, createdAt: existing?.createdAt || now() }; await saveShopEntity("inspectiontemplates", record); closeModal(); toast(`Template "${name}" saved`); render() } }
function openManageTemplates() { const rows = state.inspectionTemplates.map(tpl => `<tr><td><b>${escapeHtml(tpl.name)}</b></td><td>${(tpl.items || []).length} points</td><td><button class="mini-action" data-tpl-edit="${tpl.id}">${icon("pencil", 13)} Edit</button></td></tr>`).join(""); showModal(`<div class="modal"><div class="modal-head"><h2>Inspection templates</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><table class="mini-table"><thead><tr><th>Template</th><th>Points</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="3">No saved templates. The default 36-point checklist is always available.</td></tr>`}</tbody></table></div><div class="modal-actions"><button type="button" class="secondary" data-close>Close</button><button class="primary" id="new-template-btn">${icon("list-plus", 14)} New template</button></div></div>`); document.querySelector("#new-template-btn")?.addEventListener("click", () => { closeModal(); openInspectionTemplateForm() }); document.querySelectorAll("[data-tpl-edit]").forEach(btn => btn.onclick = () => { closeModal(); openInspectionTemplateForm(state.inspectionTemplates.find(t => t.id === btn.dataset.tplEdit)) }) }
function inspectionApprovalHistory(inspection) { return (inspection.approvalHistory || []).map(entry => `<div class="approval-entry"><span class="badge ${entry.status === "approved" ? "paid" : entry.status === "rejected" ? "overdue" : "estimate"}">${escapeHtml(entry.status)}</span><span>${escapeHtml(entry.actorName || "Unknown")} · ${new Date(entry.timestamp).toLocaleString()}</span>${entry.note ? `<small>${escapeHtml(entry.note)}</small>` : ""}</div>`).join("") }
function printInspectionReport(inspection) { const profile = shopProfile(), counts = (inspection.items || []).reduce((t, r) => (t[r.status] = (t[r.status] || 0) + 1, t), {}), itemRows = (inspection.items || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td class="${item.status}">${item.status === "pass" ? "Pass" : item.status === "attention" ? "Attention" : item.status === "fail" ? "Fail" : "Not checked"}</td><td>${escapeHtml(item.note || "")}</td></tr>`).join(""), photoHtml = (inspection.photoKeys || []).map(key => `<img src="${cloudflareConfig.apiUrl}/files/${encodeURIComponent(key)}" style="width:120px;height:90px;object-fit:cover;border-radius:4px;border:1px solid #ddd"/>`).join(" "), damageHtml = (inspection.damageZones || []).length ? `<p><b>Damage zones:</b> ${inspection.damageZones.map(escapeHtml).join(", ")}</p>` : "", approvalHtml = (inspection.approvalHistory || []).map(entry => `<tr><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.actorName || "")}</td><td>${new Date(entry.timestamp).toLocaleString()}</td><td>${escapeHtml(entry.note || "")}</td></tr>`).join(""), win = window.open("", "_blank"); win.document.write(`<!DOCTYPE html><html><head><title>Inspection ${inspection.number}</title><style>body{font:12px/1.6 system-ui,sans-serif;max-width:900px;margin:auto;padding:20px}h1{font-size:20px}h2{font-size:16px;margin-top:18px}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{padding:5px 8px;border:1px solid #ddd;text-align:left;font-size:11px}th{background:#f5f5f5}.pass{color:#087e6a;font-weight:700}.attention{color:#e2a524;font-weight:700}.fail{color:#d64b4b;font-weight:700}.not_checked{color:#999}img{margin:4px}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(profile.shopName)}</h1><p>${escapeHtml(profile.address || "")} · ${escapeHtml(profile.phone || "")}</p><h2>Digital Inspection Report: ${escapeHtml(inspection.number)}</h2><p><b>Vehicle:</b> ${escapeHtml(inspection.vehicle)} · <b>Customer:</b> ${escapeHtml(inspection.customer)}</p><p><b>Date:</b> ${new Date(inspection.createdAt).toLocaleDateString()} · <b>Work Order:</b> ${escapeHtml(inspection.workOrderId || "Unlinked")}</p><p><b>Results:</b> ${counts.pass || 0} pass · ${counts.attention || 0} attention · ${counts.fail || 0} fail</p>${damageHtml}<table><thead><tr><th>Item</th><th>Status</th><th>Notes</th></tr></thead><tbody>${itemRows}</tbody></table>${inspection.recommendations ? `<h2>Recommendations</h2><p>${escapeHtml(inspection.recommendations)}</p>` : ""} ${photoHtml ? `<h2>Photos</h2><div>${photoHtml}</div>` : ""} ${approvalHtml ? `<h2>Approval History</h2><table><thead><tr><th>Decision</th><th>By</th><th>Date</th><th>Note</th></tr></thead><tbody>${approvalHtml}</tbody></table>` : ""}<p style="margin-top:18px;color:#999">Generated ${new Date().toLocaleString()}</p><button onclick="window.print()">Print</button></body></html>`); win.document.close() }
function shareInspectionReport(inspection) { const counts = (inspection.items || []).reduce((t, r) => (t[r.status] = (t[r.status] || 0) + 1, t), {}), text = `Inspection ${inspection.number} · ${inspection.vehicle} · ${inspection.customer}\nResults: ${counts.pass || 0} pass, ${counts.attention || 0} attention, ${counts.fail || 0} fail\n${inspection.recommendations ? `Recommendations: ${inspection.recommendations}\n` : ""}Date: ${new Date(inspection.createdAt).toLocaleDateString()}`; if (navigator.share) { navigator.share({ title: `Inspection ${inspection.number}`, text }).catch(() => { }) } else { navigator.clipboard.writeText(text).then(() => toast("Report copied to clipboard")).catch(() => toast("Could not copy report")) } }
function openInspectionApproval(inspection) { showModal(`<form class="modal" id="approval-form"><div class="modal-head"><h2>Inspection approval</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${escapeHtml(inspection.number)} · ${escapeHtml(inspection.vehicle)}</span><strong>${escapeHtml(inspection.customer)}</strong></div><label>Decision<select name="status" required><option value="approved">Approve</option><option value="rejected">Reject</option></select></label><label>Note<textarea name="note" placeholder="Optional approval note"></textarea></label>${inspectionApprovalHistory(inspection) ? `<h3>History</h3>${inspectionApprovalHistory(inspection)}` : ""}</div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("check", 14)} Submit decision</button></div></form>`); document.querySelector("#approval-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); inspection.approvalStatus = data.status; inspection.approvalHistory ??= []; inspection.approvalHistory.push({ status: data.status, actorId: currentUser().id, actorName: currentUser().name, timestamp: now(), note: data.note.trim() }); inspection.updatedAt = now(); await saveShopEntity("inspections", inspection); closeModal(); toast(`Inspection ${data.status}`); render() } }
function openInspectionForm(existing = null) { const vehicleOptions = state.vehicles.map(vehicle => `<option value="${escapeHtml(vehicle.id)}" ${existing?.vehicleId === vehicle.id ? "selected" : ""}>${escapeHtml(vehicle.customer)} · ${escapeHtml(vehicleLabel(vehicle))}</option>`).join(""), templateOptions = `<option value="default">Default ${inspectionPoints.length}-point checklist</option>${state.inspectionTemplates.map(tpl => `<option value="${escapeHtml(tpl.id)}">${escapeHtml(tpl.name)} (${(tpl.items || []).length} points)</option>`).join("")}`, items = existing?.items || inspectionPoints.map(name => ({ name, status: "not_checked", note: "" })), zones = ["Front", "Rear", "Driver side", "Passenger side", "Roof", "Glass"], damage = new Set(existing?.damageZones || []), existingPhotos = (existing?.photoKeys || []).map(key => `<img src="${cloudflareConfig.apiUrl}/files/${encodeURIComponent(key)}" alt="Inspection photo" class="vehicle-thumb"/>`).join(""); showModal(`<form class="modal wide" id="inspection-form"><div class="modal-head"><h2>${existing ? "Edit" : "New"} digital inspection</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Vehicle<select name="vehicleId" required>${vehicleOptions}</select></label><label>Work order<select name="workOrderId"><option value="">Unlinked</option>${state.orders.map(order => `<option ${existing?.workOrderId === order.id ? "selected" : ""}>${order.id}</option>`).join("")}</select></label>${!existing ? `<label>Template<select name="templateId" id="template-picker">${templateOptions}</select></label>` : ""}</div><h3>Damage diagram</h3><div class="damage-zones">${zones.map(zone => `<button type="button" class="damage-zone ${damage.has(zone) ? "marked" : ""}" data-damage-zone="${zone}">${icon(damage.has(zone) ? "alert-triangle" : "check", 13)} ${zone}</button>`).join("")}</div><h3 id="checklist-heading">${items.length}-point checklist</h3><div class="inspection-grid" id="inspection-checklist">${items.map((item, index) => `<article><b>${escapeHtml(item.name)}</b><select name="status-${index}"><option value="not_checked" ${item.status === "not_checked" ? "selected" : ""}>Not checked</option><option value="pass" ${item.status === "pass" ? "selected" : ""}>Pass</option><option value="attention" ${item.status === "attention" ? "selected" : ""}>Needs attention</option><option value="fail" ${item.status === "fail" ? "selected" : ""}>Fail</option></select><input name="note-${index}" value="${escapeHtml(item.note || "")}" placeholder="Reading or note"/></article>`).join("")}</div><label>Inspection photos<input name="photos" type="file" accept="image/*" multiple/></label>${existingPhotos ? `<div class="vehicle-photo-thumbs">${existingPhotos}</div>` : ""}<label>Recommendations<textarea name="recommendations">${escapeHtml(existing?.recommendations || "")}</textarea></label>${existing ? `<div class="inspection-report-actions"><button type="button" class="secondary" id="print-inspection">${icon("printer", 14)} Print report</button><button type="button" class="secondary" id="share-inspection">${icon("share-2", 14)} Share report</button><button type="button" class="secondary" id="approve-inspection">${icon("shield-check", 14)} Approval</button></div>${inspectionApprovalHistory(existing) ? `<h3>Approval history</h3>${inspectionApprovalHistory(existing)}` : ""}` : ""}</div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("save", 14)} Save inspection</button></div></form>`); document.querySelectorAll("[data-damage-zone]").forEach(button => { button.onclick = () => { button.classList.toggle("marked"); const ic = button.querySelector("[data-lucide]"); if (ic) { ic.setAttribute("data-lucide", button.classList.contains("marked") ? "alert-triangle" : "check"); lucide.createIcons() } } }); document.querySelector("#template-picker")?.addEventListener("change", event => { const value = event.target.value, grid = document.querySelector("#inspection-checklist"), heading = document.querySelector("#checklist-heading"); let newItems; if (value === "default") { newItems = inspectionPoints.map(name => ({ name, status: "not_checked", note: "" })) } else { const tpl = state.inspectionTemplates.find(t => t.id === value); newItems = (tpl?.items || []).map(item => ({ name: item.name, status: "not_checked", note: "" })) } heading.textContent = `${newItems.length}-point checklist`; grid.innerHTML = newItems.map((item, index) => `<article><b>${escapeHtml(item.name)}</b><select name="status-${index}"><option value="not_checked" selected>Not checked</option><option value="pass">Pass</option><option value="attention">Needs attention</option><option value="fail">Fail</option></select><input name="note-${index}" placeholder="Reading or note"/></article>`).join("") }); document.querySelector("#print-inspection")?.addEventListener("click", () => printInspectionReport(existing)); document.querySelector("#share-inspection")?.addEventListener("click", () => shareInspectionReport(existing)); document.querySelector("#approve-inspection")?.addEventListener("click", () => { closeModal(); openInspectionApproval(existing) }); document.querySelector("#inspection-form").onsubmit = async event => { event.preventDefault(); const form = event.target, submitBtn = form.querySelector("button[type=submit],button.primary:last-child"); submitBtn.disabled = true; try { const vehicle = state.vehicles.find(item => item.id === form.elements.vehicleId.value), files = [...form.elements.photos.files], photoKeys = []; for (const file of files) photoKeys.push(await uploadFileToR2(file, "inspection", file.type || "image/jpeg")); const checklist = [...form.querySelectorAll("#inspection-checklist article")].map((article, index) => ({ name: article.querySelector("b").textContent, status: form.elements[`status-${index}`].value, note: (form.elements[`note-${index}`]?.value || "").trim() })), record = { ...(existing || {}), id: existing?.id || `inspection-${Date.now()}`, number: existing?.number || `INSP-${String(state.inspections.length + 1).padStart(4, "0")}`, vehicleId: vehicle.id, vehicle: vehicleLabel(vehicle), customer: vehicle.customer, workOrderId: form.elements.workOrderId.value, items: checklist, damageZones: [...form.querySelectorAll(".damage-zone.marked")].map(button => button.dataset.damageZone), photoKeys: [...(existing?.photoKeys || []), ...photoKeys], recommendations: form.elements.recommendations.value.trim(), createdAt: existing?.createdAt || now(), updatedAt: existing ? now() : undefined }; await saveShopEntity("inspections", record); closeModal(); toast("Digital inspection saved"); render() } catch (error) { toast("Could not save inspection. Please try again."); submitBtn.disabled = false } } }
function simpleRecordModal(kind, title, fields, build) { showModal(`<form class="modal" id="simple-record-form"><div class="modal-head"><h2>${title}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid">${fields}</div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Save</button></div></form>`); document.querySelector("#simple-record-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), record = build(data); await saveShopEntity(kind, record); closeModal(); toast(`${title} saved`); render() } }
function addInventory() { simpleRecordModal("inventory", "Inventory item", `<label>Name<input name="name" required/></label><label>SKU<input name="sku" required/></label><label>Type<select name="kind"><option>Part</option><option>Tire</option><option>Supply</option><option>Asset</option></select></label><label>Vendor<select name="vendor"><option value="">Unassigned</option>${state.vendors.map(v => `<option>${escapeHtml(v.name)}</option>`).join("")}</select></label><label>Quantity<input name="quantity" type="number" min="0" value="0"/></label><label>Reorder level<input name="reorderLevel" type="number" min="0" value="0"/></label><label>Unit cost<input name="cost" type="number" min="0" step=".01"/></label><label>Selling price<input name="price" type="number" min="0" step=".01"/></label>`, data => ({ id: `inventory-${Date.now()}`, ...data, quantity: Number(data.quantity), reorderLevel: Number(data.reorderLevel), cost: Number(data.cost), price: Number(data.price), unit: "ea", createdAt: now() })) }
function addVendor() { simpleRecordModal("vendors", "Vendor", `<label>Name<input name="name" required/></label><label>Phone<input name="phone"/></label><label>Email<input name="email" type="email"/></label><label>Account number<input name="accountNumber"/></label><label class="full">Address<input name="address"/></label>`, data => ({ id: `vendor-${Date.now()}`, ...data, createdAt: now() })) }
function openServiceForm(existing = null) { const price = existing ? Number(existing.menuPrice ?? existing.partsPrice ?? 0).toFixed(2) : "", channel = existing?.channel === "van" ? "van" : "shop"; showModal(`<form class="modal" id="service-form"><div class="modal-head"><h2>${existing ? "Edit" : "Add"} canned service</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label class="full">Name *<input name="name" required value="${escapeAttr(existing?.name || "")}"/></label><label>Where<select name="channel"><option value="van" ${channel === "van" ? "selected" : ""}>Van</option><option value="shop" ${channel === "shop" ? "selected" : ""}>Shop</option></select></label><label>Menu price *<input name="menuPrice" type="number" min="0" step=".01" required value="${price}"/></label><label>Default discount %<input name="discount" type="number" min="0" max="100" step=".1" value="${Number(existing?.discount || 0)}"/></label><label class="full">What the customer gets<textarea name="description">${escapeHtml(existing?.description || "")}</textarea></label><label class="full">Shop note<textarea name="marginNote" placeholder="Internal only. This does not print on the estimate.">${escapeHtml(existing?.marginNote || "")}</textarea></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} Save service</button></div></form>`); document.querySelector("#service-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), menuPrice = Math.round(Math.max(0, Number(data.menuPrice) || 0) * 100) / 100, record = { ...(existing || {}), id: existing?.id || `service-${Date.now()}`, name: String(data.name || "").trim(), channel: data.channel === "van" ? "van" : "shop", menuPrice, partsPrice: menuPrice, laborHours: 0, discount: Math.min(100, Math.max(0, Number(data.discount) || 0)), description: String(data.description || "").trim(), marginNote: String(data.marginNote || "").trim(), catalog: existing?.catalog === true, sort: existing?.sort ?? 1000, createdAt: existing?.createdAt || now(), updatedAt: existing ? (existing.updatedAt || now()) : undefined }; try { await saveShopEntity("services", record); closeModal(); toast(`${record.name} saved`); render() } catch (error) { toast(error.message || "Could not save this service") } } }
function addService() { openServiceForm() }
async function ensureCannedMenu() {
  const role = currentUser()?.role;
  if (!["owner", "admin", "office", "service_writer"].includes(role)) return;
  const profile = shopProfile();
  const seeded = Array.isArray(profile.cannedMenuSeededIds) ? profile.cannedMenuSeededIds : [];
  const catalogIds = CANNED_MENU.map(item => item.id);
  const missing = missingCannedServices(state.services, seeded);
  if (!missing.length && catalogIds.every(id => seeded.includes(id))) return;
  const onServer = new Set(state.services.map(row => row.id));
  const confirmed = new Set(seeded.filter(id => onServer.has(id)));
  for (const item of CANNED_MENU) if (onServer.has(item.id)) confirmed.add(item.id);
  const createdAt = now();
  for (const item of missing) {
    const record = { ...item, createdAt };
    try {
      const saved = await apiFetch("/entities/services", { method: "POST", body: JSON.stringify(record), silent: true });
      const value = saved?.queued ? record : saved;
      const index = state.services.findIndex(row => row.id === value.id);
      if (index >= 0) state.services[index] = value; else state.services.push(value);
      if (saved && !saved.queued) confirmed.add(item.id);
    } catch (error) {
      console.error("Canned menu item was kept on this device", error);
      if (!state.services.some(row => row.id === record.id)) state.services.push(record);
    }
  }
  save();
  if (confirmed.size <= seeded.length) return;
  try { await saveProfilePatch({ cannedMenuSeededIds: [...confirmed] }) } catch (error) { console.error("Canned menu marker was not saved", error) }
}
function reminderDate(days = 7) { const date = new Date(); date.setDate(date.getDate() + days); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-") }
function openReminderForm(existing = null, parent = null) { const source = existing || parent, defaultDate = parent ? reminderDate(7) : ""; showModal(`<form class="modal" id="reminder-form"><div class="modal-head"><h2>${existing ? "Edit" : "Add"} service reminder</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Customer<select name="customer">${customerOptions(source?.customer)}</select></label><label>Vehicle<input name="vehicle" required value="${escapeHtml(source?.vehicle || "")}"/></label><label>Service<input name="service" required value="${escapeHtml(source?.service || "")}"/></label><label>Due date<input name="dueDate" type="date" required value="${existing?.dueDate || defaultDate}"/></label><label>Due mileage<input name="dueMileage" type="number" min="0" value="${existing?.dueMileage || ""}"/></label><label>Channel<select name="channel"><option value="sms" ${source?.channel !== "email" ? "selected" : ""}>Text</option><option value="email" ${source?.channel === "email" ? "selected" : ""}>Email</option></select></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Save reminder</button></div></form>`); document.querySelector("#reminder-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), record = { ...(existing || {}), id: existing?.id || `reminder-${Date.now()}`, ...data, dueMileage: Number(data.dueMileage) || null, createdAt: existing?.createdAt || now(), parentReminderId: existing?.parentReminderId || parent?.id || undefined, updatedAt: existing ? now() : undefined }; await saveShopEntity("reminders", record); closeModal(); toast(parent ? "Follow-up reminder saved" : "Service reminder saved"); render() } }
function addReminder() { openReminderForm() }
async function receiveStock(id) { const item = state.inventory.find(row => row.id === id), quantity = Number(prompt(`Quantity received for ${item.name}:`, "1")); if (!Number.isFinite(quantity) || quantity <= 0) return; item.quantity = Number(item.quantity || 0) + quantity; item.lastReceivedAt = now(); await saveShopEntity("inventory", item); await saveShopEntity("purchases", { id: `purchase-${Date.now()}`, inventoryId: id, vendor: item.vendor, quantity, unitCost: Number(item.cost || 0), total: quantity * Number(item.cost || 0), receivedAt: now() }); toast(`${quantity} ${item.name} received`); render() }
async function sendReminder(id) { const reminder = state.reminders.find(item => item.id === id), customer = state.customers.find(item => item.name === reminder.customer); if (!customer) return toast("Customer contact information is missing"); const body = `${state.messagingSettings.shopName || "Your Car Guy"}: ${reminder.service} is due for ${reminder.vehicle}${reminder.dueDate ? ` on ${reminder.dueDate}` : ""}. Contact us to schedule service.`, channel = reminder.channel || "sms"; await deliverShopMessage({ channel, to: channel === "email" ? customer.email : customer.phone, subject: "Vehicle service reminder", body, metadata: { type: "service-reminder", reminderId: id } }); reminder.sentAt = now(); reminder.updatedAt = now(); await saveShopEntity("reminders", reminder); toast("Service reminder prepared"); render() }
function elmLineBytes(line, command = "") { let value = String(line || "").toUpperCase().trim(); if (!value || value.replace(/\s/g, "") === String(command).toUpperCase().replace(/\s/g, "") || /^(SEARCHING|BUS INIT|STOPPED|OK\b|ELM327)/.test(value)) return []; value = value.replace(/^\s*\d+\s*:\s*/, ""); let header = false; if (/^(?:[67][0-9A-F]{2}|18[0-9A-F]{6})[0-9A-F]{4,}$/.test(value.replace(/\s/g, ""))) { const compact = value.replace(/\s/g, ""); value = compact.slice(compact.startsWith("18") ? 8 : 3); header = true } let parts = value.match(/[0-9A-F]+/g) || []; if (!header && (parts[0]?.length === 3 || parts[0]?.length === 8)) { parts.shift(); header = true } if (parts.length === 1 && parts[0].length % 2 === 0) parts = parts[0].match(/../g) || []; else parts = parts.flatMap(part => part.length === 2 ? [part] : part.length % 2 === 0 ? (part.match(/../g) || []) : []); let bytes = parts.map(part => parseInt(part, 16)).filter(Number.isFinite); if (header && bytes.length && bytes[0] <= 0x0f) bytes.shift(); if (bytes[0] >= 0x10 && bytes[0] <= 0x1f) bytes = bytes.slice(2); else if (bytes[0] >= 0x20 && bytes[0] <= 0x2f) bytes = bytes.slice(1); else if (bytes[0] <= 0x0f && bytes[0] === bytes.length - 1) bytes = bytes.slice(1); return bytes }
function normalizeElmResponse(raw, command = "") { const text = String(raw ?? "").trim(), upper = text.toUpperCase(), noData = /\bNO\s*DATA\b/.test(upper), adapterError = (upper.match(/\b(?:UNABLE TO CONNECT|BUS ERROR|CAN ERROR|BUFFER FULL|ERROR)\b/) || [])[0] || "", lines = text.replace(/>/g, "\n").split(/[\r\n]+/), frames = lines.map(line => elmLineBytes(line, command)).filter(frame => frame.length), bytes = frames.flat(); return { raw: text, noData, adapterError, frames, bytes } }
function findElmReply(bytes, mode, pid) { for (let index = 0; index < bytes.length; index++) { if (bytes[index] === mode && (pid === undefined || bytes[index + 1] === pid)) return bytes.slice(index + (pid === undefined ? 1 : 2)) } return null }
function parseElmPid(raw, pid) { const normalized = normalizeElmResponse(raw, `01${pid.toString(16).padStart(2, "0")}`.toUpperCase()); if (normalized.noData) return { ...normalized, status: "no-data" }; if (normalized.adapterError) return { ...normalized, status: "error" }; const data = findElmReply(normalized.bytes, 0x41, pid), needed = pid === 0x0c ? 2 : 1; if (!data || data.length < needed) return { ...normalized, status: "malformed" }; if (pid === 0x0c) return { ...normalized, status: "ok", pid, rpm: (data[0] * 256 + data[1]) / 4 }; if (pid === 0x0d) return { ...normalized, status: "ok", pid, kmh: data[0], mph: data[0] * 0.621371 }; if (pid === 0x05) { const celsius = data[0] - 40; return { ...normalized, status: "ok", pid, celsius, fahrenheit: celsius * 9 / 5 + 32 } } return { ...normalized, status: "unsupported" } }
function dtcFromBytes(first, second) { const systems = ["P", "C", "B", "U"], system = systems[(first & 0xc0) >> 6], digit = (first & 0x30) >> 4; return `${system}${digit}${(first & 0x0f).toString(16).toUpperCase()}${second.toString(16).padStart(2, "0").toUpperCase()}` }
function parseElmDtcs(raw) { const normalized = normalizeElmResponse(raw, "03"); if (normalized.noData) return { ...normalized, status: "no-data", codes: [] }; if (normalized.adapterError) return { ...normalized, status: "error", codes: [] }; const replies = []; let current = null; for (const frame of normalized.frames) { const marker = frame.indexOf(0x43); if (marker >= 0) { current = frame.slice(marker + 1); replies.push(current) } else if (current) current.push(...frame) } if (!replies.length) return { ...normalized, status: "malformed", codes: [] }; const codes = []; let malformed = false; for (const data of replies) { for (let index = 0; index < data.length; index += 2) { if (data[index] === 0 && data[index + 1] === 0) continue; if (data[index + 1] === undefined) { malformed = true; break } codes.push(dtcFromBytes(data[index], data[index + 1])) } } return { ...normalized, status: malformed ? "partial" : "ok", codes: [...new Set(codes)] } }
function formatElmResult(label, command, raw) { if (command === "010C") { const result = parseElmPid(raw, 0x0c); return result.status === "ok" ? `${label}: ${result.rpm.toFixed(result.rpm % 1 ? 2 : 0)} RPM` : formatElmProblem(label, result) } if (command === "010D") { const result = parseElmPid(raw, 0x0d); return result.status === "ok" ? `${label}: ${result.kmh} km/h (${result.mph.toFixed(1)} mph)` : formatElmProblem(label, result) } if (command === "0105") { const result = parseElmPid(raw, 0x05); return result.status === "ok" ? `${label}: ${result.celsius} °C (${result.fahrenheit.toFixed(1)} °F)` : formatElmProblem(label, result) } if (command === "03") { const result = parseElmDtcs(raw); if (result.status === "no-data" || result.status === "ok" && !result.codes.length) return `${label}: No stored diagnostic trouble codes reported.`; if (result.status === "ok" || result.status === "partial") return `${label}: ${result.codes.join(", ")}${result.status === "partial" ? " (response ended with an incomplete code)" : ""}`; return formatElmProblem(label, result) } return `${label}: Response received. See raw adapter response.` }
function formatElmProblem(label, result) { if (result.status === "no-data") return `${label}: No data reported by the vehicle.`; if (result.status === "error") return `${label}: Adapter reported ${result.adapterError.toLowerCase()}.`; return `${label}: Response was incomplete or malformed.` }
globalThis.mechProElm327 = { normalizeElmResponse, parseElmPid, parseElmDtcs, formatElmResult };
async function elmCommand(command) { if (!elmPort?.readable || !elmPort?.writable) throw new Error("Adapter is not connected"); const writer = elmPort.writable.getWriter(), reader = elmPort.readable.getReader(), decoder = new TextDecoder(); try { await writer.write(new TextEncoder().encode(`${command}\r`)); let output = "", done = false; while (!done && !output.includes(">")) { const pending = reader.read(), result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1800))]); if (result.timeout) { await reader.cancel(); break } done = result.done; output += decoder.decode(result.value || new Uint8Array()) } return output.trim() } finally { writer.releaseLock(); reader.releaseLock() } }
async function connectElm() { if (elmPort) { await elmPort.close(); elmPort = null; state.elmOutput = "Adapter disconnected."; save(); return render() } if (!navigator.serial) return toast("Web Serial requires desktop Chrome or Edge"); try { elmPort = await navigator.serial.requestPort(); await elmPort.open({ baudRate: 38400 }); for (const command of ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"]) await elmCommand(command); state.elmOutput = "ELM327 initialized. Vehicle ignition should be on."; save(); render() } catch (error) { elmPort = null; toast(`Adapter connection failed: ${error.message}`) } }
async function runElm(action) { try { if (action === "clear" && !confirm("Clear stored diagnostic trouble codes? This may reset readiness monitors and should only be done after repairs are verified.")) return; const commands = action === "live" ? [["RPM", "010C"], ["Speed", "010D"], ["Coolant", "0105"]] : action === "dtc" ? [["Stored DTCs", "03"]] : [["Clear response", "04"]], lines = [], rawResponses = []; for (const [label, command] of commands) { const raw = await elmCommand(command); lines.push(formatElmResult(label, command, raw)); rawResponses.push(`${command}\n${raw}`) } state.elmOutput = { friendly: `${new Date().toLocaleString()}\n${lines.join("\n")}`, raw: rawResponses.join("\n\n") }; save(); render() } catch (error) { toast(error.message) } }

async function buildEstimateFromInspectionRecord(inspection) {
  const orderId = inspection.workOrderId;
  const order = state.orders?.find(item => item.id === orderId) || {
    id: orderId || `RO-${Date.now()}`,
    customer: inspection.customer,
    vehicle: inspection.vehicle,
    status: "intake",
  };
  const next = applyEstimateFromInspection(order, inspection, {
    laborRate: Number(shopProfile()?.laborRate) || 165,
    taxRate: Number(state.taxSettings?.rate) || 0,
  }, currentUser() || { name: "Staff" });
  await saveShopEntity("orders", next);
  if (!state.orders.some(item => item.id === next.id)) state.orders.push(next);
  else state.orders = state.orders.map(item => item.id === next.id ? next : item);
  toast(`Estimate draft built from inspection (${next.estimate.lines.length} finding line(s))`);
  return next;
}
function bindShopOperations() { document.querySelector("#open-oem-programming")?.addEventListener("click", () => { state.route = "oem-diagnostics"; save(); render() }); document.querySelectorAll("[data-order-autozone]").forEach(button => { button.onclick = () => { const item = state.inventory.find(row => row.id === button.dataset.orderAutozone); void openAutozoneOrder(item?.name || "") } }); document.querySelector("#autozone-login-form")?.addEventListener("submit", async event => { event.preventDefault(); try { await saveAutozoneLogin(event.target) } catch (error) { toast(error.message || "Could not save the AutoZone Pro login") } }); document.querySelector("#autozone-disconnect")?.addEventListener("click", async () => { try { await apiFetch("/ordering/autozone", { method: "DELETE" }); autozoneAccount = { connected: false, loaded: true }; toast("AutoZone Pro login removed"); render() } catch (error) { toast(error.message || "Could not remove the AutoZone Pro login") } }); document.querySelector("#autozone-search-form")?.addEventListener("submit", event => { event.preventDefault(); void openAutozoneOrder(new FormData(event.target).get("keyword")) }); document.querySelector("#autozone-open")?.addEventListener("click", () => { void openAutozoneOrder("") }); if (shopOpsTab === "ordering") {
    void loadAutozoneAccount();
    void loadPartstechAccount();
    void loadLaborGuideAccount();
    void loadQuickbooksAccount();
  }
  document.querySelector("#partstech-connect-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(event.target));
      partstechAccount = { ...(await apiFetch("/integrations/partstech", { method: "POST", body: JSON.stringify(data) })), loaded: true };
      toast("PartsTech connected");
      render();
    } catch (error) { toast(error.message || "Could not connect PartsTech"); }
  });
  document.querySelector("#partstech-disconnect")?.addEventListener("click", async () => {
    try {
      await apiFetch("/integrations/partstech", { method: "DELETE" });
      partstechAccount = { connected: false, loaded: true };
      toast("PartsTech disconnected");
      render();
    } catch (error) { toast(error.message || "Could not disconnect PartsTech"); }
  });
  document.querySelector("#partstech-search-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const panel = document.querySelector("#partstech-results");
    if (panel) panel.innerHTML = "<p>Quoting…</p>";
    try {
      const result = await apiFetch("/integrations/partstech/quote", { method: "POST", body: JSON.stringify(data) });
      const rows = (result.items || []).map(item => `<tr><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.partNumber)}</td><td>${money(item.unitPrice)}</td><td><button type="button" class="mini-action" data-add-pt-line="${escapeAttr(item.id)}">Add</button></td></tr>`).join("");
      if (panel) panel.innerHTML = `<table><thead><tr><th>Part</th><th>#</th><th>Price</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=4>No quotes returned</td></tr>"}</tbody></table>`;
      window.__MECHPRO_PARTSTECH_LINES__ = Object.fromEntries((result.items || []).map(item => [item.id, item]));
      document.querySelectorAll("[data-add-pt-line]").forEach(button => {
        button.onclick = () => {
          const line = window.__MECHPRO_PARTSTECH_LINES__?.[button.dataset.addPtLine];
          if (!line) return;
          state.pendingEstimateLines = [...(state.pendingEstimateLines || []), line];
          toast(`Added ${line.description} to pending estimate lines`);
        };
      });
    } catch (error) {
      if (panel) panel.innerHTML = `<p class="login-error">${escapeHtml(error.message || "PartsTech quote failed")}</p>`;
      toast(error.message || "PartsTech quote failed");
    }
  });
  document.querySelector("#labor-guide-connect-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(event.target));
      laborGuideAccount = { ...(await apiFetch("/integrations/labor-guide", {
        method: "POST",
        body: JSON.stringify({ provider: data.provider, viaPartstech: data.viaPartstech === "on" }),
      })), loaded: true };
      toast("Labor guide saved");
      render();
    } catch (error) { toast(error.message || "Could not save labor guide"); }
  });
  document.querySelector("#labor-guide-disconnect")?.addEventListener("click", async () => {
    try {
      await apiFetch("/integrations/labor-guide", { method: "DELETE" });
      laborGuideAccount = { connected: false, provider: "manual", loaded: true };
      toast("MOTOR disconnected");
      render();
    } catch (error) { toast(error.message || "Could not disconnect labor guide"); }
  });
  document.querySelector("#labor-guide-search-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const panel = document.querySelector("#labor-guide-results");
    if (panel) panel.innerHTML = "<p>Looking up…</p>";
    try {
      const result = await apiFetch("/integrations/labor-guide/search", { method: "POST", body: JSON.stringify(data) });
      if (result.provider === "web_estimate") {
        if (!result.found) {
          if (panel) panel.innerHTML = `<p class="login-error"><b>no estimate found</b> — ${escapeHtml(result.message || "web estimate unavailable")}. Manual entry stays available below.</p>`;
          toast(result.message || "no estimate found");
          return;
        }
        const sources = (result.sources || []).map(source => `<li><a href="${escapeAttr(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.title || source.url)}</a></li>`).join("");
        const rows = (result.lines || []).map(line => `<tr><td>${escapeHtml(line.description)}</td><td>${line.hours}</td><td>${money(line.total)}</td><td><button type="button" class="mini-action" data-add-labor-line="${escapeAttr(line.id)}">Add</button></td></tr>`).join("");
        if (panel) panel.innerHTML = `<div class="messaging-status idle"><div><strong>web estimate — not book time</strong><span>Average ${escapeHtml(String(result.averageHours))} hrs from ${escapeHtml(String(result.sourceCount || 0))} source(s). Not ALLDATA / MOTOR / ShopKey book time.</span></div></div><table><thead><tr><th>Operation</th><th>Hours</th><th>Total</th><th></th></tr></thead><tbody>${rows}</tbody></table><ol class="ops-note">${sources}</ol>`;
      } else {
        const rows = (result.lines || []).map(line => `<tr><td>${escapeHtml(line.description)}</td><td>${line.hours}</td><td>${money(line.total)}</td><td><button type="button" class="mini-action" data-add-labor-line="${escapeAttr(line.id)}">Add</button></td></tr>`).join("");
        if (panel) panel.innerHTML = `<table><thead><tr><th>Operation</th><th>Hours</th><th>Total</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=4>No operations returned</td></tr>"}</tbody></table>`;
      }
      window.__MECHPRO_LABOR_LINES__ = Object.fromEntries((result.lines || []).map(line => [line.id, line]));
      document.querySelectorAll("[data-add-labor-line]").forEach(button => {
        button.onclick = () => {
          const line = window.__MECHPRO_LABOR_LINES__?.[button.dataset.addLaborLine];
          if (!line) return;
          state.pendingEstimateLines = [...(state.pendingEstimateLines || []), line];
          toast(`Added ${line.description}`);
        };
      });
    } catch (error) {
      if (panel) panel.innerHTML = `<p class="login-error">${escapeHtml(error.message || "Labor guide search failed")}</p>`;
      toast(error.message || "Labor guide search failed");
    }
  });
  document.querySelector("#manual-labor-form")?.addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const line = createManualLaborEntry({
      description: data.description,
      hours: data.hours,
      laborRate: data.laborRate,
    });
    state.pendingEstimateLines = [...(state.pendingEstimateLines || []), line];
    toast(`Added manual labor: ${line.description}`);
  });
  document.querySelector("#qbo-connect")?.addEventListener("click", async () => {
    try {
      const redirectUri = `${location.origin}/qbo/callback`;
      const result = await apiFetch("/integrations/quickbooks/connect", {
        method: "POST",
        body: JSON.stringify({ redirectUri }),
      });
      if (result.authorizeUrl) location.href = result.authorizeUrl;
      else toast("QuickBooks authorize URL missing");
    } catch (error) { toast(error.message || "Could not start QuickBooks connect"); }
  });
  document.querySelector("#qbo-disconnect")?.addEventListener("click", async () => {
    try {
      await apiFetch("/integrations/quickbooks", { method: "DELETE" });
      quickbooksAccount = { connected: false, loaded: true };
      toast("QuickBooks disconnected");
      render();
    } catch (error) { toast(error.message || "Could not disconnect QuickBooks"); }
  });
  document.querySelector("#qbo-sync-now")?.addEventListener("click", async () => {
    const status = document.querySelector("#qbo-sync-status");
    if (status) status.textContent = "Sync uses per-record POST /integrations/quickbooks/sync from invoices and customers.";
    toast("Open a customer or invoice and sync from there, or call the sync API with entityType/localId");
  });
 document.querySelectorAll("[data-ops-tab]").forEach(button => button.onclick = () => { shopOpsTab = button.dataset.opsTab; render() }); document.querySelector("#add-vehicle")?.addEventListener("click", () => openVehicleForm()); document.querySelector("#add-inspection")?.addEventListener("click", () => openInspectionForm()); document.querySelectorAll("[data-start-inspection]").forEach(button => button.onclick = () => openCatalogInspection(null, button.dataset.startInspection)); document.querySelector("#manage-templates")?.addEventListener("click", openManageTemplates); document.querySelectorAll("[data-edit-inspection]").forEach(button => button.onclick = () => { const inspection = state.inspections.find(item => item.id === button.dataset.editInspection); if (inspection?.catalogId) openCatalogInspection(inspection); else openInspectionForm(inspection) });
  document.querySelectorAll("[data-estimate-from-inspection]").forEach(button => button.onclick = async event => {
    event.stopPropagation();
    const inspection = state.inspections.find(item => item.id === button.dataset.estimateFromInspection);
    if (!inspection) return toast("Inspection not found");
    try { await buildEstimateFromInspectionRecord(inspection); render(); }
    catch (error) { toast(error.message || "Could not build estimate from inspection"); }
  }); document.querySelectorAll("[data-edit-template]").forEach(button => button.onclick = () => openInspectionTemplateForm(state.inspectionTemplates.find(t => t.id === button.dataset.editTemplate))); document.querySelectorAll("[data-edit-vehicle]").forEach(row => row.onclick = () => openVehicleDetail(row.dataset.editVehicle)); document.querySelector("#add-inventory")?.addEventListener("click", addInventory); document.querySelector("#add-vendor")?.addEventListener("click", addVendor); document.querySelector("#add-service")?.addEventListener("click", addService); document.querySelectorAll("[data-edit-service]").forEach(button => button.onclick = event => { event.stopPropagation(); openServiceForm(state.services.find(item => item.id === button.dataset.editService)) }); document.querySelector("#add-reminder")?.addEventListener("click", addReminder); document.querySelectorAll("[data-reminder-filter]").forEach(button => button.onclick = () => { reminderFilter = button.dataset.reminderFilter; render() }); document.querySelectorAll("[data-edit-reminder]").forEach(row => row.onclick = () => openReminderForm(state.reminders.find(item => item.id === row.dataset.editReminder))); document.querySelectorAll("[data-edit-reminder-button]").forEach(button => button.onclick = event => { event.stopPropagation(); openReminderForm(state.reminders.find(item => item.id === button.dataset.editReminderButton)) }); document.querySelectorAll("[data-follow-up-reminder]").forEach(button => button.onclick = event => { event.stopPropagation(); openReminderForm(null, state.reminders.find(item => item.id === button.dataset.followUpReminder)) }); document.querySelectorAll("[data-receive-stock]").forEach(button => button.onclick = () => receiveStock(button.dataset.receiveStock)); document.querySelectorAll("[data-send-reminder]").forEach(button => button.onclick = event => { event.stopPropagation(); sendReminder(button.dataset.sendReminder) }); document.querySelector("#elm-connect")?.addEventListener("click", connectElm); document.querySelectorAll("[data-elm-command]").forEach(button => button.onclick = () => runElm(button.dataset.elmCommand)) }
function openCustomerMessage(name, phone, email) { showModal(`<form class="modal" id="customer-message-form"><div class="modal-head"><h2>Message ${name}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${phone || "No phone"} · ${email || "No email"}</span><strong>Your Car Guy</strong></div><label>Delivery method<select name="channel"><option value="sms" ${phone ? "" : "disabled"}>Text message</option><option value="email" ${email ? "" : "disabled"}>Email</option></select></label><label>Subject<input name="subject" value="Update from Your Car Guy"/></label><label>Message *<textarea name="message" required>Hello ${name}, this is Your Car Guy with an update regarding your vehicle.</textarea></label><p class="ai-disclaimer">This opens the device's configured messaging or email app. The app does not transmit messages through an outside service.</p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("send", 14)} Open device app</button></div></form>`); document.querySelector("#customer-message-form").onsubmit = event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), body = encodeURIComponent(data.message); if (data.channel === "email") { window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(data.subject)}&body=${body}` } else { window.location.href = `sms:${String(phone).replace(/[^0-9+]/g, "")}?body=${body}` } state.messageLog ??= []; state.messageLog.push({ id: `message-${Date.now()}`, customer: name, channel: data.channel, subject: data.subject, body: data.message, createdAt: now() }); save(); toast(`Opened ${data.channel === "email" ? "email" : "messaging"} app for ${name}`); closeModal() } }
let financeDerivedCache=null;
function getFinanceDerived(){const key=[state.invoices.length,state.payments.length,state.invoices.at(-1)?.number||"",state.payments.at(-1)?.id||state.payments.at(-1)?.invoiceNumber||""].join("|");if(financeDerivedCache?.key===key)return financeDerivedCache;const completedPaidByInvoice=new Map();for(const payment of state.payments){if(payment.status!=="completed")continue;const number=String(payment.invoiceNumber||"");if(!number)continue;completedPaidByInvoice.set(number,(completedPaidByInvoice.get(number)||0)+Number(payment.amount||0))}const invoiceByNumber=new Map();const balanceByCustomer=new Map();for(const invoice of state.invoices){invoiceByNumber.set(invoice.number,invoice);const paid=completedPaidByInvoice.get(invoice.number)||0;const effectivePaid=paid||((invoice.status==="paid")?Number(invoice.amount||0):0);const balance=Math.max(0,Math.round((Number(invoice.amount||0)-effectivePaid)*100)/100);balanceByCustomer.set(invoice.customer,(balanceByCustomer.get(invoice.customer)||0)+balance)}financeDerivedCache={key,completedPaidByInvoice,invoiceByNumber,balanceByCustomer};return financeDerivedCache}
function invoicePaid(invoice) { const recorded = getFinanceDerived().completedPaidByInvoice.get(invoice.number) || 0; return recorded || (invoice.status === "paid" ? invoice.amount : 0) }
function invoiceBalance(invoice) { return Math.max(0, Math.round((invoice.amount - invoicePaid(invoice)) * 100) / 100) }
function invoiceTaxBreakdown(invoice) { if (!invoice) return { subtotal: 0, tax: 0, taxRate: state.taxSettings.rate }; if (typeof invoice.tax === "number" && typeof invoice.subtotal === "number") return { subtotal: invoice.subtotal, tax: invoice.tax, taxRate: invoice.taxRate ?? state.taxSettings.rate }; const rate = state.taxSettings.rate, subtotal = Math.round((invoice.amount / (1 + rate / 100)) * 100) / 100, tax = Math.round((invoice.amount - subtotal) * 100) / 100; return { subtotal, tax, taxRate: rate } }
function openInvoiceTax(number) { const invoice = state.invoices.find(item => item.number === number); if (!invoice) return; if (invoicePaid(invoice) > 0) { toast("Tax cannot be edited after payments have been recorded on this invoice"); return } const bd = invoiceTaxBreakdown(invoice); showModal(`<form class="modal" id="tax-form"><div class="modal-head"><h2>Invoice tax</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${invoice.number} · ${escapeHtml(invoice.customer)}</span><strong>${money(invoice.amount)}</strong></div><div class="form-grid"><label>Taxable subtotal *<input name="subtotal" type="number" step=".01" min="0" value="${bd.subtotal}" required/></label><label>Tax rate % *<input name="taxRate" type="number" step=".01" min="0" value="${bd.taxRate}" required/></label></div><div class="ledger-note">${icon("landmark", 15)} Tax is calculated on the taxable subtotal at the entered rate and posted to Sales Tax Payable when collected.</div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("check", 14)} Save tax</button></div></form>`); document.querySelector("#tax-form").onsubmit = event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), subtotal = Number(data.subtotal), taxRate = Number(data.taxRate); if (!Number.isFinite(subtotal) || subtotal < 0 || !Number.isFinite(taxRate) || taxRate < 0) { toast("Enter a valid subtotal and tax rate"); return } const tax = Math.round(subtotal * taxRate / 100 * 100) / 100; invoice.subtotal = subtotal; invoice.taxRate = taxRate; invoice.tax = tax; invoice.amount = Math.round((subtotal + tax) * 100) / 100; updateInvoiceInApi(invoice); save(); closeModal(); toast(`${invoice.number} tax updated`); render() } }
function taxReport(fromDate, toDate) { const from = new Date(fromDate), to = new Date(toDate), invoices = getFinanceDerived().invoiceByNumber; to.setHours(23, 59, 59, 999); const rows = paymentRecords().filter(payment => { const d = new Date(payment.receivedAt); return d >= from && d <= to }).map(payment => { const invoice = invoices.get(payment.invoiceNumber), bd = invoiceTaxBreakdown(invoice), ratio = invoice ? payment.amount / (invoice.amount || payment.amount) : 0; return { date: payment.receivedAt, invoiceNumber: payment.invoiceNumber, customer: payment.customer, gross: payment.amount, taxable: Math.round(bd.subtotal * ratio * 100) / 100, tax: Math.round(bd.tax * ratio * 100) / 100 } }).sort((a, b) => String(a.date).localeCompare(String(b.date))); const totals = rows.reduce((acc, row) => ({ gross: acc.gross + row.gross, taxable: acc.taxable + row.taxable, tax: acc.tax + row.tax }), { gross: 0, taxable: 0, tax: 0 }); return { from: fromDate, to: toDate, rows, totals } }
function invoices() { const q = query.toLowerCase(), rows = state.invoices.filter(x => !q || Object.values(x).join(" ").toLowerCase().includes(q)).map(x => { const paid = invoicePaid(x), balance = invoiceBalance(x), bd = invoiceTaxBreakdown(x); return `<tr><td class="mono"><b>${x.number}</b></td><td class="mono">${x.ro}</td><td><b>${x.customer}</b></td><td>${x.date}</td><td>${x.due}</td><td>${balance === 0 ? `<span class="badge paid">Paid</span>` : badge(x.status)}</td><td><b>${money(x.amount)}</b><small>Subtotal ${money(bd.subtotal)} · Tax ${money(bd.tax)} (${bd.taxRate}%)</small><small>Paid ${money(paid)} · Balance ${money(balance)}</small><div class="invoice-payments">${balance > 0 ? `<button class="mini-action" data-record-payment="${x.number}" data-method="cash">${icon("banknote", 13)} Cash</button><button class="mini-action" data-record-payment="${x.number}" data-method="processor">${icon("credit-card", 13)} Card receipt</button><button class="mini-action invoice-pay" data-pay-invoice="${x.number}">${icon("external-link", 13)} Pay online</button><button class="mini-action" data-text-pay="${x.number}">${icon("message-square", 13)} Text to pay</button>` : ""}${paid === 0 ? `<button class="mini-action" data-edit-tax="${x.number}">${icon("percent", 13)} Edit tax</button>` : ""}</div></td></tr>` }).join(""); return shell(`${heading("Accounts receivable", "Invoices", "Track open balances, invoice tax, and record cash or processor payments.", false)}${stats()}<div class="data-panel"><table><thead><tr><th>Invoice</th><th>Work order</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th>Invoice & payments</th></tr></thead><tbody>${rows}</tbody></table></div>`) }
function recordPayment(invoiceNumber, method) { const invoice = state.invoices.find(item => item.number === invoiceNumber); if (!invoice) return; const balance = invoiceBalance(invoice); showModal(`<form class="modal" id="payment-form"><div class="modal-head"><h2>Record ${method === "cash" ? "cash" : "processor"} payment</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${invoice.number} · ${escapeHtml(invoice.customer)}</span><strong>Balance ${money(balance)}</strong></div><div class="form-grid"><label>Amount received *<input name="amount" type="number" min="0.01" max="${balance}" step=".01" value="${balance}" required/></label><label>Received date<input name="receivedAt" type="date" value="2026-08-14" required/></label><label class="full">Reference / receipt<input name="reference" placeholder="${method === "cash" ? "Cash drawer receipt or check number" : "Stripe payment ID or processor receipt"}"/></label><label class="full">Note<textarea name="note" placeholder="Optional payment note"></textarea></label></div><div class="ledger-note">${icon("landmark", 15)} This posts a payment receipt to Accounts Receivable and cash/processor clearing in accounting.</div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("check", 14)} Record payment</button></div></form>`); document.querySelector("#payment-form").onsubmit = event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), amount = Number(data.amount); if (!Number.isFinite(amount) || amount <= 0 || amount > balance) { toast("Enter a payment amount within the open balance"); return } const paymentRecord = { id: `payment-${Date.now()}`, invoiceNumber, customer: invoice.customer, amount, method, receivedAt: data.receivedAt, reference: data.reference.trim(), note: data.note.trim(), status: "completed", recordedBy: currentUser().id }; state.payments.push(paymentRecord); pushPaymentToApi(paymentRecord); const newBalance = invoiceBalance(invoice); if (newBalance === 0) { invoice.status = "paid"; invoice.due = `Paid ${data.receivedAt}` } else invoice.status = "sent"; updateInvoiceInApi(invoice); save(); closeModal(); toast(`${money(amount)} ${method} payment recorded for ${invoice.number}`); render() } }
async function startInvoiceCheckout(number, textToPay = false) {
  const invoice = state.invoices.find(item => item.number === number);
  if (!invoice) return;
  const ensureStripeReady = async () => {
    if (state.billingSettings.enabled) return true;
    try {
      const status = await apiFetch("/payments/stripe/status");
      stripePaymentStatus = status;
      if (status?.configured) {
        state.billingSettings = {
          ...state.billingSettings,
          enabled: true,
          provider: "stripe",
          shopId: status.shopId || state.billingSettings.shopId || "",
          webhookUrl: status.webhookUrl || state.billingSettings.webhookUrl || "",
        };
        save();
        return true;
      }
    } catch (error) {
      console.error("Could not load Stripe payment status", error);
    }
    toast("Configure Stripe on the Payments page before creating a checkout link");
    return false;
  };
  if (!await ensureStripeReady()) return;
  const checkoutWindow = textToPay ? null : window.open("", "_blank");
  try {
    const data = await apiFetch("/payments/checkout-session", {
      method: "POST",
      body: JSON.stringify({
        invoiceNumber: invoice.number,
        successUrl: `${location.origin}${location.pathname}#payment-success`,
        cancelUrl: `${location.origin}${location.pathname}#payment-cancel`,
      }),
    });
    if (!data.url) throw new Error("Checkout service did not return a payment URL");
    invoice.checkoutUrl = data.url;
    invoice.checkoutCreatedAt = now();
    updateInvoiceInApi(invoice);
    save();
    if (textToPay) {
      const customer = state.customers.find(item => item.id === invoice.customerId || item.name === invoice.customer), phone = invoice.phone || customer?.phone;
      if (!phone) throw new Error("Add a customer phone number before sending text-to-pay");
      const result = await deliverShopMessage({ channel: "sms", to: phone, subject: "", body: `${state.messagingSettings.shopName || "Your shop"} invoice ${invoice.number}: pay securely at ${data.url}`, metadata: { type: "text_to_pay", customerId: customer?.id, invoiceNumber: invoice.number } });
      toast(result.mode === "mechpro_sms" ? `Text-to-pay sent for ${invoice.number}` : `Text-to-pay opened in the device messaging app`);
    } else if (checkoutWindow) checkoutWindow.location = data.url;
    else window.location.assign(data.url);
    if (!textToPay) toast(`Opened secure card checkout for ${invoice.number}`);
  } catch (error) {
    checkoutWindow?.close();
    toast(error.message || "The shop payment service could not create a checkout link");
  }
}
function reports() { const t = state.taxSettings, stateName = usStates.find(s => s.code === t.state)?.name || t.state, result = taxReportResult; return shell(`${heading("Performance", "Reports", "A concise operational snapshot and state tax filing report based on current shop records.", false)}${stats()}<section class="messaging-panel"><div class="messaging-status ready">${icon("landmark", 17)}<div><strong>Tax filing report — ${stateName}</strong><span>Sales tax collected, formatted for ${stateName}'s ${t.filingFrequency.toLowerCase()} filing. Change the subscribing state in Shop settings.</span></div></div><form class="form-grid" id="tax-report-form"><label>From date *<input type="date" name="from" value="${result?.from || "2026-08-01"}" required/></label><label>To date *<input type="date" name="to" value="${result?.to || "2026-08-14"}" required/></label><div class="full messaging-actions"><button class="primary" type="submit">${icon("file-text", 14)} Generate report</button>${result ? `<button class="secondary" type="button" id="print-tax-report">${icon("printer", 14)} Print report</button>` : ""}</div></form>${result ? taxReportView(result, stateName, t) : ""}</section>`) }
function taxReportView(result, stateName, settings) { const rows = result.rows.map(row => `<tr><td>${row.date}</td><td class="mono">${row.invoiceNumber}</td><td>${escapeHtml(row.customer)}</td><td>${money(row.gross)}</td><td>${money(row.taxable)}</td><td><b>${money(row.tax)}</b></td></tr>`).join(""); return `<div class="tax-report-print" id="tax-report-printable"><div class="statement-head"><div><div class="eyebrow">${stateName} sales tax filing</div><h2>Period ${result.from} to ${result.to}</h2><small>Tax ID: ${settings.taxId || "Not set"} · Filing frequency: ${settings.filingFrequency}</small></div></div><div class="finance-kpis"><article><span>Gross receipts</span><strong>${money(result.totals.gross)}</strong></article><article><span>Taxable sales</span><strong>${money(result.totals.taxable)}</strong></article><article><span>Tax collected</span><strong>${money(result.totals.tax)}</strong></article></div><div class="data-panel"><table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Gross receipt</th><th>Taxable sales</th><th>Tax collected</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No payments were recorded in this period.</td></tr>`}</tbody></table></div></div>` }
function settings() { const t = state.taxSettings, stateOptions = usStates.map(s => `<option value="${s.code}" ${t.state === s.code ? "selected" : ""}>${s.name}</option>`).join(""); return shell(`${heading("Administration", "Shop settings", "Core business defaults used throughout MechPro.", false)}<div class="settings-panel"><div class="form-grid"><label>Shop name<input value="Your Car Guy"/></label><label>Phone<input value="555-0100"/></label><label class="full">Address<input value="100 Demo Street, Example City, TX 00000"/></label><label>Default labor rate<input value="$165.00 / hr"/></label><label>Sales tax<input value="8.25%"/></label><label>Service bays<input value="4"/></label><label>SMS notifications<select><option>Enabled</option><option>Disabled</option></select></label></div><button class="primary settings-save">${icon("save", 15)} Save settings</button></div><div class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Tax filing</div><h2>Subscribing state & filing details</h2></div>${icon("landmark", 18)}</div><form class="form-grid" id="tax-settings-form"><label>Filing state *<select name="state" required>${stateOptions}</select></label><label>State tax ID<input name="taxId" value="${t.taxId}" placeholder="e.g. 1-234-5678-9"/></label><label>Default sales tax rate % *<input name="rate" type="number" step=".01" min="0" value="${t.rate}" required/></label><label>Filing frequency<select name="filingFrequency"><option ${t.filingFrequency === "Monthly" ? "selected" : ""}>Monthly</option><option ${t.filingFrequency === "Quarterly" ? "selected" : ""}>Quarterly</option><option ${t.filingFrequency === "Annually" ? "selected" : ""}>Annually</option></select></label><div class="full"><button class="primary" type="submit">${icon("save", 14)} Save tax settings</button></div></form></div>`) }
function loginScreen() { if (isOfflineDesktop()) return offlineLoginMarkup({ hasAccount: offlineAccountReady, email: offlineAccountEmail, icon }); const googleUrl = `${cloudflareConfig.authEndpoints.google}?returnTo=%2F${isDesktopApp ? "&desktop=1" : ""}`, google = isLocalShell() ? "" : `<a class="google-login-button" href="${googleUrl}" ${isDesktopApp ? 'target="_blank" rel="noopener"' : ""}><span class="google-mark" aria-hidden="true">G</span><span>Continue with Google</span></a><div class="login-divider"><span>or use your email</span></div>`; return `<main class="login-screen"><section class="login-panel"><div class="brand login-brand"><div class="brand-mark">${icon("wrench")}</div><div><div class="brand-name">MechPro</div><small>Dispatch & work orders</small></div></div><div class="eyebrow">Protected workspace</div><h1>Sign in to MechPro</h1><p>${isDesktopApp ? "Google opens in your browser. After you choose an account, click Open MechPro to return to this app." : "Use your verified Google account, or receive a one-time link at your work email. No password required."}</p>${google}<form id="login-form"><label class="login-email-label" for="login-email">Work email</label><input id="login-email" name="email" type="email" autocomplete="username" inputmode="email" required autofocus placeholder="you@yourshop.com"/><p class="login-error" id="login-error" hidden></p><button class="primary login-button" type="submit">${icon("mail", 16)} Email me a sign-in link</button></form><div class="login-security">${icon("lock-keyhole", 15)}<span>${isLocalShell() ? "Local development uses the seeded admin profile; cloud APIs remain protected." : "Google verifies the account email. Access still requires an active MechPro customer or employee profile."}</span></div></section></main>` }


async function upgradeShopPlan() { const plans = [["shop", "Shop · $139/mo"], ["solo", "Solo · $69/mo"], ["shop_pro", "Shop Pro · $279/mo"], ["enterprise", "Enterprise · $559/mo"]]; showModal(`<form class="modal" id="upgrade-plan-form"><div class="modal-head"><h2>Choose a plan</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><label>Plan<select name="planId">${plans.map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}</select></label><label>Billing<select name="interval"><option value="monthly">Monthly</option><option value="annual">Annual · 2 months free</option></select></label><p>Unlimited users on every plan. Live OEM programming is Shop Pro and Enterprise.</p><p class="login-error" id="upgrade-plan-error" hidden></p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">Continue</button></div></form>`); document.querySelector("#upgrade-plan-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), error = document.querySelector("#upgrade-plan-error"); try { const result = await platformApi("/billing/checkout", { method: "POST", body: JSON.stringify({ planId: data.planId, interval: data.interval, successUrl: `${location.origin}/?billing=success`, cancelUrl: `${location.origin}/?billing=cancelled` }) }); toast("Opening secure subscription checkout"); if (result.url && (String(result.url).startsWith("http") || String(result.url).startsWith("/"))) location.assign(result.url) } catch (requestError) { error.textContent = requestError.message || "Could not start upgrade"; error.hidden = false } } }
async function platformApi(path, options = {}) {
  const response = await authorizedApiRequest(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Platform request failed (${response.status})`);
  return payload;
}
async function loadPlatformAccounts() {
  if (platformAccountsLoading) return;
  platformAccountsLoading = true;
  try {
    const accounts = await platformApi('/admin/accounts');
    platformAccounts = Array.isArray(accounts) ? accounts : accounts.accounts || [];
  } catch (error) {
    console.error(error);
    platformAccounts = [];
    toast(error.message || 'Could not load customer accounts');
  } finally {
    platformAccountsLoading = false;
    if (currentUser()?.role === 'super_admin' && state.route === 'superadmin') render();
  }
}
function platformShell(content) {
  const user = currentUser();
  return `<div class="app-shell platform-shell"><aside class="sidebar" id="sidebar"><div class="brand"><div class="brand-mark">${icon('wrench')}</div><div><div class="brand-name">MechPro</div><small>Platform console</small></div></div><div class="nav-label">Platform</div><nav class="nav">${nav('superadmin', 'building-2', 'Customer shops')}<a class="nav-button" href="/downloads" target="_blank" rel="noopener">${icon('download')} Downloads</a><a class="nav-button" href="/pricing" target="_blank" rel="noopener">${icon('badge-dollar-sign')} Pricing</a></nav><div class="sidebar-foot"><div class="shop-card"><strong>Platform admin</strong><span>${escapeHtml(user?.email || '')}</span></div><button class="user-row" id="sign-out" type="button"><div class="avatar">${initials(user?.name || 'P')}</div><div><strong>${escapeHtml(user?.name || 'Platform')}</strong><span>Sign out</span></div></button></div></aside><main class="main"><header class="topbar"><button class="icon-button menu-button" id="menu-button" type="button" aria-label="Open navigation">${icon('menu')}</button><div class="top-actions"><button class="secondary" id="refresh-platform" type="button">${icon('refresh-cw', 14)} Refresh</button><a class="secondary" href="/downloads" target="_blank" rel="noopener">${icon('download', 14)} Get apps</a></div></header><div class="content">${content}</div></main></div>`;
}
function subscriptionBadge(account) {
  const status = String(account.subscriptionStatus || 'missing');
  const expires = account.subscriptionExpiresAt ? new Date(account.subscriptionExpiresAt) : null;
  const expired = Boolean(expires && expires.getTime() <= Date.now());
  const label = account.suspended ? 'Suspended' : expired ? 'Expired' : status === 'active' ? 'Paid' : status === 'trialing' ? (expires ? 'Free trial' : 'Free / comped') : status;
  const cls = account.suspended || expired ? 'overdue' : status === 'active' ? 'paid' : 'estimate';
  const detail = account.suspended ? 'Access disabled' : expired ? `Ended ${expires.toLocaleDateString()}` : expires ? `Until ${expires.toLocaleDateString()}` : status === 'active' ? 'No end date' : 'No expiry set';
  return `<span class="badge ${cls}">${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small>`;
}

function superAdmin() { if (platformAccounts === null && !platformAccountsLoading) void loadPlatformAccounts(); const accounts = platformAccounts || [], users = accounts.reduce((sum, account) => sum + (account.users || []).length, 0), trials = accounts.filter(account => !account.suspended && String(account.subscriptionStatus || "") === "trialing").length, paid = accounts.filter(account => !account.suspended && String(account.subscriptionStatus || "") === "active").length, rows = accounts.map(account => `<tr><td><b>${escapeHtml(account.shopName)}</b><small class="mono">${escapeHtml(account.shopId)}</small></td><td><b>${escapeHtml(account.ownerName)}</b><small>${escapeHtml(account.ownerEmail)}</small></td><td>${subscriptionBadge(account)}</td><td><span class="badge paid">${(account.users || []).length} login${(account.users || []).length === 1 ? "" : "s"}</span><small>${(account.users || []).map(user => `${escapeHtml(user.email)} · ${escapeHtml(user.status || "Unknown")}`).join("<br>") || "No login found"}</small></td><td><b>${money(account.creditBalance || 0)}</b><small>Account credit</small></td><td><div class="platform-row-actions"><button class="mini-action" data-credit-shop="${escapeHtml(account.shopId)}" data-shop-name="${escapeHtml(account.shopName)}">${icon("badge-dollar-sign", 13)} Credit</button><button class="mini-action" data-convert-shop="${escapeHtml(account.shopId)}" data-shop-name="${escapeHtml(account.shopName)}">${icon("sparkles", 13)} Convert to paid</button><button class="mini-action" data-trial-shop="${escapeHtml(account.shopId)}" data-shop-name="${escapeHtml(account.shopName)}">${icon("timer", 13)} Set free term</button><button class="mini-action" data-account-status="${escapeHtml(account.shopId)}" data-shop-name="${escapeHtml(account.shopName)}" data-suspended="${account.suspended ? "false" : "true"}">${icon(account.suspended ? "play" : "pause", 13)} ${account.suspended ? "Reactivate" : "Suspend"}</button></div></td></tr>`).join(""); return platformShell(`${heading("Platform control", "Customer shops", "Create customer shops, grant free tester accounts for any duration, convert them to paid, and share desktop/mobile downloads.", false)}<div class="platform-actions"><div class="platform-kpis"><article><span>Customer shops</span><strong>${accounts.length}</strong></article><article><span>Free / trial</span><strong>${trials}</strong></article><article><span>Paid shops</span><strong>${paid}</strong></article><article><span>Managed logins</span><strong>${users}</strong></article></div><div class="platform-action-buttons"><button class="primary" id="new-customer-account">${icon("building-2", 15)} Create shop</button><a class="secondary" href="/downloads" target="_blank" rel="noopener">${icon("download", 15)} App downloads</a></div></div><div class="access-note platform-security">${icon("shield-check", 15)} Platform admins create shops and free tester terms here. Shop owners sign in with their work email. Desktop and phone installs are on the downloads page.</div><div class="data-panel platform-table"><table><thead><tr><th>Shop</th><th>Owner</th><th>Plan</th><th>Logins</th><th>Credit</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${platformAccountsLoading ? "Loading customer accounts..." : "No customer shops yet. Create one to invite an owner."}</td></tr>`}</tbody></table></div>`) }
function openCustomerAccount() { showModal(`<form class="modal wide" id="customer-account-form"><div class="modal-head"><h2>Create customer shop</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Shop name *<input name="shopName" required placeholder="High Plains Auto"/></label><label>Shop ID *<input name="shopId" required pattern="[a-z0-9][a-z0-9-]{2,63}" placeholder="high-plains-auto"/></label><label>Owner name *<input name="ownerName" required/></label><label>Owner email *<input name="email" type="email" required/></label><label>Account type *<select name="accountMode"><option value="trialing">Free / tester</option><option value="comped">Comped (no expiry)</option><option value="active">Paid</option></select></label><label>Free term (days)<input name="trialDays" type="number" min="0" max="3650" value="30" placeholder="30"/><small>Use 0 or leave blank with Comped for no end date. Paid ignores this.</small></label><label>Plan<select name="planId"><option value="solo">Solo · $69/mo</option><option value="shop">Shop · $139/mo</option><option value="shop_pro">Shop Pro · $279/mo</option><option value="enterprise">Enterprise · $559/mo</option><option value="founding_solo">Founding Solo · $49/mo</option><option value="founding_shop">Founding Shop · $99/mo</option><option value="founding_pro">Founding Pro · $199/mo</option></select></label></div><div class="ledger-note">${icon("mail", 15)} The owner signs in with this work email. You can convert free shops to paid later from this console.</div><p class="login-error" id="customer-account-error" hidden></p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("user-plus", 14)} Create shop</button></div></form>`); const form = document.querySelector("#customer-account-form"), mode = form.elements.accountMode, days = form.elements.trialDays; const syncMode = () => { days.disabled = mode.value === "active"; if (mode.value === "comped") days.value = "0"; if (mode.value === "trialing" && !days.value) days.value = "30" }; mode.onchange = syncMode; syncMode(); form.onsubmit = async event => { event.preventDefault(); const button = form.querySelector("button[type=submit]"), error = document.querySelector("#customer-account-error"), data = Object.fromEntries(new FormData(form)); button.disabled = true; error.hidden = true; try { await platformApi("/admin/accounts", { method: "POST", body: JSON.stringify({ shopName: data.shopName, shopId: data.shopId, ownerName: data.ownerName, email: data.email, accountMode: data.accountMode, trialDays: data.trialDays, planId: data.planId }) }); closeModal(); platformAccounts = null; toast("Customer shop created"); render() } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false } } }
function openAccountCredit(shopId, shopName) { showModal(`<form class="modal" id="account-credit-form"><div class="modal-head"><h2>Give account credit</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${escapeHtml(shopName)}</span><strong>${escapeHtml(shopId)}</strong></div><div class="form-grid"><label>Credit amount *<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Reason *<input name="reason" required placeholder="Service adjustment"/></label></div><p class="login-error" id="account-credit-error" hidden></p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("badge-dollar-sign", 14)} Apply credit</button></div></form>`); document.querySelector("#account-credit-form").onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector("button[type=submit]"), error = document.querySelector("#account-credit-error"), data = Object.fromEntries(new FormData(event.target)); button.disabled = true; error.hidden = true; try { await platformApi(`/admin/accounts/${encodeURIComponent(shopId)}/credits`, { method: "POST", body: JSON.stringify({ amount: Number(data.amount), reason: data.reason }) }); closeModal(); platformAccounts = null; toast(`${money(Number(data.amount))} credit applied`); render() } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false } } }
function openConvertPaid(shopId, shopName) { showModal(`<form class="modal" id="convert-paid-form"><div class="modal-head"><h2>Convert to paid</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${escapeHtml(shopName)}</span><strong>${escapeHtml(shopId)}</strong></div><div class="form-grid"><label>Plan<select name="planId"><option value="solo">Solo · $69/mo</option><option value="shop">Shop · $139/mo</option><option value="shop_pro">Shop Pro · $279/mo</option><option value="enterprise">Enterprise · $559/mo</option><option value="founding_solo">Founding Solo · $49/mo</option><option value="founding_shop">Founding Shop · $99/mo</option><option value="founding_pro">Founding Pro · $199/mo</option></select></label></div><div class="ledger-note">${icon("sparkles", 15)} Marks this shop as a paid account with no free-term expiry. Stripe card checkout can be connected later with live SaaS price IDs.</div><p class="login-error" id="convert-paid-error" hidden></p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("badge-check", 14)} Make paid</button></div></form>`); document.querySelector("#convert-paid-form").onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector("button[type=submit]"), error = document.querySelector("#convert-paid-error"), data = Object.fromEntries(new FormData(event.target)); button.disabled = true; error.hidden = true; try { await platformApi(`/admin/accounts/${encodeURIComponent(shopId)}/subscription`, { method: "POST", body: JSON.stringify({ mode: "active", planId: data.planId }) }); closeModal(); platformAccounts = null; toast(`${shopName} is now a paid account`); render() } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false } } }
function openFreeTerm(shopId, shopName) { showModal(`<form class="modal" id="free-term-form"><div class="modal-head"><h2>Set free / tester term</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${escapeHtml(shopName)}</span><strong>${escapeHtml(shopId)}</strong></div><div class="form-grid"><label>Mode<select name="mode"><option value="trialing">Replace term from today</option><option value="extend">Extend from current end</option><option value="comped">Comped (no expiry)</option></select></label><label>Days<input name="trialDays" type="number" min="0" max="3650" value="30"/></label></div><div class="ledger-note">${icon("timer", 15)} Use this for tester shops. Zero days with Comped means unlimited free access until you convert them to paid.</div><p class="login-error" id="free-term-error" hidden></p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} Save term</button></div></form>`); document.querySelector("#free-term-form").onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector("button[type=submit]"), error = document.querySelector("#free-term-error"), data = Object.fromEntries(new FormData(event.target)); button.disabled = true; error.hidden = true; try { await platformApi(`/admin/accounts/${encodeURIComponent(shopId)}/subscription`, { method: "POST", body: JSON.stringify({ mode: data.mode, trialDays: data.trialDays }) }); closeModal(); platformAccounts = null; toast("Free term updated"); render() } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false } } }
function bindPlatformAdmin() { document.querySelector("#refresh-platform")?.addEventListener("click", () => { platformAccounts = null; render() }); document.querySelector("#new-customer-account")?.addEventListener("click", openCustomerAccount); document.querySelectorAll("[data-credit-shop]").forEach(button => button.onclick = () => openAccountCredit(button.dataset.creditShop, button.dataset.shopName)); document.querySelectorAll("[data-convert-shop]").forEach(button => button.onclick = () => openConvertPaid(button.dataset.convertShop, button.dataset.shopName)); document.querySelectorAll("[data-trial-shop]").forEach(button => button.onclick = () => openFreeTerm(button.dataset.trialShop, button.dataset.shopName)); document.querySelectorAll("[data-account-status]").forEach(button => button.onclick = async () => { const suspended = button.dataset.suspended === "true", action = suspended ? "suspend" : "reactivate"; if (!confirm(`${action[0].toUpperCase() + action.slice(1)} ${button.dataset.shopName}?`)) return; button.disabled = true; try { await platformApi(`/admin/accounts/${encodeURIComponent(button.dataset.accountStatus)}/status`, { method: "POST", body: JSON.stringify({ suspended }) }); platformAccounts = null; toast(`${button.dataset.shopName} ${suspended ? "suspended" : "reactivated"}`); render() } catch (error) { toast(error.message); button.disabled = false } }) }

function openPasswordReset() { showModal(`<div class="modal"><div class="modal-head"><h2>Password and MFA</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><p>MechPro authentication is managed by Cloudflare Access and your organization identity provider. Use your identity provider's account-recovery flow or contact your administrator.</p></div><div class="modal-actions"><button type="button" class="primary" data-close>Close</button></div></div>`) }
function render() { const root = document.querySelector("#root"); if (!currentUser()) { root.innerHTML = DOMPurify.sanitize(pendingAuthProfile ? pendingProfileScreen() : loginScreen(), { USE_PROFILES: { html: true } }); lucide.createIcons(); bind(); return } if (!canAccess(state.route)) state.route = roleRoutes[currentUser().role][0]; const views = { superadmin: superAdmin, home: homeDashboard, dispatch, orders, schedule, customers, chat: teamChat, invoices, pos: cardTerminal, ai: aiWorkbench, messaging, payments, integrations, support, reports, settings }; if (typeof accounting === "function") views.accounting = accounting; if (typeof payroll === "function") views.payroll = payroll; if (typeof imports === "function") views.imports = imports; if (typeof employees === "function") views.employees = employees; if (typeof oemDiagnosticsView === "function") views["oem-diagnostics"] = oemDiagnosticsView; root.innerHTML = DOMPurify.sanitize((views[state.route] || views.home || views.dispatch)(), { USE_PROFILES: { html: true } }); const unread = state.conversations.reduce((sum, item) => sum + chatUnread(item), 0); if (currentUser().role !== "super_admin" && !root.querySelector('[data-route="chat"]') && canAccess("chat")) { const chatNav = root.querySelector('.sidebar [aria-label="Front counter"]') || root.querySelector(".sidebar .nav"); chatNav?.insertAdjacentHTML("beforeend", nav("chat", "messages-square", "Team chat", unread || "")) } if (typeof isOemDiagnosticsAvailable === "function" && isOemDiagnosticsAvailable() && !root.querySelector('[data-route="oem-diagnostics"]')) { const floorNav = root.querySelector('.sidebar [aria-label="Shop floor"]') || root.querySelector(".sidebar .nav"); floorNav?.insertAdjacentHTML("beforeend", nav("oem-diagnostics", "radio-tower", "OEM diagnostics")) } lucide.createIcons(); bind(); bindPlatformAdmin(); bindIntegrations(); document.querySelector("#upgrade-shop-plan")?.addEventListener("click", upgradeShopPlan); bindEstimateActions(); bindMessagingService(); bindPaymentService(); if (state.route === "payments") void loadStripePaymentStatus(); bindTeamChat(); if (typeof bindOemDiagnostics === "function") bindOemDiagnostics(); root.querySelector('[data-route="chat"]')?.addEventListener("click", async () => { await loadChatFromApi(); render() }); scheduleChatRefresh() }
function bindMessagingService() { document.querySelector("#messaging-form")?.addEventListener("submit", event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); state.messagingSettings = { enabled: data.enabled === "on", endpoint: data.endpoint.trim(), senderEmail: data.senderEmail.trim(), senderPhone: data.senderPhone.trim(), shopName: data.shopName.trim() || "Your Car Guy" }; if (state.messagingSettings.enabled && !state.messagingSettings.endpoint) { toast("A secure service endpoint is required before enabling delivery"); return } save(); toast("Shop messaging service saved"); render() }); document.querySelector("#test-messaging")?.addEventListener("click", () => { const config = state.messagingSettings; if (!config.endpoint) { toast("Save a secure endpoint before testing"); return } toast("Endpoint saved. Use your shop service test endpoint to verify SMTP and SMS credentials.") }) }
async function loadStripePaymentStatus() {
  if (!canAccess("payments")) return;
  try {
    stripePaymentStatus = await apiFetch("/payments/stripe/status");
    if (stripePaymentStatus?.configured && !state.billingSettings.enabled) {
      state.billingSettings = {
        ...state.billingSettings,
        enabled: true,
        provider: "stripe",
        shopId: stripePaymentStatus.shopId || state.billingSettings.shopId || "",
        webhookUrl: stripePaymentStatus.webhookUrl || state.billingSettings.webhookUrl || "",
      };
      save();
    }
  } catch (error) {
    console.error("Failed to load Stripe payment status", error);
  }
}
function bindPaymentService() {
  document.querySelector("#billing-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    const secretKey = String(data.secretKey || "").trim();
    const webhookSecret = String(data.webhookSecret || "").trim();
    const publishableKey = String(data.publishableKey || "").trim();
    const button = form.querySelector("button[type=submit]");
    const alreadyConfigured = Boolean(stripePaymentStatus?.configured);
    if ((!secretKey || !webhookSecret) && !alreadyConfigured) {
      toast("Enter both the Stripe secret key and webhook signing secret");
      return;
    }
    if ((secretKey && !webhookSecret) || (!secretKey && webhookSecret)) {
      toast("Provide both keys together when updating Stripe credentials");
      return;
    }
    if (publishableKey && !/^pk_(test|live)_/.test(publishableKey)) {
      toast("Publishable key must start with pk_test_ or pk_live_");
      return;
    }
    if (button) button.disabled = true;
    try {
      if ((secretKey && webhookSecret) || publishableKey) {
        const result = await apiFetch("/payments/stripe/configure", {
          method: "POST",
          body: JSON.stringify({
            ...(secretKey && webhookSecret ? { secretKey, webhookSecret } : {}),
            ...(publishableKey ? { publishableKey } : {}),
          }),
        });
        stripePaymentStatus = { ...stripePaymentStatus, ...result, configured: true, hasPublishableKey: Boolean(publishableKey) || Boolean(stripePaymentStatus?.hasPublishableKey) };
      } else {
        stripePaymentStatus = await apiFetch("/payments/stripe/status");
      }
      state.billingSettings = {
        enabled: data.enabled === "on" || Boolean(stripePaymentStatus?.configured),
        provider: "stripe",
        accountLabel: String(data.accountLabel || "").trim(),
        shopName: String(data.shopName || "").trim() || "Your Car Guy",
        shopId: stripePaymentStatus?.shopId || state.billingSettings.shopId || "",
        webhookUrl: stripePaymentStatus?.webhookUrl || state.billingSettings.webhookUrl || "",
        checkoutEndpoint: "",
        onboardingUrl: "",
      };
      save();
      toast(secretKey ? "Stripe keys saved securely" : "Payment settings saved");
      render();
    } catch (error) {
      toast(error.message || "Could not save Stripe payment settings");
    } finally {
      if (button) button.disabled = false;
    }
  });
  document.querySelector("#copy-stripe-webhook")?.addEventListener("click", async () => {
    const input = document.querySelector("#stripe-webhook-url");
    const value = input?.value?.trim();
    if (!value) return toast("Webhook URL is not available yet");
    try {
      await navigator.clipboard.writeText(value);
      toast("Webhook URL copied");
    } catch {
      input.select();
      document.execCommand("copy");
      toast("Webhook URL copied");
    }
  });
  document.querySelector("#refresh-stripe-status")?.addEventListener("click", async () => {
    try {
      stripePaymentStatus = await apiFetch("/payments/stripe/status");
      if (stripePaymentStatus?.configured) {
        state.billingSettings = {
          ...state.billingSettings,
          enabled: state.billingSettings.enabled || true,
          provider: "stripe",
          shopId: stripePaymentStatus.shopId || "",
          webhookUrl: stripePaymentStatus.webhookUrl || "",
        };
        save();
      }
      toast(stripePaymentStatus?.configured ? "Stripe is connected" : "Stripe is not configured yet");
      render();
    } catch (error) {
      toast(error.message || "Could not refresh Stripe status");
    }
  });
}
function bindLiveAssistant() { const form = document.querySelector("#assistant-form"); if (!form) return; const input = form.elements.message, sendButton = form.querySelector("button[type=submit]"), append = (role, content) => { assistantConversation.push({ role, content }); const list = document.querySelector("#assistant-messages"); list.innerHTML = assistantConversation.map(item => `<article class="assistant-message ${item.role}"><strong>${item.role === "user" ? "You" : "MechPro Assistant"}</strong><p>${escapeHtml(item.content)}</p></article>`).join(""); list.scrollTop = list.scrollHeight }; form.onsubmit = async event => { event.preventDefault(); if (assistantPaused) return; const message = String(input.value || "").trim(); if (!message) return; input.value = ""; sendButton.disabled = true; append("user", message); try { const result = await apiFetch("/ai/assistant", { method: "POST", body: JSON.stringify({ message, sessionId: assistantSessionId || undefined, history: assistantConversation.slice(-10).map(item => ({ role: item.role === "assistant" ? "assistant" : "user", content: [{ text: item.content }] })) }) }); assistantSessionId = result.sessionId || assistantSessionId; const answer = result.message || "I could not answer that right now."; append("assistant", answer); if (!assistantPaused && "speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(answer)) } } catch (error) { append("assistant", error.message || "The live assistant is unavailable.") } finally { sendButton.disabled = assistantPaused } }; document.querySelector("#assistant-stop")?.addEventListener("click", () => speechSynthesis?.cancel()); document.querySelector("#assistant-mic")?.addEventListener("click", () => { if (assistantPaused) return; const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!Recognition) { toast("Voice input is not supported in this browser"); return } const recognition = new Recognition(); recognition.lang = "en-US"; recognition.interimResults = false; recognition.onstart = () => toast("Listening..."); recognition.onerror = () => toast("Microphone input could not be captured"); recognition.onresult = event => { input.value = event.results[0][0].transcript; form.requestSubmit() }; recognition.start() }) }
function bindEstimateActions() { bindLiveAssistant(); document.querySelector("#save-ai-estimate")?.addEventListener("click", makeEstimate); document.querySelectorAll("[data-send-estimate]").forEach(button => button.onclick = () => sendEstimate(button.dataset.sendEstimate, button.dataset.channel)); document.querySelectorAll("[data-sign-estimate]").forEach(button => button.onclick = () => openSignature(button.dataset.signEstimate)); document.querySelectorAll("[data-message-customer]").forEach(button => button.onclick = event => { event.stopPropagation(); openCustomerMessage(decodeURIComponent(button.dataset.messageCustomer), decodeURIComponent(button.dataset.messagePhone), decodeURIComponent(button.dataset.messageEmail)) }); document.querySelectorAll("[data-open-customer]").forEach(el => { if (el.tagName === "BUTTON") el.onclick = event => { event.stopPropagation(); openCustomerRecord(decodeURIComponent(el.dataset.openCustomer)) }; else el.onclick = event => { if (event.target.closest("[data-message-customer]")) return; openCustomerRecord(decodeURIComponent(el.dataset.openCustomer)) } }); document.querySelectorAll("[data-pay-invoice]").forEach(button => button.onclick = () => startInvoiceCheckout(button.dataset.payInvoice)); document.querySelectorAll("[data-text-pay]").forEach(button => button.onclick = () => startInvoiceCheckout(button.dataset.textPay, true)); document.querySelectorAll("[data-record-payment]").forEach(button => button.onclick = () => recordPayment(button.dataset.recordPayment, button.dataset.method)); document.querySelectorAll("[data-edit-tax]").forEach(button => button.onclick = () => openInvoiceTax(button.dataset.editTax)) }
function bind() { bindAttentionPanel(); document.querySelectorAll("[data-route]").forEach(x => x.onclick = async () => { state.route = x.dataset.route; save(); render(); if (x.dataset.route === "customers") { await loadCustomersFromApi(); render() } if (x.dataset.route === "shopops") { await loadShopEntities(); render() } if (["obd", "keys"].includes(x.dataset.route)) { await Promise.all([loadOrdersFromApi(), loadEstimatesFromApi(), loadShopEntities()]); render() } if (["home", "dispatch", "orders", "schedule"].includes(x.dataset.route)) { await loadOrdersFromApi(); if (x.dataset.route === "home") await Promise.all([loadInvoicesFromApi(), loadShopEntities()]); if (x.dataset.route === "schedule") await loadShopEntities(); render() } if (["invoices", "accounting", "reports"].includes(x.dataset.route)) { await Promise.all([loadInvoicesFromApi(), loadPaymentsFromApi(), loadExpensesFromApi()]); render() } if (x.dataset.route === "payments") { await loadStripePaymentStatus(); render() } if (x.dataset.route === "ai") { await loadEstimatesFromApi(); render() } if (x.dataset.route === "payroll") { await Promise.all([loadShiftEntriesFromApi(), loadJobClockEntriesFromApi(), loadPayrollEntriesFromApi()]); render() } }); document.querySelectorAll("[data-filter]").forEach(x => x.onclick = () => { filter = x.dataset.filter; render() }); document.querySelectorAll("[data-accounting-tab]").forEach(x => x.onclick = () => { accountingTab = x.dataset.accountingTab; render() }); document.querySelectorAll("[data-ai-tab]").forEach(x => x.onclick = () => { aiTab = x.dataset.aiTab; aiResult = null; render() }); document.querySelector("#ai-form")?.addEventListener("submit", event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); if (aiTab === "workflow") { const order = state.orders.find(item => item.id === data.workOrderId); if (!order) return; aiResult = workflowLocal(order) } else if (aiTab === "diagnostics") aiResult = diagnoseLocal(data.vehicle, data.symptoms, data.dtc); else if (aiTab === "estimate") aiResult = estimateLocal(data.vehicle, data.service, data.notes); else if (aiTab === "guide") aiResult = guideLocal(data.vehicle, data.repair); else aiResult = phoneLocal(data.transcript); render() }); document.querySelector("#apply-ai-workflow")?.addEventListener("click", () => { if (aiResult?.kind !== "workflow") return; const order = state.orders.find(item => item.id === aiResult.orderId); if (!order) return; order.aiWorkflow = { generatedAt: now(), probableCauses: aiResult.diagnostics.causes, diagnosticChecklist: aiResult.diagnostics.tests, repairSteps: aiResult.guide.steps, recommendedServices: aiResult.recommended, estimate: aiResult.estimate }; applyAiWorkflowEstimate(order, aiResult.estimate, { rate: shopMileageRate(), taxRate: state.taxSettings.rate }); order.notes = `${order.notes || ""}\nAI workflow: ${aiResult.diagnostics.causes[0]?.cause || "Inspection required"}`.trim(); updateOrderInApi(order); save(); toast(`${order.id} updated with AI workflow`); render() }); document.querySelectorAll("[data-order]").forEach(x => x.onclick = () => openOrder(x.dataset.order)); document.querySelector("#new-ro-button")?.addEventListener("click", openNew); document.querySelector("#new-employee")?.addEventListener("click", openEmployee); document.querySelector("#user-menu-toggle")?.addEventListener("click", event => { event.stopPropagation(); const panel = document.querySelector("#user-menu-panel"), toggle = document.querySelector("#user-menu-toggle"); if (!panel || !toggle) return; const willOpen = panel.hidden; panel.hidden = !willOpen; toggle.setAttribute("aria-expanded", willOpen ? "true" : "false") }); document.querySelector("#user-menu-settings")?.addEventListener("click", () => { state.route = "settings"; save(); render() }); document.querySelector("#sign-out")?.addEventListener("click", () => { void signOutEverywhere() }); if (!userMenuDismissBound) { userMenuDismissBound = true; document.addEventListener("click", event => { const openPanel = document.querySelector("#user-menu-panel"), openToggle = document.querySelector("#user-menu-toggle"); if (!openPanel || openPanel.hidden || event.target.closest("#user-menu")) return; openPanel.hidden = true; openToggle?.setAttribute("aria-expanded", "false") }) } document.querySelector("#global-clock")?.addEventListener("click", toggleShift); document.querySelector("#job-clock")?.addEventListener("click", event => { const id = event.currentTarget.dataset.workOrderId; openJobClock(id) ? stopJobClock(id) : startJobClock(id) }); document.querySelectorAll("[data-toggle-user]").forEach(button => button.onclick = () => { const user = state.users.find(item => item.id === button.dataset.toggleUser); if (!user) return; user.active = !user.active; save(); toast(`${user.name} account ${user.active ? "activated" : "deactivated"}`); render() }); document.querySelector("#sync-payroll")?.addEventListener("click", () => { syncAllPayroll(); toast("Completed job labor synced to weekly payroll"); render() }); document.querySelector("#payroll-export")?.addEventListener("click", exportPayroll); document.querySelector("#export-button")?.addEventListener("click", exportCsv); document.querySelector("#accounting-export")?.addEventListener("click", exportLedger); document.querySelector("#record-expense")?.addEventListener("click", openExpense); document.querySelector("#journal-entry")?.addEventListener("click", openJournal); document.querySelector("#tax-settings-form")?.addEventListener("submit", event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); state.taxSettings = { state: data.state, taxId: data.taxId.trim(), rate: Number(data.rate) || 0, filingFrequency: data.filingFrequency }; save(); toast("Tax settings saved"); render() }); document.querySelector("#tax-report-form")?.addEventListener("submit", event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); taxReportResult = taxReport(data.from, data.to); render() }); document.querySelector("#print-tax-report")?.addEventListener("click", () => window.print()); document.querySelector("#menu-button")?.addEventListener("click", () => document.querySelector("#sidebar").classList.toggle("open")); document.querySelector(".settings-save")?.addEventListener("click", () => toast("Shop settings saved")); document.querySelectorAll("[data-template]").forEach(button => button.onclick = () => downloadTemplate(button.dataset.template)); document.querySelectorAll("[data-import-type]").forEach(button => button.onclick = () => { const input = document.querySelector("#csv-input"); input.dataset.type = button.dataset.importType; input.click() }); document.querySelector("#csv-input")?.addEventListener("change", async event => { const file = event.target.files[0]; if (!file) return; importPreview = prepareImport(event.target.dataset.type, await file.text()); render() }); document.querySelector("#cancel-import")?.addEventListener("click", () => { importPreview = null; render() }); document.querySelector("#confirm-import")?.addEventListener("click", applyImport);[document.querySelector("#global-search"), document.querySelector("#order-search")].filter(Boolean).forEach(x => x.oninput = e => { query = e.target.value; clearTimeout(window.searchTimer); window.searchTimer = setTimeout(render, 180) }); document.onkeydown = e => { if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); document.querySelector("#global-search")?.focus() } if (e.key === "Escape") closeModal() } }
let modalAutosaveFlush = null;
function setModalAutosave(flushFn) { modalAutosaveFlush = typeof flushFn === "function" ? flushFn : null }
function showModal(html) { closeModal(); const root = document.createElement("div"); root.id = "modal-root"; root.className = "modal-backdrop"; root.innerHTML = safeHtml(html); root.onclick = e => { if (e.target === root) closeModal() }; document.body.append(root); lucide.createIcons(); root.querySelectorAll("[data-close]").forEach(x => { if (!x.textContent.trim() && !x.getAttribute("aria-label")) x.setAttribute("aria-label", "Close"); if (!x.getAttribute("title") && !x.textContent.trim()) x.setAttribute("title", "Close"); x.onclick = closeModal }); root.querySelector("#job-clock")?.addEventListener("click", event => { const workOrderId = event.currentTarget.dataset.workOrderId; openJobClock(workOrderId) ? stopJobClock(workOrderId) : startJobClock(workOrderId) }) }
function closeModal() {
  const root = document.querySelector("#modal-root");
  const flush = modalAutosaveFlush;
  modalAutosaveFlush = null;
  if (flush && root) {
    try { flush({ reason: "close", root }) } catch (error) { console.error("Modal autosave failed", error) }
  }
  root?.remove();
}
function newOrderEstimateRow(line = { service: "Custom service", notes: "Describe the inspection, labor, parts, and verification included with this service.", hours: 1, parts: 0 }) { const verified = Boolean(line.laborVerified), source = line.laborSource || "Unverified shop estimate"; return `<article class="new-estimate-line" data-labor-source="${escapeAttr(source)}" data-labor-verified="${verified ? "1" : "0"}"><div class="estimate-line-head"><strong>Service line</strong><div><button class="mini-action lookup-labor-time" type="button">${icon("badge-check", 13)} Labor guide</button><button class="icon-button remove-estimate-line" type="button" title="Remove service">${icon("trash-2", 14)}</button></div></div><label>Service<input class="estimate-service" value="${escapeHtml(line.service)}" required/></label><label>What this service includes<textarea class="estimate-explanation" required>${escapeHtml(line.notes)}</textarea></label><small class="labor-source"><span class="badge ${verified ? "paid" : "estimate"}">${verified ? "Verified" : "Unverified"}</span> ${escapeHtml(source)}</small><div class="estimate-line-numbers"><label>Labor hours<input class="estimate-hours" type="number" min="0" step=".25" value="${Number(line.hours || 0)}"/></label><label>Parts & materials<input class="estimate-parts" type="number" min="0" step=".01" value="${Number(line.parts || 0).toFixed(2)}"/></label><div><span>Line total</span><b class="estimate-line-total">${money(Number(line.hours || 0) * 165 + Number(line.parts || 0))}</b></div></div></article>` }
function newOrderServiceExplanation(service, fallback) { const source = aiKeywords(service); if (/brake|rotor|pad/.test(source)) return "Includes wheel removal, brake friction and hardware inspection, pad and rotor replacement where quoted, approved lubrication, fastener and wheel torque verification, brake bedding, and a final road test."; if (/oil|lube/.test(source)) return "Includes draining the engine oil, replacing the oil filter, refilling with the specified grade and quantity, checking for leaks and final level, resetting the maintenance reminder when applicable, and a multipoint fluid and safety inspection."; if (/a\/c|air.?condition/.test(source)) return "Includes confirming vent temperature and airflow, scanning HVAC-related modules, inspecting fan and condenser operation, recording system pressures with approved equipment, and reporting the verified fault before additional repair parts are authorized."; return `${fallback || "Includes initial inspection and standard service labor."} The technician will verify the concern, perform the quoted service using current manufacturer information, document findings, and complete a post-service quality-control check.` }
function readNewOrderEstimate() { const lines = [...document.querySelectorAll(".new-estimate-line")].map(row => { const hours = Math.max(0, Number(row.querySelector(".estimate-hours").value) || 0), parts = Math.max(0, Number(row.querySelector(".estimate-parts").value) || 0), labor = Math.round(hours * 165 * 100) / 100; return { service: row.querySelector(".estimate-service").value.trim(), explanation: row.querySelector(".estimate-explanation").value.trim(), hours, laborRate: 165, labor, parts, laborSource: row.dataset.laborSource || "Unverified shop estimate", laborVerified: row.dataset.laborVerified === "1", total: Math.round((labor + parts) * 100) / 100 } }).filter(line => line.service); const labor = lines.reduce((sum, line) => sum + line.labor, 0), laborHours = lines.reduce((sum, line) => sum + line.hours, 0), parts = lines.reduce((sum, line) => sum + line.parts, 0), shopSupplies = lines.length ? 12 : 0, subtotal = Math.round((labor + parts + shopSupplies) * 100) / 100, tax = Math.round(subtotal * .0825 * 100) / 100, total = Math.round((subtotal + tax) * 100) / 100; return { lines, labor, laborHours, parts, fees: shopSupplies ? [{ description: "Shop supplies", amount: shopSupplies }] : [], subtotal, tax, taxRate: 8.25, total } }
function refreshNewOrderEstimate() { const estimate = readNewOrderEstimate(); document.querySelectorAll(".new-estimate-line").forEach(row => { const hours = Math.max(0, Number(row.querySelector(".estimate-hours").value) || 0), parts = Math.max(0, Number(row.querySelector(".estimate-parts").value) || 0), total = row.querySelector(".estimate-line-total"); if (total) total.textContent = money(hours * 165 + parts) }); const summary = document.querySelector("#new-estimate-summary"); if (summary) summary.innerHTML = `<span>Labor <b>${money(estimate.labor)}</b></span><span>Parts <b>${money(estimate.parts)}</b></span><span>Fees <b>${money(estimate.fees.reduce((sum, fee) => sum + fee.amount, 0))}</b></span><span>Tax <b>${money(estimate.tax)}</b></span><strong>Total ${money(estimate.total)}</strong>`; const total = document.querySelector("#new-estimate-total"); if (total) total.value = estimate.total.toFixed(2) }
function bindNewOrderEstimator() { const form = document.querySelector("#new-form"), lines = document.querySelector("#new-estimate-lines"); if (!form || !lines) return; const bindRows = () => { lines.querySelectorAll("input,textarea").forEach(input => input.oninput = refreshNewOrderEstimate); lines.querySelectorAll(".remove-estimate-line").forEach(button => button.onclick = () => { button.closest(".new-estimate-line").remove(); refreshNewOrderEstimate() }); lines.querySelectorAll(".lookup-labor-time").forEach(button => button.onclick = async () => { const row = button.closest(".new-estimate-line"), query = row.querySelector(".estimate-service").value.trim(), vehicle = form.elements.vehicle.value.trim(); button.disabled = true; try { const result = await apiFetch("/labor-times/search", { method: "POST", body: JSON.stringify({ vin: form.elements.vin?.value || "", query, model: vehicle }) }), labor = (result.results || [])[0]; if (!labor) throw new Error("No labor operation returned"); if (labor.hours != null) row.querySelector(".estimate-hours").value = labor.hours; row.dataset.laborSource = labor.source || "Unverified shop estimate"; row.dataset.laborVerified = labor.verified ? "1" : "0"; row.querySelector(".labor-source").innerHTML = `<span class="badge ${labor.verified ? "paid" : "estimate"}">${labor.verified ? "Verified" : "Unverified"}</span> ${escapeHtml(row.dataset.laborSource)}`; refreshNewOrderEstimate(); toast(labor.verified ? `Verified ${labor.provider} labor time applied` : "No licensed result; keeping the shop estimate unverified") } catch (error) { toast(error.message) } finally { button.disabled = false } }) }; document.querySelector("#generate-new-estimate").onclick = () => { const vehicle = form.elements.vehicle.value.trim(), complaint = form.elements.complaint.value.trim(), requested = form.elements.requestedServices.value.trim(); if (!vehicle || !complaint) { toast("Enter the vehicle and customer complaint before generating an estimate"); return } const services = (requested || complaint).split(/\n|,|;/).map(item => item.trim()).filter(Boolean), generated = services.map(service => { const line = estimateLocal(vehicle, service).lines[0]; return { ...line, laborSource: "Unverified shop estimate", laborVerified: false, notes: newOrderServiceExplanation(service, line.notes) } }); lines.innerHTML = generated.map(newOrderEstimateRow).join(""); bindRows(); refreshNewOrderEstimate(); toast(`${generated.length} service estimate${generated.length === 1 ? "" : "s"} generated`) }; document.querySelector("#add-estimate-line").onclick = () => { lines.insertAdjacentHTML("beforeend", newOrderEstimateRow()); bindRows(); refreshNewOrderEstimate() }; bindRows(); refreshNewOrderEstimate() }
function techOptions(selected = "Unassigned") { const names = ["Unassigned", ...state.users.filter(user => user.active && user.techName).map(user => user.techName)]; return [...new Set(names)].map(name => `<option ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>`).join("") }
function vehicleOptionsForCustomer(customerName, selectedVin = "") { const vehicles = state.vehicles.filter(vehicle => !customerName || vehicle.customer === customerName); return `<option value="">Enter vehicle manually</option>${vehicles.map(vehicle => `<option value="${escapeHtml(vehicle.id)}" data-vin="${escapeHtml(vehicle.vin || "")}" data-label="${escapeHtml(vehicleLabel(vehicle))}" ${vehicle.vin && vehicle.vin === selectedVin ? "selected" : ""}>${escapeHtml(vehicleLabel(vehicle))}${vehicle.vin ? ` · ${escapeHtml(vehicle.vin)}` : ""}</option>`).join("")}` }
function bindNewOrderCustomerPickers() { const form = document.querySelector("#new-form"); if (!form) return; const customerSelect = form.elements.customerSelect, customerInput = form.elements.customer, phoneInput = form.elements.phone, vehicleSelect = form.elements.vehicleSelect, vehicleInput = form.elements.vehicle, vinInput = form.elements.vin, vinStatus = document.querySelector("#new-ro-vin-status"); const syncCustomer = () => { const name = customerSelect.value; if (name === "__new__") { customerInput.value = ""; customerInput.hidden = false; customerInput.required = true; customerInput.focus(); vehicleSelect.innerHTML = vehicleOptionsForCustomer(""); return } customerInput.hidden = true; customerInput.required = false; customerInput.value = name; const match = state.customers.find(item => item.name === name); if (match) phoneInput.value = match.phone || ""; vehicleSelect.innerHTML = vehicleOptionsForCustomer(name) }; const syncVehicle = () => { const option = vehicleSelect.selectedOptions[0]; if (!option || !option.value) { vehicleInput.readOnly = false; return } vehicleInput.value = option.dataset.label || ""; vinInput.value = option.dataset.vin || ""; vehicleInput.readOnly = true }; customerSelect.onchange = syncCustomer; vehicleSelect.onchange = syncVehicle; document.querySelector("#new-ro-decode-vin")?.addEventListener("click", async () => { const vin = String(vinInput.value || "").trim().toUpperCase(); if (vin.length !== 17) { vinStatus.textContent = "Enter a 17-character VIN"; return } vinStatus.textContent = "Decoding VIN…"; try { const data = await apiFetch(`/vehicles/decode/${encodeURIComponent(vin)}`); vehicleInput.value = [data.year, data.make, data.model, data.trim].filter(Boolean).join(" "); vinInput.value = vin; vehicleInput.readOnly = false; vehicleSelect.value = ""; vinStatus.textContent = data.cached ? "Cached NHTSA data loaded" : "NHTSA vehicle data loaded" } catch { vinStatus.textContent = "VIN could not be decoded" } }); syncCustomer() }
function openNew() { const promiseDefault = relativePromiseHint(); showModal(`<form class="modal wide" id="new-form"><div class="modal-head"><h2>New work order</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><h3>Customer & vehicle</h3><div class="form-grid"><label>Customer *<select name="customerSelect" required><option value="__new__">+ New customer</option>${customerOptions()}</select></label><label>Customer name (new)<input name="customer" hidden/></label><label>Phone<input name="phone"/></label><label class="full">Linked vehicle<select name="vehicleSelect">${vehicleOptionsForCustomer("")}</select></label><label class="full">Vehicle description *<input name="vehicle" required placeholder="Year, make, model, trim"/></label><label class="full">VIN<input name="vin" maxlength="17" pattern="[A-HJ-NPR-Z0-9]{0,17}"/></label><div class="full vin-actions"><button class="secondary" type="button" id="new-ro-decode-vin">${icon("scan-line", 14)} Decode VIN with NHTSA</button><span id="new-ro-vin-status"></span></div></div><h3>Service details</h3><div class="form-grid"><label class="full">Customer complaint *<textarea name="complaint" required></textarea></label><label>Status<select name="status"><option value="estimate">Estimate</option><option value="approved">Approved</option><option value="in_progress">In progress</option></select></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label><label>Technician<select name="tech">${techOptions()}</select></label><label>Assignment<select name="bay"><option>Unassigned</option><option>Bay 1</option><option>Bay 2</option><option>Bay 3</option><option>Bay 4</option><option>Mobile</option></select></label><label>Promise time<input name="promise" value="${escapeHtml(promiseDefault)}"/></label><label>Estimate total<input id="new-estimate-total" name="total" type="number" min="0" step="0.01" value="0.00" readonly/></label></div><h3>AI service estimate</h3><section class="new-order-estimator"><div class="estimator-prompt"><label>Requested services, one per line<textarea name="requestedServices" placeholder="Front brake pads and rotors&#10;Synthetic oil and filter service"></textarea></label><button class="primary" id="generate-new-estimate" type="button">${icon("sparkles", 15)} Generate with AI</button></div><div class="estimator-toolbar"><p>Edit the generated prices and included-work explanations before creating the order.</p><button class="secondary" id="add-estimate-line" type="button">${icon("plus", 14)} Add service</button></div><div id="new-estimate-lines"></div><div class="new-estimate-summary" id="new-estimate-summary"></div></section>${Mileage.newOrderMileageMarkup({ rate: Mileage.normalizeMileageRate(typeof shopProfile === "function" ? shopProfile().mileageRate : 0.68), shopAddress: typeof shopProfile === "function" ? shopProfile().address : "" })}</div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("plus", 15)} Create work order</button></div></form>`); bindNewOrderEstimator(); bindWorkOrderMileage("#new-form"); bindNewOrderCustomerPickers(); document.querySelector("#new-form").onsubmit = async e => { e.preventDefault(); const submitButton = e.target.querySelector("button.primary"), data = Object.fromEntries(new FormData(e.target)), customerName = String(data.customerSelect === "__new__" ? data.customer : data.customerSelect || data.customer).trim(); if (!customerName) { toast("Select or enter a customer name"); return } const estimate = readNewOrderEstimate(), id = `RO-${Math.max(1040, ...state.orders.map(x => Number(x.id.split("-")[1]) || 0)) + 1}`; let order = { id, customer: customerName, phone: data.phone, vehicle: data.vehicle, vin: String(data.vin || "").trim().toUpperCase() || "VIN pending", complaint: data.complaint, status: data.status, priority: data.priority, tech: data.tech, bay: data.bay, mobile: data.bay === "Mobile", promise: data.promise, total: estimate.total, scheduled: "Unscheduled", notes: "New intake. Diagnosis pending.", labor: estimate.labor, laborHours: estimate.laborHours, parts: estimate.parts, tax: estimate.tax, jobAddress: String(data.jobAddress || "").trim(), tripMilesOneWay: Number(data.tripMilesOneWay) || 0, estimate: { ...estimate, generatedAt: now(), summary: `Preliminary estimate for ${data.vehicle}. Verify vehicle condition, part fitment, and customer authorization before repair.` } }; order = Mileage.applyMileageToOrder(order, { oneWayMiles: order.tripMilesOneWay, jobAddress: order.jobAddress, rate: shopMileageRate(), taxRate: state.taxSettings.rate }); if (submitButton) submitButton.disabled = true; try { const saved = await pushOrderToApi(order); state.orders.unshift(saved || order); const existingCustomer = state.customers.find(x => x.name.toLowerCase() === customerName.toLowerCase()); const contact = customerContactFields({ name: customerName, phone: data.phone, email: data.email, billingAddress: data.billingAddress }, existingCustomer); if (!existingCustomer || customerContactChanged(existingCustomer, contact)) await saveCustomerRecord(existingCustomer || null, contact); save(); closeModal(); toast(`${id} created successfully`); render() } catch (error) { toast(error.message || "Work order could not be saved"); } finally { if (submitButton) submitButton.disabled = false } } }
async function commitLinkedInventory(order) { if (order.inventoryDeducted || order.inventoryCommittedAt) return true; const commitments = new Map(), missing = []; for (const line of order.estimate?.lines || []) { const quantity = Number(line.committedQuantity || 0); if (!Number.isFinite(quantity) || quantity <= 0) continue; const item = state.inventory.find(record => record.id === line.inventoryId || (line.inventorySku && record.sku === line.inventorySku)); if (!item) { missing.push(line.inventorySku || line.inventoryId || line.service); continue } const current = commitments.get(item.id) || { item, quantity: 0 }; current.quantity += quantity; commitments.set(item.id, current) } const shortages = [...missing.map(name => `${name} is unavailable`), ...[...commitments.values()].filter(({ item, quantity }) => Number(item.quantity || 0) < quantity).map(({ item, quantity }) => `${item.sku || item.name}: need ${quantity}, have ${Number(item.quantity || 0)}`)]; if (shortages.length) { toast(`Inventory shortage: ${shortages.join("; ")}`); return false } for (const { item, quantity } of commitments.values()) await saveShopEntity("inventory", { ...item, quantity: Math.max(0, Number(item.quantity || 0) - quantity), updatedAt: item.updatedAt || now() }); order.inventoryCommittedAt = now(); order.inventoryDeducted = true; return true }
function openOrder(id) { const x = state.orders.find(o => o.id === id); if (!x) return; const technicians = state.users.filter(user => user.active && user.techName).map(user => user.techName), canManage = ["admin", "service_writer"].includes(currentUser().role), isAssignedTech = currentUser().role === "technician" && currentUser().techName === x.tech, activeClock = openJobClock(x.id), jobClockControl = isAssignedTech ? `<section class="job-clock-panel"><div><h3>Job time clock</h3><p>${activeClock ? `Clocked in at ${formatTime(activeClock.clockIn)}` : `${formatHours(jobTrackedHours(x.id))} tracked on this job`}</p></div><button class="${activeClock ? "secondary danger" : "primary"}" id="job-clock" data-work-order-id="${x.id}">${icon(activeClock ? "square" : "play", 14)} ${activeClock ? "Clock out job" : "Clock in to job"}</button></section>` : "", inventoryLines = (x.estimate?.lines || []).filter(line => line.inventoryId || line.inventorySku), inventoryMarkup = inventoryLines.length ? `<section><h3>Linked inventory</h3>${inventoryLines.map(line => { const item = state.inventory.find(record => record.id === line.inventoryId || (line.inventorySku && record.sku === line.inventorySku)); return `<p><b>${escapeHtml(item?.sku || line.inventorySku || "Unknown SKU")}</b> · ${escapeHtml(item?.name || line.service)} · ${Number(line.committedQuantity || 0)} committed</p>` }).join("")}${x.inventoryDeducted ? `<small>Deducted ${new Date(x.inventoryCommittedAt).toLocaleString()}</small>` : ""}</section>` : "", assignment = canManage ? `<label>Assigned technician<select id="detail-tech"><option>Unassigned</option>${technicians.map(t => `<option ${t === x.tech ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select></label><label>Labor hours<select id="detail-hours">${[0, .5, .75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8].map(h => `<option value="${h}" ${Number(x.laborHours ?? 0) === h ? "selected" : ""}>${h === 0 ? "Not set" : h.toFixed(2) + " hours"}</option>`).join("")}</select></label>` : `<section><h3>Assignment</h3><p>${escapeHtml(x.tech)} · ${Number(x.laborHours ?? 0).toFixed(2)} labor hours</p></section>`; showModal(`<div class="modal wide"><div class="modal-head"><div><span class="mono">${x.id}</span><h2>Work order details</h2></div><button class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="detail-hero"><div>${badge(x.status)}<h2>${escapeHtml(x.customer)}</h2><p>${escapeHtml(x.vehicle)} · <span class="mono">${escapeHtml(x.vin)}</span></p></div><div><div class="amount">${money(x.total)}</div><p>${escapeHtml(x.tech)} · ${escapeHtml(x.bay)}</p></div></div><div class="detail-grid"><div><label class="full">Customer complaint<textarea id="detail-complaint" rows="3">${escapeHtml(x.complaint || "")}</textarea></label><label class="full">Technician notes<textarea id="detail-notes" rows="3">${escapeHtml(x.notes || "")}</textarea></label><section><h3>Estimate breakdown</h3><p>Labor: ${money(x.labor)} · ${Number(x.laborHours ?? 0).toFixed(2)} hours<br>Parts & supplies: ${money(x.parts)}<br>Tax: ${money(x.tax)}</p></section>${inventoryMarkup}</div><aside><label>Work status<select id="detail-status" ${canManage ? "" : "disabled"}>${["estimate", "approved", "in_progress", "waiting_parts", "completed", "invoiced"].map(s => `<option value="${s}" ${s === x.status ? "selected" : ""}>${label(s)}</option>`).join("")}</select></label>${assignment}<label>Promise time<input id="detail-promise" value="${escapeHtml(x.promise || "")}"/></label><label>Bay / assignment<select id="detail-bay"><option>Unassigned</option><option>Bay 1</option><option>Bay 2</option><option>Bay 3</option><option>Bay 4</option><option>Mobile</option></select></label>${jobClockControl}${Mileage.mileagePanelMarkup({ jobAddress: x.jobAddress || "", oneWayMiles: x.tripMilesOneWay || "", roundTrip: x.tripMiles || Mileage.roundTripMiles(x.tripMilesOneWay), rate: shopMileageRate(), charge: x.mileageCharge || Mileage.mileageCharge(x.tripMiles || Mileage.roundTripMiles(x.tripMilesOneWay), shopMileageRate()), shopAddress: shopProfile().address, canEdit: canManage })}<section><h3>Activity</h3><p>Opened in shop queue<br>Customer authorization recorded<br>${escapeHtml(x.promise)}</p></section></aside></div></div><div class="modal-actions">${canManage ? `<button class="secondary danger" id="delete-order">${icon("trash-2", 14)} Delete</button><button class="primary" id="save-order">${icon("save", 14)} Save changes</button>` : `<button class="primary" data-close>Close</button>`}</div></div>`); bindWorkOrderMileage(".modal"); if (canManage) { const baySelect = document.querySelector("#detail-bay"); if (baySelect) baySelect.value = x.bay || "Unassigned"; document.querySelector("#save-order").onclick = async event => { const button = event.currentTarget, nextStatus = document.querySelector("#detail-status").value, terminal = ["completed", "invoiced"], firstCompletion = terminal.includes(nextStatus) && !terminal.includes(x.status), previous = { status: x.status, tech: x.tech, laborHours: x.laborHours, complaint: x.complaint, notes: x.notes, promise: x.promise, bay: x.bay, mobile: x.mobile, updatedAt: x.updatedAt }; button.disabled = true; try { if (firstCompletion && !await commitLinkedInventory(x)) return; x.status = nextStatus; x.tech = document.querySelector("#detail-tech")?.value || x.tech; x.laborHours = Number(document.querySelector("#detail-hours")?.value || x.laborHours || 0); x.complaint = document.querySelector("#detail-complaint")?.value?.trim() || x.complaint; x.notes = document.querySelector("#detail-notes")?.value?.trim() || ""; x.promise = document.querySelector("#detail-promise")?.value?.trim() || x.promise; x.bay = document.querySelector("#detail-bay")?.value || x.bay; x.mobile = x.bay === "Mobile"; Object.assign(x, Mileage.applyMileageToOrder(x, { oneWayMiles: document.querySelector("#detail-one-way-miles")?.value, jobAddress: document.querySelector("#detail-job-address")?.value, rate: shopMileageRate(), taxRate: state.taxSettings.rate })); syncPayroll(x); const saved = await updateOrderInApi(x); if (saved && typeof saved === "object") Object.assign(x, saved); save(); closeModal(); toast(terminal.includes(x.status) ? `${x.id} completed and labor synced to payroll` : `${x.id} updated`); render() } catch (error) { Object.assign(x, previous); toast(error.message || "Work order could not be saved") } finally { button.disabled = false } }; } document.querySelector("#delete-order")?.addEventListener("click", () => { if (confirm(`Delete ${x.id}?`)) { state.orders = state.orders.filter(o => o.id !== id); state.payrollEntries = state.payrollEntries.filter(line => line.workOrderId !== id); state.jobClockEntries = state.jobClockEntries.filter(line => line.workOrderId !== id); deleteOrderInApi(id); save(); closeModal(); toast(`${id} deleted`); render() } }) }
function exportCsv() { const rows = [["RO", "Customer", "Vehicle", "Status", "Technician", "Promise", "Total"], ...state.orders.map(x => [x.id, x.customer, x.vehicle, label(x.status), x.tech, x.promise, x.total])], csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n"), link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = "mechpro-work-orders.csv"; link.click(); URL.revokeObjectURL(link.href); toast("Work orders exported") }
function exportLedger() { const rows = [["Date", "Reference", "Description", "Debit account", "Credit account", "Amount"], ...ledger().map(x => [x.date, x.reference || "JE", x.description, x.debitAccount, x.creditAccount, x.amount])], csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n"), link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = "mechpro-general-ledger.csv"; link.click(); URL.revokeObjectURL(link.href); toast("General ledger exported") }
function exportPayroll() { syncAllPayroll(); const period = weekPeriod(), rows = [["Employee ID", "Employee", "Pay period", "Work order", "Customer", "Hours", "Rate", "Gross pay"], ...state.payrollEntries.filter(line => line.periodKey === period.key).map(line => { const user = state.users.find(item => item.id === line.employeeId); return [user?.employeeId || "", user?.name || "", `${period.start} - ${period.end}`, line.roNumber, line.customer, line.hours, line.rate, line.amount] })], csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n"), link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `mechpro-payroll-${period.key}.csv`; link.click(); URL.revokeObjectURL(link.href); toast("Weekly payroll register exported") }
function scheduleWorkspace() { const rows = [...state.appointments].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).map(item => `<tr class="clickable-row" data-edit-appointment="${item.id}"><td><b>${escapeHtml(item.date)}</b><small>${escapeHtml(item.time)}</small></td><td>${escapeHtml(item.customer)}<small>${escapeHtml(item.vehicle)}</small></td><td>${escapeHtml(item.service)}</td><td>${escapeHtml(item.tech || "Unassigned")}<small>${escapeHtml(item.bay || "Unassigned")}</small></td><td><span class="badge ${item.status === "completed" ? "paid" : "approved"}">${escapeHtml(item.status)}</span></td><td><button class="mini-action" data-edit-appointment-button="${item.id}">${icon("pencil", 13)} Edit</button></td></tr>`).join(""); return shell(`${heading(shopDayLabel(), "Schedule", "Bay appointments and mobile service calls. Add real bookings here — the decorative week grid has been removed.", false)}<div class="ops-actions"><button class="primary" id="add-appointment">${icon("calendar-plus", 14)} New appointment</button></div><div class="data-panel schedule-table"><table><thead><tr><th>Date & time</th><th>Customer & vehicle</th><th>Service</th><th>Assignment</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No appointments scheduled yet. Use <b>New appointment</b> to book the first one.</td></tr>`}</tbody></table></div>`) }
function openAppointmentForm(existing = null) { const statuses = ["scheduled", "confirmed", "completed", "cancelled"]; showModal(`<form class="modal" id="appointment-form"><div class="modal-head"><h2>${existing ? "Edit" : "New"} appointment</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Customer<select name="customer">${customerOptions(existing?.customer)}</select></label><label>Vehicle<input name="vehicle" required value="${escapeHtml(existing?.vehicle || "")}"/></label><label>Date<input name="date" type="date" required value="${existing?.date || ""}"/></label><label>Time<input name="time" type="time" required value="${existing?.time || ""}"/></label><label>Service<input name="service" required value="${escapeHtml(existing?.service || "")}"/></label><label>Technician<input name="tech" value="${escapeHtml(existing?.tech || "")}"/></label><label>Bay / mobile<input name="bay" value="${escapeHtml(existing?.bay || "")}"/></label><label>Status<select name="status">${statuses.map(status => `<option ${existing?.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Save appointment</button></div></form>`); document.querySelector("#appointment-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), record = { ...(existing || {}), id: existing?.id || `appointment-${Date.now()}`, ...data, createdAt: existing?.createdAt || now(), updatedAt: existing ? now() : undefined }; await saveShopEntity("appointments", record); closeModal(); toast("Appointment saved"); render() } }
function addAppointment() { openAppointmentForm() }
function operationsAnalytics() { const revenue = paymentRecords().reduce((sum, item) => sum + Number(item.amount || 0), 0), inventoryValue = state.inventory.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.cost || 0), 0), completed = state.orders.filter(item => ["completed", "invoiced"].includes(item.status)), customers = [...state.customers].sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0)).slice(0, 5), techs = state.users.filter(user => user.techName).map(user => ({ name: user.techName, jobs: completed.filter(order => order.tech === user.techName).length, hours: state.jobClockEntries.filter(entry => entry.userId === user.id && entry.clockOut).reduce((sum, entry) => sum + Number(entry.hours || 0), 0) })); return `<div class="finance-kpis"><article><span>Cash received</span><strong>${money(revenue)}</strong></article><article><span>Open receivables</span><strong>${money(finance().receivable)}</strong></article><article><span>Inventory value</span><strong>${money(inventoryValue)}</strong></article><article><span>Low stock</span><strong>${state.inventory.filter(item => Number(item.quantity) <= Number(item.reorderLevel)).length}</strong></article><article><span>Reminders due</span><strong>${state.reminders.filter(item => !item.sentAt).length}</strong></article></div><div class="accounting-grid"><section class="statement"><div class="statement-head"><h2>Technician productivity</h2></div>${techs.map(tech => `<div class="statement-line"><span>${escapeHtml(tech.name)} · ${tech.hours.toFixed(2)} tracked hr</span><b>${tech.jobs} completed</b></div>`).join("") || "No completed technician work."}</section><section class="statement"><div class="statement-head"><h2>Customer lifetime value</h2></div>${customers.map(customer => `<div class="statement-line"><span>${escapeHtml(customer.name)}</span><b>${money(Number(customer.spend || 0))}</b></div>`).join("")}</section></div>` }
const baseShopOperations = shopOperations;
shopOperations = function () { if (shopOpsTab !== "analytics") return baseShopOperations().replace("OBD-II</button></div>", "OBD-II</button><button class=\"tab\" data-ops-tab=\"analytics\">Analytics</button></div>"); return shell(`${heading("Connected workflow", "Shop operations", "Linked operational records and performance.", false)}<div class="accounting-tabs ops-tabs">${[["vehicles", "Vehicles"], ["inspections", "Inspections"], ["inventory", "Inventory"], ["services", "Canned services"], ["reminders", "Reminders"], ["diagnostics", "OBD-II"], ["analytics", "Analytics"]].map(tab => `<button class="tab ${shopOpsTab === tab[0] ? "active" : ""}" data-ops-tab="${tab[0]}">${tab[1]}</button>`).join("")}</div>${operationsAnalytics()}`) };
function openEstimateDiscount(id) { const estimate = state.estimates.find(item => item.id === id); showModal(`<form class="modal" id="estimate-discount-form"><div class="modal-head"><h2>Estimate discount</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><label>Discount percent<input name="discount" type="number" min="0" max="100" step=".1" value="${Number(estimate.discountPercent || 0)}" required/></label><label>Reason<input name="discountReason" value="${escapeHtml(estimate.discountReason || "")}"/></label></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Apply discount</button></div></form>`); document.querySelector("#estimate-discount-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), percent = Math.min(100, Math.max(0, Number(data.discount))), base = Number(estimate.originalSubtotal ?? estimate.subtotal); estimate.originalSubtotal = base; estimate.discountPercent = percent; estimate.discountReason = data.discountReason.trim(); estimate.discountAmount = Math.round(base * percent) / 100; estimate.subtotal = Math.round((base - estimate.discountAmount) * 100) / 100; estimate.tax = Math.round(estimate.subtotal * Number(estimate.taxRate || state.taxSettings.rate) / 100 * 100) / 100; estimate.total = Math.round((estimate.subtotal + estimate.tax) * 100) / 100; await updateEstimateInApi(estimate); save(); closeModal(); toast("Estimate discount applied"); render() } }
async function decideEstimate(id, status) { const estimate = state.estimates.find(item => item.id === id), note = prompt(`${status === "declined" ? "Decline" : "Approval"} note:`, ""); if (note === null) return; estimate.status = status; estimate.decisionNote = note.trim(); estimate.decidedAt = now(); estimate.decidedBy = currentUser().id; await updateEstimateInApi(estimate); save(); toast(`${estimate.number} ${status}`); render() }
savedEstimates = function () { const rows = [...state.estimates].reverse().map(estimate => `<tr><td class="mono"><b>${estimate.number}</b></td><td>${escapeHtml(estimate.customer)}<small>${escapeHtml(estimate.vehicle)}</small></td><td><span class="badge ${estimate.status === "approved" ? "paid" : estimate.status === "declined" ? "overdue" : "estimate"}">${escapeHtml(estimate.status)}</span><small>${escapeHtml(estimate.decisionNote || "")}</small></td><td><b>${money(estimate.total)}</b><small>${estimate.discountPercent ? `${estimate.discountPercent}% discount · ${escapeHtml(estimate.discountReason || "")}` : "No discount"}</small></td><td><div class="estimate-actions"><button class="mini-action" data-estimate-discount="${estimate.id}">${icon("percent", 13)} Discount</button><button class="mini-action" data-send-estimate="${estimate.id}" data-channel="email">${icon("mail", 13)} Email</button>${estimate.status === "pending" ? `<button class="mini-action" data-sign-estimate="${estimate.id}">${icon("signature", 13)} Sign</button><button class="mini-action danger" data-estimate-decline="${estimate.id}">${icon("circle-x", 13)} Decline</button>` : ""}</div></td></tr>`).join(""); return `<section class="ai-result"><div class="ai-result-head"><div><div class="eyebrow">Customer estimates</div><h2>Estimate register</h2><p>Discount, send, approve with a signature, or record a declined decision.</p></div></div><div class="data-panel"><table><thead><tr><th>Estimate</th><th>Customer & vehicle</th><th>Decision</th><th>Total</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No saved estimates.</td></tr>`}</tbody></table></div></section>` };
const bindEstimateActionsCore = bindEstimateActions;
bindEstimateActions = function () { bindEstimateActionsCore(); document.querySelectorAll("[data-estimate-discount]").forEach(button => button.onclick = () => openEstimateDiscount(button.dataset.estimateDiscount)); document.querySelectorAll("[data-estimate-decline]").forEach(button => button.onclick = () => decideEstimate(button.dataset.estimateDecline, "declined")) };
/* removed duplicate shopProfile */

settings = function () { const profile = shopProfile(), t = state.taxSettings, stateOptions = usStates.map(s => `<option value="${s.code}" ${t.state === s.code ? "selected" : ""}>${s.name}</option>`).join(""); return shell(`${heading("Administration", "Shop settings", "Branding, invoice defaults, tax, and optional provider readiness.", false)}<form class="settings-panel form-grid" id="shop-profile-form"><label>Shop name<input name="shopName" value="${escapeHtml(profile.shopName)}" required/></label><label>Phone<input name="phone" value="${escapeHtml(profile.phone)}"/></label><label class="full">Address<input name="address" value="${escapeHtml(profile.address)}"/></label><label>Logo URL<input name="logoUrl" type="url" value="${escapeHtml(profile.logoUrl)}"/></label><label>Default labor rate<input name="laborRate" type="number" step=".01" value="${Number(profile.laborRate)}"/></label><label>Mileage rate ($/mi)<input name="mileageRate" type="number" min="0" step=".01" value="${Number(profile.mileageRate ?? 0.68)}"/></label><label class="full">Invoice footer<input name="invoiceFooter" value="${escapeHtml(profile.invoiceFooter)}"/></label><div class="full service-contract"><h2>Commercial integrations</h2><p>CarFax service history and license-plate recognition require provider contracts and server-side credentials. They remain unavailable until configured by the platform operator.</p></div><label class="toggle-field"><input type="checkbox" disabled ${profile.carfaxEnabled ? "checked" : ""}/><span>CarFax provider configured</span></label><label class="toggle-field"><input type="checkbox" disabled ${profile.plateProviderEnabled ? "checked" : ""}/><span>Plate recognition configured</span></label><div class="full"><button class="primary">${icon("save", 14)} Save business profile</button></div></form><div class="settings-panel"><form class="form-grid" id="tax-settings-form"><label>Filing state<select name="state">${stateOptions}</select></label><label>State tax ID<input name="taxId" value="${escapeHtml(t.taxId)}"/></label><label>Sales tax rate %<input name="rate" type="number" step=".01" min="0" value="${t.rate}"/></label><label>Filing frequency<select name="filingFrequency"><option ${t.filingFrequency === "Monthly" ? "selected" : ""}>Monthly</option><option ${t.filingFrequency === "Quarterly" ? "selected" : ""}>Quarterly</option><option ${t.filingFrequency === "Annually" ? "selected" : ""}>Annually</option></select></label><div class="full"><button class="primary">Save tax settings</button></div></form></div>`) };
function bindExpandedFeatures() { document.querySelector("#add-appointment")?.addEventListener("click", addAppointment); document.querySelectorAll("[data-edit-appointment]").forEach(row => row.onclick = () => openAppointmentForm(state.appointments.find(item => item.id === row.dataset.editAppointment))); document.querySelectorAll("[data-edit-appointment-button]").forEach(button => button.onclick = event => { event.stopPropagation(); openAppointmentForm(state.appointments.find(item => item.id === button.dataset.editAppointmentButton)) }); document.querySelector("#shop-profile-form")?.addEventListener("submit", async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), profile = { ...shopProfile(), ...data, laborRate: Number(data.laborRate) }; await saveShopEntity("shopsettings", profile); toast("Business profile saved"); render() }) }
const scheduleCore = schedule;
schedule = function () { return scheduleWorkspace() };
newOrderEstimateRow = function (line = { service: "Custom service", notes: "Describe the inspection, labor, parts, and verification included with this service.", hours: 1, parts: 0, discount: 0 }) { const inventoryOptions = state.inventory.map(item => `<option value="${escapeHtml(item.id)}" ${line.inventoryId === item.id ? "selected" : ""}>${escapeHtml(item.sku || "No SKU")} · ${escapeHtml(item.name)} (${Number(item.quantity || 0)} on hand)</option>`).join(""); return `<article class="new-estimate-line"><div class="estimate-line-head"><strong>Service line</strong><button class="icon-button remove-estimate-line" type="button" title="Remove service">${icon("trash-2", 14)}</button></div><label>Service<input class="estimate-service" value="${escapeHtml(line.service)}" required/></label><label>What this service includes<textarea class="estimate-explanation" required>${escapeHtml(line.notes || line.description || "")}</textarea></label><div class="estimate-line-numbers"><label>Labor hours<input class="estimate-hours" type="number" min="0" step=".25" value="${Number(line.hours || line.laborHours || 0)}"/></label><label>Parts & materials<input class="estimate-parts" type="number" min="0" step=".01" value="${Number(line.parts ?? line.partsPrice ?? 0).toFixed(2)}"/></label><label>Discount %<input class="estimate-discount" type="number" min="0" max="100" step=".1" value="${Number(line.discount || 0)}"/></label><label>Inventory SKU<select class="estimate-inventory"><option value="">Not linked</option>${inventoryOptions}</select></label><label>Committed quantity<input class="estimate-committed-quantity" type="number" min=".01" step=".01" value="${Number(line.committedQuantity || 1)}"/></label><div><span>Line total</span><b class="estimate-line-total">${money((Number(line.hours || line.laborHours || 0) * 165 + Number(line.parts ?? line.partsPrice ?? 0)) * (1 - Number(line.discount || 0) / 100))}</b></div></div></article>` };
readNewOrderEstimate = function () { const lines = [...document.querySelectorAll(".new-estimate-line")].map(row => { const hours = Math.max(0, Number(row.querySelector(".estimate-hours").value) || 0), parts = Math.max(0, Number(row.querySelector(".estimate-parts").value) || 0), discount = Math.min(100, Math.max(0, Number(row.querySelector(".estimate-discount").value) || 0)), inventoryId = row.querySelector(".estimate-inventory").value, inventory = state.inventory.find(item => item.id === inventoryId), committedQuantity = inventory ? Math.max(0, Number(row.querySelector(".estimate-committed-quantity").value) || 0) : 0, labor = Math.round(hours * 165 * 100) / 100, gross = labor + parts, total = Math.round(gross * (1 - discount / 100) * 100) / 100; return { service: row.querySelector(".estimate-service").value.trim(), explanation: row.querySelector(".estimate-explanation").value.trim(), hours, laborRate: 165, labor, parts, discount, discountAmount: Math.round((gross - total) * 100) / 100, total, inventoryId: inventory?.id || null, inventorySku: inventory?.sku || null, committedQuantity } }).filter(line => line.service), labor = lines.reduce((sum, line) => sum + line.labor, 0), laborHours = lines.reduce((sum, line) => sum + line.hours, 0), parts = lines.reduce((sum, line) => sum + line.parts, 0), discountAmount = lines.reduce((sum, line) => sum + line.discountAmount, 0), shopSupplies = lines.length ? 12 : 0, subtotal = Math.round((labor + parts - discountAmount + shopSupplies) * 100) / 100, tax = Math.round(subtotal * state.taxSettings.rate) / 100, total = Math.round((subtotal + tax) * 100) / 100; return { lines, labor, laborHours, parts, discountAmount, fees: shopSupplies ? [{ description: "Shop supplies", amount: shopSupplies }] : [], subtotal, tax, taxRate: state.taxSettings.rate, total } };
refreshNewOrderEstimate = function () { const form = document.querySelector("#new-form"), trip = Mileage.refreshMileagePreview(form, { rate: shopMileageRate() }), estimate = Mileage.applyMileageToEstimate(readNewOrderEstimate(), trip.roundTrip, shopMileageRate(), state.taxSettings.rate); document.querySelectorAll(".new-estimate-line").forEach(row => { const hours = Math.max(0, Number(row.querySelector(".estimate-hours").value) || 0), parts = Math.max(0, Number(row.querySelector(".estimate-parts").value) || 0), discount = Math.min(100, Math.max(0, Number(row.querySelector(".estimate-discount").value) || 0)); row.querySelector(".estimate-line-total").textContent = money((hours * 165 + parts) * (1 - discount / 100)) }); const summary = document.querySelector("#new-estimate-summary"); if (summary) summary.innerHTML = `<span>Labor <b>${money(estimate.labor)}</b></span><span>Parts <b>${money(estimate.parts)}</b></span><span>Discount <b>-${money(estimate.discountAmount)}</b></span><span>Tax <b>${money(estimate.tax)}</b></span><strong>Total ${money(estimate.total)}</strong>`; const total = document.querySelector("#new-estimate-total"); if (total) total.value = estimate.total.toFixed(2) };
const bindNewOrderEstimatorCore = bindNewOrderEstimator;
bindNewOrderEstimator = function () { bindNewOrderEstimatorCore(); const lines = document.querySelector("#new-estimate-lines"); const canned = visibleCannedServices(); if (!lines || !canned.length) return; const picker = cannedServiceGroups(canned).map(group => `<div class="canned-service-picker"><span>${escapeHtml(group.label)}</span>${group.items.map(service => `<button type="button" class="mini-action" data-add-canned-service="${escapeAttr(service.id)}">${escapeHtml(service.name)} · ${money(Number(service.menuPrice ?? service.partsPrice ?? 0))}</button>`).join("")}</div>`).join(""); lines.insertAdjacentHTML("beforebegin", picker); document.querySelectorAll("[data-add-canned-service]").forEach(button => button.onclick = () => { const service = visibleCannedServices().find(item => item.id === button.dataset.addCannedService); if (!service) return; lines.insertAdjacentHTML("beforeend", newOrderEstimateRow(estimateLineFromService(service))); bindNewOrderEstimatorCore(); toast(`${service.name} added to estimate`) }) };
function customerBalance(name) { return getFinanceDerived().balanceByCustomer.get(name) || 0 }
function openCustomerRecord(name) { const customer = state.customers.find(c => c.name === name); if (!customer) return; const vehicles = state.vehicles.filter(v => v.customer === name), orders = state.orders.filter(o => o.customer === name), invs = state.invoices.filter(i => i.customer === name), payments = state.payments.filter(p => p.customer === name), balance = customerBalance(name); showModal(`<div class="modal wide" id="customer-detail"><div class="modal-head"><h2>${escapeHtml(customer.name)}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="customer-detail-top"><div class="avatar">${initials(customer.name)}</div><div><p>${escapeHtml(customer.phone || "")} · ${escapeHtml(customer.email || "")}</p><p class="customer-balance ${balance > 0 ? "has-balance" : ""}">Account balance: <b>${money(balance)}</b></p></div><div class="customer-detail-actions"><button class="secondary" id="cd-message">${icon("send", 14)} Message</button><button class="secondary" id="cd-statement">${icon("printer", 14)} Statement</button></div></div><div class="form-grid"><label>Billing address<textarea name="billingAddress" rows="2">${escapeHtml(customer.billingAddress || "")}</textarea></label><label>Billing notes<textarea name="billingNotes" rows="2">${escapeHtml(customer.billingNotes || "")}</textarea></label><div class="full"><button class="mini-action" id="cd-save-billing">${icon("save", 13)} Save billing</button></div></div><h3>Vehicles (${vehicles.length})</h3><table class="mini-table"><thead><tr><th>Vehicle</th><th>VIN</th><th>Mileage</th></tr></thead><tbody>${vehicles.map(v => `<tr class="clickable-row" data-cd-vehicle="${v.id}"><td><b>${escapeHtml(vehicleLabel(v))}</b></td><td class="mono">${escapeHtml(v.vin || "")}</td><td>${v.mileage || ""}</td></tr>`).join("") || `<tr><td colspan="3">No vehicles linked</td></tr>`}</tbody></table><h3>Work Orders (${orders.length})</h3><table class="mini-table"><thead><tr><th>RO</th><th>Status</th><th>Total</th></tr></thead><tbody>${orders.slice(0, 10).map(o => `<tr><td class="mono">${o.id}</td><td>${badge(o.status)}</td><td>${money(o.total)}</td></tr>`).join("") || `<tr><td colspan="3">No work orders</td></tr>`}</tbody></table><h3>Invoices (${invs.length})</h3><table class="mini-table"><thead><tr><th>Invoice</th><th>Status</th><th>Amount</th><th>Balance</th></tr></thead><tbody>${invs.map(i => `<tr><td class="mono">${i.number}</td><td>${badge(i.status)}</td><td>${money(i.amount)}</td><td>${money(invoiceBalance(i))}</td></tr>`).join("") || `<tr><td colspan="4">No invoices</td></tr>`}</tbody></table><h3>Payments (${payments.length})</h3><table class="mini-table"><thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Invoice</th></tr></thead><tbody>${payments.slice(0, 10).map(p => `<tr><td>${p.receivedAt || ""}</td><td>${p.method || ""}</td><td>${money(p.amount)}</td><td class="mono">${p.invoiceNumber || ""}</td></tr>`).join("") || `<tr><td colspan="4">No payments</td></tr>`}</tbody></table></div></div>`); document.querySelector("#cd-message")?.addEventListener("click", () => { closeModal(); openCustomerMessage(customer.name, customer.phone, customer.email) }); document.querySelector("#cd-statement")?.addEventListener("click", () => printCustomerStatement(customer.name)); document.querySelector("#cd-save-billing")?.addEventListener("click", async () => { const modal = document.querySelector("#customer-detail"); customer.billingAddress = modal.querySelector("[name=billingAddress]").value.trim(); customer.billingNotes = modal.querySelector("[name=billingNotes]").value.trim(); save(); try { await apiFetch(`/entities/customers/${encodeURIComponent(customer.name)}`, { method: "PUT", body: JSON.stringify(customer) }) } catch { } toast("Billing info saved") }); document.querySelectorAll("[data-cd-vehicle]").forEach(row => row.onclick = () => { closeModal(); openVehicleDetail(row.dataset.cdVehicle) }) }
function printCustomerStatement(name) { const invs = state.invoices.filter(i => i.customer === name), payments = state.payments.filter(p => p.customer === name), balance = customerBalance(name), profile = shopProfile(); const win = window.open("", "_blank"); win.document.write(`<!DOCTYPE html><html><head><title>Statement — ${name}</title><style>body{font:12px/1.6 system-ui,sans-serif;max-width:800px;margin:auto;padding:20px}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;font-size:11px}th{background:#f5f5f5;font-weight:700}.total{font-weight:700;font-size:14px}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(profile.shopName)}</h1><p>${escapeHtml(profile.address || "")} · ${escapeHtml(profile.phone || "")}</p><h2>Customer Statement: ${escapeHtml(name)}</h2><p>Generated ${new Date().toLocaleDateString()}</p><h3>Invoices</h3><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Amount</th><th>Balance</th></tr></thead><tbody>${invs.map(i => `<tr><td>${i.number}</td><td>${i.date}</td><td>${i.status}</td><td>$${i.amount.toFixed(2)}</td><td>$${invoiceBalance(i).toFixed(2)}</td></tr>`).join("")}</tbody></table><h3>Payments</h3><table><thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Invoice</th></tr></thead><tbody>${payments.map(p => `<tr><td>${p.receivedAt || ""}</td><td>${p.method || ""}</td><td>$${p.amount.toFixed(2)}</td><td>${p.invoiceNumber || ""}</td></tr>`).join("")}</tbody></table><p class="total">Account Balance: $${balance.toFixed(2)}</p><button onclick="window.print()">Print</button></body></html>`); win.document.close() }
function openVehicleDetail(id) { const vehicle = state.vehicles.find(v => v.id === id); if (!vehicle) return; const history = linkedOrders(vehicle), photos = vehicle.photoKeys || []; showModal(`<div class="modal wide" id="vehicle-detail"><div class="modal-head"><h2>${escapeHtml(vehicleLabel(vehicle))}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Owner<input value="${escapeHtml(vehicle.customer)}" disabled/></label><label>VIN<input value="${escapeHtml(vehicle.vin || "")}" disabled/></label><label>Plate<input value="${escapeHtml(vehicle.plate || "")}" disabled/></label><label>Mileage<input value="${vehicle.mileage || ""}" disabled/></label><label>Next service<input value="${vehicle.nextServiceDate || ""}" disabled/></label><label>Notes<input value="${escapeHtml(vehicle.notes || "")}" disabled/></label></div>${photos.length ? `<h3>Photos</h3><div class="vehicle-photo-thumbs">${photos.map(key => `<img src="${cloudflareConfig.apiUrl}/files/${encodeURIComponent(key)}" alt="Vehicle photo" class="vehicle-thumb"/>`).join("")}</div>` : ""}<h3>Service History (${history.length})</h3><table class="mini-table"><thead><tr><th>RO</th><th>Status</th><th>Vehicle</th><th>Total</th></tr></thead><tbody>${history.map(o => `<tr><td class="mono">${o.id}</td><td>${badge(o.status)}</td><td>${escapeHtml(o.vehicle)}</td><td>${money(o.total)}</td></tr>`).join("") || `<tr><td colspan="4">No service history</td></tr>`}</tbody></table><div class="modal-actions"><button class="secondary" id="vd-edit">${icon("pencil", 14)} Edit vehicle</button></div></div></div>`); document.querySelector("#vd-edit")?.addEventListener("click", () => { closeModal(); openVehicleForm(vehicle) }) }
const renderCore = render;
function attachShopOperationsRoute() { const firstNav = document.querySelector(".sidebar .nav"); if (!firstNav || currentUser()?.role === "super_admin" || document.querySelector('.sidebar [data-route="shopops"]')) return; firstNav.insertAdjacentHTML("beforeend", nav("shopops", "blocks", "Shop operations")); const button = firstNav.querySelector('[data-route="shopops"]'); button.onclick = async () => { state.route = "shopops"; save(); render(); await loadShopEntities(); render() } }
render = function () { applyAppearance(shopProfile().themeMode); if (currentUser() && state.route === "shopops") { const root = document.querySelector("#root"); root.innerHTML = safeHtml(shopOperations()); lucide.createIcons(); bind(); bindShopOperations(); bindExpandedFeatures(); attachShopOperationsRoute(); return } renderCore(); bindExpandedFeatures(); attachShopOperationsRoute() };

async function resolveAuthenticatedProfile(session) { const claims = session.claims, normalized = String(claims.email || "").trim().toLowerCase(), role = sessionClaimRole(claims); sessionStorage.setItem(storageKeys.session, JSON.stringify(session)); pendingAuthProfile = null; if (role === "super_admin") { const local = state.users.find(user => String(user.email || "").trim().toLowerCase() === normalized); if (local) return Object.assign(local, { role: "super_admin", active: true }); const created = { id: `super-admin-${claims.sub}`, name: claims.name || "Platform Administrator", email: normalized, role: "super_admin", title: "Platform Administrator", active: true }; state.users.push(created); save(); return created } let employees = []; try { employees = await apiFetch("/entities/employees") } catch (error) { const local = state.users.find(user => String(user.email || "").trim().toLowerCase() === normalized); if (local?.active) { state.users = sanitizeUsers(state.users); return local } if (error instanceof TypeError) throw new Error("Could not reach MechPro. Sign in from the online desktop window or check your internet connection."); throw error } const active = employees.find(user => user.active && String(user.email || "").trim().toLowerCase() === normalized); if (active) { state.users = sanitizeUsers(employees); return active } const inactive = employees.find(user => !user.active && String(user.email || "").trim().toLowerCase() === normalized); if (inactive) { pendingAuthProfile = { email: normalized, role, reason: "deactivated", name: inactive.name || claims.name || normalized }; state.users = sanitizeUsers(employees); return null } if (role === "admin") { const profile = await apiFetch("/entities/employees", { method: "POST", body: JSON.stringify({ id: `owner-${sessionClaimShopId(claims)}`, name: claims.name || normalized.split("@")[0], email: normalized, role: "admin", title: "Owner", department: "Administration", active: true, createdAt: now() }) }); state.users = sanitizeUsers([...employees, profile]); return profile } const localSeed = state.users.find(user => user.active && String(user.email || "").trim().toLowerCase() === normalized); if (localSeed) { state.users = sanitizeUsers([...employees.filter(item => String(item.email || "").trim().toLowerCase() !== normalized), localSeed]); return localSeed } pendingAuthProfile = { email: normalized, role, reason: "missing", name: claims.name || normalized.split("@")[0] }; state.users = sanitizeUsers(employees); return null }
function pendingProfileScreen() { const pending = pendingAuthProfile || {}; return `<main class="login-screen"><section class="login-panel"><div class="brand login-brand"><div class="brand-mark">${icon("wrench")}</div><div><div class="brand-name">MechPro</div><small>Account almost ready</small></div></div><div class="eyebrow">Employee profile required</div><h1>${pending.reason === "deactivated" ? "Your shop profile is deactivated" : "Ask an admin to finish setup"}</h1><p>${pending.reason === "deactivated" ? `The Cloudflare Access identity <strong>${escapeHtml(pending.email || "")}</strong> works, but the matching employee profile is inactive.` : `You signed in as <strong>${escapeHtml(pending.email || "")}</strong> (${escapeHtml(roleLabel[pending.role] || pending.role || "team member")}), but this shop does not have an active employee profile for that email yet.`}</p><div class="service-contract"><p>Ask a shop administrator to open <b>Employees</b> and create (or reactivate) a profile using exactly this email:</p><code>${escapeHtml(pending.email || "")}</code></div><div class="modal-actions" style="justify-content:flex-start;margin-top:18px"><button class="primary" id="pending-sign-out">${icon("log-out", 14)} Sign out</button></div></section></main>` }
const bindBeforeProfileSync = bind;
bind = function () { bindBeforeProfileSync(); const original = document.querySelector("#login-form"); if (!original) { document.querySelector("#pending-sign-out")?.addEventListener("click", () => { pendingAuthProfile = null; signOutApiRequest(); clearAuthSession(); state.currentUserId = null; save(); render() }); return } const form = original.cloneNode(true); original.replaceWith(form); form.addEventListener("submit", async event => { event.preventDefault(); const errorEl = form.querySelector("#login-error"), sentEl = form.querySelector("#login-sent"), submitButton = form.querySelector("button[type=submit]"), emailInput = form.querySelector("#login-email"); errorEl.hidden = true; if (sentEl) sentEl.hidden = true; submitButton.disabled = true; desktopEntitlementVerified = !isDesktopApp; try { if (isOfflineDesktop()) { const data = Object.fromEntries(new FormData(form)); if (!offlineAccountReady && data.password !== data.confirm) throw new Error("Those passwords do not match."); const account = offlineAccountReady ? await window.mechproDesktop.localAuth.signIn({ email: data.email, password: data.password }) : await window.mechproDesktop.localAuth.create({ name: data.name, email: data.email, password: data.password }); const session = offlineSession(account); sessionStorage.setItem(storageKeys.session, JSON.stringify(session)); const user = ensureOfflineOwner(state, account); pendingAuthProfile = null; state.currentUserId = user.id; desktopEntitlementVerified = true; offlineAccountReady = true; offlineAccountEmail = account.email; state.route = roleRoutes[user.role]?.[0] || "home"; query = ""; save(); render(); return } if (!navigator.onLine && !isLocalShell()) throw new Error("An internet connection is required to sign in."); if (isLocalShell()) { const session = await cloudflareSignIn(); if (isDesktopApp) await verifyDesktopEntitlement(); const user = await resolveAuthenticatedProfile(session); if (!user) { state.currentUserId = null; save(); render(); return } pendingAuthProfile = null; state.currentUserId = user.id; state.route = roleRoutes[user.role]?.[0] || "dispatch"; query = ""; save(); await Promise.all([loadCustomersFromApi(), loadOrdersFromApi(), loadInvoicesFromApi(), loadPaymentsFromApi(), loadExpensesFromApi(), loadEstimatesFromApi(), loadShiftEntriesFromApi(), loadJobClockEntriesFromApi(), loadPayrollEntriesFromApi(), loadShopEntities()]); render(); return } const email = String(emailInput?.value || "").trim().toLowerCase(); if (!email) throw new Error("Enter your work email to continue."); const result = await requestMagicLinkSignIn(email); if (result?.redirecting) return; if (result?.sent) { if (sentEl) { sentEl.textContent = result.message || "Check your email for a sign-in link. It expires in 15 minutes."; sentEl.hidden = false } submitButton.disabled = false; submitButton.textContent = "Resend sign-in link"; return } throw new Error("Check your email for a sign-in link."); } catch (error) { clearAuthSession(); pendingAuthProfile = null; desktopEntitlementVerified = !isDesktopApp; desktopLoginMessage = isDesktopApp ? error.message : ""; errorEl.textContent = error.message || "Sign-in failed."; errorEl.hidden = false; submitButton.disabled = false } }) };

const shopProfileDefaults = { id: "profile", shopName: "Your Car Guy", phone: "555-0100", address: "100 Demo Street, Example City, TX 00000", laborRate: 140, mileageRate: 0.68, invoiceFooter: "Thank you for your business.", logoUrl: "https://www.yourcarguy806.com/assets/reliable-logo.jpg", brandColor: "#087e6a", accentColor: "#ffd34e", themeMode: "device", coupons: [], defaultVendor: "", defaultVendorByKind: {}, carfaxEnabled: false, plateProviderEnabled: false };
function safeHexColor(value, fallback) { const color = String(value || "").trim(); return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback }
function safeHttpUrl(value) { const source = String(value || "").trim(); if (!source) return ""; try { const url = new URL(source, globalThis.location?.href || "https://local.invalid/"); return ["http:", "https:"].includes(url.protocol) ? url.href : "" } catch { return "" } }
function normalizedCoupons(value) { return (Array.isArray(value) ? value : []).map(coupon => ({ id: String(coupon.id || `coupon-${Date.now()}`), code: String(coupon.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24), percent: Math.min(100, Math.max(0, Number(coupon.percent) || 0)), active: coupon.active !== false })).filter(coupon => coupon.code && coupon.percent > 0) }
function shopProfile() { const stored = state.shopSettingsRecords.find(item => item.id === "profile") || {}, themeMode = ["device", "light", "dark"].includes(stored.themeMode) ? stored.themeMode : "device"; return { ...shopProfileDefaults, ...stored, logoUrl: safeHttpUrl(stored.logoUrl) || shopProfileDefaults.logoUrl, brandColor: safeHexColor(stored.brandColor, shopProfileDefaults.brandColor), accentColor: safeHexColor(stored.accentColor, shopProfileDefaults.accentColor), themeMode, coupons: normalizedCoupons(stored.coupons), defaultVendor: String(stored.defaultVendor || ""), defaultVendorByKind: stored.defaultVendorByKind && typeof stored.defaultVendorByKind === "object" ? stored.defaultVendorByKind : {} } }

function shopMileageRate() { return Mileage.normalizeMileageRate(shopProfile().mileageRate) }
function bindWorkOrderMileage(rootSelector) {
  const root = typeof rootSelector === "string" ? document.querySelector(rootSelector) : rootSelector;
  if (!root || root.dataset.mileageBound === "1") return;
  root.dataset.mileageBound = "1";
  const rate = () => shopMileageRate();
  const refresh = () => {
    Mileage.refreshMileagePreview(root, { rate: rate() });
    if (root.id === "new-form") refreshNewOrderEstimate();
  };
  root.querySelectorAll("#detail-one-way-miles, #new-one-way-miles, [name=tripMilesOneWay]").forEach(input => input.addEventListener("input", refresh));
  refresh();
  const calcButton = root.querySelector("#calculate-mileage, #new-calculate-mileage");
  const status = root.querySelector("#mileage-status, #new-mileage-status");
  calcButton?.addEventListener("click", async () => {
    const jobAddress = root.querySelector("#detail-job-address, [name=jobAddress]")?.value?.trim() || "";
    const shopAddress = shopProfile().address || "";
    if (!jobAddress) { toast("Enter the job site address first"); return }
    if (!shopAddress) { toast("Set the shop address in Settings before calculating mileage"); return }
    calcButton.disabled = true;
    if (status) status.textContent = "Calculating…";
    try {
      const result = await apiFetch("/mileage/calculate", { method: "POST", body: JSON.stringify({ from: shopAddress, to: jobAddress }) });
      const oneWay = Mileage.normalizeOneWayMiles(result?.oneWayMiles);
      const oneWayInput = root.querySelector("#detail-one-way-miles, #new-one-way-miles, [name=tripMilesOneWay]");
      if (oneWayInput) oneWayInput.value = String(oneWay);
      refresh();
      if (status) status.textContent = result?.source ? `Calculated via ${result.source}` : "Calculated";
      toast(`Round trip ${Mileage.roundTripMiles(oneWay).toFixed(1)} mi @ $${rate().toFixed(2)}/mi`);
    } catch (error) {
      if (status) status.textContent = "";
      toast(error.message || "Could not calculate mileage. Enter one-way miles manually.");
    } finally {
      calcButton.disabled = false;
    }
  });
}

function applyAppearance(mode = shopProfile().themeMode) { const selected = ["device", "light", "dark"].includes(mode) ? mode : "device", resolved = selected === "device" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : selected; document.documentElement.dataset.theme = resolved; document.documentElement.dataset.themeMode = selected; document.documentElement.style.colorScheme = resolved; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#111b20" : "#18252b"); return resolved }
const appearanceMedia = matchMedia("(prefers-color-scheme: dark)"); appearanceMedia.addEventListener?.("change", () => { if (document.documentElement.dataset.themeMode === "device") applyAppearance("device") }); applyAppearance();
function printableBrand(profile = shopProfile()) { const brand = safeHexColor(profile.brandColor, shopProfileDefaults.brandColor), accent = safeHexColor(profile.accentColor, shopProfileDefaults.accentColor), logo = safeHttpUrl(profile.logoUrl); return { brand, accent, logo, style: `:root{--brand:${brand};--accent:${accent}}.print-brand{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding-bottom:14px;border-bottom:4px solid var(--brand)}.print-brand img{max-width:150px;max-height:72px;object-fit:contain}.print-brand h1{margin:0;color:var(--brand)}.print-brand p{margin:3px 0}.print-accent{height:6px;background:var(--accent)}button{padding:7px 12px;border:1px solid var(--brand);color:#fff;background:var(--brand);cursor:pointer}@media print{button{display:none}}`, header: `<div class="print-accent"></div><header class="print-brand"><div><h1>${escapeHtml(profile.shopName)}</h1><p>${escapeHtml(profile.address || "")}</p><p>${escapeHtml(profile.phone || "")}</p></div>${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(profile.shopName)} logo"/>` : ""}</header>` } }
function vendorOptions(selected = "") { return `<option value="">Unassigned</option>${state.vendors.map(vendor => `<option value="${escapeHtml(vendor.name)}" ${vendor.name === selected ? "selected" : ""}>${escapeHtml(vendor.name)}</option>`).join("")}` }
function defaultVendorForKind(kind, profile = shopProfile()) { const specific = profile.defaultVendorByKind?.[kind]; return state.vendors.some(vendor => vendor.name === specific) ? specific : state.vendors.some(vendor => vendor.name === profile.defaultVendor) ? profile.defaultVendor : "" }
async function saveProfilePatch(patch) { const current = shopProfile(), record = { ...current, ...patch, id: "profile", updatedAt: now() }; return saveShopEntity("shopsettings", record) }


/* Restored shop modules: employees, payroll, accounting, imports */
function employees() { const rows = state.users.map(user => `<tr><td><div class="employee-name"><span class="avatar">${initials(user.name)}</span><div><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.employeeId || "Pending ID")} · ${escapeHtml(user.email)}</small></div></div></td><td>${escapeHtml(roleLabel[user.role])}<small>${escapeHtml(user.title || "No title")} · ${escapeHtml(user.department || "Unassigned")}</small></td><td>${escapeHtml(user.employmentType || "—")}<small>${escapeHtml(user.payFrequency || "—")} · ${user.payRate ? user.employmentType === "Salary" ? money(user.payRate) + " / yr" : money(user.payRate) + " / hr" : "Rate pending"}</small></td><td>${escapeHtml(user.phone || "—")}<small>${escapeHtml(user.startDate || "Start date pending")}</small></td><td><span class="badge ${user.active ? "paid" : "overdue"}">${user.active ? "Active" : "Inactive"}</span><small>${escapeHtml(user.techName || "No dispatch identity")}</small></td><td><button class="mini-action" data-toggle-user="${escapeHtml(user.id)}" ${user.id === currentUser().id ? "disabled" : ""}>${user.active ? "Deactivate" : "Activate"}</button></td></tr>`).join(""); return shell(`${heading("Team access", "Employees", "Employee records, employment details, payroll rates, and login access.", false)}<div class="employee-actions"><div class="access-note">${icon("shield-check", 15)} Admin sees all data. Technicians see only assigned jobs. Office sees customers, invoices, and accounting. Service writers manage service operations.</div><button class="primary" id="new-employee">${icon("user-plus", 15)} Create login</button></div><div class="data-panel"><table><thead><tr><th>Employee record</th><th>Role & department</th><th>Employment & pay</th><th>Contact & start</th><th>Access</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`) }
function payroll() { syncAllPayroll(); const period = weekPeriod(), admin = currentUser().role === "admin", people = admin ? state.users.filter(user => user.active) : [currentUser()], stubs = people.map(user => payStub(user, period)); return shell(`${heading("Compensation", "Payroll", admin ? `Weekly payroll for ${period.start} - ${period.end}. Completed jobs automatically add labor hours to the assigned employee.` : `Your weekly pay stub for ${period.start} - ${period.end}.`, false)}<div class="ai-notice">${icon("landmark", 16)}<span>Payroll figures are a small-shop estimate for planning only. MechPro does not file taxes, generate W-2/1099 forms, or replace a payroll processor.</span></div>${admin ? `<div class="payroll-actions"><button class="secondary" id="payroll-export">${icon("download", 14)} Export payroll</button><button class="primary" id="sync-payroll">${icon("refresh-cw", 14)} Sync completed jobs</button></div>` : ""}<div class="payroll-summary"><span>Pay period</span><strong>${period.start} - ${period.end}</strong><span>${stubs.reduce((sum, stub) => sum + stub.hours, 0).toFixed(2)} labor hours</span><strong>${money(stubs.reduce((sum, stub) => sum + stub.net, 0))} net pay</strong></div><div class="payroll-grid">${stubs.map(payStubMarkup).join("") || empty("No active payroll employees")}</div>`) }
function payStub(user, period) { const lines = state.payrollEntries.filter(entry => entry.employeeId === user.id && entry.periodKey === period.key), hours = lines.reduce((sum, line) => sum + line.hours, 0), shiftHours = state.shiftEntries.filter(entry => entry.userId === user.id && entry.clockOut && String(entry.clockIn).slice(0, 10) >= period.key).reduce((sum, entry) => sum + Number(entry.hours || 0), 0), jobPay = lines.reduce((sum, line) => sum + line.amount, 0), salaryPay = user.employmentType === "Salary" ? Number(user.payRate || 0) / 52 : 0, gross = jobPay + salaryPay, federal = Math.round(gross * .12 * 100) / 100, fica = Math.round(gross * .0765 * 100) / 100, other = 0; return { user, period, lines, hours, shiftHours, gross, federal, fica, other, net: Math.max(0, gross - federal - fica - other), salaryPay } }
function payStubMarkup(stub) { const user = stub.user, lines = stub.lines.map(line => `<tr><td class="mono">${escapeHtml(line.roNumber)}</td><td>${escapeHtml(line.customer)}<small>${escapeHtml(line.vehicle)}</small></td><td>${line.hours.toFixed(2)}</td><td>${money(line.rate)}</td><td><b>${money(line.amount)}</b></td></tr>`).join(""); return `<section class="pay-stub"><div class="pay-stub-head"><div><div class="eyebrow">${escapeHtml(user.employeeId || "Employee")} · ${escapeHtml(user.department || "Department")}</div><h2>${escapeHtml(user.name)}</h2><p>${escapeHtml(user.title)} · ${escapeHtml(user.employmentType || "Employment type")} · ${user.payRate ? user.employmentType === "Salary" ? money(user.payRate) + " / year" : money(user.payRate) + " / hr" : "Rate pending"}</p></div><div class="net-pay"><span>Net pay</span><strong>${money(stub.net)}</strong></div></div><div class="pay-stub-totals"><div><span>Job labor hours</span><b>${stub.hours.toFixed(2)}</b></div><div><span>Shift hours</span><b>${stub.shiftHours.toFixed(2)}</b></div><div><span>Gross pay</span><b>${money(stub.gross)}</b></div><div><span>Federal + FICA est.</span><b>(${money(stub.federal + stub.fica)})</b></div></div>${stub.salaryPay ? `<div class="salary-line">Weekly salary base: <b>${money(stub.salaryPay)}</b></div>` : ""}<table><thead><tr><th>Work order</th><th>Job</th><th>Hours</th><th>Rate</th><th>Pay</th></tr></thead><tbody>${lines || `<tr><td colspan="5">No completed job labor has been posted this week.</td></tr>`}</tbody></table><div class="pay-stub-foot"><span>Tax status: ${escapeHtml(user.taxStatus || "Not set")}</span><span>Global shift clock is tracked separately to prevent duplicate pay.</span></div></section>` }
function openEmployee() { showModal(`<form class="modal wide" id="employee-form"><div class="modal-head"><h2>Create employee profile</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><h3>Identity & access</h3><div class="form-grid"><label>Employee name *<input name="name" required/></label><label>Employee ID *<input name="employeeId" placeholder="EMP-005" required/></label><label>Job title<input name="title" placeholder="e.g. Service Writer"/></label><label>Department<input name="department" placeholder="e.g. Service"/></label><label class="full">Email address *<input type="email" name="email" required/></label><label>Role<select name="role"><option value="technician">Technician</option><option value="office">Office</option><option value="service_writer">Service Writer</option><option value="admin">Admin</option></select></label><label class="full">Technician dispatch name <input name="techName" placeholder="Required for technicians, e.g. Eli R."/></label></div><h3>Employment information</h3><div class="form-grid"><label>Employment type<select name="employmentType"><option>Hourly</option><option>Salary</option><option>Contractor</option></select></label><label>Pay rate *<input name="payRate" type="number" min="0" step=".01" required/></label><label>Pay frequency<select name="payFrequency"><option>Weekly</option><option>Biweekly</option><option>Monthly</option></select></label><label>Start date<input name="startDate" type="date" value="2026-08-14"/></label><label>Tax status<select name="taxStatus"><option>W-2</option><option>1099 Contractor</option></select></label><label>Phone<input name="phone" type="tel"/></label><label class="full">Home address<input name="address"/></label><label class="full">Emergency contact<input name="emergencyContact" placeholder="Name · phone number"/></label></div><div class="ledger-note">${icon("info", 15)} Save the employee profile here. They sign in with a work-email magic link. Passwords are never stored in employee records.</div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("user-plus", 14)} Create profile</button></div></form>`); document.querySelector("#employee-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), email = data.email.trim().toLowerCase(); if (state.users.some(user => user.email.toLowerCase() === email)) { toast("An employee profile already uses that email"); return } if (state.users.some(user => user.employeeId === data.employeeId.trim())) { toast("An employee already uses that employee ID"); return } if (data.role === "technician" && !data.techName.trim()) { toast("Add the technician dispatch name to create this profile"); return } const submit = event.target.querySelector("button.primary"); if (submit) submit.disabled = true; try { const profile = { id: `user-${Date.now()}`, name: data.name.trim(), email, role: data.role, title: data.title.trim(), techName: data.techName.trim(), active: true, employeeId: data.employeeId.trim(), phone: data.phone.trim(), address: data.address.trim(), startDate: data.startDate, employmentType: data.employmentType, payRate: Number(data.payRate), payFrequency: data.payFrequency, department: data.department.trim(), emergencyContact: data.emergencyContact.trim(), taxStatus: data.taxStatus, createdAt: now() }; const saved = await apiFetch("/entities/employees", { method: "POST", body: JSON.stringify(profile) }); if (saved?.queued) { toast("Employee profiles require a live connection. Reconnect and try again."); return } state.users.push(saved); save(); closeModal(); toast(`${saved.name || data.name} profile created as ${roleLabel[saved.role || data.role]}`); render() } catch (error) { toast(error.message || "Could not create employee profile") } finally { if (submit) submit.disabled = false } } }
function paymentRecords() { const legacy = state.invoices.filter(invoice => invoice.status === "paid" && !state.payments.some(payment => payment.invoiceNumber === invoice.number)).map(invoice => ({ id: `legacy-${invoice.number}`, invoiceNumber: invoice.number, customer: invoice.customer, amount: invoice.amount, method: "legacy", receivedAt: invoice.paidAt || invoice.closedAt || invoice.date, reference: "Imported paid invoice", note: "", status: "completed" })); return [...legacy, ...state.payments.filter(payment => payment.status === "completed")] }
function finance() { const paid = paymentRecords(), open = state.invoices.filter(invoice => invoiceBalance(invoice) > 0), income = paid.reduce((s, payment) => s + payment.amount, 0), expenses = state.expenses.reduce((s, x) => s + Number(x.amount || 0), 0), tax = paid.reduce((s, payment) => { const invoice = state.invoices.find(item => item.number === payment.invoiceNumber), bd = invoiceTaxBreakdown(invoice), ratio = invoice ? payment.amount / (invoice.amount || payment.amount) : 0; return s + bd.tax * ratio }, 0), manualIncome = state.journalEntries.filter(x => x.creditAccount === "4000").reduce((s, x) => s + x.amount, 0), manualExpense = state.journalEntries.filter(x => /^5|^6/.test(x.debitAccount)).reduce((s, x) => s + x.amount, 0); return { income: income + manualIncome, expenses: expenses + manualExpense, net: income + manualIncome - expenses - manualExpense, receivable: open.reduce((s, invoice) => s + invoiceBalance(invoice), 0), overdue: open.filter(invoice => invoice.status === "overdue").reduce((s, invoice) => s + invoiceBalance(invoice), 0), tax, open } }
function expenseAccount(category) { const name = String(category || "").toLowerCase(); return name.includes("utilit") ? "6200" : name.includes("tool") ? "6300" : name.includes("part") ? "5000" : "6100" }
function accounting() { const data = finance(), tabs = [["overview", "Overview"], ["receivables", "Receivables"], ["expenses", "Expenses"], ["ledger", "General ledger"], ["accounts", "Chart of accounts"]], views = { overview: profitLoss(data), receivables: arView(data), expenses: expenseView(), ledger: ledgerView(), accounts: accountView() }; return shell(`${heading("Financial operations", "Accounting", "Income, expenses, receivables, and books for Your Car Guy.", false)}<div class="accounting-actions"><button class="secondary" id="accounting-export">${icon("download", 14)} Export ledger</button><button class="secondary" id="journal-entry">${icon("book-open-check", 14)} Journal entry</button><button class="primary" id="record-expense">${icon("plus", 14)} Record expense</button></div><div class="accounting-tabs">${tabs.map(x => `<button class="tab ${accountingTab === x[0] ? "active" : ""}" data-accounting-tab="${x[0]}">${x[1]}</button>`).join("")}</div>${views[accountingTab]}`) }
function profitLoss(data) { return `<div class="finance-kpis"><article><span>Cash received</span><strong>${money(data.income)}</strong><small>Paid invoices and posted income</small></article><article><span>Operating expenses</span><strong>${money(data.expenses)}</strong><small>${state.expenses.length} recorded expenses</small></article><article class="${data.net >= 0 ? "positive" : "negative"}"><span>Net income</span><strong>${money(data.net)}</strong><small>Cash-basis operating result</small></article><article><span>Accounts receivable</span><strong>${money(data.receivable)}</strong><small>${money(data.overdue)} overdue</small></article><article><span>Sales tax payable</span><strong>${money(data.tax)}</strong><small>From paid work orders</small></article></div><div class="accounting-grid"><section class="statement"><div class="statement-head"><div><div class="eyebrow">Profit & loss</div><h2>Current activity</h2></div><span class="badge paid">Cash basis</span></div><div class="statement-line"><span>Service revenue</span><b>${money(data.income)}</b></div><div class="statement-line"><span>Operating expenses</span><b>(${money(data.expenses)})</b></div><div class="statement-line total"><span>Net income</span><b>${money(data.net)}</b></div></section><section class="statement"><div class="statement-head"><div><div class="eyebrow">Controls</div><h2>Month-end checklist</h2></div>${icon("list-checks", 18)}</div><p>Review overdue receivables, reconcile the operating account, and set aside sales tax before filing.</p><small>Financial reporting is generated from records stored in this application.</small></section></div>` }
function arView(data) { const rows = data.open.map(x => `<tr><td class="mono"><b>${x.number}</b></td><td>${x.customer}</td><td>${x.due}</td><td>${badge(x.status)}</td><td><b>${money(x.amount)}</b></td></tr>`).join(""); return `<div class="accounting-summary"><span>${data.open.length} open invoices</span><strong>${money(data.receivable)} outstanding</strong></div><div class="data-panel"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Status</th><th>Amount</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No open receivables.</td></tr>`}</tbody></table></div>` }
function expenseView() { const rows = [...state.expenses].reverse().map(x => `<tr><td>${x.date}</td><td><b>${x.vendor}</b><small>${x.memo || "No memo"}</small></td><td>${x.category}</td><td class="mono">${x.account || expenseAccount(x.category)}</td><td><b>${money(x.amount)}</b></td></tr>`).join(""), total = state.expenses.reduce((s, x) => s + Number(x.amount || 0), 0); return `<div class="accounting-summary"><span>${state.expenses.length} recorded expenses</span><strong>${money(total)} total</strong></div><div class="data-panel"><table><thead><tr><th>Date</th><th>Vendor & memo</th><th>Category</th><th>Account</th><th>Amount</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No expenses recorded.</td></tr>`}</tbody></table></div>` }
function ledger() { const receipts = paymentRecords().map(payment => ({ date: payment.receivedAt, reference: payment.reference || payment.invoiceNumber, description: `${payment.method === "cash" ? "Cash" : "Processor"} payment — ${payment.customer} · ${payment.invoiceNumber}`, debitAccount: payment.method === "cash" ? "1010" : "1020", creditAccount: "1100", amount: payment.amount })), expense = state.expenses.map(x => ({ date: x.date, reference: "EXP", description: `${x.vendor}${x.memo ? ` — ${x.memo}` : ""}`, debitAccount: x.account || expenseAccount(x.category), creditAccount: "1000", amount: Number(x.amount) })); return [...receipts, ...expense, ...state.journalEntries].sort((a, b) => String(b.date).localeCompare(String(a.date))) }
function ledgerView() { const rows = ledger().map(x => `<tr><td>${x.date}</td><td class="mono">${x.reference || "JE"}</td><td>${x.description}</td><td class="mono">${x.debitAccount}</td><td class="mono">${x.creditAccount}</td><td><b>${money(x.amount)}</b></td></tr>`).join(""); return `<div class="ledger-note">${icon("scale", 15)} Every entry is balanced: equal debit and credit amounts are posted.</div><div class="data-panel"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th><th>Amount</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No journal activity.</td></tr>`}</tbody></table></div>` }
function accountView() { const d = finance(), balance = x => x.code === "1000" ? d.income - d.expenses : x.code === "1100" ? d.receivable : x.code === "2100" ? d.tax : x.code === "4000" ? d.income : ["5000", "6100", "6200", "6300"].includes(x.code) ? state.expenses.filter(e => (e.account || expenseAccount(e.category)) === x.code).reduce((s, e) => s + Number(e.amount), 0) : 0, rows = state.chartOfAccounts.map(x => `<tr><td class="mono"><b>${x.code}</b></td><td><b>${x.name}</b></td><td>${x.type}</td><td><b>${money(balance(x))}</b></td></tr>`).join(""); return `<div class="data-panel"><table><thead><tr><th>Account</th><th>Name</th><th>Type</th><th>Activity balance</th></tr></thead><tbody>${rows}</tbody></table></div>` }
function openExpense() { showModal(`<form class="modal" id="expense-form"><div class="modal-head"><h2>Record expense</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Date<input type="date" name="date" value="2026-08-14" required/></label><label>Amount *<input name="amount" type="number" step=".01" min=".01" required/></label><label>Vendor *<input name="vendor" required/></label><label>Category<select name="category"><option>Parts & supplies</option><option>Shop supplies</option><option>Utilities</option><option>Tools & equipment</option><option>Insurance</option><option>Marketing</option><option>Other</option></select></label><label class="full">Memo<textarea name="memo" placeholder="What was this business expense for?"></textarea></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("save", 14)} Record expense</button></div></form>`); document.querySelector("#expense-form").onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)), record = { date: d.date, vendor: d.vendor, category: d.category, memo: d.memo, amount: Number(d.amount), account: expenseAccount(d.category) }; state.expenses.push(record); pushExpenseToApi(record); save(); closeModal(); toast("Expense recorded in the general ledger"); render() } }
function openJournal() { const options = state.chartOfAccounts.map(x => `<option value="${x.code}">${x.code} · ${x.name}</option>`).join(""); showModal(`<form class="modal" id="journal-form"><div class="modal-head"><h2>Journal entry</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="ledger-note">${icon("scale", 15)} Post equal debit and credit amounts for an adjustment.</div><div class="form-grid" style="margin-top:14px"><label>Date<input type="date" name="date" value="2026-08-14" required/></label><label>Amount *<input name="amount" type="number" step=".01" min=".01" required/></label><label class="full">Description *<input name="description" required placeholder="e.g. Owner contribution"/></label><label>Debit account<select name="debitAccount">${options}</select></label><label>Credit account<select name="creditAccount">${options}</select></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">${icon("book-open-check", 14)} Post entry</button></div></form>`); document.querySelector("#journal-form").onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); if (d.debitAccount === d.creditAccount) { toast("Choose different debit and credit accounts"); return } state.journalEntries.push({ date: d.date, reference: `JE-${String(state.journalEntries.length + 1).padStart(4, "0")}`, description: d.description, debitAccount: d.debitAccount, creditAccount: d.creditAccount, amount: Number(d.amount) }); save(); closeModal(); toast("Balanced journal entry posted"); render() } }
const importTypes = IMPORT_TYPES;
function imports() { const cards = Object.entries(importTypes).map(([type, def]) => `<article class="import-card"><div class="import-card-icon">${icon(def.icon, 20)}</div><div><h3>${def.title}</h3><p>Required: ${def.required}</p><p class="import-columns">Columns: ${def.columns}</p></div><button class="secondary" data-import-type="${type}">${icon("upload", 14)} Choose CSV</button><button class="template-link" data-template="${type}">${icon("download", 13)} Template</button></article>`).join(""); return shell(`${heading("Data management", "Import records", "Bring historical CSV data into MechPro. Records are checked before they are added.", false)}<input id="csv-input" type="file" accept=".csv,text/csv" hidden/><div class="import-note">${icon("shield-check", 16)}<span>Review each batch before confirming it. Valid rows are added to this shop and synced when you are signed in.</span></div><div class="import-grid">${cards}</div>${importPreview ? previewMarkup() : ""}`) }
function entityName(type) { return type === "orders" ? "work order" : type.slice(0, -1) }
function previewMarkup() { const p = importPreview, rows = p.records.slice(0, 5).map((record, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(Object.values(record).slice(0, 4).join(" · "))}</td></tr>`).join(""); return `<section class="import-preview"><div><div class="eyebrow">Ready to import</div><h2>${p.records.length} valid ${entityName(p.type)} record${p.records.length === 1 ? "" : "s"}</h2><p>${p.skipped} duplicate or invalid row${p.skipped === 1 ? "" : "s"} will not be imported.</p></div><div class="import-preview-actions"><button class="secondary" id="cancel-import">Cancel</button><button class="primary" id="confirm-import">${icon("check", 15)} Import ${p.records.length} records</button></div><table><thead><tr><th>Row</th><th>Preview</th></tr></thead><tbody>${rows || `<tr><td colspan="2">No valid rows found.</td></tr>`}</tbody></table>${p.errors.length ? `<div class="import-errors"><strong>${p.errors.length} row issue${p.errors.length === 1 ? "" : "s"}</strong>${p.errors.slice(0, 4).map(error => `<span>${escapeHtml(error)}</span>`).join("")}</div>` : ""}</section>` }

function prepareImport(type, text) { return prepareImportRecords(type, text, { customers: state.customers, vehicles: state.vehicles, orders: state.orders, expenses: state.expenses, invoices: state.invoices, estimates: state.estimates, taxRate: Number(state.taxSettings?.rate) || 0, today: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() }) }
function downloadTemplate(type) { const link = document.createElement("a"), file = importTypes[type]; link.href = URL.createObjectURL(new Blob([file.sample], { type: "text/csv" })); link.download = `mechpro-${type}-template.csv`; link.click(); URL.revokeObjectURL(link.href) }
async function ensureImportedCustomers(records) {
  const existing = new Set(state.customers.map(item => String(item.name || "").toLowerCase()));
  const missing = [];
  for (const record of records) {
    const name = String(record?.customer || "").trim();
    if (!name || existing.has(name.toLowerCase())) continue;
    existing.add(name.toLowerCase());
    missing.push({ id: mutationId(), name, phone: record.phone || "", email: record.email || "", vehicles: 0, visits: 0, spend: 0 });
  }
  if (!missing.length) return;
  const saved = await Promise.all(missing.map(record => apiFetch("/entities/customers", { method: "POST", body: JSON.stringify(record) })));
  state.customers.push(...saved.map((record, index) => record?.queued ? missing[index] : record || missing[index]));
}
async function applyImport() {
  const p = importPreview;
  if (!p?.records.length) return;
  const collection = { customers: "customers", vehicles: "vehicles", orders: "orders", invoices: "invoices", estimates: "estimates", expenses: "expenses" }[p.type];
  if (!collection || !Array.isArray(state[collection])) return;
  const button = document.querySelector("#confirm-import");
  if (button) button.disabled = true;
  try {
    if (p.type !== "customers") await ensureImportedCustomers(p.records);
    const saved = await Promise.all(p.records.map(record => apiFetch(`/entities/${p.type}`, { method: "POST", body: JSON.stringify(record) })));
    const resolved = saved.map((record, index) => record?.queued ? p.records[index] : record || p.records[index]);
    state[collection].push(...resolved);
    save();
    toast(`${p.records.length} ${entityName(p.type)} record${p.records.length === 1 ? "" : "s"} imported`);
    importPreview = null;
    render();
  } catch (error) {
    if (button) button.disabled = false;
    toast(error.message || "Import could not be saved to this shop");
  }
}
async function loadMeldedDataView(route) {
  if (route === "customers") {
    await Promise.all([loadCustomersFromApi(), loadOrdersFromApi(), loadInvoicesFromApi(), loadPaymentsFromApi(), loadShopEntities()]);
  } else if (route === "shopops") {
    await Promise.all([loadShopEntities(), loadCustomersFromApi(), loadOrdersFromApi()]);
  } else if (route === "imports") {
    await Promise.all([
      loadCustomersFromApi(),
      loadOrdersFromApi(),
      loadInvoicesFromApi(),
      loadPaymentsFromApi(),
      loadExpensesFromApi(),
      loadEstimatesFromApi(),
      loadShopEntities(),
    ]);
  }
  render();
}
const bindImportIntegrityCore = bindExpandedFeatures;
bindExpandedFeatures = function () {
  bindImportIntegrityCore();
  document.querySelectorAll('[data-route="customers"], [data-route="shopops"], [data-route="imports"]').forEach(link => {
    link.addEventListener("click", () => void loadMeldedDataView(link.dataset.route));
  });
};
function appearanceFieldset(profile = shopProfile()) { const mode = ["device", "light", "dark"].includes(profile?.themeMode) ? profile.themeMode : "device"; return `<fieldset class="full appearance-settings"><legend>Appearance</legend><div class="appearance-options">${[["device", "monitor-smartphone", "Device setting"], ["light", "sun", "Light"], ["dark", "moon", "Dark"]].map(([value, iconName, label]) => `<label class="appearance-option"><input type="radio" name="themeMode" value="${value}" ${mode === value ? "checked" : ""}/><span>${icon(iconName, 17)}<b>${label}</b></span></label>`).join("")}</div></fieldset>` }
function bindAppearanceControls(root = document) { if (!root?.querySelectorAll) return; root.querySelectorAll("[name=themeMode]").forEach(input => input.addEventListener("change", () => applyAppearance(input.value))) }

settings = function () { const profile = shopProfile(), t = state.taxSettings, stateOptions = usStates.map(s => `<option value="${s.code}" ${t.state === s.code ? "selected" : ""}>${s.name}</option>`).join(""), kinds = ["Part", "Tire", "Supply", "Asset"], couponRows = profile.coupons.map(coupon => `<tr><td><b>${escapeHtml(coupon.code)}</b></td><td>${coupon.percent}%</td><td><span class="badge ${coupon.active ? "paid" : "estimate"}">${coupon.active ? "Active" : "Inactive"}</span></td><td><div class="coupon-actions"><button type="button" class="mini-action" data-edit-coupon="${escapeHtml(coupon.id)}">${icon("pencil", 13)} Edit</button><button type="button" class="mini-action" data-toggle-coupon="${escapeHtml(coupon.id)}">${icon(coupon.active ? "pause" : "play", 13)} ${coupon.active ? "Disable" : "Enable"}</button><button type="button" class="mini-action danger" data-delete-coupon="${escapeHtml(coupon.id)}">${icon("trash-2", 13)} Delete</button></div></td></tr>`).join(""); const emptyCouponRows = "<tr><td colspan=\"4\">No coupons configured.</td></tr>", vendorKindFields = kinds.map(kind => "<label>" + kind + ' default<select name="vendor' + kind + '">' + vendorOptions(profile.defaultVendorByKind?.[kind] || "") + "</select></label>").join(""); return shell(`${heading("Administration", "Shop settings", "Branding, invoice defaults, coupons, vendors, tax, and optional provider readiness.", false)}<form class="settings-panel form-grid" id="shop-profile-form"><div class="full statement-head"><div><div class="eyebrow">Business identity</div><h2>Branding and invoice defaults</h2></div></div>${appearanceFieldset(profile)}<label>Shop name<input name="shopName" value="${escapeHtml(profile.shopName)}" required/></label><label>Phone<input name="phone" value="${escapeHtml(profile.phone)}"/></label><label class="full">Address<input name="address" value="${escapeHtml(profile.address)}"/></label><label>Logo URL<input name="logoUrl" type="url" value="${escapeHtml(profile.logoUrl)}" placeholder="https://example.com/logo.png"/></label><label>Default labor rate<input name="laborRate" type="number" min="0" step=".01" value="${Number(profile.laborRate)}"/></label><label>Mileage rate ($/mi)<input name="mileageRate" type="number" min="0" step=".01" value="${Number(profile.mileageRate ?? 0.68)}"/></label><label>Brand color<input name="brandColor" type="color" value="${profile.brandColor}"/></label><label>Accent color<input name="accentColor" type="color" value="${profile.accentColor}"/></label><label class="full">Invoice footer<input name="invoiceFooter" value="${escapeHtml(profile.invoiceFooter)}"/></label><div class="full"><button class="primary">${icon("save", 14)} Save business profile</button></div></form><section class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Discounts</div><h2>Coupons</h2></div><button class="primary" type="button" id="add-coupon">${icon("badge-percent", 14)} Add coupon</button></div><div class="data-panel"><table><thead><tr><th>Code</th><th>Percent</th><th>Status</th><th>Actions</th></tr></thead><tbody>${couponRows || emptyCouponRows}</tbody></table></div></section><form class="settings-panel form-grid" id="vendor-defaults-form"><div class="full statement-head"><div><div class="eyebrow">Purchasing</div><h2>Default vendors</h2></div></div><label>Overall default<select name="defaultVendor">${vendorOptions(profile.defaultVendor)}</select></label>${vendorKindFields}<div class="full"><button class="primary">${icon("save", 14)} Save vendor defaults</button></div></form><div class="settings-panel"><form class="form-grid" id="tax-settings-form"><label>Filing state<select name="state">${stateOptions}</select></label><label>State tax ID<input name="taxId" value="${escapeHtml(t.taxId)}"/></label><label>Sales tax rate %<input name="rate" type="number" step=".01" min="0" value="${t.rate}"/></label><label>Filing frequency<select name="filingFrequency"><option ${t.filingFrequency === "Monthly" ? "selected" : ""}>Monthly</option><option ${t.filingFrequency === "Quarterly" ? "selected" : ""}>Quarterly</option><option ${t.filingFrequency === "Annually" ? "selected" : ""}>Annually</option></select></label><div class="full"><button class="primary">${icon("save", 14)} Save tax settings</button></div></form></div>`) };

function openCouponForm(id = "") { const profile = shopProfile(), coupon = profile.coupons.find(item => item.id === id); showModal(`<form class="modal" id="coupon-form"><div class="modal-head"><h2>${coupon ? "Edit" : "Add"} coupon</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Code<input name="code" maxlength="24" pattern="[A-Za-z0-9_-]+" value="${escapeHtml(coupon?.code || "")}" required/></label><label>Discount percent<input name="percent" type="number" min=".1" max="100" step=".1" value="${coupon?.percent || ""}" required/></label><label class="toggle-field full"><input name="active" type="checkbox" ${coupon?.active !== false ? "checked" : ""}/><span>Coupon is active</span></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Save coupon</button></div></form>`); document.querySelector("#coupon-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), code = String(data.code).trim().toUpperCase(), percent = Number(data.percent); if (!/^[A-Z0-9_-]{1,24}$/.test(code) || !Number.isFinite(percent) || percent <= 0 || percent > 100) { toast("Enter a valid coupon code and percent"); return } const coupons = [...profile.coupons], duplicate = coupons.find(item => item.code === code && item.id !== coupon?.id); if (duplicate) { toast("Coupon codes must be unique"); return } const record = { id: coupon?.id || `coupon-${Date.now()}`, code, percent, active: data.active === "on" }; if (coupon) coupons[coupons.indexOf(coupon)] = record; else coupons.push(record); await saveProfilePatch({ coupons }); closeModal(); toast("Coupon saved"); render() } }

const bindBrandingFeaturesCore = bindExpandedFeatures;
bindExpandedFeatures = function () { bindBrandingFeaturesCore(); const profileForm = document.querySelector("#shop-profile-form"); if (profileForm && !profileForm.querySelector("[name=themeMode]")) { profileForm.querySelector(".statement-head")?.insertAdjacentHTML("afterend", appearanceFieldset()); lucide.createIcons(); bindAppearanceControls(profileForm) } if (profileForm) bindAppearanceControls(profileForm); profileForm?.addEventListener("submit", async event => { event.preventDefault(); event.stopImmediatePropagation(); const data = Object.fromEntries(new FormData(event.target)), logoUrl = safeHttpUrl(data.logoUrl), themeMode = ["device", "light", "dark"].includes(data.themeMode) ? data.themeMode : "device"; if (data.logoUrl.trim() && !logoUrl) { toast("Logo URL must use http or https"); return } if (!/^#[0-9a-f]{6}$/i.test(data.brandColor) || !/^#[0-9a-f]{6}$/i.test(data.accentColor)) { toast("Choose valid brand colors"); return } try { await saveProfilePatch({ shopName: data.shopName.trim(), phone: data.phone.trim(), address: data.address.trim(), logoUrl, brandColor: data.brandColor, accentColor: data.accentColor, themeMode, laborRate: Math.max(0, Number(data.laborRate) || 0), mileageRate: Math.max(0, Number(data.mileageRate) || 0.68), invoiceFooter: data.invoiceFooter.trim() }); applyAppearance(themeMode); toast("Business profile saved"); render() } catch (error) { toast(error.message || "Could not save the business profile") } }, { capture: true }); document.querySelector("#vendor-defaults-form")?.addEventListener("submit", async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), defaultVendorByKind = { Part: data.vendorPart, Tire: data.vendorTire, Supply: data.vendorSupply, Asset: data.vendorAsset }; await saveProfilePatch({ defaultVendor: data.defaultVendor, defaultVendorByKind }); toast("Vendor defaults saved"); render() }); document.querySelector("#add-coupon")?.addEventListener("click", () => openCouponForm()); document.querySelectorAll("[data-edit-coupon]").forEach(button => button.onclick = () => openCouponForm(button.dataset.editCoupon)); document.querySelectorAll("[data-toggle-coupon]").forEach(button => button.onclick = async () => { const profile = shopProfile(), coupons = profile.coupons.map(coupon => coupon.id === button.dataset.toggleCoupon ? { ...coupon, active: !coupon.active } : coupon); await saveProfilePatch({ coupons }); render() }); document.querySelectorAll("[data-delete-coupon]").forEach(button => button.onclick = async () => { if (!confirm("Delete this coupon?")) return; const profile = shopProfile(); await saveProfilePatch({ coupons: profile.coupons.filter(coupon => coupon.id !== button.dataset.deleteCoupon) }); toast("Coupon deleted"); render() }) };

addInventory = function () { const profile = shopProfile(), initialKind = "Part", initialVendor = defaultVendorForKind(initialKind, profile); simpleRecordModal("inventory", "Inventory item", `<label>Name<input name="name" required/></label><label>SKU<input name="sku" required/></label><label>Type<select name="kind" id="inventory-kind"><option>Part</option><option>Tire</option><option>Supply</option><option>Asset</option></select></label><label>Vendor<select name="vendor" id="inventory-vendor">${vendorOptions(initialVendor)}</select></label><label>Quantity<input name="quantity" type="number" min="0" value="0"/></label><label>Reorder level<input name="reorderLevel" type="number" min="0" value="0"/></label><label>Unit cost<input name="cost" type="number" min="0" step=".01"/></label><label>Selling price<input name="price" type="number" min="0" step=".01"/></label>`, data => ({ id: `inventory-${Date.now()}`, ...data, quantity: Number(data.quantity), reorderLevel: Number(data.reorderLevel), cost: Number(data.cost), price: Number(data.price), unit: "ea", createdAt: now() })); document.querySelector("#inventory-kind")?.addEventListener("change", event => { document.querySelector("#inventory-vendor").value = defaultVendorForKind(event.target.value, profile) }) };

openEstimateDiscount = function (id) { const estimate = state.estimates.find(item => item.id === id), coupons = shopProfile().coupons.filter(coupon => coupon.active); showModal(`<form class="modal" id="estimate-discount-form"><div class="modal-head"><h2>Estimate discount</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><label>Coupon<select name="couponCode" id="estimate-coupon"><option value="">Manual discount</option>${coupons.map(coupon => `<option value="${escapeHtml(coupon.code)}" data-percent="${coupon.percent}" ${estimate.couponCode === coupon.code ? "selected" : ""}>${escapeHtml(coupon.code)} · ${coupon.percent}%</option>`).join("")}</select></label><label>Discount percent<input name="discount" type="number" min="0" max="100" step=".1" value="${Number(estimate.discountPercent || 0)}" required/></label><label>Reason<input name="discountReason" value="${escapeHtml(estimate.discountReason || "")}"/></label></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Apply discount</button></div></form>`); const form = document.querySelector("#estimate-discount-form"), couponSelect = document.querySelector("#estimate-coupon"); couponSelect.onchange = () => { const option = couponSelect.selectedOptions[0], coupon = coupons.find(item => item.code === couponSelect.value); if (coupon) { form.elements.discount.value = option.dataset.percent; form.elements.discountReason.value = `Coupon ${coupon.code}` } else { form.elements.discountReason.value = "" } }; form.onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), percent = Math.min(100, Math.max(0, Number(data.discount))), base = Number(estimate.originalSubtotal ?? estimate.subtotal); if (!Number.isFinite(percent) || !Number.isFinite(base)) { toast("Enter a valid discount"); return } estimate.originalSubtotal = base; estimate.discountPercent = percent; estimate.discountReason = data.discountReason.trim(); estimate.couponCode = data.couponCode || ""; estimate.discountAmount = Math.round(base * percent) / 100; estimate.subtotal = Math.round((base - estimate.discountAmount) * 100) / 100; estimate.tax = Math.round(estimate.subtotal * Number(estimate.taxRate || state.taxSettings.rate) / 100 * 100) / 100; estimate.total = Math.round((estimate.subtotal + estimate.tax) * 100) / 100; await updateEstimateInApi(estimate); save(); closeModal(); toast("Estimate discount applied"); render() } };

function printInvoice(number) { const invoice = state.invoices.find(item => item.number === number); if (!invoice) return; const profile = shopProfile(), brand = printableBrand(profile), breakdown = invoiceTaxBreakdown(invoice), paid = invoicePaid(invoice), balance = invoiceBalance(invoice), customer = state.customers.find(item => item.name === invoice.customer), order = state.orders.find(item => item.id === invoice.ro), payments = paymentRecords().filter(payment => payment.invoiceNumber === invoice.number), paymentRows = payments.map(payment => `<tr><td>${escapeHtml(payment.receivedAt || "")}</td><td>${escapeHtml(payment.method || "")}</td><td>${escapeHtml(payment.reference || "")}</td><td>${money(Number(payment.amount || 0))}</td></tr>`).join(""), win = window.open("", "_blank", "noopener"); if (!win) { toast("Allow pop-ups to print the invoice"); return } win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.number)} invoice</title><style>${brand.style}body{font:12px/1.55 system-ui,sans-serif;max-width:850px;margin:auto;padding:22px;color:#172029}h2{margin:20px 0 8px}.invoice-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.invoice-meta div,.totals{padding:10px;border:1px solid #d6ddd7}.invoice-meta b,.invoice-meta span{display:block}.invoice-meta span{color:#66727a}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{padding:7px 9px;border-bottom:1px solid #d6ddd7;text-align:left}th{color:#fff;background:var(--brand)}.totals{width:min(320px,100%);margin:18px 0 18px auto}.totals p{display:flex;justify-content:space-between;margin:5px 0}.totals .balance{padding-top:8px;border-top:2px solid var(--brand);font-size:15px}.footer{margin-top:28px;padding-top:12px;border-top:1px solid #d6ddd7;text-align:center;color:#66727a}@media(max-width:600px){.invoice-meta{grid-template-columns:1fr}}</style></head><body>${brand.header}<div class="invoice-meta"><div><span>Invoice</span><b>${escapeHtml(invoice.number)}</b></div><div><span>Repair order</span><b>${escapeHtml(invoice.ro || "")}</b></div><div><span>Customer</span><b>${escapeHtml(invoice.customer || "")}</b>${customer?.billingAddress ? `<small>${escapeHtml(customer.billingAddress)}</small>` : ""}</div><div><span>Vehicle</span><b>${escapeHtml(order?.vehicle || "")}</b></div><div><span>Issued</span><b>${escapeHtml(invoice.date || "")}</b></div><div><span>Due</span><b>${escapeHtml(invoice.due || "")}</b></div></div><h2>Invoice summary</h2><table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody><tr><td>Services and materials for ${escapeHtml(invoice.ro || invoice.number)}</td><td>${money(breakdown.subtotal)}</td></tr><tr><td>Sales tax (${Number(breakdown.taxRate || 0)}%)</td><td>${money(breakdown.tax)}</td></tr></tbody></table>${paymentRows ? `<h2>Payments</h2><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${paymentRows}</tbody></table>` : ""}<div class="totals"><p><span>Subtotal</span><b>${money(breakdown.subtotal)}</b></p><p><span>Tax</span><b>${money(breakdown.tax)}</b></p><p><span>Invoice amount</span><b>${money(invoice.amount)}</b></p><p><span>Payments</span><b>-${money(paid)}</b></p><p class="balance"><span>Balance due</span><b>${money(balance)}</b></p></div><p class="footer">${escapeHtml(profile.invoiceFooter || "")}</p><button type="button" onclick="window.print()">Print invoice</button></body></html>`); win.document.close() }

printInvoice = function (number) {
  const invoice = state.invoices.find(item => item.number === number);
  if (!invoice) return;
  const profile = shopProfile();
  const brand = printableBrand(profile);
  const breakdown = invoiceTaxBreakdown(invoice);
  const paid = invoicePaid(invoice);
  const balance = invoiceBalance(invoice);
  const customer = state.customers.find(item => item.name === invoice.customer);
  const order = state.orders.find(item => item.id === invoice.ro);
  const itemRows = invoicePrintLineItems(invoice).map(item => `<tr><td>${escapeHtml(item.type === "fee" ? "Fee" : item.type === "part" ? "Part" : "Labor")}</td><td><b>${escapeHtml(item.description)}</b><small>${escapeHtml(item.detail)}</small></td><td>${money(item.amount)}</td></tr>`).join("");
  const fallbackRow = `<tr><td>Summary</td><td>Services and materials for ${escapeHtml(invoice.ro || invoice.number)}</td><td>${money(breakdown.subtotal)}</td></tr>`;
  const paymentRows = paymentRecords().filter(payment => payment.invoiceNumber === invoice.number)
    .map(payment => `<tr><td>${escapeHtml(payment.receivedAt || "")}</td><td>${escapeHtml(payment.method || "")}</td><td>${escapeHtml(payment.reference || "")}</td><td>${money(Number(payment.amount || 0))}</td></tr>`)
    .join("");
  const win = window.open("", "_blank", "noopener");
  if (!win) {
    toast("Allow pop-ups to print the invoice");
    return;
  }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.number)} invoice</title><style>${brand.style}body{font:12px/1.55 system-ui,sans-serif;max-width:850px;margin:auto;padding:22px;color:#172029}h2{margin:20px 0 8px}.invoice-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.invoice-meta div,.totals{padding:10px;border:1px solid #d6ddd7}.invoice-meta b,.invoice-meta span{display:block}.invoice-meta span,td small{display:block;color:#66727a}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{padding:7px 9px;border-bottom:1px solid #d6ddd7;text-align:left;vertical-align:top}th{color:#fff;background:var(--brand)}.totals{width:min(320px,100%);margin:18px 0 18px auto}.totals p{display:flex;justify-content:space-between;margin:5px 0}.totals .balance{padding-top:8px;border-top:2px solid var(--brand);font-size:15px}.footer{margin-top:28px;padding-top:12px;border-top:1px solid #d6ddd7;text-align:center;color:#66727a}@media(max-width:600px){.invoice-meta{grid-template-columns:1fr}}</style></head><body>${brand.header}<div class="invoice-meta"><div><span>Invoice</span><b>${escapeHtml(invoice.number)}</b></div><div><span>Repair order</span><b>${escapeHtml(invoice.ro || "")}</b></div><div><span>Customer</span><b>${escapeHtml(invoice.customer || "")}</b>${customer?.billingAddress ? `<small>${escapeHtml(customer.billingAddress)}</small>` : ""}</div><div><span>Vehicle</span><b>${escapeHtml(order?.vehicle || invoice.vehicle || "")}</b></div><div><span>Issued</span><b>${escapeHtml(invoice.date || "")}</b></div><div><span>Due</span><b>${escapeHtml(invoice.due || "")}</b></div></div><h2>Invoice line items</h2><table><thead><tr><th>Type</th><th>Description</th><th>Amount</th></tr></thead><tbody>${itemRows || fallbackRow}</tbody></table>${paymentRows ? `<h2>Payments</h2><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${paymentRows}</tbody></table>` : ""}<div class="totals"><p><span>Subtotal</span><b>${money(breakdown.subtotal)}</b></p><p><span>Tax (${Number(breakdown.taxRate || 0)}%)</span><b>${money(breakdown.tax)}</b></p><p><span>Invoice amount</span><b>${money(invoice.amount)}</b></p><p><span>Payments</span><b>-${money(paid)}</b></p><p class="balance"><span>Balance due</span><b>${money(balance)}</b></p></div><p class="footer">${escapeHtml(profile.invoiceFooter || "")}</p><button type="button" onclick="window.print()">Print invoice</button></body></html>`);
  win.document.close();
};

invoices = function () { const q = query.toLowerCase(), rows = state.invoices.filter(invoice => !q || Object.values(invoice).join(" ").toLowerCase().includes(q)).map(invoice => { const paid = invoicePaid(invoice), balance = invoiceBalance(invoice), bd = invoiceTaxBreakdown(invoice); return `<tr><td class="mono"><b>${escapeHtml(invoice.number)}</b></td><td class="mono">${escapeHtml(invoice.ro || "")}</td><td><b>${escapeHtml(invoice.customer)}</b></td><td>${escapeHtml(invoice.date || "")}</td><td>${escapeHtml(invoice.due || "")}</td><td>${balance === 0 ? `<span class="badge paid">Paid</span>` : badge(invoice.status)}</td><td><b>${money(invoice.amount)}</b><small>Subtotal ${money(bd.subtotal)} · Tax ${money(bd.tax)} (${bd.taxRate}%)</small><small>Paid ${money(paid)} · Balance ${money(balance)}</small><div class="invoice-payments"><button class="mini-action" data-print-invoice="${escapeHtml(invoice.number)}">${icon("printer", 13)} Print</button>${balance > 0 ? `<button class="mini-action" data-record-payment="${escapeHtml(invoice.number)}" data-method="cash">${icon("banknote", 13)} Cash</button><button class="mini-action" data-record-payment="${escapeHtml(invoice.number)}" data-method="processor">${icon("credit-card", 13)} Card receipt</button><button class="mini-action invoice-pay" data-pay-invoice="${escapeHtml(invoice.number)}">${icon("external-link", 13)} Pay online</button>` : ""}${paid === 0 ? `<button class="mini-action" data-edit-tax="${escapeHtml(invoice.number)}">${icon("percent", 13)} Edit tax</button>` : ""}</div></td></tr>` }).join(""); return shell(`${heading("Accounts receivable", "Invoices", "Track open balances, invoice tax, payments, and branded print copies.", false)}${stats()}<div class="data-panel"><table><thead><tr><th>Invoice</th><th>Work order</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th>Invoice & payments</th></tr></thead><tbody>${rows}</tbody></table></div>`) };

const bindPrintableInvoiceCore = bindEstimateActions;
bindEstimateActions = function () { bindPrintableInvoiceCore(); document.querySelectorAll("[data-print-invoice]").forEach(button => button.onclick = () => printInvoice(button.dataset.printInvoice)) };
const bindInvoiceDeleteActionsCore = bindEstimateActions;
bindEstimateActions = function () { bindInvoiceDeleteActionsCore(); document.querySelectorAll("[data-print-invoice]").forEach(button => { if (button.parentElement.querySelector("[data-delete-invoice]")) return; const invoice = state.invoices.find(item => item.number === button.dataset.printInvoice); if (!invoice) return; button.insertAdjacentHTML("afterend", `<button class="mini-action danger" data-delete-invoice="${escapeHtml(invoiceRecordKey(invoice))}">${icon("trash-2", 13)} Delete</button>`); button.parentElement.querySelector("[data-delete-invoice]").onclick = () => deleteInvoiceRecord(button.parentElement.querySelector("[data-delete-invoice]").dataset.deleteInvoice) }) };

printCustomerStatement = function (name) { const invoices = state.invoices.filter(invoice => invoice.customer === name), payments = paymentRecords().filter(payment => payment.customer === name), balance = customerBalance(name), profile = shopProfile(), brand = printableBrand(profile), invoiceRows = invoices.map(invoice => `<tr><td>${escapeHtml(invoice.number)}</td><td>${escapeHtml(invoice.date || "")}</td><td>${escapeHtml(invoice.status || "")}</td><td>${money(invoice.amount)}</td><td>${money(invoiceBalance(invoice))}</td></tr>`).join(""), paymentRows = payments.map(payment => `<tr><td>${escapeHtml(payment.receivedAt || "")}</td><td>${escapeHtml(payment.method || "")}</td><td>${money(Number(payment.amount || 0))}</td><td>${escapeHtml(payment.invoiceNumber || "")}</td></tr>`).join(""), win = window.open("", "_blank", "noopener"); if (!win) { toast("Allow pop-ups to print the statement"); return } win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(name)} statement</title><style>${brand.style}body{font:12px/1.6 system-ui,sans-serif;max-width:850px;margin:auto;padding:22px;color:#172029}h2{color:var(--brand)}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{padding:7px 9px;border-bottom:1px solid #d6ddd7;text-align:left}th{color:#fff;background:var(--brand)}.total{margin-top:18px;padding:12px;border-top:4px solid var(--brand);font-size:16px;text-align:right}</style></head><body>${brand.header}<h2>Customer Statement: ${escapeHtml(name)}</h2><p>Generated ${escapeHtml(new Date().toLocaleDateString())}</p><h3>Invoices</h3><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Amount</th><th>Balance</th></tr></thead><tbody>${invoiceRows || `<tr><td colspan="5">No invoices.</td></tr>`}</tbody></table><h3>Payments</h3><table><thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Invoice</th></tr></thead><tbody>${paymentRows || `<tr><td colspan="4">No payments.</td></tr>`}</tbody></table><p class="total">Account Balance: ${money(balance)}</p><button type="button" onclick="window.print()">Print statement</button></body></html>`); win.document.close() };

printInspectionReport = function (inspection) { if (inspection?.catalogId) { printCatalogInspection(catalogInspectionApp(), inspection); return } const profile = shopProfile(), brand = printableBrand(profile), counts = (inspection.items || []).reduce((total, item) => (total[item.status] = (total[item.status] || 0) + 1, total), {}), itemRows = (inspection.items || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.status === "not_checked" ? "Not checked" : item.status || "")}</td><td>${escapeHtml(item.note || "")}</td></tr>`).join(""), damage = (inspection.damageZones || []).map(escapeHtml).join(", "), approvalRows = (inspection.approvalHistory || []).map(entry => `<tr><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.actorName || "")}</td><td>${escapeHtml(new Date(entry.timestamp).toLocaleString())}</td><td>${escapeHtml(entry.note || "")}</td></tr>`).join(""), photos = (inspection.photoKeys || []).map(key => `<img src="${escapeHtml(`${cloudflareConfig.apiUrl}/files/${encodeURIComponent(key)}`)}" alt="Inspection photo"/>`).join(""), win = window.open("", "_blank", "noopener"); if (!win) { toast("Allow pop-ups to print the inspection"); return } win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(inspection.number)} inspection</title><style>${brand.style}body{font:12px/1.55 system-ui,sans-serif;max-width:900px;margin:auto;padding:22px;color:#172029}h2{color:var(--brand)}.summary{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.summary b{padding:7px 10px;border:1px solid #d6ddd7}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{padding:6px 8px;border:1px solid #d6ddd7;text-align:left}th{color:#fff;background:var(--brand)}.photos{display:flex;flex-wrap:wrap;gap:8px}.photos img{width:150px;height:110px;object-fit:cover;border:1px solid #d6ddd7}</style></head><body>${brand.header}<h2>Digital Inspection Report: ${escapeHtml(inspection.number)}</h2><p><b>Customer:</b> ${escapeHtml(inspection.customer)} · <b>Vehicle:</b> ${escapeHtml(inspection.vehicle)} · <b>Work order:</b> ${escapeHtml(inspection.workOrderId || "Unlinked")}</p><p><b>Date:</b> ${escapeHtml(new Date(inspection.createdAt).toLocaleString())}</p><div class="summary"><b>${counts.pass || 0} pass</b><b>${counts.attention || 0} attention</b><b>${counts.fail || 0} fail</b></div>${damage ? `<p><b>Damage zones:</b> ${damage}</p>` : ""}<table><thead><tr><th>Inspection point</th><th>Result</th><th>Note</th></tr></thead><tbody>${itemRows}</tbody></table>${inspection.recommendations ? `<h3>Recommendations</h3><p>${escapeHtml(inspection.recommendations)}</p>` : ""}${photos ? `<h3>Photos</h3><div class="photos">${photos}</div>` : ""}${approvalRows ? `<h3>Approval history</h3><table><thead><tr><th>Decision</th><th>By</th><th>Date</th><th>Note</th></tr></thead><tbody>${approvalRows}</tbody></table>` : ""}<p>${escapeHtml(profile.invoiceFooter || "")}</p><button type="button" onclick="window.print()">Print inspection</button></body></html>`); win.document.close() };
function invoiceNumberForOrder(order) { return `INV-${String(order.id || Date.now()).replace(/^RO-/i, "").replace(/[^A-Za-z0-9-]/g, "")}` }
async function ensureInvoiceForOrder(order) { if (!["completed", "invoiced"].includes(order.status)) return null; const existing = state.invoices.find(invoice => invoice.ro === order.id); if (existing) return existing; Object.assign(order, Mileage.applyMileageToOrder(order, { rate: shopMileageRate(), taxRate: state.taxSettings.rate })); const number = invoiceNumberForOrder(order), estimate = order.estimate || {}, amount = Math.max(0, Number(order.total ?? estimate.total) || 0), tax = Math.max(0, Number(order.tax ?? estimate.tax) || 0), subtotal = Math.max(0, Number(estimate.subtotal) || Math.max(0, amount - tax)), issued = new Date(), due = new Date(issued); due.setDate(due.getDate() + 14); const invoice = { id: number, number, ro: order.id, customer: order.customer, vehicle: order.vehicle, amount, subtotal, tax, taxRate: Number(estimate.taxRate ?? state.taxSettings.rate) || 0, status: "sent", date: issued.toISOString().slice(0, 10), due: due.toISOString().slice(0, 10), lines: estimate.lines || [], createdAt: now() }; const saved = await apiFetch("/entities/invoices", { method: "POST", body: JSON.stringify(invoice) }), record = saved?.queued ? invoice : saved; state.invoices.push(record); order.invoiceNumber = number; save(); return record }
const updateOrderWithInvoiceCore = updateOrderInApi;
updateOrderInApi = async function (record, options) { if (["completed", "invoiced"].includes(record.status)) { try { await ensureInvoiceForOrder(record) } catch (error) { console.error("Failed to create invoice for completed order", error); toast("Invoice creation failed; the work order was not completed"); throw error } } return updateOrderWithInvoiceCore(record, options) };

const sampleOrderIds = new Set(["RO-1044", "RO-1046", "RO-1048", "RO-1049", "RO-1050", "RO-1051", "RO-1052"]), sampleInvoiceIds = new Set(["INV-2032", "INV-2036", "INV-2040", "INV-2041"]), sampleCustomerNames = new Set(["Demo Customer A", "Demo Fleet Co", "Demo Customer B", "Demo Customer C", "Demo Customer D", "Demo Retail Co"]);
let onboardingCheckComplete = false;
function localSampleRecord(type, record) { if (record.sampleData === true) return true; if (type === "orders") return sampleOrderIds.has(record.id); if (type === "invoices") return sampleInvoiceIds.has(record.number || record.id); if (type === "customers") return sampleCustomerNames.has(record.name); if (type === "expenses") return ["Demo Parts Supplier|Brake rotor inventory replenishment|412.87", "Demo Utilities|Shop electric service|286.14"].includes(`${record.vendor || ""}|${record.memo || ""}|${Number(record.amount || 0)}`); return false }
function removeLocalSampleData() { ["orders", "invoices", "customers", "expenses", "vehicles", "payments", "estimates", "shiftEntries", "jobClockEntries", "payrollEntries", "inventory", "vendors", "services", "inspectionTemplates", "inspections", "reminders", "appointments", "purchases"].forEach(type => { state[type] = (state[type] || []).filter(record => !localSampleRecord(type, record)) }); save() }
async function reloadOperationalData() { await Promise.all([loadCustomersFromApi(), loadOrdersFromApi(), loadInvoicesFromApi(), loadPaymentsFromApi(), loadExpensesFromApi(), loadEstimatesFromApi(), loadShiftEntriesFromApi(), loadJobClockEntriesFromApi(), loadPayrollEntriesFromApi(), loadShopEntities()]) }
async function startOnboardingCleanup() { const button = document.querySelector("#start-onboarding-cleanup"); if (button) button.disabled = true; try { const result = await apiFetch("/onboarding/start", { method: "POST", body: "{}" }); removeLocalSampleData(); await reloadOperationalData(); closeModal(); toast(`${result.removed} sample record${result.removed === 1 ? "" : "s"} removed. Onboarding is ready.`); render() } catch (error) { if (button) button.disabled = false; toast(error.message || "Onboarding cleanup could not be completed") } }
function openOnboardingCleanup(count) { showModal(`<div class="modal" id="onboarding-cleanup"><div class="modal-head"><h2>Start with a clean shop</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="messaging-status ready">${icon("sparkles", 17)}<div><strong>${count} sample record${count === 1 ? "" : "s"} detected</strong><span>Starting onboarding removes only MechPro demo customers, work orders, invoices, and expenses. Employee access and real shop records stay in place.</span></div></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Keep for now</button><button type="button" class="primary" id="start-onboarding-cleanup">${icon("play", 14)} Start onboarding</button></div></div>`); document.querySelector("#start-onboarding-cleanup").onclick = startOnboardingCleanup }
async function checkOnboardingSamples() { if (onboardingCheckComplete || currentUser()?.role !== "admin" || !authSession()) return; onboardingCheckComplete = true; try { const result = await apiFetch("/onboarding/start"); if (result.sampleRecords > 0 && !document.querySelector("#modal-root")) openOnboardingCleanup(result.sampleRecords) } catch (error) { console.error("Could not check onboarding sample data", error) } }

function customerRecordKey(customer) { return customer.id || customer.name }
async function saveCustomerChanges(customer, changes) { const isNew = !customer.id, record = { ...customer, ...changes, id: customer.id || mutationId() }, saved = await apiFetch(`/entities/customers${isNew ? "" : `/${encodeURIComponent(record.id)}`}`, { method: isNew ? "POST" : "PUT", body: JSON.stringify(record) }), value = saved?.queued ? record : saved, index = state.customers.indexOf(customer); state.customers[index] = value; save(); return value }
function openCustomerEditor(key) { const customer = state.customers.find(item => customerRecordKey(item) === key); if (!customer) return; showModal(`<form class="modal" id="customer-edit-form"><div class="modal-head"><h2>Edit customer</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Name *<input name="name" value="${escapeHtml(customer.name || "")}" required/></label><label>Phone<input name="phone" value="${escapeHtml(customer.phone || "")}"/></label><label class="full">Email<input name="email" type="email" value="${escapeHtml(customer.email || "")}"/></label><label>Billing address<textarea name="billingAddress">${escapeHtml(customer.billingAddress || "")}</textarea></label><label>Billing notes<textarea name="billingNotes">${escapeHtml(customer.billingNotes || "")}</textarea></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} Save customer</button></div></form>`); document.querySelector("#customer-edit-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), oldName = customer.name, button = event.target.querySelector("button[type=submit]"); button.disabled = true; try { await saveCustomerChanges(customer, { name: data.name.trim(), phone: data.phone.trim(), email: data.email.trim(), billingAddress: data.billingAddress.trim(), billingNotes: data.billingNotes.trim() }); if (oldName !== data.name.trim()) toast("Customer saved. Existing linked records retain their original customer name."); else toast("Customer saved"); closeModal(); render() } catch (error) { button.disabled = false; toast(error.message || "Customer could not be saved") } } }
async function deleteCustomerRecord(key) { const customer = state.customers.find(item => customerRecordKey(item) === key); if (!customer) return; const linked = state.vehicles.filter(item => item.customer === customer.name).length + state.orders.filter(item => item.customer === customer.name).length + state.invoices.filter(item => item.customer === customer.name).length; if (linked) { toast("Delete this customer's vehicles, work orders, and invoices first"); return } if (!confirm(`Delete ${customer.name}? This cannot be undone.`)) return; try { await apiFetch(`/entities/customers/${encodeURIComponent(customer.id)}`, { method: "DELETE" }); state.customers = state.customers.filter(item => item !== customer); save(); toast("Customer deleted"); render() } catch (error) { toast(error.message || "Customer could not be deleted") } }
customers = function () { const q = query.toLowerCase(), cards = state.customers.filter(item => !q || Object.values(item).join(" ").toLowerCase().includes(q)).map(item => { const key = encodeURIComponent(customerRecordKey(item)); return `<article class="customer-card" data-open-customer="${encodeURIComponent(item.name)}"><div class="customer-top"><div class="avatar">${initials(item.name)}</div><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.phone || "No phone")} · ${escapeHtml(item.email || "No email")}</p></div></div><div class="customer-stats"><div><span>Vehicles</span><b>${Number(item.vehicles || state.vehicles.filter(vehicle => vehicle.customer === item.name).length)}</b></div><div><span>Lifetime spend</span><b>${money(Number(item.spend || 0))}</b></div><div><span>Shop visits</span><b>${Number(item.visits || 0)}</b></div><div><span>Balance</span><b>${money(customerBalance(item.name))}</b></div></div><div class="customer-card-actions"><button class="customer-message" data-message-customer="${encodeURIComponent(item.name)}" data-message-phone="${encodeURIComponent(item.phone || "")}" data-message-email="${encodeURIComponent(item.email || "")}">${icon("send", 14)} Message</button><button class="mini-action" data-edit-customer="${key}">${icon("pencil", 14)} Edit</button><button class="mini-action danger" data-delete-customer="${key}">${icon("trash-2", 14)} Delete</button></div></article>` }).join(""); return shell(`${heading("Relationships", "Customers", "Edit customer contact details and safely remove unlinked records.")}<div class="customer-grid">${cards || empty("No customers yet")}</div>`) };

function invoiceRecordKey(invoice) { return invoice.id || invoice.number }
function invoiceDateValue(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 10) }
function openInvoiceEditor(key) { const invoice = state.invoices.find(item => invoiceRecordKey(item) === key); if (!invoice) return; const bd = invoiceTaxBreakdown(invoice); showModal(`<form class="modal" id="invoice-edit-form"><div class="modal-head"><h2>Edit ${escapeHtml(invoice.number)}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Customer *<select name="customer" required>${customerOptions(invoice.customer)}</select></label><label>Work order<input name="ro" value="${escapeHtml(invoice.ro || "")}"/></label><label>Issued<input name="date" type="date" value="${invoiceDateValue(invoice.date)}"/></label><label>Due<input name="due" type="date" value="${invoiceDateValue(invoice.due)}"/></label><label>Subtotal *<input name="subtotal" type="number" min="0" step=".01" value="${Number(bd.subtotal).toFixed(2)}" required/></label><label>Tax rate % *<input name="taxRate" type="number" min="0" step=".01" value="${Number(bd.taxRate)}" required/></label><label>Status<select name="status">${["sent", "overdue", "paid"].map(status => `<option value="${status}" ${invoice.status === status ? "selected" : ""}>${label(status)}</option>`).join("")}</select></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} Save invoice</button></div></form>`); document.querySelector("#invoice-edit-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), subtotal = Number(data.subtotal), taxRate = Number(data.taxRate), tax = Math.round(subtotal * taxRate) / 100, record = { ...invoice, customer: data.customer, ro: data.ro.trim(), date: data.date, due: data.due, subtotal, taxRate, tax, amount: Math.round((subtotal + tax) * 100) / 100, status: data.status }, button = event.target.querySelector("button[type=submit]"); button.disabled = true; try { const saved = await apiFetch(`/entities/invoices/${encodeURIComponent(invoiceRecordKey(invoice))}`, { method: "PUT", body: JSON.stringify(record) }); state.invoices[state.invoices.indexOf(invoice)] = saved?.queued ? record : saved; save(); closeModal(); toast(`${invoice.number} saved`); render() } catch (error) { button.disabled = false; toast(error.message || "Invoice could not be saved") } } }
async function deleteInvoiceRecord(key) { const invoice = state.invoices.find(item => invoiceRecordKey(item) === key); if (!invoice) return; const payments = state.payments.filter(payment => payment.invoiceNumber === invoice.number); if (!confirm(`Delete ${invoice.number}${invoicePaid(invoice) > 0 ? " and its payment history" : ""}? This cannot be undone.`)) return; try { await Promise.all(payments.filter(payment => payment.id).map(payment => apiFetch(`/entities/payments/${encodeURIComponent(payment.id)}`, { method: "DELETE" }))); await apiFetch(`/entities/invoices/${encodeURIComponent(invoiceRecordKey(invoice))}`, { method: "DELETE" }); state.payments = state.payments.filter(payment => payment.invoiceNumber !== invoice.number); state.invoices = state.invoices.filter(item => item !== invoice); save(); toast("Invoice and related payment data deleted"); render() } catch (error) { toast(error.message || "Invoice could not be deleted") } }
invoices = function () { const q = query.toLowerCase(), rows = state.invoices.filter(invoice => !q || Object.values(invoice).join(" ").toLowerCase().includes(q)).map(invoice => { const paid = invoicePaid(invoice), balance = invoiceBalance(invoice), bd = invoiceTaxBreakdown(invoice), key = escapeHtml(invoiceRecordKey(invoice)); return `<tr><td class="mono"><b>${escapeHtml(invoice.number)}</b></td><td class="mono">${escapeHtml(invoice.ro || "")}</td><td><b>${escapeHtml(invoice.customer)}</b></td><td>${escapeHtml(invoice.date || "")}</td><td>${escapeHtml(invoice.due || "")}</td><td>${balance === 0 ? `<span class="badge paid">Paid</span>` : badge(invoice.status)}</td><td><b>${money(invoice.amount)}</b><small>Subtotal ${money(bd.subtotal)} · Tax ${money(bd.tax)} (${bd.taxRate}%)</small><small>Paid ${money(paid)} · Balance ${money(balance)}</small><div class="invoice-payments"><button class="mini-action" data-print-invoice="${escapeHtml(invoice.number)}">${icon("printer", 13)} Print</button><button class="mini-action" data-edit-invoice="${key}">${icon("pencil", 13)} Edit</button><button class="mini-action danger" data-delete-invoice="${key}">${icon("trash-2", 13)} Delete</button>${balance > 0 ? `<button class="mini-action" data-record-payment="${escapeHtml(invoice.number)}" data-method="cash">${icon("banknote", 13)} Cash</button><button class="mini-action" data-record-payment="${escapeHtml(invoice.number)}" data-method="processor">${icon("credit-card", 13)} Card receipt</button><button class="mini-action invoice-pay" data-pay-invoice="${escapeHtml(invoice.number)}">${icon("external-link", 13)} Pay online</button>` : ""}</div></td></tr>` }).join(""); return shell(`${heading("Accounts receivable", "Invoices", "Edit invoice details and safely remove invoices without payment history.", false)}${stats()}<div class="data-panel"><table><thead><tr><th>Invoice</th><th>Work order</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th>Invoice & payments</th></tr></thead><tbody>${rows || `<tr><td colspan="7">No invoices yet.</td></tr>`}</tbody></table></div>`) };
const bindRecordManagementCore = bindEstimateActions;
bindEstimateActions = function () { bindRecordManagementCore(); document.querySelectorAll("[data-edit-customer]").forEach(button => button.onclick = event => { event.stopPropagation(); openCustomerEditor(decodeURIComponent(button.dataset.editCustomer)) }); document.querySelectorAll("[data-delete-customer]").forEach(button => button.onclick = event => { event.stopPropagation(); deleteCustomerRecord(decodeURIComponent(button.dataset.deleteCustomer)) }); document.querySelectorAll("[data-edit-invoice]").forEach(button => button.onclick = () => openInvoiceEditor(button.dataset.editInvoice)); document.querySelectorAll("[data-delete-invoice]").forEach(button => button.onclick = () => deleteInvoiceRecord(button.dataset.deleteInvoice)) };
const renderOnboardingCore = render;
render = function () { invalidateDerivedCaches(); renderOnboardingCore(); queueMicrotask(checkOnboardingSamples) };

const operationsInventoryCore = operationsInventory;
operationsInventory = function () { const inventory = operationsInventoryCore(), vendorRows = state.vendors.map(vendor => `<tr><td><b>${escapeHtml(vendor.name)}</b><small>${escapeHtml(vendor.accountNumber || "No account number")}</small></td><td>${escapeHtml(vendor.phone || "No phone")}</td><td>${escapeHtml(vendor.email || "No email")}</td><td>${escapeHtml(vendor.address || "No address")}</td><td><button class="mini-action" data-edit-vendor="${escapeHtml(vendor.id)}">${icon("pencil", 13)} Edit</button></td></tr>`).join(""); return `${inventory}<div class="ops-actions vendor-register-head"><span class="ops-note">${state.vendors.length} vendor${state.vendors.length === 1 ? "" : "s"}</span><button class="secondary" id="add-vendor-register">${icon("truck", 14)} Add vendor</button></div><div class="data-panel"><table><thead><tr><th>Vendor</th><th>Phone</th><th>Email</th><th>Address</th><th></th></tr></thead><tbody>${vendorRows || `<tr><td colspan="5">No vendors yet. Add one to assign it to inventory and purchasing defaults.</td></tr>`}</tbody></table></div>` };

addVendor = function (existing = null) { showModal(`<form class="modal" id="vendor-form"><div class="modal-head"><h2>${existing ? "Edit" : "Add"} vendor</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Name *<input name="name" value="${escapeHtml(existing?.name || "")}" required/></label><label>Phone<input name="phone" value="${escapeHtml(existing?.phone || "")}"/></label><label>Email<input name="email" type="email" value="${escapeHtml(existing?.email || "")}"/></label><label>Account number<input name="accountNumber" value="${escapeHtml(existing?.accountNumber || "")}"/></label><label class="full">Address<input name="address" value="${escapeHtml(existing?.address || "")}"/></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} Save vendor</button></div></form>`); document.querySelector("#vendor-form").onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), name = data.name.trim(), duplicate = state.vendors.find(vendor => vendor.id !== existing?.id && vendor.name.toLowerCase() === name.toLowerCase()), button = event.target.querySelector("button[type=submit]"); if (duplicate) { toast("A vendor with this name already exists"); return } button.disabled = true; try { const previousName = existing?.name || "", record = { ...(existing || {}), id: existing?.id || `vendor-${Date.now()}`, name, phone: data.phone.trim(), email: data.email.trim(), accountNumber: data.accountNumber.trim(), address: data.address.trim(), createdAt: existing?.createdAt || now(), updatedAt: existing ? now() : undefined }; await saveShopEntity("vendors", record); if (existing && previousName !== name) { const linkedInventory = state.inventory.filter(item => item.vendor === previousName); await Promise.all(linkedInventory.map(item => saveShopEntity("inventory", { ...item, vendor: name, updatedAt: item.updatedAt || now() }))); const profile = shopProfile(), defaultVendorByKind = Object.fromEntries(Object.entries(profile.defaultVendorByKind || {}).map(([kind, vendor]) => [kind, vendor === previousName ? name : vendor])); if (profile.defaultVendor === previousName || Object.values(profile.defaultVendorByKind || {}).includes(previousName)) await saveProfilePatch({ defaultVendor: profile.defaultVendor === previousName ? name : profile.defaultVendor, defaultVendorByKind }) } closeModal(); toast(existing ? "Vendor updated" : "Vendor added"); render() } catch (error) { console.error("Vendor save failed", error); button.disabled = false; toast(error.message || "Vendor could not be saved") } } };

const bindVendorManagementCore = bindShopOperations;
bindShopOperations = function () { bindVendorManagementCore(); document.querySelector("#add-vendor-register")?.addEventListener("click", () => addVendor()); document.querySelectorAll("[data-edit-vendor]").forEach(button => button.onclick = () => addVendor(state.vendors.find(vendor => vendor.id === button.dataset.editVendor))) };

function clearLocalShopData() { ["orders", "invoices", "customers", "expenses", "vehicles", "payments", "estimates", "shiftEntries", "jobClockEntries", "payrollEntries", "inventory", "vendors", "services", "inspectionTemplates", "inspections", "reminders", "appointments", "purchases", "conversations", "chatMessages"].forEach(type => { if (Array.isArray(state[type])) state[type] = [] }); save() }
async function resetAllShopData(form) { const button = form.querySelector("button[type=submit]"); button.disabled = true; try { const confirmation = new FormData(form).get("confirmation"), result = await apiFetch("/onboarding/start", { method: "POST", body: JSON.stringify({ mode: "all", confirmation }) }); clearLocalShopData(); await reloadOperationalData(); closeModal(); toast(`${result.removed} record${result.removed === 1 ? "" : "s"} removed. The shop is ready for setup.`); render() } catch (error) { button.disabled = false; toast(error.message || "Shop data could not be removed") } }
function openFullReset() { showModal(`<form class="modal" id="full-reset-form"><div class="modal-head"><h2>Remove all shop data</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="messaging-status blocked">${icon("triangle-alert", 17)}<div><strong>This permanently removes the shop's data</strong><span>Customers, vehicles, work orders, invoices, payments, inventory, vendors, messages, schedules, and shop settings will be deleted. User access and the subscription remain active.</span></div></div><label>Type <b>DELETE ALL DATA</b> to continue<input name="confirmation" autocomplete="off" pattern="DELETE ALL DATA" required/></label></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="danger" type="submit">${icon("trash-2", 14)} Permanently remove data</button></div></form>`); document.querySelector("#full-reset-form").onsubmit = event => { event.preventDefault(); resetAllShopData(event.target) } }
const settingsDataResetCore = settings;
settings = function () { const page = settingsDataResetCore(); if (currentUser()?.role !== "admin") return page; return page.replace("</main>", `<section class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Danger zone</div><h2>Start with a clean slate</h2><p>Remove every shop record while keeping employee access and subscription verification intact.</p></div><button type="button" class="danger" id="open-full-reset">${icon("trash-2", 14)} Remove all shop data</button></div></section></main>`) };
const bindDataResetCore = bindExpandedFeatures;
bindExpandedFeatures = function () { bindDataResetCore(); document.querySelector("#open-full-reset")?.addEventListener("click", openFullReset) };
const settingsAgentPhoneCore = settings;
settings = function () { const page = settingsAgentPhoneCore(); if (currentUser()?.role !== "admin") return page; return page.replace("</main>", `<section class="settings-panel agentphone-settings"><div class="statement-head"><div><div class="eyebrow">Voice and messaging</div><h2>Connect AgentPhone.ai</h2><p>Give this shop's AgentPhone agent access to the live MechPro assistant for calls and messages. Credentials are encrypted by the Worker and never stored in the browser.</p></div>${icon("phone-call", 20)}</div><form class="form-grid" id="agentphone-config-form"><label>AgentPhone API key *<input name="apiKey" type="password" autocomplete="new-password" placeholder="ap_..." required/></label><label>Agent ID *<input name="agentId" placeholder="agt_..." required/></label><label>Conversation history<input name="contextLimit" type="number" min="0" max="50" value="10"/></label><label>Voice response timeout<input name="timeout" type="number" min="5" max="120" value="30"/></label><div class="full agentphone-webhook-preview"><span>Webhook URL</span><code>${cloudflareConfig.apiUrl}/agentphone/webhook/${escapeHtml(sessionClaimShopId(authSession()?.claims))}</code></div><div class="full"><button class="primary" type="submit">${icon("plug-zap", 14)} Connect AgentPhone</button><small class="form-help">The AgentPhone webhook signing secret is generated and encrypted and stored in D1 by the Worker.</small></div></form></section></main>`) };
const settingsAppsBillingCore = settings;
settings = function () { const page = settingsAppsBillingCore(); if (!["admin", "super_admin"].includes(currentUser()?.role || "")) return page; return page.replace("</main>", `<section class="settings-panel"><div class="statement-head"><div><div class="eyebrow">Apps and subscription</div><h2>Install MechPro and manage plan</h2><p>Download Windows or Android apps, install the web app on a phone home screen, or convert a free shop to paid.</p></div></div><div class="download-actions"><a class="secondary" href="/downloads" target="_blank" rel="noopener">${icon("download", 14)} Open downloads page</a><a class="secondary" href="/downloads/MechPro.apk">${icon("smartphone", 14)} Android APK</a><a class="secondary" href="/downloads/MechPro-Setup-1.0.0.exe">${icon("monitor", 14)} Windows setup</a><button type="button" class="primary" id="upgrade-shop-plan">${icon("sparkles", 14)} Upgrade to paid</button></div></section></main>`) };

const bindAgentPhoneSettingsCore = bindExpandedFeatures;
bindExpandedFeatures = function () { bindAgentPhoneSettingsCore(); document.querySelector("#agentphone-config-form")?.addEventListener("submit", async event => { event.preventDefault(); const form = event.target, data = Object.fromEntries(new FormData(form)), button = form.querySelector("button[type=submit]"); button.disabled = true; try { const result = await apiFetch("/agentphone/configure", { method: "POST", body: JSON.stringify({ apiKey: data.apiKey, agentId: data.agentId, contextLimit: Number(data.contextLimit), timeout: Number(data.timeout) }) }); form.reset(); toast(`AgentPhone connected for ${result.agentId}`); render() } catch (error) { toast(error.message || "AgentPhone could not be connected"); button.disabled = false } }) };
const bindAssistantGlobalCore = bind;
bind = function () { bindAssistantGlobalCore(); const existing = document.querySelector("#global-assistant-controls"); if (!currentUser()) { existing?.remove(); return } if (existing) return; document.body.insertAdjacentHTML("beforeend", `<div id="global-assistant-controls" aria-label="Assistant controls"><button type="button" class="assistant-float-main" id="global-assistant" title="Open MechPro Assistant">${icon("sparkles", 16)}<span>Assistant</span></button><button type="button" class="assistant-float-pause ${assistantPaused ? "paused" : ""}" data-assistant-pause title="${assistantPaused ? "Resume assistant" : "Pause assistant"}>${icon(assistantPaused ? "play" : "pause", 15)}</button></div>`); document.querySelector("#global-assistant").onclick = openGlobalAssistant; document.querySelector("[data-assistant-pause]").onclick = toggleAssistantPause; lucide.createIcons() };
const apiFetchAssistantCore = apiFetch;
apiFetch = async function (path, options = {}) { return apiFetchAssistantCore(path, options) };
if ("serviceWorker" in navigator && isSecureContext && !isDesktopApp) { window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(error => console.error("Service worker registration failed", error))) }

["admin", "technician", "office", "service_writer"].forEach(role => { if (roleRoutes[role] && !roleRoutes[role].includes("home")) roleRoutes[role] = ["home", ...roleRoutes[role]] });
const shellWithHome = shell;
function homeQuickAction(route, iconName, labelText, extra = "") { if (route && !canAccess(route)) return ""; return `<button class="home-action" type="button" ${route ? `data-route="${route}"` : "data-open-new"} ${extra}>${icon(iconName, 16)}<span>${labelText}</span></button>` }
function homeDashboard() {
  const user = currentUser();
  const model = buildHomeModel({ orders: visibleOrders(), invoices: canAccess("invoices") ? state.invoices : [], appointments: state.appointments, now: new Date() });
  const firstName = String(user.name || "there").split(/\s+/)[0];
  const attention = model.attention.map(item => {
    const tone = item.type === "overdue" ? "warn" : item.type === "parts" ? "parts" : "assign";
    const detail = item.type === "overdue" ? `${item.detail.split(" · ")[0]} · ${money(item.amount || 0)}` : item.detail;
    return `<button class="home-row ${tone}" type="button" ${item.orderId ? `data-order="${escapeHtml(item.orderId)}"` : `data-route="invoices"`}><span class="home-row-icon">${icon(item.type === "overdue" ? "clock-alert" : item.type === "parts" ? "package" : "user-plus", 16)}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(detail)}</small></span>${icon("chevron-right", 14)}</button>`;
  }).join("");
  const todayJobs = model.todayJobs.map(order => `<button class="home-job" type="button" data-order="${escapeHtml(order.id)}"><div><span class="mono">${escapeHtml(order.id)}</span>${badge(order.status)}</div><strong>${escapeHtml(order.customer)}</strong><small>${escapeHtml(order.vehicle)}</small><span class="home-job-meta">${icon("clock-3", 12)}${escapeHtml(order.promise || "Unscheduled")} · ${escapeHtml(order.tech || "Unassigned")}</span></button>`).join("");
  const appointments = model.todaysAppointments.map(item => `<article class="home-appointment"><strong>${escapeHtml(item.time)} · ${escapeHtml(item.customer)}</strong><small>${escapeHtml(item.service)} · ${escapeHtml(item.bay || "Unassigned")}</small></article>`).join("");
  const activity = model.activity.map(item => `<button class="home-row" type="button" ${item.orderId ? `data-order="${escapeHtml(item.orderId)}"` : "data-route=\"invoices\""}><span class="home-row-icon muted">${icon("activity", 15)}</span><span><strong>${escapeHtml(item.title)} · ${escapeHtml(item.customer || "")}</strong><small>${escapeHtml(item.vehicle || item.meta || "")} · ${escapeHtml(label(item.status))}</small></span></button>`).join("");
  const start = model.isEmpty ? `<section class="home-start"><div><div class="eyebrow">Get started</div><h2>Your shop dashboard is ready</h2><p>Create a work order, book a visit, or open the dispatch board. Metrics, today's jobs, and recent activity fill in as soon as records land.</p></div><div class="home-start-actions"><button class="primary" type="button" data-open-new>${icon("plus", 15)} New work order</button>${canAccess("dispatch") ? `<button class="secondary" type="button" data-route="dispatch">${icon("layout-dashboard", 15)} Open dispatch</button>` : ""}</div></section>` : "";
  const quick = `<div class="home-command"><button class="primary home-intake" type="button" id="home-intake">${icon("plus", 18)} New Customer Intake</button><div class="home-actions">${homeQuickAction("orders", "clipboard-list", "View Work Orders")}${homeQuickAction("dispatch", "layout-dashboard", "Dispatch Board")}${homeQuickAction("shopops", "package", "Parts Requests", 'data-ops-tab="ordering"')}${homeQuickAction("customers", "users", "Customers")}${homeQuickAction("pos", "credit-card", "Card terminal")}${homeQuickAction("reports", "pie-chart", "Reports")}${homeQuickAction("payroll", "landmark", "Payroll")}</div></div>`;
  return shell(`<div class="home-hero"><div><div class="eyebrow">${shopDayLabel()}</div><h1>${greetingForNow()}, ${escapeHtml(firstName)}</h1><p>Start with a customer intake. Work orders, dispatch, parts, and payroll stay one click away.</p></div><div class="head-actions"><button class="primary" type="button" id="home-intake-top">${icon("plus", 15)} New Customer Intake</button><button class="secondary" type="button" id="home-new-ro">New work order</button></div></div>${quick}${stats()}${start}<div class="home-grid"><section class="home-panel"><div class="home-panel-head"><div><h2>Needs attention</h2><p>Unassigned jobs, parts holds, and overdue invoices.</p></div><span>${model.attention.length}</span></div><div class="home-list">${attention || `<div class="home-empty">${icon("circle-check", 20)}<p>Nothing waiting on you right now.</p></div>`}</div></section><section class="home-panel"><div class="home-panel-head"><div><h2>Today's work</h2><p>Promise times and active repairs for this shop day.</p></div>${canAccess("dispatch") ? `<button class="mini-action" type="button" data-route="dispatch">View board</button>` : ""}</div><div class="home-jobs">${todayJobs || `<div class="home-empty">${icon("wrench", 20)}<p>No jobs promised for today. Create a work order to populate this list.</p></div>`}</div>${appointments ? `<div class="home-appointments"><h3>Appointments</h3>${appointments}</div>` : ""}</section><section class="home-panel home-panel-wide"><div class="home-panel-head"><div><h2>Recent activity</h2><p>Open work orders and the latest invoice movement.</p></div></div><div class="home-list">${activity || `<div class="home-empty">${icon("clipboard-list", 20)}<p>Activity shows here after the first repair order or invoice.</p></div>`}</div></section></div>`);
}
function bindHomeDashboard() { document.querySelector("#home-new-ro")?.addEventListener("click", openNew); document.querySelectorAll("[data-open-new]").forEach(button => { button.onclick = event => { event.preventDefault(); openNew() } }); document.querySelectorAll("#home-intake, #home-intake-top").forEach(button => button.addEventListener("click", () => openCustomerIntake())); document.querySelectorAll("[data-ops-tab]").forEach(button => button.addEventListener("click", () => { shopOpsTab = button.dataset.opsTab }, true)) }
async function loadPosReaders() { try { await Promise.all([loadOrdersFromApi(), loadInvoicesFromApi(), loadPaymentsFromApi()]); const result = await apiFetch("/payments/terminal/readers"); posConfigured = Boolean(result.configured); posPhoneEntry = Boolean(result.phoneEntry); posReaders = result.readers || [] } catch (error) { posReaders = []; toast(error.message || "Card terminal could not be loaded") } if (state.route === "pos") render() }
function paintPosStatus() { const note = document.querySelector(".pos-status"); if (!note || !posCharge) return; note.dataset.phase = posCharge.phase || ""; note.textContent = posCharge.message || "" }
async function pollPosCharge() { clearTimeout(posPollTimer); if (!posCharge?.paymentIntentId || state.route !== "pos") return; try { const result = await apiFetch(`/payments/terminal/status?paymentIntentId=${encodeURIComponent(posCharge.paymentIntentId)}&readerId=${encodeURIComponent(posCharge.readerId)}`); posCharge = { ...posCharge, ...result }; paintPosStatus(); if (result.phase === "paid") { await loadPaymentsFromApi(); toast("Card payment recorded"); render(); return } if (result.phase === "declined" || result.phase === "canceled") { render(); return } posPollTimer = setTimeout(pollPosCharge, 2000) } catch (error) { toast(error.message || "The reader status could not be read") } }
function loadStripeJs() { if (window.Stripe) return Promise.resolve(); return new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "https://js.stripe.com/v3/"; script.onload = () => resolve(); script.onerror = () => reject(new Error("The secure card form could not be loaded")); document.head.appendChild(script) }) }
async function startPhoneEntry(event) { event.preventDefault(); const form = event.target; const data = Object.fromEntries(new FormData(form)); const button = form.querySelector("#pos-phone-prepare"); button.disabled = true; try { const session = await apiFetch("/payments/terminal/phone", { method: "POST", body: JSON.stringify({ amount: Number(data.amount), targetType: "work_order", targetId: data.orderId }) }); await loadStripeJs(); const stripe = window.Stripe(session.publishableKey); const elements = stripe.elements({ clientSecret: session.clientSecret }); const card = elements.create("payment"); const mount = document.querySelector("#pos-card-element"); mount.replaceChildren(); card.mount(mount); posStripe = { stripe, elements, paymentIntentId: session.paymentIntentId, targetId: data.orderId }; const charge = document.querySelector("#pos-phone-charge"); const status = document.querySelector("#pos-phone-status"); if (charge) charge.hidden = false; form.querySelector("[name=amount]").disabled = true; form.querySelector("[name=orderId]").disabled = true; if (status) { status.hidden = false; status.textContent = session.moto ? "Enter the card from the phone call, then charge it." : "Enter the card from the phone call. This Stripe account is charging it as a keyed card." } } catch (error) { toast(error.message || "The phone card form could not be opened"); button.disabled = false } }
async function confirmPhoneEntry() { if (!posStripe) return; const button = document.querySelector("#pos-phone-charge"); if (button) button.disabled = true; const result = await posStripe.stripe.confirmPayment({ elements: posStripe.elements, redirect: "if_required", confirmParams: { return_url: location.href } }); if (result.error) { toast(result.error.message || "The card was not approved"); if (button) button.disabled = false; return } try { const recorded = await apiFetch(`/payments/terminal/phone/status?paymentIntentId=${encodeURIComponent(posStripe.paymentIntentId)}`); if (recorded.phase !== "paid") { toast(recorded.message || "The card was not approved"); if (button) button.disabled = false; return } await loadPaymentsFromApi(); posStripe = null; toast("Phone card payment recorded"); render() } catch (error) { toast(error.message || "The phone payment could not be recorded"); if (button) button.disabled = false } }
async function savePosWriteup() { const order = (state.orders || []).find(item => item.id === posSelectedId); const writeup = recoveryWriteup({ customer: order?.customer, vehicle: order?.vehicle }); if (!order || !writeup.ready) { toast("Choose a work order with a customer and a vehicle"); return } if (String(order.notes || "").includes("Concern: Vehicle immobilized in mud")) { toast("That write-up is already on the work order"); return } order.notes = [order.notes, writeup.text].filter(Boolean).join("\n\n"); try { const saved = await updateOrderInApi(order); Object.assign(order, saved || {}); toast("Technician write-up saved on the work order"); render() } catch (error) { toast("The write-up could not be saved") } }
function bindPhoneOrder() { document.querySelectorAll("[data-pos-mode]").forEach(button => button.addEventListener("click", () => { posMode = button.dataset.posMode; posStripe = null; render() })); document.querySelector("#pos-phone-form")?.addEventListener("submit", startPhoneEntry); document.querySelector("#pos-phone-charge")?.addEventListener("click", confirmPhoneEntry) }
function bindCardTerminal() { if (state.route !== "pos") return; bindPhoneOrder(); if (posReaders === null) { posReaders = []; loadPosReaders() } document.querySelector("#pos-order")?.addEventListener("change", event => { posSelectedId = event.target.value; posCharge = null; posStripe = null; render() }); document.querySelector("#pos-save-writeup")?.addEventListener("click", savePosWriteup); const form = document.querySelector("#pos-form"); if (!form) return; document.querySelector("#pos-refresh")?.addEventListener("click", () => { posReaders = null; render() }); document.querySelector("#pos-cancel")?.addEventListener("click", async () => { if (!posCharge?.readerId) return; try { await apiFetch("/payments/terminal/cancel", { method: "POST", body: JSON.stringify({ readerId: posCharge.readerId }) }); posCharge = { ...posCharge, phase: "canceled", message: "The reader was cleared." }; clearTimeout(posPollTimer); render() } catch (error) { toast(error.message || "The reader could not be cleared") } }); form.addEventListener("submit", async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const button = form.querySelector("#pos-charge"); button.disabled = true; const reuse = posCharge?.targetId === data.orderId && posCharge?.phase === "declined" ? posCharge.paymentIntentId : ""; try { const result = await apiFetch("/payments/terminal/charge", { method: "POST", body: JSON.stringify({ readerId: data.readerId, amount: Number(data.amount), targetType: "work_order", targetId: data.orderId, paymentIntentId: reuse }) }); posCharge = { ...result, targetId: data.orderId }; render() } catch (error) { toast(error.message || "The card charge could not be started"); button.disabled = false } }); if (posCharge?.phase === "waiting") pollPosCharge() }
const bindPosCore = bind;
bind = function () { bindPosCore(); bindCardTerminal() };
function openAssignmentEditor(order) {
  const assignments = order.assignments?.length ? order.assignments : (order.tech && order.tech !== "Unassigned" ? [{ name: order.tech, role: "primary", sharePercent: 100 }] : []);
  const techs = state.users.filter(user => user.active !== false && classificationFor(user) === "technician" && (user.techName || user.name));
  const options = (role) => `<option value="">Select technician</option>${techs.map(user => `<option value="${escapeAttr(user.id)}" ${assignments.find(item => item.role === role)?.employeeId === user.id ? "selected" : ""}>${escapeHtml(user.techName || user.name)}</option>`).join("")}`;
  const writeIn = assignments.find(item => item.writeIn)?.name || "";
  showModal(`<form class="modal" id="assignment-form"><div class="modal-head"><h2>Assigned technicians</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Primary technician<select name="primary">${options("primary")}</select></label><label>Primary share %<input name="primaryShare" type="number" min="0" max="100" step="1" value="${assignments.find(item => item.role === "primary")?.sharePercent ?? 100}"/></label><label>Secondary technician<select name="secondary">${options("secondary")}</select></label><label>Secondary share %<input name="secondaryShare" type="number" min="0" max="100" step="1" value="${assignments.find(item => item.role === "secondary")?.sharePercent ?? 0}"/></label><label>Apprentice<select name="apprentice">${options("apprentice")}</select></label><label>Apprentice share %<input name="apprenticeShare" type="number" min="0" max="100" step="1" value="${assignments.find(item => item.role === "apprentice")?.sharePercent ?? 0}"/></label><label class="full">Temporary technician name<input name="writeIn" value="${escapeAttr(writeIn)}" placeholder="Subcontractor or temp"/></label></div><p class="form-help">Only technicians appear in the lists. A temporary name is stored on this work order without a payroll rate.</p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">Save assignments</button></div></form>`);
  document.querySelector("#assignment-form").onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const nextAssignments = ["primary", "secondary", "apprentice"].flatMap(role => {
      if (!data[role]) return [];
      const user = state.users.find(item => item.id === data[role]);
      if (!user) return [];
      return [{ id: `${order.id}-${role}`, employeeId: user.id, name: user.techName || user.name, role, sharePercent: Number(data[`${role}Share`]) || 0, assignedAt: new Date().toISOString() }];
    });
    if (String(data.writeIn || "").trim()) nextAssignments.push({ id: `${order.id}-write-in`, name: data.writeIn.trim(), role: nextAssignments.length ? "secondary" : "primary", writeIn: true, sharePercent: 0, hoursWorked: 0, assignedAt: new Date().toISOString() });
    const updated = applyAssignments(order, nextAssignments, state.users);
    const saved = await updateOrderInApi({ ...order, ...updated, updatedAt: order.updatedAt });
    const index = state.orders.findIndex(item => item.id === order.id);
    if (index >= 0) state.orders[index] = saved;
    syncPayroll(saved);
    save();
    closeModal();
    toast(`${saved.id} technicians updated`);
    render();
  };
}
function loadIntakeDraft() { try { const raw = localStorage.getItem(INTAKE_STORAGE_KEY); return raw ? JSON.parse(raw) : null } catch { return null } }
function saveIntakeDraft(draft) { try { localStorage.setItem(INTAKE_STORAGE_KEY, JSON.stringify(serializableIntake(draft))) } catch { /* private browsing or a full quota keeps the in-memory draft */ } }
function openCustomerIntake() {
  const stored = loadIntakeDraft();
  const draft = stored && stored.customer ? stored : emptyIntakeDraft();
  showModal('<div class="modal wide intake-modal" id="intake-host"></div>');
  const backdrop = document.querySelector("#modal-root");
  if (backdrop) backdrop.onclick = event => { if (event.target === backdrop) event.stopPropagation() };
  const host = document.querySelector("#intake-host");
  const profile = shopProfile();
  mountIntakeWizard(host, {
    draft,
    users: state.users,
    laborRate: Number(profile.laborRate || 165),
    taxRate: Number(state.taxSettings?.rate || 0),
    onSave: saveIntakeDraft,
    onCancel: current => { saveIntakeDraft(current); closeModal() },
    decodeVin: async vin => {
      const normalized = String(vin || "").trim().toUpperCase();
      if (normalized.length !== 17) throw new Error("Enter a 17-character VIN first.");
      return apiFetch(`/api/vehicles/decode/${encodeURIComponent(normalized)}`);
    },
    lookupPlate: async () => ({ available: false, message: profile.plateProviderEnabled ? "Plate lookup is enabled in settings but no provider responded." : "Plate lookup is not connected. Enter the plate for the file, then decode the VIN or type the vehicle." }),
    analyze: async current => {
      try {
        const response = await apiFetch("/api/ai/assistant", { method: "POST", body: JSON.stringify({ message: `Shop intake review only. Vehicle ${current.vehicle?.year || ""} ${current.vehicle?.make || ""} ${current.vehicle?.model || ""}. Concern: ${current.concern?.description || ""}. Codes: ${current.diagnosis?.codes || "none"}.` }) });
        if (response?.reply || response?.message) return { source: "assistant", notice: "MechPro assistant response. Confirm every test on the vehicle before selling parts.", causes: [{ name: "Assistant notes", detail: response.reply || response.message }] };
      } catch { /* the assistant stays off unless the shop enables it */ }
      return localDiagnosticChecklist(current);
    },
    onConvert: async current => {
      const name = [current.customer.firstName, current.customer.lastName].filter(Boolean).join(" ");
      const display = current.customer.company ? `${name} (${current.customer.company})` : name;
      const address = [current.customer.address, [current.customer.city, current.customer.state, current.customer.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      const existing = findIntakeCustomer(state.customers, current);
      const customer = await saveCustomerRecord(existing, { name: display, phone: current.customer.phone, email: current.customer.email, billingAddress: address, billingNotes: `Intake ${current.id}` });
      const vehicleId = `veh-${Date.now()}`;
      await saveShopEntity("vehicles", { id: vehicleId, customerId: customer.id, customer: customer.name || display, vin: current.vehicle.vin, year: current.vehicle.year, make: current.vehicle.make, model: current.vehicle.model, plate: current.vehicle.plate, mileage: current.vehicle.mileage, color: current.vehicle.color });
      const max = state.orders.reduce((highest, order) => Math.max(highest, Number(String(order.id).replace(/\D/g, "")) || 0), 1040);
      const record = intakeOrderPayload(current, { id: `RO-${max + 1}`, laborRate: Number(profile.laborRate || 165), taxRate: Number(state.taxSettings?.rate || 0), users: state.users, customer });
      record.intake.photos = [];
      for (const photo of current.photos || []) {
        if (!photo.file) { record.intake.photos.push(photo); continue }
        try {
          const fileId = await uploadFileToStorage(photo.file, "intake", photo.file.type || "image/jpeg", { apiFetch });
          record.intake.photos.push({ id: photo.id, slot: photo.slot, name: photo.name, contentType: photo.contentType, takenAt: photo.takenAt, fileId });
        } catch (error) {
          record.intake.photos.push({ id: photo.id, slot: photo.slot, name: photo.name, takenAt: photo.takenAt, uploadError: error.message || "Upload failed" });
        }
      }
      let saved = record;
      if (!isOfflineDesktop()) {
        const response = await apiFetch("/entities/orders", { method: "POST", body: JSON.stringify(record) });
        saved = response?.queued ? record : (response || record);
      }
      state.orders.unshift(saved);
      localStorage.removeItem(INTAKE_STORAGE_KEY);
      save();
      closeModal();
      toast(`${saved.id} created from intake`);
      render();
    },
  });
}
const renderHomeCore = render;
render = function () { if (currentUser() && state.route === "home") { const root = document.querySelector("#root"); root.innerHTML = safeHtml(homeDashboard()); lucide.createIcons(); bind(); bindExpandedFeatures(); attachShopOperationsRoute(); bindHomeDashboard(); queueMicrotask(checkOnboardingSamples); return } renderHomeCore() };
let customerListEpoch = 0;
function applyRemoteList(key, records, entityType = key) { const pending = pendingCreateIdsForCollection(key, readMutationQueue(), shopEntityCollections); const remote = mergeRemoteCollection(key, records, state[key], localSampleRecord, pending); state[key] = applyQueuedEntityMutations(entityType, remote, readMutationQueue()); save() }
loadOrdersFromApi = async function () { try { applyRemoteList("orders", await apiFetch("/entities/orders")) } catch (error) { console.error("Failed to load orders from API; using local data", error) } };
loadCustomersFromApi = async function () { const epoch = customerListEpoch; try { const records = await apiFetch("/entities/customers"); if (epoch !== customerListEpoch) return; applyRemoteList("customers", records) } catch (error) { console.error("Failed to load customers from API; using local data", error) } };
loadInvoicesFromApi = async function () { try { applyRemoteList("invoices", await apiFetch("/entities/invoices")) } catch (error) { console.error("Failed to load invoices from API; using local data", error) } };
loadExpensesFromApi = async function () { try { applyRemoteList("expenses", await apiFetch("/entities/expenses")) } catch (error) { console.error("Failed to load expenses from API; using local data", error) } };
loadShopEntities = async function () { try { const types = Object.keys(shopEntityCollections), results = await Promise.all(types.map(type => apiFetch(`/entities/${type}`))); types.forEach((type, index) => applyRemoteList(shopEntityCollections[type], results[index], type)); const tax = state.shopSettingsRecords.find(item => item.id === "tax"); if (tax) state.taxSettings = { state: tax.state || "TX", taxId: String(tax.taxId || ""), rate: Number(tax.rate) || 0, filingFrequency: tax.filingFrequency || "Monthly", ein: String(tax.ein || ""), texasTaxpayerNumber: String(tax.texasTaxpayerNumber || ""), webfileNumber: String(tax.webfileNumber || ""), jurisdictions: Array.isArray(tax.jurisdictions) ? tax.jurisdictions : null } } catch (error) { console.error("Failed to load shop operations; using local data", error) } await ensureCannedMenu() };
function stampDemoAppointments() { const samples = new Set(["apt-1048", "apt-1049", "apt-1052"]); if (!(state.appointments || []).some(item => samples.has(item.id))) return; const today = new Date(), iso = localIsoDate(today), tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1); const next = localIsoDate(tomorrow); state.appointments = state.appointments.map(item => item.id === "apt-1048" || item.id === "apt-1049" ? { ...item, date: iso } : item.id === "apt-1052" ? { ...item, date: next } : item) }
stampDemoAppointments();

async function loadEmployeesFromApi() {
  if (isOfflineDesktop()) return;
  try {
    const employees = await apiFetch("/entities/employees");
    if (Array.isArray(employees)) {
      state.users = sanitizeUsers(employees);
      save();
    }
  } catch (error) {
    console.error("Failed to load employees from API; using local data", error);
  }
}

function employeeFormValue(employee, field, fallback = "") {
  return escapeAttr(employee?.[field] ?? fallback);
}

async function saveEmployeeRecord(existing, data) {
  const email = String(existing?.email || data.workEmail || data.email || "").trim().toLowerCase();
  const record = {
    ...(existing || {}),
    id: existing?.id || `user-${Date.now()}`,
    name: data.name.trim(),
    email,
    role: data.role,
    title: String(data.title || "").trim(),
    techName: String(data.techName || "").trim(),
    active: existing?.active !== false,
    employeeId: data.employeeId.trim(),
    phone: String(data.phone || "").trim(),
    address: String(data.address || "").trim(),
    startDate: data.startDate,
    employmentType: data.employmentType,
    payRate: Number(data.payRate),
    payFrequency: data.payFrequency,
    classification: data.classification || classificationFor({ role: data.role, classification: existing?.classification }),
    payPlan: PAY_PLANS.some(plan => plan.id === data.payPlan) ? data.payPlan : (existing?.payPlan || "hourly"),
    commissionPercent: Number(data.commissionPercent) || 0,
    department: String(data.department || "").trim(),
    emergencyContact: String(data.emergencyContact || "").trim(),
    taxStatus: data.taxStatus,
    w4FilingStatus: data.w4FilingStatus || existing?.w4FilingStatus || "single",
    w4Step2Checkbox: String(data.w4Step2Checkbox) === "true",
    w4DependentCredits: Number(data.w4DependentCredits) || 0,
    w4OtherIncome: Number(data.w4OtherIncome) || 0,
    w4Deductions: Number(data.w4Deductions) || 0,
    w4ExtraWithholding: Number(data.w4ExtraWithholding) || 0,
    pretaxDeductionPerPeriod: Number(data.pretaxDeductionPerPeriod) || 0,
    stateWithholdingRate: Number(data.stateWithholdingRate) || 0,
    federalWithholdingRate: Number(existing?.federalWithholdingRate) || 0,
    ssn: String(data.ssn || existing?.ssn || "").replace(/\D/g, "").slice(-4),
    createdAt: existing?.createdAt || now(),
    updatedAt: existing?.updatedAt,
  };
  let saved = record;
  if (!isOfflineDesktop()) {
    const path = existing
      ? `/entities/employees/${encodeURIComponent(record.id)}`
      : "/entities/employees";
    const response = await apiFetch(path, {
      method: existing ? "PUT" : "POST",
      body: JSON.stringify(record),
    });
    if (response?.queued) throw new Error("Employee profiles require a live connection.");
    saved = response;
  }
  const index = state.users.findIndex(user => user.id === saved.id);
  if (index >= 0) state.users[index] = saved;
  else state.users.push(saved);
  save();
  return saved;
}

employees = function () {
  const rows = state.users.map(user => `<tr><td><div class="employee-name"><span class="avatar">${initials(user.name)}</span><div><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.employeeId || "Pending ID")} · ${escapeHtml(user.email)}</small></div></div></td><td>${escapeHtml(roleLabel[user.role] || user.role)}<small>${escapeHtml(user.title || "No title")} · ${escapeHtml(user.department || "Unassigned")}</small></td><td>${escapeHtml(user.employmentType || "—")}<small>${escapeHtml(user.payFrequency || "—")} · ${user.payRate ? user.employmentType === "Salary" ? money(user.payRate) + " / yr" : money(user.payRate) + " / hr" : "Rate pending"}</small></td><td>${escapeHtml(user.phone || "—")}<small>${escapeHtml(user.startDate || "Start date pending")}</small></td><td><span class="badge ${user.active ? "paid" : "overdue"}">${user.active ? "Active" : "Inactive"}</span><small>${escapeHtml(user.techName || "No dispatch identity")}</small></td><td><div class="record-actions"><button class="mini-action" data-edit-employee="${escapeAttr(user.id)}">${icon("pencil", 13)} Edit</button><button class="mini-action" data-toggle-user="${escapeAttr(user.id)}" ${user.id === currentUser().id ? "disabled" : ""}>${user.active ? "Deactivate" : "Activate"}</button></div></td></tr>`).join("");
  return shell(`${heading("Team access", "Employees", "Employee records, employment details, payroll rates, and login access.", false)}<div class="employee-actions"><div class="access-note">${icon("shield-check", 15)} Employee profiles are saved to this shop and remain available after sign-in or refresh.</div><button class="primary" id="new-employee">${icon("user-plus", 15)} Add employee</button></div><div class="data-panel"><table><thead><tr><th>Employee record</th><th>Role & department</th><th>Employment & pay</th><th>Contact & start</th><th>Access</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No employee profiles yet.</td></tr>`}</tbody></table></div>`);
};

openEmployee = function (existing = null) {
  showModal(`<form class="modal wide" id="employee-form"><div class="modal-head"><h2>${existing ? "Edit employee profile" : "Create employee profile"}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><h3>Identity & access</h3><div class="form-grid"><label>Employee name *<input name="name" required value="${employeeFormValue(existing, "name")}"/></label><label>Employee ID *<input name="employeeId" required value="${employeeFormValue(existing, "employeeId")}" placeholder="EMP-005"/></label><label>Job title<input name="title" value="${employeeFormValue(existing, "title")}"/></label><label>Department<input name="department" value="${employeeFormValue(existing, "department")}"/></label><label class="full">Email address *<input type="email" name="email" required value="${employeeFormValue(existing, "email")}" ${existing ? "readonly" : ""}/></label><label>Role<select name="role">${["technician", "office", "service_writer", "admin"].map(role => `<option value="${role}" ${existing?.role === role ? "selected" : ""}>${roleLabel[role]}</option>`).join("")}</select></label><label class="full">Technician dispatch name<input name="techName" value="${employeeFormValue(existing, "techName")}" placeholder="Required for technicians, e.g. Eli R."/></label></div><h3>Employment information</h3><div class="form-grid"><label>Employment type<select name="employmentType">${["Hourly", "Salary", "Contractor"].map(value => `<option ${existing?.employmentType === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>Pay rate *<input name="payRate" type="number" min="0" step=".01" required value="${Number(existing?.payRate || 0)}"/></label><label>Pay frequency<select name="payFrequency">${["Weekly", "Biweekly", "Monthly"].map(value => `<option ${existing?.payFrequency === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>Start date<input name="startDate" type="date" value="${employeeFormValue(existing, "startDate", new Date().toISOString().slice(0, 10))}"/></label><label>Tax status<select name="taxStatus">${["W-2", "1099 Contractor"].map(value => `<option ${existing?.taxStatus === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>Phone<input name="phone" type="tel" value="${employeeFormValue(existing, "phone")}"/></label><label class="full">Home address<input name="address" value="${employeeFormValue(existing, "address")}"/></label><label class="full">Emergency contact<input name="emergencyContact" value="${employeeFormValue(existing, "emergencyContact")}"/></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} ${existing ? "Save employee" : "Create profile"}</button></div></form>`);
  document.querySelector("#employee-form").onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const email = String(existing?.email || data.email).trim().toLowerCase();
    if (!existing && state.users.some(user => user.email.toLowerCase() === email)) return toast("An employee profile already uses that email");
    if (state.users.some(user => user.id !== existing?.id && user.employeeId === data.employeeId.trim())) return toast("An employee already uses that employee ID");
    if (data.role === "technician" && !data.techName.trim()) return toast("Add the technician dispatch name to save this profile");
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const saved = await saveEmployeeRecord(existing, data);
      closeModal();
      toast(`${saved.name} profile saved`);
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message || "Could not save employee profile");
    }
  };
};

async function setEmployeeActive(user) {
  const updated = { ...user, active: !user.active };
  if (!isOfflineDesktop()) {
    const saved = await apiFetch(`/entities/employees/${encodeURIComponent(user.id)}`, {
      method: "PUT",
      body: JSON.stringify(updated),
    });
    if (saved?.queued) throw new Error("Employee access changes require a live connection.");
    Object.assign(updated, saved);
  }
  state.users[state.users.indexOf(user)] = updated;
  save();
  return updated;
}

async function saveCustomerRecord(existing, data) {
  customerListEpoch += 1;
  const contact = customerContactFields(data, existing);
  if (!contact.name) throw new Error("Customer name is required");
  const record = {
    ...(existing || {}),
    ...contact,
    id: existing?.id || mutationId(),
    vehicles: Number(existing?.vehicles || 0),
    visits: Number(existing?.visits || 0),
    spend: Number(existing?.spend || 0),
    createdAt: existing?.createdAt || now(),
    updatedAt: existing?.updatedAt,
  };
  let saved = record;
  if (!isOfflineDesktop()) {
    const response = await apiFetch(existing ? `/entities/customers/${encodeURIComponent(record.id)}` : "/entities/customers", {
      method: existing ? "PUT" : "POST",
      body: JSON.stringify(record),
    });
    saved = mergeSavedCustomer(record, response);
  }
  const index = existing ? state.customers.indexOf(existing) : -1;
  if (index >= 0) state.customers[index] = saved;
  else state.customers.unshift(saved);
  save();
  return saved;
}

function openCustomerForm(existing = null) {
  showModal(`<form class="modal" id="customer-edit-form"><div class="modal-head"><h2>${existing ? "Edit customer" : "Add customer"}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="form-grid"><label>Name *<input name="name" value="${escapeAttr(existing?.name || "")}" required/></label><label>Phone<input name="phone" value="${escapeAttr(existing?.phone || "")}"/></label><label class="full">Email<input name="email" type="email" value="${escapeAttr(existing?.email === "Not provided" ? "" : existing?.email || "")}"/></label><label>Billing address<textarea name="billingAddress">${escapeHtml(existing?.billingAddress || "")}</textarea></label><label>Billing notes<textarea name="billingNotes">${escapeHtml(existing?.billingNotes || "")}</textarea></label></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("save", 14)} Save customer</button></div></form>`);
  document.querySelector("#customer-edit-form").onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (state.customers.some(customer => customer !== existing && customer.name.toLowerCase() === data.name.trim().toLowerCase())) return toast("A customer already uses that name");
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await saveCustomerRecord(existing, data);
      closeModal();
      toast("Customer saved");
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message || "Customer could not be saved");
    }
  };
}

openCustomerEditor = function (key) {
  const customer = state.customers.find(item => customerRecordKey(item) === key);
  if (customer) openCustomerForm(customer);
};

customers = function () {
  const q = query.toLowerCase();
  const cards = state.customers.filter(item => !q || Object.values(item).join(" ").toLowerCase().includes(q)).map(item => {
    const key = encodeURIComponent(customerRecordKey(item));
    const vehicleCount = state.vehicles.filter(vehicle => vehicle.customer === item.name).length;
    const visitCount = state.orders.filter(order => order.customer === item.name).length;
    const lifetimeSpend = customerLifetimeSpend(item, state.invoices);
    return `<article class="customer-card" data-open-customer="${encodeURIComponent(item.name)}"><div class="customer-top"><div class="avatar">${initials(item.name)}</div><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.phone || "No phone")} · ${escapeHtml(item.email || "No email")}</p>${item.billingAddress ? `<p>${escapeHtml(item.billingAddress)}</p>` : ""}</div></div><div class="customer-stats"><div><span>Vehicles</span><b>${Math.max(Number(item.vehicles || 0), vehicleCount)}</b></div><div><span>Lifetime spend</span><b>${money(lifetimeSpend)}</b></div><div><span>Shop visits</span><b>${Math.max(Number(item.visits || 0), visitCount)}</b></div><div><span>Balance</span><b>${money(customerBalance(item.name))}</b></div></div><div class="customer-card-actions"><button class="customer-message" data-message-customer="${encodeURIComponent(item.name)}" data-message-phone="${encodeURIComponent(item.phone || "")}" data-message-email="${encodeURIComponent(item.email || "")}">${icon("send", 14)} Message</button><button class="mini-action" data-edit-customer="${key}">${icon("pencil", 14)} Edit</button><button class="mini-action danger" data-delete-customer="${key}">${icon("trash-2", 14)} Delete</button></div></article>`;
  }).join("");
  return shell(`${heading("Relationships", "Customers", "Create, find, and update customer records saved to this shop.", false)}<div class="ops-actions"><button class="primary" id="new-customer">${icon("user-plus", 14)} Add customer</button></div><div class="customer-grid">${cards || empty("No customers yet")}</div>`);
};

const openNewCore = openNew;

function customerIntakeResultMarkup(result, index) {
  const contact = [result.phone, result.email].filter(Boolean).join(" · ") || "No phone or email on file";
  const vehicle = result.recentVehicle?.label || result.recentVehicle?.vehicle || "No vehicle on file";
  return `<button class="customer-search-option" type="button" role="option" data-customer-result="${index}"><span><strong>${escapeHtml(result.name)}</strong><small>${escapeHtml(contact)}</small></span><span class="customer-search-vehicle">${escapeHtml(vehicle)}<small>${Number(result.vehicleCount || result.vehicles?.length || 0)} vehicle${Number(result.vehicleCount || result.vehicles?.length || 0) === 1 ? "" : "s"}</small></span></button>`;
}

function installCustomerIntakeFields(form) {
  const oldSelect = form.elements.customerSelect;
  const customerInput = form.elements.customer;
  if (!oldSelect || !customerInput) return;
  oldSelect.closest("label").hidden = true;
  oldSelect.closest("label").style.display = "none";
  customerInput.hidden = false;
  customerInput.required = true;
  customerInput.autocomplete = "off";
  customerInput.placeholder = "Start typing a first or last name";
  customerInput.setAttribute("role", "combobox");
  customerInput.setAttribute("aria-autocomplete", "list");
  customerInput.setAttribute("aria-controls", "customer-search-results");
  customerInput.setAttribute("aria-expanded", "false");
  customerInput.closest("label").firstChild.textContent = "Customer name *";
  customerInput.closest("label").classList.add("customer-search-field", "full");
  customerInput.closest("label").insertAdjacentHTML("beforeend", `<small class="customer-search-help">Type at least ${CUSTOMER_SEARCH_MIN_LENGTH} characters to search existing customers.</small>`);
  customerInput.closest("label").insertAdjacentHTML("afterend", `<div class="customer-search-results full" id="customer-search-results" role="listbox" aria-label="Matching customers" hidden></div>`);
  form.elements.phone.closest("label").insertAdjacentHTML("afterend", `<label>Email<input name="email" type="email" autocomplete="email"/></label><label class="full">Billing address<input name="billingAddress" autocomplete="street-address"/></label><input name="selectedCustomerId" type="hidden"/><div class="duplicate-customer-warning full" id="duplicate-customer-warning" role="alert" hidden></div>`);
}

function bindCustomerIntakeSearch(form) {
  const input = form.elements.customer;
  const resultsElement = document.querySelector("#customer-search-results");
  const duplicateElement = document.querySelector("#duplicate-customer-warning");
  if (!input || !resultsElement) return { selected: () => null, select: () => {} };
  let timer = null;
  let requestSequence = 0;
  let controller = null;
  let results = [];
  let selectedCustomer = null;
  let dismissedQuery = "";

  const hideResults = () => {
    resultsElement.hidden = true;
    resultsElement.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  };
  const showStatus = message => {
    resultsElement.hidden = false;
    resultsElement.innerHTML = `<div class="customer-search-status">${escapeHtml(message)}</div>`;
    input.setAttribute("aria-expanded", "true");
  };
  const showResults = (matches, source) => {
    results = matches;
    resultsElement.hidden = false;
    input.setAttribute("aria-expanded", "true");
    resultsElement.innerHTML = `<div class="customer-search-head"><span>${matches.length ? `${matches.length} existing customer${matches.length === 1 ? "" : "s"} found${source === "local" ? " · saved on this device" : ""}` : "No matching customers found"}</span><button type="button" class="customer-search-dismiss">Dismiss</button></div>${matches.map(customerIntakeResultMarkup).join("")}`;
    resultsElement.querySelector(".customer-search-dismiss").onclick = () => {
      dismissedQuery = input.value.trim();
      hideResults();
      input.focus();
    };
    resultsElement.querySelectorAll("[data-customer-result]").forEach(button => {
      button.onclick = () => selectCustomer(results[Number(button.dataset.customerResult)]);
      button.onkeydown = event => {
        const options = [...resultsElement.querySelectorAll("[data-customer-result]")];
        const index = options.indexOf(button);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          (options[index + 1] || options[0])?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          (options[index - 1] || options.at(-1))?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          hideResults();
          input.focus();
        }
      };
    });
  };
  const selectCustomer = customer => {
    if (!customer) return;
    selectedCustomer = customer;
    form.elements.selectedCustomerId.value = customer.id;
    input.value = customer.name || "";
    form.elements.phone.value = customer.phone || "";
    form.elements.email.value = customer.email || "";
    form.elements.billingAddress.value = customer.billingAddress || "";
    const localIndex = state.customers.findIndex(item => (
      item.id === customer.id
      || String(item.name || "").trim().toLowerCase() === String(customer.name || "").trim().toLowerCase()
    ));
    const localRecord = { ...customer, vehicles: Number(customer.vehicleCount || customer.vehicles?.length || 0) };
    if (localIndex >= 0) state.customers[localIndex] = { ...state.customers[localIndex], ...localRecord };
    else state.customers.unshift(localRecord);
    for (const vehicle of customer.vehicles || []) {
      if (!state.vehicles.some(item => item.id === vehicle.id)) {
        state.vehicles.push({ ...vehicle, customer: customer.name, customerId: customer.id });
      }
    }
    form.elements.vehicleSelect.innerHTML = vehicleOptionsForCustomer(customer.name);
    form.elements.vehicleSelect.value = "";
    form.elements.vehicle.readOnly = false;
    duplicateElement.hidden = true;
    hideResults();
    input.focus();
  };
  const runSearch = async () => {
    const queryValue = input.value.trim();
    if (!shouldSearchCustomers(queryValue) || queryValue === dismissedQuery) {
      hideResults();
      return;
    }
    const sequence = ++requestSequence;
    controller?.abort();
    controller = new AbortController();
    showStatus("Searching customers…");
    try {
      const response = await apiFetch(`/customers/search?q=${encodeURIComponent(queryValue)}`, { signal: controller.signal });
      if (sequence !== requestSequence || input.value.trim() !== queryValue) return;
      showResults(response.results || [], "cloud");
    } catch (error) {
      if (sequence !== requestSequence || error.name === "AbortError") return;
      showResults(localCustomerMatches(queryValue, state.customers, state.vehicles), "local");
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    controller?.abort();
    requestSequence += 1;
    dismissedQuery = "";
    duplicateElement.hidden = true;
    if (selectedCustomer && input.value.trim() !== selectedCustomer.name) {
      selectedCustomer = null;
      form.elements.selectedCustomerId.value = "";
      form.elements.vehicleSelect.innerHTML = vehicleOptionsForCustomer("");
    }
    if (!shouldSearchCustomers(input.value)) {
      hideResults();
      return;
    }
    timer = setTimeout(runSearch, CUSTOMER_SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && !resultsElement.hidden) {
      event.preventDefault();
      resultsElement.querySelector("[data-customer-result]")?.focus();
    } else if (event.key === "Escape") {
      hideResults();
    }
  });
  [form.elements.phone, form.elements.email].forEach(field => field.addEventListener("input", () => {
    form.dataset.duplicateConfirmed = "";
    duplicateElement.hidden = true;
  }));
  input.focus();
  return { selected: () => selectedCustomer, select: selectCustomer };
}

async function intakeDuplicateMatches(data) {
  try {
    const response = await apiFetch("/customers/duplicates", {
      method: "POST",
      body: JSON.stringify({ phone: data.phone, email: data.email }),
    });
    return response.results || [];
  } catch {
    return likelyDuplicateCustomers(data, state.customers, state.vehicles);
  }
}

function showIntakeDuplicateWarning(form, matches, picker, confirmationKey) {
  const warning = document.querySelector("#duplicate-customer-warning");
  warning.hidden = false;
  warning.innerHTML = `<strong>Possible duplicate customer</strong><p>This phone or email matches an existing customer. Link this work order or explicitly continue:</p>${matches.map((match, index) => `<button type="button" class="duplicate-customer-use" data-duplicate-result="${index}">Use ${escapeHtml(match.name)} instead</button>`).join("")}<button type="button" class="duplicate-customer-continue">Create a new customer anyway</button>`;
  warning.querySelectorAll("[data-duplicate-result]").forEach(button => {
    button.onclick = () => {
      picker.select(matches[Number(button.dataset.duplicateResult)]);
      form.requestSubmit();
    };
  });
  warning.querySelector(".duplicate-customer-continue").onclick = () => {
    form.dataset.duplicateConfirmed = confirmationKey;
    warning.hidden = true;
    form.requestSubmit();
  };
  warning.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

openNew = function () {
  openNewCore();
  const form = document.querySelector("#new-form");
  if (!form) return;
  installCustomerIntakeFields(form);
  const customerPicker = bindCustomerIntakeSearch(form);
  form.onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const customerName = String(data.customer || "").trim();
    if (!customerName) return toast("Select or enter a customer name");
    const button = form.querySelector("button[type=submit], button:not([type])");
    button.disabled = true;
    try {
      const selectedCustomer = customerPicker.selected();
      const duplicateKey = `${String(data.phone || "").replace(/\D/g, "")}|${String(data.email || "").trim().toLowerCase()}`;
      if (!selectedCustomer && duplicateKey !== "|" && form.dataset.duplicateConfirmed !== duplicateKey) {
        const duplicates = await intakeDuplicateMatches(data);
        if (duplicates.length) {
          button.disabled = false;
          showIntakeDuplicateWarning(form, duplicates, customerPicker, duplicateKey);
          return;
        }
      }
      let customer = selectedCustomer || state.customers.find(item => item.id === data.selectedCustomerId) || state.customers.find(item => item.name.toLowerCase() === customerName.toLowerCase());
      const contact = customerContactFields({
        name: customerName,
        phone: data.phone,
        email: data.email,
        billingAddress: data.billingAddress,
      }, customer);
      if (!customer || customerContactChanged(customer, contact)) {
        customer = await saveCustomerRecord(customer || null, contact);
      }
      const estimate = readNewOrderEstimate();
      const id = `RO-${Math.max(1040, ...state.orders.map(item => Number(item.id.split("-")[1]) || 0)) + 1}`;
      const order = {
        id,
        customerId: customer.id,
        customer: customer.name,
        phone: data.phone || customer.phone,
        vehicle: data.vehicle,
        vin: String(data.vin || "").trim().toUpperCase() || "VIN pending",
        complaint: data.complaint,
        status: data.status,
        priority: data.priority,
        tech: data.tech,
        bay: data.bay,
        mobile: data.bay === "Mobile",
        promise: data.promise,
        total: estimate.total,
        scheduled: "Unscheduled",
        notes: "New intake. Diagnosis pending.",
        labor: estimate.labor,
        laborHours: estimate.laborHours,
        parts: estimate.parts,
        tax: estimate.tax,
        estimate: {
          ...estimate,
          generatedAt: now(),
          summary: `Preliminary estimate for ${data.vehicle}. Verify vehicle condition, part fitment, and customer authorization before repair.`,
        },
      };
      let saved = order;
      if (!isOfflineDesktop() && !isLocalShell()) {
        const response = await apiFetch("/entities/orders", { method: "POST", body: JSON.stringify(order) });
        saved = response?.queued ? order : response;
      }
      state.orders.unshift(saved);
      save();
      closeModal();
      toast(`${id} created successfully`);
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message || "Work order could not be saved");
    }
  };
};

orders = function () {
  const rows = filtered().map(order => `<tr data-order="${escapeAttr(order.id)}"><td class="mono strong">${escapeHtml(order.id)}</td><td><b>${escapeHtml(order.customer)}</b><small>${escapeHtml(order.phone || "")}</small></td><td><b>${escapeHtml(order.vehicle)}</b><small class="mono">${escapeHtml(order.vin || "")}</small></td><td>${badge(order.status)}</td><td>${escapeHtml(assignmentSummary(order, state.users))}<small>${escapeHtml(order.bay || "Unassigned")}</small></td><td>${escapeHtml(order.promise || "Unscheduled")}</td><td><b>${money(order.total)}</b></td><td><button class="mini-action" type="button" data-edit-order="${escapeAttr(order.id)}">${icon("pencil", 13)} Edit</button></td></tr>`).join("");
  return shell(`${heading("Operations", "Work orders", "Open and edit customer, vehicle, assignment, status, and service details.")}${toolbar()}<div class="data-panel"><table><thead><tr><th>RO number</th><th>Customer</th><th>Vehicle</th><th>Status</th><th>Assignment</th><th>Promise</th><th>Total</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>${rows ? "" : empty("No matching work orders")}</div>`);
};

updateOrderInApi = async function (record) {
  if (["completed", "invoiced"].includes(record.status)) await ensureInvoiceForOrder(record);
  if (isOfflineDesktop()) return record;
  const saved = await apiFetch(`/entities/orders/${encodeURIComponent(record.id)}`, {
    method: "PUT",
    body: JSON.stringify(record),
  });
  return saved?.queued ? record : saved;
};

openOrder = function (id) {
  const order = state.orders.find(item => item.id === id);
  if (!order) return;
  const canManage = ["admin", "service_writer"].includes(currentUser().role);
  if (!canManage) {
    toast("Only an admin or service writer can edit this work order");
    return;
  }
  showModal(`<form class="modal wide" id="work-order-edit-form"><div class="modal-head"><div><span class="mono">${escapeHtml(order.id)}</span><h2>Edit work order</h2></div><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><h3>Customer & vehicle</h3><div class="form-grid"><label>Customer *<select name="customer" required>${customerOptions(order.customer)}</select></label><label>Phone<input name="phone" value="${escapeAttr(order.phone || "")}"/></label><label class="full">Vehicle description *<input name="vehicle" required value="${escapeAttr(order.vehicle || "")}"/></label><label class="full">VIN<input name="vin" maxlength="17" value="${escapeAttr(order.vin === "VIN pending" ? "" : order.vin || "")}"/></label></div><h3>Service details</h3><div class="form-grid"><label class="full">Customer complaint *<textarea name="complaint" required>${escapeHtml(order.complaint || "")}</textarea></label><label>Status<select name="status">${["estimate", "approved", "in_progress", "waiting_parts", "completed", "invoiced"].map(status => `<option value="${status}" ${order.status === status ? "selected" : ""}>${label(status)}</option>`).join("")}</select></label><label>Priority<select name="priority">${["normal", "high", "low"].map(priority => `<option value="${priority}" ${order.priority === priority ? "selected" : ""}>${label(priority)}</option>`).join("")}</select></label><label>Technician<select name="tech">${techOptions(order.tech || "Unassigned")}</select></label><label>Bay / assignment<select name="bay">${["Unassigned", "Bay 1", "Bay 2", "Bay 3", "Bay 4", "Mobile"].map(bay => `<option ${order.bay === bay ? "selected" : ""}>${bay}</option>`).join("")}</select></label><label>Promise time<input name="promise" value="${escapeAttr(order.promise || "")}"/></label><label>Labor hours<input name="laborHours" type="number" min="0" step=".25" value="${Number(order.laborHours || 0)}"/></label><label class="full">Technician / service notes<textarea name="notes">${escapeHtml(order.notes || "")}</textarea></label></div></div><div class="modal-actions"><button class="secondary danger" type="button" id="delete-order">${icon("trash-2", 14)} Delete</button><button class="primary" type="submit">${icon("save", 14)} Save work order</button></div></form>`);
  const form = document.querySelector("#work-order-edit-form");
  form.onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const next = {
      ...order,
      customer: data.customer,
      phone: data.phone.trim(),
      vehicle: data.vehicle.trim(),
      vin: data.vin.trim().toUpperCase() || "VIN pending",
      complaint: data.complaint.trim(),
      status: data.status,
      priority: data.priority,
      tech: data.tech,
      bay: data.bay,
      mobile: data.bay === "Mobile",
      promise: data.promise.trim(),
      laborHours: Math.max(0, Number(data.laborHours) || 0),
      notes: data.notes.trim(),
      updatedAt: order.updatedAt,
    };
    const firstCompletion = ["completed", "invoiced"].includes(next.status) && !["completed", "invoiced"].includes(order.status);
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      if (firstCompletion && !await commitLinkedInventory(next)) return;
      const saved = await updateOrderInApi(next);
      state.orders[state.orders.indexOf(order)] = saved;
      syncPayroll(saved);
      save();
      closeModal();
      toast(`${saved.id} saved`);
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message || "Work order could not be saved");
    }
  };
  document.querySelector("#delete-order").onclick = async () => {
    if (!confirm(`Delete ${order.id}?`)) return;
    try {
      if (!isOfflineDesktop()) await apiFetch(`/entities/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
      state.orders = state.orders.filter(item => item !== order);
      save();
      closeModal();
      toast(`${order.id} deleted`);
      render();
    } catch (error) {
      toast(error.message || "Work order could not be deleted");
    }
  };
};

function expandedEstimateLines(estimate = {}) {
  return (estimate.lines || []).flatMap((line, index) => {
    if (line.type) return [normalizeEstimateLine(line, index)];
    const rows = [];
    const labor = Math.max(0, Number(line.labor ?? (Number(line.hours || 0) * Number(line.laborRate || 165))) || 0);
    const hours = Math.max(0, Number(line.hours) || 0);
    if (labor || hours) rows.push(normalizeEstimateLine({
      ...line,
      id: line.id || `labor-${index + 1}`,
      type: "labor",
      description: line.description || line.service,
      notes: line.notes || line.explanation,
      hours,
      laborRate: hours ? labor / hours : Number(line.laborRate || 165),
    }, index));
    const parts = Math.max(0, Number(line.parts) || 0);
    if (parts) rows.push(normalizeEstimateLine({
      id: `part-${index + 1}`,
      type: "part",
      description: `${line.service || "Service"} parts & materials`,
      notes: line.notes || line.explanation || "",
      quantity: 1,
      unitPrice: parts,
    }, index));
    return rows.length ? rows : [normalizeEstimateLine(line, index)];
  });
}

function coherentOrderEstimate(order) {
  const source = order.estimate || {};
  const estimate = calculateEstimate(expandedEstimateLines(source), source.taxRate ?? state.taxSettings.rate, source.fees || []);
  estimate.summary = source.summary || `Estimate for ${order.vehicle}`;
  estimate.generatedAt = source.generatedAt || now();
  return estimate;
}

function inventoryPartOptions(selected = "") {
  return `<option value="">Typed / non-stock part</option>${state.inventory.map(item => `<option value="${escapeAttr(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.sku || "No SKU")} · ${escapeHtml(item.name)} · ${money(item.price)}</option>`).join("")}`;
}

function estimateEditorLine(line = {}, index = 0, removable = true) {
  const item = normalizeEstimateLine(line, index), description = estimateEditorDescription(line, item.description), part = item.type === "part", fee = item.type === "fee";
  return `<article class="job-estimate-line" data-line-id="${escapeAttr(item.id)}" data-fee-code="${escapeAttr(item.code || "")}">
    <div class="estimate-line-head"><strong>${part ? "Part" : fee ? "Fee" : "Labor"} line</strong>${removable ? `<button class="icon-button remove-job-line" type="button" title="Remove line">${icon("trash-2", 14)}</button>` : ""}</div>
    <div class="form-grid">
      <label>Type<select class="job-line-type" ${item.code ? "disabled" : ""}><option value="labor" ${!part && !fee ? "selected" : ""}>Labor</option><option value="part" ${part ? "selected" : ""}>Part</option><option value="fee" ${fee ? "selected" : ""}>Fee</option></select></label>
      <label class="job-inventory-field" ${part ? "" : "hidden"}>Inventory / catalog<select class="job-line-inventory">${inventoryPartOptions(item.inventoryId)}</select></label>
      <label class="full">Description<input class="job-line-description" required value="${escapeAttr(description.value)}" placeholder="${escapeAttr(description.placeholder)}" ${item.code ? "readonly" : ""}/></label>
      <label class="full">Customer-facing detail<textarea class="job-line-notes">${escapeHtml(item.notes)}</textarea></label>
      <label class="job-part-number-field" ${part ? "" : "hidden"}>Part # / SKU<input class="job-line-part-number" value="${escapeAttr(item.partNumber || item.inventorySku || "")}" placeholder="Optional"/></label>
      <label class="job-line-quantity-field" ${fee ? "hidden" : ""}><span class="job-line-quantity-label">${part ? "Quantity" : "Labor hours"}</span><input class="job-line-quantity" type="number" min="0" step="${part ? "1" : ".25"}" value="${fee ? 1 : part ? item.quantity : item.hours}"/></label>
      <label><span class="job-line-rate-label">${fee ? "Flat fee" : part ? "Unit price" : "Labor rate"}</span><input class="job-line-rate" type="number" min="0" step=".01" value="${fee || part ? item.unitPrice : item.laborRate}" ${fee && item.code ? "readonly" : ""}/></label>
    </div>
    <div class="job-line-total"><span>Line total</span><b>${money(item.total)}</b></div>
  </article>`;
}

function estimateFromEditor(root, options = root?._estimateOptions || {}) {
  const lines = [...root.querySelectorAll(".job-estimate-line")].map((row, index) => {
    const type = row.querySelector(".job-line-type").value;
    const quantity = Math.max(0, Number(row.querySelector(".job-line-quantity").value) || 0);
    const unitPrice = Math.max(0, Number(row.querySelector(".job-line-rate").value) || 0);
    const inventory = type === "part" ? state.inventory.find(item => item.id === row.querySelector(".job-line-inventory").value) : null;
    return normalizeEstimateLine({
      id: row.dataset.lineId || `line-${Date.now()}-${index}`,
      type,
      description: row.querySelector(".job-line-description").value.trim(),
      notes: row.querySelector(".job-line-notes").value.trim(),
      partNumber: type === "part" ? row.querySelector(".job-line-part-number").value.trim() : "",
      quantity,
      unitPrice,
      hours: type === "labor" ? quantity : 0,
      laborRate: type === "labor" ? unitPrice : 0,
      inventoryId: inventory?.id || null,
      inventorySku: inventory?.sku || "",
      committedQuantity: type === "part" && inventory ? quantity : 0,
      code: type === "fee" ? row.dataset.feeCode : "",
      amount: type === "fee" ? unitPrice : 0,
    }, index);
  }).filter(line => line.description && line.quantity > 0);
  const fees = options.fees ?? (lines.length ? [{ description: "Shop supplies", amount: 12 }] : []);
  return calculateEstimate(lines, options.taxRate ?? state.taxSettings.rate, fees);
}

function refreshEstimateEditor(root) {
  root.querySelectorAll(".job-estimate-line").forEach(row => {
    const type = row.querySelector(".job-line-type").value;
    const quantityInput = row.querySelector(".job-line-quantity");
    if (type === "fee") quantityInput.value = "1";
    const quantity = Math.max(0, Number(quantityInput.value) || 0);
    const rate = Math.max(0, Number(row.querySelector(".job-line-rate").value) || 0);
    row.querySelector(".job-inventory-field").hidden = type !== "part";
    row.querySelector(".job-part-number-field").hidden = type !== "part";
    row.querySelector(".job-line-quantity-field").hidden = type === "fee";
    row.querySelector(".job-line-quantity-label").textContent = type === "labor" ? "Labor hours" : "Quantity";
    row.querySelector(".job-line-rate-label").textContent = type === "fee" ? "Flat fee" : type === "part" ? "Unit price" : "Labor rate";
    row.querySelector(".job-line-quantity").step = type === "labor" ? ".25" : "1";
    row.querySelector(".job-line-total b").textContent = money(quantity * rate);
  });
  const estimate = estimateFromEditor(root), summary = root.querySelector(".job-estimate-summary");
  if (summary) summary.innerHTML = `<span>Labor <b>${money(estimate.labor)}</b></span><span>Parts <b>${money(estimate.parts)}</b></span><span>Subtotal <b>${money(estimate.subtotal)}</b></span><span>Tax <b>${money(estimate.tax)}</b></span><strong>Total ${money(estimate.total)}</strong>`;
  const total = document.querySelector("#new-estimate-total");
  if (total && root.id === "new-estimate-lines") total.value = estimate.total.toFixed(2);
}

function bindEstimateEditor(root, options) {
  if (!root) return;
  if (options) root._estimateOptions = options;
  const bindRows = () => {
    root.querySelectorAll("input,textarea,select").forEach(control => control.oninput = () => refreshEstimateEditor(root));
    root.querySelectorAll(".job-line-type").forEach(control => control.onchange = () => {
      const row = control.closest(".job-estimate-line"), labor = control.value === "labor";
      row.querySelector(".lookup-labor-time").hidden = !labor;
      row.querySelector(".labor-source").hidden = !labor;
      refreshEstimateEditor(root);
    });
    root.querySelectorAll(".job-line-inventory").forEach(control => control.onchange = () => {
      const row = control.closest(".job-estimate-line"), item = state.inventory.find(entry => entry.id === control.value);
      if (item) {
        row.querySelector(".job-line-description").value = item.name;
        row.querySelector(".job-line-rate").value = Number(item.price || 0).toFixed(2);
        row.querySelector(".job-line-part-number").value = item.sku || "";
      }
      refreshEstimateEditor(root);
    });
    root.querySelectorAll(".remove-job-line").forEach(button => button.onclick = () => {
      button.closest(".job-estimate-line").remove();
      refreshEstimateEditor(root);
    });
    root.querySelectorAll(".lookup-labor-time").forEach(button => button.onclick = async () => {
      const row = button.closest(".job-estimate-line"), form = root.closest("form");
      const query = row.querySelector(".job-line-description").value.trim();
      button.disabled = true;
      try {
        const result = await apiFetch("/labor-times/search", {
          method: "POST",
          body: JSON.stringify({
            vin: form?.elements.vin?.value || "",
            query,
            model: form?.elements.vehicle?.value?.trim() || "",
          }),
        });
        const labor = (result.results || [])[0];
        if (!labor) throw new Error("No labor operation returned");
        if (labor.hours != null) row.querySelector(".job-line-quantity").value = labor.hours;
        row.dataset.laborSource = labor.source || "Unverified shop estimate";
        row.dataset.laborVerified = labor.verified ? "1" : "0";
        row.querySelector(".labor-source").innerHTML = `<span class="badge ${labor.verified ? "paid" : "estimate"}">${labor.verified ? "Verified" : "Unverified"}</span> ${escapeHtml(row.dataset.laborSource)}`;
        refreshEstimateEditor(root);
        toast(labor.verified ? `Verified ${labor.provider} labor time applied` : "No licensed result; keeping the shop estimate unverified");
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    });
  };
  root._bindEstimateRows = bindRows;
  bindRows();
  refreshEstimateEditor(root);
}

function editorLineSnapshot(row) {
  return {
    id: row.dataset.lineId || "",
    code: row.dataset.feeCode || "",
    type: row.querySelector(".job-line-type")?.value || "labor",
    description: row.querySelector(".job-line-description")?.value || "",
    notes: row.querySelector(".job-line-notes")?.value || "",
    unitPrice: Number(row.querySelector(".job-line-rate")?.value) || 0,
  };
}

function addAfterMidnightFeeToEditor(root, append) {
  const rows = [...root.querySelectorAll(".job-estimate-line")];
  if (rows.some(row => row.dataset.feeCode === "after-midnight")) {
    toast("The after-midnight fee is already on this work order");
    return;
  }
  const legacyRows = rows.filter(row => isLegacyAfterMidnightLine(editorLineSnapshot(row)));
  if (legacyRows.length) {
    const descriptions = legacyRows.map(row => row.querySelector(".job-line-description")?.value.trim()).filter(Boolean).join(", ");
    if (!confirm(`A likely legacy after-midnight charge already exists (${descriptions || "unnamed line"}). Adding another fee could double-charge the customer. Replace the legacy line with the standard $200 flat fee?`)) return;
    legacyRows.forEach(row => row.remove());
  }
  append(afterMidnightFeeLine(`fee-after-midnight-${Date.now()}`));
  if (legacyRows.length) toast("Legacy after-midnight charge replaced with the standard $200 flat fee");
}

newOrderEstimateRow = function (line = { type: "labor", description: "Custom service", notes: "Describe the quoted work.", hours: 1, laborRate: Number(shopProfile().laborRate || 140) }) {
  return expandedEstimateLines({ lines: [line] }).map((item, index) => estimateEditorLine(item, index)).join("");
};

readNewOrderEstimate = function () {
  const root = document.querySelector("#new-estimate-lines");
  return root ? estimateFromEditor(root) : calculateEstimate([], state.taxSettings.rate);
};

bindNewOrderEstimator = function () {
  const form = document.querySelector("#new-form"), root = document.querySelector("#new-estimate-lines");
  if (!form || !root) return;
  form.elements.status.innerHTML = '<option value="estimate">Estimate · approval required before work</option>';
  form.elements.status.value = "estimate";
  const toolbar = root.previousElementSibling;
  if (toolbar && !document.querySelector("#add-part-line")) {
    toolbar.querySelector("#add-estimate-line")?.insertAdjacentHTML("beforebegin", `<button class="secondary" id="add-after-midnight-fee" type="button">${icon("moon-star", 14)} Add after-midnight fee</button><button class="secondary" id="add-part-line" type="button">${icon("package-plus", 14)} Add part</button>`);
  }
  const append = line => {
    root.insertAdjacentHTML("beforeend", estimateEditorLine(line, root.children.length));
    bindEstimateEditor(root);
  };
  document.querySelector("#generate-new-estimate").onclick = () => {
    const vehicle = form.elements.vehicle.value.trim(), complaint = form.elements.complaint.value.trim(), requested = form.elements.requestedServices.value.trim();
    if (!vehicle || !complaint) return toast("Enter the vehicle and customer complaint before generating an estimate");
    const services = (requested || complaint).split(/\n|,|;/).map(value => value.trim()).filter(Boolean);
    const generated = services.flatMap((service, index) => {
      const source = estimateLocal(vehicle, service).lines[0];
      const labor = normalizeEstimateLine({ id: `labor-${Date.now()}-${index}`, type: "labor", description: source.service, notes: newOrderServiceExplanation(service, source.notes), hours: source.hours, laborRate: source.hours ? source.labor / source.hours : Number(shopProfile().laborRate || 140) }, index);
      const parts = source.parts ? [normalizeEstimateLine({ id: `part-${Date.now()}-${index}`, type: "part", description: `${source.service} parts & materials`, quantity: 1, unitPrice: source.parts }, index)] : [];
      return [labor, ...parts];
    });
    root.innerHTML = generated.map((line, index) => estimateEditorLine(line, index)).join("");
    bindEstimateEditor(root);
    toast(`${services.length} service estimate${services.length === 1 ? "" : "s"} generated`);
  };
  document.querySelector("#add-estimate-line").onclick = () => append(customLaborDraft(`labor-${Date.now()}`, shopProfile().laborRate || 140));
  document.querySelector("#add-part-line").onclick = () => append({ id: `part-${Date.now()}`, type: "part", description: "Typed part", quantity: 1, unitPrice: 0 });
  document.querySelector("#add-after-midnight-fee").onclick = () => addAfterMidnightFeeToEditor(root, append);
  bindEstimateEditor(root);
};

async function ensureCustomerDocumentLink(documentType, documentId) {
  return apiFetch("/document-links", {
    method: "POST",
    body: JSON.stringify({ documentType, documentId }),
  });
}

async function sendJobEstimate(order, channel) {
  const customer = state.customers.find(item => item.name === order.customer);
  const to = channel === "email" ? customer?.email : customer?.phone || order.phone;
  if (!to || to === "Not provided") return toast(`Add a customer ${channel === "email" ? "email address" : "phone number"} first`);
  try {
    const link = await ensureCustomerDocumentLink("estimate", order.id);
    const subject = `Estimate ${order.id} — ${state.messagingSettings.shopName || "MechPro"}`;
    const body = `${state.messagingSettings.shopName || "MechPro"} estimate for ${order.vehicle}: ${money(order.total)}. Review each recommended line and sign to approve: ${link.url}`;
    const delivery = await deliverShopMessage({ channel, to, subject, body, metadata: { type: "estimate", workOrderId: order.id, approvalUrl: link.url } });
    order.lastEstimateLink = { url: link.url, expiresAt: link.expiresAt, sentAt: now(), channel, deliveryMode: delivery.mode };
    await updateOrderInApi(order);
    save();
    toast(`${order.id} approval link prepared by ${channel === "email" ? "email" : "text"}`);
  } catch (error) {
    toast(error.message || "Could not create the customer approval link");
  }
}

function approvalSignatureSrc(approval) {
  if (String(approval?.signatureDataUrl || "").startsWith("data:image/")) return approval.signatureDataUrl;
  const key = String(approval?.signatureKey || "");
  return key ? `${cloudflareConfig.apiUrl}/files/object?key=${encodeURIComponent(key)}` : "";
}

function estimateApprovalMarkup(approval) {
  const normalized = normalizeEstimateApproval(approval);
  if (!normalized || normalized.status !== "approved") return "";
  const summary = approvalSummary(normalized);
  const signatureSrc = normalized.type === "signature" ? approvalSignatureSrc(normalized) : "";
  return `<section class="estimate-approval-record"><div><span>Estimate authorization</span><strong>${escapeHtml(summary)}</strong></div>${signatureSrc ? `<img src="${escapeAttr(signatureSrc)}" alt="Customer signature"/>` : ""}</section>`;
}

function onsiteSignatureModal(kind, record) {
  const estimate = kind === "estimate" ? coherentOrderEstimate(record) : record;
  const number = kind === "estimate" ? record.id : record.number;
  const lineChoices = kind === "estimate" ? `<fieldset class="onsite-line-choices"><legend>Approve or decline each line</legend>${estimate.lines.map(line => `<label><input type="checkbox" name="approvedLine" value="${escapeAttr(line.id)}" checked><span><b>${escapeHtml(line.description)}</b><small>${line.type === "part" ? `${line.quantity} × ${money(line.unitPrice)}` : line.type === "fee" ? `Flat fee · ${money(line.total)}` : `${line.hours.toFixed(2)} hr × ${money(line.laborRate)}`}</small></span><strong>${money(line.total)}</strong></label>`).join("")}</fieldset>` : "";
  const typeOptions = ESTIMATE_APPROVAL_TYPES.map(option => `<option value="${option.value}">${escapeHtml(option.label)}</option>`).join("");
  const approvalFields = kind === "estimate" ? `<div class="form-grid approval-method-fields"><label>Approval type *<select name="approvalType" id="approval-type">${typeOptions}</select></label><label id="custom-approval-label" hidden>Custom approval type *<input name="customLabel" maxlength="${APPROVAL_CUSTOM_LABEL_MAX}" placeholder="e.g. Approved via fleet manager email"/></label><label class="full">Approval note (optional)<textarea name="approvalNote" maxlength="${APPROVAL_NOTE_MAX}" placeholder="Who approved, callback number, or other audit detail"></textarea></label></div>` : "";
  showModal(`<form class="modal wide" id="document-signature-form"><div class="modal-head"><h2>${kind === "estimate" ? "Authorize estimate" : "Sign invoice"} on this device</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${escapeHtml(number)} · ${escapeHtml(record.vehicle || "")}</span><strong>${money(estimate.total ?? estimate.amount)}</strong></div>${lineChoices}${approvalFields}<label>Approver name *<input name="authorizationName" maxlength="100" required value="${escapeAttr(record.customer || "")}"/></label><label class="signature-label" id="signature-capture">Draw signature *<canvas id="signature-pad" width="720" height="220"></canvas></label><p class="ai-disclaimer" id="approval-disclaimer">${kind === "estimate" ? "A signature authorizes the selected work. For phone, in-person, email, text, or other approval, MechPro records the current staff user and time instead." : "Signing acknowledges this invoice and the completed work listed on it."}</p></div><div class="modal-actions"><button type="button" class="secondary" id="clear-signature">Clear</button><button type="submit" class="primary" id="save-document-approval">${icon("signature", 14)} ${kind === "estimate" ? "Sign & approve" : "Sign invoice"}</button></div></form>`);
  const canvas = document.querySelector("#signature-pad"), context = canvas.getContext("2d");
  let drawing = false, drawn = false;
  const position = event => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height } };
  context.lineWidth = 3; context.lineCap = "round"; context.strokeStyle = "#14201c";
  canvas.onpointerdown = event => { drawing = true; drawn = true; canvas.setPointerCapture(event.pointerId); const point = position(event); context.beginPath(); context.moveTo(point.x, point.y) };
  canvas.onpointermove = event => { if (!drawing) return; const point = position(event); context.lineTo(point.x, point.y); context.stroke() };
  canvas.onpointerup = () => { drawing = false };
  document.querySelector("#clear-signature").onclick = () => { context.clearRect(0, 0, canvas.width, canvas.height); drawn = false };
  const approvalType = document.querySelector("#approval-type");
  const syncApprovalMethod = () => {
    if (!approvalType) return;
    const signature = approvalType.value === "signature";
    const other = approvalType.value === "other";
    const signatureCapture = document.querySelector("#signature-capture");
    const clearSignature = document.querySelector("#clear-signature");
    const customApproval = document.querySelector("#custom-approval-label");
    signatureCapture.hidden = !signature;
    signatureCapture.style.display = signature ? "" : "none";
    clearSignature.hidden = !signature;
    clearSignature.style.display = signature ? "" : "none";
    customApproval.hidden = !other;
    customApproval.style.display = other ? "" : "none";
    document.querySelector('[name="customLabel"]').required = other;
    document.querySelector("#save-document-approval").innerHTML = `${icon(signature ? "signature" : "circle-check", 14)} ${signature ? "Sign & approve" : "Record approval"}`;
    lucide.createIcons();
  };
  approvalType?.addEventListener("change", syncApprovalMethod);
  syncApprovalMethod();
  document.querySelector("#document-signature-form").onsubmit = async event => {
    event.preventDefault();
    const data = new FormData(event.target);
    const selectedType = kind === "estimate" ? String(data.get("approvalType") || "signature") : "signature";
    if (selectedType === "signature" && !drawn) return toast("Draw the customer signature first");
    const approvedIds = new Set([...event.target.querySelectorAll('[name="approvedLine"]:checked')].map(input => input.value));
    if (kind === "estimate" && !approvedIds.size) return toast("Approve at least one line or close without signing");
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const approvedAt = now();
      const hasSignature = selectedType === "signature";
      const signatureDataUrl = hasSignature ? canvas.toDataURL("image/png") : undefined;
      const key = hasSignature && !isLocalShell() ? await uploadFileToR2(await canvasToBlob(canvas), "signature", "image/png") : null;
      const signature = { authorizationName: String(data.get("authorizationName") || "").trim(), signatureKey: key, signatureDataUrl: hasSignature && isLocalShell() ? signatureDataUrl : undefined, signedAt: hasSignature ? approvedAt : undefined, source: "on-site" };
      if (kind === "estimate") {
        const decisions = Object.fromEntries(estimate.lines.map(line => [line.id, approvedIds.has(line.id) ? "approved" : "declined"]));
        const approved = approvedEstimate(estimate, decisions);
        const approval = validateEstimateApproval({
          status: "approved",
          ...signature,
          type: selectedType,
          customLabel: String(data.get("customLabel") || "").trim(),
          approvedAt,
          note: String(data.get("approvalNote") || "").trim(),
          recordedBy: approvalRecorder(currentUser()),
          decisions,
        });
        record.estimate = approved;
        record.total = approved.total;
        record.labor = approved.labor;
        record.laborHours = approved.laborHours;
        record.parts = approved.parts;
        record.tax = approved.tax;
        record.status = record.estimateRevisionPreviousStatus || "approved";
        record.linesLockedAt = approvedAt;
        record.estimateApproval = approval;
        record.estimateRevisionPending = false;
        delete record.estimateRevisionPreviousStatus;
        Object.assign(record, await updateOrderInApi(record));
      } else {
        record.signature = signature;
        await updateInvoiceInApi(record);
      }
      save();
      closeModal();
      toast(kind === "estimate" ? `${record.id} approval recorded` : `${record.number} signed`);
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message || "The signature could not be stored");
    }
  };
}

function jobCardLineTable(estimate) {
  return `<div class="job-card-lines">${estimate.lines.map(line => `<article class="job-card-line ${line.approvalStatus === "declined" ? "declined" : ""}"><span class="line-kind">${line.type === "part" ? "Part" : line.type === "fee" ? "Fee" : "Labor"}</span><div><strong>${escapeHtml(line.description)}</strong><small>${line.type === "part" ? `${line.quantity} × ${money(line.unitPrice)}${line.partNumber || line.inventorySku ? ` · #${escapeHtml(line.partNumber || line.inventorySku)}` : ""}` : line.type === "fee" ? `Flat fee · ${money(line.total)}` : `${line.hours.toFixed(2)} hr × ${money(line.laborRate)}`}</small>${line.notes ? `<p>${escapeHtml(line.notes)}</p>` : ""}</div><b>${money(line.total)}</b>${line.approvalStatus !== "pending" ? `<span class="line-decision ${line.approvalStatus}">${escapeHtml(line.approvalStatus)}</span>` : ""}</article>`).join("")}</div>`;
}

function laborTechnicians() {
  return state.users.filter(user => user.active && user.techName);
}

function technicianName(id) {
  const user = state.users.find(item => item.id === id);
  return user?.techName || user?.name || "Technician unavailable";
}

function technicianCheckboxes(selectedIds, className, prefix) {
  const selected = new Set(selectedIds);
  const technicians = laborTechnicians();
  for (const id of selected) {
    if (!technicians.some(user => user.id === id)) technicians.push({ id, techName: technicianName(id) });
  }
  if (!technicians.length) return `<p class="labor-assignment-empty">No active technician profiles are available.</p>`;
  return technicians.map(user => `<label><input type="checkbox" class="${className}" value="${escapeAttr(user.id)}" id="${escapeAttr(`${prefix}-${user.id}`)}" ${selected.has(user.id) ? "checked" : ""}/><span>${escapeHtml(user.techName)}</span></label>`).join("");
}

function laborAssignmentPanel(order, estimate) {
  const laborLines = estimate.lines.filter(line => line.type === "labor");
  if (!laborLines.length) return "";
  const rows = laborLines.map((line, index) => {
    const ids = normalizeTechnicianIds(line);
    return `<article class="labor-assignment-row" data-assignment-line="${escapeAttr(line.id)}"><div><strong>${escapeHtml(line.description)}</strong><small>${Number(line.hours).toFixed(2)} hr · ${ids.length ? ids.map(technicianName).map(escapeHtml).join(", ") : "Unassigned"}</small></div><fieldset><legend>Assigned technicians</legend>${technicianCheckboxes(ids, "line-technician", `line-${index}`)}</fieldset></article>`;
  }).join("");
  return `<section class="labor-assignment-panel"><div class="job-section-head"><div><h3>Labor-line technicians</h3><p>Assign none, one, or several technicians to each labor operation.</p></div></div><div class="labor-assignment-bulk"><fieldset><legend>Apply these technicians to every labor line</legend>${technicianCheckboxes([], "bulk-technician", "bulk")}</fieldset><button class="secondary" type="button" id="apply-bulk-technicians">${icon("users", 14)} Apply to all labor lines</button></div><div class="labor-assignment-list">${rows}</div><button class="primary" type="button" id="save-labor-assignments">${icon("save", 14)} Save technician assignments</button></section>`;
}

function printJobCard(order) {
  const estimate = coherentOrderEstimate(order), profile = shopProfile(), brand = printableBrand(profile);
  const billableLines = billableEstimateLines(estimate.lines);
  const technicianRows = laborLinePrintRows(billableLines, state.users.map(user => ({ id: user.id, name: user.techName || user.name })));
  const laborRows = technicianRows.map(({ line, technicianName: name }) => `<tr><td><b>${escapeHtml(line.description)}</b><small>${escapeHtml(line.notes || "")}</small></td><td>${escapeHtml(name)}</td><td>${Number(line.hours).toFixed(2)}</td><td>${money(line.laborRate)}</td><td>${money(line.total)}</td></tr>`).join("");
  const partRows = billableLines.filter(line => ["part", "fee"].includes(line.type)).map(line => `<tr><td><b>${line.type === "fee" ? "Fee · " : ""}${escapeHtml(line.description)}</b><small>${escapeHtml(line.notes || "")}</small></td><td>${line.type === "fee" ? "Flat fee" : Number(line.quantity)}</td><td>${line.priceStatus === "pending" ? "Pending" : money(line.unitPrice)}</td><td>${line.priceStatus === "pending" ? "Pending" : money(line.total)}</td></tr>`).join("");
  const supplies = estimate.fees.find(fee => /shop supplies/i.test(fee.description))?.amount || 0;
  const approvalMarkup = estimateApprovalMarkup(order.estimateApproval);
  const win = window.open("", "_blank");
  if (!win) return toast("Allow pop-ups to print the job card");
  win.opener = null;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(order.id)} job card</title><style>${brand.style}body{font:12px/1.45 system-ui,sans-serif;max-width:920px;margin:auto;padding:24px;color:#17231e}h2{margin:20px 0 7px;color:var(--brand);font-size:16px;text-transform:uppercase}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0}.meta div,.concern{padding:10px;border:1px solid #d9dedb}.meta span{display:block;color:#64726b;font-size:9px;text-transform:uppercase}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #d9dedb;text-align:left;vertical-align:top}th{background:#eef3f0;font-size:9px;text-transform:uppercase}td small{display:block;margin-top:3px;color:#59665f}.totals{width:360px;margin:18px 0 0 auto}.totals div{display:flex;justify-content:space-between;padding:4px}.totals .total{margin-top:5px;border-top:2px solid #17231e;font-size:16px;font-weight:800}.notes{margin-top:18px;padding:10px;border:1px solid #e1d3a9;background:#fff8e7}.estimate-approval-record{display:flex;justify-content:space-between;gap:20px;margin-top:20px;padding:14px;border:1px solid #b9d0c2;background:#edf5ef}.estimate-approval-record span,.estimate-approval-record strong{display:block}.estimate-approval-record span{font-size:9px;text-transform:uppercase}.estimate-approval-record img{max-width:260px;max-height:90px;object-fit:contain}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:50px}.signatures div{border-top:1px solid #17231e;padding-top:5px;font-size:9px}@media print{body{padding:0}}</style></head><body>${brand.header}<h1>Work order ${escapeHtml(order.id)}</h1><div class="meta"><div><span>Customer</span><b>${escapeHtml(order.customer)}</b><br>${escapeHtml(order.phone || "")}</div><div><span>Vehicle</span><b>${escapeHtml(order.vehicle)}</b><br>VIN ${escapeHtml(order.vin || "Not provided")}</div></div><div class="concern"><b>Customer complaint</b><p>${escapeHtml(order.complaint || "")}</p></div><h2>Labor assignments</h2><table><thead><tr><th>Labor line</th><th>Technician</th><th>Hours</th><th>Rate</th><th>Line total</th></tr></thead><tbody>${laborRows || `<tr><td colspan="5">No labor lines.</td></tr>`}</tbody></table><h2>Parts</h2><table><thead><tr><th>Part</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>${partRows || `<tr><td colspan="4">No parts.</td></tr>`}</tbody></table><div class="totals"><div><span>Parts</span><b>${money(estimate.parts)}</b></div><div><span>Labor</span><b>${money(estimate.labor)}</b></div><div><span>Shop supplies</span><b>${money(supplies)}</b></div><div><span>Discount</span><b>-${money(estimate.discountAmount || 0)}</b></div><div><span>Tax</span><b>${money(estimate.tax)}</b></div><div class="total"><span>Total</span><b>${money(estimate.total)}</b></div></div>${estimate.exclusions?.length ? `<div class="notes"><b>Not included / pending</b><ul>${estimate.exclusions.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}${approvalMarkup}<div class="signatures"><div>Service writer / date</div><div>Technician / date</div></div><script>window.addEventListener('load',()=>window.print())</script></body></html>`);
  win.document.close();
}

function jobWorkflowSteps(order, invoice) {
  const approval = !order.estimateRevisionPending && (order.estimateApproval?.status === "approved" || ["approved", "in_progress", "waiting_parts", "completed", "invoiced"].includes(order.status));
  return `<ol class="job-progress"><li class="done"><span>1</span><b>Estimate</b><small>Parts + labor</small></li><li class="${approval ? "done" : "current"}"><span>2</span><b>Approval</b><small>${approval ? "Explicitly approved" : order.estimateRevisionPending ? "Revision needs approval" : "Approval required"}</small></li><li class="${["in_progress", "waiting_parts", "completed", "invoiced"].includes(order.status) ? "done" : ""}"><span>3</span><b>Work</b><small>${order.status === "waiting_parts" ? "Waiting parts" : "Repair"}</small></li><li class="${invoice ? "done" : ""}"><span>4</span><b>Invoice</b><small>${invoice ? invoice.number : "Generated on completion"}</small></li></ol>`;
}

async function completeJobCard(order) {
  const explicitlyApproved = !order.estimateRevisionPending && (order.estimateApproval?.status === "approved" || ["approved", "in_progress", "waiting_parts"].includes(order.status));
  if (!explicitlyApproved) return toast("Approve the estimate before completing this job");
  if (!await commitLinkedInventory(order)) return;
  order.status = "completed";
  order.linesLockedAt ||= now();
  const saved = await updateOrderInApi(order);
  state.orders[state.orders.indexOf(order)] = saved;
  syncPayroll(saved);
  save();
  closeModal();
  toast(`${saved.id} completed and invoice generated`);
  render();
}

ensureInvoiceForOrder = async function (order) {
  if (!["completed", "invoiced"].includes(order.status)) return null;
  const existing = state.invoices.find(invoice => invoice.ro === order.id);
  if (existing) return existing;
  const invoice = invoiceRecordForOrder({ ...order, estimate: coherentOrderEstimate(order) });
  if (isOfflineDesktop()) {
    state.invoices.push(invoice);
    return invoice;
  }
  const saved = await apiFetch("/entities/invoices", { method: "POST", body: JSON.stringify(invoice) });
  const value = saved?.queued ? invoice : saved;
  state.invoices.push(value);
  return value;
};

openOrder = function (id) {
  const order = state.orders.find(item => item.id === id);
  if (!order) return;
  order.estimate = coherentOrderEstimate(order);
  const estimate = order.estimate, invoice = state.invoices.find(item => item.ro === order.id);
  const canManage = ["owner", "admin", "office", "service_writer"].includes(currentUser().role);
  const canApprove = ["owner", "admin", "service_writer"].includes(currentUser().role);
  const paidInvoice = invoice && invoicePaid(invoice) > 0;
  const terminalOrder = ["completed", "invoiced"].includes(order.status);
  const wasApproved = Boolean(order.linesLockedAt || order.estimateApproval?.status === "approved" || ["approved", "in_progress", "waiting_parts", "completed", "invoiced"].includes(order.status));
  const canEditEstimate = canManage && (!wasApproved || canApprove);
  const defaultLaborRate = estimate.lines.find(line => line.type === "labor")?.laborRate || Number(shopProfile().laborRate || 140);
  const editNotice = paidInvoice
    ? "Invoice already has a payment. Edits still update line items and the invoice total; recorded payments stay on the invoice."
    : invoice
      ? "Saving also updates the invoice and clears its signature so it can be re-authorized."
      : wasApproved
        ? "Saving creates a revision and clears the prior customer approval."
        : "Changes recalculate labor, parts, tax, and total. Closing the dialog autosaves drafts.";
  const detailsEditor = canManage ? `<section class="job-details-editor"><div class="job-section-head"><div><h3>Work order details</h3><p>Customer, vehicle, complaint, and assignment stay editable through estimate, work, and invoice.</p></div><span class="autosave-hint" id="job-autosave-status">Autosave on</span></div><div class="form-grid"><label>Customer *<select id="job-detail-customer" required>${customerOptions(order.customer)}</select></label><label>Phone<input id="job-detail-phone" value="${escapeAttr(order.phone || "")}"/></label><label class="full">Vehicle description *<input id="job-detail-vehicle" required value="${escapeAttr(order.vehicle || "")}"/></label><label class="full">VIN<input id="job-detail-vin" maxlength="17" value="${escapeAttr(order.vin === "VIN pending" ? "" : order.vin || "")}"/></label><label class="full">Customer complaint *<textarea id="job-detail-complaint" rows="3" required>${escapeHtml(order.complaint || "")}</textarea></label><label class="full">Technician / service notes<textarea id="job-detail-notes" rows="3">${escapeHtml(order.notes || "")}</textarea></label><label>Status<select id="job-detail-status">${["estimate", "approved", "in_progress", "waiting_parts", "completed", "invoiced"].map(status => `<option value="${status}" ${order.status === status ? "selected" : ""}>${label(status)}</option>`).join("")}</select></label><label>Priority<select id="job-detail-priority">${["normal", "high", "low"].map(priority => `<option value="${priority}" ${(order.priority || "normal") === priority ? "selected" : ""}>${label(priority)}</option>`).join("")}</select></label><label>Technician<select id="job-detail-tech">${techOptions(order.tech || "Unassigned")}</select></label><label>Bay / assignment<select id="job-detail-bay">${["Unassigned", "Bay 1", "Bay 2", "Bay 3", "Bay 4", "Mobile"].map(bay => `<option ${(order.bay || "Unassigned") === bay ? "selected" : ""}>${bay}</option>`).join("")}</select></label><label>Promise time<input id="job-detail-promise" value="${escapeAttr(order.promise || "")}"/></label><label>Labor hours<input id="job-detail-labor-hours" type="number" min="0" step=".25" value="${Number(order.laborHours || 0)}"/></label></div></section>` : "";
  const editor = canEditEstimate && !paidInvoice ? `<section class="job-editor"><div class="job-section-head"><div><h3>Edit line items</h3><p>${terminalOrder ? "After-midnight fee changes are locked after completion or invoicing. Reopen the work order before adding or replacing that fee." : editNotice}</p></div><div><button class="secondary" id="job-add-after-midnight-fee" type="button" ${terminalOrder ? `disabled title="Reopen this work order before adding the after-midnight fee"` : ""}>${icon("moon-star", 14)} Add after-midnight fee</button><button class="secondary" id="job-add-labor" type="button">${icon("wrench", 14)} Add labor</button><button class="secondary" id="job-add-part" type="button">${icon("package-plus", 14)} Add part</button></div></div><div id="job-estimate-editor" data-shop-supplies="${Number(estimate.fees?.find(fee => /shop supplies/i.test(fee.description))?.amount ?? "")}" data-discount-percent="${Number(estimate.discountPercent || 0)}" data-discount-reason="${escapeAttr(estimate.discountReason || "")}" data-exclusions="${escapeAttr(JSON.stringify(estimate.exclusions || []))}" data-insurance="${escapeAttr(JSON.stringify(estimate.insurance || {}))}">${estimate.lines.map((line, index) => estimateEditorLine(line, index)).join("")}</div><div class="job-estimate-summary"></div><button class="primary" id="save-job-lines" type="button">${icon("save", 14)} Save line items</button></section>` : "";
  const approvalActions = (order.status === "estimate" || order.estimateRevisionPending) && canManage && !["completed", "invoiced"].includes(order.status) ? `<div class="job-actions"><button class="secondary" data-send-job-estimate="email">${icon("mail", 14)} Email link</button><button class="secondary" data-send-job-estimate="sms">${icon("message-square", 14)} Text link</button>${canApprove ? `<button class="primary" id="sign-job-estimate">${icon("circle-check", 14)} Record approval</button>` : ""}</div>` : "";
  const workActions = canManage && order.status === "approved" ? `<div class="job-actions"><button class="primary" id="start-job-work">${icon("play", 14)} Start work</button></div>` : canManage && ["in_progress", "waiting_parts"].includes(order.status) ? `<div class="job-actions"><button class="primary" id="complete-job-card">${icon("circle-check", 14)} Complete job & generate invoice</button></div>` : "";
  const invoiceCard = invoice ? `<section class="job-invoice-card"><div><span>Invoice</span><h3>${escapeHtml(invoice.number)}</h3><p>${badge(invoice.status)} · ${money(invoice.amount)}</p></div><div><button class="secondary" data-print-invoice="${escapeAttr(invoice.number)}">${icon("printer", 14)} Print</button><button class="primary" id="sign-job-invoice">${icon("signature", 14)} ${invoice.signature ? "Signed" : "Sign invoice"}</button></div></section>` : "";
  const assignments = canManage ? laborAssignmentPanel(order, estimate) : "";
  showModal(`<div class="modal wide job-card-modal"><div class="modal-head"><div><span class="mono">${escapeHtml(order.id)}</span><h2>Job card</h2></div><button class="close" data-close>${icon("x")}</button></div><div class="modal-body">${jobWorkflowSteps(order, invoice)}${detailsEditor}${estimatePresentation(order, estimate, { locked: false })}${assignments}${editor}${approvalActions}${workActions}${invoiceCard}</div><div class="modal-actions"><button class="secondary" type="button" id="print-job-card">${icon("printer", 14)} Print job card</button><button class="secondary" data-close>Close</button></div></div>`);
  const editorRoot = document.querySelector("#job-estimate-editor");
  let jobCardDirty = false;
  let jobCardSaving = false;
  let jobCardTimer = 0;
  const setAutosaveStatus = message => {
    const status = document.querySelector("#job-autosave-status");
    if (status) status.textContent = message;
  };
  const readJobDetails = () => ({
    customer: document.querySelector("#job-detail-customer")?.value?.trim() || order.customer,
    phone: document.querySelector("#job-detail-phone")?.value?.trim() || "",
    vehicle: document.querySelector("#job-detail-vehicle")?.value?.trim() || order.vehicle,
    vin: (document.querySelector("#job-detail-vin")?.value || "").trim().toUpperCase() || "VIN pending",
    complaint: document.querySelector("#job-detail-complaint")?.value?.trim() || order.complaint,
    notes: document.querySelector("#job-detail-notes")?.value?.trim() || "",
    status: document.querySelector("#job-detail-status")?.value || order.status,
    priority: document.querySelector("#job-detail-priority")?.value || order.priority || "normal",
    tech: document.querySelector("#job-detail-tech")?.value || order.tech,
    bay: document.querySelector("#job-detail-bay")?.value || order.bay,
    mobile: (document.querySelector("#job-detail-bay")?.value || order.bay) === "Mobile",
    promise: document.querySelector("#job-detail-promise")?.value?.trim() || order.promise,
    laborHours: Math.max(0, Number(document.querySelector("#job-detail-labor-hours")?.value) || 0),
  });
  const readLaborAssignments = () => {
    const rows = [...document.querySelectorAll(".labor-assignment-row")];
    if (!rows.length) return null;
    return new Map(rows.map(row => [
      row.dataset.assignmentLine,
      [...row.querySelectorAll(".line-technician:checked")].map(input => input.value),
    ]));
  };
  const buildRevisedOrder = () => {
    const details = canManage ? readJobDetails() : {};
    let nextEstimate = order.estimate;
    if (editorRoot && document.contains(editorRoot)) {
      const fromEditor = estimateFromEditor(editorRoot);
      if (fromEditor.lines.length) {
        nextEstimate = {
          ...fromEditor,
          generatedAt: order.estimate?.generatedAt,
          summary: order.estimate?.summary || `Estimate for ${details.vehicle || order.vehicle}`,
        };
      }
    }
    const editedAt = now();
    let revised = workOrderWithEditedEstimate(order, nextEstimate, editedAt);
    Object.assign(revised, details, { updatedAt: order.updatedAt });
    const assignmentsByLine = readLaborAssignments();
    if (assignmentsByLine && revised.estimate?.lines) {
      revised.estimate.lines = revised.estimate.lines.map(line => line.type === "labor"
        ? { ...line, technicianIds: assignmentsByLine.get(line.id) || [] }
        : line);
    }
    return { revised, editedAt };
  };
  const persistJobCard = async ({ silent = false, reopen = false } = {}) => {
    if (!canManage || jobCardSaving) return false;
    if (!jobCardDirty && silent) return true;
    const { revised, editedAt } = buildRevisedOrder();
    if (!revised.customer || !revised.vehicle || !revised.complaint) {
      if (!silent) toast("Customer, vehicle, and complaint are required");
      return false;
    }
    if (editorRoot && document.contains(editorRoot) && !estimateFromEditor(editorRoot).lines.length) {
      if (!silent) toast("Add at least one labor or part line");
      return false;
    }
    if (invoice && !isOfflineDesktop() && !navigator.onLine) {
      Object.assign(order, revised);
      save();
      jobCardDirty = false;
      setAutosaveStatus("Saved locally · offline");
      if (!silent) toast("Saved locally. Reconnect to sync the invoice.");
      return true;
    }
    jobCardSaving = true;
    setAutosaveStatus("Saving…");
    const revisedInvoice = invoice ? {
      ...invoiceWithEditedWorkOrder(invoice, revised, editedAt),
      // Keep authorization on paid invoices; unpaid edits still clear for re-sign.
      signature: paidInvoice ? invoice.signature : null,
    } : null;
    try {
      const savedOrder = await updateOrderInApi(revised, { throwOnError: true });
      Object.assign(order, savedOrder?.queued ? revised : savedOrder);
      if (revisedInvoice) {
        const savedInvoice = await updateInvoiceInApi(revisedInvoice, { throwOnError: true });
        Object.assign(invoice, savedInvoice?.queued ? revisedInvoice : savedInvoice);
      }
      save();
      jobCardDirty = false;
      setAutosaveStatus("Saved");
      if (!silent) {
        setModalAutosave(null);
        closeModal();
        toast(`${order.id} updated${revisedInvoice ? ` · ${invoice.number} synchronized` : ""}`);
        if (reopen) openOrder(order.id);
        else render();
      }
      return true;
    } catch (error) {
      Object.assign(order, revised);
      save();
      jobCardDirty = false;
      setAutosaveStatus("Saved locally");
      if (!silent) toast(error.message || "Cloud sync failed — changes kept locally");
      return false;
    } finally {
      jobCardSaving = false;
    }
  };
  const markJobCardDirty = () => {
    jobCardDirty = true;
    setAutosaveStatus("Unsaved changes");
    clearTimeout(jobCardTimer);
    jobCardTimer = setTimeout(() => { void persistJobCard({ silent: true }) }, 700);
  };
  if (canManage) {
    document.querySelector(".job-details-editor")?.addEventListener("input", markJobCardDirty);
    document.querySelector(".job-details-editor")?.addEventListener("change", markJobCardDirty);
    document.querySelector(".labor-assignment-panel")?.addEventListener("change", markJobCardDirty);
    setModalAutosave(({ reason }) => {
      clearTimeout(jobCardTimer);
      if (!jobCardDirty) return;
      void persistJobCard({ silent: true });
      if (reason === "close") toast(`${order.id} autosaved`);
    });
  }
  if (editorRoot) {
    bindEstimateEditor(editorRoot, { taxRate: estimate.taxRate, fees: estimate.fees });
    editorRoot.addEventListener("input", markJobCardDirty);
    editorRoot.addEventListener("change", markJobCardDirty);
    document.querySelector("#job-add-labor").onclick = () => { editorRoot.insertAdjacentHTML("beforeend", estimateEditorLine(customLaborDraft(`labor-${Date.now()}`, defaultLaborRate), editorRoot.children.length)); bindEstimateEditor(editorRoot); markJobCardDirty() };
    document.querySelector("#job-add-part").onclick = () => { editorRoot.insertAdjacentHTML("beforeend", estimateEditorLine({ id: `part-${Date.now()}`, type: "part", description: "Typed part", quantity: 1, unitPrice: 0 }, editorRoot.children.length)); bindEstimateEditor(editorRoot); markJobCardDirty() };
    document.querySelector("#job-add-after-midnight-fee").onclick = () => addAfterMidnightFeeToEditor(editorRoot, line => {
      editorRoot.insertAdjacentHTML("beforeend", estimateEditorLine(line, editorRoot.children.length));
      bindEstimateEditor(editorRoot);
      markJobCardDirty();
    });
    document.querySelector("#save-job-lines").onclick = async event => {
      const next = estimateFromEditor(editorRoot);
      if (!next.lines.length) return toast("Add at least one labor, part, or fee line");
      if (terminalOrderChangesAfterMidnightFee(order.status, estimate.lines, next.lines)) {
        return toast("Reopen this work order before adding, replacing, or removing the after-midnight fee");
      }
      if (invoice && !isOfflineDesktop() && !navigator.onLine) return toast("Reconnect before changing an invoiced work order");
      event.currentTarget.disabled = true;
      jobCardDirty = true;
      const ok = await persistJobCard({ silent: false, reopen: true });
      if (!ok) event.currentTarget.disabled = false;
    };
  }
  document.querySelectorAll("[data-send-job-estimate]").forEach(button => button.onclick = () => sendJobEstimate(order, button.dataset.sendJobEstimate));
  document.querySelector("#sign-job-estimate")?.addEventListener("click", () => onsiteSignatureModal("estimate", order));
  document.querySelector("#start-job-work")?.addEventListener("click", async () => {
    jobCardDirty = true;
    const details = readJobDetails();
    order.status = "in_progress";
    Object.assign(order, details, { status: "in_progress" });
    await updateOrderInApi(order);
    save();
    setModalAutosave(null);
    closeModal();
    toast(`${order.id} moved to in progress`);
    render();
  });
  document.querySelector("#complete-job-card")?.addEventListener("click", async () => {
    if (jobCardDirty) await persistJobCard({ silent: true });
    completeJobCard(order);
  });
  document.querySelector("#sign-job-invoice")?.addEventListener("click", () => { if (!invoice.signature) onsiteSignatureModal("invoice", invoice) });
  document.querySelectorAll("[data-print-invoice]").forEach(button => button.onclick = () => printInvoice(button.dataset.printInvoice));
  document.querySelector("#print-job-card")?.addEventListener("click", () => printJobCard(order));
  document.querySelector("#apply-bulk-technicians")?.addEventListener("click", () => {
    const selected = new Set([...document.querySelectorAll(".bulk-technician:checked")].map(input => input.value));
    document.querySelectorAll(".labor-assignment-row").forEach(row => {
      row.querySelectorAll(".line-technician").forEach(input => { input.checked = selected.has(input.value) });
    });
    markJobCardDirty();
    toast(`Applied ${selected.size || "no"} technician${selected.size === 1 ? "" : "s"} to every labor line.`);
  });
  document.querySelector("#save-labor-assignments")?.addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    jobCardDirty = true;
    const ok = await persistJobCard({ silent: false, reopen: true });
    if (!ok) event.currentTarget.disabled = false;
  });
};

invoices = function () {
  const q = query.toLowerCase(), rows = state.invoices.filter(invoice => !q || Object.values(invoice).join(" ").toLowerCase().includes(q)).map(invoice => {
    const paid = invoicePaid(invoice), balance = invoiceBalance(invoice), bd = invoiceTaxBreakdown(invoice);
    return `<tr><td class="mono"><b>${escapeHtml(invoice.number)}</b><small>${invoice.signature ? `Signed by ${escapeHtml(invoice.signature.authorizationName)}` : "Signature pending"}</small></td><td class="mono">${escapeHtml(invoice.ro || "")}</td><td><b>${escapeHtml(invoice.customer)}</b></td><td>${escapeHtml(invoice.date || "")}</td><td>${balance === 0 ? `<span class="badge paid">Paid</span>` : badge(invoice.status)}</td><td><b>${money(invoice.amount)}</b><small>Subtotal ${money(bd.subtotal)} · Tax ${money(bd.tax)}</small><small>Balance ${money(balance)}</small></td><td><div class="invoice-payments"><button class="mini-action" data-print-invoice="${escapeAttr(invoice.number)}">${icon("printer", 13)} Print</button><button class="mini-action" data-sign-invoice="${escapeAttr(invoice.number)}" ${invoice.signature ? "disabled" : ""}>${icon("signature", 13)} ${invoice.signature ? "Signed" : "Sign"}</button>${balance > 0 ? `<button class="mini-action" data-record-payment="${escapeAttr(invoice.number)}" data-method="cash">${icon("banknote", 13)} Cash</button><button class="mini-action invoice-pay" data-pay-invoice="${escapeAttr(invoice.number)}">${icon("external-link", 13)} Pay online</button>` : ""}</div></td></tr>`;
  }).join("");
  return shell(`${heading("Accounts receivable", "Invoices", "Review the completed job, capture a mobile signature, and collect payment.", false)}${stats()}<div class="data-panel"><table><thead><tr><th>Invoice</th><th>Work order</th><th>Customer</th><th>Issued</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`);
};

const bindJobCardInvoiceCore = bindEstimateActions;
bindEstimateActions = function () {
  bindJobCardInvoiceCore();
  document.querySelectorAll("[data-sign-invoice]").forEach(button => button.onclick = () => {
    const invoice = state.invoices.find(item => item.number === button.dataset.signInvoice);
    if (invoice && !invoice.signature) onsiteSignatureModal("invoice", invoice);
  });
};

const loadShopEntitiesWithTaxSettingsCore = loadShopEntities;
loadShopEntities = async function () {
  const previousSettings = state.shopSettingsRecords;
  await loadShopEntitiesWithTaxSettingsCore();
  if (state.shopSettingsRecords === previousSettings) return;
  const taxSettings = state.shopSettingsRecords.find(item => item.id === "tax");
  state.taxSettings = taxSettings
    ? { ...state.taxSettings, ...taxSettings }
    : { ...state.taxSettings, state: "TX", taxId: "", rate: 8.25, filingFrequency: "Monthly" };
};

function readHelpSnapshot() {
  const user = currentUser();
  if (!user) {
    return {
      route: pendingAuthProfile ? "pending-profile" : "login",
      role: "",
      subview: "",
      selectionLabel: "",
    };
  }
  const route = String(state.route || "");
  let subview = "";
  if (route === "pos") subview = posMode || "reader";
  else if (route === "accounting") subview = accountingTab || "";
  else if (route === "shopops") subview = shopOpsTab || "";
  else if (route === "ai") subview = aiTab || "";
  let selectionLabel = "";
  if (route === "pos" && posSelectedId) {
    const order = state.orders.find((item) => item.id === posSelectedId);
    if (order) selectionLabel = `${order.id} · ${order.customer || "No customer"} · ${order.vehicle || "No vehicle"}`;
  }
  return { route, role: user.role || "", subview, selectionLabel };
}

const bindDurableRecordsCore = bind;
bind = function () {
  bindDurableRecordsCore();
  document.querySelector("#tax-settings-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const data = Object.fromEntries(new FormData(event.target));
    const existing = state.shopSettingsRecords.find(item => item.id === "tax");
    const record = {
      ...state.taxSettings,
      state: data.state,
      taxId: data.taxId.trim(),
      rate: Number(data.rate) || 0,
      filingFrequency: data.filingFrequency,
      id: "tax",
      updatedAt: existing?.updatedAt ? now() : undefined,
    };
    try {
      const saved = await saveShopEntity("shopsettings", record);
      state.taxSettings = { ...state.taxSettings, ...saved };
      toast("Tax settings saved");
      render();
    } catch (error) {
      toast(error.message || "Tax settings could not be saved");
    }
  }, { capture: true });
  document.querySelector("#new-customer")?.addEventListener("click", () => openCustomerForm());
  document.querySelectorAll("[data-edit-order]").forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      openOrder(button.dataset.editOrder);
    };
  });
  document.querySelectorAll("[data-edit-employee]").forEach(button => {
    button.onclick = () => openEmployee(state.users.find(user => user.id === button.dataset.editEmployee));
  });
  document.querySelectorAll("[data-toggle-user]").forEach(button => {
    button.onclick = async () => {
      const user = state.users.find(item => item.id === button.dataset.toggleUser);
      if (!user) return;
      button.disabled = true;
      try {
        const saved = await setEmployeeActive(user);
        toast(`${saved.name} account ${saved.active ? "activated" : "deactivated"}`);
        render();
      } catch (error) {
        button.disabled = false;
        toast(error.message || "Employee access could not be changed");
      }
    };
  });
  document.querySelector('[data-route="employees"]')?.addEventListener("click", async () => {
    await loadEmployeesFromApi();
    if (state.route === "employees") render();
  });
  syncHelp(readHelpSnapshot(), {
    icon,
    onNavigate: (route) => {
      if (!canAccess(route)) return;
      state.route = route;
      save();
      render();
    },
  });
};

function estimateParty(estimate, fallback = {}) {
  const customer = typeof estimate.customer === "object"
    ? estimate.customer
    : { ...(estimate.customerDetails || {}), name: estimate.customer || estimate.customerDetails?.name || fallback.customer, phone: estimate.phone || estimate.customerDetails?.phone || fallback.phone, email: estimate.email || estimate.customerDetails?.email, address: estimate.address || estimate.customerDetails?.address };
  const vehicle = typeof estimate.vehicle === "object"
    ? estimate.vehicle
    : { ...(estimate.vehicleDetails || {}), description: estimate.vehicle || estimate.vehicleDetails?.description || fallback.vehicle, vin: estimate.vin || estimate.vehicleDetails?.vin || fallback.vin, plate: estimate.plate || estimate.vehicleDetails?.plate || fallback.plate };
  return { customer, vehicle };
}

function estimateLinePresentation(line) {
  const pending = line.priceStatus === "pending";
  const meta = line.type === "part"
    ? `${Number(line.quantity || 0)} × ${money(line.unitPrice)}${line.partNumber ? ` · ${escapeHtml(line.partNumber)}` : ""}`
    : line.type === "fee" ? `Flat fee · ${money(line.total)}` : `${Number(line.hours || 0).toFixed(2)} hr × ${money(line.laborRate)}`;
  const assigned = line.type === "labor"
    ? normalizeTechnicianIds(line).map(technicianName)
    : [];
  return `<article class="reference-estimate-line ${pending ? "pending" : ""}"><div><strong>${escapeHtml(line.description)}</strong><small>${meta}</small>${line.type === "labor" ? `<small><span class="badge ${line.laborVerified ? "paid" : "estimate"}">${line.laborVerified ? "Verified" : "Unverified"}</span> ${escapeHtml(line.laborSource || "Shop estimate")}</small><small class="line-technicians">Technicians: ${assigned.length ? assigned.map(escapeHtml).join(", ") : "Unassigned"}</small>` : ""}${line.notes ? `<p>${escapeHtml(line.notes)}</p>` : ""}</div><b>${pending ? "Pending" : money(line.total)}</b></article>`;
}

function estimatePresentation(record, estimate, { locked = false, standalone = false } = {}) {
  const { customer, vehicle } = estimateParty(estimate, record);
  const parts = (estimate.lines || []).filter(line => line.type === "part");
  const labor = (estimate.lines || []).filter(line => line.type === "labor");
  const feeLines = (estimate.lines || []).filter(line => line.type === "fee");
  const supply = (estimate.fees || []).find(fee => /shop supplies/i.test(fee.description));
  const exclusions = estimate.exclusions || record.exclusions || [];
  const insurance = estimate.insurance || record.insurance || {};
  const complaint = estimate.complaint || record.complaint || "";
  const number = estimate.number || record.estimateNumber || record.id || "";
  return `<section class="reference-estimate-document ${standalone ? "standalone" : ""}">
    <header class="reference-estimate-header"><div><div class="eyebrow">${escapeHtml(shopProfile().shopName)}</div><h2>Service estimate</h2><p>${escapeHtml(shopProfile().address || "")}${shopProfile().address && shopProfile().phone ? " · " : ""}${escapeHtml(shopProfile().phone || "")}</p></div><div><b>${escapeHtml(number)}</b><span>${locked ? "Approved lines locked" : "Draft · review before authorization"}</span></div></header>
    <div class="reference-party-grid">
      <section><span>Customer</span><h3>${escapeHtml(customer.name || "Customer not provided")}</h3><p>${escapeHtml(customer.phone || record.phone || "")}${customer.email ? `<br>${escapeHtml(customer.email)}` : ""}${customer.address ? `<br>${escapeHtml(customer.address)}` : ""}</p></section>
      <section><span>Vehicle</span><h3>${escapeHtml(vehicle.description || "Vehicle not provided")}</h3><p>${vehicle.vin ? `VIN ${escapeHtml(vehicle.vin)}` : "VIN not provided"}${vehicle.plate ? `<br>Plate ${escapeHtml(vehicle.plate)}` : ""}${insurance.policy ? `<br>${escapeHtml(insurance.company || "Insurance")} · Policy ${escapeHtml(insurance.policy)}` : ""}</p></section>
    </div>
    <section class="reference-complaint"><span>Customer complaint / loss</span><p>${escapeHtml(complaint)}</p></section>
    <section class="reference-estimate-section"><div class="reference-section-title"><span>01</span><h3>Parts</h3></div>${parts.map(estimateLinePresentation).join("") || `<p>No parts quoted.</p>`}<div class="reference-subtotal"><span>Priced parts</span><b>${money(estimate.parts)}</b></div></section>
    <section class="reference-estimate-section"><div class="reference-section-title"><span>02</span><h3>Labor</h3></div>${labor.map(estimateLinePresentation).join("") || `<p>No labor quoted.</p>`}</section>
    ${feeLines.length ? `<section class="reference-estimate-section"><div class="reference-section-title"><span>03</span><h3>Fees</h3></div>${feeLines.map(estimateLinePresentation).join("")}</section>` : ""}
    <section class="reference-totals">
      <div><span>Labor</span><b>${money(estimate.labor)}</b></div>
      ${feeLines.length ? `<div><span>Fees</span><b>${money(estimate.lineFees || 0)}</b></div>` : ""}
      <div><span>Shop supplies</span><b>${money(supply?.amount || 0)}</b></div>
      <div><span>${escapeHtml(estimate.discountReason || "Discount")}${estimate.discountPercent ? ` · ${estimate.discountPercent}%` : ""}</span><b>${estimate.discountAmount ? `-${money(estimate.discountAmount)}` : money(0)}</b></div>
      <div><span>Tax · ${Number(estimate.taxRate || 0).toFixed(2)}%</span><b>${money(estimate.tax)}</b></div>
      <div class="total"><span>Estimate total</span><b>${money(estimate.total)}</b></div>
    </section>
    <aside class="reference-exclusions"><strong>Not included / still pending</strong><ul>${exclusions.length ? exclusions.map(item => `<li>${escapeHtml(item)}</li>`).join("") : "<li>Additional or hidden work is not included without a revised estimate and authorization.</li>"}</ul></aside>
    ${standalone ? "" : estimateApprovalMarkup(record.estimateApproval)}
  </section>`;
}

function availableEstimateSources() {
  return [
    REFERENCE_ESTIMATE,
    ...state.estimates.map(estimate => ({ ...estimate, id: estimate.id || estimate.number })),
  ];
}

function estimateSourceById(id) {
  return availableEstimateSources().find(estimate => String(estimate.id) === String(id));
}

function normalizedEstimateSource(estimate) {
  if (!estimate) return null;
  const totals = calculateShopEstimate(expandedEstimateLines(estimate), {
    taxRate: estimate.taxRate ?? state.taxSettings.rate,
    discountPercent: estimate.discountPercent,
    discountReason: estimate.discountReason,
    shopSupplies: estimate.fees?.find(fee => /shop supplies/i.test(fee.description))?.amount,
  });
  return { ...estimate, ...totals };
}

function showEstimatePreview(estimate) {
  if (!estimate) return;
  const totals = normalizedEstimateSource(estimate);
  showModal(`<div class="modal wide"><div class="modal-head"><div><span class="mono">${escapeHtml(estimate.number || "Draft estimate")}</span><h2>Estimate preview</h2></div><button class="close" data-close>${icon("x")}</button></div><div class="modal-body">${estimatePresentation(estimate, { ...estimate, ...totals }, { standalone: true })}</div><div class="modal-actions"><button class="secondary" data-close>Close</button><button class="primary" id="preview-fill-work-order">${icon("clipboard-plus", 14)} Fill new work order</button></div></div>`);
  document.querySelector("#preview-fill-work-order").onclick = () => openNewWithDraft(workOrderDraftFromEstimate(totals));
}

estimateEditorLine = function (line = {}, index = 0, removable = true) {
  const item = normalizeEstimateLine(line, index), description = estimateEditorDescription(line, item.description), part = item.type === "part", fee = item.type === "fee", laborSource = item.laborSource || "Unverified shop estimate";
  return `<article class="job-estimate-line" data-line-id="${escapeAttr(item.id)}" data-price-status="${escapeAttr(item.priceStatus || "priced")}" data-labor-source="${escapeAttr(laborSource)}" data-labor-verified="${item.laborVerified ? "1" : "0"}" data-technician-ids="${escapeAttr(JSON.stringify(item.technicianIds || []))}" data-fee-code="${escapeAttr(item.code || "")}">
    <div class="estimate-line-head"><strong>${part ? "Part" : fee ? "Fee" : "Labor"} line</strong><div>${!part && !fee ? `<button class="mini-action lookup-labor-time" type="button">${icon("badge-check", 13)} Labor guide</button>` : ""}${removable ? `<button class="icon-button remove-job-line" type="button" title="Remove line">${icon("trash-2", 14)}</button>` : ""}</div></div>
    <div class="form-grid">
      <label>Type<select class="job-line-type" ${item.code ? "disabled" : ""}><option value="labor" ${!part && !fee ? "selected" : ""}>Labor</option><option value="part" ${part ? "selected" : ""}>Part</option><option value="fee" ${fee ? "selected" : ""}>Fee</option></select></label>
      <label class="job-inventory-field" ${part ? "" : "hidden"}>Inventory / catalog<select class="job-line-inventory">${inventoryPartOptions(item.inventoryId)}</select></label>
      <label class="full">Description<input class="job-line-description" required value="${escapeAttr(description.value)}" placeholder="${escapeAttr(description.placeholder)}" ${item.code ? "readonly" : ""}/></label>
      <label class="full">Customer-facing detail<textarea class="job-line-notes">${escapeHtml(item.notes)}</textarea></label>
      <label class="job-part-number-field" ${part ? "" : "hidden"}>Part # / SKU<input class="job-line-part-number" value="${escapeAttr(item.partNumber || item.inventorySku || "")}" placeholder="Optional"/></label>
      <label class="job-line-quantity-field" ${fee ? "hidden" : ""}><span class="job-line-quantity-label">${part ? "Quantity" : "Labor hours"}</span><input class="job-line-quantity" type="number" min="0" step="${part ? "1" : ".1"}" value="${fee ? 1 : part ? item.quantity : item.hours}"/></label>
      <label><span class="job-line-rate-label">${fee ? "Flat fee" : part ? "Unit price" : "Labor rate"}</span><input class="job-line-rate" type="number" min="0" step=".01" value="${fee || part ? item.unitPrice : item.laborRate || shopProfile().laborRate}" ${fee && item.code ? "readonly" : ""}/></label>
    </div>
    <small class="labor-source" ${part ? "hidden" : ""}><span class="badge ${item.laborVerified ? "paid" : "estimate"}">${item.laborVerified ? "Verified" : "Unverified"}</span> ${escapeHtml(laborSource)}</small>
    <div class="job-line-total"><span>Line total</span><b>${item.priceStatus === "pending" ? "Pending" : money(item.total)}</b></div>
  </article>`;
};

estimateFromEditor = function (root) {
  const lines = [...root.querySelectorAll(".job-estimate-line")].map((row, index) => {
    const type = row.querySelector(".job-line-type").value;
    const quantity = Math.max(0, Number(row.querySelector(".job-line-quantity").value) || 0);
    const unitPrice = Math.max(0, Number(row.querySelector(".job-line-rate").value) || 0);
    const inventory = type === "part" ? state.inventory.find(item => item.id === row.querySelector(".job-line-inventory").value) : null;
    const partNumber = type === "part" ? (row.querySelector(".job-line-part-number")?.value || "").trim() : "";
    return normalizeEstimateLine({
      id: row.dataset.lineId || `line-${Date.now()}-${index}`,
      type,
      description: row.querySelector(".job-line-description").value.trim(),
      notes: row.querySelector(".job-line-notes").value.trim(),
      partNumber,
      quantity,
      unitPrice,
      hours: type === "labor" ? quantity : 0,
      laborRate: type === "labor" ? unitPrice : 0,
      inventoryId: inventory?.id || null,
      inventorySku: inventory?.sku || partNumber || "",
      committedQuantity: type === "part" && inventory ? quantity : 0,
      priceStatus: type === "part" ? estimatePartPriceStatus(row.dataset.priceStatus, unitPrice) : "priced",
      laborSource: row.dataset.laborSource || "",
      laborVerified: row.dataset.laborVerified === "1",
      technicianIds: JSON.parse(row.dataset.technicianIds || "[]"),
      code: type === "fee" ? row.dataset.feeCode : "",
      amount: type === "fee" ? unitPrice : 0,
    }, index);
  }).filter(line => line.description && line.quantity > 0);
  const form = root.closest("form");
  const suppliesValue = form?.querySelector("[name=shopSupplies]")?.value ?? root.dataset.shopSupplies;
  const estimate = calculateShopEstimate(lines, {
    taxRate: state.taxSettings.rate,
    discountPercent: form?.querySelector("[name=estimateDiscount]")?.value ?? root.dataset.discountPercent,
    discountReason: form?.querySelector("[name=estimateDiscountReason]")?.value ?? root.dataset.discountReason,
    shopSupplies: suppliesValue === "" || suppliesValue == null ? undefined : Number(suppliesValue),
  });
  estimate.sourceEstimateNumber = root.dataset.sourceEstimateNumber || "";
  estimate.exclusions = JSON.parse(root.dataset.exclusions || "[]");
  estimate.insurance = JSON.parse(root.dataset.insurance || "{}");
  return estimate;
};

refreshEstimateEditor = function (root) {
  root.querySelectorAll(".job-estimate-line").forEach(row => {
    const type = row.querySelector(".job-line-type").value;
    const quantityInput = row.querySelector(".job-line-quantity");
    if (type === "fee") quantityInput.value = "1";
    const quantity = Math.max(0, Number(quantityInput.value) || 0);
    const rate = Math.max(0, Number(row.querySelector(".job-line-rate").value) || 0);
    const priceStatus = type === "part" ? estimatePartPriceStatus(row.dataset.priceStatus, rate) : "priced";
    row.dataset.priceStatus = priceStatus;
    row.querySelector(".job-inventory-field").hidden = type !== "part";
    const partNumberField = row.querySelector(".job-part-number-field");
    if (partNumberField) partNumberField.hidden = type !== "part";
    row.querySelector(".job-line-quantity-field").hidden = type === "fee";
    row.querySelector(".job-line-quantity-label").textContent = type === "labor" ? "Labor hours" : "Quantity";
    row.querySelector(".job-line-rate-label").textContent = type === "fee" ? "Flat fee" : type === "part" ? "Unit price" : "Labor rate";
    row.querySelector(".job-line-quantity").step = type === "labor" ? ".1" : "1";
    row.querySelector(".job-line-total b").textContent = priceStatus === "pending" ? "Pending" : money(quantity * rate);
  });
  const estimate = estimateFromEditor(root), summary = root.parentElement.querySelector(".job-estimate-summary") || document.querySelector("#new-estimate-summary");
  const supplies = estimate.fees.find(fee => /shop supplies/i.test(fee.description))?.amount || 0;
  if (summary) summary.innerHTML = `<span>Parts <b>${money(estimate.parts)}</b></span><span>Labor <b>${money(estimate.labor)}</b></span><span>Fees <b>${money(estimate.lineFees)}</b></span><span>Supplies <b>${money(supplies)}</b></span><span>Discount <b>-${money(estimate.discountAmount)}</b></span><span>Tax <b>${money(estimate.tax)}</b></span><strong>Total ${money(estimate.total)}</strong>`;
  const total = document.querySelector("#new-estimate-total");
  if (total && root.id === "new-estimate-lines") total.value = estimate.total.toFixed(2);
};

coherentOrderEstimate = function (order) {
  const source = order.estimate || {};
  const estimate = calculateShopEstimate(expandedEstimateLines(source), {
    taxRate: source.taxRate ?? state.taxSettings.rate,
    discountPercent: source.discountPercent,
    discountReason: source.discountReason,
    shopSupplies: source.fees?.find(fee => /shop supplies/i.test(fee.description))?.amount,
  });
  return {
    ...estimate,
    number: source.number || source.sourceEstimateNumber || order.estimateNumber || order.id,
    summary: source.summary || `Estimate for ${order.vehicle}`,
    generatedAt: source.generatedAt || now(),
    complaint: source.complaint || order.complaint,
    exclusions: source.exclusions || order.exclusions || [],
    insurance: source.insurance || order.insurance || {},
  };
};

function addEstimateSourceControls(form) {
  const body = form.querySelector(".modal-body");
  if (!body || document.querySelector("#estimate-source-picker")) return;
  const options = availableEstimateSources().map(estimate => `<option value="${escapeAttr(estimate.id)}">${escapeHtml(estimate.number || "Saved draft")} · ${escapeHtml(typeof estimate.customer === "object" ? estimate.customer.name : estimate.customer || "Customer")}</option>`).join("");
  body.insertAdjacentHTML("afterbegin", `<section class="estimate-fill-panel"><div><div class="eyebrow">Optional estimate fill</div><h3>Start from a completed estimate</h3><p>A blank order stays blank. Choose an estimate and apply it only when it belongs to this customer.</p></div><div><select id="estimate-source-picker"><option value="">Select an estimate…</option>${options}</select><button type="button" class="secondary" id="apply-estimate-source">${icon("clipboard-plus", 14)} Fill fields</button></div></section>`);
  const estimator = form.querySelector(".new-order-estimator");
  estimator?.insertAdjacentHTML("beforeend", `<div class="estimate-adjustments"><label>Shop supplies<input name="shopSupplies" type="number" min="0" step=".01" placeholder="Auto: 3% of labor, max $20"/></label><label>Discount %<input name="estimateDiscount" type="number" min="0" max="100" step=".1" value="0"/></label><label>Discount reason<input name="estimateDiscountReason" placeholder="Optional"/></label></div>`);
  form.querySelectorAll("[name=shopSupplies],[name=estimateDiscount],[name=estimateDiscountReason]").forEach(input => input.addEventListener("input", () => refreshEstimateEditor(form.querySelector("#new-estimate-lines"))));
  document.querySelector("#apply-estimate-source").onclick = () => {
    const estimate = estimateSourceById(document.querySelector("#estimate-source-picker").value);
    if (estimate) applyWorkOrderDraftToForm(form, workOrderDraftFromEstimate(normalizedEstimateSource(estimate)));
  };
}

function applyWorkOrderDraftToForm(form, draft) {
  const customerSelect = form.elements.customerSelect;
  const option = [...customerSelect.options].find(item => item.value.toLowerCase() === draft.customer.toLowerCase());
  customerSelect.value = option?.value || "__new__";
  customerSelect.dispatchEvent(new Event("change"));
  if (!option) form.elements.customer.value = draft.customer;
  form.elements.phone.value = draft.phone || "";
  form.elements.vehicleSelect.value = "";
  form.elements.vehicle.value = draft.vehicle || "";
  form.elements.vehicle.readOnly = false;
  form.elements.vin.value = draft.vin || "";
  form.elements.complaint.value = draft.complaint || "";
  form.elements.requestedServices.value = draft.requestedServices || "";
  const root = form.querySelector("#new-estimate-lines");
  root.dataset.sourceEstimateNumber = draft.sourceEstimateNumber || "";
  root.dataset.exclusions = JSON.stringify(draft.exclusions || []);
  root.dataset.insurance = JSON.stringify(draft.insurance || {});
  root.innerHTML = (draft.estimate?.lines || []).map((line, index) => estimateEditorLine(line, index)).join("");
  form.elements.shopSupplies.value = draft.estimate?.fees?.find(fee => /shop supplies/i.test(fee.description))?.amount ?? "";
  form.elements.estimateDiscount.value = draft.estimate?.discountPercent || 0;
  form.elements.estimateDiscountReason.value = draft.estimate?.discountReason || "";
  bindEstimateEditor(root);
  refreshEstimateEditor(root);
  toast(`${draft.sourceEstimateNumber || "Estimate"} filled for review. The work order has not been created.`);
}

const NEW_ORDER_DRAFT_KEY = "mechpro:new-work-order-draft:v1";
function readNewOrderDraftFromForm(form) {
  if (!form) return null;
  const data = Object.fromEntries(new FormData(form).entries());
  const estimate = typeof readNewOrderEstimate === "function" ? readNewOrderEstimate() : null;
  return {
    ...data,
    estimateLines: estimate?.lines || [],
    savedAt: Date.now(),
  };
}
function applyStoredNewOrderDraft(form, draft) {
  if (!form || !draft) return;
  for (const [key, value] of Object.entries(draft)) {
    if (key === "estimateLines" || key === "savedAt") continue;
    const field = form.elements[key];
    if (!field || value == null) continue;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value;
  }
  form.elements.customerSelect?.dispatchEvent(new Event("change"));
  if (draft.customerSelect && draft.customerSelect !== "__new__") {
    form.elements.customerSelect.value = draft.customerSelect;
    form.elements.customerSelect.dispatchEvent(new Event("change"));
  }
  if (draft.vehicle) form.elements.vehicle.value = draft.vehicle;
  if (draft.vin) form.elements.vin.value = draft.vin;
  if (draft.phone) form.elements.phone.value = draft.phone;
  if (Array.isArray(draft.estimateLines) && draft.estimateLines.length) {
    const lines = document.querySelector("#new-estimate-lines");
    if (lines) {
      lines.innerHTML = draft.estimateLines.map(line => newOrderEstimateRow(line)).join("");
      bindEstimateEditor(lines);
      refreshEstimateEditor(lines);
    }
  }
}
function bindNewOrderDraftAutosave(form) {
  if (!form) return;
  let timer = 0;
  const persist = () => {
    try { localStorage.setItem(NEW_ORDER_DRAFT_KEY, JSON.stringify(readNewOrderDraftFromForm(form))) } catch { /* private mode */ }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(persist, 400);
  };
  form.addEventListener("input", schedule);
  form.addEventListener("change", schedule);
  setModalAutosave(() => {
    clearTimeout(timer);
    persist();
  });
  form.addEventListener("submit", () => {
    try { localStorage.removeItem(NEW_ORDER_DRAFT_KEY) } catch { /* ignore */ }
    setModalAutosave(null);
  }, { capture: true });
}

const openNewEstimateFillCore = openNew;
function openNewWithDraft(draft = null) {
  openNewEstimateFillCore();
  const form = document.querySelector("#new-form");
  if (!form) return;
  addEstimateSourceControls(form);
  if (draft) {
    applyWorkOrderDraftToForm(form, draft);
  } else {
    try {
      const stored = JSON.parse(localStorage.getItem(NEW_ORDER_DRAFT_KEY) || "null");
      if (stored && Date.now() - Number(stored.savedAt || 0) < 7 * 24 * 60 * 60 * 1000) {
        applyStoredNewOrderDraft(form, stored);
        toast("Restored unsaved work order draft");
      }
    } catch { /* ignore corrupt draft */ }
  }
  bindNewOrderDraftAutosave(form);
}
openNew = function () { openNewWithDraft() };

savedEstimates = function () {
  const reference = `<section class="reference-template-card"><div><div class="eyebrow">Reusable shop template</div><h2>${REFERENCE_ESTIMATE.number}</h2><p>${escapeHtml(REFERENCE_ESTIMATE.customer.name)} · ${escapeHtml(REFERENCE_ESTIMATE.vehicle.description)}</p></div><strong>${money(REFERENCE_ESTIMATE.total)}</strong><div><button class="secondary" data-preview-estimate="${REFERENCE_ESTIMATE.id}">${icon("file-text", 14)} View estimate</button><button class="primary" data-fill-estimate="${REFERENCE_ESTIMATE.id}">${icon("clipboard-plus", 14)} Fill new work order</button></div></section>`;
  const rows = [...state.estimates].reverse().map(estimate => `<tr><td class="mono"><b>${escapeHtml(estimate.number || "Draft")}</b></td><td>${escapeHtml(typeof estimate.customer === "object" ? estimate.customer.name : estimate.customer)}<small>${escapeHtml(typeof estimate.vehicle === "object" ? estimate.vehicle.description : estimate.vehicle)}</small></td><td>${badge(estimate.status || "estimate")}</td><td><b>${money(estimate.total)}</b></td><td><div class="estimate-actions"><button class="mini-action" data-preview-estimate="${escapeAttr(estimate.id)}">${icon("file-text", 13)} View</button><button class="mini-action" data-fill-estimate="${escapeAttr(estimate.id)}">${icon("clipboard-plus", 13)} Fill work order</button><button class="mini-action" data-send-estimate="${escapeAttr(estimate.id)}" data-channel="email">${icon("mail", 13)} Email</button><button class="mini-action" data-send-estimate="${escapeAttr(estimate.id)}" data-channel="sms">${icon("message-square", 13)} Text</button>${estimate.status !== "approved" ? `<button class="mini-action" data-sign-estimate="${escapeAttr(estimate.id)}">${icon("signature", 13)} Sign</button>` : ""}</div></td></tr>`).join("");
  return `${reference}<section class="ai-result"><div class="ai-result-head"><div><div class="eyebrow">Customer estimates</div><h2>Estimate register</h2><p>Review the customer-facing document or explicitly fill a new work order.</p></div></div><div class="data-panel"><table><thead><tr><th>Estimate</th><th>Customer & vehicle</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No saved estimates.</td></tr>`}</tbody></table></div></section>`;
};

function assistantMessageMarkup(item, index) {
  const actions = (item.actions || []).map((action, actionIndex) => action.kind === "estimate_work_order_draft" ? `<button type="button" class="assistant-draft-action" data-assistant-draft="${index}:${actionIndex}">${icon("clipboard-plus", 14)} Save estimate & fill work order</button>` : "").join("");
  return `<article class="assistant-message ${item.role}"><strong>${item.role === "user" ? "You" : "MechPro Assistant"}</strong><p>${escapeHtml(item.content)}</p>${actions}</article>`;
}

liveAssistant = function () {
  const rows = assistantConversation.map(assistantMessageMarkup).join("");
  return `<section class="ai-panel live-assistant"><div class="statement-head"><div><div class="eyebrow">Claude + Deepgram call assistant</div><h2>Talk through the job</h2><p>Speak or type the customer, vehicle, complaint, parts, labor hours and source, and exclusions. MechPro prepares both records for review; it never auto-submits the work order.</p></div>${icon("audio-lines", 20)}</div><div class="assistant-messages" id="assistant-messages">${rows || `<div class="assistant-empty">Ask the assistant to prepare an estimate and work order from the call.</div>`}</div><form class="assistant-form" id="assistant-form"><textarea name="message" rows="2" maxlength="4000" placeholder="Create an estimate and work order for…"></textarea><div class="assistant-actions"><button class="secondary" type="button" id="assistant-mic" title="Record with Deepgram">${icon("mic", 15)} <span>Record</span></button><button class="icon-button" type="button" id="assistant-stop" title="Stop speaking">${icon("volume-x", 15)}</button><button class="primary" type="submit">${icon("send", 14)} Ask assistant</button></div><p class="assistant-provider-note">Voice transcription requires Deepgram. Estimate drafting requires Claude. Missing configuration is reported without a simulated answer.</p></form></section>`;
};

async function saveAssistantDraft(action) {
  const estimate = estimateFromAssistantDraft(action, {
    laborRate: shopProfile().laborRate,
    taxRate: state.taxSettings.rate,
  });
  const number = `EST-${new Date().getFullYear()}-${String(state.estimates.length + 1001).padStart(4, "0")}`;
  const record = {
    ...estimate,
    id: `estimate-${Date.now()}`,
    number,
    createdAt: now(),
    status: "pending",
    customer: estimate.customer.name,
    customerDetails: estimate.customer,
    phone: estimate.customer.phone,
    email: estimate.customer.email,
    address: estimate.customer.address,
    vehicle: estimate.vehicle.description,
    vehicleDetails: estimate.vehicle,
    vin: estimate.vehicle.vin,
    plate: estimate.vehicle.plate,
  };
  state.estimates.push(record);
  await pushEstimateToApi(record);
  save();
  closeModal();
  openNewWithDraft(workOrderDraftFromEstimate({
    ...estimate,
    number,
    customer: estimate.customer,
    vehicle: estimate.vehicle,
  }));
}

function bindAssistantDraftActions() {
  document.querySelectorAll("[data-assistant-draft]").forEach(button => {
    button.onclick = async () => {
      const [messageIndex, actionIndex] = button.dataset.assistantDraft.split(":").map(Number);
      const action = assistantConversation[messageIndex]?.actions?.[actionIndex];
      if (!action) return;
      button.disabled = true;
      try { await saveAssistantDraft(action) } catch (error) { button.disabled = false; toast(error.message || "The estimate draft could not be saved") }
    };
  });
}

bindLiveAssistant = function () {
  const form = document.querySelector("#assistant-form");
  if (!form) return;
  const input = form.elements.message, sendButton = form.querySelector("button[type=submit]"), micButton = document.querySelector("#assistant-mic");
  const renderMessages = () => {
    const list = document.querySelector("#assistant-messages");
    list.innerHTML = assistantConversation.map(assistantMessageMarkup).join("");
    list.scrollTop = list.scrollHeight;
    bindAssistantDraftActions();
  };
  const append = (role, content, actions = []) => { assistantConversation.push({ role, content, actions }); renderMessages() };
  form.onsubmit = async event => {
    event.preventDefault();
    if (assistantPaused) return;
    const message = String(input.value || "").trim();
    if (!message) return;
    input.value = "";
    sendButton.disabled = true;
    append("user", message);
    try {
      const history = assistantConversation.slice(0, -1).slice(-10).map(item => ({ role: item.role === "assistant" ? "assistant" : "user", content: [{ text: item.content }] }));
      const result = await apiFetch("/ai/assistant", { method: "POST", body: JSON.stringify({ message, sessionId: assistantSessionId || undefined, history }) });
      assistantSessionId = result.sessionId || assistantSessionId;
      const answer = result.message || "The assistant did not return an answer.";
      append("assistant", answer, result.actions || []);
      if (!assistantPaused && "speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(answer)) }
    } catch (error) {
      append("assistant", error.message || "The assistant is unavailable.");
    } finally {
      sendButton.disabled = assistantPaused;
    }
  };
  document.querySelector("#assistant-stop")?.addEventListener("click", () => speechSynthesis?.cancel());
  let recorder = null, stream = null, chunks = [];
  micButton?.addEventListener("click", async () => {
    if (recorder?.state === "recording") { recorder.stop(); return }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Audio recording is not supported in this browser");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) };
      recorder.onstop = async () => {
        micButton.disabled = true;
        micButton.querySelector("span").textContent = "Transcribing…";
        stream?.getTracks().forEach(track => track.stop());
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const result = await apiFetch("/ai/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
          input.value = result.transcript;
          form.requestSubmit();
        } catch (error) {
          append("assistant", error.message || "Voice transcription is unavailable.");
        } finally {
          micButton.disabled = false;
          micButton.querySelector("span").textContent = "Record";
        }
      };
      recorder.start();
      micButton.querySelector("span").textContent = "Stop & send";
      toast("Recording with Deepgram transcription");
    } catch {
      toast("Microphone access was not granted");
    }
  });
  bindAssistantDraftActions();
};

const bindReferenceEstimatesCore = bindEstimateActions;
bindEstimateActions = function () {
  bindReferenceEstimatesCore();
  document.querySelectorAll("[data-preview-estimate]").forEach(button => button.onclick = () => showEstimatePreview(estimateSourceById(button.dataset.previewEstimate)));
  document.querySelectorAll("[data-fill-estimate]").forEach(button => button.onclick = () => {
    const estimate = estimateSourceById(button.dataset.fillEstimate);
    if (estimate) openNewWithDraft(workOrderDraftFromEstimate(normalizedEstimateSource(estimate)));
  });
};

function invoicePaymentSummary(invoice) {
  return paymentSummary(invoice.amount, state.payments, {
    targetType: "invoice",
    targetId: invoice.number,
    linkedTargetId: invoice.ro || "",
    legacyPaid: invoice.status === "paid" && invoice.paymentStatus == null,
  });
}

function workOrderPaymentSummary(order) {
  const invoice = state.invoices.find(item => item.ro === order.id);
  return paymentSummary(order.total, state.payments, {
    targetType: "work_order",
    targetId: order.id,
    linkedTargetId: invoice?.number || "",
  });
}

function paymentMethodLabel(method) {
  return ({
    cash: "Cash",
    card: "Card",
    check: "Check",
    bank: "Bank transfer",
    processor: "Card processor",
    other: "Other",
    legacy: "Imported",
  })[method] || method || "Other";
}

function paymentTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value || "") : date.toLocaleString();
}

function paymentHistoryMarkup(summary) {
  const rows = summary.history.map(payment => `<tr><td>${escapeHtml(paymentTimestamp(payment.receivedAt))}</td><td>${escapeHtml(paymentMethodLabel(payment.method))}</td><td><b>${money(Number(payment.amount || 0))}</b></td><td>${escapeHtml(payment.reference || payment.note || "—")}<small>${payment.reference && payment.note ? escapeHtml(payment.note) : ""}</small></td></tr>`).join("");
  return `<div class="payment-history"><div class="payment-history-head"><strong>Payment history</strong><span>${summary.history.length} payment${summary.history.length === 1 ? "" : "s"}</span></div>${rows ? `<table><thead><tr><th>Date / time</th><th>Method</th><th>Amount</th><th>Reference / notes</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No payments recorded yet.</p>`}</div>`;
}

function localDateTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function saveRecordedPayment(targetType, targetId, data, amount, button) {
  button.disabled = true;
  try {
    const result = await apiFetch("/payments/record", {
      method: "POST",
      body: JSON.stringify({
        targetType,
        targetId,
        amount,
        method: data.method,
        receivedAt: new Date(data.receivedAt).toISOString(),
        reference: data.reference.trim(),
        note: data.note.trim(),
      }),
    });
    state.payments.push(result.payment);
    if (result.invoice) {
      const index = state.invoices.findIndex(invoice => invoice.number === result.invoice.number);
      if (index >= 0) state.invoices[index] = result.invoice;
    }
    if (result.workOrder) {
      const index = state.orders.findIndex(order => order.id === result.workOrder.id);
      if (index >= 0) state.orders[index] = result.workOrder;
    }
    save();
    closeModal();
    toast(`${money(amount)} payment recorded · ${money(result.summary.balance)} remaining`);
    render();
    if (targetType === "work_order") openOrder(targetId);
  } catch (error) {
    button.disabled = false;
    toast(error.message || "Payment could not be recorded");
  }
}

function recordTargetPayment(targetType, targetId, initialMethod = "cash") {
  const target = targetType === "invoice"
    ? state.invoices.find(invoice => invoice.number === targetId)
    : state.orders.find(order => order.id === targetId);
  if (!target) return;
  const summary = targetType === "invoice" ? invoicePaymentSummary(target) : workOrderPaymentSummary(target);
  if (summary.balance <= 0) return toast("This record has no remaining balance");
  const labelText = targetType === "invoice" ? target.number : target.id;
  showModal(`<form class="modal" id="payment-form"><div class="modal-head"><h2>Record payment</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body"><div class="estimate-sign-summary"><span>${escapeHtml(labelText)} · ${escapeHtml(target.customer || "")}</span><strong>${money(summary.balance)} remaining</strong></div><div class="form-grid"><label>Amount received *<input name="amount" type="number" min="0.01" max="${summary.balance}" step=".01" placeholder="Enter partial or full amount" required/></label><label>Method<select name="method">${["cash", "card", "check", "bank", "other"].map(method => `<option value="${method}" ${method === initialMethod || (initialMethod === "processor" && method === "card") ? "selected" : ""}>${paymentMethodLabel(method)}</option>`).join("")}</select></label><label>Received date / time<input name="receivedAt" type="datetime-local" value="${localDateTimeValue()}" required/></label><label>Reference / receipt<input name="reference" maxlength="160" placeholder="Receipt, check, or transaction ID"/></label><label class="full">Notes<textarea name="note" maxlength="500" placeholder="Optional payment note"></textarea></label></div><div class="payment-preview"><span>Paid to date <b>${money(summary.paid)}</b></span><span>Current balance <b>${money(summary.balance)}</b></span></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon("check", 14)} Record payment</button></div></form>`);
  document.querySelector("#payment-form").onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > summary.balance) {
      toast("Enter a payment amount within the remaining balance");
      return;
    }
    void saveRecordedPayment(targetType, targetId, data, amount, event.target.querySelector("button[type=submit]"));
  };
}

recordPayment = function (invoiceNumber, method = "cash") {
  recordTargetPayment("invoice", invoiceNumber, method);
};

invoicePaid = function (invoice) {
  return invoicePaymentSummary(invoice).paid;
};

invoiceBalance = function (invoice) {
  return invoicePaymentSummary(invoice).balance;
};

const paymentStatusLabelCore = label;
label = function (status) {
  return ({ partial: "Partially paid", unpaid: "Unpaid" })[status] || paymentStatusLabelCore(status);
};

invoices = function () {
  const q = query.toLowerCase();
  const rows = state.invoices.filter(invoice => !q || Object.values(invoice).join(" ").toLowerCase().includes(q)).map(invoice => {
    const summary = invoicePaymentSummary(invoice);
    const bd = invoiceTaxBreakdown(invoice);
    return `<tr><td class="mono"><b>${escapeHtml(invoice.number)}</b><small>${invoice.signature ? `Signed by ${escapeHtml(invoice.signature.authorizationName)}` : "Signature pending"}</small></td><td class="mono">${escapeHtml(invoice.ro || "")}</td><td><b>${escapeHtml(invoice.customer)}</b></td><td>${escapeHtml(invoice.date || "")}</td><td>${escapeHtml(invoice.closedAt || "")}</td><td>${badge(summary.status)}</td><td><b>${money(summary.total)}</b><small>Subtotal ${money(bd.subtotal)} · Tax ${money(bd.tax)}</small><small>Paid ${money(summary.paid)} · Remaining ${money(summary.balance)}</small></td><td><div class="invoice-payments"><button class="mini-action" data-print-invoice="${escapeAttr(invoice.number)}">${icon("printer", 13)} Print</button><button class="mini-action" data-sign-invoice="${escapeAttr(invoice.number)}" ${invoice.signature ? "disabled" : ""}>${icon("signature", 13)} ${invoice.signature ? "Signed" : "Sign"}</button>${summary.balance > 0 ? `<button class="mini-action" data-record-payment="${escapeAttr(invoice.number)}" data-method="cash">${icon("badge-dollar-sign", 13)} Record payment</button><button class="mini-action invoice-pay" data-pay-invoice="${escapeAttr(invoice.number)}">${icon("external-link", 13)} Pay online</button><button class="mini-action" data-text-pay="${escapeAttr(invoice.number)}">${icon("message-square", 13)} Text to pay</button>` : ""}</div>${paymentHistoryMarkup(summary)}</td></tr>`;
  }).join("");
  return shell(`${heading("Accounts receivable", "Invoices", "Record partial or full payments, monitor remaining balances, and review collection history.", false)}${stats()}<div class="data-panel invoice-register"><table><thead><tr><th>Invoice</th><th>Work order</th><th>Customer</th><th>Issued</th><th>Closeout</th><th>Status</th><th>Total</th><th>Payments</th></tr></thead><tbody>${rows || `<tr><td colspan="8">No invoices yet.</td></tr>`}</tbody></table></div>`);
};

const openOrderPaymentCore = openOrder;
openOrder = function (id) {
  openOrderPaymentCore(id);
  const order = state.orders.find(item => item.id === id);
  const modalBody = document.querySelector(".job-card-modal .modal-body");
  if (!order || !modalBody) return;
  const user = currentUser();
  const assigned = user && orderIncludesTechnician(order, user, state.users);
  const activeClock = user ? openJobClock(order.id, user.id) : null;
  const clockRows = (order.assignments || []).map(item => {
    const tracked = item.employeeId ? clockedHours(state.jobClockEntries, order.id, item.employeeId) : Number(item.hoursWorked || 0);
    return `<li><strong>${escapeHtml(item.name)}</strong> · ${escapeHtml(item.role)} · ${formatHours(tracked || item.hoursWorked)}</li>`;
  }).join("");
  const clockButton = user?.role === "technician" && assigned ? `<button class="${activeClock ? "secondary danger" : "primary"}" id="job-clock" data-work-order-id="${escapeAttr(order.id)}" type="button">${activeClock ? "Clock out" : "Clock in"}</button>` : "";
  modalBody.insertAdjacentHTML("afterbegin", `<section class="job-clock-panel"><div><h3>Assigned technicians</h3><ul class="intake-causes">${clockRows || `<li>${escapeHtml(order.tech || "Unassigned")}</li>`}</ul>${clockButton}</div>${["admin", "service_writer"].includes(user?.role) ? `<button class="secondary" type="button" id="edit-assignments">Edit assignments</button>` : ""}</section>`);
  document.querySelector("#job-clock")?.addEventListener("click", event => { const workOrderId = event.currentTarget.dataset.workOrderId; openJobClock(workOrderId) ? stopJobClock(workOrderId) : startJobClock(workOrderId) });
  document.querySelector("#edit-assignments")?.addEventListener("click", () => openAssignmentEditor(order));
  const summary = workOrderPaymentSummary(order);
  modalBody.insertAdjacentHTML("beforeend", `<section class="work-order-payments"><div class="job-section-head"><div><h3>Payments</h3><p>Record deposits or partial collections against this work order.</p></div>${summary.balance > 0 ? `<button class="primary" type="button" id="record-work-order-payment">${icon("badge-dollar-sign", 14)} Record payment</button>` : ""}</div><div class="payment-balance-grid"><div><span>Total</span><b>${money(summary.total)}</b></div><div><span>Paid</span><b>${money(summary.paid)}</b></div><div><span>Remaining</span><b>${money(summary.balance)}</b></div><div><span>Status</span>${badge(summary.status)}</div></div>${paymentHistoryMarkup(summary)}</section>`);
  document.querySelector("#record-work-order-payment")?.addEventListener("click", () => recordTargetPayment("work_order", order.id));
  lucide.createIcons();
};

async function startApp() {
  if (isOfflineDesktop()) {
    desktopEntitlementVerified = true;
    try {
      const status = await window.mechproDesktop.localAuth.status();
      offlineAccountReady = Boolean(status?.exists);
      offlineAccountEmail = status?.email || "";
      const snapshot = await window.mechproDesktop.localShop.load();
      if (snapshot) applyShopSnapshot(state, snapshot);
    } catch (error) {
      console.error("Offline shop could not be opened", error);
    }
    render();
    return;
  }
  // Always refresh /auth/session when possible so ACCESS_ADMIN_EMAILS promotions
  // (and other claim changes) apply without requiring a full sign-out.
  try {
    const session = await cloudflareAccessSignIn();
    const user = await resolveAuthenticatedProfile(session);
    if (user) {
      state.currentUserId = user.id;
      if (user.role === "super_admin" && !canAccess(state.route)) state.route = "superadmin";
      if (user.role !== "super_admin") await reloadOperationalData();
    }
  } catch (error) {
    if (!authSession()) console.info("Cloudflare Access session not available", error.message);
  }
  if (isDesktopApp && authSession()) {
    try { await verifyDesktopEntitlement() }
    catch (error) { desktopLoginMessage = error.message; clearAuthSession() }
  }
  if (currentUser()) await loadShopEntities();
  save();
  render();
}
if (isDesktopApp && !isOfflineDesktop()) setInterval(async () => { if (!authSession()) return; try { await verifyDesktopEntitlement() } catch (error) { desktopLoginMessage = error.message; desktopEntitlementVerified = false; clearAuthSession(); render() } }, DESKTOP_ENTITLEMENT_INTERVAL);
// Keep the HttpOnly cookie + sessionStorage expiresAt rolling for always-open
// dispatch tabs. Without this, Max-Age from the last /auth/session would expire
// even though D1 may still be extended by other API traffic.
const SESSION_KEEPALIVE_MS = 6 * 60 * 60 * 1000;
if (!isOfflineDesktop()) setInterval(async () => {
  if (isLocalShell() || !authSession()) return;
  try { await cloudflareAccessSignIn() } catch { /* leave authSession() to clear on the next probe */ }
}, SESSION_KEEPALIVE_MS);
const saveCloudPreferences = save;
let offlineSaveTimer = 0;
save = function () { saveCloudPreferences(); if (!isOfflineDesktop() || !window.mechproDesktop?.localShop) return; clearTimeout(offlineSaveTimer); offlineSaveTimer = setTimeout(() => { void window.mechproDesktop.localShop.save(snapshotShop(state)).catch(error => console.error("Offline save failed", error)) }, 200) };
window.addEventListener("pagehide", () => { if (isOfflineDesktop() && window.mechproDesktop?.localShop) void window.mechproDesktop.localShop.save(snapshotShop(state)) });
window.icon = icon;
window.escapeHtml = escapeHtml;
window.shell = shell;
window.heading = heading;
window.toast = toast;
window.apiFetch = apiFetch;
window.save = save;
Object.defineProperty(window, "state", { get: () => state });
Object.defineProperty(window, "render", { get: () => render });
/* === MECHPRO_FILING_OVERRIDES_START === */

function filingIsoDate(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function filingPeriodPresets() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3);
  const monthStart = new Date(y, m, 1);
  const quarterStart = new Date(y, q * 3, 1);
  const yearStart = new Date(y, 0, 1);
  const today = filingIsoDate(now);
  return {
    month: { from: filingIsoDate(monthStart), to: today, label: 'This month' },
    quarter: { from: filingIsoDate(quarterStart), to: today, label: 'This quarter' },
    ytd: { from: filingIsoDate(yearStart), to: today, label: 'YTD' },
  };
}

function filingParseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function filingInRange(dateValue, from, to) {
  const d = filingParseDate(dateValue);
  if (!d) return false;
  const start = filingParseDate(from);
  const end = filingParseDate(to);
  if (!start || !end) return false;
  end.setHours(23, 59, 59, 999);
  return d >= start && d <= end;
}

function shopFilingProfile() {
  const profile = shopProfile();
  const t = state.taxSettings || {};
  const jurisdictions = Filing.normalizeJurisdictions(t.jurisdictions, Number(t.rate) || 8.25);
  return {
    shopName: profile.shopName || 'Your Car Guy',
    address: profile.address || '',
    phone: profile.phone || '',
    ein: t.ein || '',
    taxId: t.taxId || '',
    texasTaxpayerNumber: t.texasTaxpayerNumber || '',
    webfileNumber: t.webfileNumber || '',
    state: t.state || 'TX',
    rate: Number(t.rate) || Filing.combinedSalesTaxRate(jurisdictions),
    filingFrequency: t.filingFrequency || 'Monthly',
    jurisdictions,
  };
}

taxReport = function (fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const invoices = getFinanceDerived().invoiceByNumber;
  to.setHours(23, 59, 59, 999);
  const rate = Number(state.taxSettings.rate) || 0;
  const rows = paymentRecords().filter(payment => {
    const d = new Date(payment.receivedAt);
    return d >= from && d <= to;
  }).map(payment => {
    const invoice = invoices.get(payment.invoiceNumber);
    const bd = invoiceTaxBreakdown(invoice);
    const ratio = invoice ? payment.amount / (invoice.amount || payment.amount) : 0;
    const gross = Number(payment.amount);
    const taxable = Math.round(bd.subtotal * ratio * 100) / 100;
    const tax = Math.round(bd.tax * ratio * 100) / 100;
    const nontaxable = Math.max(0, Math.round((gross - taxable - tax) * 100) / 100);
    return {
      date: payment.receivedAt,
      invoiceNumber: payment.invoiceNumber,
      customer: payment.customer,
      gross,
      taxable,
      nontaxable,
      tax,
      taxRate: bd.taxRate ?? rate,
    };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totals = rows.reduce((acc, row) => ({
    gross: Math.round((acc.gross + row.gross) * 100) / 100,
    taxable: Math.round((acc.taxable + row.taxable) * 100) / 100,
    nontaxable: Math.round((acc.nontaxable + row.nontaxable) * 100) / 100,
    tax: Math.round((acc.tax + row.tax) * 100) / 100,
  }), { gross: 0, taxable: 0, nontaxable: 0, tax: 0 });
  return { from: fromDate, to: toDate, rows, totals };
};

taxReportView = function (result, stateName, settings) {
  const shop = shopFilingProfile();
  const supplement = Filing.buildJurisdictionSupplement(result.totals.taxable, shop.jurisdictions);
  const rows = result.rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td class="mono">${escapeHtml(row.invoiceNumber)}</td><td>${escapeHtml(row.customer)}</td><td>${money(row.gross)}</td><td>${money(row.taxable)}</td><td>${money(row.nontaxable ?? 0)}</td><td><b>${money(row.tax)}</b></td></tr>`).join('');
  const jurisRows = supplement.rows.map(r => `<tr><td class="mono">${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.kind)}</td><td>${r.rate}%</td><td>${money(r.amountSubjectToLocalTax)}</td><td><b>${money(r.taxDue)}</b></td></tr>`).join('');
  return `<div class="tax-report-print" id="tax-report-printable"><div class="statement-head"><div><div class="eyebrow">${escapeHtml(stateName)} sales tax filing</div><h2>Period ${escapeHtml(result.from)} to ${escapeHtml(result.to)}</h2><small>${escapeHtml(shop.shopName)} · Tax ID: ${escapeHtml(settings.taxId || 'Not set')} · EIN: ${escapeHtml(shop.ein || 'Not set')} · Filing: ${escapeHtml(settings.filingFrequency)} · Rate ${shop.rate}%</small></div></div><div class="finance-kpis"><article><span>Gross receipts</span><strong>${money(result.totals.gross)}</strong></article><article><span>Taxable sales</span><strong>${money(result.totals.taxable)}</strong></article><article><span>Nontaxable</span><strong>${money(result.totals.nontaxable || 0)}</strong></article><article><span>Tax collected</span><strong>${money(result.totals.tax)}</strong></article></div><div class="data-panel"><table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Gross</th><th>Taxable</th><th>Nontaxable</th><th>Tax</th></tr></thead><tbody>${rows || `<tr><td colspan="7">No payments were recorded in this period.</td></tr>`}</tbody></table></div><div class="statement" style="margin-top:14px"><div class="statement-head"><div><div class="eyebrow">Local jurisdictions</div><h2>Texas list supplement</h2></div></div><div class="data-panel"><table><thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Rate</th><th>Subject to tax</th><th>Tax due</th></tr></thead><tbody>${jurisRows}</tbody></table></div><small>State ${money(supplement.stateTax)} · Local ${money(supplement.localTax)} · Total ${money(supplement.totalTax)}</small></div></div>`;
};

reports = function () {
  const t = state.taxSettings;
  const stateName = usStates.find(s => s.code === t.state)?.name || t.state;
  const result = taxReportResult;
  const presets = filingPeriodPresets();
  const fromVal = result?.from || presets.month.from;
  const toVal = result?.to || presets.month.to;
  return shell(`${heading('Performance', 'Reports', 'Sales tax filing report, jurisdiction matrix, and e-file packages for your CPA or state portal.', false)}${stats()}
<section class="messaging-panel"><div class="messaging-status ready">${icon('landmark', 17)}<div><strong>Tax filing report — ${escapeHtml(stateName)}</strong><span>Cash-basis sales tax for ${escapeHtml(stateName)} ${escapeHtml(String(t.filingFrequency || '').toLowerCase())} filing. Includes nontaxable and local jurisdiction split.</span></div></div>
<div class="payroll-period-controls no-print" style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px">
<button type="button" class="secondary" data-tax-preset="month">${presets.month.label}</button>
<button type="button" class="secondary" data-tax-preset="quarter">${presets.quarter.label}</button>
<button type="button" class="secondary" data-tax-preset="ytd">${presets.ytd.label}</button>
</div>
<form class="form-grid" id="tax-report-form"><label>From date *<input type="date" name="from" value="${fromVal}" required/></label><label>To date *<input type="date" name="to" value="${toVal}" required/></label>
<div class="full messaging-actions">
<button class="primary" type="submit">${icon('file-text', 14)} Generate report</button>
${result ? `<button class="secondary" type="button" id="print-tax-report">${icon('printer', 14)} Print</button>
<button class="secondary" type="button" id="export-tax-csv">${icon('download', 14)} Export CSV</button>
<button class="secondary" type="button" id="export-tx-webfile">${icon('upload', 14)} TX WebFile package</button>
<button class="secondary" type="button" id="open-filing-center">${icon('landmark', 14)} Filing center</button>` : ''}
</div></form>
${result ? taxReportView(result, stateName, t) : ''}
</section>
${filingCenterMarkup()}`);
};

function filingCenterMarkup() {
  if (!filingCenterOpen) return '';
  const shop = shopFilingProfile();
  return `<section class="messaging-panel no-print" style="margin-top:16px"><div class="statement-head"><div><div class="eyebrow">E-file center</div><h2>IRS · Texas Comptroller · SSA</h2><p>MechPro builds portal-ready packages. Transmit via the linked government portals (or your CPA). Configure transmitter credentials in Shop settings when you enroll as an e-file provider.</p></div><button type="button" class="secondary" id="close-filing-center">Close</button></div>
<div class="accounting-grid" style="margin-top:12px">
<section class="statement"><div class="eyebrow">Sales tax</div><h3>Texas WebFile / EDI</h3><p>List-supplement CSV with 7-digit jurisdiction codes for WebFile or Texas EDI software.</p><a class="secondary" href="https://comptroller.texas.gov/taxes/file-pay/about-webfile.php" target="_blank" rel="noopener">Open WebFile</a></section>
<section class="statement"><div class="eyebrow">Employment tax</div><h3>IRS Form 941 + EFTPS</h3><p>Quarterly 941 worksheet from payroll withholdings. Pay deposits via EFTPS.</p><a class="secondary" href="https://www.irs.gov/businesses/small-businesses-self-employed/e-file-employment-tax-forms" target="_blank" rel="noopener">IRS employment e-file</a></section>
<section class="statement"><div class="eyebrow">Annual wages</div><h3>SSA W-2 / 1099</h3><p>Printable W-2 &amp; 1099-NEC plus EFW2 text for Business Services Online.</p><a class="secondary" href="https://www.ssa.gov/employer/" target="_blank" rel="noopener">SSA BSO</a></section>
</div>
<small>EIN on file: ${escapeHtml(shop.ein || 'Not set')} · TX taxpayer #: ${escapeHtml(shop.texasTaxpayerNumber || 'Not set')} · WebFile #: ${escapeHtml(shop.webfileNumber || 'Not set')}</small>
</section>`;
}

async function generateTaxReportFromForm(from, to) {
  try {
    if (navigator.onLine && !isLocalShell()) {
      const remote = await apiFetch(`/tax-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (remote?.rows) {
        taxReportResult = {
          from: remote.from || from,
          to: remote.to || to,
          rows: remote.rows.map(row => ({
            ...row,
            nontaxable: row.nontaxable ?? Math.max(0, Math.round((Number(row.gross) - Number(row.taxable) - Number(row.tax)) * 100) / 100),
          })),
          totals: remote.totals,
        };
        return;
      }
    }
  } catch (error) {
    console.warn('tax-report API unavailable, using local', error);
  }
  taxReportResult = taxReport(from, to);
}

function exportSalesTaxCsv() {
  if (!taxReportResult) return;
  const shop = shopFilingProfile();
  const rows = [
    ['Sales tax filing export'],
    ['Shop', shop.shopName],
    ['State', shop.state],
    ['Tax ID', shop.taxId],
    ['EIN', shop.ein],
    ['Period from', taxReportResult.from],
    ['Period to', taxReportResult.to],
    ['Filing frequency', shop.filingFrequency],
    [],
    ['Date', 'Invoice', 'Customer', 'Gross', 'Taxable', 'Nontaxable', 'Tax', 'Tax rate', 'Tax ID', 'State'],
    ...taxReportResult.rows.map(row => [
      row.date, row.invoiceNumber, row.customer, row.gross, row.taxable, row.nontaxable ?? 0, row.tax, row.taxRate ?? shop.rate, shop.taxId, shop.state,
    ]),
    [],
    ['Totals', '', '', taxReportResult.totals.gross, taxReportResult.totals.taxable, taxReportResult.totals.nontaxable || 0, taxReportResult.totals.tax, '', '', ''],
  ];
  Filing.downloadTextFile(`mechpro-sales-tax-${taxReportResult.from}-${taxReportResult.to}.csv`, Filing.csvFromRows(rows));
  toast('Sales tax CSV exported');
}

function exportTexasWebfilePackage() {
  if (!taxReportResult) return;
  const shop = shopFilingProfile();
  const supplement = Filing.buildJurisdictionSupplement(taxReportResult.totals.taxable, shop.jurisdictions);
  const csv = Filing.texasListSupplementCsv(supplement, {
    taxpayerNumber: shop.texasTaxpayerNumber,
    taxId: shop.taxId,
    from: taxReportResult.from,
    to: taxReportResult.to,
    outlet: 'Primary',
  });
  Filing.downloadTextFile(`mechpro-tx-webfile-${taxReportResult.from}-${taxReportResult.to}.csv`, csv);
  toast('Texas WebFile package downloaded');
}

function buildTaxPackage(from, to) {
  const payments = paymentRecords().filter(p => filingInRange(p.receivedAt, from, to));
  const expenses = state.expenses.filter(x => filingInRange(x.date, from, to));
  const journals = state.journalEntries.filter(x => filingInRange(x.date, from, to));
  let revenue = 0;
  let salesTax = 0;
  for (const payment of payments) {
    const invoice = state.invoices.find(item => item.number === payment.invoiceNumber);
    const bd = invoiceTaxBreakdown(invoice);
    const ratio = invoice ? payment.amount / (invoice.amount || payment.amount) : 0;
    salesTax += bd.tax * ratio;
    revenue += payment.amount - bd.tax * ratio;
  }
  const manualIncome = journals.filter(x => x.creditAccount === '4000').reduce((s, x) => s + Number(x.amount || 0), 0);
  const manualExpense = journals.filter(x => /^5|^6/.test(x.debitAccount)).reduce((s, x) => s + Number(x.amount || 0), 0);
  const expenseTotal = expenses.reduce((s, x) => s + Number(x.amount || 0), 0) + manualExpense;
  const byCategory = {};
  for (const x of expenses) {
    byCategory[x.category || 'Other'] = (byCategory[x.category || 'Other'] || 0) + Number(x.amount || 0);
  }
  revenue = Math.round((revenue + manualIncome) * 100) / 100;
  salesTax = Math.round(salesTax * 100) / 100;
  const net = Math.round((revenue - expenseTotal) * 100) / 100;
  return { from, to, revenue, salesTax, expenseTotal, net, byCategory, expenses, payments: payments.length };
}

function taxPackageView() {
  const presets = filingPeriodPresets();
  const range = taxPackageRange || presets.ytd;
  const pack = buildTaxPackage(range.from, range.to);
  const catRows = Object.entries(pack.byCategory).map(([cat, amt]) => `<div class="statement-line"><span>${escapeHtml(cat)}</span><b>${money(amt)}</b></div>`).join('') || '<div class="statement-line"><span>No expenses in range</span><b>$0.00</b></div>';
  return `<div class="tax-package-print" id="tax-package-printable">
<div class="payroll-period-controls no-print" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
<button type="button" class="secondary" data-taxpkg-preset="month">MTD</button>
<button type="button" class="secondary" data-taxpkg-preset="quarter">QTD</button>
<button type="button" class="secondary" data-taxpkg-preset="ytd">YTD</button>
<label>From<input type="date" id="taxpkg-from" value="${pack.from}"/></label>
<label>To<input type="date" id="taxpkg-to" value="${pack.to}"/></label>
<button type="button" class="primary" id="taxpkg-apply">Apply</button>
<button type="button" class="secondary" id="taxpkg-export-pl">${icon('download', 14)} Export P&amp;L</button>
<button type="button" class="secondary" id="taxpkg-export-exp">${icon('download', 14)} Export expenses</button>
<button type="button" class="secondary" id="taxpkg-print">${icon('printer', 14)} Print</button>
</div>
<div class="finance-kpis"><article><span>Service revenue (ex-tax)</span><strong>${money(pack.revenue)}</strong></article><article><span>Operating expenses</span><strong>${money(pack.expenseTotal)}</strong></article><article class="${pack.net >= 0 ? 'positive' : 'negative'}"><span>Net income</span><strong>${money(pack.net)}</strong></article><article><span>Sales tax collected</span><strong>${money(pack.salesTax)}</strong><small>Liability — not income</small></article></div>
<div class="accounting-grid"><section class="statement"><div class="statement-head"><div><div class="eyebrow">Cash-basis P&amp;L</div><h2>${escapeHtml(pack.from)} → ${escapeHtml(pack.to)}</h2></div><span class="badge paid">Schedule C prep</span></div>
<div class="statement-line"><span>Service revenue</span><b>${money(pack.revenue)}</b></div>
${catRows}
<div class="statement-line total"><span>Net income</span><b>${money(pack.net)}</b></div>
<small>${pack.payments} payments · Sales tax ${money(pack.salesTax)} held in 2100</small>
</section>
<section class="statement"><div class="statement-head"><div><div class="eyebrow">Filing note</div><h2>Income tax package</h2></div></div>
<p>Export these CSVs for your CPA or Schedule C. Revenue excludes sales tax collected. MechPro does not e-file Form 1040/1120 — use the package with your preparer or tax software.</p>
</section></div></div>`;
}

function exportTaxPackagePl() {
  const presets = filingPeriodPresets();
  const range = taxPackageRange || presets.ytd;
  const pack = buildTaxPackage(range.from, range.to);
  const rows = [
    ['Cash-basis profit and loss'],
    ['From', pack.from], ['To', pack.to], ['Shop', shopFilingProfile().shopName],
    [],
    ['Line', 'Amount'],
    ['Service revenue (excluding sales tax)', pack.revenue],
    ...Object.entries(pack.byCategory).map(([cat, amt]) => [`Expense — ${cat}`, amt]),
    ['Total expenses', pack.expenseTotal],
    ['Net income', pack.net],
    ['Sales tax collected (liability 2100)', pack.salesTax],
  ];
  Filing.downloadTextFile(`mechpro-pl-${pack.from}-${pack.to}.csv`, Filing.csvFromRows(rows));
  toast('P&L tax package exported');
}

function exportTaxPackageExpenses() {
  const presets = filingPeriodPresets();
  const range = taxPackageRange || presets.ytd;
  const pack = buildTaxPackage(range.from, range.to);
  const rows = [
    ['Date', 'Vendor', 'Category', 'Account', 'Amount', 'Memo'],
    ...pack.expenses.map(x => [x.date, x.vendor, x.category, x.account || expenseAccount(x.category), x.amount, x.memo || '']),
  ];
  Filing.downloadTextFile(`mechpro-expenses-${pack.from}-${pack.to}.csv`, Filing.csvFromRows(rows));
  toast('Expense detail exported');
}

accounting = function () {
  const data = finance();
  const tabs = [['overview', 'Overview'], ['taxpackage', 'Tax package'], ['receivables', 'Receivables'], ['expenses', 'Expenses'], ['ledger', 'General ledger'], ['accounts', 'Chart of accounts']];
  const views = {
    overview: profitLoss(data),
    taxpackage: taxPackageView(),
    receivables: arView(data),
    expenses: expenseView(),
    ledger: ledgerView(),
    accounts: accountView(),
  };
  return shell(`${heading('Financial operations', 'Accounting', 'Income, expenses, receivables, and filing packages for Your Car Guy.', false)}<div class="accounting-actions"><button class="secondary" id="accounting-export">${icon('download', 14)} Export ledger</button><button class="secondary" id="journal-entry">${icon('book-open-check', 14)} Journal entry</button><button class="primary" id="record-expense">${icon('plus', 14)} Record expense</button></div><div class="accounting-tabs">${tabs.map(x => `<button class="tab ${accountingTab === x[0] ? 'active' : ''}" data-accounting-tab="${x[0]}">${x[1]}</button>`).join('')}</div>${views[accountingTab] || views.overview}`);
};

function activePayrollPeriod(date = new Date()) {
  if (payrollPeriodKey) {
    const d = new Date(`${payrollPeriodKey}T12:00:00`);
    if (!Number.isNaN(d.getTime())) return weekPeriod(d);
  }
  return weekPeriod(date);
}

function ytdPayForUser(user, throughPeriodKey) {
  const year = String(throughPeriodKey || filingIsoDate()).slice(0, 4);
  const periods = new Set(state.payrollEntries.filter(e => e.employeeId === user.id && String(e.periodKey || '').startsWith(year)).map(e => e.periodKey));
  if (user.employmentType === 'Salary') {
    const start = new Date(`${year}-01-01T12:00:00`);
    const end = new Date(`${throughPeriodKey}T12:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) periods.add(weekPeriod(d).key);
  }
  let gross = 0; let federal = 0; let socialSecurity = 0; let medicare = 0; let state = 0; let ssWages = 0;
  const sorted = [...periods].sort();
  for (const key of sorted) {
    const stub = payStub(user, weekPeriod(new Date(`${key}T12:00:00`)), { ytdSocialSecurityWages: ssWages });
    gross += stub.gross;
    federal += stub.federal;
    socialSecurity += stub.socialSecurity;
    medicare += stub.medicare;
    state += stub.state;
    ssWages += stub.socialSecurityWages || 0;
  }
  return {
    gross: Math.round(gross * 100) / 100,
    federal: Math.round(federal * 100) / 100,
    socialSecurity: Math.round(socialSecurity * 100) / 100,
    medicare: Math.round(medicare * 100) / 100,
    state: Math.round(state * 100) / 100,
    socialSecurityWages: Math.round(ssWages * 100) / 100,
    net: Math.round((gross - federal - socialSecurity - medicare - state) * 100) / 100,
  };
}

payStub = function (user, period, opts = {}) {
  const lines = state.payrollEntries.filter(entry => entry.employeeId === user.id && entry.periodKey === period.key);
  const hours = lines.reduce((sum, line) => sum + Number(line.hours || 0), 0);
  const shiftHours = state.shiftEntries.filter(entry => entry.userId === user.id && entry.clockOut && String(entry.clockIn).slice(0, 10) >= period.key && String(entry.clockIn).slice(0, 10) <= period.key).reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
  const jobPay = lines.reduce((sum, line) => sum + Number(line.amount || line.grossPay || 0), 0);
  const salaryPay = user.employmentType === 'Salary' ? Number(user.payRate || 0) / 52 : 0;
  const gross = Math.round((jobPay + salaryPay) * 100) / 100;
  const taxes = Filing.computePayPeriodTaxes(user, gross, { socialSecurityWages: opts.ytdSocialSecurityWages || 0 });
  if (shopFilingProfile().state === 'TX' && !Number(user.stateWithholdingRate)) taxes.state = 0;
  return {
    user, period, lines, hours, shiftHours, gross, salaryPay,
    federal: taxes.federal,
    socialSecurity: taxes.socialSecurity,
    medicare: taxes.medicare,
    state: taxes.state,
    employerSocialSecurity: taxes.employerSocialSecurity,
    employerMedicare: taxes.employerMedicare,
    socialSecurityWages: taxes.socialSecurityWages || 0,
    pretax: taxes.pretax || 0,
    method: taxes.method,
    is1099: taxes.is1099,
    fica: Math.round((taxes.socialSecurity + taxes.medicare) * 100) / 100,
    other: taxes.state,
    net: taxes.net,
  };
};

payStubMarkup = function (stub) {
  const user = stub.user;
  const ytd = ytdPayForUser(user, stub.period.key);
  const lines = stub.lines.map(line => `<tr><td class="mono">${escapeHtml(line.roNumber)}</td><td>${escapeHtml(line.customer)}<small>${escapeHtml(line.vehicle)}</small></td><td>${Number(line.hours).toFixed(2)}</td><td>${money(line.rate)}</td><td><b>${money(line.amount || line.grossPay)}</b></td></tr>`).join('');
  return `<section class="pay-stub"><div class="pay-stub-head"><div><div class="eyebrow">${escapeHtml(user.employeeId || 'Employee')} · ${escapeHtml(user.department || 'Department')}</div><h2>${escapeHtml(user.name)}</h2><p>${escapeHtml(user.title)} · ${escapeHtml(user.employmentType || '')} · ${escapeHtml(stub.method || '')}</p></div><div class="net-pay"><span>Net pay</span><strong>${money(stub.net)}</strong></div></div>
<div class="pay-stub-totals">
<div><span>Job hours</span><b>${stub.hours.toFixed(2)}</b></div>
<div><span>Gross</span><b>${money(stub.gross)}</b></div>
<div><span>Federal FIT</span><b>(${money(stub.federal)})</b></div>
<div><span>SS / Medicare</span><b>(${money(stub.socialSecurity)} / ${money(stub.medicare)})</b></div>
<div><span>State</span><b>(${money(stub.state)})</b></div>
<div><span>Employer FICA</span><b>${money(stub.employerSocialSecurity + stub.employerMedicare)}</b></div>
</div>
${stub.salaryPay ? `<div class="salary-line">Weekly salary base: <b>${money(stub.salaryPay)}</b></div>` : ''}
<table><thead><tr><th>Work order</th><th>Job</th><th>Hours</th><th>Rate</th><th>Pay</th></tr></thead><tbody>${lines || `<tr><td colspan="5">No completed job labor has been posted this week.</td></tr>`}</tbody></table>
<div class="pay-stub-foot"><span>YTD gross ${money(ytd.gross)} · FIT ${money(ytd.federal)} · SS ${money(ytd.socialSecurity)} · Med ${money(ytd.medicare)}</span><span>Tax status: ${escapeHtml(user.taxStatus || 'Not set')} · W-4 ${escapeHtml(user.w4FilingStatus || 'single')}</span></div>
${currentUser().role === 'admin' ? `<div class="payroll-actions" style="margin-top:10px;justify-content:flex-start"><button type="button" class="mini-action" data-print-w2="${escapeHtml(user.id)}">${icon('file-text', 13)} W-2 / 1099</button></div>` : ''}
</section>`;
};

payroll = function () {
  syncAllPayroll();
  const period = activePayrollPeriod();
  payrollPeriodKey = period.key;
  const admin = currentUser().role === 'admin';
  const people = admin ? state.users.filter(user => user.active) : [currentUser()];
  const stubs = people.map(user => payStub(user, period));
  const liabilities = stubs.reduce((acc, s) => ({
    federal: acc.federal + s.federal,
    ss: acc.ss + s.socialSecurity + s.employerSocialSecurity,
    med: acc.med + s.medicare + s.employerMedicare,
    net: acc.net + s.net,
    hours: acc.hours + s.hours,
  }), { federal: 0, ss: 0, med: 0, net: 0, hours: 0 });
  return shell(`${heading('Compensation', 'Payroll', admin ? `Weekly payroll for ${period.start} – ${period.end}. Pub 15-T (2026) withholding · fileable register & 941/W-2 packages.` : `Your weekly pay stub for ${period.start} – ${period.end}.`, false)}
<div class="ai-notice">${icon('landmark', 16)}<span>Withholding uses IRS Pub 15-T (2026) percentage method, employee W-4 fields, and FICA. MechPro prepares e-file packages for IRS / SSA portals; it does not transmit until you upload via those portals or configure transmitter credentials.</span></div>
${admin ? `<div class="payroll-actions"><button class="secondary" id="payroll-export">${icon('download', 14)} Export register</button><button class="secondary" id="payroll-export-detail">${icon('download', 14)} Export detail</button><button class="secondary" id="payroll-export-941">${icon('file-text', 14)} 941 worksheet</button><button class="secondary" id="payroll-export-efw2">${icon('upload', 14)} SSA EFW2</button><button class="primary" id="sync-payroll">${icon('refresh-cw', 14)} Sync jobs</button></div>` : ''}
<div class="payroll-period-controls" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
<button type="button" class="secondary" id="payroll-prev">${icon('chevron-left', 14)} Prev</button>
<strong>${period.start} – ${period.end}</strong>
<button type="button" class="secondary" id="payroll-next">Next ${icon('chevron-right', 14)}</button>
<label>Jump to week<input type="date" id="payroll-jump" value="${period.key}"/></label>
</div>
<div class="payroll-summary"><span>Pay period</span><strong>${period.start} – ${period.end}</strong><span>${liabilities.hours.toFixed(2)} labor hours</span><strong>${money(liabilities.net)} net</strong></div>
${admin ? technicianTrackerHtml(technicianPerformance(state.orders, state.users, state.jobClockEntries)) : ""}
${admin ? `<div class="finance-kpis" style="margin:12px 0"><article><span>FIT withheld (2200)</span><strong>${money(liabilities.federal)}</strong></article><article><span>FICA payable (2210)</span><strong>${money(liabilities.ss)}</strong></article><article><span>Medicare payable (2220)</span><strong>${money(liabilities.med)}</strong></article><article><span>Suggested liabilities</span><strong>${money(liabilities.federal + liabilities.ss + liabilities.med)}</strong><small>Do not auto-journal</small></article></div>` : ''}
<div class="payroll-grid">${stubs.map(payStubMarkup).join('') || empty('No active payroll employees')}</div>`);
};

exportPayroll = function () {
  syncAllPayroll();
  const period = activePayrollPeriod();
  const adminPeople = state.users.filter(user => user.active);
  const stubs = adminPeople.map(user => payStub(user, period));
  const rows = [
    ['Employee ID', 'Employee', 'Pay period', 'Tax status', 'Hours', 'Gross', 'Pretax', 'Federal FIT', 'Social Security', 'Medicare', 'State', 'Net', 'Employer SS', 'Employer Medicare', 'Method'],
    ...stubs.map(stub => [
      stub.user.employeeId || '', stub.user.name, `${period.start} - ${period.end}`, stub.user.taxStatus || '',
      stub.hours.toFixed(2), stub.gross, stub.pretax || 0, stub.federal, stub.socialSecurity, stub.medicare, stub.state, stub.net,
      stub.employerSocialSecurity, stub.employerMedicare, stub.method || '',
    ]),
  ];
  Filing.downloadTextFile(`mechpro-payroll-register-${period.key}.csv`, Filing.csvFromRows(rows));
  toast('Payroll register exported');
};

function exportPayrollDetail() {
  syncAllPayroll();
  const period = activePayrollPeriod();
  const rows = [
    ['Employee ID', 'Employee', 'Pay period', 'Work order', 'Customer', 'Hours', 'Rate', 'Gross pay'],
    ...state.payrollEntries.filter(line => line.periodKey === period.key).map(line => {
      const user = state.users.find(item => item.id === line.employeeId);
      return [user?.employeeId || '', user?.name || '', `${period.start} - ${period.end}`, line.roNumber, line.customer, line.hours, line.rate, line.amount || line.grossPay];
    }),
  ];
  Filing.downloadTextFile(`mechpro-payroll-detail-${period.key}.csv`, Filing.csvFromRows(rows));
  toast('Payroll detail exported');
}

function quarterBounds(periodKey) {
  const d = new Date(`${periodKey}T12:00:00`);
  const q = Math.floor(d.getMonth() / 3);
  const from = new Date(d.getFullYear(), q * 3, 1);
  const to = new Date(d.getFullYear(), q * 3 + 3, 0);
  return { from: filingIsoDate(from), to: filingIsoDate(to), quarter: q + 1, taxYear: d.getFullYear() };
}

function export941Worksheet() {
  const period = activePayrollPeriod();
  const bounds = quarterBounds(period.key);
  const people = state.users.filter(u => u.active && !String(u.taxStatus || '').includes('1099'));
  let wages = 0; let federal = 0; let socialSecurityWages = 0; let socialSecurity = 0; let medicare = 0;
  for (const user of people) {
    const keys = new Set(state.payrollEntries.filter(e => e.employeeId === user.id && e.periodKey >= bounds.from && e.periodKey <= bounds.to).map(e => e.periodKey));
    if (user.employmentType === 'Salary') {
      for (let d = new Date(`${bounds.from}T12:00:00`); d <= new Date(`${bounds.to}T12:00:00`); d.setDate(d.getDate() + 7)) {
        const key = weekPeriod(d).key;
        if (key >= bounds.from && key <= bounds.to) keys.add(key);
      }
    }
    let ssYtd = 0;
    for (const key of [...keys].sort()) {
      const stub = payStub(user, weekPeriod(new Date(`${key}T12:00:00`)), { ytdSocialSecurityWages: ssYtd });
      wages += stub.gross;
      federal += stub.federal;
      socialSecurityWages += stub.socialSecurityWages || 0;
      socialSecurity += stub.socialSecurity;
      medicare += stub.medicare;
      ssYtd += stub.socialSecurityWages || 0;
    }
  }
  const summary = {
    employeeCount: people.length,
    wages: Math.round(wages * 100) / 100,
    federal: Math.round(federal * 100) / 100,
    socialSecurityWages: Math.round(socialSecurityWages * 100) / 100,
    socialSecurityTotal: Math.round(socialSecurity * 2 * 100) / 100,
    medicareWages: Math.round(wages * 100) / 100,
    medicareTotal: Math.round(medicare * 2 * 100) / 100,
    totalTax: Math.round((federal + socialSecurity * 2 + medicare * 2) * 100) / 100,
  };
  const shop = shopFilingProfile();
  Filing.downloadTextFile(
    `mechpro-941-Q${bounds.quarter}-${bounds.taxYear}.csv`,
    Filing.form941WorksheetCsv(summary, { taxYear: bounds.taxYear, quarter: bounds.quarter, ein: shop.ein, employerName: shop.shopName }),
  );
  toast('Form 941 worksheet exported');
}

function exportEfw2Package() {
  const year = new Date().getFullYear();
  const shop = shopFilingProfile();
  const people = state.users.filter(u => u.active);
  const employees = people.map(user => {
    const ytd = ytdPayForUser(user, `${year}-12-31`);
    const parts = String(user.name || '').trim().split(/\s+/);
    const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
    return {
      name: user.name,
      firstName,
      lastName,
      ssn: user.ssn || '',
      wages: ytd.gross,
      federal: ytd.federal,
      socialSecurityWages: ytd.socialSecurityWages,
      socialSecurity: ytd.socialSecurity,
      medicareWages: ytd.gross,
      medicare: ytd.medicare,
      taxStatus: user.taxStatus,
    };
  });
  const w2Employees = employees.filter(e => !String(e.taxStatus || '').includes('1099'));
  const text = Filing.buildEfw2Text({ ein: shop.ein, name: shop.shopName, address: shop.address }, w2Employees, year);
  Filing.downloadTextFile(`mechpro-efw2-${year}.txt`, text, 'text/plain;charset=utf-8');
  toast('SSA EFW2 package downloaded');
}

function printEmployeeAnnualForm(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  const year = new Date().getFullYear();
  const ytd = ytdPayForUser(user, `${year}-12-31`);
  const shop = shopFilingProfile();
  if (String(user.taxStatus || '').includes('1099')) {
    Filing.open1099NecForm({
      taxYear: year,
      payer: { name: shop.shopName, address: shop.address, tin: shop.ein },
      recipient: { name: user.name, address: user.address || '', tinLast4: String(user.ssn || '').slice(-4) },
      nonemployeeCompensation: ytd.gross,
      federalTaxWithheld: ytd.federal,
    });
  } else {
    Filing.openW2Form({
      taxYear: year,
      employer: { name: shop.shopName, address: shop.address, ein: shop.ein },
      employee: { name: user.name, address: user.address || '', ssnLast4: String(user.ssn || '').slice(-4), employeeId: user.employeeId },
      wages: ytd.gross,
      federal: ytd.federal,
      socialSecurityWages: ytd.socialSecurityWages,
      socialSecurity: ytd.socialSecurity,
      medicareWages: ytd.gross,
      medicare: ytd.medicare,
      state: shop.state === 'TX' ? '' : shop.state,
      stateWages: shop.state === 'TX' ? 0 : ytd.gross,
      stateTax: ytd.state,
    });
  }
}

openEmployee = function (existing = null) {
  const roleOptions = ["technician", "office", "service_writer", "admin"]
    .map(role => `<option value="${role}" ${existing?.role === role ? "selected" : ""}>${roleLabel[role] || role}</option>`)
    .join("");
  const employmentOptions = ["Hourly", "Salary", "Contractor"]
    .map(value => `<option ${existing?.employmentType === value ? "selected" : ""}>${value}</option>`)
    .join("");
  const payFreqOptions = ["Weekly", "Biweekly", "Monthly"]
    .map(value => `<option ${(existing?.payFrequency || "Weekly") === value ? "selected" : ""}>${value}</option>`)
    .join("");
  const taxStatusOptions = ["W-2", "1099 Contractor"]
    .map(value => `<option ${(existing?.taxStatus || "W-2") === value ? "selected" : ""}>${value}</option>`)
    .join("");
  const filingStatus = existing?.w4FilingStatus || "single";
  const filingOptions = [
    ["single", "Single / Married filing separately"],
    ["married_joint", "Married filing jointly"],
    ["head_of_household", "Head of household"],
  ].map(([value, labelText]) => `<option value="${value}" ${filingStatus === value ? "selected" : ""}>${labelText}</option>`).join("");
  const step2 = Boolean(existing?.w4Step2Checkbox);
  showModal(`<form class="modal wide" id="employee-form"><div class="modal-head"><h2>${existing ? "Edit employee profile" : "Create employee profile"}</h2><button type="button" class="close" data-close>${icon("x")}</button></div><div class="modal-body">
<h3>Identity & access</h3><div class="form-grid">
<label>Employee name *<input name="name" required value="${employeeFormValue(existing, "name")}"/></label>
<label>Employee ID *<input name="employeeId" placeholder="EMP-005" required value="${employeeFormValue(existing, "employeeId")}"/></label>
<label>Job title<input name="title" value="${employeeFormValue(existing, "title")}"/></label>
<label>Department<input name="department" value="${employeeFormValue(existing, "department")}"/></label>
<label class="full" for="employee-email"><span class="field-label">Email address *</span><input id="employee-email" name="workEmail" type="text" inputmode="email" autocomplete="email" required value="${employeeFormValue(existing, "email")}" ${existing ? "readonly" : ""}/></label>
<label>Role<select name="role">${roleOptions}</select></label>
<label>Classification<select name="classification">${EMPLOYEE_CLASSIFICATIONS.map(item => `<option value="${item.id}" ${classificationFor(existing || { role: "technician" }) === item.id ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
<label class="full">Technician dispatch name <input name="techName" value="${employeeFormValue(existing, "techName")}"/></label>
</div>
<h3>Employment & pay</h3><div class="form-grid">
<label>Employment type<select name="employmentType">${employmentOptions}</select></label>
<label>Pay rate *<input name="payRate" type="number" min="0" step=".01" required value="${Number(existing?.payRate || 0)}"/></label>
<label>Pay plan<select name="payPlan">${PAY_PLANS.map(plan => `<option value="${plan.id}" ${(existing?.payPlan || "hourly") === plan.id ? "selected" : ""}>${plan.label}</option>`).join("")}</select></label>
<label>Commission %<input name="commissionPercent" type="number" min="0" max="100" step=".01" value="${Number(existing?.commissionPercent || 0)}"/></label>
<label>Pay frequency<select name="payFrequency">${payFreqOptions}</select></label>
<label>Start date<input name="startDate" type="date" value="${employeeFormValue(existing, "startDate", filingIsoDate())}"/></label>
<label>Tax status<select name="taxStatus">${taxStatusOptions}</select></label>
<label>Phone<input name="phone" type="tel" value="${employeeFormValue(existing, "phone")}"/></label>
<label class="full">Home address<input name="address" value="${employeeFormValue(existing, "address")}"/></label>
<label class="full">Emergency contact<input name="emergencyContact" value="${employeeFormValue(existing, "emergencyContact")}"/></label>
</div>
<h3>Form W-4 / withholding (Pub 15-T 2026)</h3><div class="form-grid">
<label>Filing status<select name="w4FilingStatus">${filingOptions}</select></label>
<label>Step 2 checkbox<select name="w4Step2Checkbox"><option value="false" ${step2 ? "" : "selected"}>No</option><option value="true" ${step2 ? "selected" : ""}>Yes — multiple jobs</option></select></label>
<label>Dependent credits (annual $<input name="w4DependentCredits" type="number" min="0" step="1" value="${Number(existing?.w4DependentCredits || 0)}"/></label>
<label>Other income (annual $<input name="w4OtherIncome" type="number" min="0" step="1" value="${Number(existing?.w4OtherIncome || 0)}"/></label>
<label>Deductions (annual $<input name="w4Deductions" type="number" min="0" step="1" value="${Number(existing?.w4Deductions || 0)}"/></label>
<label>Extra withholding / period $<input name="w4ExtraWithholding" type="number" min="0" step=".01" value="${Number(existing?.w4ExtraWithholding || 0)}"/></label>
<label>Pre-tax deduction / period $<input name="pretaxDeductionPerPeriod" type="number" min="0" step=".01" value="${Number(existing?.pretaxDeductionPerPeriod || 0)}"/></label>
<label>State WH rate %<input name="stateWithholdingRate" type="number" min="0" step=".01" value="${Number(existing?.stateWithholdingRate || 0)}"/><small>TX = 0</small></label>
<label>SSN last 4 (optional)<input name="ssn" maxlength="4" pattern="[0-9]*" placeholder="XXXX" value="${employeeFormValue(existing, "ssn")}"/></label>
</div>
<div class="ledger-note">${icon("info", 15)} Federal FIT uses IRS Pub 15-T (2026) percentage method from these W-4 fields. SSN is stored only for W-2/EFW2 packages — prefer last 4 until you are ready to file.</div>
</div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon(existing ? "save" : "user-plus", 14)} ${existing ? "Save employee" : "Create profile"}</button></div></form>`);
  if (!existing) document.querySelector("#employee-email")?.focus({ preventScroll: true });
  document.querySelector("#employee-form").onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    const email = String(existing?.email || data.workEmail || "").trim().toLowerCase();
    const button = form.querySelector("button.primary");
    if (!email || !email.includes("@")) { toast("Enter a valid work email address"); return; }
    if (!existing && state.users.some(user => String(user.email || "").toLowerCase() === email)) {
      toast("An employee profile already uses that email");
      return;
    }
    if (state.users.some(user => user.id !== existing?.id && user.employeeId === data.employeeId.trim())) {
      toast("An employee already uses that employee ID");
      return;
    }
    if (data.role === "technician" && !String(data.techName || "").trim()) {
      toast("Add the technician dispatch name");
      return;
    }
    if (button) button.disabled = true;
    try {
      const saved = await saveEmployeeRecord(existing, data);
      closeModal();
      toast(`${saved.name} profile ${existing ? "updated" : "created"}`);
      render();
    } catch (error) {
      toast(error.message || "Employee could not be saved");
    } finally {
      if (button) button.disabled = false;
    }
  };
};

const bindFilingCore = bindExpandedFeatures;
bindExpandedFeatures = function () {
  bindFilingCore();
  document.querySelectorAll('[data-tax-preset]').forEach(button => {
    button.onclick = () => {
      const presets = filingPeriodPresets();
      const p = presets[button.dataset.taxPreset];
      if (!p) return;
      const form = document.querySelector('#tax-report-form');
      if (form) {
        form.elements.from.value = p.from;
        form.elements.to.value = p.to;
      }
    };
  });
  const taxReportForm = document.querySelector('#tax-report-form');
  if (taxReportForm && !taxReportForm.dataset.filingBound) {
    taxReportForm.dataset.filingBound = '1';
    taxReportForm.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const data = Object.fromEntries(new FormData(event.target));
      await generateTaxReportFromForm(data.from, data.to);
      render();
    }, { capture: true });
  }
  document.querySelector('#export-tax-csv')?.addEventListener('click', exportSalesTaxCsv);
  document.querySelector('#export-tx-webfile')?.addEventListener('click', exportTexasWebfilePackage);
  document.querySelector('#open-filing-center')?.addEventListener('click', () => { filingCenterOpen = true; render(); });
  document.querySelector('#close-filing-center')?.addEventListener('click', () => { filingCenterOpen = false; render(); });
  document.querySelectorAll('[data-taxpkg-preset]').forEach(button => {
    button.onclick = () => {
      const presets = filingPeriodPresets();
      taxPackageRange = presets[button.dataset.taxpkgPreset];
      render();
    };
  });
  document.querySelector('#taxpkg-apply')?.addEventListener('click', () => {
    taxPackageRange = {
      from: document.querySelector('#taxpkg-from')?.value,
      to: document.querySelector('#taxpkg-to')?.value,
    };
    render();
  });
  document.querySelector('#taxpkg-export-pl')?.addEventListener('click', exportTaxPackagePl);
  document.querySelector('#taxpkg-export-exp')?.addEventListener('click', exportTaxPackageExpenses);
  document.querySelector('#taxpkg-print')?.addEventListener('click', () => window.print());
  document.querySelector('#payroll-prev')?.addEventListener('click', () => {
    const period = activePayrollPeriod();
    const d = new Date(`${period.key}T12:00:00`);
    d.setDate(d.getDate() - 7);
    payrollPeriodKey = weekPeriod(d).key;
    render();
  });
  document.querySelector('#payroll-next')?.addEventListener('click', () => {
    const period = activePayrollPeriod();
    const d = new Date(`${period.key}T12:00:00`);
    d.setDate(d.getDate() + 7);
    payrollPeriodKey = weekPeriod(d).key;
    render();
  });
  document.querySelector('#payroll-jump')?.addEventListener('change', event => {
    payrollPeriodKey = weekPeriod(new Date(`${event.target.value}T12:00:00`)).key;
    render();
  });
  document.querySelector('#payroll-export-detail')?.addEventListener('click', exportPayrollDetail);
  document.querySelector('#payroll-export-941')?.addEventListener('click', export941Worksheet);
  document.querySelector('#payroll-export-efw2')?.addEventListener('click', exportEfw2Package);
  document.querySelectorAll('[data-print-w2]').forEach(button => {
    button.onclick = () => printEmployeeAnnualForm(button.dataset.printW2);
  });

  const taxSettingsForm = document.querySelector('#tax-settings-form');
  if (taxSettingsForm && !taxSettingsForm.dataset.filingEnhanced) {
    taxSettingsForm.dataset.filingEnhanced = '1';
    const grid = taxSettingsForm.querySelector('.form-grid') || taxSettingsForm;
    if (!taxSettingsForm.querySelector('[name=ein]')) {
      grid.insertAdjacentHTML('beforeend', `
<label>Federal EIN<input name="ein" value="${escapeHtml(state.taxSettings.ein || '')}" placeholder="XX-XXXXXXX"/></label>
<label>TX taxpayer number<input name="texasTaxpayerNumber" value="${escapeHtml(state.taxSettings.texasTaxpayerNumber || '')}" placeholder="1-xxxxxxxxxx-x"/></label>
<label>WebFile number<input name="webfileNumber" value="${escapeHtml(state.taxSettings.webfileNumber || '')}" placeholder="RTxxxxxx"/></label>
<label class="full">Local jurisdictions JSON<small>Array of {code,name,kind,rate,required} — city/transit/county/SPD</small>
<textarea name="jurisdictionsJson" rows="4">${escapeHtml(JSON.stringify(state.taxSettings.jurisdictions || Filing.DEFAULT_TX_JURISDICTIONS, null, 0))}</textarea></label>`);
    }
    taxSettingsForm.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const data = Object.fromEntries(new FormData(event.target));
      let jurisdictions = null;
      try { jurisdictions = JSON.parse(data.jurisdictionsJson || 'null'); } catch { toast('Jurisdiction JSON is invalid'); return; }
      const rate = jurisdictions ? Filing.combinedSalesTaxRate(jurisdictions) : (Number(data.rate) || 0);
      const taxSettings = {
        state: data.state,
        taxId: String(data.taxId || '').trim(),
        rate,
        filingFrequency: data.filingFrequency,
        ein: String(data.ein || '').trim(),
        texasTaxpayerNumber: String(data.texasTaxpayerNumber || '').trim(),
        webfileNumber: String(data.webfileNumber || '').trim(),
        jurisdictions,
      };
      try {
        await saveShopEntity('shopsettings', { ...taxSettings, id: 'tax', updatedAt: now() });
        state.taxSettings = taxSettings;
        toast('Tax & e-file settings saved');
        render();
      } catch (error) {
        toast(error.message || 'Could not save tax settings');
      }
    }, { capture: true });
  }
};

/* === MECHPRO_FILING_OVERRIDES_END === */

function orderChoices() {
  return state.orders.map(order => `<option value="${escapeHtml(order.id)}">${escapeHtml(order.id)} · ${escapeHtml(order.vehicle)} · ${escapeHtml(order.customer)}</option>`).join("");
}

function bayHw() {
  if (!globalThis.__mechproBayHardware) globalThis.__mechproBayHardware = { adapters: null, status: null, snapshot: null, snapshotOrderId: "", busy: "", error: "", checked: false, refreshing: false };
  const hw = globalThis.__mechproBayHardware;
  hw.available = Boolean(window.mechproDesktop && window.mechproDiagnostics);
  return hw;
}

function bayLive() {
  const status = bayHw().status;
  return Boolean(status?.connected && !status?.simulator);
}

function bayNavLabel(item) {
  return (item.route === "obd" || item.route === "keys") && !bayLive() ? `${item.label} (Simulator)` : item.label;
}

async function refreshBayHardware(withAdapters = false) {
  const hw = bayHw();
  if (!hw.available) return;
  try {
    if (withAdapters || !hw.adapters) {
      const listed = await window.mechproDiagnostics.listAdapters();
      hw.adapters = (listed?.adapters || []).filter(adapter => adapter.id !== "simulator");
    }
    hw.status = await window.mechproDiagnostics.getConnectionStatus();
    hw.error = "";
  } catch (error) {
    hw.error = error.message || "The diagnostics host is not available.";
  }
  hw.checked = true;
}

function bayPerformer() {
  const user = currentUser() || {};
  return { id: user.id || "", name: user.name || "", email: user.email || "", role: user.role || "" };
}

async function recordBayAudit(event) {
  try { await apiFetch("/diagnostics/audit", { method: "POST", body: JSON.stringify(event) }); } catch (error) { console.error("Could not record diagnostics audit", error); }
}

function bayHardwarePanel() {
  const hw = bayHw();
  if (!hw.available) return `<div class="messaging-status idle">${icon("monitor", 17)}<div><strong>Simulator</strong><span>Live OBD-II and key work run in the MechPro Windows app with a J2534 adapter such as the TOPDON RLink X7. In the browser this bay uses the bench simulator.</span></div></div>`;
  const status = hw.status || {};
  if (bayLive()) return `<div class="messaging-status ready">${icon("plug-zap", 17)}<div><strong>Live: ${escapeHtml(status.adapterName || "J2534 adapter")}</strong><span>${escapeHtml(status.protocol || "ISO15765")} · ${escapeHtml(String(status.voltage ?? "?"))} V at the DLC</span></div><button class="ghost" type="button" id="bay-disconnect"${hw.busy ? " disabled" : ""}>Disconnect</button></div>`;
  const adapters = hw.adapters || [];
  const choices = adapters.map(adapter => `<option value="${escapeAttr(adapter.id)}"${adapter.usable === false ? " disabled" : ""}>${escapeHtml(adapter.name)} · ${escapeHtml(adapter.vendor || "")}${adapter.bitness ? ` · ${escapeHtml(adapter.bitness)}-bit` : ""}${adapter.usable === false ? " (wrong driver bitness)" : ""}</option>`).join("");
  const empty = `<p>No J2534 driver found. Install RLink Platform and the TOPDON J2534 driver, plug the RLink X7 into USB and the vehicle, then refresh.</p>`;
  const canConnect = adapters.some(adapter => adapter.usable !== false) && !hw.busy;
  return `<section class="data-panel bay-hardware"><h3>J2534 adapter</h3>${hw.error ? `<p class="form-error">${escapeHtml(hw.error)}</p>` : ""}${adapters.length ? `<div class="form-grid"><label class="full">Adapter<select id="bay-adapter">${choices}</select></label></div>` : empty}<div class="job-actions"><button class="primary" type="button" id="bay-connect"${canConnect ? "" : " disabled"}>${icon("plug", 14)} ${hw.busy === "connect" ? "Connecting..." : "Connect"}</button><button class="ghost" type="button" id="bay-refresh"${hw.busy ? " disabled" : ""}>${icon("refresh-cw", 14)} Refresh</button></div><p class="ledger-note">Until an adapter is connected, this bay runs the bench simulator.</p></section>`;
}

function obdLiveSection() {
  const hw = bayHw();
  const snap = hw.snapshot;
  const order = state.orders.find(item => item.id === hw.snapshotOrderId);
  const vinWarning = snap && order?.vin && snap.vin && normalizeVin(order.vin) !== normalizeVin(snap.vin)
    ? `<div class="messaging-status idle">${icon("triangle-alert", 17)}<div><strong>VIN mismatch</strong><span>The vehicle reports ${escapeHtml(snap.vin)}, but ${escapeHtml(order.id)} lists ${escapeHtml(order.vin)}.</span></div></div>`
    : "";
  const codes = (label, list) => `<p><b>${label}:</b> ${list?.length ? list.map(code => `<span class="mono">${escapeHtml(code)}</span>`).join(", ") : "none"}</p>`;
  const readings = (snap?.readings || []).map(reading => `<tr><td>${escapeHtml(reading.name)}</td><td class="mono">${escapeHtml(reading.value === null || reading.value === undefined ? "-" : String(reading.value))} ${escapeHtml(reading.unit || "")}</td></tr>`).join("");
  const mil = snap?.milOn === true ? "ON" : snap?.milOn === false ? "off" : "unknown";
  const result = snap
    ? `<section class="data-panel"><h3>${snap.simulator ? "Simulator" : "Live"} scan · ${escapeHtml(snap.adapterName || "J2534 adapter")}</h3><p class="mono">VIN ${escapeHtml(snap.vin || "not reported")}</p><p>Check engine light: <b>${mil}</b>${snap.reportedDtcCount !== undefined && snap.reportedDtcCount !== null ? ` · ECU reports ${escapeHtml(String(snap.reportedDtcCount))} stored` : ""}</p>${codes("Stored", snap.storedDtcs)}${codes("Pending", snap.pendingDtcs)}${codes("Permanent", snap.permanentDtcs)}${readings ? `<table><thead><tr><th>Reading</th><th>Value</th></tr></thead><tbody>${readings}</tbody></table>` : ""}${(snap.errors || []).length ? `<ul class="ledger-note">${snap.errors.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}<p class="ledger-note">${escapeHtml(snap.protocol || "")} · read ${escapeHtml(new Date(snap.readAt || Date.now()).toLocaleString())}</p><div class="job-actions"><button class="ghost" type="button" id="obd-live-clear"${hw.busy || !snap.responded ? " disabled" : ""}>${icon("eraser", 14)} Clear codes...</button></div></section>`
    : "";
  return `${vinWarning}<form class="form-grid" id="obd-live-form"><label class="full">Repair order<select name="orderId" required>${orderChoices() || `<option value="">No repair orders</option>`}</select></label><div class="full"><button class="primary" type="submit"${hw.busy ? " disabled" : ""}>${icon("activity", 14)} ${hw.busy === "scan" ? "Reading vehicle..." : "Read vehicle"}</button></div></form>${result}`;
}

function obdBay() {
  const live = bayLive();
  const latest = [...state.diagnosticSessions].reverse()[0];
  const latestTitle = latest?.mode === "live" ? "Latest live record" : "Latest simulated scan";
  const result = latest ? `<section class="data-panel"><h3>${latestTitle}</h3><p>${escapeHtml(latest.label || "")}</p><p class="mono">${escapeHtml(latest.vin || "")} · ${escapeHtml(latest.vehicle || "")}</p><ul>${(latest.dtcs || []).map(dtc => `<li><b>${escapeHtml(dtc.code)}</b> ${escapeHtml(dtc.description || "")}</li>`).join("")}</ul>${latest.readiness ? `<p>Readiness: ${escapeHtml(Object.entries(latest.readiness).map(([name, value]) => `${name} ${value}`).join(" · "))}</p>` : ""}${latest.performedBy?.name ? `<p class="ledger-note">By ${escapeHtml(latest.performedBy.name)}</p>` : ""}</section>` : `<div class="home-empty"><p>No scans yet.</p></div>`;
  const simulator = `<div class="messaging-status idle">${icon("info", 17)}<div><strong>Simulator</strong><span>These readings are sample data, not a connected adapter.</span></div></div><form class="form-grid" id="obd-scan-form"><label class="full">Repair order<select name="orderId" required>${orderChoices() || `<option value="">No repair orders</option>`}</select></label><div class="full"><button class="primary" type="submit">${icon("activity", 14)} Run simulated scan</button></div></form>`;
  const subtitle = live
    ? "Generic OBD-II over the connected J2534 adapter: VIN, live data, and stored, pending and permanent codes."
    : "Bench simulator until a J2534 adapter is connected in the MechPro Windows app.";
  return shell(`${heading("Diagnostics", live ? "OBD bay" : "OBD bay (Simulator)", subtitle, false)}${bayHardwarePanel()}${live ? obdLiveSection() : simulator}${result}`);
}

function keyProgrammingBay() {
  const live = bayLive();
  const rows = [...state.keyJobs].reverse().map(job => `<tr><td>${escapeHtml(job.operation)}</td><td class="mono">${escapeHtml(job.roNumber || "")}</td><td>${escapeHtml(job.vehicle || "")}</td><td>${job.simulated ? "Simulator" : "Live"}</td><td>${escapeHtml(job.performedBy?.name || "")}</td><td>${escapeHtml(job.result ? `${job.result}: ${job.message || ""}` : job.message || "")}</td></tr>`).join("");
  const modes = `<option value="simulator">Simulator</option><option value="live"${live ? "" : " disabled"}>Live (J2534 adapter)${live ? "" : " - connect an adapter first"}</option>`;
  return shell(`${heading("Authorized keys", live ? "Key programming" : "Key programming (Simulator)", "Identify, add, program, or test a key only when this vehicle has a signed repair order.", false)}<div class="messaging-status idle">${icon("shield", 17)}<div><strong>Signed repair order required</strong><span>Live jobs also need the connected vehicle's VIN to match the repair order and a confirmation before anything is written. Every live session is logged. Immobilizer bypass, cloning, and rolling-code requests are refused.</span></div></div>${bayHardwarePanel()}<form class="form-grid" id="key-job-form"><label class="full">Repair order<select name="orderId" required>${orderChoices() || `<option value="">No repair orders</option>`}</select></label><label>Operation<select name="operation">${KEY_OPERATIONS.map(item => `<option value="${item.id}">${item.label}</option>`).join("")}</select></label><label>Mode<select name="mode">${modes}</select></label><label class="full">Notes<textarea name="notes" rows="3" placeholder="Customer authorization notes"></textarea></label><div class="full"><button class="primary" type="submit">${icon("key", 14)} ${live ? "Start key job" : "Record key job"}</button></div></form><div class="data-panel"><table><thead><tr><th>Operation</th><th>RO</th><th>Vehicle</th><th>Mode</th><th>By</th><th>Result</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No key jobs recorded.</td></tr>`}</tbody></table></div>`);
}

async function rememberBayRecord(type, collection, record) {
  const list = state[collection];
  const index = list.findIndex(item => item.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
  save();
  try { await saveShopEntity(type, record); } catch (error) { console.error(`Could not sync ${type}`, error); }
}

async function runLiveObdScan(orderId) {
  const hw = bayHw();
  const order = state.orders.find(item => item.id === orderId);
  if (!order) { toast("Select a repair order"); return; }
  hw.busy = "scan";
  render();
  try {
    const snap = await window.mechproDiagnostics.obdSnapshot();
    hw.snapshot = snap;
    hw.snapshotOrderId = order.id;
    const dtcs = [
      ...(snap.storedDtcs || []).map(code => ({ code, description: "Stored" })),
      ...(snap.pendingDtcs || []).map(code => ({ code, description: "Pending" })),
      ...(snap.permanentDtcs || []).map(code => ({ code, description: "Permanent" })),
    ];
    await rememberBayRecord("diagnosticsessions", "diagnosticSessions", {
      id: `scan-${Date.now()}`,
      orderId: order.id,
      customer: order.customer,
      vehicle: order.vehicle,
      mode: snap.simulator ? "simulator" : "live",
      label: `${snap.simulator ? "Simulator" : "Live"} scan via ${snap.adapterName || "J2534 adapter"}`,
      vin: snap.vin || "",
      roVin: order.vin || "",
      milOn: snap.milOn ?? null,
      dtcs,
      readings: snap.readings || [],
      errors: snap.errors || [],
      adapter: snap.adapterName || "",
      performedBy: bayPerformer(),
      scannedAt: snap.readAt || now(),
    });
    toast(snap.responded ? "Vehicle read" : "No reply from the vehicle");
  } catch (error) {
    hw.error = error.message || "Scan failed";
    toast(hw.error);
  }
  hw.busy = "";
  await refreshBayHardware();
  render();
}

function openObdClearConfirm() {
  const hw = bayHw();
  const snap = hw.snapshot;
  const order = state.orders.find(item => item.id === hw.snapshotOrderId);
  if (!snap || !order) { toast("Read the vehicle first"); return; }
  showModal(`<form class="modal" id="obd-clear-form"><div class="modal-head"><div><span class="mono">${escapeHtml(order.id)}</span><h2>Clear trouble codes?</h2></div><button class="close" type="button" data-close aria-label="Close">${icon("x", 18)}</button></div><p>This sends OBD-II mode 04 to <b>${escapeHtml(snap.vin || order.vehicle || "the vehicle")}</b>. It erases stored and pending codes, freeze-frame data and readiness monitors, so the vehicle may fail an emissions inspection until the monitors run again. Permanent codes are not cleared.</p><label class="check"><input type="checkbox" name="engineOff" required> Engine is off and ignition is on</label><label class="check"><input type="checkbox" name="understood" required> I understand what gets erased</label><div class="modal-actions"><button class="ghost" type="button" data-close>Cancel</button><button class="primary" type="submit">Clear codes</button></div></form>`);
  document.querySelector("#obd-clear-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    if (!form.get("engineOff") || !form.get("understood")) { toast("Tick both boxes to clear codes"); return; }
    closeModal();
    hw.busy = "clear";
    render();
    const before = [...(snap.storedDtcs || []), ...(snap.pendingDtcs || [])];
    try {
      await window.mechproDiagnostics.obdClearDtcs({ confirmed: true });
      await rememberBayRecord("diagnosticsessions", "diagnosticSessions", {
        id: `clear-${Date.now()}`,
        kind: "clear",
        orderId: order.id,
        customer: order.customer,
        vehicle: order.vehicle,
        mode: snap.simulator ? "simulator" : "live",
        label: "Codes cleared (OBD-II mode 04)",
        vin: snap.vin || "",
        dtcs: before.map(code => ({ code, description: "Cleared" })),
        adapter: snap.adapterName || "",
        performedBy: bayPerformer(),
        scannedAt: now(),
      });
      await recordBayAudit({ kind: "obd.clear_dtcs", orderId: order.id, vin: snap.vin || "", cleared: before, adapter: snap.adapterName || "", simulator: Boolean(snap.simulator) });
      toast("Codes cleared. Reading the vehicle again.");
      hw.busy = "";
      await runLiveObdScan(order.id);
      return;
    } catch (error) {
      toast(error.message || "Could not clear codes");
    }
    hw.busy = "";
    render();
  });
}

async function startLiveKeyJob(data) {
  const order = state.orders.find(item => item.id === data.orderId);
  const hw = bayHw();
  const steps = [];
  const step = (name, detail = "") => steps.push({ at: now(), step: name, detail: String(detail || "").slice(0, 500) });
  const procedure = liveKeyProcedureFor(data.operation);
  let vehicleVin = "";
  let authorization = null;
  let saved = false;
  const saveSession = async (result, message) => {
    if (saved) return;
    saved = true;
    const record = keyAuditRecord({
      id: `key-${Date.now()}`,
      order,
      user: bayPerformer(),
      operation: data.operation,
      procedure,
      vehicleVin,
      adapter: hw.status?.adapterName || "",
      authorization,
      notes: data.notes,
      steps,
      result,
      message,
      now: now(),
    });
    await rememberBayRecord("keyprogrammingjobs", "keyJobs", record);
    await recordBayAudit({ kind: "keys.session", ...record });
    render();
  };
  try {
    step("Live key job started", `${data.operation} on ${order?.id || "no repair order"}`);
    const vinResult = await window.mechproDiagnostics.readVin();
    vehicleVin = vinResult?.vin || "";
    step("Read VIN from vehicle", vehicleVin || "no VIN");
    authorization = assertLiveKeySession({ order, estimates: state.estimates, operation: data.operation, notes: data.notes, vehicleVin, deviceConnected: bayLive() });
    step("Signed repair order verified", `${authorization?.authorizationName || ""} ${authorization?.signedAt || ""}`.trim());
    if (!procedure) {
      if (data.operation === "identify") {
        const checks = [];
        for (const candidate of ["add_key", "program_remote", "all_keys_lost", "erase_keys"]) checks.push(await window.mechproDiagnostics.keyProcedureSupport({ procedure: candidate }));
        const summary = checks.map(check => `${check.procedure.replace(/_/g, " ")}: ${check.supported ? "supported" : "not supported"}`).join("; ");
        step("Checked live procedure support", summary);
        await saveSession("identified", checks.some(check => check.supported) ? summary : checks[0]?.reason || summary);
        toast("Vehicle identified. See the key job log for what is supported live.");
        return;
      }
      step("Operation not available live");
      await saveSession("not_supported", "Live key testing is not available yet. Use the manufacturer's software through the adapter.");
      toast("Live key testing is not available yet");
      return;
    }
    const support = await window.mechproDiagnostics.keyProcedureSupport({ procedure });
    step("Checked live procedure support", support?.reason || "");
    if (!support?.supported) {
      await saveSession("not_supported", support?.reason || "This procedure is not supported for this vehicle.");
      showModal(`<div class="modal"><div class="modal-head"><div><span class="mono">${escapeHtml(order.id)}</span><h2>Not supported for this vehicle</h2></div><button class="close" type="button" data-close aria-label="Close">${icon("x", 18)}</button></div><p>${escapeHtml(support?.reason || "MechPro cannot run this key procedure on this vehicle.")}</p><p class="ledger-note">Nothing was written to the vehicle. This attempt is in the key job log.</p><div class="modal-actions"><button class="primary" type="button" data-close>OK</button></div></div>`);
      return;
    }
    openLiveKeyConfirm({ order, authorization, vehicleVin, procedure, support, step, saveSession });
  } catch (error) {
    step("Blocked", error.message);
    await saveSession("blocked", error.message || "Key job blocked");
    toast(error.message || "Key job blocked");
  }
}

function openLiveKeyConfirm(ctx) {
  const { order, authorization, vehicleVin, procedure, support, step, saveSession } = ctx;
  showModal(`<form class="modal" id="key-live-confirm"><div class="modal-head"><div><span class="mono">${escapeHtml(order.id)}</span><h2>Confirm live key programming</h2></div><button class="close" type="button" data-close aria-label="Close">${icon("x", 18)}</button></div><dl class="detail-list"><dt>Procedure</dt><dd>${escapeHtml(procedure.replace(/_/g, " "))}</dd><dt>Vehicle</dt><dd>${escapeHtml(order.vehicle || "")}</dd><dt>VIN read from vehicle</dt><dd class="mono">${escapeHtml(vehicleVin)}</dd><dt>Customer</dt><dd>${escapeHtml(order.customer || "")}</dd><dt>Signed by</dt><dd>${escapeHtml(authorization?.authorizationName || "")}${authorization?.signedAt ? ` · ${escapeHtml(new Date(authorization.signedAt).toLocaleString())}` : ""}</dd></dl><p>This writes to the vehicle's immobilizer. Keep a battery maintainer connected and do not unplug the adapter until it finishes.</p><label class="full">Type the last 6 characters of the VIN<input name="vinTail" autocomplete="off" required maxlength="6"></label>${support.requiresVehiclePin ? `<label class="full">Immobilizer PIN the vehicle asks for<input name="pin" type="password" autocomplete="off" required></label>` : ""}<label class="check"><input type="checkbox" name="confirm" required> The customer authorized this key work on the signed repair order</label><div class="modal-actions"><button class="ghost" type="button" data-close>Cancel</button><button class="primary" type="submit">${icon("key", 14)} Program key</button></div></form>`);
  document.querySelectorAll("#key-live-confirm [data-close]").forEach(button => button.addEventListener("click", () => { step("Technician cancelled at confirmation"); void saveSession("cancelled", "Cancelled before anything was written."); }));
  document.querySelector("#key-live-confirm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    if (!keyConfirmationMatches(vehicleVin, form.get("vinTail"))) { toast("The last 6 VIN characters do not match the vehicle"); return; }
    if (!form.get("confirm")) { toast("Confirm the customer authorization"); return; }
    const pin = String(form.get("pin") || "").trim();
    closeModal();
    step("Technician confirmed", `VIN ending ${normalizeVin(form.get("vinTail"))}${pin ? ", PIN entered" : ""}`);
    try {
      const grant = await apiFetch("/diagnostics/authorize", { method: "POST", body: JSON.stringify({ vin: vehicleVin, procedure, mode: "live", orderId: order.id }) });
      if (!grant?.authorized || !grant.token) throw new Error(grant?.message || "Live key programming was not authorized");
      step("Authorization issued", grant.expiresAt ? `expires ${grant.expiresAt}` : "");
      const result = await window.mechproDiagnostics.programKey({ procedure, authorizationToken: grant.token, pin: pin || undefined });
      step("Procedure finished", JSON.stringify(result || {}));
      await saveSession("completed", `${procedure.replace(/_/g, " ")} completed`);
      toast("Key procedure completed");
    } catch (error) {
      step("Failed", error.message);
      await saveSession("failed", error.message || "Key procedure failed");
      toast(error.message || "Key procedure failed");
    }
  });
}

function bindShopOs() {
  document.querySelector("#bay-refresh")?.addEventListener("click", async () => {
    const hw = bayHw();
    hw.busy = "refresh";
    render();
    await refreshBayHardware(true);
    hw.busy = "";
    render();
  });
  document.querySelector("#bay-connect")?.addEventListener("click", async () => {
    const hw = bayHw();
    const adapterId = document.querySelector("#bay-adapter")?.value;
    if (!adapterId) return;
    hw.busy = "connect";
    hw.snapshot = null;
    render();
    try {
      await window.mechproDiagnostics.connect({ adapterId, protocol: "ISO15765" });
      await refreshBayHardware();
      toast("Adapter connected");
    } catch (error) {
      hw.error = error.message || "Could not connect to the adapter";
    }
    hw.busy = "";
    render();
  });
  document.querySelector("#bay-disconnect")?.addEventListener("click", async () => {
    const hw = bayHw();
    hw.busy = "disconnect";
    render();
    try { await window.mechproDiagnostics.disconnect(); } catch (error) { hw.error = error.message || "Could not disconnect"; }
    hw.snapshot = null;
    await refreshBayHardware();
    hw.busy = "";
    render();
  });
  document.querySelector("#obd-live-form")?.addEventListener("submit", event => {
    event.preventDefault();
    void runLiveObdScan(new FormData(event.target).get("orderId"));
  });
  document.querySelector("#obd-live-clear")?.addEventListener("click", openObdClearConfirm);
  document.querySelector("#obd-scan-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const order = state.orders.find(item => item.id === new FormData(event.target).get("orderId"));
    if (!order) { toast("Select a repair order"); return; }
    const scan = simulateObdScan(order);
    await rememberBayRecord("diagnosticsessions", "diagnosticSessions", { id: `scan-${Date.now()}`, orderId: order.id, customer: order.customer, performedBy: bayPerformer(), ...scan });
    toast("Simulated scan saved");
    render();
  });
  document.querySelector("#key-job-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (data.mode === "live") {
      await startLiveKeyJob(data);
      return;
    }
    const order = state.orders.find(item => item.id === data.orderId);
    try {
      assertKeyJobAllowed({ order, estimates: state.estimates, operation: data.operation, notes: data.notes });
      const result = simulateKeyJob({ operation: data.operation, vin: order.vin });
      const authorization = state.estimates.find(estimate => isRoAuthorizedForKeys(order, [estimate]));
      await rememberBayRecord("keyprogrammingjobs", "keyJobs", {
        id: `key-${Date.now()}`,
        orderId: order.id,
        roNumber: order.id,
        customer: order.customer,
        vehicle: order.vehicle,
        vin: order.vin,
        operation: data.operation,
        notes: String(data.notes || "").trim(),
        simulated: true,
        authorizationName: authorization?.authorizationName || "",
        performedBy: bayPerformer(),
        message: result.message,
        createdAt: now(),
      });
      toast("Key job recorded on the simulator");
      render();
    } catch (error) {
      toast(error.message || "Key job blocked");
    }
  });
}

const renderShopOsCore = render;
render = function () {
  if (currentUser() && (state.route === "obd" || state.route === "keys")) {
    const hw = bayHw();
    if (hw.available && !hw.checked && !hw.refreshing) {
      hw.refreshing = true;
      void refreshBayHardware(true).finally(() => { hw.refreshing = false; render(); });
    }
    const root = document.querySelector("#root");
    const markup = state.route === "obd" ? obdBay() : keyProgrammingBay();
    root.innerHTML = safeHtml(markup);
    lucide.createIcons();
    bind();
    bindExpandedFeatures();
    attachShopOperationsRoute();
    bindShopOs();
    return;
  }
  renderShopOsCore();
};

// --- Shop AI provider settings (optional bring-your-own Anthropic key) ---
let shopAiSettings = { loaded: false, loading: false };
function canManageShopAi() { return ["admin", "owner"].includes(currentUser()?.role || "") }
async function loadShopAiSettings(force = false) {
  if (shopAiSettings.loading || (shopAiSettings.loaded && !force)) return;
  shopAiSettings = { ...shopAiSettings, loading: true };
  try { shopAiSettings = { ...(await apiFetch("/settings/ai")), loaded: true, loading: false } }
  catch { shopAiSettings = { hasKey: false, loaded: true, loading: false, unavailable: true } }
  if (state.route === "settings") render();
}
const settingsShopAiCore = settings;
settings = function () { const page = settingsShopAiCore(); if (isOfflineDesktop()) return page; return page.replace("</main>", `${shopAiPanelHtml(shopAiSettings, { canManage: canManageShopAi(), escapeHtml, icon })}</main>`) };
const bindShopAiCore = bind;
bind = function () {
  bindShopAiCore();
  if (state.route !== "settings" || !currentUser() || isOfflineDesktop()) return;
  if (!shopAiSettings.loaded) void loadShopAiSettings();
  document.querySelector("#shop-ai-key-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.target, button = form.querySelector("button[type=submit]"), apiKey = String(new FormData(form).get("apiKey") || "").trim();
    if (!apiKey) return;
    button.disabled = true; button.textContent = "Checking key...";
    try {
      const result = await apiFetch("/settings/ai", { method: "PUT", body: JSON.stringify({ apiKey }) });
      form.reset();
      shopAiSettings = { ...result, loaded: true, loading: false };
      toast(result.warning ? `Claude key saved. ${result.warning}` : "Claude key saved. MechPro AI now uses Claude for this shop.");
      render();
    } catch (error) { button.disabled = false; button.textContent = shopAiSettings.hasKey ? "Replace key" : "Save key"; toast(error.message || "Could not save the Anthropic key") }
  });
  document.querySelector("#shop-ai-remove-key")?.addEventListener("click", async event => {
    if (!confirm("Remove this shop's Anthropic key? MechPro AI will go back to Cloudflare AI (included).")) return;
    event.currentTarget.disabled = true;
    try {
      const result = await apiFetch("/settings/ai", { method: "DELETE" });
      shopAiSettings = { ...result, loaded: true, loading: false };
      toast("Anthropic key removed. Using Cloudflare AI (included).");
      render();
    } catch (error) { toast(error.message || "Could not remove the Anthropic key"); render() }
  });
};
const apiFetchShopAiNoticeCore = apiFetch;
apiFetch = async function (path, options = {}) { const result = await apiFetchShopAiNoticeCore(path, options); if (String(path).startsWith("/ai/assistant") && result?.notice) { toast(result.notice); shopAiSettings = { ...shopAiSettings, loaded: false } } return result };

void startApp();
