import {monthlyWindows} from './forecast-windows.mjs';
// Prospective predictions and their observation coverage. Never train on this
// ledger here, never turn a failed/missing collection into a negative result.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const SIX_HOURS = 6 * 3600000;
const empty = () => ({ version: 1, records: [], samples: [] });
const sourcesFor = bank => bank === 'LIV' ? ['livelo'] : bank === 'ESF' ? ['esfera'] : ['frequentmiler', 'awardwallet'];
const isoDay = date => date.toISOString().slice(0, 10);
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && isoDay(new Date(value)) === value;
const states = ['pending', 'observed', 'not_observed', 'unknown'];
const targetOf = record => record.target ?? 'bonus_available';
const modeOf = record => record.horizonMode ?? 'calendar_months';
const fieldOf = record => record.forecastField ?? 'forecast';
const fieldMetadata = field => field === 'forecast' ? {} : { forecastField: field };
const forecastEntries = routes => routes.flatMap(route => [
  { route, forecastField: 'forecast', forecast: route.forecast },
  ...(route.monthlyCampaignForecast ? [{route,forecastField:'monthlyCampaignForecast',forecast:route.monthlyCampaignForecast}] : []),
  ...(route.nextCampaignForecast ? [{ route, forecastField: 'nextCampaignForecast', forecast: route.nextCampaignForecast }] : []),
]);
const campaignStartOf = offer => Object.hasOwn(offer,'campaignStartDate') ? offer.campaignStartDate : offer.startDate;
const targetKey = record => [targetOf(record), modeOf(record), record.days ?? null];
const issuanceKey = record => `${record.issuedAt}|${record.routeId}|${record.modelVersion}|${record.months}`
  + (record.target === undefined ? '' : `|${targetKey(record).join('|')}`)
  + (fieldOf(record) === 'forecast' ? '' : `|${fieldOf(record)}`);
const forecastIdentity = record => JSON.stringify([
  record.routeId, record.modelVersion, record.issuedAt, record.months,
  record.startDate, record.endDate, record.probability, ...targetKey(record), fieldOf(record),
]);
const dailyForecastIdentity = record => JSON.stringify([
  isoDay(new Date(record.issuedAt)), record.routeId, record.modelVersion, record.months,
  record.startDate, record.endDate, record.probability, record.availability, ...targetKey(record), fieldOf(record),
]);
const targetMetadata = (forecast, horizon) => forecast?.target === undefined ? {} : {
  target: forecast.target, horizonMode: forecast.horizonMode, days: horizon.days,
};
const evidenceSnapshot = record => ({ evidence: record.evidence ?? null, context: record.context ?? null });
const confirmedBeforeWindow = record => record.publicationStatus === 'confirmed'
  && typeof record.publishedAt === 'string' && Number.isFinite(Date.parse(record.publishedAt))
  && Date.parse(record.recordedAt) <= Date.parse(record.publishedAt)
  && Date.parse(record.issuedAt) <= Date.parse(record.publishedAt)
  && Date.parse(record.publishedAt) < Date.parse(record.startDate);

function validLedger(state) {
  return state?.version === 1 && Array.isArray(state.records) && Array.isArray(state.samples)
    && state.records.every(r => typeof r.key === 'string' && typeof r.routeId === 'string'
      && states.includes(r.status) && isoDate(r.startDate) && isoDate(r.endDate) && r.startDate <= r.endDate
      && Number.isFinite(Date.parse(r.issuedAt)) && Number.isFinite(Date.parse(r.recordedAt))
      && (r.horizonMode==='rolling_months'?[1,2,3]:[1,3,6]).includes(r.months) && Array.isArray(r.requiredSources) && r.requiredSources.length
      && (r.target === undefined || (r.target === 'campaign_start' && ((r.horizonMode === 'rolling_days' && r.days === ({1:30,3:90,6:180})[r.months]) || (r.horizonMode==='rolling_months' && monthlyWindows(r.issuedAt).some(w=>w.months===r.months&&w.days===r.days&&w.startDate===r.startDate&&w.endDate===r.endDate)))))
      && r.requiredSources.every(s => typeof s === 'string')
      && (r.probability === null || (Number.isFinite(r.probability) && r.probability >= 0 && r.probability <= 1)))
    && state.samples.every(s => Number.isFinite(Date.parse(s.at)) && s.sources && typeof s.sources === 'object'
      && Array.isArray(s.offers) && Array.isArray(s.uncertainRoutes));
}

export function loadForecastRecords(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (!validLedger(state)) throw new Error('invalid forecast ledger');
    return { ok: true, state };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, state: empty() };
    console.warn(`[forecast-records] preserving unreadable ledger: ${error.message}`);
    return { ok: false, state: null };
  }
}

export function serializeForecastRecords(state) {
  if (!validLedger(state)) throw new Error('invalid forecast ledger; refusing to serialize it');
  const { records, samples, ...metadata } = state;
  // One compact object per line keeps the growing ledger small without turning
  // every incremental observation into a diff of the entire file.
  return `${JSON.stringify(metadata).slice(0, -1)},\n"records":[\n${records.map(record => JSON.stringify(record)).join(',\n')}\n],\n"samples":[\n${samples.map(sample => JSON.stringify(sample)).join(',\n')}\n]\n}\n`;
}

function fullyCovered(record, samples) {
  const start = Date.parse(record.startDate), end = Date.parse(record.endDate) + 86400000;
  let first = -1, last = -1;
  for (let i = 0; i < samples.length; i++) {
    const t = Date.parse(samples[i].at);
    if (t <= start) first = i;
    if (t >= end) { last = i; break; }
  }
  if (first < 0 || last < 0 || start - Date.parse(samples[first].at) > SIX_HOURS
    || Date.parse(samples[last].at) - end > SIX_HOURS) return false;
  for (let i = first; i <= last; i++) {
    const sample = samples[i];
    if (record.requiredSources.some(id => sample.sources[id] !== 'ok') || sample.uncertainRoutes.includes(record.routeId)) return false;
    // An offer with an unknown start can resolve an overlap target, but cannot
    // establish whether a new campaign did or did not start in this window.
    if (targetOf(record) === 'campaign_start' && ((sample.uncertainStartRoutes ?? []).includes(record.routeId)
      || sample.offers.some(o => o.id === record.routeId && !isoDate(campaignStartOf(o))))) return false;
    if (i > first && Date.parse(sample.at) - Date.parse(samples[i - 1].at) > SIX_HOURS) return false;
  }
  return true;
}

function campaignObservation(route, window, at, previousSamples) {
  const startDate = isoDate(window.startDate) ? window.startDate : null;
  const prior = previousSamples.filter(s => Date.parse(s.at) < Date.parse(at))
    .flatMap(s => [...s.offers, ...(s.announcements ?? [])].map(o => ({ ...o, knownAt: o.knownAt ?? s.at })))
    .filter(o => o.id === route.id && isoDate(o.endDate)
      && (o.endDate === window.endDate || (startDate && isoDate(o.startDate)
        && o.startDate <= window.endDate && startDate <= o.endDate)))
    .sort((a, b) => Date.parse(a.knownAt) - Date.parse(b.knownAt));
  const first = prior[0];
  // Same start, extensions and republications that overlap an already observed
  // campaign retain its identity. A changed source label is not a new event.
  // A later source cannot declare that an already observed offer only began
  // after its first observation. Preserve identity and leave that start unknown.
  const priorStart=first ? campaignStartOf(first) : null;
  const campaignStartDate = startDate ? (isoDate(priorStart) ? priorStart
    : first && startDate > isoDay(new Date(first.knownAt)) ? null : startDate) : null;
  return { id: route.id, pct: window.pct, startDate, endDate: window.endDate,
    campaignStartDate, campaignId: campaignStartDate ? (first?.campaignId ?? `${route.id}|${campaignStartDate}`) : null,
    knownAt: first?.knownAt ?? at };
}

export function updateForecastRecords(previous, feed, observedRoutes = []) {
  const state = previous ? structuredClone(previous) : empty();
  if (!validLedger(state)) throw new Error('invalid forecast ledger; refusing to replace it');
  const at = feed.generatedAt, now = new Date(at);
  if (!Number.isFinite(now.getTime())) throw new Error('invalid feed date');
  const today = isoDay(now);
  const sample = {
    at,
    sources: Object.fromEntries(Object.entries(feed.health?.sources ?? {}).map(([id, value]) => [id, value.status])),
    offers: observedRoutes.filter(r => r.active && r.offerEvidence?.status === 'observed'
      && r.active.endDate >= today && (!r.active.startDate || r.active.startDate <= today))
      .map(r => campaignObservation(r, r.active, at, state.samples)),
    announcements: observedRoutes.filter(r => r.upcoming && r.offerEvidence?.status === 'observed'
      && r.upcoming.startDate > today).map(r => campaignObservation(r, r.upcoming, at, state.samples)),
    uncertainRoutes: observedRoutes.filter(r => r.offerEvidence?.status === 'conflict').map(r => r.id),
    uncertainStartRoutes: observedRoutes.filter(r => r.active && r.offerEvidence?.status === 'observed'
      && r.active.endDate >= today && !isoDate(r.active.startDate)).map(r => r.id),
  };
  // Retrying a timestamp does not rewrite the observation, either.
  if (!state.samples.some(s => s.at === at)) state.samples.push(sample);
  state.samples.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const currentSample = state.samples.find(s => s.at === at);
  // Derive issuance identity even for legacy day-only keys; never rewrite those
  // keys or create a second copy of an already recorded issuance.
  const keys = new Set(state.records.map(issuanceKey));
  const confirmedDailyForecasts = new Map();
  for (const record of state.records) {
    if (!confirmedBeforeWindow(record) || Date.parse(record.publishedAt) > now.getTime()) continue;
    const identity = dailyForecastIdentity(record);
    if (!confirmedDailyForecasts.has(identity)) confirmedDailyForecasts.set(identity, []);
    confirmedDailyForecasts.get(identity).push(evidenceSnapshot(record));
  }
  for (const { route, forecastField, forecast } of forecastEntries(feed.routes)) {
    const issuedAt = forecast?.issuedAt ?? at;
    const issueDate = new Date(issuedAt);
    if (!Number.isFinite(issueDate.getTime()) || issueDate > now) continue;
    const horizons = forecast?.horizons?.length ? forecast.horizons : [1, 3, 6].map(months => ({
      months,
      startDate: isoDay(new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth() + 1, 1))),
      endDate: isoDay(new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth() + months + 1, 0))),
      probability: null,
    }));
    for (const h of horizons) {
      const modelVersion = forecast?.modelVersion ?? 'unavailable';
      const definition = { ...targetMetadata(forecast, h), ...fieldMetadata(forecastField) };
      const key = issuanceKey({ issuedAt, routeId: route.id, modelVersion, months: h.months, ...definition });
      if (keys.has(key)) continue;
      const probability = Number.isFinite(h.probability) ? h.probability : null;
      const alreadyAnnounced = definition.target === 'campaign_start' && state.samples.some(s => Date.parse(s.at) <= issueDate.getTime()
        && (s.announcements ?? []).some(o => o.id === route.id && o.campaignStartDate >= h.startDate && o.campaignStartDate <= h.endDate));
      const availability = !forecast || probability === null ? 'unavailable'
        : now >= new Date(h.startDate) ? 'late_record'
          : route.active || route.upcoming || alreadyAnnounced ? 'offer_present'
            : 'displayed';
      const evidence = forecast?.evidence ?? null;
      const context = forecast?.context ?? null;
      const dailyIdentity = dailyForecastIdentity({
        issuedAt, routeId: route.id, modelVersion, months: h.months,
        startDate: h.startDate, endDate: h.endDate, probability, availability, ...definition,
      });
      // Only an already confirmed cohort can absorb identical reissues that
      // day. Unconfirmed attempts and material changes remain separate records.
      if (confirmedDailyForecasts.get(dailyIdentity)?.some(prior => isDeepStrictEqual(prior, { evidence, context }))) continue;
      state.records.push({
        key, routeId: route.id, bank: route.bank, code: route.code, airline: route.airline,
        modelVersion, issuedAt, recordedAt: at,
        months: h.months, startDate: h.startDate, endDate: h.endDate, probability,
        availability, evidence: structuredClone(evidence),
        ...definition, ...(forecast?.context === undefined ? {} : { context: structuredClone(context) }),
        publicationStatus: 'unconfirmed', publishedAt: null,
        requiredSources: sourcesFor(route.bank), status: 'pending',
      });
      keys.add(key);
    }
  }
  const positive = new Map(currentSample.offers.map(o => [o.id, o]));
  for (const record of state.records) {
    if (record.status !== 'pending') continue;
    const start = Date.parse(record.startDate), end = Date.parse(record.endDate) + 86400000;
    const offer = positive.get(record.routeId);
    const newStart = offer && isoDate(offer.campaignStartDate) && offer.campaignStartDate >= record.startDate
      && offer.campaignStartDate <= record.endDate && Date.parse(offer.knownAt) > Date.parse(record.issuedAt);
    if (now.getTime() >= start && offer
      && (targetOf(record) === 'campaign_start' ? newStart : now.getTime() < end)) {
      record.status = 'observed'; record.resolvedAt = at;
      record.observation = { observedAt: at, pct: offer.pct,
        ...(targetOf(record) === 'campaign_start' ? { startDate: offer.campaignStartDate, campaignId: offer.campaignId } : {}) };
    } else if (now.getTime() >= end) {
      record.status = fullyCovered(record, state.samples) ? 'not_observed' : 'unknown';
      record.resolvedAt = at;
    }
  }
  return state;
}

export function confirmForecastPublication(previous, feed, publishedAt) {
  if (!validLedger(previous)) throw new Error('invalid forecast ledger; refusing to confirm publication');
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) throw new Error('invalid publication date');
  if (!feed || !Array.isArray(feed.routes) || !Number.isFinite(Date.parse(feed.generatedAt))) throw new Error('invalid published feed');
  const state = structuredClone(previous);
  const publicationTime = Date.parse(publishedAt);
  if (publicationTime < Date.parse(feed.generatedAt)) return state;
  const publishedForecasts = new Set();
  for (const { route, forecastField, forecast } of forecastEntries(feed.routes)) {
    if (typeof route.id !== 'string' || typeof forecast?.modelVersion !== 'string'
      || typeof forecast?.issuedAt !== 'string' || !Array.isArray(forecast?.horizons)) continue;
    for (const horizon of forecast.horizons) {
      // Missing values are not equivalent to an explicitly published null.
      if (horizon.probability !== null && !Number.isFinite(horizon.probability)) continue;
      publishedForecasts.add(forecastIdentity({
        routeId: route.id, modelVersion: forecast.modelVersion, issuedAt: forecast.issuedAt,
        months: horizon.months, startDate: horizon.startDate, endDate: horizon.endDate, probability: horizon.probability,
        ...targetMetadata(forecast, horizon),
        ...fieldMetadata(forecastField),
      }));
    }
  }
  for (const record of state.records) {
    if (record.publicationStatus === 'confirmed' || Date.parse(record.recordedAt) > publicationTime
      || Date.parse(record.issuedAt) > publicationTime || publicationTime >= Date.parse(record.startDate)
      || !publishedForecasts.has(forecastIdentity(record))) continue;
    record.publicationStatus = 'confirmed';
    record.publishedAt = publishedAt;
  }
  return state;
}

export function summarizeForecastRecords(state) {
  return {
    version: 1, status: 'ok', asOf: state.samples.at(-1)?.at ?? null,
    startedAt: state.records.reduce((first, r) => !first || r.recordedAt < first ? r.recordedAt : first, null),
    counts: Object.fromEntries(states.map(status => [status, state.records.filter(r => r.status === status).length])),
    horizons: [1, 3, 6].map(months => ({
      months, ...Object.fromEntries(states.map(status => [status, state.records.filter(r => r.months === months && r.status === status).length])),
      displayed: state.records.filter(r => r.months === months && r.availability === 'displayed').length,
    })),
    note: 'Daily cohorts are correlated. Counts describe observations, not accuracy or calibration. Missing coverage is unknown.',
  };
}

export function forecastHistoryReport(state) {
  if (!validLedger(state)) throw new Error('invalid forecast ledger; refusing to report it');
  const samples = [...state.samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const asOf = samples.at(-1)?.at ?? null;
  const asOfDay = asOf ? isoDay(new Date(asOf)) : null;
  const startedAt = state.records.reduce((first, r) => !first || Date.parse(r.recordedAt) < Date.parse(first)
    ? r.recordedAt : first, null);
  const windowKey = r => JSON.stringify([r.routeId, r.modelVersion, r.startDate, r.endDate, ...targetKey(r)]);
  const firstByWindow = new Map();
  // A failed build is an attempt, not a published prediction. Choose the first
  // confirmed publication before inspecting probabilities, outcomes, or
  // availability, so unsuccessful attempts cannot hide the first real forecast.
  state.records.map((record, index) => ({ record, index }))
    .filter(({ record }) => confirmedBeforeWindow(record))
    .sort((a, b) => Date.parse(a.record.publishedAt) - Date.parse(b.record.publishedAt)
      || Date.parse(a.record.issuedAt) - Date.parse(b.record.issuedAt)
      || Date.parse(a.record.recordedAt) - Date.parse(b.record.recordedAt))
    .forEach(({ record, index }) => {
      const key = windowKey(record);
      if (!firstByWindow.has(key)) firstByWindow.set(key, index);
    });

  const records = state.records.map((record, index) => {
    const mature = asOfDay !== null && record.endDate < asOfDay;
    const coverageComplete = mature ? fullyCovered(record, samples) : null;
    let evaluationExclusion = null;
    if (!confirmedBeforeWindow(record)) evaluationExclusion = 'unpublished';
    else if (firstByWindow.get(windowKey(record)) !== index) evaluationExclusion = 'duplicate_window';
    // Old `limited` cohorts were not displayed. Preserve them in history, but do
    // not retroactively claim they were published forecasts. New numeric
    // predictions are displayed regardless of their evidence level.
    else if (record.availability !== 'displayed') evaluationExclusion = record.availability ?? 'unavailable';
    else if (!Number.isFinite(record.probability)) evaluationExclusion = 'missing_probability';
    else if (Date.parse(record.issuedAt) >= Date.parse(record.startDate)
      || Date.parse(record.recordedAt) >= Date.parse(record.startDate)) evaluationExclusion = 'late_record';
    else if (!mature) evaluationExclusion = 'window_open';
    else if (record.status === 'pending') evaluationExclusion = 'pending';
    else if (record.status === 'unknown') evaluationExclusion = 'unknown';
    // Apply the same collection requirement to positives and negatives. A
    // confirmed positive stays observed, but sparse collection cannot select
    // positive outcomes into a sample whose negatives would be unknown.
    else if (!coverageComplete) evaluationExclusion = 'incomplete_coverage';
    return { ...structuredClone(record), coverageComplete, evaluationEligible: evaluationExclusion === null, evaluationExclusion };
  });

  const groups = new Map();
  for (const record of records) {
    if (![null, 'window_open', 'pending', 'unknown', 'incomplete_coverage'].includes(record.evaluationExclusion)) continue;
    const key = JSON.stringify([record.months, record.modelVersion, ...targetKey(record)]);
    if (!groups.has(key)) groups.set(key, {
      months: record.months, modelVersion: record.modelVersion,
      ...targetMetadata(record, record),
      n: 0, pending: 0, unknown: 0, predicted: 0, observed: 0, squaredError: 0, correct: 0,
    });
    const group = groups.get(key);
    if (['window_open', 'pending'].includes(record.evaluationExclusion)) { group.pending++; continue; }
    if (['unknown', 'incomplete_coverage'].includes(record.evaluationExclusion)) { group.unknown++; continue; }
    const outcome = record.status === 'observed' ? 1 : 0;
    group.n++;
    group.predicted += record.probability;
    group.observed += outcome;
    group.squaredError += (record.probability - outcome) ** 2;
    group.correct += Number(Number(record.probability >= 0.5) === outcome);
  }
  const metrics = [...groups.values()].sort((a, b) => a.months - b.months || a.modelVersion.localeCompare(b.modelVersion))
    .map(group => {
      const observedRate = group.n ? group.observed / group.n : null;
      return {
        months: group.months, modelVersion: group.modelVersion, n: group.n,
        ...targetMetadata(group, group),
        predictedRate: group.n ? group.predicted / group.n : null,
        observedRate,
        brier: group.n ? group.squaredError / group.n : null,
        trendAccuracy: group.n ? group.correct / group.n : null,
        // Constant frequency fitted to these same outcomes: a descriptive
        // reference only, not an out-of-sample performance benchmark.
        baselineBrier: group.n ? observedRate * (1 - observedRate) : null,
        pending: group.pending, unknown: group.unknown,
      };
    });
  return { version: 1, status: 'ok', asOf, startedAt, records, metrics };
}
