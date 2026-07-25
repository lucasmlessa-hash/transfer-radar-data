// Self-archiving: the pipeline's own memory of bonus windows it saw live.
//
// Why this exists: history otherwise comes exclusively from Frequent Miler's
// expired-bonus archive, which never covers Esfera, Livelo or Rove -> those
// routes' Forecast can never improve, and FM outliving us is an assumption,
// not a guarantee. Every build appends what it observed to a git-committed
// ledger (data/observed-windows.json); windows in the ledger feed the same
// deriveHistory() the FM archive feeds, after dedupe so a window FM also
// archived is never counted twice.
//
// Ledger entry: { id, bank, code, pct, firstSeen, lastSeen, endDate? }
// with day-granular ISO dates. Day granularity is deliberate: the CI cron
// runs every 30 minutes, and committing a timestamp bump 48x/day would bury
// the repo history. One day of imprecision on a window boundary is noise at
// the month granularity the forecast operates on.

import { readFileSync } from 'node:fs';
import { resolveBank, resolvePartner } from './aliases.mjs';
import { parseMDY } from './history.mjs';

// A live listing that reappears after this many days of absence is a NEW
// bonus window, not the old one flickering (source outages make routes vanish
// for a build or two; issuers do not run back-to-back identical promos with
// a week's gap -- and if one ever does, undercounting one window beats
// stitching two real windows into a fictitious month-long one).
const REAPPEAR_GAP_DAYS = 7;

const dayDiff = (aIso, bIso) => Math.round((Date.parse(bIso) - Date.parse(aIso)) / 86400000);

/**
 * Reads the ledger. `ok: false` means the file exists but is unreadable —
 * callers must then neither use nor OVERWRITE it: clobbering years of
 * accumulated observations with a fresh empty ledger because of one corrupt
 * byte is the data-loss mode this flag exists to prevent.
 */
export function loadLedger(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: true, windows: [] }; // no file yet: legitimate bootstrap
  }
  try {
    const doc = JSON.parse(text);
    if (!Array.isArray(doc.windows)) throw new Error('missing windows[]');
    return { ok: true, windows: doc.windows };
  } catch (e) {
    console.warn(`[observed] ledger at ${path} is unreadable (${e.message}) — will not touch it this run`);
    return { ok: false, windows: [] };
  }
}

/**
 * Folds this build's live bonuses into the ledger. Pure: returns a new array.
 *
 * An active route continues an existing entry when the entry was seen
 * recently (gap <= REAPPEAR_GAP_DAYS) and its known end date hasn't passed;
 * otherwise it opens a new entry. Continuing updates lastSeen (day-granular),
 * keeps the highest pct seen, and adopts a newly-published endDate (sources
 * do extend bonuses).
 *
 * @param {Array} windows existing ledger entries
 * @param {Array} activeRoutes normalized routes carrying `active`
 * @param {string} todayIso YYYY-MM-DD of this build
 */
export function updateLedger(windows, activeRoutes, todayIso) {
  const out = windows.map((w) => ({ ...w }));
  for (const r of activeRoutes) {
    const end = r.active.endDate ?? null;
    const e = out.find((w) => w.id === r.id
      && dayDiff(w.lastSeen, todayIso) <= REAPPEAR_GAP_DAYS
      && !(w.endDate && w.endDate < todayIso));
    if (e) {
      if (todayIso > e.lastSeen) e.lastSeen = todayIso;
      if (r.active.pct > e.pct) e.pct = r.active.pct;
      if (end) e.endDate = end;
    } else {
      const entry = { id: r.id, bank: r.bank, code: r.code, pct: r.active.pct, firstSeen: todayIso, lastSeen: todayIso };
      if (end) entry.endDate = end;
      out.push(entry);
    }
  }
  return out;
}

// The window's effective end for history purposes: the published end date
// when sane, else the last day we actually saw it running.
const endOf = (w) => (w.endDate && w.endDate >= w.firstSeen) ? w.endDate : w.lastSeen;

/**
 * Ledger windows as RawWindow rows for recordHistory(), minus any window the
 * FM archive already covers — FM archives a window days after it expires, so
 * for US-bank routes the observed copy bridges the gap and then yields to
 * FM's authoritative dates once they land. Overlap on the same route id is
 * the dedupe test: two distinct real windows of one route never overlap.
 *
 * @param {Array} windows ledger entries
 * @param {Array} fmRaw RawWindow rows already recorded from the FM archive
 */
export function toRawWindows(windows, fmRaw = []) {
  const fmById = new Map();
  for (const w of fmRaw) {
    const bank = resolveBank(w.bankName);
    const code = resolvePartner(w.partnerName);
    const start = parseMDY(w.startDateRaw);
    const end = parseMDY(w.endDateRaw);
    if (!bank || !code || !start || !end) continue;
    const id = `${bank.toLowerCase()}-${code.toLowerCase()}`;
    if (!fmById.has(id)) fmById.set(id, []);
    fmById.get(id).push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
  }
  const mdy = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
  const out = [];
  for (const w of windows) {
    const end = endOf(w);
    const covered = (fmById.get(w.id) ?? []).some((f) => !(end < f.start || w.firstSeen > f.end));
    if (covered) continue;
    // bank/code round-trip through the resolvers by construction (codes are
    // their own aliases) — asserted in test/observed.test.mjs so an alias
    // refactor can't silently drop every observed window.
    out.push({ bankName: w.bank, partnerName: w.code, pct: w.pct, startDateRaw: mdy(w.firstSeen), endDateRaw: mdy(end) });
  }
  return out;
}
