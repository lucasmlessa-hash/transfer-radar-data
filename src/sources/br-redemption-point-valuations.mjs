import { load } from 'cheerio';
import { brasiliaTimestamp, collectPtax, conversionDate, PTAX_SOURCE, redemptionMonth, sourceResult } from './smiles-point-valuation.mjs';

const URL = 'https://www.milhasbot.com.br/valores-do-milheiro/';
const PROGRAMS = new Map([['LATAM Pass', 'LA'], ['Azul Fidelidade', 'AD'], ['TAP Miles&Go', 'TP']]);
const codes = [...PROGRAMS.values()];
const clean = text => text.replace(/\s+/g, ' ').trim();
const number = value => Number(value.replace(',', '.'));

function redemptionTable(html, today) {
  const $ = load(html);
  const tables = $('table').toArray().filter(table => {
    const headers = $(table).find('thead th').toArray().map(cell => clean($(cell).text()));
    return headers.length === 2 && headers[0] === 'Programa' && headers[1] === 'Valor de uso (faixa)';
  });
  if (tables.length !== 1) throw new Error('expected one airfare redemption range table');
  const table = $(tables[0]);
  const title = clean(table.prevAll('h2').first().text());
  const edition = /^Valor de uso por programa \(([\p{L}]+ de \d{4})\)$/u.exec(title)?.[1];
  const caption = clean(table.next('p').text());
  if (!edition || !caption.startsWith('Referência de ' + edition + ', em reais por milheiro')
    || !/uso típico \(ponta de baixo\)/i.test(caption)) throw new Error('missing dated BRL range with a typical redemption floor');
  const month = redemptionMonth(edition, today);
  const ranges = {}, seen = new Set();
  for (const row of table.find('tbody tr').toArray()) {
    const cells = $(row).children('th,td');
    const code = PROGRAMS.get(clean(cells.eq(0).text()));
    if (!code) continue;
    if (seen.has(code)) { delete ranges[code]; continue; }
    seen.add(code);
    const match = /^R\$\s*(\d+(?:,\d{1,2})?)\s+a\s+(?:R\$\s*)?(\d+(?:,\d{1,2})?)\s*\/\s*milheiro$/.exec(clean(cells.eq(1).text()));
    if (cells.length !== 2 || !match) continue;
    const low = number(match[1]), high = number(match[2]);
    if (low > 0 && high >= low && Number.isFinite(high)) ranges[code] = [low, high];
  }
  return { url: URL, month, rangesBrlPer1000: ranges };
}

async function collect({ fetchImpl = fetch, now = new Date(), previousMeta } = {}) {
  const localNow = brasiliaTimestamp(now), today = localNow.slice(0, 10);
  const prior = previousMeta?.source === URL ? previousMeta : undefined;
  const [editorial, fx] = await Promise.all([
    sourceResult('MilhasBot', URL, fetchImpl, html => redemptionTable(html, today)),
    collectPtax(localNow, fetchImpl, prior),
  ]);
  const previousMonth = /MilhasBot's (\d{4}-\d{2}) airfare redemption range/.exec(prior?.note)?.[1];
  if (previousMonth && editorial.month < previousMonth) throw new Error('MilhasBot: edition predates stored redemption reference');
  const dates = {}, values = {}, meta = {};
  const asOf = conversionDate(editorial.month, fx.date, today);
  for (const [code, [low, high]] of Object.entries(editorial.rangesBrlPer1000)) {
    const sourceValue = low / 1000;
    const value = Number((sourceValue * 100 / fx.brlPerUsd).toFixed(6));
    if (!(value > 0 && Number.isFinite(value))) continue;
    dates[code] = editorial.month + '-01';
    values[code] = value;
    meta[code] = { currency: 'BRL', source: URL, asOf, sourceCurrency: 'BRL', sourceValue, fxRate: fx.brlPerUsd,
      note: `Lower bound of MilhasBot's ${editorial.month} airfare redemption range of BRL ${low} to ${high} per 1,000 miles. Converted to US cents per mile at Banco Central do Brasil's selling USD/BRL PTAX of ${fx.brlPerUsd} BRL per USD on ${fx.date} (${PTAX_SOURCE}).` };
  }
  return { values, dates, meta, missingCodes: codes.filter(code => !(code in values)),
    evidence: { checkedAt: now.toISOString(), editorial, fx } };
}

export const BR_REDEMPTION_SOURCE = { id: 'milhasbot-br', name: 'MilhasBot', url: URL, codes, maxAgeDays: 35, collect };
