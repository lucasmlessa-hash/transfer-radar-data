import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLedger, updateLedger, toRawWindows } from '../src/observed.mjs';
import { deriveHistory } from '../src/history.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'observed-'));

const route = (id, bank, code, pct, endDate) => ({ id, bank, code, active: endDate === undefined ? { pct } : { pct, endDate } });

test('missing ledger file is a legitimate bootstrap, unreadable one is untouchable', () => {
  assert.deepEqual(loadLedger(path.join(dir, 'nope.json')), { ok: true, windows: [] });

  const corrupt = path.join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{"version":1,"windows":'); // truncated write
  assert.equal(loadLedger(corrupt).ok, false, 'corrupt ledger must flag ok:false so nothing overwrites it');

  const wrongShape = path.join(dir, 'shape.json');
  writeFileSync(wrongShape, '{"version":1}');
  assert.equal(loadLedger(wrongShape).ok, false);
});

test('a live bonus opens one entry and continued sightings only advance it', () => {
  let w = updateLedger([], [route('esf-ad', 'ESF', 'AD', 115, '2026-08-10')], '2026-07-25');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], { id: 'esf-ad', bank: 'ESF', code: 'AD', pct: 115, firstSeen: '2026-07-25', lastSeen: '2026-07-25', endDate: '2026-08-10' });

  // same bonus, three days later, source now reports a higher pct and a later end (extension)
  w = updateLedger(w, [route('esf-ad', 'ESF', 'AD', 120, '2026-08-20')], '2026-07-28');
  assert.equal(w.length, 1, 'continuation, not a second entry');
  assert.equal(w[0].firstSeen, '2026-07-25');
  assert.equal(w[0].lastSeen, '2026-07-28');
  assert.equal(w[0].pct, 120, 'keeps the highest pct seen');
  assert.equal(w[0].endDate, '2026-08-20', 'adopts the extended end date');
});

test('a reappearance after the gap, or past the known end, is a NEW window', () => {
  const seed = updateLedger([], [route('rove-qf', 'ROVE', 'QF', 50)], '2026-07-01');
  // 10 days of absence -> new entry even without an endDate
  const after = updateLedger(seed, [route('rove-qf', 'ROVE', 'QF', 50)], '2026-07-11');
  assert.equal(after.length, 2, 'gap beyond 7 days splits windows');

  // seen yesterday but its published end date has passed -> also a new window
  const ended = [{ id: 'liv-la', bank: 'LIV', code: 'LA', pct: 40, firstSeen: '2026-07-01', lastSeen: '2026-07-24', endDate: '2026-07-20' }];
  const relisted = updateLedger(ended, [route('liv-la', 'LIV', 'LA', 40, '2026-09-01')], '2026-07-25');
  assert.equal(relisted.length, 2, 'a listing past its own end date starts a fresh window');
});

test('updateLedger is pure and untouched entries survive verbatim', () => {
  const before = [{ id: 'esf-ad', bank: 'ESF', code: 'AD', pct: 80, firstSeen: '2025-03-01', lastSeen: '2025-03-20', endDate: '2025-03-20' }];
  const frozen = JSON.parse(JSON.stringify(before));
  const out = updateLedger(before, [route('liv-g3', 'LIV', 'G3', 30, '2026-08-01')], '2026-07-25');
  assert.deepEqual(before, frozen, 'input not mutated');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], frozen[0], 'old closed window carried through untouched');
});

test('toRawWindows feeds deriveHistory and dedupes what FM already archived', () => {
  const windows = [
    { id: 'esf-ad', bank: 'ESF', code: 'AD', pct: 115, firstSeen: '2026-06-10', lastSeen: '2026-07-01', endDate: '2026-07-01' },
    // Amex->Virgin window that FM's archive also carries -> must be dropped
    { id: 'amex-vs', bank: 'AMEX', code: 'VS', pct: 30, firstSeen: '2026-05-05', lastSeen: '2026-05-30', endDate: '2026-05-30' },
  ];
  const fmRaw = [
    { bankName: 'Amex Membership Rewards', partnerName: 'Virgin Atlantic', pct: 30, startDateRaw: '05/01/26', endDateRaw: '05/31/26' },
  ];
  const raw = toRawWindows(windows, fmRaw);
  assert.equal(raw.length, 1, 'FM-covered window deduped');
  assert.equal(raw[0].bankName, 'ESF');

  // the surviving row must round-trip through the SAME resolvers production
  // uses — this is the assert that keeps an alias refactor from silently
  // discarding every observed window
  const derived = deriveHistory(new Date('2026-07-25T00:00:00Z'), raw);
  const entry = derived.get('esf-ad');
  assert.ok(entry, 'observed window resolves into real history');
  assert.equal(entry.hist.length, 1);
  assert.equal(entry.hist[0].pct, 115);
  assert.equal(entry.hist[0].w, 'JUN 2026');
});

test('an endDate before firstSeen falls back to lastSeen instead of an inverted window', () => {
  // pathological but reachable: a stale listing re-appears after its end date
  const windows = [{ id: 'liv-la', bank: 'LIV', code: 'LA', pct: 25, firstSeen: '2026-07-25', lastSeen: '2026-07-26', endDate: '2026-07-20' }];
  const raw = toRawWindows(windows, []);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].endDateRaw, '7/26/2026', 'lastSeen wins over an end date that precedes firstSeen');
  assert.ok(deriveHistory(new Date('2026-08-01T00:00:00Z'), raw).get('liv-la'), 'still valid history');
});

test('runPipeline wires the ledger end to end: sighting, persistence, continuation', async (t) => {
  const { runPipeline } = await import('../src/publish.mjs');
  const { rmSync, readFileSync: rf, existsSync } = await import('node:fs');
  const outDir = mkdtempSync(path.join(tmpdir(), 'observed-out-'));
  const ledgerPath = path.join(outDir, 'ledger', 'observed-windows.json');
  // Pinned clock, before the earliest fixture end date (2026-07-26). Without it
  // the test read the real calendar, so once wall-clock time passed those end
  // dates every re-sighting reopened the expired windows (9 vs 6) and the suite
  // rotted. The panel suite learned this same lesson; runPipeline takes `now`.
  const now = new Date('2026-07-20T12:00:00Z');
  try {
    const r1 = await runPipeline({ fixtures: true, outDir, ledgerPath, now });
    assert.equal(r1.ok, true);
    assert.ok(existsSync(ledgerPath), 'first build creates the ledger');
    const l1 = JSON.parse(rf(ledgerPath, 'utf8'));
    const activeIds = r1.routes.filter((x) => x.active).map((x) => x.id).sort();
    assert.deepEqual(l1.windows.map((w) => w.id).sort(), activeIds, 'every live bonus is a ledger window');

    // same fixtures again: continuation, not duplication
    const r2 = await runPipeline({ fixtures: true, outDir, ledgerPath, now });
    assert.equal(r2.ok, true);
    const l2 = JSON.parse(rf(ledgerPath, 'utf8'));
    assert.equal(l2.windows.length, l1.windows.length, 'a re-sighting never opens a second window');

    // a run with the ledger disabled must not leak the previous run's
    // observed windows into history via the module-level store
    const r3 = await runPipeline({ fixtures: true, outDir, now });
    assert.equal(r3.ok, true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a new window is stamped with what the PREVIOUS feed said — and only then', () => {
  const prevFeed = {
    generatedAt: '2026-07-24T18:00:00.000Z',
    routes: [
      { id: 'citi-af', p2: [0, 0, 0, 0, 0, 0, 0.34, 0, 0, 0, 0, 0], wait: [0.13, 0.69, 0.79] },
      { id: 'amex-vs', p2: null }, // old feed without the fields
    ],
  };
  const w = updateLedger([], [
    route('citi-af', 'CITI', 'AF', 20, '2026-08-22'),  // tracked, with numbers
    route('amex-vs', 'AMEX', 'VS', 30, '2026-07-31'),  // tracked, no numbers
    route('rove-qf', 'ROVE', 'QF', 50, '2026-08-14'),  // first-ever: not in prev feed
  ], '2026-07-25', prevFeed);

  // opening month is July -> index 6 of the previous feed's p2
  assert.deepEqual(w.find((x) => x.id === 'citi-af').pred, { p2: 0.34, w1: 0.13, asOf: '2026-07-24' });
  assert.deepEqual(w.find((x) => x.id === 'amex-vs').pred, { p2: null, w1: null, asOf: '2026-07-24' });
  // absence IS the record: a first-ever route is unforecastable by design, and
  // any future engine-check claim has to count it as such, not skip it.
  assert.deepEqual(w.find((x) => x.id === 'rove-qf').pred, { absent: true, asOf: '2026-07-24' });

  // a re-sighting must never launder hindsight into pred
  const later = { generatedAt: '2026-07-26T18:00:00.000Z', routes: [{ id: 'citi-af', p2: Array(12).fill(0.99), wait: [0.9, 0.9, 0.9] }] };
  const w2 = updateLedger(w, [route('citi-af', 'CITI', 'AF', 20, '2026-08-22')], '2026-07-26', later);
  assert.deepEqual(w2.find((x) => x.id === 'citi-af').pred, { p2: 0.34, w1: 0.13, asOf: '2026-07-24' }, 'pred is stamped once, at open');

  // bootstrap run (no previous feed): no pred at all — "we cannot know" is not
  // the same record as "the engine had nothing"
  const boot = updateLedger([], [route('esf-ad', 'ESF', 'AD', 115, '2026-08-10')], '2026-07-25', null);
  assert.equal(boot[0].pred, undefined);
});

test('a long source outage does not split a window whose end date never moved', () => {
  // Regressão real, achada em 2026-08-28. amex-ba +30% -> British Airways ia
  // até 2026-09-27, sumiu das fontes por 25 dias e voltou anunciando a MESMA
  // data. A regra de 7 dias abriu uma segunda janela para um bônus que nunca
  // parou; o fantasma virou "janela passada" no arquivo, puxou a mediana da
  // rota para o nível do bônus vigente e apagou o selo WEAK dele.
  const aberta = [{ id: 'amex-ba', bank: 'AMEX', code: 'BA', pct: 30, firstSeen: '2026-08-03', lastSeen: '2026-08-03', endDate: '2026-09-27' }];
  const depois = updateLedger(aberta, [route('amex-ba', 'AMEX', 'BA', 30, '2026-09-27')], '2026-08-28');
  assert.equal(depois.length, 1, 'mesma data de fim, ainda no futuro: é a mesma janela, por maior que seja o buraco');
  assert.equal(depois[0].firstSeen, '2026-08-03', 'o começo real é preservado');
  assert.equal(depois[0].lastSeen, '2026-08-28');

  // mas uma data de fim DIFERENTE após o buraco é uma janela nova de verdade
  const nova = updateLedger(aberta, [route('amex-ba', 'AMEX', 'BA', 30, '2026-11-30')], '2026-08-28');
  assert.equal(nova.length, 2, 'data de fim diferente = promoção nova');

  // ESTA asserção estava invertida e causou um runaway em produção — ver o
  // teste abaixo. Uma relistagem com a MESMA data de fim é a mesma janela,
  // tenha ela vencido ou não; o que abre janela nova é data diferente.
  const encerrada = [{ id: 'amex-ba', bank: 'AMEX', code: 'BA', pct: 30, firstSeen: '2026-05-01', lastSeen: '2026-06-01', endDate: '2026-06-01' }];
  const relistada = updateLedger(encerrada, [route('amex-ba', 'AMEX', 'BA', 30, '2026-06-01')], '2026-08-28');
  assert.equal(relistada.length, 1, 'mesma data de fim continua sendo a mesma janela');
});

test('fonte que insiste em listar bônus vencido não gera uma janela por build', () => {
  // Runaway real, achado em 2026-09-01: c1-av e citi-tk seguiam publicados com
  // fim em 31/08 depois do dia 01/09. Nenhum ramo do sameWindow casava, então
  // CADA build abria outra janela — duas no primeiro dia, sem teto. Cada uma
  // vira "janela passada" no arquivo e envenena a mediana da rota (foi assim
  // que os selos WEAK sumiram da primeira vez).
  const morto = { id: 'c1-av', bank: 'C1', code: 'AV', active: { pct: 15, endDate: '2026-08-31' } };
  let w = [{ id: 'c1-av', bank: 'C1', code: 'AV', pct: 15, firstSeen: '2026-08-03', lastSeen: '2026-08-31', endDate: '2026-08-31' }];
  for (const dia of ['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-05', '2026-10-01']) {
    w = updateLedger(w, [morto], dia);
  }
  assert.equal(w.length, 1, `cinco builds sobre listagem vencida abriram ${w.length} janelas`);
  assert.equal(w[0].firstSeen, '2026-08-03', 'e a janela original fica intacta');
  assert.equal(w[0].lastSeen, '2026-08-31', 'lastSeen não avança por avistamento de bônus morto');

  // o bônus que termina HOJE ainda é vivo — inclusivo, como no resto do app
  const hoje = updateLedger([], [{ id: 'x-vs', bank: 'BILT', code: 'VS', active: { pct: 100, endDate: '2026-09-01' } }], '2026-09-01');
  assert.equal(hoje.length, 1, 'um bônus que acaba hoje ainda é registrado');
});
