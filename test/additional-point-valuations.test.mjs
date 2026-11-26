import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADDITIONAL_VALUATION_SOURCES, parseAdditionalPointValuations } from '../src/sources/additional-point-valuations.mjs';
import { VALUATION_SOURCES, parsePointValuations } from '../src/sources/point-valuations.mjs';

const fixture = id => readFileSync(new URL(`../fixtures/valuations-${id}-2026-11.html`, import.meta.url), 'utf8');
const family = value => ({ BA: value, QR: value, IB: value, EI: value, AY: value });
const expected = {
  fm: {
    AA: 1.4, AC: 1.4, AF: 1.3, AS: 1.5, AV: 1.3, ...family(1.1), CX: 1.1, DL: 1.1,
    F9: 1, B6: 1.3, LH: 1.3, QF: 1.3, WN: 1.3, UA: 1.3, VS: 1.5,
  },
  tpg: {
    AM: 0.8, AC: 1.45, AS: 1.6, AA: 1.45, NH: 1.3, AV: 1.65, ...family(1.35), CX: 1.3,
    DL: 1.2, EK: 1, EY: 1.1, AF: 1.45, F9: 1.3, B6: 1.35, QF: 1.3, SQ: 1.25, WN: 1.25,
    TK: 1.1, UA: 1.2, VS: 1.5,
  },
  'upgraded-points': {
    AC: 1.5, AF: 1.3, AS: 1.6, AA: 1.4, NH: 1.4, AV: 1.4, ...family(1.25), CX: 1.3,
    DL: 1.2, EK: 1.1, EY: 1.4, F9: 1.1, JL: 1.3, B6: 1.3, LH: 1.3, SQ: 1.35, WN: 1.3,
    TK: 1.3, UA: 1.2, VS: 1.4,
  },
  omaat: {
    AC: 1.4, AF: 1.3, AS: 1.5, NH: 1.4, AA: 1.5, AV: 1.3, ...family(1.2), CX: 1.2,
    DL: 1.1, EK: 1.2, EY: 1.1, JL: 1.3, B6: 1.3, LH: 1.2, SQ: 1.3, WN: 1.2,
    TK: 1.2, UA: 1.3, VS: 1.1,
  },
  'points-frog-copa': { CM: 1.3 },
};
const dates = {
  fm: '2026-10-08', tpg: '2026-11-01', 'upgraded-points': '2026-11-01',
  omaat: '2026-09-02', 'points-frog-copa': '2026-10-13',
};
const parse = (html, id) => ['fm','tpg'].includes(id) ? parsePointValuations(html, id) : parseAdditionalPointValuations(html, id);

test('publisher tables supply each supported comparison, with a single base Avios observation and the publisher date', () => {
  for (const { id, codes, maxAgeDays } of [...VALUATION_SOURCES, ...ADDITIONAL_VALUATION_SOURCES]) {
    const result = parse(fixture(id), id);
    assert.deepEqual(result.values, expected[id], id);
    assert.deepEqual(result.dates, Object.fromEntries(codes.map(code => [code, dates[id]])), id);
    assert.deepEqual(result.missingCodes, []);
    assert.deepEqual([...codes].sort(), Object.keys(expected[id]).sort());
    assert.equal(maxAgeDays, ['tpg', 'upgraded-points'].includes(id) ? 35 : 90);
  }
});

test('Upgraded Points accepts only the direct numeric estimate in a single explicitly dated cents-per-point table', () => {
  const id = 'upgraded-points', html = fixture(id);
  const row = /(<td><p>Japan Airlines miles<\/p><\/td>)<td><p>1\.3<\/p><\/td>/;
  const withJL = text => html.replace(row, (_, label) => label + text);
  const updated = parse(withJL('<td><p>1.35</p></td>').replace('November 2026', 'December 2026'), id);
  assert.equal(updated.values.JL, 1.35);
  assert.equal(updated.dates.JL, '2026-12-01');
  for (const invalid of ['1.1–1.3', '€1.3', '$650', '0', '1.3 purchase price', '']) {
    const result = parse(withJL(`<td>${invalid}</td>`), id);
    assert.deepEqual(result.missingCodes, ['JL']);
    assert.equal(result.dates.JL, undefined);
    assert.equal(result.values.UA, 1.2);
  }
  assert.deepEqual(parse(withJL(''), id).missingCodes, ['JL']);
  assert.deepEqual(parse(html.replace('</tbody>', '<tr><td>Japan Airlines miles</td><td>1.3</td><td>$650</td><td>$1,300</td></tr></tbody>'), id).missingCodes, ['JL']);
  for (const invalid of [html.replace('cents/point','pence/point'), html.replace('Value (cents/point)','Purchase Price (cents/point)'),
    html.replace('Airline Loyalty Program','Flexible Point Program'), html.replace('November 2026', 'NotAMonth 2026'), html+html]) {
    assert.deepEqual(parse(invalid,id).values, {});
  }
});

test('Avios uses the generic or British Airways row even when other clubs report a different estimate', () => {
  const id = 'omaat', html = fixture(id);
  assert.deepEqual(parse(html.replace('>1.2 cents per Avios<', '>3 cents per Avios<'), id).values, expected[id]);
  const changed = html.replace(/(British Airways Club Avios<\/td><td>)1\.2/, '$11.15');
  for (const code of Object.keys(family())) assert.equal(parse(changed, id).values[code], 1.15, code);
  for (const invalid of [
    html.replace('British Airways Club Avios', 'Unidentified Avios'),
    html.replaceAll('cents per Avios', 'pence per Avios'), html.replaceAll('cents per Avios', 'cents per Avios to buy'),
    html.replace('</tbody>', '<tr><td>British Airways Club Avios</td><td>2 cents per Avios</td></tr></tbody>'),
  ]) {
    assert.deepEqual(parse(invalid, id).missingCodes.sort(), Object.keys(family()).sort());
    assert.equal(parse(invalid, id).values.AC, 1.4);
  }
  assert.deepEqual(parse(html.replace('Value of airline points currency', 'Price to buy airline points'),id).values, {});
  assert.equal(parse(html.replace('1.4 cents per point','1.4 cents per Avios'), id).values.AC, undefined);
});

test('undated or impossible publisher dates cannot be advanced by fetching the same table again', () => {
  for (const id of ['fm', 'omaat']) {
    const html = fixture(id);
    for (const bad of [html.replace('article:modified_time', 'unrelated'), html.replace(/2026-\d\d-\d\dT/, '2026-02-30T')]) {
      assert.deepEqual(parse(bad, id).values, {});
    }
  }
});

test('Copa uses the redemption estimate and its dated valuation, ignoring the independent exchange-rate date', () => {
  const id = 'points-frog-copa', html = fixture(id);
  const pastValues = '<table><tr><td>2026-10-13</td><td>1.3¢</td><td>baseline</td></tr></table>';
  assert.equal(parse(html.replace('>1.3', '>1.45') + pastValues, id).values.CM, 1.45);
  for (const invalid of [
    html.replace('average redemption value', 'purchase price'),
    html.replace('US cents per unit', 'US dollars per unit'), html.replace('>1.3', '>1.0 to 1.3'),
    html.replace('<h1>Copa Airlines ConnectMiles', '<h1>Finnair Plus'),
    html.replace('How much are Copa Airlines ConnectMiles worth?', 'Archived valuation'),
    html.replace('Value updated','FX updated'), html.replace('2026-10-13', '2026-10-32'),
    html.replace('>1.3', '>0'), html.replace('>1.3', '>'), html + html, pastValues,
  ]) {
    assert.deepEqual(parse(invalid + pastValues, id), { values: {}, dates: {}, missingCodes: ['CM'] });
  }
});

test('unrecognized additional source content yields no observations and an unknown publisher throws', () => {
  for (const { id, codes } of ADDITIONAL_VALUATION_SOURCES) {
    assert.deepEqual(parse('<p>503: service unavailable</p>', id), { values: {}, dates: {}, missingCodes: codes });
  }
  assert.throws(() => parse('<p>1.3 cents</p>', 'unknown'), /source/i);
});
