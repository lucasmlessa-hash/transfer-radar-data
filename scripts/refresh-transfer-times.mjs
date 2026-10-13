#!/usr/bin/env node
// node scripts/refresh-transfer-times.mjs [--partners FILE] [--report FILE] [--dry-run]
// Refreshes estimates only where FM publishes an explicit per-route time.
// A retained value keeps its old date; the report exposes that missing evidence.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFmTransferTimes, TRANSFER_TIME_SOURCE } from '../src/sources/transfer-times.mjs';
import { validatePartners } from './validate-feed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTNERS = path.join(ROOT, 'sample/partners.json');
const routeEntries = (times) => Object.entries(times ?? {}).flatMap(([bank, byCode]) =>
  Object.entries(byCode).map(([code, time]) => ({ bank, code, time })));

export async function refreshTransferTimes(input, { fetchImpl = fetch, now = new Date() } = {}) {
  validatePartners(input);
  const doc = structuredClone(input), checkedAt = new Date(now).toISOString();
  const asOf = checkedAt.slice(0, 10), before = JSON.stringify(doc);
  const known = routeEntries(doc.transferTimes), changes = [], verified = [], missingKnown = [];
  const source = { id: TRANSFER_TIME_SOURCE.id, url: TRANSFER_TIME_SOURCE.url, status: 'ok' };
  let parsed = { times: {}, unparsed: [], conflicts: [], tableCount: 0, observedRoutes: 0 };
  try {
    const response = await fetchImpl(source.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; TransferRadar/1.0; public transfer-time verification)' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    parsed = parseFmTransferTimes(await response.text());
    if (!routeEntries(parsed.times).length) throw new Error('No explicit route times parsed; source may have changed');
  } catch (error) {
    source.status = 'failed';
    source.error = error.message;
    parsed.times = {};
  }

  for (const { bank, code, time } of routeEntries(parsed.times)) {
    // A newly recognized source name must first belong to the product contract.
    if (!doc.banks[bank] || !doc.airlineDomains[code]) continue;
    const previous = doc.transferTimes?.[bank]?.[code];
    doc.transferTimes ??= {};
    (doc.transferTimes[bank] ??= {})[code] = time;
    doc.transferTimeMeta ??= {};
    (doc.transferTimeMeta[bank] ??= {})[code] = { source: source.url, asOf, estimate: true };
    verified.push({ bank, code, time });
    if (previous !== time) changes.push({ bank, code, before: previous ?? null, after: time });
  }

  const verifiedIds = new Set(verified.map(({ bank, code }) => `${bank}/${code}`));
  const unparsedById = new Map(parsed.unparsed.map((r) => [`${r.bank}/${r.code}`, r]));
  const conflicts = new Set(parsed.conflicts.map(({ bank, code }) => `${bank}/${code}`));
  for (const { bank, code, time } of known) {
    const id = `${bank}/${code}`;
    if (verifiedIds.has(id)) continue;
    const reason = !TRANSFER_TIME_SOURCE.banks.includes(bank) ? 'source-not-covered'
      : source.status === 'failed' ? 'source-failed'
      : conflicts.has(id) ? 'conflicting-observations'
      : unparsedById.get(id)?.reason ?? 'not-observed';
    missingKnown.push({ bank, code, retainedTime: time, reason,
      retainedAsOf: doc.transferTimeMeta?.[bank]?.[code]?.asOf ?? null });
  }

  const byBank = {};
  for (const bank of new Set([...known, ...verified].map((r) => r.bank))) {
    const knownBefore = known.filter((r) => r.bank === bank).length;
    const retainedKnown = missingKnown.filter((r) => r.bank === bank).length;
    byBank[bank] = {
      knownBefore, verifiedKnown: knownBefore - retainedKnown, retainedKnown,
      verifiedTotal: verified.filter((r) => r.bank === bank).length,
      status: !TRANSFER_TIME_SOURCE.banks.includes(bank) ? 'uncovered'
        : source.status === 'failed' ? 'failed' : retainedKnown ? 'partial' : 'ok',
    };
  }
  const needsReview = missingKnown.some(({ reason }) => reason !== 'source-not-covered') || parsed.conflicts.length > 0;
  if (source.status !== 'failed' && needsReview) source.status = 'partial';
  Object.assign(source, { tableCount: parsed.tableCount, observedRoutes: parsed.observedRoutes, verifiedRoutes: verified.length });
  validatePartners(doc);
  return { doc, report: {
    ok: source.status === 'ok', changed: JSON.stringify(doc) !== before, checkedAt,
    sources: [source], changes, verified, missingKnown,
    unparsed: parsed.unparsed, conflicts: parsed.conflicts,
    coverage: {
      knownBefore: known.length, verifiedKnown: known.length - missingKnown.length,
      retainedKnown: missingKnown.length, verifiedTotal: verified.length,
      storedTotal: routeEntries(doc.transferTimes).length, byBank,
    },
  } };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export async function runTransferTimes({ partnersPath = PARTNERS, reportPath, dryRun = false, ...options } = {}) {
  const resolved = (file) => existsSync(file) ? realpathSync(file) : path.resolve(file);
  if (reportPath) {
    const samePath = resolved(reportPath) === resolved(partnersPath);
    const a = existsSync(partnersPath) && statSync(partnersPath), b = existsSync(reportPath) && statSync(reportPath);
    if (samePath || (a && b && a.dev === b.dev && a.ino === b.ino)) throw new Error('Report path must differ from partners input');
  }
  const input = JSON.parse(readFileSync(partnersPath, 'utf8'));
  const { doc, report } = await refreshTransferTimes(input, options);
  const written = !dryRun && report.changed;
  if (written) writeJson(partnersPath, doc);
  const result = { ...report, dryRun, written };
  if (reportPath) writeJson(reportPath, result);
  return result;
}

function cliOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run' || args[i] === '--dry') options.dryRun = true;
    else if (['--partners', '--report'].includes(args[i])) {
      const flag = args[i], value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a file path`);
      options[flag === '--partners' ? 'partnersPath' : 'reportPath'] = path.resolve(value);
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runTransferTimes(cliOptions(process.argv.slice(2)));
    console.log(`[transfer-times] ${result.coverage.verifiedTotal} route estimates verified; ${result.coverage.retainedKnown} previous values retained without fresh evidence`);
    for (const source of result.sources) if (source.error) console.error(`[transfer-times] ${source.id}: ${source.error}`);
    console.log(`[transfer-times] ${result.dryRun ? 'dry-run; partners unchanged' : result.written ? 'verified updates written' : 'no changes'}`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`[transfer-times] ${error.message}`);
    process.exitCode = 1;
  }
}
