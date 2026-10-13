#!/usr/bin/env node
// Refresh the project's 24 traceable editorial estimates. Other valuations
// retain their value and review date; a successful fetch is not a review unless
// the matching numeric table cell was actually extracted.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALUATION_SOURCES, parsePointValuations } from '../src/sources/point-valuations.mjs';
import { validatePartners } from './validate-feed.mjs';

const DEFAULT_PARTNERS = fileURLToPath(new URL('../sample/partners.json', import.meta.url));

export async function refreshPointValuations({
  partnersPath = DEFAULT_PARTNERS, reportPath = null, dryRun = false,
  fetchImpl = fetch, now = new Date(), log = console.log,
} = {}) {
  const doc = JSON.parse(readFileSync(partnersPath, 'utf8'));
  validatePartners(doc);
  const before = JSON.stringify(doc);
  const checkedAt = now.toISOString(), asOf = checkedAt.slice(0, 10);
  const report = { ok: true, checkedAt, verified: 0, changed: false, written: false, sources: {}, changes: [], failures: [] };
  const collected = await Promise.all(VALUATION_SOURCES.map(async source => {
    try {
      const response = await fetchImpl(source.url, {
        headers: { 'User-Agent': 'TransferRadar/1.0 (public editorial valuation check)' },
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { source, parsed: parsePointValuations(await response.text(), source.id) };
    } catch (error) { return { source, error: error.message }; }
  }));
  for (const { source, parsed, error } of collected) {
    const values = parsed?.values ?? {};
    const missingCodes = parsed?.missingCodes ?? source.codes;
    const status = error ? 'failed' : missingCodes.length ? 'degraded' : 'ok';
    report.sources[source.id] = { status, checkedAt, source: source.url,
      verifiedCodes: Object.keys(values), missingCodes, ...(error ? { error } : {}) };
    if (status !== 'ok') {
      report.ok = false;
      report.failures.push({ source: source.id, error: error ?? 'Missing or unreadable valuation cells', missingCodes });
    }
    for (const [code, value] of Object.entries(values)) {
      const previous = doc.airlineValues[code];
      if (previous !== value) report.changes.push({ code, before: previous ?? null, after: value, source: source.id });
      doc.airlineValues[code] = value;
      doc.airlineValueMeta ??= {};
      doc.airlineValueMeta[code] = {
        currency: 'USD', asOf, source: source.url, estimate: true,
        note: `Editorial redemption estimate from ${source.name}, in US cents per mile; asOf records source verification.`
          + (source.id === 'tpg' && ['QR', 'EI', 'IB'].includes(code) ? ' Uses the publisher\'s shared Avios estimate; British Airways retains its separate Frequent Miler estimate.' : ''),
      };
      report.verified += 1;
    }
    log(`[valuations] ${source.id}: ${Object.keys(values).length}/${source.codes.length} verified (${status})`);
  }
  validatePartners(doc);
  report.changed = JSON.stringify(doc) !== before;
  if (!dryRun && report.changed) {
    writeFileSync(partnersPath, JSON.stringify(doc, null, 2) + '\n');
    report.written = true;
  }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function cliOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--partners' || arg === '--report') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing path after ${arg}`);
      options[arg === '--partners' ? 'partnersPath' : 'reportPath'] = path.resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await refreshPointValuations(cliOptions(process.argv.slice(2)));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error('[valuations] ' + error.message);
    process.exitCode = 1;
  }
}

