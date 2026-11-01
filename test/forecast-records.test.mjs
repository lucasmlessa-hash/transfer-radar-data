import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as records from '../src/forecast-records.mjs';
import { runPipeline } from '../src/publish.mjs';

const route = { id: 'chase-ba', bank: 'CHASE', code: 'BA', airline: 'British Airways', forecast: {
  modelVersion: 'seasonal-wait-v1', issuedAt: '2026-11-01T10:00:00Z',
  evidence: { windowCount: 8, firstDate: '2020-01-01', lastDate: '2026-09-30', spanMonths: 81, level: 'established_history' },
  horizons: [{ months: 1, startDate: '2026-12-01', endDate: '2026-12-31', probability: 0.7 }],
} };
const feed = (at, routes = [route], failed = false) => ({ generatedAt: at, routes, health: { sources: {
  frequentmiler: { status: failed ? 'failed' : 'ok' }, awardwallet: { status: 'ok' },
} } });
const update = (state, f, offers = []) => records.updateForecastRecords(state, f, offers);

test('every route gets a prospective record even when no promotion appears', () => {
  const s = update(null, feed('2026-11-01T10:00:00Z'));
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].probability, 0.7);
  assert.equal(s.records[0].status, 'pending');
  assert.equal(s.records[0].publicationStatus, 'unconfirmed');
  assert.equal(s.records[0].publishedAt, null);
  assert.equal(s.records[0].key, '2026-11-01T10:00:00Z|chase-ba|seasonal-wait-v1|1');
  assert.equal(s.records[0].startDate, '2026-12-01');
  assert.equal(s.records[0].endDate, '2026-12-31');
  const changed = structuredClone(route); changed.forecast.horizons[0].probability = 0.9;
  const next = update(s, feed('2026-11-01T11:00:00Z', [changed]));
  assert.equal(next.records.length, 1);
  assert.equal(next.records[0].probability, 0.7, 'the same issuance is not rewritten after new evidence');
  assert.deepEqual(update(next, feed('2026-11-01T11:00:00Z', [changed])), next);
});

test('a failed publication and a same-day retry remain separate and only the published value scores', () => {
  const firstFeed = feed('2026-11-01T10:00:00Z');
  const first = update(null, firstFeed);
  const retry = structuredClone(route);
  retry.forecast.issuedAt = '2026-11-01T11:00:00Z';
  retry.forecast.horizons[0].probability = 0.9;
  const retryFeed = feed('2026-11-01T11:00:00Z', [retry]);
  const attempted = update(first, retryFeed);
  assert.equal(attempted.records.length, 2);
  assert.deepEqual(attempted.records.map(r => r.probability), [0.7, 0.9]);
  assert.notEqual(attempted.records[0].key, attempted.records[1].key);
  const confirmed = records.confirmForecastPublication(attempted, retryFeed, '2026-11-01T11:01:00Z');
  assert.equal(confirmed.records[0].publicationStatus, 'unconfirmed');
  assert.equal(confirmed.records[1].publicationStatus, 'confirmed');
  assert.equal(confirmed.records[1].publishedAt, '2026-11-01T11:01:00Z');
  assert.equal(attempted.records[1].publicationStatus, 'unconfirmed', 'confirmation must not mutate the supplied ledger');
  const mature = historyLedger(confirmed.records.map(r => ({ ...r, status: 'not_observed', resolvedAt: '2027-01-01T00:00:00Z' })));
  const report = records.forecastHistoryReport(mature);
  assert.equal(report.records[0].evaluationExclusion, 'unpublished');
  assert.equal(report.records[1].evaluationEligible, true);
  assert.equal(report.metrics[0].n, 1);
  assert.equal(report.metrics[0].predictedRate, 0.9);
  assert.equal(report.metrics[0].brier, 0.81);
});

const reissue = (at, mutate = () => {}) => {
  const supplied = structuredClone(route);
  supplied.forecast.issuedAt = at;
  mutate(supplied);
  return feed(at, [supplied]);
};

test('six confirmed collections retain one identical daily cohort and all observation samples', () => {
  let state = null;
  let original;
  for (const hour of ['01', '05', '09', '13', '17', '21']) {
    const issued = reissue(`2026-11-01T${hour}:00:00Z`);
    state = update(state, issued);
    state = records.confirmForecastPublication(state, issued, `2026-11-01T${hour}:01:00Z`);
    if (!original) original = structuredClone(state.records[0]);
  }
  assert.equal(state.records.length, 1);
  assert.equal(state.samples.length, 6);
  assert.deepEqual(state.records[0], original, 'republication never presents the original cohort as newly issued');
  const nextDay = reissue('2026-11-02T01:00:00Z');
  state = update(state, nextDay);
  assert.equal(state.records.length, 2);
  assert.equal(state.samples.length, 7);
  assert.equal(state.records[1].issuedAt, '2026-11-02T01:00:00Z');
  assert.equal(state.records[1].publicationStatus, 'unconfirmed');
});

test('daily deduplication preserves changed odds, windows and evidence after confirmation', () => {
  const firstFeed = reissue('2026-11-01T01:00:00Z');
  const first = records.confirmForecastPublication(update(null, firstFeed), firstFeed, '2026-11-01T01:01:00Z');
  for (const mutate of [
    r => { r.forecast.horizons[0].probability = 0.9; },
    r => { r.forecast.horizons[0].startDate = '2026-12-02'; },
    r => { r.forecast.horizons[0].endDate = '2026-12-30'; },
    r => { r.forecast.evidence.windowCount = 9; },
    r => { r.active = { pct: 20, endDate: '2026-11-30' }; },
  ]) {
    const next = update(first, reissue('2026-11-01T05:00:00Z', mutate));
    assert.equal(next.records.length, 2);
    assert.deepEqual(next.records[0], first.records[0]);
    assert.equal(next.records[1].publicationStatus, 'unconfirmed');
  }
  const reordered = update(first, reissue('2026-11-01T05:00:00Z', r => {
    r.forecast.evidence = Object.fromEntries(Object.entries(r.forecast.evidence).reverse());
  }));
  assert.equal(reordered.records.length, 1, 'property order is not new evidence');
});

test('identical failed attempts remain distinct until their own exact publication is confirmed', () => {
  const failedFeed = reissue('2026-11-01T01:00:00Z');
  const failed = update(null, failedFeed);
  const retryFeed = reissue('2026-11-01T05:00:00Z');
  const attempts = update(failed, retryFeed);
  assert.equal(attempts.records.length, 2);
  const confirmed = records.confirmForecastPublication(attempts, retryFeed, '2026-11-01T05:01:00Z');
  assert.equal(confirmed.records[0].publicationStatus, 'unconfirmed');
  assert.equal(confirmed.records[1].publicationStatus, 'confirmed');
  const repeated = update(confirmed, reissue('2026-11-01T09:00:00Z'));
  assert.equal(repeated.records.length, 2);
  assert.deepEqual(repeated.records, confirmed.records, 'deduplication must retain the failed attempt as well');
});

test('ledger serialization preserves all data with one compact record or sample per line', () => {
  const state = update(null, reissue('2026-11-01T01:00:00Z'));
  state.note = { retained: 'metadata also survives' };
  const before = structuredClone(state);
  const serialized = records.serializeForecastRecords(state);
  assert.deepEqual(JSON.parse(serialized), state);
  assert.deepEqual(state, before);
  assert.ok(serialized.split('\n').includes(JSON.stringify(state.records[0])));
  assert.ok(serialized.split('\n').includes(JSON.stringify(state.samples[0])));
  assert.ok(serialized.length < JSON.stringify(state, null, 2).length);
  assert.deepEqual(JSON.parse(records.serializeForecastRecords({ version: 1, records: [], samples: [] })),
    { version: 1, records: [], samples: [] });
  assert.throws(() => records.serializeForecastRecords({ version: 1, records: [], samples: null }), /invalid forecast ledger/);
});

test('publication confirmation requires the exact forecast identity and is idempotent', () => {
  const issued = feed('2026-11-01T10:00:00Z');
  const state = update(null, issued);
  for (const mutate of [
    f => { f.routes[0].id = 'another-route'; },
    f => { f.routes[0].forecast.modelVersion = 'another-model'; },
    f => { f.routes[0].forecast.issuedAt = '2026-11-01T09:00:00Z'; },
    f => { f.routes[0].forecast.horizons[0].months = 3; },
    f => { f.routes[0].forecast.horizons[0].startDate = '2026-12-02'; },
    f => { f.routes[0].forecast.horizons[0].endDate = '2026-12-30'; },
    f => { f.routes[0].forecast.horizons[0].probability = 0.9; },
  ]) {
    const different = structuredClone(issued); mutate(different);
    assert.deepEqual(records.confirmForecastPublication(state, different, '2026-11-01T10:01:00Z'), state);
  }
  for (const at of ['2026-11-01T09:59:59Z', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z']) {
    assert.deepEqual(records.confirmForecastPublication(state, issued, at), state);
  }
  const confirmed = records.confirmForecastPublication(state, issued, '2026-11-01T10:01:00Z');
  assert.equal(confirmed.records[0].publishedAt, '2026-11-01T10:01:00Z');
  assert.deepEqual(records.confirmForecastPublication(confirmed, issued, '2026-11-01T10:02:00Z'), confirmed);
  assert.deepEqual(records.confirmForecastPublication(confirmed, issued, '2027-01-01T00:00:00Z'), confirmed);
  assert.throws(() => records.confirmForecastPublication(state, issued, 'not-a-date'), /invalid publication date/);
});

test('publication confirmation may retain excluded forecasts without adding them to accuracy', () => {
  for (const availability of ['offer_present', 'unavailable']) {
    const supplied = structuredClone(route);
    if (availability === 'offer_present') supplied.active = { pct: 20, endDate: '2026-11-30' };
    else supplied.forecast.horizons[0].probability = null;
    const issued = feed('2026-11-01T10:00:00Z', [supplied]);
    const confirmed = records.confirmForecastPublication(update(null, issued), issued, '2026-11-01T10:01:00Z');
    assert.equal(confirmed.records[0].publicationStatus, 'confirmed');
    const report = records.forecastHistoryReport(confirmed);
    assert.equal(report.records[0].evaluationExclusion, availability);
    assert.deepEqual(report.metrics, []);
  }
});

test('missing model evidence is recorded as unavailable, not a probability of zero', () => {
  const s = update(null, feed('2026-11-01T10:00:00Z', [{ id: 'liv-ad', bank: 'LIV' }]));
  assert.equal(s.records.length, 3);
  assert.equal(s.records[0].probability, null);
  assert.equal(s.records[0].availability, 'unavailable');
});

test('issued route names and the first positive observation remain unchanged', () => {
  const initial = update(null, feed('2026-11-01T10:00:00Z'));
  assert.equal(initial.records[0].code, 'BA');
  assert.equal(initial.records[0].airline, 'British Airways');
  const original = structuredClone(initial.records[0]);
  const changed = structuredClone(route);
  changed.code = 'XX'; changed.airline = 'Renamed program';
  changed.forecast.horizons[0].probability = 0.99;
  const reissued = update(initial, feed('2026-11-01T11:00:00Z', [changed]));
  assert.deepEqual(reissued.records[0], original);
  const offer = pct => [{ id: route.id, active: { pct, endDate: '2026-12-31' }, offerEvidence: { status: 'observed' } }];
  const first = update(reissued, feed('2026-12-10T06:00:00Z', []), offer(25));
  assert.deepEqual(first.records[0].observation, { observedAt: '2026-12-10T06:00:00Z', pct: 25 });
  assert.equal(first.records[0].resolvedAt, '2026-12-10T06:00:00Z');
  assert.deepEqual(update(first, feed('2026-12-10T06:00:00Z', []), offer(90)), first);
  const later = update(first, feed('2026-12-11T06:00:00Z', []), offer(90));
  assert.deepEqual(later.records[0], first.records[0]);
  assert.deepEqual(initial.records[0], original, 'updating observations cannot mutate the previous ledger');
});

test('new numeric predictions with limited evidence are displayed while legacy limited records stay unchanged', () => {
  const limited = structuredClone(route);
  limited.forecast.modelVersion = 'pooled-recurrence-v2';
  limited.forecast.evidence.level = 'limited';
  const current = update(null, feed('2026-11-01T10:00:00Z', [limited]));
  assert.equal(current.records[0].availability, 'displayed');
  const legacy = update(null, feed('2026-11-01T10:00:00Z'));
  legacy.records[0].availability = 'limited';
  delete legacy.records[0].airline;
  delete legacy.records[0].code;
  const next = update(legacy, feed('2026-11-01T11:00:00Z', [limited]));
  assert.deepEqual(next.records[0], legacy.records[0]);
  assert.equal(next.records[1].availability, 'displayed');
  assert.equal(next.records[1].modelVersion, 'pooled-recurrence-v2');
});

test('an issued prediction owns a snapshot of its evidence metadata', () => {
  const supplied = structuredClone(route);
  const state = update(null, feed('2026-11-01T10:00:00Z', [supplied]));
  supplied.forecast.evidence.windowCount = 100;
  supplied.forecast.evidence.level = 'limited';
  assert.equal(state.records[0].evidence.windowCount, 8);
  assert.equal(state.records[0].evidence.level, 'established_history');
});

function coverage({ gap = false, failed = false, positive = false } = {}) {
  const issued = feed('2026-11-01T10:00:00Z');
  let s = records.confirmForecastPublication(update(null, issued), issued, '2026-11-01T10:01:00Z');
  // Cover both boundaries and every six hours. No new forecasts are issued
  // during resolution: this fixture isolates one published prediction.
  for (let t = Date.parse('2026-12-01T00:00:00Z'); t <= Date.parse('2027-01-01T00:00:00Z'); t += 6 * 3600000) {
    if (gap && t === Date.parse('2026-12-15T06:00:00Z')) continue;
    const at = new Date(t).toISOString();
    const offers = positive && at.startsWith('2026-12-15T06:') ? [{ id: 'chase-ba', active: { pct: 20, endDate: '2026-12-20' }, offerEvidence: { status: 'observed' } }] : [];
    s = update(s, feed(at, [], failed && at.startsWith('2026-12-15T06:')), offers);
  }
  return s;
}

test('negative outcomes require complete healthy coverage including both boundaries', () => {
  assert.equal(coverage().records[0].status, 'not_observed');
  assert.equal(coverage({ gap: true }).records[0].status, 'unknown');
  assert.equal(coverage({ failed: true }).records[0].status, 'unknown');
  let s = update(null, feed('2026-11-01T10:00:00Z'));
  s = update(s, feed('2027-01-01T00:00:00Z', []));
  assert.equal(s.records[0].status, 'unknown');
});

test('a positive sighting is recorded without pretending that other days were covered', () => {
  const s = coverage({ gap: true, positive: true });
  // The deliberately missing sample is the proposed sighting itself: still unknown.
  assert.equal(s.records[0].status, 'unknown');
  assert.equal(coverage({ failed: true, positive: true }).records[0].status, 'observed');
});

const historyRecord = overrides => ({
  key: 'first', routeId: 'chase-ba', bank: 'CHASE', code: 'BA', airline: 'British Airways',
  modelVersion: 'pooled-recurrence-v2', issuedAt: '2026-11-01T10:00:00Z', recordedAt: '2026-11-01T10:00:00Z',
  months: 1, startDate: '2026-12-01', endDate: '2026-12-31', probability: 0.8,
  availability: 'displayed', requiredSources: ['frequentmiler', 'awardwallet'],
  publicationStatus: 'confirmed', publishedAt: '2026-11-01T10:01:00Z',
  status: 'observed', resolvedAt: '2026-12-15T06:00:00Z',
  observation: { observedAt: '2026-12-15T06:00:00Z', pct: 20 },
  ...overrides,
});

function historyLedger(originals, asOf = '2027-01-01T00:00:00Z') {
  const samples = [];
  for (let t = Date.parse('2026-12-01T00:00:00Z'); t <= Date.parse(asOf); t += 6 * 3600000) {
    samples.push({
      at: new Date(t).toISOString(), sources: { frequentmiler: 'ok', awardwallet: 'ok' },
      offers: originals.filter(r => r.status === 'observed' && Date.parse(r.observation?.observedAt) === t)
        .map(r => ({ id: r.routeId, pct: r.observation.pct })),
      uncertainRoutes: [],
    });
  }
  return { version: 1, records: originals, samples };
}

test('empty history has no fabricated predictions or accuracy', () => {
  assert.equal(typeof records.forecastHistoryReport, 'function');
  assert.deepEqual(records.forecastHistoryReport({ version: 1, records: [], samples: [] }), {
    version: 1, status: 'ok', asOf: null, startedAt: null, records: [], metrics: [],
  });
  assert.throws(() => records.forecastHistoryReport({ version: 1, records: [], samples: null }), /invalid forecast ledger/);
});

test('history preserves every original but scores the first emission per route, model and window', () => {
  const originals = [
    historyRecord({ key: 'later-better', probability: 0.99, issuedAt: '2026-11-02T10:00:00Z', recordedAt: '2026-11-02T10:00:00Z', publishedAt: '2026-11-02T10:01:00Z' }),
    historyRecord({ key: 'first' }),
    historyRecord({ key: 'negative', routeId: 'chase-vs', probability: 0.5, status: 'not_observed', resolvedAt: '2027-01-01T00:00:00Z', observation: undefined }),
    historyRecord({ key: 'low-positive', routeId: 'amex-ba', probability: 0.2 }),
    historyRecord({ key: 'old-model', modelVersion: 'seasonal-wait-v1', probability: 0.1 }),
    historyRecord({ key: 'three-months', routeId: 'chase-af', months: 3, endDate: '2027-02-28', probability: 0.9, status: 'not_observed', resolvedAt: '2027-03-01T00:00:00Z', observation: undefined }),
  ];
  const state = historyLedger(originals, '2027-03-01T00:00:00Z');
  state.samples.reverse();
  const before = structuredClone(state);
  const report = records.forecastHistoryReport(state);
  assert.equal(report.asOf, '2027-03-01T00:00:00.000Z');
  assert.equal(report.startedAt, '2026-11-01T10:00:00Z');
  assert.deepEqual(report.records.map(({ coverageComplete, evaluationEligible, evaluationExclusion, ...original }) => original), originals);
  assert.equal(report.records[0].evaluationExclusion, 'duplicate_window');
  assert.equal(report.records[0].evaluationEligible, false);
  assert.equal(report.records[1].evaluationEligible, true);
  assert.equal(report.records[1].coverageComplete, true);
  const main = report.metrics.find(m => m.months === 1 && m.modelVersion === 'pooled-recurrence-v2');
  assert.equal(main.n, 3, 'daily reissues cannot add observations or replace the first probability');
  assert.equal(main.predictedRate, 0.5);
  assert.equal(main.observedRate, 2 / 3);
  assert.ok(Math.abs(main.brier - 0.31) < 1e-12);
  assert.equal(main.trendAccuracy, 1 / 3, 'exactly 50% predicts a promotion');
  assert.ok(Math.abs(main.baselineBrier - 2 / 9) < 1e-12);
  assert.equal(main.pending, 0);
  assert.equal(main.unknown, 0);
  assert.equal(report.metrics.length, 3);
  assert.equal(report.metrics.find(m => m.modelVersion === 'seasonal-wait-v1').n, 1);
  assert.equal(report.metrics.find(m => m.months === 3).n, 1);
  assert.deepEqual(state, before, 'reporting cannot mutate the ledger');
  report.records[1].observation.pct = 90;
  assert.deepEqual(state, before, 'the report must not expose mutable references to original records');
});

test('positive sightings do not enter metrics until the full window ends in UTC', () => {
  const state = historyLedger([
    historyRecord({ key: 'positive' }),
    historyRecord({ key: 'still-open', routeId: 'chase-vs', status: 'pending', observation: undefined, resolvedAt: undefined }),
  ], '2026-12-31T18:00:00Z');
  state.samples.push({ at: '2026-12-31T23:59:59.999Z', sources: { frequentmiler: 'ok', awardwallet: 'ok' }, offers: [], uncertainRoutes: [] });
  const open = records.forecastHistoryReport(state);
  assert.equal(open.records[0].status, 'observed');
  assert.equal(open.records[0].coverageComplete, null);
  assert.equal(open.records[0].evaluationExclusion, 'window_open');
  assert.deepEqual(open.metrics[0], {
    months: 1, modelVersion: 'pooled-recurrence-v2', n: 0,
    predictedRate: null, observedRate: null, brier: null, trendAccuracy: null, baselineBrier: null,
    pending: 2, unknown: 0,
  });
  const closed = update(state, feed('2027-01-01T00:00:00Z', []));
  const report = records.forecastHistoryReport(closed);
  assert.equal(report.metrics[0].n, 2);
  assert.equal(report.metrics[0].pending, 0);
});

test('mature observed promotions with missing collection remain visible but cannot bias accuracy', () => {
  const state = coverage({ failed: true, positive: true });
  assert.equal(state.records[0].status, 'observed');
  const report = records.forecastHistoryReport(state);
  assert.equal(report.records[0].status, 'observed');
  assert.deepEqual(report.records[0].observation, { observedAt: '2026-12-15T06:00:00.000Z', pct: 20 });
  assert.equal(report.records[0].coverageComplete, false);
  assert.equal(report.records[0].evaluationEligible, false);
  assert.equal(report.records[0].evaluationExclusion, 'incomplete_coverage');
  assert.equal(report.metrics[0].n, 0);
  assert.equal(report.metrics[0].unknown, 1);
  assert.equal(report.metrics[0].brier, null);
  const unknown = records.forecastHistoryReport(coverage({ gap: true }));
  assert.equal(unknown.metrics[0].n, 0);
  assert.equal(unknown.metrics[0].unknown, 1);
});

test('ineligible and missing predictions never score or get replaced by favorable reissues', () => {
  const state = historyLedger([
    historyRecord({ key: 'eligible' }),
    ...['unavailable', 'late_record', 'offer_present', 'limited'].map(availability => historyRecord({ key: availability, routeId: availability, availability })),
    historyRecord({ key: 'missing-probability', routeId: 'missing', probability: null }),
    historyRecord({ key: 'mislabelled-late', routeId: 'late', recordedAt: '2026-12-01T00:00:00Z' }),
    historyRecord({ key: 'future-window', routeId: 'future', endDate: '2027-01-31', status: 'pending', observation: undefined, resolvedAt: undefined }),
    historyRecord({ key: 'mature-pending', routeId: 'pending', status: 'pending', observation: undefined, resolvedAt: undefined }),
    historyRecord({ key: 'unknown', routeId: 'unknown', status: 'unknown', observation: undefined, resolvedAt: '2027-01-01T00:00:00Z' }),
    historyRecord({ key: 'first-unavailable', routeId: 'unavailable-first', availability: 'unavailable', probability: null }),
    historyRecord({ key: 'later-displayed', routeId: 'unavailable-first', probability: 0.99, issuedAt: '2026-11-02T10:00:00Z', recordedAt: '2026-11-02T10:00:00Z', publishedAt: '2026-11-02T10:01:00Z' }),
  ]);
  const report = records.forecastHistoryReport(state);
  assert.equal(report.metrics[0].n, 1);
  assert.equal(report.metrics[0].pending, 2);
  assert.equal(report.metrics[0].unknown, 1);
  assert.equal(report.records.find(r => r.key === 'later-displayed').evaluationExclusion, 'duplicate_window');
  assert.equal(report.records.find(r => r.key === 'mislabelled-late').evaluationExclusion, 'unpublished');
  assert.equal(report.records.find(r => r.key === 'missing-probability').evaluationExclusion, 'missing_probability');
  assert.equal(report.records.find(r => r.key === 'limited').evaluationExclusion, 'limited');
});

test('first confirmed publication wins before outcomes or probability are inspected', () => {
  const earlierIssuePublishedLater = historyRecord({ key: 'published-later', probability: 0.99, publishedAt: '2026-11-03T10:00:00Z' });
  const firstPublished = historyRecord({ key: 'first-published', probability: 0.2,
    issuedAt: '2026-11-02T10:00:00Z', recordedAt: '2026-11-02T10:00:00Z', publishedAt: '2026-11-02T10:01:00Z',
    status: 'unknown', observation: undefined, resolvedAt: '2027-01-01T00:00:00Z' });
  const report = records.forecastHistoryReport(historyLedger([earlierIssuePublishedLater, firstPublished]));
  assert.equal(report.records[0].evaluationExclusion, 'duplicate_window');
  assert.equal(report.records[1].evaluationExclusion, 'unknown');
  assert.equal(report.metrics[0].n, 0, 'a later observed outcome cannot replace the first published unknown');
  assert.equal(report.metrics[0].unknown, 1);
});

test('legacy records without publication proof remain original and never imply published accuracy', () => {
  const legacy = historyRecord({ key: '2026-11-01|chase-ba|pooled-recurrence-v2|1' });
  delete legacy.publicationStatus;
  delete legacy.publishedAt;
  const state = historyLedger([legacy]);
  const report = records.forecastHistoryReport(state);
  assert.equal(report.records[0].evaluationExclusion, 'unpublished');
  assert.equal(report.records[0].evaluationEligible, false);
  assert.equal('publishedAt' in report.records[0], false);
  assert.deepEqual(report.metrics, []);
  const sameIssuance = structuredClone(route);
  sameIssuance.forecast.modelVersion = legacy.modelVersion;
  sameIssuance.forecast.horizons[0].probability = legacy.probability;
  const next = update(state, feed('2027-01-01T00:00:00Z', [sameIssuance]));
  assert.equal(next.records.length, 1, 'changing key format must not duplicate an existing legacy issuance');
  assert.deepEqual(next.records[0], legacy);
});

test('legacy ledgers without names or positive observation details still load and report faithfully', () => {
  const state = coverage({ positive: true });
  delete state.records[0].code;
  delete state.records[0].airline;
  delete state.records[0].observation;
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-forecast-legacy-'));
  try {
    const ledger = path.join(dir, 'records.json');
    writeFileSync(ledger, JSON.stringify(state));
    const loaded = records.loadForecastRecords(ledger);
    assert.equal(loaded.ok, true);
    const report = records.forecastHistoryReport(loaded.state);
    assert.equal(report.records[0].status, 'observed');
    assert.equal(report.records[0].probability, 0.7);
    assert.equal('observation' in report.records[0], false, 'do not reconstruct original facts retrospectively');
    assert.equal('airline' in report.records[0], false);
    assert.equal('code' in report.records[0], false);
    assert.equal(report.metrics[0].n, 1);
    assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')), state);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt records are preserved and a rejected feed does not create a new ledger', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-forecast-records-'));
  try {
    const ledger = path.join(dir, 'records.json');
    writeFileSync(ledger, '{broken');
    assert.equal(records.loadForecastRecords(ledger).ok, false);
    await runPipeline({ fixtures: true, outDir: path.join(dir, 'out'), forecastLedgerPath: ledger });
    assert.equal(readFileSync(ledger, 'utf8'), '{broken');
    const report=JSON.parse(readFileSync(path.join(dir,'out','forecast-evaluation.json'),'utf8'));
    assert.equal(report.status,'unavailable');
    assert.equal(report.counts,undefined);
    const fresh = path.join(dir, 'new.json');
    const result = await runPipeline({ fixtures: true, outDir: path.join(dir, 'bad'), forecastLedgerPath: fresh, injectBadRoute: true });
    assert.equal(result.ok, false);
    assert.equal(existsSync(fresh), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
