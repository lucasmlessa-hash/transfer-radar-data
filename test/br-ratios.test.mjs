import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseRatioText, parsePartnerRatio, liveloPartnerUrls, esferaPartnerUrls, esferaPartnerName } from '../src/sources/br-ratios.mjs';
import { resolvePartner, partnerDisplayName } from '../src/aliases.mjs';

const nextData = (obj) => `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(obj)}</script></body></html>`;

test('reads the rate both programmes publish, in the direction the contract uses', () => {
  // ratio is "points sent : miles received", so 3.5 Livelo points for 1 Avios is 3.5:1
  assert.equal(parseRatioText('1 ponto Livelo = 1 ponto Smiles', 'LIV'), '1:1');
  assert.equal(parseRatioText('3.5 pontos Livelo = 1 ponto Iberia Plus', 'LIV'), '3.5:1');
  assert.equal(parseRatioText('3,5 pontos Livelo = 1 ponto ALL', 'LIV'), '3.5:1', 'comma decimals appear too');
  assert.equal(parseRatioText('1 ponto Esfera = 1 milha Smiles', 'ESF'), '1:1');
  assert.equal(parseRatioText('2 pontos Esfera = 1 Avios', 'ESF'), '2:1');
});

test('the Esfera UI label templates must never be read as a rate', () => {
  // Every Esfera page ships these translation strings. They look exactly like
  // the real sentence minus the leading number, which is why the pattern is
  // anchored on a digit -- a page that states no rate must yield null, not a
  // fabricated one.
  const labels = '"esferaPoint2Text":" ponto Esfera =","esferaPoints2Text":" pontos Esfera =","ptEsf":" pt Esfera = "';
  assert.equal(parseRatioText(labels, 'ESF'), null);
  assert.equal(parsePartnerRatio(`<html><body>${labels}</body></html>`, 'ESF'), null);
});

test('Esfera publishes two rates per partner — the standard one wins, not the Clube one', () => {
  // The curated file carried Flying Blue at 3:1 and TAP at 2.2:1. Both were the
  // subscriber rates. Quoting a rate the user does not qualify for understates
  // what a transfer costs them, which is the one error direction that loses points.
  const fb = '3,5 pontos Esfera por 1 milha Flying Blue para todos os clientes; '
    + '3 pontos Esfera por 1 milha Flying Blue para clientes do Clube Esfera;';
  assert.equal(parseRatioText(fb, 'ESF'), '3.5:1');
});

test('an announced rate change applies from its date, not before and not never', () => {
  // Verbatim shape of Esfera's Etihad regulation on 2026-07-25. Both the
  // standing parity and the scheduled change sit on the page at once, so a
  // date-blind parser is wrong on one side of the 31st or the other.
  const etihad = 'Atualização de paridade — Etihad Guest A partir de 31.Julho.2026, a paridade de '
    + 'transferência para Etihad Guest será alterada: Clube Esfera: de 3,3 para 4,2 pontos Esfera '
    + 'por 1 milha Etihad Guest. Esfera: de 3,5 para 4,5 pontos Esfera por 1 milha Etihad Guest. '
    + 'Até 30.Julho.2026, permanecem válidas as condições atuais. Paridades: '
    + '3,5 pontos Esfera por 1 milha Etihad Guest para todos os clientes; '
    + '3,3 pontos Esfera por 1 milha Etihad Guest para clientes do Clube Esfera;';
  assert.equal(parseRatioText(etihad, 'ESF', new Date('2026-07-25')), '3.5:1', 'before the change');
  assert.equal(parseRatioText(etihad, 'ESF', new Date('2026-07-30')), '3.5:1', 'on the last day of the old rate');
  assert.equal(parseRatioText(etihad, 'ESF', new Date('2026-07-31')), '4.5:1', 'the day it takes effect');
  assert.equal(parseRatioText(etihad, 'ESF', new Date('2027-06-01')), '4.5:1', 'and stays in force after');
});

test('a rate of zero or garbage is rejected rather than published', () => {
  assert.equal(parseRatioText('0 pontos Livelo = 1 ponto X', 'LIV'), null);
  assert.equal(parseRatioText('1 ponto Livelo = 0 ponto X', 'LIV'), null);
  assert.equal(parseRatioText('transfira seus pontos Livelo hoje', 'LIV'), null);
});

test('Livelo partner urls: only active, and root-relative ones resolved', () => {
  const html = nextData({ props: { pageProps: { page: { components: [{ props: { listPartners: [
    { nomeParceiro: 'Smiles', redirectUrl: 'https://www.livelo.com.br/x/smiles', status: 'Ativo' },
    { nomeParceiro: 'Hilton Honors', redirectUrl: '/livelo-para-parceiros/hilton-honors/HILTransfer' },
    { nomeParceiro: 'Fantasma', redirectUrl: 'https://www.livelo.com.br/x/f', status: 'Inativo' },
  ] } }] } } } });
  const out = liveloPartnerUrls(html);
  assert.deepEqual(out.map((p) => p.name), ['Smiles', 'Hilton Honors'], 'inactive partners are dropped');
  assert.equal(out[1].url, 'https://www.livelo.com.br/livelo-para-parceiros/hilton-honors/HILTransfer',
    'a relative redirectUrl must be resolved, not passed to fetch as-is');
});

test('Esfera partner ids come from the showcase, not the navigation menu', () => {
  // The menu names 8 of the 19 the showcase lists; reading the menu is how
  // Aeromexico, Etihad, IHG and Turkish went missing from the Partners tab.
  const html = nextData({ props: { pageProps: { page: { regions: [{ shared: { contentBlock: [
    { title: 'PLP de programas parceiros', showcaseProductsId: 'e000100001,e000100002, e000100072 ,e000100001,lixo' },
    { menusSection: [{ menu: [{ links: [{ columns: [{ mainItemLabel: { title: 'Parceiros Nacionais' },
      groupMenuItemsLinks: [{ menuLink: { title: 'Smiles', href: '/p/smiles/e000100001' } }] }] }] }] }] },
  ] } }] } } } });
  const ids = esferaPartnerUrls(html).map((p) => p.id);
  assert.deepEqual(ids, ['e000100001', 'e000100002', 'e000100072'], 'deduped, trimmed, non-ids dropped');
  assert.ok(esferaPartnerUrls(html)[0].url.endsWith('/p/x/e000100001'),
    'the slug is decorative — the id alone resolves the page');
});

test('an unpublished Esfera id renders the site shell and must not become a row', () => {
  // 7 of the 19 showcase ids do exactly this. Without the guard they would be
  // added to the directory as a partner literally named "Esfera".
  assert.equal(esferaPartnerName('<title>Esfera</title>'), null);
  assert.equal(esferaPartnerName('<title></title>'), null);
  assert.equal(esferaPartnerName('<title>Smiles | Esfera</title>'), 'Smiles');
  assert.equal(esferaPartnerName('<title>TAP Miles&amp;Go</title>'), 'TAP Miles&Go');
});

test('every directory row is canonically named, with no duplicate programme per bank', () => {
  // Guards the defect this scraper created once: an alias change moves what
  // canonical() returns, and the old spelling left in the file becomes a
  // second row for the same programme (Aeromexico appeared twice, once with
  // an accent). The refresh script folds rows onto canonical names; this
  // asserts the committed file is actually in that state.
  const doc = JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url)));
  const offenders = [];
  for (const [bank, entry] of Object.entries(doc.directory)) {
    for (const bucket of ['air', 'hotel']) {
      const seen = new Map();
      for (const [name] of entry[bucket] ?? []) {
        const code = resolvePartner(name);
        if (code && partnerDisplayName(code) !== name) {
          offenders.push(`${bank}/${bucket}: "${name}" should be "${partnerDisplayName(code)}"`);
        }
        const key = code ?? name;
        if (seen.has(key)) offenders.push(`${bank}/${bucket}: "${seen.get(key)}" and "${name}" are the same programme`);
        seen.set(key, name);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the Brazilian rates are actually populated, and not all 1:1', () => {
  // The whole point: Livelo sends 1:1 to Smiles but 3.5:1 to Iberia. A build
  // that quietly reverts every ratio to an em dash would pass every other test
  // in this file.
  const doc = JSON.parse(readFileSync(new URL('../sample/partners.json', import.meta.url)));
  const liv = new Map(doc.directory.LIV.air);
  assert.equal(liv.get('Smiles (GOL)'), '1:1');
  assert.notEqual(liv.get('Iberia Avios'), '1:1', 'Iberia is emphatically not 1:1');
  const withRatio = [...doc.directory.LIV.air, ...doc.directory.LIV.hotel].filter(([, r]) => r !== '—');
  assert.ok(withRatio.length >= 10, `Livelo should carry a rate for nearly every partner, got ${withRatio.length}`);
});
