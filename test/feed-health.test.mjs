import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline } from '../src/publish.mjs';

const fixtures = new URL('../fixtures/', import.meta.url);
const NOW = new Date('2026-07-24T12:00:00Z');
async function scenario(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-health-'));
  const fixtureDir = path.join(dir, 'fixtures');
  cpSync(fixtures, fixtureDir, { recursive: true });
  try { await fn(dir, fixtureDir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('partial collection publishes source health without refreshing last successful observation', async () => scenario(async (dir, fixturesDir) => {
  const outDir = path.join(dir, 'out');
  await runPipeline({ fixtures: true, fixturesDir, outDir, now: NOW });
  const before = JSON.parse(readFileSync(path.join(outDir, 'feed.json')));
  writeFileSync(path.join(fixturesDir, 'awardwallet.html'), '<html>Unavailable</html>');
  const later = new Date('2026-07-24T14:00:00Z');
  const result = await runPipeline({ fixtures: true, fixturesDir, outDir, now: later });
  assert.equal(result.ok, true);
  const feed = JSON.parse(readFileSync(path.join(outDir, 'feed.json')));
  assert.equal(feed.health.status, 'degraded');
  assert.equal(feed.health.sources.awardwallet.status, 'failed');
  assert.equal(feed.health.sources.awardwallet.checkedAt, later.toISOString());
  assert.equal(feed.health.sources.awardwallet.lastSuccessAt, before.health.sources.awardwallet.lastSuccessAt);
  assert.equal(feed.health.sources.frequentmiler.status, 'ok');
  assert.equal(feed.health.sources.livelo.status, 'degraded', 'undated bonuses cannot count as complete collection');
}));

test('carried-forward promotions expire in the published feed itself', async () => scenario(async (dir, fixturesDir) => {
  const outDir = path.join(dir, 'out');
  const first = await runPipeline({ fixtures: true, fixturesDir, outDir, now: NOW });
  const feedPath = path.join(outDir, 'feed.json');
  const previous = JSON.parse(readFileSync(feedPath));
  previous.routes.push({ ...first.routes[0], id: 'previous-only', active: { pct: 25, endDate: '2026-07-23' } });
  delete previous.routes.at(-1).next;
  writeFileSync(feedPath, JSON.stringify(previous));
  writeFileSync(path.join(fixturesDir, 'awardwallet.html'), '<html>Unavailable</html>');
  await runPipeline({ fixtures: true, fixturesDir, outDir, now: NOW });
  const after = JSON.parse(readFileSync(feedPath));
  assert.equal(after.routes.find(r => r.id === 'previous-only').active, undefined);
  assert.equal(after.health.carriedForwardRoutes, 1);
}));

test('an aborted candidate never changes the observation ledger', async () => scenario(async (dir, fixturesDir) => {
  const ledgerPath = path.join(dir, 'ledger.json');
  const original = JSON.stringify({ version: 1, windows: [] });
  writeFileSync(ledgerPath, original);
  const result = await runPipeline({ fixtures: true, fixturesDir, outDir: path.join(dir, 'out'), now: NOW, ledgerPath, injectBadRoute: true });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(ledgerPath, 'utf8'), original);
}));
