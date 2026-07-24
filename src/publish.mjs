#!/usr/bin/env node
// Parse -> normalize -> validate -> publish, with a fail-safe: invalid or
// mostly-failed source data never overwrites out/feed.json.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { source as frequentmiler } from './sources/frequentmiler.mjs';
import { source as awardwallet } from './sources/awardwallet.mjs';
import { source as livelo } from './sources/livelo.mjs';
import { source as esfera } from './sources/esfera.mjs';
import { normalize } from './normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCES = [frequentmiler, awardwallet, livelo, esfera];

async function fetchHtml(src, fixtures) {
  if (fixtures) {
    return readFileSync(path.join(ROOT, 'fixtures', `${src.id}.html`), 'utf8');
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

/**
 * Runs the full pipeline and returns a summary instead of calling
 * process.exit, so both the CLI wrapper below and tests can drive it.
 *
 * @param {{fixtures?:boolean, outDir?:string, now?:Date, injectBadRoute?:boolean}} opts
 *   injectBadRoute is a test-only hook (see test/publish.test.mjs) that
 *   forces a schema-invalid candidate to exercise the abort path without
 *   needing a real source failure.
 */
export async function runPipeline({ fixtures = false, outDir = path.join(ROOT, 'out'), now = new Date(), injectBadRoute = false } = {}) {
  mkdirSync(outDir, { recursive: true });

  const raw = [];
  const failedSources = [];

  for (const src of SOURCES) {
    try {
      const html = await fetchHtml(src, fixtures);
      const entries = await src.parse(html);
      if (!entries || entries.length === 0) throw new Error('parser returned no entries');
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

  const { routes: candidateRoutes, unmapped } = normalize(raw, now);

  // ponytail: a route in the contract carries no source tag, so a failed
  // source's prior contribution can't be pulled out individually. The
  // previous full feed already IS the union of every source's last good
  // output, so "merge from previous" is applied feed-wide: previous routes
  // fill in any id this run's candidate didn't produce (staleness beats
  // absence). Upgrade path: tag routes with their source id if per-source
  // fallback ever matters more precisely than this.
  let mergedFromPrevious = 0;
  if (failedSources.length > 0) {
    const prevPath = path.join(outDir, 'feed.json');
    if (existsSync(prevPath)) {
      try {
        const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
        const candidateIds = new Set(candidateRoutes.map((r) => r.id));
        for (const r of prev.routes ?? []) {
          if (!candidateIds.has(r.id)) {
            candidateRoutes.push(r);
            mergedFromPrevious += 1;
          }
        }
      } catch {
        // previous feed missing/corrupt - nothing to merge, candidate stands alone
      }
    }
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
  writeFileSync(path.join(outDir, 'partners.json'), readFileSync(path.join(ROOT, 'sample', 'partners.json'), 'utf8'));

  const activeCount = candidateRoutes.filter((r) => r.active).length;
  const unmappedNames = unmapped.map((u) => u.partnerName || u.bankName);
  console.log(
    `PUBLISH OK: ${candidateRoutes.length} routes (${activeCount} active), sources ok ${sourcesOk}/${SOURCES.length}, unmapped: [${unmappedNames.join(', ')}]`,
  );
  if (mergedFromPrevious > 0) {
    console.log(`[publish] merged ${mergedFromPrevious} stale route(s) from previous feed for failed source(s): ${failedSources.join(', ')}`);
  }

  return { ok: true, routes: candidateRoutes, unmapped, sourcesOk, sourcesTotal: SOURCES.length, failedSources };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fixtures = process.argv.includes('--fixtures');
  runPipeline({ fixtures }).then((result) => {
    process.exit(result.ok ? 0 : 2);
  });
}
