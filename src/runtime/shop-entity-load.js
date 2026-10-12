/**
 * Shop-entity load helpers.
 *
 * Office users get 403 from the Worker for keyprogrammingjobs. Callers must
 * skip types their role cannot read and settle each fetch independently so one
 * denied type does not abort vehicles/inventory/etc.
 */

export function readableShopEntityTypes(entityTypes, readRoles, role) {
  const types = Array.isArray(entityTypes) ? entityTypes : Object.keys(entityTypes || {});
  const roles = readRoles && typeof readRoles === 'object' ? readRoles : {};
  const currentRole = String(role || '');
  return types.filter((type) => !roles[type] || roles[type].includes(currentRole));
}

/**
 * Apply Promise.allSettled results for shop entity fetches.
 * Only fulfilled array payloads are passed to `apply` so rejected/forbidden
 * types leave local state untouched without failing the whole batch.
 */
export function applySettledShopEntityResults(types, results, apply, onRejected) {
  let failed = 0;
  types.forEach((type, index) => {
    const result = results[index];
    if (!result) return;
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      apply(type, result.value);
      return;
    }
    if (result.status === 'rejected') {
      failed += 1;
      if (typeof onRejected === 'function') onRejected(type, result.reason);
    }
  });
  return failed;
}
