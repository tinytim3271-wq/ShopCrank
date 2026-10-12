/**
 * Multi-jurisdiction sales tax matrix (state + local districts).
 * Texas local codes are 7 digits: 2=city, 3=transit, 4=county, 5=SPD, 6=combined.
 */

function roundCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Default Texas shop outlet jurisdictions (editable in settings). */
export const DEFAULT_TX_JURISDICTIONS = [
  { code: '2001000', name: 'State of Texas', kind: 'state', rate: 6.25, required: true },
  { code: '2201598', name: 'Example City', kind: 'city', rate: 1.0, required: true },
  { code: '3201598', name: 'Example Transit Authority', kind: 'transit', rate: 0.5, required: false },
  { code: '4201598', name: 'Example County', kind: 'county', rate: 0.5, required: true },
];

/**
 * @param {Array<{ code: string, name: string, kind: string, rate: number, required?: boolean }>} jurisdictions
 */
export function combinedSalesTaxRate(jurisdictions) {
  return roundCents((jurisdictions || []).reduce((sum, j) => sum + Number(j.rate || 0), 0));
}

/**
 * Allocate taxable sales across jurisdictions for a Texas list-filer style supplement.
 * Local tax applies to the same taxable base (subject to local caps in real returns —
 * MechPro reports the taxable amount against each active jurisdiction for WebFile entry).
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

export function normalizeJurisdictions(list, fallbackRate = 8.25) {
  if (Array.isArray(list) && list.length) {
    return list.map(j => ({
      code: String(j.code || '').trim(),
      name: String(j.name || '').trim(),
      kind: String(j.kind || 'local'),
      rate: Number(j.rate) || 0,
      required: Boolean(j.required),
    }));
  }
  const state = 6.25;
  const local = Math.max(0, Number(fallbackRate) - state);
  return [
    { code: '2001000', name: 'State of Texas', kind: 'state', rate: state, required: true },
    { code: '2200001', name: 'Local combined (shop default)', kind: 'combined', rate: roundCents(local), required: true },
  ];
}
