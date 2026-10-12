export {
  computeFederalWithholding,
  computeFica,
  computePayPeriodTaxes,
  PUB_15T_2026_STANDARD,
  PUB_15T_2026_STEP2,
  SS_RATE,
  MEDICARE_RATE,
  SS_WAGE_BASE_2026,
} from './withholding.js';

export {
  DEFAULT_TX_JURISDICTIONS,
  combinedSalesTaxRate,
  buildJurisdictionSupplement,
  texasListSupplementCsv,
  normalizeJurisdictions,
} from './jurisdictions.js';

export {
  openW2Form,
  open1099NecForm,
  buildEfw2Text,
} from './forms.js';

export function downloadTextFile(filename, content, mime = 'text/csv;charset=utf-8') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: mime }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function csvFromRows(rows) {
  return rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
}

/** Form 941 worksheet CSV for the quarter. */
export function form941WorksheetCsv(summary, meta = {}) {
  const rows = [
    ['Form 941 employer’s quarterly federal tax return — worksheet'],
    ['Tax year', meta.taxYear || ''],
    ['Quarter', meta.quarter || ''],
    ['EIN', meta.ein || ''],
    ['Employer', meta.employerName || ''],
    [],
    ['Line', 'Description', 'Amount'],
    ['1', 'Number of employees who received wages', summary.employeeCount],
    ['2', 'Wages, tips, and other compensation', summary.wages],
    ['3', 'Federal income tax withheld', summary.federal],
    ['5a', 'Taxable social security wages', summary.socialSecurityWages],
    ['5a × 12.4%', 'Social security tax (employee + employer)', summary.socialSecurityTotal],
    ['5c', 'Taxable Medicare wages', summary.medicareWages],
    ['5c × 2.9%', 'Medicare tax (employee + employer)', summary.medicareTotal],
    ['6', 'Total taxes before adjustments', summary.totalTax],
    [],
    ['Portal', 'https://www.irs.gov/businesses/small-businesses-self-employed/e-file-employment-tax-forms'],
    ['Note', 'Enter these amounts in IRS e-file / EFTPS or provide to your CPA. MechPro prepares the worksheet from payroll records.'],
  ];
  return csvFromRows(rows);
}
