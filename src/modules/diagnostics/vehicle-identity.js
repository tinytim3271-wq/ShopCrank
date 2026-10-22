/** VIN decode helpers for OEM diagnostics coverage and live key procedures. */

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
const NISSAN_WMI = new Set(['1N4', 'JN1', '3N1', '5N1']);
const MAXIMA_WMI = new Set(['1N4', 'JN1']);
const MAXIMA_VDS = new Set(['AA', 'BA']);
const DODGE_RAM_WMI = {
  '1C6': 'Ram',
  '3C6': 'Ram',
  '1D7': 'Dodge',
  '1B3': 'Dodge',
  '2C3': 'Dodge',
};
const RAM_PLATFORM = { R: 'DT', H: 'DJ', C: 'LD', J: 'JC', U: 'DS' };

export function vinModelYear(vin) {
  const value = String(vin || '').toUpperCase();
  if (value.length < 10) return 0;
  const index = YEAR_CODES.indexOf(value[9]);
  if (index < 0) return 0;
  const baseYear = 1980 + index;
  return /[A-Z]/.test(value[6] || '') ? baseYear + 30 : baseYear;
}

export function isNissanMaximaVin(vin) {
  const value = String(vin || '').toUpperCase();
  if (value.length < 5) return false;
  return MAXIMA_WMI.has(value.slice(0, 3)) && MAXIMA_VDS.has(value.slice(3, 5));
}

export function decodeDiagnosticVin(vin) {
  const value = String(vin || '').trim().toUpperCase();
  const year = vinModelYear(value);
  const wmi = value.slice(0, 3);
  if (isNissanMaximaVin(value)) {
    return {
      make: 'Nissan',
      model: 'Maxima',
      year,
      platform: maximaPlatform(year),
      ignitionType: maximaIgnition(year),
    };
  }
  if (NISSAN_WMI.has(wmi)) {
    return { make: 'Nissan', model: '', year, platform: 'nissan', ignitionType: 'unknown' };
  }
  const make = DODGE_RAM_WMI[wmi];
  if (make) {
    const platform = RAM_PLATFORM[value[3]] || 'unknown';
    return { make, model: '', year, platform, ignitionType: 'push_button' };
  }
  return { make: '', model: '', year, platform: 'unknown', ignitionType: 'unknown' };
}

function maximaPlatform(year) {
  if (year >= 2016) return 'A36';
  if (year >= 2009) return 'A35';
  return 'A34';
}

function maximaIgnition(year) {
  return year >= 2016 ? 'push_button' : 'mechanical';
}

export function matchCoverageRecord(bundle, vehicle = {}) {
  const records = bundle?.records || [];
  const year = Number(vehicle.modelYear || vehicle.year || 0);
  const platform = String(vehicle.platform || 'unknown');
  const make = String(vehicle.make || '').trim().toLowerCase();
  const model = String(vehicle.model || '').trim().toLowerCase();
  const inYear = (record) => {
    const [start, end] = record.yearRange || [0, 9999];
    return !year || (year >= start && year <= end);
  };
  return records.find((record) => record.platform === platform && inYear(record))
    || records.find((record) => {
      if (!make || !model) return false;
      const recordModel = String(record.model || '').toLowerCase();
      return String(record.make || '').toLowerCase() === make
        && (recordModel === model || recordModel.includes(model) || model.includes(recordModel.split('/')[0]))
        && inYear(record);
    })
    || records.find((record) => record.platform === platform)
    || null;
}
