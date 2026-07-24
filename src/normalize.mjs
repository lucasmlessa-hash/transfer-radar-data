// Turns RawBonus[] (raw strings as scraped) into contract-shaped routes.
//
// RawBonus = { bankName, partnerName, pct, endDateRaw, sourceUrl }

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveBank, resolvePartner, partnerDisplayName } from './aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ponytail: mp/hist/typical/time aren't derivable from a scraped bonus row —
// they're historical/curated data. Plan 005 will replace this with a real
// static seed file; for now the plan-001 sample feed IS the seed, keyed by
// route id. Ids the pipeline discovers that aren't in the seed yet get the
// documented defaults below.
let SEED_BY_ID = null;
function loadSeed() {
  if (SEED_BY_ID) return SEED_BY_ID;
  SEED_BY_ID = new Map();
  try {
    const raw = readFileSync(path.join(__dirname, '..', 'sample', 'feed.json'), 'utf8');
    const doc = JSON.parse(raw);
    for (const r of doc.routes ?? []) SEED_BY_ID.set(r.id, r);
  } catch {
    // no seed available - defaults below cover every route
  }
  return SEED_BY_ID;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DEFAULT_MP = Array(12).fill(0.05);

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
 * @returns {{ routes: object[], unmapped: object[], sourceUrlsById: Record<string,string[]> }}
 */
export function normalize(rawBonuses, now = new Date()) {
  const seed = loadSeed();
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

    const seedRoute = seed.get(id);
    const route = {
      id,
      bank: bankCode,
      airline: seedRoute?.airline ?? partnerDisplayName(airCode),
      code: airCode,
      time: seedRoute?.time ?? '—',
      typical: seedRoute?.typical ?? '—',
      mp: seedRoute?.mp ?? DEFAULT_MP,
      hist: seedRoute?.hist ?? [],
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

  return { routes, unmapped, sourceUrlsById };
}
