#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshPointValuations } from './refresh-point-valuations.mjs';
import { validatePartners } from './validate-feed.mjs';
import { ACCOR_VALUATION_SOURCE, isCurrentFixingDate } from '../src/sources/accor-point-valuation.mjs';

const DEFAULT_PARTNERS = fileURLToPath(new URL('../out/partners.json', import.meta.url));
const DEFAULT_FIXING = fileURLToPath(new URL('../data/accor-fixing.json', import.meta.url));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

// Only a recently verified official redemption and matching ECB conversion can
// seed a fresh runner. Source outages never renew the fixing's original date.
function isOfficialFixing(record, now) {
  const m = record?.meta;
  return m?.method === 'official-fx' && m.currency === 'EUR' && m.sourceCurrency === 'EUR' && m.sourceValue === 0.02 &&
    m.estimate === false && m.source === ACCOR_VALUATION_SOURCE.url && m.fxSource === ACCOR_VALUATION_SOURCE.fxSource &&
    isCurrentFixingDate(m.asOf, now) && Number.isFinite(m.fxRate) && m.fxRate > 0 &&
    record.value === Number((m.sourceValue * 100 * m.fxRate).toFixed(6)) && record.value > 0;
}

export async function refreshAccorFixing({
  partnersPath = DEFAULT_PARTNERS, fixingPath = DEFAULT_FIXING, now = new Date(), fetchImpl = fetch, sleepImpl, log = console.log,
} = {}) {
  const partners = read(partnersPath);
  validatePartners(partners);
  const current = { value: partners.airlineValues.ACCOR, meta: partners.airlineValueMeta?.ACCOR };
  let saved, seed;
  try {
    const candidate = read(fixingPath);
    if (!isOfficialFixing(candidate, now)) throw new Error('unexpected, expired or invalid fixing');
    const seeded = { ...partners, airlineValues: { ...partners.airlineValues, ACCOR: candidate.value },
      airlineValueMeta: { ...partners.airlineValueMeta, ACCOR: candidate.meta } };
    validatePartners(seeded);
    saved = candidate;
    if ((!isOfficialFixing(current, now) || candidate.meta.asOf >= current.meta.asOf) &&
      JSON.stringify(current) !== JSON.stringify(candidate)) seed = seeded;
  } catch (error) {
    if (error.code !== 'ENOENT') log(`::warning::ACCOR saved fixing ignored: ${error.message}`);
  }
  if (seed) write(partnersPath, seed);

  const report = await refreshPointValuations({ sources: [ACCOR_VALUATION_SOURCE], partnersPath, now, fetchImpl, sleepImpl, log });
  if (!report.ok) log('::warning::ACCOR verification unavailable. Only a recent official fixing is eligible.');
  const output = read(partnersPath);
  const result = { value: output.airlineValues.ACCOR, meta: output.airlineValueMeta?.ACCOR };
  if (isOfficialFixing(result, now) && JSON.stringify(result) !== JSON.stringify(saved)) write(fixingPath, result);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await refreshAccorFixing();
}
