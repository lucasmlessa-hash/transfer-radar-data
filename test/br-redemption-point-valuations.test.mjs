import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BR_REDEMPTION_SOURCE as source } from '../src/sources/br-redemption-point-valuations.mjs';

const html = readFileSync(new URL('../fixtures/valuations-milhasbot-br-2026-11.html', import.meta.url), 'utf8');
const now = new Date('2026-11-26T13:00:00Z');
const quote = { cotacaoVenda: 5.8825, dataHoraCotacao: '2026-11-25 13:05:00.000' };
function collect(page = html, quotes = [quote], at = now, previousMeta) {
  const fetchImpl = async url => {
    if (url === source.url) return new Response(page);
    assert.equal(new URL(url).hostname, 'olinda.bcb.gov.br');
    return Response.json({ '@odata.context': 'https://olinda.bcb.gov.br/odata$metadata#_CotacaoDolarPeriodo(cotacaoVenda,dataHoraCotacao)', value: quotes });
  };
  return source.collect({ fetchImpl, now: at, previousMeta });
}

test('the monthly Brazilian redemption table converts just LATAM, Azul and TAP at the latest published PTAX', async () => {
  const next = await collect(html, [quote, { cotacaoVenda: 6, dataHoraCotacao: '2026-11-26 14:00:00.000' }]);
  assert.deepEqual(next.values, { LA: 0.458989, TP: 0.339992, AD: 0.288993 });
  assert.deepEqual(next.missingCodes, []);
  assert.deepEqual(next.dates, { LA: '2026-11-01', TP: '2026-11-01', AD: '2026-11-01' });
  assert.equal(next.meta.TP.sourceValue, 0.02);
  assert.equal(next.meta.LA.source, source.url);
  assert.equal(next.meta.TP.asOf, '2026-11-25');
  assert.equal(next.evidence.editorial.month, '2026-11');
  assert.deepEqual(next.evidence.editorial.rangesBrlPer1000, { LA: [27,33], TP: [20,26], AD: [17,21] });
  assert.equal(next.evidence.fx.date, '2026-11-25');
  assert.equal(next.evidence.fx.brlPerUsd, 5.8825);
});

test('a missing, ambiguous or malformed program cannot use a purchase price or invalidate the other rows', async () => {
  const tap = '<tr><th scope="row">TAP Miles&amp;Go</th><td>R$ 20 a 26 / milheiro</td></tr>';
  for (const page of [html.replace(tap,''), html.replace(tap,tap+tap), html.replace('20 a 26','30 a 26'), html.replace('20 a 26 / milheiro','20 a 26 / ponto')]) {
    const result = await collect(page);
    assert.deepEqual(result.missingCodes,['TP']);
    assert.deepEqual(Object.keys(result.values).sort(),['AD','LA']);
  }
  const decimal = await collect(html.replace('27 a 33','27,50 a 33,75'));
  assert.equal(decimal.meta.LA.sourceValue,0.0275);
});

test('scope, edition, redemption meaning and an independently current fixing must all be identifiable', async () => {
  for (const page of [html.replaceAll('novembro','agosto'), html.replaceAll('novembro','dezembro'), html.replace('Referência de novembro','Referência de janeiro'),
    html.replace('uso típico (ponta de baixo)','preço de compra'), html.replace('Valor de uso (faixa)','Teto de compra'), html+html]) {
    await assert.rejects(collect(page), /MilhasBot/);
  }
  await assert.rejects(collect(html,[]), /PTAX/);
  await assert.rejects(collect(html,[quote],now,{source:source.url, asOf:'2026-11-26'}),/predates stored PTAX/);
  await assert.rejects(collect(html,[quote],now,{source:source.url, note:"Lower bound of MilhasBot's 2026-12 airfare redemption range"}),/predates stored redemption/);
  const expired = new Date('2026-12-07T18:00:00Z');
  await assert.rejects(collect(html,[{...quote, dataHoraCotacao:'2026-12-07 13:00:00'}],expired),/MilhasBot/);
});
