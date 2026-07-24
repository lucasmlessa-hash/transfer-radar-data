import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPipeline } from '../src/publish.mjs';

function scratchDir() {
  return mkdtempSync(path.join(tmpdir(), 'trd-publish-test-'));
}

test('fail-safe: a schema-invalid candidate aborts and never writes out/feed.json', async () => {
  const outDir = scratchDir();
  try {
    const result = await runPipeline({ fixtures: true, outDir, injectBadRoute: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /schema validation/i);
    assert.equal(existsSync(path.join(outDir, 'feed.json')), false, 'feed.json must not be written on abort');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('happy path: fixtures publish a valid feed.json and partners.json', async () => {
  const outDir = scratchDir();
  try {
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, true);
    assert.ok(existsSync(path.join(outDir, 'feed.json')));
    assert.ok(existsSync(path.join(outDir, 'partners.json')));

    const feed = JSON.parse(readFileSync(path.join(outDir, 'feed.json'), 'utf8'));
    assert.equal(feed.version, 1);
    assert.ok(Array.isArray(feed.routes) && feed.routes.length > 0);
    // no leftover scratch file from the in-process validation step
    assert.equal(existsSync(path.join(outDir, '.candidate.json')), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('happy path: unmapped partner/bank names are surfaced, not silently dropped', async () => {
  const outDir = scratchDir();
  try {
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, true);
    // These fixtures are live-site snapshots that change weekly, so assert on
    // the invariant (there ARE unresolved names, and each carries a reason)
    // rather than a specific count that would break every time a site's
    // current bonus list shuffles.
    assert.ok(result.unmapped.length > 0, 'expected at least one unmapped entry');
    for (const u of result.unmapped) {
      assert.match(u.reason, /unknown (bank|partner) /);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('happy path: hotels/currencies/airlines outside the tracked set stay unmapped', async () => {
  const outDir = scratchDir();
  try {
    const result = await runPipeline({ fixtures: true, outDir });
    assert.equal(result.ok, true);
    const unmappedNames = result.unmapped.map((u) => u.bankName + '|' + u.partnerName);
    // These are real names the live sources return today (2026-07-24) for
    // banks/partners this product doesn't track - they must never resolve to
    // a route, only ever appear here.
    const mustStayUnmapped = ['IHG', 'Frontier Miles', 'Qantas', 'Rove', 'PAYBACK'];
    for (const name of mustStayUnmapped) {
      assert.ok(
        unmappedNames.some((n) => n.includes(name)),
        `expected an unmapped entry mentioning "${name}"`,
      );
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
