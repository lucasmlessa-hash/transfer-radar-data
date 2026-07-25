import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePartner, resolveBank, partnerDisplayName } from '../src/aliases.mjs';

// The FM historical archive uses a different naming convention than the
// current-bonus table the alias map was originally calibrated against.
test('historical-archive name variants resolve to already-tracked codes', () => {
  assert.equal(resolvePartner('Qatar Privilege Club Avios'), 'QR');
  assert.equal(resolvePartner('Aer Lingus Avios'), 'EI');
});

// Guard: names that must NEVER resolve. The bare currency name is ambiguous
// across BA/QR/EI/IB; hotels and untracked currencies must stay unmapped.
test('shared-currency and out-of-scope names still refuse to resolve', () => {
  assert.ok(!resolvePartner('Avios'));
  assert.ok(!resolvePartner('Marriott Bonvoy'));
  assert.ok(!resolvePartner('IHG'));
  assert.ok(!resolveBank('Rove'));
  assert.ok(!resolveBank('PAYBACK'));
});
