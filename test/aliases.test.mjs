import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePartner, resolveBank, partnerDisplayName, PARTNER_ALIASES } from '../src/aliases.mjs';

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

// Documents the exact spellings observed in real sources (Frequent Miler's
// archive, AwardWallet) — why these particular variants exist, not just that
// coverage is complete (the loop below owns completeness).
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

// Complete by construction: every variant we hand-type for these codes is
// exercised, so adding one later cannot silently go unverified.
test('every new-airline alias variant resolves to its code', () => {
  for (const code of ['UA', 'B6', 'EY', 'IB']) {
    for (const variant of PARTNER_ALIASES[code]) {
      assert.equal(resolvePartner(variant), code, `${code}: "${variant}" must resolve`);
    }
  }
});
