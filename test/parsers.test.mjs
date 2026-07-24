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

for (const src of SOURCES) {
  test(`${src.id}: extracts the valid rows and skips the malformed one with a warning`, async () => {
    const html = fixture(src.id);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    let entries;
    try {
      entries = await src.parse(html);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(entries.length, 4, `${src.id} should extract 4 valid entries (5 rows minus 1 malformed)`);
    assert.equal(warnings.length, 1, `${src.id} should warn exactly once for the malformed row`);
    for (const entry of entries) {
      assert.equal(typeof entry.bankName, 'string');
      assert.ok(entry.bankName.length > 0);
      assert.equal(typeof entry.partnerName, 'string');
      assert.ok(entry.partnerName.length > 0);
      assert.equal(typeof entry.pct, 'number');
      assert.equal(typeof entry.endDateRaw, 'string');
      assert.equal(entry.sourceUrl, src.url);
    }
  });
}

test('frequentmiler: pct and endDateRaw are extracted correctly for a known row', async () => {
  const entries = await frequentmiler.parse(fixture('frequentmiler'));
  const row = entries.find((e) => e.partnerName === 'Avianca LifeMiles' && e.bankName.includes('Amex'));
  assert.ok(row, 'expected the Amex -> Avianca row to be present');
  assert.equal(row.pct, 25);
  assert.equal(row.endDateRaw, 'July 29, 2026');
});

test('awardwallet: pct and endDateRaw are extracted correctly for a known row', async () => {
  const entries = await awardwallet.parse(fixture('awardwallet'));
  const row = entries.find((e) => e.partnerName === 'Qatar Airways Avios');
  assert.ok(row, 'expected the Citi -> Qatar row to be present');
  assert.equal(row.pct, 25);
  assert.equal(row.endDateRaw, '7/25/26');
});
