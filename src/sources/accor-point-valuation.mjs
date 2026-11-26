import { load } from 'cheerio';
import { fetchPage, PUBLIC_CLIENT_USER_AGENT } from '../fetch-page.mjs';

const ACCOR_URL = 'https://all.accor.com/loyalty-program/use/booking-with-points/index.en.shtml';
const ECB_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=jsondata&lastNObservations=1';
const FX_SOURCE = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html';
const SERIES = { FREQ: 'D', CURRENCY: 'USD', CURRENCY_DENOM: 'EUR', EXR_TYPE: 'SP00', EXR_SUFFIX: 'A' };
const MAX_FX_AGE_DAYS = 7;
const clean = text => text.replace(/\s+/g, ' ').trim();

function stayDiscount(html) {
  const $ = load(html);
  const rows = $('main .reservation__list').toArray().filter(row =>
    /^Use your points to pay for part or all of your stay:?$/i.test(clean($(row).find('.reservation__title').text())));
  const badge = $(rows).find('.reservation__ico');
  if (clean($('main h1').text()) !== 'Stay with your Reward points' || rows.length !== 1 || badge.length !== 1 ||
    !/^1[.,\s]?000 PTS\s*=\s*(?:20\s*€|€\s*20)$/i.test(clean(badge.text()))) {
    throw new Error('missing, changed or ambiguous EUR 20 stay discount for 1,000 Reward points');
  }
  return { url: ACCOR_URL, points: 1000, euros: 20 };
}

export function isCurrentFixingDate(date, now) {
  const stamp = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) return false;
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const ageDays = (Date.parse(today) - stamp) / 86400000;
  return ageDays >= 0 && ageDays <= MAX_FX_AGE_DAYS;
}

function latestFixing(body, now, previousMeta) {
  const data = JSON.parse(body);
  const dimensions = data.structure?.dimensions;
  const expected = Object.entries(SERIES);
  if (data.header?.sender?.id !== 'ECB' || data.header.test !== false || dimensions?.series?.length !== expected.length ||
    !expected.every(([key, value], i) => dimensions.series[i].id === key && dimensions.series[i].values?.length === 1 &&
      dimensions.series[i].values[0].id === value)) {
    throw new Error('expected the daily USD per EUR spot reference series');
  }
  // The request selects one series and its latest published observation. SDMX
  // uses zero-based indexes into the dimension and attribute values arrays.
  const series = data.dataSets?.[0]?.series;
  const observations = series?.['0:0:0:0:0']?.observations;
  const periods = dimensions.observation?.[0];
  if (data.dataSets?.length !== 1 || Object.keys(series ?? {}).length !== 1 || Object.keys(observations ?? {}).length !== 1 ||
    !Array.isArray(observations['0']) || dimensions.observation?.length !== 1 ||
    periods?.id !== 'TIME_PERIOD' || periods.values?.length !== 1) {
    throw new Error('expected a single dated reference rate');
  }
  const observation = observations['0'];
  const obsAttrs = data.structure.attributes?.observation ?? [];
  const statusIndex = obsAttrs.findIndex(attribute => attribute.id === 'OBS_STATUS');
  const status = obsAttrs[statusIndex]?.values?.[observation[statusIndex + 1]]?.id;
  const usdPerEur = observation[0];
  if (status !== 'A' || !Number.isFinite(usdPerEur) || usdPerEur <= 0) throw new Error('invalid reference rate or observation status');
  const date = periods.values[0].id;
  if (!isCurrentFixingDate(date, now)) throw new Error(`invalid, future or stale fixing date: ${date}`);
  const validFrom = Date.parse(data.dataSets[0].validFrom);
  if (!Number.isFinite(validFrom) || validFrom > now.getTime()) throw new Error('unreadable or future dataset validity date');
  // The legacy editorial asOf is a review day, not the date of an ECB fixing.
  if (previousMeta?.method === 'official-fx' && date < previousMeta.asOf) {
    throw new Error(`fixing ${date} predates stored fixing ${previousMeta.asOf}`);
  }
  return { url: ECB_URL, date, usdPerEur };
}

async function readSource(name, url, fetchImpl, parse) {
  try {
    const body = await fetchPage(url, { fetcher: fetchImpl, tries: 1, headers: { 'User-Agent': PUBLIC_CLIENT_USER_AGENT } });
    return parse(body);
  } catch (error) {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

async function collect({ fetchImpl = fetch, now = new Date(), previousMeta } = {}) {
  const [redemption, fx] = await Promise.all([
    readSource('ALL Accor', ACCOR_URL, fetchImpl, stayDiscount),
    readSource('ECB', ECB_URL, fetchImpl, body => latestFixing(body, now, previousMeta)),
  ]);
  const sourceValue = redemption.euros / redemption.points;
  const value = Number((sourceValue * 100 * fx.usdPerEur).toFixed(6));
  if (!Number.isFinite(value) || value <= 0) throw new Error('ECB conversion produced invalid US cents per Reward point');
  return {
    values: { ACCOR: value }, missingCodes: [],
    meta: { ACCOR: { method: 'official-fx', currency: 'EUR', sourceCurrency: 'EUR', sourceValue,
      fxRate: fx.usdPerEur, fxSource: FX_SOURCE, asOf: fx.date, estimate: false,
      note: '1.000 pontos Reward dão €20 de desconto em hospedagens participantes. Câmbio de referência do BCE em dólares por euro.' } },
    evidence: { checkedAt: now.toISOString(), redemption, fx },
  };
}

export const ACCOR_VALUATION_SOURCE = { id: 'accor-ecb', name: 'ALL Accor', url: ACCOR_URL, fxSource: FX_SOURCE, codes: ['ACCOR'], collect };
