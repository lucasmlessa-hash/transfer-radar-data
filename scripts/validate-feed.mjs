#!/usr/bin/env node
// ponytail: hand-rolled checks for exactly the constraints in CONTRACT.md /
// schema/*.json, not a generic JSON-Schema engine — add ajv if the schema
// grows past what a few functions can enforce.
'use strict';

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  // p2 is allowed-not-required: the merge-from-previous fallback re-publishes
  // routes from feeds that predate it, and a required key would turn a source
  // outage into a publish abort. New builds always emit it (see normalize.mjs).
  const allowed = [...required, 'p2', 'wait', 'active', 'upcoming', 'ended', 'next', 'summary'];
  checkKeys(r, required, allowed, ctx);

  for (const k of ['id', 'bank', 'airline', 'code', 'time', 'typical']) {
    if (typeof r[k] !== 'string') fail(`${ctx}.${k}: must be a string`);
  }

  if (!Array.isArray(r.mp) || r.mp.length !== 12) fail(`${ctx}.mp: must be an array of length 12`);
  r.mp.forEach((v, j) => {
    if (typeof v !== 'number' || v < 0 || v > 1) fail(`${ctx}.mp[${j}]: must be a number in 0..1`);
  });

  if ('p2' in r) {
    if (!Array.isArray(r.p2) || r.p2.length !== 12) fail(`${ctx}.p2: must be an array of length 12`);
    r.p2.forEach((v, j) => {
      if (typeof v !== 'number' || v < 0 || v > 1) fail(`${ctx}.p2[${j}]: must be a number in 0..1`);
    });
  }

  if ('wait' in r) {
    if (!Array.isArray(r.wait) || r.wait.length !== 3) fail(`${ctx}.wait: must be an array of length 3`);
    r.wait.forEach((v, j) => {
      if (typeof v !== 'number' || v < 0 || v > 1) fail(`${ctx}.wait[${j}]: must be a number in 0..1`);
    });
    // A curve that goes down says "a bonus within 6 months is less likely than
    // within 3", which is impossible. Cheap to check, and it caught a real
    // defect during development.
    if (r.wait[0] > r.wait[1] + 1e-9 || r.wait[1] > r.wait[2] + 1e-9) {
      fail(`${ctx}.wait: cumulative curve must not decrease (${r.wait.join(' / ')})`);
    }
  }

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
    checkKeys(r.active, ['pct', 'endDate'], ['pct', 'startDate', 'endDate'], actx);
    if (typeof r.active.pct !== 'number') fail(`${actx}.pct: must be a number`);
    if (typeof r.active.endDate !== 'string' || !ISO_DATE.test(r.active.endDate)) {
      fail(`${actx}.endDate: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.active.endDate)}`);
    }
    if ('startDate' in r.active) {
      if (typeof r.active.startDate !== 'string' || !ISO_DATE.test(r.active.startDate)) {
        fail(`${actx}.startDate: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.active.startDate)}`);
      }
      if (r.active.endDate < r.active.startDate) fail(`${actx}: ends before it starts`);
    }
  }

  if ('upcoming' in r) {
    const uctx = `${ctx}.upcoming`;
    if (!isPlainObject(r.upcoming)) fail(`${uctx}: must be an object`);
    checkKeys(r.upcoming, ['pct', 'startDate', 'endDate'], ['pct', 'startDate', 'endDate'], uctx);
    if (typeof r.upcoming.pct !== 'number') fail(`${uctx}.pct: must be a number`);
    for (const k of ['startDate', 'endDate']) {
      if (typeof r.upcoming[k] !== 'string' || !ISO_DATE.test(r.upcoming[k])) {
        fail(`${uctx}.${k}: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.upcoming[k])}`);
      }
    }
    if (r.upcoming.endDate < r.upcoming.startDate) fail(`${uctx}: ends before it starts`);
    // Announced-but-not-live is mutually exclusive with live: the whole point
    // of the field is that these two must never be confused.
    if ('active' in r) fail(`${ctx}: carries both "active" and "upcoming"`);
  }

  if ('ended' in r) {
    const ectx = `${ctx}.ended`;
    if (!isPlainObject(r.ended)) fail(`${ectx}: must be an object`);
    checkKeys(r.ended, ['pct', 'endedAt'], ['pct', 'endedAt'], ectx);
    if (typeof r.ended.pct !== 'number') fail(`${ectx}.pct: must be a number`);
    if (typeof r.ended.endedAt !== 'string' || !ISO_DATE.test(r.ended.endedAt)) {
      fail(`${ectx}.endedAt: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.ended.endedAt)}`);
    }
    // CONTRACT.md: a route carries one or the other. Both would put the same
    // route in ACTIVE NOW and RECENTLY ENDED at once.
    if ('active' in r) fail(`${ctx}: carries both "active" and "ended"`);
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

export function validateFeed(doc) {
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

export function validatePartners(doc) {
  if (!isPlainObject(doc)) fail('partners: must be an object');
  const required = ['version', 'banks', 'airlineDomains', 'bankDomains', 'airlineValues', 'directory'];
  // Curated extras, all optional: per-airline logo overrides, per-bank transfer
  // speeds, and provenance for each airlineValues number.
  // ratioProvenance: quando e de onde uma razão de transferência SEM scraper foi
  // conferida à mão. Razões mudam (desvalorização é rotina), e uma errada
  // corrompe o ¢/pt e a ordenação BEST VALUE sem barulho — por isso a data é
  // obrigatória por banco e um teste falha quando ela envelhece.
  const optional = ['airlineIconUrls', 'transferTimes', 'airlineValueMeta', 'ratioProvenance'];
  checkKeys(doc, required, [...required, ...optional], 'partners');
  if (doc.version !== 1) fail(`partners.version: must be 1, got ${JSON.stringify(doc.version)}`);

  if ('ratioProvenance' in doc) {
    if (!isPlainObject(doc.ratioProvenance)) fail('partners.ratioProvenance: must be an object');
    for (const [bank, m] of Object.entries(doc.ratioProvenance)) {
      const ctx = `partners.ratioProvenance.${bank}`;
      if (!isPlainObject(m)) fail(`${ctx}: must be an object`);
      checkKeys(m, ['asOf', 'source'], ['asOf', 'source', 'note'], ctx);
      if (typeof m.asOf !== 'string' || !ISO_DATE.test(m.asOf)) fail(`${ctx}.asOf: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(m.asOf)}`);
      if (typeof m.source !== 'string' || !/^https:\/\//.test(m.source)) fail(`${ctx}.source: must be an https URL`);
    }
  }

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

  // A code typo in any of these three maps degrades silently (a wrong
  // transferTimes key just means the route shows "—" forever), so each key is
  // checked against the map it is supposed to shadow.
  if ('airlineIconUrls' in doc) {
    if (!isPlainObject(doc.airlineIconUrls)) fail('partners.airlineIconUrls: must be an object');
    for (const [k, v] of Object.entries(doc.airlineIconUrls)) {
      const ctx = `partners.airlineIconUrls.${k}`;
      if (!(k in doc.airlineDomains)) fail(`${ctx}: unknown airline code`);
      if (typeof v !== 'string' || !v.startsWith('https://')) fail(`${ctx}: must be an https:// URL, got ${JSON.stringify(v)}`);
    }
  }

  if ('transferTimes' in doc) {
    if (!isPlainObject(doc.transferTimes)) fail('partners.transferTimes: must be an object');
    for (const [bank, byCode] of Object.entries(doc.transferTimes)) {
      const ctx = `partners.transferTimes.${bank}`;
      if (!isPlainObject(byCode)) fail(`${ctx}: must be an object`);
      if (!(bank in doc.banks)) fail(`${ctx}: unknown bank code`);
      for (const [code, v] of Object.entries(byCode)) {
        if (!(code in doc.airlineDomains)) fail(`${ctx}.${code}: unknown airline code`);
        if (typeof v !== 'string' || v === '') fail(`${ctx}.${code}: must be a non-empty string`);
      }
    }
  }

  if ('airlineValueMeta' in doc) {
    if (!isPlainObject(doc.airlineValueMeta)) fail('partners.airlineValueMeta: must be an object');
    for (const [code, m] of Object.entries(doc.airlineValueMeta)) {
      const ctx = `partners.airlineValueMeta.${code}`;
      if (!isPlainObject(m)) fail(`${ctx}: must be an object`);
      checkKeys(m, ['currency', 'asOf', 'source'],
        ['currency', 'asOf', 'source', 'note', 'sourceValue', 'sourceCurrency', 'fxRate', 'estimate'], ctx);
      if (!(code in doc.airlineValues)) fail(`${ctx}: no matching airlineValues entry`);
      if (m.currency !== 'USD' && m.currency !== 'BRL') fail(`${ctx}.currency: must be "USD" or "BRL", got ${JSON.stringify(m.currency)}`);
      if (typeof m.asOf !== 'string' || !ISO_DATE.test(m.asOf)) fail(`${ctx}.asOf: must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(m.asOf)}`);
      for (const f of ['source', 'note']) {
        if (f in m && (typeof m[f] !== 'string' || m[f] === '')) fail(`${ctx}.${f}: must be a non-empty string`);
      }
      // A non-USD valuation must carry enough to re-derive it when FX moves, rather than
      // silently drifting: the native figure, its currency, and the rate used on asOf.
      for (const f of ['sourceValue', 'fxRate']) {
        if (f in m && (typeof m[f] !== 'number' || !(m[f] > 0))) fail(`${ctx}.${f}: must be a positive number`);
      }
      if ('sourceCurrency' in m && m.sourceCurrency !== 'USD' && m.sourceCurrency !== 'BRL') {
        fail(`${ctx}.sourceCurrency: must be "USD" or "BRL", got ${JSON.stringify(m.sourceCurrency)}`);
      }
      if ('estimate' in m && typeof m.estimate !== 'boolean') fail(`${ctx}.estimate: must be a boolean`);
      if (m.currency === 'BRL' && !('sourceValue' in m && 'fxRate' in m)) {
        fail(`${ctx}: a BRL-denominated value must record sourceValue and fxRate so it can be re-converted`);
      }
    }
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

// Only exit when run as a CLI: the tests import validateFeed to check the
// copy of the feed bundled into the extension, and a module-level exit would
// kill the test runner on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
