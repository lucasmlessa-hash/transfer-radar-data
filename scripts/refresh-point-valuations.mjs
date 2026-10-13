#!/usr/bin/env node
// Refresh the project's 24 traceable editorial estimates. Other valuations
// retain their value and review date; a successful fetch is not a review unless
// the matching numeric table cell was actually extracted.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALUATION_SOURCES, parsePointValuations } from '../src/sources/point-valuations.mjs';
import { validatePartners } from './validate-feed.mjs';

const DEFAULT_PARTNERS = fileURLToPath(new URL('../sample/partners.json', import.meta.url));
const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

function captureHtml(diagnosticsDir, sourceId, attempt, html) {
  if (!diagnosticsDir || typeof html !== 'string') return undefined;
  try {
    mkdirSync(diagnosticsDir, { recursive: true });
    const body = Buffer.from(html, 'utf8'), captured = body.subarray(0, MAX_DIAGNOSTIC_BYTES);
    const file = `${sourceId}-attempt${attempt}.html`;
    writeFileSync(path.join(diagnosticsDir, file), captured);
    return { file, bytes: captured.length, truncated: body.length > captured.length };
  } catch (error) { return { error: error.message }; }
}

export async function refreshPointValuations({
  partnersPath = DEFAULT_PARTNERS, reportPath = null, dryRun = false, diagnosticsDir = null,
  fetchImpl = fetch, now = new Date(), log = console.log,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const doc = JSON.parse(readFileSync(partnersPath, 'utf8'));
  validatePartners(doc);
  const before = JSON.stringify(doc);
  const checkedAt = now.toISOString(), asOf = checkedAt.slice(0, 10);
  const report = { ok: true, checkedAt, verified: 0, changed: false, written: false, sources: {}, changes: [], failures: [] };
  const collected = await Promise.all(VALUATION_SOURCES.map(async source => {
    const attempts = [];
    let selected;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let html, parsed, error, diagnostics;
      try {
        const response = await fetchImpl(source.url, {
          headers: { 'User-Agent': 'TransferRadar/1.0 (public editorial valuation check)' },
          signal: AbortSignal.timeout(25000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        html = await response.text();
        parsed = parsePointValuations(html, source.id);
      } catch (failure) { error = failure.message; diagnostics = failure.diagnostics; }
      const verifiedCodes = Object.keys(parsed?.values ?? {}), missingCodes = parsed?.missingCodes ?? source.codes;
      const status = error ? 'failed' : missingCodes.length ? 'degraded' : 'ok';
      const evidence = parsed?.diagnostics ?? diagnostics;
      const attemptReport = { attempt, status, verifiedCodes, missingCodes,
        ...(error ? { error } : {}), ...(evidence ? { diagnostics: evidence } : {}) };
      if (status !== 'ok') {
        // Capture each failed public response before retrying, even if a later
        // response succeeds. Raw HTML stays outside reports and partner data.
        const htmlCapture = captureHtml(diagnosticsDir, source.id, attempt, html);
        if (htmlCapture) attemptReport.htmlCapture = htmlCapture;
        log(`[valuations] ${source.id} attempt ${attempt}/3: ${verifiedCodes.length}/${source.codes.length} verified (${status})${error ? ': ' + error : ''}`);
        if (status === 'degraded' && evidence) log(`[valuations] ${source.id} diagnostics: ${JSON.stringify(evidence)}`);
      }
      attempts.push(attemptReport);
      // Pick exactly one response. A later network error does not erase the
      // last parsed partial, and partial responses are never merged together.
      if (parsed || !selected?.parsed) selected = { source, parsed, error, diagnostics, selectedAttempt: attempt };
      if (status === 'ok') break;
      if (attempt < 3) await sleepImpl(1000);
    }
    return { ...selected, attempts };
  }));
  for (const { source, parsed, error, diagnostics, selectedAttempt, attempts } of collected) {
    const values = parsed?.values ?? {};
    const missingCodes = parsed?.missingCodes ?? source.codes;
    const status = error ? 'failed' : missingCodes.length ? 'degraded' : 'ok';
    const evidence = parsed?.diagnostics ?? diagnostics;
    report.sources[source.id] = { status, checkedAt, source: source.url, selectedAttempt, attempts,
      verifiedCodes: Object.keys(values), missingCodes, ...(error ? { error } : {}),
      ...(status !== 'ok' && evidence ? { diagnostics: evidence } : {}) };
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
    else if (arg === '--partners' || arg === '--report' || arg === '--diagnostics-dir') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing path after ${arg}`);
      const key = { '--partners': 'partnersPath', '--report': 'reportPath', '--diagnostics-dir': 'diagnosticsDir' }[arg];
      options[key] = path.resolve(value);
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
