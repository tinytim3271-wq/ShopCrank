export const CUSTOMER_SEARCH_MIN_LENGTH = 3;
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 275;
export const CUSTOMER_SEARCH_RESULT_LIMIT = 8;

export function normalizeCustomerSearch(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function shouldSearchCustomers(value) {
  return normalizeCustomerSearch(value).length >= CUSTOMER_SEARCH_MIN_LENGTH;
}

function matchesName(name, query) {
  const source = String(name || '').toLocaleLowerCase();
  return normalizeCustomerSearch(query).toLocaleLowerCase().split(' ').every(token => source.includes(token));
}

function vehicleLabel(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
    || vehicle.vehicle
    || vehicle.description
    || 'Vehicle on file';
}

function enrichCustomer(customer, vehicles) {
  const linkedVehicles = vehicles
    .filter(vehicle => (
      (customer.id && vehicle.customerId === customer.id)
      || String(vehicle.customer || '').toLocaleLowerCase() === String(customer.name || '').toLocaleLowerCase()
    ))
    .map(vehicle => ({ ...vehicle, label: vehicleLabel(vehicle) }));
  return {
    ...customer,
    id: String(customer.id || customer.name || ''),
    vehicles: linkedVehicles,
    vehicleCount: linkedVehicles.length || Number(customer.vehicles || 0),
    recentVehicle: linkedVehicles[0] || null,
  };
}

function uniqueCustomers(customers) {
  const seen = new Set();
  return customers.filter(customer => {
    const key = String(customer.id || customer.name || '').trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function localCustomerMatches(query, customers = [], vehicles = []) {
  if (!shouldSearchCustomers(query)) return [];
  return uniqueCustomers(customers)
    .filter(customer => !String(customer.archivedAt || '').trim())
    .filter(customer => matchesName(customer.name, query))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)))
    .slice(0, CUSTOMER_SEARCH_RESULT_LIMIT)
    .map(customer => enrichCustomer(customer, vehicles));
}

const CONTACT_FIELDS = ['name', 'phone', 'email', 'billingAddress', 'billingNotes'];

export function customerContactFields(data = {}, existing = null) {
  const source = data && typeof data === 'object' ? data : {};
  const notesProvided = Object.prototype.hasOwnProperty.call(source, 'billingNotes') && source.billingNotes != null;
  return {
    name: String(source.name ?? existing?.name ?? '').trim(),
    phone: String(source.phone ?? '').trim(),
    email: String(source.email ?? '').trim(),
    billingAddress: String(source.billingAddress ?? '').trim(),
    billingNotes: notesProvided ? String(source.billingNotes).trim() : String(existing?.billingNotes || '').trim(),
  };
}

export function customerContactChanged(existing, fields) {
  if (!existing) return true;
  return CONTACT_FIELDS.some(key => String(existing[key] || '').trim() !== String(fields?.[key] || '').trim());
}

export function mergeSavedCustomer(record, response) {
  if (!response || response.queued) return record;
  const saved = { ...record, ...response, id: response.id || record.id };
  for (const key of CONTACT_FIELDS) {
    if (response[key] == null) saved[key] = record[key] ?? '';
  }
  return saved;
}

export function likelyDuplicateCustomers({ phone = '', email = '' }, customers = [], vehicles = []) {
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const normalizedEmail = String(email || '').trim().toLocaleLowerCase();
  if (!phoneDigits && !normalizedEmail) return [];
  return uniqueCustomers(customers)
    .filter(customer => !String(customer.archivedAt || '').trim())
    .filter(customer => (
      (phoneDigits && String(customer.phone || '').replace(/\D/g, '') === phoneDigits)
      || (normalizedEmail && String(customer.email || '').trim().toLocaleLowerCase() === normalizedEmail)
    ))
    .slice(0, CUSTOMER_SEARCH_RESULT_LIMIT)
    .map(customer => enrichCustomer(customer, vehicles));
}
