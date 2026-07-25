import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PARTNER_ALIASES, resolvePartner, partnerDisplayName } from '../src/aliases.mjs';
import { normalize } from '../src/normalize.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = JSON.parse(readFileSync(path.join(ROOT, 'sample', 'partners.json'), 'utf8'));

const air = (bank) => new Map(P.directory[bank].air);
const hotel = (bank) => new Map(P.directory[bank].hotel);

// ponytail: one invariant test instead of one assertion per code -- an airline
// code is only usable end to end if all three exist (alias, domain, value).
// A code with an alias but no airlineValues entry silently renders NaN¢/mile
// in the extension (VAL[r.code] is undefined), which is exactly the class of
// bug this guards.
test('every airline code has all three: alias, domain, cents-per-mile value', () => {
  for (const code of Object.keys(PARTNER_ALIASES)) {
    assert.equal(resolvePartner(code), code, `${code}: bare code must resolve to itself`);
    assert.ok(P.airlineDomains[code], `${code}: missing airlineDomains entry`);
    assert.ok(typeof P.airlineValues[code] === 'number', `${code}: missing airlineValues entry`);
    assert.notEqual(partnerDisplayName(code), code, `${code}: missing PARTNER_DISPLAY_NAMES entry`);
  }
  // and nothing in partners.json is orphaned the other way
  for (const code of Object.keys(P.airlineValues)) {
    assert.ok(PARTNER_ALIASES[code], `${code}: in partners.json but has no aliases`);
    assert.ok(P.airlineDomains[code], `${code}: has a value but no domain`);
  }
});

// The old band was a flat 0.5-2.5¢, which silently assumed every program is a
// US-market one. It is not: Smiles/LATAM/Azul are BRL-denominated and, honestly
// converted, land near 0.25-0.5¢ -- the flat band is what let the inflated
// ~1.1¢ BR numbers look reasonable for so long. Splitting the band by the
// market the valuation came from tightens the guard rather than loosening it.
const USD_BAND = [0.5, 2.5];
const BRL_BAND = [0.15, 1.0];

test('cents-per-mile values stay inside a defensible band for their market', () => {
  for (const [code, v] of Object.entries(P.airlineValues)) {
    const currency = P.airlineValueMeta[code].currency;
    const [lo, hi] = currency === 'BRL' ? BRL_BAND : USD_BAND;
    assert.ok(v >= lo && v <= hi, `${code}: ${v}¢ is outside the ${lo}–${hi}¢ band for a ${currency}-market program`);
  }
});

// Every number in airlineValues has to say where it came from. The failure this
// guards is the one that produced this file's previous contents: values copied
// out of a design prototype, then treated downstream as if they were researched.
test('every cents-per-mile value carries provenance', () => {
  for (const code of Object.keys(P.airlineValues)) {
    const m = P.airlineValueMeta[code];
    assert.ok(m, `${code}: no airlineValueMeta entry`);
    assert.match(m.asOf, /^\d{4}-\d{2}-\d{2}$/, `${code}: bad asOf`);
    assert.ok(['USD', 'BRL'].includes(m.currency), `${code}: bad currency "${m.currency}"`);
    assert.ok(
      m.source.startsWith('https://') || m.source === 'unsourced' || m.source.startsWith('derived:'),
      `${code}: source must be a URL, "unsourced", or "derived:*", got "${m.source}"`,
    );
    // a value that isn't a plain citation must explain itself
    if (!m.source.startsWith('https://')) assert.ok(m.note, `${code}: ${m.source} value needs a note`);
  }
  for (const code of Object.keys(P.airlineValueMeta)) {
    assert.ok(code in P.airlineValues, `${code}: meta with no airlineValues entry`);
  }
});

// Frequent Miler's RRV set is US-market and does not cover the Brazilian
// programs. Attributing a BR number to it would be exactly the fabrication this
// project already shipped once.
test('Brazilian programs are BRL-marked and never attributed to Frequent Miler', () => {
  for (const code of ['G3', 'LA', 'AD']) {
    const m = P.airlineValueMeta[code];
    assert.equal(m.currency, 'BRL', `${code}: must be marked BRL`);
    assert.doesNotMatch(m.source, /frequentmiler/i, `${code}: not a Frequent Miler figure`);
    assert.match(m.note, /USD\/BRL/, `${code}: note must record the FX rate used`);
  }
});

test('every directory ratio is a well-formed "<points>:<miles>" string', () => {
  for (const [bank, lists] of Object.entries(P.directory)) {
    for (const kind of ['air', 'hotel']) {
      for (const [name, ratio] of lists[kind]) {
        // '—' is legal since the directory went dynamic (2026-07-25): a
        // scraped partner whose page publishes no rate is shown unranked
        // rather than with an invented ratio.
        if (ratio === '—') continue;
        assert.match(ratio, /^\d+(\.\d+)?:\d+(\.\d+)?$/, `${bank}/${name}: bad ratio "${ratio}"`);
        const [a, b] = ratio.split(':').map(Number);
        assert.ok(a > 0 && b > 0, `${bank}/${name}: zero side in "${ratio}"`);
      }
    }
  }
});

// The names the live sources actually return today (2026-07-24), in every
// spelling seen in fixtures/ -- these are the ones that used to land in
// `unmapped` and silently cost the app a route.
test('real scraped airline names resolve to their codes', () => {
  const cases = [
    ['EVA Air Infinity MileageLands', 'BR'], ['EVA Air (Infinity MileageLands)', 'BR'],
    ['Qantas Frequent Flyer', 'QF'], ['Qantas (Frequent Flyer)', 'QF'],
    ['Japan Airlines (JMB)', 'JL'], ['Japan Airlines Mileage Bank', 'JL'],
    ['Lufthansa (Miles and More)', 'LH'], ['Lufthansa Miles & More', 'LH'],
    ['Alaska Atmos Rewards', 'AS'], ['Alaska Mileage Plan', 'AS'],
    ['American Airlines AAdvantage', 'AA'], ['American AAdvantage', 'AA'],
    ['Air Canada Aeroplan', 'AC'], ['Turkish Miles&Smiles', 'TK'],
    ['Emirates Skywards', 'EK'], ['Singapore KrisFlyer', 'SQ'],
  ];
  for (const [name, code] of cases) assert.equal(resolvePartner(name), code, `"${name}"`);
});

// Directory defects found by the 2026-07 accuracy audit. Each assertion is a
// partnership that either no longer exists or never existed (a phantom route
// sends a user to a transfer page that isn't there), or a ratio that was
// optimistic enough to change a transfer decision.
test('dead partnerships stay removed from the directory', () => {
  assert.equal(air('AMEX').has('Etihad Guest'), false, 'Amex ended Etihad 2026-06-30');
  assert.equal(air('CHASE').has('Emirates Skywards'), false, 'Chase dropped Emirates 2025-10-16');
  assert.equal(air('CITI').has('Aeromexico Rewards'), false, 'Citi ended Aeromexico 2026-01-25');
  assert.equal(air('BILT').has('American AAdvantage'), false, 'Bilt/AA ended 2024-06-24 (phantom)');
  assert.equal(air('BILT').has('Alaska Mileage Plan'), false, 'rebranded to Atmos Rewards 2025-08-20');
  assert.equal(air('LIV').has('Qatar Airways Avios'), false, 'no direct Livelo->Qatar partnership');
});

// The hand-audit of 2026-07-25 predates the dynamic directory. Its surviving
// value: the FM scrape must agree with the audited devaluations (it does —
// 1000:800 IS 1:0.8), and curated BR ratios must survive the merge by
// canonical name. Names here are the CANONICAL spellings the dynamic
// directory emits; the audit's old spellings are what §1 retired.
test('devalued and corrected ratios match the audit', () => {
  const expected = [
    ['AMEX', 'air', 'Emirates Skywards', '1000:800'],
    ['AMEX', 'air', 'Cathay Pacific Asia Miles', '1000:800'],
    ['CITI', 'hotel', 'Choice Privileges', '1:1.5'],
    ['C1', 'air', 'Emirates Skywards', '1000:750'],
    ['BILT', 'air', 'Alaska Atmos Rewards', '1:1'],
    // Esfera was optimistic by 2-3x across the board (curated, inherited by merge)
    // 2.7:1, not the 2.2:1 this file used to assert: 2.2 is the Clube Esfera
    // subscriber rate, and the app must quote what a non-subscriber pays.
    ['ESF', 'air', 'TAP Miles&Go', '2.7:1'],
    // likewise 3.5:1, not 3:1 — the audit had recorded Esfera's Clube rate
    ['ESF', 'air', 'Air France / KLM Flying Blue', '3.5:1'],
    ['ESF', 'hotel', 'ALL Accor Live Limitless', '3.5:1'],
    ['LIV', 'air', 'Iberia Avios', '3.5:1'],
    ['LIV', 'hotel', 'ALL Accor Live Limitless', '3.5:1'],
  ];
  for (const [bank, kind, name, ratio] of expected) {
    const list = kind === 'air' ? air(bank) : hotel(bank);
    assert.equal(list.get(name), ratio, `${bank}/${kind}/${name}`);
  }
  const ratios = (a, b) => Number(a.split(':')[1]) / Number(a.split(':')[0]) === b;
  assert.ok(ratios(air('AMEX').get('Emirates Skywards'), 0.8), 'FM 1000:800 is the audited 1:0.8');
});

test('added and departed partners match the official pages', () => {
  const added = [
    ['CHASE', 'hotel', 'Wyndham Rewards'], ['CITI', 'air', 'American Airlines AAdvantage'],
    ['C1', 'air', 'Japan Airlines (JAL Mileage Bank)'], ['C1', 'air', 'Qatar Airways Avios'],
    ['C1', 'air', 'JetBlue TrueBlue'], ['C1', 'hotel', 'Preferred Hotels I Prefer'],
    ['BILT', 'air', 'Etihad Guest'], ['BILT', 'air', 'Japan Airlines (JAL Mileage Bank)'],
    ['BILT', 'air', 'Qatar Airways Avios'], ['BILT', 'air', 'Southwest Rapid Rewards'],
    ['BILT', 'hotel', 'Wyndham Rewards'], ['WF', 'air', 'JetBlue TrueBlue'],
    ['WF', 'air', 'Cathay Pacific Asia Miles'], ['WF', 'hotel', 'Wyndham Rewards'],
    ['ESF', 'air', 'Azul Fidelidade'], ['ESF', 'air', 'Copa ConnectMiles'],
    ['LIV', 'air', 'United MileagePlus'], ['LIV', 'air', 'Etihad Guest'],
  ];
  for (const [bank, kind, name] of added) {
    const list = kind === 'air' ? air(bank) : hotel(bank);
    assert.ok(list.has(name), `${bank}/${kind}: missing "${name}"`);
  }
  // partners that left really leave — the whole point of a dynamic directory
  assert.ok(!air('ESF').has('American AAdvantage') && ![...air('ESF').keys()].some((n) => /American/.test(n)),
    'AAdvantage left Esfera');

  // This assertion used to read "IHG left Esfera". It was wrong: IHG is on
  // Esfera's showcase list and has a live partner page — it was simply absent
  // from the navigation menu, which was the only thing being scraped at the
  // time. The old test encoded a hole in our scraping as a fact about the
  // world, which is the failure mode a directory test exists to prevent.
  assert.ok(hotel('ESF').has('IHG One Rewards'), 'IHG is an Esfera partner (showcase id e000100736)');
  for (const name of ['Etihad Guest', 'Turkish Miles&Smiles', 'Aeromexico Rewards']) {
    assert.ok(air('ESF').has(name), `${name} is an Esfera partner the menu-only scrape missed`);
  }
});

// Transfer speed is keyed bank -> airline because it genuinely differs by bank
// (Amex->Cathay 4-8 hours vs Capital One->Cathay 1-2 days). A key that doesn't
// match a real bank/airline code degrades silently to "—", so it is checked.
test('transferTimes only references known bank and airline codes', () => {
  for (const [bank, byCode] of Object.entries(P.transferTimes)) {
    assert.ok(P.banks[bank], `transferTimes: unknown bank "${bank}"`);
    for (const [code, speed] of Object.entries(byCode)) {
      assert.ok(P.airlineDomains[code], `transferTimes.${bank}: unknown airline "${code}"`);
      assert.ok(speed.length > 0, `transferTimes.${bank}.${code}: empty`);
      // uppercase display strings only - the client prints these verbatim
      assert.equal(speed, speed.toUpperCase(), `transferTimes.${bank}.${code}: "${speed}" must be uppercase`);
    }
  }
});

test('airlineIconUrls only overrides known airlines, with absolute https URLs', () => {
  for (const [code, url] of Object.entries(P.airlineIconUrls)) {
    assert.ok(P.airlineDomains[code], `airlineIconUrls: unknown airline "${code}"`);
    assert.match(url, /^https:\/\/\S+$/, `airlineIconUrls.${code}: "${url}"`);
  }
  // Azul is the reason this map exists: Google's favicon service 404s on
  // voeazul.com.br and serves a generic grey globe in its place.
  assert.ok(P.airlineIconUrls.AD, 'AD needs an icon override (Google 404s on voeazul.com.br)');
});

// GOL's own domain gives a legible mark; smiles.com.br returns a 16x16 orange
// smear from the favicon service.
test('G3 points at voegol.com.br, not smiles.com.br', () => {
  assert.equal(P.airlineDomains.G3, 'voegol.com.br');
});

// The regression this whole map exists to fix: `time` read "—" on every route
// after the simulated feed it used to be copied from was deleted.
test('normalize reads transfer speed from partners.json, and blanks what it lacks', () => {
  const raw = (bankName, partnerName) => ({ bankName, partnerName, pct: 25, endDateRaw: 'July 29, 2026', sourceUrl: 'https://example.com/a' });
  const timeOf = (bankName, partnerName) => {
    const { routes } = normalize([raw(bankName, partnerName)], new Date('2026-06-01T00:00:00Z'));
    assert.equal(routes.length, 1, `${bankName}/${partnerName} did not resolve`);
    return routes[0].time;
  };
  assert.equal(timeOf('Amex', 'Avianca LifeMiles'), P.transferTimes.AMEX.AV);
  assert.equal(timeOf('Amex', 'Avianca LifeMiles'), 'INSTANT');
  // same airline, different bank, genuinely different speed
  assert.equal(timeOf('Amex', 'Cathay Pacific Asia Miles'), '4–8 HOURS');
  assert.equal(timeOf('Capital One', 'Cathay Pacific Asia Miles'), '1–2 DAYS');
  // Esfera -> Azul has no published transfer time; it must stay an honest blank
  assert.equal(P.transferTimes.ESF, undefined);
  assert.equal(timeOf('Esfera', 'Azul Fidelidade'), '—');
});

test('a bank never lists the same partner twice', () => {
  for (const [bank, lists] of Object.entries(P.directory)) {
    for (const kind of ['air', 'hotel']) {
      const names = lists[kind].map(([n]) => n);
      assert.equal(new Set(names).size, names.length, `${bank}/${kind} has a duplicate partner`);
    }
  }
});
