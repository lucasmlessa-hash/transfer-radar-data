import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseEndDate } from '../src/normalize.mjs';

const NOW = new Date('2026-06-01T00:00:00Z');

test('resolves bank+partner aliases into a canonical id with an ISO end date', () => {
  const { routes } = normalize(
    [{ bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 25, endDateRaw: 'July 29, 2026', sourceUrl: 'https://example.com/a' }],
    NOW,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].id, 'amex-av');
  assert.equal(routes[0].bank, 'AMEX');
  assert.equal(routes[0].code, 'AV');
  assert.equal(routes[0].active.pct, 25);
  assert.equal(routes[0].active.endDate, '2026-07-29');
});

test('an unknown partner name lands in `unmapped`, not in routes', () => {
  const { routes, unmapped } = normalize(
    [{ bankName: 'Amex', partnerName: 'Some Unknown Airline', pct: 20, endDateRaw: 'July 1, 2026', sourceUrl: 'https://example.com/a' }],
    NOW,
  );
  assert.equal(routes.length, 0);
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0].reason, /unknown partner/);
});

test('an unknown bank name lands in `unmapped`, not in routes', () => {
  const { routes, unmapped } = normalize(
    [{ bankName: 'Some Unknown Bank', partnerName: 'Avianca LifeMiles', pct: 20, endDateRaw: 'July 1, 2026', sourceUrl: 'https://example.com/a' }],
    NOW,
  );
  assert.equal(routes.length, 0);
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0].reason, /unknown bank/);
});

test('an unparseable end date publishes the route without `active`', () => {
  const { routes } = normalize(
    [{ bankName: 'Bilt', partnerName: 'Avianca LifeMiles', pct: 100, endDateRaw: '', sourceUrl: 'https://example.com/a' }],
    NOW,
  );
  assert.equal(routes.length, 1);
  assert.equal('active' in routes[0], false);
});

test('a duplicate id across two sources collapses to a single route with the max pct', () => {
  const { routes } = normalize(
    [
      { bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 20, endDateRaw: 'July 20, 2026', sourceUrl: 'https://source-a.example/' },
      { bankName: 'American Express', partnerName: 'LifeMiles', pct: 25, endDateRaw: 'July 29, 2026', sourceUrl: 'https://source-b.example/' },
    ],
    NOW,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].active.pct, 25);
  assert.equal(routes[0].active.endDate, '2026-07-29');
});

test('a duplicate id keeps the max pct regardless of which source parses first', () => {
  const { routes } = normalize(
    [
      { bankName: 'Amex', partnerName: 'Avianca LifeMiles', pct: 25, endDateRaw: 'July 29, 2026', sourceUrl: 'https://source-a.example/' },
      { bankName: 'American Express', partnerName: 'LifeMiles', pct: 20, endDateRaw: 'July 20, 2026', sourceUrl: 'https://source-b.example/' },
    ],
    NOW,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].active.pct, 25);
});

test('all four known date formats parse to the same ISO day', () => {
  assert.equal(parseEndDate('July 25, 2026', NOW), '2026-07-25');
  assert.equal(parseEndDate('7/25/26', NOW), '2026-07-25');
  assert.equal(parseEndDate('25/07', NOW), '2026-07-25');
  assert.equal(parseEndDate('until Jul 25', NOW), '2026-07-25');
});

test('an unrecognizable date string returns null', () => {
  assert.equal(parseEndDate('sometime soon', NOW), null);
  assert.equal(parseEndDate('', NOW), null);
});
