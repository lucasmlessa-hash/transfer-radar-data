import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { source as frequentmiler } from '../src/sources/frequentmiler.mjs';
import { source as awardwallet } from '../src/sources/awardwallet.mjs';
import { source as livelo } from '../src/sources/livelo.mjs';
import { source as esfera } from '../src/sources/esfera.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture(name) {
  return readFileSync(path.join(__dirname, '..', 'fixtures', `${name}.html`), 'utf8');
}

const SOURCES = [frequentmiler, awardwallet, livelo, esfera];

// endDateRaw is either empty (no published deadline) or one of the shapes
// normalize.mjs's parseEndDate() understands: "Month D, YYYY", "M/D/YY(YY)",
// "D/M" (no year), or "until Mon D".
const KNOWN_DATE_SHAPE =
  /^$|^[A-Za-z]+\s+\d{1,2},?\s*\d{4}$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$|^until\s+[A-Za-z]{3,}\s+\d{1,2}$/;

// These fixtures are snapshots of real, weekly-changing pages. Assert on
// structure/invariants here so the suite doesn't rot every time a site
// reshuffles its current bonus list - exact-value spot checks live in the
// per-source tests below, scoped to the one or two facts worth pinning down.
for (const src of SOURCES) {
  test(`${src.id}: returns structurally valid entries`, async () => {
    const html = fixture(src.id);
    const entries = await src.parse(html);

    assert.ok(entries.length >= 1, `${src.id} should return at least 1 entry`);
    for (const entry of entries) {
      assert.equal(typeof entry.bankName, 'string');
      assert.ok(entry.bankName.length > 0, `${src.id}: bankName must not be empty`);
      assert.equal(typeof entry.partnerName, 'string');
      assert.ok(entry.partnerName.length > 0, `${src.id}: partnerName must not be empty`);
      assert.equal(typeof entry.pct, 'number');
      assert.ok(Number.isFinite(entry.pct), `${src.id}: pct must not be NaN`);
      assert.ok(entry.pct > 0 && entry.pct <= 500, `${src.id}: pct ${entry.pct} out of plausible range`);
      assert.equal(typeof entry.endDateRaw, 'string');
      assert.match(entry.endDateRaw, KNOWN_DATE_SHAPE, `${src.id}: unrecognized endDateRaw shape "${entry.endDateRaw}"`);
      assert.equal(entry.sourceUrl, src.url);
    }
  });
}

// frequentmiler's fixture is a saved snapshot (not fetched live in tests), so
// pinning its exact shape is safe and catches real parser regressions.
test('frequentmiler: fixture spot-check (saved snapshot)', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  let entries;
  try {
    entries = await frequentmiler.parse(fixture('frequentmiler'));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(entries.length, 6, 'the current/upcoming table has 6 valid rows');
  assert.equal(warnings.length, 1, 'the one non-data row in the table should warn once');

  const row = entries.find((e) => e.partnerName === 'IHG');
  assert.ok(row, 'expected the Chase -> IHG row to be present');
  assert.equal(row.bankName, 'Chase Ultimate Rewards');
  assert.equal(row.pct, 100);
  assert.equal(row.endDateRaw, '07/30/26');
});

test('awardwallet: fixture spot-check (saved snapshot)', async () => {
  const entries = await awardwallet.parse(fixture('awardwallet'));

  assert.equal(entries.length, 9);

  const row = entries.find((e) => e.partnerName === 'Air France (Flying Blue)');
  assert.ok(row, 'expected the Citibank -> Air France row to be present');
  assert.equal(row.bankName, 'Citibank (ThankYou Rewards)');
  assert.equal(row.pct, 20);
  assert.equal(row.endDateRaw, 'August 22, 2026');
});

test('livelo: fixture spot-check (saved snapshot)', async () => {
  const entries = await livelo.parse(fixture('livelo'));

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    bankName: 'Livelo',
    partnerName: 'Hilton Honors',
    pct: 50,
    endDateRaw: '', // no machine-readable deadline published - by design, not a bug
    sourceUrl: livelo.url,
  });
});

test('esfera: fixture spot-check (saved snapshot)', async () => {
  const entries = await esfera.parse(fixture('esfera'));

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    bankName: 'Esfera',
    partnerName: 'Azul',
    pct: 115,
    endDateRaw: '26/07',
    sourceUrl: esfera.url,
  });
});
