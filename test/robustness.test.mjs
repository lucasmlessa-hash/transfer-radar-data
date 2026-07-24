// Guards against the pipeline silently publishing a degraded feed:
// a source that parses fine but yields nothing, and a sudden route-count cliff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runPipeline } from '../src/publish.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY_PAGE = '<html><head><title>Redesigned</title></head><body><main></main></body></html>';

function scratchDir() {
  return mkdtempSync(path.join(tmpdir(), 'trd-robustness-test-'));
}

// A fixtures dir where the named sources' pages parse to nothing - what a site
// redesign looks like to a warn-and-skip parser.
function degradedFixtures(...emptyIds) {
  const dir = scratchDir();
  cpSync(path.join(ROOT, 'fixtures'), dir, { recursive: true });
  for (const id of emptyIds) writeFileSync(path.join(dir, `${id}.html`), EMPTY_PAGE);
  return dir;
}

function captureWarnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.warn = original;
    });
}

// Publishes once to learn how many routes today's fixtures actually yield, then
// rewrites that published feed to `sizeOf(baseline)` routes (id-suffixed copies
// of real ones) so the next run has a known "previous" to be compared against.
// Sizes are derived from the baseline, never hardcoded: the fixtures are live
// snapshots and the alias table keeps moving.
async function seedPreviousFeed(outDir, sizeOf) {
  const seedRun = await runPipeline({ fixtures: true, outDir });
  assert.equal(seedRun.ok, true, 'seed run must publish');
  const baseline = seedRun.routes.length;
  assert.ok(baseline >= 2, `fixtures must yield at least 2 routes, got ${baseline}`);

  const feedPath = path.join(outDir, 'feed.json');
  const feed = JSON.parse(readFileSync(feedPath, 'utf8'));
  const routeCount = sizeOf(baseline);
  const routes = [];
  for (let i = 0; routes.length < routeCount; i += 1) {
    const src = feed.routes[i % feed.routes.length];
    routes.push({ ...src, id: `${src.id}-p${i}` });
  }
  feed.routes = routes;
  writeFileSync(feedPath, JSON.stringify(feed, null, 2));
  return { baseline, routeCount, generatedAt: feed.generatedAt };
}

test('a source that parses successfully but yields 0 entries counts as failed', async () => {
  const outDir = scratchDir();
  const fixturesDir = degradedFixtures('awardwallet');
  try {
    const { result, lines } = await captureWarnings(() =>
      runPipeline({ fixtures: true, fixturesDir, outDir }),
    );
    assert.equal(result.entryCounts.awardwallet, 0);
    assert.ok(result.failedSources.includes('awardwallet'), 'zero-yield source must be in failedSources');
    assert.equal(result.sourcesOk, 3);
    assert.ok(
      lines.some((l) => l.includes('source "awardwallet" returned 0 entries')),
      `expected a distinct zero-entry warning, got: ${lines.join(' | ')}`,
    );
    // the other three still produced entries
    assert.ok(result.entryCounts.frequentmiler > 0 && result.entryCounts.livelo > 0 && result.entryCounts.esfera > 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(fixturesDir, { recursive: true, force: true });
  }
});

test('all four sources yielding 0 entries trips the >50%-failed abort', async () => {
  const outDir = scratchDir();
  const fixturesDir = degradedFixtures('frequentmiler', 'awardwallet', 'livelo', 'esfera');
  try {
    const result = await runPipeline({ fixtures: true, fixturesDir, outDir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /4\/4 sources failed/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(fixturesDir, { recursive: true, force: true });
  }
});

test('a >50% route-count cliff aborts and leaves the published feed untouched', async () => {
  const outDir = scratchDir();
  try {
    // previous feed 4x the size this run can produce -> a >50% drop
    const previous = await seedPreviousFeed(outDir, (baseline) => baseline * 4);
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, `route count fell from ${previous.routeCount} to ${previous.baseline}`);

    const onDisk = JSON.parse(readFileSync(path.join(outDir, 'feed.json'), 'utf8'));
    assert.equal(onDisk.routes.length, previous.routeCount, 'aborting must not overwrite the published feed');
    assert.equal(onDisk.generatedAt, previous.generatedAt);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('bootstrap: no previous feed does not trip the cliff guard', async () => {
  const outDir = scratchDir();
  try {
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, true);
    assert.ok(JSON.parse(readFileSync(path.join(outDir, 'feed.json'), 'utf8')).routes.length > 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// CI seeds out/feed.json by curl-ing the published Pages feed before the build
// (see .github/workflows/build-feed.yml). That step is deliberately allowed to
// leave a truncated or 0-byte file behind rather than fail the workflow, which
// only works because an unreadable previous feed degrades to "no previous feed".
test('an unreadable previous feed degrades to bootstrap, it does not abort', async () => {
  const outDir = scratchDir();
  try {
    writeFileSync(path.join(outDir, 'feed.json'), '{"version":1,"routes":[{"id":"amex-a');
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, true, `expected publish, got: ${result.reason}`);
    assert.ok(JSON.parse(readFileSync(path.join(outDir, 'feed.json'), 'utf8')).routes.length > 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a mild drop (one route fewer than before) publishes normally', async () => {
  const outDir = scratchDir();
  try {
    // previous is one route bigger than this run can produce, and at least the
    // guard's floor - a real but sub-threshold shrink must still publish
    const previous = await seedPreviousFeed(outDir, (baseline) => Math.max(4, baseline + 1));
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, true, `expected publish, got: ${result.reason}`);
    assert.equal(result.routes.length, previous.baseline);
    assert.ok(previous.routeCount >= 4 && result.routes.length < previous.routeCount);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
