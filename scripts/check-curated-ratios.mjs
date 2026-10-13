#!/usr/bin/env node
// Operational review deadline, separate from deterministic code/schema tests.
// A late review must alert the operator without blocking verified BR updates.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTOMATED_BANKS = new Set(['AMEX', 'CHASE', 'CITI', 'C1', 'BILT', 'WF', 'USB', 'ROVE', 'ESF', 'LIV']);
export const RATIO_REVIEW_DAYS = 35;

export function checkCuratedRatios(doc, now = new Date()) {
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return Object.entries(doc.directory).filter(([bank, row]) => !AUTOMATED_BANKS.has(bank)
    && [...row.air ?? [], ...row.hotel ?? []].length).map(([bank]) => {
    const evidence = doc.ratioProvenance?.[bank];
    const date = Date.parse(evidence?.asOf);
    const ageDays = Number.isFinite(date) ? Math.floor((today - date) / 86400000) : null;
    let status = 'fresh';
    if (!evidence) status = 'missing';
    else if (ageDays === null || ageDays < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.asOf)
      || new Date(date).toISOString().slice(0, 10) !== evidence.asOf || !/^https:\/\//.test(evidence.source ?? '')) status = 'invalid';
    else if (ageDays > RATIO_REVIEW_DAYS) status = 'stale';
    return { bank, status, ageDays, asOf: evidence?.asOf ?? null, source: evidence?.source ?? null };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const doc = JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url), 'utf8'));
  const checks = checkCuratedRatios(doc);
  for (const check of checks) {
    console.log(`[curated-ratios] ${check.bank}: ${check.status}; checked ${check.asOf ?? 'never'}; age ${check.ageDays ?? 'unknown'} days; ${check.source ?? 'no source'}`);
  }
  if (checks.some((check) => check.status !== 'fresh')) {
    console.log('RATIO_REVIEW_REQUIRED: verify current official sources before changing asOf. Automated updates remain independent.');
    process.exitCode = 1;
  }
}
