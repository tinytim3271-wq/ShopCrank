import {
  approvedEstimate,
  calculateEstimate,
  declinedEstimate,
  normalizeEstimateLine,
} from '../../src/modules/estimate-workflow.js';
import {
  approvalSummary,
  normalizeEstimateApproval,
} from '../../src/modules/estimate-approval.js';
import { HttpError, json, requestJson } from './http.mjs';

const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNATURE_LIMIT = 1024 * 1024;
const RESPONSE_BODY_LIMIT = 1536 * 1024;

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const money = value => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
}).format(Number(value) || 0);

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function entityTypeForDocument(type) {
  if (type === 'estimate') return 'orders';
  if (type === 'invoice') return 'invoices';
  throw new HttpError(400, 'Document type must be estimate or invoice');
}

async function entityRow(env, shopId, entityType, documentId) {
  return env.DB.prepare(`
    SELECT data_json, created_by, created_at, updated_at
    FROM entities
    WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
  `).bind(shopId, entityType, documentId).first();
}

function parseEntity(row) {
  if (!row?.data_json) return null;
  try {
    return JSON.parse(row.data_json);
  } catch {
    return null;
  }
}

function estimateAlreadyLocked(document) {
  return Boolean(document?.linesLockedAt || ['approved', 'declined'].includes(document?.estimateApproval?.status));
}

async function claimDocumentLink(env, linkId, result, timestamp) {
  const outcome = await env.DB.prepare(
    'UPDATE customer_document_links SET consumed_at = ?, result = ? WHERE id = ? AND consumed_at IS NULL',
  ).bind(timestamp, result, linkId).run();
  if (!outcome?.meta?.changes) {
    throw new HttpError(409, 'This link has already been used');
  }
}

async function invalidateSiblingDocumentLinks(env, link, result, timestamp) {
  // Email + SMS each mint a separate token; once one response commits, burn the rest
  // so a second device cannot present an unused link after the estimate is locked.
  await env.DB.prepare(`
    UPDATE customer_document_links
    SET consumed_at = ?, result = ?
    WHERE shop_id = ? AND document_type = ? AND document_id = ?
      AND id != ? AND consumed_at IS NULL
  `).bind(
    timestamp,
    result,
    link.shop_id,
    link.document_type,
    link.document_id,
    link.id,
  ).run();
}

export async function createCustomerDocumentLink(request, env, context) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!['admin', 'office', 'service_writer'].includes(context.role)) {
    throw new HttpError(403, 'This role cannot send customer documents');
  }
  const body = await requestJson(request);
  const documentType = String(body.documentType || '').toLowerCase();
  const documentId = String(body.documentId || '').trim();
  const entityType = entityTypeForDocument(documentType);
  if (!documentId) throw new HttpError(400, 'documentId is required');
  const document = parseEntity(await entityRow(env, context.shopId, entityType, documentId));
  if (!document) throw new HttpError(404, 'Document not found');
  if (documentType === 'estimate' && !(document.estimate?.lines || []).length) {
    throw new HttpError(409, 'Add estimate lines before sending this job card');
  }
  if (documentType === 'estimate' && estimateAlreadyLocked(document)) {
    throw new HttpError(409, 'This estimate is already locked after customer approval');
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
  await env.DB.prepare(`
    INSERT INTO customer_document_links
      (id, token_hash, shop_id, document_type, document_id, expires_at, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    tokenHash,
    context.shopId,
    documentType,
    documentId,
    expiresAt,
    now.toISOString(),
    context.userId,
  ).run();
  const url = new URL(`/api/customer-documents/${token}`, request.url);
  return json({ id, url: url.toString(), expiresAt, documentType, documentId }, 201);
}

async function linkRecord(env, token) {
  const tokenHash = await sha256(token);
  return env.DB.prepare(`
    SELECT id, shop_id, document_type, document_id, expires_at, consumed_at, result
    FROM customer_document_links
    WHERE token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();
}

function lineRows(document, type) {
  const source = type === 'estimate' ? document.estimate?.lines || [] : document.lines || [];
  return source.map((line, index) => {
    const item = normalizeEstimateLine(line, index);
    const detail = item.type === 'part'
      ? `${item.quantity} × ${money(item.unitPrice)}${item.inventorySku ? ` · ${escapeHtml(item.inventorySku)}` : ''}`
      : item.type === 'fee' ? `Flat fee · ${money(item.total)}` : `${item.hours.toFixed(2)} hr × ${money(item.laborRate)}`;
    const choices = type === 'estimate'
      ? `<fieldset class="decision"><legend>Choose this line</legend><label><input type="radio" name="decision-${escapeHtml(item.id)}" value="approved" checked> Approve</label><label><input type="radio" name="decision-${escapeHtml(item.id)}" value="declined"> Decline</label></fieldset>`
      : '';
    return `<article class="line" data-line-id="${escapeHtml(item.id)}">
      <div class="line-type">${item.type === 'part' ? 'Part' : item.type === 'fee' ? 'Fee' : 'Labor'}</div>
      <div><strong>${escapeHtml(item.description)}</strong><small>${escapeHtml(detail)}</small>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}</div>
      <b>${escapeHtml(money(item.total))}</b>
      ${choices}
    </article>`;
  }).join('');
}

function customerDocumentPage(link, document, nonce) {
  const type = link.document_type;
  const isEstimate = type === 'estimate';
  const estimate = isEstimate ? document.estimate || calculateEstimate([], 0) : document;
  const number = isEstimate ? document.estimateNumber || document.id : document.number;
  const savedApproval = isEstimate ? normalizeEstimateApproval(document.estimateApproval) : null;
  const complete = Boolean(link.consumed_at || (isEstimate && estimateAlreadyLocked(document)));
  const completedDetail = savedApproval?.status === 'approved'
    ? approvalSummary(savedApproval)
    : link.consumed_at
      ? `This ${type} was ${link.result || 'completed'} on ${new Date(link.consumed_at).toLocaleString()}.`
      : `This ${type} is no longer awaiting a response.`;
  const status = complete
    ? `<section class="notice complete"><strong>Response recorded</strong><p>${escapeHtml(completedDetail)}</p></section>`
    : '';
  const controls = complete ? '' : `
    <section class="signature">
      <label for="customer-name">Full name</label>
      <input id="customer-name" autocomplete="name" maxlength="100" required value="${escapeHtml(document.customer || '')}">
      <label>Signature</label>
      <canvas id="signature-pad" width="720" height="220" aria-label="Draw your signature"></canvas>
      <div class="signature-actions"><button type="button" class="secondary" id="clear-signature">Clear</button></div>
      <label class="consent"><input id="consent" type="checkbox" required> ${isEstimate ? 'I authorize the approved work and understand declined lines will not be performed.' : 'I acknowledge this invoice and the listed completed work.'}</label>
    </section>
    <p class="error" id="error" hidden></p>
    <div class="actions">
      ${isEstimate ? '<button type="button" class="decline" id="decline-estimate">Decline all</button>' : ''}
      <button type="button" class="approve" id="submit-signature">${isEstimate ? 'Sign & approve selected work' : 'Sign invoice'}</button>
    </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${isEstimate ? 'Estimate approval' : 'Invoice signature'} · MechPro</title>
  <style>
    :root{color-scheme:light;--ink:#14201c;--muted:#68766f;--paper:#fffefb;--line:#d9ddd8;--green:#1f654b;--deep:#162c24;--lime:#c8df59;--red:#a63f36}*{box-sizing:border-box}body{margin:0;padding:20px;color:var(--ink);background:#f3f1eb;font:15px/1.5 system-ui,sans-serif}.sheet{width:min(860px,100%);margin:auto;border:1px solid var(--line);border-radius:10px;background:var(--paper);box-shadow:0 18px 55px #182a221c;overflow:hidden}.head{padding:24px;color:#fff;background:var(--deep);border-top:6px solid var(--lime)}.head span{color:var(--lime);font-size:12px;font-weight:800;text-transform:uppercase}.head h1{margin:4px 0}.head p{margin:0;color:#c8d3ce}.meta,.totals,.signature,.notice{margin:18px;padding:18px;border:1px solid var(--line);border-radius:7px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px}.meta small,.line small{display:block;color:var(--muted)}.lines{display:grid;gap:10px;margin:18px}.line{display:grid;grid-template-columns:70px 1fr auto;gap:12px;align-items:start;padding:15px;border:1px solid var(--line);border-left:4px solid var(--green);border-radius:6px}.line-type{font-size:11px;font-weight:800;text-transform:uppercase;color:var(--green)}.line p{margin:5px 0 0;color:var(--muted);font-size:13px}.decision{grid-column:2/-1;display:flex;gap:18px;border:0;padding:8px 0 0}.decision legend{position:absolute;width:1px;height:1px;overflow:hidden}.decision label{font-weight:700}.totals{display:flex;justify-content:flex-end;gap:22px;align-items:end}.totals strong{font-size:24px}.signature{display:grid;gap:8px}.signature label{font-weight:800}.signature input[type=text],#customer-name{width:100%;padding:12px;border:1px solid var(--line);border-radius:5px;font:inherit}canvas{width:100%;height:190px;border:2px dashed #91a099;border-radius:6px;background:#fff;touch-action:none}.signature-actions{text-align:right}.consent{display:flex;align-items:flex-start;gap:9px;font-weight:600!important}.actions{display:flex;justify-content:flex-end;gap:10px;padding:0 18px 22px}button{min-height:44px;padding:0 17px;border-radius:5px;font-weight:800;cursor:pointer}.approve{border:1px solid var(--green);color:#fff;background:var(--green)}.decline{border:1px solid #d9aaa5;color:var(--red);background:#fff}.secondary{border:1px solid var(--line);background:#fff}.error{margin:0 18px 14px;padding:10px;color:var(--red);background:#f8e5e2}.complete{color:#24533e;background:#edf5ef}@media(max-width:600px){body{padding:0}.sheet{border:0;border-radius:0;min-height:100vh}.meta{grid-template-columns:1fr}.line{grid-template-columns:1fr auto}.line-type{grid-column:1/-1}.decision{grid-column:1/-1}.actions{flex-direction:column}.actions button{width:100%}}
  </style>
</head>
<body>
  <main class="sheet">
    <header class="head"><span>MechPro customer approval</span><h1>${isEstimate ? 'Estimate' : 'Invoice'} ${escapeHtml(number || '')}</h1><p>${escapeHtml(document.vehicle || '')}</p></header>
    ${status}
    <section class="meta"><div><small>Customer</small><strong>${escapeHtml(document.customer || '')}</strong></div><div><small>Work order</small><strong>${escapeHtml(document.id || document.ro || '')}</strong></div></section>
    <section class="lines">${lineRows(document, type)}</section>
    <section class="totals"><span>Subtotal<br><b>${escapeHtml(money(estimate.subtotal))}</b></span><span>Tax<br><b>${escapeHtml(money(estimate.tax))}</b></span><strong>Total<br>${escapeHtml(money(estimate.total ?? estimate.amount))}</strong></section>
    ${controls}
  </main>
  ${complete ? '' : `<script nonce="${nonce}">
    const pad=document.querySelector('#signature-pad'),ctx=pad.getContext('2d');let drawing=false,drawn=false;
    ctx.lineWidth=3;ctx.lineCap='round';ctx.strokeStyle='#14201c';
    const point=e=>{const r=pad.getBoundingClientRect();return{x:(e.clientX-r.left)*pad.width/r.width,y:(e.clientY-r.top)*pad.height/r.height}};
    pad.addEventListener('pointerdown',e=>{drawing=true;drawn=true;pad.setPointerCapture(e.pointerId);const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y)});
    pad.addEventListener('pointermove',e=>{if(!drawing)return;const p=point(e);ctx.lineTo(p.x,p.y);ctx.stroke()});
    pad.addEventListener('pointerup',()=>drawing=false);
    document.querySelector('#clear-signature').onclick=()=>{ctx.clearRect(0,0,pad.width,pad.height);drawn=false};
    const send=async action=>{
      const error=document.querySelector('#error'),name=document.querySelector('#customer-name').value.trim();
      if(action==='sign'&&(!name||!drawn||!document.querySelector('#consent').checked)){error.textContent='Enter your name, draw your signature, and confirm authorization.';error.hidden=false;return}
      const decisions={};document.querySelectorAll('[data-line-id]').forEach(row=>{const choice=row.querySelector('input[type=radio]:checked');if(choice)decisions[row.dataset.lineId]=choice.value});
      const response=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,authorizationName:name,signatureDataUrl:action==='sign'?pad.toDataURL('image/png'):'',decisions})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok){error.textContent=body.message||'Your response could not be saved. Please try again.';error.hidden=false;return}
      location.reload();
    };
    document.querySelector('#submit-signature').onclick=()=>send('sign');
    document.querySelector('#decline-estimate')?.addEventListener('click',()=>send('decline'));
  </script>`}
</body>
</html>`;
}

async function storeSignature(env, link, dataUrl) {
  if (!env.FILES) throw new HttpError(503, 'Signature storage is unavailable');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new HttpError(400, 'Draw a valid signature');
  const binary = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
  if (!binary.byteLength || binary.byteLength > SIGNATURE_LIMIT) throw new HttpError(400, 'Signature is too large');
  const key = `shops/${link.shop_id}/signatures/${crypto.randomUUID()}.png`;
  await env.FILES.put(key, binary, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { shopId: link.shop_id, documentType: link.document_type, documentId: link.document_id },
  });
  return key;
}

async function limitedResponseJson(request) {
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > RESPONSE_BODY_LIMIT) throw new HttpError(413, 'Customer response is too large');
  const text = await request.text();
  if (text.length > RESPONSE_BODY_LIMIT) throw new HttpError(413, 'Customer response is too large');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

async function saveEntity(env, link, document, {
  requireUnlockedEstimate = false,
  expectedUpdatedAt = null,
} = {}) {
  const casToken = expectedUpdatedAt || document.updatedAt || null;
  const updatedAt = new Date().toISOString();
  document.updatedAt = updatedAt;
  // Per-link claim is not enough when email + SMS mint two tokens for one RO:
  // both can pass the unlocked read, claim different link rows, and last-write
  // the order. Fail closed unless this UPDATE still sees an unlocked estimate.
  // Also CAS on updated_at so a concurrent staff line edit cannot be overwritten
  // by a customer approval that loaded a stale estimate snapshot.
  let sql = `
    UPDATE entities SET data_json = ?, updated_at = ?
    WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
  `;
  const binds = [
    JSON.stringify(document),
    updatedAt,
    link.shop_id,
    entityTypeForDocument(link.document_type),
    link.document_id,
  ];
  if (requireUnlockedEstimate) {
    sql += `
      AND COALESCE(json_extract(data_json, '$.linesLockedAt'), '') = ''
      AND COALESCE(json_extract(data_json, '$.estimateApproval.status'), '')
        NOT IN ('approved', 'declined')
    `;
    if (casToken) {
      sql += ' AND updated_at = ?';
      binds.push(casToken);
    }
  }
  const outcome = await env.DB.prepare(sql).bind(...binds).run();
  if (requireUnlockedEstimate && !outcome?.meta?.changes) {
    throw new HttpError(409, 'This estimate has already been approved or declined');
  }
}

async function recordResponse(request, env, link, document, expectedUpdatedAt = null) {
  if (link.consumed_at) throw new HttpError(409, 'This link has already been used');
  if (new Date(link.expires_at).getTime() <= Date.now()) throw new HttpError(410, 'This link has expired');
  if (link.document_type === 'estimate' && estimateAlreadyLocked(document)) {
    throw new HttpError(409, 'This estimate has already been approved or declined');
  }
  const body = await limitedResponseJson(request);
  const action = String(body.action || '');
  if (action === 'decline' && link.document_type === 'estimate') {
    const timestamp = new Date().toISOString();
    // Claim the one-time link before mutating the order so concurrent POSTs cannot both win.
    await claimDocumentLink(env, link.id, 'declined', timestamp);
    // Decline-all must mark every line declined and zero money; otherwise
    // pending lines stay billable and staff completion still invoices the full card.
    const declined = declinedEstimate(document.estimate || {});
    document.estimate = declined.estimate;
    document.total = declined.estimate.total;
    document.labor = declined.estimate.labor;
    document.laborHours = declined.estimate.laborHours;
    document.parts = declined.estimate.parts;
    document.tax = declined.estimate.tax;
    document.linesLockedAt = timestamp;
    document.estimateApproval = {
      status: 'declined',
      source: 'remote',
      respondedAt: timestamp,
      decisions: declined.decisions,
    };
    await saveEntity(env, link, document, {
      requireUnlockedEstimate: true,
      expectedUpdatedAt,
    });
    await invalidateSiblingDocumentLinks(env, link, 'declined', timestamp);
    return json({ ok: true, status: 'declined' });
  }
  if (action !== 'sign') throw new HttpError(400, 'Choose sign or decline');
  const authorizationName = String(body.authorizationName || '').trim().slice(0, 100);
  if (!authorizationName) throw new HttpError(400, 'Full name is required');
  const decisions = body.decisions && typeof body.decisions === 'object' ? body.decisions : {};
  let nextEstimate = null;
  if (link.document_type === 'estimate') {
    const lineIds = (document.estimate?.lines || [])
      .map((line, index) => normalizeEstimateLine(line, index).id);
    const missingDecision = lineIds.some(id => !['approved', 'declined'].includes(decisions[id]));
    if (missingDecision) throw new HttpError(400, 'Approve or decline every estimate line');
    if (Object.keys(decisions).some(id => !lineIds.includes(id))) {
      throw new HttpError(400, 'Approval decisions do not match this estimate');
    }
    nextEstimate = approvedEstimate(document.estimate || {}, decisions);
    if (!nextEstimate.approvedLineCount) throw new HttpError(400, 'Approve at least one line or decline the estimate');
  }
  const signatureKey = await storeSignature(env, link, body.signatureDataUrl);
  const timestamp = new Date().toISOString();
  const signature = {
    type: 'signature',
    authorizationName,
    signatureKey,
    signedAt: timestamp,
    approvedAt: timestamp,
    recordedBy: { id: 'customer', name: authorizationName, email: '' },
    source: 'remote',
  };
  const result = link.document_type === 'estimate' ? 'approved' : 'signed';
  // Claim before write: only the winning request may mutate the document.
  await claimDocumentLink(env, link.id, result, timestamp);
  if (link.document_type === 'estimate') {
    document.estimate = nextEstimate;
    document.total = nextEstimate.total;
    document.labor = nextEstimate.labor;
    document.laborHours = nextEstimate.laborHours;
    document.parts = nextEstimate.parts;
    document.tax = nextEstimate.tax;
    document.status = document.estimateRevisionPreviousStatus || 'approved';
    document.linesLockedAt = timestamp;
    document.estimateApproval = { status: 'approved', ...signature, decisions };
    document.estimateRevisionPending = false;
    delete document.estimateRevisionPreviousStatus;
    await saveEntity(env, link, document, {
      requireUnlockedEstimate: true,
      expectedUpdatedAt,
    });
    await invalidateSiblingDocumentLinks(env, link, result, timestamp);
  } else {
    document.signature = signature;
    await saveEntity(env, link, document);
    await invalidateSiblingDocumentLinks(env, link, result, timestamp);
  }
  return json({ ok: true, status: result });
}

export async function handleCustomerDocument(request, env, token) {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new HttpError(404, 'Document link not found');
  const link = await linkRecord(env, token);
  if (!link) throw new HttpError(404, 'Document link not found');
  if (!link.consumed_at && new Date(link.expires_at).getTime() <= Date.now()) throw new HttpError(410, 'This link has expired');
  const row = await entityRow(env, link.shop_id, entityTypeForDocument(link.document_type), link.document_id);
  const document = parseEntity(row);
  if (!document) throw new HttpError(404, 'Document not found');
  if (request.method === 'POST') {
    return recordResponse(request, env, link, document, row.updated_at || document.updatedAt || null);
  }
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const nonce = randomToken();
  return new Response(customerDocumentPage(link, document, nonce), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'nonce-${nonce}'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}
