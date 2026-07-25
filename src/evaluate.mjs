// Walk-forward evaluation of the SHIPPED forecast, with honest uncertainty.
//
// This module exists because the previous harness could report a headline
// skill number and still hide three things that a 2026-07-25 audit found by
// hand: (1) the interval around that number crossed zero, (2) the skill was
// negative in 2024 and only positive later, (3) half the predictions came
// from routes too thin for the model to beat a per-route average. Everything
// the audit had to compute manually is computed here now.
//
// It scores `deriveHistory()` itself — the production estimator, not a
// re-implementation — so a change to the model is reflected here with no
// second copy of the math to drift out of sync.

import { parseHistory } from './sources/frequentmiler.mjs';
import { resolveBank, resolvePartner } from './aliases.mjs';
import { deriveHistory, parseMDY } from './history.mjs';

export const ami = (d) => d.getUTCFullYear() * 12 + d.getUTCMonth();
export const amiToDate = (m) => new Date(Date.UTC(Math.floor(m / 12), m % 12, 1));
export const overlaps = (w, ...months) => months.some((m) => w.s <= m && w.e >= m);

/** Archive HTML -> windows resolved with production's own resolvers/parser. */
export function loadWindows(html) {
  const raw = parseHistory(html);
  const windows = [];
  for (const w of raw) {
    const bank = resolveBank(w.bankName);
    const code = resolvePartner(w.partnerName);
    const start = parseMDY(w.startDateRaw);
    const end = parseMDY(w.endDateRaw);
    if (!bank || !code || !start || !end || end < start) continue;
    windows.push({ id: `${bank.toLowerCase()}-${code.toLowerCase()}`, bank, code, start, end, s: ami(start), e: ami(end) });
  }
  const byId = new Map();
  for (const w of windows) {
    if (!byId.has(w.id)) byId.set(w.id, []);
    byId.get(w.id).push(w);
  }
  return { raw, windows, byId };
}

/**
 * Per-route climatology: the share of observed 2-month stretches that had a
 * bonus, unweighted. This is THE baseline to beat — "ignore seasonality,
 * ignore recency, just use how often this route runs bonuses at all". A model
 * that cannot beat it is not earning its complexity.
 */
export function climatology(ws, cutAmi) {
  const first = Math.min(...ws.map((w) => w.s));
  let hits = 0, n = 0;
  for (let t = first; t + 1 <= cutAmi - 1; t += 1) {
    n += 1;
    if (ws.some((w) => overlaps(w, t, t + 1))) hits += 1;
  }
  return n ? hits / n : 0.5;
}

/**
 * One row per (route, cutoff) the product would actually have shown.
 *
 * Information hygiene, in one place so it cannot drift:
 *  - training set = windows that had ENDED before the cutoff. The archive
 *    only lists expired bonuses, so this is the real information set; a
 *    still-running window at T belongs to the Live tab, not the Forecast.
 *  - routes live at the cutoff are dropped, exactly as the product drops them.
 *  - routes the product would not publish (no `next`) are dropped.
 *  - outcomes come from the FULL archive — that is the point of a backtest.
 */
export function buildRows(html, { fromAmi = 2024 * 12, toAmi = 2026 * 12 + 3 } = {}) {
  const { raw, byId } = loadWindows(html);
  const rows = [];
  for (let cut = fromAmi; cut <= toAmi; cut += 1) {
    const T = amiToDate(cut);
    const t1 = cut + 1, t2 = cut + 2;
    const trainRaw = raw.filter((w) => { const e = parseMDY(w.endDateRaw); return e && e < T; });
    const derived = deriveHistory(T, trainRaw);
    for (const [id, entry] of derived) {
      if (!entry.next) continue;
      const ws = byId.get(id) ?? [];
      if (ws.some((w) => w.s <= cut && w.e >= cut)) continue;
      const train = ws.filter((w) => w.end < T);
      if (!train.length) continue;
      rows.push({
        id, cut, year: Math.floor(cut / 12), nTrain: train.length,
        // exactly the number the panel's verdict reads for the next 2 months
        ship: entry.p2[t1 % 12],
        clim: climatology(train, cut),
        y: ws.some((w) => overlaps(w, t1, t2)) ? 1 : 0,
      });
    }
  }
  return rows;
}

export const brier = (rows, key) => rows.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / rows.length;
export const logloss = (rows, key) => rows.reduce((s, r) => {
  const p = Math.min(0.999, Math.max(0.001, r[key]));
  return s - (r.y ? Math.log(p) : Math.log(1 - p));
}, 0) / rows.length;
export const skillPct = (rows, key, ref = 'clim') => (1 - brier(rows, key) / brier(rows, ref)) * 100;

// Deterministic PRNG: a backtest that reports a different interval on every
// run cannot be quoted in a commit message or compared across changes.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Clustered bootstrap of the Brier difference (ref - key; positive = `key` is
 * better). Rows are NOT independent: one real bonus window is the outcome for
 * ~1.85 adjacent cutoffs, and one route contributes ~15 correlated rows. An
 * unclustered interval would be far too narrow. Resample whole clusters.
 *
 * `by`: 'cut' blocks on time (guards against a lucky period), 'id' blocks on
 * route (guards against a lucky handful of routes). Report both — a result
 * that only survives one of them is not robust.
 */
export function bootstrapDelta(rows, key, { ref = 'clim', by = 'cut', reps = 2000, seed = 42 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[by];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const gs = [...groups.values()];
  const stat = (sample) => { const flat = sample.flat(); return brier(flat, ref) - brier(flat, key); };
  const rnd = mulberry32(seed);
  const draws = [];
  for (let i = 0; i < reps; i += 1) {
    draws.push(stat(Array.from({ length: gs.length }, () => gs[Math.floor(rnd() * gs.length)])));
  }
  draws.sort((a, b) => a - b);
  return {
    delta: stat(gs),
    lo: draws[Math.floor(reps * 0.025)],
    hi: draws[Math.floor(reps * 0.975)],
    pNeg: draws.filter((d) => d <= 0).length / reps,
    clusters: gs.length,
  };
}

/** Predicted-decile vs observed frequency. */
export function calibration(rows, key) {
  const out = [];
  for (let b = 0; b < 10; b += 1) {
    const lo = b / 10, hi = (b + 1) / 10;
    const bin = rows.filter((r) => r[key] >= lo && (b === 9 ? r[key] <= 1 : r[key] < hi));
    if (!bin.length) continue;
    out.push({
      bin: `${b * 10}-${(b + 1) * 10}%`, n: bin.length,
      meanP: bin.reduce((s, r) => s + r[key], 0) / bin.length,
      observed: bin.reduce((s, r) => s + r.y, 0) / bin.length,
    });
  }
  return out;
}

/**
 * How many distinct real bonus windows are behind the y=1 rows. The gap
 * between this and the row count is the serial correlation the clustered
 * bootstrap exists to absorb; printing it keeps anyone from quoting the row
 * count as an effective sample size.
 */
export function effectiveEvents(rows, byId) {
  const seen = new Map();
  for (const r of rows) {
    if (!r.y) continue;
    const w = (byId.get(r.id) ?? []).find((x) => overlaps(x, r.cut + 1, r.cut + 2));
    if (!w) continue;
    const k = `${r.id}|${w.s}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const counts = [...seen.values()];
  return {
    positiveRows: rows.filter((r) => r.y).length,
    distinctWindows: counts.length,
    rowsPerWindow: counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0,
  };
}

/**
 * Windows on one route that overlap IN DAYS — one campaign listed twice.
 *
 * Day granularity is the whole point: at month granularity, Nov 7-20 and
 * Nov 21-Dec 5 "overlap" in November and look like a duplicate, when they are
 * two genuinely distinct back-to-back campaigns. A route cannot have two real
 * bonuses running on the same DAY, so a day-level overlap is a data defect;
 * a month-level one is just adjacency.
 */
export function findOverlaps(byId) {
  const out = [];
  for (const [id, ws] of byId) {
    const sorted = ws.slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (sorted[i].start <= sorted[j].end && sorted[j].start <= sorted[i].end) {
          out.push({ id, a: sorted[i], b: sorted[j] });
        }
      }
    }
  }
  return out;
}
