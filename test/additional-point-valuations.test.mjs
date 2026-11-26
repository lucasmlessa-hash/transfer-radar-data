import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADDITIONAL_VALUATION_SOURCES, parseAdditionalPointValuations } from '../src/sources/additional-point-valuations.mjs';

const fixture = id => readFileSync(new URL(`../fixtures/valuations-${id}-2026-11.html`, import.meta.url), 'utf8');
const parse = parseAdditionalPointValuations;

test('the publishers’ November 2026 excerpts yield only the designated USD estimates', () => {
  const expected = {
    'upgraded-points': { JL: 1.3, ACCOR: 2.2 },
    omaat: { AY: 1.2 },
    'points-frog-copa': { CM: 1.3 },
  };
  for (const source of ADDITIONAL_VALUATION_SOURCES) {
    assert.deepEqual(source.codes, Object.keys(expected[source.id]));
    assert.deepEqual(parse(fixture(source.id), source.id), { values: expected[source.id], missingCodes: [] });
  }
  assert.deepEqual(ADDITIONAL_VALUATION_SOURCES.map(s => s.id).sort(), Object.keys(expected).sort());
});

test('Upgraded Points accepts changes per row and isolates unreadable or ambiguous tables', () => {
  const id = 'upgraded-points';
  const html = fixture(id);
  assert.equal(parse(html.replace('November 2026', 'December 2026').replace('>1.3<', '>1.35<'), id).values.JL, 1.35);
  for (const invalid of ['1.1–1.3', '€1.3', '$650', '0', '1.3 purchase price', '']) {
    const result = parse(html.replace('>1.3<', `>${invalid}<`), id);
    assert.deepEqual(result, { values: { ACCOR: 2.2 }, missingCodes: ['JL'] });
  }
  const [airline, hotel] = html.split('</table>');
  for (const fragment of [
    airline.replace('cents/point', 'pence/point'),
    airline.replace('Value (cents/point)', 'Purchase Price (cents/point)'),
    airline.replace('Airline Loyalty Program', 'Flexible Point Program'),
    airline.replace('<td><p>1.3</p></td>', ''),
    airline.replace('</tbody>', '<tr><td>Japan Airlines miles</td><td>1.3</td><td>$650</td><td>$1,300</td></tr></tbody>'),
    airline + '</table>' + airline,
  ]) {
    assert.deepEqual(parse(fragment + '</table>' + hotel + '</table>', id), { values: { ACCOR: 2.2 }, missingCodes: ['JL'] });
  }
});

test('One Mile at a Time requires the Finnair row in its airline valuation table and Avios units', () => {
  const id = 'omaat';
  const html = fixture(id);
  assert.equal(parse(html.replaceAll('1.2 cents per Avios', '1 cent per Avios'), id).values.AY, 1);
  for (const invalid of [
    html.replace('Finnair Plus Avios', 'Iberia Plus Avios'),
    html.replaceAll('cents per Avios', 'pence per Avios'),
    html.replaceAll('cents per Avios', 'cents per Avios to buy'),
    html.replace('Value of airline points currency', 'Price to buy airline points'),
    html.replace('</tbody>', '<tr><td>Finnair Plus Avios</td><td>2 cents per Avios</td></tr></tbody>'),
  ]) assert.deepEqual(parse(invalid, id), { values: {}, missingCodes: ['AY'] });
});

test('Points Frog reads the named current redemption estimate, rejecting ranges, purchases and historical numbers', () => {
  const id = 'points-frog-copa';
  const html = fixture(id);
  const pastValues = '<table><tr><td>2026-10-13</td><td>1.3¢</td><td>baseline</td></tr></table>';
  assert.equal(parse(html.replace('>1.3', '>1.45') + pastValues, id).values.CM, 1.45);
  for (const invalid of [
    html.replace('average redemption value', 'purchase price'),
    html.replace('US cents per unit', 'US dollars per unit'),
    html.replace('>1.3', '>1.0 to 1.3'),
    html.replace('<h1>Copa Airlines ConnectMiles', '<h1>Finnair Plus'),
    html.replace('How much are Copa Airlines ConnectMiles worth?', 'Archived valuation'),
    html.replace('>1.3', '>0'),
    html.replace('>1.3', '>'),
    html + html,
    pastValues,
  ]) assert.deepEqual(parse(invalid + pastValues, id), { values: {}, missingCodes: ['CM'] });
});

test('unrecognized content supplies no verified codes, and an unknown source is rejected', () => {
  for (const { id, codes } of ADDITIONAL_VALUATION_SOURCES) {
    assert.deepEqual(parse('<p>503: service unavailable</p>', id), { values: {}, missingCodes: codes });
  }
  assert.throws(() => parse('<p>1.3 cents</p>', 'unknown'), /source/i);
});
