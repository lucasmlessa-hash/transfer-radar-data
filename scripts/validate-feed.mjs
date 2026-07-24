#!/usr/bin/env node
// ponytail: hand-rolled checks for exactly the constraints in CONTRACT.md /
// schema/*.json, not a generic JSON-Schema engine — add ajv if the schema
// grows past what a few functions can enforce.
'use strict';

import { readFileSync } from 'node:fs';

const USAGE = 'Usage: node validate-feed.mjs <file> [--schema feed|partners]';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fail(msg) {
  const err = new Error(msg);
  err.isValidationError = true;
  throw err;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkKeys(obj, required, allowed, ctx) {
  for (const k of required) {
    if (!(k in obj)) fail(`${ctx}: missing required key "${k}"`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${ctx}: unknown key "${k}"`);
  }
}

function validateRoute(r, i) {
  const ctx = `routes[${i}]`;
  if (!isPlainObject(r)) fail(`${ctx}: must be an object`);
  const required = ['id', 'bank', 'airline', 'code', 'time', 'typical', 'mp', 'hist'];
  const allowed = [...required, 'active', 'ended', 'next', 'summary'];
  checkKeys(r, required, allowed, ctx);

  for (const k of ['id', 'bank', 'airline', 'code', 'time', 'typical']) {
    if (typeof r[k] !== 'string') fail(`${ctx}.${k}: must be a string`);
  }

  if (!Array.isArray(r.mp) || r.mp.length !== 12) fail(`${ctx}.mp: must be an array of length 12`);
  r.mp.forEach((v, j) => {
    if (typeof v !== 'number' || v < 0 || v > 1) fail(`${ctx}.mp[${j}]: must be a number in 0..1`);
  });

  if (!Array.isArray(r.hist)) fail(`${ctx}.hist: must be an array`);
  r.hist.forEach((h, j) => {
    const hctx = `${ctx}.hist[${j}]`;
    if (!isPlainObject(h)) fail(`${hctx}: must be an object`);
    checkKeys(h, ['w', 'pct', 'len'], ['w', 'pct', 'len'], hctx);
    if (typeof h.w !== 'string') fail(`${hctx}.w: must be a string`);
    if (typeof h.pct !== 'number') fail(`${hctx}.pct: must be a number`);
    if (typeof h.len !== 'string') fail(`${hctx}.len: must be a string`);
  });

  if ('active' in r) {
    const actx = `${ctx}.active`;
    if (!isPlainObject(r.active)) fail(`${actx}: must be an object`);
    checkKeys(r.active, ['pct', 'endDate'], ['pct', 'endDate'], actx);
    if (typeof r.active.pct !== 'number') fail(`${actx}.pct: must be a number`);
    if (typeof r.active.endDate !== 'string' || !ISO_DATE.test(r.active.endDate)) {
      fail(`${actx}.endDate: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.active.endDate)}`);
    }
  }

  if ('ended' in r) {
    const ectx = `${ctx}.ended`;
    if (!isPlainObject(r.ended)) fail(`${ectx}: must be an object`);
    checkKeys(r.ended, ['pct', 'endedAt'], ['pct', 'endedAt'], ectx);
    if (typeof r.ended.pct !== 'number') fail(`${ectx}.pct: must be a number`);
    if (typeof r.ended.endedAt !== 'string' || !ISO_DATE.test(r.ended.endedAt)) {
      fail(`${ectx}.endedAt: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.ended.endedAt)}`);
    }
  }

  if ('next' in r) {
    const nctx = `${ctx}.next`;
    if (!isPlainObject(r.next)) fail(`${nctx}: must be an object`);
    checkKeys(r.next, ['label', 'prob'], ['label', 'prob'], nctx);
    if (typeof r.next.label !== 'string') fail(`${nctx}.label: must be a string`);
    if (!Number.isInteger(r.next.prob) || r.next.prob < 0 || r.next.prob > 100) {
      fail(`${nctx}.prob: must be an integer in 0..100`);
    }
  }

  if ('summary' in r && typeof r.summary !== 'string') fail(`${ctx}.summary: must be a string`);
}

function validateFeed(doc) {
  if (!isPlainObject(doc)) fail('feed: must be an object');
  checkKeys(doc, ['version', 'generatedAt', 'routes'], ['version', 'generatedAt', 'routes'], 'feed');
  if (doc.version !== 1) fail(`feed.version: must be 1, got ${JSON.stringify(doc.version)}`);
  if (typeof doc.generatedAt !== 'string' || !ISO_DATETIME.test(doc.generatedAt)) {
    fail(`feed.generatedAt: must be an ISO-8601 UTC date-time, got ${JSON.stringify(doc.generatedAt)}`);
  }
  if (!Array.isArray(doc.routes)) fail('feed.routes: must be an array');
  doc.routes.forEach(validateRoute);
}

function validatePartnerTuple(t, ctx) {
  if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== 'string' || typeof t[1] !== 'string') {
    fail(`${ctx}: must be a [string, string] tuple`);
  }
}

function validatePartners(doc) {
  if (!isPlainObject(doc)) fail('partners: must be an object');
  const required = ['version', 'banks', 'airlineDomains', 'bankDomains', 'airlineValues', 'directory'];
  checkKeys(doc, required, required, 'partners');
  if (doc.version !== 1) fail(`partners.version: must be 1, got ${JSON.stringify(doc.version)}`);

  if (!isPlainObject(doc.banks)) fail('partners.banks: must be an object');
  for (const [k, v] of Object.entries(doc.banks)) {
    const ctx = `partners.banks.${k}`;
    if (!isPlainObject(v)) fail(`${ctx}: must be an object`);
    checkKeys(v, ['name', 'short', 'bg', 'fg'], ['name', 'short', 'bg', 'fg'], ctx);
    for (const f of ['name', 'short', 'bg', 'fg']) {
      if (typeof v[f] !== 'string') fail(`${ctx}.${f}: must be a string`);
    }
  }

  for (const mapKey of ['airlineDomains', 'bankDomains']) {
    if (!isPlainObject(doc[mapKey])) fail(`partners.${mapKey}: must be an object`);
    for (const [k, v] of Object.entries(doc[mapKey])) {
      if (typeof v !== 'string') fail(`partners.${mapKey}.${k}: must be a string`);
    }
  }

  if (!isPlainObject(doc.airlineValues)) fail('partners.airlineValues: must be an object');
  for (const [k, v] of Object.entries(doc.airlineValues)) {
    if (typeof v !== 'number') fail(`partners.airlineValues.${k}: must be a number`);
  }

  if (!isPlainObject(doc.directory)) fail('partners.directory: must be an object');
  for (const [bank, entry] of Object.entries(doc.directory)) {
    const ctx = `partners.directory.${bank}`;
    if (!isPlainObject(entry)) fail(`${ctx}: must be an object`);
    checkKeys(entry, ['air', 'hotel'], ['air', 'hotel'], ctx);
    for (const g of ['air', 'hotel']) {
      if (!Array.isArray(entry[g])) fail(`${ctx}.${g}: must be an array`);
      entry[g].forEach((t, j) => validatePartnerTuple(t, `${ctx}.${g}[${j}]`));
    }
  }
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const file = argv[0];
  let schema = 'feed';
  const schemaFlagIdx = argv.indexOf('--schema');
  if (schemaFlagIdx !== -1) {
    schema = argv[schemaFlagIdx + 1];
    if (schema !== 'feed' && schema !== 'partners') {
      console.error(`INVALID: --schema must be "feed" or "partners", got ${JSON.stringify(schema)}`);
      return 1;
    }
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`INVALID: ${file} — could not read file: ${e.message}`);
    return 1;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    console.error(`INVALID: ${file} — not valid JSON: ${e.message}`);
    return 1;
  }

  try {
    if (schema === 'partners') validatePartners(doc);
    else validateFeed(doc);
  } catch (e) {
    if (e.isValidationError) {
      console.error(`INVALID: ${file} — ${e.message}`);
      return 1;
    }
    throw e;
  }

  console.log(`VALID: ${file}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
