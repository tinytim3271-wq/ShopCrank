#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacyPath = join(root, 'src/runtime/legacy.js');
const fragmentPath = join(root, 'src/runtime/filing-overrides.js');
let src = readFileSync(legacyPath, 'utf8');
const fragment = readFileSync(fragmentPath, 'utf8');

const IMPORT_LINE = "import * as Filing from '../modules/filing/index.js';";
if (!src.includes(IMPORT_LINE)) {
  src = src.replace(
    "import * as Mileage from '../modules/mileage.js';",
    `import * as Mileage from '../modules/mileage.js';\n${IMPORT_LINE}`,
  );
}

if (!src.includes('"2200", name: "Federal Income Tax Withheld"')) {
  src = src.replace(
    '{ code: "2100", name: "Sales Tax Payable", type: "Liability" }, { code: "4000"',
    '{ code: "2100", name: "Sales Tax Payable", type: "Liability" }, { code: "2200", name: "Federal Income Tax Withheld", type: "Liability" }, { code: "2210", name: "FICA Payable (SS)", type: "Liability" }, { code: "2220", name: "Medicare Payable", type: "Liability" }, { code: "4000"',
  );
}

if (!src.includes('payrollPeriodKey')) {
  src = src.replace(
    'let state = load(), filter = "active", query = "", importPreview = null, accountingTab = "overview"',
    'let state = load(), filter = "active", query = "", importPreview = null, accountingTab = "overview", payrollPeriodKey = null, taxPackageRange = null, filingCenterOpen = false',
  );
}

src = src.replace(
  'taxSettings: { state: "TX", taxId: "", rate: 8.25, filingFrequency: "Monthly" }',
  'taxSettings: { state: "TX", taxId: "", rate: 8.25, filingFrequency: "Monthly", ein: "", texasTaxpayerNumber: "", webfileNumber: "", jurisdictions: null }',
);

// Expand tax settings load from shop entities
src = src.replace(
  'if (tax) state.taxSettings = { state: tax.state || "TX", taxId: String(tax.taxId || ""), rate: Number(tax.rate) || 0, filingFrequency: tax.filingFrequency || "Monthly" }',
  'if (tax) state.taxSettings = { state: tax.state || "TX", taxId: String(tax.taxId || ""), rate: Number(tax.rate) || 0, filingFrequency: tax.filingFrequency || "Monthly", ein: String(tax.ein || ""), texasTaxpayerNumber: String(tax.texasTaxpayerNumber || ""), webfileNumber: String(tax.webfileNumber || ""), jurisdictions: Array.isArray(tax.jurisdictions) ? tax.jurisdictions : null }',
);

const START = '/* === SHOP_CRANK_FILING_OVERRIDES_START === */';
const END = '/* === SHOP_CRANK_FILING_OVERRIDES_END === */';
const startInFrag = fragment.indexOf(START);
const endInFrag = fragment.indexOf(END);
if (startInFrag < 0 || endInFrag < 0) throw new Error('Fragment markers missing');
const block = fragment.slice(startInFrag, endInFrag + END.length);

const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END);
if (startIdx >= 0 && endIdx > startIdx) {
  src = `${src.slice(0, startIdx)}${block}${src.slice(endIdx + END.length)}`;
} else {
  const anchor = 'void startApp();';
  const at = src.lastIndexOf(anchor);
  if (at < 0) throw new Error('void startApp() not found');
  src = `${src.slice(0, at)}${block}\n${src.slice(at)}`;
}

writeFileSync(legacyPath, src);
console.log('Injected filing overrides into legacy.js (' + block.length + ' chars)');
