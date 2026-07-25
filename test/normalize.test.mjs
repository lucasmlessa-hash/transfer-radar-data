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

test('3-part slash dates are US M/D/Y, not D/M (frequentmiler shape)', () => {
  assert.equal(parseEndDate('07/30/26', NOW), '2026-07-30');
  assert.equal(parseEndDate('08/22/26', NOW), '2026-08-22');
});

test('2-part slash dates are Brazilian D/M, not M/D (esfera shape)', () => {
  // "26/07" can only be day 26 of month 07 - "month 26" doesn't exist -
  // but the parser must pick D/M here specifically because it's 2 parts,
  // not because the values happen to disambiguate it.
  assert.equal(parseEndDate('26/07', NOW), '2026-07-26');
});

test('an empty end date never produces an `active` block (livelo shape)', () => {
  const { routes } = normalize(
    [{ bankName: 'Livelo', partnerName: 'Hilton Honors', pct: 50, endDateRaw: '', sourceUrl: 'https://www.livelo.com.br/ofertas' }],
    NOW,
  );
  // Hilton Honors isn't a tracked partner, so this also lands in unmapped -
  // the point of this test is solely that an empty date never yields `active`.
  assert.equal(routes.length, 0);
});

test('parenthesised program suffixes resolve to the base bank/partner code (awardwallet shape)', () => {
  const { routes, unmapped } = normalize(
    [
      {
        bankName: 'Amex (Membership Rewards)',
        partnerName: 'Virgin Atlantic (Flying Club)',
        pct: 30,
        endDateRaw: 'July 31, 2026',
        sourceUrl: 'https://awardwallet.com/news/credit-card-transfer-bonuses/',
      },
      {
        bankName: 'Citibank (ThankYou Rewards)',
        partnerName: 'Air France (Flying Blue)',
        pct: 20,
        endDateRaw: 'August 22, 2026',
        sourceUrl: 'https://awardwallet.com/news/credit-card-transfer-bonuses/',
      },
    ],
    NOW,
  );
  assert.equal(unmapped.length, 0);
  assert.deepEqual(routes.map((r) => r.id).sort(), ['amex-vs', 'citi-af']);
});

test('Air France / KLM Flying Blue resolves to AF whether or not the slash is present', () => {
  const { routes } = normalize(
    [
      { bankName: 'Citi', partnerName: 'Air France KLM Flying Blue', pct: 20, endDateRaw: 'August 22, 2026', sourceUrl: 'https://a.example/' },
      { bankName: 'Citi', partnerName: 'Air France / KLM Flying Blue', pct: 20, endDateRaw: 'August 22, 2026', sourceUrl: 'https://b.example/' },
      { bankName: 'Citi', partnerName: 'Air France/KLM Flying Blue', pct: 20, endDateRaw: 'August 22, 2026', sourceUrl: 'https://c.example/' },
    ],
    NOW,
  );
  // all three variants collapse to the same id, so exactly one route comes out
  assert.equal(routes.length, 1);
  assert.equal(routes[0].code, 'AF');
});

test('an untracked bank, or a hotel partner, never becomes a route', () => {
  // Every row is half-tracked on purpose, so this keeps biting as alias
  // coverage grows rather than decaying into a list of names someone will
  // legitimately add one day: Lufthansa and Qantas Frequent Flyer ARE tracked
  // (LH, QF) and Chase IS a tracked bank. What must keep each row out of
  // `routes` is the untracked *other* half - an unknown bank, or a hotel
  // program, which is never an airline route no matter who the bank is.
  //
  // Brex, PAYBACK, Frontier Miles and IHG are chosen because they sit outside
  // the product's route model on purpose, not because coverage happens to be
  // incomplete today. Rove/Qantas used to fill the "untracked bank" role here
  // until Rove was added as a tracked bank - rove-qf is now a correct, live
  // route. If a future coverage expansion tracks one of the names below too,
  // re-point that row at another name still outside the model rather than
  // deleting the test.
  const cases = [
    [{ bankName: 'Brex', partnerName: 'Frontier Miles', pct: 25, endDateRaw: '07/31/26', sourceUrl: 'https://fm.example/' }, /unknown bank/],
    [{ bankName: 'PAYBACK', partnerName: 'Lufthansa (Miles and More)', pct: 10, endDateRaw: 'July 31, 2026', sourceUrl: 'https://aw.example/' }, /unknown bank/],
    [{ bankName: 'PAYBACK', partnerName: 'Qantas (Frequent Flyer)', pct: 50, endDateRaw: 'August 14, 2026', sourceUrl: 'https://aw.example/' }, /unknown bank/],
    [{ bankName: 'Chase Ultimate Rewards', partnerName: 'IHG', pct: 100, endDateRaw: '07/30/26', sourceUrl: 'https://fm.example/' }, /unknown partner/],
  ];

  const { routes, unmapped } = normalize(cases.map(([raw]) => raw), NOW);
  assert.equal(routes.length, 0, `no route may be invented, got: [${routes.map((r) => r.id).join(', ')}]`);
  assert.equal(unmapped.length, cases.length);
  // reason per row, not just a count: if one of these names ever does become
  // tracked, this fails loudly at the exact row instead of silently shifting.
  cases.forEach(([raw, reason], i) => {
    assert.equal(unmapped[i].bankName, raw.bankName);
    assert.match(unmapped[i].reason, reason);
  });

  // Proof the fixture isn't vacuously empty: the same Lufthansa row under a
  // TRACKED bank does resolve, so it really is the bank check doing the work
  // above - not a normalize() that stopped emitting routes altogether.
  const { routes: withTrackedBank } = normalize([{ ...cases[1][0], bankName: 'Amex' }], NOW);
  assert.deepEqual(withTrackedBank.map((r) => r.id), ['amex-lh']);
});
