import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFmDirectory, parseLiveloDirectory, parseEsferaDirectory, mergeDirectory } from '../src/sources/partner-directory.mjs';
import { resolvePartner } from '../src/aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

const fm = parseFmDirectory(fx('partner-fm.html'));
const liv = parseLiveloDirectory(fx('partner-livelo.html'));
const esf = parseEsferaDirectory(fx('partner-esfera.html'));

test('FM master list: all 7 US banks, with ratios in a:b form', () => {
  for (const bank of ['AMEX', 'CHASE', 'CITI', 'C1', 'BILT', 'WF', 'ROVE']) {
    assert.ok(fm[bank].air.size >= 8, `${bank} suspiciously few airline partners: ${fm[bank].air.size}`);
  }
  // spot checks against the page as scraped on 2026-07-25
  assert.ok(fm.CHASE.air.has('United MileagePlus'), 'Chase -> United is on the official list');
  assert.ok(fm.BILT.air.has('Alaska Atmos Rewards'), 'Bilt -> Alaska (post-rebrand name resolves)');
  assert.ok(fm.AMEX.air.has('Delta SkyMiles'), 'untracked programmes still appear by scraped name');
  assert.equal(fm.CITI.hotel.get('Wyndham Rewards'), '1:1', 'hotel names canonicalized, ratio parsed');
  for (const [, ratio] of fm.AMEX.air) assert.match(ratio, /^[\d.]+:[\d.]+$|^—$/);
  // coalition programmes are neither airlines nor hotels
  const all = JSON.stringify([...fm.CITI.air.keys(), ...fm.CITI.hotel.keys()]);
  assert.ok(!/Shop Your Way/i.test(all), 'Shop Your Way excluded');
});

test('Livelo official page: 13 travel partners, coalitions excluded', () => {
  assert.equal(liv.air.size, 10, [...liv.air.keys()].join(', '));
  assert.equal(liv.hotel.size, 3);
  assert.ok(liv.air.has('United MileagePlus') && liv.air.has('Etihad Guest'), 'the partners the curated list was missing');
  assert.ok(liv.air.has('Copa ConnectMiles'), 'Copa canonicalized through the new CM code');
  const all = JSON.stringify([...liv.air.keys()]);
  assert.ok(!/dotz|seedz/i.test(all), 'Dotz/Seedz are coalition programmes, not travel partners');
});

test('Esfera official page: current list, departed partners really gone', () => {
  assert.equal(esf.air.size, 7, [...esf.air.keys()].join(', '));
  assert.ok(esf.air.has('TAP Miles&Go') && esf.air.has('Copa ConnectMiles'));
  assert.ok(![...esf.air.keys()].some((n) => /American/i.test(n)), 'AAdvantage left Esfera and must not linger');
});

test('mergeDirectory: scrape replaces, curated fills ratios, failure falls back', () => {
  const curated = {
    ESF: { air: [['Smiles (GOL)', '1:1'], ['American AAdvantage', '3.5:1']], hotel: [] },
    LIV: { air: [['LATAM Pass', '1:1']], hotel: [] },
  };
  const merged = mergeDirectory(curated, { ESF: esf });
  const esfNames = merged.ESF.air.map(([n]) => n);
  assert.ok(!esfNames.includes('American AAdvantage'), 'a partner missing from the scrape disappears');
  assert.equal(merged.ESF.air.find(([n]) => /Smiles/.test(n))[1], '1:1', 'curated ratio inherited by canonical name');
  assert.deepEqual(merged.LIV, curated.LIV, 'bank with no scrape keeps curated lists verbatim');
});

test('cross-bank spelling consistency: one programme, one string (FOLLOW-UPS §1)', () => {
  const sample = JSON.parse(readFileSync(path.join(__dirname, '..', 'sample', 'partners.json'), 'utf8'));
  const spellings = new Map();
  for (const bankDir of Object.values(sample.directory)) {
    for (const bucket of ['air', 'hotel']) {
      for (const [name] of bankDir[bucket]) {
        const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!spellings.has(key)) spellings.set(key, new Set());
        spellings.get(key).add(name);
      }
    }
  }
  const dups = [...spellings.values()].filter((s) => s.size > 1).map((s) => [...s].join(' ≠ '));
  assert.deepEqual(dups, [], 'the Partners tab matches by string; two spellings = two phantom cards');
});

test('the new codes resolve through every spelling the sources use', () => {
  for (const v of ['Copa Airlines', 'Copa Connect Miles', 'Copa ConnectMiles', 'ConnectMiles']) {
    assert.equal(resolvePartner(v), 'CM', v);
  }
  for (const v of ['TAP Miles&Go', 'TAP Miles & Go', 'TAP Air Portugal', 'Miles&Go']) {
    assert.equal(resolvePartner(v), 'TP', v);
  }
});
