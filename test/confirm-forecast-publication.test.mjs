import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { updateForecastRecords } from '../src/forecast-records.mjs';

const script = fileURLToPath(new URL('../scripts/confirm-forecast-publication.mjs', import.meta.url));
const fixture = (issuedAt = '2026-11-01T10:00:00Z', probability = 0.7) => {
  const date = new Date(issuedAt);
  return { generatedAt: issuedAt, routes: [{ id: 'chase-ba', bank: 'CHASE', code: 'BA', airline: 'British Airways', forecast: {
    modelVersion: 'pooled-recurrence-v2', issuedAt, evidence: { level: 'limited' }, horizons: [{
      months: 1, probability,
      startDate: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10),
      endDate: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0)).toISOString().slice(0, 10),
    }],
  } }] };
};

const invoke = (ledger, feed, at) => spawnSync(process.execPath, [script, '--ledger', ledger, '--feed', feed,
  ...(at ? ['--published-at', at] : [])], { encoding: 'utf8' });

test('CLI confirms only the published build artifact, preserves original attempts and replays without writes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-confirm-cli-'));
  try {
    const first = fixture();
    const published = fixture('2026-11-01T11:00:00Z', 0.9);
    const original = updateForecastRecords(updateForecastRecords(null, first), published);
    const ledgerPath = path.join(dir, 'ledger.json'), feedPath = path.join(dir, 'expected-feed.json');
    writeFileSync(ledgerPath, JSON.stringify(original));
    const feedBytes = JSON.stringify(published);
    writeFileSync(feedPath, feedBytes);
    const result = invoke(ledgerPath, feedPath, '2026-11-01T11:01:00Z');
    assert.equal(result.status, 0, result.stderr);
    const confirmedBytes = readFileSync(ledgerPath, 'utf8');
    const confirmed = JSON.parse(confirmedBytes);
    assert.equal(confirmed.records[0].publicationStatus, 'unconfirmed');
    assert.equal(confirmed.records[1].publicationStatus, 'confirmed');
    assert.equal(confirmed.records[1].publishedAt, '2026-11-01T11:01:00Z');
    assert.deepEqual(confirmed.records.map(r => r.probability), [0.7, 0.9]);
    assert.deepEqual(confirmed.samples, original.samples);
    assert.equal(readFileSync(feedPath, 'utf8'), feedBytes);
    assert.equal(invoke(ledgerPath, feedPath, '2026-11-01T11:02:00Z').status, 0);
    assert.equal(readFileSync(ledgerPath, 'utf8'), confirmedBytes);
    assert.deepEqual(readdirSync(dir).sort(), ['expected-feed.json', 'ledger.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI never replaces a missing, corrupt or structurally invalid ledger', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-confirm-invalid-'));
  try {
    const ledgerPath = path.join(dir, 'ledger.json'), feedPath = path.join(dir, 'expected-feed.json');
    writeFileSync(feedPath, JSON.stringify(fixture()));
    const missing = invoke(ledgerPath, feedPath, '2026-11-01T11:01:00Z');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);
    assert.equal(existsSync(ledgerPath), false);
    for (const bytes of ['{broken', JSON.stringify({ version: 1, records: [], samples: null })]) {
      writeFileSync(ledgerPath, bytes);
      const result = invoke(ledgerPath, feedPath, '2026-11-01T11:01:00Z');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid forecast ledger/);
      assert.equal(readFileSync(ledgerPath, 'utf8'), bytes);
    }
    assert.deepEqual(readdirSync(dir).sort(), ['expected-feed.json', 'ledger.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI leaves the ledger untouched for a corrupt or mismatched expected feed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-confirm-feed-'));
  try {
    const ledgerPath = path.join(dir, 'ledger.json'), feedPath = path.join(dir, 'expected-feed.json');
    const issued = fixture();
    const original = JSON.stringify(updateForecastRecords(null, issued));
    writeFileSync(ledgerPath, original);
    writeFileSync(feedPath, '{broken');
    const broken = invoke(ledgerPath, feedPath, '2026-11-01T10:01:00Z');
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /invalid published feed/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), original);
    writeFileSync(feedPath, JSON.stringify(fixture('2026-11-01T10:00:00Z', 0.9)));
    assert.equal(invoke(ledgerPath, feedPath, '2026-11-01T10:01:00Z').status, 0);
    assert.equal(readFileSync(ledgerPath, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI defaults publication time to the confirmation time and accepts local files only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-confirm-now-'));
  try {
    const ledgerPath = path.join(dir, 'ledger.json'), feedPath = path.join(dir, 'expected-feed.json');
    const issued = fixture(new Date(Date.now() - 60000).toISOString());
    writeFileSync(ledgerPath, JSON.stringify(updateForecastRecords(null, issued)));
    writeFileSync(feedPath, JSON.stringify(issued));
    const before = Date.now();
    const result = invoke(ledgerPath, feedPath);
    const after = Date.now();
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const published = Date.parse(saved.records[0].publishedAt);
    assert.ok(published >= before && published <= after);
    const remote = invoke(ledgerPath, 'https://example.com/feed.json');
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /local files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
