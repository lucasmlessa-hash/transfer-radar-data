import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePartner, resolveBank, partnerDisplayName } from '../src/aliases.mjs';

// The FM historical archive uses a different naming convention than the
// current-bonus table the alias map was originally calibrated against.
test('historical-archive name variants resolve to already-tracked codes', () => {
  assert.equal(resolvePartner('Qatar Privilege Club Avios'), 'QR');
  assert.equal(resolvePartner('Qatar Privilege Club'), 'QR');
  assert.equal(resolvePartner('Qatar Airways Privilege Club'), 'QR');
  assert.equal(resolvePartner('Aer Lingus Avios'), 'EI');
});

// Guard: names that must NEVER resolve. The bare currency name is ambiguous
// across BA/QR/EI/IB; hotels and untracked currencies must stay unmapped.
test('shared-currency and out-of-scope names still refuse to resolve', () => {
  assert.ok(!resolvePartner('Avios'), 'bare currency name is ambiguous across BA/QR/EI/IB');
  assert.ok(!resolvePartner('Marriott Bonvoy'), 'hotels are reference data, never routes');
  assert.ok(!resolvePartner('IHG'), 'hotels are reference data, never routes');
  assert.ok(!resolveBank('Rove'), 'untracked transferable currency');
  assert.ok(!resolveBank('PAYBACK'), 'untracked transferable currency');
});

test('the four new airlines resolve from the names real sources use', () => {
  assert.equal(resolvePartner('United MileagePlus'), 'UA');
  assert.equal(resolvePartner('JetBlue TrueBlue'), 'B6');
  assert.equal(resolvePartner('JetBlue'), 'B6');
  assert.equal(resolvePartner('Etihad Guest'), 'EY');
  assert.equal(resolvePartner('Iberia Avios'), 'IB');
  assert.equal(resolvePartner('Iberia Plus'), 'IB');
});

test('display names exist for the new codes', () => {
  for (const c of ['UA', 'B6', 'EY', 'IB']) {
    assert.notEqual(partnerDisplayName(c), c, c + ' must have a hand-written display name');
  }
});
