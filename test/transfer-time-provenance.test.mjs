import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePartners } from '../scripts/validate-feed.mjs';

const sample = JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url)));
const withEvidence = () => ({ ...structuredClone(sample), transferTimeMeta: {
  AMEX: { AV: { source: 'https://frequentmiler.com/transfer-partner-master-list/', asOf: '2026-10-13', estimate: true } },
} });

test('transfer time provenance is optional and accepts sourced estimates', () => {
  assert.doesNotThrow(() => validatePartners(sample));
  assert.doesNotThrow(() => validatePartners(withEvidence()));
});

test('transfer time provenance rejects orphan entries, invalid dates and unsafe sources', () => {
  for (const change of [
    p => { p.transferTimeMeta.UNKNOWN = p.transferTimeMeta.AMEX; },
    p => { delete p.transferTimes.AMEX.AV; },
    p => { p.transferTimeMeta.AMEX.AV.asOf = '2026-02-30'; },
    p => { p.transferTimeMeta.AMEX.AV.source = 'javascript:alert(1)'; },
    p => { p.transferTimeMeta.AMEX.AV.source = 'https://'; },
    p => { p.transferTimeMeta.AMEX.AV.estimate = 'yes'; },
  ]) {
    const p = withEvidence();
    change(p);
    assert.throws(() => validatePartners(p));
  }
});
