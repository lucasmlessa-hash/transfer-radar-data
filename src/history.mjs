// Derives REAL per-route history (hist / mp / next / typical) from archived
// bonus windows scraped off public aggregators.
//
// Nothing in here invents data. Every number traces back to a row in a
// published archive of past transfer bonuses. A route with no archived window
// gets nothing (empty hist, zeroed mp, no `next`) — see normalize.mjs.
//
// RawWindow = { bankName, partnerName, pct, startDateRaw, endDateRaw }

import { resolveBank, resolvePartner } from './aliases.mjs';

// ponytail: side channel. publish.mjs fetches each source's html once and
// calls `source.parse(html)`; it has no notion of "history" and normalize()
// only receives the current-bonus rows. Rather than add a second HTTP request
// or change publish.mjs's contract, the frequentmiler source hands the
// archived windows it parsed out of the SAME html to this store, and
// normalize() reads them back. Replace-by-source (not append) so calling
// parse() twice in one process can't double-count.
// Upgrade path: when publish.mjs is free to change, have it collect
// `src.parseHistory?.(html)` alongside `src.parse(html)` and pass the windows
// into normalize() explicitly — then delete this store.
const RAW_BY_SOURCE = new Map();

export function recordHistory(sourceId, windows) {
  RAW_BY_SOURCE.set(sourceId, windows ?? []);
}

export function rawHistory() {
  return [...RAW_BY_SOURCE.values()].flat();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

// Archive dates are US M/D/YY (verified against all 463 rows of Frequent
// Miler's "Expired Transfer Bonuses" table on 2026-07-24, years 2017..2026).
// Anything else is dropped rather than guessed at.
// Exported for scripts/backtest.mjs, which must slice the archive by date with
// the SAME parser production uses -- a second date parser would let the
// backtest accept rows the model drops, silently skewing every score.
export function parseMDY(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const monthIdx = Number(m[1]) - 1;
  const day = Number(m[2]);
  const d = new Date(Date.UTC(year, monthIdx, day));
  // reject rollovers Date would silently accept (e.g. 02/30/26)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIdx || d.getUTCDate() !== day) return null;
  return d;
}

// "JUN 2026"
function windowLabel(d) {
  return `${MONTHS[d.getUTCMonth()].toUpperCase()} ${d.getUTCFullYear()}`;
}

// Inclusive day count: a bonus that starts and ends the same day ran 1 day.
function lengthLabel(start, end) {
  const days = Math.round((end - start) / DAY_MS) + 1;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * mp[m] = the empirical frequency that this route had a bonus RUNNING at some
 * point during calendar month m.
 *
 *   numerator   = number of distinct years in which a window of this route
 *                 overlapped month m (a Jun 14 -> Jul 18 window counts for
 *                 both June and July of that year)
 *   denominator = number of calendar years this route's archive spans, from
 *                 its earliest window's start year through the current year,
 *                 inclusive
 *
 * That's it — no smoothing, no decay, no model. Caveat worth knowing: a route
 * whose archive starts this year has a denominator of 1, so a single observed
 * month reads as 1.0. `next` guards against acting on that by requiring at
 * least 2 windows.
 */
function monthlyProbabilities(windows, now) {
  const yearsSeenPerMonth = Array.from({ length: 12 }, () => new Set());
  let firstYear = Infinity;

  for (const w of windows) {
    firstYear = Math.min(firstYear, w.start.getUTCFullYear());
    // walk month by month from start to end, inclusive
    const cursor = new Date(Date.UTC(w.start.getUTCFullYear(), w.start.getUTCMonth(), 1));
    const last = new Date(Date.UTC(w.end.getUTCFullYear(), w.end.getUTCMonth(), 1));
    while (cursor <= last) {
      yearsSeenPerMonth[cursor.getUTCMonth()].add(cursor.getUTCFullYear());
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  if (firstYear === Infinity) return Array(12).fill(0);
  const span = Math.max(1, now.getUTCFullYear() - firstYear + 1);
  // rounded to 3dp purely to keep the feed small - the client renders these
  // as whole percents anyway
  return yearsSeenPerMonth.map((years) => Math.min(1, Math.round((years.size / span) * 1000) / 1000));
}

/**
 * next = the highest-probability month among the NEXT 12 calendar months
 * (starting the month after `now` — a window opening in the current month is
 * either already live or already missed), damped by how recently this route
 * last ran a bonus:
 *
 *   prob = round(100 * mp[bestMonth] * recency), capped at 95
 *   recency = 1.00 if the last window ended  < 12 months ago
 *             0.75 if it ended 12..24 months ago
 *             0.50 if it ended > 24 months ago
 *
 * The 95 cap exists because a forecast is never a certainty. Ties on mp go to
 * the earliest month. Returns null for routes with fewer than 2 archived
 * windows: one window is an anecdote, not a pattern, and no forecast is
 * better than a made-up one.
 */
function forecastNext(windows, mp, now) {
  if (windows.length < 2) return null;

  const lastEnd = windows.reduce((a, w) => (w.end > a ? w.end : a), windows[0].end);
  const monthsSince = (now - lastEnd) / (DAY_MS * 30.44);
  const recency = monthsSince < 12 ? 1 : monthsSince <= 24 ? 0.75 : 0.5;

  let best = null;
  for (let ahead = 1; ahead <= 12; ahead += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
    const p = mp[d.getUTCMonth()];
    if (!best || p > best.p) best = { p, d };
  }
  if (!best || best.p <= 0) return null;

  const prob = Math.min(95, Math.round(100 * best.p * recency));
  if (prob <= 0) return null;
  return { label: `${MONTHS[best.d.getUTCMonth()]} ${best.d.getUTCFullYear()}`, prob };
}

// "+25–30%" (en dash, matching the client's display style), "+30%" when every
// observed window was the same size, "—" when we have nothing.
function typicalRange(pcts) {
  if (!pcts.length) return '—';
  const lo = Math.min(...pcts);
  const hi = Math.max(...pcts);
  return lo === hi ? `+${lo}%` : `+${lo}–${hi}%`;
}

/**
 * Groups raw archived windows by route id and derives the display/forecast
 * fields for each.
 *
 * @param {Date} now
 * @param {Array<{bankName:string,partnerName:string,pct:number,startDateRaw:string,endDateRaw:string}>} raw
 * @returns {Map<string, {bank:string, code:string, hist:object[], mp:number[], typical:string, next?:{label:string,prob:number}}>}
 */
export function deriveHistory(now = new Date(), raw = rawHistory()) {
  const byId = new Map();

  for (const w of raw) {
    const bank = resolveBank(w.bankName);
    const code = resolvePartner(w.partnerName);
    if (!bank || !code) continue; // untracked bank/partner - never invent a code
    const start = parseMDY(w.startDateRaw);
    const end = parseMDY(w.endDateRaw);
    const pct = Number(w.pct);
    if (!start || !end || end < start || !Number.isFinite(pct) || pct <= 0) continue;

    const id = `${bank.toLowerCase()}-${code.toLowerCase()}`;
    if (!byId.has(id)) byId.set(id, { bank, code, windows: [] });
    byId.get(id).windows.push({ start, end, pct });
  }

  const out = new Map();
  for (const [id, { bank, code, windows }] of byId) {
    windows.sort((a, b) => b.start - a.start); // most recent first
    const mp = monthlyProbabilities(windows, now);
    const next = forecastNext(windows, mp, now);
    const entry = {
      bank,
      code,
      mp,
      typical: typicalRange(windows.map((w) => w.pct)),
      hist: windows.map((w) => ({ w: windowLabel(w.start), pct: w.pct, len: lengthLabel(w.start, w.end) })),
    };
    if (next) entry.next = next;
    out.set(id, entry);
  }
  return out;
}
