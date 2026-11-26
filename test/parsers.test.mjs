import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from 'cheerio';

import { source as frequentmiler, parseHistory } from '../src/sources/frequentmiler.mjs';
import { source as awardwallet } from '../src/sources/awardwallet.mjs';
import { source as livelo } from '../src/sources/livelo.mjs';
import { source as esfera } from '../src/sources/esfera.mjs';
import { resolveBank, resolvePartner } from '../src/aliases.mjs';
import { normalize } from '../src/normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture(name) {
  return readFileSync(path.join(__dirname, '..', 'fixtures', `${name}.html`), 'utf8');
}

const SOURCES = [frequentmiler, awardwallet, livelo, esfera];

// endDateRaw is either empty (no published deadline) or one of the shapes
// normalize.mjs's parseEndDate() understands: "Month D, YYYY", "M/D/YY(YY)",
// "D/M" (no year), or "until Mon D".
const KNOWN_DATE_SHAPE =
  /^$|^[A-Za-z]+\s+\d{1,2},?\s*\d{4}$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$|^until\s+[A-Za-z]{3,}\s+\d{1,2}$/;

// These fixtures are snapshots of real, weekly-changing pages. Assert on
// structure/invariants here so the suite doesn't rot every time a site
// reshuffles its current bonus list - exact-value spot checks live in the
// per-source tests below, scoped to the one or two facts worth pinning down.
for (const src of SOURCES) {
  test(`${src.id}: returns structurally valid entries`, async () => {
    const html = fixture(src.id);
    const entries = await src.parse(html);

    assert.ok(entries.length >= 1, `${src.id} should return at least 1 entry`);
    for (const entry of entries) {
      assert.equal(typeof entry.bankName, 'string');
      assert.ok(entry.bankName.length > 0, `${src.id}: bankName must not be empty`);
      assert.equal(typeof entry.partnerName, 'string');
      assert.ok(entry.partnerName.length > 0, `${src.id}: partnerName must not be empty`);
      assert.equal(typeof entry.pct, 'number');
      assert.ok(Number.isFinite(entry.pct), `${src.id}: pct must not be NaN`);
      assert.ok(entry.pct > 0 && entry.pct <= 500, `${src.id}: pct ${entry.pct} out of plausible range`);
      assert.equal(typeof entry.endDateRaw, 'string');
      assert.match(entry.endDateRaw, KNOWN_DATE_SHAPE, `${src.id}: unrecognized endDateRaw shape "${entry.endDateRaw}"`);
      assert.equal(entry.sourceUrl, src.url);
    }
  });
}

// frequentmiler's fixture is a saved snapshot (not fetched live in tests), so
// pinning its exact shape is safe and catches real parser regressions.
test('frequentmiler: fixture spot-check (saved snapshot)', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  let entries;
  try {
    entries = await frequentmiler.parse(fixture('frequentmiler'));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(entries.length, 6, 'the current/upcoming table has 6 valid rows');
  assert.equal(warnings.length, 1, 'the one non-data row in the table should warn once');

  const row = entries.find((e) => e.partnerName === 'IHG');
  assert.ok(row, 'expected the Chase -> IHG row to be present');
  assert.equal(row.bankName, 'Chase Ultimate Rewards');
  assert.equal(row.pct, 100);
  assert.equal(row.endDateRaw, '07/30/26');
});

test('awardwallet: fixture spot-check (saved snapshot)', async () => {
  const entries = await awardwallet.parse(fixture('awardwallet'));

  assert.equal(entries.length, 9);

  const row = entries.find((e) => e.partnerName === 'Air France (Flying Blue)');
  assert.ok(row, 'expected the Citibank -> Air France row to be present');
  assert.equal(row.bankName, 'Citibank (ThankYou Rewards)');
  assert.equal(row.pct, 20);
  assert.equal(row.endDateRaw, 'August 22, 2026');
});

test('livelo: fixture spot-check (saved snapshot)', async () => {
  const entries = await livelo.parse(fixture('livelo'));

  assert.equal(entries.length, 1);
  assert.deepEqual(coreEntry(entries[0]), {
    bankName: 'Livelo',
    partnerName: 'Hilton Honors',
    pct: 50,
    endDateRaw: '', // no machine-readable deadline published - by design, not a bug
    sourceUrl: livelo.url,
  });
});

test('esfera: fixture spot-check (saved snapshot)', async () => {
  const entries = await esfera.parse(fixture('esfera'));

  assert.equal(entries.length, 1);
  assert.deepEqual(coreEntry(entries[0]), {
    bankName: 'Esfera',
    partnerName: 'Azul',
    pct: 115,
    endDateRaw: '26/07',
    sourceUrl: esfera.url,
  });
});

test('frequentmiler: added destination column preserves current offers and date positions', async () => {
  const entries = await frequentmiler.parse(fixture('frequentmiler-2026-10'));
  assert.equal(entries.length, 3);
  assert.deepEqual(coreEntry(entries[0]), {
    bankName: 'Citi ThankYou Rewards',
    partnerName: 'JAL (Japan Airlines) Mileage Bank',
    pct: 30,
    startDateRaw: '09/20/26',
    endDateRaw: '10/24/26',
    sourceUrl: frequentmiler.url,
  });
  assert.equal(entries[2].pct, 35, 'up-to percentages remain readable');
  assert.equal(entries[2].endDateRaw, '10/31/26');
});

test('frequentmiler: added destination column preserves historical windows', () => {
  assert.deepEqual(parseHistory(fixture('frequentmiler-2026-10')), [
    { bankName: 'Chase Ultimate Rewards', partnerName: 'Air Canada Aeroplan', pct: 20, startDateRaw: '08/12/26', endDateRaw: '09/30/26' },
    { bankName: 'Bilt', partnerName: 'Virgin Atlantic Flying Club', pct: 100, startDateRaw: '09/01/26', endDateRaw: '09/01/26' },
  ]);
});

test('Capital One’s verified Copa extension resolves only the superseded launch deadline', async () => {
  const launch = '<tr><td>Capital One Miles</td><td>Copa Airlines ConnectMiles</td><td>30% transfer bonus from Capital One Miles to Copa Airlines ConnectMiles</td><td>11/02/26</td><td>12/01/26</td></tr>';
  const $ = load(fixture('frequentmiler-2026-10'));
  $('tbody').html(launch);
  const [terms] = await frequentmiler.parse($.html());
  const listing = { bankName: 'Capital One', partnerName: 'Copa Airlines (ConnectMiles)', pct: 30,
    endDateRaw: 'December 31, 2026', sourceUrl: awardwallet.url, sourceId: awardwallet.id, bonusKind: 'fixed' };
  const routeAt = (entries, day) => normalize(entries, new Date(day), new Map()).routes[0];
  for (const entries of [[terms, listing], [listing, terms]]) {
    const route = routeAt(entries, '2026-11-26');
    assert.equal(route.offerEvidence.status, 'observed');
    assert.deepEqual(route.active, { pct: 30, startDate: '2026-11-02', endDate: '2026-12-31' });
    assert.ok(route.offerEvidence.observations.some(o => o.url.endsWith('/Capital-One-Copa-updated-transfer-bonus-900x264.png')));
    assert.equal(routeAt(entries, '2026-12-02').active?.pct, 30);
    assert.equal(routeAt(entries, '2027-01-01').active, undefined);
  }
  assert.equal(parseHistory($.html())[0].endDateRaw, terms.endDateRaw);
  for (const changed of [launch.replace('30%', '35%'), launch.replace('11/02/26', '11/20/26'),
    launch.replace('12/01/26', '12/15/26'), launch.replaceAll('Capital One Miles', 'Citi ThankYou Rewards')]) {
    $('tbody').html(changed);
    const [entry] = await frequentmiler.parse($.html());
    assert.equal(entry.sourceId, frequentmiler.id);
    assert.equal(parseHistory($.html())[0].endDateRaw, entry.endDateRaw);
  }
  assert.equal(routeAt([terms, { ...listing, endDateRaw: 'December 15, 2026' }], '2026-11-26').offerEvidence.status, 'conflict');
});

test('AwardWallet percentage ranges are conditional maxima, including when both endpoints have a percent sign', async () => {
  const $ = load(fixture('awardwallet-2026-10'));
  for (const range of ['40-55%', '40%–55%', '40% to 55%']) {
    const text = `Transfer partner added September 1, 2026 and ${range} transfer bonus through November 30, 2026.`;
    $('.tt-bonus').text(text);
    const [offer] = await awardwallet.parse($.html());
    assert.deepEqual([offer.pct, offer.bonusKind, offer.endDateRaw, offer.conditionsText],
      [55, 'up_to', 'November 30, 2026', text]);
  }
  $('.tt-bonus').text('100% through July 30, 2026. Then 70% through August 31, 2026.');
  const [first] = await awardwallet.parse($.html());
  assert.deepEqual([first.pct, first.bonusKind, first.endDateRaw], [100, 'fixed', 'July 30, 2026']);
});

test('frequentmiler: a headerless copy of the current TablePress table retains its expired windows', async () => {
  const $ = load(fixture('frequentmiler-2026-10'));
  const archive = $('table').last();
  archive.find('thead').remove();
  const rows = parseHistory($.html());
  assert.deepEqual(rows, [
    { bankName: 'Chase Ultimate Rewards', partnerName: 'Air Canada Aeroplan', pct: 20, startDateRaw: '08/12/26', endDateRaw: '09/30/26' },
    { bankName: 'Bilt', partnerName: 'Virgin Atlantic Flying Club', pct: 100, startDateRaw: '09/01/26', endDateRaw: '09/01/26' },
  ]);
  assert.equal((await frequentmiler.parse($.html())).length, 3);

  archive.find('tr').first().append('<td>unknown column</td>');
  assert.deepEqual(parseHistory($.html()), rows.slice(1));
  archive.removeClass('tablepress-id-33').addClass('tablepress-id-99');
  assert.deepEqual(parseHistory($.html()), []);
});

test('awardwallet: a flat signup reward alongside percentage offers leaves coverage complete', async () => {
  const $ = load(fixture('awardwallet-2026-10'));
  const row = $('.tt-row').last().clone().appendTo('.transfer-times');
  row.find('.tt-bonus').text('Get 5,000 bonus Velocity points for joining RevPoints, linking your Velocity account, and making a points transfer by January 16, 2027');
  const entries = await awardwallet.parse($.html());
  assert.equal(entries.length, 2);
  assert.equal(entries.coverageComplete, true);

  row.find('.tt-bonus').text('Special transfer bonus through January 16, 2027');
  assert.equal((await awardwallet.parse($.html())).coverageComplete, false);
});

test('awardwallet: recipient region is metadata, not part of the airline name', async () => {
  const entries = await awardwallet.parse(fixture('awardwallet-2026-10'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].partnerName, 'British Airways (Club)');
  assert.equal(resolveBank(entries[0].bankName), 'C1');
  assert.equal(resolvePartner(entries[0].partnerName), 'BA');
  assert.equal(entries[0].pct, 20);
  assert.equal(entries[0].endDateRaw, 'October 31, 2026');
  // Flying Blue was never missing an alias: HSBC is the untracked origin.
  assert.equal(resolvePartner(entries[1].partnerName), 'AF');
  assert.equal(resolveBank(entries[1].bankName), null);
});

test('esfera: populated shopping carousel can legitimately contain no transfer bonus', async () => {
  const html = fixture('esfera-empty-2026-10');
  assert.deepEqual(await esfera.parse(html), []);
  assert.equal(esfera.isValidEmpty?.(html), true);
  assert.equal(esfera.isValidEmpty?.('<html><img alt="Esfera"></html>'), false);
  assert.equal(esfera.isValidEmpty?.('<div class="carousel-item"><img alt=""></div>'), false);
  assert.equal(esfera.isValidEmpty?.(fixture('esfera')), false);
  const malformedBonus = html + '<div class="carousel-item"><img alt="Transfira pontos e ganhe 50% de bônus!"></div>';
  assert.equal(esfera.isValidEmpty?.(malformedBonus), false, 'a missing deadline must not masquerade as no offers');
});

test('livelo: known shopping cards distinguish zero transfer bonuses from a broken payload', async () => {
  const html = fixture('livelo-shopping-2026-10');
  assert.deepEqual(await livelo.parse(html), []);
  assert.equal(livelo.isValidEmpty?.(html), true);
  assert.equal(livelo.isValidEmpty?.('<html>Forbidden</html>'), false);
  assert.equal(livelo.isValidEmpty?.('<script id="__NEXT_DATA__">{}</script>'), false);
  assert.equal(livelo.isValidEmpty?.('<script id="__NEXT_DATA__">{bad</script>'), false);
  assert.equal(livelo.isValidEmpty?.(fixture('livelo')), false);
  const changedTransfer = html.replace('Ganhe em suas compras:', 'Transfira pontos e ganhe cinquenta por cento de bônus');
  assert.equal(livelo.isValidEmpty?.(changedTransfer), false, 'a changed transfer-bonus format cannot become healthy zero');
});

// Legacy extraction assertions omit the additive evidence fields, verified below.
function coreEntry({ sourceId, bonusKind, conditionsText, campaignUrl, ...entry }) { return entry; }

test('parser evidence retains the source, public terms and conditional maximum', async () => {
  const rows = await frequentmiler.parse(fixture('frequentmiler-2026-10'));
  assert.equal(rows[2].sourceId, 'frequentmiler');
  assert.equal(rows[2].bonusKind, 'up_to');
  assert.match(rows[2].conditionsText, /35%/);
});
