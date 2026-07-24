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
};

const PARTNER_ALIASES = {
  AF: ['air france', 'air france klm', 'air france / klm flying blue', 'air france/klm flying blue', 'flying blue', 'klm'],
  AV: ['avianca', 'avianca lifemiles', 'lifemiles'],
  AM: ['aeromexico', 'aeromexico rewards', 'aeromexico club premier'],
  VS: ['virgin atlantic', 'virgin atlantic flying club', 'flying club'],
  QR: ['qatar airways', 'qatar airways avios', 'qatar avios'],
  BA: ['british airways', 'british airways avios', 'ba avios'],
  EI: ['aer lingus', 'aer lingus aerclub', 'aerclub'],
  CX: ['cathay pacific', 'cathay pacific asia miles', 'asia miles'],
  NH: ['ana', 'ana mileage club', 'all nippon airways'],
  G3: ['gol', 'smiles', 'smiles (gol)'],
  LA: ['latam', 'latam pass'],
  AD: ['azul', 'azul fidelidade', 'tudoazul'],
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
};

function norm(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
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

export function resolveBank(name) {
  if (!name) return null;
  return BANK_LOOKUP.get(norm(name)) ?? null;
}

export function resolvePartner(name) {
  if (!name) return null;
  return PARTNER_LOOKUP.get(norm(name)) ?? null;
}

export function partnerDisplayName(code) {
  return PARTNER_DISPLAY_NAMES[code] ?? code;
}
