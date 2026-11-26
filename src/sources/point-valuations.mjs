import * as cheerio from 'cheerio';

// The four publishers either name Avios directly or publish a British Airways
// row. Every club uses that one base observation from a given publisher.
export const AVIOS_CODES = ['BA', 'IB', 'EI', 'QR', 'AY'];
const PROGRAMS = {
  fm: {
    'Air Canada Aeroplan': 'AC', 'Air France KLM Flying Blue': 'AF',
    'American AAdvantage': 'AA', 'Atmos Rewards (Alaska/Hawaiian)': 'AS',
    'Avianca LifeMiles': 'AV', 'British Airways Avios': AVIOS_CODES,
    'Cathay Pacific Asia Miles': 'CX', 'Delta SkyMiles': 'DL',
    'Frontier Bonus Miles': 'F9', 'JetBlue TrueBlue': 'B6',
    'Miles & More (Lufthansa)': 'LH', 'Qantas Frequent Flyer': 'QF',
    'Southwest Rapid Rewards': 'WN', 'United MileagePlus': 'UA',
    'Virgin Atlantic Flying Club': 'VS',
  },
  tpg: {
    'Aeromexico Rewards': 'AM', 'Air Canada Aeroplan': 'AC', 'Alaska Airlines Atmos Rewards': 'AS',
    'American Airlines AAdvantage': 'AA', 'ANA Mileage Club': 'NH', 'Avianca Lifemiles': 'AV',
    'Avios': AVIOS_CODES, 'Cathay Asia Miles': 'CX', 'Delta SkyMiles': 'DL',
    'Emirates Skywards': 'EK', 'Etihad Guest': 'EY', 'Flying Blue': 'AF', 'Frontier Miles': 'F9',
    'JetBlue TrueBlue': 'B6', 'Qantas Frequent Flyer': 'QF', 'Singapore KrisFlyer': 'SQ',
    'Southwest Rapid Rewards': 'WN', 'Turkish Airlines Miles&Smiles': 'TK',
    'United MileagePlus': 'UA', 'Virgin Atlantic Flying Club': 'VS',
  },
};
export const VALUATION_SOURCES = [
  { id: 'fm', url: 'https://frequentmiler.com/reasonable-redemption-values-rrvs/', name: 'Frequent Miler RRV', maxAgeDays: 90 },
  { id: 'tpg', url: 'https://thepointsguy.com/loyalty-programs/monthly-valuations/', name: 'The Points Guy', maxAgeDays: 35 },
].map(source => ({ ...source, codes: Object.values(PROGRAMS[source.id]).flat() }));
const clean = text => text.replace(/\s+/g, ' ').trim();

export function validPublisherDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return undefined;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().startsWith(value + 'T') ? value : undefined;
}

export function articleModifiedDate($) {
  const meta = $('meta[property="article:modified_time"]');
  if (meta.length !== 1) return undefined;
  const date = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(meta.attr('content') ?? '');
  return validPublisherDate(date?.[1]);
}

const months = 'January February March April May June July August September October November December'.split(' ');
export function monthlyEdition(header, suffix) {
  if (!header.endsWith(suffix)) return undefined;
  const parts = /^([A-Z][a-z]+) (\d{4})$/.exec(header.slice(0, -suffix.length));
  if (!parts || !months.includes(parts[1])) return undefined;
  // The table identifies the edition by month, without an exact valuation day.
  return `${parts[2]}-${String(months.indexOf(parts[1]) + 1).padStart(2, '0')}-01`;
}

function tableDiagnostics($, tables, matchingTableCount, htmlCharacters) {
  // Only public labels and valuation cells: no article/news text, links,
  // scripts, request headers, or raw document. Bound remote layout failures.
  const summaries = tables.slice(0,30).map((table, index) => {
    const header = $(table).find('tr').first().find('th,td').toArray()
      .slice(0,2).map(cell => clean($(cell).text()).slice(0,120));
    const rows = $(table).find('tr').toArray().filter(row => $(row).find('td').length > 0);
    return { index, header, rowCount: rows.length, rows: rows.slice(0,60).map(row => {
      const cells = $(row).find('td');
      return { program: clean(cells.eq(0).text()).slice(0,120), valuation: clean(cells.eq(1).text()).slice(0,120) };
    }) };
  });
  return { htmlCharacters, tableCount: tables.length, matchingTableCount, tables: summaries };
}

export function parsePointValuations(html, sourceId) {
  const programs = PROGRAMS[sourceId];
  if (!Object.hasOwn(PROGRAMS, sourceId)) throw new Error('Unknown valuation source: ' + sourceId);
  const $ = cheerio.load(html);
  const allTables = $('table').toArray();
  const tables = allTables.filter(table => {
    const head = $(table).find('tr').first().find('th,td').map((_, c) => clean($(c).text())).get();
    const correctUnits = sourceId === 'fm' ? head[1] === 'Reasonable Redemption Value'
      : monthlyEdition(head[1] ?? '', ' valuation (cents)');
    return head[0] === 'Program' && correctUnits && $(table).find('tr').toArray()
      .some(row => Object.hasOwn(programs, clean($(row).find('td').first().text())));
  });
  const diagnostics = () => tableDiagnostics($, allTables, tables.length, html.length);
  if (tables.length !== 1) {
    const error = new Error('Expected one recognizable airline valuation table, found ' + tables.length);
    error.diagnostics = diagnostics();
    throw error;
  }
  const head = $(tables[0]).find('tr').first().children('td,th');
  const asOf = sourceId === 'fm' ? articleModifiedDate($) : monthlyEdition(clean(head.eq(1).text()), ' valuation (cents)');
  const values = {}, dates = {}, invalid = new Set(), seen = new Set();
  $(tables[0]).find('tr').each((_, row) => {
    const cells = $(row).find('td');
    const program = clean(cells.eq(0).text());
    if (!asOf || !Object.hasOwn(programs, program)) return;
    const codes = programs[program];
    // TPG appends footnote markers and sometimes '(up/down from X)'. Never
    // parse a range, foreign currency, or a number mentioned in the news cell.
    const match = /^(\d+(?:\.\d+)?)(?:\s*\((?:up|down) from \d+(?:\.\d+)?\))?\*{0,2}$/.exec(clean(cells.eq(1).text()));
    const value = match ? Number(match[1]) : NaN;
    for (const code of Array.isArray(codes) ? codes : [codes]) {
      if (seen.has(code) || !Number.isFinite(value) || value <= 0) invalid.add(code);
      else values[code] = value;
      seen.add(code);
    }
  });
  for (const code of invalid) delete values[code];
  for (const code of Object.keys(values)) dates[code] = asOf;
  const missingCodes = Object.values(programs).flat().filter(code => values[code] === undefined);
  return { values, dates, missingCodes, ...(missingCodes.length ? { diagnostics: diagnostics() } : {}) };
}
