#!/usr/bin/env node
// node scripts/refresh-hotel-ratios.mjs [--partners FILE] [--report FILE] [--dry-run]
// Independent verified corrections are saved even when another route remains
// pending. Exit 1 means a source failed or evidence changed. An unchanged,
// explicitly unknown baseline is reported without failing the scheduled job.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOTEL_RATIO_SOURCES } from '../src/sources/hotel-ratios.mjs';
import { validatePartners } from './validate-feed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTNERS = path.join(ROOT, 'sample/partners.json');
const UA = 'Mozilla/5.0 (compatible; TransferRadar/1.0; public transfer-rate verification)';

async function get(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) { last = error; }
  }
  throw last;
}

export async function refreshHotelRatios(doc, { getPage = get, now = new Date(), log = console.log } = {}) {
  const checkedAt = new Date(now).toISOString(), before = JSON.stringify(doc);
  const changes = [], verified = [], pending = [], failures = [], coverage = {};
  for (const source of HOTEL_RATIO_SOURCES) {
    const { bank, url, parse } = source;
    const entry = doc.directory?.[bank];
    if (!entry) continue;
    const routes = ['air', 'hotel'].flatMap((bucket) => (entry[bucket] ?? []).map((row) => ({ bucket, row })));
    let parsed;
    try { parsed = parse(await getPage(url)); }
    catch (error) {
      failures.push({ bank, source: url, error: error.message });
      for (const { bucket, row: [partner, retainedRatio] } of routes) {
        pending.push({ bank, bucket, partner, retainedRatio, source: url, knownUnknown: false, reason: `source unavailable: ${error.message}` });
      }
      coverage[bank] = { status: 'failed', total: routes.length, verified: 0, complete: false };
      log(`[hotel-ratios] ${bank}: 0/${routes.length} verified; source failed (${error.message}); existing data retained`);
      continue;
    }
    let count = 0;
    for (const { bucket, row } of routes) {
      const [partner, retainedRatio] = row;
      const ratio = bucket === 'air' ? parsed.rates.get(partner) : null;
      if (!ratio) {
        pending.push({ bank, bucket, partner, retainedRatio, source: url,
          knownUnknown: bucket === 'air' && retainedRatio === '—' && parsed.knownUnknown.has(partner),
          reason: parsed.pending.get(partner) ?? 'tracked route absent from verified source; review possible source change or departure' });
        continue;
      }
      count += 1;
      verified.push({ bank, bucket, partner, ratio, source: url, checkedAt });
      if (ratio !== retainedRatio) {
        row[1] = ratio;
        changes.push({ bank, bucket, partner, before: retainedRatio, after: ratio });
        log(`[hotel-ratios] ${bank}/${partner}: ${retainedRatio} -> ${ratio}`);
      }
    }
    const complete = routes.length > 0 && count === routes.length;
    coverage[bank] = { status: complete ? 'ok' : 'partial', total: routes.length, verified: count, complete };
    if (complete) {
      doc.ratioProvenance ??= {};
      doc.ratioProvenance[bank] = { asOf: checkedAt.slice(0, 10), source: url,
        note: `${count}/${routes.length} registered transfer base ratios verified automatically in the official source. Threshold and promotional bonuses are excluded; this check does not certify untracked partners.` };
    }
    log(`[hotel-ratios] ${bank}: ${count}/${routes.length} verified; ${complete ? 'complete for registered routes' : 'partial; programme provenance date retained'}`);
  }
  for (const item of pending) log(`[hotel-ratios] PENDING ${item.bank}/${item.partner}: ${item.reason}; retained ${item.retainedRatio}`);
  return { ok: !pending.some((item) => !item.knownUnknown) && !failures.length, checkedAt, changed: JSON.stringify(doc) !== before,
    changes, verified, pending, failures, coverage };
}

function writeJson(file, doc) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(doc, null, 2) + '\n');
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export async function runHotelRatios({ partnersPath = PARTNERS, reportPath, dryRun = false, ...options } = {}) {
  const resolved = (file) => existsSync(file) ? realpathSync(file) : path.resolve(file);
  if (reportPath && resolved(reportPath) === resolved(partnersPath)) throw new Error('Report path must differ from partners input');
  const doc = JSON.parse(readFileSync(partnersPath, 'utf8'));
  const result = await refreshHotelRatios(doc, options);
  validatePartners(doc);
  const written = !dryRun && result.changed;
  if (written) writeJson(partnersPath, doc);
  const report = { ...result, dryRun, written };
  if (reportPath) writeJson(reportPath, report);
  return report;
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
    const result = await runHotelRatios(cliOptions(process.argv.slice(2)));
    console.log(`[hotel-ratios] ${result.dryRun ? 'dry-run; partners unchanged' : result.written ? 'verified updates written' : 'no changes'}`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`[hotel-ratios] ${error.message}`);
    process.exitCode = 1;
  }
}
