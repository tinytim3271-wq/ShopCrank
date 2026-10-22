import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDiagnosticVin, isNissanMaximaVin, matchCoverageRecord, vinModelYear } from './vehicle-identity.js';

const maxima2016 = '1N4AA6AP1GC123456';
const maxima2012 = '1N4AA5AP5CC123456';
const altima = '1N4AL3AP1GC123456';
const ram = '1C6SRFHT0LN123456';

test('Nissan Maxima VINs decode make, model, platform, and year', () => {
  assert.equal(isNissanMaximaVin(maxima2016), true);
  assert.equal(isNissanMaximaVin(altima), false);
  assert.equal(vinModelYear(maxima2016), 2016);
  assert.equal(vinModelYear(maxima2012), 2012);
  const decoded = decodeDiagnosticVin(maxima2016);
  assert.equal(decoded.make, 'Nissan');
  assert.equal(decoded.model, 'Maxima');
  assert.equal(decoded.platform, 'A36');
  assert.equal(decoded.year, 2016);
  assert.equal(decodeDiagnosticVin(maxima2012).platform, 'A35');
  assert.equal(decodeDiagnosticVin(ram).make, 'Ram');
});

test('coverage matches Nissan Maxima by platform or make/model', () => {
  const bundle = {
    records: [
      { id: 'ram', make: 'Ram', model: '1500', platform: 'DT', yearRange: [2019, 2024], procedures: {} },
      { id: 'maxima-a36', make: 'Nissan', model: 'Maxima', platform: 'A36', yearRange: [2016, 2023], procedures: { add_key: { supported: true } } },
    ],
  };
  const byPlatform = matchCoverageRecord(bundle, { platform: 'A36', modelYear: 2018 });
  assert.equal(byPlatform.id, 'maxima-a36');
  const byName = matchCoverageRecord(bundle, { make: 'Nissan', model: 'Maxima', year: 2017, platform: 'unknown' });
  assert.equal(byName.id, 'maxima-a36');
  assert.equal(matchCoverageRecord(bundle, { platform: 'unknown', make: 'Nissan', model: 'Altima', year: 2016 }), null);
});
