import * as cheerio from 'cheerio';

// These are the existing editorial assignments, not a universal market price.
// TPG's shared Avios estimate intentionally applies only to QR/EI/IB here;
// British Airways keeps the project's existing Frequent Miler assignment.
const PROGRAMS = {
  fm: {
    'Air Canada Aeroplan': ['AC'], 'Air France KLM Flying Blue': ['AF'],
    'American AAdvantage': ['AA'], 'Atmos Rewards (Alaska/Hawaiian)': ['AS'],
    'Avianca LifeMiles': ['AV'], 'British Airways Avios': ['BA'],
    'Cathay Pacific Asia Miles': ['CX'], 'Delta SkyMiles': ['DL'],
    'Frontier Bonus Miles': ['F9'], 'JetBlue TrueBlue': ['B6'],
    'Miles & More (Lufthansa)': ['LH'], 'Qantas Frequent Flyer': ['QF'],
    'Southwest Rapid Rewards': ['WN'], 'United MileagePlus': ['UA'],
    'Virgin Atlantic Flying Club': ['VS'],
  },
  tpg: {
    'Aeromexico Rewards': ['AM'], 'ANA Mileage Club': ['NH'], 'Avios': ['QR', 'EI', 'IB'],
    'Emirates Skywards': ['EK'], 'Etihad Guest': ['EY'],
    'Singapore KrisFlyer': ['SQ'], 'Turkish Airlines Miles&Smiles': ['TK'],
  },
};
export const VALUATION_SOURCES = [
  { id: 'fm', url: 'https://frequentmiler.com/reasonable-redemption-values-rrvs/', name: 'Frequent Miler RRV' },
  { id: 'tpg', url: 'https://thepointsguy.com/loyalty-programs/monthly-valuations/', name: 'The Points Guy' },
].map(source => ({ ...source, codes: Object.values(PROGRAMS[source.id]).flat() }));
const clean = text => text.replace(/\s+/g, ' ').trim();

export function parsePointValuations(html, sourceId) {
  const programs = PROGRAMS[sourceId];
  if (!programs) throw new Error('Unknown valuation source: ' + sourceId);
  const $ = cheerio.load(html);
  const tables = $('table').toArray().filter(table => {
    const head = $(table).find('tr').first().find('th,td').map((_, c) => clean($(c).text())).get();
    const correctUnits = sourceId === 'fm' ? head[1] === 'Reasonable Redemption Value'
      : /^[A-Za-z]+ \d{4} valuation \(cents\)$/.test(head[1] ?? '');
    return head[0] === 'Program' && correctUnits && $(table).find('tr').toArray()
      .some(row => programs[clean($(row).find('td').first().text())]);
  });
  if (tables.length !== 1) throw new Error('Expected one recognizable airline valuation table, found ' + tables.length);
  const values = {}, invalid = new Set(), seen = new Set();
  $(tables[0]).find('tr').each((_, row) => {
    const cells = $(row).find('td');
    const codes = programs[clean(cells.eq(0).text())];
    if (!codes) return;
    // TPG appends footnote markers and sometimes '(up/down from X)'. Never
    // parse a range, foreign currency, or a number mentioned in the news cell.
    const match = /^(\d+(?:\.\d+)?)(?:\s*\((?:up|down) from \d+(?:\.\d+)?\))?\*{0,2}$/.exec(clean(cells.eq(1).text()));
    const value = match ? Number(match[1]) : NaN;
    for (const code of codes) {
      if (seen.has(code) || !Number.isFinite(value) || value <= 0) invalid.add(code);
      else values[code] = value;
      seen.add(code);
    }
  });
  for (const code of invalid) delete values[code];
  return { values, missingCodes: Object.values(programs).flat().filter(code => values[code] === undefined) };
}

