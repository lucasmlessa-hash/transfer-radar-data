import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePartners } from '../scripts/validate-feed.mjs';

function partners() {
  return {
    version: 1,
    banks: { CITI: { name: 'Citi', short: 'Citi', bg: '#fff', fg: '#111' } },
    airlineDomains: {}, bankDomains: {}, airlineValues: {},
    directory: { CITI: { air: [['Flying Blue', '—']], hotel: [['ALL Accor', '—']] } },
  };
}

function options() {
  return [
    { ratio: '1:1.5', cards: 'Cartões premium' },
    { ratio: '1000:700', cards: 'Demais cartões elegíveis' },
  ];
}

function withTiers() {
  return { ...partners(), ratioTiers: { CITI: { 'Flying Blue': options(), 'ALL Accor': options() } } };
}

test('tiers are optional and supported for both air and hotel directory rows', () => {
  assert.doesNotThrow(() => validatePartners(partners()));
  const doc = withTiers();
  doc.ratioTiers.CITI['ALL Accor'][0].ratio = '0.01:1';
  assert.doesNotThrow(() => validatePartners(doc));
});

test('tiers require an existing bank and an exact directory destination with no universal rate', () => {
  for (const change of [
    doc => { delete doc.banks.CITI; },
    doc => { delete doc.directory.CITI; },
    doc => { doc.ratioTiers.CITI['Flying blue'] = options(); },
    doc => { doc.directory.CITI.hotel[0][1] = '1:1'; },
    doc => { doc.directory.CITI.air.push(['ALL Accor', '1:1']); },
  ]) {
    const doc = withTiers();
    change(doc);
    assert.throws(() => validatePartners(doc), /ratioTiers\.CITI/);
  }
});

test('tier maps must contain named destinations for a bank', () => {
  for (const tiers of [null, [], { CITI: null }, { CITI: [] }, { CITI: {} }]) {
    assert.throws(() => validatePartners({ ...partners(), ratioTiers: tiers }), /partners\.ratioTiers(?:\.CITI)?:/u);
  }
});

test('each supported route requires at least two complete card groups', () => {
  for (const invalid of [null, {}, [], options().slice(0, 1), [null, options()[0]],
    [{ cards: 'Todos os cartões' }, options()[0]], [{ ratio: '1:1' }, options()[0]],
    [{ ratio: '1:1', cards: '   ' }, options()[0]], [{ ratio: '1:1', cards: 4 }, options()[0]],
    [{ ratio: '1:1', cards: 'Outros cartões', source: 'URL' }, options()[0]],
    [{ ratio: '1:2', cards: ' cartões  PREMIUM ' }, options()[0]],
  ]) {
    const doc = withTiers();
    doc.ratioTiers.CITI['Flying Blue'] = invalid;
    assert.throws(() => validatePartners(doc), /ratioTiers\.CITI\.Flying Blue/);
  }
});

test('tier rates must contain two strictly positive decimals separated by a colon', () => {
  for (const value of [null, 1, '', '—', '0:1', '1:0.00', '-1:1', '1:2x', '2:1:3', '1,5:1', '1:1\n', '1e2:1', '1: 2']) {
    const doc = withTiers();
    doc.ratioTiers.CITI['Flying Blue'][0].ratio = value;
    assert.throws(() => validatePartners(doc), /ratioTiers\.CITI\.Flying Blue.*ratio/);
  }
});
