import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorRatios } from '../scripts/monitor-ratios.mjs';
import { refreshBrRatios } from '../scripts/refresh-br-ratios.mjs';
import { checkCuratedRatios } from '../scripts/check-curated-ratios.mjs';

const quiet = () => {};
const fmHtml = (first = '1 to 1', second = '1 to 2') => `<table class="tablepress"><thead><tr>
  <th>Rewards Program</th><th>Amex Transfer Ratio</th></tr></thead><tbody>
  <tr><td>Avianca LifeMiles</td><td>${first}</td></tr>
  <tr><td>British Airways Avios</td><td>${second}</td></tr></tbody></table>`;
const sample = () => ({ directory: { AMEX: { air: [['Avianca LifeMiles', '1:1'], ['British Airways Avios', '—']], hotel: [] } } });

test('Bilt Marriott block-inclusive FM cell is checked against the official base-rate article', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ratio-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  writeFileSync(partnersPath, JSON.stringify({ directory: { BILT: { air: [], hotel: [['Marriott Bonvoy', '1:1']] } } }));
  const listing = fmHtml('20K to 25K', '1 to 1').replace('Amex', 'Bilt').replace('Avianca LifeMiles', 'Marriott Bonvoy');
  const result = await monitorRatios({ partnersPath, log: quiet, fetchImpl: async (url) => {
    if (url.includes('frequentmiler.com')) return new Response(listing);
    assert.equal(url, 'https://support.biltrewards.com/api/v2/help_center/en-us/articles/19086448638989.json');
    return Response.json({ article: { id: 19086448638989, body: '<ul><li>Marriott Bonvoy™ -1:1</li><li>Other hotel -1:2</li></ul>' } });
  } });
  assert.equal(result.ok, true);
  assert.equal(new Map(JSON.parse(readFileSync(partnersPath)).directory.BILT.hotel).get('Marriott Bonvoy'), '1:1',
    '20000 to25000 includes a block bonus and must never become the flat base rate');
});

test('Bilt official base-rate fallback outage or changed article shape stays unverified', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ratio-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  const saved = JSON.stringify({ directory: { BILT: { air: [['British Airways Avios', '1:1']], hotel: [['Marriott Bonvoy', '1:1']] } } });
  const listing = fmHtml('20K to 25K', '1 to 1').replace('Amex', 'Bilt').replace('Avianca LifeMiles', 'Marriott Bonvoy');
  for (const response of [new Response('offline', { status: 503 }), Response.json({ article: { id: 19086448638989, body: '<p>Transfer 20000 points for25000 Marriott points.</p>' } })]) {
    writeFileSync(partnersPath, saved);
    const result = await monitorRatios({ partnersPath, log: quiet, fetchImpl: async (url) => url.includes('frequentmiler.com') ? new Response(listing) : response });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(partnersPath, 'utf8'), saved);
  }
});

test('ratio monitor reports unavailable and empty sources without changing saved data', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ratio-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  const saved = JSON.stringify(sample());
  writeFileSync(partnersPath, saved);
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => new Response('<html>blocked</html>')]) {
    const result = await monitorRatios({ partnersPath, fetchImpl, log: quiet });
    assert.equal(result.ok, false, 'an unverified source is not an unchanged rate');
    assert.equal(readFileSync(partnersPath, 'utf8'), saved);
  }
});

test('ratio monitor saves newly known rates even when no previously known rate changed', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ratio-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  writeFileSync(partnersPath, JSON.stringify(sample()));
  const result = await monitorRatios({ partnersPath, fetchImpl: async () => new Response(fmHtml()), log: quiet });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, []);
  const actual = JSON.parse(readFileSync(partnersPath));
  assert.equal(new Map(actual.directory.AMEX.air).get('British Airways Avios'), '1:2');
});

test('ratio monitor preserves a known rate when another changed rate is saved', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ratio-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partnersPath = path.join(dir, 'partners.json');
  const doc = sample();
  doc.directory.AMEX.air[1][1] = '1:1';
  writeFileSync(partnersPath, JSON.stringify(doc));
  const result = await monitorRatios({ partnersPath, fetchImpl: async () => new Response(fmHtml('Unknown', '1 to 2')), log: quiet });
  assert.equal(result.ok, false, 'a formerly known rate could not be checked');
  const actual = JSON.parse(readFileSync(partnersPath));
  assert.equal(new Map(actual.directory.AMEX.air).get('Avianca LifeMiles'), '1:1');
  assert.equal(new Map(actual.directory.AMEX.air).get('British Airways Avios'), '1:2');
  assert.equal(result.changes.length, 1);
});

test('BR refresh keeps verified changes when an independent source fails and reports partial verification', async () => {
  const doc = { directory: { LIV: { air: [['Smiles (GOL)', '2:1']], hotel: [] }, ESF: { air: [['Smiles (GOL)', '1:1']], hotel: [] } } };
  const getPage = async (url) => {
    if (url.includes('esfera')) throw new Error('HTTP 503');
    if (url.endsWith('livelo-para-parceiros')) return '<script id="__NEXT_DATA__">{"listPartners":[{"nomeParceiro":"Smiles","redirectUrl":"/smiles"}]}</script>';
    return '<p>1 ponto Livelo = 1 milha Smiles</p>';
  };
  const result = await refreshBrRatios(doc, { getPage, wait: async () => {}, log: quiet, warn: quiet });
  assert.equal(result.changed, true);
  assert.equal(result.ok, false);
  assert.equal(doc.directory.LIV.air[0][1], '1:1');
  assert.equal(doc.directory.ESF.air[0][1], '1:1');
});

test('BR refresh reports loss of a previously published rate and retains the saved value', async () => {
  const doc = { directory: { LIV: { air: [['Smiles (GOL)', '1:1']], hotel: [] } } };
  const getPage = async (url) => {
    if (url.includes('esfera')) throw new Error('HTTP 503');
    if (url.endsWith('livelo-para-parceiros')) return '<script id="__NEXT_DATA__">{"listPartners":[{"nomeParceiro":"Smiles","redirectUrl":"/smiles"}]}</script>';
    return '<p>Smiles</p>';
  };
  const result = await refreshBrRatios(doc, { getPage, wait: async () => {}, log: quiet, warn: quiet });
  assert.equal(result.ok, false);
  assert.equal(result.failures.some((f) => f.bank === 'LIV'), true);
  assert.equal(doc.directory.LIV.air[0][1], '1:1');
});

test('BR refresh flags a disappeared partner for review instead of silently retaining a phantom route', async () => {
  const doc = { directory: { LIV: { air: [['Smiles (GOL)', '1:1'], ['Iberia Avios', '3.5:1']], hotel: [] } } };
  const getPage = async (url) => {
    if (url.includes('esfera')) throw new Error('HTTP 503');
    if (url.endsWith('livelo-para-parceiros')) return '<script id="__NEXT_DATA__">{"listPartners":[{"nomeParceiro":"Smiles","redirectUrl":"/smiles"}]}</script>';
    return '<p>1 ponto Livelo = 1 milha Smiles</p>';
  };
  const result = await refreshBrRatios(doc, { getPage, wait: async () => {}, log: quiet, warn: quiet });
  assert.equal(result.failures.some((f) => f.bank === 'LIV' && f.partner === 'Iberia Avios'), true);
  assert.equal(new Map(doc.directory.LIV.air).get('Iberia Avios'), '3.5:1', 'one incomplete source read cannot authorize removal');
});

test('curated review distinguishes fresh, stale, missing and future evidence using the supplied date', () => {
  const doc = { directory: {}, ratioProvenance: {} };
  for (const [bank, asOf] of [['MANUAL_A', '2026-09-08'], ['MANUAL_B', '2026-09-07'], ['MANUAL_C', null], ['OTHER', '2026-10-14']]) {
    doc.directory[bank] = { air: [['Airline', '3:1']], hotel: [] };
    if (asOf) doc.ratioProvenance[bank] = { asOf, source: 'https://example.com' };
  }
  const checks = checkCuratedRatios(doc, new Date('2026-10-13T12:00:00Z'));
  assert.deepEqual(checks.map(({ bank, status }) => [bank, status]), [
    ['MANUAL_A', 'fresh'], ['MANUAL_B', 'stale'], ['MANUAL_C', 'missing'], ['OTHER', 'invalid'],
  ]);
  assert.equal(doc.ratioProvenance.MANUAL_B.asOf, '2026-09-07', 'checking never re-dates evidence');
});
