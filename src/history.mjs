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

// Exponential year decay, half-life 3 years. The 2020-22 promo regime was an
// artifact of nobody flying — routes that ran 3 windows/year then run ~1 now
// (amex-af: Jul/Sep/Nov 2021, May/Sep/Nov 2022, then one-a-year since) — and
// unweighted counting lets that dead regime outvote the present. Backtested
// 2026-07-25: decay alone lifts Brier skill from +1.8% to +5.6%.
const HALF_LIFE_Y = 3;
const yearWeight = (nowAmi, m) => 0.5 ** ((Math.floor(nowAmi / 12) - Math.floor(m / 12)) / HALF_LIFE_Y);

// Hierarchical shrinkage: how strongly a route's own base rate outweighs its
// BANK's when they are blended into the p2 prior. weight = n/(n+K_HIER) over
// the route's archived windows, so a 2-window route leans on its bank and a
// 15-window route is essentially on its own.
//
// Why a bank prior at all: with a median of 3 windows per route, shrinking
// toward the route's OWN rate borrows no strength from anywhere — the prior is
// as noisy as the thing it is supposed to stabilise. The bank is a low-variance
// estimator of the LEVEL a route sits at.
//
// TWO THINGS THIS IS NOT, both tested and both failed:
//
//  - Not a "bank wave" effect. Given a sibling route of the same bank ran a
//    bonus this month, the lift here is 1.95pp with a CI spanning zero. The
//    seasonal bank prior (which would borrow calendar SHAPE) measured worse.
//  - Not established as a BANK axis at all. A globally pooled prior — every
//    route, no bank structure — scores 6.64% against this 7.54%, and the
//    difference is not established (P(dBrier<=0) = 0.152 by cutoff, 0.078 by
//    route). The sustained finding is "shrink toward a POOLED prior instead of
//    the route's own rate"; the bank is a plausible grouping, not a measured
//    one. Keeping it costs nothing and the point estimate favours it, but do
//    not defend the bank axis as if it had been demonstrated.
//
// Backtested 2026-07-25 over 795 walk-forward predictions: 7.54% Brier skill
// vs per-route climatology (P(dBrier<=0) = 0.002 by cutoff, 0.004 by route),
// against 5.60% for the route-only prior.
//
// AND THE GAIN IS FADING. Measured against the route-only prior by cutoff
// year: 2024 +0.0033 (P=0.029), 2025 +0.0044 (P=0.011), 2026 -0.0026
// (P=0.694). That is the mechanism working as designed — pooling only pays
// where a route has no base of its own, and every route thickens with time.
// It keeps earning its place because thin routes keep ARRIVING (Esfera,
// Livelo and Rove have almost no archive), but the headline number is
// retrospective. Do not quote 7.54% as a forward expectation.
const K_HIER = 5;

// The horizons the "worth waiting how long?" card asks about, in months.
const HORIZONS = [1, 3, 6];

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
 *
 * Returns p2's numerator/denominator masses rather than finished p2 values:
 * the p2 prior is hierarchical (route blended with bank), so it cannot be
 * computed until every route in the archive has been measured. deriveHistory
 * assembles it. mp keeps its own route-level prior — the hierarchical prior
 * was only ever measured on p2, and unmeasured changes do not ship.
 */
function seasonality(windows, now) {
  if (!windows.length) {
    return {
      mp: Array(12).fill(0),
      calMass: Array.from({ length: 12 }, () => ({ k: 0, n: 0 })),
      horizonMass: HORIZONS.map(() => ({ k: 0, n: 0, prior: 0 })),
      stretch: { k: 0, n: 0 },
    };
  }

  let firstAmi = Infinity;
  const spans = windows.map((w) => {
    firstAmi = Math.min(firstAmi, ami(w.start));
    return { s: ami(w.start), e: ami(w.end) };
  });
  const nowAmi = ami(now); // current month is in progress, not yet observed
  const wOf = (m) => yearWeight(nowAmi, m);
  const observed = (m) => m >= firstAmi && m < nowAmi;
  const hit1 = (m) => spans.some(({ s, e }) => s <= m && e >= m);
  const hit2 = (m) => hit1(m) || hit1(m + 1);

  // decay-weighted hit mass and occurrence mass per calendar month. Hits are
  // clipped to observed months: a window still touching the in-progress month
  // must not put weight in the numerator while the month sits outside the
  // denominator (k > n would follow). It counts next month.
  const k1 = Array(12).fill(0), n1 = Array(12).fill(0);
  for (let m = firstAmi; m < nowAmi; m += 1) {
    const cal = ((m % 12) + 12) % 12;
    n1[cal] += wOf(m);
    if (hit1(m)) k1[cal] += wOf(m);
  }
  const totalK = k1.reduce((s, x) => s + x, 0);
  const totalN = n1.reduce((s, x) => s + x, 0);
  const prior1 = totalN ? totalK / totalN : 0;

  const mp = k1.map((k, cal) => round3((k + TAU * prior1) / (n1[cal] + TAU)));

  // this route's own 2-month base rate: decay-weighted share of every observed
  // sliding stretch that was hit. One of the two ingredients of the p2 prior.
  let sHits = 0, sN = 0;
  for (let m = firstAmi; m + 1 < nowAmi; m += 1) { const w = wOf(m); sN += w; if (hit2(m)) sHits += w; }

  // "Worth waiting how long?" -- P(at least one bonus within the next h months),
  // for h in HORIZONS, counted EMPIRICALLY over the stretches actually observed
  // rather than composed from mp.
  //
  // Composing is what the design handoff specifies (1 - prod(1 - mp[month]))
  // and it overstates, because a bonus running 14 Jun -> 18 Jul raises both
  // mp[Jun] and mp[Jul] and the product then treats one window as two
  // independent chances. Measured against what actually happened in the
  // archive: +3pp at 2 months, +7pp at 3, +6pp at 6 -- the error grows with the
  // horizon, which is exactly where the card prints its biggest, gold numbers.
  // An "89% by January" that is really ~80% is what makes someone wait and
  // lose the seat.
  // Anchored on the calendar stretch that starts NEXT month, not on a generic
  // sliding window: the card says "by OCT", so the answer has to be about
  // this route in those actual months, seasonality and all.
  //
  // Every horizon shares ONE denominator -- the years in which the whole
  // longest window was observed. Letting each horizon pick its own set of
  // years makes the curve non-monotone (measured: 5 routes where "within 6
  // months" came out BELOW "within 3"), which is nonsense on its face: a bonus
  // inside 3 months is a bonus inside 6. Common denominator, nested
  // numerators, monotone by construction.
  const hitH = (m, h) => { for (let k = 0; k < h; k += 1) if (hit1(m + k)) return true; return false; };
  const maxH = Math.max(...HORIZONS);
  const calStart = (((nowAmi + 1) % 12) + 12) % 12;
  const horizonMass = HORIZONS.map(() => ({ k: 0, n: 0, prior: 0 }));
  for (let y = Math.floor(firstAmi / 12) - 1; y <= Math.floor(nowAmi / 12); y += 1) {
    const m = y * 12 + calStart;
    if (!observed(m) || !observed(m + maxH - 1)) continue;
    const w = wOf(m);
    HORIZONS.forEach((h, i) => {
      horizonMass[i].n += w;
      if (hitH(m, h)) horizonMass[i].k += w;
    });
  }
  // Each horizon shrinks toward ITS OWN base rate -- the route's sliding
  // h-month rate over every observed start, seasonality ignored. Shrinking the
  // 6-month figure toward the 2-month prior (which is what reusing p2's prior
  // did) dragged it down to below the 3-month figure's honest level: wrong
  // question, wrong anchor. The sliding rate sees ~50-100 starts against the
  // handful of same-calendar years, so it is stable enough to be the prior
  // without any pooling, and it is monotone in h, which keeps the shrunk
  // curve monotone too.
  HORIZONS.forEach((h, i) => {
    let k = 0, n = 0;
    for (let m = firstAmi; m + h - 1 < nowAmi; m += 1) { const w = wOf(m); n += w; if (hitH(m, h)) k += w; }
    horizonMass[i].prior = n ? k / n : 0;
  });

  // per-calendar-stretch masses, left un-shrunk for deriveHistory to finish
  const calMass = Array.from({ length: 12 }, (_, cal) => {
    let k = 0, n = 0;
    const firstYear = Math.floor(firstAmi / 12), lastYear = Math.floor(nowAmi / 12);
    for (let y = firstYear; y <= lastYear; y += 1) {
      const m = y * 12 + cal;
      if (!observed(m) || !observed(m + 1)) continue;
      n += wOf(m);
      if (hit2(m)) k += wOf(m);
    }
    return { k, n };
  });

  return { mp, calMass, horizonMass, stretch: { k: sHits, n: sN } };
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

  // Two passes, because the p2 prior is hierarchical: pass 1 measures every
  // route, pass 2 blends each route's base rate with its bank's before
  // shrinking. A single pass cannot do this — the bank prior does not exist
  // until every route in the bank has been measured.
  const parts = new Map();
  const bankMass = new Map();
  for (const [id, { bank, windows }] of byId) {
    windows.sort((a, b) => b.start - a.start); // most recent first
    const s = seasonality(windows, now);
    parts.set(id, s);
    const acc = bankMass.get(bank) ?? { k: 0, n: 0 };
    acc.k += s.stretch.k; acc.n += s.stretch.n;
    bankMass.set(bank, acc);
  }

  const out = new Map();
  for (const [id, { bank, code, windows }] of byId) {
    const { mp, calMass, horizonMass, stretch } = parts.get(id);
    const priorRoute = stretch.n ? stretch.k / stretch.n : 0;
    // LEAVE-ONE-ROUTE-OUT: subtract this route's own mass, so a route never
    // seeds the prior it is then shrunk toward. Without this the prior would
    // partly be the route restating itself, and thin routes — the ones the
    // pooling exists to help — would be the most self-referential of all.
    const bm = bankMass.get(bank) ?? { k: 0, n: 0 };
    const outK = bm.k - stretch.k, outN = bm.n - stretch.n;
    const priorBank = outN > 0 ? outK / outN : priorRoute;
    const w = windows.length / (windows.length + K_HIER);
    const prior2 = w * priorRoute + (1 - w) * priorBank;

    const p2 = calMass.map(({ k, n }) => round3(Math.min(0.95, (k + TAU * prior2) / (n + TAU))));
    // Same pooled prior and cap as p2 — a horizon estimate is the same kind of
    // thin-sample frequency and needs the same shrinkage. Monotone by
    // construction (a hit inside h months is a hit inside h+1), and the
    // shrinkage cannot break that because every horizon shares one prior.
    // Only published when every horizon rests on at least one real observation.
    // A route whose single window is recent cannot have a 6-month stretch
    // observed at all: n and the prior are both 0, the estimate collapses to
    // the prior, and the curve comes out "95% within 1 month, 0% within 6" —
    // which is not a cautious number, it is a wrong one. Same rule `next`
    // already follows: no forecast beats an invented one, and the client
    // simply omits the card.
    const wait = horizonMass.every(({ n }) => n > 0)
      ? horizonMass.map(({ k, n, prior }) => round3(Math.min(0.95, (k + TAU * prior) / (n + TAU))))
      : undefined;
    const next = forecastNext(windows, mp, now);
    const entry = {
      bank,
      code,
      mp,
      p2,
      ...(wait === undefined ? {} : { wait }),
      typical: typicalRange(windows.map((w) => w.pct)),
      hist: windows.map((w) => ({ w: windowLabel(w.start), pct: w.pct, len: lengthLabel(w.start, w.end) })),
    };
    if (next) entry.next = next;
    out.set(id, entry);
  }
  return out;
}
