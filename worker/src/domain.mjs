export const ENTITY_TYPES = new Set([
  'customers', 'vehicles', 'orders', 'invoices', 'expenses', 'estimates', 'payments',
  'employees', 'shiftentries', 'jobclockentries', 'payrollentries', 'conversations',
  'chatmessages', 'inventory', 'vendors', 'services', 'inspectiontemplates',
  'inspections', 'reminders', 'shopsettings', 'appointments', 'purchases',
  'diagnosticsessions', 'keyprogrammingjobs', 'calls',
]);

export const WRITE_ROLES = {
  employees: ['admin'],
  invoices: ['admin', 'office', 'service_writer'],
  payments: ['admin', 'office', 'service_writer'],
  expenses: ['admin', 'office'],
  payrollentries: ['admin'],
  estimates: ['admin', 'office', 'service_writer'],
  shopsettings: ['admin'],
  purchases: ['admin', 'office'],
  vendors: ['admin', 'office'],
  services: ['admin', 'office', 'service_writer'],
  inspectiontemplates: ['admin', 'office', 'service_writer'],
  diagnosticsessions: ['admin', 'technician', 'service_writer'],
  keyprogrammingjobs: ['admin', 'technician', 'service_writer'],
  calls: ['admin', 'office', 'service_writer'],
};

export const READ_ROLES = {
  payrollentries: ['admin', 'office'],
  keyprogrammingjobs: ['admin', 'technician', 'service_writer'],
};

export function normalizeEntityType(value) {
  const type = String(value || '').trim().toLowerCase();
  return type === 'bookings' ? 'appointments' : type;
}

function firstPresent(payload, ...keys) {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') return payload[key];
  }
  return undefined;
}

function normalizedInvoiceStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['paid', 'closed', 'complete', 'completed'].includes(status)) return 'paid';
  if (['overdue', 'past_due'].includes(status)) return 'overdue';
  if (['sent', 'open', 'unpaid'].includes(status)) return 'sent';
  return status || 'sent';
}

export function normalizeEntityPayload(sourceType, payload) {
  const type = String(sourceType || '').trim().toLowerCase();
  if (type === 'customers') {
    return {
      ...payload,
      name: firstPresent(payload, 'name', 'customer_name'),
      phone: firstPresent(payload, 'phone', 'mobile') ?? '',
      billingAddress: firstPresent(payload, 'billingAddress', 'billing_address', 'address') ?? '',
      billingNotes: firstPresent(payload, 'billingNotes', 'billing_notes', 'notes') ?? '',
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  if (type === 'vehicles') {
    return {
      ...payload,
      customer: firstPresent(payload, 'customer', 'customer_name', 'owner'),
      year: firstPresent(payload, 'year', 'vehicle_year'),
      make: firstPresent(payload, 'make', 'vehicle_make'),
      model: firstPresent(payload, 'model', 'vehicle_model'),
      vin: firstPresent(payload, 'vin', 'vehicle_vin') ?? '',
      plate: firstPresent(payload, 'plate', 'license_plate', 'reg_num') ?? '',
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  if (type === 'expenses') {
    return {
      ...payload,
      date: firstPresent(payload, 'date', 'expense_date', 'paid_date'),
      vendor: firstPresent(payload, 'vendor', 'payee'),
      category: firstPresent(payload, 'category', 'expense_category') ?? 'Uncategorized',
      memo: firstPresent(payload, 'memo', 'description', 'notes') ?? '',
      amount: firstPresent(payload, 'amount', 'total_amount', 'total'),
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  if (type === 'employees' && ('salary' in payload || 'created_at' in payload)) {
    return {
      ...payload,
      payRate: payload.payRate ?? payload.salary ?? 0,
      active: payload.active ?? payload.status !== 'inactive',
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  if (type === 'bookings') {
    const timestamp = String(payload.booking_date || '');
    return {
      ...payload,
      customerId: payload.customerId ?? payload.customer_id,
      employeeId: payload.employeeId ?? payload.employee_id,
      customer: payload.customer ?? (payload.customer_id ? `Customer #${payload.customer_id}` : 'Customer pending'),
      vehicle: payload.vehicle ?? 'Vehicle pending',
      service: payload.service ?? payload.service_type ?? 'General service',
      date: payload.date ?? timestamp.slice(0, 10),
      time: payload.time ?? timestamp.slice(11, 16),
      tech: payload.tech ?? (payload.employee_id ? `Employee #${payload.employee_id}` : 'Unassigned'),
      notes: payload.notes ?? '',
      status: payload.status ?? 'scheduled',
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  if (type === 'invoices') {
    const date = firstPresent(payload, 'date', 'invoice_date', 'issued_at');
    const explicitCloseout = firstPresent(
      payload,
      'closedAt',
      'closeoutDate',
      'closeout_date',
      'closed_at',
      'closed_date',
      'paidAt',
      'paid_at',
      'paid_date',
      'completedAt',
      'completed_at',
      'completed_date',
    );
    const importedShape = Boolean(
      payload.importSource
      || payload.invoice_number
      || payload.invoice_date
      || payload.customer_name
      || explicitCloseout,
    );
    const closedAt = explicitCloseout ?? (importedShape ? date : undefined);
    return {
      ...payload,
      customerId: payload.customerId ?? payload.customer_id,
      bookingId: payload.bookingId ?? payload.booking_id,
      number: firstPresent(payload, 'number', 'invoice_number', 'invoice'),
      customer: firstPresent(payload, 'customer', 'customer_name'),
      ro: firstPresent(payload, 'ro', 'ro_number', 'work_order') ?? '',
      date,
      due: firstPresent(payload, 'due', 'due_date') ?? '',
      amount: firstPresent(payload, 'amount', 'total_amount', 'total'),
      status: normalizedInvoiceStatus(payload.status),
      closedAt,
      closeoutSource: payload.closeoutSource ?? (closedAt ? (explicitCloseout ? 'source_closeout_date' : 'invoice_date') : undefined),
      paymentMethod: payload.paymentMethod ?? payload.payment_method,
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  if (type === 'inspections') {
    return {
      ...payload,
      customerId: payload.customerId ?? payload.customer_id,
      vin: payload.vin ?? payload.vehicle_vin ?? '',
      aiAnalysis: payload.aiAnalysis ?? payload.ai_analysis ?? '',
      createdAt: payload.createdAt ?? payload.created_at,
      updatedAt: payload.updatedAt ?? payload.updated_at,
    };
  }
  return payload;
}

export function canReadEntity(type, role) {
  return !READ_ROLES[type] || READ_ROLES[type].includes(role);
}

export function canWriteEntity(type, role) {
  return !WRITE_ROLES[type] || WRITE_ROLES[type].includes(role);
}

export function redactEmployee(record, role) {
  if (['admin', 'office'].includes(role)) return record;
  const copy = { ...record };
  ['payRate', 'payFrequency', 'employmentType', 'address', 'emergencyContact', 'taxStatus', 'phone', 'federalWithholdingRate', 'stateWithholdingRate']
    .forEach(field => delete copy[field]);
  return copy;
}

export function openInvoiceBalance(invoiceAmount, payments) {
  const paid = payments.filter(payment => payment.status === 'completed')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  return Math.max(0, Math.round((Number(invoiceAmount || 0) - paid) * 100) / 100);
}

export function validVin(value) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(value || '').trim().toUpperCase());
}

export function validShopId(value) {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(String(value || ''));
}

export function invoiceTaxBreakdown(invoice, fallbackRate) {
  if (!invoice) return { subtotal: 0, tax: 0, taxRate: fallbackRate };
  if (typeof invoice.tax === 'number' && typeof invoice.subtotal === 'number') {
    return {
      subtotal: invoice.subtotal,
      // Taxable sales exclude untaxed labor/fees (ADR-003); older invoices taxed the whole subtotal.
      taxableSubtotal: typeof invoice.taxableSubtotal === 'number' ? invoice.taxableSubtotal : invoice.subtotal,
      tax: invoice.tax,
      taxRate: invoice.taxRate ?? fallbackRate,
    };
  }
  const subtotal = Math.round((Number(invoice.amount || 0) / (1 + fallbackRate / 100)) * 100) / 100;
  return { subtotal, tax: Math.round((Number(invoice.amount || 0) - subtotal) * 100) / 100, taxRate: fallbackRate };
}

export function buildTaxReport(payments, invoices, fallbackRate, from, to) {
  const start = new Date(from);
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);
  const legacyRecognitions = invoices.map(invoice => {
    const recognition = invoice.paymentImportLegacyRecognition
      || (invoice.paymentImportLegacyCloseout ? {
        amount: invoice.amount,
        receivedAt: invoice.paymentImportLegacyCloseout.paidAt
          || invoice.paymentImportLegacyCloseout.closedAt
          || invoice.date,
      } : null);
    return recognition ? {
      invoiceNumber: invoice.number,
      customer: invoice.customer,
      amount: recognition.amount,
      receivedAt: recognition.receivedAt,
      status: 'completed',
    } : null;
  }).filter(Boolean);
  const legacyInvoiceNumbers = new Set(legacyRecognitions.map(invoice => invoice.invoiceNumber));
  const completedPayments = payments.filter(payment => payment.status === 'completed'
    && !legacyInvoiceNumbers.has(payment.invoiceNumber));
  const legacyPaidInvoices = [
    ...legacyRecognitions,
    ...invoices
      .filter(invoice => invoice.status === 'paid'
        && !legacyInvoiceNumbers.has(invoice.number)
        && !payments.some(payment => payment.invoiceNumber === invoice.number))
      .map(invoice => ({
        invoiceNumber: invoice.number,
        customer: invoice.customer,
        amount: invoice.amount,
        receivedAt: invoice.paidAt || invoice.closedAt || invoice.date,
        status: 'completed',
      })),
  ];
  const rows = [...completedPayments, ...legacyPaidInvoices]
    .filter(payment => new Date(payment.receivedAt) >= start && new Date(payment.receivedAt) <= end)
    .map(payment => {
      const invoice = invoices.find(item => item.number === payment.invoiceNumber);
      const breakdown = invoiceTaxBreakdown(invoice, fallbackRate);
      const ratio = invoice ? Number(payment.amount) / (Number(invoice.amount) || Number(payment.amount)) : 0;
      const gross = Number(payment.amount);
      const taxable = Math.round((breakdown.taxableSubtotal ?? breakdown.subtotal) * ratio * 100) / 100;
      const tax = Math.round(breakdown.tax * ratio * 100) / 100;
      const nontaxable = Math.max(0, Math.round((gross - taxable - tax) * 100) / 100);
      return {
        date: payment.receivedAt,
        invoiceNumber: payment.invoiceNumber,
        customer: payment.customer,
        gross,
        taxable,
        nontaxable,
        tax,
        taxRate: breakdown.taxRate ?? fallbackRate,
      };
    }).sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const totals = rows.reduce((sum, row) => ({
    gross: Math.round((sum.gross + row.gross) * 100) / 100,
    taxable: Math.round((sum.taxable + row.taxable) * 100) / 100,
    nontaxable: Math.round((sum.nontaxable + row.nontaxable) * 100) / 100,
    tax: Math.round((sum.tax + row.tax) * 100) / 100,
  }), { gross: 0, taxable: 0, nontaxable: 0, tax: 0 });
  return { rows, totals };
}
