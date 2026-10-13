import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseMarriottRatios, parseChoiceRatios, parseWyndhamRatios, HOTEL_RATIO_SOURCES } from '../src/sources/hotel-ratios.mjs';
import { refreshHotelRatios, runHotelRatios } from '../scripts/refresh-hotel-ratios.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/hotel-${name}`, import.meta.url), 'utf8');
const bodies = { MAR: fixture('marriott.html'), CHO: fixture('choice.html'), WYN: fixture('wyndham.json') };
const now = new Date('2026-10-14T12:00:00Z');
const quiet = () => {};
const getPage = async (url) => bodies[HOTEL_RATIO_SOURCES.find((s) => s.url === url).bank];
const sample = () => JSON.parse(readFileSync(new URL('../fixtures/partners-audit-2026-10.json', import.meta.url), 'utf8'));
const tracked = () => ({ directory: {
  MAR: { air: [['Air Canada Aeroplan', '4:1'], ['United MileagePlus', '3:1']], hotel: [] },
  CHO: { air: [['Air France / KLM Flying Blue', '6:1'], ['United MileagePlus', '5:1']], hotel: [] },
  WYN: { air: [['Singapore KrisFlyer', '6:1'], ['United MileagePlus', '—']], hotel: [] },
}, ratioProvenance: Object.fromEntries(['MAR', 'CHO', 'WYN'].map((bank) => [bank, {
  asOf: '2026-09-01', source: HOTEL_RATIO_SOURCES.find((s) => s.bank === bank).url, note: 'Earlier verification',
}])) });

test('Marriott reads explicit base ratios and canonicalizes current programme labels', () => {
  const out = parseMarriottRatios(bodies.MAR);
  for (const name of ['Air Canada Aeroplan', 'United MileagePlus', 'American Airlines AAdvantage',
    'Cathay Pacific Asia Miles', 'Etihad Guest', 'British Airways Avios', 'Avianca LifeMiles', 'Virgin Atlantic Flying Club']) {
    assert.equal(out.rates.get(name), '3:1', name);
  }
  assert.equal(out.rates.get('Air New Zealand AirPoint'), '200:1', 'not all partners use 3:1');
  assert.equal(out.rates.size, 9);
});

test('Marriott rejects bonus-bearing or conflicting cells instead of turning bonuses into a base rate', () => {
  const malformed = bodies.MAR.replace('3:1', '3:1 plus 5,000 bonus miles');
  const out = parseMarriottRatios(malformed);
  assert.equal(out.rates.has('Air Canada Aeroplan'), false);
  assert.ok(out.pending.has('Air Canada Aeroplan'));
  const conflict = bodies.MAR.replace('</tbody>', '<tr><td>Air Canada Aeroplan</td><td>2:1</td></tr></tbody>');
  assert.equal(parseMarriottRatios(conflict).rates.has('Air Canada Aeroplan'), false);
  assert.equal(parseMarriottRatios(bodies.MAR.replace('3:1', '0:1')).rates.has('Air Canada Aeroplan'), false);
});

test('Choice associates each starting exchange amount with its own card, not earning-per-stay copy', () => {
  const out = parseChoiceRatios(bodies.CHO);
  assert.equal(out.rates.get('Air France / KLM Flying Blue'), '5:1');
  assert.equal(out.rates.get('United MileagePlus'), '5:1');
  assert.equal(out.rates.get('Qantas Frequent Flyer'), '2.5:1');
  const earning = bodies.CHO.replaceAll('Starting at 5,000 points for 1,000 Flying Blue Miles', '1,000 miles per stay');
  assert.equal(parseChoiceRatios(earning).rates.has('Air France / KLM Flying Blue'), false);
});

test('Choice rejects promotional copy, zero amounts and conflicting cards', () => {
  assert.equal(parseChoiceRatios(bodies.CHO.replaceAll('Starting at 5,000 points for 1,000 Flying Blue Miles',
    'Starting at 5,000 points for 1,000 Flying Blue Miles plus bonus miles')).rates.has('Air France / KLM Flying Blue'), false);
  assert.equal(parseChoiceRatios(bodies.CHO.replaceAll('5,000 points for 1,000', '0 points for 1,000')).rates.has('United MileagePlus'), false);
  const conflict = bodies.CHO + '<div class="cmp-text"><h4>United</h4><p>Starting at 5,000 points for 2,000 MileagePlus miles</p></div>';
  assert.equal(parseChoiceRatios(conflict).rates.has('United MileagePlus'), false);
});

test('Wyndham verifies all Singapore bundles while United promotional API amounts remain unknown', () => {
  const out = parseWyndhamRatios(bodies.WYN);
  assert.equal(out.rates.get('Singapore KrisFlyer'), '5:1');
  assert.equal(out.rates.has('United MileagePlus'), false);
  assert.match(out.pending.get('United MileagePlus'), /base/i);
});

test('Wyndham refuses missing, inconsistent, renamed or newly enhanced Singapore bundles', () => {
  for (const change of [
    (doc) => { doc.data = doc.data.filter((row) => row.redemptionItemCode !== 'SQ-MILES-6000'); },
    (doc) => { doc.data.find((row) => row.redemptionItemCode === 'SQ-MILES-3200').faceValue = 6400; },
    (doc) => { doc.data.filter((row) => row.currencyRequired && row.redemptionItemCode.startsWith('SQ-')).forEach((row) => { row.faceValue *= 2; }); },
    (doc) => { doc.data.find((row) => row.redemptionItemCode === 'SQ-MILES-1200').description = '1,200 Other Airline Miles'; },
  ]) {
    const doc = JSON.parse(bodies.WYN); change(doc);
    const out = parseWyndhamRatios(doc);
    assert.equal(out.rates.has('Singapore KrisFlyer'), false);
    assert.ok(out.pending.has('Singapore KrisFlyer'));
  }
});

test('redesigned, unavailable or malformed sources fail instead of looking like a verified empty programme', () => {
  assert.throws(() => parseMarriottRatios(fixture('unavailable.html')));
  assert.throws(() => parseChoiceRatios(fixture('unavailable.html')));
  assert.throws(() => parseWyndhamRatios(fixture('unavailable.html')));
  assert.throws(() => parseWyndhamRatios('{"data":[]}'));
});

test('refresh corrects proven routes only, reports partial coverage and does not re-date incomplete Wyndham evidence', async () => {
  const doc = tracked();
  const out = await refreshHotelRatios(doc, { getPage, now, log: quiet });
  assert.equal(doc.directory.MAR.air[0][1], '3:1');
  assert.equal(doc.directory.CHO.air[0][1], '5:1');
  assert.equal(doc.directory.WYN.air[0][1], '5:1');
  assert.equal(doc.directory.WYN.air[1][1], '—');
  assert.equal(doc.ratioProvenance.MAR.asOf, '2026-10-14');
  assert.equal(doc.ratioProvenance.CHO.asOf, '2026-10-14');
  assert.equal(doc.ratioProvenance.WYN.asOf, '2026-09-01');
  assert.equal(out.coverage.MAR.complete, true);
  assert.equal(out.coverage.WYN.complete, false);
  assert.equal(out.coverage.WYN.verified, 1);
  assert.equal(out.coverage.WYN.total, 2);
  assert.equal(out.ok, true, 'an already unknown baseline is not an operational failure');
  assert.ok(out.pending.some((row) => row.knownUnknown === true && row.bank === 'WYN' && row.partner === 'United MileagePlus'));
  assert.equal(doc.directory.MAR.air.length, 2, 'new partners need a separate directory review');
  assert.equal(out.changes.length, 3);
});

test('a source outage preserves that bank and its evidence while other verified banks still refresh', async () => {
  const doc = tracked(), before = structuredClone(doc);
  const out = await refreshHotelRatios(doc, { now, log: quiet, getPage: async (url) => {
    if (url.includes('marriott.com')) throw new Error('HTTP 503');
    return getPage(url);
  } });
  assert.deepEqual(doc.directory.MAR, before.directory.MAR);
  assert.deepEqual(doc.ratioProvenance.MAR, before.ratioProvenance.MAR);
  assert.equal(doc.directory.CHO.air[0][1], '5:1');
  assert.equal(out.coverage.MAR.status, 'failed');
  assert.ok(out.failures.some((row) => row.bank === 'MAR'));
});

test('a missing tracked route retains its ratio and prevents programme-wide freshness', async () => {
  const doc = tracked();
  doc.directory.MAR.air.push(['Programme absent from source', '7:1']);
  doc.directory.CHO.hotel.push(['Unsupported hotel route', '1:1']);
  const out = await refreshHotelRatios(doc, { getPage, now, log: quiet });
  assert.equal(doc.directory.MAR.air.at(-1)[1], '7:1');
  assert.equal(doc.ratioProvenance.MAR.asOf, '2026-09-01');
  assert.equal(doc.ratioProvenance.CHO.asOf, '2026-09-01');
  assert.equal(out.coverage.MAR.complete, false);
  assert.equal(out.pending.filter((row) => row.bank === 'MAR').length, 1);
});

test('dry-run is read-only for partners while the separate report records per-route checks', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotel-ratios-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json'), reportPath = path.join(dir, 'report.json');
  const doc = sample(); doc.directory.MAR.air[0][1] = '4:1';
  writeFileSync(partnersPath, JSON.stringify(doc));
  const before = readFileSync(partnersPath, 'utf8');
  const out = await runHotelRatios({ partnersPath, reportPath, dryRun: true, getPage, now, log: quiet });
  assert.equal(readFileSync(partnersPath, 'utf8'), before);
  const report = JSON.parse(readFileSync(reportPath));
  assert.equal(report.dryRun, true);
  assert.ok(report.verified.some((row) => row.bank === 'MAR' && row.ratio === '3:1'));
  assert.equal(report.written, false);
  assert.equal(out.changed, true);
});

test('non-dry refresh persists independently verified corrections despite one pending route', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotel-ratios-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  const doc = sample(); doc.directory.MAR.air[0][1] = '4:1';
  writeFileSync(partnersPath, JSON.stringify(doc));
  const out = await runHotelRatios({ partnersPath, getPage, now, log: quiet });
  assert.equal(JSON.parse(readFileSync(partnersPath)).directory.MAR.air[0][1], '3:1');
  assert.equal(out.written, true);
  assert.equal(out.ok, true);
  assert.ok(out.pending.some((row) => row.partner === 'United MileagePlus' && row.knownUnknown));
});

test('CLI --partners --report --dry-run succeeds with a documented known unknown', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotel-ratios-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json'), reportPath = path.join(dir, 'report.json');
  const doc = sample(); doc.directory.MAR.air[0][1] = '4:1';
  writeFileSync(partnersPath, JSON.stringify(doc));
  const before = readFileSync(partnersPath, 'utf8');
  const preload = path.join(dir, 'fetch.mjs');
  writeFileSync(preload, `const bodies = ${JSON.stringify(Object.fromEntries(HOTEL_RATIO_SOURCES.map((s) => [s.url, bodies[s.bank]])))}; globalThis.fetch = async (url) => new Response(bodies[url]);`);
  const result = spawnSync(process.execPath, ['--import', preload, 'scripts/refresh-hotel-ratios.mjs', '--partners', partnersPath, '--report', reportPath, '--dry-run'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(partnersPath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(reportPath)).dryRun, true);
  assert.match(result.stdout, /WYN.*1\/2/);
});

test('a report path cannot overwrite the partners input, including during a dry-run', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotel-ratios-path-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  writeFileSync(partnersPath, JSON.stringify(sample()));
  const before = readFileSync(partnersPath, 'utf8');
  await assert.rejects(runHotelRatios({ partnersPath, reportPath: partnersPath, dryRun: true, getPage, now, log: quiet }), /report.*partners/i);
  assert.equal(readFileSync(partnersPath, 'utf8'), before);
});


test('a previously known United ratio cannot be silently downgraded to a nonblocking unknown', async () => {
  const doc = tracked(); doc.directory.WYN.air[1][1] = '5:1';
  const out = await refreshHotelRatios(doc, { getPage, now, log: quiet });
  assert.equal(out.ok, false);
  assert.equal(doc.directory.WYN.air[1][1], '5:1');
  assert.equal(doc.ratioProvenance.WYN.asOf, '2026-09-01');
  assert.equal(out.pending.find((row) => row.partner === 'United MileagePlus').knownUnknown, false);
});

test('changed or missing United API amounts require review even when its retained base is unknown', async () => {
  for (const change of [
    (doc) => { doc.data = doc.data.filter((row) => !row.redemptionItemCode.startsWith('UA')); },
    (doc) => { doc.data.find((row) => row.redemptionItemCode === 'UA-MILES-2400').faceValue = 1200; },
  ]) {
    const body = JSON.parse(bodies.WYN); change(body);
    const doc = tracked();
    const out = await refreshHotelRatios(doc, { now, log: quiet, getPage: async (url) => url.includes('wyndhamhotels') ? JSON.stringify(body) : getPage(url) });
    assert.equal(out.ok, false);
    assert.equal(doc.directory.WYN.air[1][1], '—');
    assert.equal(out.pending.find((row) => row.partner === 'United MileagePlus').knownUnknown, false);
  }
});

test('an unavailable Wyndham source is an operational failure even if all its tracked ratios are unknown', async () => {
  const doc = tracked(); doc.directory.WYN.air = [['United MileagePlus', '—']];
  const out = await refreshHotelRatios(doc, { now, log: quiet, getPage: async (url) => {
    if (url.includes('wyndhamhotels')) throw new Error('HTTP 503');
    return getPage(url);
  } });
  assert.equal(out.ok, false);
  assert.equal(out.coverage.WYN.status, 'failed');
});

test('CLI exits 1 when a stored known United ratio cannot be verified', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotel-ratios-cli-known-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json'), reportPath = path.join(dir, 'report.json');
  const doc = sample(); doc.directory.WYN.air.find(([name]) => name === 'United MileagePlus')[1] = '5:1';
  writeFileSync(partnersPath, JSON.stringify(doc));
  const preload = path.join(dir, 'fetch.mjs');
  writeFileSync(preload, `const bodies = ${JSON.stringify(Object.fromEntries(HOTEL_RATIO_SOURCES.map((s) => [s.url, bodies[s.bank]])))}; globalThis.fetch = async (url) => new Response(bodies[url]);`);
  const result = spawnSync(process.execPath, ['--import', preload, 'scripts/refresh-hotel-ratios.mjs', '--partners', partnersPath, '--report', reportPath, '--dry-run'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(readFileSync(reportPath));
  assert.equal(report.ok, false);
  assert.equal(report.pending.find((row) => row.partner === 'United MileagePlus').knownUnknown, false);
});
