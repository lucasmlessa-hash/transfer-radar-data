#!/usr/bin/env node
// Run only after a successful deploy, using that build's saved feed artifact.
// A live feed may instead be checked by the next build with its observation time.
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { confirmForecastPublication, serializeForecastRecords } from '../src/forecast-records.mjs';

const usage = 'Usage: node scripts/confirm-forecast-publication.mjs --ledger <records.json> --feed <expected-feed.json> [--published-at <ISO timestamp>]';

function readJson(bytes, name) {
  try { return JSON.parse(bytes); }
  catch (error) { throw new Error(`invalid ${name}: ${error.message}`); }
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--ledger', '--feed', '--published-at'].includes(args[i]) || !args[i + 1]
      || args[i + 1].startsWith('--') || options[args[i]] !== undefined) throw new Error(usage);
    options[args[i]] = args[i + 1];
  }
  if (!options['--ledger'] || !options['--feed']) throw new Error(usage);
  if ([options['--ledger'], options['--feed']].some(value => /^[a-z][a-z\d+.-]*:\/\//i.test(value))) {
    throw new Error('Publication confirmation accepts local files only');
  }
  const ledgerPath = path.resolve(options['--ledger']);
  const feedPath = path.resolve(options['--feed']);
  if (ledgerPath === feedPath) throw new Error('Ledger and expected feed must be different files');
  const originalBytes = readFileSync(ledgerPath, 'utf8');
  const original = readJson(originalBytes, 'forecast ledger');
  const feed = readJson(readFileSync(feedPath, 'utf8'), 'published feed');
  const updated = confirmForecastPublication(original, feed, options['--published-at'] ?? new Date().toISOString());
  const newlyConfirmed = updated.records.filter((record, index) => record.publicationStatus === 'confirmed'
    && original.records[index].publicationStatus !== 'confirmed').length;
  if (newlyConfirmed) {
    // Write and flush beside the ledger, then rename on the same filesystem.
    // A bad input or failed write leaves the existing ledger intact.
    const temporary = path.join(path.dirname(ledgerPath), `.${path.basename(ledgerPath)}.publication-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, serializeForecastRecords(updated));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      if (readFileSync(ledgerPath, 'utf8') !== originalBytes) throw new Error('Forecast ledger changed during confirmation; refusing to overwrite it');
      renameSync(temporary, ledgerPath);
    } finally { rmSync(temporary, { force: true }); }
  }
  console.log(JSON.stringify({ confirmed: newlyConfirmed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
