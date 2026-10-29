/** Plate-to-VIN and CARFAX service history controls for the vehicle form. */

export const PLATE_STATES = Object.freeze('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

export function plateLookupHtml({ state = 'TX', icon = () => '' } = {}) {
  return `<label>Plate state<select name="plateState">${PLATE_STATES.map(code => `<option ${code === state ? 'selected' : ''}>${code}</option>`).join('')}</select></label><div class="full vin-actions"><button class="secondary" type="button" id="plate-lookup">${icon('search', 14)} Find VIN from plate</button><button class="secondary" type="button" id="carfax-history">${icon('history', 14)} CARFAX service history</button><span id="plate-status"></span></div><div class="full" id="carfax-results"></div>`;
}

/** Fields to fill from a plate lookup; never overwrites what the user typed. */
export function plateLookupFill(result = {}, current = {}) {
  const fill = {};
  for (const key of ['vin', 'year', 'make', 'model', 'trim']) {
    if (result[key] && !String(current[key] || '').trim()) fill[key] = String(result[key]);
  }
  return fill;
}

export function serviceHistoryHtml(result = {}, { escapeHtml = value => String(value ?? '') } = {}) {
  if (!result.found) return '<p class="ops-note">CARFAX has no service records for this VIN.</p>';
  const rows = result.records.map(record => `<tr><td>${escapeHtml(record.date)}</td><td>${record.odometer ? Number(record.odometer).toLocaleString('en-US') : ''}</td><td>${escapeHtml(record.description)}</td><td>${escapeHtml(record.source)}</td></tr>`).join('');
  return `<div class="data-panel carfax-history"><strong>CARFAX service history · ${result.records.length} record${result.records.length === 1 ? '' : 's'}</strong><table><thead><tr><th>Date</th><th>Odometer</th><th>Service</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
