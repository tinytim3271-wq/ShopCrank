/**
 * Shop KPIs for the Reports dashboard: car count, average repair order (ARO),
 * gross profit (parts and labor), and technician efficiency / productivity.
 *
 * Definitions (industry-standard, stated on screen):
 *  - Car count: distinct vehicles invoiced in the period.
 *  - ARO: invoiced sales before tax ÷ invoiced repair orders.
 *  - Gross profit: sales − parts cost − technician labor cost. Parts cost uses
 *    the line's cost, its PartsTech cost, or the inventory cost for its SKU.
 *    Labor cost is job-clock hours × the technician's hourly pay rate.
 *  - Efficiency: hours billed on a tech's labor lines ÷ hours clocked on jobs.
 *  - Productivity: hours clocked on jobs ÷ hours on shift.
 */

const round = (value, places = 2) => Math.round((Number(value) || 0) * 10 ** places) / 10 ** places;
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
const VOID = new Set(['void', 'voided', 'cancelled', 'canceled', 'draft']);

function isoDay(value) {
  const text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function periodRange(period, today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const day = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  if (period === 'week') {
    const start = new Date(today);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return { from: day(start), to: day(today), label: 'This week' };
  }
  if (period === 'last_month') return { from: day(new Date(y, m - 1, 1)), to: day(new Date(y, m, 0)), label: 'Last month' };
  if (period === 'ytd') return { from: day(new Date(y, 0, 1)), to: day(today), label: 'Year to date' };
  return { from: day(new Date(y, m, 1)), to: day(today), label: 'This month' };
}

function lineType(line) {
  return ['part', 'fee'].includes(line.type) ? line.type : 'labor';
}

function lineTotal(line) {
  if (Number.isFinite(Number(line.total))) return Number(line.total);
  if (lineType(line) === 'labor') return Number(line.hours || 0) * Number(line.laborRate || 0);
  return Number(line.quantity || 1) * Number(line.unitPrice || line.price || 0);
}

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

function vehicleKey(order, invoice) {
  const vin = String(order.vin || invoice.vin || '').trim().toUpperCase();
  if (VIN.test(vin)) return vin;
  return `${invoice.customer || order.customer}|${invoice.vehicle || order.vehicle}`.toUpperCase();
}

function isCoreCharge(line) {
  return Boolean(line.partstech?.isCore || line.isCore);
}

function partUnitCost(line, inventoryBySku) {
  const direct = [line.cost, line.unitCost, line.partstech?.cost].map(Number).find(value => Number.isFinite(value) && value > 0);
  if (direct) return direct;
  const sku = String(line.inventorySku || line.partNumber || '').trim().toLowerCase();
  const stocked = sku ? inventoryBySku.get(sku) : null;
  const cost = Number(stocked?.cost);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

function hourlyRate(user) {
  const rate = Number(user?.payRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return String(user.employmentType || '').toLowerCase() === 'salary' ? rate / 2080 : rate;
}

function inRange(day, from, to) {
  return Boolean(day) && day >= from && day <= to;
}

export function computeShopKpis({ invoices = [], orders = [], jobClockEntries = [], shiftEntries = [], users = [], inventory = [], from, to }) {
  const inventoryBySku = new Map(inventory.map(item => [String(item.sku || item.partNumber || '').trim().toLowerCase(), item]).filter(([key]) => key));
  const ordersById = new Map(orders.map(order => [order.id, order]));
  const invoiced = invoices.filter(invoice => !VOID.has(String(invoice.status || '').toLowerCase()) && inRange(isoDay(invoice.date || invoice.createdAt), from, to));

  const vehicles = new Set();
  let sales = 0; let partsSales = 0; let partsCost = 0; let partsSalesCosted = 0; let laborSales = 0; let feeSales = 0;
  const billedByTech = new Map();
  const invoicedOrderIds = new Set();
  for (const invoice of invoiced) {
    const order = ordersById.get(invoice.ro) || {};
    invoicedOrderIds.add(invoice.ro);
    vehicles.add(vehicleKey(order, invoice));
    const lines = (invoice.lines?.length ? invoice.lines : order.estimate?.lines || []).filter(line => line.approvalStatus !== 'declined');
    const subtotal = Number(invoice.subtotal);
    sales += Number.isFinite(subtotal) && subtotal > 0 ? subtotal : Math.max(0, Number(invoice.amount || 0) - Number(invoice.tax || 0));
    for (const line of lines) {
      const total = lineTotal(line);
      const type = lineType(line);
      // Refundable core deposits are neither parts sales nor parts cost.
      if (type === 'part' && isCoreCharge(line)) continue;
      if (type === 'part') {
        partsSales += total;
        const unit = partUnitCost(line, inventoryBySku);
        if (unit !== null) {
          partsCost += unit * Number(line.quantity || 1);
          partsSalesCosted += total;
        }
      } else if (type === 'fee') {
        feeSales += total;
      } else {
        laborSales += total;
        const techs = Array.isArray(line.technicianIds) && line.technicianIds.length ? line.technicianIds : (order.assignments || []).map(item => item.employeeId).filter(Boolean);
        const hours = Number(line.hours || 0);
        for (const tech of techs) billedByTech.set(tech, (billedByTech.get(tech) || 0) + hours / techs.length);
      }
    }
  }

  const usersById = new Map(users.map(user => [user.id, user]));
  const clockedByTech = new Map();
  let laborCost = 0; let laborHoursCosted = 0; let laborHoursClocked = 0;
  // Technician activity is measured in the period; labor cost follows the invoiced
  // job, so time clocked before the period on an RO invoiced in it still counts.
  for (const entry of jobClockEntries) {
    const hours = Number(entry.hours) || (entry.clockOut ? (Date.parse(entry.clockOut) - Date.parse(entry.clockIn)) / 3_600_000 : 0);
    if (!(hours > 0)) continue;
    if (inRange(isoDay(entry.clockIn), from, to)) clockedByTech.set(entry.userId, (clockedByTech.get(entry.userId) || 0) + hours);
    if (!invoicedOrderIds.has(entry.workOrderId)) continue;
    laborHoursClocked += hours;
    const rate = hourlyRate(usersById.get(entry.userId));
    if (rate !== null) {
      laborCost += hours * rate;
      laborHoursCosted += hours;
    }
  }
  const shiftByTech = new Map();
  for (const shift of shiftEntries) {
    if (!inRange(isoDay(shift.clockIn), from, to)) continue;
    const hours = Number(shift.hours) || (shift.clockOut ? (Date.parse(shift.clockOut) - Date.parse(shift.clockIn)) / 3_600_000 : 0);
    if (hours > 0) shiftByTech.set(shift.userId, (shiftByTech.get(shift.userId) || 0) + hours);
  }

  const techIds = new Set([...billedByTech.keys(), ...clockedByTech.keys(), ...users.filter(user => user.role === 'technician' && user.active !== false).map(user => user.id)]);
  const techs = [...techIds].map(id => {
    const user = usersById.get(id) || {};
    const billed = billedByTech.get(id) || 0;
    const clocked = clockedByTech.get(id) || 0;
    const shift = shiftByTech.get(id) || 0;
    return {
      id,
      name: user.name || user.techName || id,
      billedHours: round(billed, 1),
      clockedHours: round(clocked, 1),
      shiftHours: round(shift, 1),
      efficiency: ratio(billed, clocked) === null ? null : round(ratio(billed, clocked) * 100, 0),
      productivity: ratio(clocked, shift) === null ? null : round(ratio(clocked, shift) * 100, 0),
    };
  }).filter(tech => tech.billedHours || tech.clockedHours || tech.shiftHours).sort((a, b) => b.billedHours - a.billedHours);

  const roCount = invoiced.length;
  const grossProfit = sales - partsCost - laborCost;
  return {
    from, to,
    carCount: vehicles.size,
    roCount,
    sales: round(sales),
    aro: roCount ? round(sales / roCount) : 0,
    partsSales: round(partsSales),
    partsCost: round(partsCost),
    laborSales: round(laborSales),
    laborCost: round(laborCost),
    feeSales: round(feeSales),
    grossProfit: round(grossProfit),
    grossMargin: sales > 0 ? round((grossProfit / sales) * 100, 1) : null,
    partsMargin: partsSalesCosted > 0 ? round(((partsSalesCosted - partsCost) / partsSalesCosted) * 100, 1) : null,
    laborMargin: laborSales > 0 && laborHoursCosted > 0 ? round(((laborSales - laborCost) / laborSales) * 100, 1) : null,
    partsCostCoverage: partsSales > 0 ? round((partsSalesCosted / partsSales) * 100, 0) : null,
    laborCostCoverage: laborHoursClocked > 0 ? round((laborHoursCosted / laborHoursClocked) * 100, 0) : null,
    techs,
  };
}

const pct = value => (value === null || value === undefined ? '—' : `${value}%`);

export function kpiDashboardHtml(kpis, { period = 'month', label = '', money = value => `$${Number(value || 0).toFixed(2)}`, escapeHtml = value => String(value ?? ''), icon = () => '' } = {}) {
  const periods = [['week', 'This week'], ['month', 'This month'], ['last_month', 'Last month'], ['ytd', 'Year to date']];
  const caveats = [
    kpis.partsCostCoverage !== null && kpis.partsCostCoverage < 100 ? `Parts cost is known for ${kpis.partsCostCoverage}% of parts sales; add costs in Inventory or order through PartsTech for exact margin.` : '',
    kpis.laborCostCoverage !== null && kpis.laborCostCoverage < 100 ? `Labor cost uses pay rates for ${kpis.laborCostCoverage}% of clocked hours; add hourly pay rates on Employees.` : '',
    kpis.roCount && kpis.laborCostCoverage === null ? 'No job-clock time on these orders, so labor cost is not included in gross profit.' : '',
  ].filter(Boolean);
  const card = (title, value, detail = '') => `<article class="kpi-card"><span>${escapeHtml(title)}</span><strong>${value}</strong>${detail ? `<small>${detail}</small>` : ''}</article>`;
  const techRows = kpis.techs.map(tech => `<tr><td><b>${escapeHtml(tech.name)}</b></td><td>${tech.billedHours}</td><td>${tech.clockedHours}</td><td>${tech.shiftHours}</td><td><b>${pct(tech.efficiency)}</b></td><td>${pct(tech.productivity)}</td></tr>`).join('');
  return `<section class="kpi-dashboard"><div class="statement-head"><div><div class="eyebrow">Shop performance</div><h2>${escapeHtml(label || 'This month')}</h2><p>${escapeHtml(kpis.from)} to ${escapeHtml(kpis.to)} · based on invoices issued in the period.</p></div><div class="accounting-tabs">${periods.map(([id, name]) => `<button type="button" class="tab ${period === id ? 'active' : ''}" data-kpi-period="${id}">${name}</button>`).join('')}</div></div>
  <div class="kpi-grid">
    ${card('Car count', String(kpis.carCount), `${kpis.roCount} repair order${kpis.roCount === 1 ? '' : 's'}`)}
    ${card('Average repair order', money(kpis.aro), `${money(kpis.sales)} sales before tax`)}
    ${card('Gross profit', money(kpis.grossProfit), `${pct(kpis.grossMargin)} of sales`)}
    ${card('Parts gross margin', pct(kpis.partsMargin), `${money(kpis.partsSales)} parts sales · ${money(kpis.partsCost)} cost`)}
    ${card('Labor gross margin', pct(kpis.laborMargin), `${money(kpis.laborSales)} labor sales · ${money(kpis.laborCost)} tech pay`)}
  </div>
  ${caveats.length ? `<p class="ops-note">${icon('info', 14)} ${caveats.map(escapeHtml).join(' ')}</p>` : ''}
  <div class="data-panel"><table><thead><tr><th>Technician</th><th>Billed hrs</th><th>Clocked on jobs</th><th>On shift</th><th>Efficiency</th><th>Productivity</th></tr></thead><tbody>${techRows || '<tr><td colspan="6">No technician time in this period.</td></tr>'}</tbody></table><p class="ops-note">Efficiency = billed hours ÷ hours clocked on jobs. Productivity = hours clocked on jobs ÷ hours on shift.</p></div>
  </section>`;
}
