import { isArchived } from './record-retention.js';

export function customersWithSelected(customers = [], selected = '') {
  const records = Array.isArray(customers) ? customers : [];
  const selectedName = String(selected || '');
  const available = records.filter(customer => !isArchived(customer) || customer?.name === selectedName);
  if (!selectedName || available.some(customer => customer?.name === selectedName)) return available;
  return [{ name: selectedName }, ...available];
}

export function customLaborDraft(id, laborRate) {
  return {
    id,
    type: 'labor',
    description: '',
    descriptionPlaceholder: 'Custom labor',
    hours: 1,
    laborRate: Number(laborRate) || 0,
  };
}

export function estimateEditorDescription(line = {}, normalizedDescription = '') {
  const placeholder = String(line.descriptionPlaceholder || '');
  return {
    value: placeholder ? String(line.description || '') : String(normalizedDescription || ''),
    placeholder,
  };
}

function normalizedFeeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isAfterMidnightFeeLine(line = {}) {
  if (line.code === 'after-midnight') return true;
  const text = normalizedFeeText(`${line.description || line.service || ''} ${line.notes || line.explanation || ''}`);
  const hasTime = /\bmidnight\b|\bovernight\b|\blate night\b|\bafter 12(?: 00)? a?m\b/.test(text);
  const hasCharge = /\bfee\b|\bsurcharge\b|\bdifferen(?:tial|tail)\b|\bdifferentail\b/.test(text);
  return line.type !== 'part' && hasTime && hasCharge;
}

export function isLegacyAfterMidnightLine(line = {}) {
  return line.code !== 'after-midnight' && line.type !== 'fee' && isAfterMidnightFeeLine(line);
}

export function afterMidnightFeeFingerprint(lines = []) {
  return JSON.stringify((Array.isArray(lines) ? lines : [])
    .filter(isAfterMidnightFeeLine)
    .map(line => ({
      id: String(line.id || ''),
      description: String(line.description || ''),
      unitPrice: Number(line.unitPrice ?? line.amount) || 0,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export function terminalOrderChangesAfterMidnightFee(status, beforeLines = [], afterLines = []) {
  if (!['completed', 'invoiced'].includes(String(status || ''))) return false;
  return afterMidnightFeeFingerprint(beforeLines) !== afterMidnightFeeFingerprint(afterLines);
}

export function invoicePrintLineItems(invoice = {}) {
  const lineItems = (Array.isArray(invoice.lines) ? invoice.lines : []).map(line => {
    const type = ['part', 'fee'].includes(line?.type) ? line.type : 'labor';
    const amount = Math.max(0, Number(line?.total) || 0);
    return {
      type,
      description: String(line?.description || line?.service || (type === 'fee' ? 'Fee' : type === 'part' ? 'Part' : 'Labor')),
      detail: type === 'fee'
        ? 'Flat fee'
        : type === 'part'
          ? `${Math.max(0, Number(line?.quantity) || 0)} × ${Math.max(0, Number(line?.unitPrice) || 0).toFixed(2)}`
          : `${Math.max(0, Number(line?.hours) || 0).toFixed(2)} hr × ${Math.max(0, Number(line?.laborRate) || 0).toFixed(2)}`,
      amount,
    };
  });
  const feeItems = (Array.isArray(invoice.fees) ? invoice.fees : []).map(fee => ({
    type: 'fee',
    description: String(fee?.description || 'Fee'),
    detail: 'Fee',
    amount: Math.max(0, Number(fee?.amount) || 0),
  }));
  return [...lineItems, ...feeItems];
}
