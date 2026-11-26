import { load } from 'cheerio';
import { articleModifiedDate, AVIOS_CODES, monthlyEdition, validPublisherDate } from './point-valuations.mjs';

const UP_PROGRAMS = {
  'Air Canada Aeroplan points': 'AC', 'Air France-KLM Flying Blue miles': 'AF',
  'Alaska Airlines Atmos Rewards points': 'AS', 'American Airlines AAdvantage miles': 'AA',
  'All Nippon Airways (ANA) Mileage Club miles': 'NH', 'Avianca Airlines Lifemiles': 'AV',
  'British Airways Club Avios': AVIOS_CODES, 'Cathay Pacific Cathay Asia miles': 'CX',
  'Delta Air Lines SkyMiles': 'DL', 'Emirates Skywards miles': 'EK', 'Etihad Airways Etihad Guest miles': 'EY',
  'Frontier Airlines FRONTIER miles': 'F9', 'Japan Airlines miles': 'JL', 'JetBlue TrueBlue points': 'B6',
  'Lufthansa Miles & More miles': 'LH', 'Singapore Airlines KrisFlyer miles': 'SQ',
  'Southwest Airlines Rapid Rewards points': 'WN', 'Turkish Airlines Miles&Smiles miles': 'TK',
  'United Airlines MileagePlus miles': 'UA', 'Virgin Atlantic Flying Club Virgin Points': 'VS',
};
const OMAAT_PROGRAMS = {
  'Air Canada Aeroplan points': 'AC', 'Air France-KLM Flying Blue miles': 'AF',
  'Alaska Atmos Rewards points': 'AS', 'All Nippon Airways Mileage Club miles': 'NH',
  'American AAdvantage miles': 'AA', 'Avianca Lifemiles miles': 'AV',
  'British Airways Club Avios': AVIOS_CODES, 'Cathay Pacific Asia Miles miles': 'CX',
  'Delta SkyMiles miles': 'DL', 'Emirates Skywards miles': 'EK', 'Etihad Guest miles': 'EY',
  'Japan Airlines Mileage Bank miles': 'JL', 'JetBlue TrueBlue points': 'B6',
  'Lufthansa Miles & More miles': 'LH', 'Singapore Airlines KrisFlyer miles': 'SQ',
  'Southwest Rapid Rewards points': 'WN', 'Turkish Airlines Miles&Smiles miles': 'TK',
  'United MileagePlus miles': 'UA', 'Virgin Atlantic Flying Club points': 'VS',
};
export const ADDITIONAL_VALUATION_SOURCES = [
  { id: 'upgraded-points', url: 'https://upgradedpoints.com/travel/points-and-miles-valuations/', name: 'Upgraded Points', maxAgeDays: 35, codes: Object.values(UP_PROGRAMS).flat() },
  { id: 'omaat', url: 'https://onemileatatime.com/guides/value-miles-points/', name: 'One Mile at a Time', maxAgeDays: 90, codes: Object.values(OMAAT_PROGRAMS).flat() },
  { id: 'points-frog-copa', url: 'https://www.pointsfrog.com/points-value/connectmiles', name: 'Points Frog', maxAgeDays: 90, codes: ['CM'] },
];
const clean = text => text.replace(/\s+/g, ' ').trim();

function airlineTable($, id) {
  const isUP = id === 'upgraded-points';
  const matches = $('table').toArray().filter(table => {
    const head = $(table).find('tr').first().children('td,th').map((_, cell) => clean($(cell).text())).get();
    if (isUP) {
      return head.length === 4 && head[0] === 'Airline Loyalty Program'
        && monthlyEdition(head[1], ' Value (cents/point)')
        && head[2] === 'Value of 50K Points' && head[3] === 'Value of 100K Points';
    }
    return head.length === 2 && head[0] === 'Airline program rewards currency' && head[1] === 'Value of airline points currency';
  });
  if (matches.length !== 1) return {};
  const rows = $(matches[0]).find('tr');
  const asOf = isUP ? monthlyEdition(clean(rows.first().children().eq(1).text()), ' Value (cents/point)') : articleModifiedDate($);
  if (!asOf) return {};
  const programs = isUP ? UP_PROGRAMS : OMAAT_PROGRAMS, matched = {}, seen = new Set();
  for (const row of rows.toArray()) {
    const cells = $(row).children('td'), label = clean(cells.eq(0).text());
    if (!Object.hasOwn(programs, label)) continue;
    const codes = programs[label];
    const pattern = isUP ? /^(\d+(?:\.\d+)?)$/ : Array.isArray(codes)
      ? /^(\d+(?:\.\d+)?) cents? per Avios$/ : /^(\d+(?:\.\d+)?) cents? per (?:mile|point)$/;
    const cell = clean(cells.eq(1).text());
    const value = cells.length === (isUP ? 4 : 2) ? Number(cell.match(pattern)?.[1]) : NaN;
    for (const code of Array.isArray(codes) ? codes : [codes]) {
      if (seen.has(code)) delete matched[code];
      else if (Number.isFinite(value) && value > 0) matched[code] = value;
      seen.add(code);
    }
  }
  return { matched, asOf };
}

function copaObservation($) {
  const heading = $('main h1');
  if (heading.length !== 1 || clean(heading.text()) !== 'Copa Airlines ConnectMiles') return {};
  const section = $('main h2').filter((_, node) => clean($(node).text()) === 'How much are Copa Airlines ConnectMiles worth?');
  if (section.length !== 1) return {};
  const update = $('main p > time[datetime]').filter((_, time) => clean($(time).parent().text()) === 'Value updated ' + clean($(time).text()));
  const asOf = update.length === 1 ? validPublisherDate(update.attr('datetime')) : undefined;
  const paragraph = section.next('div').children('p').first();
  const match = clean(paragraph.text()).match(
    /^Copa Airlines ConnectMiles have an estimated average redemption value of (\d+(?:\.\d+)?) US cents per unit in Points Frog[’']s valuation catalog\./,
  );
  const value = Number(match?.[1]);
  return asOf && Number.isFinite(value) && value > 0 ? { matched: { CM: value }, asOf } : {};
}

export function parseAdditionalPointValuations(html, sourceId) {
  const source = ADDITIONAL_VALUATION_SOURCES.find(item => item.id === sourceId);
  if (!source) throw new Error('Unknown valuation source: ' + sourceId);
  const $ = load(html);
  const { matched: values = {}, asOf } = sourceId === 'points-frog-copa' ? copaObservation($) : airlineTable($, sourceId);
  const dates = Object.fromEntries(Object.keys(values).map(code => [code, asOf]));
  return { values, dates, missingCodes: source.codes.filter(code => !Object.hasOwn(values, code)) };
}
