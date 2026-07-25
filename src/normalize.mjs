// Turns RawBonus[] (raw strings as scraped) into contract-shaped routes.
//
// RawBonus = { bankName, partnerName, pct, endDateRaw, sourceUrl }

import { readFileSync } from 'node:fs';

import { resolveBank, resolvePartner, partnerDisplayName } from './aliases.mjs';
import { deriveHistory } from './history.mjs';

// mp/hist/typical used to be seeded by copying them out of sample/feed.json
// whenever a route id matched. sample/feed.json is SIMULATED demo data, so the
// public feed was shipping invented past bonus windows as if they were real —
// and the extension's quality badge ("BEST EVER", "ALL-TIME HIGH") was being
// computed from them. That seeding is gone and must never come back: the only
// admissible source of history is a real scraped archive (see history.mjs).
// A route with no archived window gets hist: [], mp: all zeros, no `next`.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "we have no evidence", not "it's unlikely" - zeros, not a nonzero guess.
const NO_HISTORY_MP = Array(12).fill(0);

// Forecast-only routes are capped so the feed can't balloon as the archive
// grows. 60 comfortably fits every real bank x airline pair with >=2 archived
// windows (37 as of 2026-07-25) — the old cap of 25 silently dropped routes
// like c1-af and bilt-vs, so the client's by-airline cards showed an airline
// with HALF its banks missing, which reads as "this bank never bonuses here".
const MAX_FORECAST_ROUTES = 60;

// `time` (transfer speed) is curated partner metadata, not something any
// source publishes per bonus. It used to come from the simulated sample feed;
// it now has a real home in sample/partners.json `transferTimes`, transcribed
// from Frequent Miler's published per-bank transfer-time tables.
//
// The map is keyed bank -> airline code because speed genuinely varies by bank
// for the same airline: Amex->Cathay is 4-8 hours while Capital One->Cathay is
// 1-2 days, and Citi reaches Avios programs via Qatar (~1 day) where every
// other bank is instant. A per-airline map would have to pick one and be wrong
// for the rest.
//
// A pair with no published figure is deliberately absent (Livelo/Esfera -> the
// Brazilian carriers are not covered by any source we trust) and falls back to
// the em dash the client already renders for unknown values. An honest blank
// beats an invented "INSTANT" that makes someone miss a transfer deadline.
const UNKNOWN_TIME = '—';
const TRANSFER_TIMES = JSON.parse(
  readFileSync(new URL('../sample/partners.json', import.meta.url), 'utf8'),
).transferTimes ?? {};

const transferTime = (bank, code) => TRANSFER_TIMES[bank]?.[code] ?? UNKNOWN_TIME;

function monthIndex(name) {
  const idx = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return idx === -1 ? null : idx;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoFromParts(year, monthIdx, day) {
  const d = new Date(Date.UTC(year, monthIdx, day));
  // reject invalid combos that Date would otherwise silently roll over (e.g. Feb 30)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIdx || d.getUTCDate() !== day) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// No-year formats ("25/07", "until Jul 25") need a year inferred: this year,
// unless that date already passed relative to `now`, in which case next year.
function yearForMonthDay(monthIdx, day, now) {
  const thisYear = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(thisYear, monthIdx, day));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return candidate < today ? thisYear + 1 : thisYear;
}

/**
 * Parses the date shapes our known sources use:
 *   "July 25, 2026"  - full month name + day + year
 *   "7/25/26"        - M/D/YY or M/D/YYYY (US)
 *   "25/07"          - D/M, no year (BR sources)
 *   "until Jul 25"   - "until" + abbreviated month + day, no year
 * Returns an ISO YYYY-MM-DD string, or null if the string doesn't match any
 * known shape (including empty/missing strings) - callers treat null as "no
 * live bonus, forecast row only".
 */
export function parseEndDate(raw, now = new Date()) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^until\s+/i, '');
  if (!s) return null;

  // "July 25, 2026" / "July 25 2026"
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})$/);
  if (m) {
    const mi = monthIndex(m[1]);
    return mi === null ? null : isoFromParts(Number(m[3]), mi, Number(m[2]));
  }

  // "7/25/26" or "7/25/2026" - M/D/Y
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const mi = Number(m[1]) - 1;
    if (mi < 0 || mi > 11) return null;
    return isoFromParts(year, mi, Number(m[2]));
  }

  // "25/07" - D/M, no year
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const day = Number(m[1]);
    const mi = Number(m[2]) - 1;
    if (mi < 0 || mi > 11) return null;
    return isoFromParts(yearForMonthDay(mi, day, now), mi, day);
  }

  // "Jul 25" (after stripping the "until " prefix above)
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2})$/);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi === null) return null;
    const day = Number(m[2]);
    return isoFromParts(yearForMonthDay(mi, day, now), mi, day);
  }

  return null;
}

/**
 * @param {Array<{bankName:string, partnerName:string, pct:number, endDateRaw:string, sourceUrl:string}>} rawBonuses
 * @param {Date} now
 * @param {Map<string, object>} history derived real history, keyed by route id
 *   (defaults to whatever the sources recorded this run - see history.mjs)
 * @returns {{ routes: object[], unmapped: object[], sourceUrlsById: Record<string,string[]> }}
 */
export function normalize(rawBonuses, now = new Date(), history = deriveHistory(now)) {
  const unmapped = [];
  const byId = new Map(); // id -> { route: {..., pct, endDate}, sourceUrls: Set }

  for (const raw of rawBonuses) {
    const bankCode = resolveBank(raw.bankName);
    const airCode = resolvePartner(raw.partnerName);
    if (!bankCode || !airCode) {
      unmapped.push({
        ...raw,
        reason: !bankCode ? `unknown bank "${raw.bankName}"` : `unknown partner "${raw.partnerName}"`,
      });
      continue;
    }

    const id = `${bankCode.toLowerCase()}-${airCode.toLowerCase()}`;
    const endDate = parseEndDate(raw.endDateRaw, now);
    const existing = byId.get(id);

    // dedupe across sources: keep the higher pct, keep the union of sourceUrls
    if (existing && existing.route.pct >= raw.pct) {
      existing.sourceUrls.add(raw.sourceUrl);
      continue;
    }

    const h = history.get(id);
    const route = {
      id,
      bank: bankCode,
      airline: partnerDisplayName(airCode),
      code: airCode,
      time: transferTime(bankCode, airCode),
      typical: h?.typical ?? '—',
      mp: h?.mp ?? NO_HISTORY_MP,
      p2: h?.p2 ?? NO_HISTORY_MP,
      hist: h?.hist ?? [],
      pct: raw.pct,
      endDate,
    };

    const sourceUrls = existing ? existing.sourceUrls : new Set();
    sourceUrls.add(raw.sourceUrl);
    byId.set(id, { route, sourceUrls });
  }

  const routes = [];
  const sourceUrlsById = {};
  for (const [id, { route, sourceUrls }] of byId) {
    const { pct, endDate, ...rest } = route;
    const out = { ...rest };
    // unparseable/missing end date -> published WITHOUT `active` (forecast
    // row, never a phantom live deal)
    if (endDate) out.active = { pct, endDate };
    routes.push(out);
    sourceUrlsById[id] = [...sourceUrls];
  }

  // Forecast rows: routes with real archived history but no bonus running
  // right now. Without these the client's Forecast tab has nothing to render.
  // `next` is deliberately NOT attached to routes that are live - per
  // CONTRACT.md a route carries `active` alone or `next` alone.
  const forecasts = [];
  for (const [id, h] of history) {
    if (byId.has(id) || !h.next) continue;
    forecasts.push({
      id,
      bank: h.bank,
      airline: partnerDisplayName(h.code),
      code: h.code,
      time: transferTime(h.bank, h.code),
      typical: h.typical,
      mp: h.mp,
      p2: h.p2,
      hist: h.hist,
      next: h.next,
    });
  }
  forecasts.sort((a, b) => b.next.prob - a.next.prob);
  const dropped = forecasts.slice(MAX_FORECAST_ROUTES);
  if (dropped.length) {
    console.log(`[normalize] forecast cap ${MAX_FORECAST_ROUTES}: dropped ${dropped.length} lower-probability route(s): ${dropped.map((r) => `${r.id}@${r.next.prob}%`).join(', ')}`);
  }
  routes.push(...forecasts.slice(0, MAX_FORECAST_ROUTES));

  return { routes, unmapped, sourceUrlsById };
}
