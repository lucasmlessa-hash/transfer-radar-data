import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOR_VALUATION_SOURCE } from '../src/sources/accor-point-valuation.mjs';
import { refreshAccorFixing } from '../scripts/refresh-accor-fixing.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, data) => writeFileSync(file, JSON.stringify(data));
const fixture = name => new URL(`../fixtures/${name}`, import.meta.url);
const html = readFileSync(fixture('accor-point-valuation.html'), 'utf8');
const editorial = { source: 'https://upgradedpoints.com/travel/points-and-miles-valuations/', currency: 'USD', asOf: '2026-11-26', estimate: true };

function runner(t) {
  const dir = mkdtempSync(join(tmpdir(), 'accor-fixing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = join(dir, 'partners.json'), fixingPath = join(dir, 'accor-fixing.json');
  const sample = read(new URL('../sample/partners.json', import.meta.url));
  sample.airlineValues.ACCOR = 2.2;
  sample.airlineValueMeta.ACCOR = editorial;
  write(partnersPath, sample);
  const run = async (day, rate = 1.0935, now = new Date('2026-11-26T19:00:00Z')) => {
    const fetchImpl = async url => {
      if (!day) return new Response('', { status: 503 });
      if (url === ACCOR_VALUATION_SOURCE.url) return new Response(html);
      const data = read(fixture('accor-ecb-fixing.json'));
      data.structure.dimensions.observation[0].values[0].id = day;
      data.dataSets[0].validFrom = `${day}T15:00:00Z`;
      data.dataSets[0].series['0:0:0:0:0'].observations['0'][0] = rate;
      return Response.json(data);
    };
    return refreshAccorFixing({ partnersPath, fixingPath, fetchImpl, now, sleepImpl: async () => {}, log: () => {} });
  };
  return { partnersPath, fixingPath, sample, run };
}

test('a fresh runner keeps the later intraday fixing if the sources fail or return an older day', async t => {
  const { run, partnersPath, fixingPath, sample } = runner(t);
  await run('2026-11-26', 1.105);
  const saved = read(fixingPath);
  assert.equal(saved.meta.asOf, '2026-11-26');
  assert.equal(saved.value, 2.21);
  for (const day of [null, '2026-11-25']) {
    write(partnersPath, sample);
    assert.equal((await run(day)).ok, false);
    const out = read(partnersPath);
    assert.equal(out.airlineValues.ACCOR, saved.value);
    assert.deepEqual(out.airlineValueMeta.ACCOR, saved.meta);
    assert.deepEqual(read(fixingPath), saved);
    assert.deepEqual(out.airlineValues, { ...sample.airlineValues, ACCOR: saved.value });
  }
});

test('a newer fixing verified by the daily workflow supersedes the older cache even during an outage', async t => {
  const { run, partnersPath, fixingPath } = runner(t);
  await run('2026-11-25');
  const yesterday = read(fixingPath);
  await run('2026-11-26', 1.105);
  const latest = read(fixingPath);
  write(fixingPath, yesterday);
  assert.equal((await run(null)).ok, false);
  assert.deepEqual(read(fixingPath), latest);
  assert.deepEqual(read(partnersPath).airlineValueMeta.ACCOR, latest.meta);
});

test('expired, future, corrupt or nonofficial saved quotes cannot override the daily catalog', async t => {
  const { run, partnersPath, fixingPath, sample } = runner(t);
  const unavailable = structuredClone(sample);
  delete unavailable.airlineValues.ACCOR;
  delete unavailable.airlineValueMeta.ACCOR;
  await run('2026-11-25');
  const saved = read(fixingPath);
  for (const patch of [{ asOf: '2026-11-18' }, { asOf: '2026-11-27' }, { source: editorial.source }, { fxRate: 2 }, { sourceValue: 0.025 }]) {
    write(partnersPath, sample);
    write(fixingPath, { ...saved, meta: { ...saved.meta, ...patch } });
    await run(null);
    assert.deepEqual(read(partnersPath), unavailable);
  }
  writeFileSync(fixingPath, '{');
  await run(null);
  assert.deepEqual(read(partnersPath), unavailable);
  assert.equal((await run('2026-11-26')).ok, true);
  assert.equal(read(fixingPath).meta.asOf, '2026-11-26');
});

test('first run with two unavailable sources publishes the rest of the catalog and creates no FX record', async t => {
  const { run, partnersPath, fixingPath, sample } = runner(t);
  assert.equal((await run(null)).ok, false);
  delete sample.airlineValues.ACCOR;
  delete sample.airlineValueMeta.ACCOR;
  assert.deepEqual(read(partnersPath), sample);
  assert.equal(existsSync(fixingPath), false);
});
