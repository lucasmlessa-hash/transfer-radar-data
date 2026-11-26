import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCOR_VALUATION_SOURCE } from '../src/sources/accor-point-valuation.mjs';

const fixture = name => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const html = fixture('accor-point-valuation.html');
const snapshot = fixture('accor-ecb-fixing.json');
const now = new Date('2026-11-26T12:00:00Z');
const api = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=jsondata&lastNObservations=1';

function fixing(day = '2026-11-25', usd = 1.0935) {
  const data = JSON.parse(snapshot);
  data.structure.dimensions.observation[0].values[0].id = day;
  data.dataSets[0].validFrom = `${day}T15:00:17.015+00:00`;
  data.dataSets[0].series['0:0:0:0:0'].observations[0][0] = usd;
  return data;
}

function collect({ page = html, rates = fixing(), asOf = now, previousMeta, unavailable } = {}) {
  const fetchImpl = async url => {
    if (url === unavailable) return new Response('', { status: 503 });
    if (url === ACCOR_VALUATION_SOURCE.url) return new Response(page);
    assert.equal(url, api);
    return Response.json(rates);
  };
  return ACCOR_VALUATION_SOURCE.collect({ fetchImpl, now: asOf, previousMeta });
}

test('combines the official stay redemption with USD per EUR, preserving conversion precision and sources', async () => {
  const { values, meta, evidence, missingCodes } = await collect();
  assert.deepEqual(values, { ACCOR: 2.187 });
  assert.deepEqual(missingCodes, []);
  const m = meta.ACCOR;
  assert.equal(m.currency, 'EUR');
  assert.equal(m.sourceCurrency, 'EUR');
  assert.equal(m.sourceValue, 0.02);
  assert.equal(m.fxRate, 1.0935);
  assert.equal(m.method, 'official-fx');
  assert.equal(m.estimate, false);
  assert.equal(m.asOf, '2026-11-25');
  assert.match(m.fxSource, /^https:\/\/www\.ecb\.europa\.eu\//);
  assert.equal(evidence.fx.url, api);
  assert.equal(evidence.fx.date, m.asOf);
  assert.equal(evidence.checkedAt, now.toISOString());
  assert.deepEqual((await collect({ rates: fixing('2026-11-25', 1.0879) })).values, { ACCOR: 2.1758 });
});

test('uses the last published business day through a holiday and weekend, preserving the fixing date on recheck', async () => {
  const rates = fixing('2026-04-02', 1.1628); // Thursday before Easter weekend.
  const friday = await collect({ asOf: new Date('2026-04-03T15:00:00Z'), rates });
  const monday = await collect({ asOf: new Date('2026-04-06T15:00:00Z'), rates, previousMeta: friday.meta.ACCOR });
  assert.deepEqual(friday.meta, monday.meta);
  assert.equal(monday.meta.ACCOR.asOf, '2026-04-02');
  assert.notEqual(friday.evidence.checkedAt, monday.evidence.checkedAt);
});

test('refuses a changed, missing, ambiguous or unrelated official reward discount', async () => {
  for (const page of [html.replace('20€', '30€'), html.replace('20€', '$20'), html.replace('1.000 PTS', '2.000 PTS'),
    html.replace('Reward points', 'Status points'), html.replace('pay for part or all of your stay', 'earn more Status points'),
    html + html.replace('20€', '10€'), '<script>1.000 PTS = 20€</script>']) {
    await assert.rejects(collect({ page }), /Accor/);
  }
});

test('refuses future, stale and impossible fixing dates; exactly seven calendar days are allowed', async () => {
  assert.equal((await collect({ rates: fixing('2026-11-19') })).meta.ACCOR.asOf, '2026-11-19');
  for (const date of ['2026-11-18', '2026-11-27', '2026-02-30', '2026-11-25T12:00:00Z', null]) {
    await assert.rejects(collect({ rates: fixing(date) }), /ECB/);
  }
});

test('a same-day fixing is only available once the dataset is valid', async () => {
  const rates = fixing('2026-11-26');
  await assert.rejects(collect({ rates, asOf: new Date('2026-11-26T15:00:17.014Z') }), /ECB/);
  const published = await collect({ rates, asOf: new Date('2026-11-26T15:00:17.015Z') });
  assert.equal(published.meta.ACCOR.asOf, '2026-11-26');
});

test('refuses rates with malformed values, missing observations or unexpected series and status', async () => {
  const badFixings = [null, '1.0935', 0, -1].map(value => fixing('2026-11-25', value));
  for (const change of [
    data => { data.header.sender.id = 'other'; },
    data => { data.structure.dimensions.series[1].values[0].id = 'EUR'; },
    data => { data.structure.dimensions.series[2].values[0].id = 'USD'; },
    data => { data.dataSets[0].series['0:0:0:0:0'].observations[1] = [1.12]; },
    data => { data.structure.dimensions.observation[0].values.push({ id: '2026-11-24' }); },
    data => { data.structure.attributes.observation[0].values[0].id = 'M'; },
    data => { data.dataSets = []; },
  ]) {
    const data = fixing();
    change(data);
    badFixings.push(data);
  }
  for (const rates of badFixings) await assert.rejects(collect({ rates }), /ECB/);
});

test('compares official fixing dates, while migrating the former editorial review date', async () => {
  const official = (await collect()).meta.ACCOR;
  await assert.rejects(collect({ rates: fixing('2026-11-24'), previousMeta: official }), /predates/);
  const editorial = { source: 'https://upgradedpoints.com/travel/points-and-miles-valuations/', currency: 'USD',
    asOf: '2026-11-26', estimate: true };
  assert.equal((await collect({ previousMeta: editorial })).meta.ACCOR.asOf, '2026-11-25');
});

test('has no substitute valuation when either official source is unavailable', async () => {
  for (const unavailable of [ACCOR_VALUATION_SOURCE.url, api]) {
    await assert.rejects(collect({ unavailable }), /503/);
  }
});
