import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHistory } from '../src/history.mjs';
import { normalize } from '../src/normalize.mjs';
import { validateFeed } from '../scripts/validate-feed.mjs';

const now = new Date('2026-11-01T10:00:00Z');
const raw = ['1/1/2023', '7/1/2023', '1/1/2024', '7/1/2024', '1/1/2025', '7/1/2026']
  .map(startDateRaw => ({ bankName: 'Chase', partnerName: 'British Airways', pct: 30, startDateRaw, endDateRaw: startDateRaw }));
const history = rows => deriveHistory(now, rows).get('chase-ba');

test('forecast dates describe the actual calendar intervals across a year boundary', () => {
  const r = history(raw);
  assert.ok(r.forecast, 'forecast must publish its issue date and actual horizons');
  assert.equal(r.forecast.issuedAt, '2026-11-01T10:00:00.000Z');
  assert.deepEqual(r.forecast.horizons.map(h => [h.months, h.startDate, h.endDate]), [
    [1, '2026-12-01', '2026-12-31'], [3, '2026-12-01', '2027-02-28'], [6, '2026-12-01', '2027-05-31'],
  ]);
});

test('metadata keeps the frozen seasonal probabilities unchanged', () => {
  const r = history(raw);
  assert.deepEqual(r.wait, [0.062, 0.461, 0.621]);
  assert.deepEqual(r.p2, [0.483, 0.093, 0.093, 0.093, 0.093, 0.525, 0.525, 0.093, 0.093, 0.116, 0.116, 0.404]);
  assert.deepEqual(r.mp, [0.44, 0.05, 0.05, 0.05, 0.05, 0.05, 0.482, 0.05, 0.05, 0.05, 0.062, 0.062]);
});

test('limited history cannot acquire stronger evidence through duplicate or still-running windows', () => {
  const rows = raw.slice(0, 4);
  rows.push(rows[0], {...rows[0], pct:50}, { ...raw[0], startDateRaw: '11/1/2026', endDateRaw: '11/30/2026' });
  assert.equal(history(rows).forecast?.evidence.windowCount, 4);
  assert.equal(history(rows).forecast.evidence.level, 'limited');
  assert.equal(history(raw).forecast.evidence.level, 'established_history');
  assert.equal(history(raw).forecast.evidence.firstDate, '2023-01-01');
});

test('short archive remains limited even with many observed campaigns', () => {
  const rows = [1, 2, 3, 4, 5, 6].map(m => ({ ...raw[0], startDateRaw: `${m}/1/2026`, endDateRaw: `${m}/1/2026` }));
  assert.equal(history(rows).forecast?.evidence.level, 'limited');
});

test('normalization preserves forecast provenance for both inactive and active routes', () => {
  const derived = deriveHistory(now, raw);
  for (const sightings of [[], [{ ...raw[0], endDateRaw: '11/30/2026', sourceUrl: 'https://example.com/offer' }]]) {
    const r = normalize(sightings, now, derived).routes.find(r => r.id === 'chase-ba');
    assert.equal(r.forecast?.issuedAt, '2026-11-01T10:00:00.000Z');
    const doc = { version: 1, generatedAt: now.toISOString(), routes: [r] };
    assert.doesNotThrow(() => validateFeed(doc));
    const bad = structuredClone(doc);
    bad.routes[0].forecast.horizons[0].endDate = '2026-02-30';
    assert.throws(() => validateFeed(bad), /forecast.*date/i);
    bad.routes[0].forecast.horizons[0].endDate='2026-12-30';
    assert.throws(() => validateFeed(bad), /forecast.*date/i);
  }
});
