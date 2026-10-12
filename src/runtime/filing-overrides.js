/* Loaded only as a text fragment by scripts/inject-filing-overrides.mjs — do not import. */
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
<label class="full">Technician dispatch name <input name="techName" value="${employeeFormValue(existing, "techName")}"/></label>
</div>
<h3>Employment & pay</h3><div class="form-grid">
<label>Employment type<select name="employmentType">${employmentOptions}</select></label>
<label>Pay rate *<input name="payRate" type="number" min="0" step=".01" required value="${Number(existing?.payRate || 0)}"/></label>
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
