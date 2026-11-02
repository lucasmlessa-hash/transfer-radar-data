import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFeed } from '../scripts/validate-feed.mjs';

function fixture() {
  return { version: 1, generatedAt: '2026-11-02T13:00:00Z', routes: [{ id: 'chase-ac', bank: 'CHASE', code: 'AC', airline: 'Air Canada Aeroplan', time: 'INSTANT', typical: '+20%', hist: [], mp: Array(12).fill(0), wait: [0.2, 0.5, 0.7],
    forecast: { modelVersion: 'recurrence-hazard-v3', issuedAt: '2026-11-02T13:00:00Z', target: 'campaign_start', horizonMode: 'rolling_days',
      evidence: { windowCount: 9, firstDate: '2022-11-01', lastDate: '2026-09-30', spanMonths: 47, level: 'established_history' },
      context: { campaignsThisYear: 2, campaignsLast365Days: 3, annualMedian: 2, completeYears: 3, daysSinceLastStart: 82, daysSinceLastEnd: 33, medianIntervalDays: 172, recentIntervalsDays: [128,133], nextCampaignOrdinal: 3 },
      horizons: [
        { months: 1, days: 30, startDate: '2026-11-03', endDate: '2026-12-02', probability: 0.2 },
        { months: 3, days: 90, startDate: '2026-11-03', endDate: '2027-01-31', probability: 0.5 },
        { months: 6, days: 180, startDate: '2026-11-03', endDate: '2027-05-01', probability: 0.7 },
      ],
    },
  }] };
}

test('feed accepts a fully described campaign-start prediction with 30/90/180-day dates', () => {
  assert.doesNotThrow(() => validateFeed(fixture()));
});

test('feed rejects inconsistent target definitions, horizon lengths and context counts', () => {
  for (const mutate of [
    f => { f.target = 'bonus_available'; },
    f => { f.horizonMode = 'calendar_months'; },
    f => { delete f.target; },
    f => { f.horizons[0].days = 31; },
    f => { f.horizons[0].startDate = '2026-11-02'; },
    f => { f.horizons[0].endDate = '2026-12-03'; },
    f => { f.context.campaignsThisYear = -1; },
    f => { f.context.nextCampaignOrdinal = 2; },
    f => { f.horizons[2].probability = 0.1; },
    f => { f.horizons = []; },
  ]) {
    const doc = fixture(); mutate(doc.routes[0].forecast);
    assert.throws(() => validateFeed(doc), /forecast/);
  }
});

test('unknown route context remains numeric where supported and nullable where no interval exists', () => {
  const doc = fixture(), f = doc.routes[0].forecast;
  f.evidence = { windowCount: 0, firstDate: null, lastDate: null, spanMonths: 0, level: 'limited' };
  f.context = { campaignsThisYear: 0, campaignsLast365Days: 0, annualMedian: null, completeYears: 0, daysSinceLastStart: null, daysSinceLastEnd: null, medianIntervalDays: null, recentIntervalsDays: [], nextCampaignOrdinal: 1 };
  assert.doesNotThrow(() => validateFeed(doc));
});

function additiveFixture() {
  const doc = fixture(), r = doc.routes[0];
  r.nextCampaignForecast = r.forecast;
  r.forecast = { modelVersion: 'pooled-recurrence-v2', issuedAt: doc.generatedAt,
    evidence: structuredClone(r.nextCampaignForecast.evidence), horizons: [
      { months: 1, startDate: '2026-12-01', endDate: '2026-12-31', probability: 0.481 },
      { months: 3, startDate: '2026-12-01', endDate: '2027-02-28', probability: 0.681 },
      { months: 6, startDate: '2026-12-01', endDate: '2027-05-31', probability: 0.812 },
    ] };
  r.wait = [0.481, 0.681, 0.812];
  return doc;
}

test('an additive feed validates legacy wait against its primary forecast, not the next-campaign estimate', () => {
  const doc = additiveFixture();
  assert.doesNotThrow(() => validateFeed(doc));
  doc.routes[0].wait = [0.2, 0.5, 0.7];
  assert.throws(() => validateFeed(doc), /wait/);
});

test('the additive nextCampaignForecast requires the v3 model and its complete target definition', () => {
  for (const mutate of [
    r => { r.nextCampaignForecast = structuredClone(r.forecast); },
    r => { r.nextCampaignForecast.modelVersion = 'unknown-model'; },
    r => { delete r.nextCampaignForecast.target; },
    r => { r.nextCampaignForecast.horizons[0].days = 31; },
  ]) {
    const doc = additiveFixture(); mutate(doc.routes[0]);
    assert.throws(() => validateFeed(doc), /nextCampaignForecast/);
  }
});
