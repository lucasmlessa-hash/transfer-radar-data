import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The extension bundles a copy of partners.json as its offline fallback,
// kept in sync by a manual cp. This product has already shipped stale
// fallback data once (the simulated feed) because nothing guarded the copy.
//
// This is a MONOREPO invariant. The pipeline is also published on its own as
// transfer-radar-data, where transfer-bonus-radar/ simply does not exist —
// so the check skips rather than fails there. Without this the weekly ratio
// workflow, which runs `npm test` in the published repo, fails on a rule that
// cannot apply to it (and it did, on its first run).
const BUNDLE = fileURLToPath(new URL('../../transfer-bonus-radar/data/partners.json', import.meta.url));

test('the extension bundle matches the pipeline source of truth', (t) => {
  if (!existsSync(BUNDLE)) {
    t.skip('no extension alongside this checkout — pipeline published standalone');
    return;
  }
  const src = JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url)));
  const bundled = JSON.parse(readFileSync(BUNDLE));
  assert.deepStrictEqual(bundled, src, 'run: cp transfer-radar-data/sample/partners.json transfer-bonus-radar/data/partners.json');
});
