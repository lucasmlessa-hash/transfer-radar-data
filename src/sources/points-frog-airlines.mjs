import { load } from 'cheerio';

// The global ranking does not distinguish country-specific Brazilian accounts.
// Those programs use their local redemption references. Copa has a dedicated
// dated page from this same publisher. Only the British row represents Avios.
const programs = {
  'mileage-plan':'AS', aeroplan:'AC', aadvantage:'AA', 'ana-mileage-club':'NH',
  lifemiles:'AV', 'infinity-mileagelands':'BR', 'flying-club':'VS', 'flying-blue':'AF',
  'jal-mileage-bank':'JL', trueblue:'B6', 'miles-and-more':'LH', krisflyer:'SQ',
  'british-airways-club':'BA', 'rapid-rewards':'WN', mileageplus:'UA', 'asia-miles':'CX',
  skymiles:'DL', skywards:'EK', 'etihad-guest':'EY', 'qantas-frequent-flyer':'QF',
  'miles-and-smiles':'TK', 'frontier-miles':'F9', eurobonus:'SK', 'royal-orchid-plus':'TG',
  'aeromexico-rewards':'AM', 'miles-and-go':'TP', enrich:'MH', 'maharaja-club':'AI',
  'fortune-wings-club':'HU', lotusmiles:'VN',
};
const codes = Object.values(programs);
const clean = text => text.replace(/\s+/g,' ').trim();

function parseRanking(html) {
  const $ = load(html);
  const main = $('main');
  const date = main.find('time[datetime]').attr('datetime');
  const table = main.find('table').filter((_,node) =>
    $(node).find('thead th').map((_,th)=>clean($(th).text())).get().join('|') === '#|Program|Per point|50,000 worth');
  if (main.length !== 1 || clean(main.find('h1').text()) !== 'The most valuable airline miles' || table.length !== 1 ||
      main.find('time[datetime]').length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0,10) !== date || !main.find('p').first().text().includes('estimated redemption value per point')) {
    throw new Error('Unrecognized dated Points Frog airline redemption ranking');
  }
  const values = {}, dates = {}, seen = new Set();
  for (const row of table.find('tbody tr')) {
    const link = $(row).find('th[scope="row"] a');
    const slug = /^\/points-value\/([a-z0-9-]+)$/.exec(link.attr('href') ?? '')?.[1];
    const code = programs[slug];
    if (!code) continue;
    const value = /^(\d+(?:\.\d+)?)¢ per (mile|point|Avios)$/.exec(clean($(row).children('td').eq(1).text()));
    if (seen.has(code) || !value || link.length !== 1 || Number(value[1]) <= 0 || (code === 'BA' && value[2] !== 'Avios')) {
      delete values[code]; delete dates[code];
    } else {
      values[code] = Number(value[1]); dates[code] = date;
    }
    seen.add(code);
  }
  return {values, dates, missingCodes:codes.filter(code => !Object.hasOwn(values,code))};
}
export const POINTS_FROG_AIRLINES = {id:'points-frog-airlines',name:'Points Frog',
  url:'https://www.pointsfrog.com/best-points-programs/airline-miles',codes,maxAgeDays:90,parse:parseRanking};
