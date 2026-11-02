import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateForecastRecords, confirmForecastPublication, forecastHistoryReport, serializeForecastRecords } from '../src/forecast-records.mjs';

const issuedAt = '2026-11-02T13:00:00Z';
const evidence = { windowCount: 9, firstDate: '2022-11-01', lastDate: '2026-09-30', spanMonths: 47, level: 'established_history' };
const context = { campaignsThisYear: 2, campaignsLast365Days: 3, annualMedian: 2, completeYears: 3,
  daysSinceLastStart: 82, daysSinceLastEnd: 33, medianIntervalDays: 172, recentIntervalsDays: [128, 133], nextCampaignOrdinal: 3 };
const route = () => ({ id: 'chase-ac', bank: 'CHASE', code: 'AC', airline: 'Air Canada Aeroplan', forecast: {
  modelVersion: 'recurrence-hazard-v3', issuedAt, target: 'campaign_start', horizonMode: 'rolling_days', evidence: structuredClone(evidence),
  context: structuredClone(context), horizons: [{ months: 1, days: 30, startDate: '2026-11-03', endDate: '2026-12-02', probability: 0.25 }],
} });
const feed = (at = issuedAt, routes = []) => ({ generatedAt: at, routes, health: { sources: {
  frequentmiler: { status: 'ok' }, awardwallet: { status: 'ok' },
} } });
const sighting = (startDate, endDate = '2026-12-15', key = 'active') => [{ id: 'chase-ac', [key]: { pct: 20, ...(startDate ? { startDate } : {}), endDate }, offerEvidence: { status: 'observed' } }];
const issue = (routes = [route()], previous = null, observed = []) => {
  const f = feed(issuedAt, routes);
  return confirmForecastPublication(updateForecastRecords(previous, f, observed), f, '2026-11-02T13:01:00Z');
};

test('new campaign records freeze their target, rolling horizon and explanatory context', () => {
  const r = route(), state = issue([r]);
  assert.equal(state.records[0].target, 'campaign_start');
  assert.equal(state.records[0].horizonMode, 'rolling_days');
  assert.equal(state.records[0].days, 30);
  assert.deepEqual(state.records[0].context, context);
  r.forecast.context.campaignsThisYear = 999;
  assert.equal(state.records[0].context.campaignsThisYear, 2);
  assert.deepEqual(JSON.parse(serializeForecastRecords(state)), state);
});

function additiveRoute() {
  const result = route();
  result.nextCampaignForecast = structuredClone(result.forecast);
  result.forecast = { modelVersion: 'pooled-recurrence-v2', issuedAt, evidence: structuredClone(evidence),
    horizons: [{ months: 1, startDate: '2026-12-01', endDate: '2026-12-31', probability: 0.481 }] };
  return result;
}

test('an additive feed records both models on the same route and confirms both original fields', () => {
  const r = additiveRoute(), f = feed(issuedAt, [r]);
  const original = updateForecastRecords(null, f);
  assert.equal(original.records.length, 2);
  assert.deepEqual(original.records.map(record => record.modelVersion), ['pooled-recurrence-v2', 'recurrence-hazard-v3']);
  assert.equal(original.records[0].target, undefined);
  assert.equal(original.records[1].forecastField, 'nextCampaignForecast');
  assert.deepEqual(original.records[1].context, context);
  const confirmed = confirmForecastPublication(original, f, '2026-11-02T13:01:00Z');
  assert.deepEqual(confirmed.records.map(record => record.publicationStatus), ['confirmed', 'confirmed']);
  assert.deepEqual(original.records.map(record => record.publicationStatus), ['unconfirmed', 'unconfirmed']);
  assert.deepEqual(forecastHistoryReport(confirmed).metrics.map(m => m.modelVersion).sort(), ['pooled-recurrence-v2', 'recurrence-hazard-v3']);
});

test('publishing a prediction under another field cannot confirm its originally recorded artifact', () => {
  const f = feed(issuedAt, [additiveRoute()]), original = updateForecastRecords(null, f);
  const swapped = structuredClone(f);
  [swapped.routes[0].forecast, swapped.routes[0].nextCampaignForecast] = [swapped.routes[0].nextCampaignForecast, swapped.routes[0].forecast];
  const unmatched = confirmForecastPublication(original, swapped, '2026-11-02T13:01:00Z');
  assert.deepEqual(unmatched.records.map(record => record.publicationStatus), ['unconfirmed', 'unconfirmed']);
  const missing = structuredClone(f); delete missing.routes[0].nextCampaignForecast;
  assert.deepEqual(confirmForecastPublication(original, missing, '2026-11-02T13:01:00Z').records.map(r => r.publicationStatus), ['confirmed', 'unconfirmed']);
});

test('confirmation cannot change target, horizon mode, or day count of the issued artifact', () => {
  const f = feed(issuedAt, [route()]), original = updateForecastRecords(null, f);
  for (const mutate of [
    r => { delete r.forecast.target; delete r.forecast.horizonMode; delete r.forecast.horizons[0].days; },
    r => { r.forecast.target = 'bonus_available'; },
    r => { r.forecast.horizonMode = 'calendar_months'; },
    r => { r.forecast.horizons[0].days = 31; },
  ]) {
    const changed = structuredClone(f); mutate(changed.routes[0]);
    assert.equal(confirmForecastPublication(original, changed, '2026-11-02T13:01:00Z').records[0].publicationStatus, 'unconfirmed');
  }
});

test('a continuing bonus is a legacy success but not a newly started campaign', () => {
  const modern = route(), legacy = route();
  legacy.forecast.modelVersion = 'pooled-recurrence-v2';
  delete legacy.forecast.target; delete legacy.forecast.horizonMode; delete legacy.forecast.context;
  delete legacy.forecast.horizons[0].days;
  const state = issue([modern, legacy]);
  const beforeLegacy = structuredClone(state.records[1]);
  const observed = updateForecastRecords(state, feed('2026-11-05T06:00:00Z'), sighting('2026-10-25'));
  assert.equal(observed.records[0].status, 'pending');
  assert.equal(observed.records[1].status, 'observed');
  assert.equal('target' in observed.records[1], false);
  assert.equal(observed.records[1].probability, beforeLegacy.probability);
  const started = updateForecastRecords(state, feed('2026-11-05T06:00:00Z'), sighting('2026-11-05'));
  assert.equal(started.records[0].status, 'observed');
  assert.equal(started.records[0].observation.startDate, '2026-11-05');
  assert.ok(started.samples.at(-1).offers[0].campaignId);
});

test('a changed listing start inside the previous campaign is an extension, not a new success', () => {
  let state = updateForecastRecords(null, feed('2026-11-01T06:00:00Z'), sighting('2026-10-25', '2026-11-10'));
  state = issue([route()], state);
  state = updateForecastRecords(state, feed('2026-11-05T06:00:00Z'), sighting('2026-11-05', '2026-11-30'));
  assert.equal(state.records[0].status, 'pending');
  assert.equal(state.samples.at(-1).offers[0].campaignStartDate, '2026-10-25');
  assert.equal(state.samples.at(-1).offers[0].campaignId, state.samples[0].offers[0].campaignId);
});

test('a campaign announced before issuance does not become a prospective success', () => {
  let state = updateForecastRecords(null, feed('2026-11-01T06:00:00Z'), sighting('2026-11-10', '2026-11-30', 'upcoming'));
  state = issue([route()], state);
  assert.equal(state.records[0].availability, 'offer_present', 'previously announced events must be excluded even if this feed omitted the announcement');
  state = updateForecastRecords(state, feed('2026-11-10T06:00:00Z'), sighting('2026-11-10', '2026-11-30'));
  assert.equal(state.records[0].status, 'pending');
  assert.equal(state.samples.at(-1).offers[0].knownAt, '2026-11-01T06:00:00Z');
});

test('a previously known offer with an unknown start cannot become a new success when the source fills a contradictory date', () => {
  let state=updateForecastRecords(null,feed('2026-11-01T06:00:00Z'),sighting(null));
  state=issue([route()],state);
  state=updateForecastRecords(state,feed('2026-11-05T06:00:00Z'),sighting('2026-11-05'));
  assert.equal(state.records[0].status,'pending');
  assert.equal(state.samples.at(-1).offers[0].knownAt,'2026-11-01T06:00:00Z');
  assert.equal(state.samples.at(-1).offers[0].campaignStartDate,null);
});

test('a last-day start observed at the closing coverage boundary is a positive campaign start', () => {
  let state = issue();
  state = updateForecastRecords(state, feed('2026-12-03T00:00:00Z'), sighting('2026-12-02'));
  assert.equal(state.records[0].status, 'observed');
  assert.equal(state.records[0].observation.startDate, '2026-12-02');
});

function coveredLedger({ uncertain = false, positive = false, gap = false } = {}) {
  const modern = route(), legacy = route();
  // Same model and window intentionally stress separation by target semantics.
  delete legacy.forecast.target; delete legacy.forecast.horizonMode; delete legacy.forecast.context;
  delete legacy.forecast.horizons[0].days;
  let state = issue([modern, legacy]);
  for (let t = Date.parse('2026-11-03'); t <= Date.parse('2026-12-03'); t += 6 * 3600000) {
    const at = new Date(t).toISOString();
    if (gap && at === '2026-11-10T12:00:00.000Z') continue;
    const rows = uncertain && at === '2026-11-10T06:00:00.000Z' ? sighting(null)
      : positive && at === '2026-11-15T06:00:00.000Z' ? sighting('2026-11-15') : [];
    state = updateForecastRecords(state, feed(at), rows);
  }
  return state;
}

test('unknown start dates spoil only the new-start coverage, without producing a false negative', () => {
  const state = coveredLedger({ uncertain: true });
  assert.equal(state.records[0].status, 'unknown');
  assert.equal(state.records[1].status, 'observed');
  const report = forecastHistoryReport(state);
  assert.equal(report.records[0].evaluationEligible, false);
  assert.equal(report.records[1].evaluationEligible, true);
});

test('metrics keep target definitions separate and require complete coverage for either result', () => {
  const report = forecastHistoryReport(coveredLedger());
  assert.equal(report.records.length, 2);
  assert.equal(report.metrics.length, 2);
  const modern = report.metrics.find(m => m.target === 'campaign_start');
  assert.equal(modern.days, 30);
  assert.equal(modern.horizonMode, 'rolling_days');
  assert.equal(modern.n, 1);
  assert.equal(modern.brier, 0.0625);
  assert.equal(forecastHistoryReport(coveredLedger({ positive: true, gap: true })).records[0].evaluationEligible, false);
});
