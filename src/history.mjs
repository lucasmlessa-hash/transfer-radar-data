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

// Beta-Binomial shrinkage strength, in pseudo-years. Chosen a priori during the
// 2026-07-25 analysis; the walk-forward backtest (scripts/backtest.mjs, 767
// predictions over 2024-01..2026-04) then measured the raw-frequency model at
// -4.4% Brier skill vs per-route climatology and this estimator at +2.3%
// (tau=4 scored +3.6%, but that number came from sweeping tau on the same
// evaluation set - kept at the pre-registered 2 rather than chasing it).
const TAU = 2;
const round3 = (x) => Math.round(x * 1000) / 1000;
// absolute month index - the currency all the observation-window math uses
const ami = (d) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/**
 * Seasonality estimates for one route, from its archived windows:
 *
 *   mp[m] = P(a bonus runs at some point during calendar month m)
 *   p2[m] = P(a bonus runs during the 2-month stretch starting at month m)
 *
 * Both are shrunk empirical frequencies:
 *
 *   numerator   = years in which a window overlapped the month/stretch
 *   denominator = OCCURRENCES of that month/stretch actually observed - from
 *                 the route's first archived month up to (not including) the
 *                 current month. The old year-span denominator counted months
 *                 that hadn't happened yet this year, biasing every
 *                 not-yet-reached month down by ~1/span (measured in the
 *                 backtest: 320 of 767 predictions were an exact 0%, and 9%
 *                 of those "impossible" bonuses happened).
 *   shrinkage   = (k + TAU*prior) / (n + TAU), prior = the route's own base
 *                 rate. Kills both pathologies of raw frequencies at n<=6:
 *                 the overconfident exact 0 and the span-1 route reading 1.0.
 *
 * p2 exists so the client's 2-month verdict never composes mp months by
 * independence: a single Jun 14 -> Jul 18 window feeds BOTH mp[Jun] and
 * mp[Jul], so 1-(1-mp)(1-mp) double-counts it; p2 counts the stretch once.
 * A route with no archive gets zeros (see normalize.mjs - "no evidence" is
 * zeros, not a guess; only routes WITH evidence earn the smoothed floor).
 */
function seasonality(windows, now) {
  if (!windows.length) return { mp: Array(12).fill(0), p2: Array(12).fill(0) };

  const yearsSeenPerMonth = Array.from({ length: 12 }, () => new Set());
  let firstAmi = Infinity;
  const spans = windows.map((w) => {
    firstAmi = Math.min(firstAmi, ami(w.start));
    return { s: ami(w.start), e: ami(w.end) };
  });
  const nowAmi = ami(now); // current month is in progress, not yet observed
  for (const { s, e } of spans) {
    // clip hits to observed months: a window still touching the in-progress
    // month must not put a hit in the numerator while the month is excluded
    // from the denominator (k > n would follow). It counts next month.
    for (let m = s; m <= e && m < nowAmi; m += 1) yearsSeenPerMonth[((m % 12) + 12) % 12].add(Math.floor(m / 12));
  }
  const observed = (m) => m >= firstAmi && m < nowAmi;
  const hit1 = (m) => spans.some(({ s, e }) => s <= m && e >= m);
  const hit2 = (m) => hit1(m) || hit1(m + 1);

  // per-calendar-month occurrence counts and the route's base monthly rate
  const n1 = Array(12).fill(0);
  for (let m = firstAmi; m < nowAmi; m += 1) n1[((m % 12) + 12) % 12] += 1;
  const totalK = yearsSeenPerMonth.reduce((s, y) => s + y.size, 0);
  const totalN = n1.reduce((s, x) => s + x, 0);
  const prior1 = totalN ? totalK / totalN : 0;

  const mp = yearsSeenPerMonth.map((years, cal) => round3((years.size + TAU * prior1) / (n1[cal] + TAU)));

  // stretch climatology: fraction of ALL observed sliding 2-month stretches hit
  let sHits = 0, sN = 0;
  for (let m = firstAmi; m + 1 < nowAmi; m += 1) { sN += 1; if (hit2(m)) sHits += 1; }
  const prior2 = sN ? sHits / sN : 0;

  const p2 = Array.from({ length: 12 }, (_, cal) => {
    let k = 0, n = 0;
    // every occurrence of the (cal, cal+1) stretch with both months observed
    const firstYear = Math.floor(firstAmi / 12), lastYear = Math.floor(nowAmi / 12);
    for (let y = firstYear; y <= lastYear; y += 1) {
      const m = y * 12 + cal;
      if (!observed(m) || !observed(m + 1)) continue;
      n += 1;
      if (hit2(m)) k += 1;
    }
    return round3((k + TAU * prior2) / (n + TAU));
  });

  return { mp, p2 };
}

/**
 * next = the highest-probability month among the NEXT 12 calendar months
 * (starting the month after `now` — a window opening in the current month is
 * either already live or already missed), damped by how recently this route
 * last ran a bonus. Reads the SMOOTHED mp, so a span-1 route can no longer
 * hit the 95 cap off a single observed year:
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
    const { mp, p2 } = seasonality(windows, now);
    const next = forecastNext(windows, mp, now);
    const entry = {
      bank,
      code,
      mp,
      p2,
      typical: typicalRange(windows.map((w) => w.pct)),
      hist: windows.map((w) => ({ w: windowLabel(w.start), pct: w.pct, len: lengthLabel(w.start, w.end) })),
    };
    if (next) entry.next = next;
    out.set(id, entry);
  }
  return out;
}
