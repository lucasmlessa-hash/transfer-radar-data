// Raw name -> canonical code lookups for the 8 banks and 12 airline/partner
// codes this pipeline knows about (see CONTRACT.md / sample/partners.json).
//
// ponytail: flat alias lists, one map per axis. No fuzzy matching, no NLP —
// when a source uses a name variant we don't recognize yet, it lands in
// normalize()'s `unmapped` list instead of silently failing, and extending
// the arrays below is the fix (see GO-LIVE.md step 3).

const BANK_ALIASES = {
  AMEX: ['amex', 'american express', 'membership rewards', 'amex mr', 'amex membership rewards', 'american express membership rewards'],
  CHASE: ['chase', 'chase ultimate rewards', 'ultimate rewards', 'chase ur'],
  CITI: ['citi', 'citibank', 'citi thankyou', 'citi thankyou rewards', 'thankyou rewards', 'citi thankyou points'],
  C1: ['capital one', 'cap one', 'capital one miles', 'c1'],
  BILT: ['bilt', 'bilt rewards'],
  WF: ['wells fargo', 'wells fargo rewards', 'wells'],
  ESF: ['esfera', 'banco do brasil esfera', 'bb esfera'],
  LIV: ['livelo', 'livelo pontos'],
  ROVE: ['rove', 'rove miles', 'rove rewards'],
};

export const PARTNER_ALIASES = {
  AF: ['air france', 'air france klm', 'air france / klm flying blue', 'air france/klm flying blue', 'flying blue', 'klm'],
  AV: ['avianca', 'avianca lifemiles', 'lifemiles'],
  AM: ['aeromexico', 'aeromexico rewards', 'aeromexico club premier'],
  VS: ['virgin atlantic', 'virgin atlantic flying club', 'flying club'],
  QR: ['qatar airways', 'qatar airways avios', 'qatar avios', 'qatar privilege club', 'qatar privilege club avios', 'qatar airways privilege club'],
  BA: ['british airways', 'british airways avios', 'ba avios'],
  EI: ['aer lingus', 'aer lingus aerclub', 'aerclub', 'aer lingus avios'],
  CX: ['cathay pacific', 'cathay pacific asia miles', 'asia miles'],
  NH: ['ana', 'ana mileage club', 'all nippon airways'],
  G3: ['gol', 'smiles', 'smiles (gol)'],
  LA: ['latam', 'latam pass'],
  AD: ['azul', 'azul fidelidade', 'tudoazul'],
  // Codes below cover names the live sources actually return today but the
  // 12-code model dropped into `unmapped`. Each also needs an entry in
  // partners.json's airlineDomains + airlineValues (see CONTRACT.md).
  BR: ['eva', 'eva air', 'eva airways', 'infinity mileagelands', 'eva air infinity mileagelands', 'eva infinity mileagelands'],
  QF: ['qantas', 'qantas frequent flyer'],
  JL: ['jal', 'jmb', 'japan airlines', 'japan airlines mileage bank', 'jal mileage bank', 'jal (japan airlines) mileage bank'],
  LH: ['lufthansa', 'miles and more', 'miles more', 'lufthansa miles and more', 'lufthansa miles more'],
  AS: ['alaska', 'alaska airlines', 'atmos rewards', 'alaska atmos rewards', 'alaska mileage plan', 'mileage plan'],
  AA: ['american', 'american airlines', 'aadvantage', 'american aadvantage', 'american airlines aadvantage'],
  AC: ['air canada', 'aeroplan', 'air canada aeroplan'],
  TK: ['turkish', 'turkish airlines', 'miles smiles', 'turkish miles smiles', 'turkish airlines miles & smiles'],
  EK: ['emirates', 'skywards', 'emirates skywards'],
  SQ: ['singapore', 'singapore airlines', 'krisflyer', 'singapore krisflyer'],
  UA: ['united', 'united airlines', 'united mileageplus', 'mileageplus'],
  B6: ['jetblue', 'jetblue airways', 'jetblue trueblue', 'trueblue'],
  EY: ['etihad', 'etihad airways', 'etihad guest'],
  IB: ['iberia', 'iberia plus', 'iberia avios', 'iberia club'],
  CM: ['copa', 'copa airlines', 'connectmiles', 'connect miles', 'copa connectmiles', 'copa connect miles', 'copa airlines connectmiles'],
  TP: ['tap', 'tap air portugal', 'tap portugal', 'miles&go', 'tap miles&go', 'tap miles & go', 'tap miles and go', 'miles and go'],
};

// Display name used for a route's `airline` field when no seed route already
// supplies one (see normalize.mjs's seed lookup).
const PARTNER_DISPLAY_NAMES = {
  AF: 'Air France / KLM Flying Blue',
  AV: 'Avianca LifeMiles',
  AM: 'Aeromexico Rewards',
  VS: 'Virgin Atlantic Flying Club',
  QR: 'Qatar Airways Avios',
  BA: 'British Airways Avios',
  EI: 'Aer Lingus AerClub',
  CX: 'Cathay Pacific Asia Miles',
  NH: 'ANA Mileage Club',
  G3: 'Smiles (GOL)',
  LA: 'LATAM Pass',
  AD: 'Azul Fidelidade',
  BR: 'EVA Infinity MileageLands',
  QF: 'Qantas Frequent Flyer',
  JL: 'Japan Airlines (JAL Mileage Bank)',
  LH: 'Lufthansa Miles & More',
  AS: 'Alaska Atmos Rewards',
  AA: 'American Airlines AAdvantage',
  AC: 'Air Canada Aeroplan',
  TK: 'Turkish Miles&Smiles',
  EK: 'Emirates Skywards',
  SQ: 'Singapore KrisFlyer',
  UA: 'United MileagePlus',
  B6: 'JetBlue TrueBlue',
  EY: 'Etihad Guest',
  IB: 'Iberia Avios',
  CM: 'Copa ConnectMiles',
  TP: 'TAP Miles&Go',
};

// Real sources spell the same bank/partner a dozen ways: a trailing
// "(Program Name)" suffix (awardwallet: "Amex (Membership Rewards)"), and
// slashes/ampersands/dashes standing in for spaces (frequentmiler:
// "Air France / KLM Flying Blue"). `norm` folds punctuation and whitespace;
// `nameCandidates` additionally peels off a trailing parenthetical and
// offers its inner content as a second, independent name to try — so
// "Japan Airlines (JMB)" can match either an alias for "japan airlines" or
// one for "jmb".
function norm(s) {
  return s
    .toLowerCase()
    // Strip diacritics before anything else: the Brazilian sources spell it
    // "Aeroméxico" while every US source writes "Aeromexico", and without this
    // the same programme resolves from one source and not the other -- which
    // is how a partner ends up listed twice under two spellings.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[/&.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Amex (Membership Rewards)"      -> ["amex", "membership rewards"]
// "Connect Miles - Copa Airlines"  -> ["connect miles copa airlines", "connect miles", "copa airlines"]
// "Air France KLM Flying Blue"     -> ["air france klm flying blue"]
//
// The dash split exists because Esfera titles its pages "<Programme> - <Airline>"
// while every other source names one or the other. Whole string first, so a
// programme whose real name contains a dash still wins outright; halves only as
// a fallback, and each half must match an alias exactly to resolve.
function nameCandidates(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const paren = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (paren) return [norm(paren[1]), norm(paren[2])];
  const out = [norm(s)];
  if (/\s-\s/.test(s)) for (const half of s.split(/\s-\s/)) out.push(norm(half));
  return out;
}

function buildLookup(aliasMap) {
  const lookup = new Map();
  for (const [code, names] of Object.entries(aliasMap)) {
    lookup.set(norm(code), code);
    for (const name of names) lookup.set(norm(name), code);
  }
  return lookup;
}

const BANK_LOOKUP = buildLookup(BANK_ALIASES);
const PARTNER_LOOKUP = buildLookup(PARTNER_ALIASES);

function resolve(lookup, name) {
  for (const candidate of nameCandidates(name)) {
    const code = lookup.get(candidate);
    if (code) return code;
  }
  return null;
}

export function resolveBank(name) {
  return resolve(BANK_LOOKUP, name);
}

export function resolvePartner(name) {
  return resolve(PARTNER_LOOKUP, name);
}

export function partnerDisplayName(code) {
  return PARTNER_DISPLAY_NAMES[code] ?? code;
}
