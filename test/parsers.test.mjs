import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { source as frequentmiler, parseHistory } from '../src/sources/frequentmiler.mjs';
import { source as awardwallet } from '../src/sources/awardwallet.mjs';
import { source as livelo } from '../src/sources/livelo.mjs';
import { source as esfera } from '../src/sources/esfera.mjs';
import { resolveBank, resolvePartner } from '../src/aliases.mjs';

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
  assert.deepEqual(entries[0], {
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
  assert.deepEqual(entries[0], {
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
  assert.deepEqual(entries[0], {
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
