// Walk-forward backtest of the shipped forecast model against the FM archive.
//
//   node scripts/backtest.mjs [archive-cache.html]
//
// The question it answers, for every monthly cutoff T in 2024-01..2026-04:
// "standing at T, knowing only windows that had ENDED by T, how good was our
// P(bonus in the next 2 months) for each route?" -- the exact number the
// panel's WAIT/TOSS-UP/SEND NOW verdict consumes.
//
// Scored predictors:
//   model  -- what ships today: raw mp[] frequencies composed by independence,
//             1 - (1-mp[m1])(1-mp[m2])
//   clim   -- per-route climatology: the fraction of historical 2-month
//             stretches that contained a bonus. The "no seasonality, no
//             recency" floor any model must beat.
//   cand   -- the proposed estimator (analysis §§1-3): EMPIRICAL union over
//             the same 2 calendar months (no independence assumption, no
//             double-count of spanning windows), denominator = occurrences of
//             that 2-month stretch actually observed (no not-yet-reached-year
//             bias), Beta-smoothed toward climatology with tau=2 pseudo-years.
//
// Information hygiene: training uses windows with end < T only (the archive
// lists a window after it expires -- a still-running bonus at T is the LIVE
// tab's business, and those route-cutoffs are excluded exactly like the
// product excludes them from Forecast). Outcomes come from the full archive.
// Last cutoff is 2026-04 so both outcome months are fully in the past.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { source, parseHistory } from '../src/sources/frequentmiler.mjs';
import { resolveBank, resolvePartner } from '../src/aliases.mjs';
import { deriveHistory, parseMDY } from '../src/history.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TAU = Number(process.env.TAU ?? 2); // pseudo-years of smoothing toward climatology in `cand`

// Absolute month index -- the only currency the overlap math deals in.
const ami = (y, m) => y * 12 + m;
const amiOf = (d) => ami(d.getUTCFullYear(), d.getUTCMonth());

// Windows resolved and parsed with production's own resolvers/parser.
function resolveWindows(raw) {
  const out = [];
  for (const w of raw) {
    const bank = resolveBank(w.bankName);
    const code = resolvePartner(w.partnerName);
    const start = parseMDY(w.startDateRaw);
    const end = parseMDY(w.endDateRaw);
    if (!bank || !code || !start || !end || end < start) continue;
    out.push({ id: `${bank.toLowerCase()}-${code.toLowerCase()}`, raw: w, start, end, s: amiOf(start), e: amiOf(end) });
  }
  return out;
}

const overlaps2 = (w, t1, t2) => (w.s <= t1 && w.e >= t1) || (w.s <= t2 && w.e >= t2);

// Per-route climatology at cutoff: over every observed 2-month stretch
// [t, t+1] with t from the route's first archived month to the month before
// the cutoff, the fraction that contained a bonus.
function climatology(ws, cutAmi) {
  const first = Math.min(...ws.map((w) => w.s));
  let hits = 0, n = 0;
  for (let t = first; t + 1 <= cutAmi - 1; t += 1) {
    n += 1;
    if (ws.some((w) => overlaps2(w, t, t + 1))) hits += 1;
  }
  return n ? { p: hits / n, n } : { p: 0.5, n: 0 };
}

// Candidate: empirical union for THIS calendar 2-month stretch across observed
// years, corrected denominator, shrunk toward climatology.
function candidate(ws, t1, t2, cutAmi, clim) {
  const first = Math.min(...ws.map((w) => w.s));
  let k = 0, n = 0;
  // walk the same (m1, m2) pair back one year at a time while fully observed
  for (let a1 = t1 - 12, a2 = t2 - 12; a1 >= first && a2 <= cutAmi - 1; a1 -= 12, a2 -= 12) {
    n += 1;
    if (ws.some((w) => overlaps2(w, a1, a2))) k += 1;
  }
  return (k + TAU * clim) / (n + TAU);
}

// --- candidate refinements under test (2026-07-25 second round) -------------
// Exponential year decay: the 2020-22 promo regime (3 windows/yr on routes
// that now run ~1/yr) must not weigh like the present. Half-life fixed a
// priori at 3 years.
const HALF_LIFE_Y = 3;
const yw = (cutAmi, m) => 0.5 ** ((Math.floor(cutAmi / 12) - Math.floor(m / 12)) / HALF_LIFE_Y);

function climatologyW(ws, cutAmi) {
  const first = Math.min(...ws.map((w) => w.s));
  let hits = 0, n = 0;
  for (let t = first; t + 1 <= cutAmi - 1; t += 1) {
    const w = yw(cutAmi, t);
    n += w;
    if (ws.some((x) => overlaps2(x, t, t + 1))) hits += w;
  }
  return n ? hits / n : 0.5;
}

function candidateW(ws, t1, t2, cutAmi, clim) {
  const first = Math.min(...ws.map((w) => w.s));
  let k = 0, n = 0;
  for (let a1 = t1 - 12, a2 = t2 - 12; a1 >= first && a2 <= cutAmi - 1; a1 -= 12, a2 -= 12) {
    const w = yw(cutAmi, a1);
    n += w;
    if (ws.some((x) => overlaps2(x, a1, a2))) k += w;
  }
  return (k + TAU * clim) / (n + TAU);
}

// Pooled refractory hazard: how likely a NEW window is to start, by months
// elapsed since the route's last window ended — estimated from the training
// slice only (no leakage), pooled across routes because 5-10 windows per
// route cannot support per-route conditioning. EB-smoothed toward the
// overall rate with 24 pseudo-months per bucket.
const BUCKETS = [[0, 2], [3, 5], [6, 11], [12, Infinity]];
const bucketOf = (t) => BUCKETS.findIndex(([lo, hi]) => t >= lo && t <= hi);
function refractoryMults(byIdTrain, cutAmi) {
  const starts = [0, 0, 0, 0], months = [0, 0, 0, 0];
  let allStarts = 0, allMonths = 0;
  for (const ws of byIdTrain.values()) {
    if (!ws.length) continue;
    const sorted = ws.slice().sort((a, b) => a.s - b.s);
    for (let m = sorted[0].e + 1; m < cutAmi; m += 1) {
      const prevEnds = sorted.filter((w) => w.e < m).map((w) => w.e);
      if (!prevEnds.length) continue;
      const b = bucketOf(m - Math.max(...prevEnds));
      months[b] += 1; allMonths += 1;
      if (sorted.some((w) => w.s === m)) { starts[b] += 1; allStarts += 1; }
    }
  }
  const hAll = allMonths ? allStarts / allMonths : 0;
  return BUCKETS.map((_, b) => {
    const h = (starts[b] + 24 * hAll) / (months[b] + 24);
    return hAll ? h / hAll : 1;
  });
}
// A multiplier on the hazard maps to probabilities as p -> 1-(1-p)^mult.
const applyMult = (p, mult) => 1 - (1 - Math.min(p, 0.999)) ** mult;

const brier = (rows, key) => rows.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / rows.length;
const logloss = (rows, key) => rows.reduce((s, r) => {
  const p = Math.min(0.999, Math.max(0.001, r[key])); // model emits exact 0s
  return s - (r.y ? Math.log(p) : Math.log(1 - p));
}, 0) / rows.length;

// --- self-check on synthetic data (always runs; costs nothing) --------------
{
  const mkw = (sy, sm, ey, em) => ({ s: ami(sy, sm), e: ami(ey, em) });
  // every-March route: window spanning months double-counts nothing here
  const march = [mkw(2021, 2, 2021, 2), mkw(2022, 2, 2022, 2), mkw(2023, 2, 2023, 2)];
  const cut = ami(2024, 1); // Feb 2024
  assert.equal(climatology(march, cut).n, ami(2024, 0) - ami(2021, 2), 'clim counts observed stretches');
  // predicting Mar+Apr 2024: 3 fully-observed prior years, all hits
  // 3/3 hit years -> closed form (3 + TAU*clim)/(3 + TAU). Deliberately NOT ~1.0:
  // three observations never earn near-certainty.
  const cl = climatology(march, cut).p;
  const c = candidate(march, ami(2024, 2), ami(2024, 3), cut, cl);
  assert.ok(Math.abs(c - (3 + TAU * cl) / (3 + TAU)) < 1e-9, 'candidate matches its closed form: ' + c);
  assert.ok(c < 0.95, 'three observations never earn near-certainty: ' + c);
  // predicting Jun+Jul: 0 hits in 3 years -> shrunk toward clim, never 0
  const c0 = candidate(march, ami(2024, 5), ami(2024, 6), cut, cl);
  assert.ok(c0 > 0 && Math.abs(c0 - (TAU * cl) / (3 + TAU)) < 1e-9, 'zero-hit stretch shrinks but never hits 0: ' + c0);
  // a window spanning Dec-Jan overlaps both a (Nov,Dec) and a (Jan,Feb) probe
  const span = mkw(2022, 11, 2023, 0);
  assert.ok(overlaps2(span, ami(2022, 10), ami(2022, 11)) && overlaps2(span, ami(2023, 0), ami(2023, 1)), 'spanning window overlap');
  assert.ok(!overlaps2(span, ami(2023, 1), ami(2023, 2)), 'no phantom overlap');
}

// --- data ------------------------------------------------------------------
const cachePath = process.argv[2] ?? '';
let html;
if (cachePath && existsSync(cachePath)) {
  html = readFileSync(cachePath, 'utf8');
  console.log(`[backtest] using cached archive html: ${cachePath}`);
} else {
  console.log(`[backtest] fetching ${source.url}`);
  const res = await fetch(source.url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  html = await res.text();
  if (cachePath) { writeFileSync(cachePath, html); console.log(`[backtest] cached to ${cachePath}`); }
}
const raw = parseHistory(html);
const all = resolveWindows(raw);
const byId = new Map();
for (const w of all) { if (!byId.has(w.id)) byId.set(w.id, []); byId.get(w.id).push(w); }
console.log(`[backtest] archive: ${raw.length} rows, ${all.length} resolved, ${byId.size} routes`);

// --- walk-forward ----------------------------------------------------------
const rows = [];
for (let cutAmi = ami(2024, 0); cutAmi <= ami(2026, 3); cutAmi += 1) {
  const cy = Math.floor(cutAmi / 12), cm = cutAmi % 12;
  const T = new Date(Date.UTC(cy, cm, 1));
  const t1 = cutAmi + 1, t2 = cutAmi + 2; // the panel's next-2-months window
  // information set at T: windows that had ended before T
  const trainRaw = raw.filter((w) => { const e = parseMDY(w.endDateRaw); return e && e < T; });
  const derived = deriveHistory(T, trainRaw);
  const byIdTrain = new Map();
  for (const [id, ws] of byId) {
    const train = ws.filter((w) => w.end < T);
    if (train.length) byIdTrain.set(id, train);
  }
  const mults = refractoryMults(byIdTrain, cutAmi);
  for (const [id, entry] of derived) {
    if (!entry.next) continue; // product's own guard: <2 windows never surfaces
    const ws = byId.get(id) ?? [];
    if (ws.some((w) => w.s <= cutAmi && w.e >= cutAmi)) continue; // live at T -> not Forecast's problem
    const train = byIdTrain.get(id) ?? [];
    if (!train.length) continue;
    const m1 = t1 % 12, m2 = t2 % 12;
    const model = 1 - (1 - entry.mp[m1]) * (1 - entry.mp[m2]);
    const cl = climatology(train, cutAmi);
    const cand = candidate(train, t1, t2, cutAmi, cl.p);
    const clW = climatologyW(train, cutAmi);
    const candD = candidateW(train, t1, t2, cutAmi, clW);
    const lastEnd = Math.max(...train.map((w) => w.e));
    const mult = mults[bucketOf(Math.max(0, cutAmi - lastEnd))];
    const candR = applyMult(cand, mult);
    const candDR = applyMult(candD, mult);
    const y = ws.some((w) => overlaps2(w, t1, t2)) ? 1 : 0;
    rows.push({ id, T: T.toISOString().slice(0, 7), model, clim: cl.p, cand, candD, candR, candDR, y });
  }
}

// --- report ----------------------------------------------------------------
const n = rows.length, base = rows.reduce((s, r) => s + r.y, 0) / n;
console.log(`\n${n} route-cutoff predictions, ${Math.round(base * 100)}% base event rate\n`);
console.log('predictor   Brier    log-loss   skill vs clim');
const bClim = brier(rows, 'clim');
for (const key of ['model', 'clim', 'cand', 'candD', 'candR', 'candDR']) {
  const b = brier(rows, key);
  const skill = key === 'clim' ? '—' : ((1 - b / bClim) * 100).toFixed(1) + '%';
  console.log(`${key.padEnd(10)} ${b.toFixed(4)}   ${logloss(rows, key).toFixed(4)}     ${skill}`);
}

for (const key of ['cand', 'candDR']) {
  console.log(`\ncalibration — ${key} (predicted decile -> what actually happened)`);
  console.log('bin        n     mean p   observed');
  for (let b = 0; b < 10; b += 1) {
    const bin = rows.filter((r) => r[key] >= b / 10 && (b === 9 ? r[key] <= 1 : r[key] < (b + 1) / 10));
    if (!bin.length) continue;
    const mp = bin.reduce((s, r) => s + r[key], 0) / bin.length;
    const oy = bin.reduce((s, r) => s + r.y, 0) / bin.length;
    console.log(`${(b * 10 + '-' + (b + 1) * 10 + '%').padEnd(9)} ${String(bin.length).padStart(4)}   ${(mp * 100).toFixed(0).padStart(5)}%   ${(oy * 100).toFixed(0).padStart(7)}%`);
  }
}

// worst overconfident misses -- the errors that cost users real miles
const misses = rows.filter((r) => Math.abs(r.model - r.y) > 0.6).sort((a, b) => Math.abs(b.model - b.y) - Math.abs(a.model - a.y));
console.log(`\n${misses.length} predictions off by >60% (worst 8):`);
for (const m of misses.slice(0, 8)) console.log(`  ${m.T} ${m.id.padEnd(12)} model=${Math.round(m.model * 100)}% cand=${Math.round(m.cand * 100)}% actual=${m.y}`);
