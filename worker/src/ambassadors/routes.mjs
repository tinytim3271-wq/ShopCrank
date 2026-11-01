// Ambassador program HTTP routes.
//
// Platform owner (super_admin):
//   GET/POST          /admin/ambassadors
//   GET/PUT/DELETE    /admin/ambassadors/:id
//   GET               /admin/ambassadors/:id/statement?from=YYYY-MM&to=YYYY-MM
//   GET               /admin/ambassador-sales?ambassadorId=&source=&from=&to=
//   GET               /admin/ambassador-sales/:shopId/log
//   POST              /admin/ambassador-sales/:shopId/attribution  { ambassadorId|null, saleSource, soldBy, reason }
//   GET/PUT           /admin/ambassador-commission-rates
//   GET               /admin/ambassador-commissions?period=&ambassadorId=&status=
//   POST              /admin/ambassador-commissions/generate        { period }
//   GET/POST          /admin/ambassador-payout-reports              POST { period }
//   GET               /admin/ambassador-payout-reports/:period[/print|/pdf]
//   POST              /admin/ambassador-payout-reports/:period/payouts/:ambassadorId { checkNumber, paidOn }
// Public:
//   POST /ambassadors/apply, GET /ambassadors/validate?code=, POST /ambassadors/statement { code, email }

import { HttpError, json, requestJson } from '../http.mjs';
import {
  SALE_SOURCES,
  applyAttribution,
  createAmbassador,
  getAmbassador,
  getAmbassadorByCode,
  isSaleSource,
  publicAmbassador,
  resolveAttribution,
  updateAmbassador,
} from './store.mjs';
import {
  generateCommissionLedger,
  listCommissionRates,
  listCommissions,
  periodHasEnded,
  requirePeriod,
  summarizeCommissions,
  updateCommissionRates,
} from './commissions.mjs';
import {
  AMBASSADOR_PAYOUT_CRON,
  generatePayoutReport,
  listPayoutReports,
  markAmbassadorPaid,
  notifyPayoutReport,
  payoutReportHtml,
  payoutReportPdf,
  reportWithPayouts,
} from './payout-report.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PUBLIC_RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 10 };

function requirePlatformOwner(context) {
  if (context?.role !== 'super_admin') throw new HttpError(403, 'Only the ShopCrank platform owner can manage ambassadors');
}

function saleView(row) {
  return {
    shopId: row.shop_id,
    shopName: row.shop_name || row.shop_id,
    ownerEmail: row.owner_email || '',
    planId: row.plan_id,
    status: row.status,
    accountStatus: row.subscription_status || '',
    suspended: Number(row.suspended || 0) === 1,
    saleSource: row.sale_source || '',
    soldBy: row.sold_by || '',
    referralCode: row.referral_code || '',
    ambassadorId: row.sold_by_ambassador_id || '',
    ambassadorNumber: row.ambassador_number || '',
    ambassadorName: row.ambassador_name || '',
    soldAt: row.sold_at || '',
    attributedAt: row.attributed_at || '',
  };
}

export async function listSales(env, { ambassadorId = '', source = '', from = '', to = '' } = {}) {
  const where = [];
  const args = [];
  if (ambassadorId === 'none') where.push('s.sold_by_ambassador_id IS NULL');
  else if (ambassadorId) { where.push('s.sold_by_ambassador_id = ?'); args.push(ambassadorId); }
  if (source) {
    if (!isSaleSource(source) && source !== 'unattributed') throw new HttpError(400, `source must be one of: ${SALE_SOURCES.join(', ')}`);
    if (source === 'unattributed') where.push('s.sale_source IS NULL');
    else { where.push('s.sale_source = ?'); args.push(source); }
  }
  const soldAt = 'COALESCE(s.attributed_at, s.created_at, acct.created_at, s.updated_at)';
  if (from) {
    if (!DATE_PATTERN.test(from)) throw new HttpError(400, 'from must be YYYY-MM-DD');
    where.push(`${soldAt} >= ?`); args.push(`${from}T00:00:00.000Z`);
  }
  if (to) {
    if (!DATE_PATTERN.test(to)) throw new HttpError(400, 'to must be YYYY-MM-DD');
    where.push(`${soldAt} <= ?`); args.push(`${to}T23:59:59.999Z`);
  }
  const rows = await env.DB.prepare(`
    SELECT s.*, ${soldAt} AS sold_at, acct.shop_name, acct.owner_email, acct.subscription_status, acct.suspended,
           a.ambassador_number, a.name AS ambassador_name
    FROM subscriptions s
    LEFT JOIN accounts acct ON acct.shop_id = s.shop_id
    LEFT JOIN ambassadors a ON a.id = s.sold_by_ambassador_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY sold_at DESC
    LIMIT 1000
  `).bind(...args).all();
  return (rows.results || []).map(saleView);
}

async function attributionLog(env, shopId) {
  const rows = await env.DB.prepare(`
    SELECT l.*, prev.ambassador_number AS previous_number, next.ambassador_number AS new_number
    FROM ambassador_attribution_log l
    LEFT JOIN ambassadors prev ON prev.id = l.previous_ambassador_id
    LEFT JOIN ambassadors next ON next.id = l.new_ambassador_id
    WHERE l.shop_id = ? ORDER BY l.created_at DESC LIMIT 200
  `).bind(shopId).all();
  return (rows.results || []).map(row => ({
    id: row.id,
    shopId: row.shop_id,
    previousAmbassadorId: row.previous_ambassador_id || '',
    previousAmbassadorNumber: row.previous_number || '',
    newAmbassadorId: row.new_ambassador_id || '',
    newAmbassadorNumber: row.new_number || '',
    previousSource: row.previous_source || '',
    newSource: row.new_source || '',
    previousSoldBy: row.previous_sold_by || '',
    newSoldBy: row.new_sold_by || '',
    changedBy: row.changed_by,
    reason: row.reason || '',
    createdAt: row.created_at,
  }));
}

async function ambassadorList(env) {
  const rows = await env.DB.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.sold_by_ambassador_id = a.id) AS sales_count,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.sold_by_ambassador_id = a.id AND s.status = 'active') AS active_count,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM ambassador_commissions c WHERE c.ambassador_id = a.id AND c.status = 'pending') AS pending_cents,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM ambassador_commissions c WHERE c.ambassador_id = a.id AND c.status = 'paid') AS paid_cents
    FROM ambassadors a ORDER BY a.seq
  `).all();
  return (rows.results || []).map(row => ({
    ...publicAmbassador(row),
    salesCount: Number(row.sales_count || 0),
    activeCount: Number(row.active_count || 0),
    pendingCents: Number(row.pending_cents || 0),
    paidCents: Number(row.paid_cents || 0),
  }));
}

async function statementFor(env, ambassadorId, { from = '', to = '' } = {}) {
  const lines = await listCommissions(env, { ambassadorId, from, to });
  return { lines, totals: summarizeCommissions(lines) };
}

function downloadName(period, extension) {
  return `shopcrank-ambassador-payouts-${period}.${extension}`;
}

async function handlePayoutReports(request, env, context, rest) {
  const [period, view, ambassadorId] = rest;
  if (!period) {
    if (request.method === 'GET') return json({ schedule: AMBASSADOR_PAYOUT_CRON, reports: await listPayoutReports(env) });
    if (request.method === 'POST') {
      const body = await requestJson(request);
      const { report, created } = await generatePayoutReport(env, requirePeriod(body.period), { generatedBy: context.email || context.userId });
      const email = created && body.notify === true ? await notifyPayoutReport(env, report) : null;
      return json({ created, email, report: await reportWithPayouts(env, report.period) }, created ? 201 : 200);
    }
    throw new HttpError(405, 'Method not allowed');
  }
  requirePeriod(period);
  if (view === 'payouts' && ambassadorId && request.method === 'POST') {
    const body = await requestJson(request);
    const payout = await markAmbassadorPaid(env, period, ambassadorId, { checkNumber: body.checkNumber, paidOn: body.paidOn, actor: context.email || context.userId });
    return json({ period, ambassadorId, payout });
  }
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const report = await reportWithPayouts(env, period);
  if (!report) throw new HttpError(404, 'No payout report has been generated for that month');
  if (!view) return json(report);
  if (view === 'print') {
    const autoPrint = new URL(request.url).searchParams.get('print') === '1';
    return new Response(payoutReportHtml(report, { autoPrint }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
  }
  if (view === 'pdf') {
    const { bytes } = payoutReportPdf(report);
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${downloadName(period, 'pdf')}"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  throw new HttpError(404, 'Not found');
}

export async function handleAmbassadorAdmin(request, env, context, segments) {
  requirePlatformOwner(context);
  const [, section, ...rawRest] = segments;
  const rest = rawRest.map(item => decodeURIComponent(item));
  const url = new URL(request.url);
  const actor = context.email || context.userId;

  if (section === 'ambassadors') {
    const [id, view] = rest;
    if (!id) {
      if (request.method === 'GET') return json({ ambassadors: await ambassadorList(env) });
      if (request.method === 'POST') {
        const body = await requestJson(request);
        const created = await createAmbassador(env, body, { actor, status: body.status || 'approved' });
        return json({ ambassador: publicAmbassador(created) }, 201);
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const ambassador = await getAmbassador(env, id);
    if (!ambassador) throw new HttpError(404, 'Ambassador not found');
    if (view === 'statement' && request.method === 'GET') {
      return json({
        ambassador: publicAmbassador(ambassador),
        ...(await statementFor(env, ambassador.id, { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' })),
      });
    }
    if (view) throw new HttpError(404, 'Not found');
    if (request.method === 'GET') {
      return json({
        ambassador: publicAmbassador(ambassador),
        sales: await listSales(env, { ambassadorId: ambassador.id }),
        ...(await statementFor(env, ambassador.id)),
      });
    }
    if (request.method === 'PUT') {
      return json({ ambassador: publicAmbassador(await updateAmbassador(env, ambassador.id, await requestJson(request))) });
    }
    if (request.method === 'DELETE') {
      const used = await env.DB.prepare(`
        SELECT (SELECT COUNT(*) FROM subscriptions WHERE sold_by_ambassador_id = ?)
             + (SELECT COUNT(*) FROM ambassador_commissions WHERE ambassador_id = ?)
             + (SELECT COUNT(*) FROM ambassador_attribution_log WHERE previous_ambassador_id = ? OR new_ambassador_id = ?) AS n
      `).bind(ambassador.id, ambassador.id, ambassador.id, ambassador.id).first();
      if (Number(used?.n || 0) > 0) throw new HttpError(409, 'This ambassador has sales history. Suspend them instead of deleting.');
      await env.DB.prepare('DELETE FROM ambassadors WHERE id = ?').bind(ambassador.id).run();
      return json({ deleted: true, id: ambassador.id });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (section === 'ambassador-sales') {
    const [shopId, view] = rest;
    if (!shopId && request.method === 'GET') {
      const filters = Object.fromEntries(['ambassadorId', 'source', 'from', 'to'].map(key => [key, url.searchParams.get(key) || '']));
      return json({ sales: await listSales(env, filters), filters });
    }
    if (shopId && view === 'log' && request.method === 'GET') return json({ shopId, log: await attributionLog(env, shopId) });
    if (shopId && view === 'attribution' && request.method === 'POST') {
      const body = await requestJson(request);
      const reason = String(body.reason || '').trim();
      if (!reason) throw new HttpError(400, 'A reason is required when changing sale credit');
      if (!isSaleSource(body.saleSource)) throw new HttpError(400, `saleSource must be one of: ${SALE_SOURCES.join(', ')}`);
      const resolved = await resolveAttribution(env, { ambassadorId: body.ambassadorId || '', saleSource: body.saleSource, trusted: true });
      const result = await applyAttribution(env, shopId, {
        ambassador: resolved.ambassador,
        saleSource: resolved.saleSource,
        soldBy: body.soldBy,
        changedBy: actor,
        reason,
      });
      const [sale] = (await listSales(env, {})).filter(item => item.shopId === shopId);
      return json({ ...result, sale, log: await attributionLog(env, shopId) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (section === 'ambassador-commission-rates') {
    if (request.method === 'GET') return json({ rates: await listCommissionRates(env) });
    if (request.method === 'PUT') {
      const body = await requestJson(request);
      return json({ rates: await updateCommissionRates(env, body.rates, { actor }) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (section === 'ambassador-commissions') {
    if (!rest[0] && request.method === 'GET') {
      const filters = Object.fromEntries(['period', 'ambassadorId', 'status', 'from', 'to'].map(key => [key, url.searchParams.get(key) || '']));
      const lines = await listCommissions(env, filters);
      return json({ lines, totals: summarizeCommissions(lines) });
    }
    if (rest[0] === 'generate' && request.method === 'POST') {
      const body = await requestJson(request);
      const period = requirePeriod(body.period);
      if (!periodHasEnded(period) && body.allowOpenMonth !== true) throw new HttpError(400, 'Generate commissions after the month ends');
      return json(await generateCommissionLedger(env, period, { accruedVia: 'manual' }));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (section === 'ambassador-payout-reports') return handlePayoutReports(request, env, context, rest);
  throw new HttpError(404, 'Not found');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function enforcePublicLimit(request, env, name) {
  const ip = String(request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return;
  const windowStart = Math.floor(Date.now() / PUBLIC_RATE_LIMIT.windowMs) * PUBLIC_RATE_LIMIT.windowMs;
  const row = await env.DB.prepare(`
    INSERT INTO auth_rate_limits (bucket, window_start, request_count) VALUES (?, ?, 1)
    ON CONFLICT(bucket, window_start) DO UPDATE SET request_count = request_count + 1
    RETURNING request_count
  `).bind(`${name}:${await sha256Hex(ip)}`, windowStart).first();
  if (Number(row?.request_count || 0) > PUBLIC_RATE_LIMIT.max) {
    throw new HttpError(429, 'Too many requests from this network. Try again later.', { 'Retry-After': '3600' });
  }
}

const field = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

/** Fields from the ambassador application form. */
export function normalizeApplication(body = {}) {
  const name = field(body.name || [body.firstName, body.lastName].filter(Boolean).join(' '), 120);
  return {
    contact: {
      name,
      email: field(body.email, 254).toLowerCase(),
      phone: field(body.phone, 40),
      city: field(body.city, 120),
      state: field(body.state, 60),
    },
    experience: field(body.experience),
    why: field(body.why || body.motivation),
    territory: field(body.territory, 200),
    socialReach: field(body.socialReach || body.social_reach, 1000),
    submittedAt: new Date().toISOString(),
  };
}

export async function handleAmbassadorPublic(request, env, segments, { verifyTurnstile } = {}) {
  const action = segments[1] || '';
  if (action === 'apply' && request.method === 'POST') {
    const body = await requestJson(request);
    if (verifyTurnstile) await verifyTurnstile(request, env, body.turnstileToken || body['cf-turnstile-response']);
    await enforcePublicLimit(request, env, 'ambassador-apply');
    const application = normalizeApplication(body);
    if (!application.why || !application.territory) throw new HttpError(400, 'Tell us your territory and why you want to be an ambassador');
    const existing = await env.DB.prepare('SELECT id FROM ambassadors WHERE email = ? COLLATE NOCASE LIMIT 1').bind(application.contact.email).first();
    if (existing) throw new HttpError(409, 'We already have an application for this email. We will be in touch.');
    const created = await createAmbassador(env, {
      name: application.contact.name,
      email: application.contact.email,
      phone: application.contact.phone,
      territory: application.territory,
    }, { actor: 'application', status: 'applied', application });
    return json({ ok: true, ambassadorNumber: created.ambassador_number, status: created.status, message: 'Thanks! Your application is in review.' }, 201);
  }
  if (action === 'validate' && request.method === 'GET') {
    const ambassador = await getAmbassadorByCode(env, new URL(request.url).searchParams.get('code'));
    const valid = Boolean(ambassador && ambassador.status === 'approved');
    return json({ valid, code: valid ? ambassador.referral_code : null, name: valid ? String(ambassador.name).split(/\s+/)[0] : null });
  }
  if (action === 'statement' && request.method === 'POST') {
    await enforcePublicLimit(request, env, 'ambassador-statement');
    const body = await requestJson(request);
    const ambassador = await getAmbassadorByCode(env, body.code);
    const email = field(body.email, 254).toLowerCase();
    if (!ambassador || !email || String(ambassador.email).toLowerCase() !== email) {
      throw new HttpError(404, 'No ambassador matches that code and email');
    }
    const { lines, totals } = await statementFor(env, ambassador.id);
    return json({
      ambassador: {
        ambassadorNumber: ambassador.ambassador_number,
        referralCode: ambassador.referral_code,
        name: ambassador.name,
        status: ambassador.status,
      },
      totals,
      lines: lines.map(line => ({
        period: line.period,
        shopName: line.shopName,
        tier: line.tier,
        saleSource: line.saleSource,
        amountCents: line.amountCents,
        status: line.status,
        paidAt: line.paidAt,
      })),
    });
  }
  throw new HttpError(404, 'Not found');
}

