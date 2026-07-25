import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The extension bundles a copy of partners.json as its offline fallback,
// kept in sync by a manual cp. This product has already shipped stale
// fallback data once (the simulated feed) because nothing guarded the copy.
test('the extension bundle matches the pipeline source of truth', () => {
  const src = JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url)));
  const bundled = JSON.parse(readFileSync(new URL('../../transfer-bonus-radar/data/partners.json', import.meta.url)));
  assert.deepStrictEqual(bundled, src, 'run: cp transfer-radar-data/sample/partners.json transfer-bonus-radar/data/partners.json');
});
