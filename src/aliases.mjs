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
    .replace(/[/&.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Amex (Membership Rewards)" -> ["amex", "membership rewards"]
// "Air France KLM Flying Blue" -> ["air france klm flying blue"] (no parens)
function nameCandidates(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!m) return [norm(s)];
  return [norm(m[1]), norm(m[2])];
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
