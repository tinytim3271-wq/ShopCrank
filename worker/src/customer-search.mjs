import { canReadEntity } from './domain.mjs';
import { HttpError, json, requestJson } from './http.mjs';

export const CUSTOMER_SEARCH_MIN_LENGTH = 3;
export const CUSTOMER_SEARCH_RESULT_LIMIT = 8;
const CUSTOMER_SEARCH_MAX_LENGTH = 80;
const CUSTOMER_DUPLICATE_MAX_LENGTH = 254;

function escapeLike(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function parseRecord(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function vehicleLabel(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
    || vehicle.vehicle
    || vehicle.description
    || 'Vehicle on file';
}

function customerResults(rows) {
  const customers = new Map();
  for (const row of rows) {
    let result = customers.get(row.entity_id);
    if (!result) {
      const customer = parseRecord(row.data_json);
      if (!customer) continue;
      result = {
        id: String(customer.id || row.entity_id),
        name: String(customer.name || ''),
        phone: String(customer.phone || ''),
        email: String(customer.email || ''),
        billingAddress: String(customer.billingAddress || customer.address || ''),
        billingNotes: String(customer.billingNotes || ''),
        vehicles: [],
      };
      customers.set(row.entity_id, result);
    }
    const vehicle = parseRecord(row.vehicle_json);
    if (vehicle) {
      result.vehicles.push({
        ...vehicle,
        id: String(vehicle.id || ''),
        label: vehicleLabel(vehicle),
      });
    }
  }
  return [...customers.values()].map(customer => ({
    ...customer,
    vehicleCount: customer.vehicles.length,
    recentVehicle: customer.vehicles[0] || null,
  }));
}

async function enrichedCustomers(
  env,
  shopId,
  whereSql,
  whereArgs,
  orderSql = 'lower(json_extract(data_json, \'$.name\'))',
  orderArgs = [],
) {
  const result = await env.DB.prepare(`
    WITH matching_customers AS (
      SELECT entity_id, data_json, updated_at
      FROM entities
      WHERE shop_id = ? AND entity_type = 'customers'
        AND COALESCE(trim(json_extract(data_json, '$.archivedAt')), '') = ''
        AND (${whereSql})
      ORDER BY ${orderSql}
      LIMIT ?
    )
    SELECT customer.entity_id, customer.data_json, vehicle.data_json AS vehicle_json
    FROM matching_customers customer
    LEFT JOIN entities vehicle
      ON vehicle.shop_id = ?
      AND vehicle.entity_type = 'vehicles'
      AND (
        json_extract(vehicle.data_json, '$.customerId') = customer.entity_id
        OR (
          json_extract(vehicle.data_json, '$.customerId') IS NULL
          AND lower(trim(json_extract(vehicle.data_json, '$.customer')))
            = lower(trim(json_extract(customer.data_json, '$.name')))
        )
      )
    ORDER BY lower(json_extract(customer.data_json, '$.name')), vehicle.updated_at DESC
  `).bind(shopId, ...whereArgs, ...orderArgs, CUSTOMER_SEARCH_RESULT_LIMIT, shopId).all();
  return customerResults(result.results || []);
}

export async function searchCustomers(env, shopId, query) {
  const normalized = String(query || '').trim().replace(/\s+/g, ' ').slice(0, CUSTOMER_SEARCH_MAX_LENGTH);
  if (normalized.length < CUSTOMER_SEARCH_MIN_LENGTH) {
    throw new HttpError(400, `Customer search requires at least ${CUSTOMER_SEARCH_MIN_LENGTH} characters`);
  }
  const tokens = normalized.toLocaleLowerCase('en-US').split(' ').filter(Boolean);
  const clauses = tokens.map(() => "lower(json_extract(data_json, '$.name')) LIKE ? ESCAPE '\\'");
  const args = tokens.map(token => `%${escapeLike(token)}%`);
  return enrichedCustomers(
    env,
    shopId,
    clauses.join(' AND '),
    args,
    "CASE WHEN lower(trim(json_extract(data_json, '$.name'))) = ? THEN 0 WHEN lower(json_extract(data_json, '$.name')) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, lower(json_extract(data_json, '$.name'))",
    [normalized.toLocaleLowerCase('en-US'), `${escapeLike(normalized.toLocaleLowerCase('en-US'))}%`],
  );
}

export async function findDuplicateCustomers(env, shopId, { phone = '', email = '' } = {}) {
  const boundedPhone = String(phone || '').trim().slice(0, CUSTOMER_DUPLICATE_MAX_LENGTH);
  const boundedEmail = String(email || '').trim().toLocaleLowerCase('en-US').slice(0, CUSTOMER_DUPLICATE_MAX_LENGTH);
  const phoneDigits = boundedPhone.replace(/\D/g, '');
  const clauses = [];
  const args = [];
  if (phoneDigits) {
    clauses.push("replace(replace(replace(replace(replace(json_extract(data_json, '$.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?");
    args.push(phoneDigits);
  }
  if (boundedEmail) {
    clauses.push("lower(trim(json_extract(data_json, '$.email'))) = ?");
    args.push(boundedEmail);
  }
  if (!clauses.length) return [];
  return enrichedCustomers(env, shopId, clauses.join(' OR '), args);
}

function assertCustomerRead(context) {
  if (!canReadEntity('customers', context.role)) {
    throw new HttpError(403, `Role ${context.role} cannot read customers`);
  }
}

export async function handleCustomerLookup(request, env, context, action) {
  assertCustomerRead(context);
  if (action === 'search' && request.method === 'GET') {
    const query = new URL(request.url).searchParams.get('q') || '';
    const results = await searchCustomers(env, context.shopId, query);
    return json({
      query: String(query).trim().slice(0, CUSTOMER_SEARCH_MAX_LENGTH),
      minLength: CUSTOMER_SEARCH_MIN_LENGTH,
      results,
    });
  }
  if (action === 'duplicates' && request.method === 'POST') {
    const body = await requestJson(request);
    const results = await findDuplicateCustomers(env, context.shopId, body);
    return json({ results });
  }
  throw new HttpError(405, 'Method not allowed');
}
