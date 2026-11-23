#!/usr/bin/env node
// Refresh the US Citi directory from the three public JSON documents its unsigned-in page displays.
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import { validatePartners } from './validate-feed.mjs';

const LANDING = 'https://www.thankyou.com/partnerProgramsListing.htm';
const ROSTER = 'https://www.thankyou.com/partnerProgramsListing-ajax.json';
const RATES = 'https://www.thankyou.com/getPartnerConversionRate-ajax.json';
const LABELS = 'https://staticcontent.thankyou.com/cms/json/webcontents/data/points-transfer/ty/ENG/ANONYMOUS.json';
const PARTNERS = fileURLToPath(new URL('../sample/partners.json', import.meta.url));

// Reviewed IDs keep historical radar names stable. A new or missing partner merits review
// before replacing a published directory with what could also be a partial issuer response.
const AIR = {
  PTXF_FBLUE: 'Air France / KLM Flying Blue', PTXF_AAL: 'American Airlines AAdvantage',
  PTXF_MAVI: 'Avianca LifeMiles', PTXF_Cathay: 'Cathay Pacific Asia Miles',
  PTXF_COPA: 'Copa ConnectMiles', PTXF_MEMI: 'Emirates Skywards', PTXF_ETGUES: 'Etihad Guest',
  PTXF_EINFI: 'EVA Infinity MileageLands', PTXF_JAL: 'Japan Airlines (JAL Mileage Bank)',
  PTXF_JBLUE: 'JetBlue TrueBlue', PTXF_QFFLYS: 'Qantas Frequent Flyer', PTXF_QPRIV: 'Qatar Airways Avios',
  PTXF_SKRIS: 'Singapore KrisFlyer', PTXF_TORCH: 'Thai Airways Royal Orchid Plus',
  PTXF_MTUR: 'Turkish Miles&Smiles', PTXF_VFCLU: 'Virgin Atlantic Flying Club',
};
const HOTEL = {
  PTXF_ALL: 'ALL Accor Live Limitless', PTXF_CH: 'Choice Privileges',
  PTXF_LHW: 'Leading Hotels Leaders Club', PTXF_PH: 'Preferred Hotels I Prefer', PTXF_WR: 'Wyndham Rewards',
};

function requireEvidence(condition, message) {
  if (!condition) throw new Error('Citi public evidence: ' + message);
}

function indexByCode(rows, field) {
  requireEvidence(Array.isArray(rows), 'missing ' + field);
  const indexed = new Map();
  for (const row of rows) {
    const code = row?.[field];
    requireEvidence(typeof code === 'string' && code && !indexed.has(code), 'missing or duplicate ' + field + ': ' + code);
    indexed.set(code, row);
  }
  return indexed;
}

function plainText(html) {
  if (typeof html !== 'string') return '';
  return load(html, null, false).text().replace(/\s+/gu, ' ').trim();
}

function points(s) {
  requireEvidence(typeof s === 'string' && /^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(s), 'invalid point amount ' + s);
  const amount = Number(s.replaceAll(',', ''));
  requireEvidence(Number.isSafeInteger(amount), 'invalid point amount ' + s);
  return amount;
}

function cardGroups(code) {
  const higher = ['TYSTRATAEL', 'CTHNKYUPMC', 'CTHNKYUPSC'];
  const lower = ['ANONYMOUS', 'CTHNKYUPCD', 'CUSTCASH', 'DBLCASH', 'REWARDPLUS'];
  if (code !== 'PTXF_AAL') {
    higher.push('ATTAMORE');
    lower.push('ATTPTPLUS', 'ATTUNIVER', 'CTHNKYUATT');
    if (code !== 'PTXF_JBLUE') lower.push('THKSEARSNF');
  }
  return [higher, lower];
}

function quotedPoints(tier, code) {
  requireEvidence(tier && !tier.oldDisplayPnts && !tier.promotionText, 'missing or promotional card quote for ' + code);
  const source = points(tier.sourceDisplayPnts), target = points(tier.targetDisplayPnts);
  requireEvidence(source === 1000 && tier.conversionRate === target / source, 'inconsistent conversion for ' + code);
  return target;
}

function optionsFor(row, quote, labels) {
  const code = row.partnerCode;
  requireEvidence(quote && plainText(row.programName) && plainText(row.programName) === plainText(quote.partnerName), 'missing or mismatched quote for ' + code);
  requireEvidence(row.isFutureInd === 'N' && !row.offerPercentage && !row.oldDisplayPnts && !row.promotionText, 'future or promotional listing for ' + code);
  const tiers = indexByCode(quote.tierList, 'tierCode');
  const groups = cardGroups(code);
  requireEvidence(tiers.size === groups.flat().length, 'unreviewed or missing card product for ' + code);
  const header = 'pt.landing.page.conversionRate.group-';
  const hasCustomLabels = code === 'PTXF_AAL' || [1, 2].some(i => Object.hasOwn(labels, header + i + '.header.' + code));
  const options = groups.map((group, i) => {
    const amounts = new Set(group.map(product => quotedPoints(tiers.get(product), code + '/' + product)));
    requireEvidence(amounts.size === 1, 'ambiguous rate within card group for ' + code);
    const key = header + (i + 1) + '.header' + (hasCustomLabels ? '.' + code : '');
    const cards = plainText(labels[key]).replace(/[®℠™]/gu, '').replace(/\s+Cardmembers$/u, '');
    requireEvidence(cards, 'missing card eligibility for ' + code);
    return { cards, ratio: '1000:' + [...amounts][0] };
  });
  requireEvidence(options[0].cards !== options[1].cards, 'ambiguous card eligibility for ' + code);
  requireEvidence(points(row.pxGrpInteger) === 1000 && options[1].ratio === '1000:' + points(row.pxTgtInteger),
    'listing and anonymous card quote disagree for ' + code);
  return options;
}

function verifiedCiti(roster, rates, labels) {
  requireEvidence(roster?.hasPrograms && rates && !rates.errorCode && !rates.errorMessage && labels, 'unavailable catalog, rates or eligibility');
  const programs = roster.getMemberEligiblePointExchangeProgramData;
  requireEvidence(Array.isArray(programs?.promoMemberProgramDetails) && !programs.promoMemberProgramDetails.length,
    'review base rates while a partner promotion is listed');
  const rows = indexByCode(programs.memberProgramDetails, 'partnerCode');
  const quotes = indexByCode(rates.partnerDetails, 'partnerCode');
  const directory = { air: [], hotel: [] }, tiers = {};
  const expected = Object.keys(AIR).length + Object.keys(HOTEL).length;
  requireEvidence(rows.size === expected && quotes.size === expected, 'roster or rates incomplete or changed; review added or removed partners');
  for (const [bucket, names] of [['air', AIR], ['hotel', HOTEL]]) {
    for (const [code, name] of Object.entries(names)) {
      const row = rows.get(code);
      requireEvidence(row?.programCatName === (bucket === 'air' ? 'airlines' : 'hotels'), 'missing partner or changed category for ' + code);
      tiers[name] = optionsFor(row, quotes.get(code), labels);
      directory[bucket].push([name, '—']);
    }
  }
  return { directory, tiers };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Citi public source returned HTTP ' + response.status + ' for ' + url);
  return response.json();
}

export async function refreshCitiPartners({ partnersPath = PARTNERS, getJson = fetchJson, now = new Date(), dryRun = false } = {}) {
  const responses = await Promise.all([ROSTER, RATES, LABELS].map(url => getJson(url)));
  const { directory, tiers } = verifiedCiti(...responses);
  const original = readFileSync(partnersPath, 'utf8');
  const doc = JSON.parse(original);
  doc.directory.CITI = directory;
  (doc.ratioTiers ??= {}).CITI = tiers;
  (doc.ratioProvenance ??= {}).CITI = {
    asOf: new Date(now).toISOString().slice(0, 10), source: LANDING,
    note: 'Diretório oficial dos EUA. As taxas por grupo de cartões foram conferidas nas fichas públicas de todos os parceiros.',
  };
  validatePartners(doc);
  const updated = JSON.stringify(doc, null, 2) + '\n';
  if (!dryRun && updated !== original) {
    const temporary = partnersPath + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, updated, { flag: 'wx' });
      renameSync(temporary, partnersPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return { partners: Object.keys(tiers).length, changed: updated !== original };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { partners: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
    const result = await refreshCitiPartners({ partnersPath: values.partners, dryRun: values['dry-run'] });
    console.log('[citi] Verified both card groups for ' + result.partners + ' US transfer partners');
  } catch (error) {
    console.error('[citi] ' + error.message);
    process.exitCode = 1;
  }
}
