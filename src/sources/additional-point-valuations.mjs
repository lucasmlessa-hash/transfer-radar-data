import { load } from 'cheerio';

export const ADDITIONAL_VALUATION_SOURCES = [
  { id: 'upgraded-points', url: 'https://upgradedpoints.com/travel/points-and-miles-valuations/', name: 'Upgraded Points', codes: ['JL', 'ACCOR'] },
  { id: 'omaat', url: 'https://onemileatatime.com/guides/value-miles-points/', name: 'One Mile at a Time', codes: ['AY'] },
  { id: 'points-frog-copa', url: 'https://www.pointsfrog.com/points-value/connectmiles', name: 'Points Frog', codes: ['CM'] },
];

const clean = text => text.replace(/\s+/g, ' ').trim();
const monthlyValue = /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4} Value \(cents\/point\)$/;
const upgradedHeaders = program => [program, monthlyValue, 'Value of 50K Points', 'Value of 100K Points'];

function tableValue($, headers, label, pattern) {
  const tables = $('table').filter((_, table) => {
    const cells = $(table).find('tr').first().children('td,th');
    return cells.length === headers.length && headers.every((expected, column) => {
      const name = clean(cells.eq(column).text());
      return typeof expected === 'string' ? name === expected : expected.test(name);
    });
  });
  if (tables.length !== 1) return undefined;
  const rows = tables.find('tr').filter((_, row) => clean($(row).children().first().text()) === label);
  const cells = rows.children('td');
  if (rows.length !== 1 || cells.length !== headers.length) return undefined;
  return clean(cells.eq(1).text()).match(pattern)?.[1];
}

function copaValue($) {
  const heading = $('main h1');
  if (heading.length !== 1 || clean(heading.text()) !== 'Copa Airlines ConnectMiles') return undefined;
  const section = $('main h2').filter((_, node) => clean($(node).text()) === 'How much are Copa Airlines ConnectMiles worth?');
  if (section.length !== 1) return undefined;
  const paragraph = section.next('div').children('p').first();
  return clean(paragraph.text()).match(
    /^Copa Airlines ConnectMiles have an estimated average redemption value of (\d+(?:\.\d+)?) US cents per unit in Points Frog[’']s valuation catalog\./,
  )?.[1];
}

export function parseAdditionalPointValuations(html, sourceId) {
  const source = ADDITIONAL_VALUATION_SOURCES.find(item => item.id === sourceId);
  if (!source) throw new Error('Unknown valuation source: ' + sourceId);
  const $ = load(html);
  let matched;
  if (sourceId === 'upgraded-points') {
    const cents = /^(\d+(?:\.\d+)?)$/;
    matched = {
      JL: tableValue($, upgradedHeaders('Airline Loyalty Program'), 'Japan Airlines miles', cents),
      ACCOR: tableValue($, upgradedHeaders('Hotel Loyalty Program'), 'ALL – Accor Live Limitless Reward points', cents),
    };
  } else if (sourceId === 'omaat') {
    matched = {
      AY: tableValue($, ['Airline program rewards currency', 'Value of airline points currency'],
        'Finnair Plus Avios', /^(\d+(?:\.\d+)?) cents? per Avios$/),
    };
  } else {
    matched = { CM: copaValue($) };
  }
  const values = {};
  for (const code of source.codes) {
    const number = Number(matched[code]);
    if (Number.isFinite(number) && number > 0) values[code] = number;
  }
  return { values, missingCodes: source.codes.filter(code => !Object.hasOwn(values, code)) };
}
