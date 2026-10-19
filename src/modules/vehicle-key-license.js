import { authorizePurpose, deviceIdForPublicKey, deviceProofMessage, sha256Hex } from '../shared/license-proof.js';
import { uploadFileToStorage } from './file-upload.js';

/**
 * Vehicle key licensing: device identity and HTML for the key app panel
 * (Key programming) and the platform console Licenses section.
 *
 * The device key is a non-extractable ECDSA P-256 key kept in IndexedDB, so the
 * unlock token is useless on any other machine even if the link leaks.
 */

export const LIVE_KEY_PROCEDURES = new Set(['add_key', 'all_keys_lost', 'program_remote', 'erase_keys']);
const TOKEN_PATTERN = /^sck1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DB_NAME = 'shopcrank-license-device';
const STORE = 'records';

export function requiresVehicleKeyLicense(body) {
  return body?.mode === 'live' && LIVE_KEY_PROCEDURES.has(String(body?.procedure || ''));
}

function openStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeOp(mode, run) {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const readRecord = key => storeOp('readonly', store => store.get(key));
const writeRecord = (key, value) => storeOp('readwrite', store => store.put(value, key));
const deleteRecord = key => storeOp('readwrite', store => store.delete(key));

export async function loadDeviceIdentity() {
  const existing = await readRecord('device');
  if (existing?.privateKey && existing.publicKey && existing.deviceId) return existing;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const publicKey = btoa(String.fromCharCode(...spki));
  const identity = { privateKey: pair.privateKey, publicKey, deviceId: await deviceIdForPublicKey(publicKey), createdAt: new Date().toISOString() };
  await writeRecord('device', identity);
  return identity;
}

export const loadStoredUnlock = () => readRecord('unlock').then(value => value || null);
export const saveStoredUnlock = value => writeRecord('unlock', value);
export const clearStoredUnlock = () => deleteRecord('unlock');

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signDeviceProof(identity, purpose, subject, signedAt = Date.now()) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(deviceProofMessage({ purpose, subject, signedAt })),
  );
  return { signedAt, signature: base64Url(new Uint8Array(signature)) };
}

export async function issueRequestBody(identity, label) {
  return { publicKey: identity.publicKey, deviceId: identity.deviceId, label, ...(await signDeviceProof(identity, 'issue', identity.deviceId)) };
}

export async function redeemRequestBody(identity, token) {
  return { token, deviceId: identity.deviceId, ...(await signDeviceProof(identity, 'redeem', await sha256Hex(token))) };
}

export async function authorizeUnlock(identity, token, procedure, vin) {
  return { token, deviceId: identity.deviceId, ...(await signDeviceProof(identity, authorizePurpose(procedure, vin), await sha256Hex(token))) };
}

const PROOF_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

export async function uploadProof(file, { apiFetch, fetchImpl }) {
  if (!PROOF_TYPES.has(file.type)) throw new Error('Upload the proof as a PDF, PNG, JPEG, or WebP file');
  return uploadFileToStorage(file, 'license-proof', file.type, { apiFetch, fetchImpl });
}

/** Accepts the unlock URL (token in the #fragment) or a bare token. */
export function parseUnlockInput(value) {
  const text = String(value || '').trim();
  let candidate = text;
  const hashIndex = text.indexOf('#');
  if (hashIndex >= 0) candidate = new URLSearchParams(text.slice(hashIndex + 1)).get('token') || '';
  candidate = decodeURIComponent(candidate);
  return TOKEN_PATTERN.test(candidate) ? candidate : null;
}

/** Unverified read for display and staleness checks; the Worker is the authority. */
export function unlockTokenClaims(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
  } catch {
    return null;
  }
}

/** Whether the stored token still matches what the license server currently allows. */
export function storedUnlockState(stored, license, deviceId) {
  if (!stored?.token) return 'none';
  const claims = unlockTokenClaims(stored.token);
  if (!claims || !license || claims.lid !== license.id || claims.did !== deviceId) return 'stale';
  if (license.status !== 'active' || license.expired || license.thisDevice?.status !== 'active') return 'blocked';
  if (claims.tv !== license.tokenVersion || claims.exp * 1000 > Date.parse(license.expiresAt) || claims.exp * 1000 <= Date.now()) return 'stale';
  return stored.redeemedAt ? 'unlocked' : 'issued';
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '';
}

const STATUS_BADGE = { active: 'paid', suspended: 'estimate', revoked: 'overdue', pending: 'estimate', approved: 'paid', denied: 'overdue' };

function badge(status, label = status, escapeHtml) {
  return `<span class="badge ${STATUS_BADGE[status] || ''}">${escapeHtml(label)}</span>`;
}

function requestForm({ escapeHtml, icon }, previous) {
  return `<form class="form-grid" id="key-license-request-form"><label>Contact name *<input name="contactName" required maxlength="120" value="${escapeHtml(previous?.contactName || '')}"></label><label>Business name *<input name="businessName" required maxlength="160" value="${escapeHtml(previous?.businessName || '')}"></label><label>License or registration number<input name="licenseNumber" maxlength="120" placeholder="e.g. NASTF VSP LSID or state locksmith license" value="${escapeHtml(previous?.licenseNumber || '')}"></label><label>Computers to license<input name="requestedDevices" type="number" min="1" max="100" value="${escapeHtml(previous?.requestedDevices || 1)}"></label><label class="full">Proof of licensing *<textarea name="proofDetails" rows="3" required minlength="10" maxlength="4000" placeholder="Issuing body, license number, expiry, and anything ShopCrank should verify">${escapeHtml(previous?.proofDetails || '')}</textarea></label><label class="full">Proof document (PDF or image, optional)<input name="proofFile" type="file" accept="application/pdf,image/png,image/jpeg,image/webp"></label><div class="full"><button class="primary" type="submit">${icon('send', 14)} Submit license request</button></div></form>`;
}

/** Key app panel (Key programming page). */
export function keyLicensePanelHtml(view, { escapeHtml, icon }) {
  const head = `<div class="eyebrow">Vehicle key license</div>`;
  if (!view || view.loading) return `<section class="settings-panel key-license-panel" id="key-license-panel">${head}<p>Checking this device's key license…</p></section>`;
  if (view.error) return `<section class="settings-panel key-license-panel" id="key-license-panel">${head}<p>${escapeHtml(view.error)}</p><button class="secondary" type="button" id="key-license-refresh">${icon('refresh-cw', 14)} Try again</button></section>`;
  const { license, requests = [], canRequest } = view.status || {};
  const latest = requests[0];
  const deviceLine = view.deviceId ? `<p class="ledger-note">This device: <span class="mono">${escapeHtml(view.deviceId.slice(0, 12))}…</span></p>` : '';
  let body = '';
  if (!license || license.status === 'revoked') {
    const revoked = license?.status === 'revoked' ? `<div class="messaging-status idle">${icon('shield-x', 17)}<div><strong>License revoked</strong><span>Live key programming is locked. Submit a new request if you have renewed proof of licensing.</span></div></div>` : '';
    if (latest?.status === 'pending') {
      body = `${revoked}<div class="messaging-status idle">${icon('hourglass', 17)}<div><strong>Request under review</strong><span>Submitted ${escapeHtml(formatDate(latest.createdAt))} for ${escapeHtml(latest.businessName)}. ShopCrank reviews your proof and sets the license expiry.</span></div></div>`;
    } else {
      const denied = latest?.status === 'denied' ? `<div class="messaging-status idle">${icon('circle-x', 17)}<div><strong>Last request denied</strong><span>${escapeHtml(latest.decisionNote || 'No reason given')}</span></div></div>` : '';
      body = `${revoked}${denied}<p>Live key programming on this shop needs a vehicle key license from ShopCrank. Send proof that your shop is licensed for key and immobilizer work.</p>${canRequest ? requestForm({ escapeHtml, icon }, view.draft || latest) : '<p class="ledger-note">Ask your shop owner or admin to submit the license request.</p>'}`;
    }
  } else {
    const stateLabel = license.status === 'suspended' ? 'Suspended' : license.expired ? 'Expired' : 'Active';
    const summary = `<dl class="detail-list"><dt>License</dt><dd>${badge(license.expired ? 'revoked' : license.status, stateLabel, escapeHtml)}</dd><dt>Expires</dt><dd>${escapeHtml(formatDate(license.expiresAt))}</dd><dt>Licensed computers</dt><dd>${license.activeDevices} of ${license.maxDevices}</dd></dl>`;
    const unlockState = view.unlockState;
    const redeemForm = `<form class="form-grid" id="key-license-redeem-form"><label class="full">Redeem unlock link<input name="unlockLink" autocomplete="off" placeholder="Paste the unlock link or token for this device"></label><div class="full"><button class="secondary" type="submit">${icon('lock-open', 14)} Unlock this device</button></div></form>`;
    if (license.status !== 'active' || license.expired) {
      body = `${summary}<div class="messaging-status idle">${icon('lock', 17)}<div><strong>Live key programming is locked</strong><span>${license.status === 'suspended' ? 'ShopCrank suspended this license.' : 'This license has expired.'} Contact ShopCrank to restore it.</span></div></div>`;
    } else if (unlockState === 'unlocked') {
      body = `${summary}<div class="messaging-status idle">${icon('lock-open', 17)}<div><strong>This device is unlocked for live key programming</strong><span>Until ${escapeHtml(formatDate(license.expiresAt))}. Each key job is checked with ShopCrank and still needs a signed repair order and your confirmation.</span></div></div>`;
    } else if (unlockState === 'issued') {
      body = `${summary}<div class="messaging-status idle">${icon('link', 17)}<div><strong>Unlock link ready</strong><span>Opening the link does nothing by itself. Confirm below to unlock this device.</span></div></div><label class="full">Unlock link (works only on this device)<input readonly class="mono" id="key-license-url" value="${escapeHtml(view.unlockUrl || '')}"></label><div class="messaging-actions"><button class="primary" type="button" id="key-license-redeem">${icon('lock-open', 14)} Unlock this device</button><button class="secondary" type="button" id="key-license-copy">${icon('copy', 14)} Copy link</button></div>`;
    } else {
      const stale = unlockState === 'stale' ? `<p class="ledger-note">ShopCrank replaced or changed this device's unlock link. Get a new one.</p>` : '';
      const blocked = unlockState === 'blocked' || license.thisDevice?.status === 'revoked';
      body = blocked
        ? `${summary}<div class="messaging-status idle">${icon('lock', 17)}<div><strong>This device was removed from the license</strong><span>Contact ShopCrank to license this computer again.</span></div></div>`
        : `${summary}${stale}<div class="messaging-actions"><button class="primary" type="button" id="key-license-issue">${icon('key-round', 14)} Get unlock link for this device</button></div>${redeemForm}`;
    }
  }
  const busy = view.busy ? `<p class="ledger-note">${escapeHtml(view.busy)}</p>` : '';
  const failure = view.lastError ? `<p class="login-error" role="alert">${escapeHtml(view.lastError)}</p>` : '';
  return `<section class="settings-panel key-license-panel" id="key-license-panel">${head}${failure}${body}${deviceLine}${busy}</section>`;
}

function shortId(value) {
  return value ? `${String(value).slice(0, 10)}…` : '';
}

function auditDetail(detail = {}) {
  return Object.entries(detail).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(', ');
}

/** Platform console Licenses section. */
export function licenseAdminHtml(data, { escapeHtml, icon }) {
  if (!data) return `<p>Loading licenses…</p>`;
  const { licenses = [], requests = [], events = [], auditLicenseId = '' } = data;
  const pending = requests.filter(item => item.status === 'pending');
  const decided = requests.filter(item => item.status !== 'pending');
  const active = licenses.filter(item => item.status === 'active' && !item.expired).length;
  const uses = licenses.reduce((sum, item) => sum + item.useCount, 0);
  const kpis = `<div class="platform-kpis"><article><span>Pending requests</span><strong>${pending.length}</strong></article><article><span>Active licenses</span><strong>${active}</strong></article><article><span>Suspended / revoked</span><strong>${licenses.filter(item => item.status !== 'active').length}</strong></article><article><span>Total unlock uses</span><strong>${uses}</strong></article></div>`;
  const pendingRows = pending.map(item => `<tr><td><b>${escapeHtml(item.businessName)}</b><small class="mono">${escapeHtml(item.shopId)}</small></td><td><b>${escapeHtml(item.contactName)}</b><small>${escapeHtml(item.requesterEmail || '')}</small></td><td>${escapeHtml(item.proofDetails || '')}${item.licenseNumber ? `<small>License #: ${escapeHtml(item.licenseNumber)}</small>` : ''}${item.hasProofFile ? `<small><button class="mini-action" type="button" data-license-proof="${escapeHtml(item.id)}" data-file-name="${escapeHtml(item.proofFileName || 'license-proof')}">${icon('file-down', 13)} ${escapeHtml(item.proofFileName || 'Proof file')}</button></small>` : ''}</td><td>${item.requestedDevices}<small>${escapeHtml(formatDate(item.createdAt))}</small></td><td><div class="platform-row-actions"><button class="mini-action" type="button" data-license-approve="${escapeHtml(item.id)}" data-business="${escapeHtml(item.businessName)}" data-devices="${item.requestedDevices}">${icon('badge-check', 13)} Approve</button><button class="mini-action" type="button" data-license-deny="${escapeHtml(item.id)}" data-business="${escapeHtml(item.businessName)}">${icon('circle-x', 13)} Deny</button></div></td></tr>`).join('');
  const licenseRows = licenses.map(item => {
    const label = item.status === 'active' && item.expired ? 'Expired' : item.status;
    const devices = item.devices.map(device => `<small><span class="mono">${escapeHtml(shortId(device.deviceId))}</span> ${escapeHtml(device.label || '')} · ${escapeHtml(device.status)} · ${device.useCount} use${device.useCount === 1 ? '' : 's'}${device.status === 'active' && item.status !== 'revoked' ? ` <button class="mini-action" type="button" data-license-device-revoke="${escapeHtml(item.id)}" data-device="${escapeHtml(device.deviceId)}">${icon('unplug', 12)} Remove</button>` : ''}</small>`).join('');
    const statusAction = item.status === 'active'
      ? `<button class="mini-action" type="button" data-license-action="suspend" data-license="${escapeHtml(item.id)}" data-name="${escapeHtml(item.customerName)}">${icon('pause', 13)} Suspend</button>`
      : item.status === 'suspended' ? `<button class="mini-action" type="button" data-license-action="reactivate" data-license="${escapeHtml(item.id)}" data-name="${escapeHtml(item.customerName)}">${icon('play', 13)} Reactivate</button>` : '';
    const actions = item.status === 'revoked' ? '' : `<button class="mini-action" type="button" data-license-edit="${escapeHtml(item.id)}">${icon('calendar-clock', 13)} Edit expiry</button>${statusAction}<button class="mini-action" type="button" data-license-action="reissue" data-license="${escapeHtml(item.id)}" data-name="${escapeHtml(item.customerName)}">${icon('rotate-cw', 13)} Reissue token</button><button class="mini-action" type="button" data-license-action="revoke" data-license="${escapeHtml(item.id)}" data-name="${escapeHtml(item.customerName)}">${icon('shield-x', 13)} Revoke</button>`;
    return `<tr><td><b>${escapeHtml(item.customerName)}</b><small class="mono">${escapeHtml(item.shopId)}</small></td><td>${badge(item.expired && item.status === 'active' ? 'revoked' : item.status, label, escapeHtml)}<small>Token v${item.tokenVersion}</small></td><td><b>${escapeHtml(formatDate(item.expiresAt))}</b><small>${escapeHtml(item.expiresAt)}</small></td><td>${item.activeDevices} of ${item.maxDevices}${devices}</td><td><b>${item.useCount}</b><small>${item.lastUsedAt ? `Last ${escapeHtml(formatDateTime(item.lastUsedAt))}` : 'Never used'}</small></td><td><div class="platform-row-actions">${actions}<button class="mini-action" type="button" data-license-audit="${escapeHtml(item.id)}">${icon('scroll-text', 13)} Audit</button></div></td></tr>`;
  }).join('');
  const decidedRows = decided.slice(0, 25).map(item => `<tr><td><b>${escapeHtml(item.businessName)}</b><small class="mono">${escapeHtml(item.shopId)}</small></td><td>${badge(item.status, item.status, escapeHtml)}</td><td>${escapeHtml(item.decisionNote || '')}<small>${escapeHtml(item.decidedBy || '')} · ${escapeHtml(formatDateTime(item.decidedAt))}</small></td></tr>`).join('');
  const eventRows = events.map(item => `<tr><td class="mono">${escapeHtml(formatDateTime(item.createdAt))}</td><td><b>${escapeHtml(item.event)}</b></td><td class="mono">${escapeHtml(item.shopId || '')}<small>${escapeHtml(shortId(item.licenseId || item.requestId))}</small></td><td class="mono">${escapeHtml(shortId(item.deviceId))}</td><td>${escapeHtml(item.actorEmail || '')}</td><td>${escapeHtml(auditDetail(item.detail))}</td></tr>`).join('');
  return `${kpis}<div class="access-note platform-security">${icon('shield-check', 15)} Only platform owners can approve, edit, suspend, revoke, or reissue vehicle key licenses. Unlock tokens carry the license expiry, work until then, and are checked here on every use.</div><div class="platform-action-buttons"><button class="primary" type="button" id="license-grant">${icon('key-round', 15)} Grant license directly</button></div><h2>Pending requests</h2><div class="data-panel"><table><thead><tr><th>Shop</th><th>Contact</th><th>Proof</th><th>Computers</th><th>Decision</th></tr></thead><tbody>${pendingRows || '<tr><td colspan="5">No requests waiting for review.</td></tr>'}</tbody></table></div><h2>Licenses</h2><div class="data-panel"><table><thead><tr><th>Customer</th><th>Status</th><th>Expires</th><th>Devices</th><th>Uses</th><th>Actions</th></tr></thead><tbody>${licenseRows || '<tr><td colspan="6">No licenses yet.</td></tr>'}</tbody></table></div><h2>Audit log${auditLicenseId ? ` · <span class="mono">${escapeHtml(shortId(auditLicenseId))}</span> <button class="mini-action" type="button" id="license-audit-all">Show all</button>` : ''}</h2><div class="data-panel"><table><thead><tr><th>Time</th><th>Event</th><th>Shop / record</th><th>Device</th><th>By</th><th>Detail</th></tr></thead><tbody>${eventRows || '<tr><td colspan="6">No events.</td></tr>'}</tbody></table></div>${decidedRows ? `<h2>Decided requests</h2><div class="data-panel"><table><thead><tr><th>Shop</th><th>Decision</th><th>Note</th></tr></thead><tbody>${decidedRows}</tbody></table></div>` : ''}`;
}

/** Date input value (YYYY-MM-DD) for an ISO expiry. */
export function expiryInputValue(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}
