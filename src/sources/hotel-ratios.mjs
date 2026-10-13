// Official hotel-transfer sources. These parsers return evidence, not a new
// partner directory: callers may correct tracked routes without adding/removing
// partners based on a single partial read.
import * as cheerio from 'cheerio';
import { canonical } from './partner-directory.mjs';

export const HOTEL_RATIO_SOURCES = [
  { bank: 'MAR', url: 'https://www.marriott.com/loyalty/redeem/travel/points-to-miles.mi', parse: parseMarriottRatios },
  { bank: 'WYN', url: 'https://www.wyndhamhotels.com/WHGServices/loyalty/V4/member/partners', parse: parseWyndhamRatios },
  { bank: 'CHO', url: 'https://www.choicehotels.com/en-uk/choice-privileges/rewards-exchange', parse: parseChoiceRatios },
];

const clean = (text) => String(text ?? '').replace(/[®™*]/g, '').replace(/\s+/g, ' ').trim();
const SOURCE_NAMES = new Map([
  ['The British Airways Club', 'British Airways Avios'],
  ['Cathay Pacific Cathay', 'Cathay Pacific Asia Miles'],
  ['Qantas Airline', 'Qantas Frequent Flyer'],
]);
const partnerName = (raw) => SOURCE_NAMES.get(clean(raw)) ?? canonical(clean(raw));
const result = () => ({ rates: new Map(), pending: new Map(), knownUnknown: new Set(), entries: 0 });

function record(out, name, ratio, reason = 'explicit base ratio not verifiable') {
  out.entries += 1;
  // A malformed/conflicting second occurrence must not undo the earlier
  // rejection; similarly a later valid occurrence cannot hide a conflict.
  if (out.pending.has(name)) return;
  if (!ratio || (out.rates.has(name) && out.rates.get(name) !== ratio)) {
    out.rates.delete(name);
    out.pending.set(name, !ratio ? reason : 'conflicting ratios in official source');
    return;
  }
  out.rates.set(name, ratio);
}

function amountsRatio(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  const ratio = from / to;
  // Preserve exact integer fractions when normalizing would round the rate.
  if (Number.isInteger(ratio * 10000)) return `${ratio}:1`;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  if (Number.isSafeInteger(from) && Number.isSafeInteger(to)) {
    const divisor = gcd(from, to);
    return `${from / divisor}:${to / divisor}`;
  }
  return `${from}:${to}`;
}

export function parseMarriottRatios(html) {
  const $ = cheerio.load(html), out = result();
  let tables = 0;
  $('table').each((_, table) => {
    const headers = $(table).find('thead th').map((__, th) => clean($(th).text())).get();
    if (headers.length !== 2 || headers[0] !== 'Frequent Flyer Programs' || headers[1] !== 'Points to Miles') return;
    tables += 1;
    $(table).find('tbody tr').each((__, row) => {
      const cells = $(row).children('td');
      if (cells.length !== 2) return;
      const name = partnerName(cells.eq(0).text());
      if (!name) return;
      // Only the base-ratio table cell is read. Block bonuses (60,000 points)
      // elsewhere on the page never participate in the calculation.
      const match = /^([\d]+(?:\.\d+)?)\s*:\s*([\d]+(?:\.\d+)?)$/.exec(cells.eq(1).text().trim());
      record(out, name, match ? amountsRatio(Number(match[1]), Number(match[2])) : null);
    });
  });
  if (!tables || !out.entries) throw new Error('Marriott points-to-miles table missing or empty');
  return out;
}

export function parseChoiceRatios(html) {
  const $ = cheerio.load(html), out = result();
  // The visible partner card pairs h4 with its own paragraph. Searching the
  // entire document also finds earning-per-stay copy and embedded duplicates.
  $('.cmp-text').each((_, card) => {
    const heading = $(card).children('h4');
    if (heading.length !== 1) return;
    const name = partnerName(heading.text());
    const paragraphs = $(card).children('p').map((__, p) => $(p).text().replace(/\s+/g, ' ').trim()).get();
    const line = paragraphs.find((text) => /^Starting at\b/.test(text));
    if (!line) {
      // Known tracked headings without an exchange amount are a changed card,
      // never evidence that the transfer is no longer available.
      if (['Air France / KLM Flying Blue', 'United MileagePlus'].includes(name)) record(out, name, null);
      return;
    }
    const match = /^Starting at ([\d,]+) points for ([\d,]+) ([\w\s&™]+)$/.exec(line);
    const units = match?.[3];
    const expectedUnits = {
      'Air France / KLM Flying Blue': /^Flying Blue Miles$/,
      'United MileagePlus': /^MileagePlus miles$/,
      'Qantas Frequent Flyer': /^Qantas Points$/,
    }[name];
    const promotional = /\b(bonus|promotional?|limited.time|until|through)\b/i.test($(card).text());
    const valid = match && !promotional && (!expectedUnits || expectedUnits.test(units));
    record(out, name, valid ? amountsRatio(Number(match[1].replaceAll(',', '')), Number(match[2].replaceAll(',', ''))) : null);
  });
  if (!out.entries) throw new Error('Choice exchange partner cards missing or empty');
  return out;
}

export function parseWyndhamRatios(body) {
  const doc = typeof body === 'string' ? JSON.parse(body) : body;
  if (!Array.isArray(doc?.data) || !doc.data.length) throw new Error('Wyndham partner data missing or empty');
  const out = result();
  const bundles = doc.data.filter((row) => /^SQ-MILES-/.test(row?.redemptionItemCode ?? ''));
  const expected = new Map([['SQ-MILES-1200', [6000, 1200]], ['SQ-MILES-3200', [16000, 3200]], ['SQ-MILES-6000', [30000, 6000]]]);
  // Snapshot provenance: official public calculator API, fetched 2026-10-13.
  // It does NOT label base versus promotional amounts. Accept only the three
  // independently reviewed Singapore bundles, all in agreement. A future
  // enhancement/devaluation requires new evidence rather than auto-rebasing.
  const codes = new Set(bundles.map((row) => row.redemptionItemCode));
  const valid = bundles.length === 3 && codes.size === 3 && bundles.every((row) => {
    const values = expected.get(row.redemptionItemCode);
    return values && row.currencyRequired === values[0] && row.faceValue === values[1]
      && /^\d[\d,]*[- ]Singapore Airlines Miles$/.test(row.description ?? '');
  });
  record(out, 'Singapore KrisFlyer', valid ? '5:1' : null,
    'Singapore baseline bundles changed, missing or inconsistent; review official base before updating');
  // 6,000 -> 2,400 on this API is a promotional United amount. Even three
  // consistent future tiers would not prove a baseline without separate terms.
  const united = doc.data.filter((row) => /^UA-MILES-/.test(row?.redemptionItemCode ?? ''));
  const knownAmounts = new Map([['UA-MILES-0', [0, 0]], ['UA-MILES-2400', [6000, 2400]]]);
  const unchangedUnknown = united.length === 2 && new Set(united.map((row) => row.redemptionItemCode)).size === 2
    && united.every((row) => {
      const values = knownAmounts.get(row.redemptionItemCode);
      return values && row.currencyRequired === values[0] && row.faceValue === values[1]
        && /^\d[\d,]* United MileagePlus Miles$/.test(row.description ?? '');
    });
  record(out, 'United MileagePlus', null, unchangedUnknown
    ? 'Wyndham API does not distinguish United promotional miles from its base ratio'
    : 'United API amounts changed or disappeared; review official base before updating');
  // This is an acknowledged gap only while the inspected source shape stays
  // unchanged. A disappearing/changed offer must still surface for review.
  if (unchangedUnknown) out.knownUnknown.add('United MileagePlus');
  return out;
}
