import { load } from 'cheerio';
import { fetchPage, PUBLIC_CLIENT_USER_AGENT } from '../fetch-page.mjs';

const EDITORIAL_URL = 'https://www.milhasbot.com.br/valores-do-milheiro/smiles/';
const PTAX_PERIOD = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)';
export const PTAX_SOURCE = 'https://dadosabertos.bcb.gov.br/dataset/dolar-americano-usd-todos-os-boletins-diarios';
const TIME_ZONE = 'America/Sao_Paulo';
const MAX_FX_AGE_DAYS = 5; // Calendar days, to accommodate long weekends and Carnival.
const MAX_EDITION_AGE_DAYS = 35;
const DAY_MS = 86400000;
const MONTHS = 'janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro'.split(' ');
const brlNumber = String.raw`(\d+(?:,\d{1,2})?)`;
const rangeCell = new RegExp(String.raw`^R\$\s*${brlNumber}\s*[-–—]\s*(?:R\$\s*)?${brlNumber}$`);
const redemptionSentence = new RegExp(String.raw`^Pela nossa referência de ([\p{L}]+ de \d{4}), cada 1\.?000 milhas Smiles valem de R\$\s*${brlNumber} a R\$\s*${brlNumber} em resgate\b`, 'u');
const clean = value => value.replace(/\s+/g, ' ').trim();
const parseBrl = value => Number(value.replace(',', '.'));

export function redemptionMonth(label, today) {
  const [monthName, year] = label.split(' de ');
  const monthNumber = MONTHS.indexOf(monthName) + 1;
  const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
  const ageDays = (Date.parse(today) - Date.parse(`${month}-01`)) / DAY_MS;
  if (!monthNumber || !Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_EDITION_AGE_DAYS) {
    throw new Error(`future, stale or unreadable redemption reference: ${label}`);
  }
  return month;
}

function editorialRange(html, today, previousMeta) {
  const $ = load(html);
  const candidates = [];
  for (const table of $('table').toArray()) {
    const headers = $(table).find('thead th').toArray().map(cell => clean($(cell).text()));
    if (headers.length !== 2 || headers[0] !== 'Milhas Smiles' || headers[1] !== 'Quanto vale em reais') continue;
    for (const row of $(table).find('tbody tr').toArray()) {
      const cells = $(row).children('td');
      if (cells.length === 2 && /^1\.?000 milhas$/.test(clean(cells.eq(0).text()))) {
        candidates.push({ cell: clean(cells.eq(1).text()), caption: clean($(table).prev('p').text()) });
      }
    }
  }
  if (candidates.length !== 1) throw new Error('missing or ambiguous 1,000-mile Smiles redemption row');
  const { cell, caption } = candidates[0];
  const quoted = redemptionSentence.exec(caption), row = rangeCell.exec(cell);
  if (!quoted || !row) throw new Error('missing dated BRL redemption range for 1,000 Smiles miles');
  const month = redemptionMonth(quoted[1], today);
  // Older partner contracts store the source dates in note. Reading the two
  // dates independently prevents an old cached page from undoing a newer one.
  const previousMonth = /MilhasBot's (\d{4}-\d{2}) airfare redemption range/.exec(previousMeta?.note)?.[1];
  if (previousMonth && month < previousMonth) throw new Error(`redemption reference predates stored edition ${previousMonth}`);
  const low = parseBrl(row[1]), high = parseBrl(row[2]);
  if (!(low > 0 && high >= low && Number.isFinite(high)) || low !== parseBrl(quoted[2]) || high !== parseBrl(quoted[3])) {
    throw new Error('invalid range or conflicting BRL redemption figures');
  }
  return { url: EDITORIAL_URL, month, rangeBrlPer1000: [low, high] };
}

function ptaxUrl(startDay, endDay) {
  const format = iso => `'${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}'`;
  const url = new URL(PTAX_PERIOD);
  url.search = new URLSearchParams({ '@dataInicial': format(startDay), '@dataFinalCotacao': format(endDay),
    '$format': 'json', '$select': 'cotacaoVenda,dataHoraCotacao' });
  return url.href;
}

function latestPtax(body, url, localNow, startDay, previousMeta) {
  const data = JSON.parse(body);
  if (!/\/odata\$metadata#_?CotacaoDolarPeriodo\(/.test(data?.['@odata.context']) || !Array.isArray(data.value) || data['@odata.nextLink']) {
    throw new Error('expected the complete BCB daily USD closing series');
  }
  const eligible = [];
  for (const row of data.value) {
    const stamp = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(row?.dataHoraCotacao);
    const day = stamp?.[1], dayMs = day ? Date.parse(day) : NaN;
    if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== day || !Number.isFinite(row.cotacaoVenda) || row.cotacaoVenda <= 0) {
      throw new Error('invalid daily USD selling rate or Brasília timestamp');
    }
    const localStamp = `${day} ${stamp[2]}:${stamp[3]}:${stamp[4]}.${(stamp[5] ?? '').padEnd(6, '0')}`;
    if (localStamp <= localNow && day >= startDay) eligible.push({ date: day, timestampBrasilia: localStamp, brlPerUsd: row.cotacaoVenda });
  }
  eligible.sort((a, b) => b.date.localeCompare(a.date));
  const latest = eligible[0];
  if (!latest) throw new Error(`no published quote within ${MAX_FX_AGE_DAYS} days of the check`);
  if (eligible[1]?.date === latest.date) throw new Error('ambiguous daily USD closing rate');
  const previousFxDate = /BRL per USD on (\d{4}-\d{2}-\d{2})/.exec(previousMeta?.note)?.[1] ?? previousMeta?.asOf;
  if (previousFxDate && latest.date < previousFxDate) throw new Error(`quote ${latest.date} predates stored PTAX ${previousFxDate}`);
  return { url, ...latest };
}

export async function sourceResult(label, url, fetchImpl, parse) {
  try {
    const body = await fetchPage(url, { fetcher: fetchImpl, tries: 1, headers: { 'User-Agent': PUBLIC_CLIENT_USER_AGENT } });
    return parse(body);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
}

export function brasiliaTimestamp(now) {
  // Olinda stamps are Brasília wall time. Compare in the same zone, including
  // microseconds, so a quote from later today cannot enter an earlier run.
  return now.toLocaleString('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' }).replace(',', '.') + '000';
}

export function collectPtax(localNow, fetchImpl, previousMeta) {
  const today = localNow.slice(0, 10);
  const startDay = new Date(Date.parse(today) - MAX_FX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const url = ptaxUrl(startDay, today);
  return sourceResult('BCB PTAX', url, fetchImpl, body => latestPtax(body, url, localNow, startDay, previousMeta));
}

export function conversionDate(month, fxDate, today) {
  // A new fixing must not extend the publisher's prior monthly edition.
  const priorMonthEnd = new Date(Date.parse(`${today.slice(0, 7)}-01`) - DAY_MS).toISOString().slice(0, 10);
  return month < today.slice(0, 7) && fxDate > priorMonthEnd ? priorMonthEnd : fxDate;
}

async function collectSmilesValuation({ fetchImpl = fetch, now = new Date(), previousMeta } = {}) {
  const localNow = brasiliaTimestamp(now), today = localNow.slice(0, 10);
  const [editorial, fx] = await Promise.all([
    sourceResult('MilhasBot', EDITORIAL_URL, fetchImpl, body => editorialRange(body, today, previousMeta)),
    collectPtax(localNow, fetchImpl, previousMeta),
  ]);
  const [low, high] = editorial.rangeBrlPer1000;
  const asOf = conversionDate(editorial.month, fx.date, today);
  if (previousMeta?.asOf && asOf < previousMeta.asOf) throw new Error(`MilhasBot: combined evidence predates stored asOf ${previousMeta.asOf}`);
  const sourceValue = low / 1000;
  const value = Number((sourceValue * 100 / fx.brlPerUsd).toFixed(2));
  if (!Number.isFinite(value) || value <= 0) throw new Error('Smiles conversion produced an invalid USD cents estimate');
  return {
    values: { G3: value }, missingCodes: [],
    meta: { G3: { currency: 'BRL', asOf, sourceCurrency: 'BRL', sourceValue, fxRate: fx.brlPerUsd,
      note: `Lower bound of MilhasBot's ${editorial.month} airfare redemption range of BRL ${low} to ${high} per 1,000 Smiles miles. Converted to US cents per mile at Banco Central do Brasil's selling USD/BRL PTAX of ${fx.brlPerUsd} BRL per USD on ${fx.date} (${PTAX_SOURCE}).` } },
    evidence: { checkedAt: now.toISOString(), editorial, fx },
  };
}

export const SMILES_VALUATION_SOURCE = { id: 'milhasbot-smiles', name: 'MilhasBot', url: EDITORIAL_URL, codes: ['G3'], collect: collectSmilesValuation };
