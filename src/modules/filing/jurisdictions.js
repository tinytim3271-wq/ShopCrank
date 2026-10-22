/**
 * Multi-jurisdiction sales tax matrix (state + local districts).
 * Texas local codes are 7 digits: 2=city, 3=transit, 4=county, 5=SPD, 6=combined.
 */

function roundCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * The state line only.
 *
 * A new shop has no outlet address yet, so its local city, transit, and county
 * districts are unknown. Shipping placeholder districts ("Example City", 1%)
 * would make the sales-tax filing report list a jurisdiction the shop does not
 * actually owe, and would silently inflate the default rate to 8.25%. The
 * owner adds their own local districts from the Texas Comptroller lookup in
 * Shop settings → Tax before the first filing report.
 */
export const DEFAULT_TX_JURISDICTIONS = [
  { code: '2001000', name: 'State of Texas', kind: 'state', rate: 6.25, required: true },
];

/** The local districts a Texas shop still has to supply. */
export const MISSING_LOCAL_TX_KINDS = Object.freeze(['city', 'transit', 'county', 'combined']);

/** True when the shop has not yet entered its local tax districts. */
export function needsLocalJurisdictions(jurisdictions) {
  const list = Array.isArray(jurisdictions) ? jurisdictions : [];
  const hasLocal = list.some(j => j && j.kind !== 'state');
  return !hasLocal;
}

/**
 * @param {Array<{ code: string, name: string, kind: string, rate: number, required?: boolean }>} jurisdictions
 */
export function combinedSalesTaxRate(jurisdictions) {
  return roundCents((jurisdictions || []).reduce((sum, j) => sum + Number(j.rate || 0), 0));
}

export function matchesJurisdictionRate(rate, jurisdictions) {
  return roundCents(rate) === combinedSalesTaxRate(jurisdictions);
}

/**
 * Allocate taxable sales across jurisdictions for a Texas list-filer style supplement.
 * Local tax applies to the same taxable base (subject to local caps in real returns —
 * ShopCrank reports the taxable amount against each active jurisdiction for WebFile entry).
 *
 * @param {number} taxableSales
 * @param {Array<{ code: string, name: string, kind: string, rate: number, required?: boolean }>} jurisdictions
 */
export function buildJurisdictionSupplement(taxableSales, jurisdictions) {
  const taxable = roundCents(taxableSales);
  const rows = (jurisdictions || []).map(j => {
    const rate = Number(j.rate || 0);
    const tax = roundCents(taxable * (rate / 100));
    return {
      code: String(j.code || ''),
      name: j.name || '',
      kind: j.kind || 'local',
      rate,
      amountSubjectToLocalTax: Math.round(taxable),
      taxDue: tax,
      required: Boolean(j.required),
    };
  });
  const stateRow = rows.find(r => r.kind === 'state');
  const localRows = rows.filter(r => r.kind !== 'state');
  return {
    taxableSales: taxable,
    stateTax: stateRow?.taxDue || 0,
    localTax: roundCents(localRows.reduce((s, r) => s + r.taxDue, 0)),
    totalTax: roundCents(rows.reduce((s, r) => s + r.taxDue, 0)),
    rows,
  };
}

/**
 * CSV for Texas Comptroller WebFile list supplement data entry / EDI prep.
 */
export function texasListSupplementCsv(supplement, meta = {}) {
  const header = [
    ['Texas sales tax list supplement (WebFile / EDI prep)'],
    ['Taxpayer number', meta.taxpayerNumber || ''],
    ['Outlet / location', meta.outlet || 'Primary'],
    ['Period from', meta.from || ''],
    ['Period to', meta.to || ''],
    ['Tax ID', meta.taxId || ''],
    [],
    ['Jurisdiction code', 'Jurisdiction name', 'Kind', 'Rate %', 'Amount subject to tax', 'Tax due', 'Required'],
  ];
  const body = supplement.rows.map(r => [
    r.code, r.name, r.kind, r.rate, r.amountSubjectToLocalTax, r.taxDue, r.required ? 'YES' : '',
  ]);
  const footer = [
    [],
    ['Totals', '', '', '', supplement.taxableSales, supplement.totalTax, ''],
    ['State tax', '', '', '', '', supplement.stateTax, ''],
    ['Local tax', '', '', '', '', supplement.localTax, ''],
    [],
    ['Portal', 'https://comptroller.texas.gov/taxes/file-pay/about-webfile.php'],
    ['Note', 'Upload or enter these jurisdiction lines in WebFile List Supplement or Texas EDI software.'],
  ];
  return [...header, ...body, ...footer]
    .map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(','))
    .join('\n');
}

export function normalizeJurisdictions(list) {
  if (Array.isArray(list) && list.length) {
    return list.map(j => ({
      code: String(j.code || '').trim(),
      name: String(j.name || '').trim(),
      kind: String(j.kind || 'local'),
      rate: Number(j.rate) || 0,
      required: Boolean(j.required),
    }));
  }
  // No districts saved yet: keep the state line only rather than inventing a
  // local district the shop may not owe.
  return DEFAULT_TX_JURISDICTIONS.map(j => ({ ...j }));
}
