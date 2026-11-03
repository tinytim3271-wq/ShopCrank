import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ambassadorOptions,
  ambassadorsHtml,
  creditFormHtml,
  formatCents,
  lastMonth,
  payoutReportDialogHtml,
  saleSourceLabel,
  salesQuery,
  statementHtml,
} from './ambassadors.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<i data-lucide="${name}"></i>`;
const helpers = { escapeHtml, icon };

const ambassadors = [
  { id: 'a1', ambassadorNumber: 'AMB-0001', referralCode: 'TX4K9P', name: 'Jane <Rivera>', email: 'jane@example.test', phone: '', status: 'approved', territory: 'Amarillo', salesCount: 3, activeCount: 2, pendingCents: 4000, paidCents: 2000 },
  { id: 'a2', ambassadorNumber: 'AMB-0002', referralCode: 'LBK22Z', name: 'Sam', email: 'sam@example.test', status: 'suspended', territory: '', salesCount: 0, activeCount: 0, pendingCents: 0, paidCents: 0 },
  { id: 'a3', ambassadorNumber: 'AMB-0003', referralCode: 'NEW333', name: 'Ava', email: 'ava@example.test', status: 'applied', territory: '', salesCount: 0, activeCount: 0, pendingCents: 0, paidCents: 0 },
];

function tiers(counts) {
  const rates = { solo: 1000, shop: 2000, shop_pro: 4000, enterprise: 10000 };
  return Object.fromEntries(Object.entries(rates).map(([tier, rate]) => [tier, { count: counts[tier] || 0, rateCents: rate, subtotalCents: (counts[tier] || 0) * rate }]));
}
const sources = counts => Object.fromEntries(['shopcrank_online', 'ambassador_site', 'ambassador_referral', 'other'].map(source => [source, { count: counts[source] || 0, amountCents: (counts[source] || 0) * 1000 }]));

test('formatting helpers', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(saleSourceLabel('ambassador_site'), 'Ambassador site');
  assert.equal(saleSourceLabel(''), 'Unattributed');
  assert.equal(salesQuery({ ambassadorId: 'a1', source: '', from: '2026-10-01' }), '?ambassadorId=a1&from=2026-10-01');
  assert.equal(salesQuery({}), '');
  assert.equal(lastMonth(new Date('2026-01-15T00:00:00Z')), '2025-12');
});

test('ambassador picker hides suspended ambassadors unless already credited', () => {
  const options = ambassadorOptions(ambassadors, '', { escapeHtml });
  assert.match(options, /AMB-0001 · Jane &lt;Rivera&gt;/);
  assert.doesNotMatch(options, /AMB-0002/);
  assert.match(options, /AMB-0003 · Ava \(applied\)/);
  assert.match(ambassadorOptions(ambassadors, 'a2', { escapeHtml }), /value="a2" selected/);
});

test('tabs render ambassadors, sales filters, commission rates, and reports', () => {
  assert.equal(ambassadorsHtml(null, helpers), '<p>Loading ambassadors…</p>');
  const list = ambassadorsHtml({ tab: 'ambassadors', ambassadors }, helpers);
  assert.match(list, /TX4K9P/);
  assert.match(list, /data-amb-edit="a1"/);
  assert.match(list, /\$40\.00/);

  const sales = ambassadorsHtml({
    tab: 'sales', ambassadors, salesFilters: { source: 'ambassador_site', ambassadorId: 'none' },
    sales: [{ shopId: 's1', shopName: 'High Plains', planId: 'shop_pro', status: 'active', ambassadorNumber: 'AMB-0001', ambassadorName: 'Jane', saleSource: 'ambassador_site', soldBy: 'AMB-0001 · Jane', soldAt: '2026-10-04T00:00:00Z' }],
  }, helpers);
  assert.match(sales, /<option value="ambassador_site" selected>/);
  assert.match(sales, /<option value="none" selected>/);
  assert.match(sales, /Shop Pro/);
  assert.match(sales, /data-sale-credit="s1"/);

  const commissions = ambassadorsHtml({
    tab: 'commissions', ledgerPeriod: '2026-10',
    rates: [{ planId: 'shop', tier: 'shop', monthlyCents: 2000 }],
    commissions: { lines: [{ period: '2026-10', ambassadorNumber: 'AMB-0001', ambassadorName: 'Jane', shopName: 'High Plains', tier: 'shop', saleSource: 'ambassador_referral', status: 'paid', checkNumber: '1001', amountCents: 2000 }], totals: { lines: 1, earnedCents: 2000, pendingCents: 0, paidCents: 2000 }, pagination: { page: 2, pageCount: 3, totalLines: 401 } },
  }, helpers);
  assert.match(commissions, /name="rate:shop" data-tier="shop" value="20\.00"/);
  assert.match(commissions, /Check 1001/);
  assert.match(commissions, /Page 2 of 3 · 401 lines/);
  assert.match(commissions, /data-ledger-page="1"/);

  const reports = ambassadorsHtml({ tab: 'reports', schedule: '0 9 1 * *', reports: [{ period: '2026-10', periodLabel: 'October 2026', ambassadorCount: 2, grandTotalCents: 21000, paidCount: 1, generatedAt: '2026-11-01T09:00:00Z', generatedBy: 'cron', emailStatus: 'sent:admin@shopcrank.com' }] }, helpers);
  assert.match(reports, /data-report-view="2026-10"/);
  assert.match(reports, /1 of 2 paid/);
});

test('payout dialog shows tiers, sources, totals, and mark-paid only for unpaid ambassadors', () => {
  const janeTiers = tiers({ solo: 1, shop: 3, shop_pro: 1 });
  const totalTiers = tiers({ solo: 1, shop: 3, shop_pro: 1, enterprise: 1 });
  for (const tierData of [janeTiers.shop, totalTiers.shop]) {
    tierData.rateBreakdown = [
      { rateCents: 1000, count: 1, subtotalCents: 1000 },
      { rateCents: 2500, count: 2, subtotalCents: 5000 },
    ];
  }
  const report = {
    period: '2026-10', periodLabel: 'October 2026', generatedAt: '2026-11-01T09:00:00Z', generatedBy: 'cron', paidCents: 11000,
    ambassadors: [
      { ambassadorId: 'a1', ambassadorNumber: 'AMB-0001', referralCode: 'TX4K9P', name: 'Jane', tiers: janeTiers, sources: sources({ ambassador_site: 2, ambassador_referral: 2, shopcrank_online: 1 }), totalCents: 11000, payout: { checkNumber: '1001', paidOn: '2026-11-03' } },
      { ambassadorId: 'a2', ambassadorNumber: 'AMB-0002', referralCode: 'LBK22Z', name: 'Marco', tiers: tiers({ enterprise: 1 }), sources: sources({ ambassador_referral: 1 }), totalCents: 10000, payout: null },
    ],
    totals: { grandTotalCents: 21000, ambassadorCount: 2, tiers: totalTiers, sources: sources({ ambassador_site: 2, ambassador_referral: 3, shopcrank_online: 1 }) },
  };
  const html = payoutReportDialogHtml(report, { ...helpers, today: '2026-11-05' });
  assert.match(html, /Check 1001 · 2026-11-03/);
  assert.equal((html.match(/class="amb-pay-form"/g) || []).length, 1);
  assert.match(html, /data-ambassador="a2"/);
  assert.match(html, /value="2026-11-05"/);
  assert.match(html, /\$210\.00/);
  assert.match(html, /\$60\.00 @ Mixed \(\$10\.00, \$25\.00\)/);
  assert.match(html, /Ambassador site: 2 · Ambassador referral: 2/);
  assert.match(html, /id="amb-report-print"/);
  assert.match(html, /id="amb-report-pdf"/);
});

test('credit dialog and statement escape content and show the audit trail', () => {
  const credit = creditFormHtml(
    { shopId: 's1', shopName: 'A&B Auto', ambassadorId: 'a1', saleSource: 'ambassador_site', soldBy: 'AMB-0001 · Jane' },
    ambassadors,
    [{ createdAt: '2026-10-05T12:00:00Z', previousAmbassadorNumber: '', newAmbassadorNumber: 'AMB-0001', previousSource: '', newSource: 'ambassador_site', changedBy: 'signup:o@a.test', reason: 'Self-signup' }],
    helpers,
  );
  assert.match(credit, /A&amp;B Auto/);
  assert.match(credit, /value="a1" selected/);
  assert.match(credit, /— → AMB-0001/);
  assert.match(credit, /name="reason" required/);
  const statement = statementHtml({
    ambassador: { ambassadorNumber: 'AMB-0001', name: 'Jane', referralCode: 'TX4K9P' },
    totals: { earnedCents: 3000, paidCents: 1000, pendingCents: 2000 },
    lines: [{ period: '2026-10', shopName: 'High Plains', tier: 'enterprise', saleSource: 'ai_agent', status: 'pending', amountCents: 10000 }],
    pagination: { page: 1, pageCount: 2, totalLines: 201 },
  }, helpers);
  assert.match(statement, /Enterprise/);
  assert.match(statement, /AI agent/);
  assert.match(statement, /\$20\.00/);
  assert.match(statement, /data-statement-page="2"/);
});
