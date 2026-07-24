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
    // each of the 4 fixtures has exactly one row with an unrecognized partner name
    assert.equal(result.unmapped.length, 4);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
