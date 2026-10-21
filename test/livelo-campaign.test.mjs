import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { source } from '../src/sources/livelo.mjs';
import { normalize } from '../src/normalize.mjs';
import { runPipeline } from '../src/publish.mjs';

const fixtures = new URL('../fixtures/', import.meta.url);
const fixture = name => readFileSync(new URL(name + '.html', fixtures), 'utf8');
const loadPage = async url => fixture('livelo-' + new URL(url).pathname.split('/').pop());
const now = new Date('2026-10-13T12:00:00Z');
const routes = entries => normalize(entries, now, new Map()).routes;

test('official campaign pages make Flying Blue, Copa and Etihad visible as active bonuses', async () => {
  const entries = await source.parse(fixture('livelo-october'), { loadPage });
  assert.equal(entries.length, 3, 'duplicate carousel cards must not duplicate bonuses');
  for (const [id, pct, startDate, endDate] of [
    ['liv-af', 20, '2026-09-30', '2026-10-31'],
    ['liv-cm', 50, '2026-10-01', '2026-10-15'],
    ['liv-ey', 40, '2026-10-01', '2026-10-31'],
  ]) assert.deepEqual(routes(entries).find(r => r.id === id).active, { pct, startDate, endDate });
});

test('expired campaign year is preserved rather than rolled into the next year', async () => {
  const entries = await source.parse(fixture('livelo-october'), { loadPage });
  const af = normalize(entries, new Date('2027-01-01'), new Map()).routes.find(r => r.id === 'liv-af');
  assert.equal(af.active, undefined);
  assert.equal(af.ended, undefined, 'old campaigns are not recently ended');
  assert.equal(entries.find(e => /Flying Blue/i.test(e.partnerName)).endDateRaw, '10/31/2026');
});

test('dates can come from campaign description and cross a year boundary', async () => {
  const entries = await source.parse(fixture('livelo-october'), {
    loadPage: async url => loadPage(url).then(html => html
      .replace(/"partnercampaignalert":"[^"]*"/g, '"partnercampaignalert":""')
      .replace('20% de bônus para todos os clientes;', '20% de bônus para todos os clientes; Válido de 30/12 até 05/01/2027;')),
  });
  const af = normalize(entries, new Date('2026-12-31'), new Map()).routes.find(r => r.id === 'liv-af');
  assert.deepEqual(af.active, { pct: 20, startDate: '2026-12-30', endDate: '2027-01-05' });
});

for (const [name, loader] of [
  ['HTTP failure', async () => { throw new Error('HTTP 503'); }],
  ['invalid payload', async () => '<html>maintenance</html>'],
  ['different bonus', async url => (await loadPage(url)).replaceAll('20%', '30%')],
  ['invalid date', async url => (await loadPage(url)).replaceAll('31/10/2026', '31/02/2026')],
]) test(`${name} never invents an active Flying Blue bonus`, async () => {
  const entries = await source.parse(fixture('livelo-october'), { loadPage: loader });
  assert.equal(routes(entries).find(r => r.id === 'liv-af').active, undefined);
});

test('closed cards do not become active from a campaign detail page', async () => {
  const html = fixture('livelo-october').replaceAll('"statusCard":"active"', '"statusCard":"closed"');
  assert.deepEqual(await source.parse(html, { loadPage }), []);
});

test('fixture pipeline enriches campaigns without network and surfaces unresolved dates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'livelo-campaign-'));
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const fixturesDir = path.join(dir, 'fixtures');
    cpSync(fixtures, fixturesDir, { recursive: true });
    writeFileSync(path.join(fixturesDir, 'livelo.html'), fixture('livelo-october'));
    const result = await runPipeline({ fixtures: true, fixturesDir, outDir: path.join(dir, 'out'), now });
    assert.equal(result.ok, true);
    assert.equal(result.routes.find(r => r.id === 'liv-af').active?.pct, 20);
    rmSync(path.join(fixturesDir, 'livelo-LIVK0007.html'));
    const degraded = await runPipeline({ fixtures: true, fixturesDir, outDir: path.join(dir, 'out'), now });
    assert.equal(degraded.routes.find(r => r.id === 'liv-af').active, undefined);
    assert.ok(warnings.some(w => w.startsWith('::warning::') && /livelo.*undated/i.test(w)));
  } finally {
    console.warn = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('countdown keeps its explicit year and Brazilian closing day', async () => {
  const html = fixture('livelo-october').replaceAll('"endDate":null', '"endDate":"2026-11-01T02:59:59Z"');
  const entries = await source.parse(html);
  const route = normalize(entries, new Date('2027-10-01'), new Map()).routes.find(r => r.id === 'liv-af');
  assert.equal(route.active, undefined, 'an old countdown must not become a current promotion');
  assert.equal(entries.find(e => /Flying Blue/i.test(e.partnerName)).endDateRaw, '10/31/2026');
});

test('Azul October campaign accepts às with time, de and a two-digit year', async () => {
  const listing = '<script id="__NEXT_DATA__">' + JSON.stringify({status:{variations:[{status:'Vigente',title:'Ganhe até 100% de bônus',button:{redirectLink:'/livelo-para-parceiros/azul/AZLTransfer'}}]}}) + '</script>';
  const entries = await source.parse(listing, {loadPage: async () => fixture('livelo-AZLTransfer-2026-10')});
  assert.equal(entries[0].startDateRaw, '10/20/2026');
  assert.equal(entries[0].endDateRaw, '10/21/2026');
  const expired = normalize(entries, new Date('2026-10-22T12:00:00Z'), new Map()).routes;
  assert.ok(expired.every(r => !r.active));
});
