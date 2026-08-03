#!/usr/bin/env node
// Parse -> normalize -> validate -> publish, with a fail-safe: invalid or
// mostly-failed source data never overwrites out/feed.json.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { source as frequentmiler } from './sources/frequentmiler.mjs';
import { source as awardwallet } from './sources/awardwallet.mjs';
import { source as livelo } from './sources/livelo.mjs';
import { source as esfera } from './sources/esfera.mjs';
import { normalize } from './normalize.mjs';
import { recordHistory, rawHistory } from './history.mjs';
import { loadLedger, updateLedger, toRawWindows } from './observed.mjs';
import { DIRECTORY_SOURCES, mergeDirectory } from './sources/partner-directory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCES = [frequentmiler, awardwallet, livelo, esfera];

// Route-count cliff guard. A run that publishes less than half the previous
// feed is far more likely a parser quietly breaking (site redesign -> selectors
// match nothing -> warn-and-skip -> short feed) than the market really losing
// half its bonuses overnight, so abort instead of shipping the shrunken feed.
// Below MIN_PREV_ROUTES the feed is small enough that ordinary churn (one bonus
// ending) reads as a >50% drop, so the guard stays off there.
const CLIFF_MAX_DROP = 0.5;
const CLIFF_MIN_PREV_ROUTES = 4;

async function fetchHtml(src, fixtures, fixturesDir) {
  if (fixtures) {
    return readFileSync(path.join(fixturesDir, `${src.id}.html`), 'utf8');
  }
  // Live mode - only exercised at go-live (see GO-LIVE.md); never run during
  // this build (no network access in this environment).
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Runs the plan-001 validator (scripts/validate-feed.mjs) in-process on the
// in-memory candidate, via a scratch file, *before* anything touches
// out/feed.json. Using the real validator script (as a subprocess, since it
// calls process.exit at module scope and isn't safe to import directly)
// keeps this pipeline in lockstep with plan 001's schema without duplicating
// its validation logic here.
function validateCandidate(candidate, outDir) {
  const tmpFile = path.join(outDir, '.candidate.json');
  writeFileSync(tmpFile, JSON.stringify(candidate, null, 2));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-feed.mjs'), tmpFile], { stdio: 'pipe' });
    return { valid: true };
  } catch (e) {
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.toString().trim();
    return { valid: false, message: output || e.message };
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

// Previous published feed, or null when there isn't a readable one (bootstrap
// run, or a corrupt file). Both the partial-failure merge and the cliff guard
// read it.
function readPreviousFeed(outDir) {
  try {
    return JSON.parse(readFileSync(path.join(outDir, 'feed.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Runs the full pipeline and returns a summary instead of calling
 * process.exit, so both the CLI wrapper below and tests can drive it.
 *
 * @param {{fixtures?:boolean, fixturesDir?:string, outDir?:string, now?:Date, injectBadRoute?:boolean}} opts
 *   injectBadRoute is a test-only hook (see test/publish.test.mjs) that
 *   forces a schema-invalid candidate to exercise the abort path without
 *   needing a real source failure. fixturesDir lets tests point the parsers at
 *   degraded HTML (see test/robustness.test.mjs).
 */
export async function runPipeline({
  fixtures = false,
  fixturesDir = path.join(ROOT, 'fixtures'),
  outDir = path.join(ROOT, 'out'),
  now = new Date(),
  injectBadRoute = false,
  // The self-archived history ledger (see observed.mjs). Default null — inert —
  // so tests importing runPipeline can never touch the real committed ledger;
  // the CLI entrypoint below is what passes the production path.
  ledgerPath = null,
} = {}) {
  mkdirSync(outDir, { recursive: true });

  const raw = [];
  const failedSources = [];
  const entryCounts = {};

  for (const src of SOURCES) {
    entryCounts[src.id] = 0;
    try {
      const html = await fetchHtml(src, fixtures, fixturesDir);
      const entries = (await src.parse(html)) ?? [];
      entryCounts[src.id] = entries.length;
      // A parse that yields nothing is a broken parser, not an empty listing:
      // none of these four sources is ever legitimately at zero bonuses. The
      // parsers warn-and-skip rather than throw, so this is the only place a
      // page redesign shows up. Same bucket as a thrown error.
      if (entries.length === 0) {
        console.warn(`[publish] source "${src.id}" returned 0 entries — treating as failed`);
        failedSources.push(src.id);
        continue;
      }
      raw.push(...entries);
    } catch (e) {
      console.warn(`[publish] source "${src.id}" failed: ${e.message}`);
      failedSources.push(src.id);
    }
  }
  const sourcesOk = SOURCES.length - failedSources.length;

  if (failedSources.length / SOURCES.length > 0.5) {
    const reason = `${failedSources.length}/${SOURCES.length} sources failed (>50%): ${failedSources.join(', ')}`;
    console.error(`PUBLISH ABORTED: ${reason}`);
    return { ok: false, reason };
  }

  // Feed the self-archived ledger into history BEFORE normalize derives it.
  // Order matters: the FM source records its archive during parse (above), and
  // toRawWindows dedupes against exactly that, so a window FM also archived is
  // counted once. An unreadable ledger contributes nothing and (crucially) is
  // never overwritten below.
  const ledger = ledgerPath ? loadLedger(ledgerPath) : { ok: false, windows: [] };
  // Always re-record, even with nothing to feed: the history store is
  // replace-by-source, so an unconditional call is what clears a previous
  // in-process run's observed windows instead of leaking them into this one.
  const observedRaw = ledger.ok ? toRawWindows(ledger.windows, rawHistory()) : [];
  recordHistory('observed', observedRaw);
  if (ledger.windows.length) {
    console.log(`[observed] ledger: ${ledger.windows.length} window(s), ${observedRaw.length} feeding history after FM dedupe`);
  }

  const { routes: candidateRoutes, unmapped } = normalize(raw, now);

  // Read BEFORE the ledger update, not just for the merge below: at this point
  // out/feed.json is still what users were actually served (CI seeds it from
  // the live deployment), which makes it the only honest source for the
  // prospective `pred` stamp — what the engine said BEFORE the window opened.
  const previous = readPreviousFeed(outDir);

  // Fold THIS run's live sightings into the ledger — before the stale-route
  // merge below, which would otherwise advance lastSeen on bonuses nobody
  // actually saw this run. Day-granular, so the file only changes ~once a day.
  if (ledgerPath && ledger.ok) {
    const updated = updateLedger(ledger.windows, candidateRoutes.filter((r) => r.active), now.toISOString().slice(0, 10), previous);
    if (JSON.stringify(updated) !== JSON.stringify(ledger.windows)) {
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify({ version: 1, windows: updated }, null, 2) + '\n');
      console.log(`[observed] ledger updated: ${updated.length} window(s)`);
    }
  }

  // ponytail: a route in the contract carries no source tag, so a failed
  // source's prior contribution can't be pulled out individually. The
  // previous full feed already IS the union of every source's last good
  // output, so "merge from previous" is applied feed-wide: previous routes
  // fill in any id this run's candidate didn't produce (staleness beats
  // absence). Upgrade path: tag routes with their source id if per-source
  // fallback ever matters more precisely than this.
  let mergedFromPrevious = 0;
  if (failedSources.length > 0 && previous) {
    const candidateIds = new Set(candidateRoutes.map((r) => r.id));
    for (const r of previous.routes ?? []) {
      if (!candidateIds.has(r.id)) {
        candidateRoutes.push(r);
        mergedFromPrevious += 1;
      }
    }
  }

  // Cliff guard, after the merge: what's checked is what would actually be
  // published. No previous feed (bootstrap) = nothing to compare, publish.
  const prevRoutes = previous?.routes?.length ?? 0;
  if (prevRoutes >= CLIFF_MIN_PREV_ROUTES && candidateRoutes.length < prevRoutes * CLIFF_MAX_DROP) {
    const reason = `route count fell from ${prevRoutes} to ${candidateRoutes.length}`;
    console.error(`PUBLISH ABORTED: ${reason}`);
    return { ok: false, reason };
  }

  if (injectBadRoute) {
    candidateRoutes.push({ id: 'broken-test-route', bank: 'AMEX', airline: 'Test', code: 'AF' });
  }

  const candidate = {
    version: 1,
    generatedAt: now.toISOString(),
    routes: candidateRoutes,
  };

  const { valid, message } = validateCandidate(candidate, outDir);
  if (!valid) {
    const reason = `candidate failed schema validation: ${message}`;
    console.error(`PUBLISH ABORTED: ${reason}`);
    return { ok: false, reason };
  }

  writeFileSync(path.join(outDir, 'feed.json'), JSON.stringify(candidate, null, 2));

  // Partner directory refreshed from the official pages on every build —
  // partners join and leave (Esfera dropped AAdvantage; Livelo added United).
  // Failures here never abort the publish and never count toward the source
  // failure guard above: mergeDirectory keeps the curated lists for any bank
  // whose scrape failed, so the worst case is yesterday's directory.
  const partnersDoc = JSON.parse(readFileSync(path.join(ROOT, 'sample', 'partners.json'), 'utf8'));
  const scrapedDir = {};
  for (const src of DIRECTORY_SOURCES) {
    try {
      const html = fixtures
        ? readFileSync(path.join(fixturesDir, src.fixture), 'utf8')
        : await (async () => {
          const res = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' }, signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })();
      Object.assign(scrapedDir, src.parse(html));
    } catch (e) {
      console.warn(`[publish] directory source "${src.id}" failed (${e.message}) — curated lists kept for ${src.banks.join(', ')}`);
    }
  }
  partnersDoc.directory = mergeDirectory(partnersDoc.directory, scrapedDir);
  writeFileSync(path.join(outDir, 'partners.json'), JSON.stringify(partnersDoc, null, 2));

  const activeCount = candidateRoutes.filter((r) => r.active).length;
  const unmappedNames = unmapped.map((u) => u.partnerName || u.bankName);
  // per-source counts so a source quietly sliding toward zero is visible in the
  // Actions log before it hits zero and trips the guard above
  const perSource = SOURCES.map((s) => `${s.id}:${entryCounts[s.id]}`).join(' ');
  console.log(
    `PUBLISH OK: ${candidateRoutes.length} routes (${activeCount} active), sources ok ${sourcesOk}/${SOURCES.length} (${perSource}), unmapped: [${unmappedNames.join(', ')}]`,
  );
  if (mergedFromPrevious > 0) {
    console.log(`[publish] merged ${mergedFromPrevious} stale route(s) from previous feed for failed source(s): ${failedSources.join(', ')}`);
  }

  return { ok: true, routes: candidateRoutes, unmapped, sourcesOk, sourcesTotal: SOURCES.length, failedSources, entryCounts };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fixtures = process.argv.includes('--fixtures');
  // Real builds (CI cron and operator runs) maintain the ledger; fixture runs
  // must not pollute it with fixture sightings.
  const ledgerPath = fixtures ? null : path.join(ROOT, 'data', 'observed-windows.json');
  runPipeline({ fixtures, ledgerPath }).then((result) => {
    process.exit(result.ok ? 0 : 2);
  });
}
