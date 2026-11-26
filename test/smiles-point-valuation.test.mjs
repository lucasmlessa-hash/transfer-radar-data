import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SMILES_VALUATION_SOURCE } from '../src/sources/smiles-point-valuation.mjs';

const html = readFileSync(new URL('../fixtures/smiles-point-valuation-milhasbot.html', import.meta.url), 'utf8');
const now = new Date('2026-11-26T13:00:00Z'); // 10:00 in Brasília, before today's fixing.
const context = 'https://was-p.bcnet.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata$metadata#_CotacaoDolarPeriodo(cotacaoVenda,dataHoraCotacao)';
const quote = (date = '2026-11-25', rate = 5.8825) => ({ dataHoraCotacao: `${date} 13:02:42.418138`, cotacaoVenda: rate });

function collect({ page = html, rates = [quote()], requestNow = now, previousMeta, errorHost = '' } = {}) {
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.host === errorHost) return new Response('', { status: 503 });
    if (url.href === 'https://www.milhasbot.com.br/valores-do-milheiro/smiles/') return new Response(page);
    assert.equal(url.hostname, 'olinda.bcb.gov.br');
    assert.match(url.pathname, /\/CotacaoDolarPeriodo\(/);
    assert.equal(url.searchParams.get('$select'), 'cotacaoVenda,dataHoraCotacao');
    return Response.json({ '@odata.context': context, value: rates });
  };
  return SMILES_VALUATION_SOURCE.collect({ fetchImpl, now: requestNow, previousMeta });
}

test('uses the lower BRL redemption bound and latest available selling PTAX before the check', async () => {
  const result = await collect({ rates: [quote('2026-11-26', 6), quote(), quote('2026-11-24', 5.8573)] });
  assert.deepEqual(result.values, { G3: 0.36 });
  assert.deepEqual(result.missingCodes, []);
  assert.equal(result.meta.G3.currency, 'BRL');
  assert.equal(result.meta.G3.sourceCurrency, 'BRL');
  assert.equal(result.meta.G3.sourceValue, 0.021);
  assert.equal(result.meta.G3.fxRate, 5.8825);
  assert.equal(result.meta.G3.asOf, '2026-11-25');
  assert.equal(result.evidence.editorial.month, '2026-11');
  assert.deepEqual(result.evidence.editorial.rangeBrlPer1000, [21, 27]);
  assert.equal(result.evidence.fx.date, '2026-11-25');
  assert.match(result.evidence.fx.url, /olinda\.bcb\.gov\.br/);
  assert.equal(result.evidence.checkedAt, now.toISOString());
});

test('uses updated decimal-comma redemption values in both the paragraph and the table', async () => {
  const page = html.replace('R$ 21 a R$ 27', 'R$ 23,50 a R$ 29,00').replace('R$ 21–27', 'R$ 23,50–29,00');
  const result = await collect({ page });
  assert.deepEqual(result.values, { G3: 0.4 });
  assert.equal(result.meta.G3.sourceValue, 0.0235);
});

test('rejects a missing, conflicting, mislabeled, out-of-date or ambiguous redemption range', async () => {
  const wrongPages = [
    html.slice(html.indexOf('<section>')), html.replace('em resgate', 'em compra'), html.replace('1.000 milhas</td>', '1.500 milhas</td>'),
    html.replace('R$ 21–27', '$ 21–27'), html.replace('R$ 21–27', 'R$ 19–27'),
    html.replace('novembro', 'setembro'), html.replace('novembro', 'dezembro'), html + html,
    html.replace('21 a R$ 27', '27 a R$ 21').replace('21–27', '27–21'),
  ];
  for (const page of wrongPages) await assert.rejects(collect({ page }), /MilhasBot/);
});

test('accepts a recent Friday close on Monday and rejects stale, future and malformed quotes', async () => {
  const result = await collect({ requestNow: new Date('2026-11-30T14:00:00Z'), rates: [quote('2026-11-27')] });
  assert.equal(result.meta.G3.asOf, '2026-11-27');
  const wrongRates = [[], [quote('2026-11-18')], [quote('2026-11-26')], [quote('2026-11-25', 0)], [quote('2026-11-25', '5.8825')],
    [{ dataHoraCotacao: '2026-11-25 25:35:00.000', cotacaoVenda: 5.9 }], [quote(), quote('2026-11-25', 5.8)],
    [quote('2026-02-30')], [{ ...quote(), cotacaoVenda: undefined, cotacaoCompra: 5.1 }]];
  for (const rates of wrongRates) await assert.rejects(collect({ rates }), /PTAX/);
});

test('rechecking the same fixing during the weekend keeps partner metadata identical', async () => {
  const rates = [quote('2026-11-27')];
  const saturday = await collect({ requestNow: new Date('2026-11-28T14:00:00Z'), rates });
  const sunday = await collect({ requestNow: new Date('2026-11-29T14:00:00Z'), rates, previousMeta: saturday.meta.G3 });
  assert.deepEqual(sunday.meta, saturday.meta);
  assert.notEqual(sunday.evidence.checkedAt, saturday.evidence.checkedAt);
});

test('uses the current Brasília month and the actual quotation timestamp at UTC boundaries', async () => {
  const rates = [quote('2026-11-30')];
  const result = await collect({ requestNow: new Date('2026-12-01T02:00:00Z'), rates });
  assert.equal(result.evidence.editorial.month, '2026-11');
  await assert.rejects(collect({ rates, requestNow: new Date('2026-11-30T16:02:42.418Z') }), /PTAX/);
  const arrived = await collect({ rates, requestNow: new Date('2026-11-30T16:02:42.419Z') });
  assert.equal(arrived.meta.G3.asOf, '2026-11-30');
});

test('allows a prior editorial month through day 35 and caps asOf at the edition end', async () => {
  const rates = [quote('2026-12-04')];
  const inGrace = await collect({ requestNow: new Date('2026-12-06T20:00:00Z'), rates });
  assert.equal(inGrace.evidence.editorial.month, '2026-11');
  assert.equal(inGrace.meta.G3.asOf, '2026-11-30');
  assert.equal(inGrace.evidence.fx.date, '2026-12-04');
  await assert.rejects(collect({ requestNow: new Date('2026-12-07T20:00:00Z'), rates }), /MilhasBot/);
  await assert.rejects(collect({ requestNow: new Date('2026-12-06T20:00:00Z'), rates: [quote('2026-12-03')], previousMeta: inGrace.meta.G3 }), /PTAX/);
});

test('a previous-month issue cannot supersede a newer edition, even if asOf matches', async () => {
  const requestNow = new Date('2026-12-01T11:00:00Z');
  const rates = [quote('2026-11-30')];
  const december = await collect({ page: html.replace('novembro', 'dezembro'), requestNow, rates });
  assert.equal(december.meta.G3.asOf, '2026-11-30');
  await assert.rejects(collect({ requestNow, rates, previousMeta: december.meta.G3 }), /MilhasBot/);
});

test('blocks a regressing FX date and returns no replacement if one independent source fails', async () => {
  const previousMeta = { asOf: '2026-11-25', fxRate: 5.8825, sourceValue: 0.021 };
  await assert.rejects(collect({ previousMeta, rates: [quote('2026-11-24')] }), /PTAX/);
  for (const errorHost of ['olinda.bcb.gov.br', 'www.milhasbot.com.br']) {
    await assert.rejects(collect({ previousMeta, errorHost }), /503/);
  }
  assert.deepEqual(previousMeta, { asOf: '2026-11-25', fxRate: 5.8825, sourceValue: 0.021 });
});
